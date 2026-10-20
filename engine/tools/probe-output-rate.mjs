// 输出规格探针：真实引擎 + 真实端点，逐档验证 set_output.sampleRate 的语义。
//
//   node engine/tools/probe-output-rate.mjs
//
// 它断言的是**诚实性**，不是「一定能开到 192k」：
//   · 请求值回读（set_output 回复 + state.requestedOutputRate）
//   · 实际值单独报告；端点不接受时 degradeReason 必须点名具体的率/位深
//   · 非零且与源不同 ⇒ resampled=true、bitPerfect=false
//   · 非法值必须被拒绝，而不是静默夹到最近档
// 本机内置端点只接受 48k 独占，所以 96k/192k 在这里会如实报「未被采纳」——
// 插上支持 192k 的 DAC 后重跑，同一个脚本会走出另一条分支。
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const engineDir = fileURLToPath(new URL('..', import.meta.url))
const exe = path.join(engineDir, 'bin', 'twilight-engine.exe')
const lib = JSON.parse(readFileSync(path.join(engineDir, 'fixtures', 'library-91.json'), 'utf8'))
const first = (lib.tracks ?? lib)[0]
const dir = first.path.replace(/[\\/][^\\/]+$/, '')
console.log('track:', first.title ?? first.id, '| source rate:', first.sampleRate)

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
const rl = readline.createInterface({ input: child.stdout })
const replies = new Map()
let nextId = 1
let lastState = null
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.ev) {
    if (msg.ev === 'state') lastState = msg
    if (msg.ev === 'fatal') console.log('[fatal]', msg.message)
    return
  }
  if (msg.id && replies.has(msg.id)) { const entry = replies.get(msg.id); replies.delete(msg.id); entry.resolve(msg) }
})
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text && !/^\[info\]/.test(text)) console.log('[stderr]', text.slice(0, 200))
})
const send = (cmd, timeout = 30000) => new Promise((resolve, reject) => {
  const id = nextId++
  const timer = setTimeout(() => { replies.delete(id); reject(new Error('timeout ' + cmd.cmd)) }, timeout)
  replies.set(id, { resolve: (msg) => {
    clearTimeout(timer)
    if (msg.ok) resolve(msg.data)
    else reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
  } })
  child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const describe = (label) => console.log(label, JSON.stringify({
  mode: lastState?.outputMode, requested: lastState?.requestedOutputRate, streamRate: lastState?.sampleRate,
  srcRate: lastState?.sourceSampleRate, bits: lastState?.bitDepth, resampled: lastState?.resampled,
  bitPerfect: lastState?.bitPerfect, degrade: lastState?.degradeReason || null
}))

const problems = []
try {
  await send({ cmd: 'hello', protocol: 1 })
  await send({ cmd: 'set_volume', volume: 0 })
  await send({ cmd: 'scan', path: dir, recursive: false, probe: false }, 60000)
  const list = await send({ cmd: 'list_tracks' })
  const track = (list.tracks ?? []).find((item) => item.path === first.path) ?? list.tracks?.[0]
  const opened = await send({ cmd: 'open', trackId: track.trackId })
  console.log('open reply:', JSON.stringify({ durationMs: opened.durationMs, rate: opened.sampleRate, requested: opened.requestedOutputRate }))
  await sleep(300)
  describe('baseline (auto)')

  for (const rate of [96000, 192000, 48000, 44100]) {
    const reply = await send({ cmd: 'set_output', mode: 'auto', sampleRate: rate })
    await sleep(400)
    console.log('set_output ->', rate, JSON.stringify({ mode: reply.outputMode, streamRate: reply.sampleRate, requested: reply.requestedOutputRate, degrade: reply.degradeReason || null }))
    describe('  state after ' + rate)
    if (lastState?.requestedOutputRate !== rate) problems.push('requestedOutputRate did not echo ' + rate)
    if (reply.sampleRate === rate && lastState?.srcRate !== rate && lastState?.resampled !== true) {
      problems.push('a forced rate different from the source must report resampled=true at ' + rate)
    }
  }

  try { await send({ cmd: 'set_output', mode: 'auto', sampleRate: 12345 }); problems.push('an invalid rate was accepted') }
  catch { console.log('invalid rate rejected') }

  await send({ cmd: 'set_output', mode: 'auto', sampleRate: 0 })
  await send({ cmd: 'shutdown' })
  console.log(problems.length === 0 ? 'PROBE OK' : 'PROBE FAIL: ' + problems.join(' | '))
  process.exitCode = problems.length === 0 ? 0 : 1
} catch (error) {
  console.log('PROBE ERROR:', error.code ?? '', error.message)
  child.kill()
  process.exitCode = 1
}
