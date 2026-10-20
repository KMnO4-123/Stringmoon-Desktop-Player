import type { HTMLAttributes, PointerEvent } from 'react'

function trackHighlight(event: PointerEvent<HTMLElement>): void {
  if (event.pointerType !== 'mouse' || window.matchMedia('(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce)').matches) return
  const element = event.currentTarget
  const rect = element.getBoundingClientRect()
  const x = Math.max(0, Math.min(100, (event.clientX - rect.left) / Math.max(1, rect.width) * 100))
  const y = Math.max(0, Math.min(100, (event.clientY - rect.top) / Math.max(1, rect.height) * 100))
  element.style.setProperty('--glass-x', x.toFixed(1) + '%')
  element.style.setProperty('--glass-y', y.toFixed(1) + '%')
  element.dataset.glassActive = 'true'
}

function release(event: PointerEvent<HTMLElement>): void {
  delete event.currentTarget.dataset.glassPressed
}

// Optical feedback only: no frame loop, React state or displaced hit targets.
export const glassInteraction: Pick<HTMLAttributes<HTMLElement>, 'onPointerMove' | 'onPointerLeave' | 'onPointerDown' | 'onPointerUp' | 'onPointerCancel'> = {
  onPointerMove: trackHighlight,
  onPointerDown: event => { event.currentTarget.dataset.glassPressed = 'true' },
  onPointerUp: release,
  onPointerCancel: release,
  onPointerLeave: event => {
    delete event.currentTarget.dataset.glassActive
    release(event)
  }
}
