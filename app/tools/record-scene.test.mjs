import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceRecordSpring, recordCameraDistance, recordCanAnimate } from '../src/renderer/src/components/recordScene.ts'

test('record interaction settles to its target without perpetual frames', () => {
  let spring = { value: -0.3, velocity: 0 }
  for (let frame = 0; frame < 240; frame++) spring = advanceRecordSpring(spring, 0.18, 1 / 60)
  assert.equal(spring.value, 0.18)
  assert.equal(spring.velocity, 0)
})

test('spring response is stable across frame rates', () => {
  const sample = (fps) => {
    let spring = { value: 0, velocity: 0 }
    for (let frame = 0; frame < fps / 2; frame++) spring = advanceRecordSpring(spring, 0.2, 1 / fps)
    return spring.value
  }
  assert.ok(Math.abs(sample(30) - sample(120)) < 0.0001)
})

test('record camera preserves the full disc in narrow and wide viewports', () => {
  assert.ok(recordCameraDistance(240, 420) > recordCameraDistance(420, 420))
  assert.equal(recordCameraDistance(480, 420), recordCameraDistance(420, 420))
  assert.ok(Number.isFinite(recordCameraDistance(0, 0)))
})

test('hidden, offscreen and reduced-motion records never continuously animate', () => {
  assert.equal(recordCanAnimate(true, false, false), true)
  assert.equal(recordCanAnimate(false, false, false), false)
  assert.equal(recordCanAnimate(true, true, false), false)
  assert.equal(recordCanAnimate(true, false, true), false)
})
