import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MeterVisibility } from '../src/main/meter-visibility.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const enabledList = (commands) => commands.map(command => command.enabled)

test('meter visibility waits for ready, deduplicates window events, and replays after restart', async () => {
  const commands = []
  const gate = new MeterVisibility(async command => { commands.push(command); return { enabled: command.enabled } })
  gate.setVisible(true)
  gate.setDemand(true)
  assert.deepEqual(commands, [], 'window events before ready do not write to an unavailable engine')
  gate.connected()
  gate.setVisible(true)
  gate.setVisible(false)
  gate.setVisible(false)
  gate.setVisible(true)
  assert.deepEqual(enabledList(commands), [true, false, true])
  gate.disconnected()
  gate.setVisible(false)
  assert.equal(commands.length, 3)
  gate.connected()
  assert.deepEqual(commands.at(-1), { cmd: 'set_meter', enabled: false })
  await flush()
})

test('a newly connected engine stays disabled when the window has never been shown', async () => {
  const commands = []
  const gate = new MeterVisibility(async command => { commands.push(command); return { enabled: command.enabled } })
  gate.connected()
  assert.deepEqual(commands, [{ cmd: 'set_meter', enabled: false }])
  await flush()
})

test('unsupported engines are not retried on every window event and are checked again after restart', async () => {
  const commands = [], errors = []
  const gate = new MeterVisibility(async command => {
    commands.push(command)
    throw Object.assign(new Error('old engine'), { code: 'ERR_UNSUPPORTED' })
  }, error => errors.push(error))
  gate.connected()
  await flush()
  gate.setVisible(true)
  gate.setVisible(false)
  assert.equal(commands.length, 1)
  assert.equal(errors.length, 0, 'optional metering never turns compatibility into a playback error')
  gate.disconnected()
  gate.connected()
  await flush()
  assert.equal(commands.length, 2)
})

test('late failures from an old engine cannot disable visibility updates on its replacement', async () => {
  let rejectOld
  const commands = [], errors = []
  const gate = new MeterVisibility(command => {
    commands.push(command)
    if (commands.length === 1) return new Promise((_resolve, reject) => { rejectOld = reject })
    return Promise.resolve({ enabled: command.enabled })
  }, error => errors.push(error))
  gate.setDemand(true)
  gate.setVisible(true)
  gate.connected()
  gate.disconnected()
  gate.connected()
  rejectOld(Object.assign(new Error('old engine exited'), { code: 'ERR_UNSUPPORTED' }))
  await flush()
  gate.setVisible(false)
  assert.deepEqual(enabledList(commands), [true, true, false])
  assert.equal(errors.length, 0)
})

test('meter only runs when both the window is visible and the renderer has a consumer', async () => {
  const commands = []
  const gate = new MeterVisibility(async command => { commands.push(command); return { enabled: command.enabled } })
  gate.connected()
  // 窗口不可见 + 渲染层没报消费者：组合值 false，只发一次 false 就够。
  assert.deepEqual(enabledList(commands), [false])
  gate.setVisible(true)
  assert.deepEqual(enabledList(commands), [false], '窗口可见但当前视图没有 meter 消费者 → 仍不开')
  gate.setDemand(true)
  assert.deepEqual(enabledList(commands), [false, true], '消费者出现必须立即生效')
  gate.setVisible(false)
  assert.deepEqual(enabledList(commands), [false, true, false], '窗口隐藏立即停，不受去抖影响')
  gate.setVisible(true)
  assert.deepEqual(enabledList(commands), [false, true, false, true], 'demand 未撤销时重新可见应立即恢复')
  await flush()
})

test('a consumer leaving the view is debounced so the view transition cannot flap the engine', async () => {
  const commands = []
  const gate = new MeterVisibility(async command => { commands.push(command); return {} }, () => {}, 25)
  gate.connected()
  gate.setVisible(true)
  gate.setDemand(true)
  assert.deepEqual(enabledList(commands), [false, true])
  gate.setDemand(false)
  assert.deepEqual(enabledList(commands), [false, true], '关闭边沿不立即下发（等退场动画结束）')
  await sleep(10)
  gate.setDemand(true)
  await sleep(120)
  assert.deepEqual(enabledList(commands), [false, true], '去抖窗口内的来回不产生多余命令')
  gate.setDemand(false)
  await sleep(150)
  assert.deepEqual(enabledList(commands), [false, true, false])
})

test('window hide is immediate even while a demand-off debounce is pending', async () => {
  const commands = []
  const gate = new MeterVisibility(async command => { commands.push(command); return {} })
  gate.connected()
  gate.setVisible(true)
  gate.setDemand(true)
  gate.setDemand(false)
  gate.setVisible(false)
  assert.deepEqual(enabledList(commands), [false, true, false])
  await sleep(700)
  assert.deepEqual(enabledList(commands), [false, true, false], '去抖落地时组合值未变，不重复下发')
})
