import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { smoothMeasuredPath, spectrumCurvePath, freshSpectrum } from '../src/renderer/src/audio/spectrumGlowModel.ts'

const glowSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/audio/SpectrumGlow.tsx', import.meta.url)), 'utf8')

test('continuous spectrum path is cubic, bounded, and empty without valid measurements', () => {
  assert.equal(spectrumCurvePath([], 4), '')
  assert.equal(spectrumCurvePath([-12, NaN], 4), '')
  const path = spectrumCurvePath([-72, -24, -8, -36, -72], 9)
  assert.ok(path.startsWith('M'))
  assert.equal((path.match(/ C/g) ?? []).length, 4)
  assert.ok(!/NaN|Infinity/.test(path))
  const coordinates = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]))
  assert.ok(coordinates.every(Number.isFinite))
  assert.ok(coordinates.some((value, index) => index % 2 === 1 && value < 90))
})

test('curve keeps control points inside the measured sample envelope', () => {
  const path = spectrumCurvePath([-72, -6, -6, -72], 100, 104)
  const coordinates = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]))
  const ys = coordinates.filter((_, index) => index % 2 === 1)
  const samples = [-72, -6, -6, -72].map(db => 104 - (db + 72) / 72 * 104 * 0.84)
  assert.ok(Math.min(...ys) >= Math.min(...samples) - 0.01)
  assert.ok(Math.max(...ys) <= Math.max(...samples) + 0.01)
})

test('48 measured spectrum points remain individually represented by smooth curve segments', () => {
  const points = Array.from({ length: 48 }, (_, index) => ({ x: index * 7, y: 60 - Math.sin(index / 4) * 20 }))
  const path = smoothMeasuredPath(points)
  assert.equal((path.match(/ C/g) ?? []).length, 47)
  assert.ok(path.includes('329.00,'))
})

test('immersive glow renders the full measured spectrum as one curve', () => {
  assert.match(glowSource, /spectrumCurvePath\(meter\.spectrum/)
  assert.doesNotMatch(glowSource, /spectrum-glow-bar|spectrumLevels\(/)
})

test('stale and absent frames never animate after resume or a track change', () => {
  assert.equal(freshSpectrum(0, 50), false)
  assert.equal(freshSpectrum(100, 200), true)
  assert.equal(freshSpectrum(100, 650), false)
  assert.equal(freshSpectrum(200, 100), false)
})
