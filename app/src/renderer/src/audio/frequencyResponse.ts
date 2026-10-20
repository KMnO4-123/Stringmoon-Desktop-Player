import type { ConfirmedDsp } from './dspState'

export interface FrequencyPoint { hz: number; db: number }
export interface FrequencyResponse {
  points: FrequencyPoint[]
  minHz: number
  maxHz: number
  sampleRate: number
  bypass: boolean
}

// Reuse a single native filter per device rate. Offline contexts never acquire an
// output device, connect to speakers, render audio, or request microphone access.
const nativeFilters = new Map<number, BiquadFilterNode>()
function nativeFilter(sampleRate: number): BiquadFilterNode {
  const cached = nativeFilters.get(sampleRate)
  if (cached) return cached
  if (typeof OfflineAudioContext === 'undefined') throw new Error('当前环境不支持离线音频频响计算。')
  let context: OfflineAudioContext
  try { context = new OfflineAudioContext(1, 1, sampleRate) }
  catch { throw new Error('离线音频不支持当前设备采样率。') }
  const filter = context.createBiquadFilter()
  // 类型在每次计算前按当前频段重设；这里只是初始值。
  filter.type = 'peaking'
  if (nativeFilters.size >= 3) nativeFilters.delete(nativeFilters.keys().next().value!)
  nativeFilters.set(sampleRate, filter)
  return filter
}

/** Steady-state EQ transfer plus the engine's reported static gain, not a spectrum.
 * Native peaking filters use the same RBJ definition as engine/src/dsp.cpp.
 * Limiting, hard clipping and the engine's short coefficient ramps are nonlinear
 * or time-dependent and are intentionally not claimed by this response plot.
 */
export function calculateResponse(dsp: ConfirmedDsp, sampleRate: number, frequencies?: readonly number[]): FrequencyResponse {
  if (!Number.isFinite(sampleRate) || sampleRate <= 40) throw new Error('设备采样率未知，暂不绘制频响。')
  const maxHz = Math.min(20000, sampleRate / 2)
  const minHz = 20
  const hz = frequencies ? [...frequencies] : Array.from({ length: 192 }, (_, index) =>
    index === 191 ? maxHz : minHz * Math.pow(maxHz / minHz, index / 191))
  if (hz.length === 0 || hz.some(value => !Number.isFinite(value) || value < minHz || value > sampleRate / 2)) {
    throw new Error('频率超出奈奎斯特范围。')
  }
  const points = hz.map(value => ({ hz: value, db: dsp.appliedGainDb }))
  if (dsp.eq.enabled) {
    const query = Float32Array.from(hz)
    const magnitude = new Float32Array(hz.length)
    const phase = new Float32Array(hz.length)
    for (const band of dsp.eq.bands) {
      // Match makePeakingBiquad: a section at/above Nyquist is an identity filter.
      if (band.gainDb === 0 || band.freq <= 0 || band.freq >= sampleRate / 2) continue
      const filter = nativeFilter(sampleRate)
      // 每段的类型与 Q 必须按段取，不能一律用全局 Q 当 peaking ——
      // 否则曲线画的是「十段峰值」，而引擎跑的是用户设的架子/窄带。
      filter.type = band.type === 'lowShelf' ? 'lowshelf'
        : band.type === 'highShelf' ? 'highshelf' : 'peaking'
      filter.frequency.value = band.freq
      // shelf 类型在 WebAudio 里不读 Q；写进去无害，但读数要取每段自己的。
      filter.Q.value = band.q ?? dsp.eq.q
      filter.gain.value = band.gainDb
      filter.getFrequencyResponse(query, magnitude, phase)
      for (let index = 0; index < points.length; index++) {
        const response = magnitude[index]!
        if (!Number.isFinite(response) || response <= 0) throw new Error('原生滤波器未返回有效频响。')
        points[index]!.db += 20 * Math.log10(response)
      }
    }
  }
  return { points, minHz, maxHz, sampleRate, bypass: dsp.passthrough }
}
