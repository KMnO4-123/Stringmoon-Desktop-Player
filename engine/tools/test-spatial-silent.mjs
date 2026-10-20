// test-spatial-silent.mjs — CR-029 静音协议门禁（默认端点被占用时用 TE_DEVICE 指定端点）。
// 用法: node test-spatial-silent.mjs <library> <exe> [deviceId]
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const EXE_DEFAULT = fileURLToPath(new URL('../bin/twilight-engine.exe', import.meta.url))
const LIB = process.argv[2] || process.env.STRINGMOON_TEST_LIBRARY || 'D:\\Music'
const EXE = process.argv[3] || EXE_DEFAULT
const DEVICE = process.argv[4] || process.env.TE_DEVICE || ''
const child = spawn(EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(); let nextId = 0; const events = []; let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })
createInterface({ input: child.stdout }).on('line', (line) => {
  let f; try { f = JSON.parse(line) } catch { return }
  if (f.ev) { events.push(f); return }
  const p = pending.get(f.id); if (!p) return; pending.delete(f.id)
  f.ok ? p.resolve(f.data) : p.reject(Object.assign(new Error('engine error'), { frame: f }))
})
function request(cmd, timeoutMs = 60000) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + cmd.cmd)) }, timeoutMs)
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
  })
}
const lastState = () => events.filter((e) => e.ev === 'state').slice(-1)[0] || {}
// DSP 参数在渲染线程的下一个 block 才 adopt；dsp.passthrough 要等 adopt 后再读。
const settledState = async () => { await new Promise((r) => setTimeout(r, 200)); return await request({ cmd: 'get_state' }) }
const out = { errors: [], steps: {} }
function assert(c, m) { if (!c) out.errors.push('ASSERT: ' + m) }
async function expectError(cmd, name) {
  try { await request(cmd); out.errors.push(name + ': ACCEPTED(WRONG)'); return 'accepted' }
  catch (e) { return e.frame && e.frame.error ? e.frame.error.code : 'ERR' }
}
try {
  await new Promise((r, j) => { const i = setInterval(() => { if (events.some((e) => e.ev === 'ready')) { clearInterval(i); r() } }, 20); setTimeout(() => { clearInterval(i); j(new Error('no ready')) }, 15000) })
  await request({ cmd: 'set_muted', muted: true })
  await request({ cmd: 'set_output', mode: 'shared', ...(DEVICE ? { deviceId: DEVICE } : {}) })
  await request({ cmd: 'scan', path: LIB })
  await request({ cmd: 'open', trackId: (await request({ cmd: 'list_tracks' })).tracks[0].trackId })
  await request({ cmd: 'play' })

  const initial = lastState()
  out.steps.initial = initial.spatial
  assert(initial.spatial && initial.spatial.mode === 'off' && initial.spatial.active === false, 'default spatial is off/inactive')
  assert(!(initial.dspModules || []).includes('spatial'), 'dspModules has no spatial when off')

  out.steps.invalid = {
    mode: await expectError({ cmd: 'set_spatial', mode: 'dolby' }, 'mode=dolby'),
    amountLow: await expectError({ cmd: 'set_spatial', mode: 'crossfeed', amount: -0.1 }, 'amount=-0.1'),
    amountHigh: await expectError({ cmd: 'set_spatial', mode: 'crossfeed', amount: 1.1 }, 'amount=1.1'),
    azimuthLow: await expectError({ cmd: 'set_spatial', mode: 'virtual', azimuth: -91 }, 'azimuth=-91'),
    azimuthHigh: await expectError({ cmd: 'set_spatial', mode: 'virtual', azimuth: 91 }, 'azimuth=91'),
    delayHigh: await expectError({ cmd: 'set_spatial', mode: 'crossfeed', delayMs: 1.1 }, 'delay=1.1'),
    hrir: await expectError({ cmd: 'set_spatial', mode: 'virtual', hrir: 'wav' }, 'hrir=wav'),
    empty: await expectError({ cmd: 'set_spatial' }, 'empty set_spatial')
  }

  const virtual = await request({ cmd: 'set_spatial', mode: 'virtual', amount: 0.8, azimuth: 30, delayMs: 0.3 })
  out.steps.virtual = virtual
  const vState = await settledState()
  assert(virtual.mode === 'virtual' && virtual.active === true, 'virtual active reply')
  assert(virtual.latencyFrames === 1024, 'virtual reports 1024-frame convolution latency (got ' + virtual.latencyFrames + ')')
  assert((vState.dspModules || []).includes('spatial'), 'dspModules includes spatial when active')
  assert(vState.dsp && vState.dsp.passthrough === false, 'virtual disables bit-perfect passthrough')

  const zeros = await request({ cmd: 'set_spatial', mode: 'virtual', amount: 0 })
  out.steps.amountZero = zeros
  assert(zeros.active === false, 'amount=0 reports inactive (equivalent to off)')
  assert(!((lastState().dspModules) || []).includes('spatial'), 'amount=0 removes spatial from dspModules')

  const cross = await request({ cmd: 'set_spatial', mode: 'crossfeed', amount: 0.6 })
  out.steps.crossfeed = cross
  assert(cross.active === true && cross.latencyFrames === 0, 'crossfeed active without extra latency')
  const wide = await request({ cmd: 'set_spatial', mode: 'wide', amount: 0.5 })
  out.steps.wide = wide
  assert(wide.active === true, 'wide active')
  const off = await request({ cmd: 'set_spatial', mode: 'off' })
  out.steps.off = off
  const offState = await settledState()
  assert(off.active === false && offState.dsp && offState.dsp.passthrough === true, 'off restores passthrough')

  await request({ cmd: 'stop' })
  await request({ cmd: 'shutdown' })
} catch (e) {
  out.fatal = String(e && e.message ? e.message : e)
} finally {
  try { if (child.exitCode === null) child.kill() } catch {}
}
out.stderrTail = stderr.trim() ? stderr.trim().split(/\r?\n/).slice(-2) : []
out.pass = out.errors.length === 0 && !out.fatal
console.log(JSON.stringify(out, null, 1))
if (!out.pass) process.exitCode = 1