// probe_format.cpp -- `--probe-format <file...> [--full] [--seek <ms>]`
//
// Opens each path through the PRODUCTION decoder path and reports what came back:
// the codec, the stream shape, the reported length, and -- when the open fails --
// the exact reason string. With --full it decodes to the end and compares the
// frames produced against the frames claimed; with --seek it checks that a seek
// lands where it was asked by comparing the samples it yields against a fresh
// sequential decode of the same region.
//
// Why this exists as a permanent diagnostic rather than a throwaway script:
// "this build cannot play this file" is the one answer a test suite cannot
// interrogate, because isDecodable() reduces every cause to a boolean plus a
// string only the caller sees. Every format this engine added -- MP3, MP4, and
// Ogg Vorbis / Ogg FLAC -- was debugged by guessing at that string.
//
// Why the sample checks are here rather than in a unit test: a decoder that
// OPENS successfully and returns silence, noise, or the wrong window of audio is
// indistinguishable from a working one by every metadata property. Only the
// samples say which it is, and only a comparison against an independent decode
// of the same region says whether a seek landed.
//
// No output device is touched: no WASAPI, no audio, no threading.
#include "audio_source.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>   // CommandLineToArgvW

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace te {
namespace {

struct SampleReport {
    uint64_t frames = 0;
    double   peak = 0.0;
    uint64_t nonZero = 0;
    uint64_t outOfRange = 0;
    bool     readError = false;
};

std::vector<float*> views(std::vector<std::vector<float>>& planes) {
    std::vector<float*> out;
    out.reserve(planes.size());
    for (auto& plane : planes) out.push_back(plane.data());
    return out;
}

SampleReport drainSource(AudioSource& source, uint64_t frames) {
    SampleReport report;
    if (source.channels() <= 0) return report;
    std::vector<std::vector<float>> planes(static_cast<size_t>(source.channels()));
    for (auto& plane : planes) plane.assign(static_cast<size_t>(frames), 0.0f);
    std::vector<float*> v = views(planes);

    uint64_t remaining = frames;
    while (remaining > 0) {
        const uint64_t got = source.readFrames(v.data(), remaining);
        if (got == 0) break;
        for (int ch = 0; ch < source.channels(); ++ch) {
            for (uint64_t i = 0; i < got; ++i) {
                const float s = planes[static_cast<size_t>(ch)][static_cast<size_t>(i)];
                if (!std::isfinite(s)) { ++report.outOfRange; continue; }
                const double a = std::fabs(static_cast<double>(s));
                if (a > report.peak) report.peak = a;
                if (s != 0.0f) ++report.nonZero;
                if (a > 1.0) ++report.outOfRange;
            }
        }
        report.frames += got;
        remaining -= got;
    }
    report.readError = source.hasError();
    return report;
}

// Reads exactly `frames` frames into planar scratch, returning what was produced.
// The plane count is sized from the source here rather than assumed: passing
// readFrames an array with fewer channels than the stream is an out-of-bounds
// write inside the decoder, not a diagnostic failure.
uint64_t readPlanar(AudioSource& source, std::vector<std::vector<float>>& planes, uint64_t frames) {
    if (source.channels() <= 0) return 0;
    planes.resize(static_cast<size_t>(source.channels()));
    for (auto& plane : planes) plane.assign(static_cast<size_t>(frames), 0.0f);
    std::vector<float*> v = views(planes);
    const uint64_t got = source.readFrames(v.data(), frames);
    for (auto& plane : planes) plane.resize(static_cast<size_t>(got));
    return got;
}

} // namespace

int runFormatProbe(int argc, char** argv) {
    int wargc = 0;
    wchar_t** wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    std::vector<std::string> paths;
    bool full = false;
    bool seekCheck = false;
    long long seekMs = 0;
    if (wargv) {
        for (int i = 2; i < wargc; ++i) {
            if (std::wcscmp(wargv[i], L"--full") == 0) { full = true; continue; }
            if (std::wcscmp(wargv[i], L"--seek") == 0 && i + 1 < wargc) {
                seekCheck = true;
                seekMs = std::wcstoll(wargv[++i], nullptr, 10);
                continue;
            }
            paths.push_back(toUtf8(std::filesystem::path(wargv[i])));
        }
        LocalFree(wargv);
    }
    (void)argc;
    (void)argv;

    if (paths.empty()) {
        std::fprintf(stderr,
                     "usage: twilight-engine --probe-format <file> [more files...] [--full] [--seek <ms>]\n");
        return 2;
    }

    int failures = 0;
    for (const std::string& path : paths) {
        const std::filesystem::path file = fromUtf8(path);
        std::string error;
        auto source = openAudioSource(file, error);
        if (!source) {
            std::printf("file=%s ok=0 error=%s\n", path.c_str(), error.c_str());
            ++failures;
            continue;
        }

        const uint64_t claimed = source->totalFrames();
        const int rate = source->sampleRate();
        SampleReport report;
        uint64_t decodedTotal = 0;
        if (full) {
            report = drainSource(*source, claimed + static_cast<uint64_t>(rate) * 60ull);
            decodedTotal = report.frames;
        } else {
            report = drainSource(*source, 1u << 16);
        }

        std::printf(
            "file=%s ok=1 rate=%d channels=%d bitDepth=%d frames=%llu lossless=%d "
            "decoded=%llu peak=%.6f nonZero=%llu outOfRange=%llu srcError=%d\n",
            path.c_str(), rate, source->channels(), source->bitDepth(),
            static_cast<unsigned long long>(claimed), source->lossless() ? 1 : 0,
            static_cast<unsigned long long>(report.frames), report.peak,
            static_cast<unsigned long long>(report.nonZero),
            static_cast<unsigned long long>(report.outOfRange),
            report.readError ? 1 : 0);

        if (full) {
            const bool exact = decodedTotal == claimed;
            std::printf("  full_decode produced=%llu claimed=%llu exact=%d\n",
                        static_cast<unsigned long long>(decodedTotal),
                        static_cast<unsigned long long>(claimed), exact ? 1 : 0);
            if (!exact) ++failures;
        }

        if (seekCheck && rate > 0) {
            // Ground truth: a FRESH open walked sequentially to the target. No
            // shared state, no resumed decoder -- the only thing that can say
            // where the audio really is.
            const uint64_t target = static_cast<uint64_t>(seekMs) *
                                    static_cast<uint64_t>(rate) / 1000ull;
            if (target >= claimed) {
                std::printf("  seek_check=skipped (target beyond the stream)\n");
            } else {
                constexpr uint64_t kWindow = 8192;
                std::vector<std::vector<float>> expected, actual;

                uint64_t referenceFrames = 0;
                {
                    std::string refError;
                    auto reference = openAudioSource(file, refError);
                    if (reference) {
                        std::vector<std::vector<float>> skip;
                        uint64_t skipped = 0;
                        while (skipped < target) {
                            const uint64_t want = std::min<uint64_t>(kWindow, target - skipped);
                            const uint64_t got = readPlanar(*reference, skip, want);
                            if (got == 0) break;
                            skipped += got;
                        }
                        referenceFrames = readPlanar(*reference, expected, kWindow);
                    }
                }

                uint64_t actualFrames = 0;
                const bool seeked = source->seekToFrame(target);
                if (seeked) actualFrames = readPlanar(*source, actual, kWindow);

                // Vorbis is an overlap-add codec: the block that straddles a
                // resumed page has no previous block to lap against, so the very
                // first block after a seek is not bit-identical by construction.
                // That is a property of the format, not of this reader, so the
                // comparison starts after one maximum-size block.
                constexpr uint64_t kLapping = 4096;
                uint64_t firstDiff = ~static_cast<uint64_t>(0);
                double maxDiff = 0.0;
                const uint64_t compare = std::min<uint64_t>(
                    std::min<uint64_t>(referenceFrames, actualFrames), kWindow);
                if (compare > kLapping) {
                    for (int ch = 0; ch < source->channels(); ++ch) {
                        for (uint64_t i = kLapping; i < compare; ++i) {
                            const double a = expected[static_cast<size_t>(ch)][static_cast<size_t>(i)];
                            const double b = actual[static_cast<size_t>(ch)][static_cast<size_t>(i)];
                            const double d = std::fabs(a - b);
                            if (d > maxDiff) maxDiff = d;
                            if (d > 1e-5 && firstDiff == ~static_cast<uint64_t>(0)) firstDiff = i;
                        }
                    }
                }
                const bool matched = (compare > kLapping) && (maxDiff <= 1e-5);
                std::printf(
                    "  seek_ms=%lld target_frame=%llu seeked=%d ref_frames=%llu got_frames=%llu "
                    "compared=%llu firstDiff=%lld maxDiff=%.9f matched=%d\n",
                    seekMs, static_cast<unsigned long long>(target), seeked ? 1 : 0,
                    static_cast<unsigned long long>(referenceFrames),
                    static_cast<unsigned long long>(actualFrames),
                    static_cast<unsigned long long>(compare),
                    firstDiff == ~static_cast<uint64_t>(0) ? -1 : static_cast<long long>(firstDiff),
                    maxDiff, matched ? 1 : 0);
                if (!matched) ++failures;
            }
        }
    }
    return failures == 0 ? 0 : 1;
}

} // namespace te
