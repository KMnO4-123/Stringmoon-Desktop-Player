#!/usr/bin/env node
// rate-ab.mjs -- the SAME music at two FEED RATES, both exclusive, alternating.
//
// The last variable software can still change. Other players hand the device
// 48 kHz through the mixer; this engine hands it the SOURCE rate, because that is
// what bit-perfect means. If this particular USB DAC treats 44.1 kHz worse than
// 96 kHz internally, the result is a flattened image that every software check
// reports as perfect -- and feeding it 96 kHz would fix it.
//
// The material is one track plus a copy of that track resampled by the ENGINE'S
// OWN SoXR, so the two halves differ in nothing but the rate arriving at the DAC.
//
//   1 = 44.1 kHz native (bit-perfect)      2 = 96 kHz (engine-resampled)
//   a = auto 1,2,1,2   q = quit
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = { exe: join(here, '..', 'bin', 'twilight-engine.exe'), library: null, pick: null, from: 60000, seconds: 8, target: 96000, auto: false };
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--library=')) args.library = raw.slice(10);
  else if (raw.startsWith('--pick=')) args.pick = raw.slice(7);
  else if (raw.startsWith('--from=')) args.from = Number(raw.slice(7));
  else if (raw.startsWith('--seconds=')) args.seconds = Number(raw.slice(10));
  else if (raw.startsWith('--target=')) args.target = Number(raw.slice(9));
  else if (raw === '--auto') args.auto = true;
}
if (!args.library || !args.pick) { console.error('need --library=<dir> --pick=<name>'); process.exit(2); }

// --- assemble the material: original + a rate-converted copy, side by side ---
const dir = join(tmpdir(), 'te-rate-' + Date.now());
mkdirSync(dir, { recursive: true });

const listProc = spawnSync(args.exe, ['--probe-decode', args.library], { encoding: 'utf8' });
void listProc;
// Pick the source file by name from the library.
const fs = await import('node:fs');
function findFile(root, needle) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase().endsWith('.flac') && e.name.toLowerCase().includes(needle.toLowerCase())) return full;
    }
  }
  return null;
}
const original = findFile(args.library, args.pick);
if (!original) { console.error('no FLAC matching ' + args.pick); process.exit(2); }
const originalCopy = join(dir, 'a-native-44k.flac');
copyFileSync(original, originalCopy);
const converted = join(dir, 'b-resampled-' + (args.target / 1000) + 'k.wav');
console.log('converting with the engine\'s own resampler ...');
const conv = spawnSync(args.exe, ['--probe-resample', original, converted, String(args.target)], { encoding: 'utf8' });
process.stdout.write(conv.stdout || '');
if (!fs.existsSync(converted)) { console.error('conversion failed'); process.exit(1); }

// --- engine plumbing -------------------------------------------------------
const p = spawn(args.exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const pend = new Map(); const events = []; let id = 0;
p.stdout.on('data', (d) => { buf += d.toString('utf8'); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue; const m = JSON.parse(l);
    if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.ev) events.push(m); } });
const send = (o, ms = 300000) => { o.id = ++id; p.stdin.write(JSON.stringify(o) + '\n');
  return new Promise((res, rej) => { pend.set(o.id, res); setTimeout(() => rej(new Error('timeout ' + o.cmd)), ms); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => { const iv = setInterval(() => { if (events.find((e) => e.ev === 'ready')) { clearInterval(iv); r(); } }, 50); });
const ready = events.find((e) => e.ev === 'ready');
const dev = (ready.devices || []).find((d) => /NICEHCK|HiFi/i.test(d.name)) || (ready.devices || [])[0];
await send({ cmd: 'scan', path: dir });
const tracks = (await send({ cmd: 'list_tracks' })).data.tracks;
const native = tracks.find((t) => t.path.includes('a-native'));
const hi = tracks.find((t) => t.path.includes('b-resampled'));
if (!native || !hi) { console.error('material did not appear in the catalog'); process.exit(1); }
await send({ cmd: 'set_output', mode: 'exclusive', deviceId: dev.id });

console.log('rate A/B  device=' + dev.name);
console.log('  A : ' + basename(original) + '  ' + native.sampleRate + ' Hz native');
console.log('  B : engine-resampled copy  ' + hi.sampleRate + ' Hz');
console.log('  window: ' + (args.from / 1000).toFixed(1) + 's + ' + args.seconds + 's');
console.log('');
console.log('  1 = native (bit-perfect)   2 = resampled to ' + args.target + '    a = auto   q = quit');
console.log('');
async function play(which) {
  const t = which === 1 ? native : hi;
  await send({ cmd: 'stop' });
  await send({ cmd: 'open', trackId: t.trackId });
  await send({ cmd: 'seek', positionMs: args.from });
  await send({ cmd: 'play' });
  const st = (await send({ cmd: 'get_state' })).data;
  console.log('  ' + (which === 1 ? 'NATIVE  ' : 'RESAMPLED') +
              ' resampled=' + String(st.resampled).padEnd(5) +
              ' outputPerfect=' + String(st.outputPerfect).padEnd(5) +
              ' outputMode=' + st.outputMode);
  await sleep(args.seconds * 1000);
  await send({ cmd: 'stop' });
}
async function finish() {
  try { await send({ cmd: 'stop' }); await send({ cmd: 'shutdown' }); } catch {}
  p.stdin.end(); rmSync(dir, { recursive: true, force: true });
  console.log('\ndone.'); process.exit(0);
}
if (args.auto) {
  process.stdin.pause();
  (async () => { for (let r = 0; r < 3; ++r) { await play(1); await play(2); } await finish(); })();
} else {
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k) => {
    if (k === 'q' || k === '\u0003') return finish();
    if (k === '1') { play(1).then(() => process.stdout.write('  1/2/a/q > ')); return; }
    if (k === '2') { play(2).then(() => process.stdout.write('  1/2/a/q > ')); return; }
    if (k === 'a') { (async () => { await play(1); await play(2); process.stdout.write('  1/2/a/q > '); })(); return; }
  });
  process.stdout.write('  1=native 2=resampled a=auto q=quit > ');
}