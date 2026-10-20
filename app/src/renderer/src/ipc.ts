import type { EngineRequestCommand, LatencyProfile } from '@shared/protocol'
import { unwrapRequest } from '@shared/request-result'
import { useTwilight } from './store'

/**
 * 引擎命令通道（含 QueMusic §2 的请求计数派生 loading）：
 *  - 每条命令 push/pop 恰好一次（失败/超时/风控都保证回调，见 catch）；
 *  - 每条命令 20s 看门狗兜底强制归零（防任一路径漏 pop）；
 *  - 歌词请求刻意不计数（REFS 建议：歌词加载不该阻塞全局 loading）。
 */
const WATCHDOG_MS = 20_000
let synchronization: Promise<void> | null = null
let resynchronize = false
let dspRequestSequence = 0
let playbackRequestSequence = 0

/**
 * 把用户存的输出偏好/规格下发给引擎。
 *
 * 引擎是无状态的音频进程：它不持久化 exclusive/shared 与输出采样率，重启后一律
 * 回到 auto / 跟随源。所以每次握手成功之后都要重新下发一次，否则「我明明选了
 * 独占 192k」会在一次引擎重启后静默失效，而界面上仍显示着那个偏好。
 */
export async function applyOutputPreference(options: { latencyProfile?: LatencyProfile } = {}): Promise<void> {
  const { outputPreference, requestedOutputRate } = useTwilight.getState()
  // Always re-send the automatic preference after a handshake. The engine is a
  // separate process and its startup output is shared-only until this command
  // arrives; skipping the default pair silently leaves every fresh track in the
  // system mixer, which is exactly the quality regression the signal panel says
  // "自动" should avoid.
  // 延迟档位（CR-027）与输出模式/采样率走同一条命令：set_output 会重开输出，
  // 拆成两条会让输出重开两次（用户能听到一次多余的静音/淡入）。
  await engineRequest({
    cmd: 'set_output', mode: outputPreference, sampleRate: requestedOutputRate,
    ...(options.latencyProfile ? { latencyProfile: options.latencyProfile } : {})
  }, 15000)
}

/** 启动/ready 时握手一次；事件流持续驱动状态，无周期轮询。 */
export function synchronizeEngine(restarted = false): Promise<void> {
  if (synchronization) {
    resynchronize ||= restarted
    return synchronization
  }
  synchronization = (async () => {
    do {
      resynchronize = false
      const connectionError = useTwilight.getState().connectionError
      try {
        await engineRequest({ cmd: 'hello', protocol: 1 })
        try {
          await engineRequest({ cmd: 'get_state' }, 5000)
        } catch (error) {
          const unsupported = error instanceof Error && 'code' in error && error.code === 'ERR_UNSUPPORTED'
          const hardware = error instanceof Error && 'kind' in error && error.kind === 'hardware'
          if (!unsupported || hardware) throw error
        }
        if (!resynchronize && useTwilight.getState().connectionError === connectionError) {
          useTwilight.setState({ connectionError: null })
        }
      } catch (error) {
        if (!resynchronize) throw error
      }
      // ready 可能晚于 hello 回复；补一次握手恢复被 ready 清空的能力。
    } while (resynchronize)
  })().finally(() => { synchronization = null })
  return synchronization
}

export async function engineRequest<T = unknown>(cmd: EngineRequestCommand, timeoutMs?: number): Promise<T> {
  const store = useTwilight.getState()
  const epoch = store.engineEpoch
  const dspSequence = cmd.cmd === 'get_state' || cmd.cmd === 'set_eq' || cmd.cmd === 'set_channels' || cmd.cmd === 'set_replaygain'
    ? ++dspRequestSequence : 0
  store.pushRequest()
  let settled = false
  const watchdog = setTimeout(() => {
    if (!settled) {
      settled = true
      useTwilight.getState().popRequest()
    }
  }, Math.min(WATCHDOG_MS, timeoutMs ?? WATCHDOG_MS))
  const finish = (): void => {
    if (!settled) {
      settled = true
      clearTimeout(watchdog)
      useTwilight.getState().popRequest()
    }
  }
  try {
    const data = unwrapRequest(await window.twilight.request(cmd, timeoutMs))
    if (cmd.cmd === 'hello') useTwilight.getState().applyHello(data)
    if (cmd.cmd === 'get_state' && useTwilight.getState().engineEpoch === epoch) {
      useTwilight.getState().applyEvent(data)
      const details = data !== null && typeof data === 'object' ? (data as Record<string, unknown>).dsp : undefined
      useTwilight.getState().applyDsp(details, dspSequence, epoch)
    }
    // set_replaygain 的回复是「与 get_state 一致的全量 dsp」（engine app.cpp:1343），
    // 必须走同一条 applyDsp —— 否则 dspModules / bit-perfect 徽标不会更新。
    if (cmd.cmd === 'set_eq' || cmd.cmd === 'set_channels' || cmd.cmd === 'set_replaygain') {
      useTwilight.getState().applyDsp(data, dspSequence, epoch)
    }
    return data as T
  } finally {
    finish()
  }
}

/**
 * 双击曲目 → open → play（intent 链路）。
 * open 回复的 durationMs 先行确认 intent；state/position 事件随后到达完成权威同步。
 */
export async function openAndPlay(trackId: string, queueTrackIds?: string[]): Promise<void> {
  const sequence = ++playbackRequestSequence
  const store = useTwilight.getState()
  store.beginIntent(trackId)
  try {
    if (store.queueCapable === true) {
      const visibleIds = new Set(store.tracks.map(track => track.trackId))
      const requested = queueTrackIds ?? store.tracks.map(track => track.trackId)
      const queue = [...new Set(requested.filter(id => visibleIds.has(id)))]
      if (visibleIds.has(trackId) && !queue.includes(trackId)) queue.unshift(trackId)
      if (queue.length) {
        await engineRequest({ cmd: 'set_queue', trackIds: queue })
        useTwilight.getState().setQueueIds(queue)
      }
    }
    if (sequence !== playbackRequestSequence) return
    const opened = await engineRequest<{ trackId?: string; durationMs?: number }>({ cmd: 'open', trackId })
    if (sequence !== playbackRequestSequence) return
    store.confirmIntent(trackId, opened?.durationMs)
    await engineRequest({ cmd: 'play' })
  } catch (err) {
    if (sequence === playbackRequestSequence) useTwilight.getState().failIntent(trackId, String(err instanceof Error ? err.message : err))
  }
}

/** seek：记录 seekPending，等引擎第一个 position 事件对齐（E1.1 #5）。 */
export async function seekTo(positionMs: number): Promise<void> {
  useTwilight.getState().beginSeek()
  try {
    await engineRequest({ cmd: 'seek', positionMs: Math.round(positionMs) })
  } catch {
    useTwilight.getState().applyEvent({ ev: '__none__' }) // no-op：保持类型完整
    useTwilight.setState({ seekPending: false }) // seek 失败立即解除中间态
  }
}