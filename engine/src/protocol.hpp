#pragma once
// Frozen protocol constants (CONTRACT 3.4 / 3.5). Copied verbatim from the
// contract on purpose: these strings are the shared language with the app, and
// a typo here is a silent protocol split. Do not "improve" them.

namespace te {

inline constexpr int         kProtocolVersion = 1;
inline constexpr const char* kEngineVersion   = "0.1.0";

// CONTRACT 3.4 - exactly six codes exist. Nothing else may be returned.
namespace err {
inline constexpr const char* kDevice      = "ERR_DEVICE";       // output device will not open / lost
inline constexpr const char* kDecode      = "ERR_DECODE";       // corrupt file, unsupported encoding
inline constexpr const char* kNotFound    = "ERR_NOTFOUND";     // trackId or path missing
inline constexpr const char* kState       = "ERR_STATE";        // command not legal in this state
inline constexpr const char* kUnsupported = "ERR_UNSUPPORTED";  // capability unavailable
inline constexpr const char* kInternal    = "ERR_INTERNAL";     // anything else
} // namespace err

// CONTRACT 3.5 - m3u of one prefix plus a 4-digit ordinal.
inline constexpr const char* kTrackIdPrefix = "tl_";

} // namespace te
