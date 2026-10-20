import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TARGET_CURVES, targetToFilters } from '../src/shared/eq-targets.ts'
import { fitErrorDb } from '../src/shared/eq-preset.ts'

test('the target curves come from AutoEQ and are normalised at 1 kHz', () => {
  assert.ok(TARGET_CURVES.length >= 4)
  for (const target of TARGET_CURVES) {
    assert.ok(target.points.length >= 40, target.name + ' has a real point count')
    const at1k = target.points.reduce((best, point) => Math.abs(point.freq - 1000) < Math.abs(best.freq - 1000) ? point : best)
    assert.ok(Math.abs(at1k.gainDb) < 0.2, target.name + ' is 0 dB at 1 kHz, got ' + at1k.gainDb)
    // 频率单调递增，且覆盖到 20 kHz 附近
    for (let i = 1; i < target.points.length; i++) assert.ok(target.points[i].freq > target.points[i - 1].freq)
    assert.ok(target.points.at(-1).freq > 15000)
  }
})

test('a target curve becomes ten bands, and the residual error is honest', () => {
  const name = 'Harman over-ear 2018'
  const filters = targetToFilters(name, 10)
  assert.ok(filters.length > 0 && filters.length <= 10)
  const target = TARGET_CURVES.find(item => item.name === name)
  const error = fitErrorDb(target.points, filters)
  assert.ok(Number.isFinite(error))
  assert.ok(error < 3.5, 'ten bands cannot nail a full target, but it must stay under 3.5 dB, got ' + error.toFixed(2))
})

test('an unknown curve name yields no filters instead of inventing one', () => {
  assert.deepEqual(targetToFilters('不存在的目标曲线'), [])
})
