import { useMemo } from 'react'
import { encodePath, srcRateHeight, describePath, type EngineStateSnapshot } from './encodePath'

/**
 * C2 信号路径（DESIGN v5 §3.2 / DESIGN-B §4）。
 * - 编码纯函数 encodePath() 的渲染层：几何语义 → SVG；零颜色语义（颜色只分实/虚）。
 * - 只在 state 事件变化时重算（useMemo 依赖快照字段）；形变动效走 CSS transition。
 * - aria-label 必备（R1：状态可朗读，describePath 生成）。
 */
const W = 320
const H = 24
const PAD = 6

export default function C2PathView(props: { snapshot: EngineStateSnapshot }): React.JSX.Element {
  const { snapshot } = props
  const path = useMemo(() => encodePath(snapshot), [snapshot])
  const label = useMemo(() => describePath(snapshot), [snapshot])
  const srcH = useMemo(() => srcRateHeight(snapshot.sourceSampleRate ?? snapshot.sampleRate), [snapshot.sourceSampleRate, snapshot.sampleRate])

  // 布局：按段顺序等分宽度（dsp 段缺席时其余段自动加宽）
  const drawable = path.segs.filter((s) => s !== 'paren')
  const cell = (W - PAD * 2) / drawable.length

  const els: React.JSX.Element[] = []
  let x = PAD
  const cy = H / 2
  let prevEndX: number | null = null
  let prevEndY: number | null = null

  const connectFrom = (ex: number, ey: number): void => {
    if (prevEndX !== null && prevEndY !== null) {
      els.push(
        <line
          key={'c' + els.length}
          x1={prevEndX}
          y1={prevEndY}
          x2={ex}
          y2={ey}
          className="c2-line"
        />
      )
    }
  }

  for (const seg of drawable) {
    switch (seg) {
      case 'square': {
        const filled = snapshot.loaded
        connectFrom(x, cy)
        els.push(
          <rect
            key={'sq' + x}
            x={x}
            y={cy - 4}
            width={8}
            height={8}
            rx={1}
            className={'c2-node' + (filled ? ' on' : ' off')}
          />
        )
        prevEndX = x + 8
        prevEndY = cy
        x += cell
        break
      }
      case 'bar': {
        const h = Math.max(6, srcH * (H - 8))
        connectFrom(x, cy)
        els.push(
          <rect
            key={'bar' + x}
            x={x + 3}
            y={cy - h / 2}
            width={2.5}
            height={h}
            rx={1.25}
            className="c2-src"
          />
        )
        prevEndX = x + 8
        prevEndY = cy
        x += cell
        break
      }
      case 'bend': {
        // 折线 ∧：从上一端起在中点抬升
        const mx = x + cell / 2
        const pathD =
          'M ' + (prevEndX ?? x) + ' ' + (prevEndY ?? cy) +
          ' L ' + mx + ' ' + (cy - 6) +
          ' L ' + (x + cell - 4) + ' ' + cy
        els.push(<path key={'bend' + x} d={pathD} className="c2-line c2-seg-path" fill="none" />)
        prevEndX = x + cell - 4
        prevEndY = cy
        x += cell
        break
      }
      case 'dash': {
        const ex = x + cell - 4
        els.push(
          <line
            key={'dash' + x}
            x1={prevEndX ?? x}
            y1={prevEndY ?? cy}
            x2={ex}
            y2={cy}
            className="c2-line c2-dash"
          />
        )
        prevEndX = ex
        prevEndY = cy
        x += cell
        break
      }
      case 'wave': {
        // 波浪 ～～：四段贝塞尔
        const y0: number = prevEndY ?? cy
        const x0: number = prevEndX ?? x
        const seg = (cell - 8) / 4
        let d = 'M ' + x0 + ' ' + y0
        for (let i = 0; i < 4; i++) {
          const dir = i % 2 === 0 ? -3 : 3
          d += ' q ' + seg / 2 + ' ' + dir + ' ' + seg + ' 0'
        }
        els.push(<path key={'wave' + x} d={d} className="c2-line" fill="none" />)
        prevEndX = x0 + (cell - 8)
        prevEndY = y0
        x += cell
        break
      }
      case 'line': {
        connectFrom(x + cell / 2, cy)
        prevEndX = x + cell - 4
        prevEndY = cy
        x += cell
        break
      }
      case 'circle': {
        connectFrom(x, cy)
        const filled = snapshot.outputMode === 'exclusive'
        els.push(
          <circle key={'ci' + x} cx={x + 5} cy={cy} r={4.5} className={'c2-node' + (filled ? ' on' : ' off')} />
        )
        prevEndX = x + 10
        prevEndY = cy
        x += cell
        break
      }
      case 'gap': {
        // 断口：不连线，两端各留一段短线
        els.push(<line key={'g1' + x} x1={x} y1={cy} x2={x + cell * 0.3} y2={cy} className="c2-line c2-dash" />)
        els.push(<line key={'g2' + x} x1={x + cell * 0.7} y1={cy} x2={x + cell} y2={cy} className="c2-line c2-dash" />)
        prevEndX = null
        prevEndY = null
        x += cell
        break
      }
      default:
        break
    }
  }

  // BP：整条连成不打断的实线时，补一条底层连续线（视觉合龙）
  const bpLine = path.bp ? (
    <line key="bp" x1={PAD} y1={cy} x2={W - PAD} y2={cy} className="c2-bp" />
  ) : null

  return (
    <svg
      className={'c2-path sev-' + path.severity}
      viewBox={'0 0 ' + W + ' ' + H}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {bpLine}
      {els}
      {snapshot.loaded && snapshot.xrunCount !== undefined && snapshot.xrunCount > 0 ? (
        <path d="M 150 12 l 3 -4 l 3 8 l 3 -8 l 3 4" className="c2-line" fill="none" />
      ) : null}
      {path.segs.includes('paren') ? (
        <text x={W - PAD - 10} y={cy + 3.5} className="c2-paren">
          ( )
        </text>
      ) : null}
    </svg>
  )
}
