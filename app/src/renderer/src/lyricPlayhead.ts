/**
 * 歌词填充用的**视觉播放头**。
 *
 * 依据（项目自己的规矩，不是我拍）：
 *  - REFS-B-app：**可以**做轻量补间显示，但**必须能被真实状态纠正**；
 *  - DESIGN-v3-signal：用 requestAnimationFrame 节流到显示刷新率，而不是每个 position 事件都动；
 *  - 同时所有**数字**（时间、进度）仍取权威值，不外插（handoff：参数台不做本地时间外插）。
 *
 * 为什么需要它：引擎的 position 实测约 9–10 Hz，而逐字填充按事件跳变时一顿一顿
 * （一个字 350ms，中间只落 2–3 格）。这里在**两次权威采样之间**按时间线性推进，
 * 新事件一到就**直接对齐**（不做平滑追赶 —— 那会引入滞后，宁可跳一下也不慢半拍）。
 */
/** 补间上限：事件迟到时**冻结**而不是继续跑 —— 宁可停住，也不谎报已经唱到哪。 */
export const MAX_EXTRAPOLATION_MS = 400

let anchorMs = 0
let anchorAt = 0
let running = false

/** 每个权威 position 事件都调用一次（播放栏与歌词共用同一个 positionStore 的通知）。 */
export function anchorPlayhead(positionMs: number, playing: boolean, now: number = performance.now()): void {
  anchorMs = positionMs
  anchorAt = now
  running = playing
}

/** 当前视觉时刻。暂停/未播放时就是最后一次权威值。 */
export function playheadMs(now: number = performance.now()): number {
  if (!running) return anchorMs
  return anchorMs + Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, now - anchorAt))
}

/** 测试与换曲用：清空锚点。 */
export function resetPlayhead(): void {
  anchorMs = 0
  anchorAt = 0
  running = false
}
