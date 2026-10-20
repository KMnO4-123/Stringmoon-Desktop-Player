import type {
  ChannelBandGains, DitherMode, EngineRequestCommand, LatencyProfile, MonoMode, ResamplerPhase, ResamplerQuality, SpatialMode
} from '@shared/protocol'
import { applyOutputPreference, engineRequest } from '../ipc'
import { useTwilight } from '../store'

/**
 * 用户可调的「专业音频设置」（本轮 CR-024..027）——渲染层唯一所有者。
 *
 * 为什么集中在一个模块：
 *  - 这些值是**应用侧设置**，引擎无状态，每次握手后必须重发（和输出偏好同一条纪律）；
 *  - localStorage 只是持久化，不是第二份真相：读进来先 sanitize，非法值回默认；
 *  - 旧引擎会回 ERR_UNSUPPORTED：必须**如实标记 + 回滚 UI**，不能假装成功。
 *
 * 默认值必须与引擎现状等价（不改变默认听感）：VHQ / linear / 非 steep、tpdf、
 * balanced、monoMode=off、三段增益全 0、每声道延迟 [0,0]。
 */
export interface ResamplerSettings {
  quality: ResamplerQuality
  phase: ResamplerPhase
  steep: boolean
}
/**
 * CR-029：空间音频（默认 off = 逐样本恒等，不破坏 bit-perfect）。
 *
 * azimuth / delayMs 是引擎**早就实现、应用一直没下发**的两个字段（OWN-AUDIT A1/A2）：
 * protocol.ts 有、setSpatial 以前只发 mode+amount，于是「虚拟环绕只能朝正前方」。
 * 默认值与引擎的 DspParams 初值逐字相同（azimuth 0 / delayMs 0.5），
 * 所以不碰这两项的用户与改动前逐样本一致。
 */
export interface SpatialSettings {
  mode: SpatialMode
  /** 0..1 效果强度；off 时无效但保留用户上次的值。 */
  amount: number
  /** −90..90 度：虚拟声源方位（仅 virtual 有意义）；0 = 正前方。 */
  azimuth: number
  /** 0..1 ms：对侧耳 ITD（crossfeed/virtual）。引擎默认 0.5ms。 */
  delayMs: number
}
export interface AudioPreferences {
  resampler: ResamplerSettings
  dither: DitherMode
  latency: LatencyProfile
  monoMode: MonoMode
  bandGains: ChannelBandGains
  delayMs: [number, number]
  spatial: SpatialSettings
  /** CR-028：暂停/切歌/seek 的过渡时长（5–50ms，默认 10）。 */
  fadeMs: number
  /**
   * CR-028：暂停时保持输出流打开（渲染静音）。
   *
   * 默认 true —— 它一直是这样写死的（旧代码在 set_output 里恒发 `pauseHold: true`），
   * 本轮只是把它变成用户可见的开关；false 才回退到「暂停即停流」的旧行为。
   */
  pauseHold: boolean
  /**
   * `set_output.deviceId`（协议内字段）：空串 = 跟随系统默认端点。
   *
   * 设备 id 是**本次系统会话内的不透明字符串**，重启后可能失效；读盘时只接受字符串、
   * 不做格式假设；指定端点打不开时引擎自己回退默认并在 state 里如实报 deviceName。
   */
  deviceId: string
  /**
   * CR-031 限幅器（引擎 set_limiter 落地前一律 ERR_UNSUPPORTED）。
   *
   * 默认值与引擎 DspParams 逐字相同（enabled=true / release 60ms / ceiling −0.1dBTP /
   * lookahead 0），所以从不打开第 4 个 tab 的用户听到的就是现状。
   */
  limiter: LimiterSettings
  /** CR-026 声场工具：balance / swapChannels / 整声道增益。 */
  stage: StageSettings
}
export interface LimiterSettings {
  enabled: boolean
  /** −12..0 dBTP；引擎现状的真实上限是 −0.1 dBFS（0 会让限幅器等于硬削）。 */
  ceilingDb: number
  /** 5..1000 ms。 */
  releaseMs: number
  /** 0..20 ms；0 = 与旧算法逐样本一致。 */
  lookaheadMs: number
}
/** 引擎明确不支持的能力（旧引擎回 ERR_UNSUPPORTED）；UI 显示「引擎不支持」并禁用。 */
export interface AudioSupport {
  resampler: boolean
  dither: boolean
  latency: boolean
  channelTools: boolean
  spatial: boolean
  fade: boolean
  /** CR-031：旧引擎没有 set_limiter。 */
  limiter: boolean
  /** 输出设备指定：list_devices 都没有的引擎谈不上选端点。 */
  device: boolean
  /** 空间方位/ITD：缺这两个字段的引擎会拒绝带它们的 set_spatial。 */
  spatialField: boolean
  /** CR-026 声场工具（balance/swapChannels/channelGains）：旧引擎的 set_channels 不带这些字段。 */
  stage: boolean
}
/**
 * 声场工具（OWN-AUDIT A5/A6/A7；协议字段早已存在、UI 一直没入口）。
 *
 * 默认全部为恒等值（引擎 DspParams 的初值），所以不下发也逐样本一致。
 */
export interface StageSettings {
  /** −1（全左）..+1（全右）；0 = 居中。引擎是「衰减对侧」而不是提升本侧，不会削顶。 */
  balance: number
  swapChannels: boolean
  /** [L, R] 整声道增益（dB，−12..+12）—— 与三频段增益是两回事。 */
  channelGains: [number, number]
}

export const RESAMPLER_QUALITIES: readonly ResamplerQuality[] = ['HQ', 'VHQ', '24BIT']
export const RESAMPLER_PHASES: readonly ResamplerPhase[] = ['linear', 'minimum', 'intermediate', 'maximum']
export const DITHER_MODES: readonly DitherMode[] = ['off', 'tpdf', 'highpass-tpdf', 'ns-5', 'ns-9', 'ultra-shaped']
export const LATENCY_PROFILES: readonly LatencyProfile[] = ['stable', 'balanced', 'lowLatency']
export const MONO_MODES: readonly MonoMode[] = ['off', 'sum', 'left', 'right']
export const SPATIAL_MODES: readonly SpatialMode[] = ['off', 'crossfeed', 'wide', 'virtual']
export const FADE_MIN_MS = 5
export const FADE_MAX_MS = 50
export const FADE_DEFAULT_MS = 10
/** 空间方位/ITD 的合法域（与 engine app.cpp 的 readFloat 边界逐字一致）。 */
export const SPATIAL_AZIMUTH_MIN = -90
export const SPATIAL_AZIMUTH_MAX = 90
export const SPATIAL_ITD_MIN_MS = 0
export const SPATIAL_ITD_MAX_MS = 1
/** CR-031 限幅器的合法域（PLAN §2.4）。 */
export const LIMITER_CEILING_MIN_DB = -12
export const LIMITER_CEILING_MAX_DB = 0
export const LIMITER_RELEASE_MIN_MS = 5
export const LIMITER_RELEASE_MAX_MS = 1000
export const LIMITER_LOOKAHEAD_MIN_MS = 0
export const LIMITER_LOOKAHEAD_MAX_MS = 20

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  resampler: { quality: 'VHQ', phase: 'linear', steep: false },
  dither: 'tpdf',
  latency: 'balanced',
  monoMode: 'off',
  bandGains: { low: [0, 0], mid: [0, 0], high: [0, 0] },
  delayMs: [0, 0],
  // azimuth/delayMs 的默认值来自引擎 DspParams（0 / 0.5ms），不是拍脑袋的 0。
  spatial: { mode: 'off', amount: 0.5, azimuth: 0, delayMs: 0.5 },
  fadeMs: FADE_DEFAULT_MS,
  pauseHold: true,
  deviceId: '',
  // enabled/release/ceiling 与 engine/src/dsp.hpp 的 limiterEnabled=true /
  // limiterReleaseMs=60 / dsp.cpp 的 ceiling=0.9885531(−0.1dBTP) 对应。
  limiter: { enabled: true, ceilingDb: -0.1, releaseMs: 60, lookaheadMs: 0 },
  stage: { balance: 0, swapChannels: false, channelGains: [0, 0] }
}
const NO_SUPPORT: AudioSupport = {
  resampler: false, dither: false, latency: false, channelTools: false, spatial: false, fade: false,
  limiter: false, device: false, spatialField: false, stage: false
}

/** 存储键：一组一个键，读到坏 JSON 只影响那一组，不会把整个音频面板打回默认。 */
const STORAGE_KEYS = {
  resampler: 'stringmoon.audio.resampler',
  dither: 'stringmoon.audio.dither',
  latency: 'stringmoon.audio.latency',
  channelTools: 'stringmoon.audio.channel-tools',
  spatial: 'stringmoon.audio.spatial',
  fade: 'stringmoon.audio.fade',
  /**
   * 暂停保持流 / 输出设备 / 限幅器合用一个键：三者都是「引擎需要时才重下发」的
   * 低频设置，一个键读到坏 JSON 只会把这一组打回默认，不会牵连其它组。
   */
  output: 'stringmoon.audio.output-extras',
  limiter: 'stringmoon.audio.limiter',
  stage: 'stringmoon.audio.stage'
} as const

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
const pair = (value: unknown, low: number, high: number, fallback: [number, number]): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) return fallback
  const left = value[0], right = value[1]
  if (typeof left !== 'number' || !Number.isFinite(left) || typeof right !== 'number' || !Number.isFinite(right)) return fallback
  return [clamp(left, low, high), clamp(right, low, high)]
}

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw === null || raw === undefined ? null : JSON.parse(raw)
  } catch { return null }
}
function writeJson(key: string, value: unknown): void {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)) } catch { /* 本次会话仍然有效 */ }
}
const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback

/** 从 localStorage 归一出一份合法设置；任何一组坏了只回退那一组。 */
export function readStoredAudioPreferences(): AudioPreferences {
  const resamplerRaw = readJson(STORAGE_KEYS.resampler)
  const resamplerRecord = resamplerRaw !== null && typeof resamplerRaw === 'object' ? resamplerRaw as Record<string, unknown> : null
  const resampler: ResamplerSettings = {
    quality: pickEnum(resamplerRecord?.quality, RESAMPLER_QUALITIES, DEFAULT_AUDIO_PREFERENCES.resampler.quality),
    phase: pickEnum(resamplerRecord?.phase, RESAMPLER_PHASES, DEFAULT_AUDIO_PREFERENCES.resampler.phase),
    steep: resamplerRecord?.steep === true
  }
  const channelRaw = readJson(STORAGE_KEYS.channelTools)
  const channelRecord = channelRaw !== null && typeof channelRaw === 'object' ? channelRaw as Record<string, unknown> : null
  const bandsRaw = channelRecord?.bandGains !== null && typeof channelRecord?.bandGains === 'object'
    ? channelRecord?.bandGains as Record<string, unknown> : null
  const spatialRaw = readJson(STORAGE_KEYS.spatial)
  const spatialRecord = spatialRaw !== null && typeof spatialRaw === 'object' ? spatialRaw as Record<string, unknown> : null
  const fadeRaw = readJson(STORAGE_KEYS.fade)
  const outputRaw = readJson(STORAGE_KEYS.output)
  const outputRecord = outputRaw !== null && typeof outputRaw === 'object' ? outputRaw as Record<string, unknown> : null
  const limiterRaw = readJson(STORAGE_KEYS.limiter)
  const limiterRecord = limiterRaw !== null && typeof limiterRaw === 'object' ? limiterRaw as Record<string, unknown> : null
  const stageRaw = readJson(STORAGE_KEYS.stage)
  const stageRecord = stageRaw !== null && typeof stageRaw === 'object' ? stageRaw as Record<string, unknown> : null
  return {
    resampler,
    dither: pickEnum(readJson(STORAGE_KEYS.dither), DITHER_MODES, DEFAULT_AUDIO_PREFERENCES.dither),
    latency: pickEnum(readJson(STORAGE_KEYS.latency), LATENCY_PROFILES, DEFAULT_AUDIO_PREFERENCES.latency),
    monoMode: pickEnum(channelRecord?.monoMode, MONO_MODES, DEFAULT_AUDIO_PREFERENCES.monoMode),
    bandGains: {
      low: pair(bandsRaw?.low, -6, 3, DEFAULT_AUDIO_PREFERENCES.bandGains.low),
      mid: pair(bandsRaw?.mid, -6, 3, DEFAULT_AUDIO_PREFERENCES.bandGains.mid),
      high: pair(bandsRaw?.high, -6, 3, DEFAULT_AUDIO_PREFERENCES.bandGains.high)
    },
    delayMs: pair(channelRecord?.delayMs, 0, 10, DEFAULT_AUDIO_PREFERENCES.delayMs),
    spatial: {
      mode: pickEnum(spatialRecord?.mode, SPATIAL_MODES, DEFAULT_AUDIO_PREFERENCES.spatial.mode),
      amount: typeof spatialRecord?.amount === 'number' && Number.isFinite(spatialRecord.amount)
        ? clamp(spatialRecord.amount, 0, 1) : DEFAULT_AUDIO_PREFERENCES.spatial.amount,
      // 旧版本存下的 spatial 里没有这两个字段 → 回引擎默认，而不是回 0（0 会让
      // crossfeed 的对侧延迟消失，听感与「没动过」不同）。
      azimuth: typeof spatialRecord?.azimuth === 'number' && Number.isFinite(spatialRecord.azimuth)
        ? clamp(spatialRecord.azimuth, SPATIAL_AZIMUTH_MIN, SPATIAL_AZIMUTH_MAX) : DEFAULT_AUDIO_PREFERENCES.spatial.azimuth,
      delayMs: typeof spatialRecord?.delayMs === 'number' && Number.isFinite(spatialRecord.delayMs)
        ? clamp(spatialRecord.delayMs, SPATIAL_ITD_MIN_MS, SPATIAL_ITD_MAX_MS) : DEFAULT_AUDIO_PREFERENCES.spatial.delayMs
    },
    fadeMs: typeof fadeRaw === 'number' && Number.isFinite(fadeRaw)
      ? clamp(Math.round(fadeRaw), FADE_MIN_MS, FADE_MAX_MS) : DEFAULT_AUDIO_PREFERENCES.fadeMs,
    // 旧版本没有这个开关，而当时行为恒为 true —— 读不到时必须回 true，不能回 false。
    pauseHold: typeof outputRecord?.pauseHold === 'boolean' ? outputRecord.pauseHold : DEFAULT_AUDIO_PREFERENCES.pauseHold,
    deviceId: typeof outputRecord?.deviceId === 'string' ? outputRecord.deviceId : DEFAULT_AUDIO_PREFERENCES.deviceId,
    limiter: {
      enabled: typeof limiterRecord?.enabled === 'boolean' ? limiterRecord.enabled : DEFAULT_AUDIO_PREFERENCES.limiter.enabled,
      ceilingDb: typeof limiterRecord?.ceilingDb === 'number' && Number.isFinite(limiterRecord.ceilingDb)
        ? clamp(limiterRecord.ceilingDb, LIMITER_CEILING_MIN_DB, LIMITER_CEILING_MAX_DB) : DEFAULT_AUDIO_PREFERENCES.limiter.ceilingDb,
      releaseMs: typeof limiterRecord?.releaseMs === 'number' && Number.isFinite(limiterRecord.releaseMs)
        ? clamp(Math.round(limiterRecord.releaseMs), LIMITER_RELEASE_MIN_MS, LIMITER_RELEASE_MAX_MS) : DEFAULT_AUDIO_PREFERENCES.limiter.releaseMs,
      lookaheadMs: typeof limiterRecord?.lookaheadMs === 'number' && Number.isFinite(limiterRecord.lookaheadMs)
        ? clamp(Math.round(limiterRecord.lookaheadMs), LIMITER_LOOKAHEAD_MIN_MS, LIMITER_LOOKAHEAD_MAX_MS) : DEFAULT_AUDIO_PREFERENCES.limiter.lookaheadMs
    },
    stage: {
      balance: typeof stageRecord?.balance === 'number' && Number.isFinite(stageRecord.balance)
        ? clamp(stageRecord.balance, -1, 1) : DEFAULT_AUDIO_PREFERENCES.stage.balance,
      swapChannels: typeof stageRecord?.swapChannels === 'boolean' ? stageRecord.swapChannels : DEFAULT_AUDIO_PREFERENCES.stage.swapChannels,
      channelGains: pair(stageRecord?.channelGains, -12, 12, DEFAULT_AUDIO_PREFERENCES.stage.channelGains)
    }
  }
}

let preferences: AudioPreferences = readStoredAudioPreferences()
let support: AudioSupport = { ...NO_SUPPORT }
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of [...listeners]) listener() }
const persist = (): void => {
  writeJson(STORAGE_KEYS.resampler, preferences.resampler)
  writeJson(STORAGE_KEYS.dither, preferences.dither)
  writeJson(STORAGE_KEYS.latency, preferences.latency)
  writeJson(STORAGE_KEYS.channelTools, {
    monoMode: preferences.monoMode, bandGains: preferences.bandGains, delayMs: preferences.delayMs
  })
  writeJson(STORAGE_KEYS.spatial, preferences.spatial)
  writeJson(STORAGE_KEYS.fade, preferences.fadeMs)
  writeJson(STORAGE_KEYS.output, { pauseHold: preferences.pauseHold, deviceId: preferences.deviceId })
  writeJson(STORAGE_KEYS.limiter, preferences.limiter)
  writeJson(STORAGE_KEYS.stage, preferences.stage)
}

export const audioPreferences = {
  getSnapshot: (): AudioPreferences => preferences,
  getSupport: (): AudioSupport => support,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
}

export const isDefaultSpatial = (value: SpatialSettings): boolean =>
  value.mode === 'off' && value.azimuth === DEFAULT_AUDIO_PREFERENCES.spatial.azimuth
  && value.delayMs === DEFAULT_AUDIO_PREFERENCES.spatial.delayMs
export const isDefaultFade = (ms: number): boolean => ms === FADE_DEFAULT_MS
export const isDefaultPauseHold = (value: boolean): boolean => value === DEFAULT_AUDIO_PREFERENCES.pauseHold
export const isDefaultDevice = (value: string): boolean => value === DEFAULT_AUDIO_PREFERENCES.deviceId
export const isDefaultLimiter = (value: LimiterSettings): boolean =>
  value.enabled === DEFAULT_AUDIO_PREFERENCES.limiter.enabled
  && value.ceilingDb === DEFAULT_AUDIO_PREFERENCES.limiter.ceilingDb
  && value.releaseMs === DEFAULT_AUDIO_PREFERENCES.limiter.releaseMs
  && value.lookaheadMs === DEFAULT_AUDIO_PREFERENCES.limiter.lookaheadMs
export const isDefaultStage = (value: StageSettings): boolean =>
  value.balance === DEFAULT_AUDIO_PREFERENCES.stage.balance
  && value.swapChannels === DEFAULT_AUDIO_PREFERENCES.stage.swapChannels
  && value.channelGains[0] === DEFAULT_AUDIO_PREFERENCES.stage.channelGains[0]
  && value.channelGains[1] === DEFAULT_AUDIO_PREFERENCES.stage.channelGains[1]
export const isDefaultResampler = (value: ResamplerSettings): boolean =>
  value.quality === 'VHQ' && value.phase === 'linear' && !value.steep
export const isDefaultChannelTools = (value: AudioPreferences): boolean =>
  value.monoMode === 'off' && value.delayMs[0] === 0 && value.delayMs[1] === 0
  && value.bandGains.low[0] === 0 && value.bandGains.low[1] === 0
  && value.bandGains.mid[0] === 0 && value.bandGains.mid[1] === 0
  && value.bandGains.high[0] === 0 && value.bandGains.high[1] === 0

const isUnsupported = (error: unknown): boolean =>
  error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ERR_UNSUPPORTED'

function markUnsupported(key: keyof AudioSupport): void {
  if (support[key]) return
  support = { ...support, [key]: true }
  publish()
}

/** 发一条命令；ERR_UNSUPPORTED 记为「引擎不支持」（返回 false 由调用方回滚），其他错误只记日志。 */
async function send(command: Parameters<typeof engineRequest>[0], flag: keyof AudioSupport): Promise<boolean> {
  try {
    await engineRequest(command)
    return true
  } catch (error) {
    if (isUnsupported(error)) {
      markUnsupported(flag)
      return false
    }
    console.warn('[audio-preferences] 下发失败：', error)
    return false
  }
}

function commit(next: Partial<AudioPreferences>): AudioPreferences {
  const previous = preferences
  preferences = { ...preferences, ...next }
  persist()
  publish()
  return previous
}

/** 重采样器设置：乐观更新，引擎不支持则回滚（用户看到的值必须等于实际生效的值）。 */
export async function setResampler(patch: Partial<ResamplerSettings>): Promise<boolean> {
  const previous = commit({ resampler: { ...preferences.resampler, ...patch } })
  const ok = await send({ cmd: 'set_resampler', ...preferences.resampler }, 'resampler')
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

export async function setDither(mode: DitherMode): Promise<boolean> {
  const previous = commit({ dither: mode })
  const ok = await send({ cmd: 'set_dither', mode }, 'dither')
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * 延迟档位：和输出模式/采样率走**同一条** set_output（一次重开），否则两次命令会让
 * 输出重开两次。失败时回滚并存下用户的请求值（下次握手再试）。
 */
export async function setLatencyProfile(profile: LatencyProfile): Promise<boolean> {
  const previous = commit({ latency: profile })
  const ok = await applyLatencyToEngine(profile)
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

async function applyLatencyToEngine(profile: LatencyProfile): Promise<boolean> {
  try {
    await applyOutputPreference({ latencyProfile: profile })
    return true
  } catch (error) {
    if (!isUnsupported(error)) {
      console.warn('[audio-preferences] 延迟档位下发失败：', error)
      return false
    }
    markUnsupported('latency')
    // 旧引擎不认识 latencyProfile：退回不带该字段的 set_output，至少别让输出偏好失效。
    try { await applyOutputPreference() } catch { /* 启动路径会再试 */ }
    return false
  }
}

/** 声道工具（monoMode / 三频段增益 / 每声道延迟）：0 值即旁路，不破坏 bit-perfect。 */
export async function setChannelTools(patch: Partial<Pick<AudioPreferences, 'monoMode' | 'bandGains' | 'delayMs'>>): Promise<boolean> {
  const previous = commit({
    ...(patch.monoMode !== undefined ? { monoMode: patch.monoMode } : {}),
    ...(patch.bandGains !== undefined ? { bandGains: patch.bandGains } : {}),
    ...(patch.delayMs !== undefined ? { delayMs: patch.delayMs } : {})
  })
  const ok = await send({
    cmd: 'set_channels',
    monoMode: preferences.monoMode,
    bandGains: preferences.bandGains,
    delayMs: preferences.delayMs
  }, 'channelTools')
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * CR-026 声场工具（balance / swapChannels / 整声道增益）。
 *
 * 走 set_channels 的**部分字段**：只发这三个，不同时回显 monoMode / bandGains /
 * delayMs ——那样会把用户在同一面板里没动过的值再发一遍，反而给"谁覆盖谁"开了口子。
 */
export async function setStage(patch: Partial<StageSettings>): Promise<boolean> {
  const previous = commit({ stage: { ...preferences.stage, ...patch } })
  const ok = await send({
    cmd: 'set_channels',
    balance: preferences.stage.balance,
    swapChannels: preferences.stage.swapChannels,
    channelGains: preferences.stage.channelGains
  }, 'stage')
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * 发 set_spatial 的完整当前值。
 *
 * 为什么先发带 azimuth/delayMs 的版本、被拒再退回 mode+amount：这两个字段是
 * 「引擎已有、旧构建可能没有」的只增字段；一次 ERR_UNSUPPORTED 不该让整个空间音频
 * 面板变灰 —— 用户至少还能用 crossfeed/wide。弃用字段的结论记在 spatialField 上。
 */
async function applySpatialToEngine(): Promise<boolean> {
  const { mode, amount, azimuth, delayMs } = preferences.spatial
  if (support.spatialField) {
    // 已知这台引擎不认这两个字段：只发它能懂的，别每次多一次失败往返。
    return send({ cmd: 'set_spatial', mode, amount }, 'spatial')
  }
  try {
    await engineRequest({ cmd: 'set_spatial', mode, amount, azimuth, delayMs })
    return true
  } catch (error) {
    if (!isUnsupported(error)) {
      console.warn('[audio-preferences] 空间音频下发失败：', error)
      return false
    }
    markUnsupported('spatialField')
    try {
      await engineRequest({ cmd: 'set_spatial', mode, amount })
      return true
    } catch (fallbackError) {
      if (isUnsupported(fallbackError)) markUnsupported('spatial')
      else console.warn('[audio-preferences] 空间音频下发失败：', fallbackError)
      return false
    }
  }
}

/** CR-029 空间音频：off 时引擎逐样本恒等；不支持则标记并回滚（界面不能假装生效）。 */
export async function setSpatial(patch: Partial<SpatialSettings>): Promise<boolean> {
  const previous = commit({ spatial: { ...preferences.spatial, ...patch } })
  const ok = await applySpatialToEngine()
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * 输出扩展字段（CR-028 fadeMs/pauseHold + set_output.deviceId）走**同一条** set_output。
 *
 * 为什么不是三条命令：set_output 每次都会重开输出流（引擎 app.cpp 的 reopenOutput），
 * 拆开发就是三次静音/重开。为什么带级联降级：这三个都是只增字段，旧引擎会整条拒绝，
 * 一次拒绝不该让「输出模式/采样率」一起失效 —— 逐层去掉不认识的字段重试，
 * 并把结论记到 support 上让界面如实置灰。
 */
async function pushOutputCommand(includeFade: boolean, includeDevice: boolean): Promise<void> {
  const state = useTwilight.getState()
  await engineRequest({
    cmd: 'set_output', mode: state.outputPreference, sampleRate: state.requestedOutputRate,
    latencyProfile: preferences.latency,
    ...(includeFade ? { fadeMs: preferences.fadeMs, pauseHold: preferences.pauseHold } : {}),
    ...(includeDevice && preferences.deviceId ? { deviceId: preferences.deviceId } : {})
  }, 15000)
}

async function applyOutputExtrasToEngine(): Promise<boolean> {
  let includeFade = !support.fade
  let includeDevice = !support.device && preferences.deviceId !== ''
  // 「哪个字段被拒」只能靠**删掉它之后成功**来证明：先失败、删 fade 后仍失败、再删
  // device 才成功 —— 那说明是 device 的问题，fade 未必不支持。所以只在成功的那一次
  // 记下最后一次删掉的那组，而不是每次失败都往 support 上记（那会把好字段也标成不支持，
  // 界面上就是一句谎）。
  let dropped: 'fade' | 'device' | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pushOutputCommand(includeFade, includeDevice)
      if (dropped === 'fade') markUnsupported('fade')
      else if (dropped === 'device') markUnsupported('device')
      return true
    } catch (error) {
      if (!isUnsupported(error)) {
        console.warn('[audio-preferences] 输出扩展下发失败：', error)
        return false
      }
      // 顺序：先砍 CR-028 的两个字段，再砍 deviceId（越新越先出局，旧引擎至少保住输出偏好）。
      if (includeFade) { includeFade = false; dropped = 'fade'; continue }
      if (includeDevice) { includeDevice = false; dropped = 'device'; continue }
      try { await applyOutputPreference({ latencyProfile: preferences.latency }) } catch { /* 启动路径会再试 */ }
      return false
    }
  }
  return false
}

/** CR-028 过渡时长：与输出偏好在同一条 set_output 里（避免二次重开），失败回滚。 */
export async function setFadeMs(ms: number): Promise<boolean> {
  const next = clamp(Math.round(ms), FADE_MIN_MS, FADE_MAX_MS)
  const previous = commit({ fadeMs: next })
  const ok = await applyOutputExtrasToEngine()
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/** CR-028：暂停时保持输出流打开。默认 true 与改动前的硬编码一致。 */
export async function setPauseHold(value: boolean): Promise<boolean> {
  const previous = commit({ pauseHold: value })
  const ok = await applyOutputExtrasToEngine()
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * 指定输出端点：空串 = 跟随系统默认。
 *
 * 注意它是**偏好**：端点被拔掉时引擎会自己回退到默认设备并在 state 里如实报 deviceName，
 * 所以界面必须把「请求的设备」与「实际打开的 deviceName」分开显示，不能拿这个值冒充现状。
 */
export async function setDeviceId(id: string): Promise<boolean> {
  const previous = commit({ deviceId: typeof id === 'string' ? id : '' })
  const ok = await applyOutputExtrasToEngine()
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * CR-031 的 `set_limiter` **还没进 @shared/protocol 的命令联合类型**（PLAN §2.4 已把字段名
 * 与范围定死，协议文件由引擎侧追加 CR-031）。这里只做一处收窄的断言，字段名与
 * PLAN 逐字一致；protocol.ts 落地后删掉这个类型和下面两处 asLimiterCommand 即可。
 */
interface SetLimiterCommand extends Record<string, unknown> {
  cmd: 'set_limiter'
  enabled: boolean
  ceilingDb: number
  releaseMs: number
  lookaheadMs: number
}
const asLimiterCommand = (command: SetLimiterCommand): EngineRequestCommand =>
  command as unknown as EngineRequestCommand

/**
 * CR-031 限幅器。
 *
 * ERR_UNSUPPORTED 由 `send` 记到 support.limiter 上并回滚 —— 界面据此把控件包进
 * .audio-unsupported 并置灰（Lead 的 e2e 会查这个状态）。true-peak 读数不在这里：
 * 那是 meter 事件的事实，属于 meterStore。
 */
export async function setLimiter(patch: Partial<LimiterSettings>): Promise<boolean> {
  const previous = commit({ limiter: { ...preferences.limiter, ...patch } })
  const ok = await send(asLimiterCommand({
    cmd: 'set_limiter',
    enabled: preferences.limiter.enabled,
    ceilingDb: preferences.limiter.ceilingDb,
    releaseMs: preferences.limiter.releaseMs,
    lookaheadMs: preferences.limiter.lookaheadMs
  }), 'limiter')
  if (!ok) { preferences = previous; persist(); publish() }
  return ok
}

/**
 * 每次握手（启动 + 引擎重启）后重发一遍。
 *
 * 只在新值与引擎默认不同的时候才发：默认值就是引擎启动态，多发一条命令只会多一次
 * 状态/重开（延迟档位会触发输出重开），没有收益。
 */
export async function applyAudioPreferences(): Promise<void> {
  const target = preferences
  // 输出这一组（模式/采样率/延迟/过渡/暂停保持/设备）是**一条**命令：它每次都重开流。
  const wantsOutputExtras = !isDefaultFade(target.fadeMs) || !isDefaultPauseHold(target.pauseHold) || !isDefaultDevice(target.deviceId)
  if (wantsOutputExtras) {
    await applyOutputExtrasToEngine()
  } else {
    try { await applyOutputPreference({ latencyProfile: target.latency }) } catch (error) {
      if (isUnsupported(error)) {
        markUnsupported('latency')
        try { await applyOutputPreference() } catch { /* bootstrap 会兜底 */ }
      }
    }
  }
  if (!isDefaultResampler(target.resampler)) await send({ cmd: 'set_resampler', ...target.resampler }, 'resampler')
  if (target.dither !== 'tpdf') await send({ cmd: 'set_dither', mode: target.dither }, 'dither')
  if (!isDefaultChannelTools(target) && !support.channelTools) {
    await send({ cmd: 'set_channels', monoMode: target.monoMode, bandGains: target.bandGains, delayMs: target.delayMs }, 'channelTools')
  }
  if (!isDefaultStage(target.stage) && !support.stage) {
    await send({
      cmd: 'set_channels',
      balance: target.stage.balance, swapChannels: target.stage.swapChannels, channelGains: target.stage.channelGains
    }, 'stage')
  }
  if (!isDefaultSpatial(target.spatial) && !support.spatial) await applySpatialToEngine()
  if (!isDefaultLimiter(target.limiter)) {
    await send(asLimiterCommand({
      cmd: 'set_limiter',
      enabled: target.limiter.enabled, ceilingDb: target.limiter.ceilingDb,
      releaseMs: target.limiter.releaseMs, lookaheadMs: target.limiter.lookaheadMs
    }), 'limiter')
  }
}

/**
 * 「恢复默认」：把应用侧偏好写回默认值并**显式下发**（引擎当前可能不是默认）。
 *
 * 四条命令的顺序与握手时一致；任一能力不被旧引擎支持时只标记不支持，不阻塞其余项。
 * 返回值 = 是否全部下发成功（不支持不算失败：该能力本来就无法恢复）。
 */
export async function restoreAudioDefaults(): Promise<boolean> {
  preferences = {
    resampler: { ...DEFAULT_AUDIO_PREFERENCES.resampler },
    dither: DEFAULT_AUDIO_PREFERENCES.dither,
    latency: DEFAULT_AUDIO_PREFERENCES.latency,
    monoMode: DEFAULT_AUDIO_PREFERENCES.monoMode,
    bandGains: { ...DEFAULT_AUDIO_PREFERENCES.bandGains },
    delayMs: [...DEFAULT_AUDIO_PREFERENCES.delayMs] as [number, number],
    spatial: { ...DEFAULT_AUDIO_PREFERENCES.spatial },
    fadeMs: DEFAULT_AUDIO_PREFERENCES.fadeMs,
    pauseHold: DEFAULT_AUDIO_PREFERENCES.pauseHold,
    deviceId: DEFAULT_AUDIO_PREFERENCES.deviceId,
    limiter: { ...DEFAULT_AUDIO_PREFERENCES.limiter },
    stage: { ...DEFAULT_AUDIO_PREFERENCES.stage, channelGains: [...DEFAULT_AUDIO_PREFERENCES.stage.channelGains] as [number, number] }
  }
  persist()
  publish()
  let hardFailure = false
  // 输出这一组用「默认值也显式下发」：设备要回到跟随默认端点，暂停保持要回到 true。
  if (!(await applyOutputExtrasToEngine())) {
    if (!support.fade && !support.device) hardFailure = true
  }
  if (!(await send({ cmd: 'set_resampler', quality: 'VHQ', phase: 'linear', steep: false }, 'resampler'))) {
    if (!support.resampler) hardFailure = true
  }
  if (!(await send({ cmd: 'set_dither', mode: 'tpdf' }, 'dither'))) {
    if (!support.dither) hardFailure = true
  }
  if (!(await send({ cmd: 'set_channels', monoMode: 'off', bandGains: { low: [0, 0], mid: [0, 0], high: [0, 0] }, delayMs: [0, 0] }, 'channelTools'))) {
    if (!support.channelTools) hardFailure = true
  }
  if (!(await applySpatialToEngine())) {
    if (!support.spatial) hardFailure = true
  }
  if (!(await send({ cmd: 'set_channels', balance: 0, swapChannels: false, channelGains: [0, 0] }, 'stage'))) {
    if (!support.stage) hardFailure = true
  }
  if (!(await send(asLimiterCommand({
    cmd: 'set_limiter', enabled: DEFAULT_AUDIO_PREFERENCES.limiter.enabled,
    ceilingDb: DEFAULT_AUDIO_PREFERENCES.limiter.ceilingDb,
    releaseMs: DEFAULT_AUDIO_PREFERENCES.limiter.releaseMs,
    lookaheadMs: DEFAULT_AUDIO_PREFERENCES.limiter.lookaheadMs
  }), 'limiter'))) {
    if (!support.limiter) hardFailure = true
  }
  return !hardFailure
}

/** 引擎重启/重连后调用：新引擎可能支持上一台不具备的能力，旧的「不支持」结论必须作废。 */
export function resetAudioSupport(): void {
  support = { ...NO_SUPPORT }
  publish()
}

/** 测试用：重置到默认值（不写盘）。 */
export function resetAudioPreferencesForTest(): void {
  preferences = {
    ...DEFAULT_AUDIO_PREFERENCES,
    resampler: { ...DEFAULT_AUDIO_PREFERENCES.resampler },
    bandGains: { ...DEFAULT_AUDIO_PREFERENCES.bandGains },
    delayMs: [...DEFAULT_AUDIO_PREFERENCES.delayMs] as [number, number],
    spatial: { ...DEFAULT_AUDIO_PREFERENCES.spatial },
    limiter: { ...DEFAULT_AUDIO_PREFERENCES.limiter },
    stage: { ...DEFAULT_AUDIO_PREFERENCES.stage, channelGains: [...DEFAULT_AUDIO_PREFERENCES.stage.channelGains] as [number, number] }
  }
  support = { ...NO_SUPPORT }
}