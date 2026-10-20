#pragma once
// In-memory track registry.
//
// SPEC 7.1 is explicit that 91 tracks do not justify SQLite, FTS5, resumable
// scanning or multi-size cover caches yet ("do not pay the scale cost early").
// This is the whole data layer for M1: a vector plus an id lookup, owned by the
// control thread. The JSON shape produced here is the contract the app reads,
// so it is defined exactly once, in trackToJson below.

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <string>
#include <vector>

#include "json.hpp"
#include "metadata.hpp"
#include "util.hpp"

namespace te {

struct Track {
    std::string           id;              // "tl_0001" (CONTRACT 3.5)
    std::filesystem::path path;
    TrackMeta             meta;
    long long             sizeBytes = 0;
};

// Serialises one track exactly as CONTRACT 3.3 and SPEC 7.2 describe it.
Json trackToJson(const Track& track);

// A track's IDENTITY, normalised so that two spellings of the same directory
// are the same library. This is app/src/shared/library.ts's libraryPathKey
// reproduced deliberately and exactly -- '/' becomes '\', trailing separators
// are dropped, and the result is lower-cased -- because two independent
// normalisations would disagree in a way that is harder to find than the
// duplicate they were meant to prevent (CR-013 ruling 1).
//
// Limitations are inherited on purpose too: consecutive separators are not
// merged and a UNC leading '\\' is not special-cased, because neither shape can
// come out of the directory picker that feeds both sides.
std::string pathIdentityKey(const std::filesystem::path& p);
std::string pathIdentityKeyUtf8(std::string_view utf8);

// `key` is `dirKey` itself or something inside it. The boundary is a separator:
// d:\music must NOT be treated as containing d:\music2 (CR-013 ruling 2).
bool isUnderDirKey(std::string_view key, std::string_view dirKey);

class Catalog {
public:
    struct ScanResult {
        int added   = 0;
        int failed  = 0;
        int scanned = 0;
        // Already known, therefore not added. Reported separately because a
        // rescan of a known directory otherwise answers added=0, which reads
        // like a failure to every consumer that counts (CR-013 ruling 1).
        int skipped = 0;
        // Dropped because `replace` was asked for. Separate from `scanned`:
        // emptying a directory and scanning an empty one are different events.
        int removed = 0;
        // Files the production decoder REFUSED (CR-017). Reported separately
        // from `failed`, which means "metadata could not be read": a file whose
        // tags parse but whose audio cannot be decoded used to enter the
        // library and only fail when the user clicked it.
        int unplayable = 0;
        // Their paths, so the app can say WHICH files were left out instead of
        // reporting a bare number nobody can act on.
        std::vector<std::string> unplayablePaths;
    };

    // Scans one directory and appends every readable audio file that is NOT
    // already known. onProgress(done, total) is invoked between files; it may
    // emit events, but must not command the catalog.
    //
    // Identity is the normalised path, not the string the caller happened to
    // pass. Until CR-013 the key was the raw path, so "D:/music" and "D:\music"
    // were two different libraries: the same 91 files became 182 entries with
    // 182 distinct ids, and no consumer keyed on trackId could tell.
    //
    // replaceUnderDir drops every entry under this directory FIRST. That is how
    // the app says "this directory is no longer part of the library" (CR-013
    // ruling 2), and it is why `removed` is reported separately from `added`.
    //
    // recursive walks subdirectories (CR-017). Default false keeps every
    // existing caller byte-for-byte as it was.
    //
    // probeDecodable opens each new file through the PRODUCTION decoder before
    // admitting it (CR-017). Without it a file the decoder cannot read still
    // enters the library -- extension acceptance is not decodability, and .ogg/
    // .opus proved it: TagLib reads them, no decoder in this build can.
    //
    // `isPlayable` is supplied by the CALLER rather than called directly, so
    // this data layer keeps its deliberate freedom from the decoder headers
    // (see the file header): the capability is the decoder's to answer, and the
    // catalog only records the verdict. Null means "do not probe".
    template <typename ProgressFn, typename PlayableFn = bool (*)(const std::filesystem::path&, std::string&)>
    ScanResult scanDirectory(const std::filesystem::path& dir, ProgressFn&& onProgress,
                             bool replaceUnderDir = false, bool recursive = false,
                             PlayableFn isPlayable = nullptr) {
        ScanResult result;

        if (replaceUnderDir) {
            const std::string dirKey = pathIdentityKey(dir);
            const auto firstRemoved = std::remove_if(
                tracks_.begin(), tracks_.end(),
                [&](const Track& t) { return isUnderDirKey(pathIdentityKey(t.path), dirKey); });
            result.removed = static_cast<int>(std::distance(firstRemoved, tracks_.end()));
            tracks_.erase(firstRemoved, tracks_.end());
        }

        std::vector<std::filesystem::path> files;
        {
            // A directory that does not exist must not throw here: `replace` is
            // explicitly allowed to clean up a directory whose DRIVE is gone
            // (CR-013 ruling 2), and that is the common case.
            std::error_code dirEc;
            if (recursive) {
                for (std::filesystem::recursive_directory_iterator it(dir, dirEc), end;
                     !dirEc && it != end; it.increment(dirEc)) {
                    std::error_code entryEc;
                    if (!it->is_regular_file(entryEc) || entryEc) continue;
                    if (!isSupportedExtension(it->path())) continue;
                    files.push_back(it->path());
                }
            } else {
                for (std::filesystem::directory_iterator it(dir, dirEc), end;
                     !dirEc && it != end; it.increment(dirEc)) {
                    std::error_code entryEc;
                    if (!it->is_regular_file(entryEc) || entryEc) continue;
                    if (!isSupportedExtension(it->path())) continue;
                    files.push_back(it->path());
                }
            }
        }
        // Deterministic order: the app shows the list in scan order and the
        // driver asserts against a checked-in fixture.
        std::sort(files.begin(), files.end(), [](const auto& a, const auto& b) {
            return toUtf8(a.filename()) < toUtf8(b.filename());
        });

        const int total = static_cast<int>(files.size());
        int done = 0;
        onProgress(0, total);

        for (const auto& file : files) {
            // ALREADY KNOWN: SKIP IT. Do not append a second copy.
            //
            // The old code looked the path up, copied its id, and pushed the
            // track anyway -- so the same song appeared twice in the catalog,
            // both entries sharing one id. Reusing the id made it LOOK handled
            // without being handled, which is the worst of both: the count was
            // wrong and findById returned whichever copy came first.
            //
            // This also makes a rescan of a known directory cost no metadata
            // reads at all, which is the difference between a second scan being
            // free and being a full TagLib pass over the library.
            const std::string key = pathIdentityKey(file);
            if (findByKey(key)) {
                ++result.skipped;
                onProgress(++done, total);
                continue;
            }
            Track track;
            track.path = file;
            if (!readMetadata(file, track.meta)) {
                ++result.failed;
                onProgress(++done, total);
                continue;
            }
            // CR-017: the production decoder gets the final say. Extension
            // acceptance is not decodability -- .ogg and .opus are accepted by
            // isSupportedExtension and refused by every decoder in this build,
            // so without this they enter the library and fail on the user's
            // first click.
            if (isPlayable) {
                std::string reason;
                if (!isPlayable(file, reason)) {
                    ++result.unplayable;
                    if (result.unplayablePaths.size() < 200) {
                        result.unplayablePaths.push_back(toUtf8(file));
                    }
                    onProgress(++done, total);
                    continue;
                }
            }
            std::error_code sizeEc;
            if (auto size = std::filesystem::file_size(file, sizeEc); !sizeEc) {
                track.sizeBytes = static_cast<long long>(size);
            }
            track.id = formatTrackId(++nextOrdinal_);
            tracks_.push_back(std::move(track));
            ++result.added;
            onProgress(++done, total);
        }
        result.scanned = total;
        return result;
    }

    const std::vector<Track>& tracks() const { return tracks_; }

    const Track* findById(const std::string& id) const {
        for (const auto& t : tracks_) if (t.id == id) return &t;
        return nullptr;
    }
    // Lookup on the NORMALISED key, never on the raw string: that is the whole
    // of CR-013 ruling 1.
    const Track* findByKey(const std::string& key) const {
        for (const auto& t : tracks_) if (pathIdentityKey(t.path) == key) return &t;
        return nullptr;
    }
    std::size_t size() const { return tracks_.size(); }

    static bool isSupportedExtension(const std::filesystem::path& p);

private:
    std::vector<Track> tracks_;
    // Monotonic, and NEVER reused. `replace` frees ids; handing a freed id to a
    // different track would be worse than leaving it dangling, because a client
    // still holding the old id would silently act on the wrong track instead of
    // on nothing. The ruling explicitly allows ids to be re-assigned within one
    // launch, so this trades a little id space for that safety.
    long long          nextOrdinal_ = 0;
};

} // namespace te
