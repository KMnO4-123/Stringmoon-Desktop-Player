import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/styles')
let problems = 0
for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.css'))) {
  const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  let depth = 0
  let line = 1
  let lastOpen = 1
  for (const char of text) {
    if (char === '\n') line++
    if (char === '{') { depth++; lastOpen = line }
    if (char === '}') { depth--; if (depth < 0) { console.log('[css] ' + name + ':' + line + ' 多余的 }'); problems++; depth = 0 } }
  }
  if (depth !== 0) { console.log('[css] ' + name + ' 有 ' + depth + ' 个未闭合的块（最后在 ' + lastOpen + ' 行打开）'); problems += depth }
}
if (problems > 0) { console.log('[css] 大括号不配平：' + problems + ' 处'); process.exitCode = 1 }
else console.log('[css] braces balanced')
