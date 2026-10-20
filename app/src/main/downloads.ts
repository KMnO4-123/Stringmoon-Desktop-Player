/**
 * 下载队列（全局搜索那一条的落盘端）。
 *
 * 三个决定：
 *  1. **一次只跑一个**。并发下载会同时打三四个上游接口，而这是一个用户的账号在
 *     被平台风控的语境里——队列的意义就是替用户踩刹车。
 *  2. **先写临时文件再改名**。下载中断留下的半个文件不能以成品名字出现在用户目录里。
 *  3. **标签只在 MP3 上写**。node-id3 是 ID3v2，对 m4a/flac/ogg 不适用；那些格式
 *     只落同名 .lrc 与封面文件，并在结果里说明——假装写过标签比不写更糟。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { StreamingTrack } from '@shared/streaming'

import type { DownloadItem, DownloadState } from '@shared/downloads'
export type { DownloadItem, DownloadState }

export interface DownloadDeps {
  resolvePlay: (platform: string, track: { id: string; title?: string; artist?: string }) => Promise<{ url: string; referer?: string; userAgent?: string; allowInsecure?: boolean }>
  lyrics: (platform: string, track: { id: string }) => Promise<{ lrc: string; translation: string }>
  cover: (platform: string, track: { id: string }) => Promise<{ data: Uint8Array; mime: string } | null>
}

const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac'
}

/** 文件名里不能出现的字符换掉；长度封顶，避免超长标题撑爆路径。 */
export function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled'
}

export function downloadName(track: { title: string; artist: string }): string {
  const artist = track.artist?.trim()
  return safeFileName(artist ? artist + ' - ' + track.title : track.title)
}

let counter = 0
const newId = (): string => 'dl_' + Date.now().toString(36) + '_' + (counter++).toString(36)

export class DownloadManager {
  private items: DownloadItem[] = []
  private directory = ''
  private configFile: string | null = null
  private running = false
  private emit: (item: DownloadItem) => void = () => {}

  constructor(private readonly deps: DownloadDeps) {}

  setEmitter(emit: (item: DownloadItem) => void): void { this.emit = emit }

  async configure(configFile: string, fallbackDirectory: string): Promise<void> {
    this.configFile = configFile
    try {
      const saved = JSON.parse(await readFile(configFile, 'utf8')) as { directory?: unknown }
      if (typeof saved.directory === 'string' && path.isAbsolute(saved.directory)) this.directory = saved.directory
    } catch { /* 首次运行 */ }
    if (!this.directory) this.directory = fallbackDirectory
  }

  getDirectory(): string { return this.directory }

  async setDirectory(directory: string): Promise<string> {
    if (!path.isAbsolute(directory)) throw new Error('下载目录必须是绝对路径。')
    this.directory = directory
    if (this.configFile) {
      await mkdir(path.dirname(this.configFile), { recursive: true })
      await writeFile(this.configFile, JSON.stringify({ directory }, null, 2), 'utf8')
    }
    return this.directory
  }

  list(): DownloadItem[] { return this.items.map(item => ({ ...item })) }

  cancel(id: string): void {
    const item = this.items.find(entry => entry.id === id)
    if (!item) return
    if (item.state === 'queued') { item.state = 'cancelled'; this.emit({ ...item }) }
    // downloading 的那一条由下载循环自己发现状态变化后中止
    if (item.state === 'downloading') item.state = 'cancelled'
  }

  clearFinished(): void {
    this.items = this.items.filter(item => item.state === 'queued' || item.state === 'downloading')
    this.emit({ id: 'clear', platform: '', trackId: '', title: '', artist: '', album: '', state: 'done', progress: 0, bytes: 0, total: 0, path: null, error: null, extras: [] })
  }

  enqueue(track: StreamingTrack): DownloadItem {
    // GD 音乐台是第三方**流式**源：直链带签名/时效，落盘后很快失效，且上游条款通常不允许。
    // UI 隐藏下载入口只是提示，主进程这里必须真的拒绝（不能靠前端自律）。
    if (track.platform === 'gdstudio') throw new Error('GD 音乐台是流式第三方源，不支持下载（可以播放在线流）。')
    const existing = this.items.find(item =>
      item.platform === track.platform && item.trackId === track.id && (item.state === 'queued' || item.state === 'downloading'))
    if (existing) return { ...existing }
    const item: DownloadItem = {
      id: newId(),
      platform: track.platform,
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      state: 'queued',
      progress: 0,
      bytes: 0,
      total: 0,
      path: null,
      error: null,
      extras: []
    }
    this.items.unshift(item)
    void this.pump()
    return { ...item }
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const next = this.items.find(item => item.state === 'queued')
        if (!next) break
        await this.run(next)
      }
    } finally {
      this.running = false
    }
  }

  private update(item: DownloadItem, patch: Partial<DownloadItem>): void {
    Object.assign(item, patch)
    this.emit({ ...item })
  }

  private async run(item: DownloadItem): Promise<void> {
    this.update(item, { state: 'downloading', progress: 0 })
    const base = downloadName(item)
    try {
      // GD 音乐台是流式第三方源：主进程拒绝落盘（入口已先拦一次，这里兜住持久化队列里的旧条目）。
      if (item.platform === 'gdstudio') throw new Error('GD 音乐台是流式第三方源，不支持下载。')
      await mkdir(this.directory, { recursive: true })
      const target = await this.deps.resolvePlay(item.platform, { id: item.trackId, title: item.title, artist: item.artist })
      const response = await fetch(target.url, {
        headers: {
          ...(target.referer ? { referer: target.referer } : {}),
          ...(target.userAgent ? { 'user-agent': target.userAgent } : {})
        }
      })
      if (!response.ok) throw new Error('下载失败：HTTP ' + response.status)
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      const extension = AUDIO_EXT[mime] ?? '.mp3'
      const total = Number(response.headers.get('content-length') ?? 0)
      this.update(item, { total: Number.isFinite(total) ? total : 0 })

      const temporary = path.join(this.directory, base + '.part')
      const finalPath = path.join(this.directory, base + extension)
      const stream = createWriteStream(temporary)
      let received = 0
      let lastEmit = 0
      const reader = response.body?.getReader()
      if (!reader) throw new Error('下载失败：响应没有内容。')
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (item.state === 'cancelled') { stream.destroy(); await rm(temporary, { force: true }); this.emit({ ...item }); return }
        await new Promise<void>((resolve, reject) => stream.write(Buffer.from(value), error => error ? reject(error) : resolve()))
        if (value) received += value.byteLength
        const now = Date.now()
        if (now - lastEmit > 150) {
          lastEmit = now
          this.update(item, { bytes: received, progress: total > 0 ? Math.min(1, received / total) : 0 })
        }
      }
      await new Promise<void>((resolve, reject) => stream.end(() => resolve()))
      await rename(temporary, finalPath)
      const extras: string[] = []

      // 歌词：同名 .lrc。取不到不算失败——没有歌词的歌本来就存在。
      try {
        const lyric = await this.deps.lyrics(item.platform, { id: item.trackId })
        if (lyric.lrc.trim()) {
          await writeFile(path.join(this.directory, base + '.lrc'), lyric.lrc, 'utf8')
          extras.push('歌词')
        }
      } catch { /* 忽略：歌词不是下载是否成功的判据 */ }

      // 封面：同名图片；mp3 另外嵌进 ID3。
      let cover: { data: Uint8Array; mime: string } | null = null
      try { cover = await this.deps.cover(item.platform, { id: item.trackId }) } catch { cover = null }
      if (cover && cover.data.length > 0) {
        const pictureExtension = cover.mime === 'image/png' ? '.png' : '.jpg'
        await writeFile(path.join(this.directory, base + pictureExtension), Buffer.from(cover.data))
        extras.push('封面')
      }

      if (extension === '.mp3') {
        try {
          // node-id3 是 CJS：ESM 动态 import 拿到的是 { default: module }，
          // 直接用 const id3 = await import(...) 会得到 "id3.write is not a function"
          // ——而且它会被下面的 catch 吞掉，表现成"标签没写但下载成功"。
          const imported = await import('node-id3')
          const id3 = (imported as { default?: { write: (tags: unknown, file: string) => unknown } }).default
            ?? (imported as unknown as { write: (tags: unknown, file: string) => unknown })
          const tags: Record<string, unknown> = { title: item.title, artist: item.artist, album: item.album }
          if (cover) tags.image = { mime: cover.mime, type: { id: 3, name: 'front cover' }, description: 'cover', imageBuffer: Buffer.from(cover.data) }
          const result = id3.write(tags, finalPath)
          // write() 成功返回 true，失败返回 Error 对象；只有明确成功才记一笔。
          if (result === true) extras.push('标签')
        } catch { /* 标签失败不该让整首歌判为失败 */ }
      }

      this.update(item, { state: 'done', progress: 1, path: finalPath, bytes: received, total: received, extras })
    } catch (error) {
      this.update(item, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export async function fileSize(file: string): Promise<number> {
  try { return (await stat(file)).size } catch { return 0 }
}
