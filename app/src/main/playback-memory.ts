/**
 * 播放记忆的持久化（主进程）。
 *
 * 对标 ECHO NEXT 的 echo-playback-memory.json：记住「上次听到哪里、队列与循环模式」，
 * 下次启动给渲染层一个「继续上次」入口。**恢复只到「已加载、暂停」**——
 * 主进程绝不自动 open/play，是否继续由用户点一下决定。
 *
 * 为什么主进程自己也要跟引擎事件（而不是只等渲染层上报）：
 *  - 渲染层可能在播放中崩溃/重载，状态事件仍然到达主进程；
 *  - 位置是高频数据，放在 main 侧可以用「内存实时更新 + 磁盘 5 秒节流」的方式
 *    既精确又不写坏 SSD（渲染层只为补 filePath/queue/repeatMode 调用 set）。
 *
 * 写盘纪律：内存更新立即生效；磁盘写 debounce 2s；退出时同步补写（异步在
 * will-quit 里可能来不及落地，而这份文件丢了只是少一个恢复入口，不能反过来
 * 让退出流程等它）。
 *
 * 隐私/体积：文件里只有「本地文件绝对路径 + 引擎 trackId + 位置/时长 + 队列 id +
 * 循环模式 + 时间戳」，不存标题/艺人/专辑/封面等任何元数据，也不存在线曲目
 * （在线 trackId 恒为空串，没有可恢复身份）。单个文件几 KB。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { EngineEvent } from '@shared/protocol'
import { mergePlaybackMemory, sanitizePlaybackMemory, type PlaybackMemory } from '@shared/playback-memory'

/** 位置最多每 5 秒落一次盘：一首 5 分钟的歌约 60 次小文件写，代价可忽略。 */
const POSITION_RECORD_INTERVAL_MS = 5000
/** 曲目/播放态变化等「重要变更」的写盘 debounce。 */
const WRITE_DEBOUNCE_MS = 2000

interface MemoryDocument {
  version: 1
  memory: PlaybackMemory | null
}

let configFile: string | null = null
let memory: PlaybackMemory | null = null
let ready: Promise<void> = Promise.resolve()
let generation = 0
let dirty = false
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<unknown> = Promise.resolve()
/**
 * 写代际：退出时的同步补写会把 generation 推前，从而让仍在队列里的异步写
 * （它持有的是旧快照）在落地前自行放弃 —— 否则异步写可能用旧记忆覆盖同步补写
 * 的新记忆，用户看到的是「退出前的进度回退」。
 */
let writeGeneration = 0
/** 位置事件的当前值（暂停时用它把「最后听到的位置」写进记忆）。 */
let lastPositionTrackId = ''
let lastPositionMs = 0
let lastPositionRecordedAt = 0

const cloneMemory = (value: PlaybackMemory | null): PlaybackMemory | null =>
  value ? { ...value, queue: [...value.queue] } : null

function parseDocument(text: string): PlaybackMemory | null {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  // 只认新格式 wrapper；也兼容直接存 memory 对象的早期草稿（version===1 且带 filePath）。
  if (record.version === 1 && 'memory' in record) return sanitizePlaybackMemory(record.memory)
  return sanitizePlaybackMemory(parsed)
}

export function configurePlaybackMemory(file: string): void {
  configFile = file
  memory = null
  dirty = false
  const current = ++generation
  ready = readFile(file, 'utf8')
    .then(text => {
      if (current !== generation) return
      memory = parseDocument(text)
    })
    .catch(() => {
      /* 首次运行没有这个文件；损坏按「没有记忆」处理，绝不阻断启动。 */
    })
}

export async function readPlaybackMemory(): Promise<PlaybackMemory | null> {
  await ready
  const snapshot = cloneMemory(memory)
  if (!snapshot) return null
  // 「文件不存在时不恢复」：恢复入口必须能真的打开这首歌，否则用户点「继续上次」
  // 只会得到一条 ERR_NOTFOUND。这里只 stat、不读文件；失败就当没有记忆
  //（保留磁盘上的记录：文件可能只是暂时拔盘，下次还能用）。
  if (snapshot.filePath) {
    try {
      const info = await stat(snapshot.filePath)
      if (!info.isFile()) return null
    } catch {
      return null
    }
  }
  return snapshot
}

export async function savePlaybackMemory(patch: unknown): Promise<PlaybackMemory | null> {
  await ready
  const merged = mergePlaybackMemory(memory, patch)
  if (!merged) {
    memory = null
    scheduleWrite(WRITE_DEBOUNCE_MS)
    return null
  }
  memory = { ...merged, updatedAt: Date.now() }
  scheduleWrite(WRITE_DEBOUNCE_MS)
  return cloneMemory(memory)
}

export async function clearPlaybackMemory(): Promise<void> {
  await ready
  memory = null
  scheduleWrite(WRITE_DEBOUNCE_MS)
  return
}

/**
 * 跟随引擎事件更新记忆（由 index.ts 的 sendEvent 调用）。
 *
 * 只处理本地曲目（trackId 非空）：在线曲目的 trackId 恒为空串（CR-016），
 * 没有可跨重启恢复的身份，写进去只会让「继续上次」指向一首不存在的歌。
 * 任何异常都在这里吞掉：记忆是锦上添花，不能让它影响播放事件路径。
 */
export function recordPlaybackMemoryEvent(
  event: EngineEvent,
  resolvePath: (trackId: string) => string | undefined
): void {
  try {
    if (event.ev === 'state') {
      const trackId = typeof event.trackId === 'string' ? event.trackId : ''
      if (!trackId) return
      const durationMs = typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs > 0 ? event.durationMs : undefined
      if (!memory || memory.trackId !== trackId) {
        // 换曲：filePath 从托盘缓存（它本来就是 list_tracks 的映射）解析；解析不到
        // 就留空 —— 渲染层的 set 稍后会补上，宁可这条记录缺路径也不要猜一个。
        const filePath = resolvePath(trackId) ?? ''
        memory = {
          version: 1,
          filePath,
          trackId,
          positionMs: 0,
          durationMs: durationMs ?? 0,
          queue: memory ? [...memory.queue] : [],
          repeatMode: memory?.repeatMode ?? 'sequential',
          updatedAt: Date.now()
        }
        lastPositionTrackId = trackId
        lastPositionMs = 0
        scheduleWrite(WRITE_DEBOUNCE_MS)
        return
      }
      if (durationMs !== undefined && memory.durationMs !== durationMs) {
        memory = { ...memory, durationMs, updatedAt: Date.now() }
      }
      if (event.state === 'paused' && lastPositionTrackId === trackId) {
        // 引擎暂停后不再发 position：用最后一条 position 把「听到哪里」钉住。
        if (lastPositionMs !== memory.positionMs) {
          memory = { ...memory, positionMs: lastPositionMs, updatedAt: Date.now() }
        }
        scheduleWrite(WRITE_DEBOUNCE_MS)
      } else if (event.state === 'stopped') {
        /**
         * stopped 有两个来源，旧代码把它们当成同一件事，于是「已装载、未开始播放」
         * 也会把记忆位置写成 0 —— v6 自动恢复因此永远回到 0:00：
         *  open/seek 之后引擎报 stopped（带真实位置 42000），main 却记成 0；
         *  随后任何一次 set_output 之类的重开流事件再把 0 写一遍。
         * 判据是事件自带的 positionMs：>0 说明这是「停在某个位置」，照抄；
         * 只有真正的 stop（位置 0）才归零。
         */
        const stoppedPosition = typeof event.positionMs === 'number' && Number.isFinite(event.positionMs) && event.positionMs > 0
          ? event.positionMs
          : 0
        if (memory.positionMs !== stoppedPosition) {
          memory = { ...memory, positionMs: stoppedPosition, updatedAt: Date.now() }
          if (stoppedPosition > 0) { lastPositionTrackId = trackId; lastPositionMs = stoppedPosition }
        }
        scheduleWrite(WRITE_DEBOUNCE_MS)
      }
      return
    }
    if (event.ev === 'position') {
      if (!memory || event.trackId !== memory.trackId) return
      if (typeof event.positionMs !== 'number' || !Number.isFinite(event.positionMs) || event.positionMs < 0) return
      lastPositionTrackId = event.trackId
      lastPositionMs = event.positionMs
      memory = { ...memory, positionMs: event.positionMs, updatedAt: Date.now() }
      const now = Date.now()
      if (now - lastPositionRecordedAt >= POSITION_RECORD_INTERVAL_MS) {
        lastPositionRecordedAt = now
        scheduleWrite(POSITION_RECORD_INTERVAL_MS)
      }
      return
    }
    if (event.ev === 'ended' && memory && event.trackId === memory.trackId) {
      // 自然播完/切歌：位置归零，下次「继续上次」从头放（不是从曲尾）。
      memory = { ...memory, positionMs: 0, updatedAt: Date.now() }
      scheduleWrite(WRITE_DEBOUNCE_MS)
    }
  } catch {
    /* 记忆更新失败不能影响播放事件路径。 */
  }
}

function scheduleWrite(delayMs: number): void {
  if (!configFile) return
  dirty = true
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void persist()
  }, delayMs)
  writeTimer.unref?.()
}

function persist(): Promise<void> {
  if (!configFile || !dirty) return writing.then(() => undefined)
  dirty = false
  const file = configFile
  const generation = ++writeGeneration
  const document: MemoryDocument = { version: 1, memory }
  const write = writing.then(async () => {
    // 排队期间退出补写已经落盘了更新的快照：这次异步写作废。
    if (generation !== writeGeneration) return
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(document), 'utf8')
    if (generation !== writeGeneration) return
    await rename(file + '.tmp', file)
  })
  writing = write.catch(() => undefined)
  return write
}

/**
 * 退出补写（同步）。
 *
 * will-quit 里已经不能保证异步 fs 落地；这份文件丢了只影响「继续上次」入口，
 * 不值得让退出流程 await 一个写盘 promise。同步写本身只有几 KB。
 */
export function flushPlaybackMemorySync(): void {
  if (!configFile || !dirty) return
  dirty = false
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  // 让在途/排队中的异步写全部作废（它们持有的是旧快照）。
  writeGeneration++
  try {
    const file = configFile
    mkdirSync(path.dirname(file), { recursive: true })
    const document: MemoryDocument = { version: 1, memory }
    writeFileSync(file + '.tmp', JSON.stringify(document), 'utf8')
    renameSync(file + '.tmp', file)
  } catch {
    /* 退出路径上写失败不阻断退出。 */
  }
}
