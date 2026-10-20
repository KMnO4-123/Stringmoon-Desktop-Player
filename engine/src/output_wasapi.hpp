#pragma once
// WASAPI output backend: shared and exclusive.
//
// M2. The shared path (M1) proves it makes sound; this is where it starts
// making sound correctly, which SPEC 1.1 calls the one difference this project
// exists for.
//
// The two modes are genuinely different plumbing, not a flag:
//
//   SHARED     the device mix format, through the OS mixer, with the engine
//              resampling to the device rate. Never bit-perfect.
//   EXCLUSIVE  the stream is opened AT THE TRACK OWN RATE AND DEPTH with no
//              mixer in the path, so the integer samples reach the device
//              exactly as stored. This is what bit-perfect means, and it is why
//              exclusive mode forces a stream reopen whenever the rate changes.
//
// Even in shared mode the real-time discipline of SPEC 3.2 is enforced:
//   * the render callback calls the mixer, which copies from a lock-free ring
//     and applies gain. No locks, no allocation, no logging, no system calls.
//   * the control thread only ever touches atomics: a handful of scalars and a
//     command flag. It never blocks the render thread.
//
// Capability probing (SPEC 3.3) uses IAudioClient3 where available, and the
// reported periods are handed back to the UI. That is the whole point: report
// the landing point the hardware actually reached instead of assuming a
// "3 ms x2" figure the way the previous revision of the spec did.

#include <atomic>
#include <cstdint>
#include <string>

#include "audio_fade.hpp"
#include "convolver.hpp"
#include "dsp.hpp"
#include "gain_smoother.hpp"
#include "endpoint_progress.hpp"
#include "meter.hpp"
#include "ring_buffer.hpp"

// The audio client interfaces stay opaque here: this header is included by
// code that must not see <windows.h>.
struct IAudioClient;
struct IAudioRenderClient;
struct IAudioClock;

namespace te {

// 传输瞬态的公共常量。控制线程（player）与离线模型（--probe-transport）共用，
// 防止两边各写一个数字后漂移——verifier 要靠 probe 的数字判断生产行为。
//
// 为什么是 15 ms：
//   * 旧 stop/seek/切歌用 5 ms 淡出（SPEC 3.7 的旧下限）。5 ms@44.1k 只有 220
//     帧，等功率曲线虽然两端连续，但残响刚归零就 Stop/Reset，驱动侧仍会截断
//     硬件缓冲。用户实测的"切歌/暂停/播放咔一声"就落在这个窗口。
//   * kStopSilencePadMs 是淡出归零之后、Stop/Reset/Close 之前额外写进端点的
//     静音（按流采样率换算帧数），并且要等设备真的播完它。它把"最后一个非零
//     样本"和"硬件时钟/电源切换"隔开，是 USB DAC 上最实用的一条。
// 两者都只影响传输边界，不改变稳态音频路径与 bit-perfect 判据。
inline constexpr int kTransportFadeMinMs = 15;
inline constexpr int kStopSilencePadMs   = 15;

enum class OutputMode {
    Shared,      // always the device mix format
    Exclusive,   // always the source rate and depth
    Auto,        // try exclusive, fall back to shared
};

// CR-027：输出延迟档位（对标 ECHO NEXT 的 stable/balanced/lowLatency）。
// Balanced 是既有自适应行为（bufferMs=0 → 设备默认；3 次 xrun 翻倍，上限 50 ms），
// 必须逐点等价；Stable 向 8192 帧靠、LowLatency 向 1024 帧靠（独占最低 8 ms）。
// V3 §1.1 / verifier：爆音治理的"结构性"证据。设备没有 loopback 时，verifier 只能
// 靠这些计数断言"停流前确实淡出完成、停流后确实 Reset 再 Start、排空没有超时"。
struct TransportTrace {
    int  paddingAtStop    = -1;    // Stop 时端点里还剩多少帧（-1 = 读不到）
    bool fadeCompleted    = false; // 最近一次淡出/Stop 前，淡出是否真的排空完成
    bool resetBeforeStart = false; // 最近一次 Start 前是否做了 Reset（清残留）
    int  silencePadFrames = 0;     // Stop 前实际写进端点的静音帧数（0 = 没写）
};

enum class LatencyProfile { Stable, Balanced, LowLatency };

inline const char* latencyProfileName(LatencyProfile profile) {
    switch (profile) {
        case LatencyProfile::Stable:     return "stable";
        case LatencyProfile::LowLatency: return "lowLatency";
        case LatencyProfile::Balanced:
        default:                         return "balanced";
    }
}

// What the caller wants the stream to carry. Shared mode ignores the rate (the
// device decides); for exclusive it is the whole point.
struct StreamRequest {
    int  sampleRate = 0;    // 0 = take it from the device mix format
    int  channels   = 0;    // 0 = take it from the device mix format
    int  bitDepth   = 0;    // source depth, used to pick the exclusive container
    bool isFloat    = false;
    int  bufferMs   = 0;    // 0 = derive it from the probed device period
    LatencyProfile latency = LatencyProfile::Balanced;   // CR-027
};

// Commands handed from the control thread to the render thread. A plain atomic
// int is enough: the protocol makes each control command idempotent, so a
// command that arrives between two blocks is simply applied at the next block
// boundary (SPEC 3.2: commands are handled at audio block boundaries).
enum class RenderCommand : int {
    None = 0,
    Flush,          // drop whatever is buffered (stop, seek, open)
};

struct OutputStatus {
    std::string deviceId;
    std::string deviceName;
    std::string outputMode;           // "shared" | "exclusive"
    int         sampleRate    = 0;    // device stream rate
    int         channels      = 0;
    int         periodFrames  = 0;    // engine period actually in use
    double      periodMs      = 0.0;  // the tier the UI reports (SPEC 3.3)
    // Underruns are counted per DEVICE BLOCK, not per frame: a starved block
    // produces one audible dropout regardless of how many frames it contained,
    // and SPEC 8.2 states the stability budget as "0 xrun". This used to be
    // incremented inside the per-frame fill loop, which reported 1440 for what
    // was really 3 starved blocks and made the number unreadable.
    std::atomic<unsigned> xrunCount{0};
    // SPEC 3.2: three consecutive underruns double the requested buffer,
    // capped at 50 ms. Reported so the UI can show that it happened.
    int         currentBufferMs = 0;
    // Non-zero when the render thread is alive but the device never raised its
    // buffer event. Kept as a plain value written only by that thread.
    unsigned    renderStarved = 0;
    // How many times the device actually raised its buffer event.
    //
    // This is the ONLY fact that separates 'the stream is open and the device is
    // running' from 'the stream is open and the device never asks for data'.
    // The engine previously inferred the second from 'nothing was rendered',
    // which is a different claim -- a wake with an empty ring renders nothing
    // and still proves the device is alive.
    std::atomic<uint64_t> renderWakes{0};
    // The device mix format, honoured rather than assumed: the render path must
    // write whatever sample type the endpoint asked for.
    int         formatTag        = 0;      // WAVE_FORMAT_*
    int         bitsPerSample    = 0;      // container bits (32/24/16)
    int         validBits        = 0;      // WAVE_FORMAT_EXTENSIBLE valid bits
    int         blockAlign       = 0;      // bytes per frame
    int         bytesPerSample   = 0;
    // The precision the SOURCE asked for. Kept separate from the container
    // because 24-bit audio is normally carried in a 32-bit container with 24
    // valid bits, and that is not a conversion -- comparing container width
    // against valid bits was how the engine wrongly reported itself as not
    // bit-perfect on a stream that was bit-perfect.
    int         sourceBits       = 0;
    bool        isFloat          = false;
    bool        isExclusive      = false;
    bool        mmcssProAudio    = false;  // only granted below 10 ms
    // SPEC 3.3 capability probing: the device's own periods, reported so the UI
    // shows the landing point the hardware reached rather than an assumed one.
    double      deviceDefaultPeriodMs = 0.0;
    double      deviceMinPeriodMs     = 0.0;
    // Why exclusive was not used, when it was asked for. CONTRACT 3.4 wants the
    // degradation expressed through state, so the UI can explain it.
    std::string degradeReason;
};

class WasapiOutput {
public:
    WasapiOutput() = default;
    ~WasapiOutput();

    WasapiOutput(const WasapiOutput&)            = delete;
    WasapiOutput& operator=(const WasapiOutput&) = delete;

    // Opens a render stream. mode is what to TRY: Exclusive and Auto fall back
    // to shared rather than failing, because CONTRACT 3.4 expresses a
    // degradation through state and never as an error. Returns false only when
    // no mode could open the device at all.
    bool open(const std::string& deviceId, OutputMode mode, const StreamRequest& request,
              std::string& error);

private:
    // The body of open(). Split out so open() can be the ONLY success path: this
    // function has two ways to succeed (exclusive and shared), and a diagnostic
    // record attached to one of them silently missed every exclusive stream --
    // the exact streams worth recording. A wrapper cannot be forgotten by a
    // future early return; a second copy of the record can.
    bool openInternal(const std::string& deviceId, OutputMode mode, const StreamRequest& request,
                      std::string& error);

public:

    void close();
    // Control thread after stop(): discard endpoint padding on seek/new source.
    // Pause/resume deliberately retains that padding instead.
    bool resetStream(std::string& error);
    bool isOpen() const { return client_ != nullptr; }

    // Starts the stream. The render thread begins pulling from the ring.
    // The ring is the only audio input. There is deliberately no second source:
    // the render thread pulls from one place, and the feeder is what fills it.
    bool start(PlanarRing& ring, std::atomic<uint64_t>* positionFrames,
               bool fadeIn, std::string& error);

    void stop();

    // Control-thread side; safe to call while playing.
    void setVolume(float v)                { volume_.store(v, std::memory_order_relaxed); }

    // Mute is a SEPARATE state from a zero volume, not an alias for it.
    //
    // Modelling it as "remember the old volume, set 0, put it back" would be a
    // lie to the UI in both directions: the user could not see that the volume
    // they set is still in force, and unmuting could not restore it without the
    // engine keeping a shadow value the protocol never describes.
    //
    // The render thread multiplies by an effective gain of (muted ? 0 : volume),
    // so the existing 10 ms smoothing ramp applies to mute and unmute too --
    // which is exactly what stops it clicking.
    void setMuted(bool on) { muted_.store(on, std::memory_order_relaxed); }
    bool muted() const     { return muted_.load(std::memory_order_relaxed); }
    void setCommand(RenderCommand command) { command_.store(static_cast<int>(command), std::memory_order_release); }
    // CR-025：控制线程发布 dither 档位；渲染线程在下一个整数量化点采用。
    // 换档只影响"量化误差如何整形"，不改变样本增益/直流。
    void setDitherMode(DitherMode mode) { ditherMode_.store(static_cast<int>(mode), std::memory_order_release); }
    DitherMode ditherMode() const { return static_cast<DitherMode>(ditherMode_.load(std::memory_order_acquire)); }
    void requestSilence(bool on)           { silence_.store(on, std::memory_order_release); }

    // --- pause-hold（V3 §1.1b）----------------------------------------------
    // 暂停不再拆流：淡出到 0 后保持 stream 打开、渲染静音；恢复时只做 fadeIn，
    // 不再 Start()。这条路避开的是两件设备层的事：USB DAC/蓝牙在 Stop→Start 时
    // 的电源/时钟切换杂音，以及某些驱动在 Stop 后保留端点缓冲、下次 Start 重播
    // 旧样本（"电流声"的另一种来源）。
    void setHold(bool on) { hold_.store(on, std::memory_order_release); }
    bool isHolding() const { return hold_.load(std::memory_order_acquire); }
    // 恢复：撤掉 hold 与静音，让 RT 线程在下一个 block 开始等功率淡入。
    void endHold(int fadeMs) {
        fadeInMs_.store(fadeMs > 0 ? fadeMs : 0, std::memory_order_release);
        hold_.store(false, std::memory_order_release);
        silence_.store(false, std::memory_order_release);
        wakeRenderThread();
    }
    bool isRunning() const { return running_.load(std::memory_order_acquire); }
    // 保存起来供下一次 start()/beginFadeOut() 使用；控制线程只在流停止时写。
    void setFadeMs(int ms) {
        fadeMs_.store(ms < 0 ? 0 : (ms > 50 ? 50 : ms), std::memory_order_release);
    }
    int fadeMs() const { return fadeMs_.load(std::memory_order_acquire); }
    // fade 排空超时累计（控制线程等待淡出被设备播完的 deadline 次数）。
    void noteFadeDrainTimeout() { fadeDrainTimeouts_.fetch_add(1, std::memory_order_relaxed); }
    unsigned fadeDrainTimeouts() const { return fadeDrainTimeouts_.load(std::memory_order_relaxed); }
    TransportTrace transportTrace() const {
        TransportTrace trace;
        trace.paddingAtStop    = tracePaddingAtStop_.load(std::memory_order_acquire);
        trace.fadeCompleted    = traceFadeCompleted_.load(std::memory_order_acquire);
        trace.resetBeforeStart = traceResetBeforeStart_.load(std::memory_order_acquire);
        trace.silencePadFrames = traceSilencePadFrames_.load(std::memory_order_acquire);
        return trace;
    }

    // A short fade to silence before active playback stops or changes tracks.
    //
    // SPEC 3.7 line 237 requires a 5 ms fade for manual track changes. Pause and
    // stop use the same ramp because they can also interrupt a nonzero sample.
    //
    // Synchronous on purpose: it must COMPLETE before stop() tears the stream
    // down, or the fade never reaches the device. The render thread publishes how
    // far it has got so the caller can wait for the ramp instead of guessing at a
    // sleep, which would break on a loaded machine.
    void beginFadeOut(int milliseconds);
    // True until the fade ramp has played through the endpoint buffer. The
    // caller polls this with a deadline rather than assuming a fixed duration.
    bool fadeOutPending() const { return fadeActive_.load(std::memory_order_acquire); }

    // Tells the render thread that the feeder has delivered the whole track.
    // From that moment a starved block is the END OF THE TRACK, not an underrun:
    // counting it as one made every track report 3 xruns as it finished, which
    // then tripped the adaptive-buffer rule and reopened the stream for nothing.
    void setFeederDone(bool done)          { feederDone_.store(done, std::memory_order_release); }

    // --- the M2 quality chain ------------------------------------------------
    //
    // Published from the control thread and picked up by the render thread at a
    // block boundary. Stored as well as forwarded so that reopening the stream
    // (device change, buffer-doubling recovery, exclusive fallback) re-applies
    // the user's settings instead of reverting them.
    void publishDsp(const DspParams& p) { pendingDsp_ = p; dsp_.publish(p); }
    const DspParams& dspParams() const { return dsp_.params(); }
    bool dspPassthrough() const { return dsp_.isPassthrough(); }
    // CR-029：virtual 模式的 FFT 卷积固有延迟（帧），如实进 state.spatial。
    int spatialLatencyFrames() const { return dsp_.spatialLatencyFrames(); }
    void publishSpatialBanks(const IrBank* bankA, const IrBank* bankB) {
        dsp_.publishSpatialBanks(bankA, bankB);
    }
    float dspGainDb() const { return dsp_.staticGainDb(); }
    // On seek/stop: clear filter and limiter memory so the new position does not
    // start with the previous position's ringing.
    void resetDsp() { dsp_.reset(); }
    // CR-020: impulse-response handover. Same contract as DspChain::publishIr --
    // the caller keeps ownership until the next load.
    void publishIr(const IrBank* bank) { dsp_.publishIr(bank); }
    const IrBank* irBank() const { return dsp_.irBank(); }
    int irLatencyFrames() const { return dsp_.irLatencyFrames(); }
    MeterTap& meterTap() { return meterTap_; }
    const MeterTap& meterTap() const { return meterTap_; }
    float meterGainReductionDb() const { return dsp_.gainReductionDb(); }

    // Frames the device has actually played since start(). This is the clock the
    // position event is built from; it never counts frames still sitting in the
    // engine ring.
    uint64_t playedFrames() const { return playedFrames_.load(std::memory_order_acquire); }

    // Frames the DEVICE has actually finished playing, derived in the render
    // thread as (frames handed to the device) - (current padding).
    //
    // This is the missing half of end-of-stream detection, and it is the whole
    // reason for the derivation. playedFrames() only says what the engine pulled
    // out of its OWN ring; when that ring runs dry, up to one device period is
    // still sitting in the endpoint buffer, unheard. Declaring the end at that
    // moment clips the tail off every track -- inaudible by ear, wrong every
    // single time.
    //
    // Two cheaper-looking measures do NOT work, both verified on this machine:
    //   * IAudioClock::GetPosition is per-stream, so after a seek it restarts at
    //     zero while the device buffer still holds pre-seek audio (this reported
    //     a shortfall of 61 ms and stalled the drain check);
    //   * watching padding == 0 from outside never triggers, because the render
    //     loop refills with SILENCE the moment the ring runs dry -- padding only
    //     reaches zero if the callback is late, which is not the normal case.
    // Subtracting here keeps both numbers in the same instant, from the one
    // thread that owns them.
    uint64_t devicePlayedFrames() const { return endpointProgress_.played(); }
    bool audioDrained(uint64_t framesFed) const { return endpointProgress_.drained(framesFed); }

    // True once the render thread has observed a silence/stop request and parked
    // itself. The control thread waits for this before it mutates the ring or
    // swaps the decoded buffer, which is what makes those mutations safe without
    // putting a lock on the RT path.
    bool renderIdle() const { return renderIdle_.load(std::memory_order_acquire); }

    // The volume the render thread is applying. Read by the player's
    // bit-perfect decision: a gain change is not the stored integers.
    float volume() const { return volume_.load(std::memory_order_relaxed); }

    // True once since the last call when the render thread asked for a larger
    // buffer (SPEC 3.2 adaptive recovery). The control thread polls this and
    // reopens the stream, because the RT thread may not.
    bool takeBufferIncreaseRequest() {
        return needBiggerBuffer_.exchange(false, std::memory_order_acq_rel);
    }
    int  requestedBufferMs() const { return requestedBufferMs_; }

    // Lets the caller record why the requested mode is not in force, so the
    // explanation travels in state rather than being inferred by the UI.
    void setDegradeReason(std::string reason) { status_.degradeReason = std::move(reason); }
    // 控制线程、渲染线程已 park 时调用（open/切歌）：shared 模式不重开流时，
    // dither 判据（ditherApplies）仍需要本曲的真实源位深。只改一个 int，不碰流。
    void setSourceBits(int bits) { status_.sourceBits = bits; }
    // CR-027：控制线程在 open/reopen 之前设置；只影响下一次流的 buffer 目标，
    // 当前正在跑的流不受影响（要生效请 reopen）。
    void setLatencyProfile(LatencyProfile profile) { latencyProfile_ = profile; }
    LatencyProfile latencyProfile() const { return latencyProfile_; }

    const OutputStatus& status() const { return status_; }
    const std::string& lastError() const { return lastError_; }

    // True when the stream in its current state delivers the source integers
    // untouched. Deliberately conservative: every condition that could alter a
    // sample has to hold.
    bool isBitPerfect() const;

private:
    static unsigned long __stdcall renderThreadEntry(void* self);
    void renderLoop();
    // 头文件不能看到 <windows.h>（HANDLE/SetEvent 都属于实现），唤醒渲染线程的
    // 这一步放在 .cpp 里；inline API 只改 atomic 后调用它。
    void wakeRenderThread();
    bool openShared(const std::string& deviceId, const StreamRequest& request, std::string& error);
    bool openExclusive(const std::string& deviceId, const StreamRequest& request, std::string& error);
    void resetStatus();
    // SPEC P4: a Bluetooth sink always runs shared (see the call in open()).
    bool deviceIsBluetooth(const std::string& deviceId) const;
    void releaseAll();

    IAudioClient*       client_       = nullptr;
    IAudioRenderClient* renderClient_ = nullptr;
    IAudioClock*        clock_        = nullptr;
    void*               eventHandle_  = nullptr;   // HANDLE, kept opaque here
    void*               mmcssHandle_  = nullptr;
    void*               threadHandle_ = nullptr;

    PlanarRing*            ring_           = nullptr;
    std::atomic<uint64_t>* positionFrames_ = nullptr;

    std::atomic<bool>     running_{false};
    std::atomic<bool>     renderIdle_{true};
    std::atomic<int>      command_{static_cast<int>(RenderCommand::None)};
    std::atomic<float>    volume_{1.0f};
    std::atomic<bool>     muted_{false};
    std::atomic<bool>     silence_{false};
    // Fade-out request, in place for the render thread. 0 means "no fade".
    std::atomic<int>      fadeOutMs_{0};
    std::atomic<bool>     fadeActive_{false};
    // V3 §1.1：fade 时长（0–50ms，默认 10）、淡入请求（恢复时用）、pause-hold 标志。
    // 全部通过 atomic 交给 RT 线程，控制线程不碰 fade_ 对象本身。
    std::atomic<int>      fadeMs_{kPlaybackRampMs};
    std::atomic<int>      fadeInMs_{0};
    std::atomic<bool>     hold_{false};
    // V3 §1.1 / verifier：结构性计数。fadeRequested/Completed 由控制线程在
    // beginFadeOut/stop 边界读；render 线程在 drain 完成时置 completed。
    std::atomic<bool>     fadeRequested_{false};
    std::atomic<bool>     fadeCompletedFlag_{false};
    std::atomic<unsigned> fadeDrainTimeouts_{0};
    std::atomic<int>      tracePaddingAtStop_{-1};
    std::atomic<bool>     traceFadeCompleted_{false};
    // 淡出后、Stop 前写进端点的静音帧数（render 线程写，控制线程在 stop 时取走）。
    std::atomic<int>      traceSilencePadFrames_{0};
    std::atomic<bool>     traceResetBeforeStart_{false};
    // Render-thread state for the sample-accurate playback ramp.
    AudioFade             fade_{};
    std::atomic<uint64_t> playedFrames_{0};
    // Written by the render thread each callback; read by the control thread to
    // decide whether the device has drained.
    EndpointProgress endpointProgress_;
    // The EQ / ReplayGain / limiter chain. Owned by the control thread, driven
    // sample by sample from the render thread.
    DspChain dsp_{};
    MeterTap meterTap_{};
    bool dspPrepared_ = false;   // changed only while render thread is parked
    DspParams pendingDsp_{};
    // One dither generator + noise-shaping history per channel, seeded per stream.
    // Per channel rather than shared: identical dither on both channels would be a
    // correlated (mono) noise signal, which localises to the centre and is audible
    // as a faint whistle instead of a benign hiss.
    DitherState dither_[DspChain::kMaxChannels];
    // CR-025：当前 dither 模式。控制线程写、渲染线程读；整数量化点据此选择
    // 平直 TPDF / 误差整形的哪一条路径。默认 Tpdf = 上一轮链路。
    std::atomic<int> ditherMode_{static_cast<int>(DitherMode::Tpdf)};
    // Set by the control thread when the decoder has delivered the last frame.
    std::atomic<bool> feederDone_{false};

    // Diagnostic only (TE_RT_TRACE): the render thread records how far it got,
    // so an unhandled exception can be attributed to one call instead of
    // guessed at. Compiled out of a normal build because SPEC 3.2 forbids
    // logging work on the RT path.
#if TE_RT_TRACE
public:
    std::atomic<int> renderStage_{0};
    const char* renderStageName() const;
private:
#endif

    OutputGainSmoother volumeGain_;   // render thread only
    int          consecutiveXruns_   = 0;  // render thread only
    int          requestedBufferMs_  = 0;  // render thread only
    // Set by the render thread when SPEC 3.2's "3 consecutive xruns -> double
    // the buffer" rule fires. Reopening a stream is not something the RT thread
    // may do, so it asks the control thread, which is already polling this flag.
    std::atomic<bool> needBiggerBuffer_{false};
    OutputStatus status_;
    std::string  lastError_;
    LatencyProfile latencyProfile_ = LatencyProfile::Balanced;   // CR-027
    int            maxBufferMs_    = 50;   // 自适应 buffer 上限，按档位在 start() 里设定
    bool         comInitialized_ = false;
};

} // namespace te
