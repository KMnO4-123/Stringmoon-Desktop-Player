#include "catalog.hpp"

#include <windows.h>

#include <string_view>

namespace te {

namespace {
// What the scan will admit. This list is a FILTER, not a capability: whether a
// file can actually be decoded is answered by isDecodable() (CR-017), which
// opens it through the production decoder path. The two are deliberately
// different questions -- an extension says what a file claims to be.
//
// .oga is here because that is the extension Ogg-encapsulated FLAC and Ogg
// Vorbis are conventionally given (the `flac` and `oggenc` encoders both write
// it), and those are formats this build decodes in full. A file with the wrong
// extension for its contents is caught by the probe, not by this list.
//
// CR-032 扩容：新增的扩展名是「系统解码兜底 + DSD」能真正解开的格式。它们
// 出现在这里只说明"扫描时不要跳过"，能不能解仍由 isDecodable() 打开一次
// 回答 —— 这正是 .opus 曾经在列表里却没有解码器时留下的教训。.aif/.aiff/
// .wma/.ac3 现在有 MF 兜底；.dsf/.dff 由本轮新增的 DSD 源码解开。
// .wv/.ape 故意不加：本机没有 WavPack / Monkey's Audio 解码器，加了只会让
// 扫描把注定 unplayable 的文件数一遍。
const char* const kSupportedExtensions[] = {
    ".flac", ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus",
    ".aif", ".aiff", ".wma", ".ac3", ".dsf", ".dff"};
} // namespace

namespace {

// Case folding goes through the OS rather than toLowerAscii, so it matches the
// JavaScript toLowerCase() on the other side of this normalisation for
// non-ASCII letters too. LCMapStringEx with the invariant locale is the Windows
// equivalent of Unicode simple case mapping.
std::string lowerWide(const std::wstring& w) {
    if (w.empty()) return std::string();
    const int size = static_cast<int>(w.size());
    const int needed = ::LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE,
                                       w.data(), size, nullptr, 0, nullptr, nullptr, 0);
    if (needed <= 0) return toUtf8(std::filesystem::path(w));
    std::wstring folded(static_cast<size_t>(needed), L'\0');
    const int written = ::LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE,
                                        w.data(), size, folded.data(), needed,
                                        nullptr, nullptr, 0);
    if (written <= 0) return toUtf8(std::filesystem::path(w));
    folded.resize(static_cast<size_t>(written));
    return toUtf8(std::filesystem::path(folded));
}

} // namespace

std::string pathIdentityKey(const std::filesystem::path& p) {
    std::wstring w = p.wstring();
    for (wchar_t& c : w) if (c == L'/') c = L'\\';
    while (!w.empty() && w.back() == L'\\') w.pop_back();
    return lowerWide(w);
}

std::string pathIdentityKeyUtf8(std::string_view utf8) {
    return pathIdentityKey(fromUtf8(utf8));
}

bool isUnderDirKey(std::string_view key, std::string_view dirKey) {
    if (key.empty() || dirKey.empty()) return false;
    if (key.size() < dirKey.size()) return false;
    if (key.compare(0, dirKey.size(), dirKey) != 0) return false;
    if (key.size() == dirKey.size()) return true;
    // The boundary is the separator: d:\music must not be read as containing
    // d:\music2 (CR-013 ruling 2 says this explicitly).
    return key[dirKey.size()] == '\\';
}

bool Catalog::isSupportedExtension(const std::filesystem::path& p) {
    const std::string ext = toLowerAscii(toUtf8(p.extension()));
    for (const char* candidate : kSupportedExtensions) {
        if (ext == candidate) return true;
    }
    return false;
}

Json trackToJson(const Track& track) {
    const TrackMeta& m = track.meta;
    Json j = Json::object();
    j.set("trackId",    track.id);
    j.set("path",       toUtf8(track.path));
    j.set("title",      m.title);
    j.set("artist",     m.artist);
    j.set("album",      m.album);
    j.set("albumArtist", m.albumArtist);
    j.set("genre",      m.genre);
    j.set("trackNo",    m.trackNo);
    j.set("discNo",     m.discNo);
    j.set("year",       m.year);
    j.set("durationMs", m.durationMs);
    j.set("sampleRate", m.sampleRate);
    j.set("bitDepth",   m.bitDepth);
    j.set("channels",   m.channels);
    j.set("bitrate",    m.bitrate);
    j.set("codec",      m.codec);
    j.set("sizeBytes",  track.sizeBytes);
    return j;
}

} // namespace te
