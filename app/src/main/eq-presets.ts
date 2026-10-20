/**
 * 用户导入的均衡器预设（主进程持久化）。
 *
 * 为什么不能放 localStorage：预设是**用户内容**，和歌单、元数据覆盖、无法播放记录同一类，
 * 这个项目里那三样都在主进程的 JSON 文档里（原子写 + revision 校验）。
 * localStorage 只该放界面偏好（字号、开关），它跟着渲染进程的存储配额走，
 * 清缓存就没了 —— 用户亲手导入的曲线不该有这种命运。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import type { EqPresetRecord } from '@shared/eq-model'

type StoredEqFilter = EqPresetRecord['filters'][number]
type StoredEqPreset = EqPresetRecord

const MAX_PRESETS = 200
const TYPES = new Set(['peaking', 'lowShelf', 'highShelf'])

let configFile: string | null = null
let presets: StoredEqPreset[] = []
let generation = 0
let ready: Promise<void> = Promise.resolve()
let writing: Promise<unknown> = Promise.resolve()

function sanitize(raw: unknown): StoredEqPreset | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : ''
  if (!name) return null
  const list = Array.isArray(record.filters) ? record.filters : []
  const filters: StoredEqFilter[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const band = item as Record<string, unknown>
    const freq = Number(band.freq)
    const gainDb = Number(band.gainDb)
    const q = Number(band.q)
    const type = typeof band.type === 'string' && TYPES.has(band.type) ? band.type as StoredEqFilter['type'] : 'peaking'
    if (!Number.isFinite(freq) || freq < 10 || freq > 24000) continue
    if (!Number.isFinite(gainDb) || Math.abs(gainDb) > 12) continue
    if (!Number.isFinite(q) || q < 0.1 || q > 10) continue
    filters.push({ type, freq, gainDb, q })
  }
  if (filters.length === 0) return null
  const preamp = Number(record.preampDb)
  const rig = typeof record.rig === 'string' && record.rig.trim() ? record.rig.trim().slice(0, 120) : undefined
  return {
    id: typeof record.id === 'string' && record.id ? record.id : 'user-' + randomUUID(),
    name,
    ...(rig ? { rig } : {}),
    ...(Number.isFinite(preamp) ? { preampDb: Math.max(-24, Math.min(24, preamp)) } : {}),
    filters: filters.slice(0, 10)
  }
}

export function configureEqPresets(file: string): void {
  configFile = file
  presets = []
  const current = ++generation
  ready = readFile(file, 'utf8')
    .then((text) => {
      if (current !== generation) return
      const parsed: unknown = JSON.parse(text)
      const list = (parsed as { presets?: unknown })?.presets
      if (!Array.isArray(list)) return
      presets = list.map(sanitize).filter((item): item is StoredEqPreset => item !== null)
    })
    .catch(() => {
      /* 首次运行没有这个文件；损坏按「没有预设」处理，不阻断启动。 */
    })
}

async function persist(): Promise<void> {
  if (!configFile) return
  const file = configFile
  const payload = { version: 1, presets }
  const write = writing.then(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(payload, null, 2), 'utf8')
    await rename(file + '.tmp', file)
  })
  writing = write.catch(() => undefined)
  await write
}

export async function readEqPresets(): Promise<StoredEqPreset[]> {
  await ready
  return presets.map(preset => ({ ...preset }))
}

/** 同名视为「替换」：用户重复导入同一副耳机不该在列表里堆两行。 */
export async function saveEqPreset(raw: unknown): Promise<StoredEqPreset[]> {
  await ready
  const preset = sanitize(raw)
  if (!preset) throw new Error('预设内容无效：需要名称与至少一个合法滤波器。')
  const existing = presets.findIndex(item => item.name === preset.name)
  const next = [...presets]
  if (existing >= 0) next[existing] = { ...preset, id: presets[existing]!.id }
  else next.unshift(preset)
  presets = next.slice(0, MAX_PRESETS)
  await persist()
  return presets.map(item => ({ ...item }))
}

export async function removeEqPreset(idOrName: string): Promise<StoredEqPreset[]> {
  await ready
  presets = presets.filter(item => item.id !== idOrName && item.name !== idOrName)
  await persist()
  return presets.map(item => ({ ...item }))
}
