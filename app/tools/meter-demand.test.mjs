import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribeMeter } from '../src/renderer/src/audio/meterStore.ts'

/**
 * A5 跨层契约的渲染层半边：meter 消费者数量 0 ↔ >0 时，通过
 * window.twilight.setMeterDemand(active) 上报给主进程。
 * 这条用例用 mock bridge 覆盖：true 立即发、false 去抖 400ms、无 preload 不报错。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('meter demand: 0→>0 is immediate, >0→0 is debounced, and a missing preload bridge is harmless', async () => {
  const sent = []
  globalThis.window = { twilight: { setMeterDemand: (active) => sent.push(active) } }

  const offA = subscribeMeter(() => {})
  assert.deepEqual(sent, [true], 'first consumer reports demand immediately')

  const offB = subscribeMeter(() => {})
  assert.deepEqual(sent, [true], 'second consumer does not repeat the report')

  offA()
  assert.deepEqual(sent, [true], 'still one consumer: demand stays on')

  offB()
  assert.deepEqual(sent, [true], 'drop to zero must not be reported before the debounce window')
  await sleep(250)
  assert.deepEqual(sent, [true], 'inside the 400 ms window nothing is sent')
  await sleep(250)
  assert.deepEqual(sent, [true, false], 'after the window the engine is told to stop analyzing')

  // 旧 preload / 单测环境没有 bridge：可选链兜底，不抛异常。
  delete globalThis.window
  const offC = subscribeMeter(() => {})
  offC()
  await sleep(450)
  assert.deepEqual(sent, [true, false], 'no bridge means nothing to send, and nothing throws')
})

test('re-subscribing inside the debounce window cancels the pending drop', async () => {
  const sent = []
  globalThis.window = { twilight: { setMeterDemand: (active) => sent.push(active) } }

  const off = subscribeMeter(() => {})
  assert.deepEqual(sent, [true])
  off()
  await sleep(100)
  // 视图切换的退场/入场间隙：400ms 内重新订阅，不应该先 false 再 true。
  const off2 = subscribeMeter(() => {})
  await sleep(400)
  assert.deepEqual(sent, [true], 'the pending false report was cancelled')
  off2()
  await sleep(450)
  assert.deepEqual(sent, [true, false])
  delete globalThis.window
})
