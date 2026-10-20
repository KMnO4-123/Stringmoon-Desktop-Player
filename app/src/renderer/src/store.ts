import { create } from 'zustand'
import type { DitherConfig, FadeConfig, LatencyProfile, RepeatMode, ResamplerConfig, SpatialState, Track } from '@shared/protocol'
import type { StreamingTrack } from '@shared/streaming'

/**
 * 应用**请求过**的输出模式偏好。它与 outputMode（引擎上报的**实际**模式）是两件事：
 * 请求独占而端点拒绝时会降级成共享，此时偏好仍是 exclusive、实际是 shared ——
 * 两个都显示出来才是诚实的（CONTRACT §3.4：降级是引擎的选择，不是错误）。
 */
export type OutputPreference = 'auto' | 'exclusive' | 'shared'
import type { EngineStateSnapshot } from './c2/encodePath'
import { setPosition, resetPosition } from './positionStore'
import { applyMeterFrame, resetMeter } from './audio/meterStore'
import { redactSensitiveText } from '@shared/redact'
import { isUnderRoot, libraryPathKey, type LibraryDirectories } from '@shared/library'
import { parseDspState, responseParameterKey, RESPONSE_HISTORY_LIMIT } from './audio/dspState'
import type { ConfirmedDsp, DspHistoryEntry } from './audio/dspState'

/**
 * 播放状态 store —— intent + 权威状态模型（REFS-B E1.1 / E1.2 临时 B 方案）。
 *
 * 铁律（CONTRACT §3.3）：引擎的 state/position 事件是权威值。
 * 在此之上应用侧维护两层 UI 语义（都是「等待被权威状态纠正」的中间态）：
 *  - intent：用户刚点了某首歌（open→play 链路在途）。此间收到 trackId 不匹配的
 *    事件按过期丢弃（连点下一首，旧曲响应晚到不会把 UI 拉回去）；
 *    匹配的事件到达即确认 intent。
 *  - seekPending：seek 已发出、引擎尚未回第一个 position。期间 UI 不假装已完成。
 *
 * loading（打开文件→出声之间）= intent 在途；平台层并发 loading 见 ipc.ts 请求计数。
 */
export type PlayState = 'no-track' | 'loading' | 'playing' | 'paused'

/**
 * 输出偏好与规格的持久化。
 *
 * localStorage 在 node 侧用例里不存在（app-state 测试直接 import 这个模块），
 * 所以读取必须容错；写失败也只是「下次启动回到默认」，不影响本次播放。
 * ⚠️ 引擎自己**不持久化**这两项（它是无状态的音频进程），所以 App 握手后会
 * 用 applyOutputPreference() 把它们重新下发一次。
 */
const OUTPUT_PREF_KEY = 'stringmoon.output-mode'
const OUTPUT_RATE_KEY = 'stringmoon.output-rate'

function readStoredOutputPreference(): OutputPreference {
  try {
    const value = globalThis.localStorage?.getItem(OUTPUT_PREF_KEY)
    return value === 'exclusive' || value === 'shared' || value === 'auto' ? value : 'auto'
  } catch { return 'auto' }
}

function readStoredOutputRate(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(OUTPUT_RATE_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch { return 0 }
}

function persistOutputPreference(mode: OutputPreference): void {
  try { globalThis.localStorage?.setItem(OUTPUT_PREF_KEY, mode) } catch { /* 本次会话仍然有效 */ }
}

function persistOutputRate(rate: number): void {
  try { globalThis.localStorage?.setItem(OUTPUT_RATE_KEY, String(rate)) } catch { /* 本次会话仍然有效 */ }
}

/**
 * scan_progress 的界面节流。
 *
 * 引擎每扫到一个文件就发一条 scan_progress（91 首 = 91 次 set），而进度条只需要
 * 「大概到哪了」。不节流时扫描期间整棵界面按文件数重渲染，这正是启动片头最容易被
 * 拖慢的地方；节流后 ~8Hz，进度看起来仍然连续。
 * 语义不变：只降低 set 的频率，scan_done 仍会立刻清空进度。
 */
const SCAN_PROGRESS_INTERVAL_MS = 120
let lastScanProgressAt = 0

export interface TrackRow extends Track {
  uiIndex: number
}

interface Intent {
  seq: number
  trackId: string
}

/**
 * 曲库可见集 = 引擎给的全部条目 ∩ 当前曲库目录，按归一 path 去重（保留首次出现），
 * 再**剔除已被标记为无法播放的曲目**（CR-017）。
 *
 * 之所以要「∩ 目录」而不是直接用引擎的列表：引擎没有清空 catalog 的命令，
 * 移除一个曲库目录后它的条目仍留在引擎里，只有应用侧知道该不该显示。
 * `roots === null` 表示目录尚未解析（启动早期、单元测试），此时不做过滤。
 *
 * 之所以「剔除无法播放」由应用侧做而不是让引擎删掉：判定权在解码器，而**显示权**
 * 在应用侧。放在这里等于把「移除出列表」做成可逆的显示决定，而不是不可撤销的删除
 * —— 拔盘、权限、正在复制的文件都可能是误判（见 shared/unplayable.ts）。
 * `unplayable` 为 null 表示记录尚未载入；此时**不过滤**，宁可多显示也不静默藏歌。
 */
export function visibleTracks(engineTracks: Track[], roots: string[] | null, unplayable: readonly string[] | null = null): Track[] {
  const blocked = unplayable === null ? null : new Set(unplayable.map(libraryPathKey))
  const scoped = roots === null ? engineTracks : engineTracks.filter((track) => roots.some((root) => isUnderRoot(track.path, root)))
  const seen = new Set<string>()
  return scoped.filter((track) => {
    const key = libraryPathKey(track.path)
    // path 不可用的条目没有身份可言：宁可原样留着，也不静默丢掉一首曲子。
    if (!key) return true
    if (blocked?.has(key)) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface TwilightState {
  tracks: TrackRow[]
  /** 引擎返回的全部条目（未按曲库目录过滤），移除目录后仍要靠它把曲目还原回来。 */
  engineTracks: Track[]
  /** 生效的曲库目录；null = 尚未解析，不做过滤。 */
  libraryRoots: string[] | null
  /** 其中此刻不可用的目录（拔盘/删目录），用来诚实展示而不是假装它在。 */
  libraryMissing: string[]
  /**
   * 已被标记为无法播放的曲目路径（CR-017）。可见集按它过滤，所以这些曲目
   * **不出现在列表里**；null = 记录尚未载入（此时不过滤，宁可多显示也不静默藏歌）。
   */
  unplayablePaths: string[] | null
  loadedTrackId: string | null
  /**
   * 正在播的**在线曲目**（平台源）。
   *
   * 引擎对 `open { url }` 的 state 事件里 trackId 是**空字符串**（CR-016 约束 3：
   * URL 源没有曲库条目，元数据由应用侧提供）。只按 trackId 解析「正在播放」的话，
   * 在线播放会表现成「有声音、界面上什么都没有」—— 这就是这个字段存在的原因：
   * 在线播放的**展示元数据归应用侧**，播放状态仍归引擎。
   */
  onlineTrack: StreamingTrack | null
  playState: PlayState
  intent: Intent | null
  seekPending: boolean
  /** 平台层/引擎命令在途计数（>0 = 全局 loading；歌词请求不计数） */
  pendingRequests: number
  /**
   * 最近一次下发给引擎的队列（trackId 顺序）。与 tracks（可见列表，用户可排序）不同：
   * 记忆与「下一首预热」要的是引擎真正会接着放的那一首，所以单独存一份权威顺序。
   */
  queueIds: string[]
  durationMs: number
  outputMode: 'exclusive' | 'shared' | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  containerBits: number | null
  validBits: number | null
  deviceName: string | null
  periodMs: number | null
  bitPerfect: boolean | null
  resampled: boolean | null
  sourceSampleRate: number | null
  degradeReason: string | null
  dspCapable: boolean | null
  queueCapable: boolean | null
  /**
   * 引擎**实际生效**的专业设置（CR-024/025/027）。旧引擎不发这些字段 →
   * 保持 null（UI 显示「引擎不支持/未知」），不要用应用侧的请求值冒充实际值。
   */
  resampler: ResamplerConfig | null
  dither: DitherConfig | null
  latencyProfile: LatencyProfile | null
  /** CR-028：引擎实际过渡配置（旧引擎不发 → null，不拿请求值冒充）。 */
  fade: FadeConfig | null
  /** CR-029：引擎实际空间音频配置；active=引擎是否真的在处理。 */
  spatial: SpatialState | null
  dspActive: boolean | null
  dspModules: string[] | null
  dsp: ConfirmedDsp | null
  dspHistory: DspHistoryEntry[]
  engineEpoch: number
  dspRequestSequence: number
  xrunCount: number | null
  volume: number
  /** 引擎权威的静音；与 volume 独立（静音不改变音量）。 */
  muted: boolean
  /** 引擎权威的循环模式；四态一个枚举，随机是其中一态而不是叠加开关。 */
  repeatMode: RepeatMode
  /** 应用请求过的输出模式（见 OutputPreference 注释）；实际模式仍是 outputMode。 */
  outputPreference: OutputPreference
  /**
   * 应用请求过的**输出采样率**（0 = 跟随源）。与 sampleRate（引擎上报的实际值）
   * 是两件事：共享模式下 WASAPI 只能跑设备混音格式，所以请求可能不被采纳；
   * 两个都显示出来才是诚实的。
   */
  requestedOutputRate: number
  scanProgress: { done: number; total: number } | null
  scanDone: boolean
  protocolError: string | null
  connectionError: string | null
  /** 曲库目录相关的用户可读提示（记住的目录不可用等）；与协议/连接错误分开。 */
  libraryNotice: string | null
  engineUp: boolean
  applyEvent: (ev: unknown) => void
  applyHello: (reply: unknown) => void
  applyDsp: (reply: unknown, sequence: number, epoch: number) => void
  setTracks: (tracks: Track[]) => void
  setLibraryDirectories: (state: LibraryDirectories) => void
  setUnplayablePaths: (paths: string[] | null) => void
  setVolumeLocal: (v: number) => void
  setMutedLocal: (muted: boolean) => void
  setRepeatModeLocal: (mode: RepeatMode) => void
  setOutputPreference: (mode: OutputPreference) => void
  setOutputRateLocal: (rate: number) => void
  setProtocolError: (s: string | null) => void
  setConnectionError: (s: string) => void
  setLibraryNotice: (s: string | null) => void
  beginIntent: (trackId: string) => void
  confirmIntent: (trackId: string, durationMs: number | undefined) => void
  failIntent: (trackId: string, message: string) => void
  beginOnlinePlayback: (track: StreamingTrack) => void
  confirmOnlinePlayback: (durationMs: number, quality?: string | null) => void
  failOnlinePlayback: (message: string) => void
  clearOnlinePlayback: () => void
  beginSeek: () => void
  pushRequest: () => void
  popRequest: () => void
  setQueueIds: (ids: string[]) => void
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const RESAMPLER_QUALITIES = new Set(['HQ', 'VHQ', '24BIT'])
const RESAMPLER_PHASES = new Set(['linear', 'minimum', 'intermediate', 'maximum'])
const DITHER_MODES = new Set(['off', 'tpdf', 'highpass-tpdf', 'ns-5', 'ns-9', 'ultra-shaped'])
const LATENCY_PROFILES = new Set(['stable', 'balanced', 'lowLatency'])
/** 引擎没发 = undefined（保持旧值）；发了但形状不对 = null（如实表示未知）。 */
const parseResampler = (value: unknown): ResamplerConfig | null | undefined => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.quality !== 'string' || !RESAMPLER_QUALITIES.has(record.quality)
    || typeof record.phase !== 'string' || !RESAMPLER_PHASES.has(record.phase) || typeof record.steep !== 'boolean') return null
  return { quality: record.quality as ResamplerConfig['quality'], phase: record.phase as ResamplerConfig['phase'], steep: record.steep }
}
const parseDither = (value: unknown): DitherConfig | null | undefined => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.mode !== 'string' || !DITHER_MODES.has(record.mode) || typeof record.active !== 'boolean') return null
  return { mode: record.mode as DitherConfig['mode'], active: record.active }
}
const parseLatencyProfile = (value: unknown): LatencyProfile | null | undefined => {
  if (value === undefined) return undefined
  return typeof value === 'string' && LATENCY_PROFILES.has(value) ? value as LatencyProfile : null
}
const SPATIAL_MODES = new Set(['off', 'crossfeed', 'wide', 'virtual'])
const parseFade = (value: unknown): FadeConfig | null | undefined => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const ms = record.ms
  if (typeof ms !== 'number' || !Number.isFinite(ms) || typeof record.pauseHold !== 'boolean') return null
  return { ms, pauseHold: record.pauseHold }
}
const parseSpatial = (value: unknown): SpatialState | null | undefined => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.mode !== 'string' || !SPATIAL_MODES.has(record.mode)
    || typeof record.amount !== 'number' || !Number.isFinite(record.amount) || typeof record.active !== 'boolean') return null
  return { mode: record.mode as SpatialState['mode'], amount: Math.max(0, Math.min(1, record.amount)), active: record.active }
}
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const unavailableOutput = { outputMode: null, sampleRate: null, bitDepth: null, channels: null, containerBits: null, validBits: null, deviceName: null,
  periodMs: null, bitPerfect: null, resampled: null, sourceSampleRate: null, dspActive: null, dspModules: null, xrunCount: null,
  resampler: null, dither: null, latencyProfile: null, fade: null, spatial: null,
  // 引擎不在了，这两样「只有引擎知道」的状态也没有权威来源：回默认值，
  // 而不是把上一台引擎的循环模式/静音继续显示成当前事实。
  repeatMode: 'sequential' as RepeatMode, muted: false }

export function selectSignalSnapshot(s: TwilightState): EngineStateSnapshot {
  return {
    loaded: s.loadedTrackId !== null,
    trackId: s.loadedTrackId ?? undefined,
    outputMode: s.outputMode ?? undefined,
    sampleRate: s.sampleRate ?? undefined,
    sourceSampleRate: s.sourceSampleRate ?? undefined,
    resampled: s.resampled ?? undefined,
    bitPerfect: s.bitPerfect ?? undefined,
    degradeReason: s.degradeReason,
    dspCapable: s.dspCapable ?? undefined,
    dspActive: s.dspActive ?? undefined,
    dspModules: s.dspModules ?? undefined,
    xrunCount: s.xrunCount ?? undefined
  }
}

/**
 * 在线曲目 → 统一的 Track 形状（只用于**展示**，不是曲库条目）。
 *
 * 为什么合成一个 Track 而不是让每个组件各写一套：
 * 播放栏、音乐空间、歌词、播放详情、信息栏都是按 Track 的字段画的。
 * 让它们各自判断「这是本地还是在线」，等于把同一套分支复制五份；
 * 合成之后只有 selectLoadedTrack 这一处知道差别，其余组件一个字不用改。
 *
 * ⚠️ trackId 带 `online:` 前缀且**不参与任何引擎命令**（队列/打开都只认本地 id）。
 */
export function streamingAsTrack(track: StreamingTrack, durationMs = 0): Track {
  return {
    trackId: 'online:' + track.platform + ':' + track.id,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    durationMs: durationMs > 0 ? durationMs : track.durationMs,
    // 空 path 是有意的：在线曲目没有本地文件，任何按路径取图/取歌词的路径都必须
    // 先看 trackId 的 online: 前缀，而不是去 split 一个空字符串。
    path: '',
    codec: 'stream'
  }
}

/**
 * 当前装载的曲目，从**引擎全量列表**解析而不是可见集。
 *
 * 用户在播放时移除一个曲库目录，那首歌仍在放（`Player::stop()` 也不清
 * `currentTrackId_`，所以「先停再移除」也解不开），但它的条目已经不在可见集里。
 * 若「正在播放」也从可见集取，界面就会一边放着 A 一边显示 B，或谎称「未在播放」。
 * 所以曲库列表只显示所选目录，正在播放一律看引擎的全量列表。
 */
/**
 * 合成 Track 的缓存。
 *
 * ⚠️ 必须缓存：selectLoadedTrack 是作为 **zustand selector** 用的
 * （Playbar / MusicSpace / LyricsView 都是 `useTwilight(selectLoadedTrack)`）。
 * 每次返回新对象会让 useSyncExternalStore 认为快照一直在变 —— 渲染 → 读快照 →
 * 又不相等 → 再渲染，直到 React 抛 "Maximum update depth exceeded"（错误 #185）
 * 然后整棵界面卸载成白屏。本地曲目从数组里取，天然是稳定引用；合成出来的那个不是。
 */
let onlineTrackCache: { key: string; track: Track } | null = null

export function selectLoadedTrack(s: TwilightState): Track | null {
  const id = s.loadedTrackId
  if (id) return s.engineTracks.find((t) => t.trackId === id) ?? s.tracks.find((t) => t.trackId === id) ?? null
  // 在线播放：引擎给的 trackId 是空的（URL 源没有曲库条目），展示元数据来自
  // 应用侧的 onlineTrack —— 见该字段的注释。没有它才真的是「未在播放」。
  const online = s.onlineTrack
  if (!online) return null
  const key = [online.platform, online.id, s.durationMs, s.sourceSampleRate ?? 0, s.bitDepth ?? 0].join('|')
  if (onlineTrackCache?.key !== key) {
    const base = streamingAsTrack(online, s.durationMs)
    onlineTrackCache = {
      key,
      track: {
        ...base,
        ...(s.sourceSampleRate ? { sampleRate: s.sourceSampleRate } : {}),
        ...(s.bitDepth ? { bitDepth: s.bitDepth } : {})
      }
    }
  }
  return onlineTrackCache.track
}

export const useTwilight = create<TwilightState>()((set, get) => ({
  tracks: [],
  engineTracks: [],
  libraryRoots: null,
  libraryMissing: [],
  unplayablePaths: null,
  loadedTrackId: null,
  onlineTrack: null,
  playState: 'no-track',
  intent: null,
  seekPending: false,
  pendingRequests: 0,
  queueIds: [],
  durationMs: 0,
  outputMode: null,
  sampleRate: null,
  bitDepth: null,
  channels: null,
  containerBits: null,
  validBits: null,
  deviceName: null,
  periodMs: null,
  bitPerfect: null,
  resampled: null,
  sourceSampleRate: null,
  degradeReason: null,
  dspCapable: null,
  queueCapable: null,
  resampler: null,
  dither: null,
  latencyProfile: null,
  fade: null,
  spatial: null,
  dspActive: null,
  dspModules: null,
  dsp: null,
  dspHistory: [],
  engineEpoch: 0,
  dspRequestSequence: 0,
  xrunCount: null,
  volume: 0.8,
  muted: false,
  repeatMode: 'sequential',
  // 输出偏好与规格是「用户设置」，刷新/重启后应当还在（引擎侧重启会丢掉请求，
  // App 在握手后会重新下发一次 —— 见 ipc.applyOutputPreference）。
  outputPreference: readStoredOutputPreference(),
  requestedOutputRate: readStoredOutputRate(),
  scanProgress: null,
  scanDone: false,
  protocolError: null,
  connectionError: null,
  libraryNotice: null,
  engineUp: false,

  applyHello: (reply) => {
    const data = reply !== null && typeof reply === 'object' ? reply as Record<string, unknown> : {}
    const caps = data.capabilities !== null && typeof data.capabilities === 'object'
      ? data.capabilities as Record<string, unknown> : {}
    set({ engineUp: true, dspCapable: typeof caps.dsp === 'boolean' ? caps.dsp : null, queueCapable: typeof caps.queue === 'boolean' ? caps.queue : null })
  },

  applyDsp: (reply, sequence, epoch) => {
    const st = get()
    if (epoch !== st.engineEpoch || sequence < st.dspRequestSequence) return
    const dsp = parseDspState(reply)
    if (!dsp) {
      set({ dsp: null, dspHistory: [], dspRequestSequence: sequence })
      return
    }
    const key = responseParameterKey(dsp)
    const previous = st.dspHistory.at(-1)
    const dspHistory = previous?.key === key ? st.dspHistory
      : [...st.dspHistory, { dsp, sampleRate: st.sampleRate, key }].slice(-RESPONSE_HISTORY_LIMIT)
    set({ dsp, dspHistory, dspRequestSequence: sequence })
  },

  applyEvent: (ev) => {
    if (ev === null || typeof ev !== 'object') return
    const e = ev as Record<string, unknown>
    const evTrack = typeof e.trackId === 'string' && e.trackId ? e.trackId : null
    switch (e.ev) {
      case 'ready':
        // 引擎重启只说明「进程回来了」，上一台引擎在放的在线曲目已经不存在了。
        set(s => ({ ...unavailableOutput, onlineTrack: null, engineUp: true, dspCapable: null, queueCapable: null,
          dsp: null, dspHistory: [], engineEpoch: s.engineEpoch + 1, dspRequestSequence: 0 }))
        break
      case 'position': {
        const st = get()
        // 过期保护（E1.2 B 方案）：intent 在途时，属于其它曲目的事件丢弃
        if (st.intent && evTrack && evTrack !== st.intent.trackId) return
        if (evTrack && !st.intent) {
          // 无 intent 时：只接受已装载曲目的进度（其它曲目的尾部事件丢弃）
          if (evTrack !== st.loadedTrackId) return
        }
        setPosition({ trackId: evTrack ?? st.loadedTrackId, positionMs: num(e.positionMs), durationMs: num(e.durationMs) })
        const patch: Partial<TwilightState> = {}
        if (evTrack && evTrack !== st.loadedTrackId) patch.loadedTrackId = evTrack
        if (num(e.durationMs) > 0 && e.durationMs !== st.durationMs) patch.durationMs = num(e.durationMs)
        if (st.seekPending) patch.seekPending = false // 引擎确认对齐（E1.1 #5）
        if (Object.keys(patch).length) set(patch)
        break
      }
      case 'state': {
        const st = get()
        if (e.state !== 'playing' && e.state !== 'paused' && e.state !== 'stopped') return
        if (typeof e.trackId !== 'string') return
        if (st.intent && evTrack !== st.intent.trackId) return
        /**
         * 在线播放的判定。
         *
         * URL 源的 state 事件里 trackId 恒为空串（引擎侧注释：CR-016 约束 3，
         * 元数据归应用侧）。**空 trackId 不等于「没有在播」**：有声音、有进度、
         * 只是没有曲库条目。所以「有没有歌」这个问题由 onlineTrack 回答，
         * 「在不在放」仍然由引擎的 state 回答 —— 两件事不能互相顶替。
         *
         * 没有 onlineTrack 时空 trackId 仍然按未在播放处理：别的客户端也能让引擎
         * 放一个 URL，而这边没有它的元数据，不能编一个标题出来。
         */
        const online = !evTrack && st.onlineTrack !== null
        /**
         * 打开一个 URL 源时，引擎先发一条 **state=stopped**（"源已装载、尚未开播"），
         * 然后 play() 再发 playing。这条中间态**不是**「播放结束」：
         * 把它当成结束会清掉 onlineTrack，随后那条 playing 事件就没人认识了 ——
         * 表现正是「点了播放，标题闪一下变回未在播放，声音却在放」。
         * 所以只在「已经播过（playing/paused）之后的 stopped」才算会话结束。
         */
        const stopDuringLoad = online && e.state === 'stopped' && st.playState === 'loading'
        const modules = Array.isArray(e.dspModules) && e.dspModules.every(m => typeof m === 'string')
          ? e.dspModules as string[] : null
        const patch: Partial<TwilightState> = {
          loadedTrackId: evTrack,
          playState: !evTrack
            ? (online
                ? (e.state === 'playing' ? 'playing' : (stopDuringLoad || e.state === 'paused' ? 'paused' : 'no-track'))
                : 'no-track')
            : (e.state === 'playing' ? 'playing' : 'paused'),
          outputMode: e.outputMode === 'shared' || e.outputMode === 'exclusive' ? e.outputMode : null,
          sampleRate: num(e.sampleRate) || null,
          // 旧引擎不发这个字段：缺失时保持用户设的偏好，不要把它读回 0（那等于替用户改设置）。
          requestedOutputRate: typeof e.requestedOutputRate === 'number' && Number.isInteger(e.requestedOutputRate) && e.requestedOutputRate >= 0
            ? e.requestedOutputRate : st.requestedOutputRate,
          bitDepth: num(e.bitDepth) || null,
          channels: Number.isInteger(e.channels) && num(e.channels) > 0 ? num(e.channels) : null,
          containerBits: Number.isInteger(e.containerBits) && num(e.containerBits) > 0 ? num(e.containerBits) : null,
          validBits: Number.isInteger(e.validBits) && num(e.validBits) > 0 ? num(e.validBits) : null,
          deviceName: str(e.deviceName) || null,
          periodMs: num(e.periodMs) > 0 ? num(e.periodMs) : null,
          bitPerfect: typeof e.bitPerfect === 'boolean' ? e.bitPerfect : null,
          resampled: typeof e.resampled === 'boolean' ? e.resampled : null,
          sourceSampleRate: num(e.sourceSampleRate) || null,
          degradeReason: str(e.degradeReason) || null,
          dspActive: typeof e.dspActive === 'boolean' ? e.dspActive : null,
          dspModules: modules && st.dspModules && modules.length === st.dspModules.length && modules.every((m, i) => m === st.dspModules?.[i])
            ? st.dspModules : modules,
          xrunCount: typeof e.xrunCount === 'number' && Number.isSafeInteger(e.xrunCount) && e.xrunCount >= 0 ? e.xrunCount : null
        }
        // CR-024/025/027：只增字段。旧引擎不发 → 保持旧值；发了但形状不对 → null（如实未知）。
        const nextResampler = parseResampler(e.resampler)
        const nextDither = parseDither(e.dither)
        const nextLatency = parseLatencyProfile(e.latencyProfile)
        const nextFade = parseFade(e.fade)
        const nextSpatial = parseSpatial(e.spatial)
        patch.resampler = nextResampler === undefined ? st.resampler
          : sameJson(nextResampler, st.resampler) ? st.resampler : nextResampler
        patch.dither = nextDither === undefined ? st.dither
          : sameJson(nextDither, st.dither) ? st.dither : nextDither
        patch.latencyProfile = nextLatency === undefined ? st.latencyProfile
          : nextLatency === st.latencyProfile ? st.latencyProfile : nextLatency
        patch.fade = nextFade === undefined ? st.fade : sameJson(nextFade, st.fade) ? st.fade : nextFade
        patch.spatial = nextSpatial === undefined ? st.spatial : sameJson(nextSpatial, st.spatial) ? st.spatial : nextSpatial
        // 换曲即清空频谱：上一首的曲线继续挂着，就是谎称它属于这一首。
        // 放在 **state** 分支：曲目身份在这里才是权威的（position 分支在「无 intent 且曲目不同」时
        // 会先 return，放那里等于死代码 —— 我第一版就放错了）。
        if (evTrack !== st.loadedTrackId || e.state !== 'playing') resetMeter()
        // 在线曲目没有曲库条目，但**时长是引擎测出来的**（URL 源的 decoder 报的真实长度）。
        // 以前这里写「空 trackId 就把时长清零」，于是在线播放的进度条永远 0:00 / 0:00 ——
        // 引擎明明报了 durationMs，界面却把它扔了。
        patch.durationMs = (evTrack || online) ? num(e.durationMs, st.durationMs) : 0
        // 本地曲目接管：在线元数据必须同时下线，否则界面会继续显示上一首在线曲。
        if (evTrack && st.onlineTrack) patch.onlineTrack = null
        // 引擎真的停了（不是 open 之后那条中间态）：这次在线播放在此刻结束。
        if (!evTrack && e.state === 'stopped' && st.onlineTrack && !stopDuringLoad) patch.onlineTrack = null
        if (typeof e.volume === 'number' && Number.isFinite(e.volume)) patch.volume = Math.max(0, Math.min(1, e.volume))
        // 循环模式与静音是「只有引擎知道」的权威值，但**旧引擎不发这两个字段**
        // （2026-10-15 20:35 之前的构建没有它们）。缺失时保持当前值：
        // 把缺失当成「顺序循环 / 未静音」会把用户刚设的模式在下一个 state 事件上抹掉。
        if (e.repeatMode === 'sequential' || e.repeatMode === 'one' || e.repeatMode === 'all' || e.repeatMode === 'shuffle') patch.repeatMode = e.repeatMode
        if (typeof e.muted === 'boolean') patch.muted = e.muted
        // 权威状态到达 = intent 结束（无论匹配与否，不再等）
        patch.intent = null
        if (evTrack !== st.loadedTrackId || st.intent || typeof e.positionMs === 'number') {
          setPosition({ trackId: evTrack, positionMs: num(e.positionMs), durationMs: patch.durationMs })
        }
        if (Object.entries(patch).some(([key, value]) => st[key as keyof TwilightState] !== value)) set(patch)
        break
      }
      case 'ended': {
        const st = get()
        if (st.intent && evTrack && evTrack !== st.intent.trackId) return
        // eof = 自然播完。权威 state 随后到达；此处仅把进度顶到曲末作即时反馈。
        if (e.reason === 'eof') {
          set({ playState: 'paused' })
          setPosition({ positionMs: get().durationMs })
        }
        break
      }
      case 'meter':
        // 30 Hz 的高频数据不进全局 store（与 position 同一条纪律）：直接路由到独立仓，
        // 这里**一次 set() 都不发**，否则每秒 30 次推动整棵树重渲染。
        applyMeterFrame(e)
        break
      case 'scan_progress': {
        const now = Date.now()
        if (now - lastScanProgressAt < SCAN_PROGRESS_INTERVAL_MS) break
        lastScanProgressAt = now
        set({ scanProgress: { done: num(e.done), total: num(e.total) } })
        break
      }
      case 'scan_done':
        lastScanProgressAt = 0
        set({ scanDone: true, scanProgress: null })
        break
      case 'log':
        // 引擎日志同样是外部文本（M3 后可能含签名 URL / cookie）：进控制台前先脱敏。
        console.warn('[engine:log]', redactSensitiveText(str(e.message)))
        break
      case 'fatal':
        set({ protocolError: '[engine fatal] ' + str(e.message) })
        break
      default:
        break
    }
  },

  /**
   * 曲库归一边界（应用侧）：收下引擎的全部条目，按当前曲库目录过滤 + 去重后再展示。
   *
   * 引擎的 scan 是「追加」语义、且用整串 path 认身份（见 CR-013 实测）：
   * 同一个目录换个写法再扫一次，91 首会变成 182 条 —— 182 个不同的 trackId、
   * 182 个不同的 path，指向的却是 91 个文件。按 trackId 去重抓不到这种重复。
   * 曲库数量、React key、艺术家分组计数都按这个数组算，所以在这里归一。
   * 引擎修好后这段是恒等变换，不需要撤。
   */
  setTracks: (tracks) => {
    const state = get()
    set({ engineTracks: tracks, tracks: visibleTracks(tracks, state.libraryRoots, state.unplayablePaths).map((t, i) => ({ ...t, uiIndex: i })) })
  },

  /** 目录增删之后调用：不需要重新扫盘，用已有的全部条目重新算一次可见集。 */
  setLibraryDirectories: ({ directories, missing }) => {
    const state = get()
    set({ libraryRoots: directories, libraryMissing: missing, tracks: visibleTracks(state.engineTracks, directories, state.unplayablePaths).map((t, i) => ({ ...t, uiIndex: i })) })
  },

  /**
   * 无法播放的路径集合（CR-017）。恢复记录或新标记之后调用，立刻重算可见集：
   * 改动要马上反映在列表上，而不是等下一次扫描。
   */
  setUnplayablePaths: (paths) => {
    const state = get()
    set({ unplayablePaths: paths, tracks: visibleTracks(state.engineTracks, state.libraryRoots, paths).map((t, i) => ({ ...t, uiIndex: i })) })
  },
  setVolumeLocal: (v) => set({ volume: v }),
  // 三个乐观设置，都只为了「点下去立刻有反馈」；引擎的 state 事件随后是权威值
  // （与 volume 同一模式，见文件头「等待被权威状态纠正」）。
  setMutedLocal: (muted) => set({ muted }),
  setRepeatModeLocal: (mode) => set({ repeatMode: mode }),
  setOutputPreference: (mode) => { persistOutputPreference(mode); set({ outputPreference: mode }) },
  setOutputRateLocal: (rate) => {
    const next = Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 0
    persistOutputRate(next)
    set({ requestedOutputRate: next })
  },
  setProtocolError: (s) => set({ protocolError: s }),
  setLibraryNotice: (s) => set({ libraryNotice: s }),
  setConnectionError: (message) => { resetMeter(); return set(s => ({ ...unavailableOutput, connectionError: message, engineUp: false, dspCapable: null, queueCapable: null,
    dsp: null, dspHistory: [], engineEpoch: s.engineEpoch + 1, dspRequestSequence: 0 })) },

  beginIntent: (trackId) => {
    const st = get()
    resetMeter()
    // 同曲重复触发（单曲循环场景）也重新走 loading：open 会重置进度
    // 本地曲目开始装载 = 在线播放结束，元数据必须一起下线（否则加载态会顶着上一首在线曲的标题）。
    set({ intent: { seq: (st.intent?.seq ?? 0) + 1, trackId }, playState: 'loading', seekPending: false, onlineTrack: null })
    resetPosition(trackId, st.durationMs)
  },
  confirmIntent: (trackId, durationMs) => {
    const st = get()
    if (st.intent?.trackId !== trackId) return
    // Frames already in flight during open still belong to the previous decoder.
    resetMeter()
    set({ intent: null, loadedTrackId: trackId, durationMs: durationMs ?? st.durationMs })
    resetPosition(trackId, durationMs ?? st.durationMs)
  },
  failIntent: (trackId, message) => {
    const st = get()
    if (st.intent?.trackId !== trackId) return
    set({ intent: null, playState: st.loadedTrackId ? 'paused' : 'no-track', protocolError: message })
  },

  /**
   * 在线曲目开播：先把「正在播的是谁」落下来，再去要直链。
   *
   * 顺序很重要：引擎的 state 事件可能先于 IPC 回复到达，而那时如果 onlineTrack
   * 还是空，事件会被判成「空 trackId、没有元数据」，于是 playState 退回 no-track ——
   * 用户看到的就是「有声音，界面什么都没发生」。
   */
  beginOnlinePlayback: (track) => {
    resetMeter()
    set({
      onlineTrack: track,
      intent: null,
      seekPending: false,
      playState: 'loading',
      durationMs: track.durationMs > 0 ? track.durationMs : 0
    })
    resetPosition(null, track.durationMs)
  },

  /**
   * open 的回复到了：用**引擎测出来的**时长覆盖平台给的（试听切片会被如实报成 0:35）。
   * playState 不在这里拍板 —— 它只归引擎的 state 事件。
   */
  confirmOnlinePlayback: (durationMs, quality) => {
    const st = get()
    if (!st.onlineTrack) return
    const nextDuration = durationMs > 0 ? durationMs : st.durationMs
    set({
      durationMs: nextDuration,
      // 请求档位随播放会话一起落到元数据上：界面要能显示「这次要的是哪一档」，
      // 它和引擎随后上报的真实采样率/位深是两件事，必须分开显示。
      onlineTrack: quality ? { ...st.onlineTrack, quality } : st.onlineTrack
    })
    resetPosition(null, nextDuration)
  },

  failOnlinePlayback: (message) => {
    set({ onlineTrack: null, playState: get().loadedTrackId ? 'paused' : 'no-track', protocolError: message })
  },

  /** 在线播放结束（停止、失败、离开）：本地曲目仍在时不动它的播放态。 */
  clearOnlinePlayback: () => set((s) => ({
    onlineTrack: null,
    playState: s.loadedTrackId ? s.playState : 'no-track'
  })),

  beginSeek: () => set({ seekPending: true }),
  pushRequest: () => set((s) => ({ pendingRequests: s.pendingRequests + 1 })),
  popRequest: () => set((s) => ({ pendingRequests: Math.max(0, s.pendingRequests - 1) })),
  setQueueIds: (ids) => {
    const next = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : []
    if (sameJson(next, get().queueIds)) return
    set({ queueIds: next })
  }
}))