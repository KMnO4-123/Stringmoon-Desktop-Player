import type { LyricLine, LyricWord } from './protocol'

/**
 * 网易云 YRC → CONTRACT §4.3 行结构（契约 §4.4 第 3 顺位）。
 *
 *   [行起点,行时长](字起点,字时长,0)字(字起点,字时长,0)字
 *
 * ⚠️ **字偏移是绝对毫秒，不是相对行首**。这一条是拿真实数据验出来的，不是从格式说明读出来的：
 *     yrc: [21110,1660](21110,370,0)简
 *     lrc: [00:21.056]简单点          ← 同一个位置
 *   如果按「行首 + 偏移」理解，第一个字会落到 42220 ms —— 比这一行自己结束（22770）还晚，
 *   明显荒谬。第一版就是那么写的，因为契约文字里的「字起点」可以两读。
 *
 * 但仍有相对偏移的方言（同一套格式，不同产出工具）。所以这里做成**数据自证**：
 * 先按绝对解释，如果解析出来的字整条落在本行区间之外、而相对解释落在区间之内，就改用相对。
 * 两种都不像（比如整行没有时间）就退回行级，绝不硬塞一个时间。
 */
const LINE = /^\[(\d{1,9}),(\d{1,9})\](.*)$/
const SYLLABLE = /\((\d{1,9}),(\d{1,9}),(\d{1,9})\)/g
/** 判断「落在行内」时给两端的余量：时间戳取整与人为微调都会差几十毫秒。 */
const WINDOW_SLACK_MS = 150

export interface ParsedTimedLyrics { lines: LyricLine[]; wordByWord: boolean }

interface Mark { offsetMs: number; durationMs: number; from: number; to: number }

function wordsOf(body: string, marks: Mark[], base: 'absolute' | 'relative', lineStart: number): LyricWord[] {
  const words: LyricWord[] = []
  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index]!
    const stop = index + 1 < marks.length ? marks[index + 1]!.from : body.length
    const text = body.slice(mark.to, stop)
    if (!text) continue
    const start = base === 'absolute' ? mark.offsetMs : lineStart + mark.offsetMs
    words.push({ text, startMs: Math.max(0, start), endMs: Math.max(0, start + mark.durationMs) })
  }
  return words
}

function fits(words: LyricWord[], lineStart: number, lineDuration: number): boolean {
  if (words.length === 0) return false
  const end = lineStart + lineDuration
  return words.every(word => word.startMs >= lineStart - WINDOW_SLACK_MS && word.startMs <= end + WINDOW_SLACK_MS)
}

export function parseYrc(text: string): ParsedTimedLyrics | null {
  const rows: { startMs: number; words: LyricWord[] }[] = []
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim()
    if (!line) continue
    const match = LINE.exec(line)
    if (!match) continue
    const lineStart = Number(match[1])
    const lineDuration = Number(match[2])
    const body = match[3] ?? ''
    if (!body) continue
    SYLLABLE.lastIndex = 0
    const marks: Mark[] = []
    let mark: RegExpExecArray | null
    while ((mark = SYLLABLE.exec(body)) !== null) {
      marks.push({ offsetMs: Number(mark[1]), durationMs: Number(mark[2]), from: mark.index, to: mark.index + mark[0].length })
    }
    if (marks.length === 0) {
      rows.push({ startMs: lineStart, words: [] })
      continue
    }
    // 数据自证：先绝对，落不进本行区间再试相对。
    const absolute = wordsOf(body, marks, 'absolute', lineStart)
    const relative = wordsOf(body, marks, 'relative', lineStart)
    const words = fits(absolute, lineStart, lineDuration) || !fits(relative, lineStart, lineDuration)
      ? absolute
      : relative
    rows.push({ startMs: lineStart, words })
  }
  if (rows.length === 0) return null
  rows.sort((a, b) => a.startMs - b.startMs)
  const lines: LyricLine[] = rows.map((row, index) => {
    const next = rows[index + 1]
    const endMs = next ? next.startMs : row.startMs + 5000
    const words = row.words.map((word, wordIndex) => {
      const following = row.words[wordIndex + 1]
      const stop = word.endMs > word.startMs
        ? word.endMs
        : following ? Math.max(word.startMs, following.startMs) : Math.max(word.startMs, endMs)
      return { ...word, endMs: stop }
    })
    const text = words.map(word => word.text).join('').trim()
    return { startMs: row.startMs, endMs, words, text }
  }).filter(line => line.text.length > 0)
  if (lines.length === 0) return null
  return { lines, wordByWord: lines.every(line => line.words.length > 0) }
}
