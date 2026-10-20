#include "audio_source.hpp"
#include "media_reader.hpp"
// CR-032：系统解码兜底与 DSD。能力矩阵问的是"本机到底有什么解码器"，所以这个
// 头必须由解码模块自己引用，而不是让 UI 层去猜扩展名。
#include "dsd_source.hpp"
#include "mf_source.hpp"

#include <windows.h>

#include <cstdio>
#include <algorithm>
#include <cstring>
#include <limits>
#include <iterator>
#include <string_view>
#include <utility>

#include <soxr.h>

#include "util.hpp"

// These decoders are header-only. The implementations live in exactly this
// translation unit, and stdio is disabled in all of them: the engine opens the
// file itself, through a wide path, so a Chinese directory name cannot be
// mangled by the ANSI code page.
//
// DR_FLAC_NO_OGG is deliberately NOT defined. It would be the cheaper build, but
// it also removes Ogg-encapsulated FLAC -- the LOSSLESS half of what a .ogg file
// can contain. .ogg is the container, not the codec: it carries Vorbis (lossy) or
// FLAC (lossless), and which one it holds decides state.sourceExact. Turning the
// support on costs nothing at runtime for native FLAC files, because the Ogg
// layer is only layered in once dr_flac has seen the "OggS" capture pattern.
#define DR_FLAC_IMPLEMENTATION
#define DR_FLAC_NO_STDIO
#include "dr_flac.h"

#define DR_WAV_IMPLEMENTATION
#define DR_WAV_NO_STDIO
#include "dr_wav.h"

// MP3 has no container magic, so nothing can be decided about it by looking at
// the bytes -- it is opened and the decoder either finds a frame or does not.
//
// DR_MP3_FLOAT_OUTPUT is deliberately NOT defined. dr_mp3's own default is a
// 16-bit output path, and that is not a limitation to route around: MPEG-1
// Layer III reconstructs a 16-bit-scale signal, so "the decoder produced 16-bit
// samples" is a fact about the format. Turning the float path on would make the
// delivered values wider than the format's real resolution, and bitDepth() would
// then be a number the samples no longer support.
#define DR_MP3_IMPLEMENTATION
#define DR_MP3_NO_STDIO
#include "dr_mp3.h"

// stb_vorbis has no header, so the boundary is its own translation unit
// (src/stb_vorbis_shim.c). Only scalars and an opaque handle cross it -- the
// decoder's info struct is returned BY VALUE and is not mirrored here, because a
// re-declared struct that drifts by one field is silent corruption rather than a
// compile error. The pushdata API is the one used: its pull API only opens
// FILE*, which cannot serve a wide Chinese path or an HTTP URL, and both are
// things this reader must do.
extern "C" {
void* te_vorbis_open(const unsigned char* data, int len, int* used, int* error);
int   te_vorbis_need_more_data(void);
int   te_vorbis_decode(void* handle, const unsigned char* data, int len,
                       int* channels, void** output, int* samples);
void  te_vorbis_flush(void* handle);
void  te_vorbis_close(void* handle);
int   te_vorbis_sample_offset(void* handle);
int   te_vorbis_error(void* handle);
void  te_vorbis_stream_info(void* handle, int* sample_rate, int* channels);
}

namespace te {
namespace {

// Flac and Wav share almost everything; only the library calls differ, so the
// two readers are the same shape behind a small trait-like switch.
//
// Ogg appears here because .ogg is a CONTAINER, not a codec: the same extension
// carries Vorbis (lossy) and Ogg-encapsulated FLAC (lossless), and which one is
// inside decides both the decoder and what state.sourceExact has to say. They are
// separate values rather than "Ogg" plus a flag so the choice cannot be
// forgotten downstream -- and so a stream carrying neither (Opus is the common
// one) is NAMED instead of failing as noise.
enum class Container { Flac, Wav, IsoBmff, OggVorbis, OggFlac, OggOpus, OggUnknown };

bool sniffContainer(const std::vector<uint8_t>& bytes, Container& out) {
    static const char kFlacMagic[4]  = {'f', 'L', 'a', 'C'};
    static const char kRiffMagic[4]  = {'R', 'I', 'F', 'F'};
    static const char kWaveMagic[4]  = {'W', 'A', 'V', 'E'};
    static const char kOggMagic[4]   = {'O', 'g', 'g', 'S'};
    if (bytes.size() >= 4 && std::memcmp(bytes.data(), kFlacMagic, 4) == 0) { out = Container::Flac; return true; }
    if (bytes.size() >= 12 && std::memcmp(bytes.data(), kRiffMagic, 4) == 0 &&
        std::memcmp(bytes.data() + 8, kWaveMagic, 4) == 0) { out = Container::Wav; return true; }
    // "OggS" is the page capture pattern and page 0 is always the codec's
    // identification header -- but the codec identity sits a few bytes further
    // in, past the 27-byte page header and its lacing table. So this only says
    // "an Ogg stream starts here"; sniffOggCodec decides which one.
    if (bytes.size() >= 4 && std::memcmp(bytes.data(), kOggMagic, 4) == 0) {
        out = Container::OggUnknown;
        return true;
    }
    // ISO base media file format: 'ftyp' at offset 4 (.m4a / .mp4 / .aac-in-MP4).
    // Named explicitly so this build can say WHAT it found and does not decode,
    // rather than let it fall through to the MP3 attempt: an MP4 is full of byte
    // sequences that can pass for an MPEG frame sync, and dr_mp3 finding one
    // would "succeed" and play noise while reporting success.
    if (bytes.size() >= 12 && std::memcmp(bytes.data() + 4, "ftyp", 4) == 0) { out = Container::IsoBmff; return true; }
    // MP3 is not in this list on purpose: it has no magic number at offset 0
    // (it may start with ID3, with a frame, or with nothing at all). It cannot
    // be sniffed, so the caller tries it by opening it -- the only thing that can
    // tell a real frame header from a coincidence.
    return false;
}

// Which codec an "OggS" file carries. The identification packet is in the first
// page, so a page-sized window is decisive; returns false when the window does
// not contain one of the signatures this build can act on.
bool sniffOggCodec(const std::vector<uint8_t>& bytes, Container& out) {
    static const char kVorbis[7] = {'\x01', 'v', 'o', 'r', 'b', 'i', 's'};
    static const char kFlac[5]   = {'\x7f', 'F', 'L', 'A', 'C'};
    static const char kOpus[8]   = {'O', 'p', 'u', 's', 'H', 'e', 'a', 'd'};
    const auto has = [&bytes](const char* needle, size_t n) {
        return std::search(bytes.begin(), bytes.end(), needle, needle + n) != bytes.end();
    };
    if (has(kVorbis, sizeof(kVorbis))) { out = Container::OggVorbis; return true; }
    if (has(kFlac,   sizeof(kFlac)))   { out = Container::OggFlac;   return true; }
    // Recognised but not decoded: Opus in Ogg is common enough on streaming
    // endpoints that "not Vorbis or FLAC" deserves to say which one it was.
    if (has(kOpus, sizeof(kOpus)))     { out = Container::OggOpus;   return false; }
    return false;
}

// Reads up to maxBytes from the front of a local file or URL and reports its
// total size. The decoder sees the same bytes and same size in both backends.
long long readFileHead(MediaReader& reader, std::vector<uint8_t>& out,
                       size_t maxBytes, std::string& error) {
    const uint64_t size = reader.size();
    const size_t want = static_cast<size_t>(std::min<uint64_t>(maxBytes, size));
    out.resize(want);
    const size_t got = reader.read(out.data(), want);
    if (got != want) {
        error = reader.errorMessage().empty() ? "short read" : reader.errorMessage();
        return -1;
    }
    return static_cast<long long>(size);
}

// One seek body for all three decoders. dr_libs' origins and stdio's are the
// same three cases, but they are different enums with no guaranteed relationship,
// so they are mapped explicitly instead of assumed to share their values.
bool seekReader(MediaReader* r, int offset, int origin) {
    return r->seek(offset, origin);
}

size_t readerRead(void* user, void* out, size_t bytes) {
    return static_cast<MediaReader*>(user)->read(out, bytes);
}

size_t flacRead(void* user, void* out, size_t bytes) { return readerRead(user, out, bytes); }
drflac_bool32 flacSeek(void* user, int offset, drflac_seek_origin origin) {
    return seekReader(static_cast<MediaReader*>(user), offset, static_cast<int>(origin))
        ? DRFLAC_TRUE : DRFLAC_FALSE;
}
drflac_bool32 flacTell(void* user, drflac_int64* cursor) {
    auto* r = static_cast<MediaReader*>(user);
    *cursor = static_cast<drflac_int64>(r->tell());
    return DRFLAC_TRUE;
}

size_t wavRead(void* user, void* out, size_t bytes) { return readerRead(user, out, bytes); }
drwav_bool32 wavSeek(void* user, int offset, drwav_seek_origin origin) {
    return seekReader(static_cast<MediaReader*>(user), offset, static_cast<int>(origin))
        ? DRWAV_TRUE : DRWAV_FALSE;
}
drwav_bool32 wavTell(void* user, drwav_int64* cursor) {
    auto* r = static_cast<MediaReader*>(user);
    *cursor = static_cast<drwav_int64>(r->tell());
    return DRWAV_TRUE;
}

// dr_mp3 needs its own trio even though the bodies are the same: the function
// POINTER types differ (drmp3_bool32 vs drwav_bool32 return types are distinct
// types to a C++ compiler even when both are int32).
size_t mp3Read(void* user, void* out, size_t bytes) { return readerRead(user, out, bytes); }
drmp3_bool32 mp3Seek(void* user, int offset, drmp3_seek_origin origin) {
    return seekReader(static_cast<MediaReader*>(user), offset, static_cast<int>(origin))
        ? DRMP3_TRUE : DRMP3_FALSE;
}
drmp3_bool32 mp3Tell(void* user, drmp3_int64* cursor) {
    auto* r = static_cast<MediaReader*>(user);
    *cursor = static_cast<drmp3_int64>(r->tell());
    return DRMP3_TRUE;
}

// Converts one interleaved int32 chunk to planar float32.
inline void interleavedToPlanar(const int32_t* src, uint32_t channels, uint64_t frames,
                                float* const* planar) {
    constexpr float kScale = 1.0f / 2147483648.0f;
    for (uint32_t ch = 0; ch < channels; ++ch) {
        float* dst = planar[ch];
        const int32_t* s = src + ch;
        for (uint64_t i = 0; i < frames; ++i) dst[i] = static_cast<float>(s[i * channels]) * kScale;
    }
}

// MP3 arrives interleaved as float and there is no s32 reader to route it
// through (dr_mp3 offers f32 and s16 only, and s16 would mean two conversions to
// land where the chain already is).
inline void interleavedFloatToPlanar(const float* src, uint32_t channels, uint64_t frames,
                                     float* const* planar) {
    for (uint32_t ch = 0; ch < channels; ++ch) {
        float* dst = planar[ch];
        const float* s = src + ch;
        for (uint64_t i = 0; i < frames; ++i) dst[i] = s[i * channels];
    }
}

// Both readers own their byte buffer AND their reader before the decoder is
// given a pointer to either. Doing it in the other order is a live bug: dr_libs
// keeps pUserData verbatim, so handing it the address of a stack local leaves it
// reading through a dead frame as soon as decoding starts.
class FlacSource final : public AudioSource {
public:
    FlacSource() = default;
    ~FlacSource() override {
        // The decoder first, then the handle it reads through.
        if (handle_) drflac_close(handle_);
        reader_.close();
    }

    // Takes the handle by value and keeps it: from here the source owns it, so a
    // failed init still closes the file through the destructor rather than
    // leaking it or double-closing it.
    bool init(MediaReader reader, std::string& error) {
        reader_ = std::move(reader);

        handle_ = drflac_open(flacRead, flacSeek, flacTell, &reader_, nullptr);
        if (reader_.hasError()) { error = reader_.errorMessage(); return false; }
        if (!handle_) {
            error = "not decodable as FLAC";
            return false;
        }
        if (handle_->channels == 0 || handle_->channels > 8 || handle_->totalPCMFrameCount == 0) {
            error = "unsupported stream shape";
            return false;
        }
        bitDepth_ = static_cast<int>(handle_->bitsPerSample);
        return true;
    }

    uint64_t readFrames(float* const* planar, uint64_t frames) override {
        if (!handle_ || frames == 0) return 0;
        staging_.resize(static_cast<size_t>(frames) * handle_->channels);
        const uint64_t got = drflac_read_pcm_frames_s32(handle_, frames, staging_.data());
        if (reader_.hasError()) return 0;
        if (got) interleavedToPlanar(staging_.data(), handle_->channels, got, planar);
        return got;
    }

    bool seekToFrame(uint64_t frame) override {
        if (!handle_) return false;
        return drflac_seek_to_pcm_frame(handle_, frame) == DRFLAC_TRUE;
    }

    int      sampleRate() const override  { return static_cast<int>(handle_->sampleRate); }
    int      channels() const override    { return static_cast<int>(handle_->channels); }
    int      bitDepth() const override    { return bitDepth_; }
    uint64_t totalFrames() const override { return handle_->totalPCMFrameCount; }
    bool     lossless() const override    { return true; }   // FLAC is lossless by definition
    bool     hasError() const override    { return reader_.hasError(); }
    std::string errorMessage() const override { return reader_.errorMessage(); }

private:
    drflac*              handle_ = nullptr;
    MediaReader           reader_{};       // owned here; the decoder points at it
    std::vector<int32_t> staging_;
    int                  bitDepth_ = 0;
};

class WavSource final : public AudioSource {
public:
    WavSource() = default;
    ~WavSource() override {
        if (open_) drwav_uninit(&wav_);
        reader_.close();
    }

    bool init(MediaReader reader, std::string& error) {
        reader_ = std::move(reader);

        if (drwav_init(&wav_, wavRead, wavSeek, wavTell, &reader_, nullptr) != DRWAV_TRUE) {
            error = reader_.hasError() ? reader_.errorMessage() : "not decodable as WAV";
            return false;
        }
        open_ = true;
        if (reader_.hasError()) { error = reader_.errorMessage(); return false; }
        bitDepth_ = static_cast<int>(wav_.bitsPerSample);
        return true;
    }

    uint64_t readFrames(float* const* planar, uint64_t frames) override {
        if (!open_ || frames == 0) return 0;
        staging_.resize(static_cast<size_t>(frames) * wav_.channels);
        const uint64_t got = drwav_read_pcm_frames_s32(&wav_, frames, staging_.data());
        if (reader_.hasError()) return 0;
        if (got) interleavedToPlanar(staging_.data(), wav_.channels, got, planar);
        return got;
    }

    bool seekToFrame(uint64_t frame) override {
        if (!open_) return false;
        return drwav_seek_to_pcm_frame(&wav_, frame) == DRWAV_TRUE;
    }

    int      sampleRate() const override  { return static_cast<int>(wav_.sampleRate); }
    int      channels() const override    { return static_cast<int>(wav_.channels); }
    int      bitDepth() const override    { return bitDepth_; }
    uint64_t totalFrames() const override { return wav_.totalPCMFrameCount; }
    // A .wav is a container, not a promise. PCM and IEEE float inside it are
    // lossless; ADPCM, A-law and mu-law are not, and dr_wav decodes all of them.
    // translatedFormatTag is the tag AFTER a WAVE_FORMAT_EXTENSIBLE header is
    // resolved, so this stays right for the files that use the extensible form.
    bool     lossless() const override    { return wav_.translatedFormatTag == DR_WAVE_FORMAT_PCM ||
                                                   wav_.translatedFormatTag == DR_WAVE_FORMAT_IEEE_FLOAT; }
    bool     hasError() const override    { return reader_.hasError(); }
    std::string errorMessage() const override { return reader_.errorMessage(); }

private:
    drwav                wav_{};
    bool                 open_ = false;
    MediaReader           reader_{};
    std::vector<int32_t> staging_;
    int                  bitDepth_ = 0;
};

class Mp3Source final : public AudioSource {
public:
    Mp3Source() = default;
    ~Mp3Source() override {
        if (open_) drmp3_uninit(&mp3_);
        reader_.close();
    }

    bool init(MediaReader reader, std::string& error) {
        reader_ = std::move(reader);

        // drmp3_init keeps the pUserData pointer verbatim, so reader_ has to be
        // in place first -- the same ownership rule the FLAC and WAV sources
        // exist to enforce. The destructor uninitialises the decoder before the
        // handle it reads through is closed, so it never outlives its reader.
        if (drmp3_init(&mp3_, mp3Read, mp3Seek, mp3Tell, nullptr, &reader_, nullptr) != DRMP3_TRUE) {
            error = reader_.hasError() ? reader_.errorMessage() : "not decodable as MP3";
            return false;
        }
        open_ = true;

        if (mp3_.channels == 0 || mp3_.channels > 8 || mp3_.sampleRate == 0) {
            error = "unsupported stream shape";
            return false;
        }

        // dr_mp3 reports a frame count that INCLUDES the encoder delay and the
        // trailing padding, and its reader skips the former and clamps at the
        // latter (dr_mp3.h: "Includes delay and padding"). Reporting that raw
        // number as the track length would be wrong twice over:
        //
        //   * the duration would be long by one encoder delay -- 1105 frames is
        //     25 ms at 44.1 kHz, visible on a progress bar;
        //   * end-of-stream, which compares rendered frames against this number,
        //     would never be reached, because the reader stops early. The track
        //     would sit at 99% forever.
        //
        // What the reader actually hands out is exactly the audible part.
        drmp3_uint64 total = mp3_.totalPCMFrameCount;
        if (total == DRMP3_UINT64_MAX) {
            // dr_mp3 only learns the length during init when the stream carries a
            // Xing or Info header. A plain CBR stream carries neither -- 320 kbps
            // files written without one are common, and all five real MP3s on
            // this machine are exactly that -- so the length has to be counted.
            //
            // This is an O(file) walk, which is why dr_mp3 does not do it for
            // you. It is paid once per open, and it is not optional: this number
            // is what end-of-stream is compared against, so guessing it would
            // truncate the tail or leave the track stuck at 99% forever.
            total = drmp3_get_pcm_frame_count(&mp3_);
            if (reader_.hasError()) { error = reader_.errorMessage(); return false; }
            if (total == DRMP3_UINT64_MAX || total == 0) {
                error = "MP3 length could not be determined";
                return false;
            }
        }
        // Both are zero when there is no LAME tag to read them from. That is a
        // fact about the file, not a default we chose: a headerless MP3 really
        // does start with ~1105 samples of encoder delay that nobody recorded,
        // so it cannot be trimmed, and the track is reported at its full raw
        // length rather than at a length we made up.
        const drmp3_uint64 delay   = mp3_.delayInPCMFrames;
        const drmp3_uint64 padding = mp3_.paddingInPCMFrames;
        if (total <= delay + padding) {
            error = "MP3 holds no audible frames after encoder delay and padding";
            return false;
        }
        usableFrames_ = static_cast<uint64_t>(total - delay - padding);
        if (reader_.hasError()) { error = reader_.errorMessage(); return false; }
        return true;
    }

    uint64_t readFrames(float* const* planar, uint64_t frames) override {
        if (!open_ || frames == 0) return 0;
        staging_.resize(static_cast<size_t>(frames) * mp3_.channels);
        const uint64_t got = drmp3_read_pcm_frames_f32(&mp3_, frames, staging_.data());
        if (reader_.hasError()) return 0;
        if (got) interleavedFloatToPlanar(staging_.data(), mp3_.channels, got, planar);
        return got;
    }

    bool seekToFrame(uint64_t frame) override {
        if (!open_) return false;
        // dr_mp3 seeks in the same post-delay coordinates the reader emits, so
        // the frame index passes straight through -- but it must be clamped to
        // the audible length, not the padded one, or a seek to the end lands in
        // the padding and returns failure.
        if (frame > usableFrames_) frame = usableFrames_;
        return drmp3_seek_to_pcm_frame(&mp3_, frame) == DRMP3_TRUE;
    }

    int      sampleRate() const override  { return static_cast<int>(mp3_.sampleRate); }
    int      channels() const override    { return static_cast<int>(mp3_.channels); }
    // 16 is the real resolution of what this decoder produces (see the
    // DR_MP3_FLOAT_OUTPUT note at the top of the file). The dither decision
    // compares against this, so it has to be the decoder's actual width.
    int      bitDepth() const override    { return 16; }
    uint64_t totalFrames() const override { return usableFrames_; }
    // MPEG-1 Layer III throws information away and reconstructs an approximation.
    // No chain downstream can make the delivered samples equal the encoded ones,
    // because the encoded ones are not samples.
    bool     lossless() const override    { return false; }
    bool     hasError() const override    { return reader_.hasError(); }
    std::string errorMessage() const override { return reader_.errorMessage(); }

private:
    drmp3                mp3_{};
    bool                 open_ = false;
    MediaReader           reader_{};
    std::vector<float>   staging_;
    uint64_t             usableFrames_ = 0;
};

// ---------------------------------------------------------------------------
// Ogg paging
// ---------------------------------------------------------------------------
// An Ogg file is a sequence of pages, and every page header carries the decoder
// state that a seek needs: which logical stream it belongs to and the PCM frame
// count at the end of that page ("granule position"). Reading those directly is
// what makes length and seeking possible at all, because stb_vorbis' pushdata
// API -- the only one that can read through MediaReader -- reports neither.

constexpr size_t   kOggPageHeaderBytes = 27;
constexpr size_t   kOggHeadChunk       = 64u * 1024u;   // one Vorbis page is at most 64 KB
constexpr size_t   kOggHeaderCap       = 1024u * 1024u; // header set ceiling before giving up
constexpr size_t   kOggReadChunk       = 64u * 1024u;
constexpr size_t   kOggPacketCap       = 4u * 1024u * 1024u;
constexpr size_t   kOggProbeWindow     = 64u * 1024u;
constexpr size_t   kOggTailWindow      = 128u * 1024u;
constexpr uint64_t kOggPageStepBytes   = 8u * 1024u;
constexpr int      kOggMaxBackSteps    = 256;
// How much audio a seek may decode before giving up on its resynchronisation.
// One Vorbis page carries at most a couple of blocks, so this is several pages'
// worth of slack rather than a tuning knob.
constexpr uint64_t kMaxSeekSettleSamples = 65536;

uint32_t readLE32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

uint64_t readLE64(const uint8_t* p) {
    return static_cast<uint64_t>(readLE32(p)) | (static_cast<uint64_t>(readLE32(p + 4)) << 32);
}

// Ogg writes "no packet ends in this page" as all-ones rather than 0, and the
// difference matters: 0 is a legitimate granule position (the first page).
constexpr uint64_t kOggUnknownGranule = ~static_cast<uint64_t>(0);

struct OggPage {
    uint64_t offset    = 0;   // file offset of the 'O' in "OggS"
    uint64_t granule   = kOggUnknownGranule;
    uint32_t serial    = 0;
    uint8_t  segments  = 0;
    uint16_t bodyBytes = 0;
    bool     continued = false;
};

// Recognises a page header. Only the fixed 27-byte part is required to be
// present: whether the lacing table and body fit in the buffer is the caller's
// question (a streaming scan can legitimately see a page cut in half).
bool parseOggPage(const uint8_t* data, size_t len, size_t at, uint64_t base, OggPage& out) {
    if (at + kOggPageHeaderBytes > len) return false;
    const uint8_t* p = data + at;
    if (p[0] != 'O' || p[1] != 'g' || p[2] != 'g' || p[3] != 'S') return false;
    if (p[4] != 0) return false;   // stream structure version, 0 in every real file
    out.offset    = base + at;
    out.granule   = readLE64(p + 6);
    out.serial    = readLE32(p + 14);
    out.segments  = p[26];
    out.continued = (p[5] & 0x01) != 0;
    out.bodyBytes = 0;
    return true;
}

// Total page body length from the lacing table. Fills `out.bodyBytes`; returns
// false when the table itself is not in the buffer yet.
bool readOggLacing(const uint8_t* data, size_t len, size_t at, OggPage& out) {
    const size_t table = static_cast<size_t>(out.segments);
    if (at + kOggPageHeaderBytes + table > len) return false;
    size_t total = 0;
    for (size_t i = 0; i < table; ++i) total += data[at + kOggPageHeaderBytes + i];
    out.bodyBytes = static_cast<uint16_t>(total);
    return true;
}

// stb_vorbis is the decoder because it is the only single-file, dependency-free
// Vorbis decoder with a streaming entry point, and streaming is the whole point:
// .ogg is the container streaming providers serve.
//
// Its pull API is unusable here (it only opens FILE*, which cannot take a wide
// Chinese path or an HTTP URL), so this drives the pushdata API and owns the
// paging. Two consequences follow, and both are handled rather than worked
// around:
//
//   * Pushdata knows neither the stream length nor how to seek. The length comes
//     from the granule position of the stream's last page. A seek bisects on page
//     granule positions, and then ASKS THE DECODER where it landed
//     (te_vorbis_sample_offset) before discarding the remainder -- the offset is
//     only trusted once the decoder has parsed a page that carries one, so the
//     seek verifies itself instead of assuming the arithmetic was right.
//
//   * Pushdata hands back whole packets, which run up to a Vorbis block (8192
//     frames), while the feeder asks for a few hundred. The tail of the packet is
//     staged until the next call. Nothing is re-decoded to serve it.
class OggVorbisSource final : public AudioSource {
public:
    OggVorbisSource() = default;
    ~OggVorbisSource() override {
        if (vorbis_) te_vorbis_close(vorbis_);
        reader_.close();
    }

    bool init(MediaReader reader, std::string& error) {
        reader_ = std::move(reader);
        if (!openDecoder(error)) return false;
        if (!readTotalFrames(error)) return false;
        // readTotalFrames seeks around the file. The sequential read has to
        // resume exactly where the buffered bytes end, or the first page after
        // the pre-buffered window would be skipped.
        if (!reader_.seek(static_cast<int64_t>(pending_.size()), 0)) {
            error = reader_.errorMessage().empty() ? "cannot rewind to the audio start"
                                                  : reader_.errorMessage();
            return false;
        }
        return true;
    }

    uint64_t readFrames(float* const* planar, uint64_t frames) override {
        if (!vorbis_ || frames == 0) return 0;
        uint64_t done = 0;
        while (done < frames) {
            if (frameOffset_ >= frameSamples_ && !decodeNextFrame()) break;
            // The granule position of the final page is the exact length. The
            // last packet still decodes a whole block past it, so the tail is
            // clamped here rather than by guessing where the file ends.
            if (position_ >= totalFrames_) break;
            uint64_t take = frameSamples_ - frameOffset_;
            if (take > frames - done) take = frames - done;
            if (take > totalFrames_ - position_) take = totalFrames_ - position_;
            for (uint32_t ch = 0; ch < channels_; ++ch) {
                const float* src = frame_.data() + static_cast<size_t>(ch) * frameSamples_ + frameOffset_;
                std::memcpy(planar[ch] + done, src, static_cast<size_t>(take) * sizeof(float));
            }
            frameOffset_ += static_cast<uint32_t>(take);
            position_    += take;
            done         += take;
        }
        return done;
    }

    bool seekToFrame(uint64_t frame) override {
        if (!vorbis_) return false;
        if (totalFrames_ != 0 && frame > totalFrames_) frame = totalFrames_;

        // Sample zero is exact and cheap: re-parsing the headers puts the
        // decoder at the first audio packet with no page arithmetic to get
        // wrong. It is also the common case (restarting a track).
        if (frame == 0) {
            std::string ignored;
            if (!openDecoder(ignored)) return false;
            if (!reader_.seek(static_cast<int64_t>(pending_.size()), 0)) return false;
            return true;
        }

        uint64_t searchFor = frame;
        for (int attempt = 0; attempt < 3; ++attempt) {
            OggPage page;
            if (!findSeekPage(searchFor, page)) break;
            if (!reader_.seek(static_cast<int64_t>(page.offset), 0)) return false;
            te_vorbis_flush(vorbis_);
            pending_.clear();
            pendingPos_ = 0;
            frameSamples_ = 0;
            frameOffset_ = 0;
            eof_ = false;

            const int64_t landed = locateAfterFlush(kMaxSeekSettleSamples);
            if (landed < 0) break;
            if (static_cast<uint64_t>(landed) <= frame) {
                // The staged frame ends at `landed`, so it is entirely before the
                // target and is dropped whole.
                frameSamples_ = 0;
                frameOffset_ = 0;
                position_ = static_cast<uint64_t>(landed);
                return skipFrames(frame - position_);
            }
            // Landed past the target: the page chosen began after it. Look
            // further back rather than discarding forward past the mark.
            searchFor = static_cast<uint64_t>(landed) - 1;
            if (page.offset <= audioStartByte_) break;
        }

        // The only always-correct method left: start from zero and walk forward.
        // Reached when a page seek cannot be verified at all (a damaged or
        // resynchronising stream), so it costs decode time but never plays the
        // wrong audio.
        std::string ignored;
        if (!openDecoder(ignored)) return false;
        if (!reader_.seek(static_cast<int64_t>(pending_.size()), 0)) return false;
        return skipFrames(frame);
    }

    int      sampleRate() const override  { return sampleRate_; }
    int      channels() const override    { return static_cast<int>(channels_); }
    // Vorbis reconstructs a signal from an MDCT, so it has no integer sample
    // width to report. 16 is the honest answer for the decisions this number
    // drives -- exclusive-mode negotiation and whether shared mode has to dither
    // -- and matches what the same number means for MP3: the format's real
    // resolution, not the container the decoder emits it in.
    int      bitDepth() const override    { return 16; }
    uint64_t totalFrames() const override { return totalFrames_; }
    // Vorbis is lossy by definition. Saying otherwise would tell the user their
    // chain is transparent when the file is what it is.
    bool     lossless() const override    { return false; }
    bool     hasError() const override    { return reader_.hasError() || failed_; }
    std::string errorMessage() const override {
        if (reader_.hasError()) return reader_.errorMessage();
        return failed_ ? decodeError_ : std::string();
    }

private:
    // ---- opening ---------------------------------------------------------

    // Appends up to `want` bytes to pending_. Returns false when nothing more
    // could be read; `error` is set only for a transport failure, so a clean end
    // of stream stays distinguishable from a lost connection.
    bool appendBytes(size_t want, std::string& error) {
        const size_t old = pending_.size();
        pending_.resize(old + want);
        const size_t got = reader_.read(pending_.data() + old, want);
        pending_.resize(old + got);
        if (reader_.hasError()) { error = reader_.errorMessage(); return false; }
        return got > 0;
    }

    bool openDecoder(std::string& error) {
        if (vorbis_) { te_vorbis_close(vorbis_); vorbis_ = nullptr; }
        pending_.clear();
        pendingPos_ = 0;
        frameSamples_ = 0;
        frameOffset_ = 0;
        position_ = 0;
        eof_ = false;
        failed_ = false;

        if (!reader_.seek(0, 0)) {
            error = reader_.errorMessage().empty() ? "cannot read this stream" : reader_.errorMessage();
            return false;
        }
        if (!appendBytes(kOggHeadChunk, error)) {
            if (error.empty()) error = "this Ogg file is empty";
            return false;
        }

        for (;;) {
            int used = 0, code = 0;
            vorbis_ = te_vorbis_open(pending_.data(), static_cast<int>(pending_.size()), &used, &code);
            if (vorbis_) {
                headerBytes_ = static_cast<uint64_t>(used);
                pendingPos_ = static_cast<size_t>(used);
                break;
            }
            if (code != te_vorbis_need_more_data()) {
                error = "not decodable as Ogg Vorbis (stb_vorbis error " + std::to_string(code) + ")";
                return false;
            }
            if (pending_.size() >= kOggHeaderCap) {
                error = "the Ogg Vorbis header set is larger than this decoder accepts";
                return false;
            }
            if (!appendBytes(kOggHeadChunk, error)) {
                if (error.empty()) error = "the Ogg Vorbis header set is incomplete";
                return false;
            }
        }

        int rate = 0, channels = 0;
        te_vorbis_stream_info(vorbis_, &rate, &channels);
        if (rate <= 0 || channels <= 0 || channels > 8) {
            error = "unsupported stream shape";
            return false;
        }
        sampleRate_ = rate;
        channels_   = static_cast<uint32_t>(channels);

        // The logical stream's serial number: every page that belongs to it
        // carries this, and a file can multiplex more than one stream.
        if (pending_.size() >= 18) serial_ = readLE32(pending_.data() + 14);

        // The first unconsumed byte is where audio begins. Pages are sought from
        // here rather than from zero, which also skips the header pages.
        audioStartByte_ = headerBytes_ > 0 ? headerBytes_ : 0;
        return true;
    }

    // ---- length ----------------------------------------------------------

    bool plausibleGranule(uint64_t granule) const {
        // Anything claiming more than 24 hours of audio is a granule read out of
        // a coincidental "OggS" inside compressed data, not a real file length.
        // The bound exists to reject those; it is not policing file sizes.
        const uint64_t ceiling = static_cast<uint64_t>(sampleRate_) * 60ull * 60ull * 24ull;
        return granule > 0 && granule <= ceiling;
    }

    bool lastGranulePos(uint64_t& out) {
        const uint64_t size = reader_.size();
        if (size < kOggPageHeaderBytes) return false;
        const uint64_t window = std::min<uint64_t>(size, kOggTailWindow);
        const uint64_t base   = size - window;
        if (!reader_.seek(static_cast<int64_t>(base), 0)) return false;
        std::vector<uint8_t> buf(static_cast<size_t>(window));
        size_t got = 0;
        while (got < buf.size()) {
            const size_t n = reader_.read(buf.data() + got, buf.size() - got);
            if (n == 0) break;
            got += n;
        }
        if (reader_.hasError() || got < kOggPageHeaderBytes) return false;
        buf.resize(got);

        // Backwards, because the answer is the LAST page. A candidate has to be
        // a well-formed header for OUR serial with a real granule position:
        // "OggS" is four bytes that can occur inside compressed audio, and a
        // length taken from one of those would be a duration read out of noise.
        for (size_t i = got - kOggPageHeaderBytes + 1; i-- > 0;) {
            OggPage page;
            if (!parseOggPage(buf.data(), got, i, base, page)) continue;
            if (!readOggLacing(buf.data(), got, i, page)) continue;
            if (page.serial != serial_) continue;
            if (page.granule == kOggUnknownGranule) continue;
            if (!plausibleGranule(page.granule)) continue;
            out = page.granule;
            return true;
        }
        return false;
    }

    // Fallback for a stream whose end cannot be reached by seeking (no known
    // length, e.g. a chunked HTTP response): walk the pages from the front and
    // keep the last granule position. Reads the whole file but decodes none of
    // it, which is the same order of cost as counting MP3 frames.
    bool walkGranulePos(uint64_t& out) {
        if (!reader_.seek(0, 0)) return false;
        std::vector<uint8_t> buf;
        uint64_t base = 0;
        uint64_t last = 0;
        bool any = false;
        for (;;) {
            const size_t old = buf.size();
            buf.resize(old + kOggReadChunk);
            const size_t got = reader_.read(buf.data() + old, kOggReadChunk);
            buf.resize(old + got);
            if (reader_.hasError()) return false;
            const bool eof = (got == 0);

            size_t i = 0;
            while (i + kOggPageHeaderBytes <= buf.size()) {
                OggPage page;
                if (!parseOggPage(buf.data(), buf.size(), i, base, page)) { ++i; continue; }
                const size_t table = kOggPageHeaderBytes + page.segments;
                if (i + table > buf.size()) break;                    // need more bytes
                if (!readOggLacing(buf.data(), buf.size(), i, page)) break;
                if (i + table + page.bodyBytes > buf.size()) break;    // need more bytes
                if (page.serial == serial_ && page.granule != kOggUnknownGranule) {
                    last = page.granule;
                    any = true;
                }
                i += table + page.bodyBytes;
            }
            if (eof) break;
            buf.erase(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(i));
            base += i;
            if (buf.size() > kOggPageHeaderBytes + 255 + 65535u) return false;  // refused to converge
        }
        if (!any || last == 0) return false;
        out = last;
        return true;
    }

    bool readTotalFrames(std::string& error) {
        uint64_t granule = 0;
        if (!lastGranulePos(granule) && !walkGranulePos(granule)) {
            error = "this Ogg stream does not report its length";
            return false;
        }
        if (granule == 0) { error = "this Ogg stream holds no audio"; return false; }
        totalFrames_ = granule;
        return true;
    }

    // ---- seeking ---------------------------------------------------------

    // Finds the next page of our stream at or after `from` and reads its
    // granule position. One seek, one bounded read.
    bool readPageFrom(uint64_t from, OggPage& out) {
        const uint64_t size = reader_.size();
        if (from >= size) return false;
        const uint64_t window = std::min<uint64_t>(size - from, kOggProbeWindow);
        if (!reader_.seek(static_cast<int64_t>(from), 0)) return false;
        probe_.assign(static_cast<size_t>(window), 0);
        size_t got = 0;
        while (got < probe_.size()) {
            const size_t n = reader_.read(probe_.data() + got, probe_.size() - got);
            if (n == 0) break;
            got += n;
        }
        if (reader_.hasError() || got < kOggPageHeaderBytes) return false;
        probe_.resize(got);

        for (size_t i = 0; i + kOggPageHeaderBytes <= got; ++i) {
            OggPage page;
            if (!parseOggPage(probe_.data(), got, i, from, page)) continue;
            if (page.serial != serial_) continue;
            if (!readOggLacing(probe_.data(), got, i, page)) continue;
            out = page;
            return true;
        }
        return false;
    }

    // Chooses the page to resume decoding from: the latest one that ENDS at or
    // before the target and does not begin mid-packet. Pages that continue a
    // packet are skipped because decoding one from the start of the page treats
    // the continuation as a fresh packet, and that packet decodes to noise.
    bool findSeekPage(uint64_t target, OggPage& out) {
        const uint64_t size = reader_.size();
        if (size <= audioStartByte_ + kOggPageHeaderBytes) return false;
        const uint64_t span = size - audioStartByte_;

        // Estimate: Vorbis is close enough to constant bitrate that the target's
        // fraction of the sample count is also its fraction of the bytes. The
        // estimate only has to be near -- the page walk below fixes the rest.
        uint64_t guess = audioStartByte_;
        if (totalFrames_ > 0) {
            const uint64_t whole = (span / totalFrames_) * target;
            const uint64_t frac  = ((span % totalFrames_) * target) / totalFrames_;
            guess = audioStartByte_ + std::min(whole + frac, span - 1);
        }

        for (int step = 0; step < kOggMaxBackSteps; ++step) {
            OggPage page;
            if (!readPageFrom(guess, page)) break;
            if (!page.continued && page.granule != kOggUnknownGranule && page.granule <= target) {
                out = page;
                return true;
            }
            if (page.offset <= audioStartByte_) break;
            guess = (page.offset > kOggPageStepBytes) ? page.offset - kOggPageStepBytes : audioStartByte_;
            if (guess < audioStartByte_) guess = audioStartByte_;
        }

        // Too far off for stepping: bisect the byte range on granule position.
        uint64_t lo = audioStartByte_;
        uint64_t hi = size;
        bool have = false;
        for (int iter = 0; iter < 40 && hi > lo + kOggPageStepBytes; ++iter) {
            const uint64_t mid = lo + (hi - lo) / 2;
            OggPage page;
            if (!readPageFrom(mid, page)) break;
            if (page.offset <= lo || page.offset >= hi) break;
            if (page.continued || page.granule == kOggUnknownGranule) { hi = page.offset; continue; }
            if (page.granule <= target) { lo = page.offset; out = page; have = true; }
            else                        { hi = page.offset; }
        }
        return have;
    }

    // Decodes until the decoder can report where it is, then throws away the
    // frame it produced (it lies entirely before that position). Returns -1 if
    // no granule position turned up within `limit` samples -- a resynchronisation
    // that never converged.
    int64_t locateAfterFlush(uint64_t limit) {
        uint64_t scanned = 0;
        for (;;) {
            const int offset = te_vorbis_sample_offset(vorbis_);
            if (offset >= 0) return offset;
            if (scanned > limit) return -1;
            if (!decodeNextFrame()) return -1;
            scanned += frameSamples_;
        }
    }

    // Advances the emission point by `count` samples, decoding and dropping them.
    // Used to close the gap between where a seek landed and where it was asked
    // to land: at most one page of audio after a verified page seek.
    bool skipFrames(uint64_t count) {
        uint64_t done = 0;
        while (done < count) {
            if (frameOffset_ >= frameSamples_ && !decodeNextFrame()) return false;
            uint64_t take = frameSamples_ - frameOffset_;
            if (take > count - done) take = count - done;
            frameOffset_ += static_cast<uint32_t>(take);
            position_    += take;
            done         += take;
        }
        return true;
    }

    // ---- decoding --------------------------------------------------------

    bool decodeNextFrame() {
        if (!vorbis_) return false;
        for (;;) {
            if (pendingPos_ >= pending_.size()) {
                if (eof_) return false;
                pending_.clear();
                pendingPos_ = 0;
                std::string ignored;
                if (!appendBytes(kOggReadChunk, ignored)) {
                    if (!reader_.hasError()) eof_ = true;
                    return false;
                }
                continue;
            }

            int channels = 0, samples = 0;
            void* output = nullptr;
            const size_t available = pending_.size() - pendingPos_;
            const int used = te_vorbis_decode(vorbis_, pending_.data() + pendingPos_,
                                              static_cast<int>(std::min(available, kOggPacketCap)),
                                              &channels, &output, &samples);
            if (used == 0) {
                // One packet does not fit in the bytes on hand. Vorbis does not
                // bound packet size, so the window grows -- with a ceiling, so a
                // corrupt file cannot grow it until the process dies.
                if (eof_) return false;
                if (pending_.size() >= kOggPacketCap) {
                    failed_ = true;
                    decodeError_ = "a packet in this Ogg stream is larger than this decoder accepts";
                    return false;
                }
                if (pendingPos_ > 0) {
                    pending_.erase(pending_.begin(), pending_.begin() + static_cast<std::ptrdiff_t>(pendingPos_));
                    pendingPos_ = 0;
                }
                std::string ignored;
                if (!appendBytes(kOggReadChunk, ignored)) {
                    if (!reader_.hasError()) eof_ = true;
                    return false;
                }
                continue;
            }
            pendingPos_ += static_cast<size_t>(used);
            if (samples == 0) continue;   // header, or a packet consumed resynchronising
            if (channels != static_cast<int>(channels_)) {
                failed_ = true;
                decodeError_ = "the Ogg stream changed its channel count mid-track";
                return false;
            }

            const size_t count = static_cast<size_t>(samples);
            frame_.resize(count * channels_);
            auto* planar = static_cast<float**>(output);
            for (uint32_t ch = 0; ch < channels_; ++ch) {
                std::memcpy(frame_.data() + static_cast<size_t>(ch) * count, planar[ch],
                            count * sizeof(float));
            }
            frameSamples_ = static_cast<uint32_t>(samples);
            frameOffset_  = 0;
            return true;
        }
    }

    void*                 vorbis_        = nullptr;
    MediaReader           reader_{};          // owned here; the decoder reads through it
    uint32_t              serial_        = 0;
    uint32_t              channels_      = 0;
    int                   sampleRate_    = 0;
    int                   bitDepth_      = 16;
    uint64_t              totalFrames_   = 0;
    uint64_t              headerBytes_   = 0;   // bytes the decoder owns after open
    uint64_t              audioStartByte_ = 0;  // first byte after the header set
    uint64_t              position_      = 0;   // absolute index of the next sample out
    std::vector<uint8_t>  pending_;           // fed to stb_vorbis, minus pendingPos_
    size_t                pendingPos_    = 0;
    std::vector<uint8_t>  probe_;             // seek probe window
    std::vector<float>    frame_;             // planar staging for the current packet
    uint32_t              frameSamples_  = 0;
    uint32_t              frameOffset_   = 0;
    bool                  eof_           = false;
    bool                  failed_        = false;
    std::string           decodeError_;
};

} // namespace

std::unique_ptr<AudioSource> openAudioSource(const std::filesystem::path& file, std::string& error) {
    error.clear();

    // Read a HEADER, not the file. The container decision is made before any
    // decoder is handed the path, because one outcome gives it to Media
    // Foundation -- which seeks the file itself, deliberately: media libraries
    // hand out .mp4 files of hundreds of MB and SPEC 8.2 gives the whole engine
    // process 60 MB.
    MediaReader reader;
    if (!reader.open(file)) { error = reader.errorMessage(); return nullptr; }
    std::vector<uint8_t> head;
    if (readFileHead(reader, head, 16, error) < 0) return nullptr;

    Container container{};
    bool named = sniffContainer(head, container);

    // .ogg is a container, so the codec identity is past the 27-byte page header
    // and its lacing table -- outside the 16-byte head above. Re-read once with a
    // page-sized window instead of guessing from the extension: the SAME extension
    // carries lossy Vorbis and lossless FLAC, and reporting the wrong one would
    // misreport state.sourceExact.
    if (named && container == Container::OggUnknown) {
        // readFileHead sizes its read from the FILE length and assumes it starts
        // at the beginning, so the 16 bytes already consumed have to be given
        // back: otherwise it asks for more than is left, gets a short read, and
        // reports that as a failure -- which silently turned every .ogg into
        // "carries neither Vorbis nor FLAC".
        if (reader.seek(0, 0)) {
            std::string codecError;
            if (readFileHead(reader, head, kOggHeadChunk, codecError) >= 0) {
                sniffOggCodec(head, container);
            }
        }
    }

    if (!reader.seek(0, 0)) {
        error = reader.errorMessage().empty() ? "cannot rewind this stream" : reader.errorMessage();
        return nullptr;
    }

    // CR-032: DSD (DSF / DFF) is decided by MAGIC, not by extension, exactly like
    // FLAC and WAV above -- an extension says what a file claims to be. The sniff
    // is on the same 16-byte head, so no extra read. Handing the reader over by
    // move is what keeps this path streaming: a DSD file is 60-500 MB and the
    // decimator pulls it a block at a time.
    // head may be shorter than 16 bytes for a truncated file, which is exactly why
    // the sniff takes the vector and checks its size instead of assuming one.
    if (sniffDsdContainer(head) != 0) {
        return openDsdSource(std::move(reader), error);
    }

    if (named && container == Container::IsoBmff) {
        reader.close();
        return openMp4Source(file, error);
    }

    // Ogg-encapsulated FLAC is still FLAC: dr_flac layers the Ogg pages on top of
    // the reader itself, so the existing source handles it unchanged and the Ogg
    // path needs no second FLAC implementation.
    if (named && container == Container::OggFlac) {
        auto flac = std::make_unique<FlacSource>();
        std::string initError;
        if (!flac->init(std::move(reader), initError)) {
            error = initError + ": " + toUtf8(file);
            return nullptr;
        }
        return flac;
    }

    if (named && container == Container::OggVorbis) {
        auto ogg = std::make_unique<OggVorbisSource>();
        std::string initError;
        if (!ogg->init(std::move(reader), initError)) {
            error = initError + ": " + toUtf8(file);
            return nullptr;
        }
        return ogg;
    }

    // A recognised Ogg stream this build cannot decode NATIVELY. Before saying
    // no, hand it to the system decoder fallback (CR-032): Windows ships an Opus
    // decoder, so "this build does not decode Opus" stopped being true the
    // moment the fallback landed. If the system has no decoder either, the
    // specific message below is still the right answer -- it names the codec
    // instead of pretending the bytes were a corrupt MPEG frame.
    if (named && (container == Container::OggOpus || container == Container::OggUnknown)) {
        reader.close();
        std::string mfError;
        if (auto viaSystem = openMfSource(file, mfError)) return viaSystem;
        error = std::string(container == Container::OggOpus
                                ? "this Ogg stream carries Opus, and the system decoder refused it"
                                : "this Ogg stream carries neither Vorbis, FLAC nor Opus")
              + " (native decoders: FLAC, WAV, MP3, Ogg Vorbis, Ogg FLAC, MP4 AAC/ALAC; "
                "system fallback: " + mfError + "): " + toUtf8(file);
        return nullptr;
    }

    // One handle per source, opened here and handed over by value: the source
    // keeps it, and there is exactly one close. The decoder is opened inside the
    // source AFTER the reader is in place, because dr_libs stores pUserData
    // verbatim -- handing it the address of a local is the live bug this
    // structure exists to prevent.
    if (named && container == Container::Flac) {
        auto flac = std::make_unique<FlacSource>();
        std::string initError;
        if (!flac->init(std::move(reader), initError)) {
            error = initError + ": " + toUtf8(file);
            return nullptr;   // the source still owns the handle and closes it
        }
        return flac;
    }

    if (named && container == Container::Wav) {
        auto wav = std::make_unique<WavSource>();
        std::string initError;
        if (!wav->init(std::move(reader), initError)) {
            error = initError + ": " + toUtf8(file);
            return nullptr;
        }
        return wav;
    }

    // Neither FLAC nor WAV by magic, and not an MP4. MP3 is decided by decoding.
    std::string mp3Error;
    {
        auto mp3 = std::make_unique<Mp3Source>();
        std::string initError;
        if (mp3->init(std::move(reader), initError)) return mp3;
        mp3Error = initError;
        // The reader is gone with the failed source; the fallback opens the path
        // itself (MF seeks the file, it never takes a byte buffer).
        reader = MediaReader();
    }

    // CR-032: LAST RESORT, and last on purpose. Every native decoder above is
    // tried first with the same bytes and the same header sniffing, so this
    // cannot change what any already-supported file decodes to -- it only
    // decides what happens to the files that used to fail here. The list is
    // reported honestly by --probe-format and by the failure message, because
    // "unplayable" without a reason is what this whole path exists to end.
    {
        std::string mfError;
        if (auto viaSystem = openMfSource(file, mfError)) return viaSystem;
        error = mp3Error + " (native decoders: FLAC, WAV, MP3, Ogg Vorbis/FLAC, MP4 AAC/ALAC; "
                "system fallback: " + mfError + "): " + toUtf8(file);
    }
    return nullptr;
}

bool isDecodable(const std::filesystem::path& file, std::string& reason) {
    reason.clear();
    std::string error;
    auto source = openAudioSource(file, error);
    if (!source) {
        reason = error.empty() ? "the decoder refused this file" : error;
        return false;
    }
    // A stream that reports no usable shape cannot be played either. The
    // decoders already reject these, but stating it here keeps the answer
    // "decodable" honest rather than merely "the constructor returned".
    if (source->sampleRate() <= 0 || source->channels() <= 0 || source->totalFrames() == 0) {
        reason = "the decoder found no playable audio in this file";
        return false;
    }
    // Destruction is the close: FlacSource/WavSource/Mp3Source own their reader
    // and Mp4Source releases its IMFSourceReader in close(). Letting the object
    // die here is what keeps a Media Foundation reader from outliving
    // MFShutdown (see the teardown note on openMp4Source).
    return true;
}

bool traceFlacReader(const std::filesystem::path& file, ReaderTrace& trace,
                     std::string& error) {
    trace = ReaderTrace{};

    MediaReader reader(&trace);
    if (!reader.open(file)) {
        error = reader.errorMessage();
        return false;
    }

    drflac* handle = drflac_open(flacRead, flacSeek, flacTell, &reader, nullptr);
    if (!handle) {
        error = reader.hasError() ? reader.errorMessage() : "not decodable as FLAC";
        reader.close();
        return false;
    }

    const uint32_t channels = handle->channels;
    const uint64_t chunkFrames = 8192;
    std::vector<int32_t> staging(static_cast<size_t>(chunkFrames) * channels);
    // Exercise the same random-access shape the decoder uses after a seek,
    // then return to the beginning for the sequential pass.
    if (handle->totalPCMFrameCount > 4096) {
        (void)drflac_read_pcm_frames_s32(handle, 1024, staging.data());
        (void)drflac_seek_to_pcm_frame(handle, handle->totalPCMFrameCount / 2);
        (void)drflac_read_pcm_frames_s32(handle, 1024, staging.data());
        (void)drflac_seek_to_pcm_frame(handle, 0);
    }
    for (;;) {
        const uint64_t got = drflac_read_pcm_frames_s32(handle, chunkFrames, staging.data());
        if (got == 0) break;
    }

    const bool ok = !reader.hasError();
    if (!ok) error = reader.errorMessage();
    drflac_close(handle);
    reader.close();
    return ok;
}

// ---------------------------------------------------------------------------
// Resampler
// ---------------------------------------------------------------------------

const char* resamplerQualityName(ResamplerQuality quality) noexcept {
    switch (quality) {
        case ResamplerQuality::HQ:    return "HQ";
        case ResamplerQuality::Bit24: return "24BIT";
        case ResamplerQuality::VHQ:
        default:                      return "VHQ";
    }
}

const char* resamplerPhaseName(ResamplerPhase phase) noexcept {
    switch (phase) {
        case ResamplerPhase::Minimum:      return "minimum";
        case ResamplerPhase::Intermediate: return "intermediate";
        case ResamplerPhase::Maximum:      return "maximum";
        case ResamplerPhase::Linear:
        default:                           return "linear";
    }
}

Resampler::~Resampler() {
    if (soxr_) soxr_delete(static_cast<soxr_t>(soxr_));
}

bool Resampler::configure(AudioSource* source, int inRate, int outRate, int channels,
                          std::string& error, const ResamplerConfig& config) {
    if (soxr_) {
        soxr_delete(static_cast<soxr_t>(soxr_));
        soxr_ = nullptr;
    }
    source_      = source;
    inRate_      = inRate;
    outRate_     = outRate;
    channels_    = channels;
    inValid_     = 0;
    outValid_    = 0;
    outRead_     = 0;
    inputDrained_ = false;
    flushing_     = false;
    // These buffers belong to the feeder's steady-state pull path. Release any
    // prior track's storage here, where allocation is already expected, so a
    // long track never grows a scratch buffer while it is being heard.
    inStage_.clear();
    outStage_.clear();
    planarScratch_.clear();
    planarViews_.clear();

    if (inRate == outRate) {
        // SPEC 3.4: same rate means skip the converter entirely. Not creating it
        // is both faster and removes any chance of a needless quality loss.
        passthrough_ = true;
        return true;
    }

    passthrough_ = false;
    soxr_error_t soxrError = nullptr;
    const soxr_io_spec_t io = soxr_io_spec(SOXR_FLOAT32_I, SOXR_FLOAT32_I);
    // 默认档（VHQ / linear / 非 steep）与上一轮链路逐字节等价：这是本命令的
    // 「默认值必须与现状等价」红线。VHQ=28-bit 精度；线性相位保相位、有 pre-ringing。
    // 用户可用 set_resampler 换档（CR-024）：HQ=20bit 省 CPU、24BIT=24bit 正好匹配
    // 24-bit 素材、minimum 相位没有 pre-ringing。这些只在「源率 != 流率」时生效。
    int recipe = SOXR_VHQ;
    switch (config.quality) {
        case ResamplerQuality::HQ:    recipe = SOXR_HQ; break;
        case ResamplerQuality::Bit24: recipe = SOXR_24_BITQ; break;
        case ResamplerQuality::VHQ:
        default:                      recipe = SOXR_VHQ; break;
    }
    const unsigned long qualityFlags = config.steep ? SOXR_STEEP_FILTER : 0ul;
    soxr_quality_spec_t quality = soxr_quality_spec(recipe, qualityFlags);
    switch (config.phase) {
        case ResamplerPhase::Minimum:      quality.phase_response = 0.0; break;
        case ResamplerPhase::Intermediate: quality.phase_response = 25.0; break;
        case ResamplerPhase::Maximum:      quality.phase_response = 100.0; break;
        case ResamplerPhase::Linear:
        default:                           quality.phase_response = 50.0; break;
    }
    const soxr_runtime_spec_t runtime = soxr_runtime_spec(1);

    soxr_ = soxr_create(static_cast<double>(inRate), static_cast<double>(outRate),
                        static_cast<unsigned>(channels), &soxrError, &io, &quality, &runtime);
    if (!soxr_ || soxrError) {
        error = std::string("cannot create the resampler: ") + soxr_strerror(soxrError);
        soxr_ = nullptr;
        return false;
    }

    // Sized for comfortable throughput without holding a track in memory: about
    // 46 ms of input per pull at 44.1 kHz.
    constexpr size_t kInFrames  = 2048;
    constexpr size_t kOutFrames = 4096;
    inStage_.assign(kInFrames * static_cast<size_t>(channels), 0.0f);
    outStage_.assign(kOutFrames * static_cast<size_t>(channels), 0.0f);
    planarScratch_.assign(kInFrames * static_cast<size_t>(channels), 0.0f);
    planarViews_.resize(static_cast<size_t>(channels));
    for (size_t ch = 0; ch < static_cast<size_t>(channels); ++ch) {
        planarViews_[ch] = planarScratch_.data() + ch * kInFrames;
    }
    return true;
}

void Resampler::resetBuffers() {
    inValid_  = 0;
    outValid_ = 0;
    outRead_  = 0;
    inputDrained_ = false;
    flushing_     = false;
    if (soxr_) soxr_clear(static_cast<soxr_t>(soxr_));
}

uint64_t Resampler::pull(float* const* out, uint64_t outFrames) {
    if (!source_ || outFrames == 0) return 0;
    return passthrough_ ? pullPassthrough(out, outFrames) : pullResampled(out, outFrames);
}

uint64_t Resampler::pullPassthrough(float* const* out, uint64_t outFrames) {
    return source_->readFrames(out, outFrames);
}

uint64_t Resampler::pullResampled(float* const* out, uint64_t outFrames) {
    soxr_t soxr = static_cast<soxr_t>(soxr_);
    const size_t chCount     = static_cast<size_t>(channels_);
    const size_t inCapacity  = inStage_.size() / chCount;
    const size_t outCapacity = outStage_.size() / chCount;

    uint64_t produced = 0;
    for (;;) {
        // 1. Hand out anything already converted. SoXR is interleaved and the
        //    engine is planar, so this is a deinterleave, one channel at a time.
        if (outRead_ < outValid_) {
            const size_t available = outValid_ - outRead_;
            const size_t want = static_cast<size_t>(std::min<uint64_t>(outFrames - produced, available));
            for (int ch = 0; ch < channels_; ++ch) {
                const float* src = outStage_.data() + static_cast<size_t>(ch);
                float* dst = out[ch] + produced;
                for (size_t i = 0; i < want; ++i) dst[i] = src[(outRead_ + i) * chCount];
            }
            outRead_  += want;
            produced  += want;
            if (produced == outFrames) return produced;
            continue;
        }

        // 2. Refill the input stage when it is empty.
        if (inValid_ == 0 && !inputDrained_) {
            const uint64_t got = source_->readFrames(planarViews_.data(), inCapacity);
            if (got == 0) {
                inputDrained_ = true;
            } else {
                // Interleave into the buffer SoXR consumes.
                for (size_t ch = 0; ch < chCount; ++ch) {
                    const float* src = planarViews_[ch];
                    for (uint64_t i = 0; i < got; ++i) {
                        inStage_[static_cast<size_t>(i) * chCount + ch] = src[i];
                    }
                }
                inValid_ = static_cast<size_t>(got);
            }
        }

        // 3. Feed SoXR. A NULL input is how the API is told the stream has
        //    ended, which lets it flush the tail of its filter instead of
        //    clipping the last few milliseconds off every track.
        if (inputDrained_ && inValid_ == 0 && flushing_ && outValid_ == outRead_) break;

        size_t idone = 0, odone = 0;
        soxr_error_t soxrError = soxr_process(
            soxr,
            inValid_ ? inStage_.data() : nullptr,
            inValid_,
            &idone,
            outStage_.data(), outCapacity,
            &odone);
        outRead_ = 0;
        outValid_ = odone;

        if (soxrError) {
            inputDrained_ = true;
            break;
        }

        if (idone > 0) {
            inValid_ -= idone;
            if (inValid_ > 0) {
                std::memmove(inStage_.data(),
                             inStage_.data() + idone * chCount,
                             inValid_ * chCount * sizeof(float));
            }
        }

        if (inValid_ == 0 && inputDrained_) flushing_ = true;

        // Two ways this loop can stall; both would spin the feeder thread
        // forever if they were not handled explicitly.
        if (odone == 0 && inValid_ == 0 && inputDrained_) break;   // SoXR has nothing left
        if (odone == 0 && idone == 0) break;                       // no progress either way
    }
    return produced;
}

// ---------------------------------------------------------------------------
// Does the file-handle path decode the same SAMPLES as the whole-file path?
// ---------------------------------------------------------------------------
//
// See the declaration in audio_source.hpp for why this exists. The short form:
// the switch from a heap copy of the whole file to a file handle is invisible to
// every property-based check in the suite, and it is the one change in this
// module that can silently alter what the user hears.
//
// Both sides deliberately use the SAME production callbacks (flacRead /
// flacSeek / flacTell) and the same dr_flac build. The only variable is where the
// bytes come from, so this compares integers exactly -- no tolerance, no
// floating point, no conversion in between.
bool verifyDecoderAgainstMemory(const std::filesystem::path& file,
                                uint64_t& framesCompared,
                                uint64_t& seeksChecked,
                                uint64_t& seeksRefusedPastEnd,
                                uint64_t& firstDiffFrame,
                                std::string& error) {
    framesCompared   = 0;
    seeksChecked     = 0;
    seeksRefusedPastEnd = 0;
    firstDiffFrame   = 0;

    // Reference: the OLD design, kept here on purpose. One buffer, no handle.
    std::vector<uint8_t> bytes;
    {
        MediaReader bulk;
        if (!bulk.open(file)) { error = "cannot open for the reference decode"; return false; }
        const uint64_t size = bulk.size();
        if (size == 0 || size > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
            error = "empty or unseekable file";
            return false;
        }
        bytes.resize(static_cast<size_t>(size));
        const size_t got = bulk.read(bytes.data(), bytes.size());
        if (bulk.hasError() || got != bytes.size()) { error = bulk.hasError() ? bulk.errorMessage() : "short read"; return false; }
    }

    MediaReader reader;
    if (!reader.open(file)) { error = "cannot open the file-handle decode"; return false; }

    drflac* prod = drflac_open(flacRead, flacSeek, flacTell, &reader, nullptr);
    drflac* ref  = drflac_open_memory(bytes.data(), bytes.size(), nullptr);
    if (!prod || !ref) {
        error = "dr_flac refused the stream on one of the two paths";
        if (prod) drflac_close(prod);
        if (ref)  drflac_close(ref);
        reader.close();
        return false;
    }

    bool ok = true;
    uint64_t refusedSeeks = 0;

    // The reader's byte ACCOUNTING is part of the contract: a handle path that
    // mis-tells its length produces a stream with the wrong frame count, and
    // everything downstream believes it (this library already contains one file
    // whose declared count is 23,040 frames longer than its audio).
    if (prod->totalPCMFrameCount != ref->totalPCMFrameCount ||
        prod->sampleRate  != ref->sampleRate ||
        prod->channels    != ref->channels    ||
        prod->bitsPerSample != ref->bitsPerSample) {
        error = "stream identity differs between the two byte sources";
        ok = false;
    }

    const uint32_t ch = prod->channels;
    const uint64_t kChunk = 8192;
    std::vector<int32_t> a(kChunk * ch), b(kChunk * ch);

    if (ok) {
        for (;;) {
            const uint64_t ga = drflac_read_pcm_frames_s32(prod, kChunk, a.data());
            const uint64_t gb = drflac_read_pcm_frames_s32(ref,  kChunk, b.data());
            if (ga != gb) { error = "decoded lengths diverge"; ok = false; break; }
            if (ga == 0) break;
            if (std::memcmp(a.data(), b.data(), sizeof(int32_t) * ga * ch) != 0) {
                for (uint64_t i = 0; i < ga * ch; ++i) {
                    if (a[i] != b[i]) { firstDiffFrame = framesCompared + i / ch; break; }
                }
                error = "decoded samples differ";
                ok = false;
                break;
            }
            framesCompared += ga;
        }
    }

    // Seeks are the half a sequential pass never exercises. An off-by-one in a
    // seek callback is audible while every property check stays green, so the
    // targets are spread across the file rather than grouped.
    if (ok && prod->totalPCMFrameCount > 60000) {
        const uint64_t total = prod->totalPCMFrameCount;
        const uint64_t targets[] = { total / 7, total / 3, total / 2,
                                     (total * 4) / 5, total - 4096 };
        for (const uint64_t t : targets) {
            // Ask BOTH, and say WHICH one refused. Treating a refusal by either
            // side as a failure made this report a false alarm on three files:
            // the last target is total-4096, and this library contains files
            // whose declared frame count over-runs their actual audio (one by
            // 23,040 frames), so a seek past the real end is refused -- by BOTH
            // decoders, identically, because the limitation is dr_flac's and not
            // the byte source's. Only an ASYMMETRIC refusal is a real finding.
            const drflac_bool32 okProd = drflac_seek_to_pcm_frame(prod, t);
            const drflac_bool32 okRef  = drflac_seek_to_pcm_frame(ref,  t);
            if (okProd != okRef) {
                error = "seek to frame " + std::to_string(t) +
                        " succeeded on one byte source and failed on the other";
                ok = false;
                break;
            }
            if (okProd != DRFLAC_TRUE) {
                // Past the real end of the audio on BOTH sides. Not a defect in
                // the reader; recorded so the count stays honest.
                ++refusedSeeks;
                continue;
            }
            const uint64_t ga = drflac_read_pcm_frames_s32(prod, 2048, a.data());
            const uint64_t gb = drflac_read_pcm_frames_s32(ref,  2048, b.data());
            if (ga != gb || (ga != 0 && std::memcmp(a.data(), b.data(),
                                                    sizeof(int32_t) * ga * ch) != 0)) {
                error = "samples after seek to frame " + std::to_string(t) + " differ";
                firstDiffFrame = t;
                ok = false;
                break;
            }
            ++seeksChecked;
        }
    }

    if (reader.hasError()) { error = reader.errorMessage(); ok = false; }
    drflac_close(prod);
    drflac_close(ref);
    reader.close();
    seeksRefusedPastEnd = refusedSeeks;
    return ok;
}

} // namespace te
