/**
 * 耳机补偿预设（AutoEQ 公开数据：oratory1990 / crinacle 的测量与参数化结果）。
 *
 * 为什么必须是**参数**均衡：这些预设里带 LSC/HSC（低架/高架）与任意频率、任意 Q
 * （例如 PK 4001 Hz Gain 2.3 dB Q 0.25）。固定的十频点 + 统一 Q 结构**表达不了**它们 ——
 * 这就是为此扩展引擎的原因，不是为了好看。
 *
 * 数据来源：AutoEQ 仓库（MIT）的公开结果，数值原样保留。内置这几款是为了**离线可用**；
 * 其余型号走在线获取（需精确型号名）或直接导入文件。
 */
import { parseEqPreset } from './eq-preset'
import type { EqFilter, ParsedEqPreset } from './eq-preset'

export interface HeadphonePreset {
  id: string
  name: string
  rig: string
  preampDb: number
  filters: EqFilter[]
}

interface RawPreset { name: string; rig: string; preampDb: number; spec: string }

// 数据行格式：型号|rig|preamp|类型 频率 增益 Q;…
const BUILTIN_RAW: RawPreset[] = [
  { name: "Sennheiser HD 600", rig: "oratory1990/over-ear", preampDb: -6.3, spec: "LSC 105 6.5 0.70;PK 125 -2.7 0.55;PK 8445 3.3 1.61;PK 522 0.7 1.02;PK 1298 -1.2 2.14;HSC 10000 -3.1 0.70;PK 3158 -1.8 3.67;PK 2166 0.9 3.32;PK 6639 2.2 5.82;PK 5433 -1.2 5.70" },
  { name: "Beyerdynamic DT 770 Pro", rig: "oratory1990/over-ear", preampDb: -5.1, spec: "LSC 105 -3.0 0.70;PK 6430 -4.2 0.97;PK 3684 6.8 2.88;PK 213 3.5 2.46;PK 139 -3.9 4.92;HSC 10000 -5.4 0.70;PK 93 3.5 3.00;PK 9561 2.3 1.86;PK 45 -1.3 1.74;PK 119 -2.1 5.83" },
  { name: "AKG K371", rig: "oratory1990/over-ear", preampDb: -5.6, spec: "LSC 105 -2.7 0.70;PK 182 -2.3 1.23;PK 4038 5.0 3.60;PK 67 3.1 1.41;PK 1066 -0.8 2.57;HSC 10000 2.4 0.70;PK 5564 -1.6 3.89;PK 4232 0.9 5.03;PK 524 0.3 1.66;PK 2048 0.5 4.67" },
  { name: "Audio-Technica ATH-M50x", rig: "oratory1990/over-ear", preampDb: -3.1, spec: "LSC 105 0.6 0.70;PK 156 -5.2 0.73;PK 326 5.3 1.59;PK 7077 2.8 2.22;PK 3483 2.1 5.82;HSC 10000 -4.1 0.70;PK 45 -1.1 1.90;PK 66 1.4 3.59;PK 787 -0.5 1.79;PK 1640 0.9 3.41" },
  { name: "Moondrop Aria", rig: "oratory1990/in-ear", preampDb: -3.4, spec: "LSC 105 -0.2 0.70;PK 164 -2.6 0.92;PK 6460 3.5 2.43;PK 659 1.4 1.59;PK 3108 0.5 1.51;HSC 10000 -5.3 0.70;PK 8665 2.1 2.79;PK 1408 -0.5 2.30;PK 54 0.9 5.32;PK 31 -0.4 2.21" },
  { name: "Moondrop Blessing 2", rig: "crinacle/711 in-ear", preampDb: -4.1, spec: "LSC 105 4.1 0.70;PK 183 -1.5 0.73;PK 1578 -4.1 0.68;PK 894 3.0 1.32;PK 4001 2.3 0.25;HSC 10000 -5.0 0.70;PK 4127 1.2 2.78;PK 2768 -1.1 3.69;PK 1888 0.5 3.56;PK 1334 -0.4 4.25" },
]

const TYPE_MAP: Record<string, EqFilter['type']> = {
  PK: 'peaking', LSC: 'lowShelf', HSC: 'highShelf', LS: 'lowShelf', HS: 'highShelf'
}

export function parseHeadphoneSpec(spec: string): EqFilter[] {
  const out: EqFilter[] = []
  for (const chunk of spec.split(';')) {
    const parts = chunk.trim().split(/\s+/)
    if (parts.length < 4) continue
    const type = TYPE_MAP[parts[0]!.toUpperCase()] ?? 'peaking'
    const freq = Number(parts[1])
    const gainDb = Number(parts[2])
    const q = Number(parts[3])
    if (!Number.isFinite(freq) || !Number.isFinite(gainDb) || !Number.isFinite(q)) continue
    out.push({ type, freq, gainDb, q })
  }
  return out
}

export const HEADPHONE_PRESETS: HeadphonePreset[] = BUILTIN_RAW.map((raw, index) => ({
  id: 'builtin-' + index,
  name: raw.name,
  rig: raw.rig,
  preampDb: raw.preampDb,
  filters: parseHeadphoneSpec(raw.spec)
}))

/** AutoEQ 仓库里这些测量 rig 目录存在；按顺序尝试，命中即止。 */
export const AUTOEQ_RIGS = ['oratory1990/over-ear', 'oratory1990/in-ear', 'crinacle/711 in-ear', 'crinacle/5128 in-ear'] as const

export function autoEqPresetUrl(rig: string, name: string, kind: 'ParametricEQ' | 'FixedBandEQ' = 'ParametricEQ'): string {
  const encoded = encodeURIComponent(name)
  return 'https://gh-proxy.com/https://raw.githubusercontent.com/jaakkopasanen/AutoEQ/master/results/'
    + rig + '/' + encoded + '/' + encoded + '%20' + kind + '.txt'
}

export interface HeadphoneFetchOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 已知测量 rig 时直接去那一档，省掉几次无谓的尝试（索引里带着 rig）。 */
  rig?: string
}

/**
 * 按型号名去 AutoEQ 取一份预设。
 *
 * 只能按**精确的 AutoEQ 型号名**取（那是仓库里的目录名，没有可靠的模糊索引）；
 * 失败时的错误必须说清这一点，而不是含糊地说「网络错误」。
 */
export async function fetchHeadphonePreset(name: string, options: HeadphoneFetchOptions = {}): Promise<HeadphonePreset> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请填写耳机型号。')
  const fetchImpl = options.fetchImpl ?? fetch
  const attempts: string[] = []
  const rigs = options.rig ? [options.rig] : [...AUTOEQ_RIGS]
  for (const rig of rigs) {
    const url = autoEqPresetUrl(rig, trimmed)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) { attempts.push(rig + ' → HTTP ' + response.status); continue }
      const text = await response.text()
      const parsed: ParsedEqPreset = parseEqPreset(text, trimmed)
      if (parsed.filters.length === 0) { attempts.push(rig + ' → 没有解析出滤波器'); continue }
      return { id: 'online-' + trimmed, name: trimmed, rig, preampDb: parsed.preampDb ?? 0, filters: parsed.filters }
    } catch (error) {
      attempts.push(rig + ' → ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('AutoEQ 里没有找到「' + trimmed + '」。型号名要写成仓库里的精确名字（例如 Sennheiser HD 600），也可以直接导入 txt 文件。尝试过：' + attempts.join('；'))
}
