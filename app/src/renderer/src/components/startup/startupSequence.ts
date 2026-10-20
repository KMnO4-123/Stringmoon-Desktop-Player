export type StartupPhase = 'entering' | 'holding' | 'exiting' | 'complete' | 'disposed'
export type StartupExitReason = 'ready' | 'deadline' | 'skip'
export type StartupSchedule = (callback: () => void, delayMs: number) => () => void

export const STARTUP_TIMING = {
  normal: { introMs: 2320, deadlineMs: 5000, exitMs: 1280, skipMs: 140 },
  reduced: { introMs: 250, deadlineMs: 1200, exitMs: 400, skipMs: 100 }
} as const

export interface StartupSequence {
  readonly phase: StartupPhase
  ready(): void
  skip(): void
  finish(): void
  dispose(): void
}

export function createStartupSequence({ reducedMotion, onHold, onExit, onComplete, schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
} }: {
  reducedMotion: boolean
  onHold?: () => void
  onExit: (reason: StartupExitReason, durationMs: number) => void
  onComplete: () => void
  schedule?: StartupSchedule
}): StartupSequence {
  const timing = reducedMotion ? STARTUP_TIMING.reduced : STARTUP_TIMING.normal
  let phase: StartupPhase = 'entering'
  let isReady = false
  let skipping = false
  const timers: Array<() => void> = []
  const clear = (): void => { timers.splice(0).forEach(cancel => cancel()) }
  const inactive = (): boolean => phase === 'complete' || phase === 'disposed'
  const finish = (): void => {
    if (inactive()) return
    clear()
    phase = 'complete'
    onComplete()
  }
  const exit = (reason: StartupExitReason): void => {
    if (inactive() || skipping || (phase === 'exiting' && reason !== 'skip')) return
    clear()
    phase = 'exiting'
    skipping = reason === 'skip'
    const duration = skipping ? timing.skipMs : timing.exitMs
    onExit(reason, duration)
    if (phase === 'exiting') timers.push(schedule(finish, duration))
  }
  timers.push(schedule(() => {
    phase = 'holding'
    if (isReady) exit('ready')
    else onHold?.()
  }, timing.introMs))
  timers.push(schedule(() => exit('deadline'), timing.deadlineMs))
  return {
    get phase() { return phase },
    ready() {
      isReady = true
      if (phase === 'holding') exit('ready')
    },
    skip() { exit('skip') },
    finish,
    dispose() {
      clear()
      phase = 'disposed'
    }
  }
}

interface StartupRect { left: number; top: number; width: number; height: number }

/** Map the live record centre into a uniformly scaled 1280 × 800 motion scene. */
export function startupLanding(viewport: { width: number; height: number }, record: StartupRect | null): {
  sceneScale: number; sceneLeft: number; sceneTop: number; x: number; y: number; scale: number
} {
  const sceneScale = Math.max(0.01, Math.min(Math.max(1, viewport.width) / 1280, Math.max(1, viewport.height) / 800))
  const sceneLeft = (viewport.width - 1280 * sceneScale) / 2
  const sceneTop = (viewport.height - 800 * sceneScale) / 2
  if (!record || record.width <= 0 || record.height <= 0) {
    return { sceneScale, sceneLeft, sceneTop, x: 0, y: 0, scale: 1 }
  }
  // RecordStage's 1.57-radius body in a camera framed at 1.6 × 1.1.
  const diameter = Math.min(record.width, record.height) * 1.57 / (1.6 * 1.1)
  return {
    sceneScale, sceneLeft, sceneTop,
    x: (record.left + record.width / 2 - sceneLeft) / sceneScale - 640,
    y: (record.top + record.height / 2 - sceneTop) / sceneScale - 305,
    scale: diameter / (288 * sceneScale)
  }
}
