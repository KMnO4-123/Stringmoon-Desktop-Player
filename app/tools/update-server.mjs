#!/usr/bin/env node
/**
 * tools/update-server.mjs —— 本地/自托管更新源（静态文件服务器）。
 *
 * electron-updater 的 generic provider 只需要一个能访问 latest.yml 与安装包的静态目录。
 * 这个脚本用于：
 *   - 本机演练「检查 → 下载 → 重启安装」全链路（不需要公网）；
 *   - 自托管时作为最小参考（生产可用 nginx/对象存储替代）。
 *
 * 用法：
 *   node tools/update-server.mjs --dir release --port 8787
 *   # 客户端：TWILIGHT_UPDATE_URL=http://127.0.0.1:8787/
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const dir = path.resolve(argOf('--dir', path.join(appDir, 'release')))
const port = Number(argOf('--port', '8787'))

const types = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8'
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'latest.yml'
  const file = path.resolve(dir, relative)
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + relative)
    return
  }
  const size = statSync(file).size
  res.writeHead(200, {
    'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': size
  })
  console.log('[update] ' + (req.method || 'GET') + ' ' + relative + ' (' + size + ' B)')
  createReadStream(file).pipe(res)
})

if (!existsSync(path.join(dir, 'latest.yml'))) {
  console.warn('[update] 警告：' + dir + ' 里没有 latest.yml；先跑 pnpm dist 生成安装包。')
}
server.listen(port, '127.0.0.1', () => {
  console.log('[update] 本地更新源: http://127.0.0.1:' + port + '/')
  console.log('[update] 客户端设置 TWILIGHT_UPDATE_URL=http://127.0.0.1:' + port + '/')
})
