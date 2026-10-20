import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyProbeError,
  KEEP_ALIVE_FIRST_DELAY_MS,
  KEEP_ALIVE_INTERVAL_MS,
  keepAliveNoteFor,
  mergeCookie,
  parseRefreshCookie,
  shouldProbe
} from '../src/main/streaming/keep-alive.ts'

test('refresh cookie is found at the depths the upstream actually uses', () => {
  assert.equal(parseRefreshCookie({ cookie: 'MUSIC_U=abc; __csrf=1' }), 'MUSIC_U=abc; __csrf=1')
  assert.equal(parseRefreshCookie({ status: 200, body: { code: 200, cookie: 'MUSIC_U=xyz' } }), 'MUSIC_U=xyz')
  assert.equal(parseRefreshCookie({ body: { data: { cookie: 'MUSIC_U=deep' } } }), 'MUSIC_U=deep')
})

test('a non-cookie payload never becomes an empty cookie (that would log the user out)', () => {
  assert.equal(parseRefreshCookie({ body: { code: 200 } }), null)
  assert.equal(parseRefreshCookie({ body: { cookie: '' } }), null)
  assert.equal(parseRefreshCookie({ body: { cookie: true } }), null)
  assert.equal(parseRefreshCookie(null), null)
  assert.equal(parseRefreshCookie('MUSIC_U=abc'), null)
})

test('merging a refresh keeps untouched pairs and lets the fresh values win', () => {
  const merged = mergeCookie('MUSIC_U=old; __remember_me=true; os=pc', 'MUSIC_U=new; __csrf=token')
  assert.match(merged, /MUSIC_U=new/)
  assert.match(merged, /__csrf=token/)
  assert.match(merged, /__remember_me=true/)
  assert.match(merged, /os=pc/)
  assert.doesNotMatch(merged, /MUSIC_U=old/)
})

test('cookie merge tolerates empty and malformed halves', () => {
  assert.equal(mergeCookie('', 'MUSIC_U=a'), 'MUSIC_U=a')
  assert.equal(mergeCookie('MUSIC_U=a', ''), 'MUSIC_U=a')
  assert.equal(mergeCookie('; ;', 'k=v'), 'k=v')
})

test('a dropped network is an error, not an expired session', () => {
  assert.equal(classifyProbeError(new Error('fetch failed')), 'error')
  assert.equal(classifyProbeError(new Error('connect ECONNREFUSED 127.0.0.1:3000')), 'error')
  assert.equal(classifyProbeError(new Error('请求超时：12s')), 'error')
})

test('a server-side rejection is classified as expired', () => {
  assert.equal(classifyProbeError(new Error('网易云音乐会话已过期：服务端不认这份凭据。')), 'expired')
  assert.equal(classifyProbeError(new Error('登录状态无效，请重新登录')), 'expired')
  assert.equal(classifyProbeError(new Error('ERR_LOGIN: not login')), 'expired')
})

test('keep-alive notes tell the user which action to take', () => {
  assert.equal(keepAliveNoteFor('ok', '网易云音乐'), null)
  assert.match(keepAliveNoteFor('expired', '网易云音乐'), /重新登录/)
  assert.match(keepAliveNoteFor('error', '网易云音乐'), /未变/)
})

test('probing is skipped when it would be wasteful or misleading', () => {
  assert.equal(shouldProbe({ signedIn: false, runtimeState: 'ready', inFlight: 0 }), false)
  assert.equal(shouldProbe({ signedIn: true, runtimeState: 'stopped', inFlight: 0 }), false)
  assert.equal(shouldProbe({ signedIn: true, runtimeState: 'failed', inFlight: 0 }), false)
  assert.equal(shouldProbe({ signedIn: true, runtimeState: 'ready', inFlight: 1 }), false)
  assert.equal(shouldProbe({ signedIn: true, runtimeState: 'ready', inFlight: 0 }), true)
})

test('the cadence is low-frequency by design', () => {
  assert.equal(KEEP_ALIVE_INTERVAL_MS, 6 * 60 * 60 * 1000)
  assert.equal(KEEP_ALIVE_FIRST_DELAY_MS, 8000)
})
