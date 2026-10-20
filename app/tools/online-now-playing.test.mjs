import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTwilight, selectLoadedTrack, streamingAsTrack } from '../src/renderer/src/store.ts'
import { getPosition, resetPosition } from '../src/renderer/src/positionStore.ts'

/**
 * 在线播放的「正在播放」。
 *
 * 这些断言守的是一条真实故障链：引擎对 `open { url }` 的 state 事件里 trackId 是
 * **空字符串**（CR-016 约束 3，元数据归应用侧）。旧代码把空 trackId 直接判成
 * 「未在播放」，于是有声音、界面上却没有标题、没有进度、按钮全灰 ——
 * 用户看到的是「播放没有反映到任何界面上」。
 */
const onlineTrack = {
  platform: 'qq',
  id: '004Z8Ihr0JIu5s',
  title: '七里香',
  artist: '周杰伦',
  album: '七里香',
  durationMs: 299000,
  cover: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000002Z8Ihr0JIu5s.jpg',
  quality: 'best'
}

beforeEach(() => {
  useTwilight.setState(useTwilight.getInitialState(), true)
  resetPosition(null, 0)
})

/** 引擎对 URL 源的 state 事件：trackId 是空串，其余字段照常。 */
const urlState = (state, extra = {}) => ({
  ev: 'state', state, trackId: '', positionMs: 0, durationMs: 35000,
  outputMode: 'shared', sampleRate: 44100, bitDepth: 32, containerBits: 32, validBits: 32,
  channels: 2, deviceName: 'Test DAC', periodMs: 10, bitPerfect: false, xrunCount: 0,
  repeatMode: 'sequential', muted: false, ...extra
})

test('an online open becomes a real now-playing state, not "no-track"', () => {
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  assert.equal(useTwilight.getState().playState, 'loading')
  assert.equal(useTwilight.getState().onlineTrack?.id, onlineTrack.id)

  useTwilight.getState().confirmOnlinePlayback(35000, 'flac')
  useTwilight.getState().applyEvent(urlState('playing'))

  const state = useTwilight.getState()
  assert.equal(state.loadedTrackId, null, 'a URL source has no catalog entry')
  assert.equal(state.playState, 'playing', 'the engine says playing, so the UI must too')
  assert.equal(state.durationMs, 35000, 'the engine-measured length wins over the platform one')
  assert.equal(state.sampleRate, 44100)
  assert.equal(state.onlineTrack?.quality, 'flac')
  // 「正在播放」的标题/艺人/专辑来自应用侧元数据。
  const track = selectLoadedTrack(state)
  assert.ok(track, 'selectLoadedTrack must resolve the online track')
  assert.equal(track.title, '七里香')
  assert.equal(track.artist, '周杰伦')
  assert.equal(track.durationMs, 35000)
})

test('pause, resume and position events keep the online track attached', () => {
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  useTwilight.getState().applyEvent(urlState('playing'))
  useTwilight.getState().applyEvent(urlState('paused', { positionMs: 12000 }))
  assert.equal(useTwilight.getState().playState, 'paused')
  assert.notEqual(useTwilight.getState().onlineTrack, null)

  // position 事件同样没有 trackId：进度必须继续走，不能被丢掉。
  useTwilight.getState().applyEvent({ ev: 'position', trackId: '', positionMs: 15000, durationMs: 35000 })
  assert.equal(getPosition().positionMs, 15000)
  assert.equal(getPosition().durationMs, 35000)
})

test('stopping the engine closes the online session', () => {
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  useTwilight.getState().applyEvent(urlState('playing'))
  useTwilight.getState().applyEvent(urlState('stopped'))
  assert.equal(useTwilight.getState().playState, 'no-track')
  assert.equal(useTwilight.getState().onlineTrack, null, 'a stopped engine has no now-playing track')
})

test('a local track taking over retires the online metadata', () => {
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  useTwilight.getState().applyEvent(urlState('playing'))
  useTwilight.getState().applyEvent({ ...urlState('playing'), trackId: 'local-1' })
  assert.equal(useTwilight.getState().onlineTrack, null)
  assert.equal(useTwilight.getState().loadedTrackId, 'local-1')
  // 打开本地曲目（intent 链路）时也要立刻收起在线元数据。
  store.beginOnlinePlayback(onlineTrack)
  useTwilight.getState().beginIntent('local-2')
  assert.equal(useTwilight.getState().onlineTrack, null)
})

test('an empty trackId with no online metadata still means "not playing"', () => {
  // 别的客户端也能让引擎放一个 URL；这边没有它的元数据，不能编一个标题出来。
  useTwilight.getState().applyEvent(urlState('playing'))
  assert.equal(useTwilight.getState().playState, 'no-track')
  assert.equal(selectLoadedTrack(useTwilight.getState()), null)
})

test('engine restart clears the online session', () => {
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  useTwilight.getState().applyEvent(urlState('playing'))
  useTwilight.getState().applyEvent({ ev: 'ready', protocol: 1, version: 'test', devices: [] })
  assert.equal(useTwilight.getState().onlineTrack, null)
})

test('the synthesized track keeps the online id out of engine command paths', () => {
  const track = streamingAsTrack(onlineTrack, 0)
  assert.equal(track.trackId, 'online:qq:004Z8Ihr0JIu5s')
  assert.equal(track.path, '', 'no local path exists for a stream')
  assert.equal(track.durationMs, 299000)
})
test('the online track selector is referentially stable (zustand would loop otherwise)', () => {
  // 这个断言守的是一个真实的崩溃：selectLoadedTrack 作为 zustand selector 时
  // 每次返回新对象 → useSyncExternalStore 认为快照一直在变 → React #185
  // "Maximum update depth exceeded"，整棵界面卸载成白屏。
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  useTwilight.getState().applyEvent(urlState('playing'))
  const first = selectLoadedTrack(useTwilight.getState())
  const second = selectLoadedTrack(useTwilight.getState())
  assert.ok(first)
  assert.equal(first, second, 'the same state must yield the same object reference')

  // 时长变化（引擎实测覆盖平台值）允许换一次新对象，但仍必须稳定下来。
  useTwilight.getState().confirmOnlinePlayback(32000)
  const third = selectLoadedTrack(useTwilight.getState())
  const fourth = selectLoadedTrack(useTwilight.getState())
  assert.notEqual(third, first)
  assert.equal(third, fourth)
  assert.equal(third.durationMs, 32000)
})
test('the stopped state emitted while a URL source is opening does not end the session', () => {
  // 引擎 open 一个 URL 源时会先发 state=stopped（源已装载、尚未开播），随后 play
  // 才发 playing。第一版把这条中间态当成「播完了」，于是 onlineTrack 被清掉，
  // 紧接着的 playing 事件没人认识 —— 用户看到的是「点了播放，标题闪回未在播放，声音却在放」。
  const store = useTwilight.getState()
  store.beginOnlinePlayback(onlineTrack)
  assert.equal(useTwilight.getState().playState, 'loading')
  useTwilight.getState().applyEvent(urlState('stopped', { durationMs: 3000 }))
  assert.notEqual(useTwilight.getState().onlineTrack, null, 'an open is not a stop')
  assert.equal(useTwilight.getState().playState, 'paused')
  assert.equal(useTwilight.getState().durationMs, 3000)
  useTwilight.getState().applyEvent(urlState('playing', { durationMs: 3000 }))
  assert.equal(useTwilight.getState().playState, 'playing')
  assert.equal(selectLoadedTrack(useTwilight.getState())?.title, '七里香')
  // 真正播过之后的 stopped 才结束会话。
  useTwilight.getState().applyEvent(urlState('stopped', { durationMs: 3000 }))
  assert.equal(useTwilight.getState().playState, 'no-track')
  assert.equal(useTwilight.getState().onlineTrack, null)
})
