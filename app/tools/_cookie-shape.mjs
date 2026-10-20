import { spawn } from 'node:child_process'
// 本机临时探针：用 NETESE_API_DIR 指向已装好的服务端包目录。
const pkgDir = process.env.NETESE_API_DIR ?? 'D:\\stream-verify\\node_modules\\@neteasecloudmusicapienhanced\\api'
const port = 39197
const api = spawn(process.execPath, [pkgDir + '\\app.js'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, cwd: pkgDir })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let up = false
const t0 = Date.now()
while (Date.now() - t0 < 40000) { await sleep(400); try { await fetch('http://127.0.0.1:' + port + '/'); up = true; break } catch {} }
if (!up) process.exit(1)
const base = 'http://127.0.0.1:' + port
for (const path of ['/register/anonimous', '/login/status']) {
  const r = await fetch(base + path)
  const v = await r.json().catch(() => null)
  console.log('\n=== ' + path + ' ===')
  console.log('body.cookie = ' + JSON.stringify(v?.cookie))
  // 同时看响应头里的 Set-Cookie
  console.log('Set-Cookie 头 = ' + JSON.stringify(r.headers.getSetCookie ? r.headers.getSetCookie() : (r.headers.get('set-cookie') || '').slice(0, 300)))
}
api.kill()
