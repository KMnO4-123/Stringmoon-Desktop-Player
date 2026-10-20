#include "output_wasapi.hpp"

#include "diag_log.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <mmreg.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "devices.hpp"
#include "exclusive_format.hpp"
#include "util.hpp"
#include "win_props.hpp"
#include "win_util.hpp"

#pragma comment(lib, "avrt.lib")

#include "device_monitor.hpp"
#include "crash_attribution.hpp"

namespace te {
namespace {

// A zero shared-mode duration asks WASAPI for the smallest buffer compatible
// with the engine period. Passing 1000 ms here made pause/seek wait for a full
// second of queued audio and defeated the documented latency target.
constexpr REFERENCE_TIME kSharedBufferDuration = 0;
constexpr DWORD          kRenderWaitMs         = 2000;

// SPEC 3.3: MMCSS "Pro Audio" is only worth asking for below 10 ms. Asking for
// it on a long shared-mode buffer does nothing except misreport the tier.
constexpr double kProAudioPeriodThresholdMs = 10.0;

// SPEC 3.2: adaptive buffer ceiling. 50 ms is the documented cap; beyond that
// the latency cost stops being worth the stability.

} // namespace

WasapiOutput::~WasapiOutput() {
    close();
}

void WasapiOutput::releaseAll() {
    if (renderClient_) { renderClient_->Release(); renderClient_ = nullptr; }
    // IAudioClock is bound but deliberately NOT used for position: GetPosition is
    // per-stream and restarts on seek, so it cannot answer 'has the device played
    // everything it was given'. See devicePlayedFrames() for what replaced it.
    if (clock_)        { clock_->Release();        clock_        = nullptr; }
    dspPrepared_ = false;
    if (client_)       { client_->Release();       client_       = nullptr; }
    if (eventHandle_) {
        ::CloseHandle(static_cast<HANDLE>(eventHandle_));
        eventHandle_ = nullptr;
    }
    if (mmcssHandle_) {
        ::AvRevertMmThreadCharacteristics(static_cast<HANDLE>(mmcssHandle_));
        mmcssHandle_ = nullptr;
    }
    if (comInitialized_) {
        ::CoUninitialize();
        comInitialized_ = false;
    }
}

// Enumerates the endpoint and reads its friendly name and ID. Shared by both
// modes: which mode is chosen does not change how the device is found.
static bool resolveDevice(IMMDeviceEnumerator* enumerator, const std::string& deviceId,
                          IMMDevice** outDevice, std::string& name, std::string& resolvedId,
                          std::string& error) {
    HRESULT hr = S_OK;
    if (deviceId.empty()) {
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, outDevice);
    } else {
        const std::wstring wideId = utf8ToWide(deviceId);
        hr = enumerator->GetDevice(wideId.c_str(), outDevice);
    }
    if (FAILED(hr) || !*outDevice) {
        error = "render device not found (" + hresultToString(hr) + ")";
        return false;
    }

    IPropertyStore* store = nullptr;
    if (SUCCEEDED((*outDevice)->OpenPropertyStore(STGM_READ, &store)) && store) {
        PROPVARIANT pv;
        ::PropVariantInit(&pv);
        if (SUCCEEDED(store->GetValue(kPkeyDeviceFriendlyName, &pv)) && pv.vt == VT_LPWSTR && pv.pwszVal) {
            name = wideToUtf8(pv.pwszVal);
        }
        ::PropVariantClear(&pv);
        store->Release();
    }

    LPWSTR id = nullptr;
    if (SUCCEEDED((*outDevice)->GetId(&id)) && id) {
        resolvedId = wideToUtf8(id);
        ::CoTaskMemFree(id);
    }
    return true;
}

// Binds the event handle, the render client and the clock. Identical for both
// modes -- the only difference is the format the stream was initialised with.
// The clock frequency is reported back to the caller rather than stored here:
// this is a free function and has no access to the object's state.
static bool finishStreamSetup(IAudioClient* client, HANDLE& eventHandle,
                              IAudioRenderClient*& renderClient, IAudioClock*& clock,
                              UINT64& clockFrequency, std::string& error) {
    HRESULT hr = S_OK;
    eventHandle = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!eventHandle) {
        error = "cannot create the render event";
        return false;
    }
    hr = client->SetEventHandle(eventHandle);
    if (FAILED(hr)) {
        error = "cannot bind the render event (" + hresultToString(hr) + ")";
        return false;
    }
    hr = client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&renderClient));
    if (FAILED(hr)) {
        error = "cannot get the render client (" + hresultToString(hr) + ")";
        return false;
    }
    if (SUCCEEDED(client->GetService(__uuidof(IAudioClock), reinterpret_cast<void**>(&clock)))) {
        // The clock is optional; when it is missing, position falls back to
        // counting the frames the engine itself pulled from its ring.
        UINT64 frequency = 0;
        if (SUCCEEDED(clock->GetFrequency(&frequency)) && frequency > 0) {
            clockFrequency = frequency;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// EXCLUSIVE -- the path SPEC 1.1 calls the one difference this project exists for.
//
// The stream is opened at the SOURCE rate and depth with no mixer in the chain,
// which is the only way the stored integers reach the device unaltered. Two
// details are easy to get wrong:
//   * AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM is a shared-mode facility. Setting it
//     here would silently convert the rate and make the whole exercise pointless,
//     so it is deliberately absent.
//   * The buffer comes from the device's reported minimum (SPEC 3.3: probe, do
//     not assume). On-board HD Audio reaches about 3 ms; a USB class driver
//     degrades event-driven exclusive to about 9 ms with no official fix, so the
//     landing point is measured and reported instead of promised.
// ---------------------------------------------------------------------------
bool WasapiOutput::openExclusive(const std::string& deviceId, const StreamRequest& request,
                                std::string& error) {
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                    __uuidof(IMMDeviceEnumerator),
                                    reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) {
        error = "audio device enumerator unavailable (" + hresultToString(hr) + ")";
        return false;
    }

    IMMDevice* device = nullptr;
    std::string name, resolvedId;
    if (!resolveDevice(enumerator, deviceId, &device, name, resolvedId, error)) {
        enumerator->Release();
        return false;
    }
    enumerator->Release();

    // Which exclusive format this endpoint accepts. The candidate set is
    // shared with the capability probe in devices.cpp on purpose: if the two
    // disagreed, the engine would report a format as available and then fail
    // to open it, which is worse than not probing at all.
    WAVEFORMATEXTENSIBLE candidates[4]{};
    const int candidateCount = teExclusiveFormatCandidates(request.bitDepth, candidates);

    WAVEFORMATEXTENSIBLE want{};
    bool formatAccepted = false;
    REFERENCE_TIME defaultPeriod = 0, minPeriod = 0;

    // The negotiation is a documented two-step, and it needs a FRESH client for
    // the second step. Re-initialising the same IAudioClient after
    // AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED appears to succeed but leaves a stream
    // whose event never fires: the render thread then waits out every timeout,
    // reports zero position, and the app sees a track that is "playing" and
    // silent. Releasing the interface and re-activating it is what makes the
    // second Initialize real. Hence the loop, and hence the early Release below.
    REFERENCE_TIME bufferDuration = 0;
    UINT32 negotiatedFrames = 0;
    bool haveNegotiatedFrames = false;

    for (int attempt = 0; attempt < 3; ++attempt) {
        if (client_) { client_->Release(); client_ = nullptr; }

        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                              reinterpret_cast<void**>(&client_));
        if (FAILED(hr) || !client_) {
            error = "cannot activate the audio client (" + hresultToString(hr) + ")";
            device->Release();
            return false;
        }

        if (attempt == 0) {
            // Probe the format once, on the first client, and remember the winner.
            for (int i = 0; i < candidateCount; ++i) {
                want = teMakeExclusiveFormat(request.sampleRate,
                                             candidates[i].Format.wBitsPerSample,
                                             candidates[i].Samples.wValidBitsPerSample,
                                             request.channels);
                WAVEFORMATEX* closest = nullptr;
                hr = client_->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                                reinterpret_cast<WAVEFORMATEX*>(&want),
                                                &closest);
                if (closest) ::CoTaskMemFree(closest);
                if (SUCCEEDED(hr)) { formatAccepted = true; break; }
            }
            if (!formatAccepted) {
                error = "the device does not accept " + std::to_string(request.sampleRate) +
                        " Hz / " + std::to_string(request.bitDepth) +
                        "-bit PCM in exclusive mode";
                device->Release();
                return false;
            }

            hr = client_->GetDevicePeriod(&defaultPeriod, &minPeriod);
            if (SUCCEEDED(hr)) {
                status_.deviceDefaultPeriodMs = static_cast<double>(defaultPeriod) / 10000.0;
                status_.deviceMinPeriodMs     = static_cast<double>(minPeriod) / 10000.0;
            }
        }

        if (attempt == 0) {
            if (request.bufferMs > 0) {
                bufferDuration = static_cast<REFERENCE_TIME>(request.bufferMs) * 10000;
            } else {
                bufferDuration = minPeriod > 0 ? minPeriod * 2 : 100000;  // two periods, else 10 ms
            }
            if (minPeriod > 0 && bufferDuration < minPeriod) bufferDuration = minPeriod;
            // CR-027：显式延迟档位覆盖默认的"两个设备周期"。
            // stable → 8192 帧；lowLatency → 1024 帧，但不低于 8 ms（SPEC 口径）。
            // balanced 不进入这里，保持上一轮逐点等价的行为。
            if (request.bufferMs == 0 && request.latency != LatencyProfile::Balanced) {
                const double framesTarget = (request.latency == LatencyProfile::Stable) ? 8192.0 : 1024.0;
                const REFERENCE_TIME target = static_cast<REFERENCE_TIME>(
                    (10000000.0 * framesTarget / status_.sampleRate) + 0.5);
                const REFERENCE_TIME lowLatencyFloor = 80000;   // 8 ms
                bufferDuration = target < lowLatencyFloor ? lowLatencyFloor : target;
                if (minPeriod > 0 && bufferDuration < minPeriod) bufferDuration = minPeriod;
            }
        } else {
            // Retry with the frame count the device just reported, converted to
            // the duration units Initialize wants.
            bufferDuration = static_cast<REFERENCE_TIME>(
                (10000000.0 * negotiatedFrames / status_.sampleRate) + 0.5);
        }

        // EXCLUSIVE + EVENTCALLBACK requires hnsPeriodicity to be non-zero and
        // equal to hnsBufferDuration. Passing 0 makes a device that supports
        // exclusive perfectly well reject the stream.
        hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                 AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                 bufferDuration, bufferDuration,
                                 reinterpret_cast<WAVEFORMATEX*>(&want), nullptr);
        if (SUCCEEDED(hr)) break;

        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
            UINT32 frames = 0;
            if (SUCCEEDED(client_->GetBufferSize(&frames)) && frames > 0) {
                negotiatedFrames = frames;
                haveNegotiatedFrames = true;
                continue;   // release the client and negotiate again
            }
        }
        break;   // any other result is final
    }

    device->Release();

    if (FAILED(hr)) {
        error = "exclusive stream refused (" + hresultToString(hr) + ")" +
                (hr == AUDCLNT_E_DEVICE_IN_USE ? " - the device is in use by another application" : "") +
                (hr == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED ? " - exclusive mode is disabled for this endpoint" : "") +
                (hr == AUDCLNT_E_UNSUPPORTED_FORMAT ? " - the endpoint rejects this format" : "") +
                (hr == AUDCLNT_E_BUFFER_SIZE_ERROR ? " - the requested buffer duration is out of range" : "");
        return false;
    }

    status_.sampleRate     = request.sampleRate;
    status_.channels       = request.channels;
    status_.outputMode     = "exclusive";
    status_.isExclusive    = true;

    // Report the period the negotiation actually landed on, not the one asked
    // for first. SPEC 3.3 wants the achieved figure in front of the user.
    UINT32 landedFrames = haveNegotiatedFrames ? negotiatedFrames : 0;
    if (landedFrames == 0) client_->GetBufferSize(&landedFrames);
    status_.periodFrames = static_cast<int>(landedFrames);
    status_.periodMs = status_.sampleRate > 0
        ? (static_cast<double>(landedFrames) * 1000.0) / status_.sampleRate
        : 0.0;
    status_.currentBufferMs = static_cast<int>(status_.periodMs + 0.5);
    status_.formatTag      = WAVE_FORMAT_EXTENSIBLE;
    status_.bitsPerSample  = want.Format.wBitsPerSample;          // container
    status_.validBits      = want.Samples.wValidBitsPerSample;     // actual precision
    status_.sourceBits     = request.bitDepth;                     // what the file holds
    status_.blockAlign     = want.Format.nBlockAlign;
    status_.isFloat        = false;   // exclusive PCM: integers straight to the device
    status_.bytesPerSample = want.Format.wBitsPerSample / 8;
    status_.deviceName     = name;
    status_.deviceId       = resolvedId;
    UINT64 frequency = 0;
    const bool ready = finishStreamSetup(client_, static_cast<HANDLE&>(eventHandle_),
                                         renderClient_, clock_, frequency, error);
    (void)frequency;
    return ready;
}

// ---------------------------------------------------------------------------
// SHARED -- the M1 path, kept as the guaranteed fallback.
// ---------------------------------------------------------------------------
bool WasapiOutput::openShared(const std::string& deviceId, const StreamRequest& request,
                              std::string& error) {
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                    __uuidof(IMMDeviceEnumerator),
                                    reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) {
        error = "audio device enumerator unavailable (" + hresultToString(hr) + ")";
        return false;
    }

    IMMDevice* device = nullptr;
    std::string name, resolvedId;
    if (!resolveDevice(enumerator, deviceId, &device, name, resolvedId, error)) {
        enumerator->Release();
        return false;
    }
    enumerator->Release();

    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                          reinterpret_cast<void**>(&client_));
    device->Release();
    if (FAILED(hr) || !client_) {
        error = "cannot activate the audio client (" + hresultToString(hr) + ")";
        return false;
    }

    WAVEFORMATEX* mixFormat = nullptr;
    hr = client_->GetMixFormat(&mixFormat);
    if (FAILED(hr) || !mixFormat) {
        error = "cannot read the device mix format (" + hresultToString(hr) + ")";
        return false;
    }

    status_.sampleRate     = static_cast<int>(mixFormat->nSamplesPerSec);
    status_.channels       = static_cast<int>(mixFormat->nChannels);
    status_.outputMode     = "shared";
    status_.isExclusive    = false;
    status_.formatTag      = static_cast<int>(mixFormat->wFormatTag);
    status_.bitsPerSample  = static_cast<int>(mixFormat->wBitsPerSample);
    status_.validBits      = static_cast<int>(mixFormat->wBitsPerSample);
    // What the FILE holds, needed for the dither decision. Without this it stayed
    // zero in shared mode and "no dither" was the answer to a question that was
    // never actually asked -- right for a float32 mix format by luck rather than
    // by reasoning, and wrong the moment a shared integer stream needs dither.
    status_.sourceBits     = request.bitDepth;
    status_.blockAlign     = static_cast<int>(mixFormat->nBlockAlign);
    status_.isFloat        = (mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
    if (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mixFormat->cbSize >= 22) {
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mixFormat);
        status_.validBits = static_cast<int>(ext->Samples.wValidBitsPerSample);
        status_.isFloat   = (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    }
    status_.bytesPerSample = status_.bitsPerSample / 8;
    status_.deviceName     = name;
    status_.deviceId       = resolvedId;

    REFERENCE_TIME bufferDuration = (request.bufferMs > 0)
        ? static_cast<REFERENCE_TIME>(request.bufferMs) * 10000
        : kSharedBufferDuration;
    int requestedLatencyFrames = 0;
    if (request.bufferMs == 0 && request.latency != LatencyProfile::Balanced) {
        // CR-027：shared 只能"请求"，系统可能给更大的周期；实际值下面照实报告。
        requestedLatencyFrames = (request.latency == LatencyProfile::Stable) ? 8192 : 1024;
        bufferDuration = static_cast<REFERENCE_TIME>(
            (10000000.0 * requestedLatencyFrames / status_.sampleRate) + 0.5);
    }
    hr = client_->Initialize(AUDCLNT_SHAREMODE_SHARED,
                             AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                             bufferDuration, 0, mixFormat, nullptr);
    ::CoTaskMemFree(mixFormat);
    if (FAILED(hr)) {
        error = "shared-mode stream refused (" + hresultToString(hr) + ")";
        return false;
    }
    // Report the buffer that was actually handed to Initialize(). Without a
    // requested size the field used to stay 0 while the stream ran with
    // kSharedBufferDuration -- so the xrun event, whose whole purpose is to make
    // "0 xrun" checkable, was reporting the size as nothing.
    UINT32 actualBufferFrames = 0;
    client_->GetBufferSize(&actualBufferFrames);
    status_.currentBufferMs = (request.bufferMs > 0)
        ? request.bufferMs
        : (status_.sampleRate > 0 && actualBufferFrames > 0
            ? static_cast<int>((static_cast<double>(actualBufferFrames) * 1000.0) /
                               status_.sampleRate + 0.5)
            : 0);
    // CR-027：请求的档位没达成时如实说明（shared 的周期由系统混音器决定）。
    if (requestedLatencyFrames > 0 && actualBufferFrames > 0 &&
        actualBufferFrames * 2 > static_cast<UINT32>(requestedLatencyFrames) * 3) {
        status_.degradeReason = std::string("the shared endpoint runs a ") +
            std::to_string(requestedLatencyFrames) + "-frame request at " +
            std::to_string(actualBufferFrames) + " frames (system mix period)";
    }

    // SPEC 3.3 capability probing, shared half. The reported period determines
    // both the latency the UI shows and whether MMCSS Pro Audio is reachable.
    UINT32 defaultPeriod = 0, fundamental = 0, minPeriod = 0, maxPeriod = 0;
    IAudioClient3* client3 = nullptr;
    if (SUCCEEDED(client_->QueryInterface(__uuidof(IAudioClient3), reinterpret_cast<void**>(&client3))) && client3) {
        WAVEFORMATEX* fmt = nullptr;
        if (SUCCEEDED(client_->GetMixFormat(&fmt)) && fmt) {
            if (SUCCEEDED(client3->GetSharedModeEnginePeriod(fmt, &defaultPeriod, &fundamental,
                                                             &minPeriod, &maxPeriod)) &&
                defaultPeriod > 0) {
                status_.periodFrames = static_cast<int>(defaultPeriod);
                status_.periodMs = status_.sampleRate > 0
                    ? (static_cast<double>(defaultPeriod) * 1000.0) / status_.sampleRate
                    : 0.0;
            }
            ::CoTaskMemFree(fmt);
        }
        client3->Release();
    }
    if (status_.periodFrames == 0) {
        REFERENCE_TIME defaultDevice = 0, minDevice = 0;
        if (SUCCEEDED(client_->GetDevicePeriod(&defaultDevice, &minDevice)) && status_.sampleRate > 0) {
            status_.periodFrames = static_cast<int>((defaultDevice * status_.sampleRate) / 10000000);
            status_.periodMs = static_cast<double>(defaultDevice) / 10000.0;
        }
    }
    UINT64 frequency = 0;
    const bool ready = finishStreamSetup(client_, static_cast<HANDLE&>(eventHandle_),
                                         renderClient_, clock_, frequency, error);
    (void)frequency;
    return ready;
}

bool WasapiOutput::deviceIsBluetooth(const std::string& deviceId) const {
    // Same test the device enumeration uses (see devices.cpp): Windows reports a
    // paired Bluetooth sink with the BTHENUM enumerator. Read here as well so the
    // decision to fall back to shared is made where the mode is chosen, rather
    // than being inferred from a device list that may be minutes old.
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                     __uuidof(IMMDeviceEnumerator),
                                     reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) return false;

    IMMDevice* device = nullptr;
    if (deviceId.empty()) {
        enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    } else {
        const std::wstring wide = fromUtf8(deviceId);
        enumerator->GetDevice(wide.c_str(), &device);
    }
    enumerator->Release();
    if (!device) return false;

    bool bluetooth = false;
    IPropertyStore* store = nullptr;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store)) && store) {
        bluetooth = (readStringProperty(store, kPkeyDeviceEnumeratorName) == "BTHENUM");
        store->Release();
    }
    device->Release();
    return bluetooth;
}

void WasapiOutput::resetStatus() {
    // OutputStatus holds an atomic, so it is deliberately not copy-assignable;
    // the fields a reopen invalidates are reset individually.
    status_.deviceId.clear();
    status_.deviceName.clear();
    status_.outputMode.clear();
    status_.degradeReason.clear();
    status_.sampleRate     = 0;
    status_.channels       = 0;
    status_.periodFrames   = 0;
    status_.periodMs       = 0.0;
    status_.formatTag      = 0;
    status_.bitsPerSample  = 0;
    status_.validBits      = 0;
    status_.blockAlign     = 0;
    status_.bytesPerSample = 0;
    status_.sourceBits     = 0;
    status_.isFloat        = false;
    status_.isExclusive    = false;
    status_.mmcssProAudio  = false;
    status_.deviceDefaultPeriodMs = 0.0;
    status_.deviceMinPeriodMs     = 0.0;
    status_.currentBufferMs = 0;
    status_.renderWakes.store(0, std::memory_order_relaxed);
    // xrunCount is deliberately NOT reset here. This runs on every open, and the
    // adaptive-buffer recovery reopens the stream -- so resetting would make the
    // count fall back to zero precisely when underruns were happening, which
    // reads as the fault disappearing (DESIGN-A 4.1). It is a SESSION total and
    // only ever moves upward; it is initialised once, at construction.
}

// True only when nothing in the chain can alter a sample. Deliberately strict:
// one failing condition means the claim must not be made.
bool WasapiOutput::isBitPerfect() const {
    if (!client_) return false;
    // Exclusive is necessary but not sufficient: an exclusive stream at a
    // DIFFERENT rate than the source would still be a conversion, and a float
    // stream is a conversion too. Both are checked where the rate is known, so
    // here the remaining conditions are the stream's own.
    if (!status_.isExclusive) return false;
    if (status_.isFloat) return false;
    // The container must be able to hold the source precision exactly, and the
    // device must be consuming that many valid bits. container == validBits is
    // NOT the test: 24-in-32 is the normal way a 24-bit stream is delivered.
    const int need = status_.sourceBits > 0 ? status_.sourceBits : status_.validBits;
    if (status_.validBits < need) return false;
    if (status_.bitsPerSample < need) return false;
    // A WIDER container than the source precision is not a conversion -- 24-bit
    // audio very often travels in a 32-bit container with 24 valid bits, and the
    // extra bits are zero padding -- but it is also not bit-exact delivery, so it
    // must not be advertised as such.
    // A volume below unity is a gain change, which by definition is not the
    // source integers. SPEC 3.3: the UI is told the moment it stops being
    // bit-perfect, which is why dragging the volume slider says so.
    if (volume_.load(std::memory_order_relaxed) < 0.9999f) return false;
    return true;
}

bool WasapiOutput::open(const std::string& deviceId, OutputMode mode,
                        const StreamRequest& request, std::string& error) {
    const bool opened = openInternal(deviceId, mode, request, error);
    if (opened) {
        // THE ONE PLACE A STREAM IS KNOWN TO BE OPEN, structurally rather than by
        // convention. SPEC 449 wants the buffer history; this record used to sit
        // in Player::reopenOutput and missed openTrack's direct open, and after
        // being moved here it still missed the exclusive exit inside this very
        // function. Two early returns, one record: the record lost both times.
        // Recording at the wrapper is what makes that impossible to repeat.
        diagRecord("output", "opened mode=" + status_.outputMode +
                             " device=" + status_.deviceId +
                             " rate=" + std::to_string(status_.sampleRate) +
                             " ch=" + std::to_string(status_.channels) +
                             " bits=" + std::to_string(status_.bitsPerSample) +
                             " bufferMs=" + std::to_string(status_.currentBufferMs));
    }
    return opened;
}

bool WasapiOutput::openInternal(const std::string& deviceId, OutputMode mode,
                                const StreamRequest& request, std::string& error) {
    close();
    resetStatus();

    // SPEC P4: a Bluetooth sink always runs shared. The link re-encodes the
    // stream regardless, so an exclusive request there cannot mean what the
    // user thinks it means. Not attempting it is also the honest option: the
    // failure it would produce ("the device refused the format") describes a
    // symptom while hiding the cause.
    const bool bluetooth = deviceIsBluetooth(deviceId);

    const bool wantsExclusive = !bluetooth &&
                                (mode == OutputMode::Exclusive || mode == OutputMode::Auto);

    // Exclusive needs a source rate and channel count to negotiate. Auto cannot
    // conjure them, so a request without them degrades to shared instead of
    // guessing and then claiming bit-perfect.
    if (wantsExclusive && request.sampleRate > 0 && request.channels > 0) {
        std::string exclusiveError;
        if (openExclusive(deviceId, request, exclusiveError)) {
            // openExclusive() already recorded the buffer it NEGOTIATED, from the
            // stream's real period. Overwriting it with request.bufferMs set the
            // field to 0 for every caller that did not ask for a size -- which is
            // every caller, because set_output has no such parameter. The xrun
            // event has therefore been reporting bufferMs=0 all along: a field
            // that exists to make "0 xrun" checkable, reporting nothing.
            if (request.bufferMs > 0) status_.currentBufferMs = request.bufferMs;
            return true;
        }
        // CONTRACT 3.4: this is a degradation, not a failure. The reason travels
        // in state so the UI can explain it; it never becomes ok:false unless
        // even shared cannot open.
        status_.degradeReason = exclusiveError;
        releaseAll();
        HRESULT hr = ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        comInitialized_ = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
    } else if (mode == OutputMode::Exclusive) {
        // Asked for exclusive without a source format: that is a caller mistake,
        // and answering with a silent shared stream would hide it.
        error = "exclusive output needs the source sample rate and channel count";
        return false;
    }

    if (!openShared(deviceId, request, error)) {
        lastError_ = error;
        releaseAll();
        return false;
    }

    if (bluetooth) {
        // Overwrites any exclusive-refusal reason on purpose. Both are true, but
        // only one is actionable: "the device refused the format" would send the
        // user looking for a format problem, while the link is the actual cause
        // and nothing about it is fixable by changing formats.
        status_.degradeReason =
            "Bluetooth link: shared mode is used because the link re-encodes the stream";
    }

    return true;
}

void WasapiOutput::wakeRenderThread() {
    if (eventHandle_) ::SetEvent(static_cast<HANDLE>(eventHandle_));
}

void WasapiOutput::beginFadeOut(int milliseconds) {
    // Zero or negative means no fade at all: the caller is in a hurry, or the
    // stream is already silent. Requesting a fade is always a request, never a
    // guarantee, and the caller waits on fadeOutPending() rather than assuming.
    if (milliseconds <= 0) return;
    fadeRequested_.store(true, std::memory_order_relaxed);
    fadeCompletedFlag_.store(false, std::memory_order_relaxed);
    // 上一次传输的 padding 计数不能冒充这一次的。
    traceSilencePadFrames_.store(0, std::memory_order_release);
    fadeOutMs_.store(milliseconds, std::memory_order_release);
    fadeActive_.store(true, std::memory_order_release);
}

void WasapiOutput::stop() {
    if (!running_.exchange(false)) {
        // Not running: still make sure the client is stopped if it was started.
        if (client_) client_->Stop();
        return;
    }
    // Ask the render thread to park, then wait for it. The thread is the only
    // owner of the client during playback, so it stops the stream itself.
    silence_.store(true, std::memory_order_release);
    // Wake an event-driven render thread immediately. Without this, a lost
    // device callback leaves stop() waiting for the full render timeout even
    // though the control thread has already requested silence.
    if (eventHandle_) ::SetEvent(static_cast<HANDLE>(eventHandle_));
    const DWORD deadline = ::GetTickCount() + 3000;
    while (!renderIdle_.load(std::memory_order_acquire) && ::GetTickCount() < deadline) {
        ::Sleep(1);
    }
    if (threadHandle_) {
        ::WaitForSingleObject(static_cast<HANDLE>(threadHandle_), 3000);
        ::CloseHandle(static_cast<HANDLE>(threadHandle_));
        threadHandle_ = nullptr;
    }
    // V3 §1.1 / verifier：结构性证据。Stop 之前端点里还剩多少帧、淡出是否真排空。
    // 线程已退出、流仍处于 stopped，GetCurrentPadding 此时可读（失败则 -1 如实报告）。
    {
        UINT32 padding = 0;
        const bool havePadding = client_ && SUCCEEDED(client_->GetCurrentPadding(&padding));
        tracePaddingAtStop_.store(havePadding ? static_cast<int>(padding) : -1,
                                  std::memory_order_release);
        traceFadeCompleted_.store(
            fadeRequested_.exchange(false, std::memory_order_relaxed) &&
            fadeCompletedFlag_.exchange(false, std::memory_order_relaxed),
            std::memory_order_release);
    }

    // 真正的 stop/切歌才走到这里（pause 走 pause-hold，不拆流）。
    //
    // 为什么必须 Reset：IAudioClient 的 Stop 只是暂停提交，端点缓冲里的内容仍
    // 保留；下一次 Start 会从这块残留开始播（最多一个 buffer 的旧音频 = 可闻的
    // "电流声/爆音"）。Reset 丢弃未播放数据，Start 之后设备先看到的是静音。
    // 这一步失败也不影响后续 show：下一次 start() 还会再做一次防御性 Reset。
    hold_.store(false, std::memory_order_release);
    fadeInMs_.store(0, std::memory_order_release);
    fadeOutMs_.store(0, std::memory_order_release);
    if (client_) client_->Reset();
}

void WasapiOutput::close() {
    stop();
    releaseAll();
    running_.store(false);
    renderIdle_.store(true);
}

bool WasapiOutput::resetStream(std::string& error) {
    if (running_.load(std::memory_order_acquire) || !renderIdle() || threadHandle_) {
        error = "cannot reset an output stream before the render thread is parked";
        return false;
    }
    if (!client_) { error = "output not open"; return false; }
    const HRESULT hr = client_->Reset();
    if (FAILED(hr)) {
        error = "cannot clear pending output audio (" + hresultToString(hr) + ")";
        return false;
    }
    endpointProgress_.reset();
    meterTap_.reset();
    dspPrepared_ = false;
    playedFrames_.store(0, std::memory_order_release);
    if (eventHandle_) ::ResetEvent(static_cast<HANDLE>(eventHandle_));
    return true;
}

bool WasapiOutput::start(PlanarRing& ring, std::atomic<uint64_t>* positionFrames,
                         bool fadeIn, std::string& error) {
    if (!client_ || !renderClient_) {
        error = "output not open";
        return false;
    }
    if (running_.load()) {
        error = "output already running";
        return false;
    }

    ring_           = &ring;
    positionFrames_ = positionFrames;
    meterTap_.prepare(status_.channels, status_.sampleRate);

    UINT32 bufferFrames = 0;
    const HRESULT sizeHr = client_->GetBufferSize(&bufferFrames);

    // Prepare the DSP for this stream. Doing it HERE rather than in the render
    // loop is the whole point: prepare() is the only place the chain allocates,
    // and SPEC 3.4 forbids allocating on the audio path. The control thread is
    // still the only thread touching the output at this moment.
    const bool freshStream = !dspPrepared_;
    if (freshStream && SUCCEEDED(sizeHr) && bufferFrames > 0) {
        // Fixed seed per channel: the same audio must quantise identically on a
        // replay, which is also what lets the offline test be deterministic.
        for (int ch = 0; ch < DspChain::kMaxChannels; ++ch) {
            dither_[ch].rng.seed(0x5EED0000u + static_cast<uint32_t>(ch + 1));
            dither_[ch].reset();
        }
        dsp_.prepare(status_.channels, static_cast<int>(bufferFrames), status_.sampleRate);
        // Re-apply whatever the app last asked for: a stream reopen (a device
        // change, or the buffer-doubling recovery) must not silently drop the
        // user's EQ while it fixes an unrelated problem.
        dsp_.publish(pendingDsp_);
        volumeGain_.prepare(status_.sampleRate, muted_.load(std::memory_order_relaxed)
            ? 0.0f : volume_.load(std::memory_order_relaxed));
        dspPrepared_ = true;
    }
    // A paused stream keeps its EQ, limiter, dither and volume state. Muting
    // while paused must still take effect before the first resumed frame.
    if (muted_.load(std::memory_order_relaxed)) volumeGain_.prepare(status_.sampleRate, 0.0f);

    // CR-027：3 次连续 xrun 自动翻倍 buffer 的上限按档位设。balanced 保持 50 ms
    // （上一轮行为）；stable 允许到 8192 帧；lowLatency 封顶 2048 帧——否则"低延迟"
    // 会在出问题时自己爬成高延迟档，名不副实。
    if (latencyProfile_ == LatencyProfile::Stable) {
        maxBufferMs_ = status_.sampleRate > 0
            ? static_cast<int>(8192.0 * 1000.0 / status_.sampleRate + 0.5) : 170;
        if (maxBufferMs_ < 50) maxBufferMs_ = 50;
    } else if (latencyProfile_ == LatencyProfile::LowLatency) {
        maxBufferMs_ = status_.sampleRate > 0
            ? static_cast<int>(2048.0 * 1000.0 / status_.sampleRate + 0.5) : 43;
        if (maxBufferMs_ < 10) maxBufferMs_ = 10;
    } else {
        maxBufferMs_ = 50;
    }

    // Pre-roll: fill the device buffer with silence so the first callback has
    // something valid even if the decoder has not produced anything yet.
    if (freshStream && SUCCEEDED(sizeHr)) {
        traceResetBeforeStart_.store(true, std::memory_order_release);
        BYTE* buffer = nullptr;
        if (SUCCEEDED(renderClient_->GetBuffer(bufferFrames, &buffer)) && buffer) {
            // Size from the stream's real block alignment, not from an assumed
            // float32: exclusive 16-bit and 24-bit streams are narrower, and the
            // old arithmetic would have run past the end of the buffer.
            std::memset(buffer, 0, static_cast<size_t>(bufferFrames) * status_.blockAlign);
            renderClient_->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
            endpointProgress_.submitted(bufferFrames, 0);
        }
    }

    // 复用同一个 client（pause 后的 play、同格式切歌）时，端点缓冲里可能还有
    // 上一次 Stop 前的数据。Stop 之后、Start 之前 Reset 是 WASAPI 的语义要求，
    // 否则 Start 会先把旧样本播一遍。freshStream 已在上面预滚过静音，不需要。
    if (!freshStream && SUCCEEDED(sizeHr)) {
        client_->Reset();
        endpointProgress_.reset();
        traceResetBeforeStart_.store(true, std::memory_order_release);
    } else {
        traceResetBeforeStart_.store(false, std::memory_order_release);
    }

    HRESULT hr = client_->Start();
    if (FAILED(hr)) {
        error = "cannot start the stream (" + hresultToString(hr) + ")";
        return false;
    }

    running_.store(true, std::memory_order_release);
    renderIdle_.store(false, std::memory_order_release);
    silence_.store(false, std::memory_order_release);
    command_.store(static_cast<int>(RenderCommand::None), std::memory_order_release);
    playedFrames_.store(0, std::memory_order_release);
    // Re-starts ramp in to avoid a click at an arbitrary waveform position.
    // V3 §1.1：淡入时长用配置值（默认 10ms），曲线是等功率正弦。
    hold_.store(false, std::memory_order_release);
    fadeInMs_.store(0, std::memory_order_release);
    fadeOutMs_.store(0, std::memory_order_release);
    fadeActive_.store(false, std::memory_order_release);
    // 注意：这里不清 traceSilencePadFrames_。seek = Stop(补静音)→Reset→Start，
    // 若 Start 把它清零，客户端就永远读不到刚才那次停流补了多少静音。
    // 计数只在下一次 beginFadeOut() 时重置。
    if (fadeIn) fade_.beginIn(status_.sampleRate, fadeMs_.load(std::memory_order_acquire));
    else fade_.reset();

    threadHandle_ = ::CreateThread(nullptr, 0, &WasapiOutput::renderThreadEntry, this, 0, nullptr);
    if (!threadHandle_) {
        client_->Stop();
        running_.store(false);
        renderIdle_.store(true);
        error = "cannot create the render thread";
        return false;
    }
    return true;
}

unsigned long __stdcall WasapiOutput::renderThreadEntry(void* self) {
    static_cast<WasapiOutput*>(self)->renderLoop();
    return 0;
}

#if TE_RT_TRACE
namespace {
const char* const kRenderStages[] = {
    "enter",
    "wait-for-event",
    "get-current-padding",
    "get-buffer",
    "ring-read",
    "interleave",
    "release-buffer",
    "loop-top",
};
} // namespace

const char* WasapiOutput::renderStageName() const {
    const int stage = renderStage_.load(std::memory_order_relaxed);
    if (stage < 0 || stage >= static_cast<int>(sizeof kRenderStages / sizeof kRenderStages[0])) return "?";
    return kRenderStages[stage];
}
#endif

void WasapiOutput::renderLoop() {
    // Published so the crash filter can name the failing thread (see main.cpp).
    te::publishRenderThreadId(::GetCurrentThreadId());

    // The render thread owns its own COM apartment and its own MMCSS claim.
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    DWORD mmcssIndex = 0;
    // SPEC 3.2: request "Pro Audio" when the period justifies it; otherwise
    // "Audio", which is the honest claim for a 10 ms shared-mode buffer.
    const wchar_t* taskName = status_.periodMs < kProAudioPeriodThresholdMs ? L"Pro Audio" : L"Audio";
    HANDLE mmcss = ::AvSetMmThreadCharacteristicsW(taskName, &mmcssIndex);
    if (!mmcss) {
        // Fall back to HIGHEST and record it, per SPEC 3.2.
        ::SetThreadPriority(::GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        status_.mmcssProAudio = false;
    } else {
        status_.mmcssProAudio = (std::wcscmp(taskName, L"Pro Audio") == 0);
    }

    UINT32 bufferFrames = 0;
    if (FAILED(client_->GetBufferSize(&bufferFrames)) || bufferFrames == 0) {
        running_.store(false, std::memory_order_release);
        fadeActive_.store(false, std::memory_order_release);
        renderIdle_.store(true, std::memory_order_release);
        if (mmcss) ::AvRevertMmThreadCharacteristics(mmcss);
        ::CoUninitialize();
        return;
    }

    const int channels = status_.channels;

    // Scratch buffer for pulling planar data out of the ring. Allocated once,
    // here, before the loop: the RT path itself never allocates.
    std::vector<std::vector<float>> scratch(channels, std::vector<float>(bufferFrames, 0.0f));
    std::vector<float*> scratchPtrs(channels, nullptr);
    for (int ch = 0; ch < channels; ++ch) scratchPtrs[ch] = scratch[ch].data();

#if TE_RT_TRACE
    renderStage_.store(1, std::memory_order_relaxed);
#endif
    // Counts how many times the event waited out its timeout with the stream
    // running and no silence requested. In exclusive mode a device that refuses
    // to raise its event shows up exactly here, and without this counter that
    // failure looks identical to a working stream that is simply quiet.
    int eventTimeouts = 0;
    // 淡出后的静音 padding 阶段（kStopSilencePadMs）。顺序是：
    //   淡出到 0 → 再写 padFrames 帧静音 → 等设备把它们全部播完 → 才允许
    //   Stop/Reset/Close。旧代码在淡出最后一帧刚排空就停流（paddingAtStop=0），
    //   端点缓冲里没有确定的静音，驱动截断硬件缓冲时就是用户听到的"咔/电流声"。
    bool     padPhase = false;           // 正在往端点写静音 padding
    int      padFramesRemaining = 0;     // 还要写多少帧
    int      padFramesTotal = 0;         // 本次总共写了多少帧（进 trace）
    bool     padDrainPending = false;    // padding 写完，等设备播完
    uint64_t padTargetPlayed = 0;        // 设备播到这个提交水位才算播完

    while (running_.load(std::memory_order_acquire)) {
        if (::WaitForSingleObject(static_cast<HANDLE>(eventHandle_), kRenderWaitMs) != WAIT_OBJECT_0) {
            ++eventTimeouts;
            status_.renderStarved = eventTimeouts;
            // No buffer arrived. If the app asked us to be quiet, park; otherwise
            // count it as an underrun and keep waiting, which lets the device
            // recover instead of tearing the stream down.
            if (silence_.load(std::memory_order_acquire)) {
                renderIdle_.store(true, std::memory_order_release);
                ::WaitForSingleObject(static_cast<HANDLE>(eventHandle_), 50);
                renderIdle_.store(false, std::memory_order_release);
            }
            continue;
        }

        eventTimeouts = 0;
        status_.renderStarved = 0;
        // The device asked for data. Counted separately from frames rendered,
        // because a wake with an empty ring is still proof the device is
        // running -- and that is the difference between a broken endpoint and a
        // starved one.
        status_.renderWakes.fetch_add(1, std::memory_order_relaxed);

        const int command = command_.exchange(static_cast<int>(RenderCommand::None),
                                              std::memory_order_acq_rel);
        const bool flushing = (command == static_cast<int>(RenderCommand::Flush));

        // V3 §1.1b：pause-hold 恢复时控制线程只请求淡入，不 Start() 流。
        // fade_ 对象只属于 RT 线程，控制线程通过 fadeInMs_ 这个 atomic 交接。
        if (const int requestedFadeIn = fadeInMs_.exchange(0, std::memory_order_acq_rel)) {
            fade_.beginIn(status_.sampleRate, requestedFadeIn);
        }

#if TE_RT_TRACE
        renderStage_.store(2, std::memory_order_relaxed);
#endif
        UINT32 padding = 0;
        if (FAILED(client_->GetCurrentPadding(&padding))) {
            status_.xrunCount.fetch_add(1, std::memory_order_relaxed);
            continue;
        }

        // TWO DIFFERENT PACING MODELS, and using the wrong one silently
        // produces no audio at all.
        //
        // Shared mode is a FIFO the app keeps topped up: write whatever room
        // is free, which is (buffer - padding).
        //
        // Exclusive mode with hnsPeriodicity == hnsBufferDuration is PERIODIC:
        // the device takes the whole buffer once per period. Sampling padding
        // there reports the buffer as still full, so (buffer - padding) is zero
        // and this loop would spin on the continue below forever -- device
        // signalling every period, ring full, and not one frame ever written.
        // That is exactly what happened on the USB DAC, which does support
        // exclusive, and it is why exclusive produced no audio here while the
        // very same code worked in shared mode.
        //
        // So exclusive offers the whole buffer. GetBuffer refuses with
        // AUDCLNT_E_BUFFER_TOO_LARGE if the period is not actually free, which
        // is the honest failure, and the fallback below keeps a periodic
        // report of padding usable rather than guessing.
        UINT32 available = status_.isExclusive ? bufferFrames : (bufferFrames - padding);
        if (status_.isExclusive && available == 0) available = bufferFrames - padding;
        // What the device has FINISHED: everything handed over, minus what is
        // still sitting in its buffer. Derived here, in the thread that owns both
        // numbers, so the control thread's drain test compares one instant with
        // itself. See devicePlayedFrames() for why the obvious alternatives fail.
        endpointProgress_.observePadding(padding);
        if (padDrainPending) {
            if (endpointProgress_.played() >= padTargetPlayed) {
                // 静音 padding 已被设备播到"提交水位"：端点里是确定的 0，这时才
                // 允许控制线程 Stop/Reset/Close。旧实现以"最后一个非零样本已播"
                // 为完成条件，硬件缓冲里没有额外静音，驱动断电/复位会截断。
                fadeActive_.store(false, std::memory_order_release);
                fadeCompletedFlag_.store(true, std::memory_order_release);
                traceSilencePadFrames_.store(padFramesTotal, std::memory_order_release);
                // pause-hold 没有 Stop()，也要让客户端看到"淡出真的完成"。
                traceFadeCompleted_.store(true, std::memory_order_release);
                padDrainPending = false;
                if (hold_.load(std::memory_order_acquire)) {
                    // pause-hold：静音 padding 已播完，之后只渲染静音；线程与流
                    // 都保持活着，恢复时从 fadeIn 继续而不是 Start。
                    silence_.store(true, std::memory_order_release);
                } else {
                    break;
                }
            } else {
                continue;
            }
        }
        if (available == 0) continue;

#if TE_RT_TRACE
        renderStage_.store(3, std::memory_order_relaxed);
#endif
        BYTE* buffer = nullptr;
        HRESULT getHr = renderClient_->GetBuffer(available, &buffer);
        if (FAILED(getHr) && status_.isExclusive && padding > 0) {
            // The period was not free after all -- some drivers do report
            // padding for a periodic stream. Take what padding says is
            // available instead of dropping the period and counting an xrun
            // for a stream that is merely early.
            available = bufferFrames - padding;
            if (available > 0) getHr = renderClient_->GetBuffer(available, &buffer);
        }
        if (FAILED(getHr) || !buffer) {
            status_.xrunCount.fetch_add(1, std::memory_order_relaxed);
            continue;
        }

        // padPhase 期间整块写 0，不碰 ring——否则淡出后又会把新的音乐样本写进
        // 端点，静音 padding 就不成立了。
        const bool quiet = flushing || silence_.load(std::memory_order_acquire) || padPhase;
        const int fadeMs = fadeOutMs_.load(std::memory_order_acquire);
        if (fadeMs > 0 && fade_.direction() != AudioFade::Direction::Out)
            fade_.beginOut(status_.sampleRate, fadeMs);

#if TE_RT_TRACE
        renderStage_.store(4, std::memory_order_relaxed);
#endif
        size_t got = 0;
        if (!quiet) {
            size_t audioFrames = available;
            if (fade_.direction() == AudioFade::Direction::Out && fade_.active()) {
                audioFrames = std::min(audioFrames,
                    static_cast<size_t>(fade_.remainingFrames()));
            }
            got = ring_->read(scratchPtrs.data(), audioFrames);
            // The M2 quality chain runs exactly here: after the ring, before the
            // interleave and the format conversion. That is the order SPEC 3.2
            // fixes, and it is what keeps the internal representation planar
            // float32 all the way through the filters -- interleaving first and
            // filtering second would mean de-interleaving again inside the EQ.
            //
            // Only the frames that actually arrived are processed. Running the
            // filter over the silence that pads a short block would let it ring
            // on padded zeros and colour the start of the next block.
            //
            // This call neither allocates nor locks (see dsp.hpp): the parameter
            // snapshot is picked up lock-free at the top of the block.
            if (got > 0) dsp_.process(scratchPtrs.data(), channels, static_cast<int>(got));
        }

        // Underrun: the ring could not supply the whole block. Count ONCE per
        // starved block -- a dropout is one audible event, however many frames
        // it spans, and SPEC 8.2 states its budget in xruns. While the feeder
        // is still priming the ring right after a start or a seek, the first
        // block or two are legitimately empty; those are not counted, because
        // counting them would make every play() look like a fault.
        const bool priming = (playedFrames_.load(std::memory_order_relaxed) < 2 * bufferFrames);
        // A short block once the feeder is finished is the track ending, which is
        // the expected state, not a fault. Counting it as an underrun made every
        // track report 3 xruns at its end and then trigger a pointless buffer
        // increase (and, before that was fixed, a stuck paused player).
        const bool draining = feederDone_.load(std::memory_order_acquire);
        const bool fadingOut = fadeMs > 0;
        if (!quiet && !fadingOut && got < available && !priming && !draining) {
            status_.xrunCount.fetch_add(1, std::memory_order_relaxed);
            ++consecutiveXruns_;
            if (consecutiveXruns_ >= 3) {
                // SPEC 3.2: three consecutive underruns double the buffer.
                // CR-027：上限按延迟档位（maxBufferMs_，start() 里按档位算好），
                // balanced 仍是上一轮的 50 ms。loggedRequest_ 由控制线程读取。
                if (requestedBufferMs_ < maxBufferMs_) {
                    requestedBufferMs_ = requestedBufferMs_ < 5 ? 10 : requestedBufferMs_ * 2;
                    if (requestedBufferMs_ > maxBufferMs_) requestedBufferMs_ = maxBufferMs_;
                    status_.currentBufferMs = requestedBufferMs_;
                    needBiggerBuffer_.store(true, std::memory_order_release);
                }
                consecutiveXruns_ = 0;
            }
        } else if (got >= available || quiet || fadingOut) {
            consecutiveXruns_ = 0;
        }

        // Gain ramp across the block, so a volume change cannot click.
        // Effective gain: mute is folded in HERE, at the one place the ramp is
        // computed, so muting reuses the same 10 ms smoothing as a volume drag
        // and cannot click. Everything downstream is unchanged.
        const bool muted = muted_.load(std::memory_order_relaxed);
        float targetVolume = muted ? 0.0f : volume_.load(std::memory_order_relaxed);

        // Apply fade commands at sample rate, independent of the device period.
        // Interleaving and sample conversion happen exactly here, at the output
        // boundary, from the internal planar float32 representation (SPEC 3.2).
        // The target type is the STREAM format, not an assumption: exclusive mode
        // is handed integer PCM at the source depth, and writing float32 into it
        // would produce noise rather than music.
        const int bits = status_.bitsPerSample;
        const bool floatStream = status_.isFloat;
        // CR-025：每块读一次 dither 档位（控制线程可能刚改过）。档位只影响
        // 整数量化点怎么处理量化误差，浮点流不经过这里。
        const DitherMode ditherMode = static_cast<DitherMode>(
            ditherMode_.load(std::memory_order_relaxed));

        for (UINT32 frame = 0; frame < available; ++frame) {
            // The transition envelope follows the device clock, including
            // silence used to pad a short ring read. Advancing it only for
            // `got` frames leaves fade-out pending during a brief feeder
            // underrun and forces the control thread to hard-stop at its
            // deadline—the exact edge that produces a pop.
            const float fadeGain = fade_.next();
            if (frame < got) {
                const float blockGain = volumeGain_.next(targetVolume);
                // Advance once per audio frame, never once per channel, so the
                // stereo image and fade duration hold.
                const float gain = blockGain * fadeGain;
                for (int ch = 0; ch < channels; ++ch) {
                    const float sample = scratch[ch][frame] * gain;
                    scratch[ch][frame] = sample;
                    const size_t index = static_cast<size_t>(frame) * channels + ch;
                    if (floatStream) {
                        reinterpret_cast<float*>(buffer)[index] = sample;
                    } else if (bits == 16) {
                        // One shared implementation of "float becomes integer".
                        // It clamps (a sample above 1.0 would wrap and turn the
                        // loudest moment into a click) and applies TPDF dither
                        // whenever this stream carries fewer bits than the file
                        // it came from -- SPEC line 203. Sharing it with the
                        // offline tests is the point: a test that re-implements
                        // this arithmetic only proves the copy agrees with itself.
                        reinterpret_cast<int16_t*>(buffer)[index] = static_cast<int16_t>(
                            quantizeSample(sample, 16, status_.sourceBits, dither_[ch], ditherMode));
                    } else if (bits == 24) {
                        // 24-BIT PRECISION COMES IN TWO CONTAINER WIDTHS, and
                        // writing the wrong one overruns the buffer.
                        //
                        // 24-in-32 (4 bytes/sample, left-justified) is what most
                        // endpoints accept. 24-in-24 (3 bytes/sample, packed
                        // little-endian) is what a good DAC accepts, and there
                        // the stride is 3 bytes -- so writing an int32_t stride
                        // writes one byte past every sample, four bytes per
                        // frame too far. That is a heap overflow inside the
                        // endpoint buffer, and it crashed the engine the first
                        // time it ran against hardware that offers a real
                        // 24-bit container. Every earlier device forced 24-in-32,
                        // so the bug had never been reachable.
                        const int32_t packed =
                            quantizeSample(sample, 24, status_.sourceBits, dither_[ch], ditherMode);
                        if (status_.bytesPerSample == 4) {
                            reinterpret_cast<int32_t*>(buffer)[index] = packed;
                        } else {
                            // quantizeSample returns the value left-justified for
                            // a 32-bit container; a 24-bit one wants the plain
                            // 24 bits, packed little-endian.
                            const int32_t v = packed >> 8;
                            BYTE* p = buffer + static_cast<size_t>(index) * 3;
                            p[0] = static_cast<BYTE>(v & 0xFF);
                            p[1] = static_cast<BYTE>((v >> 8) & 0xFF);
                            p[2] = static_cast<BYTE>((v >> 16) & 0xFF);
                        }
                    } else {
                        // 32-bit 整型写出（独占的 32-in-32；shared 如果给出 32-bit
                        // 整型混音格式也走这里）。stride 是 4 字节/样本，由容器的
                        // wBitsPerSample=32 决定（nBlockAlign = channels x 4），
                        // 与 validBits 无关。满刻度正峰的钳位缺口在 quantizeSample
                        // 的 32-bit 分支里修（见 dsp.cpp：float 表示不了 2^31-1，
                        // 旧算术会让 +1.0 变成 INT32_MIN，也就是一声爆音）。
                        reinterpret_cast<int32_t*>(buffer)[index] =
                            quantizeSample(sample, 32, status_.sourceBits, dither_[ch], ditherMode);
                    }
                }
            } else {
                // Pad the shortfall with silence and keep going: tearing the
                // stream down would be worse than a single dropout. The block was
                // already counted as one underrun above.
                const size_t first = static_cast<size_t>(frame) * channels;
                std::memset(reinterpret_cast<char*>(buffer) + first * status_.bytesPerSample,
                            0, static_cast<size_t>(channels) * status_.bytesPerSample);
            }
        }
#if TE_RT_TRACE
        renderStage_.store(6, std::memory_order_relaxed);
#endif
        renderClient_->ReleaseBuffer(available, 0);
        if (got > 0) meterTap_.push(scratchPtrs.data(), channels, static_cast<int>(got));
        endpointProgress_.submitted(available, got);
        // 先扣 padding 的账，再看淡出是否刚归零：本块的 available 属于淡出块，
        // 不能算进 padding，所以激活新 padding 必须放在扣账之后。
        if (padPhase) {
            padFramesRemaining -= static_cast<int>(available);
            if (padFramesRemaining <= 0) {
                padPhase = false;
                padDrainPending = true;
                // 提交水位：设备播到这里，说明 padding 已全部真正经过硬件缓冲。
                padTargetPlayed = endpointProgress_.submittedFrames();
            }
        }
        if (fadeMs > 0 && fade_.direction() == AudioFade::Direction::Out &&
            !fade_.active()) {
            fadeOutMs_.store(0, std::memory_order_release);
            // 淡出刚归零：进入静音 padding 阶段。至少 1 帧，避免采样率极低时
            // 整数除法把 padding 算成 0（那就退回旧的"零静音"行为）。
            padFramesTotal     = std::max(1, status_.sampleRate * kStopSilencePadMs / 1000);
            padFramesRemaining = padFramesTotal;
            padPhase           = true;
        }

        if (got > 0) {
            playedFrames_.fetch_add(got, std::memory_order_release);
            if (positionFrames_) positionFrames_->fetch_add(got, std::memory_order_release);
        }
    }

    // Stop the device from this thread: it is the only one touching the client
    // while playback is running.
    client_->Stop();
    fadeActive_.store(false, std::memory_order_release);

    if (mmcss) ::AvRevertMmThreadCharacteristics(mmcss);
    renderIdle_.store(true, std::memory_order_release);
    ::CoUninitialize();
}

} // namespace te
