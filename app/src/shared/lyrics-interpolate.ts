import type { LyricLine, Lyrics, LyricWord } from './protocol'

/**
 * 行级歌词的填充插值（CONTRACT §4.3「插值兜底」）。
 *
 * 为什么必须做：实测这个曲库里 12 首拿到歌词的歌有 11 首是**行级**（网易云/LRCLIB 只给每行
 * 一个时间点）。行级数据没有字级时间，逐字填充就完全不亮 —— 而这个播放器的歌词体验
 * 恰恰主要靠那条逐渐亮起的填充。不做插值，绝大多数歌永远是「整行变色」。
 *
 * 契约红线（§4.3 原文）：插值**必须如实标注** —— 所以 `wordByWord` 永远是**数据源的事实**，
 * 这里一个字节都不改它；「这一行是插出来的」由调用方从「有 words 但 wordByWord=false」推出来。
 * 换句话说：插值只发生在**渲染视图**里，缓存与 IPC 上的模型保持源样。
 *
 * 两个刻意的取舍：
 *  1. **CJK 按字素、拉丁按词**。字素簇而不是码点：拗音（きゃ）、emoji、组合音标按码点切会在
 *     字形中间断开（M3 方案 §5.2 已经为逐字填充定过这条）。
 *  2. **按字符数加权**，不是等分。同一个时间窗里「無敵の笑顔で」不该和「あ」分一样长。
 */

/** 假名 / 汉字 / 谚文。出现就按字素切（日文句子里夹英文词也照样按字）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
/** 时间窗太短就不插：200 ms 分不出任何可读的进度，只会闪。 */
const MIN_SPAN_MS = 200

interface Unit { text: string; weight: number }

type SegmenterLike = new (locale?: string, options?: { granularity: string }) => {
  segment(input: string): Iterable<{ segment: string }>
}

function graphemeOrWord(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter
  if (!Segmenter) return Array.from(text)
  const segmenter = new Segmenter(undefined, { granularity: CJK.test(text) ? 'grapheme' : 'word' })
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

/** 会被「唱出来」的字符：字、数字。空白与标点不被唱，所以不占演唱时间。 */
const SINGING = /[\p{L}\p{N}]/u

function unitsOf(text: string): Unit[] {
  const units: Unit[] = []
  let pending = ''
  for (const segment of graphemeOrWord(text)) {
    if (!segment) continue
    // 纯空白/标点并进前一段：它们不被唱，不该分走一份时间；但字形必须留下来，
    // 否则「words 拼起来 === 行文本」这条渲染不变式就断了。
    // 行首的这种字符先存着，等第一个词出现再挂上去。
    if (!SINGING.test(segment)) {
      if (units.length > 0) units[units.length - 1]!.text += segment
      else pending += segment
      continue
    }
    const weight = Array.from(segment.replace(/[^\p{L}\p{N}]/gu, '')).length
    units.push({ text: pending + segment, weight: Math.max(1, weight) })
    pending = ''
  }
  return units
}

/** 单行的词级时间。已经有词级数据就原样返回 —— 绝不覆盖数据源的真实时间。 */
export function interpolateLine(line: LyricLine): LyricWord[] {
  if (line.words.length > 0) return line.words
  const text = line.text
  if (!text) return []
  const span = line.endMs - line.startMs
  if (!Number.isFinite(span) || span < MIN_SPAN_MS) return []
  const units = unitsOf(text)
  if (units.length === 0) return []
  const total = units.reduce((sum, unit) => sum + unit.weight, 0) || units.length
  const words: LyricWord[] = []
  let accumulated = 0
  for (const unit of units) {
    const startMs = line.startMs + Math.round(span * accumulated / total)
    accumulated += unit.weight
    const endMs = line.startMs + Math.round(span * accumulated / total)
    words.push({ text: unit.text, startMs, endMs })
  }
  const last = words[words.length - 1]!
  last.endMs = Math.max(last.startMs, line.endMs)
  return words
}

export interface DisplayLyrics {
  lyrics: Lyrics
  /** true = 至少有一行是插出来的（界面据此标注「行级·插值」，不冒充逐字源） */
  interpolated: boolean
}

/** 渲染视图：给没有字级时间的行补上插值时间。**不修改** wordByWord/source。 */
export function withInterpolatedWords(lyrics: Lyrics): DisplayLyrics {
  let interpolated = false
  const lines = lyrics.lines.map((line) => {
    if (line.words.length > 0) return line
    const words = interpolateLine(line)
    if (words.length === 0) return line
    interpolated = true
    return { ...line, words }
  })
  return { lyrics: interpolated ? { ...lyrics, lines } : lyrics, interpolated }
}
