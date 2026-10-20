import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTwilight } from '../src/renderer/src/store.ts'
import { encodePath } from '../src/renderer/src/c2/encodePath.ts'
import {
  applyMeterFrame, bandHz, getMeter, resetMeter, subscribeMeter, subscribeVisibleMeter,
  SPECTRUM_MAX_HZ, SPECTRUM_MIN_HZ
} from '../src/renderer/src/audio/meterStore.ts'

const snapshot = () => useTwilight.getState()
const path = () => encodePath({
  loaded: snapshot().loadedTrackId !== null,
  outputMode: snapshot().outputMode ?? undefined,
  sampleRate: snapshot().sampleRate ?? undefined,
  bitPerfect: snapshot().bitPerfect ?? undefined,
  dspActive: snapshot().dspActive ?? undefined,
  dspModules: snapshot().dspModules ?? undefined
})
const frame = (over = {}) => ({ ev: 'meter', rmsDb: [-18.2, -18.4], peakDb: [-6.1, -5.9], peakHoldDb: [-3.2, -3.3],
  truePeakDb: [-2.8, -2.7], truePeakBasis: 'oversampled', lufsMomentary: -16.4, gainReductionDb: 0,
  spectrum: Array.from({ length: 48 }, (_, i) => -20 - i * 0.5), ...over })

beforeEach(() => { delete globalThis.document; resetMeter() })
afterEach(() => { delete globalThis.document })

test('a meter frame is consumed and the last good frame survives a broken one', () => {
  assert.equal(getMeter().hasData, false, 'nothing is drawn before the first frame')
  assert.equal(applyMeterFrame(frame()), true)
  assert.equal(getMeter().hasData, true)
  assert.equal(getMeter().spectrum.length, 48)
  assert.equal(getMeter().truePeakBasis, 'oversampled')
  // 半帧数据画出来的曲线比没有曲线更容易被当真 → 整帧丢弃、保留上一帧。
  assert.equal(applyMeterFrame({ ev: 'meter', rmsDb: [-1] }), false, 'a frame without spectrum is rejected')
  assert.equal(applyMeterFrame({ ev: 'meter', spectrum: ['loud'] }), false, 'non-numeric bands are rejected')
  assert.equal(applyMeterFrame({ ev: 'meter', spectrum: [] }), false, 'an empty spectrum is rejected')
  assert.equal(applyMeterFrame(null), false)
  assert.equal(getMeter().spectrum.length, 48, 'the previous frame is still the one on screen')
  // mono 源长度为 1：**不复制成两条**（CR-015 口径 6）
  applyMeterFrame(frame({ rmsDb: [-18.2], peakDb: [-6.1], truePeakDb: [-2.8] }))
  assert.equal(getMeter().peakDb.length, 1)
  assert.equal(applyMeterFrame(frame({ truePeakBasis: 'invented' })), true)
  assert.equal(getMeter().truePeakBasis, null, 'an unknown basis is null, not silently trusted')
})

test('monitoring never enters the global store and never changes the C2 path', () => {
  const before = path()
  let wakes = 0
  const off = useTwilight.subscribe(() => wakes++)
  for (let i = 0; i < 30; i++) snapshot().applyEvent(frame())
  off()
  assert.equal(wakes, 0, '30 Hz data must not push the whole tree (the position lesson)')
  assert.deepEqual(path(), before, 'monitoring does not add a DSP segment to the signal path')
  assert.equal(snapshot().dspActive, null, 'monitoring is not a sample-modifying module')
})

test('replacing the track drops the previous curve instead of re-labelling it', () => {
  snapshot().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_a', outputMode: 'shared', sampleRate: 48000, bitDepth: 24, bitPerfect: false })
  snapshot().applyEvent(frame())
  assert.equal(getMeter().hasData, true)
  snapshot().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_b', outputMode: 'shared', sampleRate: 48000, bitDepth: 24, bitPerfect: false })
  assert.equal(getMeter().hasData, false, 'the old track spectrum must not be shown as this track')
})

test('pausing or stopping clears the live sample instead of presenting a stale frame as current', () => {
  snapshot().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_live', outputMode: 'shared', sampleRate: 48000 })
  snapshot().applyEvent(frame())
  assert.equal(getMeter().hasData, true)
  snapshot().applyEvent({ ev: 'state', state: 'paused', trackId: 'tl_live', outputMode: 'shared', sampleRate: 48000 })
  assert.equal(getMeter().hasData, false, 'a paused player has no live meter sample')
  snapshot().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_live', outputMode: 'shared', sampleRate: 48000 })
  snapshot().applyEvent(frame())
  snapshot().applyEvent({ ev: 'state', state: 'stopped', trackId: 'tl_live', outputMode: 'shared', sampleRate: 48000 })
  assert.equal(getMeter().hasData, false, 'a stopped player has no live meter sample')
})

test('confirming a manual track switch cannot retain a late spectrum from the previous track', () => {
  snapshot().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_old', outputMode: 'shared', sampleRate: 48000 })
  snapshot().applyEvent(frame())
  snapshot().beginIntent('tl_new')
  // A meter frame may already be in flight while open is pending.
  snapshot().applyEvent(frame())
  snapshot().confirmIntent('tl_new', 180000)
  snapshot().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_new', outputMode: 'shared', sampleRate: 48000 })
  assert.equal(getMeter().hasData, false, 'a fresh old-track spectrum must not become the new-track glow')
})

test('bands are spaced logarithmically over 20 Hz – 20 kHz, like the EQ axis', () => {
  assert.equal(bandHz(0, 48), SPECTRUM_MIN_HZ)
  assert.equal(bandHz(47, 48), SPECTRUM_MAX_HZ)
  const firstRatio = bandHz(1, 48) / bandHz(0, 48)
  const lastRatio = bandHz(47, 48) / bandHz(46, 48)
  assert.ok(Math.abs(firstRatio - lastRatio) < 1e-9, 'equal ratio per band = log spacing')
})

test('hidden meter subscribers stop listening and resume with the latest frame', () => {
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  let frames = 0
  const off = subscribeVisibleMeter(() => frames++)
  subscribeMeter(() => {})
  applyMeterFrame(frame())
  assert.equal(frames, 1)
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  applyMeterFrame(frame({ lufsMomentary: -12 }))
  assert.equal(frames, 1, 'a hidden panel does no work')
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(frames, 2, 'resuming reads the latest frame once')
  assert.equal(getMeter().lufsMomentary, -12)
  off()
})
