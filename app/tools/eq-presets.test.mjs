import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const store = await import('../src/main/eq-presets.ts')

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'te-eq-presets-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'eq-presets.json')
  store.configureEqPresets(file)
  return { directory, file }
}

const PRESET = {
  id: '',
  name: 'HD 600',
  preampDb: -6.3,
  filters: [{ type: 'lowShelf', freq: 105, gainDb: 6.5, q: 0.7 }, { type: 'peaking', freq: 8445, gainDb: 3.3, q: 1.61 }]
}

test('a preset survives a restart, because it is a file and not localStorage', async (t) => {
  const { file } = await workspace(t)
  assert.deepEqual(await store.readEqPresets(), [])
  const saved = await store.saveEqPreset(PRESET)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, 'HD 600')
  assert.equal(saved[0].filters[0].type, 'lowShelf', 'shelf type is preserved, not flattened to peaking')
  assert.ok(saved[0].id.length > 0, 'the store assigns an id')
  assert.ok((await readFile(file, 'utf8')).includes('HD 600'))

  store.configureEqPresets(file)
  const reloaded = await store.readEqPresets()
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].preampDb, -6.3)
  assert.equal(reloaded[0].filters[1].q, 1.61)
})

test('importing the same model twice replaces instead of stacking rows', async (t) => {
  await workspace(t)
  await store.saveEqPreset(PRESET)
  const second = await store.saveEqPreset({ ...PRESET, preampDb: -5 })
  assert.equal(second.length, 1)
  assert.equal(second[0].preampDb, -5)
  assert.equal(second[0].id, (await store.readEqPresets())[0].id, 'the id is kept')
})

test('removal works by name or by id, and only removes that one', async (t) => {
  await workspace(t)
  await store.saveEqPreset(PRESET)
  await store.saveEqPreset({ id: '', name: 'Aria', filters: PRESET.filters })
  assert.equal((await store.readEqPresets()).length, 2)
  const byName = await store.removeEqPreset('HD 600')
  assert.deepEqual(byName.map(item => item.name), ['Aria'])
  const id = byName[0].id
  assert.deepEqual(await store.removeEqPreset(id), [])
})

test('invalid presets are refused instead of being written as garbage', async (t) => {
  await workspace(t)
  await assert.rejects(store.saveEqPreset({ name: '', filters: PRESET.filters }), /无效|名称/)
  await assert.rejects(store.saveEqPreset({ name: 'x', filters: [] }), /无效|滤波器/)
  // 越界的滤波器被丢掉；如果全被丢掉，整条预设拒绝。
  await assert.rejects(store.saveEqPreset({ name: 'x', filters: [{ type: 'peaking', freq: 999999, gainDb: 0, q: 1 }] }), /无效/)
  // 只保留十个槽位
  const many = Array.from({ length: 14 }, (_, i) => ({ type: 'peaking', freq: 100 + i * 10, gainDb: 1, q: 1.41 }))
  const saved = await store.saveEqPreset({ id: '', name: 'many', filters: many })
  assert.equal(saved[0].filters.length, 10)
})

test('a corrupt file starts empty instead of blocking the app', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'te-eq-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'eq-presets.json')
  await writeFile(file, '{ this is not json', 'utf8')
  store.configureEqPresets(file)
  assert.deepEqual(await store.readEqPresets(), [])
})
