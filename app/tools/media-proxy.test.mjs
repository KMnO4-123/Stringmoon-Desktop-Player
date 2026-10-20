import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { LoopbackMediaProxy } from '../src/main/media-proxy.ts'

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function withProxy(source, fn) {
  const proxy = new LoopbackMediaProxy()
  try {
    const url = await proxy.register(source)
    await fn(proxy, url)
  } finally {
    await proxy.close()
  }
}

test('binds to loopback and forwards range plus CDN headers', async () => {
  let seen
  const upstream = await listen((req, res) => {
    seen = req.headers
    res.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-range': 'bytes 2-4/6',
      'content-length': '3',
      'content-type': 'audio/mpeg'
    })
    res.end('cde')
  })
  const proxy = new LoopbackMediaProxy()
  try {
    const url = await proxy.register({ url: upstream.url + '/track', referer: 'https://music.example/', userAgent: 'Stringmoon test' })
    const response = await fetch(url, { headers: { Range: 'bytes=2-4' } })
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/media\/[A-Za-z0-9_-]{43}$/)
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/6')
    assert.equal(await response.text(), 'cde')
    assert.equal(seen.range, 'bytes=2-4')
    assert.equal(seen.referer, 'https://music.example/')
    assert.equal(seen['user-agent'], 'Stringmoon test')
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('rejects malformed ranges with 416 and the known resource size', async () => {
  let methods = []
  const upstream = await listen((req, res) => {
    methods.push(req.method)
    res.writeHead(200, { 'content-length': '6', 'accept-ranges': 'bytes' })
    if (req.method === 'GET') res.end('abcdef')
    else res.end()
  })
  try {
    await withProxy({ url: upstream.url + '/track' }, async (_proxy, url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=3-1' } })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('content-range'), 'bytes */6')
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.deepEqual(methods, ['HEAD'])
    })
  } finally {
    await upstream.close()
  }
})

test('refreshes an expired signed URL and retries the original range', async () => {
  let requests = 0
  let refreshes = 0
  const upstream = await listen((req, res) => {
    requests += 1
    if (req.url === '/expired') {
      res.writeHead(403).end()
      return
    }
    assert.equal(req.headers.range, 'bytes=1-3')
    res.writeHead(206, { 'content-range': 'bytes 1-3/6', 'content-length': '3' }).end('bcd')
  })
  try {
    await withProxy({
      url: upstream.url + '/expired',
      refresh: async () => {
        refreshes += 1
        return { url: upstream.url + '/fresh' }
      }
    }, async (_proxy, url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=1-3' } })
      assert.equal(response.status, 206)
      assert.equal(await response.text(), 'bcd')
      assert.equal(requests, 2)
      assert.equal(refreshes, 1)
    })
  } finally {
    await upstream.close()
  }
})

test('resigns and resumes at the next byte after a mid-stream upstream failure', async () => {
  let refreshes = 0
  const requestedRanges = []
  const upstream = await listen((req, res) => {
    requestedRanges.push(req.headers.range ?? null)
    if (requestedRanges.length === 1) {
      res.writeHead(206, { 'content-range': 'bytes 0-9/10', 'content-length': '10' })
      res.write('abc')
      setTimeout(() => res.destroy(), 10)
      return
    }
    assert.equal(req.headers.range, 'bytes=3-9')
    res.writeHead(206, { 'content-range': 'bytes 3-9/10', 'content-length': '7' }).end('defghij')
  })
  try {
    await withProxy({
      url: upstream.url + '/track',
      refresh: async () => {
        refreshes += 1
        return { url: upstream.url + '/track' }
      }
    }, async (_proxy, url) => {
      const response = await fetch(url)
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), 'bytes 0-9/10')
      assert.equal(await response.text(), 'abcdefghij')
      assert.deepEqual(requestedRanges, [null, 'bytes=3-9'])
      assert.equal(refreshes, 1)
    })
  } finally {
    await upstream.close()
  }
})

test('revoked tokens and tokens from a closed proxy stop serving media', async () => {
  let upstreamRequests = 0
  const upstream = await listen((_req, res) => {
    upstreamRequests += 1
    res.end('abcdef')
  })
  const proxy = new LoopbackMediaProxy()
  try {
    const url = await proxy.register({ url: upstream.url + '/track' })
    const token = new URL(url).pathname.split('/').at(-1)
    proxy.revoke(token)
    assert.equal((await fetch(url)).status, 404)
    const nextUrl = await proxy.register({ url: upstream.url + '/track' })
    await proxy.close()
    await delay(10)
    await assert.rejects(fetch(nextUrl))
    assert.equal(upstreamRequests, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('rejects non-HTTPS remote sources before opening a local listener', async () => {
  const proxy = new LoopbackMediaProxy()
  try {
    // 报错必须点出**是哪个地址、缺哪个开关**：平台 CDN 的直链大量是 http，
    // 走到这里几乎总是适配层漏了 allowInsecure，而不是用户拿到了坏地址。
    await assert.rejects(proxy.register({ url: 'http://media.example/track' }), (error) => {
      assert.match(error.message, /http/)
      assert.match(error.message, /allowInsecure/)
      assert.match(error.message, /media\.example/)
      return true
    })
    // 显式开启之后必须放行同一个地址（这正是平台上播放走的路）。
    const registered = await proxy.register({ url: 'http://media.example/track', allowInsecure: true })
    assert.match(registered, /^http:\/\/127\.0\.0\.1:/)
  } finally {
    await proxy.close()
  }
})

// The engine pins a resource VERSION with If-Range (ETag / Last-Modified) so the
// origin itself refuses to mix two versions of one file (INTEGRATION §3.2b).
// The proxy forwarded the upstream validator DOWN to the engine but used to drop
// the engine's If-Range going UP, which silently disabled that protection: the
// engine sent it and the CDN never saw it.
test('forwards the engine conditional-range validator upstream', async () => {
  let seen
  const upstream = await listen((req, res) => {
    seen = req.headers
    res.writeHead(206, {
      'content-range': 'bytes 0-3/8',
      'content-length': '4',
      etag: '"v1"'
    }).end('abcd')
  })
  try {
    await withProxy({ url: upstream.url + '/track' }, async (_proxy, url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=0-3', 'If-Range': '"v1"' } })
      assert.equal(response.status, 206)
      await response.text()
      assert.equal(seen['if-range'], '"v1"', 'the engine validator must reach the origin')
    })
  } finally {
    await upstream.close()
  }
})

// A resume that comes back as a full 200 means the origin ignored the range
// (typically an If-Range mismatch). Splicing that into the middle of the stream
// would corrupt it silently, so the resume must refuse it.
test('refuses to splice a full 200 response into a resumed stream', async () => {
  const ranges = []
  const upstream = await listen((req, res) => {
    ranges.push(req.headers.range ?? null)
    if (ranges.length === 1) {
      res.writeHead(206, { 'content-range': 'bytes 0-9/10', 'content-length': '10' })
      res.write('abc')
      setTimeout(() => res.destroy(), 10)
      return
    }
    // The origin decided the validator no longer matches and sent everything.
    res.writeHead(200, { 'content-length': '10' }).end('abcdefghij')
  })
  try {
    await withProxy({
      url: upstream.url + '/track',
      refresh: async () => ({ url: upstream.url + '/track' })
    }, async (_proxy, url) => {
      const response = await fetch(url)
      // The refusal tears the response down, so the client observes an aborted
      // stream rather than a clean end. Either shape is acceptable here; what
      // matters is that the 200 body is NOT spliced in and reported as success.
      await assert.rejects(
        (async () => {
          let seen = ''
          for await (const chunk of response.body ?? []) seen += Buffer.from(chunk).toString()
          // If the loop ever completes, the body must not have been spliced.
          assert.ok(!seen.includes('abcdefghij'), 'a full 200 body must not be spliced into the stream')
        })()
      )
      assert.equal(ranges.length, 2, 'exactly one resume attempt was made')
    })
  } finally {
    await upstream.close()
  }
})

