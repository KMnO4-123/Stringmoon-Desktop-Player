// Mock GD 音乐台（music-api.gdstudio.xyz 的可控替身）—— 给 e2e / verifier 做离线可回归验证。
//
// 设计目标（对应 Lead 的 e2e 可测性要求）：
//  - 覆盖 search / url / lyric / pic / playlist / embeat_by_track 六种 types；
//  - 自带两个关键 fixture：
//      1) embeat_by_track 默认 **HTTP 200 + 空数组** —— 用来验证「空数组也要降级」；
//      2) pic 返回的图片 URL 声明 image/jpeg，实际字节是 PNG —— 用来验证 magic bytes 判定；
//  - /audio/test.wav 支持 Range（引擎媒体代理会发 Range 并校验 206/Content-Range）。
//
// 用法：
//   node tools/mock-gdstudio.mjs             # 动态端口，打印 "mock gd listening on <port>"
//   TWILIGHT_GD_API_BASE=http://127.0.0.1:<port>/ node tools/test-electron.cjs
//   CONTROL: GET /mock/gd-log 看请求日志; POST /mock/gd-mode {"embeat":"ok"} 切 fixture。
import { createServer } from 'node:http'

const WAV_RATE = 44100
const WAV_CHANNELS = 2
const WAV_SECONDS = 3

function makeWav() {
  const frames = WAV_RATE * WAV_SECONDS
  const dataBytes = frames * WAV_CHANNELS * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(WAV_CHANNELS, 22)
  buffer.writeUInt32LE(WAV_RATE, 24)
  buffer.writeUInt32LE(WAV_RATE * WAV_CHANNELS * 2, 28)
  buffer.writeUInt16LE(WAV_CHANNELS * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  // 440Hz 正弦（音量很低）：引擎能正常解码，演示/验证都够用。
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / WAV_RATE) * 1200)
    for (let channel = 0; channel < WAV_CHANNELS; channel += 1) {
      buffer.writeInt16LE(sample, 44 + (i * WAV_CHANNELS + channel) * 2)
    }
  }
  return buffer
}

// 1x1 红色 PNG（声明成 image/jpeg 的那个 fixture 就用它）。
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c6360f8cf00000301010018dd8db10000000049454e44ae426082',
  'hex'
)

const SEARCH_ROWS = [
  {
    id: '1001', name: '晴天', artist: ['周杰伦'], album: '叶惠美',
    pic_id: 'p1001', url_id: 'u1001', lyric_id: 'l1001', source: 'netease', from: 'music.gdstudio.xyz'
  },
  {
    id: '1002', name: '七里香', artist: ['周杰伦', '方文山'], album: '七里香',
    pic_id: 'p1002', url_id: 'u1002', lyric_id: 'l1002', source: 'netease', from: 'music.gdstudio.xyz'
  },
  {
    id: '2001', name: '搁浅', artist: ['周杰倫'], album: '七里香',
    pic_id: 'p2001', url_id: 'u2001', lyric_id: 'l2001', source: 'joox', from: 'music.gdstudio.xyz'
  }
]

const LYRICS = '[00:00.00] mock 歌词第一行\n[00:05.50] mock 歌词第二行\n'

/**
 * 启动 mock GD 服务；返回 { port, baseUrl, close, log }。
 * 单测可以直接 import 这个函数；e2e 用 CLI 拉起即可。
 */
export async function createMockGdServer(options = {}) {
  const wav = makeWav()
  const log = []
  const state = { embeat: options.embeat ?? 'empty' }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    log.push(request.method + ' ' + url.pathname + '?' + url.searchParams.toString())
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers })
      response.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (url.pathname === '/mock/gd-log') return send(200, log)
    if (url.pathname === '/mock/gd-mode') {
      if (request.method === 'POST') {
        let raw = ''
        request.on('data', chunk => { raw += chunk })
        request.on('end', () => {
          try {
            const body = JSON.parse(raw || '{}')
            if (body && (body.embeat === 'empty' || body.embeat === 'ok')) state.embeat = body.embeat
            send(200, { ok: true, embeat: state.embeat })
          } catch { send(400, { detail: 'bad json' }) }
        })
        return
      }
      return send(200, { embeat: state.embeat })
    }
    if (url.pathname === '/image/spoof.jpg') {
      // fixture：Content-Type 说 jpeg，字节是 PNG（客户端必须按 magic 判定）。
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PNG_BYTES.length) })
      return response.end(PNG_BYTES)
    }
    if (url.pathname === '/audio/test.wav') {
      const range = request.headers.range
      if (!range) {
        response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length), 'accept-ranges': 'bytes' })
        return response.end(wav)
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range))
      if (!match) {
        response.writeHead(416, { 'content-range': 'bytes */' + wav.length })
        return response.end()
      }
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1
      if (!Number.isFinite(start) || start >= wav.length || end < start) {
        response.writeHead(416, { 'content-range': 'bytes */' + wav.length })
        return response.end()
      }
      const chunk = wav.subarray(start, end + 1)
      response.writeHead(206, {
        'content-type': 'audio/wav',
        'content-range': 'bytes ' + start + '-' + end + '/' + wav.length,
        'content-length': String(chunk.length),
        'accept-ranges': 'bytes'
      })
      return response.end(chunk)
    }
    if (url.pathname !== '/api.php' && url.pathname !== '/') return send(404, { detail: 'not found' })
    const types = url.searchParams.get('types')
    const source = url.searchParams.get('source') ?? 'netease'
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    if (types === 'search') {
      const name = url.searchParams.get('name') ?? ''
      if (source === 'tencent') return send(400, { detail: 'Value of source is not supported.' })
      const count = Number(url.searchParams.get('count') ?? '30')
      const rows = SEARCH_ROWS.filter(row => row.source === source)
      return send(200, rows.slice(0, Math.max(1, Math.min(50, Number.isFinite(count) ? count : 30))))
    }
    if (types === 'url') {
      const br = url.searchParams.get('br')
      const bitrate = br ? Number(br) : 918
      return send(200, { url: baseUrl + '/audio/test.wav', br: Number.isFinite(bitrate) ? bitrate : 918, size: wav.length, from: 'mock' })
    }
    if (types === 'lyric') return send(200, { lyric: LYRICS, tlyric: '', from: 'mock' })
    if (types === 'pic') return send(200, { url: baseUrl + '/image/spoof.jpg', from: 'mock' })
    if (types === 'playlist') {
      return send(200, {
        code: 200,
        playlist: {
          name: 'mock 歌单',
          tracks: SEARCH_ROWS.map(row => ({
            id: row.id, name: row.name, ar: row.artist.map(name => ({ name })), al: { name: row.album, picUrl: 'http://127.0.0.1:' + server.address().port + '/image/spoof.jpg' }, dt: 180000
          }))
        }
      })
    }
    if (types === 'embeat_by_track') {
      // fixture 1：默认 200 + 空数组（降级路径）；mode=ok 时返回一条模型推荐。
      if (state.embeat === 'ok') return send(200, [SEARCH_ROWS[1]])
      return send(200, [])
    }
    return send(400, { detail: 'unsupported types: ' + String(types) })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = server.address().port
  return {
    port,
    baseUrl: 'http://127.0.0.1:' + port + '/',
    log,
    async close() {
      await new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('mock-gdstudio.mjs')) {
  const mock = await createMockGdServer({ port: Number(process.env.PORT ?? 0) })
  console.log('mock gd listening on ' + mock.port + ' at ' + mock.baseUrl)
}
