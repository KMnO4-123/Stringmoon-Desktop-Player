import type { Track } from '@shared/protocol'
import type { TrackMetadataOverride, TrackOverrides } from '@shared/track-overrides'
import type { PlaylistEntry, SavedPlaylist } from '@shared/playlists'
import { libraryPathKey } from '@shared/library'
import { displayTrack, type TrackDisplay } from './display'

export interface ArtistGroup { artist: string; tracks: Track[] }

export interface SearchDocument {
  key: string
  /** Track with application-level metadata corrections applied. */
  track: Track
  display: TrackDisplay
  fields: string[]
  normalizedFields: string[]
}

export interface LibraryFilters {
  artist?: string
  album?: string
  genre?: string
  year?: number
  codec?: string
  folder?: string
}

export interface ResolvedPlaylistEntry extends PlaylistEntry {
  track: Track | null
  available: boolean
}

export interface ResolvedPlaylist {
  entries: ResolvedPlaylistEntry[]
  playable: Track[]
}

export interface VirtualRange { start: number; end: number }

export function calculateVirtualRange(rectTop: number, viewportHeight: number, rowHeight: number, itemCount: number, overscan = 4): VirtualRange {
  const count = Math.max(0, Math.floor(itemCount))
  if (count === 0) return { start: 0, end: 0 }
  const height = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 64
  const padding = Math.max(0, Math.floor(overscan))
  const top = Math.max(0, -rectTop)
  const bottom = Math.min(count * height, viewportHeight - rectTop)
  const start = Math.min(count, Math.max(0, Math.floor(top / height) - padding))
  const minimumEnd = Math.min(count, start + padding * 2 + 1)
  const end = Math.min(count, Math.max(minimumEnd, Math.ceil(bottom / height) + padding))
  return { start, end }
}

const normalizeSearchText = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()

export function applyTrackOverride(track: Track, overrides: TrackOverrides): Track {
  const override = overrides[libraryPathKey(track.path)]
  return override ? { ...track, ...override } : track
}

function searchFields(track: Track, display: TrackDisplay): string[] {
  const filename = track.path.split(/[\\/]/).pop() ?? ''
  return [
    display.title,
    display.artist,
    track.albumArtist ?? '',
    track.album ?? '',
    track.genre ?? '',
    track.year === undefined ? '' : String(track.year),
    track.codec ?? '',
    filename,
    track.path
  ]
}

export function buildSearchDocuments(tracks: Track[], overrides: TrackOverrides = {}): SearchDocument[] {
  return tracks.map(track => {
    const override = overrides[libraryPathKey(track.path)]
    const effectiveTrack = applyTrackOverride(track, overrides)
    const display = displayTrack(effectiveTrack, override)
    const fields = searchFields(effectiveTrack, display)
    return {
      key: libraryPathKey(track.path),
      track: effectiveTrack,
      display,
      fields,
      normalizedFields: fields.map(normalizeSearchText)
    }
  })
}

function matchesFilter(value: string | undefined, filter: string | undefined): boolean {
  return filter === undefined || normalizeSearchText(value ?? '') === normalizeSearchText(filter.trim())
}

function matchesFolder(trackPath: string, folder: string | undefined): boolean {
  if (folder === undefined) return true
  const pathKey = libraryPathKey(trackPath)
  const folderKey = libraryPathKey(folder)
  return Boolean(folderKey && (pathKey === folderKey || pathKey.startsWith(folderKey + '\\')))
}

export function filterSearchDocuments(
  documents: SearchDocument[],
  query: string,
  filters: LibraryFilters = {}
): SearchDocument[] {
  const tokens = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean)
  return documents.filter(document => {
    const track = document.track
    if (!matchesFilter(document.display.artist, filters.artist) ||
        !matchesFilter(track.album, filters.album) ||
        !matchesFilter(track.genre, filters.genre) ||
        (filters.year !== undefined && track.year !== filters.year) ||
        !matchesFilter(track.codec, filters.codec) ||
        !matchesFolder(track.path, filters.folder)) return false

    return tokens.every(token => document.normalizedFields.some(field => field.includes(token)))
  })
}

export function resolvePlaylistEntries(playlist: SavedPlaylist, visibleTracks: Track[]): ResolvedPlaylist {
  const tracksByPath = new Map<string, Track>()
  for (const track of visibleTracks) tracksByPath.set(libraryPathKey(track.path), track)

  const entries = playlist.entries.map(entry => {
    const track = tracksByPath.get(libraryPathKey(entry.path)) ?? null
    return { ...entry, track, available: track !== null }
  })
  return { entries, playable: entries.flatMap(entry => entry.track ? [entry.track] : []) }
}

export function groupArtists(tracks: Track[]): ArtistGroup[] {
  const groups = new Map<string, ArtistGroup>()
  for (const track of tracks) {
    const artist = displayTrack(track).artist || '未知艺术家'
    if (!groups.has(artist)) groups.set(artist, { artist, tracks: [] })
    groups.get(artist)!.tracks.push(track)
  }
  return [...groups.values()]
}

export function filterTracks<T extends Track>(tracks: T[], query: string, artist?: string): T[] {
  const documents = buildSearchDocuments(tracks)
  return filterSearchDocuments(documents, query, artist ? { artist } : undefined).map(document => document.track as T)
}
