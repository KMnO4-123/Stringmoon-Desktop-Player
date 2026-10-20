import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTwilight } from '../src/renderer/src/store.ts'
import { engineRequest } from '../src/renderer/src/ipc.ts'

const frequencies = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const dsp = (gain = 0) => ({
  eq: { enabled: gain !== 0, q: 1.41, preampDb: 0, autoHeadroom: true,
    bands: frequencies.map(freq => ({ freq, gainDb: freq === 1000 ? gain : 0 })) },
  replayGain: { mode: 'off', trackGainDb: 0, albumGainDb: 0, preampDb: 0, preventClip: true },
  appliedGainDb: -Math.max(0, gain), passthrough: gain === 0, streaming: false
})
const state = (details) => ({ ev: 'state', state: 'paused', trackId: 'song', sampleRate: 48000, dsp: details })

beforeEach(() => useTwilight.setState(useTwilight.getInitialState(), true))

test('full get_state and set_eq replies populate authoritative EQ parameters', async () => {
  globalThis.window = { twilight: { request: async ({ cmd }) => ({ ok: true, data: cmd === 'get_state' ? state(dsp()) : dsp(6) }) } }
  await engineRequest({ cmd: 'get_state' })
  assert.equal(useTwilight.getState().dsp?.eq.enabled, false)
  await engineRequest({ cmd: 'set_eq', enabled: true, bandGains: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0] })
  assert.equal(useTwilight.getState().dsp?.eq.bands[5].gainDb, 6)
  assert.equal(useTwilight.getState().dsp?.appliedGainDb, -6)
  assert.equal(useTwilight.getState().pendingRequests, 0)
})

test('set_channels replies preserve authoritative mid-side and crossfeed settings', async () => {
  const reply = {
    ...dsp(),
    channels: {
      balance: 0, mono: false, midGainDb: 3, sideGainDb: 4, stereoWidth: 1.25,
      swapChannels: false, channelGains: [{ channel: 0, gainDb: 0 }, { channel: 1, gainDb: 0 }]
    },
    crossfeed: { enabled: true, preset: 1, fcHz: 700, feedDb: 6 }
  }
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: reply }) } }
  await engineRequest({ cmd: 'set_channels', midGainDb: 3, crossfeedPreset: 1 })
  assert.deepEqual(useTwilight.getState().dsp?.channels, reply.channels)
  assert.deepEqual(useTwilight.getState().dsp?.crossfeed, reply.crossfeed)
})

test('periodic state without DSP keeps details, missing full snapshot clears them', async () => {
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: state(dsp(3)) }) } }
  await engineRequest({ cmd: 'get_state' })
  const confirmed = useTwilight.getState().dsp
  assert.ok(confirmed)
  useTwilight.getState().applyEvent({ ev: 'state', state: 'playing', trackId: 'song', sampleRate: 48000 })
  assert.equal(useTwilight.getState().dsp, confirmed)
  globalThis.window.twilight.request = async () => ({ ok: true, data: state(undefined) })
  await engineRequest({ cmd: 'get_state' })
  assert.equal(useTwilight.getState().dsp, null)
})

test('invalid DSP replies remove stale curves instead of accepting non-finite gains', async () => {
  let reply = dsp(4)
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: reply }) } }
  await engineRequest({ cmd: 'set_eq', enabled: true })
  assert.ok(useTwilight.getState().dsp)
  reply = { ...dsp(4), eq: { ...dsp(4).eq, bands: [{ freq: 1000, gainDb: NaN }] } }
  await engineRequest({ cmd: 'set_eq', enabled: true })
  assert.equal(useTwilight.getState().dsp, null)
})

test('late full snapshot cannot replace a newer confirmed EQ edit', async () => {
  const delayed = Promise.withResolvers()
  globalThis.window = { twilight: { request: async ({ cmd }) => cmd === 'get_state' ? delayed.promise : { ok: true, data: dsp(8) } } }
  const oldSnapshot = engineRequest({ cmd: 'get_state' })
  await engineRequest({ cmd: 'set_eq', enabled: true })
  delayed.resolve({ ok: true, data: state(dsp()) })
  await oldSnapshot
  assert.equal(useTwilight.getState().dsp?.eq.bands[5].gainDb, 8)
})

test('engine restart invalidates pending DSP replies and clears parameter history', async () => {
  const delayed = Promise.withResolvers()
  globalThis.window = { twilight: { request: async () => delayed.promise } }
  const pending = engineRequest({ cmd: 'set_eq', enabled: true })
  useTwilight.getState().applyEvent({ ev: 'ready' })
  delayed.resolve({ ok: true, data: dsp(6) })
  await pending
  assert.equal(useTwilight.getState().dsp, null)
  assert.deepEqual(useTwilight.getState().dspHistory, [])
})

test('frequency history records parameter changes once, stays bounded and ignores streaming activity', async () => {
  let reply = dsp(1)
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: reply }) } }
  await engineRequest({ cmd: 'set_eq', enabled: true })
  const initial = useTwilight.getState().dspHistory
  assert.equal(initial?.length, 1)
  reply = { ...dsp(1), streaming: true }
  await engineRequest({ cmd: 'set_eq', enabled: true })
  assert.equal(useTwilight.getState().dspHistory, initial)
  for (let i = 0; i < 40; i++) {
    reply = dsp(i % 12)
    await engineRequest({ cmd: 'set_eq', enabled: true })
  }
  const history = useTwilight.getState().dspHistory
  assert.ok(history.length > 1 && history.length <= 16)
  assert.equal(history.at(-1).dsp.eq.bands[5].gainDb, 3)
})

// --- CR-019 完整参数：频段可以离开 SPEC 网格，且每段带自己的类型与 Q --------

const shaped = () => ({
  eq: { enabled: true, q: 1.41, preampDb: 0, autoHeadroom: true,
    bands: frequencies.map((freq, index) => ({
      freq,
      gainDb: 0,
      q: 1.41,
      type: 'peaking'
    })) },
  replayGain: { mode: 'off', trackGainDb: 0, albumGainDb: 0, preampDb: 0, preventClip: true },
  appliedGainDb: 0, passthrough: false, streaming: false
})

test('a band moved off the SPEC grid still yields complete parameters', async () => {
  const payload = shaped()
  // 用户把第 4 段拖到 1234 Hz —— 修复前这会让整份参数被判为非法，
  // dsp 变 null，面板全灰且「重新读取」也救不回来（用户说的卡住）。
  payload.eq.bands[3] = { freq: 1234, gainDb: 4.5, q: 2.2, type: 'peaking' }
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: state(payload) }) } }
  await engineRequest({ cmd: 'get_state' })
  const dsp = useTwilight.getState().dsp
  assert.ok(dsp, 'off-grid frequency must not wipe the model')
  assert.equal(dsp.eq.bands[3].freq, 1234)
  assert.equal(dsp.eq.bands[3].gainDb, 4.5)
})

test('per-band type and Q survive parsing, so the controls can show them', async () => {
  const payload = shaped()
  payload.eq.bands[0] = { freq: 40, gainDb: -3, q: 0.7, type: 'lowShelf' }
  payload.eq.bands[9] = { freq: 12000, gainDb: 2, q: 0.9, type: 'highShelf' }
  globalThis.window = { twilight: { request: async () => ({ ok: true, data: state(payload) }) } }
  await engineRequest({ cmd: 'get_state' })
  const bands = useTwilight.getState().dsp.eq.bands
  assert.equal(bands[0].type, 'lowShelf')
  assert.equal(bands[0].q, 0.7)
  assert.equal(bands[9].type, 'highShelf')
})

test('malformed band values are still refused instead of shown as a curve', async () => {
  for (const broken of [
    { freq: 5, gainDb: 0, q: 1.41, type: 'peaking' },
    { freq: 1000, gainDb: 40, q: 1.41, type: 'peaking' },
    { freq: 1000, gainDb: 0, q: 0.01, type: 'peaking' },
    { freq: 1000, gainDb: 0, q: 1.41, type: 'bogus' }
  ]) {
    const payload = shaped()
    payload.eq.bands[2] = broken
    globalThis.window = { twilight: { request: async () => ({ ok: true, data: state(payload) }) } }
    await engineRequest({ cmd: 'get_state' })
    assert.equal(useTwilight.getState().dsp, null, JSON.stringify(broken) + ' must be refused')
  }
})
