import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AudioLines, Check, Cloud, Copy, Download, FolderCog, Gauge, Info, KeyRound, Palette, Radio, RefreshCw, RotateCcw, SlidersHorizontal, TriangleAlert, UserRound } from 'lucide-react'
import type { AppInfo, UpdatePhase, UpdateState } from '@shared/update'
import StreamingSources from '../streaming/StreamingSources'
import type { UnplayableEntry } from '@shared/unplayable'
import type { DeviceInfo, DitherMode, LatencyProfile, MonoMode, ResamplerPhase, ResamplerQuality, SpatialMode } from '@shared/protocol'
import { engineRequest } from '../ipc'
import { useTwilight, type OutputPreference } from '../store'
import {
  audioPreferences, DITHER_MODES, FADE_MAX_MS, FADE_MIN_MS, LATENCY_PROFILES, MONO_MODES, RESAMPLER_PHASES, RESAMPLER_QUALITIES,
  SPATIAL_MODES, restoreAudioDefaults, setChannelTools, setDither, setFadeMs, setLatencyProfile, setResampler, setSpatial
} from '../audio/audioPreferences'
import { replayGain, setReplayGainEnabled } from '../audio/replayGain'
import { isAutoResumeEnabled, setAutoResumeEnabled } from '../playbackResume'

const readPreference = (key: string, fallback: boolean): boolean => {
  try { return localStorage.getItem(key) !== 'off' && (localStorage.getItem(key) !== null || fallback) } catch { return fallback }
}

const QUALITY_LABEL: Record<ResamplerQuality, string> = { HQ: 'HQ · 20bit', VHQ: 'VHQ · 28bit', '24BIT': '24-bit' }
const PHASE_LABEL: Record<ResamplerPhase, string> = { linear: '线性', minimum: '最小相位', intermediate: '中间', maximum: '最大相位' }
const DITHER_LABEL: Record<DitherMode, string> = {
  off: '关闭', tpdf: 'TPDF', 'highpass-tpdf': '高通 TPDF', 'ns-5': '噪声整形 5 抽头', 'ns-9': '噪声整形 9 抽头', 'ultra-shaped': 'Ultra 整形'
}
const LATENCY_LABEL: Record<LatencyProfile, string> = { stable: '稳定优先', balanced: '均衡（默认）', lowLatency: '低延迟优先' }
const MONO_LABEL: Record<MonoMode, string> = { off: '关', sum: '求和', left: '仅左', right: '仅右' }
const SPATIAL_LABEL: Record<SpatialMode, string> = { off: '关闭', crossfeed: '串音消除', wide: '立体声加宽', virtual: '虚拟环绕' }
const BAND_LABEL = { low: '低频', mid: '中频', high: '高频' } as const
const gainText = (value: number): string => (value > 0 ? '+' : '') + value.toFixed(1) + ' dB'

/**
 * 更新 API 由 preload 暴露（perf-main 已落地：appInfo/updateState/checkForUpdates/
 * downloadUpdate/installUpdate/onUpdateStatus）。这里保留一层窄接口 + 可选调用：
 * 旧预加载/尚未接线时卡片能静态降级，接线后同一处直接生效。
 */
type UpdateBridge = {
  appInfo?: () => Promise<AppInfo>
  updateState?: () => Promise<UpdateState>
  checkForUpdates?: () => Promise<UpdateState | void>
  downloadUpdate?: () => Promise<UpdateState | void>
  installUpdate?: () => Promise<UpdateState | void>
  onUpdateStatus?: (callback: (state: UpdateState) => void) => () => void
}
const updateBridge = (): UpdateBridge => window.twilight

/** 所有 phase 的用户话术（spec §2 的九种状态 + idle）。 */
const updatePhaseText = (update: UpdateState | null): string => {
  if (!update) return '正在读取更新状态…'
  switch (update.phase) {
    case 'idle': return '尚未检查更新。'
    case 'checking': return '正在检查更新…'
    case 'available': return '发现新版本 v' + (update.latestVersion ?? '?') + '（当前 v' + update.currentVersion + '），可以下载。'
    case 'downloading': return '正在下载新版本 v' + (update.latestVersion ?? '?') + '…' + (update.percent === null ? '' : ' ' + Math.round(update.percent) + '%')
    case 'downloaded': return '新版本 v' + (update.latestVersion ?? '?') + ' 已下载；重启应用即可安装。'
    case 'up-to-date': return '已是最新版本（v' + update.currentVersion + '）。'
    case 'installing': return '正在重启并安装更新…'
    case 'error': return '更新失败，可以重试。'
    case 'unconfigured': return '未配置更新源：自动更新不会联网。'
    case 'disabled-dev': return '开发模式不检查更新。'
  }
}
const phaseBusy = (phase: UpdatePhase): boolean => phase === 'checking' || phase === 'downloading' || phase === 'installing'

export default function SettingsPage() {
  const [followTheme, setFollowTheme] = useState(() => readPreference('twilight.theme-follow', true))
  const [lyricsOnline, setLyricsOnline] = useState(() => readPreference('stringmoon.lyrics-online', true))
  const [showGlow, setShowGlow] = useState(() => readPreference('stringmoon.spectrum-glow', true))
  /** 启动自动恢复上次播放（v6）。默认开：设置页与启动流程共用同一个偏好。 */
  const [autoResume, setAutoResumeState] = useState(() => isAutoResumeEnabled())
  const setAutoResume = (value: boolean): void => { setAutoResumeState(value); setAutoResumeEnabled(value) }

  // 「无法播放」记录：用户能看见被移除了什么、为什么，并能一键捞回来。
  const [unplayable, setUnplayable] = useState<UnplayableEntry[]>([])
  const [unplayableError, setUnplayableError] = useState<string | null>(null)

  /** 读取记录并同步到 store：恢复之后列表要**立刻**把人放回来。 */
  const syncUnplayable = useCallback((report: { entries: UnplayableEntry[] }): void => {
    setUnplayable(report.entries)
    useTwilight.getState().setUnplayablePaths(report.entries.map(entry => entry.path))
  }, [])

  useEffect(() => {
    let mounted = true
    void window.twilight.unplayable()
      .then(report => { if (mounted) syncUnplayable(report) })
      .catch(() => { if (mounted) setUnplayableError('无法播放记录读取失败。') })
    return () => { mounted = false }
  }, [syncUnplayable])

  const restoreOne = (file: string): void => {
    void window.twilight.forgetUnplayable(file).then(syncUnplayable)
      .catch(() => setUnplayableError('恢复失败。'))
  }
  const restoreAll = (): void => {
    void window.twilight.clearUnplayable().then(syncUnplayable)
      .catch(() => setUnplayableError('恢复失败。'))
  }

  const setPreference = (key: string, value: boolean): void => { try { localStorage.setItem(key, value ? 'on' : 'off') } catch { /* Session fallback. */ } }

  // 顶部状态条要显示真实数据：曲库多少首、输出是什么、来源几个就绪/已登录。
  // 「控制台」如果只有一句标语，那它就只是个标题。
  const trackCount = useTwilight(state => state.tracks.length)
  const engineUp = useTwilight(state => state.engineUp)
  const deviceName = useTwilight(state => state.deviceName)
  const sampleRate = useTwilight(state => state.sampleRate)
  const outputMode = useTwilight(state => state.outputMode)
  const outputPreference = useTwilight(state => state.outputPreference)
  const setOutputPreference = useTwilight(state => state.setOutputPreference)
  const requestedOutputRate = useTwilight(state => state.requestedOutputRate)
  const setOutputRateLocal = useTwilight(state => state.setOutputRateLocal)
  const periodMs = useTwilight(state => state.periodMs)

  // 专业音频设置（CR-024/025/027 + CR-026）：应用侧偏好 + 引擎实际值要分开显示，
  // 和输出采样率同一条纪律 —— 请求了不等于被采纳，撒谎的界面比没有界面更糟。
  const preferences = useSyncExternalStore(audioPreferences.subscribe, audioPreferences.getSnapshot)
  const support = useSyncExternalStore(audioPreferences.subscribe, audioPreferences.getSupport)
  const actualResampler = useTwilight(state => state.resampler)
  const actualDither = useTwilight(state => state.dither)
  const actualLatency = useTwilight(state => state.latencyProfile)
  const actualChannels = useTwilight(state => state.dsp?.channels)
  const actualSpatial = useTwilight(state => state.spatial)
  const actualFade = useTwilight(state => state.fade)
  const replayGainState = useSyncExternalStore(replayGain.subscribe, replayGain.getSnapshot)
  const actualReplayGain = useTwilight(state => state.dsp?.replayGain)

  // ── 关于与更新（PACKAGING v1 §2）：版本/运行形态/数据目录 + 十种 phase 的更新状态机 ──
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updateBusy, setUpdateBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [updateActionError, setUpdateActionError] = useState<string | null>(null)
  const [copiedPath, setCopiedPath] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  useEffect(() => {
    let mounted = true
    const bridge = updateBridge()
    void bridge.appInfo?.().then(next => { if (mounted) setAppInfo(next) }).catch(() => { /* 接口未落地：静态兜底 */ })
    void bridge.updateState?.().then(next => { if (mounted) setUpdate(next) }).catch(() => {})
    const off = bridge.onUpdateStatus?.(next => { if (mounted) setUpdate(next) })
    return () => { mounted = false; off?.() }
  }, [])
  const updatePhase = update?.phase ?? 'idle'
  const updateSupported = update?.supported ?? appInfo?.packaged ?? false
  const updatePercent = Math.max(0, Math.min(100, update?.percent ?? 0))
  const refreshUpdate = async (): Promise<void> => {
    const next = await updateBridge().updateState?.()
    if (next) setUpdate(next)
  }
  const runUpdateAction = (kind: 'check' | 'download' | 'install', task: () => Promise<UpdateState | void | undefined> | undefined): void => {
    if (updateBusy) return
    setUpdateBusy(kind)
    setUpdateActionError(null)
    void (async () => {
      try {
        const next = task ? await task() : undefined
        if (next) setUpdate(next)
        else await refreshUpdate()
      } catch (error) {
        setUpdateActionError(error instanceof Error ? error.message : String(error))
      } finally {
        setUpdateBusy(null)
      }
    })()
  }
  const checkUpdate = (): void => { runUpdateAction('check', () => updateBridge().checkForUpdates?.()) }
  const downloadUpdate = (): void => { runUpdateAction('download', () => updateBridge().downloadUpdate?.()) }
  const installUpdate = (): void => { runUpdateAction('install', async () => { await updateBridge().installUpdate?.() }) }
  const copyDataPath = (): void => {
    const path = appInfo?.userDataPath
    if (!path) return
    void navigator.clipboard.writeText(path).then(() => {
      setCopiedPath(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { copyTimer.current = null; setCopiedPath(false) }, 1600)
    }).catch(() => setUpdateActionError('复制失败：可以手动选中路径复制。'))
  }

  /**
   * 声道工具的三频段/延迟是滑杆：拖动时只改本地草稿，停手 150ms 后才下发一条
   * set_channels（和 EQ 的队列同一个理由：一次拖动不该产生几十条命令）。
   */
  const [toolsDraft, setToolsDraft] = useState(() => ({
    monoMode: preferences.monoMode, bandGains: preferences.bandGains, delayMs: preferences.delayMs
  }))
  useEffect(() => {
    setToolsDraft({ monoMode: preferences.monoMode, bandGains: preferences.bandGains, delayMs: preferences.delayMs })
  }, [preferences])
  // 空间音频强度与过渡时长也是滑杆：草稿 → 停手 150ms 才下发（一次拖动不该发几十条命令）。
  const [spatialDraft, setSpatialDraft] = useState(preferences.spatial.amount)
  const [fadeDraft, setFadeDraft] = useState(preferences.fadeMs)
  useEffect(() => { setSpatialDraft(preferences.spatial.amount) }, [preferences.spatial.amount])
  useEffect(() => { setFadeDraft(preferences.fadeMs) }, [preferences.fadeMs])
  const spatialTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (spatialTimer.current) clearTimeout(spatialTimer.current)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
  }, [])
  const commitSpatialAmount = (amount: number): void => {
    setSpatialDraft(amount)
    if (spatialTimer.current) clearTimeout(spatialTimer.current)
    spatialTimer.current = setTimeout(() => { spatialTimer.current = null; void runApply(() => setSpatial({ amount })) }, 150)
  }
  const commitFade = (ms: number): void => {
    setFadeDraft(ms)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => { fadeTimer.current = null; void runApply(() => setFadeMs(ms)) }, 150)
  }
  const toolsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitTools = (next: typeof toolsDraft): void => {
    setToolsDraft(next)
    if (toolsTimer.current !== null) clearTimeout(toolsTimer.current)
    toolsTimer.current = setTimeout(() => {
      toolsTimer.current = null
      void runApply(async () => setChannelTools({ monoMode: next.monoMode, bandGains: next.bandGains, delayMs: next.delayMs }))
    }, 150)
  }
  useEffect(() => () => { if (toolsTimer.current !== null) clearTimeout(toolsTimer.current) }, [])

  /**
   * 「已生效 ✓ / 正在应用…」瞬时反馈（aria-live=polite，1.6s 自动消失）。
   * 为什么要有它：高级音频的每条命令都会重开/改变 DSP，用户点完需要知道「到底生效没有」；
   * 但常驻状态文字会变成噪音，所以只在对的那一秒存在。
   */
  const [applyState, setApplyState] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle')
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [resetNote, setResetNote] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [deviceOpen, setDeviceOpen] = useState(false)
  useEffect(() => () => { if (applyTimer.current) clearTimeout(applyTimer.current) }, [])
  const flashApply = (state: 'done' | 'failed'): void => {
    setApplyState(state)
    if (applyTimer.current) clearTimeout(applyTimer.current)
    applyTimer.current = setTimeout(() => { applyTimer.current = null; setApplyState('idle') }, 1600)
  }
  const runApply = useCallback(async (task: () => Promise<boolean | void>): Promise<void> => {
    setApplyState('pending')
    if (applyTimer.current) { clearTimeout(applyTimer.current); applyTimer.current = null }
    try {
      const ok = await task()
      flashApply(ok === false ? 'failed' : 'done')
    } catch { flashApply('failed') }
  }, [])

  /** 恢复默认：四项一起下发，然后回读引擎实际值（回读由 ipc.get_state 的 applyEvent/applyDsp 完成）。 */
  const resetDefaults = async (): Promise<void> => {
    if (resetting) return
    setResetting(true)
    setResetNote(null)
    setApplyState('pending')
    try {
      const ok = await restoreAudioDefaults()
      await engineRequest({ cmd: 'get_state' }, 15000).catch(() => { /* 回读失败不改变「已下发」这个事实 */ })
      setResetNote(ok ? '已恢复默认' : '已恢复默认（部分能力此引擎不支持）')
      flashApply(ok ? 'done' : 'failed')
    } catch {
      setResetNote('恢复失败，请重试。')
      flashApply('failed')
    } finally {
      setResetting(false)
      setTimeout(() => setResetNote(null), 2600)
    }
  }

  /** 三段增益全 0 时整段旁路，不能因为 bandGains 对象存在就宣称 DSP 生效。 */
  const bandActive = !!actualChannels && (['low', 'mid', 'high'] as const).some(band => {
    const pair = actualChannels.bandGains?.[band]
    return (pair?.[0] ?? 0) !== 0 || (pair?.[1] ?? 0) !== 0
  })
  /** 引擎实际生效的汇总 chips（不拿请求值冒充实际值）。 */
  const actualChips = [
    {
      key: 'resampler', label: '重采样',
      value: support.resampler ? '不支持' : actualResampler
        ? QUALITY_LABEL[actualResampler.quality] + ' · ' + PHASE_LABEL[actualResampler.phase] + (actualResampler.steep ? ' · 陡峭' : '')
        : '未上报'
    },
    {
      key: 'dither', label: '抖动',
      value: support.dither ? '不支持' : actualDither
        ? DITHER_LABEL[actualDither.mode] + (actualDither.active ? ' · 生效' : '')
        : '未上报'
    },
    {
      key: 'latency', label: '延迟',
      value: support.latency ? '不支持' : actualLatency ? LATENCY_LABEL[actualLatency] : '未上报'
    },
    {
      key: 'channels', label: '声道',
      value: support.channelTools ? '不支持' : actualChannels
        ? (actualChannels.monoMode && actualChannels.monoMode !== 'off' ? 'mono ' + MONO_LABEL[actualChannels.monoMode] : '直通')
          + (actualChannels.delayMs && (actualChannels.delayMs[0] > 0 || actualChannels.delayMs[1] > 0) ? ' · 延迟' : '')
          + (bandActive ? ' · 三段' : '')
        : '未上报'
    }
  ]

  /**
   * 设备能力表：引擎对它**真的逐个探测**了（IsFormatSupported × 采样率 × 源精度），
   * 所以这里不是一张"规格表"，而是一张"这个端点接受了什么"的实测结果。
   *
   * 探测会打开每个端点、每种格式各问一次，慢一点（秒级），所以只在需要时读：
   * **details 展开**，或用户点「重新探测」。不在挂载时无条件打一遍，也不因为滚动就触碰设备。
   */
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const probeDevices = useCallback((): void => {
    if (!useTwilight.getState().engineUp) { setDeviceError('引擎还没连上。'); return }
    setDeviceBusy(true)
    setDeviceError(null)
    void engineRequest<{ devices?: DeviceInfo[] }>({ cmd: 'list_devices' }, 30000)
      .then(reply => setDevices(Array.isArray(reply?.devices) ? reply.devices : []))
      .catch(error => setDeviceError(error instanceof Error ? error.message : String(error)))
      .finally(() => setDeviceBusy(false))
  }, [])

  /**
   * 输出规格与模式：两者都走同一次 set_output。改一个时必须带上另一个，
   * 否则引擎会把没传的那个当成默认值重置。
   */
  const applyOutput = (patch: { mode?: OutputPreference; rate?: number }): void => {
    const mode = patch.mode ?? outputPreference
    const rate = patch.rate ?? requestedOutputRate
    if (patch.mode) setOutputPreference(patch.mode)
    if (patch.rate !== undefined) setOutputRateLocal(patch.rate)
    void engineRequest({ cmd: 'set_output', mode, sampleRate: rate }).catch(error => {
      setOutputPreference(outputPreference)
      setOutputRateLocal(requestedOutputRate)
      useTwilight.getState().setProtocolError(error instanceof Error ? error.message : String(error))
    })
  }
  // v6：补到 384k 家族（352.8k 是 44.1k 的 8 倍频，384k 是 48k 的 8 倍频；两者都要有）。
  const OUTPUT_RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000] as const
  const OUTPUT_MODE_LABEL: Record<OutputPreference, string> = { auto: '自动', exclusive: '独占', shared: '共享' }
  /** "44100:24" → "44.1k / 24bit"：探测结果是 rate:源精度，界面要读得懂。 */
  const formatLabel = (entry: string): string => {
    const [rate, bits] = entry.split(':')
    const hz = Number(rate)
    return Number.isFinite(hz) && hz > 0 ? (hz / 1000) + 'k / ' + bits + 'bit' : entry
  }
  const [sources, setSources] = useState<{ ready: number; signedIn: number; total: number } | null>(null)
  // 状态条必须**活的**：服务端是应用在后台拉起的，页面刚打开时还没就绪。
  // 只读一次会长期显示「0 / 3」，比不显示更误导。
  useEffect(() => {
    let mounted = true
    const refresh = (): void => {
      // 页面不可见时不打点（设置页轮询只在真的看得见时才有意义）；回前台立即补一次。
      if (document.hidden) return
      void window.twilight.streamingStatus().then((status: Awaited<ReturnType<typeof window.twilight.streamingStatus>>) => {
        if (!mounted) return
        setSources({
          ready: status.runtimes.filter((runtime: { state: string }) => runtime.state === 'ready').length,
          signedIn: status.sessions.filter((session: { status: string }) => session.status === 'signed-in').length,
          total: status.config.providers.length
        })
      }).catch(() => { /* 读不到就保持上一帧，不编造 0 */ })
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    const onVisible = (): void => { if (!document.hidden) refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mounted = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 目录跟着滚动高亮：设置页很长，静态目录等于让用户自己找位置。
  const [activeSection, setActiveSection] = useState('playback')
  useEffect(() => {
    const targets = ['playback', 'output', 'appearance', 'about', 'library', 'accounts']
      .map(id => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
    if (targets.length === 0) return
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (visible?.target.id) setActiveSection(visible.target.id)
    }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 })
    targets.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [])

  return <section className="settings-page" aria-label="设置">
    <header className="settings-hero"><div><span className="section-eyebrow">STRINGMOON / PREFERENCES</span><h1>设置</h1><p>把播放、界面和音乐来源放在同一张控制台。</p></div><div className="settings-hero-mark"><SlidersHorizontal size={20} /></div></header>
    <div className="settings-console" role="group" aria-label="当前状态">
      <button className="settings-metric" onClick={() => jump('library')}>
        <span>曲库</span><strong>{trackCount.toLocaleString()}</strong><small>首</small>
      </button>
      <button className="settings-metric" onClick={() => jump('playback')}>
        <span>输出</span><strong>{engineUp ? (deviceName ?? '已连接') : '未连接'}</strong>
        <small>{sampleRate ? (sampleRate / 1000).toLocaleString() + ' kHz' : '—'}</small>
      </button>
      <button className="settings-metric" onClick={() => jump('accounts')}>
        <span>来源</span><strong>{sources ? sources.ready + ' / ' + sources.total : '—'}</strong>
        <small>{sources ? sources.signedIn + ' 已登录' : '就绪 / 全部'}</small>
      </button>
      <button className="settings-metric" onClick={() => jump('library')}>
        <span>已移除</span><strong>{unplayable.length}</strong><small>首无法播放</small>
      </button>
    </div>
    <div className="settings-layout">
      <aside className="settings-index" aria-label="设置目录">
        <a href="#playback" aria-current={activeSection === 'playback'}><Gauge size={15} />播放</a><a href="#output" aria-current={activeSection === 'output'}><AudioLines size={15} />输出</a><a href="#appearance" aria-current={activeSection === 'appearance'}><Palette size={15} />界面</a><a href="#about" aria-current={activeSection === 'about'}><Info size={15} />关于</a><a href="#library" aria-current={activeSection === 'library'}><FolderCog size={15} />曲库</a><a href="#accounts" aria-current={activeSection === 'accounts'}><UserRound size={15} />账户</a>
      </aside>
      <div className="settings-content">
        <section id="playback" className="settings-card"><div className="settings-card-heading"><div><span className="section-eyebrow">PLAYBACK</span><h2>播放体验</h2></div><Gauge size={18} /></div>
          <div className="settings-row"><div><strong>启动时自动回到上次播放</strong><span>重启后自动装载上次那首歌与位置，保持**暂停**（不自动出声）。关掉则只显示一条「继续上次」提示。</span></div>
            <button className={'settings-switch' + (autoResume ? ' on' : '')} aria-pressed={autoResume} aria-label="启动时自动恢复上次播放"
              onClick={() => { const next = !autoResume; setAutoResume(next); setAutoResumeEnabled(next) }}><span>{autoResume ? '开启' : '关闭'}</span><i /></button></div><div className="settings-row"><div><strong>沉浸模式频谱光效</strong><span>只在有真实 meter 数据时绘制底部连续曲线。</span></div><button className={'settings-switch' + (showGlow ? ' on' : '')} aria-pressed={showGlow} onClick={() => { const next = !showGlow; setShowGlow(next); setPreference('stringmoon.spectrum-glow', next) }}><span>{showGlow ? '开启' : '关闭'}</span><i /></button></div>
          <div className="settings-row"><div><strong>响度归一化（ReplayGain）</strong><span>按曲目响度对齐播放音量。默认关闭；开启后只对「正在播放且未扫描过」的曲目做一次离线扫描（引擎有磁盘缓存，第二次起即时），防削波用引擎测得的真峰值。会改变听感，并让 bit-perfect 如实变为否。</span></div>
            <div className="settings-controls">
              <button className={'settings-switch' + (replayGainState.enabled ? ' on' : '')} aria-pressed={replayGainState.enabled} disabled={!engineUp}
                onClick={() => setReplayGainEnabled(!replayGainState.enabled)}><span>{replayGainState.enabled ? '开启' : '关闭'}</span><i /></button>
              <small className="settings-status">
                {replayGainState.enabled
                  ? (replayGainState.scanning ? '扫描中 ' + replayGainState.scanning.done + '/' + replayGainState.scanning.total : '已分析 ' + replayGainState.analysed + ' 首')
                    + (actualReplayGain?.mode === 'track' ? ' · 当前 ' + gainText(actualReplayGain.trackGainDb) : '')
                  : (actualReplayGain && actualReplayGain.mode !== 'off' ? '引擎当前仍为 ' + actualReplayGain.mode + '（关闭后归零）' : '默认关闭')}
              </small>
            </div>
          </div></section>
<section id="output" className="settings-card"><div className="settings-card-heading"><div><span className="section-eyebrow">OUTPUT</span><h2>输出与规格</h2></div><AudioLines size={18} /></div>
          <div className="settings-row settings-row-static"><div><strong>当前输出</strong><span title="引擎正在跑的这条流">实际流：{sampleRate ? (sampleRate / 1000) + ' kHz' : '—'} · {outputMode === 'exclusive' ? '独占' : outputMode === 'shared' ? '共享' : '未连接'} · {deviceName ?? '—'}</span></div><span className="settings-status">{requestedOutputRate > 0 ? '请求 ' + requestedOutputRate / 1000 + ' kHz' : '跟随源'}</span></div>
          <div className="settings-row"><div><strong>输出规格</strong><span title="非「跟随源」时重采样器进入链路，bit-perfect 会如实变为否；共享模式下 WASAPI 只能跑设备混音格式，请求不会被采纳但会显示出来。">指定引擎开流的采样率。</span></div>
            <div className="segmented-control settings-rate">{OUTPUT_RATES.map(rate => <button key={rate} aria-pressed={requestedOutputRate === rate} onClick={() => applyOutput({ rate })}>{rate === 0 ? '跟随源' : rate / 1000 + 'k'}</button>)}</div></div>
          <div className="settings-row"><div><strong>输出模式</strong><span title="独占绕过系统混音器；端点拒绝时引擎自动降级成共享并说明原因。">独占 / 共享 / 自动；失败会降级并说明原因。</span></div>
            <div className="segmented-control settings-rate">{(['auto', 'exclusive', 'shared'] as OutputPreference[]).map(mode => <button key={mode} aria-pressed={outputPreference === mode} onClick={() => applyOutput({ mode })}>{OUTPUT_MODE_LABEL[mode]}</button>)}</div></div>

          <details className="settings-device settings-subcard" open={deviceOpen}
            onToggle={event => { const open = event.currentTarget.open; setDeviceOpen(open); if (open && devices.length === 0 && !deviceBusy) probeDevices() }}>
            <summary className="settings-device-summary"><div><strong>端点能力（实测）</strong><span>引擎对每个端点逐个 IsFormatSupported，格式是「采样率 / 源精度」；展开后才探测。</span></div><span className="settings-status">{deviceBusy ? '探测中…' : devices.length > 0 ? devices.length + ' 个端点' : '未探测'}</span></summary>
            <div className="device-block">
              <div className="device-head"><div><strong>探测结果</strong><span>慢几秒：每个端点每种格式都会真实打开一次去问。</span></div><button className="topbar-action" disabled={deviceBusy} onClick={probeDevices}>{deviceBusy ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />}{deviceBusy ? '探测中' : '重新探测'}</button></div>
              {deviceError ? <p className="settings-note" role="status">{deviceError}</p> : null}
              {devices.map(device => <div className="device-row" key={device.id}>
                <div className="device-copy"><strong>{device.name}{device.isDefault ? ' · 默认' : ''}</strong><span>{device.sampleRate ? (device.sampleRate / 1000) + ' kHz' : '—'} · {device.channels ?? '—'} ch{device.isBluetooth ? ' · 蓝牙' : ''}</span></div>
                <div className="device-formats">{device.exclusiveFormats && device.exclusiveFormats.length > 0 ? device.exclusiveFormats.map(format => <span className="format-chip mono" key={format}>{formatLabel(format)}</span>) : <span className="device-none">独占不可用</span>}</div>
              </div>)}
              {devices.length === 0 && !deviceBusy && !deviceError ? <p className="settings-note">展开这一节会自动探测一次；也可以点「重新探测」。</p> : null}
            </div>
          </details>

          <section className="settings-subcard settings-advanced" aria-label="高级音频">
            <header className="settings-advanced-head">
              <div><span className="section-eyebrow">ADVANCED AUDIO</span><h3>高级音频</h3></div>
              <span className="settings-apply" data-state={applyState} aria-live="polite">
                {applyState === 'pending' ? '正在应用…' : applyState === 'done' ? '已生效 ✓' : applyState === 'failed' ? '未生效，请重试' : ''}
              </span>
            </header>
            <div className="settings-actual-chips" aria-label="引擎实际生效的设置">
              {actualChips.map(chip => <span className="chip" key={chip.key} data-unsupported={chip.value === '不支持' || undefined}>
                {chip.label}<b>{chip.value}</b></span>)}
            </div>

            <div className="settings-row">
              <div><strong>重采样器</strong><span title="只在源采样率 ≠ 输出采样率时进入链路。VHQ（SoXR 28bit）为默认；线性相位是现状；最小/最大相位改变 pre-ringing 取舍，陡峭滤波牺牲一点过渡带换阻带抑制。改动会让引擎重开流（可能有 <100ms 淡入），不是无缝的。">质量 / 相位 / 陡峭滤波；默认 VHQ·线性，与现状等价。</span></div>
              <div className="settings-controls">
                <div className="segmented-control settings-rate">{RESAMPLER_QUALITIES.map(quality =>
                  <button key={quality} aria-pressed={preferences.resampler.quality === quality} disabled={!engineUp || support.resampler}
                    onClick={() => void runApply(() => setResampler({ quality }))}>{QUALITY_LABEL[quality]}</button>)}</div>
                <label className="settings-select">相位
                  <select aria-label="重采样相位" value={preferences.resampler.phase} disabled={!engineUp || support.resampler}
                    onChange={event => { const phase = event.target.value as ResamplerPhase; void runApply(() => setResampler({ phase })) }}>
                    {RESAMPLER_PHASES.map(phase => <option key={phase} value={phase}>{PHASE_LABEL[phase]}</option>)}
                  </select>
                </label>
                <button className={'settings-switch' + (preferences.resampler.steep ? ' on' : '')} aria-pressed={preferences.resampler.steep}
                  disabled={!engineUp || support.resampler} onClick={() => void runApply(() => setResampler({ steep: !preferences.resampler.steep }))}>
                  <span>{preferences.resampler.steep ? '陡峭' : '标准'}</span><i /></button>
                {support.resampler ? <small className="settings-status" data-unsupported>引擎不支持（旧引擎）</small> : null}
              </div>
            </div>

            <div className="settings-row">
              <div><strong>PCM 抖动</strong><span title="只在整数输出且输出位深低于源精度时才真的加（bit-perfect / float 输出永不启用）。默认 TPDF 与现状等价；噪声整形把量化噪声推离可听频段，但会改变噪底形状，建议 A/B 听。">整数输出且位深不足时才加；默认 TPDF。</span></div>
              <div className="settings-controls">
                <label className="settings-select">模式
                  <select aria-label="PCM dither 模式" value={preferences.dither} disabled={!engineUp || support.dither}
                    onChange={event => { const mode = event.target.value as DitherMode; void runApply(() => setDither(mode)) }}>
                    {DITHER_MODES.map(mode => <option key={mode} value={mode}>{DITHER_LABEL[mode]}</option>)}
                  </select>
                </label>
                {support.dither ? <small className="settings-status" data-unsupported>引擎不支持（旧引擎）</small> : null}
              </div>
            </div>

            <div className="settings-row">
              <div><strong>延迟档位</strong><span title="低延迟优先（独占/共享都向最小可行 period 靠拢）与稳定优先（更大缓冲换 xrun=0）是真实取舍；均衡是现状默认。共享模式无法小于系统混音周期时以实测值为准。">低延迟与稳定性的取舍；均衡是默认。</span></div>
              <div className="settings-controls">
                <div className="segmented-control settings-rate">{LATENCY_PROFILES.map(profile =>
                  <button key={profile} aria-pressed={preferences.latency === profile} disabled={!engineUp || support.latency}
                    onClick={() => void runApply(() => setLatencyProfile(profile))}>{LATENCY_LABEL[profile]}</button>)}</div>
                {support.latency ? <small className="settings-status" data-unsupported>引擎不支持（旧引擎）</small>
                  : periodMs ? <small className="settings-status">周期 {periodMs.toFixed(1)} ms</small> : null}
              </div>
            </div>

            <div className="settings-row">
              <div><strong>声道工具</strong><span title="单声道来源选择、200 Hz / 2 kHz LR2 分频的三频段左右独立增益、每声道延迟（音箱摆位对齐）。全部为关闭 / 0 时整段旁路，不改变样本、不破坏 bit-perfect；任一非 0 才进入 DSP。">mono 来源 / 三频段增益 / 每声道延迟；全 0 即旁路。</span></div>
              <div className="settings-controls settings-tools">
                <div className="segmented-control settings-rate">{MONO_MODES.map(mode =>
                  <button key={mode} aria-pressed={toolsDraft.monoMode === mode} disabled={!engineUp || support.channelTools}
                    onClick={() => commitTools({ ...toolsDraft, monoMode: mode })}>{MONO_LABEL[mode]}</button>)}</div>
                <div className="settings-band-grid">
                  {(['low', 'mid', 'high'] as const).map(band => <div className="settings-band-row" key={band}>
                    <span>{BAND_LABEL[band]}</span>
                    <label><b className="settings-band-ch">L</b><input type="range" min={-6} max={3} step={0.5} value={toolsDraft.bandGains[band][0]} disabled={!engineUp || support.channelTools}
                      aria-label={BAND_LABEL[band] + ' 左声道增益'} aria-valuetext={gainText(toolsDraft.bandGains[band][0])}
                      onChange={event => commitTools({ ...toolsDraft, bandGains: { ...toolsDraft.bandGains, [band]: [Number(event.target.value), toolsDraft.bandGains[band][1]] as [number, number] } })} />
                      <output>{gainText(toolsDraft.bandGains[band][0])}</output></label>
                    <label><b className="settings-band-ch">R</b><input type="range" min={-6} max={3} step={0.5} value={toolsDraft.bandGains[band][1]} disabled={!engineUp || support.channelTools}
                      aria-label={BAND_LABEL[band] + ' 右声道增益'} aria-valuetext={gainText(toolsDraft.bandGains[band][1])}
                      onChange={event => commitTools({ ...toolsDraft, bandGains: { ...toolsDraft.bandGains, [band]: [toolsDraft.bandGains[band][0], Number(event.target.value)] as [number, number] } })} />
                      <output>{gainText(toolsDraft.bandGains[band][1])}</output></label>
                  </div>)}
                </div>
                <div className="settings-delay-grid">
                  {([0, 1] as const).map(channel => <label key={channel}><b className="settings-band-ch">{channel === 0 ? 'L' : 'R'}</b><span className="settings-delay-name">延迟</span>
                    <input type="range" min={0} max={10} step={0.1} value={toolsDraft.delayMs[channel]} disabled={!engineUp || support.channelTools}
                      aria-label={(channel === 0 ? '左' : '右') + '声道延迟'} aria-valuetext={toolsDraft.delayMs[channel].toFixed(1) + ' ms'}
                      onChange={event => commitTools({ ...toolsDraft, delayMs: (channel === 0 ? [Number(event.target.value), toolsDraft.delayMs[1]] : [toolsDraft.delayMs[0], Number(event.target.value)]) as [number, number] })} />
                    <output>{toolsDraft.delayMs[channel].toFixed(1)} ms</output></label>)}
                </div>
                {support.channelTools ? <small className="settings-status" data-unsupported>引擎不支持（旧引擎）</small> : null}
              </div>
            </div>

            <div className="settings-advanced-foot">
              <button className="topbar-action settings-reset-defaults" disabled={!engineUp || resetting} onClick={() => void resetDefaults()}>
                {resetting ? '恢复中…' : '恢复默认'}</button>
              <small className="settings-status" role="status">{resetNote ?? '恢复默认会同时重置四项并回读引擎实际值。'}</small>
            </div>
          </section>
          <section className="settings-subcard settings-spatial" aria-label="空间音频与过渡">
            <header className="settings-advanced-head">
              <div><span className="section-eyebrow">SPATIAL &amp; FADE</span><h3>空间音频与过渡</h3></div>
              <span className="settings-status">{actualSpatial
                ? '实际：' + SPATIAL_LABEL[actualSpatial.mode]
                  + ' · 强度 ' + String(Math.round(actualSpatial.amount * 100) / 100)
                  + (actualSpatial.active ? ' · 生效' : ' · 未处理')
                : support.spatial ? '引擎不支持' : '引擎未上报'}</span>
            </header>
            <div className="settings-row">
              <div><strong>空间音频</strong><span title="crossfeed=耳机串扰消除（对侧短延迟 ≤1ms，按样本对齐）；wide=中侧立体声扩展（纯 M/S 增益，零延迟）；virtual=24 方位 HRIR 双耳虚拟环绕（复用 1024 帧分块 FFT 卷积器）。off 时整段旁路、逐样本恒等，bit-perfect 不变；任何模式都只输出双耳 2ch。">串音消除 / 立体声加宽 / 虚拟环绕；关闭时逐样本恒等。虚拟环绕有 1024 帧（约 21ms@48k）处理延迟，串音消除 / 立体声加宽无分块延迟。</span></div>
              <div className="settings-controls">
                <div className="segmented-control settings-rate settings-spatial-mode">{SPATIAL_MODES.map(mode =>
                  <button key={mode} aria-pressed={preferences.spatial.mode === mode} disabled={!engineUp || support.spatial}
                    onClick={() => void runApply(() => setSpatial({ mode }))}>{SPATIAL_LABEL[mode]}</button>)}</div>
                <label className="settings-slider-line"><span>强度</span>
                  <input type="range" min={0} max={1} step={0.05} value={spatialDraft} disabled={!engineUp || support.spatial || preferences.spatial.mode === 'off'}
                    aria-label="空间音频强度" aria-valuetext={Math.round(spatialDraft * 100) + '%'}
                    onChange={event => commitSpatialAmount(Number(event.target.value))} />
                  <output>{Math.round(spatialDraft * 100)}%</output>
                </label>
                {support.spatial ? <small className="settings-status" data-unsupported>引擎不支持（旧引擎）</small> : null}
              </div>
            </div>
            <div className="settings-row">
              <div><strong>过渡时长</strong><span title="等功率 sin² 淡入淡出（旧实现是线性，中途仍有可闻台阶）。暂停时保持输出流打开并渲染静音，恢复时淡入，避免 USB DAC / 蓝牙端点 Stop/Start 之间的电源与时钟切换底噪。">暂停 / 切歌 / seek 的淡入淡出；默认 10ms。</span></div>
              <div className="settings-controls">
                <label className="settings-slider-line"><span>时长</span>
                  <input type="range" min={FADE_MIN_MS} max={FADE_MAX_MS} step={1} value={fadeDraft} disabled={!engineUp || support.fade}
                    aria-label="过渡时长（毫秒）" aria-valuetext={fadeDraft + ' ms'}
                    onChange={event => commitFade(Number(event.target.value))} />
                  <output>{fadeDraft} ms</output>
                </label>
                <small className="settings-status" data-unsupported={support.fade || undefined}>
                  {support.fade ? '引擎不支持（旧引擎）' : actualFade ? '实际：' + actualFade.ms + ' ms · 暂停保持' + (actualFade.pauseHold ? '开' : '关') : '引擎未上报'}
                </small>
              </div>
            </div>
          </section>
        </section>
        <section id="appearance" className="settings-card"><div className="settings-card-heading"><div><span className="section-eyebrow">APPEARANCE</span><h2>界面与动效</h2></div><Palette size={18} /></div><div className="settings-row"><div><strong>跟随歌曲主题色</strong><span>从当前封面提取低饱和色彩，作为界面强调色。</span></div><button className={'settings-switch' + (followTheme ? ' on' : '')} aria-pressed={followTheme} onClick={() => { const next = !followTheme; setFollowTheme(next); setPreference('twilight.theme-follow', next) }}><span>{followTheme ? '开启' : '关闭'}</span><i /></button></div><div className="settings-note"><Check size={14} />减少动态效果会自动关闭连续光效与进入动画。</div></section>
        <section id="about" className="settings-card settings-about">
          <div className="settings-card-heading"><div><span className="section-eyebrow">ABOUT &amp; UPDATES</span><h2>关于与更新</h2></div><Info size={18} /></div>
          <div className="about-grid">
            <div className="about-row">
              <div><strong>版本</strong><span>当前运行的 Stringmoon 版本；覆盖安装后会跟着变化。</span></div>
              <span className="about-value mono">{update?.currentVersion ?? appInfo?.version ?? '—'}</span>
            </div>
            <div className="about-row">
              <div><strong>运行形态</strong><span>安装版支持自动更新；开发版不检查更新。</span></div>
              <span className="about-value">{appInfo ? (appInfo.packaged ? '安装版' : '开发版') + ' · ' + appInfo.platform : '尚未获取'}</span>
            </div>
            <div className="about-row">
              <div><strong>数据目录</strong><span className="about-path mono" title={appInfo?.userDataPath ?? undefined}>{appInfo?.userDataPath ?? '尚未获取（等更新接口接入）'}</span></div>
              <button className="topbar-action about-copy" data-copied={copiedPath || undefined} disabled={!appInfo?.userDataPath} onClick={copyDataPath}>
                {copiedPath ? <Check size={14} /> : <Copy size={14} />}{copiedPath ? '已复制' : '复制路径'}
              </button>
            </div>
          </div>

          <div className="about-row about-update">
            <div>
              <strong>自动更新</strong>
              <span className="about-phase" data-phase={updatePhase} aria-live="polite">{updatePhaseText(update)}</span>
            </div>
            <div className="update-actions">
              {updatePhase === 'available' ? <button className="topbar-action update-download" disabled={updateBusy !== null} onClick={downloadUpdate}><Download size={14} />下载更新</button> : null}
              {updatePhase === 'downloaded' ? <button className="topbar-action update-install" disabled={updateBusy !== null} onClick={installUpdate}><RotateCcw size={14} />重启并安装</button> : null}
              {phaseBusy(updatePhase)
                ? <span className="settings-status">{updatePhase === 'checking' ? '检查中…' : updatePhase === 'installing' ? '正在安装…' : '下载中…'}</span>
                : updatePhase === 'disabled-dev' ? null : (
                  <button className="topbar-action update-check" disabled={updateBusy !== null || !updateSupported || updatePhase === 'unconfigured'}
                    title={updatePhase === 'unconfigured' ? '先配置更新源' : undefined} onClick={checkUpdate}>
                    <RefreshCw size={14} />{updatePhase === 'error' ? '重试' : '检查更新'}
                  </button>
                )}
            </div>
          </div>

          {updatePhase === 'downloading' ? <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(updatePercent)} aria-label="更新下载进度">
            <span className="update-track"><i style={{ width: updatePercent + '%' }} /></span>
            <span className="update-percent mono">{Math.round(updatePercent)}%</span>
          </div> : null}

          {updatePhase === 'error' || updateActionError ? <p className="update-error" role="alert">
            <TriangleAlert size={14} aria-hidden />{updateActionError ?? update?.message ?? '更新失败，请重试。'}
          </p> : null}

          {updatePhase === 'unconfigured' ? <div className="update-config">
            <p>打包版需要配置一个静态更新源（generic），只允许 http(s)：</p>
            <p>① 环境变量：<code className="mono">TWILIGHT_UPDATE_URL=https://example.com/stringmoon/releases/</code></p>
            <p>② 或在数据目录放 <code className="mono">update-feed.json</code>：</p>
            <pre className="update-config-example mono">{'{ "url": "https://example.com/stringmoon/releases/" }'}</pre>
            <p className="settings-note">未配置时不会偷连任何占位地址；配置后点「检查更新」。</p>
          </div> : null}

          {updatePhase === 'disabled-dev' ? <p className="settings-note">开发模式不检查更新；打包后的安装版才会使用自动更新。</p> : null}
        </section>
        <section id="library" className="settings-card"><div className="settings-card-heading"><div><span className="section-eyebrow">LIBRARY</span><h2>本地曲库</h2></div><FolderCog size={18} /></div><div className="settings-row settings-row-static"><div><strong>本地优先</strong><span>曲库、歌单、歌词关联和元数据修正保存在本机。</span></div><span className="settings-status">已启用</span></div>
          <div className="settings-row settings-row-static"><div><strong>扫描方式</strong><span>添加或重新扫描目录时会包含子文件夹，并在入库前用解码器验证文件；验证不通过的文件不会进入列表。</span></div><span className="settings-status">递归 + 预检</span></div>
          <div className="settings-row"><div><strong>播放时在线查找歌词</strong><span>本地同名歌词（.lrc / .ttml / .yrc）永远优先；没有时才按歌名与艺人查一次：AMLL 逐字 → 网易云（原文+中译+罗马音）→ LRCLIB。命中即缓存，查不到也会记住，不重复请求。</span></div><button className={'settings-switch' + (lyricsOnline ? ' on' : '')} aria-pressed={lyricsOnline} onClick={() => { const next = !lyricsOnline; setLyricsOnline(next); setPreference('stringmoon.lyrics-online', next) }}><span>{lyricsOnline ? '开启' : '关闭'}</span><i /></button></div>
          <div className="unplayable-block">
            <div className="unplayable-head">
              <div><strong>无法播放的歌曲</strong><span>{unplayable.length > 0 ? `${unplayable.length} 首已从列表移除 · 不会删除你的文件` : '目前没有记录'}</span></div>
              {unplayable.length > 0 ? <button className="topbar-action" onClick={restoreAll}><RotateCcw size={14} />全部恢复</button> : null}
            </div>
            {unplayableError ? <p className="settings-note" role="status">{unplayableError}</p> : null}
            {unplayable.length > 0 ? <div className="unplayable-list" role="list">
              {unplayable.map(entry => <div className="unplayable-row" role="listitem" key={entry.path}>
                <TriangleAlert size={14} aria-hidden />
                <span className="unplayable-file" title={entry.path}>{entry.path.split(/[\\/]/).pop()}</span>
                <span className="unplayable-reason" title={entry.reason}>{entry.reason}</span>
                <span className="unplayable-source mono">{entry.source === 'scan' ? '扫描预检' : '播放失败'}</span>
                <button className="quiet-button" onClick={() => restoreOne(entry.path)} aria-label={'恢复 ' + entry.path} title="恢复：让它重新出现在列表里">恢复</button>
              </div>)}
            </div> : null}
            <p className="settings-note">移除只是不再显示，<strong>不会删除或修改任何音乐文件</strong>。文件修好后点「恢复」即可回到列表；重新扫描也会重新验证它们。</p>
          </div>
        </section>
        <section id="accounts" className="settings-card"><div className="settings-card-heading"><div><span className="section-eyebrow">STREAMING SOURCES</span><h2>流媒体账户</h2></div><Cloud size={18} /></div><StreamingSources /></section>
      </div>
    </div>
  </section>
}