import type { Track } from '@shared/protocol'
import { useTwilight } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { useSyncExternalStore } from 'react'
import { getPosition, subscribeVisiblePosition } from '../positionStore'
import { qualityLabel } from '@shared/streaming'

const value = (number: number | undefined | null, unit = ''): string => number && Number.isFinite(number) ? `${number}${unit}` : '—'

/**
 * 播放详情：左边是**这一次播放的音源**，右边是**此刻的输出链**。
 *
 * 本地与在线的音源事实完全不同，所以这一块分成两种写法：
 *  - 本地：文件、格式、码率、大小——都能从曲库里读到；
 *  - 在线：平台、曲目、请求档位、**引擎解码后实测的采样率/位深**。
 *    平台声称的「Hi-Res」不可核对，所以只显示请求值 + 引擎的实测值两行，
 *    用户自己就能看出这一次实际拿到的是什么。
 */
export default function PlaybackDetails({ track }: { track?: Track }) {
  const position = useSyncExternalStore(subscribeVisiblePosition, getPosition, getPosition)
  const output = useTwilight(useShallow(s => ({ rate: s.sampleRate, sourceRate: s.sourceSampleRate, sourceDepth: s.bitDepth, container: s.containerBits, valid: s.validBits, channels: s.channels,
    mode: s.outputMode, name: s.deviceName, period: s.periodMs, resampled: s.resampled,
    bitPerfect: s.bitPerfect, xrun: s.xrunCount, dsp: s.dsp, modules: s.dspModules, connected: s.engineUp, state: s.playState, active: s.dspActive, volume: s.volume })))
  const online = useTwilight(s => s.onlineTrack)
  const requestedOutputRate = useTwilight(s => s.requestedOutputRate)
  const file = track?.path.split(/[\\/]/).pop() || '—'
  const onlinePlatform = online ? (online.platform === 'qq' ? 'QQ 音乐' : online.platform === 'netease' ? '网易云音乐' : '通用源') : ''
  return <div className="playback-details" aria-label="歌曲与实时播放参数">
    {online ? <div><h3>在线音源</h3><dl>
      <dt>平台</dt><dd>{onlinePlatform}</dd>
      <dt>曲目</dt><dd title={online.title + ' — ' + online.artist}>{online.title}{online.artist ? ' — ' + online.artist : ''}</dd>
      <dt>专辑</dt><dd>{online.album || '—'}</dd>
      <dt>请求音质</dt><dd>{qualityLabel(online.platform, online.quality ?? undefined) || '平台默认'}</dd>
      <dt>实测解码</dt><dd>{value(output.sourceRate ? output.sourceRate / 1000 : null, ' kHz')} · {value(output.sourceDepth, ' bit')}</dd>
      <dt>时长</dt><dd data-testid="detail-duration">{((position.durationMs || online.durationMs) / 1000).toFixed(2)} s</dd>
    </dl></div> : <div><h3>音源文件</h3><dl>
      <dt>文件</dt><dd title={track?.path}>{file}</dd>
      <dt>专辑</dt><dd>{track?.album || '—'}</dd>
      <dt>格式</dt><dd>{track?.codec?.toUpperCase() || '—'} · {value(track?.bitDepth, ' bit')} · {value(track?.channels, ' ch')}</dd>
      <dt>采样率</dt><dd>{track?.sampleRate ? `${track.sampleRate / 1000} kHz` : '—'}</dd>
      <dt>码率 / 大小</dt><dd>{value(track?.bitrate, ' kb/s')} · {track?.sizeBytes ? `${(track.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '—'}</dd>
      <dt>年份 / 风格</dt><dd>{value(track?.year)} · {track?.genre || '—'}</dd>
    </dl></div>}
    <div><h3>当前输出 <span className="detail-state">{!output.connected ? '连接已断开' : output.state === 'playing' ? '正在播放' : output.state === 'loading' ? '正在打开' : output.state === 'no-track' ? '未在播放' : '已暂停'}</span></h3><dl>
      <dt>播放位置</dt><dd data-testid="detail-position">{(position.positionMs / 1000).toFixed(2)} / {((position.durationMs || track?.durationMs || 0) / 1000).toFixed(2)} s</dd>
      <dt>设备</dt><dd title={output.name || undefined}>{output.name || '—'}</dd>
      <dt>模式</dt><dd>{output.mode === 'exclusive' ? '独占' : output.mode === 'shared' ? '共享' : '未连接'} · {output.bitPerfect === null ? 'BP 未知' : output.bitPerfect ? 'Bit-perfect' : 'BP 否'}</dd>
      <dt>请求规格</dt><dd>{requestedOutputRate > 0 ? `${requestedOutputRate / 1000} kHz` : '跟随源'}{requestedOutputRate > 0 && output.rate && output.rate !== requestedOutputRate ? ' · 未被采纳' : ''}</dd>
      <dt>输出格式</dt><dd>{output.rate ? `${output.rate / 1000} kHz` : '—'} · {value(output.channels, ' ch')}</dd>
      <dt>容器/有效位</dt><dd>{value(output.container)} / {value(output.valid)} bit</dd>
      <dt>处理</dt><dd>{output.resampled ? '已重采样' : output.resampled === false ? '原采样率' : '未知'} · {output.modules?.length ? output.modules.join(' / ') : output.active === false ? 'DSP 直通' : 'DSP 未知'}</dd>
      <dt>增益 / 周期</dt><dd title="设备调度周期，不是总播放延迟">{output.dsp ? `${output.dsp.appliedGainDb.toFixed(1)} dB` : '—'} · {output.period ? `${output.period.toFixed(1)} ms` : '—'}</dd>
      <dt>欠载</dt><dd>{output.xrun ?? '—'}</dd>
      <dt>输出音量</dt><dd>{Math.round(output.volume * 100)}%</dd>
    </dl></div>
  </div>
}
