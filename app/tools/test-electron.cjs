// Integration check using the built app, real preload bridge and real engine.
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const trace = require('../../engine/fixtures/state-traces.json')
app.getAppPath = () => path.join(__dirname, '..')
// 隔离用户配置：启动现在会读 userData/library.json（曲库目录记忆）与 artwork.json。
// 不隔离的话，本机真实配置会改变被测行为 —— 真实配置里一旦记住了别的目录，
// 这里扫的就不是默认目录，断言会随机器状态漂移。
app.setPath('userData', path.join(__dirname, '../.smoke/qa/profile'))
// 在线播放端到端：让真实主进程把 tools/mock-streaming-server.mjs 当作「用户自备服务端」拉起来。
// 这份配置必须在 require(out/main) 之前落盘 —— StreamingManager 在 whenReady 时同步读它。
// 主进程的 userData 是「测试注入的隔离目录」优先（index.ts:52），不是这里 setPath 的那个。
const streamingProfile = process.env.TWILIGHT_USER_DATA
  ? path.resolve(process.env.TWILIGHT_USER_DATA)
  : path.join(__dirname, '../.smoke/qa/profile')
fs.mkdirSync(streamingProfile, { recursive: true })
fs.writeFileSync(path.join(streamingProfile, 'streaming.json'), JSON.stringify({
  version: 1,
  providers: [
    { platform: 'netease', command: 'node "' + path.join(__dirname, 'mock-streaming-server.mjs') + '"', enabled: true, quality: 'exhigh' },
    // v6.3：QQ 发现页也要跑同一条 e2e 路径 —— 同一个 mock 服务端同时提供 QQ 形状的
    // /recommend/* 与 /getSongListDetail/*（见 mock-streaming-server.mjs）。
    { platform: 'qq', command: 'node "' + path.join(__dirname, 'mock-streaming-server.mjs') + '"', enabled: true },
    { platform: 'meting', command: '', enabled: false, metingSource: 'kugou' }
  ]
}))
// 播放记忆（playback-memory.json）是产品行为：上一轮 e2e 留下的记忆会让下一轮启动
// 出现「继续上次」恢复横幅，于是 startup 横幅断言假红。e2e 不应继承上一轮的记忆 ——
// 每轮开跑前清掉（文件不存在时 force 容错）。
fs.rmSync(path.join(streamingProfile, 'playback-memory.json'), { force: true })
// v3 GD 音乐台 e2e：拉起本机 mock GD 服务（tools/mock-gdstudio.mjs），离线可回归。
// 必须在 require(out/main) **之前**设置 TWILIGHT_GD_API_BASE —— gdstudio 单例在模块加载时读它。
const gdMockPort = 45100 + Math.floor(Math.random() * 4000)
const gdMock = spawn(process.execPath, [path.join(__dirname, 'mock-gdstudio.mjs')], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(gdMockPort), ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let gdMockOutput = ''
gdMock.stdout.on('data', chunk => { gdMockOutput += String(chunk) })
gdMock.stderr.on('data', chunk => { gdMockOutput += String(chunk) })
process.env.TWILIGHT_GD_API_BASE = 'http://127.0.0.1:' + gdMockPort + '/'
process.on('exit', () => { try { gdMock.kill() } catch { /* 已经退出 */ } })
const waitGdMock = async () => {
  for (let index = 0; index < 120; index += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + gdMockPort + '/mock/gd-log')
      if (response.ok) return
    } catch { /* 还没监听 */ }
    await delay(50)
  }
  throw new Error('mock GD 没有就绪：' + gdMockOutput.slice(0, 300))
}

const artifacts = path.join(__dirname, '../.smoke/qa')
const enginePath = process.env.TWILIGHT_ENGINE || path.join(__dirname, '../../engine/bin/twilight-engine.exe')
const engineHash = () => createHash('sha256').update(fs.readFileSync(enginePath)).digest('hex')
const startingEngineHash = engineHash()
fs.mkdirSync(artifacts, { recursive: true })
let checks = 0
let failures = 0
function check(value, label, details) {
  checks++
  if (value) console.log('PASS', label)
  else { failures++; console.error('FAIL', label, details ?? '') }
}
// 视图切换由 AnimatePresence mode="wait" 编排：新视图要等旧视图的退场动画播完才挂载，而动画靠帧。
// 窗口被遮挡时 Chromium 会停发帧 —— 此时脚本点导航就会「React 状态变了、DOM 还是旧页面」，
// 恢复可见后自愈（.smoke/probe-hidden-view.mjs 可确定性复现；真实用户点不到一个被遮挡的窗口）。
// 测试要能在任何窗口叠放顺序下跑，所以对它关掉后台节流 —— 这是给测试环境改的一行，产品行为不变。
const { app: electronApp } = require('electron')
electronApp.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
})
require('../out/main/index.js')

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  // 视图切换由 AnimatePresence mode="wait" 编排：新视图要等旧视图的退场动画播完才挂载，
  // 而动画靠帧。窗口被遮挡/隐藏时 Chromium 停发帧 —— 此时脚本再点导航就会「状态变了、页面不动」，
  // 直到窗口恢复可见才自愈（.smoke/probe-hidden-view.mjs 可复现）。真实用户看不到、也点不到
  // 一个被遮挡的窗口，所以这是测试环境的构造问题，不是用户会遇到的画面：把窗口显式显示并置前。
  win.show()
  win.focus()
  const rendererErrors = []
  win.webContents.on('render-process-gone', (_event, details) => console.error('RENDER_PROCESS_GONE', details))
  win.webContents.on('unresponsive', () => console.error('RENDER_UNRESPONSIVE'))
  win.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) rendererErrors.push(message)
  })
  // 失败时必须知道是**哪一条表达式**炸的：executeJavaScript 的拒绝只给一句
  // "Script failed to execute"，上一轮就靠猜浪费了一轮。这里补上表达式与栈。
  const run = async expression => {
    try {
      return await win.webContents.executeJavaScript(expression)
    } catch (error) {
      console.error('RENDERER_SCRIPT_FAILED', JSON.stringify({ expression: String(expression).slice(0, 400), message: String(error && error.message) }))
      throw error
    }
  }
  const step = async expression => {
    console.log('STEP', expression.slice(0, 100))
    return run(expression)
  }
  // 截图：e2e 的视觉证据（发现页 / 音频中心 / 设置页都要有图可看）。
  // 定义点必须在所有使用点之前 —— 曾经把它放在登录段里，导致更早的发现页截图
  // 调用了未定义变量（TDZ），整轮 e2e 直接在第 20 条断言处中断。
  const captureQaShot = async (name) => {
    fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG())
  }
  const request = async cmd => {
    const reply = await run(`window.twilight.request(${JSON.stringify(cmd)})`)
    if (cmd.cmd !== 'pick_folder') assert.ok(reply.ok, cmd.cmd + ': ' + JSON.stringify(reply))
    return reply
  }
  const waitFor = async (expression, label) => {
    for (let i = 0; i < 150; i++) {
      if (await run(expression)) return
      await delay(100)
    }
    // 超时时把「界面此刻到底是什么」一起打出来：只报「等什么没等到」会在
    // 曲库/视图这类与断言无关的地方浪费一轮往返（本轮就吃过一次）。
    console.error('UI state:', await run('({ label: document.querySelector(".c2-path")?.getAttribute("aria-label"), error: document.querySelector(".proto-banner")?.textContent, progress: document.querySelector(".progress-time")?.textContent, view: document.querySelector(".view-layer")?.className, rows: document.querySelectorAll(".track-row").length, quickRows: document.querySelectorAll(".music-space .track-row").length, empty: document.querySelector(".list-empty")?.textContent, count: document.querySelector(".lib-count")?.textContent })'))
    console.error('Engine state:', await request({ cmd: 'get_state' }))
    console.error('Capabilities:', await request({ cmd: 'hello', protocol: 1 }))
    console.error('Delivered events:', await run('globalThis.qaEvents'))
    console.error('C2 DOM:', await run('document.querySelector(".c2-path")?.outerHTML'))
    throw new Error('Timed out: ' + label)
  }
  // The lyric resolver is the only substituted boundary: exercise two subtitles
  // and combining characters without changing the user's audio or LRC files.
  const lyricDelays = new Map()
  const requestedLyrics = []
  // 在线取词在测试里永远短路：真实网络不属于测试。这里给一个明确的「没有」，
  // 让渲染层的在线分支走完而不是抛「No handler registered」。
  ipcMain.removeHandler('twilight:lyrics-online')
  ipcMain.handle('twilight:lyrics-online', async () => ({ status: 'none' }))
  ipcMain.removeHandler('twilight:lyrics-candidates')
  ipcMain.handle('twilight:lyrics-candidates', async () => ([
    { id: '1', title: 'candidate one', artist: 'someone', durationMs: 200000, score: 0.9, risk: 'low', reasons: [] },
    { id: '2', title: 'candidate two', artist: 'someone else', durationMs: 210000, score: 0.7, risk: 'high', reasons: [] }
  ]))
  ipcMain.removeHandler('twilight:lyrics-apply-candidate')
  ipcMain.handle('twilight:lyrics-apply-candidate', async () => ({ status: 'none' }))
  ipcMain.removeHandler('twilight:lyrics-save')
  ipcMain.handle('twilight:lyrics-save', async () => ({ path: 'fixture.ttml' }))
  ipcMain.removeHandler('twilight:lyrics')
  ipcMain.handle('twilight:lyrics', async (_event, track) => {
    requestedLyrics.push(track.trackId)
    await delay(lyricDelays.get(track.trackId) ?? 0)
    return {
    resolvedPath: 'fixture.lrc',
    source: 'sidecar', attachedUnavailable: false, offsetMs: 0,
    // wordByWord:false = 数据源只给行级时间（实测这是本机曲库的绝大多数情况），
    // 于是渲染层必须靠插值补出填充，同时如实标注「行级·插值」。
    lyrics: { wordByWord: false, source: 'local', lines: [
      { startMs: 0, endMs: 100000, text: '夜空 e\u0301 你好', romanization: 'yozora e\u0301 ni hao', translation: '夜空下的问候',
        // ruby 是逐字注音（CR-018 的 word.ruby）。放在渲染路径的夹具里，
        // 否则「注音能显示」就只有数据层单测，没有一条断言看过真实 DOM。
        words: [{ startMs: 0, endMs: 100000, text: '夜空 e\u0301 你好', ruby: 'よぞら' }] },
      { startMs: 100000, endMs: 150000, text: track.trackId, words: [] },
      // 只有行级时间、且是多字的一行：插值必须让它也能逐字填充。
      { startMs: 150000, endMs: 160000, text: '行级歌词也能填充', words: [] }
    ] }
    }
  })
  try {
    await waitFor('!document.querySelector(".startup-intro")', 'startup transition')
    await waitFor('Boolean(document.querySelector(".track-row"))', 'library')
    const libraryApi = await run(`(async () => {
      const names = ['playlists', 'libraryDataWarnings', 'createPlaylist', 'renamePlaylist', 'deletePlaylist', 'addPlaylistEntries', 'removePlaylistEntry', 'reorderPlaylist', 'trackOverrides', 'setTrackOverride', 'resetTrackOverride', 'loadLyrics', 'attachLyrics', 'clearAttachedLyrics', 'setLyricsOffset', 'saveLyrics', 'fetchLyricsOnline']
      if (!names.every(name => typeof window.twilight[name] === 'function')) return { exposed: false }
      const before = await window.twilight.playlists()
      const created = await window.twilight.createPlaylist('IPC round trip')
      const beforeIds = new Set(before.map(item => item.id))
      const playlist = created.find(item => !beforeIds.has(item.id))
      const overrides = await window.twilight.trackOverrides()
      const warnings = await window.twilight.libraryDataWarnings()
      const lyrics = await window.twilight.loadLyrics({ trackId: 'ipc-round-trip' })
      if (playlist) await window.twilight.deletePlaylist(playlist.id)
      let invalidRejected = false
      try { await window.twilight.createPlaylist('   ') } catch { invalidRejected = true }
      return { exposed: true, before: Array.isArray(before), created: Boolean(playlist), overrides: overrides && typeof overrides === 'object', warnings: Array.isArray(warnings), lyrics: lyrics?.source === 'sidecar' && lyrics.offsetMs === 0, invalidRejected, genericInvoke: 'invoke' in window.twilight }
    })()`)
    check(libraryApi.exposed && libraryApi.before && libraryApi.created && libraryApi.overrides && libraryApi.warnings && libraryApi.lyrics && libraryApi.invalidRejected && !libraryApi.genericInvoke,
      'preload exposes explicit playlist, metadata, and lyric APIs with validated mutations', libraryApi)
    check(await run('Boolean(document.querySelector(".music-space"))'), 'music space is the default view')
    check(await run('Boolean(document.querySelector(".record-stage")) && document.querySelector(".record-stage canvas")?.width > 0'), '3D record stage has a rendered canvas')
    check(await run('Boolean(document.querySelector(".frequency-panel"))'), 'home view exposes frequency response')
    check(await run('Boolean(document.querySelector("[data-view-target=\\"library\\"]"))'), 'library navigation exists')
    // 歌单不再挂在左栏（用户要求左栏只有 7 项、不展开），它现在在「我的曲库」里的歌单页签。
    check(await run('Boolean(document.querySelector("[data-view-target=\\"settings\\"]")) && !document.querySelector(".sidebar-playlists")'), 'left navigation exposes settings and no longer stacks playlists')
    // 设置页顶部是**状态条**，不是标语：曲库/输出/来源/已移除 四项都在。
    const consoleStrip = await run(`(async () => {
      document.querySelector('[data-view-target="settings"]').click()
      await new Promise(resolve => setTimeout(resolve, 700))
      const metrics = [...document.querySelectorAll('.settings-console .settings-metric')]
      const active = [...document.querySelectorAll('.settings-index a[aria-current="true"]')]
      return { count: metrics.length, texts: metrics.map(node => node.textContent || ''), active: active.length }
    })()`)
    check(consoleStrip.count === 4, 'settings console shows four live metrics', consoleStrip)
    check(consoleStrip.texts.every(text => text.trim().length > 0), 'every console metric renders a value', consoleStrip)
    check(consoleStrip.active === 1, 'the settings index highlights exactly one section', consoleStrip)
    // 设置 → 输出：端点能力由引擎**实测**（逐个 IsFormatSupported），不是写死的规格表。
    // SETTINGS-LOGIN spec §3：探测只在 details **展开时**发生（不再用 IntersectionObserver
    // 滚到就探测——那会让没打算看的用户也付一次逐格式打开设备的成本）。所以这里先点开
    // summary 再等探测结果；format-chip 断言不变。
    await run("document.querySelector('#output')?.scrollIntoView({ block: 'start' })")
    await run("(() => { const details = document.querySelector('.settings-device'); if (details && !details.open) details.querySelector('summary')?.click() })()")
    await waitFor('Boolean(document.querySelector(".device-row"))', 'probed render devices')
    const device = await run(`(() => {
      const rows = [...document.querySelectorAll('.device-row')]
      const chips = [...document.querySelectorAll('.device-row .format-chip')].map(node => node.textContent.trim())
      return { rows: rows.length, chips, text: rows.map(row => row.textContent).join(' ') }
    })()`)
    check(device.rows >= 1, 'the settings page lists the render endpoint it probed', device)
    check(device.chips.length === 0 || device.chips.every(label => /\d+(\.\d+)?k \/ \d+bit/.test(label)),
      'probed exclusive formats are rendered as rate / precision', device)
    // 后面的用例假设停在曲库视图：这里必须把视图还回去。
    await step('document.querySelector("[data-view-target=\\"library\\"]").click()')
    await waitFor('Boolean(document.querySelector(".library-view, .library-list, .track-list"))', 'library view restored')
    await run('document.querySelector("[data-view-target=\\"settings\\"]").click()')
    await waitFor('Boolean(document.querySelector(".settings-page"))', 'settings view')
    // CONTRACT §4 落地后，这里的判据从"两个占位卡片"变成了"三行真实状态"：
    // 每个平台都必须报出自己的服务端状态，且默认（没配置启动）时三个都是未启动/未登录，
    // 不允许出现任何"即将接入"这类假装存在的文案。
    const streaming = await run(`(async () => {
      const cards = [...document.querySelectorAll('.provider-card[data-provider]')]
      const ids = cards.map(card => card.dataset.provider)
      const states = cards.map(card => card.dataset.state)
      const statuses = cards.map(card => card.querySelector('.provider-action > span')?.textContent ?? '')
      const honest = cards.every(card => !/即将|planned|敬请/.test(card.textContent || ''))
      const api = ['streamingStatus', 'streamingStart', 'streamingStop', 'streamingSearch', 'streamingPlay', 'streamingQrStart',
        'streamingSimilar', 'streamingGdSources']
        .every(name => typeof window.twilight[name] === 'function')
      const gdCard = cards.find(card => card.dataset.provider === 'gdstudio')
      const builtin = Boolean(gdCard && gdCard.dataset.builtin !== undefined)
      const gdHasStart = gdCard ? [...gdCard.querySelectorAll('button')].some(button => button.textContent.trim() === '启动') : true
      return { ids, states, statuses, honest, api, builtin, gdHasStart }
    })()`)
    // v3：内置 HTTP 源 GD 音乐台也出现在面板里（它没有服务端进程，运行时恒 ready）。
    check(streaming.ids.length === 4 && streaming.ids.join(',') === 'netease,qq,meting,gdstudio',
      'streaming panel lists every configured platform including the builtin GD source', streaming)
    // 判据不是"恰好都是未启动"，而是"每个来源都报了一个**诚实**的状态"。
    // 测试的 userData 是隔离的，所以正常情况下就是 stopped；但断言不该依赖这一点。
    check(streaming.states.every(state => ['stopped', 'starting', 'ready', 'failed'].includes(state)),
      'every platform reports a truthful server state (not a placeholder)', streaming)
    check(streaming.honest, 'no placeholder wording survives in the streaming panel', streaming)
    check(streaming.api, 'preload exposes the streaming API', streaming)
    // v6：设置页「播放体验」里的自动恢复开关也要有图可看（跳转索引 → 截图 → 回滚视图由后续导航处理）。
    await run('document.querySelector(\'.settings-index a[href="#playback"]\')?.click()')
    await delay(400)
    await win.setContentSize(1400, 1500)
    await delay(300)
    await captureQaShot('settings-playback-v6.png')
    await win.setContentSize(1280, 800)
    await delay(200)
    check(streaming.builtin && !streaming.gdHasStart,
      'the builtin GD source is marked builtin and offers no server start button', streaming)
    // v6 账号保活：两个需要登录的平台都要有「保活」这一行与「立即校验」按钮，
    // 且未登录时如实显示「未校验/服务端未启动」，不能吹成「会话有效」。
    const keepAlive = await run(`(() => {
      const rows = [...document.querySelectorAll('.provider-card[data-provider] [data-keep-alive]')]
      return {
        count: rows.length,
        states: rows.map(row => row.getAttribute('data-keep-alive')),
        text: rows.map(row => row.textContent),
        verifyButtons: [...document.querySelectorAll('.provider-card button')].filter(button => /立即校验/.test(button.textContent)).length,
        honest: rows.every(row => !/会话有效/.test(row.textContent || ''))
      }
    })()`)
    check(keepAlive.count === 2, 'both QR platforms expose a session keep-alive row', keepAlive)
    // 视觉证据：v6 的保活行 + 立即校验按钮（设置页流媒体账户）。
    // 必须先跳到 #accounts：设置页默认停在顶部（PLAYBACK/OUTPUT），不跳只会截到上面几节。
    await run('document.querySelector(\'.settings-index a[href="#accounts"]\')?.click()')
    await delay(500)
    const accountsInView = await run('(() => { const card = document.querySelector("#accounts .provider-card"); return card ? card.getBoundingClientRect().top < window.innerHeight : false })()')
    check(accountsInView, 'the accounts card scrolls into view (so the keep-alive row is actually visible)', { accountsInView })
    await win.setContentSize(1400, 1500)
    await delay(400)
    await captureQaShot('settings-accounts-v6.png')
    await win.setContentSize(1280, 800)
    await delay(200)
    check(keepAlive.honest && keepAlive.states.every(state => ['idle', 'checking', 'ok', 'expired', 'error', 'unsupported'].includes(state)),
      'keep-alive starts from an honest state instead of claiming a session is valid', keepAlive)
    // 左栏合同（用户要求）：恰好 8 项（v4 新增「发现」），且不再展开任何二级列表。
    const sidebar = await run(`(async () => {
      const items = [...document.querySelectorAll('.sidebar [data-view-target]')].map(node => node.dataset.viewTarget)
      const rails = document.querySelectorAll('.source-rail, .sidebar-playlists').length
      return { items, rails }
    })()`)
    check(sidebar.items.length === 8, 'the sidebar has exactly eight feature entries', sidebar)
    check(sidebar.items.join(',') === 'home,discover,library,center,search,downloads,sound,settings',
      'the eight entries are the agreed set, with discover right after home', sidebar)
    check(sidebar.rails === 0, 'source and playlist rails no longer pile up in the sidebar', sidebar)

    // ---- 发现页（v4）：新一级菜单 + 四区块 + 未登录降级 + 榜单详情抽屉 ----
    // 上一轮 e2e 可能留下登录态（userData 复用），这里先显式登出：
    // 「未登录必须给出登录引导而不是空列表/报错」是产品要求，不能靠运气复现。
    await run('window.twilight.streamingLogout("netease")')
    await step('document.querySelector("[data-view-target=\\"discover\\"]").click()')
    await waitFor('Boolean(document.querySelector(".discover-page"))', 'discover view')
    // 两个公共区块**各自**等到位，而不是依赖同一个帧：主进程同平台 ≥1s 串行节流，
    // 谁先回来取决于上游，断言不该把这个时序写死（否则换台机器/换网络就假红）。
    await waitFor('document.querySelectorAll(\'[data-discover-section="toplists"] .discover-card\').length >= 4', 'toplist cards')
    // 等入场动画真正画出来再截：AnimatePresence 让新视图从 opacity 0 开始，
    // 一挂载就截图会得到一张"内容全黑"的图（第一版就是这样，白占一次 e2e）。
    await delay(700)
    // 加高窗口再截，否则只截到排行榜卡片的上边缘（标题/播放次数全在视口外，图看不出内容）。
    await win.setContentSize(1400, 1500)
    await delay(500)
    await captureQaShot('discover-guest-1280.png')
    await win.setContentSize(1280, 800)
    await delay(300)
    const discoverShell = await run(`(() => ({
      sections: [...document.querySelectorAll('.discover-page [data-discover-section]')].map(node => node.dataset.discoverSection),
      hero: Boolean(document.querySelector('.discover-hero')),
      refresh: Boolean(document.querySelector('.discover-page button[aria-label="刷新发现"]'))
    }))()`)
    check(discoverShell.sections.join(',') === 'daily,fm,toplists,playlists',
      'the discover page groups the four backend sections', discoverShell)
    check(discoverShell.hero && discoverShell.refresh, 'the discover page has a hero with a refresh action', discoverShell)
    // 公共歌单广场是第二次上游请求（首页先出榜单），等它自己到位。
    await waitFor('document.querySelectorAll(\'[data-discover-section="playlists"] .discover-card\').length >= 6', 'public discovery playlists')
    const discoverGuest = await run(`(() => ({
      toplists: document.querySelectorAll('[data-discover-section="toplists"] .discover-card').length,
      playlists: document.querySelectorAll('[data-discover-section="playlists"] .discover-card').length,
      hints: [...document.querySelectorAll('[data-discover-section="daily"] .discover-empty, [data-discover-section="fm"] .discover-empty')].map(node => node.textContent || '')
    }))()`)
    check(discoverGuest.toplists >= 4, 'public toplists render for a signed-out listener', discoverGuest)
    check(discoverGuest.playlists >= 6, 'public discovery playlists render for a signed-out listener', discoverGuest)
    check(discoverGuest.hints.length === 2 && discoverGuest.hints.every(text => text.includes('登录')),
      'personal sections ask for a login instead of pretending to be empty', discoverGuest)
    // 点开榜单 → 详情抽屉列出曲目（mock 的 /playlist/track/all 固定回 2 首）
    await step('document.querySelector(\'[data-discover-section="toplists"] .discover-card\').click()')
    await waitFor('Boolean(document.querySelector(".discover-detail"))', 'toplist detail drawer')
    await waitFor('document.querySelectorAll(".discover-detail .discover-row").length >= 2', 'toplist detail rows')
    check(await run('Boolean(document.querySelector(".discover-detail button[aria-label=\\"关闭详情\\"]"))'),
      'the detail drawer can be dismissed')
    await step('document.querySelector(".discover-detail button[aria-label=\\"关闭详情\\"]").click()')
    await waitFor('!document.querySelector(".discover-detail")', 'detail drawer closed')
    // v6.3：发现页支持 QQ 音乐。切到 QQ 后四区块同名但来源不同：
    // 每日 30 首需登录、刷歌雷达/排行榜/推荐歌单公开；歌单广场没有分类与翻页。
    const platformSwitch = await run(`(() => {
      const tabs = [...document.querySelectorAll('.discover-platform-switch .discover-platform-tab')]
      return {
        tabs: tabs.map(node => node.textContent || ''),
        pressed: tabs.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent || '')
      }
    })()`)
    check(platformSwitch.tabs.length === 2 && platformSwitch.pressed.length === 1,
      'the discover page exposes a two-platform switch with exactly one active platform', platformSwitch)
    await step('document.querySelector(\'.discover-platform-switch .discover-platform-tab[data-platform="qq"]\').click()')
    await waitFor('Boolean(document.querySelector(\'[data-discover-section="toplists"] .discover-card\'))', 'QQ toplists')
    await waitFor('document.querySelectorAll(\'[data-discover-section="playlists"] .discover-card\').length >= 3', 'QQ recommend playlists')
    const qqGuest = await run(`(() => {
      const chip = [...document.querySelectorAll('.discover-chip')].map(node => node.textContent || '').join(' ')
      const cats = document.querySelectorAll('.discover-cats').length
      const dailyHint = document.querySelector('[data-discover-section="daily"] .discover-empty')
      return {
        chip,
        qqTotals: document.querySelectorAll('[data-discover-section="toplists"] .discover-card').length,
        qqPlaylists: document.querySelectorAll('[data-discover-section="playlists"] .discover-card').length,
        cats,
        dailyHint: dailyHint ? dailyHint.textContent || '' : '',
        radarCards: document.querySelectorAll('[data-discover-section="fm"] .discover-card').length
      }
    })()`)
    check(qqGuest.chip.includes('QQ 音乐'), 'the signed-in chip follows the selected platform', qqGuest)
    check(qqGuest.qqTotals >= 4 && qqGuest.qqPlaylists >= 3, 'QQ public toplists and recommend playlists render', qqGuest)
    check(qqGuest.radarCards >= 3, 'the QQ radar (anonymous read) renders without login', qqGuest)
    check(qqGuest.cats === 0, 'QQ hides the netease playlist category chips instead of faking them', qqGuest)
    check(qqGuest.dailyHint.includes('登录'), 'QQ daily 30 asks for a login instead of pretending to be empty', qqGuest)
    await captureQaShot('discover-qq-1280.png')
    // QQ 榜单详情：/recommend/toplist 的形状与网易云不同，必须真的走通。
    await step('document.querySelector(\'[data-discover-section="toplists"] .discover-card\').click()')
    await waitFor('Boolean(document.querySelector(".discover-detail"))', 'QQ toplist detail drawer')
    await waitFor('document.querySelectorAll(".discover-detail .discover-row").length >= 2', 'QQ toplist rows')
    await step('document.querySelector(".discover-detail button[aria-label=\\"关闭详情\\"]").click()')
    await waitFor('!document.querySelector(".discover-detail")', 'QQ detail drawer closed')
    // 切回网易云：数据来自按平台隔离的缓存，不能串台。
    await step('document.querySelector(\'.discover-platform-switch .discover-platform-tab[data-platform="netease"]\').click()')
    await waitFor('document.querySelectorAll(\'[data-discover-section="playlists"] .discover-card\').length >= 6', 'netease playlists back')
    const switchedBack = await run(`(() => ({
      chip: [...document.querySelectorAll('.discover-chip')].map(node => node.textContent || '').join(' '),
      cats: document.querySelectorAll('.discover-cats').length
    }))()`)
    check(switchedBack.chip.includes('网易云') && switchedBack.cats === 1,
      'switching back restores the netease view with its category chips', switchedBack)

    await step('document.querySelector("[data-view-target=\\\"search\\\"]").click()')
    await waitFor('Boolean(document.querySelector(".global-search"))', 'global search view')
    const searchView = await run(`(async () => ({
      input: Boolean(document.querySelector('.global-search .center-search input')),
      api: typeof window.twilight.searchAll === 'function' && typeof window.twilight.downloadAdd === 'function'
    }))()`)
    check(searchView.input, 'global search has its own search box', searchView)
    check(searchView.api, 'preload exposes searchAll and downloadAdd', searchView)

    // ---- v3 GD 音乐台（本机 mock GD，离线回归）：搜索 / 相似降级 / 源可用性 / UI 分组 ----
    await waitGdMock()
    const gdProbe = await run('window.twilight.streamingGdSources()')
    check(Array.isArray(gdProbe) && gdProbe.length === 2 && gdProbe.every(item => item.ok === true),
      'GD source availability is probed at runtime (netease/joox, not hard-coded)', gdProbe)
    const gdSearch = await run(`(async () => {
      const rows = await window.twilight.searchAll('周杰伦', 10)
      const gdRows = rows.filter(row => row.platform === 'gdstudio')
      return { total: rows.length, count: gdRows.length, titles: gdRows.map(row => row.title),
        sourceNames: [...new Set(gdRows.map(row => row.sourceName))], firstId: gdRows[0]?.id ?? null }
    })()`)
    check(gdSearch.count >= 2 && gdSearch.sourceNames.includes('GD 音乐台'),
      'global search reaches the builtin GD music platform (mock, offline)', gdSearch)
    const gdSimilar = await run('window.twilight.streamingSimilar(' + JSON.stringify({ title: '晴天', artist: '周杰伦' }) + ')')
    check(gdSimilar?.degraded === true && /降级/.test(String(gdSimilar?.reason)) &&
      Array.isArray(gdSimilar?.items) && gdSimilar.items.length > 0,
      'Embeat degradation is reported honestly and still returns related tracks', gdSimilar)
    // UI：走真实渲染层输入关键词 → 出现 GD 分组；GD 行不能有下载入口（主进程同样拒绝）。
    await run(`(() => {
      const input = document.querySelector('.global-search .center-search input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await run(`(() => {
      const button = [...document.querySelectorAll('.global-search button')].find(node => node.textContent.includes('搜索'))
      button.click()
      return true
    })()`)
    await waitFor(`[...document.querySelectorAll('.search-group-head span')].some(node => (node.textContent || '').includes('GD 音乐台'))`, 'GD search results group')
    const gdUi = await run(`(() => {
      const group = [...document.querySelectorAll('.search-group')].find(node => (node.querySelector('.search-group-head span')?.textContent || '').includes('GD 音乐台'))
      const rows = [...(group?.querySelectorAll('.stream-row') ?? [])]
      return { rows: rows.length, downloadButtons: rows.reduce((count, row) => count + row.querySelectorAll('button[title="下载"]').length, 0) }
    })()`)
    check(gdUi.rows > 0, 'the global search UI renders a GD results group', gdUi)
    check(gdUi.downloadButtons === 0, 'GD rows offer no download entry (stream-only source)', gdUi)


    await step('document.querySelector("[data-view-target=\\\"downloads\\\"]").click()')
    await waitFor('Boolean(document.querySelector(".downloads-page"))', 'downloads view')
    const downloadsView = await run(`(async () => {
      const directory = await window.twilight.downloadDirectory()
      const list = await window.twilight.downloads()
      const progress = typeof window.twilight.onDownloadProgress === 'function'
      return { directory, empty: Array.isArray(list) && list.length === 0, progress }
    })()`)
    check(typeof downloadsView.directory === 'string' && downloadsView.directory.length > 0,
      'the downloads view reports a real directory', downloadsView)
    // 歌曲中心的账号栏：收藏 / 我的歌单 / 歌单搜索 三件事必须都在（未登录也要在，
    // 只是按钮点了会说明原因——否则用户以为这个功能不存在）。
    await step('document.querySelector("[data-view-target=\\"center\\"]").click()')
    await waitFor('Boolean(document.querySelector(".song-center"))', 'song center')
    await run('document.querySelector(".center-source[data-source=\\"netease\\"]").click()')
    await waitFor('Boolean(document.querySelector(".center-side"))', 'account rail')
    const rail = await run(`(() => {
      const actions = [...document.querySelectorAll('.center-side .account-action')].map(n => n.textContent.trim())
      return { actions, search: Boolean(document.querySelector('#playlist-search')),
        status: Boolean(document.querySelector('.center-status')), cards: Boolean(document.querySelector('.playlist-cards')) || true }
    })()`)
    check(rail.actions.some(text => text.includes('我的收藏')) && rail.actions.some(text => text.includes('我的歌单')),
      'the song centre offers account favourites and playlists', rail)
    check(rail.search, 'the song centre has a playlist search field', rail)
    check(rail.status, 'the song centre says whether the source can be searched right now', rail)

    // ---- 在线播放端到端（假服务端，真实主进程 + 真实引擎 + 真实回环代理）----
    // 这一步验的是用户报的那句「可以播放了，但播放没有反映到任何界面上」：
    // 平台曲目播起来之后，标题、播放态、进度、歌词都必须出现在界面上。
    const waitReady = async () => {
      let last = null
      for (let i = 0; i < 150; i++) {
        const status = await run('window.twilight.streamingStatus()')
        const runtime = (status?.runtimes ?? []).find(item => item.platform === 'netease')
        last = runtime
        if (runtime?.state === 'ready') return runtime
        if (runtime?.state === 'failed') break
        await delay(200)
      }
      throw new Error('Timed out: mock streaming server ready ' + JSON.stringify(last))
    }
    const runtime = await waitReady()
    check(typeof runtime.port === 'number' && runtime.port > 0, 'the user-supplied API server is spawned on a dynamic port', runtime)
    const ticket = await run('window.twilight.streamingQrStart("netease")')
    check(ticket.state === 'waiting' && Boolean(ticket.image), 'the mock server issues a QR ticket', ticket)
    const poll = await run('window.twilight.streamingQrPoll("netease")')
    check(poll.state === 'confirmed', 'confirming the QR verifies the session against /login/status', poll)
    // v6.4：QQ 扫码有三种通道。以前固定 qqmusic（QQ 音乐 App），用手机 QQ 扫
    // 只会得到「二维码过期」；现在通道由 /login/channels 决定且可以当场切换。
    const qqTicket = await run('window.twilight.streamingQrStart("qq")')
    check(
      Array.isArray(qqTicket.channels) && qqTicket.channels.join(',') === 'qq,wechat,qqmusic' && qqTicket.channel === 'qq',
      'QQ QR login lists the phone-QQ/WeChat/QQ-Music-App channels and defaults to phone QQ',
      qqTicket
    )
    const qqWechat = await run('window.twilight.streamingQrStart("qq", "wechat")')
    check(qqWechat.channel === 'wechat' && Boolean(qqWechat.image),
      'picking the WeChat channel re-issues the QR through that channel', { channel: qqWechat.channel, hasImage: Boolean(qqWechat.image) })
    // 非法通道退回默认值（不把任意字符串透传给服务端）
    const qqBogus = await run('window.twilight.streamingQrStart("qq", "bogus-channel")')
    check(qqBogus.channel === 'qq', 'an unsupported QR channel falls back to the platform default', { channel: qqBogus.channel })
    await step('document.querySelector(".account-refresh").click()')
    await waitFor('document.querySelector(".account-copy strong")?.textContent === "模拟用户"', 'account name after login')

    // ---- 登录模态状态机 e2e（task-18：mock streaming server 可控 QR 模式）----
    // mock 的 qr-mode 是**服务端进程级全局状态**：这套用例结束必须切回 fast，
    // 否则后续用例/复跑会继承上一轮的行为。error 模式会让主进程 qrRequest
    // 重试一次（~300ms）后才抛错 → UI 进入 error phase，这是预期。
    // 这里用 runFn 把断言写成真函数而不是字符串：选择器里的引号不用在字符串里二次转义。
    const runFn = (fn) => run('(' + fn.toString() + ')()')
    const waitUntil = async (fn, label) => {
      for (let i = 0; i < 150; i++) {
        if (await runFn(fn)) return
        await delay(100)
      }
      throw new Error('Timed out: ' + label)
    }
    const mockBase = 'http://127.0.0.1:' + runtime.port
    const setMockQrMode = async (mode) => {
      const response = await fetch(mockBase + '/mock/qr-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode })
      })
      assert.equal(response.status, 200, 'mock qr mode endpoint accepts ' + mode)
      assert.equal((await response.json()).mode, mode, 'mock qr mode is applied')
    }
    await win.setContentSize(1280, 800)
    await runFn(() => document.querySelector('[data-view-target="settings"]').click())
    await waitUntil(() => Boolean(document.querySelector('.settings-page')), 'settings view for login e2e')
    await runFn(() => document.querySelector('.provider-card[data-provider="netease"]')?.scrollIntoView({ block: 'center' }))

    // 失败流：error 模式 → 点「扫码」→ 轮询命中 500（重试一次后抛错）→ error phase
    await setMockQrMode('error')
    await runFn(() => [...document.querySelectorAll('.provider-card[data-provider="netease"] .provider-actions button')].find(node => node.textContent.includes('扫码')).click())
    await waitUntil(() => Boolean(document.querySelector('.qr-card[data-phase="error"]')), 'qr error phase after upstream failure')
    const loginFailure = await runFn(() => {
      const card = document.querySelector('.qr-card[data-phase="error"]')
      return {
        overlay: Boolean(document.querySelector('.qr-overlay[data-phase="error"]')),
        fail: Boolean(card?.querySelector('.qr-fail')),
        reason: card?.querySelector('.qr-fail strong')?.textContent ?? '',
        next: card?.querySelector('.qr-next')?.textContent ?? '',
        primary: Boolean(card?.querySelector('.qr-primary')),
        actions: [...(card?.querySelectorAll('.qr-actions button') || [])].map(node => node.textContent.trim())
      }
    })
    check(loginFailure.overlay && loginFailure.fail, 'a failed QR login renders the amber fail block in the modal', loginFailure)
    check(/重试|网页登录/.test(loginFailure.next), 'the failed login explains the next step', loginFailure)
    // 用户可见质量：reason 里不能漏出 Electron IPC 的包装前缀（"Error invoking remote method ..."）。
    check(loginFailure.reason.length > 0 && !/Error invoking remote method/i.test(loginFailure.reason),
      'the failure reason is user-facing, without the Electron IPC wrapper prefix', loginFailure)
    check(loginFailure.primary && loginFailure.actions.some(text => text.includes('网页登录')),
      'the failed login keeps retry and web-login escape hatches', loginFailure)
    await captureQaShot('login-failure-1280.png')

    // 成功流：sequence 模式 → 点「重新获取」→ scanned（2s 首次轮询）→ success（4s 第二次轮询）
    await setMockQrMode('sequence')
    await runFn(() => document.querySelector('.qr-card .qr-primary').click())
    await waitUntil(() => Boolean(document.querySelector('.qr-card[data-phase="scanned"]')), 'qr scanned phase')
    check(await runFn(() => document.querySelector('.qr-card[data-phase="scanned"]').textContent.includes('已扫描')),
      'the scanned phase tells the user to confirm on the phone')
    await waitUntil(() => Boolean(document.querySelector('.qr-card[data-phase="success"]')), 'qr success phase')
    const loginSuccess = await runFn(() => {
      const card = document.querySelector('.qr-card[data-phase="success"]')
      const provider = document.querySelector('.provider-card[data-provider="netease"]')
      return {
        check: Boolean(card?.querySelector('.qr-check')),
        block: Boolean(card?.querySelector('.qr-success')),
        flash: provider?.dataset.loginFlash ?? null
      }
    })
    check(loginSuccess.check && loginSuccess.block, 'the success phase draws the check mark and success block', loginSuccess)
    check(loginSuccess.flash === 'success', 'the provider card flashes success while the success animation plays', loginSuccess)
    // 对勾是 stroke-dashoffset 绘制的：多等 450ms 再截图，否则截到的是画了一半的勾。
    // 仍在 success 的 1100ms 自动关闭窗口内（检测 ~100ms + 断言 ~100ms + 450ms + 截图）。
    await delay(450)
    await captureQaShot('login-success-1280.png')
    await waitUntil(() => !document.querySelector('.qr-overlay'), 'success modal closes automatically')
    await waitUntil(() => document.querySelector('.streaming-summary-chip[data-provider="netease"]')?.dataset.session === 'signed-in', 'signed-in summary chip after modal login')
    check(await runFn(() => (document.querySelector('.provider-card[data-provider="netease"] .provider-facts')?.textContent ?? '').includes('已登录')),
      'the provider card reports the verified session after the modal closes')
    // 跑完必须切回 fast（mock 模式是全局状态，不复位会影响后续用例与复跑）
    await setMockQrMode('fast')

    // ---- 设置页「高级音频」子卡片：chips 汇总 + 恢复默认 + 引擎实际值回读 ----
    await runFn(() => document.querySelector('.settings-subcard.settings-advanced')?.scrollIntoView({ block: 'start' }))
    const advanced = await runFn(() => {
      const card = document.querySelector('.settings-subcard.settings-advanced')
      const chips = [...(card?.querySelectorAll('.settings-actual-chips .chip') || [])].map(node => node.textContent.trim())
      return { exists: Boolean(card), chips }
    })
    check(advanced.exists && advanced.chips.length >= 4, 'the settings page exposes the advanced audio subcard with engine-actual chips', advanced)
    await runFn(() => document.querySelector('button.settings-reset-defaults').click())
    await waitUntil(() => document.querySelector('.settings-apply')?.dataset.state === 'done', 'reset defaults apply feedback')
    const resetFeedback = await runFn(() => ({
      apply: document.querySelector('.settings-apply')?.dataset.state ?? '',
      note: document.querySelector('.settings-advanced-foot small')?.textContent ?? ''
    }))
    check(resetFeedback.apply === 'done' || /已恢复默认/.test(resetFeedback.note), 'reset defaults reports success in the ui', resetFeedback)
    const resetState = (await request({ cmd: 'get_state' })).data
    check(resetState.resampler?.quality === 'VHQ' && resetState.resampler?.phase === 'linear' && resetState.resampler?.steep === false,
      'reset defaults restores the documented resampler default (VHQ / linear / non-steep)', resetState.resampler)
    check(resetState.dither?.mode === 'tpdf', 'reset defaults restores TPDF dither', resetState.dither)
    check(resetState.latencyProfile === 'balanced', 'reset defaults restores the balanced latency profile', resetState.latencyProfile)
    check((resetState.dsp?.channels?.monoMode ?? 'off') === 'off', 'reset defaults turns the channel tools fully off', resetState.dsp?.channels)
    await captureQaShot('settings-advanced-1280.png')

    // ---- 关于与更新（PACKAGING v1）：版本 / 开发模式状态 / preload API 四向可调用 ----
    // 只读断言，不联网：dev 构建的 check/download/install 都该是 disabled-dev 空操作。
    await runFn(() => document.querySelector('#about')?.scrollIntoView({ block: 'start' }))
    await waitUntil(() => Boolean(document.querySelector('.settings-about .about-phase')), 'about card')
    const about = await runFn(() => {
      const card = document.querySelector('.settings-about')
      const values = [...(card?.querySelectorAll('.about-row .about-value') ?? [])].map(node => node.textContent.trim())
      const phase = card?.querySelector('.about-phase')
      const needed = ['appInfo', 'updateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'onUpdateStatus']
      return {
        heading: card?.querySelector('h2')?.textContent ?? '',
        version: values[0] ?? '',
        runtime: values[1] ?? '',
        path: card?.querySelector('.about-path')?.textContent?.trim() ?? '',
        phase: phase?.getAttribute('data-phase') ?? '',
        phaseText: phase?.textContent?.trim() ?? '',
        apis: needed.filter(name => typeof window.twilight[name] === 'function')
      }
    })
    check(about.heading.includes('关于与更新'), 'the settings page exposes an about & updates card', about)
    // 版本号每次发版都会变，断言不能写死字符串 —— 那样每次升版都要改 e2e（假红源头）。
    // 真正的规则是：**界面显示的就是 package.json 里那份版本**，且 appInfo() 与之一致。
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version
    check(about.version === expectedVersion, 'the about card shows the version from package.json', { about, expectedVersion })
    check(about.runtime.includes('开发版'), 'the about card states this is the dev build (no auto-update)', about)
    check(about.path.length > 0 && !about.path.includes('尚未获取'), 'the about card shows the real user-data directory', about)
    check(about.phase === 'disabled-dev' && /开发模式|不检查更新/.test(about.phaseText),
      'the update state reports disabled-dev in the dev build', about)
    check(about.apis.length === 6, 'the preload exposes appInfo + all five update APIs', about)
    const liveInfo = await run('window.twilight.appInfo()')
    check(liveInfo?.version === expectedVersion && liveInfo?.packaged === false && typeof liveInfo?.userDataPath === 'string',
      'appInfo() returns the live version, packaged flag and user-data path', liveInfo)
    const liveUpdate = await run('window.twilight.updateState()')
    check(liveUpdate?.phase === 'disabled-dev' && liveUpdate?.supported === false,
      'updateState() reports disabled-dev without touching the network', liveUpdate)
    const afterCheck = await run('window.twilight.checkForUpdates()')
    check(afterCheck?.phase === 'disabled-dev', 'checkForUpdates() is a no-op in the dev build', afterCheck)
    const afterDownload = await run('window.twilight.downloadUpdate()')
    const afterInstall = await run('window.twilight.installUpdate()')
    check(afterDownload?.phase === 'disabled-dev' && afterInstall?.phase === 'disabled-dev',
      'downloadUpdate()/installUpdate() are no-ops in the dev build', { afterDownload, afterInstall })
    await captureQaShot('about-1280.png')

    // 窄窗（900×800）：高级音频的 band/delay 行必须单行不折行、卡片不能横向溢出。
    // 这是布局回归闸：滑杆+声道名+数值在 900px 下最容易挤成两行或把卡片撑破。
    await win.setContentSize(900, 800)
    await delay(250)
    await runFn(() => document.querySelector('.settings-subcard.settings-advanced')?.scrollIntoView({ block: 'start' }))
    await delay(150)
    const narrow = await runFn(() => {
      const card = document.querySelector('.settings-subcard.settings-advanced')
      const delayRow = document.querySelector('.settings-delay-grid label')
      const bandRows = [...document.querySelectorAll('.settings-band-row')]
      const heightOf = (node) => node ? Math.round(node.getBoundingClientRect().height) : 0
      return {
        delayHeight: heightOf(delayRow),
        bandMaxHeight: Math.max(0, ...bandRows.map(heightOf)),
        cardOverflowX: card ? card.scrollWidth - card.clientWidth : 0,
        docOverflowX: document.documentElement.scrollWidth - window.innerWidth
      }
    })
    check(narrow.delayHeight > 0 && narrow.delayHeight < 40 && narrow.bandMaxHeight < 40,
      'the advanced audio rows stay on one line in a 900px window', narrow)
    check(narrow.cardOverflowX <= 1 && narrow.docOverflowX <= 1,
      'the advanced audio card does not overflow horizontally at 900px', narrow)
    await captureQaShot('settings-advanced-900.png')
    await win.setContentSize(1280, 800)
    await delay(200)

    // 宽屏（1600×900）：控制界面要横向铺满（用户反馈「不要窄窄居中」）。只截图留证，
    // 不新增断言数量（121 口径不变）；顺手把内容宽度打进日志，供人工核对右侧是否留白。
    await win.setContentSize(1600, 900)
    await delay(300)
    await runFn(() => document.querySelector('.settings-subcard.settings-advanced')?.scrollIntoView({ block: 'start' }))
    await delay(200)
    const wide = await runFn(() => {
      const layout = document.querySelector('.settings-layout')
      const card = document.querySelector('.settings-subcard.settings-advanced')
      const band = document.querySelector('.settings-band-grid')
      const delayGrid = document.querySelector('.settings-delay-grid')
      const cardRect = card ? card.getBoundingClientRect() : null
      const widthOf = (node) => node ? Math.round(node.getBoundingClientRect().width) : 0
      return {
        viewport: window.innerWidth,
        layoutWidth: widthOf(layout),
        cardWidth: widthOf(card),
        // 三频段/延迟控件列：width fix 后应接近 min(720px, 100%)，不再被旧的 420px 上限卡住。
        bandWidth: widthOf(band),
        delayWidth: widthOf(delayGrid),
        // 卡片右缘距窗口右缘的留白（px），用于判断「右侧无大空洞」。
        cardRightGap: cardRect ? Math.round(window.innerWidth - cardRect.right) : -1
      }
    })
    console.log('FULLWIDTH', JSON.stringify(wide))
    await captureQaShot('settings-fullwidth-1600.png')
    await win.setContentSize(1280, 800)
    await delay(200)

    // 回到歌曲中心：模态登录后组件重挂载，账号必须重新读回；后续用例依赖这块侧栏。
    await runFn(() => document.querySelector('[data-view-target="center"]').click())
    await waitUntil(() => Boolean(document.querySelector('.song-center')), 'song centre after login detour')
    if (!(await runFn(() => Boolean(document.querySelector('.center-side'))))) {
      await runFn(() => document.querySelector('.center-source[data-source="netease"]').click())
    }
    await waitUntil(() => document.querySelector('.account-copy strong')?.textContent === '模拟用户', 'account name after settings detour')

    await step('[...document.querySelectorAll(".center-side .account-action")].find(node => node.textContent.includes("我的歌单")).click()')
    await waitFor('Boolean(document.querySelector(".playlist-card"))', 'playlist cards')
    const cards = await run('[...document.querySelectorAll(".playlist-card")].map(node => node.textContent.trim())')
    check(cards.some(text => text.includes('我的歌单一')), 'the account playlist list maps the real envelope into cards', cards)

    await step('document.querySelector(".playlist-card").click()')
    await waitFor('document.querySelectorAll(".stream-row").length === 2', 'playlist tracks')
    const rows = await run('[...document.querySelectorAll(".stream-row .track-title")].map(node => node.textContent.trim())')
    check(rows[0] === '在线曲一' && rows[1] === '在线曲二', 'opening a playlist loads its tracks', rows)
    const layout = await run(`(() => {
      const center = document.querySelector('.song-center')
      const view = document.querySelector('.view-layer')
      const scroller = document.querySelector('.center-scroll')
      return { centerScroll: center.scrollHeight, centerClient: center.clientHeight,
        viewScroll: view.scrollHeight, viewClient: view.clientHeight,
        hasScroller: Boolean(scroller), listInScroller: Boolean(scroller && scroller.querySelector('.center-list')) }
    })()`)
    check(layout.centerScroll <= layout.centerClient + 2, 'the song centre fits its view instead of growing past it', layout)
    check(layout.hasScroller && layout.listInScroller, 'the track list scrolls inside the centre, not the whole page', layout)
    check(await run('Boolean(document.querySelector(".stream-row .row-cover img")) || Boolean(document.querySelector(".stream-row .row-cover svg"))'), 'each search/playlist row shows a cover slot')

    await step('document.querySelector(".stream-row .row-play").click()')
    await waitFor('document.querySelector(".pb-title")?.textContent === "在线曲一"', 'online now playing title')
    await waitFor('document.querySelector(".playbar")?.classList.contains("has-playing")', 'online playing state')
    check(await run('!document.querySelector(".pb-btn.play").disabled'), 'transport controls become enabled for an online track')
    const before = await run('document.querySelector(".progress-time.cur").textContent')
    await delay(1600)
    const after = await run('document.querySelector(".progress-time.cur").textContent')
    check(before !== after, 'the progress bar advances for an online track', { before, after })
    check(await run('document.querySelector(".pb-artist").textContent.includes("网易云音乐")'), 'the playbar names the platform the track came from')

    // 音乐空间：同一套状态驱动大标题与歌词（歌词来自平台接口）。
    await step('document.querySelector("[data-view-target=\\"home\\"]").click()')
    await waitFor('Boolean(document.querySelector(".music-space"))', 'music space after online play')
    await waitFor('document.body.textContent.includes("在线第一行")', 'platform lyrics in the listening room')
    check(await run('document.querySelector(".track-hero-title").textContent === "在线曲一"'), 'the listening room shows the online track identity')
    await run('window.twilight.request({ cmd: "stop" })')
    await delay(300)

    // ---- 全局搜索：结果行要有详细信息（封面/时长/专辑），并能展开详情面板 ----
    await step('document.querySelector("[data-view-target=\\"search\\"]").click()')
    await waitFor('Boolean(document.querySelector(".global-search"))', 'global search after online playback')
    await run(`(() => {
      const input = document.querySelector('.global-search .center-search input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await run("document.querySelector('.global-search .center-search .topbar-action').click()")
    await waitFor('Boolean(document.querySelector(".search-group .stream-row"))', 'grouped search results')
    const resultRow = await run(`(() => {
      const row = document.querySelector('.search-group .stream-row')
      const details = {
        haveCoverSlot: Boolean(row.querySelector('.row-cover')),
        duration: row.querySelector('.stream-meta')?.textContent ?? '',
        album: row.querySelector('.stream-copy small')?.textContent ?? '',
        haveExpand: Boolean(row.querySelector('.row-expand'))
      }
      row.querySelector('.row-expand')?.click()
      return details
    })()`)
    check(resultRow.haveExpand && resultRow.duration.length > 0 && /\d+:\d\d/.test(resultRow.duration),
      'each search result shows a duration', resultRow)
    await waitFor('Boolean(document.querySelector(".stream-detail"))', 'search detail panel')
    const detail = await run(`(() => {
      const panel = document.querySelector('.stream-detail')
      const facts = panel?.querySelector('.stream-facts')?.textContent || ''
      const actions = [...(panel?.querySelectorAll('.stream-actions button') || [])].map(node => node.textContent.trim())
      return { facts, actions, haveCover: Boolean(panel?.querySelector('.stream-detail-cover')) }
    })()`)
    check(detail.facts.includes('专辑') && detail.facts.includes('时长') && detail.facts.includes('曲目 ID'),
      'a search result opens a detail panel with album, duration and the platform id', detail)
    check(detail.actions.some(text => text.includes('播放')) && detail.actions.some(text => text.includes('下载')) && detail.actions.some(text => text.includes('复制')),
      'the detail panel offers play, download and copy actions', detail)

    await step('document.querySelector("[data-view-target=\\"library\\"]").click()')
    await waitFor('Boolean(document.querySelector(".library-view, .library-list, .track-list"))', 'library restored')

    // 没有进行中的扫码会话时，轮询必须**优雅结束**而不是抛错：
    // 抛出会让对话框把「已过期，请重新获取」显示成一条 IPC 栈信息。
    const orphanPoll = await run(`(async () => {
      try {
        const ticket = await window.twilight.streamingQrPoll('netease')
        return { ok: true, state: ticket.state }
      } catch (error) { return { ok: false, message: String(error && error.message) } }
    })()`)
    check(orphanPoll.ok && orphanPoll.state === 'expired',
      'polling without a live session reports expired instead of throwing', orphanPoll)
    check(downloadsView.empty && downloadsView.progress,
      'the queue starts empty and exposes progress events', downloadsView)

    await step('document.querySelector("[data-view-target=\\\"center\\\"]").click()')
    await run('document.querySelector("[data-view-target=\\"home\\"]").click()')
    await waitFor('Boolean(document.querySelector(".music-space"))', 'home after settings')
    // MASTER-B-app §4.1-7：切页 < 200ms。判据是「新视图真的出现在 DOM 里并画出内容」，
    // 而不是等动画结束 —— 交叠式过渡下新视图应当立刻挂载、随后淡入。
    const nav = await run(`(async () => {
      const t0 = performance.now()
      document.querySelector('[data-view-target="library"]').click()
      const present = await new Promise(res => { const id = setInterval(() => { if (document.querySelector('.view-library')) { clearInterval(id); res(performance.now() - t0) } }, 4) })
      const painted = await new Promise(res => { const id = setInterval(() => { if (document.querySelector('.view-library .track-row')) { clearInterval(id); res(performance.now() - t0) } }, 4) })
      return { present: Math.round(present), painted: Math.round(painted) }
    })()`)
    check(nav.painted < 200, 'switching views shows the new view within 200ms', nav)
    await waitFor('Boolean(document.querySelector(".library-title"))', 'library view')
    await step('document.querySelector("[data-view-target=\\"home\\"]").click()')
    await waitFor('Boolean(document.querySelector(".music-space"))', 'home return')
    await step('document.querySelector("[data-view-target=\\"sound\\"]").click()')
    await waitFor('Boolean(document.querySelector(".sound-page .frequency-panel"))', 'sound view')
    // ---- 音频控制中心（v4）：四 tab + 应用反馈 + 解码矩阵 + 限幅器（引擎能力如实回读）----
    const audioConsole = await run(`(() => {
      const tabs = [...document.querySelectorAll('.audio-console [data-audio-tab]')].map(node => node.dataset.audioTab)
      const active = document.querySelector('.audio-console [data-audio-tab][aria-selected="true"]')?.dataset.audioTab
      return { tabs, active, panel: Boolean(document.querySelector('.audio-console [data-audio-panel]')) }
    })()`)
    check(audioConsole.tabs.join(',') === 'eq,stage,output,limiter',
      'the sound page becomes an audio console with four control groups', audioConsole)
    check(audioConsole.active === 'eq' && audioConsole.panel, 'the audio console opens on the equaliser tab', audioConsole)
    // EQ tab 是默认打开的：先截一张，确认它和其它三条控制带是同一套材质。
    await win.setContentSize(1400, 1500)
    await delay(500)
    await captureQaShot('audio-console-eq-1400.png')
    await win.setContentSize(1280, 800)
    await delay(300)
    await step('document.querySelector(\'.audio-console [data-audio-tab="output"]\').click()')
    await waitFor('Boolean(document.querySelector(\'.audio-console [data-audio-panel="output"]\'))', 'output tab')
    const decodeMatrix = await run(`(() => {
      const items = [...document.querySelectorAll('.decode-matrix .decode-item')].map(node => ({
        kind: node.dataset.kind, text: node.textContent || ''
      }))
      return { items, devices: Boolean(document.querySelector('.audio-console select[aria-label="输出设备"]')) }
    })()`)
    check(decodeMatrix.items.length >= 4 && decodeMatrix.items.some(item => item.text.includes('flac')),
      'the output tab lists the decoders this engine really has', decodeMatrix)
    const decodeKinds = new Set(decodeMatrix.items.map(item => item.kind))
    check([...decodeKinds].every(kind => ['native', 'system', 'dsd', 'unsupported'].includes(kind)),
      'every decoder row declares how it is provided instead of implying everything is native', [...decodeKinds])
    // 横向铺满（用户明确要求）：控制界面不能窄窄居中，也不能「左边一张窄卡、右边一大片空白」。
    // 三条几何判据（靠肉眼发现过一次，所以固化成断言）：
    //   1) 控制带（.audio-card）宽度 ≥ 主区域 85%；
    //   2) 控制带内部的控件列 ≥ 2（控件是横向铺开的，不是竖着占一条窄缝）；
    //   3) tab 条占满整行宽度。
    const audioGeometry = await run(`(() => {
      const rect = selector => { const el = document.querySelector(selector); return el ? el.getBoundingClientRect().toJSON() : null }
      const bandEl = document.querySelector('.audio-console [data-audio-panel="output"] .audio-card')
      const bandRect = bandEl ? bandEl.getBoundingClientRect() : null
      const tabsRect = rect('.audio-console .audio-tabs')
      const mainRect = rect('.main')
      const style = bandEl ? getComputedStyle(bandEl) : null
      const tracks = style ? style.gridTemplateColumns.split(' ').filter(Boolean) : []
      const fields = bandEl ? [...bandEl.querySelectorAll(':scope > .audio-field')] : []
      const fieldTops = new Set(fields.map(node => Math.round(node.getBoundingClientRect().top)))
      return {
        bandWidth: bandRect ? Math.round(bandRect.width) : -1,
        mainWidth: mainRect ? Math.round(mainRect.width) : -1,
        tabsWidth: tabsRect ? Math.round(tabsRect.width) : -1,
        columns: tracks.length,
        fields: fields.length,
        fieldRows: fieldTops.size,
        rightGap: bandRect ? Math.round(window.innerWidth - bandRect.right) : -1
      }
    })()`)
    console.log('AUDIO_GEOMETRY', JSON.stringify(audioGeometry))
    check(audioGeometry.bandWidth >= Math.round(audioGeometry.mainWidth * 0.85),
      'each audio control band spans the main area instead of a narrow centred card', audioGeometry)
    check(audioGeometry.tabsWidth >= Math.round(audioGeometry.mainWidth * 0.85),
      'the audio tab bar spans the full row instead of a small pill in the corner', audioGeometry)
    check(audioGeometry.columns >= 2,
      'the controls inside a band flow in multiple columns at 1280px', audioGeometry)
    check(audioGeometry.fields > 0 && audioGeometry.fieldRows < audioGeometry.fields,
      'fields inside one band are laid out side by side rather than stacked in one narrow column', audioGeometry)
    // v6 高保真：384k 家族必须真的出现在输出采样率里，并且点下去引擎要认（请求值回读）。
    // 实际流是否到 384k 取决于端点能力，这里只断言「请求到达 + 引擎接受」，
    // 不假装在任何机器上都真的跑 384k。
    const rateChoice = await run(`(() => {
      const group = document.querySelector('.audio-console [aria-label="输出采样率"]')
      if (!group) return { found: false }
      const labels = [...group.querySelectorAll('button')].map(button => button.textContent.trim())
      const target = [...group.querySelectorAll('button')].find(button => button.textContent.trim() === '384k')
      if (target) target.click()
      return { found: true, labels, clicked: Boolean(target) }
    })()`)
    check(rateChoice.found && rateChoice.labels.includes('352.8k') && rateChoice.labels.includes('384k'),
      'the output rate picker really offers the 384k family', rateChoice)
    await delay(600)
    const highRateState = (await request({ cmd: 'get_state' })).data
    check(highRateState && highRateState.requestedOutputRate === 384000,
      'requesting 384 kHz reaches the engine instead of being silently capped', { requested: highRateState?.requestedOutputRate, actual: highRateState?.sampleRate })
    // 还原成「跟随源」：后面的断言依赖默认输出请求。
    await run(`(() => { const group = document.querySelector('.audio-console [aria-label="输出采样率"]'); const first = group ? group.querySelector('button') : null; if (first) first.click() })()`)
    await delay(400)

    await delay(700)
    // 窗口临时拉高再截：1280x800 只能看到「输出」卡的上半截，解码矩阵/信号路径
    // 全在视口外，截图无法作为视觉证据。截完整一屏后立刻恢复，不影响后续断言。
    await win.setContentSize(1400, 1500)
    await delay(500)
    await captureQaShot('audio-console-output-1280.png')
    await win.setContentSize(1280, 800)
    await delay(300)
    await win.setContentSize(1400, 1500)
    await step('document.querySelector(\'.audio-console [data-audio-tab="stage"]\').click()')
    await waitFor('Boolean(document.querySelector(\'.audio-console [data-audio-panel="stage"]\'))', 'stage tab')
    await delay(500)
    await captureQaShot('audio-console-stage-1400.png')
    // 反向判据（必须在 stage tab 真的可见时量，隐藏面板的元素 rect 全是 0）：
    // 控件盒子不许被邻格拉成一样高。用户抱怨的「一大片空白」正是 align-items: stretch
    // 把「只有一个复选框」的格子撑到和「两个滑杆 + 说明」一样高造成的。
    // 声道工具那条带里三个控件天然不同高（约 73 / 76 / 172px），若一样高就说明又被拉伸了。
    const stretch = await run(`(() => {
      const panel = document.querySelector('.audio-console [data-audio-panel="stage"]')
      const band = panel ? panel.querySelector('.audio-card') : null
      const fields = band ? [...band.querySelectorAll(':scope > .audio-field')] : []
      const heights = fields.map(node => Math.round(node.getBoundingClientRect().height))
      const tops = fields.map(node => Math.round(node.getBoundingClientRect().top))
      return { heights, alignedTop: new Set(tops).size === 1, spread: heights.length > 1 ? Math.max(...heights) - Math.min(...heights) : 0 }
    })()`)
    check(stretch.heights.every(height => height > 0) && stretch.alignedTop && stretch.spread >= 20,
      'control boxes hug their own content instead of being stretched to the tallest neighbour', stretch)
    await step('document.querySelector(\'.audio-console [data-audio-tab="limiter"]\').click()')
    await waitFor('Boolean(document.querySelector(\'.audio-console [data-audio-panel="limiter"]\'))', 'limiter tab')
    const limiter = await run(`(() => {
      const panel = document.querySelector('.audio-console [data-audio-panel="limiter"]')
      const toggle = panel.querySelector('input[type="checkbox"][aria-label="限幅器"]')
      return {
        toggle: Boolean(toggle),
        ceiling: Boolean(panel.querySelector('[aria-label="限幅器天花板(dBTP)"]')),
        unsupported: Boolean(panel.querySelector('.audio-unsupported')),
        usable: Boolean(toggle) && !toggle.disabled
      }
    })()`)
    // 判据挂在**引擎实际回包**上，而不是无条件要求可用：
    // 只要引擎回 state.dsp.limiter（= 实现了 CR-031），控件就必须可用；
    // 反之（用旧引擎跑 e2e，TWILIGHT_ENGINE 指向备份 exe）才允许置灰 + 说明。
    const limiterEngineOk = await run(`(async () => {
      const reply = await window.twilight.request({ cmd: 'get_state' })
      return Boolean(reply && reply.ok && reply.data && reply.data.dsp && reply.data.dsp.limiter)
    })()`)
    check(limiter.toggle && limiter.ceiling && (limiterEngineOk ? limiter.usable : limiter.unsupported),
      'the limiter is live exactly when the engine reports limiter state (CR-031)', { ...limiter, limiterEngineOk })
    await delay(500)
    await captureQaShot('audio-console-limiter-1400.png')
    // 窄窗（900×800）：控制带退回两列/一列，但不许出现横向溢出（滚动条之外的多余宽度）。
    await win.setContentSize(900, 800)
    await delay(500)
    const narrowConsole = await run(`(() => {
      const page = document.querySelector('.sound-page')
      const consoleEl = document.querySelector('.audio-console')
      const band = consoleEl ? consoleEl.querySelector('[data-audio-panel="limiter"] .audio-card') : null
      return {
        pageOverflow: page ? page.scrollWidth - page.clientWidth : -1,
        consoleOverflow: consoleEl ? consoleEl.scrollWidth - consoleEl.clientWidth : -1,
        bandColumns: band ? getComputedStyle(band).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        bandWidth: band ? Math.round(band.getBoundingClientRect().width) : -1
      }
    })()`)
    check(narrowConsole.pageOverflow <= 1 && narrowConsole.consoleOverflow <= 1,
      'the audio console does not overflow horizontally at 900px', narrowConsole)
    check(narrowConsole.bandColumns >= 2, 'control bands keep at least two columns at 900px', narrowConsole)
    await win.setContentSize(1280, 800)
    await delay(300)
    await step('document.querySelector(\'.audio-console [data-audio-tab="stage"]\').click()')
    await waitFor('Boolean(document.querySelector(\'.audio-console [data-audio-panel="stage"]\'))', 'stage tab')
    const stage = await run(`(() => {
      const panel = document.querySelector('.audio-console [data-audio-panel="stage"]')
      return { azimuth: Boolean(panel.querySelector('[aria-label="虚拟声源方位"]')), balance: Boolean(panel.querySelector('[aria-label="左右平衡"]')) }
    })()`)
    check(stage.azimuth && stage.balance, 'the stage tab exposes spatial azimuth and channel balance', stage)
    await step('document.querySelector(\'.audio-console [data-audio-tab="eq"]\').click()')
    await waitFor('Boolean(document.querySelector(".sound-page .frequency-panel"))', 'equaliser tab keeps the frequency panel')
    // v6.2：EQ 控制台是「调音台模式」—— 十路竖向推子并排，每路自带频率/Q/类型。
    // 旧版（v5）把十条 20px 滑杆塞进 1fr 且只有所选频段能改形状，用户原话是「你把控制台给压缩了」。
    const eqLayout = await run(`(() => {
      const panel = document.querySelector('.sound-page .frequency-panel')
      const plot = panel ? panel.querySelector('.frequency-plot') : null
      const bank = panel ? panel.querySelector('.eq-console-bank') : null
      const channels = bank ? [...bank.querySelectorAll('.eq-channel')] : []
      const faders = channels.map(channel => channel.querySelector('.eq-channel-fader')).filter(Boolean)
      const faderHeights = faders.map(fader => Math.round(fader.getBoundingClientRect().height))
      const widths = channels.map(channel => Math.round(channel.getBoundingClientRect().width))
      return {
        plotHeight: plot ? Math.round(plot.getBoundingClientRect().height) : -1,
        plotWidth: plot ? Math.round(plot.getBoundingClientRect().width) : -1,
        channels: channels.length,
        columns: bank ? getComputedStyle(bank).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        freqInputs: channels.filter(card => card.querySelector('[aria-label$="频率(Hz)"]')).length,
        qInputs: channels.filter(card => card.querySelector('[aria-label$=" Q"]')).length,
        faderHeights,
        minChannelWidth: widths.length > 0 ? Math.min(...widths) : -1
      }
    })()`)
    check(eqLayout.channels === 10 && eqLayout.freqInputs === 10 && eqLayout.qInputs === 10,
      'all ten EQ bands are individually tunable (frequency and Q), not just the selected one', eqLayout)
    check(eqLayout.plotHeight >= 280 && eqLayout.columns === 10,
      'the EQ console is not compressed: tall plot and ten side-by-side mixer channels', eqLayout)
    check(eqLayout.faderHeights.length === 10 && Math.min(...eqLayout.faderHeights) >= 180 && eqLayout.minChannelWidth >= 60,
      'each mixer fader is tall and wide enough to be operated precisely', eqLayout)
    // 真正下发一次：把第 1 段改到 80 Hz，引擎回读确认，再复位回工程网格。
    // 先等「参数已就绪 + EQ 打开」：面板刚挂载时开关还是 disabled，此时点它不生效，
    // 输入框也是 disabled —— 直接写 value 再 blur 不会触发提交（这是本测试唯一会假红的地方）。
    await waitFor('(() => { const t = document.querySelector(\'.sound-page .eq-toggle input[aria-label="EQ 开关"]\'); return Boolean(t) && !t.disabled })()', 'EQ toggle ready', 8000)
    await runFn(() => {
      const toggle = document.querySelector('.sound-page .eq-toggle input[aria-label="EQ 开关"]')
      if (toggle instanceof HTMLInputElement && !toggle.checked) toggle.click()
    })
    await waitFor('(() => { const i = document.querySelector(\'.eq-channel[data-band="1"] [aria-label="频段 1 频率(Hz)"]\'); return Boolean(i) && !i.disabled })()', 'band 1 frequency input enabled', 8000)
    await runFn(() => {
      const input = document.querySelector('.eq-channel[data-band="1"] [aria-label="频段 1 频率(Hz)"]')
      if (!(input instanceof HTMLInputElement)) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '80')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })
    let bandFreq = null
    for (let i = 0; i < 40; i += 1) {
      const state = (await request({ cmd: 'get_state' })).data
      bandFreq = state && state.dsp && state.dsp.eq && state.dsp.eq.bands ? state.dsp.eq.bands[0].freq : null
      if (bandFreq === 80) break
      await delay(100)
    }
    check(bandFreq === 80, 'editing one band frequency reaches the engine and is read back', { bandFreq })
    await runFn(() => document.querySelector('.eq-channel[data-band="1"] .eq-channel-reset')?.click())
    let resetFreq = null
    for (let i = 0; i < 40; i += 1) {
      const state = (await request({ cmd: 'get_state' })).data
      resetFreq = state && state.dsp && state.dsp.eq && state.dsp.eq.bands ? state.dsp.eq.bands[0].freq : null
      if (resetFreq !== 80) break
      await delay(100)
    }
    check(resetFreq !== null && resetFreq !== 80, 'the per-band reset returns the slot to the project grid frequency', { resetFreq })
    await step('document.querySelector("[data-view-target=\\"home\\"]").click()')
    await waitFor('Boolean(document.querySelector(".music-space .track-row"))', 'home quick list ready')
    await run('globalThis.qaEvents = []; window.twilight.onEvent(e => { if (e.ev === "state" || e.ev === "ready") globalThis.qaEvents.push(e) }); undefined')
    // 信号弹层是个**全局 pointerdown 关闭**的 toggle（Playbar.tsx:74-88）：
    // 任何点在它外面的 pointerdown 都会把它关掉。所以「点一次」不安全（第二次=关），
    // 而且中途任何真实交互都可能关掉它。这里抽成 ensureSignalPopover()：
    // 先看 aria-expanded，未开才点，然后**等状态提交**再继续 —— 断言只在打开态下做。
    const ensureSignalPopover = async () => {
      // 弹层可能被「点击外部」关掉，所以这里不是「点一次」，而是最多试 4 次：
      // 点开 → 等 aria-expanded=true 且 .signal-popover 真的在 DOM 里。
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const state = await runFn(() => {
          const button = document.querySelector('[aria-label=信号路径]')
          return {
            hasButton: Boolean(button),
            expanded: button ? button.getAttribute('aria-expanded') : null,
            popover: Boolean(document.querySelector('.signal-popover'))
          }
        })
        if (state.hasButton && state.expanded === 'true' && state.popover) return
        if (!state.hasButton) {
          // 按钮不在说明当前视图还没渲染播放栏：等一会儿再试。
          await delay(200)
          continue
        }
        if (state.expanded === 'true' && !state.popover) {
          // 状态说开着但 DOM 还没有：等 React 提交。
          await delay(120)
          continue
        }
        await runFn(() => {
          const button = document.querySelector('[aria-label=信号路径]')
          if (button) button.click()
        })
        await delay(150)
      }
      // 真的开不了：把现场打出来，而不是只丢一句 timed out（上一轮就吃了这个亏）。
      const diagnosis = await runFn(() => {
        const button = document.querySelector('[aria-label=信号路径]')
        return {
          expanded: button ? button.getAttribute('aria-expanded') : null,
          outer: button ? button.outerHTML.slice(0, 200) : null,
          popover: document.querySelector('.signal-popover')?.className ?? null,
          overlays: [...document.querySelectorAll('.queue-overlay, .discover-detail-layer')].map(node => node.className),
          view: document.querySelector('.view-layer')?.className ?? null
        }
      })
      throw new Error('signal popover would not open: ' + JSON.stringify(diagnosis))
    }
    await ensureSignalPopover()
    check(!await run('Boolean(document.querySelector(".proto-banner"))'), 'startup has no protocol banner')
    await run('document.querySelectorAll(".track-row")[1].click()')
    await delay(50)
    check(await run('document.querySelectorAll(".track-row")[1].getAttribute("aria-selected") === "true" && !document.querySelector(".track-row.loaded")'), 'single click selects a row without starting playback')
    check(await run('[...document.querySelectorAll(".pb-btn")].every(button => button.querySelector("svg") && button.getAttribute("aria-label"))'), 'transport controls use accessible vector icons')
    check(await run('getComputedStyle(document.querySelector(".pb-controls")).backdropFilter.includes("blur")'), 'playback controls use a single translucent glass surface')
    const glassSize = await run('document.querySelector(".pb-controls").getBoundingClientRect().toJSON()')
    await run(`(() => { const el = document.querySelector('.pb-controls'); const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: r.left + r.width * 0.8, clientY: r.top + r.height * 0.3 })); })()`)
    await delay(250)
    check(await run('getComputedStyle(document.querySelector(".pb-controls"), "::before").content !== "none" && Number(getComputedStyle(document.querySelector(".pb-controls"), "::before").opacity) > 0.5'), 'glass highlight responds to the pointer')
    const glassMoved = await run('document.querySelector(".pb-controls").getBoundingClientRect().toJSON()')
    check(glassSize.width === glassMoved.width && glassSize.height === glassMoved.height, 'glass feedback keeps control hit targets stable')
    await run('document.querySelector(".pb-controls").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }))')
    const list = await request({ cmd: 'list_tracks' })
    assert.ok(list.ok && list.data.tracks.length > 0)
    await request({ cmd: 'set_volume', volume: 0 })
    await request({ cmd: 'set_output', mode: 'shared' })
    await run('document.querySelector(".track-row").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))')
    await waitFor('Boolean(document.querySelector(".lyric-romanization"))', 'lyrics')
    await waitFor('Boolean(document.querySelector(".track-row.playing"))', 'open/play chain completion')
    const ruby = await run(`(() => {
      const note = document.querySelector('.lyric-ruby')
      const unit = document.querySelector('.lyric-word-unit')
      const base = unit && unit.querySelector('.lyric-word')
      if (!note || !base) return null
      const noteBox = note.getBoundingClientRect()
      const baseBox = base.getBoundingClientRect()
      return {
        text: note.textContent,
        above: noteBox.bottom <= baseBox.top + 1,
        noteFill: getComputedStyle(note).webkitTextFillColor,
        baseFill: getComputedStyle(base).webkitTextFillColor
      }
    })()`)
    check(ruby !== null && ruby.text === 'よぞら', 'ruby annotation (word.ruby) is rendered')
    check(ruby !== null && ruby.above, 'the ruby sits above its base glyph instead of overprinting it')
    // 逐字填充靠 background-clip:text + 透明字色。注音若被塞进 .lyric-word 里会被一起裁成透明 —— 所以它必须是兄弟节点。
    check(ruby !== null && ruby.baseFill === 'rgba(0, 0, 0, 0)' && ruby.noteFill !== 'rgba(0, 0, 0, 0)', 'ruby stays outside the word-fill clip, so it is actually visible')
    // 行级歌词必须补出可填充的字级时间，否则这条曲库里的绝大多数歌永远没有填充动效。
    const fillPlan = await run(`(() => {
      const lines = Array.from(document.querySelectorAll('.lyric-line'))
      return {
        real: lines[0] ? lines[0].querySelectorAll('.lyric-word').length : 0,
        interpolated: lines[2] ? lines[2].querySelectorAll('.lyric-word').length : 0,
        kind: (document.querySelector('.lyrics-kind') || {}).textContent || '',
        label: (document.querySelector('.lyrics-source') || {}).textContent || ''
      }
    })()`)
    check(fillPlan.real === 1, 'a line that already carries word-level data keeps exactly its own words')
    check(fillPlan.interpolated > 1, 'a line with only line-level timing gets interpolated words, so the fill can run: ' + JSON.stringify(fillPlan))
    check(fillPlan.kind.includes('插值') && fillPlan.label.includes('插值'), 'the UI says plainly that the fill is interpolated, not native')
    // 「保存到本地」只对在线来源出现：本地文件已经是本地的，再给一个保存按钮只会误导。
    check(await run(`!document.querySelector('[aria-label="保存歌词到本地"]')`), 'the save button is hidden for a local lyric source')
    // 人工纠正匹配：按钮 → 候选面板 → 选一条 → 面板关闭。
    check(await run(`(() => { const b = document.querySelector('[aria-label="换一个歌词匹配"]'); if (!b) return false; b.click(); return true })()`), 'the hand-pick button exists')
    await waitFor('document.querySelectorAll(".lyrics-candidate").length === 2', 'candidate panel lists the search hits')
    const candidateRows = await run(`Array.from(document.querySelectorAll('.lyrics-candidate')).map(n => n.textContent)`)
    check(candidateRows[0].includes('candidate one') && candidateRows[0].includes('90%'), 'a candidate shows its title and score: ' + candidateRows[0])
    check(candidateRows[1].includes('高风险'), 'a risky candidate is flagged in the list')
    await run('document.querySelector(".lyrics-candidate").click()')
    await waitFor('!document.querySelector(".lyrics-candidates")', 'panel closes once a candidate is chosen')
    check(await run('!document.querySelector(".lyrics-candidates")'), 'choosing a candidate dismisses the panel')
    check(await run(`Boolean(document.querySelector('.lyrics-source-controls')) && Boolean(document.querySelector('[aria-label="关联 LRC 歌词"]')) && Boolean(document.querySelector('[aria-label="歌词偏移毫秒"]')) && Boolean(document.querySelector('[aria-label="应用歌词偏移"]')) && Boolean(document.querySelector('[aria-label="歌词延后 50 毫秒"]'))`), 'lyrics controls expose local source association and timing adjustment')
    const lyricFile = path.join(artifacts, 'attached-fixture.lrc')
    fs.writeFileSync(lyricFile, '[00:01.00]Attached fixture')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lyricFile] })
    const lyricConfig = await run(`(async () => {
      const audio = ${JSON.stringify(list.data.tracks[0].path)}
      const file = ${JSON.stringify(lyricFile)}
      const attached = await window.twilight.attachLyrics(audio)
      const shifted = await window.twilight.setLyricsOffset(audio, 50)
      const cleared = await window.twilight.clearAttachedLyrics(audio)
      const reset = await window.twilight.setLyricsOffset(audio, 0)
      return {
        attached: Object.values(attached.tracks).some(entry => entry.attachedPath === file),
        shifted: Object.values(shifted.tracks).some(entry => entry.offsetMs === 50),
        cleared: Object.values(cleared.tracks).every(entry => !entry.attachedPath),
        reset: Object.keys(reset.tracks).length === 0
      }
    })()`)
    check(lyricConfig.attached && lyricConfig.shifted && lyricConfig.cleared && lyricConfig.reset, 'lyric source and offset preferences persist through explicit preload APIs', lyricConfig)
    await request({ cmd: 'pause' })
    await request({ cmd: 'set_eq', enabled: true })
    // 弹层是「全局 pointerdown 关闭」的 toggle：中间任何一次真实交互都可能把它关掉，
    // 所以每条依赖 .c2-path 的断言前都要重新确认它开着（而不是只在开头确认一次）。
    await ensureSignalPopover()
    await waitFor('Boolean(document.querySelector(".c2-path")?.getAttribute("aria-label").includes("EQ"))', 'DSP state')
    check(await run('Array.from(document.querySelectorAll(".c2-path path")).some(p => p.getAttribute("d").includes(" q "))'), 'DSP state renders a wave')
    check(!await run('Boolean(document.querySelector(".c2-bp"))'), 'DSP disables BP')
    // 播放栏新增控件：循环四态 / 原生静音 / 输出模式偏好。
    // 这里只注入**权威 state 事件**（不发真实命令）—— 要验的正是「UI 跟随引擎，而不是跟随自己的记忆」。
    const injectState = (extra) => win.webContents.send('twilight:event', {
      ev: 'state', state: 'playing', trackId: list.data.tracks[0].trackId,
      positionMs: 0, durationMs: list.data.tracks[0].durationMs,
      sampleRate: 48000, bitDepth: 24, bitPerfect: false, outputMode: 'shared', ...extra
    })
    check(await run('Boolean(document.querySelector(".pb-btn.repeat")) && document.querySelector(".pb-controls .pb-btn.repeat").getAttribute("aria-label").includes("循环模式")'), 'the playbar exposes a repeat control that names its mode')

    injectState({ repeatMode: 'shuffle', muted: true, volume: 0.42 })
    await waitFor('document.querySelector(".pb-btn.repeat").getAttribute("aria-label").includes("随机播放")', 'repeat mode follows the engine')
    check(await run('document.querySelector(".pb-btn.repeat").classList.contains("active")'), 'a non-default repeat mode is visibly active')
    check(await run('document.querySelector(".volume-icon").getAttribute("aria-pressed") === "true" && document.querySelector(".volume").classList.contains("muted")'), 'muted state from the engine is shown on the volume control')
    check(await run('document.querySelector("[aria-label=音量]").value === "0.42" && document.querySelector(".volume-value").textContent === "42%"'), 'a muted state event still shows the chosen level (muting does not zero it)')

    // 恢复成引擎的实际状态，别把注入值留给后面的断言
    injectState({ repeatMode: 'sequential', muted: false, volume: 0 })
    await waitFor('document.querySelector(".pb-btn.repeat").getAttribute("aria-label").includes("顺序播放")', 'repeat mode restored')

    // 信号弹层是个 toggle，而且测试前面已经打开过它：这里要「确保打开」而不是再点一次，
    // 否则会把已经开着的弹层关掉（本轮就踩了这个）。它同样必须保持开着 —— 后面还有依赖它的断言。
    await ensureSignalPopover()
    await waitFor('Boolean(document.querySelector(".output-mode"))', 'output mode group')
    check(await run('document.querySelectorAll(".output-mode button").length === 3'), 'the signal panel offers three output preferences')
    check(await run('document.querySelectorAll(".output-rate button").length === 9'), 'the signal panel offers nine output sample-rate choices (up to 384 kHz)')
    check(await run('[...document.querySelectorAll(".output-rate button")].some(button => button.textContent.trim() === "384k")'),
      '384 kHz is offered for real instead of being capped at 192 kHz')
    check(await run('document.querySelector(".rate-summary").textContent.includes("跟随源")'), 'the rate summary names what is requested now')
    injectState({ outputMode: 'exclusive', muted: false, volume: 0 })
    await waitFor('document.querySelector(".signal-popover .mode-summary").textContent === "当前：独占输出"', 'actual output mode is stated')
    check(await run('document.querySelector(".signal-popover .mode-summary").textContent === "当前：独占输出"'), 'the panel states the actual engine mode, not the requested one')

    // 没有有效 meter 帧时面板必须如实留空，而不是画一条平线冒充静音。
    check(await run('Boolean(document.querySelector(".spectrum-panel")) && Boolean(document.querySelector(".spectrum-panel .spectrum-empty"))'), 'the home view keeps the spectrum empty until a measured frame arrives')
    check(await run('document.querySelector(".spectrum-panel svg").getAttribute("data-meter-ready") === "false" && document.querySelector(".spectrum-line").getAttribute("d") === ""'), 'without a meter event the panel draws nothing rather than a flat line')

    // 注入一帧（引擎落地前只有测试能提供数据）——验曲线真的按频段画出来
    const meterFrame = { ev: 'meter', rmsDb: [-18.2, -18.4], peakDb: [-6.1, -5.9], peakHoldDb: [-3.2, -3.3],
      truePeakDb: [-2.8, -2.7], truePeakBasis: 'oversampled', lufsMomentary: -16.4, gainReductionDb: -1.2,
      spectrum: Array.from({ length: 48 }, (_, i) => -30 + Math.sin(i / 4) * 18) }
    win.webContents.send('twilight:event', meterFrame)
    await waitFor('document.querySelector(".spectrum-panel svg").getAttribute("data-meter-ready") === "true"', 'meter curve')
    const curve = await run('document.querySelector(".spectrum-line").getAttribute("d")')
    check(typeof curve === 'string' && curve.startsWith('M') && curve.split(' C').length === 48, 'a live curve smoothly connects every measured band point')
    check(await run('document.querySelector(".spectrum-line").getAttribute("d") !== document.querySelector(".spectrum-area").getAttribute("d") && document.querySelector(".spectrum-area").getAttribute("d").endsWith("Z")'), 'the area under the curve is filled like the EQ chart')
    check(await run('document.querySelector(".spectrum-readout").textContent.includes("-16.4") && document.querySelector(".spectrum-readout").textContent.includes("-6.1")'), 'the readout carries the engine numbers')
    check(await run('document.querySelector(".spectrum-readout").textContent.includes("-1.2")'), 'limiter gain reduction has its own place in the readout')

    // CR-015 口径 5：真峰值基准是「样本峰值」时必须看得见区别
    win.webContents.send('twilight:event', { ...meterFrame, truePeakBasis: 'sample' })
    await waitFor('document.querySelector(".spectrum-readout").textContent.includes("样本峰值")', 'true-peak basis marker')
    check(await run('document.querySelector(".spectrum-readout").textContent.includes("样本峰值")'), 'a sample-peak basis is labelled instead of being sold as true peak')

    // MASTER-B-app §A1：引擎日志（外部文本）进控制台前必须脱敏。
    // 判据是「注入的秘密子串没有出现在 console.warn 的实参里」，而不是看打了什么星号。
    // 表达式末尾必须返回可序列化的值：run() 是 executeJavaScript，返回一个函数会报
    // "An object could not be cloned"（本轮就踩了）。赋值表达式加上 `; undefined` 才是这个项目里的惯例写法。
    await run('globalThis.__logs = []; globalThis.__warn = console.warn; console.warn = (...args) => { globalThis.__logs.push(args.map(String).join(" ")) }; undefined')
    win.webContents.send('twilight:event', { ev: 'log', level: 'warn', message: 'proxy GET /media/x?token=SECRET-TOKEN-123 Cookie: MUSIC_U=COOKIE-VALUE-999 Bearer abc.def.ghi' })
    await delay(150)
    const logs = await run('globalThis.__logs.join("\\n")')
    check(logs.includes('[engine:log]'), 'engine log lines still reach the console (the check is meaningful)', logs.slice(0, 120))
    check(!logs.includes('SECRET-TOKEN-123') && !logs.includes('COOKIE-VALUE-999'), 'a credential inside an engine log line never reaches the console', logs.slice(0, 200))
    await run('console.warn = globalThis.__warn; undefined')

    // 形状不对的帧整帧丢弃：不能把上一帧画好的曲线擦掉
    win.webContents.send('twilight:event', { ev: 'meter', rmsDb: [-1] })
    await delay(200)
    check(await run('document.querySelector(".spectrum-line").getAttribute("d").length > 100'), 'a malformed frame does not blank the last good curve')

    // 等歌词画笔真正跑过一帧：它会把 `--fill` 写到词上。负载高时首帧可能晚于注入事件，
    // 之前直接注入 position 会读到空值（Number('')=0）而假红。画笔若始终不跑，这里会真红。
    await waitFor('(() => { const w = document.querySelector(".lyric-word"); return !!w && getComputedStyle(w).getPropertyValue("--fill") !== "" })()', 'lyric fill painter ready')
    const failure = await request({ cmd: 'pick_folder' })
    check(!failure.ok && failure.error.code === 'ERR_UNSUPPORTED' && failure.error.kind === 'not_implemented', 'error.kind survives real Electron IPC and preload')
    await win.setContentSize(1280, 800)
    await delay(600)
    const subtitle = await run(`(() => {
      const lines = [...document.querySelector('.lyric-line').querySelectorAll('.lyric-tr')];
      return { text: lines.map(n => n.textContent), rows: lines.map(n => n.getBoundingClientRect().toJSON()),
        original: document.querySelector('.lyric-word').textContent };
    })()`)
    check(subtitle.text.length === 2 && subtitle.rows[0].bottom <= subtitle.rows[1].top, 'romanization and translation occupy distinct lines')
    check(subtitle.original === '夜空 e\u0301 你好', 'combining characters retain original text')

    // 逐字填充（REFS-B2 §2.6）：位置在词内推进，填充比例必须跟着连续推进，
    // 而不是「到点才跳变」。注入的 fixture 是一个词跨 0–100000ms，比例应≈position/100000。
    // 此刻引擎已暂停，不会有真实 position 事件与注入值竞争。
    // 注入权威 position 后，画笔要在**下一帧**才会写到 --fill 上。窗口刚被缩放过
    // （音频控制中心那几张截图）时 Chromium 可能压掉一两帧，读得太早会读到上一帧的值 ——
    // 这不是产品缺陷，但会让「填充是否推进」断言假红（本轮实测约 50% 概率）。
    // 所以这里等「值真的变成期望值」为止（最多 ~1.2s），超时就把最后一次读到的数返回，
    // 让断言自己判红 —— 既不放过真回归，也不被丢帧误伤。
    const fillAt = async (ms, expected = null) => {
      const deadline = Date.now() + 1200
      let value = 0
      while (Date.now() < deadline) {
        win.webContents.send('twilight:event', { ev: 'position', positionMs: ms, durationMs: activeDurationMs })
        await delay(120)
        value = await run(`Number(getComputedStyle(document.querySelector('.lyric-word')).getPropertyValue('--fill'))`)
        if (expected === null ? Number.isFinite(value) : Math.abs(value - expected) < 0.02) return value
      }
      // 超时就多打一行现场（这张表是排查位置注入类假红的唯一入口）。
      console.warn('LYRIC_FILL_MISS', JSON.stringify(await run(`(() => {
        const words = [...document.querySelectorAll('.lyric-word')]
        return {
          want: ${ms}, got: ${value},
          progress: document.querySelector('.progress-time') ? document.querySelector('.progress-time').textContent : null,
          view: document.querySelector('.view-layer') ? document.querySelector('.view-layer').className : null,
          lyricsCount: document.querySelectorAll('.lyrics').length,
          lyricsVisible: document.querySelector('.lyrics') ? document.querySelector('.lyrics').getAttribute('data-visible') : null,
          words: words.length,
          firstWordClass: words[0] ? words[0].className : null,
          fills: words.slice(0, 3).map(word => getComputedStyle(word).getPropertyValue('--fill')),
          activeLine: document.querySelector('.lyric-line.active') ? document.querySelector('.lyric-line.active').textContent.slice(0, 24) : null,
          activeCount: document.querySelectorAll('.lyric-line.active').length
        }
      })()`)))
      return value
    }
    // store 有一条过期保护：带 trackId 的 position/state 事件若与渲染层已装载的曲目不符
    // 会被直接丢弃。而"已装载曲目"可能是播放记忆恢复出来的，不等于 list.data.tracks[0] ——
    // 所以这里不猜：
    //   - position 事件**不带 trackId**（store 会用当前装载曲目补上，天然不会被丢弃）；
    //   - state 事件需要的 trackId 从歌词夹具本身读回（夹具第二行的文本就是 mock 收到的曲目 id）。
    const loadedTrackId = await run('document.querySelectorAll(".lyric-line")[1]?.textContent ?? ""')
    assert.ok(loadedTrackId, 'the lyrics fixture exposes the loaded track id')
    const activeDurationMs = list.data.tracks[0].durationMs
    const f0 = await fillAt(0, 0)
    const f25 = await fillAt(25000, 0.25)
    const f50 = await fillAt(50000, 0.5)
    const f75 = await fillAt(75000, 0.75)
    check(f0 === 0 && f25 > 0.2 && f25 < 0.3 && f50 > 0.45 && f50 < 0.55 && f75 > 0.7 && f75 < 0.8,
      'lyric fill advances continuously inside one word', { f0, f25, f50, f75 })

    // 像素证据：填充到一半时，同一个字的左半应当明显比右半亮 ——
    // 说明渐变确实裁在字形上，而不是整词换色。
    const wordBox = await run(`(() => { const r = document.querySelector('.lyric-word').getBoundingClientRect()
      return { x: Math.floor(r.x) - 2, y: Math.floor(r.y) - 2, width: Math.ceil(r.width) + 4, height: Math.ceil(r.height) + 4 } })()`)
    const halvesAt = async (ms, expected) => {
      await fillAt(ms, expected)
      const shot = await win.webContents.capturePage(wordBox)
      const bmp = shot.getBitmap()
      const { width, height } = shot.getSize()
      const mean = (from, to) => {
        let sum = 0, n = 0
        for (let y = 0; y < height; y++) for (let x = from; x < to; x++) { const i = (y * width + x) * 4; sum += (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3; n++ }
        return sum / Math.max(1, n)
      }
      return { left: mean(0, Math.floor(width / 2)), right: mean(Math.floor(width / 2), width) }
    }
    const empty = await halvesAt(0, 0)
    const half = await halvesAt(50000, 0.5)
    const nearlyFull = await halvesAt(99000, 0.99)
    check(half.left > half.right + 8, 'a half-filled word is brighter on its left half', half)
    check(nearlyFull.left > empty.left + 8 && nearlyFull.right > empty.right + 8,
      'a finished word is filled across its whole width', { empty, nearlyFull })
    // 补间：逐字填充按**显示刷新率**推进（REFS-B app：轻量补间可以，但必须能被真实状态纠正；
    // DESIGN-v3：用 rAF 节流到刷新率，而不是每个 position 事件都动）。
    // 判据是「两次权威事件之间的帧里填充也在变」——事件驱动的话 200ms 内只有约 2 个不同值。
    win.webContents.send('twilight:event', { ev: 'state', state: 'playing', trackId: loadedTrackId, positionMs: 50000, durationMs: activeDurationMs, sampleRate: 48000, bitDepth: 24, outputMode: 'shared' })
    const tween = await run(`(async () => {
      const seen = new Set()
      for (let i = 0; i < 12; i++) {
        const word = document.querySelector('.lyric-word')
        if (word) seen.add(getComputedStyle(word).getPropertyValue('--fill').trim())
        await new Promise(r => requestAnimationFrame(r))
      }
      return [...seen]
    })()`)
    check(Array.isArray(tween) && tween.length >= 5, 'the karaoke fill is repainted per frame, not per position event', { distinct: tween?.length })
    // 回到暂停：后面的断言依赖权威状态而不是我注入的播放态。
    win.webContents.send('twilight:event', { ev: 'state', state: 'paused', trackId: loadedTrackId, positionMs: 50000, durationMs: activeDurationMs, sampleRate: 48000, bitDepth: 24, outputMode: 'shared' })
    await delay(120)

    // 让截图落在「半填充」上：dsp-1280.png 因此能直接看到填充停在字中间。
    await fillAt(50000)
    fs.writeFileSync(path.join(artifacts, 'dsp-1280.png'), (await win.webContents.capturePage()).toPNG())
    const activeText = await run('document.querySelector(".lyric-line.active").textContent')
    win.setContentSize(900, 800)
    await run('document.querySelector(".home-lyrics").style.display = "none"')
    await delay(250)
    win.webContents.send('twilight:event', { ev: 'position', positionMs: 100500, durationMs: activeDurationMs })
    await delay(100)
    check(await run('document.querySelector(".lyric-line.active").textContent') === activeText, 'hidden lyrics stop processing position updates')
    win.setContentSize(1280, 800)
    await run('document.querySelector(".home-lyrics").style.display = ""')
    // waitFor 已经保证「追上最新位置」；这里再把追上之后的内容钉住，避免 waitFor 因
    // 选择器写错而恒真（历史上 check(true) 就吃过这种哑弹）。
    await waitFor('document.querySelector(".lyric-line.active")?.textContent === ' + JSON.stringify(loadedTrackId), 'visible lyrics catch up')
    const caughtUp = await run('document.querySelector(".lyric-line.active")?.textContent ?? ""')
    check(caughtUp === loadedTrackId, 'expanded lyrics catch up to the latest engine position', { caughtUp })
    const second = list.data.tracks[1]
    const third = list.data.tracks[2]
    lyricDelays.set(second.trackId, 500)
    await request({ cmd: 'open', trackId: second.trackId })
    for (let i = 0; i < 100 && !requestedLyrics.includes(second.trackId); i++) await delay(10)
    assert.ok(requestedLyrics.includes(second.trackId), 'slow lyric request started')
    check(await run('document.querySelectorAll(".lyric-line").length') === 0, 'new track clears old lyrics while its request is pending')
    await request({ cmd: 'open', trackId: third.trackId })
    await waitFor('document.querySelectorAll(".lyric-line")[1]?.textContent === ' + JSON.stringify(third.trackId), 'newer lyrics')
    await delay(600)
    check(await run('document.querySelectorAll(".lyric-line")[1]?.textContent') === third.trackId, 'late lyric response cannot replace the new track')
    await request({ cmd: 'set_eq', enabled: false })
    await ensureSignalPopover()
    await waitFor('!document.querySelector(".c2-path")?.getAttribute("aria-label").includes("数字信号处理生效")', 'DSP bypass')
    check(!await run('Array.from(document.querySelectorAll(".c2-path path")).some(p => p.getAttribute("d").includes(" q "))'), 'DSP bypass removes wave')
    win.webContents.send('twilight:disconnect', 'test disconnect')
    await waitFor('Boolean(document.querySelector(".proto-banner"))', 'disconnect banner')
    win.webContents.send('twilight:event', { ev: 'ready', protocol: 1, version: 'test', devices: [] })
    await waitFor('!document.querySelector(".proto-banner")', 'reconnected banner clears')
    check(await run('document.querySelector(".c1-dot").dataset.sev !== "error"'), 'successful reconnect clears connection error and red signal')
    const degraded = trace.events.find(e => e.ev === 'state' && e.degradeReason)
    win.webContents.send('twilight:event', { ...degraded, state: 'paused', xrunCount: 8 })
    await ensureSignalPopover()
    await waitFor('Boolean(document.querySelector(".c2-path.sev-warn .c2-dash"))', 'fallback geometry')
    const colors = await run(`(() => {
      const node = document.createElement('span'); node.style.color = 'var(--c1-warn)'; document.body.append(node);
      const colors = [getComputedStyle(document.querySelector('.c2-dash')).stroke, getComputedStyle(node).color];
      node.remove(); return colors;
    })()`)
    check(colors[0] === colors[1], 'degradation dash uses warning color')
    check(await run('document.querySelector(".c2-path").getAttribute("aria-label").includes("xrun 8")'), 'session xrun total is accessible')
    win.webContents.send('twilight:event', { ev: 'xrun', count: 9, bufferMs: 10 })
    await delay(50)
    check(await run('getComputedStyle(document.querySelector(".c1-dot")).animationName === "c1flash"'), 'xrun flash takes priority over an existing degradation blink')
    await waitFor('!document.querySelector(".c1-dot").classList.contains("flashing")', 'finite xrun animation completes')
    check(await run('!document.querySelector(".c1-dot").classList.contains("flashing")'), 'finite flash cleans up after its animation ends')
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(artifacts, 'fallback-1280.png'), image.toPNG())
    fs.writeFileSync(path.join(artifacts, 'fallback-mosaic.png'), image.resize({ width: 24, height: 16 }).resize({ width: 768, height: 512, quality: 'good' }).toPNG())
    for (const width of [1280, 900]) {
      win.setContentSize(width, 800)
      await delay(350)
      const layout = await run(`(() => {
        const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
        return { c2: rect('.c2-path'), progress: rect('.progress'), volume: rect('.volume'), width: innerWidth };
      })()`)
      check(layout.c2.left >= 0 && layout.c2.right <= layout.width && layout.progress.right <= layout.volume.left && layout.volume.right <= layout.width, 'playbar and signal popover fit at ' + width)
      fs.writeFileSync(path.join(artifacts, 'fallback-' + width + '.png'), (await win.webContents.capturePage()).toPNG())
    }
    // ---- v3 §1.4：文件夹视图 / 播放队列 / 排序（引擎是队列唯一权威）----
    await runFn(() => document.querySelector('[data-view-target="library"]').click())
    await waitUntil(() => Boolean(document.querySelector('.library')), 'library for folder view')
    await runFn(() => [...document.querySelectorAll('.library [aria-label="文件夹视图"]')][0].click())
    await waitUntil(() => Boolean(document.querySelector('.folder-browser')), 'folder browser')
    const folders = await runFn(() => {
      const browser = document.querySelector('.folder-browser')
      return {
        cards: browser.querySelectorAll('.folder-card').length,
        files: browser.querySelectorAll('.folder-file').length,
        crumbs: [...browser.querySelectorAll('.folder-crumb')].map(node => node.textContent.trim()),
        summary: browser.querySelector('.folder-summary')?.textContent ?? '',
        actions: [...browser.querySelectorAll('.folder-actions .topbar-action')].map(node => node.textContent.trim())
      }
    })
    check(folders.cards > 0 || folders.files > 0, 'the folder view builds a hierarchy from track paths', folders)
    check(folders.crumbs.length === 1 && folders.crumbs[0] === '全部曲库', 'the folder breadcrumb starts at the whole library', folders)
    check(/\d+ 首/.test(folders.summary), 'the folder view reports the current folder song count', folders)
    if (folders.cards > 0) {
      await runFn(() => document.querySelector('.folder-card .folder-open').click())
      await waitUntil(() => document.querySelectorAll('.folder-crumb').length >= 2, 'enter a folder')
      check(await runFn(() => document.querySelectorAll('.folder-file').length > 0 || document.querySelectorAll('.folder-card').length > 0),
        'opening a folder shows its songs or its subfolders')
    }
    // 当前节点「加入队列」= 一次加入其全部后代（根层平铺时也成立）。
    const enqueued = await runFn(async () => {
      const button = [...document.querySelectorAll('.folder-actions .topbar-action')].find(node => node.textContent.includes('加入队列'))
      if (!button || button.disabled) return 0
      button.click()
      for (let i = 0; i < 100; i += 1) {
        const state = await window.twilight.request({ cmd: 'get_state' })
        const queue = state && state.data && state.data.queue
        if (Array.isArray(queue) && queue.length > 0) return queue.length
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return 0
    })
    check(enqueued > 0, 'a folder (whole subtree) can be appended to the playback queue', { enqueued })

    // 播放队列抽屉：行=engine queue；排序/移除/清空都必须回到 engine。
    const queueBefore = await runFn(async () => {
      const state = await window.twilight.request({ cmd: 'get_state' })
      return state && state.data && Array.isArray(state.data.queue) ? state.data.queue.length : 0
    })
    if (queueBefore < 2) {
      // 队列太短：走真实 UI（曲库歌曲 tab 选中几行 →「加入队列」），不直接调 set_queue，
      // 这样 e2e 覆盖的是用户路径而不是内部命令。
      const filled = await runFn(async () => {
        document.querySelector('[data-view-target="library"]').click()
        await new Promise(resolve => setTimeout(resolve, 150))
        const songsTab = [...document.querySelectorAll('.segmented-control button[aria-label="歌曲列表"]')][0]
        if (songsTab) songsTab.click()
        await new Promise(resolve => setTimeout(resolve, 150))
        const rows = [...document.querySelectorAll('.track-row')].slice(0, 3)
        for (const row of rows) row.click()
        await new Promise(resolve => setTimeout(resolve, 100))
        const add = [...document.querySelectorAll('.library-selection .topbar-action')].find(node => node.textContent.includes('加入队列'))
        if (!add) return 0
        add.click()
        for (let i = 0; i < 80; i += 1) {
          const state = await window.twilight.request({ cmd: 'get_state' })
          const queue = state && state.data && state.data.queue
          if (Array.isArray(queue) && queue.length >= 2) return queue.length
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        return 0
      })
      check(filled >= 2, 'selecting library rows and pressing enqueue fills the playback queue', { filled })
    }
    await runFn(() => document.querySelector('.pb-right .queue-button').click())
    await waitUntil(() => Boolean(document.querySelector('.queue-drawer')), 'queue drawer')
    const queueUi = await runFn(() => {
      const drawer = document.querySelector('.queue-drawer')
      return {
        title: drawer.querySelector('h2') ? drawer.querySelector('h2').textContent : '',
        rows: drawer.querySelectorAll('.queue-row').length,
        count: drawer.querySelector('.queue-count') ? drawer.querySelector('.queue-count').textContent : '',
        sorts: [...drawer.querySelectorAll('.queue-sort button')].map(node => node.textContent.trim()),
        clear: Boolean(drawer.querySelector('.queue-clear'))
      }
    })
    check(queueUi.title === '播放队列', 'the playbar opens a real playback queue drawer', queueUi)
    check(queueUi.rows >= 2 && queueUi.count === queueUi.rows + ' 首', 'the queue drawer lists exactly the engine queue', queueUi)
    check(['按文件夹', '按歌名', '按歌手', '按时长', '按添加顺序'].every(label => queueUi.sorts.includes(label)),
      'the queue exposes the five documented sort keys', queueUi)
    await runFn(() => [...document.querySelectorAll('.queue-sort button')].find(node => node.textContent.includes('按歌名')).click())
    await delay(600)
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    const queueTitles = await runFn(() => [...document.querySelectorAll('.queue-row .queue-copy strong')].map(node => node.textContent))
    const sortedTitles = [...queueTitles].sort((left, right) => collator.compare(left, right))
    check(queueTitles.length >= 2 && JSON.stringify(queueTitles) === JSON.stringify(sortedTitles),
      'sorting the queue by title updates the engine order', queueTitles)
    await runFn(() => document.querySelector('.queue-direction').click())
    await delay(600)
    const descTitles = await runFn(() => [...document.querySelectorAll('.queue-row .queue-copy strong')].map(node => node.textContent))
    check(JSON.stringify(descTitles) === JSON.stringify([...sortedTitles].reverse()),
      'the asc/desc toggle reverses the queue order', descTitles)
    const titlesBeforeMove = await runFn(() => [...document.querySelectorAll('.queue-row .queue-copy strong')].map(node => node.textContent))
    const moveClicked = await runFn(() => {
      const rows = [...document.querySelectorAll('.queue-row')]
      if (rows.length < 2) return { clicked: false, reason: 'not enough rows' }
      const first = rows[0]
      const button = first.querySelector('button[title="下移"]') ??
        [...first.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? '').startsWith('下移'))
      if (!button) return { clicked: false, reason: 'down button not found', buttons: [...first.querySelectorAll('button')].map(node => node.getAttribute('aria-label') ?? node.title) }
      if (button.disabled) return { clicked: false, reason: 'down button disabled' }
      button.click()
      return { clicked: true }
    })
    await delay(600)
    const titlesAfterMove = await runFn(() => [...document.querySelectorAll('.queue-row .queue-copy strong')].map(node => node.textContent))
    check(moveClicked.clicked && titlesAfterMove.length === titlesBeforeMove.length && titlesAfterMove[0] === titlesBeforeMove[1],
      'moving a queue row down reorders the engine queue', { moveClicked, titlesBeforeMove, titlesAfterMove })
    // waitUntil 的函数会被序列化到渲染进程执行，不能引用 Node 侧变量：基线存到渲染进程全局。
    // 被测行的定位要靠**按钮自身的 aria-label**（"移出队列 <标题>"）反查，
    // 而不是另找标题节点 —— 标题类名曾经在重构中变过（.queue-title → .queue-copy strong），
    // 用按钮上的标签反推标题对类名重构免疫。
    await runFn(() => { globalThis.__qaQueueRows = document.querySelectorAll('.queue-row').length })
    await runFn(() => {
      const row = document.querySelector('.queue-row')
      const button = row?.querySelector('button[title="移出队列"]') ??
        [...(row?.querySelectorAll('button') ?? [])].find(node => (node.getAttribute('aria-label') ?? '').startsWith('移出队列'))
      const label = button?.getAttribute('aria-label') ?? ''
      globalThis.__qaQueueRemovedTitle = label.startsWith('移出队列') ? label.slice('移出队列'.length).trim()
        : (row?.querySelector('.queue-copy strong')?.textContent?.trim() ?? '')
      globalThis.__qaQueueRemovedCount = [...document.querySelectorAll('.queue-row .queue-copy strong')]
        .filter(node => node.textContent.trim() === globalThis.__qaQueueRemovedTitle).length
      if (button) button.click()
    })
    await waitUntil(() => document.querySelectorAll('.queue-row').length === (globalThis.__qaQueueRows ?? -1) - 1, 'remove one queue row')
    // 只数行数不够：要证明掉的是「被点的那一行」，而不是别的哪一行。
    // 基线在被点之前存进渲染进程全局（waitUntil 的函数会被序列化过去，不能引用 Node 变量）。
    const removal = await runFn(() => ({
      rows: document.querySelectorAll('.queue-row').length,
      baseline: globalThis.__qaQueueRows,
      removedTitle: globalThis.__qaQueueRemovedTitle,
      // 同名曲目在真实曲库里很常见：不能问「还在不在」，要问「出现次数是否正好少一次」。
      stillListed: [...document.querySelectorAll('.queue-row .queue-copy strong')]
        .filter(node => node.textContent.trim() === globalThis.__qaQueueRemovedTitle).length
        !== (globalThis.__qaQueueRemovedCount ?? 1) - 1
    }))
    check(removal.rows === removal.baseline - 1 && removal.stillListed === false && Boolean(removal.removedTitle),
      'removing one row drops that row from the queue', removal)
    await runFn(() => document.querySelector('.queue-clear').click())
    await waitUntil(() => Boolean(document.querySelector('.queue-empty')), 'queue cleared')
    check(await runFn(() => document.querySelectorAll('.queue-empty').length === 1), 'clearing the queue leaves an honest empty state')
    await runFn(() => document.querySelector('.queue-close').click())

    // 空间音频（CR-029）：默认 off；改模式必须真下发到引擎并回读（旧引擎则跳过并记录）。
    await runFn(() => document.querySelector('[data-view-target="settings"]').click())
    await waitUntil(() => Boolean(document.querySelector('.settings-page')), 'settings for spatial')
    await runFn(() => document.querySelector('.settings-subcard.settings-spatial')?.scrollIntoView({ block: 'center' }))
    await delay(200)
    const spatialUi = await runFn(() => {
      const card = document.querySelector('.settings-subcard.settings-spatial')
      const buttons = [...(card ? card.querySelectorAll('.settings-spatial-mode button') : [])]
      return {
        exists: Boolean(card),
        labels: buttons.map(node => node.textContent.trim()),
        pressed: buttons.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent.trim()),
        status: card && card.querySelector('.settings-status') ? card.querySelector('.settings-status').textContent : ''
      }
    })
    check(spatialUi.exists && spatialUi.labels.length === 4, 'the spatial audio subcard exposes the four documented modes', spatialUi)
    const spatialState = (await request({ cmd: 'get_state' })).data
    const fadeUi = await runFn(() => {
      const input = document.querySelector('.settings-spatial input[aria-label="过渡时长（毫秒）"]')
      const card = document.querySelector('.settings-subcard.settings-spatial')
      return {
        value: input ? Number(input.value) : null,
        status: card ? [...card.querySelectorAll('.settings-status')].map(node => node.textContent).join(' | ') : '',
        unsupported: Boolean(card && card.querySelector('[data-unsupported]'))
      }
    })
    if (spatialState && spatialState.spatial) {
      check(spatialState.spatial.mode === 'off', 'spatial audio defaults to off (bit-perfect unchanged)', spatialState.spatial)
      check(spatialUi.pressed.length === 1 && spatialUi.pressed[0] === '关闭', 'the UI shows the engine-actual default spatial mode', spatialUi)
      check(!fadeUi.unsupported && /实际：关闭/.test(fadeUi.status), 'spatial status names the engine-actual mode', { fadeUi, spatialUi })
      check(fadeUi.value === 10, 'the fade transition slider defaults to 10ms', fadeUi)
      if (spatialState.fade) {
        check(spatialState.fade.ms === 10 && spatialState.fade.pauseHold !== false,
          'the engine reports fade defaults (10ms / pause-hold on)', spatialState.fade)
      }
      await runFn(() => [...document.querySelectorAll('.settings-spatial-mode button')].find(node => node.textContent.includes('立体声加宽')).click())
      let spatialMode = null
      for (let i = 0; i < 50; i += 1) {
        const state = await request({ cmd: 'get_state' })
        spatialMode = state && state.data && state.data.spatial ? state.data.spatial.mode : null
        if (spatialMode === 'wide') break
        await delay(100)
      }
      check(spatialMode === 'wide', 'choosing a spatial mode reaches the engine and is read back', { spatialMode })
      await runFn(() => [...document.querySelectorAll('.settings-spatial-mode button')].find(node => node.textContent.trim() === '关闭').click())
      let restored = null
      for (let i = 0; i < 50; i += 1) {
        const state = await request({ cmd: 'get_state' })
        restored = state && state.data && state.data.spatial ? state.data.spatial.mode : null
        if (restored === 'off') break
        await delay(100)
      }
      check(restored === 'off', 'switching spatial audio back to off restores the default')
    } else {
      // 引擎自 CR-029 起必然回 state.spatial；走到这里说明**能力回读链断了**，
      // 不是「可以跳过」。以前这里是 check(true) 恒真，等于把真回归藏起来。
      check(false, 'the engine reports spatial state (CR-029): a missing state.spatial is a regression, not a skip', { spatialUi })
    }
    // ---- v6 自动回到上次播放 ----
    // 写一条**真实**播放记忆，再让渲染层重新挂载：reload 走的是与重开应用同一条
    // bootstrap 路径（恢复逻辑全在渲染层），但不必重启主进程/引擎。
    const restoreTrack = list.data.tracks[2] ?? list.data.tracks[0]
    await request({ cmd: 'open', trackId: restoreTrack.trackId })
    await request({ cmd: 'seek', positionMs: 42000 })
    // 等引擎把 open/seek 的 state 事件送完：主进程的记忆跟随器会处理这些事件，
    // 若在事件还在路上时写记忆，可能被「位置 0」覆盖回下面这条 42 秒的记忆。
    await delay(900)
    // 写记忆放在事件静默之后；写完立刻 reload，避免再被别的 state 事件覆盖。
    await run(`window.twilight.savePlaybackMemory({ trackId: ${JSON.stringify(restoreTrack.trackId)}, filePath: ${JSON.stringify(restoreTrack.path)}, positionMs: 42000, durationMs: ${Number(restoreTrack.durationMs) || 180000} })`)
    await delay(200)
    win.webContents.reload()
    await waitUntil(() => Boolean(document.querySelector('[data-resume-restored]')), 'auto-resume banner')
    const restoredView = await run(`(() => {
      const banner = document.querySelector('[data-resume-restored]')
      return {
        banner: banner ? banner.textContent : null,
        progress: document.querySelector('.progress-time') ? document.querySelector('.progress-time').textContent : null,
        view: document.querySelector('.view-layer') ? document.querySelector('.view-layer').className : null
      }
    })()`)
    const restoredEngine = (await request({ cmd: 'get_state' })).data
    check(/已回到上次播放/.test(restoredView.banner || ''),
      'startup restores the last session automatically and says so', restoredView)
    // 引擎对「已装载、未开始」报 stopped（不是 paused）：判据是**绝不 playing**，
    // 而不是要求一个引擎并不使用的状态名。
    check(Boolean(restoredEngine) && restoredEngine.trackId === restoreTrack.trackId && restoredEngine.state !== 'playing',
      'the restored track is loaded but not playing (it never auto-plays audio)', { engine: restoredEngine?.state, expected: restoreTrack.trackId })
    check(restoredView.progress === '0:42', 'the restored position is the saved one, not 0:00', restoredView)

    // 回到音乐空间：后面的「中性表面 / reduced-motion」断言依赖 home 视图的 .info-title。
    await runFn(() => document.querySelector('[data-view-target="home"]').click())
    await waitUntil(() => Boolean(document.querySelector('.music-space')), 'home view after e2e detours')

    check(rendererErrors.length === 0, 'no renderer console errors: ' + rendererErrors.join('; '))
    check(await run('getComputedStyle(document.querySelector(".playbar")).backgroundColor === "rgb(0, 0, 0)" && getComputedStyle(document.querySelector(".info-title")).animationName === "none"'), 'neutral instrument surface and no decorative title animation')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    check(await run('getComputedStyle(document.querySelector(".c1-dot")).animationName === "none" && Number(getComputedStyle(document.querySelector(".c1-dot")).opacity) > 0'), 'reduced motion keeps the state visible without animation')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    check(await run('getComputedStyle(document.querySelector(".pb-controls")).backdropFilter === "none" && getComputedStyle(document.querySelector(".pb-controls")).backgroundColor === "rgb(23, 23, 26)"'), 'reduced transparency replaces glass with an opaque surface')
    win.webContents.debugger.detach()
  } catch (error) {
    failures++
    console.error(error)
  } finally {
    check(engineHash() === startingEngineHash, 'engine executable unchanged during this run')
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ checks, failures, enginePath, engineSha256: startingEngineHash }, null, 2))
    console.log('ELECTRON CHECKS', checks, 'FAILURES', failures)
    win.close()
    await delay(100)
    check(!win.isVisible() && !win.isDestroyed(), 'closing the window hides it while keeping the app alive')
    const trayPlayback = await request({ cmd: 'list_devices' })
    check(trayPlayback.ok, 'engine IPC remains available after the window is hidden')
    try { gdMock.kill() } catch { /* 已经退出 */ }
    process.exitCode = failures ? 1 : 0
    app.quit()
  }
}).catch(error => {
  console.error(error)
  try { gdMock.kill() } catch { /* 已经退出 */ }
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ checks, failures: failures + 1, error: String(error) }))
  app.quit()
})
