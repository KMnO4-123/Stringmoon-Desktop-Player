// device_monitor.hpp -- WASAPI endpoint change notifications.
//
// SPEC 3.3 line 203 requires IMMNotificationClient: "device hot-plug: drift out
// over 10 ms, release the stream, reopen by ID, fall back to the default on
// failure, fade in over 20 ms; Bluetooth degrades to shared; an occupied
// exclusive device degrades silently."
//
// CONTRACT 3.3 also defines a `device_changed` event, which the engine had
// never emitted -- so a client could not learn that the user unplugged their
// headphones, and the UI kept showing a device that was no longer there.
//
// The callback arrives on a SYSTEM thread with no ordering guarantee relative to
// the control loop, so it does the minimum possible: it records what changed and
// sets a flag. All the work happens on the control thread, which is the only
// thread allowed to touch the stream. Doing the reopen inside the callback would
// mean re-entering the audio API from a thread whose apartment and timing the
// engine does not control.
#pragma once

#include <string>

namespace te {

// What a notification reported, in a form the control loop can act on without
// knowing anything about COM.
struct DeviceChange {
    // The default render endpoint became a different device.
    bool        defaultChanged = false;
    // The device the engine is currently using was removed or disabled.
    bool        currentRemoved = false;
    // Reported for the event payload. Empty when not applicable.
    std::string newDefaultId;
    std::string newDefaultName;
    std::string removedId;
};

// Starts listening. Idempotent. Safe to call before any stream exists, which is
// what makes a device appearing later reach the engine at all.
void startDeviceMonitor();

// Releases the COM registration. Safe to call when never started.
void stopDeviceMonitor();

// Takes the pending change, if any, and clears it. Called from the control loop;
// returns false when nothing happened, which is the overwhelmingly common case.
bool takeDeviceChange(DeviceChange& out);

} // namespace te
