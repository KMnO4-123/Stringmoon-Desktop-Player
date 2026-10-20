import { canRestoreMemory, type PlaybackMemory } from '@shared/playback-memory'
import { libraryPathKey } from '@shared/library'
import type { Track } from '@shared/protocol'
import { engineRequest } from './ipc'
import { getPosition, resetPosition, setPosition, subscribePosition } from './positionStore'
import { useTwilight } from './store'

/**
 * 播放记忆与「继续上次」（对标 ECHO NEXT 的 echo-playback-memory.json）。
 *
 * 三条纪律：
 *  1. **绝不自动出声**：启动只显示一条可操作的入口，用户点了才 open + seek，
 *     并且保持暂停 —— 恢复的语义是「接着上次的位置」，不是「一开应用就响」。
 *  2. **路径是身份**：引擎 trackId 会随重扫变化，filePath 跨重启稳定；恢复时先用
 *     trackId 试，失效再按归一化路径在当前 catalog 里找。
 *  3. **记忆写失败不打扰用户**：这是便利功能，不是播放路径；所有 IPC 都吞掉错误。
 */

/** 播放中位置每 5s 最多写一次（主进程侧也会从引擎事件按 1s 节流落盘，这里是兜底）。 */
const SAVE_INTERVAL_MS = 5000
/** 下一首预热延迟：别和当前曲目的起播 I/O 抢盘。 */
const PREFETCH_DELAY_MS = 1500

let recorderStarted = false
let prefetchTimer: ReturnType<typeof setTimeout> | null = null
let lastPrefetchPath: string | null = null
let lastSaveAt = 0

/**
 * 「启动时自动回到上次播放」开关（v6）。
 *
 * 默认**开启**：用户要的就是「开机接着听」。但它只恢复成「已装载、暂停」——
 * 自动出声是另一件事，不在这个开关里，也不该在。
 * 存 localStorage 而不是主进程文件：这是纯界面偏好，丢了只是回到默认值。
 */
const AUTO_RESUME_KEY = 'stringmoon.resume-on-launch'

export function isAutoResumeEnabled(): boolean {
  try { return globalThis.localStorage?.getItem(AUTO_RESUME_KEY) !== 'off' } catch { return true }
}

export function setAutoResumeEnabled(value: boolean): void {
  try { globalThis.localStorage?.setItem(AUTO_RESUME_KEY, value ? 'on' : 'off') } catch { /* 隐私模式：只影响本进程 */ }
}

const byId = (id: string | null): Track | null => {
  if (!id) return null
  return useTwilight.getState().engineTracks.find(track => track.trackId === id) ?? null
}

const byPath = (filePath: string): Track | null => {
  if (!filePath) return null
  const key = libraryPathKey(filePath)
  if (!key) return null
  return useTwilight.getState().engineTracks.find(track => libraryPathKey(track.path) === key) ?? null
}

/** 记忆 → 当前 catalog 里可操作的曲目（trackId 优先，路径兜底）。 */
export function resolveMemoryTrack(memory: PlaybackMemory): Track | null {
  return byId(memory.trackId) ?? byPath(memory.filePath)
}

export interface ResumeOffer {
  memory: PlaybackMemory
  track: Track
  positionMs: number
}

/**
 * 启动读一次记忆，并解析成当前 catalog 里的曲目。
 * 解析不到（歌被移走/换盘）就不显示入口 —— 一个点了会报错的「继续上次」比没有更糟。
 */
export async function loadResumeOffer(): Promise<ResumeOffer | null> {
  try {
    const memory = await window.twilight.playbackMemory()
    if (!memory || (!memory.trackId && !memory.filePath)) return null
    const track = resolveMemoryTrack(memory)
    if (!track) {
      // 没有可恢复路径、也没有可解析曲目：清掉这条死记忆，下次不再查。
      if (!canRestoreMemory(memory)) await window.twilight.clearPlaybackMemory().catch(() => {})
      return null
    }
    return { memory, track, positionMs: Math.max(0, Math.round(memory.positionMs)) }
  } catch { return null }
}

/**
 * 用户点「继续上次」：open → seek → 保持暂停，不 play。
 *
 * 队列也一起恢复（引擎队列是内存态），这样「下一首」从上次的上下文继续，
 * 而不是变成当前曲库的第一首。队列里失效的 id 会被过滤掉。
 */
export async function resumePlayback(offer: ResumeOffer): Promise<boolean> {
  const state = useTwilight.getState()
  try {
    if (state.queueCapable === true && offer.memory.queue.length > 0) {
      const visible = new Set(state.engineTracks.map(track => track.trackId))
      const queue = offer.memory.queue.filter(id => visible.has(id))
      if (queue.length > 0) {
        await engineRequest({ cmd: 'set_queue', trackIds: queue }, 15000)
        useTwilight.getState().setQueueIds(queue)
      }
    }
    const opened = await engineRequest<{ durationMs?: number }>({ cmd: 'open', trackId: offer.track.trackId }, 20000)
    /**
     * seek 要**确认落地**，不能发一次就当成功。
     *
     * 实测（v6 e2e）：open 的回复先到、源还没就绪的瞬间 seek 会被引擎以
     * "no track is open" 拒绝；旧代码把它 catch 掉继续往下写记忆，于是界面显示
     * 42 秒、引擎实际停在 0 秒 —— 下一次任何 state 事件就把 UI 纠正回 0，
     * 用户看到「自动恢复回到开头」。
     * 现在按回复里的 positionMs 判定，不一致就重试几次；最终以引擎回读为准。
     */
    let landed = 0
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const reply = await engineRequest<{ positionMs?: number }>({ cmd: 'seek', positionMs: offer.positionMs }, 15000)
        landed = Math.max(0, Math.round(Number(reply?.positionMs ?? 0)))
        if (Math.abs(landed - offer.positionMs) <= 1000) break
      } catch { /* 引擎还没装载好：稍后重试 */ }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    resetPosition(offer.track.trackId, opened?.durationMs ?? offer.memory.durationMs)
    setPosition({ trackId: offer.track.trackId, positionMs: landed || offer.positionMs, durationMs: opened?.durationMs || offer.memory.durationMs })
    // 把记忆定位到最新（用户若马上又退出，下次入口仍在这里）。
    await window.twilight.savePlaybackMemory({
      trackId: offer.track.trackId, filePath: offer.track.path, positionMs: offer.positionMs
    }).catch(() => {})
    return true
  } catch {
    return false
  }
}

export async function dismissResumeOffer(): Promise<void> {
  await window.twilight.clearPlaybackMemory().catch(() => {})
}

/** 把当前状态写进记忆（字段都合法才写；main 侧会再 sanitize 一次）。 */
function saveNow(): void {
  const state = useTwilight.getState()
  if (!state.loadedTrackId) return
  const track = byId(state.loadedTrackId)
  const position = getPosition()
  lastSaveAt = Date.now()
  void window.twilight.savePlaybackMemory({
    trackId: state.loadedTrackId,
    ...(track?.path ? { filePath: track.path } : {}),
    positionMs: Math.max(0, Math.round(position.positionMs)),
    durationMs: Math.max(0, Math.round(position.durationMs || state.durationMs)),
    // 引擎队列顺序才是「接着会放什么」；没有队列时退回可见列表。
    queue: state.queueIds.length > 0 ? state.queueIds : state.tracks.map(entry => entry.trackId),
    repeatMode: state.repeatMode
  }).catch(() => { /* 便利功能：写失败不打断播放 */ })
}

/** 当前曲目之后的第一首本地曲目（列表循环时回到第一首；随机模式不预热，避免预错）。 */
function nextLocalPath(): string | null {
  const state = useTwilight.getState()
  if (state.repeatMode === 'shuffle') return null
  // 优先用引擎队列顺序（用户可能从歌单/批量选择起播，和可见列表顺序不同）。
  const order = state.queueIds.length > 0 ? state.queueIds : state.tracks.map(entry => entry.trackId)
  if (order.length === 0) return null
  const index = order.indexOf(state.loadedTrackId ?? '')
  if (index < 0) return null
  const nextId = order[index + 1] ?? (state.repeatMode === 'all' ? order[0] : undefined)
  if (!nextId) return null
  const next = byId(nextId)
  return next?.path ? next.path : null
}

function schedulePrefetch(): void {
  if (prefetchTimer !== null) clearTimeout(prefetchTimer)
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null
    if (useTwilight.getState().playState !== 'playing') return
    const path = nextLocalPath()
    if (!path) {
      if (lastPrefetchPath) { lastPrefetchPath = null; void window.twilight.cancelPrefetch().catch(() => {}) }
      return
    }
    if (path === lastPrefetchPath) return
    lastPrefetchPath = path
    // 失败不是播放错误（文件可能刚被删）：只放弃这次预热，不弹协议错误。
    void window.twilight.prefetchTrack(path).catch(() => { })
  }, PREFETCH_DELAY_MS)
}

/**
 * 挂上记忆记录器（App 启动时调一次）。
 *
 * 写入时机：切曲 / 队列或循环模式变化 / 暂停或停止 / 播放中每 5s 位置；
 * 预热时机：切曲后 1.5s，提前把下一首文件读进 OS 缓存（只读前几 MB，不解析、不出声）。
 */
export function startPlaybackMemoryRecorder(): void {
  if (recorderStarted) return
  recorderStarted = true
  subscribePosition(() => {
    if (useTwilight.getState().playState !== 'playing') return
    if (Date.now() - lastSaveAt < SAVE_INTERVAL_MS) return
    saveNow()
  })
  useTwilight.subscribe((next, previous) => {
    if (next.loadedTrackId !== previous.loadedTrackId) {
      saveNow()
      schedulePrefetch()
      return
    }
    // 曲目没变但「开始播放」也要预热：播放恢复/暂停后继续时 loadedTrackId 是不变的，
    // 只在切曲时预热会漏掉「恢复上次播放后再点播放」这条最常见的深播路径。
    if (next.playState !== previous.playState && next.playState === 'playing') schedulePrefetch()
    if (next.repeatMode !== previous.repeatMode || next.tracks !== previous.tracks) saveNow()
    if (next.playState !== previous.playState && (next.playState === 'paused' || next.playState === 'no-track')) saveNow()
  })
}