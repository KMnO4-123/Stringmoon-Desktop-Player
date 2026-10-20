import type { Lyrics } from './protocol'

/**
 * Lyrics → AMLL TTML 文本（可被 parseTtml 原样读回来）。
 *
 * 为什么保存成 TTML 而不是 LRC：
 *  **LRC 装不下这份数据**。我们的模型每行有翻译**和**罗马音，而 LRC 只能用「同一时间戳再来一行」
 *  表达一种附加轨 —— 第二行是翻译，第三行就无处可放（解析器会把同一时间戳的后续行当重复丢掉）。
 *  也就是说 LRC 会**静默丢掉罗马音**，而那正是日文歌最需要的东西。TTML 有 x-translation / x-roman
 *  两个独立角色，还能保住逐字时间与注音（ruby），并且它本来就是 §4.4 的第一顺位格式。
 *
 * 这份文本是给**用户可读可改**的文件，所以：一个 `<p>` 一行、不折叠换行、不输出无关样式。
 */

export interface TtmlMeta {
  musicName?: string
  artists?: string
  album?: string
  ncmId?: string
  /** 记录这份歌词是哪来的（自定义 key，AMLL 允许自定义元数据） */
  origin?: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** mm:ss.SSS —— 我们的解析器接受 1–3 段冒号，这里固定两段，毫秒三位不丢精度。 */
export function formatTtmlTime(ms: number): string {
  // NaN 会穿过 Math.max（比较永远为 false），所以必须先挡住它，否则写出 "NaN:NaN.NaN"。
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const millis = total % 1000
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + String(millis).padStart(3, '0')
}

function metaTag(key: string, value: string | undefined): string {
  if (!value) return ''
  return '<amll:meta key="' + escapeXml(key) + '" value="' + escapeXml(value) + '"/>'
}

/** 注音音节：规范要求 base 不带时间，时间挂在 tts:ruby="text" 上。 */
function rubySpan(text: string, ruby: string, startMs: number, endMs: number): string {
  return '<span tts:ruby="container"><span tts:ruby="base">' + escapeXml(text) + '</span><span tts:ruby="textContainer"><span tts:ruby="text" begin="'
    + formatTtmlTime(startMs) + '" end="' + formatTtmlTime(endMs) + '">' + escapeXml(ruby) + '</span></span></span>'
}

export function serializeTtml(lyrics: Lyrics, meta: TtmlMeta = {}): string {
  const authoring = lyrics.wordByWord ? 'Word' : 'Line'
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" xmlns:amll="http://www.example.com/ns/amll" itunes:timing="' + authoring + '">',
    '<head><metadata>',
    metaTag('musicName', meta.musicName),
    metaTag('artists', meta.artists),
    metaTag('album', meta.album),
    metaTag('ncmMusicId', meta.ncmId),
    metaTag('stringmoonOrigin', meta.origin),
    metaTag('stringmoonSource', lyrics.source),
    '</metadata></head>'
  ].filter(Boolean).join('\n')

  const body = lyrics.lines.map((line, index) => {
    const key = 'L' + (index + 1)
    const inner: string[] = []
    if (line.words.length > 0) {
      for (const word of line.words) {
        if (word.ruby) inner.push(rubySpan(word.text, word.ruby, word.startMs, word.endMs))
        else inner.push('<span begin="' + formatTtmlTime(word.startMs) + '" end="' + formatTtmlTime(word.endMs) + '">' + escapeXml(word.text) + '</span>')
      }
    } else {
      inner.push(escapeXml(line.text))
    }
    if (line.translation) inner.push('<span ttm:role="x-translation" xml:lang="zh-Hans">' + escapeXml(line.translation) + '</span>')
    if (line.romanization) inner.push('<span ttm:role="x-roman" xml:lang="ja-Latn">' + escapeXml(line.romanization) + '</span>')
    // 背景人声：整行都是背景时用 x-bg 包起来，解析回来就还是 background:true。
    const content = line.background ? '<span ttm:role="x-bg">' + inner.join('') + '</span>' : inner.join('')
    return '<p begin="' + formatTtmlTime(line.startMs) + '" end="' + formatTtmlTime(line.endMs) + '" itunes:key="' + key + '">' + content + '</p>'
  }).join('\n')

  const lastEnd = lyrics.lines.reduce((max, line) => Math.max(max, line.endMs), 0)
  const firstStart = lyrics.lines.reduce((min, line) => Math.min(min, line.startMs), Number.POSITIVE_INFINITY)
  const tail = [
    '<body dur="' + formatTtmlTime(lastEnd) + '">',
    '<div begin="' + formatTtmlTime(Number.isFinite(firstStart) ? firstStart : 0) + '" end="' + formatTtmlTime(lastEnd) + '">',
    body,
    '</div></body></tt>',
    ''
  ].join('\n')
  return head + '\n' + tail
}
