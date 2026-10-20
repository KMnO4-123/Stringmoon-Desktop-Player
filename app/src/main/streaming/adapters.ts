/**
 * 三个平台的**纯函数**适配层：URL 构造 + 响应映射。
 *
 * 为什么不把这段混进网络层：端点的形状只能对着各自的官方文档写，
 * 而"形状对不上"是最难查的一类故障（表现为空列表而不是报错）。
 * 所以这里每个映射函数在认不出结构时**必须**抛出带"看到了哪些顶层字段"的错误，
 * 让一个错误的假设变成一条可诊断的信息，而不是静默的空结果。
 */

import { createHmac } from 'node:crypto'
import type { MetingSource, PlatformAccount, PlatformId, PlatformPlaylist, StreamingTrack } from '@shared/streaming'

export class ShapeError extends Error {
  constructor(what: string, value: unknown) {
    super(what + '：响应里没有预期的字段。顶层字段 = ' + describeKeys(value))
    this.name = 'ShapeError'
  }
}

function describeKeys(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value).slice(0, 60)
  const keys = Array.isArray(value) ? ['(array len ' + value.length + ')'] : Object.keys(value).slice(0, 12)
  return keys.join(', ') || '(empty object)'
}

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0)

function joinArtists(list: unknown): string {
  if (!Array.isArray(list)) return str(list)
  return list.map(item => (item && typeof item === 'object' ? str((item as Record<string, unknown>).name) : str(item)))
    .filter(Boolean).join(' / ')
}

/**
 * 封面地址统一成 **https 直链**。
 *
 * 网易云与 QQ 的封面字段大量是 http：页面 CSP 只放行 https 图片，混着来会表现成
 * 「有的歌有封面、有的没有」，而原因根本不在那首歌上。这里统一升级，取不到就返回 null。
 */
export function httpsCover(value: unknown): string | null {
  const raw = str(value).trim()
  if (!raw) return null
  if (raw.startsWith('//')) return 'https:' + raw
  if (/^http:\/\//i.test(raw)) return 'https://' + raw.slice(7)
  return /^https:\/\//i.test(raw) ? raw : null
}

/** QQ 的专辑图只能由 album mid 拼出来（响应里通常不带现成 URL）。 */
export function qqAlbumCover(albumMid: string): string | null {
  const mid = albumMid.trim()
  return mid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + mid + '.jpg' : null
}

/** 取第一层对象里的第一个非空字段（平台响应里同名概念有 3–5 种拼法）。 */
function pickField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** 第一个「是数组」的候选。外壳层数在不同部署/版本之间不稳定，但类型判断是确定的。 */
function firstArray(candidates: unknown[]): unknown[] | undefined {
  return candidates.find((value): value is unknown[] => Array.isArray(value))
}

/**
 * QQ 的歌曲映射（搜索 / 歌单曲目 / 收藏 共用）。
 *
 * 三个易错点：
 *  1. 播放接口认 **songmid**（`mid`），不是数字 songid；
 *  2. `interval` 是**秒**，不是毫秒；
 *  3. 封面通常**只给 album.mid**，要自己拼 y.gtimg.cn 的 T002 地址。
 */
function qqMapSongs(songs: unknown[]): StreamingTrack[] {
  return songs.map((raw) => {
    const song = raw as Record<string, unknown>
    const album = (song.album ?? song.albumInfo) as Record<string, unknown> | undefined
    const albumMid = str(pickField(album ?? {}, ['mid', 'albumMid']) ?? pickField(song, ['albummid', 'albumMid', 'album_id']))
    return {
      platform: 'qq' as PlatformId,
      id: str(song.mid ?? song.songmid),
      title: str(song.name ?? song.title ?? song.songname),
      artist: joinArtists(song.singer ?? song.singers),
      album: str(album?.name ?? song.albumname),
      durationMs: num(song.interval) > 0 ? num(song.interval) * 1000 : num(song.duration) * 1000,
      cover: httpsCover(pickField(album ?? {}, ['picUrl', 'pic', 'cover'])) ?? qqAlbumCover(albumMid)
    }
  }).filter(track => track.id && track.title)
}

function neteaseMapSongs(songs: unknown[]): StreamingTrack[] {
  return songs.map((raw) => {
    const song = raw as Record<string, unknown>
    const album = (song.al ?? song.album) as Record<string, unknown> | undefined
    return {
      platform: 'netease' as PlatformId,
      id: str(song.id),
      title: str(song.name),
      artist: joinArtists(song.ar ?? song.artists),
      album: str(album?.name),
      durationMs: num(song.dt ?? song.duration),
      cover: httpsCover(album?.picUrl ?? album?.img1v1Url ?? song.picUrl)
    }
  }).filter(track => track.id && track.title)
}

// ---------------------------------------------------------------------------
// 网易云 —— @neteasecloudmusicapienhanced/api（NeteaseCloudMusicApi 路由）
// ---------------------------------------------------------------------------

export const netease = {
  /**
   * 用 **cloudsearch** 而不是老的 /search：
   *  - 老 /search 一次只给一页且结果偏少（用户看到的「搜索不全」）；
   *  - cloudsearch 支持 offset 翻页，字段也是同一套（result.songs）。
   * type=1 = 单曲。
   */
  search: (base: string, keyword: string, limit = 30, offset = 0): string =>
    base + '/cloudsearch?keywords=' + encodeURIComponent(keyword) + '&type=1&limit=' + limit + '&offset=' + offset,
  playUrl: (base: string, id: string, level = 'exhigh'): string =>
    base + '/song/url/v1?id=' + encodeURIComponent(id) + '&level=' + encodeURIComponent(level),
  lyric: (base: string, id: string): string =>
    // yv=-1 才会带字级 yrc（CONTRACT §4.4 实测结论）；tv=-1 带翻译。
    base + '/lyric?id=' + encodeURIComponent(id) + '&yv=-1&tv=-1',
  qrKey: (base: string): string => base + '/login/qr/key',
  qrCreate: (base: string, key: string): string =>
    base + '/login/qr/create?key=' + encodeURIComponent(key) + '&qrimg=true',
  qrCheck: (base: string, key: string): string => base + '/login/qr/check?key=' + encodeURIComponent(key),

  mapSearch(json: unknown): StreamingTrack[] {
    const result = (json as { result?: { songs?: unknown } })?.result
    const songs = (result as { songs?: unknown })?.songs
    if (!Array.isArray(songs)) throw new ShapeError('网易云搜索', json)
    // 与 /song/detail 同一套字段，复用同一个映射（曾经是两份一模一样的代码）。
    return neteaseMapSongs(songs)
  },

  /** 返回播放地址；拿不到时抛出带原因的错误（VIP/地区/版权是正常的商业结果，不是 bug）。 */
  mapPlayUrl(json: unknown): string {
    const data = (json as { data?: unknown })?.data
    const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined
    if (!first) throw new ShapeError('网易云播放地址', json)
    const url = str(first.url)
    if (!url) {
      const code = num(first.code ?? (json as { code?: unknown }).code)
      throw new Error('网易云没有给出播放地址（code=' + code + '）：通常是会员/地区/版权限制，不是网络问题。')
    }
    return url
  },

  mapLyric(json: unknown): { lrc: string; translation: string; wordLevel: string } {
    const record = json as Record<string, unknown>
    const pick = (key: string): string => {
      const field = record[key]
      if (typeof field === 'string') return field
      if (field && typeof field === 'object') return str((field as Record<string, unknown>).lyric)
      return ''
    }
    return { lrc: pick('lrc'), translation: pick('tlyric'), wordLevel: pick('yrc') }
  },

  mapQrKey(json: unknown): string {
    const data = (json as { data?: Record<string, unknown> })?.data
    const unikey = str(data?.unikey)
    if (!unikey) throw new ShapeError('网易云扫码 key', json)
    return unikey
  },

  mapQrCreate(json: unknown): { image: string | null; url: string | null } {
    const data = (json as { data?: Record<string, unknown> })?.data
    return { image: str(data?.qrimg) || null, url: str(data?.qrurl) || null }
  },

  /** 801 等待 / 802 已扫 / 803 成功 / 800 过期。 */
  mapQrCheck(json: unknown): { code: number; cookie: string | null; detail: string | null } {
    const record = json as Record<string, unknown>
    const code = num(record.code)
    if (!code) throw new ShapeError('网易云扫码状态', json)
    return { code, cookie: str(record.cookie) || null, detail: str(record.message) || null }
  },

  loginStatus: (base: string): string => base + '/login/status',
  /**
   * 会话续期（v6 保活）。NeteaseCloudMusicApi 系列的 /login/refresh 会按当前 cookie
   * 换一份新的并延长有效期；有的部署不支持这个路由（404），所以调用方必须把它当
   * **尽力而为**：失败只记日志，最终结论以 /login/status 为准。
   */
  loginRefresh: (base: string): string => base + '/login/refresh',
  /** 账号收藏（歌曲）：先取 id 列表，再批量换歌名。两步都是公开接口。 */
  likelist: (base: string, uid: string): string => base + '/likelist?uid=' + encodeURIComponent(uid),
  songDetail: (base: string, ids: string[]): string =>
    base + '/song/detail?ids=' + encodeURIComponent(ids.join(',')),
  /** 歌单搜索：cloudsearch 的 type=1000 就是歌单。 */
  searchPlaylists: (base: string, keyword: string, limit = 30): string =>
    base + '/cloudsearch?keywords=' + encodeURIComponent(keyword) + '&type=1000&limit=' + limit,
  playlists: (base: string, uid: string): string =>
    base + '/user/playlist?uid=' + encodeURIComponent(uid) + '&limit=1000',
  playlistTracks: (base: string, id: string, limit = 1000, offset = 0): string =>
    base + '/playlist/track/all?id=' + encodeURIComponent(id) + '&limit=' + limit + '&offset=' + offset,

  /** /likelist 回的是 { ids: [...] }；空收藏是合法状态，返回空数组。 */
  mapLikedIds(json: unknown): string[] {
    const record = json as Record<string, unknown>
    const ids = record.ids ?? (record.data as Record<string, unknown> | undefined)?.ids
    if (!Array.isArray(ids)) return []
    return ids.map(value => str(value)).filter(Boolean)
  },

  /** /song/detail 回 { songs: [...] }，与搜索同一套字段，复用同一个映射。 */
  mapSongDetail(json: unknown): StreamingTrack[] {
    const songs = (json as { songs?: unknown }).songs
    if (!Array.isArray(songs)) throw new ShapeError('网易云歌曲详情', json)
    return neteaseMapSongs(songs)
  },

  /** cloudsearch type=1000：{ result: { playlists: [...] } }。 */
  mapSearchPlaylists(json: unknown): PlatformPlaylist[] {
    const record = json as Record<string, unknown>
    const result = record.result as Record<string, unknown> | undefined
    const list = (Array.isArray(result?.playlists) ? result.playlists : undefined)
      ?? (Array.isArray(record.playlists) ? record.playlists : undefined)
    if (!Array.isArray(list)) throw new ShapeError('网易云歌单搜索', json)
    return list.map((raw) => {
      const playlist = raw as Record<string, unknown>
      return {
        platform: 'netease' as PlatformId,
        id: str(playlist.id),
        name: str(playlist.name),
        trackCount: num(pickField(playlist, ['trackCount', 'track_count', 'songCount'])),
        cover: httpsCover(pickField(playlist, ['coverImgUrl', 'coverUrl', 'picUrl']))
      }
    }).filter(item => item.id && item.name)
  },

  /** profile 为空 = 未登录（这是一个正常状态，不是错误）。 */
  mapAccount(json: unknown): PlatformAccount {
    const data = (json as { data?: Record<string, unknown> })?.data
    const profile = data?.profile as Record<string, unknown> | undefined
    const uid = str(profile?.userId) || null
    return {
      platform: 'netease',
      signedIn: !!uid,
      uid,
      nickname: str(profile?.nickname) || null,
      avatar: str(profile?.avatarUrl) || null
    }
  },

  mapPlaylists(json: unknown): PlatformPlaylist[] {
    const record = json as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    // 老版本的 api-enhanced 把 playlist 包在 data 里；两种都认。
    const list = Array.isArray(record.playlist) ? record.playlist
      : Array.isArray(data?.playlist) ? data?.playlist : undefined
    if (!Array.isArray(list)) throw new ShapeError('网易云歌单列表', json)
    return list.map((raw) => {
      const playlist = raw as Record<string, unknown>
      return {
        platform: 'netease' as PlatformId,
        id: str(playlist.id),
        name: str(playlist.name),
        trackCount: num(pickField(playlist, ['trackCount', 'track_count', 'songCount'])),
        cover: httpsCover(pickField(playlist, ['coverImgUrl', 'coverUrl', 'picUrl']))
      }
    }).filter(item => item.id && item.name)
  },

  mapPlaylistTracks(json: unknown): StreamingTrack[] {
    const songs = (json as { songs?: unknown })?.songs
    if (!Array.isArray(songs)) throw new ShapeError('网易云歌单曲目', json)
    return neteaseMapSongs(songs)
  }
}

// ---------------------------------------------------------------------------
// QQ —— @yakult-green-tea/qq-music-api
// 官方文档：/search、/getMusicPlay、/getLyric、/login/qr/{key,create,check}
// ---------------------------------------------------------------------------

export const qq = {
  /**
   * QQ 服务端把每页写死在上限 20（services/search/search.js 的 MAX_LIMIT=20），
   * 想多要只能**翻页**——所以这里必须吃 page，否则永远只有第一页那 20 条。
   */
  search: (base: string, keyword: string, limit = 20, page = 1): string =>
    base + '/search?keyword=' + encodeURIComponent(keyword) + '&type=song&page=' + Math.max(1, page) +
    '&limit=' + Math.min(20, Math.max(1, limit)),
  // quality 的取值域是服务端 getMusicPlay 实测的：best / flac / 320 / 128 / ape。
  playUrl: (base: string, songmid: string, quality = 'best'): string =>
    base + '/getMusicPlay/' + encodeURIComponent(songmid) + '?quality=' + encodeURIComponent(quality) + '&resType=play',
  // 实测：参数名是 songmid，写 id 会回 400 {"response":"no songmid"}。
  lyric: (base: string, songmid: string): string =>
    base + '/getLyric?songmid=' + encodeURIComponent(songmid) + '&trans=1',
  qrKey: (base: string, channel = 'qq'): string => base + '/login/qr/key?channel=' + channel,
  qrCreate: (base: string, key: string): string => base + '/login/qr/create?key=' + encodeURIComponent(key),
  qrCheck: (base: string, key: string): string => base + '/login/qr/check?key=' + encodeURIComponent(key),
  loginStatus: (base: string): string => base + '/login/status',
  /** 这个部署支持哪些扫码通道（qq / wechat / qqmusic）以及会话模式。 */
  loginChannels: (base: string): string => base + '/login/channels',

  mapSearch(json: unknown): StreamingTrack[] {
    const record = json as Record<string, unknown>
    const items = record.items
    if (!Array.isArray(items)) throw new ShapeError('QQ 搜索', json)
    return qqMapSongs(items)
  },

  /**
   * 播放地址的形状上游没有写成契约，所以这里按"已知的几种都可能"取，取不到就报出来。
   * 宁可多几行提取，也不要把一个空地址当成"这首歌不能播"——那是两件事。
   */
  mapPlayUrl(json: unknown): string {
    const walk = (value: unknown, depth: number): string | null => {
      if (depth > 6 || value === null || typeof value !== 'object') return null
      if (Array.isArray(value)) {
        for (const item of value) { const found = walk(item, depth + 1); if (found) return found }
        return null
      }
      const record = value as Record<string, unknown>
      for (const key of ['url', 'playUrl', 'play_url', 'src', 'purl']) {
        const raw = record[key]
        if (typeof raw === 'string' && /^https?:\/\//.test(raw)) return raw
        if (typeof raw === 'string' && raw.startsWith('M') && raw.length > 20) {
          // 上游有时给 purl（去掉前缀的路径），这里还原成完整地址。
          return 'https://ws.stream.qqmusic.qq.com/' + raw
        }
      }
      for (const key of Object.keys(record)) {
        const found = walk(record[key], depth + 1)
        if (found) return found
      }
      return null
    }
    const url = walk(json, 0)
    if (!url) {
      // 实测形状：{ data: { playUrl: { <songmid>: { url: "", error: "暂无播放链接",
      //   restriction: { key, codes: { result, subcode } } } } } }
      // 也就是说"拿不到地址"是 HTTP 200 里的一个**正常业务结果**，
      // 所以这里必须把上游给的原因说出来，而不是报一句"响应里没有预期字段"。
      const reason = findFirstString(json, ['error', 'message', 'hint'])
      const code = findFirstNumber(json, ['result', 'code'])
      const parts = [reason, code !== null ? 'code=' + code : null].filter(Boolean).join(' / ')
      if (parts) {
        throw new Error('QQ 没有给出播放地址（' + parts + '）：通常是会员/版权限制，或需要先扫码登录。')
      }
      throw new ShapeError('QQ 播放地址', json)
    }
    return url
  },

  mapQrKey(json: unknown): string {
    const data = (json as { data?: Record<string, unknown> })?.data
    const unikey = str(data?.unikey ?? data?.key)
    if (!unikey) throw new ShapeError('QQ 扫码 key', json)
    return unikey
  },

  mapQrCreate(json: unknown): { image: string | null; url: string | null } {
    const data = (json as { data?: Record<string, unknown> })?.data
    return { image: str(data?.qrimg) || null, url: str(data?.qrurl ?? data?.url) || null }
  },

  mapQrCheck(json: unknown): { code: number; cookie: string | null; detail: string | null } {
    const record = json as Record<string, unknown>
    const code = num(record.code)
    if (!code) throw new ShapeError('QQ 扫码状态', json)
    const data = record.data as Record<string, unknown> | undefined
    const cookie = str(data?.cookie ?? record.cookie) || null
    // 800 时上游会带 failureStage/failureReason/failureHint；把它们原样带到界面，
    // 用户才知道「是没扫、扫错 App、还是 MQTT/网络失败」——全都写「过期」等于没说。
    const hint = record.failureHint as Record<string, unknown> | undefined
    const detail = str(hint?.message) || str(record.message) || str(record.failureReason) || null
    return { code, cookie, detail }
  },

  playlists: (base: string): string => base + '/user/playlist',
  /**
   * 歌单曲目有两条路（Folia qqProvider 的结论，我们照抄并补上顺序）：
   *  - 匿名 GET /getSongListDetail/:disstid：**收藏/分享的歌单**完整（带凭据的路由实测会少一首付费歌）；
   *  - 带凭据 GET /user/playlist-detail?tid=&dirid=：只有它读得到不公开的自建歌单。
   * 先匿名、读不到（cdlist 没有 dissname）再回落到带凭据 —— 两条顺序反过来会让收藏歌单少歌。
   */
  playlistTracks: (base: string, tid: string, limit = 100, offset = 0): string =>
    base + '/user/playlist-detail?tid=' + encodeURIComponent(tid) + '&limit=' + limit + '&offset=' + offset,
  songListDetail: (base: string, disstid: string): string =>
    base + '/getSongListDetail/' + encodeURIComponent(disstid),
  /** 账号收藏：QQ 服务端直接给「我喜欢」的曲目，支持分页。 */
  likedSongs: (base: string, limit = 100, offset = 0): string =>
    base + '/user/liked-songs?limit=' + Math.min(100, Math.max(1, limit)) + '&offset=' + Math.max(0, offset),
  /** 歌单搜索：QQ 的 search 支持 type=playlist（SEARCH_TYPES 里实测有）。 */
  searchPlaylists: (base: string, keyword: string, limit = 20): string =>
    base + '/search?keyword=' + encodeURIComponent(keyword) + '&type=playlist&limit=' + limit,

  /**
   * QQ 的登录资料字段名与直觉不符，这里按**服务端源码**取：
   * routes/operations/loginStatus.js 回 `{ code: 200, data: { profile } }`，
   * 而 profile 来自 services/auth/authenticatedReads.js 的 getLoginProfile()：
   *   publicProfileFromCredential() → { musicid, str_musicid, nickname, nick, avatarUrl }
   *   getLoginUser() 的结果再铺一层（账号字段在嵌套的 info 里）
   * **没有 uin / uid / userId** —— 以前按那些名字找，于是「服务端已经把 profile 返回了，
   * 我们却判定未登录」。
   */
  mapAccount(json: unknown): PlatformAccount {
    const record = json as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const profile = (data?.profile ?? record.profile) as Record<string, unknown> | undefined
    const sources: Array<Record<string, unknown>> = [
      profile ?? {},
      (profile?.info as Record<string, unknown> | undefined) ?? {}
    ]
    const pick = (...keys: string[]): string | null => {
      for (const source of sources) {
        for (const key of keys) {
          const value = str(source[key])
          if (value) return value
        }
      }
      return null
    }
    const uid = pick('musicid', 'str_musicid', 'uin', 'uid', 'userId')
    return {
      platform: 'qq',
      signedIn: !!uid,
      uid,
      nickname: pick('nickname', 'nick', 'name', 'nickName'),
      avatar: pick('avatarUrl', 'headpic', 'avatar', 'logo', 'pic')
    }
  },

  /** QQ 歌单搜索结果：形状同样多层，按已知几种取。 */
  mapSearchPlaylists(json: unknown): PlatformPlaylist[] {
    const record = json as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const body = data?.body as Record<string, unknown> | undefined
    const candidates = [body?.disslist, data?.disslist, data?.list, record.disslist, record.list]
    const list = candidates.find(Array.isArray) as unknown[] | undefined
    if (!list) throw new ShapeError('QQ 歌单搜索', json)
    return list.map((raw) => {
      const playlist = raw as Record<string, unknown>
      return {
        platform: 'qq' as PlatformId,
        id: str(playlist.dissid ?? playlist.tid ?? playlist.dirId ?? playlist.id),
        name: str(playlist.dissname ?? playlist.title ?? playlist.name),
        trackCount: num(pickField(playlist, ['song_count', 'songCount', 'songnum', 'listennum'])),
        cover: httpsCover(pickField(playlist, ['imgurl', 'picurl', 'picUrl', 'logo', 'cover']))
      }
    }).filter(item => item.id && item.name)
  },

  /**
   * QQ 的「我的歌单」。
   *
   * ⚠️ 真实回包是**顶层**的 `{ code, playlist, total, more }`（服务端
   * `userPlaylistResponse.js` 的 toUserPlaylistBody 逐字如此），**没有 data 这一层**。
   * 以前只找 data.list / record.list / *.playlists，于是「登录成功、歌单也有，
   * 界面却报『响应里没有预期的字段』」。四种外壳都认，认不出才报错。
   *
   * 条目有两套来源：自建歌单来自 `GetPlaylistByUin`（tid / dirName / songNum），
   * 收藏歌单来自 `CgiGetPlaylistFavInfo`（dissid / dissname / logo / song_count）。
   */
  mapPlaylists(json: unknown): PlatformPlaylist[] {
    const record = json as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const list = firstArray([
      record.playlist, data?.playlist, data?.list, record.list, data?.playlists, record.playlists
    ])
    if (!Array.isArray(list)) throw new ShapeError('QQ 歌单列表', json)
    return list.map((raw) => {
      const playlist = raw as Record<string, unknown>
      const cover = httpsCover(pickField(playlist, ['bigpicUrl', 'picUrl', 'picurl', 'coverUrl', 'logo', 'albumPicUrl', 'imgurl', 'cover', 'pic']))
      return {
        platform: 'qq' as PlatformId,
        id: str(pickField(playlist, ['tid', 'dissid', 'dirId', 'dirid', 'id', 'disstid'])),
        name: str(pickField(playlist, ['dirName', 'dissname', 'name', 'title'])),
        trackCount: num(pickField(playlist, ['songNum', 'songnum', 'song_count', 'songCount', 'song_cnt', 'total', 'listennum'])),
        cover
      }
    }).filter(item => item.id && item.name)
  },

  /** 歌单曲目 / 收藏曲目 / 我喜欢：三种回包都是 `{ code, songs, total, more }`。 */
  mapPlaylistTracks(json: unknown): StreamingTrack[] {
    const record = json as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const songs = firstArray([record.songs, data?.songs, record.songlist, data?.songlist, data?.list, record.list])
    if (!Array.isArray(songs)) throw new ShapeError('QQ 歌单曲目', json)
    return qqMapSongs(songs)
  },

  /**
   * 匿名歌单详情：后端回 `{ response: { code, cdlist: [detail] } }`。
   *
   * "读不到"与"空歌单"的区别只在 dissname：不公开/不存在的歌单，上游照样回 code 0，
   * 但 cdlist[0] 没有 dissname、songlist 是空数组（Folia 2026-09-11 的真实账号实测）。
   * 我们据此决定是否回落到带凭据的 /user/playlist-detail。
   */
  mapSongListDetail(json: unknown): { name: string; tracks: StreamingTrack[]; total: number; readable: boolean } {
    const record = json as Record<string, unknown>
    const response = (record.response ?? record) as Record<string, unknown>
    const cdlist = response?.cdlist
    const detail = Array.isArray(cdlist) ? (cdlist[0] as Record<string, unknown> | undefined) : undefined
    const name = detail ? str(detail.dissname) : ''
    const songs = detail && Array.isArray(detail.songlist) ? detail.songlist : []
    const total = detail ? num(detail.total_song_num ?? detail.songnum) : 0
    return {
      name,
      tracks: qqMapSongs(songs),
      total: total > 0 ? total : songs.length,
      readable: Boolean(detail && name)
    }
  },

  /** 带凭据的自建歌单曲目：`{ code, songs, total, more }`（与 /user/liked-songs 同形）。 */
  mapOwnedPlaylistTracks(json: unknown): { tracks: StreamingTrack[]; total: number; more: boolean } {
    const record = json as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const songs = firstArray([record.songs, data?.songs])
    if (!Array.isArray(songs)) throw new ShapeError('QQ 自建歌单曲目', json)
    const total = num(record.total ?? data?.total)
    return { tracks: qqMapSongs(songs), total: total > 0 ? total : songs.length, more: record.more === true || data?.more === true }
  }
}

// ---------------------------------------------------------------------------
// Meting —— meting-api（metowolf，Hono）
// GET /api?server=&type=&id=；url 走 302；lrc 是纯文本；url/lrc/pic 需要 HMAC 令牌
// ---------------------------------------------------------------------------

export function metingServerFor(platform: PlatformId): MetingSource {
  if (platform === 'netease') return 'netease'
  if (platform === 'qq') return 'tencent'
  return 'kugou'
}

/** HMAC-SHA1(METING_TOKEN, server + type + id)，与 meting-api 的鉴权公式一致。 */
export function metingToken(secret: string, server: string, type: string, id: string): string {
  return createHmac('sha1', secret).update(server + type + id).digest('hex')
}

export function idFromMetingLink(link: unknown): string | null {
  if (typeof link !== 'string') return null
  try {
    return new URL(link).searchParams.get('id')
  } catch {
    return null
  }
}

export const meting = {
  endpoint: (base: string, server: MetingSource, type: string, id: string, token?: string): string =>
    base + '/api?server=' + encodeURIComponent(server) + '&type=' + type + '&id=' + encodeURIComponent(id)
      + (token ? '&token=' + token : ''),

  mapSearch(json: unknown): StreamingTrack[] {
    if (!Array.isArray(json)) throw new ShapeError('Meting 搜索', json)
    return json.map((raw) => {
      const item = raw as Record<string, unknown>
      // Meting 的搜索结果不给 id，只给三条**它自己的** API 链接；id 必须从链接里取。
      const id = idFromMetingLink(item.url) ?? idFromMetingLink(item.lrc) ?? ''
      return {
        platform: 'meting' as PlatformId,
        id,
        title: str(item.title ?? item.name),
        artist: str(item.author ?? item.artist),
        album: str(item.album ?? ''),
        durationMs: 0
      }
    }).filter(track => track.id && track.title)
  }
}

function findFirstString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFirstString(item, keys, depth + 1); if (found) return found }
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  for (const key of Object.keys(record)) {
    const found = findFirstString(record[key], keys, depth + 1)
    if (found) return found
  }
  return null
}

function findFirstNumber(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFirstNumber(item, keys, depth + 1); if (found !== null) return found }
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  }
  for (const key of Object.keys(record)) {
    const found = findFirstNumber(record[key], keys, depth + 1)
    if (found !== null) return found
  }
  return null
}

/** 302 的 Location。取不到时返回 null，由调用方给出具体错误。 */
export function locationFromRedirect(headers: Record<string, string | undefined>): string | null {
  const value = headers['location'] ?? headers['Location']
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : null
}
