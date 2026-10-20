// mock GD 服务 + GD 客户端联调（离线）：六种 types、空数组降级、图片 magic 伪装、
// Range 音频、以及 TWILIGHT_GD_API_BASE 本地回环覆写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockGdServer } from './mock-gdstudio.mjs'
import { GdStudioClient, decodeGdId, resolveGdBaseUrl } from '../src/main/streaming/gdstudio.ts'

const withServer = async (fn) => {
  const mock = await createMockGdServer()
  try {
    const gd = new GdStudioClient({ baseUrl: mock.baseUrl })
    await fn({ mock, gd })
  } finally {
    await mock.close()
  }
}

test('TWILIGHT_GD_API_BASE only opens the loopback exception for an explicit 127.0.0.1 base', () => {
  const previous = process.env.TWILIGHT_GD_API_BASE
  try {
    delete process.env.TWILIGHT_GD_API_BASE
    assert.deepEqual(resolveGdBaseUrl(), { baseUrl: 'https://music-api.gdstudio.xyz/api.php', localTest: false })
    assert.deepEqual(resolveGdBaseUrl('https://mirror.example.com/api.php'), { baseUrl: 'https://mirror.example.com/api.php', localTest: false })
    assert.deepEqual(resolveGdBaseUrl('http://127.0.0.1:51234/'), { baseUrl: 'http://127.0.0.1:51234/', localTest: true })
    process.env.TWILIGHT_GD_API_BASE = 'http://127.0.0.1:43210/'
    assert.deepEqual(resolveGdBaseUrl(), { baseUrl: 'http://127.0.0.1:43210/', localTest: true })
  } finally {
    if (previous === undefined) delete process.env.TWILIGHT_GD_API_BASE
    else process.env.TWILIGHT_GD_API_BASE = previous
  }
})

test('mock GD serves six types; search normalizes artist arrays and keeps source-specific ids', async () => {
  await withServer(async ({ mock, gd }) => {
    const rows = await gd.searchSource('netease', '周杰伦', 5)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].title, '晴天')
    assert.equal(rows[0].artist, '周杰伦')
    const ids = decodeGdId(rows[0].id)
    assert.deepEqual(ids, { source: 'netease', urlId: 'u1001', lyricId: 'l1001', picId: 'p1001' })
    assert.equal(rows[1].artist, '周杰伦 / 方文山', 'multi-artist arrays are joined')
    const joox = await gd.searchSource('joox', '周杰伦', 5)
    assert.equal(joox[0].title, '搁浅')
    assert.equal(decodeGdId(joox[0].id)?.source, 'joox')
    assert.ok(mock.log.some(entry => entry.includes('types=search')))
  })
})

test('mock GD url/lyric/pic/playlist endpoints feed the client, and the pic fixture is a magic-byte spoof', async () => {
  await withServer(async ({ mock, gd }) => {
    const [track] = await gd.searchSource('netease', '周杰伦', 1)
    const target = await gd.resolvePlay(track, 'best')
    assert.equal(target.br, 918)
    assert.equal(target.quality, 'FLAC')
    assert.equal(new URL(target.url).pathname, '/audio/test.wav')
    assert.equal(target.allowInsecure, true, 'loopback mock is plain http, explicitly allowed for this test base')
    const lyric = await gd.lyric(track.id)
    assert.match(lyric.lrc, /mock 歌词/)
    const cover = await gd.cover(track.id)
    assert.equal(cover.mime, 'image/png', 'fixture declares image/jpeg but the bytes are PNG')
    const playlist = await gd.playlistTracks('3778678')
    assert.equal(playlist.length, 3)
    assert.equal(playlist[0].title, '晴天')
    assert.ok(mock.log.some(entry => entry.includes('types=url')))
    assert.ok(mock.log.some(entry => entry.includes('/image/spoof.jpg')))
  })
})

test('the mock embeat fixture returns 200 + [] and the client degrades with a reason', async () => {
  await withServer(async ({ gd }) => {
    const result = await gd.similar({ title: '晴天', artist: '周杰伦' })
    assert.equal(result.degraded, true)
    assert.match(result.reason, /Embeat 没有返回相似曲目/)
    assert.ok(result.items.length >= 1, 'fallback search still returns related tracks')
    assert.ok(result.items.every(item => item.sourceName === 'GD 音乐台'))
  })
})

test('the mock embeat fixture can be switched to ok, which removes the degraded flag', async () => {
  await withServer(async ({ mock, gd }) => {
    const response = await fetch(mock.baseUrl + 'mock/gd-mode', { method: 'POST', body: JSON.stringify({ embeat: 'ok' }) })
    assert.equal(response.status, 200)
    const result = await gd.similar({ title: '晴天', artist: '周杰伦' })
    assert.equal(result.degraded, false)
    assert.equal(result.reason, null)
    assert.equal(result.items[0].sourceName, 'Embeat 相似')
  })
})
