// preload 暴露面守卫：index.d.ts 里声明的方法，必须真的存在于 index.ts 的 contextBridge 对象。
//
// 为什么需要这条闸（2026-10-17 性能审计发现）：streamingSetSecret 在 index.d.ts 与
// 渲染层里都被使用，主进程也注册了 twilight:streaming-secret handler，唯独 preload
// 忘了暴露。TypeScript 只看 d.ts，所以 typecheck 永远绿；运行时点「保存令牌」才炸成
// "window.twilight.streamingSetSecret is not a function"。类型系统管不到 contextBridge
// 的实际对象形状，只有源码级断言能拦住这种「声明了但没实现」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const declaration = readFileSync(new URL('../src/preload/index.d.ts', import.meta.url), 'utf8')

/** index.d.ts 里 `interface Window { twilight: { ... } }` 声明的方法名。 */
function declaredMethods(text) {
  const start = text.indexOf('twilight: {')
  const end = text.indexOf('\n  }', start)
  const block = text.slice(start, end)
  return [...block.matchAll(/^\s{6}([A-Za-z_$][\w$]*):/gm)].map(match => match[1])
}

/** preload/index.ts 里 `const api = { ... }` 实际暴露的方法名。 */
function exposedMethods(text) {
  const start = text.indexOf('const api = {')
  const end = text.indexOf('\n}', start)
  const block = text.slice(start, end)
  return [...block.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map(match => match[1])
}

test('every method declared on window.twilight is actually exposed by preload', () => {
  const declared = declaredMethods(declaration)
  const exposed = new Set(exposedMethods(preload))
  assert.ok(declared.length > 50, 'sanity: window.twilight should declare a non-trivial surface')
  const missing = declared.filter(name => !exposed.has(name))
  assert.deepEqual(missing, [], 'preload 漏暴露（声明了但运行时不存在）: ' + missing.join(', '))
})

test('preload exposes the streaming secret setter used by the renderer', () => {
  // 回归点：它曾经只在 d.ts 与 renderer 里存在，导致 Meting 令牌永远存不下来。
  assert.ok(exposedMethods(preload).includes('streamingSetSecret'))
})
