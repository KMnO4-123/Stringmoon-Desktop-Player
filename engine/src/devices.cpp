#include "devices.hpp"

#include <audioclient.h>    // IAudioClient / GetMixFormat
#include <mmdeviceapi.h>
#include <mmreg.h>          // WAVEFORMATEX
#include <propidl.h>

#include <algorithm>

#include "exclusive_format.hpp"
#include "win_props.hpp"
#include "win_util.hpp"

namespace te {

namespace {

// Rates worth probing. The library here is 44.1/48/96 kHz and the device mix
// format is 48 kHz, so those three are the ones that decide whether bit-perfect
// is reachable; the rest are included because a DAC that handles 192 kHz should
// be visible to the UI rather than hidden behind an assumption.
//
// 352800/384000 是本轮补上的上限档。为什么必须加：set_output 已经接受这两个
// 采样率（见 app.cpp 的采样率校验），但设备探测表只到 192 kHz 时，UI 永远
// 查不到它们——DAC 明明支持 384 kHz 也会被显示成"不支持"，用户选不到，
// 上一档 192 kHz 反而成了假上限。352.8 kHz 还正好是 DSD128 DoP 的出口率，
// 所以它不是"更大数字更好看"，而是有实际链路要用。
// 列表保持升序（能力列表的稳定顺序，也便于人读）。探测成本可控：每个
// (rate,bits) 组合最多试 3~4 个容器候选，IsFormatSupported 只静默询问驱动、
// 不打开流、不出声，绝大多数设备在第一个候选就返回。
constexpr int kProbeRates[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
constexpr int kProbeBits[]  = {16, 24, 32};

// Asks the endpoint whether it accepts one exclusive format. The format has to
// be built exactly as the stream will request it: WASAPI compares the whole
// WAVEFORMATEXTENSIBLE, including the channel mask and the sub-format, so an
// approximate probe would report a capability the stream open then fails to use.
bool probeExclusiveFormat(IMMDevice* device, int rate, int bits, int channels) {
    IAudioClient* client = nullptr;
    HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                                  reinterpret_cast<void**>(&client));
    if (FAILED(hr) || !client) return false;

    WAVEFORMATEXTENSIBLE candidates[4]{};
    const int count = teExclusiveFormatCandidates(bits, candidates);
    for (int i = 0; i < count; ++i) {
        const WAVEFORMATEXTENSIBLE want = teMakeExclusiveFormat(
            rate, candidates[i].Format.wBitsPerSample,
            candidates[i].Samples.wValidBitsPerSample, channels);
        WAVEFORMATEX* closest = nullptr;
        hr = client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                       reinterpret_cast<WAVEFORMATEX*>(&const_cast<WAVEFORMATEXTENSIBLE&>(want)),
                                       &closest);
        if (closest) ::CoTaskMemFree(closest);
        if (SUCCEEDED(hr)) {   // S_OK only: S_FALSE is a shared-mode nearest match
            client->Release();
            return true;
        }
    }
    client->Release();
    return false;
}


} // namespace

std::vector<DeviceInfo> enumerateRenderDevices() {
    std::vector<DeviceInfo> result;

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                    __uuidof(IMMDeviceEnumerator),
                                    reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) return result;

    std::string defaultId;
    {
        IMMDevice* def = nullptr;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &def)) && def) {
            LPWSTR id = nullptr;
            if (SUCCEEDED(def->GetId(&id)) && id) {
                defaultId = wideToUtf8(id);
                ::CoTaskMemFree(id);
            }
            def->Release();
        }
    }

    IMMDeviceCollection* collection = nullptr;
    if (SUCCEEDED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection)) && collection) {
        UINT count = 0;
        if (SUCCEEDED(collection->GetCount(&count))) {
            for (UINT i = 0; i < count; ++i) {
                IMMDevice* device = nullptr;
                if (FAILED(collection->Item(i, &device)) || !device) continue;

                DeviceInfo info;
                LPWSTR id = nullptr;
                if (SUCCEEDED(device->GetId(&id)) && id) {
                    info.id = wideToUtf8(id);
                    ::CoTaskMemFree(id);
                }

                IPropertyStore* store = nullptr;
                if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store)) && store) {
                    info.name = readStringProperty(store, kPkeyDeviceFriendlyName);
                    const std::string enumeratorName = readStringProperty(store, kPkeyDeviceEnumeratorName);
                    info.isBluetooth = (enumeratorName == "BTHENUM");
                    store->Release();
                }
                if (info.name.empty()) info.name = info.id;

                // Mix format tells the UI what the endpoint accepts in shared mode
                // before any stream exists (SPEC 3.3 capability probing).
                IAudioClient* client = nullptr;
                if (SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                                               reinterpret_cast<void**>(&client))) && client) {
                    WAVEFORMATEX* mix = nullptr;
                    if (SUCCEEDED(client->GetMixFormat(&mix)) && mix) {
                        info.channels   = mix->nChannels;
                        info.sampleRate = static_cast<int>(mix->nSamplesPerSec);
                        ::CoTaskMemFree(mix);
                    }
                    client->Release();
                }

                // Exclusive formats, probed one by one. A refusal here is not an
                // error: it is the answer, and the engine reports it so the UI
                // can say "this track will not be bit-perfect" before the user
                // wonders why the badge is missing.
                // Reported as "rate:bits", where bits is the SOURCE precision the
                // endpoint can take at that rate. The container it actually uses
                // (24-in-24 or 24-in-32) is an implementation detail of the open
                // path, not something the UI or the user needs to distinguish.
                for (int rate : kProbeRates) {
                    for (int bits : kProbeBits) {
                        if (probeExclusiveFormat(device, rate, bits, info.channels)) {
                            info.exclusiveFormats.push_back(std::to_string(rate) + ":" +
                                                            std::to_string(bits));
                        }
                    }
                }

                info.isDefault = (!defaultId.empty() && info.id == defaultId);
                result.push_back(std::move(info));
                device->Release();
            }
        }
        collection->Release();
    }
    enumerator->Release();

    // Deterministic order for tests: default device first, then by name.
    std::stable_sort(result.begin(), result.end(), [](const DeviceInfo& a, const DeviceInfo& b) {
        if (a.isDefault != b.isDefault) return a.isDefault;
        return a.name < b.name;
    });
    return result;
}

bool DeviceInfo::supportsExclusiveAt(int rate, int bits) const {
    // The stream is opened with 16/24/32-bit containers, so a source depth maps
    // onto one of those the same way openExclusive() maps it. Keeping the two in
    // step matters: if they disagree the engine promises what it then cannot open.
    const int containerBits = bits <= 16 ? 16 : (bits <= 24 ? 24 : 32);
    const std::string wanted = std::to_string(rate) + ":" + std::to_string(containerBits);
    for (const auto& f : exclusiveFormats) {
        if (f == wanted) return true;
    }
    return false;
}

std::string defaultRenderDeviceId() {
    std::string id;
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                    __uuidof(IMMDeviceEnumerator),
                                    reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) return id;
    IMMDevice* def = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &def)) && def) {
        LPWSTR wide = nullptr;
        if (SUCCEEDED(def->GetId(&wide)) && wide) {
            id = wideToUtf8(wide);
            ::CoTaskMemFree(wide);
        }
        def->Release();
    }
    enumerator->Release();
    return id;
}

} // namespace te
