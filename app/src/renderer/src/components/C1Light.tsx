import { useEffect, useRef } from 'react'
import { useTwilight } from '../store'
import { subscribeEngineEvent } from '../engineEvents'

/**
 * C1 光通道（DESIGN v5 §2.2 / §3.1）——照搬 GDK 的 5 个操作，不发明第 6 个：
 *   turnOff（无曲目/未连接）· toggle（常亮）· animate（呼吸 4s）
 *   displayProgress（loading/扫描/seek 填充）· displayProgressAndToggle（扫描+就绪）
 * 载体：顶栏状态点（8×8，承载全部 5 操作）+ 窗口左缘 1px 光带（只表达 3 档：ok/warn/error）。
 * 硬规则：每次变化必须由真实事件驱动；禁止装饰性循环动画。
 * 颜色只表达严重级别（ok 白 / warn 琥珀 / error 红），不表达"是什么状态"——那是节奏与计数的职责。
 * xrun：闪 2 次（ev:'xrun' 触发）；设备变更：闪 3 次；降级：琥珀慢闪（1 次/2s）。
 */
type C1Mode = 'off' | 'on' | 'breath' | 'progress'
type Severity = 'ok' | 'warn' | 'error'

export default function C1Light(): React.JSX.Element {
  const dotRef = useRef<HTMLSpanElement>(null)
  const edgeRef = useRef<HTMLDivElement>(null)

  const playState = useTwilight((s) => s.playState)
  const engineUp = useTwilight((s) => s.engineUp)
  const scanProgress = useTwilight((s) => s.scanProgress)
  const protocolError = useTwilight((s) => s.protocolError)
  const connectionError = useTwilight((s) => s.connectionError)
  const loadedTrackId = useTwilight((s) => s.loadedTrackId)
  const degradeReason = useTwilight((s) => s.degradeReason)

  useEffect(() => {
    const dot = dotRef.current
    if (!dot) return
    const finishFlash = (event: AnimationEvent): void => {
      if (event.animationName === 'c1flash') dot.classList.remove('flashing')
    }
    dot.addEventListener('animationend', finishFlash)
    // 走统一分发器：不在这里再挂第二个 ipcRenderer 监听（position/meter 每秒几十条，
    // 每个组件各挂一份就是重复的 IPC 层回调）。这里只关心 3 种瞬时事件。
    const off = subscribeEngineEvent((ev) => {
      const count = ev.ev === 'xrun' ? 2 : ev.ev === 'device_changed' ? 3 : ev.ev === 'scan_done' ? 1 : 0
      if (!count) return
      dot.classList.remove('flashing')
      dot.style.setProperty('--flashes', String(count))
      // Restart finite feedback even when two events arrive during one animation.
      void dot.offsetWidth
      dot.classList.add('flashing')
    })
    return () => { off(); dot.removeEventListener('animationend', finishFlash) }
  }, [])

  // 主模式推导（纯函数式：状态 → 模式 + 颜色级）
  let mode: C1Mode = 'off'
  let severity: Severity = 'ok'
  let progress: number | null = null

  if (protocolError || connectionError) {
    mode = 'on'
    severity = 'error'
  } else if (scanProgress) {
    mode = 'progress'
    progress = scanProgress.total > 0 ? scanProgress.done / scanProgress.total : 0
  } else if (playState === 'loading') {
    mode = 'progress'
    progress = 0.35 // intent 在途：起点填充，等 state 事件确认
  } else if (playState === 'playing') {
    mode = 'breath'
  } else if (loadedTrackId || playState === 'paused') {
    mode = 'on'
  } else if (engineUp) {
    mode = 'on'
  } else {
    mode = 'off'
  }
  if (degradeReason && severity === 'ok') severity = 'warn'

  // 渲染副作用：直接操作 DOM 类与 CSS 变量（不进 React render path；进度用 --p 变量）
  useEffect(() => {
    const dot = dotRef.current
    const edge = edgeRef.current
    if (!dot || !edge) return

    dot.dataset.mode = mode
    dot.dataset.sev = severity
    edge.dataset.sev = severity
    edge.dataset.active = mode === 'off' ? 'no' : 'yes'
    if (progress !== null) dot.style.setProperty('--p', progress.toFixed(3))
    else dot.style.removeProperty('--p')
  }, [mode, severity, progress])

  // 降级反馈由 severity 驱动；节奏由 --dur-warning 令牌定义。

  return (
    <>
      <span ref={dotRef} className="c1-dot" aria-hidden />
      <div ref={edgeRef} className="c1-edge" aria-hidden />
    </>
  )
}
