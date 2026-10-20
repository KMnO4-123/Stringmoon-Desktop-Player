import fs from 'node:fs'
import path from 'node:path'

/**
 * 升级备份 —— 版本变化时的第一道数据保险。
 *
 * 设计目标（PACKAGING-v1 §3）：
 *  - 启动**最早阶段**读 userData/app-meta.json 的 lastVersion；与当前版本不同时，
 *    把已知 JSON 文档复制到 userData/upgrade-backups/<旧版本>/，再写新 meta。
 *  - 任何失败只记日志：绝不阻断启动、绝不删除/移动原文件（原文件是唯一真相）。
 *  - 只保留最近 3 份备份，避免长期升级把用户盘塞满。
 *
 * 为什么复制而不是移动/重命名：复制失败最多是「少一份保险」，移动失败会让应用以
 * 空数据启动 —— 后者是用户不可接受的。
 */

export const UPGRADE_BACKUP_DIR = 'upgrade-backups'
export const APP_META_FILE = 'app-meta.json'
/** 应用元数据格式版本；将来字段变化时据此迁移，而不是猜。 */
export const UPGRADE_META_SCHEMA_VERSION = 1
export const MAX_UPGRADE_BACKUPS = 3

/** 需要备份的用户文档（都在 userData 根目录，都是主进程 JSON 持久化）。 */
export const UPGRADE_DOCUMENT_FILES = [
  'library.json',
  'playlists.json',
  'track-overrides.json',
  'unplayable.json',
  'lyrics.json',
  'lyrics-online.json',
  'eq-presets.json',
  'eq-ir.json',
  'artwork.json',
  'playback-memory.json',
  'streaming.json',
  'streaming-sessions.json',
  'downloads.json'
] as const

export interface AppMeta {
  /** 上次写 meta 时正在运行的版本（升级判断的唯一依据）。 */
  lastVersion: string
  schemaVersion: number
  updatedAt: string
}

export interface UpgradeBackupResult {
  backedUp: boolean
  fromVersion: string | null
  currentVersion: string
  backupDir: string | null
  copied: string[]
  pruned: string[]
  /** 面向日志的一句中文原因；成功时 null。调用方只打日志，不做控制流。 */
  problem: string | null
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 版本号会被用作目录名：只留安全字符，防 ../ 之类的路径注入。 */
export function backupDirectoryName(fromVersion: string): string {
  return fromVersion.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 64) || 'unknown'
}

/** 读 app-meta.json。文件不存在 = 首启（不是错误）；损坏 = 有 problem 但 meta 为 null。 */
export function readAppMeta(userDataPath: string): { meta: AppMeta | null; problem: string | null } {
  const file = path.join(userDataPath, APP_META_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { meta: null, problem: null }
    return { meta: null, problem: '读取 app-meta.json 失败（' + messageOf(error) + '）。' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { meta: null, problem: 'app-meta.json 不是对象。' }
    const record = parsed as Record<string, unknown>
    const lastVersion = record.lastVersion
    const schemaVersion = record.schemaVersion
    const updatedAt = record.updatedAt
    if (typeof lastVersion !== 'string' || !lastVersion) {
      return { meta: null, problem: 'app-meta.json 缺少 lastVersion。' }
    }
    return {
      meta: {
        lastVersion,
        schemaVersion: typeof schemaVersion === 'number' && Number.isFinite(schemaVersion) ? schemaVersion : 0,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : ''
      },
      problem: null
    }
  } catch {
    return { meta: null, problem: 'app-meta.json 不是合法的 JSON。' }
  }
}

/** 原子写 meta（tmp + rename），返回 problem 或 null；绝不抛出。 */
export function writeAppMeta(userDataPath: string, currentVersion: string, now: Date = new Date()): string | null {
  const file = path.join(userDataPath, APP_META_FILE)
  const temp = file + '.' + process.pid + '.tmp'
  const document: AppMeta = {
    lastVersion: currentVersion,
    schemaVersion: UPGRADE_META_SCHEMA_VERSION,
    updatedAt: now.toISOString()
  }
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, file)
    return null
  } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch { /* 临时文件都清不掉就算了 */ }
    return '写入 app-meta.json 失败（' + messageOf(error) + '）。'
  }
}

/** 按 mtime 从新到旧列出备份目录；读不到目录返回空数组。 */
export function listBackupDirectories(userDataPath: string): Array<{ name: string; dir: string; mtimeMs: number }> {
  const root = path.join(userDataPath, UPGRADE_BACKUP_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const directories: Array<{ name: string; dir: string; mtimeMs: number }> = []
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      const stat = fs.statSync(dir)
      if (stat.isDirectory()) directories.push({ name, dir, mtimeMs: stat.mtimeMs })
    } catch { /* 统计失败就当它不存在 */ }
  }
  directories.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  return directories
}

/** 只保留最近 maxBackups 份；删除超出部分（只删我们自己建的备份目录）。 */
export function pruneUpgradeBackups(userDataPath: string, maxBackups: number = MAX_UPGRADE_BACKUPS): string[] {
  const directories = listBackupDirectories(userDataPath)
  const pruned: string[] = []
  for (const entry of directories.slice(Math.max(0, maxBackups))) {
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true })
      pruned.push(entry.name)
    } catch { /* 下一次启动还能再试；不阻断 */ }
  }
  return pruned
}

function copyDocuments(userDataPath: string, backupDir: string): { copied: string[]; problem: string | null } {
  const copied: string[] = []
  const problems: string[] = []
  for (const name of UPGRADE_DOCUMENT_FILES) {
    const source = path.join(userDataPath, name)
    try {
      if (!fs.existsSync(source)) continue
      fs.copyFileSync(source, path.join(backupDir, name))
      copied.push(name)
    } catch (error) {
      problems.push(name + '（' + messageOf(error) + '）')
    }
  }
  return {
    copied,
    problem: problems.length ? '部分文档备份失败：' + problems.join('、') : null
  }
}

/**
 * 启动时调用的入口。**永远不抛**：
 *  - 首启 / 同版本：只补写 meta，不备份；
 *  - 版本变化：备份到 upgrade-backups/<旧版本>/，成功后才写新 meta（失败下次启动重试）；
 *  - meta 损坏：当作首启处理，重写 meta（不至于让应用起不来）。
 */
export function runUpgradeBackup(options: {
  userDataPath: string
  currentVersion: string
  maxBackups?: number
  now?: () => Date
}): UpgradeBackupResult {
  const result: UpgradeBackupResult = {
    backedUp: false,
    fromVersion: null,
    currentVersion: options.currentVersion,
    backupDir: null,
    copied: [],
    pruned: [],
    problem: null
  }
  try {
    const read = readAppMeta(options.userDataPath)
    if (read.problem) result.problem = read.problem
    const changed = read.meta !== null && read.meta.lastVersion !== options.currentVersion
    if (changed && read.meta !== null) {
      result.fromVersion = read.meta.lastVersion
      const dir = path.join(options.userDataPath, UPGRADE_BACKUP_DIR, backupDirectoryName(read.meta.lastVersion))
      result.backupDir = dir
      fs.mkdirSync(dir, { recursive: true })
      const copy = copyDocuments(options.userDataPath, dir)
      result.copied = copy.copied
      if (copy.problem) result.problem = copy.problem
      result.backedUp = result.problem === null
      result.pruned = pruneUpgradeBackups(options.userDataPath, options.maxBackups ?? MAX_UPGRADE_BACKUPS)
    }
    // 版本没变不重写（避免每次启动都 churn updatedAt）；备份失败也不写，留给下次重试。
    const needsMeta = read.meta === null || (changed && result.problem === null)
    if (needsMeta) {
      const now = options.now ? options.now() : new Date()
      const problem = writeAppMeta(options.userDataPath, options.currentVersion, now)
      if (problem) result.problem = problem
    }
  } catch (error) {
    // 兜底：任何没预料到的异常都不能阻断启动。
    result.problem = '升级备份失败（' + messageOf(error) + '）。'
  }
  return result
}
