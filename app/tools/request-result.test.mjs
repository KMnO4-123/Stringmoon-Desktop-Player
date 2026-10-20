import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureRequest, unwrapRequest } from '../src/shared/request-result.ts'

test('error category survives a data serialization round trip', async () => {
  const failure = Object.assign(new Error('hardware unavailable'), { code: 'ERR_UNSUPPORTED', kind: 'hardware' })
  const wire = JSON.parse(JSON.stringify(await captureRequest(async () => { throw failure })))
  assert.throws(() => unwrapRequest(wire), e => e.code === 'ERR_UNSUPPORTED' && e.kind === 'hardware' && e.message === 'hardware unavailable')
})

test('successful data is not confused with the IPC envelope', async () => {
  const data = { ok: false, error: 'ordinary engine data', dsp: { passthrough: true } }
  assert.deepEqual(unwrapRequest(await captureRequest(async () => data)), data)
})

test('transport failure without engine fields keeps its original message', async () => {
  const wire = await captureRequest(() => { throw new Error('engine not running') })
  assert.throws(() => unwrapRequest(wire), e => e.message === 'engine not running' && e.code === undefined && e.kind === undefined)
})
