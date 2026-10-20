import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/audio_source.cpp', import.meta.url)), 'utf8')
const header = readFileSync(fileURLToPath(new URL('../src/audio_source.hpp', import.meta.url)), 'utf8')

const pullStart = source.indexOf('uint64_t Resampler::pullResampled')
assert.notEqual(pullStart, -1, 'the resampler pull implementation exists')
const pullBody = source.slice(pullStart, source.indexOf('\n}\n\n// ---------------------------------------------------------------------------', pullStart))

assert.match(header, /planarViews_/, 'resampler owns reusable planar views')
assert.match(source, /planarViews_\.resize\(/, 'planar views are sized during configure')
assert.doesNotMatch(pullBody, /std::vector<float\s*\*>\s+views\s*\(/,
  'pullResampled does not allocate a temporary vector for every input refill')
assert.doesNotMatch(pullBody, /planarScratch_\.resize\(/,
  'pullResampled does not grow the source scratch buffer in the hot path')

console.log('resampler storage invariant: PASS')
