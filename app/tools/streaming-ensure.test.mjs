// ensureStarted 的「已启动」判据（verifier 发现的竞态）。
//
// ApiServer 在探活之前就分配端口，所以 starting 阶段 status().port 已经非 null；
// 旧 ensureStarted 用 base() 判断「已启动」，会在服务端还没监听时提前返回，
// 并发操作于是打到未就绪端口上。这里用一个「延迟 700ms 才开始监听」的假服务端
// 把这个窗口稳定地造出来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { StreamingManager } = await import('../src/main/streaming/manager.ts')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DELAYED_SERVER = `import http from 'node:http'
const port = Number(process.env.PORT)
// 故意晚 700ms 再 listen：制造「端口已分配、还没就绪」的 starting 窗口。
setTimeout(() => {
  http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 200, result: { songs: [] } }))
  }).listen(port)
}, 700)
`

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), 'twilight-ensure-'))
  const serverPath = path.join(dir, 'delayed-server.mjs')
  await writeFile(serverPath, DELAYED_SERVER, 'utf8')
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

const runtimeOf = (manager, platform) => manager.runtimes().find((runtime) => runtime.platform === platform)

test('ensureStarted does not return while the server is still starting', async () => {
  const { manager, dispose } = await makeManager()
  try {
    const explicitStart = manager.start('netease') // 不 await：模拟另一条并发启动
    await sleep(250)
    const during = runtimeOf(manager, 'netease')
    assert.equal(during.state, 'starting', 'sanity: 探活期间状态应为 starting')
    assert.ok(during.port, 'sanity: 启动中端口已经分配 —— 旧 base() 判据正是在这里误判成已启动')
    // 旧实现会在上面这个窗口直接返回，ensure 返回时状态仍是 starting。
    await manager.ensureStarted('netease')
    assert.equal(runtimeOf(manager, 'netease').state, 'ready', 'ensureStarted 必须等到真正 ready 才返回')
    await explicitStart
  } finally {
    await dispose()
  }
})

test('concurrent ensureStarted calls converge on one ready server', async () => {
  const { manager, dispose } = await makeManager()
  try {
    await Promise.all([
      manager.ensureStarted('netease'),
      manager.ensureStarted('netease'),
      manager.start('netease')
    ])
    const runtime = runtimeOf(manager, 'netease')
    assert.equal(runtime.state, 'ready', '所有并发调用返回时服务端必须已经 ready')
    assert.ok(Number.isInteger(runtime.pid) && runtime.pid > 0, '只有一个真实服务端进程')
  } finally {
    await dispose()
  }
})
