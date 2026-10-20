
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ReplayGain 接线（P0）单测：mock preload 桥接，验证命令序列与事件配对，不碰 Electron。
const stored = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) }
})

const calls = []
let engineListener = null
let replyId = 7
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    twilight: {
      onEvent: (cb) => { engineListener = cb; return () => { engineListener = null } },
      request: async (cmd) => {
        calls.push(cmd)
        if (cmd.cmd === 'analyze_loudness') return { ok: true, data: { accepted: true, total: cmd.trackIds.length, replyId } }
        if (cmd.cmd === 'set_replaygain') return { ok: true, data: { dspModules: cmd.mode === 'off' ? [] : ['replaygain'], replayGain: { mode: cmd.mode } } }
        return { ok: true, data: {} }
      }
    }
  }
})

const { useTwilight } = await import('../src/renderer/src/store.ts')
const rg = await import('../src/renderer/src/audio/replayGain.ts')

const track = { trackId: 'tl_rg', title: 'RG', artist: 'X', durationMs: 1000, path: 'D:/music/rg.flac' }
const playing = (trackId = 'tl_rg') => useTwilight.setState({ loadedTrackId: trackId, playState: 'playing', engineTracks: [track], tracks: [track] })

test('disabled by default: playing a track sends no ReplayGain command', async () => {
  rg.startReplayGain()
  playing()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.length, 0, 'default off must not touch the engine')
  assert.equal(rg.replayGain.getSnapshot().enabled, false)
})

test('enabling analyses the playing track once, then applies the measured true-peak gain', async () => {
  calls.length = 0
  rg.setReplayGainEnabled(true)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls[0]?.cmd, 'analyze_loudness')
  assert.deepEqual(calls[0].trackIds, ['tl_rg'])
  assert.equal(calls[0].async, true)
  // 扫描完成事件（replyId 对应 analyze 的异步回复）
  engineListener({ ev: 'loudness_done', replyId, data: { tracks: [{ trackId: 'tl_rg', ok: true, gainDb: -6.5, truePeakDb: -1.2, peakLinear: 0.87 }], album: { ok: false, reason: 'async mode does not provide album gain' } } })
  await new Promise((r) => setTimeout(r, 10))
  const apply = calls.find((cmd) => cmd.cmd === 'set_replaygain')
  assert.ok(apply, 'a successful scan must be applied')
  assert.equal(apply.mode, 'track')
  assert.equal(apply.trackGainDb, -6.5)
  assert.equal(apply.trackPeak, 0.87, 'preventClip uses the engine true-peak linear value')
  assert.equal(apply.preventClip, true)
  assert.equal(apply.preampDb, 0)
  assert.equal(rg.replayGain.getSnapshot().analysed, 1)
})

test('the same track is not scanned twice in one session', async () => {
  calls.length = 0
  useTwilight.setState({ playState: 'paused' })
  playing()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.filter((cmd) => cmd.cmd === 'analyze_loudness').length, 0, 'known gain is applied directly')
  assert.equal(calls.filter((cmd) => cmd.cmd === 'set_replaygain').length, 1)
})

test('turning the switch off immediately zeroes the engine gain', async () => {
  calls.length = 0
  rg.setReplayGainEnabled(false)
  await new Promise((r) => setTimeout(r, 10))
  const off = calls.find((cmd) => cmd.cmd === 'set_replaygain')
  assert.ok(off)
  assert.equal(off.mode, 'off')
  assert.equal(rg.replayGain.getSnapshot().enabled, false)
})
