#include "metadata.hpp"

// Flat header names on purpose: they match the layout TagLib installs
// (every header flattened into one directory), so this file keeps
// compiling whether TagLib comes from third_party/ or from a package.
#include <fileref.h>
#include <tag.h>
#include <tpropertymap.h>
#include <audioproperties.h>
#include <flacproperties.h>
#include <mp4properties.h>

#include "util.hpp"
#include "win_util.hpp"

namespace te {
namespace {

std::string codecFromExtension(const std::filesystem::path& file) {
    const std::string ext = toLowerAscii(toUtf8(file.extension()));
    if (ext == ".flac") return "FLAC";
    if (ext == ".mp3")  return "MP3";
    if (ext == ".m4a" || ext == ".aac") return "AAC";
    if (ext == ".wav")  return "WAV";
    if (ext == ".alac") return "ALAC";
    if (ext == ".ogg")  return "Vorbis";
    if (ext == ".opus") return "Opus";
    if (ext == ".wv")   return "WavPack";
    if (!ext.empty())   return ext.substr(1);
    return "unknown";
}

std::string firstOf(const TagLib::PropertyMap& map, const char* key) {
    const auto it = map.find(key);
    if (it == map.end() || it->second.isEmpty()) return std::string();
    return it->second.front().to8Bit(true);
}

int firstIntOf(const TagLib::PropertyMap& map, const char* key) {
    const std::string s = firstOf(map, key);
    if (s.empty()) return 0;
    int value = 0;
    std::size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
        value = value * 10 + (s[i] - '0');
        ++i;
    }
    return value;
}

} // namespace

bool readMetadata(const std::filesystem::path& file, TrackMeta& out) {
    out = TrackMeta{};

    // Pass the wide path: TagLib 2.x has a dedicated FileName(const wchar_t*)
    // constructor on Windows, and going through the narrow one would force the
    // path through the active ANSI code page -- which mangles every Chinese
    // filename in this library.
    const std::wstring widePath = file.wstring();
    TagLib::FileRef ref(widePath.c_str(), true, TagLib::AudioProperties::Accurate);
    if (ref.isNull() || !ref.file()) return false;

    const TagLib::PropertyMap props = ref.file()->properties();

    out.title       = firstOf(props, "TITLE");
    out.artist      = firstOf(props, "ARTIST");
    out.album       = firstOf(props, "ALBUM");
    out.albumArtist = firstOf(props, "ALBUMARTIST");
    out.genre       = firstOf(props, "GENRE");
    out.trackNo     = firstIntOf(props, "TRACKNUMBER");
    out.discNo      = firstIntOf(props, "DISCNUMBER");
    out.year        = firstIntOf(props, "DATE");
    if (out.albumArtist.empty()) out.albumArtist = out.artist;

    // The extension is a HINT; what the file declares wins. This has to happen
    // BEFORE the block below, because that block can correct it -- an earlier
    // version assigned it afterwards and silently undid the MP4 correction.
    out.codec = codecFromExtension(file);

    if (const TagLib::AudioProperties* ap = ref.audioProperties()) {
        out.durationMs = ap->lengthInMilliseconds();
        out.sampleRate = ap->sampleRate();
        out.channels   = ap->channels();
        out.bitrate    = ap->bitrate();
        if (const auto* flac = dynamic_cast<const TagLib::FLAC::Properties*>(ap)) {
            out.bitDepth = flac->bitsPerSample();
        }
        // An extension cannot say what is inside an MP4: a .m4a holding ALAC and
        // a .m4a holding AAC are the SAME container, and this function used to
        // call both of them "AAC" because that is what the name suggested. That
        // is the same inference-from-a-proxy mistake this project keeps finding,
        // and it is not cosmetic -- the label is how a reader decides whether a
        // file is allowed to be source-exact.
        //
        // codecId() and not codec(): codecId() returns the four-character code
        // from the sample description atom, which is what the FILE says. The
        // enum only covers the shapes TagLib's own parser recognises -- TagLib
        // 2.3.2 classifies ALAC only when that atom is exactly 88 bytes, and the
        // ALAC file this engine's own test material produces is 72, so the enum
        // reports Unknown while the file says 'alac' in plain sight.
        if (const auto* mp4 = dynamic_cast<const TagLib::MP4::Properties*>(ap)) {
            const std::string id = toLowerAscii(mp4->codecId().to8Bit(true));
            if      (id == "alac") out.codec = "ALAC";
            else if (id == "mp4a") out.codec = "AAC";
            else if (id == "flac") out.codec = "FLAC";
            else if (id == "opus") out.codec = "Opus";
            else if (id == "ec-3") out.codec = "EAC3";
            else if (id == "ac-3") out.codec = "AC3";
            else if (!id.empty())  out.codec = id;   // report what the file says
            if (mp4->bitsPerSample() > 0) out.bitDepth = mp4->bitsPerSample();
        }
    }

    // Some files carry an empty TITLE tag; the contract still needs a label for
    // the list, and the driver asserts every track has one. The file stem is
    // used verbatim -- including its runs of spaces and combining marks.
    if (out.title.empty()) {
        const std::u8string stem = file.stem().u8string();
        out.title = std::string(stem.begin(), stem.end());
    }
    return true;
}

} // namespace te
