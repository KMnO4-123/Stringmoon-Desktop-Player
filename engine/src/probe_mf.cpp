// probe_mf.cpp -- what Media Foundation can ACTUALLY decode on this machine.
//
// Why this exists: the L1 format list (SPEC 3.8) still owes AAC and ALAC, and
// both live in MP4 containers that Windows is supposed to decode for us.
// "Windows 10 ships an AAC decoder" is a statement about a platform, not about
// this machine -- and the difference decides whether the feature can be built at
// all or has to be reported as ERR_UNSUPPORTED. Guessing either way would put a
// claim in the protocol that nothing here supports.
//
// The enumeration is deliberately of ALL audio codecs rather than a list of
// codecs I expected to find: a list I wrote myself would only confirm my own
// assumptions, and the one that matters (ALAC) is exactly the one I am least
// sure about.
//
// Read-only by default. With --write-tone <path.m4a> it also encodes two seconds
// of a 1 kHz tone to a REAL AAC file, because the alternative is testing the MP4
// path against files that do not exist: this machine contains no .m4a at all,
// and "no test material" is how the MP3 gap stayed invisible behind 407 green
// assertions.

#include <windows.h>
#include <shellapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <mftransform.h>

#include <cmath>
#include <filesystem>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "util.hpp"
#include "win_util.hpp"

namespace te {
namespace {

// The 4-character codec codes packed into the standard audio-subtype GUID
// shape. Spelled out rather than taken from the SDK headers, which only carry
// the newer codecs on newer SDK versions -- and a compile error there would look
// like "this machine cannot do ALAC", which is the opposite of the truth.
const GUID kSubtypeALAC = {0x00006C61, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};

std::string guidToString(const GUID& g) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
                  g.Data1, g.Data2, g.Data3, g.Data4[0], g.Data4[1], g.Data4[2],
                  g.Data4[3], g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7]);
    return buf;
}

// Media Foundation writes audio subtypes as the classic GUID shape with the
// 16-bit codec tag in the low word of Data1. Spelling the tag out avoids
// depending on SDK headers that only carry the newer codecs on newer versions.
std::string subtypeLabel(const GUID& g) {
    // MFTEnumEx reports the input-tuple starting with the MAJOR type, so the
    // first entry of every blob is 'auds' (0x73647561). Naming it is the
    // difference between a readable list and one where every codec looks like it
    // has an extra unknown member in front of it.
    if (g == MFMediaType_Audio) return "MAJOR:audio";
    if (g == MFMediaType_Video) return "MAJOR:video";
    if (g == MFMediaType_Stream) return "MAJOR:stream";
    if (g.Data2 != 0x0000 || g.Data3 != 0x0010) return guidToString(g);
    switch (g.Data1 & 0xFFFF) {
    case 0x0001: return "PCM";
    case 0x0003: return "IEEE float";
    case 0x0050: return "MPEG";
    case 0x0055: return "MP3";
    case 0x00FF: return "AAC (raw)";
    case 0x1610: return "AAC";
    case 0x0161: return "WMA v2";
    case 0x0162: return "WMA Pro";
    case 0x0163: return "WMA Lossless";
    case 0x2000: return "Dolby AC-3";
    case 0x6C61: return "ALAC";
    case 0xF1AC: return "FLAC";
    case 0x674F: return "Ogg Vorbis";
    case 0x704F: return "Opus";
    default: break;
    }
    char buf[32];
    std::snprintf(buf, sizeof buf, "tag 0x%04X", g.Data1 & 0xFFFF);
    return buf;
}

std::vector<GUID> guidBlob(IMFAttributes* attrs, REFGUID key) {
    std::vector<GUID> out;
    UINT32 size = 0;
    if (!attrs || FAILED(attrs->GetBlobSize(key, &size)) || size < sizeof(GUID)) return out;
    std::vector<BYTE> raw(size);
    UINT32 got = 0;
    if (FAILED(attrs->GetBlob(key, raw.data(), size, &got)) || got < sizeof(GUID)) return out;
    const size_t n = got / sizeof(GUID);
    const GUID* p = reinterpret_cast<const GUID*>(raw.data());
    out.assign(p, p + n);
    return out;
}

std::string friendlyName(IMFAttributes* attrs) {
    WCHAR buf[256] = {};
    UINT32 len = 0;
    if (attrs && SUCCEEDED(attrs->GetString(MFT_FRIENDLY_NAME_Attribute, buf,
                                            ARRAYSIZE(buf) - 1, &len)) && len > 0) {
        std::string s;
        for (UINT32 i = 0; i < len; ++i) s.push_back(buf[i] < 128 ? static_cast<char>(buf[i]) : '?');
        return s;
    }
    return "(unnamed)";
}

void listTransforms(const char* title, GUID category, REFGUID directionKey) {
    IMFActivate** acts = nullptr;
    UINT32 count = 0;
    const UINT32 flags = MFT_ENUM_FLAG_ALL;
    std::fprintf(stderr, "\n=== %s ===\n", title);
    if (FAILED(MFTEnumEx(category, flags, nullptr, nullptr, &acts, &count)) || count == 0) {
        std::fprintf(stderr, "  (none)\n");
        return;
    }
    for (UINT32 i = 0; i < count; ++i) {
        IMFAttributes* attrs = acts[i];
        const std::vector<GUID> types = guidBlob(attrs, directionKey);
        std::string joined;
        for (size_t k = 0; k < types.size(); ++k) {
            if (k) joined += ", ";
            joined += subtypeLabel(types[k]);
        }
        std::fprintf(stderr, "  %-28s %s\n", joined.c_str(), friendlyName(attrs).c_str());
        acts[i]->Release();
    }
    CoTaskMemFree(acts);
}

// Two seconds of a 1 kHz sine at -6 dBFS, encoded by the OS AAC encoder into a
// real MP4 container. Deterministic, tiny (~30 KB), and produced by the same
// platform that will have to decode it.
HRESULT writeTone(const std::wstring& path, REFGUID codec) {
    constexpr UINT32 kRate      = 44100;
    constexpr UINT32 kChannels  = 2;
    constexpr UINT32 kSeconds   = 2;
    constexpr UINT32 kBitrate   = 16000;   // 128 kbps

    IMFAttributes* attrs = nullptr;
    HRESULT hr = MFCreateAttributes(&attrs, 1);
    if (FAILED(hr)) return hr;
    attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);

    IMFSinkWriter* writer = nullptr;
    hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, attrs, &writer);
    attrs->Release();
    if (FAILED(hr)) { std::fprintf(stderr, "  MFCreateSinkWriterFromURL: %s\n", hresultToString(hr).c_str()); return hr; }

    IMFMediaType* outType = nullptr;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outType->SetGUID(MF_MT_SUBTYPE, codec);
    outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    outType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, kRate);
    outType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, kChannels);
    if (codec == MFAudioFormat_AAC) {
        outType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kBitrate);
        outType->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);
        outType->SetUINT32(MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29);   // AAC-LC
    } else {
        // ALAC is lossless: bytes-per-second is a consequence, not a setting.
        outType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kRate * kChannels * 2);
        outType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, kChannels * 2);
    }
    DWORD stream = 0;
    hr = writer->AddStream(outType, &stream);
    outType->Release();
    if (FAILED(hr)) { std::fprintf(stderr, "  AddStream: %s\n", hresultToString(hr).c_str()); writer->Release(); return hr; }

    IMFMediaType* inType = nullptr;
    MFCreateMediaType(&inType);
    inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    inType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    inType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    inType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, kRate);
    inType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, kChannels);
    inType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, kChannels * 2);
    inType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kRate * kChannels * 2);
    inType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    hr = writer->SetInputMediaType(stream, inType, nullptr);
    inType->Release();
    if (FAILED(hr)) { std::fprintf(stderr, "  SetInputMediaType: %s\n", hresultToString(hr).c_str()); writer->Release(); return hr; }

    hr = writer->BeginWriting();
    if (FAILED(hr)) { std::fprintf(stderr, "  BeginWriting: %s\n", hresultToString(hr).c_str()); writer->Release(); return hr; }

    const UINT32 framesPerBuffer = 1024;
    const UINT32 totalFrames = kRate * kSeconds;
    const LONGLONG frameDuration = 10000000LL / kRate;
    std::vector<INT16> pcm(static_cast<size_t>(framesPerBuffer) * kChannels);
    LONGLONG rtStart = 0;
    double phase = 0.0;

    for (UINT32 done = 0; done < totalFrames; done += framesPerBuffer) {
        UINT32 frames = framesPerBuffer;
        if (done + frames > totalFrames) frames = totalFrames - done;
        for (UINT32 i = 0; i < frames; ++i) {
            // -6 dBFS: leaves headroom so nothing here depends on the encoder's
            // handling of full scale.
            const double v = 0.5 * std::sin(phase);
            phase += 2.0 * 3.14159265358979323846 * 1000.0 / static_cast<double>(kRate);
            if (phase > 2.0 * 3.14159265358979323846) phase -= 2.0 * 3.14159265358979323846;
            const INT16 s = static_cast<INT16>(v * 32767.0);
            for (UINT32 ch = 0; ch < kChannels; ++ch) pcm[static_cast<size_t>(i) * kChannels + ch] = s;
        }
        const DWORD bytes = frames * kChannels * sizeof(INT16);

        IMFMediaBuffer* buffer = nullptr;
        IMFSample* sample = nullptr;
        MFCreateSample(&sample);
        MFCreateMemoryBuffer(bytes, &buffer);
        BYTE* dst = nullptr;
        buffer->Lock(&dst, nullptr, nullptr);
        std::memcpy(dst, pcm.data(), bytes);
        buffer->Unlock();
        buffer->SetCurrentLength(bytes);
        sample->AddBuffer(buffer);
        sample->SetSampleTime(rtStart);
        sample->SetSampleDuration(static_cast<LONGLONG>(frames) * frameDuration);
        hr = writer->WriteSample(stream, sample);
        sample->Release();
        buffer->Release();
        if (FAILED(hr)) { std::fprintf(stderr, "  WriteSample: %s\n", hresultToString(hr).c_str()); writer->Release(); return hr; }
        rtStart += static_cast<LONGLONG>(frames) * frameDuration;
    }

    hr = writer->Finalize();
    writer->Release();
    return hr;
}

} // namespace

int runMediaFoundationProbe(int argc, char** argv) {
    // MFStartup needs COM on the calling thread. A different apartment model is
    // not an error here -- something else already initialised it.
    const HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    std::fprintf(stderr, "=== Media Foundation ===\n");
    const HRESULT startHr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
    std::fprintf(stderr, "  CoInitializeEx : %s\n", hresultToString(comHr).c_str());
    std::fprintf(stderr, "  MFStartup      : %s\n", hresultToString(startHr).c_str());
    if (FAILED(startHr)) return 1;

    // Echo the command line back. A diagnostic that silently ignores an argument
    // it was given is worse than one that refuses it: the first run of
    // --write-tone produced no file and no message, and the reason was that the
    // process never saw the flag.
    std::fprintf(stderr, "  argc=%d", argc);
    for (int i = 0; i < argc; ++i) std::fprintf(stderr, " [%d]=%s", i, argv[i]);
    std::fprintf(stderr, "\n");

    listTransforms("audio decoders (input subtype -> name)",
                   MFT_CATEGORY_AUDIO_DECODER, MFT_INPUT_TYPES_Attributes);
    listTransforms("audio encoders (input subtype -> name)",
                   MFT_CATEGORY_AUDIO_ENCODER, MFT_INPUT_TYPES_Attributes);

    // Which codec the tone is encoded with. Getting BOTH matters: AAC proves the
    // lossy half of the MP4 path and ALAC proves the lossless half, and this
    // machine has an encoder for each -- so neither has to be argued from a
    // platform claim.
    GUID codec = MFAudioFormat_AAC;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--codec") == 0 && i + 1 < argc) {
            if (std::strcmp(argv[i + 1], "alac") == 0) codec = kSubtypeALAC;
            else if (std::strcmp(argv[i + 1], "aac") == 0) codec = MFAudioFormat_AAC;
        }
    }

    // THE PATH MUST NOT COME FROM argv.
    //
    // On Windows a console program receives argv in the ACTIVE ANSI CODE PAGE,
    // so a path inside a Chinese folder arrives as bytes that are already wrong.
    // Feeding those bytes to fromUtf8() -- the project's UTF-8 helper -- asks it
    // to decode a code page as UTF-8, which is not a wrong answer but an
    // ill-formed one: std::filesystem::path throws, the exception is uncaught,
    // and the process fail-fasts with 0xC0000409 and NO output at all. That is
    // how this probe behaved the first time it was pointed at a real folder, and
    // a diagnostic that dies silently on a bad argument is worse than one that
    // refuses it.
    //
    // The engine itself has never had this problem because paths reach it over
    // stdin as UTF-8 JSON, not as command-line arguments. This tool is the only
    // place a path arrives on the command line, so this is the only place that
    // has to ask Windows for the real UTF-16 command line.
    std::vector<std::wstring> wideArgs;
    int wideArgc = 0;
    if (LPWSTR* wideArgv = CommandLineToArgvW(GetCommandLineW(), &wideArgc)) {
        for (int i = 0; i < wideArgc; ++i) wideArgs.emplace_back(wideArgv[i]);
        LocalFree(wideArgv);
    }

    int rc = 0;
    for (size_t i = 1; i + 1 < wideArgs.size(); ++i) {
        if (wideArgs[i] != L"--write-tone") continue;
        const std::filesystem::path target(wideArgs[i + 1]);   // already wide: no conversion, nothing to throw
        std::fprintf(stderr, "\n=== writing a real test file ===\n");
        std::fprintf(stderr, "  target: %s\n", toUtf8(target).c_str());
        std::fprintf(stderr, "  codec : %s\n", subtypeLabel(codec).c_str());
        try {
            std::error_code ec;
            std::filesystem::create_directories(target.parent_path(), ec);
            const HRESULT hr = writeTone(target.wstring(), codec);
            std::fprintf(stderr, "  encode : %s\n", hresultToString(hr).c_str());
            if (FAILED(hr)) rc = 1;
        } catch (const std::exception& e) {
            // Report, never fail-fast: an uncaught exception here exits with a
            // code and no explanation, which reads exactly like "the encoder is
            // missing" when the encoder is fine.
            std::fprintf(stderr, "  encode : threw %s\n", e.what());
            rc = 1;
        }
    }

    MFShutdown();
    if (SUCCEEDED(comHr)) CoUninitialize();
    return rc;
}

} // namespace te
