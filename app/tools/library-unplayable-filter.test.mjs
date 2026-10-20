import test from 'node:test'
import assert from 'node:assert/strict'
import { visibleTracks } from '../src/renderer/src/store.ts'

/**
 * 「移除出列表」的实际生效点（CR-017）。
 *
 * 移除是**显示决定**而不是删除：被标记的曲目只是不再出现在可见集里，引擎的
 * catalog 与磁盘文件都不动。这里要钉住的是那几条容易出错的性质：
 *   ① 标记的曲目不出现在可见集里；
 *   ② 记录尚未载入（null）时**不过滤** —— 宁可多显示，也不静默藏歌；
 *   ③ 归一身份：不同写法指的是同一首；
 *   ④ 恢复（把路径从标记集合里去掉）之后它立刻回来。
 */

const track = (path) => ({
  trackId: 'tl_' + path.length, title: path, artist: 'a', durationMs: 1000, path
})

const ROOT = 'D:\\Music'
const lib = [track('D:\\Music\\ok.flac'), track('D:\\Music\\bad.flac'), track('D:\\Music\\also-ok.flac')]

test('a marked track is removed from the visible library', () => {
  const visible = visibleTracks(lib, [ROOT], ['D:\\Music\\bad.flac'])
  assert.deepEqual(visible.map((t) => t.path), ['D:\\Music\\ok.flac', 'D:\\Music\\also-ok.flac'])
})

test('nothing is hidden while the records are not loaded yet', () => {
  // null = 记录还没读回来。这时过滤会让整个曲库看起来"少了几首"却没人知道为什么。
  const visible = visibleTracks(lib, [ROOT], null)
  assert.equal(visible.length, 3, 'records not loaded => show everything')
})

test('an empty record list hides nothing', () => {
  assert.equal(visibleTracks(lib, [ROOT], []).length, 3)
})

test('the mark follows the normalised path, not the spelling', () => {
  // 引擎把调用方的目录字符串原样拼进 path，所以同一首歌可能以两种写法出现；
  // 标记用的是归一后的键，两种写法都必须被挡住（CR-013 的同一套规则）。
  const visible = visibleTracks(lib, [ROOT], ['D:/Music/BAD.flac'])
  assert.deepEqual(visible.map((t) => t.path), ['D:\\Music\\ok.flac', 'D:\\Music\\also-ok.flac'])
})

test('restoring brings the track straight back', () => {
  const hidden = visibleTracks(lib, [ROOT], ['D:\\Music\\bad.flac'])
  assert.equal(hidden.length, 2)
  const restored = visibleTracks(lib, [ROOT], [])
  assert.equal(restored.length, 3, 'removing the record restores the track with no rescan')
})

test('a mark outside the library directories changes nothing', () => {
  const visible = visibleTracks(lib, [ROOT], ['D:\\Other\\unrelated.flac'])
  assert.equal(visible.length, 3)
})

test('directory filtering and unplayable filtering compose', () => {
  const mixed = [...lib, track('D:\\Other\\elsewhere.flac')]
  // Directory scope first: only D:\Music is in the library. Then the mark.
  const visible = visibleTracks(mixed, [ROOT], ['D:\\Music\\bad.flac'])
  assert.deepEqual(visible.map((t) => t.path), ['D:\\Music\\ok.flac', 'D:\\Music\\also-ok.flac'])
})
