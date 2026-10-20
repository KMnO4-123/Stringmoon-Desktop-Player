import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { selectLoadedTrack, useTwilight } from '../store'
import { getPosition, subscribeVisiblePosition } from '../positionStore'
import { anchorPlayhead, playheadMs, resetPlayhead } from '../lyricPlayhead'
import type { Lyrics } from '@shared/protocol'
import { activeLineIndex, wordFill } from '../lyricFill'
import { seekTo } from '../ipc'
import { Check, CloudDownload, CloudOff, Focus, Languages, Link2, ListMusic, Minus, Plus, RotateCcw, Save, TriangleAlert, Type, Unlink2, X } from 'lucide-react'
import { applyLyricsOffset, type LyricCandidateChoice, type LyricsLoadResult, type OnlineLyricsLoadResult, type OnlineLyricsOutcome, type OnlineMatch } from '@shared/lyrics-model'
import { withInterpolatedWords } from '@shared/lyrics-interpolate'
import { parseLrc } from '@shared/lrc'
import { parseYrc } from '@shared/yrc'

/**
 * 歌词视图：数据 = 主进程归一化的 CONTRACT §4.3 Lyrics。
 *
 * 动效分两层，职责分开：
 *  - **React 只画结构**：行、词、罗马音、翻译。它只订阅「哪一行是活性行」这个**粗粒度**结果，
 *    所以每个 position 事件（实测约 9–10 Hz）**不会**重渲染整份歌词。
 *  - **填充由画笔驱动**（lyricPlayhead + ref 直接改 DOM）：按显示刷新率推进，新事件一到即对齐，
 *    于是逐字填充是连续的，而不是每秒 9 格的跳变。
 *
 * 减少动态效果时**不跑补间**（DESIGN-v4：形变→瞬时切换、不插值）：只按权威事件落格，位置依然准确。
 */


/** 在线结果 → 界面状态。取词链路与人工指定共用这一段，避免两处显示逻辑各写一份然后漂移。 */
function onlineResultOf(found: OnlineLyricsLoadResult, key: string) {
  const display = withInterpolatedWords(applyLyricsOffset(found.lyrics, found.offsetMs))
  const provider = found.match.provider === 'amll-ttml' ? 'AMLL 逐字' : found.match.provider === 'netease' ? '网易云' : 'LRCLIB'
  const origin = found.cached ? '缓存' : '在线'
  const kind = display.lyrics.wordByWord ? ' · 词级' : display.interpolated ? ' · 行级·插值' : ' · 行级'
  return {
    key,
    lyrics: display.lyrics,
    label: origin + ' · ' + provider + kind,
    source: 'online' as const,
    attachedUnavailable: false,
    offsetMs: found.offsetMs,
    match: found.match,
    interpolated: display.interpolated
  }
}

/** 非 found 的结局怎么说给用户听。自动查找没命中是常态，只有手动动作才值得一句回答。 */
function noteOfOutcome(outcome: OnlineLyricsOutcome | undefined, manual: boolean): string | null {
  if (!outcome) return null
  if (outcome.status === 'none') return manual ? '在线也没有找到这首歌的歌词' : null
  if (outcome.status === 'instrumental') return '这是一首纯音乐（无人声），没有歌词'
  if (outcome.status === 'blocked') return outcome.message ?? '该平台已停止请求'
  if (outcome.status === 'unavailable') return '在线歌词暂时取不到，可稍后重试'
  return null
}

type Paint = (lyrics: Lyrics | null, index: number) => void

/** 在线取词开关。默认开：没有歌词的歌自己去找；设置里可以关掉，关掉后只有手动按钮联网。 */
function readOnlinePreference(): boolean {
  try { return localStorage.getItem('stringmoon.lyrics-online') !== 'off' } catch { return true }
}

/** 类名只在真的变了才写，避免每帧无谓地触碰 DOM 属性。 */
function wordClass(sung: boolean, current: boolean): string {
  return 'lyric-word' + (sung ? ' sung' : current ? ' current' : '')
}

function LyricsView() {
  const loadedTrackId = useTwilight((s) => s.loadedTrackId)
  const tracks = useTwilight((s) => s.tracks)
  /** 必须订阅它：补间循环的启停取决于播放态，而 effect 只在依赖变化时重跑。 */
  const playState = useTwilight((s) => s.playState)
  const [result, setResult] = useState<{ key: string; lyrics: Lyrics | null; label: string; source: LyricsLoadResult['source'] | 'online'; attachedUnavailable: boolean; offsetMs: number; match?: OnlineMatch; interpolated?: boolean } | null>(null)
  const [onlineBusy, setOnlineBusy] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  /** 候选面板：null = 关着。用户自己挑这一版，而不是让启发式决定。 */
  const [picker, setPicker] = useState<{ loading: boolean; list: LyricCandidateChoice[]; error?: string } | null>(null)
  const [onlineNote, setOnlineNote] = useState<string | null>(null)
  /** 用户点「在线查找」时置位：这一次必须绕过缓存。 */
  const forceOnlineRef = useRef(false)
  /** 默认开启：没有歌词的歌应当自己去找，而不是等用户逐首点。设置里可关。 */
  const onlineEnabled = useRef(readOnlinePreference())
  const [offsetDraft, setOffsetDraft] = useState('0')
  const [sourceRevision, setSourceRevision] = useState(0)
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const lyricsRef = useRef<Lyrics | null>(null)
  /** 已按「整行归位」处理过的行下标；-2 = 尚未画过（首帧要对整段历史负责）。 */
  const paintedRef = useRef(-2)
  const paintRef = useRef<Paint | null>(null)
  const [following, setFollowing] = useState(true)
  const [large, setLarge] = useState(() => { try { return localStorage.getItem('stringmoon.lyrics-large') === 'on' } catch { return false } })
  const [translations, setTranslations] = useState(true)
  const nodesRef = useRef<{ node: HTMLElement; words: HTMLElement[] }[]>([])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // visible 只服务于「补间循环要不要开」这一件事，不再是正确性的前提（订阅不看它了）。
    // 额外的 rect 兜底：观察器在视图过渡里可能报一次 false 就再也不回来，滚动/resize 时补一次真实判断。
    const sync = (): void => setVisible(el.getClientRects().length > 0)
    const observer = new IntersectionObserver(sync)
    observer.observe(el)
    window.addEventListener('resize', sync)
    return () => { observer.disconnect(); window.removeEventListener('resize', sync) }
  }, [])

  const track = useTwilight(selectLoadedTrack)
  const online = useTwilight((s) => s.onlineTrack)
  /** 在线曲目：有元数据、没有本地文件。歌词只能来自平台（或在线库）。 */
  const isOnline = online !== null && !track?.path
  const trackId = track?.trackId
  const trackPath = track?.path
  const trackTitle = isOnline ? online.title : track?.title ?? ''
  const trackArtist = isOnline ? online.artist : track?.artist ?? ''
  const trackAlbum = isOnline ? online.album : track?.album ?? ''
  const trackDurationMs = isOnline ? online.durationMs : track?.durationMs ?? 0
  const trackKey = isOnline ? 'online:' + online.platform + ':' + online.id : JSON.stringify([trackId, trackPath])
  const hasTrack = loadedTrackId !== null || online !== null
  const lyrics = result?.key === trackKey ? result.lyrics : null
  const sourceLabel = result?.key === trackKey ? result.label : ''
  const currentOffset = result?.key === trackKey ? result.offsetMs : 0
  const numericOffset = Number(offsetDraft)
  const offsetDraftValid = Number.isInteger(numericOffset) && numericOffset >= -10000 && numericOffset <= 10000 && numericOffset % 50 === 0
  lyricsRef.current = lyrics

  useEffect(() => { setOffsetDraft(String(currentOffset)) }, [trackKey, currentOffset])

  /**
   * 订阅 position，但只为三件事：重锚播放头、**画一帧**（暂停/拖动时也要落格）、
   * 以及在活性行变化时唤醒 React。useSyncExternalStore 比较返回值，所以 9–10 Hz 的事件里
   * 只有换行那一次真的重渲染。
   */
  const subscribe = useCallback((listener: () => void) => {
    // **不**用 IntersectionObserver 的 visible 来短路订阅：那一份状态会在视图切换的过渡里
    // 因为瞬时零尺寸而锁死为 false，之后再没有事件能把它救回来 —— 表现就是「歌词再也不逐字填充」
    // （e2e 曾经 50% 概率红，根因就在这里，不是测试写错）。
    // 现在每次事件按**真实布局**判断：display:none 的元素没有 client rect，跳过绘制；
    // 可见就照常落格。可见性恢复后的补画由下面的 effect 与下一次 position 事件共同保证。
    return subscribeVisiblePosition(() => {
      if (document.hidden) return
      const container = containerRef.current
      if (!container || container.getClientRects().length === 0) return
      const position = getPosition()
      anchorPlayhead(position.positionMs, useTwilight.getState().playState === 'playing')
      const model = lyricsRef.current
      paintRef.current?.(model, activeLineIndex(model, position.positionMs))
      listener()
    })
  }, [])
  const getActiveIdx = useCallback(() => activeLineIndex(lyricsRef.current, getPosition().positionMs), [])
  const activeIdx = useSyncExternalStore(subscribe, getActiveIdx, getActiveIdx)

  useEffect(() => {
    let cancelled = false
    /**
     * 在线曲目：本地没有任何文件可读，歌词只有一个来源——平台自己的歌词接口。
     *
     * 平台之间能力的差别要如实说：网易云登录后可能带 yrc（逐字）；QQ 只有行级 LRC。
     * 所以这里先试 yrc，再退回 lrc；都没有就说「没有平台歌词」，而不是显示空白装作加载中。
     */
    if (isOnline) {
      setOnlineNote(null)
      void (async () => {
        setOnlineBusy(true)
        try {
          const raw = await window.twilight.streamingLyrics(online.platform, {
            id: online.id, title: online.title, artist: online.artist, album: online.album
          }) as { lrc?: string; translation?: string; wordLevel?: string }
          if (cancelled) return
          const wordLevel = parseYrc(raw?.wordLevel ?? '')
          const parsed = wordLevel ?? parseLrc((raw?.lrc ?? '') + '\n' + (raw?.translation ?? ''))
          const source = online.platform === 'qq' ? 'qq-qrc' : online.platform === 'netease' ? 'netease-lrc' : 'lrclib'
          const lyrics: Lyrics | null = parsed.lines.length > 0
            ? { lines: parsed.lines, wordByWord: parsed.wordByWord, source }
            : null
          const provider = online.platform === 'qq' ? 'QQ 音乐' : online.platform === 'netease' ? '网易云' : '通用源'
          setResult({
            key: trackKey, lyrics, source: 'online', attachedUnavailable: false, offsetMs: 0,
            label: lyrics ? '平台歌词 · ' + provider + (parsed.wordByWord ? ' · 词级' : ' · 行级') : ''
          })
          if (!lyrics) setOnlineNote('这个平台没有这首歌的歌词。')
        } catch (error) {
          if (cancelled) return
          setResult({ key: trackKey, lyrics: null, label: '', source: 'none', attachedUnavailable: false, offsetMs: 0 })
          setOnlineNote(error instanceof Error ? error.message : String(error))
        } finally {
          if (!cancelled) setOnlineBusy(false)
        }
      })()
      return () => { cancelled = true }
    }
    if (!trackId || !trackPath) {
      setResult(null)
      return
    }
    const force = forceOnlineRef.current
    forceOnlineRef.current = false
    setOnlineNote(null)

    const local = (res: LyricsLoadResult | null): boolean => {
      const shifted = res?.lyrics ? applyLyricsOffset(res.lyrics, res.offsetMs) : null
      // 行级数据在这里补出可填充的字级时间（渲染视图，不动 wordByWord —— 契约 §4.3）。
      const view = shifted ? withInterpolatedWords(shifted) : null
      let label = ''
      if (view && res?.resolvedPath) {
        const p = String(res.resolvedPath)
        const name = p.split(/[\\/]/).pop() ?? p
        const kind = res.source === 'attached' ? '已关联 · ' : res.source === 'embedded' ? '内嵌歌词 · ' : '同名歌词 · '
        label = kind + name + (view.lyrics.wordByWord ? ' · 词级' : view.interpolated ? ' · 行级·插值' : ' · 行级')
      }
      setResult({ key: trackKey, lyrics: view?.lyrics ?? null, label, source: res?.source ?? 'none', attachedUnavailable: res?.attachedUnavailable ?? false, offsetMs: res?.offsetMs ?? 0, interpolated: view?.interpolated ?? false })
      return view != null
    }

    /**
     * 本地优先，其次在线（契约 §4.4）。本地命中就**绝不联网** ——
     * 用户放进来的文件是权威，网上的同名歌词只可能在它缺席时才有意义。
     */
    void (async () => {
      let found = false
      try {
        const response = await window.twilight.loadLyrics({ trackId, path: trackPath })
        // 迟到的响应不能覆盖新歌：换曲之后这个 effect 已经作废了。
        // （上一版把这条判断写在 .then 里；改成 await 之后必须在这里重新挡一次。）
        if (cancelled) return
        found = local(response)
      } catch {
        if (!cancelled) setResult({ key: trackKey, lyrics: null, label: '', source: 'none', attachedUnavailable: false, offsetMs: 0 })
      }
      if (cancelled || found || !onlineEnabled.current) return
      setOnlineBusy(true)
      try {
        const outcome = await window.twilight.fetchLyricsOnline(
          { trackId, title: trackTitle, artist: trackArtist, album: trackAlbum, durationMs: trackDurationMs, path: trackPath },
          force
        )
        if (cancelled) return
        if (outcome?.status === 'found' && outcome.result) {
          setResult(onlineResultOf(outcome.result, trackKey))
        } else {
          const note = noteOfOutcome(outcome, force)
          if (note) setOnlineNote(note)
        }
      } catch (error) {
        if (!cancelled) setOnlineNote(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setOnlineBusy(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [trackId, trackPath, trackKey, sourceRevision, trackTitle, trackArtist, trackAlbum, trackDurationMs, isOnline, online?.platform, online?.id])

  const changeSource = async (operation: () => Promise<unknown>): Promise<void> => {
    if (!trackPath || sourceBusy) return
    setSourceBusy(true)
    setSourceError(null)
    try {
      const changed = await operation()
      if (changed !== null) setSourceRevision(value => value + 1)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceBusy(false)
    }
  }

  /** 打开候选面板：只发一次搜索请求，不做任何取词。 */
  const openPicker = async (): Promise<void> => {
    if (!trackPath) return
    setPicker({ loading: true, list: [] })
    try {
      const list = await window.twilight.lyricsCandidates({ trackId, title: trackTitle, artist: trackArtist, album: trackAlbum, durationMs: trackDurationMs, path: trackPath })
      setPicker({ loading: false, list })
    } catch (error) {
      setPicker({ loading: false, list: [], error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 用用户选中的那一条去取歌词；主进程会把这次选择记进缓存（pinned）。 */
  const chooseCandidate = async (choice: LyricCandidateChoice): Promise<void> => {
    if (!trackPath || onlineBusy) return
    setPicker(null)
    setOnlineBusy(true)
    setOnlineNote(null)
    try {
      const outcome = await window.twilight.applyLyricsCandidate(
        { trackId, title: trackTitle, artist: trackArtist, album: trackAlbum, durationMs: trackDurationMs, path: trackPath },
        choice
      )
      if (outcome?.status === 'found' && outcome.result) setResult(onlineResultOf(outcome.result, trackKey))
      else setOnlineNote(noteOfOutcome(outcome, true))
    } catch (error) {
      setOnlineNote(error instanceof Error ? error.message : String(error))
    } finally {
      setOnlineBusy(false)
    }
  }

  /** 把在线歌词存成音乐旁边的同名 .ttml：之后这首歌本地优先，再也不联网。 */
  const saveLyricsNow = async (): Promise<void> => {
    if (!trackPath || saveBusy) return
    setSaveBusy(true)
    setOnlineNote(null)
    try {
      await window.twilight.saveLyrics({ path: trackPath, title: trackTitle, artist: trackArtist })
      // 重新解析一次：现在本地同名文件是第一顺位，标签会自己变成「同名歌词 · xxx.ttml」。
      setSourceRevision(value => value + 1)
    } catch (error) {
      setOnlineNote(error instanceof Error ? error.message : String(error))
    } finally {
      setSaveBusy(false)
    }
  }

  const changeOffset = (delta: number): void => {
    const current = offsetDraftValid ? numericOffset : currentOffset
    const next = Math.max(-10000, Math.min(10000, current + delta))
    if (next === current || !trackPath) return
    setOffsetDraft(String(next))
    void changeSource(() => window.twilight.setLyricsOffset(trackPath, next))
  }

  const applyOffsetDraft = (): void => {
    if (!trackPath) return
    if (!offsetDraftValid) {
      setSourceError('偏移须在 -10000 至 10000 毫秒之间，并按 50 毫秒递增。')
      return
    }
    if (numericOffset === currentOffset) return
    void changeSource(() => window.twilight.setLyricsOffset(trackPath, numericOffset))
  }

  const candidatePanel = picker ? <div className="lyrics-candidates" role="dialog" aria-label="选择这一首的歌词">
    <div className="lyrics-candidates-head"><strong>选择这一首的歌词</strong>{picker.loading ? <span className="mono">搜索中…</span> : <span className="mono">{picker.list.length} 个候选</span>}<button className="quiet-button" aria-label="关闭候选面板" onClick={() => setPicker(null)}><X size={14} /></button></div>
    {picker.error ? <p className="lyrics-candidates-note" role="alert">{picker.error}</p> : null}
    {!picker.loading && !picker.error && picker.list.length === 0 ? <p className="lyrics-candidates-note">没有搜到候选。可以换个名字再试，或直接把歌词文件放到音乐旁边。</p> : null}
    {picker.list.map(item => <button key={item.id} className="lyrics-candidate" onClick={() => void chooseCandidate(item)}>
      <span className="lyrics-candidate-copy"><strong>{item.title}</strong><span>{item.artist || '未知艺人'}{item.album ? ' · ' + item.album : ''}</span></span>
      <span className="lyrics-candidate-meta mono">{Math.round((item.durationMs ?? 0) / 1000)}s · {Math.round(item.score * 100)}%{item.risk === 'high' ? ' · 高风险' : ''}</span>
    </button>)}
  </div> : null

  const hasAttachment = result?.key === trackKey && (result.source === 'attached' || result.attachedUnavailable)

  const sourceControls = <div className="lyrics-source-controls">
    <input className="lyrics-offset mono" type="number" min={-10000} max={10000} step={50} aria-label="歌词偏移毫秒" title="歌词偏移 · -10000 至 10000 毫秒，步进 50 毫秒" value={offsetDraft} disabled={!trackPath || sourceBusy}
      onChange={event => setOffsetDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyOffsetDraft() } }} />
    <button className="quiet-button" aria-label="歌词提前 50 毫秒" title="歌词提前 50 毫秒" disabled={!trackPath || sourceBusy || (result?.key === trackKey && result.offsetMs <= -10000)} onClick={() => changeOffset(-50)}><Minus size={14} /></button>
    <button className="quiet-button" aria-label="歌词延后 50 毫秒" title="歌词延后 50 毫秒" disabled={!trackPath || sourceBusy || (result?.key === trackKey && result.offsetMs >= 10000)} onClick={() => changeOffset(50)}><Plus size={14} /></button>
    <button className="quiet-button" aria-label="应用歌词偏移" title="应用偏移" disabled={!trackPath || sourceBusy || (offsetDraftValid && numericOffset === currentOffset)} onClick={applyOffsetDraft}><Check size={14} /></button>
    {trackPath && result?.key === trackKey && result.offsetMs !== 0 ? <button className="quiet-button" aria-label="重置歌词偏移" title="重置为 0 毫秒" disabled={sourceBusy} onClick={() => void changeSource(() => window.twilight.setLyricsOffset(trackPath, 0))}><RotateCcw size={14} /></button> : null}
    <button className="quiet-button" aria-label="关联 LRC 歌词" title="关联本地 LRC 歌词" disabled={!trackPath || sourceBusy} onClick={() => void changeSource(() => window.twilight.attachLyrics(trackPath!))}><Link2 size={15} /><span>关联 LRC</span></button>
    {hasAttachment ? <button className="quiet-button" aria-label="移除歌词关联" title="移除关联，恢复同名歌词" disabled={sourceBusy} onClick={() => void changeSource(() => window.twilight.clearAttachedLyrics(trackPath!))}><Unlink2 size={15} /><span>恢复自动</span></button> : null}
    {trackPath && result?.key === trackKey && result.source === 'online' ? <button className="quiet-button" aria-label="保存歌词到本地" title="保存为音乐旁边的同名 .ttml 文件（之后本地优先、不再联网；不会覆盖已有文件）" disabled={saveBusy || sourceBusy} onClick={() => void saveLyricsNow()}><Save size={15} /><span>{saveBusy ? '保存中' : '保存到本地'}</span></button> : null}
  </div>

  useEffect(() => {
    const el = scrollRef.current
    const active = activeRef.current
    if (!el || !active || !visible || !following || document.hidden) return
    const center = (): void => {
      const target = active.offsetTop - el.clientHeight / 2 + active.clientHeight / 2
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollTo({ top: Math.max(0, target), behavior: reduceMotion ? 'instant' : 'smooth' })
    }
    center()
    const observer = new ResizeObserver(center)
    observer.observe(el)
    return () => observer.disconnect()
  }, [activeIdx, lyrics, visible, following, large, translations])

  /**
   * 画笔：只碰 DOM 属性，不触发 React.
   *  - 活性行逐词按**视觉播放头**算 `--fill`，并维护 current/sung；
   *  - 换行（含向后 seek）时把区间整段归位：更早的行填满、更新的行复位；
   *  - 暂停时也照画（事件驱动的那一帧），所以拖动进度条后填充立刻对齐。
   */
  /** 从当前 DOM 重建行/词引用。正常由 [lyrics] effect 维护；这里是防御：
   *  在线歌词/换行切换时可能出现「effect 跑在空渲染上」的瞬间，若缓存空着不重建，
   *  paint 会永远 no-op（e2e 里逐字填充偶发全 0 就是这么来的）。重建成本只在异常路径付。 */
  const rebuildNodes = useCallback((): { node: HTMLElement; words: HTMLElement[] }[] => {
    const built = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('.lyric-line') ?? []).map(node => ({
      node, words: Array.from(node.querySelectorAll<HTMLElement>('.lyric-word'))
    }))
    nodesRef.current = built
    return built
  }, [])
  // 正常路径：歌词模型换了一份就重建引用；异常路径由 paint 内的防御逻辑兜底。
  useEffect(() => { rebuildNodes() }, [lyrics, rebuildNodes])
  const paint = useCallback<Paint>((model, index) => {
    const scroll = scrollRef.current
    if (!scroll) return
    const nodes = nodesRef.current.length === 0 || (model != null && nodesRef.current.length !== model.lines.length)
      ? rebuildNodes()
      : nodesRef.current
    const paintLine = (entry: { node: HTMLElement; words: HTMLElement[] }, lineIndex: number, atMs: number | null): void => {
      const line = model?.lines[lineIndex]
      if (!line) return
      const spans = entry.words
      for (let i = 0; i < spans.length; i++) {
        const word = line.words[i]
        const span = spans[i]
        if (!word || !span) continue
        const fill = atMs === null ? (lineIndex < index ? 1 : 0) : wordFill(atMs, word)
        const sung = fill >= 1
        const current = atMs !== null && lineIndex === index && fill > 0 && !sung
        const nextClass = wordClass(sung, current)
        if (span.className !== nextClass) span.className = nextClass
        const value = fill === 1 ? '1' : fill === 0 ? '0' : fill.toFixed(4)
        if (span.style.getPropertyValue('--fill') !== value) span.style.setProperty('--fill', value)
      }
    }
    if (paintedRef.current !== index) {
      const from = paintedRef.current < 0 ? 0 : Math.min(paintedRef.current, index)
      const to = paintedRef.current < 0 ? index : Math.max(paintedRef.current, index)
      for (let i = from; i < to; i++) { const node = nodes[i]; if (node) paintLine(node, i, null) }
      paintedRef.current = index
    }
    const active = nodes[index]
    if (active) paintLine(active, index, playheadMs())
  }, [rebuildNodes])
  // 画布是命令式的：每次 render 都把最新 paint 放到 ref 上。
  // 不能交给 effect 管理 —— 依赖变化触发的 cleanup 会先把它清空，而只要下一次 effect
  // 走了 early-return（!model || !visible），subscribe 里的 paintRef.current?.(...) 就永远静默 no-op。
  paintRef.current = paint

  /**
   * 播放头每帧推进：仅在**可见 + 播放中 + 未开启减少动态效果**时；其余情况靠事件落格。
   *
   * ⚠️ `playState` 必须在依赖里：循环的启停取决于它，而 effect 只在依赖变化时重跑。
   * 少了它就会出现「挂载时是暂停 → 之后按播放也永远起不来」——补间只有在换行撞上时才碰巧启动。
   * （这不是理论问题：正是那条「12 帧内填充应有多个不同值」的断言把它抓出来的。）
   * 另外 tick 里也再读一次实时播放态，所以中途暂停会自己停下，不必等 effect 重跑。
   */
  useEffect(() => {
    const model = lyrics
    if (!model || !visible) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const running = (): boolean => {
      const line = model.lines[activeLineIndex(model, getPosition().positionMs)]
      const lastWord = line?.words.at(-1)
      // 不再要求 model.wordByWord：行级歌词补了插值词之后同样要逐字填充。
      // 「有没有词」由 lastWord 决定，数据源是不是原生字级由界面标注负责说明。
      return !document.hidden && !preference.matches && useTwilight.getState().playState === 'playing'
        && !!lastWord && playheadMs() < lastWord.endMs
    }
    let frame = 0
    const tick = (): void => {
      paint(model, activeLineIndex(model, getPosition().positionMs))
      frame = running() ? requestAnimationFrame(tick) : 0
    }
    const sync = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      paint(model, activeIdx)
      if (running()) frame = requestAnimationFrame(tick)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    preference.addEventListener('change', sync)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', sync)
      preference.removeEventListener('change', sync)
      // paintRef 故意不清：它由 render 期维护；hidden 语义由 subscribe 的 !visible 短路与 rAF 的 visible 检查保证。
    }
  }, [lyrics, visible, activeIdx, paint, playState])

  // 换曲：锚点与「已归位」标记都要清，否则新歌的第一帧会沿用上一首的填充。
  useEffect(() => { resetPlayhead(); paintedRef.current = -2; setFollowing(true) }, [trackKey])

  if (!lyrics || lyrics.lines.length === 0) {
    return (
      <div className="lyrics" ref={containerRef} data-visible={visible}>
        <div className="lyrics-toolbar"><span className="section-eyebrow">LYRICS <span className="lyrics-kind">{result?.key === trackKey && result.attachedUnavailable ? '关联文件不可用' : onlineBusy ? '在线查找中' : '暂无歌词'}</span></span><div className="lyrics-toolbar-actions">{trackPath ? <button className="quiet-button lyric-online" aria-label="在线查找歌词" aria-busy={onlineBusy} disabled={onlineBusy} title="按歌名与艺人重新在线查找（忽略缓存）" onClick={() => { forceOnlineRef.current = true; setSourceRevision(value => value + 1) }}><CloudDownload size={15} /><span>{onlineBusy ? '查找中' : '在线查找'}</span></button> : null}{trackPath ? <button className="quiet-button lyric-picker" aria-label="换一个歌词匹配" aria-expanded={picker !== null} title="列出搜索候选，自己指定这一版" onClick={() => void openPicker()}><ListMusic size={15} /><span>换一个</span></button> : null}{sourceControls}</div></div>
        {candidatePanel}
        <div className="lyrics-empty"><span className="section-eyebrow">LYRICS</span><strong>{hasTrack ? '让音乐自己说话' : '从一首喜欢的歌开始'}</strong><span>{result?.key === trackKey && result.attachedUnavailable ? '关联的 LRC 暂时无法读取，可重新关联或恢复同名歌词' : onlineBusy ? (isOnline ? '正在读取平台歌词…' : '正在按歌名与艺人查找歌词…') : hasTrack ? '暂无歌词' + (isOnline ? ' · 这个平台没有给出歌词' : ' · 可在线查找，也可关联本地 LRC / TTML') : `你的曲库里有 ${tracks.length} 首音乐`}</span>{sourceError || onlineNote ? <span role="alert">{sourceError || onlineNote}</span> : null}</div>
      </div>
    )
  }

  const wordLevel = lyrics.wordByWord
  const hasRuby = lyrics.lines.some(line => line.words.some(word => word.ruby))
  /** 命中的是「谁的」歌词：用户有权核对，所以计分理由也要能看见（悬浮说明里）。 */
  const match = result?.key === trackKey ? result.match : undefined
  const matchTitle = match
    ? ['命中：' + match.title + (match.artist ? ' / ' + match.artist : ''),
       '来源：' + (match.provider === 'amll-ttml' ? 'AMLL TTML DB' : match.provider === 'netease' ? '网易云音乐' : 'LRCLIB')
         + ' · 计分 ' + match.score + ' · 风险 ' + match.risk,
       ...(match.ncmId ? ['网易云 ID：' + match.ncmId] : []),
       ...(match.risk === 'high' ? ['⚠ 可能不是同一版本（翻唱/现场/时长不符）'] : [])].join('\n')
    : undefined

  return (
    <div className="lyrics" ref={containerRef} data-large={large} data-following={following} data-ruby={hasRuby ? 'true' : undefined} data-visible={visible}>
      <div className="lyrics-toolbar"><span className="section-eyebrow">LYRICS <span className="lyrics-kind" title={lyrics.wordByWord ? '数据源原生提供字级时间' : '行级时间按字/词加权插值，wordByWord 仍为 false'}>{wordLevel ? '逐字歌词' : result?.key === trackKey && result.interpolated ? '同步歌词 · 插值' : '同步歌词'}{match?.risk === 'high' ? <TriangleAlert size={12} className="lyrics-risk" aria-label="可能不是同一版本" /> : null}</span></span><div className="lyrics-toolbar-actions">
        <button className="quiet-button" aria-label="大号歌词" aria-pressed={large} title="切换歌词字号" onClick={() => { setLarge(!large); try { localStorage.setItem('stringmoon.lyrics-large', large ? 'off' : 'on') } catch { /* Session preference. */ } }}><Type size={16} /></button>
        {lyrics.lines.some(line => line.translation || line.romanization || line.words.some(word => word.ruby)) ? <button className="quiet-button" aria-label="显示翻译与注音" title="显示或隐藏翻译、罗马音与注音" aria-pressed={translations} onClick={() => setTranslations(!translations)}><Languages size={16} /></button> : null}
        <button className="quiet-button lyric-follow" aria-label="跟随当前歌词" aria-pressed={following} title={following ? '正在跟随 · 滚动可浏览歌词' : '返回当前歌词'} onClick={() => setFollowing(value => !value)}><Focus size={15} /><span>{following ? '跟随' : '回到当前'}</span></button>
        {trackPath ? <button className="quiet-button lyric-online" aria-label="在线查找歌词" aria-busy={onlineBusy} disabled={onlineBusy} title="按歌名与艺人重新在线查找（忽略缓存）" onClick={() => { forceOnlineRef.current = true; setSourceRevision(value => value + 1) }}><CloudDownload size={15} /><span>{onlineBusy ? '查找中' : '在线查找'}</span></button> : null}{trackPath ? <button className="quiet-button lyric-picker" aria-label="换一个歌词匹配" aria-expanded={picker !== null} title="列出搜索候选，自己指定这一版" onClick={() => void openPicker()}><ListMusic size={15} /><span>换一个</span></button> : null}
        {sourceControls}
      </div></div>
      {candidatePanel}
      <div className="lyrics-scroll" ref={scrollRef} tabIndex={0} aria-label="歌词，点击跳转播放" onWheel={() => setFollowing(false)} onTouchStart={() => setFollowing(false)} onKeyDown={event => { if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setFollowing(false) }}>
        {lyrics.lines.map((line, i) => {
          const isActive = i === activeIdx
          const cls =
            (isActive ? 'lyric-line active' : activeIdx >= 0 && Math.abs(i - activeIdx) === 1 ? 'lyric-line adjacent' : 'lyric-line') +
            (line.words.length > 0 ? ' word-level' : '')
          return (
            <div key={i} ref={isActive ? activeRef : undefined} className={cls} role="button" tabIndex={isActive || (activeIdx < 0 && i === 0) ? 0 : -1} aria-label={'播放这一句：' + line.text} aria-current={isActive ? 'true' : undefined}
              onClick={() => { setFollowing(true); void seekTo(line.startMs) }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); event.stopPropagation(); setFollowing(true); void seekTo(line.startMs) }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault(); event.stopPropagation(); setFollowing(false)
                  const next = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
                  if (next instanceof HTMLElement) { next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }
                }
              }}>
              {line.words.length > 0
                ? line.words.map((wd, j) => wd.ruby && translations
                  // 注音必须是 .lyric-word 的**兄弟**而不是子元素：逐字填充靠
                  // background-clip:text + 透明字色，注音放进去会一起被裁掉。
                  ? <span key={j} className="lyric-word-unit"><span className="lyric-ruby" aria-hidden="true">{wd.ruby}</span><span className="lyric-word">{wd.text}</span></span>
                  : <span key={j} className="lyric-word">{wd.text}</span>)
                : line.text}
              {translations && line.romanization ? <span className="lyric-tr lyric-romanization">{line.romanization}</span> : null}
              {translations && line.translation ? <span className="lyric-tr">{line.translation}</span> : null}
            </div>
          )
        })}
      </div>
      {/* 逐字/行级已经写在 sourceLabel 里了；再追加一次会变成「· 行级·插值 · 行级·插值」。 */}
      {sourceLabel || sourceError ? <span className="lyrics-source mono" title={sourceError ?? matchTitle ?? sourceLabel}>{sourceError || (sourceLabel + (result?.key === trackKey && result.attachedUnavailable ? ' · 关联文件不可用' : ''))}</span> : null}
    </div>
  )
}

// 无 props（状态来自 store 与 positionStore）：父级因扫描/请求状态重渲染时不必跟着重算。
export default memo(LyricsView)