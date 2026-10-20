#pragma once
// Partitioned FIR convolution for room / headphone correction.
//
// WHY kPartition FRAMES OF LATENCY IS ACCEPTABLE HERE: this is a music player,
// not a monitor path. The alternative -- direct convolution of a 72000-tap
// response -- costs 72000 multiply-adds per sample per channel (~7 GFLOP/s at
// 48 kHz stereo), which cannot run in a render callback. Splitting the IR into
// 1024-frame partitions and doing it in the frequency domain turns that into a
// few thousand complex MACs per block.
//
// WHAT IS DELIBERATELY NOT HERE:
//  - no allocation in process(); every buffer is sized in prepare()
//  - no locks, no logging, no exceptions on the RT path
//  - no dry/wet mix: a correction IR already contains the direct path, so
//    mixing dry back in would comb-filter the result. The stage is full wet,
//    and changing that is a decision, not a parameter.

#include <cstdint>
#include <string>
#include <vector>

// Pulls in kiss_fft_cpx / kiss_fft_scalar as well as kiss_fftr_cfg. Hand-rolling
// a forward declaration here is what broke the first build: kiss_fftr.h already
// defines the cfg typedef, and kiss_fft_cpx comes from kiss_fft.h behind it.
#include <kiss_fftr.h>

namespace te {

// One loaded impulse response, resolved into per-partition spectra.
// Immutable once built; shared between the control thread (which builds it) and
// the render thread (which only reads it).
class IrBank {
public:
    static constexpr int kPartition = 1024;
    static constexpr int kFftSize = kPartition * 2;
    static constexpr int kBins = kFftSize / 2 + 1;
    // 128 partitions is 2.7 s at 48 kHz. Longer than that is not a room
    // correction, it is a reverb preset, and the memory grows linearly.
    static constexpr int kMaxPartitions = 128;
    static constexpr int kMaxChannels = 2;

    ~IrBank();
    IrBank(const IrBank&) = delete;
    IrBank& operator=(const IrBank&) = delete;

    // Control thread. Reads a WAV through the engine's own MediaReader path, so
    // Chinese and long paths behave exactly as in playback. Returns nullptr and
    // sets error on any refusal.
    static IrBank* load(const std::string& path, std::string& error);

    // Control thread. Builds from already-decoded planar samples (used by tests,
    // and by any future "load from memory" path).
    static IrBank* fromSamples(const std::vector<std::vector<float>>& channels,
                               int sampleRate, std::string& error);

    int channels() const noexcept { return channels_; }
    int partitions() const noexcept { return partitions_; }
    int sampleRate() const noexcept { return sampleRate_; }
    int taps() const noexcept { return taps_; }
    // --- analysis, computed once at build time -----------------------------
    // Peak and RMS gain of the whole response. These are what make an automatic
    // preamp honest: a correction IR that boosts +6 dB somewhere WILL clip a
    // full-scale signal, and "sounds fine on my track" is not evidence it does not.
    float maxGainDb() const noexcept { return maxGainDb_; }
    float rmsGainDb() const noexcept { return rmsGainDb_; }
    /** Log-spaced magnitude points for the interface: [hz, db]. */
    const std::vector<std::pair<float, float>>& curve() const noexcept { return curve_; }
    /** Display name (the file's base name), for state reporting. */
    const std::string& name() const noexcept { return name_; }
    void setName(const std::string& value) { name_ = value.substr(0, 120); }
    const kiss_fft_cpx* spectrum(int channel, int partition) const noexcept {
        return spectra_.data() + (static_cast<size_t>(channel) * partitions_ + partition) * kBins;
    }

private:
    IrBank() = default;

    float magnitudeAtBin(int bin, int channel) const noexcept;
    void analyze() noexcept;

    int channels_ = 0;
    int partitions_ = 0;
    int sampleRate_ = 0;
    int taps_ = 0;
    float maxGainDb_ = 0.0f;
    float rmsGainDb_ = 0.0f;
    std::string name_;
    std::vector<std::pair<float, float>> curve_;   // [hz, db]
    std::vector<kiss_fft_cpx> spectra_;   // [channel][partition][bin]
};

// Per-channel streaming state. One instance lives inside DspChain.
class FirConvolver {
public:
    static constexpr int kPartition = IrBank::kPartition;
    static constexpr int kFftSize = IrBank::kFftSize;
    static constexpr int kBins = IrBank::kBins;
    static constexpr int kChannels = IrBank::kMaxChannels;

    FirConvolver();
    ~FirConvolver();
    FirConvolver(const FirConvolver&) = delete;
    FirConvolver& operator=(const FirConvolver&) = delete;

    // Control thread. Allocates; call before the render thread starts.
    bool prepare(int sampleRate, std::string& error);

    // Render thread. Adopting a bank clears the history: the new response has
    // its own notion of time zero, and carrying the old tail across would make
    // the switch audible as the previous room decaying.
    void adopt(const IrBank* bank) noexcept;

    // Render thread. In place, any frame count. Emits silence until the first
    // partition is full, which is exactly what convolving with a signal that
    // starts at t=0 produces.
    void process(float* const* planes, int channels, int frames) noexcept;

    // Render thread, on seek / stream start.
    void reset() noexcept;

    int latencyFrames() const noexcept { return kPartition; }
    bool active() const noexcept { return bank_ != nullptr; }

private:
    void runBlock() noexcept;

    const IrBank* bank_ = nullptr;
    int sampleRate_ = 48000;

    // Input ring for the block being collected, output ring for the block that
    // was computed at the end of the previous one, and the overlap-add carry.
    std::vector<float> inRing_;      // [channel][kPartition]
    std::vector<float> outRing_;     // [channel][kPartition]
    std::vector<float> carry_;       // [channel][kPartition]
    // Sliding window of input spectra, one per partition slot.
    std::vector<float> history_;     // [channel][slot][kBins*2]
    int pos_ = 0;
    int head_ = 0;

    kiss_fftr_cfg forward_ = nullptr;
    kiss_fftr_cfg inverse_ = nullptr;
    std::vector<float> timeScratch_;       // kFftSize
    std::vector<float> ifftScratch_;       // kFftSize
    std::vector<float> acc_;               // kBins*2 (complex, interleaved)
};

} // namespace te
