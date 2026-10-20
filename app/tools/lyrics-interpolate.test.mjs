import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpolateLine, withInterpolatedWords } from '../src/shared/lyrics-interpolate.ts'

const line = (text, startMs, endMs, words = []) => ({ startMs, endMs, text, words })

test('line-level lyrics get word timings so the fill can actually run', () => {
  // 实测：这个曲库里拿到歌词的歌 11/12 是行级。没有这条，逐字填充永远不亮。
  const words = interpolateLine(line('ゆこう明日へと', 1000, 5000))
  assert.equal(words.length, 7, 'one unit per grapheme for CJK')
  assert.equal(words.map(w => w.text).join(''), 'ゆこう明日へと')
  assert.equal(words[0].startMs, 1000)
  assert.equal(words.at(-1).endMs, 5000, 'the last unit ends exactly at the line end')
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].startMs >= words[i - 1].startMs, 'monotonic in time')
    assert.equal(words[i].startMs, words[i - 1].endMs, 'no gaps and no overlaps')
  }
})

test('graphemes, not code points: 拗音 and combining marks stay whole', () => {
  const youon = interpolateLine(line('きゃりー', 0, 1000))
  assert.deepEqual(youon.map(w => w.text), ['き', 'ゃ', 'り', 'ー'], 'kana are separate glyphs here')
  // 组合字符（e + ́）必须是一个字素，否则填充会在字形中间断开。
  const combining = interpolateLine(line('cafe\u0301 x', 0, 1000))
  assert.ok(combining.some(w => w.text.includes('\u0301')), 'the combining mark stays with its base')
  assert.equal(combining.map(w => w.text).join(''), 'cafe\u0301 x')
})

test('Latin lines split by word, and longer words get proportionally more time', () => {
  const words = interpolateLine(line('Am I still dreaming?', 0, 8000))
  const text = words.map(w => w.text).join('')
  assert.equal(text, 'Am I still dreaming?')
  assert.ok(words.length <= 5, 'Latin splits by word, not by letter: ' + JSON.stringify(words.map(w => w.text)))
  const dreaming = words.find(w => w.text.includes('dreaming'))
  const am = words.find(w => w.text.trim() === 'Am')
  assert.ok(dreaming && am)
  assert.ok(dreaming.endMs - dreaming.startMs > (am.endMs - am.startMs) * 3, '9 letters vs 2 letters')
  // 空格并进前一个词，不单独占一份时间。
  assert.ok(!words.some(w => !w.text.trim()), 'no whitespace-only units')
})

test('interpolation never overwrites real word-level data', () => {
  const real = line('雨上がり', 0, 2000, [
    { text: '雨', startMs: 0, endMs: 900 },
    { text: '上がり', startMs: 900, endMs: 2000 }
  ])
  assert.equal(interpolateLine(real), real.words, 'the source wins, by identity')
})

test('degenerate lines are left alone instead of producing flash', () => {
  assert.deepEqual(interpolateLine(line('', 0, 5000)), [])
  assert.deepEqual(interpolateLine(line('短', 0, 120)), [], 'a 120 ms window cannot be read as progress')
  assert.deepEqual(interpolateLine(line('x', 5000, 5000)), [])
  assert.deepEqual(interpolateLine(line('   ', 0, 5000)), [])
})

test('the view model marks interpolation but keeps wordByWord honest', () => {
  const lyrics = {
    wordByWord: false,
    source: 'netease-lrc',
    lines: [line('無敵の笑顔', 0, 4000), line('already word level', 4000, 6000, [{ text: 'already word level', startMs: 4000, endMs: 6000 }])]
  }
  const { lyrics: view, interpolated } = withInterpolatedWords(lyrics)
  assert.equal(interpolated, true)
  assert.equal(view.wordByWord, false, 'the flag stays a fact about the source')
  assert.equal(view.source, 'netease-lrc')
  assert.ok(view.lines[0].words.length > 1, 'the line-level line gained words')
  assert.equal(view.lines[1].words.length, 1, 'the word-level line is untouched')
  // 源对象不被改写：缓存与 IPC 上的数据必须保持源样。
  assert.deepEqual(lyrics.lines[0].words, [])

  // 全是逐字源时不标注插值。
  const wordOnly = { wordByWord: true, source: 'amll-ttml', lines: [line('あ', 0, 1000, [{ text: 'あ', startMs: 0, endMs: 1000 }])] }
  const second = withInterpolatedWords(wordOnly)
  assert.equal(second.interpolated, false)
  assert.equal(second.lyrics, wordOnly, 'no copy when nothing changed')
})
