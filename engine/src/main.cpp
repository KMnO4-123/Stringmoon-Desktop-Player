// twilight-engine - entry point.
//
// CONTRACT 3.1: this process is the sole audio authority and speaks JSON Lines
// over stdin/stdout. Nothing in this file may write to stdout except through
// te::Io::emit.

#include <windows.h>
#include <dbghelp.h>

#include <cstdio>
#include <cstring>
#include <string>

#include "app.hpp"
#include "io.hpp"
#include "crash_attribution.hpp"
#include "protocol.hpp"

namespace te {
int runExclusiveProbe();
int runMediaFoundationProbe(int argc, char** argv);
int runDecodeVerification(int argc, char** argv);
int runReaderProbe();
int runMediaVerification();
int runSpectrumProbe(int argc, char** argv);
int runResample(int argc, char** argv);
int runFormatProbe(int argc, char** argv);
int runIrProbe(int argc, char** argv);
int runTransportProbe(int argc, char** argv);
int runSpatialProbe(int argc, char** argv);
} // namespace te

#pragma comment(lib, "dbghelp.lib")

namespace te {

// Storage for crash_attribution.hpp. The render thread writes it; the filter
// below reads it.
volatile unsigned long g_renderThreadId = 0;

void publishRenderThreadId(unsigned long id) {
    g_renderThreadId = id;
}

} // namespace te

namespace {

// A crash in the engine must leave evidence, not just a silent disappearance:
// the app only sees the process go away, and "ERR_DEVICE or a decode bug?" is
// not answerable from the outside. This filter writes a minidump next to the
// executable and, when the render thread was live, names the exact call it was
// inside (compiled in only with TE_RT_TRACE).
te::App* g_app = nullptr;

LONG WINAPI crashFilter(EXCEPTION_POINTERS* info) {
    const DWORD code = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0;
    std::fprintf(stderr, "\n[fatal] unhandled exception 0x%08lX at %p\n", code,
                 info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionAddress : nullptr);

    // WHICH MODULE, not just the exe's base.
    //
    // The previous version printed the executable's load address and told the
    // reader to subtract it. That is only valid advice when the fault IS in the
    // executable -- and the very first crash this was used on had a faulting
    // address roughly 2.8 GB away from it, so the subtraction produced a
    // meaningless RVA and the map lookup would have found nothing. A diagnostic
    // that quietly misdirects is worse than one that says less.
    //
    // Resolve the containing module directly, and the symbol when the module is
    // ours (the linker map and any available PDB live beside the exe).
    const void* faultAddress = (info && info->ExceptionRecord)
        ? info->ExceptionRecord->ExceptionAddress : nullptr;
    {
        HMODULE owner = nullptr;
        char modulePath[MAX_PATH] = {0};
        if (faultAddress && ::GetModuleHandleExA(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                static_cast<LPCSTR>(faultAddress), &owner) && owner &&
            ::GetModuleFileNameA(owner, modulePath, MAX_PATH) > 0) {
            const std::string full(modulePath);
            const size_t slash = full.find_last_of("\\/");
            const std::string leaf = (slash == std::string::npos) ? full : full.substr(slash + 1);
            const HMODULE self = ::GetModuleHandleA(nullptr);
            std::fprintf(stderr, "[fatal] faulting module: %s%s\n", leaf.c_str(),
                         (owner == self) ? "  (this executable)" : "  (NOT our code)");
            if (owner == self) {
                std::fprintf(stderr, "[fatal] rva in module:  0x%llX (look this up in twilight-engine.map)\n",
                             static_cast<unsigned long long>(
                                 reinterpret_cast<const char*>(faultAddress) -
                                 reinterpret_cast<const char*>(self)));
            } else {
                std::fprintf(stderr, "[fatal] rva in module:  0x%llX (in %s, not resolvable from our map)\n",
                             static_cast<unsigned long long>(
                                 reinterpret_cast<const char*>(faultAddress) -
                                 reinterpret_cast<const char*>(owner)),
                             leaf.c_str());
            }
        } else {
            std::fprintf(stderr, "[fatal] faulting module: unknown (address not inside any loaded module)\n");
        }
    }

    const unsigned long crashing = ::GetCurrentThreadId();
    std::fprintf(stderr, "[fatal] thread %lu (render thread %lu) -> %s\n",
                 crashing, te::renderThreadId(),
                 (crashing == te::renderThreadId()) ? "RENDER" : "NOT the render thread");
    if (g_app) {
        std::fprintf(stderr, "[fatal] render stage: %s\n", g_app->renderStageDescription());
    }

    // Dump next to the exe so the path is predictable from the driver script.
    char exePath[MAX_PATH] = {0};
    ::GetModuleFileNameA(nullptr, exePath, MAX_PATH);
    std::string dir(exePath);
    const size_t slash = dir.find_last_of("\\/");
    dir = (slash == std::string::npos) ? std::string(".") : dir.substr(0, slash);

    const std::string dumpPath = dir + "\\twilight-engine-crash.dmp";
    HANDLE file = ::CreateFileA(dumpPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) {
        MINIDUMP_EXCEPTION_INFORMATION params{};
        params.ThreadId          = ::GetCurrentThreadId();
        params.ExceptionPointers = info;
        params.ClientPointers    = FALSE;
        const MINIDUMP_TYPE type = static_cast<MINIDUMP_TYPE>(
            MiniDumpWithDataSegs | MiniDumpWithHandleData | MiniDumpWithThreadInfo);
        if (::MiniDumpWriteDump(::GetCurrentProcess(), ::GetCurrentProcessId(), file, type,
                                &params, nullptr, nullptr)) {
            std::fprintf(stderr, "[fatal] minidump: %s\n", dumpPath.c_str());
        } else {
            std::fprintf(stderr, "[fatal] minidump write failed (%lu)\n", ::GetLastError());
        }
        ::CloseHandle(file);
    }
    std::fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;
}

} // namespace

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--selftest") == 0) {
            return te::App::selfTest();
        }
        // A diagnostic for a user whose exclusive output is silent: it reports,
        // per format and per buffer period, whether the device actually raises
        // its buffer event -- the one fact no other layer of the engine can see.
        if (std::strcmp(argv[i], "--probe-exclusive") == 0) {
            return te::runExclusiveProbe();
        }
        // What Media Foundation can decode HERE, for the MP4 (AAC / ALAC) work.
        // "Windows has an AAC decoder" is a claim about a platform; this reports
        // the machine. --write-tone also produces a real .m4a, because there is
        // none on this machine and a format path without material is a format
        // path nobody has verified.
        if (std::strcmp(argv[i], "--probe-mf") == 0) {
            return te::runMediaFoundationProbe(argc, argv);
        }
        // Does the file-handle decode path produce the same SAMPLES as the
        // whole-file path? Property checks cannot see this; see the header.
        if (std::strcmp(argv[i], "--probe-decode") == 0) {
            return te::runDecodeVerification(argc, argv);
        }
        // Observe the production dr_flac read/seek/tell pattern without
        // opening WASAPI. The result sizes the HTTP reader's prefetch window.
        if (std::strcmp(argv[i], "--probe-io") == 0) {
            return te::runReaderProbe();
        }
        if (std::strcmp(argv[i], "--verify-media") == 0) {
            return te::runMediaVerification();
        }
        // How far up does the SIGNAL go? A FLAC transcoded from a lossy file is
        // a valid FLAC and still sounds muddy; see probe_spectrum.cpp.
        if (std::strcmp(argv[i], "--probe-spectrum") == 0) {
            return te::runSpectrumProbe(argc, argv);
        }
        // Same music at a different FEED RATE, through the engine's own
        // resampler, so a DAC's preference for 48/96 over 44.1 can be tested.
        if (std::strcmp(argv[i], "--probe-resample") == 0) {
            return te::runResample(argc, argv);
        }
        // What did the PRODUCTION decoder path make of this file? Prints the exact
        // open or refusal reason, the stream shape and the decoded samples, so a
        // "this build supports X" claim can be checked instead of asserted.
        if (std::strcmp(argv[i], "--probe-ir") == 0) {
            return te::runIrProbe(argc, argv);
        }
        if (std::strcmp(argv[i], "--probe-format") == 0) {
            return te::runFormatProbe(argc, argv);
        }
        // V3 §1.1 / verifier：没有 loopback、设备被占用时的离线传输证据。
        if (std::strcmp(argv[i], "--probe-transport") == 0) {
            return te::runTransportProbe(argc, argv);
        }
        // CR-029：空间音频的离线测试面（24 方位 HRIR / ITD / ILD / 能量 / 卷积延迟 /
        // 复位无尾），不打开设备，供 verifier 独立复算。
        if (std::strcmp(argv[i], "--probe-spatial") == 0) {
            return te::runSpatialProbe(argc, argv);
        }
        if (std::strcmp(argv[i], "--version") == 0) {
            std::string line = "twilight-engine ";
            line += te::kEngineVersion;
            line += '\n';
            std::fputs(line.c_str(), stderr);
            return 0;
        }
        if (std::strcmp(argv[i], "--help") == 0) {
            std::fprintf(stderr,
                "twilight-engine - Twilight Echo audio engine (JSON Lines over stdio)\n"
                "  --selftest   run protocol codec checks and exit\n"
                "  --probe-mf   list Media Foundation audio codecs; --probe-mf --write-tone <x.m4a>\n"
                "  --version    print version and exit\n"
                "  --help       print this text and exit\n"
                "With no arguments the engine starts and immediately emits its ready event.\n");
            return 0;
        }
    }

    ::SetUnhandledExceptionFilter(&crashFilter);

    te::Io io;
    te::App app(io);
    g_app = &app;
    return app.run();
}
