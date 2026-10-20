import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import path from 'node:path'
import type { EngineRequestCommand, EngineEvent, EngineReply } from '@shared/protocol'
import { redactSensitiveText } from '@shared/redact'

/**
 * EngineHost —— 主进程侧的协议层（应用侧唯一触碰引擎通道的地方）。
 *
 * 换真引擎（CONTRACT §9.1 合并判据）：把 spawn 目标从 mock-engine.mjs 换成 twilight-engine.exe，
 * 协议代码零改动 —— 本文件通过环境变量支持，无需改代码：
 *   TWILIGHT_ENGINE=<仓库根>\engine\build\twilight-engine.exe
 *   TWILIGHT_ENGINE_ARGS="...可选参数"
 * 未设置时默认 spawn node + tools/mock-engine.mjs（开发模式）。
 *
 * 铁律实现（BRIEF-B §3.4）：
 *  - stdout 按行 JSON.parse，任何一行解析失败都当作引擎 bug 上报（绝不静默跳过）；
 *  - 命令带自增 id，回复按 id 关联，超时显式失败；
 *  - stderr 只当人类可读日志，永不进协议流。
 */
interface PendingRequest {
  resolve: (reply: EngineReply) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  label: string
}

export interface EngineHandlers {
  onEvent: (ev: EngineEvent) => void
  onProtocolError: (line: string, err: unknown) => void
  onDisconnect: (reason: string) => void
}

export class EngineHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private handlers: EngineHandlers | null = null
  private exited = false
  private shuttingDown = false
  private restartAttempts = 0
  // A broken command pipe and the child's own 'exit' describe the same dead
  // engine, so the disconnect is reported once, from whichever notices first.
  private transportFailed = false

  setHandlers(h: EngineHandlers): void {
    this.handlers = h
  }

  /**
   * 解析 spawn 目标（CONTRACT §9.1 合并判据的落地）：
   * 1. env TWILIGHT_ENGINE 显式指定（最高优先，+可选 TWILIGHT_ENGINE_ARGS）；
   * 2. 默认探测 ..\..\engine\bin\twilight-engine.exe（out/main → engine/bin；存在即用真引擎）；
   * 3. 都没有 → mock（process.execPath + ELECTRON_RUN_AS_NODE=1，Electron 官方子进程 node 模式）。
   */
  private resolveTarget(): { command: string; args: string[]; label: string; asNode: boolean } {
    const exe = process.env.TWILIGHT_ENGINE
    if (exe) {
      const extra = (process.env.TWILIGHT_ENGINE_ARGS ?? '').split(' ').filter(Boolean)
      return { command: exe, args: extra, label: exe, asNode: false }
    }
    // 打包形态（PACKAGING-v1 §1）：electron-builder 用 extraResources 把引擎放在
    // resources/engine/bin；开发/单测下 process.resourcesPath 指向 electron dist 的
    // resources，那里没有引擎，存在性判断会自然回退，行为不变。
    const packagedExe = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ? path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, 'engine', 'bin', 'twilight-engine.exe')
      : null
    if (packagedExe && fs.existsSync(packagedExe)) {
      return { command: packagedExe, args: [], label: packagedExe, asNode: false }
    }
    // out/main/index.js → app/tools/mock-engine.mjs；同级上溯 = 仓库根/engine/bin
    const realExe = path.join(__dirname, '..', '..', '..', 'engine', 'bin', 'twilight-engine.exe')
    if (fs.existsSync(realExe)) {
      return { command: realExe, args: [], label: realExe, asNode: false }
    }
    const mockPath = path.join(__dirname, '..', '..', 'tools', 'mock-engine.mjs')
    return { command: process.execPath, args: [mockPath], label: 'mock-engine.mjs', asNode: true }
  }

  start(): void {
    const { command, args, label, asNode } = this.resolveTarget()
    console.log('[engine] spawning:', label, asNode ? '(as node)' : '')
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    })
    this.exited = false
    this.transportFailed = false

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => this.handleLine(line))

    const rlErr = readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity })
    rlErr.on('line', (line) => {
      // MASTER-B-app §A1：这是今天**最大的泄漏面** —— 引擎 stderr 原样打印，
      // 而 M3 之后它会打印 /media/<token> 这类带签名或 cookie 的内容。
      if (line.trim()) console.error('[engine:stderr]', redactSensitiveText(line))
    })

    // 命令管道可以在子进程**尚未退出**时就断掉：引擎消失时，主进程已经排进
    // socket 缓冲区的写入会在之后才完成，并对死管道异步报 EPIPE。
    // 因为它是异步抛出的，request() 里 `this.exited` 那道闸拦不住它
    // （写入发出时引擎看起来还活着）；而 child.stdin 上没有 error 监听时，
    // Node 会把无人处理的 'error' 直接抛成未捕获异常 —— Electron 主进程随即弹出
    // “A JavaScript error occurred in the main process”，用户看到的是弹窗而不是重连。
    this.child.stdin.on('error', (err) => {
      this.failEngine('command pipe failed: ' + String(err))
    })

    this.child.on('error', (err) => {
      console.error('[engine] spawn error:', err)
      this.failEngine('spawn-error: ' + String(err))
    })
    this.child.on('exit', (code, signal) => {
      const reason = 'exit code=' + code + (signal ? ' signal=' + signal : '')
      console.error('[engine] ' + reason)
      this.failEngine(reason)
      this.exited = true
      // 意外断连自动重启（最多 3 次）；主动 shutdown 不重启。
      // 重启策略只属于这里：只有 exit 能证明进程真的结束了，命令管道的一次
      // 写失败不是「重启」的判据（引擎看到 stdin EOF 后自然会退出）。
      if (!this.shuttingDown && this.restartAttempts < 3) {
        this.restartAttempts++
        const delay = 1200 * this.restartAttempts
        console.error('[engine] unexpected exit, restarting in ' + delay + 'ms (attempt ' + this.restartAttempts + '/3)')
        setTimeout(() => {
          if (!this.shuttingDown) this.start()
        }, delay)
      }
    })
  }

  /**
   * 引擎通道的**唯一**失败出口：命令管道断开与进程退出说的是同一件事
   * （引擎已经收不到命令了），所以先到的那个负责上报，后到的只做去重。
   * 上报一次即可让应用重连，重复上报只会让 renderer 反复闪断连状态。
   */
  private failEngine(reason: string): void {
    if (this.transportFailed) return
    this.transportFailed = true
    // 管道已断，后续写入不可能成功：让 request() 立刻拒绝，而不是再往死管道
    // 写一次（那会为每一条命令再触发一个弹窗 —— 「一直在弹」的成因）。
    this.exited = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('engine not running (' + reason + ') while awaiting ' + p.label))
    }
    this.pending.clear()
    this.handlers?.onDisconnect(reason)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: unknown
    try {
      msg = JSON.parse(trimmed)
    } catch (err) {
      // BRIEF-B §3.4：解析失败 = 引擎 bug，必须报出来
      console.error('[protocol] FATAL: engine stdout line is not JSON:', redactSensitiveText(trimmed.slice(0, 300)))
      this.handlers?.onProtocolError(trimmed, err)
      return
    }
    if (msg === null || typeof msg !== 'object') {
      console.error('[protocol] engine stdout line is not an object:', redactSensitiveText(trimmed.slice(0, 200)))
      this.handlers?.onProtocolError(trimmed, new Error('not an object'))
      return
    }
    const obj = msg as Record<string, unknown>
    if (typeof obj.ev === 'string') {
      this.handlers?.onEvent(msg as EngineEvent)
      return
    }
    if (typeof obj.id === 'number' && typeof obj.ok === 'boolean') {
      const p = this.pending.get(obj.id)
      if (!p) {
        console.error('[protocol] reply for unknown id', obj.id, redactSensitiveText(trimmed.slice(0, 120)))
        return
      }
      this.pending.delete(obj.id)
      clearTimeout(p.timer)
      p.resolve(msg as EngineReply)
      return
    }
    console.error('[protocol] unrecognized engine message (no ev / id):', redactSensitiveText(trimmed.slice(0, 200)))
    this.handlers?.onProtocolError(trimmed, new Error('no ev and no id'))
  }

  /** 发送一条契约命令并等待同 id 回复。scan 这类重活调用方给更大的 timeoutMs。 */
  request<T = unknown>(cmd: EngineRequestCommand, timeoutMs = 10000): Promise<T> {
    if (!this.child || this.exited) return Promise.reject(new Error('engine not running'))
    const id = this.nextId++
    const payload = JSON.stringify({ id, ...cmd })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('timeout after ' + timeoutMs + 'ms awaiting reply for ' + cmd.cmd))
      }, timeoutMs)
      this.pending.set(id, {
        label: cmd.cmd,
        timer: timer as unknown as NodeJS.Timeout,
        resolve: (r) => {
          if (r.ok) resolve(r.data as T)
          else reject(Object.assign(new Error('[' + r.error.code + '] ' + r.error.message), { code: r.error.code, kind: r.error.kind }))
        },
        reject
      } as PendingRequest)
      // 同步抛出的写失败（管道已断）在这里落地；**异步**的写失败由 stdin 的
      // error 监听经 failEngine() 收口。两条路都必须以「请求失败 + 上报断连」
      // 结束，绝不能让错误逃逸成主进程未捕获异常。
      try {
        this.child!.stdin.write(payload + '\n')
      } catch (err) {
        this.failEngine('command write failed: ' + String(err))
      }
    })
  }

  /** 优雅关停：先 shutdown 命令，超时杀进程。 */
  shutdown(): void {
    this.shuttingDown = true
    if (!this.child || this.exited) return
    const child = this.child
    try {
      const id = this.nextId++
      child.stdin.write(JSON.stringify({ id, cmd: 'shutdown' }) + '\n')
    } catch {
      /* stdin 可能已关闭 */
    }    setTimeout(() => {
      if (!child.killed) child.kill()
    }, 1000)
  }

  kill(): void {
    if (this.child && !this.child.killed) this.child.kill()
  }
}
