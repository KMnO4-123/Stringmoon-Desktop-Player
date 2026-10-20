/**
 * 平台接入的公共契约（CONTRACT §4.1 / §4.2）。
 *
 * 形态照 Folia 的做法：**用户自备 API 服务端，应用负责拉起**。
 * 所以这里的每种平台都只描述三件事：
 *  1. 默认启动命令（用户可以改，改成什么都行——只要它监听我们给的端口）
 *  2. 端口怎么传（不同服务端的环境变量名不一样，这是实测出来的，不是猜的）
 *  3. 它到底能做什么（登录方式、是否有字级歌词、是否能取播放地址）
 *
 * 三条端口/命令的事实，来源都是各自的官方文档：
 *  - 网易云 @neteasecloudmusicapienhanced/api：PORT
 *  - QQ @yakult-green-tea/qq-music-api：PORT，默认 3200，启动入口 dist/src/app.js
 *  - Meting-API（metowolf，Hono）：HTTP_PORT，路由前缀 /api
 */

export type PlatformId = 'netease' | 'qq' | 'meting' | 'gdstudio'

/** Meting 一个服务端覆盖多个平台，所以它的 sub-source 是参数而不是另一种 provider。 */
export type MetingSource = 'netease' | 'tencent' | 'kugou' | 'baidu' | 'kuwo'

export interface PlatformCapabilities {
  search: boolean
  playUrl: boolean
  lyrics: boolean
  /** 该源**原生**提供字级时间轴（CONTRACT §4.4 的 wordByWord=true 只对这些成立）。 */
  wordLevelLyrics: boolean
  playlists: boolean
}

export interface PlatformSpec {
  id: PlatformId
  displayName: string
  login: 'qr' | 'cookie' | 'none'
  capabilities: PlatformCapabilities
  /** 默认启动命令。$PORT 会在拉起时被替换成实际端口。 */
  defaultCommand: string
  /** 该服务端读取端口的环境变量名。 */
  portEnv: string
  /** 上游文档里的默认端口，仅用于提示，**不会**被使用（端口一律动态分配）。 */
  documentedPort: number
  /** 官方包名，用于在界面上告诉用户"这是哪个服务端"。 */
  pkg: string
  /** 界面上的一句话说明。 */
  note: string
  /**
   * 内置 HTTP 源：没有“服务端进程”，不 spawn、不分配端口、不参与空闲巡检。
   * 目前只有 GD 音乐台（music-api.gdstudio.xyz）。界面据此隐藏启动/停止/命令输入。
   */
  builtin?: boolean
}

export const PLATFORM_SPECS: readonly PlatformSpec[] = [
  {
    id: 'netease',
    displayName: '网易云音乐',
    login: 'qr',
    capabilities: { search: true, playUrl: true, lyrics: true, wordLevelLyrics: true, playlists: true },
    defaultCommand: 'npx -y @neteasecloudmusicapienhanced/api',
    portEnv: 'PORT',
    documentedPort: 3000,
    pkg: '@neteasecloudmusicapienhanced/api',
    note: '扫码登录；带 yv=-1 时返回字级 yrc'
  },
  {
    id: 'qq',
    displayName: 'QQ 音乐',
    login: 'qr',
    capabilities: { search: true, playUrl: true, lyrics: true, wordLevelLyrics: false, playlists: true },
    defaultCommand: 'npx -y @yakult-green-tea/qq-music-api',
    portEnv: 'PORT',
    documentedPort: 3200,
    pkg: '@yakult-green-tea/qq-music-api',
    note: '扫码登录；不登录搜歌常被上游拒绝（502 / search.rejected）'
  },
  {
    id: 'meting',
    displayName: '通用源（Meting）',
    login: 'none',
    capabilities: { search: true, playUrl: true, lyrics: true, wordLevelLyrics: false, playlists: true },
    // ⚠️ meting-api **不是 npm 包**（registry 404）。官方分发方式是 Docker 镜像
    // ghcr.io/metowolf/meting-api；所以默认命令给 Docker，而不是一个会当场失败的 npx。
    // 没有 Docker 的机器：自己部署任何兼容 Meting API 的服务端，把命令改掉即可。
    defaultCommand: 'docker run --rm -e HTTP_PORT=$PORT -p 127.0.0.1:$PORT:$PORT ghcr.io/metowolf/meting-api',
    portEnv: 'HTTP_PORT',
    documentedPort: 80,
    pkg: 'ghcr.io/metowolf/meting-api（Docker）',
    note: '一个服务端覆盖 酷狗 / 酷我 / 百度 / QQ / 网易云；无登录态，取链需要 HMAC 令牌。需要 Docker，或自备兼容 Meting API 的服务端'
  },
  {
    id: 'gdstudio',
    displayName: 'GD 音乐台',
    login: 'none',
    capabilities: { search: true, playUrl: true, lyrics: true, wordLevelLyrics: false, playlists: true },
    builtin: true,
    // 纯 HTTP 第三方源：没有自备服务端进程，所以命令/端口都为空。
    defaultCommand: '',
    portEnv: '',
    documentedPort: 0,
    pkg: 'music-api.gdstudio.xyz',
    note: '第三方音乐台（公共 HTTP API）：免登录搜索/取链/歌词；可用源运行时探测（网易云/JOOX），Embeat 仅作相似推荐，失败会如实降级'
  }
]

export function platformSpec(id: PlatformId): PlatformSpec {
  const spec = PLATFORM_SPECS.find(item => item.id === id)
  if (!spec) throw new Error('unknown platform: ' + id)
  return spec
}

export interface StreamingTrack {
  platform: PlatformId
  /** 该平台的歌曲标识（网易云 id / QQ songmid / Meting id）。 */
  id: string
  title: string
  artist: string
  album: string
  durationMs: number
  /**
   * 封面地址（平台 CDN 的 https 直链）。
   *
   * 为什么是**地址**而不是字节：搜索结果一屏几十条，把封面字节塞进 IPC 会让
   * 「一次搜索」变成「一次批量下载」。界面按需解码，缺图时退回占位字形。
   */
  cover?: string | null
  /**
   * 平台音质档位（界面上那一句「Hi-Res / 无损 / 320k」）。
   *
   * 它是**请求档位**的标签，不是承诺：真实解到的采样率/位深由引擎在 open 之后
   * 上报的 sourceSampleRate / bitDepth 说了算，两者都要显示，否则界面等于替上游吹牛。
   */
  quality?: string | null
}

export interface ProviderConfig {
  platform: PlatformId
  /** 用户自备的启动命令；空串表示"不启用"。 */
  command: string
  enabled: boolean
  /** 仅 Meting：走哪个上游平台。 */
  metingSource?: MetingSource
  /**
   * 取链时请求的音质档位（平台自己的取值域，见 platformQualityOptions）。
   *
   * ⚠️ 它只是**请求**：上游可能因为会员/版权/未登录给出更低的一档。
   * 真正的音质以引擎 open 之后上报的 sourceSampleRate / bitDepth 为准，
   * 界面必须同时显示两者，否则等于替上游吹牛。
   */
  quality?: string
}

export interface QualityOption {
  value: string
  label: string
}

/**
 * 各平台的音质档位。
 *
 * 网易云是 5 档（standard/higher/exhigh/lossless/hires，hires 就是 24bit/192kHz）；
 * QQ 服务端只认 best / flac / 320 / 128 / ape（实测 getMusicPlay 的 quality 参数），
 * **没有 192k 这一档** —— 所以界面上不能给它编一个。
 */
export function platformQualityOptions(platform: PlatformId): QualityOption[] {
  if (platform === 'netease') {
    return [
      { value: 'standard', label: '标准' },
      { value: 'higher', label: '较高' },
      { value: 'exhigh', label: '极高' },
      { value: 'lossless', label: '无损' },
      { value: 'hires', label: 'Hi-Res · 24bit/192kHz' }
    ]
  }
  if (platform === 'qq') {
    return [
      { value: 'best', label: '自动最佳（FLAC → 320 → 128）' },
      { value: 'flac', label: 'FLAC 无损' },
      { value: '320', label: '320 kbps' },
      { value: '128', label: '128 kbps' }
    ]
  }
  if (platform === 'gdstudio') {
    // GD 的 br 参数：不给 = 最高（实测拿到 flac 918k）；给数字 = 该码率（320 → mp3）。
    return [
      { value: 'best', label: '最高（自动 FLAC/320）' },
      { value: '320', label: '320 kbps' },
      { value: '192', label: '192 kbps' },
      { value: '128', label: '128 kbps' }
    ]
  }
  return []
}

export function defaultQualityOf(platform: PlatformId): string {
  if (platform === 'netease') return 'exhigh'
  if (platform === 'qq') return 'best'
  if (platform === 'gdstudio') return 'best'
  return ''
}

/** 档位的显示名；认不出的值原样显示（宁可难看，不要假装它是默认档）。 */
export function qualityLabel(platform: PlatformId, value: string | undefined): string {
  if (!value) return ''
  return platformQualityOptions(platform).find(option => option.value === value)?.label ?? value
}

export interface StreamingConfig {
  version: 1
  providers: ProviderConfig[]
  /**
   * 平台服务端是否**按需启动**（缺省 true）。
   *
   * true：应用启动时不拉起任何平台服务端；第一次真正用到某个平台（搜索/歌单/
   * 取直链/登录）才启动它，空闲 10 分钟再停掉。离线播放时进程表里零 node。
   * false：回退旧行为 —— 启动时把 enabled 的平台全部拉起（见 startEnabled）。
   * 这是一次行为变更，按 CR-023 由 owner 裁定；false 是它的回退开关。
   */
  lazyStart?: boolean
}

export type ServerState = 'stopped' | 'starting' | 'ready' | 'failed'

export interface ProviderRuntime {
  platform: PlatformId
  state: ServerState
  port: number | null
  pid: number | null
  error: string | null
  /** 最近几行服务端输出，便于排查"为什么起不来"。已经过脱敏。 */
  log: string[]
}

export type SessionStatus = 'signed-out' | 'signing-in' | 'signed-in' | 'expired'

/**
 * 会话保活状态（v6）。
 *
 * 为什么要单独一层而不是塞进 SessionStatus：这两件事回答的是不同的问题——
 *   - SessionStatus 回答「用户现在算不算登录着」（由本地凭据 + 登录动作决定）；
 *   - keepAlive 回答「我们最近一次去服务端问过、它认不认这个会话」（由校验动作决定）。
 * 把「网络抖了一下」显示成「掉登录」会让用户白扫一次码；反过来把「服务端明确拒绝」
 * 说成「一切正常」则是骗人。所以分开：error ≠ expired。
 */
export type SessionKeepAliveState =
  /** 还没校验过（刚启动/刚登录，或服务端没在运行）。 */
  | 'idle'
  /** 正在校验（界面可显示「校验中」）。 */
  | 'checking'
  /** 服务端认这个会话（可能同时刚续过期）。 */
  | 'ok'
  /** 服务端明确不认这个会话（cookie 失效/被踢）：需要重新登录。 */
  | 'expired'
  /** 该平台没有续期接口（例如 QQ）；能校验但不能延长。 */
  | 'unsupported'
  /** 校验本身失败（网络/服务端没起/形状不对），不代表会话失效。 */
  | 'error'

export interface PlatformSession {
  platform: PlatformId
  status: SessionStatus
  accountName: string | null
  /**
   * 最近一次保活校验完成的时刻（epoch ms）。null/缺省 = 从未校验过。
   *
   * 放在会话对象里而不是另开一个 IPC：设置页每渲染一次就要同时显示
   * 「登录态」与「上次校验时间」，两个来源会漂移。
   */
  lastVerifiedAt?: number | null
  /** 最近一次校验的结论；缺省按 'idle' 理解（旧主进程回包没有这个字段）。 */
  keepAlive?: SessionKeepAliveState
  /** 给人看的一句话：为什么 expired/error（成功时通常为 null）。 */
  keepAliveNote?: string | null
}

/** 扫码通道（QQ 音乐支持三种；网易云只有一个）。 */
export type QrChannel = 'qqmusic' | 'qq' | 'wechat'

export interface QrTicket {
  platform: PlatformId
  key: string
  /** data: URL；服务端直接给的图片。 */
  image: string | null
  url: string | null
  state: 'waiting' | 'scanned' | 'confirmed' | 'expired'
  /** 本平台服务端声明的可用扫码通道（来自 /login/channels；平台不支持时为空）。 */
  channels?: QrChannel[]
  /** 当前这次二维码用的通道。 */
  channel?: QrChannel
  /**
   * 过期/失败时上游给的具体原因（failureReason / failureHint / message）。
   * 没有它界面只能写「二维码已过期」，用户无法知道是没扫、扫错 App 还是上游拒绝。
   */
  detail?: string | null
}

/** 平台账号信息（登录后由 login/status 读取；不落盘，只用于显示）。 */
export interface PlatformAccount {
  platform: PlatformId
  signedIn: boolean
  uid: string | null
  nickname: string | null
  avatar: string | null
}

/** 平台歌单（本地歌单是另一种形状，见 shared/playlists）。 */
export interface PlatformPlaylist {
  platform: PlatformId
  id: string
  name: string
  trackCount: number
  cover: string | null
}

export interface StreamingStatus {
  config: StreamingConfig
  runtimes: ProviderRuntime[]
  sessions: PlatformSession[]
}

/**
 * GD 音乐台「相似歌曲」结果（Embeat item-to-item 推荐，失败降级为同歌手/同专辑搜索）。
 *
 * degraded 必须如实告诉界面：Embeat 对无鉴权请求可能 4xx/5xx 或返回空数组，
 * 这时我们用的是 GD 自身的相关搜索——结果仍可用，但不是“模型推荐”，不能假装。
 */
export interface StreamingSimilarResult {
  items: Array<StreamingTrack & { sourceName: string }>
  degraded: boolean
  /** 降级原因（中文单层、可展示给用户）；没有降级时 null。 */
  reason: string | null
}

/** GD 音乐台各上游源的可用性（运行时探测、10 分钟缓存；界面如实显示，不写死）。 */
export interface GdSourceStatus {
  source: 'netease' | 'joox'
  ok: boolean
  /** 探测时刻（epoch ms）。 */
  checkedAt: number
  error: string | null
}

export const DEFAULT_METING_SOURCE: MetingSource = 'kugou'

/** 默认配置：三条都用官方默认命令，先不自动启用（拉起服务端要联网装包）。 */
export function defaultStreamingConfig(): StreamingConfig {
  return {
    version: 1,
    // 缺省按需启动：这是用户要的「离线播放时不出现后台服务端进程」。
    lazyStart: true,
    providers: PLATFORM_SPECS.map(spec => ({
      platform: spec.id,
      command: spec.defaultCommand,
      enabled: false,
      quality: defaultQualityOf(spec.id),
      ...(spec.id === 'meting' ? { metingSource: DEFAULT_METING_SOURCE } : {})
    }))
  }
}

/**
 * 引号感知的命令拆分。不去掉引号会让 --path "C:\Program Files\x" 这类命令直接起不来，
 * 而这是用户自备命令最常见的一种写法。
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue }
    if (ch === ' ' || ch === '\t') {
      if (has || current) { parts.push(current); current = ''; has = false }
      continue
    }
    current += ch
  }
  if (has || current) parts.push(current)
  return parts
}

/**
 * 把端口塞进命令：先替换 $PORT 占位符；命令里没写占位符时由调用方另外通过环境变量传。
 * 两种都支持：有些服务端只认环境变量，有些用户习惯写死在命令行里。
 */
export function applyPortPlaceholder(command: string, port: number): string {
  return command.replace(/\$PORT\b/g, String(port))
}

/** 平台会话/授权状态的一句话文案（界面用）。 */
export function sessionLabel(status: SessionStatus): string {
  return status === 'signed-in' ? '已登录' : status === 'signing-in' ? '登录中' : status === 'expired' ? '登录已失效' : '未登录'
}

/**
 * 配置消毒：只接受已知平台，命令长度封顶，Meting 的 sub-source 必须合法。
 *
 * 放在 shared 而不是 manager 里有两个理由：它是纯函数（可以脱离 Electron 测），
 * 而且"什么是一个合法配置"本来就是契约的一部分，不是主进程的私事。
 */
export function sanitizeConfig(raw: unknown): StreamingConfig {
  const fallback = defaultStreamingConfig()
  const input = raw as { providers?: unknown; lazyStart?: unknown } | null
  if (!input || !Array.isArray(input.providers)) return fallback
  const sources: MetingSource[] = ['netease', 'tencent', 'kugou', 'baidu', 'kuwo']
  return {
    version: 1,
    // 只有显式 false 才回退旧行为；缺字段（老配置文件）按缺省 true 处理。
    lazyStart: input.lazyStart === false ? false : true,
    providers: fallback.providers.map((base) => {
      const found = (input.providers as unknown[]).find(item =>
        item && typeof item === 'object' && (item as ProviderConfig).platform === base.platform) as ProviderConfig | undefined
      if (!found) return base
      const allowedQuality = platformQualityOptions(base.platform).map(option => option.value)
      return {
        platform: base.platform,
        command: typeof found.command === 'string' ? found.command.slice(0, 2048) : base.command,
        enabled: found.enabled === true,
        quality: typeof found.quality === 'string' && allowedQuality.includes(found.quality)
          ? found.quality
          : (base.quality ?? defaultQualityOf(base.platform)),
        ...(base.platform === 'meting'
          ? { metingSource: sources.includes(found.metingSource as MetingSource) ? found.metingSource as MetingSource : (base.metingSource ?? DEFAULT_METING_SOURCE) }
          : {})
      }
    })
  }
}


/**
 * 把上游返回的会话串清洗成 **name=value; name2=value2**。
 *
 * 上游（api-enhanced）把响应的 Set-Cookie 数组直接 `join(';')` 塞进 body.cookie，
 * 于是我们拿到的长这样：
 *
 *     MUSIC_U=xxx==; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT;__csrf=deadbeef; Path=/
 *
 * 两个坑：
 *  1. 属性（Path/Expires/HttpOnly…）混在里面；
 *  2. `join(';')` **不带空格**，而服务端的宽容解析器按 `;\s+` 切分，
 *     于是 `GMT;__csrf=…` 整段被并进 Expires 的值里，__csrf 直接消失。
 *
 * 所以这里用正则把所有 `name=value` 抽出来（值里的 '=' 保留），丢掉属性名，
 * 再按 `'; '` 重新拼。带 '=' 填充的值不会因此损坏。
 */
const COOKIE_ATTRIBUTES = new Set([
  'path', 'expires', 'max-age', 'domain', 'secure', 'httponly', 'samesite', 'priority', 'version'
])

export function normalizeCookie(raw: string | null | undefined): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  const pairs: string[] = []
  const seen = new Set<string>()
  // [^;]* 会在分号处停下，所以即使 `;` 后面没有空格也能取到下一对。
  for (const match of text.matchAll(/([A-Za-z0-9_.\-]+)=([^;]*)/g)) {
    const name = match[1]!.trim()
    const value = match[2]!.trim()
    if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue
    if (seen.has(name)) continue
    seen.add(name)
    pairs.push(name + '=' + value)
  }
  return pairs.join('; ')
}

/**
 * QQ 音乐后端的会话是**不透明 token**（qqmusic_session=xxx），不是 QQ 的原始凭证。
 *
 * 三处来源的语义不同，不能混用（Folia 的 qqTransport.ts 也把这条写在注释里）：
 *  - X-QQ-Session 头收的是**裸 token**；
 *  - ?cookie= 收的是整串 qqmusic_session=xxx；
 *  - 浏览器 Cookie 头走 Koa 的 cookies，依赖服务端签名/解析行为，最脆。
 * 我们之前只发 Cookie 头 —— 服务端「不认这个会话」就是从这里来的。现在优先发裸 token 头。
 */
export function qqSessionToken(cookie: string | null | undefined): string {
  const text = (cookie ?? '').trim()
  if (!text) return ''
  for (const entry of text.split(';')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    if (entry.slice(0, separator).trim() === 'qqmusic_session') {
      return entry.slice(separator + 1).trim()
    }
  }
  return ''
}
