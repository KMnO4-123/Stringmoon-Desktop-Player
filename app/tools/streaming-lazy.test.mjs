// A1（CR-023）按需启动 + 空闲休眠的服务端生命周期测试。
//
// 不启动 Electron：这里只验证「进程该不该存在」，用的是本地 node 假服务端
//（只监听随机端口，不访问任何真实平台）。TWILIGHT_STREAMING_IDLE_MS 必须在
// import manager 之前设置 —— IDLE_STOP_MS 是模块加载时求值的常量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TWILIGHT_STREAMING_IDLE_MS = '1200'
const { StreamingManager } = await import('../src/main/streaming/manager.ts')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FAKE_SERVER = `import http from 'node:http'
const port = Number(process.env.PORT)
// 平台服务端的最小形状：监听端口 + 回一个合法 JSON。测试只关心进程生命周期，
// 不关心平台接口本身（那由 adapters 的测试覆盖）。
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  // 几种回包形状的并集：搜索/歌单/封面探测都走同一个假服务端。
  response.end(JSON.stringify({ code: 200, result: { songs: [] }, data: {}, playlist: [], songs: [] }))
}).listen(port)
`

async function makeManager({ lazyStart = true, command } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'twilight-streaming-lazy-'))
  const serverPath = path.join(dir, 'fake-server.mjs')
  await writeFile(serverPath, FAKE_SERVER, 'utf8')
  const manager = new StreamingManager()
  // secrets 文件不存在 → loadSecrets 直接返回 {}，不会触碰 Electron 的 safeStorage。
  manager.configure(path.join(dir, 'streaming.json'), path.join(dir, 'secrets.json'))
  await manager.saveConfig({
    version: 1,
    lazyStart,
    providers: [
      { platform: 'netease', command: command ?? ('node "' + serverPath + '"'), enabled: true, quality: 'exhigh' },
      { platform: 'qq', command: command ?? ('node "' + serverPath + '"'), enabled: true, quality: 'best' },
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

const stateOf = (manager, platform) => manager.runtimes().find((runtime) => runtime.platform === platform)?.state

test('lazy start launches nothing until the first platform operation', async () => {
  const { manager, dispose } = await makeManager()
  try {
    await manager.startOnLaunch()
    // GD 音乐台是内置 HTTP 源（没有服务端进程，运行时恒 ready）；这里只断言「需要进程的平台」。
    assert.deepEqual(manager.runtimes().filter((runtime) => runtime.platform !== 'gdstudio').map((runtime) => runtime.state),
      ['stopped', 'stopped', 'stopped'], '按需启动模式：应用启动阶段不允许拉起任何平台服务端')
    assert.equal(stateOf(manager, 'gdstudio'), 'ready', '内置 HTTP 源没有进程可启动，如实报 ready')
    await manager.ensureStarted('netease')
    assert.equal(stateOf(manager, 'netease'), 'ready', '第一次平台操作才把服务端拉起来')
  } finally {
    await dispose()
  }
})

test('an idle server is stopped again by the sweeper', async () => {
  const { manager, dispose } = await makeManager()
  try {
    await manager.startOnLaunch()
    await manager.ensureStarted('netease')
    assert.equal(stateOf(manager, 'netease'), 'ready')
    // 阈值 1200ms、巡检 300ms：等两轮阈值即可，验证脚本绝不等产品的 10 分钟。
    // 余量放宽到 2.5 倍：本机常与其它 agent 的构建/测量并行，太小会抖成假红。
    await sleep(3000)
    assert.equal(stateOf(manager, 'netease'), 'stopped', '空闲超过阈值后服务端必须被停掉')
  } finally {
    await dispose()
  }
})

test('playback hold postpones the idle stop', async () => {
  const { manager, dispose } = await makeManager()
  try {
    await manager.startOnLaunch()
    await manager.ensureStarted('netease')
    manager.setPlaybackHold('netease')
    await sleep(2400)
    assert.equal(stateOf(manager, 'netease'), 'ready', '正在播放时绝不能被停')
    manager.setPlaybackHold(null)
    await sleep(2400)
    assert.equal(stateOf(manager, 'netease'), 'stopped')
  } finally {
    await dispose()
  }
})

test('lazyStart=false keeps the old boot-time auto start', async () => {
  const { manager, dispose } = await makeManager({ lazyStart: false })
  try {
    await manager.startOnLaunch()
    assert.equal(stateOf(manager, 'netease'), 'ready', '回退开关：启动即拉起 enabled 的平台')
  } finally {
    await dispose()
  }
})

test('a failed provider is not silently restarted by the next operation', async () => {
  const { manager, dispose } = await makeManager({ command: 'twilight-definitely-not-a-real-binary' })
  try {
    await manager.startOnLaunch()
    await assert.rejects(() => manager.ensureStarted('netease'), /无法启动服务端|服务端/)
    assert.equal(stateOf(manager, 'netease'), 'failed')
    // 第二次操作不再自动重启：直接带着上一次的失败原因拒绝（否则每个搜索请求
    // 都会再打一遍 90 秒超时）。
    await assert.rejects(() => manager.ensureStarted('netease'))
  } finally {
    await dispose()
  }
})
test('an idle-stopped provider is woken up by playlists() and coverFor()', async () => {
  // verifier 发现：空闲停服后打开歌单会直接撞上「服务端没有在运行」。
  // 所有真会发请求的公开入口都必须先 ensureStarted。
  const { manager, dispose } = await makeManager()
  try {
    await manager.startOnLaunch()
    assert.equal(stateOf(manager, 'qq'), 'stopped')
    await manager.playlists('qq')
    assert.equal(stateOf(manager, 'qq'), 'ready', 'playlists 必须负责把服务端叫起来')
    await manager.stop('qq')
    assert.equal(stateOf(manager, 'qq'), 'stopped')
    const cover = await manager.coverFor('qq', 'x')
    assert.equal(cover, null, '封面取不到时仍按契约返回 null')
    assert.equal(stateOf(manager, 'qq'), 'ready', 'coverFor 也必须先把服务端叫起来，而不是静默返回 null')
  } finally {
    await dispose()
  }
})

test('saving config without lazyStart keeps the existing choice', async () => {
  // verifier 发现：渲染层保存启动命令/音质时不带 lazyStart，sanitizeConfig 缺省 true
  // 会把用户显式选的 false 静默复位。约定：字段缺省 = 保持当前值。
  const { manager, dispose } = await makeManager({ lazyStart: false })
  try {
    const current = manager.getConfig()
    assert.equal(current.lazyStart, false)
    const saved = await manager.saveConfig({ version: 1, providers: current.providers })
    assert.equal(saved.lazyStart, false, '缺省字段不能把显式 false 复位成 true')
    const explicit = await manager.saveConfig({ version: 1, lazyStart: true, providers: current.providers })
    assert.equal(explicit.lazyStart, true, '显式 true 仍然可以改')
  } finally {
    await dispose()
  }
})
