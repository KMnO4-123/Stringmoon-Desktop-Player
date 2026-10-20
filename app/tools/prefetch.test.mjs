// 下一首预热：路径校验 / 只读上限 / 可取消。全部在临时文件上跑，不碰真实曲库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TrackPrefetcher } from '../src/main/prefetch.ts'

const makeTemp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'twilight-prefetch-'))
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

test('rejects relative paths, unsupported extensions, missing files and directories', async () => {
  const { dir, dispose } = await makeTemp()
  try {
    const prefetcher = new TrackPrefetcher({ maxBytes: 1024, chunkBytes: 256 })
    for (const bad of ['relative.flac', 'D:\\does-not-exist-xyz.flac', 'D:\\x\\a.txt', 42, null]) {
      const result = await prefetcher.prefetch(bad)
      assert.equal(result.ok, false, JSON.stringify(bad))
      assert.ok(result.error, '失败必须带可显示的原因')
    }
    const asDirectory = await prefetcher.prefetch(dir + '\\')
    assert.equal(asDirectory.ok, false)
  } finally {
    await dispose()
  }
})

test('reads at most maxBytes and reports the byte count', async () => {
  const { dir, dispose } = await makeTemp()
  try {
    const file = path.join(dir, 'track.flac')
    await writeFile(file, Buffer.alloc(3 * 1024 * 1024, 7))
    const prefetcher = new TrackPrefetcher({ maxBytes: 1024 * 1024, chunkBytes: 256 * 1024 })
    const result = await prefetcher.prefetch(file)
    assert.equal(result.ok, true)
    assert.equal(result.bytes, 1024 * 1024, '只读到上限为止，不整文件读')
    assert.equal(prefetcher.active(), null, '完成后不再占着活动路径')
  } finally {
    await dispose()
  }
})

test('a newer prefetch cancels the in-flight one (切歌时旧预热必须让路)', async () => {
  const { dir, dispose } = await makeTemp()
  try {
    const first = path.join(dir, 'first.flac')
    const second = path.join(dir, 'second.flac')
    await writeFile(first, Buffer.alloc(16 * 1024 * 1024, 1))
    await writeFile(second, Buffer.alloc(64 * 1024, 2))
    const prefetcher = new TrackPrefetcher({ maxBytes: 16 * 1024 * 1024, chunkBytes: 64 * 1024 })
    const slow = prefetcher.prefetch(first)
    await new Promise((resolve) => setImmediate(resolve))
    prefetcher.cancel()
    const cancelled = await slow
    assert.equal(cancelled.cancelled, true, '被取消的预热必须如实报告')
    assert.ok(cancelled.bytes < 16 * 1024 * 1024)
    const fast = await prefetcher.prefetch(second)
    assert.equal(fast.ok, true)
    assert.equal(fast.bytes, 64 * 1024)
  } finally {
    await dispose()
  }
})
