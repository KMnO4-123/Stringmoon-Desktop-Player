// analysis.cpp -- EBU R128 measurement on top of the vendored libebur128.

#include "analysis.hpp"

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include <chrono>
#include <fstream>
#include <iterator>
#include <system_error>

#include <windows.h>

#include "audio_source.hpp"
#include "ebur128.h"
#include "json.hpp"
#include "util.hpp"

namespace te {

// The definition of the forward declaration in analysis.hpp.
struct EburStateHolder {
    ebur128_state* state = nullptr;
    ~EburStateHolder() { if (state) ebur128_destroy(&state); }
};

} // namespace te

namespace te {

namespace {

// Integrated loudness plus both peak measures. LRA is deliberately not requested:
// ReplayGain 2.0 needs integrated loudness and peak, and the LRA mode keeps a
// long block history whose memory would be multiplied by every track in an album
// scan for a figure nothing consumes.
constexpr int kMode = EBUR128_MODE_I | EBUR128_MODE_TRUE_PEAK | EBUR128_MODE_SAMPLE_PEAK;

struct EburDeleter {
    void operator()(ebur128_state* s) const { ebur128_destroy(&s); }
};

using EburState = std::unique_ptr<ebur128_state, EburDeleter>;

// libebur128 takes INTERLEAVED float; the engine is planar everywhere else. The
// conversion happens here, once, at the boundary -- the alternative is a second
// decode path just for analysis, which would measure a different signal than the
// one that plays.
void interleave(const float* const* planes, int channels, int64_t frames, int64_t offset,
                std::vector<float>& out) {
    const int64_t count = std::min<int64_t>(frames, static_cast<int64_t>(out.size()) / channels);
    for (int64_t i = 0; i < count; ++i) {
        for (int ch = 0; ch < channels; ++ch) {
            out[static_cast<size_t>(i) * channels + ch] = planes[ch][offset + i];
        }
    }
}

double linearToDb(double linear) {
    if (!(linear > 0.0)) return -HUGE_VAL;
    return 20.0 * std::log10(linear);
}

// Reads the peak measures out of a state that has already been fed.
bool readResult(ebur128_state* st, int channels, int sampleRate, int64_t frames,
                LoudnessResult& out, std::string& error) {
    double loudness = 0.0;
    const int rc = ebur128_loudness_global(st, &loudness);
    if (rc != EBUR128_SUCCESS) {
        // Not an error worth failing a whole album scan over: a silent or very
        // short track cannot be gated, and saying so is more useful than a code.
        loudness = -HUGE_VAL;
    }

    double truePeak = 0.0, samplePeak = 0.0;
    for (int ch = 0; ch < channels; ++ch) {
        double tp = 0.0, sp = 0.0;
        if (ebur128_true_peak(st, static_cast<unsigned>(ch), &tp) == EBUR128_SUCCESS) {
            truePeak = std::max(truePeak, tp);
        }
        if (ebur128_sample_peak(st, static_cast<unsigned>(ch), &sp) == EBUR128_SUCCESS) {
            samplePeak = std::max(samplePeak, sp);
        }
    }

    out.ok             = std::isfinite(loudness);
    out.integratedLufs = std::isfinite(loudness) ? loudness : 0.0;
    out.truePeakDb     = linearToDb(truePeak);
    out.samplePeakDb   = linearToDb(samplePeak);
    out.framesSeen     = frames;
    out.sampleRate     = sampleRate;
    out.channels       = channels;
    (void)error;
    return true;
}

} // namespace

double replayGainDb(double integratedLufs, double targetLufs) {
    if (!std::isfinite(integratedLufs)) return 0.0;
    // Target minus measured: a track quieter than the reference gets a positive
    // gain, which is the direction a user expects the number to move.
    return targetLufs - integratedLufs;
}

double truePeakLinear(double truePeakDb) {
    if (!std::isfinite(truePeakDb)) return 0.0;
    return std::pow(10.0, truePeakDb / 20.0);
}

bool analyzePlanar(const float* const* planes, int channels, int sampleRate,
                   int64_t frames, LoudnessResult& out, std::string& error) {
    if (planes == nullptr || channels <= 0 || sampleRate <= 0 || frames <= 0) {
        error = "loudness analysis needs a non-empty planar buffer";
        return false;
    }
    EburState st(ebur128_init(static_cast<unsigned>(channels),
                              static_cast<unsigned long>(sampleRate), kMode));
    if (!st) {
        error = "cannot create a loudness state (unsupported channel count?)";
        return false;
    }

    std::vector<float> interleaved(static_cast<size_t>(frames) * channels);
    interleave(planes, channels, frames, 0, interleaved);
    if (ebur128_add_frames_float(st.get(), interleaved.data(),
                                 static_cast<size_t>(frames)) != EBUR128_SUCCESS) {
        error = "cannot add frames to the loudness measurement";
        return false;
    }
    return readResult(st.get(), channels, sampleRate, frames, out, error);
}

// ---------------------------------------------------------------------------
// Incremental scanning
// ---------------------------------------------------------------------------
//
// The point is that the CONTROL LOOP stays responsive. A synchronous scan of
// the library takes about two minutes, during which the engine cannot answer a
// get_state, cannot report progress, and cannot be stopped -- which is exactly
// the failure the scan command's deferral machinery was built to hide.

void LoudnessScan::beginScan(const std::vector<std::filesystem::path>& files,
                            double maxSeconds, bool forceDecode) {
    loadCache();
    scanFiles_       = files;
    scanIndex_       = 0;
    scanMaxSeconds_  = maxSeconds;
    scanForceDecode_ = forceDecode;
    scanChunks_      = 0;
    abortCurrentFile();
}

size_t LoudnessScan::scanTotal() const { return scanFiles_.size(); }
long long LoudnessScan::scanChunks() const { return scanChunks_; }
size_t LoudnessScan::scanDone() const { return scanIndex_; }
bool   LoudnessScan::scanPending() const { return scanIndex_ < scanFiles_.size(); }


// ---------------------------------------------------------------------------
// The on-disk cache
// ---------------------------------------------------------------------------
//
// Measuring a track means decoding the whole thing: 91 tracks is about two
// minutes of solid work, repeated on every scan. SPEC 8 asks for persistence
// precisely so that cost is paid once.
//
// Keyed by path AND by size and modification time. Keying on the path alone
// would serve a stale measurement for a file that has been re-encoded in place,
// and a wrong ReplayGain value is applied to the audio rather than merely
// displayed -- so the invalidation has to be real, not best-effort.

namespace {

// Bumped whenever the measurement changes meaning. SPEC 3.4 fixes the algorithm
// through libebur128 and the -18 LUFS target, but a future change to either must
// not silently reuse old numbers.
constexpr int kCacheVersion = 1;

// CacheEntry is private to LoudnessScan on purpose -- nothing outside should
// construct one -- so there is no namespace-scope alias here. The member
// functions that use it can see it; a free alias could not.

std::filesystem::path cachePath() {
    // Beside the executable, like the crash dump and the link map. The engine
    // already owns that directory; inventing an OS-specific data directory
    // would be more correct for a shipped product and is more machinery than
    // this needs.
    wchar_t buffer[MAX_PATH] = {};
    const DWORD n = ::GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::filesystem::path exe(buffer, buffer + (n > 0 ? n : 0));
    return exe.parent_path() / "loudness-cache.json";
}

// stat() the file once and reuse the answer for both the key and the entry.
bool statFile(const std::filesystem::path& path, long long& size, long long& mtime) {
    std::error_code ec;
    const auto s = std::filesystem::status(path, ec);
    if (ec || !std::filesystem::exists(s)) return false;
    const auto sz = std::filesystem::file_size(path, ec);
    if (ec) return false;
    const auto t = std::filesystem::last_write_time(path, ec);
    if (ec) return false;
    size = static_cast<long long>(sz);
    mtime = static_cast<long long>(t.time_since_epoch().count());
    return true;
}

} // namespace

void LoudnessScan::loadCache() {
    if (cacheLoaded_) return;
    cacheLoaded_ = true;

    const std::filesystem::path file = cachePath();
    std::ifstream in(file, std::ios::binary);
    if (!in) return;                     // no cache yet: measure everything

    std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    auto parsed = Json::parse(text);
    if (!parsed || !parsed->isObject()) return;   // corrupt: discard, do not fail
    if (parsed->find("version") == nullptr || parsed->find("version")->asInt(0) != kCacheVersion) return;

    const Json* entries = parsed->find("files");
    if (!entries || !entries->isObject()) return;
    // Object is an insertion-ordered vector of members, not a map, so this
    // iterates the pairs directly. Insertion order is also why the cache file
    // stays readable and diff-stable between runs.
    for (const auto& entry : entries->obj()) {
        const std::string& key = entry.first;
        const Json& e = entry.second;
        if (!e.isObject()) continue;
        CacheEntry c;
        c.size        = e.find("size")          ? e.find("size")->asInt(0) : 0;
        c.mtime       = e.find("mtime")         ? e.find("mtime")->asInt(0) : 0;
        c.lufs        = e.find("lufs")          ? e.find("lufs")->asDouble(0.0) : 0.0;
        c.truePeakDb  = e.find("truePeakDb")    ? e.find("truePeakDb")->asDouble(0.0) : 0.0;
        c.samplePeakDb= e.find("samplePeakDb")  ? e.find("samplePeakDb")->asDouble(0.0) : 0.0;
        c.frames      = e.find("frames")        ? e.find("frames")->asInt(0) : 0;
        c.rate        = static_cast<int>(e.find("rate") ? e.find("rate")->asInt(0) : 0);
        c.channels    = static_cast<int>(e.find("channels") ? e.find("channels")->asInt(1) : 1);
        cache_[key] = c;
    }
}

int LoudnessScan::cacheHits() const { return cacheHits_; }
int LoudnessScan::cacheSize() const { return static_cast<int>(cache_.size()); }

std::string LoudnessScan::cacheMissReason() const { return lastMiss_; }

int LoudnessScan::cacheKeyCount() const {
    // The number of DISTINCT paths in the cache, which is what a caller means
    // by 'how much is cached' -- cache_.size() already gives that, but keeping
    // the concept named avoids it being confused with the hit count later.
    return static_cast<int>(cache_.size());
}

std::string LoudnessScan::cacheFilePath() { return toUtf8(cachePath()); }


struct LoudnessScan::Impl {
    // One state per track, kept alive: album loudness is a gated combination of
    // the parts, so the parts must still exist when the album figure is asked for.
    // A track served from the cache contributes NO state -- there is nothing to
    // keep alive because it was never decoded. That is what allCached tracks.
    std::vector<EburState> states;
    std::vector<int> rates;
    std::vector<int> channels;
    std::vector<int64_t> frameCounts;
    std::vector<std::string> keys;
    bool allCached = true;
    double seconds = 0.0;
};

// These need the complete Impl, so they live below it rather than with the
// other small accessors above.


// Opens the next queued file and prepares to measure it in chunks.
bool LoudnessScan::openNextScanFile() {
    if (scanIndex_ >= scanFiles_.size()) return false;

    const std::filesystem::path& path = scanFiles_[scanIndex_];
    scanKey_ = toUtf8(path);
    scanFileStatOk_ = statFile(path, scanFileSize_, scanFileMtime_);
    scanSource_.reset();
    scanState_.reset();
    scanFramesRead_ = 0;

    // The cache is consulted per file, exactly as the synchronous path does, so a
    // warm library finishes almost immediately even when scanned incrementally.
    if (scanMaxSeconds_ <= 0.0 && scanFileStatOk_ && !scanForceDecode_) {
        const auto it = cache_.find(scanKey_);
        if (it != cache_.end() && it->second.size == scanFileSize_ &&
            it->second.mtime == scanFileMtime_ && it->second.rate > 0) {
            LoudnessResult cachedResult;
            cachedResult.ok             = true;
            cachedResult.integratedLufs = it->second.lufs;
            cachedResult.truePeakDb     = it->second.truePeakDb;
            cachedResult.samplePeakDb   = it->second.samplePeakDb;
            cachedResult.framesSeen     = it->second.frames;
            cachedResult.sampleRate     = it->second.rate;
            cachedResult.channels       = it->second.channels;
            ++cacheHits_;
            tracks_.push_back(cachedResult);
            impl_->keys.push_back(scanKey_);
            impl_->rates.push_back(cachedResult.sampleRate);
            impl_->channels.push_back(cachedResult.channels);
            impl_->frameCounts.push_back(cachedResult.framesSeen);
            impl_->seconds += static_cast<double>(cachedResult.framesSeen) / cachedResult.sampleRate;
            ++scanIndex_;
            return true;   // consumed without decoding
        }
    }

    std::string error;
    scanSource_ = openAudioSource(path, error);
    if (!scanSource_) {
        recordScanFailure();
        return true;
    }

    scanChannels_ = scanSource_->channels();
    scanRate_     = scanSource_->sampleRate();
    auto holder = std::make_unique<EburStateHolder>();
    holder->state = ebur128_init(static_cast<unsigned>(scanChannels_),
                                 static_cast<unsigned long>(scanRate_), kMode);
    if (!holder->state) {
        recordScanFailure();
        return true;
    }
    scanState_ = std::move(holder);
    scanFileOpen_ = true;

    // Sized for THIS file's channel count and reused across every slice.
    constexpr int64_t kChunk = 4096;
    scanPlanes_.assign(static_cast<size_t>(scanChannels_),
                       std::vector<float>(static_cast<size_t>(kChunk)));
    scanViews_.assign(static_cast<size_t>(scanChannels_), nullptr);
    for (int ch = 0; ch < scanChannels_; ++ch) {
        scanViews_[static_cast<size_t>(ch)] = scanPlanes_[static_cast<size_t>(ch)].data();
    }
    scanInterleaved_.assign(static_cast<size_t>(kChunk) * scanChannels_, 0.0f);
    scanFrameLimit_ = scanMaxSeconds_ > 0.0
        ? static_cast<int64_t>(scanMaxSeconds_ * scanRate_)
        : std::numeric_limits<int64_t>::max();
    return true;
}

// One unreadable or unmeasurable file must not lose the rest of the library.
void LoudnessScan::recordScanFailure() {
    LoudnessResult failed;
    failed.ok = false;
    tracks_.push_back(failed);
    impl_->keys.push_back(scanKey_);
    scanSource_.reset();
    scanState_.reset();
    scanFileOpen_ = false;
    ++scanIndex_;
}

void LoudnessScan::abortCurrentFile() {
    // Drops work in progress without recording a result: the caller is
    // restarting or abandoning the scan.
    scanSource_.reset();
    scanState_.reset();
    scanFramesRead_ = 0;
    scanFileOpen_ = false;
}

// Advances the scan by bounded work: at most maxChunks chunks of audio, and
// only between chunks is the time bound consulted. Because a chunk is 4096
// frames (~93 ms of audio at 44.1 kHz), the loop regains control every few
// milliseconds instead of every file.
bool LoudnessScan::stepScan(size_t maxChunks, double maxMs) {
    const auto started = std::chrono::steady_clock::now();
    size_t chunks = 0;

    // 4096-frame chunks: the same size the synchronous path uses. Large enough
    // that per-call overhead disappears, small enough to bound the slice.
    constexpr int64_t kChunk = 4096;

    while (chunks < maxChunks) {
        // Start a file only when one is not ALREADY OPEN, tracked explicitly.
        //
        // Deriving this from "the vectors are empty" was a real bug: the buffers
        // are local to this call and are shrunk to nothing when it returns, so
        // every subsequent slice believed no file was open, called
        // openNextScanFile again, and reopened a decoder from scratch while the
        // previous one's state was still live. That double-open access-violated
        // inside the decoder on the very first slice of the first file.
        if (!scanFileOpen_) {
            if (scanIndex_ >= scanFiles_.size()) break;
            if (!openNextScanFile()) break;
            if (!scanFileOpen_) continue;   // served from cache or it failed
            // Allocated once per file, in openNextScanFile(). Reusing them for
            // every slice is what lets a file be measured across many calls.
        }

        if (scanViews_.empty() || scanPlanes_.empty()) {
            // A file is open but has no buffers: that is a broken invariant, and
            // reopening is the only safe recovery.
            abortCurrentFile();
            continue;
        }

        const int64_t want = std::min<int64_t>(kChunk, scanFrameLimit_ - scanFramesRead_);
        if (want <= 0) {
            // The caller's maxSeconds bound ran out: finish this file.
            finishCurrentScanFile();
            continue;
        }

        const uint64_t got = scanSource_->readFrames(scanViews_.data(), static_cast<uint64_t>(want));
        if (got == 0) {
            finishCurrentScanFile();
            continue;
        }

        const int64_t n = static_cast<int64_t>(got);
        interleave(scanViews_.data(), scanChannels_, n, 0, scanInterleaved_);
        if (ebur128_add_frames_float(scanState_->state, scanInterleaved_.data(),
                                     static_cast<size_t>(n)) != EBUR128_SUCCESS) {
            recordScanFailure();
            continue;
        }
        scanFramesRead_ += n;
        ++chunks;
        ++scanChunks_;

        if (maxMs > 0.0) {
            const double elapsed = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - started).count();
            if (elapsed >= maxMs) break;
        }
    }

    return scanPending() || scanState_ != nullptr;
}

// Reads the finished measurement out of the state and starts the next file.
void LoudnessScan::finishCurrentScanFile() {
    if (!scanState_ || !scanSource_) { abortCurrentFile(); ++scanIndex_; return; }

    LoudnessResult result;
    std::string error;
    readResult(scanState_->state, scanChannels_, scanRate_, scanFramesRead_, result, error);
    tracks_.push_back(result);
    impl_->keys.push_back(scanKey_);
    impl_->rates.push_back(scanRate_);
    impl_->channels.push_back(scanChannels_);
    impl_->frameCounts.push_back(scanFramesRead_);
    impl_->seconds += static_cast<double>(scanFramesRead_) / scanRate_;

    // Only a COMPLETE measurement is cacheable: a bounded scan is a different
    // number and storing it would poison every later full scan.
    if (scanMaxSeconds_ <= 0.0 && scanFileStatOk_) {
        CacheEntry entry;
        entry.size         = scanFileSize_;
        entry.mtime        = scanFileMtime_;
        entry.lufs         = result.integratedLufs;
        entry.truePeakDb   = result.truePeakDb;
        entry.samplePeakDb = result.samplePeakDb;
        entry.frames       = scanFramesRead_;
        entry.rate         = scanRate_;
        entry.channels     = scanChannels_;
        cache_[scanKey_] = entry;
    }

    scanSource_.reset();
    scanState_.reset();
    scanFramesRead_ = 0;
    scanFileOpen_ = false;
    scanPlanes_.clear();
    scanViews_.clear();
    scanInterleaved_.clear();
    ++scanIndex_;
}



bool LoudnessScan::allFromCache() const { return impl_->allCached && !impl_->keys.empty(); }

bool LoudnessScan::cachedAlbum(const std::vector<std::string>& keys, LoudnessResult& out) const {
    for (const auto& set : cachedSets_) {
        if (set.tracks != keys) continue;
        out = set.album;
        return true;
    }
    return false;
}

void LoudnessScan::rememberAlbum(const std::vector<std::string>& keys,
                                 const LoudnessResult& album) {
    for (auto& set : cachedSets_) {
        if (set.tracks == keys) { set.album = album; return; }
    }
    cachedSets_.push_back(CachedSet{keys, album});
}

LoudnessScan::LoudnessScan() : impl_(std::make_unique<Impl>()) {}
LoudnessScan::~LoudnessScan() = default;

void LoudnessScan::clear() {
    impl_->states.clear();
    impl_->rates.clear();
    impl_->channels.clear();
    impl_->frameCounts.clear();
    impl_->seconds = 0.0;
    tracks_.clear();
}

double LoudnessScan::analysedSeconds() const { return impl_->seconds; }

bool LoudnessScan::saveCache(std::string& error) const {
    Json files = Json::object();
    for (const auto& entry : cache_) {
        Json e = Json::object();
        e.set("size", entry.second.size);
        e.set("mtime", entry.second.mtime);
        e.set("lufs", entry.second.lufs);
        e.set("truePeakDb", entry.second.truePeakDb);
        e.set("samplePeakDb", entry.second.samplePeakDb);
        e.set("frames", entry.second.frames);
        e.set("rate", entry.second.rate);
        e.set("channels", entry.second.channels);
        files.set(entry.first, std::move(e));
    }

    Json root = Json::object();
    root.set("version", kCacheVersion);
    root.set("files", std::move(files));

    const std::filesystem::path target = cachePath();
    // Temp file then rename, per SPEC 8. A crash part-way through a direct
    // write would leave a truncated file, and the next run would have to treat
    // its own cache as corrupt; rename is atomic on the same volume, so the
    // cache is either the old one or the new one and never something in between.
    const std::filesystem::path temp = target.wstring() + L".tmp";

    {
        std::ofstream out(temp, std::ios::binary | std::ios::trunc);
        if (!out) { error = "cannot write the loudness cache"; return false; }
        const std::string text = root.dump();
        out.write(text.data(), static_cast<std::streamsize>(text.size()));
        if (!out) { error = "the loudness cache could not be written in full"; return false; }
    }

    std::error_code ec;
    std::filesystem::rename(temp, target, ec);
    if (ec) {
        // Windows rename does not replace an existing file. Removing first
        // opens a tiny window where neither exists, which is survivable because
        // a missing cache is the same as a cold one.
        std::filesystem::remove(target, ec);
        std::filesystem::rename(temp, target, ec);
        if (ec) {
            std::filesystem::remove(temp, ec);
            error = "cannot replace the loudness cache";
            return false;
        }
    }
    return true;
}

bool LoudnessScan::addFile(const std::filesystem::path& path, double maxSeconds, std::string& error,
                           bool forceDecode) {
    loadCache();

    const std::string key = toUtf8(path);
    long long size = 0, mtime = 0;
    const bool statOk = statFile(path, size, mtime);
    // Recorded because a failed stat skips the lookup entirely, which is
    // otherwise indistinguishable from a cache that is simply not hitting.
    if (!statOk) lastMiss_ = "stat failed (" + key + ")";

    // A cached result is only usable when the file is provably the same one that
    // was measured. A hit here skips the decode entirely, which is the whole
    // point: 91 tracks is about two minutes of solid CPU work.
    //
    // maxSeconds disqualifies the cache rather than being ignored: a bounded
    // measurement is a DIFFERENT measurement, and serving a full-track figure
    // for a 10-second scan would be a wrong number that looks right.
    if (maxSeconds <= 0.0 && statOk && !forceDecode) {
        const auto it = cache_.find(key);
        if (it == cache_.end()) {
            lastMiss_ = "no entry for this path";
        } else if (it->second.size != size) {
            lastMiss_ = "size " + std::to_string(it->second.size) + " != " + std::to_string(size);
        } else if (it->second.mtime != mtime) {
            lastMiss_ = "mtime " + std::to_string(it->second.mtime) + " != " + std::to_string(mtime);
        } else if (it->second.rate <= 0 || it->second.channels <= 0) {
            lastMiss_ = "entry has no format";
        } else {
            lastMiss_.clear();
        }
        if (it != cache_.end() && lastMiss_.empty() &&
            it->second.size == size && it->second.mtime == mtime &&
            it->second.rate > 0 && it->second.channels > 0) {
            LoudnessResult cachedResult;
            cachedResult.ok             = true;
            cachedResult.integratedLufs = it->second.lufs;
            cachedResult.truePeakDb     = it->second.truePeakDb;
            cachedResult.samplePeakDb   = it->second.samplePeakDb;
            cachedResult.framesSeen     = it->second.frames;
            cachedResult.sampleRate     = it->second.rate;
            cachedResult.channels       = it->second.channels;
            ++cacheHits_;

            // The album figure needs a state per track, and a cache hit has none.
            // Re-decoding merely to combine would defeat the cache, so the
            // cached numbers are kept alongside and the album path uses them
            // (see album()).
            tracks_.push_back(cachedResult);
            impl_->keys.push_back(key);
            impl_->allCached = impl_->allCached && true;
            impl_->rates.push_back(cachedResult.sampleRate);
            impl_->channels.push_back(cachedResult.channels);
            impl_->frameCounts.push_back(cachedResult.framesSeen);
            impl_->seconds += static_cast<double>(cachedResult.framesSeen) / cachedResult.sampleRate;
            return true;
        }
    }

    std::unique_ptr<AudioSource> source = openAudioSource(path, error);
    if (!source) return false;

    const int channels = source->channels();
    const int rate     = source->sampleRate();
    if (channels <= 0 || rate <= 0) {
        error = "the decoder reported an unusable format";
        return false;
    }

    EburState st(ebur128_init(static_cast<unsigned>(channels),
                              static_cast<unsigned long>(rate), kMode));
    if (!st) {
        error = "cannot create a loudness state";
        return false;
    }

    // 4096-frame chunks: large enough that the per-call overhead disappears,
    // small enough that the working set stays in cache and memory use is
    // independent of track length (the same reason playback streams).
    constexpr int64_t kChunk = 4096;
    std::vector<std::vector<float>> planes(static_cast<size_t>(channels),
                                           std::vector<float>(static_cast<size_t>(kChunk)));
    std::vector<float*> views(static_cast<size_t>(channels));
    for (int ch = 0; ch < channels; ++ch) views[static_cast<size_t>(ch)] = planes[static_cast<size_t>(ch)].data();
    std::vector<float> interleaved(static_cast<size_t>(kChunk) * channels);

    const int64_t limit = (maxSeconds > 0.0)
        ? static_cast<int64_t>(maxSeconds * rate)
        : std::numeric_limits<int64_t>::max();

    int64_t total = 0;
    for (;;) {
        const int64_t want = std::min<int64_t>(kChunk, limit - total);
        if (want <= 0) break;
        const uint64_t got = source->readFrames(views.data(), static_cast<uint64_t>(want));
        if (got == 0) break;
        const int64_t n = static_cast<int64_t>(got);
        interleave(views.data(), channels, n, 0, interleaved);
        if (ebur128_add_frames_float(st.get(), interleaved.data(),
                                     static_cast<size_t>(n)) != EBUR128_SUCCESS) {
            error = "cannot add frames to the loudness measurement";
            return false;
        }
        total += n;
    }

    LoudnessResult result;
    if (!readResult(st.get(), channels, rate, total, result, error)) return false;
    tracks_.push_back(result);
    impl_->keys.push_back(key);
    impl_->allCached = false;   // this track was decoded, so the set is not all-cached

    // Remember it, but only a complete measurement: a bounded scan is a
    // different figure and storing it would poison every later full scan.
    if (maxSeconds <= 0.0 && statOk) {
        CacheEntry entry;
        entry.size         = size;
        entry.mtime        = mtime;
        entry.lufs         = result.integratedLufs;
        entry.truePeakDb   = result.truePeakDb;
        entry.samplePeakDb = result.samplePeakDb;
        entry.frames       = total;
        entry.rate         = rate;
        entry.channels     = channels;
        cache_[key] = entry;
    }

    impl_->states.push_back(std::move(st));
    impl_->rates.push_back(rate);
    impl_->channels.push_back(channels);
    impl_->frameCounts.push_back(total);
    impl_->seconds += static_cast<double>(total) / rate;
    return true;
}

bool LoudnessScan::album(LoudnessResult& out, std::string& error) const {
    if (impl_->keys.empty()) {
        error = "nothing has been analysed";
        return false;
    }

    // Album loudness is a gated combination of the PARTS, so it needs a decoder
    // state per track. A track served from the cache has none.
    //
    // Two ways out, and the wrong one is obvious: averaging the cached per-track
    // numbers would look reasonable and give a different, wrong album figure
    // (measured on this library: -7.53 gated vs -8.46 averaged). So:
    //   * all tracks cached and this exact set is cached -> serve it, no work;
    //   * otherwise refuse, and let the caller re-run with forceDecode.
    // Refusing is deliberate. A caller that gets a plausible wrong album gain
    // would never know to ask again.
    if (allFromCache()) {
        if (cachedAlbum(impl_->keys, out)) return true;
        error = "the album figure needs a decoder state per track "
                "and every track came from the cache";
        return false;
    }
    if (impl_->states.size() != impl_->keys.size()) {
        // A mixed scan: some decoded, some cached. The cached ones have no
        // state, so the combination would be over a subset and silently wrong.
        error = "the album figure needs a decoder state per track "
                "and part of this set came from the cache";
        return false;
    }
    // A single track: the album figure IS the track figure, and asking
    // libebur128 for a one-element combination gives the same answer by a
    // longer route.
    const int count = static_cast<int>(impl_->states.size());
    std::vector<ebur128_state*> states(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i) states[static_cast<size_t>(i)] = impl_->states[static_cast<size_t>(i)].get();

    double loudness = 0.0;
    const int rc = ebur128_loudness_global_multiple(states.data(),
                                                    static_cast<size_t>(count), &loudness);
    if (rc != EBUR128_SUCCESS || !std::isfinite(loudness)) {
        // Silent or too short to gate: report it as unavailable rather than as a
        // number the caller would then apply as a gain.
        error = "the album is too short or too quiet to gate";
        out = LoudnessResult{};
        return false;
    }

    double truePeak = 0.0, samplePeak = 0.0;
    int64_t frames = 0;
    for (int i = 0; i < count; ++i) {
        for (int ch = 0; ch < impl_->channels[static_cast<size_t>(i)]; ++ch) {
            double tp = 0.0, sp = 0.0;
            if (ebur128_true_peak(states[static_cast<size_t>(i)], static_cast<unsigned>(ch), &tp) == EBUR128_SUCCESS) {
                truePeak = std::max(truePeak, tp);
            }
            if (ebur128_sample_peak(states[static_cast<size_t>(i)], static_cast<unsigned>(ch), &sp) == EBUR128_SUCCESS) {
                samplePeak = std::max(samplePeak, sp);
            }
        }
        frames += impl_->frameCounts[static_cast<size_t>(i)];
    }

    out.ok             = true;
    out.integratedLufs = loudness;
    out.truePeakDb     = linearToDb(truePeak);
    out.samplePeakDb   = linearToDb(samplePeak);
    out.framesSeen     = frames;
    out.sampleRate     = impl_->rates.front();
    out.channels       = impl_->channels.front();
    return true;
}

// Called by the owner of the scan once album() has succeeded, so the next
// identical set is served without decoding. Kept out of album() because that
// method is const and a cache write hidden inside a query is a surprise.
void LoudnessScan::cacheAlbumResult(const LoudnessResult& album) {
    if (impl_->keys.empty() || allFromCache()) return;
    rememberAlbum(impl_->keys, album);
}

} // namespace te
