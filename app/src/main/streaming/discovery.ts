/**
 * 「发现」页的主进程内核（PLAN §1.1）。
 *
 * 为什么独立成文件而不是继续塞进 manager.ts（那个文件已经 1000+ 行）：
 * 这一层的三条规则与平台层的其它操作不同 ——
 *  1. **区块级降级**：四个区块来自四个上游端点，任何一个失败都只写进它自己的
 *     error，绝不把整页打成错误页（PLAN 的硬要求）；
 *  2. **按区块缓存**：5/10 分钟内存缓存，命中不打上游（CONTRACT §5 的风控额度
 *     是硬约束，发现页又是最容易「一进页面就四个请求」的地方）；
 *  3. **只可显式调用**：这里没有任何定时器/预热/后台拉取，只有渲染层点了才发请求。
 *
 * 网络、节流、熔断、失败文案**全部复用 StreamingManager**（通过 deps 注入，见
 * manager.ts 的 discover* 方法）：这里不再造第二套 HTTP 客户端，也不自己判风控码 ——
 * 两套节流彼此不知道对方时，同平台并发请求就会绕过「≥1s 串行」这条契约。
 *
 * 本文件里除了 DiscoveryCore 之外都是纯函数：不碰 Electron、不联网，单测可直接调。
 */

import type {
  DiscoverHome,
  DiscoverPlatform,
  DiscoverPlaylist,
  DiscoverPlaylistsPage,
  DiscoverSection,
  DiscoverToplist,
  DiscoverTracksResult
} from '@shared/discover'
import type { StreamingTrack } from '@shared/streaming'

/**
 * 网易云发现页的固定上游（PLAN §1.1「后端接口」）。
 *
 * 这些路径只在 adapter 层出现过一次（adapters.ts 的 netease 对象），这里按同一
 * 风格集中：换成别家服务端/版本时只改这一处。
 */
export const DISCOVER_PATHS = {
  daily: '/recommend/songs',
  /** 私人漫游：优先 mode 端点；老服务端没有它时回退 /personal_fm（见 home()）。 */
  fmMode: '/personal/fm/mode?mode=DEFAULT&limit=30',
  fmFallback: '/personal_fm',
  toplists: '/toplist/detail',
  recommendPlaylists: '/recommend/resource'
} as const

/**
 * QQ 音乐的发现页上游（v6.3）。
 *
 * 依据是 @yakult-green-tea/qq-music-api 3.3.x 的公开路由（docs/README.md 与
 * src/routes/router.ts）：
 *   /user/daily-songs、/recommend/radar、/recommend/toplists、/recommend/toplist、
 *   /recommend/playlists、/recommend/categories、/recommend/category-playlists、
 *   /recommend/new-songs、/recommend/new-albums、/getSongListDetail/:disstid
 *
 * 与网易云的差别（界面必须如实体现）：
 *  - QQ 的「私人漫游」对应**刷歌模式**（客户端「雷达」）：一页约 10 首、HasMore 可续读；
 *  - QQ 没有「每日推荐歌单」这个概念，推荐歌单是公开内容（登录后更贴近口味，但匿名可读）；
 *  - QQ 的榜单详情走 /recommend/toplist，歌单详情走 /getSongListDetail。
 */
export const QQ_DISCOVER_PATHS = {
  daily: '/user/daily-songs',
  radar: (page = 1): string => '/recommend/radar?page=' + Math.max(1, page),
  toplists: '/recommend/toplists',
  toplistSongs: (id: string, limit = 100): string =>
    '/recommend/toplist?id=' + encodeURIComponent(id) + '&limit=' + limit,
  recommendPlaylists: (limit = 30): string => '/recommend/playlists?limit=' + limit,
  playlistDetail: (id: string): string => '/getSongListDetail/' + encodeURIComponent(id)
} as const

export const playlistTracksPath = (id: string): string =>
  '/playlist/track/all?id=' + encodeURIComponent(id) + '&limit=1000&offset=0'

export const playlistSquarePath = (cat: string, order: 'hot' | 'new', page: number): string => {
  const offset = (page - 1) * PLAYLIST_PAGE_SIZE
  return '/top/playlist?cat=' + encodeURIComponent(cat) + '&order=' + order +
    '&limit=' + PLAYLIST_PAGE_SIZE + '&offset=' + offset
}

/**
 * 缓存时长（毫秒）。PLAN 的取值：榜单/歌单广场 5 分钟，每日推荐/漫游/歌单曲目 10 分钟。
 *
 * 为什么不是「统一 5 分钟」：每日推荐与漫游是**按账号算**的推荐流，上游刷新本来就在
 * 分钟级；而榜单是公开内容、变化更快。分开取值是为了让「刷新按钮」的语义可解释。
 */
export const DISCOVER_TTL_MS = {
  daily: 10 * 60_000,
  fm: 10 * 60_000,
  toplists: 5 * 60_000,
  playlists: 5 * 60_000,
  playlistTracks: 10 * 60_000
} as const

/** 歌单广场一页 30 张（PLAN：offset = (page-1)*30）。 */
export const PLAYLIST_PAGE_SIZE = 30
const MAX_PLAYLIST_PAGE = 200
/** 首页精选位的张数（按上游顺序取前几张，见 mapToptlists）。 */
export const FEATURED_TOPLIST_COUNT = 4

// ---------------------------------------------------------------------------
// 失败文案归一：一句中文 + 下一步
// ---------------------------------------------------------------------------

/**
 * 把任意错误归一成「中文单句 + 下一步」。
 *
 * 平台层的错误文案已经是中文、且多数自带下一步（例如「服务端没有在运行，请先在
 * 设置里启动它。」），这类原样透出；剩下的（网络、形状、未知）在这里补下一步，
 * 免得界面只显示一句「fetch failed」。
 */
export function describeDiscoverFailure(error: unknown, platform: DiscoverPlatform = 'netease'): string {
  const label = platform === 'qq' ? 'QQ 音乐' : '网易云'
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.trim()
  if (!text) return '发现页暂时取不到数据。请稍后点「刷新」重试。'
  // 形状错是「上游端点变了」，重试没有意义：必须把「看到了什么」原样交给用户/日志。
  if (/形状不对|响应里没有预期的字段|不是 JSON/i.test(text)) return text
  // 风控/生命周期类：平台层已经写全了「为什么 + 怎么办」，不再追加。
  if (/已暂停|风控|限流|没有在运行|启动命令|服务端没有就绪|启动失败/i.test(text)) return text
  if (/超时|abort|timeout|ETIMEDOUT/i.test(text)) {
    return '请求超时了：' + label + '服务端没有在限定时间内回包。请稍后点「刷新」重试。'
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|network/i.test(text)) {
    return '连不上' + label + '服务端（网络不通或进程已退出）。请检查服务端，再点「刷新」重试。'
  }
  if (isLoginFailure(text)) return '这个区块需要登录' + label + '才有内容。请先在「设置 → 流媒体账户」扫码登录。'
  return /[。！？]$/.test(text) ? text : text + '。请稍后点「刷新」重试。'
}

/** 这个错误是不是「登录态问题」（据此把区块标成 needsLogin 而不是红色错误）。 */
export function isLoginFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return /需要登录|未登录|登录已失效|401/.test(text)
}

// ---------------------------------------------------------------------------
// 回包映射（纯函数）
// ---------------------------------------------------------------------------

const str = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0

function topLevelKeys(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value).slice(0, 60)
  if (Array.isArray(value)) return '(array len ' + value.length + ')'
  return Object.keys(value).slice(0, 12).join(', ') || '(empty object)'
}

/** 形状对不上时的错误：必须带上「看到了哪些顶层字段」，否则只能靠猜。 */
function shapeError(what: string, value: unknown): Error {
  return new Error('发现页' + what + '的回包形状不对（顶层字段：' + topLevelKeys(value) + '）')
}

function firstArray(candidates: unknown[]): unknown[] | undefined {
  return candidates.find((value): value is unknown[] => Array.isArray(value))
}

/**
 * 封面地址统一成 https 直链（判据与 adapters.ts:41-47 的 httpsCover 一致）。
 *
 * 页面 CSP 只放行 https 图片，混着来会表现成「有的卡有图、有的没有」，而原因
 * 根本不在那首歌上。
 */
function httpsCover(value: unknown): string | null {
  const raw = str(value).trim()
  if (!raw) return null
  if (raw.startsWith('//')) return 'https:' + raw
  if (/^http:\/\//i.test(raw)) return 'https://' + raw.slice(7)
  return /^https:\/\//i.test(raw) ? raw : null
}

/**
 * 歌曲行 → StreamingTrack。
 *
 * 与 adapters.ts 的 neteaseMapSongs 同一套字段（id/name/ar/al/dt），区别只在外壳：
 * 发现页的端点各自把同一批歌曲包在不同层里，外壳由各自的 mapXxx 剥，这里只认歌曲。
 */
function mapSongRows(rows: unknown[]): StreamingTrack[] {
  const out: StreamingTrack[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const song = raw as Record<string, unknown>
    const album = (song.al ?? song.album) as Record<string, unknown> | undefined
    const id = str(song.id)
    const title = str(song.name ?? song.title)
    if (!id || !title) continue
    const artists = song.ar ?? song.artists ?? song.singer
    const artist = Array.isArray(artists)
      ? artists
        .map(item => (item && typeof item === 'object' ? str((item as Record<string, unknown>).name) : str(item)))
        .filter(Boolean)
        .join(' / ')
      : str(artists)
    out.push({
      platform: 'netease',
      id,
      title,
      artist,
      album: str(album?.name),
      durationMs: num(song.dt ?? song.duration),
      cover: httpsCover(album?.picUrl ?? album?.img1v1Url ?? song.picUrl)
    })
  }
  return out
}

/**
 * /recommend/songs → data.dailySongs[]（真实服务端与 mock 都是这个形状）。
 *
 * 兼容 data.recommend：高版本服务端在部分登录态下把推荐放在 recommend 里，
 * 两个都认，缺了才报形状错（错误的假设必须变成一条可诊断的信息，不是空列表）。
 */
export function mapDailySongs(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const data = record.data as Record<string, unknown> | undefined
  const rows = firstArray([data?.dailySongs, data?.recommend, record.dailySongs])
  if (!rows) throw shapeError('每日推荐', json)
  return mapSongRows(rows)
}

/** /personal/fm/mode 或 /personal_fm → data[] / result[]（两种服务端版本）。 */
export function mapFmTracks(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const data = record.data
  const rows = firstArray([
    data,
    // 老版本把 items 再包一层：{ data: { items: [...] } }
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).items
      : undefined,
    record.result,
    record.songs
  ])
  if (!rows) throw shapeError('私人漫游', json)
  return mapSongRows(rows)
}

/**
 * /toplist/detail → list[]。
 *
 * featured 按**上游顺序**取前 4 张，而不是猜 ToplistType 字段：上游只有个别榜单带它，
 * 用顺序才能让 mock 与真实服务端行为一致（「精选几张」不该是第二个真相）。
 */
export function mapToptlists(json: unknown): DiscoverToplist[] {
  const record = (json ?? {}) as Record<string, unknown>
  const list = firstArray([record.list, (record.data as Record<string, unknown> | undefined)?.list])
  if (!list) throw shapeError('排行榜', json)
  const out: DiscoverToplist[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = str(row.id)
    const name = str(row.name)
    if (!id || !name) continue
    out.push({
      id,
      name,
      cover: httpsCover(row.coverImgUrl ?? row.coverUrl ?? row.picUrl),
      description: str(row.description ?? row.desc),
      updateFrequency: str(row.updateFrequency ?? row.updateTime),
      trackCount: num(row.trackCount ?? row.songCount),
      playCount: num(row.playCount ?? row.playcount),
      featured: out.length < FEATURED_TOPLIST_COUNT
    })
  }
  return out
}

/** 歌单行映射（推荐歌单 / 歌单广场共用同一套字段）。 */
function mapPlaylistRows(rows: unknown[]): DiscoverPlaylist[] {
  const out: DiscoverPlaylist[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = str(row.id)
    const name = str(row.name)
    if (!id || !name) continue
    const creator = row.creator
    out.push({
      id,
      name,
      cover: httpsCover(row.coverImgUrl ?? row.picUrl ?? row.coverUrl),
      trackCount: num(row.trackCount ?? row.songCount),
      playCount: num(row.playCount ?? row.playcount),
      // creator 有时是 { nickname }、有时只有 userId、有时直接是字符串；
      // 取不到就留空串，不编一个名字。
      creator: creator && typeof creator === 'object'
        ? str((creator as Record<string, unknown>).nickname)
        : str(creator)
    })
  }
  return out
}

/** /recommend/resource → recommend[]（需登录）。 */
export function mapRecommendPlaylists(json: unknown): DiscoverPlaylist[] {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.recommend, (record.data as Record<string, unknown> | undefined)?.recommend])
  if (!rows) throw shapeError('推荐歌单', json)
  return mapPlaylistRows(rows)
}

export interface PlaylistSquarePage {
  items: DiscoverPlaylist[]
  total: number
  hasMore: boolean
}

/**
 * /top/playlist → playlists[] + total + more。
 *
 * hasMore 的三层判据（越靠前越权威）：
 *  1. 上游显式给的 more；
 *  2. 没有 more 但给了 total：已翻过的 offset + 本页条数 < total；
 *  3. 两个都没有：退回「本页满一页」。
 * 缺了 total 也**不猜**能翻几页 —— 宁可少翻一页，也不要反复加载同一页。
 */
export function mapPlaylistSquare(json: unknown, page = 1): PlaylistSquarePage {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.playlists, (record.data as Record<string, unknown> | undefined)?.playlists])
  if (!rows) throw shapeError('歌单广场', json)
  const items = mapPlaylistRows(rows)
  const total = num(record.total)
  const more = record.more
  const safePage = clampPage(page)
  const consumed = (safePage - 1) * PLAYLIST_PAGE_SIZE + items.length
  return {
    items,
    total: total > 0 ? total : consumed,
    hasMore: typeof more === 'boolean'
      ? more
      : total > 0
        ? consumed < total
        : items.length >= PLAYLIST_PAGE_SIZE
  }
}

/** /playlist/track/all → songs[]（榜单详情与歌单详情同一端点）。 */
export function mapPlaylistTracks(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.songs, (record.data as Record<string, unknown> | undefined)?.songs])
  if (!rows) throw shapeError('歌单曲目', json)
  return mapSongRows(rows)
}

// ---------------------------------------------------------------------------
// QQ 音乐（v6.3）
// ---------------------------------------------------------------------------

/** QQ 的搜索条目与 track_info 同形：mid / name / singer[] / album{} / interval(秒)。 */
function mapQQSongRow(raw: unknown): StreamingTrack | null {
  if (!raw || typeof raw !== 'object') return null
  const song = raw as Record<string, unknown>
  const mid = str(song.mid ?? song.songmid ?? song.id)
  const title = str(song.name ?? song.title ?? song.songname)
  if (!mid || !title) return null
  const album = (song.album ?? {}) as Record<string, unknown>
  const artists = song.singer ?? song.singers
  const artist = Array.isArray(artists)
    ? artists.map(item => (item && typeof item === 'object' ? str((item as Record<string, unknown>).name) : str(item))).filter(Boolean).join(' / ')
    : str(artists)
  // interval 是**秒**（QQ track_info 的口径）；个别端点回 duration（毫秒），按量级判一下。
  const interval = num(song.interval)
  const duration = num(song.duration)
  const durationMs = interval > 0 && interval < 1000 ? interval * 1000 : duration > 0 ? duration : 0
  const albumMid = str(album.mid ?? album.albumMid)
  return {
    platform: 'qq',
    id: mid,
    title,
    artist,
    album: str(album.name ?? album.title),
    durationMs,
    cover: httpsCover(album.picUrl ?? album.cover ?? song.picUrl) ??
      (albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : null)
  }
}

function mapQQSongRows(rows: unknown[]): StreamingTrack[] {
  const out: StreamingTrack[] = []
  for (const raw of rows) {
    const mapped = mapQQSongRow(raw)
    if (mapped) out.push(mapped)
  }
  return out
}

/** /user/daily-songs 与 /recommend/radar 都是 { code, songs[] }（顶层，不套 data）。 */
export function mapQQDailySongs(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.songs, (record.data as Record<string, unknown> | undefined)?.songs])
  if (!rows) throw shapeError('QQ 每日 30 首', json)
  return mapQQSongRows(rows)
}

/** 刷歌雷达（QQ 的「私人漫游」对应）：{ code, page, songs[], more }。 */
export function mapQQRadarTracks(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.songs, (record.data as Record<string, unknown> | undefined)?.songs])
  if (!rows) throw shapeError('QQ 刷歌雷达', json)
  return mapQQSongRows(rows)
}

/**
 * /recommend/toplists → { groups: [{ id, name, toplists: [{ id, title, ... }] }] }。
 *
 * 上游按「组」给榜单（巅峰榜/特色榜/地区榜…），界面是一张平铺的卡片墙，所以这里
 * 展平并保持上游顺序：featured 仍按顺序取前 4 张（与网易云同一条规则）。
 */
export function mapQQToplists(json: unknown): DiscoverToplist[] {
  const record = (json ?? {}) as Record<string, unknown>
  const groups = record.groups
  if (!Array.isArray(groups)) throw shapeError('QQ 排行榜', json)
  const out: DiscoverToplist[] = []
  const seen = new Set<string>()
  for (const groupRaw of groups) {
    if (!groupRaw || typeof groupRaw !== 'object') continue
    const group = groupRaw as Record<string, unknown>
    const charts = Array.isArray(group.toplists) ? group.toplists : []
    for (const chartRaw of charts) {
      if (!chartRaw || typeof chartRaw !== 'object') continue
      const chart = chartRaw as Record<string, unknown>
      const id = str(chart.id ?? chart.topId)
      const name = str(chart.title ?? chart.name)
      if (!id || !name || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name,
        cover: httpsCover(chart.cover ?? chart.headPicUrl ?? chart.frontPicUrl ?? chart.musichallPicUrl),
        description: str(chart.intro ?? chart.description),
        updateFrequency: str(chart.updateTime ?? chart.period),
        trackCount: num(chart.total ?? chart.totalNum),
        playCount: num(chart.listenNum ?? chart.playCount),
        featured: out.length < FEATURED_TOPLIST_COUNT
      })
    }
  }
  if (out.length === 0) throw shapeError('QQ 排行榜', json)
  return out
}

/** /recommend/playlists → { code, playlists: [{ tid, title, picurl, songnum, play_cnt, creator }] }。 */
export function mapQQPlaylists(json: unknown): DiscoverPlaylist[] {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.playlists, (record.data as Record<string, unknown> | undefined)?.playlists])
  if (!rows) throw shapeError('QQ 推荐歌单', json)
  const out: DiscoverPlaylist[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = str(row.tid ?? row.id ?? row.disstid)
    const name = str(row.title ?? row.name ?? row.dissname)
    if (!id || !name) continue
    const creator = row.creator
    out.push({
      id,
      name,
      cover: httpsCover(row.picurl ?? row.picUrl ?? row.cover),
      trackCount: num(row.songnum ?? row.songCount ?? row.trackCount),
      playCount: num(row.play_cnt ?? row.listenNum ?? row.playCount),
      creator: creator && typeof creator === 'object'
        ? str((creator as Record<string, unknown>).nick ?? (creator as Record<string, unknown>).name)
        : str(creator)
    })
  }
  if (out.length === 0) throw shapeError('QQ 推荐歌单', json)
  return out
}

/** /recommend/toplist → { code, toplist: {...}, songs: [...] }。 */
export function mapQQToplistTracks(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const rows = firstArray([record.songs, (record.data as Record<string, unknown> | undefined)?.songs, record.songinfo])
  if (!rows) throw shapeError('QQ 榜单曲目', json)
  return mapQQSongRows(rows)
}

/**
 * /getSongListDetail/:disstid → { response: { code, cdlist: [{ songlist: [...] }] } }。
 *
 * 官方歌单（百万收藏/歌手漫游等）匿名不可读时上游回 code:10；那说明这张歌单需要登录，
 * 由 isLoginFailure 之外的「空曲目 + 明确错误」路径处理，不在这里造一个空歌单。
 */
export function mapQQPlaylistDetailTracks(json: unknown): StreamingTrack[] {
  const record = (json ?? {}) as Record<string, unknown>
  const response = (record.response ?? record) as Record<string, unknown>
  const code = num(response.code)
  if (code === 10) throw new Error('这张 QQ 歌单需要登录后才能读取。请先在设置里登录 QQ 音乐。')
  const cdlist = response.cdlist
  const first = Array.isArray(cdlist) ? cdlist[0] : undefined
  const rows = first && typeof first === 'object'
    ? (first as Record<string, unknown>).songlist
    : firstArray([record.songs])
  if (!Array.isArray(rows)) throw shapeError('QQ 歌单曲目', json)
  return mapQQSongRows(rows)
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: unknown
  updatedAt: number
}

/**
 * 模块内 Map + TTL（**不落盘**：发现页的数据都能重新拉，落盘只会引入「旧数据被
 * 当成真数据」的一类 bug；PLAN 也明确要求内存缓存）。
 *
 * 上限 120 条、先进先出淘汰：发现歌单可以翻很多页，不设上限就是一条内存泄漏。
 */
export class DiscoverCache {
  private entries = new Map<string, CacheEntry>()

  constructor(private readonly limit = 120) {}

  /** 命中返回 {value, updatedAt}；TTL 过期当场删除（过期数据不该继续占内存）。 */
  read<T>(key: string, ttlMs: number, now: number): { value: T; updatedAt: number } | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (now - entry.updatedAt >= ttlMs) {
      this.entries.delete(key)
      return null
    }
    return { value: entry.value as T, updatedAt: entry.updatedAt }
  }

  write(key: string, value: unknown, now: number): void {
    this.entries.delete(key)
    this.entries.set(key, { value, updatedAt: now })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * 会话指纹：缓存必须按**账号**隔离。
 *
 * 同一台机器上换个账号登录，每日推荐/漫游/推荐歌单全是另一份内容；只按 URL 缓存
 * 会让新账号看到上一个账号的推荐。这里用 FNV-1a 摘要而不是原始 cookie ——
 * 缓存键里不该出现凭据本身（日志/内存转储里少一处就少一处）。
 */
export function cookieScope(cookie: string | undefined | null): string {
  const text = (cookie ?? '').trim()
  if (!text) return 'anon'
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return 'c' + hash.toString(16)
}

// ---------------------------------------------------------------------------
// 降级内核
// ---------------------------------------------------------------------------

export interface DiscoveryDeps {
  /**
   * 确保服务端就绪，并返回本次缓存作用域（账号指纹）。失败即抛错 ——
   * 调用方把它写进每个远端区块的 error，而不是让整页拒绝。
   */
  scope: (platform: DiscoverPlatform) => Promise<string>
  /** 发一次平台请求并返回解析后的 JSON；节流/风控/失败文案都在平台层。 */
  send: (platform: DiscoverPlatform, path: string) => Promise<unknown>
  /** 本地会话的登录态（**不联网**：一次发现页不该为「你是不是登录了」多花一次风控额度）。 */
  signedIn: (platform: DiscoverPlatform) => boolean
  now: () => number
}

interface SectionResult<T> {
  items: T[]
  error: string | null
  needsLogin: boolean
  updatedAt: number
}

/** 未登录时的「需要登录」区块：给引导，**不发请求**（省风控额度）。 */
function loginSection<T>(now: number): SectionResult<T> {
  return { items: [], error: null, needsLogin: true, updatedAt: now }
}

/**
 * 发现页降级内核。
 *
 * 所有方法都走「缓存 → 请求 → 归一；任何一步失败只影响这一段」的同一套骨架，
 * 所以抽成一个类而不是四个复制粘贴的函数。
 */
export class DiscoveryCore {
  constructor(
    private readonly deps: DiscoveryDeps,
    private readonly cache = new DiscoverCache()
  ) {}

  /** 登出/切换账号后调用：旧账号的推荐不能被新账号看到。 */
  reset(): void {
    this.cache.clear()
  }

  private async resolveScope(platform: DiscoverPlatform): Promise<{ scope: string; failure: null } | { scope: null; failure: string }> {
    try {
      return { scope: await this.deps.scope(platform), failure: null }
    } catch (error) {
      return { scope: null, failure: describeDiscoverFailure(error, platform) }
    }
  }

  /** 通用区块加载：缓存命中直接返回（**不打上游**），否则发一次请求。 */
  private async load<T>(
    platform: DiscoverPlatform,
    scope: string,
    cacheKey: string,
    ttlMs: number,
    path: string,
    map: (json: unknown) => T[],
    now: number
  ): Promise<SectionResult<T>> {
    // 缓存键带平台：两个平台的同名区块（例如 toplists）内容完全不同，不能互相命中。
    const key = platform + '|' + scope + '|' + cacheKey
    const hit = this.cache.read<T[]>(key, ttlMs, now)
    if (hit) return { items: hit.value, error: null, needsLogin: false, updatedAt: hit.updatedAt }
    try {
      const items = map(await this.deps.send(platform, path))
      this.cache.write(key, items, now)
      return { items, error: null, needsLogin: false, updatedAt: now }
    } catch (error) {
      // 登录态失效不是「错误」而是「该去登录」：给引导，别给红字。
      if (isLoginFailure(error)) return loginSection<T>(now)
      return { items: [], error: describeDiscoverFailure(error, platform), needsLogin: false, updatedAt: now }
    }
  }

  /** 首屏四区块。**永不整体抛错**（服务端没起也返回结构，错误写在各区块里）。 */
  async home(platform: DiscoverPlatform = 'netease'): Promise<DiscoverHome> {
    return platform === 'qq' ? this.homeQQ() : this.homeNetease()
  }

  private async homeNetease(): Promise<DiscoverHome> {
    const now = this.deps.now()
    const signedIn = this.deps.signedIn('netease')
    const resolved = await this.resolveScope('netease')
    const failure = resolved.failure

    const remoteFailed = <T>(): SectionResult<T> => ({
      items: [],
      error: failure,
      // 服务端没起来不是「需要登录」，error 里已经把下一步写清楚了。
      needsLogin: false,
      updatedAt: now
    })

    const load = <T>(key: string, ttl: number, path: string, map: (json: unknown) => T[]): Promise<SectionResult<T>> =>
      resolved.scope === null
        ? Promise.resolve(remoteFailed<T>())
        : this.load<T>('netease', resolved.scope, key, ttl, path, map, now)

    // 未登录时 daily/fm/playlists **不发请求**：个性化端点未登录只有 301/空数组，
    // 发了就是白花一次风控额度（PLAN §1.1「效率与风控」）。
    const daily: Promise<SectionResult<StreamingTrack>> = signedIn
      ? load('daily', DISCOVER_TTL_MS.daily, DISCOVER_PATHS.daily, mapDailySongs)
      : Promise.resolve(loginSection<StreamingTrack>(now))

    const fm: Promise<SectionResult<StreamingTrack>> = signedIn
      ? load('fm', DISCOVER_TTL_MS.fm, DISCOVER_PATHS.fmMode, mapFmTracks)
      : Promise.resolve(loginSection<StreamingTrack>(now))

    // 榜单与歌单广场是免登录公开内容：未登录也必须请求（发现页对未登录用户仍然有用）。
    const toplists: Promise<SectionResult<DiscoverToplist>> =
      load('toplists', DISCOVER_TTL_MS.toplists, DISCOVER_PATHS.toplists, mapToptlists)

    const playlists: Promise<SectionResult<DiscoverPlaylist>> = signedIn
      ? load('playlists', DISCOVER_TTL_MS.playlists, DISCOVER_PATHS.recommendPlaylists, mapRecommendPlaylists)
      : Promise.resolve(loginSection<DiscoverPlaylist>(now))

    const [dailyResult, fmResult, toplistResult, playlistResult] = await Promise.all([daily, fm, toplists, playlists])

    // 私人漫游：老服务端没有 mode 端点。只在**真的失败了**才回退一次 —— 回退也是一次
    // 真实上游请求（占一次节流槽），绝不能无条件并发，否则失败时请求数翻倍。
    let fmFinal = fmResult
    if (signedIn && fmFinal.error !== null && resolved.scope !== null) {
      fmFinal = await this.load<StreamingTrack>(
        'netease', resolved.scope, 'fm-fallback', DISCOVER_TTL_MS.fm, DISCOVER_PATHS.fmFallback, mapFmTracks, now)
    }

    const named = [
      { name: '每日推荐', error: dailyResult.error },
      { name: '私人漫游', error: fmFinal.error },
      { name: '排行榜', error: toplistResult.error },
      { name: '推荐歌单', error: playlistResult.error }
    ]
    const failed = named.filter(item => item.error !== null)
    // 汇总只报「哪些区块没取到」：具体原因由区块自己显示，不在页头重复四遍。
    const notice = failed.length === 0
      ? null
      : failed.length === named.length
        ? '发现页的数据都没取到。网易云服务端可能没有启动，或者网络不可用。'
        : '部分区块没取到：' + failed.map(item => item.name).join('、') + '。可以点「刷新」重试。'

    const section = <T>(result: SectionResult<T>): DiscoverSection<T> => result

    return {
      platform: 'netease',
      signedIn,
      sections: {
        daily: section(dailyResult),
        fm: section(fmFinal),
        toplists: section(toplistResult),
        playlists: section(playlistResult)
      },
      notice
    }
  }

  /**
   * QQ 音乐首屏四区块（v6.3）。
   *
   * 与网易云的映射差异（都来自上游实际能力，不编）：
   *  - daily → /user/daily-songs（**必须登录**；未登录不发请求）；
   *  - fm → /recommend/radar（刷歌模式，匿名可读；登录后更贴合口味）；
   *  - toplists → /recommend/toplists（公开）；
   *  - playlists → /recommend/playlists（公开，登录后更贴近个人口味）。
   */
  private async homeQQ(): Promise<DiscoverHome> {
    const now = this.deps.now()
    const signedIn = this.deps.signedIn('qq')
    const resolved = await this.resolveScope('qq')
    const remoteFailed = <T>(): SectionResult<T> => ({
      items: [],
      error: resolved.failure,
      needsLogin: false,
      updatedAt: now
    })
    const load = <T>(key: string, ttl: number, path: string, map: (json: unknown) => T[]): Promise<SectionResult<T>> =>
      resolved.scope === null
        ? Promise.resolve(remoteFailed<T>())
        : this.load<T>('qq', resolved.scope, key, ttl, path, map, now)

    // 每日 30 首是账号私人内容：未登录只有 401，发了就是白花一次风控额度。
    const daily: Promise<SectionResult<StreamingTrack>> = signedIn
      ? load('daily', DISCOVER_TTL_MS.daily, QQ_DISCOVER_PATHS.daily, mapQQDailySongs)
      : Promise.resolve(loginSection<StreamingTrack>(now))
    // 刷歌雷达与推荐歌单是公开内容（登录只影响推荐质量），未登录也请求。
    const fm = load<StreamingTrack>('fm', DISCOVER_TTL_MS.fm, QQ_DISCOVER_PATHS.radar(1), mapQQRadarTracks)
    const toplists = load<DiscoverToplist>('toplists', DISCOVER_TTL_MS.toplists, QQ_DISCOVER_PATHS.toplists, mapQQToplists)
    const playlists = load<DiscoverPlaylist>('playlists', DISCOVER_TTL_MS.playlists, QQ_DISCOVER_PATHS.recommendPlaylists(30), mapQQPlaylists)

    const [dailyResult, fmResult, toplistResult, playlistResult] = await Promise.all([daily, fm, toplists, playlists])
    const named = [
      { name: '每日 30 首', error: dailyResult.error },
      { name: '刷歌雷达', error: fmResult.error },
      { name: '排行榜', error: toplistResult.error },
      { name: '推荐歌单', error: playlistResult.error }
    ]
    const failed = named.filter(item => item.error !== null)
    const notice = failed.length === 0
      ? null
      : failed.length === named.length
        ? '发现页的数据都没取到。QQ 音乐服务端可能没有启动，或者网络不可用。'
        : '部分区块没取到：' + failed.map(item => item.name).join('、') + '。可以点「刷新」重试。'
    const section = <T>(result: SectionResult<T>): DiscoverSection<T> => result
    return {
      platform: 'qq',
      signedIn,
      sections: {
        daily: section(dailyResult),
        fm: section(fmResult),
        toplists: section(toplistResult),
        playlists: section(playlistResult)
      },
      notice
    }
  }

  /** 榜单详情（网易云：榜单 id 就是歌单 id；QQ：/recommend/toplist?id=）。 */
  async toplistTracks(platform: DiscoverPlatform = 'netease', id: unknown): Promise<DiscoverTracksResult> {
    return this.tracksFor(platform, 'toplist', id,
      platform === 'qq' ? '打开 QQ 榜单需要登录 QQ 音乐。请先在设置里登录。' : '打开榜单需要登录网易云。请先在设置里登录。')
  }

  /** 歌单详情（网易云：/playlist/track/all；QQ：/getSongListDetail/:id）。 */
  async playlistTracks(platform: DiscoverPlatform = 'netease', id: unknown): Promise<DiscoverTracksResult> {
    return this.tracksFor(platform, 'playlist', id,
      platform === 'qq' ? '打开 QQ 歌单需要登录 QQ 音乐。请先在设置里登录。' : '打开歌单需要登录网易云。请先在设置里登录。')
  }

  private async tracksFor(
    platform: DiscoverPlatform,
    kind: 'toplist' | 'playlist',
    id: unknown,
    loginHint: string
  ): Promise<DiscoverTracksResult> {
    const now = this.deps.now()
    const safe = validId(id)
    if (!safe) return { items: [], error: '没有拿到有效的' + (kind === 'toplist' ? '榜单' : '歌单') + ' id。请回到发现页重新点一次。' }
    const resolved = await this.resolveScope(platform)
    if (resolved.scope === null) return { items: [], error: resolved.failure }
    const plan = platform === 'qq'
      ? kind === 'toplist'
        ? { path: QQ_DISCOVER_PATHS.toplistSongs(safe), map: mapQQToplistTracks }
        : { path: QQ_DISCOVER_PATHS.playlistDetail(safe), map: mapQQPlaylistDetailTracks }
      : { path: playlistTracksPath(safe), map: mapPlaylistTracks }
    const result = await this.load<StreamingTrack>(
      platform, resolved.scope, kind + '|' + safe, DISCOVER_TTL_MS.playlistTracks, plan.path, plan.map, now)
    return { items: result.items, error: result.needsLogin ? loginHint : result.error }
  }

  /**
   * 发现歌单广场（免登录）。
   *
   * 网易云：按热度/最新 + 分类分页（page 从 1 开始）。
   * QQ：没有分类广场，只有一条「推荐歌单」流（/recommend/playlists）；
   * 上游明确说这一路不像有限列表（From 往后仍有条目、HasMore 却变 false），
   * 所以 QQ 只给第一页、hasMore 恒 false —— 不假装能无限翻页。
   */
  async playlistSquare(
    platform: DiscoverPlatform = 'netease',
    query: { cat?: unknown; order?: unknown; page?: unknown } = {}
  ): Promise<DiscoverPlaylistsPage> {
    const now = this.deps.now()
    const resolved = await this.resolveScope(platform)
    if (resolved.scope === null) {
      return { items: [], hasMore: false, total: 0, error: resolved.failure }
    }
    if (platform === 'qq') {
      const cacheKey = 'qq|' + resolved.scope + '|square|recommend'
      const cached = this.cache.read<PlaylistSquarePage>(cacheKey, DISCOVER_TTL_MS.playlists, now)
      if (cached) return { ...cached.value, error: null }
      try {
        const items = mapQQPlaylists(await this.deps.send('qq', QQ_DISCOVER_PATHS.recommendPlaylists(30)))
        const pageResult: PlaylistSquarePage = { items, total: items.length, hasMore: false }
        this.cache.write(cacheKey, pageResult, now)
        return { ...pageResult, error: null }
      } catch (error) {
        return { items: [], hasMore: false, total: 0, error: describeDiscoverFailure(error, 'qq') }
      }
    }
    const cat = sanitizeCat(query.cat)
    const order: 'hot' | 'new' = query.order === 'new' ? 'new' : 'hot'
    const page = clampPage(query.page)
    const cacheKey = 'netease|' + resolved.scope + '|square|' + cat + '|' + order + '|' + page
    // 缓存键必须含 (cat, order, page)：只按分类/排序缓存会让翻页直接看到上一页。
    const cached = this.cache.read<PlaylistSquarePage>(cacheKey, DISCOVER_TTL_MS.playlists, now)
    if (cached) return { ...cached.value, error: null }
    try {
      const pageResult = mapPlaylistSquare(await this.deps.send('netease', playlistSquarePath(cat, order, page)), page)
      this.cache.write(cacheKey, pageResult, now)
      return { ...pageResult, error: null }
    } catch (error) {
      return { items: [], hasMore: false, total: 0, error: describeDiscoverFailure(error) }
    }
  }
}

/**
 * 输入消毒：曲目/歌单 id 只接受数字串。
 *
 * 渲染层传来的任何东西都要先挑一遍（main/index.ts 的既有习惯）：这个 id 会拼进
 * URL，非数字形状一定是调用方或上游错了，不能直接放行。
 */
export function validId(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  return /^[0-9]{1,20}$/.test(text) ? text : ''
}

/** 分类名：上游接受中文分类，这里只做控制字符/长度封顶，不改写内容。 */
export function sanitizeCat(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return '全部'
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)
  return cleaned || '全部'
}

/** 页码封顶：不设上限时一个坏参数能让上游算出一个巨大的 offset。 */
export function clampPage(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_PLAYLIST_PAGE, Math.max(1, Math.floor(value)))
}
