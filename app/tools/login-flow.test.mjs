
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveLoginPhase, describeLoginError, describeLoginPhase, normalizeLoginMessage } from '../src/renderer/src/streaming/loginFlow.ts'

test('phase derivation: error wins, success is terminal, busy means preparing', () => {
  assert.equal(deriveLoginPhase({ busy: false, state: null, error: null }), 'preparing')
  assert.equal(deriveLoginPhase({ busy: true, state: 'waiting', error: null }), 'preparing')
  assert.equal(deriveLoginPhase({ busy: false, state: 'waiting', error: null }), 'waiting')
  assert.equal(deriveLoginPhase({ busy: false, state: 'scanned', error: null }), 'scanned')
  assert.equal(deriveLoginPhase({ busy: false, state: 'expired', error: null }), 'expired')
  assert.equal(deriveLoginPhase({ busy: false, state: 'confirmed', error: null }), 'success')
  // 已确认后即使 busy 也已经是 success（终态优先于准备中）
  assert.equal(deriveLoginPhase({ busy: true, state: 'confirmed', error: null }), 'success')
  // 任何错误都压过服务端状态：错误必须能被看见，不能继续转圈
  assert.equal(deriveLoginPhase({ busy: false, state: 'waiting', error: 'ECONNRESET' }), 'error')
})

test('every phase answers “next step” and only the actionable ones offer retry', () => {
  const waiting = describeLoginPhase('waiting', '网易云音乐')
  assert.ok(waiting.title.length > 0 && waiting.hint.length > 0)
  assert.equal(waiting.primary, 'retry')
  assert.equal(describeLoginPhase('preparing', '网易云音乐').primary, 'none')
  assert.equal(describeLoginPhase('success', '网易云音乐').primary, 'none')
  // v6.7：QQ 没有网页登录，过期文案改成「先确认扫码 App 与通道一致」；不再承诺网页兜底。
  assert.ok(describeLoginPhase('expired', '网易云音乐').hint.includes('通道'))
  assert.ok(describeLoginPhase('error', '网易云音乐').hint.includes('重试'))
})

test('device limit 20279 points at removing old devices, not at retrying blindly', () => {
  const info = describeLoginError('登录失败：20279 设备数已超限')
  assert.equal(info.kind, 'device-limit')
  assert.equal(info.retryable, true)
  assert.ok(info.nextStep.includes('设备管理'))
  assert.ok(info.nextStep.includes('重启') && info.nextStep.includes('换网'), 'explicitly rules out the useless workarounds')
})

test('network/timeout/window-closed/session/cookie each get a concrete next step', () => {
  const network = describeLoginError('Error: ECONNRESET while fetching qr')
  assert.equal(network.kind, 'network')
  assert.ok(network.nextStep.includes('10 秒'))

  const timeout = describeLoginError('等待登录超时（180 秒）')
  assert.equal(timeout.kind, 'timeout')
  assert.ok(timeout.nextStep.includes('网页登录') || timeout.nextStep.includes('扫码'))

  const closed = describeLoginError('登录窗口已关闭')
  assert.equal(closed.kind, 'window-closed')
  assert.ok(closed.nextStep.includes('重新扫码') || closed.nextStep.includes('再次打开'))

  const session = describeLoginError('没有进行中的扫码会话')
  assert.equal(session.kind, 'session')
  assert.ok(session.nextStep.includes('重新获取'))

  const cookie = describeLoginError('cookie 不被接受：读取账号失败')
  assert.equal(cookie.kind, 'cookie')
  assert.ok(cookie.nextStep.includes('重试') || cookie.nextStep.includes('网页登录'))
})

test('unknown errors keep their original message instead of swallowing it', () => {
  const info = describeLoginError('上游返回了某个没见过的形状: { code: 42 }')
  assert.equal(info.kind, 'unknown')
  assert.ok(info.reason.includes('没见过的形状'), 'original message survives')
  assert.ok(info.nextStep.includes('重试') && info.nextStep.includes('网页登录'))
  // 空/缺失消息也不能变成空白状态
  const empty = describeLoginError(null)
  assert.ok(empty.reason.length > 0)
  assert.equal(empty.kind, 'unknown')
})

test('IPC remote-method prefix never reaches the user-visible reason', () => {
  const raw = "Error invoking remote method 'twilight:streaming-qr-poll': Error: 网易云音乐服务端返回 HTTP 500：服务不可用"
  assert.equal(normalizeLoginMessage(raw), '网易云音乐服务端返回 HTTP 500：服务不可用')
  const info = describeLoginError(raw)
  assert.ok(!/invoking remote method/i.test(info.reason), 'no Electron internals in the reason')
  assert.ok(info.reason.includes('网易云音乐服务端返回 HTTP 500'), 'the actual cause survives')
  // 归一化之后仍能命中既有规则（窗口关闭在 IPC 包装里也要识别）
  const closed = describeLoginError("Error invoking remote method 'twilight:streaming-web-login': Error: 登录窗口已关闭")
  assert.equal(closed.kind, 'window-closed')
  assert.ok(!closed.reason.includes('invoking remote method'))
  // 没有前缀的普通消息保持原文
  assert.equal(normalizeLoginMessage('  ECONNRESET  '), 'ECONNRESET')
  assert.equal(normalizeLoginMessage(null), '')
})
