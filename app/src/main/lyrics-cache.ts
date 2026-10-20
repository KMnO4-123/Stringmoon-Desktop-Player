/**
 * 在线歌词缓存（主进程持久化）。
 *
 * 三件事必须记住，否则「播放时自动查一次」会变成「每播一次查一次」：
 *  1. **命中**：歌词本身。网络不该是播放的一部分，第二次播放必须是纯本地的。
 *  2. **未命中**：查过了、没有。不记的话，一首没有歌词的歌每次播放都要重新走
 *     网易云搜索 + AMLL + LRCLIB 四五个请求 —— 那正是契约 §5 禁止的批量拉取。
 *  3. **它是谁的**：命中的是哪一首（歌名/艺人/时长/命中理由），用户要能核对。
 *     「找不到歌词」是可接受的；「悄悄换成了别人的歌词」不可接受。
 *
 * 未命中记录有有效期（默认 7 天）：后来库里有新歌了，不该永远判它死刑。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { libraryPathKey } from '@shared/library'
import type { Lyrics } from '@shared/protocol'
import type { OnlineMatch } from './lyrics-online'

export interface OnlineCacheEntry {
  lyrics: Lyrics | null
  match?: OnlineMatch
  fetchedAt: number
  /** 没有歌词时为什么没有：'instrumental' 是一条结论，不该每次播放都重新问一遍。 */
  reason?: 'instrumental' | 'not-found'
  /** true = 用户从候选里亲手选的（不是自动计分的结果）。 */
  pinned?: boolean
}

const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 每条缓存是一份完整歌词（约 10–40 KB JSON），所以按条数封顶，别让这个文件无界增长。 */
const MAX_ENTRIES = 400

let cacheFile: string | null = null
let entries = new Map<string, OnlineCacheEntry>()
let generation = 0
let ready: Promise<void> = Promise.resolve()
let writing: Promise<unknown> = Promise.resolve()

export function configureLyricsCache(file: string): void {
  cacheFile = file
  entries = new Map()
  const current = ++generation
  ready = readFile(file, 'utf8')
    .then((text) => {
      if (current !== generation) return
      const saved: unknown = JSON.parse(text)
      if (!saved || typeof saved !== 'object') return
      const stored = (saved as { entries?: unknown }).entries
      if (!stored || typeof stored !== 'object') return
      for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const record = value as Record<string, unknown>
        const fetchedAt = Number(record.fetchedAt)
        if (!Number.isFinite(fetchedAt)) continue
        const lyrics = record.lyrics && typeof record.lyrics === 'object' ? record.lyrics as Lyrics : null
        if (lyrics && (!Array.isArray(lyrics.lines) || lyrics.lines.length === 0)) continue
        entries.set(key, {
          lyrics,
          ...(record.match && typeof record.match === 'object' ? { match: record.match as OnlineMatch } : {}),
          fetchedAt,
          ...(record.reason === 'instrumental' || record.reason === 'not-found' ? { reason: record.reason } : {}),
          ...(record.pinned === true ? { pinned: true } : {})
        })
      }
    })
    .catch(() => {
      /* 首次运行没有这个文件；损坏按「没有缓存」处理，不阻断启动。 */
    })
}

async function persist(): Promise<void> {
  if (!cacheFile) return
  const file = cacheFile
  const payload = { version: 1, entries: Object.fromEntries(entries) }
  const write = writing.then(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(payload), 'utf8')
    await rename(file + '.tmp', file)
  })
  writing = write.catch(() => undefined)
  await write
}

function trim(): void {
  if (entries.size <= MAX_ENTRIES) return
  const ordered = [...entries.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
  for (const [key] of ordered.slice(0, entries.size - MAX_ENTRIES)) entries.delete(key)
}

/** 命中返回歌词；未命中记录在有效期内返回 null 但 `known` 为 true（调用方据此跳过联网）。 */
export async function readOnlineCache(trackKey: string, now: number): Promise<{ known: boolean; entry?: OnlineCacheEntry }> {
  await ready
  const entry = entries.get(trackKey)
  if (!entry) return { known: false }
  if (entry.lyrics) return { known: true, entry }
  if (now - entry.fetchedAt <= MISS_TTL_MS) return { known: true, entry }
  entries.delete(trackKey)
  return { known: false }
}

export async function writeOnlineCache(
  trackKey: string,
  lyrics: Lyrics | null,
  match: OnlineMatch | undefined,
  now: number,
  reason?: OnlineCacheEntry['reason'],
  pinned?: boolean
): Promise<void> {
  await ready
  if (!trackKey) return
  entries.delete(trackKey)
  entries.set(trackKey, { lyrics, ...(match ? { match } : {}), fetchedAt: now, ...(reason ? { reason } : {}), ...(pinned ? { pinned } : {}) })
  trim()
  await persist()
}

export async function forgetOnlineCache(audioPath: string): Promise<void> {
  await ready
  entries.delete(libraryPathKey(audioPath))
  await persist()
}

export async function clearOnlineCache(): Promise<void> {
  await ready
  entries = new Map()
  await persist()
}
