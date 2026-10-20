import type { EngineRequestCommand, EngineEvent } from '../shared/protocol'
import type { RequestResult } from '../shared/request-result'
import type { ArtworkResult } from '../shared/artwork'
import type { LibraryDirectories } from '../shared/library'
import type { SavedPlaylist } from '../shared/playlists'
import type { TrackMetadataOverride, TrackOverrides } from '../shared/track-overrides'
import type { UnplayableReport } from '../shared/unplayable'
import type { LyricsConfig, LyricsLoadResult, LyricCandidateChoice, LyricsTrackInput, OnlineLyricsOutcome } from '../shared/lyrics-model'
import type { AutoEqModelChoice, EqPresetRecord } from '../shared/eq-model'
import type { IrPrefs } from '../shared/eq-model'
import type { PlaybackMemory } from '../shared/playback-memory'
import type { PrefetchResult } from '../shared/prefetch'
import type { AppInfo, UpdateState } from '../shared/update'
import type { GdSourceStatus, PlatformAccount, PlatformId, PlatformPlaylist, PlatformSession, ProviderRuntime, QrChannel, QrTicket, StreamingConfig, StreamingSimilarResult, StreamingStatus, StreamingTrack } from '../shared/streaming'
import type { AudioCapabilities, DiscoverHome, DiscoverPlatform, DiscoverPlaylistsQuery, DiscoverPlaylistsPage, DiscoverTracksResult } from '../shared/discover'

declare global {
  interface Window {
    twilight: {
      request: (cmd: EngineRequestCommand, timeoutMs?: number) => Promise<RequestResult>
      onEvent: (cb: (ev: EngineEvent) => void) => () => void
      onProtocolError: (cb: (line: string) => void) => () => void
      onDisconnect: (cb: (reason: string) => void) => () => void
      onWindowHidden: (cb: () => void) => () => void
      setMeterDemand: (active: boolean) => void
      playbackMemory: () => Promise<PlaybackMemory | null>
      savePlaybackMemory: (patch: Partial<PlaybackMemory>) => Promise<PlaybackMemory | null>
      clearPlaybackMemory: () => Promise<void>
      prefetchTrack: (file: string) => Promise<PrefetchResult>
      cancelPrefetch: () => Promise<void>
      loadLyrics: (track: { trackId?: string; path?: string }) => Promise<LyricsLoadResult>
      fetchLyricsOnline: (
        track: { trackId?: string; title?: string; artist?: string; album?: string; durationMs?: number; path?: string },
        force?: boolean
      ) => Promise<OnlineLyricsOutcome>
      attachLyrics: (audio: string) => Promise<LyricsConfig | null>
      clearAttachedLyrics: (audio: string) => Promise<LyricsConfig>
      setLyricsOffset: (audio: string, offsetMs: number) => Promise<LyricsConfig>
      saveLyrics: (track: { path: string; title?: string; artist?: string }) => Promise<{ path: string }>
      lyricsCandidates: (track: LyricsTrackInput) => Promise<LyricCandidateChoice[]>
      eqModelsSearch: (query: string, limit?: number) => Promise<AutoEqModelChoice[]>
      eqModelsCount: () => Promise<number>
      eqHeadphoneFetch: (model: { name: string; rig?: string }) => Promise<EqPresetRecord>
      pickImpulse: () => Promise<string | null>
      searchAll: (keyword: string, limit?: number) => Promise<Array<StreamingTrack & { sourceName: string }>>
      downloads: () => Promise<DownloadItem[]>
      downloadAdd: (track: StreamingTrack) => Promise<DownloadItem>
      downloadCancel: (id: string) => Promise<DownloadItem[]>
      downloadClear: () => Promise<DownloadItem[]>
      downloadDirectory: () => Promise<string>
      setDownloadDirectory: (directory: string) => Promise<string>
      pickDownloadDir: () => Promise<string | null>
      onDownloadProgress: (listener: (item: DownloadItem) => void) => () => void
      streamingStatus: () => Promise<StreamingStatus>
      streamingSaveConfig: (config: StreamingConfig) => Promise<StreamingConfig>
      streamingStart: (platform: PlatformId) => Promise<ProviderRuntime>
      streamingStop: (platform: PlatformId) => Promise<ProviderRuntime>
      streamingAccount: (platform: PlatformId) => Promise<PlatformAccount>
      streamingPlaylists: (platform: PlatformId) => Promise<PlatformPlaylist[]>
      streamingLikedSongs: (platform: PlatformId) => Promise<StreamingTrack[]>
      streamingSearchPlaylists: (platform: PlatformId, keyword: string) => Promise<PlatformPlaylist[]>
      streamingPlaylistTracks: (platform: PlatformId, id: string) => Promise<StreamingTrack[]>
      streamingSearch: (platform: PlatformId, keyword: string, limit?: number, offset?: number) => Promise<StreamingTrack[]>
      streamingPlay: (platform: PlatformId, track: StreamingTrack) => Promise<{ token: string; title: string; artist: string }>
      /**
       * 取歌词。只需要歌曲身份（id 是主进程唯一使用的字段），所以形参收窄到这里而不是
       * 要求完整 StreamingTrack —— 调用方（搜索结果/在线曲目卡片）手里的对象本来就只有这几项。
       */
      streamingLyrics: (platform: PlatformId, track: { id: string; title?: string; artist?: string; album?: string }) => Promise<{ lrc: string; translation: string; wordLevel: string }>
      streamingLogout: (platform: PlatformId) => Promise<void>
      /** 立即校验（并在平台支持时续期）会话；不传 platform = 校验全部已登录平台。 */
      streamingVerify: (platform?: PlatformId) => Promise<PlatformSession[]>
      streamingSetSecret: (platform: PlatformId, value: string) => Promise<void>
      streamingSimilar: (track: { id?: string; title?: string; artist?: string; album?: string }) => Promise<StreamingSimilarResult>
      streamingGdSources: () => Promise<GdSourceStatus[]>
      streamingQrStart: (platform: PlatformId, channel?: QrChannel) => Promise<QrTicket>
      streamingQrPoll: (platform: PlatformId) => Promise<QrTicket & { session: string | null }>
      streamingWebLogin: (platform: PlatformId) => Promise<PlatformAccount>
      irPrefs: () => Promise<IrPrefs | null>
      setIrPrefs: (prefs: IrPrefs) => Promise<IrPrefs | null>
      eqPresets: () => Promise<EqPresetRecord[]>
      saveEqPreset: (preset: EqPresetRecord) => Promise<EqPresetRecord[]>
      removeEqPreset: (idOrName: string) => Promise<EqPresetRecord[]>
      applyLyricsCandidate: (track: LyricsTrackInput, candidate: LyricCandidateChoice) => Promise<OnlineLyricsOutcome>
      loadArtwork: (file: string) => Promise<ArtworkResult | null>
      chooseArtwork: (file: string) => Promise<ArtworkResult | null>
      removeArtwork: (file: string) => Promise<ArtworkResult | null>
      libraryDirs: () => Promise<LibraryDirectories>
      addLibraryDir: (directory: string) => Promise<LibraryDirectories>
      removeLibraryDir: (directory: string) => Promise<LibraryDirectories>
      playlists: () => Promise<SavedPlaylist[]>
      libraryDataWarnings: () => Promise<string[]>
      createPlaylist: (name: string) => Promise<SavedPlaylist[]>
      renamePlaylist: (id: string, name: string) => Promise<SavedPlaylist[]>
      deletePlaylist: (id: string) => Promise<SavedPlaylist[]>
      addPlaylistEntries: (id: string, paths: string[]) => Promise<SavedPlaylist[]>
      removePlaylistEntry: (id: string, file: string) => Promise<SavedPlaylist[]>
      reorderPlaylist: (id: string, paths: string[]) => Promise<SavedPlaylist[]>
      trackOverrides: () => Promise<TrackOverrides>
      unplayable: () => Promise<UnplayableReport>
      forgetUnplayable: (file: string) => Promise<UnplayableReport>
      clearUnplayable: () => Promise<UnplayableReport>
      onUnplayableChanged: (cb: () => void) => () => void
      setTrackOverride: (file: string, patch: TrackMetadataOverride) => Promise<TrackOverrides>
      resetTrackOverride: (file: string, field?: keyof TrackMetadataOverride) => Promise<TrackOverrides>
      pickFolder: () => Promise<string | null>
      appInfo: () => Promise<AppInfo>
      updateState: () => Promise<UpdateState>
      checkForUpdates: () => Promise<UpdateState>
      downloadUpdate: () => Promise<UpdateState>
      installUpdate: () => Promise<UpdateState>
      onUpdateStatus: (cb: (state: UpdateState) => void) => () => void
      bootstrap: () => Promise<{ smoke: boolean }>
      discoverHome: (platform?: DiscoverPlatform) => Promise<DiscoverHome>
      discoverToplist: (platform: DiscoverPlatform, id: string) => Promise<DiscoverTracksResult>
      discoverPlaylists: (platform: DiscoverPlatform, query?: DiscoverPlaylistsQuery) => Promise<DiscoverPlaylistsPage>
      discoverPlaylistTracks: (platform: DiscoverPlatform, id: string) => Promise<DiscoverTracksResult>
      audioCapabilities: () => Promise<AudioCapabilities>
    }
  }
}

export {}
