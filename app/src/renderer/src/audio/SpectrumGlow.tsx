import { useEffect, useRef } from 'react'
import { getMeter, meterReceivedAt, subscribeMeter } from './meterStore'
import { freshSpectrum, spectrumCurvePath, SPECTRUM_STALE_MS } from './spectrumGlowModel'
import { createFrameDraw } from './frameDraw'

const CURVE_WIDTH = 1200
const CURVE_HEIGHT = 104
/** 面积路径的尾巴是常量：每帧只拼曲线本身（70Hz 下少一次模板字符串与两次数字格式化）。 */
const AREA_SUFFIX = ` L${CURVE_WIDTH},${CURVE_HEIGHT} L0,${CURVE_HEIGHT} Z`

/** Event-driven transforms, bounded DOM, no idle loop or React meter updates. */
export default function SpectrumGlow({ active, playing }: { active: boolean; playing: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const curve = el.querySelector<SVGPathElement>('.spectrum-glow-curve')
    const area = el.querySelector<SVGPathElement>('.spectrum-glow-area')
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let unsubscribe: (() => void) | undefined
    let frame: ReturnType<typeof createFrameDraw> | null = null
    let staleTimer: ReturnType<typeof setTimeout> | undefined
    let inView = false
    let lastPath = ''
    const setState = (state: string): void => { if (el.dataset.state !== state) el.dataset.state = state }
    const clear = (state: string): void => {
      if (staleTimer !== undefined) { clearTimeout(staleTimer); staleTimer = undefined }
      setState(state)
      if (lastPath !== '') { lastPath = ''; curve?.setAttribute('d', ''); area?.setAttribute('d', '') }
    }
    /**
     * 过期检查只在「最后一帧之后 450ms」需要一次。
     * 旧实现每帧 clearTimeout + setTimeout（70+ 次/秒）；现在一个定时器够用：
     * 到点时若仍新鲜的（只是还没到下一帧）就按剩余时间续一次，否则清成 waiting。
     */
    const armStale = (delayMs: number): void => {
      if (staleTimer !== undefined) return
      staleTimer = setTimeout(() => {
        staleTimer = undefined
        const now = performance.now()
        if (freshSpectrum(meterReceivedAt(), now)) armStale(Math.max(1, SPECTRUM_STALE_MS - (now - meterReceivedAt())))
        else clear('waiting')
      }, Math.max(1, delayMs))
    }
    const draw = (): void => {
      const meter = getMeter()
      if (!meter.hasData || !freshSpectrum(meterReceivedAt(), performance.now())) { clear('waiting'); return }
      setState('live')
      const path = spectrumCurvePath(meter.spectrum, CURVE_WIDTH, CURVE_HEIGHT)
      // 静音段连续帧可能得到同一条空/平路径：值没变就别碰 DOM 属性。
      if (path !== lastPath) {
        lastPath = path
        curve?.setAttribute('d', path)
        area?.setAttribute('d', path ? path + AREA_SUFFIX : '')
      }
      armStale(SPECTRUM_STALE_MS - (performance.now() - meterReceivedAt()))
    }
    const sync = (): void => {
      unsubscribe?.(); unsubscribe = undefined
      if (!active || !playing || preference.matches || document.hidden || !inView) { clear(preference.matches ? 'reduced' : 'inactive'); return }
      frame = createFrameDraw(draw)
      unsubscribe = subscribeMeter(frame.request)
      frame.request()
    }
    const observer = new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? false; sync() })
    observer.observe(el)
    document.addEventListener('visibilitychange', sync)
    preference.addEventListener('change', sync)
    sync()
    return () => { frame?.cancel(); observer.disconnect(); document.removeEventListener('visibilitychange', sync); preference.removeEventListener('change', sync); unsubscribe?.(); clearTimeout(staleTimer) }
  }, [active, playing])
  return <div className="spectrum-glow" ref={root} aria-hidden="true" data-state="inactive">
    <svg className="spectrum-glow-canvas" viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="spectrum-glow-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--track-accent)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--track-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="spectrum-glow-area" fill="url(#spectrum-glow-fill)" d="" />
      <path className="spectrum-glow-curve" fill="none" stroke="var(--track-accent)" d="" />
    </svg>
  </div>
}