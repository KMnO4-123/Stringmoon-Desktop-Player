/** 主进程持久化的均衡器预设（应用侧共享形状）。 */
import type { EqFilter } from './eq-preset'

export interface EqPresetRecord {
  id: string
  name: string
  /** 来自哪一套测量（AutoEQ 的 rig）；导入文件时没有。 */
  rig?: string
  preampDb?: number
  filters: EqFilter[]
}

/** AutoEQ 型号索引里的一项：型号名 + 它所在的测量 rig。 */
export interface AutoEqModelChoice {
  name: string
  rig: string
}

/** 房间校正的持久化偏好（只记路径，不记冲激响应本身）。 */
export interface IrPrefs {
  path: string
  enabled: boolean
  preampDb: number
}
