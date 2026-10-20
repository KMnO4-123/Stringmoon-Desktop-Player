import type { Lyrics } from './protocol'

export interface LyricsSourceResult {
  lyrics: Lyrics
  resolvedPath: string
  source: 'attached' | 'sidecar' | 'embedded'
}

export interface LyricsLoadResult {
  lyrics: Lyrics | null
  resolvedPath: string | null
  source: 'attached' | 'sidecar' | 'embedded' | 'none'
  attachedUnavailable: boolean
  offsetMs: number
}

export interface LyricsConfig {
  version: 1
  tracks: Record<string, { attachedPath?: string; offsetMs: number }>
}

export function validateLyricsOffset(offsetMs: number): void {
  if (!Number.isInteger(offsetMs) || offsetMs < -10000 || offsetMs > 10000 || offsetMs % 50 !== 0) {
    throw new Error('Lyrics offset must be an integer from -10000 to 10000 in 50 ms steps.')
  }
}

/** Apply only to source lyrics, once per source/offset change; never rewrite the source model. */
export function applyLyricsOffset(lyrics: Lyrics, offsetMs: number): Lyrics {
  validateLyricsOffset(offsetMs)
  if (offsetMs === 0) return lyrics
  const shift = (time: number): number => Math.max(0, time + offsetMs)
  return {
    ...lyrics,
    lines: lyrics.lines.map(line => ({
      ...line, startMs: shift(line.startMs), endMs: shift(line.endMs),
      words: line.words.map(word => ({ ...word, startMs: shift(word.startMs), endMs: shift(word.endMs) }))
    }))
  }
}

/** 优先级就是契约 §4.4 的第 1 顺位：手选关联 > 同名文件 > 文件内嵌标签。 */
export function selectLyricsSource(
  attached: LyricsSourceResult | null, sidecar: LyricsSourceResult | null, embedded: LyricsSourceResult | null = null
): LyricsSourceResult | null {
  return attached ?? sidecar ?? embedded
}

// ── 在线取词的公共类型（主进程产出、渲染层消费，所以放 shared）──

export type OnlineProvider = 'amll-ttml' | 'netease' | 'lrclib'

/** 命中的是哪个条目、凭什么判它是这首歌。用户要能核对，所以理由随结果一起走。 */
export interface OnlineMatch {
  provider: OnlineProvider
  title: string
  artist: string
  album?: string
  durationMs?: number
  ncmId?: string
  score: number
  risk: 'low' | 'medium' | 'high'
  reasons: string[]
}

export interface OnlineLyricsLoadResult {
  lyrics: Lyrics
  match: OnlineMatch
  /** 该曲目的歌词偏移（在线歌词同样要跟着偏移走） */
  offsetMs: number
  /** true = 直接来自本地缓存，这次没有联网 */
  cached: boolean
  fetchedAt: number
}

/**
 * 'blocked'     = 平台风控（-460），已停止该平台全部请求
 * 'unavailable' = 网络/接口故障，可重试
 * 'instrumental'= 确认是纯音乐（无人声）。这不是失败，是结论，别再去别处找。
 */
export interface OnlineLyricsOutcome {
  status: 'found' | 'none' | 'instrumental' | 'unavailable' | 'blocked'
  result?: OnlineLyricsLoadResult
  message?: string
}

export interface LyricsTrackInput {
  trackId?: string
  title?: string
  artist?: string
  album?: string
  durationMs?: number
  path?: string
}

/** 候选列表的一项：用户看到的就是这些字段，够他判断「是不是这一版」。 */
export interface LyricCandidateChoice {
  id: string
  title: string
  artist: string
  album?: string
  durationMs?: number
  score: number
  risk: 'low' | 'medium' | 'high'
  reasons: string[]
}
