import type { QrTicket } from '@shared/streaming'

/**
 * 登录状态机与错误话术 —— **纯函数**，不碰 DOM/IPC，便于单测与复用。
 *
 * 为什么单独抽出来：扫码模态、设置页卡片、歌曲中心账号栏三处都要回答
 * 「现在到哪一步了、下一步做什么」。三份 if/else 必然漂移；这里只留一份真相。
 */
export type LoginPhase = 'preparing' | 'waiting' | 'scanned' | 'success' | 'expired' | 'error'

export interface LoginPhaseInput {
  /** 正在做异步动作（拉二维码 / 等 server 就绪） */
  busy: boolean
  /** 服务端回报的扫码会话状态；null = 还没有会话 */
  state: QrTicket['state'] | null
  /** 已经发生并需要展示给用户的错误 */
  error: string | null
}

/** 输入 → 单一 phase（错误优先；busy 且无错误 = 准备中）。 */
export function deriveLoginPhase(input: LoginPhaseInput): LoginPhase {
  if (input.error) return 'error'
  if (input.state === 'confirmed') return 'success'
  if (input.busy) return 'preparing'
  if (input.state === 'scanned') return 'scanned'
  if (input.state === 'expired') return 'expired'
  if (input.state === 'waiting') return 'waiting'
  return 'preparing'
}

export interface LoginPhaseCopy {
  title: string
  hint: string
  /** 主操作：retry=重新获取/重试；none=只能等或关闭 */
  primary: 'retry' | 'none'
}

/** 每个 phase 的「现在怎么样 + 下一步做什么」（规格 §2 表格的代码化）。 */
export function describeLoginPhase(phase: LoginPhase, platformTitle: string): LoginPhaseCopy {
  switch (phase) {
    case 'preparing':
      return { title: '正在准备登录…', hint: `首次拉起 ${platformTitle} 服务端可能要几十秒，请稍候。`, primary: 'none' }
    case 'waiting':
      return { title: '用手机扫码', hint: `用 ${platformTitle} App 扫描二维码；二维码约 3 分钟有效。`, primary: 'retry' }
    case 'scanned':
      return { title: '已扫描', hint: '请在手机上确认登录。', primary: 'none' }
    case 'success':
      return { title: '登录成功', hint: '账号已连接，正在返回…', primary: 'none' }
    case 'expired':
      // 只剩网易云有网页登录；QQ 的二维码过期时要先确认「扫码 App 与通道一致」。
      return { title: '二维码已过期', hint: '点「重新获取」；反复过期时先确认扫码的 App 与上方通道一致。', primary: 'retry' }
    case 'error':
      return { title: '登录未完成', hint: '看下面的原因与下一步；可以重试或改用网页登录。', primary: 'retry' }
  }
}

export type LoginErrorKind = 'device-limit' | 'network' | 'window-closed' | 'timeout' | 'session' | 'cookie' | 'unknown'

export interface LoginErrorInfo {
  kind: LoginErrorKind
  /** 发生了什么（尽量保留上游原文；未知错误不吞消息） */
  reason: string
  /** 下一步做什么 */
  nextStep: string
  /** 是否值得原地重试 */
  retryable: boolean
}

/**
 * IPC 拒绝的消息会带上 Electron 的调用点前缀：
 *   Error invoking remote method 'twilight:streaming-qr-poll': Error: 网易云音乐服务端返回 HTTP 500：…
 * 这是给开发者看的，绝不能进用户可见文案。归一化只去前缀，正文原样保留（未知错误也不吞消息）。
 */
const IPC_PREFIX = /^\s*Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i

/** 去掉 IPC 前缀并 trim；非字符串返回空串。导出以便单测锁定这条边界。 */
export function normalizeLoginMessage(message: string | null | undefined): string {
  if (typeof message !== 'string') return ''
  return message.replace(IPC_PREFIX, '').trim()
}

const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|502|503|504|fetch failed|网络|socket hang up/i
const DEVICE_LIMIT = /20279|设备数已超限|设备数量|too many devices/i
const WINDOW_CLOSED = /登录窗口已关闭|窗口已关闭|window.*closed/i
const TIMEOUT = /超时|timeout|timed out|180\s*秒/i
const SESSION = /没有进行中的扫码会话|已过期|expired|no active qr session/i
const COOKIE = /cookie|不接受这个会话|读取账号失败|session.*reject/i

/**
 * 上游错误 → { 原因, 下一步, 可重试 }。
 * 规则顺序有意义：设备上限与「窗口关闭」是**确定性**事实，不能被泛化的网络正则吞掉。
 */
export function describeLoginError(message: string | null | undefined): LoginErrorInfo {
  const original = normalizeLoginMessage(message)
  const reason = original || '登录没有完成（上游没有给出原因）'
  if (DEVICE_LIMIT.test(original)) {
    return {
      kind: 'device-limit', reason,
      nextStep: '到手机 QQ「设置 → 设备管理」移除旧设备后重试；重启或换网无效。',
      retryable: true
    }
  }
  if (WINDOW_CLOSED.test(original)) {
    return { kind: 'window-closed', reason, nextStep: '已取消网页登录；可以重新扫码，或再次打开网页登录。', retryable: true }
  }
  if (TIMEOUT.test(original)) {
    return { kind: 'timeout', reason, nextStep: '重新打开网页登录，或改用扫码登录。', retryable: true }
  }
  if (NETWORK.test(original)) {
    return { kind: 'network', reason, nextStep: '等 10 秒重试；仍失败就改用网页登录或换一个网络。', retryable: true }
  }
  if (SESSION.test(original)) {
    return { kind: 'session', reason, nextStep: '二维码已过期，点「重新获取」；反复过期就改用网页登录。', retryable: true }
  }
  if (COOKIE.test(original)) {
    return { kind: 'cookie', reason, nextStep: '重试一次；仍失败就改用网页登录。', retryable: true }
  }
  return { kind: 'unknown', reason, nextStep: '重试一次；仍失败就改用网页登录。', retryable: true }
}