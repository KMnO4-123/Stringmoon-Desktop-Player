import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTtmlTime, serializeTtml } from '../src/shared/ttml-write.ts'
import { parseTtml } from '../src/shared/ttml.ts'

const roundTrip = (lyrics) => parseTtml(serializeTtml(lyrics))

test('written lyrics read back with the same text, timing, translation and romanization', () => {
  const original = {
    wordByWord: false,
    source: 'netease-lrc',
    lines: [
      { startMs: 1000, endMs: 4000, words: [], text: 'これは合成された歌詞の一行です', translation: '其实我早就知道我能飞翔', romanization: 'ho n to u wa so ra wo to be ru' },
      { startMs: 4000, endMs: 8000, words: [], text: 'これも合成された歌詞の二行目', translation: '即便如此仍牵起你的手' }
    ]
  }
  const back = roundTrip(original)
  assert.ok(back)
  assert.equal(back.lines.length, 2)
  assert.deepEqual(back.lines.map(l => [l.startMs, l.endMs, l.text]), [
    [1000, 4000, 'これは合成された歌詞の一行です'],
    [4000, 8000, 'これも合成された歌詞の二行目']
  ])
  assert.equal(back.lines[0].translation, '其实我早就知道我能飞翔')
  assert.equal(back.lines[0].romanization, 'ho n to u wa so ra wo to be ru')
  assert.equal(back.lines[1].romanization, undefined)
  assert.equal(back.wordByWord, false)
})

test('word-level timing survives the round trip', () => {
  const original = {
    wordByWord: true,
    source: 'amll-ttml',
    lines: [{
      startMs: 500, endMs: 3000,
      text: '無敵の笑顔',
      words: [
        { text: '無敵', startMs: 500, endMs: 1200 },
        { text: 'の', startMs: 1200, endMs: 1400 },
        { text: '笑顔', startMs: 1400, endMs: 3000 }
      ],
      translation: '无敌的笑容'
    }]
  }
  const back = roundTrip(original)
  assert.ok(back)
  assert.equal(back.wordByWord, true)
  assert.deepEqual(back.lines[0].words.map(w => [w.text, w.startMs, w.endMs]), [
    ['無敵', 500, 1200], ['の', 1200, 1400], ['笑顔', 1400, 3000]
  ])
  assert.equal(back.lines[0].text, '無敵の笑顔')
  assert.equal(back.lines[0].translation, '无敌的笑容')
})

test('ruby (注音) survives — that is the reason this is TTML and not LRC', () => {
  const original = {
    wordByWord: true, source: 'amll-ttml',
    lines: [{
      startMs: 0, endMs: 2000, text: '所詮',
      words: [
        { text: '所', ruby: 'しょ', startMs: 0, endMs: 900 },
        { text: '詮', ruby: 'せん', startMs: 900, endMs: 2000 }
      ]
    }]
  }
  const back = roundTrip(original)
  assert.ok(back)
  assert.deepEqual(back.lines[0].words.map(w => [w.text, w.ruby, w.startMs, w.endMs]), [
    ['所', 'しょ', 0, 900], ['詮', 'せん', 900, 2000]
  ])
})

test('XML-unsafe characters are escaped, not dropped', () => {
  const original = {
    wordByWord: false, source: 'lrclib',
    lines: [{ startMs: 0, endMs: 2000, words: [], text: '傘 & 街 <3 "ok"', translation: 'a & b' }]
  }
  const text = serializeTtml(original, { musicName: 'A & B', artists: '<test>' })
  assert.ok(text.includes('&amp;'))
  assert.ok(!/<p begin="[^"]*">傘 & 街/.test(text), 'no raw ampersand in the body')
  const back = roundTrip(original)
  assert.equal(back.lines[0].text, '傘 & 街 <3 "ok"')
  assert.equal(back.lines[0].translation, 'a & b')
  assert.ok(text.includes('value="&lt;test&gt;"'), 'metadata is escaped too')
})

test('background vocals keep their flag through the round trip', () => {
  const original = {
    wordByWord: true, source: 'amll-ttml',
    lines: [{
      startMs: 0, endMs: 2000, text: '(信じてる)', background: true,
      words: [{ text: '(信', startMs: 0, endMs: 900 }, { text: 'じてる)', startMs: 900, endMs: 2000 }]
    }]
  }
  const back = roundTrip(original)
  assert.equal(back.lines[0].background, true)
})

test('time formatting is padded, millisecond-exact, and never negative', () => {
  assert.equal(formatTtmlTime(0), '00:00.000')
  assert.equal(formatTtmlTime(61500), '01:01.500')
  assert.equal(formatTtmlTime(3_599_999), '59:59.999')
  assert.equal(formatTtmlTime(-5), '00:00.000')
  assert.equal(formatTtmlTime(Number.NaN), '00:00.000')
})
