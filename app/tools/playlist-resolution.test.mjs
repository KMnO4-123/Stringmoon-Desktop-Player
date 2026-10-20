import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePlaylistEntries } from '../src/renderer/src/libraryModel.ts'

const playlist = {
  id: 'mix-1',
  name: 'Mix',
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  entries: [
    { path: 'D:/Music/one.flac' },
    { path: 'D:/Music/missing.flac' },
    { path: 'D:/Music/two.flac' }
  ]
}

const visibleTracks = [
  { trackId: 'new-1', title: 'One', artist: '', durationMs: 1000, path: 'd:\\music\\one.flac' },
  { trackId: 'new-2', title: 'Two', artist: '', durationMs: 1000, path: 'D:\\Music\\two.flac' },
  { trackId: 'out-of-root', title: 'Other', artist: '', durationMs: 1000, path: 'D:\\Elsewhere\\other.flac' }
]

test('playlist entries resolve by normalized path and preserve unavailable entries in order', () => {
  const result = resolvePlaylistEntries(playlist, visibleTracks)
  assert.deepEqual(result.entries.map(entry => [entry.path, entry.track?.trackId ?? null]), [
    ['D:/Music/one.flac', 'new-1'],
    ['D:/Music/missing.flac', null],
    ['D:/Music/two.flac', 'new-2']
  ])
  assert.deepEqual(result.playable.map(track => track.trackId), ['new-1', 'new-2'])
  assert.equal(result.entries[1].available, false)
})
