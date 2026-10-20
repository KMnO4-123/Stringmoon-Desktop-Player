import { createStartupSequence, STARTUP_TIMING, startupLanding } from './startupSequence'
import type { StartupSequence } from './startupSequence'

export interface StartupMotion { ready(): void; skip(): void; dispose(): void }
type Step = [number, Keyframe, string?]

/** Native, finite animations. Timers gate loading; no JavaScript render loop. */
export function startStartupMotion(host: HTMLElement, content: HTMLElement, onComplete: () => void): StartupMotion {
  const scene = host.querySelector<HTMLElement>('.startup-scene')!
  const hero = host.querySelector<HTMLElement>('.startup-hero')!
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  const tokens = getComputedStyle(host)
  const settle = tokens.getPropertyValue('--ease-immerse').trim()
  const flow = tokens.getPropertyValue('--ease-in-out-screen').trim()
  const animations = new Set<Animation>()
  let sequence: StartupSequence | null = null
  let ready = false, disposed = false, started = false
  let observedRecord: Element | null = null
  let landingAnimation: Animation | null = null
  let offWindowHidden: (() => void) | undefined
  const transform = (): string => `translate(${hero.style.getPropertyValue('--startup-land-x')}, ${hero.style.getPropertyValue('--startup-land-y')}) scale(${hero.style.getPropertyValue('--startup-land-scale')})`
  const query = (selector: string): Element => host.querySelector(selector)!
  const animate = (target: Element | string, steps: Step[], duration: number): Animation => {
    const frames = steps.map(([ms, properties, easing]) => ({ ...properties, offset: ms / duration, ...(easing ? { easing } : {}) }))
    const last = frames.at(-1)!
    if (Number(last.offset) < 1) frames.push({ ...last, offset: 1 })
    const animation = (typeof target === 'string' ? query(target) : target).animate(frames, { duration, fill: 'both', easing: 'linear' })
    animations.add(animation)
    return animation
  }
  const fit = (): void => {
    if (disposed) return
    const viewport = host.getBoundingClientRect()
    const record = content.querySelector('.record-stage')
    const box = record?.getBoundingClientRect()
    const target = box ? { left: box.left - viewport.left, top: box.top - viewport.top, width: box.width, height: box.height } : null
    const landing = startupLanding(viewport, target)
    scene.style.transform = `translate(${landing.sceneLeft}px, ${landing.sceneTop}px) scale(${landing.sceneScale})`
    hero.style.setProperty('--startup-land-x', `${landing.x}px`)
    hero.style.setProperty('--startup-land-y', `${landing.y}px`)
    hero.style.setProperty('--startup-land-scale', `${landing.scale}`)
    // Retarget an exit already in progress when the window changes size.
    if (landingAnimation?.effect instanceof KeyframeEffect) {
      landingAnimation.effect.setKeyframes([
        { transform: 'translate(0px, 0px) scale(1)', offset: 0, easing: flow },
        { transform: transform(), offset: 680 / 1280 },
        { transform: transform(), offset: 1 }
      ])
    }
    if (record && record !== observedRecord) {
      if (observedRecord) observer.unobserve(observedRecord)
      observedRecord = record
      observer.observe(record)
    }
  }
  const observer = new ResizeObserver(fit)
  const cleanup = (): void => {
    animations.forEach(animation => animation.cancel())
    animations.clear()
    observer.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('keydown', keyboard, true)
    media.removeEventListener('change', motionPreference)
    offWindowHidden?.()
  }
  const complete = (): void => {
    if (disposed) return
    disposed = true
    const restoreFocus = host.contains(document.activeElement)
    cleanup()
    content.style.opacity = '1'
    content.inert = false
    content.removeAttribute('aria-hidden')
    host.hidden = true
    if (restoreFocus) content.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true })
    onComplete()
  }
  const exit = (reason: 'ready' | 'deadline' | 'skip', duration: number): void => {
    host.dataset.phase = 'exiting'
    content.style.opacity = '1'
    if (reason === 'skip') {
      const opacity = getComputedStyle(host).opacity
      animate(host, [[0, { opacity }], [duration, { opacity: 0 }]], duration)
      return
    }
    if (media.matches) {
      animate(host, [[0, { opacity: 1 }], [duration, { opacity: 0 }]], duration)
      return
    }
    fit()
    animate('.startup-moon', [[0, { opacity: 1, transform: 'scale(1)' }], [520, { opacity: 0, transform: 'scale(.58)' }]], duration)
    animate('.startup-girl', [[0, { opacity: 1, transform: 'translate(0px,0px)' }], [400, { opacity: 0, transform: 'translate(0px,-6px)' }]], duration)
    for (const selector of ['.startup-orbit', '.startup-ring', '.startup-atmosphere', '.startup-halo', '.startup-sub', '.startup-signature']) {
      animate(selector, [[0, { opacity: getComputedStyle(query(selector)).opacity }], [420, { opacity: 0 }]], duration)
    }
    host.querySelectorAll('.startup-star').forEach(star => animate(star, [[0, { opacity: .2 }], [360, { opacity: 0 }]], duration))
    host.querySelectorAll('.startup-word span').forEach((letter,i) => animate(letter, [[0, { opacity: 1, transform: 'translateY(0px)' }], [360+i*8, { opacity: 0, transform: 'translateY(-12px)' }]], duration))
    animate('.startup-vinyl', [[0, { opacity: 0, transform: 'scale(.55) rotate(-30deg)' }, settle], [350, { opacity: .95, transform: 'scale(1) rotate(0deg)' }], [680, { opacity: .8, transform: 'scale(1) rotate(10deg)' }], [1080, { opacity: 0, transform: 'scale(1) rotate(20deg)' }]], duration)
    landingAnimation = animate(hero, [[0, { transform: 'translate(0px,0px) scale(1)' }, flow], [680, { transform: transform() }]], duration)
    animate('.startup-backdrop', [[0, { opacity: 1 }], [590, { opacity: 1 }, settle], [duration, { opacity: 0 }]], duration)
  }
  const begin = (): void => {
    if (started || disposed) return
    started = true
    const reduced = media.matches
    host.dataset.reduced = String(reduced)
    fit()
    sequence = createStartupSequence({ reducedMotion: reduced, onHold: () => { host.dataset.phase = 'holding' }, onExit: (reason, duration) => {
      try { exit(reason, duration) } catch { sequence?.finish() }
    }, onComplete: complete })
    if (ready) sequence.ready()
    try {
      if (reduced) {
        hero.style.transform = 'scale(.63)'
      } else {
        const intro = (target: Element | string, steps: Step[]): void => { animate(target, steps, STARTUP_TIMING.normal.introMs) }
        intro('.startup-atmosphere', [[0, { opacity: 0 }], [900, { opacity: 1 }]])
        intro('.startup-seed', [[0, { opacity: 0, transform: 'scale(0)' }], [140, { opacity: 1, transform: 'scale(1.1)' }], [380, { opacity: 1, transform: 'scale(.65)' }], [700, { opacity: 0, transform: 'scale(.2)' }]])
        intro('.startup-string', [[0, { opacity: 0, transform: 'scaleX(0)' }], [90, { opacity: 0, transform: 'scaleX(.02)' }, settle], [390, { opacity: .9, transform: 'scaleX(1)' }], [630, { opacity: 0, transform: 'scaleX(.94)' }]])
        intro('.startup-wave', [[0, { opacity: 0, transform: 'scaleY(.1)' }], [190, { opacity: 0, transform: 'scaleY(.1)' }], [330, { opacity: .65, transform: 'scaleY(1)' }], [670, { opacity: 0, transform: 'scaleY(.04)' }]])
        intro('.startup-ring-track', [[0, { strokeDashoffset: 1006, opacity: 0 }], [270, { strokeDashoffset: 1006, opacity: .7 }, settle], [1120, { strokeDashoffset: 0, opacity: .65 }]])
        intro('.startup-ring', [[0, { opacity: 0, transform: 'rotate(-160deg) scale(.78)' }], [270, { opacity: 1, transform: 'rotate(-160deg) scale(.78)' }, settle], [1170, { opacity: 1, transform: 'rotate(-90deg) scale(1)' }], [2320, { opacity: .8, transform: 'rotate(-70deg) scale(1.035)' }]])
        intro('.startup-ring-lit', [[0, { strokeDashoffset: 1006 }], [270, { strokeDashoffset: 1006 }, settle], [1400, { strokeDashoffset: -150 }], [2320, { strokeDashoffset: -300 }]])
        intro('.startup-halo', [[0, { opacity: 0, transform: 'scale(.7)' }], [580, { opacity: 0, transform: 'scale(.7)' }, settle], [1420, { opacity: 1, transform: 'scale(1)' }], [2320, { opacity: .85, transform: 'scale(1.03)' }]])
        intro('.startup-moon', [[0, { opacity: 0, transform: 'translateY(26px) scale(.78)' }], [330, { opacity: 0, transform: 'translateY(26px) scale(.78)' }, settle], [1100, { opacity: 1, transform: 'translateY(0px) scale(1)' }]])
        host.querySelectorAll('.startup-moon-band').forEach((band,i) => intro(band, [[0, { transform: `translateY(${16+i*5}px)`, opacity: 0 }], [390+i*45, { transform: `translateY(${16+i*5}px)`, opacity: 0 }, settle], [1000+i*42, { transform: 'translateY(0px)', opacity: 1 }]]))
        intro('.startup-girl', [[0, { opacity: 0, transform: 'translate(8px,22px)' }], [620, { opacity: 0, transform: 'translate(8px,22px)' }, settle], [1370, { opacity: 1, transform: 'translate(0px,0px)' }]])
        intro('.startup-orbit', [[0, { opacity: 0, transform: 'rotate(-26deg) scale(.68)' }], [450, { opacity: 0, transform: 'rotate(-26deg) scale(.68)' }, settle], [1400, { opacity: .85, transform: 'rotate(-19deg) scale(1)' }], [2320, { opacity: .65, transform: 'rotate(-16deg) scale(1.025)' }]])
        host.querySelectorAll('.startup-star').forEach((star,i) => intro(star, [[0, { opacity: 0 }], [900+i*60, { opacity: 0 }], [1450+i*30, { opacity: i%2 ? .36 : .16 }], [2320, { opacity: .16 }]]))
        host.querySelectorAll('.startup-word span').forEach((letter,i) => intro(letter, [[0, { opacity: 0, transform: 'translateY(18px)' }], [980+i*30, { opacity: 0, transform: 'translateY(18px)' }, settle], [1600+i*22, { opacity: 1, transform: 'translateY(0px)' }]]))
        intro('.startup-sub', [[0, { opacity: 0, transform: 'translateY(7px)' }], [1450, { opacity: 0, transform: 'translateY(7px)' }, settle], [1950, { opacity: 1, transform: 'translateY(0px)' }]])
        intro('.startup-signature', [[0, { opacity: 0 }], [1450, { opacity: 0 }], [1950, { opacity: 1 }]])
      }
      host.querySelector<HTMLButtonElement>('.startup-skip')?.focus({ preventScroll: true })
    } catch { sequence.finish() }
  }
  const visibility = (): void => {
    if (document.hidden) sequence?.finish()
    else begin()
  }
  const keyboard = (event: KeyboardEvent): void => {
    if (disposed) return
    event.stopPropagation()
    if (event.key === 'Escape' || event.code === 'Space' || event.key === 'Enter') {
      event.preventDefault()
      sequence?.skip()
    }
  }
  const motionPreference = (): void => {
    if (!media.matches) return
    animations.forEach(animation => animation.pause())
    sequence?.skip()
  }
  observer.observe(host)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('keydown', keyboard, true)
  media.addEventListener('change', motionPreference)
  offWindowHidden = window.twilight.onWindowHidden(() => sequence?.finish())
  if (!document.hidden) begin()
  return {
    ready() { ready = true; sequence?.ready() },
    skip() { sequence?.skip() },
    dispose() {
      disposed = true
      sequence?.dispose()
      cleanup()
      content.style.opacity = '1'
    }
  }
}
