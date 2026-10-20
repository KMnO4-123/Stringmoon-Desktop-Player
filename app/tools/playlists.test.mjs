import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const store = await import('../src/main/playlists.ts').catch(() => null)
function api() {
  assert.ok(store, 'playlist store module should be loadable')
  return store
}

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'stringmoon-playlists-'))
  return { file: path.join(root, 'playlists.json'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('playlist mutations persist, use stable ids, and deduplicate path variants', async () => {
  const w = await workspace()
  try {
    const { configurePlaylists, readPlaylists, createPlaylist, addPlaylistEntries } = api()
    configurePlaylists(w.file)
    const [created] = await createPlaylist('  Night drive  ')
    assert.equal(created.name, 'Night drive')
    assert.ok(created.id)
    await addPlaylistEntries(created.id, [path.resolve('D:/Music/A.flac'), path.resolve('d:/music/a.flac')])
    const saved = await readPlaylists()
    assert.equal(saved[0].entries.length, 1)
    assert.match((await readFile(w.file, 'utf8')), /"version":1/)
  } finally {
    await w.cleanup()
  }
})

test('rename, remove, reorder, and delete update the saved document', async () => {
  const w = await workspace()
  try {
    const { configurePlaylists, readPlaylists, createPlaylist, renamePlaylist, deletePlaylist, addPlaylistEntries, removePlaylistEntry, reorderPlaylist } = api()
    configurePlaylists(w.file)
    const [created] = await createPlaylist('Mix')
    const first = path.resolve('D:/Music/first.flac')
    const second = path.resolve('D:/Music/second.flac')
    await addPlaylistEntries(created.id, [first, second])
    await renamePlaylist(created.id, '  Evening mix  ')
    await reorderPlaylist(created.id, [second, first])
    assert.deepEqual((await readPlaylists())[0].entries.map(entry => entry.path), [second, first])
    await removePlaylistEntry(created.id, second)
    assert.deepEqual((await readPlaylists())[0].entries.map(entry => entry.path), [first])
    await deletePlaylist(created.id)
    assert.deepEqual(await readPlaylists(), [])
  } finally {
    await w.cleanup()
  }
})

test('rejects invalid names, relative paths, and incomplete reorder requests without losing prior data', async () => {
  const w = await workspace()
  try {
    const { configurePlaylists, readPlaylists, createPlaylist, addPlaylistEntries, reorderPlaylist } = api()
    configurePlaylists(w.file)
    const [created] = await createPlaylist('Mix')
    const trackPath = path.resolve('D:/Music/first.flac')
    await addPlaylistEntries(created.id, [trackPath])
    const before = await readFile(w.file, 'utf8')
    await assert.rejects(createPlaylist('   '), /name/i)
    await assert.rejects(addPlaylistEntries(created.id, ['relative.flac']), /absolute/i)
    await assert.rejects(reorderPlaylist(created.id, []), /entry/i)
    assert.equal(await readFile(w.file, 'utf8'), before)
  } finally {
    await w.cleanup()
  }
})

test('corrupt documents recover as an empty collection and reload in a fresh configuration', async () => {
  const w = await workspace()
  try {
    const { configurePlaylists, readPlaylists, readPlaylistWarning, createPlaylist } = api()
    await writeFile(w.file, '{broken', 'utf8')
    configurePlaylists(w.file)
    assert.deepEqual(await readPlaylists(), [])
    assert.match(await readPlaylistWarning(), /空歌单/)
    await createPlaylist('Recovered')
    configurePlaylists(w.file)
    assert.equal((await readPlaylists())[0].name, 'Recovered')
    assert.equal(await readPlaylistWarning(), null)
  } finally {
    await w.cleanup()
  }
})

test('failed atomic writes leave the last good playlist document and memory snapshot intact', async () => {
  const w = await workspace()
  try {
    const { configurePlaylists, readPlaylists, createPlaylist, renamePlaylist } = api()
    configurePlaylists(w.file)
    const [saved] = await createPlaylist('Stable')
    const before = await readFile(w.file, 'utf8')
    await mkdir(w.file + '.tmp')
    await assert.rejects(renamePlaylist(saved.id, 'Not saved'))
    assert.equal(await readFile(w.file, 'utf8'), before)
    assert.equal((await readPlaylists())[0].name, 'Stable')
  } finally {
    await w.cleanup()
  }
})
