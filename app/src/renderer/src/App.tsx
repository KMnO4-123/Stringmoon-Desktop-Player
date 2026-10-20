import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react'
import { selectLoadedTrack, useTwilight } from './store'
import { subscribeEngineEvent } from './engineEvents'
import { getPosition } from './positionStore'
import { engineRequest, openAndPlay, seekTo, synchronizeEngine } from './ipc'
import { applyAudioPreferences, resetAudioSupport } from './audio/audioPreferences'
import { dismissResumeOffer, isAutoResumeEnabled, loadResumeOffer, resumePlayback, startPlaybackMemoryRecorder, type ResumeOffer } from './playbackResume'
import { startReplayGain } from './audio/replayGain'
import type { Track } from '@shared/protocol'
import LibraryList from './components/LibraryList'
import { useLibraryData } from './libraryDataStore'
import C1Light from './components/C1Light'
import Playbar from './components/Playbar'
import MusicSpace from './components/MusicSpace'
import AudioControlCenter from './components/AudioControlCenter'
import SettingsPage from './components/SettingsPage'
import SongCenter from './views/SongCenter'
import Discover from './views/Discover'
import GlobalSearch from './views/GlobalSearch'
import Downloads from './views/Downloads'
import { CloudDownload, Compass, FolderPlus, House, Library, Palette, Search, Settings2, SlidersHorizontal, Sparkles } from 'lucide-react'
import { glassInteraction } from './glassInteraction'
import { settle, snap } from './motionPresets'
import { clearArtworkCache, useArtwork, useArtworkHue } from './artwork'
import type { ArtworkResult } from '@shared/artwork'
import { libraryPathKey } from '@shared/library'
import type { CSSProperties } from 'react'
import StartupIntro from './components/startup/StartupIntro'

/**
 * 本次会话已经扫过的目录（归一后的键）。
 *
 * 引擎的 scan 只增不换：同一个目录再扫一次，要么追加一批重复条目，要么（换个
 * 写法时）变成一批新 trackId，两种都不会刷新已有条目（见 CR-013）。
 * ⚠️ 但「重新扫描」按钮要的正是**重新走一遍磁盘**（用户新拷了歌进来），
 * 所以那一条路径用 `replace: true` 按目录替换，而不是沿用这里的跳过规则 ——
 * 只有 replace 才能既发现新增、又丢掉已删除的文件。
 */
const scannedDirectories = new Set<string>()

/** 用于「重新扫描」：绕过会话内跳过，交给调用方用 replace 重扫。 */
export function forgetScannedDirectories(): void {
  scannedDirectories.clear()
}

/**
 * 扫一个目录。
 *
 * `recursive` 与 `probe` 缺省开启（CR-017）：音乐目录通常是「歌手/专辑/曲目」
 * 的多层结构，不递归会漏掉大部分文件；而**入库前用生产解码器验一次**是唯一能
 * 阻止「列表里有、点开报错」的办法 —— 扩展名白名单说不了话，.ogg/.opus 就是证据。
 */
async function scanDirectory(directory: string, timeoutMs: number, options: { replace?: boolean } = {}): Promise<void> {
  const key = libraryPathKey(directory)
  if (!options.replace && scannedDirectories.has(key)) return
  await engineRequest({ cmd: 'scan', path: directory, recursive: true, probe: true, ...(options.replace ? { replace: true } : {}) }, timeoutMs)
  if (!options.replace) scannedDirectories.add(key)
}

/** 用引擎的全量条目刷新曲库。可见集由 store 按曲库目录过滤后算出。 */
async function refreshTracks(): Promise<Track[]> {
  const list = await engineRequest<{ tracks?: Track[] }>({ cmd: 'list_tracks' }, 15000)
  if (!Array.isArray(list?.tracks)) return useTwilight.getState().tracks
  useTwilight.getState().setTracks(list.tracks)
  return useTwilight.getState().tracks
}

/** 「继续上次」里的时间：m:ss，和播放栏同一口径。 */
function fmtResumeTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

/**
 * 启动先握手并恢复权威快照，再按顺序扫描全部曲库目录。冒烟模式下自动播放第一首。
 *
 * 曲库目录是主进程持久化的一整组（首次安装时是内置默认目录）。某个目录不见了
 * （拔掉的盘、删掉的目录）时**不静默**把它从曲库里抹掉，也不换成别的目录：只提示
 * 哪几个不可用，并继续把可用的那些扫进来 —— 一个盘没插不该让整个曲库消失。
 */
async function bootstrap(): Promise<void> {
  const { setProtocolError, setLibraryNotice, setLibraryDirectories, setUnplayablePaths } = useTwilight.getState()
  try {
    await synchronizeEngine()
    // 引擎不记得输出偏好（无状态进程），握手成功后由应用侧重新下发。
    // 输出模式/采样率/延迟档位 + 重采样/dither/声道工具是同一批「无状态设置」。
    resetAudioSupport()
    await applyAudioPreferences().catch(() => { /* 设置下发失败不该阻断启动 */ })
    // 先载入「无法播放」记录，再扫盘：可见集是按它过滤的，顺序反了会让被标记的
    // 曲目在扫描返回的瞬间闪一下又消失。
    const unplayable = await window.twilight.unplayable()
    setUnplayablePaths(unplayable.entries.map((entry) => entry.path))
    const library = await window.twilight.libraryDirs()
    // 先落目录：随后扫回来的条目要按这份目录过滤。
    setLibraryDirectories(library)
    for (const directory of library.directories) {
      if (library.missing.includes(directory)) continue
      await scanDirectory(directory, 60000)
    }
    const tracks = await refreshTracks()
    if (library.missing.length > 0) {
      setLibraryNotice(`${library.missing.length} 个曲库目录不可用：${library.missing.join('、')}`)
    }
    const boot = await window.twilight.bootstrap()
    if (boot.smoke && tracks.length > 0) {
      const first = tracks[0]
      if (first) await openAndPlay(first.trackId) // 走 intent 链路，与手动双击一致
    }
  } catch (err) {
    setProtocolError(String(err instanceof Error ? err.message : err))
  }
}

/**
 * 重新扫描全部曲库目录（用户新拷了歌进来时用）。
 *
 * 用 `replace: true` 按目录重扫，而不是普通的追加扫描：只有替换语义才能同时
 * **发现新增**与**丢掉已删除**。这是用户唯一能主动让磁盘与列表对齐的动作，
 * 所以它必须真的重走磁盘，而不是复用启动时那次结果。
 */
async function rescanAllDirectories(): Promise<void> {
  const { setProtocolError, setLibraryNotice, engineUp } = useTwilight.getState()
  if (!engineUp) { setLibraryNotice('引擎未就绪，暂时无法重新扫描。'); return }
  setLibraryNotice(null)
  try {
    const library = await window.twilight.libraryDirs()
    const usable = library.directories.filter((directory) => !library.missing.includes(directory))
    if (!usable.length) { setLibraryNotice('没有可扫描的曲库目录。'); return }
    forgetScannedDirectories()
    for (const directory of usable) await scanDirectory(directory, 180000, { replace: true })
    await refreshTracks()
    // 重扫后「播不了」的判定也要刷新：文件可能已被替换成好的，或原本好的坏了。
    const records = await window.twilight.unplayable()
    useTwilight.getState().setUnplayablePaths(records.entries.map((entry) => entry.path))
    setLibraryNotice(`已重新扫描 ${usable.length} 个目录。`)
  } catch (err) {
    setProtocolError(String(err instanceof Error ? err.message : err))
  }
}

export default function App() {
  const [startupActive, setStartupActive] = useState(true)
  const [startupReady, setStartupReady] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const finishStartup = useCallback(() => setStartupActive(false), [])
  // 左栏固定 8 项，全部是独立界面，不展开任何二级列表（用户明确要求）。
  // 'immersive' 不在左栏里：它是播放栏那个按钮进入的展示模式，不是第九个功能。
  const [view, setView] = useState<'home' | 'discover' | 'library' | 'center' | 'search' | 'downloads' | 'sound' | 'settings' | 'immersive'>('home')
  const [artist, setArtist] = useState<string | undefined>()
  const [playlistId, setPlaylistId] = useState<string | undefined>()
  const [followTheme, setFollowTheme] = useState(() => { try { return localStorage.getItem('twilight.theme-follow') !== 'off' } catch { return true } })
  const [artworkRevision, setArtworkRevision] = useState(0)
  const [choosingArtwork, setChoosingArtwork] = useState(false)
  /** 「继续上次」入口：只在启动时读一次播放记忆；用户点了才 open+seek（保持暂停）。 */
  const [resumeOffer, setResumeOffer] = useState<ResumeOffer | null>(null)
  /**
   * 自动恢复完成后的提示（v6）。
   *
   * 为什么还要一条提示：自动恢复是「悄悄发生了的事」。静默装载一首歌会让用户
   * 一进界面就以为自己在放它；一句「已回到上次播放 · 暂停」把因果说清楚。
   */
  const [resumeNote, setResumeNote] = useState<string | null>(null)
  const reduced = useReducedMotion()
  const showLibrary = useCallback((name?: string): void => { setArtist(name); setPlaylistId(undefined); setView('library') }, [])
  /** 视图切换回调保持稳定引用：App 因 scanProgress/请求计数重渲染时，子组件才能跳过。 */
  const openSound = useCallback((): void => setView('sound'), [])
  const toggleImmersive = useCallback((): void => setView(current => current === 'immersive' ? 'home' : 'immersive'), [])
  const engineUp = useTwilight((s) => s.engineUp)
  const scanProgress = useTwilight((s) => s.scanProgress)
  const scanDone = useTwilight((s) => s.scanDone)
  const protocolError = useTwilight((s) => s.protocolError)
  const connectionError = useTwilight((s) => s.connectionError)
  const libraryNotice = useTwilight((s) => s.libraryNotice)
  const pendingRequests = useTwilight((s) => s.pendingRequests)
  const playState = useTwilight((s) => s.playState)
  const tracks = useTwilight((s) => s.tracks)
  const loadedTrackId = useTwilight((s) => s.loadedTrackId)
  // 同 MusicSpace：正在播放的曲目从引擎全量列表解析，避免移除目录后界面显示别的歌。
  const displayedTrack = useTwilight(selectLoadedTrack) ?? tracks[0]
  /** 在线曲目：封面是平台 CDN 上的地址，不是本地文件，所以不走 useArtwork 的 IPC 读取。 */
  const online = useTwilight((s) => s.onlineTrack)
  const localArtwork = useArtwork(displayedTrack?.path || undefined, artworkRevision)
  const onlineArtwork: ArtworkResult | null = online?.cover ? { dataUrl: online.cover, source: 'embedded' } : null
  const artwork = online ? onlineArtwork : localArtwork
  // 在线曲目没有 path（空串不是 null，?? 不会回退），所以这里显式用「或」。
  const hue = useArtworkHue(displayedTrack?.path || (online ? online.platform + ':' + online.id : ''), artwork)
  const theme = { '--track-hue': hue } as CSSProperties
  const startedRef = useRef(false)
  const chooseArtwork = useCallback(async (): Promise<void> => {
    const path = displayedTrack?.path
    if (!path || choosingArtwork) return
    setChoosingArtwork(true)
    try {
      const cover = await window.twilight.chooseArtwork(path)
      if (cover) { clearArtworkCache(path); setArtworkRevision(value => value + 1) }
    } catch (error) { useTwilight.getState().setProtocolError(error instanceof Error ? error.message : String(error)) }
    finally { setChoosingArtwork(false) }
  }, [choosingArtwork, displayedTrack?.path])
  /** 撤销自定义封面，回到自动读取。返回结果可能是 null（本来就没有图），照样刷新。 */
  const removeArtwork = useCallback(async (): Promise<void> => {
    const path = displayedTrack?.path
    if (!path || choosingArtwork) return
    setChoosingArtwork(true)
    try {
      await window.twilight.removeArtwork(path)
      clearArtworkCache(path)
      setArtworkRevision(value => value + 1)
    } catch (error) { useTwilight.getState().setProtocolError(error instanceof Error ? error.message : String(error)) }
    finally { setChoosingArtwork(false) }
  }, [choosingArtwork, displayedTrack?.path])

  // 应用侧目录选择（CR-005 方案 1）：拿到路径 → 加入曲库目录 → 契约的 scan → 刷新
  const addDirectory = useCallback(async (): Promise<void> => {
    const dir = await window.twilight.pickFolder()
    if (!dir) return
    const { setProtocolError: setErr, setLibraryNotice, setLibraryDirectories } = useTwilight.getState()
    try {
      const before = await window.twilight.libraryDirs()
      if (before.directories.some(entry => libraryPathKey(entry) === libraryPathKey(dir))) {
        setLibraryNotice('这个目录已经在曲库里了。')
        return
      }
      const next = await window.twilight.addLibraryDir(dir)
      // 主进程只接受存在的绝对目录；没被采纳就说明它不可用，如实说。
      if (!next.directories.some(entry => libraryPathKey(entry) === libraryPathKey(dir))) {
        setLibraryNotice(`没有加入这个目录（不存在或不可访问）：${dir}`)
        return
      }
      // 已经扫过的目录不必再扫：它的条目还在引擎里，重新可见即可。
      if (!next.missing.includes(dir)) {
        await scanDirectory(dir, 120000)
        await refreshTracks()
      }
      setLibraryDirectories(next)
      setLibraryNotice(null)
    } catch (err) {
      setErr(String(err instanceof Error ? err.message : err))
    }
  }, [])
  const chooseFolder = useCallback((): void => { void addDirectory() }, [addDirectory])
  const rescan = useCallback((): void => { void rescanAllDirectories() }, [])
  /**
   * 移除一个曲库目录。不需要重新扫盘：引擎仍留着那些条目（它没有清空命令），
   * 但可见集只认当前目录，所以它们会立刻从界面上消失，重新加回来也同样立刻回来。
   */
  const removeDirectory = useCallback(async (directory: string): Promise<void> => {
    const { setProtocolError: setErr, setLibraryDirectories } = useTwilight.getState()
    try {
      setLibraryDirectories(await window.twilight.removeLibraryDir(directory))
    } catch (err) {
      setErr(String(err instanceof Error ? err.message : err))
    }
  }, [])
  const handleRemoveDirectory = useCallback((directory: string): void => { void removeDirectory(directory) }, [removeDirectory])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const offEvent = subscribeEngineEvent((ev) => {
      useTwilight.getState().applyEvent(ev)
      if (ev.ev === 'ready') {
        void synchronizeEngine(true)
          .then(() => { resetAudioSupport(); return applyAudioPreferences() })
          .catch((err) => useTwilight.getState().setProtocolError(String(err instanceof Error ? err.message : err)))
      }
    })
    const offErr = window.twilight.onProtocolError((line) => useTwilight.getState().setProtocolError('[protocol] ' + line))
    const offDisconnect = window.twilight.onDisconnect((reason) => useTwilight.getState().setConnectionError('播放服务已断开：' + reason))
    // 主进程刚把一首歌标记为无法播放（播放时解码失败）：立刻把它从列表里去掉。
    // 监听这条而不是让主进程直接改渲染层状态，是因为标记必须落在**主进程**才持久，
    // 而界面只需要知道"记录变了，重新取一次"。
    const offUnplayable = window.twilight.onUnplayableChanged(() => {
      void window.twilight.unplayable()
        .then((report) => useTwilight.getState().setUnplayablePaths(report.entries.map((entry) => entry.path)))
        .catch(() => { /* 记录读取失败不该打断播放 */ })
    })
    void useLibraryData.getState().load().then(() => {
      const warning = useLibraryData.getState().warnings.join(' ')
      if (warning) useTwilight.getState().setLibraryNotice(warning)
    }).catch(() => useTwilight.getState().setLibraryNotice('本地歌单或歌曲信息读取失败。'))
    let mounted = true
    void bootstrap()
      .then(async () => {
        if (!mounted) return
        // ReplayGain 只在用户开启后动作；订阅挂在这里，避免每个组件各自监听引擎事件。
        startReplayGain()
        /**
         * 顺序很重要：**先读记忆，再挂记忆记录器**。
         *
         * 记录器会监听 store 变化并立刻 saveNow()。重开应用时 store 的 playState 在
         * 引擎 state 事件到达前是 no-track，到达后变成 stopped —— 这个变化会让记录器
         * 用「位置 0」覆盖掉刚读出来的记忆。v6 e2e 实测过：自动恢复因此总是回到 0:00。
         * 所以先把 offer 读到手（它已经是一条快照），恢复完成后再开始记录。
         */
        const offer = await loadResumeOffer()
        if (!mounted) { return }
        if (!offer) { startPlaybackMemoryRecorder(); return }
        if (!isAutoResumeEnabled()) {
          // 用户关了自动恢复：保留启动横幅，点一下才装载。
          setResumeOffer(offer)
          return
        }
        // 自动恢复：open → seek → **保持暂停**，绝不自动出声。
        // 失败（曲目被移走 / 引擎还没起来）就退回手动入口 —— 比一个静默失败好。
        const restored = await resumePlayback(offer).catch(() => false)
        if (!mounted) return
        if (restored) {
          setResumeOffer(null)
          setResumeNote('已回到上次播放：' + offer.track.title + ' · ' + fmtResumeTime(offer.positionMs) + '（暂停）')
        } else {
          setResumeOffer(offer)
        }
        // 恢复完成（或失败后已退出手动入口）才挂记录器：见上面那段顺序说明。
        startPlaybackMemoryRecorder()
      })
      .catch(() => { /* bootstrap 内部已把错误写进 store */ })
      .finally(() => { if (mounted) setStartupReady(true) })
    return () => {
      mounted = false
      offEvent()
      offErr()
      offDisconnect()
      offUnplayable()
    }
  }, [])

  // 键盘：空格 播放/暂停；←/→ 快退/快进 5s（输入框聚焦时不接管）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') { setView(current => current === 'immersive' ? 'home' : current); return }
      if (e.target instanceof Element && e.target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]')) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (e.code === 'KeyF') { e.preventDefault(); setView(current => current === 'immersive' ? 'home' : 'immersive'); return }
      const s = useTwilight.getState()
      if (s.playState === 'no-track' || s.playState === 'loading') return
      if (e.code === 'Space') {
        e.preventDefault()
        void engineRequest(s.playState === 'playing' ? { cmd: 'pause' } : { cmd: 'play' })
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault()
        const delta = e.code === 'ArrowRight' ? 5000 : -5000
        const pos = getPosition()
        const target = Math.min(Math.max(0, pos.positionMs + delta), Math.max(1, pos.durationMs || s.durationMs))
        void seekTo(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <MotionConfig reducedMotion="user"><div className="app-window" data-startup={startupActive ? 'active' : 'complete'}><div ref={contentRef} inert={startupActive} aria-hidden={startupActive || undefined} data-view={view} data-theme-follow={followTheme} className={'app-shell' + (playState === 'playing' ? ' playing' : '')} style={theme}>
      <header className="topbar">
        <C1Light />
        <img className="brand-icon" src="./stringmoon-icon.png" alt="" /><span className="brand">Stringmoon</span>
        <button className="topbar-action glass-surface" {...glassInteraction} onClick={() => void addDirectory()} title="添加音乐文件夹到曲库">
          <FolderPlus strokeWidth={1.5} aria-hidden />添加文件夹
        </button>
        <button className="topbar-action theme-follow" aria-label="歌曲主题色跟随" aria-pressed={followTheme} title={followTheme ? '关闭歌曲主题色跟随' : '开启歌曲主题色跟随'} onClick={() => {
          setFollowTheme(!followTheme)
          try { localStorage.setItem('twilight.theme-follow', followTheme ? 'off' : 'on') } catch { /* Session preference still works. */ }
        }}><Palette size={16} strokeWidth={1.5} /><span>随曲主题</span></button>
        <span className="topbar-status mono">
          {engineUp ? '已连接' : '连接中…'}
          {scanProgress ? (
            <span className="dim">
              {' '}
              · 扫描 {scanProgress.done}/{scanProgress.total}
            </span>
          ) : scanDone ? (
            <span className="dim"> · 曲库就绪</span>
          ) : null}
        </span>
      </header>

      <nav className="sidebar" aria-label="导航">
        <span className="nav-label">聆听</span>
        {([{ id: 'home', label: '音乐空间', icon: House }, { id: 'discover', label: '发现', icon: Sparkles }, { id: 'library', label: '我的曲库', icon: Library }, { id: 'center', label: '歌曲中心', icon: Compass }, { id: 'search', label: '全局搜索', icon: Search }, { id: 'downloads', label: '下载', icon: CloudDownload }, { id: 'sound', label: '音频', icon: SlidersHorizontal }] as const).map(item => <button key={item.id} data-view-target={item.id} className={'nav-item' + (view === item.id ? ' active glass-surface' : '')} {...glassInteraction} aria-current={view === item.id ? 'page' : undefined} onClick={() => { if (item.id === 'library') { setArtist(undefined); setPlaylistId(undefined) } setView(item.id) }} title={item.label}><item.icon strokeWidth={1.5} aria-hidden /><span>{item.label}</span></button>)}
        <div className="sidebar-foot"><button className={'nav-item' + (view === 'settings' ? ' active glass-surface' : '')} {...glassInteraction} data-view-target="settings" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')} title="设置"><Settings2 strokeWidth={1.5} aria-hidden /><span>设置</span></button><span className="mono sidebar-signature">Stringmoon</span></div>
      </nav>

      <main className="main">
        {/* 视图切换只动 opacity 与 y，用快速弹簧（snap）。
            两处刻意的取舍，都有实测依据：
            ① **不要整屏 filter: blur()** —— 它是大面积逐帧模糊（MASTER-B-app 红线 6，参考实现 Folia 就栽在这里：
               全屏 backdrop-blur 逐帧重绘 → INP 864ms），而且是退出弹簧里最后收敛的那一项：
               实测退出动画 306ms 视觉到位，却要 554ms 才判完成，而 mode="wait" 必须等它判完成才挂载新视图。
            ② 弹簧换 snap（response 0.18s）：settle 的 0.42s 让导航显得迟滞。 */}
          <AnimatePresence initial={false}><motion.div key={view === 'home' || view === 'immersive' ? 'listening' : view} className={'view-layer view-' + view} initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? {} : { opacity: 0, y: -8 }} transition={snap}>
          {view === 'home' || view === 'immersive' ? <MusicSpace artwork={artwork} onChooseArtwork={choosingArtwork || !displayedTrack?.path ? undefined : () => void chooseArtwork()} onRemoveArtwork={choosingArtwork || !displayedTrack?.path ? undefined : () => void removeArtwork()} onLibrary={showLibrary} onSound={openSound} onImmersive={toggleImmersive} onChooseFolder={chooseFolder} immersive={view === 'immersive'} /> : null}
          {view === 'discover' ? <Discover /> : null}
          {view === 'library' ? <LibraryList onChooseFolder={chooseFolder} onRescan={rescan} onRemoveDirectory={handleRemoveDirectory} artist={artist} playlistId={playlistId} initialTab={playlistId ? 'playlists' : undefined} onArtistSelect={setArtist} onArtistReset={() => setArtist(undefined)} /> : null}
          {view === 'center' ? <SongCenter /> : null}
          {view === 'search' ? <GlobalSearch /> : null}
          {view === 'downloads' ? <Downloads /> : null}
          {/* 音频控制中心：四个 tab（均衡/声场与空间/输出与解码/限幅与响度）。
              .sound-page 这层壳保留 —— e2e 用 `.sound-page .frequency-panel` 断言
              「切到音效页能立刻看到 EQ 面板」，而 eq 是默认 tab。 */}
          {view === 'sound' ? <div className="sound-page"><AudioControlCenter /></div> : null}
          {view === 'settings' ? <SettingsPage /> : null}
        </motion.div></AnimatePresence>
      </main>

      {pendingRequests > 0 ? <div className="topbar-progress" aria-hidden /> : null}
      {/* 两个横幅都会出现在底部同一带：放进同一个纵向堆叠里，否则会互相盖住。 */}
      {libraryNotice || protocolError || connectionError || resumeOffer || resumeNote ? <div className="banner-stack">
        {resumeNote ? <div className="proto-banner notice-banner" role="status" data-resume-restored="true">
          <span>{resumeNote}</span>
          <button className="topbar-action" onClick={() => setResumeNote(null)}>知道了</button>
        </div> : null}
        {resumeOffer ? <div className="proto-banner notice-banner" role="status">
          <span>继续上次：{resumeOffer.track.title} · {fmtResumeTime(resumeOffer.positionMs)}</span>
          <button className="topbar-action" onClick={() => {
            const offer = resumeOffer
            if (!offer) return
            setResumeOffer(null)
            void resumePlayback(offer).then(ok => {
              if (!ok) useTwilight.getState().setProtocolError('无法恢复上次播放：曲目可能已被移走。')
            }).catch(() => useTwilight.getState().setProtocolError('无法恢复上次播放。'))
          }}>继续</button>
          <button className="topbar-action" onClick={() => { setResumeOffer(null); void dismissResumeOffer() }}>忽略</button>
        </div> : null}
        {libraryNotice ? <div className="proto-banner notice-banner" role="status"><span>{libraryNotice}</span><button className="topbar-action" onClick={() => useTwilight.getState().setLibraryNotice(null)}>知道了</button></div> : null}
        {protocolError || connectionError ? <div className="proto-banner" role="alert"><span>{protocolError ?? connectionError}</span><button className="topbar-action" onClick={() => {
          if (protocolError) useTwilight.getState().setProtocolError(null)
          else void synchronizeEngine().catch(err => useTwilight.getState().setConnectionError(String(err instanceof Error ? err.message : err)))
        }}>{protocolError ? '关闭提示' : '重试连接'}</button></div> : null}
      </div> : null}

      <Playbar artwork={loadedTrackId || online ? artwork : null} onImmersive={toggleImmersive} immersive={view === 'immersive'} />
    </div>{startupActive ? <StartupIntro ready={startupReady} contentRef={contentRef} onComplete={finishStartup} /> : null}</div></MotionConfig>
  )
}