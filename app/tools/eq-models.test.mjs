import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelCount, normalizeModel, searchEqModels } from '../src/main/eq-models.ts'

test('the shipped index covers the whole AutoEQ catalogue', () => {
  // AutoEQ 的 results/README.md 自己声明覆盖 6033 个型号；索引若少太多，说明解析漏了。
  assert.equal(modelCount(), 6033)
})

test('searching a model fragment finds the model users mean', () => {
  const hd600 = searchEqModels('HD 600', 10)
  assert.ok(hd600.length > 0)
  assert.equal(hd600[0].name, 'Sennheiser HD 600')
  assert.ok(hd600[0].rig.includes('oratory1990'), 'the rig is returned so the fetch can go straight there')

  const aria = searchEqModels('aria', 10)
  assert.ok(aria.some(item => item.name === 'Moondrop Aria'), JSON.stringify(aria.map(item => item.name)))

  // 空格与大小写不该影响结果：用户打 "hd600" 是常态。
  assert.equal(searchEqModels('hd600', 5)[0].name, 'Sennheiser HD 600')
  assert.equal(normalizeModel('Sony WH-1000XM4'), normalizeModel('sony wh1000xm4'))
})

test('an exact name outranks a longer one that merely contains it', () => {
  const results = searchEqModels('Moondrop Aria', 10)
  assert.equal(results[0].name, 'Moondrop Aria')
})

test('no query means no results, and gibberish does not fill a page', () => {
  assert.deepEqual(searchEqModels('   '), [])
  const nonsense = searchEqModels('zzzzqqqqxxxx', 10)
  assert.ok(nonsense.length < 10, 'fuzzy matching must not return a full page for gibberish')
})
