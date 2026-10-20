import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChannelCommandQueue } from '../src/renderer/src/audio/channelCommandQueue.ts'

const turn = () => new Promise(resolve => setTimeout(resolve, 0))

test('channel edits merge by field and stay serialized while a command is in flight', async () => {
  const calls = []
  let releaseFirst
  const queue = createChannelCommandQueue(patch => {
    calls.push(patch)
    return calls.length === 1 ? new Promise(resolve => { releaseFirst = resolve }) : Promise.resolve()
  }, 0)

  queue.enqueue({ midGainDb: 1 })
  await turn()
  assert.deepEqual(calls, [{ midGainDb: 1 }])

  queue.enqueue({ sideGainDb: 2 })
  queue.enqueue({ stereoWidth: 1.25 })
  await turn()
  assert.equal(calls.length, 1)
  releaseFirst()
  await turn()
  await turn()

  assert.deepEqual(calls[1], { sideGainDb: 2, stereoWidth: 1.25 })
  await turn()
  assert.deepEqual(queue.getSnapshot(), { pending: null, saving: false, error: null })
})

test('invalid sound-stage values never enter the command queue', () => {
  const queue = createChannelCommandQueue(async () => {})
  assert.throws(() => queue.enqueue({ midGainDb: 13 }), /声场参数超出范围/)
  assert.throws(() => queue.enqueue({ crossfeedPreset: 3 }), /声场参数超出范围/)
  assert.deepEqual(queue.getSnapshot(), { pending: null, saving: false, error: null })
})
