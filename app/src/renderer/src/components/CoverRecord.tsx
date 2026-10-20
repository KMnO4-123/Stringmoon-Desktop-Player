import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Disc3, ImagePlus, Undo2 } from 'lucide-react'
import { useState } from 'react'
import type { ArtworkResult } from '@shared/artwork'
import RecordStage from './RecordStage'
import { settle } from '../motionPresets'

export default function CoverRecord({ trackKey, title, artist, playing, artwork, onChooseArtwork, onRemoveArtwork, compact = false }: {
  trackKey: string; title: string; artist: string; playing: boolean; artwork: ArtworkResult | null; onChooseArtwork?: () => void; onRemoveArtwork?: () => void; compact?: boolean
}) {
  const reduced = useReducedMotion()
  const [failed, setFailed] = useState<string | null>(null)
  const image = artwork && failed !== artwork.dataUrl ? artwork : null
  return <div className={'cover-record' + (compact ? ' cover-record--compact' : '')} aria-label={`${title} 的封面和唱片`}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={trackKey} data-track-id={trackKey} className="cover-record-set"
        initial={reduced ? false : { opacity: 0, x: 32, rotateY: -12, scale: 0.94 }}
        animate={{ opacity: 1, x: 0, rotateY: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, x: -32, rotateY: 12, scale: 0.94 }}
        transition={settle}>
        <div className="cover-record-disc"><RecordStage title={title} artist={artist} playing={playing} compact={compact} /></div>
        <div className="track-cover">
          {image ? <img src={image.dataUrl} alt={`${title} 的${image.source === 'embedded' ? '嵌入' : '本地'}封面`} onError={() => setFailed(image.dataUrl)} /> : <div className="track-cover-fallback" role="img" aria-label={`${title} 的曲目字形封面`}><span className="cover-kicker">STRINGMOON · LOCAL</span><Disc3 aria-hidden size={20} strokeWidth={1} /><strong>{title}</strong><span>{artist || '本地音乐'}</span><small>曲目视觉</small></div>}
          <div className="cover-actions">
            <button className="cover-edit" aria-label="设置歌曲封面" title="选择本地封面图片" disabled={!onChooseArtwork} onClick={onChooseArtwork}><ImagePlus size={16} /><span>{image ? '更换封面' : '添加封面'}</span></button>
            {/* 只在「用户自己选过图」时提供撤销：嵌入图和同名图不是用户加的，没有可撤销的东西。 */}
            {image && image.source === 'custom' && onRemoveArtwork ? <button className="cover-edit cover-clear" aria-label="移除自定义封面" title="移除自定义封面，回到自动读取" onClick={onRemoveArtwork}><Undo2 size={16} /><span>移除封面</span></button> : null}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  </div>
}
