/**
 * 实时电平监测仓（DSP-B-app §4.1 + CR-015）。
 *
 * 与 positionStore 同一条纪律：30 Hz 的数据**不进全局 store**，否则每一帧都推动整棵树重渲染。
 * 权威来源仍是引擎的 ev:'meter'（应用不自行外插、不自己算衰减曲线 —— CR-015 明确峰值保持与衰减
 * 由引擎侧算好，两边各算一条会互相打架）。
 *
 * 两处对外部事实的**假设**，都集中在下面的常量里，引擎落地时若口径不同只改这里：
 *  1. spectrum 的值按 dB 处理；
 *  2. 频段是 20 Hz–20 kHz 的等对数间距（与 EQ 图同一根频轴）。
 * CR-015 没规定这两点，所以在 contract-requests.md 的裁定里已请引擎确认。
 */

import { reportMeterDemand } from './meterDemand'

export interface MeterSnapshot {
  /** 是否收到过至少一帧 —— 没收到过就不画任何曲线（画一条平的等于宣称「此刻静音」）。 */
  hasData: boolean
  spectrum: readonly number[]
  rmsDb: readonly number[]
  peakDb: readonly number[]
  peakHoldDb: readonly number[]
  truePeakDb: readonly number[]
  truePeakBasis: 'oversampled' | 'sample' | null
  lufsMomentary: number | null
  gainReductionDb: number | null
}

/** 频谱的显示范围（dB）。固定不自动缩放：会自己跳动的纵轴没法当监测看。 */
export const SPECTRUM_MIN_DB = -72
export const SPECTRUM_MAX_DB = 0
export const SPECTRUM_MIN_HZ = 20
export const SPECTRUM_MAX_HZ = 20000

const empty: MeterSnapshot = {
  hasData: false,
  spectrum: [],
  rmsDb: [],
  peakDb: [],
  peakHoldDb: [],
  truePeakDb: [],
  truePeakBasis: null,
  lufsMomentary: null,
  gainReductionDb: null
}

let snapshot: MeterSnapshot = empty
let receivedAt = 0
const listeners = new Set<() => void>()

export function meterReceivedAt(): number { return receivedAt }

export function getMeter(): MeterSnapshot {
  return snapshot
}

export function subscribeMeter(listener: () => void): () => void {
  listeners.add(listener)
  // A5：监听器数量 0→>0 立刻告诉主进程「现在真有消费者」，让它恢复 meter 分析与推送。
  reportMeterDemand(true)
  return () => {
    listeners.delete(listener)
    // >0→0 由 meterDemand 侧去抖 400ms 再上报，避免视图切换退场瞬间反复开关。
    if (listeners.size === 0) reportMeterDemand(false)
  }
}

/** 不可见时断开订阅；恢复时读最新一帧，不补算中间过程。 */
export function subscribeVisibleMeter(listener: () => void): () => void {
  const visibility = document
  let unsubscribe: (() => void) | null = null
  const update = (): void => {
    if (visibility.hidden) {
      unsubscribe?.()
      unsubscribe = null
    } else if (!unsubscribe) {
      unsubscribe = subscribeMeter(listener)
      listener()
    }
  }
  if (!visibility.hidden) unsubscribe = subscribeMeter(listener)
  visibility.addEventListener('visibilitychange', update)
  return () => {
    unsubscribe?.()
    visibility.removeEventListener('visibilitychange', update)
  }
}

const finiteNumbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every(entry => typeof entry === 'number' && Number.isFinite(entry)) ? value as number[] : null
const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * 消费一帧 meter 事件。**形状不对就整帧丢弃、保留上一帧**：
 * 半帧数据画出来的曲线比没有曲线更容易被当真。
 */
export function applyMeterFrame(event: unknown): boolean {
  if (event === null || typeof event !== 'object') return false
  const e = event as Record<string, unknown>
  const spectrum = finiteNumbers(e.spectrum)
  if (!spectrum || spectrum.length === 0) return false
  const basis = e.truePeakBasis === 'oversampled' || e.truePeakBasis === 'sample' ? e.truePeakBasis : null
  const next: MeterSnapshot = {
    hasData: true,
    spectrum,
    rmsDb: finiteNumbers(e.rmsDb) ?? [],
    peakDb: finiteNumbers(e.peakDb) ?? [],
    peakHoldDb: finiteNumbers(e.peakHoldDb) ?? [],
    truePeakDb: finiteNumbers(e.truePeakDb) ?? [],
    truePeakBasis: basis,
    lufsMomentary: finiteOrNull(e.lufsMomentary),
    gainReductionDb: finiteOrNull(e.gainReductionDb)
  }
  snapshot = next
  receivedAt = performance.now()
  for (const l of listeners) l()
  return true
}

/** 换曲/断连时清空：上一首的频谱继续挂着就是谎称它属于这一首。 */
export function resetMeter(): void {
  if (!snapshot.hasData) return
  snapshot = empty
  receivedAt = 0
  for (const l of listeners) l()
}

/** 第 index 个频段的中心频率（等对数间距，与 EQ 图同一根频轴）。 */
export function bandHz(index: number, count: number): number {
  if (count <= 1) return SPECTRUM_MIN_HZ
  return SPECTRUM_MIN_HZ * Math.pow(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ, index / (count - 1))
}
