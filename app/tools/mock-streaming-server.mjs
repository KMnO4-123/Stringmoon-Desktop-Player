// 假网易云 API 服务端 —— 登录链路的可复现回归工具。
//
// 为什么需要它：真实扫码要手机，803 之后的链路（cookie 清洗、传输通道、核验判据）
// 就没有确定性验证。这个假服务端按真实形状回包，并且**严格**要求会话里：
//   · MUSIC_U 的值完整（含 '=' 填充）
//   · __csrf 没有被属性吞掉
//   · 不残留 Path=/ Expires= 这类属性
// 跑法：node tools/login-flow-check.cjs 的 electron 启动脚本（见 docs/STREAMING-v1 §13）。
// 回包形状按真实服务端：cookie 是 Set-Cookie 串用 ';' 拼起来的，值里带 '=' 填充。
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

//
// 它还提供**播放字节**（/song/url/v1 → /audio/test.wav，带 Range/ETag 的 8 秒 WAV）
// 与歌单/歌词端点，于是「登录 → 歌单 → 曲目 → 播起来 → 界面显示正在播放」这条链
// 在 tools/test-electron.cjs 里可以端到端跑，不需要真实平台账号。
/**
 * 8 秒 44.1 kHz / 16bit 立体声 WAV。引擎按字节嗅探容器，所以 URL 没有扩展名也能认出来。
 *
 * 为什么是 8 秒：e2e 里「点播放在线曲 → 回首页 → 等平台歌词」的前序步骤要 2–3 秒，
 * 3 秒测试音在机器负载高时会先自然播完（state=stopped），随后歌词断言等不到内容
 * 成为假红。8 秒既保留「进度条在走」的可观测性，又把这段竞态余量拉开。
 */
function makeWav(seconds = 8, rate = 44100, channels = 2) {
  const frames = seconds * rate
  const dataBytes = frames * channels * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000)
    buffer.writeInt16LE(value, 44 + i * channels * 2)
    buffer.writeInt16LE(value, 46 + i * channels * 2)
  }
  return buffer
}
const TEST_WAV = makeWav(8)

const COOKIE = 'MUSIC_U=MOCK-VALUE==; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT;__csrf=deadbeef; Path=/'
/**
 * 扫码检查的可控模式（供 e2e 覆盖 UI 状态机；默认 fast = 保持既有行为）。
 *
 *   fast      默认：/login/qr/check 直接 803 + cookie（既有 e2e 依赖这个行为，不能变）
 *   sequence  /login/qr/key 重置计数；第一次 check → 802（已扫描），第二次 → 803（成功）
 *   expired   check → 800（二维码过期）
 *   error     check → HTTP 500 + 文本 body（含 "502" 字样）。为什么不直接回 500 干净 JSON：
 *             主进程 qrRequest 只对 /502|ECONNRESET|socket hang up|fetch failed|Failed to fetch/
 *             这类「瞬时失败」重试一次；干净的 HTTP 500 会被当成终态、根本不重试。
 *             这里用「500 + 含 502 的文本」既符合真实服务端「风控/网关错误被吞成 500」的
 *             形状，又能让既有的瞬时重试路径真的跑一次 —— 两次都失败后 UI 进入 error 态。
 * 控制端点（仅测试用，不参与平台协议）：
 *   GET  /mock/qr-mode        → { mode, checks }
 *   POST /mock/qr-mode {mode} → 切换模式并重置计数；非法模式/畸形 JSON → 400
 */
const QR_MODES = new Set(['fast', 'sequence', 'expired', 'error'])
let qrMode = 'fast'
let qrChecks = 0
const seen = []
const log = () => { try { writeFileSync(process.env.MOCK_LOG || 'mock-log.json', JSON.stringify(seen, null, 1)) } catch {} }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const header = req.headers.cookie || ''
  const query = url.searchParams.get('cookie') || ''
  const effective = query || header
  seen.push({ path: url.pathname, header, query })
  log()
  const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

  // ---- 测试控制面：切换 /login/qr/check 的返回模式 ----
  if (url.pathname === '/mock/qr-mode') {
    if (req.method === 'GET') return json({ mode: qrMode, checks: qrChecks })
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST' })
      return res.end(JSON.stringify({ code: 405, message: 'mock: 只支持 GET/POST' }))
    }
    let body = ''
    let rejected = false
    req.on('data', chunk => {
      body += chunk
      // 控制面不需要大 body：超过 4KB 直接断，避免假服务端被误用成上传通道。
      if (body.length > 4096) { rejected = true; req.destroy() }
    })
    req.on('end', () => {
      if (rejected || res.destroyed) return
      let mode
      try {
        mode = JSON.parse(body || '{}').mode
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ code: 400, message: 'mock: POST body 必须是 JSON' }))
      }
      if (!QR_MODES.has(mode)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ code: 400, message: 'mock: 未知 mode ' + String(mode) + '（支持 ' + [...QR_MODES].join('/') + '）' }))
      }
      qrMode = mode
      qrChecks = 0
      return json({ mode: qrMode, checks: qrChecks })
    })
    return
  }
  if (url.pathname === '/login/channels') {
    // QQ 服务端的能力查询（v6.4）：三条扫码通道 + 会话模式。mock 同时服务两个平台，
    // 网易云侧不会调它，所以这里照 QQ 的形状回。
    return json({ code: 200, data: { channels: ['qq', 'wechat', 'qqmusic'], sessionMode: 'stored', configured: true } })
  }
  if (url.pathname === '/login/qr/key') {
    // 每轮二维码生成都重置 sequence 的计数（否则第二次登录会直接 803）。
    qrChecks = 0
    return json({ code: 200, data: { code: 200, unikey: 'mock-key-123' } })
  }
  if (url.pathname === '/login/qr/create') return json({ code: 200, data: { qrurl: 'https://music.163.com/login?codekey=mock', qrimg: 'data:image/png;base64,AAAA' } })
  if (url.pathname === '/login/qr/check') {
    if (qrMode === 'error') {
      // 见文件头的模式说明：500 + 含 "502" 的文本，让主进程的瞬时重试路径真的走一次。
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('mock qr check simulated upstream failure (502)')
    }
    if (qrMode === 'expired') return json({ code: 800, message: '二维码已过期' })
    if (qrMode === 'sequence') {
      qrChecks += 1
      if (qrChecks === 1) return json({ code: 802, message: '已扫描，等待确认' })
      return json({ code: 803, message: '授权登陆成功', cookie: COOKIE })
    }
    return json({ code: 803, message: '授权登陆成功', cookie: COOKIE })
  }
  // ---- 网易云形状（同一个假服务端同时伺候两个平台的形状）----
  if (url.pathname === '/likelist') return json({ code: 200, ids: [101, 102, 103] })
  if (url.pathname === '/song/detail') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean)
    return json({ songs: ids.map(id => ({ id: Number(id), name: '收藏曲 ' + id, ar: [{ name: '歌手' + id }], al: { name: '专辑' }, dt: 200000 })) })
  }
  if (url.pathname === '/cloudsearch' && url.searchParams.get('type') === '1') {
    // 分页：offset=0 回 30 条，offset=30 回 5 条，用来验证「加载更多」。
    const offset = Number(url.searchParams.get('offset') || 0)
    const limit = Number(url.searchParams.get('limit') || 30)
    const total = 35
    const songs = []
    for (let index = offset; index < Math.min(total, offset + limit); index++) {
      songs.push({ id: 1000 + index, name: '歌曲 ' + index, ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 200000 })
    }
    return json({ result: { songs, songCount: total } })
  }
  if (url.pathname === '/cloudsearch') return json({ result: { playlists: [
    { id: 9001, name: '搜索歌单一', trackCount: 21, coverImgUrl: 'http://c/9a.jpg' },
    { id: 9002, name: '搜索歌单二', trackCount: 8, coverImgUrl: 'http://c/9b.jpg' }
  ] } })
  if (url.pathname === '/user/liked-songs') return json({ code: 200, data: { list: [
    { mid: 'a1', name: '收藏曲一', singer: [{ name: '歌手A' }], album: { name: '专辑A' }, interval: 200 },
    { mid: 'a2', name: '收藏曲二', singer: [{ name: '歌手B' }], album: { name: '专辑B' }, interval: 180 }
  ] } })
  if (url.pathname === '/search' && url.searchParams.get('type') === 'playlist') {
    return json({ code: 200, data: { body: { disslist: [
      { dissid: 'p1', dissname: '搜索结果歌单一', song_count: 12, imgurl: 'http://x/p1.jpg' },
      { dissid: 'p2', dissname: '搜索结果歌单二', song_count: 34, imgurl: 'http://x/p2.jpg' }
    ] } } })
  }
  // ---- 在线播放用的假音频（让「播了但界面没反应」这条链能被真实驱动）----
  if (url.pathname === '/audio/test.wav' && (req.method === 'GET' || req.method === 'HEAD')) {
    const body = TEST_WAV
    const etag = 'W/"mock-wav-1"'
    const range = req.headers.range
    const match = typeof range === 'string' ? /bytes=(\d*)-(\d*)/.exec(range) : null
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1
      const slice = body.subarray(start, end + 1)
      res.writeHead(206, {
        'content-type': 'audio/wav', 'accept-ranges': 'bytes', etag,
        'content-range': 'bytes ' + start + '-' + end + '/' + body.length,
        'content-length': String(slice.length)
      })
      return res.end(req.method === 'HEAD' ? undefined : slice)
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', etag, 'content-length': String(body.length) })
    return res.end(req.method === 'HEAD' ? undefined : body)
  }
  if (url.pathname.startsWith('/song/url')) {
    return json({ code: 200, data: [{ id: Number(url.searchParams.get('id') || 0), url: 'http://127.0.0.1:' + server.address().port + '/audio/test.wav', br: 320000, type: 'wav', size: TEST_WAV.length, code: 200 }] })
  }
  if (url.pathname === '/user/playlist') {
    // 带 uid = 网易云形状（record.playlist）；不带 uid = QQ 形状（顶层 { code, playlist, total, more }）。
    // 后者才是真实 QQ 服务端的形状，也是这一轮修掉的那个洞。
    const entry = { id: 7001, tid: '7001', name: '我的歌单一', dirName: '我的歌单一', trackCount: 2, songNum: 2, coverImgUrl: 'http://c/p1.jpg', picUrl: 'http://c/p1.jpg' }
    if (url.searchParams.get('uid')) return json({ code: 200, more: false, total: 1, playlist: [entry] })
    return json({ code: 200, playlist: [entry], total: 1, more: false })
  }
  if (url.pathname === '/playlist/track/all' || url.pathname === '/user/playlist-detail') {
    return json({ code: 200, songs: [
      { id: 1001, mid: 'online-mid-1', name: '在线曲一', ar: [{ name: '在线歌手' }], singer: [{ name: '在线歌手' }], al: { name: '在线专辑', picUrl: 'http://c/x.jpg' }, album: { name: '在线专辑', mid: 'am1' }, dt: 3200, interval: 3 },
      { id: 1002, mid: 'online-mid-2', name: '在线曲二', ar: [{ name: '在线歌手' }], singer: [{ name: '在线歌手' }], al: { name: '在线专辑' }, album: { name: '在线专辑', mid: 'am2' }, dt: 3200, interval: 3 }
    ], total: 2, more: false })
  }
  if (url.pathname === '/lyric') {
    return json({ code: 200, lrc: { lyric: '[00:00.00]在线第一行\n[00:01.50]在线第二行' }, tlyric: { lyric: '' }, yrc: { lyric: '' } })
  }
  // ---- QQ 音乐发现页（v6.3）：形状照 @yakult-green-tea/qq-music-api 3.3.x ----
  // 路由清单：/user/daily-songs、/recommend/radar、/recommend/toplists、
  // /recommend/toplist、/recommend/playlists、/getSongListDetail/:disstid。
  if (url.pathname === '/recommend/radar') {
    const page = Number(url.searchParams.get('page') || 1)
    const songs = [0, 1, 2].map(index => ({
      mid: 'qq-radar-' + page + '-' + index, id: 9100 + index, name: '雷达歌曲 ' + index,
      singer: [{ name: 'QQ 歌手' }], album: { name: 'QQ 专辑', mid: 'qqam' + index }, interval: 245
    }))
    return json({ code: 200, page, songs, more: page < 3 })
  }
  if (url.pathname === '/recommend/toplists') {
    return json({ code: 200, groups: [
      { id: 1, name: '巅峰榜', toplists: [
        { id: 26, title: '热歌榜', intro: 'QQ 音乐热歌', cover: 'http://c/qqtop1.jpg', totalNum: 100, listenNum: 1200000, updateTime: '每天更新' },
        { id: 27, title: '新歌榜', intro: '最新上架', cover: 'http://c/qqtop2.jpg', totalNum: 100, listenNum: 800000, updateTime: '每天更新' }
      ] },
      { id: 2, name: '特色榜', toplists: [
        { id: 62, title: '飙升榜', intro: '上升最快', cover: 'http://c/qqtop3.jpg', totalNum: 100, listenNum: 600000, updateTime: '每小时更新' },
        { id: 58, title: '古风榜', intro: '国风专区', cover: 'http://c/qqtop4.jpg', totalNum: 100, listenNum: 300000, updateTime: '每周更新' }
      ] }
    ] })
  }
  if (url.pathname === '/recommend/toplist') {
    const id = Number(url.searchParams.get('id') || 26)
    return json({ code: 200, toplist: { id, title: 'QQ 榜单 ' + id }, songs: [
      { mid: 'qq-top-' + id + '-1', name: '榜单曲一', singer: [{ name: '榜单歌手' }], album: { name: '榜单专辑', mid: 'qqa1' }, interval: 200 },
      { mid: 'qq-top-' + id + '-2', name: '榜单曲二', singer: [{ name: '榜单歌手' }], album: { name: '榜单专辑', mid: 'qqa2' }, interval: 180 }
    ] })
  }
  if (url.pathname === '/recommend/playlists') {
    return json({ code: 200, playlists: [
      { tid: 710001, title: 'QQ 推荐歌单一', picurl: 'http://c/qqp1.jpg', songnum: 42, play_cnt: 23456, creator: { nick: 'QQ 创建者' } },
      { tid: 710002, title: 'QQ 推荐歌单二', picurl: 'http://c/qqp2.jpg', songnum: 18, play_cnt: 9876, creator: { nick: 'QQ 创建者' } },
      { tid: 710003, title: 'QQ 推荐歌单三', picurl: 'http://c/qqp3.jpg', songnum: 30, play_cnt: 4567, creator: { nick: 'QQ 创建者' } }
    ], more: false })
  }
  if (url.pathname.startsWith('/getSongListDetail/')) {
    const id = decodeURIComponent(url.pathname.slice('/getSongListDetail/'.length))
    return json({ response: { code: 0, cdlist: [{ disstid: id, dissname: 'QQ 歌单 ' + id, songlist: [
      { mid: 'qq-list-' + id + '-1', name: '歌单曲一', singer: [{ name: '歌单歌手' }], album: { name: '歌单专辑', mid: 'qqb1' }, interval: 210 },
      { mid: 'qq-list-' + id + '-2', name: '歌单曲二', singer: [{ name: '歌单歌手' }], album: { name: '歌单专辑', mid: 'qqb2' }, interval: 190 }
    ] }] } })
  }
  if (url.pathname === '/user/daily-songs') {
    // QQ 的每日 30 首必须登录；e2e 里 QQ 是未登录态，这条按真实服务端回 401 的形状。
    return json({ code: 401, errorKey: 'auth-missing', message: '需要登录' }, 401)
  }
  // ---- 发现页端点（v4）：形状与真实 @neteasecloudmusicapienhanced/api 一致 ----
  // 未登录时真实服务端对这三个接口回 code=301/200 但数据为空；这里按 cookie 是否
  // 有效（/login/status 同一判据）决定「有没有个性化数据」，让 e2e 能同时覆盖
  // 已登录/未登录两条降级路径，而不是只测一条。
  if (url.pathname === '/recommend/songs') {
    const signedIn = effective.includes('MUSIC_U=MOCK-VALUE==')
    const dailySongs = signedIn
      ? [0, 1, 2, 3, 4, 5].map(index => ({ id: 5000 + index, name: '每日推荐 ' + index, ar: [{ name: '推荐歌手' }], al: { name: '推荐专辑', picUrl: 'http://c/d' + index + '.jpg' }, dt: 210000 }))
      : []
    return json({ code: 200, data: { dailySongs } })
  }
  if (url.pathname === '/personal/fm/mode' || url.pathname === '/personal_fm') {
    const signedIn = effective.includes('MUSIC_U=MOCK-VALUE==')
    const rows = signedIn
      ? [0, 1, 2].map(index => ({ id: 6000 + index, name: '漫游 ' + index, ar: [{ name: '漫游歌手' }], al: { name: '漫游专辑' }, dt: 180000 }))
      : []
    return json({ code: 200, data: rows })
  }
  if (url.pathname === '/toplist/detail') {
    // 榜单是免登录内容：即使 cookie 无效也必须给数据（这正是发现页对未登录用户
    // 仍然有用的原因），所以这里不判 signedIn。
    return json({ code: 200, list: [
      { id: 19723756, name: '飙升榜', coverImgUrl: 'http://c/top1.jpg', description: '实时热度', updateFrequency: '每天更新', trackCount: 100, playCount: 9000000, ToplistType: 'S' },
      { id: 3779629, name: '新歌榜', coverImgUrl: 'http://c/top2.jpg', description: '最新单曲', updateFrequency: '每天更新', trackCount: 100, playCount: 7000000 },
      { id: 2884035, name: '原创榜', coverImgUrl: 'http://c/top3.jpg', description: '独立原创', updateFrequency: '每周更新', trackCount: 100, playCount: 5000000 },
      { id: 3778678, name: '热歌榜', coverImgUrl: 'http://c/top4.jpg', description: '热门单曲', updateFrequency: '每天更新', trackCount: 100, playCount: 8000000 },
      { id: 8888888, name: '冷门榜', coverImgUrl: 'http://c/top5.jpg', description: '更多榜单', updateFrequency: '每周更新', trackCount: 50, playCount: 100000 }
    ] })
  }
  if (url.pathname === '/recommend/resource') {
    const signedIn = effective.includes('MUSIC_U=MOCK-VALUE==')
    const recommend = signedIn
      ? [{ id: 7101, name: '推荐歌单一', picUrl: 'http://c/r1.jpg', trackCount: 20, playCount: 123456 }]
      : []
    return json({ code: 200, recommend })
  }
  if (url.pathname === '/top/playlist' || url.pathname === '/top/playlist/highquality') {
    const offset = Number(url.searchParams.get('offset') || 0)
    const limit = Number(url.searchParams.get('limit') || 30)
    const total = 45
    const playlists = []
    for (let index = offset; index < Math.min(total, offset + limit); index++) {
      playlists.push({ id: 8000 + index, name: '发现歌单 ' + index, coverImgUrl: 'http://c/p' + index + '.jpg', trackCount: 12 + index, playCount: 1000 * (index + 1), creator: { nickname: '创建者' } })
    }
    return json({ code: 200, playlists, total, more: offset + limit < total })
  }
  if (url.pathname === '/login/status') {
    // 按真实服务端的需要来判：值里的 '=' 必须完整、__csrf 不能被属性吞掉、
    // 属性（Path/Expires）不该出现在会话里。
    const ok = effective.includes('MUSIC_U=MOCK-VALUE==')
      && effective.includes('__csrf=deadbeef')
      && !/Path=|Expires=/.test(effective)
    return json({ data: { code: 200, account: { id: 42, type: ok ? 1 : 1000 },
      profile: ok ? { userId: 42, nickname: '模拟用户', avatarUrl: 'http://x/y.png' } : null } })
  }
  json({ code: 404, message: 'mock: 未实现 ' + url.pathname })
})
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log('mock listening on ' + server.address().port))