import { useMemo, useState } from 'react'
import { ChevronRight, Disc3, Folder, FolderOpen, Play, Plus, SkipForward } from 'lucide-react'
import { openAndPlay } from '../ipc'
import { appendToQueue, playNext } from '../queueActions'

/** 文件夹视图只需要曲目这几个字段（store 的 TrackRow 直接满足）。 */
export interface FolderTrack {
  trackId: string
  title: string
  artist: string
  album?: string
  durationMs: number
  path: string
}

interface DirNode {
  /** 显示名（根节点 = 曲库目录名）。 */
  name: string
  /** 从「全部曲库」到这里的层级；空数组 = 根容器。 */
  segments: string[]
  children: Map<string, DirNode>
  files: FolderTrack[]
  /** 本节点（含所有子层）的曲目数与总时长。 */
  count: number
  totalMs: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
const baseName = (path: string): string => normalize(path).split('/').filter(Boolean).pop() ?? path

function createNode(name: string, segments: string[]): DirNode {
  return { name, segments, children: new Map(), files: [], count: 0, totalMs: 0 }
}

/** 把绝对路径归到「曲库目录 → 相对目录层级」。找不到所属目录时放进「其他位置」。 */
function locate(track: FolderTrack, roots: string[]): { top: string; dirs: string[] } {
  const file = normalize(track.path)
  let bestRoot = ''
  for (const root of roots) {
    const normalized = normalize(root)
    if (!normalized) continue
    if (file === normalized || file.startsWith(normalized + '/')) {
      if (normalized.length > bestRoot.length) bestRoot = normalized
    }
  }
  if (bestRoot) {
    const relative = file.slice(bestRoot.length).replace(/^\/+/, '')
    const parts = relative.split('/').filter(Boolean)
    parts.pop() // 文件名
    return { top: baseName(bestRoot), dirs: parts }
  }
  const parts = file.split('/').filter(Boolean)
  parts.pop()
  return { top: '其他位置', dirs: parts.length > 1 ? parts.slice(1) : [] }
}

function fmtTotal(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分'
  if (minutes > 0) return minutes + ' 分'
  return total + ' 秒'
}
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}
function collectFiles(node: DirNode, out: FolderTrack[] = []): FolderTrack[] {
  out.push(...node.files)
  for (const child of node.children.values()) collectFiles(child, out)
  return out
}

/**
 * 文件夹视图（V3 §1.4「按文件夹」）。
 *
 * 曲库本身没有「文件夹实体」，所以这里完全由曲目绝对路径聚合：根 = 曲库目录名，
 * 逐层进入；每层都能整目录播放/入队。只读展示，不移动、不重命名任何文件。
 */
export default function FolderBrowser({ tracks, directories }: { tracks: readonly FolderTrack[]; directories: readonly string[] }) {
  const [crumbs, setCrumbs] = useState<string[]>([])

  const tree = useMemo(() => {
    const root = createNode('全部曲库', [])
    const rootList = directories.length > 0 ? [...directories] : []
    for (const track of tracks) {
      const { top, dirs } = locate(track, rootList)
      const segments = [top, ...dirs]
      let node = root
      for (const segment of segments) {
        let child = node.children.get(segment)
        if (!child) { child = createNode(segment, [...node.segments, segment]); node.children.set(segment, child) }
        node = child
        node.count += 1
        node.totalMs += track.durationMs
      }
      node.files.push(track)
    }
    return root
  }, [tracks, directories])

  const current = useMemo(() => {
    let node = tree
    for (const segment of crumbs) {
      const child = node.children.get(segment)
      if (!child) return tree
      node = child
    }
    return node
  }, [tree, crumbs])

  const files = useMemo(() => [...current.files].sort((a, b) => collator.compare(a.title, b.title)), [current])
  const children = useMemo(() => [...current.children.values()].sort((a, b) => collator.compare(a.name, b.name)), [current])
  const allIds = useMemo(() => collectFiles(current).map(track => track.trackId), [current])

  const playAll = (): void => { const first = collectFiles(current)[0]; if (first) void openAndPlay(first.trackId, allIds) }
  const enqueueAll = (): void => { if (allIds.length) void appendToQueue(allIds) }
  const queueNextAll = (): void => { if (allIds.length) void playNext(allIds) }

  return (
    <div className="folder-browser" aria-label="文件夹视图">
      <div className="folder-toolbar">
        <nav className="folder-crumbs" aria-label="文件夹层级">
          <button className="folder-crumb" aria-current={crumbs.length === 0 ? 'true' : undefined} onClick={() => setCrumbs([])}>全部曲库</button>
          {crumbs.map((segment, index) => <span className="folder-crumb-group" key={segment + index}>
            <ChevronRight size={13} aria-hidden />
            <button className="folder-crumb" aria-current={index === crumbs.length - 1 ? 'true' : undefined}
              onClick={() => setCrumbs(crumbs.slice(0, index + 1))} title={crumbs.slice(0, index + 1).join(' / ')}>{segment}</button>
          </span>)}
        </nav>
        <div className="folder-actions">
          <span className="folder-summary mono">{current.count} 首 · {fmtTotal(current.totalMs)}</span>
          <button className="topbar-action" disabled={allIds.length === 0} onClick={playAll}><Play size={14} />全部播放</button>
          <button className="topbar-action" disabled={allIds.length === 0} onClick={enqueueAll}><Plus size={14} />加入队列</button>
          <button className="topbar-action" disabled={allIds.length === 0} onClick={queueNextAll}><SkipForward size={14} />下一首</button>
        </div>
      </div>

      {children.length === 0 && files.length === 0 ? <div className="list-empty"><span>{tracks.length === 0 ? '曲库为空，先添加音乐文件夹' : '这个文件夹里没有歌曲'}</span></div> : null}

      {children.length > 0 ? <div className="folder-grid">
        {children.map(child => {
          const childIds = collectFiles(child).map(track => track.trackId)
          return <div className="folder-card" key={child.segments.join('/')}>
            <button className="folder-open" onClick={() => setCrumbs(child.segments)} title={'进入 ' + child.name}>
              <span className="folder-icon" aria-hidden><Folder size={20} strokeWidth={1.4} /></span>
              <span className="folder-copy"><strong>{child.name}</strong><small>{child.count} 首 · {fmtTotal(child.totalMs)}</small></span>
              <FolderOpen size={14} className="folder-enter" aria-hidden />
            </button>
            <div className="folder-card-actions">
              <button className="quiet-button" aria-label={'播放文件夹 ' + child.name} title="播放这个文件夹"
                onClick={() => { const first = collectFiles(child)[0]; if (first) void openAndPlay(first.trackId, childIds) }}><Play size={13} /></button>
              <button className="quiet-button" aria-label={'把文件夹加入队列 ' + child.name} title="把整个文件夹加入队列"
                onClick={() => { if (childIds.length) void appendToQueue(childIds) }}><Plus size={13} /></button>
            </div>
          </div>
        })}
      </div> : null}

      {files.length > 0 ? <div className="folder-files" role="list" aria-label={current.name + ' 中的歌曲'}>
        {files.map(track => <div className="folder-file" role="listitem" key={track.trackId} data-track-id={track.trackId}>
          <span className="folder-file-icon" aria-hidden><Disc3 size={16} strokeWidth={1.3} /></span>
          <span className="folder-file-copy"><strong>{track.title}</strong><small>{[track.artist, track.album].filter(Boolean).join(' · ')}</small></span>
          <span className="folder-file-dur mono">{fmtDuration(track.durationMs)}</span>
          <button className="quiet-button" aria-label={'播放 ' + track.title} title="播放" onClick={() => void openAndPlay(track.trackId)}><Play size={14} /></button>
          <button className="quiet-button" aria-label={'把 ' + track.title + ' 加入队列'} title="加入队列" onClick={() => void appendToQueue([track.trackId])}><Plus size={14} /></button>
        </div>)}
      </div> : null}
    </div>
  )
}
