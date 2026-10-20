import { create } from 'zustand'
import type { SavedPlaylist } from '@shared/playlists'
import type { TrackMetadataOverride, TrackOverrides } from '@shared/track-overrides'

interface LibraryDataState {
  playlists: SavedPlaylist[]
  overrides: TrackOverrides
  loaded: boolean
  error: string | null
  warnings: string[]
  load: () => Promise<void>
  createPlaylist: (name: string) => Promise<void>
  renamePlaylist: (id: string, name: string) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  addPlaylistEntries: (id: string, paths: string[]) => Promise<void>
  removePlaylistEntry: (id: string, path: string) => Promise<void>
  reorderPlaylist: (id: string, paths: string[]) => Promise<void>
  setTrackOverride: (path: string, patch: TrackMetadataOverride) => Promise<void>
  resetTrackOverride: (path: string, field?: keyof TrackMetadataOverride) => Promise<void>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useLibraryData = create<LibraryDataState>()((set) => {
  const updatePlaylists = async (operation: () => Promise<SavedPlaylist[]>): Promise<void> => {
    try {
      const playlists = await operation()
      const warnings = await window.twilight.libraryDataWarnings()
      set({ playlists, warnings, error: null })
    } catch (error) {
      set({ error: errorText(error) })
      throw error
    }
  }
  const updateOverrides = async (operation: () => Promise<TrackOverrides>): Promise<void> => {
    try {
      const overrides = await operation()
      const warnings = await window.twilight.libraryDataWarnings()
      set({ overrides, warnings, error: null })
    } catch (error) {
      set({ error: errorText(error) })
      throw error
    }
  }
  return {
    playlists: [], overrides: {}, loaded: false, error: null, warnings: [],
    load: async () => {
      try {
        const [playlists, overrides, warnings] = await Promise.all([window.twilight.playlists(), window.twilight.trackOverrides(), window.twilight.libraryDataWarnings()])
        set({ playlists, overrides, warnings, loaded: true, error: null })
      } catch (error) {
        set({ loaded: true, error: errorText(error) })
        throw error
      }
    },
    createPlaylist: name => updatePlaylists(() => window.twilight.createPlaylist(name)),
    renamePlaylist: (id, name) => updatePlaylists(() => window.twilight.renamePlaylist(id, name)),
    deletePlaylist: id => updatePlaylists(() => window.twilight.deletePlaylist(id)),
    addPlaylistEntries: (id, paths) => updatePlaylists(() => window.twilight.addPlaylistEntries(id, paths)),
    removePlaylistEntry: (id, path) => updatePlaylists(() => window.twilight.removePlaylistEntry(id, path)),
    reorderPlaylist: (id, paths) => updatePlaylists(() => window.twilight.reorderPlaylist(id, paths)),
    setTrackOverride: (path, patch) => updateOverrides(() => window.twilight.setTrackOverride(path, patch)),
    resetTrackOverride: (path, field) => updateOverrides(() => window.twilight.resetTrackOverride(path, field))
  }
})
