/**
 * 平台列表的界面侧投影。
 *
 * 这里**不再**维护第二份平台清单：能力和登录方式都来自 @shared/streaming 的
 * PLATFORM_SPECS，否则界面上写着"支持"、实现里却没有，是这类功能最常见的谎言。
 * status 也不再是写死的 'planned' —— 它由主进程回报的服务端状态决定。
 */
import { PLATFORM_SPECS, sessionLabel } from '@shared/streaming'
import type { PlatformId, SessionStatus, StreamingStatus } from '@shared/streaming'

export type StreamingProviderId = PlatformId
export type StreamingSessionStatus = SessionStatus

export { sessionLabel }

export interface StreamingProviderDescriptor {
  id: PlatformId
  name: string
  shortName: string
  note: string
  login: 'qr' | 'cookie' | 'none'
  pkg: string
  status: 'stopped' | 'starting' | 'ready' | 'failed'
}

export function providersFromStatus(status: StreamingStatus | null): StreamingProviderDescriptor[] {
  const runtimeOf = (id: PlatformId) => status?.runtimes.find(item => item.platform === id)?.state ?? 'stopped'
  return PLATFORM_SPECS.map(spec => ({
    id: spec.id,
    name: spec.displayName,
    shortName: spec.id === 'netease' ? '网易云' : spec.id === 'qq' ? 'QQ 音乐' : '通用源',
    note: spec.note,
    login: spec.login,
    pkg: spec.pkg,
    status: runtimeOf(spec.id)
  }))
}
