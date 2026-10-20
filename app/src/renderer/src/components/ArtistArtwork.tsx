import { useEffect, useRef } from 'react'
import { motion, useMotionValue, useSpring, useReducedMotion } from 'motion/react'
import { ArrowUpRight } from 'lucide-react'
import type { ArtistGroup } from '../libraryModel'
import { settle } from '../motionPresets'

/**
 * 画布基准宽度：下面所有绘制坐标都按这个宽度写，实际后备尺寸按「显示尺寸 × DPR」缩放。
 * 设计坐标系与分辨率解耦，同一份画法在侧栏小卡片和瀑布大卡片上都不变形。
 */
const DESIGN_WIDTH = 480
/**
 * 后备尺寸上限（宽度）：只为清晰度服务，不跟着窗口无限涨（4K 大屏下每张卡片几 MB 没有意义）。
 * 取 480：瀑布列宽约 323px × DPR 1.75 ≈ 565，封顶 480 与旧行为一致（不退化）；
 * 侧栏 78px 的卡片只需 ~137px，不会再画 480²（那是 12 倍像素与 ~0.9MB 内存）。
 */
const MAX_CANVAS_WIDTH = 480
/**
 * 后备尺寸上限（高度）：极窄/极高卡片（大列宽 + 竖构图）也不至于分配巨大画布。
 * 高度必须跟宽度一起**等比**缩放，画布宽高比要与 CSS 盒子一致，否则 object-fit: cover 会裁边。
 */
const MAX_CANVAS_HEIGHT = 640

export default function ArtistArtwork({ group, index, onSelect }: { group: ArtistGroup; index: number; onSelect: (artist: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useSpring(x, settle)
  const rotateY = useSpring(y, settle)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const styles = getComputedStyle(el)
    const ink = styles.getPropertyValue('--artwork-ink').trim()
    const colors = ['--artwork-blue', '--artwork-sage', '--artwork-sand', '--artwork-lilac']
    const color = styles.getPropertyValue(colors[index % colors.length]!).trim()
    const family = styles.fontFamily
    let drawn = false
    let visible = false
    let retry = 0

    /** 按当前显示尺寸重画；尺寸变化后由 ResizeObserver 触发。 */
    const paint = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        // 布局还没稳定（首帧 rect 为 0）：下一帧再试，避免「可见但空白、滚动后才补画」。
        if (!retry) retry = requestAnimationFrame(() => { retry = 0; if (visible && !drawn) paint() })
        return
      }
      const dpr = Math.min(2, typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1))
      const rawWidth = rect.width * dpr
      const rawHeight = rect.height * dpr
      // 宽高**分别**按 CSS 尺寸 × DPR 算，再**等比**一起封顶：
      // canvas 宽高比必须等于 CSS 盒子的宽高比，否则 object-fit: cover 会裁掉一条边
      // （上一版把高度也按 480 封顶，323×394 的卡片因此被水平裁掉 ~18%、字号被放大 ~21%）。
      const factor = Math.min(1, MAX_CANVAS_WIDTH / rawWidth, MAX_CANVAS_HEIGHT / rawHeight)
      const width = Math.max(1, Math.round(rawWidth * factor))
      const height = Math.max(1, Math.round(rawHeight * factor))
      if (el.width !== width || el.height !== height) {
        // 改 width/height 会清空画布并重置上下文状态，所以之后要重设全部样式。
        el.width = width
        el.height = height
      }
      const scale = width / DESIGN_WIDTH
      const designHeight = height / scale
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.fillStyle = color
      ctx.fillRect(0, 0, DESIGN_WIDTH, designHeight)
      ctx.strokeStyle = ink
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.18
      for (let i = -8; i < 16; i++) {
        ctx.beginPath()
        ctx.moveTo(i * 42, 0)
        ctx.bezierCurveTo(i * 42 + 150, 160, i * 42 - 110, designHeight - 160, i * 42 + 70, designHeight)
        ctx.stroke()
      }
      ctx.globalAlpha = 0.9
      ctx.fillStyle = ink
      ctx.font = '400 142px ' + family
      const letters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(group.artist)].slice(0, 2).map(s => s.segment).join('')
      ctx.fillText(letters, 36, designHeight - 76, 408)
      ctx.globalAlpha = 0.7
      ctx.font = '400 20px ' + family
      ctx.fillText(String(index + 1).padStart(2, '0'), 36, 48)
      ctx.fillText(group.artist, 36, designHeight - 32, 408)
      drawn = true
    }
    const paintIfVisible = (): void => { if (visible && !drawn) paint() }

    // 惰性绘制：艺术家瀑布一次挂着几十张卡片，只画进入视口（含 200px 预取）的那几张。
    // 画布在首次进入视口前保持浏览器默认小尺寸，不分配大后备存储。
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      if (visible) paintIfVisible()
    }, { rootMargin: '200px' })
    observer.observe(el)
    // 布局尺寸变化（窗口缩放 / 瀑布列宽变化）后按新尺寸重画；未画过的等进入视口再说。
    const resizeObserver = new ResizeObserver(() => { if (drawn) paint(); else paintIfVisible() })
    resizeObserver.observe(el)
    // 首帧兜底：IO 回调与布局可能差一帧，第二张「半可见」的卡片过去因此空白到滚动才补画。
    const firstFrame = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      const nearViewport = rect.width > 0 && rect.top < window.innerHeight + 200 && rect.bottom > -200
      if (!nearViewport) return
      visible = true
      if (!drawn) paint()
    })
    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
      cancelAnimationFrame(firstFrame)
      if (retry) cancelAnimationFrame(retry)
    }
  }, [group.artist, index])

  return <motion.button className={'artist-card artist-card-' + index % 3} onClick={() => onSelect(group.artist)}
    aria-label={'浏览 ' + group.artist + ' 的歌曲'}
    initial={reduced ? false : { opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.15 }}
    transition={{ ...settle, delay: Math.min(index, 6) * 0.045 }} whileTap={reduced ? {} : { scale: 0.96 }}>
    <motion.div className="artist-sleeve" style={{ rotateX, rotateY, transformPerspective: 700 }}
      onPointerMove={event => {
        if (reduced || event.pointerType !== 'mouse') return
        const rect = event.currentTarget.getBoundingClientRect()
        x.set((0.5 - (event.clientY - rect.top) / rect.height) * 8)
        y.set(((event.clientX - rect.left) / rect.width - 0.5) * 8)
      }} onPointerLeave={() => { x.set(0); y.set(0) }}>
      <canvas ref={canvas} aria-hidden />
      <span className="artist-open" aria-hidden><ArrowUpRight size={18} strokeWidth={1.5} /></span>
    </motion.div>
    <span className="artist-name">{group.artist}</span><span className="artist-count">{group.tracks.length} 首</span>
  </motion.button>
}