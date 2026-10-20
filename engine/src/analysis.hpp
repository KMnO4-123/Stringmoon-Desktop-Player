// analysis.hpp -- EBU R128 loudness scanning, for ReplayGain 2.0.
//
// SPEC 3.4 asks for a libebur128 scan (whole track and album), a target of
// -18 LUFS, and track_peak to prevent clipping. The gain APPLICATION already
// shipped (see dsp.hpp); this is the measurement half, without which the engine
// can apply a ReplayGain value but cannot compute one.
//
// libebur128 is vendored at third_party/libebur128 (v1.2.6, MIT). It is the
// component SPEC 2.6 names, so the measurement is the reference implementation
// rather than my reading of the standard -- the one place where using a library
// is more honest than writing the algorithm, because loudness is defined by a
// specification everyone must agree on to the decibel.
//
// Decoding goes through the engine's OWN decoders (dr_flac / dr_wav), not a
// second audio stack: a measurement produced by a different decoder than the
// one that plays the file is a measurement of a different signal.
#pragma once

#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "audio_source.hpp"

namespace te {

// SPEC 3.4: the ReplayGain 2.0 reference level.
inline constexpr double kReplayGainTargetLufs = -18.0;

struct LoudnessResult {
    bool   ok = false;
    // EBU R128 integrated loudness, LUFS. -inf when the track is silent or too
    // short to gate, which is why it is reported alongside ok rather than alone.
    double integratedLufs = 0.0;
    double truePeakDb     = 0.0;   // highest true peak across channels
    double samplePeakDb   = 0.0;   // highest raw sample peak, for reference
    int64_t framesSeen    = 0;
    int     sampleRate    = 0;
    int     channels      = 0;
};

// ReplayGain 2.0 gain for a measurement: how much to change the level so the
// track lands on the reference. The sign is the engine's convention -- a QUIET
// master (integrated -24 LUFS) yields +6 dB, which is what the user expects a
// 'ReplayGain' to do.
double replayGainDb(double integratedLufs, double targetLufs = kReplayGainTargetLufs);

// Linear peak from a dB true peak, for the preventClip cap in dsp.cpp. That
// formula works in linear amplitude, and feeding it a dB value silently
// produces a cap of about 1.0 for every input, which looks like it works.
double truePeakLinear(double truePeakDb);

// Equal-loudness-weighted scan over an already-decoded planar buffer.
// Exposed separately from the file path so the offline tests can drive it with
// synthesised signals of KNOWN loudness -- the standard's own calibration
// signals -- instead of only ever measuring real music, where any bug still
// produces a plausible number.
bool analyzePlanar(const float* const* planes, int channels, int sampleRate,
                   int64_t frames, LoudnessResult& out, std::string& error);

// Wraps the libebur128 state so this header does not include ebur128.h. Defined
// at NAMESPACE scope, not inside the class: a nested declaration would name a
// different type than a definition written outside it.
struct EburStateHolder;

// One scan over a set of tracks.
//
// Deliberately accumulates rather than analysing one file at a time: album
// loudness is not the average of track loudnesses, it is the gated loudness of
// the album as a whole, and libebur128 needs the per-track states alive to
// combine them. Measuring tracks independently and averaging would give a
// different and wrong album figure -- and it would look entirely reasonable.
class LoudnessScan {
public:
    LoudnessScan();
    ~LoudnessScan();
    LoudnessScan(const LoudnessScan&) = delete;
    LoudnessScan& operator=(const LoudnessScan&) = delete;

    // Decodes the file through the engine's own decoder and measures it.
    // maxSeconds <= 0 means the whole file; a positive value bounds the work so
    // a caller can trade accuracy for time on a huge library.
    //
    // Takes a path, NOT a string. Converting to UTF-8 and back looks harmless
    // and is not: std::filesystem::path built from a narrow string reinterprets
    // the bytes in the active ANSI code page, which turned every Chinese path in
    // this library into mojibake. The decoder already takes a path, so the
    // correct move is to not convert at all (see util.hpp).
    //
    // forceDecode ignores the cache and re-measures. It exists for one case: an
    // album figure needs a decoder state per track and a cached track has none.
    // Rather than approximate the album from cached per-track numbers -- which
    // would give a plausible wrong answer, the exact failure this file guards
    // against -- the caller re-runs the pass and pays the decode.
    bool addFile(const std::filesystem::path& path, double maxSeconds, std::string& error,
                 bool forceDecode = false);

    // Album (or set) figures across everything added so far. Uses libebur128's
    // multi-state entry point, so this is the gated loudness of the whole set
    // and not an average of the parts.
    //
    // Fails rather than guessing when the set cannot be recombined: see the
    // cache note in analysis.cpp.
    bool album(LoudnessResult& out, std::string& error) const;

    // Per-track figures, in the order the files were added.
    const std::vector<LoudnessResult>& tracks() const { return tracks_; }

    // Total audio measured so far, in seconds, so a caller can report progress
    // or decide it has done enough.
    double analysedSeconds() const;

    void clear();

    // --- the on-disk cache (SPEC 8) -----------------------------------------

    // Loads once, lazily, from addFile. A missing, unreadable or corrupt cache
    // is NOT an error: it costs a re-measurement and nothing else, so it
    // degrades to a cold scan rather than failing one the user asked for.
    void loadCache();

    // Writes atomically (temp file + rename), so a crash part-way through leaves
    // the previous cache intact rather than a truncated file that the next run
    // would have to detect as corrupt.
    bool saveCache(std::string& error) const;

    // How many tracks were served from the cache instead of being decoded.
    int cacheHits() const;

    // How many entries the cache holds, and where it lives. Both are reported
    // in the command reply: without them a miss is indistinguishable from a
    // cache that was never written, which is the difference between "the file
    // changed" and "persistence is broken".
    int cacheSize() const;
    int cacheKeyCount() const;
    // Why the most recent lookup missed. A cache that silently never hits is
    // indistinguishable from one that is not being read, and the two have very
    // different causes.
    std::string cacheMissReason() const;
    static std::string cacheFilePath();

    // True when every track in this scan came from the cache.
    bool allFromCache() const;

    // --- incremental use, for a caller that must stay responsive -------------
    //
    // A full-library scan is about two minutes of decoding, and a synchronous
    // command that long makes the engine deaf: the app cannot ask for progress,
    // cannot stop it, and cannot do anything else. These three calls let the
    // control loop advance the work a slice at a time.
    //
    // THE CONSTRAINT THAT SHAPES THIS: album loudness wants a decoder state per
    // track, but holding 91 of them costs 10-20 MB and SPEC 8.2 budgets the
    // whole engine at 60 MB RSS. So a scan accumulates per-track RESULTS (a few
    // hundred bytes each, bounding memory) and reports no album figure. That is
    // the honest trade: per-track ReplayGain works at any library size, album
    // ReplayGain only where the set is small enough to hold, and the caller is
    // told which it got rather than handed a wrong number.
    void beginScan(const std::vector<std::filesystem::path>& files, double maxSeconds,
                   bool forceDecode);

    // Advances by bounded work and returns true while there is still work.
    //
    // Bounds are in CHUNKS of audio (4096 frames each) and milliseconds. A
    // chunk-based bound is what keeps the control loop responsive: bounding only
    // within a file was useless, because one 200-second track took about 1.5 s
    // to measure, so a small time budget still produced multi-second stalls.
    bool stepScan(size_t maxChunks, double maxMs);

    size_t scanTotal() const;
    size_t scanDone() const;

    // Chunks measured since the scan began. The file count alone moves only once
    // per track (91 times for the whole library), which is too coarse to drive a
    // progress bar; this advances continuously and costs nothing to read.
    long long scanChunks() const;

    // True when a scan was started and has not been fully stepped. A caller uses
    // this to know it owes the loop more work before the results are complete.
    bool scanPending() const;

    // Records a successful album figure for this exact set, so a repeat scan is
    // free. Separate from album() on purpose: album() is const, and a cache
    // write hidden inside a query method is a surprise.
    void cacheAlbumResult(const LoudnessResult& album);

private:
    // One cached measurement. Small enough that a whole library's cache is a
    // few tens of KB in memory.
    struct CacheEntry {
        long long size = 0;
        long long mtime = 0;
        double    lufs = 0.0;
        double    truePeakDb = 0.0;
        double    samplePeakDb = 0.0;
        long long frames = 0;
        int       rate = 0;
        int       channels = 0;
    };

    // Album figures are cached by the EXACT track list. The per-file entries
    // already prove nothing changed, so matching the list is sufficient and
    // cannot collide -- and a collision here would serve a wrong album gain.
    struct CachedSet {
        std::vector<std::string> tracks;
        LoudnessResult           album;
    };
    bool cachedAlbum(const std::vector<std::string>& keys, LoudnessResult& out) const;
    void rememberAlbum(const std::vector<std::string>& keys, const LoudnessResult& album);

    struct Impl;
    std::unique_ptr<Impl> impl_;
    std::vector<LoudnessResult> tracks_;

    // Keyed by path; the size and modification time inside each entry are what
    // make a hit safe.
    std::map<std::string, CacheEntry> cache_;
    std::vector<CachedSet> cachedSets_;
    bool cacheLoaded_ = false;
    int  cacheHits_   = 0;
    std::string lastMiss_;

    // Incremental-scan state. scanIndex_ reaching scanFiles_.size() means done.
    std::vector<std::filesystem::path> scanFiles_;
    size_t scanIndex_     = 0;
    double scanMaxSeconds_ = 0.0;
    bool   scanForceDecode_ = false;

    // --- the file currently being measured, in bounded chunks ---------------
    //
    // Exactly ONE file is ever in flight. That is what makes the slice bound
    // mean something: bounding only BETWEEN files was useless, because a single
    // track is around 200 seconds of audio and took ~1.5 s to measure, so a
    // 15 ms budget still produced multi-second stalls in the control loop.
    //
    // Keeping one decoder open costs a few hundred KB and bounds memory
    // independently of library size, which is how album state for 91 tracks is
    // avoided (SPEC 8.2 budgets the engine at 60 MB).
    // NOTE: NOT `std::unique_ptr<struct AudioSource>`.
    // Declaring the struct inline here introduces a NEW incomplete type, so the
    // unique_ptr picks a different default_delete and the linker then looks for
    // an openAudioSource with a matching return type that does not exist. The
    // type comes from audio_source.hpp, which must be included for it.
    std::unique_ptr<AudioSource> scanSource_;
    std::unique_ptr<EburStateHolder> scanState_;
    int                          scanRate_ = 0;
    int                          scanChannels_ = 0;
    int64_t                      scanFramesRead_ = 0;
    int64_t                      scanFrameLimit_ = 0;
    std::string                  scanKey_;
    long long                    scanFileSize_ = 0;
    long long                    scanFileMtime_ = 0;
    bool                         scanFileStatOk_ = false;
    // Whether a file is currently open and mid-measurement. Tracked explicitly
    // because the buffers are per-call locals: inferring it from their emptiness
    // made every slice reopen the same file (see stepScan).
    bool                         scanFileOpen_ = false;
    long long                    scanChunks_ = 0;

    // Scratch buffers, allocated when a file opens and reused for every slice of
    // that file. They CANNOT be locals of stepScan: the control loop calls it
    // once per pass, so per-call locals meant every slice after the first found
    // them empty, believed no file was open, and reopened the same decoder from
    // scratch -- the scan made eight chunks of progress and then threw it away,
    // forever.
    std::vector<std::vector<float>> scanPlanes_;
    std::vector<float*>             scanViews_;
    std::vector<float>              scanInterleaved_;

    bool openNextScanFile();
    void finishCurrentScanFile();
    void recordScanFailure();
    void abortCurrentFile();
};

} // namespace te
