/**
 * 高频播放进度仓（REFS-B E1.3）：position 每 250ms 一跳，不能放进全局 store
 * 推动整棵树重渲染——独立的可订阅快照，只有播放栏与歌词视图订阅它。
 * 权威来源仍是引擎的 position 事件（应用不自行外插）。
 */
export interface PositionSnapshot {
  positionMs: number
  durationMs: number
  trackId: string | null
}

let snapshot: PositionSnapshot = { positionMs: 0, durationMs: 0, trackId: null }
const listeners = new Set<() => void>()

export function getPosition(): PositionSnapshot {
  return snapshot
}

export function setPosition(next: Partial<PositionSnapshot>): void {
  const updated = { ...snapshot, ...next }
  if (updated.positionMs === snapshot.positionMs && updated.durationMs === snapshot.durationMs && updated.trackId === snapshot.trackId) return
  snapshot = updated
  for (const l of listeners) l()
}

export function subscribePosition(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 隐藏时断开歌词订阅；恢复只读最新引擎快照，不累积本地时间。 */
export function subscribeVisiblePosition(listener: () => void): () => void {
  const visibility = document
  let unsubscribe: (() => void) | null = null
  const update = (): void => {
    if (visibility.hidden) {
      unsubscribe?.()
      unsubscribe = null
    } else if (!unsubscribe) {
      unsubscribe = subscribePosition(listener)
      listener()
    }
  }
  if (!visibility.hidden) unsubscribe = subscribePosition(listener)
  visibility.addEventListener('visibilitychange', update)
  return () => {
    unsubscribe?.()
    visibility.removeEventListener('visibilitychange', update)
  }
}

/** 非高频字段（durationMs）也在此镜像一份，供订阅方单点读取 */
export function resetPosition(trackId: string | null, durationMs: number): void {
  setPosition({ positionMs: 0, durationMs, trackId })
}
