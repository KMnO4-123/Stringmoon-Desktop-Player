#pragma once
// The two device property keys this engine reads, declared locally.
//
// Why not just include <functiondiscoverykeys_devpkey.h>: that header needs
// propkeydef.h first, and it only declares the keys unless INITGUID is defined
// in exactly one translation unit -- which then drags a global GUID definition
// into whichever file got it. Two keys are all this project needs, and spelling
// them out here removes the include-order trap and the one-TU-with-INITGUID
// rule entirely. The values are the documented ones from the Windows SDK.
//
//   PKEY_Device_FriendlyName    {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
//   PKEY_Device_EnumeratorName  {a45c254e-df1c-4efd-8020-67d146a850e0}, 1
//
// The enumerator name is how a paired Bluetooth sink is identified: Windows
// reports it as "BTHENUM". That matters because P4 says a Bluetooth link always
// re-encodes, so the UI must label it as degraded rather than as HiFi.

#include <windows.h>
#include <propkeydef.h>
#include <propidl.h>

#include <string>

#include "win_util.hpp"

namespace te {

inline constexpr PROPERTYKEY kPkeyDeviceFriendlyName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

inline constexpr PROPERTYKEY kPkeyDeviceEnumeratorName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 1};

// Reads a string property, returning an empty string when it is absent or of
// another type. Shared rather than duplicated: both the device enumeration and
// the output's Bluetooth check read the same property, and two copies of this
// would be two places for the BTHENUM test to drift apart.
inline std::string readStringProperty(IPropertyStore* store, const PROPERTYKEY& key) {
    PROPVARIANT pv;
    ::PropVariantInit(&pv);
    std::string out;
    if (SUCCEEDED(store->GetValue(key, &pv)) && pv.vt == VT_LPWSTR && pv.pwszVal) {
        out = wideToUtf8(pv.pwszVal);
    }
    ::PropVariantClear(&pv);
    return out;
}

} // namespace te
