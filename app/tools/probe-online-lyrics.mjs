/**
 * 在线取词探针：真实网络 + 真实文件，打印「这一首最后落到了哪一档」。
 *
 * 为什么要有它：单测只能证明「给我一份 JSON 我能算对」，证明不了
 * 「线上真的会返回这个形状」。这一轮的三个关键事实（90/91 无标签、网易云没有 yrc、
 * AMLL 要走镜像）全部是它跑出来的，所以它留在仓库里，而不是用完就删的脚本。
 *
 *   node --import ./tools/register-source.mjs tools/probe-online-lyrics.mjs [目录] [条数]
 *
 * ⚠️ 会联网，且按契约 §5 节流（同平台 ≥1.2 s），所以**不进 pnpm test**。
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { fetchOnlineLyrics } from '../src/main/lyrics-online.ts'

// 可用 STRINGMOON_TEST_LIBRARY 指向本机测试曲库；缺省取当前用户的音乐文件夹。
const DEFAULT_DIR = process.env.STRINGMOON_TEST_LIBRARY ?? path.join(homedir(), 'Music')
const dir = process.argv[2] ?? DEFAULT_DIR
const limit = Number(process.argv[3] ?? 5)

let files
try {
  files = readdirSync(dir).filter(name => /\.(flac|mp3|m4a|ogg|oga|wav)$/i.test(name)).sort()
} catch (error) {
  console.error('读不到目录：' + dir + '（' + (error?.message ?? error) + '）')
  process.exit(1)
}
if (files.length === 0) {
  console.error('目录里没有音频文件：' + dir)
  process.exit(1)
}

// 挑长度适中的几首：太短的可能只是音效，太长的探测耗时长。
const picked = files.slice(0, Number.isFinite(limit) ? Math.max(1, limit) : 5)
console.log('目录：' + dir + '  共 ' + files.length + ' 首，探测 ' + picked.length + ' 首\n')

const tally = { 'amll-ttml': 0, netease: 0, lrclib: 0, instrumental: 0, none: 0, error: 0 }
for (const name of picked) {
  const full = path.join(dir, name)
  const stem = name.replace(/\.[^.]+$/, '')
  let durationMs = 0
  try { durationMs = Math.round((await parseFile(full, { duration: true })).format.duration * 1000) } catch { /* 标签坏了不影响探测 */ }
  // 与引擎同口径：没有 ARTIST 标签时 title 就是文件名主干，artist 为空。
  const track = { trackId: 'probe', title: stem, artist: '', durationMs, path: full }
  const started = Date.now()
  try {
    const result = await fetchOnlineLyrics(track)
    const ms = Date.now() - started
    if (!result) { tally.none++; console.log('  ○ 无歌词    ' + stem + '  (' + ms + ' ms)'); continue }
    if (!result.lyrics) { tally.instrumental++; console.log('  ○ 纯音乐    ' + stem + '  (' + ms + ' ms)  命中=' + result.match.title); continue }
    tally[result.match.provider]++
    const lines = result.lyrics.lines
    const withTranslation = lines.find(line => line.translation) ?? lines[0]
    const ruby = lines.flatMap(line => line.words).find(word => word.ruby)
    console.log('  ✓ ' + stem)
    console.log('      来源=' + result.match.provider + '/' + result.lyrics.source
      + '  计分=' + result.match.score + '  风险=' + result.match.risk
      + '  行数=' + lines.length + '  逐字=' + result.lyrics.wordByWord + '  ' + ms + ' ms')
    console.log('      命中=' + result.match.title + ' / ' + result.match.artist)
    console.log('      原文=' + JSON.stringify(withTranslation.text).slice(0, 90))
    if (withTranslation.translation) console.log('      翻译=' + JSON.stringify(withTranslation.translation).slice(0, 70))
    if (withTranslation.romanization) console.log('      注音=' + JSON.stringify(withTranslation.romanization).slice(0, 70))
    if (ruby) console.log('      振假名=' + ruby.text + '(' + ruby.ruby + ')')
  } catch (error) {
    tally.error++
    console.log('  ✗ 失败      ' + stem + ' :: ' + (error?.message ?? error))
  }
}

console.log('\n汇总：' + JSON.stringify(tally))
