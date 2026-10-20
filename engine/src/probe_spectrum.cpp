// probe_spectrum.cpp -- `--probe-spectrum <dir>`
//
// Is the SOURCE actually lossless?
//
// A FLAC that was transcoded from a lossy file is indistinguishable by
// container: it is a real FLAC, it decodes bit-exactly, `sourceExact` is
// honestly true, and it still sounds muddy with a flat soundstage -- because
// everything above the encoder's cutoff is gone and the coder's own artefacts
// are baked in. No player can restore it, so when a listener reports exactly
// those symptoms the file is the first thing that has to be ruled out.
//
// The signature is a SHARP low-pass edge. Average a few windows through the
// middle of the track, find the highest frequency still carrying energy, and
// compare it with the Nyquist limit of the file's own sample rate:
//
//   ~22.0 kHz on a 44.1 kHz file  -> the full band is present
//   <=20 kHz, with a steep edge   -> consistent with a lossy source
//
// This reports EVIDENCE, not a verdict about provenance: a genuinely
// band-limited recording (old analogue masters, some classical releases) also
// stops early, and this check cannot tell those apart. It is a triage tool.
#include "audio_source.hpp"
#include "util.hpp"

#include <kiss_fftr.h>

#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

namespace te {
namespace {

constexpr int kFftSize   = 8192;   // ~186 ms at 44.1 kHz
constexpr int kWindows   = 24;     // averaged across the middle of the track
constexpr float kFloorDb = -75.0f; // where the spectrum is called empty

} // namespace

int runSpectrumProbe(int argc, char** argv) {
    (void)argc; (void)argv;

    std::filesystem::path dir;
    {
        int wargc = 0;
        LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
        if (wargv) {
            for (int i = 1; i < wargc; ++i) {
                const std::wstring a(wargv[i]);
                if (a == L"--probe-spectrum" || a.rfind(L"--", 0) == 0) continue;
                dir = a; break;
            }
            LocalFree(wargv);
        }
    }
    if (dir.empty()) { std::printf("usage: twilight-engine --probe-spectrum <directory>\n"); return 2; }

    std::error_code ec;
    std::vector<std::filesystem::path> files;
    for (std::filesystem::recursive_directory_iterator it(dir, ec), end; it != end; it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        if (!it->is_regular_file(ec)) continue;
        std::wstring ext = it->path().extension().wstring();
        std::transform(ext.begin(), ext.end(), ext.begin(), ::towlower);
        if (ext == L".flac") files.push_back(it->path());
    }
    std::sort(files.begin(), files.end());
    if (files.empty()) { std::printf("no FLAC found under %s\n", toUtf8(dir).c_str()); return 1; }

    kiss_fftr_cfg cfg = kiss_fftr_alloc(kFftSize, 0, nullptr, nullptr);
    if (!cfg) { std::printf("kiss_fftr_alloc failed\n"); return 1; }

    std::vector<float> window(kFftSize), frame(kFftSize);
    std::vector<kiss_fft_cpx> spec(static_cast<size_t>(kFftSize / 2 + 1));
    for (int i = 0; i < kFftSize; ++i)
        window[i] = 0.5f * (1.0f - std::cos(2.0f * 3.14159265358979f * i / (kFftSize - 1)));

    std::printf("spectral extent (is the source actually full-band?)\n");
    std::printf("  dir   : %s\n", toUtf8(dir).c_str());
    std::printf("  files : %zu\n\n", files.size());
    std::printf("  %-46s %7s %9s  %s\n", "file", "rate", "edge", "reading");

    int bandLimited = 0;
    std::vector<std::string> suspects;
    for (const auto& f : files) {
        std::string error;
        auto src = openAudioSource(f, error);
        if (!src) { std::printf("  %-46s  OPEN FAILED: %s\n", toUtf8(f.filename()).substr(0,46).c_str(), error.c_str()); continue; }
        const int rate = src->sampleRate();
        const int ch   = src->channels();
        const uint64_t total = src->totalFrames();
        if (rate <= 0 || ch < 1 || total < static_cast<uint64_t>(kFftSize) * 4) { std::printf("  %-46s  too short\n", toUtf8(f.filename()).substr(0,46).c_str()); continue; }

        // The middle third, where a track is least likely to be fading in or out.
        const uint64_t lo = total / 3;
        const uint64_t span = total / 3;
        std::vector<float*> planar(static_cast<size_t>(ch));
        std::vector<std::vector<float>> store(static_cast<size_t>(ch), std::vector<float>(kFftSize));
        for (int c = 0; c < ch; ++c) planar[c] = store[c].data();

        std::vector<double> acc(static_cast<size_t>(kFftSize / 2 + 1), 0.0);
        int used = 0;
        for (int w = 0; w < kWindows; ++w) {
            const uint64_t at = lo + (span * static_cast<uint64_t>(w)) / static_cast<uint64_t>(kWindows);
            if (at + kFftSize > total) break;
            if (!src->seekToFrame(at)) break;
            if (src->readFrames(planar.data(), kFftSize) < static_cast<uint64_t>(kFftSize)) break;
            // Channel 0 only: a lossy encoder's cutoff is per-channel and mixing
            // to mono would only add the other channel's noise floor.
            for (int i = 0; i < kFftSize; ++i) frame[i] = store[0][i] * window[i];
            kiss_fftr(cfg, frame.data(), spec.data());
            for (int b = 0; b <= kFftSize / 2; ++b) {
                const double re = spec[b].r, im = spec[b].i;
                acc[b] += re * re + im * im;
            }
            ++used;
        }
        if (used == 0) { std::printf("  %-46s  read failed\n", toUtf8(f.filename()).substr(0,46).c_str()); continue; }

        const double binsPerHz = static_cast<double>(kFftSize) / rate;
        int peakBin = 0; double peak = 0.0;
        for (int b = 1; b <= kFftSize / 2; ++b) if (acc[b] > peak) { peak = acc[b]; peakBin = b; }
        // Smooth over ~200 Hz so a single notch does not define the edge.
        const int half = std::max(1, static_cast<int>(100.0 * binsPerHz));
        int edgeBin = 0;
        for (int b = kFftSize / 2; b > peakBin; --b) {
            double sum = 0.0; int n = 0;
            for (int k = std::max(1, b - half); k <= std::min(kFftSize / 2, b + half); ++k) { sum += acc[k]; ++n; }
            const double db = 10.0 * std::log10((sum / n) / peak + 1e-30);
            if (db > kFloorDb) { edgeBin = b; break; }
        }
        const double edgeHz = edgeBin / binsPerHz;
        const double nyquist = rate / 2.0;
        const bool narrow = edgeHz < nyquist * 0.95;
        if (narrow) { ++bandLimited; suspects.push_back(toUtf8(f.filename()) + "  edge " + std::to_string(static_cast<int>(edgeHz)) + " Hz"); }

        std::string reading = narrow ? "NARROW -- consistent with a lossy source" : "full band";
        if (narrow && edgeHz > nyquist * 0.85) reading = "slightly narrow";
        std::printf("  %-46s %6d  %6d Hz  %s\n",
                    toUtf8(f.filename()).substr(0,46).c_str(), rate,
                    static_cast<int>(edgeHz), reading.c_str());
    }
    kiss_fftr_free(cfg);

    std::printf("\n  %d of %zu files stop below 95%% of their own Nyquist\n", bandLimited, files.size());
    if (!suspects.empty()) {
        std::printf("  worth a listen / a second look:\n");
        for (const auto& s : suspects) std::printf("    %s\n", s.c_str());
    }
    std::printf("  NOTE: a genuinely band-limited master also reads narrow. This is\n");
    std::printf("        triage evidence, not a provenance claim.\n");
    return 0;
}

} // namespace te