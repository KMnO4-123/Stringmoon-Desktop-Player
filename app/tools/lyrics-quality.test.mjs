import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTimeline } from '../src/shared/lyrics-quality.ts'

const lyricsEnding = (endMs, startMs = 5000) => ({
  wordByWord: false,
  source: 'netease-lrc',
  lines: [{ startMs, endMs, words: [], text: 'x' }]
})

test('the timeline check uses the margins measured on real tracks', () => {
  // 实测 8 首：歌词末尾比曲长短 1–42 s（片尾器乐）。这些必须全部放行。
  for (const [duration, lastEnd] of [[305000, 263000], [175000, 155000], [187000, 177000], [279000, 275000], [296000, 297000]]) {
    const check = checkTimeline(lyricsEnding(lastEnd), duration)
    assert.equal(check.accept, true, duration + '/' + lastEnd + ' should be accepted')
    assert.equal(check.risky, false, duration + '/' + lastEnd + ' is normal, not risky')
  }
})

test('a lyric that runs far past the track is refused, a mild overrun is only flagged', () => {
  const runaway = checkTimeline(lyricsEnding(300000), 200000)
  assert.equal(runaway.accept, false, '150 s past the end is not this song')
  assert.equal(runaway.issue, 'exceeds_track')

  const longer = checkTimeline(lyricsEnding(245000), 200000)
  assert.equal(longer.accept, true, '45 s over could be a longer edit — flag it, do not drop it')
  assert.equal(longer.risky, true)
  assert.equal(longer.issue, 'overrun')
})

test('lyrics that cover less than half the track are flagged but still used', () => {
  const truncated = checkTimeline(lyricsEnding(100000), 300000)
  assert.equal(truncated.accept, true, 'a truncated lyric still lines up for what it covers')
  assert.equal(truncated.risky, true)
  assert.equal(truncated.issue, 'truncated')
})

test('no duration, tiny tracks, empty lyrics and garbage fall through untouched', () => {
  assert.deepEqual(checkTimeline(lyricsEnding(999999), undefined), { accept: true, risky: false, issue: null })
  assert.deepEqual(checkTimeline(lyricsEnding(999999), 30000), { accept: true, risky: false, issue: null }, 'a 30 s sound effect has no meaningful ratio')
  assert.deepEqual(checkTimeline({ wordByWord: false, source: 'local', lines: [] }, 200000), { accept: true, risky: false, issue: null })
  assert.deepEqual(checkTimeline(lyricsEnding(Number.NaN), 200000), { accept: true, risky: false, issue: null })
})
