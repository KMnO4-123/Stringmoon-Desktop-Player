#pragma once
#include <algorithm>
#include <cmath>

namespace te {
// Render-thread state for output volume and mute. prepare() runs before audio;
// next() is allocation-free and advances once per stereo/multichannel frame.
class OutputGainSmoother {
public:
    void prepare(int sampleRate, float initial) noexcept {
        coefficient_ = 1.0 - std::exp(-1.0 / (0.010 * std::max(1, sampleRate)));
        value_ = std::clamp(initial, 0.0f, 1.0f);
    }
    float next(float target) noexcept {
        const double wanted = std::clamp(target, 0.0f, 1.0f);
        const double delta = wanted - value_;
        // Double state avoids a float rounding plateau near unity. Snap only
        // below -140 dB, so the neutral path can return the exact stored samples.
        value_ = std::fabs(delta) <= 1e-7 ? wanted : value_ + delta * coefficient_;
        return static_cast<float>(value_);
    }
private:
    double coefficient_ = 1.0;
    double value_ = 1.0;
};
} // namespace te
