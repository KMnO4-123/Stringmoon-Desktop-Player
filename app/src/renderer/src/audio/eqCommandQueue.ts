import type { EqBandPatch, EqPatch } from '@shared/protocol'
import { createPatchQueue } from './patchQueue'

export interface EqCommandStatus {
  pending: EqPatch | null
  saving: boolean
  error: string | null
}

function mergePatch(previous: EqPatch | null, next: EqPatch): EqPatch {
  const merged = { ...previous, ...next }
  if (next.bandGains) {
    merged.bandGains = previous?.bandGains ? [...previous.bandGains] : []
    next.bandGains.forEach((gain, index) => { merged.bandGains![index] = gain })
  }
  // CR-019: per-band shapes merge by index and then by field, so two edits to
  // different slots (or to different fields of one slot) both survive the coalescing.
  if (next.bands) {
    merged.bands = (previous?.bands ?? []).map(band => ({ ...band }))
    next.bands.forEach((band, index) => { merged.bands![index] = { ...merged.bands![index], ...band } })
  }
  return merged
}

const BAND_TYPES = new Set(['peaking', 'lowShelf', 'highShelf'])

function validBand(band: EqBandPatch): boolean {
  if (!band || typeof band !== 'object') return false
  if (band.freq !== undefined && (typeof band.freq !== 'number' || !Number.isFinite(band.freq)
    || (band.freq !== 0 && (band.freq < 10 || band.freq > 24000)))) return false
  if (band.gainDb !== undefined && (typeof band.gainDb !== 'number' || !Number.isFinite(band.gainDb) || Math.abs(band.gainDb) > 12)) return false
  if (band.q !== undefined && (typeof band.q !== 'number' || !Number.isFinite(band.q)
    || (band.q !== 0 && (band.q < 0.1 || band.q > 10)))) return false
  if (band.type !== undefined && !BAND_TYPES.has(band.type)) return false
  return true
}

function validate(patch: EqPatch): void {
  const finite = (value: number): boolean => Number.isFinite(value)
  if (Object.keys(patch).length === 0
    || (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
    || (patch.autoHeadroom !== undefined && typeof patch.autoHeadroom !== 'boolean')
    || (patch.q !== undefined && (!finite(patch.q) || patch.q < 0.5 || patch.q > 4))
    || (patch.preampDb !== undefined && !finite(patch.preampDb))
    || (patch.bandGains !== undefined && (!Array.isArray(patch.bandGains) || patch.bandGains.length === 0
      || patch.bandGains.length > 10 || patch.bandGains.some(gain => !finite(gain) || Math.abs(gain) > 12)))
    || (patch.bands !== undefined && (!Array.isArray(patch.bands) || patch.bands.length === 0
      || patch.bands.length > 10 || patch.bands.some(band => !validBand(band))))) {
    throw new Error('EQ 参数无效，请检查增益、频率与 Q 值。')
  }
}

/** One request at a time; edits made while it runs are merged into the next command. */
export function createEqCommandQueue(send: (patch: EqPatch) => Promise<void>, delayMs = 80) {
  return createPatchQueue<EqPatch>({ merge: mergePatch, validate, send, delayMs })
}
