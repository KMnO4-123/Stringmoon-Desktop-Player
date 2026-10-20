// Apple-style response/damping inputs converted for Motion's spring solver.
const response = 0.42
const dampingRatio = 0.82
const angularFrequency = 2 * Math.PI / response
export const settle = { type: 'spring' as const, stiffness: angularFrequency ** 2, damping: 2 * dampingRatio * angularFrequency, mass: 1 }

/**
 * 视图切换用的**快速收敛**弹簧（response 0.18s、阻尼比 0.95 —— 欠阻尼一点点，不会过冲抖动）。
 *
 * 为什么不用 settle：settle 的 response 是 0.42s，退出动画实测 306ms 视觉到位、却要 554ms 才判完成，
 * 而 AnimatePresence 的 mode="wait" 必须等旧视图**判完成**才挂载新视图 —— 切页 630ms 就是这么来的。
 */
const snapResponse = 0.12
const snapDamping = 0.95
const snapFrequency = 2 * Math.PI / snapResponse
export const snap = { type: 'spring' as const, stiffness: snapFrequency ** 2, damping: 2 * snapDamping * snapFrequency, mass: 1 }
