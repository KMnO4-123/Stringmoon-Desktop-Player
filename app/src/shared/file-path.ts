/**
 * 路径判据（shared 层，主进程与渲染层共用）。
 *
 * 为什么不用 node:path：shared 模块会被渲染层打包进浏览器 bundle，那里没有
 * node:path。播放记忆/预热都只需要「这看起来是一条 Windows 绝对路径」这一条
 * 判据，用正则即可；真正的文件存在性由主进程用 fs.stat 判定（渲染层传来的
 * 路径一律不可信）。
 */

/** 盘符形式（C:\ 或 C:/）或 UNC（\\server\share）。 */
export function isAbsoluteWindowsPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767) return false
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]/.test(value)
}

/** 曲库/播放链路承认的音频扩展名（与 artwork.ts、lyrics.ts 的白名单保持同源语义）。 */
const AUDIO_EXTENSION = /\.(flac|wav|mp3|ogg|oga|opus|m4a|aac|ape|wv|aiff?|alac)$/i

export function isSupportedAudioPath(value: unknown): value is string {
  return isAbsoluteWindowsPath(value) && AUDIO_EXTENSION.test(value)
}
