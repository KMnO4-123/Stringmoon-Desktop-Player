#pragma once
// Single-producer / single-consumer planar float32 ring buffer.
//
// SPEC 3.2 fixes the properties that matter here:
//   * alignas(64) on the indices, so producer and consumer never share a cache
//     line ("SPSC 环形缓冲 alignas(64) 防伪共享")
//   * the indices are published with acquire/release only, never seq_cst
//   * the consumer path does no locking, no allocation, no system call
//
// Layout is channel-major: data_[ch * capacity + frame]. That keeps the internal
// representation planar as SPEC 3.2 requires, and it means a consumer reads one
// contiguous run per channel instead of striding the interleaved buffer.

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace te {

class PlanarRing {
public:
    PlanarRing() = default;

    PlanarRing(const PlanarRing&)            = delete;
    PlanarRing& operator=(const PlanarRing&) = delete;

    // Producer-side setup. Only call while the consumer is parked.
    void configure(int channels, size_t capacityFrames) {
        channels_ = channels;
        capacity_ = capacityFrames;
        data_.assign(capacityFrames * static_cast<size_t>(channels), 0.0f);
        writeFrame_.store(0, std::memory_order_relaxed);
        readFrame_.store(0, std::memory_order_relaxed);
    }

    int    channels() const       { return channels_; }
    size_t capacityFrames() const { return capacity_; }
    bool   isConfigured() const   { return capacity_ > 0; }

    size_t readableFrames() const {
        const uint64_t w = writeFrame_.load(std::memory_order_acquire);
        const uint64_t r = readFrame_.load(std::memory_order_relaxed);
        return static_cast<size_t>(w - r);
    }

    size_t writableFrames() const {
        const uint64_t w = writeFrame_.load(std::memory_order_relaxed);
        const uint64_t r = readFrame_.load(std::memory_order_acquire);
        return capacity_ - static_cast<size_t>(w - r);
    }

    // Producer side (decoder thread). Copies up to frames from planar sources,
    // returns the number actually written.
    size_t write(const float* const* planar, size_t frames) {
        if (capacity_ == 0) return 0;
        const size_t n = std::min(frames, writableFrames());
        if (n == 0) return 0;

        const uint64_t w = writeFrame_.load(std::memory_order_relaxed);
        const size_t start = static_cast<size_t>(w % capacity_);
        const size_t first = std::min(n, capacity_ - start);

        for (int ch = 0; ch < channels_; ++ch) {
            float* dst = data_.data() + static_cast<size_t>(ch) * capacity_;
            std::memcpy(dst + start, planar[ch], first * sizeof(float));
            if (n > first) std::memcpy(dst, planar[ch] + first, (n - first) * sizeof(float));
        }
        writeFrame_.store(w + n, std::memory_order_release);
        return n;
    }

    // Consumer side (RT thread). Returns how many frames were available.
    size_t read(float* const* planar, size_t frames) {
        if (capacity_ == 0) return 0;
        const size_t n = std::min(frames, readableFrames());
        if (n == 0) return 0;

        const uint64_t r = readFrame_.load(std::memory_order_relaxed);
        const size_t start = static_cast<size_t>(r % capacity_);
        const size_t first = std::min(n, capacity_ - start);

        for (int ch = 0; ch < channels_; ++ch) {
            const float* src = data_.data() + static_cast<size_t>(ch) * capacity_;
            std::memcpy(planar[ch], src + start, first * sizeof(float));
            if (n > first) std::memcpy(planar[ch] + first, src, (n - first) * sizeof(float));
        }
        readFrame_.store(r + n, std::memory_order_release);
        return n;
    }

    // Producer side. Legal only while the consumer is parked; the player proves
    // that by waiting for the RT thread to acknowledge a silence request first.
    void reset() {
        readFrame_.store(0, std::memory_order_relaxed);
        writeFrame_.store(0, std::memory_order_relaxed);
    }

private:
    int                channels_ = 0;
    size_t             capacity_ = 0;
    std::vector<float> data_;

    alignas(64) std::atomic<uint64_t> writeFrame_{0};
    alignas(64) std::atomic<uint64_t> readFrame_{0};
};

} // namespace te
