/**
 * GD 音乐台（music-api.gdstudio.xyz）—— 纯 HTTP 第三方源，不 spawn 任何进程。
 *
 * 为什么单独一个模块：它和「用户自备服务端」的三家（netease/qq/meting）不是同一类东西。
 * 没有登录、没有端口、没有进程生命周期；风险完全在**上游随时改协议/限流**。所以这里
 * 只做四件事：URL 构造、形状归一化、换源、缓存/限流。业务接线在 manager.ts。
 *
 * 实测形状（2026-10-18，Lead/本机）：
 *   search  -> [{ id, name, artist: string[], album, pic_id, url_id, lyric_id, source, from }]
 *   url     -> { url, br, size, from }（不给 br = 最高；实测 flac br=918；br=320 -> mp3）
 *   lyric   -> { lyric, tlyric, from }
 *   pic     -> { url, from }（注意是 JSON 里的图片 URL，不是 302）
 *   playlist-> 网易云原始 { code, playlist: { tracks: [...] } }
 *   embeat_by_track -> 需要 name 参数；无鉴权时可能 4xx/5xx 或回空数组（必须降级）
 *
 * 安全/日志纪律：**任何 URL 的 query 都不进日志**。错误信息只说 type/source/status/detail，
 * 并统一过 redactSensitiveText —— 上游将来把 token 放进 query 时也不会泄漏。
 */
import { redactSensitiveText } from '@shared/redact'
import type { GdSourceStatus, StreamingSimilarResult, StreamingTrack } from '@shared/streaming'
import { assertSafeRemoteUrl, type SafeRemoteUrl } from './url-guard'

export const GD_API_BASE = 'https://music-api.gdstudio.xyz/api.php'
/**
 * GD 播放/封面直链的 CDN 域名白名单（上游返回的 URL 必须落在这里）。
 * 配置可扩展：TWILIGHT_GD_ALLOWED_HOSTS=a.com,b.com（逗号分隔）。
 */
export const GD_ALLOWED_HOST_SUFFIXES = [
  'music.126.net', '126.net', 'music.163.com',
  'joox.com', 'qq.com', 'gtimg.cn', 'gdstudio.xyz'
] as const
/** 搜索/取链可用源（按优先级）。embeat 不是音乐源，只做相似推荐。 */
export const GD_SOURCES = ['netease', 'joox'] as const
export type GdSource = (typeof GD_SOURCES)[number]

/** 10 分钟缓存（规格 §1.3）。 */
export const GD_CACHE_TTL_MS = 10 * 60_000
export const GD_TIMEOUT_MS = 12_000
/** 全程并发上限（规格：≤2）。 */
export const GD_CONCURRENCY = 2
const GD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export type GdFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * 显式设置 TWILIGHT_GD_API_BASE / 构造参数时的测试基址识别。
 * 只有 http://127.0.0.1:<port> 形式会打开 loopback 例外（mock GD 服务用）；
 * 生产默认基址不匹配，行为不变。
 */
const TEST_LOCAL_BASE_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/|$)/

export function resolveGdBaseUrl(explicit?: string): { baseUrl: string; localTest: boolean } {
  const raw = (explicit ?? process.env.TWILIGHT_GD_API_BASE ?? '').trim()
  if (!raw) return { baseUrl: GD_API_BASE, localTest: false }
  return { baseUrl: raw, localTest: TEST_LOCAL_BASE_RE.test(raw) }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

/** 单行中文错误（错误信息里不允许换行/堆栈）。 */
export class GdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GdError'
  }
}

/** URL 安全校验失败（SSRF/白名单）：确定性结果，绝不重试。 */
export class GdSecurityError extends GdError {
  constructor(message: string) {
    super(message)
    this.name = 'GdSecurityError'
  }
}

export function describeGdError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'GD 音乐台请求超时。'
    const message = error.message.trim().split(/\r?\n/)[0] ?? ''
    if (!message) return 'GD 音乐台请求失败。'
    if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) {
      return 'GD 音乐台网络不可用：无法连接 music-api.gdstudio.xyz。'
    }
    return message
  }
  return 'GD 音乐台请求失败。'
}

// ---- 形状归一化（纯函数，单测直接打这里） ---------------------------------

/** GD 的 track id 需要带三个子 id 才能取链/歌词/封面，所以打包成一个不透明 id。 */
export interface GdTrackIds {
  source: string
  urlId: string
  lyricId: string
  picId: string
}

export function encodeGdId(ids: GdTrackIds): string {
  return 'gd:' + [ids.source, ids.urlId, ids.lyricId, ids.picId].map(part => encodeURIComponent(part)).join('|')
}

export function decodeGdId(id: string): GdTrackIds | null {
  if (typeof id !== 'string' || !id.startsWith('gd:')) return null
  const parts = id.slice(3).split('|')
  if (parts.length !== 4) return null
  try {
    const [source, urlId, lyricId, picId] = parts.map(part => decodeURIComponent(part))
    if (!source || !urlId) return null
    return { source, urlId, lyricId: lyricId ?? '', picId: picId ?? '' }
  } catch {
    return null
  }
}

const joinArtists = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(item => (item && typeof item === 'object' ? str((item as Record<string, unknown>).name) : str(item)))
      .filter(Boolean).join(' / ')
  }
  return str(value)
}

/**
 * search 响应 → StreamingTrack[]。
 * artist 是 string[]（这是 GD 与网易云原始响应最大的形态差异），空名字行直接丢弃。
 */
export function mapSearchRows(json: unknown, fallbackSource: string): StreamingTrack[] {
  if (!Array.isArray(json)) throw new GdError('GD 音乐台搜索返回的不是列表（上游协议可能变了）。')
  return json.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const source = str(row.source) || fallbackSource
    const urlId = str(row.url_id) || str(row.id)
    return {
      platform: 'gdstudio' as const,
      id: encodeGdId({ source, urlId, lyricId: str(row.lyric_id) || urlId, picId: str(row.pic_id) }),
      title: str(row.name),
      artist: joinArtists(row.artist),
      album: str(row.album),
      durationMs: 0,
      cover: null
    }
  }).filter(track => track.id && track.title)
}

/** url 响应 → 直链与实测码率。空 url 是业务结果（版权/地区），必须说清楚。 */
export function mapPlayUrl(json: unknown, source: string): { url: string; br: number | null; size: number | null } {
  const record = (json ?? {}) as Record<string, unknown>
  const url = str(record.url)
  const brRaw = record.br
  const br = typeof brRaw === 'number' && Number.isFinite(brRaw) ? brRaw : null
  const sizeRaw = record.size
  const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? sizeRaw : null
  if (!url) {
    const detail = br !== null ? '（br=' + br + '）' : ''
    throw new GdError('GD 音乐台没有给出播放地址（来源 ' + source + '）' + detail + '：可能是版权/地区限制。')
  }
  if (!/^https?:\/\//i.test(url)) throw new GdError('GD 音乐台给出了无法识别的播放地址。')
  return { url, br, size }
}

/** 码率 → 界面音质标签（918 实测是 flac；320 是 mp3）。 */
export function qualityFromBr(br: number | null): string | null {
  if (br === null || !Number.isFinite(br) || br <= 0) return null
  if (br >= 800) return 'FLAC'
  return String(Math.round(br)) + ' kbps'
}

export function mapLyric(json: unknown): { lrc: string; translation: string } {
  const record = (json ?? {}) as Record<string, unknown>
  return { lrc: str(record.lyric), translation: str(record.tlyric) }
}

export function mapPicUrl(json: unknown): string | null {
  const record = (json ?? {}) as Record<string, unknown>
  const url = str(record.url)
  return /^https?:\/\//i.test(url) ? url : null
}

/** 以 magic bytes 判定图片真实格式；认不出就当作不可信（防止把 HTML/脚本当图片）。 */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  const ascii = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString('latin1')
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

/** 网易云原始 playlist 的 tracks → GD 曲目（id 用 music 的 netease song id；取链时会再换源）。 */
export function mapPlaylistTracks(json: unknown): StreamingTrack[] {
  const playlist = (json as { playlist?: Record<string, unknown> })?.playlist
  const list = Array.isArray(playlist?.tracks) ? playlist?.tracks as unknown[] : null
  if (!list) throw new GdError('GD 音乐台歌单响应里没有 playlist.tracks（上游协议可能变了）。')
  return list.map((raw) => {
    const song = (raw ?? {}) as Record<string, unknown>
    const album = (song.al ?? song.album) as Record<string, unknown> | undefined
    const cover = str(album?.picUrl) || null
    return {
      platform: 'gdstudio' as const,
      // 歌单里没有 GD 的 url_id：先用网易云 song id 占位，resolvePlay 会按 title/artist 换源。
      id: encodeGdId({ source: 'netease', urlId: str(song.id), lyricId: str(song.id), picId: str(song.id) }),
      title: str(song.name),
      artist: joinArtists(song.ar ?? song.artists),
      album: str(album?.name),
      durationMs: typeof song.dt === 'number' ? song.dt : 0,
      cover: cover && cover.startsWith('http') ? cover.replace(/^http:\/\//i, 'https://') : null
    }
  }).filter(track => track.title)
}

// ---- 客户端 ---------------------------------------------------------------

interface CacheEntry { expiresAt: number; value: unknown }
type CacheKind = 'search' | 'url' | 'lyric' | 'pic' | 'playlist' | 'embeat'

export interface GdStudioOptions {
  baseUrl?: string
  fetchImpl?: GdFetch
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
  concurrency?: number
  retryDelayMs?: number
  log?: (message: string) => void
  /** 播放/封面直链必须命中的 CDN 域名后缀（默认 GD_ALLOWED_HOST_SUFFIXES / env）。 */
  allowedHostSuffixes?: readonly string[]
  /** 测试注入 DNS 解析（SSRF 校验用）；生产用 node:dns。 */
  lookup?: (hostname: string) => Promise<string[]>
  /** JSON / 图片响应大小上限（默认 2 MB / 8 MB）。 */
  jsonMaxBytes?: number
  imageMaxBytes?: number
  /** 429 后该源冷却时长（默认 60s）。 */
  rateLimitCooldownMs?: number
  /** 播放地址缓存 TTL（默认 60s：直链带签名，10 分钟必然过期）。 */
  urlCacheTtlMs?: number
}

export interface GdPlayTarget {
  url: string
  br: number | null
  size: number | null
  /** 实际取到链的源（换源后可能与搜索源不同）。 */
  source: string
  quality: string | null
  title: string
  artist: string
  /** 只有白名单 CDN 的明文 http 才允许媒体代理放行（不再给 GD 无条件 allowInsecure）。 */
  allowInsecure: boolean
}

/** 简单的并发闸：全程最多 N 个 GET 在飞（规格 ≤2）。 */
class Limiter {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(resolve => this.queue.push(resolve))
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * GD 音乐台客户端。所有对外方法都只返回归一化结果或抛中文单层错误；
 * fetch/now/时间全部可注入，单测不联网。
 */
export class GdStudioClient {
  private readonly baseUrl: string
  private readonly fetchImpl: GdFetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly retryDelayMs: number
  private readonly limiter: Limiter
  private readonly log: (message: string) => void
  private readonly allowedHostSuffixes: readonly string[]
  private readonly lookup: ((hostname: string) => Promise<string[]>) | undefined
  private readonly jsonMaxBytes: number
  private readonly imageMaxBytes: number
  private readonly rateLimitCooldownMs: number
  private readonly urlCacheTtlMs: number
  private readonly cooling = new Map<string, number>()
  /** mock GD 测试基址（显式 127.0.0.1 覆写）：只对本进程打开 loopback 例外。 */
  private readonly localTestBase: boolean
  private readonly localTestOrigin: string
  private readonly caches: Record<CacheKind, Map<string, CacheEntry>> = {
    search: new Map(), url: new Map(), lyric: new Map(), pic: new Map(), playlist: new Map(), embeat: new Map()
  }
  private probeCache: { expiresAt: number; statuses: GdSourceStatus[] } | null = null

  constructor(options: GdStudioOptions = {}) {
    const resolved = resolveGdBaseUrl(options.baseUrl)
    // 生产路径（无覆写）永远走官方 https 基址；只有测试/e2e 才可能走到本地 mock。
    this.baseUrl = resolved.baseUrl
    this.localTestBase = resolved.localTest
    this.localTestOrigin = (() => {
      try { return new URL(resolved.baseUrl).origin } catch { return '' }
    })()
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? GD_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? GD_CACHE_TTL_MS
    this.retryDelayMs = options.retryDelayMs ?? 250
    this.limiter = new Limiter(Math.max(1, Math.min(2, options.concurrency ?? GD_CONCURRENCY)))
    this.log = options.log ?? ((message) => console.log('[gdstudio]', redactSensitiveText(message)))
    const envHosts = (process.env.TWILIGHT_GD_ALLOWED_HOSTS ?? '').split(',').map(item => item.trim()).filter(Boolean)
    const configuredHosts = options.allowedHostSuffixes ?? (envHosts.length > 0 ? envHosts : GD_ALLOWED_HOST_SUFFIXES)
    // 本地 mock 的媒体/图片 URL 也是 127.0.0.1：只在测试基址模式把该主机加进白名单。
    this.allowedHostSuffixes = resolved.localTest ? [...configuredHosts, '127.0.0.1'] : configuredHosts
    // 注入 fetch 的调用方（单测/自托管）自带传输层；没注入 lookup 时固定公网 IP 占位，避免单测真实 DNS。
    // 生产（真实 fetch，无注入）走 node:dns，对每个上游 URL 做解析级 SSRF 校验。
    this.lookup = options.lookup ?? (options.fetchImpl ? async () => ['93.184.216.34'] : undefined)
    this.jsonMaxBytes = options.jsonMaxBytes ?? 2 * 1024 * 1024
    this.imageMaxBytes = options.imageMaxBytes ?? 8 * 1024 * 1024
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60_000
    this.urlCacheTtlMs = options.urlCacheTtlMs ?? 60_000
    if (this.localTestBase) {
      this.log('[test] GD API 使用本地回环测试基址 ' + this.localTestOrigin + '：loopback 例外仅对本进程生效。')
    }
  }

  /** 仅当这是本地 mock 基址上的 URL 时才跳过 API 的 SSRF 校验（CDN 仍走白名单+loopback 例外）。 */
  private isLocalTestApiUrl(raw: string): boolean {
    if (!this.localTestBase) return false
    try { return new URL(raw).origin === this.localTestOrigin } catch { return false }
  }

  private endpoint(params: Record<string, string>): string {
    const url = new URL(this.baseUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.toString()
  }

  private cached(kind: CacheKind, key: string): unknown {
    const entry = this.caches[kind].get(key)
    if (!entry) return undefined
    if (this.now() >= entry.expiresAt) {
      this.caches[kind].delete(key)
      return undefined
    }
    return entry.value
  }

  private remember(kind: CacheKind, key: string, value: unknown, ttlMs: number = this.cacheTtlMs): void {
    this.caches[kind].set(key, { expiresAt: this.now() + ttlMs, value })
    if (this.caches[kind].size > 500) {
      const oldest = this.caches[kind].keys().next()
      if (!oldest.done) this.caches[kind].delete(oldest.value)
    }
  }

  /**
   * 一次 GET + JSON。重试只对**网络/超时/5xx**（GET 幂等、上游抖动常见）；
   * 4xx 是业务/协议结果，重试没有意义（还会浪费配额）。
   */
  private async requestJson(kind: CacheKind, params: Record<string, string>, options: { ttlMs?: number } = {}): Promise<unknown> {
    const key = kind + '|' + new URLSearchParams(params).toString()
    const hit = this.cached(kind, key)
    if (hit !== undefined) return hit
    const source = params.source
    // 429 冷却：同源在冷却期内不再打上游（也避免连续失败放大封禁）。
    if (source) {
      const until = this.cooling.get(source)
      if (until !== undefined && this.now() < until) {
        throw new GdError('GD 音乐台（' + source + '）正在限流冷却，请稍后重试。')
      }
    }
    const url = this.endpoint(params)
    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const value = await this.limiter.run(() => this.getJson(url))
        this.remember(kind, key, value, options.ttlMs ?? this.cacheTtlMs)
        return value
      } catch (error) {
        lastError = error
        if (error instanceof GdHttpError && error.status === 429) {
          if (source) this.cooling.set(source, this.now() + this.rateLimitCooldownMs)
          const seconds = Math.round(this.rateLimitCooldownMs / 1000)
          this.log('限流冷却 source=' + String(source ?? 'unknown') + ' ' + seconds + 's')
          throw new GdError('GD 音乐台' + (source ? '（' + source + '）' : '') + '限流（429），已暂停该源 ' + seconds + ' 秒。')
        }
        // URL 安全校验失败是确定性结果（不重试）；只有网络/超时/5xx 值得再试一次。
        const retryable = error instanceof GdSecurityError
          ? false
          : error instanceof GdHttpError ? error.status >= 500 : true
        if (attempt === 1 || !retryable) break
        await sleep(this.retryDelayMs)
      }
    }
    const message = describeGdError(lastError)
    this.log(message)
    // 对外永远是中文单层 GdError（内部状态码只用于重试判断，不泄漏给 UI）。
    throw new GdError(message)
  }

  /** 带 SSRF 校验与逐跳重定向复验的文本请求（JSON 端点共用）。 */
  /**
   * API 基址的校验策略：
   *  - 生产：assertSafeRemoteUrl（官方 https 域名 + 公网 IP 校验）；
   *  - 本地 mock（显式 127.0.0.1 覆写）：只要求 http(s)，跳过域名/IP 校验（仅本进程）。
   * CDN 资源 URL 不走这里，仍然强制白名单 + loopback 例外。
   */
  private async validateApiUrl(raw: string): Promise<SafeRemoteUrl> {
    if (this.localTestBase && this.isLocalTestApiUrl(raw)) {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new GdSecurityError('上游地址只允许 http(s)。')
      return { url: parsed, allowInsecure: parsed.protocol === 'http:' }
    }
    try {
      return await assertSafeRemoteUrl(raw, { lookup: this.lookup })
    } catch (error) {
      throw new GdSecurityError(describeGdError(error))
    }
  }

  private async fetchJsonText(url: string): Promise<{ status: number; text: string }> {
    let current = await this.validateApiUrl(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      for (let hop = 0; hop <= 3; hop += 1) {
        const response = await this.fetchImpl(current.url.href, {
          headers: { 'user-agent': GD_UA, accept: 'application/json' },
          signal: controller.signal,
          redirect: 'manual'
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => undefined)
          if (!location) throw new GdError('GD 音乐台返回了没有 Location 的重定向。')
          const nextRaw = new URL(location, current.url).href
          current = await this.validateApiUrl(nextRaw)
          continue
        }
        const length = Number(response.headers.get('content-length') ?? 0)
        if (Number.isFinite(length) && length > this.jsonMaxBytes) {
          await response.body?.cancel().catch(() => undefined)
          throw new GdError('GD 音乐台 JSON 响应过大，已中止。')
        }
        const text = await this.readTextCapped(response, this.jsonMaxBytes)
        return { status: response.status, text }
      }
      throw new GdError('GD 音乐台重定向次数过多。')
    } finally {
      clearTimeout(timer)
    }
  }

  private async readTextCapped(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new GdError('GD 音乐台 JSON 响应过大，已中止。')
        }
        chunks.push(value)
      }
    } finally {
      try { reader.releaseLock() } catch { /* 已释放 */ }
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  }

  private async getJson(url: string): Promise<unknown> {
    const { status, text } = await this.fetchJsonText(url)
    if (status < 200 || status >= 300) {
      let detail = text.slice(0, 160)
      try {
        const body = JSON.parse(text) as Record<string, unknown>
        detail = str(body.detail ?? body.error ?? body.message) || detail
      } catch { /* 非 JSON 保留原文 */ }
      throw new GdHttpError(status, redactSensitiveText(detail.replace(/\s+/g, ' ').trim()))
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new GdError('GD 音乐台返回的不是 JSON（上游协议可能变了）。')
    }
  }

  // ---- 搜索 / 源选择 ----------------------------------------------------

  async searchSource(source: string, keyword: string, limit = 30): Promise<StreamingTrack[]> {
    const query = keyword.trim()
    if (!query) return []
    const json = await this.requestJson('search', {
      types: 'search', source, name: query, count: String(Math.max(1, Math.min(50, limit))), pages: '1'
    })
    return mapSearchRows(json, source).slice(0, Math.max(1, limit))
  }

  /**
   * 按「当前可用源」顺序搜索，第一个有结果的源胜出；全失败时抛出聚合原因。
   * 顺序：默认 netease → joox；探测过可用性时可用源优先（保持相对顺序）。
   */
  async searchAvailable(keyword: string, limit = 30): Promise<StreamingTrack[]> {
    const order = await this.sourceOrder()
    const failures: string[] = []
    for (const source of order) {
      try {
        const rows = await this.searchSource(source, keyword, limit)
        if (rows.length > 0) return rows
      } catch (error) {
        failures.push(source + '：' + describeGdError(error))
      }
    }
    if (failures.length === order.length) {
      throw new GdError('GD 音乐台搜索失败（已尝试 ' + order.join('/') + '）：' + failures.join('；'))
    }
    return []
  }

  /** 显式探测各源可用性（10 分钟缓存）；界面/诊断用。 */
  async probeSources(): Promise<GdSourceStatus[]> {
    if (this.probeCache && this.now() < this.probeCache.expiresAt) return this.probeCache.statuses
    const statuses: GdSourceStatus[] = []
    for (const source of GD_SOURCES) {
      const checkedAt = this.now()
      try {
        const rows = await this.searchSource(source, '周杰伦', 1)
        statuses.push({ source, ok: rows.length > 0, checkedAt, error: rows.length > 0 ? null : '没有返回结果' })
      } catch (error) {
        statuses.push({ source, ok: false, checkedAt, error: describeGdError(error) })
      }
    }
    this.probeCache = { expiresAt: this.now() + this.cacheTtlMs, statuses }
    return statuses
  }

  private async sourceOrder(): Promise<GdSource[]> {
    const statuses = this.probeCache && this.now() < this.probeCache.expiresAt ? this.probeCache.statuses : null
    if (!statuses) return [...GD_SOURCES]
    const usable = statuses.filter(status => status.ok).map(status => status.source as GdSource)
    if (usable.length === 0) return [...GD_SOURCES]
    const rest = GD_SOURCES.filter(source => !usable.includes(source))
    return [...usable, ...rest]
  }

  // ---- 取链 -------------------------------------------------------------

  /**
   * 取直链（含换源）。策略：
   *  1. 先试曲目自带的源 + url_id；
   *  2. 失败则用 title/artist 在其它源搜索，取最像的一首再取链（netease → joox）。
   * 返回真实 br/quality；失败时抛出所有尝试过的原因（单行中文）。
   */
  async resolvePlay(input: { id: string; title?: string; artist?: string }, quality = 'best'): Promise<GdPlayTarget> {
    const ids = decodeGdId(input.id)
    const title = (input.title ?? '').trim()
    const artist = (input.artist ?? '').trim()
    const br = quality && quality !== 'best' && /^\d+$/.test(quality) ? quality : ''
    const attempted: string[] = []
    const trySource = async (source: string, urlId: string): Promise<GdPlayTarget | null> => {
      if (!urlId) return null
      const params: Record<string, string> = { types: 'url', source, id: urlId }
      if (br) params.br = br
      try {
        // 直链签名有时效：url 只缓存 60s，别拿着过期链接去 open。
        const json = await this.requestJson('url', params, { ttlMs: this.urlCacheTtlMs })
        const mapped = mapPlayUrl(json, source)
        // P0：上游给的 URL 是可控数据 —— 解析 IP、拒绝内网/回环、限定 CDN 白名单后才交给媒体代理。
        let safe: SafeRemoteUrl
        try {
          safe = await assertSafeRemoteUrl(mapped.url, {
            allowedHostSuffixes: this.allowedHostSuffixes,
            lookup: this.lookup,
            allowLoopback: this.localTestBase
          })
        } catch (error) {
          attempted.push(source + '：' + describeGdError(error))
          return null
        }
        return {
          url: safe.url.href, br: mapped.br, size: mapped.size, source,
          quality: qualityFromBr(mapped.br), title, artist, allowInsecure: safe.allowInsecure
        }
      } catch (error) {
        attempted.push(source + '：' + describeGdError(error))
        return null
      }
    }
    if (ids) {
      const direct = await trySource(ids.source, ids.urlId)
      if (direct) return direct
    }
    const sources = [ids?.source, ...GD_SOURCES].filter((source): source is string => Boolean(source))
    const unique = [...new Set(sources)]
    for (const source of unique) {
      if (ids && source === ids.source) continue
      if (!title) continue
      try {
        const matched = await this.matchOnSource(source, title, artist)
        if (!matched) continue
        const decoded = decodeGdId(matched.id)
        if (!decoded) continue
        const target = await trySource(source, decoded.urlId)
        if (target) return target
      } catch (error) {
        attempted.push(source + '：' + describeGdError(error))
      }
    }
    throw new GdError('GD 音乐台取链失败' + (attempted.length ? '（' + attempted.join('；') + '）' : '：没有可尝试的来源。'))
  }

  /** 在某个源里按「歌名 + 歌手」找最像的一首（换源兜底）。 */
  private async matchOnSource(source: string, title: string, artist: string): Promise<StreamingTrack | null> {
    const keyword = artist ? title + ' ' + artist : title
    const rows = await this.searchSource(source, keyword, 5)
    const normalized = (value: string): string => value.toLowerCase().replace(/\s+/g, '')
    const exact = rows.find(row => normalized(row.title) === normalized(title))
    return exact ?? rows[0] ?? null
  }

  // ---- 歌词 / 封面 / 歌单 ----------------------------------------------

  async lyric(id: string): Promise<{ lrc: string; translation: string }> {
    const ids = decodeGdId(id)
    if (!ids || !ids.lyricId) throw new GdError('GD 音乐台：这首歌没有歌词 id。')
    const json = await this.requestJson('lyric', { types: 'lyric', source: ids.source, id: ids.lyricId })
    return mapLyric(json)
  }

  async cover(id: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const ids = decodeGdId(id)
    if (!ids || !ids.picId) return null
    try {
      const json = await this.requestJson('pic', { types: 'pic', source: ids.source, id: ids.picId })
      const url = mapPicUrl(json)
      if (!url) return null
      return await this.fetchImage(url)
    } catch (error) {
      // 封面不参与「能不能播」，失败收敛为 null（与 manager.coverFor 的约定一致）。
      this.log('封面获取失败：' + describeGdError(error))
      return null
    }
  }

  /**
   * 下载封面字节（P0 加固）：
   *  - URL 复用 SSRF 校验 + CDN 白名单，**每一跳重定向都复验**；
   *  - content-length 预检 + 流式限长（超过 imageMaxBytes 立即中止，先查后读不能防 chunked）；
   *  - content-type 必须是 image/*，并以 magic bytes 判定真实格式（防止把 HTML/脚本当图片落盘）。
   */
  private async fetchImage(rawUrl: string): Promise<{ data: Uint8Array; mime: string } | null> {
    let current: SafeRemoteUrl
    try {
      current = await assertSafeRemoteUrl(rawUrl, {
        allowedHostSuffixes: this.allowedHostSuffixes,
        lookup: this.lookup,
        allowLoopback: this.localTestBase
      })
    } catch (error) {
      this.log('封面地址被拒绝：' + describeGdError(error))
      return null
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      for (let hop = 0; hop <= 3; hop += 1) {
        const response = await this.limiter.run(() => this.fetchImpl(current.url.href, {
          headers: { 'user-agent': GD_UA, accept: 'image/*' },
          signal: controller.signal,
          redirect: 'manual'
        }))
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => undefined)
          if (!location) return null
          const nextRaw = new URL(location, current.url).href
          try {
            current = await assertSafeRemoteUrl(nextRaw, {
              allowedHostSuffixes: this.allowedHostSuffixes,
              lookup: this.lookup,
              allowLoopback: this.localTestBase
            })
          } catch (error) {
            this.log('封面重定向被拒绝：' + describeGdError(error))
            return null
          }
          continue
        }
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null }
        const type = (response.headers.get('content-type') ?? '').toLowerCase()
        if (!type.startsWith('image/')) {
          await response.body?.cancel().catch(() => undefined)
          this.log('封面响应不是图片（content-type=' + type.slice(0, 40) + '），已丢弃。')
          return null
        }
        const length = Number(response.headers.get('content-length') ?? 0)
        if (Number.isFinite(length) && length > this.imageMaxBytes) {
          await response.body?.cancel().catch(() => undefined)
          this.log('封面过大（content-length=' + length + '），已丢弃。')
          return null
        }
        const data = await this.readBytesCapped(response, this.imageMaxBytes)
        if (!data || data.byteLength === 0) return null
        const mime = detectImageMime(data)
        if (!mime) {
          this.log('封面 magic bytes 不是 jpg/png/webp/gif，已丢弃。')
          return null
        }
        return { data, mime }
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async readBytesCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(value)
      }
    } finally {
      try { reader.releaseLock() } catch { /* 已释放 */ }
    }
    return new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  }

  async playlistTracks(id: string): Promise<StreamingTrack[]> {
    const playlistId = id.trim()
    if (!playlistId) throw new GdError('GD 音乐台：缺少歌单 id。')
    const json = await this.requestJson('playlist', { types: 'playlist', source: 'netease', id: playlistId })
    return mapPlaylistTracks(json)
  }

  // ---- 相似歌曲（Embeat） ----------------------------------------------

  /**
   * Embeat item-to-item 相似推荐。无鉴权时上游可能 4xx/5xx 或返回空数组 ——
   * 这两种都算「不可用」，降级为 GD 同歌手/同专辑搜索，并在结果里如实标注。
   */
  async similar(track: { id?: string; title?: string; artist?: string; album?: string }): Promise<StreamingSimilarResult> {
    const ids = track.id ? decodeGdId(track.id) : null
    const title = (track.title ?? '').trim()
    const artist = (track.artist ?? '').trim()
    if (title) {
      try {
        const params: Record<string, string> = { types: 'embeat_by_track', name: title }
        if (artist) params.artist = artist
        if (ids?.source) params.source = ids.source
        if (ids?.urlId) params.id = ids.urlId
        const json = await this.requestJson('embeat', params)
        if (Array.isArray(json) && json.length > 0) {
          const source = ids?.source ?? 'netease'
          return {
            items: mapSearchRows(json, source).map(item => ({ ...item, sourceName: 'Embeat 相似' })),
            degraded: false,
            reason: null
          }
        }
        return await this.fallbackSimilar(title, artist, 'Embeat 没有返回相似曲目')
      } catch (error) {
        return await this.fallbackSimilar(title, artist, 'Embeat 不可用：' + describeGdError(error))
      }
    }
    return this.fallbackSimilar(title, artist, '缺少歌名，无法请求 Embeat')
  }

  private async fallbackSimilar(title: string, artist: string, reason: string): Promise<StreamingSimilarResult> {
    // 多歌手是 ' / ' 连接的（周杰伦 / 李硕 / 张鑫）：整串去搜基本搜不到，
    // 用第一歌手做「同歌手」兜底；再不行用歌名。
    const primaryArtist = artist.split('/')[0]?.trim() ?? ''
    const keyword = primaryArtist || title
    if (!keyword) return { items: [], degraded: true, reason }
    try {
      let rows = await this.searchAvailable(keyword, 10)
      if (rows.length === 0 && title && keyword !== title) rows = await this.searchAvailable(title, 10)
      const filtered = title
        ? rows.filter(row => row.title !== title)
        : rows
      return {
        items: filtered.map(row => ({ ...row, sourceName: 'GD 音乐台' })),
        degraded: true,
        reason: reason + '；已降级为同歌手/同专辑搜索。'
      }
    } catch (error) {
      return { items: [], degraded: true, reason: reason + '；降级搜索也失败：' + describeGdError(error) }
    }
  }
}

/** 统一的 HTTP 错误（带状态码，重试策略只看它）。 */
export class GdHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super('GD 音乐台 HTTP ' + status + (detail ? '：' + detail : ''))
    this.name = 'GdHttpError'
  }
}

export const gdStudio = new GdStudioClient()
