import { useEffect, useState } from 'react'
import type { ArtworkResult } from '@shared/artwork'

const cache = new Map<string, { expires: number; pending: Promise<ArtworkResult | null> }>()
export function clearArtworkCache(path: string): void { cache.delete(path) }

export function useArtwork(path: string | undefined, revision = 0): ArtworkResult | null {
  const [result, setResult] = useState<{ path: string; artwork: ArtworkResult | null } | null>(null)
  useEffect(() => {
    if (!path) return
    let active = true
    let entry = cache.get(path)
    if (!entry || entry.expires < Date.now()) {
      entry = { expires: Date.now() + 60000, pending: window.twilight.loadArtwork(path).catch(() => null) }
      cache.set(path, entry)
      if (cache.size > 6) cache.delete(cache.keys().next().value!)
    }
    void entry.pending.then(artwork => { if (active) setResult({ path, artwork }) })
    return () => { active = false }
  }, [path, revision])
  return result && result.path === path ? result.artwork : null
}

export function fallbackHue(key: string): number {
  let hash = 2166136261
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  return ((hash >>> 0) % 270 + 15) % 360
}

export function useArtworkHue(key: string, artwork: ArtworkResult | null): number {
  const [sample, setSample] = useState<{ key: string; hue: number } | null>(null)
  useEffect(() => {
    if (!artwork) return
    let active = true
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 24
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.drawImage(image, 0, 0, 24, 24)
      let data: Uint8ClampedArray
      try {
        data = context.getImageData(0, 0, 24, 24).data
      } catch {
        // 在线封面是跨域图片：canvas 会被标记为「被污染」，getImageData 直接抛 SecurityError。
        // 取色只是锦上添花，退回按 key 的哈希色，绝不让整个界面因此报错。
        if (active) setSample({ key: artwork.dataUrl, hue: fallbackHue(key) })
        return
      }
      let x = 0, y = 0, weight = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo
        if (data[i + 3]! < 200 || delta < 0.12 || hi < 0.14 || lo > 0.87) continue
        let angle = hi === r ? (g - b) / delta : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4
        angle = ((angle * 60) % 360 + 360) % 360
        x += Math.cos(angle * Math.PI / 180) * delta
        y += Math.sin(angle * Math.PI / 180) * delta
        weight += delta
      }
      if (active) setSample({ key: artwork.dataUrl, hue: weight > 0 ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : fallbackHue(key) })
    }
    image.src = artwork.dataUrl
    return () => { active = false; image.onload = null }
  }, [key, artwork])
  return sample && sample.key === artwork?.dataUrl ? sample.hue : fallbackHue(key)
}
