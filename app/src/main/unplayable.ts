/**
 * 无法播放的曲目记录（主进程持久化）。
 *
 * 为什么需要一份**持久**记录（而不是每次启动重新发现）：
 *
 * 1. 判定"播不了"的唯一权威是**解码器**，而它只有在扫描预检或真正播放时才会回答。
 *    用户不会为了看见列表干净而把每首坏歌点一遍 —— 所以一次发现必须留痕。
 * 2. 用户要求「自动标记并移除出列表」+「可在设置里查看、一键恢复」。移除必须是
 *    **应用侧过滤**而不是删除数据：引擎的 catalog 没有清空单条的命令，而且
 *    「文件暂时读不到」与「文件真的坏了」在磁盘上无法区分（拔盘、权限、正在复制）。
 *    把判定记下来、把显示权收在应用侧，才能既清干净又能捞回来。
 * 3. ⚠️ 误判是真实存在的风险，所以恢复必须是一等操作，记录里也保留原因与时间。
 *
 * 记录**不**删除或改动任何音乐文件。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { libraryPathKey } from '@shared/library'
import type { UnplayableEntry, UnplayableReport } from '@shared/unplayable'

let configFile: string | null = null
/** 归一 path 键 → 记录。以键为身份，与曲库其余部分同一套归一（CR-013）。 */
let entries = new Map<string, UnplayableEntry>()
let loadGeneration = 0
let ready: Promise<void> = Promise.resolve()

export function configureUnplayable(file: string): void {
  configFile = file
  entries = new Map()
  const generation = ++loadGeneration
  ready = readFile(file, 'utf8')
    .then((text) => {
      // 代际保护：两次 configure 的异步读取可能乱序完成。
      if (generation !== loadGeneration) return
      const saved: unknown = JSON.parse(text)
      if (!saved || typeof saved !== 'object') return
      const list = (saved as { entries?: unknown }).entries
      if (!Array.isArray(list)) return
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const record = raw as Record<string, unknown>
        if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) continue
        entries.set(libraryPathKey(record.path), {
          path: record.path,
          reason: typeof record.reason === 'string' ? record.reason : '无法解码',
          source: record.source === 'scan' || record.source === 'playback' ? record.source : 'playback',
          detectedAt: typeof record.detectedAt === 'string' ? record.detectedAt : new Date().toISOString()
        })
      }
    })
    .catch(() => {
      /* 首次运行没有这个文件；损坏的记录按"没有记录"处理，不阻断启动。 */
    })
}

async function persist(): Promise<void> {
  if (!configFile) return
  await mkdir(path.dirname(configFile), { recursive: true })
  const payload = { entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) }
  await writeFile(configFile + '.tmp', JSON.stringify(payload, null, 2), 'utf8')
  await rename(configFile + '.tmp', configFile)
}

/** 当前全部记录（按路径排序，界面直接渲染）。 */
export async function readUnplayable(): Promise<UnplayableReport> {
  await ready
  return { entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}

/**
 * 记下一个播不了的路径。重复记录会**更新原因与时间**而不是新增一条：
 * 同一个文件第二次仍然坏，那是同一个事实，不该在列表里出现两行。
 * 返回 true 表示这是一条新记录（调用方据此决定要不要提示用户）。
 */
export async function markUnplayable(
  file: string,
  reason: string,
  source: UnplayableEntry['source']
): Promise<boolean> {
  await ready
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false
  const key = libraryPathKey(file)
  if (!key) return false
  const existed = entries.has(key)
  entries.set(key, { path: file, reason, source, detectedAt: new Date().toISOString() })
  await persist()
  return !existed
}

/**
 * 一键恢复：忘掉全部记录，被过滤的曲目重新回到列表。
 * 只清记录，不碰磁盘 —— 文件本来就没被动过。
 */
export async function clearUnplayable(): Promise<UnplayableReport> {
  await ready
  entries = new Map()
  await persist()
  return readUnplayable()
}

/** 恢复一条（用户在列表里只捞回某一首）。 */
export async function forgetUnplayable(file: string): Promise<UnplayableReport> {
  await ready
  entries.delete(libraryPathKey(file))
  await persist()
  return readUnplayable()
}
