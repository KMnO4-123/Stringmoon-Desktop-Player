import { useEffect, useState } from 'react'
import { CloudDownload, FolderOpen, RotateCw, Trash2, X } from 'lucide-react'
import type { DownloadItem } from '@shared/downloads'

/**
 * 下载队列。
 *
 * 进度由主进程**推**过来（twilight:download-progress），所以这里不需要轮询；
 * 打开页面时再拉一次全量列表补上历史。两种来源合并的策略是"以最新事件为准"。
 */
export default function Downloads() {
  const [items, setItems] = useState<DownloadItem[]>([])
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setItems(await window.twilight.downloads())
      setDirectory(await window.twilight.downloadDirectory())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    return window.twilight.onDownloadProgress(item => {
      setItems(current => {
        const next = current.filter(entry => entry.id !== item.id)
        next.unshift(item)
        return next
      })
    })
  }, [])

  const pickDirectory = (): void => {
    void (async () => {
      try {
        const next = await window.twilight.pickDownloadDir()
        if (next) setDirectory(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  const total = items.filter(item => item.state === 'downloading' || item.state === 'queued').length

  return (
    <section className="downloads-page" aria-label="下载">
      <div className="space-heading">
        <div>
          <span className="section-eyebrow">DOWNLOADS</span>
          <h1>下载</h1>
        </div>
        <div className="download-tools">
          <span className="download-dir mono" title={directory}>{directory || '尚未设置目录'}</span>
          <button className="topbar-action" onClick={pickDirectory}><FolderOpen size={14} />选择目录</button>
          <button className="topbar-action" onClick={() => void refresh()}><RotateCw size={14} />刷新</button>
          <button className="topbar-action" disabled={items.length === 0} onClick={() => void window.twilight.downloadClear().then(setItems)}>
            <Trash2 size={14} />清除已完成
          </button>
        </div>
      </div>

      <p className="center-note">
        {total > 0 ? total + " 首在队列里" : "队列空闲"} · 一次只下一个（并发请求会被平台风控）· 落盘「歌手 - 歌名」，带歌词与封面，MP3 会写入标签
      </p>
      {error ? <p className="center-note error" role="alert">{error}</p> : null}

      <div className="track-list center-list" role="list">
        {items.map(item => (
          <div key={item.id} className="track-row download-row" data-state={item.state}>
            <CloudDownload size={14} className={item.state === 'downloading' ? 'spin' : undefined} />
            <span className="track-title">{item.title}</span>
            <span className="track-artist">{item.artist}</span>
            <span className="download-progress mono">
              {item.state === 'downloading' ? Math.round(item.progress * 100) + '%'
                : item.state === 'done' ? '完成'
                : item.state === 'failed' ? '失败'
                : item.state === 'cancelled' ? '已取消' : '排队中'}
            </span>
            <span className="download-extras">{item.extras.join(' · ')}{item.error ? ' · ' + item.error : ''}</span>
            {item.state === 'queued' || item.state === 'downloading'
              ? <button className="row-play" title="取消" onClick={() => void window.twilight.downloadCancel(item.id).then(setItems)}><X size={12} /></button>
              : null}
          </div>
        ))}
        {items.length === 0 ? <p className="center-note">还没有下载。在「全局搜索」里点那朵云即可。</p> : null}
      </div>
    </section>
  )
}
