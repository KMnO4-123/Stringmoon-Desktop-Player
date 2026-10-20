/**
 * 内置运行环境（v0.4.0）。
 *
 * 目的：发给别人时对方不用装 Node.js、也不用 npx 拉包 —— 安装包自带 node.exe 与
 * 两个平台服务端（netease / qq 的 API 包及其依赖）。
 *
 * 为什么要打 zip：electron-builder 的 extraResources 会**丢掉 node_modules 目录**
 * （试过 filter 也不行），而 Node 的模块解析必须有名为 node_modules 的目录。所以
 * 打包时把整个运行环境压成 runtime.zip（约 61MB），首次启动用 Windows 自带的
 * tar.exe 解压到 userData/runtime（约 151MB），之后靠 .ready 标记跳过。
 *
 * 纪律：
 *  - 已有 streaming.json 的机器不碰配置，也不解压运行环境（用不到）；
 *  - 解压失败/缺文件就返回 null，回落到 npx 默认命令并让界面如实报错，
 *    绝不写一份指向不存在文件的配置；
 *  - 命令里路径带引号：安装目录可能在 Program Files（空格），splitCommand 支持引号。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { defaultStreamingConfig, type PlatformId } from '@shared/streaming'

/** 开发态：app/resources/runtime 里已经是解开的目录。 */
export function bundledRuntimeDir(appPath: string, resourcesPath: string): string | null {
  const candidates = [
    path.join(resourcesPath, 'runtime'),
    path.join(appPath, 'resources', 'runtime')
  ]
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'node.exe'))) return dir
  }
  return null
}

/** 打包态：resources/runtime.zip。 */
export function bundledRuntimeZip(appPath: string, resourcesPath: string): string | null {
  const candidates = [
    path.join(resourcesPath, 'runtime.zip'),
    path.join(appPath, 'resources', 'runtime.zip')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 准备可用的运行目录：
 *  - 开发态直接用 resources/runtime；
 *  - 打包态把 runtime.zip 解压到 userData/runtime（只解一次，版本变了重解）。
 * 返回 null 表示没有可用运行环境（走 npx 默认命令）。
 */
export function prepareBundledRuntime(options: {
  appPath: string
  resourcesPath: string
  userDataDir: string
  version: string
}): string | null {
  const source = bundledRuntimeDir(options.appPath, options.resourcesPath)
  if (source) return source

  const target = path.join(options.userDataDir, 'runtime')
  const marker = path.join(target, '.ready')
  const tag = 'v' + options.version
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === tag && existsSync(path.join(target, 'node.exe'))) {
    return target
  }

  const zip = bundledRuntimeZip(options.appPath, options.resourcesPath)
  if (!zip) return null
  try {
    mkdirSync(target, { recursive: true })
    // Windows 10 1803+ 自带 bsdtar，支持 zip；参数是固定的数组，不存在命令注入。
    const result = spawnSync('tar.exe', ['-xf', zip, '-C', target], { windowsHide: true })
    if (result.status !== 0) return null
    if (!existsSync(path.join(target, 'node.exe'))) return null
    writeFileSync(marker, tag, 'utf8')
    return target
  } catch {
    return null
  }
}

/** 两个平台服务端的入口文件（相对运行目录）。 */
const PROVIDER_ENTRIES: Partial<Record<PlatformId, string[]>> = {
  netease: ['node_modules', '@neteasecloudmusicapienhanced', 'api', 'app.js'],
  qq: ['node_modules', '@yakult-green-tea', 'qq-music-api', 'dist', 'src', 'app.js']
}

export function bundledProviderCommand(runtimeDir: string, platform: PlatformId): string | null {
  const parts = PROVIDER_ENTRIES[platform]
  if (!parts) return null
  const node = path.join(runtimeDir, 'node.exe')
  const entry = path.join(runtimeDir, ...parts)
  if (!existsSync(node) || !existsSync(entry)) return null
  return '"' + node + '" "' + entry + '"'
}

/**
 * 首次启动写一份指向内置运行环境的 streaming.json。
 * @returns 是否真的写了（配置已存在 / 运行环境不可用时 false）
 */
export function ensureBundledStreamingConfig(configFile: string, runtimeDir: string | null): boolean {
  if (existsSync(configFile) || !runtimeDir) return false
  const config = defaultStreamingConfig()
  let replaced = 0
  config.providers = config.providers.map(provider => {
    const command = bundledProviderCommand(runtimeDir, provider.platform)
    if (!command) return provider
    replaced += 1
    return { ...provider, command }
  })
  // 一个都没换成就别写：写一份跟默认 npx 一样的配置只会掩盖「运行环境没打进包」。
  if (replaced === 0) return false
  mkdirSync(path.dirname(configFile), { recursive: true })
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')
  return true
}
