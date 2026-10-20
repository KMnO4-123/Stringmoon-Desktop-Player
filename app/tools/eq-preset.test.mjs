import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bandwidthToQ, curveResponseDb, filtersToBands, fitCurveToBands, fitErrorDb,
  parseEqPreset, peakingResponseDb, resampleCurve
} from '../src/shared/eq-preset.ts'
import { EQ_BAND_FREQUENCY } from '../src/shared/eq-bands.ts'

// 真实文件内容（AutoEQ，Sennheiser HD 600 定频版，经 gh-proxy 取回）
const AUTOEQ_FIXED = [
  'Preamp: -7.5 dB',
  'Filter 1: ON PK Fc 31 Hz Gain 6.9 dB Q 1.41',
  'Filter 2: ON PK Fc 62 Hz Gain 3.3 dB Q 1.41',
  'Filter 3: ON PK Fc 125 Hz Gain -1.1 dB Q 1.41',
  'Filter 4: ON PK Fc 250 Hz Gain -1.6 dB Q 1.41',
  'Filter 5: ON PK Fc 500 Hz Gain 0.6 dB Q 1.41',
  'Filter 6: ON PK Fc 1000 Hz Gain -0.8 dB Q 1.41',
  'Filter 7: ON PK Fc 2000 Hz Gain 0.1 dB Q 1.41',
  'Filter 8: ON PK Fc 4000 Hz Gain -1.0 dB Q 1.41',
  'Filter 9: ON PK Fc 8000 Hz Gain 3.9 dB Q 1.41',
  'Filter 10: ON PK Fc 16000 Hz Gain -6.5 dB Q 1.41'
].join('\n')

test('AutoEQ fixed-band presets map 1:1 onto the engine grid', () => {
  const preset = parseEqPreset(AUTOEQ_FIXED, 'HD600')
  assert.equal(preset.format, 'autoeq')
  assert.equal(preset.preampDb, -7.5)
  assert.equal(preset.filters.length, 10)
  // AutoEQ 的定频表用的是取整值（31 Hz），引擎网格是 31.25 Hz。差 0.8%，
  // 而且引擎现在接受任意频率，所以这里比的是「落在同一格网格上」，不是相等。
  preset.filters.forEach((filter, index) => {
    const grid = EQ_BAND_FREQUENCY[index]
    assert.ok(Math.abs(filter.freq - grid) / grid < 0.02, 'band ' + index + ' sits on the grid: ' + filter.freq + ' vs ' + grid)
  })
  assert.equal(preset.filters[0].gainDb, 6.9)
  assert.equal(preset.filters[9].gainDb, -6.5)
  assert.ok(preset.filters.every(f => f.type === 'peaking' && f.q === 1.41))
  assert.equal(preset.warnings.length, 0)
})

test('parametric presets bring their own frequencies, Q and shelves', () => {
  const text = [
    'Preamp: -6.3 dB',
    'Filter 1: ON PK Fc 21 Hz Gain 6.0 dB Q 0.70',
    'Filter 2: ON LS Fc 105 Hz Gain 5.5 dB Q 0.71',
    'Filter 3: ON HS Fc 10000 Hz Gain -4.0 dB Q 0.71',
    'Filter 4: ON PK Fc 1200 Hz Gain -2.1 dB BW Oct 1.0',
    'Filter 5: ON HP Fc 30 Hz',
    'Filter 6: ON PK Fc 3000 Hz Gain -1.0 dB Q 2.0'
  ].join('\n')
  const preset = parseEqPreset(text)
  assert.equal(preset.filters.length, 5, 'HP is not expressible and must be skipped; the other five remain')
  assert.deepEqual(preset.filters.map(f => [f.type, f.freq]), [
    ['peaking', 21], ['lowShelf', 105], ['highShelf', 10000], ['peaking', 1200], ['peaking', 3000]
  ])
  assert.ok(Math.abs(preset.filters[3].q - bandwidthToQ(1)) < 1e-9, 'BW Oct is converted to Q, not ignored')
  assert.ok(preset.warnings.some(w => w.includes('HP')), 'the skipped filter is reported')
})

test('Equalizer APO extras are reported rather than silently dropped', () => {
  const text = [
    'Preamp: -3.0 dB',
    'Include: other.txt',
    'Channel: L',
    'GraphicEQ: 20 3.0; 100 1.5; 1000 0; 10000 -2.0'
  ].join('\n')
  const preset = parseEqPreset(text)
  assert.equal(preset.format, 'curve')
  assert.equal(preset.curve.length, 4)
  assert.ok(preset.warnings.some(w => w.includes('Include')))
  assert.ok(preset.warnings.some(w => w.includes('Channel')))
})

test('plain CSV curves are understood, and out-of-range values are clamped with a warning', () => {
  const preset = parseEqPreset('100,-2.5\n1000, 0\n10000,-30')
  assert.equal(preset.format, 'curve')
  assert.equal(preset.curve.length, 3)
  assert.equal(preset.curve[2].gainDb, -12, 'beyond +/-12 dB is clamped')
})

test('JSON presets round-trip and reject junk', () => {
  const json = JSON.stringify({ name: '我的曲线', preampDb: -2, bands: [{ freq: 100, gainDb: 3.5, q: 0.8, type: 'lowShelf' }] })
  const preset = parseEqPreset(json)
  assert.equal(preset.format, 'json')
  assert.equal(preset.name, '我的曲线')
  assert.equal(preset.filters[0].type, 'lowShelf')
  assert.throws(() => parseEqPreset('这里没有任何均衡器数据'), /没有在这份文件里找到/)
})

test('more than ten filters keeps the ten that matter, in frequency order', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ type: 'peaking', freq: 40 * (i + 1), gainDb: i % 2 ? -1 : 2, q: 1.41 }))
  many.push({ type: 'peaking', freq: 1000, gainDb: 11, q: 1.41 })
  const bands = filtersToBands(many)
  assert.equal(bands.length, 10)
  assert.ok(bands.some(band => band.gainDb === 11), 'the loudest correction survives')
  const freqs = bands.map(b => b.freq)
  assert.deepEqual(freqs, [...freqs].sort((a, b) => a - b), 'returned in frequency order')
})

test('the response model agrees with the engine formula at the centre', () => {
  const filter = { type: 'peaking', freq: 1000, gainDb: 6, q: 1.41 }
  assert.ok(Math.abs(peakingResponseDb(filter, 1000) - 6) < 1e-9, 'a peak passes its own gain at its centre')
  assert.ok(Math.abs(peakingResponseDb(filter, 20)) < 1.0, 'and is flat far away')
})

test('a dense curve is fitted to ten bands, and the error is reported', () => {
  const points = []
  for (let hz = 20; hz <= 20000; hz *= 1.12) {
    const lift = 6 / (1 + Math.pow(hz / 120, 2))
    const dip = -4 / (1 + Math.pow(3000 / hz, 2))
    points.push({ freq: hz, gainDb: lift + dip })
  }
  const filters = fitCurveToBands(points, 10)
  assert.ok(filters.length > 0 && filters.length <= 10)
  const error = fitErrorDb(points, filters)
  assert.ok(error < 1.5, 'the fit reproduces the curve within 1.5 dB on average, got ' + error.toFixed(2))
  assert.ok(curveResponseDb(filters, 100) > 3, 'the bass lift is captured')
})

test('resampling is monotonic in frequency and keeps the endpoints', () => {
  const grid = resampleCurve([{ freq: 20, gainDb: 6 }, { freq: 20000, gainDb: -6 }], 8)
  assert.equal(grid.length, 8)
  assert.equal(grid[0].freq, 20)
  assert.equal(grid[7].freq, 20000)
  for (let i = 1; i < grid.length; i++) assert.ok(grid[i].freq > grid[i - 1].freq)
})

test('REW parametric exports are just APO text, and are understood as-is', () => {
  // REW 的「Equalizer APO / miniDSP」导出与 APO 配置同格式；这条测试是为了防止
  // 以后有人给它加「只认 APO 前缀」的假设，把房间校正的入口堵死。
  const text = [
    'Filter  1: ON PK Fc 42 Hz Gain -6.0 dB Q 1.41',
    'Filter  2: ON PK Fc 118 Hz Gain -8.5 dB Q 2.40',
    'Filter  3: ON PK Fc 2400 Hz Gain -3.0 dB Q 1.20'
  ].join('\n')
  const preset = parseEqPreset(text)
  assert.equal(preset.filters.length, 3)
  assert.equal(preset.filters[1].freq, 118)
  assert.equal(preset.filters[1].gainDb, -8.5)
  assert.equal(preset.warnings.length, 0)
})
