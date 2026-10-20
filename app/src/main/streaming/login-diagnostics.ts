/**
 * 登录诊断日志（v6.6）。
 *
 * 为什么需要它：扫码/网页登录的失败点发生在主进程里（cookie 抓没抓到、服务端认不认、
 * 二维码轮询拿到什么 code），而打包后的应用没有控制台可看。用户只能看到一句
 * 「服务端不认 / 二维码过期」，我们也只能猜 —— 这一轮就是这么卡住的。
 *
 * 纪律：
 *  - 只记**名字、数量、状态、上游 code**，绝不记 cookie/token/二维码内容本身；
 *  - 追加写、单文件上限 256 KB（超了轮转一份 .1），永不让诊断日志本身变成故障源；
 *  - 任何写失败都吞掉：诊断不能影响登录。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 256 * 1024
let file: string | null = null

export function configureLoginDiagnostics(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'login-diag.log')
  } catch {
    file = null
  }
}

/** 日志文件路径（界面/交接文档用；未配置时为 null）。 */
export function loginDiagnosticsPath(): string | null {
  return file
}

export function loginDiag(event: string, fields: Record<string, unknown> = {}): void {
  if (!file) return
  try {
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch { /* 文件还不存在 */ }
    const line = new Date().toISOString() + ' ' + event + ' ' + JSON.stringify(fields) + '\n'
    appendFileSync(file, line, 'utf8')
  } catch {
    // 诊断写失败不影响登录。
  }
}
