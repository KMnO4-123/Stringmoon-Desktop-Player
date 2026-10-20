import type { PlatformId, StreamingStatus } from '@shared/streaming'

/**
 * 登录前的「服务端就绪」入口（A1 按需启动之后所有登录入口必须经过这里）。
 *
 * 为什么不能直接开模态：平台 API 服务端现在是**按需拉起**的，首次可能要几十秒。
 * 直接把用户丢进扫码模态再转圈，用户不知道在等什么；这里先 ensure（幂等启动 +
 * 短轮询到 ready），失败时抛出可读原因，由调用方映射成下一步。
 */
const POLL_MS = 700
const DEFAULT_TIMEOUT_MS = 45_000

export interface EnsureReadyOptions {
  timeoutMs?: number
  /** 每次轮询把最新状态回给界面（卡片可显示「启动中…」） */
  onStatus?: (status: StreamingStatus) => void
}

const runtimeOf = (status: StreamingStatus, platform: PlatformId) =>
  status.runtimes.find(runtime => runtime.platform === platform)

/** 解析一次状态；ready 返回，failed 抛错，其余继续等。 */
function inspect(status: StreamingStatus, platform: PlatformId): boolean {
  const runtime = runtimeOf(status, platform)
  if (runtime?.state === 'ready') return true
  if (runtime?.state === 'failed') {
    throw new Error(runtime.error ? '服务端启动失败：' + runtime.error : '服务端启动失败。')
  }
  return false
}

/** 确保平台服务端 ready（幂等：已在跑/启动中都不会重复拉起）。 */
export async function ensureStreamingReady(platform: PlatformId, options: EnsureReadyOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let status = await window.twilight.streamingStatus() as StreamingStatus
  options.onStatus?.(status)
  if (inspect(status, platform)) return
  // streamingStart 自己会处理「已在启动中」的并发（perf-main 的 ensureStarted 竞态修复）。
  const runtime = await window.twilight.streamingStart(platform)
  if (runtime?.state === 'ready') return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    status = await window.twilight.streamingStatus() as StreamingStatus
    options.onStatus?.(status)
    if (inspect(status, platform)) return
  }
  throw new Error('服务端启动超时（' + Math.round(timeoutMs / 1000) + ' 秒）；请重试，或检查启动命令。')
}
