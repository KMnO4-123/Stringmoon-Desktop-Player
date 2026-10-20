#!/usr/bin/env node
/**
 * tools/mock-engine.mjs — 「假引擎」：假装自己是 twilight-engine.exe。
 *
 * 铁律（BRIEF-B §3 / CONTRACT §3）：
 *  - stdout 只输出 JSON Lines（UTF-8，\n 结尾），一条一个 JSON，绝不写日志；
 *    人类可读日志一律走 stderr。
 *  - 命令必须带 id；回复必须带回同一 id。字段名与 CONTRACT §3 逐字一致。
 *  - 消息时间单位一律毫秒整数；音量 0.0–1.0 float。
 *  - play 后 position 事件自己往前走（250ms 周期）。
 *
 * 换真引擎时本文件不参与运行——主进程只改 spawn 目标（见 src/main/engine-host.ts 顶部说明）。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = 1
const ENGINE_VERSION = '0.1.0-mock'
const TICK_MS = 250

const stderrLog = (...args) => process.stderr.write('[mock-engine] ' + args.join(' ') + '\n')
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const replyOk = (id, data) => send({ id, ok: true, data })
const replyErr = (id, code, message) => send({ id, ok: false, error: { code, message } })

/** 确定性伪随机（同一文件名永远得到同一条时长），90s–420s */
function hashDurationMs(name) {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 90_000 + (Math.abs(h) % 330_000) + (name.length % 7) * 1000
}

/** 从文件名解析 Artist - Title（保留原文里的连续空格等“脏数据”以测试 UI 韧性） */
function parseName(basename) {
  const stem = basename.replace(/\.flac$/i, '')
  const m = stem.match(/^(.+?)\s+-\s+(.+)$/)
  if (m) return { artist: m[1].trim(), title: m[2] }
  return { artist: '未知艺术家', title: stem }
}

const state = {
  library: [],            // [{trackId,title,artist,album,durationMs,path,sampleRate,bitDepth}]
  loadedIndex: -1,
  playing: false,
  positionMs: 0,
  anchorAt: 0,            // Date.now() when playback (re)started, positionMs 为锚点
  volume: 0.8,
  muted: false,
  repeatMode: 'sequential',
  outputMode: 'exclusive',  // 保持 mock 原有默认，别让既有断言悄悄变味
  tick: null
}

function currentTrack() {
  return state.loadedIndex >= 0 ? state.library[state.loadedIndex] : null
}
function effectivePositionMs() {
  const t = currentTrack()
  if (!t) return 0
  const p = state.playing ? state.positionMs + (Date.now() - state.anchorAt) : state.positionMs
  return Math.min(Math.round(p), t.durationMs)
}
function emitState() {
  const t = currentTrack()
  if (!t) return
  send({
    ev: 'state',
    state: state.playing ? 'playing' : 'paused',
    trackId: t.trackId,
    outputMode: state.outputMode,
    sampleRate: 96000,
    bitDepth: 24,
    bitPerfect: true,
    // 与真引擎同形的两个「只有引擎知道」的事实（player.cpp:540/:543）。
    repeatMode: state.repeatMode,
    muted: state.muted,
    volume: state.volume
  })
}
function startPlayback() {
  const t = currentTrack()
  if (!t) return false
  state.playing = true
  state.anchorAt = Date.now()
  if (!state.tick) {
    state.tick = setInterval(() => {
      const tr = currentTrack()
      if (!tr || !state.playing) return
      const pos = effectivePositionMs()
      send({ ev: 'position', trackId: tr.trackId, positionMs: pos, durationMs: tr.durationMs })
      if (pos >= tr.durationMs) {
        // 自然播完：ended(eof)，不自动续播——队列归应用侧管（见 checkpoint 决策）
        state.playing = false
        state.positionMs = tr.durationMs
        clearInterval(state.tick); state.tick = null
        send({ ev: 'ended', trackId: tr.trackId, reason: 'eof' })
        emitState()
      }
    }, TICK_MS)
  }
  emitState()
  return true
}
function pausePlayback() {
  if (!state.playing) return
  state.positionMs = effectivePositionMs()
  state.playing = false
  if (state.tick) { clearInterval(state.tick); state.tick = null }
  emitState()
}
function stopPlayback() {
  const t = currentTrack()
  state.playing = false
  state.positionMs = 0
  if (state.tick) { clearInterval(state.tick); state.tick = null }
  if (t) emitState()
}
/** 装载第 i 首（不发事件，由调用方决定发什么） */
function loadIndex(i) {
  state.loadedIndex = ((i % state.library.length) + state.library.length) % state.library.length
  state.positionMs = 0
  state.playing = false
  if (state.tick) { clearInterval(state.tick); state.tick = null }
}

function handleCommand(msg) {
  const id = msg?.id
  if (typeof id !== 'number') {
    stderrLog('command without numeric id, ignored:', JSON.stringify(msg).slice(0, 120))
    return
  }
  switch (msg.cmd) {
    case 'hello':
      replyOk(id, { protocol: PROTOCOL_VERSION, version: ENGINE_VERSION })
      send({ ev: 'ready', protocol: PROTOCOL_VERSION, version: ENGINE_VERSION, devices: [
        { id: 'mock-out-0', name: 'Mock WASAPI Output ( Speakers )', isDefault: true }
      ] })
      break
    case 'pick_folder':
      replyErr(id, 'ERR_UNSUPPORTED', 'mock: pick_folder not supported')
      break
    case 'scan': {
      const dir = typeof msg.path === 'string' ? msg.path : ''
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        replyErr(id, 'ERR_NOTFOUND', 'scan path not found: ' + dir)
        break
      }
      const names = fs.readdirSync(dir).filter((n) => /\.flac$/i.test(n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      state.library = names.map((n, i) => {
        const { artist, title } = parseName(n)
        return {
          trackId: 'tl_' + String(i + 1).padStart(4, '0'),
          title, artist,
          album: 'Twilight Test Library',
          durationMs: hashDurationMs(n),
          path: path.join(dir, n),
          sampleRate: 96000,
          bitDepth: 24
        }
      })
      let done = 0
      const total = state.library.length
      const step = Math.max(1, Math.floor(total / 10))
      for (let i = 0; i < total; i++) {
        done = i + 1
        if (done % step === 0 || done === total) send({ ev: 'scan_progress', done, total })
      }
      send({ ev: 'scan_done', added: total, failed: 0 })
      replyOk(id, { added: total, failed: 0 })
      break
    }
    case 'list_tracks':
      replyOk(id, { tracks: state.library })
      break
    case 'open': {
      const idx = state.library.findIndex((t) => t.trackId === msg.trackId)
      if (idx < 0) { replyErr(id, 'ERR_NOTFOUND', 'unknown trackId: ' + msg.trackId); break }
      loadIndex(idx)
      const t = currentTrack()
      replyOk(id, { trackId: t.trackId, durationMs: t.durationMs })
      emitState() // state: paused（已装载未播放）
      break
    }
    case 'play': {
      if (!currentTrack()) { replyErr(id, 'ERR_STATE', 'no track loaded — open first'); break }
      if (!state.playing) startPlayback()
      replyOk(id, {})
      break
    }
    case 'pause':
      pausePlayback()
      replyOk(id, {})
      break
    case 'stop':
      stopPlayback()
      replyOk(id, {})
      break
    case 'next': {
      if (state.library.length === 0) { replyErr(id, 'ERR_STATE', 'library empty'); break }
      const old = currentTrack()
      const wasPlaying = state.playing
      if (old && wasPlaying) send({ ev: 'ended', trackId: old.trackId, reason: 'stop' })
      loadIndex(state.loadedIndex + 1)
      if (wasPlaying) startPlayback()
      else emitState()
      replyOk(id, { trackId: currentTrack().trackId })
      break
    }
    case 'prev': {
      if (state.library.length === 0) { replyErr(id, 'ERR_STATE', 'library empty'); break }
      const old = currentTrack()
      const wasPlaying = state.playing
      if (old && wasPlaying) send({ ev: 'ended', trackId: old.trackId, reason: 'stop' })
      loadIndex(state.loadedIndex - 1)
      if (wasPlaying) startPlayback()
      else emitState()
      replyOk(id, { trackId: currentTrack().trackId })
      break
    }
    case 'seek': {
      const t = currentTrack()
      if (!t) { replyErr(id, 'ERR_STATE', 'no track loaded'); break }
      const p = typeof msg.positionMs === 'number' && msg.positionMs >= 0 ? msg.positionMs : 0
      state.positionMs = Math.min(p, t.durationMs)
      state.anchorAt = Date.now()
      replyOk(id, { positionMs: Math.round(state.positionMs) })
      send({ ev: 'position', trackId: t.trackId, positionMs: Math.round(effectivePositionMs()), durationMs: t.durationMs })
      break
    }
    case 'set_volume': {
      const v = typeof msg.volume === 'number' ? Math.min(1, Math.max(0, msg.volume)) : state.volume
      state.volume = v
      replyOk(id, { volume: v })
      break
    }
    case 'set_output': {
      const mode = typeof msg.mode === 'string' ? msg.mode : 'auto'
      if (mode !== 'auto' && mode !== 'shared' && mode !== 'exclusive') {
        replyErr(id, 'ERR_STATE', 'mode must be one of exclusive | shared | auto')
        break
      }
      // 真引擎在这里会重开流；mock 只把它记下来并如实上报实际模式。
      // 故意不让 'auto' 变成 'exclusive'：应用要能看出「我请求了自动」与「实际是独占」不是一回事。
      state.outputMode = mode === 'auto' ? (state.outputMode === 'none' ? 'shared' : state.outputMode) : mode
      replyOk(id, { mode })
      emitState()
      break
    }
    case 'set_muted': {
      if (typeof msg.muted !== 'boolean') {
        replyErr(id, 'ERR_STATE', 'set_muted requires a boolean muted')
        break
      }
      state.muted = msg.muted
      // 音量**原样回显**：静音不改音量是引擎的明确语义，mock 不在这里发明别的。
      replyOk(id, { muted: state.muted, volume: state.volume })
      if (currentTrack()) emitState()
      break
    }
    case 'set_repeat': {
      const mode = typeof msg.mode === 'string' ? msg.mode : ''
      if (!['sequential', 'one', 'all', 'shuffle'].includes(mode)) {
        replyErr(id, 'ERR_STATE', 'mode must be one of sequential | one | all | shuffle')
        break
      }
      state.repeatMode = mode
      replyOk(id, { mode })
      if (currentTrack()) emitState()
      break
    }
    case 'get_state':
      if (currentTrack()) emitState()
      replyOk(id, {})
      break
    case 'list_devices':
      replyOk(id, { devices: [{ id: 'mock-out-0', name: 'Mock WASAPI Output ( Speakers )', isDefault: true }] })
      break
    case 'shutdown':
      replyOk(id, {})
      stderrLog('shutdown requested; exiting 0')
      setTimeout(() => process.exit(0), 60)
      break
    default:
      replyErr(id, 'ERR_UNSUPPORTED', 'unknown cmd: ' + String(msg.cmd))
  }
}

// stdin：逐行 JSON.parse；坏行记 stderr 并继续（引擎侧宽容，应用侧严格）
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch (e) {
    stderrLog('non-JSON command line ignored:', trimmed.slice(0, 160))
    return
  }
  try { handleCommand(msg) } catch (e) {
    stderrLog('handler error:', e && e.stack ? e.stack : String(e))
    if (typeof msg?.id === 'number') replyErr(msg.id, 'ERR_INTERNAL', String(e && e.message ? e.message : e))
  }
})
rl.on('close', () => { stderrLog('stdin closed; exiting'); process.exit(0) })
process.on('uncaughtException', (e) => {
  stderrLog('uncaughtException:', e && e.stack ? e.stack : String(e))
  send({ ev: 'fatal', code: 'ERR_INTERNAL', message: String(e && e.message ? e.message : e) })
  process.exit(1)
})
stderrLog('mock-engine up, protocol', PROTOCOL_VERSION)
