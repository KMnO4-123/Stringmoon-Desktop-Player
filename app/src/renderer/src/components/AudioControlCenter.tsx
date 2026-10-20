import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AudioLines, Check, Gauge, RefreshCw, ScanLine, SlidersHorizontal, TriangleAlert, Waves } from 'lucide-react'
import type { DeviceInfo, LatencyProfile, LoudnessScanData, SpatialState } from '@shared/protocol'
import type { AudioCapabilities, AudioFormatCapability, DsdCapability } from '@shared/discover'
import { DEFAULT_DSD_CAPABILITY, STATIC_AUDIO_FORMATS } from '@shared/discover'
import FrequencyPanel from '../audio/FrequencyPanel'
import { applyOutputPreference, engineRequest } from '../ipc'
import { useTwilight, type OutputPreference } from '../store'
import { subscribeEngineEvent } from '../engineEvents'
import {
  audioPreferences, FADE_MAX_MS, FADE_MIN_MS, LATENCY_PROFILES, LIMITER_CEILING_MAX_DB, LIMITER_CEILING_MIN_DB,
  LIMITER_LOOKAHEAD_MAX_MS, LIMITER_LOOKAHEAD_MIN_MS, LIMITER_RELEASE_MAX_MS, LIMITER_RELEASE_MIN_MS,
  SPATIAL_AZIMUTH_MAX, SPATIAL_AZIMUTH_MIN, SPATIAL_ITD_MAX_MS, SPATIAL_ITD_MIN_MS, SPATIAL_MODES,
  setDeviceId, setFadeMs, setLatencyProfile, setLimiter, setPauseHold, setSpatial, setStage
} from '../audio/audioPreferences'
import { channelCommands, useChannelCommandStatus } from '../audio/channelCommandQueue'
import { getMeter, subscribeVisibleMeter, type MeterSnapshot } from '../audio/meterStore'
import { replayGain, setReplayGainEnabled } from '../audio/replayGain'
import '../styles/audio-console.css'

/**
 * 音频控制中心（PLAN §3）。
 *
 * 为什么是四个 tab 而不是继续加卡片：
 *  - 这些控件分属四个**互不相干的事实域**（EQ / 声场与空间 / 输出与解码 / 限幅与响度），
 *    挤在一页里每个都要滚动、且互相干扰阅读；
 *  - 四个域共用一条纪律：请求值与引擎实际值必须分开显示。引擎无状态、可能降级、
 *    可能拒绝（ERR_UNSUPPORTED），把请求值当现状显示就是撒谎。
 *
 * 为什么不把状态搬进全局 store：这些控件只在当前 tab 里活着，30Hz 的 meter 还不能
 * 进全局 store（与 position 同一条纪律，见 meterStore.ts 头注释）。
 */

type TabId = 'eq' | 'stage' | 'output' | 'limiter'

const TABS: ReadonlyArray<{ id: TabId; label: string; hint: string; icon: typeof AudioLines }> = [
  { id: 'eq', label: '均衡', hint: '十段参数均衡、冲激响应与频响曲线', icon: SlidersHorizontal },
  { id: 'stage', label: '声场与空间', hint: '左右平衡、声道交换、整声道增益、虚拟环绕', icon: Waves },
  { id: 'output', label: '输出与解码', hint: '输出模式、采样率、过渡、设备与解码能力矩阵', icon: AudioLines },
  { id: 'limiter', label: '限幅与响度', hint: '限幅器、真峰值、ReplayGain 与响度读数', icon: Gauge }
]

const LATENCY_LABEL: Record<LatencyProfile, string> = { stable: '稳定优先', balanced: '均衡（默认）', lowLatency: '低延迟优先' }
const OUTPUT_MODE_LABEL: Record<OutputPreference, string> = { auto: '自动', exclusive: '独占', shared: '共享' }
/**
 * 输出采样率档位（v6：补到 384k 家族）。
 *
 * 352.8k / 384k 只对**独占**有意义：WASAPI shared 模式永远跑设备混音格式
 * （通常是 48k/32f），选了也不会生效 —— 界面下方「请求 vs 实际」会如实显示，
 * 这不是失败，是 API 的边界，所以不把这两个档位标成「高级/不可用」。
 */
const OUTPUT_RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000] as const
const SPATIAL_LABEL: Record<string, string> = { off: '关闭', crossfeed: '串音消除', wide: '立体声加宽', virtual: '虚拟环绕' }
const REPLAY_GAIN_MODE_KEY = 'stringmoon.replaygain.mode'

const dbText = (value: number | null | undefined, digits = 1): string =>
  typeof value === 'number' && Number.isFinite(value) ? (value > 0 ? '+' : '') + value.toFixed(digits) + ' dB' : '—'
const hzText = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? (value / 1000) + ' kHz' : '—'
const percentText = (value: number): string => Math.round(value * 100) + '%'
/** 平衡是「衰减对侧」的比率：显示左右百分比比显示一个 −1..1 的裸数好读。 */
const balanceText = (value: number): string => value === 0 ? '居中'
  : (value < 0 ? '偏左 ' : '偏右 ') + Math.round(Math.abs(value) * 100) + '%'

function readStoredReplayGainMode(): 'off' | 'track' | 'album' {
  try {
    const value = globalThis.localStorage?.getItem(REPLAY_GAIN_MODE_KEY)
    return value === 'track' || value === 'album' ? value : 'off'
  } catch { return 'off' }
}

/**
 * 解码能力矩阵：**类型与静态矩阵都来自 @shared/discover**，界面这一侧不复制一份。
 *
 * 三件事必须分清，混起来就是撒谎：
 *  1. `engine !== null` = 引擎真的用 CR-032 上报过；否则说明这只是静态说明；
 *  2. `available === false` = 本机**没有**解它的解码器（.opus/.wma/.ac3 取决于本机
 *     有没有对应的 Media Foundation MFT，同一份引擎在不同机器上结论不同）；
 *  3. `kind` 说明由谁提供（原生 / 系统 MF / DSD 抽取 / 不支持），不代表「能用」。
 *
 * 桥由 app-main 提供（window.twilight.audioCapabilities）；旧引擎 / 请求失败时它回
 * `{ formats: STATIC_AUDIO_FORMATS, engine: null }` —— 键名叫 STATIC 就是让人别把
 * 它当实测结果展示，界面上必须写「引擎未上报，以下为静态说明」。
 */
type DecodeKind = AudioFormatCapability['kind']
const kindLabel: Record<DecodeKind, string> = { native: '原生', system: '系统解码', dsd: 'DSD', unsupported: '不支持' }

type CapabilityBridge = () => Promise<AudioCapabilities | null>
/**
 * 桥可能还不存在（旧 preload / 测试替身）：用可选读取而不是直接调
 * window.twilight.audioCapabilities，否则一个尚未接线的构建会在渲染层抛 TypeError，
 * 而不是显示「引擎未上报」。
 */
const capabilityBridge = (): CapabilityBridge | undefined =>
  (window.twilight as unknown as { audioCapabilities?: CapabilityBridge }).audioCapabilities

/** 引擎 get_state 里协议类型没覆盖、但本轮要用的只读字段（防御性读取，形状不对就当未知）。 */
interface RawSpatial { azimuth?: number; delayMs?: number; latencyFrames?: number; degradeReason?: string }
interface RawLimiter { enabled?: boolean; ceilingDb?: number; releaseMs?: number; lookaheadMs?: number }
interface EngineDetails { spatial: RawSpatial | null; limiter: RawLimiter | null }

function readEngineDetails(reply: unknown): EngineDetails {
  const data = reply !== null && typeof reply === 'object' ? reply as Record<string, unknown> : {}
  const spatialRaw = data.spatial !== null && typeof data.spatial === 'object' ? data.spatial as Record<string, unknown> : null
  const dspRaw = data.dsp !== null && typeof data.dsp === 'object' ? data.dsp as Record<string, unknown> : null
  const limiterRaw = dspRaw?.limiter !== null && typeof dspRaw?.limiter === 'object' ? dspRaw.limiter as Record<string, unknown> : null
  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return {
    spatial: spatialRaw
      ? {
          azimuth: numberOrUndefined(spatialRaw.azimuth),
          delayMs: numberOrUndefined(spatialRaw.delayMs),
          latencyFrames: numberOrUndefined(spatialRaw.latencyFrames),
          ...(typeof spatialRaw.degradeReason === 'string' ? { degradeReason: spatialRaw.degradeReason } : {})
        }
      : null,
    // 老引擎没有 dsp.limiter（CR-031 之前），但 dsp.limiterEnabled 一直有：先回退到它。
    limiter: limiterRaw
      ? {
          enabled: typeof limiterRaw.enabled === 'boolean' ? limiterRaw.enabled : undefined,
          ceilingDb: numberOrUndefined(limiterRaw.ceilingDb),
          releaseMs: numberOrUndefined(limiterRaw.releaseMs),
          lookaheadMs: numberOrUndefined(limiterRaw.lookaheadMs)
        }
      : typeof dspRaw?.limiterEnabled === 'boolean' ? { enabled: dspRaw.limiterEnabled } : null
  }
}

/**
 * 请求值 / 实际值成对显示的一行。
 *
 * `compare` 默认 true，但**只有「两者本该相等」的控件才该标不一致**：
 * 「请求跟随源 / 实际 44.1k」是两个不同的事实（不是失败），标红就是假警报。
 */
function Field({ label, request, actual, note, compare = true, children }: {
  label: string
  request: string
  actual: string
  note?: string
  compare?: boolean
  children: React.ReactNode
}) {
  const differs = compare && request !== '—' && actual !== '—' && request !== actual
  return <div className="audio-field" data-mismatch={differs || undefined}>
    <div className="audio-field-head">
      <span className="audio-field-label">{label}</span>
      <span className="audio-field-values">
        <span className="audio-value audio-value-request">请求 {request}</span>
        <span className="audio-value audio-value-actual" data-mismatch={differs || undefined}>
          {differs ? <TriangleAlert size={12} aria-hidden /> : null}实际 {actual}
        </span>
      </span>
    </div>
    {children}
    {note ? <small className="audio-field-note">{note}</small> : null}
  </div>
}

/** 30Hz 的 meter 只让这个小块重渲染，不带着整页一起画。 */
function MeterReadout({ label, unit, pick, format }: {
  label: string
  unit: string
  pick: (meter: MeterSnapshot) => number | null
  format: (value: number) => string
}) {
  const meter = useSyncExternalStore(subscribeVisibleMeter, getMeter)
  const value = pick(meter)
  return <div className="audio-meter" data-state={value === null ? 'idle' : 'live'}>
    <span className="audio-meter-label">{label}</span>
    <span className="audio-meter-value mono">{value === null ? '—' : format(value)}</span>
    <span className="audio-meter-unit">{unit}</span>
  </div>
}

export default function AudioControlCenter() {
  const [tab, setTab] = useState<TabId>('eq')
  const [details, setDetails] = useState<EngineDetails>({ spatial: null, limiter: null })
  const [apply, setApply] = useState<{ state: 'pending' | 'applied' | 'rejected'; label: string } | null>(null)
  const mounted = useRef(true)
  /**
   * 150ms 防抖**按控件分别计时**。
   *
   * 共用一个 timer 是个隐蔽的 bug：拖完方位滑杆 80ms 内又点了限幅器开关，前一次提交会被
   * 直接取消 —— 用户以为改了方位，实际从没发出去。键是控件名，互不干扰。
   */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    return () => {
      mounted.current = false
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const engineUp = useTwilight(s => s.engineUp)
  const engineEpoch = useTwilight(s => s.engineEpoch)
  const dspCapable = useTwilight(s => s.dspCapable)
  const preferences = useSyncExternalStore(audioPreferences.subscribe, audioPreferences.getSnapshot)
  const support = useSyncExternalStore(audioPreferences.subscribe, audioPreferences.getSupport)
  const channelStatus = useChannelCommandStatus()

  // 输出 / 信号路径的权威事实全部来自引擎 state 事件。
  const outputPreference = useTwilight(s => s.outputPreference)
  const requestedOutputRate = useTwilight(s => s.requestedOutputRate)
  const setOutputPreference = useTwilight(s => s.setOutputPreference)
  const setOutputRateLocal = useTwilight(s => s.setOutputRateLocal)
  const sampleRate = useTwilight(s => s.sampleRate)
  const bitDepth = useTwilight(s => s.bitDepth)
  const outputMode = useTwilight(s => s.outputMode)
  const bitPerfect = useTwilight(s => s.bitPerfect)
  const resampled = useTwilight(s => s.resampled)
  const sourceSampleRate = useTwilight(s => s.sourceSampleRate)
  const containerBits = useTwilight(s => s.containerBits)
  const validBits = useTwilight(s => s.validBits)
  const deviceName = useTwilight(s => s.deviceName)
  const periodMs = useTwilight(s => s.periodMs)
  const degradeReason = useTwilight(s => s.degradeReason)
  const actualLatencyProfile = useTwilight(s => s.latencyProfile)
  const actualSpatial = useTwilight(s => s.spatial)
  const actualFade = useTwilight(s => s.fade)
  const actualDither = useTwilight(s => s.dither)
  const actualChannels = useTwilight(s => s.dsp?.channels)
  const actualCrossfeed = useTwilight(s => s.dsp?.crossfeed)
  const actualLimiterEnabled = useTwilight(s => s.dsp?.limiterEnabled)
  const actualReplayGain = useTwilight(s => s.dsp?.replayGain)
  const replayGainState = useSyncExternalStore(replayGain.subscribe, replayGain.getSnapshot)

  /** 提交反馈：先 pending，落地后 applied / rejected。150ms 防抖把一次拖动合并成一条命令。 */
  const commit = useCallback((label: string, task: () => Promise<boolean | void>): void => {
    setApply({ state: 'pending', label })
    const running = timers.current.get(label)
    if (running) clearTimeout(running)
    timers.current.set(label, setTimeout(() => {
      timers.current.delete(label)
      void (async () => {
        try {
          const ok = await task()
          if (!mounted.current) return
          setApply({ state: ok === false ? 'rejected' : 'applied', label })
        } catch (error) {
          if (!mounted.current) return
          setApply({ state: 'rejected', label })
          console.warn('[audio-console] ' + label + ' 下发失败：', error)
        }
      })()
    }, 150))
  }, [])

  /** 回读协议类型没覆盖的只读字段（空间方位/ITD、限幅器实际参数）。 */
  const refreshDetails = useCallback((): void => {
    if (!engineUp) return
    void engineRequest<unknown>({ cmd: 'get_state' }, 12000)
      .then(reply => { if (mounted.current) setDetails(readEngineDetails(reply)) })
      .catch(() => { /* 读不到就显示「未上报」，不编造 */ })
  }, [engineUp])

  useEffect(() => { refreshDetails() }, [refreshDetails, engineEpoch])

  // ── 声场滑杆的本地草稿：引擎回读之前，滑杆要跟手；回读之后以引擎为准。 ──
  const [drafts, setDrafts] = useState(() => ({
    balance: 0, swapChannels: false, gains: [0, 0] as [number, number],
    amount: preferences.spatial.amount, azimuth: preferences.spatial.azimuth, itd: preferences.spatial.delayMs,
    fade: preferences.fadeMs,
    ceiling: preferences.limiter.ceilingDb, release: preferences.limiter.releaseMs, lookahead: preferences.limiter.lookaheadMs
  }))
  useEffect(() => {
    setDrafts(current => ({
      ...current,
      amount: preferences.spatial.amount, azimuth: preferences.spatial.azimuth, itd: preferences.spatial.delayMs,
      fade: preferences.fadeMs,
      ceiling: preferences.limiter.ceilingDb, release: preferences.limiter.releaseMs, lookahead: preferences.limiter.lookaheadMs
    }))
  }, [preferences.spatial.amount, preferences.spatial.azimuth, preferences.spatial.delayMs, preferences.fadeMs, preferences.limiter])
  useEffect(() => {
    if (channelStatus.saving || channelStatus.error) return
    const channels = actualChannels
    if (!channels) return
    setDrafts(current => ({
      ...current,
      balance: channels.balance,
      swapChannels: channels.swapChannels,
      gains: [channels.channelGains[0]?.gainDb ?? 0, channels.channelGains[1]?.gainDb ?? 0] as [number, number]
    }))
  }, [actualChannels, channelStatus.saving, channelStatus.error])

  // ── 输出：设备列表与解码能力矩阵（后者来自主进程桥） ──
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [capabilities, setCapabilities] = useState<{
    formats: AudioFormatCapability[]
    dsd: DsdCapability
    /** true = 引擎真的用 CR-032 上报过；false = 下面只是静态说明。 */
    reported: boolean
    error: string | null
  }>({
    // 初值就用静态矩阵：e2e 在 output tab 一出现就会查它，不能是空的。
    formats: STATIC_AUDIO_FORMATS.map(format => ({ ...format })),
    dsd: { ...DEFAULT_DSD_CAPABILITY, modes: [] },
    reported: false,
    error: '引擎未上报，以下为静态说明'
  })
  /**
   * 设备列表读取。
   *
   * 引用必须稳定：`list_devices` 会真实打开每个端点逐格式探测（秒级），如果这个函数
   * 依赖 deviceBusy 就会形成「读完 → 状态变 → 函数重建 → effect 再读」的自激循环，
   * 把端点每秒打开一次。所以这里从 store 读引擎状态，用 ref 挡重入。
   */
  const deviceReading = useRef(false)
  const loadDevices = useCallback((): void => {
    if (deviceReading.current || !useTwilight.getState().engineUp) return
    deviceReading.current = true
    setDeviceBusy(true)
    setDeviceError(null)
    void engineRequest<{ devices?: DeviceInfo[] }>({ cmd: 'list_devices' }, 30000)
      .then(reply => { if (mounted.current) setDevices(Array.isArray(reply?.devices) ? reply.devices : []) })
      .catch(error => { if (mounted.current) { setDevices([]); setDeviceError(error instanceof Error ? error.message : String(error)) } })
      .finally(() => {
        deviceReading.current = false
        if (mounted.current) setDeviceBusy(false)
      })
  }, [])
  /**
   * **只在切到输出 tab 时**才探测一次端点。
   *
   * list_devices 是真实探测（每个端点每种格式各开一次，秒级），挂载即发等于每次进
   * 「音效」页都给用户加一次几百毫秒到几秒的排队 —— 而大多数人根本不会看设备列表。
   * 用 ref 记「这一轮试过」而不是看 devices.length：探测失败时列表同样是空的，
   * 靠长度判断会变成每次渲染都重试一遍。
   */
  const deviceAttempted = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'output' || !engineUp) return
    const stamp = String(engineEpoch)
    if (deviceAttempted.current === stamp) return
    deviceAttempted.current = stamp
    loadDevices()
  }, [tab, engineUp, engineEpoch, loadDevices])

  /**
   * 选中端点的独占能力摘要（v6 高保真）。
   *
   * 为什么要把这件事写出来：384k/32bit 是否真的可用**完全取决于端点**，而引擎在
   * shared 模式下永远跑设备混音格式。不告诉用户「这个端点最高多少」，用户选了
   * 384k 却看到实际 48k 时只会以为软件坏了 —— 那是界面在替驱动背锅。
   */
  const deviceExclusiveText = useMemo((): string | null => {
    if (devices.length === 0) return null
    const selectedId = preferences.deviceId || devices.find(device => device.isDefault)?.id || ''
    const device = devices.find(item => item.id === selectedId) ?? devices.find(item => item.isDefault) ?? devices[0]
    if (!device) return null
    const formats = Array.isArray(device.exclusiveFormats) ? device.exclusiveFormats : []
    if (device.hasExclusive === false || formats.length === 0) {
      return device.name + '：没有报出独占格式；384k / 32bit 只有在独占模式下才可能生效。'
    }
    let maxRate = 0
    let maxBits = 0
    for (const entry of formats) {
      // 「率:位深」字符串来自引擎；坏形状（只有率、非数字）直接跳过，不要 NaN 传播。
      const parts = entry.split(':')
      const rate = Number(parts[0])
      const bits = Number(parts[1])
      if (Number.isFinite(rate) && rate > maxRate) maxRate = rate
      if (Number.isFinite(bits) && bits > maxBits) maxBits = bits
    }
    const has = (rate: number): boolean => formats.some(entry => entry.startsWith(rate + ':'))
    const family = has(384000) ? ' · 支持 384k 家族' : has(352800) ? ' · 支持 352.8k' : ''
    return device.name + '：独占最高 ' + (maxRate > 0 ? maxRate / 1000 + ' kHz / ' + maxBits + ' bit' : '未上报') + family
  }, [devices, preferences.deviceId])
  useEffect(() => {
    const bridge = capabilityBridge()
    const staticOnly = (error: string, reply?: AudioCapabilities | null): void => {
      // 主进程已经回落的 formats 也是静态矩阵；能用它就不再用本地副本 —— 两处一字不差
      // 才不会被误当成两份不同的结论。
      const formats = reply && Array.isArray(reply.formats) && reply.formats.length > 0
        ? reply.formats : STATIC_AUDIO_FORMATS.map(format => ({ ...format }))
      setCapabilities({
        formats, dsd: reply?.dsd ?? { ...DEFAULT_DSD_CAPABILITY, modes: [] }, reported: false, error
      })
    }
    if (!bridge) { staticOnly('引擎未上报，以下为静态说明'); return }
    let alive = true
    void bridge().then(reply => {
      if (!alive) return
      // engine === null = 旧引擎 / 请求失败，主进程已回落到静态矩阵。
      if (!reply || !reply.engine) { staticOnly('引擎未上报，以下为静态说明', reply); return }
      setCapabilities({ formats: reply.formats, dsd: reply.dsd, reported: true, error: null })
    }).catch(error => {
      if (!alive) return
      staticOnly('引擎未上报，以下为静态说明（' + (error instanceof Error ? error.message : String(error)) + '）')
    })
    return () => { alive = false }
    // 引擎重启后必须重问：上一台引擎的回答（尤其是「引擎未上报」）不能当成这一台的结论。
  }, [engineEpoch])

  // ── 限幅器：老引擎没有 set_limiter。打开这个 tab 时探一次，失败就置灰。 ──
  const [limiterProbing, setLimiterProbing] = useState(false)
  const limiterProbe = useRef<number | null>(null)
  useEffect(() => {
    // 挂载即探一次（不是等用户点到第 4 个 tab）：置灰状态要在控件出现之前就确定，
    // 否则用户会先看到一个「可用」的开关再看着它变灰。
    if (!engineUp || support.limiter || limiterProbe.current === engineEpoch) return
    limiterProbe.current = engineEpoch
    setLimiterProbing(true)
    void setLimiter({})
      .then(ok => { if (ok) refreshDetails() })
      .finally(() => { if (mounted.current) setLimiterProbing(false) })
  }, [engineUp, support.limiter, engineEpoch, refreshDetails])

  // ── ReplayGain：模式（off/track/album）+ 本轮新增的专辑扫描 ──
  const [replayMode, setReplayMode] = useState<'off' | 'track' | 'album'>(readStoredReplayGainMode)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [albumResult, setAlbumResult] = useState<{ integratedLufs: number | null; truePeakDb: number | null; gainDb: number | null } | null>(null)
  useEffect(() => {
    const off = subscribeEngineEvent(event => {
      if (event.ev !== 'loudness_done') return
      const album = event.data?.album
      if (!album || album.ok !== true) return
      setAlbumResult({
        integratedLufs: typeof album.integratedLufs === 'number' ? album.integratedLufs : null,
        truePeakDb: typeof album.truePeakDb === 'number' ? album.truePeakDb : null,
        gainDb: typeof album.gainDb === 'number' ? album.gainDb : null
      })
      // 引擎的专辑结果只在同步扫描里给；异步 done 事件里的 album 是明确拒绝，不覆盖读数。
    })
    return off
  }, [])

  const loadedTrackId = useTwilight(s => s.loadedTrackId)
  const tracks = useTwilight(s => s.tracks)
  const loadedTrack = useMemo(() => tracks.find(track => track.trackId === loadedTrackId) ?? null, [tracks, loadedTrackId])
  const albumTracks = useMemo(() => {
    if (!loadedTrack?.album) return []
    return tracks.filter(track => track.album === loadedTrack.album).slice(0, 24)
  }, [tracks, loadedTrack])

  const changeReplayMode = (next: 'off' | 'track' | 'album'): void => {
    setReplayMode(next)
    try { globalThis.localStorage?.setItem(REPLAY_GAIN_MODE_KEY, next) } catch { /* 本次会话仍然有效 */ }
    commit('ReplayGain 模式', async () => {
      if (next === 'off') {
        setReplayGainEnabled(false)
        await engineRequest({ cmd: 'set_replaygain', mode: 'off' }, 15000)
        return true
      }
      if (next === 'track') {
        // track 模式交给 replayGain.ts 的自动扫描：它只在用户开启后对当前曲目扫一次。
        setReplayGainEnabled(true)
        await engineRequest({ cmd: 'set_replaygain', mode: 'track', preampDb: 0, preventClip: true }, 15000)
        return true
      }
      // album：自动单曲扫描必须让位，否则切歌时 replayGain.ts 会用 track 增益覆盖专辑增益。
      setReplayGainEnabled(false)
      await engineRequest({ cmd: 'set_replaygain', mode: 'album', preampDb: 0, preventClip: true }, 15000)
      return true
    })
  }

  const scanAlbum = (): void => {
    if (scanBusy || albumTracks.length === 0) return
    const ids = albumTracks.map(track => track.trackId).filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) { setScanNote('这张专辑还没有可测量的曲目。'); return }
    setScanBusy(true)
    setScanNote('正在解码测量专辑响度…（同步扫描，完成前不会播放）')
    commit('专辑响度扫描', async () => {
      try {
        // 专辑增益必须同步跑：引擎 app.cpp 明确拒绝异步模式的 album 请求。
        const reply = await engineRequest<LoudnessScanData>({ cmd: 'analyze_loudness', trackIds: ids, album: true }, 180000)
        const album = reply?.album
        if (!album || album.ok !== true || typeof album.gainDb !== 'number') {
          setScanNote('这张专辑测不出可用增益（太短或太安静），没有应用任何改动。')
          return false
        }
        setAlbumResult({
          integratedLufs: typeof album.integratedLufs === 'number' ? album.integratedLufs : null,
          truePeakDb: typeof album.truePeakDb === 'number' ? album.truePeakDb : null,
          gainDb: album.gainDb
        })
        await engineRequest({
          cmd: 'set_replaygain', mode: 'album', albumGainDb: album.gainDb, preampDb: 0, preventClip: true,
          ...(typeof album.peakLinear === 'number' ? { albumPeak: album.peakLinear } : {})
        }, 15000)
        setScanNote('已应用专辑增益 ' + dbText(album.gainDb) + '（' + ids.length + ' 首）。')
        return true
      } finally {
        if (mounted.current) setScanBusy(false)
      }
    })
  }

  const applyOutput = (patch: { mode?: OutputPreference; rate?: number }): void => {
    commit('输出设置', async () => {
      const previousMode = outputPreference
      const previousRate = requestedOutputRate
      if (patch.mode) setOutputPreference(patch.mode)
      if (patch.rate !== undefined) setOutputRateLocal(patch.rate)
      try {
        await applyOutputPreference()
        return true
      } catch (error) {
        setOutputPreference(previousMode)
        setOutputRateLocal(previousRate)
        console.warn('[audio-console] 输出设置下发失败：', error)
        return false
      }
    })
  }

  /**
   * 声场三件套（平衡 / 交换 / 整声道增益）走 audioPreferences 的 setStage。
   *
   * 不直接用 channelCommands：那条队列没有「记下引擎不支持哪个能力」的语义，
   * 旧引擎拒绝时界面只会得到一行错误、控件仍然可点。setStage 会在 ERR_UNSUPPORTED
   * 时把 support.stage 置上，界面据此把这一组真正置灰。
   */
  const stagePatch = (label: string, patch: { balance?: number; swapChannels?: boolean; channelGains?: [number, number] }): void => {
    commit(label, async () => {
      const ok = await setStage(patch)
      refreshDetails()
      return ok
    })
  }

  const applySpatialPatch = (patch: { mode?: SpatialState['mode']; amount?: number; azimuth?: number; delayMs?: number }): void => {
    commit('空间音频', async () => {
      const ok = await setSpatial(patch)
      refreshDetails()
      return ok
    })
  }

  /**
   * 限幅器的四个控件**各自一个防抖标签**。
   *
   * 它们共用一个标签时，150ms 内先动天花板再动释放，前一次会被取消 —— 用户改了
   * 天花板却从没发出去。标签只用于「哪个控件在等」，不影响下发内容（每次都是全量）。
   */
  const applyLimiterPatch = (
    label: string,
    patch: { enabled?: boolean; ceilingDb?: number; releaseMs?: number; lookaheadMs?: number }
  ): void => {
    commit(label, async () => {
      const ok = await setLimiter(patch)
      refreshDetails()
      return ok
    })
  }

  const engineReady = engineUp && (dspCapable !== false)
  const decodeFormats = capabilities.formats
  const unsupportedLimiter = support.limiter

  const status = (() => {
    if (!apply) return null
    if (apply.state === 'pending') return { state: 'pending' as const, text: '正在应用：' + apply.label + '…' }
    if (apply.state === 'applied') return { state: 'applied' as const, text: '已生效：' + apply.label }
    return { state: 'rejected' as const, text: '未生效：' + apply.label + '（引擎拒绝了这次修改，请换一个值或检查输出设备）' }
  })()

  return <div className="audio-console" data-tab={tab}>
    <header className="audio-console-head">
      <div className="audio-console-title">
        <span className="section-eyebrow">AUDIO CONTROL</span>
        <h1>音频控制中心</h1>
        <p>四个分组各管一件事；每个控件都同时显示请求值（我们发出去的）与引擎实际值（它认下的）。</p>
      </div>
      <div className="audio-console-status" aria-live="polite">
        <span className="audio-engine-chip" data-state={engineUp ? 'up' : 'down'}>
          {engineUp ? '引擎在线' : '引擎未连接'}
        </span>
        {status
          ? <span className="audio-apply-state" data-state={status.state}>{status.text}</span>
          : <span className="audio-apply-idle">改动会在停止操作 150 ms 后提交</span>}
      </div>
    </header>

    <div className="audio-tabs" role="tablist" aria-label="音频控制分组" onKeyDown={event => {
      const index = TABS.findIndex(item => item.id === tab)
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index + TABS.length - 1) % TABS.length
      const target = TABS[next]
      if (target) setTab(target.id)
    }}>
      {TABS.map(item => <button key={item.id} type="button" role="tab" data-audio-tab={item.id}
        id={'audio-tab-' + item.id} aria-selected={tab === item.id} aria-controls={'audio-panel-' + item.id}
        tabIndex={tab === item.id ? 0 : -1} className="audio-tab" onClick={() => setTab(item.id)}
        title={item.hint}>
        <item.icon size={16} strokeWidth={1.5} aria-hidden />
        <span>{item.label}</span>
      </button>)}
    </div>

    {/* eq：FrequencyPanel 原样挂载（compact=false）。老 e2e 依赖 .sound-page .frequency-panel。 */}
    <section className="audio-panel" data-audio-panel="eq" role="tabpanel" id="audio-panel-eq"
      aria-labelledby="audio-tab-eq" hidden={tab !== 'eq'}>
      <FrequencyPanel />
    </section>

    <section className="audio-panel" data-audio-panel="stage" role="tabpanel" id="audio-panel-stage"
      aria-labelledby="audio-tab-stage" hidden={tab !== 'stage'}>
      <div className="audio-grid">
        <section className="audio-card" aria-label="声道工具">
          <header className="audio-card-head"><h2>声道工具</h2><span>平衡与增益不改变总能量，交换只动左右</span></header>
          <Field label="左右平衡" request={balanceText(drafts.balance)} actual={typeof actualChannels?.balance === 'number' ? balanceText(actualChannels.balance) : '未上报'}
            note={support.stage ? '引擎不支持这组字段，控件已置灰。' : undefined}>
            <div className={support.stage ? 'audio-unsupported' : undefined}>
              <input type="range" min={-1} max={1} step={0.05} value={drafts.balance} aria-label="左右平衡"
                aria-valuetext={balanceText(drafts.balance)} disabled={!engineReady || support.stage}
                onChange={event => { const balance = Number(event.target.value); setDrafts(d => ({ ...d, balance })); stagePatch('左右平衡', { balance }) }} />
            </div>
          </Field>
          <Field label="左右交换" request={drafts.swapChannels ? '交换' : '正常'} actual={actualChannels ? (actualChannels.swapChannels ? '交换' : '正常') : '未上报'}>
            <label className={support.stage ? 'audio-switch audio-unsupported' : 'audio-switch'}>
              <input type="checkbox" aria-label="左右声道交换" checked={drafts.swapChannels} disabled={!engineReady || support.stage}
                onChange={event => { const swapChannels = event.target.checked; setDrafts(d => ({ ...d, swapChannels })); stagePatch('左右交换', { swapChannels }) }} />
              <span>{support.stage ? '引擎不支持' : drafts.swapChannels ? '交换左右' : '保持原样'}</span>
            </label>
          </Field>
          <Field label="整声道增益（L / R）"
            request={dbText(drafts.gains[0]) + ' / ' + dbText(drafts.gains[1])}
            actual={actualChannels ? dbText(actualChannels.channelGains[0]?.gainDb ?? null) + ' / ' + dbText(actualChannels.channelGains[1]?.gainDb ?? null) : '未上报'}
            note="这是整条声道的电平（−12..+12 dB），与「三频段增益」不是一回事。">
            <div className={support.stage ? 'audio-pair audio-unsupported' : 'audio-pair'}>
              {([0, 1] as const).map(channel => <label className="audio-slider" key={channel}>
                <span>{channel === 0 ? 'L' : 'R'}</span>
                <input type="range" min={-12} max={12} step={0.5} value={drafts.gains[channel]}
                  aria-label={(channel === 0 ? '左' : '右') + '声道增益'} aria-valuetext={dbText(drafts.gains[channel])}
                  disabled={!engineReady || support.stage}
                  onChange={event => {
                    const value = Number(event.target.value)
                    const gains: [number, number] = channel === 0 ? [value, drafts.gains[1]] : [drafts.gains[0], value]
                    setDrafts(d => ({ ...d, gains }))
                    stagePatch('整声道增益', { channelGains: gains })
                  }} />
                <output>{dbText(drafts.gains[channel])}</output>
              </label>)}
            </div>
          </Field>
          {channelStatus.error ? <p className="audio-error" role="alert">{channelStatus.error}</p> : null}
        </section>

        <section className="audio-card" aria-label="空间音频">
          <header className="audio-card-head"><h2>空间音频</h2><span>关闭时逐样本恒等；任何模式都只输出双耳 2ch</span></header>
          <div className="audio-segmented" role="group" aria-label="空间音频模式">
            {SPATIAL_MODES.map(mode => <button key={mode} type="button" aria-pressed={preferences.spatial.mode === mode}
              disabled={!engineReady || support.spatial}
              onClick={() => applySpatialPatch({ mode })}>{SPATIAL_LABEL[mode] ?? mode}</button>)}
          </div>
          <p className="audio-field-note">关闭时整段旁路、逐样本恒等，bit-perfect 不变；播放中切换会有一次重开。</p>
          {support.spatial ? <p className="audio-unsupported"><TriangleAlert size={14} aria-hidden />引擎不支持（旧引擎缺少 set_spatial）</p> : null}
          <Field label="效果强度" request={percentText(preferences.spatial.amount)}
            actual={actualSpatial ? percentText(actualSpatial.amount) : '未上报'}
            note={actualSpatial ? (actualSpatial.active ? '引擎报告：正在处理。' : '引擎报告：未处理（参数无效或当前是单声道源）。') : undefined}>
            <input type="range" min={0} max={1} step={0.05} value={drafts.amount} aria-label="空间音频强度"
              aria-valuetext={percentText(drafts.amount)} disabled={!engineReady || support.spatial || preferences.spatial.mode === 'off'}
              onChange={event => {
                const amount = Number(event.target.value)
                setDrafts(d => ({ ...d, amount }))
                // 滑杆拖动只改草稿，150ms 后提交一条（committed 由 commit 的防抖兜住）。
                commit('空间音频强度', async () => { const ok = await setSpatial({ amount }); refreshDetails(); return ok })
              }} />
          </Field>
          <Field label="虚拟声源方位" request={Math.round(preferences.spatial.azimuth) + '°'}
            actual={typeof details.spatial?.azimuth === 'number' ? Math.round(details.spatial.azimuth) + '°' : '未上报'}
            note="仅「虚拟环绕」有意义：0° 正前方，负值偏左、正值偏右（±90° 夹紧）。">
            <input type="range" min={SPATIAL_AZIMUTH_MIN} max={SPATIAL_AZIMUTH_MAX} step={1} value={drafts.azimuth}
              aria-label="虚拟声源方位" aria-valuetext={Math.round(drafts.azimuth) + ' 度'}
              disabled={!engineReady || support.spatial || preferences.spatial.mode !== 'virtual'}
              onChange={event => {
                const azimuth = Number(event.target.value)
                setDrafts(d => ({ ...d, azimuth }))
                commit('虚拟声源方位', async () => { const ok = await setSpatial({ azimuth }); refreshDetails(); return ok })
              }} />
          </Field>
          <Field label="对侧耳 ITD" request={preferences.spatial.delayMs.toFixed(2) + ' ms'}
            actual={typeof details.spatial?.delayMs === 'number' ? details.spatial.delayMs.toFixed(2) + ' ms' : '未上报'}
            note={support.spatialField ? '引擎不支持这个字段：只下发模式与强度。' : '0–1 ms 的对侧延迟，只在串音消除 / 虚拟环绕里生效。'}>
            <input type="range" min={SPATIAL_ITD_MIN_MS} max={SPATIAL_ITD_MAX_MS} step={0.05} value={drafts.itd}
              aria-label="对侧耳延迟" aria-valuetext={drafts.itd.toFixed(2) + ' 毫秒'}
              disabled={!engineReady || support.spatial || support.spatialField || preferences.spatial.mode === 'off'}
              onChange={event => {
                const delayMs = Number(event.target.value)
                setDrafts(d => ({ ...d, delayMs }))
                commit('对侧耳延迟', async () => { const ok = await setSpatial({ delayMs }); refreshDetails(); return ok })
              }} />
          </Field>
          {typeof actualSpatial?.active === 'boolean' && !actualSpatial.active && preferences.spatial.mode !== 'off'
            ? <p className="audio-note">引擎报告「未处理」：参数可能无效，或当前是单声道源。</p> : null}
        </section>

        <section className="audio-card" aria-label="中侧与交叉馈送">
          <header className="audio-card-head"><h2>中侧与交叉馈送</h2><span>和均衡页的「声场」是同一组引擎参数，改哪边都算数</span></header>
          <Field label="中声道增益" request={channelStatus.pending?.midGainDb !== undefined ? dbText(channelStatus.pending.midGainDb) : dbText(actualChannels?.midGainDb ?? 0)}
            actual={dbText(actualChannels?.midGainDb ?? null)}>
            <input type="range" min={-12} max={12} step={0.5} value={actualChannels?.midGainDb ?? 0} aria-label="中声道增益"
              disabled={!engineReady || support.channelTools}
              onChange={event => channelCommands.enqueue({ midGainDb: Number(event.target.value) })} />
          </Field>
          <Field label="侧声道增益" request={channelStatus.pending?.sideGainDb !== undefined ? dbText(channelStatus.pending.sideGainDb) : dbText(actualChannels?.sideGainDb ?? 0)}
            actual={dbText(actualChannels?.sideGainDb ?? null)}>
            <input type="range" min={-12} max={12} step={0.5} value={actualChannels?.sideGainDb ?? 0} aria-label="侧声道增益"
              disabled={!engineReady || support.channelTools}
              onChange={event => channelCommands.enqueue({ sideGainDb: Number(event.target.value) })} />
          </Field>
          <Field label="立体声宽度" request={(channelStatus.pending?.stereoWidth ?? actualChannels?.stereoWidth ?? 1).toFixed(2)}
            actual={actualChannels ? actualChannels.stereoWidth.toFixed(2) : '未上报'}>
            <input type="range" min={0} max={2} step={0.05} value={actualChannels?.stereoWidth ?? 1} aria-label="立体声宽度"
              disabled={!engineReady || support.channelTools}
              onChange={event => channelCommands.enqueue({ stereoWidth: Number(event.target.value) })} />
          </Field>
          <Field label="耳机交叉馈送" request={(channelStatus.pending?.crossfeedEnabled ?? actualCrossfeed?.enabled) ? '开启' : '关闭'}
            actual={actualCrossfeed ? (actualCrossfeed.enabled ? '开启' : '关闭') : '未上报'}>
            <label className="audio-switch">
              <input type="checkbox" aria-label="耳机交叉馈送" checked={actualCrossfeed?.enabled ?? false} disabled={!engineReady || support.channelTools}
                onChange={event => channelCommands.enqueue({ crossfeedEnabled: event.target.checked })} />
              <span>{actualCrossfeed?.enabled ? '已开启' : '已关闭'}</span>
            </label>
          </Field>
        </section>
      </div>
    </section>

    <section className="audio-panel" data-audio-panel="output" role="tabpanel" id="audio-panel-output"
      aria-labelledby="audio-tab-output" hidden={tab !== 'output'}>
      <div className="audio-grid">
        <section className="audio-card" aria-label="输出">
          <header className="audio-card-head"><h2>输出</h2><span>模式与采样率走同一条 set_output，每次改动都会重开一次流</span></header>
          <Field label="输出模式" request={OUTPUT_MODE_LABEL[outputPreference]}
            actual={outputMode === 'exclusive' ? '独占' : outputMode === 'shared' ? '共享' : '未连接'}>
            <div className="audio-segmented" role="group" aria-label="输出模式">
              {(['auto', 'exclusive', 'shared'] as OutputPreference[]).map(mode =>
                <button key={mode} type="button" aria-pressed={outputPreference === mode} disabled={!engineUp}
                  onClick={() => applyOutput({ mode })}>{OUTPUT_MODE_LABEL[mode]}</button>)}
            </div>
            {degradeReason ? <p className="audio-note">引擎降级原因：{degradeReason}</p> : null}
          </Field>
          <Field label="输出采样率" request={requestedOutputRate > 0 ? (requestedOutputRate / 1000) + ' kHz' : '跟随源'}
            actual={hzText(sampleRate)} compare={false}
            note="「跟随源」与一个具体 kHz 是不同的两件事，不算不一致。非「跟随源」时重采样器进入链路，bit-perfect 会如实变为否。">
            <div className="audio-segmented" role="group" aria-label="输出采样率">
              {OUTPUT_RATES.map(rate => <button key={rate} type="button" aria-pressed={requestedOutputRate === rate}
                disabled={!engineUp} onClick={() => applyOutput({ rate })}>{rate === 0 ? '跟随源' : (rate / 1000) + 'k'}</button>)}
            </div>
          </Field>
          <Field label="延迟档位" request={LATENCY_LABEL[preferences.latency]}
            actual={LATENCY_LABEL[actualLatencyProfile ?? 'balanced'] + (periodMs ? ' · ' + periodMs.toFixed(1) + ' ms' : '')}
            compare={false}
            note={support.latency ? '引擎不支持该字段，只下发输出模式与采样率。' : undefined}>
            <div className="audio-segmented" role="group" aria-label="延迟档位">
              {LATENCY_PROFILES.map(profile => <button key={profile} type="button" aria-pressed={preferences.latency === profile}
                disabled={!engineUp || support.latency}
                onClick={() => commit('延迟档位', () => setLatencyProfile(profile))}>{LATENCY_LABEL[profile]}</button>)}
            </div>
          </Field>
          <Field label="输出设备" request={preferences.deviceId ? (devices.find(device => device.id === preferences.deviceId)?.name ?? '已选端点') : '系统默认'}
            actual={deviceName ?? '未上报'} compare={false}
            note={deviceError ? '设备列表读取失败：' + deviceError : (deviceExclusiveText ?? '指定端点打不开时引擎会回退到默认设备，实际值以上面为准。')}>
            <div className="audio-inline">
              <select aria-label="输出设备" value={preferences.deviceId} disabled={!engineUp || support.device}
                onChange={event => {
                  const deviceId = event.target.value
                  commit('输出设备', async () => { const ok = await setDeviceId(deviceId); refreshDetails(); return ok })
                }}>
                <option value="">跟随系统默认</option>
                {devices.map(device => <option key={device.id} value={device.id}>{device.name}{device.isDefault ? ' · 默认' : ''}</option>)}
                {preferences.deviceId && !devices.some(device => device.id === preferences.deviceId)
                  ? <option value={preferences.deviceId}>上次选的端点（当前列表没有）</option> : null}
              </select>
              <button type="button" className="audio-action" disabled={deviceBusy} onClick={loadDevices}>
                <RefreshCw size={14} className={deviceBusy ? 'spin' : undefined} aria-hidden />{deviceBusy ? '读取中' : '刷新设备'}
              </button>
            </div>
            {support.device ? <p className="audio-unsupported"><TriangleAlert size={14} aria-hidden />引擎不支持（旧引擎不认 deviceId）</p> : null}
          </Field>
          <Field label="过渡时长" request={preferences.fadeMs + ' ms'} actual={actualFade ? actualFade.ms + ' ms' : '未上报'}
            note={support.fade ? '引擎不支持 fadeMs / pauseHold，这一组只影响输出模式与采样率。' : '暂停 / 切歌 / seek 的等功率淡入淡出。'}>
            <div className={support.fade ? 'audio-unsupported' : undefined}>
              <input type="range" min={FADE_MIN_MS} max={FADE_MAX_MS} step={1} value={drafts.fade} aria-label="过渡时长(ms)"
                aria-valuetext={drafts.fade + ' 毫秒'} disabled={!engineUp || support.fade}
                onChange={event => {
                  const ms = Number(event.target.value)
                  setDrafts(d => ({ ...d, fade: ms }))
                  commit('过渡时长', async () => { const ok = await setFadeMs(ms); refreshDetails(); return ok })
                }} />
            </div>
          </Field>
          <Field label="暂停保持输出流" request={preferences.pauseHold ? '保持' : '关闭'}
            actual={actualFade ? (actualFade.pauseHold ? '保持' : '关闭') : '未上报'}
            note="保持开启可避免 USB DAC / 蓝牙端点 Stop/Start 的电源与时钟切换底噪。">
            <label className={support.fade ? 'audio-switch audio-unsupported' : 'audio-switch'}>
              <input type="checkbox" aria-label="暂停保持输出流" checked={preferences.pauseHold} disabled={!engineUp || support.fade}
                onChange={event => commit('暂停保持输出流', async () => { const ok = await setPauseHold(event.target.checked); refreshDetails(); return ok })} />
              <span>{support.fade ? '引擎不支持，控件已置灰' : preferences.pauseHold ? '保持' : '暂停即停流'}</span>
            </label>
          </Field>
        </section>

        <section className="audio-card" aria-label="信号路径">
          <header className="audio-card-head"><h2>信号路径</h2><span>全部来自引擎 state 事件，不是界面自己推出来的</span></header>
          <div className="audio-chips" aria-label="当前信号路径">
            <span className="chip">实际流 <b>{hzText(sampleRate)} · {bitDepth ?? '—'} bit · {outputMode === 'exclusive' ? '独占' : outputMode === 'shared' ? '共享' : '未连接'}</b></span>
            <span className="chip" data-unsupported={bitPerfect === false || undefined}>bit-perfect <b>{bitPerfect === null ? '未上报' : bitPerfect ? '是' : '否'}</b></span>
            <span className="chip" data-unsupported={resampled === true || undefined}>重采样 <b>{resampled === null ? '未上报' : resampled ? '是' : '否'}</b></span>
            <span className="chip">源采样率 <b>{hzText(sourceSampleRate ?? null)}</b></span>
            <span className="chip">容器/有效位深 <b>{containerBits ?? '—'} / {validBits ?? '—'} bit</b></span>
            <span className="chip">dither <b>{actualDither ? actualDither.mode + (actualDither.active ? ' · 生效' : ' · 未生效') : '未上报'}</b></span>
            <span className="chip">设备 <b>{deviceName ?? '—'}</b></span>
          </div>
        </section>

        <section className="audio-card" aria-label="解码能力">
          <header className="audio-card-head">
            <h2>解码能力矩阵</h2>
            <span>{capabilities.reported ? '引擎逐项上报（本机真的能解开才算 available）' : '引擎未上报，以下为静态说明'}</span>
          </header>
          {capabilities.error ? <p className="audio-note" role="status" data-static={!capabilities.reported || undefined}>{capabilities.error}</p> : null}
          <div className="decode-matrix">
            {decodeFormats.map(item => {
              const ext = String(item.ext ?? '').replace(/^\./, '').toLowerCase()
              const kind: DecodeKind = item.kind === 'native' || item.kind === 'system' || item.kind === 'dsd' || item.kind === 'unsupported'
                ? item.kind : 'unsupported'
              // available 缺失 = 未知（静态说明）；只有引擎明确说 false 才置灰并标「本机不可用」。
              const available = typeof item.available === 'boolean' ? item.available : undefined
              return <div className="decode-item" key={ext + ':' + kind} data-kind={kind}
                data-lossless={item.lossless === true ? 'true' : item.lossless === false ? 'false' : undefined}
                data-available={available === undefined ? 'unknown' : String(available)}
                data-source={capabilities.reported ? 'engine' : 'static'}>
                <b className="decode-ext mono">{ext}</b>
                <span className="decode-label">{item.label ?? ext.toUpperCase()}</span>
                <span className="decode-kind">{kindLabel[kind]}</span>
                <span className="decode-lossless">{item.lossless === true ? '无损' : item.lossless === false ? '有损' : '未知'}</span>
                <span className="decode-availability">
                  {available === false ? '本机不可用' : available === true ? '可用' : '未实测'}
                </span>
              </div>
            })}
          </div>
          <p className="audio-note">
            DSD：{capabilities.dsd?.supported ? '支持' + (capabilities.dsd.modes?.length ? '（' + capabilities.dsd.modes.join(' / ') + '）' : '') + ' · 输出 ' + (capabilities.dsd.output ?? 'pcm') : '未上报或本构建不支持'}
          </p>
        </section>
      </div>
    </section>

    <section className="audio-panel" data-audio-panel="limiter" role="tabpanel" id="audio-panel-limiter"
      aria-labelledby="audio-tab-limiter" hidden={tab !== 'limiter'}>
      <div className="audio-grid">
        <section className={'audio-card' + (unsupportedLimiter ? ' audio-unsupported' : '')} aria-label="限幅器">
          <header className="audio-card-head">
            <h2>限幅器</h2>
            <span>{unsupportedLimiter ? '引擎不支持（旧引擎缺少 set_limiter）' : '0 前瞻时与旧算法逐样本一致'}</span>
          </header>
          {unsupportedLimiter
            ? <p className="audio-unsupported"><TriangleAlert size={14} aria-hidden />引擎不支持（旧引擎缺少 set_limiter），控件已置灰。</p>
            : <p className="audio-field-note">{limiterProbing
              ? '正在向引擎确认限幅器是否可控…'
              : '引擎支持 set_limiter；参数改动会在停手 150 ms 后提交一次（0 前瞻时与旧算法逐样本一致）。'}</p>}
          <Field label="开关" request={preferences.limiter.enabled ? '开启' : '关闭'}
            actual={typeof details.limiter?.enabled === 'boolean' ? (details.limiter.enabled ? '开启' : '关闭')
              : typeof actualLimiterEnabled === 'boolean' ? (actualLimiterEnabled ? '开启' : '关闭') : '未上报'}>
            <label className={unsupportedLimiter ? 'audio-switch audio-unsupported' : 'audio-switch'}>
              <input type="checkbox" aria-label="限幅器" checked={preferences.limiter.enabled} disabled={!engineUp || unsupportedLimiter}
                onChange={event => applyLimiterPatch('限幅器开关', { enabled: event.target.checked })} />
              <span>{unsupportedLimiter ? '引擎不支持，控件已置灰' : preferences.limiter.enabled ? '开启' : '关闭（仍有硬削波保护）'}</span>
            </label>
          </Field>
          <Field label="天花板" request={dbText(preferences.limiter.ceilingDb, 1) + 'TP'}
            actual={typeof details.limiter?.ceilingDb === 'number' ? dbText(details.limiter.ceilingDb, 1) + 'TP' : '未上报'}
            note="−12..0 dBTP。引擎现状的真实上限是 −0.1 dBFS；0 会让限幅器等同硬削。">
            <div className={unsupportedLimiter ? 'audio-unsupported' : undefined}>
              <input type="range" min={LIMITER_CEILING_MIN_DB} max={LIMITER_CEILING_MAX_DB} step={0.1} value={drafts.ceiling}
                aria-label="限幅器天花板(dBTP)" aria-valuetext={dbText(drafts.ceiling, 1)}
                disabled={!engineUp || unsupportedLimiter}
                onChange={event => { const ceilingDb = Number(event.target.value); setDrafts(d => ({ ...d, ceiling: ceilingDb })); applyLimiterPatch('限幅器天花板', { ceilingDb }) }} />
            </div>
          </Field>
          <Field label="释放时间" request={preferences.limiter.releaseMs + ' ms'}
            actual={typeof details.limiter?.releaseMs === 'number' ? details.limiter.releaseMs + ' ms' : '未上报'}
            note="5..1000 ms；越短越「抓住」瞬态，越长越平滑但可能压住整体。">
            <div className={unsupportedLimiter ? 'audio-unsupported' : undefined}>
              <input type="range" min={LIMITER_RELEASE_MIN_MS} max={LIMITER_RELEASE_MAX_MS} step={5} value={drafts.release}
                aria-label="限幅器释放(ms)" aria-valuetext={drafts.release + ' 毫秒'}
                disabled={!engineUp || unsupportedLimiter}
                onChange={event => { const releaseMs = Number(event.target.value); setDrafts(d => ({ ...d, release: releaseMs })); applyLimiterPatch('限幅器释放', { releaseMs }) }} />
            </div>
          </Field>
          <Field label="前瞻" request={preferences.limiter.lookaheadMs + ' ms'}
            actual={typeof details.limiter?.lookaheadMs === 'number' ? details.limiter.lookaheadMs + ' ms' : '未上报'}
            note="0..20 ms；0 = 与旧算法逐样本一致（默认）。">
            <div className={unsupportedLimiter ? 'audio-unsupported' : undefined}>
              <input type="range" min={LIMITER_LOOKAHEAD_MIN_MS} max={LIMITER_LOOKAHEAD_MAX_MS} step={1} value={drafts.lookahead}
                aria-label="限幅器前瞻(ms)" aria-valuetext={drafts.lookahead + ' 毫秒'}
                disabled={!engineUp || unsupportedLimiter}
                onChange={event => { const lookaheadMs = Number(event.target.value); setDrafts(d => ({ ...d, lookahead: lookaheadMs })); applyLimiterPatch('限幅器前瞻', { lookaheadMs }) }} />
            </div>
          </Field>
        </section>

        <section className="audio-card" aria-label="实时电平">
          <header className="audio-card-head"><h2>实时电平</h2><span>30 Hz 的 meter 数据只驱动这一块，不进全局 store</span></header>
          <div className="audio-meters">
            <MeterReadout label="真峰值" unit="dBTP" pick={meter => maxOf(meter.truePeakDb)} format={value => value.toFixed(1)} />
            <MeterReadout label="样本峰值" unit="dBFS" pick={meter => maxOf(meter.peakDb)} format={value => value.toFixed(1)} />
            <MeterReadout label="RMS" unit="dBFS" pick={meter => maxOf(meter.rmsDb)} format={value => value.toFixed(1)} />
            <MeterReadout label="Momentary" unit="LUFS" pick={meter => meter.lufsMomentary} format={value => value.toFixed(1)} />
            <MeterReadout label="限幅衰减" unit="dB" pick={meter => meter.gainReductionDb} format={value => value.toFixed(1)} />
          </div>
          <p className="audio-note">
            Short-term / 整段 LRA 需要离线扫描，引擎的 meter 事件里没有这两个读数，所以这里不显示（不拿 Momentary 冒充）。
          </p>
        </section>

        <section className="audio-card" aria-label="响度与 ReplayGain">
          <header className="audio-card-head"><h2>响度与 ReplayGain</h2><span>测量与应用分离：扫描只读，确认后才下发增益</span></header>
          <div className="audio-segmented" role="group" aria-label="ReplayGain 模式">
            {(['off', 'track', 'album'] as const).map(mode => <button key={mode} type="button" aria-pressed={replayMode === mode}
              disabled={!engineUp} onClick={() => changeReplayMode(mode)}>
              {mode === 'off' ? '关闭' : mode === 'track' ? '单曲' : '专辑'}
            </button>)}
          </div>
          <Field label="引擎实际模式" request={replayMode === 'off' ? '关闭' : replayMode === 'track' ? '单曲' : '专辑'}
            actual={actualReplayGain ? (actualReplayGain.mode === 'off' ? '关闭' : actualReplayGain.mode === 'track' ? '单曲' : '专辑') : '未上报'}
            note={replayMode === 'album' ? '专辑模式：自动单曲扫描已让位，增益由上方的专辑扫描写入。' : undefined}>
            <div className="audio-inline">
              <button type="button" className="audio-action" disabled={!engineUp || scanBusy || albumTracks.length === 0} onClick={scanAlbum}>
                <ScanLine size={14} aria-hidden />{scanBusy ? '扫描中…' : '扫描本专辑响度'}
              </button>
              <small className="audio-field-note">
                {albumTracks.length > 0
                  ? '将解码 ' + albumTracks.length + ' 首（当前曲目所在专辑），完成后应用专辑增益。'
                  : '当前没有装载可分组到专辑的本地曲目。'}
              </small>
            </div>
          </Field>
          <div className="audio-chips" aria-label="响度读数">
            <span className="chip">Integrated <b>{albumResult?.integratedLufs !== null && albumResult?.integratedLufs !== undefined ? albumResult.integratedLufs.toFixed(1) + ' LUFS' : '未扫描'}</b></span>
            <span className="chip">专辑增益 <b>{albumResult?.gainDb !== null && albumResult?.gainDb !== undefined ? dbText(albumResult.gainDb) : '未扫描'}</b></span>
            <span className="chip">真峰值 <b>{albumResult?.truePeakDb !== null && albumResult?.truePeakDb !== undefined ? dbText(albumResult.truePeakDb) : '未扫描'}</b></span>
            <span className="chip">当前曲目增益 <b>{replayGainState.lastGainDb !== null ? dbText(replayGainState.lastGainDb) : '未应用'}</b></span>
            <span className="chip">已测量曲目 <b>{replayGainState.analysed} 首</b></span>
          </div>
          {replayGainState.scanning
            ? <p className="audio-note" role="status">后台扫描进度 {replayGainState.scanning.done} / {replayGainState.scanning.total}</p>
            : null}
          {scanNote ? <p className="audio-note" role="status">{scanNote}</p> : null}
        </section>
      </div>
    </section>

    <p className="audio-console-foot">
      <Check size={13} aria-hidden />
      所有值都来自引擎回读：请求了不等于被采纳，两者不一致时会标出来；引擎不支持的能力会置灰而不是假装成功。
    </p>
  </div>
}

function maxOf(values: readonly number[]): number | null {
  let best: number | null = null
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (best === null || value > best) best = value
  }
  return best
}
