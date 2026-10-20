// test-transport-silent.mjs — CR-028/CR-030 静音门禁：fade 配置、pause-hold、seek、切歌、队列保持。
// 用法: node test-transport-silent.mjs <library> [exePath] [label]
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

const EXE_DEFAULT = fileURLToPath(new URL('../bin/twilight-engine.exe', import.meta.url))
const LIB = process.argv[2] || process.env.STRINGMOON_TEST_LIBRARY || 'D:\\Music'
const EXE = process.argv[3] || EXE_DEFAULT
const LABEL = process.argv[4] || 'new'
const DEVICE = process.argv[5] || ''   // 可选：显式指定端点（默认设备被独占占用时测试用）
const child = spawn(EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(); let nextId = 0; const events = []; let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })
createInterface({ input: child.stdout }).on('line', (line) => {
  let f; try { f = JSON.parse(line) } catch { return }
  if (f.ev) { events.push(f); return }
  const p = pending.get(f.id); if (!p) return; pending.delete(f.id)
  f.ok ? p.resolve(f.data) : p.reject(Object.assign(new Error('engine error'), { frame: f }))
})
function request(cmd, timeoutMs = 60000) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + cmd.cmd)) }, timeoutMs)
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
  })
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const closed = new Promise((r) => child.on('close', (code) => r(code)))
const out = { label: LABEL, exe: EXE, steps: {}, errors: [] }
const lastState = () => events.filter((e) => e.ev === 'state').slice(-1)[0] || {}
async function expectError(cmd, name) {
  try { await request(cmd); out.errors.push(name + ': ACCEPTED(WRONG)'); return 'accepted' }
  catch (e) { return e.frame && e.frame.error ? e.frame.error.code : 'ERR' }
}
function assert(cond, msg) { if (!cond) out.errors.push('ASSERT: ' + msg) }
try {
  await new Promise((r, j) => { const i = setInterval(() => { if (events.some((e) => e.ev === 'ready')) { clearInterval(i); r() } }, 20); setTimeout(() => { clearInterval(i); j(new Error('no ready')) }, 15000) })
  await request({ cmd: 'hello', protocol: 1 })
  await request({ cmd: 'set_muted', muted: true })
  await request({ cmd: 'set_output', mode: 'shared', ...(DEVICE ? { deviceId: DEVICE } : {}) })
  const scan = await request({ cmd: 'scan', path: LIB })
  const tracks = scan.tracks || []
  // 取轨不能假设夹具的采样率组合：本机 dsh-engine-lib 只有 1 首 44.1k，还混着
  // 旧 1kHz/8kHz 的 3.6 秒 WAV；旧写法 t44[1] 直接 undefined，把用例 fatal 掉。
  //
  // 两条约束分开处理：
  //   * 播放步骤要 seek 到 5000ms，必须选 duration >= 6s 的曲目；
  //   * 队列用例只要 id（不播放），用全库前 6 首即可，且至少 4 条（ids[2] 当
  //     currentTrackId）。
  // 跨采样率用例优先 96k，没有就挑一首与 main[0] 不同率的。
  const longEnough = tracks.filter((t) => (t.durationMs ?? 0) >= 6000)
  const long44 = longEnough.filter((t) => t.sampleRate === 44100)
  const main = (long44.length >= 2 ? long44 : longEnough.length >= 2 ? longEnough : tracks).slice(0, 3)
  if (main.length < 2) {
    throw new Error('need at least 2 long-enough tracks for the transport checks, got ' + tracks.length)
  }
  const queueIds = tracks.slice(0, 6).map((t) => t.trackId)
  if (queueIds.length < 4) {
    throw new Error('need at least 4 scanned tracks for the queue checks, got ' + tracks.length)
  }
  const t96 = main.find((t) => t.sampleRate === 96000) ||
              tracks.find((t) => t.sampleRate === 96000) ||
              tracks.find((t) => t.sampleRate !== main[0].sampleRate)

  // --- CR-028: fade 配置 ---
  const before = lastState()
  out.steps.fadeConfigPresent = !!before.fade
  out.steps.defaultFade = before.fade
  const r4 = await expectError({ cmd: 'set_output', fadeMs: 4 }, 'fadeMs=4')
  const r51 = await expectError({ cmd: 'set_output', fadeMs: 51 }, 'fadeMs=51')
  out.steps.fadeInvalid = [r4, r51]
  const r7 = await request({ cmd: 'set_output', fadeMs: 7 }); out.steps.fadeSet = r7 && r7.fade ? r7.fade : lastState().fade
  await request({ cmd: 'set_output', fadeMs: 10 })
  const rHold = await request({ cmd: 'set_output', pauseHold: false })
  out.steps.holdSet = { state: lastState().fade, reply: rHold && rHold.fade }
  await request({ cmd: 'set_output', pauseHold: true })

  // --- pause-hold: 暂停期间流保持运行 ---
  await request({ cmd: 'open', trackId: main[0].trackId })
  await request({ cmd: 'play' })
  await delay(400)
  const posBefore = lastState().positionMs
  const t0 = performance.now()
  await request({ cmd: 'pause' })
  out.steps.pauseMs = +(performance.now() - t0).toFixed(1)
  await delay(120)
  const pausedState = lastState()
  out.steps.paused = { state: pausedState.state, streamHeld: pausedState.streamHeld, positionMs: pausedState.positionMs }
  await delay(500)
  const heldState = lastState()
  out.steps.heldAfter500ms = { positionMs: heldState.positionMs, streamHeld: heldState.streamHeld }
  const t1 = performance.now()
  await request({ cmd: 'play' })
  out.steps.resumeMs = +(performance.now() - t1).toFixed(1)
  await delay(500)
  const resumed = lastState()
  out.steps.resumed = { state: resumed.state, streamHeld: resumed.streamHeld, positionMs: resumed.positionMs }
  assert(resumed.positionMs > posBefore, 'resume continues from pause position (pos ' + resumed.positionMs + ' > ' + posBefore + ')')

  // --- seek（播放中）---
  const xBefore = resumed.xrunCount
  const t2 = performance.now()
  await request({ cmd: 'seek', positionMs: 5000 })
  out.steps.seekMs = +(performance.now() - t2).toFixed(1)
  await delay(350)
  const afterSeek = lastState()
  out.steps.seeked = { state: afterSeek.state, positionMs: afterSeek.positionMs, xrun: afterSeek.xrunCount, xrunDelta: (afterSeek.xrunCount ?? 0) - (xBefore ?? 0) }
  assert(afterSeek.state === 'playing', 'seek keeps playing state')
  assert(Math.abs((afterSeek.positionMs ?? 0) - 5000) < 900, 'seek lands near requested position (' + afterSeek.positionMs + ')')

  // --- cut/track change（同格式 shared 复用流）---
  await request({ cmd: 'open', trackId: main[1].trackId })
  await request({ cmd: 'play' })
  await delay(350)
  const afterSwitch = lastState()
  out.steps.switched = { state: afterSwitch.state, outputOpened: events.filter((e) => e.ev === 'log' && /output opened/.test(e.message || '')).length, xrun: afterSwitch.xrunCount }
  assert(afterSwitch.state === 'playing', 'track switch keeps playing')

  if (t96) {
    await request({ cmd: 'open', trackId: t96.trackId })
    await request({ cmd: 'play' })
    await delay(350)
    out.steps.crossRate = { state: lastState().state, sampleRate: lastState().sampleRate }
  }

  // --- CR-030: set_queue keepCurrent ---
  const ids = queueIds
  const q1 = await request({ cmd: 'set_queue', trackIds: ids, keepCurrent: true, currentTrackId: ids[2] })
  out.steps.queueKeep = { replyQueueIndex: q1.queueIndex, stateQueueIndex: lastState().queueIndex }
  assert(q1.queueIndex === 2, 'keepCurrent points queueIndex at currentTrackId (got ' + q1.queueIndex + ')')
  assert(lastState().queueIndex === 2, 'state.queueIndex reflects keepCurrent')
  const q2 = await request({ cmd: 'set_queue', trackIds: ids, keepCurrent: false })
  out.steps.queueReset = { replyQueueIndex: q2.queueIndex, stateQueueIndex: lastState().queueIndex }
  assert(q2.queueIndex === 0, 'without keepCurrent the queue index resets to 0')
  const q3 = await expectError({ cmd: 'set_queue', trackIds: ids, keepCurrent: true, currentTrackId: 'tl_9999' }, 'unknown currentTrackId')
  out.steps.queueUnknown = q3
  const q4 = await expectError({ cmd: 'set_queue', trackIds: ids, keepCurrent: 'yes' }, 'keepCurrent not bool')
  out.steps.queueBadKeep = q4
  // --- verifier 结构性计数：fade 真排空 / 排空超时 / Reset 顺序 ---
  const finalState = lastState()
  out.steps.structural = { fade: finalState.fade, dspModules: finalState.dspModules }
  assert(finalState.fade && typeof finalState.fade.fadeDrainTimeouts === 'number', 'state.fade.fadeDrainTimeouts present')
  assert(finalState.fade && finalState.fade.lastTransport && typeof finalState.fade.lastTransport.paddingAtStop === 'number', 'state.fade.lastTransport.paddingAtStop present')
  assert(finalState.fade && finalState.fade.lastTransport && typeof finalState.fade.lastTransport.fadeCompleted === 'boolean', 'state.fade.lastTransport.fadeCompleted present')
  assert(finalState.fade && finalState.fade.lastTransport && typeof finalState.fade.lastTransport.resetBeforeStart === 'boolean', 'state.fade.lastTransport.resetBeforeStart present')
  assert((finalState.fade?.fadeDrainTimeouts ?? 1) === 0, 'no fade drain timeouts during transport scenario')

  await request({ cmd: 'stop' })
  await request({ cmd: 'shutdown' })
} catch (e) {
  out.fatal = String(e && e.message ? e.message : e)
} finally {
  try { if (child.exitCode === null) child.kill() } catch {}
}
out.stderrTail = stderr.trim() ? stderr.trim().split(/\r?\n/).slice(-3) : []
out.pass = out.errors.length === 0 && !out.fatal
console.log(JSON.stringify(out, null, 1))
if (!out.pass) process.exitCode = 1