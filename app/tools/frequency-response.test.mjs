import { test } from 'node:test'
import assert from 'node:assert/strict'

const module = await import('../src/renderer/src/audio/frequencyResponse.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
const calculate = (...args) => {
  assert.equal(typeof module.calculateResponse, 'function', 'a response must come from confirmed DSP settings')
  return module.calculateResponse(...args)
}
const dsp = {
  eq: { enabled: false, q: 1.41, preampDb: -4, autoHeadroom: false,
    bands: [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map(freq => ({ freq, gainDb: 0 })) },
  appliedGainDb: -4, passthrough: false, streaming: false
}

test('disabled EQ retains actual applied gain rather than claiming a zero-dB bypass', () => {
  const response = calculate(dsp, 48000, [20, 1000, 20000])
  assert.deepEqual(response.points.map(point => point.db), [-4, -4, -4])
  assert.equal(response.bypass, false)
})

test('logarithmic frequency domain stops at Nyquist for a low-rate device', () => {
  const response = calculate(dsp, 22050)
  assert.equal(response.points[0].hz, 20)
  assert.equal(response.points.at(-1).hz, 11025)
  assert.ok(response.points.every(point => point.hz >= 20 && point.hz <= 11025 && Number.isFinite(point.db)))
})

test('unknown or impossible sample rates never produce a claimed response', () => {
  for (const rate of [0, -48000, NaN, 30]) assert.throws(() => calculate(dsp, rate), /采样率/)
  assert.throws(() => calculate(dsp, 48000, [1000, 25000]), /奈奎斯特/)
  assert.throws(() => calculate(dsp, 48000, [0, 1000]), /奈奎斯特/)
})

test('active filters fail honestly when native offline audio is unavailable', () => {
  const boosted = { ...dsp, eq: { ...dsp.eq, enabled: true,
    bands: dsp.eq.bands.map(band => ({ ...band, gainDb: band.freq === 1000 ? 6 : 0 })) } }
  assert.throws(() => calculate(boosted, 48000), /离线音频/)
})
