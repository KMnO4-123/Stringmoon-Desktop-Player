#!/usr/bin/env node
// level-ab.mjs -- same passage, same output path, three DIGITAL levels.
//
// Why: the owner reports that other players (NetEase / QQ Music, both shared
// mode) sound clearly better on the same track, headphones and DAC, while the
// engine's exclusive path is verified bit-exact. When measurement and ears
// disagree, the measurement is usually measuring the wrong thing.
//
// The one structural difference nobody had looked at: the Windows volume slider
// does NOT apply to an exclusive stream. Other players run through the mixer and
// are attenuated by it; this engine's output level is entirely its own digital
// volume. So if the engine is simply LOUDER than what the owner is used to, they
// would hear it as worse -- pushed level reads as 'muddy' exactly like squashed
// level does, and both are 'separation is not clear'.
//
// 1 2 3 = play the window at 100% / 50% / 25%     a = auto cycle     q = quit
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = { exe: join(here, '..', 'bin', 'twilight-engine.exe'), library: null, from: 60000, seconds: 8, auto: false };
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--library=')) args.library = raw.slice(10);
  else if (raw.startsWith('--from=')) args.from = Number(raw.slice(7));
  else if (raw.startsWith('--seconds=')) args.seconds = Number(raw.slice(10));
  else if (raw.startsWith('--pick=')) args.pick = raw.slice(7);
  else if (raw === '--auto') args.auto = true;
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
const track = args.pick
  ? (tracks.find((t) => t.title.toLowerCase().includes(args.pick.toLowerCase())) || tracks[0])
  : tracks.slice().sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
const VOLUMES = [1.0, 0.5, 0.25];

await send({ cmd: 'set_output', mode: 'exclusive', deviceId: dev.id });
await send({ cmd: 'open', trackId: track.trackId });
console.log('level A/B  device=' + dev.name);
console.log('  track : ' + track.title.slice(0, 52));
console.log('  window: ' + (args.from / 1000).toFixed(1) + 's + ' + args.seconds + 's at volume 100% / 50% / 25%');
console.log('');

async function play(v) {
  await send({ cmd: 'stop' });
  await send({ cmd: 'set_volume', volume: v });
  await send({ cmd: 'open', trackId: track.trackId });
  await send({ cmd: 'seek', positionMs: args.from });
  await send({ cmd: 'play' });
  const st = (await send({ cmd: 'get_state' })).data;
  console.log('  volume=' + String(Math.round(v * 100) + '%').padEnd(5) +
              ' outputPerfect=' + String(st.outputPerfect).padEnd(5) +
              ' reason=' + (st.outputNotPerfectReason || '-'));
  await sleep(args.seconds * 1000);
  await send({ cmd: 'stop' });
}

async function finish() {
  try { await send({ cmd: 'set_volume', volume: 1.0 }); } catch {}
  try { await send({ cmd: 'stop' }); await send({ cmd: 'shutdown' }); } catch {}
  p.stdin.end(); console.log('\ndone.'); process.exit(0);
}

if (args.auto) {
  process.stdin.pause();
  (async () => {
    for (let r = 0; r < 2; ++r) for (const v of VOLUMES) await play(v);
    await finish();
  })();
} else {
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k) => {
    if (k === 'q' || k === '\u0003') { finish(); return; }
    if (k >= '1' && k <= '3') { play(VOLUMES[Number(k) - 1]).then(() => process.stdout.write('  1/2/3 > ')); return; }
    if (k === 'a') { (async () => { for (const v of VOLUMES) await play(v); process.stdout.write('  1/2/3 > '); })(); return; }
  });
  process.stdout.write('  1=100%  2=50%  3=25%  a=auto  q=quit > ');
}