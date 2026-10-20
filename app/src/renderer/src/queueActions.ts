/**
 * 批量队列操作 + 队列内排序。
 *
 * 队列的唯一权威在引擎（state.queue），所以这里每次都先读当前队列再改，
 * 而不是在界面里维护一份"我以为的队列"——那样两处一旦不同步，
 * 「下一首播放」就会插到错误的位置，而且没有任何东西会报错。
 *
 * 排序/拖拽/删除同样走「读引擎队列 → 计算新顺序 → set_queue」这一条路：
 * 只改变播放顺序，不动文件、不动曲库、不改任何标签。
 */
import { engineRequest } from './ipc'
import { useTwilight } from './store'

/** 队列排序字段（只影响顺序，不改文件/曲库）。 */
export type QueueSortField = 'folder' | 'title' | 'artist' | 'duration' | 'added'
export const QUEUE_SORT_LABEL: Record<QueueSortField, string> = {
  folder: '按文件夹',
  title: '按歌名',
  artist: '按歌手',
  duration: '按时长',
  added: '按添加顺序'
}
/** 队列行需要的最小曲目信息（store 的 TrackRow 直接满足）。 */
export interface QueueTrackInfo {
  trackId: string
  title: string
  artist: string
  durationMs: number
  path: string
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

async function readQueue(): Promise<string[]> {
  const state = await engineRequest<{ queue?: string[] }>({ cmd: 'get_state' })
  return Array.isArray(state?.queue) ? state.queue : []
}

/**
 * 队列顺序的唯一写入路径：先让引擎接受，再同步 store（失败则两者都不变）。
 *
 * CR-030：**重排必须带 keepCurrent + currentTrackId**，否则引擎会把 queueIndex 重置为 0，
 * 正在播放的那一手高亮/下一首语义都会跳走。追加/下一首同样带——它们也不该改变当前项。
 */
async function writeQueue(next: string[]): Promise<void> {
  const currentTrackId = useTwilight.getState().loadedTrackId ?? undefined
  await engineRequest({ cmd: 'set_queue', trackIds: next, keepCurrent: true, ...(currentTrackId ? { currentTrackId } : {}) }, 15000)
  useTwilight.getState().setQueueIds(next)
}

/** 追加到队列末尾；已经在队列里的不重复添加（同一首歌放两次没有意义）。 */
export async function appendToQueue(trackIds: string[]): Promise<number> {
  const queue = await readQueue()
  const present = new Set(queue)
  const additions = trackIds.filter(id => !present.has(id))
  if (additions.length === 0) return 0
  const next = [...queue, ...additions]
  await writeQueue(next)
  return additions.length
}

/** 插到"下一首"：紧跟在当前曲目之后，并先摘掉它们在队列里原有的位置。 */
export async function playNext(trackIds: string[]): Promise<number> {
  const queue = await readQueue()
  const current = useTwilight.getState().loadedTrackId
  const moving = new Set(trackIds)
  const rest = queue.filter(id => !moving.has(id))
  const at = current ? rest.indexOf(current) : -1
  const insertAt = at >= 0 ? at + 1 : 0
  const next = [...rest.slice(0, insertAt), ...trackIds, ...rest.slice(insertAt)]
  await writeQueue(next)
  return trackIds.length
}

const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '').toLowerCase()

/**
 * 纯函数：给定队列与曲库快照，返回排序后的新数组（不修改入参）。
 * 不在本地曲库里的 id（罕见：曲库刚移除）稳定排在末尾，保持相对顺序。
 */
export function sortQueueIds(
  ids: string[],
  tracks: readonly QueueTrackInfo[],
  field: QueueSortField,
  direction: 'asc' | 'desc' = 'asc'
): string[] {
  const byId = new Map(tracks.map(track => [track.trackId, track]))
  const factor = direction === 'asc' ? 1 : -1
  const origin = new Map(ids.map((id, index) => [id, index]))
  return [...ids].sort((left, right) => {
    const a = byId.get(left)
    const b = byId.get(right)
    if (!a || !b) {
      if (a) return -1
      if (b) return 1
      return (origin.get(left) ?? 0) - (origin.get(right) ?? 0)
    }
    let result = 0
    switch (field) {
      case 'added':
        result = 0
        break
      case 'duration':
        result = a.durationMs - b.durationMs
        break
      case 'folder':
        result = collator.compare(folderOf(a.path), folderOf(b.path))
        break
      case 'artist':
        result = collator.compare(a.artist, b.artist)
        break
      case 'title':
      default:
        result = collator.compare(a.title, b.title)
        break
    }
    if (result === 0 && field !== 'added') result = collator.compare(a.title, b.title)
    if (result === 0) result = (origin.get(left) ?? 0) - (origin.get(right) ?? 0)
    return factor * result
  })
}

/** 拖拽/键盘调序：把 from 位置移到 to 位置。 */
export async function reorderQueue(from: number, to: number): Promise<void> {
  const queue = await readQueue()
  if (from < 0 || from >= queue.length) return
  const target = Math.max(0, Math.min(queue.length - 1, to))
  if (from === target) return
  const next = [...queue]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return
  next.splice(target, 0, moved)
  await writeQueue(next)
}

/** 删除单项（可批量）。 */
export async function removeFromQueue(trackIds: string[]): Promise<void> {
  const removing = new Set(trackIds)
  if (removing.size === 0) return
  const queue = await readQueue()
  const next = queue.filter(id => !removing.has(id))
  if (next.length === queue.length) return
  await writeQueue(next)
}

/** 清空队列（引擎会停在下一次 next/prev 无队列可用的状态，界面如实显示为空）。 */
export async function clearQueue(): Promise<void> {
  const queue = await readQueue()
  if (queue.length === 0) return
  await writeQueue([])
}

/** 按字段排序整个队列。 */
export async function sortQueue(field: QueueSortField, direction: 'asc' | 'desc' = 'asc'): Promise<void> {
  const queue = await readQueue()
  const next = sortQueueIds(queue, useTwilight.getState().tracks, field, direction)
  if (next.every((id, index) => id === queue[index])) return
  await writeQueue(next)
}
