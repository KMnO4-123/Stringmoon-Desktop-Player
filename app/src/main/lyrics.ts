import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { libraryPathKey } from '@shared/library'
import { parseLyricsDocument } from '@shared/lyrics-parse'
import { selectLyricsSource, validateLyricsOffset } from '@shared/lyrics-model'
import type { LyricsConfig, LyricsLoadResult, LyricsSourceResult } from '@shared/lyrics-model'
import type { Lyrics, Track } from '@shared/protocol'
import { serializeTtml } from '@shared/ttml-write'
import { readEmbeddedLyrics } from './embedded-lyrics'
import { fetchLyricsForCandidate, fetchOnlineLyrics, searchLyricCandidates } from './lyrics-online'
import type { LyricCandidateOption } from './lyrics-online'
import { forgetOnlineCache, readOnlineCache, writeOnlineCache } from './lyrics-cache'
import type { OnlineLyricsLoadResult, OnlineLyricsOutcome, OnlineMatch } from '@shared/lyrics-model'

// The extensions a lyrics sidecar can be attached to. `.oga` is included because
// that is what Ogg Vorbis and Ogg FLAC files conventionally carry, and a sidecar
// `.lrc`/`.ttml` next to one of those is exactly as legitimate as next to a .flac.
const AUDIO_EXT = /\.(flac|wav|mp3|ogg|oga|opus|m4a|ape|wv|aiff?)$/i
/**
 * 能被当作**本地歌词文件**读的扩展名，按优先级排列。
 *
 * 先把 .lrc 试完再试别的，是因为同一首歌旁边同时躺着 .lrc 与 .ttml 时，
 * .lrc 通常是用户自己配好的偏移版本，而 .ttml 多半是整包下载下来的原件。
 * （内容才是权威：哪个装的是哪种格式由 parseLyricsDocument 按内容判，不看扩展名。）
 */
const LYRIC_EXTENSIONS = ['.lrc', '.ttml', '.yrc'] as const
const LYRIC_EXT = /\.(lrc|ttml|yrc)$/i
const MAX_CACHE_ENTRIES = 128
const MAX_CACHE_BYTES = 8 * 1024 * 1024

interface LyricsOptions { fixturePaths?: string[] }
interface CacheEntry { mtimeMs: number; size: number; bytes: number; lyrics: Lyrics }

let configFile: string | null = null
let config: LyricsConfig = { version: 1, tracks: {} }
let configReady: Promise<void> = Promise.resolve()
let configGeneration = 0
let mutationQueue: Promise<unknown> = Promise.resolve()
let fixturePaths: string[] = []
const parsedCache = new Map<string, CacheEntry>()
let cacheBytes = 0

function cloneConfig(value: LyricsConfig): LyricsConfig {
  return { version: 1, tracks: Object.fromEntries(Object.entries(value.tracks).map(([key, item]) => [key, { ...item }])) }
}

function parseDocument(text: string): LyricsConfig {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('Invalid lyrics configuration.')
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !document.tracks || typeof document.tracks !== 'object' || Array.isArray(document.tracks)) {
    throw new Error('Unsupported lyrics configuration.')
  }
  const tracks: LyricsConfig['tracks'] = {}
  for (const [key, value] of Object.entries(document.tracks)) {
    if (!key || !value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    if (!Number.isInteger(item.offsetMs) || Number(item.offsetMs) < -10000 || Number(item.offsetMs) > 10000
      || Number(item.offsetMs) % 50 !== 0) continue
    if (item.attachedPath !== undefined && (typeof item.attachedPath !== 'string' || !path.isAbsolute(item.attachedPath))) continue
    tracks[libraryPathKey(key)] = {
      ...(typeof item.attachedPath === 'string' ? { attachedPath: path.normalize(item.attachedPath) } : {}),
      offsetMs: Number(item.offsetMs)
    }
  }
  return { version: 1, tracks }
}

function clearCache(): void {
  parsedCache.clear()
  cacheBytes = 0
}

export function configureLyrics(file: string, options: LyricsOptions = {}): void {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Lyrics storage path must be absolute.')
  configFile = file
  config = { version: 1, tracks: {} }
  fixturePaths = options.fixturePaths?.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(path.normalize) ?? []
  clearCache()
  const generation = ++configGeneration
  configReady = readFile(file, 'utf8')
    .then(text => { if (generation === configGeneration) config = parseDocument(text) })
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && generation === configGeneration) {
        console.error('[lyrics] invalid configuration; starting empty', error)
      }
      if (generation === configGeneration) config = { version: 1, tracks: {} }
    })
}

function validateAudioPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !AUDIO_EXT.test(value)) {
    throw new Error('Audio path must be an absolute supported audio file path.')
  }
  return path.normalize(value)
}

function validateLyricsPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !LYRIC_EXT.test(value)) {
    throw new Error('Lyrics path must be an absolute .lrc, .ttml or .yrc file path.')
  }
  return path.normalize(value)
}

/** 本地文件的歌词：格式由内容判断（.lrc / .ttml / .yrc），来源一律是 local。 */
function documentLyrics(text: string): Lyrics | null {
  if (!text.trim()) return null
  const parsed = parseLyricsDocument(text)
  if (!parsed || parsed.lines.length === 0) return null
  return { lines: parsed.lines, wordByWord: parsed.wordByWord, source: 'local' }
}

async function readParsed(file: string): Promise<Lyrics | null> {
  const info = await stat(file)
  if (!info.isFile()) return null
  const key = libraryPathKey(file)
  const cached = parsedCache.get(key)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    parsedCache.delete(key)
    parsedCache.set(key, cached)
    return cached.lyrics
  }
  if (cached) {
    parsedCache.delete(key)
    cacheBytes -= cached.bytes
  }
  const text = await readFile(file, 'utf8')
  const lyrics = documentLyrics(text)
  if (!lyrics) return null
  const entry: CacheEntry = { mtimeMs: info.mtimeMs, size: info.size, bytes: text.length * 2, lyrics }
  if (entry.bytes <= MAX_CACHE_BYTES) {
    parsedCache.set(key, entry)
    cacheBytes += entry.bytes
    while (parsedCache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
      const [oldestKey, oldest] = parsedCache.entries().next().value as [string, CacheEntry]
      parsedCache.delete(oldestKey)
      cacheBytes -= oldest.bytes
    }
  }
  return lyrics
}

async function trySource(file: string, source: 'attached' | 'sidecar'): Promise<LyricsSourceResult | null> {
  try {
    const lyrics = await readParsed(file)
    return lyrics ? { lyrics, resolvedPath: file, source } : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
      console.error('[lyrics] failed to read', file, error)
    }
    return null
  }
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

async function persist(file: string | null, next: LyricsConfig): Promise<void> {
  if (!file) throw new Error('Lyrics storage is not configured.')
  const temporary = file + '.' + randomUUID() + '.tmp'
  await mkdir(path.dirname(file), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify(next), 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function mutate(operation: (current: LyricsConfig) => LyricsConfig): Promise<LyricsConfig> {
  return enqueue(async () => {
    await configReady
    const generation = configGeneration
    const file = configFile
    const next = operation(cloneConfig(config))
    await persist(file, next)
    if (generation === configGeneration) config = next
    return cloneConfig(next)
  })
}

async function validateLyricsFile(file: string): Promise<void> {
  const lyrics = await readParsed(file)
  if (!lyrics) throw new Error('Selected file does not contain valid timed lyrics.')
}

export async function attachLyrics(audioPath: string, lrcPath: string): Promise<LyricsConfig> {
  const audio = validateAudioPath(audioPath)
  const attached = validateLyricsPath(lrcPath)
  await validateLyricsFile(attached)
  return mutate(current => {
    const key = libraryPathKey(audio)
    current.tracks[key] = { ...(current.tracks[key] ?? { offsetMs: 0 }), attachedPath: attached }
    return current
  })
}

export async function clearAttachedLyrics(audioPath: string): Promise<LyricsConfig> {
  const audio = validateAudioPath(audioPath)
  return mutate(current => {
    const key = libraryPathKey(audio)
    const item = current.tracks[key]
    if (item) {
      delete item.attachedPath
      if (item.offsetMs === 0) delete current.tracks[key]
    }
    return current
  })
}

export async function setLyricsOffset(audioPath: string, offsetMs: number): Promise<LyricsConfig> {
  const audio = validateAudioPath(audioPath)
  validateLyricsOffset(offsetMs)
  return mutate(current => {
    const key = libraryPathKey(audio)
    const item = current.tracks[key] ?? { offsetMs: 0 }
    item.offsetMs = offsetMs
    if (!item.attachedPath && item.offsetMs === 0) delete current.tracks[key]
    else current.tracks[key] = item
    return current
  })
}

export async function resolveLyrics(track: { trackId?: string; path?: string }): Promise<LyricsLoadResult> {
  await configReady
  const audio = typeof track?.path === 'string' && track.path ? validateAudioPath(track.path) : null
  const item = audio ? config.tracks[libraryPathKey(audio)] : undefined
  const offsetMs = item?.offsetMs ?? 0
  let attachedUnavailable = false
  let selected: LyricsSourceResult | null = null

  if (item?.attachedPath) {
    selected = await trySource(item.attachedPath, 'attached')
    attachedUnavailable = !selected
  }
  if (!selected && audio) {
    for (const extension of LYRIC_EXTENSIONS) {
      selected = await trySource(audio.replace(AUDIO_EXT, extension), 'sidecar')
      if (selected) break
    }
  }
  // §4.4 第 1 顺位的另一半：歌词写在文件自己的标签里。只接受带时间轴的那些。
  if (!selected && audio) {
    const embedded = await readEmbeddedLyrics(audio)
    if (embedded) selected = { lyrics: embedded, resolvedPath: audio, source: 'embedded' }
  }
  if (!selected) {
    for (const fixture of fixturePaths) {
      selected = await trySource(fixture, 'sidecar')
      if (selected) break
    }
  }

  const source = selectLyricsSource(
    selected?.source === 'attached' ? selected : null,
    selected?.source === 'sidecar' ? selected : null,
    selected?.source === 'embedded' ? selected : null
  )
  return {
    lyrics: source?.lyrics ?? null,
    resolvedPath: source?.resolvedPath ?? null,
    source: source?.source ?? 'none',
    attachedUnavailable,
    offsetMs
  }
}

export function loadLyrics(audioPath: string): Promise<LyricsLoadResult> {
  return resolveLyrics({ path: audioPath })
}

// ───────────────────────── 在线取词 ─────────────────────────

function trackKeyOf(track: { path?: string }): string {
  return typeof track?.path === 'string' && track.path ? libraryPathKey(track.path) : ''
}

/**
 * 同一首歌的取词去重。
 *
 * 渲染层可能在换曲/重试时连发两次请求（例如用户连点两下「在线查找」，或切歌切回来）。
 * 两次并发会真的打两遍网络 —— 既慢又白白多 4 个请求。这里让后来者搭第一趟车。
 */
const inFlight = new Map<string, Promise<OnlineLyricsOutcome>>()

/**
 * 取在线歌词。
 *
 * 顺序刻在缓存里：**查到过就永不重查**，**查不到则记住一段时间**。
 * 否则「播放时自动查一次」在实现上就是「每播一次查四五个请求」——
 * 那正是契约 §5 明令禁止的批量拉取。
 *
 * force=true 时忽略缓存（用户在歌词栏点「重新查找」就是明确要重查）。
 */
export function resolveOnlineLyrics(track: Track, force = false): Promise<OnlineLyricsOutcome> {
  // 显式离线开关：UI/集成测试里绝不允许真的联网（网络抖动会变成测试抖动，
  // 而且测试不该替用户访问第三方）。生产环境不设这个变量。
  if (process.env.TWILIGHT_OFFLINE === '1') return Promise.resolve({ status: 'none' })
  const key = trackKeyOf(track)
  if (!key) return Promise.resolve({ status: 'none' })
  const running = inFlight.get(key)
  if (running) return running
  const started = lookupOnlineLyrics(track, force).finally(() => { inFlight.delete(key) })
  inFlight.set(key, started)
  return started
}

async function lookupOnlineLyrics(track: Track, force: boolean): Promise<OnlineLyricsOutcome> {
  await configReady
  const key = trackKeyOf(track)
  if (!key) return { status: 'none' }
  const offsetMs = config.tracks[key]?.offsetMs ?? 0
  const now = Date.now()

  if (!force) {
    const cached = await readOnlineCache(key, now)
    if (cached.known) {
      const entry = cached.entry
      if (entry?.lyrics) {
        return { status: 'found', result: { lyrics: entry.lyrics, match: entry.match ?? emptyMatch(), offsetMs, cached: true, fetchedAt: entry.fetchedAt } }
      }
      // 有效期内已知「没有」：不再联网，也不再打扰用户。
      // 但「纯音乐」要如实说出来 —— 那是一条结论，不是一次失败。
      return { status: entry?.reason === 'instrumental' ? 'instrumental' : 'none' }
    }
  }

  let found: Awaited<ReturnType<typeof fetchOnlineLyrics>>
  try {
    found = await fetchOnlineLyrics(track)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const blocked = /-460|460|风控/.test(message)
    return { status: blocked ? 'blocked' : 'unavailable', message }
  }

  if (!found) {
    await writeOnlineCache(key, null, undefined, now, 'not-found')
    return { status: 'none' }
  }
  if (found.instrumental) {
    await writeOnlineCache(key, null, found.match, now, 'instrumental')
    return { status: 'instrumental' }
  }
  if (!found.lyrics) {
    await writeOnlineCache(key, null, undefined, now, 'not-found')
    return { status: 'none' }
  }
  await writeOnlineCache(key, found.lyrics, found.match, now)
  return {
    status: 'found',
    result: { lyrics: found.lyrics, match: found.match!, offsetMs, cached: false, fetchedAt: now }
  }
}

function emptyMatch(): OnlineMatch {
  return { provider: 'lrclib', title: '', artist: '', score: 0, risk: 'high', reasons: ['unknown'] }
}

/** 用户手动关联/清空歌词后，让在线缓存跟着失效（否则旧结果会一直盖住新的本地文件）。 */
export async function forgetOnlineLyrics(audioPath: string): Promise<void> {
  await forgetOnlineCache(audioPath)
}

/**
 * 把**在线取到的歌词**落成本地同名 .ttml，放在音乐旁边。
 *
 * 为什么值得有一个「保存」动作：
 *  1. 在线结果是缓存在 app 数据目录里的，**跟着路径走**；文件一改名或换目录，歌词就没了。
 *     同名文件跟着音频文件走，改名、移动、换机器都还在。
 *  2. 本地文件是 §4.4 的第一顺位，存下来之后这首歌**再也不联网**。
 *  3. 用户可以打开它改（TTML 是可读文本），改错了删掉即可 —— 我们绝不覆盖已有文件。
 *
 * 保存的是**在线缓存里的源歌词**，不是界面上的插值视图：
 * 把插值出来的词级时间写进文件，就是把「猜的」永久固化成「测的」。
 */
export async function saveLyricsBeside(track: { path?: string; title?: string; artist?: string }): Promise<{ path: string }> {
  await configReady
  const audio = validateAudioPath(track?.path)
  const key = libraryPathKey(audio)
  const cached = await readOnlineCache(key, Date.now())
  const lyrics = cached.entry?.lyrics
  if (!lyrics) throw new Error('这首歌还没有可保存的在线歌词，请先在歌词栏点「在线查找」。')

  const target = audio.replace(AUDIO_EXT, '.ttml')
  const exists = await stat(target).then(() => true, () => false)
  if (exists) throw new Error('同名歌词文件已存在：' + path.basename(target) + '（不会覆盖已有文件）')

  const match = cached.entry?.match
  const text = serializeTtml(lyrics, {
    musicName: match?.title || track.title,
    artists: match?.artist || track.artist,
    ...(match?.album ? { album: match.album } : {}),
    ...(match?.ncmId ? { ncmId: match.ncmId } : {}),
    origin: match
      ? '在线匹配 · ' + match.provider + ' · 计分 ' + match.score + ' · 风险 ' + match.risk
      : '在线匹配'
  })

  const temporary = target + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  // 不清在线缓存：万一用户把文件删了，下一次解析还能立刻退回到缓存里的那份。
  return { path: target }
}

// ───────────────────────── 人工纠正 ─────────────────────────

/** 列出候选（一次搜索请求），给用户自己挑。离线模式下不联网。 */
export async function listLyricCandidates(track: Track): Promise<LyricCandidateOption[]> {
  if (process.env.TWILIGHT_OFFLINE === '1') return []
  return searchLyricCandidates(track)
}

/**
 * 按用户选中的候选取歌词，并**记住这个选择**（缓存打 pinned 标记）。
 * 之后再播这首歌直接用缓存，不会又退回自动计分挑的那一条。
 */
export async function applyLyricCandidate(track: Track, candidate: LyricCandidateOption): Promise<OnlineLyricsOutcome> {
  if (process.env.TWILIGHT_OFFLINE === '1') return { status: 'none' }
  await configReady
  const key = trackKeyOf(track)
  if (!key) return { status: 'none' }
  const offsetMs = config.tracks[key]?.offsetMs ?? 0

  let found: Awaited<ReturnType<typeof fetchLyricsForCandidate>>
  try {
    found = await fetchLyricsForCandidate(track, candidate)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: /-460|460|风控/.test(message) ? 'blocked' : 'unavailable', message }
  }

  const now = Date.now()
  if (!found) {
    await writeOnlineCache(key, null, undefined, now, 'not-found')
    return { status: 'none' }
  }
  if (found.instrumental) {
    await writeOnlineCache(key, null, found.match, now, 'instrumental')
    return { status: 'instrumental' }
  }
  if (!found.lyrics) {
    await writeOnlineCache(key, null, undefined, now, 'not-found')
    return { status: 'none' }
  }
  await writeOnlineCache(key, found.lyrics, found.match, now, undefined, true)
  return {
    status: 'found',
    result: { lyrics: found.lyrics, match: found.match!, offsetMs, cached: false, fetchedAt: now }
  }
}
