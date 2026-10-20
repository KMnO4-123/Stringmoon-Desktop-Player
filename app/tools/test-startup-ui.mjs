import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const cwd = fileURLToPath(new URL('..',import.meta.url))
const artifacts = fileURLToPath(new URL('../.smoke/startup/',import.meta.url))
mkdirSync(artifacts,{recursive:true})
const env = {...process.env,TWILIGHT_ENGINE:process.execPath,TWILIGHT_ENGINE_ARGS:fileURLToPath(new URL('startup-test-engine.mjs',import.meta.url))}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TWILIGHT_SMOKE
// 测试不联网：在线取词在这里被主进程直接短路。
env.TWILIGHT_OFFLINE = '1'
const results=[],errors=[]
let application,page
const check = (condition,label,details) => {assert.ok(condition,label+': '+JSON.stringify(details));results.push({label,details});console.log('PASS',label)}
async function launch(mode='normal'){
  console.log('STEP launch',mode)
  application=await _electron.launch({executablePath:require('electron'),args:['tools/startup-test-app.cjs'],cwd,env:{...env,STRINGMOON_STARTUP_CASE:mode},timeout:15000})
  application.process().stderr.on('data',chunk=>process.stderr.write(chunk))
  page=await application.firstWindow()
  page.on('pageerror',error=>errors.push(error.message))
  // 15s：本轮起启动路径多了音频偏好重下发/播放记忆读取等异步工作，冷启动在负载机器上
  // 偶发 >5s（实测过 renderer 7s 才挂 intro）；这只是等待上限，断言内容不变。
  // 用 attached 而不是默认的 visible：intro 挂载后可能先在 CSS 里不可见一小段时间，
  // 等 visible 会让 harness 晚 ~1s 才起步，后面的 entering/exiting 窗口被压缩（实测假红）。
  await page.locator('.startup-intro').waitFor({timeout:15000, state:'attached'}).catch(async error=>{
    console.log('STARTUP DIAGNOSTIC',await page.evaluate(()=>({ready:document.readyState,hidden:document.hidden,visibility:document.visibilityState,startup:document.querySelector('.app-window')?.dataset.startup,phase:document.querySelector('.startup-intro')?.dataset.phase,introCount:document.querySelectorAll('.startup-intro').length,box:(()=>{const el=document.querySelector('.startup-intro');if(!el)return null;const b=el.getBoundingClientRect();const s=getComputedStyle(el);return {x:b.x,y:b.y,w:b.width,h:b.height,display:s.display,visibility:s.visibility,opacity:s.opacity}})(),url:location.href,frames:null,viewport:{w:innerWidth,h:innerHeight},body:document.body.innerText.slice(0,200)})))
    throw error
  })
}
const size = async (width,height) => application.evaluate(({BrowserWindow},dimensions)=>BrowserWindow.getAllWindows()[0].setContentSize(...dimensions),[width,height])
try{
  await launch()
  // 900 宽几何检查放在 launch 后**立刻**做：此时 intro 一定还在 entering 阶段。
  // 以前它在「1280 截图 + 两次 resize」之后，慢机器上 intro 可能已经 exiting 甚至卸载，
  // querySelector('.startup-scene') 变成 null → TypeError 假红（verifier 复现的 harness 竞态）。
  // 几何只与视口/CSS 有关、与动画进度无关，提前做不改变断言内容。
  await size(900,600)
  const geometry=await page.evaluate(()=>{const scene=document.querySelector('.startup-scene');const box=scene.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scene:box.toJSON(),matrix:getComputedStyle(scene).transform}})
  check(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'startup fits a 900px window during the transition',geometry)
  await size(1280,800)
  check(await page.locator('.app-shell').evaluate(node=>node.inert),'application is inert behind the startup identity')
  check(await page.locator('.startup-intro img,.startup-intro video,.startup-intro canvas').count()===0,'startup uses inline SVG instead of screenshot, video or another canvas')
  await page.evaluate(()=>{globalThis.startupTestNode=document.querySelector('.startup-intro')})
  // 身份帧截图**立刻异步发起**（此时仍在 entering，animations 在跑）：
  //  - attach 检测在负载机器上会比 mount 晚 ~1s，再串行等 900ms + 截图编码（~0.6s），
  //    会把「退出中改窗口」的测量挤到 intro 已卸载之后 → hero=null 假红（已实测复现）。
  //  - 截图只作为人工留证、不参与断言；先发起、不 await，退出窗口留给真正的测量。
  const identityShot = page.screenshot({path:artifacts+'identity-1280.png'}).catch(() => undefined)
  // 一旦进入 exiting 就立刻改窗口并读场景目标（resize 本身触发 fit 重新对准唱片）。
  await page.locator('.startup-intro[data-phase="exiting"]').waitFor({timeout:4000})
  await size(900,600)
  await page.waitForTimeout(70)
  const resizedLanding=await page.evaluate(()=>{
    const hero=document.querySelector('.startup-hero')
    const end=hero.getAnimations()[0]?.effect.getKeyframes().at(-1).transform
    const target=`translate(${hero.style.getPropertyValue('--startup-land-x')}, ${hero.style.getPropertyValue('--startup-land-y')}) scale(${hero.style.getPropertyValue('--startup-land-scale')})`
    return {end,target}
  })
  const numbers=value=>value.match(/-?\d+(?:\.\d+)?/g).map(Number)
  check(numbers(resizedLanding.end).every((value,i)=>Math.abs(value-numbers(resizedLanding.target)[i])<.001),'resizing during exit retargets the disc to the live record bounds',resizedLanding)
  // 截图是异步发起的；等它编码落盘后再继续（只影响产物，不影响上面的测量窗口）。
  await identityShot
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:8000})
  check(await page.locator('.app-shell').evaluate(node=>!node.inert&&getComputedStyle(node).opacity==='1'),'normal completion reveals the live app and restores input')
  check(await page.evaluate(()=>globalThis.startupTestNode.getAnimations({subtree:true}).length===0),'completed startup cancels animations even on its retained DOM nodes')
  await page.locator('[data-view-target="library"]').click()
  await page.locator('[data-view-target="home"]').click()
  await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.hide();win.show()})
  check(await page.locator('.startup-intro').count()===0,'navigation and tray restore do not replay startup')
  await page.screenshot({path:artifacts+'complete-900.png'})
  await application.close()

  await launch()
  await page.getByRole('button',{name:'跳过启动动画'}).click()
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:5000})
  check(await page.locator('.app-shell').evaluate(node=>!node.inert),'skip releases the app immediately')
  await application.close()

  await launch()
  await page.keyboard.press('Escape')
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:5000})
  check(await page.locator('.app-shell').evaluate(node=>!node.inert),'Escape skips startup')
  await application.close()

  await launch()
  console.log('STEP hide during startup',await page.evaluate(()=>({hidden:document.hidden,phase:document.querySelector('.startup-intro')?.dataset.phase})))
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide())
  console.log('STEP hidden',await page.evaluate(()=>({hidden:document.hidden,phase:document.querySelector('.startup-intro')?.dataset.phase})))
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:5000})
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show())
  check(await page.locator('.startup-intro').count()===0,'hiding during startup cleans it up before the window is restored')
  await application.close()

  await launch()
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:1500})
  check(true,'changing reduced motion during startup stops spatial animation')
  await page.reload()
  // 超时只放宽等待预算，断言不变：负载机器上 renderer 挂载/还原媒体查询都可能 >1s。
  await page.locator('.startup-intro[data-reduced="true"]').waitFor({timeout:4000})
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:6000})
  check(await page.locator('.app-shell').evaluate(node=>!node.inert),'system reduced motion takes the short dissolve')
  await application.close()

  await launch()
  await page.addInitScript(()=>{
    const animate=Element.prototype.animate
    Element.prototype.animate=function(...args){
      if(this.closest('.startup-intro'))throw new Error('Startup animation unavailable')
      return animate.apply(this,args)
    }
  })
  await page.reload()
  await page.locator('.app-window[data-startup="complete"]').waitFor({timeout:8000})
  check(await page.locator('.app-shell').evaluate(node=>!node.inert),'unavailable animation support falls through to the usable app')
  await application.close()

  await launch('slow')
  await page.locator('.startup-intro[data-phase="holding"]').waitFor({timeout:12000})
  check(await page.locator('.startup-waiting').isVisible(),'slow bootstrap holds one static identity with a readable status')
  await page.screenshot({path:artifacts+'identity-hold.png'})
  await page.locator('.startup-intro').waitFor({state:'detached',timeout:15000})
  check(await page.locator('.app-shell').evaluate(node=>!node.inert),'a stalled bootstrap cannot trap the user behind the animation')
  check(errors.length===0,'startup has no renderer errors',errors)
  console.log('STARTUP CHECKS',results.length)
}finally{
  await application?.close()
  writeFileSync(artifacts+'result.json',JSON.stringify({checks:results.length,results,errors},null,2))
}
