#!/usr/bin/env node
/**
 * tools/gen-fixture.mjs — 生成 app/fixtures/library-91.json（BRIEF-B 第 2 步占位曲库）。
 * 真实文件名 + 确定性伪时长（与 mock-engine.mjs 同一 hash，保证两边一致）。
 * AI-A 的 engine/fixtures/library-91.json 出现后，用真数据替换（接入层不用改）。
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 可用 STRINGMOON_TEST_LIBRARY 指向本机测试曲库；缺省取当前用户的音乐文件夹。
const DIR = process.env.STRINGMOON_TEST_LIBRARY ?? path.join(homedir(), 'Music')

function hashDurationMs(name) {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 90000 + (Math.abs(h) % 330000) + (name.length % 7) * 1000
}

function parseName(basename) {
  const stem = basename.replace(/\.flac$/i, '')
  const m = stem.match(/^(.+?)\s+-\s+(.+)$/)
  if (m) return { artist: m[1].trim(), title: m[2] }
  return { artist: '未知艺术家', title: stem }
}

const names = fs.readdirSync(DIR).filter((n) => /\.flac$/i.test(n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const tracks = names.map((n, i) => {
  const { artist, title } = parseName(n)
  return {
    trackId: 'tl_' + String(i + 1).padStart(4, '0'),
    title,
    artist,
    album: 'Twilight Test Library',
    durationMs: hashDurationMs(n),
    path: path.join(DIR, n),
    sampleRate: 96000,
    bitDepth: 24
  }
})

const out = {
  note: 'AI-B 占位 fixture：真实文件名 + 确定性伪时长（mock-engine 同一 hash）。A 的 engine/fixtures/library-91.json 出现后替换。',
  generatedAt: new Date().toISOString(),
  sourceDir: DIR,
  count: tracks.length,
  tracks
}
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'library-91.json')
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n')
console.log('wrote', dest, 'with', tracks.length, 'tracks')
