import { stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import type { ArtworkResult } from '@shared/artwork'
import { nativeImage } from 'electron'

const MAX_ARTWORK_BYTES = 8 * 1024 * 1024
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }
const AUDIO = new Set(['.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wv', '.alac'])
const cache = new Map<string, { stamp: string; expires: number; pending: Promise<ArtworkResult | null> }>()
let configFile: string | null = null
const custom = new Map<string, string>()
let configReady: Promise<void> = Promise.resolve()

export function configureArtwork(file: string): void {
  configFile = file
  configReady = readFile(file, 'utf8').then(text => {
    const saved: unknown = JSON.parse(text)
    if (saved && typeof saved === 'object') for (const [audio, cover] of Object.entries(saved)) {
      if (path.isAbsolute(audio) && typeof cover === 'string' && path.isAbsolute(cover)) custom.set(audio, cover)
    }
  }).catch(() => {})
}

async function readImage(file: string, source: ArtworkResult['source']): Promise<ArtworkResult | null> {
  try {
    const mime = MIME[path.extname(file).toLowerCase()]
    const info = await stat(file)
    if (!mime || !info.isFile() || info.size > MAX_ARTWORK_BYTES) return null
    return image(await readFile(file), mime, source)
  } catch { return null }
}

export async function setArtwork(audio: string, file: string): Promise<ArtworkResult | null> {
  await configReady
  if (!path.isAbsolute(audio) || !AUDIO.has(path.extname(audio).toLowerCase())) return null
  const cover = await readImage(file, 'custom')
  if (!cover) return null
  custom.set(audio, file)
  await persist()
  cache.delete(audio)
  return cover
}

/** 原子写配置：临时文件 + rename，避免中断留下半个 JSON。 */
async function persist(): Promise<void> {
  if (!configFile) return
  const snapshot = Object.fromEntries(custom)
  await mkdir(path.dirname(configFile), { recursive: true })
  await writeFile(configFile + '.tmp', JSON.stringify(snapshot), 'utf8')
  await rename(configFile + '.tmp', configFile)
}

/**
 * 丢弃这首歌的自定义封面，回到自动读取（嵌入图 → 同名图 → cover/folder/front）。
 *
 * 只删映射，**不删用户的图片文件**（那是用户自己的文件，我们只是引用过它），
 * 也不动音乐文件。返回移除后的自动结果，让调用方能立刻画出正确的下一张图；
 * 没有自定义映射时就是普通的自动结果，调用方不必先查状态。
 */
export async function removeArtwork(audio: string): Promise<ArtworkResult | null> {
  if (typeof audio !== 'string' || !path.isAbsolute(audio) || !AUDIO.has(path.extname(audio).toLowerCase())) return null
  await configReady
  if (!custom.delete(audio)) return load(audio)
  await persist()
  cache.delete(audio)
  return load(audio)
}

function image(bytes: Uint8Array, mime: string, source: ArtworkResult['source']): ArtworkResult | null {
  if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) return null
  const jpeg = mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8
  const png = mime === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (!jpeg && !png) return null
  const decoded = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (decoded.isEmpty()) return null
  const size = decoded.getSize()
  if (size.width > 8192 || size.height > 8192 || size.width * size.height > 32_000_000) return null
  const ratio = Math.min(1, 1024 / Math.max(size.width, size.height))
  const resized = ratio < 1 ? decoded.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' }) : decoded
  return { dataUrl: resized.toDataURL(), source }
}

async function load(file: string): Promise<ArtworkResult | null> {
  const selected = custom.get(file)
  if (selected) { const cover = await readImage(selected, 'custom'); if (cover) return cover }
  try {
    const { parseFile, selectCover } = await import('music-metadata')
    const metadata = await parseFile(file, { duration: false })
    const picture = selectCover(metadata.common.picture)
    for (const candidate of [picture, ...(metadata.common.picture ?? []).filter(entry => entry !== picture)]) {
      if (!candidate) continue
      const embedded = image(candidate.data, candidate.format.toLowerCase(), 'embedded')
      if (embedded) return embedded
    }
  } catch { /* The audio may still be playable without parsable artwork. */ }
  const parent = path.dirname(file)
  const base = path.basename(file, path.extname(file))
  for (const name of [base, 'cover', 'folder', 'front']) {
    for (const extension of Object.keys(MIME)) {
      const candidate = path.join(parent, name + extension)
      const cover = await readImage(candidate, 'sidecar')
      if (cover) return cover
    }
  }
  return null
}

export async function readArtwork(file: string): Promise<ArtworkResult | null> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !AUDIO.has(path.extname(file).toLowerCase())) return null
  await configReady
  let stamp: string
  try { const info = await stat(file); if (!info.isFile()) return null; stamp = `${info.size}:${info.mtimeMs}` } catch { return null }
  let entry = cache.get(file)
  if (!entry || entry.stamp !== stamp || entry.expires < Date.now()) {
    entry = { stamp, expires: Date.now() + 60000, pending: load(file) }
    cache.set(file, entry)
    if (cache.size > 6) cache.delete(cache.keys().next().value!)
  }
  return entry.pending
}
