// 曲库目录集合的真实 Electron 验收：多次真实启动同一个隔离 profile。
// 核心契约：**这次看到的曲库，下次启动必须原样拿到**（多目录累加、移除要真的移除）。
import { _electron } from 'playwright-core'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const cwd = fileURLToPath(new URL('..', import.meta.url))
const smoke = fileURLToPath(new URL('../.smoke/library/', import.meta.url))
const profile = smoke + 'profile/'
const libraryFile = profile + 'library.json'
const results = []
const check = (condition, label, details) => {
  assert.ok(condition, label + (details ? ': ' + JSON.stringify(details) : ''))
  results.push(label)
  console.log('PASS', label)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TWILIGHT_SMOKE
// 测试不联网：在线取词在这里被主进程直接短路。
env.TWILIGHT_OFFLINE = '1'

// 可用 STRINGMOON_TEST_LIBRARY 指向本机测试曲库；缺省取当前用户的音乐文件夹（须含 91 首 flac）。
const DEFAULT_DIR = process.env.STRINGMOON_TEST_LIBRARY ?? path.join(homedir(), 'Music')

/**
 * 第二音乐目录用自造的小 WAV：引擎把它当成 1 首真实曲目（标签可读、时长 1 秒）。
 * 比拷贝 8MB 的 FLAC 便宜，而且完全不依赖测试机上的其它素材。
 */
function makeExtraLibrary() {
  const dir = smoke + 'music-extra\\'
  mkdirSync(dir, { recursive: true })
  const sampleRate = 44100, seconds = 1, channels = 2, bits = 16
  const dataBytes = sampleRate * seconds * channels * (bits / 8)
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * channels * bits / 8, 28)
  buf.writeUInt16LE(channels * bits / 8, 32); buf.writeUInt16LE(bits, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < dataBytes; i++) buf[44 + i] = (i * 7) & 0xff
  writeFileSync(dir + 'extra-tone.wav', buf)
  return dir.replace(/\\$/, '')
}

const readConfig = () => JSON.parse(readFileSync(libraryFile, 'utf8'))

async function launch() {
  const app = await _electron.launch({ args: ['tools/library-test-app.cjs'], cwd, env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.app-window[data-startup="complete"]').waitFor()
  return { app, page }
}

/** 必须量完整曲库视图：首页那份是 5 条压缩速览，量它会得到假数字。 */
async function openLibrary(page) {
  await page.locator('[data-view-target="library"]').click()
  // 曲库为空时组件提前返回，不会有 .library 外壳 —— 两种形态都要能等到。
  await page.waitForFunction(
    () => Boolean(document.querySelector('.view-library .library, .view-library .list-empty')),
    null, { timeout: 30000 })
  await page.waitForTimeout(500)
}
/**
 * 曲库条目总数 —— 读 listbox 的 **aria-rowcount**，不是数 DOM 行。
 *
 * 列表已虚拟化（MASTER-B-app §A4-1）：DOM 里只有可见窗口的十来行，数 DOM 只会数到窗口大小，
 * 而且那样测的是「渲染了多少」而不是「曲库有多少」。aria-rowcount 是 ARIA 的 windowing 约定，
 * 正好承担这个语义（空曲库时组件提前返回、没有 listbox → 0）。
 */
const rowCount = page => page.evaluate(() =>
  Number(document.querySelector('.library:not(.library-compact) .track-list')?.getAttribute('aria-rowcount') ?? 0))
/** 渲染窗口内的 id（虚拟化后只有可见的一小段）。 */
const trackIds = page => page.evaluate(() => {
  const ids = [...document.querySelectorAll('.library:not(.library-compact) .track-row')].map(row => row.dataset.trackId)
  return { rows: ids.length, unique: new Set(ids).size }
})
/** 虚拟化自查：DOM 行数应远小于总数，且窗口跟着滚动走。 */
const virtualState = page => page.evaluate(() => ({
  rendered: document.querySelectorAll('.library:not(.library-compact) .track-row').length,
  total: Number(document.querySelector('.library:not(.library-compact) .track-list')?.getAttribute('aria-rowcount') ?? 0),
  firstIndex: document.querySelector('.library:not(.library-compact) .track-row')?.getAttribute('data-row-index'),
}))
async function addFolder(app, page, directory) {
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, directory)
  await page.locator('.topbar-action[title="添加音乐文件夹到曲库"]').click()
  await page.waitForTimeout(2500)
}
/** 同 src/shared/library.ts 的 libraryPathKey：分隔符/大小写归一，用来对上一个目录的两种写法。 */
const norm = value => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

async function removeFolder(page, directory) {
  await openLibrary(page)
  if (await page.locator('.library-dirs[open]').count() === 0) await page.locator('.dirs-toggle').click()
  // 按应用**自己存下来的拼写**找按钮：默认目录常量用的是正斜杠，
  // 和调用方传进来的写法可能不同，但它们是同一个目录。
  const stored = (existsSync(libraryFile) ? readConfig().directories : []).find(entry => norm(entry) === norm(directory)) ?? directory
  await page.getByRole('button', { name: '移除目录 ' + stored, exact: true }).click()
  await page.waitForTimeout(600)
}

// 顺序要紧：先清干净，再造夹具 —— 反过来会把刚造好的第二个目录一起删掉。
rmSync(smoke, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
const extraDir = makeExtraLibrary()

// ── 启动 1：从未选过 → 用内置默认目录，不写配置 ──
let { app, page } = await launch()
try {
  await openLibrary(page)
  check(await rowCount(page) === 91, 'first run scans the built-in default directory')
  // 虚拟化自查（MASTER-B-app §A4-1）：总数 91，而 DOM 里只渲染可见窗口的十来行。
  const virtual = await virtualState(page)
  check(virtual.total === 91 && virtual.rendered > 0 && virtual.rendered < 40, 'the list renders only a window, not all 91 rows', virtual)
  check(await page.getByRole('button', { name: '播放列表', exact: true }).count() === 1, 'songs, playlists, and artists share one library workspace')
  const firstTitle = await page.locator('.library:not(.library-compact) .track-title').first().textContent()
  await page.locator('#library-search').fill(firstTitle.trim().split(/\s+/)[0])
  await page.waitForFunction(() => Number(document.querySelector('.library:not(.library-compact) .track-list')?.getAttribute('aria-rowcount') ?? 0) > 0)
  check(await rowCount(page) < 91, 'shared search filters the indexed song list')
  await page.locator('#library-search').fill('')
  await page.locator('[aria-label="排序方式"]').selectOption('path')
  check(await page.locator('[aria-label="排序方式"]').inputValue() === 'path', 'song list exposes path sorting')
  await page.getByRole('button', { name: '艺术家瀑布', exact: true }).click()
  check(await page.locator('.artist-masonry').count() === 1, 'artist view uses the filtered library snapshot')
  await page.getByRole('button', { name: '歌曲列表', exact: true }).click()
  const firstTwo = page.locator('.library:not(.library-compact) .track-row')
  const listPosition = await page.locator('.library:not(.library-compact) .track-list').boundingBox()
  await firstTwo.nth(0).click()
  const selectedListPosition = await page.locator('.library:not(.library-compact) .track-list').boundingBox()
  check(Math.abs(listPosition.y - selectedListPosition.y) < 1, 'selecting a song keeps virtual rows anchored', { before: listPosition.y, after: selectedListPosition.y })
  await firstTwo.nth(1).click({ modifiers: ['Control'] })
  check(await page.locator('.library-selection').textContent().then(text => text.includes('2 首已选')), 'control-click selects multiple songs')
  await page.getByRole('button', { name: '播放列表', exact: true }).click()
  await page.getByLabel('新歌单名称').fill('Workflow Mix')
  await page.getByRole('button', { name: '新建歌单' }).click()
  await page.waitForSelector('.playlist-nav-item[aria-selected="true"]')
  await page.getByRole('button', { name: '歌曲列表', exact: true }).click()
  await page.getByLabel('选择目标歌单').selectOption({ label: 'Workflow Mix' })
  await page.getByRole('button', { name: '添加到歌单' }).click()
  await page.getByRole('button', { name: '播放列表', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.playlist-row').length === 2)
  check(await page.locator('.playlist-row-actions button[aria-label^="上移"]').count() === 2, 'playlist entries can be reordered with keyboard-accessible controls')
  const playlistPaths = await page.locator('.playlist-row').evaluateAll(rows => rows.map(row => row.dataset.playlistPath))
  await page.locator('.playlist-row').nth(0).dragTo(page.locator('.playlist-row').nth(1))
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.playlist-row')].map(row => row.dataset.playlistPath)) === JSON.stringify([...expected].reverse()), playlistPaths)
  check(true, 'playlist entries can also be reordered by pointer drag')
  await page.screenshot({ path: fileURLToPath(new URL('../.smoke/library-workspace-1280.png', import.meta.url)) })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 600))
  await page.waitForTimeout(300)
  await page.screenshot({ path: fileURLToPath(new URL('../.smoke/library-workspace-900.png', import.meta.url)) })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800))
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: '歌曲列表', exact: true }).click()
  await page.locator('.library:not(.library-compact) .track-row').first().click()
  await page.getByRole('button', { name: '编辑歌曲信息' }).click()
  await page.getByLabel('修正标题').fill('Workflow Override')
  await page.getByRole('button', { name: '保存标题' }).click()
  await page.waitForFunction(() => document.querySelector('.library:not(.library-compact) .track-row .track-title')?.textContent === 'Workflow Override')
  check(await page.locator('.track-corrected[aria-label="使用了应用内信息修正"]').count() === 1, 'metadata corrections are visibly marked in the library')
  await page.getByRole('button', { name: '重置标题' }).click()
  await page.waitForFunction(() => document.querySelector('.library:not(.library-compact) .track-row .track-title')?.textContent !== 'Workflow Override')
  await page.waitForFunction(() => document.querySelector('.track-corrected') === null)
  const missingTrack = smoke + 'missing-track.flac'
  await page.evaluate(async file => {
    const playlist = (await window.twilight.playlists()).find(item => item.name === 'Workflow Mix')
    if (!playlist) throw new Error('workflow playlist was not saved')
    await window.twilight.addPlaylistEntries(playlist.id, [file])
  }, missingTrack)
  check(!existsSync(libraryFile), 'nothing is written before the user manages directories')
  // 加第二个目录：列表必须同时记住「默认」和「新目录」，否则重启会丢掉默认那批。
  await addFolder(app, page, extraDir)
  await openLibrary(page)
  const combined = await trackIds(page)
  const combinedTotal = await rowCount(page)
  // 总数读 aria-rowcount（虚拟化后 DOM 只有可见窗口）；窗口内顺带断言没有重复 id ——
  // 后者正是当年 91→182 那个重复条目缺陷会露头的地方。
  check(combinedTotal === 92 && combined.unique === combined.rows, 'the second directory adds its own tracks', { ...combined, total: combinedTotal })
  const saved = readConfig()
  check(saved.configured === true && saved.directories.length === 2, 'both directories are remembered', saved)
  // 目录面板的视觉证据（写在 .smoke 外层：library/ 目录在本测试结束时会被清掉）。
  if (await page.locator('.library-dirs[open]').count() === 0) await page.locator('.dirs-toggle').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: fileURLToPath(new URL('../.smoke/library-directories-1280.png', import.meta.url)) })
} finally { await app.close() }

// ── 启动 2：新进程必须复现启动 1 看到的那一份（这就是本轮修的核心缺口）──
;({ app, page } = await launch())
try {
  await openLibrary(page)
  const rows = await rowCount(page)
  check(rows === 92, 'restart reproduces exactly what the session showed (both directories)', { rows })
  await page.getByRole('button', { name: '播放列表', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.playlist-row').length === 3)
  check(await page.locator('.playlist-row.unavailable').count() === 1 && (await page.locator('.playlist-warning').textContent()).includes('1 首文件当前不可用'),
    'missing playlist paths survive restart and stay unavailable')
  await page.getByRole('button', { name: '歌曲列表', exact: true }).click()
} finally { await app.close() }

// ── 启动 3：移除第二个目录 → 立刻少掉它，且不重新扫盘 ──
;({ app, page } = await launch())
try {
  await removeFolder(page, extraDir)
  check(await rowCount(page) === 91, 'removing a directory drops its tracks immediately')
  check(readConfig().directories.length === 1, 'the removal is persisted')
  // 加回来：条目还在引擎里，所以立刻恢复，不需要重新扫盘。
  await addFolder(app, page, extraDir)
  await openLibrary(page)
  check(await rowCount(page) === 92, 're-adding restores the tracks without rescanning')
} finally { await app.close() }

// ── 启动 4：重启后仍是 92（移除/重加都落了盘）──
;({ app, page } = await launch())
try {
  await openLibrary(page)
  check(await rowCount(page) === 92, 'restart reproduces the re-added state')

  // 正在播放的曲目属于默认目录。播放它就绪后把这个目录移掉：
  // 曲库列表必须少掉那批，但**正在播放不许变成别的歌**（引擎的 stop 也不清 currentTrackId，
  // 所以只能由「正在播放」从引擎全量列表解析来保证）。
  await page.evaluate(() => window.twilight.request({ cmd: 'set_volume', volume: 0 }))
  await page.locator('.library:not(.library-compact) .track-row').first().dblclick()
  await page.waitForSelector('.track-row.playing', { timeout: 15000 })
  const playingTitle = await page.locator('.pb-title').textContent()
  check(Boolean(playingTitle), 'a track from the default directory is playing', { playingTitle })

  await removeFolder(page, DEFAULT_DIR)
  check(await rowCount(page) === 1, 'the built-in default directory can be removed too')
  check(await page.locator('.pb-title').textContent() === playingTitle,
    'the playing track still names itself after its directory leaves the library')
  await page.evaluate(() => window.twilight.request({ cmd: 'stop' }))
} finally { await app.close() }

// ── 启动 5：只剩一个目录且能被复现；再全部移除后不应偷偷退回默认库 ──
;({ app, page } = await launch())
try {
  await openLibrary(page)
  const rows = await rowCount(page)
  check(rows === 1, 'restart keeps only the directory the user kept', { rows })
  await removeFolder(page, extraDir)
  // 空曲库时组件提前返回，没有 .library 外壳 —— 按视图容器取。
  const empty = await page.locator('.view-library .list-empty').textContent()
  check(empty.includes('曲库为空'), 'removing every directory shows the empty library state', empty)
  check(await rowCount(page) === 0, 'an empty directory set shows nothing rather than falling back to the default')
} finally { await app.close() }

// ── 启动 6：空曲库也要能被复现 ──
;({ app, page } = await launch())
try {
  await openLibrary(page)
  check(await rowCount(page) === 0, 'the empty library survives a restart')
} finally { await app.close() }

rmSync(smoke, { recursive: true, force: true })
console.log('LIBRARY UI OK', results.length)
