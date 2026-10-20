// 自动更新状态机 / 更新源解析 / 错误文案（PACKAGING-v1 §2、§4）。
//
// 这些是纯逻辑 + 可注入 fake adapter 的 controller：不需要 Electron，也不需要联网，
// 所以主进程的更新策略能被 node:test 直接覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AUTO_CHECK_DELAY_MS,
  UPDATE_FEED_FILE,
  UpdaterService,
  clampPercent,
  describeUpdateError,
  autoUpdaterFromModule,
  initialUpdateState,
  normalizeFeedUrl,
  reduceUpdateState,
  resolveAutoCheckDelay,
  resolveFeedConfig
} from '../src/main/updater.ts'

const tempUserData = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-update-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const APP = (packaged) => ({ version: '0.2.0', packaged, userDataPath: '', platform: 'win32' })

const baseState = (overrides = {}) => ({
  phase: 'idle',
  currentVersion: '0.2.0',
  latestVersion: null,
  percent: null,
  message: null,
  feedConfigured: true,
  supported: true,
  ...overrides
})

test('the auto-check delay is the documented 12 seconds', () => {
  assert.equal(AUTO_CHECK_DELAY_MS, 12_000)
})

test('TWILIGHT_UPDATE_AUTOCHECK_MS shortens the auto-check for drills; invalid values fall back to 12s', () => {
  assert.equal(resolveAutoCheckDelay('3000'), 3000)
  assert.equal(resolveAutoCheckDelay(' 0 '), 0)
  assert.equal(resolveAutoCheckDelay('1.5e3'), 1500)
  for (const invalid of [undefined, null, '', '   ', 'abc', '-5', Number.NaN, {}]) {
    assert.equal(resolveAutoCheckDelay(invalid), AUTO_CHECK_DELAY_MS, String(invalid))
  }
})

test('feed urls only accept http(s), normalize the trailing slash and reject credentials', () => {
  assert.equal(normalizeFeedUrl('https://updates.example.com/stringmoon/'), 'https://updates.example.com/stringmoon/')
  assert.equal(normalizeFeedUrl('  http://127.0.0.1:8080/releases  '), 'http://127.0.0.1:8080/releases/')
  for (const bad of [undefined, null, 42, '', '   ', 'file:///C:/releases/', 'ftp://example.com/x', 'javascript:alert(1)', 'not a url', 'https://user:pass@example.com/releases/']) {
    assert.equal(normalizeFeedUrl(bad), null, String(bad))
  }
})

test('feed priority: env wins; an invalid env is reported instead of silently falling back to the file', () => {
  const { dir, cleanup } = tempUserData()
  try {
    fs.writeFileSync(path.join(dir, UPDATE_FEED_FILE), JSON.stringify({ url: 'https://file.example.com/feed/', note: 'file source' }))
    const fromEnv = resolveFeedConfig({ envUrl: 'https://env.example.com/feed', userDataPath: dir })
    assert.equal(fromEnv.configured, true)
    assert.equal(fromEnv.origin, 'env')
    assert.equal(fromEnv.url, 'https://env.example.com/feed/')
    assert.equal(fromEnv.note, null)

    const invalidEnv = resolveFeedConfig({ envUrl: 'ftp://bad.example.com/', userDataPath: dir })
    assert.equal(invalidEnv.configured, false)
    assert.equal(invalidEnv.origin, 'env')
    assert.match(invalidEnv.problem, /TWILIGHT_UPDATE_URL/)
  } finally { cleanup() }
})

test('feed file: valid config exposes url + note, broken config degrades to a readable problem', () => {
  const { dir, cleanup } = tempUserData()
  try {
    assert.deepEqual(resolveFeedConfig({ userDataPath: dir }), {
      configured: false, url: null, note: null, origin: 'none', problem: null
    })
    fs.writeFileSync(path.join(dir, UPDATE_FEED_FILE), JSON.stringify({ url: 'https://cdn.example.com/stringmoon/', note: '内网镜像' }))
    const good = resolveFeedConfig({ userDataPath: dir })
    assert.equal(good.configured, true)
    assert.equal(good.origin, 'file')
    assert.equal(good.url, 'https://cdn.example.com/stringmoon/')
    assert.equal(good.note, '内网镜像')

    fs.writeFileSync(path.join(dir, UPDATE_FEED_FILE), '{not json')
    const brokenJson = resolveFeedConfig({ userDataPath: dir })
    assert.equal(brokenJson.configured, false)
    assert.match(brokenJson.problem, /JSON/)

    fs.writeFileSync(path.join(dir, UPDATE_FEED_FILE), JSON.stringify({ url: 'file:///C:/releases/' }))
    const brokenUrl = resolveFeedConfig({ userDataPath: dir })
    assert.equal(brokenUrl.configured, false)
    assert.match(brokenUrl.problem, /http\(s\)/)
  } finally { cleanup() }
})

test('state derivation: checking -> available -> progress -> downloaded -> installing', () => {
  let state = initialUpdateState({ currentVersion: '0.2.0', supported: true, feedConfigured: true }, { phase: 'idle', message: 'ready' })
  state = reduceUpdateState(state, { type: 'checking' })
  assert.equal(state.phase, 'checking')
  assert.equal(state.percent, null)

  state = reduceUpdateState(state, { type: 'available', version: '0.2.1' })
  assert.equal(state.phase, 'available')
  assert.equal(state.latestVersion, '0.2.1')
  assert.match(state.message, /0\.2\.1/)

  state = reduceUpdateState(state, { type: 'download-progress', percent: 42.6 })
  assert.equal(state.phase, 'downloading')
  assert.equal(state.percent, 43)

  state = reduceUpdateState(state, { type: 'downloaded', version: '0.2.1' })
  assert.equal(state.phase, 'downloaded')
  assert.equal(state.percent, 100)
  assert.equal(state.latestVersion, '0.2.1')

  state = reduceUpdateState(state, { type: 'installing' })
  assert.equal(state.phase, 'installing')
  // currentVersion / supported / feedConfigured 永远不被事件改写。
  assert.equal(state.currentVersion, '0.2.0')
  assert.equal(state.supported, true)
  assert.equal(state.feedConfigured, true)
})

test('state derivation: up-to-date and error paths clear the transient fields', () => {
  let state = baseState({ phase: 'downloading', latestVersion: '0.2.1', percent: 50 })
  state = reduceUpdateState(state, { type: 'not-available' })
  assert.equal(state.phase, 'up-to-date')
  assert.equal(state.latestVersion, null)
  assert.equal(state.percent, null)

  state = reduceUpdateState(state, { type: 'error', message: '检查更新失败：断网。' })
  assert.equal(state.phase, 'error')
  assert.equal(state.message, '检查更新失败：断网。')
  assert.equal(state.percent, null)
})

test('percent clamps into 0-100 and tolerates garbage', () => {
  assert.equal(clampPercent(150), 100)
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(undefined), 0)
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(clampPercent(33.3), 33)
})

test('error copy is one Chinese line, without stack or update-source credentials', () => {
  const network = describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED https://user:pass@updates.example.com/\n    at Updater.check (x.js:1:1)'))
  assert.match(network, /无法连接更新服务器/)
  assert.ok(!network.includes('\n'), 'must be a single line')
  assert.ok(!network.includes('user:pass'))
  assert.ok(!network.includes('https://'))
  assert.ok(!network.includes('at Updater'))

  assert.match(describeUpdateError(new Error('HttpError: 404 Not Found')), /404/)
  assert.match(describeUpdateError(new Error('Request failed with status code 403')), /拒绝访问/)
  assert.match(describeUpdateError(new Error('sha512 checksum mismatch')), /校验/)
  assert.match(describeUpdateError(new Error('No published versions on GitHub')), /latest\.yml|版本/)
  assert.equal(describeUpdateError(null), '检查更新失败：未知原因。')
  const unknown = describeUpdateError(new Error('boom happened'))
  assert.equal(unknown, '检查更新失败：boom happened')
})

test('development mode never touches the network and reports disabled-dev', async () => {
  let factoryCalls = 0
  const service = new UpdaterService({
    app: { ...APP(false), userDataPath: 'C:/unused' },
    envUrl: 'https://updates.example.com/',
    onState: () => undefined,
    adapterFactory: async () => { factoryCalls++; throw new Error('must not load electron-updater in dev') },
    autoCheckDelayMs: 0
  })
  service.start()
  const state = service.getState()
  assert.equal(state.phase, 'disabled-dev')
  assert.equal(state.supported, false)
  assert.equal(state.feedConfigured, false)
  assert.deepEqual(await service.check(), state)
  assert.deepEqual(await service.download(), state)
  assert.deepEqual(service.install(), state)
  assert.equal(factoryCalls, 0)
  service.stop()
})

test('packaged without a feed reports unconfigured and sends no request', async () => {
  const { dir, cleanup } = tempUserData()
  try {
    let factoryCalls = 0
    const service = new UpdaterService({
      app: { ...APP(true), userDataPath: dir },
      onState: () => undefined,
      adapterFactory: async () => { factoryCalls++; throw new Error('must not load') },
      autoCheckDelayMs: 0
    })
    service.start()
    const state = service.getState()
    assert.equal(state.phase, 'unconfigured')
    assert.equal(state.supported, true)
    assert.equal(state.feedConfigured, false)
    assert.ok(state.message.includes('TWILIGHT_UPDATE_URL'))
    assert.deepEqual(await service.check(), state)
    assert.equal(factoryCalls, 0)
    service.stop()
  } finally { cleanup() }
})

function fakeAdapter(overrides = {}) {
  const listeners = new Map()
  const calls = { check: 0, download: 0, quit: null, feed: null }
  const adapter = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    installDirectory: undefined,
    setFeedURL(options) { calls.feed = options },
    async checkForUpdates() { calls.check++; return overrides.checkResult ?? { updateInfo: { version: '0.2.1' } } },
    async downloadUpdate() { calls.download++; return undefined },
    quitAndInstall(...args) { calls.quit = args },
    on(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return adapter },
    emit(event, payload) { for (const listener of listeners.get(event) ?? []) listener(payload) },
    calls
  }
  return adapter
}

test('packaged + configured: check applies the product switches, uses generic feed and wires events', async () => {
  const adapter = fakeAdapter()
  let beforeInstall = 0
  const service = new UpdaterService({
    app: { ...APP(true), userDataPath: 'C:/unused' },
    envUrl: 'https://updates.example.com/stringmoon',
    onState: () => undefined,
    adapterFactory: async () => adapter,
    beforeInstall: () => { beforeInstall++ },
    // 安装形态：exe 在安装目录里，用于验证 installDirectory 传给 NSIS 的 /D=...
    exePath: 'C:/Apps/Stringmoon/Stringmoon.exe',
    autoCheckDelayMs: 0
  })
  service.start()
  assert.equal(service.getState().phase, 'idle')

  // 未收到事件时，用 checkForUpdates 的 promise 结果兜底。
  const checked = await service.check()
  assert.equal(checked.phase, 'available')
  assert.equal(checked.latestVersion, '0.2.1')
  assert.equal(adapter.autoDownload, false)
  assert.equal(adapter.autoInstallOnAppQuit, true)
  assert.equal(adapter.allowDowngrade, false)
  assert.deepEqual(adapter.calls.feed, { provider: 'generic', url: 'https://updates.example.com/stringmoon/' })
  assert.equal(adapter.installDirectory, 'C:/Apps/Stringmoon', '静默升级必须显式传安装目录（NSIS /D=...）')

  // 事件同样能把状态推进下去（真实 electron-updater 主要靠事件）。
  adapter.emit('download-progress', { percent: 41 })
  assert.equal(service.getState().phase, 'downloading')
  assert.equal(service.getState().percent, 41)
  adapter.emit('update-downloaded', { version: '0.2.1' })
  assert.equal(service.getState().phase, 'downloaded')

  const installed = service.install()
  assert.equal(installed.phase, 'installing')
  assert.equal(beforeInstall, 1, '安装前必须同步收尾（播放记忆落盘）')
  // isSilent=true 才会给 NSIS 加 /S；false 会弹出安装向导（verifier 实测卡住过）。
  assert.deepEqual(adapter.calls.quit, [true, true], '无痛升级必须是静默安装')
  service.stop()
})

test('actions are idempotent: duplicate check shares one request, download/install no-op in wrong state', async () => {
  const adapter = fakeAdapter()
  const service = new UpdaterService({
    app: { ...APP(true), userDataPath: 'C:/unused' },
    envUrl: 'https://updates.example.com/',
    onState: () => undefined,
    adapterFactory: async () => adapter,
    autoCheckDelayMs: 0
  })
  service.start()
  const first = service.check()
  assert.equal(service.getState().phase, 'checking')
  const second = service.check()
  const third = service.check()
  // 第二次/第三次命中「正在检查」的幂等短路：返回当前状态，不发第二个请求。
  assert.deepEqual(await second, service.getState())
  assert.deepEqual(await third, service.getState())
  const settled = await first
  assert.equal(settled.phase, 'available')
  assert.equal(adapter.calls.check, 1, '并发调用只发一次请求')

  // 还没检查出可用版本时，download 是空操作。
  const fresh = new UpdaterService({
    app: { ...APP(true), userDataPath: 'C:/unused' },
    envUrl: 'https://updates.example.com/',
    onState: () => undefined,
    adapterFactory: async () => adapter,
    autoCheckDelayMs: 0
  })
  fresh.start()
  assert.equal((await fresh.download()).phase, 'idle')
  assert.equal(fresh.install().phase, 'idle')
  assert.equal(adapter.calls.download, 0)
  assert.equal(adapter.calls.quit, null)
  service.stop()
  fresh.stop()
})

test('electron-updater interop accepts both the ESM namespace and the CJS default shape', () => {
  const adapter = { autoDownload: true, on() { return adapter }, setFeedURL() {} }
  assert.equal(autoUpdaterFromModule({ autoUpdater: adapter }), adapter)
  assert.equal(autoUpdaterFromModule({ default: { autoUpdater: adapter } }), adapter)
  for (const bad of [null, undefined, {}, { autoUpdater: 42 }, { autoUpdater: null, default: {} }, 'electron']) {
    assert.equal(autoUpdaterFromModule(bad), null, JSON.stringify(bad))
  }
})

test('a missing updater export becomes a readable Chinese error instead of undefined.autoDownload', async () => {
  const service = new UpdaterService({
    app: { ...APP(true), userDataPath: 'C:/unused' },
    envUrl: 'https://updates.example.com/',
    onState: () => undefined,
    adapterFactory: async () => {
      const adapter = autoUpdaterFromModule({ default: {} })
      if (!adapter) throw new Error('更新模块加载失败（electron-updater 未导出 autoUpdater）。')
      return adapter
    },
    autoCheckDelayMs: 0
  })
  service.start()
  const state = await service.check()
  assert.equal(state.phase, 'error')
  assert.match(state.message, /更新模块加载失败/)
  assert.ok(!state.message.includes('autoDownload'), '不能把 undefined 的属性赋值错误暴露给用户')
  service.stop()
})

test('check failures become one readable Chinese error', async () => {
  const service = new UpdaterService({
    app: { ...APP(true), userDataPath: 'C:/unused' },
    envUrl: 'https://updates.example.com/',
    onState: () => undefined,
    adapterFactory: async () => fakeAdapter({ checkResult: Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')) }),
    autoCheckDelayMs: 0
  })
  service.start()
  const state = await service.check()
  assert.equal(state.phase, 'error')
  assert.match(state.message, /无法连接更新服务器/)
  assert.ok(!state.message.includes('\n'))
  service.stop()
})
