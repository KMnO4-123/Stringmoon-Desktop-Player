#pragma once
// Player: the playback state machine and the owner of the three threads.
//
// Thread map (SPEC 3.2), all three real here:
//   control (the caller thread)   - commands, state machine, position events
//   render  (inside WasapiOutput) - lock-free pull from the ring, gain, xruns
//   decode  (feeder worker)       - decode + resample + fill the ring
//
// Only the control thread mutates state_, and every command is applied at an
// audio-block boundary: the ring is flushed through the render thread, which is
// parked first. That is why no lock is needed on the RT path.
//
// The feeder is where decode and resampling happen, on purpose. The render
// thread must never decode: dr_flac allocates, and SoXR allocates, and both
// would be real-time violations (SPEC 3.2).

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "audio_source.hpp"
#include "catalog.hpp"
#include "output_wasapi.hpp"
#include "ring_buffer.hpp"

namespace te {

class App;

enum class PlayState { Stopped, Playing, Paused };
enum class RepeatMode { Sequential, RepeatOne, RepeatAll, Shuffle };

// The wire spelling, kept beside the enum it describes so the two cannot drift.
// A UI shows this string; the enum values themselves are internal.
inline const char* repeatModeName(RepeatMode mode) {
    switch (mode) {
        case RepeatMode::RepeatOne:  return "one";
        case RepeatMode::RepeatAll:  return "all";
        case RepeatMode::Shuffle:    return "shuffle";
        case RepeatMode::Sequential:
        default:                     return "sequential";
    }
}

class Player {
public:
    explicit Player(App& app);
    ~Player();

    Player(const Player&)            = delete;
    Player& operator=(const Player&) = delete;

    // Must be called before any playback command. Opening the output can fail,
    // and CONTRACT 3.4 allows ERR_DEVICE only when no mode works at all.
    void initialise(const std::string& preferredDeviceId);
    void reopenOutput(const std::string& deviceId, int bufferMs = 0);

    // SPEC 3.3 / CONTRACT 3.2: what the user asked the output to be.
    // Auto tries exclusive and degrades to shared, which is expressed through
    // state.outputMode + bitPerfect, never as an error (CONTRACT 3.4).
    void setOutputMode(OutputMode mode) { requestedMode_ = mode; }
    OutputMode outputMode() const      { return requestedMode_; }
    static const char* outputModeName(OutputMode mode);

    // --- fixed output sample rate (0 = follow the source) ---------------------
    //
    // The exclusive path opens at the SOURCE rate by default, which is what
    // bit-perfect means. A user may still ask for a specific stream rate (the
    // DAC is happiest at 192 kHz, or the material is 44.1 and they want the
    // converter in the DAC to do less work). That request is honoured by putting
    // the resampler in the path and opening the stream at the requested rate;
    // outputPerfect then reports false with reason "resampled", because it is a
    // conversion and the contract's rule is to SAY what happened, not to refuse.
    //
    // Shared mode cannot honour it: WASAPI shared always runs at the endpoint
    // mix format. The request is kept (and reported) so the interface can show
    // "asked 192 kHz, stream is 48 kHz" instead of pretending the setting took.
    void setOutputRate(int rate) { forcedOutputRate_ = rate > 0 ? rate : 0; }
    int  requestedOutputRate() const { return forcedOutputRate_; }

    // --- CR-024 resampler quality / phase / steep -----------------------------
    //
    // 默认 VHQ + 线性相位 + 非 steep，与既定链路逐字节等价。播放中改动会
    // "停流 → 重建 SoXR → 从同一源码帧继续"（≤100ms），appliedNow 如实说明；
    // 没有加载源码或没有打开输出时只记录，下次 open 生效。
    // 重建失败必须回滚旧配置并返回 false（调用方报 ERR_INTERNAL），不得静默降级。
    bool setResampler(const ResamplerConfig& config, bool& appliedNow, std::string& error);
    const ResamplerConfig& resamplerConfig() const { return resamplerConfig_; }

    // --- CR-027 output latency profile ---------------------------------------
    // balanced = 既有自适应行为（默认，逐点等价）；stable/lowLatency 见 StreamRequest。
    // 只影响下一次 open/reopen 的 buffer 目标；要立即生效由 App 走 reopenOutput。
    void setLatencyProfile(LatencyProfile profile) { latencyProfile_ = profile; }
    LatencyProfile latencyProfile() const { return latencyProfile_; }

    // --- CR-028 transport fade / pause-hold（V3 §1.1）------------------------
    // fadeMs：淡入淡出时长 0–50ms（默认 10；0 = 关掉淡变）。pauseHold：暂停不拆流
    // （淡出到 0 后保持 stream 打开渲染静音，恢复只做 fadeIn 不 Start）。两者都只
    // 影响后续动作，对当前正在播的流无副作用；state 会如实回读。
    void setFadeMs(int milliseconds);
    int  fadeMs() const { return fadeMs_; }
    void setPauseHold(bool on) { pauseHold_ = on; emitState(); }
    bool pauseHold() const { return pauseHold_; }

    // --- CR-029 spatial audio -------------------------------------------------
    // mode: off/crossfeed/wide/virtual；amount 0..1（0 = 等价 off）；azimuth -90..90；
    // delayMs 0..1（crossfeed 对侧延迟）。virtual 需要 2 个 HRIR bank，在控制线程
    // 构建（失败时回滚旧参数并让 App 报 ERR_STATE，不谎称生效）。
    bool setSpatial(SpatialMode mode, float amount, float azimuth, float delayMs,
                    std::string& error);
    Json spatialJson() const;
    SpatialMode spatialMode() const { return dspParams_.spatialMode; }
    float spatialAmount() const { return dspParams_.spatialAmount; }
    float spatialAzimuth() const { return dspParams_.spatialAzimuth; }
    float spatialDelayMs() const { return dspParams_.spatialDelayMs; }

    // --- CR-025 dither mode ---------------------------------------------------
    //
    // 默认 tpdf = 上一轮链路（平直 TPDF，只在整数输出且丢位宽时生效）。
    // 换档不需要重开流：量化点每块读一次模式；off 时整数输出不加抖动（安全钳位仍在）。
    void setDitherMode(DitherMode mode);
    DitherMode ditherMode() const { return ditherMode_; }
    // 当前打开的流是否真的在加 dither（state.dither.active 的唯一来源）：
    // 只有「模式非 off + 流是整数 + 输出位深低于源有效精度」三者同时成立才为真。
    bool ditherActive() const;

    bool openTrack(const Track& track, std::string& error)
    {
        return openSourcePath(track.path, track.id, error);
    }

    // CR-016: opens a source straight from a URL, with no catalog entry. The
    // URL is only ever a PATH handed to the reader -- audio samples never
    // travel over stdio (CONTRACT 3.2, iron rule 2). Range, authorization and
    // re-signing stay the loopback proxy's job; a transport failure stops
    // playback and is reported rather than being mistaken for end of stream.
    // trackId stays empty: the catalog simply has no row for a streamed URL.
    bool openUrl(const std::string& url, std::string& error)
    {
        return openSourcePath(std::filesystem::path(fromUtf8(url)), std::string(), error);
    }
    bool play(std::string& error);
    void pause();
    void stop();
    bool seek(long long positionMs, std::string& error);
    void setVolume(float volume);

    // Mute is independent of volume: the stored volume is untouched, so the UI
    // can keep showing the level the user chose while the output is silenced.
    void setMuted(bool on);
    bool muted() const { return muted_; }
    // Control thread only: visibility gates events, never the sample path.
    // 实现放在 player.cpp：从"不可见"回到"可见"时要复位分析器状态（E2），
    // 这个转换是 player 的职责，不是一行的赋值。
    void setMeterEnabled(bool enabled);
    bool meterEnabled() const { return meterEnabled_; }
    // The level the user chose, which muting does NOT change. A UI shows this
    // value next to the mute control, so mute never has to pretend to be 0.
    float volume() const { return pendingVolume_; }

    // --- the M2 quality chain (SPEC 1.1 / 3.4) --------------------------------
    //
    // The player owns the parameters rather than the output, because they must
    // survive a stream reopen: the exclusive fallback, a device change and the
    // buffer-doubling recovery all tear the stream down, and losing the user's
    // EQ every time one of those fires would be unforgivable.
    const DspParams& dspParams() const { return dspParams_; }

    // --- CR-031 limiter -------------------------------------------------------
    // 四个参数都是"省略 = 保持当前值"，与 set_channels / set_spatial 一致。
    // 越界拒绝而不是 clamp：调用方给了 +40 dB 不是想被截到 0。
    // lookaheadMs = 0 是默认值，走既有逐样本算法（selftest 有等价回归）。
    bool setLimiter(bool enabled, float ceilingDb, float releaseMs, float lookaheadMs,
                    std::string& error);
    // 当前 lookahead 实际延迟的帧数（0 表示没开 lookahead）。回读用。
    int limiterLatencyFrames() const;
    void setEqEnabled(bool on);
    // Returns false and fills error when the band index or gain is out of range,
    // so the protocol layer can refuse a bad request instead of silently
    // clamping it to something the caller did not ask for.
    bool setEqBand(int band, float gainDb, std::string& error);
    // CR-019: per-band shape. A value of 0 (freq) or 0 (q) resets that slot to
    // the SPEC 3.4 default, and type 0 is peaking -- so clearing a band is the
    // same call as keeping the old behaviour.
    bool setEqBandFreq(int band, float freqHz, std::string& error);
    bool setEqBandQ(int band, float q, std::string& error);
    bool setEqBandType(int band, int type, std::string& error);
    // CR-020: FIR / room correction. Loading builds the spectra on the control
    // thread; enabling is a parameter, so it rides the normal snapshot.
    bool loadIr(const std::string& path, std::string& error);
    bool setIrEnabled(bool enabled);
    bool setIrPreamp(float db);
    // 是否已加载响应：set_ir {enabled:true} 在没有响应时必须被拒绝（见 App 层）。
    bool irLoaded() const { return irBank_ != nullptr; }
    bool setEqQ(float q, std::string& error);
    void setEqPreamp(float preampDb);
    void setAutoHeadroom(bool on);
    bool setReplayGainMode(const std::string& mode, std::string& error);

    // --- channel tools -------------------------------------------------------
    // Each validates and refuses rather than clamping, for the reason the EQ
    // setters do: a caller asking for +40 dB of balance has a bug, and silently
    // giving it the maximum hides that behind a plausible result.
    bool setBalance(float balance, std::string& error);
    void setMono(bool on);
    bool setStereoWidth(float width, std::string& error);
    bool setMidGain(float gainDb, std::string& error);
    bool setSideGain(float gainDb, std::string& error);
    void setCrossfeedEnabled(bool on);
    bool setCrossfeedPreset(int preset, std::string& error);
    bool setCrossfeedFcHz(float frequency, std::string& error);
    bool setCrossfeedFeedDb(float feedDb, std::string& error);
    void setSwapChannels(bool on);
    bool setChannelGain(int channel, float gainDb, std::string& error);
    // --- CR-026: channel tools extension -------------------------------------
    // monoMode: 0 off / 1 sum / 2 left / 3 right；旧 setMono 与它保持语义一致。
    bool setMonoMode(int mode, std::string& error);
    // 三频段 L/R 增益：band 0=low(<200Hz) 1=mid(200-2k) 2=high(>2k)，范围 -6..+3 dB。
    bool setBandGain(int band, int channel, float gainDb, std::string& error);
    // 每声道延迟 0..10 ms；0 = 旁路。
    bool setChannelDelay(int channel, float delayMs, std::string& error);
    void setReplayGainValues(float trackGainDb, float albumGainDb, float preampDb,
                             float trackPeak, float albumPeak, bool preventClip);
    bool skipNext(std::string& error, bool userInitiated);
    bool skipPrevious(std::string& error, bool userInitiated);
    // CR-030：keepCurrent 让队列重排（拖拽/删除/排序）后 queueIndex 仍指向正在
    // 播放的那首；找不到（例如它是队列外点开的单曲）则 queueIndex = -1 如实报告。
    void setQueue(const std::vector<std::string>& trackIds, bool keepCurrent = false,
                  const std::string& currentTrackId = std::string());
    bool advanceQueue(std::string& error);
    // True when the loaded track is the one the queue points at.
    // -1 means the loaded track is NOT a queue member, which is a real and
    // common state: the user double-clicked a track outside the queue. It used
    // to be a size_t, so that state had no representation and the index silently
    // kept its previous value -- the UI would highlight the wrong queue row.
    void noteTrackIsFromQueue(int index) { queueIndex_ = index; }
    int queueIndex() const { return queueIndex_; }
    const std::string& queuedTrackId() const;
    void setRepeatMode(RepeatMode mode) { repeatMode_ = mode; }
    RepeatMode repeatMode() const       { return repeatMode_; }
    const std::vector<std::string>& queue() const { return queue_; }

    // Called from the control loop. Emits position events at the contract
    // cadence and reports end of stream. Returns true when the current track
    // ran out, filling endedTrackId.
    bool tick(long long elapsedMs, std::string& endedTrackId);

    PlayState state() const { return state_; }

    // CR-007: the playback session id.
    //
    // Assigned by the ENGINE, incremented on every open, and carried on the
    // open reply and on every state / position / ended event that belongs to
    // that session. Without it, a client cannot tell a late event from the
    // session it just replaced: replaying one track twice, or clicking next
    // twice quickly, produces two sessions whose trackId is either identical
    // or arrives out of order. The client was left guessing from timing.
    //
    // It lives in the engine because only the engine knows which stream an
    // event came from; a client-side counter is a guess about ordering.
    long long operationId() const { return operationId_; }
    const std::string& currentTrackId() const { return currentTrackId_; }

    // Whether a source is loaded at all, which is NOT the same question as
    // "does it have a trackId".
    //
    // CR-016 opens an HTTP URL that has no catalog entry, so its id is
    // legitimately EMPTY while the stream is perfectly playable. Every guard
    // that used `currentTrackId().empty()` to mean "nothing is open" therefore
    // refused to play or seek a URL source -- the one thing the URL branch
    // exists to allow. Identity and loadedness are separate facts and are
    // spelled separately here.
    bool hasSource() const { return sourceLoaded_; }

    // The decoder's measured source format for the stream that is open. For a
    // catalog track this agrees with its metadata; for a URL open there is no
    // catalog entry, so this is the only honest source for the format numbers
    // the open reply and the state event report.
    int sourceSampleRate() const { return trackSampleRate_; }
    int sourceBitDepth() const   { return trackBitDepth_; }
    // CR-032：解码器实际交付的源格式（"pcm" / "dsd"）与 DSD 源率。open 回复
    // 对 DSD 必须用解码器的实测值：TagLib 对 DSF/DFF 报的是 1-bit 率 2822400
    // 与位深 1，而播放链交付的是抽取后的 176400/24 —— 两个数字都是真的，但
    // 回复里那个字段的语义是"这次播放的源"，只能是后者。
    const char* sourceFormat() const { return sourceFormat_; }
    int sourceDsdRate() const { return dsdRate_; }

    long long positionMs() const;
    long long durationMs() const;

    // Builds the state event payload (CONTRACT 3.3). That event is the
    // authoritative value; the UI must not infer playback state itself.
    Json stateEventJson() const;
    // The full DSP state, for get_state and for the set_* replies. Kept out of
    // the periodic state event on purpose: it is 10 numbers plus a mode that
    // cannot change between events, and that event is emitted ten times a second.
    Json dspJson() const;

    bool outputAvailable() const { return output_.isOpen(); }
    const OutputStatus& outputStatus() const { return output_.status(); }
    const std::string& outputError() const { return outputError_; }

    // E10：独占协商结果缓存的失效入口。set_output（模式/设备/速率变化）、
    // 设备热插拔、显式重开设备时必须调用——缓存只对「同一台设备的同一格式」成立，
    // 跨设备复用会谎报能力。正常切歌不清缓存，那正是它存在的意义。
    void invalidateOutputCapabilities();

    // Device stream format, so the caller can tell whether a track can be
    // played as-is or has to go through the resampler.
    int outputSampleRate() const { return output_.status().sampleRate; }
    int outputChannels() const   { return output_.status().channels; }

    // True only when the whole chain passes the stored integers through
    // untouched: exclusive stream, at the source rate, with no converter and no
    // gain applied.
    // --- the double-state model (CR-010) -------------------------------------
    //
    // One boolean was answering two different questions and giving one of them
    // the wrong answer. These three separate them, and each is computable from
    // facts the engine already has:
    //
    //   pcmPassthrough  FORMAT question: is the delivered PCM format identical
    //                   to the decoded format? A 24-bit source packed into a
    //                   24-in-32 container is NOT passthrough, even though the
    //                   audio is identical -- the container changed.
    //   outputPerfect   CHAIN question: no volume change, no DSP, no resample,
    //                   and the samples delivered equal the stored samples.
    //   sourceExact     FILE question: outputPerfect AND the source itself is
    //                   lossless. A lossy file can be output-perfect, which the
    //                   single boolean could not express at all.
    bool pcmPassthrough() const;
    bool outputPerfect() const;
    bool sourceExact() const;
    // Why the chain is not output-perfect. Human-readable: it is displayed.
    std::string outputNotPerfectReason() const;

    // CONTRACT compatibility alias, equal to outputPerfect(). Kept because the
    // UI, the state trace fixture and 256 driver assertions already read it, and
    // a rename would be a protocol break for a value that did not change meaning
    // -- what changed is that the OTHER two facts are now stated instead of being
    // implied by a single boolean that could not express them.
    bool isBitPerfect() const { return outputPerfect(); }

    const char* renderStageDescription() const;

private:
    void startFeeder();
    void stopFeeder();
    // The one open path, shared by the catalog (`trackId`) and URL (CR-016)
    // entry points. A local file and an HTTP stream differ ONLY in where the
    // bytes come from, so every decision below it -- format negotiation,
    // resampler setup, ring sizing, the operationId bump -- must be identical
    // for both. An empty trackId marks a source the catalog does not know.
    bool openSourcePath(const std::filesystem::path& sourcePath, const std::string& trackId,
                        std::string& error);
    bool handleInputFailure();
    // Active playback fades out (等功率余弦，默认 10ms，见 CR-028) before a
    // manual change, pause, or stop. Waits for the ramp to COMPLETE, because a
    // fade the stream never reaches is not a fade.
    // overrideMs > 0 时用这个时长（seek 用 5ms 短淡出），否则用 fadeMs_。
    void fadeOutBeforeStop(int overrideMs = -1);
    // V3 §1.1b：暂停不拆流（hold）。返回 false 时调用方回退到 fadeOut+stop()。
    bool beginPauseHold();
    // CR-029：按当前 dspParams_ 构建/清除 virtual 的 HRIR bank（控制线程）。
    bool ensureSpatialBanks(std::string& error);
    void feederLoop();
    void resetPlaybackBuffers(uint64_t startFrame);
    // Both audio threads must be parked. Moves decoder, resampler and clocks
    // together so a visible reset can never leave playback at the old position.
    bool resetSourcePosition(uint64_t frame, std::string& error);
    void armExclusiveWatchdog();

    // A stream that STOPS is as invisible as one that never started, and the
    // exclusive watchdog only ever caught the second kind: it disarms itself the
    // moment the device signals once. A 30-minute SPEC 9 soak found the gap --
    // after an adaptive-buffer reopen the position froze for the last four and a
    // half minutes while state stayed "playing" and every command still answered
    // in 2 ms. Nothing anywhere said the music had stopped.
    void serviceRenderLiveness(long long nowMs);
    uint64_t  lastLiveFrames_   = 0;
    long long lastLiveChangeMs_ = 0;
    int       stallRecoveries_  = 0;
    // Fixed output rate requested by the client; 0 means "follow the source".
    int       forcedOutputRate_ = 0;
    // CR-024: 重采样器档位。默认值 = 既有链路（VHQ/linear/非 steep）。
    ResamplerConfig resamplerConfig_{};
    // CR-025: dither 档位。默认 tpdf = 既有链路。
    DitherMode ditherMode_ = DitherMode::Tpdf;
    // CR-027: 输出延迟档位。默认 balanced = 既有自适应行为。
    LatencyProfile latencyProfile_ = LatencyProfile::Balanced;
    // CR-028（V3 §1.1）：淡变时长与 pause-hold 开关。默认 10ms / 开启。
    int  fadeMs_    = 10;
    bool pauseHold_ = true;
    // verifier：淡出排空 deadline 超时的累计次数（结构性证据，独立于音频设备）。
    unsigned fadeDrainTimeouts_ = 0;
    // CR-029：virtual 的两个 HRIR bank。渲染线程只读指针；替换时旧 bank 留在
    // retiredSpatial_ 里（与 IR 的 retiredIr_ 同一约定：至少能活过当前块）。
    std::vector<std::unique_ptr<IrBank>> spatialBanks_;
    std::vector<std::unique_ptr<IrBank>> retiredSpatial_;
    // Returns true when an exclusive stream must be abandoned and re-opened in
    // shared mode, filling the reason.
    bool checkExclusiveWatchdog(long long elapsedMs, std::string& degradeReason);
    void emitState();
    bool emitMeter();

public:
    // DESIGN-A 3.1: dspActive and dspModules are part of the authoritative state
    // event, which the UI draws C2 from. A change that is not announced is a
    // change the interface cannot show, so every DSP mutation ends with one
    // state event -- the same contract setVolume already honours for bit-perfect.
    void announceDspChange() { emitState(); }

    // Closes the audio device now, synchronously. Called on the shutdown path
    // so the WASAPI client is released while the engine is still fully alive
    // instead of during process exit, where a fault would be attributed to
    // teardown and the audio service rather than to anything actionable.
    // SPEC 3.3: the device disappeared or the default changed. Releases the
    // stream and reopens it, keeping the SOURCE position -- expressed in source
    // frames, because a rate change makes device frames meaningless. Returns
    // false when neither the requested device nor the default can be opened, and
    // the caller reports that as a device error.
    bool reopenForDeviceChange(const std::string& preferDeviceId, std::string& error);

    void releaseOutput() {
        stop();
        output_.close();
    }

    // Releases the DECODER as well as the stream. Added with the MP4 path: a
    // Media Foundation source reader must be gone before MFShutdown, and letting
    // App's destructor do it puts the release inside the process-exit window --
    // which is precisely where the WASAPI client produced a 0xC0000005 that a
    // fully green suite never saw.
    void releaseSource();

private:

    App&         app_;
    WasapiOutput output_;
    PlanarRing   ring_;

    // Decode side (feeder thread). Guards the source/resampler against the
    // control thread swapping them during open or seek.
    std::unique_ptr<AudioSource> source_;
    std::unique_ptr<Resampler>   resampler_;
    std::thread                  feederThread_;
    std::atomic<bool>            feederRun_{false};
    // Publishing to the output is the one place the chain's lock-free hand-off
    // is triggered, so every setter funnels through here.
    void publishDsp() { output_.publishDsp(dspParams_); }

    DspParams                    dspParams_{};
    // The player owns the loaded IR. Retired banks are released only after two
    // replacements, because the render thread reads the pointer for one block
    // after a swap (see DspChain::publishIr).
    std::unique_ptr<IrBank>      irBank_;
    std::vector<std::unique_ptr<IrBank>> retiredIr_;
    // Whether the file's own codec is lossless. Set at open from
    // AudioSource::lossless(), so it is the decoder's answer and not a guess
    // from the file extension. The default is only what an unopened stream
    // reports; it is never what a playing one reports.
    bool                         trackLossless_ = true;
    // CR-032：源格式（"pcm" / "dsd"）与 DSD 源率。从解码器拿，不从扩展名猜
    // —— .dsf 也可能是一个坏文件，只有打开成功的那一侧才知道它是什么。
    const char*                  sourceFormat_ = "pcm";
    int                          dsdRate_ = 0;
    // Starts at 1 so that 0 in a payload is unambiguous: it can only mean
    // 'no session', never 'the first one'.
    long long                    operationId_ = 0;
    // Highest xrun total already reported as an event, so each new underrun is
    // announced exactly once (DESIGN-A 4).
    unsigned                     lastReportedXruns_ = 0;
    std::atomic<uint64_t>        deliveredFrames_{0};   // source frames consumed, cumulative
    // Set by the feeder when the DECODER says it has nothing left, cleared when
    // it produces frames again. This is the difference between "the file's
    // header says there should be more" and "there is more": a FLAC whose
    // STREAMINFO declares more samples than the stream actually contains is not
    // hypothetical -- one track in this very library is 23,040 frames (523 ms)
    // over-declared, and treating the declaration as the truth hung the engine
    // at the end of that track in three consecutive 30-minute soaks.
    std::atomic<bool>            inputExhausted_{false};
    bool                         restartAfterEof_ = false;
    std::atomic<bool>            inputFailed_{false};
    std::string                  inputFailureReason_;
    // Frames of the CURRENT stream queued for the device. Compared against the
    // device's finished count to decide end-of-stream; reset with the ring.
    std::atomic<uint64_t>        fedFrames_{0};

    std::mutex                   sourceMutex_;

    // Feeder 空闲等待（E10 附属的播放性能项）：原来 ring 满/输入排空/源失败/无
    // resampler 四处都是 sleep_for(2–3ms) 轮询。在 Electron 会话里系统定时器分辨率
    // 常是 1ms，这等于每秒最多 500 次空唤醒；改成条件变量定时等待（20–30ms）后降到
    // 几十次，而 ring 里始终有 250ms 余量、单次 pull 4096 帧（85ms@48k），不会饿死。
    // 通知只来自控制线程：渲染线程（消费者）绝不能 syscall/加锁，它不解锁任何东西。
    std::mutex              feederMutex_;
    std::condition_variable feederCv_;
    void waitFeeder(int milliseconds);
    void notifyFeeder();

    // E10：独占协商结果缓存。auto 模式按「端点 id + 本次要协商的流格式」记住
    // 「该端点不接受该格式的独占」的结论与原因；同一设备同一格式的下一首不再
    // 重复协商（一次失败要建 COM 枚举器、探测 4 个格式候选、再回落 shared，
    // 实测占 open 延迟的 100–300ms，是切歌延迟的主因）。设备变化或显式 set_output
    // 时由 invalidateOutputCapabilities() 清空。
    std::unordered_map<std::string, std::string> exclusiveRefusals_;
    std::string              exclusiveCacheDevice_;
    std::string              exclusiveKey(int streamRate, int bitDepth, int channels) const;

    PlayState             state_ = PlayState::Stopped;
    std::string           currentTrackId_;
    std::filesystem::path currentPath_;
    // "A source is loaded", which stays TRUE for a URL open whose trackId is
    // empty (CR-016). Deliberately not derivable from currentTrackId_.empty():
    // conflating the two is exactly what made play/seek refuse URL sources.
    bool                  sourceLoaded_ = false;
    int                   trackSampleRate_ = 0;
    int                   trackChannels_   = 0;
    int                   trackBitDepth_   = 0;
    uint64_t              trackTotalFrames_ = 0;

    std::atomic<uint64_t> framesRendered_{0};   // the render thread advances this
    uint64_t              seekBaseFrame_ = 0;   // playback clock origin
    long long             lastEmitMs_    = -1;

    std::vector<std::string> queue_;
    int                      queueIndex_ = -1;
    RepeatMode               repeatMode_ = RepeatMode::Sequential;
    // The user-facing default is automatic: try the source format in exclusive
    // mode and fall back to shared only when the endpoint refuses it. Startup
    // still opens a shared device before a source is known; the first track then
    // negotiates the requested mode in openSourcePath().
    OutputMode               requestedMode_ = OutputMode::Auto;
    MeterAnalyzer             meterAnalyzer_;
    int                       meterPreparedRate_ = 0;
    int                       meterPreparedChannels_ = 0;
    long long                 lastMeterEmitMs_ = 0;
    bool                      meterEnabled_ = false;
    // The stream format the output is currently open with. Exclusive mode only
    // opens at the source rate, so this is what decides whether a track needs a
    // stream rebuild.
    int                      openedRate_     = 0;
    int                      openedChannels_ = 0;
    int                      openedBitDepth_ = 0;
    std::string              outputError_;
    bool                     endOfStreamReached_ = false;
    // SPEC 3.3 requires a fallback chain: exclusive fails -> shared. A stream
    // that initialises but never delivers a frame IS such a failure, and it is
    // the worst kind because everything reports success while the user hears
    // silence. These two fields drive the watchdog that catches it.
    bool                     exclusiveWatchdogArmed_ = false;
    long long                playingSinceMs_ = 0;
    float                    pendingVolume_ = 1.0f;
    bool                     muted_ = false;
};

} // namespace te