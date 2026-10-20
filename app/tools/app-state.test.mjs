import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as store from '../src/renderer/src/store.ts'
import { encodePath, describePath } from '../src/renderer/src/c2/encodePath.ts'
import { getPosition, resetPosition } from '../src/renderer/src/positionStore.ts'
import { engineRequest, openAndPlay } from '../src/renderer/src/ipc.ts'
import * as ipc from '../src/renderer/src/ipc.ts'

const { useTwilight } = store
const trace = JSON.parse(readFileSync(new URL('../../engine/fixtures/state-traces.json', import.meta.url), 'utf8'))
const states = trace.events.filter(e => e.ev === 'state')
const active = states.find(e => e.dspActive === true)
assert.ok(active, 'the engine trace must include active DSP')
beforeEach(() => {
  useTwilight.setState(useTwilight.getInitialState(), true)
  resetPosition(null, 0)
})

test('startup and reconnect share one hello/snapshot synchronization', async () => {
  const commands = []
  globalThis.window = { twilight: { request: async ({ cmd }) => {
    commands.push(cmd)
    return { ok: true, data: cmd === 'hello' ? { capabilities: trace.capabilities } : active }
  } } }
  await Promise.all([ipc.synchronizeEngine(), ipc.synchronizeEngine()])
  assert.deepEqual(commands, ['hello', 'get_state'])
  assert.equal(useTwilight.getState().dspCapable, true)
  assert.equal(useTwilight.getState().dspActive, true)
  useTwilight.getState().applyEvent({ ev: 'ready' })
  await ipc.synchronizeEngine()
  assert.equal(useTwilight.getState().dspCapable, true)
})

test('successful reconnect clears only the connection error, preserving protocol diagnostics', async () => {
  useTwilight.getState().setProtocolError('malformed stdout')
  useTwilight.getState().setConnectionError('engine exited')
  assert.equal(useTwilight.getState().engineUp, false)
  globalThis.window = { twilight: { request: async ({ cmd }) => ({ ok: true, data: cmd === 'hello' ? { capabilities: trace.capabilities } : active }) } }
  useTwilight.getState().applyEvent({ ev: 'ready' })
  await ipc.synchronizeEngine(true)
  assert.equal(useTwilight.getState().connectionError, null)
  assert.equal(useTwilight.getState().protocolError, 'malformed stdout')
  assert.equal(useTwilight.getState().engineUp, true)
})

test('snapshot compatibility ignores missing implementation but surfaces hardware failure', async () => {
  for (const kind of [undefined, 'not_implemented', 'hardware']) {
    globalThis.window = { twilight: { request: async ({ cmd }) => cmd === 'hello'
      ? { ok: true, data: {} }
      : { ok: false, error: { code: 'ERR_UNSUPPORTED', kind, message: 'unsupported' } } } }
    if (kind === 'hardware') await assert.rejects(ipc.synchronizeEngine(), e => e.kind === 'hardware')
    else await ipc.synchronizeEngine()
  }
})

test('ready arriving after hello schedules a fresh handshake before synchronization completes', async () => {
  const snapshotRequested = Promise.withResolvers()
  const firstSnapshot = Promise.withResolvers()
  const commands = []
  globalThis.window = { twilight: { request: async ({ cmd }) => {
    commands.push(cmd)
    if (cmd === 'hello') return { ok: true, data: { capabilities: trace.capabilities } }
    if (commands.length === 2) {
      snapshotRequested.resolve()
      return firstSnapshot.promise
    }
    return { ok: true, data: active }
  } } }
  const first = ipc.synchronizeEngine()
  await snapshotRequested.promise
  assert.equal(useTwilight.getState().dspCapable, true)
  useTwilight.getState().applyEvent({ ev: 'ready' })
  const restarted = ipc.synchronizeEngine(true)
  firstSnapshot.resolve({ ok: true, data: active })
  await Promise.all([first, restarted])
  assert.equal(useTwilight.getState().dspCapable, true)
  assert.ok(encodePath(store.selectSignalSnapshot(useTwilight.getState())).segs.includes('wave'))
  assert.deepEqual(commands, ['hello', 'get_state', 'hello', 'get_state'])
})

test('old-track state cannot overwrite pending intent telemetry', () => {
  useTwilight.getState().applyEvent({ ...active, dspActive: false })
  useTwilight.getState().beginIntent('new-track')
  useTwilight.getState().applyEvent(active)
  assert.equal(useTwilight.getState().dspActive, false)
  assert.equal(useTwilight.getState().intent.trackId, 'new-track')
})

test('get_state reply restores paused position and DSP without polling', async () => {
  const data = { ...active, state: 'paused', positionMs: 12000 }
  globalThis.window = { twilight: { request: async () => ({ ok: true, data }) } }
  assert.deepEqual(await engineRequest({ cmd: 'get_state' }), data)
  assert.equal(useTwilight.getState().dspActive, true)
  assert.equal(useTwilight.getState().loadedTrackId, active.trackId)
  assert.equal(getPosition().positionMs, 12000)
  assert.equal(getPosition().trackId, active.trackId)
  assert.equal(useTwilight.getState().pendingRequests, 0)
})

test('an unloaded state clears the previous track and does not invent exclusive output', () => {
  useTwilight.getState().applyEvent(active)
  useTwilight.getState().applyEvent({ ...active, state: 'stopped', trackId: '', outputMode: 'none', durationMs: 0, positionMs: 0 })
  assert.equal(useTwilight.getState().loadedTrackId, null)
  assert.equal(useTwilight.getState().playState, 'no-track')
  assert.equal(useTwilight.getState().outputMode, null)
  assert.equal(getPosition().durationMs, 0)
})

test('repeat mode and mute come from the engine, and an old engine does not silently reset them', () => {
  const s = () => useTwilight.getState()
  s().applyEvent({ ...active, repeatMode: 'shuffle', muted: true, volume: 0.62 })
  assert.equal(s().repeatMode, 'shuffle', 'authoritative repeatMode is consumed')
  assert.equal(s().muted, true, 'authoritative muted is consumed')
  // 静音不改音量：这两个是独立事实（引擎为此专门分开上报）。
  assert.equal(s().volume, 0.62, 'muting does not zero the volume')

  // 旧引擎（2026-10-15 20:35 之前的构建）不发这两个字段。
  // 缺失必须保持当前值 —— 当成「顺序循环/未静音」会把用户刚设的模式抹掉。
  s().applyEvent({ ...active, volume: 0.62 })
  assert.equal(s().repeatMode, 'shuffle', 'absent repeatMode keeps the previous value')
  assert.equal(s().muted, true, 'absent muted keeps the previous value')

  // 非法值同样不能污染状态。
  s().applyEvent({ ...active, repeatMode: 'sometimes', muted: 'yes' })
  assert.equal(s().repeatMode, 'shuffle')
  assert.equal(s().muted, true)

  // 引擎不在了：没有权威来源，回默认而不是把上一台引擎的模式继续当成当前事实。
  s().setConnectionError('engine gone')
  assert.equal(s().repeatMode, 'sequential')
  assert.equal(s().muted, false)
})

/**
 * 验收（MASTER-B-app §4.1-11）：**快速连续切歌，旧任务的返回不得改变新播放状态**。
 *
 * 这是确定性注入：把「慢的那首」的 open 回复人为拖到 80ms，快的那首立刻返回，
 * 于是慢回复必然在快链路走完之后才到 —— 不用赌真实引擎的时序。
 *
 * 应用侧本来就防了两层（ipc.ts 的 playbackRequestSequence + store 里 confirmIntent/failIntent
 * 的 trackId 匹配），但此前**没有任何测试**盯着它；这条测试就是防止它被无声删掉。
 */
test('a slow open from a superseded track never takes over the new playback', async () => {
  const calls = []
  globalThis.window = { twilight: { request: async (cmd) => {
    calls.push(cmd.trackId ? cmd.cmd + ':' + cmd.trackId : cmd.cmd)
    if (cmd.cmd === 'open' && cmd.trackId === 'tl_slow') {
      await new Promise(resolve => setTimeout(resolve, 80))
      return { ok: true, data: { trackId: 'tl_slow', durationMs: 1000 } }
    }
    if (cmd.cmd === 'open') return { ok: true, data: { trackId: cmd.trackId, durationMs: 2000 } }
    return { ok: true, data: {} }
  } } }
  const s = () => store.useTwilight.getState()
  s().applyHello({ capabilities: { queue: false } })   // 不走 set_queue，让命令序列更好读
  s().setTracks([
    { trackId: 'tl_slow', title: 'slower', artist: '', durationMs: 1000, path: 'D:/x/slow.flac' },
    { trackId: 'tl_fast', title: 'faster', artist: '', durationMs: 2000, path: 'D:/x/fast.flac' }
  ])

  await Promise.all([openAndPlay('tl_slow'), openAndPlay('tl_fast')])

  assert.equal(s().loadedTrackId, 'tl_fast', '被顶替的那次 open 不许成为当前曲目')
  assert.equal(s().durationMs, 2000, '时长也必须来自胜出的那次，不能是慢回复的 1000')
  assert.equal(s().intent, null, 'intent 必须已经落定，不能卡在 loading')
  // 命令都发出去了，但**权威 state 事件还没来**：界面必须停在 loading，不能自己宣称在播。
  assert.equal(s().playState, 'loading', '在权威 state 事件到达前不许自称已播放')
  assert.equal(calls.filter(call => call === 'play').length, 1, '只许发出一次 play —— 被顶替的链路必须在 play 之前就返回')
  assert.deepEqual(calls.filter(call => call.startsWith('open')), ['open:tl_slow', 'open:tl_fast'], '两次 open 都发了，但只有后者兑现')
})

test('output preference and actual mode stay separate facts', () => {
  const s = () => useTwilight.getState()
  s().applyEvent({ ...active, outputMode: 'shared', degradeReason: '端点拒绝独占' })
  s().setOutputPreference('exclusive')
  assert.equal(s().outputPreference, 'exclusive', 'the request is remembered')
  assert.equal(s().outputMode, 'shared', 'the actual mode is still what the engine reports')
  assert.equal(s().degradeReason, '端点拒绝独占', 'the reason stays visible rather than looking like success')
})

test('high-frequency position does not notify the global store when metadata is unchanged', () => {
  useTwilight.getState().applyEvent(active)
  let renders = 0
  const off = useTwilight.subscribe(() => renders++)
  useTwilight.getState().applyEvent({ ev: 'position', trackId: active.trackId, positionMs: 500, durationMs: active.durationMs })
  useTwilight.getState().applyEvent({ ev: 'position', trackId: active.trackId, positionMs: 600, durationMs: active.durationMs })
  off()
  assert.equal(renders, 0)
  assert.equal(getPosition().positionMs, 600)
})

test('real trace preserves DSP, bypass, BP and genuine fallback through the store', () => {
  useTwilight.getState().applyHello({ capabilities: trace.capabilities })
  let waves = 0, bypass = 0, bp = 0, warnings = 0
  for (const event of states) {
    useTwilight.getState().applyEvent(event)
    const snapshot = store.selectSignalSnapshot(useTwilight.getState())
    const path = encodePath(snapshot)
    if (event.dspActive) { waves++; assert.ok(path.segs.includes('wave')); assert.equal(path.bp, false) }
    else { bypass++; assert.equal(path.segs.includes('wave'), false) }
    if (event.bitPerfect) { bp++; assert.equal(path.bp, true) }
    if (event.degradeReason) {
      warnings++
      assert.equal(path.severity, 'warn')
      assert.ok(path.segs.includes('dash'))
      assert.equal(path.bp, false)
      assert.ok(describePath(snapshot).includes(event.degradeReason))
    }
  }
  assert.ok(waves > 0 && bypass > 0 && bp > 0 && warnings > 0)
})

test('unsupported errors preserve kind and settle request accounting', async () => {
  for (const kind of ['hardware', 'not_implemented']) {
    globalThis.window = { twilight: { request: async () => ({ ok: false, error: { code: 'ERR_UNSUPPORTED', kind, message: 'unsupported' } }) } }
    await assert.rejects(engineRequest({ cmd: 'get_state' }), e => e.code === 'ERR_UNSUPPORTED' && e.kind === kind)
    assert.equal(useTwilight.getState().pendingRequests, 0)
  }
})

test('hello reply capability and state event reach the C2 selector', async () => {
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: { capabilities: trace.capabilities } }) } }
  await engineRequest({ cmd: 'hello', protocol: 1 })
  useTwilight.getState().applyEvent(active)
  assert.equal(useTwilight.getState().dspCapable, true)
  assert.equal(useTwilight.getState().dspActive, true)
  assert.deepEqual(useTwilight.getState().dspModules, ['eq'])
  const snapshot = store.selectSignalSnapshot(useTwilight.getState())
  assert.ok(encodePath(snapshot).segs.includes('wave'))
  assert.equal(encodePath(snapshot).bp, false)
  assert.match(describePath(snapshot), /EQ/)
})

test('missing or false capability never claims a DSP segment', () => {
  useTwilight.getState().applyEvent(active)
  assert.equal(useTwilight.getState().dspCapable, null)
  assert.equal(encodePath(store.selectSignalSnapshot(useTwilight.getState())).segs.includes('wave'), false)
  useTwilight.getState().applyHello({ capabilities: { dsp: false } })
  assert.equal(encodePath(store.selectSignalSnapshot(useTwilight.getState())).segs.includes('wave'), false)
})

test('malformed optional telemetry clears stale values', () => {
  useTwilight.getState().applyEvent(active)
  useTwilight.getState().applyEvent({ ...active, dspActive: 'true', dspModules: ['eq', 5], xrunCount: -1 })
  assert.equal(useTwilight.getState().dspActive, null)
  assert.equal(useTwilight.getState().dspModules, null)
  assert.equal(useTwilight.getState().xrunCount, null)
})

test('state owns cumulative xruns across tracks; transient events do not add it', () => {
  useTwilight.getState().applyEvent({ ...active, xrunCount: 7 })
  useTwilight.getState().applyEvent({ ev: 'xrun', count: 8, bufferMs: 10 })
  assert.equal(useTwilight.getState().xrunCount, 7)
  useTwilight.getState().beginIntent('next')
  assert.equal(useTwilight.getState().xrunCount, 7)
  useTwilight.getState().applyEvent({ ...active, trackId: 'next', xrunCount: 8 })
  assert.equal(useTwilight.getState().xrunCount, 8)
  assert.match(describePath(store.selectSignalSnapshot(useTwilight.getState())), /xrun 8/)
  useTwilight.getState().applyEvent({ ev: 'ready', protocol: 1, version: 'test', devices: [] })
  assert.equal(useTwilight.getState().xrunCount, null)
  assert.equal(useTwilight.getState().dspActive, null)
})
