// 升级备份（PACKAGING-v1 §3）：版本变化时把用户文档复制到 upgrade-backups/<旧版本>/。
//
// 重点不是「复制成功」，而是**失败时绝不阻断启动、绝不删原文件**：
// 这些断言都直接打文件系统，不需要 Electron。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APP_META_FILE,
  MAX_UPGRADE_BACKUPS,
  UPGRADE_BACKUP_DIR,
  UPGRADE_META_SCHEMA_VERSION,
  backupDirectoryName,
  listBackupDirectories,
  readAppMeta,
  runUpgradeBackup
} from '../src/main/upgrade-backup.ts'

const tempUserData = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-backup-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const metaPath = (dir) => path.join(dir, APP_META_FILE)
const writeMeta = (dir, meta) => fs.writeFileSync(metaPath(dir), JSON.stringify(meta))
const readMeta = (dir) => JSON.parse(fs.readFileSync(metaPath(dir), 'utf8'))
const writeDoc = (dir, name, text = name) => fs.writeFileSync(path.join(dir, name), text)

test('first launch: no meta -> no backup, just write app-meta.json', () => {
  const { dir, cleanup } = tempUserData()
  try {
    writeDoc(dir, 'library.json', '{"dirs":["D:/music"]}')
    const result = runUpgradeBackup({ userDataPath: dir, currentVersion: '0.2.0', now: () => new Date('2026-10-17T12:00:00Z') })
    assert.equal(result.backedUp, false)
    assert.equal(result.fromVersion, null)
    assert.equal(result.problem, null)
    assert.equal(fs.existsSync(path.join(dir, UPGRADE_BACKUP_DIR)), false, '首启不该产生备份目录')
    const meta = readMeta(dir)
    assert.equal(meta.lastVersion, '0.2.0')
    assert.equal(meta.schemaVersion, UPGRADE_META_SCHEMA_VERSION)
    assert.equal(meta.updatedAt, '2026-10-17T12:00:00.000Z')
  } finally { cleanup() }
})

test('same version: nothing is copied and app-meta is not rewritten', () => {
  const { dir, cleanup } = tempUserData()
  try {
    writeMeta(dir, { lastVersion: '0.2.0', schemaVersion: 1, updatedAt: '2026-10-01T00:00:00.000Z' })
    const before = fs.readFileSync(metaPath(dir), 'utf8')
    const result = runUpgradeBackup({ userDataPath: dir, currentVersion: '0.2.0' })
    assert.equal(result.backedUp, false)
    assert.equal(result.problem, null)
    assert.equal(fs.readFileSync(metaPath(dir), 'utf8'), before, '同版本启动不该 churn updatedAt')
    assert.equal(fs.existsSync(path.join(dir, UPGRADE_BACKUP_DIR)), false)
  } finally { cleanup() }
})

test('version change: known documents are copied, unknown files are ignored, originals stay put', () => {
  const { dir, cleanup } = tempUserData()
  try {
    writeMeta(dir, { lastVersion: '0.1.0', schemaVersion: 1, updatedAt: '2026-09-01T00:00:00.000Z' })
    writeDoc(dir, 'library.json', '{"v":1}')
    writeDoc(dir, 'playlists.json', '[{"name":"夜"}]')
    writeDoc(dir, 'playback-memory.json', '{"memory":{}}')
    writeDoc(dir, 'not-a-user-document.txt', 'ignore me')
    const result = runUpgradeBackup({ userDataPath: dir, currentVersion: '0.2.0' })
    assert.equal(result.backedUp, true)
    assert.equal(result.fromVersion, '0.1.0')
    assert.equal(result.problem, null)
    assert.equal(result.backupDir, path.join(dir, UPGRADE_BACKUP_DIR, '0.1.0'))
    assert.deepEqual([...result.copied].sort(), ['library.json', 'playback-memory.json', 'playlists.json'])
    // 备份内容 = 原文件内容；原文件仍在.
    assert.equal(fs.readFileSync(path.join(result.backupDir, 'library.json'), 'utf8'), '{"v":1}')
    assert.equal(fs.existsSync(path.join(dir, 'library.json')), true)
    assert.equal(fs.existsSync(path.join(result.backupDir, 'not-a-user-document.txt')), false)
    assert.equal(readMeta(dir).lastVersion, '0.2.0')
  } finally { cleanup() }
})

test('backup directory name is sanitized so a version string cannot escape userData', () => {
  assert.equal(backupDirectoryName('0.2.1'), '0.2.1')
  assert.equal(backupDirectoryName('../../etc'), '.._.._etc')
  assert.equal(backupDirectoryName(''), 'unknown')
})

test('corrupt app-meta.json never throws: it is treated as a first launch and rewritten', () => {
  const { dir, cleanup } = tempUserData()
  try {
    fs.writeFileSync(metaPath(dir), '{definitely not json')
    const read = readAppMeta(dir)
    assert.equal(read.meta, null)
    assert.match(read.problem, /JSON/)
    const result = runUpgradeBackup({ userDataPath: dir, currentVersion: '0.2.0' })
    assert.equal(result.backedUp, false)
    assert.match(result.problem, /JSON/)
    assert.equal(readMeta(dir).lastVersion, '0.2.0', '损坏的 meta 必须被重写，否则每次启动都报错')
  } finally { cleanup() }
})

test('only the newest ' + MAX_UPGRADE_BACKUPS + ' backup directories are kept', () => {
  const { dir, cleanup } = tempUserData()
  try {
    const root = path.join(dir, UPGRADE_BACKUP_DIR)
    fs.mkdirSync(root, { recursive: true })
    const hour = 60 * 60 * 1000
    const now = Date.now()
    const old = [
      { name: '0.1.1', mtime: new Date(now - 3 * hour) },
      { name: '0.1.2', mtime: new Date(now - 2 * hour) },
      { name: '0.1.3', mtime: new Date(now - hour) }
    ]
    for (const entry of old) {
      const target = path.join(root, entry.name)
      fs.mkdirSync(target)
      fs.utimesSync(target, entry.mtime, entry.mtime)
    }
    writeMeta(dir, { lastVersion: '0.1.4', schemaVersion: 1, updatedAt: '2026-08-01T00:00:00.000Z' })
    writeDoc(dir, 'library.json', '{"v":2}')
    const result = runUpgradeBackup({ userDataPath: dir, currentVersion: '0.2.0' })
    assert.equal(result.backedUp, true)
    assert.deepEqual(result.pruned, ['0.1.1'])
    const kept = listBackupDirectories(dir).map(entry => entry.name).sort()
    assert.deepEqual(kept, ['0.1.2', '0.1.3', '0.1.4'])
  } finally { cleanup() }
})

test('a backup failure is reported but never thrown, and meta is left behind so the next launch retries', () => {
  const { dir, cleanup } = tempUserData()
  try {
    writeMeta(dir, { lastVersion: '0.1.0', schemaVersion: 1, updatedAt: '2026-09-01T00:00:00.000Z' })
    // 让 upgrade-backups 成为普通文件：mkdir 备份目录必然失败。
    fs.writeFileSync(path.join(dir, UPGRADE_BACKUP_DIR), 'not a directory')
    writeDoc(dir, 'library.json', '{"v":1}')
    let result
    assert.doesNotThrow(() => { result = runUpgradeBackup({ userDataPath: dir, currentVersion: '0.2.0' }) })
    assert.equal(result.backedUp, false)
    assert.ok(result.problem && result.problem.length > 0)
    assert.equal(readMeta(dir).lastVersion, '0.1.0', '备份失败不能写新 meta，否则永远失去重试机会')
    assert.equal(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'), '{"v":1}', '原文件必须完好')
  } finally { cleanup() }
})

test('a missing userData directory is created on demand instead of crashing the launch', () => {
  const { dir, cleanup } = tempUserData()
  try {
    const missing = path.join(dir, 'does', 'not', 'exist')
    let result
    assert.doesNotThrow(() => { result = runUpgradeBackup({ userDataPath: missing, currentVersion: '0.2.0' }) })
    assert.equal(result.problem, null)
    assert.equal(result.backedUp, false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(missing, APP_META_FILE), 'utf8')).lastVersion, '0.2.0')
  } finally { cleanup() }
})
