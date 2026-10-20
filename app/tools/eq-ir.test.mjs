import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const store = await import('../src/main/eq-ir.ts')

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'te-ir-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'eq-ir.json')
  store.configureEqIr(file)
  return { directory, file }
}

test('the room-correction choice survives a restart, because it is a file', async (t) => {
  const { file } = await workspace(t)
  assert.equal(await store.readIrPrefs(), null)

  await store.writeIrPrefs({ path: 'D:/music/room.wav', enabled: true, preampDb: -3.5 })
  store.configureEqIr(file)
  const reloaded = await store.readIrPrefs()
  assert.ok(reloaded)
  assert.equal(reloaded.path, 'D:/music/room.wav')
  assert.equal(reloaded.enabled, true)
  assert.equal(reloaded.preampDb, -3.5)
  // 只记路径，不记冲激响应本身
  const text = await readFile(file, 'utf8')
  assert.ok(text.includes('room.wav'))
  assert.ok(text.length < 400, 'the config file stays tiny: ' + text.length + ' bytes')
})

test('a toggle-only change keeps the path and clamps the level', async (t) => {
  await workspace(t)
  await store.writeIrPrefs({ path: 'D:/music/room.wav', enabled: true, preampDb: 0 })
  const off = await store.writeIrPrefs({ path: 'D:/music/room.wav', enabled: false, preampDb: 99 })
  assert.equal(off.enabled, false)
  assert.equal(off.preampDb, 24, 'a level outside +-24 dB is clamped, not stored')
})

test('an entry without a path is refused rather than half-saved', async (t) => {
  await workspace(t)
  assert.equal(await store.writeIrPrefs({ path: '', enabled: true, preampDb: 0 }), null)
  assert.equal(await store.readIrPrefs(), null)
})

test('a corrupt file means no preference, not a startup failure', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'te-ir-bad-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'eq-ir.json')
  await writeFile(file, '{ not json', 'utf8')
  store.configureEqIr(file)
  assert.equal(await store.readIrPrefs(), null)
})
