import type { LoudnessScanData, LoudnessTrackResult } from '@shared/protocol'
import { subscribeEngineEvent } from '../engineEvents'
import { engineRequest } from '../ipc'
import { useTwilight } from '../store'

/**
 * 响度归一化（ReplayGain）接线 —— 对标 ECHO NEXT 的 ReplayGain。
 *
 * 设计取舍（为什么默认关闭）：
 *  - ReplayGain 会改变听感（按曲目响度对齐），不能替用户默认打开；
 *  - 首次扫描要解码整首（引擎侧有磁盘缓存，第二次起 ~1ms），所以只在用户开启后
 *    对**正在播放且没扫过**的曲目做一次 async 扫描，不做全库批量扫描；
 *  - 测量与应用分离：analyze_loudness 只读，loudness_done 拿到 gainDb/peakLinear
 *    后才发 set_replaygain；防削波用引擎给的**真峰值**（peakLinear），不用 sample peak。
 *
 * 失败静默：扫描失败（文件损坏/太短/太安静）只放弃这一首，不弹协议错误 ——
 * 这是可选的听感功能，不该打断播放。
 */

const STORAGE_KEY = 'stringmoon.replaygain'
const readEnabled = (): boolean => { try { return globalThis.localStorage?.getItem(STORAGE_KEY) === 'on' } catch { return false } }

export interface ReplayGainSnapshot {
  enabled: boolean
  /** 本会话已经拿到增益的曲目数。 */
  analysed: number
  /** 扫描进度（仅引擎的 loudness_progress 事件更新；不参与 React 高频路径）。 */
  scanning: { done: number; total: number } | null
  /** 当前曲目实际应用的增益（来自引擎 state.dsp.replayGain，权威）。 */
  lastGainDb: number | null
  lastTrackId: string | null
}

let enabled = readEnabled()
let snapshot: ReplayGainSnapshot = { enabled, analysed: 0, scanning: null, lastGainDb: null, lastTrackId: null }
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of [...listeners]) listener() }
const update = (patch: Partial<ReplayGainSnapshot>): void => { snapshot = { ...snapshot, ...patch }; publish() }

/** 本会话已拿到的增益（trackId → 文件级数值）。缓存命中时扫描是瞬时的，但仍要一次命令。 */
const knownGain = new Map<string, { gainDb: number; peakLinear?: number }>()
/** 已经在扫描中的曲目（防重复请求）。 */
const scanning = new Set<string>()
/** replyId → trackId：异步扫描完成事件靠它对上号。 */
const pending = new Map<number, string>()
let started = false

const gainOf = (entry: LoudnessTrackResult | undefined): { gainDb: number; peakLinear?: number } | null => {
  if (!entry || entry.ok !== true || typeof entry.gainDb !== 'number' || !Number.isFinite(entry.gainDb)) return null
  return { gainDb: entry.gainDb, ...(typeof entry.peakLinear === 'number' && Number.isFinite(entry.peakLinear) ? { peakLinear: entry.peakLinear } : {}) }
}

/** 把已知增益应用到引擎（mode=track；preamp 固定 0，避免双重增益）。 */
async function applyGain(trackId: string): Promise<void> {
  const gain = knownGain.get(trackId)
  if (!gain) return
  try {
    await engineRequest({
      cmd: 'set_replaygain',
      mode: 'track',
      trackGainDb: gain.gainDb,
      preampDb: 0,
      ...(gain.peakLinear !== undefined ? { trackPeak: gain.peakLinear } : {}),
      preventClip: true
    }, 15000)
    update({ lastGainDb: gain.gainDb, lastTrackId: trackId })
  } catch { /* 应用失败：下一次切歌/开关再试；不弹协议错误 */ }
}

/** 对当前正在播放的曲目决定「直接应用 / 先扫描 / 跳过」。 */
function evaluateCurrentTrack(): void {
  if (!enabled) return
  const state = useTwilight.getState()
  const trackId = state.loadedTrackId
  if (!trackId || state.playState !== 'playing') return
  const known = knownGain.get(trackId)
  if (known) { void applyGain(trackId); return }
  if (scanning.has(trackId)) return
  scanning.add(trackId)
  // 单曲 async 扫描：命中缓存即时完成；首扫在后台分片进行，不阻塞播放。
  void engineRequest<{ accepted?: boolean; total?: number; replyId?: number }>(
    { cmd: 'analyze_loudness', trackIds: [trackId], async: true }, 20000
  ).then(reply => {
    if (typeof reply?.replyId === 'number') pending.set(reply.replyId, trackId)
  }).catch(() => { scanning.delete(trackId) })
}

function onLoudnessDone(replyId: number, data: LoudnessScanData): void {
  const trackId = pending.get(replyId)
  pending.delete(replyId)
  if (!trackId) return
  scanning.delete(trackId)
  const entry = data.tracks.find(track => track.trackId === trackId)
  const gain = gainOf(entry)
  if (!gain) return // 太短/太安静/读不了：静默放弃这一首
  knownGain.set(trackId, gain)
  update({ analysed: knownGain.size })
  // 只有「仍然是当前正在播放的曲目」才应用：扫描期间用户可能已经切歌。
  const state = useTwilight.getState()
  if (state.loadedTrackId === trackId && state.playState === 'playing') void applyGain(trackId)
}

/** 开启/关闭（乐观持久化；关闭时立即把引擎增益归零）。 */
export function setReplayGainEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next ? 'on' : 'off') } catch { /* 本次会话仍然有效 */ }
  update({ enabled: next, ...(next ? {} : { scanning: null }) })
  if (!next) {
    void engineRequest({ cmd: 'set_replaygain', mode: 'off' }, 15000).catch(() => { })
    return
  }
  evaluateCurrentTrack()
}

/** 关闭 ReplayGain：退出/用户关闭开关时用（与 setReplayGainEnabled(false) 等价）。 */
export function disableReplayGain(): void { setReplayGainEnabled(false) }

export const replayGain = {
  getSnapshot: (): ReplayGainSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
}

/**
 * 挂上事件与状态订阅（App 启动时调一次）。
 * - loudness_progress：只更新「已扫 N/M」的显示；
 * - loudness_done：配对 replyId，缓存增益并在仍是当前曲目时应用；
 * - store：切歌/开始播放时决定扫描或应用（只在开启后生效）。
 */
export function startReplayGain(): void {
  if (started) return
  started = true
  subscribeEngineEvent((event) => {
    if (event.ev === 'loudness_progress') {
      if (enabled) update({ scanning: { done: event.done, total: event.total } })
      return
    }
    if (event.ev === 'loudness_done') {
      if (enabled) onLoudnessDone(event.replyId, event.data)
    }
  })
  useTwilight.subscribe((next, previous) => {
    if (!enabled) return
    if (next.loadedTrackId !== previous.loadedTrackId || next.playState !== previous.playState) evaluateCurrentTrack()
    // 引擎权威的 replayGain 值随 dsp 到达：用它刷新「当前实际增益」（不用我们的请求值冒充）。
    const rg = next.dsp?.replayGain
    if (rg && rg.mode === 'track' && Number.isFinite(rg.trackGainDb)) update({ lastGainDb: rg.trackGainDb })
  })
  if (enabled) evaluateCurrentTrack()
}
