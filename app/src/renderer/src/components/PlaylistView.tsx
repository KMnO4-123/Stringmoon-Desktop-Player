import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Check, ListMusic, Play, Plus, Trash2, X } from 'lucide-react'
import { libraryPathKey } from '@shared/library'
import { useTwilight } from '../store'
import { openAndPlay } from '../ipc'
import { displayTrack } from '../display'
import { filterSearchDocuments, resolvePlaylistEntries, type SearchDocument } from '../libraryModel'
import { useLibraryData } from '../libraryDataStore'

interface Props { documents: SearchDocument[]; query: string; initialPlaylistId?: string }

function searchKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
}

export default function PlaylistView({ documents, query, initialPlaylistId }: Props) {
  const playlists = useLibraryData(state => state.playlists)
  const error = useLibraryData(state => state.error)
  const createPlaylist = useLibraryData(state => state.createPlaylist)
  const renamePlaylist = useLibraryData(state => state.renamePlaylist)
  const deletePlaylist = useLibraryData(state => state.deletePlaylist)
  const removePlaylistEntry = useLibraryData(state => state.removePlaylistEntry)
  // 歌单内的批量选择：路径集合。移除是**逐条**调既有接口，不新增批量命令。
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const reorderPlaylist = useLibraryData(state => state.reorderPlaylist)
  const tracks = useTwilight(state => state.tracks)
  const [selectedId, setSelectedId] = useState(initialPlaylistId ?? '')
  const [newName, setNewName] = useState('')
  const [rename, setRename] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  useEffect(() => {
    if (initialPlaylistId && playlists.some(playlist => playlist.id === initialPlaylistId)) {
      setSelectedId(initialPlaylistId)
      const selected = playlists.find(playlist => playlist.id === initialPlaylistId)
      setRename(selected?.name ?? '')
      return
    }
    if (!playlists.some(playlist => playlist.id === selectedId)) {
      const next = playlists[0]?.id ?? ''
      setSelectedId(next)
      setRename(playlists[0]?.name ?? '')
    }
  }, [playlists, selectedId, initialPlaylistId])

  const playlist = playlists.find(item => item.id === selectedId) ?? null
  const resolved = useMemo(() => playlist ? resolvePlaylistEntries(playlist, documents.map(document => document.track)) : null, [playlist, documents])
  const matchingKeys = useMemo(() => new Set(filterSearchDocuments(documents, query).map(document => document.key)), [documents, query])
  const visibleEntries = useMemo(() => {
    if (!resolved) return []
    const tokens = searchKey(query).trim().split(/\s+/).filter(Boolean)
    return resolved.entries.map((entry, index) => ({ ...entry, index }))
      .filter(entry => !tokens.length || (entry.available
        ? matchingKeys.has(libraryPathKey(entry.path))
        : tokens.every(token => searchKey(entry.path).includes(token))))
  }, [resolved, documents, query, matchingKeys])

  const submitCreate = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    const previous = new Set(playlists.map(item => item.id))
    await createPlaylist(name)
    const created = useLibraryData.getState().playlists.find(item => !previous.has(item.id))
    if (created) {
      setSelectedId(created.id)
      setRename(created.name)
      setNewName('')
    }
  }

  const submitRename = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!playlist || !rename.trim()) return
    await renamePlaylist(playlist.id, rename)
  }

  const removePlaylist = async (): Promise<void> => {
    if (!playlist || !window.confirm(`删除歌单“${playlist.name}”？歌曲文件不会被删除。`)) return
    await deletePlaylist(playlist.id)
  }

  const moveEntry = (index: number, offset: -1 | 1): void => {
    if (!playlist || !resolved) return
    const next = [...resolved.entries]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    void reorderPlaylist(playlist.id, next.map(entry => entry.path)).catch(() => {})
  }

  const reorderEntry = (from: number, to: number): void => {
    if (!playlist || !resolved || from === to || from < 0 || from >= resolved.entries.length || to < 0 || to >= resolved.entries.length) return
    const next = [...resolved.entries]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    void reorderPlaylist(playlist.id, next.map(entry => entry.path)).catch(() => {})
  }

  const playPlaylist = (): void => {
    if (!resolved?.playable.length) return
    void openAndPlay(resolved.playable[0]!.trackId, resolved.playable.map(track => track.trackId))
  }

  return <div className="playlist-workspace">
    <aside className="playlist-sidebar" aria-label="已保存歌单">
      <form className="playlist-create" onSubmit={event => void submitCreate(event).catch(() => {})}>
        <input aria-label="新歌单名称" maxLength={80} placeholder="歌单名称" value={newName} onChange={event => setNewName(event.target.value)} />
        <button className="topbar-action" aria-label="新建歌单" title="新建歌单" disabled={!newName.trim()}><Plus size={15} />新建</button>
      </form>
      <div className="playlist-nav" role="listbox" aria-label="歌单列表">
        {playlists.map(item => <button key={item.id} role="option" aria-selected={item.id === selectedId} className={'playlist-nav-item' + (item.id === selectedId ? ' active' : '')} onClick={() => { setSelectedId(item.id); setRename(item.name) }}>
          <ListMusic size={16} /><span>{item.name}</span><small>{item.entries.length}</small>
        </button>)}
      </div>
      {!playlists.length ? <div className="playlist-empty">还没有保存的歌单。</div> : null}
    </aside>

    <section className="playlist-detail" aria-label={playlist ? '歌单详情 ' + playlist.name : '歌单详情'}>
      {!playlist ? <div className="playlist-empty playlist-empty-main"><ListMusic size={24} /><span>创建一个歌单，整理本地音乐。</span></div> : <>
        <header className="playlist-detail-head">
          <div className="playlist-heading">
            <form className="playlist-rename" onSubmit={event => void submitRename(event).catch(() => {})}>
              <input aria-label="歌单名称" maxLength={80} value={rename} onChange={event => setRename(event.target.value)} />
              <button className="quiet-button" aria-label="保存歌单名称" title="保存名称" disabled={!rename.trim() || rename.trim() === playlist.name}><Check size={15} /></button>
            </form>
            <span className="mono playlist-count">{resolved?.playable.length ?? 0} 首可播放 · {resolved?.entries.length ?? 0} 首已保存</span>
            {(resolved?.entries.length ?? 0) > (resolved?.playable.length ?? 0) ? <span className="playlist-warning" role="status">{(resolved?.entries.length ?? 0) - (resolved?.playable.length ?? 0)} 首文件当前不可用，仍保留在歌单中</span> : null}
          </div>
          <div className="playlist-actions">
            <button className="topbar-action" disabled={!resolved?.playable.length} onClick={playPlaylist}><Play size={14} />播放歌单</button>
            <button className="quiet-button" aria-label="删除歌单" title="删除歌单" onClick={() => void removePlaylist().catch(() => {})}><Trash2 size={16} /></button>
          </div>
          <div className="playlist-bulk" role="group" aria-label="歌单批量操作">
            <span>{selectedPaths.size} 首已选</span>
            <button className="topbar-action" onClick={() => setSelectedPaths(new Set(visibleEntries.map(entry => entry.path)))}>全选</button>
            <button className="topbar-action" onClick={() => setSelectedPaths(current => {
              const next = new Set<string>()
              for (const entry of visibleEntries) if (!current.has(entry.path)) next.add(entry.path)
              return next
            })}>反选</button>
            <button className="topbar-action" disabled={selectedPaths.size === 0} title="从这张歌单移除选中的条目" onClick={() => {
              const paths = [...selectedPaths]
              setSelectedPaths(new Set())
              void (async () => { for (const path of paths) await removePlaylistEntry(playlist.id, path).catch(() => {}) })()
            }}>从歌单移除</button>
          </div>
        </header>
        {error ? <div className="library-data-error" role="status">{error}</div> : null}
        {!resolved?.entries.length ? <div className="playlist-empty playlist-empty-main">歌单为空，可从歌曲列表中选择曲目添加。</div> : !visibleEntries.length ? <div className="playlist-empty playlist-empty-main">没有匹配的歌单曲目。</div> : <div className="playlist-entries" role="list" aria-label={playlist.name + ' 歌曲'}>
          {visibleEntries.map(entry => {
            const track = entry.track
            const display = track ? displayTrack(track) : null
            const title = display?.title ?? (entry.path.split(/[\\/]/).pop() || entry.path)
            return <div className={'playlist-row' + (track ? '' : ' unavailable') + (draggedIndex === entry.index ? ' dragging' : '')} role="listitem" data-playlist-path={entry.path} draggable={true} key={libraryPathKey(entry.path)}
              onDragStart={event => { setDraggedIndex(entry.index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(entry.index)) }}
              onDragOver={event => event.preventDefault()}
              onDrop={event => { event.preventDefault(); reorderEntry(Number(event.dataTransfer.getData('text/plain')), entry.index); setDraggedIndex(null) }}
              onDragEnd={() => setDraggedIndex(null)}>
              <input type="checkbox" aria-label={'选择 ' + title} checked={selectedPaths.has(entry.path)}
                onChange={() => setSelectedPaths(current => {
                  const next = new Set(current)
                  if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path)
                  return next
                })} />
              <span className="playlist-index mono">{String(entry.index + 1).padStart(2, '0')}</span>
              <span className="playlist-track-info"><strong>{title}</strong><small>{track ? display?.artist || '未知艺术家' : '文件当前不可用'}</small></span>
              <span className="playlist-row-actions">
                {track ? <button className="quiet-button" aria-label={'播放 ' + title} title="从这里播放" onClick={() => void openAndPlay(track.trackId, resolved.playable.map(item => item.trackId))}><Play size={15} /></button> : null}
                <button className="quiet-button" aria-label={'上移 ' + title} title="上移" disabled={entry.index === 0} onClick={() => moveEntry(entry.index, -1)}><ArrowUp size={14} /></button>
                <button className="quiet-button" aria-label={'下移 ' + title} title="下移" disabled={entry.index === resolved.entries.length - 1} onClick={() => moveEntry(entry.index, 1)}><ArrowDown size={14} /></button>
                <button className="quiet-button" aria-label={'从歌单移除 ' + title} title="从歌单移除" onClick={() => void removePlaylistEntry(playlist.id, entry.path).catch(() => {})}><X size={14} /></button>
              </span>
            </div>
          })}
        </div>}
      </>}
      {!tracks.length ? <span className="playlist-footnote">将来重新添加曲库目录时，已有歌曲引用会自动恢复。</span> : null}
    </section>
  </div>
}
