import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { libraryPathKey, type LibraryDirectories } from '@shared/library'

/**
 * 曲库目录集合（应用侧设置，不进引擎协议）。
 *
 * 用户通过顶栏「添加文件夹」加进来的目录都记在这里，下次启动按顺序全部扫描 ——
 * 于是「这次看到的曲库」与「下次拿到的曲库」是同一份。产物是 userData/library.json。
 *
 * 为什么必须记住一整组而不是一个：引擎的 scan 只能追加、且没有清空 catalog 的
 * 命令（见 CR-013），所以会话内天然是累加的；只记最后一个目录的话，加了第二个
 * 文件夹后重启，第一个就没了 —— 一次探索性的添加会把原来的曲库顶掉。
 *
 * 内置默认目录只对「从未管理过目录」的用户生效，并且会在用户第一次添加/移除时
 * 被写进列表（否则会话内是「默认 + 新目录」、重启后只剩新目录，又对不上了）。
 */

/** 从未选过目录时的默认位置：当前用户的音乐文件夹（开箱即可用，不依赖任何特定机器）。 */
const DEFAULT_DIRECTORY = path.join(homedir(), 'Music')

let configFile: string | null = null
let stored: string[] = []
/** 用户是否明确管理过目录。false = 从未选过 → 用内置默认目录。 */
let configured = false
let configReady: Promise<void> = Promise.resolve()
let loadGeneration = 0
/** 生效的「从未选过」回退目录。可注入，便于测试不依赖本机某个真实目录。 */
let defaultDirectory = DEFAULT_DIRECTORY

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

export function configureLibrary(file: string, fallbackDirectory: string = DEFAULT_DIRECTORY): void {
  configFile = file
  defaultDirectory = fallbackDirectory
  // 切到另一个配置文件时先清空：否则「读不到」会继承上一个文件的值。
  stored = []
  configured = false
  // 代际保护：读取是异步的，两次 configure 的读取可能乱序完成；只让最后一次落地。
  const generation = ++loadGeneration
  configReady = readFile(file, 'utf8')
    .then((text) => {
      if (generation !== loadGeneration) return
      const saved: unknown = JSON.parse(text)
      if (!saved || typeof saved !== 'object') return
      const record = saved as Record<string, unknown>
      // 迁移：上一版只存一个目录（{directory}）。保住用户已经选过的那份。
      if (typeof record.directory === 'string' && path.isAbsolute(record.directory)) {
        stored = [record.directory]
        configured = true
        return
      }
      if (Array.isArray(record.directories)) {
        stored = record.directories.filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry))
        // 空数组 + configured=true 是合法状态（用户把目录都移除了），不能退化成默认目录。
        configured = record.configured === true
      }
    })
    .catch(() => {
      /* 首次运行没有配置文件；损坏的配置按「从未管理过」处理，不阻断启动。 */
    })
}

/** 生效的目录（含内置默认目录的回退），并标出其中此刻不可用的。 */
export async function readLibraryDirectories(): Promise<LibraryDirectories> {
  await configReady
  let effective = stored
  if (!configured) {
    // 从未管理过目录：回退到内置默认目录。
    effective = [defaultDirectory]
  }
  const missing: string[] = []
  for (const directory of effective) {
    if (!(await isDirectory(directory))) missing.push(directory)
  }
  return { directories: [...effective], missing }
}

async function persist(): Promise<void> {
  if (!configFile) return
  await mkdir(path.dirname(configFile), { recursive: true })
  await writeFile(configFile + '.tmp', JSON.stringify({ directories: stored, configured: true }), 'utf8')
  await rename(configFile + '.tmp', configFile)
}

/** 把内置默认目录固化进列表：用户一动目录，会话内的曲库就必须能被重启复现。 */
async function materializeDefault(): Promise<void> {
  if (configured) return
  configured = true
  // 默认目录不存在就别写进配置：那会把「下次必然扫不到」固化下来。
  stored = (await isDirectory(defaultDirectory)) ? [defaultDirectory] : []
}

/**
 * 加一个目录。只接受存在的绝对目录 —— 把不存在的路径写进配置，
 * 等于把「下次启动必然扫不到东西」固化下来。已存在则不重复添加。
 */
export async function addLibraryDirectory(directory: string): Promise<LibraryDirectories> {
  await configReady
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await isDirectory(directory))) {
    return readLibraryDirectories()
  }
  await materializeDefault()
  const key = libraryPathKey(directory)
  if (!stored.some((entry) => libraryPathKey(entry) === key)) stored = [...stored, directory]
  await persist()
  return readLibraryDirectories()
}

/**
 * 移除一个目录。只影响这份列表：引擎 catalog 里的条目仍在（它没有清空命令），
 * 但应用不再把它们算进曲库，所以从界面上真正消失。重新加回来时它们会立刻出现，
 * 不需要再扫一次盘。
 */
export async function removeLibraryDirectory(directory: string): Promise<LibraryDirectories> {
  await configReady
  const key = libraryPathKey(directory)
  if (!key) return readLibraryDirectories()
  await materializeDefault()
  stored = stored.filter((entry) => libraryPathKey(entry) !== key)
  configured = true
  await persist()
  return readLibraryDirectories()
}
