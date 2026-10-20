import { useSyncExternalStore } from 'react'
import type { ChannelPatch } from '@shared/protocol'
import { engineRequest } from '../ipc'
import { useTwilight } from '../store'
import { createPatchQueue } from './patchQueue'

export interface ChannelCommandStatus {
  pending: ChannelPatch | null
  saving: boolean
  error: string | null
}

function mergePatch(previous: ChannelPatch | null, next: ChannelPatch): ChannelPatch {
  const merged = { ...previous, ...next }
  if (next.channelGains) {
    merged.channelGains = previous?.channelGains ? [...previous.channelGains] : []
    next.channelGains.forEach((gain, index) => { merged.channelGains![index] = gain })
  }
  // CR-026：三频段按「频段→左右」两级合并；只改一个频段时不要抹掉另外两个。
  if (next.bandGains) {
    merged.bandGains = { ...(previous?.bandGains ?? {}), ...next.bandGains }
  }
  return merged
}

function validate(patch: ChannelPatch): void {
  const range = (value: number | undefined, low: number, high: number): boolean =>
    value === undefined || (Number.isFinite(value) && value >= low && value <= high)
  if (Object.keys(patch).length === 0
    || !range(patch.balance, -1, 1)
    || (patch.mono !== undefined && typeof patch.mono !== 'boolean')
    || !range(patch.stereoWidth, 0, 2)
    || (patch.swapChannels !== undefined && typeof patch.swapChannels !== 'boolean')
    || (patch.channelGains !== undefined && (!Array.isArray(patch.channelGains)
      || patch.channelGains.length > 2 || patch.channelGains.some(gain => !range(gain, -12, 12))))
    || !range(patch.midGainDb, -12, 12)
    || !range(patch.sideGainDb, -12, 12)
    || (patch.crossfeedEnabled !== undefined && typeof patch.crossfeedEnabled !== 'boolean')
    || (patch.crossfeedPreset !== undefined && ![0, 1, 2].includes(patch.crossfeedPreset))
    || !range(patch.crossfeedFcHz, 100, 4000)
    || !range(patch.crossfeedFeedDb, 0, 12)
    // CR-026 新字段：省略合法；出现时逐项校验。
    || (patch.monoMode !== undefined && !['off', 'sum', 'left', 'right'].includes(patch.monoMode))
    || (patch.delayMs !== undefined && (!Array.isArray(patch.delayMs) || patch.delayMs.length !== 2
      || patch.delayMs.some(value => !range(value, 0, 10))))
    || (patch.bandGains !== undefined && (typeof patch.bandGains !== 'object'
      || (['low', 'mid', 'high'] as const).some(key => {
        const value = patch.bandGains?.[key]
        return value !== undefined && (!Array.isArray(value) || value.length !== 2 || value.some(gain => !range(gain, -6, 3)))
      })))) {
    throw new Error('声场参数超出范围。')
  }
}

export function createChannelCommandQueue(send: (patch: ChannelPatch) => Promise<void>, delayMs = 80) {
  return createPatchQueue<ChannelPatch>({ merge: mergePatch, validate, send, delayMs })
}

export const channelCommands = createChannelCommandQueue(async patch => {
  const state = useTwilight.getState()
  if (!state.engineUp || state.dspCapable !== true || !state.dsp) throw new Error('音效引擎尚未就绪。')
  await engineRequest({ cmd: 'set_channels', ...patch })
  const confirmed = useTwilight.getState().dsp
  if (!confirmed?.channels || !confirmed.crossfeed) throw new Error('引擎未返回完整的声场参数。')
})

useTwilight.subscribe((next, previous) => {
  if (next.engineEpoch !== previous.engineEpoch) channelCommands.reset()
})

export const useChannelCommandStatus = () =>
  useSyncExternalStore(channelCommands.subscribe, channelCommands.getSnapshot)