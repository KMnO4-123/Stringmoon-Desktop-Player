import fs from 'node:fs'
import path from 'node:path'
import type { AppUpdater } from 'electron-updater'
import { redactForLog } from '@shared/redact'
import type { AppInfo, UpdatePhase, UpdateState } from '@shared/update'

/**
 * 自动更新（electron-updater 封装）。
 *
 * 为什么全部主进程：更新源配置、下载、安装、退出重启都是特权动作；渲染层只该看到
 * 一个「可序列化的 UpdateState」和 check/download/install 三个动作（见 shared/update.ts）。
 *
 * 两条纪律：
 *  1. **只在打包版启用**。开发模式不检查、不联网，状态显示 disabled-dev（不是错误）。
 *  2. **未显式配置更新源就绝不发请求**。electron-builder.yml 里的 publish.url 是占位，
 *     如果这里拿它当默认值，未配置的安装版会偷偷打 example.com。
 */

/** userData/update-feed.json：换自托管更新源不必重新打包。 */
export const UPDATE_FEED_FILE = 'update-feed.json'
/** 启动后多久自动检查一次（规格 §2：12s，先让窗口/引擎起来）。 */
export const AUTO_CHECK_DELAY_MS = 12_000

/**
 * 测试/演练用：环境变量 TWILIGHT_UPDATE_AUTOCHECK_MS 可缩短 12s 自动检查。
 * 非法值或缺省一律回退 12000；0 表示关闭自动检查（只留手动「检查更新」）。
 */
export function resolveAutoCheckDelay(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return AUTO_CHECK_DELAY_MS
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : AUTO_CHECK_DELAY_MS
}

export type FeedOrigin = 'env' | 'file' | 'none'

export interface FeedResolution {
  configured: boolean
  url: string | null
  note: string | null
  origin: FeedOrigin
  /** 面向用户/日志的一句中文原因；没有问题时 null。 */
  problem: string | null
}

const UNCONFIGURED = (problem: string | null, origin: FeedOrigin = 'none'): FeedResolution =>
  ({ configured: false, url: null, note: null, origin, problem })

/**
 * 只接受 http(s)，并拒绝带用户名/密码的 URL。
 *
 * 为什么拒绝凭据：错误信息、日志、设置页都会展示更新源；把 user:pass@host 带进去
 * 等于把凭据写进用户截图。自托管源应使用公开静态目录或独立的鉴权代理。
 */
export function normalizeFeedUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (!parsed.hostname) return null
  // generic provider 把 url 当目录用：统一补尾斜杠，避免拼出 .../releaseslatest.yml。
  const href = parsed.toString()
  return href.endsWith('/') ? href : href + '/'
}

function feedNoteOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const note = (raw as Record<string, unknown>).note
  return typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null
}

/**
 * 更新源优先级：env TWILIGHT_UPDATE_URL（最高） > userData/update-feed.json > 未配置。
 * 文件读失败 / JSON 坏 / url 非法都收敛成「未配置 + 一句原因」，绝不抛出启动阶段。
 */
export function resolveFeedConfig(options: { envUrl?: string | undefined; userDataPath: string }): FeedResolution {
  const envUrl = normalizeFeedUrl(options.envUrl)
  if (envUrl) return { configured: true, url: envUrl, note: null, origin: 'env', problem: null }
  if (typeof options.envUrl === 'string' && options.envUrl.trim()) {
    // env 写了但不是合法 http(s)：如实报配置错误，而不是悄悄回退到文件源。
    return UNCONFIGURED('TWILIGHT_UPDATE_URL 不是有效的 http(s) 地址，已忽略。', 'env')
  }

  const file = path.join(options.userDataPath, UPDATE_FEED_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return UNCONFIGURED(null, 'none')
    return UNCONFIGURED('读取 update-feed.json 失败（文件不可读）。', 'file')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return UNCONFIGURED('update-feed.json 不是合法的 JSON。', 'file')
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  const url = normalizeFeedUrl(record?.url)
  if (!url) return UNCONFIGURED('update-feed.json 里的 url 不是有效的 http(s) 地址。', 'file')
  return { configured: true, url, note: feedNoteOf(record), origin: 'file', problem: null }
}

// ---- 状态推导（纯函数：单测直接打这里，不需要 Electron） ----------------------

export interface UpdateStateSeed {
  currentVersion: string
  supported: boolean
  feedConfigured: boolean
}

export function initialUpdateState(seed: UpdateStateSeed, patch: Partial<UpdateState> & { phase: UpdatePhase }): UpdateState {
  return {
    phase: patch.phase,
    currentVersion: seed.currentVersion,
    latestVersion: patch.latestVersion ?? null,
    percent: patch.percent ?? null,
    message: patch.message ?? null,
    feedConfigured: seed.feedConfigured,
    supported: seed.supported
  }
}

export type UpdateReducerEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string | null }
  | { type: 'not-available' }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; version: string | null }
  | { type: 'error'; message: string }
  | { type: 'installing' }

export function clampPercent(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.min(100, Math.max(0, number))
}

/** 事件 → 新状态。electron-updater 的事件顺序不完全可靠，所有字段都从当前状态推导。 */
export function reduceUpdateState(state: UpdateState, event: UpdateReducerEvent): UpdateState {
  switch (event.type) {
    case 'checking':
      return { ...state, phase: 'checking', percent: null, message: '正在检查更新…' }
    case 'available':
      return {
        ...state,
        phase: 'available',
        latestVersion: event.version,
        percent: null,
        message: event.version ? '发现新版本 v' + event.version : '发现新版本'
      }
    case 'not-available':
      return { ...state, phase: 'up-to-date', latestVersion: null, percent: null, message: '已是最新版本' }
    case 'download-progress': {
      const percent = clampPercent(event.percent)
      return { ...state, phase: 'downloading', percent, message: '正在下载更新… ' + percent + '%' }
    }
    case 'downloaded':
      return {
        ...state,
        phase: 'downloaded',
        percent: 100,
        latestVersion: event.version ?? state.latestVersion,
        message: event.version ? '新版本 v' + event.version + ' 已下载，重启后安装' : '更新已下载，重启后安装'
      }
    case 'error':
      return { ...state, phase: 'error', percent: null, message: event.message }
    case 'installing':
      return { ...state, phase: 'installing', message: '正在重启并安装更新…' }
  }
}

const RAW_URL_RE = /https?:\/\/[^\s)"']+/gi
const FIRST_LINE_RE = /\r?\n/

/**
 * 上游错误 → 一句中文原因（单层、无堆栈、无 URL 凭据）。
 *
 * 分类来自实测的 electron-updater 报错面：断网、源上没有 latest.yml、鉴权/权限、
 * 校验失败。未知错误保留第一行（脱敏、去掉 URL），不要吞成「未知错误」。
 */
export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const firstLine = redactForLog(raw).replace(RAW_URL_RE, '[更新源]').split(FIRST_LINE_RE)[0]?.slice(0, 200).trim() ?? ''
  const lower = firstLine.toLowerCase()
  if (!firstLine) return '检查更新失败：未知原因。'
  if (/net::err|enotfound|econnrefused|etimedout|econnreset|eai_again|network|fetch failed|socket hang up|getaddrinfo/.test(lower)) {
    return '检查更新失败：无法连接更新服务器，请检查网络或更新源地址。'
  }
  if (/\b404\b|not found/.test(lower)) {
    return '检查更新失败：更新源上找不到更新信息（404），请确认地址与 latest.yml 是否完整。'
  }
  if (/\b(401|403)\b|unauthorized|forbidden|status code/.test(lower)) {
    return '检查更新失败：更新源拒绝访问，请确认该地址可公开读取。'
  }
  if (/sha|checksum|signature|verify/.test(lower)) {
    return '检查更新失败：更新包校验不通过，已停止安装。'
  }
  if (/no published versions|latest\.yml|channel file/.test(lower)) {
    return '检查更新失败：更新源缺少 latest.yml 或版本信息不完整。'
  }
  return '检查更新失败：' + firstLine
}

// ---- controller -----------------------------------------------------------

/** electron-updater 的最小结构化接口：单测可以注入假实现，不必加载 Electron。 */
export type UpdaterAdapter = Pick<
  AppUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'allowDowngrade' | 'setFeedURL' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on'
>

export interface UpdaterOptions {
  app: AppInfo
  /** 生产传 process.env.TWILIGHT_UPDATE_URL；测试直接给字符串。 */
  envUrl?: string | undefined
  onState: (state: UpdateState) => void
  /** 安装前同步收尾（index.ts 传 flushPlaybackMemorySync）。 */
  beforeInstall?: () => void
  autoCheckDelayMs?: number
  /** 测试注入；生产懒加载真实 electron-updater。 */
  adapterFactory?: () => Promise<UpdaterAdapter>
  /** 安装形态下的可执行文件路径（默认 process.execPath；测试注入用）。 */
  exePath?: string
  log?: (message: string) => void
}

/**
 * 从动态 import 的结果里取 autoUpdater（兼容 ESM 命名空间与 CJS default 两种形状）。
 *
 * 为什么需要：主进程被 electron-vite externalize 成 CJS，运行时
 * await import('electron-updater') 拿到的是 CJS 模块的命名空间；不同 bundler/
 * interop 下 autoUpdater 可能挂在模块本身，也可能只挂在 default 上。直接
 * module.autoUpdater 在后者会得到 undefined，随后 ensureAdapter 里
 * undefined.autoDownload = false 就炸成安装版实测到的
 * "Cannot set properties of undefined (setting 'autoDownload')"。
 */
export function autoUpdaterFromModule(loaded: unknown): UpdaterAdapter | null {
  if (loaded === null || typeof loaded !== 'object') return null
  const namespace = loaded as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } }
  const candidate = namespace.autoUpdater ?? namespace.default?.autoUpdater
  return candidate !== null && typeof candidate === 'object' ? candidate as UpdaterAdapter : null
}

/** 懒加载真实模块：主进程构建把 electron-updater 外部化，打包后从 node_modules 取。 */
async function loadElectronUpdater(): Promise<UpdaterAdapter> {
  const loaded = await import('electron-updater')
  const adapter = autoUpdaterFromModule(loaded)
  if (!adapter) throw new Error('更新模块加载失败（electron-updater 未导出 autoUpdater）。')
  return adapter
}

const versionOf = (info: unknown): string | null => {
  if (info === null || typeof info !== 'object') return null
  const version = (info as Record<string, unknown>).version
  return typeof version === 'string' && version ? version : null
}

const percentOf = (info: unknown): number => {
  if (info === null || typeof info !== 'object') return 0
  const percent = (info as Record<string, unknown>).percent
  return typeof percent === 'number' ? percent : 0
}

export class UpdaterService {
  private readonly options: UpdaterOptions
  private readonly seed: UpdateStateSeed
  private readonly feed: FeedResolution
  private state: UpdateState
  private adapter: UpdaterAdapter | null = null
  private wired = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<UpdateState> | null = null

  constructor(options: UpdaterOptions) {
    this.options = options
    const supported = options.app.packaged === true
    this.feed = supported
      ? resolveFeedConfig({ envUrl: options.envUrl, userDataPath: options.app.userDataPath })
      : { configured: false, url: null, note: null, origin: 'none', problem: null }
    this.seed = { currentVersion: options.app.version, supported, feedConfigured: this.feed.configured }
    this.state = this.initialState()
  }

  private initialState(): UpdateState {
    if (!this.seed.supported) {
      return initialUpdateState(this.seed, {
        phase: 'disabled-dev',
        message: '开发模式不检查更新；安装版启动后才会自动更新。'
      })
    }
    if (!this.feed.configured) {
      const hint = this.feed.problem
        ? '更新源配置无效：' + this.feed.problem + '自动更新未启用。'
        : '未配置更新源：设置环境变量 TWILIGHT_UPDATE_URL，或在数据目录写 update-feed.json。'
      return initialUpdateState(this.seed, { phase: 'unconfigured', message: hint })
    }
    const origin = this.feed.origin === 'env' ? '环境变量' : 'update-feed.json'
    return initialUpdateState(this.seed, {
      phase: 'idle',
      message: '更新源已配置（' + origin + '），启动 12 秒后自动检查。'
    })
  }

  getState(): UpdateState {
    return this.state
  }

  /** 启动接线：先把初始状态播一次，再（仅配置了源的打包版）安排 12s 后自动检查。 */
  start(): void {
    this.emit()
    if (!this.seed.supported || !this.feed.configured) return
    const delay = this.options.autoCheckDelayMs ?? AUTO_CHECK_DELAY_MS
    if (delay <= 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
    }, delay)
    // 主进程里这个 timer 不该单独撑住事件循环（Electron 有 app 管生命周期）。
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private log(message: string): void {
    const line = 'update: ' + message
    if (this.options.log) this.options.log(line)
    else console.log('[update]', redactForLog(line))
  }

  private emit(): void {
    try {
      this.options.onState(this.state)
    } catch (error) {
      this.log('状态广播失败：' + redactForLog(error))
    }
  }

  private patch(event: UpdateReducerEvent): UpdateState {
    this.state = reduceUpdateState(this.state, event)
    this.emit()
    return this.state
  }

  private fail(error: unknown): UpdateState {
    const message = describeUpdateError(error)
    this.log(message)
    return this.patch({ type: 'error', message })
  }

  private async ensureAdapter(): Promise<UpdaterAdapter> {
    if (this.adapter) return this.adapter
    const factory = this.options.adapterFactory ?? loadElectronUpdater
    const adapter = await factory()
    // 三个开关是产品决定，不是可配置项：不自动下载（尊重流量）、已下载的更新
    // 退出时自动装（无痛）、不降级（避免把用户推回旧版）。
    adapter.autoDownload = false
    adapter.autoInstallOnAppQuit = true
    adapter.allowDowngrade = false
    adapter.setFeedURL({ provider: 'generic', url: this.feed.url ?? '' })
    // assisted NSIS 的静默更新必须显式告诉安装器装到哪：electron-updater 只有
    // installDirectory 非空时才传 /D=<dir>；否则 /S 会装到 NSIS 默认目录，
    // 用户自定义安装目录的覆盖升级就会变成「旧目录一份、新目录一份」。
    // 安装形态下当前进程 exe 就在安装目录里，dirname 就是真实安装路径。
    // NsisUpdater 有 installDirectory，基类 AppUpdater 类型没有，用窄断言。
    if (this.seed.supported) {
      (adapter as UpdaterAdapter & { installDirectory?: string }).installDirectory =
        path.dirname(this.options.exePath ?? process.execPath)
    }
    if (!this.wired) {
      this.wired = true
      adapter.on('checking-for-update', () => { this.patch({ type: 'checking' }) })
      adapter.on('update-available', (info: unknown) => { this.patch({ type: 'available', version: versionOf(info) }) })
      adapter.on('update-not-available', () => { this.patch({ type: 'not-available' }) })
      adapter.on('download-progress', (info: unknown) => { this.patch({ type: 'download-progress', percent: percentOf(info) }) })
      adapter.on('update-downloaded', (info: unknown) => { this.patch({ type: 'downloaded', version: versionOf(info) }) })
      adapter.on('error', (error: unknown) => { this.fail(error) })
    }
    this.adapter = adapter
    return adapter
  }

  /**
   * 检查更新。幂等：正在检查/下载/安装时重复调用直接返回当前状态，
   * 不叠加请求；并发调用共享同一个 in-flight promise。
   */
  async check(): Promise<UpdateState> {
    if (!this.seed.supported || !this.feed.configured) return this.state
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return this.state
    }
    if (this.inFlight) return this.inFlight
    this.patch({ type: 'checking' })
    this.inFlight = (async () => {
      try {
        const adapter = await this.ensureAdapter()
        const result = await adapter.checkForUpdates()
        // 事件通常已经给出结论；若没有（某些 provider 只在 promise 里给），用结果兜底。
        if (this.state.phase === 'checking') {
          const info = (result ?? null) as { updateInfo?: { version?: unknown } } | null
          const version = typeof info?.updateInfo?.version === 'string' ? info.updateInfo.version : null
          if (version && version !== this.seed.currentVersion) this.patch({ type: 'available', version })
          else this.patch({ type: 'not-available' })
        }
        return this.state
      } catch (error) {
        return this.fail(error)
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /** 下载已发现的新版本。幂等：不是 available 状态时是空操作（不抛错、不重复下载）。 */
  async download(): Promise<UpdateState> {
    if (!this.seed.supported || !this.feed.configured) return this.state
    if (this.state.phase !== 'available') return this.state
    try {
      const adapter = await this.ensureAdapter()
      this.patch({ type: 'download-progress', percent: 0 })
      await adapter.downloadUpdate()
      return this.state
    } catch (error) {
      return this.fail(error)
    }
  }

  /**
   * 重启并安装。只有 downloaded 状态才动作；安装前同步收尾（播放记忆落盘），
   * 然后 quitAndInstall(true, true) —— **静默**安装并重启新版本。
   *
   * 第一个参数必须是 true：electron-updater 只在 isSilent=true 时给 NSIS 加 /S，
   * 否则安装向导窗口会弹出并卡住（verifier 在最终安装包上实测过）。
   */
  install(): UpdateState {
    if (this.state.phase !== 'downloaded') return this.state
    const adapter = this.adapter
    if (!adapter) return this.fail(new Error('更新尚未就绪，无法安装。'))
    this.patch({ type: 'installing' })
    try {
      this.options.beforeInstall?.()
    } catch (error) {
      this.log('安装前收尾失败（继续安装）：' + redactForLog(error))
    }
    try {
      adapter.quitAndInstall(true, true)
    } catch (error) {
      return this.fail(error)
    }
    return this.state
  }
}
