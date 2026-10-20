import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { randomSecret, rsaEncrypt, weapiForm } from '../src/main/netease-weapi.ts'

const IV = Buffer.from('0102030405060708')
const NONCE = '0CoJUm6Qyw8W8jud'
function aesDecryptBase64(value, key) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), IV)
  return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8')
}

test('the two AES layers decrypt back to the payload the server expects', () => {
  // 服务端要的是「两层 AES」：内层用固定 nonce，外层用本次的随机 secret。
  // 这里反向解一遍，等于用同一套算法证明参数是可还原的（而不是看起来像 base64 就行）。
  const payload = { id: 32507038, lv: -1, tv: -1, rv: -1, yv: -1, ytv: -1, yrv: -1, cp: false }
  const secret = 'abcdefghijklmnop'
  const body = weapiForm(payload, secret)
  const params = new URLSearchParams(body).get('params')
  assert.ok(params, 'params is present')
  const inner = aesDecryptBase64(params, secret)
  const json = aesDecryptBase64(inner, NONCE)
  assert.deepEqual(JSON.parse(json), payload)
})

test('encSecKey is a 256-hex textbook RSA of the reversed secret', () => {
  const secret = '0123456789abcdef'
  const key = rsaEncrypt(secret)
  assert.equal(key.length, 256, 'the server expects exactly 256 hex characters')
  assert.match(key, /^[0-9a-f]{256}$/)
  assert.equal(rsaEncrypt(secret), key, 'deterministic for the same secret')
  assert.notEqual(rsaEncrypt('fedcba9876543210'), key, 'a different secret gives a different key')
})

test('a random secret is full-width hex and actually random', () => {
  const secrets = new Set()
  for (let i = 0; i < 50; i++) {
    const secret = randomSecret()
    assert.match(secret, /^[0-9a-f]{16}$/)
    secrets.add(secret)
  }
  assert.ok(secrets.size > 45, 'secrets must not repeat in practice')
})

test('the form body carries both fields and nothing else', () => {
  const body = weapiForm({ id: 1 }, 'abcdefghijklmnop')
  const parsed = new URLSearchParams(body)
  assert.deepEqual([...parsed.keys()].sort(), ['encSecKey', 'params'])
})
