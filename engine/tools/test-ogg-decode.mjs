// Ogg support, verified against the REAL engine rather than against the code.
//
// What this is defending, and why each check exists:
//
//   .ogg is a CONTAINER, not a codec. The same extension carries Vorbis (lossy)
//   and Ogg-encapsulated FLAC (lossless). Both have to decode, and the engine has
//   to report the right answer for state.sourceExact -- a lossy file reported as
//   lossless tells the user their chain is transparent when the file is what it
//   is, and the reverse sends them hunting for a defect that does not exist.
//
//   "Opens successfully" and "plays the right audio" are different claims. A
//   decoder that returns silence, or the wrong window after a seek, passes every
//   metadata assertion. So the decode checks compare against an INDEPENDENT
//   ground truth: --probe-format seeks and then compares the samples it yields
//   with a fresh sequential decode of the same region.
//
//   The length has to be EXACT. The end-of-track decision compares rendered
//   frames against totalFrames(), so a length that is one block short leaves the
//   track stuck at 99% forever, and one block long appends silence to every song.
//   --full decodes to the end and compares the count against the claim.
//
// Fixtures: taglib's test data (tiny, for the container-level checks) plus real
// game BGM from this machine (for the "this actually decodes music" checks).
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const EXE = fileURLToPath(new URL('../../engine/bin/twilight-engine.exe', import.meta.url))
const DATA = fileURLToPath(new URL('../../engine/third_party/taglib-2.3.2/tests/data/', import.meta.url))

// Real Vorbis music on this machine. If it is absent the checks that need it are
// reported as SKIPPED rather than quietly passing on a silent fixture -- a
// fixture that decodes to pure silence cannot tell a working decoder from a
// broken one, and that is the whole point of these checks.
const REAL = {
  // 32 s, 48 kHz stereo -- long enough that the seek matrix covers the middle of
  // the file rather than falling off the end of a 5-second jingle.
  stereo: 'D:/HappyDDZ/GameNew/cdnpackages/Sound/bgm/2024zhounianqing/MusicEx_Normal.ogg',
  mono: 'D:/HappyDDZ/GameNew/cdnpackages/Sound/huaxiaM_Dialect_Package/Chat_11706.ogg',
}

let checks = 0, failures = 0, skipped = 0
const check = (ok, label) => { checks++; if (ok) console.log('  ok  - ' + label); else { failures++; console.error('  FAIL- ' + label) } }
const skip = (label) => { skipped++; console.log('  SKIP- ' + label) }

// ---------------------------------------------------------------------------
// Independent Ogg page parser.
//
// This is the ground truth for the reported LENGTH: it reads the granule
// position of the stream's last page straight out of the file, with no engine
// code involved. Comparing the engine against its own arithmetic would only show
// that it is self-consistent.
// ---------------------------------------------------------------------------
function lastGranule(buf) {
  let i = 0, last = 0, serial = null
  const serials = new Set()
  while (i + 27 <= buf.length) {
    if (buf.toString('latin1', i, i + 4) !== 'OggS') { i++; continue }
    const segs = buf[i + 26]
    if (i + 27 + segs > buf.length) break
    let body = 0
    for (let s = 0; s < segs; s++) body += buf[i + 27 + s]
    if (i + 27 + segs + body > buf.length) break
    const s = buf.readUInt32LE(i + 14)
    serials.add(s)
    if (serial === null) serial = s
    const g = buf.readBigUInt64LE(i + 6)
    if (s === serial && g !== 0xffffffffffffffffn) last = Number(g)
    i += 27 + segs + body
  }
  return { last, serials: [...serials] }
}

// ---------------------------------------------------------------------------
// --probe-format output, parsed into key=value maps.
// ---------------------------------------------------------------------------
async function probe(args) {
  try {
    const { stdout } = await execFileAsync(EXE, ['--probe-format', ...args], { windowsHide: true, maxBuffer: 8 << 20 })
    return { code: 0, lines: stdout.trim().split(/\r?\n/).filter(Boolean) }
  } catch (e) {
    return { code: e.code ?? 1, lines: String(e.stdout ?? '').trim().split(/\r?\n/).filter(Boolean) }
  }
}
const fields = (line) => Object.fromEntries(line.replace(/^\s+/, '').split(/\s+/)
  .filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))

// ---------------------------------------------------------------------------
// Engine protocol client (for the library-level checks).
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'te-ogg-'))
copyFileSync(join(DATA, 'test.ogg'), join(root, 'vorbis.ogg'))
copyFileSync(join(DATA, 'empty_flac.oga'), join(root, 'lossless.oga'))
copyFileSync(join(DATA, 'correctness_gain_silent_output.opus'), join(root, 'opus.opus'))
copyFileSync(join(DATA, 'segfault.oga'), join(root, 'broken.ogg'))

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

try {
  // ── ① the decoders, through the production open path ──────────────────────
  console.log('\n① Ogg Vorbis and Ogg FLAC both decode, and report the right nature')
  {
    const r = await probe([join(DATA, 'test.ogg'), join(DATA, 'empty_flac.oga')])
    const vorbis = fields(r.lines.find((l) => l.includes('test.ogg')) ?? '')
    const flac = fields(r.lines.find((l) => l.includes('empty_flac.oga')) ?? '')
    check(vorbis.ok === '1', 'Ogg VORBIS opens (was "not decodable" before this work)')
    check(vorbis.lossless === '0', 'Ogg Vorbis reports lossless=0 -- it is a lossy codec')
    check(flac.ok === '1', 'Ogg FLAC opens (the lossless half of .ogg)')
    check(flac.lossless === '1', 'Ogg FLAC reports lossless=1 -- lossless is not inferred from ".ogg"')

    // Length cross-check against an independent page parse, not against itself.
    for (const [file, label] of [[join(DATA, 'test.ogg'), 'vorbis'], [join(DATA, 'empty_flac.oga'), 'ogg-flac']]) {
      const truth = lastGranule(readFileSync(file))
      const f = fields(r.lines.find((l) => l.includes(file.split(/[\\/]/).pop())) ?? '')
      check(Number(f.frames) === truth.last,
        `${label}: reported length ${f.frames} matches the last page's granule position ${truth.last}`)
    }
  }

  // ── ② exact length and bit-exact seeks on real music ─────────────────────
  console.log('\n② real Vorbis music: exact length, real samples, bit-exact seeks')
  if (!existsSync(REAL.stereo)) {
    skip('real .ogg fixtures not present on this machine (' + REAL.stereo + ')')
  } else {
    for (const seekMs of [0, 500, 3000, 15000]) {
      const { lines } = await probe([REAL.stereo, '--seek', String(seekMs)])
      const seek = fields(lines.find((l) => l.includes('seek_ms=')) ?? '')
      check(seek.matched === '1',
        `seek to ${seekMs} ms lands on the SAME samples as a fresh sequential decode (maxDiff=${seek.maxDiff})`)
    }
    const { lines } = await probe([REAL.stereo, '--full'])
    const top = fields(lines[0] ?? '')
    const full = fields(lines.find((l) => l.includes('full_decode')) ?? '')
    check(top.ok === '1', 'stereo 48 kHz Vorbis opens')
    check(top.channels === '2' && top.rate === '48000', `stereo Vorbis reports ${top.rate} Hz / ${top.channels} ch`)
    check(Number(top.peak) > 0.05, `it decodes to real AUDIO, not silence (peak=${top.peak})`)
    check(top.outOfRange === '0', 'no decoded sample is non-finite or outside [-1, 1]')
    check(full.exact === '1',
      `decoding to the end produces exactly the claimed length (${full.produced} of ${full.claimed})`)

    if (existsSync(REAL.mono)) {
      const mono = await probe([REAL.mono, '--full', '--seek', '2500'])
      const m = fields(mono.lines[0] ?? '')
      const mfull = fields(mono.lines.find((l) => l.includes('full_decode')) ?? '')
      const ms = fields(mono.lines.find((l) => l.includes('seek_ms=')) ?? '')
      check(m.ok === '1' && m.channels === '1', 'MONO Vorbis opens and reports 1 channel')
      check(Number(m.peak) > 0.05, `mono Vorbis decodes to real audio (peak=${m.peak})`)
      check(mfull.exact === '1', 'mono Vorbis length is exact end to end')
      check(ms.matched === '1', 'mono Vorbis seeks bit-exactly as well')
    } else skip('mono .ogg fixture not present')
  }

  // ── ③ formats this build cannot decode are NAMED, not mis-decoded ────────
  console.log('\n③ Opus and damaged Ogg files are refused with a reason')
  {
    const r = await probe([join(DATA, 'correctness_gain_silent_output.opus'), join(DATA, 'segfault.oga')])
    const opus = r.lines.find((l) => l.includes('opus')) ?? ''
    const broken = r.lines.find((l) => l.includes('segfault')) ?? ''
    check(opus.includes('ok=0'), 'Opus in Ogg is refused rather than decoded as noise')
    check(opus.includes('Opus'), 'the refusal NAMES Opus instead of calling the file corrupt')
    check(broken.includes('ok=0'), 'a 120-byte malformed .oga is refused cleanly (no crash, no false accept)')
  }

  // ── ④ the library admits what plays and keeps out what does not ──────────
  console.log('\n④ scan + probe: Ogg files enter the library, Opus does not')
  await request({ cmd: 'hello', protocol: 1 })
  await request({ cmd: 'set_muted', muted: true })
  await request({ cmd: 'set_output', mode: 'shared' })
  const scan = await request({ cmd: 'scan', path: root, replace: true, recursive: true, probe: true })
  const admitted = scan.tracks.map((t) => nameOf(t.path)).sort()
  check(admitted.includes('vorbis.ogg'), 'Ogg Vorbis is ADMITTED to the library (not marked unplayable)')
  check(admitted.includes('lossless.oga'), 'Ogg FLAC with the .oga extension is ADMITTED (extension list updated)')
  check(!admitted.includes('opus.opus'), 'Opus stays OUT of the library')
  check(!admitted.includes('broken.ogg'), 'the malformed .ogg stays OUT of the library')
  check(Array.isArray(scan.unplayablePaths) && scan.unplayablePaths.some((p) => p.endsWith('opus.opus')),
    'the refused Opus file is NAMED in unplayablePaths, so the UI can explain it')

  // ── ⑤ playback reaches the end of an Ogg track ───────────────────────────
  console.log('\n⑤ an Ogg track actually plays through to its end')
  const vorbisTrack = scan.tracks.find((t) => nameOf(t.path) === 'vorbis.ogg')
  if (!vorbisTrack) {
    check(false, 'fixture: an admitted .ogg track to play')
  } else {
    const mark = events.length
    await request({ cmd: 'open', trackId: vorbisTrack.trackId })
    await request({ cmd: 'play' })
    // The taglib fixture is ~3.7 s. Waiting for the END event is the only check
    // that proves end-of-stream is reached: a length that is one block long
    // would leave it playing silence forever, and a short one would cut off.
    const deadline = Date.now() + 30000
    let ended = null
    while (Date.now() < deadline) {
      ended = events.slice(mark).find((e) => e.ev === 'ended')
      if (ended) break
      const state = await request({ cmd: 'get_state' })
      if (state.state === 'stopped' && Date.now() - mark > 1000 && !events.slice(mark).some((e) => e.ev === 'ended')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const st = await request({ cmd: 'get_state' })
    check(ended?.reason === 'eof', `playback reached end-of-stream (reason=${ended?.reason ?? 'none'})`)
    check(!events.slice(mark).some((e) => e.ev === 'ended' && e.reason === 'error'),
      'playback of a valid .ogg raised no decode error')
    check(st.durationMs > 3500 && st.durationMs < 4000,
      `reported duration ${st.durationMs} ms is the real one (~3685 ms for this fixture)`)
  }

  await request({ cmd: 'shutdown' })
} catch (e) {
  failures++
  console.error('ERROR ' + (e?.stack ?? e))
  console.error(stderr.split('\n').slice(-12).join('\n'))
} finally {
  if (child.exitCode === null) child.kill()
}

console.log(`\n${checks - failures}/${checks} checks passed` + (skipped ? `, ${skipped} skipped` : ''))
if (failures > 0) process.exitCode = 1
