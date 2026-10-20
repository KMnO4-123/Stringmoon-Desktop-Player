#!/usr/bin/env node
/**
 * tools/release.mjs —— 一条命令出安装包（2026-10-17 用户要求「出安装包 + 无痛升级」）。
 *
 * 做三件事，顺序固定：
 *   1. pnpm build（electron-vite：main/preload/renderer）；
 *   2. electron-builder --win nsis --x64（输出到 app/release/）；
 *   3. 对安装包/latest.yml/blockmap 计算 SHA256 写 SHA256SUMS.txt（自托管更新也建议带上）。
 *
 * 用法：
 *   node tools/release.mjs              # 完整出包
 *   node tools/release.mjs --skip-build # 只打包（out/ 已经构建过）
 *   node tools/release.mjs --dir        # 只出未安装目录，快速验证资源布局
 *
 * 注意：appId 一旦发布永不修改；版本号在 app/package.json 的 version 里改。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(appDir, 'release')
const skipBuild = process.argv.includes('--skip-build')
const dirOnly = process.argv.includes('--dir')

const run = (command, args, label) => {
  console.log('[release] ' + label + ': ' + command + ' ' + args.join(' '))
  execFileSync(command, args, { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' })
}

if (!skipBuild) run('pnpm', ['build'], '构建应用')
run('pnpm', ['exec', 'electron-builder', '--win', dirOnly ? '--dir' : 'nsis', '--x64'], dirOnly ? '出未安装目录' : '出 NSIS 安装包')

if (dirOnly) {
  const unpacked = path.join(releaseDir, 'win-unpacked')
  console.log('[release] 未安装目录: ' + unpacked)
  const engine = path.join(unpacked, 'resources', 'engine', 'bin', 'twilight-engine.exe')
  console.log('[release] 引擎: ' + (existsSync(engine) ? 'OK ' + engine : '缺失！'))
  process.exit(existsSync(engine) ? 0 : 2)
}

const targets = readdirSync(releaseDir)
  .filter((name) => /\.(exe|yml|blockmap)$/i.test(name))
  .map((name) => path.join(releaseDir, name))
  .filter((file) => statSync(file).isFile())
if (targets.length === 0) {
  console.error('[release] 没有找到安装产物，请检查 electron-builder 输出。')
  process.exit(2)
}

const lines = targets
  .sort()
  .map((file) => {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
    const size = statSync(file).size
    console.log('[release] ' + path.basename(file) + '  ' + (size / 1024 / 1024).toFixed(1) + ' MB  ' + hash)
    return hash + '  ' + path.basename(file)
  })
writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8')

console.log('')
console.log('[release] 完成。下一步：')
console.log('  1) 自托管更新：把 release/ 里的 .exe + latest.yml + .blockmap 上传到静态目录；')
console.log('  2) 客户端更新源：设置环境变量 TWILIGHT_UPDATE_URL=https://<你的目录>/ ，')
console.log('     或把 { "url": "https://<你的目录>/" } 写到 %APPDATA%\\twilight-echo-app\\update-feed.json；')
console.log('  3) 本地演练：pnpm update-server -- --dir release，然后在客户端把环境变量指到它打印的地址。')
