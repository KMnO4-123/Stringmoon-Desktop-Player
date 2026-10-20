/**
 * 流媒体来源的界面状态（与 store.ts 分开）。
 *
 * 为什么单独一个 store：曲库 store 里的每个字段都参与「引擎状态 → 界面」的权威同步
 * （selectLoadedTrack、applyEvent 之类），把"当前选了哪个来源"塞进去会让那套不变式
 * 变模糊。来源是**纯界面选择**，不来自引擎，所以它自己住。
 */
import { create } from 'zustand'
import type { PlatformAccount, PlatformId, PlatformPlaylist } from '@shared/streaming'

export type SourceId = 'local' | PlatformId

export interface PlatformPlaylistRef {
  platform: PlatformId
  id: string
  name: string
}

interface StreamingUiState {
  accounts: Partial<Record<PlatformId, PlatformAccount | null>>
  playlists: Partial<Record<PlatformId, PlatformPlaylist[]>>
  /** 歌曲中心搜索用的来源。 */
  activeSource: SourceId
  /** 歌单一栏显示的来源。 */
  playlistSource: SourceId
  /** 在歌曲中心打开的那张平台歌单；null 表示显示搜索结果。 */
  openedPlaylist: PlatformPlaylistRef | null
  playlistError: string | null
  loadingPlaylists: boolean
  selectSource: (source: SourceId) => void
  selectPlaylistSource: (source: SourceId) => Promise<void>
  loadAccount: (platform: PlatformId) => Promise<void>
  loadPlaylists: (platform: PlatformId) => Promise<void>
  openPlaylist: (ref: PlatformPlaylistRef | null) => void
  logoutAccount: (platform: PlatformId) => Promise<void>
}

export const useStreamingUi = create<StreamingUiState>()((set, get) => ({
  accounts: {},
  playlists: {},
  activeSource: 'local',
  playlistSource: 'local',
  openedPlaylist: null,
  playlistError: null,
  loadingPlaylists: false,

  selectSource: (source) => set({ activeSource: source, openedPlaylist: source === 'local' ? null : get().openedPlaylist }),

  async selectPlaylistSource(source) {
    set({ playlistSource: source, playlistError: null })
    if (source === 'local') return
    await get().loadPlaylists(source)
  },

  async loadAccount(platform) {
    try {
      const account = await window.twilight.streamingAccount(platform) as PlatformAccount
      set(state => ({ accounts: { ...state.accounts, [platform]: account } }))
    } catch {
      set(state => ({ accounts: { ...state.accounts, [platform]: null } }))
    }
  },

  async loadPlaylists(platform) {
    set({ loadingPlaylists: true, playlistError: null })
    try {
      const list = await window.twilight.streamingPlaylists(platform) as PlatformPlaylist[]
      set(state => ({ playlists: { ...state.playlists, [platform]: list } }))
      if (list.length === 0) {
        const account = get().accounts[platform]
        if (!account?.signedIn) set({ playlistError: '登录后可以看到你的歌单。' })
      }
    } catch (error) {
      set({
        playlistError: error instanceof Error ? error.message : String(error),
        playlists: { ...get().playlists, [platform]: [] }
      })
    } finally {
      set({ loadingPlaylists: false })
    }
  },

  openPlaylist: (ref) => set({ openedPlaylist: ref }),

  async logoutAccount(platform) {
    await window.twilight.streamingLogout(platform)
    set(state => ({
      accounts: { ...state.accounts, [platform]: { platform, signedIn: false, uid: null, nickname: null, avatar: null } },
      playlists: { ...state.playlists, [platform]: [] }
    }))
  }
}))
