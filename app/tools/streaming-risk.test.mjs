// CONTRACT §5 风控熔断：-460（body 里的 Cheating）与 403/418（裸状态码）必须让
// 该平台**立即停止全部请求**，而不是逐次重试（重试会加重封禁、波及主账号）。
// 这里用本地假服务端满足 ensureStarted，再用全局 fetch 桩模拟上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { StreamingManager } = await import('../src/main/streaming/manager.ts')

const FAKE_SERVER = `import http from 'node:http'
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end('{}')
}).listen(Number(process.env.PORT))
`

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), 'twilight-risk-'))
  const serverPath = path.join(dir, 'fake-server.mjs')
  await writeFile(serverPath, FAKE_SERVER, 'utf8')
  const manager = new StreamingManager()
  manager.configure(path.join(dir, 'streaming.json'), path.join(dir, 'secrets.json'))
  await manager.saveConfig({
    version: 1,
    lazyStart: true,
    providers: [
      { platform: 'netease', command: 'node "' + serverPath + '"', enabled: true, quality: 'exhigh' },
      { platform: 'qq', command: 'node "' + serverPath + '"', enabled: true, quality: 'best' },
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

test('a -460 body blocks the platform and no later request reaches the upstream', async () => {
  const { manager, dispose } = await makeManager()
  const originalFetch = globalThis.fetch
  let upstreamCalls = 0
  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1
      return new Response(JSON.stringify({ code: -460, message: 'Cheating' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    await assert.rejects(() => manager.search('netease', 'x'), /风控|Cheating/)
    const callsAfterFirst = upstreamCalls
    assert.ok(callsAfterFirst >= 1, '第一次请求确实打到了上游')
    // 熔断后的第二次请求：在 checkBlocked 就拒绝，不得再打上游。
    await assert.rejects(() => manager.search('netease', 'x'), /已暂停|10 分钟/)
    assert.equal(upstreamCalls, callsAfterFirst, '熔断后不得再发任何上游请求')
  } finally {
    globalThis.fetch = originalFetch
    await dispose()
  }
})

test('a bare 403 is treated as risk control at the request layer', async () => {
  const { manager, dispose } = await makeManager()
  const originalFetch = globalThis.fetch
  let upstreamCalls = 0
  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1
      return new Response('', { status: 403 })
    }
    await assert.rejects(() => manager.search('qq', 'x'), /风控|403/)
    const callsAfterFirst = upstreamCalls
    await assert.rejects(() => manager.search('qq', 'x'), /已暂停|10 分钟/)
    assert.equal(upstreamCalls, callsAfterFirst)
  } finally {
    globalThis.fetch = originalFetch
    await dispose()
  }
})

test('a risk code hidden in a non-2xx JSON body also blocks', async () => {
  const { manager, dispose } = await makeManager()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: -460, message: 'Cheating' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
    await assert.rejects(() => manager.search('netease', 'x'), /风控|Cheating/)
    // 已进入熔断：后续请求直接拒绝。
    await assert.rejects(() => manager.search('netease', 'x'), /已暂停/)
  } finally {
    globalThis.fetch = originalFetch
    await dispose()
  }
})
