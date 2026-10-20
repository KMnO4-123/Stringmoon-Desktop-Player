/**
 * 这条 state 事件是否意味着「在线播放占用结束」。
 *
 * CR-016 约束 3：在线曲目的 state.trackId 恒为空串，本地曲目是 tl_ 前缀。
 * 仅凭 state !== 'playing' 判断会漏掉一个真实场景：在线曲目 A 正在放，用户切到
 * 本地曲目 B —— 引擎 open+play 后 state 仍是 playing，只是 trackId 变成 tl_xxx，
 * 而且不一定会先发 ended。不按 trackId 释放的话，平台服务端会被这个已经不在
 * 出声的会话永久钉住，空闲休眠永远不触发。
 *
 * 参数刻意收窄成结构类型而不是 EngineEvent 联合：调用点只需要 ev/state/trackId，
 * 单测也不需要伪造整条事件。
 */
export interface PlaybackStateLike {
  ev: string
  state?: string
  trackId?: string
}

export function releasesOnlinePlayback(event: PlaybackStateLike): boolean {
  if (event.ev !== 'state') return false
  return event.state !== 'playing' || event.trackId !== ''
}
