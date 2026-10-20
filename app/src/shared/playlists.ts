export interface PlaylistEntry {
  path: string
}

export interface SavedPlaylist {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  entries: PlaylistEntry[]
}

export interface PlaylistDocument {
  version: 1
  playlists: SavedPlaylist[]
}
