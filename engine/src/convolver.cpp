#include "convolver.hpp"

#include "media_reader.hpp"
#include "util.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>

#include <kiss_fftr.h>

// The dr_wav IMPLEMENTATION lives in audio_source.cpp. Including the header
// here only gives us the declarations -- defining it twice is an LNK2005.
#include "dr_wav.h"

namespace te {
namespace {

constexpr int P = IrBank::kPartition;
constexpr int N = IrBank::kFftSize;
constexpr int B = IrBank::kBins;
constexpr int kSlots = IrBank::kMaxPartitions;

size_t historyOffset(int channel, int slot) {
    return (static_cast<size_t>(channel) * kSlots + static_cast<size_t>(slot)) * B * 2;
}

// kiss_fft's inverse transform is unscaled (fft then ifft multiplies by N), so
// the 1/N has to be applied explicitly. The acceptance test proves this number:
// convolving a unit impulse must reproduce the IR sample for sample, and a
// missing or doubled scale factor shows up there as an obvious constant.
constexpr float kInverseScale = 1.0f / static_cast<float>(N);

struct WavCallbacks {
    static size_t read(void* user, void* out, size_t bytes) {
        return static_cast<MediaReader*>(user)->read(out, bytes);
    }
    static drwav_bool32 seek(void* user, int offset, drwav_seek_origin origin) {
        // Same mapping audio_source.cpp uses: dr_libs origins and MediaReader
        // modes are different enums that happen to agree on 0/1/2.
        return static_cast<MediaReader*>(user)->seek(offset, static_cast<int>(origin))
            ? DRWAV_TRUE : DRWAV_FALSE;
    }
    static drwav_bool32 tell(void* user, drwav_int64* cursor) {
        *cursor = static_cast<drwav_int64>(static_cast<MediaReader*>(user)->tell());
        return DRWAV_TRUE;
    }
};

// Linear resampling of an IR. This is a correction filter, not program audio:
// linear interpolation of the response is a visible compromise, so the caller
// reports the source rate rather than pretending nothing happened.
std::vector<float> resampleLinear(const std::vector<float>& input, int fromRate, int toRate) {
    if (input.empty() || fromRate <= 0 || toRate <= 0 || fromRate == toRate) return input;
    const double ratio = static_cast<double>(toRate) / static_cast<double>(fromRate);
    const size_t outCount = static_cast<size_t>(std::llround(static_cast<double>(input.size()) * ratio));
    std::vector<float> out(outCount, 0.0f);
    for (size_t i = 0; i < outCount; ++i) {
        const double src = static_cast<double>(i) / ratio;
        const size_t i0 = static_cast<size_t>(src);
        const size_t i1 = std::min(i0 + 1, input.size() - 1);
        const float t = static_cast<float>(src - static_cast<double>(i0));
        out[i] = input[std::min(i0, input.size() - 1)] * (1.0f - t) + input[i1] * t;
    }
    return out;
}

} // namespace

// Magnitude of the WHOLE response at one FFT bin index.
//
// Each partition's spectrum is the DFT of that block alone, so the parts still
// have to be recombined with their time offsets. With P = N/2 the offset factor
// e^{-j2*pi*k*P*b/N} collapses to (-1)^(k*b) -- an exact +-1, no trig needed and
// no phase error. Evaluating on the bin grid is what makes this exact; the curve
// below then just resamples it.
float IrBank::magnitudeAtBin(int bin, int channel) const noexcept {
    float re = 0.0f, im = 0.0f;
    for (int k = 0; k < partitions_; ++k) {
        const kiss_fft_cpx value = spectrum(channel, k)[bin];
        const bool negative = ((k & 1) != 0) && ((bin & 1) != 0);
        re += negative ? -value.r : value.r;
        im += negative ? -value.i : value.i;
    }
    return std::sqrt(re * re + im * im);
}

void IrBank::analyze() noexcept {
    // Peak / RMS over the bin grid of channel 0 (the channels of a correction IR
    // are conventionally normalised to each other; reporting the worst one would
    // make a deliberately offset channel look like a defect).
    double peak = 0.0;
    double energy = 0.0;
    int counted = 0;
    for (int b = 1; b < kBins; ++b) {
        const double magnitude = static_cast<double>(magnitudeAtBin(b, 0));
        if (magnitude > peak) peak = magnitude;
        energy += magnitude * magnitude;
        ++counted;
    }
    maxGainDb_ = peak > 0.0 ? static_cast<float>(20.0 * std::log10(peak)) : -120.0f;
    rmsGainDb_ = counted > 0 && energy > 0.0
        ? static_cast<float>(10.0 * std::log10(energy / counted)) : -120.0f;

    // 48 log-spaced points, 20 Hz .. 20 kHz: enough to show the shape, small
    // enough to ride in every state event without becoming the payload.
    constexpr int kPoints = 48;
    const double lo = 20.0;
    const double hi = std::min(20000.0, 0.5 * static_cast<double>(sampleRate_));
    curve_.clear();
    curve_.reserve(kPoints);
    for (int i = 0; i < kPoints; ++i) {
        const double hz = lo * std::pow(hi / lo, static_cast<double>(i) / (kPoints - 1));
        const int bin = std::min(kBins - 1, std::max(1, static_cast<int>(std::lround(hz * kFftSize / sampleRate_))));
        const double magnitude = static_cast<double>(magnitudeAtBin(bin, 0));
        const float db = magnitude > 0.0 ? static_cast<float>(20.0 * std::log10(magnitude)) : -120.0f;
        curve_.emplace_back(static_cast<float>(hz), db);
    }
}

// ---------------------------------------------------------------------------
// IrBank
// ---------------------------------------------------------------------------

IrBank::~IrBank() = default;

IrBank* IrBank::fromSamples(const std::vector<std::vector<float>>& channels,
                            int sampleRate, std::string& error) {
    if (channels.empty()) { error = "IR has no channels"; return nullptr; }
    if (channels.size() > static_cast<size_t>(kMaxChannels)) {
        error = "IR has more than two channels";
        return nullptr;
    }
    if (sampleRate <= 0) { error = "IR has no sample rate"; return nullptr; }

    size_t taps = 0;
    for (const auto& channel : channels) taps = std::max(taps, channel.size());
    if (taps == 0) { error = "IR is empty"; return nullptr; }
    if (taps > static_cast<size_t>(kMaxPartitions) * P) {
        error = "IR is longer than " + std::to_string(kMaxPartitions * P) + " taps ("
              + std::to_string((kMaxPartitions * P * 1000) / sampleRate) + " ms at this rate)";
        return nullptr;
    }

    auto* bank = new IrBank();
    bank->channels_ = static_cast<int>(channels.size());
    bank->sampleRate_ = sampleRate;
    bank->taps_ = static_cast<int>(taps);
    bank->partitions_ = static_cast<int>((taps + P - 1) / P);
    bank->spectra_.assign(static_cast<size_t>(bank->channels_) * bank->partitions_ * B, kiss_fft_cpx{0.0f, 0.0f});

    kiss_fftr_cfg forward = kiss_fftr_alloc(N, 0, nullptr, nullptr);
    if (forward == nullptr) { delete bank; error = "FFT allocation failed"; return nullptr; }
    std::vector<float> time(N, 0.0f);
    std::vector<kiss_fft_cpx> freq(B);

    for (int ch = 0; ch < bank->channels_; ++ch) {
        for (int part = 0; part < bank->partitions_; ++part) {
            std::fill(time.begin(), time.end(), 0.0f);
            const size_t offset = static_cast<size_t>(part) * P;
            const auto& source = channels[static_cast<size_t>(ch)];
            for (int i = 0; i < P; ++i) {
                const size_t index = offset + static_cast<size_t>(i);
                if (index < source.size()) time[static_cast<size_t>(i)] = source[index];
            }
            kiss_fftr(forward, time.data(), freq.data());
            std::memcpy(bank->spectra_.data() + (static_cast<size_t>(ch) * bank->partitions_ + part) * B,
                        freq.data(), B * sizeof(kiss_fft_cpx));
        }
    }
    kiss_fftr_free(forward);
    bank->analyze();
    return bank;
}

namespace {

IrBank* loadWav(const std::string& path, std::string& error) {
    MediaReader reader;
    // The path arrives as UTF-8 from the protocol, and a bare std::string would
    // be interpreted as the ANSI code page on Windows -- a Chinese directory
    // becomes mojibake and the file "does not exist". fromUtf8 is the project's
    // one conversion point for exactly this.
    if (!reader.open(fromUtf8(path))) { error = "cannot open IR: " + reader.errorMessage(); return nullptr; }

    drwav wav{};
    if (drwav_init(&wav, &WavCallbacks::read, &WavCallbacks::seek, &WavCallbacks::tell, &reader, nullptr) != DRWAV_TRUE) {
        error = "not a readable WAV impulse response";
        return nullptr;
    }
    const uint32_t channels = wav.channels;
    const uint32_t rate = wav.sampleRate;
    const drwav_uint64 frames = wav.totalPCMFrameCount;
    if (channels == 0 || rate == 0 || frames == 0) {
        error = "IR header is degenerate (channels/rate/frames = 0)";
        drwav_uninit(&wav);
        return nullptr;
    }
    if (channels > static_cast<uint32_t>(IrBank::kMaxChannels)) {
        error = "IR has " + std::to_string(channels) + " channels; this convolver takes mono or stereo";
        drwav_uninit(&wav);
        return nullptr;
    }

    std::vector<std::vector<float>> planar(channels);
    for (auto& channel : planar) channel.assign(static_cast<size_t>(frames), 0.0f);
    std::vector<drwav_int32> block(static_cast<size_t>(P) * channels);
    drwav_uint64 frame = 0;
    while (frame < frames) {
        const drwav_uint64 want = std::min<drwav_uint64>(frames - frame, static_cast<drwav_uint64>(P));
        const drwav_uint64 got = drwav_read_pcm_frames_s32(&wav, want, block.data());
        if (got == 0) break;
        for (drwav_uint64 i = 0; i < got; ++i) {
            for (uint32_t ch = 0; ch < channels; ++ch) {
                planar[ch][static_cast<size_t>(frame + i)] =
                    static_cast<float>(static_cast<double>(block[static_cast<size_t>(i) * channels + ch]) / 2147483648.0);
            }
        }
        frame += got;
    }
    drwav_uninit(&wav);
    if (frame == 0) { error = "IR decoded to zero frames"; return nullptr; }

    for (auto& channel : planar) channel.resize(static_cast<size_t>(frame));
    IrBank* bank = IrBank::fromSamples(planar, static_cast<int>(rate), error);
    if (bank != nullptr) {
        // The interface needs to say WHICH response is in force after a restart,
        // and the path itself can be long and private.
        const std::filesystem::path file = fromUtf8(path);
        bank->setName(toUtf8(file.filename()));
    }
    return bank;
}

} // namespace

IrBank* IrBank::load(const std::string& path, std::string& error) {
    return loadWav(path, error);
}

// ---------------------------------------------------------------------------
// FirConvolver
// ---------------------------------------------------------------------------

FirConvolver::FirConvolver() = default;

FirConvolver::~FirConvolver() {
    if (forward_) kiss_fftr_free(forward_);
    if (inverse_) kiss_fftr_free(inverse_);
    forward_ = nullptr;
    inverse_ = nullptr;
}

bool FirConvolver::prepare(int sampleRate, std::string& error) {
    if (forward_) kiss_fftr_free(forward_);
    if (inverse_) kiss_fftr_free(inverse_);
    forward_ = kiss_fftr_alloc(N, 0, nullptr, nullptr);
    inverse_ = kiss_fftr_alloc(N, 1, nullptr, nullptr);
    if (!forward_ || !inverse_) { error = "FFT allocation failed"; return false; }
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000;

    inRing_.assign(static_cast<size_t>(kChannels) * P, 0.0f);
    outRing_.assign(static_cast<size_t>(kChannels) * P, 0.0f);
    carry_.assign(static_cast<size_t>(kChannels) * P, 0.0f);
    history_.assign(static_cast<size_t>(kChannels) * kSlots * B * 2, 0.0f);
    timeScratch_.assign(N, 0.0f);
    ifftScratch_.assign(N, 0.0f);
    acc_.assign(static_cast<size_t>(B) * 2, 0.0f);
    reset();
    return true;
}

void FirConvolver::adopt(const IrBank* bank) noexcept {
    bank_ = bank;
    reset();
}

void FirConvolver::reset() noexcept {
    std::fill(inRing_.begin(), inRing_.end(), 0.0f);
    std::fill(outRing_.begin(), outRing_.end(), 0.0f);
    std::fill(carry_.begin(), carry_.end(), 0.0f);
    std::fill(history_.begin(), history_.end(), 0.0f);
    pos_ = 0;
    head_ = 0;
}

void FirConvolver::runBlock() noexcept {
    if (!bank_ || !forward_) return;
    const int parts = bank_->partitions();
    const int channels = std::min(kChannels, std::max(1, bank_->channels()));

    for (int ch = 0; ch < channels; ++ch) {
        // 1) the input block, zero padded to the FFT size
        std::memcpy(timeScratch_.data(), inRing_.data() + static_cast<size_t>(ch) * P, sizeof(float) * P);
        std::fill(timeScratch_.begin() + P, timeScratch_.end(), 0.0f);
        kiss_fft_cpx* slot = reinterpret_cast<kiss_fft_cpx*>(history_.data() + historyOffset(ch, head_));
        kiss_fftr(forward_, timeScratch_.data(), slot);

        // 2) sum over partitions: history[head - k] * H[k]
        std::fill(acc_.begin(), acc_.end(), 0.0f);
        float* acc = acc_.data();
        for (int k = 0; k < parts; ++k) {
            const int at = (head_ - k + kSlots) % kSlots;
            const kiss_fft_cpx* x = reinterpret_cast<const kiss_fft_cpx*>(history_.data() + historyOffset(ch, at));
            const kiss_fft_cpx* h = bank_->spectrum(std::min(ch, bank_->channels() - 1), k);
            for (int b = 0; b < B; ++b) {
                const float ar = acc[b * 2], ai = acc[b * 2 + 1];
                acc[b * 2] = ar + x[b].r * h[b].r - x[b].i * h[b].i;
                acc[b * 2 + 1] = ai + x[b].r * h[b].i + x[b].i * h[b].r;
            }
        }

        // 3) back to time, overlap-add the tail into the next block
        kiss_fftri(inverse_, reinterpret_cast<const kiss_fft_cpx*>(acc_.data()), ifftScratch_.data());
        float* out = outRing_.data() + static_cast<size_t>(ch) * P;
        float* carry = carry_.data() + static_cast<size_t>(ch) * P;
        for (int i = 0; i < P; ++i) {
            out[i] = ifftScratch_[static_cast<size_t>(i)] * kInverseScale + carry[i];
            carry[i] = ifftScratch_[static_cast<size_t>(P + i)] * kInverseScale;
        }
    }
    head_ = (head_ + 1) % kSlots;
}

void FirConvolver::process(float* const* planes, int channels, int frames) noexcept {
    if (!bank_ || !forward_ || planes == nullptr) return;
    const int active = std::min(channels, std::min(kChannels, std::max(1, bank_->channels())));
    for (int i = 0; i < frames; ++i) {
        for (int ch = 0; ch < active; ++ch) {
            float* plane = planes[ch];
            if (plane == nullptr) continue;
            inRing_[static_cast<size_t>(ch) * P + static_cast<size_t>(pos_)] = plane[i];
            plane[i] = outRing_[static_cast<size_t>(ch) * P + static_cast<size_t>(pos_)];
        }
        if (++pos_ == P) { pos_ = 0; runBlock(); }
    }
}

} // namespace te
