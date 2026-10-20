import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseTtml } from '../src/shared/ttml.ts'

const lyrics = await import('../src/main/lyrics.ts')
const cache = await import('../src/main/lyrics-cache.ts')

const ONLINE = {
  wordByWord: false,
  source: 'netease-lrc',
  lines: [
    { startMs: 1000, endMs: 4000, words: [], text: 'これは合成された歌詞の一行です', translation: '其实我早就知道我能飞翔', romanization: 'ho n to u wa so ra wo to be ru' },
    { startMs: 4000, endMs: 8000, words: [], text: 'これも合成された歌詞の二行目', translation: '即便如此仍牵起你的手' }
  ]
}

const MATCH = { provider: 'netease', title: '测试曲目', artist: 'Test Artist', album: 'THE BOOK', durationMs: 305000, score: 1, risk: 'low', reasons: ['title_exact', 'artist_exact', 'duration_match'], ncmId: '3402268010' }

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'twilight-lyrics-save-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const audio = path.join(directory, 'Test Artist - 测试曲目.flac')
  lyrics.configureLyrics(path.join(directory, 'lyrics.json'))
  cache.configureLyricsCache(path.join(directory, 'lyrics-online.json'))
  return { directory, audio, sidecar: audio.replace(/\.flac$/i, '.ttml') }
}

test('an online lyric can be saved beside the track and then wins locally', async (t) => {
  const { audio, sidecar } = await workspace(t)
  // 缓存键必须与 libraryPathKey 一致（大小写、分隔符都归一），否则「保存」会找不到歌词。
  const { libraryPathKey } = await import('../src/shared/library.ts')
  await cache.writeOnlineCache(libraryPathKey(audio), ONLINE, MATCH, Date.now())

  const saved = await lyrics.saveLyricsBeside({ path: audio, title: 'Test Artist - 测试曲目', artist: '' })
  assert.equal(saved.path, sidecar)

  // 写出来的文件必须能被我们自己的解析器原样读回 —— 这是这个功能唯一的正确性标准。
  const back = parseTtml(await readFile(sidecar, 'utf8'))
  assert.ok(back)
  assert.equal(back.lines.length, 2)
  assert.equal(back.lines[0].text, 'これは合成された歌詞の一行です')
  assert.equal(back.lines[0].translation, '其实我早就知道我能飞翔')
  assert.equal(back.lines[0].romanization, 'ho n to u wa so ra wo to be ru')
  assert.equal(back.lines[0].startMs, 1000)
  assert.equal(back.lines[1].endMs, 8000)

  // 元数据把「这份歌词是哪来的」一并留下，不留在内存里。
  const text = await readFile(sidecar, 'utf8')
  assert.ok(text.includes('3402268010'), 'the netease id is recorded')
  assert.ok(text.includes('在线匹配'))

  // 本地优先：现在解析这首歌，来源必须是 sidecar 而不是在线。
  const resolved = await lyrics.resolveLyrics({ path: audio })
  assert.equal(resolved.source, 'sidecar')
  assert.equal(resolved.lyrics.lines.length, 2)
})

test('saving never overwrites an existing sidecar', async (t) => {
  const { audio, sidecar } = await workspace(t)
  const { libraryPathKey } = await import('../src/shared/library.ts')
  await cache.writeOnlineCache(libraryPathKey(audio), ONLINE, MATCH, Date.now())
  await writeFile(sidecar, 'hand written lyrics, do not clobber', 'utf8')
  await assert.rejects(lyrics.saveLyricsBeside({ path: audio }), /已存在/)
  assert.equal(await readFile(sidecar, 'utf8'), 'hand written lyrics, do not clobber')
})

test('saving without an online lyric says so instead of writing an empty file', async (t) => {
  const { audio, sidecar } = await workspace(t)
  await assert.rejects(lyrics.saveLyricsBeside({ path: audio }), /还没有可保存/)
  await assert.rejects(readFile(sidecar, 'utf8'), { code: 'ENOENT' })
})

test('a saved file survives a restart of the lyrics storage', async (t) => {
  const { audio, sidecar, directory } = await workspace(t)
  const { libraryPathKey } = await import('../src/shared/library.ts')
  await cache.writeOnlineCache(libraryPathKey(audio), ONLINE, MATCH, Date.now())
  await lyrics.saveLyricsBeside({ path: audio })
  // 模拟重启：只有磁盘上的东西还在。
  lyrics.configureLyrics(path.join(directory, 'lyrics.json'))
  cache.configureLyricsCache(path.join(directory, 'lyrics-online.json'))
  const resolved = await lyrics.resolveLyrics({ path: audio })
  assert.equal(resolved.source, 'sidecar')
  assert.equal(resolved.lyrics.lines[0].text, 'これは合成された歌詞の一行です')
  assert.equal(await readFile(sidecar, 'utf8').then(text => text.includes('测试曲目')), true)
})
