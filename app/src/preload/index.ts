import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EngineRequestCommand, EngineEvent } from '@shared/protocol'
import type { RequestResult } from '@shared/request-result'
import type { ArtworkResult } from '@shared/artwork'
import type { LibraryDirectories } from '@shared/library'
import type { SavedPlaylist } from '@shared/playlists'
import type { TrackMetadataOverride, TrackOverrides } from '@shared/track-overrides'
import type { UnplayableReport } from '@shared/unplayable'
import type { LyricsConfig, LyricsLoadResult, OnlineLyricsOutcome } from '@shared/lyrics-model'
import type { PlaybackMemory } from '@shared/playback-memory'
import type { PrefetchResult } from '@shared/prefetch'
import type { AppInfo, UpdateState } from '@shared/update'
import type { GdSourceStatus, StreamingSimilarResult } from '@shared/streaming'
import type { AudioCapabilities, DiscoverHome, DiscoverPlatform, DiscoverPlaylistsQuery, DiscoverPlaylistsPage, DiscoverTracksResult } from '@shared/discover'

/**
 * preload 白名单（BRIEF-B §3.6）：渲染进程不是 Node 环境。
 * 只暴露这几个显式通道；不暴露任何 fs / child_process / remote 能力。
 * request 传输可序列化的结果；渲染层重建 Error，保留 code/kind。
 */
const api = {
  request: (cmd: EngineRequestCommand, timeoutMs?: number): Promise<RequestResult> =>
    ipcRenderer.invoke('twilight:request', cmd, timeoutMs),
  onEvent: (cb: (ev: EngineEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: EngineEvent): void => cb(ev)
    ipcRenderer.on('twilight:event', listener)
    return () => {
      ipcRenderer.removeListener('twilight:event', listener)
    }
  },
  onProtocolError: (cb: (line: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, line: string): void => cb(line)
    ipcRenderer.on('twilight:protocol-error', listener)
    return () => {
      ipcRenderer.removeListener('twilight:protocol-error', listener)
    }
  },
  onDisconnect: (cb: (reason: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, reason: string): void => cb(reason)
    ipcRenderer.on('twilight:disconnect', listener)
    return () => ipcRenderer.removeListener('twilight:disconnect', listener)
  },
  onWindowHidden: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('twilight:window-hidden', listener)
    return () => ipcRenderer.removeListener('twilight:window-hidden', listener)
  },
  // A5：当前视图有没有 meter 消费者（频谱/沉浸光效/监测）。开关是单向信号，
  // 用 send 不用 invoke —— 不需要回复，也不该为它维持一条请求的生命周期。
  setMeterDemand: (active: boolean): void => ipcRenderer.send('twilight:meter-demand', active === true),
  // ---- 播放记忆 / 下一首预热（ECHO NEXT 对标功能）-------------------------
  // 播放记忆是「上次听到哪里」，恢复由渲染层做成「已加载暂停」，主进程绝不自动播。
  playbackMemory: (): Promise<PlaybackMemory | null> => ipcRenderer.invoke('twilight:playback-memory-get'),
  savePlaybackMemory: (patch: Partial<PlaybackMemory>): Promise<PlaybackMemory | null> =>
    ipcRenderer.invoke('twilight:playback-memory-set', patch),
  clearPlaybackMemory: (): Promise<void> => ipcRenderer.invoke('twilight:playback-memory-clear'),
  // 预热下一首本地文件：主进程只读进 OS 页缓存，不解析、不出声、可被下一次调用取消。
  prefetchTrack: (file: string): Promise<PrefetchResult> => ipcRenderer.invoke('twilight:prefetch-track', file),
  cancelPrefetch: (): Promise<void> => ipcRenderer.invoke('twilight:prefetch-cancel'),
  loadLyrics: (track: { trackId?: string; path?: string }): Promise<LyricsLoadResult> =>
    ipcRenderer.invoke('twilight:lyrics', track),
  // 在线取词由主进程做（限速、计分、缓存都在那边）；渲染层只决定要不要发起。
  fetchLyricsOnline: (
    track: { trackId?: string; title?: string; artist?: string; album?: string; durationMs?: number; path?: string },
    force?: boolean
  ): Promise<OnlineLyricsOutcome> => ipcRenderer.invoke('twilight:lyrics-online', track, force === true),
  attachLyrics: (audio: string): Promise<LyricsConfig | null> => ipcRenderer.invoke('twilight:lyrics-attach', audio),
  clearAttachedLyrics: (audio: string): Promise<LyricsConfig> => ipcRenderer.invoke('twilight:lyrics-clear', audio),
  setLyricsOffset: (audio: string, offsetMs: number): Promise<LyricsConfig> => ipcRenderer.invoke('twilight:lyrics-offset', audio, offsetMs),
  // 把在线歌词保存为音乐旁边的同名 .ttml（本地文件永远优先，之后不再联网）。
  saveLyrics: (track: { path: string; title?: string; artist?: string }): Promise<{ path: string }> => ipcRenderer.invoke('twilight:lyrics-save', track),
  lyricsCandidates: (track: unknown): Promise<unknown[]> => ipcRenderer.invoke('twilight:lyrics-candidates', track),
  // 用户导入的均衡器预设：主进程 JSON 持久化（与歌单/覆盖同一条路）。
  eqModelsSearch: (query: string, limit = 20): Promise<unknown[]> => ipcRenderer.invoke('twilight:eq-models-search', query, limit),
  // 主进程索引里有多少型号（140KB 索引不进渲染层包；界面用它显示「共 N 个型号」）。
  // 这个 handler 一直存在却没有 preload 桥（IPC 落地审计 2026-10-17 发现）。
  eqModelsCount: (): Promise<number> => ipcRenderer.invoke('twilight:eq-models-count'),
  eqHeadphoneFetch: (model: { name: string; rig?: string }): Promise<unknown> => ipcRenderer.invoke('twilight:eq-headphone-fetch', model),
  pickImpulse: (): Promise<string | null> => ipcRenderer.invoke('twilight:pick-impulse'),
  // 平台接入（CONTRACT §4）。渲染层只碰本地 URL 与状态，永远拿不到服务端凭据。
  searchAll: (keyword: string, limit = 20): Promise<unknown> => ipcRenderer.invoke('twilight:search-all', keyword, limit),
  downloads: (): Promise<unknown[]> => ipcRenderer.invoke('twilight:downloads'),
  downloadAdd: (track: unknown): Promise<unknown> => ipcRenderer.invoke('twilight:download-add', track),
  downloadCancel: (id: string): Promise<unknown[]> => ipcRenderer.invoke('twilight:download-cancel', id),
  downloadClear: (): Promise<unknown[]> => ipcRenderer.invoke('twilight:download-clear'),
  downloadDirectory: (): Promise<string> => ipcRenderer.invoke('twilight:download-directory'),
  setDownloadDirectory: (directory: string): Promise<string> => ipcRenderer.invoke('twilight:download-directory-set', directory),
  pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('twilight:pick-download-dir'),
  onDownloadProgress: (listener: (item: unknown) => void): (() => void) => {
    const handler = (_event: unknown, item: unknown): void => listener(item)
    ipcRenderer.on('twilight:download-progress', handler)
    return () => { ipcRenderer.removeListener('twilight:download-progress', handler) }
  },
  streamingStatus: (): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-status'),
  streamingSaveConfig: (config: unknown): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-config-save', config),
  streamingStart: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-start', platform),
  streamingStop: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-stop', platform),
  streamingAccount: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-account', platform),
  streamingPlaylists: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-playlists', platform),
  streamingLikedSongs: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-liked-songs', platform),
  streamingSearchPlaylists: (platform: string, keyword: string): Promise<unknown> =>
    ipcRenderer.invoke('twilight:streaming-search-playlists', platform, keyword),
  streamingPlaylistTracks: (platform: string, id: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-playlist-tracks', platform, id),
  streamingSearch: (platform: string, keyword: string, limit?: number, offset?: number): Promise<unknown> =>
    ipcRenderer.invoke('twilight:streaming-search', platform, keyword, limit, offset),
  streamingPlay: (platform: string, track: unknown): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-play', platform, track),
  streamingLyrics: (platform: string, track: unknown): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-lyrics', platform, track),
  streamingLogout: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-logout', platform),
  /** 立即校验（并在平台支持时续期）会话；不传 platform = 校验全部已登录平台。 */
  streamingVerify: (platform?: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-verify', platform),
  // Meting 的服务端共享令牌（不是账号会话）：d.ts 与渲染层早已在用这个名字，
  // 但 preload 之前漏了它 —— 类型检查看 d.ts 所以永远是绿的，只有点「保存令牌」
  // 时才会炸成 "not a function"。preload-surface.test.mjs 是这类漏暴露的闸。
  streamingSetSecret: (platform: string, value: string): Promise<void> =>
    ipcRenderer.invoke('twilight:streaming-secret', platform, value),
  // GD 音乐台（v3 §1.3）：相似歌曲与上游源可用性。source 信息由 track.id 携带。
  streamingSimilar: (track: { id?: string; title?: string; artist?: string; album?: string }): Promise<StreamingSimilarResult> =>
    ipcRenderer.invoke('twilight:streaming-similar', track),
  streamingGdSources: (): Promise<GdSourceStatus[]> => ipcRenderer.invoke('twilight:streaming-gd-sources'),
  streamingQrStart: (platform: string, channel?: string): Promise<unknown> =>
    ipcRenderer.invoke('twilight:streaming-qr-start', platform, channel),
  streamingQrPoll: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-qr-poll', platform),
  streamingWebLogin: (platform: string): Promise<unknown> => ipcRenderer.invoke('twilight:streaming-web-login', platform),
  irPrefs: (): Promise<unknown> => ipcRenderer.invoke('twilight:eq-ir-prefs'),
  setIrPrefs: (prefs: unknown): Promise<unknown> => ipcRenderer.invoke('twilight:eq-ir-prefs-set', prefs),
  eqPresets: (): Promise<unknown[]> => ipcRenderer.invoke('twilight:eq-presets'),
  saveEqPreset: (preset: unknown): Promise<unknown[]> => ipcRenderer.invoke('twilight:eq-preset-save', preset),
  removeEqPreset: (idOrName: string): Promise<unknown[]> => ipcRenderer.invoke('twilight:eq-preset-remove', idOrName),
  applyLyricsCandidate: (track: unknown, candidate: unknown): Promise<OnlineLyricsOutcome> => ipcRenderer.invoke('twilight:lyrics-apply-candidate', track, candidate),
  loadArtwork: (file: string): Promise<ArtworkResult | null> => ipcRenderer.invoke('twilight:artwork', file),
  chooseArtwork: (file: string): Promise<ArtworkResult | null> => ipcRenderer.invoke('twilight:choose-artwork', file),
  removeArtwork: (file: string): Promise<ArtworkResult | null> => ipcRenderer.invoke('twilight:remove-artwork', file),
  libraryDirs: (): Promise<LibraryDirectories> => ipcRenderer.invoke('twilight:library-dirs'),
  addLibraryDir: (directory: string): Promise<LibraryDirectories> => ipcRenderer.invoke('twilight:library-add', directory),
  removeLibraryDir: (directory: string): Promise<LibraryDirectories> => ipcRenderer.invoke('twilight:library-remove', directory),
  playlists: (): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlists'),
  libraryDataWarnings: (): Promise<string[]> => ipcRenderer.invoke('twilight:library-data-warnings'),
  createPlaylist: (name: string): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlist-create', name),
  renamePlaylist: (id: string, name: string): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlist-rename', id, name),
  deletePlaylist: (id: string): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlist-delete', id),
  addPlaylistEntries: (id: string, paths: string[]): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlist-add', id, paths),
  removePlaylistEntry: (id: string, file: string): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlist-remove', id, file),
  reorderPlaylist: (id: string, paths: string[]): Promise<SavedPlaylist[]> => ipcRenderer.invoke('twilight:playlist-reorder', id, paths),
  trackOverrides: (): Promise<TrackOverrides> => ipcRenderer.invoke('twilight:track-overrides'),
  // 无法播放的曲目记录：查看与恢复。恢复只是忘掉判定，不触碰磁盘。
  unplayable: (): Promise<UnplayableReport> => ipcRenderer.invoke('twilight:unplayable'),
  forgetUnplayable: (file: string): Promise<UnplayableReport> => ipcRenderer.invoke('twilight:unplayable-forget', file),
  clearUnplayable: (): Promise<UnplayableReport> => ipcRenderer.invoke('twilight:unplayable-clear'),
  onUnplayableChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('twilight:unplayable-changed', listener)
    return () => ipcRenderer.removeListener('twilight:unplayable-changed', listener)
  },
  setTrackOverride: (file: string, patch: TrackMetadataOverride): Promise<TrackOverrides> => ipcRenderer.invoke('twilight:track-override-set', file, patch),
  resetTrackOverride: (file: string, field?: keyof TrackMetadataOverride): Promise<TrackOverrides> => ipcRenderer.invoke('twilight:track-override-reset', file, field),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('twilight:pick-folder'),
  // ---- 应用信息与自动更新（PACKAGING-v1）--------------------------------
  // 渲染层只拿可序列化状态；更新源配置/下载/安装都在主进程（见 main/updater.ts）。
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('twilight:app-info'),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('twilight:update-state'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('twilight:update-check'),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('twilight:update-download'),
  installUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('twilight:update-install'),
  onUpdateStatus: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState): void => cb(state)
    ipcRenderer.on('twilight:update-status', listener)
    return () => { ipcRenderer.removeListener('twilight:update-status', listener) }
  },
  bootstrap: (): Promise<{ smoke: boolean }> => ipcRenderer.invoke('twilight:bootstrap'),
  // ---- 发现页（v4 PLAN §1.1）--------------------------------------------
  // 这四个方法的行为约定：**永不因单区块失败而整体 reject**，错误写在返回结构里。
  // 渲染层因此不需要给每个调用套 try/catch 来做降级展示（真正的 IPC 层失败除外）。
  discoverHome: (platform: DiscoverPlatform = 'netease'): Promise<DiscoverHome> =>
    ipcRenderer.invoke('twilight:discover-home', platform),
  // 榜单 id 就是该平台自己的榜单 id（网易云=歌单 id；QQ=/recommend/toplist 的 topId）。
  discoverToplist: (platform: DiscoverPlatform, id: string): Promise<DiscoverTracksResult> =>
    ipcRenderer.invoke('twilight:discover-toplist', platform, id),
  // page 从 1 开始（offset = (page-1)*30），返回 hasMore/total 供「加载更多」用。
  discoverPlaylists: (platform: DiscoverPlatform, query: DiscoverPlaylistsQuery = {}): Promise<DiscoverPlaylistsPage> =>
    ipcRenderer.invoke('twilight:discover-playlists', platform, query),
  discoverPlaylistTracks: (platform: DiscoverPlatform, id: string): Promise<DiscoverTracksResult> =>
    ipcRenderer.invoke('twilight:discover-playlist-tracks', platform, id),
  // 解码能力矩阵：引擎 get_capabilities 优先，旧引擎/失败时回静态矩阵（engine=null）。
  audioCapabilities: (): Promise<AudioCapabilities> => ipcRenderer.invoke('twilight:audio-capabilities')
}

contextBridge.exposeInMainWorld('twilight', api)
