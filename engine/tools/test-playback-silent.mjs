// Short real-device lifecycle regression. Mute is acknowledged BEFORE any play.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const library = process.argv[2]
const DEVICE = process.env.TE_DEVICE || ''   // 非默认端点（默认端点被用户实例占用时用）
if (!library) throw new Error('usage: node test-playback-silent.mjs <library>')
const child = spawn(fileURLToPath(new URL('../bin/twilight-engine.exe', import.meta.url)), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(), events = []
let id = 0, assertions = 0, stderr = ''
const timer = setTimeout(() => child.kill(), 45000)
const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
child.stderr.on('data', chunk => { stderr += chunk })
child.on('error', error => { for (const item of pending.values()) item.reject(error) })
child.on('exit', code => { for (const item of pending.values()) item.reject(new Error(`engine exit ${code}: ${stderr}`)) })
createInterface({ input: child.stdout }).on('line', line => {
  try {
    const frame = JSON.parse(line)
    if (frame.id && pending.has(frame.id)) {
      const item = pending.get(frame.id)
      pending.delete(frame.id)
      frame.ok ? item.resolve(frame.data) : item.reject(new Error(JSON.stringify(frame.error)))
    } else events.push(frame)
  } catch (error) { for (const item of pending.values()) item.reject(error) }
})
function request(cmd) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    child.stdin.write(JSON.stringify({ id: requestId, ...cmd }) + '\n')
  })
}
function check(value, message) { ++assertions; assert.ok(value, message) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// 轮询到目标状态（最多 timeoutMs），避免固定 sleep 在忙机器/慢设备上误判。
async function waitForState(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let state = await request({ cmd: 'get_state' })
  while (!predicate(state) && performance.now() < deadline) {
    await delay(20)
    state = await request({ cmd: 'get_state' })
  }
  return state
}
try {
  await request({ cmd: 'set_muted', muted: true })
  await request({ cmd: 'set_output', mode: 'shared', ...(DEVICE ? { deviceId: DEVICE } : {}) })
  const { tracks } = await request({ cmd: 'scan', path: library })
  check(tracks.length > 0, 'scan found tracks')
  const rates = [...new Set(tracks.map(track => track.sampleRate))].slice(0, 3)
  for (const rate of rates) {
    const track = tracks.find(item => item.sampleRate === rate)
    await request({ cmd: 'open', trackId: track.trackId })
    const meterBaseline = await request({ cmd: 'get_state' })
    const beforeVisible = events.filter(event => event.ev === 'meter').length
    await request({ cmd: 'play' })
    await delay(150)
    check(events.filter(event => event.ev === 'meter').length === beforeVisible,
      'meter push defaults to disabled until a visible UI subscribes')
    for (const invalid of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
      await assert.rejects(request({ cmd: 'set_meter', ...invalid }), /ERR_STATE/)
      ++assertions
    }
    const enabled = await request({ cmd: 'set_meter', enabled: true })
    check(enabled.enabled === true, 'set_meter acknowledges visibility without changing playback')
    await delay(250)
    let state = await request({ cmd: 'get_state' })
    check(state.state === 'playing' && state.muted, 'playing remains muted after reopen')
    const meter = events.filter(event => event.ev === 'meter').at(-1)
    check(meter && Array.isArray(meter.spectrum) && meter.spectrum.length === 48 &&
      meter.spectrum.every(Number.isFinite), 'playback emits 48 measured log-frequency bands')
    check(meter && meter.rmsDb.length === meter.peakDb.length && meter.rmsDb.length > 0 &&
      meter.peakHoldDb.length === meter.rmsDb.length && meter.truePeakDb.length === meter.rmsDb.length,
      'meter levels and peak holds are reported per output channel')
    check(meter && ['sample', 'oversampled'].includes(meter.truePeakBasis),
      'meter labels whether true peak was oversampled')
    check(state.outputPerfect === meterBaseline.outputPerfect &&
      JSON.stringify(state.dspModules) === JSON.stringify(meterBaseline.dspModules),
      'monitoring leaves output quality and sample-changing DSP state untouched')
    // R8：waveform 字段已从 IPC 移除（渲染层 meterStore 从不消费它；真机 749 B/帧
    // 里约 550 B 是它）。断言从"长度 64"改为"不再发送"，分析正确性继续由上面的
    // 48 段频谱/电平断言覆盖（分析器内部仍计算 waveform，--selftest 验证它）。
    check(meter && !('waveform' in meter),
      'meter payload no longer carries the unconsumed waveform field')
    // R8：数值收敛到 0.1 dB。既省 IPC 字节（to_chars 输出 "-12.3" 而不是
    // "-12.345678901234567"），也不改变人眼可辨的读数。
    check(meter && meter.spectrum.every(value => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9),
      'meter spectrum values are quantized to 0.1 dB steps')
    const disabled = await request({ cmd: 'set_meter', enabled: false })
    check(disabled.enabled === false, 'hidden UI disables meter push')
    const hiddenFrameCount = events.filter(event => event.ev === 'meter').length
    await delay(150)
    check(events.filter(event => event.ev === 'meter').length === hiddenFrameCount,
      'no meter frames arrive after the disable acknowledgement')
    await request({ cmd: 'set_meter', enabled: true })
    await delay(150)
    check(events.filter(event => event.ev === 'meter').length > hiddenFrameCount,
      'restoring visibility resumes measured frames')
    const pauseStarted = performance.now()
    await request({ cmd: 'pause' })
    const pauseElapsedMs = performance.now() - pauseStarted
    check(pauseElapsedMs < 250,
      `pause stays responsive (${pauseElapsedMs.toFixed(1)} ms, buffer=${state.currentBufferMs} ms, mode=${state.outputMode})`)
    state = await request({ cmd: 'get_state' })
    check(state.state === 'paused', 'pause acknowledged')
    await request({ cmd: 'seek', positionMs: 1000 })
    await request({ cmd: 'play' })
    await delay(200)
    state = await request({ cmd: 'get_state' })
    check(state.positionMs >= 1000 && state.positionMs < 3000, 'seek resumes from requested position')
    await request({ cmd: 'stop' })
    state = await request({ cmd: 'get_state' })
    check(state.state === 'stopped' && state.positionMs === 0 && state.feederDelivered === 0,
      'stop rewinds both decoder accounting and visible position')
    await request({ cmd: 'play' })
    // 轮询到 playing（最多 1.5s），再给位置/解码计数一点落稳时间。
    // "从头开始"的判据用**输出采样率**：feederDelivered 数的是重采样后的输出帧，
    // 而夹具目录可能混入 1kHz/8kHz 的旧测试 WAV（本机 dsh-engine-lib 就有），
    // 用源采样率比较会把正常的 250ms 预缓冲误判成"没有从头开始"。
    state = await waitForState(s => s.state === 'playing', 1500)
    await delay(100)
    state = await request({ cmd: 'get_state' })
    check(state.state === 'playing' &&
      state.positionMs < 1000 &&
      state.feederDelivered < (state.sampleRate || 48000),
      'play after stop starts from the beginning ' +
      '(state=' + state.state + ', positionMs=' + state.positionMs +
      ', feederDelivered=' + state.feederDelivered + ', outRate=' + state.sampleRate + ')')
    const frozen = state.positionMs
    await request({ cmd: 'pause' })
    const paused = await request({ cmd: 'get_state' })
    await delay(150)
    state = await request({ cmd: 'get_state' })
    check(state.positionMs === paused.positionMs && state.positionMs >= frozen,
      'paused position stays still')
    await request({ cmd: 'play' })
    await delay(150)
    state = await request({ cmd: 'get_state' })
    check(state.positionMs >= paused.positionMs && state.positionMs < paused.positionMs + 1000,
      'resume continues without rewinding or jumping ahead')
    await request({ cmd: 'set_meter', enabled: false })
  }
  const state = await request({ cmd: 'get_state' })
  const eventStart = events.length
  await request({ cmd: 'seek', positionMs: Math.max(0, state.durationMs - 500) })
  const deadline = performance.now() + 5000
  while (!events.slice(eventStart).some(event => event.ev === 'ended') && performance.now() < deadline) await delay(50)
  check(events.slice(eventStart).some(event => event.ev === 'ended' && event.reason === 'eof'), 'drained track emits normal EOF')
  await request({ cmd: 'play' })
  await delay(250)
  const replayed = await request({ cmd: 'get_state' })
  check(replayed.state === 'playing' && replayed.renderedFrames > 0 && replayed.positionMs < 1000,
    'play after EOF restarts the current track')
  // Reopen while audio is active, including source-rate changes and exclusive
  // negotiation. Mute must survive every transition.
  await request({ cmd: 'set_output', mode: 'exclusive', ...(DEVICE ? { deviceId: DEVICE } : {}) })
  for (const rate of rates) {
    const track = tracks.find(item => item.sampleRate === rate)
    await request({ cmd: 'open', trackId: track.trackId })
    await request({ cmd: 'play' })
    await delay(200)
    const state = await request({ cmd: 'get_state' })
    check(state.state === 'playing' && state.muted && state.renderedFrames > 0,
      'track changes across exclusive formats keep muted playback flowing')
  }
  await request({ cmd: 'stop' })
  await request({ cmd: 'shutdown' })
  const result = await closed
  check(result.code === 0, 'engine exits cleanly')
  console.log(`silent playback PASS: ${assertions} assertions, ${rates.length} source rates`)
} finally {
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) child.kill()
}