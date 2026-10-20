/**
 * 发现页（v4）：每日推荐 / 私人漫游 / 排行榜 / 推荐歌单 + 曲目详情抽屉。
 *
 * 三条约束决定了这里的写法：
 *
 * 1. **不做后台轮询**（CONTRACT §5）。这一页只在「用户打开 / 点刷新 / 点重试」时取数，
 *    离开页面就停。平台层同平台请求 ≥1s 串行，所以首屏是一次性扇出 4~5 个请求，
 *    而不是每个区块各自定时刷新。
 *
 * 2. **区块各自失败**。discoverHome 内部已经 allSettled，单区块失败不能拖垮整页；
 *    重试也只重取那一个区块（主进程有 5~10 分钟缓存，健康的区块不会因此再打上游）。
 *
 * 3. **在线曲目与本地队列是两条路**。引擎的 set_queue 只认曲库 trackId，而在线曲目的
 *    id 带 online: 前缀（store.ts:305 明确写了它不参与任何引擎命令）。所以这一页的
 *    「加入在线播放列表」维护的是**页内**在线播放顺序，从不写引擎队列 —— 假装能用
 *    queueActions.appendToQueue 会往引擎塞一批打不开的 id。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown, CircleAlert, Loader2, LogIn, Music2, Play, Plus, RefreshCw, Sparkles, Trophy, X
} from 'lucide-react'
import type {
  DiscoverHome, DiscoverPlatform, DiscoverPlaylist, DiscoverPlaylistsPage, DiscoverToplist, DiscoverTracksResult
} from '@shared/discover'
import type { StreamingTrack } from '@shared/streaming'
import { playStreamingTrack } from '../streaming/play'
import { subscribeEngineEvent } from '../engineEvents'
import { useTwilight } from '../store'
import '../styles/discover.css'

type SectionKey = 'daily' | 'fm' | 'toplists' | 'playlists'
type DetailKind = 'toplist' | 'playlist'

interface DetailTarget {
  kind: DetailKind
  id: string
  name: string
  cover: string | null
}

/**
 * 首屏缓存（渲染层，60 秒）。
 *
 * 用途只有一个：**切走再切回不重新打平台**。主进程虽然也有 5~10 分钟缓存，但每次
 * 重新挂载仍会走一遍 IPC 与四个区块的组装；这里让「回到发现页」直接命中内存快照。
 * 点「刷新发现」会显式绕过它。
 */
const HOME_CACHE_MS = 60_000
/** 平台选择记在本地：用户切到 QQ 后，下次打开发现页仍是 QQ。 */
const PLATFORM_KEY = 'stringmoon.discover-platform'
let homeCache: { at: number; platform: DiscoverPlatform; home: DiscoverHome } | null = null
/** 公开歌单广场的首屏页单独缓存：它走的是另一条 IPC，刷新时也可能各自成功/失败。 */
let playlistCache: { at: number; platform: DiscoverPlatform; page: DiscoverPlaylistsPage } | null = null

/** 各平台在发现页上的叫法。QQ 的「漫游」是刷歌模式的雷达，不能直接叫私人漫游。 */
const PLATFORM_LABELS: Record<DiscoverPlatform, { name: string; daily: string; fm: string; playlists: string }> = {
  netease: { name: '网易云', daily: '每日推荐', fm: '私人漫游', playlists: '推荐歌单' },
  qq: { name: 'QQ 音乐', daily: '每日 30 首', fm: '刷歌雷达', playlists: '推荐歌单' }
}

function readStoredPlatform(): DiscoverPlatform {
  try {
    return localStorage.getItem(PLATFORM_KEY) === 'qq' ? 'qq' : 'netease'
  } catch {
    return 'netease'
  }
}

/* ------------------------------------------------------------------ */
/* 在线播放列表：只在用户显式「播放全部 / 加入在线播放列表」后存在        */
/* ------------------------------------------------------------------ */

/**
 * 为什么这里自己维护一条**在线播放列表**，而不是 queueActions.appendToQueue：
 *
 * 引擎的 set_queue 只认曲库 trackId（AI 侧 player.cpp 的 queue_ 是 open 过的本地条目），
 * 而在线曲目的 id 带 "online:" 前缀、根本不在曲库里（store.ts:305 明确写了它不参与
 * 任何引擎命令）。把在线条目塞进引擎队列的后果不是「不生效」，而是**更糟**：
 * 队列高亮/下一首/重排会指向一批打不开的 id，用户在播放栏看到的是错位。
 *
 * 所以在线播放走 playStreamingTrack 单曲直出（一次一个 URL token），本模块只负责
 * 「播完这一首，接着播下一首」的顺序。它**从不**写引擎队列，也不与本地队列混排。
 */
let onlineQueue: StreamingTrack[] = []
let onlineCursor = -1
let onlineSubscribed = false
/** 订阅者：让界面能显示「在线列表 N 首」（模块级状态本身不触发 React 渲染）。 */
const onlineListeners = new Set<() => void>()

function publishOnlineQueue(): void {
  for (const listener of [...onlineListeners]) listener()
}

function subscribeOnlineQueue(listener: () => void): () => void {
  onlineListeners.add(listener)
  return () => { onlineListeners.delete(listener) }
}

function onlineQueueLength(): number {
  return onlineQueue.length
}

/** 在线播放列表快照（「播放在线列表」按钮用；拷贝一份，调用方改不了模块状态）。 */
function onlineQueueSnapshot(): StreamingTrack[] {
  return [...onlineQueue]
}

const trackKey = (track: StreamingTrack): string => track.platform + ':' + track.id

/**
 * 播放队列推进：只认引擎的 ended(eof)，不轮询。
 *
 * 守卫是必要的：本地曲目播完也会发 eof，如果那时我们手里还留着一条在线队列，
 * 就会把用户刚放的本地歌顶掉。所以只有当「引擎当前在播的在线曲目就是我们排的那一首」时
 * 才推进。
 */
function ensureOnlineQueueSubscription(): void {
  if (onlineSubscribed) return
  onlineSubscribed = true
  subscribeEngineEvent((event) => {
    if (onlineQueue.length === 0) return
    if (event.ev === 'ended') {
      if (event.reason !== 'eof') return
      const current = useTwilight.getState().onlineTrack
      const expected = onlineCursor >= 0 ? onlineQueue[onlineCursor] : undefined
      if (!current || !expected || trackKey(current) !== trackKey(expected)) {
        onlineQueue = []
        onlineCursor = -1
        publishOnlineQueue()
        return
      }
      const next = onlineQueue[onlineCursor + 1]
      if (!next) {
        onlineQueue = []
        onlineCursor = -1
        publishOnlineQueue()
        return
      }
      onlineCursor += 1
      void playStreamingTrack(next).catch(() => {
        onlineQueue = []
        onlineCursor = -1
        publishOnlineQueue()
      })
      return
    }
    if (event.ev === 'state' && event.state === 'stopped') {
      onlineQueue = []
      onlineCursor = -1
      publishOnlineQueue()
    }
  })
}

function startOnlineQueue(list: StreamingTrack[]): void {
  ensureOnlineQueueSubscription()
  onlineQueue = [...list]
  onlineCursor = 0
  publishOnlineQueue()
}

function appendOnlineQueue(list: StreamingTrack[]): number {
  ensureOnlineQueueSubscription()
  const present = new Set(onlineQueue.map(trackKey))
  const additions = list.filter(track => !present.has(trackKey(track)))
  onlineQueue = [...onlineQueue, ...additions]
  if (onlineCursor < 0 && onlineQueue.length > 0) onlineCursor = 0
  publishOnlineQueue()
  return additions.length
}

function clearOnlineQueue(): void {
  onlineQueue = []
  onlineCursor = -1
  publishOnlineQueue()
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

function fmtCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count >= 10000) return (count / 10000).toFixed(count >= 100000 ? 0 : 1) + ' 万'
  return String(Math.round(count))
}

function fmtTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

const CATEGORIES = ['全部', '华语', '欧美', '日韩', '电子', '民谣', '摇滚', '古典', '轻音乐']

/**
 * 把异常剥成一层中文句子。
 *
 * Electron 的 IPC 失败会把主进程栈包进
 *   "Error invoking remote method 'twilight:discover-home': Error: xxx"
 * 直接显示给用户就是一堆英文噪声；这里剥掉前缀，只留真正的原因。
 * 后端自己给出的文案已经是一层中文 + 下一步，原样透传，不再包装第二层。
 */
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const text = raw.trim()
  if (!text) return '这次操作没有成功，请稍后重试。'
  const stripped = text
    .replace(/^(?:Error:\s*)?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .replace(/^(?:Error:\s*)+/i, '')
    .trim()
  return stripped || '这次操作没有成功，请稍后重试。'
}

/* ------------------------------------------------------------------ */
/* 展示组件                                                            */
/* ------------------------------------------------------------------ */

function Skeleton({ count }: { count: number }) {
  return (
    <div className="discover-skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <div className="discover-skeleton" key={index} />)}
    </div>
  )
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="discover-error" role="alert">
      <CircleAlert size={14} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" className="topbar-action" onClick={onRetry}>重试</button>
    </div>
  )
}

/**
 * 空态与「需要登录」共用这一个组件：未登录不是错误，不能画成 alert。
 *
 * 图标分两种：登录引导用 LogIn（「你需要做一件事」），单纯没内容用 Music2
 * （「现在没有」）。共用一个登录图标会让「排行榜暂时没有内容」看起来像要求登录。
 * 登录引导的文案必须真的出现「登录」二字（产品要求：诚实降级，不假装是空列表）。
 */
function EmptyRow({ children, login = false }: { children: React.ReactNode; login?: boolean }) {
  return (
    <div className="discover-empty">
      {login ? <LogIn size={15} aria-hidden="true" /> : <Music2 size={15} aria-hidden="true" />}
      <span>{children}</span>
    </div>
  )
}

function CardCover({ src, alt }: { src: string | null; alt: string }) {
  // 图挂了要退回字形，而不是留一个空白方块：上游 CDN 偶尔 404 / 被墙，
  // 卡片墙因此整排"空黑"会被误读成"没加载出来"。onError 只处理加载失败，
  // 不重试（重试会把一次坏链接变成多次请求，上游风控下不是好主意）。
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  return (
    <span className="discover-card-cover">
      {src && !failed
        ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <Music2 size={20} aria-hidden="true" />}
      <span className="sr-only">{alt}</span>
    </span>
  )
}

function ToplistCard({ item, onOpen }: { item: DiscoverToplist; onOpen: () => void }) {
  return (
    <button type="button" className="discover-card" data-kind="toplist" title={'打开 ' + item.name} onClick={onOpen}>
      <CardCover src={item.cover} alt={item.name} />
      <span className="discover-card-copy">
        <strong>{item.name}</strong>
        <small>{item.updateFrequency || '榜单'} · {item.trackCount || 0} 首</small>
        <small className="mono">{fmtCount(item.playCount)} 次播放</small>
      </span>
      {item.featured === true ? <span className="discover-badge">精选</span> : null}
    </button>
  )
}

function PlaylistCard({ item, onOpen }: { item: DiscoverPlaylist; onOpen: () => void }) {
  return (
    <button type="button" className="discover-card" data-kind="playlist" title={'打开 ' + item.name} onClick={onOpen}>
      <CardCover src={item.cover} alt={item.name} />
      <span className="discover-card-copy">
        <strong>{item.name}</strong>
        <small>{item.creator || '未知创建者'} · {item.trackCount || 0} 首</small>
        <small className="mono">{fmtCount(item.playCount)} 次播放</small>
      </span>
    </button>
  )
}

function TrackCard({ track, onPlay, onQueue }: { track: StreamingTrack; onPlay: () => void; onQueue: () => void }) {
  return (
    <div className="discover-card" data-kind="track">
      <CardCover src={track.cover ?? null} alt={track.title} />
      <span className="discover-card-copy">
        <strong>{track.title}</strong>
        <small>{track.artist || '未知艺人'}</small>
        <small className="mono">{fmt(track.durationMs)}</small>
      </span>
      <span className="discover-card-actions">
        <button type="button" className="row-play" title={'播放 ' + track.title} aria-label={'播放 ' + track.title} onClick={onPlay}><Play size={12} /></button>
        <button type="button" className="discover-icon-button" title="加入在线播放列表" aria-label={'把 ' + track.title + ' 加入在线播放列表'} onClick={onQueue}><Plus size={12} /></button>
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

export default function Discover() {
  /** v6.3：发现页支持网易云与 QQ 音乐；切换平台会重新取数（缓存按平台隔离）。 */
  const [platform, setPlatform] = useState<DiscoverPlatform>(readStoredPlatform)
  const labels = PLATFORM_LABELS[platform]

  const readCache = (want: DiscoverPlatform): typeof homeCache => {
    return homeCache && homeCache.platform === want && Date.now() - homeCache.at < HOME_CACHE_MS ? homeCache : null
  }
  const readPlaylistCache = (want: DiscoverPlatform): DiscoverPlaylistsPage | null => {
    return playlistCache && playlistCache.platform === want && Date.now() - playlistCache.at < HOME_CACHE_MS
      ? playlistCache.page
      : null
  }

  const [home, setHome] = useState<DiscoverHome | null>(() => readCache(readStoredPlatform())?.home ?? null)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [homeLoading, setHomeLoading] = useState(false)
  /** 单区块重试：只把该区块置为加载中，其余区块保持已有数据，不闪。 */
  const [retrying, setRetrying] = useState<SectionKey | null>(null)
  const [expandedToplists, setExpandedToplists] = useState(false)
  /** 读屏播报（sr-only）：屏幕上的反馈条只管「看得见」，这里管「听得见」。 */
  const [announce, setAnnounce] = useState('')
  /**
   * 可见反馈条：播放失败、入队成功、刷新失败都走它。
   *
   * 为什么不能只用 sr-only 的 aria-live：验证者指出「播放失败在屏幕上不可见」——
   * 点了播放却什么都没发生（或者只是没声音），用户无从知道原因。aria-live 是给读屏
   * 软件的，不是给眼睛的，两者必须同时更新。
   */
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  /** 在线播放列表长度：模块级状态没有响应式，靠订阅推到这里。 */
  const [onlineCount, setOnlineCount] = useState(() => onlineQueueLength())

  /** 公开歌单广场：未登录时「推荐歌单」的诚实替代（/top/playlist 免登录）。 */
  const [publicLists, setPublicLists] = useState<DiscoverPlaylist[]>(() => readPlaylistCache(readStoredPlatform())?.items ?? [])
  const [playlistTotal, setPlaylistTotal] = useState(() => readPlaylistCache(readStoredPlatform())?.total ?? 0)
  const [playlistHasMore, setPlaylistHasMore] = useState(() => readPlaylistCache(readStoredPlatform())?.hasMore ?? false)
  const [playlistError, setPlaylistError] = useState<string | null>(null)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [category, setCategory] = useState('全部')
  const [order, setOrder] = useState<'hot' | 'new'>('hot')
  /**
   * 已经取到第几页。
   *
   * 不能用「已显示条数 / 30」推页号：个人推荐与公开广场会按 id 去重，去重后的条数
   * 可能少于 30，推出来的页号就会重复请求同一页（表现为「加载更多」点了没反应）。
   */
  const [loadedPage, setLoadedPage] = useState(1)

  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const [detailTracks, setDetailTracks] = useState<StreamingTrack[]>([])
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    setOnlineCount(onlineQueueLength())
    const off = subscribeOnlineQueue(() => setOnlineCount(onlineQueueLength()))
    return () => {
      mountedRef.current = false
      off()
    }
  }, [])

  /** 公开歌单：分页 + 分类 + 排序都走同一个函数；append=false 表示换分类/刷新。 */
  const publicPlaylists = useCallback(async (
    target: DiscoverPlatform,
    page: number,
    nextCategory: string,
    nextOrder: 'hot' | 'new',
    append: boolean
  ): Promise<void> => {
    setPlaylistLoading(true)
    setPlaylistError(null)
    try {
      const reply = await window.twilight.discoverPlaylists(target, { cat: nextCategory, order: nextOrder, page })
      if (!mountedRef.current) return
      setPublicLists(current => {
        if (!append) return reply.items
        const seen = new Set(current.map(item => item.id))
        return current.concat(reply.items.filter(item => !seen.has(item.id)))
      })
      setPlaylistTotal(reply.total)
      setPlaylistHasMore(reply.hasMore)
      setLoadedPage(page)
      // 只缓存首页且只缓存成功结果：失败页缓存下来会让「回到发现页」看到一份旧错误。
      if (!append && !reply.error) playlistCache = { at: Date.now(), platform: target, page: reply }
      if (reply.error) setPlaylistError(reply.error)
    } catch (error) {
      if (mountedRef.current) {
        const message = friendlyError(error)
        setPlaylistError(message)
        setFeedback({ tone: 'error', text: '歌单没有取到：' + message })
      }
    } finally {
      if (mountedRef.current) setPlaylistLoading(false)
    }
  }, [])

  /**
   * 取发现首页。
   *
   * reason='retry' 时只把指定区块换掉：主进程的 discoverHome 是整页聚合，但四个区块
   * 各自有缓存，健康的区块不会因为一次重试再打上游；渲染层只替换坏掉的那一块，
   * 避免整页闪一次骨架。
   */
  const loadHome = useCallback(async (
    reason: 'mount' | 'refresh' | 'retry',
    only?: SectionKey,
    target: DiscoverPlatform = platform
  ): Promise<void> => {
    if (reason === 'retry' && only) setRetrying(only)
    else setHomeLoading(true)
    setHomeError(null)
    if (reason === 'refresh') {
      homeCache = null
      playlistCache = null
    }
    try {
      const next = await window.twilight.discoverHome(target)
      if (!mountedRef.current) return
      setHome(current => {
        if (reason !== 'retry' || !only || !current) return next
        return { ...current, sections: { ...current.sections, [only]: next.sections[only] }, notice: next.notice }
      })
      homeCache = { at: Date.now(), platform: target, home: next }
      setAnnounce(reason === 'refresh' ? '发现内容已刷新。' : '发现内容已载入。')
    } catch (error) {
      if (!mountedRef.current) return
      const message = friendlyError(error)
      setHomeError(message)
      setAnnounce('发现内容读取失败：' + message)
      setFeedback({ tone: 'error', text: '发现内容读取失败：' + message })
    } finally {
      if (mountedRef.current) {
        setHomeLoading(false)
        setRetrying(null)
      }
    }
  }, [])

  /**
   * 首屏：内存缓存 60 秒内直接复用（切走再切回的常态），否则取数。
   * 只有挂载这一次；之后只有用户点刷新/重试才会再发请求 —— 这一页没有轮询。
   *
   * **顺序有意义**：公开歌单先发、首页后发。主进程按平台节流（同平台 ≥1s 串行），
   * 先发的先回来；而 e2e 在「榜单卡片出现」的同一帧就读歌单卡片数量，若首页先完成，
   * 歌单请求还在节流队列里，那一读就是 0（假红，不是产品缺陷）。
   */
  /**
   * 切平台：清掉当前平台的可见状态，再由下面的 effect 取新平台的数据。
   *
   * 为什么不在这里直接 await：切平台和首屏是同一条取数路径（含播放器缓存判断），
   * 复制一份只会让「刷新」与「切换」渐渐长成两套行为。
   */
  const switchPlatform = useCallback((next: DiscoverPlatform): void => {
    if (next === platform) return
    setPlatform(next)
    try { localStorage.setItem(PLATFORM_KEY, next) } catch { /* 隐私模式写不进去就算了：本次仍然生效 */ }
    setHome(null)
    setHomeError(null)
    setPublicLists([])
    setPlaylistTotal(0)
    setPlaylistHasMore(false)
    setPlaylistError(null)
    setLoadedPage(1)
    setCategory('全部')
    setOrder('hot')
    setExpandedToplists(false)
    setDetail(null)
    setAnnounce('已切换到 ' + PLATFORM_LABELS[next].name + '，正在取数。')
  }, [platform])

  /**
   * 首屏/切平台：内存缓存 60 秒内直接复用（切走再切回的常态），否则取数。
   *
   * **顺序有意义**：公开歌单先发、首页后发（主进程按平台节流，先发的先回来）。
   * QQ 没有「歌单广场」这条旁路（它的推荐歌单已经在首屏区块里），所以不重复请求。
   */
  const bootRef = useRef<DiscoverPlatform | null>(null)
  useEffect(() => {
    if (bootRef.current === platform) return
    bootRef.current = platform
    // 切回一个 60 秒内看过的平台时直接摆缓存（否则 setHome(null) 之后这里跳过请求，
    // 页面会停在空骨架 —— 那是「切回来变白」的经典 bug）。
    const cachedHome = readCache(platform)
    if (cachedHome) {
      setHome(cachedHome.home)
    }
    const cachedPlaylists = platform !== 'qq' ? readPlaylistCache(platform) : null
    if (cachedPlaylists) {
      setPublicLists(cachedPlaylists.items)
      setPlaylistTotal(cachedPlaylists.total)
      setPlaylistHasMore(cachedPlaylists.hasMore)
    }
    void (async () => {
      if (!cachedPlaylists && platform !== 'qq') {
        await publicPlaylists(platform, 1, '全部', 'hot', false)
      }
      if (!cachedHome) await loadHome('mount', undefined, platform)
    })()
  }, [platform, publicPlaylists, loadHome])

  const refreshAll = useCallback((): void => {
    setAnnounce('正在刷新发现内容…')
    void loadHome('refresh', undefined, platform)
    if (platform !== 'qq') void publicPlaylists(platform, 1, category, order, false)
  }, [loadHome, publicPlaylists, category, order, platform])

  const closeDetail = useCallback((): void => {
    setDetail(null)
    setDetailTracks([])
    setDetailError(null)
    setDetailLoading(false)
  }, [])

  const openDetail = useCallback(async (target: DetailTarget): Promise<void> => {
    setDetail(target)
    setDetailTracks([])
    setDetailError(null)
    setDetailLoading(true)
    try {
      const reply: DiscoverTracksResult = target.kind === 'toplist'
        ? await window.twilight.discoverToplist(platform, target.id)
        : await window.twilight.discoverPlaylistTracks(platform, target.id)
      if (!mountedRef.current) return
      setDetailTracks(Array.isArray(reply.items) ? reply.items : [])
      setDetailError(reply.error ?? null)
    } catch (error) {
      if (mountedRef.current) {
        const message = friendlyError(error)
        setDetailError(message)
        setFeedback({ tone: 'error', text: '曲目没有取到：' + message })
      }
    } finally {
      if (mountedRef.current) setDetailLoading(false)
    }
  }, [platform])

  /** 卸载（切走视图）时必须关掉 portal 里的抽屉：它挂在 body 上，不会跟着视图一起消失。 */
  useEffect(() => () => { setDetail(null) }, [])

  /** 详情抽屉：Esc 关闭。用捕获阶段拦下，避免同时触发全局的 Esc（退出沉浸）。 */
  useEffect(() => {
    if (!detail) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeDetail()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [detail, closeDetail])

  const play = useCallback((track: StreamingTrack): void => {
    setAnnounce('正在播放：' + track.title)
    setFeedback({ tone: 'info', text: '正在播放：' + track.title })
    void playStreamingTrack(track).catch((error: unknown) => {
      const message = friendlyError(error)
      setAnnounce('播放失败：' + message)
      setFeedback({ tone: 'error', text: '播放失败：' + message })
    })
  }, [])

  const playAll = useCallback((list: StreamingTrack[], label: string): void => {
    const first = list[0]
    if (!first) return
    startOnlineQueue(list)
    setAnnounce('开始播放：' + label + '（共 ' + list.length + ' 首）')
    setFeedback({ tone: 'info', text: '开始播放：' + label + '（共 ' + list.length + ' 首）' })
    void playStreamingTrack(first).catch((error: unknown) => {
      const message = friendlyError(error)
      setAnnounce('播放失败：' + message)
      setFeedback({ tone: 'error', text: '播放失败：' + message })
    })
  }, [])

  /**
   * 加入**在线播放列表**（不是播放栏的本地队列）。
   * 在线条目带 online: 前缀，进不了引擎 set_queue；这里的列表只用于「播完接着播下一首」。
   */
  const enqueue = useCallback((list: StreamingTrack[], label: string): void => {
    const added = appendOnlineQueue(list)
    const text = added > 0
      ? '已把 ' + added + ' 首加入在线播放列表（' + label + '），当前共 ' + onlineQueueLength() + ' 首。'
      : '这些曲目已经在在线播放列表里了。'
    setAnnounce(text)
    setFeedback({ tone: 'info', text })
  }, [])

  /* ---------------- 派生数据 ---------------- */

  const dailySection = home?.sections.daily
  const fmSection = home?.sections.fm
  const toplistSection = home?.sections.toplists
  const recommendSection = home?.sections.playlists

  /** 榜单张数（决定要不要给「展开全部」）：排序细节在 renderToplists 里，这里只数个数。 */
  const toplistCount = toplistSection?.items.length ?? 0

  /** 推荐歌单 = 个人推荐（登录后）+ 公开歌单广场，按 id 去重，个人推荐在前。 */
  const playlistGroups = useMemo(() => {
    const personalized = recommendSection?.items ?? []
    const seen = new Set(personalized.map(item => item.id))
    return { personalized, publicItems: publicLists.filter(item => !seen.has(item.id)) }
  }, [recommendSection, publicLists])

  /**
   * 骨架条件：没有数据、且确实在取（或还没取过且没报错）。有数据时不闪。
   *
   * 「骨架优先于错误」是刻意的：刷新期间整页在取数，若先摆红字再摆骨架，用户会看到
   * 一次闪红。等请求真落地了再决定显示错误还是内容。
   */
  const showSkeleton = (key: SectionKey, hasData: boolean): boolean => {
    if (hasData) return false
    if (retrying === key) return true
    if (homeLoading) return true
    return !home && !homeError
  }

  const retrySection = (key: SectionKey): void => { void loadHome('retry', key) }

  /**
   * 每日推荐 / 私人漫游。
   *
   * 渲染优先级固定为「数据 → 骨架 → 错误 → 未登录引导 → 空态」，且**骨架优先于错误**：
   * 刷新时整页在取数，先把旧数据/骨架摆出来，等服务端返回再决定显示错误还是内容。
   * 未登录不是错误：这一块必须给出登录引导而不是把 needsLogin 变成「没有内容」。
   */
  const renderTrackSection = (key: 'daily' | 'fm', label: string) => {
    const section = key === 'daily' ? dailySection : fmSection
    const items = section?.items ?? []
    if (items.length > 0) {
      return (
        <div className="discover-card-row">
          {items.map(track => (
            <TrackCard key={track.platform + ':' + track.id} track={track}
              onPlay={() => play(track)} onQueue={() => enqueue([track], track.title)} />
          ))}
        </div>
      )
    }
    if (showSkeleton(key, false)) return <Skeleton count={6} />
    if (section?.error) return <ErrorRow message={section.error} onRetry={() => retrySection(key)} />
    if (section?.needsLogin === true || home?.signedIn === false) {
      return <EmptyRow login>登录后即可看到{label}。在「设置 → 账号」里扫码登录{platform === 'qq' ? ' QQ 音乐' : ''}，登录成功后点「刷新发现」。</EmptyRow>
    }
    return <EmptyRow>{label}暂时没有内容，过一会儿点「刷新发现」再看看。</EmptyRow>
  }

  /**
   * 排行榜：featured 排前面，其余保持上游顺序（只改展示次序，不改数据）。
   * 默认展示 4 张，多余的折叠进「展开全部」—— 一屏四个区块，首页不该被一个榜单区吃掉半屏。
   */
  const renderToplists = () => {
    const list = toplistSection?.items ?? []
    const ordered = [...list].sort((left, right) => Number(right.featured) - Number(left.featured))
    if (ordered.length > 0) {
      const visible = expandedToplists ? ordered : ordered.slice(0, 4)
      return (
        <div className="discover-card-row">
          {visible.map(item => (
            <ToplistCard key={item.id} item={item}
              onOpen={() => void openDetail({ kind: 'toplist', id: item.id, name: item.name, cover: item.cover })} />
          ))}
        </div>
      )
    }
    if (showSkeleton('toplists', false)) return <Skeleton count={4} />
    if (toplistSection?.error) return <ErrorRow message={toplistSection.error} onRetry={() => retrySection('toplists')} />
    return <EmptyRow>排行榜暂时没有内容，过一会儿点「刷新发现」再看看。</EmptyRow>
  }

  /**
   * 推荐歌单 = 个人推荐（登录后，需登录端点）+ 公开歌单广场（免登录，分页）。
   *
   * 为什么两块拼在一起而不是分成两个区：用户看到的是「推荐歌单」这一个产品概念，
   * 未登录时它必须仍然可用（公开广场），登录后个人推荐排前面。拆成两块会让未登录
   * 用户对着一个空的「推荐」区发呆。
   */
  const renderPlaylists = () => {
    const personalized = playlistGroups.personalized
    const publicItems = playlistGroups.publicItems
    const total = personalized.length + publicItems.length
    if (total > 0) {
      return (
        <>
          <div className="discover-card-row">
            {personalized.map(item => (
              <PlaylistCard key={'mine-' + item.id} item={item}
                onOpen={() => void openDetail({ kind: 'playlist', id: item.id, name: item.name, cover: item.cover })} />
            ))}
            {publicItems.map(item => (
              <PlaylistCard key={'open-' + item.id} item={item}
                onOpen={() => void openDetail({ kind: 'playlist', id: item.id, name: item.name, cover: item.cover })} />
            ))}
          </div>
          {playlistError || recommendSection?.error ? (
            <div className="discover-error" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{playlistError ?? recommendSection?.error}</span>
              <button type="button" className="topbar-action" onClick={refreshAll}>重试</button>
            </div>
          ) : null}
          {playlistHasMore ? (
            <div className="discover-load-more">
              <button type="button" className="topbar-action" disabled={playlistLoading}
                onClick={() => void publicPlaylists(platform, loadedPage + 1, category, order, true)}>
                {playlistLoading ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
                {playlistLoading ? '正在加载…' : '加载更多（已显示 ' + publicItems.length + ' / ' + playlistTotal + '）'}
              </button>
            </div>
          ) : null}
        </>
      )
    }
    if (showSkeleton('playlists', false) || playlistLoading) return <Skeleton count={8} />
    if (playlistError || recommendSection?.error) {
      return <ErrorRow message={playlistError ?? recommendSection?.error ?? '歌单暂时取不到。'} onRetry={refreshAll} />
    }
    return <EmptyRow>还没有推荐歌单，过一会儿点「刷新发现」再看看。</EmptyRow>
  }

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="discover-page">
      <header className="discover-hero">
        <div className="discover-hero-copy">
          <span className="section-eyebrow">DISCOVER</span>
          <h1>发现</h1>
          <p>只在你打开这一页时取数：{labels.daily}、{labels.fm}、排行榜与{labels.playlists}，不做后台轮询。网易云与 QQ 音乐可切换，缓存与登录态按平台隔离。</p>
        </div>
        <div className="discover-hero-side">
          <div className="discover-platform-switch" role="group" aria-label="发现平台">
            {(['netease', 'qq'] as const).map(id => (
              <button key={id} type="button" className="discover-platform-tab" data-platform={id}
                aria-pressed={platform === id} title={'切换到' + PLATFORM_LABELS[id].name + '的发现内容'}
                onClick={() => switchPlatform(id)}>{PLATFORM_LABELS[id].name}</button>
            ))}
          </div>
          <div className="discover-chips" aria-label="发现状态">
            <span className="discover-chip" data-state={home?.signedIn === true ? 'ok' : 'muted'}>
              <i className="discover-chip-dot" aria-hidden="true" />
              {home ? (home.signedIn ? labels.name + ' · 已登录' : labels.name + ' · 未登录') : labels.name + ' · 状态未知'}
            </span>
            <span className="discover-chip mono">
              {toplistSection && toplistSection.updatedAt > 0 ? '更新于 ' + fmtTime(toplistSection.updatedAt) : '尚未取到数据'}
            </span>
          </div>
          {/* 在线播放列表不是本地队列：这里常驻一个入口，抽屉关掉后也能从头再播一遍。 */}
          {onlineCount > 0 ? (
            <button type="button" className="discover-chip discover-chip-action" data-state="ok"
              title="从头播放在线播放列表（只影响在线曲目；本地队列在播放栏的队列面板里）"
              aria-label={'播放在线播放列表（' + onlineCount + ' 首）'}
              onClick={() => {
                const list = onlineQueueSnapshot()
                if (list.length > 0) playAll(list, '在线播放列表')
              }}>
              <i className="discover-chip-dot" aria-hidden="true" />
              在线列表 {onlineCount} 首
            </button>
          ) : null}
          <button type="button" className="topbar-action discover-refresh" aria-label="刷新发现"
            disabled={homeLoading || retrying !== null} onClick={refreshAll}
            title="重新取一次发现内容（不会自动轮询）">
            {homeLoading || retrying !== null
              ? <Loader2 size={14} className="spin" aria-hidden="true" />
              : <RefreshCw size={14} aria-hidden="true" />}
            刷新
          </button>
        </div>
      </header>

      {/* 读屏播报（看不见但听得见）；下面的可见反馈条负责「看得见」。 */}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {/* 可见反馈条：非模态、可关闭，播放失败/入队结果/刷新失败都落在这里。
          用户点了播放却没声音时，屏幕上必须有东西说话。 */}
      {feedback ? (
        <div className="discover-notice" role="status" data-tone={feedback.tone}>
          <CircleAlert size={14} aria-hidden="true" />
          <span>{feedback.text}</span>
          <button type="button" className="discover-icon-button" aria-label="关闭提示" title="关闭提示"
            onClick={() => setFeedback(null)}><X size={12} /></button>
        </div>
      ) : null}

      {homeError ? <ErrorRow message={homeError} onRetry={refreshAll} /> : null}
      {home?.notice
        ? <div className="discover-notice" role="status" data-tone="info">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{home.notice}</span>
          </div>
        : null}

      <section className="discover-section" data-discover-section="daily" aria-label={labels.daily}>
        <div className="discover-section-head">
          <div className="discover-section-title">
            <span className="section-eyebrow">DAILY</span>
            <h2><Sparkles size={16} aria-hidden="true" />{labels.daily}</h2>
          </div>
          <span className="discover-section-meta mono">{dailySection && dailySection.items.length > 0 ? dailySection.items.length + ' 首' : ''}</span>
        </div>
        {renderTrackSection('daily', labels.daily)}
      </section>

      <section className="discover-section" data-discover-section="fm" aria-label={labels.fm}>
        <div className="discover-section-head">
          <div className="discover-section-title">
            <span className="section-eyebrow">{platform === 'qq' ? 'RADAR' : 'PERSONAL FM'}</span>
            <h2>{labels.fm}</h2>
          </div>
          <span className="discover-section-meta mono">{fmSection && fmSection.items.length > 0 ? fmSection.items.length + ' 首' : ''}</span>
        </div>
        {renderTrackSection('fm', labels.fm)}
      </section>

      <section className="discover-section" data-discover-section="toplists" aria-label="排行榜">
        <div className="discover-section-head">
          <div className="discover-section-title">
            <span className="section-eyebrow">TOPLISTS</span>
            <h2><Trophy size={16} aria-hidden="true" />排行榜</h2>
          </div>
          <div className="discover-section-tools">
            {toplistCount > 4 ? (
              <button type="button" className="discover-more" aria-expanded={expandedToplists}
                onClick={() => setExpandedToplists(value => !value)}>
                {expandedToplists ? '收起' : '展开全部 ' + toplistCount}
                <ChevronDown size={12} className={expandedToplists ? 'discover-flip' : undefined} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
        {renderToplists()}
      </section>

      <section className="discover-section" data-discover-section="playlists" aria-label="推荐歌单">
        <div className="discover-section-head">
          <div className="discover-section-title">
            <span className="section-eyebrow">PLAYLISTS</span>
            <h2>推荐歌单</h2>
          </div>
          <div className="discover-section-tools">
            {platform === 'netease' ? (
              <>
                <div className="discover-cats" role="group" aria-label="歌单分类">
                  {CATEGORIES.map(item => (
                    <button key={item} type="button" className="discover-cat" aria-pressed={category === item}
                      onClick={() => { setCategory(item); void publicPlaylists(platform, 1, item, order, false) }}>{item}</button>
                  ))}
                </div>
                <div className="discover-orders" role="group" aria-label="歌单排序">
                  <button type="button" className="discover-cat" aria-pressed={order === 'hot'}
                    onClick={() => { setOrder('hot'); void publicPlaylists(platform, 1, category, 'hot', false) }}>热门</button>
                  <button type="button" className="discover-cat" aria-pressed={order === 'new'}
                    onClick={() => { setOrder('new'); void publicPlaylists(platform, 1, category, 'new', false) }}>最新</button>
                </div>
              </>
            ) : (
              // QQ 没有分类广场：上游 /recommend/playlists 是单条推荐流，不假装能翻页。
              <span className="discover-section-meta mono">QQ 音乐只提供一条推荐歌单流（不分页）</span>
            )}
          </div>
        </div>
        {renderPlaylists()}
      </section>

      {/* 详情抽屉 portal 到 body：放进 .view-layer 里会被视图切换的 transform 变成新的
          包含块，position: fixed 就不再相对视口，抽屉会跟着内容页一起被裁掉。 */}
      {detail ? createPortal(
        <div className="discover-detail-layer" role="presentation" onClick={closeDetail}>
          <aside className="discover-detail" role="dialog" aria-modal="true"
            aria-label={detail.name + ' 的曲目'} onClick={event => event.stopPropagation()}>
            <header className="discover-detail-head">
              <div className="discover-detail-copy">
                <span className="section-eyebrow">{detail.kind === 'toplist' ? 'TOPLIST' : 'PLAYLIST'}</span>
                <h2>{detail.name}</h2>
                <p className="mono">
                  {detailLoading ? '正在读取曲目…' : detailError ? '读取失败' : detailTracks.length + ' 首'}
                </p>
                <p className="discover-detail-live" role="status">
                  {onlineCount > 0
                    ? '在线列表 ' + onlineCount + ' 首（只影响在线曲目，不占用本地队列）'
                    : '在线列表为空：播放全部会按这个顺序一首接一首播。'}
                </p>
              </div>
              <button type="button" className="discover-icon-button discover-detail-close"
                aria-label="关闭详情" title="关闭详情（Esc）" onClick={closeDetail}><X size={16} /></button>
            </header>
            <div className="discover-detail-actions">
              <button type="button" className="topbar-action" disabled={detailTracks.length === 0}
                onClick={() => playAll(detailTracks, detail.name)}><Play size={13} />播放全部</button>
              <button type="button" className="topbar-action" disabled={detailTracks.length === 0}
                onClick={() => enqueue(detailTracks, detail.name)}><Plus size={13} />加入在线播放列表</button>
              {onlineCount > 0 ? (
                <button type="button" className="topbar-action" title="从头播放在线播放列表"
                  onClick={() => {
                    const list = onlineQueueSnapshot()
                    if (list.length === 0) return
                    playAll(list, '在线播放列表')
                  }}><Play size={13} />播放在线列表</button>
              ) : null}
            </div>
            {detailError ? <ErrorRow message={detailError} onRetry={() => void openDetail(detail)} /> : null}
            {detailLoading ? <Skeleton count={6} /> : null}
            {!detailLoading && !detailError && detailTracks.length === 0
              ? <p className="discover-note">这个{detail.kind === 'toplist' ? '榜单' : '歌单'}暂时没有可播放的曲目。</p>
              : null}
            <div className="discover-detail-list" role="list">
              {detailTracks.map((track, index) => (
                <div className="discover-row" role="listitem" key={track.platform + ':' + track.id + ':' + index}>
                  <span className="discover-row-index mono">{index + 1}</span>
                  <button type="button" className="row-play" title={'播放 ' + track.title}
                    aria-label={'播放 ' + track.title} onClick={() => play(track)}><Play size={12} /></button>
                  <span className="discover-row-copy">
                    <strong>{track.title}</strong>
                    <small>{track.artist || '未知艺人'}{track.album ? ' · ' + track.album : ''}</small>
                  </span>
                  <span className="discover-row-dur mono">{fmt(track.durationMs)}</span>
                  <button type="button" className="discover-icon-button" title="加入在线播放列表"
                    aria-label={'把 ' + track.title + ' 加入在线播放列表'}
                    onClick={() => enqueue([track], track.title)}><Plus size={12} /></button>
                </div>
              ))}
            </div>
          </aside>
        </div>, document.body) : null}
    </div>
  )
}