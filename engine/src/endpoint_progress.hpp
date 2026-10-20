#pragma once
#include <atomic>
#include <cstdint>

namespace te {
// One render-thread writer, control-thread readers. Device padding counts
// silence too; audioFrames is the real amount taken from the planar ring.
class EndpointProgress {
public:
    void reset() noexcept {
        submitted_ = 0;
        audioSubmitted_.store(0, std::memory_order_relaxed);
        lastAudioEnd_.store(0, std::memory_order_relaxed);
        played_.store(0, std::memory_order_relaxed);
    }
    void submitted(uint64_t frames, uint64_t audioFrames) noexcept {
        if (audioFrames) lastAudioEnd_.store(submitted_ + audioFrames, std::memory_order_relaxed);
        submitted_ += frames;
        // Publish after the endpoint watermark. A reader cannot declare drain
        // while the render thread is between ring.read() and ReleaseBuffer().
        audioSubmitted_.fetch_add(audioFrames, std::memory_order_release);
    }
    void observePadding(uint64_t padding) noexcept {
        played_.store(submitted_ > padding ? submitted_ - padding : 0, std::memory_order_release);
    }
    uint64_t played() const noexcept { return played_.load(std::memory_order_acquire); }
    // 已提交给端点的总帧数（含静音 padding）。静音排水判据用它：
    // 设备播到"提交水位"才算 padding 真的进了硬件缓冲并被放完。
    uint64_t submittedFrames() const noexcept { return submitted_; }
    uint64_t submittedAudioFrames() const noexcept {
        return audioSubmitted_.load(std::memory_order_acquire);
    }
    bool drained(uint64_t expectedAudio) const noexcept {
        if (audioSubmitted_.load(std::memory_order_acquire) < expectedAudio) return false;
        return played() >= lastAudioEnd_.load(std::memory_order_relaxed);
    }
private:
    uint64_t submitted_ = 0;
    std::atomic<uint64_t> audioSubmitted_{0}, lastAudioEnd_{0}, played_{0};
};
} // namespace te
