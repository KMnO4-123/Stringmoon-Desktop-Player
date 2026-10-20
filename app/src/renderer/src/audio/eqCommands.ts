import { useSyncExternalStore } from 'react'
import { engineRequest } from '../ipc'
import { useTwilight } from '../store'
import { createEqCommandQueue } from './eqCommandQueue'

/** Shared by the full editor and compact player so remounting cannot reorder edits. */
export const eqCommands = createEqCommandQueue(async patch => {
  const state = useTwilight.getState()
  if (!state.engineUp || state.dspCapable !== true || !state.dsp) throw new Error('均衡器尚未就绪，请重新读取引擎状态。')
  await engineRequest({ cmd: 'set_eq', ...patch })
  if (!useTwilight.getState().dsp) throw new Error('引擎未返回完整的 EQ 参数，请重新读取状态。')
})

useTwilight.subscribe((next, previous) => {
  if (next.engineEpoch !== previous.engineEpoch) eqCommands.reset()
})

export const useEqCommandStatus = () => useSyncExternalStore(eqCommands.subscribe, eqCommands.getSnapshot)

let refreshing: Promise<void> | null = null
/**
 * 重新读取 DSP 参数。
 *
 * 必须带超时：主进程或引擎一时没有回包时，这个 promise 会一直挂着，
 * 而 refreshing 只会在它 settle 之后清空 —— 界面就永远停在「正在读取」，
 * 连重试都没有入口。宁可 6 秒后明确报错，让用户点得动。
 */
export function refreshDspDetails(timeoutMs = 6000): Promise<void> {
  if (!refreshing) refreshing = Promise.race([
    engineRequest({ cmd: 'get_state' }, timeoutMs).then(() => {
      if (!useTwilight.getState().dsp) throw new Error('引擎尚未提供完整的 EQ 参数。')
    }),
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('读取均衡器参数超时，请重试。')), timeoutMs + 500)
    })
  ]).finally(() => { refreshing = null })
  return refreshing
}
