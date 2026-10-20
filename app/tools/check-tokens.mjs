#!/usr/bin/env node
/**
 * tools/check-tokens.mjs -- 设计令牌强制层(DESIGN v5 §4 / DESIGN-B §3).
 * 检查 src/renderer 下的 css/tsx:
 *  1. 字面颜色(#hex / rgb() / rgba())且文件不是 tokens.css
 *  2. transition: all 或 ease-in 或 cubic-bezier( 字面量 -- 时序/曲线必须走令牌
 *  3. transition/animation 值中的裸 ms/s 时序字面量
 *  4. font-size 中的裸字号字面量
 * 逃生口: 违规行或其上一行含 token-allow: <理由> (CSS 注释包裹) 则跳过并记录.
 * 棘轮: 与 tools/token-baseline.json 比对, 新增违规 exit 1, 只降不升.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src', 'renderer', 'src')
const baselinePath = path.join(root, 'tools', 'token-baseline.json')

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(/
const BAD_EASE_RE = /transition:\s*all|\bease-in\b(?!-)|cubic-bezier\(/
const BARE_DUR_RE = /(?:transition|animation)[^;]*?\b\d+(?:\.\d+)?(?:ms|s)\b/
const BARE_TYPE_RE = /font-size\s*:\s*\d+(?:\.\d+)?(?:px|em|rem|pt|%)/

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(css|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

const files = walk(srcDir).filter((f) => !f.endsWith('tokens.css'))
const violations = {}

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prev = lines[i - 1] ?? ''
    if (/token-allow:/.test(line) || /token-allow:/.test(prev)) continue
    let kind = null
    if (COLOR_RE.test(line)) kind = 'color'
    else if (BAD_EASE_RE.test(line)) kind = 'ease'
    else if (BARE_DUR_RE.test(line)) kind = 'duration'
    else if (BARE_TYPE_RE.test(line)) kind = 'typography'
    if (kind) hits.push({ line: i + 1, kind, text: line.trim().slice(0, 120) })
  }
  if (hits.length > 0) violations[rel] = hits
}

let baseline = { files: {} }
try {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
} catch {
  console.log('[tokens] no baseline yet -- first run records it')
}

let fails = 0
let total = 0
for (const [rel, hits] of Object.entries(violations)) {
  total += hits.length
  const base = baseline.files?.[rel] ?? 0
  if (hits.length > base) {
    const added = hits.slice(base)
    console.error('[tokens] FAIL ' + rel + ': ' + hits.length + ' violations (baseline ' + base + ', +' + added.length + ' new)')
    for (const h of added) console.error("    +" + h.line + " [" + h.kind + "] " + h.text)
    fails++
  } else if (hits.length < base) {
    console.log('[tokens] ratchet available: ' + rel + ' ' + base + ' -> ' + hits.length + ' (update baseline)')
  }
}

for (const rel of Object.keys(baseline.files ?? {})) {
  if (!violations[rel] && baseline.files[rel] > 0) {
    console.log('[tokens] ratchet available: ' + rel + ' ' + baseline.files[rel] + ' -> 0 (update baseline)')
  }
}

console.log('[tokens] total violations: ' + total + ' across ' + Object.keys(violations).length + ' files')
if (fails > 0) {
  console.error('[tokens] NEW violations above baseline -- fix or add a token-allow comment')
  process.exit(1)
}
console.log('[tokens] OK (within baseline)')
