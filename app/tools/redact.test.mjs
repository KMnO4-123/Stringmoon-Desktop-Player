import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactForLog, redactSensitiveText } from '../src/shared/redact.ts'

/**
 * MASTER-B-app §A1 / 验收 §4.1-10：日志里不含 MUSIC_U / __csrf / 任何 cookie 明文。
 *
 * 断言方式刻意选「**原文里的秘密子串不得出现在输出里**」而不是比对固定的遮蔽结果 ——
 * 前者不管遮蔽成 *** 还是 [redacted] 都成立，测的是「有没有泄漏」这个真问题。
 */
test('cookies, headers and signed URLs never survive into a log line', () => {
  const secrets = ['9f3a-MUSIC-U-token', 'csrf-value-xyz', 'eyJhbGciOiJIUzI1NiJ9.payload.sig', 'sk-live-abc123', 'signature-value-42', 'qm-key-777']
  const line = 'GET /media/abc?token=' + secrets[0] + '&sign=' + secrets[4]
    + ' Cookie: MUSIC_U=' + secrets[0] + '; __csrf=' + secrets[1]
    + ' Authorization: Bearer ' + secrets[2]
    + ' X-Api-Key: ' + secrets[3]
    + ' qm_keyst=' + secrets[5]
  const out = redactSensitiveText(line)
  for (const secret of secrets) assert.ok(!out.includes(secret), '凭据泄漏进日志: ' + secret)
  // 排障要用的部分必须留下：路径、头名、方法
  assert.ok(out.includes('GET /media/abc'), '请求路径要留下')
  assert.ok(out.includes('Authorization'), '头名要留下（只是值没了）')
  assert.ok(out.includes('__csrf'), 'cookie 名要留下，否则排障时分不清是哪个凭据')
})

test('ordinary log lines pass through untouched', () => {
  // 反向对照：不过度遮蔽到把日志变得没用。这一行里没有凭据，必须**逐字节相同**。
  const line = '[engine] scan done: added=91 failed=0 | device: 耳机 (NICEHCK HiFi Audio) | decode D:/Music/Album/track-01.flac'
  assert.equal(redactSensitiveText(line), line, '没有凭据的行必须原样通过')
  assert.equal(redactSensitiveText(''), '')
})

test('redactForLog handles the shapes logs actually receive', () => {
  assert.ok(!redactForLog(new Error('proxy failed: Cookie: MUSIC_U=leak-me')).includes('leak-me'))
  assert.ok(!redactForLog({ toString: () => 'https://cdn/x?access_token=tok-9' }).includes('tok-9'))
  assert.equal(redactForLog(undefined), 'undefined')
})

test('free-text token params are masked too (third-party error bodies, not just URLs)', () => {
  const samples = [
    'upstream detail: token=SECRET-A-123 br=320',
    '{"detail":"invalid token=SECRET-B-456"}',
    'token=SECRET-C-789&br=320',
    'proxy failed (key=SECRET-D-000)',
    'line one\nsecond line signature=SECRET-E-999'
  ]
  for (const sample of samples) {
    const out = redactSensitiveText(sample)
    assert.ok(!out.includes('SECRET-'), '凭据泄漏进日志: ' + out)
  }
  // 不误伤普通单词：monkey= 的 key= 前面不是边界字符。
  assert.equal(redactSensitiveText('monkey=banana'), 'monkey=banana')
})
