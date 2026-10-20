// probe_decode.cpp -- `--probe-decode [path...]`
//
// 两个互不相干的诊断，放在同一个入口是因为它们回答同一个问题：「这个引擎
// 到底能解什么」。
//
// 1) 解码能力矩阵（CR-032）：把引擎自报的 decoders[] 原样打印出来，包括每项
//    本机是否真的可用。这是 UI 卡片的唯一真相来源——界面不该自己维护扩展名表。
//
// 2) 逐文件解码报告：用 PRODUCTION 路径（openAudioSource）打开每个文件，打印
//    采样率/声道/位深/帧数/lossless/**谁解的**，失败时打印真实原因。这样
//    「这个格式支持吗」可以用一条命令验证，而不是读代码猜。
//
// 历史包袱：给定目录时仍然做 FLAC 的「文件句柄路径 vs 整文件内存路径逐样本
// 比对」。那是这个探针最早的功能，rate-ab.mjs 依赖它，所以保留原样；新增的
// 能力矩阵与逐文件报告只是加在前面，不改变目录模式的结论。
//
// 为什么不把这些挪到一个新命令：`--probe-decode` 已经是文档与脚本里的名字，
// 再加一个 `--probe-decoders` 只会让"该跑哪个"多一次猜测。
#include "audio_source.hpp"
#include "mf_source.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>   // CommandLineToArgvW

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

namespace te {
namespace {

// 能力矩阵。kind 顺序 native → system → dsd，与 dekoderCapabilities() 一致。
void printCapabilities() {
    std::printf("decoder capabilities (CR-032)\n");
    std::printf("  %-8s %-18s %-8s %-9s %s\n", "ext", "label", "kind", "lossless", "available");
    for (const auto& capability : decoderCapabilities()) {
        std::printf("  %-8s %-18s %-8s %-9s %s\n",
                    capability.ext.c_str(), capability.label.c_str(),
                    decoderKindName(capability.kind),
                    capability.lossless ? "yes" : "no",
                    capability.available ? "yes" : "NO");
    }
    std::printf("  system decoder runtime (Media Foundation): %s\n\n",
                mediaFoundationAvailable() ? "started" : "not started");
}

// 一个文件的解码报告。走的是和播放完全相同的打开路径。
void reportFile(const std::filesystem::path& file) {
    std::string error;
    auto source = openAudioSource(file, error);
    if (!source) {
        std::printf("file=%s ok=0 error=%s\n", toUtf8(file).c_str(), error.c_str());
        return;
    }
    std::printf("file=%s ok=1 decoder=%s rate=%d channels=%d bitDepth=%d frames=%llu lossless=%d\n",
                toUtf8(file).c_str(), source->decoderName(),
                source->sampleRate(), source->channels(), source->bitDepth(),
                static_cast<unsigned long long>(source->totalFrames()),
                source->lossless() ? 1 : 0);
}

} // namespace

// 目录模式：FLAC 逐样本比对（既有行为，rate-ab.mjs 依赖）。
int runDecodeVerification(int argc, char** argv);

} // namespace te

namespace te {

int runDecodeVerification(int argc, char** argv) {
    (void)argc;
    (void)argv;

    // 路径来自 WIDE 命令行，不来自 argv：argv 是 ANSI 代码页，而测试素材坐在
    // 含中文的目录下。这个坑 probe_mf.cpp 的注释里已经详细记过一次。
    std::vector<std::filesystem::path> targets;
    {
        int wargc = 0;
        LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
        if (wargv) {
            for (int i = 1; i < wargc; ++i) {
                const std::wstring a(wargv[i]);
                if (a.rfind(L"--", 0) == 0) continue;
                targets.emplace_back(a);
            }
            LocalFree(wargv);
        }
    }

    // 能力矩阵永远先打印：一条命令就能回答"支持哪些格式"。旧脚本只读目录模式
    // 的结论，多出来的表头不影响它们。
    printCapabilities();

    if (targets.empty()) {
        // 没有路径 = 只看能力矩阵，退出码 0。这比"打印 usage 再返回 2"有用：
        // UI 侧与验证者都需要一个"只问能力"的调用方式。
        return 0;
    }

    int failures = 0;
    for (const auto& target : targets) {
        std::error_code ec;
        if (std::filesystem::is_directory(target, ec) && !ec) {
            // ---- 目录模式（既有语义）------------------------------------
            std::vector<std::filesystem::path> files;
            for (std::filesystem::recursive_directory_iterator it(target, ec), end; it != end;
                 it.increment(ec)) {
                if (ec) { ec.clear(); continue; }
                if (!it->is_regular_file(ec)) continue;
                std::wstring ext = it->path().extension().wstring();
                std::transform(ext.begin(), ext.end(), ext.begin(), ::towlower);
                if (ext == L".flac") files.push_back(it->path());
            }
            std::sort(files.begin(), files.end());

            std::printf("decode verification (file handle vs whole file in memory)\n");
            std::printf("  dir    : %s\n", toUtf8(target).c_str());
            std::printf("  files  : %zu FLAC\n\n", files.size());
            if (!files.empty()) {
                uint64_t totalFrames = 0, totalSeeks = 0, totalRefused = 0;
                int failed = 0;
                for (size_t i = 0; i < files.size(); ++i) {
                    uint64_t frames = 0, seeks = 0, refused = 0, firstDiff = 0;
                    std::string error;
                    const bool ok = verifyDecoderAgainstMemory(files[i], frames, seeks, refused,
                                                               firstDiff, error);
                    const std::string name = toUtf8(files[i].filename());
                    if (ok) {
                        std::printf("  [%2zu/%zu] PASS  %8llu frames  %llu seeks  %s\n",
                                    i + 1, files.size(),
                                    static_cast<unsigned long long>(frames),
                                    static_cast<unsigned long long>(seeks), name.c_str());
                    } else {
                        ++failed;
                        std::printf("  [%2zu/%zu] FAIL  %8llu frames  %llu seeks  %s\n",
                                    i + 1, files.size(),
                                    static_cast<unsigned long long>(frames),
                                    static_cast<unsigned long long>(seeks), name.c_str());
                        std::printf("           %s", error.c_str());
                        if (firstDiff) {
                            std::printf(" (first differing source frame %llu)",
                                        static_cast<unsigned long long>(firstDiff));
                        }
                        std::printf("\n");
                    }
                    totalFrames  += frames;
                    totalSeeks   += seeks;
                    totalRefused += refused;
                }
                std::printf("\n  result: %zu files, %llu frames, %llu seek probes "
                            "(%llu refused past end on BOTH byte sources, which is dr_flac's "
                            "limit and not a divergence), %d failed\n",
                            files.size(),
                            static_cast<unsigned long long>(totalFrames),
                            static_cast<unsigned long long>(totalSeeks),
                            static_cast<unsigned long long>(totalRefused), failed);
                std::printf(failed == 0
                    ? "  the handle path decodes the SAME SAMPLES as the whole-file path\n\n"
                    : "  DIVERGENCE -- the handle path does not decode the same samples\n\n");
                failures += failed;
            }
            continue;
        }

        // ---- 单文件（或 URL）模式 ---------------------------------------
        const std::string lower = toLowerAscii(toUtf8(target));
        if (lower.rfind("http://", 0) == 0 || lower.rfind("https://", 0) == 0 ||
            (std::filesystem::is_regular_file(target, ec) && !ec)) {
            // FLAC 的逐样本比对只在 FLAC 上成立（dr_flac 的句柄路径才是它要
            // 验的东西）；非 FLAC 文件走通用的解码报告，那才是能回答
            // "这个格式支持吗"的东西。
            std::wstring ext = target.extension().wstring();
            std::transform(ext.begin(), ext.end(), ext.begin(), ::towlower);
            const bool isFlac = ext == L".flac";
            const bool url = lower.rfind("http://", 0) == 0 || lower.rfind("https://", 0) == 0;
            reportFile(target);
            if (isFlac || url) {
                uint64_t frames = 0, seeks = 0, refused = 0, firstDiff = 0;
                std::string error;
                const bool ok = verifyDecoderAgainstMemory(target, frames, seeks, refused,
                                                           firstDiff, error);
                std::printf("  flac_memory_compare : %s, %llu frames, %llu seek probes "
                            "(%llu refused past end)\n",
                            ok ? "PASS" : "FAIL",
                            static_cast<unsigned long long>(frames),
                            static_cast<unsigned long long>(seeks),
                            static_cast<unsigned long long>(refused));
                if (!ok) {
                    std::printf("  flac_memory_compare error: %s\n", error.c_str());
                    ++failures;
                }
            }
            continue;
        }

        std::printf("not a file or directory: %s\n", toUtf8(target).c_str());
        ++failures;
    }
    return failures == 0 ? 0 : 1;
}

} // namespace te
