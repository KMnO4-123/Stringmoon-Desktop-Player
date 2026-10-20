// probe_spatial.cpp — CR-029 空间音频的无声离线测试面（verifier 独立复算用）。
//
// 输出：
//   * 24 个方位 (-90°..+90° 等分) 的双耳解析 HRIR：完整 taps、ITD（样本/ms）、
//     ILD（dB）、总能量、峰值/首末非零位置；
//   * virtual 模式的卷积延迟（帧，固定 1024 = partitioned FFT 的固有延迟）；
//   * 「复位后无残留尾音」：喂冲激 → 卷积 → reset() → 再喂零 → 输出必须全零。
//
// 不打开音频设备，不影响正在使用默认端点的用户实例。
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "convolver.hpp"
#include "dsp.hpp"

namespace te {
namespace {

constexpr double kPi = 3.14159265358979323846;

struct BankProbe {
    bool built = false;
    int taps = 0;
    int channels = 0;
    int partitions = 0;
    int latencyFrames = 0;
    double resetTailMaxAbs = 0.0;
    int impulsePeakIndex = -1;
    double impulsePeak = 0.0;
    double chainFirstOutput = -1.0;
    double chainLeftEnergy = 0.0;
    double chainRightEnergy = 0.0;
    double chainSampleL[8] = {};
    double chainSampleR[8] = {};
    int    chainSampleN[8] = {};
    int    chainSamples = 0;
    std::string error;
};

BankProbe runBankProbe(int sampleRate) {
    BankProbe out;
    IrBank* bankA = nullptr;
    IrBank* bankB = nullptr;
    std::string error;
    if (!buildSpatialBanks(0.0f, sampleRate, bankA, bankB, error)) {
        out.error = error.empty() ? "buildSpatialBanks failed" : error;
        return out;
    }
    out.built = true;
    out.taps = bankA->taps();
    out.channels = bankA->channels();
    out.partitions = bankA->partitions();
    out.latencyFrames = FirConvolver::kPartition;

    FirConvolver convolver;
    std::string prepareError;
    if (!convolver.prepare(sampleRate, prepareError)) {
        out.error = prepareError;
        delete bankA; delete bankB;
        return out;
    }
    convolver.adopt(bankA);

    // 冲激响应：L 声道 impulse，R 声道 0；跑 4 个 partition 的帧数。
    constexpr int kFrames = FirConvolver::kPartition * 4;
    std::vector<std::vector<float>> planes(2, std::vector<float>(kFrames, 0.0f));
    planes[0][0] = 1.0f;
    float* views[2] = {planes[0].data(), planes[1].data()};
    convolver.process(views, 2, kFrames);
    for (int n = 0; n < kFrames; ++n) {
        const double v = std::fabs(static_cast<double>(planes[0][static_cast<std::size_t>(n)]));
        if (v > out.impulsePeak) { out.impulsePeak = v; out.impulsePeakIndex = n; }
    }

    // DspChain 完整虚拟路径（与播放链路同一实现）：验证 24 方位 HRIR 从
    // 冲激到输出的端到端延迟与左右能量，供 verifier 复算。
    {
        DspChain chain;
        chain.prepare(2, 2048, sampleRate);
        DspParams spatial;
        spatial.spatialMode = SpatialMode::Virtual;
        spatial.spatialAmount = 1.0f;
        chain.publish(spatial);
        chain.publishSpatialBanks(bankA, bankB);

        std::vector<std::vector<float>> chainPlanes(2, std::vector<float>(2048, 0.0f));
        for (int b = 0; b < 4; ++b) {
            for (auto& ch : chainPlanes) std::fill(ch.begin(), ch.end(), 0.0f);
            if (b == 0) chainPlanes[0][0] = 1.0f;
            float* views[2] = {chainPlanes[0].data(), chainPlanes[1].data()};
            chain.process(views, 2, 2048);

            for (int n = 0; n < 2048; ++n) {
                const double l = chainPlanes[0][static_cast<std::size_t>(n)];
                const double r = chainPlanes[1][static_cast<std::size_t>(n)];
                if (out.chainFirstOutput < 0.0 && (std::fabs(l) > 1.0e-6 || std::fabs(r) > 1.0e-6)) {
                    out.chainFirstOutput = static_cast<double>(b * 2048 + n);
                }
                out.chainLeftEnergy += l * l;
                out.chainRightEnergy += r * r;
                if (out.chainSamples < 8) {
                    out.chainSampleL[out.chainSamples] = l;
                    out.chainSampleR[out.chainSamples] = r;
                    out.chainSampleN[out.chainSamples] = b * 2048 + n;
                    ++out.chainSamples;
                }
            }
        }
    }

    // 复位后无尾音：reset 再喂零，输出必须精确为 0（卷积器历史已被清掉）。
    convolver.reset();
    std::vector<std::vector<float>> zeros(2, std::vector<float>(kFrames, 0.0f));
    float* zeroViews[2] = {zeros[0].data(), zeros[1].data()};
    convolver.process(zeroViews, 2, kFrames);
    for (int n = 0; n < kFrames; ++n) {
        out.resetTailMaxAbs = std::max(out.resetTailMaxAbs,
            std::fabs(static_cast<double>(zeros[0][static_cast<std::size_t>(n)])));
        out.resetTailMaxAbs = std::max(out.resetTailMaxAbs,
            std::fabs(static_cast<double>(zeros[1][static_cast<std::size_t>(n)])));
    }
    delete bankA;
    delete bankB;
    return out;
}

void printTaps(const std::vector<float>& taps) {
    std::printf("[");
    const int n = static_cast<int>(taps.size());
    for (int i = 0; i < n; ++i) {
        std::printf("%s%.6f", i ? ", " : "", static_cast<double>(taps[static_cast<std::size_t>(i)]));
    }
    std::printf("]");
}

} // namespace

int runSpatialProbe(int argc, char** argv) {
    bool json = false;
    int sampleRate = 48000;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--json") == 0) json = true;
        else if (std::strncmp(argv[i], "--rate=", 7) == 0) {
            const int parsed = std::atoi(argv[i] + 7);
            if (parsed >= 8000 && parsed <= 384000) sampleRate = parsed;
        }
    }

    // 24 个方位：[-90, +90] 等分（与 virtual 播放时 clamp(azimuth∓30°) 的取值域一致）。
    constexpr int kDirections = 24;
    std::vector<double> azimuths(kDirections);
    for (int i = 0; i < kDirections; ++i) {
        azimuths[static_cast<std::size_t>(i)] = -90.0 + 180.0 * static_cast<double>(i) /
                                                            static_cast<double>(kDirections - 1);
    }

    struct Entry {
        double azimuthDeg = 0.0;
        int    ear = 0;
        AnalyticHrir hrir;
    };
    std::vector<Entry> entries;
    entries.reserve(static_cast<std::size_t>(kDirections * 2));
    for (double az : azimuths) {
        for (int ear = 0; ear < 2; ++ear) {
            Entry e;
            e.azimuthDeg = az;
            e.ear = ear;
            e.hrir = makeAnalyticHrir(az, ear, sampleRate);
            entries.push_back(std::move(e));
        }
    }
    const BankProbe bank = runBankProbe(sampleRate);

    if (!json) {
        std::printf("spatial probe: %d azimuths x 2 ears @ %d Hz\n", kDirections, sampleRate);
        for (const auto& e : entries) {
            std::printf("  az=%7.2f ear=%s itd=%3d smp (%.3f ms) ild=%5.2f dB energy=%.5f peak=%d "
                        "first=%d last=%d\n",
                        e.azimuthDeg, e.ear == 0 ? "L" : "R", e.hrir.itdSamples,
                        static_cast<double>(e.hrir.itdSamples) * 1000.0 / sampleRate,
                        e.hrir.ildDb, e.hrir.energy, e.hrir.peakIndex,
                        e.hrir.firstNonzero, e.hrir.lastNonzero);
        }
        std::printf("  measuredIld@90=%.3f dB (design ildDb far ear = 4*sin|theta|)\n",
                    measuredIldDb(90.0, sampleRate));
        std::printf("  convolver: built=%d taps=%d latency=%d frames resetTailMaxAbs=%.9g\n",
                    bank.built ? 1 : 0, bank.taps, bank.latencyFrames, bank.resetTailMaxAbs);
        std::printf("  chain: firstOut=%.1f Lenergy=%.6f Renergy=%.6f\n",
                    bank.chainFirstOutput, bank.chainLeftEnergy, bank.chainRightEnergy);
        for (int i = 0; i < bank.chainSamples; ++i) {
            std::printf("    chain sample n=%d L=%.6f R=%.6f\n", bank.chainSampleN[i],
                        bank.chainSampleL[i], bank.chainSampleR[i]);
        }
        return 0;
    }

    std::printf("{\n");
    std::printf("  \"probe\": \"spatial\",\n");
    std::printf("  \"mode\": \"offline-model\",\n");
    std::printf("  \"sampleRate\": %d,\n", sampleRate);
    std::printf("  \"hrirModel\": {\"itd\": \"woodworth\", \"ildDbMax\": 4.0, "
                "\"pinnaReflectionMs\": 0.22, \"tapsMs\": 5.0},\n");
    std::printf("  \"azimuthsDeg\": [");
    for (int i = 0; i < kDirections; ++i) {
        std::printf("%s%.2f", i ? ", " : "", azimuths[static_cast<std::size_t>(i)]);
    }
    std::printf("],\n");
    // 实测双耳 ILD（能量比）——与 AnalyticHrir::ildDb（设计参数）区分开。
    std::printf("  \"measuredIldDbByAzimuth\": [");
    for (int i = 0; i < kDirections; ++i) {
        std::printf("%s%.4f", i ? ", " : "", measuredIldDb(azimuths[static_cast<std::size_t>(i)], sampleRate));
    }
    std::printf("],\n");
    std::printf("  \"entries\": [\n");
    for (std::size_t i = 0; i < entries.size(); ++i) {
        const Entry& e = entries[i];
        std::printf("    {\"azimuthDeg\": %.2f, \"ear\": \"%s\", \"taps\": ",
                    e.azimuthDeg, e.ear == 0 ? "L" : "R");
        printTaps(e.hrir.taps);
        std::printf(", \"itdSamples\": %d, \"itdMs\": %.4f, \"ildDb\": %.3f, "
                    "\"energy\": %.6f, \"peakIndex\": %d, \"firstNonzero\": %d, "
                    "\"lastNonzero\": %d}%s\n",
                    e.hrir.itdSamples,
                    static_cast<double>(e.hrir.itdSamples) * 1000.0 / sampleRate,
                    e.hrir.ildDb, e.hrir.energy, e.hrir.peakIndex,
                    e.hrir.firstNonzero, e.hrir.lastNonzero,
                    i + 1 == entries.size() ? "" : ",");
    }
    std::printf("  ],\n");
    std::printf("  \"convolver\": {\"built\": %s, \"taps\": %d, \"channels\": %d, "
                "\"partitions\": %d, \"latencyFrames\": %d, \"impulsePeakIndex\": %d, "
                "\"impulsePeak\": %.6f, \"resetTailMaxAbs\": %.9g",
                bank.built ? "true" : "false", bank.taps, bank.channels, bank.partitions,
                bank.latencyFrames, bank.impulsePeakIndex, bank.impulsePeak,
                bank.resetTailMaxAbs);
    if (!bank.error.empty()) std::printf(", \"error\": \"%s\"", bank.error.c_str());
    std::printf(", \"chainFirstOutput\": %.1f, \"chainLeftEnergy\": %.6f, "
                "\"chainRightEnergy\": %.6f",
                bank.chainFirstOutput, bank.chainLeftEnergy, bank.chainRightEnergy);
    std::printf("}\n");
    std::printf("}\n");
    return 0;
}

} // namespace te
