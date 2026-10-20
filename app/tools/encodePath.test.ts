/**
 * C2 语法断言（DESIGN-B §4.3 六条）—— 把 v5 §3.2 判定表变成可执行规格。
 * 跑法：pnpm test:c2（node --test，type-stripping 模式）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePath, srcRateHeight, describePath } from '../src/renderer/src/c2/encodePath.ts'

// 1. 重采样 → 必有折线
test('resampled implies bend', () => {
  const p = encodePath({ loaded: true, resampled: true })
  assert.ok(p.segs.includes('bend'))
  assert.equal(p.bp, false)
})

// 2. 降级 → 必有虚线，且 severity=warn（琥珀慢闪走 C1，红只给真失败）
test('degradeReason implies dash + warn', () => {
  const p = encodePath({ loaded: true, degradeReason: '独占无回调，已回退共享' })
  assert.ok(p.segs.includes('dash'))
  assert.equal(p.severity, 'warn')
})

// 3. bit-perfect → 全链无改动（不得出现折线/虚线/波浪）
test('bitPerfect excludes alteration marks', () => {
  const p = encodePath({ loaded: true, bitPerfect: true, resampled: false, dspActive: false, dspCapable: true })
  assert.ok(!p.segs.includes('bend'))
  assert.ok(!p.segs.includes('dash'))
  assert.ok(!p.segs.includes('wave'))
  assert.equal(p.bp, true)
})

// 3b. 矛盾输入防御：引擎报 bitPerfect 但又有重采样 → BP 必须为 false（引擎语义：链自身上报直通才可 BP）
test('bitPerfect with resampled is contradictory -> bp false', () => {
  const p = encodePath({ loaded: true, bitPerfect: true, resampled: true })
  assert.equal(p.bp, false)
})

// 4. 共享模式 → 输出段是空心圆（编码层统一 circle，实/虚由渲染按 outputMode；这里断言段存在且不报错）
test('shared mode keeps circle segment', () => {
  const p = encodePath({ loaded: true, outputMode: 'shared' })
  assert.ok(p.segs.includes('circle'))
})

// 5. 蓝牙 → 输出段带括号标记
test('bluetooth adds paren', () => {
  const p = encodePath({ loaded: true, isBluetooth: true })
  assert.ok(p.segs.includes('paren'))
})

// 6. 组合不冲突：重采样 + DSP 波浪可同时出现（v5 §9 的例子）
test('bend and wave coexist', () => {
  const p = encodePath({ loaded: true, resampled: true, dspCapable: true, dspActive: true })
  assert.ok(p.segs.includes('bend'))
  assert.ok(p.segs.includes('wave'))
})

// 7. 能力守门：dspCapable=false → DSP 段完全不出现（P1：只画引擎声明支持的）
test('dsp incapable omits segment', () => {
  const p = encodePath({ loaded: true, dspCapable: false, dspActive: undefined })
  assert.ok(!p.segs.includes('wave'))
})

// 8. 错误路径：deviceError/fatal → gap + error
test('device error breaks path', () => {
  const p = encodePath({ loaded: true, deviceError: true })
  assert.ok(p.segs.includes('gap'))
  assert.equal(p.severity, 'error')
})

// 9. 源率高度：单调性（44.1k < 48k < 96k）
test('srcRateHeight monotonic', () => {
  const a = srcRateHeight(44100)
  const b = srcRateHeight(48000)
  const c = srcRateHeight(96000)
  assert.ok(a < b && b < c)
})

// 10. aria 描述包含降级原因原文（R1：状态可朗读）
test('describePath includes degrade reason', () => {
  const d = describePath({ loaded: true, degradeReason: '驱动不触发缓冲区事件', outputMode: 'shared' })
  assert.ok(d.includes('驱动不触发缓冲区事件'))
})