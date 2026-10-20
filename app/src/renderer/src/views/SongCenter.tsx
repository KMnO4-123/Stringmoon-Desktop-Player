import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown, ChevronRight, Copy, Download, Heart, KeyRound, ListMusic, Loader2, Music2, Play,
  Plus, RefreshCw, Search, Sparkles, X
} from 'lucide-react'
import { PLATFORM_SPECS, type PlatformAccount, type PlatformId, type PlatformPlaylist, type StreamingStatus, type StreamingTrack } from '@shared/streaming'
import { useTwilight } from '../store'
import { openAndPlay } from '../ipc'
import { playStreamingTrack } from '../streaming/play'
import { useStreamingUi, type SourceId } from '../streaming/streamStore'
import { appendToQueue, playNext } from '../queueActions'
import { withInterpolatedWords } from '@shared/lyrics-interpolate'
import { parseLrc } from '@shared/lrc'
import QrLogin from '../streaming/QrLogin'
import { ensureStreamingReady } from '../streaming/ensureReady'
import { describeLoginError } from '../streaming/loginFlow'

const PAGE = 30

const platformName = (id: PlatformId): string =>
  PLATFORM_SPECS.find(spec => spec.id === id)?.displayName ?? id

/** 毫秒 → m:ss。搜索结果里时长是判断「是不是这一版」最便宜的依据之一。 */
function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

const rowKey = (track: StreamingTrack): string => track.platform + ':' + track.id

/**
 * 歌曲中心：一个地方「找歌、看详情、直接播」。
 *
 * 三种内容共用一块主区：本地曲库搜索结果、平台搜索结果、打开的一张平台歌单。
 * 它们长得一样是因为对用户来说就是「一批可以放的歌」；差异只在**能不能进本地
 * 歌单/队列**（平台曲目没有本地路径，进去也放不了），所以批量操作只在本地那档出现。
 *
 * 布局上这一版修的是三件事：
 *  1. **高度**：整页用 `height: 100%` 交给外层，列表自己滚动，不再用 56vh 把内容
 *     截在页面中间（那会在滚动容器里再套一个滚动区，底部的行看起来像被砍掉）；
 *  2. **栏宽**：账号栏固定 232px、主区 `minmax(0, 1fr)`，主区永远拿剩余宽度，
 *     不会被侧栏挤成一条；窗口窄于 1020px 时侧栏落到上方（不再压主区）；
 *  3. **入口**：账号栏只在平台档出现，但顶部来源切换永远在，所以「为什么左边空了」
 *     这个疑问不存在 —— 本地档的左边本来就是整宽列表。
 */
const formatDuration = (ms: number): string => {
  const total = Math.round(ms / 1000)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

export default function SongCenter() {
  const tracks = useTwilight(state => state.tracks)
  const source = useStreamingUi(state => state.activeSource)
  const selectSource = useStreamingUi(state => state.selectSource)
  const opened = useStreamingUi(state => state.openedPlaylist)
  const openPlaylist = useStreamingUi(state => state.openPlaylist)

  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<StreamingTrack[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  /** 已拿到多少条（翻页游标）与是否还可能更多。 */
  const [searchKeyword, setSearchKeyword] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  /**
   * 主区有两种内容，形状完全不同，所以用一个显式视图而不是"看哪个数组非空"：
   *  - tracks：曲目列表（搜索结果 / 收藏 / 打开的歌单）
   *  - playlists：歌单卡片（我的歌单 / 歌单搜索结果）
   * 「看哪个数组非空」在两者都为空时会退化成猜，用户会分不清现在是"没有"还是"没查"。
   */
  const [view, setView] = useState<'tracks' | 'playlists'>('tracks')
  const [playlists, setPlaylists] = useState<PlatformPlaylist[]>([])
  const [playlistQuery, setPlaylistQuery] = useState('')
  const [account, setAccount] = useState<PlatformAccount | null>(null)
  /** 登录入口：未登录时显示；成功后短暂高亮账号栏（1.6s）。 */
  const [qrOpen, setQrOpen] = useState(false)
  const [loginPending, setLoginPending] = useState(false)
  const [loginFlash, setLoginFlash] = useState(false)
  const [loginError, setLoginError] = useState<{ reason: string; nextStep: string } | null>(null)
  const loginFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 触发按钮：ensureReady 期间按钮 disabled 会丢焦点，必须由父级在事件里记下。 */
  const loginOrigin = useRef<HTMLElement | null>(null)
  const [playlistLabel, setPlaylistLabel] = useState<string>('')
  const [status, setStatus] = useState<StreamingStatus | null>(null)
  /** 展开详情的那一行（key = platform:id）。同一时刻只展开一行，列表不会跳。 */
  const [detailKey, setDetailKey] = useState<string | null>(null)
  /** 详情面板里的歌词预览：按需取，不在搜索时预取。 */
  const [lyricsPreview, setLyricsPreview] = useState<{ key: string; lines: string[]; note: string | null } | null>(null)

  const localMatches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return tracks.slice(0, 80)
    return tracks.filter(track =>
      track.title.toLowerCase().includes(needle) ||
      (track.artist ?? '').toLowerCase().includes(needle) ||
      (track.album ?? '').toLowerCase().includes(needle)
    ).slice(0, 300)
  }, [tracks, query])

  const isLocal = source === 'local'
  const runtime = status?.runtimes.find(item => item.platform === source)

  // 来源状态是「现在能不能搜」的事实来源：服务端没起、没登录，界面要先说清，
  // 而不是让用户点一次搜索再读一条报错。
  const refreshStatus = useCallback((): void => {
    void window.twilight.streamingStatus().then((next) => setStatus(next as StreamingStatus)).catch(() => { /* 读不到就保持上一帧 */ })
  }, [])
  useEffect(() => { if (!isLocal) refreshStatus() }, [isLocal, refreshStatus, source])
  useEffect(() => () => { if (loginFlashTimer.current) clearTimeout(loginFlashTimer.current) }, [])

  const flashLogin = (): void => {
    setLoginFlash(true)
    if (loginFlashTimer.current) clearTimeout(loginFlashTimer.current)
    loginFlashTimer.current = setTimeout(() => { loginFlashTimer.current = null; setLoginFlash(false) }, 1600)
  }

  /** 登录前置：先把按需服务端叫醒（可能几十秒），成功后才开模态。 */
  const openLogin = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (isLocal || source === 'meting') return
    loginOrigin.current = event.currentTarget
    setLoginError(null)
    setLoginPending(true)
    void (async () => {
      try {
        await ensureStreamingReady(source as PlatformId, { onStatus: next => setStatus(next as StreamingStatus) })
        setQrOpen(true)
      } catch (error) {
        setLoginError(describeLoginError(error instanceof Error ? error.message : String(error)))
      } finally {
        setLoginPending(false)
      }
    })()
  }

  /** 登录成功：刷新账号与（若正停在歌单视图）歌单，并给账号栏 1.6s 高亮。 */
  const afterSignedIn = (): void => {
    flashLogin()
    setLoginError(null)
    void (async () => {
      try {
        const [nextAccount, nextStatus] = await Promise.all([
          window.twilight.streamingAccount(source as PlatformId),
          window.twilight.streamingStatus()
        ])
        setAccount(nextAccount as PlatformAccount)
        setStatus(nextStatus as StreamingStatus)
        if (view === 'playlists') {
          const list = await window.twilight.streamingPlaylists(source as PlatformId) as PlatformPlaylist[]
          setPlaylists(list)
        }
      } catch { /* 刷新失败不撤销「已登录」这件事本身 */ }
    })()
  }

  /** 网页登录：只负责真实动作；成功后的刷新/高亮统一由模态的 onSignedIn 做（避免重复拉取）。 */
  const webLogin = async (): Promise<void> => {
    await ensureStreamingReady(source as PlatformId, { onStatus: next => setStatus(next as StreamingStatus) })
    await window.twilight.streamingWebLogin(source as PlatformId)
  }

  // ⚠️ 只跟 source：跟着 opened 一起重置会把「返回歌单」刚设的 playlists 视图再按回 tracks。
  useEffect(() => {
    setSelected(new Set())
    setNotice(null)
    setError(null)
    setView('tracks')
    setPlaylists([])
    setPlaylistLabel('')
    setDetailKey(null)
    setLyricsPreview(null)
  }, [source])

  // 来源变化时读一次账号：收藏与歌单都挂在这个账号上，未登录时要先说清楚。
  useEffect(() => {
    setAccount(null)
    if (source === 'local' || source === 'meting') return
    let alive = true
    void window.twilight.streamingAccount(source)
      .then(next => { if (alive) setAccount(next) })
      .catch(() => { /* 读不到账号不阻断搜索与播放 */ })
    return () => { alive = false }
  }, [source])

  /** 账号动作（收藏 / 歌单 / 歌单搜索）走同一条错误处理路径。 */
  const runAccount = (label: string, task: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    setNotice(null)
    void (async () => {
      try {
        await task()
      } catch (err) {
        setError(label + '失败：' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setBusy(false)
      }
    })()
  }

  const loadLiked = (): void => runAccount('读取收藏', async () => {
    openPlaylist(null)
    const list = await window.twilight.streamingLikedSongs(source as PlatformId) as StreamingTrack[]
    setResults(list)
    setView('tracks')
    setPlaylistLabel('我的收藏')
    if (list.length === 0) setNotice('这个账号还没有收藏的歌。')
  })

  const loadPlaylists = (): void => runAccount('读取歌单', async () => {
    openPlaylist(null)
    const list = await window.twilight.streamingPlaylists(source as PlatformId) as PlatformPlaylist[]
    setPlaylists(list)
    setView('playlists')
    setPlaylistLabel('我的歌单')
    if (list.length === 0) setNotice('这个账号还没有歌单。')
  })

  const searchPlaylists = (): void => runAccount('歌单搜索', async () => {
    const keyword = playlistQuery.trim()
    if (!keyword) return
    openPlaylist(null)
    const list = await window.twilight.streamingSearchPlaylists(source as PlatformId, keyword) as PlatformPlaylist[]
    setPlaylists(list)
    setView('playlists')
    setPlaylistLabel('歌单搜索 · ' + keyword)
    if (list.length === 0) setNotice('没有搜到歌单。')
  })

  const openCard = (playlist: PlatformPlaylist): void => {
    openPlaylist({ platform: playlist.platform, id: playlist.id, name: playlist.name } as never)
    setView('tracks')
  }

  /** 关掉打开的歌单：回到歌单卡片，而不是留一个空列表。 */
  const closePlaylist = (): void => {
    openPlaylist(null)
    setView('playlists')
  }

  // 打开一张平台歌单：直接拉它的曲目，不再要求用户再搜一次。
  useEffect(() => {
    if (!opened) { setResults([]); return }
    let alive = true
    setBusy(true)
    setError(null)
    setView('tracks')
    void (async () => {
      try {
        const list = await window.twilight.streamingPlaylistTracks(opened.platform, opened.id) as StreamingTrack[]
        if (alive) { setResults(list); if (list.length === 0) setNotice('这张歌单是空的。') }
      } catch (err) {
        if (alive) setError('读取歌单失败：' + (err instanceof Error ? err.message : String(err)))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [opened])

  const search = (): void => {
    if (isLocal) return
    const keyword = query.trim()
    if (!keyword) return
    openPlaylist(null)
    setBusy(true)
    setError(null)
    setResults([])
    setPlaylistLabel('')
    setHasMore(false)
    setDetailKey(null)
    setSearchKeyword(keyword)
    void (async () => {
      try {
        const list = await window.twilight.streamingSearch(source as PlatformId, keyword, PAGE, 0) as StreamingTrack[]
        setResults(list)
        // 恰好拿满一页就说明「可能还有」：不假装知道总数（上游总数不可靠），
        // 只提供一个诚实的「加载更多」。
        setHasMore(list.length >= PAGE)
        if (list.length === 0) setNotice('没有搜到结果。QQ 音乐不登录时搜歌常被上游拒绝，先登录试试。')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  /** 追加下一页。失败不清空已有结果——已经看到的不该因为一次翻页失败消失。 */
  const loadMore = (): void => {
    if (isLocal || !searchKeyword || loadingMore) return
    setLoadingMore(true)
    setError(null)
    void (async () => {
      try {
        const list = await window.twilight.streamingSearch(source as PlatformId, searchKeyword, PAGE, results.length) as StreamingTrack[]
        setResults(current => {
          const seen = new Set(current.map(track => track.platform + track.id))
          return current.concat(list.filter(track => !seen.has(track.platform + track.id)))
        })
        setHasMore(list.length >= PAGE)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingMore(false)
      }
    })()
  }

  const playStreaming = (track: StreamingTrack): void => {
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        // playStreamingTrack 先把「正在播的是谁」写进 store，再要直链：
        // 引擎对 URL 源的 state 事件没有 trackId，顺序反了界面就永远停在「未在播放」。
        await playStreamingTrack(track)
        setNotice('正在播放：' + track.title + (track.artist ? ' — ' + track.artist : ''))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const download = (track: StreamingTrack): void => {
    setError(null)
    void window.twilight.downloadAdd(track).then(() => setNotice('已加入下载：' + track.title))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const copyInfo = (track: StreamingTrack): void => {
    const text = [track.title, track.artist, track.album, platformName(track.platform), 'ID ' + track.id].filter(Boolean).join(' · ')
    void navigator.clipboard.writeText(text).then(() => setNotice('已复制：' + text)).catch(() => setNotice(text))
  }

  /** 详情面板里的歌词预览：按需取一次平台歌词，取不到就如实说明。 */
  const previewLyrics = (track: StreamingTrack): void => {
    const key = rowKey(track)
    if (lyricsPreview?.key === key) { setLyricsPreview(null); return }
    setLyricsPreview({ key, lines: [], note: '正在读取平台歌词…' })
    void window.twilight.streamingLyrics(track.platform, { id: track.id, title: track.title, artist: track.artist, album: track.album })
      .then((raw) => {
        const payload = raw as { lrc?: string; translation?: string }
        const parsed = parseLrc((payload?.lrc ?? '') + '\n' + (payload?.translation ?? ''))
        // 行级数据补一次字级时间，只用于这一段预览文本的观感（wordByWord 不被改写）。
        const view = withInterpolatedWords({ lines: parsed.lines, wordByWord: parsed.wordByWord, source: 'netease-lrc' })
        const lines = view.lyrics.lines.map(line => line.text).filter(Boolean).slice(0, 14)
        setLyricsPreview({ key, lines, note: lines.length === 0 ? '这个平台没有给出这首歌的歌词。' : null })
      })
      .catch((err: unknown) => setLyricsPreview({ key, lines: [], note: err instanceof Error ? err.message : String(err) }))
  }

  const toggle = (id: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const localIds = useMemo(() => new Set(localMatches.map(track => track.trackId)), [localMatches])
  const selectAllLocal = (invert = false): void => {
    setSelected(current => {
      if (!invert) return new Set(localMatches.map(track => track.trackId))
      const next = new Set<string>()
      for (const id of localIds) if (!current.has(id)) next.add(id)
      return next
    })
  }

  const runBulk = (label: string, action: () => Promise<number>): void => {
    setNotice(null)
    void (async () => {
      try {
        const count = await action()
        setNotice(label + '：' + count + ' 首')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  /** 平台档的状态句：把「为什么现在搜不了」放在主区顶部，而不是等一次失败。 */
  const sourceStatusText = ((): string => {
    if (isLocal) return '本地曲库'
    if (source === 'meting') return runtime?.state === 'ready' ? '通用源就绪' : '通用源未启动'
    if (runtime?.state === 'ready') return account?.signedIn ? '已登录 · ' + (account.nickname ?? '账号') : '未登录（收藏与歌单要登录）'
    if (runtime?.state === 'starting') return '服务端启动中…'
    if (runtime?.state === 'failed') return '服务端启动失败'
    return '服务端未启动（设置 → 流媒体账户）'
  })()

  const detailOf = (track: StreamingTrack) => rowKey(track) === detailKey

  return (
    <section className="song-center" aria-label="歌曲中心">
      <header className="space-heading center-head">
        <div>
          <span className="section-eyebrow">SONG CENTER</span>
          <h1>歌曲中心</h1>
        </div>
        <div className="center-sources" role="tablist" aria-label="来源切换">
          {(['local', ...PLATFORM_SPECS.map(spec => spec.id)] as SourceId[]).map(id => {
            const ready = id === 'local' || status?.runtimes.find(item => item.platform === id)?.state === 'ready'
            return <button key={id} role="tab" aria-selected={source === id} data-source={id}
              className={'center-source' + (source === id ? ' active' : '')}
              title={ready ? '切换到' + (id === 'local' ? '本地曲库' : platformName(id as PlatformId)) : '服务端未启动'}
              onClick={() => { selectSource(id); openPlaylist(null); setResults([]); setError(null); setNotice(null) }}>
              <i className="center-source-dot" data-on={ready || undefined} aria-hidden="true" />
              {id === 'local' ? '本地' : platformName(id as PlatformId)}
            </button>
          })}
        </div>
      </header>

      <div className="center-body" data-source={source}>
        {/* 账号栏：收藏、歌单、歌单搜索都挂在这个账号上，所以放在主区左边而不是塞进顶栏 */}
        {!isLocal && source !== 'meting' ? (
          <aside className="center-side" aria-label="账号">
            <div className="account-head" data-login-flash={loginFlash ? 'success' : undefined}>
              <span className="account-dot" data-on={account?.signedIn || undefined} aria-hidden="true" />
              <div className="account-copy">
                <strong>{account?.signedIn ? (account.nickname ?? '已登录') : '未登录'}</strong>
                <small>{account?.signedIn ? '账号收藏与歌单' : '登录后可用'}</small>
              </div>
              <button className="quiet-button account-refresh" title="刷新账号与服务端状态" onClick={() => { refreshStatus(); void window.twilight.streamingAccount(source as PlatformId).then(setAccount).catch(() => {}) }}><RefreshCw size={13} /></button>
            </div>
            {!account?.signedIn ? <button className="account-action account-login" disabled={busy || loginPending} onClick={openLogin}>
              <KeyRound size={14} />{loginPending ? '正在准备…' : '登录'}</button> : null}
            {loginError ? <p className="account-status account-login-error" role="alert">
              <span>{loginError.reason}</span><small>{loginError.nextStep}</small></p> : null}
            {loginFlash ? <p className="account-status account-login-ok" role="status">登录成功</p> : null}
            <button className="account-action" disabled={busy} onClick={loadLiked}><Heart size={14} />我的收藏</button>
            <button className="account-action" disabled={busy} onClick={loadPlaylists}><ListMusic size={14} />我的歌单</button>
            <div className="account-search">
              <label htmlFor="playlist-search">歌单搜索</label>
              <div className="account-search-row">
                <input id="playlist-search" aria-label="搜索歌单" placeholder="歌单关键词" value={playlistQuery}
                  onChange={event => setPlaylistQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') searchPlaylists() }} />
                <button className="row-play" title="搜索歌单" disabled={busy || !playlistQuery.trim()} onClick={searchPlaylists}>
                  <Search size={13} /></button>
              </div>
            </div>
            <p className="account-status">{sourceStatusText}</p>
          </aside>
        ) : null}

        {qrOpen && !isLocal && source !== 'meting' ? <QrLogin
          platform={source as PlatformId}
          title={platformName(source as PlatformId)}
          onClose={() => setQrOpen(false)}
          onSignedIn={afterSignedIn}
          onWebLogin={webLogin}
          returnFocusTo={loginOrigin.current}
        /> : null}

        <div className="center-main">
          <div className="center-search">
            <Search size={16} strokeWidth={1.6} className="center-search-icon" />
            <input aria-label="搜索歌曲" placeholder={isLocal ? '在本地曲库里搜索' : ('在' + platformName(source as PlatformId) + '搜索，回车或点搜索')} value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') search() }} />
            {isLocal ? <span className="center-hint">{localMatches.length} 首</span>
              : <button className="topbar-action" disabled={busy || !query.trim()} onClick={search}><Search size={14} />搜索</button>}
          </div>

          <div className="center-toolbar">
            <div className="center-views" role="tablist" aria-label="内容">
              <button role="tab" aria-selected={view === 'tracks'} onClick={() => setView('tracks')}>
                曲目{!isLocal && results.length > 0 ? <b>{results.length}</b> : null}
              </button>
              <button role="tab" aria-selected={view === 'playlists'} onClick={() => setView('playlists')}>
                歌单{playlists.length > 0 ? <b>{playlists.length}</b> : null}
              </button>
            </div>
            {opened ? <button className="quiet-button center-back" onClick={closePlaylist}>
              <ChevronDown size={13} style={{ transform: 'rotate(90deg)' }} />返回歌单
            </button> : null}
            {playlistLabel && view === 'tracks' ? <span className="center-opened"><Heart size={12} />{playlistLabel}</span> : null}
            {opened ? <span className="center-opened"><ListMusic size={13} />{opened.name}
              <button className="quiet-button" title="关闭这张歌单" onClick={closePlaylist}><X size={13} /></button></span> : null}
            {!isLocal ? <span className="center-status mono" data-ready={runtime?.state === 'ready' || undefined}>{sourceStatusText}</span> : null}
          </div>

          {busy ? <p className="center-note"><Loader2 size={13} className="spin" /> 处理中…</p> : null}
          {error ? <p className="center-note error" role="alert">{error}</p> : null}
          {notice ? <p className="center-note" role="status">{notice}</p> : null}

          <div className="center-scroll">
            {view === 'playlists' ? (
              <div className="playlist-cards" role="list" aria-label={playlistLabel || '歌单'}>
                {playlists.map(playlist => (
                  <button key={playlist.id} className="playlist-card" role="listitem" disabled={busy}
                    title={'打开 ' + playlist.name} onClick={() => openCard(playlist)}>
                    <span className="playlist-cover">
                      {playlist.cover ? <img src={playlist.cover} alt="" loading="lazy" /> : <ListMusic size={18} />}
                    </span>
                    <span className="playlist-copy">
                      <strong>{playlist.name}</strong>
                      <small>{playlist.trackCount ? playlist.trackCount + ' 首' : '曲目数未知'} · {platformName(playlist.platform)}</small>
                    </span>
                    <ChevronRight size={14} className="playlist-arrow" />
                  </button>
                ))}
                {playlists.length === 0 && !busy ? <p className="center-note">这里还没有歌单。用左边「我的歌单」或「歌单搜索」。</p> : null}
              </div>
            ) : isLocal ? (
              <>
                <div className="center-bulk" role="group" aria-label="批量操作">
                  <span>{selected.size} 首已选</span>
                  <button className="topbar-action" onClick={() => selectAllLocal(false)}>全选</button>
                  <button className="topbar-action" onClick={() => selectAllLocal(true)}>反选</button>
                  <button className="topbar-action" disabled={selected.size === 0}
                    onClick={() => { const first = [...selected][0]; if (first) void openAndPlay(first, [...selected]) }}><Play size={14} />播放选中</button>
                  <button className="topbar-action" disabled={selected.size === 0}
                    onClick={() => runBulk('已加入队列', () => appendToQueue([...selected]))}><Plus size={14} />加入队列</button>
                  <button className="topbar-action" disabled={selected.size === 0}
                    onClick={() => runBulk('已设为下一首', () => playNext([...selected]))}>下一首播放</button>
                  {selected.size > 0 ? <button className="quiet-button" title="清除选择" onClick={() => setSelected(new Set())}><X size={14} /></button> : null}
                </div>
                <div className="track-list center-list" role="listbox" aria-multiselectable="true">
                  {localMatches.map(track => (
                    <div key={track.trackId} className={'track-row' + (selected.has(track.trackId) ? ' selected' : '')}
                      role="option" aria-selected={selected.has(track.trackId)}
                      onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey) toggle(track.trackId); else void openAndPlay(track.trackId) }}>
                      <input type="checkbox" aria-label={'选择 ' + track.title} checked={selected.has(track.trackId)}
                        onChange={() => toggle(track.trackId)} onClick={event => event.stopPropagation()} />
                      <span className="track-title">{track.title}</span>
                      <span className="track-artist">{track.artist}</span>
                      <span className="track-album">{track.album ?? ''}</span>
                      <span className="track-duration mono">{fmt(track.durationMs)}</span>
                      <button className="row-play" title="立即播放" onClick={event => { event.stopPropagation(); void openAndPlay(track.trackId) }}><Play size={13} /></button>
                    </div>
                  ))}
                  {localMatches.length === 0 ? <p className="center-note">本地曲库里没有匹配的歌。用顶栏「添加文件夹」把音乐放进来。</p> : null}
                </div>
              </>
            ) : (
              <div className="track-list center-list" role="listbox" aria-label="平台搜索、收藏或歌单结果">
                {results.map(track => {
                  const key = rowKey(track)
                  const detail = detailOf(track)
                  return (
                    <div key={key} className={'stream-row' + (detail ? ' open' : '')} role="option" aria-selected={false}>
                      <div className="stream-main" onDoubleClick={() => playStreaming(track)}>
                        <button className="row-play" title="播放" disabled={busy} onClick={() => playStreaming(track)}><Play size={13} /></button>
                        <span className="row-cover" aria-hidden="true">
                          {track.cover ? <img src={track.cover} alt="" loading="lazy" /> : <Music2 size={14} />}
                        </span>
                        <span className="stream-copy">
                          <strong className="track-title">{track.title}</strong>
                          <small>{track.artist || '未知艺人'}{track.album ? ' · ' + track.album : ''}</small>
                        </span>
                        <span className="stream-meta mono">{fmt(track.durationMs)}</span>
                        <span className="source-chip" title={platformName(track.platform)}>{platformName(track.platform)}</span>
                        <button className="row-play" title="下载" onClick={() => download(track)}><Download size={13} /></button>
                        <button className={'quiet-button row-expand' + (detail ? ' open' : '')} aria-expanded={detail}
                          aria-label={detail ? '收起详情' : '展开详情'} title="详情" onClick={() => { setDetailKey(detail ? null : key); if (detail) setLyricsPreview(null) }}>
                          <ChevronDown size={14} />
                        </button>
                      </div>
                      {detail ? (
                        <div className="stream-detail">
                          <div className="stream-detail-cover" aria-hidden="true">
                            {track.cover ? <img src={track.cover} alt="" /> : <Music2 size={22} />}
                          </div>
                          <dl className="stream-facts">
                            <div><dt>平台</dt><dd>{platformName(track.platform)}</dd></div>
                            <div><dt>专辑</dt><dd title={track.album || undefined}>{track.album || '—'}</dd></div>
                            <div><dt>时长</dt><dd>{fmt(track.durationMs)}</dd></div>
                            <div><dt>曲目 ID</dt><dd className="mono" title={track.id}>{track.id}</dd></div>
                            <div><dt>歌词</dt><dd>{lyricsPreview?.key === key ? (lyricsPreview.note ?? (lyricsPreview.lines.length + ' 行')) : '未读取'}</dd></div>
                          </dl>
                          <div className="stream-actions">
                            <button className="topbar-action" onClick={() => playStreaming(track)}><Play size={13} />播放</button>
                            <button className="topbar-action" onClick={() => download(track)}><Download size={13} />下载</button>
                            <button className="topbar-action" onClick={() => previewLyrics(track)}><Sparkles size={13} />{lyricsPreview?.key === key ? '收起歌词' : '查看歌词'}</button>
                            <button className="topbar-action" onClick={() => copyInfo(track)}><Copy size={13} />复制信息</button>
                          </div>
                          {lyricsPreview?.key === key ? (
                            <div className="stream-lyrics">
                              {lyricsPreview.note && lyricsPreview.lines.length === 0
                                ? <p className="center-note">{lyricsPreview.note}</p>
                                : lyricsPreview.lines.map((line, index) => <p key={index}>{line}</p>)}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                {results.length === 0 && !busy ? <p className="center-note">这个来源还没有结果。{source === 'meting' ? '通用源只做搜索与播放，没有登录与歌单。' : '左边可以打开「我的收藏」「我的歌单」或搜歌单。'}</p> : null}
                {hasMore && searchKeyword ? (
                  <button className="topbar-action center-more" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                    {loadingMore ? '加载中…' : '加载更多'}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}