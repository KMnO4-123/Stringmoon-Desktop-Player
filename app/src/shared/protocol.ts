/**
 * CONTRACT §3 / §4.3 冻结协议的 TypeScript 形状。
 * 字段名与 <仓库根>/CONTRACT.md (2026-10-14, v1.1) 逐字对应，不得增删语义字段。
 * 命令回复的 data 形状契约未明文 → 见 docs/contract-requests.md CR-001；应用侧只做防御性可选读取。
 */
export const PROTOCOL_VERSION = 1

/**
 * 循环模式。引擎侧是**一个枚举**（`RepeatMode`，player.hpp:36），不是「循环开关 + 随机开关」两个独立布尔 ——
 * 所以界面也只有一个四态控件：随机取代循环，而不是叠加在它之上。
 * 线上拼写与 `repeatModeName()` 逐字对应（引擎把两者放在一起就是为了不漂移）。
 */
export type RepeatMode = 'sequential' | 'one' | 'all' | 'shuffle'

export type EngineCommand =
  | { cmd: 'hello'; protocol: number }
  | { cmd: 'pick_folder' }
  // CR-017：`recursive` 遍历子目录，`probe` 在入库前用生产解码器验一次；
  // 两者缺省 false ⇒ 行为与 CR-013 裁定后完全一致，旧调用方零影响。
  | { cmd: 'scan'; path: string; replace?: boolean; recursive?: boolean; probe?: boolean }
  // CR-016（owner 已裁定接受）：`url` 与 `trackId` 互斥，缺二者仍 ERR_NOTFOUND。
  // URL 只作为路径交给引擎，音频样本不穿越 stdio；Range/鉴权/重签由回环代理负责，
  // 网络失败由引擎停止并报告，绝不当作 EOF。
  | { cmd: 'open'; trackId: string }
  | { cmd: 'open'; url: string }
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'stop' }
  | { cmd: 'next' }
  | { cmd: 'prev' }
  | { cmd: 'seek'; positionMs: number }
  | { cmd: 'set_volume'; volume: number }
  /**
   * mode 省略 = 保持当前偏好（引擎 2026-10-17 起支持）；sampleRate 省略 = 跟随源采样率。
   *
   * sampleRate 是**应用侧追加**的字段（引擎已实现，CONTRACT 待走 CR）：它把
   * 「按哪个采样率开流」变成可指定的，因为同一份 44.1k 素材在有的 DAC 上
   * 96k/192k 反而更稳。非零时重采样器进入链路，outputPerfect 随之如实变 false。
   */
  | { cmd: 'set_output'; mode?: 'exclusive' | 'shared' | 'auto'; deviceId?: string; sampleRate?: number
      /** CR-027：输出延迟档位；省略 = 保持当前（缺省 balanced = 现状）。 */
      latencyProfile?: LatencyProfile
      /** CR-028：暂停/切歌/seek 的过渡时长（5–50ms，缺省 10）；曲线为等功率 sin²。 */
      fadeMs?: number
      /** CR-028：暂停时保持输出流打开（渲染静音），避免端点 Stop/Start 的底噪。缺省 true。 */
      pauseHold?: boolean }
  | { cmd: 'list_devices' }
  | { cmd: 'list_tracks' }
  | { cmd: 'shutdown' }

export interface Track {
  trackId: string
  title: string
  artist: string
  album?: string
  durationMs: number
  path: string
  sampleRate?: number
  bitDepth?: number
  // ── 引擎侧附加字段（CR-004，只增不改；应用侧只读展示）──
  albumArtist?: string
  genre?: string
  trackNo?: number
  discNo?: number
  year?: number
  channels?: number
  bitrate?: number
  codec?: string
  sizeBytes?: number
}

export interface DeviceInfo {
  id: string
  name: string
  isDefault?: boolean
  // 引擎附加（CR-004）
  isBluetooth?: boolean
  channels?: number
  sampleRate?: number
  hasExclusive?: boolean
  exclusiveFormats?: string[]
}

/** 引擎能力自报（hello 回复 data.capabilities，CR-004） */
export interface EngineCapabilities {
  exclusive: boolean
  shared: boolean
  resampler: boolean
  dsp: boolean
  queue: boolean
  seek: boolean
  /** CR-015 visibility extension: set_meter controls non-destructive monitoring. */
  meter?: boolean
}

export type EngineErrorCode =
  | 'ERR_DEVICE'
  | 'ERR_DECODE'
  | 'ERR_NOTFOUND'
  | 'ERR_STATE'
  | 'ERR_UNSUPPORTED'
  | 'ERR_INTERNAL'

export interface EngineErrorShape {
  code: EngineErrorCode | string
  message: string
  /** CR-009: implemented extension; contract approval is still pending. */
  kind?: 'not_implemented' | 'hardware'
}

/** stdout 上的每一行：要么带 ev（事件），要么带 id+ok（命令回复） */
export type EngineReply =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: EngineErrorShape }

/** 契约命令外，引擎实测已支持的扩展命令（CR-002 AI-A，待 owner 裁定后入契约） */
export type EngineExtensionCommand =
  | { cmd: 'set_queue'; trackIds: string[]
      /** CR-030：重排后把 queueIndex 指回该曲目（队列拖拽/删除不甩掉正在播放的项）。 */
      keepCurrent?: boolean
      currentTrackId?: string }
  /** CR-029：空间音频。off 时逐样本恒等（不破坏 bit-perfect）。 */
  | ({ cmd: 'set_spatial' } & SpatialPatch)
  | { cmd: 'set_repeat'; mode: RepeatMode }
  | { cmd: 'get_state' }
  /**
   * CR-031：限幅器可控。字段全部可选，省略 = 保持当前；全缺省时引擎回 ERR_STATE。
   * lookaheadMs=0（默认）走既有算法，逐样本与引入 CR-031 之前一致。
   */
  | { cmd: 'set_limiter'; enabled?: boolean; ceilingDb?: number; releaseMs?: number; lookaheadMs?: number }
  /**
   * CR-032：解码能力矩阵。引擎回答「本构建能解哪些格式、本机系统解码器在不在」——
   * 客户端不再自己维护一张会和引擎漂移的扩展名表。
   */
  | { cmd: 'get_capabilities' }
  /** 引擎侧独立于音量：静音**不改变** volume（app.cpp:513 的回复注释专门纠正把二者等同的客户端）。 */
  | { cmd: 'set_muted'; muted: boolean }
  /** CR-015 visibility extension accepted by owner: false stops event push only. */
  | { cmd: 'set_meter'; enabled: boolean }
  /** CR-008 accepted 2026-10-15: partial update; omitted fields are preserved. */
  | ({ cmd: 'set_eq' } & EqPatch)
  | ({ cmd: 'set_ir' } & IrPatch)
  | ({ cmd: 'set_channels' } & ChannelPatch)
  /**
   * CR-024：重采样器可配置（对标 ECHO NEXT 的 ECHO SRC）。
   * 字段全部可选，省略 = 保持当前值；默认 VHQ / linear / 非 steep 与现状等价。
   */
  | { cmd: 'set_resampler'; quality?: ResamplerQuality; phase?: ResamplerPhase; steep?: boolean }
  /**
   * CR-025：PCM dither 档位。省略 mode = 保持当前；默认 tpdf 与现状等价。
   * （“省略=保持”是 CR 的语义，所以 mode 在类型上可选；UI 每次都显式带上当前值。）
   */
  | { cmd: 'set_dither'; mode?: DitherMode }
  /**
   * CR 外（引擎已实现，应用侧本轮接线）：离线响度扫描（libebur128）。
   * async:true 立即回 {accepted,total,replyId}，完成后发 loudness_done；
   * 测量与应用分离 —— 这条命令不改变任何播放状态。
   */
  | { cmd: 'analyze_loudness'; trackIds: string[]; album?: boolean; async?: boolean; maxSeconds?: number }
  /**
   * 应用 ReplayGain（引擎侧早已实现）：mode 必填；数值字段描述的是**文件**，
   * 省略时保持引擎当前值。trackPeak/albumPeak 是线性振幅（给 preventClip 用，
   * 不是 dB —— 两条公式的量纲不同，混用会静默算出错误上限）。
   */
  | {
      cmd: 'set_replaygain'
      mode: 'off' | 'track' | 'album'
      trackGainDb?: number
      albumGainDb?: number
      preampDb?: number
      trackPeak?: number
      albumPeak?: number
      preventClip?: boolean
    }

export type EngineRequestCommand = EngineCommand | EngineExtensionCommand

export type EqBandTypeName = 'peaking' | 'lowShelf' | 'highShelf'

/** CR-019: one slot of the parametric EQ. Every field is optional; omitted ones are preserved. */
export interface EqBandPatch {
  /** 0 = "back to the SPEC grid frequency for this slot". Otherwise 10..24000 Hz. */
  freq?: number
  gainDb?: number
  /** 0 = "use the global Q". Otherwise 0.1..10. */
  q?: number
  type?: EqBandTypeName
}

export interface EqPatch {
  enabled?: boolean
  /** At most ten entries in fixed frequency order, each within -12..12 dB. Gains only. */
  bandGains?: number[]
  /**
   * CR-019: index-aligned per-band updates (type / frequency / Q / gain).
   * A shorter array updates only the leading slots, which is what a UI dragging
   * one band needs — it must not have to echo the other nine back.
   */
  bands?: EqBandPatch[]
  q?: number
  preampDb?: number
  autoHeadroom?: boolean
}

/** CR-024：SoXR 精度档（VHQ=28bit 默认，24BIT=SOXR_24_BITQ，HQ=20bit）。 */
export type ResamplerQuality = 'HQ' | 'VHQ' | '24BIT'
/** CR-024：soxr phase_response（minimum=0 / intermediate=25 / linear=50（默认） / maximum=100）。 */
export type ResamplerPhase = 'linear' | 'minimum' | 'intermediate' | 'maximum'
export interface ResamplerConfig {
  quality: ResamplerQuality
  phase: ResamplerPhase
  steep: boolean
}
/** CR-025：dither 档位（默认 tpdf 与现状等价）。 */
export type DitherMode = 'off' | 'tpdf' | 'highpass-tpdf' | 'ns-5' | 'ns-9' | 'ultra-shaped'
export interface DitherConfig {
  mode: DitherMode
  /** 引擎如实上报：这次量化是否真的加了 dither（整数输出且输出位深低于源有效精度时才为 true）。 */
  active: boolean
}
/** CR-027：输出延迟档位（balanced 为现状默认）。 */
export type LatencyProfile = 'stable' | 'balanced' | 'lowLatency'
/**
 * CR-028：过渡（fade）配置 —— 治理暂停/切歌爆音。
 *
 * - ms：过渡时长（5–50），曲线为等功率 sin²（旧实现是线性，中途仍有可闻台阶）；
 * - pauseHold：暂停时不关闭输出流（淡出后继续渲染静音、恢复时淡入），
 *   避免 USB DAC / 蓝牙端点 Stop/Start 之间的电源与时钟切换底噪。
 */
export interface FadeConfig {
  ms: number
  pauseHold: boolean
}
/**
 * CR-029：空间音频（对标杜比/Cavern 的高效实现）。
 *
 * off 时整段旁路、逐样本恒等（bit-perfect 不变）；其余模式都只输出双耳 2ch：
 * - crossfeed：耳机串扰消除（对侧短延迟 + 低通，缓解极端左右分离的听觉疲劳）；
 * - wide：中侧（M/S）增益扩展，提升宽度；
 * - virtual：24 方位内置 HRIR 的双耳虚拟环绕（复用既有 partitioned FFT 卷积器）。
 */
export type SpatialMode = 'off' | 'crossfeed' | 'wide' | 'virtual'
export interface SpatialPatch {
  mode?: SpatialMode
  /** 0..1：效果强度（crossfeed 是串扰量、wide 是扩展量、virtual 是环绕量）。 */
  amount?: number
  /** −90..90 度：虚拟声源方位（仅 virtual 有意义）。 */
  azimuth?: number
  /** 0..1 ms：对侧耳 ITD（仅 crossfeed/virtual）。 */
  delayMs?: number
}
export interface SpatialState {
  mode: SpatialMode
  amount: number
  /** 引擎如实上报：是否真的在处理（off / 参数无效 / 单声道源时为 false）。 */
  active: boolean
  /**
   * CR-029 只增字段：引擎实际生效的方位与对侧耳延迟。
   * 旧引擎不发这两项时保持 undefined —— 界面按「未上报」显示，不要用 patch 里的请求值回填，
   * 否则「请求了 30° 但引擎实际 0°」会被画成已生效。
   */
  azimuth?: number
  delayMs?: number
  /** 虚拟环绕共用的卷积器延迟（帧）；0 = 当前没走卷积路径。 */
  latencyFrames?: number
}

/**
 * CR-031：限幅器状态回读（state.dsp.limiter）。
 *
 * truePeakActive 是引擎如实声明「峰值判定用的是采样峰还是真峰值」——本构建为 false，
 * 界面不能把它画成 true-peak 限幅。gainReductionDb 是最近一块的联动衰减量。
 */
export interface LimiterState {
  enabled: boolean
  ceilingDb: number
  releaseMs: number
  lookaheadMs: number
  /** lookaheadMs 对应的延迟帧数（0 = 不引入延迟）。 */
  latencyFrames: number
  truePeakActive: boolean
  gainReductionDb: number
}
/** CR-026：单声道来源选择。 */
export type MonoMode = 'off' | 'sum' | 'left' | 'right'
/** CR-026：低/中/高三频段的左右独立增益（dB，−6..+3）；全 0 时引擎整段旁路。 */
export interface ChannelBandGains {
  low: [number, number]
  mid: [number, number]
  high: [number, number]
}
/** CR-026 的补丁形状：每个频段可单独省略（省略 = 保持）。 */
export interface ChannelBandGainsPatch {
  low?: [number, number]
  mid?: [number, number]
  high?: [number, number]
}

export interface ChannelPatch {
  /** CR-026：单声道来源选择。off 时完全旁路；旧字段 mono:true 等价 monoMode:'sum'。 */
  monoMode?: MonoMode
  /** CR-026：低/中/高三频段左右独立增益（dB，范围 −6..+3）；三个频段都可单独省略。 */
  bandGains?: ChannelBandGainsPatch
  /** CR-026：每声道延迟（ms，0..10）；[0,0] 时完全旁路。 */
  delayMs?: [number, number]
  balance?: number
  mono?: boolean
  stereoWidth?: number
  swapChannels?: boolean
  channelGains?: number[]
  midGainDb?: number
  sideGainDb?: number
  crossfeedEnabled?: boolean
  crossfeedPreset?: 0 | 1 | 2
  crossfeedFcHz?: number
  crossfeedFeedDb?: number
}

export interface EqState {
  enabled: boolean
  q: number
  preampDb: number
  autoHeadroom: boolean
  /** CR-019: each band reports its RESOLVED shape, so a client never has to re-derive defaults. */
  bands: Array<{ freq: number; gainDb: number; q?: number; type?: EqBandTypeName }>
}

/** CR-008: full details arrive in get_state.dsp and directly in setter replies. */
/** CR-020: FIR / room correction. */
export interface IrState {
  loaded: boolean
  enabled: boolean
  preampDb: number
  /** Frames of latency the convolver adds. Reported, not guessed. */
  latencyFrames: number
  taps?: number
  channels?: number
  sampleRate?: number
  partitions?: number
  /** Display name (the file's base name) — the path itself would be long and private. */
  name?: string
  /** Peak magnitude of the whole response, dB. The automatic preamp is -this. */
  maxGainDb?: number
  rmsGainDb?: number
  /** Log-spaced preview of the response, 48 points over 20 Hz..20 kHz. */
  curve?: Array<{ hz: number; db: number }>
}

export interface IrPatch {
  /** Absolute path to a WAV impulse response. */
  path?: string
  enabled?: boolean
  preampDb?: number
}

export interface DspState {
  ir?: IrState
  eq?: EqState
  replayGain?: { mode: 'off' | 'track' | 'album'; trackGainDb: number; albumGainDb: number; preampDb: number; preventClip: boolean }
  appliedGainDb?: number
  passthrough?: boolean
  streaming?: boolean
  limiterEnabled?: boolean
  /** CR-031 只增字段：完整限幅器配置（旧引擎不发时只看 limiterEnabled）。 */
  limiter?: LimiterState
  channels?: {
    balance: number
    mono: boolean
    midGainDb: number
    sideGainDb: number
    stereoWidth: number
    swapChannels: boolean
    channelGains: Array<{ channel: number; gainDb: number }>
    /** CR-026 只增字段：旧引擎不返回时保持 undefined（UI 按 off/0 展示）。 */
    monoMode?: MonoMode
    bandGains?: ChannelBandGains
    delayMs?: [number, number]
  }
  crossfeed?: { enabled: boolean; preset: number; fcHz: number; feedDb: number }
}

/** analyze_loudness 的单曲结果（引擎 app.cpp:1177-1190 的 loudnessJson）。 */
export interface LoudnessTrackResult {
  trackId?: string
  ok: boolean
  integratedLufs?: number
  /** 引擎算好的 target − integrated（符号约定由引擎负责，调用方不要自己再算）。 */
  gainDb?: number
  truePeakDb?: number
  /** 真峰值的线性振幅（给 preventClip 用；sample peak 不能冒充真峰值）。 */
  peakLinear?: number
  /** ok:false 时的原因（太短/太安静/读不了）。 */
  reason?: string
}
export interface LoudnessScanData {
  targetLufs?: number
  tracks: LoudnessTrackResult[]
  album?: LoudnessTrackResult
  analysedSeconds?: number
  cacheHits?: number
  albumRequested?: boolean
}

export type EngineStateReply = Extract<EngineEvent, { ev: 'state' }> & { dsp?: DspState }

export type EngineEvent =
  | { ev: 'ready'; protocol: number; version: string; devices: DeviceInfo[] }
  | { ev: 'position'; trackId: string; positionMs: number; durationMs: number }
  | {
      ev: 'state'
      // CR-002（AI-A）：真引擎实测有第三态 "stopped"（已装载未播放/已停止；trackId 可为空串）
      state: 'playing' | 'paused' | 'stopped'
      trackId: string
      outputMode: 'exclusive' | 'shared' | 'none'
      sampleRate: number
      bitDepth: number
      bitPerfect: boolean
      // ── 引擎侧附加字段（CR-004，只增不改）──
      positionMs?: number
      durationMs?: number
      volume?: number
      resampled?: boolean
      sourceSampleRate?: number
      degradeReason?: string
      deviceId?: string
      deviceName?: string
      periodMs?: number
      /** CR-009: session total from state; never sum xrun events. */
      xrunCount?: number
      channels?: number
      /** Read-only engine output precision; bitDepth above describes the source. */
      containerBits?: number
      validBits?: number
      dspActive?: boolean
      dspModules?: string[]
      /**
       * 权威的循环模式与静音（player.cpp:540 / :543）。二者都是「只由引擎知道」的事实：
       * 客户端只记住自己发过什么，一旦自动续播或队列重载改了模式就会显示错的。
       * 旧引擎不发这两个字段 → 应用侧保持当前值，不要当成「未静音」。
       */
      repeatMode?: RepeatMode
      muted?: boolean
      // ── CR-024..027（只增不改；旧引擎不发时保持 undefined，不要当成默认值覆盖用户设置）──
      /** CR-024：实际生效的重采样配置。 */
      resampler?: ResamplerConfig
      /** CR-025：dither 档位与“这次量化是否真的加了 dither”。 */
      dither?: DitherConfig
      /** CR-027：引擎实际采用的输出延迟档位。 */
      latencyProfile?: LatencyProfile
      /** CR-028：实际生效的过渡配置。 */
      fade?: FadeConfig
      /** CR-029：实际生效的空间音频配置（active 如实反映是否真的在处理）。 */
      spatial?: SpatialState
    }
  /**
   * CR-017：`reason='error'` 现在也表示「这条曲目引擎打不开，已跳过」。
   * `trackId` 点名是哪一条 —— 应用据此把它标记为无法播放，而不是只留一行日志。
   * `message` 是解码器给的人类可读原因（可选，旧引擎不发）。
   */
  | { ev: 'ended'; trackId: string; reason: 'eof' | 'stop' | 'error'; message?: string }
  | { ev: 'scan_progress'; done: number; total: number }
  /** CR-017：`unplayable` = 解码器拒绝、因而没有入库的文件数（旧引擎不发 ⇒ 0）。 */
  | { ev: 'scan_done'; added: number; failed: number; unplayable?: number; removed?: number; skipped?: number }
  | { ev: 'device_changed'; deviceId: string; name: string }
  /** Transient notification; count is the current session total, not a delta. */
  | { ev: 'xrun'; count: number; bufferMs: number }
  /**
   * CR-015（owner 已接受，2026-10-16）：实时电平监测。
   * 主进程通过 set_meter 同步「窗口可见 **且** 当前视图真有 meter 消费者」；播放且消费者存在时按控制循环节拍（实测约 60–70 Hz）推送。
    * CR-022（待 owner 裁定，2026-10-17）：waveform **默认不再发送**（应用侧从来没有消费者，单帧 73.6% 的字节都是它），
    * dB 类数值收敛到 0.1 dB。字段保留为可选是为了兼容旧引擎 / 回滚；新渲染层不要依赖它。
   * 它**不改样本**，因此不进 dspModules、
   * 也不影响 outputPerfect。频谱是 32–64 个对数频段（不是 FFT 的 1024 个 bin）。
   * 阵列按声道；mono 源长度为 1，**不复制成两份**。
   */
  | {
      ev: 'meter'
      rmsDb?: number[]
      peakDb?: number[]
      peakHoldDb?: number[]
      truePeakDb?: number[]
      /** 'oversampled' = 真过采样测出；'sample' = libebur128 在 ≥192 kHz 不建插值器，真峰值退化为样本峰值，必须如实标注。 */
      truePeakBasis?: 'oversampled' | 'sample'
      /** 400 ms 的 Momentary（EBU R128）。Short-term 与 Integrated 走离线扫描，不在这里。 */
      lufsMomentary?: number
      /** 限幅器对处理路径实际施加的最大增益衰减；0 dB 表示该帧未限幅。 */
      gainReductionDb?: number
      /** 对数频段幅度。CR-015 未固定单位与频段边界；应用侧按 dB、20 Hz–20 kHz 等对数间距处理（见 meterStore）。 */
      spectrum?: number[]
      /** CR-022：新引擎不再发送（应用侧无消费者）；保留可选以兼容旧引擎。 */
      waveform?: Array<[number, number]>
    }
  /** 离线响度扫描的进度（引擎按 ~250ms 节流，不是每片都发）。 */
  | { ev: 'loudness_progress'; done: number; total: number; chunks: number }
  /**
   * 离线响度扫描完成。replyId 对应 analyze_loudness 的异步回复 ——
   * 中间插了别的命令也能对上号（与 CR-007 同一原则）。
   * data.album.ok=false + reason 是「异步扫描不提供专辑增益」的明确拒绝，不是错误。
   */
  | { ev: 'loudness_done'; replyId: number; data: LoudnessScanData }
  | { ev: 'log'; level: string; message: string }
  | { ev: 'fatal'; code: string; message: string }

// ── CONTRACT §4.3 歌词归一化格式（冻结 —— 动画层只认这一个） ──

export interface LyricWord {
  text: string
  startMs: number
  endMs: number
  /**
   * 注音/振假名（CR-018 待裁定；**只增不改**）。
   *
   * 冻结的 §4.3 只有行级 romanization，而 AMLL TTML 的 ruby 是**按字**标注的：
   * `<span tts:ruby="container"><span tts:ruby="base">所</span>…<span tts:ruby="text">しょ</span></span>`。
   * 行级字段装不下它，塞进 text 又会污染「words 拼接 === text」这条渲染不变式。
   * 所以加一个**可选**字段：不认识的消费者直接忽略，旧数据一个字节都不用改。
   */
  ruby?: string
}

export interface LyricLine {
  startMs: number
  endMs: number
  words: LyricWord[]
  text: string
  translation?: string
  romanization?: string
  background?: boolean
}

export interface Lyrics {
  lines: LyricLine[]
  /** true=数据源原生字级；false=行级数据（本方未插值或插值合成）。必须如实标注 */
  wordByWord: boolean
  /**
   * 'netease-lrc' 是本项目对冻结枚举的**追加请求**（见 CR-018）：
   * 实测网易云 /api/song/lyric 只给行级 lrc + tlyric + romalrc，**没有 yrc**，
   * 把它标成 'netease-yrc' 就是谎报词级来源。枚举只增不改，旧值语义不变。
   */
  source: 'amll-ttml' | 'netease-yrc' | 'netease-lrc' | 'qq-qrc' | 'lrclib' | 'local' | 'embedded'
}