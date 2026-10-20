import * as THREE from 'three'

interface TrackState {
  title: string
  artist: string
  playing: boolean
}

export interface RecordSceneController {
  update: (track: TrackState) => void
  destroy: () => void
}

interface SpringState {
  value: number
  velocity: number
}

/** Exact damped spring integration keeps the response independent of frame rate. */
export function advanceRecordSpring(state: SpringState, target: number, seconds: number): SpringState {
  const dt = Math.max(0, Math.min(seconds, 0.1))
  const damping = 9
  const frequency = Math.sqrt(160 - damping * damping)
  const distance = state.value - target
  const coefficient = (state.velocity + damping * distance) / frequency
  const decay = Math.exp(-damping * dt)
  const cosine = Math.cos(frequency * dt)
  const sine = Math.sin(frequency * dt)
  const value = target + decay * (distance * cosine + coefficient * sine)
  const velocity = decay * (
    -damping * (distance * cosine + coefficient * sine)
    + frequency * (-distance * sine + coefficient * cosine)
  )
  if (Math.abs(value - target) < 0.0001 && Math.abs(velocity) < 0.001) return { value: target, velocity: 0 }
  return { value, velocity }
}

export function recordCameraDistance(width: number, height: number): number {
  const aspect = Math.max(1, width) / Math.max(1, height)
  return (1.6 / Math.tan(THREE.MathUtils.degToRad(36 / 2))) * Math.max(1, 1 / aspect) * 1.1
}

export function recordCanAnimate(inView: boolean, hidden: boolean, reducedMotion: boolean): boolean {
  return inView && !hidden && !reducedMotion
}

interface Palette {
  body: string
  groove: string
  label: string
  ink: string
  light: string
}

function readPalette(element: HTMLElement): Palette {
  const computed = getComputedStyle(element)
  const token = (name: string) => computed.getPropertyValue(name).trim() || computed.color
  return {
    body: token('--record-body'),
    groove: token('--record-groove'),
    label: token('--record-label'),
    ink: token('--record-ink'),
    light: token('--record-light'),
  }
}

/** Creates a real record model; its printed label is metadata, never claimed album art. */
export function createRecordScene(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  initialTrack: TrackState,
  onFailure: () => void,
): RecordSceneController | null {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const disposers: Array<() => void> = []
  let renderer: THREE.WebGLRenderer | undefined
  let environment: THREE.WebGLRenderTarget | undefined
  let pmrem: THREE.PMREMGenerator | undefined
  let frame = 0
  let destroyed = false

  const stopFrame = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    stopFrame()
    disposers.forEach((dispose) => dispose())
    geometries.forEach((geometry) => geometry.dispose())
    materials.forEach((material) => material.dispose())
    textures.forEach((texture) => texture.dispose())
    environment?.dispose()
    pmrem?.dispose()
    renderer?.dispose()
    renderer?.forceContextLoss()
  }

  try {
    const gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
    renderer = gl
    gl.outputColorSpace = THREE.SRGBColorSpace
    gl.toneMapping = THREE.ACESFilmicToneMapping
    gl.toneMappingExposure = 0.88
    gl.setClearAlpha(0)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 30)
    const tilt = new THREE.Group()
    const record = new THREE.Group()
    scene.add(tilt)
    tilt.add(record)
    tilt.rotation.set(-0.17, -0.3, -0.09)

    let track = initialTrack
    let palette = readPalette(host)
    const geometry = <T extends THREE.BufferGeometry>(value: T): T => { geometries.add(value); return value }
    const material = <T extends THREE.Material>(value: T): T => { materials.add(value); return value }
    const bodyMaterial = material(new THREE.MeshStandardMaterial({
      color: palette.body, roughness: 0.36, metalness: 0.58, envMapIntensity: 0.72,
    }))
    const deadWaxMaterial = material(new THREE.MeshStandardMaterial({
      color: palette.body, roughness: 0.3, metalness: 0.5, envMapIntensity: 0.78,
    }))
    const edgeMaterial = material(new THREE.MeshStandardMaterial({
      color: palette.groove, roughness: 0.32, metalness: 0.65, envMapIntensity: 0.65,
    }))

    const body = new THREE.Mesh(geometry(new THREE.CylinderGeometry(1.57, 1.57, 0.055, 160)), bodyMaterial)
    body.rotation.x = Math.PI / 2
    record.add(body)

    // Four samples per radial wave preserve sloped normals, so the real grooves catch studio light.
    const grooveGeometry = geometry(new THREE.RingGeometry(0.51, 1.56, 256, 160))
    const positions = grooveGeometry.attributes.position!
    for (let index = 0; index < positions.count; index++) {
      const ring = Math.floor(index / 257)
      positions.setZ(index, 0.03 + Math.sin(ring * Math.PI / 2) * 0.0012)
    }
    grooveGeometry.computeVertexNormals()
    record.add(new THREE.Mesh(grooveGeometry, bodyMaterial))

    const deadWax = new THREE.Mesh(geometry(new THREE.RingGeometry(0.025, 0.515, 128)), deadWaxMaterial)
    deadWax.position.z = 0.031
    record.add(deadWax)
    const edge = new THREE.Mesh(geometry(new THREE.TorusGeometry(1.561, 0.011, 8, 192)), edgeMaterial)
    edge.position.z = 0.02
    record.add(edge)

    // 标签纹理分辨率：唱片标签在屏幕上只有约 150–300 设备像素，1024²（4MB 纹理）是 ~7 倍
    // 过采样，换曲时还要整块重传。512²（1MB）显示上等价，内存与上传都省一半以上。
    const LABEL_SIZE = 512
    const labelCanvas = document.createElement('canvas')
    labelCanvas.width = LABEL_SIZE
    labelCanvas.height = LABEL_SIZE
    const context = labelCanvas.getContext('2d')
    if (!context) throw new Error('Record label canvas is unavailable')
    const labelTexture = new THREE.CanvasTexture(labelCanvas)
    textures.add(labelTexture)
    labelTexture.colorSpace = THREE.SRGBColorSpace
    labelTexture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy())
    const labelMaterial = material(new THREE.MeshStandardMaterial({ map: labelTexture, roughness: 0.94, metalness: 0 }))
    const label = new THREE.Mesh(geometry(new THREE.RingGeometry(0.026, 0.485, 128)), labelMaterial)
    label.position.z = 0.034
    record.add(label)

    const spindleMaterial = material(new THREE.MeshStandardMaterial({
      color: palette.light, roughness: 0.2, metalness: 0.95,
    }))
    const spindle = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.021, 24, 16)), spindleMaterial)
    spindle.position.z = 0.036
    record.add(spindle)

    const ambient = new THREE.HemisphereLight(palette.light, palette.body, 1.1)
    const keyLight = new THREE.DirectionalLight(palette.light, 2.6)
    keyLight.position.set(-3, 4, 6)
    const rimLight = new THREE.DirectionalLight(palette.light, 0.9)
    rimLight.position.set(4, -2, 3)
    scene.add(ambient, keyLight, rimLight)

    // Rectangular lights are reflected by the vinyl, never drawn as decorative scene objects.
    const studio = new THREE.Scene()
    studio.background = new THREE.Color(palette.body)
    const studioMaterial = material(new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.light).multiplyScalar(2.8) }))
    const studioGeometry = geometry(new THREE.BoxGeometry(1, 1, 1))
    const panels = [
      { position: [-3, 2, 4], size: [1.2, 5, 0.1] },
      { position: [4, 0, 2], size: [0.1, 4, 2] },
      { position: [0, 5, 0], size: [5, 0.1, 3] },
    ]
    for (const panel of panels) {
      const mesh = new THREE.Mesh(studioGeometry, studioMaterial)
      mesh.position.set(panel.position[0]!, panel.position[1]!, panel.position[2]!)
      mesh.scale.set(panel.size[0]!, panel.size[1]!, panel.size[2]!)
      studio.add(mesh)
    }
    pmrem = new THREE.PMREMGenerator(gl)
    const updateEnvironment = () => {
      if (!pmrem) return
      const next = pmrem.fromScene(studio, 0.03, 0.1, 30)
      scene.environment = next.texture
      environment?.dispose()
      environment = next
    }
    updateEnvironment()

    const paintLabel = () => {
      // 绘制代码仍按 1024 设计坐标写；用 transform 缩到实际纹理尺寸，换分辨率不必重排版。
      const labelScale = LABEL_SIZE / 1024
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, LABEL_SIZE, LABEL_SIZE)
      context.setTransform(labelScale, 0, 0, labelScale, 0, 0)
      context.fillStyle = palette.label
      context.fillRect(0, 0, 1024, 1024)
      context.fillStyle = palette.ink
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      const family = getComputedStyle(host).fontFamily
      const fitText = (text: string, y: number, initialSize: number, maxWidth: number, weight = 500) => {
        let size = initialSize
        context.font = `${weight} ${size}px ${family}`
        while (context.measureText(text).width > maxWidth && size > 20) {
          size -= 2
          context.font = `${weight} ${size}px ${family}`
        }
        context.fillText(text, 512, y, maxWidth)
      }
      fitText('STRINGMOON', 240, 48, 700, 650)
      fitText(track.title || '等待播放', 365, 72, 820, 650)
      fitText(track.artist || '你的音乐，此刻回响', 660, 48, 800)
      fitText('SIDE  A', 790, 38, 600)
      context.strokeStyle = palette.ink
      context.globalAlpha = 0.22
      context.lineWidth = 2
      context.beginPath()
      context.arc(512, 512, 446, 0, Math.PI * 2)
      context.stroke()
      context.globalAlpha = 1
      labelTexture.needsUpdate = true
    }
    paintLabel()

    let inView = true
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reducedMotion = media.matches
    let xSpring: SpringState = { value: 0, velocity: 0 }
    let ySpring: SpringState = { value: 0, velocity: 0 }
    let targetX = 0
    let targetY = 0
    /** 上一次真正渲染时的 rAF 时间戳：弹簧/旋转按**真实经过秒数**积分，限帧不改变速度。 */
    let lastPaint = 0
    /** 上一次 rAF 回调时间与累计时间：渲染限到 60fps，但循环仍按屏幕刷新率回调。 */
    let lastTick = 0
    let frameBudget = Number.POSITIVE_INFINITY
    const FRAME_INTERVAL_MS = 1000 / 60
    const unsettled = () => xSpring.value !== targetX || ySpring.value !== targetY || xSpring.velocity !== 0 || ySpring.velocity !== 0
    const canAnimate = () => recordCanAnimate(inView, document.hidden, reducedMotion)
    const fail = () => {
      if (destroyed) return
      destroy()
      onFailure()
    }
    const render = () => {
      if (destroyed || !inView || document.hidden) return
      try { gl.render(scene, camera) } catch { fail() }
    }
    const tick = (timestamp: number) => {
      frame = 0
      if (destroyed || !inView || document.hidden) return
      // 渲染上限 60fps：高刷屏（本机实测 ~90Hz）上 rAF 仍按刷新率回调，但只有累计够一帧
      // 才积分/渲染。弹簧与旋转必须用「距上次渲染的真实秒数」——用固定 1/60 会让转速变慢。
      const sinceTick = lastTick ? timestamp - lastTick : 0
      lastTick = timestamp
      frameBudget += sinceTick
      if (frameBudget < FRAME_INTERVAL_MS - 1) {
        if (canAnimate() && (track.playing || unsettled())) frame = requestAnimationFrame(tick)
        return
      }
      const seconds = lastPaint ? Math.min((timestamp - lastPaint) / 1000, 1 / 30) : 1 / 60
      lastPaint = timestamp
      // 保留余量而不是归零：90Hz 上步长 11.1ms 与 16.7ms 阈值不整除，归零会退化成一帧画一帧不画。
      frameBudget -= FRAME_INTERVAL_MS
      if (canAnimate()) {
        xSpring = advanceRecordSpring(xSpring, targetX, seconds)
        ySpring = advanceRecordSpring(ySpring, targetY, seconds)
        tilt.rotation.x = -0.17 + xSpring.value
        tilt.rotation.y = -0.3 + ySpring.value
        if (track.playing) record.rotation.z -= seconds * 0.68
      }
      render()
      if (!destroyed && canAnimate() && (track.playing || unsettled())) frame = requestAnimationFrame(tick)
      else { lastPaint = 0; lastTick = 0; frameBudget = Number.POSITIVE_INFINITY }
    }
    const invalidate = () => {
      if (destroyed || frame || !inView || document.hidden) return
      // 空闲后的第一帧立即渲染（不等 16.7ms 累计）；时间基准一起归零，避免补帧跳变。
      frameBudget = FRAME_INTERVAL_MS
      lastPaint = 0
      lastTick = 0
      frame = requestAnimationFrame(tick)
    }
    const pauseFrames = () => { stopFrame(); lastPaint = 0; lastTick = 0; frameBudget = Number.POSITIVE_INFINITY }
    const resize = () => {
      if (destroyed) return
      const bounds = host.getBoundingClientRect()
      const width = Math.max(1, bounds.width)
      const height = Math.max(1, bounds.height)
      // 用真实 DPR，不向上取整：1.75 的屏上 ceil 会抬到 2.0，多出 31% 像素却不会更准
      // （画布最终被合成器缩放到物理像素，多画的像素只是额外光栅化）。上限 2 保留高 DPI 收益。
      gl.setPixelRatio(Math.min(2, Math.max(1, window.devicePixelRatio || 1)))
      gl.setSize(width, height, false)
      camera.aspect = width / height
      camera.position.set(0, 0, recordCameraDistance(width, height))
      camera.updateProjectionMatrix()
      invalidate()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    disposers.push(() => resizeObserver.disconnect())
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false
      if (inView) invalidate()
      else pauseFrames()
    }, { threshold: 0 })
    intersectionObserver.observe(host)
    disposers.push(() => intersectionObserver.disconnect())

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion || event.pointerType === 'touch') return
      const bounds = host.getBoundingClientRect()
      const x = THREE.MathUtils.clamp((event.clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1, -1, 1)
      const y = THREE.MathUtils.clamp((event.clientY - bounds.top) / Math.max(1, bounds.height) * 2 - 1, -1, 1)
      targetX = y * 0.16
      targetY = x * 0.24
      invalidate()
    }
    const onPointerLeave = () => { targetX = 0; targetY = 0; invalidate() }
    const onVisibility = () => { if (document.hidden) pauseFrames(); else invalidate() }
    const onMotionPreference = () => {
      reducedMotion = media.matches
      if (reducedMotion) {
        pauseFrames()
        targetX = targetY = 0
        xSpring = ySpring = { value: 0, velocity: 0 }
        tilt.rotation.set(-0.17, -0.3, -0.09)
      }
      invalidate()
    }
    const onContextLost = (event: Event) => { event.preventDefault(); fail() }
    host.addEventListener('pointermove', onPointerMove, { passive: true })
    host.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)
    media.addEventListener('change', onMotionPreference)
    canvas.addEventListener('webglcontextlost', onContextLost)
    window.addEventListener('resize', resize)
    disposers.push(() => {
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      media.removeEventListener('change', onMotionPreference)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      window.removeEventListener('resize', resize)
    })

    const onTheme = () => {
      if (destroyed) return
      const next = readPalette(host)
      if (JSON.stringify(next) === JSON.stringify(palette)) return
      palette = next
      bodyMaterial.color.set(palette.body)
      deadWaxMaterial.color.set(palette.body)
      edgeMaterial.color.set(palette.groove)
      spindleMaterial.color.set(palette.light)
      ambient.color.set(palette.light)
      ambient.groundColor.set(palette.body)
      keyLight.color.set(palette.light)
      rimLight.color.set(palette.light)
      studio.background = new THREE.Color(palette.body)
      studioMaterial.color.set(palette.light).multiplyScalar(2.8)
      updateEnvironment()
      paintLabel()
      invalidate()
    }
    const themeObserver = new MutationObserver(onTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode'] })
    disposers.push(() => themeObserver.disconnect())
    void document.fonts.ready.then(() => { if (!destroyed) { paintLabel(); invalidate() } })
    resize()

    return {
      update(next) {
        if (destroyed) return
        const metadataChanged = next.title !== track.title || next.artist !== track.artist
        track = next
        if (metadataChanged) paintLabel()
        invalidate()
      },
      destroy,
    }
  } catch {
    destroy()
    onFailure()
    return null
  }
}
