import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_UNDO, describeSnapshot, popUndo, pushUndo, sameSnapshot, snapshotOf, snapshotToBands
} from '../src/renderer/src/audio/eqSnapshots.ts'
import { EQ_BAND_FREQUENCY } from '../src/shared/eq-bands.ts'

const bands = EQ_BAND_FREQUENCY.map((freq, index) => ({ freq, gainDb: index === 0 ? 3 : 0, q: 1.41, type: 'peaking' }))

test('a snapshot always has ten bands, filling defaults for whatever the engine did not report', () => {
  const snapshot = snapshotOf(bands.slice(0, 3), -2, 'test')
  assert.equal(snapshot.bands.length, 10)
  assert.equal(snapshot.preampDb, -2)
  assert.equal(snapshot.bands[0].gainDb, 3)
  assert.equal(snapshot.bands[9].gainDb, 0, 'missing bands default to flat, not to undefined')
  assert.equal(snapshot.bands[9].freq, 16000)
})

test('pushing the same snapshot twice does not stack up undo steps', () => {
  let stack = []
  const a = snapshotOf(bands, 0, 'A')
  stack = pushUndo(stack, a)
  stack = pushUndo(stack, snapshotOf(bands, 0, 'A again'))
  assert.equal(stack.length, 1, 'identical states are one undo step')

  const b = snapshotOf(bands.map((band, i) => ({ ...band, gainDb: i === 0 ? -6 : 0 })), 0, 'B')
  stack = pushUndo(stack, b)
  assert.equal(stack.length, 2)
  assert.equal(sameSnapshot(stack[0], stack[1]), false)
})

test('undo pops the most recent state and hands it back', () => {
  let stack = []
  stack = pushUndo(stack, snapshotOf(bands, 0, 'one'))
  stack = pushUndo(stack, snapshotOf(bands, -1, 'two'))
  const popped = popUndo(stack)
  assert.equal(popped.snapshot.preampDb, -1)
  assert.equal(popped.rest.length, 1)
  const empty = popUndo([])
  assert.equal(empty.snapshot, null)
  assert.deepEqual(empty.rest, [])
})

test('the stack is bounded so a long session cannot grow without limit', () => {
  let stack = []
  for (let i = 0; i < MAX_UNDO + 10; i++) {
    stack = pushUndo(stack, snapshotOf(bands.map(band => ({ ...band, gainDb: i })), i, 's' + i))
  }
  assert.equal(stack.length, MAX_UNDO)
  assert.equal(stack[stack.length - 1].preampDb, MAX_UNDO + 9, 'the newest state survives the trim')
})

test('a snapshot becomes a full ten-band patch, so applying it cannot blend with the previous preset', () => {
  const patch = snapshotToBands(snapshotOf(bands, 0, 'x'))
  assert.equal(patch.length, 10)
  assert.equal(patch[0].freq, 31.25)
  assert.equal(patch[9].freq, 16000)
})

test('the human-readable line names the state and its tonal extremes', () => {
  const line = describeSnapshot(snapshotOf(bands, 0, '平直'))
  assert.ok(line.includes('平直'))
  assert.ok(line.includes('低频'))
})
