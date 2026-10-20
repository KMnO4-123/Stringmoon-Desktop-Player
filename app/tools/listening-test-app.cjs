const { app } = require('electron')
const path = require('node:path')
const profile = path.join(__dirname, '../.smoke/listening/profile')
app.setPath('userData', profile)
// 同 player-test-app：主进程只认 TWILIGHT_USER_DATA 注入的隔离目录。
process.env.TWILIGHT_USER_DATA = profile
app.getAppPath = () => path.join(__dirname, '..')
app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false))
require('../out/main/index.js')
