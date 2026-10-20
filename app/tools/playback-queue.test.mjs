import test from 'node:test'
import assert from 'node:assert/strict'
import { useTwilight } from '../src/renderer/src/store.ts'
import { openAndPlay } from '../src/renderer/src/ipc.ts'

test('manual playback sends the real library queue before opening its chosen track', async () => {
  useTwilight.setState(useTwilight.getInitialState(), true)
  useTwilight.getState().setTracks([{ trackId: 'one' }, { trackId: 'two' }])
  useTwilight.getState().applyHello({ capabilities: { queue: true } })
  const commands = []
  globalThis.window = { twilight: { request: async command => { commands.push(command); return { ok: true, data: { trackId: command.trackId, durationMs: 5000 } } } } }
  await openAndPlay('two')
  assert.deepEqual(commands.map(command => command.cmd), ['set_queue', 'open', 'play'])
  assert.deepEqual(commands[0].trackIds, ['one', 'two'])
  assert.equal(commands[1].trackId, 'two')
})

test('playlist playback sends only visible tracks in saved order and includes the selected track', async () => {
  useTwilight.setState(useTwilight.getInitialState(), true)
  useTwilight.getState().setTracks([{ trackId: 'one' }, { trackId: 'two' }])
  useTwilight.getState().applyHello({ capabilities: { queue: true } })
  const commands = []
  globalThis.window = { twilight: { request: async command => { commands.push(command); return { ok: true, data: { trackId: command.trackId, durationMs: 5000 } } } } }
  await openAndPlay('two', ['outside', 'two', 'one', 'two', 'missing'])
  assert.deepEqual(commands[0], { cmd: 'set_queue', trackIds: ['two', 'one'] })
  assert.equal(commands[1].trackId, 'two')
})

test('playlist playback without queue capability still opens and plays without sending a queue', async () => {
  useTwilight.setState(useTwilight.getInitialState(), true)
  const commands = []
  globalThis.window = { twilight: { request: async command => { commands.push(command); return { ok: true, data: { trackId: command.trackId, durationMs: 5000 } } } } }
  await openAndPlay('two', ['two', 'one'])
  assert.deepEqual(commands.map(command => command.cmd), ['open', 'play'])
})

test('a newer track selection supersedes an older queued open before it can play', async () => {
  useTwilight.setState(useTwilight.getInitialState(), true)
  const release = Promise.withResolvers()
  const commands = []
  globalThis.window = { twilight: { request: async command => {
    commands.push(command)
    if (command.trackId === 'one') await release.promise
    return { ok: true, data: { trackId: command.trackId, durationMs: 5000 } }
  } } }
  const old = openAndPlay('one')
  await openAndPlay('two')
  release.resolve(); await old
  assert.equal(commands.filter(command => command.cmd === 'play').length, 1)
  assert.equal(useTwilight.getState().loadedTrackId, 'two')
})
