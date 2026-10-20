// 在线播放占用释放判据（CR-016 约束 3：在线曲目 state.trackId 恒为空串）。
//
// 为什么值得单独一条测试：只按 state!=='playing' 释放会漏掉「在线曲目放一半
// 切到本地曲目」——那时 state 仍是 playing、trackId 变成 tl_xxx，ended 也不一定发。
// 漏了它，平台服务端就被一个已经不在出声的会话永久钉住（空闲休眠永不触发）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { releasesOnlinePlayback } from '../src/main/playback-hold.ts'

const stateEvent = (state, trackId) => ({ ev: 'state', state, trackId })

test('online playback keeps the hold while it is actually playing', () => {
  assert.equal(releasesOnlinePlayback(stateEvent('playing', '')), false)
  assert.equal(releasesOnlinePlayback(stateEvent('paused', '')), true)
  assert.equal(releasesOnlinePlayback(stateEvent('stopped', '')), true)
})

test('a local track taking over playback releases the online hold', () => {
  // 关键场景：引擎 open 本地曲目后 state 仍是 playing，只是 trackId 变成 tl_ 前缀。
  assert.equal(releasesOnlinePlayback(stateEvent('playing', 'tl_0001')), true)
  assert.equal(releasesOnlinePlayback(stateEvent('paused', 'tl_0042')), true)
})

test('non-state events never release the hold', () => {
  assert.equal(releasesOnlinePlayback({ ev: 'position', state: 'playing', trackId: '' }), false)
  assert.equal(releasesOnlinePlayback({ ev: 'meter', state: 'playing', trackId: '' }), false)
})
