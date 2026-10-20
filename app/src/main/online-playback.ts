import { mediaProxy, type MediaSource } from './media-proxy'

/**
 * 在线播放的唯一所有者（INTEGRATION-v1-engine-app §3 / §3.2c 的落地）。
 *
 * 这一层存在的原因，是把三件**必须一起成立**的事收在一个地方：
 *
 * 1. ⭐ **一次播放固定一个资源版本**（§3.2b）。
 *    引擎的 Range 实现会校验 `206 + Content-Range`、总长度、编码与
 *    ETag/Last-Modified。没有 validator 的源若在播放中被**等长替换**，生产端
 *    无法仅凭长度判断版本变了 —— 所以签名可以变，内容不能变，而"换一首"必须
 *    换一个 token。**一个 token 只服务一次播放**就是这个约束的写法。
 *
 * 2. ⭐ **token 与这次播放同生共死**（§3.2c）。
 *    切歌/停止/关闭时撤销 token；否则上一首的句柄还能把字节喂给引擎，
 *    而那正是"读到混合版本"的入口。
 *
 * 3. ⭐ **本地文件不绕代理**（§3.2 注意 1）。
 *    本地路径引擎直读更快、且不引入网络失败面，所以这里**只**处理在线源。
 *    本地播放继续走既有的 `{cmd:'open', trackId}` 路径，一个字都不改。
 *
 * 关于"取消"：在途上游请求由 LoopbackMediaProxy 自己在客户端断开时 abort
 * （media-proxy.ts 的 response 'close' → controller.abort()）。这里负责的是
 * **让 token 失效**，也就是不再有新的请求能进来。
 */
export interface OnlineTrackSource extends MediaSource {
  /** 应用侧提供的展示元数据；引擎不新增元数据命令（CR-016 约束 3）。 */
  title?: string
  artist?: string
}

export interface OnlineOpenResult {
  /** 交给引擎的回环 URL。 */
  url: string
  /** 本次播放的 token；撤销用。 */
  token: string
}

/** 从回环 URL 里取出 token。代理的 URL 形状由 media-proxy.ts 固定。 */
export function tokenFromLoopbackUrl(url: string): string {
  const match = /^\/media\/([A-Za-z0-9_-]{43})$/.exec(new URL(url).pathname)
  const token = match?.[1]
  // 明确的形状校验：取不到 token 就没有可撤销的东西，这一点必须说出来而不是
  // 让一个 undefined 悄悄流进 token 集合。
  if (!token) throw new Error('Not a loopback media URL: ' + url)
  return token
}

export class OnlinePlayback {
  // 当前这次在线播放的 token。null 表示此刻没有在线播放。
  private token: string | null = null

  /**
   * 为一次在线播放注册源并交给引擎装载。
   *
   * 顺序很重要：**先撤销上一个 token，再注册新的**。反过来的话，两次播放之间
   * 会存在一个窗口，让上一首的句柄仍然可用；而这段窗口正好覆盖引擎换源的时刻。
   */
  async open(source: OnlineTrackSource, request: (url: string) => Promise<unknown>): Promise<OnlineOpenResult> {
    this.release()
    // allowInsecure 必须一路传到代理：平台 CDN 的直链大量是 http，
    // 代理默认只放行 https 与回环 http——漏传这一位的话，每次点播都会拿到
    // 「Media URLs must use HTTPS」，而真正的原因在上层根本没被看见。
    const url = await mediaProxy.register({
      url: source.url,
      referer: source.referer,
      userAgent: source.userAgent,
      refresh: source.refresh,
      allowInsecure: source.allowInsecure === true
    })
    const token = tokenFromLoopbackUrl(url)
    this.token = token
    try {
      await request(url)
    } catch (error) {
      // 装载失败就没有这次播放了；token 不该继续活着等一个不会到来的下一首。
      this.release()
      throw error
    }
    return { url, token }
  }

  /**
   * 结束这次在线播放：撤销 token，上一首的回环入口立即失效。
   * 切歌、停止、退出、切换 provider 都要走到这里（§3.3）。
   * 幂等：重复调用不是错误。
   */
  release(): void {
    if (!this.token) return
    mediaProxy.revoke(this.token)
    this.token = null
  }

  /** 当前是否有在线播放占用着回环 token（诊断与测试用）。 */
  activeToken(): string | null {
    return this.token
  }
}

export const onlinePlayback = new OnlinePlayback()
