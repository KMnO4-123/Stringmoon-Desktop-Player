import type { LyricLine } from './protocol'
import type { ParsedTimedLyrics } from './yrc'
import { parseLrc } from './lrc'
import { parseYrc } from './yrc'

/**
 * 网易云行级歌词 → CONTRACT §4.3。
 *
 * 一次请求拿回三轨（契约 §4.4 第 3 顺位，`/api/song/lyric?id=…&lv=-1&tv=-1&rv=-1`）：
 *   lrc       原文
 *   tlyric    中文翻译
 *   romalrc   罗马音（日文曲的注音就是它）
 *
 * 三轨是各自独立的 LRC，按**时间戳**配对而不是按行号 —— 这是 REFS-B-app 记下的既有做法，
 * 也是唯一稳的做法：翻译轨可能少一行、多一行或整体偏移，按行号配会把译文错到别的句子上。
 *
 * 该接口**不返回 yrc**（实测 `/song/lyric`、`/song/lyric/v1` 都没有 yrc 字段），
 * 所以这里恒为行级、wordByWord=false —— 逐字只能靠 AMLL TTML DB。不要在这里假装有逐字。
 */

export interface NeteaseLyricPayload {
  lrc?: string
  tlyric?: string
  romalrc?: string
}

const CREDIT = /^(作词|作曲|编曲|制作人|混音|母带|录音|监制|出品|词|曲|和声|吉他|贝斯|鼓)\s*[:：]/
/** 翻译/罗马音与原文允许的时间戳误差。超出就不配 —— 宁可没有译文，也不要把译文错到别的句子。 */
const PAIR_TOLERANCE_MS = 400

interface TimedText { startMs: number; text: string }

/** 新版接口在 `cp=false` 时把 lrc 变成逐行 JSON：{"t":0,"c":[{"tx":"…"}]} */
function richJsonLines(text: string): TimedText[] {
  const out: TimedText[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      const value = JSON.parse(line) as { t?: unknown; c?: unknown }
      const startMs = Number(value.t)
      if (!Number.isFinite(startMs)) continue
      const cells = Array.isArray(value.c) ? value.c : []
      const body = cells
        .map((cell) => (cell && typeof cell === 'object' ? String((cell as { tx?: unknown }).tx ?? '') : ''))
        .join('')
      if (body) out.push({ startMs: Math.max(0, Math.round(startMs)), text: body })
    } catch {
      // 单行坏掉不该毁掉整份歌词：跳过它，其余照常。
    }
  }
  return out
}

function timedTexts(text: string | undefined): TimedText[] {
  if (!text || !text.trim()) return []
  if (text.trimStart().startsWith('{')) return richJsonLines(text)
  return parseLrc(text).lines.map(line => ({ startMs: line.startMs, text: line.text }))
}

function nearest(map: Map<number, string>, startMs: number): string | undefined {
  const exact = map.get(startMs)
  if (exact != null) return exact
  let best: string | undefined
  let bestDistance = PAIR_TOLERANCE_MS + 1
  for (const [at, value] of map) {
    const distance = Math.abs(at - startMs)
    if (distance < bestDistance) { bestDistance = distance; best = value }
  }
  return bestDistance <= PAIR_TOLERANCE_MS ? best : undefined
}

function toMap(texts: TimedText[]): Map<number, string> {
  const map = new Map<number, string>()
  for (const item of texts) {
    const value = item.text.trim()
    if (value && !map.has(item.startMs)) map.set(item.startMs, value)
  }
  return map
}

export function neteaseLyrics(payload: NeteaseLyricPayload): { lines: LyricLine[] } | null {
  const base = timedTexts(payload.lrc)
  if (base.length === 0) return null
  const translations = toMap(timedTexts(payload.tlyric))
  const romanizations = toMap(timedTexts(payload.romalrc))

  // 开头的「作词/作曲/编曲」制作名单不是歌词。只在最前面剥，中间出现的同名句保留。
  let first = 0
  while (first < base.length && CREDIT.test((base[first]!.text ?? '').trim())) first++
  const rows = base.slice(first).filter(row => row.text.trim().length > 0)
  if (rows.length === 0) return null
  rows.sort((a, b) => a.startMs - b.startMs)

  const lines: LyricLine[] = rows.map((row, index) => {
    const next = rows[index + 1]
    const endMs = next ? next.startMs : row.startMs + 5000
    const text = row.text.trim()
    const line: LyricLine = { startMs: row.startMs, endMs, words: [], text }
    const translation = nearest(translations, row.startMs)
    if (translation && translation !== text) line.translation = translation
    const romanization = nearest(romanizations, row.startMs)
    if (romanization && romanization !== text) line.romanization = romanization
    return line
  })
  return { lines }
}

/**
 * 网易云对「没有歌词的歌」不是返回空，而是返回一句占位文本。实测见过两种：
 *   [00:00.00]暂无歌词            —— 曲库没有这首的歌词
 *   [00:00.00]纯音乐，请欣赏       —— 这首是纯音乐（BGM/配乐），本来就没有人声
 * 两者都不是歌词。把占位符当歌词显示，用户会以为播放器坏了。
 */
const PLACEHOLDER = /^(暂无歌词|纯音乐[，,。！!\s]*请欣赏|此歌曲为没有填词的纯音乐.*|纯音乐.*|该歌曲无歌词|instrumental|no ?lyrics)$/i

export function classifyNeteasePlaceholder(lines: { text: string }[]): 'instrumental' | 'none' | null {
  const texts = lines.map(line => line.text.trim()).filter(Boolean)
  if (texts.length === 0) return 'none'
  if (!texts.every(text => PLACEHOLDER.test(text))) return null
  return texts.some(text => /纯音乐|instrumental/i.test(text)) ? 'instrumental' : 'none'
}

/**
 * 网易云 **字级** 歌词（yrc）→ §4.3。
 *
 * 与行级的区别只有一处：`words` 里真的有每个字的时间（来自 yrc），所以 `wordByWord=true`。
 * 翻译/罗马音仍然来自 `tlyric`/`romalrc`（行级），按时间戳配到 yrc 的行上 ——
 * 实测 yrc 的行起点与 lrc 的行起点差几十毫秒（21110 vs 21056），所以配对必须有容差。
 */
export function neteaseYrcLyrics(payload: {
  yrc?: string
  tlyric?: string
  romalrc?: string
  ytlrc?: string
  yromalrc?: string
}): ParsedTimedLyrics | null {
  const yrc = payload.yrc
  if (!yrc || !yrc.trim()) return null
  const parsed = parseYrc(yrc)
  if (!parsed) return null
  const translations = toMap(timedTexts(payload.ytlrc ?? payload.tlyric))
  const romanizations = toMap(timedTexts(payload.yromalrc ?? payload.romalrc))

  let first = 0
  while (first < parsed.lines.length && CREDIT.test(parsed.lines[first]!.text.trim())) first++
  const rows = parsed.lines.slice(first)
  const lines: LyricLine[] = rows.map((line) => {
    const translation = nearest(translations, line.startMs)
    const romanization = nearest(romanizations, line.startMs)
    const next: LyricLine = { ...line }
    if (translation && translation !== line.text) next.translation = translation
    if (romanization && romanization !== line.text) next.romanization = romanization
    return next
  })
  if (lines.length === 0) return null
  return { lines, wordByWord: lines.every(line => line.words.length > 0) }
}
