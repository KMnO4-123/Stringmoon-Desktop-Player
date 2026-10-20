// dsp.cpp -- 10-band RBJ peaking EQ, ReplayGain, limiter, hard clip.
//
// Parameter values come from SPEC 3.4 (line 210) and the ReplayGain formulas
// from the reference implementation the owner supplied (QueMusic AudioDsp,
// Apache-2.0). The two pitfalls that reference documents are handled
// deliberately here and are called out where they matter:
//
//   * its bypass ALSO skips the hard clip, so switching DSP off lets samples
//     above 1.0 reach the device; the safety clamp here is outside the bypass;
//   * limiter off does NOT mean unclipped; it means no gain envelope, while the
//     hard clip still runs.

#include "dsp.hpp"

#include <string>

#include <algorithm>

namespace te {

namespace {

// SPEC 3.4: +/-12 dB in 0.5 dB steps, Q adjustable over 0.5..4.
constexpr float kMaxGainDb = 12.0f;
constexpr float kMinQ      = 0.5f;
constexpr float kMaxQ      = 4.0f;

} // namespace

// Declared in dsp.hpp: shared with the offline tests so they assert against the
// shipped arithmetic rather than a re-implementation of it.
float clampf(float v, float lo, float hi) noexcept {
    // NaN has to be handled EXPLICITLY, because the comparison form below lets it
    // through: `v < lo` and `v > hi` are both false for NaN, so `v` is returned
    // unchanged. That is not a cosmetic edge case here -- every clamp in this file
    // is a safety clamp, and "the safety clamp does not clamp" is the kind of
    // claim this project treats as a defect rather than a detail.
    //
    // Measured 2026-10-16: one NaN entering a biquad poisons z1/z2 (DF2T carries
    // state), so EVERY following sample is NaN, and the clamp did not clear it.
    // At the device that becomes full-scale garbage until the next seek or track
    // change resets the filter -- i.e. sustained noise, not a click.
    //
    // Zero (not `lo`) is returned for NaN: silence is the only value that cannot
    // be heard as a defect.
    if (!(v == v)) return 0.0f;          // NaN: silence is the only safe value
    return v < lo ? lo : (v > hi ? hi : v);
}

void makePeakingBiquad(double frequency, double sampleRate, double q, double gainDb,
                       Biquad& out) noexcept {
    // RBJ Audio EQ Cookbook, peaking EQ. Guarded against the degenerate inputs
    // because a caller can reach this with an unfinished device format.
    if (sampleRate <= 0.0) sampleRate = 48000.0;
    if (frequency <= 0.0 || frequency >= sampleRate * 0.5) {
        // Above Nyquist the section cannot exist; pass through rather than
        // aliasing a filter that would misbehave.
        out.b0 = 1.0f; out.b1 = 0.0f; out.b2 = 0.0f; out.a1 = 0.0f; out.a2 = 0.0f;
        return;
    }
    if (q <= 0.0) q = 1.41;

    const double A     = std::pow(10.0, gainDb / 40.0);
    const double w0    = 2.0 * 3.14159265358979323846 * frequency / sampleRate;
    const double cosw0 = std::cos(w0);
    const double alpha = std::sin(w0) / (2.0 * q);

    const double b0 = 1.0 + alpha * A;
    const double b1 = -2.0 * cosw0;
    const double b2 = 1.0 - alpha * A;
    const double a0 = 1.0 + alpha / A;
    const double a1 = -2.0 * cosw0;
    const double a2 = 1.0 - alpha / A;

    out.b0 = static_cast<float>(b0 / a0);
    out.b1 = static_cast<float>(b1 / a0);
    out.b2 = static_cast<float>(b2 / a0);
    out.a1 = static_cast<float>(a1 / a0);
    out.a2 = static_cast<float>(a2 / a0);
}

// RBJ Audio EQ Cookbook low shelf (Q form, not slope form -- AutoEQ/Equalizer
// APO presets carry a Q for shelves, and the Q form reproduces it directly).
void makeLowShelfBiquad(double frequency, double sampleRate, double q, double gainDb,
                        Biquad& out) noexcept {
    if (sampleRate <= 0.0) sampleRate = 48000.0;
    if (frequency <= 0.0 || frequency >= sampleRate * 0.5 || q <= 0.0) {
        out.b0 = 1.0f; out.b1 = 0.0f; out.b2 = 0.0f; out.a1 = 0.0f; out.a2 = 0.0f;
        return;
    }
    const double A     = std::pow(10.0, gainDb / 40.0);
    const double w0    = 2.0 * 3.14159265358979323846 * frequency / sampleRate;
    const double cosw0 = std::cos(w0);
    const double sinw0 = std::sin(w0);
    const double alpha = sinw0 / (2.0 * q);
    const double sqrtA = std::sqrt(A);
    const double twoSqrtAAlpha = 2.0 * sqrtA * alpha;

    const double b0 = A * ((A + 1.0) - (A - 1.0) * cosw0 + twoSqrtAAlpha);
    const double b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosw0);
    const double b2 = A * ((A + 1.0) - (A - 1.0) * cosw0 - twoSqrtAAlpha);
    const double a0 = (A + 1.0) + (A - 1.0) * cosw0 + twoSqrtAAlpha;
    const double a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosw0);
    const double a2 = (A + 1.0) + (A - 1.0) * cosw0 - twoSqrtAAlpha;

    out.b0 = static_cast<float>(b0 / a0);
    out.b1 = static_cast<float>(b1 / a0);
    out.b2 = static_cast<float>(b2 / a0);
    out.a1 = static_cast<float>(a1 / a0);
    out.a2 = static_cast<float>(a2 / a0);
}

void makeHighShelfBiquad(double frequency, double sampleRate, double q, double gainDb,
                         Biquad& out) noexcept {
    if (sampleRate <= 0.0) sampleRate = 48000.0;
    if (frequency <= 0.0 || frequency >= sampleRate * 0.5 || q <= 0.0) {
        out.b0 = 1.0f; out.b1 = 0.0f; out.b2 = 0.0f; out.a1 = 0.0f; out.a2 = 0.0f;
        return;
    }
    const double A     = std::pow(10.0, gainDb / 40.0);
    const double w0    = 2.0 * 3.14159265358979323846 * frequency / sampleRate;
    const double cosw0 = std::cos(w0);
    const double sinw0 = std::sin(w0);
    const double alpha = sinw0 / (2.0 * q);
    const double sqrtA = std::sqrt(A);
    const double twoSqrtAAlpha = 2.0 * sqrtA * alpha;

    const double b0 = A * ((A + 1.0) + (A - 1.0) * cosw0 + twoSqrtAAlpha);
    const double b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosw0);
    const double b2 = A * ((A + 1.0) + (A - 1.0) * cosw0 - twoSqrtAAlpha);
    const double a0 = (A + 1.0) - (A - 1.0) * cosw0 + twoSqrtAAlpha;
    const double a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cosw0);
    const double a2 = (A + 1.0) - (A - 1.0) * cosw0 - twoSqrtAAlpha;

    out.b0 = static_cast<float>(b0 / a0);
    out.b1 = static_cast<float>(b1 / a0);
    out.b2 = static_cast<float>(b2 / a0);
    out.a1 = static_cast<float>(a1 / a0);
    out.a2 = static_cast<float>(a2 / a0);
}

// CR-019: one entry point for the render thread and the offline response test,
// so the two can never disagree about what a band means.
void makeEqBiquad(EqBandType type, double frequency, double sampleRate, double q, double gainDb,
                  Biquad& out) noexcept {
    switch (type) {
        case EqBandType::LowShelf:  makeLowShelfBiquad(frequency, sampleRate, q, gainDb, out); break;
        case EqBandType::HighShelf: makeHighShelfBiquad(frequency, sampleRate, q, gainDb, out); break;
        case EqBandType::Peaking:
        default:                    makePeakingBiquad(frequency, sampleRate, q, gainDb, out); break;
    }
}

DspChain::~DspChain() {
    delete[] dry_;
    dry_ = nullptr;
}

void DspChain::prepare(int channels, int maxFrames, int sampleRate) {
    // A bank loaded while stopped must survive the device being opened: prepare()
    // rebuilds the FFT plans, so re-adopt the pointer the render thread already had.
    const IrBank* keepIr = irBank_;
    std::string irError;
    ir_.prepare(sampleRate, irError);   // failure leaves forward_ null; process() then no-ops
    if (keepIr != nullptr) ir_.adopt(keepIr);

    channels_   = std::max(1, std::min(channels, kMaxChannels));
    maxFrames_  = std::max(1, maxFrames);
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000;

    // SPEC 3.4: approximately 20 ms of per-sample interpolation for the EQ
    // coefficients, 30 ms crossfade on bypass, 30 ms for a ReplayGain change.
    smoothSamples_   = std::max(1, static_cast<int>(0.020 * sampleRate_));
    bypassSamples_   = std::max(1, static_cast<int>(0.030 * sampleRate_));
    gainFadeSamples_ = std::max(1, static_cast<int>(0.030 * sampleRate_));

    // The only allocation in this file, and it happens here, on the control
    // thread, before the render thread exists. The audio path below never
    // allocates -- which is what makes it usable from an RT callback.
    if (dryFrames_ < maxFrames_ || dry_ == nullptr) {
        delete[] dry_;
        dry_ = new float[static_cast<std::size_t>(kMaxChannels) *
                       static_cast<std::size_t>(maxFrames_)];
        dryFrames_ = maxFrames_;
    }

    // CR-031：lookahead 的延迟线与单调队列，按最大 20 ms + 1 帧预分配。
    // RT 路径零分配是硬约束，所以这里一次给足；实际窗口按参数截取。
    {
        const std::size_t maxLookahead =
            static_cast<std::size_t>(static_cast<double>(sampleRate_) * 0.020) + 2;
        for (int ch = 0; ch < 2; ++ch) lookaheadDelay_[ch].assign(maxLookahead, 0.0f);
        lookaheadPeak_.assign(maxLookahead, 0.0f);
        lookaheadDeque_.assign(maxLookahead, 0);
        lookaheadWrite_ = 0;
        lookaheadHead_ = lookaheadTail_ = 0;
        lookaheadIndex_ = 0;
        lookaheadFrames_ = 0;
        limiterLookaheadGain_ = 1.0f;
    }

    // CR-026：每声道延迟线，按最大 10 ms 预分配（RT 路径不再分配）。
    // 额外 +2 帧让"读比写落后 frames"在 frames == 最大值时也安全。
    {
        const std::size_t delayFrames =
            static_cast<std::size_t>(static_cast<double>(sampleRate_) * 0.010) + 2;
        for (int ch = 0; ch < 2; ++ch) channelDelay_[ch].assign(delayFrames, 0.0f);
        delayWrite_ = 0;
    }

    // CR-029：spatial 的所有缓冲在这里分配（RT 路径零分配）。
    {
        std::string spatialError;
        spatialA_.prepare(sampleRate_, spatialError);
        spatialB_.prepare(sampleRate_, spatialError);
        const std::size_t framesCap = static_cast<std::size_t>(maxFrames_);
        for (int ch = 0; ch < 2; ++ch) {
            spatialInA_[ch].assign(framesCap, 0.0f);
            spatialInB_[ch].assign(framesCap, 0.0f);
            spatialMix_[ch].assign(framesCap, 0.0f);
            // 干声延迟线容量必须 > latency + 一块帧数：写指针在读指针之后，
            // 若容量恰好等于 latency，读写索引会重合（静音/错位）。
            spatialDry_[ch].assign(FirConvolver::kPartition + framesCap + 2, 0.0f);
            const std::size_t delayCap = static_cast<std::size_t>(
                static_cast<double>(sampleRate_) * 0.001) + 2;   // 1ms 上限
            spatialDelay_[ch].assign(delayCap, 0.0f);
        }
        spatialDelayWrite_ = 0;
        spatialDryWrite_ = 0;
        spatialLp_[0] = spatialLp_[1] = 0.0f;
        spatialBankA_ = nullptr;
        spatialBankB_ = nullptr;
        pendingSpatialA_.store(nullptr, std::memory_order_release);
        pendingSpatialB_.store(nullptr, std::memory_order_release);
    }

    reset();
    currentValid_ = false;
    gainCurrent_ = 1.0f;
    gainTarget_  = 1.0f;
    wetMix_ = 0.0f;
    wetTarget_ = 0.0f;
    gainRamp_ = wetRamp_ = 0;
    gainDelta_ = wetDelta_ = 0.0f;
    for (int b = 0; b < kEqBandCount; ++b) {
        // Start from a valid identity filter, including on output restarts.
        // Interpolating from zero coefficients is not an identity transition.
        curB0_[b] = 1.0f;
        curB1_[b] = curB2_[b] = curA1_[b] = curA2_[b] = 0.0f;
        bandTgt_[b][0] = 1.0f;
        for (int k = 1; k < 5; ++k) bandTgt_[b][k] = 0.0f;
        for (int k = 0; k < 5; ++k) bandDelta_[b][k] = 0.0f;
        bandRamp_[b] = 0;
        bandActive_[b] = false;
    }
}

void DspChain::reset() noexcept {
    for (int ch = 0; ch < kMaxChannels; ++ch) {
        for (int b = 0; b < kEqBandCount; ++b) bands_[ch][b].reset();
    }
    limiterPeak_ = 0.0f;
    // CR-031：lookahead 的延迟线/队列/增益也是"上一个位置"的状态，seek 后必须清。
    for (int ch = 0; ch < 2; ++ch) {
        std::fill(lookaheadDelay_[ch].begin(), lookaheadDelay_[ch].end(), 0.0f);
    }
    lookaheadWrite_ = 0;
    lookaheadHead_ = lookaheadTail_ = 0;
    lookaheadIndex_ = 0;
    limiterLookaheadGain_ = 1.0f;
    gainReductionDb_.store(0.0f, std::memory_order_relaxed);
    crossfeedLow_[0] = crossfeedLow_[1] = 0.0f;
    // CR-026：分频滤波状态与延迟线也必须清零。否则 seek/换曲后的第一段会带上
    // 上一位置的滤波器余振和被延迟的旧样本（会是真的可听出来的错位声）。
    for (int ch = 0; ch < kMaxChannels; ++ch) {
        bandLow_[ch].reset();
        bandMidHp_[ch].reset();
        bandMidLp_[ch].reset();
        bandHigh_[ch].reset();
    }
    for (int ch = 0; ch < 2; ++ch) {
        std::fill(channelDelay_[ch].begin(), channelDelay_[ch].end(), 0.0f);
    }
    delayWrite_ = 0;
    // CR-029：spatial 的历史（卷积 tail、延迟线、低通状态）也属于"上一个位置"，
    // seek/换曲后必须清掉，否则会以 1024 帧延迟的方式把旧内容拖到新位置（可闻）。
    spatialA_.reset();
    spatialB_.reset();
    for (int ch = 0; ch < 2; ++ch) {
        std::fill(spatialDry_[ch].begin(), spatialDry_[ch].end(), 0.0f);
        std::fill(spatialDelay_[ch].begin(), spatialDelay_[ch].end(), 0.0f);
    }
    spatialDryWrite_ = 0;
    spatialDelayWrite_ = 0;
    spatialLp_[0] = spatialLp_[1] = 0.0f;
    // The new position has no relationship to the previous one's remaining
    // tail; carrying it over would smear the first P frames after a seek.
    ir_.reset();
}

void DspChain::adoptParams() noexcept {
    if (!currentValid_) {
        // First block after prepare(): adopt one complete snapshot. process()
        // starts the configured smoothing ramps from the identity state.
        DspParams p;
        if (params_.read(p)) {
            current_ = p;
            currentValid_ = true;
        }
    } else {
        DspParams p;
        if (params_.read(p)) current_ = p;
    }
}

float computeStaticGainDb(const DspParams& params) noexcept {
    // SPEC 3.4 / reference formulas:
    //   outputGainDb = preampDb + replayGainDb - headroom
    //   headroom     = max(0, highest band gain) when auto headroom is on
    //
    // The reference computes the headroom from ALL bands without asking which
    // are enabled; that is correct here too, because a band at 0 dB contributes
    // nothing to the maximum, so "all bands" and "only boosted bands" agree.
    float rg = 0.0f;
    if (params.rgMode > 0) {
        const bool album = (params.rgMode == 2);
        rg = (album ? params.rgAlbumGainDb : params.rgTrackGainDb) + params.rgPreampDb;
        if (params.preventClip) {
            const float peak = album ? params.rgAlbumPeak : params.rgTrackPeak;
            if (peak > 0.0f) {
                // Cap the boost so the known peak lands at 0 dBFS. Setting it to
                // -0.1 dBFS leaves the tiny margin SPEC 3.4 asks for.
                const float ceiling = static_cast<float>(-20.0 * std::log10(static_cast<double>(peak))) - 0.1f;
                // Preamp is another gain on the same samples. Limit their sum,
                // retaining EQ headroom below, rather than clamping ReplayGain
                // alone and then boosting the protected peak back above 0 dBFS.
                rg = std::min(rg, ceiling - params.preampDb);
            }
        }
    }

    float headroom = 0.0f;
    if (params.autoHeadroom && params.eqEnabled) {
        for (int b = 0; b < kEqBandCount; ++b) headroom = std::max(headroom, params.eqGainDb[b]);
        headroom = std::max(0.0f, headroom);
    }

    return params.preampDb + rg - headroom;
}

bool channelToolsNeutral(const DspParams& params) noexcept {
    // Exact comparison on purpose: the defaults ARE the identity values, so any
    // deviation is a deliberate user action and must switch the path on.
    if (params.balance != 0.0f)      return false;
    if (params.mono)                 return false;
    if (params.monoMode != 0)        return false;
    if (params.swapChannels)         return false;
    if (params.channelGainDb[0] != 0.0f) return false;
    if (params.channelGainDb[1] != 0.0f) return false;
    // CR-026：三频段增益与每声道延迟，全 0 才是恒等。任一非 0 都必须进湿路径，
    // 否则设置会"看起来生效、实际没声音变化"。
    for (int band = 0; band < 3; ++band) {
        if (params.bandGainDb[band][0] != 0.0f) return false;
        if (params.bandGainDb[band][1] != 0.0f) return false;
    }
    if (params.channelDelayMs[0] != 0.0f || params.channelDelayMs[1] != 0.0f) return false;
    return true;
}

bool midSideNeutral(const DspParams& params) noexcept {
    return params.midGainDb == 0.0f && params.sideGainDb == 0.0f &&
           params.stereoWidth == 1.0f;
}

namespace {

inline void applyMidSide(float& l, float& r, float midGain, float sideGain,
                         float width) noexcept {
    const float mid  = (l + r) * 0.5f * midGain;
    const float side = (l - r) * 0.5f * sideGain * width;
    l = mid + side;
    r = mid - side;
}

inline void applyCrossfeed(float& l, float& r, float alpha, float feedMix,
                           float equalPowerGain, float lowState[2]) noexcept {
    // A one-pole low shelf keeps low-frequency crossfeed attenuated while the
    // high-frequency difference passes through. bs2b avoids FFT here because
    // recursive filters avoid the combing artefacts that block convolution can add.
    lowState[0] += alpha * (l - lowState[0]);
    lowState[1] += alpha * (r - lowState[1]);
    const float filteredR = r - 0.5f * lowState[1];
    const float filteredL = l - 0.5f * lowState[0];
    const float direct = 1.0f - feedMix;
    const float outL = (l * direct + filteredR * feedMix) * equalPowerGain;
    const float outR = (r * direct + filteredL * feedMix) * equalPowerGain;
    l = outL;
    r = outR;
}

// One frame of channel processing, planar and in place for a single sample of
// each channel. Written per-sample because balance is a static gain
// that must be applied consistently to both channels of the same frame.
inline void applyChannelTools(float& l, float& r, const DspParams& p) noexcept {
    // --- exchange first: it is a routing change, so everything after it should
    //     operate on the channels the listener will actually hear.
    if (p.swapChannels) { const float t = l; l = r; r = t; }

    // --- mono。旧 mono:true 等价于 monoMode:sum；CR-026 之后还可以选只用左/右
    //     声道（音箱只接了一边时的摆位工具）。fold 到平均值而不是丢弃一个声道，
    //     否则被 pan 到另一边的内容会静默消失。
    const int monoMode = p.monoMode != 0 ? p.monoMode : (p.mono ? 1 : 0);
    if (monoMode == 1)      { const float m = (l + r) * 0.5f; l = m; r = m; }
    else if (monoMode == 2) { r = l; }
    else if (monoMode == 3) { l = r; }

    // --- balance attenuates the opposite side. Boosting would clip.
    if (p.balance > 0.0f)      l *= (1.0f - p.balance);
    else if (p.balance < 0.0f) r *= (1.0f + p.balance);

    // --- per-channel trim.
    if (p.channelGainDb[0] != 0.0f) l *= std::pow(10.0f, p.channelGainDb[0] / 20.0f);
    if (p.channelGainDb[1] != 0.0f) r *= std::pow(10.0f, p.channelGainDb[1] / 20.0f);
}

// CR-026：RBJ Audio EQ Cookbook 低通/高通，归一化 a0 = 1。Q=0.5 得到二阶
// Linkwitz-Riley 段（LR2，12 dB/oct）；低/中/高三段都用同一组 Q，不做全通补偿，
// 因此分频点附近有 LR2 固有的相位旋转（幅度和为近似平坦，不是精确平坦）。
void makeLowpassBiquad(double frequency, double sampleRate, double q, Biquad& out) noexcept {
    const double pi = 3.14159265358979323846;
    const double w0 = 2.0 * pi * frequency / sampleRate;
    const double cosw = std::cos(w0);
    const double alpha = std::sin(w0) / (2.0 * q);
    const double a0 = 1.0 + alpha;
    out.b0 = static_cast<float>(((1.0 - cosw) * 0.5) / a0);
    out.b1 = static_cast<float>((1.0 - cosw) / a0);
    out.b2 = out.b0;
    out.a1 = static_cast<float>((-2.0 * cosw) / a0);
    out.a2 = static_cast<float>((1.0 - alpha) / a0);
}

void makeHighpassBiquad(double frequency, double sampleRate, double q, Biquad& out) noexcept {
    const double pi = 3.14159265358979323846;
    const double w0 = 2.0 * pi * frequency / sampleRate;
    const double cosw = std::cos(w0);
    const double alpha = std::sin(w0) / (2.0 * q);
    const double a0 = 1.0 + alpha;
    out.b0 = static_cast<float>(((1.0 + cosw) * 0.5) / a0);
    out.b1 = static_cast<float>(-(1.0 + cosw) / a0);
    out.b2 = out.b0;
    out.a1 = static_cast<float>((-2.0 * cosw) / a0);
    out.a2 = static_cast<float>((1.0 - alpha) / a0);
}

bool bandGainNeutral(const DspParams& params) noexcept {
    for (int band = 0; band < 3; ++band) {
        if (params.bandGainDb[band][0] != 0.0f) return false;
        if (params.bandGainDb[band][1] != 0.0f) return false;
    }
    return true;
}

bool channelDelayNeutral(const DspParams& params) noexcept {
    return params.channelDelayMs[0] == 0.0f && params.channelDelayMs[1] == 0.0f;
}

} // namespace

bool isPassthroughConfig(const DspParams& params) noexcept {
    if (params.eqEnabled) return false;
    if (computeStaticGainDb(params) != 0.0f) return false;
    // The channel tools change the samples, so they disqualify bit-perfect on
    // exactly the same grounds as the EQ. Omitting this would let a mono fold or
    // a width boost keep claiming the stored integers reached the device.
    if (!channelToolsNeutral(params)) return false;
    if (!midSideNeutral(params)) return false;
    if (params.crossfeedEnabled) return false;
    // CR-029：amount=0 时所有 spatial 模式都退化为恒等（= off），所以只有
    // "模式非 off 且 amount>0"才破坏 bit-perfect。
    if (params.spatialMode != SpatialMode::Off && params.spatialAmount > 0.0f) return false;
    return true;
}

// The live versions simply answer about the snapshot the render thread adopted.
float DspChain::staticGainDb() const noexcept { return computeStaticGainDb(current_); }
bool DspChain::isPassthrough() const noexcept {
    // CR-020: an enabled impulse response is a change to the samples, and the
    // bank pointer is deliberately not part of DspParams (it is megabytes of
    // spectra), so the decision is made here rather than in isPassthroughConfig.
    if (irBank_ != nullptr && current_.irEnabled) return false;
    return isPassthroughConfig(current_);
}
void DspChain::process(float* const* planes, int channels, int frames) noexcept {
    if (planes == nullptr || frames <= 0 || channels <= 0) return;
    if (frames > maxFrames_)   frames   = maxFrames_;
    if (channels > kMaxChannels) channels = kMaxChannels;

    adoptParams();

    // ---- impulse response adoption -------------------------------------
    // Swapped here, at a block boundary, never inside the sample loop: the
    // convolver's history belongs to one response, and changing it mid-block
    // would mix two rooms into one block.
    if (const IrBank* next = pendingIr_.exchange(nullptr, std::memory_order_acquire)) {
        irBank_ = next;
        ir_.adopt(next);
    }
    // CR-029：virtual 的两个 HRIR bank 也在块边界 adopt（卷积历史必须属于一个
    // 响应，块内切换会把两个"房间"混进同一块）。
    if (const IrBank* nextA = pendingSpatialA_.exchange(nullptr, std::memory_order_acquire)) {
        spatialBankA_ = nextA;
        spatialA_.adopt(nextA);
    }
    if (const IrBank* nextB = pendingSpatialB_.exchange(nullptr, std::memory_order_acquire)) {
        spatialBankB_ = nextB;
        spatialB_.adopt(nextB);
    }

    // Each sample-changing stage contributes independently to the wet mix.
    const bool needChannels = !channelToolsNeutral(current_);
    const bool needMidSide = !midSideNeutral(current_);
    const bool needCrossfeed = current_.crossfeedEnabled;
    const bool needIr = (irBank_ != nullptr) && current_.irEnabled;
    // CR-029：spatial。amount=0 等价 off（退化为恒等，避免"半开"状态悄悄改样本）。
    const bool spatialWanted = current_.spatialMode != SpatialMode::Off &&
                               current_.spatialAmount > 0.0f;
    const bool needSpatialVirtual = spatialWanted &&
        current_.spatialMode == SpatialMode::Virtual &&
        spatialBankA_ != nullptr && spatialBankB_ != nullptr;
    const bool needSpatialSample = spatialWanted && !needSpatialVirtual &&
                                   current_.spatialMode != SpatialMode::Virtual;
    // CR-026：三频段增益与每声道延迟。全 0 时整段旁路（channelToolsNeutral 已经把
    // "非 0"并入 needChannels），这里单独拆出来是为了在块边界算一次系数/帧数。
    const bool needBandGain = !bandGainNeutral(current_);
    const bool needDelay = !channelDelayNeutral(current_);
    if (!needCrossfeed) crossfeedLow_[0] = crossfeedLow_[1] = 0.0f;
    if (!needBandGain) {
        // 旁路期间清掉分频状态：重新启用时不能带着上一次的余振。
        for (int ch = 0; ch < kMaxChannels; ++ch) {
            bandLow_[ch].reset();
            bandMidHp_[ch].reset();
            bandMidLp_[ch].reset();
            bandHigh_[ch].reset();
        }
    }

    // ---- resolve the block's targets -------------------------------------
    // The wet path carries all stages that change samples. Omitting any one of
    // them here would make that control appear to work while bypassing its audio.
    const float targetGain = std::pow(10.0f, staticGainDb() / 20.0f);
    // The IR stage is FULL WET by construction (a correction response already
    // contains the direct path, so mixing dry back in combs). That means it has
    // to force the wet path on, otherwise the chain would bypass the convolver
    // and silently play the uncorrected signal.
    const bool spatialWet = needSpatialVirtual || needSpatialSample;
    const float targetMix = (current_.eqEnabled || targetGain != 1.0f || needChannels || needMidSide ||
                             needCrossfeed || needIr || needBandGain || needDelay || spatialWet)
        ? 1.0f : 0.0f;
    if (targetMix != wetTarget_) {
        wetTarget_ = targetMix;
        wetDelta_  = (wetTarget_ - wetMix_) / static_cast<float>(bypassSamples_);
        wetRamp_   = bypassSamples_;
    }

    if (targetGain != gainTarget_) {
        gainTarget_ = targetGain;
        gainDelta_  = (gainTarget_ - gainCurrent_) / static_cast<float>(gainFadeSamples_);
        gainRamp_   = gainFadeSamples_;
    }

    const bool fading  = (wetRamp_ > 0);
    const bool moving  = (gainRamp_ > 0);
    const bool needWet = (wetMix_ > 0.0f) || fading || moving || needChannels ||
                         needMidSide || needCrossfeed || needIr || needBandGain || needDelay ||
                         spatialWet;

    // ---- fully bypassed and settled --------------------------------------
    //
    // The safety clamp still runs. This is the fix for the reference
    // implementation's most dangerous bug: its bypass skips the hard clip along
    // with everything else, so with DSP off a sample above 1.0 reaches the
    // device. Clamping an in-range float returns it unchanged and bit-exact, so
    // this loop costs nothing in fidelity and keeps bit-perfect claims honest.
    if (!needWet) {
        // Fully neutral DSP still runs the always-on safety clamp.
        const bool tools = needChannels && channels == 2;
        for (int n = 0; n < frames; ++n) {
            if (tools) {
                float l = planes[0][n];
                float r = planes[1][n];
                applyChannelTools(l, r, current_);
                planes[0][n] = l;
                planes[1][n] = r;
            }
            for (int ch = 0; ch < channels; ++ch) {
                planes[ch][n] = clampf(planes[ch][n], -1.0f, 1.0f);
            }
        }
        gainReductionDb_.store(0.0f, std::memory_order_relaxed);
        return;
    }

    // ---- coefficient targets ---------------------------------------------
    for (int b = 0; b < kEqBandCount; ++b) {
        const float want = current_.eqEnabled
            ? clampf(current_.eqGainDb[b], -kMaxGainDb, kMaxGainDb) : 0.0f;
        // CR-019: freq / Q / type are per band now. A default DspParams still
        // resolves to the SPEC grid + global Q + peaking, so the coefficient
        // values here are unchanged for every pre-existing caller.
        const EqBandShape shape = resolveEqBand(current_, b);
        const double q = clampf(static_cast<float>(shape.q), kMinQ, kMaxQ);
        Biquad t;
        makeEqBiquad(shape.type, shape.freq, static_cast<double>(sampleRate_),
                     static_cast<double>(q), static_cast<double>(want), t);

        const float tgt[5] = { t.b0, t.b1, t.b2, t.a1, t.a2 };
        bool changed = false;
        for (int k = 0; k < 5; ++k) {
            if (bandTgt_[b][k] != tgt[k]) { changed = true; bandTgt_[b][k] = tgt[k]; }
        }
        if (changed) {
            const float cur[5] = { curB0_[b], curB1_[b], curB2_[b], curA1_[b], curA2_[b] };
            for (int k = 0; k < 5; ++k) {
                bandDelta_[b][k] = (bandTgt_[b][k] - cur[k]) / static_cast<float>(smoothSamples_);
            }
            bandRamp_[b] = smoothSamples_;
        }
        // A peaking section at 0 dB is mathematically a pass-through, so it is
        // skipped entirely -- but only once its ramp has finished, or a band
        // returning to 0 dB would be cut off mid-glide and click.
        bandActive_[b] = (want != 0.0f) || (bandRamp_[b] > 0);
    }

    // ---- limiter coefficients --------------------------------------------
    const bool limiterOn = current_.limiterEnabled;
    const float releaseMs = current_.limiterReleaseMs > 0.0f ? current_.limiterReleaseMs : 60.0f;
    const float rel = 1.0f - std::exp(-1.0f / (releaseMs * 0.001f * static_cast<float>(sampleRate_)));
    // CR-031：ceiling 从参数来。默认 -0.1 dBFS 与改动前那个写死的常数
    // 0.9885531f 是同一个值，所以不设置时行为逐样本不变。
    const float ceilingDb = clampf(current_.limiterCeilingDb, -12.0f, 0.0f);
    const float ceiling = std::pow(10.0f, ceilingDb / 20.0f);
    // CR-031：lookahead。0 = 既有逐样本算法（下面的 old path），> 0 = 进入
    // 预留的延迟线分支。帧数在这里算一次，块内不再做除法。
    const int lookaheadFrames = current_.limiterLookaheadMs <= 0.0f ? 0
        : static_cast<int>(current_.limiterLookaheadMs * 0.001f *
                           static_cast<float>(sampleRate_) + 0.5f);
    const bool limiterLookahead = limiterOn && lookaheadFrames > 0 && !lookaheadDelay_[0].empty();
    const float midGain = needMidSide
        ? std::pow(10.0f, current_.midGainDb / 20.0f) : 1.0f;
    const float sideGain = needMidSide
        ? std::pow(10.0f, current_.sideGainDb / 20.0f) : 1.0f;
    const float width = current_.stereoWidth;
    const float crossfeedAlpha = needCrossfeed
        ? 1.0f - std::exp(-2.0f * 3.14159265358979323846f * current_.crossfeedFcHz /
                          static_cast<float>(sampleRate_))
        : 0.0f;
    const float crossfeedAmount = needCrossfeed
        ? 0.5f * std::pow(10.0f, -current_.crossfeedFeedDb / 20.0f)
        : 0.0f;
    const float crossfeedDirect = 1.0f - crossfeedAmount;
    // Keep decorrelated stereo material near equal loudness after the direct
    // path is attenuated. The one-pole response has a closed-form white-noise
    // power, so this stays block-rate and allocation-free on the render thread.
    const float lowpassWhiteNoisePower = needCrossfeed
        ? crossfeedAlpha / (2.0f - crossfeedAlpha) : 0.0f;
    const float crossfeedFilterWhiteNoisePower = needCrossfeed
        ? 1.0f - crossfeedAlpha + 0.25f * lowpassWhiteNoisePower : 0.0f;
    const float crossfeedEqualPowerGain = needCrossfeed
        ? 1.0f / std::sqrt(crossfeedDirect * crossfeedDirect +
                           crossfeedAmount * crossfeedAmount * crossfeedFilterWhiteNoisePower)
        : 1.0f;

    // ---- CR-026: LR2 三频段 + 每声道延迟（块率准备）--------------------------
    // 系数与增益每块算一次；滤波状态跨块保留。分频点固定 200 Hz / 2 kHz（CR-026）。
    // 分频是二阶 LR2（Q=0.5，12 dB/oct）：幅度近似平坦，但**不做全通补偿**，
    // 所以分频点附近有相位旋转——这是 LR2 的固有特性，文档里如实写明。
    float bandGainLinear[3][2] = {{1.0f, 1.0f}, {1.0f, 1.0f}, {1.0f, 1.0f}};
    int delayFramesForChannel[2] = {0, 0};
    if (needBandGain) {
        Biquad low, midHp, midLp, high;
        makeLowpassBiquad(200.0, static_cast<double>(sampleRate_), 0.5, low);
        makeHighpassBiquad(200.0, static_cast<double>(sampleRate_), 0.5, midHp);
        makeLowpassBiquad(2000.0, static_cast<double>(sampleRate_), 0.5, midLp);
        makeHighpassBiquad(2000.0, static_cast<double>(sampleRate_), 0.5, high);
        for (int ch = 0; ch < channels; ++ch) {
            // 只更新系数，保留 z1/z2：调增益时不能把滤波器状态清零（会爆音）。
            bandLow_[ch].b0 = low.b0;     bandLow_[ch].b1 = low.b1;     bandLow_[ch].b2 = low.b2;
            bandLow_[ch].a1 = low.a1;     bandLow_[ch].a2 = low.a2;
            bandMidHp_[ch].b0 = midHp.b0; bandMidHp_[ch].b1 = midHp.b1; bandMidHp_[ch].b2 = midHp.b2;
            bandMidHp_[ch].a1 = midHp.a1; bandMidHp_[ch].a2 = midHp.a2;
            bandMidLp_[ch].b0 = midLp.b0; bandMidLp_[ch].b1 = midLp.b1; bandMidLp_[ch].b2 = midLp.b2;
            bandMidLp_[ch].a1 = midLp.a1; bandMidLp_[ch].a2 = midLp.a2;
            bandHigh_[ch].b0 = high.b0;   bandHigh_[ch].b1 = high.b1;   bandHigh_[ch].b2 = high.b2;
            bandHigh_[ch].a1 = high.a1;   bandHigh_[ch].a2 = high.a2;
        }
        for (int band = 0; band < 3; ++band) {
            for (int ch = 0; ch < 2; ++ch) {
                const float db = current_.bandGainDb[band][ch];
                bandGainLinear[band][ch] = (db == 0.0f) ? 1.0f : std::pow(10.0f, db / 20.0f);
            }
        }
    }
    if (needDelay) {
        const double framesPerMs = static_cast<double>(sampleRate_) / 1000.0;
        const int capacity = channelDelay_[0].empty() ? 0 : static_cast<int>(channelDelay_[0].size());
        for (int ch = 0; ch < 2; ++ch) {
            int frames = static_cast<int>(static_cast<double>(current_.channelDelayMs[ch]) * framesPerMs + 0.5);
            if (frames < 0) frames = 0;
            if (capacity > 1 && frames > capacity - 2) frames = capacity - 2;
            delayFramesForChannel[ch] = frames;
        }
    }

    // ---- CR-029 spatial 块级准备 -------------------------------------------
    // crossfeed / wide 是逐样本阶段；virtual 是块级 FFT 卷积（1024 帧延迟）。
    // 干声必须在 spatial 之前整块拷进 dry_：virtual 的湿声有 1024 帧延迟，
    // 湿/干混合若不按同一时间基准对齐会产生梳状滤波。
    const float spatialAmount = clampf(current_.spatialAmount, 0.0f, 1.0f);
    const float wideSideGain = 1.0f + spatialAmount;
    const float wideNorm = 1.0f / std::sqrt((1.0f + wideSideGain * wideSideGain) * 0.5f);
    int xfeedDelayFrames = static_cast<int>(current_.spatialDelayMs * sampleRate_ / 1000.0f + 0.5f);
    if (xfeedDelayFrames < 0) xfeedDelayFrames = 0;
    if (!spatialDelay_[0].empty()) {
        const int cap = static_cast<int>(spatialDelay_[0].size());
        if (xfeedDelayFrames > cap - 2) xfeedDelayFrames = cap - 2;
    }
    const float xfeedAlpha = 1.0f - std::exp(-2.0f * 3.14159265358979323846f * 700.0f /
                                            static_cast<float>(sampleRate_));
    if (needWet) {
        // 所有声道都要拷：非 stereo 链路（单声道/多声道）的末级混合同样读 dry_，
        // 之前只在 channels==2 时拷贝，会把上一块残留的干声混进来。
        for (int ch = 0; ch < channels; ++ch) {
            std::memcpy(dry_ + static_cast<std::size_t>(ch) * dryFrames_, planes[ch],
                        static_cast<std::size_t>(frames) * sizeof(float));
        }
    }
    if (needSpatialVirtual && channels == 2 && !spatialDry_[0].empty()) {
        // 输入 A = (L,R) 正常顺序；输入 B = (R,L) 交换 → 两个 2ch 卷积覆盖 2×2 矩阵。
        for (int ch = 0; ch < 2; ++ch) {
            std::memcpy(spatialInA_[ch].data(), planes[ch],
                        static_cast<std::size_t>(frames) * sizeof(float));
            std::memcpy(spatialInB_[ch].data(), planes[1 - ch],
                        static_cast<std::size_t>(frames) * sizeof(float));
        }
        float* pa[2] = {spatialInA_[0].data(), spatialInA_[1].data()};
        float* pb[2] = {spatialInB_[0].data(), spatialInB_[1].data()};
        spatialA_.process(pa, 2, frames);
        spatialB_.process(pb, 2, frames);
        const std::size_t dryCap = spatialDry_[0].size();
        const std::size_t latency = static_cast<std::size_t>(FirConvolver::kPartition);
        if (latency < dryCap && spatialDryWrite_ < dryCap) {
            for (int n = 0; n < frames; ++n) {
                // 先取原始输入（下一步会覆盖 planes），再读延迟 latency 帧的干声。
                const float inL = planes[0][n];
                const float inR = planes[1][n];
                const std::size_t read = (spatialDryWrite_ + dryCap - latency) % dryCap;
                const float wetL = spatialInA_[0][static_cast<std::size_t>(n)] +
                                   spatialInB_[0][static_cast<std::size_t>(n)];
                const float wetR = spatialInA_[1][static_cast<std::size_t>(n)] +
                                   spatialInB_[1][static_cast<std::size_t>(n)];
                planes[0][n] = spatialDry_[0][read] * (1.0f - spatialAmount) + wetL * spatialAmount;
                planes[1][n] = spatialDry_[1][read] * (1.0f - spatialAmount) + wetR * spatialAmount;
                // 末级 wetMix_ 混合用的是 dry_[n]（同一 n）。virtual 的湿声延迟了
                // 1024 帧，如果把未延迟的干声留在这里，横向渐变期间会把冲激提前
                // 泄漏出来（前回声）。把对齐后的干声写回 dry_，两级混合才对得上。
                dry_[static_cast<std::size_t>(0) * dryFrames_ + n] = spatialDry_[0][read];
                dry_[static_cast<std::size_t>(1) * dryFrames_ + n] = spatialDry_[1][read];
                spatialDry_[0][spatialDryWrite_] = inL;
                spatialDry_[1][spatialDryWrite_] = inR;
                spatialDryWrite_ = (spatialDryWrite_ + 1) % dryCap;
            }
        }
    }

    // ---- sample loop ------------------------------------------------------
    float blockGainReductionDb = 0.0f;
    for (int n = 0; n < frames; ++n) {
        // Coefficient ramps advance ONCE per frame, not once per channel: the
        // coefficients describe the curve, and every channel must be filtered
        // by the same trajectory or the stereo image would wobble.
        for (int b = 0; b < kEqBandCount; ++b) {
            if (bandRamp_[b] <= 0) continue;
            curB0_[b] += bandDelta_[b][0];
            curB1_[b] += bandDelta_[b][1];
            curB2_[b] += bandDelta_[b][2];
            curA1_[b] += bandDelta_[b][3];
            curA2_[b] += bandDelta_[b][4];
            if (--bandRamp_[b] == 0) {
                curB0_[b] = bandTgt_[b][0]; curB1_[b] = bandTgt_[b][1];
                curB2_[b] = bandTgt_[b][2]; curA1_[b] = bandTgt_[b][3];
                curA2_[b] = bandTgt_[b][4];
            }
        }
        if (gainRamp_ > 0) {
            gainCurrent_ += gainDelta_;
            if (--gainRamp_ == 0) gainCurrent_ = gainTarget_;
        }
        if (wetRamp_ > 0) {
            wetMix_ += wetDelta_;
            if (--wetRamp_ == 0) wetMix_ = wetTarget_;
        }

        // TWO PASSES OVER THE CHANNELS, and the split is forced by the stereo
        // stages: mid/side, crossfeed and channel tools need both samples from a
        // frame at once. Gain and the limiter
        // were per-channel and side-effect free, so the original single loop
        // worked for them -- adding the tools inside it would have meant
        // re-reading a channel the loop had already written.
        float frame[kMaxChannels] = { 0.0f };

        // Pass 1: everything that is per-channel and independent.
        for (int ch = 0; ch < channels; ++ch) {
            float* p = planes[ch];
            const float x = p[n];
            // dry_ 已在块头整块拷贝（CR-029：spatial 的湿声有延迟，干声必须按同一
            // 时间基准对齐后混合）。这里不再逐帧写，否则 spatial 之后会覆盖成湿声。

            float wet = x;
            if (wetMix_ > 0.0f) {
                for (int b = 0; b < kEqBandCount; ++b) {
                    if (!bandActive_[b]) continue;
                    Biquad& s = bands_[ch][b];
                    s.b0 = curB0_[b]; s.b1 = curB1_[b]; s.b2 = curB2_[b];
                    s.a1 = curA1_[b]; s.a2 = curA2_[b];
                    wet = s.process(wet);
                }
                wet *= gainCurrent_;
            }
            frame[ch] = wet;
        }

        // Stereo stages need the original pair and run once per frame.
        if ((needMidSide || needCrossfeed || needChannels || needSpatialSample) &&
            channels == 2 && wetMix_ > 0.0f) {
            float l = frame[0], r = frame[1];
            if (needMidSide) applyMidSide(l, r, midGain, sideGain, width);
            if (needCrossfeed) applyCrossfeed(l, r, crossfeedAlpha, crossfeedAmount,
                                              crossfeedEqualPowerGain, crossfeedLow_);
            if (needChannels) applyChannelTools(l, r, current_);
            // CR-029：crossfeed / wide（virtual 是块级卷积，不在这里）。
            if (needSpatialSample && current_.spatialMode == SpatialMode::Wide) {
                // M/S 扩展：side 增益 (1+amount)，整体按 uncorrelated 能量归一化，
                // 避免"变宽=变响"被误认为音质提升。
                const float mid = (l + r) * 0.5f;
                const float side = (l - r) * 0.5f;
                l = (mid + wideSideGain * side) * wideNorm;
                r = (mid - wideSideGain * side) * wideNorm;
            } else if (needSpatialSample && current_.spatialMode == SpatialMode::Crossfeed) {
                // 互补混合：outL = l + amount*(lp(R,延迟) - lp(L))，outR 对称。
                // 低频 (l+r) 精确守恒（两项相消），只有中高频产生串扰；延迟用
                // ≤1ms 的预分配环，低通是一阶（700 Hz）——耳机常用的温和串扰消除。
                spatialLp_[0] += xfeedAlpha * (l - spatialLp_[0]);
                spatialLp_[1] += xfeedAlpha * (r - spatialLp_[1]);
                const std::size_t cap = spatialDelay_[0].size();
                if (cap > 1) {
                    float delayedL = spatialLp_[0];
                    float delayedR = spatialLp_[1];
                    if (xfeedDelayFrames > 0) {
                        const std::size_t read = (spatialDelayWrite_ + cap -
                            static_cast<std::size_t>(xfeedDelayFrames)) % cap;
                        delayedL = spatialDelay_[0][read];
                        delayedR = spatialDelay_[1][read];
                    }
                    l = l + spatialAmount * (delayedR - spatialLp_[0]);
                    r = r + spatialAmount * (delayedL - spatialLp_[1]);
                    spatialDelay_[0][spatialDelayWrite_] = spatialLp_[0];
                    spatialDelay_[1][spatialDelayWrite_] = spatialLp_[1];
                    spatialDelayWrite_ = (spatialDelayWrite_ + 1) % cap;
                }
            }
            frame[0] = l; frame[1] = r;
        }

        // CR-026：三频段增益与每声道延迟。只作用在湿路径、限幅器之前——限幅器
        // 必须看到听众真正听到的信号，否则一个延迟/增益可能把信号推过满刻度。
        if (wetMix_ > 0.0f && channels == 2) {
            if (needBandGain) {
                for (int ch = 0; ch < 2; ++ch) {
                    const float x = frame[ch];
                    const float low = bandLow_[ch].process(x);
                    const float mid = bandMidLp_[ch].process(bandMidHp_[ch].process(x));
                    const float high = bandHigh_[ch].process(x);
                    frame[ch] = low * bandGainLinear[0][ch] +
                                mid * bandGainLinear[1][ch] +
                                high * bandGainLinear[2][ch];
                }
            }
            if (needDelay) {
                const std::size_t capacity = channelDelay_[0].size();
                if (capacity > 1 && delayWrite_ < capacity) {
                    for (int ch = 0; ch < 2; ++ch) {
                        channelDelay_[ch][delayWrite_] = frame[ch];
                        const int frames = delayFramesForChannel[ch];
                        if (frames > 0) {
                            const std::size_t read =
                                (delayWrite_ + capacity - static_cast<std::size_t>(frames)) % capacity;
                            frame[ch] = channelDelay_[ch][read];
                        }
                    }
                    delayWrite_ = (delayWrite_ + 1) % capacity;
                }
            }
        }

        float limiterGain = 1.0f;
        if (wetMix_ > 0.0f && limiterOn) {
            float peak = 0.0f;
            for (int ch = 0; ch < channels; ++ch) peak = std::max(peak, std::fabs(frame[ch]));
            if (limiterLookahead) {
                // ---- CR-031 lookahead 路径 ---------------------------------
                // 结构：把样本推进每声道延迟线，同时把链接峰值推进一个长度
                // L+1 的单调递减双端队列；队列头的"未来最大峰值"决定当前输出
                // 的增益。因为决策用的是未来 L 帧里的最大值，瞬态到达之前增益
                // 就已经压下去，不需要预报，也不会削顶。
                //
                // 释放仍用既有的一阶平滑（rel），但平滑作用在"目标增益"上而
                // 不是峰值上：这样攻击是即时的（未来峰值已知），释放是可闻的
                // 那一段，和原来听感一致。
                // 环形缓冲的容量是 prepare() 里预分配的最大值（≥ 任何合法窗口），
                // 窗口长度只决定回读距离与索引弹出边界 —— process() 里绝不 resize，
                // 那会在渲染线程上分配（SPEC 3.4 禁止）。
                const int ring = lookaheadFrames + 1;
                const int capacity = static_cast<int>(lookaheadDelay_[0].size());
                for (int ch = 0; ch < channels; ++ch) {
                    std::vector<float>& line = lookaheadDelay_[ch < 2 ? ch : 1];
                    if (line.empty()) continue;
                    const int write = lookaheadWrite_ % capacity;
                    line[static_cast<size_t>(write)] = frame[ch];
                }
                // 队列：写入当前峰值，弹出所有不大于它的旧索引（它们是死值）。
                // 队列与延迟线共用同一容量（prepare() 预分配），窗口长度只影响
                // 弹出边界；因此这里也按 capacity 取模，绝不 resize。
                const long long index = lookaheadIndex_;
                while (lookaheadHead_ != lookaheadTail_) {
                    const int back = (lookaheadTail_ - 1 + capacity) % capacity;
                    if (lookaheadPeak_[static_cast<size_t>(back)] <= peak) {
                        lookaheadTail_ = back;
                    } else {
                        break;
                    }
                }
                lookaheadPeak_[static_cast<size_t>(lookaheadTail_)] = peak;
                lookaheadDeque_[static_cast<size_t>(lookaheadTail_)] = static_cast<int>(index);
                lookaheadTail_ = (lookaheadTail_ + 1) % capacity;
                // 丢弃已经离开窗口的索引。
                while (lookaheadHead_ != lookaheadTail_) {
                    if (static_cast<long long>(lookaheadDeque_[static_cast<size_t>(lookaheadHead_)]) <=
                        index - static_cast<long long>(lookaheadFrames)) {
                        lookaheadHead_ = (lookaheadHead_ + 1) % capacity;
                    } else {
                        break;
                    }
                }
                const float futurePeak = (lookaheadHead_ != lookaheadTail_)
                    ? lookaheadPeak_[static_cast<size_t>(lookaheadHead_)] : peak;
                float targetGain = 1.0f;
                if (futurePeak > ceiling) targetGain = ceiling / futurePeak;
                // 攻击即时、释放平滑：目标比当前低就立刻跟上，比当前高才平滑。
                if (targetGain < limiterLookaheadGain_) {
                    limiterLookaheadGain_ = targetGain;
                } else {
                    limiterLookaheadGain_ += (targetGain - limiterLookaheadGain_) * rel;
                }
                limiterGain = limiterLookaheadGain_;
                // 延迟线读出 L 帧之前的样本 —— 这就是 lookahead 的可闻代价，
                // 也是 state.dsp.limiter.latencyFrames 必须如实上报的原因。
                const int read = (lookaheadWrite_ - lookaheadFrames + capacity * 2) % capacity;
                for (int ch = 0; ch < channels; ++ch) {
                    const std::vector<float>& line = lookaheadDelay_[ch < 2 ? ch : 1];
                    if (!line.empty()) frame[ch] = line[static_cast<size_t>(read)];
                }
                lookaheadWrite_ = (lookaheadWrite_ + 1) % capacity;
                ++lookaheadIndex_;
                (void)ring;
            } else {
                // ---- 既有算法（默认路径）-----------------------------------
                // Catch a sample peak immediately; a slow attack without lookahead
                // otherwise leaves the hard clip to catch the transient. Link all
                // channels so gain reduction cannot move the stereo image.
                limiterPeak_ = std::max(peak, limiterPeak_ + (peak - limiterPeak_) * rel);
                if (limiterPeak_ > ceiling) limiterGain = ceiling / limiterPeak_;
            }
        }
        if (limiterGain < 1.0f) {
            blockGainReductionDb = std::min(blockGainReductionDb,
                20.0f * std::log10(std::max(limiterGain, 1.0e-12f)));
        }

        for (int ch = 0; ch < channels; ++ch) {
            float wet = frame[ch] * limiterGain;

            if (wetMix_ < 1.0f) {
                const float d = dry_[static_cast<std::size_t>(ch) * dryFrames_ + n];
                wet = d + (wet - d) * wetMix_;
            }

            // Outside every conditional: see the bypass note above.
            planes[ch][n] = clampf(wet, -1.0f, 1.0f);
        }
    }
    // ---- FIR / room correction -------------------------------------------
    // Runs on the finished wet signal, fully wet. Placed at the end so the IR
    // corrects what the EQ produced, which is the order every room-correction
    // workflow assumes (measure, then correct the measured response).
    if (needIr && irBank_ != nullptr) {
        const float irGain = std::pow(10.0f, clampf(current_.irPreampDb, -24.0f, 24.0f) / 20.0f);
        if (irGain != 1.0f) {
            for (int ch = 0; ch < channels; ++ch) {
                float* plane = planes[ch];
                if (plane == nullptr) continue;
                for (int n = 0; n < frames; ++n) plane[n] *= irGain;
            }
        }
        ir_.process(planes, channels, frames);
    } else if (irBank_ != nullptr && ir_.active()) {
        // Disabled: clear the tail so re-enabling does not replay the last block.
        ir_.reset();
    }

    gainReductionDb_.store(blockGainReductionDb, std::memory_order_relaxed);
}

// ---------------------------------------------------------------------------
// Output quantisation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CR-025: dither / noise shaping coefficient tables
// ---------------------------------------------------------------------------
//
// 只抄常数，不引入依赖。来源：SoX v14.4.2 src/dither.c
//   lip44  —— 5 抽头 Lipshitz（Shape_lipshitz）
//   fwe44  —— 9 抽头 F-weighted（Shape_f_weighted）
//   shi44  —— 20 抽头 Shibata 44.1k（Shape_shibata）
// SoX 的误差反馈结构（src/dither.h 的 CONVOLVE）是：
//   u = x - Σ c[j] * e[n-1-j]        （本文件用 errorHistory[0] = 最近误差）
//   q = round(u + tpdf)
//   e[n] = q - u
// 我们用同一结构、同一符号；gain_cB 自动增益不搬（CR 要求“不改变输入样本增益”）。
namespace {

constexpr double kLip44[5] = {2.033, -2.165, 1.959, -1.590, 0.6149};
constexpr double kFwe44[9] = {2.412, -3.370, 3.937, -4.174, 3.353,
                              -2.205, 1.281, -0.569, 0.0847};
constexpr double kShi44[20] = {
    2.6773197650909423828,  -4.8308925628662109375,   6.570110321044921875,
    -7.4572014808654785156, 6.7263274192810058594,   -4.8481650352478027344,
    2.0412089824676513672,   0.7006359100341796875,  -2.9537565708160400391,
    4.0800385475158691406,  -4.1845216751098632812,   3.3311812877655029297,
    -2.1179926395416259766,  0.879302978515625,      -0.031759146600961685181,
    -0.42382788658142089844, 0.47882103919982910156, -0.35490813851356506348,
    0.17496839165687561035, -0.060908168554306030273};
// 一阶高通 TPDF：NTF = 1 - z^-1，等价于单抽头误差反馈 c = 1。
constexpr double kHighpassTpdf[1] = {1.0};

struct DitherTaps {
    const double* coefs;
    int           count;
};

DitherTaps ditherTaps(DitherMode mode) noexcept {
    switch (mode) {
        case DitherMode::Ns5:         return {kLip44, 5};
        case DitherMode::Ns9:         return {kFwe44, 9};
        case DitherMode::UltraShaped: return {kShi44, 20};
        case DitherMode::HighpassTpdf:return {kHighpassTpdf, 1};
        case DitherMode::Tpdf:
        case DitherMode::Off:
        default:                      return {nullptr, 0};
    }
}

} // namespace

void DitherState::reset() noexcept {
    for (double& value : errorHistory) value = 0.0;
}

const char* ditherModeName(DitherMode mode) noexcept {
    switch (mode) {
        case DitherMode::Off:          return "off";
        case DitherMode::Tpdf:         return "tpdf";
        case DitherMode::HighpassTpdf: return "highpass-tpdf";
        case DitherMode::Ns5:          return "ns-5";
        case DitherMode::Ns9:          return "ns-9";
        case DitherMode::UltraShaped:  return "ultra-shaped";
    }
    return "tpdf";
}

bool ditherModeFromName(const std::string& name, DitherMode& out) noexcept {
    if (name == "off")           { out = DitherMode::Off;          return true; }
    if (name == "tpdf")          { out = DitherMode::Tpdf;         return true; }
    if (name == "highpass-tpdf") { out = DitherMode::HighpassTpdf; return true; }
    if (name == "ns-5")          { out = DitherMode::Ns5;          return true; }
    if (name == "ns-9")          { out = DitherMode::Ns9;          return true; }
    if (name == "ultra-shaped")  { out = DitherMode::UltraShaped;  return true; }
    return false;
}

int effectiveOutputBits(bool isFloat, int containerBits) noexcept {
    // float32 carries a 24-bit mantissa, so it is lossless for any source of 24
    // bits or fewer. Treating it as 32 would claim a 16-bit stream needs dither
    // against a 24-bit source it reproduces exactly; treating it as 24 is both
    // true and the reason a 24-bit file stays bit-perfect through a float32
    // shared stream.
    if (isFloat) return 24;
    if (containerBits >= 32) return 32;
    if (containerBits >= 24) return 24;
    return 16;
}

bool ditherApplies(int containerBits, int sourceBits, bool isFloat) noexcept {
    // Strictly greater: equal depths lose nothing, so there is nothing to
    // decorrelate and dithering would ADD noise to a signal that was exact.
    return sourceBits > effectiveOutputBits(isFloat, containerBits);
}

// ---------------------------------------------------------------------------
// CR-025: quantisation with optional noise shaping
// ---------------------------------------------------------------------------
//
// 默认 Tpdf / Off 分支保持上一轮的 float 域算术，逐样本不变（这是默认等价红线）。
// 整形分支在"目标 LSB 域"里做误差反馈：先减历史误差，再加 ≤1 LSB 的 TPDF，
// round 后记录本次量化误差供下一个样本使用。它不改变输入样本的增益/直流，
// 只把量化噪声的能量从人耳敏感的中频推向高频。
int32_t quantizeSample(float sample, int containerBits, int sourceBits,
                       DitherState& state, DitherMode mode) noexcept {
    const int outBits = (containerBits >= 32) ? 32 : (containerBits >= 24 ? 24 : 16);
    const bool applies = (mode != DitherMode::Off) && (sourceBits > outBits);

    // LAST LINE OF DEFENCE, and it is not theoretical:
    // std::lrintf(NaN) is undefined behaviour. On x86/MSVC it typically yields
    // INT32_MIN, which for a 24-in-32 stream is the loudest possible negative
    // sample -- a full-scale click (or, persisted, a burst of noise). Inf is
    // defined by the compare-and-clamp below, but NaN is not, because every
    // comparison against NaN is false.
    //
    // The DSP safety clamp now clears NaN too (see clampf), so this is a second,
    // independent barrier at the boundary the hardware actually sees. Two guards
    // for one fault is deliberate: this is the single point where a float stops
    // being a float, and a non-finite value reaching it must never be silent.
    if (!(sample == sample)) sample = 0.0f;          // NaN -> digital silence

    // Full-scale value for the depth. Using 2^(n-1) rather than 2^(n-1)-1 keeps
    // the scale symmetric, which matters because the dither is expressed in LSB
    // and an asymmetric scale would shift the noise floor off centre.
    const float scale = static_cast<float>(1u << (outBits - 1));
    const DitherTaps taps = ditherTaps(mode);
    int32_t value = 0;

    if (!applies || taps.count == 0) {
        // 平直 TPDF 或 off：16/24-bit 维持与上一轮完全相同的浮点算术（默认等价红线）。
        //
        // 32-bit 容器必须单独走 double 域，原因是 float 表示不了正满刻度 2^31-1：
        // scale = 2^31 而 scale - 1.0f 会四舍五入回 2^31，于是钳位条件
        // scaled > limit 对满刻度永不成立；紧接着 std::lrintf(2^31) 超出 int32
        // 可表示范围（MSVC/x86 返回 INT32_MIN）。结果是正满刻度样本变成负满刻度
        // ——直接听就是一声爆音，而不是「32-bit 位完美」。这不是理论边界：32-bit 源
        // 里最大的整数 2147483647 解码成 float 恰好是 1.0f，任何一首 0 dBFS 的
        // 32-bit 素材都会走到这里。16/24-bit 的 scale-1 在 float 里是精确的，
        // 所以它们不进入本分支，行为逐样本不变。
        if (outBits == 32) {
            double wide = static_cast<double>(sample) * 2147483648.0;
            if (applies) wide += static_cast<double>(state.rng.next());
            if (wide > 2147483647.0) wide = 2147483647.0;
            if (wide < -2147483648.0) wide = -2147483648.0;
            value = static_cast<int32_t>(std::llrint(wide));
        } else {
            float scaled = sample * scale;
            if (applies) scaled += state.rng.next();
            const float limit = scale - 1.0f;
            if (scaled >  limit) scaled =  limit;
            if (scaled < -scale) scaled = -scale;
            value = static_cast<int32_t>(std::lrintf(scaled));
        }
        // 从整形档切回平直档：历史误差必须清零，否则下一轮整形会继承旧误差。
        // （只在确实有历史时写，避免每样本 20 次比较；通常进入本分支时历史已为 0。）
        if (state.errorHistory[0] != 0.0 || state.errorHistory[19] != 0.0) state.reset();
    } else {
        double shaped = static_cast<double>(sample) * static_cast<double>(scale);
        for (int i = 0; i < taps.count; ++i) shaped -= taps.coefs[i] * state.errorHistory[i];
        shaped += static_cast<double>(state.rng.next());
        const double limit = static_cast<double>(scale) - 1.0;
        const double floor = -static_cast<double>(scale);
        if (shaped > limit) shaped = limit;
        if (shaped < floor) shaped = floor;
        value = static_cast<int32_t>(std::lrint(shaped));
        // 误差 = 量化输出 - 整形后输入（SoX 同一定义），[0] 是最近一个误差。
        for (int i = taps.count - 1; i > 0; --i) state.errorHistory[i] = state.errorHistory[i - 1];
        state.errorHistory[0] = static_cast<double>(value) - shaped;
    }

    // WASAPI packs 24-bit samples left-justified in a 32-bit container.
    if (outBits == 24) value <<= 8;
    return value;
}

// 兼容旧签名（等价于 Tpdf 档）：既有 selftest / 离线调用继续用它。
// rng 是调用方的状态，必须拷进拷出，否则随机序列会在这里被重置。
int32_t quantizeSample(float sample, int containerBits, int sourceBits,
                       TpdfDither& rng) noexcept {
    DitherState state;
    state.rng = rng;
    const int32_t value = quantizeSample(sample, containerBits, sourceBits, state, DitherMode::Tpdf);
    rng = state.rng;
    return value;
}

// ---------------------------------------------------------------------------
// CR-029：解析 HRIR 与 virtual 模式的两个卷积 bank
// ---------------------------------------------------------------------------
//
// 模型（不是录制的 HRTF，而是可复算的双耳线索）：
//   ITD  —— Woodworth 球头模型 (a/c)(θ+sinθ)，a=8.75cm、c=343m/s；
//   ILD  —— 远耳按 4·sin|θ| dB 衰减，并做一阶低通（头影）；
//   耳廓 —— 近耳在约 0.22ms 处一个反相小反射（方向线索，简化固定）。
// 24 方位由 [−90°, +90°] 等分（probe-spatial 逐项打印），virtual 播放时取
// clamp(azimuth∓30°, ±90°) 作为左右虚拟声源方向。
namespace {
constexpr double kHrirPi = 3.14159265358979323846;
constexpr double kHeadRadiusM = 0.0875;
constexpr double kSpeedOfSound = 343.0;
} // namespace

AnalyticHrir makeAnalyticHrir(double azimuthDeg, int ear, int sampleRate) {
    AnalyticHrir out;
    if (sampleRate <= 0) sampleRate = 48000;
    if (ear != 0 && ear != 1) ear = 0;
    const double theta = std::clamp(azimuthDeg, -90.0, 90.0) * kHrirPi / 180.0;
    const double absTheta = std::fabs(theta);

    const bool rightEar = (ear == 1);
    const bool nearEar = (theta > 0.0) ? rightEar : (theta < 0.0 ? !rightEar : true);

    const double itdSec = (kHeadRadiusM / kSpeedOfSound) * (absTheta + std::sin(absTheta));
    const int itdSamples = static_cast<int>(itdSec * sampleRate + 0.5);
    const int taps = std::max(64, static_cast<int>(sampleRate * 0.005));   // 5ms
    out.taps.assign(static_cast<std::size_t>(taps), 0.0f);

    if (nearEar) {
        out.taps[0] = 1.0f;
        const int reflection = std::max(1, static_cast<int>(0.00022 * sampleRate));
        if (reflection < taps) out.taps[static_cast<std::size_t>(reflection)] -= 0.35f;
    } else {
        // 远耳：延迟到达 + 一阶低通（头影）。截止频率随偏角减小而升高。
        const double ildDb = 4.0 * std::sin(absTheta);
        const double gain = std::pow(10.0, -ildDb / 20.0);
        const double cutoff = 500.0 + 3500.0 * (1.0 - std::sin(absTheta));
        const double a = std::exp(-2.0 * kHrirPi * cutoff / static_cast<double>(sampleRate));
        double state = 0.0;
        for (int n = itdSamples; n < taps; ++n) {
            const double x = (n == itdSamples) ? 1.0 : 0.0;
            state = (1.0 - a) * x + a * state;
            out.taps[static_cast<std::size_t>(n)] = static_cast<float>(gain * state);
        }
    }

    // 近耳没有延迟；"ITD" 是两耳到达时间差，所以近耳一侧报 0，远耳报全量。
    out.itdSamples = nearEar ? 0 : itdSamples;
    out.ildDb = (theta > 0.0)
        ? 4.0 * std::sin(absTheta) * (ear == 0 ? 1.0 : 0.0)
        : (theta < 0.0 ? 4.0 * std::sin(absTheta) * (ear == 1 ? 1.0 : 0.0) : 0.0);
    out.energy = 0.0;
    double peak = 0.0;
    for (int n = 0; n < taps; ++n) {
        const double v = static_cast<double>(out.taps[static_cast<std::size_t>(n)]);
        out.energy += v * v;
        if (std::fabs(v) > peak) { peak = std::fabs(v); out.peakIndex = n; }
        if (std::fabs(v) > 1.0e-9) {
            if (out.firstNonzero < 0) out.firstNonzero = n;
            out.lastNonzero = n;
        }
    }
    return out;
}

double measuredIldDb(double azimuthDeg, int sampleRate) {
    const double theta = std::clamp(azimuthDeg, -90.0, 90.0);
    // 近耳是哪一只与 makeAnalyticHrir 保持一致：θ>0 右近，θ<0 左近，θ=0 对称。
    const int nearEar = (theta > 0.0) ? 1 : 0;
    const int farEar = 1 - nearEar;
    const AnalyticHrir nearH = makeAnalyticHrir(theta, nearEar, sampleRate);
    const AnalyticHrir farH = makeAnalyticHrir(theta, farEar, sampleRate);
    const double nearEnergy = std::max(nearH.energy, 1.0e-30);
    const double farEnergy = std::max(farH.energy, 1.0e-30);
    const double db = 10.0 * std::log10(nearEnergy / farEnergy);
    return db < 0.0 ? 0.0 : db;
}

bool buildSpatialBanks(float azimuth, int sampleRate,
                       IrBank*& bankA, IrBank*& bankB, std::string& error) {
    bankA = nullptr;
    bankB = nullptr;
    if (sampleRate <= 0) {
        error = "the output stream has no sample rate yet";
        return false;
    }
    const double thetaL = std::clamp(static_cast<double>(azimuth) - 30.0, -90.0, 90.0);
    const double thetaR = std::clamp(static_cast<double>(azimuth) + 30.0, -90.0, 90.0);
    const AnalyticHrir lL = makeAnalyticHrir(thetaL, 0, sampleRate);
    const AnalyticHrir rL = makeAnalyticHrir(thetaL, 1, sampleRate);
    const AnalyticHrir lR = makeAnalyticHrir(thetaR, 0, sampleRate);
    const AnalyticHrir rR = makeAnalyticHrir(thetaR, 1, sampleRate);
    std::size_t taps = 0;
    for (const AnalyticHrir* h : {&lL, &rL, &lR, &rR}) taps = std::max(taps, h->taps.size());
    auto pad = [taps](const AnalyticHrir& h) {
        std::vector<float> v(taps, 0.0f);
        std::copy(h.taps.begin(), h.taps.end(), v.begin());
        return v;
    };

    // bankA: [左耳(θL), 右耳(θR)]；bankB: [左耳(θR), 右耳(θL)]，配合输入交换完成
    // 2×2 HRIR 矩阵的四个卷积（两个 FirConvolver，每个 2 声道）。
    IrBank* a = IrBank::fromSamples({ pad(lL), pad(rR) }, sampleRate, error);
    if (a == nullptr) return false;
    IrBank* b = IrBank::fromSamples({ pad(lR), pad(rL) }, sampleRate, error);
    if (b == nullptr) {
        delete a;
        return false;
    }
    bankA = a;
    bankB = b;
    return true;
}

} // namespace te

