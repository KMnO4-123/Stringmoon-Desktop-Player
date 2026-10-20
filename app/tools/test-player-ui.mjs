// Real Electron + Playwright interaction and pixel checks. The native engine stays muted.
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const cwd = fileURLToPath(new URL('..', import.meta.url))
const artifacts = fileURLToPath(new URL('../.smoke/player/', import.meta.url))
mkdirSync(artifacts, { recursive: true })
mkdirSync(artifacts + '/profile', { recursive: true })
writeFileSync(artifacts + '/profile/artwork.json', '{}')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TWILIGHT_SMOKE
// 测试不联网：在线取词在这里被主进程直接短路。
env.TWILIGHT_OFFLINE = '1'
const results = []
let electronApp
let page
const check = (condition, label, details) => {
  assert.ok(condition, label + (details ? ': ' + JSON.stringify(details) : ''))
  results.push({ label, ...(details ? { details } : {}) })
  console.log('PASS', label)
}
const request = async command => {
  const result = await page.evaluate(command => window.twilight.request(command), command)
  assert.ok(result.ok, JSON.stringify(result))
  return result.data
}
const resize = async (width, height) => {
  await electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
  await page.waitForTimeout(200)
  console.log('WINDOW', { target: [width, height], content: await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()), viewport: await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]) })
  await page.waitForTimeout(500)
}
const navigate = async (name, selector) => {
  await page.locator(`[data-view-target="${name}"]`).click()
  await page.locator(selector).waitFor({ state: 'visible' })
  await page.waitForTimeout(650)
}
const capture = name => page.screenshot({ path: artifacts + '/' + name + '.png' })
const pixels = async buffer => electronApp.evaluate(({ nativeImage }, base64) => {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
  const bytes = image.getBitmap()
  let min = 255, max = 0, sum = 0, sum2 = 0
  for (let i = 0; i < bytes.length; i += 4) {
    const level = (bytes[i] + bytes[i + 1] + bytes[i + 2]) / 3
    min = Math.min(min, level); max = Math.max(max, level)
    sum += level; sum2 += level * level
  }
  const count = bytes.length / 4
  return { ...image.getSize(), min, max, variance: sum2 / count - (sum / count) ** 2 }
}, buffer.toString('base64'))
const pixelDelta = async (one, two) => electronApp.evaluate(({ nativeImage }, [first, second]) => {
  const a = nativeImage.createFromBuffer(Buffer.from(first, 'base64')).getBitmap()
  const b = nativeImage.createFromBuffer(Buffer.from(second, 'base64')).getBitmap()
  if (a.length !== b.length) return Infinity
  let difference = 0
  for (let i = 0; i < a.length; i += 4) difference += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
  return difference / (a.length / 4 * 3)
}, [one.toString('base64'), two.toString('base64')])
try {
  electronApp = await _electron.launch({ executablePath: require('electron'), args: ['tools/player-test-app.cjs'], cwd, env, timeout: 30000 })
  page = await electronApp.firstWindow()
  await page.locator('.app-window[data-startup="complete"]').waitFor()
  const rendererErrors = []
  page.on('pageerror', error => rendererErrors.push(String(error)))
  await page.locator('.music-space .track-row').first().waitFor({ timeout: 30000 })
  await resize(1280, 800)
  if (await page.getByLabel('歌曲主题色跟随').getAttribute('aria-pressed') !== 'true') await page.getByLabel('歌曲主题色跟随').click()
  await request({ cmd: 'set_volume', volume: 0 })
  await request({ cmd: 'set_output', mode: 'shared' })
  await page.locator('.music-space .track-row').first().dblclick()
  await page.locator('.track-row.playing').waitFor()
  await page.waitForTimeout(800)
  check(await page.locator('.record-stage--fallback').count() === 0, 'real WebGL record is available')
  const record = page.locator('.record-stage')
  const firstFrame = await record.screenshot()
  const stats = await pixels(firstFrame)
  check(stats.max - stats.min > 80 && stats.variance > 100, '3D record contains rendered geometry and lighting', stats)
  await page.waitForTimeout(350)
  const secondFrame = await record.screenshot()
  check(!createHash('sha256').update(firstFrame).digest().equals(createHash('sha256').update(secondFrame).digest()), 'playing record changes actual pixels')
  await request({ cmd: 'pause' })
  await page.waitForTimeout(100)
  const bounds = await record.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.waitForTimeout(1100)
  const centered = await record.screenshot()
  await page.mouse.move(bounds.x + bounds.width * 0.85, bounds.y + bounds.height * 0.25)
  await page.waitForTimeout(450)
  const tilted = await record.screenshot()
  check(!createHash('sha256').update(centered).digest().equals(createHash('sha256').update(tilted).digest()), 'pointer parallax changes the actual 3D frame')
  await page.mouse.move(bounds.x - 20, bounds.y - 20)
  await page.waitForTimeout(1400)
  const reset = await record.screenshot()
  const returnDelta = await pixelDelta(centered, reset)
  const motionDelta = await pixelDelta(centered, tilted)
  check(returnDelta < motionDelta * 0.25, '3D pointer tilt springs back toward rest', { returnDelta, motionDelta })
  await request({ cmd: 'play' })
  const collisions = await page.evaluate(() => {
    const stage = document.querySelector('.listening-stage').getBoundingClientRect()
    const chart = document.querySelector('.frequency-panel').getBoundingClientRect()
    const lyric = document.querySelector('.home-lyrics').getBoundingClientRect()
    return { chartRight: chart.right, lyricLeft: lyric.left, lyricHeight: lyric.height, chartWidth: chart.width, stageWidth: stage.width, lyricBottom: lyric.bottom, stageBottom: stage.bottom }
  })
  check(collisions.chartRight <= collisions.lyricLeft && collisions.lyricHeight >= 160 && collisions.chartWidth < collisions.stageWidth / 2 && collisions.lyricBottom <= collisions.stageBottom + 1, 'compact EQ leaves a bounded dedicated lyric column', collisions)
  await capture('music-space-1280')

  await navigate('sound', '.sound-page .frequency-plot[data-response-ready="true"]')
  await page.getByLabel('中声道增益', { exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => !document.querySelector('.sound-stage-heading .frequency-status').textContent.includes('正在'))
  await page.getByLabel('交叉馈送预设', { exact: true }).selectOption('1')
  await page.getByLabel('耳机交叉馈送', { exact: true }).check()
  await page.waitForFunction(() => !document.querySelector('.sound-stage-heading .frequency-status').textContent.includes('正在'))
  const stageState = await request({ cmd: 'get_state' })
  check(stageState.dsp?.channels?.midGainDb === 0.5, 'mid-side control reaches the engine and reads back')
  check(stageState.dsp?.crossfeed?.enabled && stageState.dsp.crossfeed.preset === 1,
    'crossfeed preset and enable control reach the engine', stageState.dsp?.crossfeed)
  check(stageState.dspActive && stageState.dspModules.includes('midSide') && stageState.dspModules.includes('crossfeed'),
    'active sound-stage modules are reported by the engine', stageState.dspModules)
  check(stageState.dsp?.passthrough === false, 'active sound-stage processing clears the DSP passthrough state')
  const rejectedStage = await page.evaluate(() => window.twilight.request({ cmd: 'set_channels', midGainDb: 2, sideGainDb: 13 }))
  check(!rejectedStage.ok && rejectedStage.error.code === 'ERR_STATE', 'an invalid combined sound-stage patch is rejected')
  const unchangedStage = await request({ cmd: 'get_state' })
  check(unchangedStage.dsp?.channels?.midGainDb === stageState.dsp.channels.midGainDb,
    'a rejected sound-stage patch leaves every previous value intact')
  await request({ cmd: 'set_channels', midGainDb: 0, crossfeedEnabled: false })
  await page.getByRole('button', { name: '归零', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="均衡器预设"]').value === '平直' && !document.querySelector('.frequency-status').textContent.includes('正在'))
  await page.waitForTimeout(450)
  const flat = await page.locator('.frequency-response-line').getAttribute('d')
  await page.getByLabel('均衡器预设', { exact: true }).selectOption('人声')
  await page.waitForFunction(() => document.querySelector('[aria-label="1000 Hz 增益"]').value === '3' && !document.querySelector('.frequency-status').textContent.includes('正在'))
  await page.waitForTimeout(550)
  const state = await request({ cmd: 'get_state' })
  check(state.dsp?.eq.enabled && state.dsp.eq.bands.find(b => b.freq === 1000)?.gainDb === 3, 'preset UI reaches the actual native EQ', state.dsp?.eq)
  const shaped = await page.locator('.frequency-response-line').getAttribute('d')
  check(shaped !== flat && !/NaN|Infinity/.test(shaped), 'frequency response changes with confirmed EQ parameters')
  const plot = await page.locator('.frequency-plot').evaluate(el => ({ css: el.getBoundingClientRect().width, view: el.viewBox.baseVal.width }))
  check(Math.abs(plot.css - plot.view) < 1, 'frequency chart coordinates match actual width', plot)
  await capture('frequency-response-1280')
  await page.getByLabel('1000 Hz 增益', { exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => !document.querySelector('.frequency-status').textContent.includes('正在'))
  const changed = await request({ cmd: 'get_state' })
  check(changed.dsp.eq.bands.find(b => b.freq === 1000).gainDb !== 3, 'keyboard EQ adjustment is sent to the engine')
  check(await page.locator('.frequency-history-line').count() > 0, 'confirmed response history renders a waterfall trail')
  await page.getByRole('button', { name: '频响轨迹', exact: true }).click()
  check(await page.locator('.frequency-history-line').count() === 0, 'response history can be hidden')
  await page.getByRole('button', { name: '频响轨迹', exact: true }).click()

  await navigate('library', '.library-title')
  await page.getByRole('button', { name: '艺术家瀑布', exact: true }).click()
  await page.locator('.artist-masonry .artist-card').first().waitFor()
  await page.waitForTimeout(750)
  const heights = await page.locator('.artist-masonry .artist-sleeve').evaluateAll(nodes => nodes.map(n => Math.round(n.getBoundingClientRect().height)))
  check(new Set(heights).size > 1, 'artist masonry has varied card proportions', heights)
  const artworkStats = await pixels(await page.locator('.artist-masonry .artist-sleeve').first().screenshot())
  check(artworkStats.variance > 50, 'artist typography artwork is visibly rendered', artworkStats)
  await capture('artist-waterfall-1280')
  const artist = await page.locator('.artist-masonry .artist-name').first().textContent()
  const card = page.locator('.artist-masonry .artist-card').first()
  const cardBounds = await card.boundingBox()
  await page.mouse.move(cardBounds.x + cardBounds.width / 2, cardBounds.y + cardBounds.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(180)
  const pressed = await card.evaluate(node => getComputedStyle(node).transform)
  check(pressed !== 'none' && Number(pressed.match(/^matrix\(([^,]+)/)?.[1]) < 1, 'artist press has visible spring scale feedback', pressed)
  await page.mouse.up()
  await page.locator('.track-row').first().waitFor()
  check(await page.locator('.library-title').textContent() === artist, 'artist card opens the matching song collection')
  const artists = await page.locator('.track-artist').allTextContents()
  check(artists.every(name => name === artist), 'artist filter contains only matching songs', { artist, tracks: artists.length })

  await resize(900, 600)
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.playbar').getBoundingClientRect()
    const progress = document.querySelector('.progress-track').getBoundingClientRect()
    const right = document.querySelector('.pb-right').getBoundingClientRect()
    return { viewport: innerWidth, body: document.documentElement.scrollWidth, barBottom: bar.bottom, viewportHeight: innerHeight, progressRight: progress.right, controlsLeft: right.left }
  })
  check(geometry.body === geometry.viewport && geometry.barBottom <= geometry.viewportHeight + 1 && geometry.progressRight < geometry.controlsLeft, '900 × 600 window keeps playback controls separated and visible', geometry)
  await page.getByRole('button', { name: '信号路径', exact: true }).click()
  const popover = await page.locator('.signal-popover').boundingBox()
  check(popover.x >= 0 && popover.x + popover.width <= 901 && popover.y >= 0, 'signal popover fits the minimum window', popover)
  await page.getByRole('button', { name: '信号路径', exact: true }).click()
  await page.getByRole('button', { name: '播放详情', exact: true }).click()
  const details = await page.locator('.detail-popover').boundingBox()
  check(details.x >= 0 && details.x + details.width <= geometry.viewport && details.y >= 0, 'detailed playback console fits the minimum window', details)
  const beforePosition = await page.getByTestId('detail-position').textContent()
  await page.waitForTimeout(400)
  check(await page.getByTestId('detail-position').textContent() !== beforePosition, 'detail position advances from native engine events')
  const output = await request({ cmd: 'get_state' })
  const detailText = await page.locator('.detail-popover').textContent()
  check(detailText.includes(output.deviceName) && detailText.includes(`${output.sampleRate / 1000} kHz`), 'playback details show the actual output device and sample rate')
  check(detailText.includes(`${output.containerBits || '—'} / ${output.validBits || '—'} bit`), 'output precision uses reported container and valid bits, never source bit depth')
  await capture('playback-details-900')
  await page.getByRole('button', { name: '播放详情', exact: true }).click()
  await navigate('home', '.music-space')
  const smallHome = await page.evaluate(() => {
    const chart = document.querySelector('.frequency-panel').getBoundingClientRect()
    const lyrics = document.querySelector('.home-lyrics').getBoundingClientRect()
    const bar = document.querySelector('.playbar').getBoundingClientRect()
    return { chartBottom: chart.bottom, lyricsTop: lyrics.top, lyricsBottom: lyrics.bottom, lyricHeight: lyrics.height, barTop: bar.top }
  })
  check(smallHome.chartBottom <= smallHome.barTop + 1 && smallHome.lyricsTop + 100 < smallHome.barTop && smallHome.lyricHeight >= 120 && smallHome.lyricsBottom <= smallHome.barTop + 1,
    'minimum window shows compact response and lyrics together', smallHome)
  await capture('music-space-900')
  // 沉浸播放不再是左栏一项（用户要求左栏只有 7 个功能栏），
  // 它是播放栏那个按钮进入的展示模式 —— 测试跟着产品的真实入口走。
  await page.locator('.playbar .pb-btn.immersive-toggle').click()
  await page.locator('.immersive-player').waitFor()
  await page.waitForTimeout(900)
  const immersiveStats = await pixels(await page.locator('.record-stage').screenshot())
  check(immersiveStats.variance > 100, 'immersive mode renders the 3D record at minimum size', immersiveStats)
  const lyricsGeometry = await page.evaluate(() => ({ sourceTop: document.querySelector('.immersive-lyrics .lyrics-source')?.getBoundingClientRect().top ?? Infinity,
    scrollBottom: document.querySelector('.immersive-lyrics .lyrics-scroll')?.getBoundingClientRect().bottom ?? 0,
    viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, lyrics: document.querySelector('.immersive-lyrics .lyrics').getBoundingClientRect().toJSON() }))
  check(lyricsGeometry.scrollBottom <= lyricsGeometry.sourceTop + 1 && lyricsGeometry.scrollWidth === lyricsGeometry.viewport && lyricsGeometry.lyrics.right <= lyricsGeometry.viewport,
    'minimum-window immersive lyrics fit without source overlap', lyricsGeometry)
  await capture('immersive-900')
  await resize(1280, 800)
  await capture('immersive-1280')
  await page.keyboard.press('Escape')
  await page.locator('.music-space').waitFor()
  check(true, 'Escape returns from immersive mode')

  await request({ cmd: 'pause' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(800)
  const still = await page.locator('.record-stage').screenshot()
  await page.waitForTimeout(250)
  const stillLater = await page.locator('.record-stage').screenshot()
  check(createHash('sha256').update(still).digest().equals(createHash('sha256').update(stillLater).digest()), 'reduced motion produces a stable paused record')

  // A clearly labeled test image exercises the real local picker/IPC/persistence boundary.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const testCover = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#b85b35'; ctx.fillRect(0, 0, 400, 400)
    ctx.fillStyle = '#f2e9db'; ctx.font = '34px sans-serif'; ctx.fillText('ARTWORK TEST', 32, 100)
    ctx.font = '18px sans-serif'; ctx.fillText('Local image / QA fixture', 32, 142)
    ctx.beginPath(); ctx.arc(280, 290, 100, 0, Math.PI * 2); ctx.fill()
    return canvas.toDataURL('image/png')
  })
  const coverFile = artifacts + '/cover-fixture.png'
  writeFileSync(coverFile, Buffer.from(testCover.split(',')[1], 'base64'))
  await electronApp.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, coverFile)
  const beforeCoverState = await request({ cmd: 'get_state' })
  const firstTitle = await page.locator('.pb-title').textContent()
  await page.locator('.track-cover').hover()
  await page.getByLabel('设置歌曲封面', { exact: true }).click()
  await page.locator('.track-cover img').waitFor()
  await page.waitForFunction(() => document.querySelector('.track-cover img')?.naturalWidth > 0)
  check(await page.locator('.pb-thumb img').count() === 1, 'selected local cover appears in both stage and playbar')
  const list = await request({ cmd: 'list_tracks' })
  const currentTrack = list.tracks.find(track => track.trackId === beforeCoverState.trackId)
  const saved = JSON.parse(readFileSync(artifacts + '/profile/artwork.json', 'utf8'))
  check(saved[currentTrack.path] === coverFile, 'cover choice persists without modifying the song')
  await page.waitForFunction(() => Number(document.querySelector('.app-shell').style.getPropertyValue('--track-hue')) < 40)
  const followed = await page.locator('.progress-fill').evaluate(node => getComputedStyle(node).backgroundColor)
  await page.getByLabel('歌曲主题色跟随').click()
  const neutral = await page.locator('.progress-fill').evaluate(node => getComputedStyle(node).backgroundColor)
  check(followed !== neutral, 'theme follows image pixels and can be disabled')
  await page.getByLabel('歌曲主题色跟随').click()
  await capture('custom-cover-1280')
  await page.getByRole('button', { name: '下一首', exact: true }).click()
  await page.waitForFunction(title => document.querySelector('.pb-title').textContent !== title, firstTitle)
  await page.waitForTimeout(800)
  check(await page.locator('.cover-record-set').count() === 1 && await page.locator('.track-cover img').count() === 0, 'track transition releases the old cover and record')
  await page.getByRole('button', { name: '上一首', exact: true }).click()
  await page.waitForFunction(title => document.querySelector('.pb-title').textContent === title, firstTitle)
  await page.locator('.track-cover img').waitFor()
  await page.waitForTimeout(800)
  check(await page.locator('.cover-record-set').count() === 1, 'returning to a song restores its selected cover after transition')

  // 移除自定义封面：只删映射回到自动读取（本参考库 91 首无嵌入封面 → 字形封面）。
  // 移除入口只在「当前显示的是用户自己选的图」时出现，嵌入图/同名图没有可撤销的东西。
  await page.locator('.track-cover').hover()
  const removeButton = page.getByLabel('移除自定义封面', { exact: true })
  await removeButton.waitFor()
  check(await removeButton.count() === 1, 'a custom cover can be removed from the UI')
  await removeButton.click()
  await page.waitForFunction(() => !document.querySelector('.track-cover img'))
  const cleared = JSON.parse(readFileSync(artifacts + '/profile/artwork.json', 'utf8'))
  check(!(currentTrack.path in cleared), 'removing the custom cover drops its mapping')
  check(await page.locator('.track-cover-fallback').count() === 1, 'removal falls back to the typographic cover')
  check(await page.locator('.pb-thumb img').count() === 0, 'the playbar thumbnail follows the removal too')
  // 撤销之后没有自定义映射了，入口必须自己消失 —— 否则用户会以为还能再移除一次。
  check(await page.getByLabel('移除自定义封面', { exact: true }).count() === 0, 'the removal entry disappears once nothing custom is left')
  await page.locator('.track-cover').hover()
  check(await page.getByLabel('设置歌曲封面', { exact: true }).count() === 1, 'the add-cover entry remains available afterwards')
  await capture('cover-removed-1280')
  await request({ cmd: 'set_volume', volume: 0.2 })
  await page.waitForFunction(() => document.querySelector('[aria-label="音量"]').value === '0.2')
  const muteButton = page.locator('.volume-icon')
  const sliderValue = () => page.locator('[aria-label="音量"]').inputValue()
  await muteButton.click()
  await page.waitForFunction(() => document.querySelector('.volume')?.classList.contains('muted'))
  const muted = await request({ cmd: 'get_state' })
  check(muted.muted === true, 'mute is executed by the engine (state.muted is true)')
  check(Math.abs(muted.volume - 0.2) < 0.001, 'muting does NOT change the volume the engine reports')
  check(await sliderValue() === '0.2', 'the volume slider stays at the level the user chose instead of being zeroed')
  check(await muteButton.getAttribute('aria-pressed') === 'true', 'the muted state is exposed to assistive tech')
  await muteButton.click()
  await page.waitForFunction(() => document.querySelector('.volume')?.classList.contains('muted') === false)
  const unmuted = await request({ cmd: 'get_state' })
  check(unmuted.muted === false && Math.abs(unmuted.volume - 0.2) < 0.001, 'unmuting leaves the volume untouched (nothing was "restored")')
  // 静音状态下动音量 = 显然想听见声音 → 一步显式取消静音（不是隐含副作用）
  await muteButton.click()
  await page.waitForFunction(() => document.querySelector('.volume')?.classList.contains('muted'))
  await page.locator('[aria-label="音量"]').fill('0.35')
  await page.waitForFunction(() => document.querySelector('.volume')?.classList.contains('muted') === false)
  check((await request({ cmd: 'get_state' })).muted === false, 'moving the volume explicitly unmutes')
  await request({ cmd: 'set_volume', volume: 0 })

  // 循环模式四态：客户端循环，但**引擎是权威** —— 每一态都回读 get_state 确认
  const repeatButton = page.locator('.pb-btn.repeat')
  check(((await repeatButton.getAttribute('aria-label')) ?? '').includes('顺序播放'), 'the repeat control starts at 顺序播放')
  const cycle = [['all', '列表循环'], ['one', '单曲循环'], ['shuffle', '随机播放'], ['sequential', '顺序播放']]
  for (const entry of cycle) {
    const mode = entry[0]
    const label = entry[1]
    await repeatButton.click()
    await page.waitForFunction((l) => (document.querySelector('.pb-btn.repeat')?.getAttribute('aria-label') ?? '').includes(l), label)
    check((await request({ cmd: 'get_state' })).repeatMode === mode, 'clicking through reports ' + label + ' and the engine confirms ' + mode)
  }
  check(await repeatButton.getAttribute('aria-label') !== null && !(await repeatButton.evaluate((el) => el.classList.contains('active'))), 'a default repeat mode is not shown as active')

  // 输出模式偏好：请求与实际模式分开显示，实际模式取自引擎
  await page.locator('[aria-label="信号路径"]').click()
  await page.waitForFunction(() => Boolean(document.querySelector('.output-mode')))
  check(await page.locator('.output-mode button').count() === 3, 'the signal panel offers 自动 / 独占 / 共享')
  await page.locator('.output-mode button', { hasText: '共享' }).click()
  await page.waitForFunction(() => document.querySelector('.output-mode button[aria-pressed="true"]')?.textContent === '共享')
  const afterShare = await request({ cmd: 'get_state' })
  check(afterShare.outputMode === 'shared', 'the engine reports the actual mode after switching')
  // 弹层里现在有两段 <p>（请求/实际流率 + 实际输出模式），按顺序取会取错 —— 用类名定位。
  const modeText = (await page.locator('.signal-popover .mode-summary').textContent()) ?? ''
  check(afterShare.degradeReason ? modeText === afterShare.degradeReason : modeText === (afterShare.outputMode === 'shared' ? '当前：共享输出' : '当前：独占输出'),
    'the panel states the ACTUAL mode (or the degradation reason), not the requested one')
  await page.keyboard.press('Escape')

  // 真引擎的输出 tap 应驱动画面；即使主音量为零，也会收到真实的静音样本窗口。
  await page.locator('[data-view-target="home"]').click()
  const spectrum = page.locator('.spectrum-panel')
  await spectrum.waitFor()
  const playbackAtHome = await request({ cmd: 'get_state' })
  if (playbackAtHome.state !== 'playing') await request({ cmd: 'play' })
  await page.waitForFunction(() => document.querySelector('.spectrum-line')?.getAttribute('d')?.startsWith('M'))
  const measuredCurve = await spectrum.locator('.spectrum-line').getAttribute('d')
  check(typeof measuredCurve === 'string' && measuredCurve.split(' C').length === 48,
    'the real engine meter produces one smooth segment for each measured band')
  check(await spectrum.locator('.spectrum-empty').count() === 0, 'a real meter frame clears the empty state')
  await page.evaluate(() => {
    globalThis.__meterFrames = 0
    window.twilight.onEvent(event => { if (event.ev === 'meter') ++globalThis.__meterFrames })
  })
  await page.waitForFunction(() => globalThis.__meterFrames > 1)
  for (const action of ['hide', 'minimize']) {
    await electronApp.evaluate(({ BrowserWindow }, method) => BrowserWindow.getAllWindows()[0][method](), action)
    await page.waitForTimeout(150)
    const hiddenCount = await page.evaluate(() => globalThis.__meterFrames)
    const hiddenPosition = await request({ cmd: 'get_state' })
    await page.waitForTimeout(200)
    check(await page.evaluate(() => globalThis.__meterFrames) === hiddenCount,
      `${action} stops live meter IPC`)
    const hiddenState = await request({ cmd: 'get_state' })
    check(hiddenState.state === 'playing' && hiddenState.positionMs >= hiddenPosition.positionMs && hiddenState.volume === 0,
      `${action} preserves muted playback and its position`)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    await page.waitForFunction(count => globalThis.__meterFrames > count, hiddenCount)
    check(true, `restoring after ${action} resumes measured meter frames`)
  }
  check(await spectrum.locator('.frequency-axis-label').count() > 4, 'the spectrum keeps the EQ chart axis grammar (dB / Hz ticks)')
  check(rendererErrors.length === 0, 'real renderer has no uncaught errors', rendererErrors)
  await request({ cmd: 'set_eq', enabled: false, bandGains: Array(10).fill(0), preampDb: 0, autoHeadroom: true, q: 1.41 })
  rmSync(artifacts + '/failure.png', { force: true })
  writeFileSync(artifacts + '/result.json', JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
  console.log('PLAYER UI OK', results.length, artifacts)
} catch (error) {
  console.error(error)
  try { await capture('failure') } catch {}
  writeFileSync(artifacts + '/result.json', JSON.stringify({ ok: false, checks: results.length, results, error: String(error) }, null, 2))
  process.exitCode = 1
} finally {
  await electronApp?.close()
}
