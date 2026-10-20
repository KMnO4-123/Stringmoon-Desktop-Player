// 发现页 provider（主进程侧）单测：不联网、不启 Electron。
//
// 覆盖 PLAN §1.1 的四条硬要求：
//  1. 形状解析能吃下真实/mock 服务端的回包（外壳不一致时**报形状错**，不是空列表）；
//  2. 单区块失败不把整页打成错误页（Promise.all 逐区块降级）；
//  3. 缓存命中不再打上游（CONTRACT §5 的风控额度）；
//  4. 未登录时 daily/fm/playlists 不发请求且 needsLogin=true，toplists 照常请求。
// 另外用真实的 StreamingManager + 假服务端验证：发现页的请求走的是同一套节流/熔断，
// 熔断后第二次进页面不得再打上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const {
  clampPage,
  cookieScope,
  DiscoverCache,
  DiscoveryCore,
  DISCOVER_TTL_MS,
  mapDailySongs,
  mapFmTracks,
  mapPlaylistSquare,
  mapPlaylistTracks,
  mapRecommendPlaylists,
  mapToptlists,
  mapQQDailySongs,
  mapQQPlaylistDetailTracks,
  mapQQPlaylists,
  mapQQRadarTracks,
  mapQQToplistTracks,
  mapQQToplists,
  playlistSquarePath,
  sanitizeCat,
  validId
} = await import('../src/main/streaming/discovery.ts')
const { DEFAULT_DSD_CAPABILITY, STATIC_AUDIO_FORMATS, normalizeEngineCapabilities } = await import('../src/shared/discover.ts')

// ---------------------------------------------------------------------------
// 回包夹具：形状逐字照 mock-streaming-server.mjs 与真实服务端（PLAN §1.1）
// ---------------------------------------------------------------------------

const song = (id, name) => ({ id, name, ar: [{ name: '歌手' + id }], al: { name: '专辑', picUrl: 'http://c/' + id + '.jpg' }, dt: 200000 })

const DAILY_JSON = { code: 200, data: { dailySongs: [song(5001, '每日推荐 0'), song(5002, '每日推荐 1')] } }
const FM_JSON = { code: 200, data: [song(6001, '漫游 0'), song(6002, '漫游 1')] }
const FALLBACK_FM_JSON = { code: 200, result: [song(6101, '漫游回退 0')] }
const TOPLIST_JSON = {
  code: 200,
  list: [
    { id: 19723756, name: '飙升榜', coverImgUrl: 'http://c/top1.jpg', description: '实时热度', updateFrequency: '每天更新', trackCount: 100, playCount: 9000000, ToplistType: 'S' },
    { id: 3779629, name: '新歌榜', coverImgUrl: 'http://c/top2.jpg', description: '最新单曲', updateFrequency: '每天更新', trackCount: 100, playCount: 7000000 },
    { id: 2884035, name: '原创榜', coverImgUrl: 'http://c/top3.jpg', description: '独立原创', updateFrequency: '每周更新', trackCount: 100, playCount: 5000000 },
    { id: 3778678, name: '热歌榜', coverImgUrl: 'http://c/top4.jpg', description: '热门单曲', updateFrequency: '每天更新', trackCount: 100, playCount: 8000000 },
    { id: 8888888, name: '冷门榜', coverImgUrl: 'http://c/top5.jpg', description: '更多榜单', updateFrequency: '每周更新', trackCount: 50, playCount: 100000 }
  ]
}
const RESOURCE_JSON = { code: 200, recommend: [{ id: 7101, name: '推荐歌单一', picUrl: 'http://c/r1.jpg', trackCount: 20, playCount: 123456 }] }
const SQUARE_JSON = {
  code: 200,
  playlists: [
    { id: 8000, name: '发现歌单 0', coverImgUrl: 'http://c/p0.jpg', trackCount: 12, playCount: 1000, creator: { nickname: '创建者' } },
    { id: 8001, name: '发现歌单 1', coverImgUrl: 'http://c/p1.jpg', trackCount: 13, playCount: 2000, creator: { nickname: '创建者' } }
  ],
  total: 45,
  more: true
}
const TRACKS_JSON = { code: 200, songs: [song(1001, '在线曲一'), song(1002, '在线曲二')] }

// ---------------------------------------------------------------------------
// 1. 形状解析
// ---------------------------------------------------------------------------

test('daily songs are mapped from data.dailySongs with https covers', () => {
  const tracks = mapDailySongs(DAILY_JSON)
  assert.equal(tracks.length, 2)
  assert.equal(tracks[0].id, '5001')
  assert.equal(tracks[0].title, '每日推荐 0')
  assert.equal(tracks[0].artist, '歌手5001')
  assert.equal(tracks[0].album, '专辑')
  assert.equal(tracks[0].durationMs, 200000)
  assert.equal(tracks[0].cover, 'https://c/5001.jpg', 'http 封面必须升级成 https（页面 CSP 只放行 https）')
})

test('fm accepts both data[] and result[] shells', () => {
  assert.equal(mapFmTracks(FM_JSON).length, 2)
  assert.equal(mapFmTracks(FALLBACK_FM_JSON)[0].title, '漫游回退 0')
  // 老版本把 items 再包一层
  assert.equal(mapFmTracks({ data: { items: [song(1, 'a')] } }).length, 1)
})

test('toptlists keep upstream order and mark the first four as featured', () => {
  const lists = mapToptlists(TOPLIST_JSON)
  assert.equal(lists.length, 5)
  assert.deepEqual(lists.map(item => item.name), ['飙升榜', '新歌榜', '原创榜', '热歌榜', '冷门榜'])
  assert.deepEqual(lists.map(item => item.featured), [true, true, true, true, false],
    'featured 由上游顺序决定，不是猜 ToplistType（只有个别榜单带它）')
  assert.equal(lists[0].updateFrequency, '每天更新')
  assert.equal(lists[0].playCount, 9000000)
  assert.equal(lists[0].cover, 'https://c/top1.jpg')
})

test('recommend playlists and discovery square map their own shells', () => {
  const recommended = mapRecommendPlaylists(RESOURCE_JSON)
  assert.equal(recommended.length, 1)
  assert.equal(recommended[0].creator, '', '推荐歌单没有 creator 字段：留空而不是编一个')

  const square = mapPlaylistSquare(SQUARE_JSON)
  assert.equal(square.items.length, 2)
  assert.equal(square.items[0].creator, '创建者')
  assert.equal(square.total, 45)
  assert.equal(square.hasMore, true)
  // 老服务端不给 more 时按「本页满一页」推断
  assert.equal(mapPlaylistSquare({ playlists: SQUARE_JSON.playlists }).hasMore, false)
})

test('playlist tracks reuse the song mapping', () => {
  const tracks = mapPlaylistTracks(TRACKS_JSON)
  assert.deepEqual(tracks.map(item => item.id), ['1001', '1002'])
})

test('a wrong shell raises a shape error that names the top-level keys', () => {
  for (const [map, what] of [
    [mapDailySongs, '每日推荐'],
    [mapToptlists, '排行榜'],
    [mapPlaylistSquare, '歌单广场'],
    [mapPlaylistTracks, '歌单曲目']
  ]) {
    assert.throws(() => map({ code: 200, surprise: [] }), (error) => {
      assert.match(error.message, new RegExp('发现页' + what + '的回包形状不对'))
      assert.match(error.message, /surprise/, '错误里必须带「看到了哪些顶层字段」，否则只能靠猜')
      return true
    })
  }
})

test('ids and paging inputs are sanitized before they reach a URL', () => {
  assert.equal(validId('19723756'), '19723756')
  assert.equal(validId(123), '123')
  assert.equal(validId('  '), '')
  assert.equal(validId('1/2'), '', '非数字形状绝不能拼进 URL')
  assert.equal(validId('../../etc'), '')
  assert.equal(clampPage(undefined), 1)
  assert.equal(clampPage(0), 1)
  assert.equal(clampPage(-3), 1)
  assert.equal(clampPage(2.9), 2)
  assert.equal(clampPage(99999), 200)
  assert.equal(sanitizeCat(''), '全部')
  assert.equal(sanitizeCat(' 华语 '), '华语')
  // page 从 1 开始：第 2 页的 offset 必须是 30（PLAN: offset=(page-1)*30）
  assert.match(playlistSquarePath('全部', 'hot', 2), /offset=30(?:&|$)/)
  assert.match(playlistSquarePath('全部', 'hot', 1), /limit=30&offset=0$/)
})

// ---------------------------------------------------------------------------
// 1b. QQ 音乐（v6.3）：形状照 @yakult-green-tea/qq-music-api 3.3.x
// ---------------------------------------------------------------------------

const QQ_SONG = (mid, name, interval = 200) => ({
  mid, id: 9000, name, singer: [{ name: 'QQ 歌手' }], album: { name: 'QQ 专辑', mid: 'am-' + mid }, interval
})
const QQ_DAILY_JSON = { code: 200, songs: [QQ_SONG('qqd1', 'QQ 每日一'), QQ_SONG('qqd2', 'QQ 每日二', 180)] }
const QQ_RADAR_JSON = { code: 200, page: 1, songs: [QQ_SONG('qqr1', 'QQ 雷达一')], more: true }
const QQ_TOPLISTS_JSON = {
  code: 200,
  groups: [
    { id: 1, name: '巅峰榜', toplists: [
      { id: 26, title: '热歌榜', intro: 'QQ 热歌', totalNum: 100, listenNum: 1200000, updateTime: '每天更新', headPicUrl: 'http://c/qq1.jpg' },
      { id: 27, title: '新歌榜', intro: '新上架', totalNum: 100, listenNum: 800000, updateTime: '每天更新', frontPicUrl: 'http://c/qq2.jpg' }
    ] },
    { id: 2, name: '特色榜', toplists: [
      { id: 62, title: '飙升榜', intro: '上升最快', totalNum: 100, listenNum: 600000, updateTime: '每小时更新' },
      { id: 26, title: '热歌榜（重复）', intro: '重复的 id 必须去掉' },
      { id: 58, title: '古风榜', intro: '国风' }
    ] }
  ]
}
const QQ_PLAYLISTS_JSON = {
  code: 200,
  playlists: [
    { tid: 710001, title: 'QQ 推荐一', picurl: 'http://c/qqp1.jpg', songnum: 42, play_cnt: 23456, creator: { nick: '创建者' } },
    { tid: 710002, title: 'QQ 推荐二', picurl: 'http://c/qqp2.jpg', songnum: 18, play_cnt: 9876 }
  ]
}
const QQ_TOPLIST_TRACKS_JSON = { code: 200, toplist: { id: 26, title: '热歌榜' }, songs: [QQ_SONG('qqt1', '榜单曲一'), QQ_SONG('qqt2', '榜单曲二')] }
const QQ_PLAYLIST_DETAIL_JSON = { response: { code: 0, cdlist: [{ disstid: '710001', dissname: 'QQ 歌单', songlist: [QQ_SONG('qqs1', '歌单曲一')] }] } }

test('QQ tracks are mapped from track_info shape (mid / singer[] / interval seconds)', () => {
  const tracks = mapQQDailySongs(QQ_DAILY_JSON)
  assert.equal(tracks.length, 2)
  assert.equal(tracks[0].platform, 'qq')
  assert.equal(tracks[0].id, 'qqd1')
  assert.equal(tracks[0].title, 'QQ 每日一')
  assert.equal(tracks[0].artist, 'QQ 歌手')
  assert.equal(tracks[0].album, 'QQ 专辑')
  assert.equal(tracks[0].durationMs, 200_000, 'interval 是秒，要换成毫秒')
  assert.equal(tracks[0].cover, 'https://y.gtimg.cn/music/photo_new/T002R300x300M000am-qqd1.jpg')
  assert.equal(tracks[1].durationMs, 180_000)
  assert.equal(mapQQRadarTracks(QQ_RADAR_JSON)[0].id, 'qqr1')
})

test('QQ toplists flatten groups, keep upstream order, dedupe ids and feature the first four', () => {
  const lists = mapQQToplists(QQ_TOPLISTS_JSON)
  assert.deepEqual(lists.map(item => item.id), ['26', '27', '62', '58'], '重复的 id 必须去掉')
  assert.deepEqual(lists.map(item => item.name), ['热歌榜', '新歌榜', '飙升榜', '古风榜'])
  assert.equal(lists[0].featured, true)
  assert.equal(lists[3].featured, true)
  assert.equal(lists[0].cover, 'https://c/qq1.jpg')
  assert.equal(lists[0].description, 'QQ 热歌')
  assert.equal(lists[0].trackCount, 100)
  assert.equal(lists[0].playCount, 1200000)
  assert.equal(lists[0].updateFrequency, '每天更新')
})

test('QQ playlists map tid/title/picurl/songnum/play_cnt and tolerate a missing creator', () => {
  const lists = mapQQPlaylists(QQ_PLAYLISTS_JSON)
  assert.equal(lists.length, 2)
  assert.equal(lists[0].id, '710001')
  assert.equal(lists[0].name, 'QQ 推荐一')
  assert.equal(lists[0].cover, 'https://c/qqp1.jpg')
  assert.equal(lists[0].trackCount, 42)
  assert.equal(lists[0].playCount, 23456)
  assert.equal(lists[0].creator, '创建者')
  assert.equal(lists[1].creator, '', '缺创建者时留空串，不编名字')
})

test('QQ toplist songs and playlist detail both yield tracks; anonymous-only playlists say why', () => {
  assert.equal(mapQQToplistTracks(QQ_TOPLIST_TRACKS_JSON)[1].title, '榜单曲二')
  assert.equal(mapQQPlaylistDetailTracks(QQ_PLAYLIST_DETAIL_JSON)[0].id, 'qqs1')
  assert.throws(
    () => mapQQPlaylistDetailTracks({ response: { code: 10, cdlist: [] } }),
    /需要登录/,
    '官方歌单匿名不可读时要明确说需要登录，而不是回一个空歌单'
  )
})

test('QQ home loads radar/toplists/playlists anonymously and asks for a login only for daily', async () => {
  const routes = {
    '/recommend/radar?page=1': QQ_RADAR_JSON,
    '/recommend/toplists': QQ_TOPLISTS_JSON,
    '/recommend/playlists?limit=30': QQ_PLAYLISTS_JSON
  }
  const harness = makeCore({ signed: false, routes })
  const home = await harness.core.home('qq')
  assert.equal(home.platform, 'qq')
  assert.equal(home.signedIn, false)
  assert.equal(home.sections.daily.needsLogin, true, '未登录时 QQ 每日 30 首只给登录引导，不发请求')
  assert.equal(home.sections.fm.items.length, 1)
  assert.equal(home.sections.toplists.items.length, 4)
  assert.equal(home.sections.playlists.items.length, 2)
  assert.ok(harness.calls.every(call => call.startsWith('qq:')), 'QQ 发现页只打 QQ 平台的请求')
  assert.ok(!harness.calls.some(call => call.includes('/user/daily-songs')), '未登录不得请求个性化端点')
})

test('the two platforms have separate caches (netease and qq never share a section)', async () => {
  const harness = makeCore({
    signed: false,
    routes: {
      '/toplist/detail': TOPLIST_JSON,
      '/recommend/resource': RESOURCE_JSON,
      '/recommend/radar?page=1': QQ_RADAR_JSON,
      '/recommend/toplists': QQ_TOPLISTS_JSON,
      '/recommend/playlists?limit=30': QQ_PLAYLISTS_JSON,
      '/recommend/songs': DAILY_JSON,
      '/personal/fm/mode?mode=DEFAULT&limit=30': FM_JSON,
      '/personal_fm': FALLBACK_FM_JSON
    }
  })
  const neteaseHome = await harness.core.home('netease')
  const qqHome = await harness.core.home('qq')
  assert.equal(neteaseHome.sections.toplists.items[0].name, '飙升榜')
  assert.equal(qqHome.sections.toplists.items[0].name, '热歌榜')
  assert.notDeepEqual(neteaseHome.sections.toplists.items, qqHome.sections.toplists.items)
})

// ---------------------------------------------------------------------------
// 2. 降级：单区块失败不整体失败
// ---------------------------------------------------------------------------

function makeCore(options = {}) {
  const calls = []
  let nowValue = options.now ?? 1_000_000
  let scopeValue = options.scope ?? 'anon'
  const routes = options.routes ?? {
    '/recommend/songs': DAILY_JSON,
    '/personal/fm/mode?mode=DEFAULT&limit=30': FM_JSON,
    '/toplist/detail': TOPLIST_JSON,
    '/recommend/resource': RESOURCE_JSON,
    '/personal_fm': FALLBACK_FM_JSON
  }
  const core = new DiscoveryCore({
    scope: async () => scopeValue,
    // v6.3：deps 带平台参数；缓存键会把平台算进去，所以这里把调用记成 platform:path。
    send: async (platform, path) => {
      calls.push(platform + ':' + path)
      const entry = routes[path]
      if (entry instanceof Error) throw entry
      if (entry === undefined) throw new Error('unexpected path ' + path)
      return entry
    },
    signedIn: () => options.signed ?? false,
    now: () => nowValue
  })
  return {
    core,
    calls,
    setNow: value => { nowValue = value },
    setScope: value => { scopeValue = value }
  }
}

test('a single failing section degrades alone (signed-in listener)', async () => {
  const routes = {
    '/recommend/songs': DAILY_JSON,
    '/personal/fm/mode?mode=DEFAULT&limit=30': new Error('上游限流（429）：已暂停该平台请求 10 分钟。'),
    '/toplist/detail': new Error('网易云服务端返回 HTTP 500：boom'),
    '/recommend/resource': RESOURCE_JSON,
    '/personal_fm': FALLBACK_FM_JSON
  }
  const { core } = makeCore({ signed: true, routes })
  const home = await core.home()
  assert.equal(home.platform, 'netease')
  assert.equal(home.signedIn, true)
  // 成功的区块照常给数据
  assert.equal(home.sections.daily.items.length, 2)
  assert.equal(home.sections.playlists.items.length, 1)
  // 失败的两个区块各有自己的中文错误 + 下一步
  assert.match(home.sections.toplists.error, /HTTP 500/)
  assert.equal(home.sections.toplists.items.length, 0)
  // 漫游：mode 端点失败后**回退** /personal_fm，并且回退成功
  assert.equal(home.sections.fm.error, null, 'mode 端点失败应回退 /personal_fm 而不是直接报错')
  assert.equal(home.sections.fm.items[0].title, '漫游回退 0')
  // 汇总只报名字，不重复四条错误
  assert.match(home.notice, /排行榜/)
  assert.doesNotMatch(home.notice, /每日推荐/, '成功区块不出现在汇总里')
  assert.ok(home.notice.length > 0)
})

test('the whole page still resolves when the platform server is down', async () => {
  const down = new Error('网易云音乐服务端没有在运行，请先在设置里启动它。')
  const routes = {
    '/recommend/songs': down,
    '/personal/fm/mode?mode=DEFAULT&limit=30': down,
    '/toplist/detail': down,
    '/recommend/resource': down,
    '/personal_fm': down
  }
  const { core } = makeCore({ signed: true, routes })
  const home = await core.home()
  assert.equal(home.sections.toplists.error, down.message, '平台层的「为什么 + 怎么办」必须原样透出')
  assert.equal(home.notice, '发现页的数据都没取到。网易云服务端可能没有启动，或者网络不可用。')
  assert.equal(home.sections.daily.needsLogin, false, '服务端没起不是「需要登录」')
})

test('scope() failing (server not started) still yields a full structure', async () => {
  const core = new DiscoveryCore({
    scope: async () => { throw new Error('网易云音乐服务端没有在运行，请先在设置里启动它。') },
    send: async () => { throw new Error('must not be called') },
    signedIn: () => false,
    now: () => 1
  })
  const home = await core.home()
  assert.equal(home.sections.toplists.error, '网易云音乐服务端没有在运行，请先在设置里启动它。')
  // 未登录的个性化区块仍然是登录引导（needsLogin），不是错误：所以汇总里只会点出
  // 真正尝试过却失败的榜单。这与「服务端没起 + 已登录」时的「全都没取到」是两条路径。
  assert.equal(home.sections.daily.needsLogin, true)
  assert.equal(home.sections.playlists.needsLogin, true)
  assert.equal(home.notice, '部分区块没取到：排行榜。可以点「刷新」重试。')
})

// ---------------------------------------------------------------------------
// 3. 缓存：命中不打上游，按账号隔离，TTL 到期重取
// ---------------------------------------------------------------------------

test('a second visit inside the TTL sends no upstream request at all', async () => {
  const { core, calls } = makeCore({ signed: true })
  const first = await core.home()
  const afterFirst = calls.length
  assert.ok(afterFirst >= 4, '第一次进页面应该真的发了四个区块的请求，实际 ' + afterFirst)

  const second = await core.home()
  assert.equal(calls.length, afterFirst, '缓存命中不得再打上游（风控额度）')
  assert.deepEqual(second.sections.daily.items, first.sections.daily.items)
  assert.equal(second.sections.daily.updatedAt, first.sections.daily.updatedAt,
    '缓存命中保留原始抓取时间，界面才能说清数据多旧')
  assert.equal(second.notice, null)
})

test('the cache is per account: switching the session refetches personalised sections', async () => {
  const harness = makeCore({ signed: true })
  await harness.core.home()
  const afterFirst = harness.calls.length
  harness.setScope('c-deadbeef')
  await harness.core.home()
  assert.ok(harness.calls.length > afterFirst, '换账号后每日推荐/漫游必须重新请求，不能看到上一个账号的推荐')
})

test('ttl expiry refetches and logout clears the cache', async () => {
  const harness = makeCore({ signed: true })
  harness.setNow(1000)
  await harness.core.home()
  const afterFirst = harness.calls.length
  harness.setNow(1000 + DISCOVER_TTL_MS.toplists)
  await harness.core.home()
  assert.ok(harness.calls.length > afterFirst, 'TTL 到期后应该重新请求')
  const afterExpiry = harness.calls.length
  harness.core.reset()
  await harness.core.home()
  assert.ok(harness.calls.length > afterExpiry, '登出/换账号清缓存后必须重新请求')
})

test('the cache keeps a bounded size (discovery square pages cannot leak)', () => {
  const cache = new DiscoverCache(3)
  cache.write('a', 1, 0)
  cache.write('b', 2, 0)
  cache.write('c', 3, 0)
  cache.write('d', 4, 0)
  assert.equal(cache.size, 3)
  assert.equal(cache.read('a', 1000, 0), null, '最旧的条目先淘汰')
  assert.equal(cache.read('d', 1000, 0).value, 4)
  // 过期即删
  assert.equal(cache.read('d', 10, 20), null)
  assert.equal(cache.size, 2)
})

test('cookieScope fingerprints instead of storing the credential', () => {
  assert.equal(cookieScope(''), 'anon')
  assert.equal(cookieScope(undefined), 'anon')
  const scope = cookieScope('MUSIC_U=secret-value==')
  assert.match(scope, /^c[0-9a-f]+$/)
  assert.ok(!scope.includes('secret'), '缓存键里不得出现凭据本身')
  assert.equal(cookieScope('MUSIC_U=other-value'), cookieScope('MUSIC_U=other-value'))
  assert.notEqual(cookieScope('MUSIC_U=a'), cookieScope('MUSIC_U=b'))
})

// ---------------------------------------------------------------------------
// 4. 未登录：needsLogin 且不发请求
// ---------------------------------------------------------------------------

test('a signed-out listener gets login hints and no personalised request', async () => {
  const { core, calls } = makeCore({ signed: false })
  const home = await core.home()
  assert.deepEqual(calls, ['netease:/toplist/detail'],
    '未登录时只请求免登录的榜单；每日推荐/漫游/推荐歌单一次都不发（省风控额度）')
  assert.equal(home.sections.daily.needsLogin, true)
  assert.equal(home.sections.fm.needsLogin, true)
  assert.equal(home.sections.playlists.needsLogin, true)
  assert.equal(home.sections.daily.error, null, '需要登录不是错误：界面显示引导，不显示红字')
  assert.equal(home.sections.toplists.needsLogin, false)
  assert.ok(home.sections.toplists.items.length >= 4, '未登录时榜单必须有内容（发现页对游客仍然有用）')
  assert.equal(home.notice, null, '未登录不是失败，不该有汇总错误')
})

test('signed-out discovery square still works (public endpoint)', async () => {
  const squarePath = '/top/playlist?cat=' + encodeURIComponent('全部') + '&order=hot&limit=30&offset=0'
  const routes = { '/toplist/detail': TOPLIST_JSON, [squarePath]: SQUARE_JSON }
  const { core } = makeCore({ signed: false, routes })
  const page = await core.playlistSquare({ page: 1 })
  assert.equal(page.error, null)
  assert.equal(page.items.length, 2)
  assert.equal(page.hasMore, true)
})

test('a login failure inside a section becomes a login hint, not a red error', async () => {
  const routes = {
    '/recommend/songs': new Error('网易云需要登录（401）。'),
    '/personal/fm/mode?mode=DEFAULT&limit=30': FM_JSON,
    '/toplist/detail': TOPLIST_JSON,
    '/recommend/resource': RESOURCE_JSON
  }
  const { core } = makeCore({ signed: true, routes })
  const home = await core.home()
  assert.equal(home.sections.daily.needsLogin, true)
  assert.equal(home.sections.daily.error, null)
})

// ---------------------------------------------------------------------------
// 5. 真实 StreamingManager：同一套节流/熔断
// ---------------------------------------------------------------------------

const FAKE_SERVER = `import http from 'node:http'
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end('{}')
}).listen(Number(process.env.PORT))
`

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), 'twilight-discover-'))
  const serverPath = path.join(dir, 'fake-server.mjs')
  await writeFile(serverPath, FAKE_SERVER, 'utf8')
  const { StreamingManager } = await import('../src/main/streaming/manager.ts')
  const manager = new StreamingManager()
  manager.configure(path.join(dir, 'streaming.json'), path.join(dir, 'secrets.json'))
  await manager.saveConfig({
    version: 1,
    lazyStart: true,
    providers: [
      { platform: 'netease', command: 'node "' + serverPath + '"', enabled: true, quality: 'exhigh' },
      { platform: 'qq', command: '', enabled: false },
      { platform: 'meting', command: '', enabled: false, metingSource: 'kugou' }
    ]
  })
  return {
    manager,
    async dispose() {
      await manager.shutdown()
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/**
 * 用全局 fetch 桩模拟上游（真实节流/熔断/ensureStarted 都还是生产代码）。
 * 返回的 recorder 记录每次请求的 path，用来做「有没有打到那条端点」的硬断言。
 */
function stubUpstream(handler) {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    requests.push({ path: parsed.pathname, search: parsed.search })
    const result = await handler(parsed)
    if (result instanceof Error) throw result
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return {
    requests,
    paths: () => requests.map(item => item.path),
    restore: () => { globalThis.fetch = originalFetch }
  }
}

/** mock-streaming-server.mjs 的发现页形状（也刻意与真实服务端一致）。 */
function mockUpstream(parsed, signedIn) {
  const pathname = parsed.pathname
  if (pathname === '/recommend/songs') return { code: 200, data: { dailySongs: signedIn ? [song(5001, '每日推荐 0')] : [] } }
  if (pathname === '/personal/fm/mode' || pathname === '/personal_fm') return { code: 200, data: signedIn ? [song(6001, '漫游 0')] : [] }
  if (pathname === '/toplist/detail') return { code: 200, list: TOPLIST_JSON.list }
  if (pathname === '/recommend/resource') return { code: 200, recommend: signedIn ? RESOURCE_JSON.recommend : [] }
  if (pathname === '/top/playlist') {
    const offset = Number(parsed.searchParams.get('offset') || 0)
    const limit = Number(parsed.searchParams.get('limit') || 30)
    const total = 45
    const playlists = []
    for (let index = offset; index < Math.min(total, offset + limit); index++) {
      playlists.push({ id: 8000 + index, name: '发现歌单 ' + index, coverImgUrl: 'http://c/p' + index + '.jpg', trackCount: 12, playCount: 1000, creator: { nickname: '创建者' } })
    }
    return { code: 200, playlists, total, more: offset + limit < total }
  }
  if (pathname === '/playlist/track/all') return TRACKS_JSON
  return new Error('unexpected upstream path ' + pathname)
}

test('the discovery fuse shares the platform risk-control state (no second request after -460)', async () => {
  const { manager, dispose } = await makeManager()
  // 让发现页认为已登录：setSecret 只写内存并尝试持久化；普通 node 里没有 safeStorage，
  // 会安静跳过落盘（「没有加密后端就不保存」的既有约束）。
  await manager.setSecret('netease', 'MUSIC_U=test-session')
  const upstream = stubUpstream(() => ({ code: -460, message: 'Cheating' }))
  try {
    const first = await manager.discoverHome()
    assert.ok(upstream.requests.length >= 1, '第一次进页面确实打到了上游')
    for (const name of ['daily', 'fm', 'toplists', 'playlists']) {
      assert.ok(first.sections[name].error !== null, name + ' 应该带上风控错误')
      assert.match(first.sections[name].error, /风控|Cheating|已暂停/)
    }
    const callsAfterFirst = upstream.requests.length

    // 熔断已生效：第二次进页面（缓存里没有失败结果 → 必然会再请求 → 被 checkBlocked 拦下）
    const second = await manager.discoverHome()
    assert.equal(upstream.requests.length, callsAfterFirst, '熔断后不得再发任何上游请求')
    for (const name of ['daily', 'fm', 'toplists', 'playlists']) {
      assert.match(second.sections[name].error, /已暂停|风控/, name + ' 第二次应被本地熔断直接拒绝')
    }
  } finally {
    upstream.restore()
    await dispose()
  }
})

test('a signed-out listener never touches the personalised endpoints (risk budget)', async () => {
  const { manager, dispose } = await makeManager()
  const upstream = stubUpstream(parsed => mockUpstream(parsed, false))
  try {
    const home = await manager.discoverHome()
    assert.deepEqual(upstream.paths(), ['/toplist/detail'],
      '未登录时只准请求免登录的榜单；每日推荐/漫游/推荐歌单一条都不许发')
    for (const forbidden of ['/recommend/songs', '/personal/fm/mode', '/personal_fm', '/recommend/resource']) {
      assert.ok(!upstream.paths().includes(forbidden), '风控纪律：未登录不得请求 ' + forbidden)
    }
    assert.equal(home.sections.daily.needsLogin, true)
    assert.equal(home.sections.fm.needsLogin, true)
    assert.equal(home.sections.playlists.needsLogin, true)
    assert.ok(home.sections.toplists.items.length >= 4, '榜单对游客必须有内容')
  } finally {
    upstream.restore()
    await dispose()
  }
})

test('a signed-in listener gets all four sections and a second visit is served from cache', async () => {
  const { manager, dispose } = await makeManager()
  await manager.setSecret('netease', 'MUSIC_U=test-session')
  const upstream = stubUpstream(parsed => mockUpstream(parsed, true))
  try {
    const first = await manager.discoverHome()
    assert.equal(first.signedIn, true)
    assert.equal(first.notice, null)
    assert.equal(first.sections.daily.items.length, 1)
    assert.equal(first.sections.fm.items.length, 1)
    assert.equal(first.sections.playlists.items.length, 1)
    assert.deepEqual(upstream.paths().sort(), ['/personal/fm/mode', '/recommend/resource', '/recommend/songs', '/toplist/detail'])
    const afterFirst = upstream.requests.length

    const second = await manager.discoverHome()
    assert.equal(upstream.requests.length, afterFirst, '第二次进页面必须全部命中缓存，一次上游都不打')
    assert.deepEqual(second.sections.daily.items, first.sections.daily.items)
  } finally {
    upstream.restore()
    await dispose()
  }
})

test('discover endpoints carry the sanitized paging parameters through the manager', async () => {
  const { manager, dispose } = await makeManager()
  const upstream = stubUpstream(parsed => mockUpstream(parsed, false))
  try {
    const firstPage = await manager.discoverPlaylists('netease', { cat: '华语', order: 'new', page: 1 })
    assert.equal(firstPage.error, null)
    assert.equal(firstPage.total, 45)
    assert.equal(firstPage.hasMore, true, 'total=45 / limit=30：第一页还有更多')
    const firstRequest = upstream.requests.find(item => item.path === '/top/playlist')
    assert.ok(firstRequest)
    assert.equal(new URLSearchParams(firstRequest.search).get('cat'), '华语')
    assert.equal(new URLSearchParams(firstRequest.search).get('order'), 'new')
    assert.equal(new URLSearchParams(firstRequest.search).get('offset'), '0')

    // 第 2 页：offset 必须是 30，且 hasMore 必须由 total 如实算出（45 条 → 第 2 页是最后一页）
    const secondPage = await manager.discoverPlaylists('netease', { cat: '华语', order: 'new', page: 2 })
    assert.equal(secondPage.error, null)
    assert.equal(secondPage.items.length, 15)
    assert.equal(secondPage.hasMore, false, 'offset 30 + 15 条 = 45 = total：已经没有下一页')
    const secondRequest = upstream.requests.filter(item => item.path === '/top/playlist')[1]
    assert.equal(new URLSearchParams(secondRequest.search).get('offset'), '30')

    // 翻页必须各走各的缓存键：两次请求都真的发生了（第 2 页没有命中第 1 页的缓存）
    assert.equal(upstream.requests.filter(item => item.path === '/top/playlist').length, 2)

    // 再次请求第 1 页：命中缓存，不再打上游
    const beforeCache = upstream.requests.length
    const again = await manager.discoverPlaylists('netease', { cat: '华语', order: 'new', page: 1 })
    assert.equal(again.items.length, 30)
    assert.equal(upstream.requests.length, beforeCache, '同一 (cat,order,page) 再次请求必须命中缓存')

    // 换个分类：必须是另一次真实请求（缓存键含 cat）
    await manager.discoverPlaylists('netease', { cat: '摇滚', order: 'new', page: 1 })
    assert.equal(upstream.requests.length, beforeCache + 1)

    const tracks = await manager.discoverPlaylistTracks('netease', '8000')
    assert.equal(tracks.error, null)
    assert.deepEqual(tracks.items.map(item => item.id), ['1001', '1002'])

    // 非法 id 在进入上游之前就被挡下（返回 error 而不是发请求）
    const beforeBad = upstream.requests.length
    const bad = await manager.discoverToplist('netease', '1; drop')
    assert.match(bad.error, /有效的榜单 id/)
    assert.equal(bad.items.length, 0)
    assert.equal(upstream.requests.length, beforeBad, '非法 id 不得触达上游')
  } finally {
    upstream.restore()
    await dispose()
  }
})

// ---------------------------------------------------------------------------
// 6. 解码能力矩阵（CR-032 的回落规则）
// ---------------------------------------------------------------------------

test('a valid get_capabilities reply wins, and an unknown shape falls back to the static matrix', () => {
  const reply = {
    decoders: [
      { ext: '.flac', label: 'FLAC', kind: 'native', lossless: true, available: true },
      { ext: '.dsf', label: 'DSD', kind: 'dsd', lossless: true, available: true },
      // 本机没有对应解码器 MFT 的格式：引擎如实报 available:false，界面不能把它当正常支持
      { ext: '.wma', label: 'WMA', kind: 'system', lossless: false, available: false },
      // 旧引擎/半截回包不回 available：按「声明即支持」处理（available 缺省 true）
      { ext: '.mp3', label: 'MP3', kind: 'native', lossless: false },
      { ext: '.bogus', label: 'x', kind: 'weird', lossless: true }
    ],
    dsd: { supported: true, modes: ['dsd64'], output: 'dop' },
    // 引擎会回更多字段（systemDecoders 等）：归一化不消费，但 engine 原样保留给界面/诊断。
    systemDecoders: true
  }
  const normalized = normalizeEngineCapabilities(reply)
  assert.ok(normalized)
  assert.deepEqual(normalized.formats.map(item => item.ext), ['.flac', '.dsf', '.wma', '.mp3'], '未知 kind 的行必须被丢掉，不能画进界面')
  assert.deepEqual(normalized.formats.map(item => item.available), [true, true, false, true],
    'available 必须透传：本机没有 MFT 的格式是 false，缺省一律 true')
  assert.equal(normalized.dsd.supported, true)
  assert.equal(normalized.dsd.output, 'dop')

  // 旧引擎/坏回包：归一化返回 null（调用方退回静态矩阵，engine:null 如实标注）
  assert.equal(normalizeEngineCapabilities(null), null)
  assert.equal(normalizeEngineCapabilities({}), null)
  assert.equal(normalizeEngineCapabilities({ decoders: [] }), null)
  assert.equal(normalizeEngineCapabilities({ decoders: [{ ext: '.x', kind: 'nope' }] }), null)
})

test('the static matrix never claims a format the current engine cannot decode', () => {
  const byExt = new Map(STATIC_AUDIO_FORMATS.map(item => [item.ext, item]))
  // 本轮引擎实际解码：FLAC/WAV/MP3/Ogg(Vorbis|FLAC) 原生，MP4(AAC/ALAC) 走 MF；
  // Ogg-Opus 能识别但不解码（audio_source.cpp:124-126）。
  assert.equal(byExt.get('.flac').lossless, true)
  assert.equal(byExt.get('.wav').lossless, true)
  assert.equal(byExt.get('.mp3').lossless, false)
  assert.equal(byExt.get('.m4a').kind, 'system')
  // 容器不是编解码器：.m4a/.oga 的 lossless 必须按典型语义报 false，不能替上游吹无损
  assert.equal(byExt.get('.m4a').lossless, false)
  assert.equal(byExt.get('.oga').lossless, false)
  // 系统解码格式（.wma/.aif/.ac3/.aac）的可用性属于「本机实测」，没有引擎回包时不写进兜底矩阵
  for (const ext of ['.wma', '.aif', '.aiff', '.ac3', '.aac']) {
    assert.equal(byExt.has(ext), false, ext + ' 的可用性只能由引擎如实回答，静态矩阵不得猜')
  }
  assert.equal(byExt.get('.opus').kind, 'unsupported')
  assert.equal(byExt.get('.opus').available, false, '本引擎没有 Opus 解码器：静态矩阵必须写 available:false')
  assert.equal(byExt.get('.flac').available, true)
  // 每一行都必须显式写 available，不允许靠「缺省」在大矩阵里漏掉一个
  for (const format of STATIC_AUDIO_FORMATS) {
    assert.equal(typeof format.available, 'boolean', format.ext + ' 缺少 available')
  }
  assert.equal(byExt.has('.dsf'), false, 'DSD 还没落地，静态矩阵不得替引擎吹牛')
  assert.equal(byExt.has('.dff'), false)
  assert.deepEqual(DEFAULT_DSD_CAPABILITY, { supported: false, modes: [], output: 'pcm' })
})
