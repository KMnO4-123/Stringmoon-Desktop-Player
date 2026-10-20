import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEADPHONE_PRESETS, autoEqPresetUrl, fetchHeadphonePreset, parseHeadphoneSpec } from '../src/shared/eq-headphone.ts'

test('built-in headphone presets carry shelves and unusual Q values', () => {
  assert.ok(HEADPHONE_PRESETS.length >= 6)
  const hd600 = HEADPHONE_PRESETS.find(p => p.name === 'Sennheiser HD 600')
  assert.ok(hd600)
  assert.equal(hd600.preampDb, -6.3)
  assert.equal(hd600.filters.length, 10)
  // 这两条正是「固定十段等 Q」表达不了的：架式滤波 + 超过全局 Q 上限的 Q
  assert.equal(hd600.filters[0].type, 'lowShelf')
  assert.ok(hd600.filters.some(f => f.q > 4), 'a Q above the old global cap of 4 must survive')
  assert.ok(hd600.filters.every(f => f.freq >= 10 && f.freq <= 24000 && Math.abs(f.gainDb) <= 12))
})

test('the spec parser ignores malformed rows instead of throwing', () => {
  assert.deepEqual(parseHeadphoneSpec('garbage'), [])
  assert.deepEqual(parseHeadphoneSpec('PK 1000 3 1.41;XX bad'), [{ type: 'peaking', freq: 1000, gainDb: 3, q: 1.41 }])
})

test('the URL follows the AutoEQ repository layout', () => {
  const url = autoEqPresetUrl('oratory1990/over-ear', 'Sennheiser HD 600')
  assert.ok(url.includes('/results/oratory1990/over-ear/'))
  assert.ok(url.includes('Sennheiser%20HD%20600/Sennheiser%20HD%20600%20ParametricEQ.txt'), url)
})

const SAMPLE = ['Preamp: -6.3 dB','Filter 1: ON PK Fc 1000 Hz Gain -2.0 dB Q 1.41'].join('\n')

test('fetching walks the rigs and stops at the first hit', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    if (String(url).includes('oratory1990/in-ear')) return { ok: true, status: 200, text: async () => SAMPLE }
    return { ok: false, status: 404, text: async () => '' }
  }
  const preset = await fetchHeadphonePreset('Sennheiser HD 600', { fetchImpl, timeoutMs: 1000 })
  assert.equal(preset.filters.length, 1)
  assert.equal(preset.rig, 'oratory1990/in-ear')
  assert.ok(seen.length >= 2, 'it tried the earlier rig first')
})

test('a miss explains that the model name has to be exact, not just 网络错误', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' })
  await assert.rejects(fetchHeadphonePreset('某个不存在的耳机', { fetchImpl, timeoutMs: 500 }), /精确名字|没有找到/)
})
