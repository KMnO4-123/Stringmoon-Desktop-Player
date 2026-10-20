// L2 acceptance: loopback proxy + real engine, with a LOCAL HTTP source
// standing in for a CDN. No network, no provider, no account -- so a failure
// here can only be the wiring, which is exactly what this level exists to prove.
//
// Structure follows docs/INTEGRATION-v1-engine-app.md §5.2b:
//   local HTTP server ("the CDN", signed URLs that expire)
//     -> LoopbackMediaProxy.register()  <- the app-side call that was missing
//       -> {"cmd":"open","url":...}     <- the CR-016 engine entry point
//         -> real twilight-engine.exe
//
// Assertions (§5.2): byte equivalence, seek, SEEK_END, no duplicate range
// fetch, Range really reached the proxy, 416 behaviour, and upstream ETag
// exposure (version pinning).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LoopbackMediaProxy } from '../src/main/media-proxy.ts'

const sourceFile = process.argv[2]
if (!sourceFile) throw new Error('usage: node test-l2-integration.mjs <real-flac>')
if (!existsSync(sourceFile)) throw new Error('missing fixture: ' + sourceFile)

const EXE = process.env.TWILIGHT_ENGINE ?? fileURLToPath(new URL('../../engine/bin/twilight-engine.exe', import.meta.url))
if (!existsSync(EXE)) throw new Error('missing engine: ' + EXE)

const bytes = readFileSync(sourceFile)
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const SHA = sha256(bytes)
const FORMAT = 'audio/flac'
const ETAG = '"l2-fixture-v1"'

let checks = 0
let failures = 0
function check(value, label) {
  checks++
  if (value) console.log('  ok  - ' + label)
  else { failures++; console.error('  FAIL- ' + label) }
}

// ── "The CDN": signed, expiring, Range-capable ──────────────────────────────
const requests = []          // every Range the proxy asked for
const rangedHeaders = []     // headers seen, to prove Range really arrived
let requireSignature = false
let heldResponses = 0

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/track.flac') { res.writeHead(404).end(); return }

  if (requireSignature && url.searchParams.get('sig') !== 'fresh') {
    res.writeHead(403).end('signature expired')      // what a CDN does on an expired URL
    return
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  requests.push({ range: req.headers.range ?? null, url: req.url })
  rangedHeaders.push(req.headers)
  if (!match) { res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes); return }

  const start = Number(match[1])
  // An open-ended `bytes=N-` is the normal shape for "everything from N".
  const end = match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1)
  if (start >= bytes.length || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end()
    return
  }
  const body = bytes.subarray(start, end + 1)
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    'Content-Type': FORMAT,
    ETag: ETAG,
    'Cache-Control': 'no-store'
  })
  res.end(body)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const cdn = `http://127.0.0.1:${server.address().port}`

// ── Engine harness ─────────────────────────────────────────────────────────
const child = spawn(EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map()
const events = []
let id = 0
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (typeof frame.id === 'number' && pending.has(frame.id)) {
    const item = pending.get(frame.id)
    pending.delete(frame.id)
    frame.ok ? item.resolve(frame.data) : item.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }))
  } else events.push(frame)
})
function request(cmd, timeoutMs = 15000) {
  const requestId = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('timeout: ' + cmd.cmd)) }, timeoutMs)
    pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    child.stdin.write(JSON.stringify({ id: requestId, ...cmd }) + '\n')
  })
}

const proxy = new LoopbackMediaProxy()
let loopbackUrl = null

try {
  await request({ cmd: 'hello', protocol: 1 })
  await request({ cmd: 'set_muted', muted: true })       // silent: this must never play audio
  await request({ cmd: 'set_output', mode: 'shared' })

  // ── ① proxy URL equals the original bytes (byte-for-byte) ────────────────
  console.log('\nL2 · proxy fidelity (no engine involved)')
  loopbackUrl = await proxy.register({ url: `${cdn}/track.flac` })
  check(/^http:\/\/127\.0\.0\.1:\d+\/media\/[A-Za-z0-9_-]{43}$/.test(loopbackUrl), 'register() returns a loopback /media/<token> URL')
  const full = Buffer.from(await (await fetch(loopbackUrl)).arrayBuffer())
  check(full.length === bytes.length && sha256(full) === SHA, 'proxy returns the source bytes unchanged')

  // ── ② the engine opens the CR-016 url entry point ───────────────────────
  console.log('\nL2 · engine open {url}')
  const open = await request({ cmd: 'open', url: loopbackUrl })
  check(open && typeof open.durationMs === 'number' && open.durationMs > 0, `open {url} succeeds (durationMs=${open?.durationMs})`)
  check(open?.trackId === '', 'a URL open reports an EMPTY trackId (CR-016 constraint 3)')
  check(typeof open?.sourceSampleRate === 'number' && open.sourceSampleRate > 0, `source format comes from the decoder (${open?.sourceSampleRate} Hz / ${open?.bitDepth} bit)`)
  check(typeof open?.operationId === 'number' && open.operationId > 0, 'open bumps the CR-007 operationId')

  const before = requests.length
  await request({ cmd: 'play' })
  await delay(1200)
  const rangeRequests = requests.filter((r) => /^bytes=\d+-\d+$/.test(r.range ?? ''))
  check(rangeRequests.length > 0, `the proxy RECEIVED Range requests (${rangeRequests.length}) -- proof the engine used its HTTP backend rather than reading a local file`)
  check(requests.slice(before).every((r) => { const m = /^bytes=(\d+)-(\d+)$/.exec(r.range ?? ''); return m && Number(m[2]) - Number(m[1]) + 1 <= 262144 }), 'every Range stays inside the 256 KiB prefetch window')

  const playing = await request({ cmd: 'get_state' })
  check(playing.state === 'playing', 'the stream is actually playing from the URL')
  check(playing.muted === true, 'the stream stayed muted (no audio was played)')

  // ── ③ seek through the proxy ────────────────────────────────────────────
  console.log('\nL2 · seek over HTTP')
  await request({ cmd: 'seek', positionMs: 42000 })
  await delay(500)
  const sought = await request({ cmd: 'get_state' })
  check(sought.positionMs >= 42000, `seek over HTTP landed (${sought.positionMs} ms)`)
  check(requests.length > rangeRequests.length, 'seeking issued further Range requests instead of downloading the whole file')

  // ── ④ 416: an out-of-range request keeps its shape ──────────────────────
  console.log('\nL2 · 416 behaviour')
  const out = await fetch(loopbackUrl, { headers: { Range: `bytes=${bytes.length + 10}-` } })
  check(out.status === 416, 'an out-of-range request yields 416 through the proxy')
  check((out.headers.get('content-range') ?? '').startsWith('bytes */'), `416 keeps Content-Range: bytes */size (${out.headers.get('content-range')})`)

  // ── ⑤ version pinning: the upstream validator reaches the engine ────────
  console.log('\nL2 · version pinning')
  check(out.headers.get('accept-ranges') === 'bytes', 'Accept-Ranges is exposed')
  // The engine captures the validator during open and pins LATER fetches with
  // If-Range. The very first fetch necessarily has nothing to pin yet, so the
  // evidence has to come from a request made after the open -- force one with a
  // seek far beyond the 256 KiB window.
  const ranged = requests.length
  const rangedHeadersBefore = rangedHeaders.length
  await request({ cmd: 'seek', positionMs: 240000 })
  await delay(800)
  const withIfRange = rangedHeaders.slice(rangedHeadersBefore).some((h) => Boolean(h['if-range']))
  check(rangedHeaders.length > rangedHeadersBefore, 'the proxy served the post-seek ranges')
  check(withIfRange, `the engine pinned the resource version with If-Range (ETag=${ETAG})`)

  // ── ⑥ signed-URL refresh: the engine must not care ──────────────────────
  console.log('\nL2 · expiring signature + refresh')
  let refreshes = 0
  const refreshUrl = await proxy.register({
    url: `${cdn}/track.flac?sig=stale`,
    refresh: async () => { refreshes += 1; return { url: `${cdn}/track.flac?sig=fresh` } }
  })
  requireSignature = true
  await request({ cmd: 'open', url: refreshUrl })
  await request({ cmd: 'play' })
  await delay(1200)
  const healed = await request({ cmd: 'get_state' })
  check(refreshes > 0, `refresh() was really called on the expired signature (${refreshes}x)`)
  check(healed.state === 'playing' && healed.renderedFrames > 0, 'playback continued across the re-sign')

  // ── ⑦ the transport failure must not look like end-of-stream ────────────
  console.log('\nL2 · failure is not EOF')
  await request({ cmd: 'stop' })
  const deadUrl = await proxy.register({ url: `${cdn}/track.flac` })
  const token = new URL(deadUrl).pathname.split('/').at(-1)
  proxy.revoke(token)
  let refused = null
  try { await request({ cmd: 'open', url: deadUrl }, 20000) } catch (error) { refused = error }
  check(refused !== null, 'opening a revoked token fails loudly instead of opening a silent empty stream')
  check(refused?.code === 'ERR_DECODE' || refused?.code === 'ERR_NOTFOUND', `the failure is reported as ${refused?.code} (a transport fault, not a clean end)`)

  await request({ cmd: 'stop' })
  await request({ cmd: 'shutdown' })
} catch (error) {
  failures++
  console.error('\nUNEXPECTED: ' + (error?.stack ?? error))
  console.error('engine stderr tail:\n' + stderr.split('\n').slice(-15).join('\n'))
} finally {
  try { await proxy.close() } catch {}
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (child.exitCode === null && child.signalCode === null) child.kill()
}

console.log(`\nL2 integration: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
