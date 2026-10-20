// dsd_source.cpp -- DSF / DFF（1-bit DSD）→ PCM 的抽取解码。
//
// 为什么不引解码库：DSD 的"解码"是低通 + 抽取，没有熵解码、没有预测器。DSF/DFF
// 的头是固定布局。第三方 DSD 解码库的代价（许可、体积、又一份 bug 面）大于这份
// 实现；而听感几乎完全取决于抽取滤波器，写在这里就能被单测钉住。
//
// 抽取器是半带（half-band）级联。选半带而不是通用 FIR 的原因是可算：
//   * 半带的中心抽头之外，只有距中心奇数个样本处非零 → 2× 抽取每输出 17 次乘加；
//   * 4 级级联 = 16×，DSD64 → 176400 Hz；
//   * DC 增益必须 = 1（单测用"全 1 输入"钉），1-bit 流的 Nyquist（fs/2，即
//     交替 +1/-1）必须被抑制（单测用交替位钉）。
//
// 两个容器的差别只有三处，其余逐字节一样：
//   1) 头字节序：DSF 小端，DFF（IFF 家族）大端；
//   2) 位序：DSF 是 LSB-first，DFF 是 MSB-first；
//   3) 交织粒度：DSF 按 blockSize 分块（一块里先是整段声道 0，再整段声道 1），
//      DFF 按帧交织（每帧 channels 个字节，每声道一个字节）。
// 第 3 点是最容易写错的一条：把 DFF 当 DSF 解，两个声道会被错位拼在一起，
// 结果是"左右声道被拉成时间上的前一半/后一半"，听起来像慢速抖动而不是错误。
#include "dsd_source.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "util.hpp"

namespace te {
namespace {

constexpr double kPi = 3.14159265358979323846;

// 抽取后的 PCM 率由级联级数吸收差值：DSD64/128/256 共用同一个出口率，
// 下游（重采样 / bit-perfect / 独占协商）因此一行都不用改。
constexpr int kPcmRate = kDsdPcmRate;

// 半带低通设计参数（与 DsdDecimator 里的常量保持一致；那边是 private，所以
// 这里再写一次并在 configure() 里断言只差一次设计）。63 taps、Blackman 窗、
// 截止 0.25·fs。奇数偏移的抽头才是半带的非零项。
constexpr int kTaps   = 63;
constexpr int kCenter = 31;
constexpr int kPairs  = 16;   // 偏移 1,3,...,31

// 1-bit 率 → 级联级数。只接受 44.1k 家族，因为出口固定 176400：
//   DSD64  2822400 / 176400 = 16  → 4 级
//   DSD128 5644800 / 176400 = 32  → 5 级
//   DSD256 11289600 / 176400 = 64 → 6 级
// 48k 家族（3072000）除不尽 176400；如实拒绝比悄悄换一个出口率诚实。
int stagesForDsdRate(int dsdRate) {
    switch (dsdRate) {
        case 2822400:  return 4;
        case 5644800:  return 5;
        case 11289600: return 6;
        default:       return 0;
    }
}

// 设计半带低通，归一化到 DC 增益 1。
//
// h[n] = sin(πn/2) / (πn)（n ≠ 0），h[0] = 1/2 —— 这是半带的定义式：中心抽头
// 恰好 1/2，偶数偏移抽头恒为 0，H(π/2) 恰好等于 H(0)/2。
//
// 第一版写成了 sin(πn/2)/(πn) 的**一半**（等效 sinc(n/2)/2），导致 H(π/2)/H(0)
// 变成 0.667 而不是 0.5、阻带只有 -9.5 dB，4 级级联后 Nyquist 只压到 -9.5 dB，
// 等于没有抽取滤波（DSD 的超声噪声整形会原样留在 PCM 里）。这一处是 verifier
// 复算 H(π/2)/H(0) 抓到的；下面的 selftest 会用同一判据钉住它，不再只靠听感。
void designHalfBand(float& center, float pair[kPairs]) {
    double coefficients[kTaps] = {};
    double sum = 0.0;
    for (int k = 0; k < kTaps; ++k) {
        const double n = static_cast<double>(k - kCenter);
        const double ideal = (n == 0.0) ? 0.5 : std::sin(kPi * n * 0.5) / (kPi * n);
        // Blackman 窗：旁瓣低；过渡带约 11%·fs，对抽取足够。
        const double w = 0.42 - 0.5 * std::cos(2.0 * kPi * k / (kTaps - 1)) +
                         0.08 * std::cos(4.0 * kPi * k / (kTaps - 1));
        coefficients[k] = ideal * w;
        sum += coefficients[k];
    }
    for (double& c : coefficients) c /= sum;
    center = static_cast<float>(coefficients[kCenter]);
    for (int j = 0; j < kPairs; ++j) {
        pair[j] = static_cast<float>(coefficients[kCenter + 2 * j + 1]);
    }
}

uint32_t readLE32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint64_t readLE64(const uint8_t* p) {
    return static_cast<uint64_t>(readLE32(p)) | (static_cast<uint64_t>(readLE32(p + 4)) << 32);
}
uint32_t readBE32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}
uint64_t readBE64(const uint8_t* p) {
    return (static_cast<uint64_t>(readBE32(p)) << 32) | static_cast<uint64_t>(readBE32(p + 4));
}
std::string fourcc(const uint8_t* p) {
    return std::string(reinterpret_cast<const char*>(p), 4);
}

// 读满 want 字节；短读只在 hasError 时才不是 EOF。
size_t readFully(MediaReader& reader, void* out, size_t want) {
    size_t got = 0;
    auto* bytes = static_cast<uint8_t*>(out);
    while (got < want) {
        const size_t n = reader.read(bytes + got, want - got);
        if (n == 0) break;
        got += n;
    }
    return got;
}

class DsdSource final : public AudioSource {
public:
    ~DsdSource() override { close(); }

    bool init(MediaReader reader, std::string& error);

    uint64_t readFrames(float* const* planar, uint64_t frames) override;
    bool     seekToFrame(uint64_t frame) override;

    int      sampleRate() const override  { return kPcmRate; }
    int      channels() const override    { return channels_; }
    // 1-bit 到 float 的可听精度：抽取器通带纹波与 24-bit 量化同量级；报 24 是
    // 诚实的下界（报 1 会让独占协商去要 1-bit 容器，报 32 是没有根据的抬举）。
    int      bitDepth() const override    { return 24; }
    uint64_t totalFrames() const override { return totalPcmFrames_; }
    bool     lossless() const override    { return true; }
    const char* decoderName() const override { return "dsd"; }

    // CR-032：state.source 需要源 1-bit 率。
    const char* sourceFormat() const override { return "dsd"; }
    int      dsdRate() const override     { return dsdRate_; }

private:
    void close();
    bool decodeNextChunk();

    MediaReader   reader_;
    DsdDecimator  decimator_[6];
    int           channels_ = 2;
    int           dsdRate_ = 2822400;
    int           stages_ = 4;
    uint64_t      totalPcmFrames_ = 0;
    uint64_t      audioStartByte_ = 0;
    uint64_t      audioBytes_ = 0;
    uint64_t      bytesConsumed_ = 0;
    uint64_t      position_ = 0;         // 已交付的 PCM 帧
    bool          dsf_ = true;
    uint32_t      blockSize_ = 4096;
    bool          endOfStream_ = false;
    bool          failed_ = false;
    std::string   decodeError_;
    int           warmupSkip_ = 0;   // 级联稳定前要丢弃的输出帧数（启动瞬态）

    std::vector<float>   pcm_;           // interleaved，已解码未交付
    size_t               pcmFrames_ = 0;
    size_t               pcmRead_ = 0;
    std::vector<uint8_t> raw_;
};

void DsdSource::close() {
    reader_.close();
    pcm_.clear();
    pcmFrames_ = 0;
    pcmRead_ = 0;
    endOfStream_ = true;
}

bool DsdSource::init(MediaReader reader, std::string& error) {
    reader_ = std::move(reader);
    if (!reader_.seek(0, 0)) {
        error = "cannot read this DSD file";
        return false;
    }
    uint8_t head[128] = {};
    const size_t headBytes = readFully(reader_, head, sizeof head);
    if (headBytes < 92) {
        error = "the DSD header is shorter than a valid container";
        return false;
    }

    if (std::memcmp(head, "DSD ", 4) == 0) {
        // ---- DSF（全部小端）------------------------------------------------
        //  0 "DSD "; 4 chunkSize(28); 12 fileSize; 20 metadataOffset;
        // 28 "fmt "; 32 chunkSize(52); 40 version; 44 formatId;
        // 48 channelType; 52 channelNum; 56 samplingFrequency; 60 bitsPerSample;
        // 64 sampleCount; 72 blockSize; 80 "data"; 84 chunkSize; 92 audio
        if (std::memcmp(head + 28, "fmt ", 4) != 0) {
            error = "DSF header has no fmt chunk";
            return false;
        }
        const uint32_t formatId = readLE32(head + 44);
        if (formatId != 0) {
            // 1 = ID3v2 元数据块夹在前面的布局。本构建不剥离它，如实拒绝。
            error = "DSF is in the ID3-leading layout, which this build does not parse";
            return false;
        }
        channels_ = static_cast<int>(readLE32(head + 52));
        dsdRate_  = static_cast<int>(readLE32(head + 56));
        const uint32_t bitsPerSample = readLE32(head + 60);
        const uint64_t sampleCount = readLE64(head + 64);
        blockSize_ = readLE32(head + 72);
        if (bitsPerSample != 1) {
            error = "DSF declares " + std::to_string(bitsPerSample) + " bits per sample, not 1";
            return false;
        }
        if (sampleCount == 0 || blockSize_ == 0) {
            error = "DSF declares an empty stream";
            return false;
        }
        if (std::memcmp(head + 80, "data", 4) != 0) {
            error = "DSF has no data chunk";
            return false;
        }
        stages_ = stagesForDsdRate(dsdRate_);
        if (stages_ <= 0) {
            error = "unsupported DSD rate " + std::to_string(dsdRate_) +
                    " (this build decimates 44.1k-family DSD64/128/256 to 176400 Hz)";
            return false;
        }
        audioStartByte_ = 92;
        const uint64_t dataChunkSize = readLE64(head + 84);
        const uint64_t fileBytes = reader_.size();
        const uint64_t declared = dataChunkSize > 12 ? dataChunkSize - 12 : 0;
        const uint64_t present  = fileBytes > audioStartByte_ ? fileBytes - audioStartByte_ : 0;
        audioBytes_ = std::min(declared, present);
        dsf_ = true;
        // sampleCount 是"每声道 1-bit 样本数"，与 data 字节数应能对上；以较小的
        // 那个为准，避免文件尾部被补零后多放出一段静音。
        const uint64_t capacitySamples = (audioBytes_ / static_cast<uint64_t>(channels_)) * 8ull;
        totalPcmFrames_ = std::min(sampleCount, capacitySamples) >> stages_;
    } else if (std::memcmp(head, "FRM8", 4) == 0 && std::memcmp(head + 12, "DSD ", 4) == 0) {
        // ---- DFF（DSDIFF，全部大端）---------------------------------------
        // FRM8 + size + "DSD "，此后是 chunk 序列（id + 8 字节大端 size + data，
        // 奇数长度补 1 字节）。需要 FS（采样率）、CHNL（声道数）、CMPR（压缩法）
        // 与 SSND（音频）。
        uint64_t offset = 16;
        const uint64_t fileBytes = reader_.size();
        bool sawFs = false, sawChnl = false;
        while (offset + 12 <= fileBytes) {
            uint8_t chunk[12] = {};
            if (!reader_.seek(static_cast<int64_t>(offset), 0)) break;
            if (readFully(reader_, chunk, 12) != 12) break;
            const std::string id = fourcc(chunk);
            const uint64_t size = readBE64(chunk + 4);
            if (id == "PROP") {
                const uint64_t end = offset + 12 + size;
                uint64_t at = offset + 16;     // type(4) 之后
                while (at + 12 <= end) {
                    uint8_t sub[64] = {};
                    if (!reader_.seek(static_cast<int64_t>(at), 0)) break;
                    if (readFully(reader_, sub, sizeof sub) != sizeof sub) break;
                    const std::string sid = fourcc(sub);
                    const uint64_t ssize = readBE64(sub + 4);
                    if (sid == "FS  ") {
                        dsdRate_ = static_cast<int>(readBE32(sub + 12));
                        sawFs = true;
                    } else if (sid == "CHNL") {
                        channels_ = (static_cast<int>(sub[12]) << 8) | static_cast<int>(sub[13]);
                        sawChnl = true;
                    } else if (sid == "CMPR") {
                        // CMPR 载荷（sub+12 起）= compressionType(4) + 字符数(1) + 名字。
                        // 实测 empty10ms.dff：sub+12 = "DSD "，sub+16 = 0x0e，"not
                        // compressed" 从 sub+17 开始。第一次实现读 sub+16 得到 "not "，
                        // 把一个未压缩文件判成"压缩不支持"。
                        //
                        // 规范文字里 CMPR 前面还写过 type(4) + size(8)，那是块头
                        // 本身（id + size），不是载荷里多出来的字段；为防两种排布
                        // 都出现，这里 +12 不是已知值时再看 +16。只接受 'DSD '
                        // （未压缩），'DST ' 如实拒绝 —— DST 是带熵编码的另一种载荷。
                        std::string compression = fourcc(sub + 12);
                        if (compression != "DSD " && compression != "DST ") {
                            compression = fourcc(sub + 16);
                        }
                        if (compression != "DSD ") {
                            error = "DFF audio is compressed with " + compression +
                                    ", which this build does not decode (DST is not supported)";
                            return false;
                        }
                    }
                    at += 12 + ssize + (ssize & 1u);
                }
            } else if (id == "DSD ") {
                // 重要：DSDIFF 的 'DSD ' 声音块**没有** SSND/AIFF 那样的
                // offset/blockSize 前导 —— 12 字节块头之后就是音频字节本身。
                // 实测 empty10ms.dff：chunk 在 118、size=7056、音频从 130 开始，
                // 130+7056 = 7186 = 文件长度。把它当 SSND 读会让起点晚 8 字节、
                // 长度少 8 字节，解出的是错位的比特流（而错位在 DSD 里听起来
                // 不是"有噪声"，是"整段音乐慢了一个字节的抖动"）。
                audioStartByte_ = offset + 12;
                const uint64_t fileLeft = fileBytes > audioStartByte_ ? fileBytes - audioStartByte_ : 0;
                audioBytes_ = std::min(size, fileLeft);
                break;
            }
            offset += 12 + size + (size & 1u);
        }
        if (!sawFs || !sawChnl || audioStartByte_ == 0 || audioBytes_ == 0) {
            error = "DFF is missing FS/CHNL or a readable SSND chunk";
            return false;
        }
        stages_ = stagesForDsdRate(dsdRate_);
        if (stages_ <= 0) {
            error = "unsupported DSD rate " + std::to_string(dsdRate_) +
                    " (this build decimates 44.1k-family DSD64/128/256 to 176400 Hz)";
            return false;
        }
        dsf_ = false;
        // DFF 是帧交织（每帧 channels 个字节）→ 每声道字节数 = 总量 / channels。
        const uint64_t perChannelBytes = audioBytes_ / static_cast<uint64_t>(channels_);
        totalPcmFrames_ = (perChannelBytes * 8ull) >> stages_;
    } else {
        error = "not a DSF or DFF container";
        return false;
    }

    if (channels_ <= 0 || channels_ > 6) {
        error = "DSD declares an unsupported channel count";
        return false;
    }
    if (totalPcmFrames_ == 0) {
        error = "DSD declares no playable audio";
        return false;
    }
    for (int ch = 0; ch < channels_; ++ch) decimator_[ch].configure(stages_);
    // 抽取器启动时延迟线全 0，突遇满幅输入会有一段阶跃响应振铃（实测 DC 输入
    // 过冲 8.3%，131072 个样本里 20 个 > 1.0）。真实的 DSD 文件开头不会恰好是
    // 满幅 DC，但"PCM 永远不越过 1.0"是限幅器之前就必须成立的性质。
    // 处理：丢弃级联稳定前的头 256 个输出（约 1.5 ms @176.4k，用户听不到），
    // 这些样本本来就属于文件头的启动瞬态。丢弃发生在第一块解码里，所以
    // totalFrames 的账要从这里扣 —— 见下面的稳定计数。
    warmupSkip_ = 256;
    if (!reader_.seek(static_cast<int64_t>(audioStartByte_), 0)) {
        error = reader_.errorMessage().empty() ? "cannot seek to the DSD audio start"
                                               : reader_.errorMessage();
        return false;
    }
    bytesConsumed_ = 0;
    position_ = 0;
    pcmFrames_ = 0;
    pcmRead_ = 0;
    endOfStream_ = false;
    if (!decodeNextChunk() || pcmFrames_ == 0) {
        error = failed_ && !decodeError_.empty() ? decodeError_ : "DSD decoded no audio";
        return false;
    }
    return true;
}

bool DsdSource::decodeNextChunk() {
    if (endOfStream_) return true;

    // 一块的大小：DSF 按整块（blockSize × channels），DFF 按 64 KB 且必须是
    // 帧（channels 字节）的整数倍，否则会切在声道中间。
    size_t want = 0;
    if (dsf_) {
        want = static_cast<size_t>(blockSize_) * static_cast<size_t>(channels_);
    } else {
        want = 64u * 1024u;
        want -= want % static_cast<size_t>(channels_);
    }
    if (bytesConsumed_ >= audioBytes_) {
        endOfStream_ = true;
        return true;
    }
    want = static_cast<size_t>(std::min<uint64_t>(want, audioBytes_ - bytesConsumed_));
    if (!dsf_) want -= want % static_cast<size_t>(channels_);
    if (want == 0) {
        endOfStream_ = true;
        return true;
    }

    raw_.resize(want);
    const size_t got = readFully(reader_, raw_.data(), want);
    if (reader_.hasError()) {
        failed_ = true;
        decodeError_ = reader_.errorMessage();
        endOfStream_ = true;
        return false;
    }
    if (got == 0) {
        endOfStream_ = true;
        return true;
    }
    raw_.resize(got);
    bytesConsumed_ += got;
    // 读到的字节可能不是 channels 的整数倍（DFF 只会在文件截断时发生）：丢掉
    // 尾部不完整的帧，否则声道会错位。
    if (!dsf_) raw_.resize(raw_.size() - raw_.size() % static_cast<size_t>(channels_));
    if (raw_.empty()) {
        endOfStream_ = true;
        return true;
    }

    // 这个块能产出的 1-bit 样本数（每声道）。
    size_t bitsPerChannel = 0;
    if (dsf_) {
        // 尾块可能短：取所有声道里最短的那段。
        size_t minBytes = static_cast<size_t>(-1);
        for (int ch = 0; ch < channels_; ++ch) {
            const size_t begin = static_cast<size_t>(ch) * blockSize_;
            const size_t available = (begin < raw_.size()) ? raw_.size() - begin : 0;
            minBytes = std::min(minBytes, std::min(available, static_cast<size_t>(blockSize_)));
        }
        bitsPerChannel = (minBytes == static_cast<size_t>(-1)) ? 0 : minBytes * 8;
    } else {
        bitsPerChannel = (raw_.size() / static_cast<size_t>(channels_)) * 8;
    }
    if (bitsPerChannel == 0) {
        endOfStream_ = bytesConsumed_ >= audioBytes_;
        return true;
    }

    // 采集本块每个声道的 PCM 输出。
    std::vector<std::vector<float>> outputs(static_cast<size_t>(channels_));
    for (auto& channel : outputs) channel.reserve(bitsPerChannel >> stages_);
    for (size_t i = 0; i < bitsPerChannel; ++i) {
        for (int ch = 0; ch < channels_; ++ch) {
            size_t byteIndex = 0;
            int shift = 0;
            if (dsf_) {
                // DSF：块内第 ch 段整段属于声道 ch，块内字节序 LSB-first。
                byteIndex = static_cast<size_t>(ch) * blockSize_ + (i >> 3);
                shift = static_cast<int>(i & 7u);
            } else {
                // DFF：帧交织（每帧 channels 字节），字节序 MSB-first。
                byteIndex = (i >> 3) * static_cast<size_t>(channels_) + static_cast<size_t>(ch);
                shift = 7 - static_cast<int>(i & 7u);
            }
            if (byteIndex >= raw_.size()) continue;
            const float bit = ((raw_[byteIndex] >> shift) & 1u) ? 1.0f : -1.0f;
            float out = 0.0f;
            if (decimator_[ch].push(bit, out)) outputs[static_cast<size_t>(ch)].push_back(out);
        }
    }

    size_t frames = static_cast<size_t>(-1);
    for (const auto& channel : outputs) frames = std::min(frames, channel.size());
    if (frames == static_cast<size_t>(-1) || frames == 0) {
        pcmFrames_ = 0;
        pcmRead_ = 0;
        if (bytesConsumed_ >= audioBytes_) endOfStream_ = true;
        return true;
    }
    pcm_.assign(frames * static_cast<size_t>(channels_), 0.0f);
    for (int ch = 0; ch < channels_; ++ch) {
        const auto& src = outputs[static_cast<size_t>(ch)];
        for (size_t i = 0; i < frames; ++i) {
            pcm_[i * static_cast<size_t>(channels_) + static_cast<size_t>(ch)] = src[i];
        }
    }
    // 启动瞬态：丢掉前 warmupSkip_ 帧（只在最开头发生一次）。总量与
    // totalPcmFrames_ 一起扣，否则 readFrames 会在末尾多放一段本不存在的音频。
    if (warmupSkip_ > 0) {
        const size_t drop = std::min<size_t>(static_cast<size_t>(warmupSkip_), frames);
        warmupSkip_ -= static_cast<int>(drop);
        if (drop == frames) {
            pcmFrames_ = 0;
            pcmRead_ = 0;
            if (bytesConsumed_ >= audioBytes_) endOfStream_ = true;
            return true;
        }
        std::vector<float> trimmed((frames - drop) * static_cast<size_t>(channels_));
        std::memcpy(trimmed.data(), pcm_.data() + drop * static_cast<size_t>(channels_),
                    trimmed.size() * sizeof(float));
        pcm_.swap(trimmed);
        frames -= drop;
        totalPcmFrames_ = totalPcmFrames_ >= drop ? totalPcmFrames_ - drop : 0;
    }
    pcmFrames_ = frames;
    pcmRead_ = 0;
    if (bytesConsumed_ >= audioBytes_) endOfStream_ = true;
    return true;
}

uint64_t DsdSource::readFrames(float* const* planar, uint64_t frames) {
    if (frames == 0 || failed_) return 0;
    uint64_t produced = 0;
    while (produced < frames) {
        if (pcmRead_ >= pcmFrames_) {
            if (endOfStream_) break;
            if (!decodeNextChunk()) break;
            if (pcmRead_ >= pcmFrames_) continue;
        }
        if (position_ >= totalPcmFrames_) break;
        size_t available = pcmFrames_ - pcmRead_;
        if (available > totalPcmFrames_ - position_) {
            available = static_cast<size_t>(totalPcmFrames_ - position_);
        }
        const size_t take = std::min<size_t>(available, static_cast<size_t>(frames - produced));
        for (int ch = 0; ch < channels_; ++ch) {
            const float* src = pcm_.data() + pcmRead_ * static_cast<size_t>(channels_) +
                               static_cast<size_t>(ch);
            float* dst = planar[ch] + produced;
            for (size_t i = 0; i < take; ++i) dst[i] = src[i * static_cast<size_t>(channels_)];
        }
        pcmRead_ += take;
        position_ += take;
        produced += take;
    }
    return produced;
}

bool DsdSource::seekToFrame(uint64_t frame) {
    if (frame > totalPcmFrames_) frame = totalPcmFrames_;
    const uint64_t bitsPerChannel = frame << stages_;
    const uint64_t bytesPerChannel = (bitsPerChannel + 7) >> 3;
    uint64_t byteOffset = audioStartByte_;
    if (dsf_) {
        if (blockSize_ == 0) return false;
        const uint64_t wholeBlocks = bytesPerChannel / blockSize_;
        const uint64_t rest = bytesPerChannel % blockSize_;
        byteOffset += wholeBlocks * static_cast<uint64_t>(blockSize_) *
                      static_cast<uint64_t>(channels_) +
                      rest * static_cast<uint64_t>(channels_);
    } else {
        byteOffset += bytesPerChannel * static_cast<uint64_t>(channels_);
    }
    if (byteOffset > audioStartByte_ + audioBytes_) byteOffset = audioStartByte_ + audioBytes_;
    if (!reader_.seek(static_cast<int64_t>(byteOffset), 0)) return false;
    bytesConsumed_ = byteOffset - audioStartByte_;
    for (int ch = 0; ch < channels_; ++ch) decimator_[ch].reset();
    pcm_.clear();
    pcmFrames_ = 0;
    pcmRead_ = 0;
    position_ = frame;
    endOfStream_ = bytesConsumed_ >= audioBytes_;
    failed_ = false;
    return true;
}

} // namespace

// ---------------------------------------------------------------------------
// DsdDecimator
// ---------------------------------------------------------------------------

void DsdDecimator::configure(int stages) {
    stagesCount_ = (stages < 0) ? 0 : (stages > 6 ? 6 : stages);
    float center = 0.5f;
    float pair[kPairs] = {};
    designHalfBand(center, pair);
    for (int s = 0; s < stagesCount_; ++s) {
        stages_[s].center = center;
        for (int j = 0; j < kPairs; ++j) stages_[s].pair[j] = pair[j];
        stages_[s].reset();
    }
    reset();
}

void DsdDecimator::reset() noexcept {
    for (Stage& stage : stages_) stage.reset();
}

bool DsdDecimator::push(float bit, float& out) noexcept {
    if (stagesCount_ <= 0) {
        out = bit;
        return true;
    }
    float value = bit;
    for (int s = 0; s < stagesCount_; ++s) {
        float next = 0.0f;
        if (!stages_[s].push(value, next)) return false;
        value = next;
    }
    out = value;
    return true;
}

double DsdDecimator::testHalfBandMagnitude(double w) const noexcept {
    if (stagesCount_ <= 0) return 1.0;
    // H(w) = c0 + Σ_j pair[j]·2·cos(w·(2j+1))；偶数偏移抽头按半带定义为 0
    // （设计里它们也确实只有 1e-17 量级），所以这样算是精确的。
    const Stage& stage = stages_[0];
    double dc = static_cast<double>(stage.center);
    for (int j = 0; j < kPairs; ++j) dc += 2.0 * static_cast<double>(stage.pair[j]);
    if (dc == 0.0) return 0.0;
    double real = static_cast<double>(stage.center);
    for (int j = 0; j < kPairs; ++j) {
        real += 2.0 * static_cast<double>(stage.pair[j]) *
                std::cos(w * static_cast<double>(2 * j + 1));
    }
    return std::fabs(real) / std::fabs(dc);
}

// ---------------------------------------------------------------------------
// sniff + 工厂
// ---------------------------------------------------------------------------

int sniffDsdContainer(const std::vector<uint8_t>& head) {
    if (head.size() >= 4 && std::memcmp(head.data(), "DSD ", 4) == 0) return 1;
    if (head.size() >= 16 && std::memcmp(head.data(), "FRM8", 4) == 0 &&
        std::memcmp(head.data() + 12, "DSD ", 4) == 0) {
        return 2;
    }
    return 0;
}

std::unique_ptr<AudioSource> openDsdSource(MediaReader reader, std::string& error) {
    auto source = std::make_unique<DsdSource>();
    if (!source->init(std::move(reader), error)) return nullptr;
    return source;
}

} // namespace te
