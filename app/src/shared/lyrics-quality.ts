import type { Lyrics } from './protocol'

/**
 * 歌词与曲目时长的自洽检查 —— 「精确匹配」里唯一不依赖元数据字符串的证据。
 *
 * 计分看的是歌名/艺人/时长这些**字符串**；而歌词自己的时间轴说的是**这首歌放完之前它唱完了没有**。
 * 同名翻唱、live 版、现场剪辑版在被判成同一首时，元数据可能全对，时间轴却对不上。
 *
 * 阈值是量出来的，不是拍的（2026-10-17，8 首真实曲目）：
 *   歌词末尾比曲长短 1–42 s（片尾器乐），首行在第一句前 0–27 s 出现。
 * 所以：超出曲长 75 s 才判「这条歌词不是这首的」；超出 30 s 记高风险但照常使用；
 * 覆盖不到曲长 45% 记高风险（可能是残词或别的版本），但不拒绝 —— 截断的歌词仍然唱对得上前面。
 */

/** 硬拒：歌词明显比曲目还长。 */
const OVERRUN_REJECT_MS = 75_000
/** 记风险：结尾压在曲目之后（可能是更长的版本）。 */
const OVERRUN_RISK_MS = 30_000
/** 记风险：歌词覆盖不到曲目时长的这个比例（残词/别的版本）。 */
const COVERAGE_RISK_RATIO = 0.45
/** 太短的曲目（提示音/音效）不做这条判断，比例没有意义。 */
const MIN_DURATION_MS = 60_000

export type TimelineIssue = 'exceeds_track' | 'overrun' | 'truncated' | null

export interface TimelineCheck {
  /** false = 这条歌词几乎不可能是这首歌的，应当放弃并继续下一档 */
  accept: boolean
  /** true = 用得，但要标高风险让用户看见 */
  risky: boolean
  issue: TimelineIssue
}

export function checkTimeline(lyrics: Lyrics, durationMs: number | undefined): TimelineCheck {
  const clean: TimelineCheck = { accept: true, risky: false, issue: null }
  if (!durationMs || durationMs < MIN_DURATION_MS) return clean
  if (!lyrics || lyrics.lines.length === 0) return clean
  // 只看**结尾**：覆盖到哪儿由最后一句唱完的位置决定。
  // （早先这里还拿 startMs 兜底，结果一行 end 是 NaN 时会把覆盖长度判成 0，误报「残词」。）
  let lastEnd = 0
  for (const line of lyrics.lines) {
    if (!Number.isFinite(line.endMs)) continue
    if (line.endMs > lastEnd) lastEnd = line.endMs
  }
  if (lastEnd <= 0) return clean
  if (lastEnd > durationMs + OVERRUN_REJECT_MS) return { accept: false, risky: true, issue: 'exceeds_track' }
  if (lastEnd > durationMs + OVERRUN_RISK_MS) return { accept: true, risky: true, issue: 'overrun' }
  if (lastEnd < durationMs * COVERAGE_RISK_RATIO) return { accept: true, risky: true, issue: 'truncated' }
  return clean
}
