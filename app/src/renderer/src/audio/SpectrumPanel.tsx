import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  applyMeterFrame, bandHz, getMeter, subscribeVisibleMeter,
  SPECTRUM_MAX_DB, SPECTRUM_MAX_HZ, SPECTRUM_MIN_DB, SPECTRUM_MIN_HZ
} from './meterStore'
import type { MeterSnapshot } from './meterStore'
import { smoothPathFromArrays } from './spectrumGlowModel'
import { createFrameDraw } from './frameDraw'

/**
 * 实时频谱（DSP-B-app §4.1）：与 EQ 频响**同一套画布语法** —— 同一根对数频轴、同样的 dB 纵轴、
 * 同样的线 + 面，只是数据换成引擎推的 ev:'meter'。
 *
 * 三条纪律：
 *  1. **30 Hz 不进 React 渲染**：曲线与读数都用 ref 直接改 DOM，React 只在「有没有数据」
 *     和宽度变化时重渲染（否则每秒 30 次整树 diff，正是 position 那一课）。
 *  2. **没有数据就不画曲线**：画一条平线等于宣称「此刻静音」，而我们并不知道。
 *  3. 纵轴**固定不自动缩放**：会自己跳的纵轴没法当监测看。
 */
// Match the compact EQ plot height and keep the established listening layout unchanged.
const HEIGHT = 88
const DB_TICKS = [0, -24, -48, -72]
const DB_GRID = [0, -12, -24, -36, -48, -60, -72]
const FREQUENCY_GRID = [20, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
  630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000]
const FREQUENCY_LABELS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, SPECTRUM_MAX_HZ]

const hzLabel = (hz: number): string => hz >= 1000 ? `${hz / 1000}k` : `${hz}`
const fmtDb = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? (value > 0 ? '+' : '') + value.toFixed(1) : '—'
const fmtChannels = (values: readonly number[]): string => values.length ? values.map(v => fmtDb(v)).join(' / ') : '—'

export default function SpectrumPanel() {
  const plotShell = useRef<HTMLDivElement>(null)
  const lineRef = useRef<SVGPathElement>(null)
  const areaRef = useRef<SVGPathElement>(null)
  const lufsRef = useRef<HTMLSpanElement>(null)
  const peakRef = useRef<HTMLSpanElement>(null)
  const truePeakRef = useRef<HTMLSpanElement>(null)
  const truePeakNoteRef = useRef<HTMLSpanElement>(null)
  const grRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(520)
  /**
   * 每帧复用的几何缓存：x 轴只由「宽度 + 频段数」决定，y 轴每帧重算但写进复用数组。
   * 旧实现每帧给 48 个点各分配一个 {x,y} 对象并逐点 toFixed —— 70Hz 下都是可省的分配。
   */
  const geometryRef = useRef<{ width: number; count: number; xs: Float64Array; ys: Float64Array; areaSuffix: string }>({
    width: 0, count: 0, xs: new Float64Array(0), ys: new Float64Array(0), areaSuffix: ''
  })
  /** 读数写入缓存：值没变就不碰 DOM（textContent 同值写入也会让样式/绘制失效一次）。 */
  const textRef = useRef<Record<string, string>>({})
  const [hasData, setHasData] = useState(() => getMeter().hasData)
  const hasDataRef = useRef(hasData)
  const id = useId().replace(/:/g, '')


  useLayoutEffect(() => {
    const shell = plotShell.current
    if (!shell) return
    const measure = (value: number): void => { if (Number.isFinite(value) && value > 0) setWidth(value) }
    const styles = getComputedStyle(shell)
    measure(shell.clientWidth - (Number.parseFloat(styles.paddingLeft) || 0) - (Number.parseFloat(styles.paddingRight) || 0))
    const observer = new ResizeObserver(entries => { const entry = entries[0]; if (entry) measure(entry.contentRect.width) })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  const left = Math.min(48, width * 0.2)
  const right = width - Math.min(24, width * 0.15)
  const top = 18
  const bottom = HEIGHT - 27
  const x = useCallback((hz: number): number =>
    left + Math.log(hz / SPECTRUM_MIN_HZ) / Math.log(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ) * (right - left), [left, right])
  const y = useCallback((db: number): number => {
    const clamped = Math.min(SPECTRUM_MAX_DB, Math.max(SPECTRUM_MIN_DB, db))
    return top + (SPECTRUM_MAX_DB - clamped) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB) * (bottom - top)
  }, [bottom])

  /** 把一帧画上去。只改属性，不触发 React。 */
  const draw = useCallback((meter: MeterSnapshot): void => {
    const line = lineRef.current
    const area = areaRef.current
    const spectrum = meter.spectrum
    if (line && area) {
      if (spectrum.length > 1) {
        const cache = geometryRef.current
        if (cache.width !== width || cache.count !== spectrum.length) {
          const xs = new Float64Array(spectrum.length)
          for (let index = 0; index < spectrum.length; index++) xs[index] = x(bandHz(index, spectrum.length))
          cache.width = width
          cache.count = spectrum.length
          cache.xs = xs
          cache.ys = new Float64Array(spectrum.length)
          cache.areaSuffix = ` L${right.toFixed(2)},${bottom.toFixed(2)} L${left.toFixed(2)},${bottom.toFixed(2)} Z`
        }
        const ys = cache.ys
        for (let index = 0; index < spectrum.length; index++) ys[index] = y(spectrum[index] as number)
        const path = smoothPathFromArrays(cache.xs, ys)
        line.setAttribute('d', path)
        area.setAttribute('d', path + cache.areaSuffix)
      } else {
        line.setAttribute('d', '')
        area.setAttribute('d', '')
      }
    }
    /** 只有值真的变了才写 DOM：同值写入同样会让样式/绘制失效一次。 */
    const write = (element: HTMLElement | null, key: string, value: string): void => {
      if (!element || textRef.current[key] === value) return
      textRef.current[key] = value
      element.textContent = value
    }
    // 读数按声道数组原样显示：mono 源长度是 1，**不复制成两条**（CR-015 口径 6）。
    write(lufsRef.current, 'lufs', fmtDb(meter.lufsMomentary))
    write(peakRef.current, 'peak', fmtChannels(meter.peakDb))
    write(truePeakRef.current, 'truePeak', fmtChannels(meter.truePeakDb.length ? meter.truePeakDb : []))
    // 口径 5：basis === 'sample' 时必须看得见区别，否则等于把样本峰值标成真峰值。
    // 没有数据时不加任何标注 —— 空状态本来就够安静，别再堆一句没人问的告示。
    const sample = meter.truePeakBasis === 'sample'
    write(truePeakNoteRef.current, 'truePeakNote', sample ? '样本峰值 · 未过采样' : '')
    const title = sample ? '采样率 ≥ 192 kHz 时 libebur128 不建插值器，真峰值退化为样本峰值 —— 如实标注，不冒充真峰值。' : ''
    if (truePeakNoteRef.current && textRef.current['truePeakTitle'] !== title) {
      textRef.current['truePeakTitle'] = title
      truePeakNoteRef.current.title = title
    }
    const gr = meter.gainReductionDb
    write(grRef.current, 'gr', typeof gr === 'number' && Number.isFinite(gr)
      ? (gr > -0.05 ? '0.0' : gr.toFixed(1)) : '—')
  }, [x, y, left, right, bottom, width])

  useEffect(() => {
    const update = (): void => {
      const meter = getMeter()
      if (meter.hasData !== hasDataRef.current) { hasDataRef.current = meter.hasData; setHasData(meter.hasData) }
      draw(meter)
    }
    // 65 帧/秒的事件合并到下一次动画帧：一帧最多画一次，避免同一刷新内重复写 DOM。
    const frame = createFrameDraw(update)
    const off = subscribeVisibleMeter(frame.request)
    frame.request()
    return () => { off(); frame.cancel() }
  }, [draw])

  return <section className="frequency-panel compact spectrum-panel" aria-label="实时频谱与电平">
    <div className="frequency-panel-header">
      <div><span className="frequency-eyebrow">实时监测</span><h2 className="frequency-panel-title">频谱</h2></div>
      <div className="frequency-panel-actions">
        <span className="frequency-state-badge" data-active={hasData || undefined}>{hasData ? '监测中' : '暂无样本'}</span>
      </div>
    </div>
    <div className="frequency-plot-shell" ref={plotShell}>
      <svg className="frequency-plot" width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img"
        aria-label={hasData ? '实时频谱曲线' : '实时频谱：暂无有效样本'} data-meter-ready={hasData}>
        <defs>
          <linearGradient id={`meter-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--response-fill)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--response-fill)" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        {DB_GRID.map(db => <line key={db} className={DB_TICKS.includes(db) ? 'spectrum-grid-major' : 'spectrum-grid-minor'}
          x1={left} x2={right} y1={y(db)} y2={y(db)} stroke="var(--response-grid)" />)}
        {DB_TICKS.map(db => <text key={db} className="frequency-axis-label" x={left - 10} y={y(db) + 4} textAnchor="end">{db}</text>)}
        {FREQUENCY_GRID.map(hz => <line key={hz} className={FREQUENCY_LABELS.includes(hz) ? 'spectrum-grid-major' : 'spectrum-grid-minor'}
          x1={x(hz)} x2={x(hz)} y1={top} y2={bottom} stroke="var(--response-grid)" />)}
        {FREQUENCY_LABELS.map(hz => <text key={hz} className="frequency-axis-label" x={x(hz)} y={HEIGHT - 10} textAnchor="middle">{hzLabel(hz)}</text>)}
        <text className="frequency-axis-label" x={left - 10} y={top - 8} textAnchor="end">dB</text>
        <text className="frequency-axis-label" x={right} y={top - 8} textAnchor="end">Hz</text>
        <path ref={areaRef} className="frequency-response-area spectrum-area" fill={`url(#meter-fill-${id})`} d="" />
        <path ref={lineRef} className="frequency-response-line spectrum-line" fill="none" stroke="var(--response-line)" d="" />
      </svg>
      {!hasData ? <p className="spectrum-empty">暂无实时样本</p> : null}
    </div>
    <dl className="spectrum-readout">
      <div><dt>响度</dt><dd className="mono"><span ref={lufsRef}>—</span><small>LUFS-M</small></dd></div>
      <div><dt>峰值</dt><dd className="mono"><span ref={peakRef}>—</span><small>dBFS</small></dd></div>
      <div><dt>真峰值</dt><dd className="mono"><span ref={truePeakRef}>—</span><small ref={truePeakNoteRef} /></dd></div>
      <div><dt>增益衰减</dt><dd className="mono"><span ref={grRef}>—</span><small>dB</small></dd></div>
    </dl>
  </section>
}