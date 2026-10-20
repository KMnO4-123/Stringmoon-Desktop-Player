// dsp.hpp -- the M2 quality chain: 10-band EQ, ReplayGain, limiter.
//
// SPEC 1.1 calls EQ + ReplayGain part of the one difference this project exists
// for, and SPEC 3.4 (line 210) fixes the parameters: 10 bands at
// 31.25/62.5/125/250/500/1k/2k/4k/8k/16k Hz, RBJ peaking, Q 1.41 (0.5..4),
// +/-12 dB in 0.5 dB steps, coefficients smoothed by per-sample interpolation
// over about 20 ms, and a 30 ms crossfade on bypass. SPEC 3.4 also says
// PRE-ALLOCATED AND ZERO-ALLOCATING, which is what shapes everything below.
//
// Two constraints from SPEC 3.2 decide the architecture:
//   * the render thread is RT and must not lock, allocate or log;
//   * the UI must be able to move an EQ slider while audio is running.
// Together those force a lock-free parameter hand-off (Seqlock, below) rather
// than a mutex: the control thread publishes a whole snapshot, the RT thread
// reads one at block boundaries and never blocks. Publishing a WHOLE snapshot
// also means a band change can never be observed half-applied.
//
// The processing order is deliberate and follows the reference implementation
// the owner supplied (QueMusic AudioDsp, Apache-2.0): EQ -> static gain ->
// limiter -> hard clip -> volume. Reordering these changes the result, so the
// order is asserted by the offline tests rather than left to taste.
#pragma once

#include <atomic>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "convolver.hpp"
#include <cstring>

namespace te {

inline constexpr int kEqBandCount = 10;

// One-octave centres from SPEC 3.4, not the rounded integers the reference
// implementation uses: 31.25 and 62.5 are exact octaves of 16k, 31/62 are not.
// Defined here (not in the .cpp) because the per-band shape struct below needs
// them as the zero-initialised default -- see resolveEqBand().
inline constexpr double kEqBandFrequency[kEqBandCount] = {
    31.25, 62.5, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0
};

// CR-019: each of the ten slots can be a full parametric band. 0 (Peaking) is
// the SPEC 3.4 default, and a zeroed DspParams must keep the old behaviour
// bit-exactly -- which is why "unset" is encoded as 0 rather than needing an
// initialiser that would duplicate the table above.
enum class EqBandType : int { Peaking = 0, LowShelf = 1, HighShelf = 2 };

struct EqBandShape {
    double freq;
    double q;
    EqBandType type;
};

// --- CR-029：解析 HRIR（生产模型，selftest/probe 与真实 virtual 共用同一实现）---
//
// 为什么是解析模型而不是内置 WAV 表：24 方位 × 2 耳 × 256 taps 的 HRIR 表要么
// 是第三方版权数据，要么是几百 KB 资源；用 ITD/ILD/耳廓低通的解析模型生成，
// 零资源、可复算、且能被 probe-spatial 逐项打印数学指标。它不是"录制的 HRTF"，
// 而是可测量、可解释的双耳线索模型。
struct AnalyticHrir {
    std::vector<float> taps;      // 时域冲激响应（长度固定）
    int    itdSamples   = 0;      // 相对于近耳的延迟（样本数；近耳为 0）
    // 设计参数，NOT 实测能量比：远耳按 4·sin|θ| dB 设计衰减（近耳 0）。解析模型的
    // 低通/反射会让实际能量比大得多（±90° 实测 ≈19.35 dB），要测实际值用
    // measuredIldDb()。把设计参数写成"能量比"会误导 verifier 和文档读者。
    double ildDb        = 0.0;
    double energy       = 0.0;    // sum(taps²)
    int    peakIndex    = 0;      // |taps| 最大处
    int    firstNonzero = -1;
    int    lastNonzero  = -1;
};

// azimuthDeg ∈ [-90, 90]（0=正前方，正=右）；ear 0=左 1=右。
AnalyticHrir makeAnalyticHrir(double azimuthDeg, int ear, int sampleRate);

// 实测 ILD（dB）：同一方位双耳 HRIR 的能量比 10·log10(E_near/E_far)，≥0。
// 与 AnalyticHrir::ildDb（设计参数 4·sin|θ|）不同；±90° 实测 ≈19.35 dB。
double measuredIldDb(double azimuthDeg, int sampleRate);

// 构建 virtual 模式的两个 2ch IrBank（调用方拥有所有权；失败返回 false）。
// bankA = [earL(θL), earR(θR)]（正常声道顺序）；bankB = [earL(θR), earR(θL)]
// （输入交换后的交叉项）。θL/θR = clamp(azimuth ∓ 30°)。
bool buildSpatialBanks(float azimuth, int sampleRate,
                       IrBank*& bankA, IrBank*& bankB, std::string& error);

// Resolves one slot. freq == 0 means "the SPEC grid frequency for this slot",
// q == 0 means "the global Q", anything outside the enum means Peaking.
inline EqBandShape resolveEqBand(const struct DspParams& params, int band) noexcept;

// ---------------------------------------------------------------------------
// Seqlock -- one writer (control thread), one reader (render thread)

// ---------------------------------------------------------------------------
// Seqlock -- one writer (control thread), one reader (render thread)
// ---------------------------------------------------------------------------
//
// A plain struct assignment across threads would tear: the reader could see a
// new band 3 with an old band 4. A seqlock makes the whole snapshot appear
// atomically without ever blocking the reader.
//
// Storage is byte-wise std::atomic rather than a plain struct. The usual
// seqlock trick of racing a plain memset against a plain read is what everyone
// writes and is formally a data race; byte-atomics make it a defined program
// and cost nothing here, because a snapshot is read once per audio block (a
// few hundred times a second) rather than per sample.
template <typename T>
class Seqlock {
public:
    void write(const T& value) noexcept {
        seq_.fetch_add(1, std::memory_order_relaxed);        // odd: write in progress
        std::atomic_thread_fence(std::memory_order_release);
        const uint8_t* src = reinterpret_cast<const uint8_t*>(&value);
        for (std::size_t i = 0; i < sizeof(T); ++i) {
            bytes_[i].store(src[i], std::memory_order_relaxed);
        }
        std::atomic_thread_fence(std::memory_order_release);
        seq_.fetch_add(1, std::memory_order_relaxed);        // even: stable
    }

    // Returns false when a write overlapped; the caller then keeps the snapshot
    // it already had. Bounded retries matter: this is called from the RT thread,
    // which must never spin waiting on a control thread the scheduler may have
    // preempted -- a torn read is harmless, a stalled audio callback is not.
    bool read(T& out) const noexcept {
        for (int attempt = 0; attempt < 8; ++attempt) {
            const uint32_t s1 = seq_.load(std::memory_order_acquire);
            if (s1 & 1u) continue;
            uint8_t tmp[sizeof(T)];
            for (std::size_t i = 0; i < sizeof(T); ++i) {
                tmp[i] = bytes_[i].load(std::memory_order_relaxed);
            }
            std::atomic_thread_fence(std::memory_order_acquire);
            const uint32_t s2 = seq_.load(std::memory_order_relaxed);
            if (s1 == s2) {
                std::memcpy(&out, tmp, sizeof(T));
                return true;
            }
        }
        return false;
    }

private:
    std::atomic<uint32_t> seq_{0};
    mutable std::atomic<uint8_t> bytes_[sizeof(T)]{};
};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

enum class ReplayGainMode : int { Off = 0, Track = 1, Album = 2 };

// CR-029：空间音频模式。Off 必须逐样本恒等（bit-perfect 语义不变）。
enum class SpatialMode : int { Off = 0, Crossfeed = 1, Wide = 2, Virtual = 3 };

inline const char* spatialModeName(SpatialMode mode) {
    switch (mode) {
        case SpatialMode::Crossfeed: return "crossfeed";
        case SpatialMode::Wide:      return "wide";
        case SpatialMode::Virtual:   return "virtual";
        case SpatialMode::Off:
        default:                     return "off";
    }
}

// 解析 set_spatial 的 mode 字符串；未知值返回 false（调用方报 ERR_STATE）。
inline bool spatialModeFromName(const std::string& name, SpatialMode& out) {
    if (name == "off")       { out = SpatialMode::Off;       return true; }
    if (name == "crossfeed") { out = SpatialMode::Crossfeed; return true; }
    if (name == "wide")      { out = SpatialMode::Wide;      return true; }
    if (name == "virtual")   { out = SpatialMode::Virtual;   return true; }
    return false;
}

struct DspParams {
    bool  eqEnabled     = false;
    float eqGainDb[kEqBandCount] = {};
    float eqQ           = 1.41f;      // SPEC 3.4 default; also the fallback for bands with q == 0
    // --- CR-019 per-band parametric shape ---------------------------------
    // All zero = "the SPEC 3.4 grid: kEqBandFrequency[b], Q from eqQ, peaking".
    // That is deliberate: a default-constructed DspParams must reproduce the
    // pre-CR-019 coefficients bit for bit, so the golden response test is
    // untouched by this feature existing.
    float  eqFreq[kEqBandCount]  = {};
    float  eqBandQ[kEqBandCount] = {};
    int8_t eqType[kEqBandCount]  = {};
    float preampDb      = 0.0f;
    bool  autoHeadroom  = true;

    // --- FIR / room correction --------------------------------------------
    // Only scalars go through the seqlock. The impulse response itself is a
    // pointer handed over on its own atomic (see DspChain::publishIr): a bank is
    // megabytes of spectra, and copying it into every parameter snapshot would
    // both be absurd and break the zero-allocation promise of the render thread.
    bool  irEnabled     = false;
    float irPreampDb    = 0.0f;

    int   rgMode        = 0;          // ReplayGainMode
    float rgTrackGainDb = 0.0f;
    float rgAlbumGainDb = 0.0f;
    float rgPreampDb    = 0.0f;
    float rgTrackPeak   = 0.0f;
    float rgAlbumPeak   = 0.0f;
    bool  preventClip   = true;

    // CR-031：限幅器可控。字段是**只增**的：limiterEnabled / limiterReleaseMs
    // 的名字与默认值一个都没改（app_selftest 的 8 处断言、旧客户端都在读它），
    // 新增的两个默认值恰好复现改动前的行为 —— ceiling 等于原来写死的常数，
    // lookahead = 0 走原来那条逐样本分支。
    bool  limiterEnabled  = true;
    float limiterReleaseMs = 60.0f;
    // 采样峰 ceiling（dBFS，-12..0）。默认 -0.1 与旧实现的 constexpr 常数
    // 0.9885531f 是同一个数（见 DspChain::process 里的默认值分支）。
    float limiterCeilingDb = -0.1f;
    // 前瞻时长（ms，0..20）。0 = 既有算法（逐样本一致，有 selftest 回归断言）；
    // >0 = 延迟线 + 滑动最大值，延迟 = ceil(ms·rate/1000) 帧并如实回读。
    float limiterLookaheadMs = 0.0f;

    // --- mid/side sound stage ---------------------------------------------
    // Identity defaults preserve the existing sample path exactly.
    float midGainDb   = 0.0f;
    float sideGainDb  = 0.0f;
    float stereoWidth = 1.0f;

    // --- Bauer-style crossfeed --------------------------------------------
    bool  crossfeedEnabled = false;
    int   crossfeedPreset  = 0;
    float crossfeedFcHz    = 700.0f;
    float crossfeedFeedDb  = 4.5f;  // attenuation expressed as a positive dB value

    // --- channel tools (stereo only) ---------------------------------------
    //
    // Applied AFTER the static gain and BEFORE the limiter, which is the order
    // the reference implementation uses -- and it matters: the limiter must see
    // what the listener hears, or a channel tool could push a signal past full
    // scale after the limiter had already declared it safe.
    //
    // EVERY DEFAULT HERE IS THE IDENTITY. That is what keeps bit-perfect
    // possible: the tools are skipped entirely when all are neutral, so a user
    // who never touches them keeps the untouched signal path.
    //
    // balance: -1.0 fully left .. +1.0 fully right, 0 = centre. It ATTENUATES
    //   the opposite channel rather than boosting one, so a balance move cannot
    //   push anything into clipping.
    float balance      = 0.0f;
    bool  mono         = false;
    bool  swapChannels = false;
    // Per-channel trim in dB, indexed by channel. Kept at two entries because
    // these are stereo tools; extra channels pass through untouched.
    float channelGainDb[2] = { 0.0f, 0.0f };

    // --- CR-026: channel tools extension -----------------------------------
    //
    // monoMode: 0 = off, 1 = sum (旧 mono:true 的等价物), 2 = 只用左声道, 3 = 只用右声道。
    // 旧 mono 布尔保留：两者同时存在时 monoMode 优先，setMono()/setMonoMode() 会保持
    // 两者语义一致，所以旧客户端只发 mono:true 仍然得到 sum。
    int   monoMode = 0;
    // 三频段 L/R 增益（dB）：low < 200 Hz、mid 200 Hz..2 kHz、high > 2 kHz，
    // LR2（Q=0.5，二阶 Linkwitz-Riley）分频；全部 0 时整段旁路（bit-perfect 不变）。
    // 范围 -6 .. +3 dB（CR-026），拒绝而非 clamp。
    float bandGainDb[3][2] = {};
    // 每声道延迟（ms，0..10，0 = 旁路）。用于音箱摆位对齐；它改变样本，非 0 时
    // isPassthroughConfig 必然为 false。延迟在湿路径末端、限幅器之前。
    float channelDelayMs[2] = { 0.0f, 0.0f };

    // --- CR-029: spatial audio -------------------------------------------------
    // Off（默认）= 整段旁路、逐样本恒等；crossfeed = 耳机串扰消除（互补混合 +
    // 0..1ms 对侧延迟 + 低通，低频和守恒）；wide = M/S 扩展（按 amount 归一化能量）；
    // virtual = 24 方位解析 HRIR 的双耳虚拟环绕（复用 partitioned FFT 卷积器）。
    // amount=0 时所有模式都退化为恒等（用户可无损关掉）。
    SpatialMode spatialMode = SpatialMode::Off;
    float spatialAmount  = 0.5f;    // 0..1
    float spatialAzimuth = 0.0f;    // -90..90（virtual 声像中心）
    float spatialDelayMs = 0.5f;    // 0..1（crossfeed 对侧延迟）
};

// Resolves one slot: freq 0 = the SPEC grid frequency, q 0 = the global Q, unknown type = peaking.
inline EqBandShape resolveEqBand(const DspParams& params, int band) noexcept {
    if (band < 0 || band >= kEqBandCount) return EqBandShape{ 1000.0, 1.41, EqBandType::Peaking };
    const double fallbackQ = static_cast<double>(params.eqQ) > 0.0 ? static_cast<double>(params.eqQ) : 1.41;
    const double freq = static_cast<double>(params.eqFreq[band]) > 0.0
        ? static_cast<double>(params.eqFreq[band]) : kEqBandFrequency[band];
    const double q = static_cast<double>(params.eqBandQ[band]) > 0.0
        ? static_cast<double>(params.eqBandQ[band]) : fallbackQ;
    const int raw = static_cast<int>(params.eqType[band]);
    const EqBandType type = raw == 1 ? EqBandType::LowShelf
                          : raw == 2 ? EqBandType::HighShelf : EqBandType::Peaking;
    return EqBandShape{ freq, q, type };
}


// A single biquad section, Direct Form II Transposed.
//
// DF2T rather than DF1: it needs two state words instead of four and has the
// better numerical behaviour for the small coefficient changes that smoothing
// produces every sample.
struct Biquad {
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
    float z1 = 0.0f, z2 = 0.0f;

    void reset() noexcept { z1 = z2 = 0.0f; }

    inline float process(float x) noexcept {
        const float y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

// The gain the chain will apply for a given configuration, in dB.
//
// A free function rather than a method because the SAME formula has to answer
// two different questions: what the render thread has adopted right now (asked
// of a live DspChain), and what a configuration WOULD apply (asked before any
// stream exists -- a UI configuring the EQ while playback is stopped). They must
// never be two copies of the arithmetic, or they will drift.
float computeStaticGainDb(const DspParams& params) noexcept;

// True when a configuration would leave the samples untouched, which is what
// bit-perfect eligibility is defined against. Note that a band set to exactly
// 0 dB and a gain that lands on exactly 1.0 both count as pass-through: the
// question is what the arithmetic does, not what the user typed.
bool isPassthroughConfig(const DspParams& params) noexcept;

// The safety clamp, shared by the render path and the offline tests.
//
// Exposed rather than kept file-local because it is a CONTRACT, not an
// implementation detail: it is the thing that keeps a non-finite or over-range
// sample away from the device. A test cannot assert "the clamp clamps" against a
// copy of the arithmetic, and the copy is what would drift.
//
// NaN is mapped to 0.0f. That is deliberate and was a real defect: the naive
// form (`v < lo ? lo : (v > hi ? hi : v)`) returns NaN unchanged, because both
// comparisons are false for it, and the biquad's DF2T state then keeps the
// stream NaN for as long as nothing resets the filter.
float clampf(float v, float lo, float hi) noexcept;

// True when no channel tool would change a sample. Separate from
// isPassthroughConfig because the UI and the bit-perfect decision need different
// granularity: one asks "is the whole chain inert", this asks "did the user
// touch the stereo controls".
bool channelToolsNeutral(const DspParams& params) noexcept;
bool midSideNeutral(const DspParams& params) noexcept;

// ---------------------------------------------------------------------------
// Output quantisation (SPEC 2.x line 203 / 536)
// ---------------------------------------------------------------------------
//
// SPEC: "when the output depth is below the source depth, TPDF dither; the
// bit-perfect path disables it". Both halves matter and they are the same
// switch: a bit-perfect stream is by definition one where no depth is lost, so
// the dither can never be active on it. That is not a coincidence to rely on
// silently -- quantizeSample() is the only place a sample becomes an integer,
// and it derives the decision from the depths, so the two cannot disagree.
//
// Why dither at all: rounding a 24-bit sample to 16 bits replaces the discarded
// low bits with a quantisation error that is a DETERMINISTIC function of the
// signal. That is not noise, it is distortion -- it correlates with the music
// and is audible at low levels as a gritty, granulated decay. Adding a small
// random offset before rounding turns that distortion into a constant, benign
// noise floor.
//
// TPDF (triangular) rather than RPDF (rectangular) because rectangular dither
// leaves the error VARIANCE modulated by the signal, which is audible as noise
// that breathes with the music. The triangular distribution is the sum of two
// independent rectangular ones and removes that modulation entirely.
class TpdfDither {
public:
    // Seeded per stream so the same audio quantises identically on a replay,
    // which is what makes the offline test deterministic.
    void seed(uint32_t s) noexcept {
        s1_ = (s == 0u) ? 0x9E3779B9u : s;
        s2_ = (s == 0u) ? 0x85EBCA6Bu : (s * 2654435761u) | 1u;
    }

    // Two independent uniform values in [0,1) summed and shifted, giving a
    // triangular distribution over (-1, 1) -- one LSB peak to peak, which is
    // the amount that fully decorrelates the quantisation error.
    inline float next() noexcept {
        s1_ ^= s1_ << 13; s1_ ^= s1_ >> 17; s1_ ^= s1_ << 5;
        s2_ ^= s2_ << 13; s2_ ^= s2_ >> 17; s2_ ^= s2_ << 5;
        const float a = static_cast<float>(s1_ >> 8) * (1.0f / 16777216.0f);
        const float b = static_cast<float>(s2_ >> 8) * (1.0f / 16777216.0f);
        return (a + b) - 1.0f;
    }

    // Testing hook: the 16- and 24-bit paths only ever call next().
    uint32_t state1() const noexcept { return s1_; }

private:
    uint32_t s1_ = 0x9E3779B9u;
    uint32_t s2_ = 0x85EBCA6Bu;
};

// ---------------------------------------------------------------------------
// CR-025: PCM dither / noise shaping modes（对标 ECHO NEXT 的 dither 档位）
// ---------------------------------------------------------------------------
//
// 默认 tpdf 走**原有的 float 域算术**，与上一轮逐样本一致；off 只是不加抖动，
// 安全钳位仍在。其余档位是**量化误差反馈**：只改变被丢弃低位产生的噪声形状，
// 不改变输入样本的增益与直流——量化前只减去历史误差、再加 ≤1 LSB 的 TPDF，
// 输出仍是 round(u)。
//
// 系数来源（只抄常数，不引入依赖）：
//   lip44 / fwe44 / shi44 取自 SoX v14.4.2 的 src/dither.c（LGPL-2.1+，自用项目），
//   分别是 5 抽头 Lipshitz、9 抽头 F-weighted、20 抽头 Shibata(44.1k) 表。
//   SoX 只在采样率与该表 ±5% 内时使用它；我们把同一组系数用于所有输出采样率
//   （引擎最常见 48k，与 44.1k 相差 8.8%），这是刻意的取舍并在报告里注明。
enum class DitherMode : int {
    Off = 0,          // 不加抖动：直接 round（安全钳位仍在）
    Tpdf = 1,         // 平直 TPDF（默认，与上一轮逐样本一致）
    HighpassTpdf = 2, // 一阶高通整形（NTF = 1 - z^-1），1 抽头
    Ns5 = 3,          // SoX lip44，5 抽头
    Ns9 = 4,          // SoX fwe44，9 抽头
    UltraShaped = 5,  // SoX shi44，20 抽头 Shibata
};

// 线上拼写（state.dither / set_dither 用），与枚举同处避免漂移。
const char* ditherModeName(DitherMode mode) noexcept;
bool ditherModeFromName(const std::string& name, DitherMode& out) noexcept;

// 每个输出声道一份：随机源 + 量化误差历史（目标 LSB 域，[0] = 最近一个误差）。
// 放 fixed 数组而不是 vector：量化在 RT 线程上，必须零分配。
struct DitherState {
    TpdfDither rng;
    double     errorHistory[20]{};
    void reset() noexcept;
};

// 整数量化的唯一入口（带整形模式）。mode == Tpdf / Off 时走原算术，
// 因此默认链路的输出逐样本不变；其它档位只在"确实要丢位宽"时生效。
int32_t quantizeSample(float sample, int containerBits, int sourceBits,
                       DitherState& state, DitherMode mode) noexcept;
// 兼容旧签名（等价于 Tpdf 档）：既有 selftest 与离线测试继续用它。
int32_t quantizeSample(float sample, int containerBits, int sourceBits,
                       TpdfDither& rng) noexcept;

// Effective bits a stream format can carry. float32 counts as 24, because its
// mantissa is 24 bits -- that is exactly why a 24-bit source through a float32
// stream is lossless and must NOT be dithered.
int effectiveOutputBits(bool isFloat, int containerBits) noexcept;

// The one place a float becomes integer PCM.
//
// Shared by the render loop and the offline tests on purpose: a test that
// re-implements this arithmetic proves only that the copy is self-consistent.
// sample is in [-1, 1]; the result is an integer in the target depth, already
// clamped and left-justified where the container is wider than the depth.
int32_t quantizeSample(float sample, int containerBits, int sourceBits,
                       TpdfDither& rng) noexcept;

// True when quantizeSample would apply dither for these depths. Exposed so the
// bit-perfect decision and the dither decision can be asserted against each
// other rather than argued about.
bool ditherApplies(int containerBits, int sourceBits, bool isFloat) noexcept;

// RBJ Audio EQ Cookbook peaking section, normalised to a0 = 1.
//
// The cookbook's peaking form is used unchanged: SPEC 3.4 names RBJ explicitly,
// and its gain at the centre frequency is exactly the requested dB, which is
// what makes the golden test's +/-0.1 dB tolerance meaningful.
void makePeakingBiquad(double frequency, double sampleRate, double q, double gainDb,
                       Biquad& out) noexcept;

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------
class DspChain {
public:
    // Fixed ceiling so the per-channel state arrays below are a compile-time
    // size: an RT callback cannot allocate, so this can never be dynamic.
    static constexpr int kMaxChannels = 8;
    DspChain() = default;
    // dry_ is a raw array so the audio path can index it without a bounds check;
    // that makes cleanup this class's job.
    ~DspChain();
    DspChain(const DspChain&) = delete;
    DspChain& operator=(const DspChain&) = delete;

    // Control thread. Allocates; never call while the render thread is running.
    void prepare(int channels, int maxFrames, int sampleRate);

    // Control thread: publish a new parameter snapshot.
    void publish(const DspParams& params) noexcept { params_.write(params); }

    // Control thread: hand over a loaded impulse response. The render thread
    // adopts it at the start of its next block, so the swap can never happen
    // mid-block. The caller KEEPS OWNERSHIP and must outlive the adoption.
    void publishIr(const IrBank* bank) noexcept { pendingIr_.store(bank, std::memory_order_release); }
    // CR-029：virtual 模式的两个卷积 bank（正常/交换输入）。所有权在 Player，
    // 调用方必须保证 bank 比 adopt 活得久（沿用 publishIr 的同一契约）。
    void publishSpatialBanks(const IrBank* bankA, const IrBank* bankB) noexcept {
        pendingSpatialA_.store(bankA, std::memory_order_release);
        pendingSpatialB_.store(bankB, std::memory_order_release);
    }
    bool spatialActive() const noexcept {
        return current_.spatialMode != SpatialMode::Off && current_.spatialAmount > 0.0f;
    }
    // 诊断用：RT 线程是否已经 adopt 到两个 HRIR bank（probe/verifier 用）。
    bool spatialBankReady() const noexcept {
        return spatialBankA_ != nullptr && spatialBankB_ != nullptr;
    }
    // 卷积器的固有延迟（帧）：virtual 模式下如实报告，避免"口型不同步"的误解。
    int spatialLatencyFrames() const noexcept { return FirConvolver::kPartition; }

    // Which bank the render thread has adopted. Read by the control thread for
    // state reporting; a stale read only mis-reports for one block.
    const IrBank* irBank() const noexcept { return irBank_; }
    int irLatencyFrames() const noexcept { return ir_.latencyFrames(); }

    // Control thread: the snapshot the RENDER thread has adopted. A publish()
    // that the audio thread has not reached yet is deliberately not reflected
    // here, so this is what should be reported in state events and what
    // isPassthrough() judges bit-perfect eligibility by.
    const DspParams& params() const noexcept { return current_; }

    // RT thread. Planar float32, in place. Zero allocation, no locks, no logging.
    void process(float* const* planes, int channels, int frames) noexcept;

    // RT thread, on stream start/seek: clear filter and limiter state so the new
    // position does not inherit the previous one's ringing.
    void reset() noexcept;

    // True when the chain would leave the samples untouched, which is what lets
    // the engine keep claiming bit-perfect. Recomputed per block.
    bool isPassthrough() const noexcept;

    // The scalar gain actually in force, for diagnostics and for state events.
    float staticGainDb() const noexcept;
    // Greatest linked limiter attenuation in the most recent audio block.
    float gainReductionDb() const noexcept { return gainReductionDb_.load(std::memory_order_relaxed); }

private:
    void adoptParams() noexcept;

    Seqlock<DspParams> params_{};
    DspParams current_{};
    bool      currentValid_ = false;

    int   channels_  = 0;
    int   maxFrames_ = 0;
    int   sampleRate_ = 48000;

    // State is PER CHANNEL. One Biquad per band shared across channels would run
    // both channels through a single delay line, which is mono filtering applied
    // twice, not a stereo EQ.
    // CR-026：LR2 三频段分频的滤波状态与每声道延迟线（RT 线程独占，
    // prepare()/reset() 里分配与清零；process() 零分配）。
    Biquad bandLow_[kMaxChannels];
    Biquad bandMidHp_[kMaxChannels];
    Biquad bandMidLp_[kMaxChannels];
    Biquad bandHigh_[kMaxChannels];
    std::vector<float> channelDelay_[2];
    size_t delayWrite_ = 0;

    FirConvolver ir_;
    std::atomic<const IrBank*> pendingIr_{nullptr};

    // --- CR-029 spatial 状态（RT 线程独占；prepare() 分配）------------------
    FirConvolver spatialA_;
    FirConvolver spatialB_;
    std::atomic<const IrBank*> pendingSpatialA_{nullptr};
    std::atomic<const IrBank*> pendingSpatialB_{nullptr};
    const IrBank* spatialBankA_ = nullptr;   // render thread adopted
    const IrBank* spatialBankB_ = nullptr;
    std::vector<float> spatialInA_[2];       // [ch][maxFrames]
    std::vector<float> spatialInB_[2];
    std::vector<float> spatialMix_[2];       // conv 输出合成
    std::vector<float> spatialDry_[2];       // 与卷积延迟对齐的干声延迟线
    std::vector<float> spatialDelay_[2];     // crossfeed 低通对侧延迟线（≤1ms）
    int  spatialDelayWrite_ = 0;
    int  spatialDryWrite_   = 0;             // virtual 干声延迟线写指针（对齐 1024 帧卷积延迟）
    float spatialLp_[2] = {0.0f, 0.0f};      // crossfeed 单极低通状态
    const IrBank* irBank_ = nullptr;   // render thread's adopted bank
    Biquad bands_[kMaxChannels][kEqBandCount];
    float  limiterPeak_ = 0.0f; // linked sample peak: instantaneous catch, smoothed release
    float  limiterLookaheadGain_ = 1.0f;  // CR-031 lookahead 路径的当前增益
    // --- CR-031 lookahead 状态（RT 线程独占；prepare() 分配，process() 零分配）---
    //
    // 为什么是"滑动最大值 + 延迟线"而不是"块级峰值 + 斜坡"：块级峰值只能在
    // 块边界开始压，跨块的瞬态仍然会削顶。滑动最大值看的是**未来 L 帧**，
    // 因此增益在瞬态到达之前就已经压下去，不会削顶，也不需要预报未来样本。
    std::vector<float> lookaheadDelay_[kMaxChannels];  // 每声道延迟线
    int                lookaheadWrite_ = 0;
    int                lookaheadFrames_ = 0;            // 已解析的 L（帧）
    std::vector<float> lookaheadPeak_;                  // 链接峰值的环形缓冲（L+1）
    std::vector<int>   lookaheadDeque_;                 // 单调递减索引双端队列
    int                lookaheadHead_ = 0;
    int                lookaheadTail_ = 0;
    long long          lookaheadIndex_ = 0;             // 单调样本序号
    float  crossfeedLow_[2]{};
    std::atomic<float> gainReductionDb_{0.0f};

    // Coefficient smoothing: current chases target so a slider move cannot click.
    // Shared across channels -- the coefficients are a property of the curve, not
    // of a channel, so they are computed once and used by both.
    float curB0_[kEqBandCount]{}, curB1_[kEqBandCount]{}, curB2_[kEqBandCount]{};
    float curA1_[kEqBandCount]{}, curA2_[kEqBandCount]{};
    // Per-band interpolation state: {b0,b1,b2,a1,a2}. A linear ramp over
    // smoothSamples_ is used rather than a one-pole, because SPEC 3.4 says the
    // coefficients are INTERPOLATED over about 20 ms -- a bounded, exactly
    // reached target, not an asymptotic approach.
    float bandTgt_[kEqBandCount][5]{};
    float bandDelta_[kEqBandCount][5]{};
    int   bandRamp_[kEqBandCount]{};
    bool  bandActive_[kEqBandCount]{};

    // Same ramp treatment for the two block-rate values, which would otherwise
    // step audibly when a slider moves or ReplayGain mode switches (30 ms).
    int   gainRamp_  = 0;
    float gainDelta_ = 0.0f;
    int   wetRamp_   = 0;
    float wetDelta_  = 0.0f;

    // Static gain and bypass are block-rate but must still ramp.
    float gainCurrent_ = 1.0f;
    float gainTarget_  = 1.0f;
    float wetMix_      = 0.0f;   // 0 = fully bypassed, 1 = fully processed
    float wetTarget_   = 0.0f;

    // Ramp rates, derived from the SPEC and held in samples.
    int smoothSamples_  = 0;   // ~20 ms, EQ coefficients
    int bypassSamples_  = 0;   // 30 ms, bypass crossfade
    int gainFadeSamples_ = 0;  // 30 ms, ReplayGain / mode switch

    // Bypass needs the untouched signal to cross-fade back to.
    // Pre-allocated in prepare(): SPEC 3.4 forbids allocating on this path.
    float* dry_ = nullptr;
    int    dryFrames_ = 0;
};

} // namespace te
