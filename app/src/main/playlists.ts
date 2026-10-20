import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { libraryPathKey } from '@shared/library'
import type { PlaylistDocument, PlaylistEntry, SavedPlaylist } from '@shared/playlists'

let configFile: string | null = null
let playlists: SavedPlaylist[] = []
let loadWarning: string | null = null
let configReady: Promise<void> = Promise.resolve()
let configGeneration = 0
let mutationQueue: Promise<unknown> = Promise.resolve()

function clonePlaylists(value: SavedPlaylist[]): SavedPlaylist[] {
  return value.map(playlist => ({ ...playlist, entries: playlist.entries.map(entry => ({ ...entry })) }))
}

function validEntry(value: unknown): value is PlaylistEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.path === 'string' && path.isAbsolute(entry.path)
}

function parseDocument(text: string): SavedPlaylist[] {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('Invalid playlist document.')
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !Array.isArray(document.playlists)) throw new Error('Unsupported playlist document.')
  const parsed: SavedPlaylist[] = []
  for (const value of document.playlists) {
    if (!value || typeof value !== 'object') throw new Error('Invalid playlist entry.')
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || !Array.isArray(item.entries)
      || !item.entries.every(validEntry)) throw new Error('Invalid playlist entry.')
    const seen = new Set<string>()
    const entries: PlaylistEntry[] = []
    for (const entry of item.entries) {
      const key = libraryPathKey(entry.path)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ path: entry.path })
    }
    parsed.push({ id: item.id, name: item.name.trim(), createdAt: item.createdAt, updatedAt: item.updatedAt, entries })
  }
  return parsed
}

export function configurePlaylists(file: string): void {
  configFile = file
  playlists = []
  loadWarning = null
  const generation = ++configGeneration
  configReady = readFile(file, 'utf8')
    .then(text => {
      if (generation === configGeneration) playlists = parseDocument(text)
    })
    .catch(error => {
      if (generation === configGeneration) {
        playlists = []
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loadWarning = '本地歌单配置无法读取，已按空歌单处理。'
      }
    })
}

export async function readPlaylists(): Promise<SavedPlaylist[]> {
  await configReady
  return clonePlaylists(playlists)
}

export async function readPlaylistWarning(): Promise<string | null> {
  await configReady
  return loadWarning
}

function validateName(value: string): string {
  if (typeof value !== 'string') throw new Error('Playlist name is required.')
  const name = value.trim()
  const length = [...name].length
  if (length < 1 || length > 80) throw new Error('Playlist name must be between 1 and 80 characters.')
  return name
}

function validatePaths(values: string[]): string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('Playlist tracks must use absolute paths.')
  }
  return values
}

async function persist(file: string | null, next: SavedPlaylist[]): Promise<void> {
  if (!file) throw new Error('Playlist storage is not configured.')
  const temporary = file + '.tmp'
  await mkdir(path.dirname(file), { recursive: true })
  try {
    const document: PlaylistDocument = { version: 1, playlists: next }
    await writeFile(temporary, JSON.stringify(document), 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function mutate(operation: (current: SavedPlaylist[]) => SavedPlaylist[]): Promise<SavedPlaylist[]> {
  return serializeMutation(async () => {
    await configReady
    const generation = configGeneration
    const file = configFile
    const next = operation(clonePlaylists(playlists))
    await persist(file, next)
    if (generation === configGeneration) {
      playlists = next
      loadWarning = null
    }
    return clonePlaylists(next)
  })
}

function findPlaylist(items: SavedPlaylist[], id: string): SavedPlaylist {
  const playlist = items.find(item => item.id === id)
  if (!playlist) throw new Error('Playlist not found.')
  return playlist
}

export async function createPlaylist(value: string): Promise<SavedPlaylist[]> {
  const name = validateName(value)
  const now = new Date().toISOString()
  return mutate(items => [{ id: randomUUID(), name, createdAt: now, updatedAt: now, entries: [] }, ...items])
}

export async function renamePlaylist(id: string, value: string): Promise<SavedPlaylist[]> {
  const name = validateName(value)
  const updatedAt = new Date().toISOString()
  return mutate(items => {
    const target = findPlaylist(items, id)
    return items.map(item => item.id === id ? { ...target, name, updatedAt } : item)
  })
}

export async function deletePlaylist(id: string): Promise<SavedPlaylist[]> {
  return mutate(items => {
    findPlaylist(items, id)
    return items.filter(item => item.id !== id)
  })
}

export async function addPlaylistEntries(id: string, values: string[]): Promise<SavedPlaylist[]> {
  const paths = validatePaths(values)
  const updatedAt = new Date().toISOString()
  return mutate(items => {
    findPlaylist(items, id)
    return items.map(item => {
      if (item.id !== id) return item
      const seen = new Set(item.entries.map(entry => libraryPathKey(entry.path)))
      const additions = paths.filter(value => {
        const key = libraryPathKey(value)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).map(value => ({ path: value }))
      return { ...item, updatedAt, entries: [...item.entries, ...additions] }
    })
  })
}

export async function removePlaylistEntry(id: string, value: string): Promise<SavedPlaylist[]> {
  const trackPath = validatePaths([value])[0]!
  const key = libraryPathKey(trackPath)
  const updatedAt = new Date().toISOString()
  return mutate(items => {
    findPlaylist(items, id)
    return items.map(item => item.id === id
      ? { ...item, updatedAt, entries: item.entries.filter(entry => libraryPathKey(entry.path) !== key) }
      : item)
  })
}

export async function reorderPlaylist(id: string, values: string[]): Promise<SavedPlaylist[]> {
  const paths = validatePaths(values)
  return mutate(items => {
    const playlist = findPlaylist(items, id)
    const current = new Map(playlist.entries.map(entry => [libraryPathKey(entry.path), entry]))
    const ordered = paths.map(value => current.get(libraryPathKey(value)))
    if (ordered.length !== current.size || ordered.some(entry => !entry)
      || new Set(paths.map(libraryPathKey)).size !== current.size) {
      throw new Error('Reorder must include each playlist entry exactly once.')
    }
    const updatedAt = new Date().toISOString()
    return items.map(item => item.id === id
      ? { ...item, updatedAt, entries: ordered as PlaylistEntry[] }
      : item)
  })
}
