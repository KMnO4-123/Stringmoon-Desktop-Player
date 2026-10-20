#!/usr/bin/env node
/**
 * tools/test-mock-engine.mjs — mock 引擎的协议自测（BRIEF-B 第 1 步“每一步都要能独立验证”）。
 * 用途：spawn tools/mock-engine.mjs，按 CONTRACT §3 喂命令、断言回复与事件流。
 * 跑法：node tools/test-mock-engine.mjs  （exit 0 = 全过）
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mockPath = path.join(here, 'mock-engine.mjs')
// 可用 STRINGMOON_TEST_LIBRARY 指向本机测试曲库；缺省取当前用户的音乐文件夹。
const LIBRARY_DIR = process.env.STRINGMOON_TEST_LIBRARY ?? path.join(homedir(), 'Music')

let failures = 0
let checks = 0
function assert(cond, label) {
  checks++
  if (cond) console.log('  ok -', label)
  else { failures++; console.error('  FAIL -', label) }
}

const child = spawn(process.execPath, [mockPath], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('[engine:stderr] ' + d))

/** 事件与回复统一队列；按谓词等待，超时即失败 */
const queue = []
let lineBuf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  lineBuf += chunk
  let idx
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx).replace(/\r$/, '')
    lineBuf = lineBuf.slice(idx + 1)
    if (!line.trim()) continue
    try { queue.push(JSON.parse(line)) } catch { assert(false, 'engine stdout line is valid JSON: ' + line.slice(0, 80)) }
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
async function cmd(payload, ms = 5000) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
  return waitFor((m) => m.id === id && typeof m.ok === 'boolean', ms, 'reply for ' + payload.cmd)
}

// 1. hello → ready
const hello = await cmd({ cmd: 'hello' })
assert(hello?.ok === true, 'hello ok')
const ready = await waitFor((m) => m.ev === 'ready', 3000, 'ready event')
assert(ready?.protocol === 1, 'ready protocol=1')
assert(Array.isArray(ready?.devices) && ready.devices.length >= 1, 'ready devices present')

// 2. scan
const scan = await cmd({ cmd: 'scan', path: LIBRARY_DIR }, 15000)
assert(scan?.ok === true && scan.data?.added === 91, 'scan adds 91 (got ' + (scan?.data?.added ?? '?') + ')')
const scanDone = await waitFor((m) => m.ev === 'scan_done', 3000, 'scan_done')
assert(scanDone?.added === 91 && scanDone?.failed === 0, 'scan_done 91/0')
const prog = queue.find((m) => m.ev === 'scan_progress')
assert(prog && prog.total === 91, 'scan_progress events present')

// 3. open/play/position
const open = await cmd({ cmd: 'open', trackId: 'tl_0001' })
assert(open?.ok === true && open.data?.trackId === 'tl_0001', 'open tl_0001 ok')
const stOpen = await waitFor((m) => m.ev === 'state' && m.trackId === 'tl_0001', 3000, 'state after open')
assert(stOpen?.state === 'paused', 'open does not autoplay (state=paused)')
const play = await cmd({ cmd: 'play' })
assert(play?.ok === true, 'play ok')
const stPlay = await waitFor((m) => m.ev === 'state' && m.state === 'playing', 3000, 'state playing')
assert(stPlay?.sampleRate === 96000 && stPlay?.bitDepth === 24, 'state carries sampleRate/bitDepth')
const pos1 = await waitFor((m) => m.ev === 'position', 4000, 'first position event')
assert(typeof pos1?.positionMs === 'number', 'position event has positionMs')
await new Promise((r) => setTimeout(r, 1200))
const pos2 = await waitFor((m) => m.ev === 'position' && m.positionMs > (pos1?.positionMs ?? 0), 4000, 'position advances')
assert(!!pos2, 'position advances while playing (' + pos1?.positionMs + ' → ' + pos2?.positionMs + ')')

// 4. seek / volume / pause
const seek = await cmd({ cmd: 'seek', positionMs: 42000 })
assert(seek?.ok === true, 'seek ok')
const posSeek = await waitFor((m) => m.ev === 'position' && m.positionMs >= 42000, 3000, 'position after seek >= 42000')
assert(!!posSeek, 'position jumped to seek target (' + posSeek?.positionMs + ')')
const vol = await cmd({ cmd: 'set_volume', volume: 0.5 })
assert(vol?.ok === true && vol.data?.volume === 0.5, 'set_volume ok')
const pause = await cmd({ cmd: 'pause' })
assert(pause?.ok === true, 'pause ok')
const stPause = await waitFor((m) => m.ev === 'state' && m.state === 'paused', 3000, 'state paused after pause')
assert(!!stPause, 'state=paused is authoritative')

// 4b. 循环模式 / 静音 / 输出模式：命令被接受，且权威值经 state 回传
const rep = await cmd({ cmd: 'set_repeat', mode: 'shuffle' })
assert(rep?.ok === true && rep.data?.mode === 'shuffle', 'set_repeat(shuffle) ok')
const stRepeat = await waitFor((m) => m.ev === 'state' && m.repeatMode === 'shuffle', 3000, 'state carries repeatMode')
assert(!!stRepeat, 'state reports the authoritative repeatMode (client memory is not the source)')
const repBad = await cmd({ cmd: 'set_repeat', mode: 'sometimes' })
assert(repBad?.ok === false && repBad?.error?.code === 'ERR_STATE', 'unknown repeat mode → ERR_STATE')

const mute = await cmd({ cmd: 'set_muted', muted: true })
assert(mute?.ok === true && mute.data?.muted === true, 'set_muted(true) ok')
assert(mute.data?.volume === 0.5, 'set_muted echoes the UNCHANGED volume (got ' + mute.data?.volume + ')')
const stMute = await waitFor((m) => m.ev === 'state' && m.muted === true, 3000, 'state carries muted')
assert(stMute?.volume === 0.5, 'a muted state event still reports the chosen volume')
const muteBad = await cmd({ cmd: 'set_muted', muted: 'yes' })
assert(muteBad?.ok === false && muteBad?.error?.code === 'ERR_STATE', 'non-boolean muted → ERR_STATE')
const unmute = await cmd({ cmd: 'set_muted', muted: false })
assert(unmute?.ok === true && unmute.data?.muted === false, 'unmute ok')

const outExcl = await cmd({ cmd: 'set_output', mode: 'exclusive' })
assert(outExcl?.ok === true, 'set_output(exclusive) ok')
const stOut = await waitFor((m) => m.ev === 'state' && m.outputMode === 'exclusive', 3000, 'state carries outputMode')
assert(!!stOut, 'state reports the ACTUAL output mode after a switch')
const outBad = await cmd({ cmd: 'set_output', mode: 'analog' })
assert(outBad?.ok === false && outBad?.error?.code === 'ERR_STATE', 'unknown output mode → ERR_STATE')

// 5a. 暂停态跳曲：不推流、不发 ended，新曲保持 paused（state 权威）
const nextPaused = await cmd({ cmd: 'next' })
assert(nextPaused?.ok === true && nextPaused.data?.trackId === 'tl_0002', 'next(paused) → tl_0002')
const stNextPaused = await waitFor((m) => m.ev === 'state' && m.trackId === 'tl_0002' && m.state === 'paused', 3000, 'state paused tl_0002')
assert(!!stNextPaused, 'next while paused stays paused')
const prevPaused = await cmd({ cmd: 'prev' })
assert(prevPaused?.ok === true && prevPaused.data?.trackId === 'tl_0001', 'prev(paused) → tl_0001')

// 5b. 播放态跳曲：旧曲 ended(stop)，新曲继续 playing
const resume = await cmd({ cmd: 'play' })
assert(resume?.ok === true, 'resume play ok')
await waitFor((m) => m.ev === 'state' && m.trackId === 'tl_0001' && m.state === 'playing', 3000, 'state playing tl_0001 after resume')
const next = await cmd({ cmd: 'next' })
assert(next?.ok === true && next.data?.trackId === 'tl_0002', 'next → tl_0002')
const endedStop = await waitFor((m) => m.ev === 'ended' && m.reason === 'stop', 3000, 'ended(stop) on skip')
assert(endedStop?.trackId === 'tl_0001', 'ended(stop) carries old trackId')
const stNext = await waitFor((m) => m.ev === 'state' && m.trackId === 'tl_0002' && m.state === 'playing', 3000, 'state playing tl_0002')
assert(!!stNext, 'next keeps playing')
const prev = await cmd({ cmd: 'prev' })
assert(prev?.ok === true && prev.data?.trackId === 'tl_0001', 'prev → tl_0001')
const endedPrev = await waitFor((m) => m.ev === 'ended' && m.reason === 'stop' && m.trackId === 'tl_0002', 3000, 'ended(stop) on prev')
assert(!!endedPrev, 'prev while playing emits ended(stop) for old track')

// 6. stop / ERR_STATE / ERR_NOTFOUND / ERR_UNSUPPORTED
const stop = await cmd({ cmd: 'stop' })
assert(stop?.ok === true, 'stop ok')
await waitFor((m) => m.ev === 'state' && m.state === 'paused' && m.trackId === 'tl_0001', 3000, 'state after stop (paused@0)')
const playNoOpen = await cmd({ cmd: 'open', trackId: 'tl_nope' })
assert(playNoOpen?.ok === false && playNoOpen?.error?.code === 'ERR_NOTFOUND', 'unknown trackId → ERR_NOTFOUND')
const badCmd = await cmd({ cmd: 'dance' })
assert(badCmd?.ok === false && badCmd?.error?.code === 'ERR_UNSUPPORTED', 'unknown cmd → ERR_UNSUPPORTED')

// 7. shutdown → 进程干净退出
const bye = await cmd({ cmd: 'shutdown' })
assert(bye?.ok === true, 'shutdown ok')
const exited = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('timeout'), 3000)
  child.on('exit', (code) => { clearTimeout(t); resolve(code) })
})
assert(exited === 0, 'engine exits 0 on shutdown (got ' + exited + ')')

console.log(failures === 0 ? '\nALL ' + checks + ' CHECKS PASSED' : '\n' + failures + '/' + checks + ' CHECKS FAILED')
process.exit(failures === 0 ? 0 : 1)
