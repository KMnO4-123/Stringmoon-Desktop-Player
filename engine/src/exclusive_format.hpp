#pragma once
// Exclusive-mode format construction, shared by the capability probe
// (devices.cpp) and the stream open (output_wasapi.cpp).
//
// These two MUST agree. If the probe reports a format the open path cannot then
// negotiate, the engine promises bit-perfect output and silently degrades -- the
// exact failure mode SPEC 3.3's "probe, do not assume" rule exists to prevent.
//
// The subtle part is 24-bit audio. Hardware very often exposes it as a 32-bit
// container carrying 24 valid bits, so a probe that only ever asks for
// container == precision reports "24-bit unsupported" for a device that supports
// it perfectly well.

#include <windows.h>
#include <mmreg.h>
// ksmedia.h 硬性要求先包含 ks.h（_KS_ 未定义会直接 #error）。这里显式补上，
// 让这个头文件自包含：以前它只被 devices.cpp / output_wasapi.cpp 这样"恰好
// 先经过了 audioclient.h"的翻译单元包含，换一个只含 windows.h 的 TU（自检）
// 就会编译失败。探测与打开共用这一个格式定义，前提是它自己能被独立包含。
#include <ks.h>
#include <ksmedia.h>

namespace te {

// Fills up to 4 candidates ordered narrowest-container-first.
inline int teExclusiveFormatCandidates(int sourceBits, WAVEFORMATEXTENSIBLE out[4]) {
    int count = 0;
    const int bits = sourceBits <= 0 ? 16 : sourceBits;

    if (bits <= 16) {
        out[count].Format.wBitsPerSample = 16;
        out[count].Samples.wValidBitsPerSample = 16;
        ++count;
    }
    if (bits <= 24) {
        out[count].Format.wBitsPerSample = 24;      // 24 in a 24-bit container
        out[count].Samples.wValidBitsPerSample = 24;
        ++count;
        out[count].Format.wBitsPerSample = 32;      // 24 in a 32-bit container
        out[count].Samples.wValidBitsPerSample = 24;
        ++count;
    }
    out[count].Format.wBitsPerSample = 32;
    out[count].Samples.wValidBitsPerSample = static_cast<WORD>(bits > 24 ? 32 : bits);
    ++count;
    return count;
}

inline WAVEFORMATEXTENSIBLE teMakeExclusiveFormat(int rate, int containerBits, int validBits,
                                                   int channels) {
    WAVEFORMATEXTENSIBLE want{};
    want.Format.wFormatTag      = WAVE_FORMAT_EXTENSIBLE;
    want.Format.nChannels       = static_cast<WORD>(channels);
    want.Format.nSamplesPerSec  = static_cast<DWORD>(rate);
    want.Format.wBitsPerSample  = static_cast<WORD>(containerBits);
    want.Format.nBlockAlign     = static_cast<WORD>(channels * (containerBits / 8));
    want.Format.nAvgBytesPerSec = static_cast<DWORD>(rate) * want.Format.nBlockAlign;
    want.Format.cbSize          = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    want.Samples.wValidBitsPerSample = static_cast<WORD>(validBits);
    want.dwChannelMask          = (channels == 1)
                                    ? SPEAKER_FRONT_CENTER
                                    : (channels == 2
                                        ? (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT)
                                        : 0);
    want.SubFormat              = KSDATAFORMAT_SUBTYPE_PCM;
    return want;
}

} // namespace te
