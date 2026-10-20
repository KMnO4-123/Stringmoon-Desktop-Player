import type { Track } from '@shared/protocol'
import type { TrackMetadataOverride } from '@shared/track-overrides'

export interface TrackDisplay {
  title: string
  artist: string
}

/**
 * 展示层拆分（只影响显示，不改协议数据）：
 * 测试库的 FLAC 标签大多为空，引擎如实返回 title=文件名词干、artist=''。
 * 文件名遵循「Artist - Title」惯例时，显示层拆开；标签齐全时原样显示。
 * trackId / path 等协议字段永远原样使用（CONTRACT §3.5：前端不得自行生成 id）。
 */
export function displayTrack(t: Track, override?: TrackMetadataOverride): TrackDisplay {
  const title = override?.title ?? t.title
  const hasArtistOverride = override?.artist !== undefined
  const artist = typeof override?.artist === 'string'
    ? override.artist.trim()
    : typeof t.artist === 'string' ? t.artist.trim() : ''
  if (artist || hasArtistOverride) return { title, artist }
  const m = title.match(/^(.+?)\s+-\s+(.+)$/)
  if (m && m[1] && m[2]) return { title: m[2], artist: m[1].trim() }
  return { title, artist: '' }
}

/** 列表行悬浮提示：展示原始文件名词干，避免拆分后的信息丢失 */
export function rawTrackLabel(t: Track): string {
  const artist = typeof t.artist === 'string' ? t.artist.trim() : ''
  return artist ? t.title + ' — ' + artist : t.title
}
