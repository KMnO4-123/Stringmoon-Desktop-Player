import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WEB_LOGIN_SPECS, hasPlatformSessionCookie, hasSessionCookie, isAllowedHost, sessionCookieHeader } from '../src/shared/web-login.ts'

test('allow list matches exact hosts and dot-prefixed suffixes only', () => {
  assert.equal(isAllowedHost('music.163.com', WEB_LOGIN_SPECS.netease.allow), true)
  assert.equal(isAllowedHost('y.qq.com', WEB_LOGIN_SPECS.qq.allow), true)
  assert.equal(isAllowedHost('music.qq.com', WEB_LOGIN_SPECS.qq.allow), true)
  // 后缀匹配必须是完整标签，不能是"包含"
  assert.equal(isAllowedHost('evil-qq.com', WEB_LOGIN_SPECS.qq.allow), false)
  assert.equal(isAllowedHost('qq.com.evil.example', WEB_LOGIN_SPECS.qq.allow), false)
  assert.equal(isAllowedHost('music.163.com.evil.example', WEB_LOGIN_SPECS.netease.allow), false)
  assert.equal(isAllowedHost('example.com', WEB_LOGIN_SPECS.netease.allow), false)
})

test('session is only considered complete when a known cookie key appears', () => {
  assert.equal(hasSessionCookie(['MUSIC_U'], WEB_LOGIN_SPECS.netease.keys), true)
  assert.equal(hasSessionCookie(['NMTID', '__csrf'], WEB_LOGIN_SPECS.netease.keys), false)
  assert.equal(hasSessionCookie(['qqmusic_key'], WEB_LOGIN_SPECS.qq.keys), true)
  assert.equal(hasSessionCookie(['ptui_loginuin'], WEB_LOGIN_SPECS.qq.keys), false)
  // v6.4：'uin' 对未登录访客也会下发 —— 把它当会话键会让登录窗口一秒内就关掉，
  // 随后服务端不认这个会话（用户看到「网页登录没反应」）。这条钉住这个回归。
  assert.equal(hasSessionCookie(['uin', 'p_uin', 'ptui_loginuin'], WEB_LOGIN_SPECS.qq.keys), false)
  assert.equal(hasSessionCookie(['musickey'], WEB_LOGIN_SPECS.qq.keys), true)
  // 登录页样式来自 s4.music.126.net：主框架白名单也应当放行这个 CDN 域。
  assert.equal(isAllowedHost('s4.music.126.net', WEB_LOGIN_SPECS.netease.allow), true)
})

test('p_skey is not a session key (it appears before the music-site authorization lands)', () => {
  // ptlogin2.qq.com 在 QQ 登录成功的瞬间就下发 p_skey，此时 y.qq.com 的会话还没建立；
  // 用它判定完成会在窗口里「提前关窗」，服务端随后不认 —— 用户看到「服务端不认」。
  assert.equal(hasSessionCookie(['p_skey'], WEB_LOGIN_SPECS.qq.keys), false)
  const cookies = [
    { name: 'p_skey', value: 'x', domain: '.ptlogin2.qq.com' },
    { name: 'uin', value: 'o123', domain: 'y.qq.com' }
  ]
  assert.equal(hasPlatformSessionCookie(cookies, 'qq', WEB_LOGIN_SPECS.qq), false)
})

test('the captured cookie header keeps only platform-domain auth cookies and dedupes by name', () => {
  const cookies = [
    { name: 'uin', value: 'o1', domain: 'y.qq.com' },
    { name: 'uin', value: 'o0123', domain: '.qq.com' },
    { name: 'qqmusic_key', value: 'K1', domain: 'y.qq.com' },
    { name: 'qm_keyst', value: 'K2', domain: 'y.qq.com' },
    { name: 'p_skey', value: 'secret', domain: '.qq.com' },
    { name: 'ptui_loginuin', value: 'o1', domain: '.qq.com' },
    { name: 'MUSIC_U', value: 'netease-only', domain: '.music.163.com' },
    { name: 'uin', value: 'evil', domain: 'evil.example.com' }
  ]
  const header = sessionCookieHeader(cookies, 'qq', WEB_LOGIN_SPECS.qq)
  assert.match(header, /(^|; )uin=o0123(;|$)/, '同名保留更长的那份（跨域那份 uin=o1 被淘汰）')
  assert.match(header, /qqmusic_key=K1/)
  assert.match(header, /qm_keyst=K2/)
  assert.doesNotMatch(header, /p_skey/)
  assert.doesNotMatch(header, /ptui_loginuin/)
  assert.doesNotMatch(header, /MUSIC_U/)
  assert.doesNotMatch(header, /evil/)
  // 网易云：只留 163/126 域
  const netease = sessionCookieHeader([
    { name: 'MUSIC_U', value: 'U1', domain: '.music.163.com' },
    { name: 'MUSIC_U', value: 'U2', domain: '.example.com' },
    { name: '__csrf', value: 'c1', domain: '.music.163.com' }
  ], 'netease', WEB_LOGIN_SPECS.netease)
  assert.match(netease, /MUSIC_U=U1/)
  assert.doesNotMatch(netease, /U2/)
  assert.match(netease, /__csrf=c1/)
})

test('each platform has a login url on an allowed host', () => {
  for (const [platform, spec] of Object.entries(WEB_LOGIN_SPECS)) {
    const host = new URL(spec.url).hostname
    assert.equal(isAllowedHost(host, spec.allow), true, platform + ' login url must be reachable')
  }
})
