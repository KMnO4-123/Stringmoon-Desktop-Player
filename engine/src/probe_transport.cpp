// probe_transport.cpp — 离线传输测试面（verifier 用，替代 loopback 录音）。
//
// 为什么需要它：设备可能被用户正在使用的播放器独占（本机就是），此时无法开流、
// 也无法录 loopback；但"暂停/切歌是否硬切"这个问题可以在**离线模型**里精确回答：
//
//   * 包络使用生产代码 AudioFade（sin²/cos²，与真实 RT 路径同一实现）；
//   * 设备模型按真实参数推进：48kHz、10ms 设备周期、fade 排空语义、Reset 顺序；
//   * 每个事件输出结构性计数（paddingAtStop / fadeCompleted / resetBeforeStart /
//     fadeDrainTimeouts）与样本级证据（lastSampleBeforeStop / firstSampleAfterStart /
//     maxDeltaInWindow，均已归一化到满刻度 1.0）。
//
// 它不是 loopback 的替代品（听不到设备底噪），但可以把"数字域是否硬切"变成
// 可复算的数字；真机听感仍由 owner 确认。
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "audio_fade.hpp"
// 与生产共用同一组传输瞬态常量（kTransportFadeMinMs / kStopSilencePadMs），
// 避免 probe 里再抄一份数字、以后和 output_wasapi.cpp 漂移。
#include "output_wasapi.hpp"

namespace te {
namespace {

constexpr int    kRate       = 48000;
constexpr int    kBlock      = 480;      // 10 ms device period (measured on this machine)
constexpr double kTwoPi      = 6.28318530717958647692;
constexpr double kAmplitude  = 0.1;      // -20 dBFS：与 verifier 的 0.013 normal maxΔ 对齐
// 淡出归零后、Stop/Reset/Close 之前写进端点的静音帧数（与生产同一公式）。
constexpr int    kPadFrames  = kRate * kStopSilencePadMs / 1000;

struct EventReport {
    std::string event;
    // paddingAtStop 的语义：Stop 之前补进端点的静音帧数（>0 才合格）；
    // pause 没有 Stop，固定 -1。旧实现该字段是"端点里剩余 padding"，恒为 0。
    int   paddingAtStop = -1;
    int   padFrames = 0;               // 本事件实际写入的静音 padding 帧数
    bool  fadeCompleted = false;
    bool  resetBeforeStart = false;
    bool  holdBufferSilent = false;    // pause-hold 冻结时端点缓冲是否全 0
    unsigned fadeDrainTimeouts = 0;
    double lastSampleBeforeStop = 0.0;
    double firstSampleAfterStart = 0.0;
    double maxDeltaInWindow = 0.0;
    // 对照：旧行为（无淡出，直接切）在同一相位下的值。
    double controlLastSample = 0.0;
    double controlMaxDelta = 0.0;
};

class OfflineTransport {
public:
    explicit OfflineTransport(double initialPhase) : phase_(initialPhase) {
        timeline_.reserve(kRate * 8);
    }

    void play() {
        running_ = true;
        resetBeforeStart_ = true;     // 首次 start 会预滚静音（等价 Reset 语义）
        fade_.beginIn(kRate, 10);
        renderBlocks(2);
    }

    // pause-hold：淡出到 0 后保持"流"运行，继续渲染静音；返回结构计数。
    EventReport pauseHold(int fadeMs) {
        EventReport r;
        r.event = "pause";
        const size_t cut = timeline_.size();
        const double controlSignal = currentSignalAbs();   // 旧行为会在这里硬切
        (void)cut;
        fade_.beginOut(kRate, fadeMs);
        renderUntilFadeDone();
        r.lastSampleBeforeStop = std::fabs(static_cast<double>(timeline_.back()));
        r.fadeCompleted = true;
        // 与生产一致：淡出归零后先写 kStopSilencePadMs 的静音，再进入 hold。
        // 冻结必须发生在"端点里已经是确定的 0"之后，而不是最后一块还有数据时。
        appendSilence(kPadFrames);
        r.padFrames = kPadFrames;
        r.paddingAtStop = -1;              // 没有 Stop
        r.resetBeforeStart = false;
        // hold 期间渲染 2 个 block 静音（设备仍在跑，这是 pause-hold 的定义）。
        for (int b = 0; b < 2; ++b) appendSilence(kBlock);
        // 冻结时端点缓冲是否全 0：取最后 (padding + 2 block) 帧检查。
        {
            const size_t count = static_cast<size_t>(kPadFrames) + 2u * kBlock;
            const size_t begin = timeline_.size() > count ? timeline_.size() - count : 0;
            bool silent = true;
            for (size_t i = begin; i < timeline_.size(); ++i) {
                if (timeline_[i] != 0.0f) { silent = false; break; }
            }
            r.holdBufferSilent = silent;
        }
        r.controlLastSample = controlSignal;
        r.controlMaxDelta = controlSignal;
        return r;
    }

    EventReport resume(int fadeMs) {
        EventReport r;
        r.event = "resume";
        const size_t cut = timeline_.size();
        const double controlSignal = currentSignalAbs();
        fade_.beginIn(kRate, fadeMs);
        renderBlocks(2);
        r.firstSampleAfterStart = std::fabs(static_cast<double>(timeline_[cut]));
        r.maxDeltaInWindow = maxDeltaAround(cut, 128);
        r.fadeCompleted = true;
        r.paddingAtStop = -1;
        r.resetBeforeStart = true;
        r.controlLastSample = controlSignal;
        r.controlMaxDelta = controlSignal;
        return r;
    }

    // seek / 切歌：淡出→Stop→Reset→Start(fadeIn)。
    EventReport stopAndRestart(const char* name, int fadeMs, double newPhase) {
        EventReport r;
        r.event = name;
        const size_t cut = timeline_.size();
        const double controlSignal = currentSignalAbs();
        fade_.beginOut(kRate, fadeMs);
        renderUntilFadeDone();
        r.lastSampleBeforeStop = std::fabs(static_cast<double>(timeline_.back()));
        r.fadeCompleted = true;
        // 生产语义（kStopSilencePadMs）：淡出归零后，在 Stop/Reset/Close 之前再往
        // 端点写一段静音并等它排空。本离线模型把这段静音 append 进 timeline；
        // paddingAtStop 定义为"停流前补的静音帧数"，必须 > 0 才算合格。
        appendSilence(kPadFrames);
        r.padFrames = kPadFrames;
        r.paddingAtStop = kPadFrames;
        resetBeforeStart_ = true;
        // Reset 后从新相位开始，先 fadeIn 再出音频。
        phase_ = newPhase;
        running_ = true;
        const size_t startCut = timeline_.size();
        fade_.beginIn(kRate, kPlaybackRampMs);
        renderBlocks(2);
        r.firstSampleAfterStart = std::fabs(static_cast<double>(timeline_[startCut]));
        r.maxDeltaInWindow = std::max(maxDeltaAround(cut, 128), maxDeltaAround(startCut, 128));
        r.resetBeforeStart = resetBeforeStart_;   // 本次重启确实做了 Reset
        r.controlLastSample = controlSignal;
        r.controlMaxDelta = controlSignal;
        return r;
    }

    EventReport stop(int fadeMs) {
        EventReport r;
        r.event = "stop";
        const size_t cut = timeline_.size();
        const double controlSignal = currentSignalAbs();
        (void)cut;
        fade_.beginOut(kRate, fadeMs);
        renderUntilFadeDone();
        r.lastSampleBeforeStop = std::fabs(static_cast<double>(timeline_.back()));
        r.fadeCompleted = true;
        // 与 seek/switch 同一条生产语义：Stop 之前先补静音 padding 并等排空。
        appendSilence(kPadFrames);
        r.padFrames = kPadFrames;
        r.paddingAtStop = kPadFrames;
        r.resetBeforeStart = false;
        r.controlLastSample = controlSignal;
        r.controlMaxDelta = controlSignal;
        running_ = false;
        return r;
    }

    // 结构计数：这个离线模型没有真实设备 deadline，所以超时恒为 0；真实引擎的
    // 计数在 state.fade.fadeDrainTimeouts 里，由 --probe-transport 以外的门禁检查。
    unsigned fadeDrainTimeouts() const { return 0; }

private:
    void renderBlocks(int blocks) {
        for (int b = 0; b < blocks && running_; ++b) renderBlock(kBlock);
    }

    void renderUntilFadeDone() {
        // 与真实渲染线程一致：淡出期间只读 fade.remainingFrames() 个"音频"帧，
        // 块内其余位置补 0；淡出完成后还需要一块把最后的音频样本交给设备。
        while (fade_.active()) renderBlock(kBlock);
        renderBlock(kBlock);
    }

    void renderBlock(int frames) {
        const int audioFrames = std::min(frames, fade_.remainingFrames() > 0
                                                     ? fade_.remainingFrames() : frames);
        lastAudioFrames_ = audioFrames;
        for (int i = 0; i < frames; ++i) {
            float sample = 0.0f;
            if (i < audioFrames) {
                const double gain = static_cast<double>(fade_.next());
                sample = static_cast<float>(kAmplitude * std::sin(phase_) * gain);
                phase_ += kTwoPi * 1000.0 / kRate;
                if (phase_ > kTwoPi) phase_ -= kTwoPi;
            }
            timeline_.push_back(sample);
        }
    }

    void appendSilence(int frames) {
        for (int i = 0; i < frames; ++i) timeline_.push_back(0.0f);
        lastAudioFrames_ = 0;
    }

    // 旧行为（无淡出）在当下会硬切的样本绝对值。初始相位故意不是 0：1kHz 在
    // 48k 下每 480 帧恰好 10 个整周期，块边界处的正弦恒为 0——那会让"硬切对照"
    // 退化成 0，看起来像旧代码没有爆音。故意错开相位，对照值才是真实的最坏情况。
    double currentSignalAbs() const {
        return std::fabs(kAmplitude * std::sin(phase_));
    }

    double maxDeltaAround(size_t cut, int halfWindow) const {
        const size_t begin = cut > static_cast<size_t>(halfWindow) ? cut - halfWindow : 0;
        const size_t end = std::min(timeline_.size(), cut + static_cast<size_t>(halfWindow));
        double worst = 0.0;
        for (size_t i = begin + 1; i < end; ++i) {
            worst = std::max(worst, std::fabs(static_cast<double>(timeline_[i]) -
                                              static_cast<double>(timeline_[i - 1])));
        }
        return worst;
    }

    AudioFade fade_;
    std::vector<float> timeline_;
    double phase_ = 0.371;   // 每个 phase run 由构造函数覆盖
    bool running_ = false;
    bool resetBeforeStart_ = false;
    int lastAudioFrames_ = 0;
};

void printEvent(const EventReport& r, unsigned drainTimeouts) {
    std::printf("    {\"event\": \"%s\", \"paddingAtStop\": %d, \"padFrames\": %d, "
                "\"fadeCompleted\": %s, \"resetBeforeStart\": %s, "
                "\"holdBufferSilent\": %s, \"fadeDrainTimeouts\": %u, "
                "\"lastSampleBeforeStop\": %.6f, \"firstSampleAfterStart\": %.6f, "
                "\"maxDeltaInWindow\": %.6f, "
                "\"control\": {\"lastSampleBeforeStop\": %.6f, \"maxDeltaInWindow\": %.6f}}",
                r.event.c_str(), r.paddingAtStop, r.padFrames,
                r.fadeCompleted ? "true" : "false",
                r.resetBeforeStart ? "true" : "false",
                r.holdBufferSilent ? "true" : "false",
                drainTimeouts,
                r.lastSampleBeforeStop, r.firstSampleAfterStart, r.maxDeltaInWindow,
                r.controlLastSample, r.controlMaxDelta);
}

} // namespace

int runTransportProbe(int argc, char** argv) {
    bool json = false;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--json") == 0) json = true;
    }
    // verifier 要求每类事件在 8 个相位下都验证：单相位可能恰好落在过零点，
    // 让"旧代码硬切"退化成一个看不出问题的样本值。45° 步进覆盖整周期。
    static constexpr double kPhaseDegrees[8] = {0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0};
    static constexpr double kPi = 3.14159265358979323846;
    struct Run {
        double phaseDeg = 0.0;
        std::vector<EventReport> events;
        unsigned drainTimeouts = 0;
    };
    std::vector<Run> runs;
    for (double deg : kPhaseDegrees) {
        OfflineTransport t(deg * kPi / 180.0);
        Run run;
        run.phaseDeg = deg;
        t.play();
        // 与生产一致：暂停/停止/seek/切歌用传输淡出下限（15ms）；恢复的
        // fade-in 用播放链路配置值（10ms）。
        run.events.push_back(t.pauseHold(kTransportFadeMinMs));
        run.events.push_back(t.resume(kPlaybackRampMs));
        run.events.push_back(t.stopAndRestart("seek", kTransportFadeMinMs, 0.7 + deg * 0.011));
        run.events.push_back(t.stopAndRestart("switch", kTransportFadeMinMs, 1.3 + deg * 0.013));
        run.events.push_back(t.stop(kTransportFadeMinMs));
        run.drainTimeouts = t.fadeDrainTimeouts();
        runs.push_back(std::move(run));
    }

    // fadeCurve：生产 AudioFade 的 sin² 曲线（淡入前 8 个 / 淡出后 8 个增益值），
    // 供 verifier 直接断言"不是线性"：sin² 在 1/4 点约 0.146，线性是 0.25。
    const int curveFrames = kRate * 10 / 1000;
    const int quarter = curveFrames / 4;
    float first8[8] = {};
    float last8[8] = {};
    for (int i = 0; i < 8; ++i) {
        first8[i] = AudioFade::gainAt(AudioFade::Direction::In, i, curveFrames);
        last8[i] = AudioFade::gainAt(AudioFade::Direction::Out, curveFrames - 8 + i, curveFrames);
    }
    const float quarterIn = AudioFade::gainAt(AudioFade::Direction::In, quarter, curveFrames);
    const float quarterOut = AudioFade::gainAt(AudioFade::Direction::Out, quarter, curveFrames);
    const float midpointIn = AudioFade::gainAt(AudioFade::Direction::In, curveFrames / 2, curveFrames);

    // --- 断言：把"数字域没有硬切 + Stop 前确有静音 padding"变成可判定的事实 ---
    //
    // 判据直接来自生产不变量：
    //   * 淡出最后一帧精确为 0（lastSampleBeforeStop == 0）；
    //   * 淡入第一帧精确为 0（firstSampleAfterStart == 0）；
    //   * stop/seek/switch 在 Stop/Reset 前补 kStopSilencePadMs 的静音，所以
    //     paddingAtStop == kPadFrames > 0（旧实现该字段是"端点剩余 padding"，
    //     恒为 0，正是用户听到爆音的窗口）；
    //   * pause-hold 冻结时端点缓冲必须是确定的 0（holdBufferSilent）；
    //   * 任何事件的 128 帧窗口内不得出现采样级台阶（maxDelta 应与 1kHz 正弦
    //     自然斜率同量级）；对照组（无淡出的硬切）必须显著更大，否则这些断言
    //     既证明不了"没有台阶"，也证明不了自己测得出台阶。
    int checksPassed = 0;
    int checksFailed = 0;
    auto expect = [&](bool ok, const std::string& what) {
        if (ok) { ++checksPassed; return; }
        ++checksFailed;
        std::fprintf(stderr, "  FAIL  %s\n", what.c_str());
    };
    double worstControlStep = 0.0;
    for (const auto& run : runs) {
        for (const auto& e : run.events) {
            worstControlStep = std::max(worstControlStep, e.controlLastSample);
            worstControlStep = std::max(worstControlStep, e.controlMaxDelta);
            if (e.event == "pause") {
                expect(e.paddingAtStop == -1,
                       "pause: no Stop is performed (paddingAtStop stays -1)");
                expect(e.padFrames == kPadFrames,
                       "pause: " + std::to_string(kPadFrames) +
                           " frames of silence are written before hold");
                expect(e.holdBufferSilent,
                       "pause-hold freezes on a fully silent endpoint buffer");
            } else if (e.event == "resume") {
                // 恢复是 hold 的延续，没有 Stop，因此没有停流 padding；
                // 它的判据是"从 0 淡入"（见下面的 firstSampleAfterStart）。
                expect(e.paddingAtStop == -1,
                       "resume: no Stop is performed (paddingAtStop stays -1)");
            } else {
                expect(e.paddingAtStop == kPadFrames,
                       e.event + ": " + std::to_string(kPadFrames) +
                           " frames of silence padded before Stop (paddingAtStop=" +
                           std::to_string(e.paddingAtStop) + ")");
                expect(e.fadeCompleted, e.event + ": fade-out completed before Stop");
            }
            expect(e.lastSampleBeforeStop <= 1e-6,
                   e.event + ": last sample before Stop is exactly 0 (got " +
                       std::to_string(e.lastSampleBeforeStop) + ")");
            if (e.event == "resume" || e.event == "seek" || e.event == "switch") {
                expect(e.firstSampleAfterStart <= 1e-6,
                       e.event + ": first sample after Start is exactly 0 (fade-in starts at 0)");
            }
            expect(e.maxDeltaInWindow < 0.02,
                   e.event + ": no sample-level step in the transition window (maxDelta=" +
                       std::to_string(e.maxDeltaInWindow) + ")");
        }
    }
    expect(worstControlStep > 0.05,
           "control (no fade) still hard-cuts, so the checks can detect a step (worst=" +
               std::to_string(worstControlStep) + ")");
    // gainAt() 是解析 helper：端点按 float 精度趋近 0（运行态 next() 会强制精确
    // 落在 target 上，前面的事件断言已覆盖 lastSample/firstSample == 0）。
    expect(static_cast<double>(first8[0]) <= 1e-7 && static_cast<double>(last8[7]) <= 1e-6,
           "fade curve endpoints approach 0 at float precision (in first, out last)");
    // 1/4 点的解析值是 sin^2(pi/2 * quarter/(frames-1)) ≈ 0.147027；线性是 0.25。
    const double quarterT = static_cast<double>(quarter) / static_cast<double>(curveFrames - 1);
    const double quarterRef = std::sin(kPi / 2.0 * quarterT);
    const double quarterRefSq = quarterRef * quarterRef;
    expect(std::fabs(static_cast<double>(quarterIn) - quarterRefSq) < 1e-6,
           "fade curve matches sin^2 at the quarter point (got " +
               std::to_string(quarterIn) + ", expected " + std::to_string(quarterRefSq) + ")");
    expect(std::fabs(static_cast<double>(quarterIn) - 0.25) > 0.05,
           "fade curve is equal-power, not linear (linear quarter gain would be 0.25, got " +
               std::to_string(quarterIn) + ")");
    if (checksFailed == 0) {
        std::fprintf(stderr, "transport checks: all %d passed\n", checksPassed);
    } else {
        std::fprintf(stderr, "transport checks: %d FAILED of %d\n", checksFailed,
                     checksPassed + checksFailed);
    }

    if (!json) {
        for (const auto& run : runs) {
            std::printf("phase %6.1f deg  drainTimeouts=%u\n", run.phaseDeg, run.drainTimeouts);
            for (const auto& e : run.events) {
                std::printf("  %-8s paddingAtStop=%d padFrames=%d fadeCompleted=%d "
                            "resetBeforeStart=%d holdSilent=%d last=%.6f first=%.6f "
                            "maxDelta=%.6f (control last=%.6f maxDelta=%.6f)\n",
                            e.event.c_str(), e.paddingAtStop, e.padFrames,
                            e.fadeCompleted ? 1 : 0, e.resetBeforeStart ? 1 : 0,
                            e.holdBufferSilent ? 1 : 0, e.lastSampleBeforeStop,
                            e.firstSampleAfterStart, e.maxDeltaInWindow,
                            e.controlLastSample, e.controlMaxDelta);
            }
        }
        std::printf("transport fadeMinMs=%d silencePadMs=%d silencePadFrames=%d\n",
                    kTransportFadeMinMs, kStopSilencePadMs, kPadFrames);
        std::printf("fadeCurve sin2 quarterIn=%.6f (linear would be 0.25) quarterOut=%.6f midpointIn=%.6f\n",
                    quarterIn, quarterOut, midpointIn);
        return checksFailed == 0 ? 0 : 1;
    }
    std::printf("{\n");
    std::printf("  \"probe\": \"transport\",\n");
    std::printf("  \"mode\": \"offline-model\",\n");
    std::printf("  \"sampleRate\": %d,\n", kRate);
    std::printf("  \"deviceBlockFrames\": %d,\n", kBlock);
    // paddingAtStop 的语义从这里可见：Stop 前补的静音帧数必须 > 0。
    std::printf("  \"transport\": {\"fadeMinMs\": %d, \"silencePadMs\": %d, "
                "\"silencePadFrames\": %d},\n",
                kTransportFadeMinMs, kStopSilencePadMs, kPadFrames);
    std::printf("  \"signal\": {\"type\": \"sine\", \"frequencyHz\": 1000, \"amplitude\": %.1f},\n", kAmplitude);
    std::printf("  \"thresholds\": {\"hardCutLastSample\": 0.1, \"hardCutMaxDelta\": 0.052, "
                "\"normalMaxDelta\": 0.013},\n");
    std::printf("  \"fadeCurve\": {\"curve\": \"sin2\", \"frames\": %d, \"first8\": [", curveFrames);
    for (int i = 0; i < 8; ++i) std::printf("%s%.6f", i ? ", " : "", static_cast<double>(first8[i]));
    std::printf("], \"last8\": [");
    for (int i = 0; i < 8; ++i) std::printf("%s%.6f", i ? ", " : "", static_cast<double>(last8[i]));
    std::printf("], \"quarterGain\": %.6f, \"quarterGainLinearWouldBe\": 0.25, "
                "\"midpointGain\": %.6f, \"firstGain\": %.6f, \"lastGain\": %.6f},\n",
                static_cast<double>(quarterIn), static_cast<double>(midpointIn),
                static_cast<double>(first8[0]), static_cast<double>(last8[7]));
    std::printf("  \"phasesDeg\": [");
    for (int i = 0; i < 8; ++i) std::printf("%s%.1f", i ? ", " : "", kPhaseDegrees[i]);
    std::printf("],\n");
    std::printf("  \"runs\": [\n");
    for (size_t r = 0; r < runs.size(); ++r) {
        std::printf("    {\"phaseDeg\": %.1f, \"fadeDrainTimeouts\": %u, \"events\": [\n",
                    runs[r].phaseDeg, runs[r].drainTimeouts);
        for (size_t i = 0; i < runs[r].events.size(); ++i) {
            printEvent(runs[r].events[i], runs[r].drainTimeouts);
            std::printf("%s\n", i + 1 == runs[r].events.size() ? "" : ",");
        }
        std::printf("    ]}%s\n", r + 1 == runs.size() ? "" : ",");
    }
    std::printf("  ],\n");
    std::printf("  \"checks\": {\"passed\": %d, \"failed\": %d}\n}\n",
                checksPassed, checksFailed);
    return checksFailed == 0 ? 0 : 1;
}

} // namespace te
