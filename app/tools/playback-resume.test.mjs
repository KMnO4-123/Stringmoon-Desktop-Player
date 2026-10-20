
import { test } from 'node:test'
import assert from 'node:assert/strict'

// renderer 侧模块会读 window.twilight；单测里用假桥接，验证命令顺序与解析逻辑。
const calls = []
let memory = null
let nextState = null
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    twilight: {
      playbackMemory: async () => memory,
      savePlaybackMemory: async (patch) => { calls.push(['savePlaybackMemory', patch]); return memory },
      clearPlaybackMemory: async () => { calls.push(['clearPlaybackMemory']) },
      request: async (cmd) => {
        calls.push([cmd.cmd, cmd])
        if (nextState && cmd.cmd === 'get_state') return { ok: true, data: nextState }
        if (cmd.cmd === 'open') return { ok: true, data: { trackId: cmd.trackId, durationMs: 180000 } }
        if (cmd.cmd === 'seek') return { ok: true, data: { positionMs: cmd.positionMs } }
        if (cmd.cmd === 'set_queue') return { ok: true, data: { count: cmd.trackIds.length } }
        return { ok: true, data: {} }
      },
      prefetchTrack: async (path) => { calls.push(['prefetchTrack', path]); return { ok: true, bytes: 1024, ms: 1 } },
      cancelPrefetch: async () => { calls.push(['cancelPrefetch']) }
    }
  }
})

const { useTwilight } = await import('../src/renderer/src/store.ts')
const resume = await import('../src/renderer/src/playbackResume.ts')
const { getPosition } = await import('../src/renderer/src/positionStore.ts')

const tracks = [
  { trackId: 'tl_a', title: 'A', artist: 'X', durationMs: 1000, path: 'D:/music/a.flac' },
  { trackId: 'tl_b', title: 'B', artist: 'Y', durationMs: 2000, path: 'D:/music/b.flac' }
]

test('no memory means no resume entry', async () => {
  memory = null
  useTwilight.getState().setTracks(tracks)
  assert.equal(await resume.loadResumeOffer(), null)
})

test('memory is resolved by normalised path after a rescan changed the trackId', async () => {
  useTwilight.getState().setTracks([{ ...tracks[0], trackId: 'tl_new_id' }, tracks[1]])
  // queue 里放当前 catalog 的 id（重扫后旧 id 会失效，恢复时被过滤 —— 这条正是要覆盖的）
  memory = { version: 1, filePath: 'd:\\music\\a.flac', trackId: 'tl_old_id', positionMs: 42000, durationMs: 180000, queue: ['tl_new_id', 'tl_b'], repeatMode: 'sequential', updatedAt: 1 }
  const offer = await resume.loadResumeOffer()
  assert.ok(offer)
  assert.equal(offer.track.trackId, 'tl_new_id', 'path is the stable identity')
  assert.equal(offer.positionMs, 42000)
})

test('resuming opens, seeks and stays paused — it never sends play', async () => {
  calls.length = 0
  useTwilight.setState({ queueCapable: true, engineUp: true })
  useTwilight.getState().setQueueIds(['tl_a', 'tl_b'])
  const offer = await resume.loadResumeOffer()
  const ok = await resume.resumePlayback(offer)
  assert.equal(ok, true)
  const order = calls.map(([name]) => name)
  assert.deepEqual(order.slice(0, 3), ['set_queue', 'open', 'seek'])
  assert.equal(order.includes('play'), false, 'resume must not start playback')
  assert.equal(order.includes('set_volume'), false)
  const queue = calls.find(([name]) => name === 'set_queue')[1].trackIds
  assert.deepEqual(queue, ['tl_new_id', 'tl_b'], 'queue comes from the memory, filtered against the current catalog')
  assert.equal(getPosition().positionMs, 42000)
  assert.equal(getPosition().trackId, 'tl_new_id')
})

test('a memory whose track is gone is not offered (and a dead record is cleared)', async () => {
  useTwilight.getState().setTracks(tracks)
  // 注意：canRestoreMemory 只看「路径是否绝对且是音频扩展名」，不看文件是否存在；
  // 真正「不可恢复」的是「既没有路径、也没有能解析的 trackId」这种记忆。
  memory = { version: 1, filePath: '', trackId: 'tl_gone', positionMs: 1, durationMs: 1, queue: [], repeatMode: 'sequential', updatedAt: 1 }
  const offer = await resume.loadResumeOffer()
  assert.equal(offer, null)
  assert.ok(calls.some(([name]) => name === 'clearPlaybackMemory'), 'unrestorable memory is cleared')
})