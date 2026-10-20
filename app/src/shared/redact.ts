/**
 * 日志脱敏（MASTER-B-app §A1，验收 §4.1-10：日志里不含 MUSIC_U / __csrf / 任何 cookie 明文）。
 *
 * 为什么**现在**就要有：日志出口今天已经在跑 —— 引擎的 stderr 是**原样打印**的
 * （`engine-host.ts` 的 `[engine:stderr]`），协议异常也会把引擎原文截断打出来。
 * M3 接平台后，引擎与回环代理会经手 `/media/<token>` 这类带签名或 cookie 的字符串；
 * 一旦被原样打进控制台就收不回来了（CONTRACT §5 / SPEC §9.4）。
 *
 * 两条刻意的取舍：
 *  1. **黑名单式遮蔽，不做“智能识别”**：漏遮一次的代价（凭据泄漏）远大于多遮几个字符。
 *  2. 宁可**过度遮蔽**：因此 `key=` 这种普通参数也会被遮 —— 这是有意接受的代价，
 *     因为日志的用途是排障，不是留档原文。
 */

/** 各家的会话 cookie 名。多接一个渠道就加一个，别指望日志里的人眼去认。 */
const COOKIE_NAMES = [
  'MUSIC_U', 'MUSIC_A', '__csrf', '__remember_me', 'NMTID', 'NMTID2',
  'qm_keyst', 'qqmusic_key', 'skey', 'p_skey', 'psrf_qqunionid', '_qpsvr_localtk', 'uin'
]
const COOKIE_RE = new RegExp('\\b(' + COOKIE_NAMES.join('|') + ')=([^;\\s"\']+)', 'gi')
/** 请求/响应头：整段值遮蔽（Cookie 头常常一次带好几个凭据，逐个认不可靠）。 */
const HEADER_RE = /\b(authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;"']+)/gi
/** URL 查询串里的签名/令牌参数。 */
const SECRET_PARAM_RE = /([?&](?:token|sign|signature|access_token|auth|key|apikey|api_key|mtoken)=)([^&\s"']+)/gi
/**
 * 自由文本里的同名参数（行首/空白/标点边界）。
 *
 * 为什么要第二条：第三方 API 的错误 body 会把 token 放成普通文本
 * （例如 {"detail":"invalid token=SECRET"} 或整行 "token=SECRET&br=320"），
 * 原来的 URL 查询串规则只认 ?/& 前缀，这种会原样进日志。宁可过度遮蔽。
 */
const SECRET_TEXT_PARAM_RE = /(^|[\s;,"'(])((?:token|sign|signature|access_token|auth|key|apikey|api_key|mtoken)=)([^&\s"';,)]+)/gim
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi

export function redactSensitiveText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    .replace(COOKIE_RE, '$1=***')
    .replace(BEARER_RE, '$1***')
    .replace(HEADER_RE, '$1: ***')
    .replace(SECRET_PARAM_RE, '$1***')
    .replace(SECRET_TEXT_PARAM_RE, (_match, prefix: string, key: string) => prefix + key + '***')
}

/** 便捷形式：任意值先转成字符串再脱敏（日志里常常直接塞 Error 对象）。 */
export function redactForLog(value: unknown): string {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value instanceof Error) return redactSensitiveText(value.message)
  try { return redactSensitiveText(String(value)) } catch { return '[unprintable]' }
}
