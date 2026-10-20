export interface TrayMenuStatus {
  state: 'playing' | 'paused' | 'stopped'
  trackId: string
  title?: string
  artist?: string
}

export type TrayMenuAction = 'show' | 'previous' | 'toggle' | 'next' | 'quit'

export type TrayMenuItem =
  | { id: 'separator' }
  | { id: 'track'; label: string; enabled: false }
  | { id: TrayMenuAction; label: string; enabled: boolean }

function playbackLabel(state: TrayMenuStatus['state']): string {
  if (state === 'playing') return '正在播放'
  if (state === 'paused') return '已暂停'
  return '已停止'
}

function trackLabel(status: TrayMenuStatus): string {
  if (!status.trackId) return '当前无播放'
  const metadata = [status.title, status.artist].filter(Boolean).join(' · ')
  const label = metadata || playbackLabel(status.state)
  return label.length > 76 ? `${label.slice(0, 75)}…` : label
}

export function buildTrayTooltip(status: TrayMenuStatus): string {
  if (!status.trackId) return 'Stringmoon'
  const playback = playbackLabel(status.state)
  const metadata = [status.title, status.artist].filter(Boolean).join(' · ')
  const track = metadata.length > 76 ? `${metadata.slice(0, 75)}…` : metadata
  return track ? `Stringmoon · ${playback} · ${track}` : `Stringmoon · ${playback}`
}

export function buildTrayMenu(status: TrayMenuStatus): TrayMenuItem[] {
  const hasTrack = Boolean(status.trackId)
  return [
    { id: 'track', label: trackLabel(status), enabled: false },
    { id: 'separator' },
    { id: 'show', label: '打开 Stringmoon', enabled: true },
    { id: 'separator' },
    { id: 'previous', label: '上一首', enabled: hasTrack },
    { id: 'toggle', label: status.state === 'playing' ? '暂停' : '播放', enabled: hasTrack },
    { id: 'next', label: '下一首', enabled: hasTrack },
    { id: 'separator' },
    { id: 'quit', label: '退出 Stringmoon', enabled: true }
  ]
}
