/**
 * 会话保活的纯函数层（v6）。
 *
 * 为什么单独一层：manager.ts 里每加一条分支都要和「风控节流 / 熔断 / 服务端进程生命周期」纠缠，
 * 而保活真正容易出错的地方是**判断**（哪些响应算续期成功、哪些错误算会话过期、什么时候该跳过），
 * 这些判断必须能脱离网络与 Electron 单测。所以把「怎么判」放这里，「怎么发请求」留在 manager。
 *
 * 一条纪律：**error ≠ expired**。网络抖一下不是掉登录；服务端明确不认才是。
 * 这两者显示给用户的动作完全不同（前者「重试」，后者「重新登录」）。
 */

/** 自动巡检间隔：6 小时。低频到不会给平台增加可观察的请求量，又能在典型 cookie 生命周期内跑几次。 */
export const KEEP_ALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后首次巡检的延迟：让启动 I/O（扫描曲库/起服务端）先跑完，别和它们抢。 */
export const KEEP_ALIVE_FIRST_DELAY_MS = 8000

export type KeepAliveProbeKind = 'ok' | 'expired' | 'error'

/**
 * 从 /login/refresh 的响应里取新 cookie。
 *
 * 不同版本的服务端把 cookie 放在不同深度（body.cookie / cookie / data.cookie），
 * 形状也对不上时**必须返回 null 而不是猜**：返回空串会让调用方把一份空 cookie 写进 secrets，
 * 那等于把用户登出。
 */
export function parseRefreshCookie(json: unknown, depth = 0): string | null {
  if (depth > 4 || json === null || typeof json !== 'object') return null
  const record = json as Record<string, unknown>
  // 先看本层的 cookie 字段；要求含 '='，否则那不是一份 cookie（可能是 boolean/提示文本）。
  const direct = record.cookie
  if (typeof direct === 'string' && direct.includes('=') && direct.length <= 8192) return direct
  for (const key of ['body', 'data', 'result']) {
    const nested = parseRefreshCookie(record[key], depth + 1)
    if (nested) return nested
  }
  return null
}

/**
 * 合并 cookie：新值覆盖同名项，旧的其它项保留。
 *
 * 为什么不是「直接用新的」：续期接口通常只回 MUSIC_U/__csrf 这类关键项，
 * 把 __remember_me 之类丢掉会让下一次请求被判成另一个会话。
 */
export function mergeCookie(previous: string, next: string): string {
  const pairs = new Map<string, string>()
  const push = (raw: string): void => {
    for (const part of raw.split(';')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const index = trimmed.indexOf('=')
      const name = (index < 0 ? trimmed : trimmed.slice(0, index)).trim()
      const value = index < 0 ? '' : trimmed.slice(index + 1)
      if (name) pairs.set(name, value)
    }
  }
  push(previous)
  push(next)
  return [...pairs.entries()].map(([name, value]) => name + '=' + value).join('; ')
}

const LOGIN_FAILURE_RE = /过期|失效|未登录|重新登录|登录状态|请先登录|not\s*login|login\s*(required|expired)|ERR_LOGIN|状态码\s*301/i

/**
 * 把一次探测失败的异常分类成 expired / error。
 *
 * 判据只看消息文本：manager 抛出的错误已经是中文人话（含「会话已过期」「服务端不认」这类词），
 * 而网络层的 ECONNREFUSED / timeout 不会被这些词命中 —— 这正是我们要的分界。
 */
export function classifyProbeError(error: unknown): KeepAliveProbeKind {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return LOGIN_FAILURE_RE.test(message) ? 'expired' : 'error'
}

/** 该不该在这次巡检里探测这个平台。 */
export function shouldProbe(input: {
  signedIn: boolean
  runtimeState: string | null
  inFlight: number
}): boolean {
  // 没登录：没有会话可校验（探了也只会得到「未登录」）。
  if (!input.signedIn) return false
  // 服务端没在跑：为了校验把它拉起来是「后台偷启动进程」，不做。
  if (input.runtimeState !== 'ready') return false
  // 有用户请求在途：不和用户抢风控额度。
  if (input.inFlight > 0) return false
  return true
}

/** 给人看的一句话（成功时为空）。 */
export function keepAliveNoteFor(kind: KeepAliveProbeKind, platformName: string): string | null {
  if (kind === 'ok') return null
  if (kind === 'expired') return '会话已过期，需要重新登录'
  return platformName + '：这次校验没成功（网络或服务端问题），会话状态未变。'
}
