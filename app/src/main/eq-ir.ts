/**
 * 房间校正的持久化偏好（主进程）。
 *
 * 为什么需要这个：冲激响应是**引擎内存里的状态**，引擎一重启（应用重启、输出设备切换
 * 重开引擎）就没了。用户每次开机都要重新挑一遍 WAV，是把「功能有」和「功能好用」的差距
 * 暴露在第一分钟。所以这里只记三样东西：路径、是否启用、电平。
 *
 * **记路径而不是记冲激响应本身**：一份 IR 可以是几百 KB 到几 MB，塞进配置文件和塞进
 * localStorage 都不合适；而文件本来就该由用户自己保管。文件没了就是没了，界面上说清楚。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface IrPrefs {
  path: string
  enabled: boolean
  preampDb: number
}

let configFile: string | null = null
let prefs: IrPrefs | null = null
let ready: Promise<void> = Promise.resolve()
let writing: Promise<unknown> = Promise.resolve()

function sanitize(raw: unknown): IrPrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const file = typeof record.path === 'string' ? record.path.trim() : ''
  if (!file) return null
  const preamp = Number(record.preampDb)
  return {
    path: file.slice(0, 1024),
    enabled: record.enabled !== false,
    preampDb: Number.isFinite(preamp) ? Math.max(-24, Math.min(24, preamp)) : 0
  }
}

export function configureEqIr(file: string): void {
  configFile = file
  prefs = null
  ready = readFile(file, 'utf8')
    .then((text) => {
      prefs = sanitize(JSON.parse(text) as unknown)
    })
    .catch(() => {
      /* 首次运行没有这个文件，或者它坏了：当作没有偏好，不影响启动。 */
    })
}

export async function readIrPrefs(): Promise<IrPrefs | null> {
  await ready
  return prefs ? { ...prefs } : null
}

export async function writeIrPrefs(raw: unknown): Promise<IrPrefs | null> {
  await ready
  const next = sanitize(raw)
  prefs = next
  if (configFile) {
    const file = configFile
    const write = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file + '.tmp', JSON.stringify(next ?? {}, null, 2), 'utf8')
      await rename(file + '.tmp', file)
    })
    writing = write.catch(() => undefined)
    await write
  }
  return prefs ? { ...prefs } : null
}
