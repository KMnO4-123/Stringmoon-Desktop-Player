/**
 * 十个槽位的默认频率 —— 与引擎 `kEqBandFrequency`（SPEC 3.4）同一套数值。
 *
 * 这里再写一遍是有意的：应用侧不能 include 引擎头文件。两边一旦不一致，
 * 「导入的 AutoEQ 定频预设能否 1:1 对上」就没人说得清了。
 */
export const EQ_BAND_FREQUENCY = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export const EQ_BAND_COUNT = EQ_BAND_FREQUENCY.length

export type EqFilterType = 'peaking' | 'lowShelf' | 'highShelf'

export function isEqFilterType(value: unknown): value is EqFilterType {
  return value === 'peaking' || value === 'lowShelf' || value === 'highShelf'
}
