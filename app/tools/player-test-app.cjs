// Run the production app with test-owned artwork preferences and Chromium storage.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const profile = path.join(__dirname, '../.smoke/player/profile')
app.setPath('userData', profile)
// main/index.ts 只在 TWILIGHT_USER_DATA 存在时才承认外部注入的 userData（2026-10-17 的
// 数据目录修复）。不设这个变量，上面那行会被主进程覆盖成 appData/twilight-echo-app，
// 于是测试读的 artwork.json 与主进程写的不是同一个文件 —— 这正是「封面选择没有持久化」那条假红。
process.env.TWILIGHT_USER_DATA = profile
app.getAppPath = () => path.join(__dirname, '..')
// 同 test-electron.cjs：窗口被遮挡时 Chromium 停发帧，会让 mode="wait" 的视图切换卡住。
// 测试要能在任何窗口叠放顺序下跑，所以对它关掉后台节流（产品行为不变）。
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
})
void BrowserWindow
require('../out/main/index.js')
