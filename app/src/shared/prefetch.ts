/**
 * 下一首预热的 IPC 返回形状（main / preload / renderer 共用一份）。
 *
 * 放在 shared 而不是各自声明：这类跨进程返回值最容易出现「preload 的 d.ts 说
 * available 而 main 返回别的字段」的静默漂移，共用类型让漂移在 typecheck 阶段暴露。
 */
export interface PrefetchResult {
  ok: boolean
  /** 实际读进内存（并因此进入 OS 页缓存）的字节数。 */
  bytes: number
  ms: number
  /** 失败原因（中文，可直接显示给用户）；ok=true 时不出现。 */
  error?: string
  /** true = 被下一次预热/取消打断；已经读到的字节仍然有效。 */
  cancelled?: boolean
}
