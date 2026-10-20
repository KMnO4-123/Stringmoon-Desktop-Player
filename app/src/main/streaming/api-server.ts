/**
 * 一个平台 API 服务端的生命周期（CONTRACT §4.1：用户自备 + 应用内置自动启动）。
 *
 * 这一层只做**进程与端口**，不认识任何平台接口。这样换平台不用改这里，
 * 而"服务端起不来"永远是同一类可诊断的问题。
 *
 * 四个决定：
 *  1. **端口一律动态分配**（CONTRACT §4.1 明确禁止硬编码）。先绑 0 号端口拿到一个
 *     空闲端口再关掉，把它交给服务端 —— 这中间有理论上的竞态，但比"用户机器上 3000
 *     被占用"常见得多的问题是端口冲突本身，所以这个取舍是划算的。
 *  2. **就绪判据是"能建立 HTTP 连接"，不是"某个接口返回 200"**。探测业务接口会打
 *     上游、消耗风控额度；而服务端连上说明它已经在监听，这就够了。
 *  3. **崩溃重启用退避，且有上限**。无限重启会把用户的机器变成一个 fork 炸弹。
 *  4. **输出只留最近几行**，并且过脱敏 —— 服务端日志里会出现凭证和签名链接。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { redactSensitiveText } from '@shared/redact'
import { applyPortPlaceholder, platformSpec, splitCommand, type PlatformId, type ProviderRuntime, type ServerState } from '@shared/streaming'

export const READY_TIMEOUT_MS = 90_000
const MAX_RESTARTS = 3
const LOG_LINES = 12

/** 拿到一个当前空闲的本机端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))))
    })
  })
}

/** 能不能建立 HTTP 连接（任何状态码都算"在监听"）。 */
export function probeHttp(port: number, path = '/', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * Windows 上 npx/npm/pnpm 是 .cmd 包装，直接 spawn 会 ENOENT。
 * 这个映射只覆盖"包管理器"，用户自己的 node/php/可执行文件照原样 spawn。
 */
const SHELL_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'yarn'])

export function resolveSpawn(command: string): { file: string; args: string[]; shell: boolean } {
  const parts = splitCommand(command)
  const head = parts[0]
  if (!head) throw new Error('启动命令是空的')
  const rest = parts.slice(1)
  if (process.platform === 'win32' && SHELL_COMMANDS.has(head.toLowerCase())) {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', head, ...rest], shell: false }
  }
  return { file: head, args: rest, shell: false }
}

export class ApiServer {
  readonly platform: PlatformId
  private child: ChildProcess | null = null
  private state: ServerState = 'stopped'
  private port: number | null = null
  private error: string | null = null
  private log: string[] = []
  private command = ''
  private restarts = 0
  private stopping = false
  // 「主动丢弃这次子进程」：错误/超时收尸时置位，让 'exit' 处理器不要把它当成
  // 崩溃去退避重启（否则会为了一个起不来的服务端再等一轮 READY_TIMEOUT）。
  private discarded = false

  constructor(platform: PlatformId) {
    this.platform = platform
  }

  status(): ProviderRuntime {
    return {
      platform: this.platform,
      state: this.state,
      port: this.port,
      pid: this.child?.pid ?? null,
      error: this.error,
      log: [...this.log]
    }
  }

  base(): string | null {
    return this.port ? 'http://127.0.0.1:' + this.port : null
  }

  private note(line: string): void {
    const clean = redactSensitiveText(line).trim()
    if (!clean) return
    this.log.push(clean.slice(0, 400))
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  async start(command: string): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') return
    this.stopping = false
    this.restarts = 0
    await this.launch(command)
  }

  private async launch(command: string): Promise<void> {
    this.command = command
    this.state = 'starting'
    this.error = null
    this.discarded = false
    const spec = platformSpec(this.platform)
    try {
      this.port = await pickFreePort()
    } catch (error) {
      this.state = 'failed'
      this.error = '无法分配端口：' + (error instanceof Error ? error.message : String(error))
      return
    }

    const expanded = applyPortPlaceholder(command, this.port)
    let target: { file: string; args: string[]; shell: boolean }
    try {
      target = resolveSpawn(expanded)
    } catch (error) {
      this.state = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      return
    }

    this.note('启动：' + target.file + ' ' + target.args.join(' '))
    const child = spawn(target.file, target.args, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: target.shell,
      env: { ...process.env, [spec.portEnv]: String(this.port), PORT: String(this.port) }
    })
    this.child = child
    child.stdout?.on('data', chunk => String(chunk).split(/\r?\n/).forEach(line => this.note(line)))
    child.stderr?.on('data', chunk => String(chunk).split(/\r?\n/).forEach(line => this.note(line)))
    child.on('error', (error) => {
      // spawn 失败（命令不存在 / 无权限）时不会有活进程，但 this.child 仍握着
      // 一个永远不会 'exit' 的句柄：不丢它就是一条到应用退出都清不掉的缓存，
      // 而且之后 stop()/status() 会一直对着这个假子进程操作。
      if (this.discarded || this.stopping) return
      this.state = 'failed'
      this.error = '无法启动服务端：' + error.message
      this.child = null
      this.port = null
      this.discarded = true
    })
    child.on('exit', (code) => {
      // 收尸路径（错误/超时）主动 kill 之后也会走到这里：只清句柄，不再重启。
      if (this.discarded) {
        this.discarded = false
        this.child = null
        this.port = null
        return
      }
      if (this.stopping) return
      this.child = null
      this.port = null
      this.note('服务端退出，code=' + String(code))
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1
        const delay = 500 * this.restarts
        this.state = 'starting'
        this.error = null
        setTimeout(() => { if (!this.stopping) void this.launch(this.command) }, delay)
      } else {
        this.state = 'failed'
        this.error = '服务端反复退出（已重试 ' + MAX_RESTARTS + ' 次），请检查启动命令与日志。'
      }
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.child !== child) return   // 已退出，exit 处理器接管
      if (this.port && await probeHttp(this.port)) {
        if (this.child !== child) return
        this.state = 'ready'
        this.error = null
        this.restarts = 0
        this.note('已就绪：' + this.base())
        return
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    // 超时：子进程还活着，但一直没有监听端口。留着它就是一个永不回收的常驻进程
    // （实测这类 Node 服务端常驻 84–165 MB），所以必须收尸；同时阻止 'exit'
    // 处理器把它当成「崩溃 → 退避重启」再等一轮 90 秒。
    const timedOutPort = this.port
    this.state = 'failed'
    this.error = '服务端在 ' + Math.round(READY_TIMEOUT_MS / 1000) + ' 秒内没有开始监听端口 ' + String(timedOutPort) + '。'
    this.note(this.error)
    this.discarded = true
    this.child = null
    this.port = null
    try { child.kill() } catch { /* 已经退出 */ }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    this.state = 'stopped'
    this.port = null
    if (!child || child.killed) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已经没了 */ } resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      try { child.kill() } catch { clearTimeout(timer); resolve() }
    })
  }
}
