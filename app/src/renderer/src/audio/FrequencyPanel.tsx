import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowUpRight, RotateCcw, Waves } from 'lucide-react'
import { useTwilight } from '../store'
import { eqCommands, refreshDspDetails, useEqCommandStatus } from './eqCommands'
import { engineRequest } from '../ipc'
import { filtersToPatch, fitCurveToBands, parseEqPreset } from '@shared/eq-preset'
import type { EqFilter } from '@shared/eq-preset'
import { HEADPHONE_PRESETS } from '@shared/eq-headphone'
import type { AutoEqModelChoice } from '@shared/eq-model'
import { EQ_BAND_FREQUENCY } from '@shared/eq-bands'
import { TARGET_CURVES, targetToFilters } from '@shared/eq-targets'
import type { EqPresetRecord } from '@shared/eq-model'
import { DEFAULT_CHANNEL_SNAPSHOT, popUndo, pushUndo, snapshotOf, snapshotToBands, snapshotToChannels } from './eqSnapshots'
import type { ChannelSnapshot, EqSnapshot } from './eqSnapshots'
import { Undo2 } from 'lucide-react'
import { fitErrorDb } from '@shared/eq-preset'
import { Download, Upload, Trash2 } from 'lucide-react'
import { calculateResponse } from './frequencyResponse'
import type { FrequencyResponse } from './frequencyResponse'
import type { ChannelPatch, EqBandPatch, EqBandTypeName, EqPatch } from '@shared/protocol'
import { channelCommands, useChannelCommandStatus } from './channelCommandQueue'

/** 内置音色：十个固定增益，等价于「十段等 Q 峰值」——与引擎的 SPEC 3.4 网格一一对应。 */
const TONAL_PRESETS = [
  { name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '暖声', gains: [3, 3, 2, 1, 0, -0.5, -1, 0, 1, 1.5] },
  { name: '人声', gains: [-2, -1, 0, 1, 2, 3, 2, 1, 0, -1] },
  { name: '清晰', gains: [-1, -1, 0, 0, 0, 1, 2, 3, 2, 1] }
]

/** 十个固定增益 → 参数带（全部用引擎网格频率与 Q 1.41）。 */
function tonalFilters(gains: number[]): EqFilter[] {
  return gains.map((gainDb, index) => ({ type: 'peaking' as const, freq: EQ_BAND_FREQUENCY[index]!, gainDb, q: 1.41 }))
}
const CROSSFEED_PRESETS = [
  { value: 0, label: '标准', fcHz: 700, feedDb: 4.5 },
  { value: 1, label: 'Chu Moy', fcHz: 700, feedDb: 6 },
  { value: 2, label: 'Jan Meier', fcHz: 650, feedDb: 9.5 }
] as const
const hzLabel = (hz: number): string => hz >= 1000 ? `${hz / 1000}k` : `${hz}`
const dbLabel = (db: number): string => `${db > 0 ? '+' : ''}${db.toFixed(1)}`

/**
 * 调音台的一条通道（v6.2）。
 *
 * 用户要的是「调音台模式」：十路竖向推子并排、像一张混合台面，而不是一格格卡片。
 * 所以每条通道从上到下是 序号 → 增益读数 → 竖向推子（200px，居中 0 dB 刻度）
 * → 频率（Hz，可直接改）→ Q → 类型 → 复位。
 *
 * 与旧版（把 10 条 20px 竖滑杆塞进 1fr、只有所选频段能改形状）的区别：
 *  - 推子更高更宽（200×26px 的轨道，整条通道约 70px 宽），读数在推子上方；
 *  - **每一条通道**都能改频率 / Q / 类型，不需要先「选中某段」；
 *  - 推子双击回 0 dB，复位只清该段的频率/Q 形状。
 *
 * 图上拖动与这里的推子/输入改的是同一份引擎状态，两条路不会打架。
 */
function EqChannel({ index, freq, gainDb, q, type, globalQ, ready, enabled, unavailable, onGain, onShape }: {
  index: number
  freq: number
  gainDb: number
  q: number
  type: EqBandTypeName | undefined
  globalQ: number
  ready: boolean
  enabled: boolean
  unavailable: boolean
  onGain: (gainDb: number) => void
  onShape: (patch: EqBandPatch) => void
}) {
  const resolvedQ = q > 0 ? q : globalQ
  const [freqDraft, setFreqDraft] = useState(String(Math.round(freq)))
  const [qDraft, setQDraft] = useState(String(Number(resolvedQ.toFixed(2))))
  // 引擎回读/预设应用/图上拖动都会改真实值：草稿跟着刷新，避免输入框停在旧数字。
  useEffect(() => { setFreqDraft(String(Math.round(freq))) }, [freq])
  useEffect(() => { setQDraft(String(Number(resolvedQ.toFixed(2)))) }, [resolvedQ])
  const commitFreq = (): void => {
    const parsed = Math.round(Number(freqDraft))
    const next = Number.isFinite(parsed) ? Math.max(20, Math.min(20000, parsed)) : Math.round(freq)
    setFreqDraft(String(next))
    if (next !== Math.round(freq)) onShape({ freq: next })
  }
  const commitQ = (): void => {
    const parsed = Number(qDraft)
    const next = Number.isFinite(parsed) ? Math.max(0.1, Math.min(10, parsed)) : Number(resolvedQ.toFixed(2))
    setQDraft(next.toFixed(2))
    if (Math.abs(next - resolvedQ) > 0.001) onShape({ q: next })
  }
  const disabled = !ready || !enabled || unavailable
  return <div className="eq-channel" data-band={index + 1} data-unavailable={unavailable || undefined}
    title={unavailable ? '此频段达到或超出当前设备奈奎斯特频率，引擎保持直通' : Math.round(freq) + ' Hz'}>
    <span className="eq-channel-index">{index + 1}</span>
    <output className="eq-channel-value" aria-label={'频段 ' + (index + 1) + ' 增益读数'}>{dbLabel(gainDb)}<small>dB</small></output>
    <span className="eq-channel-track">
      {/* 竖向推子：0 dB 在正中（−12..+12 对称），双击回 0 —— 调音台上最常用的两个小动作。 */}
      <span className="eq-channel-zero" aria-hidden="true" />
      <input className="eq-channel-fader" type="range" min={-12} max={12} step={0.1} value={gainDb}
        aria-label={Math.round(freq) + ' Hz 增益'} aria-valuetext={dbLabel(gainDb) + ' dB'}
        disabled={disabled}
        onDoubleClick={() => onGain(0)}
        onChange={event => onGain(Number(event.target.value))} />
    </span>
    <label className="eq-channel-field">
      <input type="number" min={20} max={20000} step={1} inputMode="numeric" value={freqDraft}
        aria-label={'频段 ' + (index + 1) + ' 频率(Hz)'} disabled={disabled}
        onChange={event => setFreqDraft(event.target.value)}
        onBlur={commitFreq}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <small>Hz</small>
    </label>
    <label className="eq-channel-field">
      <input type="number" min={0.1} max={10} step={0.01} inputMode="decimal" value={qDraft}
        aria-label={'频段 ' + (index + 1) + ' Q'} disabled={disabled}
        onChange={event => setQDraft(event.target.value)}
        onBlur={commitQ}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <small>Q</small>
    </label>
    <select className="eq-channel-type" aria-label={'频段 ' + (index + 1) + ' 类型'} value={type ?? 'peaking'}
      disabled={disabled} onChange={event => onShape({ type: event.target.value as EqBandTypeName })}>
      <option value="peaking">峰值</option>
      <option value="lowShelf">低架</option>
      <option value="highShelf">高架</option>
    </select>
    <button type="button" className="eq-channel-reset" disabled={disabled}
      title="回到该段的工程网格频率与全局 Q" onClick={() => onShape({ freq: 0, q: 0 })}>复位</button>
  </div>
}

export default function FrequencyPanel({ compact = false, onExpand }: { compact?: boolean; onExpand?: () => void }) {
  const dsp = useTwilight(s => s.dsp)
  const history = useTwilight(s => s.dspHistory)
  const sampleRate = useTwilight(s => s.sampleRate)
  const capable = useTwilight(s => s.dspCapable)
  const engineUp = useTwilight(s => s.engineUp)
  const engineEpoch = useTwilight(s => s.engineEpoch)
  const command = useEqCommandStatus()
  const channelCommand = useChannelCommandStatus()
  const [showHistory, setShowHistory] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [userPresets, setUserPresets] = useState<EqPresetRecord[]>([])
  const [importNote, setImportNote] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [modelHits, setModelHits] = useState<AutoEqModelChoice[]>([])
  const [onlineBusy, setOnlineBusy] = useState(false)
  const [undoStack, setUndoStack] = useState<EqSnapshot[]>([])
  const [slots, setSlots] = useState<{ A: EqSnapshot | null; B: EqSnapshot | null }>({ A: null, B: null })
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')
  const [irPath, setIrPath] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // 用户预设走主进程（与歌单/覆盖同一类数据），不是 localStorage。
  useEffect(() => {
    let alive = true
    void window.twilight.eqPresets()
      .then(list => { if (alive) setUserPresets(list) })
      .catch(() => { /* 读不到就当没有，不阻断调音 */ })
    return () => { alive = false }
  }, [])
  const [reading, setReading] = useState(false)
  const plotShell = useRef<HTMLDivElement>(null)
  const [plotWidth, setPlotWidth] = useState(760)
  const reducedMotion = useReducedMotion()
  const [geometryDuration] = useState(() => {
    const token = getComputedStyle(document.documentElement).getPropertyValue('--dur-geom').trim()
    const value = Number.parseFloat(token)
    return Number.isFinite(value) ? value / (token.endsWith('ms') ? 1000 : 1) : 0.4
  })
  const id = useId().replace(/:/g, '')
  const ready = engineUp && capable === true && dsp !== null

  useLayoutEffect(() => {
    const shell = plotShell.current
    if (!shell) return
    const measure = (width: number): void => {
      // Hidden panels can report zero. Keep the last valid geometry until visible.
      if (Number.isFinite(width) && width > 0) setPlotWidth(width)
    }
    const styles = getComputedStyle(shell)
    measure(shell.clientWidth - (Number.parseFloat(styles.paddingLeft) || 0) - (Number.parseFloat(styles.paddingRight) || 0))
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!engineUp || capable !== true || dsp) { setReading(false); return }
    let active = true
    setReading(true)
    setReadError(null)
    void refreshDspDetails().catch(error => { if (active) setReadError(String(error.message ?? error)) })
      .finally(() => { if (active) setReading(false) })
    return () => { active = false }
  }, [engineUp, capable, dsp, engineEpoch])

  const refresh = (): void => {
    setReading(true)
    setReadError(null)
    void refreshDspDetails().catch(error => setReadError(String(error.message ?? error))).finally(() => setReading(false))
  }
  const result = useMemo(() => {
    if (!ready || !dsp || !sampleRate) return { response: null, error: null, trails: [] }
    try {
      const response = calculateResponse(dsp, sampleRate)
      const trails = showHistory && !compact ? history.slice(0, -1)
        .filter(entry => entry.sampleRate === sampleRate)
        .map(entry => ({ key: entry.key, response: calculateResponse(entry.dsp, sampleRate) })) : []
      return { response, error: null, trails }
    } catch (error) {
      return { response: null, error: error instanceof Error ? error.message : String(error), trails: [] }
    }
  }, [ready, dsp, sampleRate, history, showHistory, compact])
  const { response, trails } = result
  const draft = command.pending
  const gains = dsp?.eq.bands.map((band, index) => draft?.bandGains?.[index] ?? band.gainDb) ?? []
  const enabled = draft?.enabled ?? dsp?.eq.enabled ?? false
  const q = draft?.q ?? dsp?.eq.q ?? 1.41
  const preamp = draft?.preampDb ?? dsp?.eq.preampDb ?? 0
  const autoHeadroom = draft?.autoHeadroom ?? dsp?.eq.autoHeadroom ?? false
  // 预设名 = 当前十段增益恰好等于某个内置音色时的名字；参数/耳机预设无法用增益反推，显示「自定义」。
  const matchedTonal = TONAL_PRESETS.find(item => item.gains.every((gain, index) => gain === gains[index]))
  const presetName = matchedTonal?.name ?? '自定义'
  const irState = dsp?.ir
  // 冲激响应的频响预览：横轴对数频率、纵轴 dB，带一条 0 dB 基线。
  // 范围至少 ±6 dB，否则一条平线会被自动缩放放大成"好像有事"的形状。
  const irPlot = irState?.curve && irState.curve.length > 1
    ? (() => {
        const points = irState.curve
        let lo = Math.min(...points.map(point => point.db))
        let hi = Math.max(...points.map(point => point.db))
        const span = Math.max(6, Math.max(hi, -lo))
        lo = Math.min(lo, -span); hi = Math.max(hi, span)
        const w = 260, h = 52, pad = 3
        const px = (hz: number): number => pad + (Math.log(hz / 20) / Math.log(1000)) * (w - pad * 2)
        const py = (db: number): number => pad + ((hi - db) / Math.max(0.001, hi - lo)) * (h - pad * 2)
        return {
          width: w, height: h,
          path: points.map(point => (px(Math.min(20000, Math.max(20, point.hz))).toFixed(1) + ',' + py(point.db).toFixed(1))).join(' '),
          zero: py(0)
        }
      })()
    : null
  const change = (patch: EqPatch): void => { if (ready) eqCommands.enqueue(patch) }

  /**
   * 拖动把手：横轴改频率、纵轴改增益，两者同时生效（这就是「无极」）。
   * 每次移动都入队，由 eqCommandQueue 的 80 ms 合并兜住 —— 与滑杆走同一条路径，
   * 所以不会出现「拖拽和滑杆互相打架」的两种行为。
   */
  const [drag, setDrag] = useState<{ index: number; freq: number; gainDb: number } | null>(null)
  const dragBox = useRef<SVGSVGElement | null>(null)

  const hzAt = (clientX: number): number => {
    const box = dragBox.current?.getBoundingClientRect()
    const maxHz = response?.maxHz ?? 20000
    if (!box || box.width <= 0) return 1000
    const scale = width / box.width
    const px = (clientX - box.left) * scale
    const ratio = (px - left) / Math.max(1, right - left)
    const clamped = Math.min(0.999, Math.max(0, ratio))
    return Math.max(20, Math.min(maxHz, 20 * Math.pow(maxHz / 20, clamped)))
  }
  const dbAt = (clientY: number): number => {
    const box = dragBox.current?.getBoundingClientRect()
    if (!box || box.height <= 0) return 0
    const scale = height / box.height
    const py = (clientY - box.top) * scale
    const ratio = (py - top) / Math.max(1, bottom - top)
    return Math.max(-12, Math.min(12, maxDb - Math.min(1, Math.max(0, ratio)) * (maxDb - minDb)))
  }
  const beginDrag = (event: React.PointerEvent<SVGCircleElement>, index: number, _cx: number, _cy: number): void => {
    if (!ready || !enabled) return
    rememberOnce('拖动频段')
    event.currentTarget.setPointerCapture(event.pointerId)
    const band = dsp?.eq.bands[index]
    if (!band) return
    setDrag({ index, freq: band.freq, gainDb: band.gainDb })
  }
  const moveDrag = (event: React.PointerEvent<SVGCircleElement>, index: number): void => {
    if (!drag || drag.index !== index) return
    const freq = Math.round(hzAt(event.clientX))
    const gainDb = Math.round(dbAt(event.clientY) * 10) / 10
    setDrag({ index, freq, gainDb })
    change({ bands: Array.from({ length: index + 1 }, (_, at) => at === index ? { freq, gainDb } : {}) })
  }
  const endDrag = (): void => { setDrag(null) }
  const changeChannels = (patch: ChannelPatch): void => { if (ready) channelCommands.enqueue(patch) }

  /**
   * 当前声道状态 → 快照。旧引擎缺 CR-026 字段时按默认（off/0）补齐：
   * 恢复时写回 0 就等于旁路，不会把未知状态写成「有处理」。
   */
  const channelSnapshot = (): ChannelSnapshot => {
    const c = dsp?.channels
    if (!c) return DEFAULT_CHANNEL_SNAPSHOT
    return {
      ...DEFAULT_CHANNEL_SNAPSHOT,
      balance: c.balance,
      mono: c.mono,
      stereoWidth: c.stereoWidth,
      swapChannels: c.swapChannels,
      channelGains: [c.channelGains[0]?.gainDb ?? 0, c.channelGains[1]?.gainDb ?? 0],
      midGainDb: c.midGainDb,
      sideGainDb: c.sideGainDb,
      crossfeedEnabled: crossfeed?.enabled ?? false,
      crossfeedPreset: (crossfeed?.preset === 1 || crossfeed?.preset === 2 ? crossfeed.preset : 0),
      crossfeedFcHz: crossfeed?.fcHz ?? DEFAULT_CHANNEL_SNAPSHOT.crossfeedFcHz,
      crossfeedFeedDb: crossfeed?.feedDb ?? DEFAULT_CHANNEL_SNAPSHOT.crossfeedFeedDb,
      monoMode: c.monoMode ?? 'off',
      bandGains: c.bandGains ?? DEFAULT_CHANNEL_SNAPSHOT.bandGains,
      delayMs: c.delayMs ?? DEFAULT_CHANNEL_SNAPSHOT.delayMs
    }
  }

  /** 把快照里的声道部分整份写回引擎（set_channels 一次，0 值即旁路）。 */
  const applyChannels = (snapshot: EqSnapshot): void => {
    const channel = snapshotToChannels(snapshot)
    channelCommands.enqueue({
      balance: channel.balance,
      mono: channel.mono,
      stereoWidth: channel.stereoWidth,
      swapChannels: channel.swapChannels,
      channelGains: channel.channelGains,
      midGainDb: channel.midGainDb,
      sideGainDb: channel.sideGainDb,
      crossfeedEnabled: channel.crossfeedEnabled,
      crossfeedPreset: channel.crossfeedPreset,
      crossfeedFcHz: channel.crossfeedFcHz,
      crossfeedFeedDb: channel.crossfeedFeedDb,
      monoMode: channel.monoMode,
      bandGains: channel.bandGains,
      delayMs: channel.delayMs
    })
  }

  /** 拍一张当前状态的快照（十段一定是十段，缺的用 SPEC 默认补）。 */
  const currentSnapshot = (label: string): EqSnapshot | null => {
    if (!dsp) return null
    return snapshotOf(dsp.eq.bands, dsp.eq.preampDb, label, channelSnapshot())
  }

  /** 把当前状态压进撤销栈。应用预设/切 A/B/开始拖动前调用。 */
  const remember = (label: string): void => {
    const snapshot = currentSnapshot(label)
    if (snapshot) setUndoStack(stack => pushUndo(stack, snapshot))
  }

  /**
   * 连续编辑（滑杆、拖动把手、形状控件）的撤销点。
   *
   * 以前只有「应用预设」会压快照，所以拖了几下之后撤销按钮一直是灰的——
   * 用户说的「无法撤销」就是这个。但每动一像素压一帧也不对：一次拖动会产生
   * 上百帧，撤销变成逐像素倒退。折中是**手势级**粒度：800 ms 内只压一次，
   * 于是「拖一下」= 一步，「拖着慢慢调」也还是一步。
   */
  const lastRemember = useRef(0)
  const rememberOnce = (label: string): void => {
    const now = Date.now()
    if (now - lastRemember.current < 800) return
    lastRemember.current = now
    remember(label)
  }

  /**
   * 应用快照：直接下发，不经过 remember（否则撤销会把自己压进栈）。
   *
   * 一次恢复 = set_eq + set_channels 两条：A/B 与撤销的意义是「回到同一个可听状态」，
   * 只退一半（EQ 变了、声场没变）会制造一个从未存在过的组合。
   */
  const applySnapshot = (snapshot: EqSnapshot): void => {
    if (!ready) return
    change({ enabled: true, bands: snapshotToBands(snapshot), preampDb: snapshot.preampDb, autoHeadroom: true })
    applyChannels(snapshot)
  }

  const undoOnce = (): void => {
    if (!ready || undoStack.length === 0) return
    const { snapshot, rest } = popUndo(undoStack)
    setUndoStack(rest)
    if (snapshot) applySnapshot(snapshot)
  }

  /** A/B：切到另一边；那边还是空的就把当前状态复制过去（等于「从这里开始试」）。 */
  const switchSlot = (target: 'A' | 'B'): void => {
    if (!ready || target === activeSlot) return
    const snapshot = currentSnapshot(presetName)
    if (!snapshot) return
    const nextSlots = { ...slots, [activeSlot]: snapshot }
    const incoming = nextSlots[target] ?? snapshot
    nextSlots[target] = incoming
    setSlots(nextSlots)
    setActiveSlot(target)
    applySnapshot(incoming)
  }

  const copySlot = (): void => {
    const snapshot = currentSnapshot(presetName)
    if (!snapshot || !ready) return
    const other = activeSlot === 'A' ? 'B' : 'A'
    setSlots({ ...slots, [activeSlot]: snapshot, [other]: snapshot })
  }

  // Ctrl/Cmd+Z 撤销。输入框里不抢（用户可能在改型号名）。
  // 用 ref 拿最新实现，监听器只挂一次 —— 依赖数组为空时闭包会过期，
  // 而没有依赖数组则每次渲染都重挂一遍。
  const undoRef = useRef(undoOnce)
  undoRef.current = undoOnce
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** 应用一组参数滤波器：十个槽位全部写满，避免和上一个预设叠加。 */
  const applyFilters = (filters: EqFilter[], preampDb: number | undefined, enabled = true): void => {
    if (!ready || filters.length === 0) return
    remember(presetName)
    const patch = filtersToPatch(filters, preampDb)
    change({ enabled, bands: patch.bands.map(band => ({ ...band })), autoHeadroom: true,
      ...(preampDb !== undefined ? { preampDb } : {}) })
  }

  const applyTonal = (name: string): void => {
    const preset = TONAL_PRESETS.find(item => item.name === name)
    if (preset) applyFilters(tonalFilters(preset.gains), 0)
  }

  const importFile = async (file: File): Promise<void> => {
    setImportNote(null)
    try {
      const text = await file.text()
      const parsed = parseEqPreset(text, file.name.replace(/\.[^.]+$/, ''))
      const filters = parsed.curve.length > 0 ? fitCurveToBands(parsed.curve, 10) : parsed.filters
      if (filters.length === 0) throw new Error('这份文件里没有可用的滤波器。')
      applyFilters(filters.slice(0, 10), parsed.preampDb)
      const saved = await window.twilight.saveEqPreset({
        id: '',
        name: parsed.name,
        filters: filters.slice(0, 10),
        ...(parsed.preampDb !== undefined ? { preampDb: parsed.preampDb } : {})
      })
      setUserPresets(saved)
      const notes = [
        parsed.curve.length > 0 ? '按曲线拟合出 ' + filters.length + ' 段' : '导入 ' + filters.length + ' 段',
        ...parsed.warnings.slice(0, 3)
      ]
      setImportNote(notes.join(' · '))
    } catch (error) {
      setImportNote(error instanceof Error ? error.message : String(error))
    }
  }

  /** 型号搜索：索引在主进程（140 KB，且有 6033 个型号），输入即查。 */
  const searchModels = async (query: string): Promise<void> => {
    setModelQuery(query)
    if (!query.trim()) { setModelHits([]); return }
    try {
      setModelHits(await window.twilight.eqModelsSearch(query, 12))
    } catch { setModelHits([]) }
  }

  const fetchOnline = async (model: AutoEqModelChoice): Promise<void> => {
    if (onlineBusy) return
    setOnlineBusy(true)
    setImportNote(null)
    try {
      const preset = await window.twilight.eqHeadphoneFetch(model)
      applyFilters(preset.filters.slice(0, 10), preset.preampDb)
      const saved = await window.twilight.saveEqPreset({
        id: '',
        name: preset.name,
        ...(preset.rig ? { rig: preset.rig } : {}),
        filters: preset.filters.slice(0, 10),
        preampDb: preset.preampDb
      })
      setUserPresets(saved)
      setImportNote('已获取 ' + preset.name + '（' + preset.rig + '）· ' + preset.filters.length + ' 段')
    } catch (error) {
      setImportNote(error instanceof Error ? error.message : String(error))
    } finally {
      setOnlineBusy(false)
    }
  }

  /** CR-020：房间校正。路径在主进程选，文件由引擎自己读——几百 KB 的 WAV 不走 IPC。 */
  /**
   * 引擎重启（应用重启 / 输出设备重开）会丢掉冲激响应 —— 那是引擎内存里的状态。
   * 所以每次 engineEpoch 变化都按主进程记的偏好重新下发一次；文件不在了就只提示，
   * 不弹错误，也不假装它还生效。
   */
  useEffect(() => {
    if (!ready) return
    let alive = true
    void (async () => {
      try {
        const prefs = await window.twilight.irPrefs()
        if (!alive || !prefs || !prefs.path) return
        await engineRequest({ cmd: 'set_ir', path: prefs.path })
        setIrPath(prefs.path)
        await engineRequest({ cmd: 'set_ir', enabled: prefs.enabled, preampDb: prefs.preampDb })
        if (alive) await refreshDspDetails()
      } catch (error) {
        if (alive) setImportNote('上次载入的冲激响应没能恢复：' + (error instanceof Error ? error.message : String(error)))
      }
    })()
    return () => { alive = false }
  }, [ready, engineEpoch])

  const pickImpulse = async (): Promise<void> => {
    if (!ready) return
    const path = await window.twilight.pickImpulse()
    if (!path) return
    setImportNote(null)
    try {
      // engineRequest rejects on an engine error reply, so reaching here means
      // the engine accepted it; a silent failure would surface on the read-back.
      await engineRequest({ cmd: 'set_ir', path })
      setIrPath(path)
      await refreshDspDetails()
      await window.twilight.setIrPrefs({ path, enabled: true, preampDb: useTwilight.getState().dsp?.ir?.preampDb ?? 0 })
      setImportNote('已载入冲激响应：' + path.split(/[\\/]/).pop())
    } catch (error) {
      setImportNote(error instanceof Error ? error.message : String(error))
    }
  }
  const changeIr = (patch: { enabled?: boolean; preampDb?: number }): void => {
    if (!ready) return
    void engineRequest({ cmd: 'set_ir', ...patch })
      .catch(() => { /* 状态回读会纠正开关 */ })
    // 记下用户的选择，否则下次重启又回到默认。
    const current = useTwilight.getState().dsp?.ir
    if (current) {
      void window.twilight.setIrPrefs({
        path: irPath ?? '',
        enabled: patch.enabled ?? current.enabled,
        preampDb: patch.preampDb ?? current.preampDb
      }).catch(() => { /* 记不住不影响这次调音 */ })
    }
  }

  const removeUserPreset = (name: string): void => {
    void window.twilight.removeEqPreset(name).then(setUserPresets).catch(() => { /* 删不掉就别动 UI */ })
  }
  const changeBand = (index: number, gain: number): void => {
    const confirmed = useTwilight.getState().dsp
    if (!confirmed || !ready) return
    rememberOnce('增益 ' + (index + 1))
    const pending = eqCommands.getSnapshot().pending?.bandGains
    const next = confirmed.eq.bands.map((band, i) => i === index ? gain : pending?.[i] ?? band.gainDb)
    change({ bandGains: next })
  }
  /**
   * 改**某一段**的形状（频率 / Q / 类型）。协议是「索引对齐的稀疏补丁」：只带这一个槽位，
   * 其余 `{}` 表示保持原值，所以调一段不会把另外九段回写一遍（也不会覆盖别处的拖动）。
   */
  const changeBandShape = (index: number, patch: EqBandPatch): void => {
    if (!ready) return
    rememberOnce('频段 ' + (index + 1))
    change({ bands: Array.from({ length: index + 1 }, (_, at) => at === index ? patch : {}) })
  }
  const status = !engineUp ? '引擎未连接' : capable === false ? '引擎未提供 DSP' : !dsp ? '参数未就绪'
    : dsp.passthrough ? 'DSP 直通' : dsp.eq.enabled ? 'EQ 已启用' : 'EQ 旁路 · 增益生效'
  const empty = !engineUp ? '连接音频引擎后显示频响' : capable === false ? '当前引擎未提供均衡器'
    : !dsp ? (reading ? '正在读取均衡器参数…' : '尚未取得完整的均衡器参数')
      : !sampleRate ? '打开一首歌曲，读取设备采样率后显示频响' : result.error
  const error = command.error ?? readError ?? result.error
  const channelError = channelCommand.error
  const channels = dsp?.channels
  const crossfeed = dsp?.crossfeed
  const channelDraft = channelCommand.pending
  const midGain = channelDraft?.midGainDb ?? channels?.midGainDb ?? 0
  const sideGain = channelDraft?.sideGainDb ?? channels?.sideGainDb ?? 0
  const stereoWidth = channelDraft?.stereoWidth ?? channels?.stereoWidth ?? 1
  const crossfeedEnabled = channelDraft?.crossfeedEnabled ?? crossfeed?.enabled ?? false
  const pendingPreset = channelDraft?.crossfeedPreset
  const selectedCrossfeedPreset = pendingPreset !== undefined
    ? CROSSFEED_PRESETS[pendingPreset]
    : CROSSFEED_PRESETS.find(preset => preset.value === crossfeed?.preset)
  const crossfeedFcHz = channelDraft?.crossfeedFcHz ?? selectedCrossfeedPreset?.fcHz ?? crossfeed?.fcHz ?? 700
  const crossfeedFeedDb = channelDraft?.crossfeedFeedDb ?? selectedCrossfeedPreset?.feedDb ?? crossfeed?.feedDb ?? 4.5
  const allDb = response ? [0, ...response.points.map(point => point.db), ...trails.flatMap(trail => trail.response.points.map(point => point.db))] : [0]
  const minDb = Math.min(-12, Math.floor(Math.min(...allDb) / 6) * 6)
  const maxDb = Math.max(12, Math.ceil(Math.max(...allDb) / 6) * 6)
  const width = plotWidth
  // v6.1：完整编辑器里的频响图从 212px 抬到 320px。212 是旧版「控制台挤在 1fr 里」时的
  // 遗产，曲线和把手都太小；音频控制中心整行铺满后没有理由再压着它。
  const height = compact ? 88 : 320
  const left = Math.min(48, width * 0.2)
  const right = width - Math.min(24, width * 0.15)
  const top = compact ? 18 : 42
  const bottom = height - 27
  const x = (hz: number): number => left + Math.log(hz / 20) / Math.log((response?.maxHz ?? 20000) / 20) * (right - left)
  const y = (db: number): number => top + (maxDb - db) / (maxDb - minDb) * (bottom - top)
  const path = (curve: FrequencyResponse): string => curve.points.map((point, index) =>
    `${index ? 'L' : 'M'}${x(point.hz).toFixed(2)},${y(point.db).toFixed(2)}`).join(' ')
  const curve = response ? path(response) : ''
  const area = curve ? `${curve} L${right},${bottom} L${left},${bottom} Z` : ''
  const ticks = [20, 100, 1000, 10000, response?.maxHz ?? 20000].filter((hz, index, list) =>
    hz <= (response?.maxHz ?? 20000) && list.indexOf(hz) === index)
    .filter((hz, index, list) => index === 0 || index === list.length - 1
      || (x(hz) - x(list[index - 1]!) >= 42 && x(list.at(-1)!) - x(hz) >= 42))
  const dbTicks = compact ? [maxDb, 0, minDb] : [maxDb, maxDb / 2, 0, minDb / 2, minDb]
  const duration = reducedMotion ? 0 : geometryDuration

  return <section className={`frequency-panel${compact ? ' compact' : ''}`} aria-label="EQ 频响与均衡器">
    <div className="frequency-panel-header">
      <div>
        <span className="frequency-eyebrow">声音塑形</span>
        <h2 className="frequency-panel-title">EQ 频响</h2>
      </div>
      <div className="frequency-panel-actions">
        <span className="frequency-state-badge" data-active={dsp?.eq.enabled || undefined}>{status}</span>
        {compact && onExpand && <button className="frequency-expand" onClick={onExpand} aria-label="打开均衡器"><ArrowUpRight size={16} /></button>}
        {!compact && <button className="frequency-history-toggle" aria-pressed={showHistory}
          onClick={() => setShowHistory(value => !value)}><Waves size={15} />频响轨迹</button>}
      </div>
    </div>

    <div className="frequency-plot-shell" ref={plotShell}>
      <svg className="frequency-plot" ref={dragBox} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={response ? `EQ 频响，${sampleRate} Hz 设备，静态增益 ${dbLabel(dsp!.appliedGainDb)} dB，${status}` : empty ?? '频响暂不可用'}
        data-sample-rate={sampleRate ?? undefined} data-response-ready={!!response}>
        <defs>
          <linearGradient id={`response-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--response-fill)" stopOpacity={0.38} />
            <stop offset="100%" stopColor="var(--response-fill)" stopOpacity={0.015} />
          </linearGradient>
        </defs>
        {dbTicks.map(db => <g key={db}>
          <line className={db === 0 ? 'frequency-zero' : 'frequency-grid'} x1={left} x2={right} y1={y(db)} y2={y(db)} stroke="var(--response-grid)" />
          <text className="frequency-axis-label" x={left - 10} y={y(db) + 4} textAnchor="end">{db > 0 ? '+' : ''}{db}</text>
        </g>)}
        {ticks.map(hz => <g key={hz}>
          <line className="frequency-grid" x1={x(hz)} x2={x(hz)} y1={top} y2={bottom} stroke="var(--response-grid)" />
          <text className="frequency-axis-label" x={x(hz)} y={height - 10} textAnchor="middle">{hzLabel(hz)}</text>
        </g>)}
        <text className="frequency-axis-label" x={left - 10} y={top - 12} textAnchor="end">dB</text>
        <text className="frequency-axis-label" x={right} y={top - 12} textAnchor="end">Hz</text>
        {trails.map((trail, index) => <motion.path className="frequency-history-line" key={trail.key + index}
          d={path(trail.response)} fill="none" stroke="var(--response-line)"
          initial={false} animate={{ opacity: 0.08 + (index + 1) / trails.length * 0.3, y: -(trails.length - index) * 4 }}
          transition={{ duration }} />)}
        {response && <>
          <motion.path className="frequency-response-area" fill={`url(#response-fill-${id})`} initial={false}
            animate={{ d: area }} transition={{ duration }} />
          <motion.path className="frequency-response-line" fill="none" stroke="var(--response-line)" initial={false}
            animate={{ d: curve }} transition={{ duration }} data-gain-db={dsp!.appliedGainDb} />
          {/* 十个可拖动的把手：横拖改频率、竖拖改增益。键盘用户走下面的滑杆与形状编辑器，
              两条路改的是同一份状态，不存在只有鼠标能到达的设置。 */}
          {!compact && dsp!.eq.bands.map((band, index) => {
            const live = drag && drag.index === index ? drag : null
            const freq = live ? live.freq : band.freq
            const gainDb = live ? live.gainDb : band.gainDb
            const unavailable = !!sampleRate && freq >= sampleRate / 2
            return <circle key={index} className="frequency-marker" data-band={index + 1}
              data-unavailable={unavailable || undefined} r={drag?.index === index ? 5 : 3}
              cx={x(freq)} cy={y(gainDb)} fill="var(--response-line)"
              style={{ cursor: 'ns-resize', touchAction: 'none' }}
              onPointerDown={event => beginDrag(event, index, x(freq), y(gainDb))}
              onPointerMove={event => moveDrag(event, index)} onPointerUp={endDrag} onPointerCancel={endDrag} />
          })}
        </>}
      </svg>
      {!response && <div className="frequency-plot-empty"><Waves size={25} /><span>{empty}</span></div>}
    </div>

    <div className="frequency-footer">
      <span className="frequency-note" title="显示引擎确认的 EQ 与静态增益频响，包括已启用的重播增益；不含限幅与削波。">EQ + 前级增益</span>
      <span className="frequency-status" role="status" title={command.saving ? '曲线显示引擎已确认的参数' : undefined}>{command.saving ? '正在应用…'
        : dsp && response ? `${(sampleRate! / 1000).toLocaleString()} kHz · ${dbLabel(dsp.appliedGainDb)} dB` : '等待有效参数'}</span>
    </div>

    {!compact && <div className="frequency-controls">
      <div className="eq-toolbar">
        <label className="eq-toggle"><input type="checkbox" aria-label="EQ 开关" checked={enabled} disabled={!ready}
          onChange={event => { rememberOnce('开关'); change({ enabled: event.target.checked }) }} /><span>启用均衡器</span></label>
        <label className="eq-preset">预设<select aria-label="均衡器预设" value={presetName} disabled={!ready}
          onChange={event => {
            const value = event.target.value
            const tonal = TONAL_PRESETS.find(item => item.name === value)
            if (tonal) { applyTonal(value); return }
            if (TARGET_CURVES.some(item => item.name === value)) {
              const filters = targetToFilters(value, 10)
              if (filters.length > 0) {
                applyFilters(filters, 0)
                // 十段逼近目标曲线必然有误差，直接报出来（dB）。
                const target = TARGET_CURVES.find(item => item.name === value)!
                setImportNote(value + '：用 ' + filters.length + ' 段逼近，平均误差 ' + fitErrorDb(target.points, filters).toFixed(2) + ' dB')
              }
              return
            }
            const headphone = HEADPHONE_PRESETS.find(item => item.name === value)
            if (headphone) { applyFilters(headphone.filters.slice(0, 10), headphone.preampDb); return }
            const user = userPresets.find(item => item.name === value)
            if (user) applyFilters(user.filters.slice(0, 10), user.preampDb)
          }}>
          <option value={presetName} disabled>{presetName}</option>
          <optgroup label="内置音色">{TONAL_PRESETS.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</optgroup>
          <optgroup label="目标曲线">{TARGET_CURVES.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</optgroup>
          <optgroup label="耳机补偿">{HEADPHONE_PRESETS.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</optgroup>
          {userPresets.length > 0 ? <optgroup label="已导入">{userPresets.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</optgroup> : null}
        </select></label>
        <input ref={fileInput} type="file" accept=".txt,.csv,.json" hidden aria-label="导入均衡器预设文件"
          onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = "" }} />
        <button className="eq-reset" disabled={!ready} onClick={() => fileInput.current?.click()} title="导入 AutoEQ / Equalizer APO / CSV / JSON 预设"><Upload size={14} />导入</button>
        {userPresets.some(item => item.name === presetName) ? <button className="eq-reset" onClick={() => removeUserPreset(presetName)} title="删除这个导入的预设"><Trash2 size={14} />删除</button> : null}
        <span className="eq-online">
          <input className="eq-online-input" value={modelQuery} placeholder="搜耳机型号：hd600 / aria / xm4…" aria-label="搜索耳机型号"
            onChange={event => void searchModels(event.target.value)} />
          <button className="eq-reset" disabled={onlineBusy || modelHits.length === 0} onClick={() => modelHits[0] ? void fetchOnline(modelHits[0]) : undefined}
            title="从 AutoEQ 获取所选型号的补偿曲线"><Download size={14} />{onlineBusy ? "获取中" : "获取"}</button>
        </span>
        {modelHits.length > 0 ? <div className="eq-model-hits" role="listbox" aria-label="型号搜索结果">
          {modelHits.slice(0, 8).map(hit => <button key={hit.rig + "/" + hit.name} className="eq-model-hit" role="option" aria-selected={false}
            disabled={onlineBusy} onClick={() => void fetchOnline(hit)}>
            <span>{hit.name}</span><small className="mono">{hit.rig}</small>
          </button>)}
        </div> : null}
        <button className="eq-reset" disabled={!ready || undoStack.length === 0} onClick={undoOnce}
          title={undoStack.length > 0 ? "撤销（Ctrl+Z）· 还可退 " + undoStack.length + " 步" : "没有可撤销的步骤"}><Undo2 size={14} />撤销</button>
        <span className="eq-ab" role="group" aria-label="A/B 对比">
          <button className="eq-ab-slot" aria-pressed={activeSlot === "A"} disabled={!ready} title="切到 A（当前状态会存进 B）"
            onClick={() => switchSlot("A")}>A</button>
          <button className="eq-ab-slot" aria-pressed={activeSlot === "B"} disabled={!ready} title="切到 B（当前状态会存进 A）"
            onClick={() => switchSlot("B")}>B</button>
          <button className="eq-ab-copy" disabled={!ready} title="把当前这一边复制到另一边" onClick={copySlot}>复制</button>
        </span>
        <button className="eq-reset" disabled={!ready} onClick={() => { rememberOnce('归零'); change({ bandGains: Array(10).fill(0), preampDb: 0, q: 1.41, autoHeadroom: true }) }}>
          <RotateCcw size={14} />归零</button>
      </div>
      {/* v6.2：调音台模式 = 十路竖向推子并排，每路自带频率/Q/类型。
          旧版把 10 条 20px 窄滑杆塞进 1fr、且只有「所选频段」能改形状 —— 那就是用户说的
          「控制台被压缩」。现在每条通道都是一等公民，图上拖动仍改同一份状态。 */}
      <div className="eq-console" role="group" aria-label="十段均衡器调音台（每路可单独调整频率、增益与 Q）">
        <div className="eq-console-scale" aria-hidden="true">
          <span>+12</span><span>+6</span><span>0</span><span>−6</span><span>−12</span>
        </div>
        <div className="eq-console-bank">
          {dsp?.eq.bands.map((band, index) => {
            const outOfRange = !!sampleRate && band.freq >= sampleRate / 2
            return <EqChannel key={index} index={index} freq={band.freq} gainDb={gains[index] ?? 0}
              q={band.q ?? 0} type={band.type} globalQ={q} ready={ready} enabled={enabled} unavailable={outOfRange}
              onGain={gain => changeBand(index, gain)}
              onShape={patch => changeBandShape(index, patch)} />
          })}
        </div>
      </div>
      {importNote ? <p className="frequency-note" role="status">{importNote}</p> : null}
      <div className="eq-fine-controls">
        <label className="eq-fine-control"><span>前级增益 <output>{dbLabel(preamp)} dB</output></span>
          <input type="range" min={Math.min(-12, preamp)} max={Math.max(12, preamp)} step={0.5} value={preamp}
            aria-label="前级增益" aria-valuetext={`${preamp} dB`} disabled={!ready}
            onPointerDown={() => rememberOnce('前级增益')}
            onChange={event => change({ preampDb: Number(event.target.value) })} /></label>
        <label className="eq-fine-control"><span>频带宽度 Q <output>{q.toFixed(2)}</output></span>
          <input type="range" min={0.5} max={4} step={0.01} value={q} aria-label="频带宽度 Q" disabled={!ready || !enabled}
            onPointerDown={() => rememberOnce('全局 Q')}
            onChange={event => change({ q: Number(event.target.value) })} /></label>
        <label className="eq-checkbox"><input type="checkbox" checked={autoHeadroom} disabled={!ready}
          onChange={event => change({ autoHeadroom: event.target.checked })} /><span>自动预留增益余量</span></label>
      </div>
      <section className="sound-stage-controls" aria-label="声场控制">
        <div className="sound-stage-heading">
          <h3>声场</h3>
          <span className="frequency-status" role="status">{channelCommand.saving ? '正在应用…'
            : crossfeedEnabled || midGain !== 0 || sideGain !== 0 || stereoWidth !== 1 ? '音效已启用' : '直通'}</span>
        </div>
        <div className="sound-stage-grid">
          <label className="sound-stage-control"><span>中声道增益 <output>{dbLabel(midGain)} dB</output></span>
            <input type="range" min={-12} max={12} step={0.5} value={midGain} aria-label="中声道增益"
              aria-valuetext={`${midGain} dB`} disabled={!ready}
              onChange={event => changeChannels({ midGainDb: Number(event.target.value) })} /></label>
          <label className="sound-stage-control"><span>侧声道增益 <output>{dbLabel(sideGain)} dB</output></span>
            <input type="range" min={-12} max={12} step={0.5} value={sideGain} aria-label="侧声道增益"
              aria-valuetext={`${sideGain} dB`} disabled={!ready}
              onChange={event => changeChannels({ sideGainDb: Number(event.target.value) })} /></label>
          <label className="sound-stage-control"><span>立体声宽度 <output>{stereoWidth.toFixed(2)}</output></span>
            <input type="range" min={0} max={2} step={0.05} value={stereoWidth} aria-label="立体声宽度"
              disabled={!ready} onChange={event => changeChannels({ stereoWidth: Number(event.target.value) })} /></label>
          <label className="eq-checkbox sound-stage-toggle"><input type="checkbox" checked={crossfeedEnabled}
            aria-label="耳机交叉馈送" disabled={!ready}
            onChange={event => changeChannels({ crossfeedEnabled: event.target.checked })} /><span>耳机交叉馈送</span></label>
          <label className="sound-stage-select">预设<select aria-label="交叉馈送预设" value={selectedCrossfeedPreset?.value ?? 'custom'}
            disabled={!ready} onChange={event => {
              const preset = Number(event.target.value)
              if (preset >= 0 && preset <= 2) changeChannels({ crossfeedPreset: preset as 0 | 1 | 2 })
            }}>
            <option value="custom" disabled>自定义</option>
            {CROSSFEED_PRESETS.map(preset => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          </select></label>
          <label className="sound-stage-control"><span>交叉频率 <output>{Math.round(crossfeedFcHz)} Hz</output></span>
            <input type="range" min={100} max={4000} step={10} value={crossfeedFcHz} aria-label="交叉频率"
              disabled={!ready || !crossfeedEnabled} onChange={event => changeChannels({ crossfeedFcHz: Number(event.target.value) })} /></label>
          <label className="sound-stage-control"><span>交叉强度 <output>{dbLabel(crossfeedFeedDb)} dB</output></span>
            <input type="range" min={0} max={12} step={0.5} value={crossfeedFeedDb} aria-label="交叉强度"
              disabled={!ready || !crossfeedEnabled} onChange={event => changeChannels({ crossfeedFeedDb: Number(event.target.value) })} /></label>
        </div>
        {channelError && <p className="eq-error" role="alert">{channelError}</p>}
      </section>
      <section className="sound-stage-controls" aria-label="房间校正">
        <h3>房间校正</h3>
        <div className="sound-stage-row">
          <label className="eq-toggle"><input type="checkbox" checked={!!irState?.enabled} disabled={!ready || !irState?.loaded}
            onChange={event => changeIr({ enabled: event.target.checked })} />启用 FIR</label>
          <button className="eq-reset" disabled={!ready} onClick={() => void pickImpulse()}>载入冲激响应…</button>
          <label className="eq-fine-field"><span>电平</span>
            <input type="range" min={-24} max={24} step={0.5} value={irState?.preampDb ?? 0}
              aria-label="冲激响应电平" disabled={!ready || !irState?.loaded}
              onChange={event => changeIr({ preampDb: Number(event.target.value) })} />
            <output>{(irState?.preampDb ?? 0).toFixed(1)} dB</output></label>
        </div>
        {irPlot ? <svg className="ir-curve" viewBox={`0 0 ${irPlot.width} ${irPlot.height}`} width="100%" height={irPlot.height}
          role="img" aria-label="冲激响应频响预览">
          <line x1="3" x2={irPlot.width - 3} y1={irPlot.zero} y2={irPlot.zero} className="ir-curve-zero" />
          <polyline points={irPlot.path} className="ir-curve-line" />
        </svg> : null}
        <p className="frequency-note">
          {irState?.loaded
            ? `${irState.name ?? '冲激响应'} · ${irState.taps ?? 0} 抽头 · ${irState.channels ?? 1} 声道 · ${irState.sampleRate ?? 0} Hz · 延迟 ${(((irState.latencyFrames ?? 0) / Math.max(1, irState.sampleRate ?? 48000)) * 1000).toFixed(1)} ms · 峰值 ${(irState.maxGainDb ?? 0).toFixed(1)} dB（电平已自动补偿）`
            : '还没有冲激响应。载入一个 WAV（REW / AutoEQ / 房间测量的导出）即可做卷积校正。'}
        </p>
      </section>
      {showHistory && <p className="frequency-note" title="历史曲线向上错位排列；当前曲线对应坐标刻度，不代表音频频谱。">最近 {history.length} 次调节 · 亮线为当前频响</p>}
      {(error || !dsp) && <div className="eq-error" role={error ? 'alert' : undefined}>
        <span>{error ?? '完整参数尚未就绪'}</span>
        <button onClick={refresh} disabled={!engineUp || reading}>{reading ? '读取中…' : '重新读取'}</button>
      </div>}
    </div>}
    {compact && error && <p className="eq-error" role="alert">{error}</p>}
  </section>
}