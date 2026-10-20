/**
 * C2 信号路径编码器（DESIGN v5 §3.2 判定表的纯函数形态）。
 * 输入：引擎状态快照（state 事件 + get_state 补充 + capabilities）。
 * 输出：可渲染的段序列 —— 无 React、无 DOM、无颜色（R3：色盲/亮色主题零损失）。
 *
 * 六段：decode(方) → srcRate(竖线) → convert(直线/折线) → dsp(波浪,可选) → output(圆) → bp(实线)
 * 纪律：
 *  - 界面只画引擎声明支持的东西：capabilities.dsp=false → dsp 段不出现（P1）。
 *  - bitPerfect=true 时全链不得出现 bend/dash/wave（BP = 无改动的连续实线）。
 *  - degradeReason 存在 → dash 段（虚线），severity 至少 warn；红只给真失败。
 *  - dspActive 未上报（undefined）→ dsp 段画"直通线"占位但不画波浪；不上报就不猜。
 */

export type C2Seg =
  | 'square'      // 解码节点：实心=已装载/解码，空心=未装载
  | 'bar'         // 源率竖线：height 编码采样率
  | 'line'        // 直通线段
  | 'bend'        // 折线 ∧：重采样
  | 'dash'        // 虚线 ┄：降级（degradeReason）
  | 'wave'        // 波浪 ～～：DSP 生效
  | 'circle'      // 输出节点：实心=独占，空心=共享
  | 'paren'       // 蓝牙括号修饰
  | 'gap'         // 断口：设备错误/致命

export interface C2Path {
  segs: C2Seg[]
  bp: boolean
  severity: 'ok' | 'warn' | 'error'
}

/** 引擎状态快照（应用侧视角的字段并集；undefined = 引擎未上报，不猜） */
export interface EngineStateSnapshot {
  loaded: boolean
  trackId?: string
  outputMode?: 'exclusive' | 'shared'
  sampleRate?: number
  sourceSampleRate?: number
  resampled?: boolean
  bitPerfect?: boolean
  degradeReason?: string | null
  dspActive?: boolean
  dspCapable?: boolean
  dspModules?: string[]
  xrunCount?: number
  isBluetooth?: boolean
  hasExclusive?: boolean
  exclusiveFormats?: string[]
  deviceError?: boolean
  fatal?: boolean
}

/** 采样率 → 竖线相对高度（0..1）。已知档位线性映射，未知档位按对数插值兜底 */
export function srcRateHeight(hz?: number): number {
  if (!hz || hz <= 0) return 0.25
  const known: Array<[number, number]> = [
    [44100, 0.35],
    [48000, 0.42],
    [88200, 0.62],
    [96000, 0.7],
    [176400, 0.86],
    [192000, 0.95]
  ]
  for (const [hz0, h] of known) {
    if (hz === hz0) return h
  }
  if (hz < 44100) return 0.3
  return Math.min(1, 0.35 + 0.3 * Math.log2(hz / 44100))
}

export function encodePath(s: EngineStateSnapshot): C2Path {
  // 致命/设备错误：路径断开
  if (s.fatal || s.deviceError) {
    return { segs: ['square', 'gap', 'circle'], bp: false, severity: 'error' }
  }

  const segs: C2Seg[] = []

  // 1) 解码
  segs.push('square')

  // 2) 源率（竖线高度由渲染层按 srcRateHeight 画，编码层只放段）
  segs.push('bar')

  // 3) 转换：重采样 → 折线；否则直通线
  segs.push(s.resampled ? 'bend' : 'line')

  // 4) DSP：只画引擎声明支持且上报生效的（字段未上报 → 直通占位）
  if (s.dspCapable) {
    segs.push(s.dspActive ? 'wave' : 'line')
  }

  // 5) 输出：圆（实/虚由渲染层按 outputMode；蓝牙加括号修饰段）
  segs.push('circle')
  if (s.isBluetooth) segs.push('paren')

  // 6) 降级虚线（degradeReason 优先级高于普通直通；虚线段插在输出圆之前语义位）
  if (s.degradeReason) {
    segs.splice(segs.indexOf('circle'), 0, 'dash')
  }

  // BP 判定：引擎声明 bit-perfect 且全链确无改动标记
  const hasAlteration = segs.includes('bend') || segs.includes('dash') || segs.includes('wave')
  const bp = s.bitPerfect === true && !hasAlteration

  // severity：错误 > 降级 > 正常（颜色只表达这个，几何已表达"是什么"）
  const severity: C2Path['severity'] = s.fatal || s.deviceError ? 'error' : s.degradeReason ? 'warn' : 'ok'

  return { segs, bp, severity }
}

/** aria 文案（R1：状态必须可朗读；从段序列生成稳定描述） */
export function describePath(s: EngineStateSnapshot): string {
  if (s.fatal) return '引擎致命错误，路径中断'
  if (s.deviceError) return '输出设备错误，路径中断'
  if (!s.loaded) return '未装载曲目'
  const parts: string[] = []
  parts.push(s.trackId ? '曲目 ' + s.trackId : '曲目')
  if (s.sourceSampleRate && s.sampleRate && s.sourceSampleRate !== s.sampleRate) {
    parts.push((s.sourceSampleRate / 1000).toFixed(1).replace(/\.0$/, '') + 'kHz 重采样到 ' + (s.sampleRate / 1000).toFixed(1).replace(/\.0$/, '') + 'kHz')
  } else if (s.sampleRate) {
    parts.push((s.sampleRate / 1000).toFixed(1).replace(/\.0$/, '') + 'kHz 直通')
  }
  if (s.dspCapable && s.dspActive) {
    const names = s.dspModules?.map(m => m === 'eq' ? 'EQ' : m === 'replaygain' ? 'ReplayGain' : m)
    parts.push('数字信号处理生效' + (names?.length ? '：' + names.join('、') : ''))
  }
  if (s.outputMode) parts.push(s.outputMode === 'exclusive' ? '独占输出' : '共享输出')
  if (s.xrunCount !== undefined && s.xrunCount > 0) parts.push('会话累计 xrun ' + s.xrunCount)
  if (s.isBluetooth) parts.push('蓝牙链路')
  if (s.degradeReason) parts.push('已降级：' + s.degradeReason)
  if (s.bitPerfect && !s.degradeReason && !s.resampled && !(s.dspCapable && s.dspActive)) {
    parts.push('比特完美')
  }
  return parts.join('，')
}
