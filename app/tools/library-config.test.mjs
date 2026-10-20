import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 曲库目录集合（应用侧设置，不进引擎协议）。
 *
 * 这个模块的关键契约是**一致性**：用户在会话里看到的曲库，必须能被下次启动原样复现。
 * 所以「加入一个目录」要把内置默认目录一起固化进列表（否则会话内是「默认+新目录」、
 * 重启后只剩新目录），而「移除」必须真的能移除，包括移除到空（那时不该偷偷退回默认目录）。
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    let url
    if (specifier.startsWith('@shared/')) url = new URL('../src/shared/' + specifier.slice(8), import.meta.url)
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) url = new URL(specifier, context.parentURL)
    if (url) {
      for (const suffix of ['', '.ts', '.tsx']) {
        const candidate = new URL(url.href + suffix)
        if (/\.tsx?$/.test(candidate.pathname) && existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && /\.tsx?$/.test(new URL(url).pathname)) {
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
      })
      return { format: 'module', source: outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  }
})

const mod = await import('../src/main/library-config.ts')
const { libraryPathKey, isUnderRoot } = await import('../src/shared/library.ts')

/** 一个隔离的「配置 + 若干音乐目录」实验台。 */
async function bench() {
  const root = await mkdtemp(path.join(tmpdir(), 'twilight-lib-'))
  const music = async (name) => { const dir = path.join(root, name); await mkdir(dir, { recursive: true }); return dir }
  const home = await music('home')      // 充当「内置默认目录」
  const other = await music('other')
  return {
    root, home, other,
    config: path.join(root, 'library.json'),
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

test('never-chosen falls back to the built-in default without writing a config', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    mod.configureLibrary(b.config, b.home)
    const state = await mod.readLibraryDirectories()
    assert.deepEqual(state.directories, [b.home])
    assert.deepEqual(state.missing, [])
    assert.equal(existsSync(b.config), false, 'merely reading must not create a config')
  } finally { await b.cleanup() }
})

test('adding a directory materializes the default so the session is reproducible after restart', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    mod.configureLibrary(b.config, b.home)
    const after = await mod.addLibraryDirectory(b.other)
    // 会话内是「默认 + 新目录」，所以列表里必须两者都在，否则重启后默认目录就丢了。
    assert.deepEqual(after.directories, [b.home, b.other])
    assert.deepEqual((JSON.parse(await readFile(b.config, 'utf8'))).directories, [b.home, b.other])

    // 新进程视角：读回来必须一模一样。
    mod.configureLibrary(b.config, b.home)
    assert.deepEqual((await mod.readLibraryDirectories()).directories, [b.home, b.other])
  } finally { await b.cleanup() }
})

test('removing a directory sticks across a fresh load, including removing all of them', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    mod.configureLibrary(b.config, b.home)
    await mod.addLibraryDirectory(b.other)
    let state = await mod.removeLibraryDirectory(b.home)
    assert.deepEqual(state.directories, [b.other])
    mod.configureLibrary(b.config, b.home)
    assert.deepEqual((await mod.readLibraryDirectories()).directories, [b.other])

    // 移除到空是合法状态：不能再偷偷退回内置默认目录，那等于撤销了用户的操作。
    state = await mod.removeLibraryDirectory(b.other)
    assert.deepEqual(state.directories, [])
    mod.configureLibrary(b.config, b.home)
    assert.deepEqual((await mod.readLibraryDirectories()).directories, [])
  } finally { await b.cleanup() }
})

test('removing the implicit default is possible, and leaves an empty library', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    mod.configureLibrary(b.config, b.home)
    // 用户还没管理过任何目录时，生效的是内置默认目录；它也必须能被移除。
    const state = await mod.removeLibraryDirectory(b.home)
    assert.deepEqual(state.directories, [])
    mod.configureLibrary(b.config, b.home)
    assert.deepEqual((await mod.readLibraryDirectories()).directories, [])
  } finally { await b.cleanup() }
})

test('adding is idempotent under separators and case, and refuses unusable paths', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    mod.configureLibrary(b.config, b.home)
    await mod.addLibraryDirectory(b.other)
    // 换个写法的同一个目录不能再加一遍。
    const spelled = b.other.replace(/\\/g, '/').toUpperCase()
    assert.deepEqual((await mod.addLibraryDirectory(spelled)).directories, [b.home, b.other])
    // 不存在的目录必须拒绝，并且不破坏已有列表。
    assert.deepEqual((await mod.addLibraryDirectory(path.join(b.root, 'nope'))).directories, [b.home, b.other])
    // 相对路径会随工作目录漂移，记住它没有意义。
    assert.deepEqual((await mod.addLibraryDirectory('relative/music')).directories, [b.home, b.other])
    assert.deepEqual((await mod.addLibraryDirectory('')).directories, [b.home, b.other])
  } finally { await b.cleanup() }
})

test('a missing directory is reported rather than silently dropped', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    mod.configureLibrary(b.config, b.home)
    await mod.addLibraryDirectory(b.other)
    await rm(b.other, { recursive: true, force: true })
    // 拔掉的盘：仍然留在列表里（插回来就该能用），但如实报告不可用。
    mod.configureLibrary(b.config, b.home)
    const state = await mod.readLibraryDirectories()
    assert.deepEqual(state.directories, [b.home, b.other])
    assert.deepEqual(state.missing, [b.other])
  } finally { await b.cleanup() }
})

test('migrates the earlier single-directory config instead of losing it', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    // 上一版存的是 {directory}。迁移后要保住用户已经选过的那份。
    await writeFile(b.config, JSON.stringify({ directory: b.other }), 'utf8')
    mod.configureLibrary(b.config, b.home)
    const state = await mod.readLibraryDirectories()
    assert.deepEqual(state.directories, [b.other], 'the previously chosen directory survives')
    assert.equal(state.directories.includes(b.home), false, 'migration must not re-add the default')
    // 迁移之后照常可增删。
    assert.deepEqual((await mod.addLibraryDirectory(b.home)).directories, [b.other, b.home])
  } finally { await b.cleanup() }
})

test('a corrupt config degrades to "never chosen" rather than breaking startup', { timeout: 30000 }, async () => {
  const b = await bench()
  try {
    await writeFile(b.config, '{ this is not json', 'utf8')
    mod.configureLibrary(b.config, b.home)
    assert.deepEqual((await mod.readLibraryDirectories()).directories, [b.home])
    // 损坏之后仍然可以正常写入并恢复。
    assert.deepEqual((await mod.addLibraryDirectory(b.other)).directories, [b.home, b.other])
  } finally { await b.cleanup() }
})

test('the visible library is the engine list scoped to the current directories', async () => {
  const { useTwilight } = await import('../src/renderer/src/store.ts')
  const track = (id, file) => ({ trackId: id, path: file, title: id, artist: '', album: '', durationMs: 1000 })
  const reset = () => useTwilight.setState(useTwilight.getInitialState(), true)

  const home = 'D:\\Music', other = 'D:\\Other'
  const raw = [
    track('tl_0001', 'D:/Music/a.flac'),
    track('tl_0002', 'D:\\Music\\b.flac'),
    track('tl_0003', 'D:\\Other\\c.flac')
  ]

  reset()
  // 目录尚未解析时不过滤（启动早期/单元测试的既有行为）。
  useTwilight.getState().setTracks(raw)
  assert.equal(useTwilight.getState().tracks.length, 3, 'roots=null means no filtering')

  // 两个目录 → 三首都在。
  useTwilight.getState().setLibraryDirectories({ directories: [home, other], missing: [] })
  assert.deepEqual(useTwilight.getState().tracks.map(t => t.trackId), ['tl_0001', 'tl_0002', 'tl_0003'])

  // 移除一个目录 → 它的曲目立刻从可见集消失，**不需要重新扫盘**。
  useTwilight.getState().setLibraryDirectories({ directories: [other], missing: [] })
  assert.deepEqual(useTwilight.getState().tracks.map(t => t.trackId), ['tl_0003'])
  // 注意 D:/Music/a.flac 与 D:\Music\b.flac 的两种拼写都被归一后归到同一目录下。
  useTwilight.getState().setLibraryDirectories({ directories: [home], missing: [] })
  assert.deepEqual(useTwilight.getState().tracks.map(t => t.trackId), ['tl_0001', 'tl_0002'])

  // 加回来 → 条目还在引擎全量列表里，所以立刻恢复。
  useTwilight.getState().setLibraryDirectories({ directories: [home, other], missing: [] })
  assert.equal(useTwilight.getState().tracks.length, 3)

  // 目录全移除 → 空曲库，而不是退回显示全部。
  useTwilight.getState().setLibraryDirectories({ directories: [], missing: [] })
  assert.deepEqual(useTwilight.getState().tracks, [])

  // 曲库列表按目录收窄，但「正在播放」仍能从引擎全量列表解析出来。
  useTwilight.getState().setLibraryDirectories({ directories: [other], missing: [] })
  useTwilight.getState().applyEvent({ ev: 'state', state: 'playing', trackId: 'tl_0001', positionMs: 0, durationMs: 1000 })
  const loaded = mod && (await import('../src/renderer/src/store.ts')).selectLoadedTrack(useTwilight.getState())
  assert.equal(loaded?.trackId, 'tl_0001', 'the playing track survives its directory being removed')

  // uiIndex 连续重排，序号不跳号。
  useTwilight.getState().setLibraryDirectories({ directories: [home, other], missing: [] })
  assert.deepEqual(useTwilight.getState().tracks.map(t => t.uiIndex), [0, 1, 2])
})

test('path identity normalizes separators and case, which is what the engine does not', () => {
  assert.equal(libraryPathKey('D:/Music/Album/a.flac'), libraryPathKey('D:\\Music\\Album\\a.flac'))
  assert.equal(libraryPathKey('D:\\Music\\a.flac'), libraryPathKey('d:\\music\\A.FLAC'))
  assert.equal(libraryPathKey('D:\\Music\\'), libraryPathKey('D:\\Music'))
  assert.notEqual(libraryPathKey('D:\\Music\\a.flac'), libraryPathKey('D:\\Music\\b.flac'))
  assert.equal(libraryPathKey(undefined), '')
})

test('isUnderRoot keeps the boundary on the separator', () => {
  assert.equal(isUnderRoot('D:\\Music\\a.flac', 'D:\\Music'), true)
  assert.equal(isUnderRoot('D:/Music/a.flac', 'D:\\Music\\'), true)
  assert.equal(isUnderRoot('D:\\Music', 'D:\\Music'), true)
  // 关键边界：D:\Music2 不在 D:\Music 之下，否则移除一个目录会连累名字相邻的另一个。
  assert.equal(isUnderRoot('D:\\Music2\\a.flac', 'D:\\Music'), false)
  assert.equal(isUnderRoot('D:\\Other\\a.flac', 'D:\\Music'), false)
  assert.equal(isUnderRoot('', 'D:\\Music'), false)
})
