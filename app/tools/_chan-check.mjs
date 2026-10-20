import { spawn } from 'node:child_process'
// 本机临时探针：用 NETESE_API_DIR 指向已装好的服务端包目录。
const pkgDir = process.env.NETESE_API_DIR ?? 'D:\\stream-verify\\node_modules\\@neteasecloudmusicapienhanced\\api'
const port = 39193
const api = spawn(process.execPath, [pkgDir + '\\app.js'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, cwd: pkgDir })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let up = false
const t0 = Date.now()
while (Date.now() - t0 < 40000) { await sleep(400); try { await fetch('http://127.0.0.1:' + port + '/'); up = true; break } catch {} }
if (!up) process.exit(1)
const base = 'http://127.0.0.1:' + port
const call = async (label, init) => {
  const r = await fetch(base + '/login/status', init)
  const v = await r.json().catch(() => null)
  const account = v?.data?.account ?? null
  console.log(label.padEnd(34) + ' status=' + r.status + '  account=' + (account ? account.id : 'null') + '  profile=' + (v?.data?.profile ? 'present' : 'null'))
}

await call('无 cookie', {})
// 头：宽容解析
await call('Cookie 头 MUSIC_U=BOGUS', { headers: { cookie: 'MUSIC_U=BOGUS' } })
// 头：值里带 '='（base64 填充），看是否保留
await call('Cookie 头 MUSIC_U=BOG=US', { headers: { cookie: 'MUSIC_U=BOG=US' } })
// query：有损解析
await call('?cookie=MUSIC_U=BOGUS', {})
const q = base + '/login/status?cookie=' + encodeURIComponent('MUSIC_U=BOGUS')
{ const r = await fetch(q); const v = await r.json().catch(() => null); console.log('?cookie=MUSIC_U=BOGUS'.padEnd(34) + ' status=' + r.status + '  account=' + (v?.data?.account ? v.data.account.id : 'null') + '  profile=' + (v?.data?.profile ? 'present' : 'null')) }
// 两者同时：query 会覆盖头
{ const r = await fetch(base + '/login/status?cookie=' + encodeURIComponent('MUSIC_U=BOGUS'), { headers: { cookie: 'MUSIC_U=SECOND' } }); const v = await r.json().catch(() => null); console.log('头+query 同时给'.padEnd(34) + ' status=' + r.status + '  account=' + (v?.data?.account ? v.data.account.id : 'null')) }
api.kill()
