import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const module = await import('../src/renderer/src/audio/eqCommandQueue.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
const queueFor = (send) => {
  assert.equal(typeof module.createEqCommandQueue, 'function', 'EQ edits need a coalescing serial command queue')
  return module.createEqCommandQueue(send, 0)
}

test('rapid edits merge by field and never send concurrently', async () => {
  const first = Promise.withResolvers()
  const sent = []
  const queue = queueFor(async patch => { sent.push(patch); if (sent.length === 1) await first.promise })
  queue.enqueue({ enabled: true })
  queue.enqueue({ bandGains: [3] })
  queue.enqueue({ bandGains: [6] })
  await delay(15)
  assert.deepEqual(sent, [{ enabled: true, bandGains: [6] }])
  queue.enqueue({ q: 2 })
  queue.enqueue({ q: 3, bandGains: [9] })
  await delay(15)
  assert.equal(sent.length, 1)
  assert.equal(queue.getSnapshot().pending.q, 3)
  first.resolve()
  await delay(15)
  assert.deepEqual(sent[1], { q: 3, bandGains: [9] })
  assert.equal(queue.getSnapshot().pending, null)
  assert.equal(queue.getSnapshot().saving, false)
})

test('failed edit removes draft and exposes an actionable error', async () => {
  const queue = queueFor(async () => { throw new Error('设备已断开') })
  queue.enqueue({ enabled: true })
  await delay(15)
  assert.equal(queue.getSnapshot().pending, null)
  assert.equal(queue.getSnapshot().saving, false)
  assert.match(queue.getSnapshot().error, /设备已断开/)
})

test('reset discards queued edits and ignores completion from the previous engine', async () => {
  const old = Promise.withResolvers()
  const sent = []
  const queue = queueFor(async patch => { sent.push(patch); await old.promise })
  queue.enqueue({ enabled: true })
  await delay(15)
  queue.enqueue({ q: 4 })
  queue.reset()
  old.reject(new Error('old engine'))
  await delay(15)
  assert.equal(sent.length, 1)
  assert.equal(queue.getSnapshot().pending, null)
  assert.equal(queue.getSnapshot().error, null)
})

test('invalid band and Q values never reach the engine', () => {
  const queue = queueFor(async () => { assert.fail('must not send malformed settings') })
  for (const patch of [{}, { q: 4.1 }, { bandGains: [13] }, { bandGains: [NaN] }, { preampDb: Infinity }]) {
    assert.throws(() => queue.enqueue(patch), /EQ/)
  }
  assert.equal(queue.getSnapshot().pending, null)
})
