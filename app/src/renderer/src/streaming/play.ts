import type { StreamingTrack } from '@shared/streaming'
import { useTwilight } from '../store'

export interface StreamingPlayReply {
  token?: string
  /** 引擎 open 之后实测的时长（毫秒）。试听切片会如实报成 0:35，而不是平台的 4:21。 */
  durationMs?: number
  sampleRate?: number
  bitDepth?: number
  sourceSampleRate?: number
  quality?: string | null
}

/**
 * 播放一首平台歌曲：**先把「正在播的是谁」交给 store，再要直链**。
 *
 * 顺序是这一层存在的理由。引擎对 URL 源的 state 事件里 trackId 是空串
 * （CR-016 约束 3），所以「这一首是谁」只能由应用侧先落下来；反过来的话，
 * 引擎的第一个 state/position 事件到达时 store 还不知道在线曲目，
 * 就会被判成「未在播放」——表现是有声音、界面毫无反应，而且之后再也不会自愈
 * （后续事件同样没有 trackId 可以用来纠正）。
 *
 * 失败时如实收起在线曲目并保留错误：不留下一个「看起来在播、其实没出声」的状态。
 */
export async function playStreamingTrack(track: StreamingTrack): Promise<StreamingPlayReply> {
  const store = useTwilight.getState()
  store.beginOnlinePlayback(track)
  try {
    const reply = await window.twilight.streamingPlay(track.platform, track) as StreamingPlayReply
    useTwilight.getState().confirmOnlinePlayback(Number(reply?.durationMs ?? 0), reply?.quality ?? null)
    return reply ?? {}
  } catch (error) {
    useTwilight.getState().failOnlinePlayback(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** 停止在线播放：引擎的 stop 会回报 state=stopped，store 据此收起在线曲目。 */
export async function stopStreamingTrack(): Promise<void> {
  await window.twilight.request({ cmd: 'stop' })
  useTwilight.getState().clearOnlinePlayback()
}
