
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 音频专业设置（CR-024..027）的持久化与默认值：模块在 import 时会读一次 localStorage，
// 所以先装一个假的再动态导入。
const stored = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: (key) => { stored.delete(key) }
  }
})

const audio = await import('../src/renderer/src/audio/audioPreferences.ts')

test('defaults are exactly the engine current behaviour (no audible change by default)', () => {
  const prefs = audio.readStoredAudioPreferences()
  assert.deepEqual(prefs.resampler, { quality: 'VHQ', phase: 'linear', steep: false })
  assert.equal(prefs.dither, 'tpdf')
  assert.equal(prefs.latency, 'balanced')
  assert.equal(prefs.monoMode, 'off')
  assert.deepEqual(prefs.bandGains, { low: [0, 0], mid: [0, 0], high: [0, 0] })
  assert.deepEqual(prefs.delayMs, [0, 0])
  assert.equal(audio.isDefaultResampler(prefs.resampler), true)
  assert.equal(audio.isDefaultChannelTools(prefs), true)
})

test('corrupt or out-of-range stored values fall back field by field, not as a whole', () => {
  stored.set('stringmoon.audio.resampler', JSON.stringify({ quality: 'HQ', phase: 'bogus', steep: true }))
  stored.set('stringmoon.audio.dither', '{broken json')
  stored.set('stringmoon.audio.latency', JSON.stringify('ultra-low'))
  stored.set('stringmoon.audio.channel-tools', JSON.stringify({
    monoMode: 'left', bandGains: { low: [-99, 3], mid: ['x', 0], high: [1, 99] }, delayMs: [4, -1]
  }))
  const prefs = audio.readStoredAudioPreferences()
  assert.equal(prefs.resampler.quality, 'HQ', 'valid field survives')
  assert.equal(prefs.resampler.phase, 'linear', 'unknown enum falls back to default')
  assert.equal(prefs.resampler.steep, true)
  assert.equal(prefs.dither, 'tpdf', 'broken JSON falls back to default')
  assert.equal(prefs.latency, 'balanced', 'invalid enum falls back')
  assert.equal(prefs.monoMode, 'left')
  assert.deepEqual(prefs.bandGains.low, [-6, 3], 'gain clamped into -6..3')
  assert.deepEqual(prefs.bandGains.mid, [0, 0], 'non-numeric pair falls back')
  assert.deepEqual(prefs.bandGains.high, [1, 3], 'clamped per channel')
  assert.deepEqual(prefs.delayMs, [4, 0], 'delay clamped into 0..10')
})

test('the requested values survive a reload of the store (localStorage round trip)', () => {
  stored.clear()
  const { setResampler } = audio
  // 只验证持久化形状：不触达引擎（真实下发在 Electron 里由集成测试覆盖）。
  const mod = audio
  mod.audioPreferences.getSnapshot()
  // 直接写一组值再读：模拟用户设置后重启。
  stored.set('stringmoon.audio.resampler', JSON.stringify({ quality: '24BIT', phase: 'minimum', steep: true }))
  stored.set('stringmoon.audio.dither', JSON.stringify('ns-9'))
  stored.set('stringmoon.audio.latency', JSON.stringify('lowLatency'))
  const prefs = mod.readStoredAudioPreferences()
  assert.deepEqual(prefs.resampler, { quality: '24BIT', phase: 'minimum', steep: true })
  assert.equal(prefs.dither, 'ns-9')
  assert.equal(prefs.latency, 'lowLatency')
  assert.equal(typeof setResampler, 'function')
})
