import type { ChannelBandGains, EqBandTypeName, MonoMode } from '@shared/protocol'
import { EQ_BAND_FREQUENCY } from '@shared/eq-bands'

/**
 * EQ 快照与撤销栈（纯函数）。
 *
 * 为什么撤销要按「快照」而不是按「一步操作」：
 * 滑杆一次拖动会产生几十条 set_eq（命令队列 80 ms 合并后仍有若干条），
 * 按操作回退会让 Ctrl+Z 变成「往回退 3 毫秒」。快照是以**预设/一次拖动**为粒度拍的，
 * 回退一次就是退回上一个听得出来的状态。
 */

export interface EqBandSnapshot {
  freq: number
  gainDb: number
  q: number
  type: EqBandTypeName
}

/**
 * 声道工具快照（A/B 与撤销要连声场一起回退）。
 *
 * 为什么连声道一起快照：A/B 的意义是「同一段音乐下比较两套设置」；如果 A/B 只切 EQ、
 * 声场卡在最后一次手动值，两次试听就不是同一个变量。撤销同理 —— 用户拖了声道增益后
 * 按 Ctrl+Z，只退 EQ 会制造一个从未存在过的组合。
 *
 * 全部字段给默认值：旧引擎不返回这些字段时，快照仍可完整恢复（0/off = 旁路）。
 */
export interface ChannelSnapshot {
  balance: number
  mono: boolean
  stereoWidth: number
  swapChannels: boolean
  channelGains: [number, number]
  midGainDb: number
  sideGainDb: number
  crossfeedEnabled: boolean
  crossfeedPreset: 0 | 1 | 2
  crossfeedFcHz: number
  crossfeedFeedDb: number
  monoMode: MonoMode
  bandGains: ChannelBandGains
  delayMs: [number, number]
}

export interface EqSnapshot {
  bands: EqBandSnapshot[]
  preampDb: number
  label: string
  /** 拍快照时的声道工具状态；省略 = 旧调用方只关心 EQ（A/B/撤销会补默认值）。 */
  channels?: ChannelSnapshot
}

export const DEFAULT_CHANNEL_SNAPSHOT: ChannelSnapshot = {
  balance: 0, mono: false, stereoWidth: 1, swapChannels: false, channelGains: [0, 0],
  midGainDb: 0, sideGainDb: 0, crossfeedEnabled: false, crossfeedPreset: 0, crossfeedFcHz: 700, crossfeedFeedDb: 4.5,
  monoMode: 'off', bandGains: { low: [0, 0], mid: [0, 0], high: [0, 0] }, delayMs: [0, 0]
}

/** 从引擎回报的状态拍一张快照。缺失的字段用 SPEC 默认值补齐，保证永远是十段。 */
export function snapshotOf(
  bands: ReadonlyArray<{ freq: number; gainDb: number; q?: number; type?: EqBandTypeName }>,
  preampDb: number,
  label: string,
  channels?: Partial<ChannelSnapshot>
): EqSnapshot {
  const out: EqBandSnapshot[] = []
  for (let index = 0; index < EQ_BAND_FREQUENCY.length; index++) {
    const band = bands[index]
    out.push({
      freq: band?.freq ?? EQ_BAND_FREQUENCY[index]!,
      gainDb: band?.gainDb ?? 0,
      q: band?.q ?? 1.41,
      type: band?.type ?? 'peaking'
    })
  }
  return { bands: out, preampDb, label, channels: { ...DEFAULT_CHANNEL_SNAPSHOT, ...channels } }
}

/** 撤销快照上限：本轮口径 20（超出后丢最旧的一条）。 */
export const MAX_UNDO = 20

/** 入栈。相同的快照不重复入栈 —— 否则连按两次「应用同一个预设」要按两次撤销才动。 */
export function pushUndo(stack: EqSnapshot[], snapshot: EqSnapshot): EqSnapshot[] {
  const last = stack[stack.length - 1]
  if (last && sameSnapshot(last, snapshot)) return stack
  const next = [...stack, snapshot]
  return next.length > MAX_UNDO ? next.slice(next.length - MAX_UNDO) : next
}

export function popUndo(stack: EqSnapshot[]): { snapshot: EqSnapshot | null; rest: EqSnapshot[] } {
  if (stack.length === 0) return { snapshot: null, rest: stack }
  return { snapshot: stack[stack.length - 1]!, rest: stack.slice(0, -1) }
}

export function sameSnapshot(a: EqSnapshot, b: EqSnapshot): boolean {
  if (a.bands.length !== b.bands.length) return false
  if (a.preampDb !== b.preampDb) return false
  if (JSON.stringify(a.channels ?? DEFAULT_CHANNEL_SNAPSHOT) !== JSON.stringify(b.channels ?? DEFAULT_CHANNEL_SNAPSHOT)) return false
  for (let index = 0; index < a.bands.length; index++) {
    const x = a.bands[index]!
    const y = b.bands[index]!
    if (x.type !== y.type) return false
    if (x.freq !== y.freq || x.gainDb !== y.gainDb || x.q !== y.q) return false
  }
  return true
}

/** 快照 → 一次性的 set_channels 补丁（声道工具全部显式写回，避免与上一个状态叠加）。 */
export function snapshotToChannels(snapshot: EqSnapshot): ChannelSnapshot {
  return { ...DEFAULT_CHANNEL_SNAPSHOT, ...snapshot.channels }
}

/** 快照 → 一次性的 set_eq 补丁（十段写满，避免与上一个状态叠加）。 */
export function snapshotToBands(snapshot: EqSnapshot): Array<{ freq: number; gainDb: number; q: number; type: EqBandTypeName }> {
  return snapshot.bands.map(band => ({ freq: band.freq, gainDb: band.gainDb, q: band.q, type: band.type }))
}

/** 给人看的一句话，用在工具栏的悬浮说明上。 */
export function describeSnapshot(snapshot: EqSnapshot): string {
  const lows = snapshot.bands[0]?.gainDb ?? 0
  const highs = snapshot.bands[snapshot.bands.length - 1]?.gainDb ?? 0
  return snapshot.label + '（低频 ' + lows.toFixed(1) + ' dB · 高频 ' + highs.toFixed(1) + ' dB）'
}