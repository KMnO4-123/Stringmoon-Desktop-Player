import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const online = await import('../src/main/lyrics-online.ts')
const cache = await import('../src/main/lyrics-cache.ts')
const { deriveTrackIdentity } = await import('../src/shared/track-identity.ts')

const ttml = readFileSync(new URL('../fixtures/lyrics/amll-real.ttml', import.meta.url), 'utf8')
const track = { trackId: 't1', title: 'テスト曲', artist: 'TestBand', album: 'THE BOOK 3', durationMs: 213233, path: 'C:/music/テスト曲.flac' }

const jsonResponse = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) })
const textResponse = (value) => ({ ok: true, status: 200, json: async () => JSON.parse(value), text: async () => value })
const failResponse = (status) => ({ ok: false, status, json: async () => null, text: async () => '' })

beforeEach(() => online.resetOnlineStateForTests())

test('scoring accepts the exact record and refuses a different version of it', () => {
  const identity = deriveTrackIdentity({ title: 'テスト曲', artist: 'TestBand', durationMs: 213233 })
  const exact = online.scoreCandidate(identity, { id: '1', title: 'テスト曲', artists: ['TestBand'], durationMs: 213000 })
  assert.equal(exact.risk, 'low')
  assert.ok(exact.score >= 0.9, 'exact title + artist + duration')

  // 同名翻唱：标题一样，但它不是这首歌。风险必须被标出来。
  const cover = online.scoreCandidate(identity, { id: '2', title: 'テスト曲 (Cover)', artists: ['TestBand'], durationMs: 213000 })
  assert.equal(cover.risk, 'high', 'a cover is never a low-risk match')
  assert.ok(cover.reasons.includes('version_conflict'))

  // 完全不同的歌：分数必须低到被拒（宁可没有歌词，也不能显示别人的歌词）。
  const wrong = online.scoreCandidate(identity, { id: '3', title: '全然違う曲', artists: ['別の人'], durationMs: 180000 })
  assert.ok(wrong.score < 0.5)
  assert.ok(wrong.reasons.includes('title_mismatch'))

  // 时长对不上是独立的证据：标题相同也可能选错了版本。
  const concert = online.scoreCandidate(identity, { id: '4', title: 'テスト曲', artists: ['TestBand'], durationMs: 400000 })
  assert.equal(concert.risk, 'high')
})

test('the chain prefers AMLL word-level over netease line-level (contract §4.4)', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 2034742057, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }], album: { name: 'THE BOOK 3' } }] } })
    if (href.includes('amll-ttml-db')) return textResponse(ttml)
    throw new Error('unexpected request ' + href)
  }
  const result = await online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.match.provider, 'amll-ttml')
  assert.equal(result.match.ncmId, '2034742057')
  assert.equal(result.lyrics.source, 'amll-ttml')
  assert.equal(result.lyrics.wordByWord, true)
  assert.ok(result.lyrics.lines[0].translation, 'translation comes with the TTML')
  assert.equal(calls.filter(url => url.includes('/api/song/lyric')).length, 0, 'AMLL won, so netease lyrics were never needed')
})

test('when AMLL has no file for the id, the netease line-level tracks are used instead', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 2034742057, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) return failResponse(404)
    if (href.includes('song/lyric')) {
      return jsonResponse({
        code: 200,
        lrc: { lyric: '[00:01.000]無敵の笑顔' },
        tlyric: { lyric: '[00:01.000]无敌的笑容' },
        romalrc: { lyric: '[00:01.000]mu te ki no e ga o' }
      })
    }
    throw new Error('unexpected request ' + href)
  }
  const result = await online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.match.provider, 'netease')
  assert.equal(result.lyrics.source, 'netease-lrc')
  assert.equal(result.lyrics.wordByWord, false, 'netease gives line level only — never pretend it is word level')
  assert.equal(result.lyrics.lines[0].translation, '无敌的笑容')
  assert.equal(result.lyrics.lines[0].romanization, 'mu te ki no e ga o')
})

test('LRCLIB is the last resort, and only records with a timeline are accepted', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [] } })
    if (href.includes('lrclib.net')) {
      return jsonResponse([
        { id: 1, trackName: 'Hero Theme', artistName: '牛尾憲輔', duration: 100, syncedLyrics: null, plainLyrics: 'untimed words' },
        { id: 2, trackName: 'Hero Theme', artistName: '牛尾憲輔', duration: 100, syncedLyrics: '[00:01.00]timed words', plainLyrics: 'timed words' }
      ])
    }
    throw new Error('unexpected request ' + href)
  }
  const identity = { trackId: 't2', title: 'Hero Theme', artist: '', durationMs: 100500, path: 'C:/music/Hero Theme.flac' }
  const result = await online.fetchOnlineLyrics(identity, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.match.provider, 'lrclib')
  assert.equal(result.lyrics.lines[0].text, 'timed words', 'the record without a timeline was skipped')
})

test('a -460 answer stops the platform for the whole session and is never retried', async () => {
  let hits = 0
  // 只数网易云的请求：被风控之后 LRCLIB 仍然该被尝试（那是**另一个平台**），
  // 但同一个平台连一次都不许再打。
  const fetchImpl = async (url) => {
    if (String(url).includes('music.163.com')) hits++
    return jsonResponse({ code: -460, message: 'Cheating' })
  }
  await assert.rejects(online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} }), /460|风控/)
  assert.equal(hits, 1)
  assert.match(Object.keys(online.blockedPlatforms()).join(','), /netease/)
  // 第二次连 fetch 都不该碰
  await assert.rejects(online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} }))
  assert.equal(hits, 1, 'a blocked platform must not be contacted again')
})

test('netease placeholder text is never shown as lyrics; an instrumental is a conclusion', async () => {
  const run = async (lyricLine) => {
    const fetchImpl = async (url) => {
      const href = String(url)
      if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 29357406, name: 'Hero Theme', duration: 100000, artists: [{ name: '牛尾憲輔' }] }] } })
      if (href.includes('amll-ttml-db')) return failResponse(404)
      if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: lyricLine } })
      if (href.includes('lrclib.net')) return jsonResponse([])
      throw new Error('unexpected ' + href)
    }
    const identity = { trackId: 't3', title: 'Hero Theme', artist: '牛尾憲輔', durationMs: 100000, path: 'C:/music/Hero Theme.flac' }
    return online.fetchOnlineLyrics(identity, { fetchImpl, now: () => 0, sleep: async () => {} })
  }

  // 纯音乐：如实说「这首没有歌词」，并且**不再**去 LRCLIB 找（那只会找到同名的别的歌）。
  const instrumental = await run('[00:00.00]纯音乐，请欣赏')
  assert.equal(instrumental.lyrics, null)
  assert.equal(instrumental.instrumental, true)

  // 曲库没有这首的歌词：也不是歌词，但这不是「纯音乐」结论，允许继续兜底。
  const missing = await run('[00:00.00]暂无歌词')
  assert.equal(missing, null)
})

test('netease word-level yrc is used when the encrypted endpoint returns it', async () => {
  // 真实 yrc（TestSinger《演员》）—— 字偏移是绝对毫秒，与 lrc 的 [00:21.056] 同位置。
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 32507038, name: '演员', duration: 261000, artists: [{ name: 'TestSinger' }] }] } })
    if (href.includes('amll-ttml-db')) return failResponse(404)
    if (href.includes('/weapi/song/lyric')) {
      return jsonResponse({
        code: 200,
        yrc: { lyric: '[21110,1660](21110,370,0)简(21480,340,0)单(21820,950,0)点\n[24860,3170](24860,380,0)说(25240,450,0)话' },
        lrc: { lyric: '[00:21.056]简单点\n[00:24.967]说话' },
        tlyric: { lyric: '[00:21.056]简单点(译)\n[00:24.967]说话(译)' }
      })
    }
    throw new Error('unexpected ' + href)
  }
  const track = { trackId: 'c1', title: '演员', artist: 'TestSinger', durationMs: 261000, path: 'C:/music/演员.flac' }
  const result = await online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.lyrics.source, 'netease-yrc')
  assert.equal(result.lyrics.wordByWord, true, 'yrc is real word-level timing, not interpolation')
  assert.deepEqual(result.lyrics.lines[0].words.map(w => [w.text, w.startMs, w.endMs]), [
    ['简', 21110, 21480], ['单', 21480, 21820], ['点', 21820, 22770]
  ])
  assert.equal(result.lyrics.lines[0].text, '简单点')
  assert.equal(result.lyrics.lines[0].translation, '简单点(译)', 'line-level translation still pairs onto the word-level line')
})

test('if the encrypted endpoint fails, the plain one still yields line-level lyrics', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 42, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) return failResponse(404)
    if (href.includes('/weapi/song/lyric')) throw new Error('connection reset')
    if (href.includes('/api/song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]無敵' }, tlyric: { lyric: '[00:01.000]无敌' } })
    throw new Error('unexpected ' + href)
  }
  const result = await online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.lyrics.source, 'netease-lrc', 'degraded to line level instead of failing')
  assert.equal(result.lyrics.wordByWord, false)
  assert.equal(result.lyrics.lines[0].translation, '无敌')
})

test('a lyric whose timeline contradicts the track is dropped and the chain moves on', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 7, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) return failResponse(404)
    // 网易云这一条明显是别的（更长的）版本：曲目 213 s，歌词却唱到 900 s
    if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]a\n[15:00.000]b' } })
    if (href.includes('lrclib.net')) return jsonResponse([{ id: 9, trackName: 'テスト曲', artistName: 'TestBand', duration: 213, syncedLyrics: '[00:01.00]right one' }])
    throw new Error('unexpected ' + href)
  }
  const result = await online.fetchOnlineLyrics(track, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.match.provider, 'lrclib', 'the contradictory source was skipped, not shown')
  assert.equal(result.lyrics.lines[0].text, 'right one')
})

test('the AMLL attempt is time-budgeted instead of making the user wait on dead mirrors', async () => {
  // 实测：一首歌在 AMLL 库里的概率约 1/14，所以绝大多数时候三跳都是白跑。
  // 预算耗尽就必须放弃这一档，直接退回网易云行级 —— 不能让用户对着空歌词干等。
  const amllCalls = []
  let clock = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 42, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) { amllCalls.push(href); clock += 1400; throw new Error('connection reset') }
    if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]x' } })
    throw new Error('unexpected ' + href)
  }
  const result = await online.fetchOnlineLyrics(track, { fetchImpl, now: () => clock, sleep: async () => {} })
  assert.equal(result.match.provider, 'netease', 'gave up on AMLL and used the line-level source')
  assert.equal(amllCalls.length, 2, 'two dead mirrors is enough; the third is skipped once the budget is gone: ' + amllCalls.join(' , '))
})

test('each AMLL attempt is capped by the remaining budget, and the source is skipped after repeated failures', async () => {
  // 第一版预算只在「两次尝试之间」检查 —— 挂住的请求仍要等满 8 s 超时才回来，
  // 预算形同虚设（实测单曲 9.2 s）。超时必须压进剩余预算里。
  let clock = 0
  const timeoutsSeen = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 42, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) {
      timeoutsSeen.push(init && init.signal ? 'abortable' : 'none')
      // 模拟「挂住直到超时」：超时由 AbortController 触发，这里直接抛错即可。
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]x' } })
    throw new Error('unexpected ' + href)
  }
  const options = { fetchImpl, now: () => clock, sleep: async () => { clock += 700 } }
  await online.fetchOnlineLyrics(track, options)
  assert.ok(timeoutsSeen.length > 0, 'AMLL was attempted')

  // 连续 3 次失败之后进入冷却：下一次连请求都不发。
  online.resetOnlineStateForTests()
  let amllHits = 0
  clock = 0
  const failing = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 42, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) { amllHits++; throw new Error('connection reset') }
    if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]x' } })
    throw new Error('unexpected ' + href)
  }
  const failingOptions = { fetchImpl: failing, now: () => clock, sleep: async () => {} }
  await online.fetchOnlineLyrics(track, failingOptions)
  const afterFirst = amllHits
  await online.fetchOnlineLyrics(track, failingOptions)
  await online.fetchOnlineLyrics(track, failingOptions)
  const beforeCooldown = amllHits
  await online.fetchOnlineLyrics(track, failingOptions)
  assert.equal(amllHits, beforeCooldown, 'after repeated failures the AMLL source is skipped for a while (no new requests)')
  assert.ok(beforeCooldown > afterFirst, 'the later lookups did try before the breaker opened')
})

test('candidates are listed with their scores so the user can pick by hand', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [
      { id: 1, name: 'テスト曲', duration: 180000, artists: [{ name: '別の人' }] },
      { id: 2, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }], album: { name: 'THE BOOK 3' } },
      { id: 3, name: '全然違う曲', duration: 200000, artists: [{ name: 'TestBand' }] }
    ] } })
    throw new Error('unexpected ' + href)
  }
  const options = { fetchImpl, now: () => 0, sleep: async () => {} }
  const list = await online.searchLyricCandidates(track, options)
  assert.equal(list.length, 3, 'every search hit is offered, not just the winner')
  assert.equal(list[0].id, '2', 'the best match is ranked first')
  assert.equal(list[0].risk, 'low')
  assert.equal(list[0].album, 'THE BOOK 3')
  assert.ok(list[0].score > list[2].score, 'scores are visible and ordered')
})

test('a hand-picked candidate is fetched by its own id, AMLL still first', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    const href = String(url)
    seen.push(href)
    if (href.includes('amll-ttml-db')) return textResponse(ttml)
    throw new Error('unexpected ' + href)
  }
  const choice = { id: '999', title: 'テスト曲', artist: 'TestBand', durationMs: 213233, score: 0.9, risk: 'low', reasons: ['title_exact'] }
  const result = await online.fetchLyricsForCandidate(track, choice, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result.lyrics.source, 'amll-ttml')
  assert.equal(result.match.ncmId, '999', 'the user choice wins over the automatic match')
  assert.ok(seen.some(url => url.includes('/999.ttml')), 'the requested id was used: ' + seen.join(' , '))
})

test('a hand-picked candidate that yields nothing is reported as none, not as a crash', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('amll-ttml-db')) return failResponse(404)
    if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:00.00]暂无歌词' } })
    throw new Error('unexpected ' + href)
  }
  const choice = { id: '5', title: 'x', artist: 'y', score: 0.6, risk: 'medium', reasons: [] }
  const result = await online.fetchLyricsForCandidate(track, choice, { fetchImpl, now: () => 0, sleep: async () => {} })
  assert.equal(result, null)
})

test('the same platform is never hit twice within its interval', async () => {
  const sleeps = []
  let clock = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/api/search/get')) return jsonResponse({ code: 200, result: { songs: [{ id: 2034742057, name: 'テスト曲', duration: 213233, artists: [{ name: 'TestBand' }] }] } })
    if (href.includes('amll-ttml-db')) return failResponse(404)
    if (href.includes('song/lyric')) return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]x' } })
    throw new Error('unexpected ' + href)
  }
  const options = { fetchImpl, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms } }
  await online.fetchOnlineLyrics(track, options)
  assert.ok(sleeps.some(ms => ms >= 1200), 'netease calls are spaced by at least the platform interval, got ' + JSON.stringify(sleeps))
})

test('the cache remembers both hits and misses so playback does not become a crawler', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'twilight-lyrics-online-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'lyrics-online.json')
  cache.configureLyricsCache(file)
  const key = 'c/music/song.flac'

  assert.deepEqual(await cache.readOnlineCache(key, 1000), { known: false })
  await cache.writeOnlineCache(key, { lines: [{ startMs: 0, endMs: 1000, words: [], text: 'a' }], wordByWord: false, source: 'lrclib' }, undefined, 1000)
  const hit = await cache.readOnlineCache(key, 2000)
  assert.equal(hit.known, true)
  assert.equal(hit.entry.lyrics.lines[0].text, 'a')

  // 未命中：7 天内有效，过期后允许重查。
  await cache.writeOnlineCache(key + 'miss', null, undefined, 5000)
  assert.equal((await cache.readOnlineCache(key + 'miss', 6000)).known, true)
  assert.equal((await cache.readOnlineCache(key + 'miss', 5000 + 8 * 24 * 60 * 60 * 1000)).known, false)

  // 重新配置（= 重启）后仍在：歌词不该因为关一次程序就重新下载。
  cache.configureLyricsCache(file)
  const reloaded = await cache.readOnlineCache(key, 3000)
  assert.equal(reloaded.entry?.lyrics?.lines[0].text, 'a')
})
