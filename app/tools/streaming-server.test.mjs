import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiServer, pickFreePort, probeHttp, resolveSpawn } from '../src/main/streaming/api-server.ts'
import { PLATFORM_SPECS, sanitizeConfig } from '../src/shared/streaming.ts'

// 一个真正会监听端口的"服务端"，用 node 自己起，不碰外网。
const FAKE_SERVER = "require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(process.env.PORT,'127.0.0.1')"
const command = JSON.stringify(process.execPath) + ' -e "' + FAKE_SERVER.replace(/"/g, '\\"') + '"'

test('a free port is actually free and bindable', async () => {
  const port = await pickFreePort()
  assert.ok(port > 1024 && port < 65536, 'got a plausible port: ' + port)
  assert.equal(await probeHttp(port, '/', 300), false, 'nothing is listening on it yet')
})

test('npm-family commands are wrapped for Windows so they can spawn at all', () => {
  const spawn = resolveSpawn('npx -y @neteasecloudmusicapienhanced/api')
  if (process.platform === 'win32') {
    assert.equal(spawn.file, 'cmd.exe')
    assert.deepEqual(spawn.args.slice(0, 3), ['/d', '/s', '/c'])
  } else {
    assert.equal(spawn.file, 'npx')
  }
  // 用户自己的可执行文件不包：
  const direct = resolveSpawn('"C:\\Program Files\\api\\server.exe" --port 1')
  assert.equal(direct.file, 'C:\\Program Files\\api\\server.exe')
  assert.throws(() => resolveSpawn('   '), /空的/)
})

test('the server lifecycle reaches ready, reports its port, and stops cleanly', async (t) => {
  const server = new ApiServer('meting')
  t.after(async () => { await server.stop() })
  await server.start(command)

  const status = server.status()
  assert.equal(status.state, 'ready', 'state=' + status.state + ' error=' + String(status.error) + ' log=' + status.log.join(' | '))
  assert.ok(status.port && status.port > 1024)
  assert.equal(server.base(), 'http://127.0.0.1:' + status.port)
  assert.equal(await probeHttp(status.port, '/'), true, 'the fake server answers on the allocated port')

  await server.stop()
  const stopped = server.status()
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.port, null)
  assert.equal(stopped.pid, null)
})

test('a command that never listens ends up failed with a reason, not hanging forever', async (t) => {
  const server = new ApiServer('meting')
  t.after(async () => { await server.stop() })
  // 立刻退出：应触发重试上限并给出明确错误，而不是永远 starting。
  const start = server.start(JSON.stringify(process.execPath) + ' -e "process.exit(3)"')
  // 不等待整个 90 秒就绪窗口，靠重试计数把它推到 failed 就够了。
  await new Promise(resolve => setTimeout(resolve, 2500))
  const status = server.status()
  assert.ok(['starting', 'failed'].includes(status.state), 'state=' + status.state)
  await server.stop()
  assert.equal(server.status().state, 'stopped')
}, { timeout: 120_000 })

test('the stored config is sanitised: unknown platforms dropped, sources validated, command capped', () => {
  const config = sanitizeConfig({
    version: 1,
    providers: [
      { platform: 'netease', command: 'x'.repeat(5000), enabled: true },
      { platform: 'nope', command: 'evil', enabled: true },
      { platform: 'meting', command: 'meting', enabled: false, metingSource: 'spotify' }
    ]
  })
  const netease = config.providers.find(provider => provider.platform === 'netease')
  assert.equal(netease.enabled, true)
  assert.equal(netease.command.length, 2048, 'the command is capped')
  assert.equal(config.providers.length, PLATFORM_SPECS.length, 'only the known platforms remain')
  assert.ok(!config.providers.some(provider => provider.platform === 'nope'))
  // 非法的 sub-source 回落到默认值，而不是被原样存进去。
  assert.equal(config.providers.find(provider => provider.platform === 'meting').metingSource, 'kugou')
})

test('a config that is not an object falls back to defaults instead of throwing', () => {
  const config = sanitizeConfig(null)
  assert.equal(config.providers.length, PLATFORM_SPECS.length)
  assert.ok(config.providers.every(provider => provider.enabled === false))
})
