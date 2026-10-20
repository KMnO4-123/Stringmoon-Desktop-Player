/**
 * 内嵌歌词（§4.4 第 1 顺位的另一半：歌词就写在音频文件里）。
 *
 * 为什么放在应用侧而不是引擎：引擎读标签走 taglib，加一个 `LYRICS` 字段意味着改协议、
 * 重建引擎、写 CR；而应用侧本来就有 `music-metadata`（封面已在用）。
 * 实测本机 91 首 FLAC **0 首**带任何歌词标签，所以这件事的唯一正确做法是：
 * 便宜地做掉，不为它动引擎。
 *
 * 只接受**带时间轴**的内嵌歌词（很多 Vorbis 的 LYRICS 值本身就是 LRC 文本）。
 * 没时间轴的内嵌歌词无法驱动高亮，硬塞进来只会得到一行行同时间的字 —— 那就成了伪造同步，
 * 所以宁可不显示。
 */
import { parseLyricsDocument } from '@shared/lyrics-parse'
import type { Lyrics } from '@shared/protocol'

/** 从文件里取出所有候选歌词文本（Vorbis LYRICS/UNSYNCEDLYRICS、ID3 USLT/SYLT…）。 */
export type LyricsTagReader = (file: string) => Promise<string[]>

const defaultReader: LyricsTagReader = async (file) => {
  const { parseFile } = await import('music-metadata')
  const metadata = await parseFile(file, { skipCovers: true })
  const out: string[] = []
  const common = (metadata.common as { lyrics?: unknown }).lyrics
  if (typeof common === 'string') out.push(common)
  else if (Array.isArray(common)) {
    for (const item of common) {
      if (typeof item === 'string') out.push(item)
      else if (item && typeof item === 'object') {
        const record = item as { text?: unknown; syncText?: unknown }
        if (typeof record.text === 'string') out.push(record.text)
        if (Array.isArray(record.syncText)) {
          // SYLT：逐条 { text, timestamp }，拼成 LRC 再交给统一解析器，避免第二套时间模型。
          const lines = (record.syncText as { text?: unknown; timestamp?: unknown }[])
            .filter(entry => typeof entry?.text === 'string' && Number.isFinite(entry?.timestamp))
            .map(entry => stampOf(Number((entry as { timestamp: number }).timestamp)) + String(entry.text))
          if (lines.length > 0) out.push(lines.join('\n'))
        }
      }
    }
  }
  // music-metadata 的 native 在不同版本里是数组或「按容器分组的对象」，两种都认。
  const nativeList = metadata.native as unknown as Array<{ tags?: Array<{ id?: unknown; value?: unknown }> }> | undefined
  for (const tag of Array.isArray(nativeList) ? nativeList : []) {
    for (const entry of tag.tags ?? []) {
      if (!/LYRICS|USLT|SYLT/i.test(String(entry.id))) continue
      if (typeof entry.value === 'string' && entry.value.trim()) out.push(entry.value)
    }
  }
  return out
}

function stampOf(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  const minutes = String(Math.floor(safe / 60000)).padStart(2, '0')
  const seconds = String(Math.floor((safe % 60000) / 1000)).padStart(2, '0')
  const millis = String(safe % 1000).padStart(3, '0')
  return '[' + minutes + ':' + seconds + '.' + millis + ']'
}

let reader: LyricsTagReader | null = null

export function configureEmbeddedLyrics(next: LyricsTagReader | null): void {
  reader = next
}

/** 读内嵌歌词；能解析出时间轴才算数。任何失败都当作「没有」，不打断本地优先链。 */
export async function readEmbeddedLyrics(file: string): Promise<Lyrics | null> {
  let texts: string[]
  try {
    texts = await (reader ?? defaultReader)(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[lyrics] embedded tag read failed', error)
    return null
  }
  for (const text of texts) {
    if (!text || !text.trim()) continue
    const parsed = parseLyricsDocument(text)
    if (!parsed || parsed.lines.length === 0) continue
    return { lines: parsed.lines, wordByWord: parsed.wordByWord, source: 'embedded' }
  }
  return null
}
