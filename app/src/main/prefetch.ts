/**
 * 下一首预热（对标 ECHO NEXT 的 audio.prefetch）。
 *
 * 做什么：把下一首本地文件的前若干 MB 读进内存再丢弃 —— 目的是把文件页读进
 * Windows 的 OS 缓存，让真正切歌时解码器的第一段读取命中缓存（冷盘首读常常是
 * 切歌卡顿的主因）。不解析音频、不碰引擎、不影响当前播放。
 *
 * 为什么不是「解码器预热」：那需要引擎对下一首 open 一次，会打断当前播放链路
 * （协议里没有「只解码不出声」的命令）。规格里这条本来就写的是「预热 OS 缓存/
 * 解码器」二选一，我们选前者。
 *
 * 「低优先级」在这个环境里的实现：Node 没有 I/O 优先级 API，也不该改整个进程的
 * 优先级（会影响播放主线程）。所以用「小块（1MB）+ 每块后 setImmediate 让出
 * 事件循环 + 总量封顶」来保证主线程不会被一次大读占住，且用户切歌时旧预热会被
 * 立刻取消（代际计数 + 关闭句柄）。
 */
import { open, stat, type FileHandle } from 'node:fs/promises'
import { isAbsoluteWindowsPath, isSupportedAudioPath } from '@shared/file-path'
import type { PrefetchResult } from '@shared/prefetch'

export type { PrefetchResult }

export interface PrefetchOptions {
  /** 最多读多少字节（默认 8MB：足够覆盖一首歌起播+seek 附近的页，又不至于读整张专辑）。 */
  maxBytes?: number
  /** 单次 read 的大小（默认 1MB）。 */
  chunkBytes?: number
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 1024 * 1024

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

export class TrackPrefetcher {
  private generation = 0
  private handle: FileHandle | null = null
  private activePath: string | null = null
  private readonly maxBytes: number
  private readonly chunkBytes: number

  constructor(options: PrefetchOptions = {}) {
    this.maxBytes = Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 64 * 1024 * 1024))
    this.chunkBytes = Math.max(1, Math.min(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, this.maxBytes))
  }

  /** 当前正在预热的路径（诊断/测试用）。 */
  active(): string | null {
    return this.activePath
  }

  /**
   * 预热一个文件。渲染层传来的路径一律不可信：必须是字符串、Windows 绝对路径、
   * 支持的音频扩展名、真实存在的普通文件。任何一步失败都如实返回 error（不抛），
   * 因为预热失败不该让渲染层以为播放出了问题。
   */
  async prefetch(raw: unknown): Promise<PrefetchResult> {
    const started = Date.now()
    this.cancel()
    const generation = ++this.generation
    const reject = (error: string): PrefetchResult => ({ ok: false, bytes: 0, ms: Date.now() - started, error })

    if (typeof raw !== 'string' || !isAbsoluteWindowsPath(raw)) return reject('预热的路径必须是绝对路径。')
    const file = raw
    if (!isSupportedAudioPath(file)) return reject('预热的文件不是受支持的音频格式。')
    let info
    try {
      info = await stat(file)
    } catch {
      return reject('预热的文件不存在或不可读。')
    }
    if (generation !== this.generation) return { ok: true, bytes: 0, ms: Date.now() - started, cancelled: true }
    if (!info.isFile()) return reject('预热的路径不是文件。')
    if (info.size <= 0) return reject('预热的文件是空的。')

    const limit = Math.min(info.size, this.maxBytes)
    let handle: FileHandle
    try {
      handle = await open(file, 'r')
    } catch {
      return reject('预热的文件打不开。')
    }
    if (generation !== this.generation) {
      await handle.close().catch(() => undefined)
      return { ok: true, bytes: 0, ms: Date.now() - started, cancelled: true }
    }
    this.handle = handle
    this.activePath = file
    const buffer = Buffer.allocUnsafe(Math.min(this.chunkBytes, limit))
    let read = 0
    try {
      while (read < limit) {
        if (generation !== this.generation) {
          return { ok: true, bytes: read, ms: Date.now() - started, cancelled: true }
        }
        const want = Math.min(buffer.length, limit - read)
        const { bytesRead } = await handle.read(buffer, 0, want, read)
        if (bytesRead <= 0) break
        read += bytesRead
        // 每块之后让出一轮事件循环：播放主线程的命令/事件处理优先。
        await yieldToEventLoop()
      }
      return { ok: true, bytes: read, ms: Date.now() - started }
    } catch {
      // 取消会关闭句柄，让在途 read 以 EBADF/ERR_STREAM_DESTROYED 失败 —— 那不是
      // 「预热失败」，而是「用户切歌了」，必须如实报 cancelled（渲染层不该弹错误）。
      if (generation !== this.generation) {
        return { ok: true, bytes: read, ms: Date.now() - started, cancelled: true }
      }
      return { ok: false, bytes: read, ms: Date.now() - started, error: '预热读取失败。' }
    } finally {
      if (generation === this.generation) {
        this.handle = null
        this.activePath = null
      }
      await handle.close().catch(() => undefined)
    }
  }

  /** 取消当前预热（切歌/关闭提示/退出时调用；幂等）。 */
  cancel(): void {
    this.generation++
    const handle = this.handle
    this.handle = null
    this.activePath = null
    if (handle) void handle.close().catch(() => undefined)
  }
}

export const trackPrefetcher = new TrackPrefetcher()
