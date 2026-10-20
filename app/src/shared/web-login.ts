/**
 * 网页登录的纯逻辑（不碰 Electron，可在 Node 里断言）。
 *
 * 白名单是这里唯一有安全含义的部分：它同时决定「登录窗口会不会被带去第三方」
 * 和「拿到 cookie 后算不算登录完成」。放太松会把会话泄给外部页面，
 * 放太紧则登不上 —— 所以两件事都必须有测试钉住。
 */
export interface WebLoginSpec {
  url: string
  allow: string[]
  keys: string[]
}

/**
 * 支持「网页 Cookie 登录」的平台。
 *
 * 只有网易云：它的后端接受浏览器里拿到的 MUSIC_U。
 * QQ 音乐的后端是**不透明会话 token**（扫码 803 才发的 qqmusic_session），
 * 它不解析浏览器 cookie 罐里的 QQ 凭证 —— 上一版把网页登录给 QQ，用户拿到的
 * 永远是「服务端不认这个会话」。Folia 对 QQ 也只做扫码。
 */
export const WEB_LOGIN_PLATFORM_IDS = ['netease'] as const

export function supportsWebLogin(platform: string): boolean {
  return (WEB_LOGIN_PLATFORM_IDS as readonly string[]).includes(platform)
}

export const WEB_LOGIN_SPECS = {
  netease: {
    url: 'https://music.163.com/#/login',
    // 页面自身的样式/脚本在 s4.music.126.net：白名单只管**主框架导航**（见 web-login.ts），
    // 这里仍把 CDN 列全，方便理解「登录页会用到哪些域」。
    allow: ['music.163.com', '163.com', '.163.com', '.music.163.com', '126.com', '.126.com', '.126.net', '126.net'],
    keys: ['MUSIC_U']
  },
  qq: {
    url: 'https://y.qq.com/',
    allow: ['y.qq.com', '.qq.com', 'qq.com', '.y.qq.com', '.gtimg.cn', 'gtimg.cn', '.qlogo.cn'],
    /**
     * 只认**真正的会话 cookie**。
     *
     * 只认**QQ 音乐自己的会话键**：qqmusic_key / qm_keyst / musickey。
     *
     * 两个被删掉的诱饵：
     *  - uin / p_uin：y.qq.com 对未登录访客也下发，窗口会秒关；
     *  - p_skey：ptlogin2.qq.com 在**QQ 登录成功那一刻**就下发（还没完成 y.qq.com
     *    的授权跳转），用它判定同样是「提前关窗 → 服务端不认这个会话」。
     *    这一条就是用户这轮看到的「服务端不认」的直接来源之一。
     */
    keys: ['qqmusic_key', 'qm_keyst', 'musickey']
  }
} as const satisfies Record<'netease' | 'qq', WebLoginSpec>

/**
 * 域名是否被放行。
 *
 * 规则刻意**只有两条**：完全相等，或条目以 '.' 开头表示其后缀匹配。
 * 不做"包含"判断 —— `host.includes('qq.com')` 会放行 evil-qq.com，
 * 这是同类白名单最经典的一个洞。
 */
export function isAllowedHost(host: string, allow: readonly string[]): boolean {
  const target = host.toLowerCase()
  return allow.some(entry => {
    const rule = entry.toLowerCase()
    if (rule.startsWith('.')) {
      const suffix = rule.slice(1)
      return target === suffix || target.endsWith(rule)
    }
    return target === rule
  })
}

/** cookie 列表里是否已经出现了会话键。 */
export function hasSessionCookie(names: readonly string[], keys: readonly string[]): boolean {
  return keys.some(key => names.includes(key))
}
/**
 * 从「整份浏览器 cookie 罐」里挑出该平台真正需要的那几项，拼成一条 Cookie 头。
 *
 * 为什么不能把整个罐子直接丢给服务端：
 *  - 罐子里混着 ptlogin2/graph.qq.com 的登录中间态 cookie（p_skey、ptui_loginuin…），
 *    以及同名不同域的两份 uin，服务端按自己的规则解析时可能取到错的那份；
 *  - 只有平台域下的 cookie 才有意义（防止把别的站点 cookie 带出去）。
 *
 * 规则：名字在白名单里 + domain 落在平台域 + 同名保留更长的那条。
 */
export interface BrowserCookie {
  name: string
  value: string
  domain?: string
}

const PLATFORM_DOMAINS: Record<string, string[]> = {
  netease: ['music.163.com', '163.com', '126.net', '126.com'],
  qq: ['y.qq.com', 'qq.com']
}

/** 除会话键外，服务端解析凭证还需要的补充 cookie（uin / 客户端 key 的伴随项）。 */
const EXTRA_COOKIE_NAMES: Record<string, string[]> = {
  netease: ['MUSIC_U', '__csrf', 'NMTID'],
  qq: ['uin', 'p_uin', 'wxuin', 'wxopenid', 'wxrefresh_token', 'qqmusic_key', 'qm_keyst', 'musickey', 'psrf_musickey_createtime', 'psrf_access_token_expiresAt', 'psrf_qqunionid']
}

function domainOfAudience(domain: string): string {
  return domain.replace(/^\./, '').toLowerCase()
}

function domainMatches(domain: string | undefined, platform: string): boolean {
  if (!domain) return false
  const target = domainOfAudience(domain)
  return (PLATFORM_DOMAINS[platform] ?? []).some(rule => target === rule || target.endsWith('.' + rule))
}

/** 拼 Cookie 头。只保留平台域下的已知名字；同名保留更长值。 */
export function sessionCookieHeader(
  cookies: readonly BrowserCookie[],
  platform: string,
  spec: WebLoginSpec = WEB_LOGIN_SPECS[platform as 'netease' | 'qq']
): string {
  const allowed = new Set([...spec.keys, ...(EXTRA_COOKIE_NAMES[platform] ?? [])])
  const picked = new Map<string, string>()
  for (const cookie of cookies) {
    if (!cookie.name || !allowed.has(cookie.name)) continue
    if (!domainMatches(cookie.domain, platform)) continue
    const previous = picked.get(cookie.name)
    if (!previous || cookie.value.length > previous.length) picked.set(cookie.name, cookie.value)
  }
  return [...picked.entries()].map(([name, value]) => name + '=' + value).join('; ')
}

/** 会话键是否出现了（用于轮询窗口是否登录完成）；可以限定平台域。 */
export function hasPlatformSessionCookie(cookies: readonly BrowserCookie[], platform: string, spec: WebLoginSpec): boolean {
  return cookies.some(cookie => spec.keys.includes(cookie.name) && domainMatches(cookie.domain, platform))
}
