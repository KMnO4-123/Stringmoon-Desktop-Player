// probe_ir.cpp -- what would a convolver actually have to handle?
//
// There is no FIR convolution in the engine yet. This probe exists because the
// FIRST thing that decides whether room correction is viable here is not the
// algorithm, it is the material: how long real impulse responses are, how many
// channels, whether they are finite, and how much tap memory one would cost.
//
// It loads the file through the SAME MediaReader path playback uses, so a
// Chinese path or a long path behaves here exactly as in the real signal path.
//
// Usage: twilight-engine --probe-ir <file.wav> [more files...]

#include "media_reader.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#endif

// The dr_wav IMPLEMENTATION lives in audio_source.cpp; defining it here too
// makes the linker see two copies of every internal helper (LNK2005).
// Only the declarations are needed.
#include "dr_wav.h"

namespace te {
namespace {

size_t irRead(void* user, void* out, size_t bytes) {
    return static_cast<MediaReader*>(user)->read(out, bytes);
}
drwav_bool32 irSeek(void* user, int offset, drwav_seek_origin origin) {
    auto* reader = static_cast<MediaReader*>(user);
    // dr_libs' origins and MediaReader's modes are different enums with no
    // guaranteed relationship, but audio_source.cpp already maps them by value
    // (0=beginning, 1=current, 2=end), so this probe does exactly the same
    // rather than inventing a second mapping that could drift.
    return reader->seek(offset, static_cast<int>(origin)) ? DRWAV_TRUE : DRWAV_FALSE;
}
drwav_bool32 irTell(void* user, drwav_int64* cursor) {
    *cursor = static_cast<drwav_int64>(static_cast<MediaReader*>(user)->tell());
    return DRWAV_TRUE;
}

// These are the numbers the convolver design assumes. The probe reports what
// THIS file would cost under them, rather than describing the file in the
// abstract.
constexpr int kPartitionFrames = 1024;
constexpr int kMaxPartitions = 128;     // ~2.7 s at 48 kHz
constexpr int kMaxChannels = 2;

void probeOne(const char* path) {
    std::printf("\n%s\n", path);

    MediaReader reader;
    if (!reader.open(path)) {
        std::printf("  FAIL open: %s\n", reader.errorMessage().c_str());
        return;
    }
    drwav wav{};
    if (drwav_init(&wav, irRead, irSeek, irTell, &reader, nullptr) != DRWAV_TRUE) {
        std::printf("  FAIL not a readable WAV (an IR must be PCM or float)\n");
        return;
    }

    const uint32_t channels = wav.channels;
    const uint32_t rate = wav.sampleRate;
    const uint32_t bits = wav.bitsPerSample;
    const bool isFloat = wav.translatedFormatTag == DR_WAVE_FORMAT_IEEE_FLOAT;
    const drwav_uint64 frames = wav.totalPCMFrameCount;
    if (channels == 0 || rate == 0 || frames == 0) {
        std::printf("  FAIL degenerate header: ch=%u rate=%u frames=%llu\n", channels, rate,
                    static_cast<unsigned long long>(frames));
        drwav_uninit(&wav);
        return;
    }

    const size_t chunk = static_cast<size_t>(kPartitionFrames) * channels;
    std::vector<drwav_int32> samples(chunk);

    double peak = 0.0, sumSq = 0.0, sumDc = 0.0;
    uint64_t counted = 0, nonFinite = 0;
    int64_t firstEnergy = -1, lastEnergy = -1;
    drwav_uint64 frame = 0;
    while (frame < frames) {
        const drwav_uint64 want = (frames - frame) < static_cast<drwav_uint64>(kPartitionFrames)
            ? (frames - frame) : static_cast<drwav_uint64>(kPartitionFrames);
        const drwav_uint64 got = drwav_read_pcm_frames_s32(&wav, want, samples.data());
        if (got == 0) break;
        for (drwav_uint64 i = 0; i < got; ++i) {
            for (uint32_t ch = 0; ch < channels; ++ch) {
                const double value = static_cast<double>(samples[i * channels + ch]) / 2147483648.0;
                if (!std::isfinite(value)) { nonFinite++; continue; }
                const double magnitude = std::fabs(value);
                if (magnitude > peak) peak = magnitude;
                sumSq += value * value;
                sumDc += value;
                counted++;
                if (magnitude > 1e-6) {
                    if (firstEnergy < 0) firstEnergy = static_cast<int64_t>(frame + i);
                    lastEnergy = static_cast<int64_t>(frame + i);
                }
            }
        }
        frame += got;
    }
    drwav_uninit(&wav);

    const double durationMs = 1000.0 * static_cast<double>(frames) / static_cast<double>(rate);
    const double rms = counted > 0 ? std::sqrt(sumSq / static_cast<double>(counted)) : 0.0;
    const double dc = counted > 0 ? sumDc / static_cast<double>(counted) : 0.0;
    const int partitions = static_cast<int>((frames + kPartitionFrames - 1) / kPartitionFrames);
    // One complex FFT of 2x the partition per channel per block: the cost unit a
    // partitioned convolver is measured in.
    const double fftPerSecond = 1000.0 / (1000.0 * kPartitionFrames / rate) * partitions * channels;

    std::printf("  format      %s %u-bit @ %u Hz, %u ch\n", isFloat ? "float" : "pcm", bits, rate, channels);
    std::printf("  frames      %llu (%.1f ms)\n", static_cast<unsigned long long>(frames), durationMs);
    std::printf("  peak/rms/dc %.4f / %.4f / %+.5f\n", peak, rms, dc);
    if (firstEnergy >= 0) {
        std::printf("  energy      first %lld, last %lld (lead-in %.1f ms, tail %.1f ms)\n",
                    static_cast<long long>(firstEnergy), static_cast<long long>(lastEnergy),
                    1000.0 * static_cast<double>(firstEnergy) / rate,
                    1000.0 * static_cast<double>(frames - lastEnergy - 1) / rate);
    } else {
        std::printf("  energy      none above -120 dBFS\n");
    }
    std::printf("  convolver   %d partitions x %d frames, ~%.0f complex FFTs/s\n",
                partitions, kPartitionFrames, fftPerSecond);

    bool ok = true;
    if (channels > kMaxChannels) { std::printf("  REJECT channels > %d\n", kMaxChannels); ok = false; }
    if (partitions > kMaxPartitions) {
        std::printf("  REJECT %d partitions > %d (limit is %.0f ms at this rate)\n", partitions,
                    kMaxPartitions, 1000.0 * kMaxPartitions * kPartitionFrames / rate);
        ok = false;
    }
    if (nonFinite > 0) {
        std::printf("  REJECT %llu non-finite samples\n", static_cast<unsigned long long>(nonFinite));
        ok = false;
    }
    if (peak <= 0.0) { std::printf("  REJECT all-silent IR\n"); ok = false; }
    std::printf("  verdict     %s\n", ok ? "loadable by a uniform-partition convolver"
                                          : "NOT loadable as-is");
}

} // namespace

int runIrProbe(int argc, char** argv) {
#if defined(_WIN32)
    // Paths are UTF-8 on the wire; without this the console renders a Chinese
    // path as mojibake and the report looks like it read the wrong file.
    ::SetConsoleOutputCP(CP_UTF8);
#endif
    int count = 0;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--probe-ir") == 0) continue;
        if (argv[i][0] == '-') continue;
        probeOne(argv[i]);
        count++;
    }
    if (count == 0) {
        std::printf("usage: twilight-engine --probe-ir <file.wav> [more files...]\n");
        return 2;
    }
    return 0;
}

} // namespace te
