import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const embedded = await import('../src/main/embedded-lyrics.ts')
const lyrics = await import('../src/main/lyrics.ts')

beforeEach(() => embedded.configureEmbeddedLyrics(null))

test('embedded lyrics are used only when they carry a timeline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'te-embedded-'))
  try {
    const audio = path.join(dir, 'song.flac')
    embedded.configureEmbeddedLyrics(async () => ['just some unsynced words'])
    assert.equal(await embedded.readEmbeddedLyrics(audio), null, 'unsynced text cannot drive a highlight, so it is not lyrics')

    embedded.configureEmbeddedLyrics(async () => ['[00:01.00]第一句\n[00:03.50]第二句'])
    const parsed = await embedded.readEmbeddedLyrics(audio)
    assert.ok(parsed)
    assert.equal(parsed.source, 'embedded')
    assert.equal(parsed.lines.length, 2)
    assert.equal(parsed.lines[0].startMs, 1000)
    assert.equal(parsed.lines[1].text, '第二句')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a bad tag reader never breaks local resolution', async () => {
  embedded.configureEmbeddedLyrics(async () => { throw new Error('corrupt tag') })
  const original = console.error
  console.error = () => {}
  try {
    assert.equal(await embedded.readEmbeddedLyrics('C:/x/a.flac'), null)
  } finally { console.error = original }
})

test('the chain prefers a sidecar file over the embedded tag', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'te-embedded-chain-'))
  try {
    const audio = path.join(dir, 'song.flac')
    lyrics.configureLyrics(path.join(dir, 'lyrics.json'))
    embedded.configureEmbeddedLyrics(async () => ['[00:05.00]内嵌的句子'])

    let resolved = await lyrics.resolveLyrics({ path: audio })
    assert.equal(resolved.source, 'embedded')
    assert.equal(resolved.lyrics.lines[0].startMs, 5000)

    await writeFile(path.join(dir, 'song.lrc'), '[00:01.00]旁边的文件', 'utf8')
    resolved = await lyrics.resolveLyrics({ path: audio })
    assert.equal(resolved.source, 'sidecar', 'a file beside the track beats a tag inside it')
    assert.equal(resolved.lyrics.lines[0].text, '旁边的文件')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
