// device_monitor.cpp -- the IMMNotificationClient implementation.

#include "device_monitor.hpp"

#include <windows.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <cstdio>
#include <mutex>
#include <string>

#include "util.hpp"
#include "win_util.hpp"

namespace te {
namespace {

// The callback's payload. Guarded by a mutex because the callback runs on a
// system thread while takeDeviceChange() runs on the control thread, and a
// std::string pair cannot be read and written concurrently.
struct Pending {
    std::mutex   mutex;
    DeviceChange change;
    bool         any = false;
};

Pending g_pending;
std::atomic<bool> g_started{false};
// Held so the registration can be undone. Kept as void* so the header stays
// free of COM types.
void* g_enumerator = nullptr;

// The object lives for the whole process, so the reference count is a formality
// -- but it still has to be correct, because returning a wrong count would let
// COM release an object the engine is still using.
class DeviceNotifier final : public IMMNotificationClient {
public:
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
        if (!out) return E_POINTER;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
            *out = static_cast<IMMNotificationClient*>(this);
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR deviceId, DWORD newState) override {
        // Only removal matters: a device APPEARING does not change what is
        // playing, but one disappearing invalidates the open stream.
        if (!(newState & DEVICE_STATE_ACTIVE)) {
            const std::string id = deviceId ? wideToUtf8(deviceId) : std::string();
            remember([&](DeviceChange& c) {
                c.currentRemoved = true;
                c.removedId = id;
            });
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }

    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR deviceId) override {
        const std::string id = deviceId ? wideToUtf8(deviceId) : std::string();
        remember([&](DeviceChange& c) {
            c.currentRemoved = true;
            c.removedId = id;
        });
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role,
                                                     LPCWSTR deviceId) override {
        // ONLY THE CONSOLE ROLE. Windows raises this callback separately for the
        // console, multimedia and communications roles, and the engine follows
        // eConsole -- the one the system Sound settings treat as "the" default
        // output.
        //
        // Reacting to all three was a mistake with a visible symptom: the FIRST
        // notification of a single switch arrived for a role the engine does not
        // follow, so the device_changed event named the device it was LEAVING
        // rather than the one it moved to.
        if (flow != eRender || role != eConsole) return S_OK;
        const std::string id = deviceId ? wideToUtf8(deviceId) : std::string();
        remember([&](DeviceChange& c) {
            c.defaultChanged = true;
            c.newDefaultId = id;
        });
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override {
        // A renamed device is worth nothing to a stream that is already open.
        return S_OK;
    }

private:
    template <typename Fn>
    static void remember(Fn&& apply) {
        std::lock_guard<std::mutex> lock(g_pending.mutex);
        apply(g_pending.change);
        g_pending.any = true;
    }
};

DeviceNotifier g_notifier;

} // namespace

void startDeviceMonitor() {
    if (g_started.exchange(true)) return;

    // The MTA is what the rest of the audio code uses. Joining it here means the
    // callback can arrive on an arbitrary RPC thread without apartment work.
    ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* enumerator = nullptr;
    const HRESULT hr = ::CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                          CLSCTX_INPROC_SERVER,
                                          __uuidof(IMMDeviceEnumerator),
                                          reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) {
        // Not being able to listen is not fatal: everything still works, the
        // engine simply will not notice a hot-plug. Reporting it where it is
        // decided beats a silent no-op.
        std::fprintf(stderr, "[warn] device notifications unavailable (%s); "
                             "hot-plug will not be detected\n",
                     hresultToString(hr).c_str());
        g_started.store(false);
        return;
    }

    enumerator->RegisterEndpointNotificationCallback(&g_notifier);
    g_enumerator = enumerator;
}

void stopDeviceMonitor() {
    if (!g_started.exchange(false)) return;
    if (g_enumerator) {
        auto* enumerator = static_cast<IMMDeviceEnumerator*>(g_enumerator);
        enumerator->UnregisterEndpointNotificationCallback(&g_notifier);
        enumerator->Release();
        g_enumerator = nullptr;
    }
    ::CoUninitialize();
}

bool takeDeviceChange(DeviceChange& out) {
    std::lock_guard<std::mutex> lock(g_pending.mutex);
    if (!g_pending.any) return false;
    out = g_pending.change;
    g_pending.change = DeviceChange{};
    g_pending.any = false;
    return true;
}

} // namespace te
