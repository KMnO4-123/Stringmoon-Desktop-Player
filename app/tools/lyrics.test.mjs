import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as position from '../src/renderer/src/positionStore.ts'
import { parseLrc } from '../src/shared/lrc.ts'
import { activeLineIndex, wordFill } from '../src/renderer/src/lyricFill.ts'
import { MAX_EXTRAPOLATION_MS, anchorPlayhead, playheadMs, resetPlayhead } from '../src/renderer/src/lyricPlayhead.ts'

const fixture = (name) => readFileSync(new URL('../fixtures/lyrics/' + name, import.meta.url), 'utf8')

afterEach(() => { delete globalThis.document })

test('word-level lyrics keep the spaces the author wrote', () => {
  // 旧实现给每个词段做了 .trim()，把「下一个标签前的空格」当噪声删掉了：
  // "…增强LRC<00:35.80> word" 渲染成 "增强LRCword"。中文段落看着还凑合，
  // 中英混排直接把单词粘在一起 —— 截图里就是 "数据来自增强LRCwordByWord为真"。
  for (const name of ['demo-word.lrc', 'demo.lrc']) {
    const { lines } = parseLrc(fixture(name))
    for (const line of lines) {
      if (line.words.length === 0) continue
      const rendered = line.words.map((w) => w.text).join('')
      // 渲染层用的是 words，所以「渲染出来的字」必须与整行文本逐字相同。
      assert.equal(rendered, line.text, name + ' @ ' + line.startMs + 'ms')
    }
  }
  const { lines } = parseLrc(fixture('demo-word.lrc'))
  const latin = lines.map((l) => l.words.map((w) => w.text).join('')).find((t) => t.includes('wordByWord'))
  assert.equal(latin, '数据来自增强LRC wordByWord为真')
})

test('the visual playhead tweens between events, freezes when late and snaps on arrival', () => {
  resetPlayhead()
  assert.equal(playheadMs(1000), 0, 'nothing has been sung before the first anchor')
  anchorPlayhead(5000, true, 1000)
  assert.equal(playheadMs(1000), 5000)
  assert.equal(playheadMs(1050), 5050, 'between events it advances with the wall clock (that is the whole point)')
  assert.equal(playheadMs(1200), 5200)
  // 事件迟到：冻结在补间上限，而不是继续跑 —— 宁可停住，也不谎报已经唱到哪。
  assert.equal(playheadMs(1000 + MAX_EXTRAPOLATION_MS + 5000), 5000 + MAX_EXTRAPOLATION_MS)
  // 新事件到达即对齐：不做平滑追赶，补间不引入滞后。
  anchorPlayhead(6000, true, 2000)
  assert.equal(playheadMs(2000), 6000)
  // 暂停（或未播放）：就是最后一次权威值，不再自己往前走。
  anchorPlayhead(6000, false, 2000)
  assert.equal(playheadMs(99999), 6000)
})

test('a position event inside one line yields one distinct active index', () => {
  const lyrics = { wordByWord: true, source: 'local', lines: [
    { startMs: 0, endMs: 1000, text: 'a', words: [] },
    { startMs: 1000, endMs: 2000, text: 'b', words: [] },
    { startMs: 2000, endMs: 3000, text: 'c', words: [] }
  ] }
  const seen = new Set()
  for (let ms = 0; ms < 1000; ms += 50) seen.add(activeLineIndex(lyrics, ms))
  // React 的 useSyncExternalStore 比较这个返回值：同一行内 20 个事件得到同一个数 → 至多一次重渲染。
  assert.deepEqual([...seen], [0], '20 events inside one line must not wake React 20 times')
  assert.equal(activeLineIndex(lyrics, 1500), 1)
  assert.equal(activeLineIndex(lyrics, 2500), 2)
  assert.equal(activeLineIndex(lyrics, 99999), 2, 'past the end the last line stays active')
  assert.equal(activeLineIndex(lyrics, -5), -1, 'before the first line nothing is active')
  assert.equal(activeLineIndex(null, 10), -1)
})

test('wordFill is clamped, monotonic and never divides by a zero length', () => {
  const word = { startMs: 1000, endMs: 3000 }
  assert.equal(wordFill(0, word), 0, 'before the word')
  assert.equal(wordFill(1000, word), 0, 'exactly at the start')
  assert.equal(wordFill(2000, word), 0.5, 'halfway')
  assert.equal(wordFill(3000, word), 1, 'exactly at the end')
  assert.equal(wordFill(9e9, word), 1, 'long after')
  // 单调不减：填充只能向前走，位置回退时最多停在原地（engine 回退 seek 也不该倒着亮）。
  let previous = -1
  for (let ms = 0; ms <= 4000; ms += 50) {
    const fill = wordFill(ms, word)
    assert.ok(fill >= previous - 1e-9, 'monotonic at ' + ms)
    assert.ok(fill >= 0 && fill <= 1, 'within [0,1] at ' + ms)
    previous = fill
  }
  // 增强 LRC 解析中途会出现 start == end 的词，不能产生 NaN 或闪光。
  const pending = { startMs: 5000, endMs: 5000 }
  assert.equal(wordFill(4999, pending), 0)
  assert.equal(wordFill(5000, pending), 1)
  assert.ok(Number.isFinite(wordFill(5000, pending)))
})

test('identical position snapshots preserve identity and do not wake subscribers', () => {
  position.resetPosition('track', 10000)
  const before = position.getPosition()
  let wakes = 0
  const off = position.subscribePosition(() => wakes++)
  position.setPosition({ positionMs: 0, durationMs: 10000, trackId: 'track' })
  off()
  assert.equal(wakes, 0)
  assert.equal(position.getPosition(), before)
})

test('hidden lyrics stop subscribing and resume once with the latest engine position', () => {
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  position.resetPosition('track', 10000)
  const seen = []
  const off = position.subscribeVisiblePosition(() => seen.push(position.getPosition().positionMs))
  position.setPosition({ positionMs: 100 })
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  position.setPosition({ positionMs: 200 })
  position.setPosition({ positionMs: 900 })
  assert.deepEqual(seen, [100])
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  assert.deepEqual(seen, [100, 900])
  off()
  document.dispatchEvent(new Event('visibilitychange'))
  position.setPosition({ positionMs: 1000 })
  assert.deepEqual(seen, [100, 900])
})

test('lyrics mounted while hidden do no work until visible', () => {
  globalThis.document = Object.assign(new EventTarget(), { hidden: true })
  let wakes = 0
  const off = position.subscribeVisiblePosition(() => wakes++)
  position.setPosition({ positionMs: 500 })
  assert.equal(wakes, 0)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(wakes, 1)
  off()
})
