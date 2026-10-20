import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, CloudDownload, Copy, Loader2, Music2, Play, Search, Sparkles } from 'lucide-react'
import type { GdSourceStatus, PlatformId, StreamingSimilarResult, StreamingTrack } from '@shared/streaming'
import { PLATFORM_SPECS } from '@shared/streaming'
import { useStreamingUi } from '../streaming/streamStore'
import { playStreamingTrack } from '../streaming/play'
import { parseLrc } from '@shared/lrc'

type Row = StreamingTrack & { sourceName: string }

const platformName = (id: PlatformId): string => PLATFORM_SPECS.find(spec => spec.id === id)?.displayName ?? id

function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

/**
 * 全局搜索（参考 gdstudio 的那一栏）。
 *
 * 一次输入、搜遍**所有已启动的来源**，结果按来源分组并标注。这一栏只做三件事：
 * 播放、下载、看详情。来源管理不在这里——它属于设置，否则这一栏又会变成一个百宝箱。
 *
 * 「看得到详细信息」是这一版的重点：结果行有封面、时长、专辑与来源；
 * 展开还能看到曲目 ID、平台直链请求的档位说明，以及平台歌词预览。
 */
export default function GlobalSearch() {
  const selectSource = useStreamingUi(state => state.selectSource)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [results, setResults] = useState<Row[]>([])
  const [keyword, setKeyword] = useState('')
  const [queued, setQueued] = useState<Set<string>>(() => new Set())
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [lyrics, setLyrics] = useState<{ key: string; lines: string[]; note: string | null } | null>(null)
  /** GD 音乐台上游源可用性（运行时探测；界面如实显示，不写死）。 */
  const [gdSources, setGdSources] = useState<GdSourceStatus[]>([])
  /** Embeat 相似歌曲（失败时 provider 已降级为同歌手/同专辑搜索，界面必须标注 degraded）。 */
  const [similar, setSimilar] = useState<{ key: string; items: StreamingSimilarResult['items']; degraded: boolean; reason: string | null; busy: boolean } | null>(null)
  useEffect(() => {
    let mounted = true
    void window.twilight.streamingGdSources().then(list => { if (mounted && Array.isArray(list)) setGdSources(list) }).catch(() => { /* provider 未就绪：不显示这一条 */ })
    return () => { mounted = false }
  }, [])

  const keyOf = (track: StreamingTrack): string => track.platform + ':' + track.id

  const run = (): void => {
    const keyword = query.trim()
    if (!keyword || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setOpenKey(null)
    setLyrics(null)
    void (async () => {
      try {
        setKeyword(keyword)
        const list = await window.twilight.searchAll(keyword, 20) as Array<StreamingTrack & { sourceName?: string }>
        const rows = list.map(track => ({ ...track, sourceName: track.sourceName ?? platformName(track.platform) }))
        setResults(rows)
        if (rows.length === 0) setNotice('三个来源都没有结果。没登录时 QQ 的搜索常被上游拒绝。')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setResults([])
      } finally {
        setBusy(false)
      }
    })()
  }

  const play = (track: StreamingTrack): void => {
    setError(null)
    void (async () => {
      try {
        await playStreamingTrack(track)
        setNotice('正在播放：' + track.title)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  const download = (track: StreamingTrack): void => {
    setError(null)
    void (async () => {
      try {
        await window.twilight.downloadAdd(track)
        setQueued(current => new Set(current).add(keyOf(track)))
        setNotice('已加入下载：' + track.title)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  const copy = (track: StreamingTrack): void => {
    const text = [track.title, track.artist, track.album, platformName(track.platform), 'ID ' + track.id].filter(Boolean).join(' · ')
    void navigator.clipboard.writeText(text).then(() => setNotice('已复制：' + text)).catch(() => setNotice(text))
  }

  /** 平台歌词预览：按需取，不随搜索预取（一次搜索 20 条，预取就是 20 次请求）。 */
  const previewLyrics = (track: StreamingTrack): void => {
    const key = keyOf(track)
    if (lyrics?.key === key) { setLyrics(null); return }
    setLyrics({ key, lines: [], note: '正在读取平台歌词…' })
    void window.twilight.streamingLyrics(track.platform, { id: track.id, title: track.title, artist: track.artist, album: track.album })
      .then((raw) => {
        const payload = raw as { lrc?: string; translation?: string }
        const parsed = parseLrc((payload?.lrc ?? '') + '\n' + (payload?.translation ?? ''))
        const lines = parsed.lines.map(line => line.text).filter(Boolean).slice(0, 12)
        setLyrics({ key, lines, note: lines.length === 0 ? '这个平台没有给出这首歌的歌词。' : null })
      })
      .catch((err: unknown) => setLyrics({ key, lines: [], note: err instanceof Error ? err.message : String(err) }))
  }

  /** Embeat 相似歌曲（v3 §1.3）：失败时 provider 会降级，降级原因要如实展示。 */
  const loadSimilar = (track: StreamingTrack): void => {
    const key = keyOf(track)
    if (similar?.key === key && !similar.busy) { setSimilar(null); return }
    setSimilar({ key, items: [], degraded: false, reason: null, busy: true })
    void window.twilight.streamingSimilar({ id: track.id, title: track.title, artist: track.artist, album: track.album })
      .then((result) => setSimilar({ key, items: result.items ?? [], degraded: result.degraded === true, reason: result.reason ?? null, busy: false }))
      .catch((err: unknown) => setSimilar({ key, items: [], degraded: true, reason: err instanceof Error ? err.message : String(err), busy: false }))
  }

  /** 找到这首歌后跳到歌曲中心那一档，方便继续看歌单/来源。 */
  const openSource = (platform: PlatformId): void => { selectSource(platform) }

  /** 按来源分组：同一首歌在三个平台都有时，分组比一串混排更容易读。 */
  const groups = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const row of results) {
      const list = map.get(row.sourceName) ?? []
      list.push(row)
      map.set(row.sourceName, list)
    }
    return [...map.entries()]
  }, [results])

  return (
    <section className="global-search" aria-label="全局搜索">
      <header className="space-heading">
        <div>
          <span className="section-eyebrow">GLOBAL SEARCH</span>
          <h1>全局搜索</h1>
        </div>
      </header>

      <div className="center-search">
        <Search size={16} strokeWidth={1.6} />
        <input aria-label="全局搜索" placeholder="一次搜遍所有已启动的来源" value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') run() }} />
        <button className="topbar-action" disabled={busy || !query.trim()} onClick={run}>
          {busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />}搜索
        </button>
      </div>

      <div className="center-toolbar">
        <span className="section-eyebrow">RESULTS</span>
        {keyword ? <span className="center-ed">{keyword}</span> : null}
        <span className="center-status mono">{results.length ? results.length + ' 条' : ''}</span>
      </div>

      {gdSources.length > 0 ? <div className="gd-sources" role="status" aria-label="GD 音乐台上游源可用性">
        <span className="gd-sources-label" title="GD 音乐台属于第三方聚合源：只支持在线播放/相似推荐，不提供下载">GD 音乐台源 · 仅在线播放</span>
        {gdSources.map(source => <span className="gd-source" key={source.source} data-ok={source.ok || undefined}
          title={source.error ?? (source.ok ? '可用' : '当前不可用')}>
          <i aria-hidden className="gd-source-dot" />{source.source === 'netease' ? '网易云' : 'JOOX'}{source.ok ? '' : ' · 不可用'}
        </span>)}
      </div> : null}

      {error ? <p className="center-note error" role="alert">{error}</p> : null}
      {notice ? <p className="center-note" role="status">{notice}</p> : null}

      <div className="center-scroll">
        {groups.map(([source, rows]) => (
          <div className="search-group" key={source}>
            <div className="search-group-head"><span>{source}</span><b>{rows.length}</b></div>
            <div className="track-list center-list" role="listbox" aria-label={source + ' 搜索结果'}>
              {rows.map(track => {
                const key = keyOf(track)
                const open = openKey === key
                return (
                  <div key={key} className={'stream-row' + (open ? ' open' : '')} role="option" aria-selected={false}>
                    <div className="stream-main" onDoubleClick={() => play(track)}>
                      <button className="row-play" title="播放" onClick={() => play(track)}><Play size={13} /></button>
                      <span className="row-cover" aria-hidden="true">
                        {track.cover ? <img src={track.cover} alt="" loading="lazy" /> : <Music2 size={14} />}
                      </span>
                      <span className="stream-copy">
                        <strong className="track-title">{track.title}</strong>
                        <small>{track.artist || '未知艺人'}{track.album ? ' · ' + track.album : ''}</small>
                      </span>
                      <span className="stream-meta mono">{fmt(track.durationMs)}</span>
                      <button className="source-chip" title={'切到 ' + track.sourceName} onClick={() => openSource(track.platform)}>{track.sourceName}</button>
                      {track.platform === 'gdstudio' ? null : <button className="row-play" title="下载" disabled={queued.has(key)} onClick={() => download(track)}>
                        <CloudDownload size={13} />
                      </button>}
                      <button className={'quiet-button row-expand' + (open ? ' open' : '')} aria-expanded={open} title="详情"
                        aria-label={open ? '收起详情' : '展开详情'} onClick={() => { setOpenKey(open ? null : key); if (open) setLyrics(null) }}>
                        <ChevronDown size={14} />
                      </button>
                    </div>
                    {open ? (
                      <div className="stream-detail">
                        <div className="stream-detail-cover" aria-hidden="true">
                          {track.cover ? <img src={track.cover} alt="" /> : <Music2 size={22} />}
                        </div>
                        <dl className="stream-facts">
                          <div><dt>来源</dt><dd>{track.sourceName}</dd></div>
                          <div><dt>专辑</dt><dd title={track.album || undefined}>{track.album || '—'}</dd></div>
                          <div><dt>时长</dt><dd>{fmt(track.durationMs)}</dd></div>
                          <div><dt>曲目 ID</dt><dd className="mono" title={track.id}>{track.id}</dd></div>
                          <div><dt>歌词</dt><dd>{lyrics?.key === key ? (lyrics.note ?? lyrics.lines.length + ' 行') : '未读取'}</dd></div>
                        </dl>
                        <div className="stream-actions">
                          <button className="topbar-action" onClick={() => play(track)}><Play size={13} />播放</button>
                          {track.platform === 'gdstudio'
                            ? <button className="topbar-action" disabled title="第三方源（GD 音乐台）不提供下载，只支持在线播放与相似推荐"><CloudDownload size={13} />不提供下载</button>
                            : <button className="topbar-action" disabled={queued.has(key)} onClick={() => download(track)}><CloudDownload size={13} />下载</button>}
                          <button className="topbar-action" onClick={() => previewLyrics(track)}><Sparkles size={13} />{lyrics?.key === key ? '收起歌词' : '查看歌词'}</button>
                          {track.platform === 'gdstudio' ? <button className="topbar-action" aria-expanded={similar?.key === key} onClick={() => loadSimilar(track)}>
                            <Sparkles size={13} />{similar?.key === key ? '收起相似' : '相似歌曲'}</button> : null}
                          <button className="topbar-action" onClick={() => copy(track)}><Copy size={13} />复制信息</button>
                        </div>
                        {similar?.key === key ? <div className="search-similar" aria-label="相似歌曲">
                          <div className="search-similar-head">
                            <span>相似歌曲</span>
                            {similar.busy ? <Loader2 size={13} className="spin" aria-label="正在获取" /> : null}
                            {!similar.busy ? <span className="search-similar-note" data-degraded={similar.degraded || undefined}>
                              {similar.degraded ? '推荐降级：' + (similar.reason ?? 'Embeat 暂不可用，已改用同歌手/同专辑搜索') : 'Embeat 推荐'}
                            </span> : null}
                          </div>
                          {!similar.busy && similar.items.length === 0 ? <p className="center-note">没有找到相似歌曲。</p> : null}
                          {similar.items.map(item => <div className="search-similar-row" key={keyOf(item)} data-track-id={item.id}>
                            <button className="row-play" title="播放" onClick={() => play(item)}><Play size={13} /></button>
                            <span className="search-similar-copy"><strong>{item.title}</strong><small>{item.artist}{item.album ? ' · ' + item.album : ''}</small></span>
                            <span className="source-chip">{item.sourceName}</span>
                          </div>)}
                        </div> : null}
                        {lyrics?.key === key ? (
                          <div className="stream-lyrics">
                            {lyrics.note && lyrics.lines.length === 0
                              ? <p className="center-note">{lyrics.note}</p>
                              : lyrics.lines.map((line, index) => <p key={index}>{line}</p>)}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {results.length === 0 && !busy ? <p className="center-note">输入关键词，一次搜遍所有已启动的来源。</p> : null}
      </div>
    </section>
  )
}