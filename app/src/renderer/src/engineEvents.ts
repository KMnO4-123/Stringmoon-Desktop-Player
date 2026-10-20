import type { EngineEvent } from '@shared/protocol'

/**
 * 引擎事件的单一分发点。
 *
 * 为什么需要：以前 App 与 C1Light 各自 `window.twilight.onEvent(...)` —— 每条事件
 * （position 20Hz、meter ~70Hz、state/scan）进渲染层都要跑两份 ipcRenderer 监听。
 * 这里只挂一个底层监听，再分发给订阅者：新增消费者不再增加 IPC 层回调，
 * 最后一个订阅者离开时把底层监听拆掉。
 */
type EngineEventListener = (event: EngineEvent) => void

const listeners = new Set<EngineEventListener>()
let detach: (() => void) | null = null

export function subscribeEngineEvent(listener: EngineEventListener): () => void {
  listeners.add(listener)
  detach ??= window.twilight.onEvent((event) => {
    // 用拷贝遍历：监听器里增删订阅不会影响本次分发（C1Light 的挂/摘可能发生在事件回调里）。
    for (const entry of [...listeners]) entry(event)
  })
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && detach) {
      detach()
      detach = null
    }
  }
}
