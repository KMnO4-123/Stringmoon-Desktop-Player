import { useMemo } from 'react'
import { ArrowRight, FolderPlus, HardDrive, Radio } from 'lucide-react'
import { useTwilight } from '../store'
import { groupArtists } from '../libraryModel'
import { applyTrackOverride } from '../libraryModel'
import { useLibraryData } from '../libraryDataStore'
import ArtistArtwork from './ArtistArtwork'
import LibraryList from './LibraryList'

export default function ListeningRail({ onLibrary, onChooseFolder }: { onLibrary: (artist?: string) => void; onChooseFolder: () => void }) {
  const tracks = useTwilight(s => s.tracks)
  const overrides = useLibraryData(s => s.overrides)
  const groups = useMemo(() => groupArtists(tracks.map(track => applyTrackOverride(track, overrides))), [tracks, overrides])
  return <aside className="listening-rail" id="listening-rail" aria-label="音乐探索">
    <details className="source-controls">
      <summary><HardDrive size={15} /><span>本地音乐</span><span className="source-state">播放来源</span></summary>
      <div className="source-menu" role="group" aria-label="播放来源">
        <div className="source-current"><HardDrive size={15} /><span>本地曲库</span><span>已启用</span></div>
        <button onClick={onChooseFolder}><FolderPlus size={15} />添加音乐文件夹</button>
        <div className="source-unavailable"><Radio size={15} /><span>网易云音乐</span><span>未接入</span></div>
        <div className="source-unavailable"><Radio size={15} /><span>QQ 音乐</span><span>未接入</span></div>
        <p>在线音乐服务接入后，可在这里切换来源。</p>
      </div>
    </details>
    <section className="artist-section"><div className="section-heading"><h2>艺术家</h2><button className="text-action" aria-label="浏览全部艺术家" onClick={() => onLibrary()}><ArrowRight size={15} /></button></div>
      <div className="artist-shelf">{groups.slice(0, 2).map((group, index) => <ArtistArtwork key={group.artist} group={group} index={index} onSelect={onLibrary} />)}</div>
      {!groups.length ? <p className="rail-empty">添加音乐，发现你的艺术家。</p> : null}
    </section>
    <section className="quick-list"><div className="section-heading"><h2>歌曲速览</h2><button className="text-action" aria-label="全部歌曲" onClick={() => onLibrary()}><ArrowRight size={15} /></button></div><LibraryList compact onChooseFolder={onChooseFolder} /></section>
    <span className="rail-caption mono">{tracks.length} 首音乐 · {groups.length} 位艺术家</span>
  </aside>
}
