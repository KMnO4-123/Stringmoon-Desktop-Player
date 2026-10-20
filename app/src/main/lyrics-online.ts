import type { Lyrics, Track } from '@shared/protocol'
import { artistTokens, deriveTrackIdentity, matchKey } from '@shared/track-identity'
import type { TrackIdentity } from '@shared/track-identity'
import { parseLyricsDocument } from '@shared/lyrics-parse'
import { classifyNeteasePlaceholder, neteaseLyrics, neteaseYrcLyrics } from '@shared/netease-lyrics'
import { NETEASE_LYRIC_URL, NETEASE_WEAPI_HEADERS, weapiForm } from './netease-weapi'
import type { NeteaseRichLyric } from './netease-weapi'
import { checkTimeline } from '@shared/lyrics-quality'

/**
 * 在线取词：把「这份歌词属于这首歌吗」当成一等公民。
 *
 * 背景（实测）：本机 91 首 FLAC 里 90 首没有标签、0 首内嵌歌词，所以歌词只能按
 * 「艺人 + 曲名 + 时长」去网上找。而**找错歌词比找不到更糟**：用户不会发现那是别人的版本，
 * 只会觉得播放器疯了。所以这里每个候选都要过计分，分不够就返回 null。
 *
 * 取词顺序 = 契约 §4.4（本地已由调用方先试过）：
 *   网易云搜索得到歌曲 ID → AMLL TTML DB（逐字 + 翻译）→ 网易云行级（原文+中译+罗马音）→ LRCLIB
 *
 * 风控（契约 §5）：同一平台请求间隔 ≥1s，令牌桶在这一层，任何调用方都绕不过；
 * 一次播放最多 4 个请求，不做批量、不做预取；收到 -460 立即停用该平台并记下来，不重试。
 */

export type OnlineProvider = 'amll-ttml' | 'netease' | 'lrclib'

export type { OnlineMatch } from '@shared/lyrics-model'
import type { OnlineMatch } from '@shared/lyrics-model'

export interface OnlineLyricsResult {
  lyrics: Lyrics
  match: OnlineMatch
}

export interface OnlineOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

const UA = 'Stringmoon/0.1.0 (desktop music player; TwilightEcho)'
/** 同一平台的最小间隔。契约 §5 的 ≥1s 是硬要求，这里只可能更严，不会更松。 */
const INTERVAL_MS: Record<OnlineProvider, number> = { 'amll-ttml': 300, netease: 1200, lrclib: 1200 }
/** 计分下限：低于它就认为「这不是这首歌的歌词」，返回 null。 */
const ACCEPT_SCORE = 0.5
const DECORATION = /\bcover\b|カバー|instrumental|\binst\b|off ?vocal|remix|karaoke|live ?ver|tv ?size|short ?ver/i

interface ThrottleState { lastAt: number; chain: Promise<unknown> }
const throttles = new Map<OnlineProvider, ThrottleState>()
/** -460 命中后该平台整场会话不再请求（契约 §5：立即停止、不重试）。 */
const blocked = new Map<OnlineProvider, string>()

export function resetOnlineStateForTests(): void {
  throttles.clear()
  blocked.clear()
  amllFailures = 0
  amllCooldownUntil = 0
  weapiFailures = 0
  weapiCooldownUntil = 0
}

/**
 * weapi（字级歌词）的熔断。
 *
 * 实测（2026-10-17）：同一套加密参数在连续探测约 10 次之后开始返回 **200 + 空 body**，
 * 换歌、换 id 都一样，隔一段时间才恢复 —— 这是服务端侧的限流，不是我们的参数算错了。
 * 所以它只能是 **best-effort**：失败就立刻退回明文接口（行级），并停一段时间不再试。
 * 用户日常的频率（一首歌一次、命中即缓存）远低于这个阈值。
 */
let weapiFailures = 0
let weapiCooldownUntil = 0
const WEAPI_FAILURE_LIMIT = 2
const WEAPI_COOLDOWN_MS = 10 * 60 * 1000

export function blockedPlatforms(): Record<string, string> {
  return Object.fromEntries(blocked)
}

async function limit<T>(provider: OnlineProvider, now: () => number, sleep: (ms: number) => Promise<void>, run: () => Promise<T>): Promise<T> {
  const state = throttles.get(provider) ?? { lastAt: 0, chain: Promise.resolve() }
  throttles.set(provider, state)
  const next = state.chain.then(async () => {
    // 间隔按**请求发起时刻**算，而不是「上一次结束之后」。
    // 契约 §5 要的是「同一平台请求间隔 ≥1s」；按结束时刻算会多等一整个请求的耗时
    // （本机实测网易云一次 600-800 ms），等于白等将近一倍。发起时刻算起既满足「间隔」，
    // 又保证前一个请求已经结束（这是串行队列），不会出现两个请求同时在飞。
    const wait = INTERVAL_MS[provider] - (now() - state.lastAt)
    if (wait > 0) await sleep(wait)
    state.lastAt = now()
    return run()
  })
  state.chain = next.then(() => undefined, () => undefined)
  return next
}

async function request(url: string, options: OnlineOptions, accept: 'json' | 'text'): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: accept === 'json' ? 'application/json' : 'text/plain, text/xml, */*' }
    })
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    return accept === 'json' ? await response.json() : await response.text()
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────── 计分 ─────────────────────────

export interface Candidate {
  id: string
  title: string
  artists: string[]
  durationMs?: number
  album?: string
}

export interface ScoreResult { score: number; risk: 'low' | 'medium' | 'high'; reasons: string[] }

export function scoreCandidate(identity: TrackIdentity, candidate: Candidate): ScoreResult {
  const reasons: string[] = []
  const wantedTitle = matchKey(identity.title)
  const gotTitle = matchKey(candidate.title)
  let score = 0
  if (wantedTitle && gotTitle === wantedTitle) { score += 0.55; reasons.push('title_exact') }
  else if (wantedTitle && gotTitle && (gotTitle.includes(wantedTitle) || wantedTitle.includes(gotTitle))) { score += 0.35; reasons.push('title_partial') }
  else { score += 0.05; reasons.push('title_mismatch') }

  const wantedArtists = artistTokens(identity.artist)
  const gotArtists = candidate.artists.flatMap(name => artistTokens(name))
  if (wantedArtists.length > 0 && gotArtists.length > 0) {
    if (wantedArtists.some(token => gotArtists.includes(token))) { score += 0.3; reasons.push('artist_exact') }
    else if (wantedArtists.some(token => gotArtists.some(other => other.includes(token) || token.includes(other)))) { score += 0.15; reasons.push('artist_partial') }
    else reasons.push('artist_mismatch')
  }

  const durationDelta = identity.durationMs && candidate.durationMs
    ? Math.abs(identity.durationMs - candidate.durationMs)
    : undefined
  if (durationDelta != null) {
    if (durationDelta <= 2000) { score += 0.15; reasons.push('duration_match') }
    else if (durationDelta <= 6000) { score += 0.07; reasons.push('duration_close') }
    else reasons.push('duration_conflict')
  }

  let risk: 'low' | 'medium' | 'high' = 'low'
  const versionConflict = DECORATION.test(candidate.title) && !DECORATION.test(identity.title)
  if (versionConflict) reasons.push('version_conflict')
  if (versionConflict || reasons.includes('artist_mismatch') || (durationDelta != null && durationDelta > 8000)) risk = 'high'
  else if (reasons.includes('title_partial') || wantedArtists.length === 0) risk = 'medium'
  return { score: Math.min(1, Math.round(score * 1000) / 1000), risk, reasons }
}

// ───────────────────────── 网易云 ─────────────────────────

interface NeteaseSong { id: number; name: string; duration?: number; artists?: { name?: string }[]; album?: { name?: string } }

function assertNotBlocked(provider: OnlineProvider): void {
  const reason = blocked.get(provider)
  if (reason) throw new Error('已停止使用 ' + provider + '：' + reason)
}

function checkBlockedCode(provider: OnlineProvider, code: unknown): void {
  const value = Number(code)
  if (value === -460 || value === 460) {
    const reason = '风控错误 ' + value + '（Cheating），已停止该平台全部请求'
    blocked.set(provider, reason)
    throw new Error(reason)
  }
}

export interface ScoredCandidate { id: string; candidate: Candidate; score: ScoreResult }

/**
 * 网易云搜索，返回**全部**候选（不在这一层筛分）。
 * 搜索是「给个列表」，计分是另一件事 —— 人工纠正要看到的就是这份列表。
 */
async function neteaseSearchRaw(identity: TrackIdentity, options: OnlineOptions): Promise<ScoredCandidate[]> {
  assertNotBlocked('netease')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const keyword = [identity.artist, identity.title].filter(Boolean).join(' ').trim()
  if (!keyword) return []
  const url = 'https://music.163.com/api/search/get?s=' + encodeURIComponent(keyword) + '&type=1&limit=10&offset=0'
  const payload = await limit('netease', now, sleep, () => request(url, options, 'json')) as { code?: unknown; result?: { songs?: NeteaseSong[] } }
  checkBlockedCode('netease', payload?.code)
  const out: ScoredCandidate[] = []
  for (const song of payload?.result?.songs ?? []) {
    if (!song || typeof song.id !== 'number') continue
    const candidate: Candidate = {
      id: String(song.id),
      title: String(song.name ?? ''),
      artists: (song.artists ?? []).map(artist => String(artist?.name ?? '')).filter(Boolean),
      durationMs: Number.isFinite(song.duration) ? Number(song.duration) : undefined,
      album: typeof song.album?.name === 'string' ? song.album.name : undefined
    }
    out.push({ id: candidate.id, candidate, score: scoreCandidate(identity, candidate) })
  }
  return out.sort((a, b) => b.score.score - a.score.score)
}

async function searchNetease(identity: TrackIdentity, options: OnlineOptions): Promise<ScoredCandidate | null> {
  const ranked = await neteaseSearchRaw(identity, options)
  return ranked.find(item => item.score.score >= ACCEPT_SCORE) ?? null
}

/**
 * 一次请求拿回全部：yrc（字级）+ lrc（行级）+ tlyric（中译）+ romalrc（罗马音）。
 *
 * 为什么必须走加密接口：明文 /api/song/lyric 从不返回 yrc（实测穷举过参数组合），
 * 只有 weapi 会给。加密失败（算法变更/网络）时退回明文接口，宁可只有行级也不能没有歌词。
 */
async function postWeapiLyric(id: string, options: OnlineOptions): Promise<NeteaseRichLyric> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  try {
    const response = await fetchImpl(NETEASE_LYRIC_URL, {
      method: 'POST',
      headers: NETEASE_WEAPI_HEADERS,
      body: weapiForm({ id, lv: -1, tv: -1, rv: -1, yv: -1, ytv: -1, yrv: -1, cp: false }),
      signal: controller.signal
    } as RequestInit)
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    return await response.json() as NeteaseRichLyric
  } finally {
    clearTimeout(timer)
  }
}

async function fetchNeteaseLyrics(id: string, options: OnlineOptions): Promise<{ lyrics: Lyrics | null; instrumental?: boolean }> {
  assertNotBlocked('netease')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  let payload: NeteaseRichLyric | null = null
  if (now() >= weapiCooldownUntil) {
    try {
      const result = await limit('netease', now, sleep, () => postWeapiLyric(id, options))
      // 空 body 是限流的典型形态（200 + content-length: 0），必须按失败处理，
      // 否则 JSON 解析会在别处炸，而且我们会误以为「这首歌没有字级歌词」。
      if (!result || typeof result !== 'object' || Object.keys(result).length === 0) throw new Error('empty weapi response')
      payload = result
      weapiFailures = 0
    } catch {
      // 加密接口挂了不代表歌词没了：退回明文接口（只有行级）。
      weapiFailures++
      if (weapiFailures >= WEAPI_FAILURE_LIMIT) {
        weapiFailures = 0
        weapiCooldownUntil = now() + WEAPI_COOLDOWN_MS
      }
      payload = null
    }
  }
  if (!payload) {
    const url = 'https://music.163.com/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&tv=-1&rv=-1'
    payload = await limit('netease', now, sleep, () => request(url, options, 'json')) as NeteaseRichLyric
  }
  checkBlockedCode('netease', payload?.code)

  // ① 有 yrc：真的字级时间，标 wordByWord=true。
  const timed = payload.yrc?.lyric
    ? neteaseYrcLyrics({
        yrc: payload.yrc.lyric,
        tlyric: payload.tlyric?.lyric,
        romalrc: payload.romalrc?.lyric,
        ytlrc: payload.ytlrc?.lyric,
        yromalrc: payload.yromalrc?.lyric
      })
    : null
  if (timed && timed.lines.length > 0) {
    const placeholder = classifyNeteasePlaceholder(timed.lines)
    if (placeholder) return { lyrics: null, instrumental: placeholder === 'instrumental' }
    return { lyrics: { lines: timed.lines, wordByWord: timed.wordByWord, source: 'netease-yrc' } }
  }

  // ② 没有 yrc：行级（原文 + 中译 + 罗马音），如实标 false。
  const parsed = neteaseLyrics({
    lrc: payload.lrc?.lyric,
    tlyric: payload.tlyric?.lyric,
    romalrc: payload.romalrc?.lyric
  })
  if (!parsed) return { lyrics: null }
  const placeholder = classifyNeteasePlaceholder(parsed.lines)
  if (placeholder) return { lyrics: null, instrumental: placeholder === 'instrumental' }
  return { lyrics: { lines: parsed.lines, wordByWord: false, source: 'netease-lrc' } }
}

// ───────────────────────── AMLL TTML DB（CC0） ─────────────────────────

/**
 * AMLL TTML DB 的取法。顺序按**本机实测**排的，不是按「谁更正规」：
 *   ① jsDelivr CDN —— 中国大陆通常可达，命中率最好；
 *   ② gh-proxy 镜像 —— CDN 偶发拒连时的稳定退路（只取公开 CC0 文件）；
 *   ③ 直连 raw.githubusercontent —— 在本机**两次实测都超时**，放最后，避免前面挂了就干等 8 秒。
 * 任何一个 404 表示「这个 ID 库里确实没有」，直接放弃整档（换镜像也没用）。
 */
const AMLL_MIRRORS = [
  (id: string) => 'https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/ncm-lyrics/' + id + '.ttml',
  (id: string) => 'https://gh-proxy.com/https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/ncm-lyrics/' + id + '.ttml',
  (id: string) => 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/ncm-lyrics/' + id + '.ttml'
]

/**
 * AMLL 这一档的**总时间预算**。
 *
 * 实测：一首歌在 AMLL 库里的概率约 1/14，也就是大多数时候这三跳全是白跑，
 * 而每次白跑要付「jsDelivr 一次 + gh-proxy 一次」的往返（本机实测 0.9–1.6 s）。
 * 逐字歌词值得多等一点，但不值得无限等：超预算就放弃这一档，
 * 直接退回网易云行级（它同样带原文、中译和罗马音）。
 */
const AMLL_BUDGET_MS = 2000
/** 连续失败这么多次就认为这一档当前不可用，冷却一段时间不再尝试。 */
const AMLL_FAILURE_LIMIT = 3
const AMLL_COOLDOWN_MS = 10 * 60 * 1000

let amllFailures = 0
let amllCooldownUntil = 0

/** 供测试使用的状态复位。 */
export function resetAmllHealthForTests(): void {
  amllFailures = 0
  amllCooldownUntil = 0
}

async function fetchAmllLyrics(id: string, options: OnlineOptions): Promise<Lyrics | null> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  // 熔断：CDN 真的挂了的时候，不能每首歌都白等 2 秒。
  if (now() < amllCooldownUntil) return null
  const deadline = now() + AMLL_BUDGET_MS
  const failed = (): null => {
    amllFailures++
    if (amllFailures >= AMLL_FAILURE_LIMIT) {
      amllFailures = 0
      amllCooldownUntil = now() + AMLL_COOLDOWN_MS
    }
    return null
  }
  for (const build of AMLL_MIRRORS) {
    // ⚠️ 只检查「两次尝试之间」是不够的：挂住的请求要等满超时才会回来（实测 8 s）。
    // 所以每次尝试的**超时**也必须压到剩余预算之内，否则预算形同虚设。
    const remaining = deadline - now()
    if (remaining <= 400) return failed()
    let text: string
    try {
      const attempt = { ...options, timeoutMs: Math.min(options.timeoutMs ?? 8000, remaining) }
      text = await limit('amll-ttml', now, sleep, () => request(build(id), attempt, 'text')) as string
    } catch (error) {
      // 404 = 这个 ID 在库里确实没有；换镜像也没用。
      if ((error as { status?: number }).status === 404) { amllFailures = 0; return null }
      continue
    }
    const parsed = parseLyricsDocument(text)
    if (!parsed || parsed.lines.length === 0) continue
    amllFailures = 0
    return { lines: parsed.lines, wordByWord: parsed.wordByWord, source: 'amll-ttml' }
  }
  return failed()
}

// ───────────────────────── LRCLIB ─────────────────────────

interface LrclibRecord {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

async function fetchLrclibLyrics(identity: TrackIdentity, options: OnlineOptions): Promise<{ lyrics: Lyrics; candidate: Candidate; score: ScoreResult } | null> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const query = new URLSearchParams()
  if (identity.title) query.set('track_name', identity.title)
  if (identity.artist) query.set('artist_name', identity.artist)
  if (identity.durationMs) query.set('duration', String(Math.round(identity.durationMs / 1000)))
  const url = 'https://lrclib.net/api/search?' + query.toString()
  let records: LrclibRecord[]
  try {
    records = await limit('lrclib', now, sleep, () => request(url, options, 'json')) as LrclibRecord[]
  } catch {
    return null
  }
  if (!Array.isArray(records)) return null
  let best: { lyrics: Lyrics; candidate: Candidate; score: ScoreResult } | null = null
  for (const record of records) {
    // 只有 plainLyrics 的记录不带时间轴：塞进 lines 只能全部落在 0ms，那是在伪造同步。
    if (!record?.syncedLyrics) continue
    if (record.instrumental) continue
    const candidate: Candidate = {
      id: String(record.id ?? ''),
      title: String(record.trackName ?? ''),
      // 艺人名保持整串（"TEST ROID" 就是一个人名串），拆词只发生在计分里。
      artists: String(record.artistName ?? '').trim() ? [String(record.artistName).trim()] : [],
      durationMs: Number.isFinite(record.duration) ? Number(record.duration) * 1000 : undefined,
      album: typeof record.albumName === 'string' ? record.albumName : undefined
    }
    const score = scoreCandidate(identity, candidate)
    if (score.score < ACCEPT_SCORE) continue
    const parsed = parseLyricsDocument(record.syncedLyrics)
    if (!parsed || parsed.lines.length === 0) continue
    const lyrics: Lyrics = { lines: parsed.lines, wordByWord: parsed.wordByWord, source: 'lrclib' }
    if (best == null || score.score > best.score.score) best = { lyrics, candidate, score }
  }
  return best
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * 「没有歌词」其实有两种，必须分开：
 *  - 返回 null            = 找过了，没有（可以继续兜底 / 记一笔未命中）
 *  - instrumental: true   = **确认**这首是纯音乐（BGM/配乐）。这不是失败，
 *                           而且它是最终结论 —— 再去 LRCLIB 找只会找到同名的别的歌。
 */
export interface OnlineLyricLookup {
  lyrics: Lyrics | null
  match?: OnlineMatch
  instrumental?: boolean
}

/**
 * 元数据说得再像，也要过一遍时间轴：同名翻唱/现场版的元数据可能全对，
 * 但「这首歌放完之前它唱完了没有」是另一份独立证据。
 * 明显不是这首的（超出曲长 75 s）就当作没找到，让链路继续往下走。
 */
function withTimeline(lyrics: Lyrics, match: OnlineMatch, durationMs: number | undefined): OnlineLyricLookup | null {
  const check = checkTimeline(lyrics, durationMs)
  if (!check.accept) return null
  if (!check.risky || match.risk === 'high') return { lyrics, match }
  return { lyrics, match: { ...match, risk: 'high', reasons: [...match.reasons, check.issue ?? 'timeline'] } }
}

export async function fetchOnlineLyrics(track: Track, options: OnlineOptions = {}): Promise<OnlineLyricLookup | null> {
  const identity = deriveTrackIdentity(track)
  if (!identity.title) return null

  /**
   * 元数据说得再像，也要过一遍时间轴：同名翻唱/现场版的元数据可能全对，
   * 但「这首歌放完之前它唱完了没有」是另一份独立证据。
   * 明显不是这首的（超出曲长 75 s）就当作没找到，让链路继续往下走。
   */
  const accept = (lyrics: Lyrics, match: OnlineMatch): OnlineLyricLookup | null =>
    withTimeline(lyrics, match, identity.durationMs)

  let neteaseError: unknown = null
  let best: { id: string; candidate: Candidate; score: ScoreResult } | null = null
  try {
    best = await searchNetease(identity, options)
  } catch (error) {
    neteaseError = error
  }

  let instrumental = false
  if (best) {
    const match: OnlineMatch = {
      provider: 'amll-ttml',
      title: best.candidate.title,
      artist: best.candidate.artists.join(' / '),
      ...(best.candidate.album ? { album: best.candidate.album } : {}),
      ...(best.candidate.durationMs ? { durationMs: best.candidate.durationMs } : {}),
      ncmId: best.id,
      score: best.score.score,
      risk: best.score.risk,
      reasons: best.score.reasons
    }
    // 契约 §4.4：AMLL 在网易云之前。只有逐字 + 翻译的那一份才值得替换行级数据。
    const amll = await fetchAmllLyrics(best.id, options)
    if (amll) {
      const accepted = accept(amll, match)
      if (accepted) return accepted
    }

    const netease: { lyrics: Lyrics | null; instrumental?: boolean } = await fetchNeteaseLyrics(best.id, options).catch((error: unknown) => {
      neteaseError = error
      return { lyrics: null }
    })
    if (netease.lyrics) {
      const accepted = accept(netease.lyrics, { ...match, provider: 'netease' })
      if (accepted) return accepted
    }
    // 网易云明确说这是纯音乐：这是结论，不是失败。继续去 LRCLIB 找只可能找到错的。
    if (netease.instrumental) return { lyrics: null, instrumental: true, match: { ...match, provider: 'netease' } }
  }

  const lrclib = await fetchLrclibLyrics(identity, options)
  if (lrclib) {
    const accepted = accept(lrclib.lyrics, {
      provider: 'lrclib',
      title: lrclib.candidate.title,
      artist: lrclib.candidate.artists.join(' / '),
      ...(lrclib.candidate.album ? { album: lrclib.candidate.album } : {}),
      ...(lrclib.candidate.durationMs ? { durationMs: lrclib.candidate.durationMs } : {}),
      score: lrclib.score.score,
      risk: lrclib.score.risk,
      reasons: lrclib.score.reasons
    })
    // 时间轴对不上就当作没找到 —— 但 LRCLIB 是最后一档，这里直接收敛成「没有歌词」。
    if (accepted) return accepted
    return null
  }

  if (neteaseError) throw neteaseError
  return null
}

// ───────────────────────── 人工纠正 ─────────────────────────

export interface LyricCandidateOption {
  id: string
  title: string
  artist: string
  album?: string
  durationMs?: number
  score: number
  risk: 'low' | 'medium' | 'high'
  reasons: string[]
}

/**
 * 列出这首歌的搜索候选，给用户自己挑。
 *
 * 为什么需要它：计分再细也只是启发式，错配是**必然会发生**的（同名翻唱、live 版、
 * 名字里带括号的版本）。在此之前用户唯一的动作是「重新查一次」——而重查大概率还是同一个结果。
 * 这个接口只发**一次**搜索请求，不再探测 AMLL / 歌词，用户点了哪一条才去取哪一条。
 */
export async function searchLyricCandidates(track: Track, options: OnlineOptions = {}): Promise<LyricCandidateOption[]> {
  const identity = deriveTrackIdentity(track)
  if (!identity.title) return []
  let ranked: ScoredCandidate[] = []
  try {
    ranked = await neteaseSearchRaw(identity, options)
  } catch {
    return []
  }
  return ranked.slice(0, 8).map((item) => ({
    id: item.id,
    title: item.candidate.title,
    artist: item.candidate.artists.join(' / '),
    ...(item.candidate.album ? { album: item.candidate.album } : {}),
    ...(item.candidate.durationMs ? { durationMs: item.candidate.durationMs } : {}),
    score: item.score.score,
    risk: item.score.risk,
    reasons: item.score.reasons
  }))
}

/** 按用户选中的那一条去取歌词（AMLL 优先，其次网易云），仍然过时间轴自检。 */
export async function fetchLyricsForCandidate(
  track: Track,
  candidate: LyricCandidateOption,
  options: OnlineOptions = {}
): Promise<OnlineLyricLookup | null> {
  const identity = deriveTrackIdentity(track)
  if (!identity.title || !candidate.id) return null
  const match: OnlineMatch = {
    provider: 'amll-ttml',
    title: candidate.title,
    artist: candidate.artist,
    ...(candidate.album ? { album: candidate.album } : {}),
    ...(candidate.durationMs ? { durationMs: candidate.durationMs } : {}),
    ncmId: candidate.id,
    score: candidate.score,
    risk: candidate.risk,
    reasons: candidate.reasons
  }
  const amll = await fetchAmllLyrics(candidate.id, options)
  if (amll) {
    const accepted = withTimeline(amll, match, identity.durationMs)
    if (accepted) return accepted
  }
  const netease = await fetchNeteaseLyrics(candidate.id, options).catch(() => ({ lyrics: null }) as { lyrics: Lyrics | null; instrumental?: boolean })
  if (netease.lyrics) {
    const accepted = withTimeline(netease.lyrics, { ...match, provider: 'netease' }, identity.durationMs)
    if (accepted) return accepted
  }
  if (netease.instrumental) return { lyrics: null, instrumental: true, match: { ...match, provider: 'netease' } }
  return null
}
