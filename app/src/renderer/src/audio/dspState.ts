import type { DspState, EqState } from '@shared/protocol'

/**
 * SPEC 3.4 的十段网格频率 —— 这是**默认值**，不是合法集合。
 *
 * CR-019 之后每段可以有自己的频率（无极调节），所以解析时不能要求
 * `band.freq === EQ_FREQUENCIES[index]`：一旦用户把某个频段拖离网格，
 * 整份参数就会被判为非法、模型变 null、整个 EQ 面板变灰且无法撤销，
 * 而且「重新读取」读回来的还是同一份，等于永久卡住。
 * 频段的身份是**槽位下标**，不是它的频率。
 */
export const EQ_FREQUENCIES = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const RESPONSE_HISTORY_LIMIT = 12

export interface ConfirmedDsp extends DspState {
  eq: EqState
  appliedGainDb: number
  passthrough: boolean
  streaming: boolean
}

export interface DspHistoryEntry {
  dsp: ConfirmedDsp
  sampleRate: number | null
  key: string
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Unknown or malformed engine data never becomes a plausible-looking flat curve. */
export function parseDspState(value: unknown): ConfirmedDsp | null {
  const data = record(value)
  const eq = record(data?.eq)
  if (!data || !eq || typeof eq.enabled !== 'boolean' || typeof eq.autoHeadroom !== 'boolean'
    || !finite(eq.q) || eq.q < 0.5 || eq.q > 4 || !finite(eq.preampDb)
    || !finite(data.appliedGainDb) || typeof data.passthrough !== 'boolean' || typeof data.streaming !== 'boolean'
    || !Array.isArray(eq.bands) || eq.bands.length !== EQ_FREQUENCIES.length) return null
  const bands: EqState['bands'] = []
  for (const [index, value] of eq.bands.entries()) {
    const band = record(value)
    if (!band || !finite(band.freq) || band.freq < 10 || band.freq > 24000
      || !finite(band.gainDb) || Math.abs(band.gainDb) > 12) return null
    // CR-019 的每段形状（类型/Q）以前在这里被丢掉：引擎一直在发，
    // 应用只留了 freq+gainDb，于是类型与 Q 控件永远显示默认值、改了也回不来。
    // 只接受明确合法的值；字段缺失时保持 undefined（老引擎没有这两项）。
    const type = band.type
    const bandQ = band.q
    if (type !== undefined && type !== 'peaking' && type !== 'lowShelf' && type !== 'highShelf') return null
    if (bandQ !== undefined && (!finite(bandQ) || bandQ < 0.1 || bandQ > 10)) return null
    bands.push({
      freq: band.freq as number,
      gainDb: band.gainDb,
      ...(typeof bandQ === 'number' ? { q: bandQ } : {}),
      ...(typeof type === 'string' ? { type: type as EqState['bands'][number]['type'] } : {})
    })
  }
  const parsed: ConfirmedDsp = {
    eq: { enabled: eq.enabled, q: eq.q, preampDb: eq.preampDb, autoHeadroom: eq.autoHeadroom, bands },
    appliedGainDb: data.appliedGainDb, passthrough: data.passthrough, streaming: data.streaming
  }
  if (typeof data.limiterEnabled === 'boolean') parsed.limiterEnabled = data.limiterEnabled
  const channels = record(data.channels)
  const gains = channels?.channelGains
  if (channels && finite(channels.balance) && channels.balance >= -1 && channels.balance <= 1
    && typeof channels.mono === 'boolean' && finite(channels.midGainDb) && Math.abs(channels.midGainDb) <= 12
    && finite(channels.sideGainDb) && Math.abs(channels.sideGainDb) <= 12
    && finite(channels.stereoWidth) && channels.stereoWidth >= 0 && channels.stereoWidth <= 2
    && typeof channels.swapChannels === 'boolean' && Array.isArray(gains) && gains.length === 2
    && gains.every((value, index) => {
      const item = record(value)
      return item?.channel === index && finite(item.gainDb) && Math.abs(item.gainDb) <= 12
    })) {
    parsed.channels = {
      balance: channels.balance,
      mono: channels.mono,
      midGainDb: channels.midGainDb,
      sideGainDb: channels.sideGainDb,
      stereoWidth: channels.stereoWidth,
      swapChannels: channels.swapChannels,
      channelGains: gains.map((value, channel) => ({
        channel,
        gainDb: (record(value) as Record<string, unknown>).gainDb as number
      }))
    }
    // CR-026（只增）：旧引擎不发这三个字段 → 保持 undefined（UI 按 off/0 展示）。
    if (channels.monoMode === 'off' || channels.monoMode === 'sum' || channels.monoMode === 'left' || channels.monoMode === 'right') {
      parsed.channels.monoMode = channels.monoMode
    }
    const bandPair = (value: unknown): [number, number] | null => {
      if (!Array.isArray(value) || value.length !== 2) return null
      const [left, right] = value
      return typeof left === 'number' && Number.isFinite(left) && typeof right === 'number' && Number.isFinite(right)
        && Math.abs(left) <= 6 && Math.abs(right) <= 6 ? [left, right] : null
    }
    const bandGains = record(channels.bandGains)
    const low = bandPair(bandGains?.low), mid = bandPair(bandGains?.mid), high = bandPair(bandGains?.high)
    if (low && mid && high) parsed.channels.bandGains = { low, mid, high }
    const delay = bandPair(channels.delayMs)
    if (delay && delay[0] >= 0 && delay[0] <= 10 && delay[1] >= 0 && delay[1] <= 10) parsed.channels.delayMs = delay
  }
  const crossfeed = record(data.crossfeed)
  if (crossfeed && typeof crossfeed.enabled === 'boolean' && Number.isInteger(crossfeed.preset)
    && typeof crossfeed.preset === 'number' && crossfeed.preset >= -1 && crossfeed.preset <= 2
    && finite(crossfeed.fcHz) && crossfeed.fcHz >= 100 && crossfeed.fcHz <= 4000
    && finite(crossfeed.feedDb) && crossfeed.feedDb >= 0 && crossfeed.feedDb <= 12) {
    parsed.crossfeed = {
      enabled: crossfeed.enabled,
      preset: crossfeed.preset,
      fcHz: crossfeed.fcHz,
      feedDb: crossfeed.feedDb
    }
  }
  const rg = record(data.replayGain)
  if (rg && (rg.mode === 'off' || rg.mode === 'track' || rg.mode === 'album')
    && finite(rg.trackGainDb) && finite(rg.albumGainDb) && finite(rg.preampDb) && typeof rg.preventClip === 'boolean') {
    parsed.replayGain = { mode: rg.mode, trackGainDb: rg.trackGainDb, albumGainDb: rg.albumGainDb,
      preampDb: rg.preampDb, preventClip: rg.preventClip }
  }
  return parsed
}

/** Streaming activity is deliberately excluded: these are parameter changes, not audio frames. */
export function responseParameterKey(dsp: ConfirmedDsp): string {
  return JSON.stringify([dsp.eq, dsp.appliedGainDb, dsp.passthrough, dsp.channels, dsp.crossfeed])
}