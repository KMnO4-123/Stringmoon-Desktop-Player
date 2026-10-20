import { useEffect, useState } from 'react'
import { ListMusic } from 'lucide-react'
import { useLibraryData } from '../libraryDataStore'
import { useStreamingUi, type SourceId } from './streamStore'
import type { PlatformId } from '@shared/streaming'

/**
 * 歌单一栏的「来源切换」。
 *
 * 本地歌单是应用自己存的（主进程 JSON），平台歌单是**登录后才看得到**的账号数据。
 * 两者形状不同，所以这里只在本地档调用既有的 onOpenPlaylist，平台档则打开歌曲中心
 * 显示那张歌单 —— 而不是硬把平台歌单塞进本地歌单模型里。
 */
export default function PlaylistRail({ onOpenLocal, onOpenPlatform }: {
  onOpenLocal: (id: string) => void
  onOpenPlatform: () => void
}) {
  const playlists = useLibraryData(state => state.playlists)
  const source = useStreamingUi(state => state.playlistSource)
  const selectSource = useStreamingUi(state => state.selectPlaylistSource)
  const platformPlaylists = useStreamingUi(state => state.playlists)
  const accounts = useStreamingUi(state => state.accounts)
  const loading = useStreamingUi(state => state.loadingPlaylists)
  const error = useStreamingUi(state => state.playlistError)
  const openPlaylist = useStreamingUi(state => state.openPlaylist)
  const loadPlaylists = useStreamingUi(state => state.loadPlaylists)
  const [tab, setTab] = useState<SourceId>(source)

  useEffect(() => { setTab(source) }, [source])

  const pick = (next: SourceId): void => {
    setTab(next)
    void selectSource(next)
    if (next !== 'local') void loadPlaylists(next as PlatformId)
  }

  const list = tab === 'local' ? [] : (platformPlaylists[tab as PlatformId] ?? [])
  const account = tab === 'local' ? null : accounts[tab as PlatformId]

  return (
    <div className="sidebar-playlists" aria-label="我的歌单">
      <div className="sidebar-section-head">
        <span className="nav-label">歌单</span>
        <span className="playlist-source-tabs" role="tablist">
          {(['local', 'netease', 'qq'] as SourceId[]).map(id => (
            <button key={id} role="tab" aria-selected={tab === id} className={'playlist-tab' + (tab === id ? ' active' : '')}
              data-playlist-source={id} onClick={() => pick(id)} title={id === 'local' ? '本地歌单' : id === 'netease' ? '网易云歌单' : 'QQ 歌单'}>
              {id === 'local' ? '本地' : id === 'netease' ? '网易' : 'QQ'}
            </button>
          ))}
        </span>
      </div>

      {tab === 'local'
        ? playlists.slice(0, 6).map(playlist => (
            <button key={playlist.id} className="sidebar-playlist" onClick={() => onOpenLocal(playlist.id)} title={playlist.name}>
              <ListMusic size={13} /> <span>{playlist.name}</span>
              <span className="playlist-count mono">{playlist.entries.length}</span>
            </button>
          ))
        : null}

      {tab !== 'local' ? (
        loading
          ? <p className="sidebar-note">读取歌单…</p>
          : error
            ? <p className="sidebar-note" role="status">{error}</p>
            : account && !account.signedIn
              ? <p className="sidebar-note">登录后可见你的歌单</p>
              : list.length === 0
                ? <p className="sidebar-note">这个账号没有歌单</p>
                : list.slice(0, 6).map(playlist => (
                    <button key={playlist.id} className="sidebar-playlist" title={playlist.name}
                      onClick={() => { openPlaylist({ platform: tab as PlatformId, id: playlist.id, name: playlist.name }); onOpenPlatform() }}>
                      <ListMusic size={13} /> <span>{playlist.name}</span>
                      <span className="playlist-count mono">{playlist.trackCount}</span>
                    </button>
                  ))
      ) : null}
    </div>
  )
}
