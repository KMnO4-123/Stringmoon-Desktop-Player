#include "meter.hpp"


#include <algorithm>
#include <cmath>
#include <cstring>

namespace te {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr float kFloorDb = -72.0f;

float dbFromLinear(double value) noexcept {
    return value > 1e-12 ? static_cast<float>(20.0 * std::log10(value)) : kFloorDb;
}

} // namespace

void MeterTap::prepare(int channels, int sampleRate) noexcept {
    if (!slots_) slots_ = std::make_unique<Slot[]>(kSlotCount);
    channels_ = std::clamp(channels, 1, kMaxChannels);
    sampleRate_ = std::max(1, sampleRate);
    for (auto& state : slotState_) state.store(0, std::memory_order_relaxed);
    slotSequence_.fill(0);
    publishedSlot_.store(-1, std::memory_order_relaxed);
    publishedSequence_.store(0, std::memory_order_relaxed);
    writeSlot_ = claimWritableSlot();
    writeFrame_ = 0;
    nextSequence_ = 1;
}

void MeterTap::reset() noexcept {
    publishedSlot_.store(-1, std::memory_order_release);
    publishedSequence_.store(0, std::memory_order_release);
    writeSlot_ = -1;
    writeFrame_ = 0;
    nextSequence_ = 1;
    for (auto& state : slotState_) state.store(0, std::memory_order_relaxed);
    slotSequence_.fill(0);
    writeSlot_ = claimWritableSlot();
}

int MeterTap::claimWritableSlot() noexcept {
    const int published = publishedSlot_.load(std::memory_order_acquire);
    for (int offset = 1; offset <= kSlotCount; ++offset) {
        const int candidate = (published + offset + kSlotCount) % kSlotCount;
        if (candidate == published) continue;
        int state = slotState_[static_cast<size_t>(candidate)].load(std::memory_order_acquire);
        while (state == 0 || state == 2) {
            if (slotState_[static_cast<size_t>(candidate)].compare_exchange_weak(
                    state, 1, std::memory_order_acq_rel, std::memory_order_acquire)) return candidate;
        }
    }
    return -1;
}

void MeterTap::push(float* const* planes, int channels, int frames) noexcept {
    if (!planes || frames <= 0) return;
    const int count = std::min(channels_, std::min(channels, kMaxChannels));
    if (count <= 0 || count != channels_) return;
    if (writeSlot_ < 0) writeSlot_ = claimWritableSlot();

    for (int frame = 0; frame < frames; ++frame) {
        if (writeSlot_ < 0) {
            writeSlot_ = claimWritableSlot();
            if (writeSlot_ < 0) continue;
        }
        auto& slot = slots_[static_cast<size_t>(writeSlot_)];
        for (int ch = 0; ch < count; ++ch)
            slot[static_cast<size_t>(ch) * kWindowFrames + writeFrame_] = planes[ch][frame];
        if (++writeFrame_ == kWindowFrames) {
            // 发布当前这个完整窗口。
            slotSequence_[static_cast<size_t>(writeSlot_)] = nextSequence_;
            publishedSequence_.store(nextSequence_, std::memory_order_release);
            slotState_[static_cast<size_t>(writeSlot_)].store(2, std::memory_order_release);
            publishedSlot_.store(writeSlot_, std::memory_order_release);
            ++nextSequence_;

            // 重叠：把刚发布窗口的最后 (window - hop) 个样本搬进下一个槽，
            // 让后续 kHopFrames 个新样本补满它。拷贝发生在**写者自己拥有的槽**上，
            // 与读者无共享，所以仍然是无锁且无数据竞争的。
            const int keep = kWindowFrames - kHopFrames;
            const int filled = writeSlot_;
            writeSlot_ = claimWritableSlot();
            if (writeSlot_ >= 0) {
                for (int ch = 0; ch < count; ++ch) {
                    std::memcpy(slots_[static_cast<size_t>(writeSlot_)].data() + static_cast<size_t>(ch) * kWindowFrames,
                                slots_[static_cast<size_t>(filled)].data() + static_cast<size_t>(ch) * kWindowFrames + kHopFrames,
                                sizeof(float) * static_cast<size_t>(keep));
                }
                writeFrame_ = keep;
            } else {
                // 三个槽都被读者占着：放弃这次重叠，下一帧从空窗开始。
                // 宁可掉一帧的连续性，也不能踩正在被读的槽。
                writeFrame_ = 0;
            }
        }
    }
}

bool MeterTap::snapshot(float* out, uint64_t& sequence) const noexcept {
    const int slot = publishedSlot_.load(std::memory_order_acquire);
    if (slot < 0 || slot >= kSlotCount) return false;
    int expected = 2;
    if (!slotState_[slot].compare_exchange_strong(expected, 3, std::memory_order_acq_rel,
                                                  std::memory_order_acquire)) return false;
    if (publishedSlot_.load(std::memory_order_acquire) != slot) {
        slotState_[slot].store(2, std::memory_order_release);
        return false;
    }
    // 只拷"实际声道数"的窗口，不是 kMaxChannels 个：槽位按 8 声道分配（kMaxChannels），
    // 但常态是 2 声道，按 8 声道拷每帧要搬 64 KB，其中 48 KB 谁也读不到（analyzer 只
    // 按 channels_ 循环）。60 帧/秒下这是约 2.9 MB/s 的纯浪费（bench_hot 可量）。
    std::memcpy(out, slots_[static_cast<size_t>(slot)].data(),
                sizeof(float) * static_cast<size_t>(channels_) * kWindowFrames);
    sequence = slotSequence_[slot];
    slotState_[slot].store(2, std::memory_order_release);
    return true;
}

MeterAnalyzer::~MeterAnalyzer() {
    if (fft_) kiss_fftr_free(static_cast<kiss_fftr_cfg>(fft_));
    if (loudness_) ebur128_destroy(&loudness_);
}

bool MeterAnalyzer::prepare(int sampleRate, int channels, std::string& error) {
    // 只在控制线程、且只在 prepare 里分配（RT 路径依旧零分配）。
    if (!windowFunction_) windowFunction_ = std::make_unique<float[]>(MeterTap::kWindowFrames);
    if (!fftInput_)      fftInput_      = std::make_unique<float[]>(kFftFrames);
    if (!fftOutput_)     fftOutput_     = std::make_unique<kiss_fft_cpx[]>(kBins);
    if (!power_)         power_         = std::make_unique<double[]>(kBins);
    if (!window_)        window_        = std::make_unique<float[]>(static_cast<size_t>(MeterResult::kMaxChannels) * MeterTap::kWindowFrames);
    if (!interleaved_)   interleaved_   = std::make_unique<float[]>(static_cast<size_t>(MeterResult::kMaxChannels) * MeterTap::kWindowFrames);
    if (fft_) {
        kiss_fftr_free(static_cast<kiss_fftr_cfg>(fft_));
        fft_ = nullptr;
    }
    if (loudness_) ebur128_destroy(&loudness_);
    sampleRate_ = sampleRate;
    channels_ = std::clamp(channels, 1, MeterResult::kMaxChannels);
    lastSequence_ = 0;
    peakHoldDb_.fill(kFloorDb);
    if (sampleRate_ <= 0 || channels <= 0) {
        error = "meter requires a positive sample rate and channel count";
        return false;
    }
    fft_ = kiss_fftr_alloc(kFftFrames, 0, nullptr, nullptr);
    if (!fft_) {
        error = "cannot allocate meter FFT";
        return false;
    }
    loudness_ = ebur128_init(static_cast<unsigned>(channels_), static_cast<unsigned long>(sampleRate_),
                             EBUR128_MODE_M | EBUR128_MODE_TRUE_PEAK | EBUR128_MODE_SAMPLE_PEAK);
    const int windowResult = loudness_ ? ebur128_set_max_window(loudness_, 400) : EBUR128_ERROR_NOMEM;
    if (!loudness_ || (windowResult != EBUR128_SUCCESS && windowResult != EBUR128_ERROR_NO_CHANGE)) {
        if (loudness_) ebur128_destroy(&loudness_);
        kiss_fftr_free(static_cast<kiss_fftr_cfg>(fft_));
        fft_ = nullptr;
        error = "cannot allocate momentary loudness meter";
        return false;
    }
    // Keep only the 400 ms Momentary history. Integrated loudness and LRA are
    // offline scans and must not grow with playback duration here.
    (void)ebur128_set_max_history(loudness_, 400);
    for (int i = 0; i < MeterTap::kWindowFrames; ++i) {
        windowFunction_[static_cast<size_t>(i)] = static_cast<float>(
            0.5 * (1.0 - std::cos(2.0 * kPi * i / (MeterTap::kWindowFrames - 1))));
    }
    return true;
}

void MeterAnalyzer::reset() noexcept {
    lastSequence_ = 0;
    peakHoldDb_.fill(kFloorDb);
    if (loudness_) ebur128_destroy(&loudness_);
    if (sampleRate_ > 0 && channels_ > 0) {
        loudness_ = ebur128_init(static_cast<unsigned>(channels_), static_cast<unsigned long>(sampleRate_),
                                 EBUR128_MODE_M | EBUR128_MODE_TRUE_PEAK | EBUR128_MODE_SAMPLE_PEAK);
        if (loudness_) {
            (void)ebur128_set_max_window(loudness_, 400);
            (void)ebur128_set_max_history(loudness_, 400);
        }
    }
}

double meterBandCenterHz(int index, int count, int sampleRate) noexcept {
    if (count <= 1 || sampleRate <= 0) return 20.0;
    const double maxHz = std::min(20000.0, sampleRate * 0.5);
    const double ratio = maxHz / 20.0;
    return 20.0 * std::pow(ratio, static_cast<double>(index) / (count - 1));
}

bool MeterAnalyzer::analyze(const MeterTap& tap, MeterResult& result) noexcept {
    uint64_t sequence = 0;
    if (!fft_) return false;
    if (!tap.snapshot(window_.get(), sequence)) return false;
    const uint64_t sequenceDelta = lastSequence_ > 0 && sequence > lastSequence_
        ? sequence - lastSequence_ : 1;
    lastSequence_ = sequence;

    result = MeterResult{};
    result.channels = channels_;
    result.spectrumCount = MeterResult::kSpectrumBands;
    result.rmsDb.fill(kFloorDb);
    result.peakDb.fill(kFloorDb);
    result.peakHoldDb.fill(kFloorDb);
    result.truePeakDb.fill(kFloorDb);
    result.spectrumDb.fill(kFloorDb);
    std::fill(power_.get(), power_.get() + kBins, 0.0);

    for (int ch = 0; ch < channels_; ++ch) {
        const float* source = window_.get() + static_cast<size_t>(ch) * MeterTap::kWindowFrames;
        double sum = 0.0;
        float peak = 0.0f;
        for (int i = 0; i < MeterTap::kWindowFrames; ++i) {
            const float sample = source[i];
            sum += static_cast<double>(sample) * sample;
            peak = std::max(peak, std::fabs(sample));
            fftInput_[static_cast<size_t>(i)] = sample * windowFunction_[static_cast<size_t>(i)];
            interleaved_[static_cast<size_t>(i) * channels_ + ch] = sample;
        }
        const float rmsDb = dbFromLinear(std::sqrt(sum / MeterTap::kWindowFrames));
        const float peakDb = dbFromLinear(peak);
        result.rmsDb[static_cast<size_t>(ch)] = rmsDb;
        result.peakDb[static_cast<size_t>(ch)] = peakDb;
        const float holdDecayDb = static_cast<float>(
            // 相邻两帧之间实际只过去了 kHopFrames 个样本（重叠分析），
            // 用窗口长度会让峰值保持的衰减慢 4 倍。
            20.0 * MeterTap::kHopFrames * sequenceDelta / sampleRate_);
        peakHoldDb_[static_cast<size_t>(ch)] = std::max(peakDb, peakHoldDb_[static_cast<size_t>(ch)] - holdDecayDb);
        result.peakHoldDb[static_cast<size_t>(ch)] = peakHoldDb_[static_cast<size_t>(ch)];
        result.truePeakDb[static_cast<size_t>(ch)] = peakDb;

        // 补零：只有前 kWindowFrames 个是样本，其余保持 0。
        std::fill(fftInput_.get() + MeterTap::kWindowFrames,
                  fftInput_.get() + kFftFrames, 0.0f);
        kiss_fftr(static_cast<kiss_fftr_cfg>(fft_), fftInput_.get(), fftOutput_.get());
        for (int bin = 0; bin < kBins; ++bin) {
            const double re = fftOutput_[static_cast<size_t>(bin)].r;
            const double im = fftOutput_[static_cast<size_t>(bin)].i;
            power_[static_cast<size_t>(bin)] += (re * re + im * im) / channels_;
        }
    }

    bool truePeakQueriesSucceeded = false;
    if (loudness_ && ebur128_add_frames_float(loudness_, interleaved_.get(),
                                              MeterTap::kWindowFrames) == EBUR128_SUCCESS) {
        double lufs = 0.0;
        if (ebur128_loudness_momentary(loudness_, &lufs) == EBUR128_SUCCESS && std::isfinite(lufs)) {
            result.lufsMomentary = static_cast<float>(lufs);
            result.hasMomentaryLufs = true;
        }
        truePeakQueriesSucceeded = true;
        for (int ch = 0; ch < channels_; ++ch) {
            double peak = 0.0;
            if (ebur128_prev_true_peak(loudness_, static_cast<unsigned>(ch), &peak) == EBUR128_SUCCESS)
                result.truePeakDb[static_cast<size_t>(ch)] = dbFromLinear(peak);
            else
                truePeakQueriesSucceeded = false;
        }
    }
    result.truePeakOversampled = sampleRate_ < 192000 && truePeakQueriesSucceeded;
    if (!truePeakQueriesSucceeded) {
        for (int ch = 0; ch < channels_; ++ch)
            result.truePeakDb[static_cast<size_t>(ch)] = result.peakDb[static_cast<size_t>(ch)];
    }

    constexpr int framesPerPoint = MeterTap::kWindowFrames / MeterResult::kWaveformPoints;
    for (int point = 0; point < MeterResult::kWaveformPoints; ++point) {
        float minimum = 1.0f;
        float maximum = -1.0f;
        const int first = point * framesPerPoint;
        for (int i = first; i < first + framesPerPoint; ++i) {
            for (int ch = 0; ch < channels_; ++ch) {
                const float sample = window_[static_cast<size_t>(ch) * MeterTap::kWindowFrames + i];
                minimum = std::min(minimum, sample);
                maximum = std::max(maximum, sample);
            }
        }
        result.waveform[static_cast<size_t>(point)] = { minimum, maximum };
    }

    const double nyquist = sampleRate_ * 0.5;
    const double ratio = std::pow(std::min(20000.0, nyquist) / 20.0,
                                  1.0 / (MeterResult::kSpectrumBands - 1));
    for (int band = 0; band < MeterResult::kSpectrumBands; ++band) {
        const double center = meterBandCenterHz(band, MeterResult::kSpectrumBands, sampleRate_);
        const double low = band == 0 ? 20.0 : center / std::sqrt(ratio);
        const double high = band == MeterResult::kSpectrumBands - 1 ? nyquist : center * std::sqrt(ratio);
        if (low >= nyquist) continue;
        const int first = std::max(1, static_cast<int>(std::ceil(low * kFftFrames / sampleRate_)));
        const int last = std::min(kBins - 1, static_cast<int>(std::floor(high * kFftFrames / sampleRate_)));
        double sum = 0.0;
        if (first > last) {
            // 这个频段的宽度还不到一个 bin —— 低频必然如此。**不能留空**：
            // 空的段会停在底噪，画出来就是频谱上的断口（用户报的"低频段不连续"）。
            // 取中心两侧的 bin 按中心位置线性插值，既保证有值，又比"最近 bin"
            // 少一层阶梯感。
            const double position = center * kFftFrames / sampleRate_;
            const int lo = std::clamp(static_cast<int>(std::floor(position)), 1, kBins - 1);
            const int hi = std::clamp(lo + 1, 1, kBins - 1);
            const double t = std::clamp(position - std::floor(position), 0.0, 1.0);
            sum = power_[static_cast<size_t>(lo)] * (1.0 - t) + power_[static_cast<size_t>(hi)] * t;
        } else {
            for (int bin = first; bin <= last; ++bin) sum += power_[static_cast<size_t>(bin)];
        }
        // 补零后同一段内会落进更多 bin，全带功率随之放大 (kFftFrames/kWindowFrames) 倍；
        // 不除掉这个比例，频谱整体会凭空抬高 6 dB。
        constexpr double kPadRatio = static_cast<double>(kFftFrames) / MeterTap::kWindowFrames;
        const double amplitude = 4.0 * std::sqrt(std::max(0.0, sum))
            / (MeterTap::kWindowFrames * std::sqrt(kPadRatio));
        result.spectrumDb[static_cast<size_t>(band)] = std::max(kFloorDb, dbFromLinear(amplitude));
    }
    return true;
}

} // namespace te