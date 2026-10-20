import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  bundledProviderCommand, bundledRuntimeDir, bundledRuntimeZip, ensureBundledStreamingConfig, prepareBundledRuntime
} from '../src/main/streaming/bundled-runtime.ts'

const makeRuntime = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-runtime-'))
  const runtime = path.join(dir, 'runtime')
  await mkdir(path.join(runtime, 'node_modules', '@yakult-green-tea', 'qq-music-api', 'dist', 'src'), { recursive: true })
  await mkdir(path.join(runtime, 'node_modules', '@neteasecloudmusicapienhanced', 'api'), { recursive: true })
  await writeFile(path.join(runtime, 'node.exe'), '')
  await writeFile(path.join(runtime, 'node_modules', '@yakult-green-tea', 'qq-music-api', 'dist', 'src', 'app.js'), '')
  await writeFile(path.join(runtime, 'node_modules', '@neteasecloudmusicapienhanced', 'api', 'app.js'), '')
  return { dir, runtime }
}

test('dev runtime dir is found and each provider command quotes both paths', async () => {
  const { dir, runtime } = await makeRuntime()
  assert.equal(bundledRuntimeDir('unused', dir), runtime)
  const qq = bundledProviderCommand(runtime, 'qq')
  assert.ok(qq && qq.startsWith('"') && qq.includes('node.exe"'), 'both paths are quoted for Program Files installs')
  assert.ok(qq && qq.endsWith('app.js"'))
  assert.equal(bundledProviderCommand(runtime, 'meting'), null)
  assert.equal(bundledRuntimeDir('unused', path.join(dir, 'missing')), null)
  await rm(dir, { recursive: true, force: true })
})

test('first run seeds streaming.json with the bundled commands and never overwrites', async () => {
  const { dir, runtime } = await makeRuntime()
  const configFile = path.join(dir, 'streaming.json')
  assert.equal(ensureBundledStreamingConfig(configFile, runtime), true)
  const seeded = JSON.parse(await readFile(configFile, 'utf8'))
  const qq = seeded.providers.find(provider => provider.platform === 'qq')
  const netease = seeded.providers.find(provider => provider.platform === 'netease')
  assert.ok(qq.command.includes('qq-music-api'))
  assert.ok(netease.command.includes('@neteasecloudmusicapienhanced'))
  // 没有内置入口的平台保留文档默认命令（meting 仍走 docker）
  assert.equal(seeded.providers.find(provider => provider.platform === 'meting').command.startsWith('docker '), true)
  // 已有配置绝不覆盖
  await writeFile(configFile, JSON.stringify({ version: 1, providers: [{ platform: 'qq', command: 'my-server', enabled: true }] }))
  assert.equal(ensureBundledStreamingConfig(configFile, runtime), false)
  const kept = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(kept.providers[0].command, 'my-server')
  // 没有运行环境时什么都不写
  const emptyConfig = path.join(dir, 'empty.json')
  assert.equal(ensureBundledStreamingConfig(emptyConfig, null), false)
  assert.equal(existsSync(emptyConfig), false)
  await rm(dir, { recursive: true, force: true })
})

test('packaged runtime.zip is extracted once into userData and marked with the version', async () => {
  const { dir, runtime } = await makeRuntime()
  const zip = path.join(dir, 'runtime.zip')
  const packed = spawnSync('tar.exe', ['-a', '-c', '-f', zip, '-C', runtime, '.'], { windowsHide: true })
  assert.equal(packed.status, 0, 'tar.exe creates the zip')
  const resources = path.join(dir, 'resources')
  await mkdir(resources, { recursive: true })
  await writeFile(path.join(resources, 'runtime.zip'), await readFile(zip))
  const userData = path.join(dir, 'profile')
  const viaZip = prepareBundledRuntime({ appPath: dir, resourcesPath: resources, userDataDir: userData, version: '0.4.0' })
  assert.equal(viaZip, path.join(userData, 'runtime'))
  assert.equal(existsSync(path.join(viaZip, 'node.exe')), true)
  assert.equal(existsSync(path.join(viaZip, 'node_modules', '@yakult-green-tea', 'qq-music-api', 'dist', 'src', 'app.js')), true)
  assert.equal((await readFile(path.join(viaZip, '.ready'), 'utf8')).trim(), 'v0.4.0')
  // 第二次直接复用（不再解压）
  assert.equal(prepareBundledRuntime({ appPath: dir, resourcesPath: resources, userDataDir: userData, version: '0.4.0' }), viaZip)
  // 版本变了要重解
  assert.equal(prepareBundledRuntime({ appPath: dir, resourcesPath: resources, userDataDir: userData, version: '0.4.1' }), viaZip)
  assert.equal((await readFile(path.join(viaZip, '.ready'), 'utf8')).trim(), 'v0.4.1')
  await rm(dir, { recursive: true, force: true })
})
