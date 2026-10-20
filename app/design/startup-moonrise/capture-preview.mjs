import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./',import.meta.url))
mkdirSync(root+'frames',{recursive:true})
const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1})
const errors=[]
page.on('pageerror',error=>errors.push(error.message))
await page.goto(new URL('preview.html?film=1&t=2050',import.meta.url).href)
await page.waitForFunction(()=>window.previewReady)
await page.screenshot({path:root+'hero.png'})
for(const time of [280,700,1150,2050,2600,2900,3120,3600]){
  await page.evaluate(t=>window.motionPreview.seek(t),time)
  await page.screenshot({path:root+`frames/key-${time}.png`})
}
const result={errors,phases:8,screenSizes:[]}
for(const size of [{width:900,height:600},{width:1280,height:800}]){
  await page.setViewportSize(size)
  await page.evaluate(()=>window.motionPreview.seek(2050))
  result.screenSizes.push(await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollX:document.documentElement.scrollWidth>innerWidth,scrollY:document.documentElement.scrollHeight>innerHeight})))
}
await page.evaluate(()=>window.motionPreview.seek(3590))
await page.evaluate(()=>window.motionPreview.play())
await page.waitForTimeout(100)
result.completedState=await page.evaluate(()=>window.motionPreview.state)
await page.evaluate(()=>window.motionPreview.setReduced(true))
await page.evaluate(()=>window.motionPreview.seek(650))
result.reducedMotion=await page.evaluate(()=>getComputedStyle(document.querySelector('.app-screen')).opacity)
await page.evaluate(()=>window.motionPreview.setReduced(false))
await page.evaluate(()=>window.motionPreview.seek(0))
await page.goto(new URL('preview.html?t=2050',import.meta.url).href)
await page.waitForFunction(()=>window.previewReady)
await page.setViewportSize({width:1440,height:1180})
await page.screenshot({path:root+'review-page.png',fullPage:true})
writeFileSync(root+'verification.json',JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
await browser.close()
