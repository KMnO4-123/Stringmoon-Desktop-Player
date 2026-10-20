import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { EngineHost } from './engine-host'
import { MeterVisibility } from './meter-visibility'
import { redactSensitiveText } from '@shared/redact'
import { applyLyricCandidate, attachLyrics, clearAttachedLyrics, configureLyrics, listLyricCandidates, resolveLyrics, resolveOnlineLyrics, saveLyricsBeside, setLyricsOffset } from './lyrics'
import { configureLyricsCache } from './lyrics-cache'
import { configureEqPresets, readEqPresets, removeEqPreset, saveEqPreset } from './eq-presets'
import { modelCount, searchEqModels } from './eq-models'
import { configureEqIr, readIrPrefs, writeIrPrefs } from './eq-ir'
import { fetchHeadphonePreset } from '@shared/eq-headphone'
import type { LyricsLoadResult } from '@shared/lyrics-model'
import type { EngineEvent, EngineRequestCommand, Track } from '@shared/protocol'
import { captureRequest } from '@shared/request-result'
import { configureArtwork, readArtwork, removeArtwork, setArtwork } from './artwork'
import { addLibraryDirectory, configureLibrary, readLibraryDirectories, removeLibraryDirectory } from './library-config'
import { mediaProxy } from './media-proxy'
import { streamingManager } from './streaming/manager'
import {
  DEFAULT_DSD_CAPABILITY,
  normalizeEngineCapabilities,
  STATIC_AUDIO_FORMATS,
  type AudioCapabilities
} from '@shared/discover'
import { openWebLogin } from './streaming/web-login'
import { configureLoginDiagnostics } from './streaming/login-diagnostics'
import { ensureBundledStreamingConfig, prepareBundledRuntime } from './streaming/bundled-runtime'
import { DownloadManager } from './downloads'
import type { PlatformId, StreamingConfig, StreamingTrack } from '@shared/streaming'
import { onlinePlayback } from './online-playback'
import { clearUnplayable, configureUnplayable, forgetUnplayable, markUnplayable, readUnplayable } from './unplayable'
import { addPlaylistEntries, configurePlaylists, createPlaylist, deletePlaylist, readPlaylistWarning, readPlaylists, removePlaylistEntry, renamePlaylist, reorderPlaylist } from './playlists'
import { configureTrackOverrides, readTrackOverrideWarning, readTrackOverrides, resetTrackOverride, setTrackOverride } from './track-overrides'
import type { TrackMetadataOverride } from '@shared/track-overrides'
import { buildTrayMenu, buildTrayTooltip, type TrayMenuItem, type TrayMenuStatus } from './tray-menu'
import { releasesOnlinePlayback } from './playback-hold'
import { clearPlaybackMemory, configurePlaybackMemory, flushPlaybackMemorySync, readPlaybackMemory, recordPlaybackMemoryEvent, savePlaybackMemory } from './playback-memory'
import { trackPrefetcher } from './prefetch'
import { UpdaterService, resolveAutoCheckDelay } from './updater'
import { resolveAppVersion as resolveAppVersionFrom } from './app-version'
import { runUpgradeBackup } from './upgrade-backup'
import type { AppInfo, UpdateState } from '@shared/update'

// 下载队列：解析直链/歌词/封面都复用流媒体层的既有实现，所以它拿的是依赖而不是副本。
const downloads = new DownloadManager({
  resolvePlay: (platform, track) => streamingManager.resolvePlay(platform as PlatformId, track),
  lyrics: (platform, track) => streamingManager.lyrics(platform as PlatformId, track),
  cover: (platform, track) => streamingManager.coverFor(platform as PlatformId, track.id)
})
let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let trayStatus: TrayMenuStatus = { state: 'stopped', trackId: '' }
// 除标题/艺人外也收 path：解码失败时要用 trackId 换回文件路径，而 path 本来就在
// 同一份 list_tracks 结果里 —— 多存一个字段就能省掉一次全量请求（见 claimTrackPath）。
const trayTracks = new Map<string, Pick<Track, 'title' | 'artist' | 'path'>>()
let trayTrackRefresh: Promise<void> | null = null
let trayTrackRefreshAgain = false
// 上一次真正构建出的托盘菜单内容键。托盘菜单只由「播放状态 + 曲目 + 曲名/艺人」
// 决定，音量/静音/循环模式的变化同样会发 state 事件，却与菜单无关。
let trayBuiltKey: string | null = null
// 数据目录：**钉死**，不依赖 app 名解析。
//
// 踩过一次，症状是「设置全没了、服务端也不自动起」：
// `app.getPath('userData')` 在 electron 被不同方式拉起时会解析成不同名字
// （打包/预览时是 twilight-echo-app，直接 spawn 一个脚本时是 'Electron'）。
// 之前这里按「当前 userData」推导目标目录，于是换个启动方式就换了一个空仓库，
// 而用户的曲库、歌单、登录态其实还在原来的文件夹里。
// 现在只有两条路径：测试注入的隔离目录，或固定的历史目录（保留既有数据）。
app.setName('Stringmoon')
const isolatedUserData = process.env.TWILIGHT_USER_DATA
const profilePath = isolatedUserData ? path.resolve(isolatedUserData) : path.join(app.getPath('appData'), 'twilight-echo-app')
app.setPath('userData', profilePath)
app.setAppUserModelId('Stringmoon')

// ---- 单实例（安装包形态）------------------------------------------------------
// 用户可能从桌面/开始菜单各点一次；第二个实例只负责把已有窗口叫到前台再退出。
// 不拦的话会重复拉起引擎、托盘与下载队列，听起来像两个应用在抢同一个输出设备。
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => { showMainWindow() })
}

/**
 * 应用版本：打包版用 app.getVersion()（= package.json version）；dev/测试启动时
 * app.getVersion() 会拿到 Electron 自身版本，回退应用根 package.json。
 * 纯判断在 app-version.ts（有单测），这里只提供真实依赖。
 */
function resolveAppVersion(): string {
  return resolveAppVersionFrom({
    getVersion: () => app.getVersion(),
    electronVersion: process.versions.electron,
    readPackageVersion: () => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { version?: unknown }
        return typeof pkg.version === 'string' ? pkg.version : null
      } catch { return null }
    }
  })
}

/** 设置页「关于与更新」需要的应用信息（版本/形态/数据目录/平台）。 */
function appInfo(): AppInfo {
  return { version: resolveAppVersion(), packaged: app.isPackaged, userDataPath: profilePath, platform: process.platform }
}

/** 更新状态广播：窗口可能还没建好/正在销毁，失败只当这一帧丢了（渲染层还能 invoke 一次）。 */
function broadcastUpdateState(state: UpdateState): void {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send('twilight:update-status', state) } catch { /* 窗口正在销毁 */ }
}

// 更新服务：只在打包版启用；未显式配置更新源时只显示 unconfigured，绝不发请求。
// beforeInstall 里同步收尾播放记忆 —— quitAndInstall 之后进程随时会被关掉。
const updater = new UpdaterService({
  app: appInfo(),
  envUrl: process.env.TWILIGHT_UPDATE_URL,
  onState: broadcastUpdateState,
  beforeInstall: () => { flushPlaybackMemorySync(); trackPrefetcher.cancel() },
  // 测试/演练可用 TWILIGHT_UPDATE_AUTOCHECK_MS 缩短 12s 自动检查；非法/缺省回退 12000（见 updater.ts）。
  autoCheckDelayMs: resolveAutoCheckDelay(process.env.TWILIGHT_UPDATE_AUTOCHECK_MS)
})

const engine = new EngineHost()
const meterVisibility = new MeterVisibility(command => engine.request(command), error => {
  console.error('[meter] visibility synchronization failed:', error)
})

function mainWindowVisible(): boolean {
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
}

function updateTray(): void {
  if (!tray) return
  const track = trayTracks.get(trayStatus.trackId)
  const status = { ...trayStatus, ...track }
  // 实测一次 Menu.buildFromTemplate 约 0.2ms。拖音量杆时每秒会来几十条 state
  // 事件（引擎 setVolume 每次都会 emitState），而菜单内容一个像素都不会变 ——
  // 没有这道比对，就是每秒白建几十个原生菜单。
  const key = status.state + '|' + status.trackId + '|' + (status.title ?? '') + '|' + (status.artist ?? '')
  if (key === trayBuiltKey) return
  trayBuiltKey = key
  tray.setToolTip(buildTrayTooltip(status))
  const template = buildTrayMenu(status).map((item) => {
    if (item.id === 'separator') return { type: 'separator' as const }
    if (item.id === 'track') return { label: item.label, enabled: false }
    return { label: item.label, enabled: item.enabled, click: () => runTrayAction(item.id) }
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function showMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function runTrayAction(action: Exclude<TrayMenuItem, { id: 'separator' | 'track' }>['id']): void {
  if (action === 'show') {
    showMainWindow()
    return
  }
  if (action === 'quit') {
    app.quit()
    return
  }
  if (!trayStatus.trackId) return
  const command: EngineRequestCommand = action === 'toggle'
    ? { cmd: trayStatus.state === 'playing' ? 'pause' : 'play' }
    : { cmd: action === 'previous' ? 'prev' : 'next' }
  void engine.request(command).catch((error: unknown) => {
    console.error('[tray] playback command failed:', error)
  })
}

/**
 * 拉一次全量曲目，只为给托盘菜单补「曲名 · 艺人」。
 *
 * 只在真正需要时调用（当前曲目不在缓存里，也就是第一次播放/换库之后），
 * 不再在 ready / scan_done 时各拉一次：启动时那两次的结果会被渲染层自己的
 * list_tracks 立刻覆盖，而每次都是整库 JSON 的往返（真引擎实测约 15ms）。
 */
function refreshTrayTracks(): Promise<void> {
  if (trayTrackRefresh) {
    trayTrackRefreshAgain = true
    return trayTrackRefresh
  }
  trayTrackRefresh = (async () => {
    do {
      trayTrackRefreshAgain = false
      try {
        const result = await engine.request<{ tracks?: Track[] }>({ cmd: 'list_tracks' })
        trayTracks.clear()
        for (const track of result.tracks ?? []) {
          trayTracks.set(track.trackId, { title: track.title, artist: track.artist, path: track.path })
        }
        updateTray()
      } catch (error) {
        console.error('[tray] track metadata refresh failed:', error)
        return
      }
    } while (trayTrackRefreshAgain)
  })().finally(() => { trayTrackRefresh = null })
  return trayTrackRefresh
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources/stringmoon.ico'))
  tray = new Tray(icon)
  tray.setToolTip('Stringmoon')
  tray.on('click', showMainWindow)
  updateTray()
}

function sendEvent(ev: EngineEvent): void {
  if (ev.ev === 'ready') meterVisibility.connected()
  // 播放记忆必须在可见性门控**之前**记录：窗口隐藏/最小化时 position 不再转发给
  // 渲染层，但用户最小化听歌同样需要「继续上次」，主进程是唯一还能看到事件的消费者。
  if (ev.ev === 'state' || ev.ev === 'position' || ev.ev === 'ended') {
    recordPlaybackMemoryEvent(ev, trackId => trayTracks.get(trackId)?.path)
  }
  // 不可见窗口没有消费者：meter 与 position 都是高频事件，窗口隐藏/最小化时
  // 跨一次 IPC 就是白花（实测 position 约 16–20 Hz）。恢复可见后不需要补帧 ——
  // 引擎仍按同一节奏发 position，下一条就会到；权威状态还有 state / get_state，
  // 渲染层的 positionStore 收到任意一条 position 即刷新，进度条不会卡住。
  if ((ev.ev === 'meter' || ev.ev === 'position') && !mainWindowVisible()) return
  if (ev.ev === 'state') {
    trayStatus = { state: ev.state, trackId: ev.trackId }
    updateTray()
    if (ev.trackId && !trayTracks.has(ev.trackId)) void refreshTrayTracks()
    // 在线播放占用只覆盖「真的在放」的时段：暂停/停止/被本地曲目接管后，
    // 平台服务端就该重新进入空闲巡检，而不是被一个已经不在出声的会话钉住。
    // 判据在 playback-hold.ts（本地曲目的 playing state 带 tl_ 前缀，同样要释放）。
    if (releasesOnlinePlayback(ev)) streamingManager.setPlaybackHold(null)
  } else if (ev.ev === 'ended') {
    // 一首歌结束（eof/stop/error）就不再占用平台服务端。
    streamingManager.setPlaybackHold(null)
    if (ev.reason === 'error') {
      // The engine just told us it could not load a track it stepped over. This
      // is where "无法播放" becomes a durable fact the user can see and undo --
      // marking it inside the event path (not in the renderer) keeps the record
      // correct even when no window is open.
      // The engine names the track, and the id only resolves through the catalog.
      void claimTrackPath(ev.trackId).then((file) => {
        if (!file) return
        return markUnplayable(file, '播放时引擎无法解码这个文件', 'playback').then((isNew) => {
          if (isNew && win && !win.isDestroyed()) win.webContents.send('twilight:unplayable-changed')
        })
      }).catch((error) => { console.error('[unplayable] could not record a failed track:', error) })
    }
  }
  if (win && !win.isDestroyed()) win.webContents.send('twilight:event', ev)
}

/**
 * 用一个 trackId 换回磁盘路径。
 *
 * 需要它的原因：引擎在 `ended reason=error` 里给的是 **trackId**（那是它的身份），
 * 而"不能播放"这件事属于**文件**。路径才是能跨重启、跨会话、跨引擎进程生存的键，
 * 记录也必须以它为准，否则引擎一重启 id 就失去意义。
 * 找不到就返回 null：id 可能属于已被 `replace` 清掉的一代曲库。
 */
async function claimTrackPath(trackId: string): Promise<string | null> {
  if (!trackId) return null
  // 托盘刷新已经把整张曲库（含 path）收进 trayTracks：先查它，常见路径上就
  // 不必为了一个 id 再向引擎要一次全量 list_tracks（真引擎实测约 15ms）。
  const cached = trayTracks.get(trackId)?.path
  if (cached) return cached
  try {
    const result = await engine.request<{ tracks?: Track[] }>({ cmd: 'list_tracks' }, 8000)
    return result.tracks?.find((track) => track.trackId === trackId)?.path ?? null
  } catch (error) {
    console.error('[unplayable] list_tracks failed while resolving', trackId, error)
    return null
  }
}

function createWindow(): void {
  const created = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    title: 'Stringmoon',
    icon: path.join(app.getAppPath(), 'resources/stringmoon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  win = created
  const syncMeterVisibility = (): void => meterVisibility.setVisible(mainWindowVisible())
  created.on('show', syncMeterVisibility)
  created.on('hide', syncMeterVisibility)
  created.on('minimize', syncMeterVisibility)
  created.on('restore', syncMeterVisibility)
  syncMeterVisibility()
  const notifyHidden = (): void => {
    if (!created.webContents.isDestroyed()) created.webContents.send('twilight:window-hidden')
  }
  created.on('hide', notifyHidden)
  created.on('minimize', notifyHidden)
  created.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    created.hide()
  })
  created.on('closed', () => {
    if (win === created) {
      win = null
      syncMeterVisibility()
    }
  })
  created.on('ready-to-show', () => created.show())
  created.webContents.on('did-finish-load', () => {
    if (process.env.TWILIGHT_SMOKE) scheduleSmokeCapture()
  })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void created.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void created.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** 冒烟模式（TWILIGHT_SMOKE=1）：渲染层稳定后截图到 .smoke/window.png 并退出。 */
function scheduleSmokeCapture(): void {
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    win.webContents
      .capturePage()
      .then((img) => {
        const dir = path.join(app.getAppPath(), '.smoke')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'window.png')
        fs.writeFileSync(file, img.toPNG())
        console.log('[smoke] captured', file)
        app.exit(0)
      })
      .catch((err) => {
        console.error('[smoke] capture failed', err)
        app.exit(1)
      })
  }, 8000)
}

function registerIpc(): void {
  // A5：meter 消费者需求（渲染层当前视图有没有频谱/监测）。与「窗口可见」在
  // MeterVisibility 里取与：两者都真才让引擎序列化/分析 meter。单向 send，
  // 所以用 ipcMain.on 而不是 handle —— 它不该产生一次 invoke 往返。
  ipcMain.on('twilight:meter-demand', (_event, active) => { meterVisibility.setDemand(active === true) })
  // ---- 全局搜索与下载（gdstudio 那一栏的落地）---------------------------
  ipcMain.handle('twilight:search-all', (_e, keyword: unknown, limit: unknown) =>
    streamingManager.searchAll(typeof keyword === 'string' ? keyword : '', Number.isFinite(limit) ? Number(limit) : 20))
  ipcMain.handle('twilight:downloads', () => downloads.list())
  ipcMain.handle('twilight:download-add', (_e, track: StreamingTrack) => downloads.enqueue(track))
  ipcMain.handle('twilight:download-cancel', (_e, id: unknown) => { downloads.cancel(String(id ?? '')); return downloads.list() })
  ipcMain.handle('twilight:download-clear', () => { downloads.clearFinished(); return downloads.list() })
  ipcMain.handle('twilight:download-directory', () => downloads.getDirectory())
  ipcMain.handle('twilight:download-directory-set', (_e, directory: unknown) => downloads.setDirectory(String(directory ?? '')))
  ipcMain.handle('twilight:pick-download-dir', async (): Promise<string | null> => {
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, { title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    await downloads.setDirectory(result.filePaths[0])
    return result.filePaths[0]
  })
  // ---- 平台接入（CONTRACT §4）------------------------------------------
  ipcMain.handle('twilight:streaming-status', () => ({
    config: streamingManager.getConfig(),
    runtimes: streamingManager.runtimes(),
    sessions: streamingManager.sessionList()
  }))
  ipcMain.handle('twilight:streaming-config-save', (_e, next: StreamingConfig) => streamingManager.saveConfig(next))
  ipcMain.handle('twilight:streaming-start', (_e, platform: PlatformId) => streamingManager.start(platform))
  ipcMain.handle('twilight:streaming-stop', (_e, platform: PlatformId) => streamingManager.stop(platform))
  ipcMain.handle('twilight:streaming-account', (_e, platform: PlatformId) => streamingManager.account(platform))
  ipcMain.handle('twilight:streaming-playlists', (_e, platform: PlatformId) => streamingManager.playlists(platform))
  ipcMain.handle('twilight:streaming-liked-songs', (_e, platform: PlatformId) => streamingManager.likedSongs(platform))
  ipcMain.handle('twilight:streaming-search-playlists', (_e, platform: PlatformId, keyword: unknown) =>
    streamingManager.searchPlaylists(platform, typeof keyword === 'string' ? keyword : ''))
  ipcMain.handle('twilight:streaming-playlist-tracks', (_e, platform: PlatformId, id: unknown) =>
    streamingManager.playlistTracks(platform, typeof id === 'string' ? id : ''))
  // ---- GD 音乐台 / Embeat（v3 §1.3：内置 HTTP 源，无登录、无进程）----------
  // 相似歌曲：优先 Embeat item-to-item；不可用/为空时降级为 GD 相关搜索，
  // 结果的 degraded/reason 如实标注（不假装是模型推荐）。
  ipcMain.handle('twilight:streaming-similar', (_e, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    return streamingManager.similar({
      id: text(input.id), title: text(input.title), artist: text(input.artist), album: text(input.album)
    })
  })
  // 各上游源（netease/joox）的可用性：运行时探测 + 10 分钟缓存，界面据此如实显示。
  ipcMain.handle('twilight:streaming-gd-sources', () => streamingManager.gdSourceStatus())
  ipcMain.handle('twilight:streaming-search', (_e, platform: PlatformId, keyword: unknown, limit: unknown, offset: unknown) =>
    streamingManager.search(platform, typeof keyword === 'string' ? keyword : '',
      Number.isFinite(Number(limit)) ? Number(limit) : 30,
      Number.isFinite(Number(offset)) ? Number(offset) : 0))
  ipcMain.handle('twilight:streaming-lyrics', (_e, platform: PlatformId, track: StreamingTrack) =>
    streamingManager.lyrics(platform, { id: String(track?.id ?? '') }))
  ipcMain.handle('twilight:streaming-logout', (_e, platform: PlatformId) => streamingManager.logout(platform))
  /**
   * 手动「立即校验」会话（设置页按钮）。
   *
   * 与自动巡检走同一个入口：手动点一下不该走另一套逻辑，否则两条路会给出
   * 不同的会话状态（历史上登录态就这样分裂过一次）。
   */
  ipcMain.handle('twilight:streaming-verify', (_e, platform?: PlatformId) =>
    streamingManager.verifySessions(platform ? { platform } : {}))
  ipcMain.handle('twilight:streaming-secret', (_e, platform: PlatformId, value: unknown) =>
    streamingManager.setSecret(platform, typeof value === 'string' ? value : ''))
  // 扫码通道由渲染层显式传入（QQ 有手机QQ/微信/QQ音乐App 三种）；非法值在 manager 里收敛。
  ipcMain.handle('twilight:streaming-qr-start', (_e, platform: PlatformId, channel?: unknown) =>
    streamingManager.qrStart(platform, typeof channel === 'string' ? channel as 'qq' | 'wechat' | 'qqmusic' : undefined))
  ipcMain.handle('twilight:streaming-qr-poll', (_e, platform: PlatformId) => streamingManager.qrPoll(platform))
  ipcMain.handle('twilight:streaming-web-login', async (_e, platform: PlatformId) => {
    const window = win && !win.isDestroyed() ? win : null
    const cookie = await openWebLogin(platform, window)
    return streamingManager.acceptWebLogin(platform, cookie)
  })
  /**
   * 播一首平台歌曲：解析直链 → 交给回环代理（带 Referer/UA）→ 引擎用 open{url} 装载。
   * 令牌生命周期由 onlinePlayback 管：换一首必然换一个 token，上一首的入口同时失效。
   */
  ipcMain.handle('twilight:streaming-play', async (_e, platform: PlatformId, track: StreamingTrack) => {
    const target = await streamingManager.resolvePlay(platform, { id: String(track?.id ?? ''), title: track?.title, artist: track?.artist })
    // open 的回复里带着**引擎实测**的时长与格式（试听切片会如实报成 0:35）。
    // 渲染层要把它们写进「正在播放」：平台给的 durationMs 是整首的，不是这一次流到的长度。
    // 用属性容器而不是裸变量：赋值发生在回调里，裸变量会被 TS 的控制流分析窄化成 null。
    const captured: { opened?: { durationMs?: number; sampleRate?: number; sourceSampleRate?: number; bitDepth?: number } } = {}
    const session = await onlinePlayback.open(
      { url: target.url, referer: target.referer, userAgent: target.userAgent, allowInsecure: target.allowInsecure },
      async (loopbackUrl) => { captured.opened = await engine.request({ cmd: 'open', url: loopbackUrl }, 20000) }
    )
    await engine.request({ cmd: 'play' })
    // A1：从现在到 ended/暂停/停止之间，这个平台不能被空闲巡检停掉
    //（用户下一首/重开还可能要用它取直链）。
    streamingManager.setPlaybackHold(platform)
    const opened = captured.opened
    return {
      token: session.token,
      title: target.title,
      artist: target.artist,
      quality: target.quality ?? null,
      durationMs: Number(opened?.durationMs ?? 0),
      sampleRate: Number(opened?.sampleRate ?? 0),
      sourceSampleRate: Number(opened?.sourceSampleRate ?? 0),
      bitDepth: Number(opened?.bitDepth ?? 0)
    }
  })
  // ---- 发现页（v4 §1.1，PLAN §1.1）----------------------------------------
  // 这四个通道都**永不因单区块失败而整页抛错**：错误写在返回结构里（区块 error /
  // result.error），渲染层据此逐区块显示「重试」。入参一律 unknown 逐字段消毒。
  /**
   * v6.3：发现页支持网易云与 QQ 音乐。
   * 平台参数在这里收敛成两个合法值（不把任意字符串透传给平台层），
   * 非法值回 'netease' 还是抛错？—— 回退会让用户以为切了平台却没变内容，
   * 所以直接抛中文错误（IPC 会把它变成 rejected promise，界面显示错误）。
   */
  const discoverPlatform = (value: unknown): 'netease' | 'qq' => {
    if (value === 'qq') return 'qq'
    if (value === undefined || value === null || value === '' || value === 'netease') return 'netease'
    throw new Error('发现页只支持网易云音乐和 QQ 音乐。')
  }
  ipcMain.handle('twilight:discover-home', (_e, platform: unknown) => streamingManager.discoverHome(discoverPlatform(platform)))
  ipcMain.handle('twilight:discover-toplist', (_e, platform: unknown, id: unknown) =>
    streamingManager.discoverToplist(discoverPlatform(platform), id))
  ipcMain.handle('twilight:discover-playlists', (_e, platform: unknown, query: unknown) => {
    const input = (query ?? {}) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    return streamingManager.discoverPlaylists(discoverPlatform(platform), {
      cat: text(input.cat),
      // 只有显式 'new' 才是最新；其它值都按热度（上游默认），不把任意字符串透传。
      order: input.order === 'new' ? 'new' : 'hot',
      page: Number.isFinite(Number(input.page)) ? Number(input.page) : 1
    })
  })
  ipcMain.handle('twilight:discover-playlist-tracks', (_e, platform: unknown, id: unknown) =>
    streamingManager.discoverPlaylistTracks(discoverPlatform(platform), id))
  /**
   * 解码能力矩阵：先问引擎（CR-032），旧引擎/mock 引擎回 ERR_UNSUPPORTED 或超时时
   * 退回**静态已知矩阵**并用 engine:null 如实标注「引擎没上报」。
   *
   * 为什么不让界面自己回落：静态矩阵的依据在引擎源码里（catalog.cpp 的白名单、
   * audio_source.cpp 的容器判定），只有主进程这一侧能对着实现写清楚。
   */
  ipcMain.handle('twilight:audio-capabilities', async (): Promise<AudioCapabilities> => {
    try {
      // CR-032 的 get_capabilities 还没进 shared/protocol.ts 的扩展命令联合（那条类型
      // 由引擎侧的本轮 CR 一并提交）；这里用一次显式断言保持协议文件的唯一真相，
      // 不在这边偷偷扩一份命令表。命令名与形状见 docs/contract-requests.md 的 CR-032。
      const capabilitiesCommand = { cmd: 'get_capabilities' } as unknown as EngineRequestCommand
      const reply = await engine.request<unknown>(capabilitiesCommand, 2500)
      const normalized = normalizeEngineCapabilities(reply)
      if (normalized) return { ...normalized, engine: reply }
    } catch {
      // 旧引擎不认识这条命令、引擎没起、超时：都走静态矩阵，engine 置 null。
    }
    return {
      formats: STATIC_AUDIO_FORMATS.map(format => ({ ...format })),
      dsd: { ...DEFAULT_DSD_CAPABILITY },
      engine: null
    }
  })
  ipcMain.handle('twilight:request', (_e, cmd: EngineRequestCommand, timeoutMs?: number) => {
    // 「用户点哪首就先服务哪首」：open 会立刻读这个文件，而下一首预热可能正在读同一个
    // 文件 —— 磁盘队列会把 open 拖慢（E10b 复测里 tl_0002 稳定 1.2s 的推断成因）。
    // 预热是可丢弃的提示，open 是用户动作，所以这里直接取消、不等待。
    if (cmd && cmd.cmd === 'open') trackPrefetcher.cancel()
    // 防御层：本地曲目 open（trackId 非空）就是接管播放，在线占用必须释放 ——
    // 不依赖 state 事件按序到达。open 的 URL 分支（在线播放）不带 trackId，保留占用。
    if (cmd && cmd.cmd === 'open' && 'trackId' in cmd && typeof cmd.trackId === 'string' && cmd.trackId !== '') {
      streamingManager.setPlaybackHold(null)
    }
    return captureRequest(() => engine.request(cmd, timeoutMs))
  })
  ipcMain.handle('twilight:lyrics', (_e, track: { trackId?: string; path?: string }): Promise<LyricsLoadResult> => resolveLyrics(track))
  // 在线取词：渲染层决定要不要联网（自动/手动），主进程只负责取、计分与缓存。
  // 入参来自渲染进程，所以逐字段挑出来，不把任意对象丢进搜索。
  ipcMain.handle('twilight:lyrics-online', (_e, raw: unknown, force: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    const track = {
      trackId: text(input.trackId),
      title: text(input.title),
      artist: text(input.artist),
      album: text(input.album),
      durationMs: Number.isFinite(input.durationMs) ? Number(input.durationMs) : 0,
      path: text(input.path)
    }
    return resolveOnlineLyrics(track as unknown as Track, force === true)
  })
  ipcMain.handle('twilight:lyrics-attach', async (_e, audio: string) => {
    if (!win || win.isDestroyed() || typeof audio !== 'string') throw new Error('当前没有可关联歌词的歌曲。')
    const result = await dialog.showOpenDialog(win, { title: '关联本地 LRC 歌词', properties: ['openFile'], filters: [{ name: 'LRC 歌词', extensions: ['lrc'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return attachLyrics(audio, result.filePaths[0])
  })
  ipcMain.handle('twilight:lyrics-clear', (_e, audio: string) => clearAttachedLyrics(audio))
  ipcMain.handle('twilight:lyrics-offset', (_e, audio: string, offsetMs: number) => setLyricsOffset(audio, offsetMs))
  // 人工纠正匹配：列出候选 / 应用某一条。入参同样逐字段挑，不把任意对象丢进搜索。
  const lyricTrackOf = (raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    return {
      trackId: text(input.trackId),
      title: text(input.title),
      artist: text(input.artist),
      album: text(input.album),
      durationMs: Number.isFinite(input.durationMs) ? Number(input.durationMs) : 0,
      path: text(input.path)
    } as unknown as Track
  }
  ipcMain.handle('twilight:lyrics-candidates', (_e, raw: unknown) => listLyricCandidates(lyricTrackOf(raw)))
  ipcMain.handle('twilight:lyrics-apply-candidate', (_e, raw: unknown, candidate: unknown) => {
    const picked = (candidate ?? {}) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    return applyLyricCandidate(lyricTrackOf(raw), {
      id: text(picked.id),
      title: text(picked.title),
      artist: text(picked.artist),
      ...(typeof picked.album === 'string' ? { album: picked.album } : {}),
      ...(Number.isFinite(picked.durationMs) ? { durationMs: Number(picked.durationMs) } : {}),
      score: Number.isFinite(picked.score) ? Number(picked.score) : 0,
      risk: picked.risk === 'high' || picked.risk === 'medium' ? picked.risk : 'low',
      reasons: Array.isArray(picked.reasons) ? picked.reasons.filter((item): item is string => typeof item === 'string') : []
    })
  })
  // 把在线歌词存成同名 .ttml。只接受绝对音频路径，其余字段用于元数据补全。
  ipcMain.handle('twilight:lyrics-save', (_e, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    return saveLyricsBeside({ path: text(input.path), title: text(input.title), artist: text(input.artist) })
  })
  // 型号索引与在线取预设都在主进程：索引 140 KB 不该进渲染层包，
  // 而且跨域抓取在渲染层会被 CORS 挡掉，主进程没有这个限制。
  ipcMain.handle('twilight:eq-models-search', (_e, query: unknown, limit: unknown) =>
    searchEqModels(typeof query === 'string' ? query : '', Number.isFinite(limit) ? Number(limit) : 20))
  ipcMain.handle('twilight:eq-models-count', () => modelCount())
  ipcMain.handle('twilight:eq-headphone-fetch', async (_e, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>
    const name = typeof input.name === 'string' ? input.name : ''
    const rig = typeof input.rig === 'string' ? input.rig : undefined
    const preset = await fetchHeadphonePreset(name, rig ? { rig } : {})
    return { name: preset.name, rig: preset.rig, preampDb: preset.preampDb, filters: preset.filters }
  })
  // 房间校正偏好：路径 + 开关 + 电平。引擎重启后由界面按它重新下发 set_ir。
  ipcMain.handle('twilight:eq-ir-prefs', () => readIrPrefs())
  ipcMain.handle('twilight:eq-ir-prefs-set', (_e, raw: unknown) => writeIrPrefs(raw))
  ipcMain.handle('twilight:eq-presets', () => readEqPresets())
  ipcMain.handle('twilight:eq-preset-save', (_e, preset: unknown) => saveEqPreset(preset))
  ipcMain.handle('twilight:eq-preset-remove', (_e, idOrName: string) => removeEqPreset(idOrName))
  ipcMain.handle('twilight:playlists', () => readPlaylists())
  ipcMain.handle('twilight:library-data-warnings', async () => (await Promise.all([readPlaylistWarning(), readTrackOverrideWarning()])).filter((warning): warning is string => Boolean(warning)))
  ipcMain.handle('twilight:playlist-create', (_e, name: string) => createPlaylist(name))
  ipcMain.handle('twilight:playlist-rename', (_e, id: string, name: string) => renamePlaylist(id, name))
  ipcMain.handle('twilight:playlist-delete', (_e, id: string) => deletePlaylist(id))
  ipcMain.handle('twilight:playlist-add', (_e, id: string, paths: string[]) => addPlaylistEntries(id, paths))
  ipcMain.handle('twilight:playlist-remove', (_e, id: string, file: string) => removePlaylistEntry(id, file))
  ipcMain.handle('twilight:playlist-reorder', (_e, id: string, paths: string[]) => reorderPlaylist(id, paths))
  ipcMain.handle('twilight:track-overrides', () => readTrackOverrides())
  // 无法播放的曲目：查看 / 单条恢复 / 全部恢复。都不删除任何音乐文件。
  ipcMain.handle('twilight:unplayable', () => readUnplayable())
  ipcMain.handle('twilight:unplayable-forget', (_e, file: string) => forgetUnplayable(file))
  ipcMain.handle('twilight:unplayable-clear', () => clearUnplayable())
  ipcMain.handle('twilight:track-override-set', (_e, file: string, patch: TrackMetadataOverride) => setTrackOverride(file, patch))
  ipcMain.handle('twilight:track-override-reset', (_e, file: string, field?: keyof TrackMetadataOverride) => resetTrackOverride(file, field))
  ipcMain.handle('twilight:artwork', (_e, file: string) => readArtwork(file))
  ipcMain.handle('twilight:choose-artwork', async (_e, audio: string) => {
    if (!win || win.isDestroyed() || typeof audio !== 'string') return null
    const result = await dialog.showOpenDialog(win, { title: '设置歌曲封面', properties: ['openFile'], filters: [{ name: '封面图片', extensions: ['jpg', 'jpeg', 'png'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const artwork = await setArtwork(audio, result.filePaths[0])
    if (!artwork) throw new Error('无法读取封面，请选择 8 MB 以内、边长不超过 8192 的有效 JPG 或 PNG 图片。')
    return artwork
  })
  // CR-005 方案 1（AI-A 提议、owner 待裁定）：目录选择在应用侧做，拿到路径后走契约的 scan
  // 曲库目录集合：读回生效列表（含此刻不可用的），并支持增删
  ipcMain.handle('twilight:library-dirs', () => readLibraryDirectories())
  ipcMain.handle('twilight:library-add', (_e, directory: string) => addLibraryDirectory(directory))
  ipcMain.handle('twilight:library-remove', (_e, directory: string) => removeLibraryDirectory(directory))
  // 清除自定义封面：只删映射，不动用户的图片文件，也不动音乐文件
  ipcMain.handle('twilight:remove-artwork', (_e, audio: string) => removeArtwork(audio))
  // CR-020: let the user pick an impulse response, then hand the PATH to the
  // engine. The file itself never crosses the IPC boundary: the engine reads it
  // with its own decoder, and shipping megabytes through structured clone to
  // hand it straight back would be pure waste.
  ipcMain.handle('twilight:pick-impulse', async (): Promise<string | null> => {
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择房间 / 耳机校正冲激响应',
      properties: ['openFile'],
      filters: [{ name: '冲激响应 (WAV)', extensions: ['wav'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('twilight:pick-folder', async (): Promise<string | null> => {
    if (!win || win.isDestroyed()) return null
    const res = await dialog.showOpenDialog(win, {
      title: '选择音乐目录',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0] ?? null
  })
  // ---- 播放记忆 / 下一首预热（ECHO NEXT 对标功能）-------------------------
  // 记忆的读取/写入都是小 JSON；主进程同时自己跟随引擎事件更新（见 sendEvent），
  // 渲染层只需要补 filePath/queue/repeatMode 这些引擎不知道的字段。
  ipcMain.handle('twilight:playback-memory-get', () => readPlaybackMemory())
  ipcMain.handle('twilight:playback-memory-set', (_e, patch: unknown) => savePlaybackMemory(patch))
  ipcMain.handle('twilight:playback-memory-clear', () => clearPlaybackMemory())
  // 预热只读文件前几 MB 进 OS 缓存，不解析、不出声；路径在 prefetcher 里逐项校验。
  ipcMain.handle('twilight:prefetch-track', (_e, file: unknown) => trackPrefetcher.prefetch(file))
  ipcMain.handle('twilight:prefetch-cancel', () => { trackPrefetcher.cancel() })
  // ---- 应用信息与自动更新（PACKAGING-v1）--------------------------------
  // 设置页只拿状态与四个动作；更新源配置、下载、安装全在主进程。
  ipcMain.handle('twilight:app-info', () => appInfo())
  ipcMain.handle('twilight:update-state', () => updater.getState())
  ipcMain.handle('twilight:update-check', () => updater.check())
  ipcMain.handle('twilight:update-download', () => updater.download())
  ipcMain.handle('twilight:update-install', () => updater.install())
  ipcMain.handle('twilight:bootstrap', () => ({ smoke: Boolean(process.env.TWILIGHT_SMOKE) }))
}

app.whenReady().then(() => {
  // 第二个实例已经 quit；不要再初始化任何单实例资源。
  if (!singleInstance) return
  // 最早阶段：版本变化时把用户文档备份到 upgrade-backups/<旧版本>/。
  // 只读/复制小 JSON，失败只打日志，绝不阻断启动（见 upgrade-backup.ts）。
  const upgrade = runUpgradeBackup({ userDataPath: profilePath, currentVersion: app.getVersion() })
  if (upgrade.problem) {
    console.error('[upgrade-backup]', redactSensitiveText(upgrade.problem))
  } else if (upgrade.backedUp) {
    console.log('[upgrade-backup] copied', upgrade.copied.length, 'documents from', upgrade.fromVersion)
  }
  configureArtwork(path.join(app.getPath('userData'), 'artwork.json'))
  configureLibrary(path.join(app.getPath('userData'), 'library.json'))
  configurePlaylists(path.join(app.getPath('userData'), 'playlists.json'))
  configureTrackOverrides(path.join(app.getPath('userData'), 'track-overrides.json'))
  configureUnplayable(path.join(app.getPath('userData'), 'unplayable.json'))
  configureLyrics(path.join(app.getPath('userData'), 'lyrics.json'))
  // 在线歌词缓存与用户的歌词偏好分开放：一个是网络结果，一个是用户意图，混在一起回滚时会互相牵连。
  configureLyricsCache(path.join(app.getPath('userData'), 'lyrics-online.json'))
  // 用户导入的均衡器预设与歌单/覆盖同一类：用户内容，放主进程 JSON。
  configureEqPresets(path.join(app.getPath('userData'), 'eq-presets.json'))
  configureEqIr(path.join(app.getPath('userData'), 'eq-ir.json'))
  // 播放记忆（ECHO NEXT 的 echo-playback-memory.json 对标物）：只读/写「上次听到哪里」，
  // 恢复成「已加载暂停」由渲染层做，主进程绝不自动出声。
  configurePlaybackMemory(path.join(app.getPath('userData'), 'playback-memory.json'))
  // 平台接入：配置与加密凭据都放 userData；服务端由 StreamingManager 拉起。
  // 登录诊断日志与 streaming.json 同目录：用户复现一次后，这里能看到
  // 「二维码轮询拿到什么 code / cookie 抓到哪些名字 / 服务端 /login/status 回了什么」。
  configureLoginDiagnostics(app.getPath('userData'))
  // v0.4.0：安装包自带 node.exe + 两个平台服务端（打包成 resources/runtime.zip，
  // 因为 electron-builder 会丢掉 node_modules）。首次启动解压到 userData/runtime 并把
  // streaming.json 写成指向它的命令，对方不需要装 Node.js / 跑 npx。已有配置绝不覆盖。
  const streamingConfigFile = path.join(app.getPath('userData'), 'streaming.json')
  if (!fs.existsSync(streamingConfigFile)) {
    const runtimeDir = prepareBundledRuntime({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataDir: app.getPath('userData'),
      version: app.getVersion()
    })
    ensureBundledStreamingConfig(streamingConfigFile, runtimeDir)
  }
  streamingManager.configure(
    path.join(app.getPath('userData'), 'streaming.json'),
    path.join(app.getPath('userData'), 'streaming-sessions.json')
  )
  // A1（CR-023）：默认**按需启动** —— 启动时不拉起任何平台服务端，等第一次
  // 平台操作（搜索/歌单/取直链/登录）由 ensureStarted 拉起，空闲 10 分钟再停。
  // 离线/本地播放时进程表里应当零 node；配置里 lazyStart=false 才回退旧的
  // 「启动即拉起 enabled 平台」行为。失败不阻断启动：原因写在 runtimes 里由界面显示。
  void streamingManager.startOnLaunch().catch(() => undefined)
  void downloads.configure(
    path.join(app.getPath('userData'), 'downloads.json'),
    path.join(app.getPath('userData'), 'Downloads')
  ).then(() => {
    // 进度推给渲染层；窗口还没建好时直接丢弃（列表读取会补上最终状态）。
    downloads.setEmitter(item => { try { win?.webContents.send('twilight:download-progress', item) } catch { /* 窗口没了 */ } })
  })
  engine.setHandlers({
    onEvent: sendEvent,
    onProtocolError: (line, err) => {
      console.error('[protocol] engine line failed to parse:', redactSensitiveText(line.slice(0, 200)), err)
      if (win && !win.isDestroyed()) win.webContents.send('twilight:protocol-error', line.slice(0, 200))
    },
    onDisconnect: (reason) => {
      meterVisibility.disconnected()
      console.error('[engine] disconnected:', reason)
      if (win && !win.isDestroyed()) win.webContents.send('twilight:disconnect', reason)
    }
  })
  engine.start()
  createTray()
  registerIpc()
  createWindow()
  // 更新服务在窗口建好后启动：初始状态能直接广播给已挂载的设置页。
  updater.start()
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  if (!singleInstance) return
  isQuitting = true
  engine.shutdown()
})

app.on('will-quit', () => {
  if (!singleInstance) return
  // 退出补写必须在任何异步清理之前：同步写几 KB，保证「上次听到哪里」不丢。
  flushPlaybackMemorySync()
  updater.stop()
  trackPrefetcher.cancel()
  tray?.destroy()
  tray = null
  // 让在线播放的回环 token 立即失效，再关代理。撤销是**安全特性**而不是资源
  // 回收（INTEGRATION §3.3）：退出后带着有效 token 的回环入口不该还能取到字节。
  onlinePlayback.release()
  void streamingManager.shutdown()
  void mediaProxy.close()
  engine.kill()
})
