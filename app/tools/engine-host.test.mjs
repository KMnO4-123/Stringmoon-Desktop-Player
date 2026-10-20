import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EngineHost } from '../src/main/engine-host.ts'

/**
 * 真实的失败形状（2026-10-16 实测复现）：
 *
 *   Error: write EPIPE
 *     at afterWriteDispatched (node:internal/stream_base_commons:159:15)
 *     at WriteWrap.onWriteComplete
 *
 * 引擎进程消失时，主进程**已经排进缓冲区**的写入会在之后完成，并对死管道报错。
 * 这个错误是异步抛出的，所以 EngineHost 里 `this.exited` 那道闸拦不住它
 * （写入发出时引擎看起来还活着）；而 child.stdin 上没有 error 监听时，Node 会把
 * 无人处理的 'error' 直接抛成未捕获异常 —— Electron 主进程随即弹出
 * “A JavaScript error occurred in the main process”。用户看到的是弹窗，
 * 而不是应用重连。
 *
 * 触发条件是「缓冲区里还有没写完的数据」：小的命令行数太少会直接写进管道而不炸，
 * 大载荷才会留在父进程的 socket 缓冲区里 —— 这就是它看起来**间歇性**的原因。
 */

/**
 * 起一个「假引擎」：它从不读取 stdin（与引擎忙或正在退出时的形状一致），
 * 因此大载荷必然堆积在父进程缓冲区中，随后以异步错误完成。
 * 用 TWILIGHT_ENGINE/TWILIGHT_ENGINE_ARGS 指定目标，走的是生产代码的同一条路径。
 */
async function withFakeEngine(exitAfterMs, body) {
  const dir = mkdtempSync(join(tmpdir(), 'te-engine-host-'))
  const script = join(dir, 'fake-engine.mjs')
  writeFileSync(script, `setTimeout(() => process.exit(0), ${exitAfterMs})\n`)

  const previousExe = process.env.TWILIGHT_ENGINE
  const previousArgs = process.env.TWILIGHT_ENGINE_ARGS
  process.env.TWILIGHT_ENGINE = process.execPath
  process.env.TWILIGHT_ENGINE_ARGS = script

  const host = new EngineHost()
  try {
    await body(host)
  } finally {
    // shutdown() 置 shuttingDown，取消自动重启；否则重启定时器会在测试结束后
    // 再次 start()，而 ESM 下没有 bundler 注入的 __dirname。
    host.shutdown()
    await delay(1400)
    host.kill()
    if (previousExe === undefined) delete process.env.TWILIGHT_ENGINE
    else process.env.TWILIGHT_ENGINE = previousExe
    if (previousArgs === undefined) delete process.env.TWILIGHT_ENGINE_ARGS
    else process.env.TWILIGHT_ENGINE_ARGS = previousArgs
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 捕获未捕获异常：它才是 Electron 弹窗的触发器。 */
function trapUncaught() {
  const seen = []
  const handler = (error) => { seen.push(error) }
  process.on('uncaughtException', handler)
  return {
    seen,
    release: () => process.off('uncaughtException', handler),
    describe: () => seen.map((e) => `${e.code ?? '?'} ${e.message}`).join('; ')
  }
}

test('a dead engine pipe surfaces as a disconnect instead of crashing the main process', async () => {
  const trap = trapUncaught()
  const disconnects = []
  const protocolErrors = []

  try {
    await withFakeEngine(120, async (host) => {
      host.setHandlers({
        onEvent: () => {},
        onProtocolError: (line, err) => protocolErrors.push({ line, err }),
        onDisconnect: (reason) => disconnects.push(reason)
      })
      host.start()

      // 载荷必须大于管道缓冲区（默认 64 KiB），这次写入才可能「挂起」到子进程
      // 退出之后完成 —— 正是 EPIPE 的成因。512 KiB 实测可稳定复现。
      const pending = host.request({ cmd: 'scan', path: 'x'.repeat(512 * 1024) }, 5000)
      await pending.then(
        () => assert.fail('a request to a dead engine must not resolve'),
        () => {}
      ).catch(() => {})
      await delay(600)

      assert.equal(trap.describe(), '',
        'a broken engine pipe must not raise an uncaught exception (Electron shows a ' +
        'main-process dialog for these): ' + trap.describe())
      assert.ok(disconnects.length > 0, 'the host reports the disconnect so the app can reconnect')
      assert.equal(protocolErrors.length, 0, 'no protocol error is invented for a transport failure')
    })
  } finally {
    trap.release()
  }
})

test('shutdown after the engine died does not leak a pipe error either', async () => {
  const trap = trapUncaught()
  const disconnects = []

  try {
    await withFakeEngine(60, async (host) => {
      host.setHandlers({
        onEvent: () => {},
        onProtocolError: () => {},
        onDisconnect: (reason) => disconnects.push(reason)
      })
      host.start()
      void host.request({ cmd: 'scan', path: 'y'.repeat(512 * 1024) }, 5000).catch(() => {})
      // 等 EPIPE 落地，但**不要**等过引擎的自动重启退避（1200ms）：否则会先拉起下一代
      // 引擎、再死一次，disconnect 合法地变成 2，测试变成「机器越快越红」。
      // 这里只等到第一次上报就立刻走关停路径，断言才是确定性的。
      for (let attempt = 0; attempt < 60 && disconnects.length === 0; attempt += 1) await delay(50)
      assert.equal(trap.describe(), '', 'the pipe failure stays inside the request path')
      assert.ok(disconnects.length > 0, 'the disconnect is reported')

      // 关停路径也往同一个 stdin 写（engine-host.ts shutdown()），同样不能逃逸。
      host.shutdown()
      await delay(500)
      assert.equal(trap.describe(), '', 'shutdown must not leak a pipe error either')
      // 管道断开与进程退出说的是同一件事：只上报一次，避免 renderer 反复闪断连。
      assert.equal(disconnects.length, 1, 'one transport failure is reported exactly once')
    })
  } finally {
    trap.release()
  }
})
