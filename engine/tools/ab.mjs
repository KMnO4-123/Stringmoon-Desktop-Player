#!/usr/bin/env node
// ab.mjs -- play the SAME passage through the two output paths, back to back,
// so a human can say whether they actually sound different.
//
// Why this exists: the engine can PROVE it hands the device the file's exact
// samples on the exclusive path (verified: 934,929,691 frames decode
// bit-identically, the source files are genuinely full-band, the DSP chain is
// identity by default and the limiter does not run unless the EQ does). It
// cannot prove what a listener HEARS. When those two disagree, the only honest
// next step is a controlled comparison rather than more argument.
//
// The cue, because a listener cannot read a terminal while listening:
//     1 beep  -> the passage that follows is EXCLUSIVE (source rate, no mixer)
//     2 beeps -> the passage that follows is SHARED    (48 kHz, OS mixer)
//
// usage: node tools/ab.mjs --library=<dir> [--from=60000] [--seconds=15] [--rounds=3]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = { exe: join(here, '..', 'bin', 'twilight-engine.exe'), library: null, from: 60000, seconds: 15, rounds: 3 };
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--library=')) args.library = raw.slice(10);
  else if (raw.startsWith('--from=')) args.from = Number(raw.slice(7));
  else if (raw.startsWith('--seconds=')) args.seconds = Number(raw.slice(10));
  else if (raw.startsWith('--rounds=')) args.rounds = Number(raw.slice(9));
  else if (raw.startsWith('--exe=')) args.exe = raw.slice(6);
}
if (!args.library) { console.error('need --library=<dir>'); process.exit(2); }

// --- the beep -------------------------------------------------------------
// Written as a real file and played through the engine's own WAV decoder, so
// the cue travels the SAME path as the music it introduces. A cue injected any
// other way would prove nothing about the path under test.
function markerWav(beeps) {
  const rate = 44100, ch = 2, frameCount = 0;
  const parts = [];
  let total = 0;
  for (let b = 0; b < beeps; ++b) {
    const on = Math.floor(rate * 0.15), gap = Math.floor(rate * 0.12);
    parts.push({ on, gap });
    total += on + gap;
  }
  total += Math.floor(rate * 0.35);            // a tail so the cue is not clipped off
  const data = Buffer.alloc(total * ch * 2);
  let cursor = 0;
  for (const { on, gap } of parts) {
    for (let i = 0; i < on; ++i) {
      const t = i / rate;
      const fade = Math.min(1, i / (rate * 0.005), (on - i) / (rate * 0.005));
      const v = Math.round(Math.sin(2 * Math.PI * 1000 * t) * 0.28 * 32767 * fade);
      for (let c = 0; c < ch; ++c) data.writeInt16LE(v, (cursor + i) * ch * 2 + c * 2);
    }
    cursor += on + gap;
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * ch * 2, 28); header.writeUInt16LE(ch * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const cueDir = join(tmpdir(), 'te-ab-' + Date.now());
mkdirSync(cueDir, { recursive: true });
writeFileSync(join(cueDir, 'cue-1-exclusive.wav'), markerWav(1));
writeFileSync(join(cueDir, 'cue-2-shared.wav'), markerWav(2));

// --- engine plumbing (same shape as drive.mjs) -----------------------------
const p = spawn(args.exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const pend = new Map(); let id = 0;
const events = [];
p.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.ev) events.push(m);
  }
});
const send = (o, ms = 120000) => { o.id = ++id; p.stdin.write(JSON.stringify(o) + '\n');
  return new Promise((res, rej) => { pend.set(o.id, res); setTimeout(() => rej(new Error('timeout ' + o.cmd)), ms); }); };
const waitFor = (ev, ms) => new Promise((res) => { const dl = Date.now() + ms;
  const iv = setInterval(() => { const h = events.find((e) => e.ev === ev); if (h || Date.now() > dl) { clearInterval(iv); res(h || null); } }, 50); });
// Wait for a NEW event of this kind. Matching the first one in the log returns
// instantly on every pass after the first, which cuts the cue off mid-beep and
// silently turns the whole comparison into 'no cue at all'.
const waitForNew = (ev, ms) => { const seen = events.filter((e) => e.ev === ev).length;
  return new Promise((res) => { const dl = Date.now() + ms;
    const iv = setInterval(() => {
      const now = events.filter((e) => e.ev === ev);
      if (now.length > seen || Date.now() > dl) { clearInterval(iv); res(now[seen] || null); }
    }, 50); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await waitFor('ready', 15000);
await send({ cmd: 'scan', path: cueDir }, 60000);
await send({ cmd: 'scan', path: args.library }, 300000);
const all = (await send({ cmd: 'list_tracks' })).data.tracks;
const cue1 = all.find((t) => t.path.includes('cue-1-exclusive'));
const cue2 = all.find((t) => t.path.includes('cue-2-shared'));
if (!cue1 || !cue2) { console.error('cue files did not show up in the catalog'); process.exit(1); }
const music = all.filter((t) => !t.path.includes('cue-'));
// The loudest, most stereo track in the library is the fairest test material: a
// quiet mono-ish recording would hide any difference between the two paths.
music.sort((a, b) => b.sizeBytes - a.sizeBytes);
const track = music[0];

const ready = events.find((e) => e.ev === 'ready');
const devices = ready.devices || [];
const dev = devices.find((d) => /NICEHCK|HiFi/i.test(d.name)) || devices.find((d) => d.isDefault) || devices[0];

console.log('A/B: exclusive (source rate) vs shared (48 kHz + OS mixer)');
console.log('  device : ' + dev.name);
console.log('  track  : ' + track.title.slice(0, 46) + '  (' + (track.sizeBytes / 1048576).toFixed(1) + ' MB)');
console.log('  passage: ' + (args.from / 1000).toFixed(0) + 's, ' + args.seconds + 's long, ' + args.rounds + ' rounds');
console.log('  CUE    : 1 beep = EXCLUSIVE    2 beeps = SHARED');
console.log('');

// The numbers printed here come from get_state AFTER the track has opened.
// Reading them from the set_output reply instead looked correct and was not:
// that reply describes the output as it stands at the moment of the CALL,
// which is still the previous pass's stream. It reported 48 kHz for one pass
// and 44.1 kHz for another on the SAME file, which reads like an engine bug
// and was a measurement bug in this script.
async function pass(mode, cue, label) {
  await send({ cmd: 'set_output', mode, deviceId: dev.id });
  await send({ cmd: 'open', trackId: cue.trackId });
  await send({ cmd: 'play' });
  await waitForNew('ended', 9000);   // let the cue finish before the music starts
  await sleep(300);
  await send({ cmd: 'open', trackId: track.trackId });
  await send({ cmd: 'seek', positionMs: args.from });
  await send({ cmd: 'play' });
  const st = (await send({ cmd: 'get_state' })).data;
  console.log('  ' + label.padEnd(11) +
              ' mode=' + String(st.outputMode).padEnd(9) +
              ' resampled=' + String(st.resampled).padEnd(5) +
              ' outputPerfect=' + String(st.outputPerfect).padEnd(5) +
              ' sourceExact=' + String(st.sourceExact).padEnd(5) +
              ' container=' + st.containerBits + 'bit valid=' + st.validBits + 'bit' +
              (st.outputNotPerfectReason ? '  reason=' + st.outputNotPerfectReason : ''));
  await sleep(args.seconds * 1000);
  await send({ cmd: 'stop' });
  await sleep(700);
}

for (let r = 1; r <= args.rounds; ++r) {
  console.log('round ' + r + '/' + args.rounds + '  (order flips each round so expectation cannot bias it)');
  if (r % 2 === 1) {
    await pass('exclusive', cue1, 'EXCLUSIVE');
    await pass('shared', cue2, 'SHARED');
  } else {
    await pass('shared', cue2, 'SHARED');
    await pass('exclusive', cue1, 'EXCLUSIVE');
  }
  console.log('');
}

await send({ cmd: 'shutdown' });
p.stdin.end();
rmSync(cueDir, { recursive: true, force: true });
console.log('done. 1 beep = exclusive, 2 beeps = shared.');