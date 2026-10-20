/** 下载队列的共享形状（主进程与渲染层同一份）。 */
export type DownloadState = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled'

export interface DownloadItem {
  id: string
  platform: string
  trackId: string
  title: string
  artist: string
  album: string
  state: DownloadState
  /** 0..1 */
  progress: number
  bytes: number
  total: number
  path: string | null
  error: string | null
  /** 这首歌实际落了哪些东西：'歌词' / '封面' / '标签' */
  extras: string[]
}
