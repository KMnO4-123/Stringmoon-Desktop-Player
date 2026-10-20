#pragma once
// WASAPI render-device enumeration (CONTRACT 3.3 "devices", cmd list_devices).
//
// This is the probing half of SPEC 3.3: the contract reports a device list at
// startup and on request, and the UI shows the actual landing point the engine
// achieved rather than an assumed one.

#include <string>
#include <vector>

namespace te {

struct DeviceInfo {
    std::string id;                  // stable endpoint ID, echoed back by set_output
    std::string name;                // friendly name, UTF-8
    bool        isDefault   = false;
    bool        isBluetooth = false;
    int         channels    = 0;     // mix format channel count (0 = unknown)
    int         sampleRate  = 0;     // mix format sample rate in Hz (0 = unknown)

    // Exclusive-mode capability, probed rather than assumed.
    //
    // This matters more than it looks. Bit-perfect requires an exclusive stream
    // at the SOURCE rate with no mixer, so if the endpoint refuses 44.1 kHz
    // exclusive then every 44.1 kHz file in this library silently loses its
    // claim to bit-perfect however the UI is written. SPEC 3.3 replaced an
    // assumed 3 ms figure with capability probing for exactly this reason; the
    // same discipline applies to the format.
    //
    // Each entry is "<rate>:<bits>", e.g. "44100:24". Empty means the endpoint
    // accepts no exclusive format at all, which is a real configuration on
    // virtual and Bluetooth endpoints.
    std::vector<std::string> exclusiveFormats;
    // True when this endpoint accepts exclusive at the rate and depth the
    // calling track needs. The engine checks this before promising anything.
    bool supportsExclusiveAt(int rate, int bits) const;
};

// Enumerates active render endpoints. Returns an empty vector when the audio
// service is unreachable, which the caller reports as ERR_DEVICE.
std::vector<DeviceInfo> enumerateRenderDevices();

std::string defaultRenderDeviceId();

} // namespace te
