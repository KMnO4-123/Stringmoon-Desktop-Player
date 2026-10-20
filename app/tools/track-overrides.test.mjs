import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const store = await import('../src/main/track-overrides.ts').catch(() => null)
function api() {
  assert.ok(store, 'track override store module should be loadable')
  return store
}

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'stringmoon-overrides-'))
  return { file: path.join(root, 'track-overrides.json'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('overrides use normalized path keys and survive reloading the store', async () => {
  const w = await workspace()
  try {
    const { configureTrackOverrides, readTrackOverrides, setTrackOverride } = api()
    configureTrackOverrides(w.file)
    await setTrackOverride(path.resolve('D:/Music/A.flac'), { title: 'Corrected title', artist: 'Test Artist' })
    configureTrackOverrides(w.file)
    assert.deepEqual(await readTrackOverrides(), { 'd:\\music\\a.flac': { title: 'Corrected title', artist: 'Test Artist' } })
    assert.match(await readFile(w.file, 'utf8'), /"version":1/)
  } finally {
    await w.cleanup()
  }
})

test('partial update and reset preserve other fields and retain missing paths', async () => {
  const w = await workspace()
  try {
    const { configureTrackOverrides, readTrackOverrides, setTrackOverride, resetTrackOverride } = api()
    configureTrackOverrides(w.file)
    const track = path.resolve('D:/Missing/track.flac')
    await setTrackOverride(track, { title: 'New title', artist: 'Test Artist', year: 2024 })
    await setTrackOverride(track, { album: 'After dark' })
    await resetTrackOverride(track, 'artist')
    assert.deepEqual(await readTrackOverrides(), {
      'd:\\missing\\track.flac': { title: 'New title', year: 2024, album: 'After dark' }
    })
    await resetTrackOverride(track)
    assert.deepEqual(await readTrackOverrides(), {})
  } finally {
    await w.cleanup()
  }
})

test('rejects invalid paths and field values without changing saved overrides', async () => {
  const w = await workspace()
  try {
    const { configureTrackOverrides, readTrackOverrides, setTrackOverride } = api()
    configureTrackOverrides(w.file)
    const track = path.resolve('D:/Music/track.flac')
    await setTrackOverride(track, { title: 'Saved title' })
    const before = await readFile(w.file, 'utf8')
    await assert.rejects(setTrackOverride('relative.flac', { title: 'Invalid' }), /absolute/i)
    await assert.rejects(setTrackOverride(track, { title: '   ' }), /title/i)
    await assert.rejects(setTrackOverride(track, { year: 2024.5 }), /year/i)
    assert.equal(await readFile(w.file, 'utf8'), before)
  } finally {
    await w.cleanup()
  }
})

test('corrupt override documents recover as empty and can be rewritten', async () => {
  const w = await workspace()
  try {
    const { configureTrackOverrides, readTrackOverrides, readTrackOverrideWarning, setTrackOverride } = api()
    await writeFile(w.file, '{broken', 'utf8')
    configureTrackOverrides(w.file)
    assert.deepEqual(await readTrackOverrides(), {})
    assert.match(await readTrackOverrideWarning(), /原始标签/)
    await setTrackOverride(path.resolve('D:/Music/track.flac'), { artist: 'Test Artist' })
    configureTrackOverrides(w.file)
    assert.deepEqual(await readTrackOverrides(), { 'd:\\music\\track.flac': { artist: 'Test Artist' } })
    assert.equal(await readTrackOverrideWarning(), null)
  } finally {
    await w.cleanup()
  }
})

test('failed atomic writes leave the last good override document and memory snapshot intact', async () => {
  const w = await workspace()
  try {
    const { configureTrackOverrides, readTrackOverrides, setTrackOverride } = api()
    const track = path.resolve('D:/Music/track.flac')
    configureTrackOverrides(w.file)
    await setTrackOverride(track, { title: 'Stable title' })
    const before = await readFile(w.file, 'utf8')
    await mkdir(w.file + '.tmp')
    await assert.rejects(setTrackOverride(track, { title: 'Not saved' }))
    assert.equal(await readFile(w.file, 'utf8'), before)
    assert.deepEqual(await readTrackOverrides(), { 'd:\\music\\track.flac': { title: 'Stable title' } })
  } finally {
    await w.cleanup()
  }
})
