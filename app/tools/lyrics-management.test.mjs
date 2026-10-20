import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const model = await import('../src/shared/lyrics-model.ts').catch(() => ({}))

const original = {
  source: 'local', wordByWord: true,
  lines: [{ startMs: 200, endMs: 1200, text: 'Hello', translation: '你好', romanization: 'ni hao', background: true,
    words: [{ startMs: 200, endMs: 700, text: 'Hel' }, { startMs: 700, endMs: 1200, text: 'lo' }] }]
}

test('offset shifts line and word timing immutably, clamps zero, and resets exactly', () => {
  assert.equal(typeof model.applyLyricsOffset, 'function')
  const input = structuredClone(original)
  const negative = model.applyLyricsOffset(input, -500)
  assert.deepEqual(negative.lines[0], {
    ...original.lines[0], startMs: 0, endMs: 700,
    words: [{ startMs: 0, endMs: 200, text: 'Hel' }, { startMs: 200, endMs: 700, text: 'lo' }]
  })
  const positive = model.applyLyricsOffset(input, 500)
  assert.equal(positive.lines[0].startMs, 700)
  assert.equal(positive.lines[0].endMs, 1700)
  assert.equal(positive.lines[0].words[1].endMs, 1700)
  assert.deepEqual(input, original)
  assert.deepEqual(model.applyLyricsOffset(input, 0), original)
})

test('offset rejects noninteger, nonfinite, out of range and non-step values', () => {
  assert.equal(typeof model.applyLyricsOffset, 'function')
  for (const value of [-10050, 10050, 1, 25, 0.5, NaN, Infinity, '50', null]) {
    assert.throws(() => model.applyLyricsOffset(original, value), /offset/i)
  }
  assert.equal(model.applyLyricsOffset(original, 10000).lines[0].startMs, 10200)
  assert.equal(model.applyLyricsOffset(original, -10000).lines[0].endMs, 0)
})

test('source selection prefers attached lyrics, falls back to sidecar, and permits no source', () => {
  assert.equal(typeof model.selectLyricsSource, 'function')
  const attached = { lyrics: original, resolvedPath: '/attached.lrc', source: 'attached' }
  const sidecar = { lyrics: original, resolvedPath: '/song.lrc', source: 'sidecar' }
  assert.equal(model.selectLyricsSource(attached, sidecar), attached)
  assert.equal(model.selectLyricsSource(null, sidecar), sidecar)
  assert.equal(model.selectLyricsSource(null, null), null)
})

const repository = await import('../src/main/lyrics.ts').catch(() => ({}))

async function workspace(t) {
  assert.equal(typeof repository.configureLyrics, 'function')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'twilight-lyrics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'lyrics.json')
  const audio = path.join(directory, 'song.flac')
  const sidecar = path.join(directory, 'song.lrc')
  const attached = path.join(directory, 'attached.lrc')
  repository.configureLyrics(config)
  return { directory, config, audio, sidecar, attached }
}

test('repository resolves attached before sidecar, returns raw timing, persists offsets and restores automatic selection', async t => {
  const { config, audio, sidecar, attached, directory } = await workspace(t)
  await writeFile(sidecar, '[00:01.00]Sidecar')
  await writeFile(attached, '[00:02.00]Attached')
  assert.equal((await repository.resolveLyrics({ path: audio })).source, 'sidecar')
  await Promise.all([repository.attachLyrics(audio, attached), repository.setLyricsOffset(audio, -500)])
  const selected = await repository.resolveLyrics({ trackId: 'transient-1', path: audio })
  assert.equal(selected.source, 'attached')
  assert.equal(selected.lyrics.lines[0].startMs, 2000)
  assert.equal(selected.offsetMs, -500)
  assert.equal(selected.attachedUnavailable, false)
  assert.equal(selected.resolvedPath, attached)
  repository.configureLyrics(config)
  const normalizedAudio = audio.toUpperCase().replaceAll('\\', '/')
  assert.equal((await repository.resolveLyrics({ trackId: 'transient-2', path: normalizedAudio })).offsetMs, -500)
  assert.equal((await repository.resolveLyrics({ path: audio })).source, 'attached')
  await repository.clearAttachedLyrics(audio)
  assert.equal((await repository.resolveLyrics({ path: audio })).source, 'sidecar')
  assert.equal((await repository.resolveLyrics({ path: audio })).offsetMs, -500)
  const document = JSON.parse(await readFile(config, 'utf8'))
  assert.equal(document.version, 1)
  assert.deepEqual(Object.values(document.tracks), [{ offsetMs: -500 }])
  assert.equal((await readFile(attached, 'utf8')), '[00:02.00]Attached')
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false)
})

test('missing and invalid attached sources retain their association and fall back to sidecar', async t => {
  const { config, audio, sidecar, attached } = await workspace(t)
  await writeFile(sidecar, '[00:01]Sidecar')
  await writeFile(attached, '[00:02]Attached')
  await repository.attachLyrics(audio, attached)
  await unlink(attached)
  let result = await repository.loadLyrics(audio)
  assert.equal(result.source, 'sidecar')
  assert.equal(result.attachedUnavailable, true)
  assert.equal(Object.values(JSON.parse(await readFile(config, 'utf8')).tracks)[0].attachedPath, attached)
  await writeFile(attached, 'invalid lyric text')
  result = await repository.loadLyrics(audio)
  assert.equal(result.source, 'sidecar')
  assert.equal(result.attachedUnavailable, true)
  await writeFile(attached, '[00:03]Restored')
  assert.equal((await repository.loadLyrics(audio)).source, 'attached')
})

test('ordinary resolution never falls back to demo fixtures; fixtures require explicit configuration', async t => {
  const { config, audio, attached } = await workspace(t)
  const empty = { lyrics: null, resolvedPath: null, source: 'none', attachedUnavailable: false, offsetMs: 0 }
  assert.deepEqual(await repository.resolveLyrics({ path: audio }), empty)
  assert.deepEqual(await repository.resolveLyrics({ trackId: 'demo' }), empty)
  await writeFile(attached, '[00:01]Smoke fixture')
  repository.configureLyrics(config, { fixturePaths: [attached] })
  assert.equal((await repository.resolveLyrics({ path: audio })).resolvedPath, attached)
  repository.configureLyrics(config)
  assert.deepEqual(await repository.resolveLyrics({ path: audio }), empty)
})

test('repository rejects invalid paths, non-LRC files, empty LRC and invalid offsets without changing preferences', async t => {
  const { config, audio, attached, directory } = await workspace(t)
  await writeFile(attached, 'No timestamps')
  await assert.rejects(repository.attachLyrics(audio, attached), /valid|timed|lyrics/i)
  await assert.rejects(repository.attachLyrics(audio, path.join(directory, 'bad.txt')), /lrc/i)
  await assert.rejects(repository.attachLyrics(audio, path.join(directory, 'missing.lrc')), /read|found|lyrics/i)
  await assert.rejects(repository.attachLyrics('relative.flac', attached), /absolute|path/i)
  await assert.rejects(repository.setLyricsOffset(audio, 25), /offset/i)
  await assert.rejects(repository.setLyricsOffset(audio, 10050), /offset/i)
  assert.deepEqual(await repository.resolveLyrics({ path: audio }), {
    lyrics: null, resolvedPath: null, source: 'none', attachedUnavailable: false, offsetMs: 0
  })
  await assert.rejects(readFile(config), { code: 'ENOENT' })
})

test('serialized concurrent preference writes survive reload with no lost associations or offsets', async t => {
  const { config, audio, attached, directory } = await workspace(t)
  await writeFile(attached, '[00:01]Attached')
  const other = path.join(directory, 'other.mp3')
  await Promise.all([
    repository.attachLyrics(audio, attached), repository.setLyricsOffset(audio, 250),
    repository.setLyricsOffset(other, -750), repository.setLyricsOffset(audio, 500)
  ])
  repository.configureLyrics(config)
  const first = await repository.loadLyrics(audio)
  assert.equal(first.offsetMs, 500)
  assert.equal(first.source, 'attached')
  assert.equal((await repository.loadLyrics(other)).offsetMs, -750)
})

test('parsed cache reuses unchanged sources and invalidates after size or mtime changes', async t => {
  const { audio, sidecar } = await workspace(t)
  await writeFile(sidecar, '[00:01]First')
  const first = await repository.loadLyrics(audio)
  assert.equal((await repository.loadLyrics(audio)).lyrics, first.lyrics)
  await writeFile(sidecar, '[00:02]A different sized lyric')
  assert.equal((await repository.loadLyrics(audio)).lyrics.lines[0].text, 'A different sized lyric')
  const second = await repository.loadLyrics(audio)
  await writeFile(sidecar, '[00:03]A different sized lyric')
  await utimes(sidecar, new Date(), new Date(Date.now() + 5000))
  const third = await repository.loadLyrics(audio)
  assert.notEqual(third.lyrics, second.lyrics)
  assert.equal(third.lyrics.lines[0].startMs, 3000)
})

test('parsed cache evicts the least recently used entry above 128 sources', async t => {
  const { directory } = await workspace(t)
  const files = Array.from({ length: 129 }, (_, i) => path.join(directory, `song-${i}.lrc`))
  await Promise.all(files.map((file, i) => writeFile(file, `[00:01]Song ${i}`)))
  const load = i => repository.loadLyrics(files[i].replace(/\.lrc$/, '.flac'))
  const oldest = await load(0)
  const recent = await load(1)
  for (let i = 2; i < 128; i++) await load(i)
  await load(1)
  await load(128)
  assert.equal((await load(1)).lyrics, recent.lyrics)
  assert.notEqual((await load(0)).lyrics, oldest.lyrics)
})

test('parsed cache also evicts sources when retained text exceeds eight MiB', async t => {
  const { directory } = await workspace(t)
  const firstAudio = path.join(directory, 'large-a.flac')
  const secondAudio = path.join(directory, 'large-b.flac')
  await writeFile(path.join(directory, 'large-a.lrc'), '[00:01]' + 'a'.repeat(2200000))
  await writeFile(path.join(directory, 'large-b.lrc'), '[00:02]' + 'b'.repeat(2200000))
  const first = await repository.loadLyrics(firstAudio)
  await repository.loadLyrics(secondAudio)
  assert.notEqual((await repository.loadLyrics(firstAudio)).lyrics, first.lyrics)
})
