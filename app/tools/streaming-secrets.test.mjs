// Electron 44 的 safeStorage 异步解密形状兼容（verifier 发现的真实回归）。
//
// decryptStringAsync 从 Electron 44 起返回 { result, shouldReEncrypt }，
// 旧代码按 string 判断 → 凭据写进去了却永远读不回来（每次启动都要重新登录）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { plainSecretOf } from '../src/main/streaming/secrets.ts'

test('Electron 44 shape is unwrapped, including the re-encrypt hint', () => {
  assert.deepEqual(plainSecretOf({ result: 'MUSIC_U=abc; __csrf=def', shouldReEncrypt: false }),
    { secret: 'MUSIC_U=abc; __csrf=def', reEncrypt: false })
  assert.deepEqual(plainSecretOf({ result: 'cookie=1', shouldReEncrypt: true }),
    { secret: 'cookie=1', reEncrypt: true })
})

test('the legacy string shape still works (old Electron / test stubs)', () => {
  assert.deepEqual(plainSecretOf('MUSIC_U=legacy'), { secret: 'MUSIC_U=legacy', reEncrypt: false })
})

test('unknown shapes are reported as no secret instead of crashing the login path', () => {
  for (const value of [null, undefined, 42, {}, { result: 123 }, { result: null, shouldReEncrypt: true }]) {
    assert.deepEqual(plainSecretOf(value), { secret: null, reEncrypt: false }, JSON.stringify(value))
  }
})
