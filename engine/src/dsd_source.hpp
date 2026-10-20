#pragma once
// dsd_source.hpp -- DSF / DFF（1-bit DSD）到 PCM 的抽取解码。
//
// 为什么自己写而不是找解码器：DSD 的"解码"本质就是低通 + 抽取，没有熵解码也没有
// 预测器；DSF/DFF 的头是固定结构。引一个第三方 DSD 解码库的代价（许可、体积、
// 又一份 bug 面）大于这份实现的体积。而 DSD 的听感几乎完全取决于抽取滤波器——
// 写在这里意味着它可以被单测：DC 输入必须给稳定直流、Nyquist 输入必须被抑制。
//
// 为什么 16× 到 176400 Hz：DSD64 = 2822400 Hz，2822400 / 16 = 176400。
// 176400 是 44.1k 家族的 4 倍，既保住 DSD 的超声信息下限，又让既有的 SoXR 阶段
// 把它接到设备率（通常 48000）。DSD128/256 用更多级联，出口率固定 176400——
// 出口固定，下游（重采样 / bit-perfect / 独占协商）就一行都不用改。
//
// 已知取舍（写在接口处，不靠代码注释解释）：
//   * 不做 DoP / 原生 DSD 输出。抽取到 PCM 是本构建唯一路径，
//     get_capabilities 的 dsd.output 固定报 "pcm"。
//   * DST 压缩的 DFF 不支持（那是带熵编码的另一种载荷）。遇到时明确拒绝，
//     而不是把压缩数据当 1-bit 流解成噪声。
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include "audio_source.hpp"
#include "media_reader.hpp"

namespace te {

// DSD 抽取后的 PCM 率。所有 44.1k 家族的 DSD 率都能整除它。
inline constexpr int kDsdPcmRate = 176400;

// 半带级联抽取器：1-bit（±1）→ float PCM。
//
// 单独成类是为了可单测。抽取器的错法（相位反了、DC 增益不是 1、Nyquist 没被
// 抑制）在真实音乐上只表现为"有点糊"，只有合成信号能钉住它们。
class DsdDecimator {
public:
    // stages：2 的幂次级联数。DSD64 用 4（16×），DSD128 用 5，DSD256 用 6。
    // stages <= 0 时退化为直通（测试与防御用）。
    void configure(int stages);
    // 清空所有滤波历史。seek / 换曲后必须调用：旧内容的余振拖进新位置是可闻的。
    void reset() noexcept;
    // 推入一个 1-bit 样本（+1 = 1-bit 流里的 1，-1 = 0）。级联凑满一次抽取时
    // 返回 true 并写出一个 PCM 样本（DC 增益 = 1）。
    bool push(float bit, float& out) noexcept;
    int  stages() const noexcept { return stagesCount_; }

private:
    // 63-tap 半带低通（Blackman 窗），截止 0.25·fs。半带的定义是"中心抽头
    // 之外只有奇数位置非零"，所以 2× 抽取每输出只需 1+16 次乘加（对称配对）。
    static constexpr int kTaps    = 63;
    static constexpr int kCenter  = 31;
    static constexpr int kPairs   = 16;   // 中心两侧各 16 个非零抽头（偏移 1..31）
    static constexpr int kHistory = 64;   // 2 的幂，取模用位与

    struct Stage {
        float history[kHistory] = {};
        int   write = 0;
        int   sinceOutput = 0;
        float center = 0.5f;
        float pair[kPairs] = {};
        bool push(float x, float& out) noexcept {
            history[write] = x;
            const int n = write;
            write = (write + 1) & (kHistory - 1);
            if (++sinceOutput < 2) return false;
            sinceOutput = 0;
            // y[m] = Σ h[k]·x[2m-k]，中心抽头对齐 k = kCenter：
            //   0.5·x[n-31] + Σ_j pair[j]·(x[n-31+j] + x[n-31-j])
            const int base = n - kCenter;
            float sum = center * history[base & (kHistory - 1)];
            for (int j = 0; j < kPairs; ++j) {
                const int offset = 2 * j + 1;      // 1, 3, ..., 31
                const float a = history[(base + offset) & (kHistory - 1)];
                const float b = history[(base - offset) & (kHistory - 1)];
                sum += pair[j] * (a + b);
            }
            out = sum;
            return true;
        }
        void reset() noexcept {
            for (float& value : history) value = 0.0f;
            write = 0;
            sinceOutput = 0;
        }
    };

    Stage stages_[6];
    int   stagesCount_ = 4;

public:
    // 测试用：单级半带的幅频响应 |H(ω)|/|H(0)|（ω 为相对单级输入采样率的归一化角频率）。
    //
    // 为什么需要它：用信号测 H(π/2) 会退化 —— decimation by 2 之后 fs/4 正好落在
    // 输出域的 Nyquist，输出是 (-1)^m 且相位相消，峰值判据给出 0 而不是 0.5。
    // 半带的定义式只能在系数上量，所以把"单级的系数"以只读方式暴露给 selftest。
    // 这不是给生产代码用的接口：它只在 configure() 之后有意义，且不碰任何状态。
    double testHalfBandMagnitude(double w) const noexcept;
};

// 这个文件是不是 DSD？只看值得一试的魔数，不做完整解析：
//   DSF 以 "DSD " 开头；DFF 以 "FRM8" 开头且偏移 12 处是表单类型 "DSD "。
// 返回 0 = 不是，1 = DSF，2 = DFF。完整校验由 openDsdSource 真正解析时做。
int sniffDsdContainer(const std::vector<uint8_t>& head);

// 用已打开的 reader 构造 DSD 源。reader 会被移入（必须已 rewind 到文件开头）。
// 失败时返回 nullptr 并填 error（含 DST 压缩、非法头、非 44.1k 家族 DSD 率等原因）。
std::unique_ptr<AudioSource> openDsdSource(MediaReader reader, std::string& error);

} // namespace te
