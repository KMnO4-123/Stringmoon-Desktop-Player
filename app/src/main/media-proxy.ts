import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface MediaSourceCredentials {
  url: string
  referer?: string
  userAgent?: string
  /**
   * 允许明文 http 上游。默认关闭 —— 缺省应当是最安全的那个。
   *
   * 为什么需要它：网易云和 QQ 的 CDN 大量回 http 直链，而它们不走明文就取不到。
   * 这个开关是**平台适配层**显式给的，不是用户能随手打开的，也不是"校验失败就放宽"
   * 的自动降级：收紧的默认值仍在，例外必须被写出来才存在。
   */
  allowInsecure?: boolean
}

export interface MediaSource extends MediaSourceCredentials {
  refresh?: () => Promise<MediaSourceCredentials>
}

interface RegisteredSource extends MediaSourceCredentials {
  refresh?: MediaSource['refresh']
  allowInsecure: boolean
}

interface ParsedRange {
  start: number | null
  end: number | null
  suffix: number | null
}

function validateUrl(value: string, allowInsecure = false): URL {
  const url = new URL(value)
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp && !(allowInsecure && url.protocol === 'http:')) {
    // 这条消息必须点出**是谁没开开关**：平台 CDN 的直链大多是 http，
    // 走到这里几乎总是适配层漏了 allowInsecure，而不是用户拿了一个坏地址。
    throw new Error('这个音频地址是明文 http（' + url.origin + '），而代理没有为它开启 allowInsecure。' +
      '平台直链需要适配层显式允许明文：检查 resolvePlay() 是否带上了 allowInsecure。')
  }
  if (url.username || url.password) throw new Error('Media URLs cannot contain embedded credentials.')
  return url
}

function validateHeaderValue(value: string | undefined, name: string): void {
  if (value !== undefined && /[\r\n]/.test(value)) throw new Error(`Invalid ${name} header.`)
}

function parseRange(value: string | undefined): ParsedRange | null | false {
  if (value === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return false
  const start = match[1] ? Number(match[1]) : null
  const end = match[2] ? Number(match[2]) : null
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))) return false
  if ((start !== null && end !== null && end < start) || (start === null && end === 0)) return false
  return { start, end, suffix: start === null ? end : null }
}

function contentRangeStart(value: string | null): number | null {
  const match = value && /^bytes (\d+)-\d+\/(?:\d+|\*)$/i.exec(value)
  return match ? Number(match[1]) : null
}

function resourceSize(response: Response): number | null {
  const range = response.headers.get('content-range')
  const rangeMatch = range && /^bytes \d+-\d+\/(\d+)$/i.exec(range)
  if (rangeMatch) return Number(rangeMatch[1])
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length)) return Number(length)
  return null
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed) return
  response.writeHead(status, {
    'accept-ranges': 'bytes',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message)
  })
  response.end(message)
}

function setMediaHeaders(response: ServerResponse, upstream: Response): void {
  for (const name of ['content-range', 'content-length', 'content-type', 'etag', 'last-modified', 'cache-control']) {
    response.removeHeader(name)
    const value = upstream.headers.get(name)
    if (value !== null) response.setHeader(name, value)
  }
  response.setHeader('accept-ranges', 'bytes')
  response.statusCode = upstream.status
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain)
      response.off('close', onClose)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new Error('Media client disconnected.')) }
    response.once('drain', onDrain)
    response.once('close', onClose)
  })
}

export class LoopbackMediaProxy {
  private readonly sources = new Map<string, RegisteredSource>()
  private server: Server | null = null
  private startPromise: Promise<string> | null = null

  async register(source: MediaSource): Promise<string> {
    const registered = this.validateSource(source)
    const baseUrl = await this.start()
    const token = randomBytes(32).toString('base64url')
    this.sources.set(token, registered)
    return `${baseUrl}/media/${token}`
  }

  revoke(token: string): void {
    this.sources.delete(token)
  }

  async close(): Promise<void> {
    this.sources.clear()
    const server = this.server
    this.server = null
    this.startPromise = null
    if (!server?.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }

  private start(): Promise<string> {
    if (this.startPromise) return this.startPromise
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) sendError(response, 502, 'Media source unavailable.')
        else response.destroy()
      })
    })
    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = this.server!
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to bind the media proxy.'))
          return
        }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    }).catch((error) => {
      this.server = null
      this.startPromise = null
      throw error
    })
    return this.startPromise!
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const token = /^\/media\/([A-Za-z0-9_-]{43})$/.exec(pathname)?.[1]
    const source = token ? this.sources.get(token) : undefined
    if (!source) {
      sendError(response, 404, 'Media token expired.')
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD')
      sendError(response, 405, 'Method not allowed.')
      return
    }

    const rangeHeader = request.headers.range
    // The engine's conditional-range validator, forwarded verbatim (see
    // requestOnce). validateHeaderValue keeps a malformed value from becoming a
    // header-injection vector; an unusable one is simply not forwarded.
    const ifRange = request.headers['if-range']
    const ifRangeValue = typeof ifRange === 'string' && !/[\r\n]/.test(ifRange) ? ifRange : undefined
    const range = parseRange(rangeHeader)
    if (range === false) {
      const head = await this.requestWithRefresh(source, 'HEAD', undefined)
      await head.body?.cancel().catch(() => undefined)
      const size = resourceSize(head)
      response.writeHead(416, {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${size ?? '*'}`,
        'content-length': '0'
      })
      response.end()
      return
    }

    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    request.once('aborted', () => controller.abort())
    const upstream = await this.requestWithRefresh(source, request.method, rangeHeader, controller.signal, ifRangeValue)

    if (upstream.status === 416) {
      let contentRange = upstream.headers.get('content-range')
      if (!contentRange) {
        const head = await this.requestWithRefresh(source, 'HEAD', undefined, controller.signal)
        await head.body?.cancel().catch(() => undefined)
        contentRange = `bytes */${resourceSize(head) ?? '*'}`
      }
      await upstream.body?.cancel().catch(() => undefined)
      response.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': contentRange, 'content-length': '0' })
      response.end()
      return
    }

    if (request.method === 'HEAD') {
      setMediaHeaders(response, upstream)
      response.end()
      return
    }

    setMediaHeaders(response, upstream)
    await this.streamResponse(upstream, response, source, controller, range, ifRangeValue)
  }

  private validateSource(source: MediaSourceCredentials & { refresh?: MediaSource['refresh'] }): RegisteredSource {
    const allowInsecure = source.allowInsecure === true
    const url = validateUrl(source.url, allowInsecure)
    validateHeaderValue(source.referer, 'Referer')
    validateHeaderValue(source.userAgent, 'User-Agent')
    return { url: url.href, referer: source.referer, userAgent: source.userAgent, refresh: source.refresh, allowInsecure }
  }

  private async refresh(source: RegisteredSource): Promise<boolean> {
    if (!source.refresh) return false
    const credentials = this.validateSource(await source.refresh())
    source.url = credentials.url
    source.referer = credentials.referer
    source.userAgent = credentials.userAgent
    return true
  }

  private async requestOnce(source: RegisteredSource, method: string, range: string | undefined, signal?: AbortSignal, ifRange?: string): Promise<Response> {
    let target = validateUrl(source.url, source.allowInsecure)
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers = new Headers({ 'accept-encoding': 'identity' })
      if (source.referer) headers.set('referer', source.referer)
      if (source.userAgent) headers.set('user-agent', source.userAgent)
      if (range) headers.set('range', range)
      // Conditional range: the engine pins the resource VERSION with If-Range
      // (ETag or Last-Modified) so the origin itself refuses to mix two
      // versions of a file. Dropping it here would silently disable that
      // protection -- the engine sends it and the CDN never sees it, which is
      // precisely the "签名会变、内容不能变" contract this proxy must preserve.
      if (ifRange) headers.set('if-range', ifRange)
      const response = await fetch(target, { method, headers, redirect: 'manual', signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location || redirects === 5) return response
      const nextTarget = validateUrl(new URL(location, target).href, source.allowInsecure)
      // The HTTPS-downgrade rule still holds unless this source was explicitly
      // registered as plaintext-only, in which case "downgrade" is not a change.
      if (!source.allowInsecure && target.protocol === 'https:' && nextTarget.protocol !== 'https:') {
        throw new Error('Secure media redirects cannot downgrade to HTTP.')
      }
      target = nextTarget
    }
    throw new Error('Too many media redirects.')
  }

  private async requestWithRefresh(source: RegisteredSource, method: string, range: string | undefined, signal?: AbortSignal, ifRange?: string): Promise<Response> {
    let response = await this.requestOnce(source, method, range, signal, ifRange)
    if ((response.status === 401 || response.status === 403) && source.refresh) {
      await response.body?.cancel().catch(() => undefined)
      if (await this.refresh(source)) response = await this.requestOnce(source, method, range, signal)
    }
    return response
  }

  private async streamResponse(
    initial: Response,
    response: ServerResponse,
    source: RegisteredSource,
    controller: AbortController,
    range: ParsedRange | null,
    ifRange: string | undefined
  ): Promise<void> {
    let upstream = initial
    let sent = 0
    let retries = 0
    let start = contentRangeStart(upstream.headers.get('content-range')) ?? range?.start ?? 0
    let end = range?.end ?? null
    if (range?.suffix !== null && range?.suffix !== undefined) {
      const size = resourceSize(upstream)
      if (size !== null) {
        start = Math.max(0, size - range.suffix)
        end = size - 1
      }
    }
    if (end === null) {
      const size = resourceSize(upstream)
      if (size !== null) end = size - 1
    }

    while (true) {
      try {
        if (upstream.body) {
          for await (const value of upstream.body) {
            if (controller.signal.aborted || response.destroyed) return
            const chunk = Buffer.from(value)
            if (chunk.length === 0) continue
            if (!response.write(chunk)) await waitForDrain(response)
            sent += chunk.length
          }
        }
        response.end()
        return
      } catch (error) {
        if (controller.signal.aborted || response.destroyed) return
        if (!source.refresh || retries >= 2) throw error
        const resumeAt = start + sent
        await this.refresh(source)
        const resumeRange = `bytes=${resumeAt}-${end === null ? '' : end}`
        // Same version pinning as the original request: a resume must continue
        // the SAME resource version, not a re-signed URL that happens to serve
        // different bytes at the same length (INTEGRATION §3.2b).
        upstream = await this.requestWithRefresh(source, 'GET', resumeRange, controller.signal, ifRange)
        // A resume that does not come back as a partial response is not a
        // resume: status 200 here means the origin ignored our range (an
        // If-Range mismatch is the usual cause) and is sending the file from
        // byte 0. Splicing that into the middle of the stream would corrupt it
        // silently, so it is refused instead.
        if (upstream.status !== 206) throw new Error('Unable to resume media stream.')
        if (!response.headersSent) setMediaHeaders(response, upstream)
        start = resumeAt
        sent = 0
        retries += 1
      }
    }
  }
}

export const mediaProxy = new LoopbackMediaProxy()
