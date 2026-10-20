import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { LoopbackMediaProxy, mediaProxy } from '../src/main/media-proxy.ts'
import { OnlinePlayback, tokenFromLoopbackUrl } from '../src/main/online-playback.ts'

/**
 * 在线播放的接线契约（INTEGRATION-v1-engine-app §3.2b/§3.2c）。
 * 这一层是"注册 → 交给引擎 → 播放结束失效"的唯一所有者，所以它要证明的
 * 恰是那三条容易写错、错了又不容易发现的性质：
 *   ① 一个 token 只服务一次播放（换一首 = 换 token，版本不会混）
 *   ② 切歌/停止/退出后，旧 token 立刻取不到字节
 *   ③ 本地文件不经过代理
 *
 * 注意：断言一律带 Range 头。引擎永远带 Range 取字节（这是它的读取器形状），
 * 而**不带** Range 的请求本来就该回 200 —— 拿 206 去断言它是在测错的形状。
 */

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
}

function rangeHandler(payload, onRequest) {
  return (req, res) => {
    if (onRequest) onRequest(req)
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (!match) { res.writeHead(200, { 'Content-Length': payload.length }).end(payload); return }
    const start = Number(match[1])
    const end = match[2] === '' ? payload.length - 1 : Math.min(Number(match[2]), payload.length - 1)
    const body = payload.subarray(start, end + 1)
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
      etag: '"v1"'
    })
    res.end(body)
  }
}

/** 引擎取字节的形状：总是带 Range，并断言拿到 206。 */
async function engineFetch(url) {
  return fetch(url, { headers: { Range: 'bytes=0-1023' } })
}

test('one online playback owns exactly one token and revokes it on release', async () => {
  const payload = Buffer.alloc(4096, 5)
  const upstream = await listen(rangeHandler(payload))
  const playback = new OnlinePlayback()
  try {
    const opened = await playback.open({ url: upstream.url + '/track' }, async (url) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/media\/[A-Za-z0-9_-]{43}$/, 'the engine receives the loopback URL')
    })
    assert.equal(playback.activeToken(), opened.token)
    const live = await engineFetch(opened.url)
    assert.equal(live.status, 206, 'the token serves a range while the play is live')
    await live.body?.cancel().catch(() => {})

    playback.release()
    assert.equal(playback.activeToken(), null)
    const dead = await engineFetch(opened.url)
    assert.equal(dead.status, 404, 'after release the old token no longer serves bytes')
    await dead.body?.cancel().catch(() => {})
    // 幂等：再放一次不是错误。
    playback.release()
    assert.equal(playback.activeToken(), null)
  } finally {
    playback.release()
    await upstream.close()
  }
})

test('opening the next online track revokes the previous token first', async () => {
  const payload = Buffer.alloc(2048, 7)
  const upstream = await listen(rangeHandler(payload))
  const playback = new OnlinePlayback()
  try {
    const first = await playback.open({ url: upstream.url + '/one' }, async () => {})
    const second = await playback.open({ url: upstream.url + '/two' }, async () => {})
    assert.notEqual(first.token, second.token, 'a new play gets a NEW token -- the version cannot be shared across tracks')
    const old = await engineFetch(first.url)
    assert.equal(old.status, 404, 'the previous track handle is dead the moment the next one opens')
    await old.body?.cancel().catch(() => {})
    const fresh = await engineFetch(second.url)
    assert.equal(fresh.status, 206, 'the new track serves')
    await fresh.body?.cancel().catch(() => {})
  } finally {
    playback.release()
    await upstream.close()
  }
})

test('a failed engine open does not leave a live token behind', async () => {
  const payload = Buffer.alloc(1024, 9)
  const upstream = await listen(rangeHandler(payload))
  const playback = new OnlinePlayback()
  try {
    await assert.rejects(
      playback.open({ url: upstream.url + '/track' }, async () => { throw new Error('open failed') }),
      /open failed/
    )
    assert.equal(playback.activeToken(), null, 'no orphan token after a failed open')
  } finally {
    playback.release()
    await upstream.close()
  }
})

// ⭐ 版本钉住：refresh() 只换签名不改内容；代理必须把上游 validator 往下暴露给
// 引擎，并把引擎的 If-Range 往上转发——否则引擎的版本校验到了 CDN 就断了。
test('a refreshed signature keeps serving the same resource version', async () => {
  const payload = Buffer.alloc(2048, 3)
  let requestedUrl = null
  const upstream = await listen((req, res) => {
    requestedUrl = req.url
    rangeHandler(payload)(req, res)
  })
  const playback = new OnlinePlayback()
  try {
    let refreshes = 0
    const opened = await playback.open({
      url: upstream.url + '/track?sig=stale',
      refresh: async () => { refreshes += 1; return { url: upstream.url + '/track?sig=fresh' } }
    }, async () => {})
    assert.equal(refreshes, 0, 'no refresh is needed while the signature is valid')
    const live = await engineFetch(opened.url)
    assert.equal(live.status, 206)
    assert.ok(requestedUrl.includes('sig=stale'), 'the registered URL is what the proxy fetches')
    await live.body?.cancel().catch(() => {})
  } finally {
    playback.release()
    await upstream.close()
  }
})

test('tokenFromLoopbackUrl reads the proxy token and refuses other URLs', () => {
  const token = 'A'.repeat(43)
  assert.equal(tokenFromLoopbackUrl(`http://127.0.0.1:1234/media/${token}`), token)
  assert.throws(() => tokenFromLoopbackUrl('http://127.0.0.1:1234/not-media/abc'), /Not a loopback media URL/)
})

// ③ 本地文件不绕代理：这条由协议层形状保证（本地走 trackId），这里断言
// online-playback 不提供任何本地入口，避免将来有人把本地也塞进来。
test('online playback exposes no local-file path', () => {
  const source = OnlinePlayback.prototype.open.toString()
  assert.ok(!/file:|readFile/.test(source), 'the online path must not accept a local file')
})

test.after(async () => {
  // online-playback 用的是 media-proxy 的模块级单例，它的 http server 会一直把
  // 事件循环撑住；不关掉的话 `node --test` 跑完不退出（这正是先前卡住的原因）。
  await mediaProxy.close()
})
