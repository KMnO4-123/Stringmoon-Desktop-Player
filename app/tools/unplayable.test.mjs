import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureUnplayable, readUnplayable, markUnplayable, clearUnplayable, forgetUnplayable } from '../src/main/unplayable.ts'

/**
 * 「无法播放」记录的契约（CR-017）。
 *
 * 这块的风险全在**误判**上：把一首好歌标成坏的，用户就再也看不见它；而判定的
 * 唯一权威是解码器，它只在扫描预检或真正播放时才说话。所以这里要钉住的不是
 * 「能不能写文件」，而是：
 *   ① 记录以**归一路径**为身份（与曲库其余部分同一套规则，CR-013）；
 *   ② 重复标记是同一个事实，不产生第二行；
 *   ③ 恢复必须能真的把人放回来（单条与全部）；
 *   ④ 坏记录/缺失文件不能让启动炸掉 —— 宁可当没有记录，也不静默藏歌。
 */

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'te-unplayable-'))
  const file = join(dir, 'unplayable.json')
  // 串行化：这些函数用模块级状态，测试之间必须显式切换配置文件。
  return Promise.resolve()
    .then(() => configureUnplayable(file))
    .then(() => run(file))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('records a marked file and reads it back', async () => {
  await withStore(async () => {
    const isNew = await markUnplayable('D:\\Music\\broken.flac', 'not decodable as MP3', 'playback')
    assert.equal(isNew, true, 'the first mark is a new record')
    const report = await readUnplayable()
    assert.equal(report.entries.length, 1)
    assert.equal(report.entries[0].path, 'D:\\Music\\broken.flac')
    assert.equal(report.entries[0].reason, 'not decodable as MP3')
    assert.equal(report.entries[0].source, 'playback')
    assert.ok(report.entries[0].detectedAt, 'the record carries a timestamp')
  })
})

test('the same file marked twice stays ONE record and updates the reason', async () => {
  await withStore(async () => {
    await markUnplayable('D:\\Music\\a.flac', 'first reason', 'playback')
    const isNew = await markUnplayable('D:\\Music\\a.flac', 'second reason', 'scan')
    assert.equal(isNew, false, 'a repeat is not a new record')
    const report = await readUnplayable()
    assert.equal(report.entries.length, 1, 'the same file must not appear twice')
    assert.equal(report.entries[0].reason, 'second reason')
    assert.equal(report.entries[0].source, 'scan')
  })
})

test('identity is the normalised path, matching the rest of the library', async () => {
  await withStore(async () => {
    await markUnplayable('D:\\Music\\Same.flac', 'x', 'playback')
    // 分隔符与大小写不同，但归一后是同一个文件（CR-013）。
    const isNew = await markUnplayable('D:/Music/Same.flac', 'y', 'playback')
    assert.equal(isNew, false, 'a different spelling is the SAME file')
    assert.equal((await readUnplayable()).entries.length, 1)
  })
})

test('restoring one file removes only that record', async () => {
  await withStore(async () => {
    await markUnplayable('D:\\Music\\a.flac', 'x', 'playback')
    await markUnplayable('D:\\Music\\b.flac', 'y', 'playback')
    const report = await forgetUnplayable('D:\\Music\\a.flac')
    assert.deepEqual(report.entries.map((e) => e.path), ['D:\\Music\\b.flac'])
  })
})

test('restore-all clears every record', async () => {
  await withStore(async () => {
    await markUnplayable('D:\\Music\\a.flac', 'x', 'playback')
    await markUnplayable('D:\\Music\\b.flac', 'y', 'scan')
    const report = await clearUnplayable()
    assert.equal(report.entries.length, 0)
    assert.equal((await readUnplayable()).entries.length, 0)
  })
})

test('records survive a reload, so a restart does not forget them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-unplayable-persist-'))
  const file = join(dir, 'unplayable.json')
  try {
    configureUnplayable(file)
    await markUnplayable('D:\\Music\\a.flac', 'why', 'playback')
    // Point the store at the same file again: this is what a restart looks like.
    configureUnplayable(file)
    const report = await readUnplayable()
    assert.equal(report.entries.length, 1, 'the record is persisted, not memory-only')
    assert.equal(report.entries[0].reason, 'why')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt or missing record file never blocks startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-unplayable-corrupt-'))
  try {
    const missing = join(dir, 'does-not-exist.json')
    configureUnplayable(missing)
    assert.equal((await readUnplayable()).entries.length, 0, 'a missing file reads as empty')

    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{not json at all', 'utf8')
    configureUnplayable(corrupt)
    assert.equal((await readUnplayable()).entries.length, 0, 'unparseable content reads as empty, not as a crash')

    // Entries with a non-absolute path are meaningless for a library, so drop them.
    const bad = join(dir, 'bad-entry.json')
    writeFileSync(bad, JSON.stringify({ entries: [{ path: 'relative.flac', reason: 'x' }] }), 'utf8')
    configureUnplayable(bad)
    assert.equal((await readUnplayable()).entries.length, 0, 'a path that is not absolute is not a library record')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-absolute path is refused instead of recorded', async () => {
  await withStore(async () => {
    assert.equal(await markUnplayable('relative.flac', 'x', 'playback'), false)
    assert.equal((await readUnplayable()).entries.length, 0)
  })
})
