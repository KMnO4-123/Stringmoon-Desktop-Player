import test from 'node:test'
import assert from 'node:assert/strict'
import { useTwilight } from '../src/renderer/src/store.ts'

test('output details use engine fields and are invalidated by disconnect or restart', () => {
  useTwilight.setState({ intent: null })
  const state = { ev: 'state', state: 'playing', trackId: 'sample', outputMode: 'shared', sampleRate: 48000,
    bitDepth: 24, containerBits: 32, validBits: 32, channels: 2, deviceName: 'Test DAC', periodMs: 10, bitPerfect: false, xrunCount: 0 }
  useTwilight.getState().applyEvent(state)
  assert.equal(useTwilight.getState().deviceName, 'Test DAC')
  assert.equal(useTwilight.getState().channels, 2)
  assert.equal(useTwilight.getState().periodMs, 10)
  assert.equal(useTwilight.getState().bitDepth, 24)
  assert.equal(useTwilight.getState().containerBits, 32)
  assert.equal(useTwilight.getState().validBits, 32)
  useTwilight.getState().applyEvent({ ...state, channels: -2, periodMs: NaN })
  assert.equal(useTwilight.getState().channels, null)
  assert.equal(useTwilight.getState().periodMs, null)
  useTwilight.getState().setConnectionError('disconnected')
  assert.equal(useTwilight.getState().deviceName, null)
  assert.equal(useTwilight.getState().sampleRate, null)
  useTwilight.getState().applyEvent(state)
  useTwilight.getState().applyEvent({ ev: 'ready' })
  assert.equal(useTwilight.getState().deviceName, null)
})
