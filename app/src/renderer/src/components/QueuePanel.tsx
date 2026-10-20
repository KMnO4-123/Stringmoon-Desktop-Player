import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, ListMusic, Play, Trash2, X } from 'lucide-react'
import { useTwilight } from '../store'
import { openAndPlay } from '../ipc'
import { clearQueue, QUEUE_SORT_LABEL, removeFromQueue, reorderQueue, sortQueue, type QueueSortField } from '../queueActions'

const SORT_FIELDS: readonly QueueSortField[] = ['folder', 'title', 'artist', 'duration', 'added']

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

/**
 * 播放队列抽屉（V3 §1.4）。
 *
 * 三种操作都遵守同一条纪律：**引擎是队列的唯一权威**。界面从不自己维护一份
 * 「我以为的队列」——拖拽、删除、排序都先读 get_state.queue 再 set_queue，
 * 成功后 store.queueIds 跟着更新；失败则两边都不变，不会出现「界面动了、播放没动」。
 * 排序只改变播放顺序，不动文件与曲库。
 */
export default function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queueIds = useTwilight(state => state.queueIds)
  const tracks = useTwilight(state => state.tracks)
  const loadedTrackId = useTwilight(state => state.loadedTrackId)
  const [sortField, setSortField] = useState<QueueSortField>('added')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const dragIndex = useRef<number | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const byId = useMemo(() => new Map(tracks.map(track => [track.trackId, track])), [tracks])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open, onClose])

  if (!open) return null

  const run = (task: () => Promise<void>): void => {
    setBusy(true)
    setNotice(null)
    void (async () => {
      try { await task() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
    })()
  }

  return (
    <div className="queue-overlay" role="dialog" aria-modal="true" aria-label="播放队列">
      <button className="queue-backdrop" aria-label="关闭播放队列" onClick={onClose} />
      <aside className="queue-drawer">
        <header className="queue-head">
          <div><span className="section-eyebrow">PLAY QUEUE</span><h2>播放队列</h2></div>
          <span className="queue-count mono">{queueIds.length} 首</span>
          <button className="quiet-button queue-close" aria-label="关闭播放队列" ref={closeRef} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="queue-toolbar">
          <div className="segmented-control queue-sort" role="group" aria-label="队列排序">
            {SORT_FIELDS.map(field => <button key={field} aria-pressed={sortField === field} disabled={busy || queueIds.length === 0}
              onClick={() => { setSortField(field); run(() => sortQueue(field, direction)) }}>{QUEUE_SORT_LABEL[field]}</button>)}
          </div>
          <button className="topbar-action queue-direction" aria-pressed={direction === 'desc'} disabled={busy || queueIds.length === 0}
            title="升序/降序" onClick={() => { const next = direction === 'asc' ? 'desc' : 'asc'; setDirection(next); run(() => sortQueue(sortField, next)) }}>
            {direction === 'asc' ? '升序' : '降序'}</button>
          <button className="topbar-action queue-clear" disabled={busy || queueIds.length === 0} onClick={() => run(clearQueue)}>清空</button>
        </div>

        {notice ? <p className="queue-notice" role="status">{notice}</p> : null}

        {queueIds.length === 0 ? <div className="queue-empty">
          <ListMusic strokeWidth={1.5} />
          <p>队列是空的：在曲库或歌单里用「加入队列 / 下一首」把它填起来。</p>
        </div> : <div className="queue-list" role="list">
          {queueIds.map((id, index) => {
            const track = byId.get(id)
            const current = id === loadedTrackId
            return (
              <div key={id} className={'queue-row' + (current ? ' current' : '')} role="listitem" tabIndex={0}
                draggable
                aria-current={current ? 'true' : undefined}
                onDragStart={event => { dragIndex.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)) }}
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                onDrop={event => {
                  event.preventDefault()
                  const from = dragIndex.current ?? Number(event.dataTransfer.getData('text/plain'))
                  dragIndex.current = null
                  if (Number.isInteger(from) && from >= 0) run(() => reorderQueue(from, index))
                }}
                onDoubleClick={() => { void openAndPlay(id) }}
                onKeyDown={event => {
                  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    event.preventDefault()
                    run(() => reorderQueue(index, index + (event.key === 'ArrowUp' ? -1 : 1)))
                  }
                }}>
                <span className="queue-grip" aria-hidden><GripVertical size={14} /></span>
                <span className="queue-index mono">{String(index + 1).padStart(2, '0')}</span>
                <span className="queue-copy"><strong>{track?.title ?? '不在本地曲库'}</strong><small>{track ? [track.artist, track.album].filter(Boolean).join(' · ') : id}</small></span>
                <span className="queue-dur mono">{track ? fmtDuration(track.durationMs) : '—'}</span>
                <span className="queue-row-actions">
                  <button className="quiet-button" aria-label={'上移 ' + (track?.title ?? id)} title="上移" disabled={busy || index === 0} onClick={() => run(() => reorderQueue(index, index - 1))}><ArrowUp size={14} /></button>
                  <button className="quiet-button" aria-label={'下移 ' + (track?.title ?? id)} title="下移" disabled={busy || index === queueIds.length - 1} onClick={() => run(() => reorderQueue(index, index + 1))}><ArrowDown size={14} /></button>
                  <button className="quiet-button" aria-label={'播放 ' + (track?.title ?? id)} title="播放这首" onClick={() => { void openAndPlay(id) }}><Play size={14} /></button>
                  <button className="quiet-button" aria-label={'移出队列 ' + (track?.title ?? id)} title="移出队列" disabled={busy} onClick={() => run(() => removeFromQueue([id]))}><Trash2 size={14} /></button>
                </span>
              </div>
            )
          })}
        </div>}
      </aside>
    </div>
  )
}
