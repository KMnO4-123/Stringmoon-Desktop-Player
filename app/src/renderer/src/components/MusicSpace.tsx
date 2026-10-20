import { useState } from 'react'
import { AudioLines, ChevronDown, Expand, PanelRightClose, PanelRightOpen, Pause, Play, SlidersHorizontal } from 'lucide-react'
import { libraryPathKey } from '@shared/library'
import { selectLoadedTrack, useTwilight } from '../store'
import { displayTrack } from '../display'
import { applyTrackOverride } from '../libraryModel'
import { useLibraryData } from '../libraryDataStore'
import { engineRequest, openAndPlay } from '../ipc'
import CoverRecord from './CoverRecord'
import type { ArtworkResult } from '@shared/artwork'
import LyricsView from './LyricsView'
import ListeningRail from './ListeningRail'
import FrequencyPanel from '../audio/FrequencyPanel'
import SpectrumPanel from '../audio/SpectrumPanel'
import SpectrumGlow from '../audio/SpectrumGlow'
import { qualityLabel } from '@shared/streaming'

export default function MusicSpace({ artwork, onChooseArtwork, onRemoveArtwork, onLibrary, onSound, onImmersive, onChooseFolder, immersive = false }: {
  artwork: ArtworkResult | null; onChooseArtwork?: () => void; onRemoveArtwork?: () => void; onLibrary: (artist?: string) => void; onSound: () => void; onImmersive: () => void; onChooseFolder: () => void; immersive?: boolean
}) {
  const tracks = useTwilight(s => s.tracks)
  const overrides = useLibraryData(s => s.overrides)
  const id = useTwilight(s => s.loadedTrackId)
  /** 在线曲目：引擎侧 trackId 为空，播放控制仍然走引擎，展示元数据来自 store。 */
  const online = useTwilight(s => s.onlineTrack)
  const sourceRate = useTwilight(s => s.sourceSampleRate ?? s.sampleRate)
  const sourceDepth = useTwilight(s => s.bitDepth)
  const playing = useTwilight(s => s.playState === 'playing')
  const busy = useTwilight(s => s.playState === 'loading')
  const [railOpen, setRailOpen] = useState(true)
  const [glow, setGlow] = useState(() => { try { return localStorage.getItem('stringmoon.spectrum-glow') !== 'off' } catch { return true } })
  const rawTrack = useTwilight(selectLoadedTrack) ?? tracks[0]
  const track = rawTrack ? applyTrackOverride(rawTrack, overrides) : null
  const corrected = Boolean(track && overrides[libraryPathKey(track.path)] && Object.keys(overrides[libraryPathKey(track.path)]!).length)
  const display = track ? displayTrack(track) : { title: '你的音乐', artist: '' }
  const toggle = (): void => {
    // 在线曲目也由引擎播放/暂停：它只是没有曲库条目，不是没有播放会话。
    if (id || online) void engineRequest({ cmd: playing ? 'pause' : 'play' }).catch(error => useTwilight.getState().setProtocolError(String(error.message)))
    else if (track) void openAndPlay(track.trackId)
    else onChooseFolder()
  }
  const onlineSource = online ? (online.platform === 'qq' ? 'QQ 音乐' : online.platform === 'netease' ? '网易云音乐' : '通用源') : ''
  const onlineQuality = online ? qualityLabel(online.platform, online.quality ?? undefined) : ''
  return <section className={'music-space' + (immersive ? ' immersive-player' : '')} data-rail={railOpen && !immersive ? 'open' : 'closed'} aria-label={immersive ? '沉浸播放' : '音乐空间'}>
    <header className="space-heading">
      <div className="space-identity">{immersive ? <button className="quiet-button" onClick={onImmersive}><ChevronDown size={17} />返回音乐空间</button> : <><span className="section-eyebrow">STRINGMOON / LISTENING ROOM</span><h1>音乐空间</h1></>}</div>
      <div className="space-tools">
        <button className="quiet-button" onClick={onSound} title="均衡器、声道、输出与解码"><SlidersHorizontal size={16} /><span>音频</span></button>
        {immersive ? <button className="quiet-button" aria-label="频谱光效" aria-pressed={glow} title="真实音频频谱 · 无数据时不绘制" onClick={() => { setGlow(!glow); try { localStorage.setItem('stringmoon.spectrum-glow', glow ? 'off' : 'on') } catch { /* Session preference. */ } }}><AudioLines size={16} /><span>频谱光效</span></button> : <>
          <button className="quiet-button" aria-label="收放音乐探索" aria-expanded={railOpen} aria-controls="listening-rail" onClick={() => setRailOpen(!railOpen)}>{railOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}<span>探索</span></button>
          <button className="quiet-button" onClick={onImmersive} title="沉浸播放 · F"><Expand size={16} /><span>沉浸播放</span></button>
        </>}
      </div>
    </header>
    <div className="listening-layout">
      <section className="listening-stage" aria-label="唱片与当前曲目">
        <div className="listening-media">
          <div className="record-space"><CoverRecord trackKey={track?.trackId ?? 'empty'} title={display.title} artist={display.artist || '本地音乐'} playing={playing} artwork={artwork} onChooseArtwork={onChooseArtwork} onRemoveArtwork={onRemoveArtwork} /></div>
          <div className="track-card">
            <span className="listening-state"><span className={playing ? 'state-pin playing' : 'state-pin'} />{busy ? '正在打开' : (id || online) ? playing ? '正在播放' : '暂停' : '待播放'}<span className="track-source mono">{online ? onlineSource : 'LOCAL AUDIO'}</span></span>
            <h2 className="track-hero-title info-title" title={display.title}>{display.title}</h2>
            <button className="track-hero-artist artist-link" disabled={!display.artist} onClick={() => onLibrary(display.artist)} title={display.artist || '本地曲库'}>{display.artist || '本地曲库'}</button>
            {track?.album ? <p className="track-hero-album" title={track.album}>{track.album}{track.year ? ` · ${track.year}` : ''}</p> : null}
            {/* 在线曲目的采样率/位深**只能**来自引擎解码后的上报：平台声称的档位不可核对。 */}
            <div className="track-facts mono">{online ? <><span className="format-badge">{onlineQuality || 'STREAM'}</span>{sourceRate ? <span>{sourceRate / 1000} kHz</span> : null}{sourceDepth ? <span>{sourceDepth} bit</span> : null}</> : <>{track?.codec ? <span className="format-badge">{track.codec.toUpperCase()}</span> : null}{track?.sampleRate ? <span>{track.sampleRate / 1000} kHz</span> : null}{track?.bitDepth ? <span>{track.bitDepth} bit</span> : null}</>}{corrected ? <span className="metadata-applied" title="应用内元数据修正">应用修正</span> : null}</div>
            <div className="listening-actions"><button className="primary-play" onClick={toggle} disabled={busy}><span>{playing ? <Pause size={17} /> : <Play size={17} />}</span>{playing ? '暂停' : '播放'}</button><span className="listening-hint">空格 播放 · ← → 跳转</span></div>
          </div>
          {!immersive ? <div className="listening-eq"><FrequencyPanel compact onExpand={onSound} /></div> : null}
        </div>
        <div className="listening-copy">
          <div className={immersive ? 'home-lyrics immersive-lyrics' : 'home-lyrics'}><LyricsView /></div>
          {!immersive ? <div className="listening-monitor"><SpectrumPanel /></div> : null}
        </div>
      </section>
      {/* 沉浸模式没有这个栏位：不再挂载一棵永远不可见的子树（返回音乐空间时重挂即可）。 */}
      {!immersive ? <div className="rail-slot" hidden={!railOpen}><ListeningRail onLibrary={onLibrary} onChooseFolder={onChooseFolder} /></div> : null}
    </div>
    <SpectrumGlow active={immersive && glow} playing={playing} />
  </section>
}