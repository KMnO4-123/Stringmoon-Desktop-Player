/**
 * 播放记忆（对标 ECHO NEXT 的 echo-playback-memory.json）。
 *
 * 目标：下次启动能给出「继续上次」入口，恢复成**已加载、暂停**的状态 ——
 * 绝不自动出声。所以这里只描述「上次听到哪里」，不描述「应该开始播放」。
 *
 * 两条纪律：
 *  1. **路径是身份**：引擎的 trackId 只在本代 catalog 里有意义（重扫会换 id），
 *     而 filePath 跨重启稳定，所以恢复以 filePath 为准、trackId 只作辅助；
 *  2. 渲染层传来的 patch 一律不可信：逐字段 sanitize，认不出的字段直接忽略，
 *     不允许它把记忆写成非法状态（例如相对路径、NaN 位置、超长队列）。
 */
import { isAbsoluteWindowsPath, isSupportedAudioPath } from './file-path'

export type PlaybackRepeatMode = 'sequential' | 'one' | 'all' | 'shuffle'

export interface PlaybackMemory {
  version: 1
  /** 上次播放的本地文件绝对路径（在线曲目为空串：在线播放不参与恢复）。 */
  filePath: string
  /** 引擎 trackId（只在本代 catalog 有效；恢复时若失效由渲染层按 filePath 兜底）。 */
  trackId: string
  positionMs: number
  durationMs: number
  /** 当时的可见队列（trackId 列表），恢复后可据此重建上下曲。 */
  queue: string[]
  repeatMode: PlaybackRepeatMode
  updatedAt: number
}

const REPEAT_MODES: readonly PlaybackRepeatMode[] = ['sequential', 'one', 'all', 'shuffle']
const MAX_POSITION_MS = 24 * 60 * 60 * 1000
const MAX_QUEUE = 500

/** 位置/时长按 24h 封顶（坏数据不能把进度条撑到宇宙）。 */
const finiteNonNegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_POSITION_MS) : null

/** 时间戳是 epoch 毫秒，量级 1.7e12 —— 不能套用位置的 24h 封顶。 */
const finiteTimestamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : null

const repeatModeOf = (value: unknown): PlaybackRepeatMode | null =>
  typeof value === 'string' && (REPEAT_MODES as readonly string[]).includes(value) ? value as PlaybackRepeatMode : null

/** 队列只保留合法本地路径（trackId 在恢复时没有意义，但先按字符串保留以便重建顺序）。 */
function queueOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_QUEUE)) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * 从磁盘 JSON / IPC patch 归一出一份合法记忆。
 *
 * 返回 null = 这份数据整体不可用（坏文件、版本不对、既没有路径也没有 trackId）。
 * 单个字段不合法不会毁掉整份记忆：那种情况按「没有这个字段」处理更接近用户预期。
 */
export function sanitizePlaybackMemory(raw: unknown): PlaybackMemory | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return null
  const filePath = typeof record.filePath === 'string' && isSupportedAudioPath(record.filePath) ? record.filePath : ''
  const trackId = typeof record.trackId === 'string' && record.trackId.length <= 64 && /^[\w.-]*$/.test(record.trackId)
    ? record.trackId : ''
  // 既没有可恢复的本地文件、也没有曲目 id：这条记忆没有任何恢复价值。
  if (!filePath && !trackId) return null
  return {
    version: 1,
    filePath,
    trackId,
    positionMs: finiteNonNegative(record.positionMs) ?? 0,
    durationMs: finiteNonNegative(record.durationMs) ?? 0,
    queue: queueOf(record.queue) ?? [],
    repeatMode: repeatModeOf(record.repeatMode) ?? 'sequential',
    updatedAt: finiteTimestamp(record.updatedAt) ?? 0
  }
}

/**
 * 把渲染层/引擎事件送来的 patch 合并进当前记忆。
 * - 未出现的字段保持原值（渲染层只需要报它知道的那部分）；
 * - 出现但非法的字段被忽略（不是整条作废）；
 * - 合并后 updatedAt 由调用方（主进程）刷新。
 */
export function mergePlaybackMemory(current: PlaybackMemory | null, patch: unknown): PlaybackMemory | null {
  const base: PlaybackMemory = current ?? {
    version: 1, filePath: '', trackId: '', positionMs: 0, durationMs: 0, queue: [], repeatMode: 'sequential', updatedAt: 0
  }
  if (!patch || typeof patch !== 'object') return current
  const record = patch as Record<string, unknown>
  const next: PlaybackMemory = { ...base, queue: [...base.queue] }
  if ('filePath' in record) {
    next.filePath = typeof record.filePath === 'string' && isSupportedAudioPath(record.filePath) ? record.filePath : base.filePath
  }
  if ('trackId' in record) {
    next.trackId = typeof record.trackId === 'string' && record.trackId.length <= 64 && /^[\w.-]*$/.test(record.trackId) ? record.trackId : base.trackId
  }
  if ('positionMs' in record) {
    const value = finiteNonNegative(record.positionMs)
    if (value !== null) next.positionMs = value
  }
  if ('durationMs' in record) {
    const value = finiteNonNegative(record.durationMs)
    if (value !== null) next.durationMs = value
  }
  if ('queue' in record) {
    const value = queueOf(record.queue)
    if (value !== null) next.queue = value
  }
  if ('repeatMode' in record) {
    const value = repeatModeOf(record.repeatMode)
    if (value !== null) next.repeatMode = value
  }
  if (!next.filePath && !next.trackId) return null
  return next
}

/** 播放恢复只需要「本地文件 + 可见队列」，不恢复在线曲目。 */
export function canRestoreMemory(memory: PlaybackMemory | null): memory is PlaybackMemory {
  return Boolean(memory && memory.filePath && isAbsoluteWindowsPath(memory.filePath))
}
