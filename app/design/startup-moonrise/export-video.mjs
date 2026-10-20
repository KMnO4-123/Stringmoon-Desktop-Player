import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./',import.meta.url))
const encoder = process.env.STARTUP_FFMPEG || `${process.env.LOCALAPPDATA}/ms-playwright/ffmpeg-1013/ffmpeg-win64.exe`
const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
try {
  const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1})
  await page.goto(new URL('preview.html?film=1&t=0',import.meta.url).href)
  await page.waitForFunction(()=>window.previewReady)
  const ffmpeg=spawn(encoder,['-y','-hide_banner','-loglevel','error','-f','image2pipe','-vcodec','mjpeg','-r','60','-i','pipe:0','-an','-c:v','libvpx-vp9','-crf','24','-b:v','0','-pix_fmt','yuv420p','-row-mt','1','-speed','4',root+'stringmoon-moonrise.webm'],{windowsHide:true})
  ffmpeg.stderr.on('data',chunk=>process.stderr.write(chunk))
  const done=once(ffmpeg,'exit')
  for(let i=0;i<252;i++){
    await page.evaluate(time=>window.motionPreview.seek(time),Math.min(3600,i*1000/60))
    const frame=await page.screenshot({type:'jpeg',quality:96})
    if(!ffmpeg.stdin.write(frame))await once(ffmpeg.stdin,'drain')
  }
  ffmpeg.stdin.end()
  const [code]=await done
  if(code!==0)throw new Error('Video encoding failed: '+code)
  console.log('WebM encoded at 60 fps')
  await page.goto('about:blank')
  const data=readFileSync(root+'stringmoon-moonrise.webm').toString('base64')
  const mp4=await page.evaluate(async data=>{
    const video=document.createElement('video')
    video.muted=true
    video.style.cssText='width:1280px;height:800px;position:fixed;inset:0'
    document.body.append(video)
    video.src='data:video/webm;base64,'+data
    await new Promise(resolve=>video.addEventListener('loadeddata',resolve,{once:true}))
    const recorder=new MediaRecorder(video.captureStream(),{mimeType:'video/mp4;codecs=avc1.42001E',videoBitsPerSecond:8_000_000})
    const chunks=[]
    recorder.ondataavailable=event=>chunks.push(event.data)
    const done=new Promise(resolve=>recorder.onstop=resolve)
    video.onended=()=>recorder.stop()
    recorder.start()
    await video.play()
    await done
    const blob=new Blob(chunks,{type:'video/mp4'})
    return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(blob)})
  },data)
  writeFileSync(root+'stringmoon-moonrise.mp4',Buffer.from(mp4,'base64'))
  console.log('MP4 exported: '+root+'stringmoon-moonrise.mp4')
} finally { await browser.close() }
