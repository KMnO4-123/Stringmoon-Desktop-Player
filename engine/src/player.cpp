#include "player.hpp"

#include "diag_log.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <random>
#include <vector>

#include "app.hpp"
#include "protocol.hpp"

namespace te {

namespace {

// CONTRACT 3.3 and appendix A: a position snapshot about every 100 ms.
constexpr long long kPositionIntervalMs = 100;

// The feeder keeps roughly a quarter second of audio queued. That is enough to
// absorb a disk hiccup or a resampler hiccup, and small enough that a stop or a
// seek is heard immediately rather than after the buffer drains.
constexpr double kTargetBufferedMs = 250.0;

// How long an exclusive stream gets to produce its first frames before it is
// judged silent. One device period here is 6 ms; 400 ms is long enough that a
// slow disk cannot trip it and short enough that the user hears music, not a
// pause.
constexpr long long kExclusiveStartupGraceMs = 400;

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

const char* stateName(PlayState s) {
    switch (s) {
    case PlayState::Playing: return "playing";
    case PlayState::Paused:  return "paused";
    case PlayState::Stopped: return "stopped";
    }
    return "stopped";
}

} // namespace

// How long a PLAYING stream may fail to advance before it is treated as dead.
//
// Every legitimate pause in this engine is far shorter: a buffer reopen stops
// the render thread for about 50 ms, a seek for a few, and the feeder priming
// does not stop it at all (it writes silence). Two seconds is two orders of
// magnitude above that noise, and still fast enough that a user who loses their
// audio is told within a breath.
constexpr long long kRenderStallMs = 2000;

// Reopening forever is not recovery. After this many attempts in a row the
// engine stops and says so -- a stopped player is honest; a silent one that
// claims to be playing is not.
constexpr int kStallRecoveriesBeforeGivingUp = 2;

namespace {

// SPEC 3.3: 输出端点的打开策略 = 按 ID 打开，失败回退系统默认端点。
//
// 现场证据（本机 2026-10-18，拔掉 USB DAC 后）：端点会先进入不可用状态，几十到
// 几百毫秒后才重新可打开；旧代码对每个候选只 Initialize 一次，失败后引擎就停在
// "没有流"的状态：play() 永远 ERR_DEVICE、set_output 回 ok 但 outputMode 为空、
// 状态里没有原因。用户看到的是"插拔后耳机和扬声器都没声音"。
//
// 这里做两件事，都发生在控制线程，最坏阻塞约 0.4 s（真拔掉时）：
//   1) 每个候选端点重试一次、间隔 120 ms，覆盖热插拔后的短暂不可用窗口；
//   2) 请求的端点确实打不开时回落到系统默认端点——否则用户显式选中的、已拔掉的
//      DAC 会把输出锁死在一个永远打不开的 ID 上。
constexpr int kOutputOpenAttempts      = 2;
constexpr int kOutputOpenRetryDelayMs  = 120;

bool openOutputWithFallback(WasapiOutput& output, const std::string& deviceId, OutputMode mode,
                            const StreamRequest& request, std::string& error,
                            std::string& degrade) {
    const auto tryOpen = [&](const std::string& id, std::string& err) {
        for (int attempt = 0; attempt < kOutputOpenAttempts; ++attempt) {
            if (attempt > 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(kOutputOpenRetryDelayMs));
            }
            err.clear();
            if (output.open(id, mode, request, err)) return true;
        }
        return false;
    };

    std::string firstError;
    if (tryOpen(deviceId, firstError)) return true;
    if (deviceId.empty()) {
        error = firstError;
        return false;
    }

    std::string fallbackError;
    if (tryOpen(std::string(), fallbackError)) {
        degrade = "the requested audio device could not be opened (" + firstError +
                  "); using the default endpoint instead";
        return true;
    }
    error = fallbackError.empty() ? firstError : fallbackError;
    return false;
}

} // namespace

Player::Player(App& app) : app_(app) {}

Player::~Player() {
    stopFeeder();
    output_.close();
}

const char* Player::outputModeName(OutputMode mode) {
    switch (mode) {
    case OutputMode::Exclusive: return "exclusive";
    case OutputMode::Shared:    return "shared";
    case OutputMode::Auto:      return "auto";
    }
    return "shared";
}

void Player::initialise(const std::string& preferredDeviceId) {
    // No source format is known at startup, so this is a shared-mode open purely
    // to have a usable device (and to publish the device list). Exclusive is
    // established per track, in openTrack(), because it needs the source rate.
    StreamRequest request;
    request.latency = latencyProfile_;
    std::string error;
    std::string degrade;
    output_.setLatencyProfile(latencyProfile_);
    if (openOutputWithFallback(output_, preferredDeviceId, OutputMode::Shared, request, error,
                               degrade)) {
        outputError_.clear();
        output_.setDitherMode(ditherMode_);
        output_.setFadeMs(fadeMs_);
        if (!degrade.empty()) output_.setDegradeReason(degrade);

        // CR-029：流打开后按真实采样率重建 virtual HRIR（bank 的 rate 必须等于流率）。
        {
            std::string spatialBuildError;
            if (!ensureSpatialBanks(spatialBuildError) && !spatialBuildError.empty()) {
                output_.setDegradeReason("spatial: " + spatialBuildError);
            }
        }
        openedRate_     = output_.status().sampleRate;
        openedChannels_ = output_.status().channels;
        openedBitDepth_ = 0;
    } else {
        outputError_ = error;
        // 没有流本身就是一种降级，而 CONTRACT 3.4 要求降级用 state 表达：
        // degradeReason 是客户端唯一能显示"为什么没声音"的字段。旧代码只把
        // 错误留在 outputError_ 里，state 里是空 outputMode + 空原因。
        output_.setDegradeReason(error);
    }
}

void Player::reopenOutput(const std::string& deviceId, int bufferMs) {
    // E10：缓存只对"同一台设备的同一格式"成立。设备变了就必须失效，否则会把
    // 旧设备的"不接受独占"结论套到新设备上——那是谎报能力，不是优化。
    if (!deviceId.empty() && deviceId != exclusiveCacheDevice_) invalidateOutputCapabilities();
    const bool wasPlaying = (state_ == PlayState::Playing);
    if (wasPlaying) pause();
    stopFeeder();
    output_.close();

    // Reopen with whatever format this track needs. Pass the requested mode and
    // the source format through, so an adaptive-buffer reopen cannot silently
    // drop the stream out of exclusive mode.
    StreamRequest request;
    const bool haveTrack = (trackSampleRate_ > 0 && trackChannels_ > 0);
    if (haveTrack) request.bitDepth = trackBitDepth_;
    if (requestedMode_ != OutputMode::Shared && haveTrack) {
        // Same rule as openSourcePath: a fixed rate wins over the source rate.
        request.sampleRate = forcedOutputRate_ > 0 ? forcedOutputRate_ : trackSampleRate_;
        request.channels   = trackChannels_;
        request.bitDepth   = trackBitDepth_;
    }
    request.bufferMs = bufferMs;
    request.latency = latencyProfile_;
    output_.setLatencyProfile(latencyProfile_);

    // With no track open there is no source format to negotiate exclusive with.
    // Falling through to a shared open keeps a usable device and lets the mode
    // take effect when a track is actually opened. Asking for exclusive here and
    // letting that fail would have torn down a perfectly good output for a
    // preference that cannot be evaluated yet.
    OutputMode mode = requestedMode_;
    if (mode == OutputMode::Exclusive && !haveTrack) mode = OutputMode::Shared;

    std::string error;
    std::string degrade;
    if (!openOutputWithFallback(output_, deviceId, mode, request, error, degrade)) {
        outputError_ = error;
        // A reopen that failed still CHANGES what the client should display (the
        // stream is gone). Staying quiet about it leaves the UI showing the format
        // of a stream that no longer exists. The REASON belongs in the state too:
        // degradeReason is the only field a client can show, and resetStatus()
        // clears it on every failed open, so a dead output used to look like an
        // unexplained "none".
        output_.setDegradeReason(error);
        emitState();
        return;
    }
    if (mode != requestedMode_) {
        // Deliberately NO degradeReason here. Choosing exclusive before any
        // track is open is an ordinary sequence, not a degradation -- with no
        // source format there is no exclusive stream to negotiate, and nothing
        // has gone wrong. Setting a reason made the UI draw its degraded line
        // for a normal step, which is a false alarm: DESIGN-A 2.2 forbids
        // setting this field for looks or by habit. The real negotiation happens
        // in openTrack(), and that is where a genuine fallback reports itself.
    }
    outputError_.clear();
    // No diagnostic record here: WasapiOutput::open() writes it, which is the
    // only place every open path passes through. Recording at this call site
    // too would duplicate the adaptive and device-change opens while still
    // missing openTrack's -- a partial history that looks complete.
    openedRate_     = output_.status().sampleRate;
    openedChannels_ = output_.status().channels;
    openedBitDepth_ = output_.status().bitsPerSample;
    output_.setVolume(pendingVolume_);
    output_.setMuted(muted_);
    output_.setDitherMode(ditherMode_);
    output_.setFadeMs(fadeMs_);
    // 回退到默认端点必须让用户知道：不是请求的那台设备在响。放在 CR-029 之前，
    // 这样真正更具体的 spatial 错误仍可以覆盖它。
    if (!degrade.empty()) output_.setDegradeReason(degrade);

        // CR-029：流打开后按真实采样率重建 virtual HRIR（bank 的 rate 必须等于流率）。
        {
            std::string spatialBuildError;
            if (!ensureSpatialBanks(spatialBuildError) && !spatialBuildError.empty()) {
                output_.setDegradeReason("spatial: " + spatialBuildError);
            }
        }
    // Playback after a device change resumes from the current position, which
    // is only correct if the stream format still matches the source; the next
    // play() re-checks nothing, so the resampler is rebuilt here instead.
    if (resampler_ && output_.isOpen()) {
        std::lock_guard<std::mutex> lock(sourceMutex_);
        std::string configError;
        resampler_->configure(source_.get(), trackSampleRate_, output_.status().sampleRate,
                              output_.status().channels, configError, resamplerConfig_);
    }
    // Announce the new stream. Without this, set_output (mode or rate) replied with
    // the new format while no state event followed -- so the interface kept drawing
    // the PREVIOUS stream until some unrelated event happened to fire. The reply is
    // addressed to the caller; the state event is what every other view listens to.
    emitState();
}

const char* Player::renderStageDescription() const {
#if TE_RT_TRACE
    return output_.renderStageName();
#else
    return "off";
#endif
}

void Player::startFeeder() {
    if (feederRun_.load()) return;
    feederRun_.store(true, std::memory_order_release);
    feederThread_ = std::thread([this] { feederLoop(); });
}

void Player::stopFeeder() {
    if (!feederRun_.exchange(false)) return;
    // 先叫醒定时等待中的 feeder 再 join：否则最坏要等一个完整超时（≤30ms），
    // 而 pause/stop/seek 的延迟预算远比这紧。
    feederCv_.notify_all();
    if (feederThread_.joinable()) feederThread_.join();
}

// Feeder 的"没事可做"等待。谓词只关心"该退出"：ring 有没有空位没有通知
// （消费者是 RT 线程，不允许 syscall/加锁），所以超时醒来再查一次。
// 20–30ms 远小于 ring 里 250ms 的余量，不会造成欠载；换掉的是 2–3ms 的空轮询。
void Player::waitFeeder(int milliseconds) {
    std::unique_lock<std::mutex> lock(feederMutex_);
    feederCv_.wait_for(lock, std::chrono::milliseconds(milliseconds),
                       [this] { return !feederRun_.load(std::memory_order_acquire); });
}

void Player::notifyFeeder() {
    // 控制线程在 seek/open/start 之后调用：换源后应立刻续填，而不是等超时。
    feederCv_.notify_all();
}

bool Player::handleInputFailure() {
    if (!inputFailed_.load(std::memory_order_acquire)) return false;
    // Park first: the feeder publishes the message before the failure flag,
    // and no recovery/seek may hide it by replacing the source.
    // V3 §1.1 / verifier 真因清单：读失败而停流同样会硬切，先淡出再停。
    // 用传输下限 15ms（5ms 在真机上仍有可闻台阶）；设备已卡住时排空会超时，
    // 超时也会被计数而不是无限等待。
    if (state_ == PlayState::Playing) fadeOutBeforeStop(kTransportFadeMinMs);
    output_.stop();
    stopFeeder();
    std::string reason;
    {
        std::lock_guard<std::mutex> lock(sourceMutex_);
        reason = inputFailureReason_;
    }
    inputFailed_.store(false, std::memory_order_release);
    output_.setDegradeReason(reason.empty() ? "audio source read failed" : reason);
    Json note = Json::object();
    note.set("ev", "log");
    note.set("level", "error");
    note.set("message", output_.status().degradeReason);
    app_.emitEvent(note);
    state_ = PlayState::Stopped;
    emitState();
    return true;
}

// The feeder does all the work the RT thread may not: decode, resample, and the
// allocations SoXR and dr_flac make internally. It pushes into the ring and
// then waits, so it costs nothing while the buffer is full.
void Player::feederLoop() {
    std::vector<std::vector<float>> scratch;
    std::vector<float*>             views;          // mutable view, for source pulls
    std::vector<const float*>       ringViews;      // const view, for the ring

    const int outChannels = output_.status().channels > 0 ? output_.status().channels : 2;
    const int outRate     = output_.status().sampleRate > 0 ? output_.status().sampleRate : 48000;
    const uint64_t targetFrames = static_cast<uint64_t>(kTargetBufferedMs * outRate / 1000.0);

    // A pull is sized so that one whole SoXR output batch fits.
    constexpr uint64_t kPullFrames = 4096;
    scratch.assign(static_cast<size_t>(outChannels), std::vector<float>(kPullFrames, 0.0f));
    views.assign(static_cast<size_t>(outChannels), nullptr);
    ringViews.assign(static_cast<size_t>(outChannels), nullptr);
    for (int ch = 0; ch < outChannels; ++ch) {
        views[static_cast<size_t>(ch)]     = scratch[static_cast<size_t>(ch)].data();
        ringViews[static_cast<size_t>(ch)] = scratch[static_cast<size_t>(ch)].data();
    }

    while (feederRun_.load(std::memory_order_acquire)) {
        // A failed source is sticky until reopened. Wait for the control
        // thread to consume it instead of repeatedly pulling the same failure.
        if (inputFailed_.load(std::memory_order_acquire)) {
            waitFeeder(30);
            continue;
        }
        uint64_t readable = ring_.readableFrames();
        const size_t pullFrames = std::min<size_t>(kPullFrames, ring_.writableFrames());
        if (readable >= targetFrames || pullFrames == 0) {
            waitFeeder(20);
            continue;
        }

        uint64_t got = 0;
        bool sourceFailed = false;
        bool notConfigured = false;
        std::string sourceFailure;
        {
            std::lock_guard<std::mutex> lock(sourceMutex_);
            if (!resampler_ || !resampler_->isConfigured()) {
                // 不能持着 sourceMutex_ 等：控制线程换源/seek 需要的正是这把锁。
                notConfigured = true;
            } else {
                got = resampler_->pull(views.data(), pullFrames);
                sourceFailed = resampler_->sourceFailed();
                if (sourceFailed) sourceFailure = resampler_->sourceError();
            }
        }
        if (notConfigured) {
            waitFeeder(20);
            continue;
        }

        if (sourceFailed) {
            {
                std::lock_guard<std::mutex> lock(sourceMutex_);
                inputFailureReason_ = sourceFailure.empty()
                    ? "audio source read failed"
                    : sourceFailure;
            }
            inputFailed_.store(true, std::memory_order_release);
            output_.setFeederDone(true);
            waitFeeder(30);
            continue;
        }

        if (got == 0) {
            // THE DECODER IS THE ORACLE FOR "IS THERE MORE", NOT THE HEADER.
            //
            // The end-of-stream test used to infer this from
            // deliveredFrames_ >= trackTotalFrames_, where trackTotalFrames_ comes
            // from dr_flac's totalPCMFrameCount. That count is what the FILE SAYS;
            // it is not what the file contains, and for one track in this library
            // it is 23,040 frames (523 ms) too large. The feeder therefore
            // delivered everything there was, stopped 523 ms short of the
            // declared total, and the end was never declared: the ring drained,
            // the underruns raised the buffer, the reopen zeroed framesRendered_,
            // and the engine sat reporting "playing" over silence. Three
            // consecutive 30-minute soaks, same track, same millisecond.
            //
            // "The decoder handed over everything it has" is a fact only the
            // feeder can observe, so it observes it here and publishes it.
            inputExhausted_.store(true, std::memory_order_release);
            // AND TELL THE OUTPUT, because this is what stops the render thread
            // counting the tail's starved blocks as underruns. That flag used to
            // be driven ONLY by deliveredFrames_ >= trackTotalFrames_ -- the very
            // comparison this file can never satisfy -- so ONE over-declared frame
            // count disabled BOTH safety mechanisms at once: the end-of-stream
            // declaration (which hung the player) and this one (which turned the
            // normal end of a track into 3 xruns and a pointless buffer increase).
            output_.setFeederDone(true);
            // Stay alive: the control thread decides whether another track
            // follows, and a seek may need the feeder again.
            waitFeeder(30);
            continue;
        }
        // Frames are flowing again (a seek, or a gapless splice): the drain flag
        // must not outlive the gap it described.
        if (inputExhausted_.exchange(false, std::memory_order_acq_rel)) {
            output_.setFeederDone(false);
        }

        // Only this thread writes; the consumer can only free space. Limiting
        // the pull to the observed free space guarantees the full batch fits.
        // Decoded frames cannot be re-pulled after a short ring write.
        const size_t written = ring_.write(ringViews.data(), static_cast<size_t>(got));
        // Count what actually entered the ring: the drain test compares this with
        // what the device has finished, so over-counting would call the end early.
        fedFrames_.fetch_add(written, std::memory_order_release);
        (void)written;
        const uint64_t consumed = deliveredFrames_.fetch_add(got, std::memory_order_release) + got;
        // Tell the output when the decoder has nothing left: from here a short
        // block is the track ending rather than a fault.
        if (trackTotalFrames_ > 0 && consumed >= trackTotalFrames_) {
            output_.setFeederDone(true);
        }
    }
}

void Player::fadeOutBeforeStop(int overrideMs) {
    // Only worth doing if audio is actually flowing: a fade on a paused stream
    // would just delay the stop for no audible benefit.
    if (state_ != PlayState::Playing) return;
    if (!output_.isOpen()) return;

    // stop / 切歌路径：明确不保持流（保持流是 pause 的 pause-hold 路径）。
    output_.setHold(false);
    const int requested = overrideMs > 0 ? overrideMs : fadeMs_;
    if (requested <= 0) return;   // fadeMs=0 是用户显式选择"不要淡变"
    // 传输操作的淡出下限。旧 stop/seek/切歌/换 resampler 用 5ms；实测用户仍
    // 听到"咔/电流声"：5ms@44.1k 只有 220 帧，曲线刚归零就被 Stop/Reset，
    // 驱动侧没有余量。抬到 kTransportFadeMinMs（15ms），并在淡出归零后由
    // output 再补 kStopSilencePadMs 的静音、等设备播完才 Stop。
    const int fadeMs = std::max(requested, kTransportFadeMinMs);
    output_.setFadeMs(fadeMs);
    output_.beginFadeOut(fadeMs);

    // 等设备播完 "淡出 + 静音 padding"。deadline 把设备周期和 padding 都算进去，
    // 超时仍要如实计数（state.fade.fadeDrainTimeouts），绝不无限等待。
    const int drainWaitMs = std::max(200,
        output_.status().currentBufferMs * 3 + fadeMs + kStopSilencePadMs * 2);
    const long long deadline = nowMs() + drainWaitMs;
    while (output_.fadeOutPending() && nowMs() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (output_.fadeOutPending()) {
        ++fadeDrainTimeouts_;             // Player 侧计数（state.fade 回读）
        output_.noteFadeDrainTimeout();   // output 侧计数（诊断/后续门禁）
    }
}

// V3 §1.1b：暂停不拆流。返回 true 表示 hold 已生效（流保持打开、渲染静音）；
// false 表示调用方应回退到"淡出 + stop()"（pauseHold 关闭、流没在跑、或设备
// 卡住导致 fade 排空超时——宁可拆流也不能让界面显示暂停而设备还在出声）。
bool Player::beginPauseHold() {
    if (!pauseHold_) return false;
    if (!output_.isOpen() || !output_.isRunning()) return false;

    output_.setHold(true);
    if (fadeMs_ <= 0) {
        // 淡变被用户关掉：直接进入静音 hold（无淡出，等价于旧的硬切但不断流）。
        output_.requestSilence(true);
        return output_.isHolding();
    }

    // 暂停也走传输下限：用户报告的"暂停咔一声"与 5-10ms 淡出后立刻冻结端点
    // 缓冲是同一类瞬态；淡出 + 静音 padding 都排空后才进入 hold。
    const int fadeMs = std::max(fadeMs_, kTransportFadeMinMs);
    output_.setFadeMs(fadeMs);
    output_.beginFadeOut(fadeMs);
    const int drainWaitMs = std::max(200,
        output_.status().currentBufferMs * 3 + fadeMs + kStopSilencePadMs * 2);
    const long long deadline = nowMs() + drainWaitMs;
    while (output_.fadeOutPending() && nowMs() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (output_.fadeOutPending()) {
        // 设备没有排空（事件流停摆/驱动异常）。撤掉 hold，交给 stop() 拆流。
        ++fadeDrainTimeouts_;
        output_.noteFadeDrainTimeout();
        output_.setHold(false);
        return false;
    }
    return output_.isHolding();
}

bool Player::reopenForDeviceChange(const std::string& preferDeviceId, std::string& error) {
    // Nothing to recover if no source is loaded: the next open will pick a device
    // anyway, and reopening here would just churn the endpoint.
    // Loadedness, not identity: a URL source has no trackId but does need the
    // stream re-established at its own rate (CR-016).
    // E10：设备热插拔/默认端点变化后，独占能力结论必须重测。
    invalidateOutputCapabilities();
    // Nothing to recover if no source is loaded: the next open will pick a device
    // anyway, and reopening here would just churn the endpoint.
    // Loadedness, not identity: a URL source has no trackId but does need the
    // stream re-established at its own rate (CR-016).
    if (!sourceLoaded_) return true;
    if (!output_.isOpen()) {
        // 流已经关掉（上一次热插拔重开失败）。此时旧流的采样率已随 resetStatus
        // 清空，没有可信的断点换算，所以只把默认端点重新打开、保持 stopped，
        // 由用户的 play 恢复播放（play 里也有同一条恢复路径）；不在这里自动续播，
        // 避免插拔过程中突然出声。这就是 diag 里 "device=（空）" 之后一直无声的状态。
        reopenOutput(std::string(), 0);
        if (!output_.isOpen()) {
            error = outputError_.empty() ? "no audio output device after a device change"
                                         : outputError_;
            return false;
        }
        return true;
    }

    // 断流前用的端点。preferredDeviceId 有可能正是它：用户显式选中的设备被拔掉
    // 时，这个偏好不会自动改指系统默认端点，再按一个已经消失的 ID 打开只会失败。
    // 这种情况直接问默认端点（SPEC 3.3: fall back to the default），
    // 不必先付一次注定失败的 GetDevice。
    const std::string lostDevice = output_.status().deviceId;

    const bool wasPlaying = (state_ == PlayState::Playing);

    // Capture the position BEFORE touching the stream, and in SOURCE frames: the
    // new device may run at a different rate, so device frames would translate to
    // the wrong moment in the track.
    const int oldRate = output_.status().sampleRate;
    const int srcRate = trackSampleRate_ > 0 ? trackSampleRate_ : oldRate;
    const uint64_t playedDevice = framesRendered_.load(std::memory_order_acquire);
    const uint64_t playedSource = (oldRate > 0 && oldRate != srcRate)
        ? (playedDevice * static_cast<uint64_t>(srcRate)) / static_cast<uint64_t>(oldRate)
        : playedDevice;
    const uint64_t resumeFrame = seekBaseFrame_ + playedSource;

    // SPEC 3.3 asks for a short fade before the stream is released, for the same
    // reason a track change gets one: tearing down mid-waveform clicks.
    if (wasPlaying) fadeOutBeforeStop();

    reopenOutput(preferDeviceId == lostDevice ? std::string() : preferDeviceId, 0);

    // The requested device may be gone; reopenOutput() falls back to the default
    // endpoint internally, and this is where that outcome is turned into a failure
    // or a success.
    if (!output_.isOpen()) {
        error = outputError_.empty() ? "no audio output device after a device change"
                                     : outputError_;
        state_ = PlayState::Stopped;
        emitState();
        return false;
    }

    if (!resetSourcePosition(resumeFrame, error)) {
        state_ = PlayState::Stopped;
        output_.setDegradeReason(error);
        emitState();
        return false;
    }

    if (wasPlaying) {
        startFeeder();
        if (!output_.start(ring_, &framesRendered_, true, error)) return false;
        state_ = PlayState::Playing;
        armExclusiveWatchdog();
    } else {
        state_ = PlayState::Stopped;
    }
    emitState();
    return true;
}

void Player::setDitherMode(DitherMode mode) {
    // 换档不重开流：量化点每块读一次原子模式。整形历史跨档位清理交给
    // quantizeSample（进入平直/off 分支时清历史），防止 "ns-9 -> tpdf -> ns-9"
    // 把旧误差带进新一轮。
    ditherMode_ = mode;
    output_.setDitherMode(mode);
    emitState();
}

bool Player::ditherActive() const {
    if (ditherMode_ == DitherMode::Off) return false;
    if (!output_.isOpen()) return false;
    const OutputStatus& status = output_.status();
    // 与量化点同一个判据（ditherApplies）：只有真的丢位宽才谈得上 dither。
    return ditherApplies(status.bitsPerSample, status.sourceBits, status.isFloat);
}

// CR-024：播放中换 SoXR 档位。顺序与 seek 相同：停流 → 在源码帧位置重建
// 转换器 → 从同一帧继续。失败必须回滚旧配置并报错，不能悄悄降级——用户改的是
// 重建精度/相位，静默保持旧档位会让他以为设置生效了（谎报，不是优化）。
bool Player::setResampler(const ResamplerConfig& config, bool& appliedNow, std::string& error) {
    appliedNow = false;
    if (config == resamplerConfig_) { emitState(); return true; }
    if (!sourceLoaded_ || !output_.isOpen()) {
        // 没有源码或没有打开的流：只记录，下次 open 创建的新转换器会用它。
        // appliedNow=false 让回复如实说明"下次生效"。
        resamplerConfig_ = config;
        emitState();
        return true;
    }

    const bool wasPlaying = (state_ == PlayState::Playing);
    const int outRate = output_.status().sampleRate > 0 ? output_.status().sampleRate : trackSampleRate_;
    const int srcRate = trackSampleRate_ > 0 ? trackSampleRate_ : outRate;
    const uint64_t playedDevice = framesRendered_.load(std::memory_order_acquire);
    const uint64_t playedSource = (outRate > 0 && outRate != srcRate)
        ? (playedDevice * static_cast<uint64_t>(srcRate)) / static_cast<uint64_t>(outRate)
        : playedDevice;
    const uint64_t resumeFrame = seekBaseFrame_ + playedSource;

    if (wasPlaying) {
        // V3 §1.1 / verifier 真因清单：播放中换 resampler 也是"停流重建"，旧代码
        // 直接 stop()，会在任意采样相位硬切。用传输下限 15ms：够长到不留台阶，
        // 又不至于像 50ms 的暂停档那样让设置反馈显得迟滞。
        fadeOutBeforeStop(kTransportFadeMinMs);
        output_.stop();
    }
    stopFeeder();

    // 先建好新转换器再替换：旧的 resampler_ 在成功前一直留着，失败时才能回滚。
    auto fresh = std::make_unique<Resampler>();
    std::string configError;
    bool configured = false;
    {
        std::lock_guard<std::mutex> lock(sourceMutex_);
        configured = fresh->configure(source_.get(), srcRate, outRate,
                                      output_.status().channels, configError, config);
        if (configured) resampler_ = std::move(fresh);
    }
    if (!configured) {
        error = configError.empty() ? "the resampler rejected the configuration" : configError;
        if (wasPlaying) {
            // 回滚：旧转换器还在，从同一帧恢复播放；失败才落到 stopped。
            std::string restoreError;
            if (!resetSourcePosition(resumeFrame, restoreError)) {
                state_ = PlayState::Stopped;
                output_.setDegradeReason("could not restore playback after a failed resampler change: " + restoreError);
                emitState();
                return false;
            }
            startFeeder();
            if (!output_.start(ring_, &framesRendered_, true, restoreError)) {
                state_ = PlayState::Stopped;
                output_.setDegradeReason("could not restart the output after a failed resampler change: " + restoreError);
            }
        }
        emitState();
        return false;
    }

    resamplerConfig_ = config;
    appliedNow = true;
    std::string resetError;
    if (!resetSourcePosition(resumeFrame, resetError)) {
        state_ = PlayState::Stopped;
        output_.setDegradeReason("could not restore the source after a resampler change: " + resetError);
        emitState();
        return false;
    }
    if (wasPlaying) {
        startFeeder();
        if (!output_.start(ring_, &framesRendered_, true, resetError)) {
            state_ = PlayState::Stopped;
            output_.setDegradeReason("could not restart the output after a resampler change: " + resetError);
            emitState();
            return false;
        }
        state_ = PlayState::Playing;
        armExclusiveWatchdog();
    }
    // 换的是转换器，分析器里那份窗口不属于新链路，清掉重来。
    meterAnalyzer_.reset();
    emitState();
    return true;
}

void Player::resetPlaybackBuffers(uint64_t startFrame) {
    ring_.reset();
    fedFrames_.store(0, std::memory_order_release);
    inputExhausted_.store(false, std::memory_order_release);
    inputFailed_.store(false, std::memory_order_release);
    inputFailureReason_.clear();
    output_.setFeederDone(false);
    // Clear filter and limiter memory too: a seek or a new track must not begin
    // with the tail of the previous one still ringing inside the EQ.
    output_.resetDsp();
    framesRendered_.store(0, std::memory_order_release);
    seekBaseFrame_ = startFrame;
    lastEmitMs_    = -1;
    endOfStreamReached_ = false;
    restartAfterEof_ = false;
}

bool Player::resetSourcePosition(uint64_t frame, std::string& error) {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    if (!source_) { error = "no track is open"; return false; }
    if (!source_->seekToFrame(frame)) {
        error = source_->hasError() ? source_->errorMessage() : "the decoder refused to seek";
        return false;
    }
    if (!output_.resetStream(error)) return false;
    if (resampler_) resampler_->resetBuffers();
    deliveredFrames_.store(frame, std::memory_order_release);
    resetPlaybackBuffers(frame);
    // seek 之后 ring 是空的，叫醒 feeder 立刻续填，而不是等它的定时等待到期。
    notifyFeeder();
    return true;
}

void Player::emitState() {
    app_.emitEvent(stateEventJson());
}

void Player::armExclusiveWatchdog() {
    // Only meaningful for an exclusive stream: shared mode has a working device
    // by construction, and arming it there would fire on the priming window.
    exclusiveWatchdogArmed_ = output_.status().isExclusive;
    playingSinceMs_ = nowMs();
}

// SPEC 3.3: exclusive failure must not surface as silence. An exclusive stream
// can be accepted by the API and still never run -- the buffer event never
// fires, so nothing is rendered and every layer reports success. When that is
// detected, the honest recovery is the documented one: fall back to shared and
// say why, rather than leaving the user with a track that says "playing".
bool Player::checkExclusiveWatchdog(long long elapsedMs, std::string& degradeReason) {
    if (!exclusiveWatchdogArmed_) return false;
    if (state_ != PlayState::Playing) return false;
    // THE DEVICE SIGNALLED, so exclusive is working. Testing framesRendered_
    // here instead was wrong and it cost real fidelity: that counter only moves
    // when the RING has data, so a device that was signalling perfectly while
    // the feeder was still priming looked identical to a device that was dead.
    // On the USB DAC this fired the watchdog on a stream that had already
    // reported outputPerfect=true -- the engine talked itself out of working
    // bit-perfect playback.
    if (output_.status().renderWakes.load(std::memory_order_relaxed) > 0) {
        exclusiveWatchdogArmed_ = false;   // the device is running; exclusive is fine
        return false;
    }
    if (elapsedMs - playingSinceMs_ < kExclusiveStartupGraceMs) return false;

    exclusiveWatchdogArmed_ = false;
    degradeReason = "the exclusive stream produced no audio (the device never signalled its buffer); fell back to shared";
    return true;
}

// THE OTHER HALF OF THE SAME QUESTION, and the one nothing was asking.
//
// checkExclusiveWatchdog() catches "the device never signalled". It cannot catch
// "the device stopped signalling", because it DISARMS itself on the first wake.
// A 30-minute SPEC 9 soak produced exactly that: after an adaptive-buffer reopen
// the position froze for the last four and a half minutes while state stayed
// "playing", the engine kept answering every command in 2 ms, and nothing
// anywhere recorded that the music had stopped. The user would have heard
// silence with a progress bar that had quietly given up.
//
// This is not device-specific. Any stream can be invalidated by something outside
// this process, and the engine's duty is to notice, try once to recover, and
// otherwise stop claiming to play.
void Player::serviceRenderLiveness(long long nowMs) {
    if (state_ != PlayState::Playing || !output_.isOpen()) {
        // Not playing: re-baseline so a pause is never mistaken for a stall.
        lastLiveFrames_   = framesRendered_.load(std::memory_order_acquire);
        lastLiveChangeMs_ = nowMs;
        stallRecoveries_  = 0;
        return;
    }

    const uint64_t rendered = framesRendered_.load(std::memory_order_acquire);
    if (rendered != lastLiveFrames_) {
        lastLiveFrames_   = rendered;
        lastLiveChangeMs_ = nowMs;
        stallRecoveries_  = 0;
        return;
    }
    if (nowMs - lastLiveChangeMs_ < kRenderStallMs) return;

    const OutputStatus& s = output_.status();
    // The three-stage pipeline report, in the file rather than in a console:
    // "no sound" is three distinguishable failures and this is the only place
    // that can say WHICH one happened, after the fact.
    // EVERY TERM OF THE END-OF-STREAM TEST, not just the counters that were
    // convenient. The previous version of this record printed rendered / wakes /
    // devicePlayed / ringBuffered, and those four were enough to prove the
    // engine had nothing to play -- but not enough to say WHICH clause of
    //
    //     feederDone && ringDry && deviceDrained && everRan
    //
    // was false. Printing the terms themselves is what turns the next
    // reproduction from a puzzle into a reading.
    const uint64_t delivered = deliveredFrames_.load(std::memory_order_acquire);
    const uint64_t devicePlayedNow = output_.devicePlayedFrames();
    const uint64_t fed = fedFrames_.load(std::memory_order_acquire);
    diagRecord("stall", "no frames for " + std::to_string(nowMs - lastLiveChangeMs_) +
                        " ms at position " + std::to_string(positionMs()) +
                        "; rendered=" + std::to_string(rendered) +
                        " wakes=" + std::to_string(s.renderWakes.load(std::memory_order_relaxed)) +
                        " ringBuffered=" + std::to_string(ring_.readableFrames()) +
                        " mode=" + s.outputMode);
    diagRecord("stall-eos", "delivered=" + std::to_string(delivered) +
                            " trackTotal=" + std::to_string(trackTotalFrames_) +
                            " fed=" + std::to_string(fed) +
                            " devicePlayed=" + std::to_string(devicePlayedNow) +
                            " rendered=" + std::to_string(rendered) +
                            " | feederDone=" + ((delivered >= trackTotalFrames_) ? "1" : "0") +
                            " ringDry=" + ((ring_.readableFrames() == 0) ? "1" : "0") +
                            " deviceDrained=" + (output_.audioDrained(fed) ? "1" : "0") +
                            " everRan=" + (((rendered > 0) || (fed > 0)) ? "1" : "0") +
                            " srcFrames=" + std::to_string(trackTotalFrames_ - delivered));
    lastLiveChangeMs_ = nowMs;   // one report and one attempt per episode
    ++stallRecoveries_;

    app_.emitEvent([]() {
        Json note = Json::object();
        note.set("ev", "log");
        note.set("level", "warn");
        note.set("message", "the output stream stopped producing audio; reopening it");
        return note;
    }());

    if (stallRecoveries_ > kStallRecoveriesBeforeGivingUp) {
        output_.setDegradeReason("the output stream stopped producing audio and could not be recovered");
        output_.stop();
        stopFeeder();
        state_ = PlayState::Stopped;
        diagRecord("stall", "gave up after " + std::to_string(stallRecoveries_) + " attempts");
        emitState();
        return;
    }

    // Same resume arithmetic the adaptive-buffer reopen uses: the device clock
    // restarts with the new stream, so the SOURCE frame is what has to survive.
    const int rate    = s.sampleRate;
    const int srcRate = trackSampleRate_ > 0 ? trackSampleRate_ : rate;
    const uint64_t playedDevice = framesRendered_.load(std::memory_order_acquire);
    const uint64_t playedSource = (rate > 0 && rate != srcRate)
        ? (playedDevice * static_cast<uint64_t>(srcRate)) / static_cast<uint64_t>(rate)
        : playedDevice;
    const uint64_t resumeFrame = seekBaseFrame_ + playedSource;
    const std::string device = s.deviceId;

    reopenOutput(device, 0);
    if (!output_.isOpen()) {
        output_.setDegradeReason("the output stream stopped producing audio and the device could not be reopened");
        state_ = PlayState::Stopped;
        emitState();
        return;
    }
    output_.setDegradeReason("the output stream stopped producing audio; it was reopened at the same position");
    lastLiveFrames_ = 0;
    std::string error;
    if (!resetSourcePosition(resumeFrame, error)) {
        output_.setDegradeReason("could not restore the source after output recovery: " + error);
        state_ = PlayState::Stopped;
        emitState();
        return;
    }
    startFeeder();
    if (output_.start(ring_, &framesRendered_, true, error)) {
        state_ = PlayState::Playing;
        armExclusiveWatchdog();
    } else {
        output_.setDegradeReason("the output stream stopped producing audio and could not be restarted: " + error);
        state_ = PlayState::Stopped;
    }
    emitState();
}

Json Player::stateEventJson() const {
    const OutputStatus& status = output_.status();
    // The resampled flag is true only when a converter is actually in the path. In
    // exclusive mode the stream was opened at the source rate, so the rates match
    // and this stays false -- which is exactly the signal the UI needs to show
    // the bit-perfect badge instead of the degraded one.
    const bool differsInRate = (trackSampleRate_ > 0 && status.sampleRate > 0 &&
                                trackSampleRate_ != status.sampleRate);

    Json event = Json::object();
    event.set("ev", "state");
    // CR-007: which playback session this state describes.
    event.set("operationId", operationId_);
    event.set("state", stateName(state_));
    event.set("trackId", currentTrackId_);
    event.set("positionMs", positionMs());
    event.set("durationMs", durationMs());
    event.set("volume", static_cast<double>(pendingVolume_));

    // PLAYBACK CONTROLS THE UI CANNOT OTHERWISE KNOW.
    //
    // set_repeat accepts a mode and the player stores it, but nothing reported
    // it back -- so a client could only remember what IT last sent, which is
    // wrong the moment anything else changes the mode (auto-advance, a queue
    // reload, a future preset). The state event is the authoritative value by
    // contract, so the mode belongs here.
    event.set("repeatMode", repeatModeName(repeatMode_));
    // Mute is reported separately from volume on purpose: a UI needs to show the
    // chosen level AND whether it is currently silenced.
    event.set("muted", muted_);

    // The queue, and where playback sits in it.
    //
    // Reports ids rather than the full track objects: the client already has
    // every track from list_tracks, and repeating that metadata ten times a
    // second would be the largest thing on the wire for no new information.
    //
    // queueIndex is -1 when the playing track is not a queue member (a one-off
    // open), which is a real state the UI must be able to show.
    {
        Json ids = Json::array();
        for (const auto& id : queue_) ids.push(Json(id));
        event.set("queue", std::move(ids));
        event.set("queueIndex", static_cast<long long>(queueIndex_));
    }
    event.set("outputMode", status.outputMode.empty() ? "none" : status.outputMode);
    event.set("sampleRate", status.sampleRate);
    // The rate the client ASKED for; 0 means "follow the source". Reported next
    // to the achieved sampleRate so a shared-mode stream (which cannot honour a
    // fixed rate) is visible as the disagreement it is, not as a silent ignore.
    event.set("requestedOutputRate", static_cast<long long>(forcedOutputRate_));
    // CR-027：请求的延迟档位（实际 periodMs/bufferMs 另有两个字段如实报告）。
    event.set("latencyProfile", latencyProfileName(latencyProfile_));
    // CR-028（V3 §1.1）：transport 淡变配置（冻结协议 FadeConfig { ms, pauseHold }）。
    {
        Json fade = Json::object();
        fade.set("ms", static_cast<long long>(fadeMs_));
        fade.set("pauseHold", pauseHold_);
        // verifier：结构性证据（独立于是否有 loopback 录音）。
        // paddingAtStop：Stop 时端点里还剩多少帧；fadeCompleted：Stop 前淡出是否
        // 真被设备播完；resetBeforeStart：最近一次 Start 前是否清了残留缓冲。
        const TransportTrace trace = output_.transportTrace();
        Json last = Json::object();
        last.set("paddingAtStop", static_cast<long long>(trace.paddingAtStop));
        last.set("fadeCompleted", trace.fadeCompleted);
        last.set("resetBeforeStart", trace.resetBeforeStart);
        // 只增字段：Stop 之前实际写进端点的静音帧数（0 = 没写）。配合
        // fadeCompleted 可以判断"淡出 + padding 是否真的走到设备"。
        last.set("silencePadFrames", static_cast<long long>(trace.silencePadFrames));
        fade.set("lastTransport", std::move(last));
        fade.set("fadeDrainTimeouts", static_cast<long long>(fadeDrainTimeouts_));
        event.set("fade", std::move(fade));
    }
    // CR-029：空间音频只读回读（mode/amount/active + virtual 的卷积延迟）。
    event.set("spatial", spatialJson());
    // 额外只增可观测字段：pause-hold 是否真的让流保持打开。冻结的 FadeConfig 只是
    // 配置回读，这个字段才证明"暂停但流没停"确实发生（测试用；不需要可忽略）。
    event.set("streamHeld", output_.isHolding());
    // CR-024：重采样器配置（实际会用于下一条重采样路径的档位；同率直通时没有
    // 听觉含义，但仍然如实报告配置，UI 才能回读它刚设置的值）。
    {
        Json resampler = Json::object();
        resampler.set("quality", resamplerQualityName(resamplerConfig_.quality));
        resampler.set("phase", resamplerPhaseName(resamplerConfig_.phase));
        resampler.set("steep", resamplerConfig_.steep);
        event.set("resampler", std::move(resampler));
    }
    // CR-025：dither 档位与"这次量化是否真的加抖动"。active 是如实报告，不是
    // 配置的回显：bit-perfect/等位深/浮点流下即使选了 tpdf 也不会加。
    {
        Json dither = Json::object();
        dither.set("mode", ditherModeName(ditherMode_));
        dither.set("active", ditherActive());
        event.set("dither", std::move(dither));
    }
    event.set("bitDepth", trackBitDepth_);
    // The three orthogonal facts (CR-010). bitPerfect above stays the alias.
    event.set("outputPerfect", outputPerfect());
    event.set("sourceExact", sourceExact());
    event.set("pcmPassthrough", pcmPassthrough());
    // The evidence for those claims. Without these two numbers the user cannot
    // check a bit-perfect badge; with them the container and the precision the
    // device is actually consuming are both visible, and the whole claim is
    // auditable rather than asserted.
    event.set("containerBits", status.bitsPerSample);
    event.set("validBits", status.validBits);
    // Empty string when the chain is perfect, so an empty reason and a true
    // outputPerfect can never disagree.
    event.set("outputNotPerfectReason", outputNotPerfectReason());
    event.set("channels", status.channels);
    // CONTRACT 3.4: the degradation is expressed HERE, never as an ok:false.
    //
    // bitPerfect is the COMPATIBILITY ALIAS of outputPerfect, and it has to be
    // literally the same value. It used to be computed here from the stream's
    // own check, which is container-blind -- so after the container rule was
    // added to outputPerfect the two could disagree, and for one build they did:
    // bitPerfect said true while outputPerfect said false on the same event.
    // Two fields that claim to be the same thing and are not is worse than
    // having only one, so this now reads the same function.
    event.set("bitPerfect", outputPerfect());
    event.set("resampled", differsInRate);
    event.set("sourceSampleRate", trackSampleRate_);
    // CR-032：源格式如实回读。DSD 时 format='dsd' 且带上源 1-bit 率与抽取后的
    // PCM 率；sampleRate/sourceSampleRate 仍然报抽取后的 PCM 率，所以既有的
    // 重采样 / bit-perfect / 独占协商逻辑一行都不用改。
    {
        Json source = Json::object();
        source.set("format", sourceFormat_);
        if (dsdRate_ > 0) {
            source.set("dsdRate", static_cast<long long>(dsdRate_));
            source.set("decimationPcmRate", trackSampleRate_);
        }
        event.set("source", std::move(source));
    }
    // Why exclusive was not used, when the user asked for it. Empty when there
    // is nothing to explain.
    event.set("degradeReason", status.degradeReason);
    event.set("deviceId", status.deviceId);
    event.set("deviceName", status.deviceName);
    event.set("periodMs", status.periodMs);
    // What the stream is ACTUALLY running at, as opposed to the device's period.
    // SPEC 9 asks for "30 min at the smallest buffer = 0 xrun", and that claim
    // is only checkable if the buffer it was achieved at travels with it. Same
    // field name the xrun event already uses.
    event.set("bufferMs", status.currentBufferMs);
    event.set("xrunCount", static_cast<long long>(status.xrunCount));

    // Two separate facts about whether the stream is actually running, and they
    // are reported separately because their DISAGREEMENT is the diagnostic that
    // found a real bug: the exclusive watchdog used to infer 'the device never
    // signalled' from 'nothing was rendered', which is a different claim.
    //
    //   renderWakes    the device asked for data (the stream is alive)
    //   renderedFrames frames actually pulled from the ring and rendered
    //
    // wakes > 0 with frames == 0 means the device is fine and the feeder is not,
    // which needs a completely different fix from a dead endpoint.
    event.set("renderWakes", static_cast<long long>(status.renderWakes.load(std::memory_order_relaxed)));
    event.set("renderedFrames", static_cast<long long>(framesRendered_.load(std::memory_order_acquire)));
    // And the two stages before it, so 'no audio' can be localised instead of
    // guessed at: delivered = the feeder produced frames, buffered = they are
    // waiting in the ring, rendered = the device consumed them. Whichever of
    // the three is zero names the stage that is stuck.
    event.set("feederDelivered", static_cast<long long>(deliveredFrames_.load(std::memory_order_acquire)));
    event.set("ringBuffered", static_cast<long long>(ring_.readableFrames()));

    // DESIGN-A 3.1: whether DSP is in force for THIS playback, which is a
    // different question from capabilities.dsp (does the engine have one).
    // Without this the interface can only draw a permanent "capability" mark,
    // which is mistaking a capability for a state.
    //
    // dspModules names the ones actually altering samples. The limiter is
    // deliberately absent: at unity gain it changes nothing, and listing it
    // would claim an effect that is not being heard.
    Json modules = Json::array();
    const bool eqOn = dspParams_.eqEnabled;
    const bool rgOn = dspParams_.rgMode > 0;
    const bool preampOn = dspParams_.preampDb != 0.0f;
    if (eqOn)    modules.push(std::string("eq"));
    // CR-020: an enabled IR changes every sample, so it must be named here too.
    if (dspParams_.irEnabled && irBank_ != nullptr) modules.push(std::string("ir"));
    if (rgOn)    modules.push(std::string("replaygain"));
    // Channel tools are named individually: a UI that shows "DSP active" alone
    // cannot tell the user whether the EQ or the stereo controls are doing it.
    const bool balanceOn = dspParams_.balance != 0.0f;
    // CR-026：monoMode 优先于旧 mono 布尔；两者任一为真都算 mono 在改样本。
    const int  effectiveMonoMode = dspParams_.monoMode != 0 ? dspParams_.monoMode
                                                            : (dspParams_.mono ? 1 : 0);
    const bool monoOn    = effectiveMonoMode != 0;
    const bool midSideOn = !midSideNeutral(dspParams_);
    const bool crossfeedOn = dspParams_.crossfeedEnabled;
    const bool swapOn    = dspParams_.swapChannels;
    const bool trimOn    = dspParams_.channelGainDb[0] != 0.0f ||
                           dspParams_.channelGainDb[1] != 0.0f;
    // CR-026：三频段增益与每声道延迟只有在非 0 时才改样本（0 = 完全旁路）。
    bool bandGainOn = false;
    for (int band = 0; band < 3; ++band) {
        if (dspParams_.bandGainDb[band][0] != 0.0f) bandGainOn = true;
        if (dspParams_.bandGainDb[band][1] != 0.0f) bandGainOn = true;
    }
    const bool channelDelayOn = dspParams_.channelDelayMs[0] != 0.0f ||
                                dspParams_.channelDelayMs[1] != 0.0f;
    // CR-029：amount=0 等价 off；只有真正改变样本时才计入 modules/dspActive。
    const bool spatialOn = dspParams_.spatialMode != SpatialMode::Off &&
                           dspParams_.spatialAmount > 0.0f;
    if (balanceOn) modules.push(std::string("balance"));
    if (monoOn)    modules.push(std::string("mono"));
    if (midSideOn) modules.push(std::string("midSide"));
    if (crossfeedOn) modules.push(std::string("crossfeed"));
    if (swapOn)    modules.push(std::string("swapChannels"));
    if (trimOn)    modules.push(std::string("channelGain"));
    if (bandGainOn) modules.push(std::string("bandGain"));
    if (channelDelayOn) modules.push(std::string("channelDelay"));
    if (spatialOn) modules.push(std::string("spatial"));
    const bool irOn = dspParams_.irEnabled && irBank_ != nullptr;
    const bool dspActive = eqOn || rgOn || preampOn || irOn ||
                           balanceOn || monoOn || midSideOn || crossfeedOn || swapOn || trimOn ||
                           bandGainOn || channelDelayOn || spatialOn;
    event.set("dspActive", dspActive);
    event.set("dspModules", std::move(modules));
    // Non-zero means the render thread is alive but the device never raised its
    // buffer event -- the failure mode exclusive mode can hit on a driver that
    // refuses to run a small event-driven buffer. Without this it is
    // indistinguishable from a stream that is simply playing quietly.
    event.set("renderStarved", static_cast<long long>(status.renderStarved));
    return event;
}

std::string Player::exclusiveKey(int streamRate, int bitDepth, int channels) const {
    // 键 = 本次要协商的流格式。设备不在键里：exclusiveCacheDevice_ 是外层判据
    // （同一键在不同设备上结论可以相反，混用会谎报能力）。
    return std::to_string(streamRate) + "|" + std::to_string(bitDepth) + "|" +
           std::to_string(channels);
}

void Player::invalidateOutputCapabilities() {
    exclusiveRefusals_.clear();
    exclusiveCacheDevice_.clear();
}

bool Player::openSourcePath(const std::filesystem::path& sourcePath, const std::string& trackId,
                            std::string& error) {
    if (!output_.isOpen()) {
        // Try once more: the device may have appeared since startup.
        initialise("");
    }
    if (!output_.isOpen()) {
        error = outputError_.empty() ? "no audio output device" : outputError_;
        return false;
    }

    std::unique_ptr<AudioSource> source = openAudioSource(sourcePath, error);
    if (!source) return false;

    // A format reopen destroys output state that the feeder reads. Park both
    // threads before negotiation, and fade while the OLD stream is still live.
    const bool wasPlaying = (state_ == PlayState::Playing);
    if (wasPlaying) fadeOutBeforeStop();
    output_.stop();
    stopFeeder();
    state_ = PlayState::Stopped;

    // --- establish the stream for THIS source ------------------------------
    // Exclusive mode runs at the source rate because that is what bit-perfect
    // means; shared mode runs at the device mix format and resamples to it.
    // Either way the stream is (re)opened when the format it was opened with no
    // longer matches what this track needs.

    // A fixed output rate only exists on the exclusive/auto path: WASAPI shared
    // always runs at the endpoint mix format, so "shared at 192 kHz" is not a
    // thing the API offers. The request is still reported (see stateEventJson)
    // so the interface can say "asked 192, stream is 48" instead of lying.
    const bool exclusiveRequested = (requestedMode_ != OutputMode::Shared);
    const int streamRate = (exclusiveRequested && forcedOutputRate_ > 0)
                             ? forcedOutputRate_ : source->sampleRate();

    // E10：auto 模式下先查「这个端点对这个流格式拒绝过独占」的缓存。一次失败要
    // CoCreateInstance 枚举器 + 探测 4 个格式候选 + 回落 shared，实测占 open 延迟的
    // 100–300ms；同一设备同一格式的下一首没有理由再付一次。显式 exclusive 请求不
    // 查缓存：那种失败必须每次都如实报 ERR_DEVICE，不能被优化吞掉。
    std::string cachedRefusal;
    bool wantExclusive = exclusiveRequested;
    if (wantExclusive && requestedMode_ == OutputMode::Auto) {
        const std::string& deviceId = output_.status().deviceId;
        if (deviceId == exclusiveCacheDevice_) {
            const auto it = exclusiveRefusals_.find(
                exclusiveKey(streamRate, source->bitDepth(), source->channels()));
            if (it != exclusiveRefusals_.end()) {
                wantExclusive = false;
                cachedRefusal = it->second;
            }
        }
    }

    // E10b：shared 模式的流格式是设备混音格式，与源采样率无关——「源率 ≠ 已开流率」
    // 不是重开流的理由。旧代码用源率比较，跨采样率切歌每首都整段重开 WASAPI
    // （实测 70–150ms，CPU 只有 4.7ms，其余全是 COM/驱动等待）。
    // 独占分支仍按真实流格式比较：独占流是按源率/位深协商的，任何一项不同都要重开。
    // 反过来，独占流与当前源格式完全匹配时也不必重开（同格式连播省掉一次协商）。
    const bool exclusiveMatches = output_.status().isExclusive &&
                                  streamRate == openedRate_ &&
                                  source->channels() == openedChannels_ &&
                                  source->bitDepth() == output_.status().sourceBits;
    const bool sharedStreamUsable = output_.isOpen() && !output_.status().isExclusive &&
                                    source->channels() == openedChannels_;
    const bool needOpen = wantExclusive ? !exclusiveMatches : !sharedStreamUsable;

    if (needOpen) {
        StreamRequest request;
        // The source depth is passed in BOTH modes. Exclusive needs it to
        // negotiate the format; shared needs it to decide whether this stream
        // loses bits and therefore needs dither (SPEC line 203). Leaving it zero
        // in shared made that decision fall out of an unset field.
        request.bitDepth = source->bitDepth();
        request.latency  = latencyProfile_;
        output_.setLatencyProfile(latencyProfile_);
        if (wantExclusive) {
            request.sampleRate = streamRate;
            request.channels   = source->channels();
        }
        std::string openError;
        // open() clears its own status: never pass a reference into that status.
        const std::string deviceId = output_.status().deviceId;
        if (!output_.open(deviceId, requestedMode_, request, openError)) {
            // Shared could not open either: this IS a device failure.
            error = openError;
            emitState();
            return false;
        }
        openedRate_     = output_.status().sampleRate;
        openedChannels_ = output_.status().channels;
        openedBitDepth_ = output_.status().bitsPerSample;
        output_.setVolume(pendingVolume_);
        // A reopen must not resurrect audio the user muted: mute lives in the
        // output object, and every open() makes a new one.
        output_.setMuted(muted_);
        // CR-025：dither 档位也要在重开之后重新发布（对象状态跨流保留，但显式
        // 重发让"open 后一定生效"不依赖对象生命周期的隐含假设）。
        output_.setDitherMode(ditherMode_);
        // CR-028：淡变时长同样明确重发。
        output_.setFadeMs(fadeMs_);

        // CR-029：流打开后按真实采样率重建 virtual HRIR（bank 的 rate 必须等于流率）。
        {
            std::string spatialBuildError;
            if (!ensureSpatialBanks(spatialBuildError) && !spatialBuildError.empty()) {
                output_.setDegradeReason("spatial: " + spatialBuildError);
            }
        }
        // E10：学习这次的协商结果。只有 auto 模式参与缓存；成功后清掉这个格式
        // 的失败记录（设备/系统设置可能变过），失败则连同真实原因一起记住。
        if (wantExclusive && requestedMode_ == OutputMode::Auto) {
            exclusiveCacheDevice_ = output_.status().deviceId;
            const std::string key = exclusiveKey(streamRate, source->bitDepth(), source->channels());
            if (output_.status().isExclusive) {
                exclusiveRefusals_.erase(key);
            } else if (!output_.status().degradeReason.empty()) {
                exclusiveRefusals_[key] = output_.status().degradeReason;
            }
        }
    } else {
        // 流保持不变：shared 模式的 dither 判据仍要看到本曲的真实源位深（旧代码
        // 靠重开顺带更新，这里显式补上）。只写一个 int，不碰流。
        output_.setSourceBits(source->bitDepth());
    }

    // 缓存命中时也要如实解释为什么没走独占：state.degradeReason 是 UI 唯一的
    // 解释来源。不回填会出现「空原因」或沿用上一首的原因——前者是静默降级，
    // 后者是谎报（比如播 44.1k 却显示 96k 的失败原因）。
    if (!cachedRefusal.empty()) output_.setDegradeReason(cachedRefusal);

    const int outChannels = output_.status().channels;
    const int outRate     = output_.status().sampleRate;

    if (source->channels() != outChannels) {
        // Channel mapping is not implemented (SPEC 3.4 does not list a down/up
        // mixer), so say so instead of playing one channel and dropping the rest
        // in silence. Exclusive mode negotiated the source channel count, so
        // reaching here means the device refused and shared could not adapt.
        error = "source has " + std::to_string(source->channels()) +
                " channels but the output stream has " + std::to_string(outChannels) +
                "; channel mapping is not implemented in this build";
        return false;
    }

    // SPEC 3.4: same rate means skip the converter entirely. In exclusive mode
    // the rates always match by construction, so this is a passthrough and the
    // integer samples are never touched.
    auto resampler = std::make_unique<Resampler>();
    if (!resampler->configure(source.get(), source->sampleRate(), outRate, outChannels, error,
                              resamplerConfig_)) {
        return false;
    }

    // Rebuild the ring only when the channel count changed: the ring is sized in
    // frames, not bytes, so a rate change does not require a new one.
    if (!ring_.isConfigured() || ring_.channels() != outChannels) {
        ring_.configure(outChannels, static_cast<size_t>(outRate));   // one second
    }

    if (!output_.resetStream(error)) { emitState(); return false; }

    uint64_t startFrame = 0;
    {
        std::lock_guard<std::mutex> lock(sourceMutex_);
        source_      = std::move(source);
        resampler_   = std::move(resampler);
        deliveredFrames_.store(0, std::memory_order_release);
    }
    // A new playback session begins here, so the id moves here and not on
    // play(): an open is what invalidates the previous session's events, and
    // pause/resume must NOT manufacture a new one.
    ++operationId_;
    // CR-016: trackId may legitimately be EMPTY (a URL open with no catalog
    // row). It is still a loaded source, which is why loadedness is recorded
    // separately instead of being inferred from this string.
    currentTrackId_   = trackId;
    currentPath_      = sourcePath;
    sourceLoaded_     = true;
    trackSampleRate_  = source_->sampleRate();
    trackChannels_    = source_->channels();
    trackBitDepth_    = source_->bitDepth();
    // Ask the decoder rather than assume from the extension: a .wav can hold
    // ADPCM and an .mp3 is lossy by construction, and only the object holding the
    // codec knows which one it just opened. This is the sole input to
    // state.sourceExact -- see AudioSource::lossless().
    trackLossless_    = source_->lossless();
    // CR-032：源格式同样由解码器回答（DSD 源覆盖 sourceFormat/dsdRate）。
    sourceFormat_     = source_->sourceFormat();
    dsdRate_          = source_->dsdRate();
    trackTotalFrames_ = source_->totalFrames();
    meterAnalyzer_.reset();
    resetPlaybackBuffers(startFrame);

    if (wasPlaying) {
        startFeeder();
        if (!output_.start(ring_, &framesRendered_, true, error)) return false;
        state_ = PlayState::Playing;
        armExclusiveWatchdog();
    } else {
        state_ = PlayState::Stopped;
    }
    emitState();
    return true;
}

void Player::releaseSource() {
    stop();
    stopFeeder();
    std::lock_guard<std::mutex> lock(sourceMutex_);
    resampler_.reset();
    source_.reset();
    // No source survives this, so the loadedness flag must fall with it, or a
    // later play() would try to start a stream that has nothing behind it.
    sourceLoaded_ = false;
}

bool Player::play(std::string& error) {
    // Loadedness, not identity: a URL source (CR-016) has no trackId and must
    // still be playable. Using currentTrackId_.empty() here refused the one
    // thing the URL branch exists for.
    if (!sourceLoaded_) {
        error = "no track is open";
        return false;
    }
    if (state_ == PlayState::Playing) return true;

    if (!output_.isOpen()) {
        // 恢复路径：热插拔/设备切换失败会把流关掉（正常的 stop 不关流），旧行为
        // 是直接 ERR_DEVICE，用户只能重开曲目或重启应用。这里按当前曲目的格式
        // 重建默认端点——reopenOutput 内含默认端点回退与热插拔短暂重试。
        reopenOutput(std::string(), 0);
        if (!output_.isOpen()) {
            error = outputError_.empty() ? "no audio output device" : outputError_;
            return false;
        }
    }

    // V3 §1.1b：pause-hold 恢复。流从暂停起就没停过，位置/ring/设备缓冲都在原处，
    // 这里只重新启动 feeder 并请求一次等功率淡入——不 Start()，所以没有设备
    // 唤醒/时钟切换的爆音，也不会重播端点里的残留。
    if (state_ == PlayState::Paused && output_.isHolding() && !restartAfterEof_) {
        startFeeder();
        output_.setFadeMs(fadeMs_);
        output_.endHold(fadeMs_);
        state_ = PlayState::Playing;
        armExclusiveWatchdog();
        emitState();
        return true;
    }

    if (restartAfterEof_ && !resetSourcePosition(0, error)) return false;
    output_.setFadeMs(fadeMs_);
    startFeeder();
    if (!output_.start(ring_, &framesRendered_, true, error)) return false;
    state_ = PlayState::Playing;
    armExclusiveWatchdog();
    emitState();
    return true;
}

bool Player::ensureSpatialBanks(std::string& error) {
    const bool wantVirtual = dspParams_.spatialMode == SpatialMode::Virtual &&
                             dspParams_.spatialAmount > 0.0f;
    if (!wantVirtual) {
        for (auto& bank : spatialBanks_) retiredSpatial_.push_back(std::move(bank));
        while (retiredSpatial_.size() > 4) retiredSpatial_.erase(retiredSpatial_.begin());
        spatialBanks_.clear();
        output_.publishSpatialBanks(nullptr, nullptr);
        return true;
    }
    int rate = output_.status().sampleRate;
    if (rate <= 0) rate = trackSampleRate_ > 0 ? trackSampleRate_ : 48000;
    IrBank* a = nullptr;
    IrBank* b = nullptr;
    std::string buildError;
    if (!buildSpatialBanks(dspParams_.spatialAzimuth, rate, a, b, buildError)) {
        error = buildError.empty() ? "could not build the virtual HRIR banks" : buildError;
        return false;
    }
    // 旧 bank 至少活过当前块：渲染线程只读它在本块开头 adopt 到的指针。
    for (auto& bank : spatialBanks_) retiredSpatial_.push_back(std::move(bank));
    while (retiredSpatial_.size() > 4) retiredSpatial_.erase(retiredSpatial_.begin());
    spatialBanks_.clear();
    spatialBanks_.emplace_back(a);
    spatialBanks_.emplace_back(b);
    output_.publishSpatialBanks(a, b);
    return true;
}

bool Player::setSpatial(SpatialMode mode, float amount, float azimuth, float delayMs,
                        std::string& error) {
    if (!(amount >= 0.0f && amount <= 1.0f)) {
        error = "spatial amount must be within 0..1";
        return false;
    }
    if (!(azimuth >= -90.0f && azimuth <= 90.0f)) {
        error = "spatial azimuth must be within -90..90 degrees";
        return false;
    }
    if (!(delayMs >= 0.0f && delayMs <= 1.0f)) {
        error = "spatial delayMs must be within 0..1 ms";
        return false;
    }
    const DspParams old = dspParams_;
    dspParams_.spatialMode = mode;
    dspParams_.spatialAmount = amount;
    dspParams_.spatialAzimuth = azimuth;
    dspParams_.spatialDelayMs = delayMs;
    std::string buildError;
    if (!ensureSpatialBanks(buildError)) {
        // 回滚：无法构建 HRIR 时不能把 mode 留成 virtual——那是谎报生效。
        dspParams_ = old;
        publishDsp();
        error = buildError;
        return false;
    }
    publishDsp();
    emitState();
    return true;
}

Json Player::spatialJson() const {
    Json out = Json::object();
    out.set("mode", spatialModeName(dspParams_.spatialMode));
    out.set("amount", static_cast<double>(dspParams_.spatialAmount));
    const bool active = dspParams_.spatialMode != SpatialMode::Off &&
                        dspParams_.spatialAmount > 0.0f;
    out.set("active", active);
    out.set("azimuth", static_cast<double>(dspParams_.spatialAzimuth));
    out.set("delayMs", static_cast<double>(dspParams_.spatialDelayMs));
    // virtual 的 FFT 卷积有固定 1024 帧（21ms@48k）延迟；如实报告，用户才能判断
    // 唇音同步是否受影响。非 virtual 模式没有额外延迟。
    out.set("latencyFrames", static_cast<long long>(
        (active && dspParams_.spatialMode == SpatialMode::Virtual)
            ? output_.spatialLatencyFrames() : 0));
    if (active && dspParams_.spatialMode == SpatialMode::Virtual && spatialBanks_.empty()) {
        out.set("degradeReason", std::string("virtual HRIR banks are not built for this stream yet"));
    }
    return out;
}

void Player::setFadeMs(int milliseconds) {
    // CR-028 冻结协议：5–50ms。低于 5ms 起不到消除台阶的作用（线性 5ms 就是
    // 旧行为的时长），高于 50ms 暂停会显得迟钝，所以 clamp 而不是接受。
    if (milliseconds < 5) milliseconds = 5;
    if (milliseconds > 50) milliseconds = 50;
    fadeMs_ = milliseconds;
    output_.setFadeMs(fadeMs_);
    emitState();
}

void Player::pause() {
    if (state_ != PlayState::Playing) return;
    if (beginPauseHold()) {
        // 流没停：只停 feeder（不再往 ring 里解码），渲染线程继续跑并输出静音。
        stopFeeder();
        state_ = PlayState::Paused;
        emitState();
        return;
    }
    // 回退路径（pauseHold 关闭 / 流未运行 / 设备未排空）：保持旧行为。
    fadeOutBeforeStop();
    output_.stop();
    stopFeeder();
    state_ = PlayState::Paused;
    emitState();
}

void Player::stop() {
    fadeOutBeforeStop();
    output_.stop();
    stopFeeder();
    if (source_) {
        std::string error;
        if (!resetSourcePosition(0, error)) {
            output_.setDegradeReason(error);
            Json note = Json::object();
            note.set("ev", "log");
            note.set("level", "error");
            note.set("message", error);
            app_.emitEvent(note);
        }
    }
    meterAnalyzer_.reset();
    state_ = PlayState::Stopped;
    emitState();
}

bool Player::seek(long long positionMs, std::string& error) {
    // Same loadedness/identity distinction as play(): seeking a URL source is a
    // core part of streaming playback (CR-016).
    if (!sourceLoaded_) {
        error = "no track is open";
        return false;
    }
    const int rate = trackSampleRate_ > 0 ? trackSampleRate_ : output_.status().sampleRate;
    if (positionMs < 0) positionMs = 0;

    uint64_t frame = static_cast<uint64_t>((positionMs * static_cast<long long>(rate)) / 1000);
    if (trackTotalFrames_ > 0 && frame >= trackTotalFrames_) frame = trackTotalFrames_ > 0 ? trackTotalFrames_ - 1 : 0;

    const bool wasPlaying = (state_ == PlayState::Playing);
    if (wasPlaying) {
        // V3 §1.1d：seek 也走淡出。旧代码直接 stop()，在任意采样相位硬切——
        // 这是四个场景中最容易被听到的爆音（低音/大振幅内容尤其明显）。
        // 用传输下限 15ms：仍快于用户对"跳转"的感知阈值，同时把 5ms 时留下的
        // 硬件缓冲截断（驱动 pop）也包进淡出 + 静音 padding 里。
        fadeOutBeforeStop(kTransportFadeMinMs);
        output_.stop();
    } else if (output_.isHolding()) {
        // 暂停-hold 中 seek：hold 的前提是"位置没变"，这里先撤掉 hold 再重建。
        output_.setHold(false);
        output_.stop();
    }
    stopFeeder();

    if (!resetSourcePosition(frame, error)) {
        state_ = PlayState::Stopped;
        emitState();
        return false;
    }
    meterAnalyzer_.reset();

    if (wasPlaying) {
        output_.setFadeMs(fadeMs_);
        startFeeder();
        if (!output_.start(ring_, &framesRendered_, true, error)) return false;
    }
    emitState();
    return true;
}


// ---------------------------------------------------------------------------
// The double-state model (CR-010)
// ---------------------------------------------------------------------------
//
// These replace a single boolean that was answering two questions at once and
// getting one of them wrong. The format question and the chain question are
// genuinely different: a 24-bit source in a 24-in-32 container delivers the same
// audio as 24-in-24, but it is not a format passthrough, and calling it one is
// the over-claim the external reference points at.

bool Player::pcmPassthrough() const {
    const OutputStatus& s = output_.status();
    if (!s.isExclusive) return false;
    // A float stream is a sample-format conversion by definition, whatever the
    // arithmetic does to the values.
    if (s.isFloat) return false;
    // Same rate and channel count as the source, or the backend converted.
    if (trackSampleRate_ > 0 && s.sampleRate != trackSampleRate_) return false;
    if (trackChannels_ > 0 && s.channels != trackChannels_) return false;
    if (resampler_ && !resampler_->passthrough()) return false;
    // THE LINE THE OLD CODE MISSED. A container wider than the source precision
    // is not a format passthrough: the endpoint is being handed 32-bit slots for
    // 24-bit audio. It is audibly identical and it is not the file's own
    // packing, and this field is about the packing.
    if (s.sourceBits > 0 && s.bitsPerSample != s.sourceBits) return false;
    if (s.sourceBits > 0 && s.validBits < s.sourceBits) return false;
    return true;
}

bool Player::outputPerfect() const {
    if (!pcmPassthrough()) return false;
    // The stream the engine is actually committed to. After the exclusive-silence
    // watchdog has run, exclusive is no longer viable on this endpoint; claiming
    // perfection from a stream about to be torn down would contradict
    // state.outputMode.
    if (requestedMode_ == OutputMode::Shared) return false;
    // A volume below unity is a gain change, and a gain change is by definition
    // not the stored integers. SPEC 3.3 wants the UI told the moment it stops
    // being bit-perfect, which is why dragging the slider must clear the badge.
    //
    // This condition lived in WasapiOutput::isBitPerfect() and was LOST when the
    // three-field model was introduced: outputPerfect() no longer called into it,
    // so a stream at 50% volume went on claiming bit-perfect. The assertion that
    // caught it had been passing for the wrong reason until exclusive actually
    // worked on a real DAC.
    if (output_.volume() < 0.9999f) return false;
    // SPEC 1.1: bit-perfect means the STORED integers reach the device. The
    // moment an EQ band, a preamp or a ReplayGain offset is in force they are no
    // longer the stored integers, however good they sound. The chain reports its
    // own state so this holds even when a band is 0 dB or a gain lands on exactly
    // 1.0 by coincidence.
    if (!output_.dspPassthrough()) return false;
    return true;
}

bool Player::sourceExact() const {
    if (!outputPerfect()) return false;
    // A LOSSY SOURCE CANNOT BE SOURCE-EXACT, and that is the whole reason this
    // field exists: an MP3 played through a flawless chain is outputPerfect and
    // not sourceExact. Without the distinction the UI reports the same false
    // value for both, and the user reads a chain defect where there is only a
    // property of the file they chose.
    //
    // The lossy decoder this separation was written in anticipation of has
    // landed: MP3 decodes now, so this is no longer equal to outputPerfect() on
    // every track. An MP3 through a flawless exclusive chain is outputPerfect and
    // NOT sourceExact -- which is exactly the pair of facts a single boolean
    // could not state, and the reason the field was split before it was needed.
    return trackLossless_;
}

std::string Player::outputNotPerfectReason() const {
    const OutputStatus& s = output_.status();
    if (!s.isExclusive)         return "shared output goes through the system mixer";
    if (s.isFloat)              return "float pipeline";
    if (trackSampleRate_ > 0 && s.sampleRate != trackSampleRate_)
                                return "resampled";
    if (trackChannels_ > 0 && s.channels != trackChannels_)
                                return "channel count changed";
    if (resampler_ && !resampler_->passthrough()) return "resampled";
    if (s.sourceBits > 0 && s.bitsPerSample != s.sourceBits) {
        // Named after the external reference's reason code, because it is the
        // same situation: the integer values survive but the container changed.
        //
        // Say WHOSE constraint it is. The candidate list is tried
        // narrowest-container-first, so landing on a wider container means the
        // narrower one was offered and the endpoint refused it. That is the
        // difference between a defect the code could fix and a permanent
        // property of this device -- and it is the difference between a UI that
        // should nag and one that should just state a fact.
        const std::string narrow = std::to_string(s.sourceBits) + "-bit container";
        const std::string wide = std::to_string(s.bitsPerSample) + "-bit container";
        return "integer passthrough unavailable: " + std::to_string(s.sourceBits) +
               "-bit audio in a " + wide + " (this endpoint refuses a " + narrow + ")";
    }
    if (requestedMode_ == OutputMode::Shared) return "exclusive not in force";
    if (!output_.dspPassthrough()) {
        std::vector<std::string> active;
        if (dspParams_.eqEnabled) active.emplace_back("equalizer");
        if (dspParams_.rgMode > 0) active.emplace_back("ReplayGain");
        if (dspParams_.preampDb != 0.0f || dspParams_.rgPreampDb != 0.0f)
            active.emplace_back("preamp gain");
        if (!midSideNeutral(dspParams_)) active.emplace_back("mid/side controls");
        if (dspParams_.crossfeedEnabled) active.emplace_back("crossfeed");
        if (!channelToolsNeutral(dspParams_)) active.emplace_back("channel controls");
        if (active.empty()) return "audio processing is active";

        std::string stages;
        for (size_t i = 0; i < active.size(); ++i) {
            if (i != 0) stages += (i + 1 == active.size()) ? " and " : ", ";
            stages += active[i];
        }
        return "audio processing is active: " + stages;
    }
    return "";
}

void Player::setMuted(bool on) {
    muted_ = on;
    output_.setMuted(on);
    // A state event for the same reason setVolume emits one: this is part of the
    // authoritative state, and a change the UI is not told about is a change it
    // cannot show.
    emitState();
}


void Player::setMeterEnabled(bool enabled) {
    if (enabled && !meterEnabled_) {
        // 从"不看"回到"看"：隐藏/关闭期间 emitMeter() 完全不做分析（见下），
        // 所以分析器停在旧时间点（FFT 窗口序号 + EBU 400 ms 历史）。不清掉的话，
        // 重新可见的第一帧会把陈旧窗口当新窗口，peakHold 的衰减还会按错误的
        // sequenceDelta 跳变。reset() 之后第一帧就是当前窗口。
        meterAnalyzer_.reset();
    }
    meterEnabled_ = enabled;
}

bool Player::emitMeter() {
    if (state_ != PlayState::Playing || !output_.isOpen()) return false;
    // 不可见时整段分析都不做（E2）。CR-015 原本只约束"不发 IPC"，但实测
    // FFT(8192×2ch) + EBU true-peak 是每帧约 393 µs 的固定成本（2ch/48k、60 帧/秒
    // = 2.36% 单核，见 .smoke/perf-audit/perf-engine/bench）。后台播放/关闭监测时
    // 没人看却照付——这是本轮测量里最大的一笔背景 CPU。
    //
    // 这是**有意的行为变化**（Lead 记入 CR）：隐藏/关闭期间 meter 读数暂停推进。
    // 重新可见时 setMeterEnabled() 复位分析器，2–3 个控制循环（≤50 ms）内第一帧
    // 就是当前窗口；EBU Momentary 需要 400 ms 窗口重填，会在约一秒内从底噪爬回
    // 真实值——与"表头刚打开"一致，不是故障。
    if (!meterEnabled_) return false;
    const int rate = output_.status().sampleRate;
    const int channels = output_.status().channels;
    if (rate <= 0 || channels <= 0) return false;
    if (meterPreparedRate_ != rate || meterPreparedChannels_ != channels) {
        std::string error;
        if (!meterAnalyzer_.prepare(rate, channels, error)) return false;
        meterPreparedRate_ = rate;
        meterPreparedChannels_ = channels;
    }
    MeterResult result;
    if (!meterAnalyzer_.analyze(output_.meterTap(), result)) return false;

    // 0.1 dB 量化（R8）：meter 是给眼睛看的电平/光带，0.1 dB 已细于人耳可辨阈值；
    // 而 JSON 里每个数字的位数直接决定帧体积与序列化成本。量化后 to_chars 输出
    // "-12.3" 而不是 "-12.345678901234567"，帧体积因而大幅下降。
    // 必须用 double 做除法：float 的 -12.3f 转回 double 是 -12.300000190734863，
    // 最短表示反而变长，等于没省。
    const auto quantize01 = [](float value) {
        return std::round(static_cast<double>(value) * 10.0) / 10.0;
    };

    Json event = Json::object();
    event.obj().reserve(16);   // 键数固定，避免 vector 的 4 次扩容（E3）
    event.set("ev", "meter");
    auto channelsArray = [&](const std::array<float, MeterResult::kMaxChannels>& values) {
        Json array = Json::array();
        array.arr().reserve(static_cast<std::size_t>(result.channels));
        for (int ch = 0; ch < result.channels; ++ch) {
            array.push(quantize01(values[static_cast<size_t>(ch)]));
        }
        return array;
    };
    event.set("rmsDb", channelsArray(result.rmsDb));
    event.set("peakDb", channelsArray(result.peakDb));
    event.set("peakHoldDb", channelsArray(result.peakHoldDb));
    event.set("truePeakDb", channelsArray(result.truePeakDb));
    event.set("truePeakBasis", result.truePeakOversampled ? "oversampled" : "sample");
    if (result.hasMomentaryLufs) event.set("lufsMomentary", quantize01(result.lufsMomentary));
    event.set("gainReductionDb", quantize01(output_.meterGainReductionDb()));
    // R8：waveform 字段不再发送。渲染层 audio/meterStore.ts 从不读它，而 64 对
    // min/max 是 meter 帧里最大的一块（真机 749 B/帧里约 550 B）。分析器仍然计算它
    // （--selftest 用它验证窗口测量正确），只是不再上 IPC。
    Json spectrum = Json::array();
    spectrum.arr().reserve(static_cast<std::size_t>(result.spectrumCount));
    for (int i = 0; i < result.spectrumCount; ++i) {
        spectrum.push(quantize01(result.spectrumDb[static_cast<size_t>(i)]));
    }
    event.set("spectrum", std::move(spectrum));
    // 帧体积已知（约 400 B），预分配字符串省掉 dump 过程中的扩容（E3）。
    app_.emitEvent(event, 512);
    return true;
}

void Player::setVolume(float volume) {
    if (volume < 0.0f) volume = 0.0f;
    if (volume > 1.0f) volume = 1.0f;
    pendingVolume_ = volume;
    output_.setVolume(volume);
    emitState();
}

long long Player::positionMs() const {
    // Two clocks meet here and they are NOT the same clock.
    //
    // seekBaseFrame_ is a position in SOURCE frames; framesRendered_ counts
    // frames the DEVICE has consumed. When the resampler is in the path those
    // differ by the rate ratio (44100/48000 for most of this library), so
    // adding them and dividing by one rate made the reported position run about
    // 8 percent slow: a five minute track reached its end with the progress bar
    // still 25 seconds short. Convert the device frames back to source frames
    // first, then express the total in source time.
    const int srcRate = trackSampleRate_ > 0 ? trackSampleRate_ : output_.status().sampleRate;
    const int outRate = output_.status().sampleRate > 0 ? output_.status().sampleRate : srcRate;
    if (srcRate <= 0) return 0;

    const uint64_t playedDevice = framesRendered_.load(std::memory_order_acquire);
    const uint64_t playedSource = (outRate == srcRate)
        ? playedDevice
        : (playedDevice * static_cast<uint64_t>(srcRate)) / static_cast<uint64_t>(outRate);

    const uint64_t sourceFrame = seekBaseFrame_ + playedSource;
    return static_cast<long long>((sourceFrame * 1000ull) / static_cast<uint64_t>(srcRate));
}

long long Player::durationMs() const {
    // The SOURCE rate, not the device rate. trackTotalFrames_ counts source
    // frames; once the resampler is in the path the device consumes a different
    // number of them, and dividing source frames by the device rate shortened
    // every 44.1 kHz track on a 48 kHz device by exactly 44100/48000 -- about
    // 25 seconds on a 5 minute track.
    const int rate = trackSampleRate_ > 0 ? trackSampleRate_ : output_.status().sampleRate;
    if (rate <= 0) return 0;
    return static_cast<long long>((trackTotalFrames_ * 1000ull) / static_cast<uint64_t>(rate));
}

bool Player::advanceQueue(std::string& error) {
    if (queue_.empty()) {
        error = "the queue is empty";
        return false;
    }
    if (repeatMode_ == RepeatMode::RepeatOne) {
        return true;      // same index: the caller replays the same track
    }
    if (repeatMode_ == RepeatMode::Shuffle && queue_.size() > 1) {
        static std::mt19937 rng{std::random_device{}()};
        std::uniform_int_distribution<size_t> pick(0, queue_.size() - 1);
        size_t next = queueIndex_;
        while (next == queueIndex_) next = pick(rng);
        queueIndex_ = next;
        return true;
    }
    if (queueIndex_ + 1 < queue_.size()) {
        ++queueIndex_;
        return true;
    }
    if (repeatMode_ == RepeatMode::RepeatAll) {
        queueIndex_ = 0;
        return true;
    }
    error = "end of queue";
    return false;
}

bool Player::skipNext(std::string& error, bool userInitiated) {
    (void)userInitiated;
    return advanceQueue(error);
}

bool Player::skipPrevious(std::string& error, bool userInitiated) {
    if (queue_.empty()) {
        error = "the queue is empty";
        return false;
    }
    if (repeatMode_ == RepeatMode::Shuffle && queue_.size() > 1) {
        return advanceQueue(error);
    }
    if (queueIndex_ < 0) {
        // CR-030：当前曲目不在队列里（queueIndex=-1）时，"上一首"没有前项，
        // 从队列头开始比返回 -2 越界更合理（旧代码会把它减成 -2）。
        queueIndex_ = 0;
    } else if (queueIndex_ == 0) {
        if (repeatMode_ == RepeatMode::RepeatAll) queueIndex_ = queue_.size() - 1;
        else {
            error = "start of queue";
            return false;
        }
    } else {
        --queueIndex_;
    }
    (void)userInitiated;
    return true;
}

void Player::setQueue(const std::vector<std::string>& trackIds, bool keepCurrent,
                      const std::string& currentTrackId) {
    queue_ = trackIds;
    if (!keepCurrent) {
        queueIndex_ = 0;
        emitState();
        return;
    }
    // CR-030：调用方可以显式给 currentTrackId（队列面板知道是哪首在放），
    // 省略时用引擎记录的当前曲目。URL 源（无 trackId）找不到成员时就是 -1。
    const std::string& target = !currentTrackId.empty() ? currentTrackId : currentTrackId_;
    queueIndex_ = -1;
    if (!target.empty()) {
        for (std::size_t i = 0; i < queue_.size(); ++i) {
            if (queue_[i] == target) {
                queueIndex_ = static_cast<int>(i);
                break;
            }
        }
    }
    emitState();
}

const std::string& Player::queuedTrackId() const {
    static const std::string kNone;
    if (queue_.empty() || queueIndex_ >= queue_.size()) return kNone;
    return queue_[queueIndex_];
}

bool Player::tick(long long elapsedMs, std::string& endedTrackId) {
    // Input faults take priority over stall recovery, adaptive reopen and EOF,
    // including when the transport failed while playback was paused.
    if (handleInputFailure()) return false;
    // FIRST, and before the "not playing" early return further down: while
    // paused or stopped this re-baselines, so that a long pause can never look
    // like a stall the instant playback resumes. Putting it after that guard
    // would leave the baseline frozen for the whole pause and fire on resume.
    serviceRenderLiveness(elapsedMs);
    // CR-015 visibility extension: only serialize/push while the UI is visible.
    // 8 ms：真正的上限不是这个数，而是**控制循环本身的节拍**——循环里 pollLine
    // 每轮等约 15 ms，实测稳定在 65 次/秒。节流写成 16 ms 时，两个 15 ms 才凑够，
    // 实测只有 40 帧/秒（用户仍然觉得卡）。放到 8 ms 之后，每轮循环都会发一帧，
    // 上限自然落到循环节拍上（~60 帧/秒，与显示器同频）。
    if (elapsedMs - lastMeterEmitMs_ >= 8) {
        if (emitMeter()) lastMeterEmitMs_ = elapsedMs;
    }
    // The transient half of the xrun report.
    //
    // state.xrunCount is the authoritative, session-cumulative total (DESIGN-A
    // 4.2). But a total cannot tell a UI that something JUST happened -- it can
    // only say how many times in total. C1 flashes and C2 marks the path on the
    // event, so the event has to exist. AI-B declared {ev:'xrun',count,bufferMs}
    // in protocol.ts from the start; the engine simply never emitted it.
    //
    // Emitted from the control loop rather than the audio thread: the RT thread
    // may not write to stdout, and this is a reporting concern anyway.
    const unsigned xruns = output_.status().xrunCount.load(std::memory_order_relaxed);
    if (xruns > lastReportedXruns_) {
        lastReportedXruns_ = xruns;
        const unsigned total = xruns;
        const double bufferMs = output_.status().currentBufferMs;
        // The xrun history SPEC 182 asks for. Written where the event is
        // emitted, so the file and the wire always agree about what happened
        // and when -- two records of the same fact that disagree are worse than
        // one, because they cost the reader a decision about which to trust.
        // The same lesson the stall record taught: print the STATE the fault
        // happened in, not just the fact that it happened. Three underruns sat
        // unexplained at one track boundary in three consecutive soaks, and the
        // only way to stop guessing is to write down, at that instant, whether
        // the feeder knew it was finished and how much was still buffered.
        diagRecord("xrun", "count=" + std::to_string(total) +
                           " bufferMs=" + std::to_string(bufferMs) +
                           " ringBuffered=" + std::to_string(ring_.readableFrames()) +
                           " inputExhausted=" + (inputExhausted_.load() ? "1" : "0") +
                           " delivered=" + std::to_string(deliveredFrames_.load()) +
                           " trackTotal=" + std::to_string(trackTotalFrames_) +
                           " device=" + output_.status().deviceId);
        app_.emitEvent([total, bufferMs] {
            Json frame = Json::object();
            frame.set("ev", "xrun");
            frame.set("count", static_cast<long long>(total));
            frame.set("bufferMs", bufferMs);
            return frame;
        }());
    }

    // SPEC 3.2 adaptive recovery. The render thread is not allowed to reopen a
    // stream, so it raises a flag and the control thread acts on it here.
    if (output_.takeBufferIncreaseRequest()) {
        const int bigger = output_.requestedBufferMs();
        const int rate = output_.status().sampleRate;
        if (rate > 0) {
            // Keep the playback position across the reopen. The stream is
            // rebuilt, so the device clock restarts from zero; the SOURCE frame
            // the engine is at is what has to survive, expressed in source
            // frames so it stays correct when the resampler is in the path.
            const int srcRate = trackSampleRate_ > 0 ? trackSampleRate_ : rate;
            const uint64_t playedDevice = framesRendered_.load(std::memory_order_acquire);
            const uint64_t playedSource = (rate == srcRate)
                ? playedDevice
                : (playedDevice * static_cast<uint64_t>(srcRate)) / static_cast<uint64_t>(rate);
            const uint64_t resumeFrame = seekBaseFrame_ + playedSource;
            app_.emitEvent([] {
                Json note = Json::object();
                note.set("ev", "log");
                note.set("level", "warn");
                note.set("message", "repeated underruns: increasing the output buffer");
                return note;
            }());
            diagRecord("buffer", "increased to " + std::to_string(bigger) +
                                " ms after repeated underruns");
            const std::string device = output_.status().deviceId;
            const bool wasPlaying = (state_ == PlayState::Playing);
            reopenOutput(device, bigger);
            if (output_.isOpen()) {
                // AFTER the reopen, never before: open() calls resetStatus(),
                // which clears degradeReason, so a reason set earlier would be
                // silently erased and the increase would look like nothing
                // happened. DESIGN-A 2.1 requires this one because the user is
                // owed an explanation for audio that momentarily changed.
                output_.setDegradeReason(
                    "repeated underruns: the output buffer was increased to " +
                    std::to_string(output_.status().currentBufferMs) + " ms");
                std::string resetError;
                if (!resetSourcePosition(resumeFrame, resetError)) {
                    output_.setDegradeReason("could not restore the source after buffer recovery: " + resetError);
                    state_ = PlayState::Stopped;
                    emitState();
                    return false;
                }
                if (wasPlaying) {
                    startFeeder();
                    std::string error;
                    if (output_.start(ring_, &framesRendered_, true, error)) {
                        // reopenOutput() pauses to release the device, so the
                        // playing state has to be put back explicitly. Without
                        // this the buffer increase 'succeeds' into a paused
                        // player and the music simply stops -- the same class of
                        // bug as the exclusive-silence fallback had.
                        state_ = PlayState::Playing;
                        armExclusiveWatchdog();
                    }
                }
                emitState();
            }
        }
    }

    if (state_ != PlayState::Playing) return false;

    // Catch a failure published while this tick was doing routine work.
    if (handleInputFailure()) return false;

    // The exclusive-silence watchdog runs first: if the stream never produced a
    // frame, everything below would report a healthy track that makes no sound.
    std::string degrade;
    if (checkExclusiveWatchdog(elapsedMs, degrade)) {
        app_.emitEvent([]() {
            Json note = Json::object();
            note.set("ev", "log");
            note.set("level", "warn");
            note.set("message", "exclusive output produced no audio; falling back to shared");
            return note;
        }());
        const std::string device = output_.status().deviceId;
        // reopenOutput() pauses first (it has to release the device), so the
        // playing state has to be restored explicitly afterwards. Without this
        // the fallback 'succeeds' into a paused player, which looks like the
        // engine giving up rather than recovering.
        const uint64_t resumeFrames = framesRendered_.load(std::memory_order_acquire);
        requestedMode_ = OutputMode::Shared;
        reopenOutput(device);
        output_.setDegradeReason(degrade);
        if (output_.isOpen()) {
            // Restart from the same source position so the fallback is seamless.
            startFeeder();
            std::string error;
            if (output_.start(ring_, &framesRendered_, true, error)) {
                state_ = PlayState::Playing;
                armExclusiveWatchdog();   // will not re-arm: the stream is shared now
                emitState();
                return false;
            }
        }
        // Shared could not start either: that IS a device failure, and the state
        // event is how the app finds out (there is no command in flight to fail).
        state_ = PlayState::Stopped;
        emitState();
        (void)resumeFrames;
        return false;
    }

    if (lastEmitMs_ < 0 || elapsedMs - lastEmitMs_ >= kPositionIntervalMs) {
        lastEmitMs_ = elapsedMs;

        Json event = Json::object();
        event.set("ev", "position");
        // Every event belonging to a session carries its id, so a late frame
        // from a replaced session is identifiable instead of merely suspicious
        // (CR-007).
        event.set("operationId", operationId_);
        event.set("trackId", currentTrackId_);
        event.set("positionMs", positionMs());
        event.set("durationMs", durationMs());
        app_.emitEvent(event);
    }

    if (trackTotalFrames_ == 0) return false;

    // FOUR facts are needed, and the fourth is the one that is easy to miss.
    //
    // The external reference is explicit about the distinction (ECHO:
    // inputEnded / isDrained): inputEnded means the decoder has no more data,
    // isDrained means the output has actually finished playing it. Declaring the
    // end at decoder EOF truncates the tail of every track, and auto-advance and
    // progress both jump.
    //
    // The subtle version of that mistake is what this code used to do. It counted
    // frames the render thread had PULLED FROM THE ENGINE RING and called the
    // ring-dry moment 'played'. Frames pulled are not frames heard: when the ring
    // goes dry, up to one device period is still sitting in the WASAPI endpoint
    // buffer. handleTrackFinished() then stops the stream and that period is
    // discarded, on every track, silently.
    //
    // So: compare what the DEVICE has played (IAudioClock) against what was fed
    // to it, and only then declare the end.
    // Two ways to know the input is finished, and BOTH are needed:
    //   * the decoder said so (inputExhausted_), which is the only authority on
    //     how much audio a file actually holds;
    //   * the declared total was reached, which still covers the case where the
    //     feeder is between the last read and the next one.
    const bool inputExhausted = inputExhausted_.load(std::memory_order_acquire);
    const bool feederDone = inputExhausted ||
                            deliveredFrames_.load(std::memory_order_acquire) >= trackTotalFrames_;
    const bool ringDry    = ring_.readableFrames() == 0;
    // The device half of the same fact: has the endpoint finished playing what it
    // was handed? Compare like with like by counting frames fed for THIS stream
    // against the device's own finished count, rather than against a total that a
    // seek would invalidate.
    const uint64_t fed = fedFrames_.load(std::memory_order_acquire);
    const bool deviceDrained = output_.audioDrained(fed);
    const uint64_t played = framesRendered_.load(std::memory_order_acquire);

    // `played > 0` USED TO GUARD THIS, AND THAT GUARD IS THE BUG.
    //
    // Its purpose was to avoid declaring the end of a stream that had never
    // produced anything. But framesRendered_ is RESET TO ZERO by the
    // adaptive-buffer reopen -- it has to be, because the device clock restarts
    // with the new stream -- so a track that reaches its end just after such a
    // reopen can NEVER satisfy `played > 0`. The engine then sits with a dry
    // ring and an exhausted feeder, reporting "playing" forever.
    //
    // Two consecutive 30-minute soaks produced exactly that, at the first track
    // boundary that followed an underrun burst, and the diagnostic record said
    // it in four numbers:
    //     rendered=0  wakes=202 (and climbing)  ringBuffered=0  mode=exclusive
    // The device was signalling, the render thread was alive, and there was
    // nothing to play -- because the track had ENDED and nobody could say so.
    //
    // What actually separates "has not started" from "has finished" is whether
    // anything was ever FED. fedFrames_ is reset by open() and by seek(), but
    // NOT by a reopen, so after the counter that broke this was zeroed it still
    // means what the guard was trying to mean.
    const bool everRan = (played > 0) || (fed > 0);
    if (feederDone && ringDry && deviceDrained && everRan) {
        endOfStreamReached_ = true;
    }
    if (!endOfStreamReached_) return false;

    endOfStreamReached_ = false;
    endedTrackId = currentTrackId_;
    restartAfterEof_ = true;

    // Release the device and the feeder before the caller decides what plays
    // next. This is also what makes the device available to the next open()
    // without a race.
    output_.stop();
    stopFeeder();
    state_ = PlayState::Stopped;

    // CONTRACT 3.3: the state event is the authoritative value and the UI must
    // not infer playback state. A track that reaches its natural end therefore
    // has to publish the stop; without this the app kept showing playing for a
    // stream that had already been closed. Emitted before the caller's ended
    // event, so a UI sees stopped and then that the track ended.
    emitState();
    return true;
}

// ---------------------------------------------------------------------------
// The M2 quality chain
// ---------------------------------------------------------------------------
//
// Every setter validates against the SPEC limits BEFORE storing, and refuses
// rather than clipping: SPEC 3.4 allows +/-12 dB in 0.5 dB steps and Q over
// 0.5..4. A caller that asks for +40 dB has a bug, and silently giving it 12 dB
// would hide that bug behind a plausible-sounding result.

void Player::setEqEnabled(bool on) {
    dspParams_.eqEnabled = on;
    publishDsp();
    emitState();
}

bool Player::setEqBand(int band, float gainDb, std::string& error) {
    if (band < 0 || band >= kEqBandCount) {
        error = "EQ band index must be 0.." + std::to_string(kEqBandCount - 1);
        return false;
    }
    if (!(gainDb >= -12.0f && gainDb <= 12.0f)) {
        error = "EQ gain must be within -12.0 .. +12.0 dB";
        return false;
    }
    dspParams_.eqGainDb[band] = gainDb;
    publishDsp();
    emitState();
    return true;
}

bool Player::setEqBandFreq(int band, float freqHz, std::string& error) {
    if (band < 0 || band >= kEqBandCount) {
        error = "EQ band index must be 0.." + std::to_string(kEqBandCount - 1);
        return false;
    }
    // 0 is the documented "back to the SPEC grid" value.
    if (freqHz != 0.0f && !(freqHz >= 10.0f && freqHz <= 24000.0f)) {
        error = "EQ band frequency must be 0 (default) or within 10 .. 24000 Hz";
        return false;
    }
    dspParams_.eqFreq[band] = freqHz;
    publishDsp();
    emitState();
    return true;
}

bool Player::setEqBandQ(int band, float q, std::string& error) {
    if (band < 0 || band >= kEqBandCount) {
        error = "EQ band index must be 0.." + std::to_string(kEqBandCount - 1);
        return false;
    }
    if (q != 0.0f && !(q >= 0.1f && q <= 10.0f)) {
        error = "EQ band Q must be 0 (default) or within 0.1 .. 10";
        return false;
    }
    dspParams_.eqBandQ[band] = q;
    publishDsp();
    emitState();
    return true;
}

bool Player::setEqBandType(int band, int type, std::string& error) {
    if (band < 0 || band >= kEqBandCount) {
        error = "EQ band index must be 0.." + std::to_string(kEqBandCount - 1);
        return false;
    }
    if (type < 0 || type > 2) {
        error = "EQ band type must be 0 (peaking), 1 (low shelf) or 2 (high shelf)";
        return false;
    }
    dspParams_.eqType[band] = static_cast<int8_t>(type);
    publishDsp();
    emitState();
    return true;
}

bool Player::loadIr(const std::string& path, std::string& error) {
    if (path.empty()) { error = "set_ir: path is empty"; return false; }
    std::string loadError;
    IrBank* bank = IrBank::load(path, loadError);
    if (bank == nullptr) { error = loadError; return false; }

    // Keep the previous two banks alive. The render thread may still hold the
    // pointer it read at the top of its current block; two replacements cannot
    // happen inside one 21 ms block, so the oldest is safe to release here.
    retiredIr_.push_back(std::move(irBank_));
    while (retiredIr_.size() > 2) retiredIr_.erase(retiredIr_.begin());
    // Auto level: normalise the response's PEAK gain to 0 dB. A correction IR
    // that boosts +6 dB somewhere clips a full-scale signal, and "it sounded
    // fine" is not evidence it does not. The user can still move the trim.
    const float autoPreamp = -bank->maxGainDb();
    irBank_.reset(bank);

    output_.publishIr(bank);
    dspParams_.irPreampDb = autoPreamp < -24.0f ? -24.0f : (autoPreamp > 24.0f ? 24.0f : autoPreamp);
    dspParams_.irEnabled = true;
    publishDsp();
    emitState();
    return true;
}

bool Player::setIrEnabled(bool enabled) {
    dspParams_.irEnabled = enabled;
    publishDsp();
    emitState();
    return true;
}

bool Player::setIrPreamp(float db) {
    dspParams_.irPreampDb = db < -24.0f ? -24.0f : (db > 24.0f ? 24.0f : db);
    publishDsp();
    emitState();
    return true;
}

bool Player::setEqQ(float q, std::string& error) {
    if (!(q >= 0.5f && q <= 4.0f)) {
        error = "EQ Q must be within 0.5 .. 4.0";
        return false;
    }
    dspParams_.eqQ = q;
    publishDsp();
    emitState();
    return true;
}

void Player::setEqPreamp(float preampDb) {
    dspParams_.preampDb = preampDb;
    publishDsp();
    emitState();
}

void Player::setAutoHeadroom(bool on) {
    dspParams_.autoHeadroom = on;
    publishDsp();
    emitState();
}

bool Player::setReplayGainMode(const std::string& mode, std::string& error) {
    int value = 0;
    if (mode == "off")        value = 0;
    else if (mode == "track") value = 1;
    else if (mode == "album") value = 2;
    else {
        error = "replayGain mode must be off, track or album";
        return false;
    }
    dspParams_.rgMode = value;
    publishDsp();
    emitState();
    return true;
}

void Player::setReplayGainValues(float trackGainDb, float albumGainDb, float preampDb,
                                 float trackPeak, float albumPeak, bool preventClip) {
    // Values come from the scanner, so they are stored as given: they describe
    // the FILE, and refusing them would mean refusing a legitimate master.
    dspParams_.rgTrackGainDb = trackGainDb;
    dspParams_.rgAlbumGainDb = albumGainDb;
    dspParams_.rgPreampDb    = preampDb;
    dspParams_.rgTrackPeak   = trackPeak;
    dspParams_.rgAlbumPeak   = albumPeak;
    dspParams_.preventClip   = preventClip;
    publishDsp();
    emitState();
}


bool Player::setBalance(float balance, std::string& error) {
    if (!(balance >= -1.0f && balance <= 1.0f)) {
        error = "balance must be within -1.0 (left) .. +1.0 (right)";
        return false;
    }
    dspParams_.balance = balance;
    publishDsp();
    emitState();
    return true;
}

void Player::setMono(bool on) {
    // CR-026：旧 mono:true 的语义固定为 monoMode=sum；关掉时只清掉它自己设过的
    // sum，不覆盖用户显式选的 left/right（setMonoMode 之后旧 API 不该反悔）。
    dspParams_.mono = on;
    if (on) {
        dspParams_.monoMode = 1;
    } else if (dspParams_.monoMode == 1) {
        dspParams_.monoMode = 0;
    }
    publishDsp();
    emitState();
}

bool Player::setMonoMode(int mode, std::string& error) {
    if (mode < 0 || mode > 3) {
        error = "monoMode must be 0 (off), 1 (sum), 2 (left) or 3 (right)";
        return false;
    }
    dspParams_.monoMode = mode;
    // 保持旧字段与新模式一致：dspJson 的 channels.mono 继续可用。
    dspParams_.mono = (mode == 1);
    publishDsp();
    emitState();
    return true;
}

bool Player::setBandGain(int band, int channel, float gainDb, std::string& error) {
    if (band < 0 || band > 2) {
        error = "bandGain band must be 0 (low), 1 (mid) or 2 (high)";
        return false;
    }
    if (channel < 0 || channel > 1) {
        error = "bandGain channel must be 0 (left) or 1 (right)";
        return false;
    }
    if (!(gainDb >= -6.0f && gainDb <= 3.0f)) {
        error = "band gain must be within -6.0 .. +3.0 dB";
        return false;
    }
    dspParams_.bandGainDb[band][channel] = gainDb;
    publishDsp();
    emitState();
    return true;
}

bool Player::setChannelDelay(int channel, float delayMs, std::string& error) {
    if (channel < 0 || channel > 1) {
        error = "channelDelay channel must be 0 (left) or 1 (right)";
        return false;
    }
    if (!(delayMs >= 0.0f && delayMs <= 10.0f)) {
        error = "channel delay must be within 0 .. 10 ms";
        return false;
    }
    dspParams_.channelDelayMs[channel] = delayMs;
    publishDsp();
    emitState();
    return true;
}

bool Player::setStereoWidth(float width, std::string& error) {
    // 0 = mono, 1 = unchanged, 2 = maximum. Beyond 2 the side signal dominates
    // and the result is mostly out-of-phase content, which collapses in mono
    // playback -- so the limit is a usability boundary, not an arbitrary one.
    if (!(width >= 0.0f && width <= 2.0f)) {
        error = "stereoWidth must be within 0.0 (mono) .. 2.0";
        return false;
    }
    dspParams_.stereoWidth = width;
    publishDsp();
    emitState();
    return true;
}

bool Player::setMidGain(float gainDb, std::string& error) {
    if (!(gainDb >= -12.0f && gainDb <= 12.0f)) {
        error = "midGainDb must be within -12.0 .. +12.0 dB";
        return false;
    }
    dspParams_.midGainDb = gainDb;
    publishDsp();
    emitState();
    return true;
}

bool Player::setSideGain(float gainDb, std::string& error) {
    if (!(gainDb >= -12.0f && gainDb <= 12.0f)) {
        error = "sideGainDb must be within -12.0 .. +12.0 dB";
        return false;
    }
    dspParams_.sideGainDb = gainDb;
    publishDsp();
    emitState();
    return true;
}

bool Player::setLimiter(bool enabled, float ceilingDb, float releaseMs, float lookaheadMs,
                       std::string& error) {
    if (!(ceilingDb >= -12.0f && ceilingDb <= 0.0f)) {
        error = "limiter ceilingDb must be within -12 .. 0 dBFS";
        return false;
    }
    if (!(releaseMs >= 5.0f && releaseMs <= 1000.0f)) {
        error = "limiter releaseMs must be within 5 .. 1000 ms";
        return false;
    }
    if (!(lookaheadMs >= 0.0f && lookaheadMs <= 20.0f)) {
        error = "limiter lookaheadMs must be within 0 .. 20 ms";
        return false;
    }
    dspParams_.limiterEnabled     = enabled;
    dspParams_.limiterCeilingDb   = ceilingDb;
    dspParams_.limiterReleaseMs   = releaseMs;
    dspParams_.limiterLookaheadMs = lookaheadMs;
    publishDsp();
    emitState();
    return true;
}

int Player::limiterLatencyFrames() const {
    if (!dspParams_.limiterEnabled || dspParams_.limiterLookaheadMs <= 0.0f) return 0;
    const int rate = output_.status().sampleRate > 0 ? output_.status().sampleRate
                                                     : (trackSampleRate_ > 0 ? trackSampleRate_ : 48000);
    return static_cast<int>(dspParams_.limiterLookaheadMs * 0.001f *
                            static_cast<float>(rate) + 0.5f);
}

void Player::setCrossfeedEnabled(bool on) {
    dspParams_.crossfeedEnabled = on;
    publishDsp();
    emitState();
}

bool Player::setCrossfeedPreset(int preset, std::string& error) {
    static constexpr float frequencies[] = { 700.0f, 700.0f, 650.0f };
    static constexpr float feedsDb[] = { 4.5f, 6.0f, 9.5f };
    if (preset < 0 || preset > 2) {
        error = "crossfeedPreset must be 0 (default), 1 (Chu Moy) or 2 (Jan Meier)";
        return false;
    }
    dspParams_.crossfeedPreset = preset;
    dspParams_.crossfeedFcHz = frequencies[preset];
    dspParams_.crossfeedFeedDb = feedsDb[preset];
    publishDsp();
    emitState();
    return true;
}

bool Player::setCrossfeedFcHz(float frequency, std::string& error) {
    if (!(frequency >= 100.0f && frequency <= 4000.0f)) {
        error = "crossfeedFcHz must be within 100 .. 4000 Hz";
        return false;
    }
    dspParams_.crossfeedFcHz = frequency;
    dspParams_.crossfeedPreset = -1;
    publishDsp();
    emitState();
    return true;
}

bool Player::setCrossfeedFeedDb(float feedDb, std::string& error) {
    if (!(feedDb >= 0.0f && feedDb <= 12.0f)) {
        error = "crossfeedFeedDb must be within 0 .. 12 dB";
        return false;
    }
    dspParams_.crossfeedFeedDb = feedDb;
    dspParams_.crossfeedPreset = -1;
    publishDsp();
    emitState();
    return true;
}

void Player::setSwapChannels(bool on) {
    dspParams_.swapChannels = on;
    publishDsp();
    emitState();
}

bool Player::setChannelGain(int channel, float gainDb, std::string& error) {
    if (channel < 0 || channel > 1) {
        error = "channelGain index must be 0 (left) or 1 (right)";
        return false;
    }
    if (!(gainDb >= -12.0f && gainDb <= 12.0f)) {
        error = "channel gain must be within -12.0 .. +12.0 dB";
        return false;
    }
    dspParams_.channelGainDb[channel] = gainDb;
    publishDsp();
    emitState();
    return true;
}

Json Player::dspJson() const {
    Json eq = Json::object();
    eq.set("enabled", dspParams_.eqEnabled);
    eq.set("q", static_cast<double>(dspParams_.eqQ));
    eq.set("preampDb", static_cast<double>(dspParams_.preampDb));
    eq.set("autoHeadroom", dspParams_.autoHeadroom);
    Json bands = Json::array();
    for (int b = 0; b < kEqBandCount; ++b) {
        Json band = Json::object();
        // Reported RESOLVED, not raw: a zeroed slot must read back as the grid
        // frequency / global Q / peaking, or a client would have to duplicate
        // the resolution rules to know what it is actually listening to.
        const EqBandShape shape = resolveEqBand(dspParams_, b);
        band.set("freq", shape.freq);
        band.set("gainDb", static_cast<double>(dspParams_.eqGainDb[b]));
        band.set("q", shape.q);
        band.set("type", shape.type == EqBandType::LowShelf ? "lowShelf"
                          : shape.type == EqBandType::HighShelf ? "highShelf" : "peaking");
        bands.push(std::move(band));
    }
    eq.set("bands", std::move(bands));

    const char* modeName = dspParams_.rgMode == 2 ? "album"
                         : (dspParams_.rgMode == 1 ? "track" : "off");
    Json rg = Json::object();
    rg.set("mode", modeName);
    rg.set("trackGainDb", static_cast<double>(dspParams_.rgTrackGainDb));
    rg.set("albumGainDb", static_cast<double>(dspParams_.rgAlbumGainDb));
    rg.set("preampDb", static_cast<double>(dspParams_.rgPreampDb));
    rg.set("preventClip", dspParams_.preventClip);

    // CR-020: room correction. Reported from the PLAYER's bank, not the chain's
    // adopted one: right after a load the render thread has not swapped yet, and
    // reporting "nothing loaded" for one block would be a lie to the interface.
    Json ir = Json::object();
    const IrBank* bank = irBank_.get();
    ir.set("loaded", bank != nullptr);
    ir.set("enabled", dspParams_.irEnabled && bank != nullptr);
    ir.set("preampDb", static_cast<double>(dspParams_.irPreampDb));
    ir.set("latencyFrames", bank != nullptr ? output_.irLatencyFrames() : 0);
    if (bank != nullptr) {
        ir.set("name", bank->name());
        ir.set("taps", bank->taps());
        ir.set("channels", bank->channels());
        ir.set("sampleRate", bank->sampleRate());
        ir.set("partitions", bank->partitions());
        ir.set("maxGainDb", static_cast<double>(bank->maxGainDb()));
        ir.set("rmsGainDb", static_cast<double>(bank->rmsGainDb()));
        Json curve = Json::array();
        for (const auto& point : bank->curve()) {
            Json entry = Json::object();
            entry.set("hz", static_cast<double>(point.first));
            entry.set("db", static_cast<double>(point.second));
            curve.push(std::move(entry));
        }
        ir.set("curve", std::move(curve));
    }
    Json out = Json::object();
    out.set("ir", std::move(ir));
    out.set("eq", std::move(eq));
    out.set("replayGain", std::move(rg));
    // Reported from the CONFIGURATION, not from the render thread's adopted copy.
    // A UI sets the EQ while playback is stopped, and with no stream running the
    // chain has adopted nothing -- reporting that would show zero gain for a
    // configuration that is about to apply -6 dB. The formula is shared with the
    // live path (computeStaticGainDb), so the two cannot drift.
    out.set("appliedGainDb", static_cast<double>(computeStaticGainDb(dspParams_)));
    // CR-020: the bypass decision has to include the IR, and it has to be made
    // from CONFIGURATION like everything else in this block. Judging it from the
    // chain's adopted pointer instead would report "bit-perfect" for as long as
    // the render thread has not run -- i.e. every time the engine is stopped,
    // which is exactly when a user loads an impulse response.
    const bool irInForce = irBank_ != nullptr && dspParams_.irEnabled;
    out.set("passthrough", isPassthroughConfig(dspParams_) && !irInForce);
    // Whether the chain is actually running right now is a different question,
    // and worth exposing: it explains why appliedGainDb has not taken effect yet.
    out.set("streaming", output_.isOpen());
    // A limiter that is working is worth surfacing: it explains why a loud
    // passage sounds compressed, and it is the one DSP stage that alters
    // dynamics rather than tone.
    out.set("limiterEnabled", dspParams_.limiterEnabled);
    // CR-031：完整的限幅器回读。limiterEnabled 保留（旧客户端仍在读），这里
    // 只增一个对象把它们绑在一起；truePeakActive 如实为 false —— 本构建按
    // 采样峰判定，谎报 true-peak 会让"为什么还有削波"这类问题无法回答。
    {
        Json limiter = Json::object();
        limiter.set("enabled", dspParams_.limiterEnabled);
        limiter.set("ceilingDb", static_cast<double>(dspParams_.limiterCeilingDb));
        limiter.set("releaseMs", static_cast<double>(dspParams_.limiterReleaseMs));
        limiter.set("lookaheadMs", static_cast<double>(dspParams_.limiterLookaheadMs));
        limiter.set("latencyFrames", static_cast<long long>(limiterLatencyFrames()));
        limiter.set("truePeakActive", false);
        limiter.set("gainReductionDb", static_cast<double>(output_.meterGainReductionDb()));
        out.set("limiter", std::move(limiter));
    }

    // The channel tools, reported for the same reason the EQ is: a UI shows the
    // controls it owns, and it must be able to read back what is in force rather
    // than trusting its own last command.
    Json ch = Json::object();
    ch.set("balance", static_cast<double>(dspParams_.balance));
    ch.set("mono", dspParams_.mono);
    ch.set("midGainDb", static_cast<double>(dspParams_.midGainDb));
    ch.set("sideGainDb", static_cast<double>(dspParams_.sideGainDb));
    ch.set("stereoWidth", static_cast<double>(dspParams_.stereoWidth));
    ch.set("swapChannels", dspParams_.swapChannels);
    Json gains = Json::array();
    for (int i = 0; i < 2; ++i) {
        Json g = Json::object();
        g.set("channel", static_cast<long long>(i));
        g.set("gainDb", static_cast<double>(dspParams_.channelGainDb[i]));
        gains.push(std::move(g));
    }
    ch.set("channelGains", std::move(gains));
    // CR-026：monoMode / 三频段 L/R 增益 / 每声道延迟。全部只增字段，旧客户端忽略即可。
    const char* monoModeName = dspParams_.monoMode == 1 ? "sum"
                             : (dspParams_.monoMode == 2 ? "left"
                             : (dspParams_.monoMode == 3 ? "right" : "off"));
    ch.set("monoMode", monoModeName);
    {
        Json bandGains = Json::object();
        const char* bandNames[3] = {"low", "mid", "high"};
        for (int band = 0; band < 3; ++band) {
            Json pair = Json::array();
            pair.push(static_cast<double>(dspParams_.bandGainDb[band][0]));
            pair.push(static_cast<double>(dspParams_.bandGainDb[band][1]));
            bandGains.set(bandNames[band], std::move(pair));
        }
        ch.set("bandGains", std::move(bandGains));
    }
    {
        Json delays = Json::array();
        delays.push(static_cast<double>(dspParams_.channelDelayMs[0]));
        delays.push(static_cast<double>(dspParams_.channelDelayMs[1]));
        ch.set("delayMs", std::move(delays));
    }
    out.set("channels", std::move(ch));
    Json crossfeed = Json::object();
    crossfeed.set("enabled", dspParams_.crossfeedEnabled);
    crossfeed.set("preset", dspParams_.crossfeedPreset);
    crossfeed.set("fcHz", static_cast<double>(dspParams_.crossfeedFcHz));
    crossfeed.set("feedDb", static_cast<double>(dspParams_.crossfeedFeedDb));
    out.set("crossfeed", std::move(crossfeed));
    return out;
}

} // namespace te