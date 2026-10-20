import { normalizeCookie, qqSessionToken } from '../src/shared/streaming.ts'
import { supportsWebLogin } from '../src/shared/web-login.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ShapeError, idFromMetingLink, locationFromRedirect, meting, metingServerFor, metingToken, netease, qq
} from '../src/main/streaming/adapters.ts'
import {
  PLATFORM_SPECS, applyPortPlaceholder, defaultStreamingConfig, platformSpec, sessionLabel, splitCommand
} from '../src/shared/streaming.ts'

// ---------------------------------------------------------------------------
// 命令与端口
// ---------------------------------------------------------------------------

test('a command with quotes splits without eating the quotes into the path', () => {
  assert.deepEqual(splitCommand('npx -y pkg'), ['npx', '-y', 'pkg'])
  assert.deepEqual(
    splitCommand('node "C:\Program Files\api\index.js" --flag'),
    ['node', 'C:\Program Files\api\index.js', '--flag']
  )
  assert.deepEqual(splitCommand("php -S 127.0.0.1:$PORT 'a b.php'"), ['php', '-S', '127.0.0.1:$PORT', 'a b.php'])
  assert.deepEqual(splitCommand('   '), [])
})

test('the port placeholder is substituted, and a command without one is left alone', () => {
  assert.equal(applyPortPlaceholder('server --port $PORT', 41234), 'server --port 41234')
  assert.equal(applyPortPlaceholder('server --port $PORTX', 41234), 'server --port $PORTX')
  assert.equal(applyPortPlaceholder('server', 41234), 'server')
})

test('each platform declares where its own server reads the port', () => {
  assert.equal(platformSpec('netease').portEnv, 'PORT')
  assert.equal(platformSpec('qq').portEnv, 'PORT')
  // meting-api 用的是 HTTP_PORT，不是 PORT —— 写错就永远起不来。
  assert.equal(platformSpec('meting').portEnv, 'HTTP_PORT')
  // meting-api 不在 npm 上，默认命令必须是 Docker（否则一启动就 ENOENT）。
  assert.ok(platformSpec('meting').defaultCommand.startsWith('docker '), 'meting default uses the Docker image')
  assert.ok(!platformSpec('meting').defaultCommand.includes('npx'), 'no bogus npx meting-api')
  assert.throws(() => platformSpec('nope'), /unknown platform/)
})

test('the default config covers every platform and starts nothing', () => {
  const config = defaultStreamingConfig()
  assert.equal(config.providers.length, PLATFORM_SPECS.length)
  assert.ok(config.providers.every(provider => provider.enabled === false), 'nothing is auto-started')
  assert.equal(config.providers.find(p => p.platform === 'meting').metingSource, 'kugou')
})

test('session labels are user-facing words, not enum names', () => {
  assert.equal(sessionLabel('signed-in'), '已登录')
  assert.equal(sessionLabel('expired'), '登录已失效')
})

// ---------------------------------------------------------------------------
// 网易云
// ---------------------------------------------------------------------------

test('netease URLs encode the keyword and ask for word-level lyrics', () => {
  const search = netease.search('http://127.0.0.1:1', '周杰伦 晴天', 10)
  assert.ok(search.includes('keywords=' + encodeURIComponent('周杰伦 晴天')))
  assert.ok(search.includes('limit=10'))
  // yv=-1 是 CONTRACT §4.4 的实测结论：不带它就没有字级 yrc。
  assert.ok(netease.lyric('http://127.0.0.1:1', '1901371647').includes('yv=-1'))
})

test('netease search maps the documented shape, and the legacy artist/album keys too', () => {
  const modern = {
    result: { songs: [
      { id: 1, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' }, dt: 269000 },
      { id: 2, name: '七里香', artists: [{ name: '周杰伦' }], album: { name: '七里香' }, duration: 299000 }
    ] }
  }
  const tracks = netease.mapSearch(modern)
  assert.equal(tracks.length, 2)
  assert.deepEqual(tracks[0], { platform: 'netease', id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000, cover: null })
  assert.equal(tracks[1].artist, '周杰伦', 'the legacy artists[] key still maps')
  // 封面：http 必须升级成 https（CSP 只放行 https 图片），没有就是 null。
  const [withCover] = netease.mapSearch({ result: { songs: [
    { id: 3, name: '封面', ar: [], al: { name: 'a', picUrl: 'http://p1.music.126.net/x.jpg' }, dt: 1 }
  ] } })
  assert.equal(withCover.cover, 'https://p1.music.126.net/x.jpg')
})

test('a shape mismatch names the keys it actually saw', () => {
  assert.throws(() => netease.mapSearch({ code: 200, msg: 'nothing' }), (error) => {
    assert.ok(error instanceof ShapeError)
    assert.match(error.message, /顶层字段/)
    assert.match(error.message, /code/)
    return true
  })
})

test('a null play url is reported as an entitlement problem, not a network one', () => {
  assert.equal(netease.mapPlayUrl({ data: [{ url: 'https://x/1.mp3', code: 200 }] }), 'https://x/1.mp3')
  assert.throws(() => netease.mapPlayUrl({ data: [{ url: null, code: 404 }] }), /会员|code=404/)
})

// ---------------------------------------------------------------------------
// QQ
// ---------------------------------------------------------------------------

test('qq search uses songmid (not the numeric id) and seconds for duration', () => {
  const json = { code: 200, items: [
    { mid: 'demo-mid', name: '示例', singer: [{ name: '歌手' }], album: { name: '专辑', mid: 'am' }, interval: 240, file: { media_mid: 'mm' } }
  ] }
  const [track] = qq.mapSearch(json)
  assert.equal(track.id, 'demo-mid')
  assert.equal(track.durationMs, 240000)
  assert.equal(track.platform, 'qq')
})

test('qq play url is found wherever the server nests it', () => {
  assert.equal(qq.mapPlayUrl({ data: [{ url: 'https://x/a.m4a' }] }), 'https://x/a.m4a')
  assert.equal(qq.mapPlayUrl({ data: { playUrl: 'https://x/b.m4a' } }), 'https://x/b.m4a')
  const purl = 'M800002xyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123'
  assert.equal(qq.mapPlayUrl({ file: { purl } }), 'https://ws.stream.qqmusic.qq.com/' + purl)
  assert.throws(() => qq.mapPlayUrl({ code: 401 }), /code=401/)
})

test('qq QR codes read the 801/802/803 dialect', () => {
  assert.equal(qq.mapQrKey({ data: { unikey: 'u1' } }), 'u1')
  assert.deepEqual(qq.mapQrCreate({ data: { qrimg: 'data:image/png;base64,AA' } }), { image: 'data:image/png;base64,AA', url: null })
  assert.deepEqual(qq.mapQrCheck({ code: 803, data: { cookie: 'qqmusic_session=abc' } }), { code: 803, cookie: 'qqmusic_session=abc', detail: null })
})

test('qq session token is extracted for the X-QQ-Session transport', () => {
  // 后端的三条通道语义不同：header 收裸 token，?cookie= 收整串。我们之前只发 Cookie 头，
  // 服务端因此「不认这个会话」。这条钉住解析。
  assert.equal(qqSessionToken('qqmusic_session=abc123'), 'abc123')
  assert.equal(qqSessionToken('uin=o1; qqmusic_session=abc==; qm_keyst=k'), 'abc==')
  assert.equal(qqSessionToken('qqmusic_key=k; qm_keyst=k2'), '')
  assert.equal(qqSessionToken(''), '')
  // 只有网易云支持网页 Cookie 登录；QQ 是扫码会话 token，网页罐里的凭证它不解析。
  assert.equal(supportsWebLogin('netease'), true)
  assert.equal(supportsWebLogin('qq'), false)
  assert.equal(supportsWebLogin('meting'), false)
})

test('qq user data uses the routes and pagination Folia uses', () => {
  const base = 'http://127.0.0.1:1'
  assert.equal(qq.likedSongs(base, 100, 200), base + '/user/liked-songs?limit=100&offset=200')
  assert.equal(qq.songListDetail(base, '12345'), base + '/getSongListDetail/12345')
  assert.equal(qq.playlistTracks(base, '12345'), base + '/user/playlist-detail?tid=12345&limit=100&offset=0')
  assert.equal(qq.playlists(base), base + '/user/playlist')
})

test('qq song list detail separates "unreadable" from "empty playlist"', () => {
  const readable = qq.mapSongListDetail({ response: { code: 0, cdlist: [{
    disstid: '9', dissname: '我喜欢的歌', songlist: [{ mid: 'm1', name: '歌一', singer: [{ name: '歌手' }], album: { name: '专辑' }, interval: 200 }], total_song_num: 1
  }] } })
  assert.equal(readable.readable, true)
  assert.equal(readable.name, '我喜欢的歌')
  assert.equal(readable.tracks.length, 1)
  assert.equal(readable.tracks[0].id, 'm1')
  // 不公开歌单：上游回 code 0 但没有 dissname —— 这是"读不到"，不是空歌单。
  const hidden = qq.mapSongListDetail({ response: { code: 0, cdlist: [{ disstid: '9', songlist: [] }] } })
  assert.equal(hidden.readable, false)
  assert.equal(hidden.tracks.length, 0)
})

test('qq owned playlist tracks read the paginated songs shape', () => {
  const page = qq.mapOwnedPlaylistTracks({ code: 200, songs: [
    { mid: 'm2', name: '自建歌单曲', singer: [{ name: '歌手' }], album: { name: '专辑' }, interval: 180 }
  ], total: 1, more: false })
  assert.equal(page.tracks.length, 1)
  assert.equal(page.total, 1)
  assert.equal(page.more, false)
})

test('qq QR expiry keeps the upstream failure reason instead of a bare "expired"', () => {
  const result = qq.mapQrCheck({
    code: 800,
    message: 'QR code expired',
    failureReason: 'mqtt-websocket-error',
    failureHint: { key: 'mqtt', message: '二维码通道连接失败，请检查网络后重新获取。' }
  })
  assert.equal(result.code, 800)
  assert.equal(result.detail, '二维码通道连接失败，请检查网络后重新获取。')
  // 上游只给 message 时也要透出
  assert.equal(qq.mapQrCheck({ code: 800, message: 'QR code expired' }).detail, 'QR code expired')
  // 通道查询路由存在（v6.4：手机QQ/微信/QQ音乐App 三种扫码）
  assert.equal(qq.loginChannels('http://127.0.0.1:1'), 'http://127.0.0.1:1/login/channels')
  assert.equal(qq.qrKey('http://127.0.0.1:1'), 'http://127.0.0.1:1/login/qr/key?channel=qq')
  assert.equal(qq.qrKey('http://127.0.0.1:1', 'wechat'), 'http://127.0.0.1:1/login/qr/key?channel=wechat')
})

// ---------------------------------------------------------------------------
// Meting
// ---------------------------------------------------------------------------

test('meting search recovers the song id from the API links it returns', () => {
  const json = [
    { title: '歌名', author: '作者', url: 'http://127.0.0.1:9/api?server=kugou&type=url&id=ABC123&token=t', pic: '', lrc: 'http://127.0.0.1:9/api?server=kugou&type=lrc&id=ABC123&token=t' },
    { title: '', author: 'x', url: 'http://127.0.0.1:9/api?server=kugou&type=url&id=ZZZ' }
  ]
  const tracks = meting.mapSearch(json)
  assert.equal(tracks.length, 1, 'a titleless row is dropped, not shown as blank')
  assert.equal(tracks[0].id, 'ABC123')
  assert.equal(tracks[0].artist, '作者')
  assert.equal(idFromMetingLink('not a url'), null)
})

test('the meting HMAC token matches the server formula', () => {
  // 值由独立算出的 HMAC-SHA1('token', 'neteaseurl123456') 固定在这里，
  // 这样改了公式会立刻失败，而不是两边一起改一起绿。
  assert.equal(metingToken('token', 'netease', 'url', '123456'), 'd7d40b2fe965d986752f60514962aea4e5f104bc')
})

test('the platform aliases meting expects are used', () => {
  assert.equal(metingServerFor('netease'), 'netease')
  assert.equal(metingServerFor('qq'), 'tencent', 'meting calls QQ "tencent"')
  assert.equal(metingServerFor('meting'), 'kugou')
})

test('a 302 location is only trusted when it is an absolute http(s) URL', () => {
  assert.equal(locationFromRedirect({ location: 'https://x/y.mp3' }), 'https://x/y.mp3')
  assert.equal(locationFromRedirect({ Location: 'https://x/y.mp3' }), 'https://x/y.mp3')
  assert.equal(locationFromRedirect({ location: '/relative' }), null)
  assert.equal(locationFromRedirect({}), null)
})

test('qq lyric asks for songmid, because asking for id returns 400', () => {
  const url = qq.lyric('http://127.0.0.1:1', '004Z8Ihr0JIu5s')
  assert.ok(url.includes('songmid=' + encodeURIComponent('004Z8Ihr0JIu5s')), url)
  assert.ok(!url.includes('?id='), 'the id parameter is rejected by the real server: ' + url)
})

test('qq play url reports the upstream reason from a 200 body, not a shape error', () => {
  // 实测形状（未登录/受限歌曲）
  const body = { data: { playUrl: { '004Z8Ihr0JIu5s': {
    url: '', error: '暂无播放链接', quality: '128',
    restriction: { key: 'url_unavailable', codes: { result: 104003, subcode: 1 } }
  } } } }
  assert.throws(() => qq.mapPlayUrl(body), (error) => {
    assert.ok(!(error instanceof ShapeError), 'must not be reported as an unexpected shape')
    assert.match(error.message, /暂无播放链接/)
    return true
  })
})

test('qq lyric text can arrive as { response: { lyric } }', () => {
  // 这个形状由 manager 解析；这里只钉住"不要把它当成 LRC 纯文本"的判断依据。
  const body = { response: { retcode: 0, lyric: '[00:00.00]七里香' } }
  assert.equal(typeof body.response.lyric, 'string')
  assert.ok(!JSON.stringify(body).trim().startsWith('['))
})

test('upstream set-cookie junk is stripped down to clean name=value pairs', () => {
  // 这是上游 join(';') 之后的真实形态：属性混在里面，且 `GMT;__csrf` 之间没有空格。
  const raw = 'MUSIC_U=MOCK-VALUE==; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT;__csrf=deadbeef; Path=/'
  const clean = normalizeCookie(raw)
  assert.equal(clean, 'MUSIC_U=MOCK-VALUE==; __csrf=deadbeef')
  // 带 '=' 填充的值必须完整保留（有损解析会把它整条丢掉）。
  assert.ok(clean.includes('MUSIC_U=MOCK-VALUE=='))
  // 属性绝不能留在会话里。
  for (const attribute of ['Path=', 'Expires=', 'HttpOnly', 'Max-Age']) {
    assert.ok(!clean.includes(attribute), attribute + ' must be stripped: ' + clean)
  }
})

test('normalizing is idempotent and tolerates empty input', () => {
  const raw = 'A=1; Path=/; B=two==; Expires=Wed, 01 Jan 2031 00:00:00 GMT;__csrf=x'
  const once = normalizeCookie(raw)
  assert.equal(normalizeCookie(once), once)
  assert.equal(normalizeCookie(''), '')
  assert.equal(normalizeCookie(null), '')
})

test('QQ profile is read with the field names the server actually sends', () => {
  // 服务端：{ code: 200, data: { profile } }，profile 由 getLoginProfile() 产出，
  // 账号 id 叫 musicid / str_musicid —— **没有 uin**。以前按 uin 找会把已登录判成未登录。
  const loggedIn = { code: 200, data: { profile: { musicid: '1234567', str_musicid: '1234567', nickname: '某用户', avatarUrl: 'http://a/b.jpg' } } }
  const account = qq.mapAccount(loggedIn)
  assert.equal(account.signedIn, true)
  assert.equal(account.uid, '1234567')
  assert.equal(account.nickname, '某用户')
  assert.equal(account.avatar, 'http://a/b.jpg')

  // 未登录：data 是空对象，profile 不存在。
  assert.equal(qq.mapAccount({ code: 200, data: {} }).signedIn, false)
})

test('QQ profile fields nested under info are still found', () => {
  const reply = { code: 200, data: { profile: { info: { musicid: '999', nick: '嵌套昵称' } } } }
  const account = qq.mapAccount(reply)
  assert.equal(account.signedIn, true)
  assert.equal(account.uid, '999')
  assert.equal(account.nickname, '嵌套昵称')
})

test('netease playlist search keeps name, id, count and cover', () => {
  const reply = { result: { playlists: [{ id: 123, name: '某歌单', trackCount: 42, coverImgUrl: 'http://c/1.jpg' }] } }
  const list = netease.mapSearchPlaylists(reply)
  assert.equal(list.length, 1)
  assert.deepEqual(list[0], { platform: 'netease', id: '123', name: '某歌单', trackCount: 42, cover: 'https://c/1.jpg' })
})

test('netease liked ids are read from { ids } and empty is not an error', () => {
  assert.deepEqual(netease.mapLikedIds({ ids: [1, 2, 3] }), ['1', '2', '3'])
  assert.deepEqual(netease.mapLikedIds({ ids: [] }), [])
  assert.deepEqual(netease.mapLikedIds({}), [])
})

test('qq playlist search tolerates the nested shapes and reports when it cannot', () => {
  const reply = { code: 200, data: { body: { disslist: [{ dissid: 'p1', dissname: '歌单一', song_count: 7, imgurl: 'http://c/a.jpg' }] } } }
  const list = qq.mapSearchPlaylists(reply)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'p1')
  assert.equal(list[0].trackCount, 7)
  assert.throws(() => qq.mapSearchPlaylists({ code: 200, data: { weird: true } }), /QQ 歌单搜索/)
})

test('netease search uses cloudsearch with offset paging', () => {
  const first = netease.search('http://h', '关键词', 30, 0)
  assert.ok(first.includes('/cloudsearch'), first)
  assert.ok(first.includes('type=1'), first)
  assert.ok(first.includes('offset=0'), first)
  const second = netease.search('http://h', '关键词', 30, 30)
  assert.ok(second.includes('offset=30'), second)
})

test('qq playlist list reads the real top-level { code, playlist, total, more } shape', () => {
  // 实测：服务端 userPlaylistResponse.js 的 toUserPlaylistBody 就是这四个顶层字段，
  // **没有 data 这一层**。以前只认 data.list / record.list，于是登录成功也报形状错。
  const reply = {
    code: 200,
    playlist: [
      { tid: '1001', dirName: '自建歌单一', songNum: 12, picUrl: 'http://p.qpic.cn/a.jpg' },
      { dissid: 'f-2', dissname: '收藏的歌单', song_count: 34, logo: 'http://p.qpic.cn/b.jpg' }
    ],
    total: 2,
    more: false
  }
  const list = qq.mapPlaylists(reply)
  assert.equal(list.length, 2, 'both the owned and the favourite entry map')
  assert.deepEqual(list[0], { platform: 'qq', id: '1001', name: '自建歌单一', trackCount: 12, cover: 'https://p.qpic.cn/a.jpg' })
  assert.deepEqual(list[1], { platform: 'qq', id: 'f-2', name: '收藏的歌单', trackCount: 34, cover: 'https://p.qpic.cn/b.jpg' })
})

test('qq playlist list still accepts the older nested shapes', () => {
  const nested = { code: 200, data: { list: [{ dirId: 7, name: '旧壳', songnum: 3 }] } }
  assert.equal(qq.mapPlaylists(nested)[0].id, '7')
  assert.equal(qq.mapPlaylists({ code: 200, data: { playlists: [{ tid: 9, title: '另一种' }] } })[0].name, '另一种')
  assert.throws(() => qq.mapPlaylists({ code: 200, playlist: 'nope' }), /QQ 歌单列表/)
})

test('qq playlist tracks map songmid, seconds and the album-mid cover', () => {
  const reply = {
    code: 200,
    songs: [
      { mid: '004Z8Ihr0JIu5s', name: '七里香', singer: [{ name: '周杰伦' }], album: { name: '七里香', mid: '002Z8Ihr0JIu5s' }, interval: 299 }
    ],
    total: 1,
    more: false
  }
  const [track] = qq.mapPlaylistTracks(reply)
  assert.equal(track.id, '004Z8Ihr0JIu5s')
  assert.equal(track.durationMs, 299000, 'interval is seconds')
  assert.equal(track.album, '七里香')
  assert.equal(track.cover, 'https://y.gtimg.cn/music/photo_new/T002R300x300M000002Z8Ihr0JIu5s.jpg')
  // 收藏曲目走同一套：{ code, songs } —— 与 /user/liked-songs 一致。
  const liked = qq.mapPlaylistTracks({ code: 200, songs: [{ songmid: 'm2', name: '喜欢', singer: [{ name: 'A' }], interval: 100 }] })
  assert.equal(liked[0].id, 'm2')
  assert.equal(liked[0].cover, null)
})

test('qq search pages because the server caps a page at 20', () => {
  const lower = qq.search('http://h', '关键词', 5, 1)
  const upper = qq.search('http://h', '关键词', 100, 3)
  assert.ok(lower.includes('limit=5'), lower)
  // 服务端 MAX_LIMIT=20：多要也没用，必须靠 page。
  assert.ok(upper.includes('limit=20'), upper)
  assert.ok(upper.includes('page=3'), upper)
})
