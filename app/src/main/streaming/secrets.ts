/**
 * Electron safeStorage 异步解密结果的形状归一。
 *
 * Electron 44 起 `decryptStringAsync()` 返回
 * `Promise<{ result: string; shouldReEncrypt: boolean }>`
 * （见 electron.d.ts:12153 / 21733），不再是 `Promise<string>`。
 * 旧代码按 string 判断，于是平台登录凭据虽然写进了 streaming-sessions.json，
 * 重启后却永远解不出来 —— 表现是「每次启动都要重新扫码/重新登录」，
 * 而日志里没有任何错误（静默变成 signed-out）。
 *
 * 这里同时兼容两种形状（旧 Electron / 测试桩返回 string），并把
 * shouldReEncrypt 作为「加载后立刻重新加密落盘」的信号（DPAPI 密钥轮换后
 * 旧密文仍能读，但应当用新密钥重写，否则下次可能就解不开了）。
 */
export interface DecryptedSecret {
  /** 解出来的明文；null = 形状不认识 / 解密失败，调用方按「没读到」处理。 */
  secret: string | null
  /** true = 读到了、但应该用当前密钥重新加密落盘。 */
  reEncrypt: boolean
}

export function plainSecretOf(value: unknown): DecryptedSecret {
  // 旧版本（或测试桩）直接返回 string。
  if (typeof value === 'string') return { secret: value, reEncrypt: false }
  if (value && typeof value === 'object') {
    const record = value as { result?: unknown; shouldReEncrypt?: unknown }
    if (typeof record.result === 'string') {
      return { secret: record.result, reEncrypt: record.shouldReEncrypt === true }
    }
  }
  return { secret: null, reEncrypt: false }
}
