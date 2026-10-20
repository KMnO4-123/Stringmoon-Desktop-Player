const { app, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const profile = path.join(__dirname, '../.smoke/startup/profile-' + (process.env.STRINGMOON_STARTUP_CASE || 'normal') + '-' + process.pid)
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile,'library.json'), JSON.stringify({directories:[]}))
app.setPath('userData', profile)
// 同 player-test-app：主进程只认 TWILIGHT_USER_DATA 注入的隔离目录。
process.env.TWILIGHT_USER_DATA = profile
app.getAppPath = () => path.join(__dirname, '..')
require('../out/main/index.js')
app.whenReady().then(() => {
  if (process.env.STRINGMOON_STARTUP_CASE === 'slow') {
    ipcMain.removeHandler('twilight:library-dirs')
    ipcMain.handle('twilight:library-dirs', () => new Promise(() => {}))
  }
})
