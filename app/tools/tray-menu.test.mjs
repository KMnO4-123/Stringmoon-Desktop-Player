import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTrayMenu, buildTrayTooltip } from '../src/main/tray-menu.ts'

test('tray menu shows track metadata and the current playback action', () => {
  const items = buildTrayMenu({
    state: 'playing',
    trackId: 'track-1',
    title: 'Night Drive',
    artist: 'Stringmoon'
  })

  assert.equal(items[0].label, 'Night Drive · Stringmoon')
  assert.equal(items.find(item => item.id === 'toggle')?.label, '暂停')
  assert.equal(items.find(item => item.id === 'previous')?.enabled, true)
  assert.equal(items.find(item => item.id === 'next')?.enabled, true)
})

test('tray menu disables playback actions when no track is loaded', () => {
  const items = buildTrayMenu({ state: 'stopped', trackId: '' })

  assert.equal(items[0].label, '当前无播放')
  assert.equal(items.find(item => item.id === 'toggle')?.label, '播放')
  assert.equal(items.find(item => item.id === 'previous')?.enabled, false)
  assert.equal(items.find(item => item.id === 'toggle')?.enabled, false)
  assert.equal(items.find(item => item.id === 'next')?.enabled, false)
  assert.equal(items.find(item => item.id === 'show')?.enabled, true)
  assert.equal(items.find(item => item.id === 'quit')?.enabled, true)
})

test('tray track label is bounded so metadata cannot dominate the native menu', () => {
  const items = buildTrayMenu({
    state: 'paused',
    trackId: 'track-1',
    title: 'A'.repeat(100),
    artist: 'B'.repeat(100)
  })

  assert.equal(items[0].label.length, 76)
  assert.ok(items[0].label.endsWith('…'))
})

test('tray tooltip identifies playback state and the current song', () => {
  assert.equal(buildTrayTooltip({ state: 'playing', trackId: 'track-1', title: 'Night Drive', artist: 'Stringmoon' }),
    'Stringmoon · 正在播放 · Night Drive · Stringmoon')
  assert.equal(buildTrayTooltip({ state: 'paused', trackId: 'track-1', title: 'Night Drive' }),
    'Stringmoon · 已暂停 · Night Drive')
})
