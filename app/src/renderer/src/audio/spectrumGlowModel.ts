import { SPECTRUM_MAX_DB, SPECTRUM_MIN_DB } from './meterStore'

export interface CurvePoint { x: number; y: number }

/** Smooth measured points without allowing interpolation to exceed a sample. */
export function smoothMeasuredPath(points: readonly CurvePoint[]): string {
  if (!points.length || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return ''
  if (points.some((point, index) => index > 0 && point.x <= points[index - 1]!.x)) return ''
  if (points.length === 1) return `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`

  const commands = [`M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`]
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index]!
    const next = points[index + 1]!
    const previous = points[Math.max(0, index - 1)]!
    const after = points[Math.min(points.length - 1, index + 2)]!
    const tension = 0.22
    const cp1x = current.x + (next.x - previous.x) * tension
    const lowY = Math.min(current.y, next.y)
    const highY = Math.max(current.y, next.y)
    const cp1y = Math.min(highY, Math.max(lowY, current.y + (next.y - previous.y) * tension))
    const cp2x = next.x - (after.x - current.x) * tension
    const cp2y = Math.min(highY, Math.max(lowY, next.y - (after.y - current.y) * tension))
    commands.push(`C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${next.x.toFixed(2)},${next.y.toFixed(2)}`)
  }
  return commands.join(' ')
}

/** Map every measured dB band to a fixed axis before shape-preserving smoothing. */
export function spectrumCurvePath(spectrum: readonly number[], width: number, height = 104): string {
  if (!spectrum.length || !spectrum.every(Number.isFinite)
      || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return ''
  const count = spectrum.length
  // x 轴只由「点数 + 宽度」决定：宽高不变时复用上次算好的数组（每帧省 48 次除法与数组分配）。
  if (curveCacheWidth !== width || curveCacheCount !== count) {
    curveCacheWidth = width
    curveCacheCount = count
    curveXs = new Float64Array(count)
    curveYs = new Float64Array(count)
    for (let index = 0; index < count; index++) curveXs[index] = index / Math.max(1, count - 1) * width
  }
  const ys = curveYs
  for (let index = 0; index < count; index++) {
    const db = spectrum[index] as number
    ys[index] = height - (Math.min(SPECTRUM_MAX_DB, Math.max(SPECTRUM_MIN_DB, db)) - SPECTRUM_MIN_DB)
      / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB) * height * 0.84
  }
  return smoothPathFromArrays(curveXs, ys)
}


/** 紧凑数值数组：允许 Float64Array，避免每帧为每个点分配 {x,y} 对象。 */
export interface NumericArray {
  readonly length: number
  readonly [index: number]: number
}

/** 保留两位小数的数字格式化：比 toFixed 快，且不会产生 "12.00" 这类多余字符。 */
const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * 逐帧画曲线时的快速路径：调用方**复用**已算好的 x/y 数组，这里不再校验、不分配点对象。
 *
 * 控制点算法与 smoothMeasuredPath 完全一致（tension 0.22 + 上下包络限制），
 * 只是把 toFixed(2) 换成 Math.round（每帧 48 个点、400+ 次格式化时差别明显）。
 * 输入由调用方保证：x 单调、长度一致、数值有限。
 */
export function smoothPathFromArrays(xs: NumericArray, ys: NumericArray): string {
  const n = Math.min(xs.length, ys.length)
  if (n === 0) return ''
  const x0 = xs[0] as number
  const y0 = ys[0] as number
  if (n === 1) return `M${round2(x0)},${round2(y0)}`
  let path = `M${round2(x0)},${round2(y0)}`
  for (let index = 0; index < n - 1; index++) {
    const curX = xs[index] as number
    const curY = ys[index] as number
    const nextX = xs[index + 1] as number
    const nextY = ys[index + 1] as number
    const previousX = index > 0 ? xs[index - 1] as number : curX
    const previousY = index > 0 ? ys[index - 1] as number : curY
    const afterX = index + 2 < n ? xs[index + 2] as number : nextX
    const afterY = index + 2 < n ? ys[index + 2] as number : nextY
    const tension = 0.22
    const cp1x = curX + (nextX - previousX) * tension
    const lowY = Math.min(curY, nextY)
    const highY = Math.max(curY, nextY)
    const cp1y = Math.min(highY, Math.max(lowY, curY + (nextY - previousY) * tension))
    const cp2x = nextX - (afterX - curX) * tension
    const cp2y = Math.min(highY, Math.max(lowY, nextY - (afterY - curY) * tension))
    path += ` C${round2(cp1x)},${round2(cp1y)} ${round2(cp2x)},${round2(cp2y)} ${round2(nextX)},${round2(nextY)}`
  }
  return path
}

/** spectrumCurvePath 的复算缓存：宽高不变时 x 轴（等比间距）只需算一次。 */
let curveCacheWidth = -1
let curveCacheCount = -1
let curveXs: Float64Array = new Float64Array(0)
let curveYs: Float64Array = new Float64Array(0)

export const SPECTRUM_STALE_MS = 450
export function freshSpectrum(receivedAt: number, now: number): boolean {
  return receivedAt > 0 && now >= receivedAt && now - receivedAt < SPECTRUM_STALE_MS
}