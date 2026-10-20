#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

#include <kiss_fftr.h>
#include <ebur128.h>

namespace te {

struct MeterResult {
    static constexpr int kMaxChannels = 8;
    static constexpr int kSpectrumBands = 48;
    static constexpr int kWaveformPoints = 64;

    int channels = 0;
    int spectrumCount = 0;
    bool hasMomentaryLufs = false;
    bool truePeakOversampled = false;
    float lufsMomentary = 0.0f;
    std::array<float, kMaxChannels> rmsDb{};
    std::array<float, kMaxChannels> peakDb{};
    std::array<float, kMaxChannels> peakHoldDb{};
    std::array<float, kMaxChannels> truePeakDb{};
    std::array<float, kSpectrumBands> spectrumDb{};
    std::array<std::array<float, 2>, kWaveformPoints> waveform{};
};

// A fixed-window, single-producer tap. The render thread only copies samples
// into preallocated slots; it never allocates, locks, or performs FFT work.
class MeterTap {
public:
    // 分析窗口长度（决定频率分辨率与主瓣宽度）。
    static constexpr int kWindowFrames = 2048;

    // 发布步长：每写满 kHopFrames 就发布一个**新的** 2048 点窗口（重叠 75%）。
    // 为什么不像以前那样"窗口满了才发"：那会把刷新率绑死在窗口长度上
    // （2048 → 23.4 帧/秒，8192 → 5.9 帧/秒，实测都卡）。解耦之后
    // 分辨率由窗口决定、刷新率由 hop 决定：512 @48 kHz = 93.75 帧/秒。
    static constexpr int kHopFrames = 512;
    static constexpr int kMaxChannels = MeterResult::kMaxChannels;
    static constexpr int kSlotCount = 3;

    MeterTap() = default;

    void prepare(int channels, int sampleRate) noexcept;
    void reset() noexcept;

    // RT thread only. planes must contain channels valid pointers and at least
    // frames samples each. Extra channels are ignored deterministically.
    void push(float* const* planes, int channels, int frames) noexcept;

    // Control thread only. Copies the newest complete window into out. A
    // sequence lets the analyzer avoid repeating the same FFT frame.
    // out 由调用方提供（analyzer 的 window_）；这里不假设它有多大。
    bool snapshot(float* out, uint64_t& sequence) const noexcept;

    int channels() const noexcept { return channels_; }
    int sampleRate() const noexcept { return sampleRate_; }

private:
    // 堆上分配：kWindowFrames 是 8192 时每个 slot 就是 262 KB，三个 slot 放在
    // 对象里会把这个类撑成 786 KB —— 而它挂在 Player 上、Player 又是 main 的栈
    // 局部变量，1 MB 的默认栈直接溢出（实测 STATUS_STACK_OVERFLOW）。
    // 分配只发生在 prepare()（控制线程），push() 依旧零分配。
    using Slot = std::array<float, kMaxChannels * kWindowFrames>;
    std::unique_ptr<Slot[]> slots_;
    // 0=free, 1=writer-owned, 2=published, 3=reader-owned. Ownership CASes
    // make the non-atomic sample copies data-race-free under the C++ memory model.
    mutable std::array<std::atomic<int>, kSlotCount> slotState_{};
    std::array<uint64_t, kSlotCount> slotSequence_{};
    std::atomic<int> publishedSlot_{-1};
    std::atomic<uint64_t> publishedSequence_{0};
    int channels_ = 0;
    int sampleRate_ = 0;

    // Render-thread-only state.
    int writeSlot_ = -1;
    int writeFrame_ = 0;
    uint64_t nextSequence_ = 1;

    int claimWritableSlot() noexcept;
};

class MeterAnalyzer {
public:
    MeterAnalyzer() = default;
    ~MeterAnalyzer();

    MeterAnalyzer(const MeterAnalyzer&) = delete;
    MeterAnalyzer& operator=(const MeterAnalyzer&) = delete;

    // Control thread only. Creates the FFT plan and all working state.
    bool prepare(int sampleRate, int channels, std::string& error);
    void reset() noexcept;

    // Control thread only. Returns false when no new complete window exists.
    bool analyze(const MeterTap& tap, MeterResult& result) noexcept;
    int sampleRate() const noexcept { return sampleRate_; }
    int channels() const noexcept { return channels_; }

private:
    // 补零到 4 倍再做 FFT：bin 宽从 23.4 Hz 压到 5.86 Hz，低频那几段才落得进 bin。
    // **补零不增加真实分辨率**（主瓣宽度仍由 2048 点窗口决定），只是把频轴插值得更细，
    // 这样 48 段的对数分布不会因为"段比 bin 还窄"而出现空格。
    static constexpr int kFftFrames = MeterTap::kWindowFrames * 4;
    static constexpr int kBins = kFftFrames / 2 + 1;

    void* fft_ = nullptr; // kiss_fftr_cfg
    int sampleRate_ = 0;
    int channels_ = 0;
    uint64_t lastSequence_ = 0;
    // 同上：这些都是 prepare() 里一次分配、之后只读写的缓冲，放堆上。
    std::unique_ptr<float[]> windowFunction_;
    std::unique_ptr<float[]> fftInput_;   // kFftFrames（前 kWindowFrames 个是样本，其余补零）
    std::unique_ptr<kiss_fft_cpx[]> fftOutput_;
    std::unique_ptr<double[]> power_;
    std::unique_ptr<float[]> window_;
    std::unique_ptr<float[]> interleaved_;
    std::array<float, MeterResult::kMaxChannels> peakHoldDb_{};
    ebur128_state* loudness_ = nullptr;
};

double meterBandCenterHz(int index, int count, int sampleRate) noexcept;

} // namespace te
