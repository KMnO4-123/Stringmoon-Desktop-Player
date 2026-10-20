#pragma once
// TagLib-backed tag / audio-property reader (CONTRACT 3.3 scan; SPEC 7.2 columns).
//
// Isolated in its own translation unit so the catalog and the protocol never
// depend on TagLib's headers, and so a TagLib problem can never take the audio
// path down with it.

#include <cstdint>
#include <filesystem>
#include <string>

namespace te {

struct TrackMeta {
    std::string title;          // falls back to the file stem when the tag is empty
    std::string artist;
    std::string album;
    std::string albumArtist;
    std::string genre;
    std::string codec;          // "FLAC", "MP3", ... derived from the extension
    int         trackNo    = 0;
    int         discNo     = 0;
    int         year       = 0;
    int         durationMs = 0;
    int         sampleRate = 0;
    int         channels   = 0;
    int         bitDepth   = 0;
    int         bitrate    = 0;  // kbps
};

// Reads tags plus audio properties from one file. Returns false when the file
// cannot be opened or parsed at all, which the scan counts into "failed".
// Never throws and never writes to stdout.
bool readMetadata(const std::filesystem::path& file, TrackMeta& out);

} // namespace te
