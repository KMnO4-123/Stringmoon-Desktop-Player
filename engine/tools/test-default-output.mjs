#!/usr/bin/env node
// Regression gate for the user-facing default: "自动" must be sent to the
// engine even when no fixed output rate was selected. A clean auto stream may
// land on exclusive or fall back to shared with an explicit reason.

import { spawn } from 'node:child_process'
import { join } from 'node:path'

const enginePath = join(import.meta.dirname, '..', 'bin', 'twilight-engine.exe')
const library = process.env.TWILIGHT_LIBRARY ?? process.env.STRINGMOON_TEST_LIBRARY ?? 'D:\\Music'

const child = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
let buffer = ''
let nextId = 1
const pending = new Map()
const events = []

child.stdout.on('data', (data) => {
  buffer += data.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const frame = JSON.parse(line)
    if (frame.ev) events.push(frame)
    else pending.get(frame.id)?.(frame)
    pending.delete(frame.id)
  }
})

function request(command, timeoutMs = 120000) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ id, ...command }) + '\n')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout waiting for ' + command.cmd))
    }, timeoutMs)
    pending.set(id, (frame) => {
      clearTimeout(timer)
      resolve(frame)
    })
  })
}

function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const match = events.find(predicate)
      if (match) {
        clearInterval(poll)
        resolve(match)
      } else if (Date.now() >= deadline) {
        clearInterval(poll)
        reject(new Error('timed out waiting for engine event'))
      }
    }, 25)
  })
}

try {
  await waitFor((event) => event.ev === 'ready')
  // 这是"自动输出模式"的回归测试，不是听音测试：先静音再播放，避免自动化测量在
  // 默认端点上真的出声。mute 不影响下面 outputMode / degradeReason 的断言
  // （CONTRACT 3.4 的降级表达与增益无关，实际音量在 render 线程乘以 0 而已）。
  // 可选非默认端点（TE_DEVICE）：用户实例占用默认端点时仍能验证 auto 模式的
  // "不得静默降级"语义；报告里必须注明这是非默认端点变体。
  const device = process.env.TE_DEVICE || ''
  if (device) {
    const selected = await request({ cmd: 'set_output', mode: 'auto', deviceId: device })
    if (!selected.ok) throw new Error('set_output device failed: ' + JSON.stringify(selected.error))
  }
  const muted = await request({ cmd: 'set_muted', muted: true })
  if (!muted.ok) throw new Error('set_muted failed: ' + JSON.stringify(muted.error))
  const scan = await request({ cmd: 'scan', path: library })
  if (!scan.ok || !scan.data?.tracks?.length) throw new Error('scan returned no tracks')
  const open = await request({ cmd: 'open', trackId: scan.data.tracks[0].trackId })
  if (!open.ok) throw new Error('open failed: ' + JSON.stringify(open.error))
  if (!(await request({ cmd: 'play' })).ok) throw new Error('play failed')
  const playing = await waitFor((event) => event.ev === 'state' && event.state === 'playing')
  if (playing.outputMode === 'shared' && !playing.degradeReason) {
    throw new Error('automatic output silently stayed shared without a degradation reason')
  }
  if (playing.outputMode !== 'shared' && playing.outputMode !== 'exclusive') {
    throw new Error('unexpected output mode: ' + playing.outputMode)
  }
  console.log('default output PASS:', JSON.stringify({
    outputMode: playing.outputMode,
    degradeReason: playing.degradeReason || '',
    sampleRate: playing.sampleRate,
  }))
} finally {
  try { await request({ cmd: 'stop' }, 5000) } catch {}
  try { await request({ cmd: 'shutdown' }, 5000) } catch {}
  child.stdin.end()
}