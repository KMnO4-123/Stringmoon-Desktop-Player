import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Check, Disc3, FolderCog, FolderPlus, LayoutGrid, ListMusic, Pencil, Play, Plus, RefreshCw, Search, X } from 'lucide-react'
import { libraryPathKey } from '@shared/library'
import type { Track } from '@shared/protocol'
import type { TrackMetadataOverride } from '@shared/track-overrides'
import { useTwilight } from '../store'
import { openAndPlay } from '../ipc'
import { appendToQueue, playNext } from '../queueActions'
import { displayTrack, rawTrackLabel } from '../display'
import { buildSearchDocuments, calculateVirtualRange, filterSearchDocuments, groupArtists, type LibraryFilters, type SearchDocument } from '../libraryModel'
import { useLibraryData } from '../libraryDataStore'
import ArtistArtwork from './ArtistArtwork'
import PlaylistView from './PlaylistView'
import FolderBrowser from './FolderBrowser'

const ROW_HEIGHT = (() => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-height').trim()
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 64
})()
const OVERSCAN = 4
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export type LibraryTab = 'songs' | 'playlists' | 'artists' | 'folders'
type SortField = 'title' | 'artist' | 'album' | 'duration' | 'path'

interface Props {
  onChooseFolder: () => void
  /** 重新扫描全部曲库目录（发现新增、丢掉已删除）。 */
  onRescan?: () => void
  onRemoveDirectory?: (directory: string) => void
  compact?: boolean
  artist?: string
  onArtistReset?: () => void
  onArtistSelect?: (artist: string) => void
  initialTab?: LibraryTab
  playlistId?: string
}

function TrackMetadataEditor({ track, onClose }: { track: Track | null; onClose: () => void }) {
  const overrides = useLibraryData(state => state.overrides)
  const setTrackOverride = useLibraryData(state => state.setTrackOverride)
  const resetTrackOverride = useLibraryData(state => state.resetTrackOverride)
  const error = useLibraryData(state => state.error)
  const [draft, setDraft] = useState<TrackMetadataOverride>({})
  if (!track) return <section className="metadata-editor"><div className="metadata-editor-head"><strong>编辑歌曲信息</strong><button className="quiet-button" aria-label="关闭歌曲信息编辑" onClick={onClose}><X size={15} /></button></div><span className="metadata-note">选择一首歌曲开始修正。</span></section>
  const key = libraryPathKey(track.path)
  const override = overrides[key] ?? {}
  const display = displayTrack(track)
  const fields: { field: keyof TrackMetadataOverride; label: string; value: string; placeholder: string }[] = [
    { field: 'title', label: '标题', value: track.title, placeholder: track.title },
    { field: 'artist', label: '艺术家', value: track.artist, placeholder: display.artist || '未知艺术家' },
    { field: 'album', label: '专辑', value: track.album ?? '', placeholder: '无专辑标签' },
    { field: 'genre', label: '流派', value: track.genre ?? '', placeholder: '无流派标签' },
    { field: 'year', label: '年份', value: track.year === undefined ? '' : String(track.year), placeholder: '无年份标签' }
  ]

  const save = async (field: keyof TrackMetadataOverride): Promise<void> => {
    const value = draft[field]
    if (field === 'year') {
      if (typeof value !== 'string' || !/^\d{4}$/.test(value.trim())) return
      await setTrackOverride(track.path, { year: Number(value) }).catch(() => {})
      return
    }
    if (typeof value !== 'string' || !value.trim()) return
    await setTrackOverride(track.path, { [field]: value.trim() }).catch(() => {})
  }

  return <section className="metadata-editor">
    <div className="metadata-editor-head"><strong>编辑歌曲信息</strong><button className="quiet-button" aria-label="关闭歌曲信息编辑" onClick={onClose}><X size={15} /></button></div>
    <div className="metadata-grid">
      {fields.map(item => {
        const value = draft[item.field] ?? override[item.field]
        return <div className="metadata-field" key={item.field}>
          <label htmlFor={'metadata-' + item.field}>{item.label}</label>
          <input id={'metadata-' + item.field} aria-label={'修正' + item.label} inputMode={item.field === 'year' ? 'numeric' : undefined} maxLength={item.field === 'year' ? 4 : 512}
            value={value === undefined ? '' : String(value)} placeholder={item.placeholder}
            onChange={event => setDraft(current => ({ ...current, [item.field]: event.target.value }))} />
          <button className="quiet-button" aria-label={'保存' + item.label} title={'保存' + item.label} disabled={value === undefined || (item.field === 'year' ? !/^\d{4}$/.test(String(value).trim()) : !String(value).trim())} onClick={() => void save(item.field)}><Check size={14} /></button>
          <button className="quiet-button" aria-label={'重置' + item.label} title={'恢复文件标签'} disabled={override[item.field] === undefined} onClick={() => { void resetTrackOverride(track.path, item.field).catch(() => {}); setDraft(current => ({ ...current, [item.field]: '' })) }}><X size={14} /></button>
        </div>
      })}
    </div>
    {error ? <span className="metadata-error" role="status">{error}</span> : <span className="metadata-note">仅修改 Stringmoon 中的显示信息，不写入音频文件。</span>}
    <button className="text-action metadata-reset-all" disabled={!Object.keys(override).length} onClick={() => { void resetTrackOverride(track.path).catch(() => {}); setDraft({}) }}>恢复全部文件标签</button>
  </section>
}

function sortDocuments(documents: SearchDocument[], field: SortField, direction: 'asc' | 'desc'): SearchDocument[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...documents].sort((left, right) => {
    let result = 0
    if (field === 'duration') result = left.track.durationMs - right.track.durationMs
    else if (field === 'path') result = collator.compare(left.track.path, right.track.path)
    else {
      const a = field === 'title' ? left.display.title : field === 'artist' ? left.display.artist : left.track.album ?? ''
      const b = field === 'title' ? right.display.title : field === 'artist' ? right.display.artist : right.track.album ?? ''
      result = collator.compare(a, b)
    }
    return factor * (result || collator.compare(left.display.title, right.display.title))
  })
}

export default function LibraryList({ onChooseFolder, onRescan, onRemoveDirectory, compact = false, artist, onArtistReset, onArtistSelect, initialTab, playlistId }: Props) {
  const tracks = useTwilight(state => state.tracks)
  const directories = useTwilight(state => state.libraryRoots) ?? []
  const missing = useTwilight(state => state.libraryMissing)
  const loadedTrackId = useTwilight(state => state.loadedTrackId)
  const playState = useTwilight(state => state.playState)
  const scanProgress = useTwilight(state => state.scanProgress)
  const overrides = useLibraryData(state => state.overrides)
  const playlists = useLibraryData(state => state.playlists)
  const dataError = useLibraryData(state => state.error)
  const dataWarnings = useLibraryData(state => state.warnings)
  const addPlaylistEntries = useLibraryData(state => state.addPlaylistEntries)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [tab, setTab] = useState<LibraryTab>(initialTab ?? 'songs')
  const [sortField, setSortField] = useState<SortField>('title')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [filterValues, setFilterValues] = useState({ album: '', genre: '', year: '', codec: '', folder: '' })
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [editingInfo, setEditingInfo] = useState(false)
  const [playlistTarget, setPlaylistTarget] = useState('')
  const [range, setRange] = useState({ start: 0, end: 0 })
  const listRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<string | null>(null)

  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])

  const documents = useMemo(() => buildSearchDocuments(tracks, overrides), [tracks, overrides])
  const filters = useMemo<LibraryFilters>(() => ({
    ...(artist ? { artist } : {}),
    ...(filterValues.album ? { album: filterValues.album } : {}),
    ...(filterValues.genre ? { genre: filterValues.genre } : {}),
    ...(filterValues.year && /^\d{4}$/.test(filterValues.year) ? { year: Number(filterValues.year) } : {}),
    ...(filterValues.codec ? { codec: filterValues.codec } : {}),
    ...(filterValues.folder ? { folder: filterValues.folder } : {})
  }), [artist, filterValues])
  const filtered = useMemo(() => sortDocuments(filterSearchDocuments(documents, deferredQuery, filters), sortField, sortDirection), [documents, deferredQuery, filters, sortField, sortDirection])
  const groups = useMemo(() => groupArtists(filtered.map(document => document.track)), [filtered])
  const visible = compact ? filtered.slice(0, 5) : filtered
  const rendered = compact ? visible : visible.slice(range.start, range.end)
  const selectedDocuments = useMemo(() => documents.filter(document => selectedPaths.has(document.key)), [documents, selectedPaths])
  const windowStart = compact ? 0 : range.start

  const recalc = useCallback((): void => {
    if (compact) return
    const element = listRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const next = calculateVirtualRange(rect.top, window.innerHeight, ROW_HEIGHT, visible.length, OVERSCAN)
    setRange(previous => previous.start === next.start && previous.end === next.end ? previous : next)
  }, [compact, visible.length])

  useLayoutEffect(() => {
    if (compact || tab !== 'songs') return
    recalc()
    const onScroll = (): void => recalc()
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
    }
  }, [recalc, compact, tab, visible.length])

  const focusRow = useCallback((index: number): void => {
    const element = listRef.current
    if (!element) return
    const target = Math.max(0, Math.min(visible.length - 1, index))
    let scroller = element.parentElement
    while (scroller && !/(auto|scroll|overlay)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (scroller) {
      const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const desired = offset + target * ROW_HEIGHT - (scroller.clientHeight - ROW_HEIGHT) / 2
      scroller.scrollTo({ top: Math.max(0, desired), behavior: 'instant' as ScrollBehavior })
    }
    recalc()
    requestAnimationFrame(() => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[data-row-index="' + target + '"]')?.focus()))
  }, [visible.length, recalc])

  const selectRow = (document: SearchDocument, index: number, event: React.MouseEvent | React.KeyboardEvent): void => {
    const key = document.key || document.track.trackId
    if (event.shiftKey && anchorRef.current) {
      const anchor = filtered.findIndex(item => item.key === anchorRef.current)
      const from = anchor < 0 ? index : anchor
      const next = new Set(event.ctrlKey || event.metaKey ? selectedPaths : [])
      for (const item of filtered.slice(Math.min(from, index), Math.max(from, index) + 1)) next.add(item.key)
      setSelectedPaths(next)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths(current => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    } else setSelectedPaths(new Set([key]))
    anchorRef.current = key
  }

  const playSelected = (): void => {
    const first = selectedDocuments[0]
    if (first) void openAndPlay(first.track.trackId, selectedDocuments.map(document => document.track.trackId))
  }

  const addSelectedToPlaylist = (): void => {
    if (!playlistTarget || selectedDocuments.length === 0) return
    void addPlaylistEntries(playlistTarget, selectedDocuments.map(document => document.track.path)).catch(() => {})
  }

  const clearFilters = (): void => {
    setQuery('')
    setFilterValues({ album: '', genre: '', year: '', codec: '', folder: '' })
    onArtistReset?.()
  }

  if (compact && scanProgress && tracks.length === 0) return <div className="list-empty">扫描中 {scanProgress.done}/{scanProgress.total}</div>
  if (compact && tracks.length === 0) return <div className="list-empty"><FolderPlus strokeWidth={1.5} /><span>曲库为空</span><button className="topbar-action" onClick={onChooseFolder}>添加音乐文件夹</button></div>

  return <section className={'library' + (compact ? ' library-compact' : '')} aria-label={compact ? '歌曲速览' : '音乐曲库'}>
    {!compact ? <>
      <div className="library-titlebar"><div><span className="section-eyebrow">本地音乐</span><h1 className="library-title">{artist || '我的曲库'}</h1></div><span className="lib-count">{tab === 'playlists' ? playlists.length + ' 个歌单' : tab === 'folders' ? directories.length + ' 个目录 · ' + tracks.length + ' 首' : filtered.length + ' 首'}</span></div>
      <details className="library-dirs">
        <summary className="dirs-toggle"><FolderCog size={15} strokeWidth={1.5} aria-hidden /><span>{directories.length} 个曲库目录</span>{missing.length > 0 ? <span className="dirs-warn">{missing.length} 个不可用</span> : null}</summary>
        <div className="dirs-panel">
          {directories.length === 0 ? <p className="dirs-empty">还没有曲库目录。添加一个开始建立曲库。</p> : null}
          {directories.map(directory => <div className="dirs-row" key={directory} data-directory={directory}>
            <span className="dirs-path mono" title={directory}>{directory}</span>
            {missing.includes(directory) ? <span className="dirs-flag">不可用</span> : null}
            {onRemoveDirectory ? <button className="dirs-remove" aria-label={'移除目录 ' + directory} title="从曲库移除这个目录（不删除文件）" onClick={() => onRemoveDirectory(directory)}><X size={14} aria-hidden /></button> : null}
          </div>)}
          <button className="dirs-add" onClick={onChooseFolder}><FolderPlus size={15} strokeWidth={1.5} aria-hidden />添加音乐文件夹</button>
          {onRescan ? <button className="dirs-add" onClick={onRescan} title="重新扫描全部曲库目录：发现新拷进来的歌曲，并丢掉已删除的文件"><RefreshCw size={15} strokeWidth={1.5} aria-hidden />重新扫描</button> : null}
        </div>
      </details>
      <div className="library-head">
        <label className="lib-search"><Search strokeWidth={1.5} aria-hidden /><input id="library-search" className="lib-filter" placeholder="搜索标题、艺术家、专辑或文件" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索曲库" /></label>
        {artist ? <button className="filter-chip" onClick={onArtistReset}><span>{artist}</span><X size={14} aria-hidden /><span className="sr-only">清除艺术家筛选</span></button> : null}
        <div className="segmented-control" aria-label="曲库视图">
          <button aria-label="歌曲列表" aria-pressed={tab === 'songs'} onClick={() => setTab('songs')}><ListMusic size={17} />歌曲</button>
          <button aria-label="播放列表" aria-pressed={tab === 'playlists'} onClick={() => setTab('playlists')}><ListMusic size={17} />歌单</button>
          <button aria-label="艺术家瀑布" aria-pressed={tab === 'artists'} onClick={() => setTab('artists')}><LayoutGrid size={17} />艺术家</button>
          <button aria-label="文件夹视图" aria-pressed={tab === 'folders'} onClick={() => setTab('folders')}><FolderCog size={17} />文件夹</button>
        </div>
      </div>
      {tab === 'songs' ? <div className="library-filters" aria-label="曲库筛选">
        <input aria-label="按专辑筛选" placeholder="专辑" value={filterValues.album} onChange={event => setFilterValues(value => ({ ...value, album: event.target.value }))} />
        <input aria-label="按流派筛选" placeholder="流派" value={filterValues.genre} onChange={event => setFilterValues(value => ({ ...value, genre: event.target.value }))} />
        <input aria-label="按年份筛选" placeholder="年份" inputMode="numeric" maxLength={4} value={filterValues.year} onChange={event => setFilterValues(value => ({ ...value, year: event.target.value.replace(/\D/g, '').slice(0, 4) }))} />
        <input aria-label="按格式筛选" placeholder="格式 · FLAC" value={filterValues.codec} onChange={event => setFilterValues(value => ({ ...value, codec: event.target.value }))} />
        <input aria-label="按文件夹筛选" placeholder="曲库文件夹" list="library-folders" value={filterValues.folder} onChange={event => setFilterValues(value => ({ ...value, folder: event.target.value }))} />
        <datalist id="library-folders">{directories.map(directory => <option key={directory} value={directory} />)}</datalist>
        {(query || Object.values(filterValues).some(Boolean) || artist) ? <button className="text-action" onClick={clearFilters}>清除筛选</button> : null}
      </div> : null}
      {tab === 'songs' && tracks.length > 0 ? <>
        <div className="library-tools">
          <label className="library-sort"><span>排序</span><select aria-label="排序方式" value={sortField} onChange={event => setSortField(event.target.value as SortField)}>
            <option value="title">标题</option><option value="artist">艺术家</option><option value="album">专辑</option><option value="duration">时长</option><option value="path">文件路径</option>
          </select></label>
          <button className="text-action" aria-label={sortDirection === 'asc' ? '升序排列' : '降序排列'} onClick={() => setSortDirection(value => value === 'asc' ? 'desc' : 'asc')}>{sortDirection === 'asc' ? '升序' : '降序'}</button>
        </div>
        <div className="library-selection-row" aria-live="polite">
          {selectedPaths.size > 0 ? <div className="library-selection" role="group" aria-label="已选歌曲操作">
            <span>{selectedPaths.size} 首已选</span>
            <button className="topbar-action" onClick={playSelected}><Play size={14} />播放选中</button>
            <button className="topbar-action" title="选中可见的全部歌曲" onClick={() => setSelectedPaths(new Set(visible.map(document => document.key)))}>全选</button>
            <button className="topbar-action" title="反选可见歌曲" onClick={() => setSelectedPaths(current => {
              const next = new Set<string>()
              for (const document of visible) if (!current.has(document.key)) next.add(document.key)
              return next
            })}>反选</button>
            <button className="topbar-action" title="追加到播放队列末尾" onClick={() => {
              void appendToQueue([...selectedPaths].map(key => documents.find(document => document.key === key)?.track.trackId).filter((id): id is string => !!id))
            }}><Plus size={14} />加入队列</button>
            <button className="topbar-action" title="插到当前曲目之后" onClick={() => {
              void playNext([...selectedPaths].map(key => documents.find(document => document.key === key)?.track.trackId).filter((id): id is string => !!id))
            }}>下一首</button>
            <select aria-label="选择目标歌单" value={playlistTarget} onChange={event => setPlaylistTarget(event.target.value)}><option value="">选择歌单</option>{playlists.map(playlist => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}</select>
            <button className="topbar-action" disabled={!playlistTarget} onClick={addSelectedToPlaylist}><Plus size={14} />添加到歌单</button>
            {selectedDocuments.length === 1 ? <button className="topbar-action" aria-label="编辑歌曲信息" aria-pressed={editingInfo} onClick={() => setEditingInfo(value => !value)}><Pencil size={14} />编辑信息</button> : null}
            <button className="quiet-button" aria-label="清除歌曲选择" title="清除选择" onClick={() => setSelectedPaths(new Set())}><X size={15} /></button>
          </div> : null}
        </div>
        {editingInfo ? <TrackMetadataEditor key={selectedDocuments[0]?.key ?? 'no-selection'} track={selectedDocuments[0]?.track ?? null} onClose={() => setEditingInfo(false)} /> : null}
      </> : null}
      {dataError || dataWarnings.length ? <div className="library-data-error" role="status">{dataError || dataWarnings.join(' ')}</div> : null}
    </> : null}

    {!compact && tab === 'playlists' ? <PlaylistView documents={documents} query={deferredQuery} initialPlaylistId={playlistId} /> : null}
    {!compact && tab === 'folders' ? <FolderBrowser tracks={tracks} directories={directories} /> : null}
    {!compact && tab === 'artists' ? <div className="artist-masonry">{groups.map((group, index) => <ArtistArtwork key={group.artist} group={group} index={index} onSelect={name => { setTab('songs'); onArtistSelect?.(name) }} />)}</div> : null}
    {(compact || tab === 'songs') ? <>
      {!tracks.length && !compact ? <div className="list-empty"><span>{scanProgress ? `扫描中 ${scanProgress.done}/${scanProgress.total}` : '曲库为空'}</span><button className="topbar-action" onClick={onChooseFolder}>添加音乐文件夹</button></div> : null}
      {tracks.length > 0 && !visible.length ? <div className="list-empty"><span>没有匹配的歌曲</span><button className="topbar-action" onClick={clearFilters}>清除筛选</button></div> : null}
      {tracks.length > 0 && visible.length > 0 ? <div className="track-list" role="listbox" aria-label="曲库列表" aria-multiselectable={compact ? undefined : true} ref={listRef} aria-rowcount={visible.length} style={compact ? undefined : { height: visible.length * ROW_HEIGHT }}>
        <div className="track-window" style={{ transform: 'translateY(' + windowStart * ROW_HEIGHT + 'px)' }}>
          {rendered.map((document, slot) => {
            const index = windowStart + slot
            const track = document.track
            const loaded = track.trackId === loadedTrackId
            const key = document.key || track.trackId
            const selected = selectedPaths.has(key)
            const corrected = Boolean(overrides[document.key] && Object.keys(overrides[document.key]!).length)
            const seconds = Math.max(0, Math.floor(track.durationMs / 1000))
            return <div key={slot} data-track-id={track.trackId} data-path-key={document.key} data-row-index={index} role="option" aria-rowindex={index + 1} aria-selected={selected} tabIndex={0}
              className={'track-row row-enter' + (loaded ? ' loaded' : '') + (loaded && playState === 'playing' ? ' playing' : '') + (selected ? ' selected' : '')}
              style={{ animationDelay: Math.min(slot, 8) * 25 + 'ms' }}
              onClick={event => selectRow(document, index, event)} onDoubleClick={() => void openAndPlay(track.trackId)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return
                if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); selectRow(document, index, event) }
                if (event.key === 'Enter') { void openAndPlay(track.trackId) }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); focusRow(index + (event.key === 'ArrowDown' ? 1 : -1)) }
              }} title={rawTrackLabel(track)}>
              <span className="track-no">{selected ? <Check size={14} aria-label="已选择" /> : loaded && playState === 'playing' ? <AudioLines size={15} aria-label="正在播放" /> : String(index + 1).padStart(2, '0')}</span>
              <span className="track-thumb" aria-hidden><Disc3 size={22} strokeWidth={1} /></span>
              <span className="track-summary"><span className="track-title"><span className="track-title-copy">{document.display.title}</span>{corrected ? <span className="track-corrected" title="使用了应用内信息修正" aria-label="使用了应用内信息修正"><Pencil size={12} /></span> : null}</span><span className="track-artist">{document.display.artist || '未知艺术家'}{track.album ? ' · ' + track.album : ''}</span></span>
              <span className="track-dur">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
              <button className="track-play" aria-label={'播放 ' + document.display.title} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void openAndPlay(track.trackId) }}><Play size={16} strokeWidth={1.5} /></button>
            </div>
          })}
        </div>
      </div> : null}
    </> : null}
  </section>
}
