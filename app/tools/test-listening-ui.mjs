// Test-owned profiles and injected meter frames exercise the real preload and renderer.
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const cwd = fileURLToPath(new URL('..', import.meta.url))
const artifacts = fileURLToPath(new URL('../.smoke/listening/', import.meta.url))
mkdirSync(artifacts + '/profile', { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TWILIGHT_SMOKE
// 测试不联网：在线取词在这里被主进程直接短路。
env.TWILIGHT_OFFLINE = '1'
const fixtureLyrics = {
  wordByWord: true,
  source: 'local',
  lines: [
    { startMs: 0, endMs: 4000, text: '夜色沉入水底', words: [] },
    { startMs: 4000, endMs: 18000, text: '光在层与层之间呼吸', romanization: 'hikari', words: [] },
    { startMs: 18000, endMs: 100000, text: '逐字播放头测试', words: [{ startMs: 0, endMs: 100000, text: '逐字播放头测试' }] }
  ]
}
const results = []
const check = (condition, label, details) => {
  assert.ok(condition, label + (details ? ': ' + JSON.stringify(details) : ''))
  results.push({ label, details })
  console.log('PASS', label)
}
let app, page
const request = async command => {
  const response = await page.evaluate(command => window.twilight.request(command), command)
  assert.ok(response.ok, JSON.stringify(response))
  return response.data
}
const resize = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
  await page.waitForTimeout(400)
}
const injectMeter = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('twilight:event', {
  ev: 'meter', spectrum: Array.from({ length: 64 }, (_, i) => -14 - (i % 9) * 5),
  peakDb: [-6, -8], rmsDb: [-18, -20], truePeakDb: [-5, -7], truePeakBasis: 'oversampled', lufsMomentary: -16
}))
const centerDistance = () => page.evaluate(() => {
  const active = document.querySelector('.lyric-line.active').getBoundingClientRect()
  const scroll = document.querySelector('.lyrics-scroll').getBoundingClientRect()
  return Math.abs((active.top + active.bottom) / 2 - (scroll.top + scroll.bottom) / 2)
})
try {
  app = await _electron.launch({ executablePath: require('electron'), args: ['tools/listening-test-app.cjs'], cwd, env })
  page = await app.firstWindow()
  await page.locator('.app-window[data-startup="complete"]').waitFor()
  await app.evaluate(({ ipcMain }, lyrics) => {
    ipcMain.removeHandler('twilight:lyrics')
    ipcMain.handle('twilight:lyrics', async () => ({ lyrics, resolvedPath: 'test-fixture.lrc', source: 'sidecar', attachedUnavailable: false, offsetMs: 0 }))
  }, fixtureLyrics)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.locator('.track-row').first().waitFor({ timeout: 30000 })
  await request({ cmd: 'set_volume', volume: 0 })
  await request({ cmd: 'set_output', mode: 'shared' })
  await page.locator('.track-row').first().dblclick()
  await page.locator('.lyric-line').first().waitFor()
  await request({ cmd: 'seek', positionMs: 6000 })
  await request({ cmd: 'pause' })
  await page.waitForTimeout(350)
  const brand = await app.evaluate(({ app, BrowserWindow }) => ({ name: app.getName(), title: BrowserWindow.getAllWindows()[0].getTitle(), profile: app.getPath('userData') }))
  check(brand.name === 'Stringmoon' && brand.title === 'Stringmoon' && brand.profile.includes('listening'), 'Stringmoon branding preserves the explicitly isolated profile', brand)
  check(await page.locator('.brand-icon').evaluate(el => el.complete && el.naturalWidth === 64), 'the actual anime icon loads in the application')
  const ico = readFileSync(cwd + '/resources/stringmoon.ico')
  check(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 7, 'the Windows icon contains seven native sizes')

  for (const [w, h] of [[1280, 800], [900, 600]]) {
    await resize(w, h)
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect()
      const stage = rect('.listening-stage'), rail = rect('.listening-rail'), lyrics = rect('.home-lyrics')
      const scroll = rect('.lyrics-scroll'), source = rect('.lyrics-source'), cover = rect('.track-cover')
      const list = rect('.library-compact .track-list'), caption = rect('.rail-caption')
      return { stageRight: stage.right, stageBottom: stage.bottom, railLeft: rail.left, railRight: rail.right, lyricHeight: lyrics.height,
        scrollBottom: scroll.bottom, sourceTop: source.top, coverWidth: cover.width, coverHeight: cover.height,
        listHeight: list.height, listBottom: list.bottom, captionTop: caption.top, width: innerWidth, scrollWidth: document.documentElement.scrollWidth }
    })
    check(geometry.railLeft >= geometry.stageRight && geometry.railRight <= geometry.width && geometry.width === geometry.scrollWidth,
      `${w} × ${h}: artists and song preview are beside the listening stage`, geometry)
    check(geometry.lyricHeight >= (h === 800 ? 280 : 200) && geometry.scrollBottom <= geometry.sourceTop + 1,
      `${w} × ${h}: lyrics gain space without overlapping their source`, geometry)
    check(Math.abs(geometry.coverWidth - geometry.coverHeight) < 2, `${w} × ${h}: record sleeve remains square`, geometry)
    check(geometry.listHeight > 200 && geometry.captionTop >= geometry.listBottom, `${w} × ${h}: preview rows reserve real scrollable height`, geometry)
  }
  check(await page.locator('.lyric-word').first().evaluate(el => !getComputedStyle(el).backgroundImage.includes('rgba(0, 0, 0, 0)')),
    'unsung lyrics remain visibly readable')
  await page.locator('.lyrics-scroll').hover()
  await page.mouse.wheel(0, 200)
  await page.waitForFunction(() => document.querySelector('.lyrics').dataset.following === 'false')
  check(true, 'manual browsing releases automatic lyric following')
  await page.getByRole('button', { name: '跟随当前歌词', exact: true }).click()
  await page.waitForTimeout(450)
  check(await centerDistance() < 5, 'return to current centers the active lyric')
  await page.locator('.lyric-line').nth(2).click()
  await page.waitForTimeout(250)
  const afterLyric = await request({ cmd: 'get_state' })
  check(Math.abs(afterLyric.positionMs - 18000) < 500 && afterLyric.state === 'paused', 'clicking a lyric seeks the real engine without starting paused playback', afterLyric.positionMs)
  const beforeSize = await page.locator('.lyric-line.active').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
  await page.getByRole('button', { name: '大号歌词', exact: true }).click()
  const afterSize = await page.locator('.lyric-line.active').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
  check(afterSize > beforeSize, 'lyric type size is adjustable')
  await page.getByRole('button', { name: '大号歌词', exact: true }).click()

  await resize(1280, 800)
  const beforeWidth = await page.locator('.home-lyrics').evaluate(el => el.clientWidth)
  await page.getByRole('button', { name: '收放音乐探索', exact: true }).click()
  check(await page.locator('.home-lyrics').evaluate(el => el.clientWidth) > beforeWidth, 'collapsing discovery gives the space to lyrics')
  await page.waitForTimeout(450)
  check(await centerDistance() < 5, 'paused lyrics re-center when the layout resizes')
  await page.getByRole('button', { name: '收放音乐探索', exact: true }).click()
  await page.evaluate(() => { window.testCanvas = document.querySelector('.record-stage canvas'); window.testLyrics = document.querySelector('.lyrics'); document.activeElement?.blur() })
  await page.keyboard.press('f')
  await page.locator('.immersive-player').waitFor()
  await page.waitForTimeout(450)
  check(await page.evaluate(() => window.testCanvas === document.querySelector('.record-stage canvas') && window.testLyrics === document.querySelector('.lyrics')),
    'entering immersion preserves the record context and lyric DOM')
  check(await page.locator('.rail-slot').isHidden() && await page.locator('.listening-monitor').count() === 0,
    'immersion hides discovery and unmounts the extra meter consumer')
  check(await centerDistance() < 5, 'paused lyrics stay centered on entering immersion')
  const immersiveType = await page.locator('.lyric-line.active').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
  await page.getByRole('button', { name: '大号歌词', exact: true }).click()
  check(await page.locator('.lyric-line.active').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) > immersiveType,
    'large lyrics also increase the immersive type size')
  await page.getByRole('button', { name: '大号歌词', exact: true }).click()
  await page.getByRole('button', { name: '频谱光效', exact: true }).click()
  await page.getByRole('button', { name: '频谱光效', exact: true }).click()
  await request({ cmd: 'play' })
  await page.waitForFunction(() => document.querySelector('.spectrum-glow').dataset.state === 'waiting')
  check(true, 'no spectrum light is invented while waiting for audio data')
  const stateBeforeMeter = await request({ cmd: 'get_state' })
  await injectMeter()
  await page.waitForFunction(() => document.querySelector('.spectrum-glow').dataset.state === 'live')
  check(await page.locator('.spectrum-glow-curve').count() === 1 && Boolean((await page.locator('.spectrum-glow-curve').getAttribute('d'))?.startsWith('M')),
    'real preload meter events drive a bounded continuous spectrum curve')
  await page.getByRole('button', { name: '频谱光效', exact: true }).click()
  await injectMeter()
  await page.waitForTimeout(100)
  check(await page.locator('.spectrum-glow').getAttribute('data-state') === 'inactive', 'disabling glow stops consumption of meter frames')
  await page.getByRole('button', { name: '频谱光效', exact: true }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await injectMeter()
  await page.waitForTimeout(100)
  check(await page.locator('.spectrum-glow').isHidden(), 'reduced motion removes the spectrum effect at runtime')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // This host disables background throttling, which also forces Chromium visibility.
  // Dispatch the browser visibility signal deterministically to test component teardown.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  await injectMeter()
  await page.waitForTimeout(50)
  check(await page.locator('.spectrum-glow').getAttribute('data-state') === 'inactive', 'hidden windows unsubscribe from animated spectrum updates')
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await injectMeter()
  await page.waitForFunction(() => document.querySelector('.spectrum-glow').dataset.state === 'live')
  check(true, 'visible windows resume with the latest audio frame')
  const stateAfterMeter = await request({ cmd: 'get_state' })
  check(stateBeforeMeter.dspActive === stateAfterMeter.dspActive && JSON.stringify(stateBeforeMeter.dspModules) === JSON.stringify(stateAfterMeter.dspModules),
    'decorative monitoring never changes the processing chain')
  await request({ cmd: 'pause' })
  await page.waitForFunction(() => document.querySelector('.spectrum-glow').dataset.state === 'inactive')
  check(await page.locator('.spectrum-glow-curve').getAttribute('d') === '', 'pausing playback immediately clears the spectrum curve')
  await page.screenshot({ path: artifacts + '/immersive-1280.png' })
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Escape')
  await page.locator('.music-space:not(.immersive-player)').waitFor()
  await page.waitForTimeout(400)
  check(await page.evaluate(() => window.testCanvas === document.querySelector('.record-stage canvas')), 'exiting immersion keeps the same record renderer')
  // Drop injected QA samples before saving normal product screenshots.
  const firstTitle = await page.locator('.pb-title').textContent()
  await page.getByRole('button', { name: '下一首', exact: true }).click()
  await page.waitForFunction(title => document.querySelector('.pb-title').textContent !== title, firstTitle)
  await page.getByRole('button', { name: '上一首', exact: true }).click()
  await page.waitForFunction(title => document.querySelector('.pb-title').textContent === title, firstTitle)
  await request({ cmd: 'seek', positionMs: 18000 })
  await page.waitForTimeout(450)
  await page.screenshot({ path: artifacts + '/music-space-1280.png' })
  await resize(900, 600)
  await page.screenshot({ path: artifacts + '/music-space-900.png' })
  await page.locator('.source-controls summary').click()
  check((await page.locator('.source-menu').textContent()).includes('未接入') && await page.locator('.source-unavailable button').count() === 0,
    'unavailable streaming services are labeled without claiming connected playback')
  check(errors.length === 0, 'the new interactions produce no renderer exceptions', errors)
  await app.close()
  app = await _electron.launch({ executablePath: require('electron'), args: ['tools/branding-test-app.cjs'], cwd, env })
  await app.firstWindow()
  const legacyProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  check(legacyProfile.replaceAll('\\', '/').endsWith('/default-appdata/twilight-echo-app'),
    'the renamed default app continues to use the original library and cover profile', legacyProfile)
  writeFileSync(artifacts + '/result.json', JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
  console.log('LISTENING UI OK', results.length)
} catch (error) {
  try { await page?.screenshot({ path: artifacts + '/failure.png' }) } catch {}
  writeFileSync(artifacts + '/result.json', JSON.stringify({ ok: false, checks: results.length, error: String(error), results }, null, 2))
  throw error
} finally { await app?.close() }
