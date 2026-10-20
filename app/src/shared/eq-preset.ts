import { EQ_BAND_COUNT, isEqFilterType } from './eq-bands'
import type { EqFilterType } from './eq-bands'

/**
 * 外部均衡曲线 → 我们引擎能吃的十个槽位。
 *
 * 支持四种现实里会遇到的来源：
 *  - AutoEQ（Filter 1: ON PK Fc 31 Hz Gain 6.9 dB Q 1.41）—— 定频版与参数版同一套语法；
 *  - Equalizer APO 配置（多 Preamp: / GraphicEQ: / Include: / Channel: 这些指令）；
 *  - 纯曲线（CSV/TSV 的「频率,增益」两列，或 GraphicEQ: 那一行）→ 需要拟合到十个参数带；
 *  - 本项目 JSON（导出/备份用）。
 *
 * 三条原则：
 *  1. 能原样就不要拟合。AutoEQ 定频预设本来就是十个 PK / Q 1.41，与引擎网格一一对应，
 *     直接搬过去即可 —— 拟合只会白白引入误差。
 *  2. 不认识的东西要说出来，不能静默丢掉。低通/高通/Include 都进 warnings，由界面展示。
 *  3. 超出生效范围的取值夹紧并记录，而不是让整份预设失败。
 */

export interface EqFilter { type: EqFilterType; freq: number; gainDb: number; q: number }
export interface EqCurvePoint { freq: number; gainDb: number }

export type EqPresetFormat = 'autoeq' | 'apo' | 'curve' | 'json'

export interface ParsedEqPreset {
  name: string
  preampDb?: number
  filters: EqFilter[]
  curve: EqCurvePoint[]
  format: EqPresetFormat
  warnings: string[]
}

const MIN_FREQ = 10
const MAX_FREQ = 24000
const MIN_Q = 0.1
const MAX_Q = 10
const MAX_GAIN = 12

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))

/** APO 的 BW Oct x → Q。公式是 RBJ 带宽换算，不是经验值。 */
export function bandwidthToQ(octaves: number): number {
  if (!Number.isFinite(octaves) || octaves <= 0) return 1.41
  const factor = Math.pow(2, octaves)
  return Math.sqrt(factor) / (factor - 1)
}

const FILTER_TYPES: Record<string, EqFilterType | null> = {
  PK: 'peaking', PEQ: 'peaking', NOTCH: 'peaking',
  LS: 'lowShelf', LSC: 'lowShelf', LSQ: 'lowShelf', LO: 'lowShelf',
  HS: 'highShelf', HSC: 'highShelf', HSQ: 'highShelf', HI: 'highShelf',
  LP: null, HP: null, BP: null, LPQ: null, HPQ: null, NO: null
}

/** Filter 3: ON PK Fc 1200 Hz Gain -2.5 dB Q 0.70  */
const FILTER_LINE = /^filter\s*\d*\s*:\s*(on|off)\s+([A-Za-z]+)\b(.*)$/i
// `BW Oct 1.0` 与 `BW 1.0` 两种写法都要认 —— APO 文档里是前者，导出的配置里两种都见过。
const PARAM = /(fc|gain|q|bw|s)\s+(?:oct\s+)?(-?\d+(?:[.,]\d+)?)\s*(hz|db|oct)?/gi

function parseNumber(raw: string): number {
  return Number(raw.replace(',', '.'))
}

function readCurveLine(line: string): EqCurvePoint[] {
  const graphic = /^graphic\s*eq\s*:\s*(.*)$/i.exec(line)
  const body = graphic ? graphic[1]! : line
  const points: EqCurvePoint[] = []
  for (const chunk of body.split(/[;|]/)) {
    const parts = chunk.trim().split(/[\s,]+/).filter(Boolean)
    if (parts.length < 2) continue
    const freq = Number(parts[0])
    const gainDb = Number(parts[1])
    if (!Number.isFinite(freq) || !Number.isFinite(gainDb)) continue
    if (freq < MIN_FREQ || freq > MAX_FREQ) continue
    points.push({ freq, gainDb: clamp(gainDb, -MAX_GAIN, MAX_GAIN) })
  }
  return points
}

export function parseEqPreset(text: string, fallbackName = '导入的预设'): ParsedEqPreset {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonPreset(trimmed, fallbackName)
    if (parsed) return parsed
  }

  const warnings: string[] = []
  const filters: EqFilter[] = []
  const curve: EqCurvePoint[] = []
  let preampDb: number | undefined
  let name = fallbackName

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue

    const preamp = /^preamp\s*:\s*(-?\d+(?:\.\d+)?)\s*db/i.exec(line)
    if (preamp) { preampDb = clamp(Number(preamp[1]), -24, 24); continue }

    if (/^graphic\s*eq\s*:/i.test(line)) {
      const points = readCurveLine(line)
      if (points.length > 0) curve.push(...points)
      else warnings.push('GraphicEQ 行没有解析出任何点。')
      continue
    }

    const directive = /^(include|channel|copy|convolution|delay)\s*:/i.exec(line)
    if (directive) { warnings.push('不支持这条指令：' + directive[1]); continue }

    const filter = FILTER_LINE.exec(line)
    if (filter) {
      if (filter[1]!.toLowerCase() === 'off') continue
      const kind = filter[2]!.toUpperCase()
      if (!(kind in FILTER_TYPES)) { warnings.push('不认识的滤波器类型：' + kind); continue }
      const mapped = FILTER_TYPES[kind]
      if (!mapped) { warnings.push('不支持 ' + kind + '（十段峰值/架式表达不了），已跳过。'); continue }
      const rest = filter[3] ?? ''
      let freq = Number.NaN
      let gainDb = 0
      let q = 1.41
      let haveQ = false
      PARAM.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = PARAM.exec(rest)) !== null) {
        const key = match[1]!.toLowerCase()
        const value = parseNumber(match[2]!)
        if (!Number.isFinite(value)) continue
        if (key === 'fc') freq = value
        else if (key === 'gain') gainDb = value
        else if (key === 'q') { q = value; haveQ = true }
        else if (key === 'bw') { q = bandwidthToQ(value); haveQ = true }
      }
      if (!Number.isFinite(freq)) { warnings.push('滤波器缺少 Fc，已跳过：' + line.slice(0, 48)); continue }
      if (freq < MIN_FREQ || freq > MAX_FREQ) warnings.push('频率 ' + Math.round(freq) + ' Hz 超出范围，已夹紧。')
      if (Math.abs(gainDb) > MAX_GAIN) warnings.push('增益 ' + gainDb.toFixed(1) + ' dB 超出 ±12 dB，已夹紧。')
      if (!haveQ) warnings.push('滤波器缺少 Q，按 1.41 处理。')
      filters.push({
        type: mapped,
        freq: clamp(freq, MIN_FREQ, MAX_FREQ),
        gainDb: clamp(gainDb, -MAX_GAIN, MAX_GAIN),
        q: clamp(q, MIN_Q, MAX_Q)
      })
      continue
    }

    const pair = /^(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)$/.exec(line)
    if (pair) {
      const freq = Number(pair[1])
      const gainDb = Number(pair[2])
      if (Number.isFinite(freq) && Number.isFinite(gainDb) && freq >= MIN_FREQ && freq <= MAX_FREQ) {
        curve.push({ freq, gainDb: clamp(gainDb, -MAX_GAIN, MAX_GAIN) })
      }
      continue
    }

    const title = /^title\s*:\s*(.+)$/i.exec(line)
    if (title) name = title[1]!.trim().slice(0, 60)
  }

  if (curve.length > 0) curve.sort((a, b) => a.freq - b.freq)
  if (filters.length === 0 && curve.length === 0) {
    throw new Error('没有在这份文件里找到可用的均衡器数据。')
  }
  if (filters.length > EQ_BAND_COUNT) {
    warnings.push('文件含 ' + filters.length + ' 个滤波器，超过十段，只保留影响最大的十个。')
  }
  const format: EqPresetFormat = curve.length > 0 ? 'curve'
    : /^filter\s*\d*\s*:/im.test(text) ? 'autoeq' : 'apo'
  return { name, ...(preampDb !== undefined ? { preampDb } : {}), filters, curve, format, warnings }
}

export function parseJsonPreset(text: string, fallbackName = '导入的预设'): ParsedEqPreset | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  const record = (Array.isArray(value) ? { bands: value } : value) as Record<string, unknown>
  if (!record || typeof record !== 'object') return null
  const list = record.filters ?? record.bands ?? record.eq
  if (!Array.isArray(list)) return null
  const filters: EqFilter[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const band = item as Record<string, unknown>
    const freq = Number(band.freq ?? band.frequency ?? band.fc)
    const gainDb = Number(band.gainDb ?? band.gain ?? 0)
    if (!Number.isFinite(freq) || freq < MIN_FREQ || freq > MAX_FREQ) continue
    const rawType = band.type
    const qRaw = Number(band.q ?? 1.41)
    filters.push({
      type: isEqFilterType(rawType) ? rawType : 'peaking',
      freq,
      gainDb: clamp(Number.isFinite(gainDb) ? gainDb : 0, -MAX_GAIN, MAX_GAIN),
      q: clamp(Number.isFinite(qRaw) && qRaw > 0 ? qRaw : 1.41, MIN_Q, MAX_Q)
    })
  }
  if (filters.length === 0) return null
  const preamp = Number(record.preampDb)
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : fallbackName
  return {
    name,
    ...(Number.isFinite(preamp) ? { preampDb: clamp(preamp, -24, 24) } : {}),
    filters,
    curve: [],
    format: 'json',
    warnings: []
  }
}

/**
 * 参数化滤波器 → 十个槽位。能原样搬就原样搬：AutoEQ 定频预设与引擎网格一一对应，
 * 拟合只会引入误差，所以这里只按影响大小截断到十个，不做任何近似。
 */
export function filtersToBands(filters: EqFilter[]): EqFilter[] {
  if (filters.length <= EQ_BAND_COUNT) return filters.map(filter => ({ ...filter }))
  return [...filters]
    .sort((a, b) => Math.abs(b.gainDb) - Math.abs(a.gainDb))
    .slice(0, EQ_BAND_COUNT)
    .sort((a, b) => a.freq - b.freq)
    .map(filter => ({ ...filter }))
}

/** RBJ 峰值滤波器幅度响应（dB）。与引擎 dsp.cpp 的系数公式同源。 */
export function peakingResponseDb(filter: EqFilter, hz: number, sampleRate = 48000): number {
  const A = Math.pow(10, filter.gainDb / 40)
  const w0 = 2 * Math.PI * filter.freq / sampleRate
  const alpha = Math.sin(w0) / (2 * Math.max(filter.q, 1e-6))
  const b0 = 1 + alpha * A, b1 = -2 * Math.cos(w0), b2 = 1 - alpha * A
  const a0 = 1 + alpha / A, a1 = -2 * Math.cos(w0), a2 = 1 - alpha / A
  const w = 2 * Math.PI * hz / sampleRate
  const cw = Math.cos(w), sw = Math.sin(w)
  const cw2 = Math.cos(2 * w), sw2 = Math.sin(2 * w)
  const numRe = b0 + b1 * cw + b2 * cw2
  const numIm = -(b1 * sw + b2 * sw2)
  const denRe = a0 + a1 * cw + a2 * cw2
  const denIm = -(a1 * sw + a2 * sw2)
  const num = numRe * numRe + numIm * numIm
  const den = denRe * denRe + denIm * denIm
  return den <= 0 ? 0 : 10 * Math.log10(Math.max(1e-12, num / den))
}

export function curveResponseDb(filters: EqFilter[], hz: number): number {
  let sum = 0
  for (const filter of filters) sum += peakingResponseDb(filter, hz)
  return sum
}

/** 对数等距采样目标曲线（20 Hz–20 kHz），中间点按线性插值。 */
export function resampleCurve(points: EqCurvePoint[], count = 72): EqCurvePoint[] {
  if (points.length === 0) return []
  const sorted = [...points].sort((a, b) => a.freq - b.freq)
  const lo = Math.max(20, sorted[0]!.freq)
  const hi = Math.min(20000, sorted[sorted.length - 1]!.freq)
  if (!(hi > lo)) return []
  const out: EqCurvePoint[] = []
  for (let i = 0; i < count; i++) {
    const freq = lo * Math.pow(hi / lo, i / (count - 1))
    let gainDb = sorted[sorted.length - 1]!.gainDb
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1]!
      const b = sorted[k]!
      if (freq <= b.freq) {
        const t = b.freq === a.freq ? 0 : (freq - a.freq) / (b.freq - a.freq)
        gainDb = a.gainDb + (b.gainDb - a.gainDb) * t
        break
      }
    }
    out.push({ freq, gainDb })
  }
  return out
}

/**
 * 密集曲线 → 参数带（贪心拟合）。
 *
 * 只有 AutoEQ 的参数/定频预设之外的情形才需要它（例如贴一份测量曲线进来）。
 * 做法：每次挑残差最大的频点放一个峰值带，Q 由半高宽估出来，然后把这条带的响应
 * 从残差里减掉，重复到用完十个槽位或残差足够小。
 *
 * ⚠️ 这是**近似**。拟合误差会随曲线起伏变大，调用方必须把它算出来给用户看
 * （见 fitErrorDb），而不是假装无损。
 */
export function fitCurveToBands(points: EqCurvePoint[], bandCount = 10): EqFilter[] {
  const grid = resampleCurve(points)
  if (grid.length === 0) return []
  const residual = grid.map(point => point.gainDb)
  const filters: EqFilter[] = []
  for (let placed = 0; placed < bandCount; placed++) {
    let peak = 0
    for (let k = 1; k < residual.length; k++) {
      if (Math.abs(residual[k]!) > Math.abs(residual[peak]!)) peak = k
    }
    const magnitude = Math.abs(residual[peak]!)
    if (magnitude < 0.3) break
    const sign = Math.sign(residual[peak]!)
    const gainDb = clamp(residual[peak]!, -MAX_GAIN, MAX_GAIN)
    const half = magnitude / 2
    let left = peak
    let right = peak
    while (left > 0 && Math.sign(residual[left - 1]!) === sign && Math.abs(residual[left - 1]!) >= half) left--
    while (right < residual.length - 1 && Math.sign(residual[right + 1]!) === sign && Math.abs(residual[right + 1]!) >= half) right++
    const ratio = grid[right]!.freq / grid[left]!.freq
    const q = clamp(ratio > 1.0001 ? Math.sqrt(ratio) / (ratio - 1) : 4, 0.3, 4)
    const filter: EqFilter = { type: 'peaking', freq: grid[peak]!.freq, gainDb, q }
    filters.push(filter)
    for (let k = 0; k < residual.length; k++) residual[k] = residual[k]! - peakingResponseDb(filter, grid[k]!.freq)
  }
  return filters
}

/** 拟合误差：在采样点上的平均绝对偏差（dB）。界面必须把它显示出来。 */
export function fitErrorDb(points: EqCurvePoint[], filters: EqFilter[]): number {
  const grid = resampleCurve(points)
  if (grid.length === 0) return 0
  let sum = 0
  for (const point of grid) sum += Math.abs(curveResponseDb(filters, point.freq) - point.gainDb)
  return sum / grid.length
}

/**
 * 滤波器列表 → 一次性的 set_eq 补丁：**十个槽位全部写满**。
 *
 * 为什么必须写满：set_eq 是局部更新，只写前 N 个槽位会把旧预设留在后面的槽里，
 * 于是「换预设」变成了「和上一个预设叠加」。所以没用到的槽要显式清零。
 */
export function filtersToPatch(filters: EqFilter[], preampDb?: number): {
  bands: Array<{ freq: number; gainDb: number; q: number; type: EqFilterType }>
  preampDb?: number
} {
  const bands: Array<{ freq: number; gainDb: number; q: number; type: EqFilterType }> = []
  for (let index = 0; index < 10; index++) {
    const filter = filters[index]
    bands.push(filter
      ? { freq: filter.freq, gainDb: filter.gainDb, q: filter.q, type: filter.type }
      : { freq: 0, gainDb: 0, q: 0, type: 'peaking' as EqFilterType })
  }
  return { bands, ...(preampDb !== undefined ? { preampDb } : {}) }
}
