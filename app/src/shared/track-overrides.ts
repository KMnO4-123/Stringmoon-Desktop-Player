export interface TrackMetadataOverride {
  title?: string
  artist?: string
  album?: string
  genre?: string
  year?: number
}

export type TrackOverrides = Record<string, TrackMetadataOverride>

export interface TrackOverrideDocument {
  version: 1
  overrides: TrackOverrides
}
