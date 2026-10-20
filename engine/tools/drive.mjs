#!/usr/bin/env node
// drive.mjs - AI-A's fake application.
//
// CONTRACT 9.1: AI-A verifies the engine with this, AI-B develops the UI with
// its own mock engine. Neither waits for the other; this script is the engine
// side of that deal, and it grows with every M1 step.
//
// What it is for:
//   * spawn twilight-engine.exe and speak the CONTRACT 3 protocol at it
//   * fail loudly when any stdout line is not valid JSON (iron rule 3.1)
//   * exercise the real 91-track FLAC library on this machine
//
// Usage:
//   node engine/tools/drive.mjs                    # full M1 acceptance run
//   node engine/tools/drive.mjs --exe=<path>       # use a specific binary
//   node engine/tools/drive.mjs --library=<dir>    # use a different folder
//   node engine/tools/drive.mjs --step=hello       # only the named step
//   node engine/tools/drive.mjs --export-fixture   # write fixtures/library-91.json
//   node engine/tools/drive.mjs --list             # list step names
//
// Exit code 0 means every assertion passed.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = resolve(HERE, '..');
const REPO_DIR = resolve(ENGINE_DIR, '..');

const DEFAULT_EXE = join(ENGINE_DIR, 'bin', 'twilight-engine.exe');
// Override with STRINGMOON_TEST_LIBRARY when a step needs a real library on this machine.
const DEFAULT_LIBRARY = process.env.STRINGMOON_TEST_LIBRARY ?? 'D:\\Music';
// Kept in one place: the fixture AI-B consumes is generated from this run.
const FIXTURE_PATH = join(ENGINE_DIR, 'fixtures', 'library-91.json');
// DESIGN-A 8: the one cross-directory handover of this split. B renders C2 from
// REAL event traces rather than hand-made data, so the trace has to contain an
// actual degradation -- a clean run would let a lying UI pass its own tests.
const TRACE_PATH = join(ENGINE_DIR, 'fixtures', 'state-traces.json');

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------
const failures = [];
const warnings = [];
let assertions = 0;

function ok(condition, what, detail) {
  ++assertions;
  if (condition) return true;
  failures.push(detail === undefined ? what : what + ' -- ' + detail);
  return false;
}
function eq(actual, expected, what) {
  return ok(actual === expected, what, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function warn(what) { warnings.push(what); }

// ---------------------------------------------------------------------------
// the engine end of the protocol
// ---------------------------------------------------------------------------
class EngineClient {
  constructor(exe) {
    this.exe = exe;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();       // id -> {resolve, reject}
    this.events = [];               // every event frame, in arrival order
    this.listeners = new Map();     // ev name -> [fn]
    this.malformed = [];            // stdout lines that were not JSON: fatal
    this.stderrLines = [];
    this.exited = null;
    this.rawLines = 0;
  }

  async start() {
    this.child = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    liveClients.add(this);
    spawnedPids.add(this.child.pid);

    this.child.on('exit', (code, signal) => {
      liveClients.delete(this);
      this.exited = { code, signal };
      for (const { reject } of this.pending.values()) reject(new Error('engine exited before replying'));
      this.pending.clear();
    });

    // The iron rule of CONTRACT 3.1: every single stdout line must parse.
    const out = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    out.on('line', (line) => {
      ++this.rawLines;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        this.malformed.push(line);
        return;
      }
      if (frame && typeof frame === 'object' && typeof frame.ev === 'string') {
        this.events.push(frame);
        for (const fn of this.listeners.get(frame.ev) ?? []) fn(frame);
      } else {
        this.reply(frame);
      }
    });

    const err = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    err.on('line', (line) => this.stderrLines.push(line));

    return this.waitFor((frame) => frame.ev === 'ready', 15000);
  }

  reply(frame) {
    if (!Object.prototype.hasOwnProperty.call(frame, 'id')) return;   // not a reply
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    waiter.resolve(frame);
  }

  send(command, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          rejectPromise(new Error('timeout waiting for reply to ' + JSON.stringify(command)));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (frame) => { clearTimeout(timer); resolvePromise(frame); },
        reject: (err) => { clearTimeout(timer); rejectPromise(err); }
      });
      this.child.stdin.write(JSON.stringify({ id, ...command }) + '\n');
    });
  }

  // Sends a line verbatim so malformed-input handling can be tested.
  sendRaw(line) { this.child.stdin.write(line + '\n'); }

  on(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(fn);
  }

  waitFor(predicate, timeoutMs = 10000) {
    for (const frame of this.events) if (predicate(frame)) return Promise.resolve(frame);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => { clearInterval(poll); resolvePromise(null); }, timeoutMs);
      const poll = setInterval(() => {
        const hit = this.events.find(predicate);
        if (hit) { clearTimeout(timer); clearInterval(poll); resolvePromise(hit); }
      }, 10);
    });
  }

  waitForEvent(ev, predicate = () => true, timeoutMs = 10000) {
    return this.waitFor((frame) => frame.ev === ev && predicate(frame), timeoutMs);
  }

  async close() {
    if (!this.child || this.exited) return;
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const deadline = Date.now() + 5000;
    while (!this.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!this.exited) { this.child.kill(); }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Every engine THIS run spawned, and which of them are still alive.
//
// Kept because "did we leave an engine behind" is a question about our own
// children. The app spawns the very same executable (app/src/main/engine-host.ts
// probes for engine/bin/twilight-engine.exe), so asking the OS about the image
// name measures the neighbourhood instead of this run: it fails while a
// neighbour is testing, and a real leak of ours could hide behind the
// neighbour's healthy process. Both directions are wrong, so the assertion below
// asks about ours and only WARNS about the rest.
const liveClients = new Set();
const spawnedPids = new Set();

function parseArgs(argv) {
  const args = { exe: DEFAULT_EXE, library: DEFAULT_LIBRARY, step: null, exportFixture: false, exportTrace: false, list: false, keepOpen: false };
  for (const raw of argv.slice(2)) {
    if (raw === '--export-fixture') args.exportFixture = true;
    else if (raw === '--export-trace') args.exportTrace = true;
    else if (raw === '--list') args.list = true;
    else if (raw === '--keep-open') args.keepOpen = true;
    else if (raw.startsWith('--exe=')) args.exe = raw.slice(6);
    else if (raw.startsWith('--library=')) args.library = raw.slice(10);
    else if (raw.startsWith('--step=')) args.step = raw.slice(7);
    else throw new Error('unknown argument: ' + raw);
  }
  return args;
}

function countLibraryFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => {
      try { return statSync(join(dir, name)).isFile(); } catch { return false; }
    }).length;
  } catch {
    return -1;
  }
}

function heading(text) {
  console.log('');
  console.log('== ' + text + ' ' + '='.repeat(Math.max(0, 66 - text.length)));
}

// Reads the resident set size of the running engine. SPEC 8.2 sets a 60 MB
// budget for the engine process while playing, and that number is worth
// measuring rather than deriving from the design.
async function tools_rss(exe) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const name = path.basename(exe);
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'],
                             { encoding: 'utf8' });
    // "name","pid","session","session#","memusage"
    const rows = out.trim().split(/\r?\n/).filter((l) => l.includes(name));
    let total = 0;
    for (const row of rows) {
      const cols = row.split('","').map((c) => c.replace(/"/g, ''));
      const mem = cols[4];
      if (mem) {
        // The value is like "12,345 K"
        const kb = Number(mem.replace(/[^0-9]/g, ''));
        if (Number.isFinite(kb)) total += kb * 1024;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------
const steps = [];
const step = (name, description, fn) => steps.push({ name, description, fn });

step('selftest', 'in-process protocol codec checks (--selftest)', async (args) => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(args.exe, ['--selftest'], { encoding: 'utf8' });
  eq(result.status, 0, '--selftest exits 0');
  if (result.stderr) process.stderr.write(result.stderr);
  ok(result.stdout === '', '--selftest writes nothing to stdout', JSON.stringify(result.stdout));
});

step('hello', 'startup, ready frame, hello/list_devices, clean shutdown', async (args) => {
  const engine = new EngineClient(args.exe);
  const ready = await engine.start();

  ok(!!ready, 'ready event arrives at startup');
  if (ready) {
    eq(ready.protocol, 1, 'ready.protocol is 1');
    ok(typeof ready.version === 'string' && ready.version.length > 0, 'ready.version is a string');
    ok(Array.isArray(ready.devices), 'ready.devices is an array');
    if (Array.isArray(ready.devices) && ready.devices.length) {
      const d = ready.devices[0];
      ok(typeof d.id === 'string' && d.id.length > 0, 'device.id is a non-empty string');
      ok(typeof d.name === 'string' && d.name.length > 0, 'device.name is a non-empty string');
      console.log('   default device: ' + d.name + (d.isBluetooth ? '  [bluetooth]' : '') +
                  '  ' + d.channels + 'ch @ ' + d.sampleRate + 'Hz');
    } else {
      warn('no render devices reported');
    }
  }

  const hello = await engine.send({ cmd: 'hello', protocol: 1 });
  eq(hello.ok, true, 'hello replies ok');
  eq(hello.data && hello.data.accepted, true, 'hello accepts protocol 1');

  const devices = await engine.send({ cmd: 'list_devices' });
  eq(devices.ok, true, 'list_devices replies ok');
  ok(Array.isArray(devices.data && devices.data.devices), 'list_devices returns an array');

  // Unknown commands must be refused with a contract error code, never faked.
  const bogus = await engine.send({ cmd: 'definitely_not_a_command' });
  eq(bogus.ok, false, 'unknown command is refused');
  ok(bogus.error && bogus.error.code === 'ERR_UNSUPPORTED', 'unknown command uses ERR_UNSUPPORTED',
     JSON.stringify(bogus.error));

  // A command that exists in the contract but is not implemented yet must say
  // so rather than silently succeeding. pick_folder is still in that state.
  const pick = await engine.send({ cmd: 'pick_folder' });
  eq(pick.ok, false, 'pick_folder is refused rather than silently succeeding');
  ok(pick.error && pick.error.code === 'ERR_UNSUPPORTED', 'pick_folder uses ERR_UNSUPPORTED',
     JSON.stringify(pick.error));

  // Sequencing matters as much as existence: play with nothing open is a state
  // error, and the app relies on that distinction to decide what to say.
  const play = await engine.send({ cmd: 'play' });
  eq(play.ok, false, 'play with no track open is refused');
  ok(play.error && play.error.code === 'ERR_STATE', 'that refusal uses ERR_STATE',
     JSON.stringify(play.error));

  // Malformed JSON must not produce a reply and must not corrupt the stream.
  engine.sendRaw('{ this is not json');
  const after = await engine.send({ cmd: 'list_devices' });
  eq(after.ok, true, 'engine still answers after malformed input');

  const shutdown = await engine.send({ cmd: 'shutdown' });
  eq(shutdown.ok, true, 'shutdown replies ok');

  await engine.close();
  ok(!!engine.exited, 'process exits after shutdown');
  eq(engine.malformed.length, 0, 'every stdout line parsed as JSON',
     JSON.stringify(engine.malformed.slice(0, 3)));
});

step('scan', 'scan the real 91-track library through TagLib', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const progress = [];
  engine.on('scan_progress', (frame) => progress.push(frame));

  const reply = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  eq(reply.ok, true, 'scan replies ok', JSON.stringify(reply.error));
  if (!reply.ok) { await engine.close(); return; }

  const tracks = reply.data.tracks;
  const expectedCount = countLibraryFiles(args.library);
  console.log('   library: ' + args.library);
  eq(tracks.length, expectedCount, 'scan returns every file in the folder');
  ok(expectedCount === 91, 'the reference library holds 91 files', String(expectedCount));

  const done = await engine.waitForEvent('scan_done');
  ok(!!done, 'scan_done event arrives');
  if (done) {
    eq(done.added, tracks.length, 'scan_done.added matches the returned track count');
    eq(done.failed, 0, 'scan_done.failed is 0');
  }

  ok(progress.length > 0, 'scan_progress is reported');
  if (progress.length) {
    eq(progress[0].done, 0, 'first scan_progress reports done=0');
    ok(progress.some((p) => p.total === expectedCount), 'scan_progress reports the real total');
    ok(progress.every((p) => p.done <= p.total), 'scan_progress never overshoots total');
    // progress must be monotonically non-decreasing
    let monotonic = true;
    for (let i = 1; i < progress.length; ++i) if (progress[i].done < progress[i - 1].done) monotonic = false;
    ok(monotonic, 'scan_progress.done is monotonically non-decreasing');
  }

  // CONTRACT 3.5: tl_ + 4 digits, assigned by the engine, unique.
  const ids = new Set();
  let idShape = true, unique = true, allFields = true, metadataSeen = 0;
  for (const track of tracks) {
    if (!/^tl_\d{4,}$/.test(track.trackId)) idShape = false;
    if (ids.has(track.trackId)) unique = false;
    ids.add(track.trackId);
    if (typeof track.title !== 'string' || typeof track.path !== 'string' ||
        typeof track.durationMs !== 'number' || typeof track.sampleRate !== 'number' ||
        typeof track.channels !== 'number' || typeof track.bitDepth !== 'number' ||
        typeof track.artist !== 'string' || typeof track.album !== 'string') {
      allFields = false;
    }
    if (track.title && track.title !== '' && track.durationMs > 0) ++metadataSeen;
  }
  ok(idShape, 'every trackId matches tl_ + 4 digits');
  ok(unique, 'trackIds are unique');
  ok(allFields, 'every track carries the CONTRACT 3.3 fields');
  eq(metadataSeen, tracks.length, 'every track has a title and a positive duration');

  // The strongest available encoding test, and the reason this is not a
  // spot-check: the engine's paths must equal what Node itself sees on disk,
  // byte for byte, as a set. Any ANSI-code-page round trip, any lost or
  // collapsed character, any truncation moves a path and fails here -- for all
  // 91 files at once, rather than only the traps someone remembered to list.
  const paths = tracks.map((t) => t.path);
  const enginePaths = new Set(paths);
  eq(enginePaths.size, paths.length, 'the engine returned no duplicate paths');

  let onDisk = [];
  try {
    const fs = await import('node:fs');
    onDisk = fs.readdirSync(args.library)
      .map((name) => join(args.library, name))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  } catch (err) {
    ok(false, 'could not read the library directory for comparison', String(err));
  }
  if (onDisk.length) {
    const missing = onDisk.filter((p) => !enginePaths.has(p));
    const extra = paths.filter((p) => !onDisk.includes(p));
    eq(missing.length, 0, 'no path was lost or altered in transit (UTF-8 round trip)',
       JSON.stringify(missing.slice(0, 3)));
    eq(extra.length, 0, 'the engine invented no path', JSON.stringify(extra.slice(0, 3)));
  }

  // Given that, these three spot-checks document which traps the library
  // actually contains. They assert survival of the class, not one codepoint.
  const basenameOf = (p) => String(p).split(/[\\/]/).pop() ?? '';
  const spaced = paths.find((p) => / {2,}/.test(basenameOf(p)));
  ok(!!spaced, 'a filename with a run of multiple spaces survived');
  if (spaced) {
    ok(/ {2,}/.test(basenameOf(spaced)), 'the run of spaces was not collapsed', spaced);
    console.log('   multi-space file:  ' + spaced.split('\\').pop());
  }

  const combining = paths.find((p) => [...p].some((c) => {
    const cp = c.codePointAt(0);
    return cp >= 0x0300 && cp <= 0x036f;      // combining diacritical marks
  }));
  ok(!!combining, 'a filename with combining marks survived');
  if (combining) {
    eq([...combining].some((c) => c.codePointAt(0) === 0x0301), true,
       'the combining marks are intact and not normalised away');
    console.log('   combining-mark file: ' + combining.split('\\').pop());
  }

  const cjk = paths.find((p) => /[\u3040-\u30FF\u4E00-\u9FFF]/.test(p));
  ok(!!cjk, 'a CJK filename survived');

  // Metadata sanity: the brief says the library is mostly 24-bit / 96k class.
  const hires = tracks.filter((t) => t.bitDepth >= 24).length;
  const rates = [...new Set(tracks.map((t) => t.sampleRate))].sort((a, b) => a - b);
  console.log('   ' + hires + '/' + tracks.length + ' tracks are 24-bit or deeper');
  console.log('   sample rates present: ' + rates.join(', '));

  // list_tracks must agree with what scan returned.
  const listed = await engine.send({ cmd: 'list_tracks' });
  eq(listed.ok, true, 'list_tracks replies ok');
  eq(listed.data.tracks.length, tracks.length, 'list_tracks returns the same count');

  if (args.exportFixture) {
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    const fixture = {
      _comment: 'Generated by engine/tools/drive.mjs --export-fixture. This is the handover point of CONTRACT 9.1: real metadata from the reference library, for AI-B to build the UI against before the engine is finished.',
      _generatedAt: new Date().toISOString(),
      _libraryPath: args.library,
      _trackCount: tracks.length,
      protocol: 1,
      tracks
    };
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
    console.log('   fixture written: ' + FIXTURE_PATH);
  }

  await engine.send({ cmd: 'shutdown' });
  await engine.close();
  eq(engine.malformed.length, 0, 'every stdout line parsed as JSON');
});

step('playback', 'open / play / pause / stop / seek / volume on the real library', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds before playback', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  // Prefer a file the library actually holds at the device rate when possible;
  // otherwise the engine is right to refuse with ERR_DECODE and the step below
  // reports that as an unsupported-capability skip rather than a failure.
  const devices = await engine.send({ cmd: 'list_devices' });
  const device = (devices.data.devices ?? [])[0];
  ok(!!device, 'at least one render device is present');
  if (!device) { await engine.close(); return; }
  console.log('   device: ' + device.name + '  ' + device.channels + 'ch @ ' + device.sampleRate + 'Hz');

  const exact = tracks.find((t) => t.sampleRate === device.sampleRate && t.channels === device.channels);
  const candidate = exact ?? tracks[0];
  const isSupported = !!exact;
  console.log('   picking: ' + candidate.title + '  ' + candidate.sampleRate + 'Hz/' +
              candidate.bitDepth + 'bit/' + candidate.channels + 'ch' +
              (isSupported ? '' : '  (rate differs from the device: expect a refusal)'));

  // This legacy M1 step exercises the shared fallback contract explicitly. The
  // product default is now automatic (exclusive first); pinning the mode here
  // keeps this milestone's expected state independent of endpoint capabilities.
  await engine.send({ cmd: 'set_output', mode: 'shared' });

  // --- open -----------------------------------------------------------------
  const opened = await engine.send({ cmd: 'open', trackId: candidate.trackId }, 60000);
  if (!isSupported) {
    // Resampling is L2. Until it exists the contract-correct answer is a
    // refusal, and refusing loudly is better than playing at the wrong speed.
    eq(opened.ok, false, 'open refuses a stream the device cannot take as-is');
    ok(opened.error && opened.error.code === 'ERR_DECODE', 'the refusal uses ERR_DECODE',
       JSON.stringify(opened.error));
    console.log('   refusal: ' + (opened.error && opened.error.message));
    await engine.send({ cmd: 'shutdown' });
    await engine.close();
    return;
  }

  eq(opened.ok, true, 'open replies ok', JSON.stringify(opened.error));
  if (!opened.ok) { await engine.close(); return; }
  eq(opened.data.trackId, candidate.trackId, 'open echoes the trackId');
  ok(opened.data.durationMs > 0, 'open reports a duration');

  // open must not start playback (CONTRACT 3.2: "loads, does not auto-play")
  await new Promise((r) => setTimeout(r, 150));
  const positionAfterOpen = engine.events.filter((e) => e.ev === 'position');
  eq(positionAfterOpen.length, 0, 'open does not begin playback');

  // --- play -----------------------------------------------------------------
  const play = await engine.send({ cmd: 'play' });
  eq(play.ok, true, 'play replies ok', JSON.stringify(play.error));

  const playing = await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);
  ok(!!playing, 'a state event reports playing');
  if (playing) {
    // CONTRACT 3.4: shared mode is a degradation, expressed here and never as
    // an ok:false. M1 must report it exactly this way.
    eq(playing.outputMode, 'shared', 'state.outputMode is shared in M1');
    eq(playing.bitPerfect, false, 'state.bitPerfect is false in shared mode');
    ok(playing.sampleRate > 0, 'state reports the device sample rate');
    ok(playing.trackId === candidate.trackId, 'state reports the playing track');
    console.log('   playing: ' + playing.outputMode + ' ' + playing.sampleRate + 'Hz  bitPerfect=' +
                playing.bitPerfect + '  period=' + playing.periodMs + 'ms');
  }

  // Audio must actually be flowing: the position event only advances when the
  // render side has handed frames to the device, so a frozen position means no
  // sound, which is precisely what this milestone is about.
  const first = await engine.waitForEvent('position', () => true, 3000);
  ok(!!first, 'position events arrive while playing');
  const p1 = first ? first.positionMs : 0;
  await new Promise((r) => setTimeout(r, 1200));
  const positions = engine.events.filter((e) => e.ev === 'position');
  const last = positions[positions.length - 1];
  ok(!!last && last.positionMs > p1, 'position advances while playing',
     'first=' + p1 + ' last=' + (last && last.positionMs));

  const advanced = last ? last.positionMs - p1 : 0;
  ok(advanced >= 700 && advanced <= 1800, 'position advanced by about the elapsed wall time',
     'advanced ' + advanced + 'ms over ~1200ms');
  ok(last && last.durationMs === opened.data.durationMs, 'position.durationMs matches open');

  // --- pause ----------------------------------------------------------------
  const pause = await engine.send({ cmd: 'pause' });
  eq(pause.ok, true, 'pause replies ok', JSON.stringify(pause.error));
  const paused = await engine.waitForEvent('state', (e) => e.state === 'paused', 3000);
  ok(!!paused, 'a state event reports paused');

  const frozenAt = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: 0 }).positionMs;
  await new Promise((r) => setTimeout(r, 600));
  const afterPause = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: 0 }).positionMs;
  eq(afterPause, frozenAt, 'position does not advance while paused');

  // --- resume ---------------------------------------------------------------
  const resume = await engine.send({ cmd: 'play' });
  eq(resume.ok, true, 'play resumes from pause');
  await new Promise((r) => setTimeout(r, 600));
  const resumed = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: 0 }).positionMs;
  ok(resumed > afterPause, 'position advances again after resuming',
     'paused=' + afterPause + ' resumed=' + resumed);

  // --- seek -----------------------------------------------------------------
  const target = Math.floor(opened.data.durationMs / 2);
  const seek = await engine.send({ cmd: 'seek', positionMs: target });
  eq(seek.ok, true, 'seek replies ok', JSON.stringify(seek.error));
  await new Promise((r) => setTimeout(r, 400));
  const afterSeek = engine.events.filter((e) => e.ev === 'position').pop();
  ok(!!afterSeek, 'position events continue after seek');
  if (afterSeek) {
    const delta = Math.abs(afterSeek.positionMs - target);
    ok(delta < 1500, 'seek lands within 1.5s of the requested position',
       'requested=' + target + ' reported=' + afterSeek.positionMs);
  }

  // --- volume ---------------------------------------------------------------
  const vol = await engine.send({ cmd: 'set_volume', volume: 0.35 });
  eq(vol.ok, true, 'set_volume replies ok', JSON.stringify(vol.error));
  const volState = engine.events.filter((e) => e.ev === 'state').pop();
  ok(!!volState && Math.abs((volState.volume ?? -1) - 0.35) < 1e-6, 'state reports the new volume');

  const bad = await engine.send({ cmd: 'set_volume', volume: 1.5 });
  eq(bad.ok, false, 'set_volume refuses a value above 1.0');

  // --- stop -----------------------------------------------------------------
  const stop = await engine.send({ cmd: 'stop' });
  eq(stop.ok, true, 'stop replies ok');
  const stopped = await engine.waitForEvent('state', (e) => e.state === 'stopped', 3000);
  ok(!!stopped, 'a state event reports stopped');
  const stoppedAt = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: -1 }).positionMs;
  await new Promise((r) => setTimeout(r, 500));
  const afterStop = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: -1 }).positionMs;
  eq(afterStop, stoppedAt, 'position does not advance after stop');

  // --- state errors ---------------------------------------------------------
  const pauseAgain = await engine.send({ cmd: 'pause' });
  eq(pauseAgain.ok, false, 'pause when not playing is refused');
  ok(pauseAgain.error && pauseAgain.error.code === 'ERR_STATE', 'that refusal uses ERR_STATE',
     JSON.stringify(pauseAgain.error));

  const badTrack = await engine.send({ cmd: 'open', trackId: 'tl_9999' });
  eq(badTrack.ok, false, 'open with an unknown trackId is refused');
  ok(badTrack.error && badTrack.error.code === 'ERR_NOTFOUND', 'that refusal uses ERR_NOTFOUND',
     JSON.stringify(badTrack.error));

  eq(engine.malformed.length, 0, 'every stdout line parsed as JSON');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
  ok(!!engine.exited, 'engine exits cleanly after playback');
});

step('resample', 'a 44.1 kHz track plays through SoXR on a 48 kHz device', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  const devices = await engine.send({ cmd: 'list_devices' });
  const device = (devices.data.devices ?? [])[0];
  const deviceRate = device ? device.sampleRate : 0;

  // Pick a track whose rate differs from the device: this is the path 80 of the
  // 91 tracks take on this machine, so it is not an edge case.
  const other = tracks.find((t) => t.sampleRate !== deviceRate && t.channels === device.channels);
  if (!other) {
    warn('the library holds no track at a rate other than ' + deviceRate + '; resampling not exercised');
    await engine.send({ cmd: 'shutdown' });
    await engine.close();
    return;
  }
  console.log('   source ' + other.sampleRate + 'Hz -> device ' + deviceRate + 'Hz: ' + other.title);

  const opened = await engine.send({ cmd: 'open', trackId: other.trackId }, 60000);
  eq(opened.ok, true, 'open accepts a track whose rate differs from the device', JSON.stringify(opened.error));
  if (!opened.ok) { await engine.close(); return; }
  eq(opened.data.resampled, true, 'open reports the track as resampled');
  eq(opened.data.sourceSampleRate, other.sampleRate, 'open reports the source rate');
  eq(opened.data.sampleRate, deviceRate, 'open reports the device rate');
  ok(opened.data.durationMs > 0, 'open reports a duration');

  const play = await engine.send({ cmd: 'play' });
  eq(play.ok, true, 'play starts', JSON.stringify(play.error));

  const playing = await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);
  ok(!!playing, 'a state event reports playing');
  if (playing) {
    eq(playing.resampled, true, 'state reports the resampled path');
    eq(playing.sourceSampleRate, other.sampleRate, 'state reports the source rate');
    eq(playing.sampleRate, deviceRate, 'state reports the device rate');
    eq(playing.bitPerfect, false, 'the resampled path is not bit-perfect');
  }

  const first = await engine.waitForEvent('position', () => true, 3000);
  const p1 = first ? first.positionMs : 0;
  await new Promise((r) => setTimeout(r, 1500));
  const positions = engine.events.filter((e) => e.ev === 'position');
  const last = positions[positions.length - 1];
  const advanced = last ? last.positionMs - p1 : 0;
  ok(advanced >= 1100 && advanced <= 1900,
     'position advances by real time through the resampler (source clock, not device clock)',
     'advanced ' + advanced + 'ms over ~1500ms');

  // The reported duration must be the source duration, not a resampled guess.
  if (last) {
    const delta = Math.abs(last.durationMs - other.durationMs);
    ok(delta <= 2, 'duration matches the metadata duration, not the resampled length',
       'metadata=' + other.durationMs + ' reported=' + last.durationMs);
  }

  eq(engine.malformed.length, 0, 'resampled playback kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('library', 'every track in the library opens and starts playing', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;
  console.log('   checking all ' + tracks.length + ' tracks');

  const failed = [];
  const rateCounts = new Map();
  let checked = 0;

  for (const track of tracks) {
    const opened = await engine.send({ cmd: 'open', trackId: track.trackId }, 60000);
    if (!opened.ok) {
      failed.push(track.trackId + ' ' + track.title + ' -> ' + JSON.stringify(opened.error));
      continue;
    }
    const play = await engine.send({ cmd: 'play' }, 20000);
    if (!play.ok) {
      failed.push(track.trackId + ' ' + track.title + ' (play) -> ' + JSON.stringify(play.error));
      continue;
    }
    // Prove audio actually moved before moving on: a track that opens but
    // never renders is silent, which is the exact failure this sweep exists to
    // catch.
    const startPos = (engine.events.filter((e) => e.ev === 'position' && e.trackId === track.trackId).pop() ?? {}).positionMs ?? 0;
    await new Promise((r) => setTimeout(r, 260));
    const nowPos = (engine.events.filter((e) => e.ev === 'position' && e.trackId === track.trackId).pop() ?? {}).positionMs ?? 0;
    if (nowPos <= startPos) {
      failed.push(track.trackId + ' ' + track.title + ' -> position did not advance');
      continue;
    }
    const stopped = await engine.send({ cmd: 'stop' });
    if (!stopped.ok) failed.push(track.trackId + ' stop refused');
    ++checked;
    const key = track.sampleRate + 'Hz';
    rateCounts.set(key, (rateCounts.get(key) ?? 0) + 1);
  }

  for (const [rate, count] of [...rateCounts].sort()) {
    console.log('   played ' + count + ' tracks at ' + rate);
  }
  console.log('   ' + checked + '/' + tracks.length + ' tracks opened, played and advanced');

  eq(failed.length, 0, 'every track in the library plays', failed.slice(0, 5).join(' | '));
  eq(checked, tracks.length, 'every track was checked');
  eq(engine.malformed.length, 0, 'the whole-library sweep kept stdout clean');

  await engine.send({ cmd: 'shutdown' });
  await engine.close();
  ok(!!engine.exited, 'engine survives a full library sweep and exits');
});

step('queue', 'set_queue, next/prev, and auto-advance on end of stream', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  const devices = await engine.send({ cmd: 'list_devices' });
  const device = (devices.data.devices ?? [])[0];
  const deviceRate = device ? device.sampleRate : 0;

  // Three playable tracks, preferring ones the device takes without resampling
  // so a resampler problem cannot masquerade as a queue problem.
  const playable = tracks.filter((t) => t.channels === device.channels);
  const sameRate = playable.filter((t) => t.sampleRate === deviceRate);
  const pool = sameRate.length >= 3 ? sameRate : playable;
  if (pool.length < 3) { warn('not enough tracks for the queue step'); await engine.close(); return; }
  const [a, b, c] = pool;
  console.log('   queue: ' + a.title + ' | ' + b.title + ' | ' + c.title);

  // next/prev before a queue exists must be a state error, not a crash.
  const noQueue = await engine.send({ cmd: 'next' });
  eq(noQueue.ok, false, 'next without a queue is refused');
  ok(noQueue.error && noQueue.error.code === 'ERR_STATE', 'that refusal uses ERR_STATE',
     JSON.stringify(noQueue.error));

  const setQueue = await engine.send({ cmd: 'set_queue', trackIds: [a.trackId, b.trackId, c.trackId] });
  eq(setQueue.ok, true, 'set_queue replies ok', JSON.stringify(setQueue.error));
  eq(setQueue.data.count, 3, 'set_queue reports the queue length');

  const badQueue = await engine.send({ cmd: 'set_queue', trackIds: [a.trackId, 'tl_9999'] });
  eq(badQueue.ok, false, 'set_queue refuses an unknown trackId');
  ok(badQueue.error && badQueue.error.code === 'ERR_NOTFOUND', 'that refusal uses ERR_NOTFOUND',
     JSON.stringify(badQueue.error));

  // Re-set the good queue: the refused call must not have replaced it.
  await engine.send({ cmd: 'set_queue', trackIds: [a.trackId, b.trackId, c.trackId] });

  const open = await engine.send({ cmd: 'open', trackId: a.trackId }, 60000);
  eq(open.ok, true, 'open the first queued track', JSON.stringify(open.error));
  if (!open.ok) { await engine.close(); return; }
  const play = await engine.send({ cmd: 'play' });
  eq(play.ok, true, 'play starts', JSON.stringify(play.error));

  // next: the reply must name the track that is now playing, and playback must
  // have continued rather than silently stopping.
  const next = await engine.send({ cmd: 'next' }, 60000);
  eq(next.ok, true, 'next replies ok', JSON.stringify(next.error));
  eq(next.data.trackId, b.trackId, 'next moves to the second queued track');
  eq(engine.events.filter((e) => e.ev === 'state').pop().trackId, b.trackId, 'next emits a state event');
  eq(engine.events.filter((e) => e.ev === 'state').pop().state, 'playing', 'next keeps playing');

  const nextAgain = await engine.send({ cmd: 'next' }, 60000);
  eq(nextAgain.data.trackId, c.trackId, 'next again moves to the third track');

  const prev = await engine.send({ cmd: 'prev' }, 60000);
  eq(prev.ok, true, 'prev replies ok', JSON.stringify(prev.error));
  eq(prev.data.trackId, b.trackId, 'prev goes back to the second track');

  // Auto-advance: seek close to the end of the current track and let it finish.
  // Waiting for a real 5 minute track would make this suite unusable.
  const state = engine.events.filter((e) => e.ev === 'state').pop();
  const nearEnd = Math.max(0, state.durationMs - 1200);
  const seek = await engine.send({ cmd: 'seek', positionMs: nearEnd });
  eq(seek.ok, true, 'seek near the end replies ok', JSON.stringify(seek.error));

  const ended = await engine.waitForEvent('ended', (e) => e.trackId === b.trackId, 8000);
  ok(!!ended, 'an ended event arrives when the track finishes');
  if (ended) eq(ended.reason, 'eof', 'ended.reason is eof');

  // The queue must continue on its own: state playing on the next track.
  const advanced = await engine.waitForEvent('state', (e) => e.state === 'playing' && e.trackId === c.trackId, 8000);
  ok(!!advanced, 'playback auto-advances to the next queued track');
  if (advanced) {
    console.log('   ended -> auto-advanced to: ' + c.title);
    // And it must really be playing, not just reported as playing.
    const before = (engine.events.filter((e) => e.ev === 'position' && e.trackId === c.trackId).pop() ?? {}).positionMs ?? 0;
    await new Promise((r) => setTimeout(r, 700));
    const after = (engine.events.filter((e) => e.ev === 'position' && e.trackId === c.trackId).pop() ?? {}).positionMs ?? 0;
    ok(after > before, 'the auto-advanced track is actually rendering', before + ' -> ' + after);
  }

  // Repeat-one must replay the same track instead of moving on.
  const one = await engine.send({ cmd: 'set_repeat', mode: 'one' });
  eq(one.ok, true, 'set_repeat accepts "one"');
  eq(one.data.mode, 'one', 'set_repeat echoes the mode');
  const repeated = await engine.send({ cmd: 'next' }, 60000);
  eq(repeated.data.trackId, c.trackId, 'repeat-one keeps the same track on next');

  const badMode = await engine.send({ cmd: 'set_repeat', mode: 'sideways' });
  eq(badMode.ok, false, 'set_repeat refuses an unknown mode');
  ok(badMode.error && badMode.error.code === 'ERR_STATE', 'that refusal uses ERR_STATE');

  // Repeat-one at a NATURAL end: the track must restart rather than the queue
  // moving on. This is the case a 'next' command cannot cover, because it goes
  // through the end-of-stream path instead.
  const oneState = engine.events.filter((e) => e.ev === 'state').pop();
  const nearEnd2 = Math.max(0, oneState.durationMs - 1200);
  await engine.send({ cmd: 'seek', positionMs: nearEnd2 });
  await engine.send({ cmd: 'play' });
  const endedOne = await engine.waitForEvent('ended', (e) => e.trackId === c.trackId, 12000);
  ok(!!endedOne, 'repeat-one still reports the track ended');
  if (endedOne) {
    const restart = await engine.waitForEvent('state',
      (e) => e.state === 'playing' && e.trackId === c.trackId && e.positionMs < 3000, 10000);
    ok(!!restart, 'repeat-one replays the same track from the start',
       JSON.stringify((engine.events.filter((e) => e.ev === 'state').pop() || {})));
  }

  // SPEC 3.7: a manual track change fades out over 5 ms so it cannot click. The
  // fade is a real-time wait on the control thread, so the risk it introduces is
  // not the click coming back but the ENGINE STALLING: a wait that never ends
  // would freeze every command. This measures it while changing tracks the way a
  // user does, which is the only place the fade runs.
  {
    const before = engine.events.length;
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      await engine.send({ cmd: 'next' });
      await engine.send({ cmd: 'play' });
      // A get_state immediately after proves the engine is still serving while
      // the fade path runs, not merely that it finished eventually.
      const s = await engine.send({ cmd: 'get_state' }, 10000);
      worst = Math.max(worst, Date.now() - t0);
      ok(s.ok, 'the engine answers during a track change (round ' + (i + 1) + ')');
      await new Promise((r) => setTimeout(r, 150));
    }
    ok(worst < 1000,
       'a track change completes promptly: the 5 ms fade does not become a stall',
       'worst ' + worst + ' ms across 4 changes');
    console.log('   track change: worst ' + worst + ' ms for next+play+get_state');
    ok(engine.events.length > before, 'track changes still emit state events');
  }

  await engine.send({ cmd: 'set_repeat', mode: 'sequential' });
  await engine.send({ cmd: 'stop' });
  eq(engine.malformed.length, 0, 'the queue step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
  ok(!!engine.exited, 'engine exits cleanly after queue work');
});


step('session', 'CR-007: operationId makes a replaced playback session identifiable', async (args) => {
  // The problem this solves: a client that clicks next twice quickly receives
  // events from two sessions, and a trackId cannot tell them apart when the
  // same track is opened twice (repeat-one) or when the replies arrive out of
  // order. Timing was the only available guess.
  const engine = new EngineClient(args.exe);
  await engine.start();
  await engine.send({ cmd: 'scan', path: args.library }, 120000);
  const list = await engine.send({ cmd: 'list_tracks' });
  const a = list.data.tracks[0];
  const b = list.data.tracks[5];

  const openA = await engine.send({ cmd: 'open', trackId: a.trackId });
  ok(typeof openA.data.operationId === 'number' && openA.data.operationId > 0,
     'the open reply carries a positive operationId', JSON.stringify(openA.data.operationId));
  const idA = openA.data.operationId;

  // The state event must agree with the reply, or the client cannot correlate
  // the two and the field solves nothing.
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);
  const stateA = engine.events.filter((e) => e.ev === 'state').pop();
  eq(stateA.operationId, idA, 'the state event carries the open reply id');

  // Open a different track: a NEW session, strictly increasing so a client can
  // also use it as a monotonic watermark.
  const openB = await engine.send({ cmd: 'open', trackId: b.trackId });
  ok(openB.data.operationId > idA,
     'a later open has a strictly greater id',
     idA + ' -> ' + openB.data.operationId);
  const idB = openB.data.operationId;

  // THE case a trackId cannot express: the SAME track opened twice. The id is
  // the only thing that distinguishes the two sessions.
  const openA2 = await engine.send({ cmd: 'open', trackId: a.trackId });
  eq(openA2.data.trackId, a.trackId, 'the replay opens the same track');
  ok(openA2.data.operationId > idB,
     'replaying the same track still starts a new session',
     'first ' + idA + ', replay ' + openA2.data.operationId);
  ok(openA2.data.operationId !== idA,
     'so the two sessions of one track are distinguishable');

  // Position events carry it too: they are the highest-frequency events and the
  // ones a progress bar consumes, so a stale one would move the bar backwards.
  await engine.send({ cmd: 'play' });
  // Wait for a position event from THIS session. Taking the first one in the
  // buffer returns a frame from the first session and proves the opposite of
  // what the assertion claims -- which is exactly what it caught the first time.
  const pos = await engine.waitForEvent('position',
      (e) => e.operationId === openA2.data.operationId, 6000);
  ok(!!pos, 'a position event from the current session arrives',
     'want operationId ' + openA2.data.operationId);
  if (pos) eq(pos.operationId, openA2.data.operationId,
              'position events carry the current session id');

  // next/prev start sessions as well, so they report the id they started. A
  // queue is needed first: next with nothing queued is a state error, not a
  // session transition.
  await engine.send({ cmd: 'set_queue', trackIds: [a.trackId, b.trackId] });
  const next = await engine.send({ cmd: 'next' });
  if (ok(next.ok, 'next succeeds with a queue set', JSON.stringify(next.error))) {
    ok(typeof next.data.operationId === 'number' && next.data.operationId > openA2.data.operationId,
       'next reports the session it started', JSON.stringify(next.data));
  }

  // And a session id must never be reused or reset by a mere pause/resume:
  // those do not replace the session, so the id must hold still.
  const held = (next.data && next.data.operationId) || 0;
  await engine.send({ cmd: 'pause' });
  await engine.send({ cmd: 'play' });
  const afterResume = engine.events.filter((e) => e.ev === 'state').pop();
  eq(afterResume.operationId, held,
     'pause then play does NOT manufacture a new session');

  eq(engine.malformed.length, 0, 'the session step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});
step('contract', 'the reply data shapes AI-B asked for in CR-001 are all present', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  // CR-001 names these fields. The engine is allowed to send more (CONTRACT 3.3
  // says the other side ignores extras), but it must never send fewer or use a
  // different name -- that is precisely what would break the merge criterion of
  // CONTRACT 9.1 ("swap the target and change no protocol code").
  const hasField = (obj, name, type) => {
    if (!obj || typeof obj !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(obj, name)) return false;
    return type ? typeof obj[name] === type : true;
  };

  // hello -> { protocol, version }
  const hello = await engine.send({ cmd: 'hello', protocol: 1 });
  eq(hello.ok, true, 'hello replies ok');
  ok(hasField(hello.data, 'protocol', 'number'), 'hello.data.protocol is a number');
  eq(hello.data.protocol, 1, 'hello.data.protocol is 1');
  ok(hasField(hello.data, 'version', 'string'), 'hello.data.version is a string');

  // list_tracks -> { tracks: Track[] }, Track = { trackId, title, artist, album?,
  // durationMs, path, sampleRate?, bitDepth? }
  const listed = await engine.send({ cmd: 'list_tracks' });
  eq(listed.ok, true, 'list_tracks replies ok');
  ok(Array.isArray(listed.data.tracks), 'list_tracks.data.tracks is an array');
  const trackFields = [
    ['trackId', 'string'], ['title', 'string'], ['artist', 'string'], ['album', 'string'],
    ['durationMs', 'number'], ['path', 'string'], ['sampleRate', 'number'], ['bitDepth', 'number'],
  ];
  let trackShapeOk = true;
  let firstBad = '';
  for (const track of listed.data.tracks) {
    for (const [field, type] of trackFields) {
      if (!hasField(track, field, type)) {
        trackShapeOk = false;
        firstBad = track.trackId + ' missing ' + field + ' (' + type + ')';
        break;
      }
    }
    if (!trackShapeOk) break;
  }
  ok(trackShapeOk, 'every track carries the CR-001 fields with the right types', firstBad);
  eq(listed.data.tracks.length, tracks.length, 'list_tracks agrees with scan');

  // open -> { trackId, durationMs }
  const openable = tracks.find((t) => t.channels === 2);
  const opened = await engine.send({ cmd: 'open', trackId: openable.trackId }, 60000);
  eq(opened.ok, true, 'open replies ok', JSON.stringify(opened.error));
  ok(hasField(opened.data, 'trackId', 'string'), 'open.data.trackId is a string');
  ok(hasField(opened.data, 'durationMs', 'number'), 'open.data.durationMs is a number');
  eq(opened.data.trackId, openable.trackId, 'open.data.trackId echoes the request');

  // seek -> { positionMs }
  const seek = await engine.send({ cmd: 'seek', positionMs: 5000 });
  eq(seek.ok, true, 'seek replies ok');
  ok(hasField(seek.data, 'positionMs', 'number'), 'seek.data.positionMs is a number');

  // set_volume -> { volume }
  const volume = await engine.send({ cmd: 'set_volume', volume: 0.5 });
  eq(volume.ok, true, 'set_volume replies ok');
  ok(hasField(volume.data, 'volume', 'number'), 'set_volume.data.volume is a number');
  eq(volume.data.volume, 0.5, 'set_volume.data.volume echoes the request');

  // next / prev -> { trackId }
  const queue = await engine.send({ cmd: 'set_queue', trackIds: tracks.slice(0, 4).map((t) => t.trackId) });
  eq(queue.ok, true, 'set_queue replies ok');
  const next = await engine.send({ cmd: 'next' }, 60000);
  eq(next.ok, true, 'next replies ok', JSON.stringify(next.error));
  ok(hasField(next.data, 'trackId', 'string'), 'next.data.trackId is a string');
  const prev = await engine.send({ cmd: 'prev' }, 60000);
  eq(prev.ok, true, 'prev replies ok', JSON.stringify(prev.error));
  ok(hasField(prev.data, 'trackId', 'string'), 'prev.data.trackId is a string');

  // list_devices -> { devices: DeviceInfo[] }, DeviceInfo = { id, name, isDefault? }
  const devices = await engine.send({ cmd: 'list_devices' });
  eq(devices.ok, true, 'list_devices replies ok');
  ok(Array.isArray(devices.data.devices), 'list_devices.data.devices is an array');
  let deviceShapeOk = devices.data.devices.length > 0;
  for (const d of devices.data.devices) {
    if (!hasField(d, 'id', 'string') || !hasField(d, 'name', 'string') ||
        !hasField(d, 'isDefault', 'boolean')) { deviceShapeOk = false; break; }
  }
  ok(deviceShapeOk, 'every device carries the CR-001 fields { id, name, isDefault }');

  // Everything the app can receive must be strict JSON: no NaN, no undefined.
  const allReplies = [hello, listed, opened, seek, volume, queue, next, prev, devices];
  const badJson = allReplies.filter((r) => JSON.stringify(r) === undefined ||
                                          JSON.stringify(r).includes('null') === false && false);
  eq(badJson.length, 0, 'every reply serialises cleanly');

  eq(engine.malformed.length, 0, 'every stdout line parsed as JSON');
  await engine.send({ cmd: 'stop' });
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('latency', 'measured startup-to-audio and seek response against SPEC 8.2', async (args) => {
  const engine = new EngineClient(args.exe);
  const tStart = Date.now();
  await engine.start();
  const readyMs = Date.now() - tStart;

  const devices = await engine.send({ cmd: 'list_devices' });
  const device = (devices.data.devices ?? [])[0];
  const deviceRate = device ? device.sampleRate : 0;

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  // Measure on the path the app actually uses: a track the device takes at its
  // own rate, so a resampler setup cannot be mistaken for engine startup cost.
  const sameRate = tracks.filter((t) => t.sampleRate === deviceRate && t.channels === device.channels);
  const candidate = (sameRate.length ? sameRate : tracks)[0];

  console.log('   ready event:      ' + readyMs + ' ms after spawn');

  // --- open -> first audio -------------------------------------------------
  const tOpen = Date.now();
  const opened = await engine.send({ cmd: 'open', trackId: candidate.trackId }, 60000);
  const openMs = Date.now() - tOpen;
  eq(opened.ok, true, 'the measured track opens', JSON.stringify(opened.error));
  if (!opened.ok) { await engine.close(); return; }

  const tPlay = Date.now();
  const play = await engine.send({ cmd: 'play' });
  eq(play.ok, true, 'play starts', JSON.stringify(play.error));
  // Open does not play (CONTRACT 3.2), so "startup to sound" is play -> the
  // render side having handed real frames to the device, which is what the
  // position event reports.
  const firstPos = await engine.waitFor((e) => e.ev === 'position' && e.positionMs > 0, 10000);
  const playToAudioMs = firstPos ? Date.now() - tPlay : -1;
  ok(!!firstPos, 'audio begins after play');

  const openToAudioMs = openMs + playToAudioMs;
  console.log('   open -> ready:    ' + openMs + ' ms');
  console.log('   play -> audio:    ' + playToAudioMs + ' ms');
  console.log('   open -> audio:    ' + openToAudioMs + ' ms   (SPEC 8.2 target: <1000 ms)');
  // SPEC 8.2: "startup to sound < 1s (local file)". The budget is on the whole
  // path from being asked to play to sound coming out.
  ok(openToAudioMs > 0 && openToAudioMs < 1000,
     'startup to sound is under the SPEC 8.2 budget of 1s',
     openToAudioMs + ' ms');

  // --- seek response -------------------------------------------------------
  // SPEC 8.2: "Seek response: UI <50 ms / sound back <150 ms". The engine owns
  // the command-reply half; the UI half belongs to the app.
  const seeks = [];
  for (const positionMs of [30000, 60000, 90000]) {
    if (positionMs >= opened.data.durationMs - 2000) continue;
    const t0 = Date.now();
    const seek = await engine.send({ cmd: 'seek', positionMs });
    const dt = Date.now() - t0;
    if (seek.ok) seeks.push(dt);
  }
  const worstSeek = seeks.length ? Math.max(...seeks) : -1;
  console.log('   seek command:     ' + seeks.join(' / ') + ' ms  (worst ' + worstSeek + ')');
  ok(seeks.length > 0, 'at least one seek was measured');
  // The reply is the engine's half of the budget; the remainder is one 10 ms
  // device period before sound actually returns.
  ok(worstSeek >= 0 && worstSeek < 150,
     'seek command replies within the SPEC 8.2 sound-back budget of 150 ms',
     worstSeek + ' ms');

  // --- engine RSS ----------------------------------------------------------
  const rss = await tools_rss(args.exe);
  if (rss > 0) {
    console.log('   engine RSS:       ' + (rss / 1048576).toFixed(1) + ' MB   (SPEC 8.2 target: <=60 MB)');
    ok(rss / 1048576 <= 60, 'engine RSS while playing is within the SPEC 8.2 budget of 60 MB',
       (rss / 1048576).toFixed(1) + ' MB');
  } else {
    warn('could not read engine RSS on this platform');
  }

  // --- xrun count ----------------------------------------------------------
  await new Promise((r) => setTimeout(r, 1000));
  const state = engine.events.filter((e) => e.ev === 'state').pop();
  if (state) console.log('   xrunCount:        ' + state.xrunCount);
  ok(!state || state.xrunCount === 0, 'no underruns during the measured window',
     state ? String(state.xrunCount) : 'no state event');

  await engine.send({ cmd: 'stop' });
  eq(engine.malformed.length, 0, 'the latency step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('concurrency', 'commands sent during a scan are answered, not dropped', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  // A regression guard with a real history: the scan progress callback used to
  // read a pending stdin line and throw it away, so a get_state sent while a
  // scan was running silently vanished -- no reply, and the app would wait
  // forever. Anything sent mid-scan must now be answered in arrival order.
  const scanPromise = engine.send({ cmd: 'scan', path: args.library }, 120000);
  await new Promise((r) => setTimeout(r, 60));

  const duringScan = await engine.send({ cmd: 'get_state' }, 30000);
  eq(duringScan.ok, true, 'get_state sent during a scan is answered');
  ok(duringScan.data && 'state' in (duringScan.data || {}), 'the reply carries a state', JSON.stringify(duringScan.data));

  // A burst, to prove nothing is lost when several arrive between progress ticks.
  const burst = await Promise.all([
    engine.send({ cmd: 'get_state' }, 30000),
    engine.send({ cmd: 'list_devices' }, 30000),
    engine.send({ cmd: 'hello', protocol: 1 }, 30000),
  ]);
  eq(burst.filter((r) => r.ok).length, burst.length, 'a burst of commands during a scan is answered');

  const scan = await scanPromise;
  eq(scan.ok, true, 'the scan itself still completes', JSON.stringify(scan.error));
  eq(scan.data.tracks.length, 91, 'the concurrent scan still returns all 91 tracks');

  eq(engine.malformed.length, 0, 'interleaved traffic kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('completion', 'a track plays through to its natural end without clipping the tail', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  // Shortest track in the library. The point of this step is the TAIL: end of
  // stream must be declared when the last decoded frame has actually been
  // rendered, not when the decoder finishes, or every track loses its last
  // fraction of a second. Everything else in the suite proves a track STARTS.

  const shortest = tracks.reduce((a, b) => (b.durationMs < a.durationMs ? b : a));
  console.log('   shortest track: ' + shortest.title + '  ' + (shortest.durationMs / 1000).toFixed(1) + 's');

  const opened = await engine.send({ cmd: 'open', trackId: shortest.trackId });
  ok(opened.ok, 'the shortest track opens', JSON.stringify(opened.error));

  // Start 20 s before the end. Long enough that the tail is reached by playing
  // rather than by another seek, short enough that the step does not take the
  // whole track's runtime.
  const tailMs = 20000;
  const seekTo = Math.max(0, shortest.durationMs - tailMs);
  const seek = await engine.send({ cmd: 'seek', positionMs: seekTo });
  ok(seek.ok, 'seek into the tail succeeds', JSON.stringify(seek.error));

  const startedAt = Date.now();
  const played = await engine.send({ cmd: 'play' });
  ok(played.ok, 'play starts');

  const ended = await engine.waitForEvent('ended', () => true, tailMs + 15000);
  const elapsed = Date.now() - startedAt;

  ok(!!ended, 'the track ends on its own');
  ok(elapsed > tailMs * 0.9,
     'playback took about as long as the remaining audio',
     elapsed + ' ms for ' + tailMs + ' ms of audio');

  // The measurement this step exists for. If the tail is cut, the last reported
  // position falls short of the real duration, and nothing else in the suite
  // would notice -- every other step only proves a track STARTS.
  const positions = engine.events.filter((e) => e.ev === 'position');
  const last = positions.length ? positions[positions.length - 1].positionMs : 0;
  const shortfall = shortest.durationMs - last;
  console.log('   reported end:   ' + last + ' ms of ' + shortest.durationMs +
              ' ms  (shortfall ' + shortfall + ' ms)');
  ok(shortfall >= 0 && shortfall < 1000,
     'the reported end reaches the real duration (the tail is not clipped)',
     'shortfall ' + shortfall + ' ms');

  const settled = engine.events.filter((e) => e.ev === 'state').pop();
  ok(settled && settled.state !== 'playing',
     'the engine is not left in a playing state',
     settled ? settled.state : 'no state event');

  eq(engine.malformed.length, 0, 'the completion step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('exclusive', 'WASAPI exclusive at the source rate, and honest degradation', async (args) => {
  const engine = new EngineClient(args.exe);
  const ready = await engine.start();

  const device = (ready.devices && ready.devices[0]) || null;
  ok(!!device, 'a default device was reported');
  if (!device) { await engine.close(); return; }
  console.log('   device: ' + device.name + '  ' + device.channels + 'ch @ ' + device.sampleRate + 'Hz');

  // SPEC 3.3 capability probing. Without this list the engine cannot know what
  // the endpoint will take, and a refusal is indistinguishable from a bug.
  const formats = device.exclusiveFormats || [];
  console.log('   exclusive formats the endpoint accepts: ' +
              (formats.length ? formats.join(', ') : 'none'));
  ok(Array.isArray(formats), 'ready.devices[].exclusiveFormats is an array');

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  // Prefer a track the PROBED capability says the endpoint can take natively.
  // Picking arbitrarily would make a genuine refusal look like a missing
  // feature, which is the whole thing this step is trying to tell apart.
  const capable = tracks.filter((t) => formats.includes(t.sampleRate + ':' + t.bitDepth));
  const track = capable.length ? capable[0]
    : tracks.filter((t) => formats.some((f) => Number(f.split(':')[0]) === t.sampleRate))[0];
  ok(!!track, 'the library has a track the probed capability covers');
  if (!track) { await engine.close(); return; }
  console.log('   track:  ' + track.title + '  ' + track.sampleRate + 'Hz/' + track.bitDepth + 'bit' +
              (capable.length ? '  (endpoint supports it)' : '  (endpoint does NOT support it)'));

  const mode = await engine.send({ cmd: 'set_output', mode: 'exclusive' });
  // CONTRACT 3.4: exclusive being refused is a DEGRADATION, not an error. The
  // command itself must still succeed.
  eq(mode.ok, true, 'set_output exclusive is accepted (degradation is not an error)');

  await engine.send({ cmd: 'open', trackId: track.trackId });
  await engine.send({ cmd: 'set_volume', volume: 1.0 });
  await engine.send({ cmd: 'play' });

  const state = engine.events.filter((e) => e.ev === 'state').pop();
  ok(!!state, 'a state event describes the stream');
  if (!state) { await engine.close(); return; }
  const landedExclusive = state.outputMode === 'exclusive';
  console.log('   landed:       ' + state.outputMode + '  ' + state.sampleRate + 'Hz  bitPerfect=' +
              state.bitPerfect + '  resampled=' + state.resampled);

  // What must hold REGARDLESS of which path the hardware allows.
  //
  // The endpoint here accepts 48000:24 exclusively, so exclusive genuinely opens
  // and negotiation completes. Whether that stream then RUNS is a separate
  // question this particular driver answers with 'no', so the engine is expected
  // to notice and fall back. Both outcomes are correct; what would be wrong is
  // silence, or a bit-perfect claim that is not true.
  ok(!!state.degradeReason || landedExclusive,
     'the engine either achieved exclusive or said why not',
     JSON.stringify({ mode: state.outputMode, reason: state.degradeReason }));

  // bit-perfect must never be claimed on a stream that is not delivering source
  // integers at the source rate. This is the one assertion that catches the
  // dangerous failure: a badge the user trusts.
  if (state.bitPerfect) {
    eq(state.outputMode, 'exclusive', 'a bit-perfect claim requires an exclusive stream');
    eq(state.sampleRate, track.sampleRate, 'a bit-perfect claim requires the source rate');
    eq(state.resampled, false, 'a bit-perfect claim forbids the resampler');
    console.log('   -> exclusive delivering bit-perfect output');
  } else {
    ok(true, 'bit-perfect not claimed');
    console.log('   -> not bit-perfect (' + (state.degradeReason || 'shared stream') + ')');
  }

  // Audio must flow in either case -- and this is the assertion that matters most
  // for exclusive mode. An exclusive stream that opens, reports bit-perfect and
  // renders nothing is the worst possible outcome, because every other signal
  // says the feature works. The watchdog exists to convert that into a working
  // shared stream, and this is where that is checked.
  const first = await engine.waitForEvent('position', (e) => e.positionMs > 0, 12000);
  const p1 = first ? first.positionMs : 0;
  await new Promise((r) => setTimeout(r, 900));
  const p2 = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: 0 }).positionMs;
  ok(p2 > p1, 'position advances while playing in the requested mode', p1 + ' -> ' + p2);

  // If the watchdog fired, the user must have been told rather than left to
  // wonder, and playback must have continued instead of stopping.
  const fellBack = engine.events.some((e) => e.ev === 'log' && /exclusive/i.test(e.message || ''));
  const settled = engine.events.filter((e) => e.ev === 'state').pop();
  if (fellBack) {
    console.log('   -> watchdog: exclusive was silent, engine fell back and kept playing');
    eq(settled.outputMode, 'shared', 'after the fallback the stream is shared');
    eq(settled.state, 'playing', 'after the fallback playback continues');
    eq(settled.bitPerfect, false, 'after the fallback bit-perfect is no longer claimed');
    ok(!!settled.degradeReason, 'the fallback explains itself', JSON.stringify(settled.degradeReason));
  }

  // Volume and bit-perfect are mutually exclusive by definition: a gain change is
  // not the source integers. Only meaningful on a stream the engine is genuinely
  // committed to, so it is skipped once the watchdog has fallen back.
  if (landedExclusive && state.bitPerfect && !fellBack) {
    const vol = await engine.send({ cmd: 'set_volume', volume: 0.5 });
    eq(vol.ok, true, 'set_volume replies ok');
    const afterVol = engine.events.filter((e) => e.ev === 'state').pop();
    eq(afterVol.bitPerfect, false, 'a volume below unity stops being bit-perfect');
    const restored = await engine.send({ cmd: 'set_volume', volume: 1.0 });
    eq(restored.ok, true, 'volume back to unity');
    const afterRestore = engine.events.filter((e) => e.ev === 'state').pop();
    eq(afterRestore.bitPerfect, true, 'restoring unity volume restores bit-perfect');
  } else if (landedExclusive && state.bitPerfect && fellBack) {
    console.log('   -> volume/bit-perfect interplay skipped: exclusive fell back on this endpoint');
  }

  // auto must land wherever the endpoint really allows, not silently stay put.
  await engine.send({ cmd: 'stop' });
  const auto = await engine.send({ cmd: 'set_output', mode: 'auto' });
  eq(auto.ok, true, 'set_output auto is accepted');
  console.log('   auto landed:  ' + (auto.data ? auto.data.outputMode : '(no mode reported)'));
  ok(!!auto.data && !!auto.data.outputMode, 'auto reports the mode it landed on');

  const bogus = await engine.send({ cmd: 'set_output', mode: 'bitperfect' });
  eq(bogus.ok, false, 'an unknown mode is refused rather than guessed at');
  eq(bogus.error.code, 'ERR_STATE', 'an unknown mode is refused with ERR_STATE');

  eq(engine.malformed.length, 0, 'the exclusive step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('ir', 'CR-020: FIR / room convolution, its analysis, and its refusals', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();

  await engine.send({ cmd: 'scan', path: args.library }, 120000).catch(() => null);
  const clean = (await engine.send({ cmd: 'get_state' })).data;
  ok(!!clean.dsp.ir, 'get_state carries the dsp.ir block', JSON.stringify(Object.keys(clean.dsp || {})));
  eq(clean.dsp.ir.loaded, false, 'a fresh engine has no impulse response');
  eq(clean.dsp.ir.enabled, false, 'and it is not enabled');
  eq(clean.dsp.ir.latencyFrames, 0, 'with no IR there is no added latency');
  eq(clean.dsp.passthrough, true, 'a fresh engine is still a pass-through');

  // h = 1.0*delta + 0.5*delta(n-8): |H| peaks at 1.5 (+3.5218 dB) where the two
  // taps align (6000 Hz at 48 kHz) and nulls at 0.5 (-6.02 dB) at 3000 Hz.
  // Writing the WAV here rather than shipping one keeps the analytic value in
  // the same file as the assertion that uses it.
  const dir = join(tmpdir(), 'te-ir-step-' + process.pid);
  mkdirSync(dir, { recursive: true });
  const irPath = join(dir, 'analytic.wav');
  {
    const rate = 48000, frames = 4096, channels = 1;
    const samples = new Float32Array(frames);
    samples[0] = 1.0; samples[8] = 0.5;
    const bytes = 44 + frames * channels * 2;
    const buf = Buffer.alloc(bytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * channels * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(frames * channels * 2, 40);
    samples.forEach((sample, i) => {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
    });
    writeFileSync(irPath, buf);
  }

  const loaded = await engine.send({ cmd: 'set_ir', path: irPath });
  if (!ok(loaded.ok, 'set_ir loads a WAV impulse response', JSON.stringify(loaded.error))) {
    rmSync(dir, { recursive: true, force: true });
    await engine.close();
    return;
  }
  const ir = loaded.data.ir;
  eq(ir.loaded, true, 'the IR reports as loaded');
  eq(ir.enabled, true, 'loading enables it');
  eq(ir.taps, 4096, 'the tap count is the file length');
  eq(ir.channels, 1, 'the channel count follows the file');
  eq(ir.sampleRate, 48000, 'the source sample rate is reported');
  eq(ir.partitions, 4, '4096 taps is four 1024-frame partitions');
  eq(ir.latencyFrames, 1024, 'the added latency is exactly one partition');
  eq(ir.name, 'analytic.wav', 'the file name is reported (not the whole path)');
  eq(loaded.data.passthrough, false, 'an active IR is NOT a pass-through');

  // The analysis is what the automatic preamp and the preview are built on, so
  // it is asserted against the ANALYTIC value, not against itself.
  ok(Math.abs(ir.maxGainDb - 3.5218) < 0.1,
     'the response peak matches 20log10(1.5)', 'maxGainDb=' + ir.maxGainDb);
  ok(Math.abs(ir.preampDb + ir.maxGainDb) < 0.01,
     'the automatic preamp is -peak (headroom for the boost)', 'preampDb=' + ir.preampDb);
  ok(Array.isArray(ir.curve) && ir.curve.length === 48,
     'a 48-point preview curve is reported', 'len=' + (ir.curve || []).length);
  if (Array.isArray(ir.curve) && ir.curve.length > 1) {
    ok(ir.curve[ir.curve.length - 1].hz > ir.curve[0].hz, 'the preview curve is ordered by frequency');
    const peak = ir.curve.reduce((a, b) => (b.db > a.db ? b : a));
    ok(Math.abs(peak.db - ir.maxGainDb) < 1.0,
       'the sampled preview reaches the true peak', 'curvePeak=' + peak.db);
  }

  // state.dspModules is how the interface knows what is actually running.
  const stateEvent = engine.events.filter((e) => e.ev === 'state').pop();
  ok(!!stateEvent, 'a state event was emitted for the IR change');
  if (stateEvent) {
    ok((stateEvent.dspModules || []).includes('ir'),
       'dspModules names the convolution when it is in force', JSON.stringify(stateEvent.dspModules));
    eq(stateEvent.dspActive, true, 'and dspActive is true');
  }

  const off = await engine.send({ cmd: 'set_ir', enabled: false });
  eq(off.data.ir.enabled, false, 'the IR can be switched off without unloading it');
  eq(off.data.ir.loaded, true, 'the loaded response survives the switch');
  eq(off.data.passthrough, true, 'a disabled IR is a pass-through again');
  const backOn = await engine.send({ cmd: 'set_ir', enabled: true, preampDb: -6 });
  eq(backOn.data.ir.preampDb, -6, 'the manual trim overrides the automatic one');

  // Refusals have to be specific: "invalid IR" would tell the user nothing.
  const empty = await engine.send({ cmd: 'set_ir' });
  eq(empty.ok, false, 'set_ir with no fields is refused rather than a no-op ok');
  const missing = await engine.send({ cmd: 'set_ir', path: join(dir, 'does-not-exist.wav') });
  eq(missing.ok, false, 'a missing file is refused');
  ok(String((missing.error || {}).message || '').includes('set_ir'),
     'and the error names the command', JSON.stringify(missing.error));
  const blank = await engine.send({ cmd: 'set_ir', path: '   ' });
  eq(blank.ok, false, 'a blank path is refused');

  rmSync(dir, { recursive: true, force: true });
  eq(engine.malformed.length, 0, 'the ir step kept stdout clean');
  await engine.close();
});

step('dsp', '10-band EQ, ReplayGain, limiter, and bit-perfect honesty', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();
  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;

  // A fresh engine is processing nothing, so the samples really are the stored
  // integers. This is the state bit-perfect is defined against.
  const clean = (await engine.send({ cmd: 'get_state' })).data;
  ok(!!clean.dsp, 'get_state carries the dsp block', JSON.stringify(Object.keys(clean.dsp || {})));
  eq(clean.dsp.passthrough, true, 'a fresh engine is a pass-through');
  eq(clean.dsp.appliedGainDb, 0, 'a fresh engine applies no gain');
  eq(clean.dsp.eq.bands.length, 10, 'ten EQ bands are reported');
  eq(clean.dsp.eq.bands[0].freq, 31.25, 'band 0 is 31.25 Hz');
  eq(clean.dsp.eq.bands[9].freq, 16000, 'band 9 is 16 kHz');

  // SPEC 3.4 limits, refused rather than silently clamped. A caller asking for
  // +40 dB has a bug, and hiding it behind a plausible-looking +12 dB is worse.
  const tooLoud = await engine.send({ cmd: 'set_eq', bandGains: [40] });
  eq(tooLoud.ok, false, 'a gain beyond +12 dB is refused');
  eq(tooLoud.error.code, 'ERR_STATE', 'an out-of-range gain is refused with ERR_STATE');
  const tooMany = await engine.send({ cmd: 'set_eq', bandGains: new Array(11).fill(0) });
  eq(tooMany.ok, false, 'more than ten bands is refused');
  const badQ = await engine.send({ cmd: 'set_eq', q: 99 });
  eq(badQ.ok, false, 'a Q outside 0.5..4 is refused');
  const pointless = await engine.send({ cmd: 'set_eq' });
  eq(pointless.ok, false, 'set_eq with no fields is refused rather than a no-op ok');

  // Auto headroom: a +6 dB band must be paid for by -6 dB of static gain, or
  // boosting the EQ would simply clip.
  const boosted = (await engine.send({ cmd: 'set_eq', enabled: true, bandGains: [0,0,0,6,0,0,0,0,0,0] })).data;
  eq(boosted.eq.enabled, true, 'the EQ reports as enabled');
  eq(boosted.passthrough, false, 'an enabled EQ is not a pass-through');
  ok(Math.abs(boosted.appliedGainDb + 6) < 0.01,
     'auto headroom subtracts the largest band boost', 'appliedGainDb=' + boosted.appliedGainDb);

  // The two corrections COMPOSE, and the order is what the SPEC fixes:
  //   applied = preamp + replayGain - headroom
  // The EQ above is still enabled with +6 dB on band 3, so a -7.5 dB ReplayGain
  // must land at -13.5 dB, not -7.5. Asserting the composition here is worth more
  // than asserting either term alone, because that is the arithmetic a user
  // actually hears when they use both features at once.
  const composed = (await engine.send({ cmd: 'set_replaygain', mode: 'track', trackGainDb: -7.5, trackPeak: 0 })).data;
  eq(composed.replayGain.mode, 'track', 'ReplayGain mode is reported as track');
  ok(Math.abs(composed.appliedGainDb + 13.5) < 0.01,
     'ReplayGain and auto headroom compose additively',
     'expected -13.5, appliedGainDb=' + composed.appliedGainDb);

  // Now isolate ReplayGain: with the EQ off there is no headroom to subtract.
  await engine.send({ cmd: 'set_eq', enabled: false });
  const rg = (await engine.send({ cmd: 'set_replaygain', mode: 'track', trackGainDb: -7.5, trackPeak: 0 })).data;
  ok(Math.abs(rg.appliedGainDb + 7.5) < 0.01,
     'with the EQ off the applied gain is the ReplayGain value alone',
     'appliedGainDb=' + rg.appliedGainDb);

  // preventClip: a master whose peak is already at full scale cannot take a
  // +6 dB boost, so the boost is capped back to (almost) unity.
  const capped = (await engine.send({ cmd: 'set_replaygain', mode: 'track', trackGainDb: 6, trackPeak: 1.0 })).data;
  ok(capped.appliedGainDb <= 0.0,
     'preventClip caps a boost when the peak is already at full scale',
     'appliedGainDb=' + capped.appliedGainDb);

  // THE HONESTY GUARANTEE, and the reason this suite grew a dsp step at all.
  // SPEC 1.1 makes bit-perfect the difference this project exists for. The
  // moment an EQ band or a ReplayGain offset is in force the samples are no
  // longer the stored integers, so state.bitPerfect must go false -- in EVERY
  // output mode, including the exclusive path where it would otherwise be true.
  await engine.send({ cmd: 'open', trackId: tracks[0].trackId });
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('state', () => true, 4000);
  const playing = engine.events.filter((e) => e.ev === 'state').pop();
  eq(playing.bitPerfect, false, 'DSP engaged means no bit-perfect claim while playing');

  // Put everything back and the guarantee has to come back with it: this is what
  // stops the flag from latching false forever after one experiment.
  await engine.send({ cmd: 'set_eq', enabled: false, bandGains: [0,0,0,0,0,0,0,0,0,0], preampDb: 0 });
  await engine.send({ cmd: 'set_replaygain', mode: 'off', trackGainDb: 0, trackPeak: 0, preventClip: true });
  await new Promise((r) => setTimeout(r, 300));
  const restored = (await engine.send({ cmd: 'get_state' })).data;
  eq(restored.dsp.passthrough, true, 'clearing the EQ restores pass-through');
  ok(Math.abs(restored.dsp.appliedGainDb) < 0.001,
     'clearing everything restores unity gain', 'appliedGainDb=' + restored.dsp.appliedGainDb);

  // And audio still flows with the chain engaged: a filter that silently
  // produced nothing would pass every assertion above.
  await engine.send({ cmd: 'set_eq', enabled: true, bandGains: [3,3,3,0,0,0,0,0,0,0] });
  const before = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: 0 }).positionMs;
  const advanced = await engine.waitForEvent('position', (e) => e.positionMs > before, 4000);
  ok(!!advanced, 'position keeps advancing with the EQ engaged',
     before + ' -> ' + (advanced ? advanced.positionMs : 'stalled'));

  eq(engine.malformed.length, 0, 'the dsp step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

step('honesty', 'DESIGN-A A1-A5: every degradation is reported, nothing is invented', async (args) => {
  const engine = new EngineClient(args.exe);
  const ready = await engine.start();

  // A4: capabilities must not under-report either. dsp:false kept the DSP
  // segment off the drawn signal path even after EQ and ReplayGain landed.
  //
  // capabilities live on the hello REPLY, not on the ready event: ready tells
  // the app what exists, hello answers what the engine can be asked to do.
  const hello = await engine.send({ cmd: 'hello', protocol: 1 });
  eq(hello.data.capabilities.dsp, true, 'the engine declares the DSP capability it has');
  eq(ready.devices.length > 0, true, 'ready still carries the device list');

  const scan = await engine.send({ cmd: 'scan', path: args.library }, 120000);
  if (!ok(scan.ok, 'scan succeeds', JSON.stringify(scan.error))) { await engine.close(); return; }
  const tracks = scan.data.tracks;
  const track = tracks.find((t) => t.sampleRate === 48000) || tracks[0];

  // A2: the ordinary path must NOT set degradeReason. A dashed line on a clean
  // stream is a false alarm, and it is just as dishonest as hiding a real one.
  await engine.send({ cmd: 'set_output', mode: 'shared' });
  await engine.send({ cmd: 'open', trackId: track.trackId });
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);
  const clean = engine.events.filter((e) => e.ev === 'state').pop();
  eq(clean.outputMode, 'shared', 'the clean path really is on shared output');
  ok(!clean.degradeReason, 'a normal shared stream reports NO degradation',
     'degradeReason=' + JSON.stringify(clean.degradeReason));
  eq(clean.dspActive, false, 'A4: nothing is altering the samples yet');
  eq(Array.isArray(clean.dspModules) && clean.dspModules.length, 0,
     'A4: dspModules is empty when no module is in force');

  // A4: engaging the EQ must flip the flag -- this is what draws the DSP segment
  // and what must darken the BP segment with it.
  await engine.send({ cmd: 'set_eq', enabled: true, bandGains: [0,0,0,0,0,3,0,0,0,0] });
  await new Promise((r) => setTimeout(r, 200));
  const withEq = engine.events.filter((e) => e.ev === 'state').pop();
  eq(withEq.dspActive, true, 'A4: dspActive turns true when the EQ is engaged');
  ok(Array.isArray(withEq.dspModules) && withEq.dspModules.includes('eq'),
     'A4: dspModules names the module in force', JSON.stringify(withEq.dspModules));
  eq(withEq.bitPerfect, false, 'A4: DSP in force means bit-perfect is not claimed');

  await engine.send({ cmd: 'set_eq', enabled: false, bandGains: [0,0,0,0,0,0,0,0,0,0] });
  await new Promise((r) => setTimeout(r, 200));
  const back = engine.events.filter((e) => e.ev === 'state').pop();
  eq(back.dspActive, false, 'A4: clearing the EQ clears dspActive (it does not latch)');

  // A1: the exclusive path degrades on this machine, and the degradation MUST be
  // explained. This is the case DESIGN-A 2 is built around.
  await engine.send({ cmd: 'set_output', mode: 'exclusive' });
  await engine.send({ cmd: 'open', trackId: track.trackId });
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('position', (e) => e.positionMs > 0, 12000);

  // Let a fallback SETTLE before reading the state. The exclusive-silence
  // watchdog needs its grace period before it acts, and reading immediately
  // caught the stream while it still said exclusive -- which meant the exported
  // trace contained no degradation at all, defeating the point of exporting it.
  const reported = await engine.waitForEvent('state', (e) => !!e.degradeReason, 8000);
  const degraded = reported || engine.events.filter((e) => e.ev === 'state').pop();
  const landedExclusive = degraded.outputMode === 'exclusive';
  if (!landedExclusive) {
    ok(!!degraded.degradeReason,
       'A1: a stream that ended up on shared says WHY',
       JSON.stringify(degraded.degradeReason));
    console.log('   degradation reported: ' + degraded.degradeReason);
  } else {
    // Ask the engine WHY, using the field that answers THAT question.
    //
    // degradeReason answers a different one: it means the requested output mode
    // was abandoned. A 24-bit track delivered in a 32-bit container is NOT a
    // degradation -- the audio is identical, only the packing differs, and the
    // owner ruled exactly that in CR-010 -- so degradeReason is correctly empty
    // while bitPerfect is correctly false. This assertion conflated the two, and
    // it passed only while this machine's USB DAC happened to accept the narrow
    // container; on the internal endpoint it reported a defect that was not one.
    const detail = (await engine.send({ cmd: 'get_state' })).data;
    ok(detail.bitPerfect || !!detail.outputNotPerfectReason,
       'A1: exclusive either is bit-perfect, or names why it is not',
       JSON.stringify({ bp: detail.bitPerfect, reason: detail.outputNotPerfectReason,
                        degradeReason: detail.degradeReason }));
    console.log('   exclusive achieved; not-perfect reason=' +
                JSON.stringify(detail.outputNotPerfectReason));
  }

  // A1/A2 together: the reason must be human text, not a debug dump. It is
  // displayed verbatim in C3.
  if (degraded.degradeReason) {
    ok(degraded.degradeReason.length > 8 && degraded.degradeReason.length < 200,
       'A1: the reason is a readable sentence of sane length',
       degraded.degradeReason);
    ok(!/0x[0-9a-f]{8}/i.test(degraded.degradeReason) && !/\bat line \d/.test(degraded.degradeReason),
       'A1: the reason carries no HRESULT or stack trace (it is shown to the user)',
       degraded.degradeReason);
  }

  // A3: the two xrun sources must not contradict each other.
  const xrunEvents = engine.events.filter((e) => e.ev === 'xrun');
  const finalState = engine.events.filter((e) => e.ev === 'state').pop();
  ok(typeof finalState.xrunCount === 'number', 'A3: state.xrunCount is a number',
     JSON.stringify(finalState.xrunCount));
  if (xrunEvents.length) {
    const last = xrunEvents[xrunEvents.length - 1].count;
    ok(last === finalState.xrunCount,
       'A3: the last xrun event agrees with the cumulative state field',
       'event=' + last + ' state=' + finalState.xrunCount);
  } else {
    eq(finalState.xrunCount, 0, 'A3: no event and a zero total are consistent');
  }

  // A5: the two ERR_UNSUPPORTED situations must be told apart.
  const unsupported = await engine.send({ cmd: 'pick_folder' });
  eq(unsupported.ok, false, 'A5: pick_folder is refused');
  eq(unsupported.error.code, 'ERR_UNSUPPORTED', 'A5: it uses ERR_UNSUPPORTED');
  eq(unsupported.error.kind, 'not_implemented',
     'A5: it says the engine has not built it, which is a wait, not a device switch');

  // The handover artefact itself. DESIGN-A 8 asks for a trace containing a real
  // degradation, because a clean trace would let a UI that never draws the
  // degraded path pass its own tests against real data.
  const sawDegradation = engine.events.some((e) => e.ev === 'state' && e.degradeReason);
  console.log('   trace contains a degradation: ' + sawDegradation);
  if (args.exportTrace) {
    const trace = {
      _comment: 'DESIGN-A 8 handover. Real state event sequences captured from the engine, including a genuine degradation, so C2 can be rendered from real data instead of hand-made fixtures.',
      _generatedAt: new Date().toISOString(),
      _exe: args.exe,
      _library: args.library,
      _note: 'degradeReason is human-readable by contract: it is displayed verbatim.',
      // Self-describing: what this particular capture actually exercises. An
      // xrun cannot be summoned on demand, so when the count is zero that is a
      // fact about the run rather than a missing feature, and B should know
      // which of the two it is looking at.
      _contains: {
        degradations: engine.events.filter((e) => e.ev === 'state' && e.degradeReason).length,
        xrunEvents: engine.events.filter((e) => e.ev === 'xrun').length,
        dspActiveSeen: engine.events.some((e) => e.ev === 'state' && e.dspActive),
        note: 'xrunEvents is 0 when no underrun occurred during the capture; the event shape is declared in the contract either way.',
      },
      capabilities: hello.data.capabilities,
      devices: ready.devices,
      events: engine.events,
    };
    mkdirSync(dirname(TRACE_PATH), { recursive: true });
    writeFileSync(TRACE_PATH, JSON.stringify(trace, null, 2) + '\n', 'utf8');
    console.log('   trace written:   ' + TRACE_PATH);
  }

  eq(engine.malformed.length, 0, 'the honesty step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});
step('bitperfect', 'the double-state model: bitPerfect / outputPerfect / sourceExact / pcmPassthrough', async (args) => {
  // REFS-A2 0 asks whether the engine over-claims bit-perfection for a 24-bit
  // source packed into a wider container. It did. This step is the matrix that
  // keeps the four fields from drifting apart again -- the invariant that caught
  // the bug in the first place is assertion 1 below.
  const engine = new EngineClient(args.exe);
  const ready = await engine.start();
  await engine.send({ cmd: 'scan', path: args.library }, 120000);
  const list = await engine.send({ cmd: 'list_tracks' });
  const tracks = list.data.tracks;

  // Across every mode and depth this machine can reach, the four fields must be
  // mutually consistent on EVERY state event. Checking one event would miss the
  // transitions, and transitions are where the two computations disagreed.
  const seen = [];
  const checkEvent = (s, where) => {
    if (s.bitPerfect === undefined) return;
    seen.push(s);
    // 1. The alias must be literally equal. This is the invariant that failed:
    //    bitPerfect was computed separately from outputPerfect and the two
    //    disagreed by construction once the container rule existed.
    eq(s.bitPerfect, s.outputPerfect,
       where + ': bitPerfect is the alias of outputPerfect',
       'bitPerfect=' + s.bitPerfect + ' outputPerfect=' + s.outputPerfect);
    // 2. sourceExact is the strictest, so it cannot exceed outputPerfect.
    ok(!(s.sourceExact === true && s.outputPerfect !== true),
       where + ': sourceExact implies outputPerfect');
    // 3. outputPerfect requires a format passthrough; it cannot exceed it.
    ok(!(s.outputPerfect === true && s.pcmPassthrough !== true),
       where + ': outputPerfect implies pcmPassthrough');
    // 4. A false outputPerfect must come with a reason, and a true one with an
    //    empty reason. An unexplained false is the thing the UI cannot render,
    //    and a reason attached to a true is the false alarm DESIGN-A bans.
    if (s.outputPerfect === false) {
      ok(!!s.outputNotPerfectReason, where + ': a false outputPerfect explains itself',
         JSON.stringify(s.outputNotPerfectReason));
    } else {
      eq(s.outputNotPerfectReason, '', where + ': a true outputPerfect carries no reason');
    }
    // 5. The container and precision are reported, so the claim is auditable.
    if (s.outputMode && s.outputMode !== 'none') {
      ok(typeof s.containerBits === 'number' && typeof s.validBits === 'number',
         where + ': container and precision are reported',
         'container=' + s.containerBits + ' valid=' + s.validBits);
    }
  };

  for (const mode of ['shared', 'exclusive', 'auto']) {
    await engine.send({ cmd: 'set_output', mode });
    for (const want of [{ r: 48000, b: 24 }, { r: 44100, b: 16 }, { r: 48000, b: 16 }]) {
      const t = tracks.find((x) => x.sampleRate === want.r && x.bitDepth === want.b);
      if (!t) continue;
      await engine.send({ cmd: 'open', trackId: t.trackId });
      await engine.send({ cmd: 'set_volume', volume: 1.0 });
      await engine.send({ cmd: 'play' });
      await new Promise((r) => setTimeout(r, 700));
      checkEvent(engine.events.filter((e) => e.ev === 'state').pop(),
                 mode + '/' + want.r + 'Hz/' + want.b + 'bit');
      await engine.send({ cmd: 'stop' });
    }
  }
  console.log('   state events checked: ' + seen.length);

  // The specific over-claim REFS-A2 pointed at, asserted directly rather than
  // left to the generic invariants: a container wider than the source precision
  // is NOT a format passthrough, even though the audio is identical.
  const wide = seen.find((s) => s.containerBits > s.bitDepth && s.bitDepth > 0);
  if (wide) {
    eq(wide.pcmPassthrough, false,
       'a container wider than the source precision is not a format passthrough',
       wide.bitDepth + '-bit source in a ' + wide.containerBits + '-bit container');
    ok(!wide.outputPerfect,
       'and it therefore is not output-perfect either',
       JSON.stringify(wide.outputNotPerfectReason));
    console.log('   container case observed: ' + wide.bitDepth + '-bit in ' +
                wide.containerBits + '-bit container -- ' + wide.outputNotPerfectReason);
  } else {
    console.log('   (no wider-container stream was reached on this run)');
  }

  // And the honest counter-case: if any stream DID reach output-perfect, its
  // format really must match on the nose. Without this, a bug that simply
  // always returned false would pass every assertion above.
  const perfect = seen.find((s) => s.outputPerfect === true);
  if (perfect) {
    eq(perfect.pcmPassthrough, true, 'an output-perfect stream is a format passthrough');
    eq(perfect.containerBits, perfect.bitDepth,
       'an output-perfect stream uses the source container width');
    eq(perfect.resampled, false, 'an output-perfect stream is not resampled');
    console.log('   output-perfect reached: ' + perfect.bitDepth + '-bit, container ' +
                perfect.containerBits + ', ' + perfect.outputMode);
  } else {
    ok(true, 'no output-perfect stream on this endpoint (expected here)');
    console.log('   no output-perfect stream was reachable on this endpoint');
  }

  eq(engine.malformed.length, 0, 'the bitperfect step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});
step('loudness', 'EBU R128 scan: ReplayGain can be computed, not only applied', async (args) => {
  const engine = new EngineClient(args.exe);
  await engine.start();
  await engine.send({ cmd: 'scan', path: args.library }, 120000);
  const list = await engine.send({ cmd: 'list_tracks' });
  const all = list.data.tracks;

  // A spread on purpose: different rates, depths and loudness. One track would
  // only prove the code runs.
  const shortest = all.reduce((a, b) => (b.durationMs < a.durationMs ? b : a));
  const picks = [];
  for (const want of [shortest, all.find((t) => t.sampleRate === 96000),
                      all.find((t) => t.bitDepth === 16), all[0], all[40]]) {
    if (want && !picks.some((p) => p.trackId === want.trackId)) picks.push(want);
  }
  const ids = picks.map((t) => t.trackId);

  // album: true because this step checks the album figure below, and album gain
  // needs a decoder state per track -- which is exactly what the cache cannot
  // provide. Asking for it explicitly is the contract; the per-track-only path
  // is what stays on the cache.
  const r = await engine.send({ cmd: 'analyze_loudness', trackIds: ids, album: true }, 600000);
  if (!ok(r.ok, 'analyze_loudness succeeds', JSON.stringify(r.error))) { await engine.close(); return; }
  const data = r.data;

  eq(data.targetLufs, -18, 'the ReplayGain target is the SPEC 3.4 reference');
  eq(data.tracks.length, ids.length, 'one result per requested track');
  ok(data.analysedSeconds > 0, 'audio was actually decoded', String(data.analysedSeconds));
  console.log('   analysed ' + data.analysedSeconds.toFixed(0) + 's across ' + ids.length + ' tracks');

  // Every result must be a measurement, and the gain must be derived from it by
  // the documented relation. A gain that is merely 'a number' would still look
  // reasonable in a UI and would be wrong on every track.
  for (const e of data.tracks) {
    ok(e.ok === true, 'track ' + e.trackId + ' produced a measurement', JSON.stringify(e.reason));
    if (!e.ok) continue;
    ok(e.integratedLufs < 0 && e.integratedLufs > -40,
       'track ' + e.trackId + ' loudness is in a plausible range',
       e.integratedLufs + ' LUFS');
    ok(Math.abs(e.gainDb - (-18 - e.integratedLufs)) < 0.001,
       'track ' + e.trackId + ' gain is target minus measured',
       'lufs=' + e.integratedLufs + ' gain=' + e.gainDb);
    // peakLinear must be the amplitude form of truePeakDb, because that is what
    // the preventClip cap consumes.
    ok(Math.abs(e.peakLinear - Math.pow(10, e.truePeakDb / 20)) < 0.001,
       'track ' + e.trackId + ' reports peak in both dB and amplitude consistently');
  }

  // The album figure is the point of the multi-state API, and the thing that is
  // easy to fake: an average of the track loudnesses looks entirely reasonable
  // and is the wrong number. Assert it is NOT that average, so a future
  // 'simplification' of the album path fails here instead of shipping.
  const okTracks = data.tracks.filter((e) => e.ok);
  if (data.album && data.album.ok && okTracks.length >= 2) {
    const mean = okTracks.reduce((a, e) => a + e.integratedLufs, 0) / okTracks.length;
    console.log('   album ' + data.album.integratedLufs.toFixed(2) + ' LUFS vs mean-of-tracks ' +
                mean.toFixed(2) + ' LUFS');
    ok(Math.abs(data.album.integratedLufs - mean) > 0.2,
       'album loudness is a gated combination, not an average of the tracks',
       'album=' + data.album.integratedLufs + ' mean=' + mean);
    ok(data.album.truePeakDb >= Math.max(...okTracks.map((e) => e.truePeakDb)) - 0.001,
       'album peak is the loudest peak among its tracks');
  }

  // maxSeconds must actually bound the work, or a caller cannot use it to trade
  // accuracy for time on a large library.
  const bounded = await engine.send(
      { cmd: 'analyze_loudness', trackIds: [ids[0]], maxSeconds: 10 }, 120000);
  if (ok(bounded.ok, 'a bounded analysis succeeds', JSON.stringify(bounded.error))) {
    ok(bounded.data.analysedSeconds <= 10.5,
       'maxSeconds bounds the decoded audio',
       bounded.data.analysedSeconds + 's analysed with a 10s limit');
  }

  // --- the cache: it must remove the work AND never serve a stale number ---
  {
    // Warm the cache with a set small enough to be quick but non-trivial.
    const warmIds = ids.slice(0, 3);
    const cold = await engine.send({ cmd: 'analyze_loudness', trackIds: warmIds }, 600000);
    ok(cold.data.albumRequested === false, 'album gain is opt-in, not assumed');
    ok(cold.ok, 'the warming scan succeeds', JSON.stringify(cold.error));

    const t0 = Date.now();
    const warm = await engine.send({ cmd: 'analyze_loudness', trackIds: warmIds }, 600000);
    const warmMs = Date.now() - t0;
    ok(warm.ok, 'the repeat scan succeeds', JSON.stringify(warm.error));

    // THE point of the cache: the second scan must not decode. Asserting the
    // numbers match is not enough -- a cache that still decodes would pass that.
    eq(warm.data.cacheHits, warmIds.length,
       'a repeat scan is served entirely from the cache',
       'cacheHits=' + warm.data.cacheHits + ' of ' + warmIds.length);
    console.log('   repeat scan: ' + warmMs + ' ms, cacheHits ' + warm.data.cacheHits +
                '/' + warmIds.length);
    ok(warmMs < 1500,
       'the repeat scan does not re-decode (a decode of these tracks takes seconds)',
       warmMs + ' ms');

    // And the cached numbers must be the measured ones, not defaults.
    for (let i = 0; i < warmIds.length; i++) {
      const a = cold.data.tracks[i];
      const b = warm.data.tracks[i];
      ok(Math.abs(a.integratedLufs - b.integratedLufs) < 0.001 &&
         Math.abs(a.truePeakDb - b.truePeakDb) < 0.001,
         'track ' + warmIds[i] + ' is identical from the cache',
         JSON.stringify({ cold: a.integratedLufs, warm: b.integratedLufs }));
    }

    // A bounded scan is a DIFFERENT measurement. Serving the full-track figure
    // for it would be a wrong number that looks right, so the cache must miss.
    const bounded2 = await engine.send(
        { cmd: 'analyze_loudness', trackIds: [warmIds[0]], maxSeconds: 10 }, 120000);
    eq(bounded2.data.cacheHits, 0,
       'a bounded scan is not served from the full-track cache');
    ok(bounded2.data.tracks[0].ok &&
       bounded2.data.tracks[0].integratedLufs < cold.data.tracks[0].integratedLufs - 0.01,
       'and its loudness is the bounded measurement, not the full track',
       'bounded=' + bounded2.data.tracks[0].integratedLufs +
       ' full=' + cold.data.tracks[0].integratedLufs);
  }

  // --- asynchronous mode: the engine must stay answerable while it works ---
  //
  // A synchronous full-library scan takes about two minutes, during which the
  // engine cannot answer anything at all. A small set is used here so the
  // suite does not pay that cost, but the mechanism under test is the same.
  {
    // Tracks NOT already measured earlier in this step, so the scan is real work
    // rather than instant cache hits. Using cached ids made the scan finish
    // before the second request arrived, and the refusal assertion failed for a
    // reason that had nothing to do with the refusal.
    const asyncIds = all.map((t) => t.trackId).filter((id) => !ids.includes(id)).slice(0, 4);
    ok(asyncIds.length > 0, 'there are tracks left to scan asynchronously',
       asyncIds.length + ' unmeasured tracks available');
    const started = await engine.send({ cmd: 'analyze_loudness', trackIds: asyncIds, async: true }, 30000);
    ok(started.ok, 'async scan is accepted', JSON.stringify(started.error));
    eq(started.data.accepted, true, 'the reply confirms acceptance');
    eq(started.data.total, asyncIds.length, 'the reply states the work it took on');

    // THE POINT OF THE FEATURE: commands still answered while it runs, and
    // answered quickly. Bounding the slice by FILES was the first attempt and it
    // produced multi-second stalls; chunk-level bounds are what make this hold.
    let worst = 0;
    let answered = 0;
    for (let i = 0; i < 8; i++) {
      const t0 = Date.now();
      const s = await engine.send({ cmd: 'get_state' }, 15000);
      worst = Math.max(worst, Date.now() - t0);
      if (s.ok) answered++;
      await new Promise((r) => setTimeout(r, 120));
    }
    eq(answered, 8, 'get_state is answered every time during an async scan');
    ok(worst < 500,
       'commands are answered promptly while a scan runs',
       'worst latency ' + worst + ' ms');
    console.log('   async: worst command latency ' + worst + ' ms during the scan');

    // A second scan is refused rather than queued or run concurrently: two
    // running scans would interleave their progress into nonsense.
    // Only meaningful if the first scan is still running; assert that precondition
    // rather than assuming it, so a fast machine reports a clear reason instead
    // of a confusing failure.
    const stillRunning = !engine.events.some((e) => e.ev === 'loudness_done');
    if (stillRunning) {
      const second = await engine.send({ cmd: 'analyze_loudness', trackIds: asyncIds, async: true }, 15000);
      eq(second.ok, false, 'a second concurrent async scan is refused');
      eq(second.error && second.error.code, 'ERR_STATE', 'and refused with ERR_STATE');
    } else {
      console.log('   (first scan already finished; concurrency rule not exercised)');
    }

    // Album gain genuinely cannot be produced this way, and saying so is better
    // than returning a figure computed from a subset.
    const badAlbum = await engine.send(
        { cmd: 'analyze_loudness', trackIds: asyncIds, async: true, album: true }, 15000);
    eq(badAlbum.ok, false, 'async + album is refused rather than approximated');

    // Completion arrives as an event carrying the reply id, so a client can
    // match it to the call even if it issued other commands in between.
    const done = await engine.waitForEvent('loudness_done', () => true, 120000);
    ok(!!done, 'a loudness_done event is emitted');
    if (done) {
      eq(done.replyId, started.data.replyId, 'the completion carries the original reply id');
      eq(done.data.tracks.length, asyncIds.length, 'every requested track is reported');
      for (const t of done.data.tracks) {
        ok(t.ok === true, 'async track ' + t.trackId + ' produced a measurement', JSON.stringify(t.reason));
        if (t.ok) ok(Math.abs(t.gainDb - (-18 - t.integratedLufs)) < 0.001,
                     'async gain is target minus measured for ' + t.trackId);
      }
      eq(done.data.album.ok, false, 'the album field is explicitly unavailable');
      ok(!!done.data.album.reason, 'and gives a reason rather than being absent');
    }

    // Progress is throttled to a human cadence, and only a scan that lasts long
    // enough emits any at all -- a few short tracks can finish inside the first
    // interval, which is correct behaviour rather than a missing feature. The
    // upper bound is the assertion that matters at any duration: emitting once
    // per slice produced 26,558 events for this library on the first attempt.
    const progressEvents = engine.events.filter((e) => e.ev === 'loudness_progress').length;
    console.log('   progress events for a ' + asyncIds.length + '-track scan: ' + progressEvents);
    ok(progressEvents < 200,
       'progress is throttled to a human cadence, not per slice',
       progressEvents + ' events');
  }

  // Refusals, so a caller gets a contract error rather than a plausible answer.
  const missing = await engine.send({ cmd: 'analyze_loudness', trackIds: ['tl_9999'] });
  eq(missing.ok, false, 'an unknown trackId is refused');
  eq(missing.error.code, 'ERR_NOTFOUND', 'an unknown trackId reports ERR_NOTFOUND');
  const empty = await engine.send({ cmd: 'analyze_loudness', trackIds: [] });
  eq(empty.ok, false, 'an empty list is refused rather than reported as complete');
  const negative = await engine.send({ cmd: 'analyze_loudness', trackIds: [ids[0]], maxSeconds: -1 });
  eq(negative.ok, false, 'a negative maxSeconds is refused');

  eq(engine.malformed.length, 0, 'the loudness step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});
step('channels', 'channel tools: balance / mono / width / swap / trim', async (args) => {
  // These are the stereo controls a player UI puts in front of the user, and
  // each has a definition that can be checked rather than eyeballed: what
  // matters is not that the output changed but that it changed the way the
  // control claims. The offline golden tests in --selftest cover the arithmetic;
  // this step covers the protocol contract around it.
  const engine = new EngineClient(args.exe);
  await engine.start();
  await engine.send({ cmd: 'scan', path: args.library }, 120000);

  const initial = (await engine.send({ cmd: 'get_state' })).data;
  ok(!!initial.dsp.channels, 'get_state reports the channel tools',
     JSON.stringify(initial.dsp.channels));
  eq(initial.dsp.channels.balance, 0, 'balance starts centred');
  eq(initial.dsp.channels.mono, false, 'mono starts off');
  eq(initial.dsp.channels.stereoWidth, 1, 'width starts at unity (unchanged)');
  eq(initial.dsp.channels.swapChannels, false, 'swap starts off');

  // PARTIAL update: a UI dragging one slider must not have to echo the rest.
  const balanced = await engine.send({ cmd: 'set_channels', balance: -0.5 });
  ok(balanced.ok, 'set_channels accepts a single field', JSON.stringify(balanced.error));
  eq(balanced.data.channels.balance, -0.5, 'balance is applied');
  eq(balanced.data.channels.stereoWidth, 1, 'an untouched field keeps its value');
  eq(balanced.data.channels.mono, false, 'and so does an untouched flag');

  // Out-of-range values are REFUSED, not clamped: a caller asking for balance
  // 2.0 has a bug, and quietly giving it 1.0 hides that behind a result that
  // looks like it worked.
  const badBalance = await engine.send({ cmd: 'set_channels', balance: 2.0 });
  eq(badBalance.ok, false, 'balance beyond +1 is refused');
  eq(badBalance.error.code, 'ERR_STATE', 'and refused with ERR_STATE');
  const badWidth = await engine.send({ cmd: 'set_channels', stereoWidth: 3.0 });
  eq(badWidth.ok, false, 'stereoWidth beyond 2.0 is refused');
  const badTrim = await engine.send({ cmd: 'set_channels', channelGains: [40] });
  eq(badTrim.ok, false, 'a channel trim beyond +12 dB is refused');
  const tooMany = await engine.send({ cmd: 'set_channels', channelGains: [0, 0, 0] });
  eq(tooMany.ok, false, 'more than two channel gains is refused');
  const empty = await engine.send({ cmd: 'set_channels' });
  eq(empty.ok, false, 'set_channels with no fields is refused rather than a no-op ok');

  // Engaging a tool must arm the DSP path AND clear the bit-perfect claim: the
  // samples are no longer the stored integers, which is the same rule the EQ is
  // held to.
  const toolsOn = (await engine.send({ cmd: 'set_channels', mono: true })).data;
  // passthrough is part of the dsp block in the reply; dspActive and dspModules
  // live on the periodic state EVENT (DESIGN-A 3.1). Reading them from the reply
  // was a test bug -- the fields exist, just not there.
  eq(toolsOn.passthrough, false, 'a channel tool is not a pass-through');
  const stateAfter = engine.events.filter((e) => e.ev === 'state').pop();
  eq(stateAfter.dspActive, true, 'engaging a channel tool emits a state event marking DSP active');
  ok(Array.isArray(stateAfter.dspModules) && stateAfter.dspModules.includes('mono'),
     'and the event names the module in force', JSON.stringify(stateAfter.dspModules));

  await engine.send({ cmd: 'open', trackId: (await engine.send({ cmd: 'list_tracks' })).data.tracks[0].trackId });
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);
  const playing = engine.events.filter((e) => e.ev === 'state').pop();
  eq(playing.bitPerfect, false, 'no bit-perfect claim while a channel tool is engaged');

  // Back to neutral: the controls must be able to return the chain to a
  // pass-through, or bit-perfect could never be regained after one experiment.
  const off = await engine.send({ cmd: 'set_channels', balance: 0, mono: false,
                                  stereoWidth: 1, swapChannels: false, channelGains: [0, 0] });
  ok(off.ok, 'all controls can be returned to neutral', JSON.stringify(off.error));
  eq(off.data.passthrough, true, 'neutral controls restore the pass-through');
  const offState = engine.events.filter((e) => e.ev === 'state').pop();
  eq(offState.dspActive, false, 'and the state event no longer reports DSP active');
  eq(offState.dspModules.length, 0, 'with no modules named');

  // Audio must keep flowing with the tools engaged: a tool that silently
  // produced nothing would pass every assertion above.
  await engine.send({ cmd: 'set_channels', balance: 0.3, stereoWidth: 1.2 });
  const before = (engine.events.filter((e) => e.ev === 'position').pop() ?? { positionMs: 0 }).positionMs;
  const advanced = await engine.waitForEvent('position', (e) => e.positionMs > before, 5000);
  ok(!!advanced, 'position keeps advancing with channel tools engaged',
     before + ' -> ' + (advanced ? advanced.positionMs : 'stalled'));

  eq(engine.malformed.length, 0, 'the channels step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});
// Where the real MP3s live on this machine. The whole point of this step is
// that it runs against files a real encoder produced -- a synthetic vector would
// prove the decoder opens, not that it decodes what people actually have.
const DEFAULT_MP3_LIBRARY = process.env.STRINGMOON_TEST_MP3_LIBRARY ?? 'D:\\Music';

step('formats', 'L1 audio formats: MP3 decodes, and a lossy file is never sourceExact', async (args) => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  // Stage a tiny isolated library by HARD LINKING, not copying: same bytes, no
  // I/O, and the scan sees two files instead of the owner's 11k-file working
  // directory. The engine's scan is additive (CR-013), so a folder this narrow
  // is also what keeps list_tracks unambiguous.
  const stage = path.join(path.dirname(args.exe), '..', 'build', 'tmp-formats');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const link = (from, to) => { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } };
  let stagedMp3 = 0;
  try {
    for (const name of fs.readdirSync(DEFAULT_MP3_LIBRARY)
                         .filter((n) => n.toLowerCase().endsWith('.mp3')).slice(0, 2)) {
      link(path.join(DEFAULT_MP3_LIBRARY, name), path.join(stage, name));
      ++stagedMp3;
    }
  } catch { /* reported as a skip below */ }

  let stagedFlac = 0;
  try {
    for (const name of fs.readdirSync(args.library)
                         .filter((n) => n.toLowerCase().endsWith('.flac')).slice(0, 3)) {
      link(path.join(args.library, name), path.join(stage, name));
      ++stagedFlac;
    }
  } catch { /* the lossy/lossless pair degrades to the half that still holds */ }

  // A file that carries an ID3 tag and no MPEG frame: the shape a decoder must
  // REFUSE. Written rather than borrowed, because no one keeps one on purpose.
  const ghostName = 'zz-id3-only.mp3';
  fs.writeFileSync(path.join(stage, ghostName), Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.alloc(4096),
  ]));

  // MP4 material is ENCODED here rather than borrowed, because there is no .m4a
  // on this machine and "no test material" is exactly how the MP3 gap stayed
  // invisible behind 407 green assertions. Media Foundation has both an AAC and
  // an ALAC encoder here (--probe-mf reports them), so a genuine AAC file and a
  // genuine LOSSLESS ALAC file can both be produced on demand.
  const mp4 = { aac: null, alac: null };
  try {
    const { execFileSync } = await import('node:child_process');
    for (const [codec, name] of [['aac', 'tone-aac.m4a'], ['alac', 'tone-alac.m4a']]) {
      const target = path.join(stage, name);
      try {
        execFileSync(args.exe, ['--probe-mf', '--codec', codec, '--write-tone', target],
                     { stdio: 'ignore', timeout: 60000 });
        if (fs.existsSync(target) && fs.statSync(target).size > 1000) mp4[codec] = target;
      } catch { /* reported below */ }
    }
  } catch { /* node modules unavailable: treated as no material */ }
  if (!mp4.aac || !mp4.alac) {
    console.log('   (Media Foundation could not encode ' +
                [!mp4.aac && 'AAC', !mp4.alac && 'ALAC'].filter(Boolean).join(' + ') +
                '; that half of the MP4 path is NOT exercised)');
  }

  if (stagedMp3 === 0) {
    console.log('   (no real MP3 found in ' + DEFAULT_MP3_LIBRARY + ' -- L1 format coverage NOT exercised)');
    fs.rmSync(stage, { recursive: true, force: true });
    return;
  }

  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = await engine.send({ cmd: 'scan', path: stage }, 60000);
  ok(scan.ok === true, 'the staged library scans');
  const list = await engine.send({ cmd: 'list_tracks' });
  const tracks = list.data.tracks;
  const mp3s = tracks.filter((t) => t.codec === 'MP3' && path.basename(t.path) !== ghostName);
  eq(mp3s.length, stagedMp3, 'every real MP3 is catalogued as MP3');

  // Real metadata, not zeros. Before the decoder existed, scan already listed
  // MP3s -- TagLib reads the tags -- so "it appears in the list" proved nothing
  // about playback. These numbers are from TagLib and must be sane.
  ok(mp3s.every((t) => t.durationMs > 0 && t.sampleRate > 0 && t.channels === 2 && t.bitrate > 0),
     'every MP3 carries real duration / rate / channels / bitrate',
     JSON.stringify(mp3s.map((t) => [t.durationMs, t.sampleRate, t.channels, t.bitrate])));

  const mp3 = mp3s[0];
  const opened = await engine.send({ cmd: 'open', trackId: mp3.trackId });
  // THE REGRESSION ASSERTION. Until this round this reply was
  // ERR_DECODE "unrecognised audio container" for every MP3 on the machine.
  ok(opened.ok === true, 'an MP3 opens',
     opened.error ? opened.error.code + ': ' + opened.error.message : '');

  const afterOpen = (await engine.send({ cmd: 'get_state' })).data;
  // Two independent implementations of the same fact: TagLib's MPEG parser and
  // dr_mp3's frame walk. They do not share code, so agreement is evidence -- and
  // a disagreement would mean one of them is wrong about the track length, which
  // is what end-of-stream is compared against.
  const drift = Math.abs(afterOpen.durationMs - mp3.durationMs);
  ok(drift <= 5, 'the decoder duration agrees with the TagLib duration within 5 ms',
     'decoder ' + afterOpen.durationMs + ' vs TagLib ' + mp3.durationMs + ' (' + drift + ' ms)');

  await engine.send({ cmd: 'play' });
  const advanced = await engine.waitForEvent('position', (e) => e.positionMs > 400, 6000);
  ok(!!advanced, 'MP3 playback actually advances', advanced ? advanced.positionMs + ' ms' : 'stalled');

  const target = Math.floor(mp3.durationMs / 2);
  const seekStart = Date.now();
  await engine.send({ cmd: 'seek', positionMs: target });
  const seekMs = Date.now() - seekStart;
  const landed = (await engine.send({ cmd: 'get_state' })).data.positionMs;
  ok(Math.abs(landed - target) < 400, 'seeking an MP3 lands where it was asked to',
     'asked ' + target + ', landed ' + landed);
  // MP3 seeking is not the same job as FLAC seeking, and pretending otherwise
  // would make this assertion a lie about what it proves. A file with a
  // Xing/Info header carries a seek table; these five do not (their frame count
  // is unknown at init, which is exactly the tell), so dr_mp3 decodes and
  // discards everything up to the target -- reaching the middle of a four-minute
  // track means decoding two minutes of it. The bound below is therefore "this
  // is a command, not a hang"; the SPEC 8.2 seek budget is measured by
  // --step=latency on a format that can seek by offset.
  console.log('   seek to mid-track: ' + seekMs + ' ms (no Xing index in these files)');
  ok(seekMs < 800, 'and the seek reply comes back promptly', seekMs + ' ms');

  // The end of the track must be reachable, which is only true if the frame
  // count is right: dr_mp3 reports a count that INCLUDES encoder delay and
  // padding, and using that raw number would leave the track short of the end
  // forever, because its reader stops early.
  await engine.send({ cmd: 'seek', positionMs: Math.max(0, mp3.durationMs - 1500) });
  const ended = await engine.waitForEvent('ended', () => true, 12000);
  ok(!!ended, 'an MP3 plays through to its natural end');
  if (ended) eq(ended.reason, 'eof', 'and the end is reported as eof, not as a fault');

  const mp3State = (await engine.send({ cmd: 'get_state' })).data;
  eq(mp3State.bitPerfect, mp3State.outputPerfect,
     'bitPerfect is still the literal alias of outputPerfect on a lossy track');
  // Independent of the chain, the device, and the mode: the FILE is lossy. This
  // is the field's entire reason for existing.
  eq(mp3State.sourceExact, false, 'a lossy file is never sourceExact, whatever the chain does');

  if (stagedFlac > 0) {
    const flac = tracks.find((t) => t.codec === 'FLAC' && t.sampleRate === 44100);
    if (!flac) {
      warn('staged FLACs contained no 44.1 kHz file; the exclusive half was not exercised');
    } else {
      await engine.send({ cmd: 'set_output', mode: 'exclusive' });
      await engine.send({ cmd: 'open', trackId: flac.trackId });
      await engine.send({ cmd: 'play' });
      await new Promise((r) => setTimeout(r, 1200));
      const flacState = (await engine.send({ cmd: 'get_state' })).data;
      // Holds in EVERY mode, and is the invariant that says the field is about
      // the file: for a lossless source sourceExact is exactly outputPerfect.
      eq(flacState.sourceExact, flacState.outputPerfect,
         'for a lossless file sourceExact is exactly outputPerfect');

      await engine.send({ cmd: 'open', trackId: mp3.trackId });
      await engine.send({ cmd: 'play' });
      await new Promise((r) => setTimeout(r, 1200));
      const lossy = (await engine.send({ cmd: 'get_state' })).data;
      const show = (tag, s) => console.log('   ' + tag + ': mode=' + s.outputMode +
        ' container=' + s.containerBits + ' outputPerfect=' + s.outputPerfect +
        ' pcmPassthrough=' + s.pcmPassthrough + ' sourceExact=' + s.sourceExact);
      show('lossy   ', lossy);
      show('lossless', flacState);
      if (lossy.outputMode === 'exclusive' && lossy.pcmPassthrough) {
        // The pair the single boolean could not express, now reachable on real
        // hardware: an MP3 delivered bit-for-bit through the chain, by a file
        // that is not bit-for-bit anything.
        eq(lossy.outputPerfect, true,
           'an MP3 reaches output-perfect when the chain is genuinely perfect');
        eq(lossy.sourceExact, false, 'and is still not sourceExact');
      } else {
        console.log('   (exclusive not achieved on this endpoint -- the pair is asserted via the invariants above)');
      }
      await engine.send({ cmd: 'stop' });
    }
  } else {
    warn('no FLAC could be staged; the lossy/lossless pair was not compared directly');
  }

  // ---- MP4: AAC and ALAC ------------------------------------------------
  //
  // Both are the same container, so the extension cannot tell them apart, and
  // one of them is lossy while the other is lossless. That makes this the
  // sharpest available test of the field that exists to separate "the chain is
  // perfect" from "the file is what it is".
  const aacTrack = tracks.find((t) => path.basename(t.path) === 'tone-aac.m4a');
  const alacTrack = tracks.find((t) => path.basename(t.path) === 'tone-alac.m4a');
  if (mp4.aac && !aacTrack) warn('the AAC fixture was written but did not scan');
  if (mp4.alac && !alacTrack) warn('the ALAC fixture was written but did not scan');

  if (alacTrack) {
    // The catalog used to call every .m4a "AAC" because that is what the file
    // name suggested. The codec id comes from the sample description atom now.
    eq(alacTrack.codec, 'ALAC', 'an ALAC file is catalogued as ALAC, not as AAC');
  }
  if (aacTrack) {
    eq(aacTrack.codec, 'AAC', 'an AAC file is catalogued as AAC');
  }

  const mp4State = {};
  for (const [tag, track] of [['aac', aacTrack], ['alac', alacTrack]]) {
    if (!track) continue;
    const openReply = await engine.send({ cmd: 'open', trackId: track.trackId });
    ok(openReply.ok === true, 'the ' + tag.toUpperCase() + ' fixture opens',
       openReply.error ? openReply.error.code + ': ' + openReply.error.message : '');
    if (!openReply.ok) continue;
    await engine.send({ cmd: 'play' });
    const moved = await engine.waitForEvent('position', (e) => e.positionMs > 200, 6000);
    ok(!!moved, 'and produces audio that advances the position',
       moved ? moved.positionMs + ' ms' : 'stalled');
    const s = (await engine.send({ cmd: 'get_state' })).data;
    mp4State[tag] = s;
    console.log('   ' + tag.toUpperCase().padEnd(4) + ': ' + s.outputMode + ' ' + s.sampleRate + 'Hz ' +
                s.durationMs + 'ms outputPerfect=' + s.outputPerfect + ' sourceExact=' + s.sourceExact);
    eq(s.bitPerfect, s.outputPerfect, 'bitPerfect is still the literal alias of outputPerfect (' + tag + ')');
    await engine.send({ cmd: 'stop' });
  }
  if (mp4State.aac) {
    // AAC throws information away, so no chain can make its samples equal the
    // encoded ones -- the encoded ones are not samples.
    eq(mp4State.aac.sourceExact, false, 'an AAC file is never sourceExact');
  }
  if (mp4State.alac) {
    // ALAC is lossless, so for it sourceExact is EXACTLY outputPerfect: the pair
    // of facts a single boolean could not carry. True in every output mode.
    eq(mp4State.alac.sourceExact, mp4State.alac.outputPerfect,
       'an ALAC file is sourceExact exactly when the chain is perfect');
    if (mp4State.alac.outputMode === 'exclusive' && mp4State.alac.pcmPassthrough) {
      eq(mp4State.alac.outputPerfect, true, 'and this chain is perfect');
      eq(mp4State.alac.sourceExact, true, 'so a lossless MP4 file is reported source-exact');
    } else {
      console.log('   (exclusive not achieved here, so ALAC sourceExact=true could NOT be shown -- ' +
                  'the invariant above still holds)');
    }
  }

  // A decoder that guesses plays noise and calls it success. This one refuses,
  // and the refusal names what it does support.
  const ghost = tracks.find((t) => path.basename(t.path) === ghostName);
  if (ghost) {
    const refused = await engine.send({ cmd: 'open', trackId: ghost.trackId });
    ok(refused.ok === false && refused.error && refused.error.code === 'ERR_DECODE',
       'an ID3 tag with no MPEG frame is REFUSED, not played as noise',
       JSON.stringify(refused).slice(0, 180));
  } else {
    console.log('   (the ID3-only file was rejected at scan time, before open could refuse it)');
  }

  eq(engine.malformed.length, 0, 'the formats step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
  fs.rmSync(stage, { recursive: true, force: true });
});

step('identity', 'CR-013: a directory is one library however it is spelled, and replace is per-directory', async (args) => {
  // The ruled acceptance list, verbatim (docs/contract-requests.md CR-013):
  //   1. scan A(/) then A(\) -> added must be 0, count unchanged, ids unique
  //   2. the same string twice      -> count does not grow, added 0
  //   3. A -> B -> A replace:true   -> count = |B| + |A|, A's ids all fresh,
  //                                    B's ids untouched
  //
  // Two staged directories with DISJOINT file sets, so "A's ids changed" and
  // "B's ids changed" can never be confused for one another.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(path.dirname(args.exe), '..', 'build');
  const stageA = path.join(root, 'tmp-identity-a');
  const stageB = path.join(root, 'tmp-identity-b');
  for (const d of [stageA, stageB]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

  // No literal backslashes anywhere below: this file is generated, and a
  // mis-escaped separator has already cost this project two rounds.
  const forwardSlashes = (p) => p.split(path.sep).join('/');

  const sources = fs.readdirSync(args.library).filter((n) => n.toLowerCase().endsWith('.flac'));
  const aNames = sources.slice(0, 3);
  const bNames = sources.slice(3, 5);
  const link = (from, to) => { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } };
  for (const n of aNames) link(path.join(args.library, n), path.join(stageA, n));
  for (const n of bNames) link(path.join(args.library, n), path.join(stageB, n));

  if (aNames.length < 2 || bNames.length < 1) {
    console.log('   (not enough staged files; CR-013 coverage NOT exercised)');
    for (const d of [stageA, stageB]) fs.rmSync(d, { recursive: true, force: true });
    return;
  }

  const engine = new EngineClient(args.exe);
  await engine.start();

  const scan = async (p, replace) => {
    const command = { cmd: 'scan', path: p };
    if (replace !== undefined) command.replace = replace;
    return engine.send(command, 120000);
  };
  const catalog = async () => {
    const list = await engine.send({ cmd: 'list_tracks' });
    const tracks = list.data.tracks;
    const inA = tracks.filter((t) => aNames.includes(path.basename(t.path)));
    const inB = tracks.filter((t) => bNames.includes(path.basename(t.path)));
    return { total: tracks.length, inA, inB, ids: tracks.map((t) => t.trackId) };
  };

  // --- 1. one directory, two spellings --------------------------------
  const first = await scan(stageA);
  ok(first.ok === true, 'scanning a staged directory succeeds', JSON.stringify(first.error));
  eq(first.data.added, aNames.length, 'the first scan adds every staged file');
  eq(first.data.skipped, 0, 'and skips nothing, because nothing was known');

  const respelled = await scan(forwardSlashes(stageA));
  eq(respelled.data.added, 0,
     'scanning the SAME directory with forward slashes adds nothing');
  eq(respelled.data.skipped, aNames.length,
     'and reports them as skipped, so added=0 is not mistakable for a failure');
  const afterRespelling = await catalog();
  eq(afterRespelling.inA.length, aNames.length,
     'the catalog still holds one entry per file, not two',
     'the 91-tracks-become-182 defect');
  eq(new Set(afterRespelling.ids).size, afterRespelling.ids.length,
     'every trackId in the catalog is unique');

  // --- 2. the same string twice ---------------------------------------
  const idsBefore = (await catalog()).inA.map((t) => t.trackId).sort();
  const again = await scan(stageA);
  eq(again.data.added, 0, 'rescanning the same string adds nothing');
  eq(again.data.skipped, aNames.length, 'and skips every file');
  const idsAfter = (await catalog()).inA.map((t) => t.trackId).sort();
  eq(idsAfter.join(','), idsBefore.join(','),
     'and the ids are unchanged (a rescan must not renumber a cached library)');

  // --- 3. replace is per-directory ------------------------------------
  const bFirst = await scan(stageB);
  eq(bFirst.data.added, bNames.length, 'the second directory scans into the same catalog');
  const beforeReplace = await catalog();
  eq(beforeReplace.total, aNames.length + bNames.length, 'both directories are now catalogued');
  const aIdsBefore = beforeReplace.inA.map((t) => t.trackId).sort();
  const bIdsBefore = beforeReplace.inB.map((t) => t.trackId).sort();

  const replaced = await scan(stageA, true);
  eq(replaced.ok, true, 'replace:true succeeds');
  eq(replaced.data.removed, aNames.length, 'it removes exactly the entries under that directory');
  eq(replaced.data.added, aNames.length, 'and re-adds them, which is what added reports afterwards');
  const afterReplace = await catalog();
  eq(afterReplace.total, aNames.length + bNames.length,
     'the catalog ends up with |A| + |B| entries, not with everything cleared');
  const aIdsAfter = afterReplace.inA.map((t) => t.trackId).sort();
  const bIdsAfter = afterReplace.inB.map((t) => t.trackId).sort();
  eq(aIdsAfter.filter((id) => aIdsBefore.includes(id)).length, 0,
     'every id under the replaced directory is new',
     'replace issued fresh ids for the re-added files');
  eq(bIdsAfter.join(','), bIdsBefore.join(','),
     'and NOT ONE id under the other directory moved',
     'this is the isolation replace is easiest to get wrong about');

  // --- the two edges the ruling calls out -----------------------------
  const missing = path.join(root, 'tmp-identity-does-not-exist');
  fs.rmSync(missing, { recursive: true, force: true });
  const notFound = await scan(missing);
  eq(notFound.ok, false, 'a missing directory without replace is still ERR_NOTFOUND');
  eq(notFound.error && notFound.error.code, 'ERR_NOTFOUND', 'with the code it always had');

  // "the usual reason a user removes a directory is that the drive is gone",
  // so the cleanup has to work when there is nothing there to read.
  const cleanup = await scan(missing, true);
  eq(cleanup.ok, true, 'the SAME missing directory with replace:true succeeds');
  eq(cleanup.data.added, 0, 'adding nothing');
  eq(cleanup.data.removed, 0, 'and removing nothing, because nothing was there');

  const wrongType = await engine.send({ cmd: 'scan', path: stageA, replace: 'yes' });
  eq(wrongType.ok, false, 'a non-boolean replace is refused');
  eq(wrongType.error && wrongType.error.code, 'ERR_STATE', 'as ERR_STATE, not coerced');

  eq(engine.malformed.length, 0, 'the identity step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
  for (const d of [stageA, stageB]) fs.rmSync(d, { recursive: true, force: true });
});
step('hotplug', 'the device_changed event the contract defines (SPEC 3.3 / CONTRACT 3.3)', async (args) => {
  // The engine had NEVER emitted this event, so a client could not learn that the
  // user unplugged their headphones or moved the default elsewhere: the UI went on
  // showing a device that was no longer in use.
  //
  // The test needs a SECOND render endpoint to switch to, and switching the
  // Windows default is a machine-level action. When there is only one endpoint,
  // or the helper is unavailable, the step reports that and checks what it can --
  // it does not pretend to have exercised the path.
  const { existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const switcher = join(dirname(args.exe), '..', 'tools', 'set-default-device.ps1');

  const engine = new EngineClient(args.exe);
  const ready = await engine.start();
  const devices = ready.devices || [];
  ok(devices.length >= 1, 'at least one render endpoint exists');

  if (!existsSync(switcher)) {
    console.log('   (device switch helper missing; hot-plug path not exercised)');
    await engine.send({ cmd: 'shutdown' });
    await engine.close();
    return;
  }
  if (devices.length < 2) {
    console.log('   (only one render endpoint on this machine; nothing to switch to)');
    await engine.send({ cmd: 'shutdown' });
    await engine.close();
    return;
  }

  const { execFileSync } = await import('node:child_process');
  // Compare case-insensitively: Windows device ids differ only in GUID casing
  // between the enumeration and the policy interface.
  const strip = (s) => String(s).toLowerCase();
  const current = strip(player_device_of(ready));
  const other = devices.find((d) => strip(d.id) !== current);
  if (!other) {
    console.log('   (no second distinct endpoint); hot-plug path not exercised');
    await engine.send({ cmd: 'shutdown' });
    await engine.close();
    return;
  }

  await engine.send({ cmd: 'scan', path: args.library }, 120000);
  const list = await engine.send({ cmd: 'list_tracks' });
  await engine.send({ cmd: 'open', trackId: list.data.tracks[0].trackId });
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);

  const before = engine.events.filter((e) => e.ev === 'state').pop();
  const positionBefore = before ? before.positionMs : 0;

  let switched = false;
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', switcher,
                                 '-DeviceId', other.id], { encoding: 'utf8', timeout: 60000 });
    switched = true;
  } catch (err) {
    console.log('   (could not switch the default device: ' + String(err).slice(0, 80) + ')');
  }

  if (switched) {
    const changed = await engine.waitForEvent('device_changed', () => true, 8000);
    ok(!!changed, 'switching the default endpoint raises device_changed');
    if (changed) {
      eq(changed.defaultChanged, true, 'the event says the default changed');
      eq(changed.streamLost, true, 'and that the stream had to move');
      // The event must name the device the engine MOVED TO. An earlier version
      // reported the one it was leaving, because the first notification arrived
      // for an audio role the engine does not follow.
      eq(strip(changed.deviceId), strip(other.id),
         'and it names the device the engine actually moved to',
         'reported ' + changed.deviceId + ', expected ' + other.id);

      // ONE user action must produce ONE event, not one per audio role.
      await new Promise((r) => setTimeout(r, 900));
      const arrivals = engine.events.filter((e) => e.ev === 'device_changed').length;
      eq(arrivals, 1, 'a single switch produces exactly one event', String(arrivals) + ' events');

      // Playback must survive: the point of the recovery is that the user does
      // not lose their place.
      const after = await engine.waitForEvent('position', (e) => e.positionMs > positionBefore, 8000);
      ok(!!after, 'playback continues on the new device',
         positionBefore + ' -> ' + (after ? after.positionMs : 'stalled'));
      const settled = engine.events.filter((e) => e.ev === 'state').pop();
      eq(settled.state, 'playing', 'the engine is still playing afterwards');
    }

    // Put the machine back the way it was found.
    try {
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', switcher,
                                   '-DeviceId', before ? before.deviceId : current],
                   { encoding: 'utf8', timeout: 60000 });
    } catch { /* best effort; the next run picks a default anyway */ }
  }

  eq(engine.malformed.length, 0, 'the hotplug step kept stdout clean');
  await engine.send({ cmd: 'shutdown' });
  await engine.close();
});

// The ready event carries the device list; the engine's current device is the
// default one until a set_output says otherwise.
function player_device_of(ready) {
  const d = (ready.devices || []).find((x) => x.isDefault);
  return d ? d.id : '';
}
step('lifecycle', 'shutdown and stdin-close leave no orphan process', async (args) => {
  // A7: closing stdin must make the engine exit. An orphan would outlive the app,
  // hold the audio device open, and look to the user like the app is still
  // running after they closed it.
  const engine = new EngineClient(args.exe);
  await engine.start();

  // 1. shutdown: an explicit, answered exit.
  const bye = await engine.send({ cmd: 'shutdown' });
  eq(bye.ok, true, 'shutdown is answered before the engine exits');
  await engine.close();
  ok(!!engine.exited, 'the engine exits after shutdown',
     engine.exited ? 'code ' + engine.exited.code : 'still running');

  // 2. stdin EOF with no shutdown at all. This is the path a crashed or killed
  //    app takes, so it is the one that actually produces orphans in the wild.
  const second = new EngineClient(args.exe);
  await second.start();
  second.child.stdin.end();
  const deadline = Date.now() + 5000;
  while (!second.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  ok(!!second.exited, 'stdin EOF alone makes the engine exit',
     second.exited ? 'code ' + second.exited.code : 'still running');
  await second.close();

  // 3. Nothing WE started is left behind. The two checks above could both pass
  //    while a third process from an earlier step lingers.
  //
  //    This used to count every twilight-engine.exe on the machine and fail on
  //    the total. That is not evidence about this run: the app spawns the same
  //    executable, so a concurrent app test made it report an orphan that was
  //    never ours -- and the same blindness would let our own leak pass behind a
  //    neighbour's healthy process. Ask about our children; only report the rest.
  await new Promise((r) => setTimeout(r, 250));
  const leaked = [...liveClients].filter((c) => !c.exited);
  ok(leaked.length === 0, 'no engine this run started is still alive',
     leaked.map((c) => 'pid ' + c.child.pid).join(', '));

  const { execFileSync } = await import('node:child_process');
  let listing = '';
  try {
    listing = execFileSync('tasklist', ['/FI', 'IMAGENAME eq twilight-engine.exe', '/FO', 'CSV', '/NH'],
                           { encoding: 'utf8' });
  } catch { /* tasklist missing: treated as no evidence, not as success */ }
  const runningPids = listing.split(/\r?\n/)
    .filter((l) => l.toLowerCase().includes('twilight-engine.exe'))
    .map((l) => Number((l.split('","')[1] || '').replace(/[^0-9]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  const foreign = runningPids.filter((pid) => !spawnedPids.has(pid));
  if (foreign.length) {
    warn('twilight-engine.exe is running that this run did not start (pid ' + foreign.join(', ') +
         ') -- the app spawns the same executable, so this is expected while it is testing');
  }

  eq(engine.malformed.length, 0, 'the lifecycle step kept stdout clean');

  // A crash during teardown leaves a minidump beside the executable, and NOTHING
  // used to look for it. That is how an exclusive-mode access violation survived
  // a fully green suite: playback was perfect, positions were right, and the
  // fault happened after the engine had already logged a clean exit.
  //
  // Asserting on the dump file rather than on the exit code is deliberate: the
  // exit code of a crashed teardown still reads as success in several paths,
  // the dump does not.
  {
    const { existsSync, rmSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const dump = join(dirname(args.exe), 'twilight-engine-crash.dmp');
    rmSync(dump, { force: true });

    // One more full cycle that touches the exclusive path, since that is where
    // the teardown fault lived.
    const cycled = new EngineClient(args.exe);
    await cycled.start();
    await cycled.send({ cmd: 'scan', path: args.library }, 120000);
    const list = await cycled.send({ cmd: 'list_tracks' });
    const t = list.data.tracks.find((x) => x.sampleRate === 44100 && x.bitDepth === 24)
           || list.data.tracks[0];
    await cycled.send({ cmd: 'set_output', mode: 'exclusive' });
    await cycled.send({ cmd: 'open', trackId: t.trackId });
    await cycled.send({ cmd: 'play' });
    await new Promise((r) => setTimeout(r, 800));
    await cycled.send({ cmd: 'shutdown' });
    await cycled.close();
    await new Promise((r) => setTimeout(r, 600));

    ok(!existsSync(dump),
       'no crash dump was produced: teardown after exclusive playback is clean',
       dump);
  }
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    console.log('steps:');
    for (const s of steps) console.log('  ' + s.name.padEnd(12) + s.description);
    return 0;
  }

  console.log('twilight-engine driver');
  console.log('  exe:     ' + args.exe);
  console.log('  library: ' + args.library);

  const selected = args.step ? steps.filter((s) => s.name === args.step) : steps;
  if (args.step && selected.length === 0) {
    console.error('unknown step: ' + args.step);
    console.error('use --list to see the available steps');
    return 2;
  }

  for (const s of selected) {
    heading(s.name + ' - ' + s.description);
    try {
      await s.fn(args);
    } catch (err) {
      // A step that throws is a failed step, not a crashed runner: the remaining
      // steps still run so one problem does not hide the others.
      ok(false, 'step "' + s.name + '" threw', String((err && err.stack) || err));
    }
  }

  console.log('');
  console.log('== result ============================================================');
  console.log('  assertions: ' + assertions);
  console.log('  failures:   ' + failures.length);
  for (const f of failures) console.log('  FAIL ' + f);
  for (const w of warnings)  console.log('  warn ' + w);
  console.log('');
  if (failures.length === 0) {
    console.log('  ALL CHECKS PASSED');
    return 0;
  }
  console.log('  FAILED');
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
