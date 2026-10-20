import type { LyricLine, Lyrics } from './protocol'
import { parseLrc } from './lrc'
import { parseTtml } from './ttml'
import { parseYrc } from './yrc'

/**
 * 一个入口，按内容判断格式，再交给对应解析器。
 *
 * 不按扩展名判断：`.yrc` 里装 LRC、`.ttml` 被另存成 `.txt` 都是真实会发生的事，
 * 而内容自己是诚实的。扩展名只决定「要不要尝试读这个文件」。
 *（REFS-B2 §8：多解析器 → 一个中间态，别在 lrc.ts 里堆 if。）
 */
export type LyricsFormat = 'ttml' | 'yrc' | 'lrc'

export interface ParsedLyrics {
  lines: LyricLine[]
  wordByWord: boolean
  format: LyricsFormat
}

const TTML_HEAD = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<tt[\s>]/i
const YRC_LINE = /^\s*\[\d{1,9},\d{1,9}\]/m

export function detectLyricsFormat(text: string): LyricsFormat {
  if (TTML_HEAD.test(text)) return 'ttml'
  if (YRC_LINE.test(text)) return 'yrc'
  return 'lrc'
}

export function parseLyricsDocument(text: string): ParsedLyrics | null {
  if (!text || !text.trim()) return null
  switch (detectLyricsFormat(text)) {
    case 'ttml': {
      const parsed = parseTtml(text)
      return parsed ? { lines: parsed.lines, wordByWord: parsed.wordByWord, format: 'ttml' } : null
    }
    case 'yrc': {
      const parsed = parseYrc(text)
      return parsed ? { lines: parsed.lines, wordByWord: parsed.wordByWord, format: 'yrc' } : null
    }
    default: {
      const parsed = parseLrc(text)
      return parsed.lines.length > 0 ? { lines: parsed.lines, wordByWord: parsed.wordByWord, format: 'lrc' } : null
    }
  }
}

/** 归一化后的歌词 + 它来自哪种文件，一起交给上层决定 label 与 source。 */
export function lyricsFromDocument(text: string, source: Lyrics['source']): Lyrics | null {
  const parsed = parseLyricsDocument(text)
  if (!parsed) return null
  return { lines: parsed.lines, wordByWord: parsed.wordByWord, source }
}
