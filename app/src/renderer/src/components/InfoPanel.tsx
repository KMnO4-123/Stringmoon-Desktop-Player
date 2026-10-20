import { useRef } from 'react'
import { selectLoadedTrack, useTwilight } from '../store'
import { displayTrack } from '../display'
import { applyTrackOverride } from '../libraryModel'
import { useLibraryData } from '../libraryDataStore'
import LyricsView from './LyricsView'
import { Disc3 } from 'lucide-react'

/**
 * 信息栏：封面玻璃板（效果④：鼠标倾斜 ≤2°、径向高光跟随、离开 400ms 弹簧复位）
 * + 元数据 + 歌词。prefers-reduced-motion 下 CSS 侧禁用过渡与变换。
 */
export default function InfoPanel() {
  const glassRef = useRef<HTMLDivElement>(null)
  const raw = useTwilight(selectLoadedTrack)
  const overrides = useLibraryData(state => state.overrides)
  const effective = raw ? applyTrackOverride(raw, overrides) : null
  const t = effective ? { ...effective, ...displayTrack(effective) } : undefined

  const onTilt = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = glassRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = (e.clientX - r.left) / r.width - 0.5
    const ny = (e.clientY - r.top) / r.height - 0.5
    el.style.setProperty('--rx', (-ny * 4).toFixed(2) + 'deg')
    el.style.setProperty('--ry', (nx * 4).toFixed(2) + 'deg')
    el.style.setProperty('--mx', ((nx + 0.5) * 100).toFixed(1) + '%')
    el.style.setProperty('--my', ((ny + 0.5) * 100).toFixed(1) + '%')
    el.classList.add('tilting')
  }
  const onUntilt = (): void => {
    const el = glassRef.current
    if (!el) return
    el.classList.remove('tilting')
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
  }

  return (
    <div className="info-inner">
      <div
        className="cover-glass"
        ref={glassRef}
        onMouseMove={onTilt}
        onMouseLeave={onUntilt}
        aria-hidden
      >
        <div className="cover-sheen" />
        <Disc3 className="cover-symbol" strokeWidth={1} />
        <span className="cover-note">{t ? '暂无封面' : '—'}</span>
      </div>
      <div className="info-meta">
        <div className="info-title">{t ? t.title : '未在播放'}</div>
        <div className="info-artist">{t ? t.artist : '—'}</div>
      </div>
      <LyricsView />
    </div>
  )
}
