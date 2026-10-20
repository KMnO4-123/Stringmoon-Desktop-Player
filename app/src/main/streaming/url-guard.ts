/**
 * 第三方源 URL 的安全闸（SSRF 防护）。
 *
 * 威胁模型：GD 音乐台返回的播放/封面 URL 是**上游可控数据**。如果它被篡改成
 * http://127.0.0.1:... 或 http://10.0.0.1/...，而主进程照单全收，就变成用户机器上
 * 的 SSRF —— 内网服务、本机回环端口都会被请求。仅校验 http(s) 完全不够。
 *
 * 规则（每一条都必须成立）：
 *  1. 协议只允许 http(s)；带用户名/密码的 URL 直接拒绝。
 *  2. host 是 IP 字面量时直接分类；是域名时**先解析出全部 A/AAAA**，任何一个
 *     落在 loopback/private/link-local/multicast/reserved 都拒绝（防 DNS 指向内网）。
 *  3. 调用方可以为「必须是上游 CDN」的场景传域名后缀白名单（host 必须精确等于
 *     后缀或以 .后缀 结尾）。白名单是额外收紧，不替代 IP 校验。
 *  4. 只有白名单域名上的明文 http 才允许返回 allowInsecure=true（媒体代理需要）；
 *     非白名单 http 一律拒绝。
 *
 * 残余风险（诚实说明）：DNS 校验与 fetch 自身解析之间存在 TOCTOU 窗口。这里通过
 * 「CDN 域名白名单 + 每一跳重定向复验 + 媒体代理只连白名单」把窗口压到最小；要彻底
 * 消除需要把已解析 IP 直接连（socket-level pinning），本机架构暂不值得引入。
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export type IpKind = 'loopback' | 'private' | 'link-local' | 'multicast' | 'reserved' | 'public' | 'invalid'

function ipv4Kind(ip: string): IpKind {
  const parts = ip.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return 'invalid'
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 100 && b >= 64 && b <= 127) return 'reserved' // CGNAT 100.64/10
  if (a === 0) return 'reserved'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  // 文档/基准测试网段：不是公网可路由地址。
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved'
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'
  if (a === 198 && b === 51 && c === 100) return 'reserved'
  if (a === 203 && b === 0 && c === 113) return 'reserved'
  return 'public'
}

/** 把 IPv6 展开成 8 个 16-bit 组（支持 :: 压缩与尾部内嵌 IPv4）。 */
function ipv6Groups(raw: string): number[] | null {
  let ip = raw.toLowerCase()
  if (!ip.includes(':')) return null
  if (ip.includes('%')) ip = ip.split('%')[0] ?? ''
  // 末尾内嵌 IPv4（::ffff:127.0.0.1）先转成两个组。
  const lastColon = ip.lastIndexOf(':')
  const tail = ip.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null
    const v4 = tail.split('.').map(part => Number(part))
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0)
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)
    ip = ip.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16)
  }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const tailGroups = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  const missing = 8 - head.length - tailGroups.length
  if (halves.length === 2 ? missing < 0 : head.length !== 8) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tailGroups]
  if (groups.length !== 8) return null
  const numbers = groups.map(group => Number.parseInt(group, 16))
  return numbers.some(number => !Number.isInteger(number) || number < 0 || number > 0xffff) ? null : numbers
}

function ipv6Kind(raw: string): IpKind {
  const groups = ipv6Groups(raw)
  if (!groups) return 'invalid'
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 === 0) return 'reserved' // ::
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback' // ::1
  // IPv4-mapped（::ffff:a.b.c.d）按内嵌 IPv4 分类。
  if (zeroPrefix && g5 === 0xffff) {
    const hi = g6 ?? 0
    const lo = g7 ?? 0
    return ipv4Kind([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'))
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'private' // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local' // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return 'multicast' // ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved' // 2001:db8::/32 doc
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved' // 100::/64 discard
  return 'public'
}

/** IPv4/IPv6 字面量分类；不是合法 IP 返回 invalid。 */
export function classifyIp(raw: string): IpKind {
  const version = isIP(raw)
  if (version === 4) return ipv4Kind(raw)
  if (version === 6) return ipv6Kind(raw)
  return 'invalid'
}

export function isBlockedIp(raw: string): boolean {
  const kind = classifyIp(raw)
  return kind !== 'public'
}

/** 分类的中文名（错误信息面向用户，别把 internal enum 直接丢出去）。 */
const KIND_LABEL: Record<Exclude<IpKind, 'public' | 'invalid'>, string> = {
  loopback: '回环',
  private: '私有',
  'link-local': '链路本地',
  multicast: '组播',
  reserved: '保留'
}

const kindLabel = (kind: IpKind): string => (kind === 'public' ? '公网' : kind === 'invalid' ? '非法' : KIND_LABEL[kind])

/** 域名是否落在白名单后缀内（精确相等或以 .suffix 结尾）。 */
export function hostMatchesSuffix(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  for (const suffix of suffixes) {
    const normalized = suffix.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
    if (!normalized) continue
    if (host === normalized || host.endsWith('.' + normalized)) return true
  }
  return false
}

export interface RemoteUrlOptions {
  /** 必须命中的域名后缀白名单；不传表示不要求域名（仅做 IP 校验）。 */
  allowedHostSuffixes?: readonly string[]
  /** 测试注入的 DNS 解析；生产用 node:dns。 */
  lookup?: (hostname: string) => Promise<string[]>
  /**
   * 仅测试/本地 mock 用：允许 loopback（127.0.0.1）地址。
   * 打开它的唯一入口是 main 里「显式设置 TWILIGHT_GD_API_BASE 且为 127.0.0.1」，
   * 生产不会经过这里；私网/链路本地/组播/保留地址仍然一律拒绝。
   */
  allowLoopback?: boolean
}

export interface SafeRemoteUrl {
  url: URL
  /** 只有「白名单域名 + 明文 http」才为 true（媒体代理据此放行）。 */
  allowInsecure: boolean
}

const defaultLookup = async (hostname: string): Promise<string[]> => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map(entry => entry.address)
}

/**
 * 校验一个上游 URL 是否可安全请求。失败抛 UnsafeUrlError（中文单层）。
 * 每一跳重定向都必须重新调用它（见 gdstudio 的 redirect 处理）。
 */
export async function assertSafeRemoteUrl(raw: string, options: RemoteUrlOptions = {}): Promise<SafeRemoteUrl> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('上游给出的地址不是合法 URL。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('上游地址只允许 http(s)。')
  }
  if (url.username || url.password) throw new UnsafeUrlError('上游地址不能携带用户名/密码。')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw new UnsafeUrlError('上游地址缺少主机名。')

  const allowedHost = options.allowedHostSuffixes && options.allowedHostSuffixes.length > 0
    ? hostMatchesSuffix(hostname, options.allowedHostSuffixes)
    : true
  if (!allowedHost) {
    throw new UnsafeUrlError('上游地址不在允许的 CDN 域名白名单内（' + hostname + '）。')
  }
  const literal = isIP(hostname) !== 0
  if (literal) {
    const kind = classifyIp(hostname)
    const loopbackAllowed = options.allowLoopback === true && kind === 'loopback'
    if (kind !== 'public' && !loopbackAllowed) throw new UnsafeUrlError('上游地址指向' + kindLabel(kind) + '地址，已拒绝（SSRF 防护）。')
  } else {
    let addresses: string[]
    try {
      addresses = await (options.lookup ?? defaultLookup)(hostname)
    } catch {
      throw new UnsafeUrlError('无法解析上游地址的主机名（' + hostname + '）。')
    }
    if (addresses.length === 0) throw new UnsafeUrlError('上游地址解析不到任何 IP（' + hostname + '）。')
    for (const address of addresses) {
      const kind = classifyIp(address)
      const loopbackAllowed = options.allowLoopback === true && kind === 'loopback'
      if (kind !== 'public' && !loopbackAllowed) throw new UnsafeUrlError('上游地址解析到' + kindLabel(kind) + '地址，已拒绝（SSRF 防护）。')
    }
  }
  // 明文 http 只允许出现在白名单域名上；否则要求 https。
  // 放在 IP 校验**之后**：127.0.0.1 这类地址必须报「回环」，而不是被一句泛化的明文提示盖过。
  if (url.protocol === 'http:' && !hostMatchesSuffix(hostname, options.allowedHostSuffixes ?? [])) {
    throw new UnsafeUrlError('上游地址是明文 http，且不在允许的 CDN 白名单内。')
  }
  return { url, allowInsecure: url.protocol === 'http:' && hostMatchesSuffix(hostname, options.allowedHostSuffixes ?? []) }
}
