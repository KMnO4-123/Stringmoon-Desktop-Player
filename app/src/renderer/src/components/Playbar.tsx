import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { selectLoadedTrack, useTwilight, selectSignalSnapshot, type OutputPreference } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { engineRequest, seekTo } from '../ipc'
import { getPosition, setPosition, subscribeVisiblePosition } from '../positionStore'
import { displayTrack } from '../display'
import { applyTrackOverride } from '../libraryModel'
import { useLibraryData } from '../libraryDataStore'
import C2PathView from '../c2/C2PathView'
import type { EngineRequestCommand, RepeatMode } from '@shared/protocol'
import { AudioLines, Disc3, Ellipsis, Expand, Info, ListMusic, Minimize, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Square, Volume2, VolumeX } from 'lucide-react'
import { glassInteraction } from '../glassInteraction'
import PlaybackDetails from './PlaybackDetails'
import QueuePanel from './QueuePanel'
import type { ArtworkResult } from '@shared/artwork'
import { PLATFORM_SPECS, qualityLabel } from '@shared/streaming'

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

/**
 * 循环模式是一个**四态枚举**（引擎 player.hpp:36），不是「循环开关 + 随机开关」两个独立布尔：
 * 随机在引擎里取代循环，而不是叠加。所以界面也是一个按钮循环四态，
 * 顺序 → 列表 → 单曲 → 随机 → 顺序，用图标与文案如实标出当前是哪一态。
 */
const REPEAT_ORDER: readonly RepeatMode[] = ['sequential', 'all', 'one', 'shuffle']
const REPEAT_LABEL: Record<RepeatMode, string> = {
  sequential: '顺序播放',
  all: '列表循环',
  one: '单曲循环',
  shuffle: '随机播放'
}
const OUTPUT_LABEL: Record<OutputPreference, string> = { auto: '自动', exclusive: '独占', shared: '共享' }

/**
 * 播放栏：六控制命令 + 音量 + 水滴进度条。
 * - 进度走 positionStore 局部订阅（E1.3：播放进度不推动全局重渲染）；
 * - 拖拽期间本地预览（写入 positionStore 供其他视图即时跟随），松手 seekTo；
 * - loading（intent 在途）呼吸缩略图；seekPending 亮播放头。
 */
function Playbar({ artwork, onImmersive, immersive = false }: { artwork: ArtworkResult | null; onImmersive?: () => void; immersive?: boolean }) {
  const playState = useTwilight((s) => s.playState)
  // 在线曲目的展示元数据不在引擎里（URL 源的 trackId 是空串），所以播放栏要单独读它。
  const online = useTwilight((s) => s.onlineTrack)
  const seekPending = useTwilight((s) => s.seekPending)
  const durationMs = useTwilight((s) => s.durationMs)
  const volume = useTwilight((s) => s.volume)
  const setVolumeLocal = useTwilight((s) => s.setVolumeLocal)
  const muted = useTwilight((s) => s.muted)
  const setMutedLocal = useTwilight((s) => s.setMutedLocal)
  const repeatMode = useTwilight((s) => s.repeatMode)
  const setRepeatModeLocal = useTwilight((s) => s.setRepeatModeLocal)
  const outputPreference = useTwilight((s) => s.outputPreference)
  const setOutputPreference = useTwilight((s) => s.setOutputPreference)
  const requestedOutputRate = useTwilight((s) => s.requestedOutputRate)
  const setOutputRateLocal = useTwilight((s) => s.setOutputRateLocal)
  const signal = useTwilight(useShallow(selectSignalSnapshot))
  const tracks = useTwilight((s) => s.tracks)
  const overrides = useLibraryData((s) => s.overrides)
  const queueCapable = useTwilight((s) => s.queueCapable)
  const queueIds = useTwilight((s) => s.queueIds)

  // 高频进度：useSyncExternalStore + 局部快照（不含任何全局 store 字段）。
  // 用「可见才订阅」的版本：窗口隐藏时 position 事件仍会到渲染层（主进程负责转发），
  // 但隐藏的播放栏不需要每 50ms 重渲染一次——恢复可见时重读最新快照即可。
  const position = useSyncExternalStore(subscribeVisiblePosition, getPosition, getPosition)

  const [dragMs, setDragMs] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const signalRef = useRef<HTMLDivElement>(null)
  const [openPanel, setOpenPanel] = useState<'signal' | 'details' | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  useEffect(() => {
    if (!openPanel) return
    const close = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && !signalRef.current?.contains(event.target)) setOpenPanel(null)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpenPanel(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape, true) }
  }, [openPanel])

  // PlaybackDetails 用 undefined 表示「没有曲目」，这里做一次显式转换。
  const rawLoadedTrack = useTwilight(selectLoadedTrack)
  const loadedTrack = rawLoadedTrack ? applyTrackOverride(rawLoadedTrack, overrides) : undefined
  const track = loadedTrack ? { ...loadedTrack, ...displayTrack(loadedTrack) } : undefined
  const dur = Math.max(1, position.durationMs || durationMs)
  const shown = dragMs ?? position.positionMs
  const ratio = Math.min(1, Math.max(0, shown / dur))

  const ratioFromEvent = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (playState === 'no-track' || playState === 'loading') return
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    setDragMs(Math.round(ratioFromEvent(e.clientX) * dur))
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    setDragMs(Math.round(ratioFromEvent(e.clientX) * dur))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const ms = Math.round(ratioFromEvent(e.clientX) * dur)
    setDragMs(null)
    setPosition({ positionMs: ms }) // 拖拽预览的最终落点立即生效，等引擎 position 对齐
    void seekTo(ms)
  }

  /**
   * 乐观设置 + 失败回滚。离散控件（静音/循环/输出模式）失败时必须退回去并说出来 ——
   * 一个静默失败的开关就是一句假话。音量拖拽例外（见 onVolume）：高频、且失败自明。
   */
  const command = (cmd: EngineRequestCommand, revert?: () => void): void => {
    void engineRequest(cmd).catch(error => {
      revert?.()
      useTwilight.getState().setProtocolError(error instanceof Error ? error.message : String(error))
    })
  }
  const send = (cmd: EngineRequestCommand): void => command(cmd)

  const onVolume = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value)
    setVolumeLocal(v)
    // 静音状态下拖音量 = 显然想要听见声音 → 顺手取消静音。
    // 两者在引擎里是独立的（静音不改音量），所以这是一步显式命令，不是隐含副作用。
    if (muted) { setMutedLocal(false); command({ cmd: 'set_muted', muted: false }, () => setMutedLocal(true)) }
    // 音量拖拽不弹协议错误：高频控件，且失败与「引擎没在放」难以区分（保持既有行为）。
    void engineRequest({ cmd: 'set_volume', volume: v }).catch(() => {})
  }
  /** 静音走引擎原生的 set_muted：音量**不变**（app.cpp:513 专门纠正把它当成音量归零的客户端）。 */
  const toggleMute = (): void => {
    const next = !muted
    setMutedLocal(next)
    command({ cmd: 'set_muted', muted: next }, () => setMutedLocal(!next))
  }
  const cycleRepeat = (): void => {
    const next = REPEAT_ORDER[(REPEAT_ORDER.indexOf(repeatMode) + 1) % REPEAT_ORDER.length]!
    const previous = repeatMode
    setRepeatModeLocal(next)
    command({ cmd: 'set_repeat', mode: next }, () => setRepeatModeLocal(previous))
  }
  const chooseOutput = (mode: OutputPreference): void => {
    const previous = outputPreference
    setOutputPreference(mode)
    // 同时带上当前请求的输出率：set_output 是一次完整重开，不带着它等于顺手把
    // 用户选的规格清回「跟随源」。
    command({ cmd: 'set_output', mode, sampleRate: requestedOutputRate }, () => setOutputPreference(previous))
  }

  /**
   * 输出规格：跟随源 / 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz。
   *
   * 这些档位不是装饰：引擎会把流按请求的采样率重开（独占可行时），这时重采样器
   * 进入链路，bit-perfect 如实变 false 并写明 resampled。共享模式下 WASAPI
   * 只能跑设备混音格式，请求不会被采纳 —— 所以下面同时显示「请求」与「实际」。
   */
  // v6：补到 384k 家族。352.8k 只对 44.1k 家族有意义、384k 只对 48k 家族有意义，
  // 但两个都列出来：选择器是「请求」，能不能被采纳由引擎/端点决定并如实回读。
  const OUTPUT_RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000] as const
  const chooseRate = (rate: number): void => {
    const previous = requestedOutputRate
    setOutputRateLocal(rate)
    void engineRequest({ cmd: 'set_output', mode: outputPreference, sampleRate: rate }).catch(error => {
      setOutputRateLocal(previous)
      useTwilight.getState().setProtocolError(error instanceof Error ? error.message : String(error))
    })
  }

  const hasTrack = playState !== 'no-track' || online !== null
  // 平台名只有一个来源（PLATFORM_SPECS），不在各个组件里各写一遍中文。
  const onlinePlatform = online ? (PLATFORM_SPECS.find(spec => spec.id === online.platform)?.displayName ?? online.platform) : ''
  const onlineQuality = online ? qualityLabel(online.platform, online.quality ?? undefined) : ''
  /**
   * 上一首/下一首只对**引擎队列**有意义。在线曲目是一次性的 URL 源，不在队列里：
   * 按钮仍可点会让引擎报 "the queue is empty"，所以这里明说为什么不可用，
   * 而不是给一个点了没反应的按钮。
   */
  const queueNavigable = hasTrack && playState !== 'loading' && queueCapable !== false && online === null

  const playBtn =
    playState === 'loading' ? <Ellipsis strokeWidth={1.5} /> : playState === 'playing' ? <Pause strokeWidth={1.5} /> : <Play strokeWidth={1.5} />

  return (
    <footer className={'playbar' + (playState === 'loading' ? ' loading' : '') + (playState === 'playing' ? ' has-playing' : '')}>
      <div className="pb-left">
        <div className="pb-thumb" aria-hidden>{artwork ? <img src={artwork.dataUrl} alt="" /> : <Disc3 strokeWidth={1.5} />}</div>
        <div className="pb-meta">
          <div className="pb-title">{track ? track.title : '未在播放'}</div>
          <div className="pb-artist">
            {playState === 'loading'
              ? '正在打开…'
              : track
                ? [track.artist, onlinePlatform, onlineQuality].filter(Boolean).join(' · ') || '—'
                : '—'}
          </div>
        </div>
      </div>

      <div className="pb-center">
        <div className="pb-controls glass-surface" {...glassInteraction}>
          <button className="pb-btn" aria-label="上一首" title={online ? '在线单曲没有队列，无法上一首' : '上一首'} disabled={!queueNavigable} onClick={() => send({ cmd: 'prev' })}><SkipBack strokeWidth={1.5} /></button>
          <button
            className="pb-btn play"
            aria-label={playState === 'loading' ? '正在打开' : playState === 'playing' ? '暂停' : '播放'}
            title={playState === 'playing' ? '暂停 · 空格' : '播放 · 空格'}
            disabled={!hasTrack || playState === 'loading'}
            onClick={() => send(playState === 'playing' ? { cmd: 'pause' } : { cmd: 'play' })}
          >
            {playBtn}
          </button>
          <button className="pb-btn" aria-label="停止" title="停止" disabled={!hasTrack} onClick={() => send({ cmd: 'stop' })}><Square strokeWidth={1.5} /></button>
          <button className="pb-btn" aria-label="下一首" title={online ? '在线单曲没有队列，无法下一首' : '下一首'} disabled={!queueNavigable} onClick={() => send({ cmd: 'next' })}><SkipForward strokeWidth={1.5} /></button>
          <button
            className={'pb-btn repeat' + (repeatMode === 'sequential' ? '' : ' active')}
            aria-label={'循环模式：' + REPEAT_LABEL[repeatMode] + '，点击切换'}
            title={'循环模式：' + REPEAT_LABEL[repeatMode] + ' · 点击切换'}
            onClick={cycleRepeat}
          >
            {repeatMode === 'one' ? <Repeat1 strokeWidth={1.5} /> : repeatMode === 'shuffle' ? <Shuffle strokeWidth={1.5} /> : <Repeat strokeWidth={1.5} />}
          </button>
        </div>
        <div className={'progress' + (dragMs !== null ? ' dragging' : '') + (seekPending ? ' seeking' : '')}>
          <span className="progress-time cur mono">{fmt(shown)}</span>
          <div
            className="progress-track"
            role="slider"
            tabIndex={hasTrack ? 0 : -1}
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={dur}
            aria-valuenow={Math.max(0, Math.min(dur, shown))}
            aria-valuetext={fmt(shown)}
            onKeyDown={event => {
              if (!hasTrack || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault(); event.stopPropagation()
              const target = event.key === 'Home' ? 0 : event.key === 'End' ? dur : Math.max(0, Math.min(dur, shown + (event.key === 'ArrowRight' ? 5000 : -5000)))
              void seekTo(target)
            }}
            ref={trackRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { draggingRef.current = false; setDragMs(null) }}
          >
            <div className="progress-fill" style={{ width: (ratio * 100).toFixed(2) + '%' }} />
            <div className="progress-head" style={{ left: (ratio * 100).toFixed(2) + '%' }} />
          </div>
          <span className="progress-time total mono">{fmt(dur)}</span>
        </div>
      </div>

      <div className="pb-right">
        <button className="signal-button queue-button" aria-label="播放队列" title="播放队列" aria-expanded={queueOpen}
          onClick={() => setQueueOpen(true)}><ListMusic size={16} strokeWidth={1.5} /><span className="mono">{queueIds.length}</span></button>
        <div className="signal-control" ref={signalRef}>
          <button className={'signal-button' + (signal.degradeReason ? ' warn' : '')} aria-label="信号路径" aria-expanded={openPanel === 'signal'} onClick={() => setOpenPanel(value => value === 'signal' ? null : 'signal')}><AudioLines size={16} strokeWidth={1.5} /><span className="mono">{signal.bitPerfect ? 'BP' : signal.sampleRate ? signal.sampleRate / 1000 + 'k' : '—'}</span></button>
          <button className="signal-button detail-trigger" aria-label="播放详情" title="歌曲与实时输出参数" aria-expanded={openPanel === 'details'} onClick={() => setOpenPanel(value => value === 'details' ? null : 'details')}><Info size={16} strokeWidth={1.5} /></button>
          {openPanel ? <div className={'signal-popover' + (openPanel === 'details' ? ' detail-popover' : '')} role="region" aria-label={openPanel === 'signal' ? '音频信号路径' : '歌曲与实时播放参数'}>
            {openPanel === 'signal' ? <>
              <span className="section-eyebrow">信号路径</span>
              <C2PathView snapshot={signal} />
              {/* 偏好是应用请求的，下面是引擎上报的**实际**模式：请求独占而降级成共享时，
                  两个都要看得见，否则界面等于替引擎宣称了一件没发生的事（CONTRACT §3.4）。 */}
              <div className="output-mode" role="group" aria-label="输出模式偏好">
                <span className="section-eyebrow">输出模式</span>
                <div className="segmented-control">
                  {(Object.keys(OUTPUT_LABEL) as OutputPreference[]).map(mode =>
                    <button key={mode} aria-pressed={outputPreference === mode} onClick={() => chooseOutput(mode)}>{OUTPUT_LABEL[mode]}</button>)}
                </div>
              </div>
              {/* 请求值 vs 实际值：共享模式下 WASAPI 只能跑设备混音格式，
                  请求 192k 而流仍是 48k 是**硬件/API 的事实**，不是失败，但必须看得见。 */}
              <div className="output-rate" role="group" aria-label="输出规格">
                <span className="section-eyebrow">输出规格</span>
                <div className="segmented-control rate-control">
                  {OUTPUT_RATES.map(rate => (
                    <button key={rate} aria-pressed={requestedOutputRate === rate} onClick={() => chooseRate(rate)}>
                      {rate === 0 ? '跟随源' : rate / 1000 + 'k'}
                    </button>
                  ))}
                </div>
                <p className="rate-summary mono">
                  {requestedOutputRate === 0 ? '跟随源采样率' : '请求 ' + requestedOutputRate / 1000 + ' kHz'}
                  {signal.sampleRate ? ' · 实际 ' + signal.sampleRate / 1000 + ' kHz' : ''}
                  {requestedOutputRate > 0 && signal.sampleRate && signal.sampleRate !== requestedOutputRate ? ' · 未被采纳' : ''}
                </p>
              </div>
              {/* 这一行说的是**引擎实际**在用的模式，不是用户请求的那个（CONTRACT §3.4）。
                  类名是给断言用的：弹层里现在有第二段 <p>（请求/实际流率），按顺序取会取错。 */}
              <p className="mode-summary">{signal.degradeReason || (signal.outputMode === 'exclusive' ? '当前：独占输出' : signal.outputMode === 'shared' ? '当前：共享输出' : '当前：未装载曲目')}</p>
            </> : <PlaybackDetails track={loadedTrack} />}
          </div> : null}
        </div>
        {/* 静音与音量是两个独立事实：静音时音量条**不动**，只让「正在静音」可见 ——
            把静音做成音量归零会丢掉用户选的音量（引擎正是为此把 muted 与 volume 分开上报）。 */}
        <div className={'volume' + (muted ? ' muted' : '')}>
          <button className="volume-icon" aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} title={muted ? '取消静音' : '静音'} onClick={toggleMute}>{muted ? <VolumeX strokeWidth={1.5} /> : <Volume2 strokeWidth={1.5} />}</button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            style={{ ['--vol-pct' as string]: (volume * 100).toFixed(0) + '%' }}
            onChange={onVolume}
            aria-label="音量"
            aria-valuetext={`${Math.round(volume * 100)}%`}
          />
          <output className="volume-value mono" title={muted ? '正在静音（音量档位不变）' : '音量'}>{Math.round(volume * 100)}%</output>
        </div>
        <button className="pb-btn immersive-toggle" aria-label={immersive ? '退出沉浸播放' : '沉浸播放'} title={immersive ? '退出沉浸播放' : '沉浸播放'} onClick={onImmersive}>{immersive ? <Minimize strokeWidth={1.5} /> : <Expand strokeWidth={1.5} />}</button>
      </div>
      <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
    </footer>
  )
}

// App 会因 scanProgress / 请求计数重渲染；props 都稳定时跳过播放栏整棵渲染。
export default memo(Playbar)
