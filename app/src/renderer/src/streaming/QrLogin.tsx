import { useEffect, useRef, useState } from 'react'
import { TriangleAlert, Globe, X } from 'lucide-react'
import type { PlatformId, QrChannel, QrTicket } from '@shared/streaming'
import { deriveLoginPhase, describeLoginError, describeLoginPhase, type LoginPhase } from './loginFlow'

/**
 * 扫码登录（CONTRACT §4/§5）。
 *
 * 状态机：preparing → waiting → scanned → success | expired | error（spec §2）。
 * 三条纪律：
 *  1. 每个状态都要回答「现在怎么样 + 下一步做什么」，不能只转圈；
 *  2. 成功态至少停留 1000ms 播完对勾再关闭（动画放一半就消失等于没反馈）；
 *  3. 失败/过期**不自动关闭**，给「重试 / 网页登录」，否则用户只能重开一遍。
 *
 * 轮询只在模态打开且会话仍有效时跑；Escape 可关（success 时禁用）。
 */
const QR_CHANNEL_LABELS: Record<QrChannel, string> = {
  qq: '手机 QQ',
  wechat: '微信',
  qqmusic: 'QQ 音乐 App'
}

export default function QrLogin({ platform, title, onClose, onSignedIn, onWebLogin, returnFocusTo }: {
  platform: PlatformId
  title: string
  onClose: () => void
  onSignedIn: () => void
  /** 打开模态的触发元素：父组件在 disabled 前通过事件记下它（挂载时 activeElement 可能已经是 body）。 */
  returnFocusTo?: HTMLElement | null
  /** 由调用方注入「网页登录」动作（主进程负责窗口与 cookie），模态只负责反馈 */
  onWebLogin?: () => Promise<void> | void
}) {
  const [ticket, setTicket] = useState<QrTicket | null>(null)
  const [ticketState, setTicketState] = useState<QrTicket['state'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 网页登录成功也走 success phase（同一套动画与自动关闭）。 */
  const [webSuccess, setWebSuccess] = useState(false)
  const [webPending, setWebPending] = useState(false)
  const alive = useRef(true)
  const cardRef = useRef<HTMLDivElement>(null)
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedRef = useRef(false)
  const signedInRef = useRef(onSignedIn)
  const closeRef = useRef(onClose)
  signedInRef.current = onSignedIn
  closeRef.current = onClose

  const phase: LoginPhase = deriveLoginPhase({ busy, state: ticketState, error })

  /** 成功：先让用户看见结果（≥1000ms），再通知外围并关闭。 */
  const finishSuccess = (): void => {
    if (closedRef.current) return
    closedRef.current = true
    signedInRef.current()
    successTimer.current = setTimeout(() => { successTimer.current = null; closeRef.current() }, 1100)
  }

  /** 用户选的扫码通道；undefined = 让主进程用平台默认值（QQ 默认手机 QQ）。 */
  const [channel, setChannel] = useState<QrChannel | undefined>(undefined)

  const request = async (wantChannel: QrChannel | undefined = channel): Promise<void> => {
    setBusy(true)
    setError(null)
    setWebSuccess(false)
    setTicket(null)
    setTicketState(null)
    try {
      const next = await window.twilight.streamingQrStart(platform, wantChannel) as QrTicket
      if (!alive.current) return
      setTicket(next)
      setTicketState(next.state)
      if (!next.image && !next.url) throw new Error('服务端没有返回二维码，检查它是否真的支持扫码登录。')
      if (next.state === 'confirmed') finishSuccess()
    } catch (err) {
      if (!alive.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    closedRef.current = false
    // 优先用父组件记下的触发按钮；兜底才是挂载时的 activeElement（可能已被 disabled 丢成 body）。
    const active = document.activeElement
    const opener = returnFocusTo && returnFocusTo.isConnected
      ? returnFocusTo
      : active instanceof HTMLElement && active !== document.body ? active : null
    void request()
    // 打开时焦点进卡片（键盘用户不用再 Tab 找）
    const focusTimer = setTimeout(() => cardRef.current?.focus({ preventScroll: true }), 30)
    return () => {
      alive.current = false
      if (focusTimer) clearTimeout(focusTimer)
      if (successTimer.current) clearTimeout(successTimer.current)
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true })
        // 极端路径：关闭瞬间触发按钮仍 disabled（父级 busy 未清）→ 下一拍再试一次。
        if (document.activeElement !== opener) setTimeout(() => { if (opener.isConnected) opener.focus({ preventScroll: true }) }, 0)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform])

  /**
   * 轮询：**串行**（上一次 check 回来以后才排下一次），不是固定间隔的 setInterval。
   *
   * 为什么改：微信通道的 /login/qr/check 是长轮询（上游最多等 15s）。固定 2s 间隔会
   * 在 15s 里叠出 7 个并发 check，同一个 key 上互相干扰，上游一被惹毛就回 800「已过期」；
   * 客户端这边也会因为 12s 超时先 abort。现在一次只挂一个请求，成功/过期/出错都停。
   */
  useEffect(() => {
    if (!ticket || (phase !== 'waiting' && phase !== 'scanned')) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const result = await window.twilight.streamingQrPoll(platform)
        if (!alive.current || stopped) return
        setTicketState(result.state)
        if (result.detail) setTicket(current => (current ? { ...current, detail: result.detail } : current))
        if (result.state === 'confirmed') { finishSuccess(); return }
        if (result.state === 'expired') return
      } catch (err) {
        if (!alive.current || stopped) return
        const message = err instanceof Error ? err.message : String(err)
        setError(/没有进行中的扫码会话/.test(message) ? '这次扫码已经结束，请点「重新获取」。' : message)
        return
      }
      if (!stopped) timer = setTimeout(() => { void tick() }, 2000)
    }
    timer = setTimeout(() => { void tick() }, 1200)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
    // finishSuccess 是稳定语义（ref 驱动），不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, phase, platform])

  // Escape 关闭；成功态（扫码确认或网页登录）都禁用，让动画与状态收束先完成。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (phase === 'success' || webSuccess) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, webSuccess])

  const copy = describeLoginPhase(phase, title)
  const errorInfo = describeLoginError(error)
  const showError = phase === 'error'
  const showExpired = phase === 'expired'

  const webLogin = async (): Promise<void> => {
    if (!onWebLogin || webPending) return
    setWebPending(true)
    setError(null)
    try {
      await onWebLogin()
      if (!alive.current) return
      setWebSuccess(true)
      if (!closedRef.current) {
        // 网页登录没有二维码可展示，直接进 success phase 播同一套动画再关闭。
        signedInRef.current()
        successTimer.current = setTimeout(() => { successTimer.current = null; closeRef.current() }, 1100)
        closedRef.current = true
      }
    } catch (err) {
      if (!alive.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setWebPending(false)
    }
  }

  const successVisible = phase === 'success' || webSuccess

  return (
    <div className="qr-overlay" data-phase={successVisible ? 'success' : phase} role="dialog" aria-modal="true" aria-label={title + '登录'}>
      <div className={'qr-card' + (successVisible ? ' qr-success-card' : '') + (showError || showExpired ? ' qr-fail-card' : '')}
        data-phase={successVisible ? 'success' : phase} tabIndex={-1} ref={cardRef}>
        <div className="qr-head">
          <h2>{successVisible ? '登录成功' : copy.title}</h2>
          <button className="quiet-button qr-close" aria-label="关闭登录" disabled={successVisible} onClick={onClose}><X size={16} /></button>
        </div>

        {successVisible ? <div className="qr-success" role="status">
          <span className="qr-halo" aria-hidden="true" />
          <svg className="qr-check" viewBox="0 0 48 48" aria-hidden="true" fill="none">
            <circle className="qr-check-ring" cx="24" cy="24" r="21" />
            <path className="qr-check-mark" d="M14 24.5 21 31.5 34 17.5" />
          </svg>
          <strong>{title} 账号已连接</strong>
          <span>{webSuccess ? '网页登录已完成，正在返回…' : '正在返回设置…'}</span>
        </div> : null}

        {!successVisible && (showError || showExpired) ? <div className="qr-fail" role="alert">
          <span className="qr-fail-icon" aria-hidden="true"><TriangleAlert size={22} /></span>
          <div>
            <strong>{showExpired ? '二维码已过期' : errorInfo.reason}</strong>
            <p className="qr-next">
              {showExpired
                ? '二维码约 3 分钟有效。如果刚才是用「' + QR_CHANNEL_LABELS[ticket?.channel ?? 'qq'] + '」扫的但没有反应，请点上方对应通道再重新获取（手机 QQ / 微信 / QQ 音乐 App 的码不通用）。'
                : errorInfo.nextStep}
            </p>
            {/* 上游给的具体原因：没扫 / MQTT 断开 / 风控 —— 全写「过期」等于没说。 */}
            {ticket?.detail ? <p className="qr-next qr-detail" title="上游返回的具体原因">原因：{ticket.detail}</p> : null}
          </div>
        </div> : null}

        {!successVisible && !showError && ticket?.image ? <img className="qr-image" src={ticket.image} alt={title + ' 登录二维码'} width={200} height={200} /> : null}
        {!successVisible && !showError && ticket?.url && !ticket.image ? <p className="qr-link mono">{ticket.url}</p> : null}

        {!successVisible && !showError && !showExpired ? <p className="qr-hint" data-state={phase} aria-live="polite">
          {ticket?.channel ? '用「' + QR_CHANNEL_LABELS[ticket.channel] + '」扫描二维码。' : copy.hint}
        </p> : null}
        {/* 扫码通道：QQ 音乐服务端支持手机QQ/微信/QQ音乐App 三种，扫错 App 的唯一表现就是「过期」。
            v6.6：过期/出错时**也**显示通道选择 —— 之前它只在等待态出现，用户卡在
           「过期」卡片上根本没有机会换通道，只能一直重新获取同一个错的二维码。 */}
        {!successVisible && platform === 'qq' && (ticket?.channels?.length ?? 0) > 0 ? <div className="qr-channels" role="group" aria-label="扫码通道">
          {ticket?.channels?.map(item => (
            <button key={item} type="button" className="qr-channel" aria-pressed={(ticket.channel ?? 'qq') === item}
              disabled={busy}
              title={'改用' + QR_CHANNEL_LABELS[item] + '扫码（会重新生成二维码）'}
              onClick={() => { if (item === ticket.channel) return; setChannel(item); void request(item) }}>
              {QR_CHANNEL_LABELS[item]}
            </button>
          ))}
        </div> : null}
        {/* 失败/过期时 .qr-next 已经给了下一步，不再重复通用说明；网页登录等待是独立事实，单独一行。 */}
        {!successVisible && webPending ? <p className="qr-web-pending" role="status">
          已打开网页登录窗口：完成登录后自动返回；关闭窗口即取消。</p> : null}

        {!successVisible ? <div className="qr-actions">
          <button className="topbar-action qr-primary" disabled={busy} onClick={() => void request()}>
            重新获取
          </button>
          {onWebLogin && (showError || showExpired) ? (
            <button className="topbar-action" disabled={webPending} onClick={() => void webLogin()}>
              <Globe size={14} />{webPending ? '网页登录中…' : '网页登录'}
            </button>
          ) : null}
          <button className="topbar-action qr-cancel" onClick={onClose}>关闭</button>
        </div> : null}
      </div>
    </div>
  )
}