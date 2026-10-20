#pragma once
// Streaming decode + stream resampling (SPEC 3.4 names SoXR for this job).
//
// Why streaming rather than "decode the file, then play it": a 96 kHz stereo
// FLAC in this library is about 178 MB once decoded to float32. Whole-file
// decode needs both the source and the resampled copy resident, which peaks
// near 360 MB and walks straight through the SPEC 8.2 engine budget of 60 MB
// RSS. Pulling a few thousand frames at a time keeps the footprint flat
// regardless of track length.
//
// The source reader picks its decoder from the container, so a WAV dropped
// into the folder scans and plays through the same path as FLAC.

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include "media_reader.hpp"

namespace te {

class AudioSource {
public:
    virtual ~AudioSource() = default;

    // Reads up to frames per channel into the supplied planar buffers.
    // Returns the number of frames produced; 0 means end of stream.
    virtual uint64_t readFrames(float* const* planar, uint64_t frames) = 0;
    virtual bool     seekToFrame(uint64_t frame) = 0;

    virtual int      sampleRate() const  = 0;
    virtual int      channels() const    = 0;
    virtual int      bitDepth() const    = 0;
    virtual uint64_t totalFrames() const = 0;

    // A zero-frame read normally means EOF. Streaming readers also need a
    // distinct failure bit so a lost HTTP response cannot be mistaken for a
    // clean end of the song.
    virtual bool        hasError() const { return false; }
    virtual std::string errorMessage() const { return {}; }

    // Is the file's OWN codec lossless? The decoder answers, because the
    // decoder is the only thing that knows: FLAC never is lossy, but a .wav can
    // carry ADPCM or A-law inside a container that looks lossless from outside,
    // and MP3 reconstructs a signal rather than retrieving one. This is the sole
    // input to state.sourceExact, and getting it wrong is not a cosmetic bug:
    // sourceExact=true on a lossy file tells the user their chain is fine when
    // the file is what it is, and sourceExact=false on a lossless one sends them
    // hunting for a defect that does not exist.
    virtual bool     lossless() const    = 0;

    // 哪个解码器解开了这个文件（CR-032 / state.source.decoder）。默认值
    // "native" 对绝大多数源是对的；系统兜底与 DSD 各自覆盖它。为什么要暴露：
    // 用户问"这个 .opus 是谁解的"时，答案决定了他该不该怀疑音质——系统解码器
    // 与自带解码器的行为不同，而文件名里的扩展名说不了这件事。
    virtual const char* decoderName() const { return "native"; }

    // CR-032: DSD 源需要如实说明"这是 1-bit 源，抽取到 PCM 了"。
    // state.sampleRate 仍然报抽取后的 PCM 率 —— 下游（重采样/bit-perfect/独占
    // 协商）因此一行都不用改；这两个字段只用于 state.source 的如实回读。
    virtual const char* sourceFormat() const { return "pcm"; }
    virtual int         dsdRate() const { return 0; }

    uint64_t durationMs() const {
        return sampleRate() > 0 ? (totalFrames() * 1000ull) / static_cast<uint64_t>(sampleRate()) : 0;
    }
};

// Opens a file, choosing the decoder from the container. Returns nullptr and
// fills error when the file cannot be read or is not a supported stream.
std::unique_ptr<AudioSource> openAudioSource(const std::filesystem::path& file, std::string& error);

// Can this build actually DECODE this file? (CR-017)
//
// Admitting a file to the library is a claim that it can be played, and only
// the decoders can answer that. The catalog's extension list is a filter, not a
// capability: it accepts .opus, and this build has no Opus decoder, so before
// CR-017 those files entered the library and failed on the user's first click --
// exactly the "unplayable track" complaint. (Ogg Vorbis and Ogg FLAC used to be
// in that same state; both decode now, which is why the answer has to stay a
// question asked of the decoders rather than a list of claims.)
//
// Deliberately implemented by OPENING the file through the production path and
// closing it again, rather than by re-listing the supported formats. A second
// list would be a second thing to keep in sync, and it would be wrong the first
// time a decoder is added -- which is precisely what happened when Ogg support
// landed.
//
// Costs one real decode-open (header parse + first frame), so it is opt-in at
// the call site. Touches no output device: no WASAPI, no audio.
bool isDecodable(const std::filesystem::path& file, std::string& reason);

// Diagnostic-only trace of the production dr_flac callback pattern. It does not
// open an output device or emit audio; the result is used to size a streaming
// reader's prefetch window from an observed request sequence rather than a guess.
bool traceFlacReader(const std::filesystem::path& file, ReaderTrace& trace,
                     std::string& error);

// Decodes a FLAC TWICE -- once through the production file-handle path and once
// through dr_flac's whole-file-in-memory entry point -- and compares the two s32
// streams sample-for-sample, sequentially and after seeks.
//
// Why this exists: the decoder module's most dangerous change (reading through a
// file handle instead of a heap copy of the whole file) is INVISIBLE to every
// other check in the suite. Those check properties -- codec, rate, depth, total
// frames, lossless -- and the DSP golden tests run on synthetic data. Nothing
// compared decoded SAMPLES. A reader that dropped a block, or a seek callback
// that landed a byte off, would have kept 462 assertions green.
//
// Both sides use the SAME production callbacks and the same dr_flac, so the only
// variable is where the bytes come from and the comparison is exact integer
// equality rather than a tolerance. Returns false with error set on divergence.
bool verifyDecoderAgainstMemory(const std::filesystem::path& file,
                                uint64_t& framesCompared,
                                uint64_t& seeksChecked,
                                uint64_t& seeksRefusedPastEnd,
                                uint64_t& firstDiffFrame,
                                std::string& error);

// MP4 (AAC / ALAC) via Media Foundation. Separate from openAudioSource because
// this one is handed a PATH, not bytes: it must not copy the container into
// memory, so the caller decides to use it BEFORE doing any whole-file read.
std::unique_ptr<AudioSource> openMp4Source(const std::filesystem::path& file, std::string& error);

// Releases the process-wide Media Foundation runtime if the MP4 decoder started
// it. Must only run once every source from openMp4Source has been destroyed: a
// live IMFSourceReader outliving MFShutdown is a teardown-order fault, which is
// the class of fault this project already paid for once.
void shutdownMediaFoundation();

// ---------------------------------------------------------------------------
// CR-024: 重采样器可配置（对标 ECHO NEXT 的 ECHO SRC 档位）
// ---------------------------------------------------------------------------
//
// 默认值必须与既定链路逐字节等价：VHQ(28-bit) + 线性相位(50) + 非 steep。
// 这些档位只在"源率 != 流率"时才有听觉意义——同率时 configure() 直接返回
// passthrough，SoXR 根本不会被创建（SPEC 3.4）。
//
// 语义来源（soxr.h）：
//   quality  = 重建精度：VHQ=28-bit / HQ=20-bit / 24BIT=24-bit（正好匹配 24-bit 素材）
//   phase    = 相位响应 0(minimum)…50(linear)…100(maximum)，最小相位没有 pre-ringing，
//              代价是相位非线性；线性相位保相位但冲激前有 pre-ringing。
//   steep    = SOXR_STEEP_FILTER：更陡的过渡带，阻带抑制更好、时域振铃更长。
enum class ResamplerQuality : int { VHQ = 0, HQ = 1, Bit24 = 2 };
enum class ResamplerPhase : int { Linear = 0, Minimum = 1, Intermediate = 2, Maximum = 3 };

struct ResamplerConfig {
    ResamplerQuality quality = ResamplerQuality::VHQ;
    ResamplerPhase   phase   = ResamplerPhase::Linear;
    bool             steep   = false;
    bool operator==(const ResamplerConfig& other) const {
        return quality == other.quality && phase == other.phase && steep == other.steep;
    }
    bool operator!=(const ResamplerConfig& other) const { return !(*this == other); }
};

// 线上拼写（state.resampler 用）。定义放在 .cpp 里，与枚举同处，避免两处漂移。
const char* resamplerQualityName(ResamplerQuality quality) noexcept;
const char* resamplerPhaseName(ResamplerPhase phase) noexcept;

// One-way pull that converts a source stream to the device rate and channel
// layout. Identical rates bypass SoXR entirely (SPEC 3.4: same rate, skip it).
class Resampler {
public:
    Resampler() = default;
    ~Resampler();

    Resampler(const Resampler&)            = delete;
    Resampler& operator=(const Resampler&) = delete;

    // Binds the source. Returns false if the converter cannot be created.
    // config 默认值 = 既定链路；显式传参才改变重建精度/相位/陡度。
    bool configure(AudioSource* source, int inRate, int outRate, int channels, std::string& error,
                   const ResamplerConfig& config = ResamplerConfig{});

    // Pulls up to outFrames per channel. out must have capacity for outFrames on
    // every channel. Returns frames written; 0 means end of stream.
    uint64_t pull(float* const* out, uint64_t outFrames);

    bool passthrough() const { return passthrough_; }
    bool isConfigured() const { return source_ != nullptr; }
    bool sourceFailed() const { return source_ && source_->hasError(); }
    std::string sourceError() const { return source_ ? source_->errorMessage() : std::string(); }

    // Discards buffered input/output and resumes reading from the source
    // position. Used after a seek: the ratio stays the same, only the phase of
    // the buffered tail is meaningless, and dropping it is cheaper than proving
    // it is still aligned.
    void resetBuffers();

private:
    uint64_t pullPassthrough(float* const* out, uint64_t outFrames);
    uint64_t pullResampled(float* const* out, uint64_t outFrames);

    void*        soxr_        = nullptr;   // soxr_t, opaque so this header stays clean
    AudioSource* source_      = nullptr;
    int          inRate_      = 0;
    int          outRate_     = 0;
    int          channels_    = 0;
    bool         passthrough_ = true;
    bool         inputDrained_ = false;
    bool         flushing_     = false;

    // Interleaved staging for SoXR, sized once in configure(). The engine's
    // internal representation is planar, SoXR's is interleaved, so both
    // directions need one conversion; these buffers are what keeps that
    // conversion off the allocator after startup.
    std::vector<float> inStage_;      // interleaved, feeding SoXR
    std::vector<float> outStage_;     // interleaved, produced by SoXR
    std::vector<float> planarScratch_;// planar, on loan from the source
    std::vector<float*> planarViews_; // stable channel views into planarScratch_
    size_t inValid_  = 0;             // frames of valid data in inStage_
    size_t outValid_ = 0;             // frames of converted data waiting in outStage_
    size_t outRead_  = 0;             // frames of outStage_ already handed out
};

} // namespace te
