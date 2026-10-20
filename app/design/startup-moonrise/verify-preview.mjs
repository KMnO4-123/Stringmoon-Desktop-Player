import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { writeFileSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('./',import.meta.url))
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
const errors=[]
try{
  const page=await browser.newPage({viewport:{width:1440,height:1180}})
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(new URL('preview.html?t=2050',import.meta.url).href)
  await page.waitForFunction(()=>window.previewReady)
  await page.getByRole('button',{name:'重新播放',exact:true}).click()
  await page.waitForTimeout(120)
  assert.equal(await page.evaluate(()=>window.motionPreview.state.running),true)
  await page.getByRole('button',{name:'暂停预览',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.motionPreview.state.running),false)
  await page.locator('.chapter').nth(2).click()
  assert.equal(await page.evaluate(()=>window.motionPreview.state.time),2050)
  await page.getByRole('button',{name:'跳过启动动画',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.motionPreview.state.time),3600)
  for(const reduced of [true,false]){
    await page.evaluate(reduced=>window.motionPreview.setReduced(reduced),reduced)
    await page.evaluate(()=>window.motionPreview.seek(1000))
    const visible=await page.evaluate(()=>getComputedStyle(document.querySelector('.app-screen')).opacity)
    assert.equal(visible,reduced?'1':'0')
  }
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.reload()
  await page.waitForFunction(()=>window.previewReady)
  assert.equal(await page.evaluate(()=>window.motionPreview.state.reduced),true)
  await page.emulateMedia({reducedMotion:'no-preference'})
  await page.goto(new URL('stringmoon-moonrise.mp4',import.meta.url).href)
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2)
  const video=await page.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=2.05;return {duration:v.duration,width:v.videoWidth,height:v.videoHeight}})
  await page.waitForTimeout(150)
  assert.equal(video.width,1280)
  assert.equal(video.height,800)
  assert.ok(video.duration>3.6&&video.duration<5)
  await page.screenshot({path:root+'video-check.png'})
  assert.deepEqual(errors,[])
  const result={checks:['replay','pause','chapter seek','skip','reduced motion','reduced motion reversal','system reduced motion','MP4 decode','video size','no browser errors'],video,bytes:statSync(root+'stringmoon-moonrise.mp4').size,errors}
  writeFileSync(root+'interaction-verification.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
}finally{await browser.close()}
