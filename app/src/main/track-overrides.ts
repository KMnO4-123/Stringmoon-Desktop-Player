import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { libraryPathKey } from '@shared/library'
import type { TrackMetadataOverride, TrackOverrideDocument, TrackOverrides } from '@shared/track-overrides'

const FIELDS = ['title', 'artist', 'album', 'genre', 'year'] as const
type OverrideField = typeof FIELDS[number]

let configFile: string | null = null
let overrides: TrackOverrides = {}
let loadWarning: string | null = null
let configReady: Promise<void> = Promise.resolve()
let configGeneration = 0
let mutationQueue: Promise<unknown> = Promise.resolve()

function cloneOverrides(value: TrackOverrides): TrackOverrides {
  return Object.fromEntries(Object.entries(value).map(([key, fields]) => [key, { ...fields }]))
}

function parseOverride(value: unknown): TrackMetadataOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid track override.')
  const record = value as Record<string, unknown>
  const result: TrackMetadataOverride = {}
  for (const [field, entry] of Object.entries(record)) {
    if (!FIELDS.includes(field as OverrideField)) throw new Error('Invalid track override field.')
    if (field === 'year') {
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1000 || entry > 9999) throw new Error('Invalid year override.')
      result.year = entry
    } else {
      if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > 512) throw new Error(`Invalid ${field} override.`)
      result[field as 'title' | 'artist' | 'album' | 'genre'] = entry.trim()
    }
  }
  if (Object.keys(result).length === 0) throw new Error('Track override must contain at least one field.')
  return result
}

function parseDocument(text: string): TrackOverrides {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid track override document.')
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !document.overrides || typeof document.overrides !== 'object' || Array.isArray(document.overrides)) {
    throw new Error('Unsupported track override document.')
  }
  const parsed: TrackOverrides = {}
  for (const [rawKey, value] of Object.entries(document.overrides)) {
    const key = libraryPathKey(rawKey)
    if (!key || !path.isAbsolute(key)) throw new Error('Invalid track identity in override document.')
    parsed[key] = parseOverride(value)
  }
  return parsed
}

export function configureTrackOverrides(file: string): void {
  configFile = file
  overrides = {}
  loadWarning = null
  const generation = ++configGeneration
  configReady = readFile(file, 'utf8')
    .then(text => {
      if (generation === configGeneration) overrides = parseDocument(text)
    })
    .catch(error => {
      if (generation === configGeneration) {
        overrides = {}
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loadWarning = '本地歌曲信息修正无法读取，已按原始标签显示。'
      }
    })
}

export async function readTrackOverrides(): Promise<TrackOverrides> {
  await configReady
  return cloneOverrides(overrides)
}

export async function readTrackOverrideWarning(): Promise<string | null> {
  await configReady
  return loadWarning
}

function validateTrackPath(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Track path must be absolute.')
  const key = libraryPathKey(value)
  if (!key) throw new Error('Track path is required.')
  return key
}

async function persist(file: string | null, next: TrackOverrides): Promise<void> {
  if (!file) throw new Error('Track override storage is not configured.')
  const temporary = file + '.tmp'
  await mkdir(path.dirname(file), { recursive: true })
  try {
    const document: TrackOverrideDocument = { version: 1, overrides: next }
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

function mutate(operation: (current: TrackOverrides) => TrackOverrides): Promise<TrackOverrides> {
  return serializeMutation(async () => {
    await configReady
    const generation = configGeneration
    const file = configFile
    const next = operation(cloneOverrides(overrides))
    await persist(file, next)
    if (generation === configGeneration) {
      overrides = next
      loadWarning = null
    }
    return cloneOverrides(next)
  })
}

export async function setTrackOverride(filePath: string, patch: TrackMetadataOverride): Promise<TrackOverrides> {
  const key = validateTrackPath(filePath)
  const validated = parseOverride(patch)
  return mutate(current => ({ ...current, [key]: { ...current[key], ...validated } }))
}

export async function resetTrackOverride(filePath: string, field?: OverrideField): Promise<TrackOverrides> {
  const key = validateTrackPath(filePath)
  if (field !== undefined && !FIELDS.includes(field)) throw new Error('Invalid track override field.')
  return mutate(current => {
    const existing = current[key]
    if (!existing) return current
    if (!field) {
      delete current[key]
      return current
    }
    const next = { ...existing }
    delete next[field]
    if (Object.keys(next).length === 0) delete current[key]
    else current[key] = next
    return current
  })
}
