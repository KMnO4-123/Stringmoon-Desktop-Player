/**
 * 应用版本解析（纯函数，便于单测）。
 *
 * 为什么不能直接用 app.getVersion()：用 `electron <entry>` 启 动（dev / test:electron）时，
 * Electron 返回的是**运行时版本**（如 44.7.2），不是应用 package.json 的 version。
 * 设置页「关于」与 updater.currentVersion 显示 44.7.2 是错的。
 *
 * 规则：app.getVersion() 有值且不等于 process.versions.electron → 用它（打包版即此路径）；
 * 否则回退应用根 package.json 的 version；都拿不到才用 runtime。
 */
export interface AppVersionSources {
  /** 即 app.getVersion()。 */
  getVersion: () => string
  /** 即 process.versions.electron。 */
  electronVersion: string | undefined
  /** 读应用根 package.json 的 version（失败返回 null）。 */
  readPackageVersion: () => string | null
}

export function resolveAppVersion(sources: AppVersionSources): string {
  let runtime = ''
  try {
    runtime = sources.getVersion()
  } catch { /* app.getVersion 理论上不抛；抛了也要能继续走 package.json 回退 */ }
  const trimmed = typeof runtime === 'string' ? runtime.trim() : ''
  if (trimmed && trimmed !== sources.electronVersion) return trimmed
  const packageVersion = sources.readPackageVersion()
  if (typeof packageVersion === 'string' && packageVersion.trim()) return packageVersion.trim()
  return runtime
}
