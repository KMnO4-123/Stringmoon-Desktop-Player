#pragma once
// Small shared helpers. The UTF-8 conversions here are not cosmetic: on Windows
// std::filesystem::path constructed from std::string reinterprets the bytes in
// the active ANSI code page, which silently corrupts every Chinese path in this
// project (the test library lives in a folder whose name is Chinese). Paths are
// therefore converted explicitly through char8_t, and back out the same way.

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace te {

// UTF-8 byte string -> filesystem path (Windows: proper wide conversion).
inline std::filesystem::path fromUtf8(std::string_view s) {
    const auto* p = reinterpret_cast<const char8_t*>(s.data());
    return std::filesystem::path(std::u8string(p, p + s.size()));
}

// filesystem path -> UTF-8 byte string.
inline std::string toUtf8(const std::filesystem::path& p) {
    const std::u8string u = p.u8string();
    return std::string(u.begin(), u.end());
}

inline std::string toLowerAscii(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

inline bool endsWithNoCase(std::string_view s, std::string_view suffix) {
    if (s.size() < suffix.size()) return false;
    return toLowerAscii(std::string(s.substr(s.size() - suffix.size()))) == toLowerAscii(std::string(suffix));
}

// Zero-pad an ordinal: "tl_" + 4 digits, widening only past 9999 so the format
// never silently changes for the 91-track library.
inline std::string formatTrackId(long long ordinal) {
    std::string n = std::to_string(ordinal < 0 ? 0 : ordinal);
    if (n.size() < 4) n.insert(n.begin(), 4 - n.size(), '0');
    return std::string("tl_") + n;
}

} // namespace te
