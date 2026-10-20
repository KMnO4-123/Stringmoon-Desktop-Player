/** 「无法播放的曲目」记录的应用侧形状（主进程 ↔ 渲染进程）。 */

/**
 * 为什么这个文件被认为播不了。
 *
 * - `scan`：扫描预检时解码器拒绝（CR-017 的 probe）。这是**入库前**的判定，
 *   这类文件根本不会进入曲库，所以正常情况下用户不会在这里看到它们；
 *   只有跨版本遗留（先入库、后加预检）或恢复记录后才会出现。
 * - `playback`：播放时解码/打开失败。这是用户真正会撞上的那一类 ——
 *   文件在列表里、点开或被队列播到才失败。
 */
export type UnplayableSource = 'scan' | 'playback'

export interface UnplayableEntry {
  /** 绝对路径。曲目身份用归一后的 path，与曲库其余部分同一套规则。 */
  path: string
  /** 解码器给出的人类可读原因，界面直接展示，便于判断是坏了还是格式不支持。 */
  reason: string
  source: UnplayableSource
  /** ISO 时间戳；用户要能知道"这是什么时候被标记的"。 */
  detectedAt: string
}

export interface UnplayableReport {
  entries: UnplayableEntry[]
}
