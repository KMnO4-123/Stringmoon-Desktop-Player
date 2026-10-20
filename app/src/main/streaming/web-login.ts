/**
 * 网页登录兜底（参考 Folia 的做法：「扫码通道失效时用户仍有路可走」）。
 *
 * 用**内存分区**打开官方登录页，轮询该分区的 cookie，拿到会话就关窗。
 * 几条纪律：
 *  - 分区名每次唯一且不落盘：登录窗口的 cookie 不该留在磁盘上第二份；
 *  - 导航白名单只放行该平台的域名，避免窗口被带到第三方页面还能拿到 cookie；
 *  - 180 秒超时，用户直接关窗也算结束（不能"看不见但还在等"）；
 *  - 只返回 cookie 字符串，不在这里判定是否成功 —— 由调用方拿它去服务端核验。
 */
import { BrowserWindow, session } from 'electron'
import type { PlatformId } from '@shared/streaming'
import { WEB_LOGIN_SPECS, hasPlatformSessionCookie, isAllowedHost, sessionCookieHeader } from '@shared/web-login'
import { loginDiag } from './login-diagnostics'

export const WEB_LOGIN_TIMEOUT_MS = 180_000

export async function openWebLogin(
  platform: PlatformId,
  parent: BrowserWindow | null
): Promise<string> {
  if (platform === 'meting') throw new Error('通用源没有登录态。')
  if (platform === 'gdstudio') throw new Error('GD 音乐台无需登录（免登录第三方源）。')
  const spec = WEB_LOGIN_SPECS[platform]
  const partition = 'streaming-web-login-' + platform + '-' + Date.now()
  const ses = session.fromPartition(partition, { cache: false })

  const win = new BrowserWindow({
    parent: parent ?? undefined,
    modal: false,
    width: 480,
    height: 760,
    title: (platform === 'netease' ? '网易云' : 'QQ 音乐') + '登录',
    autoHideMenuBar: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true }
  })

  /**
   * 白名单只拦**主框架导航**（resourceType === 'mainFrame'）。
   *
   * 为什么不能拦所有请求：登录页的 CSS/JS/图片大量来自 CDN（网易云是
   * s4.music.126.net，QQ 音乐是 *.gtimg.cn / *.qlogo.cn），把子资源也拦掉 =
   * 页面残缺、按钮都点不到 —— 那正是「网页登录也不行」的直接原因。安全目标只是
   * 「别把窗口导航到第三方」，用主框架判定即可；cookie 也只从这个一次性内存分区读，
   * 窗口关闭就 clearStorageData。
   */
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      if (!/^https?:/i.test(details.url)) return callback({ cancel: false })
      if (details.resourceType !== 'mainFrame') return callback({ cancel: false })
      callback({ cancel: !isAllowedHost(new URL(details.url).hostname, spec.allow) })
    } catch {
      callback({ cancel: false })
    }
  })

  /** 整份 cookie 罐（名字/域/长度写进诊断；值不落日志）。 */
  const readCookies = async (): Promise<Array<{ name: string; value: string; domain?: string }>> => {
    const cookies = await ses.cookies.get({})
    return cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain }))
  }

  /**
   * 判定「登录完成」并拼出给服务端的 Cookie 头。
   *
   * 关键改动（v6.6）：不再把整罐 cookie 直接丢给服务端，而是
   *  - 只认**平台域下**的会话键（p_skey 这类 ptlogin 中间态不算）；
   *  - 按服务端需要的名字挑（uin / qqmusic_key / qm_keyst / musickey …）；
   *  - 检测到会话键后再等 800ms 重读一次 —— 登录跳转落地的 cookie 是分几拍写的，
   *    立刻读会拿到「有 key 但缺 uin」的半套，服务端自然不认。
   */
  const captured = async (): Promise<{ cookie: string | null; names: string[]; waited: boolean }> => {
    const first = await readCookies()
    if (!hasPlatformSessionCookie(first, platform, spec)) return { cookie: null, names: first.map(c => c.name), waited: false }
    await new Promise(resolve => setTimeout(resolve, 800))
    const second = await readCookies()
    const cookie = sessionCookieHeader(second, platform, spec)
    return { cookie: cookie || null, names: second.map(c => c.name), waited: true }
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | null = null
    let capturing = false
    const finish = (error: Error | null, cookie?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      clearTimeout(deadline)
      try { if (!win.isDestroyed()) win.destroy() } catch { /* 已经关了 */ }
      void ses.clearStorageData().catch(() => undefined)
      loginDiag('web.finish', {
        platform,
        ok: !error,
        error: error ? error.message : null,
        cookieLength: (cookie ?? '').length,
        cookieNames: (cookie ?? '').split(';').map(pair => pair.split('=')[0]?.trim()).filter(Boolean)
      })
      if (error) reject(error)
      else resolve(cookie ?? '')
    }
    const deadline = setTimeout(() => finish(new Error('网页登录等待超时（180 秒）。')), WEB_LOGIN_TIMEOUT_MS)
    timer = setInterval(() => {
      if (capturing) return
      capturing = true
      void captured().then(result => {
        capturing = false
        if (result.cookie) {
          loginDiag('web.capture', { platform, names: result.names, grace: result.waited })
          finish(null, result.cookie)
        }
      }).catch(() => { capturing = false })
    }, 600)
    win.on('closed', () => {
      // 用户自己关窗：如果这时已经拿到 cookie 就用它，否则当作取消。
      void captured().then(result => {
        if (result.cookie) finish(null, result.cookie)
        else finish(new Error('登录窗口已关闭。'))
      }).catch(() => finish(new Error('登录窗口已关闭。')))
    })
    void win.loadURL(spec.url).catch(error => finish(new Error('打开登录页失败：' + String(error))))
  })
}
