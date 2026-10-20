import type { LyricLine, LyricWord } from './protocol'

/**
 * LRC → CONTRACT §4.3 Lyrics 行结构。
 * 支持：多时间戳行、元数据头、两种字级标注、同时间戳翻译行（按时间戳配对，不按行号）、offset。
 *
 * 字级标注两种（QueMusic LocalLyricsReader.extractWordLabels 的形状，Apache-2.0）：
 *  - 增强 LRC：<mm:ss.xx>          —— 绝对时间
 *  - KRC 风格：<offset,duration,0> —— 相对行起点的偏移与时长（毫秒）
 * 同一行混用两种时以先出现的风格为准（绝不允许混着解释）。
 *
 * 诚实标注（CONTRACT §4.3）：只有原生字级标注才 wordByWord=true；
 * 无标注的行级数据保持 false，绝不插值伪装（SYLT 重建将来也归 false，source 细分）。
 */
interface RawLine {
  startMs: number
  text: string
  words: LyricWord[]
  hasWordTags: boolean
  translation?: string
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const KRC_WORD_TAG = /<(\d{1,6}),(\d{1,6}),(\d{1,2})>/g
const META_TAG = /^\[(ti|ar|al|by|offset|re|ve):(.*)\]$/i

function toMs(min: string, sec: string, frac?: string): number {
  const f = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0
  return Number(min) * 60000 + Number(sec) * 1000 + f
}

export function parseLrc(text: string): { lines: LyricLine[]; wordByWord: boolean } {
  const meta: Record<string, string> = {}
  const raw: RawLine[] = []

  for (const original of text.split(/\r\n|\n|\r/)) {
    if (!original.trim()) continue
    TIME_TAG.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let lastEnd = 0
    while ((m = TIME_TAG.exec(original)) !== null) {
      stamps.push(toMs(m[1]!, m[2]!, m[3]))
      lastEnd = TIME_TAG.lastIndex
    }
    if (stamps.length === 0) {
      const metaMatch = original.match(META_TAG)
      if (metaMatch) meta[metaMatch[1]!.toLowerCase()] = metaMatch[2]!.trim()
      continue
    }
    const content = original.slice(lastEnd)

    // ── 字级标注解析（同一行只认一种风格）──
    const words: LyricWord[] = []
    let hasWordTags = false

    WORD_TAG.lastIndex = 0
    const enhMarks: { startMs: number; from: number; to: number }[] = []
    let w: RegExpExecArray | null
    while ((w = WORD_TAG.exec(content)) !== null) {
      enhMarks.push({ startMs: toMs(w[1]!, w[2]!, w[3]), from: w.index, to: w.index + w[0].length })
    }

    KRC_WORD_TAG.lastIndex = 0
    const krcMarks: { offsetMs: number; durationMs: number; from: number; to: number }[] = []
    let k: RegExpExecArray | null
    while ((k = KRC_WORD_TAG.exec(content)) !== null) {
      krcMarks.push({ offsetMs: Number(k[1]), durationMs: Number(k[2]), from: k.index, to: k.index + k[0].length })
    }

    // 两种都出现时：取标注数多的那种（另一种按普通文本剥离）
    const useEnh = enhMarks.length > 0 && enhMarks.length >= krcMarks.length
    const useKrc = krcMarks.length > 0 && krcMarks.length > enhMarks.length
    const activeTag = useEnh ? WORD_TAG : useKrc ? KRC_WORD_TAG : null

    // 段内文字**原样保留空格**，只裁整行的首尾空白。
    //
    // 曾经这里对每段都 .trim()，于是「标签前的那个空格」被当作噪声删掉：
    // "…增强LRC<00:35.80> word" 渲染成 "增强LRCword"，中文段落看着还凑合，
    // 中英混排就直接把单词粘在一起了。空格是歌词排版的一部分，不是噪声。
    // 于是空格留在前一个词的字形里 —— 它本来就在时间轴的同一段（前词一直唱到下一个
    // 标签开始），所以宽度与时间都对得上。
    const takeSegment = (from: number, to: number, strip: RegExp, isFirst: boolean, isLast: boolean): string => {
      let text = content.slice(from, to).replace(strip, '')
      if (isFirst) text = text.replace(/^\s+/, '')
      if (isLast) text = text.replace(/\s+$/, '')
      return text
    }

    if (useEnh) {
      hasWordTags = true
      for (let i = 0; i < enhMarks.length; i++) {
        const segEnd = i + 1 < enhMarks.length ? enhMarks[i + 1]!.from : content.length
        const segText = takeSegment(enhMarks[i]!.to, segEnd, KRC_WORD_TAG, i === 0, i === enhMarks.length - 1)
        if (!segText) continue
        // 纯空白的段不新造一个没有宽度的词，并入前一个词保住那个空格。
        if (!segText.trim()) {
          const prev = words[words.length - 1]
          if (prev) prev.text += segText
          continue
        }
        words.push({ text: segText, startMs: enhMarks[i]!.startMs, endMs: enhMarks[i]!.startMs })
      }
    } else if (useKrc) {
      hasWordTags = true
      const lineStartMs = stamps[0] ?? 0
      for (let i = 0; i < krcMarks.length; i++) {
        const segEnd = i + 1 < krcMarks.length ? krcMarks[i + 1]!.from : content.length
        const segText = takeSegment(krcMarks[i]!.to, segEnd, WORD_TAG, i === 0, i === krcMarks.length - 1)
        if (!segText) continue
        if (!segText.trim()) {
          const prev = words[words.length - 1]
          if (prev) prev.text += segText
          continue
        }
        words.push({
          text: segText,
          startMs: lineStartMs + krcMarks[i]!.offsetMs,
          endMs: lineStartMs + krcMarks[i]!.offsetMs + krcMarks[i]!.durationMs
        })
      }
    }

    const plain = activeTag ? content.replace(activeTag, '').trim() : content.trim()
    if (!plain && words.length === 0) continue
    for (const startMs of stamps) {
      raw.push({ startMs, text: plain, words: words.map((x) => ({ ...x })), hasWordTags })
    }
  }

  const offsetMs = meta['offset'] ? Number(meta['offset']) || 0 : 0
  if (offsetMs !== 0) {
    for (const r of raw) {
      r.startMs = Math.max(0, r.startMs - offsetMs)
      for (const wd of r.words) {
        wd.startMs = Math.max(0, wd.startMs - offsetMs)
        wd.endMs = Math.max(0, wd.endMs - offsetMs)
      }
    }
  }

  // 同一时间戳多行 → 第一行原文，后续行按时间戳配对为翻译（不按行号）
  raw.sort((a, b) => a.startMs - b.startMs)
  const merged: RawLine[] = []
  for (const r of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.startMs === r.startMs) {
      if (!prev.translation && r.text && r.text !== prev.text) prev.translation = r.text
      continue
    }
    merged.push(r)
  }

  const lines: LyricLine[] = merged.map((r, i) => {
    const next = merged[i + 1]
    const endMs = next ? next.startMs : r.startMs + 5000
    const wordEnds = r.words.map((wd, j) => ({
      ...wd,
      endMs: j + 1 < r.words.length ? r.words[j + 1]!.startMs : Math.max(wd.endMs, endMs)
    }))
    const line: LyricLine = {
      startMs: r.startMs,
      endMs,
      words: wordEnds,
      text: r.text || r.words.map((x) => x.text).join('')
    }
    if (r.translation && r.translation !== line.text) line.translation = r.translation
    return line
  })

  const wordByWord = lines.length > 0 && merged.every((r) => r.hasWordTags && r.words.length > 0)
  return { lines, wordByWord }
}
