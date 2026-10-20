// shared/file-path.ts：渲染层传来的路径一律不可信，判据必须严。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isAbsoluteWindowsPath, isSupportedAudioPath } from '../src/shared/file-path.ts'

test('absolute drive and UNC paths are accepted, relative/odd ones are not', () => {
  for (const value of ['D:\\music\\a.flac', 'D:/music/a.flac', '\\\\server\\share\\a.flac', 'c:\\a.wav']) {
    assert.equal(isAbsoluteWindowsPath(value), true, value)
  }
  for (const value of ['music\\a.flac', '\\a.flac', 'D:', '', null, 42, 'D:relative\\a.flac']) {
    assert.equal(isAbsoluteWindowsPath(value), false, JSON.stringify(value))
  }
})

test('audio path needs an absolute path AND a supported extension', () => {
  assert.equal(isSupportedAudioPath('D:\\music\\a.flac'), true)
  assert.equal(isSupportedAudioPath('D:/music/b.MP3'), true)
  assert.equal(isSupportedAudioPath('D:\\music\\a.txt'), false)
  assert.equal(isSupportedAudioPath('music\\a.flac'), false)
})
