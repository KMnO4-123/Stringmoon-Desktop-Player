/**
 * AutoEQ 型号搜索。
 *
 * 索引本身（`eq-models.data.ts`）是从 AutoEQ 的 `results/README.md` 生成的只读快照；
 * 这里只负责把它变成可查的结构并打分。放在**主进程**是因为：索引 140 KB，
 * 渲染层不该为了一个搜索框背着它；而且搜索是纯 CPU、无副作用，适合就地进行。
 *
 * 打分是刻意的朴素版本：用户输入的往往只是型号片段（"HD 600"、"aria"、"xm4"），
 * 所以先比归一化后的完整包含，再比词元包含，最后才是子序列模糊匹配 ——
 * 顺序反了会把「HD 600」排在「HD 600S」后面这种事弄丢。
 */
import { AUTOEQ_MODEL_INDEX } from './eq-models.data'

export interface AutoEqModel {
  name: string
  rig: string
}

let cache: AutoEqModel[] | null = null

function allModels(): AutoEqModel[] {
  if (cache) return cache
  const out: AutoEqModel[] = []
  for (const [rig, names] of AUTOEQ_MODEL_INDEX) {
    for (const name of names.split('\n')) {
      if (name) out.push({ name, rig })
    }
  }
  cache = out
  return out
}

export function modelCount(): number {
  return allModels().length
}

/** 归一化：小写、去空白与常见分隔符。搜索是给人用的，不该要求用户打对空格。 */
export function normalizeModel(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.·・]+/g, '')
}

function subsequenceScore(needle: string, haystack: string): number {
  let at = 0
  let hits = 0
  for (const char of haystack) {
    if (char === needle[at]) { at++; hits++; if (at === needle.length) break }
  }
  if (at !== needle.length) return 0
  // 命中越靠前越好；同样命中时短名字优先（用户要的是「那一个」）。
  return 20 + (needle.length / Math.max(1, haystack.length)) * 10
}

/**
 * 用户输入的通常是**型号名后缀**（"HD 600"、"Aria"、"XM4"），而品牌在前。
 * 所以「查询等于名字末尾若干个完整词元」是一个强信号 —— 没有它，
 * "HD 600" 会先命中 "Denon AH-D600"（因为归一化后都包含 hd600，而它更短）。
 */
function suffixTokenMatch(query: string, modelName: string): boolean {
  const tokens = modelName.split(/[\s\-_.·・]+/).filter(Boolean)
  const target = normalizeModel(query)
  if (!target) return false
  for (let take = 1; take <= Math.min(tokens.length, 4); take++) {
    if (normalizeModel(tokens.slice(tokens.length - take).join(' ')) === target) return true
  }
  return false
}

export function scoreModel(query: string, model: AutoEqModel): number {
  const needle = normalizeModel(query)
  if (!needle) return 0
  const name = normalizeModel(model.name)
  if (name === needle) return 100
  if (suffixTokenMatch(query, model.name)) return 90
  if (name.startsWith(needle)) return 85
  if (name.includes(needle)) return 70
  const tokens = needle.split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every(token => name.includes(token))) return 60
  return subsequenceScore(needle, name)
}

export function searchEqModels(query: string, limit = 20): AutoEqModel[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const scored: Array<{ model: AutoEqModel; score: number }> = []
  for (const model of allModels()) {
    const score = scoreModel(trimmed, model)
    if (score > 0) scored.push({ model, score })
  }
  scored.sort((a, b) => b.score - a.score || a.model.name.length - b.model.name.length)
  return scored.slice(0, Math.max(1, Math.min(100, limit))).map(item => item.model)
}
