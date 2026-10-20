// GD 音乐台 / Embeat 接入（v3 §1.3）：形状归一化、换源、缓存、超时、降级。
//
// 全部不联网：fetch/now 都是注入的假实现；真实联网冒烟另跑一次并留证据。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GdError,
  GdStudioClient,
  decodeGdId,
  encodeGdId,
  mapLyric,
  mapPicUrl,
  mapPlaylistTracks,
  mapPlayUrl,
  mapSearchRows,
  qualityFromBr
} from '../src/main/streaming/gdstudio.ts'
import { StreamingManager } from '../src/main/streaming/manager.ts'

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
})

const SEARCH_NETEASE = [{
  id: '509781655', name: '晴天', artist: ['周杰伦'], album: '叶惠美',
  pic_id: 'p1', url_id: 'u1', lyric_id: 'l1', source: 'netease', from: 'music.gdstudio.xyz'
}]
const SEARCH_JOOX = [{
  id: 'J1==', name: '晴天', artist: ['周傑倫'], album: '葉惠美',
  pic_id: 'jp1', url_id: 'ju1', lyric_id: 'jl1', source: 'joox', from: 'music.gdstudio.xyz'
}]
const FLAC_URL = { url: 'https://m801.music.126.net/a.flac', br: 918, size: 27401646, from: 'music.gdstudio.xyz' }
const MP3_URL = { url: 'https://m801.music.126.net/b.mp3', br: 320, size: 9550125, from: 'music.gdstudio.xyz' }
const PLAYLIST = { code: 200, playlist: { name: '热歌榜', tracks: [
  { id: 186016, name: '夜曲', ar: [{ name: '周杰伦' }], al: { name: '十一月的萧邦', picUrl: 'http://p1.music.126.net/x.jpg' }, dt: 226000 }
] } }
const PIC_BODY = { url: 'https://p2.music.126.net/p.jpg' }

/** 按 types/source 路由的假 fetch；记录调用顺序与并发峰值。图片请求用 'image' 键。 */
function routeFetch(table, options = {}) {
  const calls = []
  let active = 0
  let maxActive = 0
  const fetchImpl = async (url, init) => {
    calls.push(url)
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      const parsed = new URL(url)
      const types = parsed.searchParams.get('types')
      const source = parsed.searchParams.get('source')
      const handler = parsed.searchParams.has('types')
        ? (table[types + '|' + source] ?? table[types])
        : table.image
      if (!handler) throw new Error('unexpected request: ' + types + '|' + source)
      const value = typeof handler === 'function' ? await handler(parsed, init) : handler
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      return value instanceof Response ? value : jsonResponse(value)
    } finally {
      active -= 1
    }
  }
  return { fetchImpl, calls, stats: () => ({ maxActive }) }
}

const expectRejects = async (promise, pattern, label) => {
  try {
    await promise
    assert.fail(label + ' should reject')
  } catch (error) {
    assert.ok(error instanceof Error, label + ' rejects with an Error')
    assert.match(error.message, pattern, label + ' message: ' + error.message)
    assert.ok(!error.message.includes('\n'), label + ' is a single line')
    return error
  }
}

// ---- 纯函数 ---------------------------------------------------------------

test('search rows normalize artist[] to a string and pack the three sub-ids into an opaque track id', () => {
  const [track] = mapSearchRows(SEARCH_NETEASE, 'netease')
  assert.equal(track.platform, 'gdstudio')
  assert.equal(track.artist, '周杰伦')
  assert.equal(track.title, '晴天')
  assert.equal(track.album, '叶惠美')
  assert.equal(track.durationMs, 0, 'GD search does not return duration')
  assert.equal(track.cover, null, 'pic needs another request; do not fake a cover URL')
  assert.deepEqual(decodeGdId(track.id), { source: 'netease', urlId: 'u1', lyricId: 'l1', picId: 'p1' })
  const [multi] = mapSearchRows([{ ...SEARCH_NETEASE[0], artist: ['周杰伦', '李硕'] }], 'netease')
  assert.equal(multi.artist, '周杰伦 / 李硕')
})

test('opaque gd ids round-trip joox ids that contain = / + / characters', () => {
  const ids = { source: 'joox', urlId: 'Ii1l6fZ4vC6rURvKJV_TfQ==', lyricId: 'a+b/c=', picId: '0aac' }
  const encoded = encodeGdId(ids)
  assert.ok(encoded.startsWith('gd:'))
  assert.deepEqual(decodeGdId(encoded), ids)
  for (const bad of ['', 'gd:', 'gd:a|b|c', 'not-gd|a|b|c', 'gd:a|b|c|d|e']) {
    assert.equal(decodeGdId(bad), null, bad)
  }
})

test('play url mapping reports the real br, and an empty url is a business result with a readable reason', () => {
  assert.deepEqual(mapPlayUrl(FLAC_URL, 'netease'), { url: 'https://m801.music.126.net/a.flac', br: 918, size: 27401646 })
  assert.throws(() => mapPlayUrl({ url: '', br: -1, size: 0 }, 'joox'), (error) => {
    assert.ok(error instanceof GdError)
    assert.match(error.message, /没有给出播放地址/)
    assert.match(error.message, /joox/)
    assert.match(error.message, /版权|地区/)
    return true
  })
  assert.throws(() => mapPlayUrl({ url: 'ftp://x/y' }, 'netease'), /无法识别/)
  assert.equal(qualityFromBr(918), 'FLAC')
  assert.equal(qualityFromBr(320), '320 kbps')
  assert.equal(qualityFromBr(null), null)
})

test('lyric / pic / playlist mapping follows the measured response shapes', () => {
  assert.deepEqual(mapLyric({ lyric: '[00:00]a', tlyric: '翻译', from: 'x' }), { lrc: '[00:00]a', translation: '翻译' })
  assert.equal(mapPicUrl(PIC_BODY), 'https://p2.music.126.net/p.jpg')
  assert.equal(mapPicUrl({ url: 'file:///x' }), null)
  const [track] = mapPlaylistTracks(PLAYLIST)
  assert.equal(track.title, '夜曲')
  assert.equal(track.album, '十一月的萧邦')
  assert.equal(track.durationMs, 226000)
  assert.equal(track.cover, 'https://p1.music.126.net/x.jpg', 'http covers are upgraded to https')
  assert.throws(() => mapPlaylistTracks({ code: 200 }), /playlist\.tracks/)
})

// ---- 请求 / 缓存 / 重试 / 超时 -------------------------------------------

test('search builds the documented query, and identical searches are served from the 10-minute cache', async () => {
  let nowMs = 1000000
  const routed = routeFetch({ 'search|netease': SEARCH_NETEASE })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, now: () => nowMs, cacheTtlMs: 60000 })
  const first = await gd.searchSource('netease', '周杰伦', 5)
  assert.equal(first.length, 1)
  assert.equal(routed.calls.length, 1)
  const url = new URL(routed.calls[0])
  assert.equal(url.searchParams.get('types'), 'search')
  assert.equal(url.searchParams.get('source'), 'netease')
  assert.equal(url.searchParams.get('name'), '周杰伦')
  assert.equal(url.searchParams.get('count'), '5')
  assert.equal(url.searchParams.get('pages'), '1')
  await gd.searchSource('netease', '周杰伦', 5)
  assert.equal(routed.calls.length, 1)
  nowMs += 60001
  await gd.searchSource('netease', '周杰伦', 5)
  assert.equal(routed.calls.length, 2)
})

test('search failover: netease error -> joox; the first source with rows wins', async () => {
  const routed = routeFetch({
    'search|netease': () => jsonResponse({ detail: 'upstream down' }, 500),
    'search|joox': SEARCH_JOOX
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
  const rows = await gd.searchAvailable('晴天', 5)
  assert.equal(rows.length, 1)
  assert.equal(decodeGdId(rows[0].id)?.source, 'joox')
  const sources = routed.calls.map(call => new URL(call).searchParams.get('source'))
  assert.deepEqual(sources, ['netease', 'netease', 'joox'], '5xx is retried once, then the next source is tried')
})

test('a 4xx is not retried (it is a protocol/business answer, not a transient failure)', async () => {
  const routed = routeFetch({ 'search|netease': () => jsonResponse({ detail: 'Value of source is not supported.' }, 400) })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
  const error = await expectRejects(gd.searchSource('netease', 'x'), /HTTP 400/, '4xx')
  assert.match(error.message, /source/)
  assert.equal(routed.calls.length, 1)
})

test('timeouts surface as one readable Chinese line and do not hang', async () => {
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const gd = new GdStudioClient({ fetchImpl: hanging, timeoutMs: 30, retryDelayMs: 0 })
  const startedAt = Date.now()
  const error = await expectRejects(gd.searchSource('netease', 'x'), /超时/, 'timeout')
  assert.equal(error.name, 'GdError')
  assert.ok(Date.now() - startedAt < 2000, 'timeout must fire promptly')
})

test('concurrency stays at or below 2 while several requests are in flight', async () => {
  const routed = routeFetch({ 'search|netease': SEARCH_NETEASE, 'search|joox': SEARCH_JOOX }, { delayMs: 20 })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, concurrency: 2 })
  await Promise.all([
    gd.searchSource('netease', 'a'),
    gd.searchSource('joox', 'b'),
    gd.searchSource('netease', 'c')
  ])
  assert.equal(routed.stats().maxActive, 2)
})

test('logs never contain the request URL/query (future tokens stay out of console)', async () => {
  const routed = routeFetch({ 'search|netease': () => jsonResponse({ detail: 'boom' }, 500) })
  const lines = []
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0, log: line => lines.push(line) })
  await expectRejects(gd.searchSource('netease', '周杰伦'), /boom/, 'logged failure')
  assert.ok(lines.length > 0)
  for (const line of lines) {
    assert.ok(!line.includes('https://'), 'no URL in logs: ' + line)
    assert.ok(!line.includes('name='), 'no query string in logs: ' + line)
  }
})

// ---- 取链换源 / 相似 / 封面 ----------------------------------------------

test('resolvePlay returns the direct flac link with its measured quality', async () => {
  const routed = routeFetch({ 'url|netease': FLAC_URL })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl })
  const track = mapSearchRows(SEARCH_NETEASE, 'netease')[0]
  const target = await gd.resolvePlay(track, 'best')
  assert.equal(target.url, FLAC_URL.url)
  assert.equal(target.br, 918)
  assert.equal(target.source, 'netease')
  assert.equal(target.quality, 'FLAC')
  assert.equal(new URL(routed.calls[0]).searchParams.get('br'), null, 'best means: omit br for the highest quality')
})

test('resolvePlay fails over: netease gives no url -> search joox -> take its url', async () => {
  const routed = routeFetch({
    'url|netease': { url: '', br: -1, size: 0 },
    'search|joox': SEARCH_JOOX,
    'url|joox': MP3_URL
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
  const track = mapSearchRows(SEARCH_NETEASE, 'netease')[0]
  const target = await gd.resolvePlay(track, '320')
  assert.equal(target.source, 'joox')
  assert.equal(target.url, MP3_URL.url)
  assert.equal(target.br, 320)
  assert.equal(target.quality, '320 kbps')
  assert.ok(routed.calls.some(call => new URL(call).searchParams.get('source') === 'joox'))
})

test('resolvePlay reports every attempted source when nothing is playable', async () => {
  const routed = routeFetch({
    'url|netease': { url: '', br: -1, size: 0 },
    'search|joox': [],
    'url|joox': { url: '', br: -1, size: 0 }
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
  const track = mapSearchRows(SEARCH_NETEASE, 'netease')[0]
  const error = await expectRejects(gd.resolvePlay(track, 'best'), /取链失败/, 'all sources failed')
  assert.match(error.message, /netease/)
})

test('similar returns real Embeat rows when available, without the degraded flag', async () => {
  const routed = routeFetch({ embeat_by_track: SEARCH_NETEASE })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl })
  const result = await gd.similar({ id: encodeGdId({ source: 'netease', urlId: 'u1', lyricId: 'l1', picId: 'p1' }), title: '晴天', artist: '周杰伦' })
  assert.equal(result.degraded, false)
  assert.equal(result.reason, null)
  assert.equal(result.items[0].sourceName, 'Embeat 相似')
  const url = new URL(routed.calls[0])
  assert.equal(url.searchParams.get('name'), '晴天')
  assert.equal(url.searchParams.get('artist'), '周杰伦')
})

test('similar degrades to a GD search when Embeat fails, and says so', async () => {
  const routed = routeFetch({
    embeat_by_track: () => jsonResponse({ detail: 'Field name is required.' }, 400),
    'search|netease': [
      ...SEARCH_NETEASE,
      { id: '2', name: '七里香', artist: ['周杰伦'], album: '七里香', pic_id: 'p2', url_id: 'u2', lyric_id: 'l2', source: 'netease' }
    ]
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
  const result = await gd.similar({ title: '晴天', artist: '周杰伦' })
  assert.equal(result.degraded, true)
  assert.match(result.reason, /降级/)
  assert.equal(result.items.length, 1, 'the seed song itself is filtered out of the fallback list')
  assert.equal(result.items[0].title, '七里香')
  assert.equal(result.items[0].sourceName, 'GD 音乐台')
})

test('the fallback search uses the primary artist (multi-artist strings are too specific)', async () => {
  const routed = routeFetch({
    embeat_by_track: [],
    'search|netease': SEARCH_NETEASE
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl })
  const result = await gd.similar({ title: '某现场', artist: '周杰伦 / 李硕 / 张鑫' })
  assert.equal(result.degraded, true)
  const searchCalls = routed.calls.filter(call => new URL(call).searchParams.get('types') === 'search')
  assert.ok(searchCalls.length >= 1)
  assert.equal(new URL(searchCalls[0]).searchParams.get('name'), '周杰伦')
})

test('an empty Embeat array is also treated as unavailable (degraded), not as a success', async () => {
  const routed = routeFetch({ embeat_by_track: [], 'search|netease': SEARCH_NETEASE })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl })
  const result = await gd.similar({ title: '晴天', artist: '周杰伦' })
  assert.equal(result.degraded, true)
  assert.match(result.reason, /没有返回相似曲目/)
})

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

test('lyric and cover use the lyric/pic endpoints with the packed sub-ids', async () => {
  const routed = routeFetch({
    'lyric|netease': { lyric: '[00:00]a', tlyric: '' },
    'pic|netease': PIC_BODY,
    image: () => new Response(JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl })
  const id = encodeGdId({ source: 'netease', urlId: 'u1', lyricId: 'l1', picId: 'p1' })
  assert.deepEqual(await gd.lyric(id), { lrc: '[00:00]a', translation: '' })
  const cover = await gd.cover(id)
  assert.deepEqual(Array.from(cover.data), Array.from(JPEG_BYTES))
  assert.equal(cover.mime, 'image/jpeg', 'mime comes from magic bytes, not from the header')
})

// ---- manager 接线 ---------------------------------------------------------

class FakeGd {
  constructor() { this.calls = [] }
  async searchAvailable(keyword, limit) {
    this.calls.push(['searchAvailable', keyword, limit])
    return mapSearchRows(SEARCH_NETEASE, 'netease')
  }
  async searchSource(source, keyword) { this.calls.push(['searchSource', source, keyword]); return [] }
  async resolvePlay(track, quality) {
    this.calls.push(['resolvePlay', track, quality])
    return { url: FLAC_URL.url, br: 918, size: FLAC_URL.size, source: 'netease', quality: 'FLAC', title: track.title ?? '', artist: track.artist ?? '', allowInsecure: false }
  }
  async lyric(id) { this.calls.push(['lyric', id]); return { lrc: '[00:00]a', translation: '' } }
  async cover(id) { this.calls.push(['cover', id]); return { data: new Uint8Array([9]), mime: 'image/png' } }
  async playlistTracks(id) { this.calls.push(['playlistTracks', id]); return mapSearchRows(SEARCH_NETEASE, 'netease') }
  async similar(track) { this.calls.push(['similar', track]); return { items: [], degraded: true, reason: '降级' } }
  async probeSources() { return [{ source: 'netease', ok: true, checkedAt: 1, error: null }] }
}

test('manager routes gdstudio through the builtin HTTP client (no server process, no spawn)', async () => {
  const fake = new FakeGd()
  const manager = new StreamingManager({ gd: fake })
  const gdRuntime = manager.runtimes().find(runtime => runtime.platform === 'gdstudio')
  assert.deepEqual({ state: gdRuntime.state, port: gdRuntime.port, pid: gdRuntime.pid }, { state: 'ready', port: null, pid: null })
  assert.equal((await manager.start('gdstudio')).state, 'ready')
  await manager.ensureStarted('gdstudio')

  const all = await manager.searchAll('晴天', 5)
  assert.equal(all.length, 1)
  assert.equal(all[0].platform, 'gdstudio')
  assert.equal(all[0].sourceName, 'GD 音乐台')
  assert.deepEqual(fake.calls.find(call => call[0] === 'searchAvailable'), ['searchAvailable', '晴天', 5])
  assert.deepEqual(await manager.search('gdstudio', '晴天', 5, 20), [], 'gd has no offset paging')

  const target = await manager.resolvePlay('gdstudio', { id: all[0].id, title: '晴天', artist: '周杰伦' })
  assert.equal(target.allowInsecure, false, 'https CDN links do not opt into plaintext')
  assert.equal(target.quality, 'FLAC')

  assert.deepEqual(await manager.lyrics('gdstudio', { id: all[0].id }), { lrc: '[00:00]a', translation: '', wordLevel: '' })
  const cover = await manager.coverFor('gdstudio', all[0].id)
  assert.equal(cover.mime, 'image/png')
  assert.equal((await manager.playlistTracks('gdstudio', '3778678')).length, 1)
  assert.equal((await manager.playlists('gdstudio')).length, 0)
  assert.equal((await manager.account('gdstudio')).signedIn, false)
  assert.equal((await manager.similar({ id: all[0].id, title: '晴天' })).degraded, true)
  assert.equal((await manager.gdSourceStatus())[0].ok, true)

  await expectRejects(manager.likedSongs('gdstudio'), /没有账号/, 'likedSongs')
  await expectRejects(manager.searchPlaylists('gdstudio', 'x'), /歌单搜索/, 'searchPlaylists')
  await expectRejects(manager.qrStart('gdstudio'), /无需登录/, 'qrStart')
})
// ---- P0 安全：SSRF / CDN 白名单 / 重定向复验 / 429 / 缓存 TTL -----------------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

test('resolvePlay rejects loopback / private / link-local CDN urls (SSRF protection)', async () => {
  const cases = [
    { url: 'http://127.0.0.1:8080/a.mp3', label: 'loopback IPv4' },
    { url: 'http://10.1.2.3/a.mp3', label: 'private IPv4' },
    { url: 'http://169.254.169.254/latest/meta-data/', label: 'link-local metadata' },
    { url: 'http://[::1]/a.mp3', label: 'loopback IPv6' },
    { url: 'http://[fd00::1]/a.mp3', label: 'unique-local IPv6' },
    { url: 'http://music.126.net/a.mp3', label: 'plain http on a whitelisted CDN is allowed later, but not for this test' }
  ]
  for (const item of cases.slice(0, 5)) {
    const routed = routeFetch({ 'url|netease': { url: item.url, br: 320, size: 1 } })
    const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
    const track = mapSearchRows(SEARCH_NETEASE, 'netease')[0]
    const error = await expectRejects(gd.resolvePlay(track, '320'), /取链失败/, item.label)
    assert.match(error.message, /SSRF|白名单|回环|私有|链路本地|拒绝/, item.label + ': ' + error.message)
  }
  // 明文 http 仅在白名单 CDN 上放行：此时 allowInsecure 必须为 true（媒体代理需要）。
  const allowed = routeFetch({ 'url|netease': { url: 'http://m801.music.126.net/a.mp3', br: 320, size: 1 } })
  const gd = new GdStudioClient({ fetchImpl: allowed.fetchImpl })
  const target = await gd.resolvePlay(mapSearchRows(SEARCH_NETEASE, 'netease')[0], '320')
  assert.equal(target.allowInsecure, true)
  assert.equal(new URL(target.url).protocol, 'http:')
})

test('resolvePlay rejects a non-whitelisted domain even if it resolves to a public IP', async () => {
  const routed = routeFetch({ 'url|netease': { url: 'https://evil.example.com/a.mp3', br: 320, size: 1 } })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl })
  const error = await expectRejects(gd.resolvePlay(mapSearchRows(SEARCH_NETEASE, 'netease')[0], '320'), /取链失败/, 'non-whitelisted')
  assert.match(error.message, /CDN 域名白名单/)
})

test('every redirect hop is re-validated: a public CDN redirect to a private IP is refused', async () => {
  const routed = routeFetch({
    'search|netease': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } })
  })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0 })
  const error = await expectRejects(gd.searchSource('netease', '周杰伦'), /SSRF|拒绝|白名单|明文 http/, 'redirect to loopback')
  assert.match(error.message, /回环|loopback|SSRF|拒绝|白名单|明文/)
  assert.equal(routed.calls.length, 1, 'the redirect target is never requested')
})

test('a safe redirect chain to another public host is followed and parsed', async () => {
  let hop = 0
  const routed = routeFetch({
    'search|netease': () => {
      hop += 1
      if (hop === 1) return new Response(null, { status: 302, headers: { location: 'https://mirror.music.126.net/api.php?types=search' } })
      return jsonResponse(SEARCH_NETEASE)
    },
    // 重定向后的 URL 没有 source 参数：同一份假响应兜底。
    'search|null': SEARCH_NETEASE
  })
  const gd = new GdStudioClient({
    fetchImpl: routed.fetchImpl,
    lookup: async () => ['93.184.216.34']
  })
  const rows = await gd.searchSource('netease', '周杰伦')
  assert.equal(rows.length, 1)
  assert.equal(routed.calls.length, 2)
})

test('play urls are cached for 60s only (signed links expire), not the 10-minute default', async () => {
  let nowMs = 5_000_000
  const routed = routeFetch({ 'url|netease': FLAC_URL })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, now: () => nowMs, cacheTtlMs: 600_000 })
  const track = mapSearchRows(SEARCH_NETEASE, 'netease')[0]
  await gd.resolvePlay(track, 'best')
  const urlCalls = routed.calls.filter(call => new URL(call).searchParams.get('types') === 'url')
  assert.equal(urlCalls.length, 1)
  await gd.resolvePlay(track, 'best')
  assert.equal(routed.calls.filter(call => new URL(call).searchParams.get('types') === 'url').length, 1, 'hit within 60s')
  nowMs += 60_001
  await gd.resolvePlay(track, 'best')
  assert.equal(routed.calls.filter(call => new URL(call).searchParams.get('types') === 'url').length, 2, 'expired after 60s')
})

test('a 429 cools the source down instead of hammering it', async () => {
  const routed = routeFetch({ 'url|netease': () => jsonResponse({ detail: 'rate limited' }, 429) })
  const gd = new GdStudioClient({ fetchImpl: routed.fetchImpl, retryDelayMs: 0, rateLimitCooldownMs: 60_000 })
  const track = mapSearchRows(SEARCH_NETEASE, 'netease')[0]
  const directOnly = { id: track.id }
  const error = await expectRejects(gd.resolvePlay(directOnly, '320'), /限流/, '429')
  const callsAfterFirst = routed.calls.length
  assert.equal(callsAfterFirst, 1, '429 is not retried')
  const second = await expectRejects(gd.resolvePlay(directOnly, '320'), /限流冷却/, 'cooling')
  assert.match(second.message, /限流冷却/)
  assert.equal(routed.calls.length, callsAfterFirst, 'no upstream request during the cooldown')
})

test('cover rejects oversized bodies, non-image content types and bad magic bytes', async () => {
  const makePic = (imageFactory) => new GdStudioClient({
    fetchImpl: routeFetch({
      'pic|netease': PIC_BODY,
      image: imageFactory
    }).fetchImpl,
    imageMaxBytes: 64
  })
  const id = encodeGdId({ source: 'netease', urlId: 'u1', lyricId: 'l1', picId: 'p1' })

  const oversized = makePic(() => new Response(new Uint8Array(200).fill(0xff), { headers: { 'content-type': 'image/jpeg' } }))
  assert.equal(await oversized.cover(id), null, 'streamed limit aborts oversized images')

  const html = makePic(() => new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } }))
  assert.equal(await html.cover(id), null, 'content-type must be image/*')

  const fakeMagic = makePic(() => new Response(new Uint8Array([1, 2, 3, 4]).fill(0x41), { headers: { 'content-type': 'image/jpeg' } }))
  assert.equal(await fakeMagic.cover(id), null, 'magic bytes decide the real format')

  const png = makePic(() => new Response(PNG_BYTES, { headers: { 'content-type': 'image/jpeg' } }))
  const cover = await png.cover(id)
  assert.equal(cover.mime, 'image/png', 'mime comes from magic bytes, not the (wrong) header')
})

test('cover refuses a redirect that leaves the CDN allowlist', async () => {
  const gd = new GdStudioClient({
    fetchImpl: routeFetch({
      'pic|netease': PIC_BODY,
      image: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/x.jpg' } })
    }).fetchImpl
  })
  const id = encodeGdId({ source: 'netease', urlId: 'u1', lyricId: 'l1', picId: 'p1' })
  assert.equal(await gd.cover(id), null)
})

test('GD is refused by the download manager (stream-only third-party source)', async () => {
  const { DownloadManager } = await import('../src/main/downloads.ts')
  const manager = new DownloadManager({
    resolvePlay: async () => ({ url: 'https://x/a.mp3' }),
    lyrics: async () => ({ lrc: '', translation: '' }),
    cover: async () => null
  })
  assert.throws(() => manager.enqueue({ platform: 'gdstudio', id: 'gd:x', title: 't', artist: 'a', album: '', durationMs: 0 }), /不支持下载/)
})

