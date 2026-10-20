const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')
app.getAppPath = () => path.join(__dirname, '..')
process.env.TWILIGHT_USER_DATA = path.join(__dirname, '../.smoke/qa/mock-profile')
process.env.MOCK_LOG = path.join(__dirname, '../.smoke/qa/mock-log.json')
// 需要先 pnpm build：它跑的是 out/main 的真实主进程。
require('../out/main/index.js')

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  const run = (e) => win.webContents.executeJavaScript(e)
  await delay(5000)
  const status = await run('window.twilight.streamingStatus()')
  console.log('runtimes = ' + JSON.stringify(status.runtimes.map(r => r.platform + ':' + r.state)))
  const net = status.runtimes.find(r => r.platform === 'netease')
  console.log('netease error = ' + JSON.stringify(net && net.error))
  console.log('netease log = ' + JSON.stringify(net && net.log))
  const ticket = await run("window.twilight.streamingQrStart('netease')")
  console.log('qrStart state=' + ticket.state)
  const poll = await run("window.twilight.streamingQrPoll('netease')")
  console.log('qrPoll state=' + poll.state)
  console.log('qrPoll session = ' + JSON.stringify(poll.session))
  try {
    const account = await run("window.twilight.streamingAccount('netease')")
    console.log('account = ' + JSON.stringify(account))
  } catch (error) {
    console.log('account 失败: ' + (error && error.message))
  }
  const raw = await fsp.readFile(process.env.MOCK_LOG, 'utf8').catch(() => '[]')
  const entries = JSON.parse(raw)
  const call = entries.filter(e => e.path === '/login/status').pop()
  console.log('mock 收到 header = ' + JSON.stringify(call && call.header))
  console.log('mock 收到 query  = ' + JSON.stringify(call && call.query))
  app.exit(0)
}).catch(e => { console.error('FATAL', e); app.exit(1) })
