// IPC 落地闸：把「main 注册/发送的通道 × preload 桥接 × d.ts 声明 × renderer 实际调用」
// 做四向对账。这是 A12（d.ts 有声明、渲染层在调、preload 却漏了桥，运行时才炸）那类
// 缺口的系统性防线 —— 类型检查只看 d.ts，永远发现不了 contextBridge 实际对象少了什么。
//
// 2026-10-17 审计时它抓到过：twilight:eq-models-count 有 handler 但 preload 没桥。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(file, 'utf8')
const uniq = (list) => [...new Set(list)].sort()

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const mainFiles = walk(join(appRoot, 'src/main'))
const mainSource = mainFiles.map(read).join('\n')
const preload = read(join(appRoot, 'src/preload/index.ts'))
const declaration = read(join(appRoot, 'src/preload/index.d.ts'))
const rendererFiles = walk(join(appRoot, 'src/renderer/src'))

const handled = uniq([...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]))
const listened = uniq([...mainSource.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]))
const sent = uniq([...mainSource.matchAll(/webContents\.send\('([^']+)'/g)].map((m) => m[1]))
const invoke = uniq([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))
const rendererSend = uniq([...preload.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1]))
const receive = uniq([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]))
const declared = uniq([...declaration.matchAll(/^\s{6}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]))
const apiBlock = preload.slice(preload.indexOf('const api = {'), preload.indexOf('\n}', preload.indexOf('const api = {')))
const exposed = uniq([...apiBlock.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]))
// 渲染层实际调用（含可选链：window.twilight?.foo()）。
const used = uniq(rendererFiles.flatMap((file) => [...read(file).matchAll(/window\.twilight\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])))

const missing = (list, expected) => list.filter((entry) => !expected.includes(entry))

test('sanity: the audited surface is non-trivial', () => {
  assert.ok(handled.length > 60, 'main should register >60 IPC handlers, got ' + handled.length)
  assert.ok(exposed.length > 60, 'preload should expose >60 methods, got ' + exposed.length)
})

test('every main IPC handler has a preload bridge (no dead handler)', () => {
  assert.deepEqual(missing(handled, invoke), [],
    '这些 handler 注册了但 preload 从未 invoke —— 功能等于没接上：' + missing(handled, invoke).join(', '))
})

test('every preload invoke targets a handler main actually implements', () => {
  assert.deepEqual(missing(invoke, handled), [],
    'preload invoke 了不存在的 handler（运行时必炸）：' + missing(invoke, handled).join(', '))
})

test('every preload send targets a main listener', () => {
  assert.deepEqual(missing(rendererSend, listened), [],
    'preload send 了 main 没监听的通道（消息石沉大海）：' + missing(rendererSend, listened).join(', '))
})

test('main-to-renderer events each have a preload receiver, and vice versa', () => {
  assert.deepEqual(missing(sent, receive), [], 'main 发了但渲染层没有订阅：' + missing(sent, receive).join(', '))
  assert.deepEqual(missing(receive, sent), [], 'preload 订阅了 main 从不发送的通道：' + missing(receive, sent).join(', '))
})

test('the preload object and the d.ts declaration stay in sync', () => {
  assert.deepEqual(missing(declared, exposed), [], 'd.ts 声明了但 preload 没暴露（A12 类）：' + missing(declared, exposed).join(', '))
  assert.deepEqual(missing(exposed, declared), [], 'preload 暴露了但 d.ts 没声明（类型缺失）：' + missing(exposed, declared).join(', '))
})

test('renderer only calls methods the preload actually exposes', () => {
  assert.deepEqual(missing(used, exposed), [],
    '渲染层调用了 window.twilight 上不存在的方法（运行时 TypeError）：' + missing(used, exposed).join(', '))
})
