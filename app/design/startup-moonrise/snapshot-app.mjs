import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
const require = createRequire(import.meta.url)
const cwd = fileURLToPath(new URL('../../',import.meta.url))
const env={...process.env}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TWILIGHT_SMOKE
mkdirSync(fileURLToPath(new URL('../../.smoke/startup-profile',import.meta.url)),{recursive:true})
const application=await _electron.launch({executablePath:require('electron'),args:['design/startup-moonrise/snapshot-app.cjs'],cwd,env,timeout:15000})
application.process().stderr.on('data',chunk=>process.stderr.write(chunk))
try {
  const page=await application.firstWindow()
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,800))
  await page.waitForFunction(()=>Boolean(window.twilight))
  await page.waitForTimeout(1200)
  const result=await page.evaluate(async()=>{
    const reply=await window.twilight.request({cmd:'list_tracks'})
    if(!reply.ok)throw new Error('Could not read library')
    const track=reply.data.tracks.find(t=>t.title!=='0001'&&t.title!=='test')
    if(!track)throw new Error('No display track')
    await window.twilight.request({cmd:'open',trackId:track.trackId})
    const snapshot=await window.twilight.request({cmd:'get_state'})
    return {title:track.title,artist:track.artist,snapshot:snapshot.data}
  })
  await application.evaluate(({BrowserWindow},snapshot)=>BrowserWindow.getAllWindows()[0].webContents.send('twilight:event',snapshot),result.snapshot)
  await page.waitForTimeout(450)
  await page.screenshot({path:fileURLToPath(new URL('app-screen.png',import.meta.url))})
  console.log(JSON.stringify({title:result.title,artist:result.artist,displayTitle:await page.locator('.track-hero-title').textContent()}))
}finally{await application.close()}
