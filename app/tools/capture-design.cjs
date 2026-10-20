// Capture the normal app with its real lyric resolver. Audio stays muted.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
// Electron launches this helper as the app; restore the normal package root.
app.getAppPath = () => path.join(__dirname, '..')
require('../out/main/index.js')
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  const dir = path.join(__dirname, '../.smoke/design')
  fs.mkdirSync(dir, { recursive: true })
  const run = expression => win.webContents.executeJavaScript(expression)
  const wait = async expression => {
    for (let i = 0; i < 150; i++) {
      if (await run(expression)) return
      await delay(100)
    }
    throw new Error('UI did not settle: ' + expression)
  }
  const save = async name => {
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(dir, name + '.png'), image.toPNG())
    fs.writeFileSync(path.join(dir, name + '-mosaic.png'), image.resize({ width: 24, height: 16 }).resize({ width: 768, height: 512, quality: 'good' }).toPNG())
  }
  try {
    await wait('Boolean(document.querySelector(".track-row"))')
    await run('window.twilight.request({cmd:"set_volume",volume:0})')
    await run('window.twilight.request({cmd:"set_output",mode:"shared"})')
    await run('document.querySelector(".track-row").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
    await wait('Boolean(document.querySelector(".track-row.playing"))')
    win.setContentSize(1280, 800)
    await delay(800)
    await save('playing-1280')
    await run(`(() => { const el = document.querySelector('.pb-controls'); const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: r.left + r.width * 0.75, clientY: r.top + r.height * 0.25 })); })()`)
    await delay(300)
    await save('glass-controls-1280')
    await run('document.querySelector(".pb-controls").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }))')
    await run('window.twilight.request({cmd:"pause"})')
    await wait('!document.querySelector(".track-row.playing")')
    await save('paused-1280')
    win.setContentSize(900, 800)
    await delay(400)
    await save('paused-900')
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: true, source: 'built app, real engine, real lyric resolver' }))
    console.log('DESIGN CAPTURE OK', dir)
  } catch (error) {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, error: String(error) }))
    console.error(error)
  } finally {
    win.close()
  }
})
