/**
 * 把「事件驱动的绘制」合并到下一次动画帧。
 *
 * 引擎现在每 16 ms 左右推一帧 meter（实测 65 帧/秒），而显示器刷新是 60/120/144 Hz ——
 * 两者不同频。直接在每个事件里写 DOM 会出现「一帧里画两次、下一帧空着」，
 * 看起来就是抖动。合并之后：一帧最多画一次，且与显示器同相。
 */
export function createFrameDraw(draw: () => void): { request: () => void; cancel: () => void } {
  let handle = 0
  return {
    request(): void {
      if (handle) return
      handle = requestAnimationFrame(() => {
        handle = 0
        draw()
      })
    },
    cancel(): void {
      if (handle) {
        cancelAnimationFrame(handle)
        handle = 0
      }
    }
  }
}
