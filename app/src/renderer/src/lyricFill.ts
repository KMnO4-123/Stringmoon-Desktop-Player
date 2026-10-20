import type { LyricLine, LyricWord, Lyrics } from '@shared/protocol'

/**
 * 一个字此刻该被填充的比例：0 = 还没唱到，1 = 唱完。
 *
 * **按已测量的字形宽度插值，不按字数均分**（REFS-B2 §2.6）。这条要求在这里是
 * 「用浏览器的排版结果」而不是「自己量一遍」：
 *
 *  - 填充是一条横跨这个词**自身盒子**的渐变，并被裁到字形上。这个盒子的宽度就是
 *    这个词真实排出来的宽度 —— 全角/半角/CJK 混排各自占多宽由排版引擎决定。
 *  - 所以不需要 `canvas.measureText()` 另算一份宽度：**再算一份就会和真实排版漂移**
 *    （字体回退、字距、kerning 都会让两者不一致），那是比不测量更糟的做法。
 *  - 也绝不按「词里几个字就均分几份」来推宽度 —— 那正是 §2.6 点名会在中日文混排
 *    时算错的做法。
 *
 * 同理不做任何按 code point 的切分（那会把组合字符拆开，本库就有
 * `Cytus - ͟͝͞Ⅱ́̕.flac` 这种文件名的歌词）。词的切分发生在 LRC 解析里，
 * 按标签下标切片，组合字符天然留在同一个词内。
 *
 * 时间轴仍然是作者写的时间轴：这个词从 startMs 唱到 endMs，边界就在这段时间里
 * 匀速走完这个词的宽度 —— 一个字宽就多花时间，窄就少花时间。
 */
/**
 * 活性行 = startMs <= position 的最后一行。
 *
 * 刻意返回**下标**而不是布尔/位置：React 侧用它做 useSyncExternalStore 的快照，
 * 同一行内的每一次 position 事件都得到同一个值 → 不会重渲染整份歌词，
 * 只有真的换行（约每几秒一次）才唤醒 React。
 */
export function activeLineIndex(lyrics: Lyrics | null, positionMs: number): number {
  if (!lyrics) return -1
  let index = -1
  for (let i = 0; i < lyrics.lines.length; i++) {
    const line: LyricLine | undefined = lyrics.lines[i]
    if (line && line.startMs <= positionMs) index = i
    else break
  }
  return index
}

export function wordFill(positionMs: number, word: Pick<LyricWord, 'startMs' | 'endMs'>): number {
  const { startMs, endMs } = word
  // 增强 LRC 里「只有起始标签、结束时间待定」的词会先长成 start == end
  // （解析阶段随后才把 endMs 补成下一个词的起点）。零长度不能除，也不能让它闪一下。
  if (!(endMs > startMs)) return positionMs >= endMs ? 1 : 0
  if (positionMs <= startMs) return 0
  if (positionMs >= endMs) return 1
  return (positionMs - startMs) / (endMs - startMs)
}
