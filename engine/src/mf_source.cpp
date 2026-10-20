// mf_source.cpp -- 系统解码兜底（IMFSourceReader）+ 解码能力矩阵（CR-032）。
//
// 为什么需要它：MP4（AAC/ALAC）已经证明 Windows 自带的 MF 解码器可用（见
// --probe-mf 的实测枚举：Opus / WMA / AC-3 / FLAC / MP3 / ALAC 都有 MFT）。
// 原生解码器（dr_libs + stb_vorbis）之外再引一套第三方解码库意味着许可、体积
// 和又一份要维护的 bug 面；而 IMFSourceReader 是系统组件，接进来只是选择
// "把系统已经装好的解码器当成兜底"。这是本轮唯一零新依赖的扩容方式。
//
// 边界是刻意划定的：
//   * 只做本地文件。HTTP 流继续走 MediaReader（Range/重定向/鉴权语义都在
//     应用侧的代理里）；让 MF 的 URL 源参与播放等于在引擎里放第二套传输层。
//   * 只在原生解码器全部拒绝之后才尝试。原生 FLAC/WAV/MP3/Ogg/MP4 的输出
//     必须逐样本不变——所以这个文件永远排在 openAudioSource 的最后一步。
//   * lossless 走白名单。认不出的 codec 一律报 lossy：把有损文件报成
//     lossless 会让 state.sourceExact 撒谎，而这个方向的错误用户无法自行
//     发现，也无法向用户解释。
//
// 一个读者可能会问：为什么不把 mp4_source.cpp 留着、另写一份？
// 因为"用 IMFSourceReader 按块取 PCM"这件事只该有一个实现。两份拷贝里那份
// 关于 ALAC 的 lossless 判定曾经被修正过一次（MP4 sample-entry 的 FOURCC
// 形状），如果兜底路径是第二份拷贝，这次修正只会落在其中一份上，然后两条
// 路径对同一个文件给出不同的 sourceExact。所以 mp4_source.cpp 的实现搬到了
// 这里，MP4 只是"带容器名字的同一个读者"。
//
// ---------------------------------------------------------------------------
// 一个必须写下来的实测结论：MFT 存在 != 格式能播
// ---------------------------------------------------------------------------
// 本机 --probe-mf 列出了 Microsoft Opus Audio Decoder MFT，但这不代表
// .opus/.ogg 能被 MF 打开：**解码器 MFT 只管"已解复用的码流"，容器解复用
// 归 byte-stream handler 管**，而 Windows 没有注册 .opus/.ogg/.aif/.dff 的
// byte-stream handler（HKLM\SOFTWARE\Microsoft\Windows Media Foundation\
// ByteStreamHandlers 里没有这几个后缀）。实测：--probe-decode 对
// correctness_gain_silent_output.opus 与 empty.aiff 都得到 0xC00D36C4
// (MF_E_UNSUPPORTED_BYTESTREAM_TYPE)，而对 real_example.wma / lossless.wma /
// empty1s.aac 分别成功解出 WMA / WMA Lossless / AAC。
//
// 所以能力矩阵的 available 是**两个条件同时成立**：byte-stream handler 已注册
// 且对应解码器 MFT 存在。只查后者会把 Opus 谎报成可用，而谎报的代价是界面
// 亮着、用户点了报错。

#include "mf_source.hpp"

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <mftransform.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "audio_source.hpp"
#include "util.hpp"
#include "win_util.hpp"

namespace te {
namespace {

// MEDIA FOUNDATION 用两种形状命名同一个 codec，这台机器两种都会出现：
//
//   AAC  文件报 {00001610-0000-0010-8000-00AA00389B71}  WAVE 风格 tag
//   ALAC 文件报 {616C6163-767A-494D-B478-F29D25DC9037}  MP4 sample entry
//
// 后者是 MFMPEG4Format_Base {00000000-767A-494D-B478-F29D25DC9037} 把 sample
// description 的 FOURCC 填进 Data1。只认同第一种形状曾把一个真正无损的文件
// 判成 lossy —— 而这个方向的错误正是最不能犯的。
const GUID kMpeg4FormatBase = {0x00000000, 0x767A, 0x494D, {0xB4, 0x78, 0xF2, 0x9D, 0x25, 0xDC, 0x90, 0x37}};
const GUID kSubtypeALAC      = {0x00006C61, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
// Dolby AC-3 与 E-AC-3。这两个既不是 WAVE 风格 tag、也不在 MP4 的 sample-entry
// 形状里，codecIdentity() 认不出它们 —— 实测 ac3.m4a 因此报 decoder=system，把
// "系统兜底"和"认不出的 codec"混成了一件事。
const GUID kSubtypeDolbyAC3   = {0xE06D802C, 0xDB46, 0x11CF, {0xB4, 0xD1, 0x00, 0x80, 0x5F, 0x6C, 0xBB, 0xEA}};
const GUID kSubtypeDolbyEC3   = {0xA7FB87AF, 0x2D02, 0x42FB, {0xA4, 0xD4, 0x05, 0xCD, 0x93, 0x84, 0x3B, 0xDD}};
// WAVE 风格 tag（低 16 位）——这些是 SDK 头文件里不一定有的旧 tag，所以显式写。
constexpr unsigned kTagPcm          = 0x0001;
constexpr unsigned kTagFloat        = 0x0003;
constexpr unsigned kWmaV1           = 0x0160;
constexpr unsigned kWmaV2           = 0x0161;
constexpr unsigned kWmaPro          = 0x0162;
constexpr unsigned kWmaLossless     = 0x0163;
constexpr unsigned kTagAlac         = 0x6C61;
constexpr unsigned kTagFlac         = 0xF1AC;
constexpr unsigned kTagOpus         = 0x704F;
constexpr unsigned kTagAc3          = 0x2000;
constexpr unsigned kTagAac          = 0x1610;

bool sameTail(const GUID& a, const GUID& b) {
    return a.Data2 == b.Data2 && a.Data3 == b.Data3 &&
           std::memcmp(a.Data4, b.Data4, sizeof a.Data4) == 0;
}

bool isWaveStyle(const GUID& subtype) {
    return subtype.Data2 == 0x0000 && subtype.Data3 == 0x0010 &&
           subtype.Data4[0] == 0x80 && subtype.Data4[1] == 0x00 && subtype.Data4[2] == 0x00 &&
           subtype.Data4[3] == 0xAA && subtype.Data4[4] == 0x00 && subtype.Data4[5] == 0x38 &&
           subtype.Data4[6] == 0x9B && subtype.Data4[7] == 0x71;
}

// codec 身份收敛成一个数，两种形状都能比。MP4 形状产出 FOURCC（'alac' =
// 0x616C6163），WAVE 形状产出 16-bit tag（0x6C61）。
unsigned int codecIdentity(const GUID& subtype) {
    if (sameTail(subtype, kMpeg4FormatBase)) return subtype.Data1;
    if (isWaveStyle(subtype)) return subtype.Data1 & 0xFFFFu;
    return 0;
}

const char* codecName(const GUID& subtype) {
    if (subtype == kSubtypeDolbyAC3) return "AC3";
    if (subtype == kSubtypeDolbyEC3) return "EAC3";
    switch (codecIdentity(subtype)) {
    case kTagPcm:      return "PCM";
    case kTagFloat:    return "IEEE_FLOAT";
    case kTagFlac:     return "FLAC";
    case kTagAlac:     return "ALAC";
    case 0x664C6143u:  return "FLAC";      // 'fLaC' MP4 sample entry
    case 0x616C6163u:  return "ALAC";      // 'alac' MP4 sample entry
    case kWmaV1:       return "WMA";
    case kWmaV2:       return "WMA";
    case kWmaPro:      return "WMAPro";
    case kWmaLossless: return "WMALossless";
    case kTagOpus:     return "Opus";
    case kTagAc3:      return "AC3";
    case kTagAac:      return "AAC";
    case 0x00FF:       return "AAC";       // MFAudioFormat_AAC 的 raw 形状
    case 0x0050:       return "MPEG";
    case 0x0055:       return "MP3";
    default:           return nullptr;
    }
}

// 白名单，不是猜测。认不出的 codec 报 lossy —— 见文件头。
bool isLosslessSubtype(const GUID& subtype) {
    if (subtype == kSubtypeALAC) return true;
    switch (codecIdentity(subtype)) {
    case kTagPcm:      return true;
    case kTagFloat:    return true;   // 浮点 PCM 也是未压缩样本
    case kTagFlac:     return true;
    case kTagAlac:     return true;
    case 0x664C6143u:  return true;
    case 0x616C6163u:  return true;
    case kWmaLossless: return true;
    default:           return false;
    }
}

// 进程级 MF 运行时。MFStartup 是引用计数的，全引擎只在这里启动一次、
// shutdownMediaFoundation() 里关闭一次；MP4 路径与兜底路径共用这一份。
struct MfRuntime {
    HRESULT hr = E_FAIL;
    bool    started = false;
};

MfRuntime& mfRuntime() {
    static MfRuntime runtime;
    return runtime;
}

bool isHttpPath(const std::filesystem::path& file) {
    const std::string lower = toLowerAscii(toUtf8(file));
    return lower.rfind("http://", 0) == 0 || lower.rfind("https://", 0) == 0;
}

// ---- 能力判定的两个条件（见文件头）----------------------------------------

// 条件一：容器解复用。MF 的后缀 → byte-stream handler 映射就在注册表里，
// HKLM 是系统安装的，HKCU 是用户/应用注册的，两处都看。
//
// 关键细节（第一次写错过，verifier 实测抓到）：ByteStreamHandlers 把扩展名存成
// **子键名**，不是值名。实测该键下 cSubKeys = 88、cValues = 0。
// 所以判定是"能不能打开 <ByteStreamHandlers>\.wma 这个子键"，而不是
// RegQueryValueExW 查一个叫 ".wma" 的值 —— 后者恒 ERROR_FILE_NOT_FOUND，
// 结果是整个 system 组假阴性（界面说不能用、实际能用），这是必须修掉的谎报。
bool mfByteStreamHandlesExtension(const char* ext) {
    const wchar_t* const kPath = L"SOFTWARE\\Microsoft\\Windows Media Foundation\\ByteStreamHandlers";
    const HKEY roots[] = {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER};
    const std::wstring wide(ext, ext + std::strlen(ext));
    if (wide.empty() || wide[0] != L'.') return false;
    for (HKEY root : roots) {
        std::wstring subkey(kPath);
        subkey += L"\\";
        subkey += wide;
        HKEY key = nullptr;
        const LSTATUS status = ::RegOpenKeyExW(root, subkey.c_str(), 0, KEY_READ, &key);
        if (status == ERROR_SUCCESS) {
            ::RegCloseKey(key);
            return true;
        }
    }
    return false;
}

// 条件二：码流解码器。MFTEnumEx 枚举所有音频解码器，看有没有接受这个 subtype。
bool hasDecoderForGUID(REFGUID subtype) {
    if (!mediaFoundationAvailable()) return false;
    IMFActivate** acts = nullptr;
    UINT32 count = 0;
    if (FAILED(MFTEnumEx(MFT_CATEGORY_AUDIO_DECODER, MFT_ENUM_FLAG_ALL, nullptr, nullptr,
                         &acts, &count)) || acts == nullptr) {
        return false;
    }
    bool found = false;
    for (UINT32 i = 0; i < count && !found; ++i) {
        IMFAttributes* attrs = acts[i];
        UINT32 size = 0;
        if (SUCCEEDED(attrs->GetBlobSize(MFT_INPUT_TYPES_Attributes, &size)) &&
            size >= sizeof(GUID)) {
            std::vector<BYTE> raw(size);
            UINT32 got = 0;
            if (SUCCEEDED(attrs->GetBlob(MFT_INPUT_TYPES_Attributes, raw.data(), size, &got)) &&
                got >= sizeof(GUID)) {
                const size_t n = got / sizeof(GUID);
                const GUID* types = reinterpret_cast<const GUID*>(raw.data());
                for (size_t k = 0; k < n; ++k) {
                    if (types[k] == subtype) { found = true; break; }
                }
            }
        }
        acts[i]->Release();
    }
    CoTaskMemFree(acts);
    return found;
}

// WAVE 风格的 tag GUID（Data1 = tag）。
GUID waveTag(unsigned tag) {
    GUID g = {tag, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
    return g;
}

// ---- 通用 IMFSourceReader 源 ------------------------------------------------
//
// 与 mp4_source.cpp 原来的实现逐行同构：按块取 sample、转平面 float、按时间戳
// 校正 seek 的落点。区别只有两处：容器名字（错误文案用）与 lossless 判定的
// 白名单更宽（现在同时服务 MP4 与系统兜底）。
class MfSource final : public AudioSource {
public:
    ~MfSource() override { close(); }

    // label 只影响错误文案与那行 stderr 诊断（"MP4" 与 "system decoder" 对
    // 用户是两件不同的事：一个是容器路径、一个是兜底路径）。
    bool init(const std::filesystem::path& file, std::string& error, const char* label);

    uint64_t readFrames(float* const* planar, uint64_t frames) override;
    bool     seekToFrame(uint64_t frame) override;

    int      sampleRate() const override  { return sampleRate_; }
    int      channels() const override    { return channels_; }
    int      bitDepth() const override    { return bitDepth_; }
    uint64_t totalFrames() const override { return totalFrames_; }
    bool     lossless() const override    { return lossless_; }
    const char* decoderName() const override { return decoderName_; }

private:
    void     close();
    bool     selectOutputType(std::string& error);
    bool     nextChunk(std::string& error);

    IMFSourceReader*     reader_ = nullptr;
    int                  sampleRate_ = 0;
    int                  channels_ = 0;
    int                  bitDepth_ = 16;      // 文件声明的，不是 MF 递过来的容器位深
    bool                 lossless_ = false;
    bool                 floatOutput_ = false;
    uint64_t             totalFrames_ = 0;
    bool                 endOfStream_ = false;
    const char*          decoderName_ = "system";

    std::vector<float>   pending_;            // interleaved float，已解码未交付
    size_t               pendingFrames_ = 0;
    size_t               pendingRead_ = 0;
    long long            skipFrames_ = 0;
    long long            skipTarget_ = -1;    // -1 = 用时间戳推落点
    std::string          lastError_;
};

void MfSource::close() {
    if (reader_) {
        reader_->Release();
        reader_ = nullptr;
    }
    pending_.clear();
    pendingFrames_ = 0;
    pendingRead_ = 0;
    endOfStream_ = true;
}

bool MfSource::init(const std::filesystem::path& file, std::string& error, const char* label) {
    const std::string prefix = std::string(label) + ": ";
    {
        std::string runtimeError;
        if (!ensureMediaFoundation(runtimeError)) {
            error = prefix + "Media Foundation did not start (" + runtimeError + ")";
            return false;
        }
    }

    // 不设任何属性：MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING 会让 MF 插入它
    // 自己的重采样器，而这个引擎只有一条允许重采样的路径（SoXR），
    // state.sampleRate 必须说的是文件的采样率。
    const HRESULT hr = MFCreateSourceReaderFromURL(file.c_str(), nullptr, &reader_);
    if (FAILED(hr) || !reader_) {
        reader_ = nullptr;
        error = prefix + "no system decoder accepted this file (" + hresultToString(hr) + ")";
        return false;
    }

    // 只要一条音频流：一个同时含视频的 .mp4/.mka 否则会把视频也解一遍。
    reader_->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    if (FAILED(reader_->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE))) {
        error = prefix + "no selectable audio stream";
        close();
        return false;
    }

    IMFMediaType* native = nullptr;
    if (FAILED(reader_->GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, &native)) || !native) {
        error = prefix + "the container holds no audio track";
        close();
        return false;
    }

    GUID subtype{};
    native->GetGUID(MF_MT_SUBTYPE, &subtype);
    UINT32 value = 0;
    if (SUCCEEDED(native->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &value))) sampleRate_ = static_cast<int>(value);
    value = 0;
    if (SUCCEEDED(native->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &value))) channels_ = static_cast<int>(value);
    value = 0;
    if (SUCCEEDED(native->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &value)) && value > 0) {
        bitDepth_ = static_cast<int>(value);
    }
    lossless_ = isLosslessSubtype(subtype);
    decoderName_ = codecName(subtype);
    if (decoderName_ == nullptr) decoderName_ = "system";
    native->Release();

    // 如实说出解码器怎么看这个文件：catalog 的 codec 来自 TagLib，这里是
    // 真正要解它的那一个。两者不一致时，以用户的听感为准的就是这里。
    {
        char guid[64] = {};
        std::snprintf(guid, sizeof guid, "%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X",
                      subtype.Data1, subtype.Data2, subtype.Data3, subtype.Data4[0], subtype.Data4[1],
                      subtype.Data4[2], subtype.Data4[3], subtype.Data4[4], subtype.Data4[5],
                      subtype.Data4[6], subtype.Data4[7]);
        std::fprintf(stderr, "[info] %s decode: subtype {%s} codec=%s lossless=%d %dHz %dch %dbit\n",
                     label, guid, decoderName_, lossless_ ? 1 : 0, sampleRate_, channels_, bitDepth_);
    }

    if (sampleRate_ <= 0 || channels_ <= 0 || channels_ > 8) {
        error = prefix + "unsupported stream shape";
        close();
        return false;
    }
    if (!selectOutputType(error)) {
        close();
        return false;
    }

    PROPVARIANT duration;
    PropVariantInit(&duration);
    if (SUCCEEDED(reader_->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &duration)) &&
        duration.vt == VT_UI8) {
        totalFrames_ = static_cast<uint64_t>(duration.uhVal.QuadPart) * static_cast<uint64_t>(sampleRate_) / 10000000ull;
    }
    PropVariantClear(&duration);
    if (totalFrames_ == 0) {
        // 时长驱动 EOS：0 会让每首歌一打开就被判为已结束。
        error = prefix + "reports no usable duration";
        close();
        return false;
    }

    // 先读一块，让"能打开但解不出样本"的解码器在这里失败，而不是变成一条
    // 打开成功、然后永远安静的音轨。
    //
    // 这里曾经写成 "nextChunk 返回 false 且 pendingFrames_==0" 才失败：nextChunk
    // 在 EOS 时返回 TRUE（干净结束），所以"打开成功但一个样本都没有"的容器会
    // 被放过 —— real_example.wma（9967 B 却声称 96 秒的 fixture）正是这样：
    // 头解析成功、立刻 EOS、decoded=0，而 --probe-format 报 ok=1。改成"只要
    // 没拿到样本就拒绝"，因为一个放不出一帧的文件不可播。
    std::string probeError;
    const bool firstChunkOk = nextChunk(probeError);
    if (!firstChunkOk || pendingFrames_ == 0) {
        error = (!firstChunkOk && !probeError.empty()) ? probeError : prefix + "decoded no audio";
        close();
        return false;
    }
    skipFrames_ = 0;
    skipTarget_ = -1;
    return true;
}

bool MfSource::selectOutputType(std::string& error) {
    // 先要 float。要求与文件相同的采样率/声道数不是洁癖：若 MF 在这里重采样，
    // state.sampleRate 说的就会是设备率，引擎自己的重采样器反而无事可做。
    const GUID candidates[2] = {MFAudioFormat_Float, MFAudioFormat_PCM};
    HRESULT last = E_FAIL;
    for (const GUID& candidate : candidates) {
        IMFMediaType* type = nullptr;
        MFCreateMediaType(&type);
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        type->SetGUID(MF_MT_SUBTYPE, candidate);
        type->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, static_cast<UINT32>(channels_));
        type->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, static_cast<UINT32>(sampleRate_));
        if (candidate == MFAudioFormat_PCM) {
            type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        }
        last = reader_->SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, type);
        type->Release();
        if (SUCCEEDED(last)) {
            floatOutput_ = (candidate == MFAudioFormat_Float);
            return true;
        }
    }
    error = "no decodable output type (" + hresultToString(last) + ")";
    return false;
}

bool MfSource::nextChunk(std::string& error) {
    if (endOfStream_) return true;

    while (true) {
        DWORD flags = 0;
        LONGLONG timestamp = 0;
        IMFSample* sample = nullptr;
        const HRESULT hr = reader_->ReadSample(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, nullptr,
                                               &flags, &timestamp, &sample);
        if (FAILED(hr)) {
            error = "read failed (" + hresultToString(hr) + ")";
            if (sample) sample->Release();
            return false;
        }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
            endOfStream_ = true;
            if (sample) sample->Release();
            return true;
        }
        if (!sample) continue;   // 空档或格式变化但没有数据

        IMFMediaBuffer* buffer = nullptr;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer)) || !buffer) {
            sample->Release();
            continue;
        }

        BYTE* data = nullptr;
        DWORD maxLength = 0;
        DWORD length = 0;
        if (FAILED(buffer->Lock(&data, &maxLength, &length)) || !data) {
            buffer->Release();
            sample->Release();
            continue;
        }

        // seek 之后读者落在"不晚于请求帧"的样本边界上，时间戳说明那是哪里。
        // 没有这一步，恢复播放会比用户拖到的位置最多晚一个 sample group。
        if (skipTarget_ >= 0) {
            const long long landed = static_cast<long long>(timestamp) * sampleRate_ / 10000000LL;
            skipFrames_ = (landed < skipTarget_) ? (skipTarget_ - landed) : 0;
            skipTarget_ = -1;
        }

        const int bytesPerSample = floatOutput_ ? 4 : 2;
        const size_t frames = length / (static_cast<size_t>(bytesPerSample) * static_cast<size_t>(channels_));
        pending_.resize(frames * static_cast<size_t>(channels_));
        if (floatOutput_) {
            std::memcpy(pending_.data(), data, frames * static_cast<size_t>(channels_) * sizeof(float));
        } else {
            const int16_t* src = reinterpret_cast<const int16_t*>(data);
            constexpr float kScale = 1.0f / 32768.0f;
            for (size_t i = 0; i < frames * static_cast<size_t>(channels_); ++i) {
                pending_[i] = static_cast<float>(src[i]) * kScale;
            }
        }
        buffer->Unlock();
        buffer->Release();
        sample->Release();

        pendingFrames_ = frames;
        pendingRead_ = 0;
        if (frames > 0) return true;
    }
}

uint64_t MfSource::readFrames(float* const* planar, uint64_t frames) {
    if (!reader_ || frames == 0) return 0;
    uint64_t produced = 0;

    while (produced < frames) {
        if (pendingRead_ >= pendingFrames_) {
            if (endOfStream_) break;
            std::string error;
            if (!nextChunk(error)) break;      // 没有错误通道；音轨就到这里结束
            if (pendingRead_ >= pendingFrames_) continue;
        }

        size_t available = pendingFrames_ - pendingRead_;
        if (skipFrames_ > 0) {
            const size_t dropping = std::min<size_t>(available, static_cast<size_t>(skipFrames_));
            pendingRead_ += dropping;
            skipFrames_ -= static_cast<long long>(dropping);
            continue;
        }

        const size_t take = std::min<size_t>(available, static_cast<size_t>(frames - produced));
        const float* src = pending_.data() + pendingRead_ * static_cast<size_t>(channels_);
        for (uint32_t ch = 0; ch < static_cast<uint32_t>(channels_); ++ch) {
            float* dst = planar[ch] + produced;
            const float* s = src + ch;
            for (size_t i = 0; i < take; ++i) dst[i] = s[i * static_cast<size_t>(channels_)];
        }
        pendingRead_ += take;
        produced += take;
    }
    return produced;
}

bool MfSource::seekToFrame(uint64_t frame) {
    if (!reader_) return false;
    if (frame > totalFrames_) frame = totalFrames_;

    PROPVARIANT position;
    PropVariantInit(&position);
    position.vt = VT_I8;
    position.hVal.QuadPart = static_cast<LONGLONG>(frame) * 10000000LL / sampleRate_;
    const HRESULT hr = reader_->SetCurrentPosition(GUID_NULL, position);
    PropVariantClear(&position);
    if (FAILED(hr)) return false;

    // 丢掉 seek 前解出的所有东西，然后让第一块的时间戳说出读者实际落在哪里。
    pendingFrames_ = 0;
    pendingRead_ = 0;
    endOfStream_ = false;
    skipTarget_ = static_cast<long long>(frame);
    skipFrames_ = 0;
    return true;
}

} // namespace

// ---------------------------------------------------------------------------
// MF 运行时
// ---------------------------------------------------------------------------

bool ensureMediaFoundation(std::string& error) {
    MfRuntime& runtime = mfRuntime();
    if (runtime.started) return true;
    runtime.hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
    runtime.started = SUCCEEDED(runtime.hr);
    if (!runtime.started) {
        error = hresultToString(runtime.hr);
        return false;
    }
    return true;
}

bool mediaFoundationAvailable() {
    return mfRuntime().started;
}

void shutdownMediaFoundation() {
    MfRuntime& runtime = mfRuntime();
    if (!runtime.started) return;
    // 只会在 Player::releaseSource() 之后调用：活着的 IMFSourceReader 比
    // MFShutdown 活得久，正是这个项目已经付过一次代价的拆除顺序错误。
    MFShutdown();
    runtime.started = false;
}

// ---------------------------------------------------------------------------
// 两个入口：MP4 与系统兜底
// ---------------------------------------------------------------------------

std::unique_ptr<AudioSource> openMfContainerSource(const std::filesystem::path& file,
                                                    std::string& error, const char* label) {
    error.clear();
    auto source = std::make_unique<MfSource>();
    if (!source->init(file, error, label)) return nullptr;
    return source;
}

std::unique_ptr<AudioSource> openMfSource(const std::filesystem::path& file,
                                          std::string& error) {
    // 系统兜底只做本地文件。URL 走 MediaReader，避免第二套传输层。
    if (isHttpPath(file)) {
        error = "the system decoder fallback only accepts local files";
        return nullptr;
    }
    // 先做一次容器能力判断：MF 对没有 byte-stream handler 的后缀只会返回
    // 0xC00D36C4，把它变成一条说得清的原因，比让每个文件都去试一次更有用。
    if (!mfByteStreamHandlesExtension(toLowerAscii(toUtf8(file.extension())).c_str())) {
        error = "this build's system decoder fallback has no container demuxer for " +
                toLowerAscii(toUtf8(file.extension()));
        return nullptr;
    }
    return openMfContainerSource(file, error, "system decoder");
}

// ---------------------------------------------------------------------------
// 能力矩阵（CR-032）
// ---------------------------------------------------------------------------

std::vector<DecoderCapability> decoderCapabilities() {
    // MFStartup 必须在读能力之前发生，否则 mediaFoundationAvailable() 恒为
    // false，矩阵会把本机明明能解的 WMA/AC-3/AAC 全部报成不可用 —— 这正是
    // 第一次实测抓到的假阴性。MFStartup 幂等且是进程级一次，控制线程承担这
    // 一次启动成本是正确的（get_capabilities 与 --probe-decode 都在控制线程）。
    {
        std::string ignored;
        ensureMediaFoundation(ignored);
    }
    std::vector<DecoderCapability> out;

    // ---- native：本引擎自带解码器，不依赖系统 -------------------------------
    //
    // lossless 是"该格式的典型语义"：最终每个文件的判定由解码器在 open 时
    // 回答（state.sourceExact），矩阵只是让界面能先把已知的格式列出来。
    out.push_back({".flac", "FLAC", DecoderKind::Native, true,  true});
    out.push_back({".wav",  "WAV",  DecoderKind::Native, true,  true});
    out.push_back({".mp3",  "MP3",  DecoderKind::Native, false, true});
    out.push_back({".ogg",  "Ogg Vorbis", DecoderKind::Native, false, true});
    out.push_back({".oga",  "Ogg (Vorbis/FLAC)", DecoderKind::Native, false, true});
    out.push_back({".m4a",  "MP4 (AAC/ALAC)", DecoderKind::Native, false, true});

    // ---- system：Windows 自带的 Media Foundation 解码链 ---------------------
    //
    // available = byte-stream handler 已注册 AND 解码器 MFT 存在（见文件头）。
    // 这两个条件缺一不可，实测依据也写在那里：Opus 解码器 MFT 在，但容器
    // 解复用器不在，所以 .opus 在本机经 MF 打不开 —— 矩阵如实报 false，
    // 界面才能把这一项置灰而不是让用户点了报错。
    const bool mf = mediaFoundationAvailable();
    const bool wmaHandler = mf && mfByteStreamHandlesExtension(".wma");
    const bool ac3Handler = mf && mfByteStreamHandlesExtension(".ac3");
    const bool aacHandler = mf && mfByteStreamHandlesExtension(".aac");
    const bool opusHandler = mf && (mfByteStreamHandlesExtension(".opus") ||
                                    mfByteStreamHandlesExtension(".ogg"));
    const bool aiffHandler = mf && (mfByteStreamHandlesExtension(".aif") ||
                                    mfByteStreamHandlesExtension(".aiff"));

    const bool wmaDecoder = hasDecoderForGUID(waveTag(kWmaV2)) ||
                            hasDecoderForGUID(waveTag(kWmaV1)) ||
                            hasDecoderForGUID(waveTag(kWmaLossless)) ||
                            hasDecoderForGUID(waveTag(kWmaPro));
    out.push_back({".wma",  "WMA",  DecoderKind::System, false, wmaHandler && wmaDecoder});
    out.push_back({".ac3",  "AC-3", DecoderKind::System, false,
                   ac3Handler && hasDecoderForGUID(waveTag(kTagAc3))});
    out.push_back({".aac",  "AAC (raw ADTS)", DecoderKind::System, false,
                   aacHandler && hasDecoderForGUID(waveTag(0x00FF))});
    out.push_back({".opus", "Opus", DecoderKind::System, false,
                   opusHandler && hasDecoderForGUID(waveTag(kTagOpus))});
    out.push_back({".aif",  "AIFF", DecoderKind::System, true, aiffHandler});
    out.push_back({".aiff", "AIFF", DecoderKind::System, true, aiffHandler});

    // ---- dsd：1-bit 源经抽取转 PCM -----------------------------------------
    //
    // 这一项不依赖系统：抽取器是引擎自带的（dsd_source.cpp）。DSD64/128/256
    // 都能解，出口固定 176400 Hz；DSD 是对原始 1-bit 数据的无损表示，故
    // lossless = true（抽取是有损的降采样，但源文件本身没有丢信息 —— 这与
    // "这个文件是 lossless 格式"的语义一致，state.sourceExact 也据此为真）。
    out.push_back({".dsf", "DSF (DSD)", DecoderKind::Dsd, true, true});
    out.push_back({".dff", "DFF (DSDIFF)", DecoderKind::Dsd, true, true});

    return out;
}

const char* decoderKindName(DecoderKind kind) {
    switch (kind) {
        case DecoderKind::System: return "system";
        case DecoderKind::Dsd:    return "dsd";
        case DecoderKind::Native:
        default:                  return "native";
    }
}

} // namespace te
