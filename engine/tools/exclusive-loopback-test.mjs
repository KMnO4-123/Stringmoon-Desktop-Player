// exclusive-loopback-test.mjs
//
// The one question this answers:
//   Can WASAPI loopback capture what the engine renders in EXCLUSIVE mode?
//
// Why it matters (and why this file exists at all):
//   Microsoft's Loopback Recording doc says "Exclusive-mode streams cannot
//   operate in loopback mode". If that holds here, the Null Test -- the only
//   experiment that can turn "the other player sounds better" into data --
//   must be run in SHARED mode, which changes what it can conclude.
//
// How it works:
//   1. Start a loopback capture thread (raw WASAPI, via a helper PowerShell).
//   2. Drive the engine over stdin/stdout: open + play a real FLAC in exclusive.
//   3. Report what the capture saw, alongside the engine's own state.
//
// The capture is a separate process so that the engine's timing is untouched.
// Nothing here writes to the engine's stdout, and the engine is not modified.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', 'bin', 'twilight-engine.exe');
const CAPTURE = path.resolve(HERE, 'capture-loopback.ps1');
const TRACK = process.argv[2] || path.join(process.env.STRINGMOON_TEST_LIBRARY ?? 'D:\\Music', 'track-01.flac');
const SECONDS = Number(process.argv[3] || 6);

for (const [label, p] of [['engine', ENGINE], ['capture helper', CAPTURE], ['track', TRACK]]) {
  if (!existsSync(p)) {
    console.error(`missing ${label}: ${p}`);
    process.exit(2);
  }
}

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// 1. start the engine and get it READY -- but do not play yet.
//
// Sequencing matters more than it looks. The first two runs of this test
// reported "no packets" and looked like an exclusive-mode limitation. They were
// not: the capture window (6 s) began and ended while the engine was still
// scanning the folder (~10 s of setup), so playback never overlapped capture.
// A capture that misses the audio proves nothing about the audio.
// ---------------------------------------------------------------------------
log('=== exclusive-mode loopback test ===');
log(`track: ${path.basename(TRACK)}`);
log('');

log('starting engine...');
const engine = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'] });

let outputMode = null;
let sawPlaying = false;
let statePerfect = null;
let stateExclusive = null;
const responses = [];
const stderrBuf = [];

const rl = createInterface({ input: engine.stdout });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  responses.push(msg);

  if (msg.ev === 'state' && msg.data) {
    if (msg.data.outputMode) outputMode = msg.data.outputMode;
    if (msg.data.state === 'playing') sawPlaying = true;
    if (typeof msg.data.outputPerfect === 'boolean') statePerfect = msg.data.outputPerfect;
    if (typeof msg.data.pcmPassthrough === 'boolean') stateExclusive = msg.data.pcmPassthrough;
  }
  if (msg.ok && msg.data && msg.data.outputMode) outputMode = msg.data.outputMode;
});
engine.stderr.on('data', d => stderrBuf.push(d.toString()));

const send = (obj) => engine.stdin.write(JSON.stringify(obj) + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let capture = null;
let captureOut = '';

try {
  send({ cmd: 'hello', protocol: 1 });
  await wait(400);

  send({ cmd: 'set_output', mode: 'exclusive' });
  await wait(300);

  // The engine does NOT scan on its own -- list_tracks is empty until scan runs.
  const folder = path.dirname(TRACK);
  send({ cmd: 'scan', path: folder });
  log(`scanning ${folder} ...`);
  await wait(9000);

  send({ cmd: 'open', trackId: 'tl_0001' });
  await wait(900);

  // -------------------------------------------------------------------------
  // 2. NOW start the capture, and only then start playback.
  // -------------------------------------------------------------------------
  log('starting loopback capture...');
  capture = spawn('pwsh', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE,
    '-Seconds', String(SECONDS + 2)
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  capture.stdout.on('data', d => { captureOut += d.toString(); });
  capture.stderr.on('data', d => { captureOut += d.toString(); });

  // let the capture open its stream before audio starts, so no leading audio
  // is missed
  await wait(2500);

  send({ cmd: 'play' });
  log(`playing for ${SECONDS}s in exclusive mode...`);
  await wait(SECONDS * 1000);

  send({ cmd: 'get_state' });
  await wait(500);

  send({ cmd: 'pause' });
  await wait(300);
} catch (e) {
  log('driver error: ' + e.message);
} finally {
  try { engine.kill(); } catch { }
}

// ---------------------------------------------------------------------------
// 3. let capture finish and report
// ---------------------------------------------------------------------------
log('');
log('waiting for capture to finish...');

// The capture helper has its own duration, but a pwsh child can outlive it by a
// beat (JIT/startup), and if it never exits we must not hang the whole test.
const captureCode = await new Promise(res => {
  let done = false;
  const finish = (c) => { if (!done) { done = true; res(c); } };
  capture.on('exit', c => finish(c));
  setTimeout(() => {
    if (!done) {
      log('  (capture helper did not exit in time -- killing it)');
      try { capture.kill(); } catch { }
      finish('timeout');
    }
  }, (SECONDS + 6) * 1000);
});

log('');
log('=== engine state ===');
log(`  outputMode:        ${outputMode}`);
log(`  saw playing state: ${sawPlaying}`);
log(`  pcmPassthrough:    ${stateExclusive}`);
log(`  outputPerfect:     ${statePerfect}`);

// The engine's stderr is the authoritative record of what it actually did
// (stdout is protocol-only). Without it, a "no packets" result cannot be
// distinguished from "the engine never opened the device".
log('');
log('=== engine stderr (last lines) ===');
const errText = stderrBuf.join('');
for (const line of errText.split(/\r?\n/).filter(l => l.trim()).slice(-14)) {
  log('  ' + line.trim());
}

// Open/play replies matter: ERR_NOTFOUND on open means nothing was ever loaded.
log('');
log('=== open / play replies ===');
for (const m of responses.filter(r => r.id !== undefined && r.ok === false)) {
  log(`  id=${m.id} error=${m.error?.code} ${m.error?.message}`);
}

log('');
log('=== capture helper output ===');
for (const line of captureOut.split(/\r?\n/)) {
  if (line.trim()) log('  ' + line.trim());
}
log(`  (exit code ${captureCode})`);

// ---------------------------------------------------------------------------
// 4. verdict
// ---------------------------------------------------------------------------
const capturedFrames = Number((captureOut.match(/captured frames:\s*(\d+)/) || [])[1] || 0);
const nonzero = Number((captureOut.match(/non-zero captured samples:\s*(\d+)/) || [])[1] || 0);

log('');
log('=== VERDICT ===');
if (capturedFrames === 0) {
  log('  INCONCLUSIVE: loopback delivered no packets at all.');
  log('  -> either nothing was playing, or the endpoint was busy.');
} else if (nonzero === 0) {
  log('  ⚠️ EXCLUSIVE IS NOT LOOPBACK-CAPTURABLE on this endpoint.');
  log('  -> packets arrived but every sample was zero: the audio engine was');
  log('     bypassed, which is exactly what Microsoft documents.');
  log('  -> The Null Test must therefore run in SHARED mode.');
} else {
  log('  ✅ EXCLUSIVE WAS CAPTURED.');
  log(`  -> ${nonzero} non-zero samples out of ${capturedFrames} frames.`);
  log('  -> This endpoint DOES expose a loopback pin, so the Null Test can');
  log('     compare exclusive output too.');
}
