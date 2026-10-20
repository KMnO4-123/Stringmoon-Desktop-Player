/**
 * meter 需求上报（A5 跨层契约，渲染层侧）。
 *
 * 为什么需要它：引擎的 meter 分析在开启时约 7% 单核、关闭时约 3% —— 只有「窗口可见
 * 且当前视图真的有 meter 消费者」时才值得跑。窗口可见性由主进程判断；
 * 「有没有消费者」只有渲染层知道，就是 meterStore 的监听器数量（0 ↔ >0）。
 *
 * 纪律：
 *  - 只在 0 ↔ >0 变化时上报，不做周期心跳；
 *  - true 立即发（切回首页要在 200ms 内恢复 meter），false 去抖 400ms
 *    （视图切换时 AnimatePresence 退场会短暂卸载/重挂，立即发会让引擎来回开关）；
 *  - 旧 preload 没有 setMeterDemand 时静默跳过（可选链），行为退回「按窗口可见」；
 *    单测环境没有 window/preload 也不该报错。
 */
export const METER_DEMAND_DROP_DELAY_MS = 400

let demand = false
let dropTimer: ReturnType<typeof setTimeout> | null = null

/** 旧 preload 可能没有这个方法：用可选链兜底，而不是假设通道一定存在。 */
function bridge(): { setMeterDemand?: (active: boolean) => void } | undefined {
  const scope = globalThis as unknown as { window?: { twilight?: { setMeterDemand?: (active: boolean) => void } } }
  return scope.window?.twilight
}

export function reportMeterDemand(active: boolean): void {
  if (active) {
    if (dropTimer !== null) {
      clearTimeout(dropTimer)
      dropTimer = null
    }
    if (demand) return
    demand = true
    bridge()?.setMeterDemand?.(true)
    return
  }
  // 首次上报 false 不必发：main 默认 demand=false。
  if (!demand || dropTimer !== null) return
  dropTimer = setTimeout(() => {
    dropTimer = null
    if (!demand) return
    demand = false
    bridge()?.setMeterDemand?.(false)
  }, METER_DEMAND_DROP_DELAY_MS)
  // Node 单测环境里别让这个去抖定时器把进程拖住 400ms。
  const timer = dropTimer as unknown as { unref?: () => void }
  timer.unref?.()
}
