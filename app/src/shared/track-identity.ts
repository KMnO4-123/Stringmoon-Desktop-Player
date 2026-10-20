import type { Track } from './protocol'

/**
 * 「这首歌到底叫什么、谁唱的」——在线取词的第一步，也是**唯一**真正会错的一步。
 *
 * 实测（2026-10-17，本机 91 首）：90 首 FLAC **没有任何标签**，引擎只好把文件名当标题，
 * artist 是空串。所以「按艺人+曲名去搜」这件事必须先把这个身份推出来，否则搜出去的
 * 是整串「TEST ROID - TEST HELIX」当歌名，命中率接近 0。
 *
 * 只做有把握的事：
 *  - 有 ARTIST 标签 → 直接用，不动文件名（标签是作者写的，文件名是别人起的）；
 *  - 没有标签 → 按**第一个** `空格-空格` 切开。切不开就当整串是歌名、艺人未知；
 *  - 比较用的 key 单独算（去括号、去标点、转小写、NFKC），**绝不改写展示用的标题**。
 */

export interface TrackIdentity {
  title: string
  artist: string
  album?: string
  durationMs?: number
  derivedFrom: 'tags' | 'filename'
}

type IdentityInput = Pick<Track, 'title' | 'artist' | 'album' | 'durationMs'> & { path?: string }

const SEPARATOR = /\s+-\s+/
const BRACKETED = /\([^()]*\)|（[^（）]*）|\[[^[\]]*\]|【[^【】]*】/g
const DECORATION = /(feat\.?|ft\.?|prod\.?|cover|instrumental|inst\.?|remix|ver\.?|version|tv ?size|short ver\.?)/gi

/** 比较用的归一化：全角转半角、小写、去括号内容、去标点与空白。只用于匹配，不用于展示。 */
export function matchKey(value: string): string {
  if (!value) return ''
  return value
    .normalize('NFKC')
    .replace(BRACKETED, ' ')
    .replace(DECORATION, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** 艺人串拆成 token：网易云的 artists 是数组，我们的标签是「A, B」「A & B」「A、B」这类。 */
export function artistTokens(value: string): string[] {
  if (!value) return []
  return value
    .normalize('NFKC')
    .split(/[,，、&/＆+]|\s+feat\.?\s+|\s+ft\.?\s+/i)
    .map(token => matchKey(token))
    .filter(token => token.length > 0)
}

function filenameStem(filePath: string | undefined): string {
  if (!filePath) return ''
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function deriveTrackIdentity(input: IdentityInput): TrackIdentity {
  const taggedTitle = (input.title ?? '').trim()
  const taggedArtist = (input.artist ?? '').trim()
  const durationMs = Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0 ? input.durationMs : undefined
  const album = (input.album ?? '').trim() || undefined

  if (taggedArtist && taggedTitle) {
    return { title: taggedTitle, artist: taggedArtist, ...(album ? { album } : {}), ...(durationMs ? { durationMs } : {}), derivedFrom: 'tags' }
  }

  const stem = (taggedTitle || filenameStem(input.path)).trim()
  const parts = stem.split(SEPARATOR)
  if (!taggedArtist && parts.length >= 2) {
    const artist = parts[0]!.trim()
    const title = parts.slice(1).join(' - ').trim()
    if (artist && title) {
      return { title, artist, ...(album ? { album } : {}), ...(durationMs ? { durationMs } : {}), derivedFrom: 'filename' }
    }
  }
  return { title: stem, artist: taggedArtist, ...(album ? { album } : {}), ...(durationMs ? { durationMs } : {}), derivedFrom: 'filename' }
}
