// Exercises the real engine against a loopback server. No output device opens.
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = process.argv[2]
if (!file) throw new Error('usage: node test-http-reader.mjs <real-flac>')
const bytes = readFileSync(file)
if (bytes.length <= 524288) throw new Error('fixture must exceed two cache windows')
const exe = fileURLToPath(new URL('../bin/twilight-engine.exe', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'twilight-reader-'))
const wavFile = join(temporary, 'stereo.wav')
const wav = Buffer.alloc(44 + 48000 * 4 * 4)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28)
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(((i * 31) % 60001) - 30000, i)
writeFileSync(wavFile, wav)
const mp3File = fileURLToPath(new URL('../third_party/taglib-2.3.2/tests/data/lame_cbr.mp3', import.meta.url))
const mp3 = readFileSync(mp3File)
const mp3LargeFile = join(temporary, 'large.mp3')
const mp3WithoutFrameIndex = Buffer.from(mp3)
const frameIndex = mp3WithoutFrameIndex.indexOf('Info')
if (frameIndex < 0) throw new Error('the MP3 fixture needs an Info header to construct a no-index case')
mp3WithoutFrameIndex.write('Junk', frameIndex, 'ascii')
writeFileSync(mp3LargeFile, Buffer.concat([mp3WithoutFrameIndex, Buffer.alloc(300000)]))
const mp3Large = readFileSync(mp3LargeFile)
let failures = 0
const requests = new Map()
const server = createServer((req, res) => {
  const mode = req.url.slice(1)
  const payload = mode === 'wav' ? wav : mode === 'mp3' ? mp3 : ['mp3-large', 'failure-mp3'].includes(mode) ? mp3Large
    : mode === 'small-full' ? bytes.subarray(0, 65537) : bytes
  const seen = requests.get(mode) ?? []
  requests.set(mode, seen)
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
  if (!match) { res.writeHead(400).end(); return }
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), payload.length - 1)
  seen.push([start, end])
  if ((mode === 'failure' || mode === 'failure-decode' || mode === 'failure-mp3') && start > 0) { res.writeHead(503).end(); return }
  if (mode === 'timeout' && start > 0) return
  if (mode === 'small-full' || mode === 'large-full') {
    res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload); return
  }
  const headers = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' }
  if (mode !== 'missing-range') headers['Content-Range'] = `bytes ${start + (mode === 'wrong-range' ? 1 : 0)}-${end}/${payload.length + (mode === 'changed-length' && start > 0 ? 1 : 0)}`
  if (mode === 'bad-total') headers['Content-Range'] += 'junk'
  if (mode === 'unknown-total') headers['Content-Range'] = `bytes ${start}-${end}/*`
  if (mode === 'changed-etag') headers.ETag = start === 0 ? '"first"' : '"second"'
  if (mode === 'encoded') headers['Content-Encoding'] = 'gzip'
  if (['short', 'overlong', 'chunked'].includes(mode)) delete headers['Content-Length']
  res.writeHead(206, headers)
  if (mode === 'short') { res.end(payload.subarray(start, end)); return }
  if (mode === 'overlong') { res.write(payload.subarray(start, end + 1)); res.end(Buffer.from([0])); return }
  const body = Buffer.from(payload.subarray(start, end + 1))
  if (mode === 'changed-content' && start > 0 && body.length > 0) body[Math.floor(body.length / 2)] ^= 0xff
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
async function run(mode, expectSuccess, options = {}) {
  const args = options.local ? ['--verify-media', options.local, `${base}/${mode}`, ...(options.flags ?? [])] : ['--probe-io', `${base}/${mode}`]
  const started = performance.now()
  const result = await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${mode}: engine timeout`)) }, 20000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  const elapsed = performance.now() - started
  const seen = requests.get(mode) ?? []
  const bounded = seen.every(([start, end]) => end - start + 1 <= 262144)
  const passed = (expectSuccess ? result.code === 0 : result.code === 1 && result.output.includes(options.error ?? 'failed:')) && bounded &&
    (options.requests === undefined || seen.length === options.requests) && (mode !== 'timeout' || elapsed < 12000)
  if (!passed) ++failures
  console.log(`${passed ? 'PASS' : 'FAIL'} ${mode}: exit=${result.code}, requests=${seen.length}, ${Math.round(elapsed)} ms`)
  if (expectSuccess && options.local) console.log(result.output.trim())
  if (!passed) console.log(result.output.trim())
}
try {
  await run('valid', true)
  await run('wrong-range', false)
  await run('missing-range', false)
  await run('failure', false)
  await run('bad-total', false)
  await run('unknown-total', false)
  await run('short', false)
  await run('overlong', false)
  await run('encoded', false)
  await run('changed-length', false, { error: 'length changed' })
  await run('changed-etag', false, { error: 'identity changed' })
  await run('large-full', false)
  await run('cache', true, { local: file, flags: ['--cache-only'], requests: 1 })
  await run('media', true, { local: file })
  await run('chunked', true, { local: file, flags: ['--bytes-only'] })
  await run('small-full', false, { error: 'HTTP server did not honor Range' })
  await run('wav', true, { local: wavFile })
  await run('mp3', true, { local: mp3File })
  await run('failure-decode', false, { local: file, flags: ['--decode-only'] })
  await run('failure-mp3', false, { local: mp3LargeFile, flags: ['--decode-only'], error: 'HTTP server did not honor Range' })
  await run('changed-content', false, { local: file, flags: ['--bytes-only'], error: 'byte contents or positions differ' })
  await run('timeout', false)
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(temporary, { recursive: true, force: true })
}
console.log(`HTTP reader: ${failures} failure(s)`)
process.exitCode = failures ? 1 : 0
