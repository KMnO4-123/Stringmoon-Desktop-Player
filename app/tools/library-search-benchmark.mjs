import { performance } from 'node:perf_hooks'
import { buildSearchDocuments, filterSearchDocuments } from '../src/renderer/src/libraryModel.ts'

const tracks = Array.from({ length: 10_000 }, (_, index) => ({
  trackId: 'synthetic-' + index,
  title: 'Track ' + index + ' Cafe\u0301',
  artist: 'Artist ' + (index % 100),
  albumArtist: 'Artist ' + (index % 100),
  album: 'Album ' + (index % 250),
  genre: index % 2 ? 'Ambient' : 'Classical',
  year: 2000 + index % 25,
  durationMs: 180_000 + index,
  path: 'D:/Music/Artist ' + (index % 100) + '/track-' + index + '.flac',
  codec: index % 3 ? 'FLAC' : 'MP3'
}))

const buildStart = performance.now()
const documents = buildSearchDocuments(tracks)
const buildMs = performance.now() - buildStart
const searchStart = performance.now()
const matches = filterSearchDocuments(documents, 'artist 42 flac cafe')
const searchMs = performance.now() - searchStart

console.log(JSON.stringify({ tracks: tracks.length, buildMs: Number(buildMs.toFixed(2)), searchMs: Number(searchMs.toFixed(2)), matches: matches.length }))
