// 播放记忆：纯函数归一 + 主进程存储（节流写/退出补写/引擎事件跟随）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canRestoreMemory, mergePlaybackMemory, sanitizePlaybackMemory } from '../src/shared/playback-memory.ts'

const store = await import('../src/main/playback-memory.ts')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const valid = {
  version: 1,
  filePath: 'D:\\music\\Test Artist - 测试曲目.flac',
  trackId: 'tl_0001',
  positionMs: 42000,
  durationMs: 304948,
  queue: ['tl_0001', 'tl_0002'],
  repeatMode: 'all',
  updatedAt: 1700000000000
}

test('sanitize accepts a valid memory and rejects unusable ones', () => {
  assert.deepEqual(sanitizePlaybackMemory(valid), valid)
  assert.equal(sanitizePlaybackMemory({ ...valid, version: 2 }), null)
  assert.equal(sanitizePlaybackMemory({ ...valid, filePath: 'relative.flac', trackId: '' }), null)
  assert.equal(sanitizePlaybackMemory(null), null)
  assert.equal(canRestoreMemory(sanitizePlaybackMemory(valid)), true)
})

test('sanitize clamps/epairs individual bad fields instead of destroying the record', () => {
  const repaired = sanitizePlaybackMemory({
    ...valid,
    positionMs: -5,
    queue: ['tl_0001', 'tl_0001', 42, 'tl_0002'],
    repeatMode: 'bogus',
    filePath: valid.filePath
  })
  assert.equal(repaired.positionMs, 0)
  assert.deepEqual(repaired.queue, ['tl_0001', 'tl_0002'])
  assert.equal(repaired.repeatMode, 'sequential')
  assert.equal(repaired.filePath, valid.filePath)
})

test('merge keeps unspecified fields and ignores invalid patches', () => {
  const merged = mergePlaybackMemory(valid, { positionMs: 1000, queue: ['tl_0009'], bogus: 'x' })
  assert.equal(merged.positionMs, 1000)
  assert.deepEqual(merged.queue, ['tl_0009'])
  assert.equal(merged.filePath, valid.filePath, '未出现的字段保持原值')
  const unchanged = mergePlaybackMemory(valid, { positionMs: Number.NaN, filePath: 'relative.flac' })
  assert.equal(unchanged.positionMs, valid.positionMs)
  assert.equal(unchanged.filePath, valid.filePath)
})

test('store persists across a simulated restart and follows engine events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'twilight-memory-'))
  const file = path.join(dir, 'playback-memory.json')
  // 记忆里的路径必须真实存在：读取时会 stat 校验（文件不存在 = 不恢复）。
  const audio = path.join(dir, 'track7.flac')
  await writeFile(audio, Buffer.alloc(0))
  try {
    store.configurePlaybackMemory(file)
    assert.equal(await store.readPlaybackMemory(), null, '首次运行没有记忆')

    // 引擎 state：新曲目 + 路径解析器（主进程用托盘缓存当解析器）
    store.recordPlaybackMemoryEvent(
      { ev: 'state', state: 'playing', trackId: 'tl_0007', durationMs: 240000 },
      (trackId) => trackId === 'tl_0007' ? audio : undefined
    )
    store.recordPlaybackMemoryEvent({ ev: 'position', trackId: 'tl_0007', positionMs: 61000, durationMs: 240000 }, () => undefined)
    store.recordPlaybackMemoryEvent({ ev: 'state', state: 'paused', trackId: 'tl_0007', durationMs: 240000 }, () => undefined)
    /**
     * v6 回归：引擎把「已装载、未开始播放」报成 stopped，并且**带真实位置**。
     * 旧实现无差别把 stopped 写成位置 0，导致自动恢复永远回到 0:00。
     * 这里同时钉住两个方向：带位置要照抄，真正的 stop（位置 0）才归零。
     */
    store.recordPlaybackMemoryEvent({ ev: 'state', state: 'stopped', trackId: 'tl_0007', durationMs: 240000, positionMs: 61000 }, () => undefined)
    assert.equal((await store.readPlaybackMemory())?.positionMs, 61000, 'stopped with a real position keeps it')
    store.recordPlaybackMemoryEvent({ ev: 'state', state: 'stopped', trackId: 'tl_0007', durationMs: 240000, positionMs: 0 }, () => undefined)
    assert.equal((await store.readPlaybackMemory())?.positionMs, 0, 'a real stop still rewinds the memory')
    // 恢复成 61s，后面的断言（队列/重启）仍按原意走。
    store.recordPlaybackMemoryEvent({ ev: 'position', trackId: 'tl_0007', positionMs: 61000, durationMs: 240000 }, () => undefined)
    // 渲染层补它知道、引擎不知道的字段
    const merged = await store.savePlaybackMemory({ queue: ['tl_0007', 'tl_0008'], repeatMode: 'one' })
    assert.equal(merged.trackId, 'tl_0007')
    assert.equal(merged.positionMs, 61000, '暂停时用最后一条 position 钉住位置')
    assert.deepEqual(merged.queue, ['tl_0007', 'tl_0008'])
    assert.equal(merged.repeatMode, 'one')

    store.flushPlaybackMemorySync()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.memory.trackId, 'tl_0007')

    // 模拟重启：重新 configure 同一个文件
    store.configurePlaybackMemory(file)
    const restored = await store.readPlaybackMemory()
    assert.equal(restored.trackId, 'tl_0007')
    assert.equal(restored.positionMs, 61000)
    assert.equal(restored.durationMs, 240000)
    assert.deepEqual(restored.queue, ['tl_0007', 'tl_0008'])

    // 「文件不存在时不恢复」：删掉音频后重读同一份记忆 → null（但记录仍在磁盘）
    await unlink(audio)
    store.configurePlaybackMemory(file)
    assert.equal(await store.readPlaybackMemory(), null, '文件不存在时不得给出恢复入口')
    store.flushPlaybackMemorySync()

    // clear：文件里应写回 memory:null，再读是 null
    await store.clearPlaybackMemory()
    store.flushPlaybackMemorySync()
    store.configurePlaybackMemory(file)
    assert.equal(await store.readPlaybackMemory(), null)
  } finally {
    await sleep(10)
    await rm(dir, { recursive: true, force: true })
  }
})
