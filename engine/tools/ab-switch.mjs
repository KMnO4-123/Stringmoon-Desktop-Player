#!/usr/bin/env node
// ab-switch.mjs -- press a key, hear the SAME musical window through a
// different output path, instantly.
//
// The previous attempt (tools/ab.mjs) played two passes back to back with a
// beep cue. The owner's verdict on it was the useful one: the difference was
// audible but they could not say which was better -- which is what a comparison
// with tens of seconds between the samples and an order that changes under you
// will always produce. Human auditory memory for this kind of judgement is a few
// seconds, not half a minute.
//
// So this version removes both problems:
//   * the window is anchored, so both paths play the SAME seconds of the same
//     file, not merely the same track;
//   * YOU choose the path, so there is no cue to decode and no order to track.
//
//   1  -> replay the window through EXCLUSIVE (source rate, no mixer)
//   2  -> replay the window through SHARED    (48 kHz + OS mixer)
//   [ ] -> nudge the window start by -/+ 5 s     (if the passage is unhelpful)
//   a  -> auto-alternate 1,2,1,2                (hands free)
//   q  -> quit
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = { exe: join(here, '..', 'bin', 'twilight-engine.exe'), library: null, from: 60000, seconds: 10, auto: false };
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--library=')) args.library = raw.slice(10);
  else if (raw.startsWith('--from=')) args.from = Number(raw.slice(7));
  else if (raw.startsWith('--seconds=')) args.seconds = Number(raw.slice(10));
  else if (raw.startsWith('--exe=')) args.exe = raw.slice(6);
  else if (raw === '--auto') args.auto = true;
  else if (raw === '--list') args.list = true;
  else if (raw.startsWith('--pick=')) args.pick = raw.slice(7);
  else if (raw.startsWith('--index=')) args.index = Number(raw.slice(8));
}
if (!args.library) { console.error('need --library=<dir>'); process.exit(2); }

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
await send({ cmd: 'scan', path: args.library });
const tracks = (await send({ cmd: 'list_tracks' })).data.tracks;
if (args.list) {
  tracks.forEach((t, i) => console.log(String(i).padStart(3) + '  ' + t.sampleRate + 'Hz/' +
    String(t.bitDepth) + 'bit  ' + t.title.slice(0, 60)));
  await send({ cmd: 'shutdown' }); p.stdin.end(); process.exit(0);
}
// Selection: by index, by substring, else the largest file.
//
// The substring form exists because 'changing the song' is a real experiment
// and not just variety: if one track sounds muddy and another does not, the
// FILE is implicated and the whole output path is exonerated. Comparing two
// different sample rates tests a second thing at once -- a 96 kHz file on a
// 96 kHz-capable DAC exercises the exclusive format negotiation that a 44.1 kHz
// file never reaches.
let track;
if (Number.isInteger(args.index)) track = tracks[args.index];
else if (args.pick) {
  const needle = args.pick.toLowerCase();
  track = tracks.find((t) => t.title.toLowerCase().includes(needle)) ||
          tracks.find((t) => t.path.toLowerCase().includes(needle));
  if (!track) { console.error('no track matches --pick=' + args.pick + ' (try --list)'); process.exit(2); }
} else {
  track = tracks.slice().sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
}

console.log('switch A/B on ' + dev.name);
console.log('  track : ' + track.title.slice(0, 52));
console.log('         ' + track.sampleRate + ' Hz / ' + track.bitDepth + ' bit / ' + track.codec);
console.log('  window: ' + (args.from / 1000).toFixed(1) + 's + ' + args.seconds + 's   (same seconds for both paths)');
console.log('');
console.log('  1 = EXCLUSIVE (source rate, no mixer)');
console.log('  2 = SHARED    (48 kHz + OS mixer)');
console.log('  [ ] = move window -/+ 5s    a = auto 1,2,1,2    q = quit');
console.log('');

let anchor = args.from;
let busy = false;

async function play(mode) {
  if (busy) return;
  busy = true;
  try {
    await send({ cmd: 'stop' });
    await send({ cmd: 'set_output', mode, deviceId: dev.id });
    await send({ cmd: 'open', trackId: track.trackId });
    await send({ cmd: 'seek', positionMs: anchor });
    await send({ cmd: 'play' });
    // Read the state AFTER the track has opened, never from the set_output
    // reply: that one describes the stream as it stood before the switch.
    const st = (await send({ cmd: 'get_state' })).data;
    console.log('  ' + (mode === 'exclusive' ? 'EXCLUSIVE' : 'SHARED   ') +
                ' resampled=' + String(st.resampled).padEnd(5) +
                ' outputPerfect=' + String(st.outputPerfect).padEnd(5) +
                ' sourceExact=' + String(st.sourceExact).padEnd(5) +
                ' container=' + st.containerBits + 'bit');
    await sleep(args.seconds * 1000);
    await send({ cmd: 'stop' });
  } finally { busy = false; }
}

async function autoSequence() {
  for (let i = 0; i < 6 && running; ++i) {
    await play(i % 2 === 0 ? 'exclusive' : 'shared');
    await sleep(400);
  }
  if (running) prompt();
}

let running = true;
const prompt = () => process.stdout.write('  1/2/[ ]/a/q > ');

function onKey(k) {
  if (k === '\u0003' || k === 'q') { running = false; finish(); return; }
  if (k === '1') { play('exclusive').then(prompt); return; }
  if (k === '2') { play('shared').then(prompt); return; }
  if (k === '[') { anchor = Math.max(0, anchor - 5000); console.log('  window -> ' + (anchor / 1000).toFixed(1) + 's'); prompt(); return; }
  if (k === ']') { anchor += 5000; console.log('  window -> ' + (anchor / 1000).toFixed(1) + 's'); prompt(); return; }
  if (k === 'a') { console.log('  auto-alternating (6 passes)'); autoSequence(); return; }
  prompt();
}

async function finish() {
  try { await send({ cmd: 'stop' }); } catch {}
  try { await send({ cmd: 'shutdown' }); } catch {}
  p.stdin.end();
  console.log('\ndone.');
  process.exit(0);
}

if (args.auto) {
  process.stdin.pause();
  autoSequence().then(finish);
} else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKey);
  prompt();
}