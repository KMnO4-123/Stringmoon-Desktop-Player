/**
 * 「发现」页的数据契约（PLAN §1.1）。
 *
 * 为什么单开一个文件：shared/streaming.ts 是**平台层**契约（四个平台共用），
 * 而发现页这一版只做网易云一家；把「发现页能看到什么」与「平台能做什么」分开，
 * 将来接第二个平台的发现流时不必改既有语义（CONTRACT §4 只增不改）。
 *
 * 每个区块自带 error / needsLogin，而不是让整页抛错：一屏四个区块来自四个上游
 * 端点，任何一个失败都不该打掉另外三个（CONTRACT §5 还要求请求数可控 ——
 * 失败就如实标注，不靠整页重试把风控额度再花一遍）。
 */

import type { StreamingTrack } from './streaming'

/**
 * 发现页支持的平台（v6.3）。
 *
 * 写成显式联合而不是 string：接第三个平台时类型检查会把所有需要处理的分支列出来，
 * 界面与主进程不会各自猜一套。
 */
export type DiscoverPlatform = 'netease' | 'qq'

/**
 * 排行榜（/toplist/detail 的一行）。
 *
 * featured 由主进程按**上游返回顺序**标好（前几张进首页精选位），渲染层不再自己
 * 判断 —— 否则「精选」会变成第二个真相，换个端点就变了。
 */
export interface DiscoverToplist {
  id: string
  name: string
  cover: string | null
  description: string
  updateFrequency: string
  trackCount: number
  playCount: number
  featured: boolean
}

/** 歌单广场（/top/playlist 的一行）。 */
export interface DiscoverPlaylist {
  id: string
  name: string
  cover: string | null
  trackCount: number
  playCount: number
  /** 创建者昵称；上游有时只给 uid，这时是空串而不是编一个名字。 */
  creator: string
}

export interface DiscoverSection<T> {
  items: T[]
  /** 中文单句 + 下一步；成功时为 null。 */
  error: string | null
  /** 需要登录才有内容、且这次**没有**发请求（未登录时的每日推荐/私人漫游）。 */
  needsLogin: boolean
  /** 这批数据的抓取时刻（epoch ms）；缓存命中时保持原始抓取时间，界面才能说清「多旧」。 */
  updatedAt: number
}

export interface DiscoverHome {
  /** v6.3：网易云与 QQ 音乐。界面一次只看一个平台，切换会重新取数（缓存按平台隔离）。 */
  platform: DiscoverPlatform
  /** 本次判定所用的登录态（来自本地会话，不是一次额外网络请求）。 */
  signedIn: boolean
  sections: {
    daily: DiscoverSection<StreamingTrack>
    fm: DiscoverSection<StreamingTrack>
    toplists: DiscoverSection<DiscoverToplist>
    playlists: DiscoverSection<DiscoverPlaylist>
  }
  /** 部分失败时的一条汇总（中文、可展示）；全成功为 null。 */
  notice: string | null
}

/** 「发现歌单」分页。page 从 1 开始（offset = (page-1) * 30）。 */
export interface DiscoverPlaylistsQuery {
  /** 分类名，缺省「全部」（上游客服端接受中文分类名）。 */
  cat?: string
  order?: 'hot' | 'new'
  page?: number
}

export interface DiscoverPlaylistsPage {
  items: DiscoverPlaylist[]
  hasMore: boolean
  total: number
  error: string | null
}

export interface DiscoverTracksResult {
  items: StreamingTrack[]
  error: string | null
}

/**
 * 解码能力的一行。
 *
 * lossless 的含义是「这个扩展名**可能**是无损」：.ogg 里可能是 Vorbis（有损）也可能是
 * Ogg-FLAC（无损），.m4a 里可能是 AAC 也可能是 ALAC。真正的结论只能由引擎打开文件后
 * 如实上报（CR-032 的 decoders[] 是权威来源，静态矩阵只是没有引擎时的兜底说明）。
 */
export interface AudioFormatCapability {
  ext: string
  label: string
  kind: 'native' | 'system' | 'dsd' | 'unsupported'
  lossless: boolean
  /**
   * 本机到底有没有解它的解码器（引擎回包的 available，MF 实测，engine/src/mf_source.cpp:560-576）。
   *
   * 为什么 extension + kind 不够：.opus/.wma/.ac3 在**有** Media Foundation 解码器 MFT 的
   * 机器上能播，在没有的机器上不能 —— 同一份引擎、同一个扩展名，结论不同。
   * 缺省 true（没有回包的旧引擎/静态矩阵按「声明即支持」处理，但静态矩阵里
   * 本机确实没有解码器的项会显式写 false）。
   */
  available: boolean
}

export interface DsdCapability {
  supported: boolean
  modes: string[]
  output: 'pcm' | 'native' | 'dop'
}

export interface AudioCapabilities {
  formats: AudioFormatCapability[]
  dsd: DsdCapability
  /**
   * 引擎 get_capabilities 的原始回包（旧引擎 / 失败时为 null，界面据此标注「引擎未上报」）。
   *
   * 归一化只消费 decoders / dsd（含 available）；引擎可能回**更多**字段
   * （例如 systemDecoders 是 MF 是否可用，见 app.cpp:1542），客户端不消费，
   * 但原样保留在这里 —— 需要诊断时能直接看到引擎到底说了什么。
   */
  engine: unknown
}

/**
 * 静态已知矩阵：**只在引擎不回 get_capabilities 时**使用（旧引擎、mock 引擎、请求超时）。
 *
 * 依据（都取自现有实现，不猜能力）：
 *  - catalog.cpp:19-20 的扫描白名单：.flac/.wav/.mp3/.m4a/.aac/.ogg/.oga/.opus；
 *  - audio_source.cpp:81 的容器判定：FLAC/WAV/Ogg(Vorbis|FLAC)/Opus；Ogg-Opus 能识别
 *    但当前不解码（audio_source.cpp:124-126），所以 .opus 如实标 unsupported + available:false；
 *  - mp4_source.cpp:1-2：MP4 里的 AAC/ALAC 由 Media Foundation 解码（kind:'system'）。
 *
 * 三条克制：
 *  1. **不写系统解码格式**（.opus/.wma/.aif/.aiff/.ac3/.aac 的 MF 路径）：能不能解是
 *     **本机实测**（.wma/.ac3 有多少机器没有对应 MFT），没有引擎回包时我们无从得知，
 *     写 available:true 就是替用户的机器吹牛；这份兜底只列本项目自己就能解码的格式。
 *  2. **.m4a/.oga 的 lossless 一律 false**：两者都是容器而不是编解码器（MP4 里可能是
 *     AAC 也可能 ALAC，Ogg 里可能是 Vorbis 也可能 Ogg-FLAC），典型语义按有损报，
 *     与引擎自己的矩阵口径一致；真正的无损结论由引擎打开文件后上报 sourceExact。
 *  3. **不写 DSD**（.dsf/.dff）：本轮引擎还没落地。
 */
export const STATIC_AUDIO_FORMATS: readonly AudioFormatCapability[] = [
  { ext: '.flac', label: 'FLAC', kind: 'native', lossless: true, available: true },
  { ext: '.wav', label: 'WAV', kind: 'native', lossless: true, available: true },
  { ext: '.mp3', label: 'MP3', kind: 'native', lossless: false, available: true },
  { ext: '.ogg', label: 'Ogg Vorbis', kind: 'native', lossless: false, available: true },
  { ext: '.oga', label: 'Ogg (Vorbis/FLAC)', kind: 'native', lossless: false, available: true },
  { ext: '.m4a', label: 'MP4 (AAC/ALAC)', kind: 'system', lossless: false, available: true },
  // 当前实现能**识别** Ogg-Opus 但没有解码器（audio_source.cpp:124-126）：
  // kind 说「本引擎不支持」，available 说「这台机器的引擎播不了」，两个字段各说一件事。
  { ext: '.opus', label: 'Ogg Opus（本引擎尚无解码器）', kind: 'unsupported', lossless: false, available: false }
]

/** 没有引擎回包时的 DSD 结论：不知道就是「不能」，不假装支持。 */
export const DEFAULT_DSD_CAPABILITY: DsdCapability = { supported: false, modes: [], output: 'pcm' }

const FORMAT_KINDS: ReadonlySet<string> = new Set(['native', 'system', 'dsd', 'unsupported'])

/**
 * 把引擎 get_capabilities 的回包归一成界面形状；形状不合法返回 null（调用方退回静态矩阵）。
 *
 * 为什么不信任回包：CR-032 是新命令，旧引擎会回 ERR_UNSUPPORTED，而第三方/测试引擎
 * 可能回一个半截对象。逐字段挑出来是这里唯一的规矩 —— 把未知形状透传给界面，
 * 界面就会画出「支持 DSD」这种它没有依据的结论。
 */
export function normalizeEngineCapabilities(
  reply: unknown
): { formats: AudioFormatCapability[]; dsd: DsdCapability } | null {
  if (!reply || typeof reply !== 'object') return null
  const record = reply as Record<string, unknown>
  const decoders = record.decoders
  if (!Array.isArray(decoders)) return null
  const formats: AudioFormatCapability[] = []
  for (const entry of decoders) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const ext = typeof row.ext === 'string' ? row.ext.trim() : ''
    const kind = typeof row.kind === 'string' ? row.kind : ''
    if (!ext || !FORMAT_KINDS.has(kind)) continue
    formats.push({
      ext,
      label: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : ext,
      kind: kind as AudioFormatCapability['kind'],
      lossless: row.lossless === true,
      // 只有显式 false 才算「本机没有」：缺省/undefined 一律按可用处理（旧引擎不会回
      // available，这时按「引擎声明了就支持」的老语义走，不让界面凭空变灰）。
      available: row.available !== false
    })
  }
  if (formats.length === 0) return null
  const rawDsd = record.dsd
  const dsdRecord = rawDsd && typeof rawDsd === 'object' ? (rawDsd as Record<string, unknown>) : null
  const output: DsdCapability['output'] =
    dsdRecord?.output === 'native' || dsdRecord?.output === 'dop' ? dsdRecord.output : 'pcm'
  const modes: string[] = []
  if (Array.isArray(dsdRecord?.modes)) {
    for (const mode of dsdRecord.modes) if (typeof mode === 'string' && mode.trim()) modes.push(mode.trim())
  }
  return { formats, dsd: { supported: dsdRecord?.supported === true, modes, output } }
}
