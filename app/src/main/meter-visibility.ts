type MeterCommand = { cmd: 'set_meter'; enabled: boolean }

/**
 * meter 推送开关的唯一所有者。
 *
 * 两个输入必须同时为真才开启：
 *  1. **窗口可见**（最小化/隐藏时渲染层没有消费者，推送只是白跨 IPC）；
 *  2. **渲染层当前视图真有 meter 消费者**（首页的频谱、沉浸页的光效、音效页的监测）。
 *     曲库/搜索/设置/下载页没有消费者 —— 那些页面上引擎既不必序列化 meter，
 *     也不必做分析（perf-engine 的 E2 已配套：enabled=false 时跳过 analyze）。
 *
 * 为什么要去抖：视图切换由 AnimatePresence 编排，旧视图的 meter 组件会一直活到
 * 退场动画结束；立刻发 false→true→false 会让引擎每秒重启两次分析。开启（true）
 * 必须立即生效（用户就看着那一帧），关闭（false）延迟几百毫秒合并。
 */
export class MeterVisibility {
  private visible = false
  private ready = false
  private supported = true
  private sent: boolean | null = null
  private generation = 0
  private sequence = 0
  /** 渲染层报告的「当前视图有 meter 消费者」。默认没有（渲染层首次 true 才开）。 */
  private demand = false
  private demandOffTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly request: (command: MeterCommand) => Promise<unknown>,
    private readonly onError: (error: unknown) => void = () => {},
    // 只有测试会把它调小；产品语义固定 400ms。
    private readonly demandOffDelayMs = 400
  ) {}

  setVisible(visible: boolean): void {
    this.visible = visible
    this.sync()
  }

  /**
   * 渲染层报告 meter 消费者是否存在。
   * - true：立即生效（下一帧就该有数据），同时取消尚未落地的关闭；
   * - false：延迟合并（视图退场动画期间组件还挂着），但窗口隐藏路径不受影响，
   *   visible=false 仍然是即时关闭。
   */
  setDemand(active: boolean): void {
    if (active) {
      this.cancelDemandOff()
      if (this.demand) return
      this.demand = true
      this.sync()
      return
    }
    if (!this.demand || this.demandOffTimer) return
    this.demandOffTimer = setTimeout(() => {
      this.demandOffTimer = null
      this.demand = false
      this.sync()
    }, this.demandOffDelayMs)
  }

  connected(): void {
    ++this.generation
    this.ready = true
    this.supported = true
    this.sent = null
    this.sync()
  }

  disconnected(): void {
    ++this.generation
    this.ready = false
    this.sent = null
  }

  private cancelDemandOff(): void {
    if (!this.demandOffTimer) return
    clearTimeout(this.demandOffTimer)
    this.demandOffTimer = null
  }

  private sync(): void {
    if (!this.ready || !this.supported) return
    // 组合值：窗口可见 **且** 渲染层有消费者。任一为 false 都意味着没有理由让
    // 引擎继续序列化/分析 meter。
    const enabled = this.visible && this.demand
    if (this.sent === enabled) return
    const generation = this.generation
    const sequence = ++this.sequence
    this.sent = enabled
    // EngineHost writes immediately to one ordered stdin stream. Keep that
    // order even during rapid hide/show; replies never overwrite newer intent.
    void this.request({ cmd: 'set_meter', enabled }).catch((error: unknown) => {
      if (generation !== this.generation) return
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_UNSUPPORTED') {
        this.supported = false
        return
      }
      if (sequence === this.sequence) this.sent = null
      this.onError(error)
    })
  }
}
