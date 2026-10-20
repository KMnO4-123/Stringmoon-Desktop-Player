// probe_exclusive.cpp -- a one-shot diagnostic for WASAPI exclusive mode.
//
// Why this exists: on this machine an exclusive stream initialises, reports a
// bit-perfect format, and then renders nothing -- the device never raises its
// buffer event. Every layer above reports success, so the failure is invisible
// from inside the engine. This walks the negotiation directly and reports, for
// each format and each buffer period, the three facts that separate the
// possibilities: did Initialize succeed, did Start succeed, and DID THE EVENT
// ACTUALLY FIRE.
//
// Those three are deliberately separate. 'Initialize succeeded' means the driver
// accepted the format. 'Start succeeded' means it accepted the stream. Neither
// implies the third, and only the third means audio can flow. An endpoint can
// pass the first two and still never signal, which is exactly the case here.
//
// Read-only with respect to the user's machine: it opens and stops its own
// stream and touches no files.

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <ksmedia.h>

#include <cstdio>
#include <string>
#include <vector>

#include "exclusive_format.hpp"
#include "util.hpp"
#include "win_util.hpp"

namespace te {
namespace {

struct Attempt {
    int    containerBits = 0;
    int    validBits = 0;
    double bufferMs = 0.0;
    HRESULT initHr = E_FAIL;
    HRESULT startHr = E_FAIL;
    int     fired = 0;
    int     waited = 0;
    UINT32  lastPadding = 0;    // what GetCurrentPadding reported at the last wake
    UINT32  bufferFrames = 0;   // the stream's buffer, for scale
};

std::string hrName(HRESULT hr) { return hresultToString(hr); }

// One full attempt: activate, initialise, bind the event, start, and then see
// whether the device actually signals anything.
Attempt tryFormat(IMMDevice* device, int rate, int channels, int containerBits, int validBits,
                  REFERENCE_TIME minPeriod, double bufferMs) {
    Attempt a;
    a.containerBits = containerBits;
    a.validBits = validBits;
    a.bufferMs = bufferMs;

    IAudioClient* client = nullptr;
    HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                                  reinterpret_cast<void**>(&client));
    if (FAILED(hr) || !client) { a.initHr = hr; return a; }

    const WAVEFORMATEXTENSIBLE want = teMakeExclusiveFormat(rate, containerBits, validBits, channels);

    const REFERENCE_TIME duration = static_cast<REFERENCE_TIME>(bufferMs * 10000.0);
    const REFERENCE_TIME period = duration;   // exclusive + EVENTCALLBACK requires equality

    hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            duration, period,
                            reinterpret_cast<const WAVEFORMATEX*>(&want), nullptr);
    a.initHr = hr;
    if (FAILED(hr)) {
        // AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED carries the aligned size the driver
        // wants, and the documented sequence is to retry with a FRESH client.
        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
            UINT32 frames = 0;
            if (SUCCEEDED(client->GetBufferSize(&frames)) && frames > 0) {
                const REFERENCE_TIME aligned = static_cast<REFERENCE_TIME>(
                    10000.0 * 1000.0 * frames / rate + 0.5);
                client->Release();
                client = nullptr;
                if (SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER,
                                              nullptr, reinterpret_cast<void**>(&client))) && client) {
                    a.bufferMs = static_cast<double>(aligned) / 10000.0;
                    hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                            aligned, aligned,
                                            reinterpret_cast<const WAVEFORMATEX*>(&want), nullptr);
                    a.initHr = hr;
                }
            }
        }
        if (FAILED(a.initHr)) { if (client) client->Release(); return a; }
    }

    HANDLE ev = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = client->SetEventHandle(ev);
    if (FAILED(hr)) { a.startHr = hr; ::CloseHandle(ev); client->Release(); return a; }

    IAudioRenderClient* render = nullptr;
    if (SUCCEEDED(client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&render))) && render) {
        UINT32 bufferFrames = 0;
        if (SUCCEEDED(client->GetBufferSize(&bufferFrames))) {
            BYTE* buf = nullptr;
            if (SUCCEEDED(render->GetBuffer(bufferFrames, &buf)) && buf) {
                // SILENT: this probe asks whether the device signals, not what
                // it sounds like, so it must not make noise on the user's desk.
                ::memset(buf, 0, static_cast<size_t>(bufferFrames) * want.Format.nBlockAlign);
                render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
            }
        }
        render->Release();
    }

    IAudioRenderClient* pump = nullptr;
    client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&pump));

    a.startHr = client->Start();
    if (SUCCEEDED(a.startHr)) {
        // The question this whole probe exists for.
        //
        // PUMP ON EVERY WAKE. The first version filled the buffer once before
        // Start and never again, so a driver that signals only when it is given
        // more data would look broken. Feeding it every time is what separates
        // "this driver never signals" from "this driver signals per period and
        // the caller stopped feeding it" -- and those two have opposite fixes.
        for (int i = 0; i < 12; ++i) {
            ++a.waited;
            const DWORD w = ::WaitForSingleObject(ev, 50);
            if (w != WAIT_OBJECT_0) continue;
            ++a.fired;
            UINT32 padding = 0;
            if (SUCCEEDED(client->GetCurrentPadding(&padding))) a.lastPadding = padding;
            UINT32 bufferFrames = 0;

            // EXCLUSIVE PERIODIC STREAMS DO NOT USE THE SHARED-MODE PADDING IDIOM.
            //
            // This used to feed the device only when padding < bufferFrames, which
            // is the shared-mode (FIFO) rule. An exclusive periodic stream reports
            // padding == the WHOLE buffer at every wake, so that test was never
            // true: the probe wrote one buffer before Start, never wrote again, and
            // the device stopped asking for more. It then reported 1 / 12 for an
            // endpoint the engine plays through continuously -- a clean, repeatable,
            // completely wrong answer about the hardware.
            //
            // The defect is the same one the engine itself had, and fixed first: on
            // each wake, write the entire buffer.
            if (pump && SUCCEEDED(client->GetBufferSize(&bufferFrames)) && bufferFrames > 0) {
                a.bufferFrames = bufferFrames;
                BYTE* buf = nullptr;
                if (SUCCEEDED(pump->GetBuffer(bufferFrames, &buf)) && buf) {
                    ::memset(buf, 0, static_cast<size_t>(bufferFrames) * want.Format.nBlockAlign);
                    pump->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
                }
            }
        }
        client->Stop();
    }
    if (pump) pump->Release();

    ::CloseHandle(ev);
    client->Release();
    return a;
}

} // namespace

int runExclusiveProbe() {
    ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                    __uuidof(IMMDeviceEnumerator),
                                    reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) {
        std::fprintf(stderr, "probe: no device enumerator (%s)\n", hrName(hr).c_str());
        return 2;
    }
    IMMDevice* device = nullptr;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device)) || !device) {
        std::fprintf(stderr, "probe: no default render endpoint\n");
        enumerator->Release();
        return 2;
    }
    enumerator->Release();

    IAudioClient* client = nullptr;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                                reinterpret_cast<void**>(&client))) || !client) {
        std::fprintf(stderr, "probe: cannot activate a client\n");
        device->Release();
        return 2;
    }

    REFERENCE_TIME defPeriod = 0, minPeriod = 0;
    client->GetDevicePeriod(&defPeriod, &minPeriod);
    WAVEFORMATEX* mix = nullptr;
    client->GetMixFormat(&mix);
    std::fprintf(stderr, "probe: default device period %.2f ms, minimum %.2f ms\n",
                 static_cast<double>(defPeriod) / 10000.0, static_cast<double>(minPeriod) / 10000.0);
    if (mix) {
        std::fprintf(stderr, "probe: mix format %lu Hz, %u ch, %u bits, tag 0x%04x\n",
                     mix->nSamplesPerSec, mix->nChannels, mix->wBitsPerSample, mix->wFormatTag);
    }
    const int rate = mix ? static_cast<int>(mix->nSamplesPerSec) : 48000;
    const int channels = mix ? static_cast<int>(mix->nChannels) : 2;
    if (mix) ::CoTaskMemFree(mix);
    client->Release();

    // The two things that could plausibly matter: which container the driver
    // will take, and how large a period it is willing to signal on. The second
    // is the interesting one -- a driver that ignores a tiny period would look
    // exactly like a broken exclusive path.
    struct Fmt { int container; int valid; };
    const Fmt formats[] = { {16, 16}, {24, 24}, {32, 24}, {32, 32} };

    std::vector<double> periods;
    const double minMs = minPeriod > 0 ? static_cast<double>(minPeriod) / 10000.0 : 3.0;
    periods.push_back(minMs);
    periods.push_back(minMs * 2);
    periods.push_back(minMs * 4);
    periods.push_back(20.0);
    periods.push_back(50.0);

    // The padding column is the one that was missing while this probe was lying
    // about the hardware: on an exclusive periodic stream it is the WHOLE buffer
    // at every wake, and seeing that next to "1 / 12" is what names the cause.
    std::fprintf(stderr, "\n  %-12s %-8s %-10s %-10s %-14s %s\n",
                 "container", "buffer", "Initialize", "Start", "event fired", "padding / buffer");
    std::fprintf(stderr, "  %s\n", std::string(80, '-').c_str());

    for (const Fmt& f : formats) {
        for (double ms : periods) {
            Attempt a = tryFormat(device, rate, channels, f.container, f.valid, minPeriod, ms);
            const bool initOk = SUCCEEDED(a.initHr);
            const bool startOk = SUCCEEDED(a.startHr);
            std::string fmtCol = std::to_string(f.container) + "-" + std::to_string(f.valid);
            std::string note;
            if (!initOk) note = hrName(a.initHr);
            else if (!startOk) note = hrName(a.startHr);
            else if (a.fired == 0) note = "NEVER SIGNALLED";
            std::fprintf(stderr, "  %-12s %-8.2f %-10s %-10s %-14s %s\n",
                         fmtCol.c_str(), a.bufferMs,
                         initOk ? "ok" : "FAIL",
                         startOk ? "ok" : "FAIL",
                         (std::to_string(a.fired) + " / " + std::to_string(a.waited)).c_str(),
                         a.bufferFrames
                             ? (std::to_string(a.lastPadding) + " / " + std::to_string(a.bufferFrames)
                                + "  " + note).c_str()
                             : note.c_str());
        }
    }

    std::fprintf(stderr,
                 "\n  A row that Initialises and Starts but never signals is the failure\n"
                 "  this probe exists to make visible: every API call succeeded and no\n"
                 "  audio can ever come out.\n");

    device->Release();
    ::CoUninitialize();
    return 0;
}

} // namespace te
