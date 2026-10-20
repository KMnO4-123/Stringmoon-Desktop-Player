import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTrackOverride,
  buildSearchDocuments,
  filterSearchDocuments,
  groupArtists,
  filterTracks,
  calculateVirtualRange
} from '../src/renderer/src/libraryModel.ts'
import { displayTrack } from '../src/renderer/src/display.ts'

const tracks = [
  { trackId: 'tl_0001', title: 'Test Artist - 测试曲目', artist: '', durationMs: 1000, path: 'a.flac' },
  { trackId: 'tl_0002', title: 'another', artist: ' Test Artist ', durationMs: 2000, path: 'b.flac' },
  { trackId: 'tl_0003', title: '你好', artist: '另一位', durationMs: 3000, path: 'c.flac' }
]
test('artist grouping uses the same displayed metadata as the player without changing track IDs', () => {
  const groups = groupArtists(tracks)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].tracks.map(t => t.trackId), ['tl_0001', 'tl_0002'])
  assert.equal(groups[0].artist, 'Test Artist')
  assert.equal(tracks[0].artist, '')
})
test('search combines the artist filter and displayed title, including whitespace and casing', () => {
  assert.deepEqual(filterTracks(tracks, '  TEST ARTIST  ').map(t => t.trackId), ['tl_0001', 'tl_0002'])
  assert.deepEqual(filterTracks(tracks, '测试', 'Test Artist').map(t => t.trackId), ['tl_0001'])
  assert.deepEqual(filterTracks(tracks, '你好', 'Test Artist'), [])
})

const indexedTracks = [
  { trackId: 'tl_0001', title: 'Café live', artist: 'Test Singer', albumArtist: 'Test Artist', album: 'Live in 東京', genre: 'Pop', year: 2024, codec: 'FLAC', durationMs: 1000, path: 'D:/Music/First.flac' },
  { trackId: 'tl_0002', title: 'Hello', artist: '世界', albumArtist: 'Other', album: '你好', genre: 'Jazz', year: 2020, codec: 'MP3', durationMs: 2000, path: 'D:/Archive/hello.mp3' }
]

test('search ANDs normalized tokens across effective metadata fields and path', () => {
  const docs = buildSearchDocuments(indexedTracks, {})
  for (const query of ['test singer live', 'test artist flac', '東京 2024', 'first d:/music', 'pop cafe']) {
    assert.deepEqual(filterSearchDocuments(docs, query).map(doc => doc.track.trackId), ['tl_0001'], query)
  }
  assert.deepEqual(filterSearchDocuments(docs, '世界 你好').map(doc => doc.track.trackId), ['tl_0002'])
  assert.deepEqual(filterSearchDocuments(docs, '').map(doc => doc.track.trackId), ['tl_0001', 'tl_0002'])
})

test('metadata overrides are path-keyed, applied to effective tracks, and do not mutate engine records', () => {
  const original = indexedTracks[0]
  const overrides = { 'd:\\music\\first.flac': { title: 'Dejá vu', artist: 'Zoë', album: 'Corrected album', genre: 'Ambient', year: 1999 } }
  const effective = applyTrackOverride(original, overrides)
  assert.deepEqual(displayTrack(original, overrides['d:\\music\\first.flac']), { title: 'Dejá vu', artist: 'Zoë' })
  assert.equal(effective.title, 'Dejá vu')
  assert.equal(effective.album, 'Corrected album')
  assert.equal(original.title, 'Café live')
  assert.deepEqual(filterSearchDocuments(buildSearchDocuments([original], overrides), 'deja zoe corrected 1999').map(doc => doc.track.title), ['Dejá vu'])
})

test('metadata filters select exact normalized values including the folder filter', () => {
  const docs = buildSearchDocuments(indexedTracks, {})
  assert.deepEqual(filterSearchDocuments(docs, '', { artist: 'Test Singer', album: 'Live in 東京', genre: 'pop', year: 2024, codec: 'flac', folder: 'D:/Music' }).map(doc => doc.track.trackId), ['tl_0001'])
})

test('virtual range remains bounded for a 10,000-track list at initial and deep scroll positions', () => {
  const rowHeight = 64
  const viewportHeight = 765
  const total = 10_000
  for (const rectTop of [400, 2000, -320_000, -638_000]) {
    const range = calculateVirtualRange(rectTop, viewportHeight, rowHeight, total)
    assert.ok(range.start >= 0 && range.start <= range.end && range.end <= total)
    assert.ok(range.end - range.start <= Math.ceil(viewportHeight / rowHeight) + 9, JSON.stringify({ rectTop, range }))
  }
  assert.deepEqual(calculateVirtualRange(2000, viewportHeight, rowHeight, total), { start: 0, end: 9 })
  assert.deepEqual(calculateVirtualRange(0, viewportHeight, rowHeight, 0), { start: 0, end: 0 })
})
