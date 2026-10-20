// Verify the CR-017 engine changes against the REAL engine:
//   ① recursive scan finds files in subdirectories
//   ② probe=true keeps unplayable formats OUT of the library
//   ③ auto-advance SKIPS an unplayable entry and reaches the next good one
//   ④ defaults (no flags) are unchanged, per CR-013
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const EXE = fileURLToPath(new URL('../../engine/bin/twilight-engine.exe', import.meta.url))
const DATA = fileURLToPath(new URL('../../engine/third_party/taglib-2.3.2/tests/data/', import.meta.url))
// Override with STRINGMOON_TEST_GOOD_TRACK when a manual run wants a specific file.
const GOOD = process.env.STRINGMOON_TEST_GOOD_TRACK ?? join(process.env.STRINGMOON_TEST_LIBRARY ?? 'D:/Music', 'track-01.flac')

let checks = 0, failures = 0
const check = (ok, label) => { checks++; if (ok) console.log('  ok  - ' + label); else { failures++; console.error('  FAIL- ' + label) } }

// ── fixture: nested layout + one unplayable format + one truncated file ─────
// The playable file is SHORT on purpose: the test has to actually cross the
// track boundary for the skip to happen, and waiting out a 5-minute song would
// make the suite useless.
const SHORT = join(DATA, 'sinewave.flac')   // ~3.5 s
const root = mkdtempSync(join(tmpdir(), 'te-cr017-'))
mkdirSync(join(root, 'album-one'), { recursive: true })
mkdirSync(join(root, 'album-two', 'deeper'), { recursive: true })
copyFileSync(SHORT, join(root, 'top.flac'))
copyFileSync(SHORT, join(root, 'album-one', 'one.flac'))
copyFileSync(SHORT, join(root, 'album-two', 'deeper', 'deep.flac'))
// Opus in .opus: an extension this build ACCEPTS and a codec it cannot decode.
// (This used to be test.ogg -- until Ogg Vorbis actually started decoding, at
// which point the fixture stopped being unplayable and this test would have
// passed vacuously.)
copyFileSync(join(DATA, 'correctness_gain_silent_output.opus'), join(root, 'bad.opus'))
const flac = readFileSync(SHORT)
writeFileSync(join(root, 'truncated.flac'), flac.subarray(0, Math.floor(flac.length / 3)))  // corrupt

const child = spawn(EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(); const events = []; let id = 0; let stderr = ''
child.stderr.on('data', (c) => { stderr += c })
createInterface({ input: child.stdout }).on('line', (line) => {
  let f; try { f = JSON.parse(line) } catch { return }
  if (typeof f.id === 'number' && pending.has(f.id)) {
    const p = pending.get(f.id); pending.delete(f.id)
    f.ok ? p.resolve(f.data) : p.reject(Object.assign(new Error(f.error.message), { code: f.error.code }))
  } else events.push(f)
})
const request = (cmd, ms = 120000) => {
  const rid = ++id
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(rid); reject(new Error('timeout ' + cmd.cmd)) }, ms)
    pending.set(rid, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    child.stdin.write(JSON.stringify({ id: rid, ...cmd }) + '\n')
  })
}
const nameOf = (p) => String(p).split(/[\\/]/).pop()

const indexed = (r) => r.tracks.map((t) => nameOf(t.path)).sort()
const scan = (extra) => request({ cmd: 'scan', path: root, ...extra })

try {
  await request({ cmd: 'hello', protocol: 1 })
  await request({ cmd: 'set_muted', muted: true })
  await request({ cmd: 'set_output', mode: 'shared' })

  // ④ defaults unchanged: non-recursive, no probe
  console.log('\n④ default scan (no flags) = old behaviour: top level only, no probe')
  const plain = await scan({})
  check(JSON.stringify(indexed(plain)) === JSON.stringify(['bad.opus', 'top.flac', 'truncated.flac']),
    'default scan is still NON-recursive and does NOT probe: ' + indexed(plain).join(', '))
  check(plain.unplayable === 0, 'default scan reports unplayable=0 (no probing requested)')

  // ① recursion
  console.log('\n① recursive scan reaches subdirectories')
  const rec = await scan({ recursive: true })
  // Already-known top-level files are skipped; the nested ones must appear.
  check(indexed(rec).includes('one.flac'), 'recursive scan found album-one/one.flac')
  check(indexed(rec).includes('deep.flac'), 'recursive scan found album-two/deeper/deep.flac')

  // ② probe keeps unplayable files out
  console.log('\n② probe=true keeps the undecodable format OUT of the library')
  const before = indexed(rec)
  check(before.includes('bad.opus'), 'without probe, bad.opus is in the library (the old bug)')

  // Fresh engine state is needed to re-admit bad.opus through the probe, so use
  // `replace` to drop the tree and scan it again WITH the probe.
  const probed = await request({ cmd: 'scan', path: root, replace: true, recursive: true, probe: true })
  const after = indexed(probed)
  check(!after.includes('bad.opus'), 'probe=true EXCLUDED bad.opus from the library')
  check(probed.unplayable >= 1, `probe reported unplayable=${probed.unplayable}`)
  check(Array.isArray(probed.unplayablePaths) && probed.unplayablePaths.some((p) => p.endsWith('bad.opus')),
    'the unplayable file is NAMED in unplayablePaths, not just counted')
  const doneEvent = events.filter((e) => e.ev === 'scan_done').at(-1)
  check(doneEvent && doneEvent.unplayable >= 1, `scan_done carries unplayable=${doneEvent?.unplayable}`)

  // ③ the reported symptom: queue must skip the bad entry and keep going
  console.log('\n③ auto-advance SKIPS an unplayable entry instead of dying')
  // The realistic shape: bad.opus is indexed the way it would be WITHOUT the
  // probe (an already-scanned library, or a file that broke after indexing), so
  // it sits in the queue by a LIVE id. That is what the user actually hits --
  // the queue holds ids, and the file fails only when playback reaches it.
  const plain2 = await request({ cmd: 'scan', path: root, replace: true, recursive: true })
  const tracks = plain2.tracks
  const good1 = tracks.find((t) => nameOf(t.path) === 'top.flac')
  const good2 = tracks.find((t) => nameOf(t.path) === 'one.flac')
  const bad = tracks.find((t) => nameOf(t.path) === 'bad.opus')
  check(Boolean(good1 && good2 && bad), 'fixture: two playable tracks bracketing the unplayable one')

  await request({ cmd: 'set_queue', trackIds: [good1.trackId, bad.trackId, good2.trackId] })
  const mark = events.length
  await request({ cmd: 'open', trackId: good1.trackId })
  await request({ cmd: 'play' })
  // Wait for the END state rather than sleeping a fixed amount: playback passes
  // through a brief stopped→playing transition as it skips, and sampling on a
  // fixed delay lands there often enough to make the assertion flaky.
  const deadline = Date.now() + 25000
  let cur = ''
  while (Date.now() < deadline) {
    const st = await request({ cmd: 'get_state' })
    cur = nameOf(plain2.tracks.find((t) => t.trackId === st.trackId)?.path ?? '(none)')
    // The two things we are waiting for: a good track is loaded AND it is
    // actually playing (the skip is over, not mid-transition).
    if (cur === 'one.flac' && st.state === 'playing') break
    await delay(250)
  }
  const st = await request({ cmd: 'get_state' })
  const logs = events.slice(mark).filter((e) => e.ev === 'log').map((e) => e.message)
  const errored = events.slice(mark).filter((e) => e.ev === 'ended' && e.reason === 'error')
  console.log('     engine logs: ' + (logs.join(' | ') || '(none)'))
  console.log(`     ended(reason=error) events: ${errored.length}`)
  console.log(`     final state=${st.state} current=${cur}`)
  check(errored.length >= 1, 'the unplayable entry was REPORTED via ended reason=error (so the app can mark it)')
  check(errored[0]?.trackId === bad.trackId, 'the error event names the BAD track, so the app marks the right row')
  check(cur === 'one.flac', `playback SKIPPED the bad entry and reached the next good track (${cur})`)

  await request({ cmd: 'shutdown' })
} catch (e) {
  failures++
  console.error('ERROR ' + (e?.stack ?? e))
  console.error(stderr.split('\n').slice(-12).join('\n'))
} finally {
  if (child.exitCode === null) child.kill()
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nCR-017 engine checks: ${checks - failures}/${checks} passed`)
process.exitCode = failures ? 1 : 0
