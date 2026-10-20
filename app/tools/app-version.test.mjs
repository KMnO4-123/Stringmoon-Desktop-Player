// 应用版本解析（PACKAGING v1）：dev/测试启动时 app.getVersion() 返回 Electron 版本，
// 不能让设置页「关于」和 updater.currentVersion 显示 44.7.2。纯函数，无 Electron 依赖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAppVersion } from '../src/main/app-version.ts'

test('packaged builds trust app.getVersion() (the real package.json version)', () => {
  let packageReads = 0
  const version = resolveAppVersion({
    getVersion: () => '0.2.0',
    electronVersion: '44.7.2',
    readPackageVersion: () => { packageReads++; return '0.2.0' }
  })
  assert.equal(version, '0.2.0')
  assert.equal(packageReads, 0, '打包版不需要读 package.json')
})

test('dev/test launches fall back to package.json when app.getVersion() is the Electron runtime version', () => {
  const version = resolveAppVersion({
    getVersion: () => '44.7.2',
    electronVersion: '44.7.2',
    readPackageVersion: () => '0.2.0'
  })
  assert.equal(version, '0.2.0')
})

test('an unreadable package.json keeps the runtime value instead of returning empty', () => {
  assert.equal(resolveAppVersion({
    getVersion: () => '44.7.2',
    electronVersion: '44.7.2',
    readPackageVersion: () => null
  }), '44.7.2')
})

test('empty/throwing runtime values still resolve through package.json', () => {
  const base = { electronVersion: '44.7.2', readPackageVersion: () => '0.2.0' }
  assert.equal(resolveAppVersion({ ...base, getVersion: () => '' }), '0.2.0')
  assert.equal(resolveAppVersion({ ...base, getVersion: () => '   ' }), '0.2.0')
  assert.equal(resolveAppVersion({ ...base, getVersion: () => { throw new Error('boom') } }), '0.2.0')
})

test('versions are trimmed on both paths', () => {
  assert.equal(resolveAppVersion({ getVersion: () => ' 0.2.0 ', electronVersion: '44.7.2', readPackageVersion: () => null }), '0.2.0')
  assert.equal(resolveAppVersion({ getVersion: () => '44.7.2', electronVersion: '44.7.2', readPackageVersion: () => ' 0.2.1 ' }), '0.2.1')
})
