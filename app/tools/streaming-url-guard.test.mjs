// 第三方 URL 的 SSRF 防护（P0）：IP 分类、域名解析校验、CDN 白名单、明文 http 例外。
// 纯函数 + 注入 DNS，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { UnsafeUrlError, assertSafeRemoteUrl, classifyIp, hostMatchesSuffix, isBlockedIp } from '../src/main/streaming/url-guard.ts'

const lookupOf = (...addresses) => async () => addresses

test('IPv4 classification covers loopback / private / link-local / multicast / reserved', () => {
  assert.equal(classifyIp('127.0.0.1'), 'loopback')
  assert.equal(classifyIp('127.255.255.254'), 'loopback')
  assert.equal(classifyIp('10.1.2.3'), 'private')
  assert.equal(classifyIp('172.16.0.1'), 'private')
  assert.equal(classifyIp('172.31.255.255'), 'private')
  assert.equal(classifyIp('192.168.1.1'), 'private')
  assert.equal(classifyIp('169.254.169.254'), 'link-local')
  assert.equal(classifyIp('0.0.0.0'), 'reserved')
  assert.equal(classifyIp('100.64.0.1'), 'reserved')
  assert.equal(classifyIp('192.0.2.1'), 'reserved')
  assert.equal(classifyIp('198.18.0.1'), 'reserved')
  assert.equal(classifyIp('203.0.113.9'), 'reserved')
  assert.equal(classifyIp('224.0.0.1'), 'multicast')
  assert.equal(classifyIp('233.252.0.1'), 'multicast')
  assert.equal(classifyIp('240.0.0.1'), 'reserved')
  assert.equal(classifyIp('8.8.8.8'), 'public')
  assert.equal(classifyIp('202.12.34.56'), 'public')
  assert.equal(classifyIp('not-an-ip'), 'invalid')
  assert.equal(classifyIp('999.1.1.1'), 'invalid')
  for (const blocked of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '224.0.0.1', '192.168.0.1']) {
    assert.equal(isBlockedIp(blocked), true, blocked)
  }
  assert.equal(isBlockedIp('8.8.8.8'), false)
})

test('IPv6 classification covers ::1, ULA, link-local, multicast and IPv4-mapped addresses', () => {
  assert.equal(classifyIp('::1'), 'loopback')
  assert.equal(classifyIp('::'), 'reserved')
  assert.equal(classifyIp('fc00::1'), 'private')
  assert.equal(classifyIp('fd12:3456::1'), 'private')
  assert.equal(classifyIp('fe80::1'), 'link-local')
  assert.equal(classifyIp('ff02::1'), 'multicast')
  assert.equal(classifyIp('2001:db8::1'), 'reserved')
  assert.equal(classifyIp('::ffff:127.0.0.1'), 'loopback', 'IPv4-mapped loopback must not slip through')
  assert.equal(classifyIp('::ffff:10.0.0.1'), 'private')
  assert.equal(classifyIp('2606:4700:4700::1111'), 'public')
  assert.equal(classifyIp('::ffff:8.8.8.8'), 'public')
})

test('host suffix matching is boundary-aware (evilmusic.126.net is not in the allowlist)', () => {
  assert.equal(hostMatchesSuffix('m801.music.126.net', ['music.126.net']), true)
  assert.equal(hostMatchesSuffix('music.126.net', ['music.126.net']), true)
  assert.equal(hostMatchesSuffix('M801.Music.126.Net', ['music.126.net']), true)
  assert.equal(hostMatchesSuffix('evilmusic.126.net', ['music.126.net']), false)
  assert.equal(hostMatchesSuffix('music.126.net.evil.com', ['music.126.net']), false)
  assert.equal(hostMatchesSuffix('m801.music.126.net.', ['music.126.net']), true, 'trailing dot is normalized')
  assert.equal(hostMatchesSuffix('m801.music.126.net', ['.music.126.net']), true, 'leading dot in config is tolerated')
})

test('public https URLs pass; plaintext http requires the CDN allowlist', async () => {
  const publicLookup = lookupOf('93.184.216.34')
  const https = await assertSafeRemoteUrl('https://m801.music.126.net/a.flac', { lookup: publicLookup })
  assert.equal(https.url.href, 'https://m801.music.126.net/a.flac')
  assert.equal(https.allowInsecure, false)
  const plain = await assertSafeRemoteUrl('http://m801.music.126.net/a.mp3', { allowedHostSuffixes: ['music.126.net'], lookup: publicLookup })
  assert.equal(plain.allowInsecure, true, 'media proxy needs allowInsecure for plaintext CDN links')
  await assert.rejects(
    assertSafeRemoteUrl('http://example.com/a.mp3', { allowedHostSuffixes: ['music.126.net'], lookup: publicLookup }),
    /白名单|明文 http/
  )
})

test('IP literals and DNS answers pointing at private networks are refused (SSRF)', async () => {
  const cases = [
    ['http://127.0.0.1/a.mp3', '回环'],
    ['http://[::1]/a.mp3', '回环'],
    ['http://10.1.2.3/a.mp3', '私有'],
    ['http://169.254.169.254/latest/meta-data/', '链路本地'],
    ['http://[fd00::1]/a.mp3', '私有']
  ]
  for (const [url, pattern] of cases) {
    // 不传域名白名单：让断言落到「IP 分类」这一层，而不是先被白名单拦掉。
    await assert.rejects(assertSafeRemoteUrl(url, { lookup: lookupOf('93.184.216.34') }), new RegExp(pattern), url)
  }
  // 域名本身合法，但 DNS 解析到内网：同样拒绝（DNS rebinding）。
  await assert.rejects(assertSafeRemoteUrl('https://evil.example.com/a.mp3', { lookup: lookupOf('10.0.0.5') }), /私有/)
  await assert.rejects(assertSafeRemoteUrl('https://evil.example.com/a.mp3', { lookup: lookupOf('93.184.216.34', '127.0.0.1') }), /回环/)
})

test('credentials, non-http protocols and non-allowlisted CDNs are refused', async () => {
  const lookup = lookupOf('93.184.216.34')
  await assert.rejects(assertSafeRemoteUrl('https://user:pass@music.126.net/a.mp3', { lookup }), /用户名/)
  await assert.rejects(assertSafeRemoteUrl('file:///C:/Windows/win.ini', { lookup }), /http\(s\)/)
  await assert.rejects(assertSafeRemoteUrl('javascript:alert(1)', { lookup }), /http\(s\)/)
  await assert.rejects(assertSafeRemoteUrl('https://evil.example.com/a.mp3', { lookup, allowedHostSuffixes: ['music.126.net'] }), /白名单/)
  await assert.rejects(assertSafeRemoteUrl('https://music.126.net/a.mp3', { lookup: async () => { throw new Error('ENOTFOUND') } }), /无法解析/)
  await assert.rejects(assertSafeRemoteUrl('https://music.126.net/a.mp3', { lookup: async () => [] }), /解析不到/)
  assert.ok(new UnsafeUrlError('x') instanceof Error)
})
