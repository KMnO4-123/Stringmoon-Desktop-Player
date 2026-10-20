#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace te {

// 默认淡入/淡出时长（毫秒）。
//
// 5ms 线性 ramp 的问题是"斜率在两端突变"：线性曲线在结尾处仍以恒定斜率回落，
// 最后一个采样离 0 还差一个 step（48k/5ms ≈ 240 帧，1/240 ≈ −48 dBFS 的残差），
// 再被硬切到 0 就是一个可闻的台阶。等功率余弦在结尾处斜率→0，最后采样精确为 0，
// 同时起点处斜率最大、听起来像"快速但不断裂"的收尾。10ms 是听感与响应速度的
// 折中（用户按暂停时 10ms 内完成，不会觉得拖沓）。
inline constexpr int kPlaybackRampMs = 10;

// 播放增益包络：等功率（equal-power）淡入/淡出。
//
// 曲线：淡出 gain = cos²(π/2 · t)，淡入 gain = sin²(π/2 · t)，t ∈ [0,1]。
// 两者互补（gainIn + gainOut = 1，中点各 0.5），且**两端一阶导数都为 0**：
// 淡出的最后一帧精确为 0，前面几帧也按 O(1/N²) 收敛，硬切台阶因此消失；
// 淡入的第一帧精确为 0，起始没有"从第一个样本突然起跳"的 click。
//
// 只在 ramp 期间计算 sin/cos（每次暂停/切歌约 480 个采样），稳态路径没有三角
// 函数，RT 线程不做任何分配/加锁/系统调用。曲线在首尾都连续：淡出从 1 开始、
// 到 0 精确结束；淡入从 0 开始、到 1 精确结束——这是消除爆音的关键，而不是
// "斜率小"。
class AudioFade {
public:
    enum class Direction { None, In, Out };

    void beginIn(int sampleRate, int milliseconds) noexcept {
        begin(Direction::In, sampleRate, milliseconds);
    }

    void beginOut(int sampleRate, int milliseconds) noexcept {
        begin(Direction::Out, sampleRate, milliseconds);
    }

    void reset() noexcept {
        gain_ = 1.0f;
        target_ = 1.0f;
        remaining_ = 0;
        total_ = 0;
        direction_ = Direction::None;
    }

    float next() noexcept {
        if (remaining_ <= 0) return gain_;
        const int total = total_;
        const int index = total - remaining_;   // 0 .. total-1
        const float t = (total > 1)
            ? static_cast<float>(index) / static_cast<float>(total - 1)
            : 1.0f;
        constexpr float kHalfPi = 1.57079632679489661923f;
        const float s = std::sin(kHalfPi * t);
        const float c = std::cos(kHalfPi * t);
        // sin² / cos²：两端的一阶导数都为 0。cos 曲线在终点斜率是最大值
        // （π/2/N 的台阶），而 cos² 在终点按 O(1/N²) 收敛——这才是"最后一步
        // 精确归零"的关键。两条曲线互补：sin² + cos² = 1。
        gain_ = (direction_ == Direction::In) ? (s * s) : (c * c);
        --remaining_;
        if (remaining_ <= 0) {
            // 精确落在目标上，而不是"接近目标"：最后一步必须是 0（或 1）。
            gain_ = target_;
        }
        return gain_;
    }

    bool active() const noexcept { return remaining_ > 0; }
    int remainingFrames() const noexcept { return remaining_; }
    int totalFrames() const noexcept { return total_; }
    float gain() const noexcept { return gain_; }
    Direction direction() const noexcept { return direction_; }

    // 供自测使用：不推进状态，返回第 index 帧（0-based）的包络值。
    static float gainAt(Direction direction, int index, int total) noexcept {
        if (total <= 1) return direction == Direction::In ? 1.0f : 0.0f;
        const float t = static_cast<float>(index) / static_cast<float>(total - 1);
        constexpr float kHalfPi = 1.57079632679489661923f;
        const float s = std::sin(kHalfPi * t);
        const float c = std::cos(kHalfPi * t);
        // 与 next() 同一公式；保留独立实现让自测能对照运行态与解析曲线。
        return (direction == Direction::In) ? (s * s) : (c * c);
    }

private:
    void begin(Direction direction, int sampleRate, int milliseconds) noexcept {
        direction_ = direction;
        target_ = (direction == Direction::In) ? 1.0f : 0.0f;
        if (sampleRate <= 0) sampleRate = 48000;
        if (milliseconds <= 0) {
            gain_ = target_;
            remaining_ = 0;
            total_ = 0;
            return;
        }
        const int64_t frames = static_cast<int64_t>(sampleRate) * milliseconds / 1000;
        total_ = static_cast<int>(std::clamp<int64_t>(frames, 1, INT32_MAX));
        remaining_ = total_;
        // 起点精确：淡入第一帧是 0，淡出第一帧是 1。
        gain_ = (direction == Direction::In) ? 0.0f : 1.0f;
    }

    float gain_ = 1.0f;
    float target_ = 1.0f;
    int remaining_ = 0;
    int total_ = 0;
    Direction direction_ = Direction::None;
};

} // namespace te
