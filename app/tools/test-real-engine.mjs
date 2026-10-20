#!/usr/bin/env node
/**
 * tools/test-real-engine.mjs — 对真引擎（twilight-engine.exe）跑同一套契约断言。
 * 这是 CONTRACT §9.1 合并判据的可重复化：spawn 目标换成真 exe，协议行为必须一致。
 * exe 不存在时 SKIP（exit 0）——没有引擎的开发机照常通过。
 * 注意：play 步骤会真的出声几秒（M1 A3 判据本来就是"放出声"）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_EXE = fileURLToPath(new URL('../../engine/bin/twilight-engine.exe', import.meta.url))
const EXE = process.env.TWILIGHT_ENGINE ?? ENGINE_EXE
// 可用 STRINGMOON_TEST_LIBRARY 指向本机测试曲库；缺省取当前用户的音乐文件夹。
const LIBRARY_DIR = process.env.STRINGMOON_TEST_LIBRARY ?? path.join(homedir(), 'Music')
if (!fs.existsSync(EXE)) {
  console.log('SKIP: real engine not found at ' + EXE)
  process.exit(0)
}

let failures = 0
let checks = 0
function assert(cond, label) {
  checks++
  if (cond) console.log('  ok -', label)
  else { failures++; console.error('  FAIL -', label) }
}

const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('[engine:stderr] ' + d))

const queue = []
let lineBuf = ''
let badLines = 0
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  lineBuf += chunk
  let idx
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx).replace(/\r$/, '')
    lineBuf = lineBuf.slice(idx + 1)
    if (!line.trim()) continue
    try { queue.push(JSON.parse(line)) } catch { badLines++; assert(false, 'engine stdout line is valid JSON: ' + line.slice(0, 80)) }
  }
})

async function waitFor(pred, ms, label) {
  const deadline = Date.now() + ms
  for (;;) {
    const i = queue.findIndex(pred)
    if (i >= 0) return queue.splice(i, 1)[0]
    if (Date.now() > deadline) { assert(false, 'timeout: ' + label); return null }
    await new Promise((r) => setTimeout(r, 20))
  }
}
let nextId = 1
async function cmd(payload, ms = 10000) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
  return waitFor((m) => m.id === id && typeof m.ok === 'boolean', ms, 'reply for ' + payload.cmd)
}

const ready = await waitFor((m) => m.ev === 'ready', 5000, 'ready event')
assert(ready?.protocol === 1, 'ready protocol=1')
assert(Array.isArray(ready?.devices) && ready.devices.length >= 1, 'ready exposes devices')

const hello = await cmd({ cmd: 'hello' })
assert(hello?.ok === true, 'hello ok')

const scan = await cmd({ cmd: 'scan', path: LIBRARY_DIR }, 120000)
// 实测形状：scan 回复 data = { tracks: [...] }（完整列表）；{added, failed} 在 scan_done 事件里
const scanTracks = scan?.data?.tracks
assert(scan?.ok === true && Array.isArray(scanTracks) && scanTracks.length === 91, 'scan returns 91 tracks (got ' + (Array.isArray(scanTracks) ? scanTracks.length : '?') + ')')
const scanDone = await waitFor((m) => m.ev === 'scan_done', 5000, 'scan_done')
assert(scanDone?.added === 91 && scanDone?.failed === 0, 'scan_done 91/0')

const list = await cmd({ cmd: 'list_tracks' }, 15000)
const tracks = list?.data?.tracks
assert(Array.isArray(tracks) && tracks.length === 91, 'list_tracks returns 91')
const first = tracks?.[0]
assert(typeof first?.trackId === 'string' && /^tl_\d{4}$/.test(first.trackId), 'trackId format tl_NNNN')
assert(typeof first?.durationMs === 'number' && first.durationMs > 0, 'durationMs is positive number')

const open = await cmd({ cmd: 'open', trackId: first.trackId })
assert(open?.ok === true && open.data?.trackId === first.trackId && typeof open.data?.durationMs === 'number', 'open returns trackId + durationMs')
const stOpen = await waitFor((m) => m.ev === 'state' && m.trackId === first.trackId, 5000, 'state after open')
// 实测：真引擎 open 后发第三态 "stopped"（契约只列了 playing/paused —— 见 CR-001）
assert(stOpen?.state === 'paused' || stOpen?.state === 'stopped', 'open does not autoplay (state=' + stOpen?.state + ')')

const play = await cmd({ cmd: 'play' })
assert(play?.ok === true, 'play ok (real audio out)')
const stPlay = await waitFor((m) => m.ev === 'state' && m.state === 'playing', 5000, 'state playing')
assert(!!stPlay, 'state=playing is authoritative')
const pos1 = await waitFor((m) => m.ev === 'position', 5000, 'first position event')
await new Promise((r) => setTimeout(r, 1100))
const pos2 = await waitFor((m) => m.ev === 'position' && m.positionMs > (pos1?.positionMs ?? 0), 5000, 'position advances')
assert(!!pos2, 'position advances (' + pos1?.positionMs + ' → ' + pos2?.positionMs + ')')

const seek = await cmd({ cmd: 'seek', positionMs: 42000 })
assert(seek?.ok === true, 'seek ok')
const posSeek = await waitFor((m) => m.ev === 'position' && m.positionMs >= 42000, 5000, 'position after seek >= 42000')
assert(!!posSeek, 'position jumped to seek target (' + posSeek?.positionMs + ')')

const vol = await cmd({ cmd: 'set_volume', volume: 0.4 })
assert(vol?.ok === true, 'set_volume ok')

const pause = await cmd({ cmd: 'pause' })
assert(pause?.ok === true, 'pause ok')
await waitFor((m) => m.ev === 'state' && m.state === 'paused', 5000, 'state paused')

const stop = await cmd({ cmd: 'stop' })
assert(stop?.ok === true, 'stop ok')

// 先挂 exit 监听再发 shutdown：引擎收到 shutdown 后 ~6ms 即退出，
// 若等回复轮询（20ms 步进）后再挂监听，exit 事件已经发过（Node 只发一次）
const exited = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('timeout'), 5000)
  child.on('exit', (code) => { clearTimeout(t); resolve(code) })
  const id = nextId++
  child.stdin.write(JSON.stringify({ id, cmd: 'shutdown' }) + '\n')
  void cmd
})
assert(exited === 0, 'engine exits 0 (got ' + exited + ')')
if (exited === 'timeout') child.kill()

console.log(badLines === 0 && failures === 0 ? '\nALL ' + checks + ' CHECKS PASSED (real engine)' : '\n' + failures + '/' + checks + ' CHECKS FAILED, badLines=' + badLines)
process.exit(failures === 0 && badLines === 0 ? 0 : 1)
