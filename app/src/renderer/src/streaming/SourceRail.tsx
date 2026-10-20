import { useEffect, useState } from 'react'
import { Cloud, KeyRound, LogOut, Radio, Zap } from 'lucide-react'
import { PLATFORM_SPECS, type PlatformId, type ProviderRuntime, type StreamingStatus } from '@shared/streaming'
import { useStreamingUi, type SourceId } from './streamStore'
import QrLogin from './QrLogin'

/**
 * 左栏的「来源」区（CONTRACT §4）。
 *
 * 一行一个来源：点一下就是切换当前来源（歌曲中心与歌单一栏都会跟着换）。
 * 平台行还带自己的开关与登录入口 —— 因为「没有服务端」和「没登录」是两种完全
 * 不同的中断，混成一个"不可用"会让用户不知道该先做哪件事。
 */
export default function SourceRail({ onPick }: { onPick: (source: SourceId) => void }) {
  const activeSource = useStreamingUi(state => state.activeSource)
  const accounts = useStreamingUi(state => state.accounts)
  const selectSource = useStreamingUi(state => state.selectSource)
  const loadAccount = useStreamingUi(state => state.loadAccount)
  const logoutAccount = useStreamingUi(state => state.logoutAccount)

  const [status, setStatus] = useState<StreamingStatus | null>(null)
  const [qr, setQr] = useState<PlatformId | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try { setStatus(await window.twilight.streamingStatus() as StreamingStatus) } catch { /* 主进程未就绪 */ }
  }

  useEffect(() => {
    void (async () => {
      await refresh()
      for (const spec of PLATFORM_SPECS) {
        if (spec.login !== 'none') void loadAccount(spec.id)
      }
    })()
  }, [loadAccount])

  // 服务端启动中才轮询；稳定后停。
  const starting = status?.runtimes.some(runtime => runtime.state === 'starting') ?? false
  useEffect(() => {
    if (!starting) return
    const timer = setInterval(() => { void refresh() }, 1200)
    return () => clearInterval(timer)
  }, [starting])

  const runtimeOf = (id: PlatformId): ProviderRuntime | undefined => status?.runtimes.find(item => item.platform === id)
  const serverReady = (id: PlatformId): boolean => runtimeOf(id)?.state === 'ready'

  const start = async (id: PlatformId): Promise<void> => {
    setBusy(id)
    try {
      await window.twilight.streamingStart(id)
      await refresh()
    } catch { /* 错误会体现在状态行里 */ }
    finally { setBusy(null) }
  }

  const stop = async (id: PlatformId): Promise<void> => {
    setBusy(id)
    try { await window.twilight.streamingStop(id); await refresh() } finally { setBusy(null) }
  }

  const pick = async (source: SourceId): Promise<void> => {
    selectSource(source)
    onPick(source)
    if (source !== 'local') {
      await refresh()
      if (!serverReady(source)) await start(source)
      await loadAccount(source)
    }
  }

  return (
    <div className="source-rail" aria-label="播放来源">
      <div className="sidebar-section-head"><span className="nav-label">来源</span></div>

      <button className={'source-row' + (activeSource === 'local' ? ' active' : '')}
        onClick={() => void pick('local')} data-source="local">
        <Zap size={14} strokeWidth={1.6} />
        <span className="source-name">本地曲库</span>
        <span className="source-state" data-state="ready">就绪</span>
      </button>

      {PLATFORM_SPECS.map(spec => {
        const runtime = runtimeOf(spec.id)
        const account = accounts[spec.id]
        const state = runtime?.state ?? 'stopped'
        return (
          <div key={spec.id} className={'source-row-wrap' + (activeSource === spec.id ? ' active' : '')} data-source={spec.id} data-state={state}>
            <button className="source-row" onClick={() => void pick(spec.id)}>
              {spec.id === 'meting' ? <Cloud size={14} strokeWidth={1.6} /> : <Radio size={14} strokeWidth={1.6} />}
              <span className="source-name">{spec.id === 'meting' ? '通用源' : spec.displayName}</span>
              <span className="source-state" data-state={state}>
                {busy === spec.id ? '…' : state === 'ready'
                  ? (account?.signedIn ? (account.nickname ?? '已登录') : spec.login === 'none' ? '就绪' : '未登录')
                  : state === 'starting' ? '启动中' : state === 'failed' ? '启动失败' : '未启动'}
              </span>
            </button>
            <div className="source-actions">
              {spec.login !== 'none' && serverReady(spec.id) && !account?.signedIn
                ? <button className="source-mini" title="扫码登录" onClick={() => setQr(spec.id)}><KeyRound size={12} />登录</button>
                : null}
              {spec.login !== 'none' && account?.signedIn
                ? <button className="source-mini" title="退出登录" onClick={() => void logoutAccount(spec.id)}><LogOut size={12} />退出</button>
                : null}
              {state === 'ready'
                ? <button className="source-mini" title="停止服务端" disabled={busy !== null} onClick={() => void stop(spec.id)}>停止</button>
                : <button className="source-mini" title="启动服务端" disabled={busy !== null} onClick={() => void start(spec.id)}>启动</button>}
            </div>
            {runtime?.error ? <p className="source-error" title={runtime.error}>{runtime.error}</p> : null}
          </div>
        )
      })}

      {qr ? <QrLogin platform={qr} title={PLATFORM_SPECS.find(spec => spec.id === qr)?.displayName ?? ''}
        onClose={() => setQr(null)} onSignedIn={() => void loadAccount(qr)} /> : null}
    </div>
  )
}
