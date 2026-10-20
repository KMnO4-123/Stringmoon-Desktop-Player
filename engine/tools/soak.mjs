#!/usr/bin/env node
// tools/soak.mjs -- SPEC 9: "30 min of exclusive playback at the smallest buffer
// = 0 xrun". SPEC 8.2 line 418 states the same criterion as an acceptance row.
//
// WHY THIS IS NOT A drive.mjs STEP. Thirty minutes is not an assertion, it is a
// shift: a suite that takes half an hour is a suite nobody runs, and a check
// nobody runs is not a check. The rest of the suite is the fast gate; this is
// the one you invoke deliberately.
//
// WHAT IT CANNOT DO, stated here rather than discovered later: it never changes
// the buffer size. SPEC 9 says "smallest buffer", and the smallest buffer the
// engine can be ASKED for is the one it opens with -- set_output has no bufferMs
// parameter. So the soak runs at the engine's own default exclusive buffer and
// PRINTS the exact figure it measured, so that "0 xrun" always arrives attached
// to the buffer it was achieved at. A knob to force the device's 3 ms minimum
// would be a contract change, not a quiet addition.
//
// It also reads the diagnostic file SPEC 449 asks for (bin/twilight-engine-diag.log),
// so a soak produces evidence rather than a claim: the xrun history, the buffer
// history and every device change the engine saw are on disk with timestamps.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = resolve(HERE, '..');

function parseArgs(argv) {
  const args = {
    exe: join(ENGINE_DIR, 'bin', 'twilight-engine.exe'),
    library: process.env.STRINGMOON_TEST_LIBRARY ?? 'D:\\Music',
    minutes: 30,
    intervalSec: 15,
    device: null,
    // Queue ONE track instead of the whole library. The stall this soak is
    // hunting reproduces at a fixed TRACK position (~295.6 s into a specific
    // file), not at a fixed wall-clock time, so playing just that track reaches
    // it in five minutes instead of twenty-five -- and a five-minute
    // reproduction is one you can iterate against.
    trackIndex: -1,
  };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--exe=')) args.exe = raw.slice(6);
    else if (raw.startsWith('--library=')) args.library = raw.slice(10);
    else if (raw.startsWith('--minutes=')) args.minutes = Number(raw.slice(10));
    else if (raw.startsWith('--interval=')) args.intervalSec = Number(raw.slice(11));
    else if (raw.startsWith('--device=')) args.device = raw.slice(9);
    else if (raw.startsWith('--track-index=')) args.trackIndex = Number(raw.slice(14));
    else throw new Error('unknown argument: ' + raw);
  }
  return args;
}

class Engine {
  constructor(exe) {
    this.child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.buffer = '';
    this.exited = null;
    this.malformed = 0;
    this.child.stdout.on('data', (d) => {
      this.buffer += d.toString('utf8');
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { ++this.malformed; continue; }
        if (frame && typeof frame.ev === 'string') this.events.push(frame);
        else if (frame && this.pending.has(frame.id)) {
          const w = this.pending.get(frame.id);
          this.pending.delete(frame.id);
          w(frame);
        }
      }
    });
    this.child.on('exit', (code, signal) => { this.exited = { code, signal }; });
  }
  send(command, timeoutMs = 30000) {
    const id = this.nextId++;
    const started = Date.now();
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error('timeout after ' + timeoutMs + 'ms: ' + command.cmd));
      }, timeoutMs);
      this.pending.set(id, (frame) => { clearTimeout(timer); res({ frame, latencyMs: Date.now() - started }); });
      this.child.stdin.write(JSON.stringify({ id, ...command }) + '\n');
    });
  }
  waitForEvent(ev, pred, timeoutMs) {
    const hit = () => this.events.find((e) => e.ev === ev && pred(e));
    const found = hit();
    if (found) return Promise.resolve(found);
    return new Promise((res) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        const f = hit();
        if (f || Date.now() > deadline) { clearInterval(poll); res(f || null); }
      }, 50);
    });
  }
  async close() {
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const deadline = Date.now() + 5000;
    while (!this.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    if (!this.exited) this.child.kill();
  }
}

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

async function main() {
  const args = parseArgs(process.argv);
  const diagPath = join(dirname(args.exe), 'twilight-engine-diag.log');
  const diagBefore = existsSync(diagPath) ? statSync(diagPath).size : 0;

  console.log('twilight-engine soak');
  console.log('  exe      : ' + args.exe);
  console.log('  library  : ' + args.library);
  console.log('  duration : ' + args.minutes + ' min, polling every ' + args.intervalSec + 's');
  console.log('  diag log : ' + diagPath);

  const engine = new Engine(args.exe);
  // The device list arrives on the `ready` EVENT, not on a hello reply. `hello`
  // only reports the engine's own state; `ready` is the startup frame the
  // contract defines as carrying the endpoints, and reading the wrong one is
  // how this script first announced that a machine with two DACs had none.
  const ready = await engine.waitForEvent('ready', () => true, 20000);
  if (!ready) { console.error('engine never emitted ready'); process.exit(2); }
  const devices = ready.devices || [];
  let device = devices.find((d) => d.isDefault);
  if (args.device) device = devices.find((d) => d.name.includes(args.device)) || device;
  if (!device) { console.error('no render endpoint'); process.exit(2); }
  console.log('  device   : ' + device.name);

  await engine.send({ cmd: 'set_output', mode: 'exclusive', deviceId: device.id });
  const scan = (await engine.send({ cmd: 'scan', path: args.library }, 180000)).frame;
  const tracks = scan.data.tracks;
  if (!tracks.length) { console.error('no tracks; nothing to soak'); process.exit(2); }
  const queued = args.trackIndex >= 0 ? [tracks[args.trackIndex]] : tracks;
  if (args.trackIndex >= 0) {
    console.log('  queue    : ONE track -- ' + queued[0].title + '  (' + queued[0].durationMs + ' ms)');
  }
  await engine.send({ cmd: 'set_queue', trackIds: queued.map((t) => t.trackId) });
  await engine.send({ cmd: 'set_repeat', mode: 'all' });
  await engine.send({ cmd: 'open', trackId: queued[0].trackId });
  await engine.send({ cmd: 'play' });
  await engine.waitForEvent('state', (e) => e.state === 'playing', 5000);

  const first = (await engine.send({ cmd: 'get_state' })).frame.data;
  console.log('');
  console.log('  running: mode=' + first.outputMode + ' rate=' + first.sampleRate +
              ' bufferMs=' + first.bufferMs + ' tracks=' + tracks.length);
  if (first.outputMode !== 'exclusive') {
    // The premise of the soak is exclusive playback. Soaking a shared stream and
    // reporting "0 xrun" would be a true statement about the wrong thing.
    console.error('  !! not on exclusive output -- this soak would measure the wrong stream');
    console.error('     degradeReason: ' + JSON.stringify(first.degradeReason || ''));
    await engine.send({ cmd: 'shutdown' });
    await engine.close();
    process.exit(3);
  }

  const anomalies = [];
  let advances = 0;
  let playedMs = 0;
  let prevPos = first.positionMs;
  let prevTrack = first.trackId;
  let worstLatency = 0;
  let peakXruns = 0;
  let peakBufferMs = first.bufferMs;
  const started = Date.now();
  const deadline = started + args.minutes * 60 * 1000;
  let nextReport = started + 60000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
    let reply;
    try {
      reply = await engine.send({ cmd: 'get_state' }, 20000);
    } catch (err) {
      anomalies.push('get_state failed: ' + err.message);
      continue;
    }
    const d = reply.frame.data;
    worstLatency = Math.max(worstLatency, reply.latencyMs);
    if (reply.latencyMs > 500) anomalies.push('slow get_state: ' + reply.latencyMs + ' ms');
    if (d.trackId !== prevTrack) { ++advances; prevPos = 0; prevTrack = d.trackId; }
    const delta = d.positionMs - prevPos;
    if (delta > 0) playedMs += delta;
    else if (delta < 0) { ++advances; prevTrack = d.trackId; }
    prevPos = d.positionMs;
    peakXruns = Math.max(peakXruns, d.xrunCount);
    peakBufferMs = Math.max(peakBufferMs, d.bufferMs);
    if (d.outputMode !== 'exclusive') anomalies.push('left exclusive: ' + d.outputMode);
    if (d.degradeReason) anomalies.push('degraded: ' + d.degradeReason);
    if (d.state !== 'playing') anomalies.push('state became ' + d.state);
    if (engine.malformed) anomalies.push('malformed stdout lines: ' + engine.malformed);

    if (Date.now() >= nextReport) {
      nextReport += 60000;
      console.log('  ' + mmss(Date.now() - started) + '  pos=' + mmss(d.positionMs) +
                  ' played=' + mmss(playedMs) + ' advances=' + advances +
                  ' xrun=' + d.xrunCount + ' bufferMs=' + d.bufferMs);
    }
  }

  const last = (await engine.send({ cmd: 'get_state' })).frame.data;
  if (engine.malformed) anomalies.push('malformed stdout lines: ' + engine.malformed);

  console.log('');
  console.log('== soak result =======================================================');
  console.log('  wall clock      : ' + mmss(Date.now() - started));
  console.log('  audio played    : ' + mmss(playedMs) + ' across ' + (advances + 1) + ' tracks');
  console.log('  output mode     : ' + last.outputMode + ' @ ' + last.sampleRate + ' Hz, ' +
              'bufferMs=' + last.bufferMs + ' (peak seen ' + peakBufferMs + ')');
  console.log('  xrun            : ' + peakXruns + (peakXruns === 0 ? '   <- SPEC 9 target met' : '   <- FAILED'));
  console.log('  worst get_state : ' + worstLatency + ' ms');
  console.log('  anomalies       : ' + (anomalies.length ? anomalies.join(' | ') : 'none'));

  // The crash dump is asserted rather than the exit code, for the reason
  // recorded in PROGRESS: a teardown fault still reports a clean exit code.
  const dump = join(dirname(args.exe), 'twilight-engine-crash.dmp');
  const dumped = existsSync(dump);
  console.log('  crash dump      : ' + (dumped ? 'PRESENT -- ' + dump : 'none'));

  await engine.send({ cmd: 'shutdown' });
  await engine.close();

  // The evidence, not the claim.
  if (existsSync(diagPath)) {
    const text = readFileSync(diagPath, 'utf8');
    const fresh = text.slice(Math.min(diagBefore, text.length));
    const lines = fresh.split('\n').filter(Boolean);
    console.log('');
    console.log('  diagnostic log grew by ' + lines.length + ' lines; last 12:');
    for (const line of lines.slice(-12)) console.log('    ' + line);
  } else {
    console.log('  !! no diagnostic log was produced at ' + diagPath);
  }

  const ok = peakXruns === 0 && !dumped && anomalies.length === 0;
  console.log('');
  console.log(ok ? '  SOAK PASSED' : '  SOAK FAILED');
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });