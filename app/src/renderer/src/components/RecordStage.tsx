import { useEffect, useRef, useState } from 'react'
import { createRecordScene, type RecordSceneController } from './recordScene'

export interface RecordStageProps {
  title: string
  artist: string
  playing: boolean
  compact?: boolean
  className?: string
}

export default function RecordStage({ title, artist, playing, compact = false, className = '' }: RecordStageProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<RecordSceneController | null>(null)
  const initialTrack = useRef({ title, artist, playing })
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    let mounted = true
    const scene = createRecordScene(host, canvas, initialTrack.current, () => {
      if (mounted) setUnavailable(true)
    })
    sceneRef.current = scene
    return () => {
      mounted = false
      sceneRef.current = null
      scene?.destroy()
    }
  }, [])

  useEffect(() => {
    sceneRef.current?.update({ title, artist, playing })
  }, [title, artist, playing])

  const description = `${title || '等待播放'}${artist ? ` · ${artist}` : ''}，黑胶唱片${playing ? '播放中' : '已暂停'}`

  return (
    <div
      ref={hostRef}
      className={`record-stage${compact ? ' record-stage--compact' : ''}${unavailable ? ' record-stage--fallback' : ''} ${className}`.trim()}
      role="img"
      aria-label={description}
    >
      <canvas ref={canvasRef} className="record-stage__canvas" aria-hidden="true" hidden={unavailable} />
      {unavailable && (
        <div className="record-stage__fallback" aria-hidden="true">
          <div className="record-stage__fallback-label">
            <span className="record-stage__fallback-title">{title || '等待播放'}</span>
            <span className="record-stage__fallback-artist">{artist || 'STRINGMOON'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
