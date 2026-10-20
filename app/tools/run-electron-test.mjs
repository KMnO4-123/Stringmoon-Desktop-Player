import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.TWILIGHT_SMOKE
// 测试不联网：在线取词在这里被主进程直接短路。
env.TWILIGHT_OFFLINE = '1'
// 独立 userData：测试永远不碰开发者真实的歌单 / 覆盖 / 流媒体配置。
env.TWILIGHT_USER_DATA = fileURLToPath(new URL('../.smoke/qa/userdata/', import.meta.url))
mkdirSync(env.TWILIGHT_USER_DATA, { recursive: true })
delete env.ELECTRON_RENDERER_URL
mkdirSync(new URL('../.smoke/qa/', import.meta.url), { recursive: true })
writeFileSync(new URL('../.smoke/qa/result.json', import.meta.url), JSON.stringify({ checks: 0, failures: 1, status: 'running' }))
const log = createWriteStream(new URL('../.smoke/qa/electron.log', import.meta.url))
const child = spawn(require('electron'), ['tools/test-electron.cjs'], { cwd, env, windowsHide: true })
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => { process.stdout.write(chunk); log.write(chunk) })
}
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => {
  log.end()
  let failures = 1
  try { failures = JSON.parse(readFileSync(new URL('../.smoke/qa/result.json', import.meta.url), 'utf8')).failures } catch {}
  process.exitCode = code === 0 && failures === 0 ? 0 : 1
})
