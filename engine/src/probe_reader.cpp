// --probe-io: observe the production dr_flac callback contract without opening
// an audio device. This is intentionally a separate diagnostic executable mode:
// its stdout is a report, while the normal engine remains JSON Lines only.

#include "audio_source.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

namespace te {

// Compares independent local and HTTP inputs through the SAME interface that
// the decoders use, then compares the production planar samples. Never WASAPI.
int runMediaVerification() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<std::filesystem::path> paths;
    bool bytesOnly = false, cacheOnly = false, decodeOnly = false;
    for (int i = 1; argv && i < argc; ++i) {
        const std::wstring arg(argv[i]);
        if (arg == L"--bytes-only") bytesOnly = true;
        else if (arg == L"--cache-only") cacheOnly = true;
        else if (arg == L"--decode-only") decodeOnly = true;
        else if (!arg.starts_with(L"--")) paths.emplace_back(arg);
    }
    if (argv) LocalFree(argv);
    if (paths.size() != 2) {
        std::printf("usage: --verify-media <local-file> <url> [--bytes-only|--cache-only|--decode-only]\n");
        return 2;
    }
    std::string error;
    auto fail = [&](const std::string& reason) { std::printf("media verification failed: %s\n", reason.c_str()); return 1; };
    uint64_t bytesChecked = 0, framesChecked = 0;
    if (!decodeOnly) {
        MediaReader local, remote;
        if (!local.open(paths[0])) return fail(local.errorMessage());
        if (!remote.open(paths[1])) return fail(remote.errorMessage());
        if (local.size() != remote.size()) return fail("byte lengths differ");
        std::vector<uint8_t> a(3 * MediaReader::kHttpWindowBytes + 71), b(a.size());
        auto compare = [&](size_t count) {
            const auto ga = local.read(a.data(), count), gb = remote.read(b.data(), count);
            if (local.hasError() || remote.hasError()) {
                error = local.hasError() ? local.errorMessage() : remote.errorMessage();
                return false;
            }
            if (ga != gb || std::memcmp(a.data(), b.data(), ga) != 0 || local.tell() != remote.tell()) {
                error = "byte contents or positions differ";
                return false;
            }
            bytesChecked += ga;
            return true;
        };
        auto seek = [&](int64_t offset, int origin) {
            const auto x = local.seek(offset, origin), y = remote.seek(offset, origin);
            return x && y && local.tell() == remote.tell();
        };
        if (cacheOnly) {
            // Server independently asserts that all these reads cost ONE GET.
            for (int i = 0; i < 12; ++i) {
                if (!seek(i * 23, 0) || !compare(97)) return fail(error.empty() ? "cache seek failed" : error);
            }
        } else {
            while (static_cast<uint64_t>(local.tell()) < local.size())
                if (!compare(a.size())) return fail(error);
            if (!compare(64)) return fail(error); // clean EOF is distinct from error
            uint64_t random = 0x617564696full;
            for (int i = 0; i < 32; ++i) {
                random = random * 6364136223846793005ull + 1;
                const auto target = random % local.size();
                if (!seek(static_cast<int64_t>(target), 0) || !compare(4097)) return fail(error.empty() ? "random seek failed" : error);
                if (!seek(-static_cast<int64_t>(std::min<uint64_t>(31, target)), 1) || !compare(37)) return fail("relative seek differs");
            }
            const auto tail = std::min<uint64_t>(64, local.size());
            if (!seek(-static_cast<int64_t>(tail), 2) || !compare(128)) return fail("end-relative read differs");
            const auto cursor = remote.tell();
            if (remote.seek(1, 2) || remote.tell() != cursor || remote.hasError()) return fail("invalid seek changed reader state");
        }
    }
    if (!bytesOnly && !cacheOnly) {
        auto local = openAudioSource(paths[0], error);
        if (!local) return fail(error);
        auto remote = openAudioSource(paths[1], error);
        if (!remote) return fail(error);
        const int channels = local->channels();
        if (channels < 1 || channels > 8 || channels != remote->channels() ||
            local->sampleRate() != remote->sampleRate() || local->totalFrames() != remote->totalFrames() ||
            local->bitDepth() != remote->bitDepth() || local->lossless() != remote->lossless()) return fail("decoded stream identities differ");
        constexpr size_t chunk = 8192;
        std::vector<std::vector<float>> a(channels, std::vector<float>(chunk)), b(a);
        std::vector<float*> av(channels), bv(channels);
        for (int ch = 0; ch < channels; ++ch) { av[ch] = a[ch].data(); bv[ch] = b[ch].data(); }
        auto compare = [&]() {
            const auto ga = local->readFrames(av.data(), chunk), gb = remote->readFrames(bv.data(), chunk);
            if (local->hasError() || remote->hasError()) { error = local->hasError() ? local->errorMessage() : remote->errorMessage(); return false; }
            if (ga != gb) { error = "decoded lengths differ"; return false; }
            for (int ch = 0; ch < channels; ++ch) if (std::memcmp(av[ch], bv[ch], ga * sizeof(float)) != 0) { error = "decoded samples differ"; return false; }
            framesChecked += ga;
            return true;
        };
        for (;;) {
            const auto before = framesChecked;
            if (!compare()) return fail(error);
            if (framesChecked == before) break;
        }
        for (uint64_t fraction : {1ull, 3ull, 5ull}) {
            const auto frame = local->totalFrames() * fraction / 7;
            const bool x = local->seekToFrame(frame), y = remote->seekToFrame(frame);
            if (local->hasError() || remote->hasError() || x != y) return fail("decoded seek differs or failed transport");
            if (x && !compare()) return fail(error);
        }
        if (framesChecked == 0) return fail("no decoded frames");
    }
    std::printf("media verification PASS: %llu bytes, %llu production frames\n",
        static_cast<unsigned long long>(bytesChecked), static_cast<unsigned long long>(framesChecked));
    return 0;
}

int runReaderProbe() {
    std::filesystem::path file;
    int wargc = 0;
    LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv) {
        for (int i = 1; i < wargc; ++i) {
            const std::wstring arg(wargv[i]);
            if (arg == L"--probe-io" || arg.rfind(L"--", 0) == 0) continue;
            file = arg;
            break;
        }
        LocalFree(wargv);
    }

    if (file.empty()) {
        std::printf("usage: twilight-engine --probe-io <flac-file>\n");
        return 2;
    }
    const std::string target = toUtf8(file);
    const std::string lower = toLowerAscii(target);
    const bool url = lower.rfind("http://", 0) == 0 || lower.rfind("https://", 0) == 0;
    std::error_code ec;
    if (!url && !std::filesystem::is_regular_file(file, ec)) {
        std::printf("not a file: %s\n", toUtf8(file).c_str());
        return 2;
    }

    ReaderTrace trace;
    std::string error;
    if (!traceFlacReader(file, trace, error)) {
        std::printf("reader probe failed: %s\n", error.c_str());
        return 1;
    }

    std::map<size_t, uint64_t> histogram;
    for (const size_t request : trace.readRequestSizes) ++histogram[request];

    std::printf("dr_flac reader trace\n");
    std::printf("  file             : %s\n", toUtf8(file).c_str());
    std::printf("  read calls       : %llu\n", static_cast<unsigned long long>(trace.readCalls));
    std::printf("  seek calls       : %llu\n", static_cast<unsigned long long>(trace.seekCalls));
    std::printf("  tell calls       : %llu\n", static_cast<unsigned long long>(trace.tellCalls));
    std::printf("  bytes requested  : %llu\n", static_cast<unsigned long long>(trace.bytesRequested));
    std::printf("  bytes returned   : %llu\n", static_cast<unsigned long long>(trace.bytesReturned));
    std::printf("  short reads      : %llu\n", static_cast<unsigned long long>(trace.shortReads));
    std::printf("  max request     : %zu\n", trace.maxReadRequest);
    std::printf("  sizes (first %zu reads):", trace.readRequestSizes.size());
    for (const auto& [size, count] : histogram) {
        std::printf(" %zu(%llu)", size, static_cast<unsigned long long>(count));
    }
    std::printf("\n");
    std::printf("  first sequence   :");
    const size_t sequenceCount = std::min<size_t>(trace.readRequestSizes.size(), 64);
    for (size_t i = 0; i < sequenceCount; ++i) {
        std::printf(" %zu/%zu", trace.readRequestSizes[i], trace.readReturnSizes[i]);
    }
    if (trace.readRequestSizes.size() > sequenceCount) std::printf(" ...");
    std::printf("\n");

    // A real file should not produce a short read before EOF. The final short
    // callback is legal and is exactly how dr_libs learns that the byte stream
    // ended; the probe reports it rather than treating it as an implementation
    // failure.
    return trace.readCalls > 0 && trace.bytesReturned > 0 ? 0 : 1;
}

} // namespace te
