/**
 * 平台层的总装（CONTRACT §4.2 的 MusicProvider 落地）。
 *
 * 这一层负责四件互相牵制的事，所以必须在一个文件里：
 *
 * 1. **节流**（§5 硬要求）：同一平台请求间隔 ≥1s。放在这里而不是调用方，
 *    是因为"任何调用方都不得绕过"——包括以后新增的界面。
 * 2. **风控退避**（§5）：收到限流类信号立即封停该平台并提示，**不重试**。
 *    这一类错误下重试就是加重封禁。
 * 3. **凭据**（§5）：扫码拿到的 cookie 只进 safeStorage（DPAPI），永不明文落盘；
 *    没有可用的加密后端时宁可不保存，也不退化成明文。
 * 4. **服务端生命周期**：用户自备命令，应用拉起、探活、退出清理。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { redactSensitiveText } from '@shared/redact'
import {
  DEFAULT_METING_SOURCE,
  defaultQualityOf,
  defaultStreamingConfig,
  platformQualityOptions,
  platformSpec,
  PLATFORM_SPECS,
  sanitizeConfig,
  type MetingSource,
  type PlatformId,
  type PlatformSession,
  type ProviderConfig,
  type ProviderRuntime,
  type QrChannel,
  type QrTicket,
  type PlatformAccount,
  type PlatformPlaylist,
  type StreamingConfig,
  type StreamingSimilarResult,
  type GdSourceStatus,
  type StreamingTrack,
  normalizeCookie,
  qqSessionToken
} from '@shared/streaming'
import { ApiServer } from './api-server'
import { locationFromRedirect, meting, metingServerFor, metingToken, netease, qq } from './adapters'
import { cookieScope, DiscoveryCore } from './discovery'
import type { DiscoverHome, DiscoverPlatform, DiscoverPlaylistsPage, DiscoverTracksResult } from '@shared/discover'
import { gdStudio, type GdStudioClient } from './gdstudio'
import {
  classifyProbeError,
  KEEP_ALIVE_FIRST_DELAY_MS,
  KEEP_ALIVE_INTERVAL_MS,
  keepAliveNoteFor,
  mergeCookie,
  parseRefreshCookie,
  shouldProbe
} from './keep-alive'
import { loginDiag } from './login-diagnostics'
import { plainSecretOf } from './secrets'

const REQUEST_TIMEOUT_MS = 12_000

/**
 * 把平台 id 收敛成「发现页支持的两个平台」。
 *
 * meting/gdstudio 没有发现页数据（一个是通用解析源、一个是公共电台），传进来
 * 一定是调用方写错了；这里明确抛一句中文，而不是悄悄去请求一个不存在的东西。
 */
const discoverPlatformOf = (platform: PlatformId): DiscoverPlatform => {
  if (platform === 'netease' || platform === 'qq') return platform
  throw new Error('发现页只支持网易云音乐和 QQ 音乐（当前平台：' + platform + '）。')
}
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
const MIN_INTERVAL_MS = 1000

/**
 * 平台服务端空闲多久后停掉。
 *
 * 平台服务端是独立 Node 进程（实测两个常驻 165.1 MB + 83.7 MB），本地/离线播放时
 * 它们没有任何存在理由。默认 10 分钟；TWILIGHT_STREAMING_IDLE_MS 只给验证脚本
 * 缩短阈值用 —— 不要在测试里真的等 10 分钟。
 */
const IDLE_STOP_MS = (() => {
  const override = Number(process.env.TWILIGHT_STREAMING_IDLE_MS)
  return Number.isFinite(override) && override > 0 ? override : 10 * 60_000
})()
/** 巡检间隔：生产 60s；验证脚本把阈值调短时按 1/4 自动缩短（最短 250ms）。 */
const IDLE_CHECK_MS = Math.max(250, Math.min(60_000, Math.floor(IDLE_STOP_MS / 4)))

/**
 * CONTRACT §5 的风控熔断：一旦出现这些信号，**立即停止该平台全部请求**，不重试。
 *
 * 已知事实（契约 §5 的风险表）：-460 Cheating 出现过 24 小时未恢复；约 1 次/分钟
 * 的高频访问即被封。所以宁可 10 分钟内什么都不发，也不要在被封时继续请求 ——
 * 重试只会加重封禁，而且会波及用户的主账号。
 *  -460 常以 HTTP 200 + JSON body 的 code/upstreamCode 出现；
 *  403/418 是上游风控/反爬最常见的两种裸状态码（不读 body 也能判定）。
 */
const RISK_BODY_CODES = new Set([-460, 460])
const RISK_HTTP_STATUS = new Set([403, 418])
const isRiskCode = (code: number): boolean => Number.isFinite(code) && RISK_BODY_CODES.has(code)

/** 同一平台的最小请求间隔。串行化而不是排队丢弃：用户点一次搜索就该得到一次结果。 */
class Throttle {
  private tail: Promise<unknown> = Promise.resolve()
  private lastAt = 0
  constructor(private readonly minIntervalMs = MIN_INTERVAL_MS) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      const wait = this.lastAt + this.minIntervalMs - Date.now()
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      this.lastAt = Date.now()
      return task()
    })
    this.tail = next.catch(() => undefined)
    return next as Promise<T>
  }
}

export interface PlayTarget {
  url: string
  referer?: string
  userAgent?: string
  allowInsecure?: boolean
  title: string
  artist: string
  /** 这次请求的音质档位（请求值，不是承诺；真正的音质看引擎解码后上报的采样率/位深）。 */
  quality?: string
}

interface Secrets { [platform: string]: string }

const NET_EASE_REFERER = 'https://music.163.com/'
const QQ_REFERER = 'https://y.qq.com/'
// 平台 CDN 对没有 UA 的请求经常回 403，这是实测里最常见的一类"取到链接却播不了"。
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export class StreamingManager {
  private servers = new Map<PlatformId, ApiServer>()
  private throttles = new Map<PlatformId, Throttle>()
  private sessions = new Map<PlatformId, PlatformSession>()
  private secrets: Secrets = {}
  private qrKeys = new Map<PlatformId, string>()
  private blocked = new Map<PlatformId, { until: number; reason: string }>()
  private config: StreamingConfig = defaultStreamingConfig()
  private configFile: string | null = null
  private secretsFile: string | null = null
  private ready = Promise.resolve()
  /**
   * 会话保活定时器（v6）。两个分开存：首次巡检是一次性延迟，之后才是间隔巡检；
   * 合成一个会迫使首次也用 interval，启动 8 秒就进入 6 小时节奏（语义不对）。
   */
  private keepAliveFirstTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  /** 正在启动中的服务端：并发调用（搜索+登录同时点）必须共享同一次启动。 */
  private starting = new Map<PlatformId, Promise<void>>()
  /** 每个平台最后一次真正发请求的时刻；空闲巡检据此判断。 */
  private lastActivityAt = new Map<PlatformId, number>()
  /** 在途请求数：有请求时绝不空闲停服。 */
  private inFlight = new Map<PlatformId, number>()
  /** 正在被在线播放占用的平台（取直链后到播放结束之间）；空闲巡检必须跳过它。 */
  private playbackHold: PlatformId | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  /**
   * GD 音乐台是**内置 HTTP 源**（builtin）：没有服务端进程/端口/登录，
   * 所以不进 servers 表，也不参与空闲巡检。可注入仅为单测（默认单例）。
   */
  readonly gd: GdStudioClient
  /**
   * 发现页内核（PLAN §1.1）。
   *
   * 为什么不用它自己的 HTTP 客户端：发现页一次进页面最多四个上游请求，必须和搜索/
   * 取链共用**同一个**「同平台 ≥1s 串行 + 风控熔断」桶（CONTRACT §5）。两套节流彼此
   * 不知道对方时，并发请求会直接绕过 1s 间隔。所以这里只注入「怎么发请求」，
   * 节流/熔断/失败文案仍由这一层负责。
   */
  private readonly discovery = new DiscoveryCore({
    // 两个平台共用同一个节流/熔断桶（每个平台一个桶，见 throttles）：发现页不是一条
    // 绕过 CONTRACT §5 的旁路，所以平台参数一路传到底，而不是写死 netease。
    scope: async platform => {
      await this.ensureStarted(platform)
      // base() 在服务端没起来时会抛「请先在设置里启动它」这类带下一步的中文错误。
      this.base(platform)
      // 缓存必须按账号隔离：换账号后每日推荐/漫游是另一份内容。
      return cookieScope(this.secrets[platform])
    },
    send: (platform, path) => this.json(platform, this.base(platform) + path),
    signedIn: platform => this.hasSession(platform),
    now: () => Date.now()
  })

  constructor(options: { gd?: GdStudioClient } = {}) {
    this.gd = options.gd ?? gdStudio
    // 只有「用户自备服务端」的平台才需要进程生命周期；builtin 平台跳过。
    for (const spec of PLATFORM_SPECS) {
      if (spec.builtin) {
        this.sessions.set(spec.id, { platform: spec.id, status: 'signed-out', accountName: null })
        continue
      }
      this.servers.set(spec.id, new ApiServer(spec.id))
      this.throttles.set(spec.id, new Throttle())
      this.sessions.set(spec.id, { platform: spec.id, status: 'signed-out', accountName: null })
    }
  }

  /** 内置 HTTP 源的运行时（没有进程，状态就是 ready）。 */
  private builtinRuntime(platform: PlatformId): ProviderRuntime {
    return { platform, state: 'ready', port: null, pid: null, error: null, log: [] }
  }

  private isBuiltin(platform: PlatformId): boolean {
    return platformSpec(platform).builtin === true
  }

  configure(configFile: string, secretsFile: string): void {
    this.configFile = configFile
    this.secretsFile = secretsFile
    this.ready = (async () => {
      try {
        const parsed = JSON.parse(await readFile(configFile, 'utf8')) as StreamingConfig
        this.config = sanitizeConfig(parsed)
      } catch { /* 首次运行或文件损坏：用默认配置，不阻断启动 */ }
      this.secrets = await this.loadSecrets()
      for (const platform of ['netease', 'qq'] as PlatformId[]) {
        if (this.secrets[platform]) {
          // 只置 'signed-in' 是「本地有凭据」，不等于「服务端还认」；保活巡检会在一分钟后
          // 把真实结论写进 keepAlive 字段，界面同时显示两者（v6）。
          this.sessions.set(platform, {
            platform, status: 'signed-in', accountName: null,
            keepAlive: 'idle', keepAliveNote: '尚未校验', lastVerifiedAt: null
          })
        }
      }
      this.scheduleKeepAlive()
    })()
    // 空闲巡检只负责「停」，与启动解耦：按需启动模式下没有它，服务端一旦被
    // 第一次操作拉起来就会常驻到应用退出。
    this.startIdleSweeper()
  }

  /**
   * 安全存储（DPAPI）只在真正要读写凭据时才加载。
   *
   * 除了「不碰凭据就不初始化加密后端」这一点，还有可测试性的原因：模块顶层
   * import electron 会让这个文件在普通 node 测试里连导入都失败（electron 包的
   * CJS 形状不提供 safeStorage 命名导出），而服务端生命周期逻辑本身与 Electron 无关。
   */
  private async safeStorageOrNull(): Promise<typeof import('electron').safeStorage | null> {
    try {
      const electron = await import('electron')
      const storage = electron.safeStorage
      return storage && typeof storage.isAsyncEncryptionAvailable === 'function' ? storage : null
    } catch {
      return null
    }
  }

  private async loadSecrets(): Promise<Secrets> {
    if (!this.secretsFile) return {}
    let raw: Record<string, string>
    try {
      raw = JSON.parse(await readFile(this.secretsFile, 'utf8')) as Record<string, string>
    } catch { return {} }
    const safeStorage = await this.safeStorageOrNull()
    // isAsyncEncryptionAvailable 在 Electron 44 返回 Promise<boolean>（不是同步布尔），
    // 必须 await；不 await 的话一个永远 truthy 的 Promise 会让「没有加密后端」形同虚设。
    if (!safeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) {
      // 没有加密后端就**不保存**，也不假装读过——CONTRACT §5 明确禁止明文落盘。
      return {}
    }
    const out: Secrets = {}
    let needsReEncrypt = false
    for (const [platform, cipher] of Object.entries(raw)) {
      try {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(cipher, 'base64'))
        const plain = plainSecretOf(decrypted)
        if (plain.secret !== null) {
          out[platform] = plain.secret
          if (plain.reEncrypt) needsReEncrypt = true
        }
      } catch { /* 换了机器/换了用户，旧密文解不开是正常情况 */ }
    }
    // DPAPI 密钥轮换后旧密文仍可读，但应尽快用新密钥重写；失败不影响本次会话
    //（下次启动会再看到 shouldReEncrypt，继续尝试）。
    if (needsReEncrypt) {
      this.secrets = out
      await this.persistSecrets().catch(() => undefined)
    }
    return out
  }

  private async persistSecrets(): Promise<void> {
    if (!this.secretsFile) return
    const safeStorage = await this.safeStorageOrNull()
    // Electron 44 的 isAsyncEncryptionAvailable() 返回 Promise<boolean>：不 await 的话
    // Promise 恒真，"没有加密后端就不落盘"的闸形同虚设（还会把 {} 覆盖到已有凭据文件上）。
    if (!safeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) return
    const raw: Record<string, string> = {}
    for (const [platform, value] of Object.entries(this.secrets)) {
      try {
        raw[platform] = (await safeStorage.encryptStringAsync(value)).toString('base64')
      } catch { /* 存不下就不存，不影响本次会话 */ }
    }
    await mkdir(path.dirname(this.secretsFile), { recursive: true })
    await writeFile(this.secretsFile + '.tmp', JSON.stringify(raw), 'utf8')
    await rename(this.secretsFile + '.tmp', this.secretsFile)
  }

  // --- 生命周期 ---------------------------------------------------------

  /**
   * 启动时调用一次：
   *  - lazyStart（缺省 true）：**什么都不拉起**，运行时状态保持 stopped；
   *    第一次平台操作由 ensureStarted() 拉起，空闲 10 分钟由巡检停掉。
   *  - lazyStart=false：回退旧行为，启动即把 enabled 的平台全部拉起（CR-023 的回退开关）。
   */
  async startOnLaunch(): Promise<void> {
    await this.ready
    if (this.config.lazyStart === false) await this.startEnabled()
  }

  /**
   * 显式启动（用户点「启动」或 lazyStart=false 的启动期自动拉起）。
   *
   * CR-023：多个平台**并行**拉起。串行会让第二个平台白等第一个的就绪探活
   * （最坏各 90s），而两平台互不依赖；单个失败只写进它自己的 runtime，
   * 不影响另一个（Promise.all 里的 catch 只吞该平台的错误）。
   * 走同一条 startServer 路径：与渲染层第一次操作并发时只 spawn 一次。
   */
  async startEnabled(): Promise<void> {
    await this.ready
    const enabled = this.config.providers.filter(provider => provider.enabled && provider.command.trim())
    await Promise.all(enabled.map(async (provider) => {
      try {
        await this.startServer(provider.platform)
      } catch { /* 单个平台起不来不阻断另一个；原因已写进该平台 runtime */ }
    }))
  }

  async start(platform: PlatformId): Promise<ProviderRuntime> {
    await this.ready
    // 内置 HTTP 源没有可启动的进程：如实返回 ready（界面据此隐藏启动按钮）。
    if (this.isBuiltin(platform)) return this.builtinRuntime(platform)
    await this.startServer(platform)
    return this.requireServer(platform).status()
  }

  /**
   * 一次启动只发生一次：并发的 ensureStarted / start 共享同一个 Promise。
   * 返回时服务端要么 ready、要么已经是 failed（由 ApiServer 自己带 error）。
   */
  private startServer(platform: PlatformId): Promise<void> {
    const running = this.starting.get(platform)
    if (running) return running
    const provider = this.config.providers.find(item => item.platform === platform)
    if (!provider || !provider.command.trim()) return Promise.reject(new Error('还没有为这个平台配置启动命令。'))
    const server = this.requireServer(platform)
    const run = server.start(provider.command).finally(() => { this.starting.delete(platform) })
    this.starting.set(platform, run)
    return run.then(() => { this.lastActivityAt.set(platform, Date.now()) })
  }

  /**
   * 用之前确保服务端在跑（A1 的核心）。凡是「真的要向平台发请求」的入口都先 await 它：
   *  - 已 ready：立即返回；
   *  - 正在启动：搭同一趟车（不重复 spawn）；
   *  - failed：**不自动重启** —— 那是用户点「启动」才能翻过去的坑，否则每个搜索
   *    请求都会再打一遍 90 秒超时；
   *  - stopped：启动，失败时把错误如实抛给调用方（不吞、不阻塞其它功能）。
   */
  async ensureStarted(platform: PlatformId): Promise<void> {
    await this.ready
    // 内置 HTTP 源无需（也没有）服务端进程可等。
    if (this.isBuiltin(platform)) return
    const server = this.requireServer(platform)
    const runtime = server.status()
    // ⚠️ 判据必须是 state==='ready'，不能用 base()：ApiServer 在探活**之前**就分配了
    // 端口，starting 阶段 base() 已经非 null。用 base() 会让并发操作提前返回，
    // 打到还没开始监听的端口上（表现为随机 ECONNREFUSED / 空响应）。
    if (runtime.state === 'ready') return
    const starting = this.starting.get(platform)
    if (starting) return starting
    if (runtime.state === 'failed') {
      throw new Error(runtime.error ?? (platformSpec(platform).displayName + '服务端启动失败，请检查启动命令。'))
    }
    await this.startServer(platform)
    const after = server.status()
    if (after.state !== 'ready') throw new Error(after.error ?? (platformSpec(platform).displayName + '服务端没有就绪。'))
  }

  /**
   * 在线播放占用标记：取到直链到播放结束之间，对应平台不会被空闲巡检停掉。
   * 只记一个（同一时刻只有一首歌在放）；null 表示没有占用。
   */
  setPlaybackHold(platform: PlatformId | null): void {
    this.playbackHold = platform
  }

  private startIdleSweeper(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => { void this.sweepIdleServers() }, IDLE_CHECK_MS)
    // 巡检不是「还有事要做」的理由：不让它把进程钉在事件循环里。
    this.idleTimer.unref?.()
  }

  /**
   * 空闲停服：ready 且超过 IDLE_STOP_MS 没有任何请求、没有在途请求、没有启动中、
   * 没有进行中的扫码、也没被在线播放占用 → 停掉该平台服务端。
   * lazyStart=false 是用户显式选择的「常驻」，这种情况不巡检。
   */
  private async sweepIdleServers(): Promise<void> {
    await this.ready.catch(() => undefined)
    if (this.config.lazyStart === false) return
    const now = Date.now()
    for (const [platform, server] of this.servers) {
      if (server.status().state !== 'ready') continue
      if (this.playbackHold === platform) continue
      if ((this.inFlight.get(platform) ?? 0) > 0) continue
      if (this.starting.has(platform)) continue
      if (this.qrKeys.has(platform)) continue
      if (now - (this.lastActivityAt.get(platform) ?? 0) < IDLE_STOP_MS) continue
      await server.stop()
    }
  }

  async stop(platform: PlatformId): Promise<ProviderRuntime> {
    if (this.isBuiltin(platform)) return this.builtinRuntime(platform)
    const server = this.requireServer(platform)
    await server.stop()
    return server.status()
  }

  async shutdown(): Promise<void> {
    this.stopKeepAlive()
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    await Promise.all([...this.servers.values()].map(server => server.stop()))
  }

  runtimes(): ProviderRuntime[] {
    const serverRuntimes = [...this.servers.values()].map(server => server.status())
    const builtinRuntimes = PLATFORM_SPECS.filter(spec => spec.builtin).map(spec => this.builtinRuntime(spec.id))
    return [...serverRuntimes, ...builtinRuntimes]
  }

  getConfig(): StreamingConfig {
    return {
      version: 1,
      lazyStart: this.config.lazyStart !== false,
      providers: this.config.providers.map(provider => ({ ...provider }))
    }
  }

  async saveConfig(next: StreamingConfig): Promise<StreamingConfig> {
    // 渲染层保存的是它改过的字段（启动命令/音质/上游），不一定带 lazyStart。
    // sanitizeConfig 的缺省是 true；这里若直接交给它，一次「保存启动命令」就会把
    // 用户显式设的 lazyStart=false 静默复位成 true（反过来不会自动变 false）。
    // 约定：**字段缺省 = 保持当前选择**，只有显式 true/false 才改变它。
    const keepsLazyStart = next && typeof next === 'object' && next.lazyStart === undefined && this.config.lazyStart !== undefined
    this.config = sanitizeConfig(keepsLazyStart ? { ...next, lazyStart: this.config.lazyStart } : next)
    if (this.configFile) {
      await mkdir(path.dirname(this.configFile), { recursive: true })
      await writeFile(this.configFile + '.tmp', JSON.stringify(this.config, null, 2), 'utf8')
      await rename(this.configFile + '.tmp', this.configFile)
    }
    return this.getConfig()
  }

  sessionList(): PlatformSession[] {
    return [...this.sessions.values()].map(session => ({ ...session }))
  }

  // --- 会话保活（v6）-------------------------------------------------------

  /** 把保活结论合并进会话对象（不动其它字段，避免把 accountName 冲掉）。 */
  private patchSession(platform: PlatformId, patch: Partial<PlatformSession>): void {
    const current = this.sessions.get(platform) ?? { platform, status: 'signed-out' as const, accountName: null }
    this.sessions.set(platform, { ...current, ...patch, platform })
  }

  /**
   * 立刻校验（并在平台支持时续期）会话。返回校验后的会话快照。
   *
   * 三个诚实边界：
   *  1. 服务端没在跑就不校验（也不为了校验把它拉起来）——后台偷启动进程比「不知道」更糟；
   *  2. 有用户请求在途就跳过（不和用户抢风控额度）；
   *  3. 网络错误写成 error，只有服务端明确不认才写 expired —— 两者的用户动作不同。
   */
  async verifySessions(options: { platform?: PlatformId } = {}): Promise<PlatformSession[]> {
    await this.ready
    const platforms = (options.platform ? [options.platform] : (['netease', 'qq'] as PlatformId[]))
      .filter(platform => Boolean(this.secrets[platform]))
    await Promise.all(platforms.map(async platform => {
      const runtime = this.servers.get(platform)?.status() ?? null
      if (!shouldProbe({ signedIn: Boolean(this.secrets[platform]), runtimeState: runtime?.state ?? null, inFlight: this.inFlight.get(platform) ?? 0 })) {
        // 有请求在途时保持原结论（别把「正在忙」显示成「未校验」）；其余情况写 idle。
        if (runtime?.state !== 'ready') this.patchSession(platform, { keepAlive: 'idle', keepAliveNote: '服务端未启动，暂不校验' })
        else if ((this.inFlight.get(platform) ?? 0) > 0) this.patchSession(platform, { keepAlive: 'checking', keepAliveNote: '正在处理其它请求，稍后校验' })
        return
      }
      this.patchSession(platform, { keepAlive: 'checking', keepAliveNote: null })
      try {
        const base = this.base(platform)
        // 1) 尽力续期：只有 netease 有 /login/refresh。失败（404/形状不对）不算会话失效，
        //    最终结论仍然看 login/status。
        let renewed = false
        if (platform === 'netease') {
          const refreshJson = await this.json(platform, netease.loginRefresh(base)).catch(() => null)
          const freshCookie = parseRefreshCookie(refreshJson)
          if (freshCookie) {
            const previous = this.secrets[platform] ?? ''
            const merged = mergeCookie(previous, freshCookie)
            if (merged !== previous) {
              this.secrets[platform] = normalizeCookie(merged)
              await this.persistSecrets().catch(() => undefined)
              renewed = true
            }
          }
        }
        // 2) 权威结论：服务端认不认这个会话。
        const statusJson = platform === 'netease'
          ? await this.json(platform, netease.loginStatus(base))
          : await this.json(platform, qq.loginStatus(base))
        const account = platform === 'netease' ? netease.mapAccount(statusJson) : qq.mapAccount(statusJson)
        if (!account.signedIn) {
          throw new Error(platformSpec(platform).displayName + '会话已过期：服务端不认这份凭据。')
        }
        this.patchSession(platform, {
          status: 'signed-in',
          accountName: account.nickname ?? this.sessions.get(platform)?.accountName ?? null,
          // QQ 没有续期接口：能校验但不能延长，如实标 unsupported（仍然算校验成功）。
          keepAlive: platform === 'qq' ? 'unsupported' : 'ok',
          keepAliveNote: platform === 'qq' ? 'QQ 音乐没有续期接口，只做校验' : (renewed ? '已续期' : null),
          lastVerifiedAt: Date.now()
        })
      } catch (error) {
        const kind = classifyProbeError(error)
        this.patchSession(platform, {
          keepAlive: kind,
          keepAliveNote: keepAliveNoteFor(kind, platformSpec(platform).displayName),
          lastVerifiedAt: Date.now()
        })
      }
    }))
    return this.sessionList()
  }

  /** 首次延迟 + 周期巡检。只在 configure() 之后调用一次；重复调用会先清旧定时器。 */
  private scheduleKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveFirstTimer = setTimeout(() => {
      this.keepAliveFirstTimer = null
      void this.verifySessions().catch(() => undefined)
      this.keepAliveTimer = setInterval(() => {
        void this.verifySessions().catch(() => undefined)
      }, KEEP_ALIVE_INTERVAL_MS)
      // 定时器不该把进程钉在事件循环里（主进程退出时由 shutdown 清理）。
      this.keepAliveTimer.unref?.()
    }, KEEP_ALIVE_FIRST_DELAY_MS)
    this.keepAliveFirstTimer.unref?.()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveFirstTimer) { clearTimeout(this.keepAliveFirstTimer); this.keepAliveFirstTimer = null }
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null }
  }

  /**
   * 存一个**服务端共享密钥**（目前只有 Meting 的 METING_TOKEN 用到）。
   * 它和账号 cookie 一样进 safeStorage：虽然是本地共享密钥，但它决定了能不能取到直链。
   */
  async setSecret(platform: PlatformId, value: string): Promise<void> {
    const trimmed = value.trim()
    if (trimmed) this.secrets[platform] = trimmed
    else delete this.secrets[platform]
    await this.persistSecrets()
    if (platform !== 'meting') {
      this.sessions.set(platform, { platform, status: trimmed ? 'signed-in' : 'signed-out', accountName: null })
    }
  }

  async logout(platform: PlatformId): Promise<void> {
    this.secrets[platform] = ''
    delete this.secrets[platform]
    this.sessions.set(platform, { platform, status: 'signed-out', accountName: null })
    if (platform === 'netease') this.resetDiscoveryCache()
    await this.persistSecrets()
  }

  private requireServer(platform: PlatformId): ApiServer {
    const server = this.servers.get(platform)
    if (!server) throw new Error('未配置的平台：' + platform)
    return server
  }

  private base(platform: PlatformId): string {
    const base = this.requireServer(platform).base()
    if (!base) throw new Error(platformSpec(platform).displayName + '服务端没有在运行，请先在设置里启动它。')
    return base
  }

  private checkBlocked(platform: PlatformId): void {
    const entry = this.blocked.get(platform)
    if (!entry) return
    if (Date.now() >= entry.until) { this.blocked.delete(platform); return }
    throw new Error('已暂停对' + platformSpec(platform).displayName + '的请求：' + entry.reason)
  }

  private block(platform: PlatformId, reason: string, minutes = 10): void {
    this.blocked.set(platform, { until: Date.now() + minutes * 60_000, reason })
  }

  private throttle(platform: PlatformId): Throttle {
    const throttle = this.throttles.get(platform)
    if (!throttle) throw new Error('未配置的平台：' + platform)
    return throttle
  }

  /**
   * 本地会话里有没有这个平台的登录凭据（**不联网**）。
   *
   * 发现页要在「未登录就不发个性化请求」和「已登录才请推荐」之间做决定；这个判断
   * 如果走 account() 就变成一次额外的上游往返，正好花掉我们想省的那格风控额度。
   * 会话失效（cookie 过期）由后续请求失败后的 isLoginFailure 兜住，并清掉缓存。
   */
  private hasSession(platform: PlatformId): boolean {
    return Boolean(this.secrets[platform])
  }

  /** 只有这两个平台有会话 cookie；meting 的 secrets 是 HMAC 令牌，不是 cookie。 */
  private sessionCookie(platform: PlatformId): string | undefined {
    if (platform === 'meting') return undefined
    const cookie = this.secrets[platform]
    if (!cookie) return undefined
    return platform === 'qq' && !cookie.includes('=') ? 'qqmusic_session=' + cookie : cookie
  }

  private headers(platform: PlatformId): Record<string, string> {
    const cookie = this.sessionCookie(platform)
    const headers: Record<string, string> = {}
    if (!cookie) return headers
    headers.cookie = cookie
    // QQ：后端明确支持 X-QQ-Session 裸 token，而且这是三条通道里唯一不依赖
    // cookie 解析/签名的。只发 Cookie 头时服务端会回「不认这个会话」（本轮实测）。
    if (platform === 'qq') {
      const token = qqSessionToken(cookie)
      if (token) headers['x-qq-session'] = token
    }
    return headers
  }

  /**
   * 登录诊断用的「服务端现场」：进程状态 + 最近几行 stdout（ApiServer 已脱敏）。
   * MQTT 断开、服务端重启导致二维码会话丢失这类问题，只能从这里看出来。
   */
  private loginServerHint(platform: PlatformId): { server: string; log: string[] } {
    if (this.isBuiltin(platform)) return { server: 'builtin', log: [] }
    const runtime = this.servers.get(platform)?.status()
    if (!runtime) return { server: 'none', log: [] }
    return { server: runtime.state, log: runtime.log.slice(-6) }
  }

  /**
   * 二维码失败原因的人话版。
   *
   * qq-music-api 3.3.3 的 800 带 `failureHint.message`（英文原话）。最常见的一种是
   * 「登录设备数已达上限」（上游码 20279）：二维码本身没问题，扫了也确认了，是 QQ 拒绝
   * 这次登录 —— 软件端没有任何办法绕过，只能让用户去手机端删旧设备。
   */
  private describeQrDetail(detail: string | null | undefined): string | null {
    if (!detail) return null
    if (/device limit|设备.*上限|too many devices/i.test(detail)) {
      return 'QQ 音乐拒绝登录：登录设备数已达上限。请到手机 QQ 音乐 → 设置 → 设备管理 移除一台旧设备，然后再扫一次。'
    }
    if (/rate.?limit|too frequent|频繁/i.test(detail)) {
      return '登录太频繁，服务端要求稍后再试；等十几秒重新获取二维码即可。'
    }
    return detail
  }

  /** cookie 只记名字与长度，值绝不落盘。 */
  private cookieShape(cookie: string | undefined | null): { length: number; names: string[] } {
    const text = cookie ?? ''
    return { length: text.length, names: text.split(';').map(pair => pair.split('=')[0]?.trim()).filter((name): name is string => Boolean(name)) }
  }

  // --- HTTP --------------------------------------------------------------

  /**
   * @param init.timeoutMs 单次请求超时。默认 12s；扫码轮询要单独放宽 ——
   *   微信通道的 /login/qr/check 是长轮询（上游默认最多等 15s），12s 会先
   *   abort 掉，客户端以为失败、服务端却还在跑，重试就会叠在同一个 key 上。
   */
  private async request(
    platform: PlatformId,
    url: string,
    init: { redirect?: 'follow' | 'manual'; timeoutMs?: number } = {}
  ): Promise<Response> {
    this.checkBlocked(platform)
    // 从发起请求这一刻就算「活跃」：节流的排队等待也是这次操作的一部分，
    // 空闲巡检不能因为等 1 秒节流就把服务端判成闲置。
    this.lastActivityAt.set(platform, Date.now())
    return this.throttle(platform).run(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
      this.inFlight.set(platform, (this.inFlight.get(platform) ?? 0) + 1)
      try {
        // 只发请求头：server.js 的 `req.cookies` 来自 Cookie 头，用的是**宽容**解析
        // （按第一个 '=' 切，值里的 '=' 保留）；而 `?cookie=` 会走 cookieToJson 把
        // 带 '=' 的值整条丢掉，并且**覆盖**头里那份更完整的结果。
        let response: Response
        try {
          response = await fetch(url, {
            headers: this.headers(platform),
            signal: controller.signal,
            redirect: init.redirect ?? 'follow'
          })
        } catch (error) {
          // 登录路径的失败必须留现场（打包后没有控制台）：只记路径与错误摘要。
          if (/\/login\//.test(url)) {
            loginDiag('http.error', {
              platform,
              path: new URL(url).pathname,
              message: error instanceof Error ? error.message : String(error),
              timeoutMs: init.timeoutMs ?? REQUEST_TIMEOUT_MS
            })
          }
          throw error
        }
        if (!response.ok && /\/login\//.test(url)) {
          const peek = await response.clone().text().catch(() => '')
          loginDiag('http.status', {
            platform,
            path: new URL(url).pathname,
            status: response.status,
            body: redactSensitiveText(peek.slice(0, 300))
          })
        }
        if (response.status === 429) {
          // QQ 的 429 有两种：登录退避（qrService 的 local-backoff，15 秒级）与真正的风控。
          // 前者绝不能把整个平台拉黑 10 分钟——那会让「登录太频繁」连锁成「什么都查不到」。
          if (platform === 'qq' && /\/login\//.test(url)) {
            const peek = await response.clone().json().catch(() => undefined) as { retryAfterMs?: unknown } | undefined
            const waitSeconds = typeof peek?.retryAfterMs === 'number' && Number.isFinite(peek.retryAfterMs)
              ? Math.max(1, Math.ceil(peek.retryAfterMs / 1000))
              : 15
            throw new Error('QQ 音乐登录太频繁：服务端要求约 ' + waitSeconds + ' 秒后再试。等一会儿重新获取二维码即可。')
          }
          this.block(platform, '上游限流（429），已停止请求以免加重封禁。')
          throw new Error('上游限流（429）：已暂停该平台请求 10 分钟。')
        }
        if (RISK_HTTP_STATUS.has(response.status)) {
          const reason = '上游返回 HTTP ' + response.status + '（疑似风控），已停止该平台全部请求 10 分钟'
          this.block(platform, reason)
          throw new Error(platformSpec(platform).displayName + '：' + reason + '。请稍后再试。')
        }
        return response
      } finally {
        clearTimeout(timer)
        const remaining = (this.inFlight.get(platform) ?? 1) - 1
        if (remaining > 0) this.inFlight.set(platform, remaining)
        else this.inFlight.delete(platform)
      }
    })
  }

  private async json(platform: PlatformId, url: string, timeoutMs?: number): Promise<unknown> {
    const response = await this.request(platform, url, timeoutMs === undefined ? {} : { timeoutMs })
    const text = await response.text()
    if (!response.ok) throw this.describeFailure(platform, response.status, text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new Error(platformSpec(platform).displayName + '服务端返回的不是 JSON（HTTP ' + response.status + '）：' + redactSensitiveText(text.slice(0, 160)))
    }
    this.checkRiskCode(platform, parsed)
    return parsed
  }

  /**
   * 把 -460 一类风控码记录成平台级熔断，并返回给用户看的原因。
   * 熔断状态写在 blocked 表里：之后所有 request 在 checkBlocked 处立刻拒绝，不再打上游。
   */
  private riskBlockReason(platform: PlatformId, code: number): string {
    const reason = '上游风控错误 ' + code + '（Cheating），已停止该平台全部请求 10 分钟'
    this.block(platform, reason)
    return platformSpec(platform).displayName + '：' + reason + '。请稍后再试或更换网络。'
  }

  /** 所有 JSON 平台请求（搜索/歌单/直链/账号）的公共出口：风控码只在这一处判断。 */
  private checkRiskCode(platform: PlatformId, body: unknown): void {
    if (!body || typeof body !== 'object') return
    const record = body as Record<string, unknown>
    const code = Number(record.code ?? record.upstreamCode)
    if (isRiskCode(code)) throw new Error(this.riskBlockReason(platform, code))
  }

  private describeFailure(platform: PlatformId, status: number, text: string): Error {
    // 上游的 login_qr_check 有个 catch 引用未定义变量的 bug：请求被拒时它抛
    // ReferenceError，服务端只回一个空的 404，真正的风控码被吞掉。
    // 所以 404 不能原样透传成"找不到页面"。
    if (status === 404) {
      return new Error(platformSpec(platform).displayName +
        ' 服务端对这个请求返回 404：上游拒绝时会把真实原因吞掉（常见于扫码风控）。' +
        '等 10 秒重试；若一直这样，改用网页登录。')
    }
    let detail = redactSensitiveText(text.slice(0, 200))
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      const code = body.code ?? body.upstreamCode
      const key = body.errorKey ?? body.message
      // 非 2xx 的回包里同样可能带风控码（上游用 400/500 包着 -460）：一样熔断。
      const numericCode = Number(code)
      if (isRiskCode(numericCode)) return new Error(this.riskBlockReason(platform, numericCode))
      if (/20279|device-limit/i.test(text)) {
        return new Error('QQ 音乐：登录设备数已超限（20279）。请到手机 QQ 的「设备管理」里移除不用的设备，再扫码登录。')
      }
      if (/search\.rejected|2001/.test(text)) {
        return new Error('QQ 音乐拒绝了这次搜索（search.rejected）：不登录时搜歌常被上游拒绝，请先扫码登录。')
      }
      detail = [code, key].filter(Boolean).join(' / ') || detail
    } catch { /* 不是 JSON，保留原文 */ }
    const name = platformSpec(platform).displayName
    if (status === 401) return new Error(name + '需要登录（401）。')
    if (status === 422) return new Error(name + '上游没有数据（422）。')
    return new Error(name + '服务端返回 HTTP ' + status + '：' + detail)
  }

  // --- 平台操作 ----------------------------------------------------------

  /**
   * 搜索。offset 是**已拿到的条数**，用于翻页：
   *  - 网易云：cloudsearch 原生支持 offset；
   *  - QQ：服务端每页上限 20，只能按 page 翻；
   *  - Meting：不提供翻页，offset>0 直接回空（如实而不是重复上一页）。
   */
  async search(platform: PlatformId, keyword: string, limit = 30, offset = 0): Promise<StreamingTrack[]> {
    const query = keyword.trim()
    if (!query) return []
    // GD 音乐台：纯 HTTP、无服务端；offset 无意义（上游一次给一页）。
    if (this.isBuiltin(platform)) {
      if (offset > 0) return []
      return this.gd.searchAvailable(query, limit)
    }
    await this.ensureStarted(platform)
    const base = this.base(platform)
    if (platform === 'netease') {
      return netease.mapSearch(await this.json(platform, netease.search(base, query, limit, Math.max(0, offset))))
    }
    if (platform === 'qq') {
      const pageSize = Math.min(20, Math.max(1, limit))
      const page = Math.floor(Math.max(0, offset) / pageSize) + 1
      return qq.mapSearch(await this.json(platform, qq.search(base, query, pageSize, page)))
    }
    if (offset > 0) return []
    // 搜索不需要令牌：meting-api 的文档写明只有 lrc / url / pic 需要鉴权。
    // 多带一个令牌在宽松实现上无害，在严格实现上会被拒——所以不带。
    return meting.mapSearch(await this.json(platform, meting.endpoint(base, this.metingSource(), 'search', query)))
  }

  private metingSource(): MetingSource {
    const provider = this.config.providers.find(item => item.platform === 'meting')
    return provider?.metingSource ?? DEFAULT_METING_SOURCE
  }

  /** 这个平台现在请求哪一档音质（配置里存的，已经过白名单校验）。 */
  private qualityOf(platform: PlatformId): string {
    const configured = this.config.providers.find(item => item.platform === platform)?.quality
    const allowed = platformQualityOptions(platform).map(option => option.value)
    if (configured && allowed.includes(configured)) return configured
    return defaultQualityOf(platform)
  }

  /** 取播放地址。Meting 的 url 走 302，其余两个回 JSON。 */
  async resolvePlay(platform: PlatformId, track: { id: string; title?: string; artist?: string }): Promise<PlayTarget> {
    // GD 音乐台：取链 + 自动换源（netease → joox）；直链是 126.net 的 http(s)，
    // 显式允许明文（与网易云同一条理由：CDN 大量返回 http）。
    if (this.isBuiltin(platform)) {
      const target = await this.gd.resolvePlay(track, this.qualityOf(platform))
      return {
        url: target.url,
        userAgent: DESKTOP_UA,
        // 不再无条件 allowInsecure：只有 GD 白名单 CDN 上的明文 http 才放行（见 gdstudio 的 SSRF 校验）。
        allowInsecure: target.allowInsecure,
        title: track.title ?? target.title,
        artist: track.artist ?? target.artist,
        quality: target.quality ?? undefined
      }
    }
    await this.ensureStarted(platform)
    const base = this.base(platform)
    const quality = this.qualityOf(platform)
    if (platform === 'netease') {
      const url = netease.mapPlayUrl(await this.json(platform, netease.playUrl(base, track.id, quality || 'exhigh')))
      return { url, referer: NET_EASE_REFERER, userAgent: DESKTOP_UA, allowInsecure: true, title: track.title ?? '', artist: track.artist ?? '', quality }
    }
    if (platform === 'qq') {
      const url = qq.mapPlayUrl(await this.json(platform, qq.playUrl(base, track.id, quality || 'best')))
      return { url, referer: QQ_REFERER, userAgent: DESKTOP_UA, allowInsecure: true, title: track.title ?? '', artist: track.artist ?? '', quality }
    }
    const server = this.metingSource()
    const token = this.secrets.meting ? metingToken(this.secrets.meting, server, 'url', track.id) : undefined
    const response = await this.request(platform, meting.endpoint(base, server, 'url', track.id, token), { redirect: 'manual' })
    const location = locationFromRedirect({ location: response.headers.get('location') ?? undefined })
    await response.body?.cancel().catch(() => undefined)
    if (!location) {
      throw new Error('Meting 没有给出跳转地址（HTTP ' + response.status + '）：如果服务端设了 METING_TOKEN，请在设置里填同一个令牌。')
    }
    return { url: location, userAgent: DESKTOP_UA, allowInsecure: true, title: track.title ?? '', artist: track.artist ?? '' }
  }

  async lyrics(platform: PlatformId, track: { id: string }): Promise<{ lrc: string; translation: string; wordLevel: string }> {
    if (this.isBuiltin(platform)) {
      const lyric = await this.gd.lyric(track.id)
      return { lrc: lyric.lrc, translation: lyric.translation, wordLevel: '' }
    }
    await this.ensureStarted(platform)
    const base = this.base(platform)
    if (platform === 'netease') return netease.mapLyric(await this.json(platform, netease.lyric(base, track.id)))
    if (platform === 'qq') {
      const response = await this.request(platform, qq.lyric(base, track.id))
      const text = await response.text()
      if (!response.ok) throw this.describeFailure(platform, response.status, text)
      // 实测：QQ 的 /getLyric 回的是 JSON，LRC 在 response.lyric 里（不是纯文本）。
      // 两种都认：有的部署会直接吐 LRC 文本。
      if (text.trim().startsWith('[')) return { lrc: text, translation: '', wordLevel: '' }
      try {
        const body = JSON.parse(text) as {
          response?: { lyric?: string; trans?: string; retcode?: number }
          data?: { lyric?: string; trans?: string }
        }
        const lrc = body.response?.lyric ?? body.data?.lyric ?? ''
        const translation = body.response?.trans ?? body.data?.trans ?? ''
        if (!lrc) {
          const retcode = body.response?.retcode
          throw new Error('QQ 没有返回歌词' + (retcode !== undefined ? '（retcode=' + retcode + '）' : '') + '。')
        }
        return { lrc, translation, wordLevel: '' }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('QQ 没有返回歌词')) throw error
        throw new Error('QQ 歌词返回了无法识别的格式。')
      }
    }
    const server = this.metingSource()
    const token = this.secrets.meting ? metingToken(this.secrets.meting, server, 'lrc', track.id) : undefined
    const response = await this.request(platform, meting.endpoint(base, server, 'lrc', track.id, token))
    const text = await response.text()
    if (!response.ok) throw this.describeFailure(platform, response.status, text)
    return { lrc: text, translation: '', wordLevel: '' }
  }

  /**
   * 账号收藏（歌曲）。
   *
   * 两个平台的取法不同，但对外都是「给我这个账号收藏的歌」：
   *  - 网易云：/likelist 只回 id，再 /song/detail 批量换歌名（两步都是公开接口）；
   *  - QQ：/user/liked-songs 直接回曲目。
   * 没登录时**不猜**：明确要求先登录，否则用户会以为收藏是空的。
   */
  async likedSongs(platform: PlatformId): Promise<StreamingTrack[]> {
    if (this.isBuiltin(platform)) throw new Error('GD 音乐台没有账号与收藏（免登录第三方源）。')
    if (platform === 'meting') throw new Error('通用源没有账号，也没有收藏。')
    await this.ensureStarted(platform)
    const base = this.requireServer(platform).base()
    if (!base) throw new Error(platformSpec(platform).displayName + '服务端没有在运行。')
    if (!this.secrets[platform]) throw new Error('先登录 ' + platformSpec(platform).displayName + '，收藏要看账号。')
    if (platform === 'netease') {
      const account = await this.account(platform)
      if (!account.uid) throw new Error('还没有读到网易云账号，登录后再试一次。')
      const ids = netease.mapLikedIds(await this.json(platform, netease.likelist(base, account.uid)))
      if (ids.length === 0) return []
      const tracks: StreamingTrack[] = []
      // 分批：一次几百个 id 会把 URL 撑爆，而 /song/detail 支持逗号分隔的批量。
      for (let index = 0; index < ids.length; index += 100) {
        const batch = ids.slice(index, index + 100)
        tracks.push(...netease.mapSongDetail(await this.json(platform, netease.songDetail(base, batch))))
      }
      return tracks
    }
    // 我喜欢：后端支持 offset/limit 分页。一次 100，最多取 500 首（超过这个量级
    // 曲库页也不会一次全渲染，够用且不会把登录后的首批请求拖成十几页）。
    const liked: StreamingTrack[] = []
    for (let offset = 0; offset < 500; offset += 100) {
      const page = qq.mapPlaylistTracks(await this.json(platform, qq.likedSongs(base, 100, offset)))
      liked.push(...page)
      if (page.length < 100) break
    }
    return liked
  }

  /** 歌单搜索：只搜**歌单**，不混歌曲——两者在界面上是两种东西。 */
  async searchPlaylists(platform: PlatformId, keyword: string): Promise<PlatformPlaylist[]> {
    if (this.isBuiltin(platform)) throw new Error('GD 音乐台没有歌单搜索；公开歌单可用歌单 id 直接打开。')
    if (platform === 'meting') throw new Error('通用源只有歌曲搜索，没有歌单。')
    await this.ensureStarted(platform)
    const base = this.requireServer(platform).base()
    if (!base) throw new Error(platformSpec(platform).displayName + '服务端没有在运行。')
    const query = keyword.trim()
    if (!query) return []
    const adapters = platform === 'netease' ? netease : qq
    const reply = await this.json(platform, adapters.searchPlaylists(base, query))
    return adapters.mapSearchPlaylists(reply)
  }

  /**
   * 全局搜索：把**已在运行**的每个源都搜一遍，结果合并后统一返回。
   *
   * 参与哪些源：**用户启用过的**（enabled）或**此刻已在运行的**。只看「在运行」
   * 在按需启动模式下永远为空；而把所有配置了命令的源都拉起来又会让一次全局搜索
   * 顺便启动用户没打算用的 Docker 源。enabled 正是用户「我想要这个源」的意图位。
   * 每个源各自走自己的节流桶，所以这一轮最多多发 3 次上游请求。
   */
  async searchAll(keyword: string, limit = 20): Promise<Array<StreamingTrack & { sourceName: string }>> {
    const query = keyword.trim()
    if (!query) return []
    // 内置 HTTP 源（GD 音乐台）**总是**参与全局搜索：它不需要用户启动任何服务端。
    // 其余平台仍按「用户启用过 / 此刻在运行」的老规则，行为不变。
    const builtin = PLATFORM_SPECS.filter(spec => spec.builtin).map(spec => spec.id)
    const candidates: PlatformId[] = [
      ...builtin,
      ...this.config.providers
        .filter(provider => !platformSpec(provider.platform).builtin && provider.command.trim() &&
          (provider.enabled || this.requireServer(provider.platform).base() !== null))
        .map(provider => provider.platform)
    ]
    if (candidates.length === 0) throw new Error('还没有可用的来源：先在「设置 → 流媒体账户」里启动至少一个服务端。')
    const settled = await Promise.allSettled(candidates.map(async (platform) => {
      // search() 内部会 ensureStarted：按需启动模式下这里就是「第一次操作把服务端拉起来」。
      const list = await this.search(platform, query, limit)
      return list.map(track => ({ ...track, sourceName: platformSpec(platform).displayName }))
    }))
    const merged: Array<StreamingTrack & { sourceName: string }> = []
    const failures: string[] = []
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') merged.push(...result.value)
      else failures.push(platformSpec(candidates[index]!).displayName + '：' + (result.reason instanceof Error ? result.reason.message : String(result.reason)))
    })
    if (merged.length === 0 && failures.length > 0) throw new Error(failures.join('；'))
    return merged.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  }

  /**
   * GD 音乐台「相似歌曲」：优先 Embeat item-to-item；不可用/为空时降级为
   * GD 同歌手/同专辑搜索，并在 degraded/reason 里如实标注。
   */
  async similar(track: { platform?: PlatformId; id?: string; title?: string; artist?: string; album?: string }): Promise<StreamingSimilarResult> {
    return this.gd.similar({ id: track.id, title: track.title, artist: track.artist, album: track.album })
  }

  /** GD 各源可用性（10 分钟缓存；界面/诊断用，不写死哪些源可用）。 */
  async gdSourceStatus(): Promise<GdSourceStatus[]> {
    return this.gd.probeSources()
  }

  /**
   * 取封面。三个源给的形态完全不同：
   *  - 网易云：/song/detail 里 al.picUrl
   *  - Meting：pic 类型是 302 到图片
   *  - QQ：曲目信息里没有可直接用的封面 URL（要 album mid 拼 y.gtimg.cn），
   *    这一版不做猜测，返回 null，下载结果里也就不会声称有封面。
   */
  async coverFor(platform: PlatformId, id: string): Promise<{ data: Uint8Array; mime: string } | null> {
    // 内置 HTTP 源直接走 GD 的 pic 端点（它返回 JSON 里的图片 URL，再由这里下载字节）。
    if (this.isBuiltin(platform)) return this.gd.cover(id)
    // 封面不参与「播放是否成功」，所以失败一律收敛成 null；但它同样是一次真实
    // 平台请求（网易云 /song/detail），必须先 ensureStarted —— 否则空闲停服后
    // 这里会静默返回 null，表现成「下载完成但没有封面」。
    const started = await this.ensureStarted(platform).then(() => true, () => false)
    if (!started) return null
    const base = this.requireServer(platform).base()
    if (!base) return null
    let url: string | null = null
    if (platform === 'netease') {
      const detail = await this.json(platform, base + '/song/detail?ids=' + encodeURIComponent(id))
      const song = (detail as { songs?: Array<Record<string, unknown>> })?.songs?.[0]
      const album = song?.al as Record<string, unknown> | undefined
      url = str(album?.picUrl) || null
    } else if (platform === 'meting') {
      const token = this.secrets.meting ? metingToken(this.secrets.meting, this.metingSource(), 'pic', id) : undefined
      const response = await this.request(platform, meting.endpoint(base, this.metingSource(), 'pic', id, token), { redirect: 'manual' })
      url = locationFromRedirect({ location: response.headers.get('location') ?? undefined })
      await response.body?.cancel().catch(() => undefined)
    }
    if (!url) return null
    const image = await fetch(url, { headers: { 'user-agent': DESKTOP_UA, ...(platform === 'netease' ? { referer: NET_EASE_REFERER } : {}) } })
    if (!image.ok) return null
    const buffer = new Uint8Array(await image.arrayBuffer())
    const mime = (image.headers.get('content-type') ?? 'image/jpeg').split(';')[0]?.trim() || 'image/jpeg'
    return buffer.byteLength > 0 ? { data: buffer, mime } : null
  }

  // --- 账号与歌单 --------------------------------------------------------

  /**
   * 登录核验失败时的诊断输出。只打**结构**，不打凭据本身：
   * 会话名（不是值）、服务端回的账号类型、以及是否有 profile。
   */
  private diagnoseLogin(platform: PlatformId, json: unknown): void {
    const cookie = this.secrets[platform] ?? ''
    const names = cookie.split(';').map(pair => pair.split('=')[0]?.trim()).filter(Boolean)
    const data = (json as { data?: Record<string, unknown> })?.data
    const account = data?.account as Record<string, unknown> | undefined
    const profile = data?.profile as Record<string, unknown> | undefined
    console.log('[streaming] 会话核验失败 platform=' + platform +
      ' 会话长度=' + cookie.length +
      ' 会话项=[' + names.join(',') + ']' +
      ' 服务端 code=' + String(data?.code ?? '?') +
      ' accountType=' + String(account?.type ?? 'null') +
      ' profile=' + (profile ? 'present' : 'null') +
      ' profile键=[' + Object.keys(profile ?? {}).join(',') + ']' +
      ' MUSIC_U=' + (names.includes('MUSIC_U') ? '有' : '无'))
  }

  /** 读当前账号资料。未登录不是错误：返回 signedIn=false，界面据此显示「登录」。 */
  async account(platform: PlatformId): Promise<PlatformAccount> {
    const empty: PlatformAccount = { platform, signedIn: false, uid: null, nickname: null, avatar: null }
    if (this.isBuiltin(platform)) return empty
    if (platform === 'meting') return empty
    // 按需启动：读账号也是「用平台」，先确保服务端在跑；启动失败按未登录返回，
    // 账户状态读不到不该把界面打成错误页。
    const started = await this.ensureStarted(platform).then(() => true, () => false)
    if (!started) return empty
    const base = this.requireServer(platform).base()
    if (!base) return empty
    try {
      const json = platform === 'netease'
        ? await this.json(platform, netease.loginStatus(base))
        : await this.json(platform, qq.loginStatus(base))
      const account = platform === 'netease' ? netease.mapAccount(json) : qq.mapAccount(json)
      // 核验失败时留一条可读诊断：真实的扫码只能由用户完成，出问题时我们必须
      // 能从日志里看出「会话长什么样、服务端怎么回的」，而不是继续猜。
      const data = (json as { data?: Record<string, unknown> })?.data
      loginDiag('account.verify', {
        platform,
        signedIn: account.signedIn,
        nickname: account.nickname ?? null,
        stored: this.cookieShape(this.secrets[platform]),
        serverDataKeys: data ? Object.keys(data) : [],
        serverCode: data?.code ?? null,
        profile: data?.profile ? 'present' : 'null',
        ...this.loginServerHint(platform)
      })
      if (!account.signedIn) this.diagnoseLogin(platform, json)
      this.sessions.set(platform, {
        platform,
        status: account.signedIn ? 'signed-in' : (this.secrets[platform] ? 'expired' : 'signed-out'),
        accountName: account.nickname
      })
      return account
    } catch {
      // 服务端刚起来/接口 401 都走这里：不要把"读不到"说成"未登录"以外的结论。
      return { ...empty, signedIn: !!this.secrets[platform] }
    }
  }

  async playlists(platform: PlatformId): Promise<PlatformPlaylist[]> {
    // GD 音乐台没有「我的歌单」（无登录）；公开歌单按 id 打开，见 playlistTracks。
    if (this.isBuiltin(platform)) return []
    if (platform === 'meting') return []
    // 按需启动：打开歌单也是一次真实平台请求。少了这一步，空闲停服之后
    // 第一次打开歌单会直接撞上「服务端没有在运行」。
    await this.ensureStarted(platform)
    const base = this.base(platform)
    if (platform === 'netease') {
      const account = await this.account('netease')
      if (!account.uid) throw new Error('网易云歌单需要先扫码登录。')
      return netease.mapPlaylists(await this.json(platform, netease.playlists(base, account.uid)))
    }
    return qq.mapPlaylists(await this.json(platform, qq.playlists(base)))
  }

  async playlistTracks(platform: PlatformId, id: string): Promise<StreamingTrack[]> {
    if (this.isBuiltin(platform)) return this.gd.playlistTracks(id)
    if (platform === 'meting') return []
    await this.ensureStarted(platform)
    const base = this.base(platform)
    if (platform === 'netease') {
      return netease.mapPlaylistTracks(await this.json(platform, netease.playlistTracks(base, id)))
    }
    // QQ：先走匿名歌单详情（收藏/分享的歌单完整），读不到（不公开的自建歌单没有 dissname）
    // 再用带凭据的 /user/playlist-detail。顺序与 Folia qqProvider.getPlaylistTracks 一致。
    const detail = qq.mapSongListDetail(await this.json(platform, qq.songListDetail(base, id)))
    if (detail.readable) return detail.tracks
    if (!this.secrets[platform]) {
      throw new Error('这个 QQ 歌单不公开，需要先扫码登录 QQ 音乐才能读取。')
    }
    const owned = qq.mapOwnedPlaylistTracks(await this.json(platform, qq.playlistTracks(base, id)))
    return owned.tracks
  }

  // --- 发现页（PLAN §1.1）-------------------------------------------------

  /**
   * 发现页首屏。
   *
   * 与其它平台方法的最大区别：**永不整体抛错**。四个区块来自四个端点，任何一个
   * 失败都只写进它自己的 error；这样「服务端没起」「未登录」「某一端点上头」都不会
   * 把整页打成错误页（而用户对发现页的期待就是「有几块就有几块」）。
   */
  async discoverHome(platform: PlatformId = 'netease'): Promise<DiscoverHome> {
    return this.discovery.home(discoverPlatformOf(platform))
  }

  /** 榜单详情（网易云的榜单 id 就是歌单 id；QQ 走 /recommend/toplist）。 */
  async discoverToplist(platform: PlatformId, id: unknown): Promise<DiscoverTracksResult> {
    return this.discovery.toplistTracks(discoverPlatformOf(platform), id)
  }

  /** 发现歌单广场（网易云可分类分页；QQ 只有一页推荐歌单）。 */
  async discoverPlaylists(
    platform: PlatformId,
    query: { cat?: unknown; order?: unknown; page?: unknown } = {}
  ): Promise<DiscoverPlaylistsPage> {
    return this.discovery.playlistSquare(discoverPlatformOf(platform), query)
  }

  /** 歌单详情曲目（QQ 走 /getSongListDetail/:disstid）。 */
  async discoverPlaylistTracks(platform: PlatformId, id: unknown): Promise<DiscoverTracksResult> {
    return this.discovery.playlistTracks(discoverPlatformOf(platform), id)
  }

  /**
   * 登出/换账号后必须丢掉发现页缓存：缓存键里带账号指纹，理论上不会串台，
   * 但旧账号的每日推荐留在内存里没有任何意义，还会拖着一份别人不该看到的数据。
   */
  private resetDiscoveryCache(): void {
    this.discovery.reset()
  }

  // --- 扫码登录 ----------------------------------------------------------

  /**
   * 扫码相关的请求走这里：Folia 实测「扫码请求可能被 ECONNRESET / 502」，
   * 而且这类失败重发一次常常就好了。**只对扫码路径重试**——搜索/播放重试会
   * 让风控更难缠，得不偿失。
   */
  private async qrRequest<T>(platform: PlatformId, task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient = /502|ECONNRESET|socket hang up|fetch failed|Failed to fetch/i.test(message)
      if (!transient) throw error
      await new Promise(resolve => setTimeout(resolve, 300))
      return task()
    }
  }

  /**
   * 扫码登录的通道（v6.4）。
   *
   * 以前 QQ 固定用 qqmusic（QQ 音乐 App 扫码）。但「用手机 QQ 扫」和「用微信扫」
   * 在这个服务端上都是独立通道，扫错 App 的唯一表现就是「二维码过期」——
   * 用户没有任何提示。现在：先问服务端支持哪些通道（/login/channels），
   * 由界面让用户选，默认沿用上游默认的 qq（手机 QQ）。
   */
  private qrChannels = new Map<PlatformId, QrChannel[]>()

  private async channelsOf(platform: PlatformId): Promise<QrChannel[]> {
    if (platform !== 'qq') return []
    const cached = this.qrChannels.get(platform)
    if (cached) return cached
    try {
      const json = await this.json(platform, qq.loginChannels(this.base(platform)), 20_000)
      const raw = (json as { data?: { channels?: unknown } })?.data?.channels
      const allowed: QrChannel[] = ['qq', 'wechat', 'qqmusic']
      const channels = Array.isArray(raw)
        ? raw.filter((value): value is QrChannel => typeof value === 'string' && (allowed as string[]).includes(value))
        : []
      if (channels.length > 0) {
        this.qrChannels.set(platform, channels)
        return channels
      }
    } catch {
      // /login/channels 是辅助接口：拿不到就退到三种全给，qrKey 会替我们拒绝不支持的通道。
    }
    const fallback: QrChannel[] = ['qq', 'wechat', 'qqmusic']
    this.qrChannels.set(platform, fallback)
    return fallback
  }

  async qrStart(platform: PlatformId, requested?: QrChannel): Promise<QrTicket> {
    if (this.isBuiltin(platform)) throw new Error('GD 音乐台无需登录（免登录第三方源）。')
    if (platform === 'meting') throw new Error('通用源没有登录态。')
    loginDiag('qr.start', { platform, requested: requested ?? null, ...this.loginServerHint(platform) })
    await this.ensureStarted(platform)
    const base = this.base(platform)
    const adapters = platform === 'netease' ? netease : qq
    const channels = await this.channelsOf(platform)
    // 网易云没有通道概念；QQ 默认 qq（上游默认值），显式传了合法值就用它。
    const channel: QrChannel | undefined = platform === 'netease'
      ? undefined
      : (requested && channels.includes(requested) ? requested : channels.includes('qq') ? 'qq' : channels[0])
    const key = adapters.mapQrKey(await this.qrRequest(platform, () =>
      this.json(platform, channel ? qq.qrKey(base, channel) : netease.qrKey(base), 25_000)))
    const created = adapters.mapQrCreate(await this.qrRequest(platform, () =>
      this.json(platform, adapters.qrCreate(base, key), 25_000)))
    this.qrKeys.set(platform, key)
    this.qrChannelKeys.set(platform, channel)
    this.sessions.set(platform, { platform, status: 'signing-in', accountName: null })
    loginDiag('qr.start.ok', {
      platform,
      channel: channel ?? null,
      channels,
      keyLength: key.length,
      imageLength: (created.image ?? '').length,
      ...this.loginServerHint(platform)
    })
    return { platform, key, image: created.image, url: created.url, state: 'waiting', channels, channel, detail: null }
  }

  /** 当前二维码用的通道（qrPoll 回包与界面文案用）。 */
  private qrChannelKeys = new Map<PlatformId, QrChannel | undefined>()

  /**
   * 网页登录兜底：把从登录窗口拿到的 cookie 存下来，并且**同样先验证再宣布成功**。
   * 判据与扫码完全一致，避免"扫码能用了、网页登录却是假的"两条不同的真相。
   */
  async acceptWebLogin(platform: PlatformId, cookie: string): Promise<PlatformAccount> {
    if (platform === 'qq') {
      // QQ 音乐后端只认扫码发出的不透明会话 token（qqmusic_session）；浏览器 cookie 罐里的
      // QQ 凭证它根本不解析。继续走网页登录只会稳定得到「服务端不认这个会话」。
      throw new Error('QQ 音乐不支持网页登录：请在登录窗口里扫码。' +
        '如果扫码报「登录设备数已达上限」，先到手机 QQ 音乐 → 设置 → 设备管理 移除一台旧设备，再扫一次。')
    }
    const trimmed = cookie.trim()
    loginDiag('web.accept', { platform, captured: this.cookieShape(trimmed) })
    if (!trimmed) throw new Error('登录窗口没有拿到会话 cookie。')
    this.secrets[platform] = normalizeCookie(trimmed)
    loginDiag('web.normalized', { platform, stored: this.cookieShape(this.secrets[platform]) })
    await this.persistSecrets()
    const account = await this.account(platform).catch((error: unknown) => {
      throw new Error('网页登录已拿到 cookie，但读取账号失败：' + (error instanceof Error ? error.message : String(error)))
    })
    if (!account.signedIn) {
      delete this.secrets[platform]
      await this.persistSecrets()
      this.sessions.set(platform, { platform, status: 'signed-out', accountName: null })
      throw new Error('网页登录拿到了 cookie，但服务端不认这个会话。可能登录没走完，或该账号被风控。')
    }
    this.sessions.set(platform, { platform, status: 'signed-in', accountName: account.nickname })
    if (platform === 'netease') this.resetDiscoveryCache()
    return account
  }

  /** 801 等待 / 802 已扫 / 803 成功 / 800 过期（两个服务端同一套数字）。 */
  async qrPoll(platform: PlatformId): Promise<QrTicket & { session: string | null }> {
    const key = this.qrKeys.get(platform)
    if (!key) {
      // 没有进行中的会话不是错误，而是「这一轮已经结束了」（过期、取消，
      // 或刚在别处重新生成过二维码）。抛错会把界面上的「已过期，请重新获取」
      // 换成一条 IPC 栈信息。
      this.sessions.set(platform, { platform, status: 'signed-out', accountName: null })
      return { platform, key: '', image: null, url: null, state: 'expired', session: null }
    }
    // 扫码可能持续几分钟：服务端若因空闲巡检/崩溃停过，轮询要能把它拉回来
    //（qrKeys 非空会让空闲巡检跳过，所以这里只兜底异常停机）。
    await this.ensureStarted(platform)
    const base = this.base(platform)
    const adapters = platform === 'netease' ? netease : qq
    // 扫码 check 的预算是上游定的：微信通道是长轮询（默认最多等 15s），
    // 所以这里必须比普通请求的 12s 更宽，否则客户端先 abort、服务端还在跑。
    const result = adapters.mapQrCheck(await this.qrRequest(platform, () =>
      this.json(platform, adapters.qrCheck(base, key), 25_000)))
    // 801 是正常等待，不写日志（2 秒一条会把文件刷爆）；其余状态都要留现场。
    if (result.code !== 801) {
      loginDiag('qr.poll', {
        platform,
        code: result.code,
        detail: result.detail ?? null,
        keyLength: key.length,
        ...this.loginServerHint(platform)
      })
    }
    if (result.code === 803) {
      this.qrKeys.delete(platform)
      if (!result.cookie) {
        this.sessions.set(platform, { platform, status: 'signed-out', accountName: null })
        throw new Error('扫码已确认，但服务端没有返回会话 cookie。请重试；若反复出现，改用网页登录。')
      }
      this.secrets[platform] = normalizeCookie(result.cookie)
      await this.persistSecrets()
      // ⭐ 803 只说明"用户在手机上点了确认"，不等于这个会话能用。
      // 不验证就宣布登录成功，用户会在下一次搜索/播放才发现没登上，
      // 而且界面上一直显示"已登录"——比直接报错更糟。
      const account = await this.account(platform).catch((error: unknown) => {
        throw new Error('扫码已确认，但读取账号失败：' + (error instanceof Error ? error.message : String(error)))
      })
      if (!account.signedIn) {
        delete this.secrets[platform]
        await this.persistSecrets()
        this.sessions.set(platform, { platform, status: 'signed-out', accountName: null })
        throw new Error('扫码已确认，但服务端不接受这个会话（cookie 未被识别）。重试一次；若仍然失败，改用网页登录。')
      }
      this.sessions.set(platform, { platform, status: 'signed-in', accountName: account.nickname })
      // 扫码登录成功也是「换了账号」：发现页缓存的每日推荐/漫游必须作废，
      // 否则第一次进发现页看到的仍是登录前那份（未登录时根本没有那些区块）。
      if (platform === 'netease') this.resetDiscoveryCache()
      return { platform, key, image: null, url: null, state: 'confirmed', session: result.cookie }
    }
    const channel = this.qrChannelKeys.get(platform)
    const channels = platform === 'qq' ? this.qrChannels.get(platform) ?? [] : []
    if (result.code === 800) {
      this.qrKeys.delete(platform)
      this.qrChannelKeys.delete(platform)
      this.sessions.set(platform, { platform, status: 'signed-out', accountName: null })
      return { platform, key, image: null, url: null, state: 'expired', session: null, channels, channel, detail: this.describeQrDetail(result.detail) }
    }
    if (result.code === 802) {
      return { platform, key, image: null, url: null, state: 'scanned', session: null, channels, channel, detail: null }
    }
    return { platform, key, image: null, url: null, state: 'waiting', session: null, channels, channel, detail: null }
  }
}

export const streamingManager = new StreamingManager()
