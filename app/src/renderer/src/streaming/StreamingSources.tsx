import QrLogin from './QrLogin'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Globe, KeyRound, Play, Radio } from 'lucide-react'
import { PLATFORM_SPECS, platformQualityOptions, qualityLabel, sessionLabel, type PlatformId, type StreamingStatus, type StreamingTrack } from '@shared/streaming'
import { playStreamingTrack } from './play'
import { describeLoginError } from './loginFlow'
import { ensureStreamingReady } from './ensureReady'
import { supportsWebLogin } from '@shared/web-login'

/**
 * 流媒体源面板（CONTRACT §4）。
 *
 * 界面上呈现的是**真实状态**：服务端由主进程拉起，能不能搜、能不能播取决于它是否
 * ready。所以这里没有"即将接入"这种占位文案——要么能点，要么明确说出为什么不能。
 */
export default function StreamingSources() {
  const [status, setStatus] = useState<StreamingStatus | null>(null)
  const [commands, setCommands] = useState<Partial<Record<PlatformId, string>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [qrPlatform, setQrPlatform] = useState<PlatformId | null>(null)
  const [platform, setPlatform] = useState<PlatformId>('netease')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StreamingTrack[]>([])
  const [secret, setSecret] = useState('')
  /** 登录成功后的短暂高亮（约 1.6s）：它是「刚刚发生」的确认，不是常驻状态。 */
  const [loginFlash, setLoginFlash] = useState<PlatformId | null>(null)
  /** 正在等按需服务端就绪（首次拉起可能几十秒）：卡片里要说清在准备什么。 */
  const [loginPreparing, setLoginPreparing] = useState<PlatformId | null>(null)
  /** 网页登录窗口还开着（关窗=取消，主进程会以 reject 结束）。 */
  const [webPending, setWebPending] = useState<PlatformId | null>(null)
  const [webFeedback, setWebFeedback] = useState<{ platform: PlatformId; kind: 'success' | 'error'; message: string } | null>(null)
  /** 卡片内联的结构化失败（原因 + 下一步），不用弹窗，也不吞原文。 */
  const [loginFailure, setLoginFailure] = useState<{ platform: PlatformId; reason: string; nextStep: string } | null>(null)
  const alive = useRef(true)
  /** 打开扫码模态的触发按钮：ensureReady 期间按钮 disabled 会丢焦点，挂载时再取 activeElement 已经晚了。 */
  const loginOrigin = useRef<HTMLElement | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.twilight.streamingStatus() as StreamingStatus
      if (!alive.current) return
      setStatus(next)
      setCommands(current => {
        const merged = { ...current }
        for (const provider of next.config.providers) {
          if (merged[provider.platform] === undefined) merged[provider.platform] = provider.command
        }
        return merged
      })
    } catch { /* 主进程还没就绪：下一轮再试 */ }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    // 设置页不可见时不打点（轮询只在需要时跑）；回前台立刻补一次，避免看到过期状态。
    const onVisible = (): void => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // 服务端在启动中时轮询；稳定下来就停（不常驻打点）。
  const starting = status?.runtimes.some(runtime => runtime.state === 'starting') ?? false
  useEffect(() => {
    if (!starting) return
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 1200)
    return () => clearInterval(timer)
  }, [starting, refresh])

  /** 成功高亮：1.6s 后自己消失（与「已生效 ✓」同一节奏，用户不需要关掉它）。 */
  const flashSuccess = (id: PlatformId): void => {
    setLoginFlash(id)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => { flashTimer.current = null; setLoginFlash(null) }, 1600)
  }
  const showFeedback = (platform: PlatformId, kind: 'success' | 'error', message: string): void => {
    setWebFeedback({ platform, kind, message })
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    if (kind === 'success') feedbackTimer.current = setTimeout(() => { feedbackTimer.current = null; setWebFeedback(null) }, 1600)
  }

  const run = async (key: string, task: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setNotice(null)
    try { await task() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(null); await refresh() }
  }

  const runtimeOf = (id: PlatformId) => status?.runtimes.find(item => item.platform === id)
  const sessionOf = (id: PlatformId) => status?.sessions.find(item => item.platform === id)

  /**
   * 保活一句话（v6）。
   *
   * 这里刻意把「会话过期」和「校验失败」写成完全不同的文案：前者要用户重新登录，
   * 后者只需要等网络/服务端恢复。混成一句「异常」会让用户白扫一次码。
   */
  const keepAliveText = (session: StreamingStatus['sessions'][number] | undefined): string => {
    if (!session) return '未校验'
    const verified = typeof session.lastVerifiedAt === 'number'
      ? new Date(session.lastVerifiedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : null
    switch (session.keepAlive) {
      case 'checking': return '正在校验…'
      case 'ok': return '会话有效' + (session.keepAliveNote === '已续期' ? ' · 已续期' : '') + (verified ? ' · ' + verified : '')
      case 'expired': return '会话已过期，需要重新登录' + (verified ? ' · ' + verified : '')
      case 'error': return '校验失败（网络/服务端），会话状态未变' + (verified ? ' · ' + verified : '')
      case 'unsupported': return '已校验 · 该平台无续期接口' + (verified ? ' · ' + verified : '')
      // idle / 缺省：主进程还没跑过巡检（或服务端没启动）。
      default: return session.keepAliveNote ?? '未校验'
    }
  }

  /** 手动校验：与自动巡检同一个主进程入口，返回校验后的会话快照。 */
  const verifySession = (id: PlatformId): void => {
    void run('verify-' + id, async () => {
      const sessions = await window.twilight.streamingVerify(id) as StreamingStatus['sessions']
      setStatus(current => current ? { ...current, sessions } : current)
    })
  }

  const saveCommand = (id: PlatformId): void => {
    if (!status) return
    const next = {
      version: 1 as const,
      providers: status.config.providers.map(provider => provider.platform === id
        ? { ...provider, command: commands[id] ?? provider.command }
        : provider)
    }
    void run('save-' + id, async () => {
      const saved = await window.twilight.streamingSaveConfig(next) as StreamingStatus['config']
      setStatus(current => current ? { ...current, config: saved } : current)
      setNotice('启动命令已保存。')
    })
  }

  /** 音质档位：与启动命令同一条持久化路径（配置里就是 providers[].quality）。 */
  const saveQuality = (id: PlatformId, quality: string): void => {
    if (!status) return
    const next = {
      version: 1 as const,
      providers: status.config.providers.map(provider => provider.platform === id ? { ...provider, quality } : provider)
    }
    void run('quality-' + id, async () => {
      const saved = await window.twilight.streamingSaveConfig(next) as StreamingStatus['config']
      setStatus(current => current ? { ...current, config: saved } : current)
      setNotice('音质档位已保存：' + qualityLabel(id, quality) + '（下一首生效）')
    })
  }

  const toggleServer = (id: PlatformId, running: boolean): void => {
    void run('server-' + id, async () => {
      if (running) await window.twilight.streamingStop(id)
      else await window.twilight.streamingStart(id)
    })
  }

  /** 统一走 ensureStreamingReady（A1 按需启动后所有登录入口都必须先叫醒服务端）。 */
  const ensureReady = (id: PlatformId): Promise<void> =>
    ensureStreamingReady(id, { onStatus: next => { if (alive.current) setStatus(next) } })

  /** 网页登录共用的真实动作（卡片内联反馈与模态都复用它，只是错误处理不同）。 */
  const runWebLogin = async (id: PlatformId): Promise<{ nickname?: string | null }> => {
    await ensureReady(id)
    const account = await window.twilight.streamingWebLogin(id) as { nickname?: string | null }
    flashSuccess(id)
    await refresh()
    return account
  }

  const login = (id: PlatformId, trigger?: HTMLElement): void => {
    loginOrigin.current = trigger ?? null
    setLoginFailure(null)
    setBusy('login-' + id)
    setNotice(null)
    setLoginPreparing(id)
    void (async () => {
      try {
        await ensureReady(id)
        // 二维码交给 QrLogin 模态自己去取：它带 2 秒轮询、过期提示与重新获取。
        setQrPlatform(id)
      } catch (error) {
        const info = describeLoginError(error instanceof Error ? error.message : String(error))
        setLoginFailure({ platform: id, reason: info.reason, nextStep: info.nextStep })
      } finally {
        setLoginPreparing(null)
        setBusy(null)
        await refresh()
      }
    })()
  }

  /** 网页登录兜底：扫码被风控挡住时还能用。失败保留 inline 下一步，成功 1.6s 后淡出。 */
  const webLogin = (id: PlatformId): void => {
    if (webPending) return
    setWebPending(id)
    setLoginFailure(null)
    void (async () => {
      try {
        const account = await runWebLogin(id)
        showFeedback(id, 'success', '网页登录成功' + (account.nickname ? '：' + account.nickname : '。'))
      } catch (error) {
        const info = describeLoginError(error instanceof Error ? error.message : String(error))
        setLoginFailure({ platform: id, reason: info.reason, nextStep: info.nextStep })
        showFeedback(id, 'error', '网页登录未完成。')
      } finally {
        setWebPending(null)
      }
    })()
  }

  const search = (): void => {
    void run('search', async () => {
      const tracks = await window.twilight.streamingSearch(platform, query) as StreamingTrack[]
      setResults(tracks)
      if (tracks.length === 0) setNotice('没有搜到结果。')
    })
  }

  const play = (track: StreamingTrack): void => {
    void run('play-' + track.id, async () => {
      await playStreamingTrack(track)
      setNotice('正在播放：' + track.title + (track.artist ? ' — ' + track.artist : ''))
    })
  }

  return (
    <div className="streaming-sources">
      {/* 一行总览：哪个源就绪、哪个已登录 */}
      <div className="streaming-summary" role="list" aria-label="来源状态总览">
        {PLATFORM_SPECS.map(spec => {
          const runtime = runtimeOf(spec.id)
          const session = sessionOf(spec.id)
          const state = runtime?.state ?? 'stopped'
          const label = spec.builtin === true
            ? (state === 'ready' ? '内置' : state === 'failed' ? '不可用' : '就绪')
            : state === 'ready'
              ? (session?.status === 'signed-in' ? (session.accountName ?? '已登录') : (spec.login === 'none' ? '就绪' : '未登录'))
              : state === 'starting' ? '启动中' : state === 'failed' ? '启动失败' : '未启动'
          return <span key={spec.id} className="streaming-summary-chip" role="listitem"
            data-provider={spec.id} data-state={state} data-session={session?.status ?? 'signed-out'}>
            <i className="streaming-dot" aria-hidden="true" />{spec.displayName}<b>{label}</b>
          </span>
        })}
      </div>

      {/* 三个源并排：每张卡只放「状态 / 账号 / 动作」，启动命令收进 details，避免堆成一大坨 */}
      <div className="streaming-grid">
        {PLATFORM_SPECS.map(spec => {
          const runtime = runtimeOf(spec.id)
          const session = sessionOf(spec.id)
          const state = runtime?.state ?? 'stopped'
          const running = state === 'ready'
          const builtin = spec.builtin === true
          const stateText = builtin
            ? (state === 'ready' ? '内置' : state === 'failed' ? '不可用' : '就绪')
            : state === 'ready' ? '运行中' : state === 'starting' ? '启动中' : state === 'failed' ? '启动失败' : '未启动'
          return (
            <article className="provider-card" key={spec.id} data-provider={spec.id} data-state={state}
              data-builtin={builtin || undefined}
              data-login-flash={loginFlash === spec.id ? 'success' : undefined}>
              <header className="provider-head">
                <span className="provider-icon"><Radio size={16} /></span>
                <strong>{spec.displayName}</strong>
                <span className="provider-state" data-state={state}>{stateText}</span>
              </header>
              <dl className="provider-facts">
                <div><dt>{builtin ? '接入方式' : '服务端'}</dt><dd>{builtin ? '公共 HTTP API · 无需进程' : running ? '127.0.0.1:' + String(runtime?.port ?? '') : stateText}</dd></div>
                <div><dt>账号</dt><dd>{spec.login === 'none' ? '无需登录' : sessionLabel(session?.status ?? 'signed-out')}</dd></div>
                {spec.login === 'qr'
                  ? <div><dt>保活</dt><dd data-keep-alive={session?.keepAlive ?? 'idle'}
                      data-expired={session?.keepAlive === 'expired' ? 'true' : undefined}>{keepAliveText(session)}</dd></div>
                  : null}
                {platformQualityOptions(spec.id).length > 0 ? <div><dt>音质</dt><dd>
                  <select className="provider-quality" aria-label={spec.displayName + ' 音质档位'}
                    value={status?.config.providers.find(provider => provider.platform === spec.id)?.quality ?? ''}
                    onChange={event => saveQuality(spec.id, event.target.value)}>
                    {platformQualityOptions(spec.id).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </dd></div> : null}
              </dl>
              <p className="provider-note" title={spec.note}>{spec.note}</p>
              <div className="provider-actions">
                {builtin
                  ? <span className="settings-status" title="第三方公共 API：随用随取，不启动本地进程">内置源 · 无需启动</span>
                  : <button className="topbar-action" disabled={busy !== null} onClick={() => toggleServer(spec.id, running)}>
                      {running ? '停止' : '启动'}</button>}
                {spec.login !== 'none'
                  ? <button className="topbar-action" disabled={busy !== null} onClick={event => login(spec.id, event.currentTarget)}><KeyRound size={13} />扫码</button>
                  : null}
                {spec.login !== 'none' && supportsWebLogin(spec.id)
                  ? <button className="topbar-action" disabled={busy !== null} onClick={() => webLogin(spec.id)} title="扫码被风控挡住时用这个：打开官方登录页"><Globe size={13} />网页</button>
                  : null}
                {session?.status === 'signed-in' && spec.login === 'qr'
                  ? <button className="topbar-action" disabled={busy !== null} aria-label={spec.displayName + ' 立即校验会话'}
                      title="立刻向平台确认这份会话还认不认；支持续期的平台会顺手延长有效期"
                      onClick={() => verifySession(spec.id)}>立即校验</button>
                  : null}
                {session?.status === 'signed-in'
                  ? <button className="topbar-action" disabled={busy !== null}
                      onClick={() => void run('logout-' + spec.id, () => window.twilight.streamingLogout(spec.id))}>退出</button>
                  : null}
              </div>
              {loginPreparing === spec.id ? <p className="provider-note provider-login-preparing" role="status">
                正在准备登录：首次拉起平台服务端可能要几十秒…</p> : null}
              {webPending === spec.id ? <p className="provider-note provider-web-pending" role="status">
                已打开网页登录窗口：完成登录后自动返回；关闭窗口即取消。</p> : null}
              {webFeedback?.platform === spec.id ? <p className="provider-login-feedback" data-kind={webFeedback.kind} role="status">
                {webFeedback.message}</p> : null}
              {loginFailure?.platform === spec.id ? <div className="provider-login-error" role="alert">
                <strong>{loginFailure.reason}</strong>
                <small>{loginFailure.nextStep}</small>
                <div className="provider-login-error-actions">
                  <button className="topbar-action" disabled={busy !== null} onClick={event => login(spec.id, event.currentTarget)}>重试</button>
                  {supportsWebLogin(spec.id)
                    ? <button className="topbar-action" disabled={busy !== null || webPending !== null} onClick={() => webLogin(spec.id)}>网页登录</button>
                    : null}
                </div>
              </div> : null}
              {builtin ? <p className="provider-note">第三方流式聚合源：只支持在线播放 / 相似推荐，<strong>不提供下载</strong>。</p> : <details className="provider-command">
                <summary>启动命令</summary>
                <input className="streaming-command" aria-label={spec.displayName + ' 启动命令'}
                  value={commands[spec.id] ?? spec.defaultCommand}
                  onChange={event => setCommands(current => ({ ...current, [spec.id]: event.target.value }))}
                  spellCheck={false} />
                <button className="topbar-action" disabled={busy !== null} onClick={() => saveCommand(spec.id)}>保存</button>
                {spec.id === 'meting'
                  ? <span className="streaming-secret">
                      <input type="password" aria-label="METING_TOKEN" placeholder="METING_TOKEN"
                        value={secret} onChange={event => setSecret(event.target.value)} />
                      <button className="topbar-action" disabled={busy !== null}
                        onClick={() => void run('secret', () => window.twilight.streamingSetSecret('meting', secret))}>保存令牌</button>
                    </span>
                  : null}
              </details>}
              {runtime?.error || state === 'failed'
                ? <pre className="streaming-log">{(runtime?.log ?? []).slice(-3).join('\n') || runtime?.error}</pre>
                : null}
            </article>
          )
        })}
      </div>

      <p className="settings-intro">
        每个源需要你自己跑一个 API 服务端：应用负责拉起、探活与关停，端口每次动态分配。首次用 npx 会联网下载；
        GD 音乐台是内置聚合源，不需要本地进程。
      </p>

      <article className="provider-card streaming-search">
        <div className="provider-copy">
          <strong>搜索并播放</strong>
          <span>搜索走你启动的服务端；播放时主进程把直链交给回环代理（带 Referer/UA），引擎用 open url 装载。</span>
          <div className="streaming-search-row">
            <select aria-label="选择平台" value={platform} onChange={event => { setPlatform(event.target.value as PlatformId); setResults([]) }}>
              {PLATFORM_SPECS.filter(spec => runtimeOf(spec.id)?.state === 'ready').map(spec => (
                <option key={spec.id} value={spec.id}>{spec.displayName}</option>
              ))}
            </select>
            <input aria-label="搜索关键词" value={query} placeholder="歌名 / 歌手" onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') search() }} />
            <button className="topbar-action" disabled={busy !== null || !query.trim()} onClick={search}>搜索</button>
          </div>
          {results.length ? (
            <ul className="streaming-results">
              {results.slice(0, 20).map(track => (
                <li key={track.platform + track.id}>
                  <button className="streaming-result" disabled={busy !== null} onClick={() => play(track)}>
                    <Play size={12} />
                    <span>{track.title}</span>
                    <small>{track.artist}{track.album ? ' · ' + track.album : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </article>

      {notice ? <p className="settings-note" role="status">{notice}</p> : null}
      {qrPlatform ? (
        <QrLogin
          platform={qrPlatform}
          title={PLATFORM_SPECS.find(spec => spec.id === qrPlatform)?.displayName ?? ''}
          onClose={() => { setQrPlatform(null); setLoginFailure(null) }}
          onSignedIn={() => {
            flashSuccess(qrPlatform)
            setLoginFailure(null)
            void refresh()
          }}
          onWebLogin={supportsWebLogin(qrPlatform) ? () => runWebLogin(qrPlatform).then(() => { flashSuccess(qrPlatform); void refresh() }) : undefined}
          returnFocusTo={loginOrigin.current}
        />
      ) : null}
    </div>
  )
}