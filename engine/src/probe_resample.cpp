// probe_resample.cpp -- `--probe-resample <in> <out.wav> <targetRate>`
//
// Writes a rate-converted copy of a file using the ENGINE'S OWN resampler at the
// engine's own quality (SoXR VHQ as of CR-021, the same call the shared-mode path makes).
//
// Why this exists: the owner reports that other players sound better on the same
// track, headphones and DAC, while this engine's exclusive path is verified
// bit-exact at every link. One variable is left that software CAN change: other
// players hand the device 48 kHz through the mixer, while this engine hands it
// the SOURCE rate -- 44.1 kHz -- because that is what bit-perfect means. Some USB
// DACs treat 44.1 kHz worse than 48/96 kHz internally, which would sound exactly
// like a flattened image and is invisible to every software check.
//
// To test that fairly the material has to be the SAME MUSIC at two feed rates, so
// this produces the other half of the comparison rather than relying on a second
// song.
#include "audio_source.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace te {
namespace {

void put16(std::FILE* f, uint16_t v) { std::fputc(v & 0xFF, f); std::fputc((v >> 8) & 0xFF, f); }
void put32(std::FILE* f, uint32_t v) {
    for (int i = 0; i < 4; ++i) std::fputc((v >> (8 * i)) & 0xFF, f);
}
void patch32(std::FILE* f, long at, uint32_t v) {
    const long here = std::ftell(f);
    std::fseek(f, at, SEEK_SET);
    put32(f, v);
    std::fseek(f, here, SEEK_SET);
}

} // namespace

int runResample(int argc, char** argv) {
    (void)argc; (void)argv;
    std::vector<std::wstring> pos;
    {
        int wargc = 0;
        LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
        if (wargv) {
            for (int i = 1; i < wargc; ++i) {
                const std::wstring a(wargv[i]);
                if (a.rfind(L"--", 0) == 0) continue;
                pos.push_back(a);
            }
            LocalFree(wargv);
        }
    }
    if (pos.size() < 3) {
        std::printf("usage: twilight-engine --probe-resample <in> <out.wav> <targetRate>\n");
        return 2;
    }
    const std::filesystem::path in(pos[0]);
    const std::filesystem::path out(pos[1]);
    const int target = std::stoi(pos[2]);

    std::string error;
    auto source = openAudioSource(in, error);
    if (!source) { std::printf("open failed: %s\n", error.c_str()); return 1; }

    const int srcRate  = source->sampleRate();
    const int channels = source->channels();
    Resampler resampler;
    if (!resampler.configure(source.get(), srcRate, target, channels, error)) {
        std::printf("configure failed: %s\n", error.c_str());
        return 1;
    }

    std::FILE* f = ::_wfopen(out.wstring().c_str(), L"wb");
    if (!f) { std::printf("cannot write %s\n", toUtf8(out).c_str()); return 1; }

    // Match the SOURCE's bit depth unless asked otherwise. A rate comparison
    // that silently also changes the container depth is not a rate comparison:
    // a 16-bit master turned into a 24-bit file hands the DAC a different
    // format AND a different rate, and then neither variable is isolated.
    int bits = source->bitDepth() == 16 ? 16 : 24;
    if (pos.size() >= 4) {
        const int want = std::stoi(pos[3]);
        if (want == 16 || want == 24 || want == 32) bits = want;
    }
    const int bytesPer = bits / 8;
    const uint32_t blockAlign = static_cast<uint32_t>(channels * bytesPer);
    std::fwrite("RIFF", 1, 4, f); put32(f, 0); std::fwrite("WAVE", 1, 4, f);
    std::fwrite("fmt ", 1, 4, f); put32(f, 16); put16(f, 1); put16(f, static_cast<uint16_t>(channels));
    put32(f, static_cast<uint32_t>(target)); put32(f, static_cast<uint32_t>(target) * blockAlign);
    put16(f, static_cast<uint16_t>(blockAlign)); put16(f, static_cast<uint16_t>(bits));
    std::fwrite("data", 1, 4, f); const long sizeAt = std::ftell(f); put32(f, 0);
    const long dataAt = std::ftell(f);

    const uint64_t kChunk = 8192;
    std::vector<std::vector<float>> store(static_cast<size_t>(channels), std::vector<float>(kChunk));
    std::vector<float*> planes(static_cast<size_t>(channels));
    for (int c = 0; c < channels; ++c) planes[c] = store[c].data();
    std::vector<uint8_t> bytes;
    uint64_t written = 0;
    for (;;) {
        const uint64_t got = resampler.pull(planes.data(), kChunk);
        if (got == 0) break;
        bytes.resize(static_cast<size_t>(got) * blockAlign);
        size_t at = 0;
        for (uint64_t n = 0; n < got; ++n) {
            for (int c = 0; c < channels; ++c) {
                const float x = planes[c][n];
                const double full = (bits == 16) ? 32767.0 : 8388607.0;
                double s = x * full;
                if (s >  full) s =  full;
                if (s < -(full + 1.0)) s = -(full + 1.0);
                const int32_t v = static_cast<int32_t>(std::lround(s));
                for (int k = 0; k < bytesPer; ++k) bytes[at++] = static_cast<uint8_t>((v >> (8 * k)) & 0xFF);
            }
        }
        std::fwrite(bytes.data(), 1, bytes.size(), f);
        written += got;
    }
    const uint32_t dataBytes = static_cast<uint32_t>(written * blockAlign);
    const long end = std::ftell(f);
    patch32(f, sizeAt, dataBytes);
    patch32(f, 4, static_cast<uint32_t>(end - 8));
    std::fclose(f);

    const double seconds = target > 0 ? static_cast<double>(written) / target : 0.0;
    std::printf("resampled %s\n  %d Hz -> %d Hz, %d ch, SoXR (engine quality)\n"
                "  wrote %s  %llu frames  %.1f s\n",
                toUtf8(in.filename()).c_str(), srcRate, target, channels,
                toUtf8(out.filename()).c_str(),
                static_cast<unsigned long long>(written), seconds);
    return 0;
}

} // namespace te