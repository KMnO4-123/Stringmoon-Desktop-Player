/**
 * 一次只发一条请求、在途期间的编辑合并进下一条的通用队列。
 *
 * 为什么抽出来：均衡器与声场此前各写了一份完全同构的调度器
 * （eqCommandQueue.ts 与 channelCommandQueue.ts，约 80 行重复：排队/合并/在途/代际/
 * 订阅发布一模一样）。同一套时序只该有一份实现 —— 否则同一个 bug 要修两次，
 * 而且两处一旦分叉，界面两个面板的"保存中"行为就会不一致。
 *
 * 这里只留调度；**合并规则与参数校验仍归各自模块**——那是领域知识（哪个字段
 * 可以合并、合法范围是多少），不是队列该知道的事。校验在入队时抛出，调用方
 * 据此给用户看错误；发送失败只记到 error，不丢队列。
 */
export interface PatchQueueStatus<P> {
  pending: P | null
  saving: boolean
  error: string | null
}

export interface PatchQueue<P> {
  enqueue(patch: P): void
  reset(): void
  getSnapshot(): PatchQueueStatus<P>
  subscribe(listener: () => void): () => void
}

export interface PatchQueueOptions<P> {
  /** 把在途补丁与排队补丁合成一条：字段级覆盖，数组按索引逐项合并。 */
  merge: (previous: P | null, next: P) => P
  /** 入队即校验；非法输入不排队，直接抛给调用方。 */
  validate: (patch: P) => void
  send: (patch: P) => Promise<void>
  /** 首条入队到真正发出的等待窗口（毫秒）。一次拖动会在这段窗口里被合并成一条。 */
  delayMs?: number
}

export function createPatchQueue<P>({ merge, validate, send, delayMs = 80 }: PatchQueueOptions<P>): PatchQueue<P> {
  let queued: P | null = null
  let inFlight: P | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let status: PatchQueueStatus<P> = { pending: null, saving: false, error: null }
  const listeners = new Set<() => void>()

  const publish = (error: string | null = status.error): void => {
    status = {
      pending: queued ? merge(inFlight, queued) : inFlight,
      saving: !!(inFlight || queued),
      error
    }
    listeners.forEach(listener => listener())
  }

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    if (!inFlight && queued) timer = setTimeout(() => { timer = null; void flush() }, delayMs)
  }

  const flush = async (): Promise<void> => {
    if (inFlight || !queued) return
    const token = generation
    inFlight = queued
    queued = null
    publish()
    try {
      await send(inFlight)
      // 代际已变（reset）：旧请求的落地结果不能再改状态，否则会盖掉新一任的。
      if (token !== generation) return
      inFlight = null
      publish(null)
    } catch (error) {
      if (token !== generation) return
      inFlight = null
      publish(error instanceof Error ? error.message : String(error))
    }
    schedule()
  }

  return {
    enqueue(patch: P): void {
      validate(patch)
      queued = merge(queued, patch)
      publish(null)
      schedule()
    },
    reset(): void {
      generation++
      if (timer !== null) clearTimeout(timer)
      timer = null
      queued = null
      inFlight = null
      publish(null)
    },
    getSnapshot: (): PatchQueueStatus<P> => status,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
