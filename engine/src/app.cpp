#include "analysis.hpp"

#include "diag_log.hpp"
#include "app.hpp"
#include "device_monitor.hpp"

#include <string>
#include <cmath>

#include "mf_source.hpp"
#include "protocol.hpp"
#include "util.hpp"
#include "win_util.hpp"

namespace te {

namespace {

// One device as the protocol reports it. Extra fields beyond the contract are
// allowed (CONTRACT 3.3 writes "..." there on purpose): the app ignores what it
// does not know, and the UI needs this to show the landing point the hardware
// actually reached rather than an assumed one (SPEC 3.3).
Json deviceToJson(const DeviceInfo& d) {
    Json j = Json::object();
    j.set("id",          d.id);
    j.set("name",        d.name);
    j.set("isDefault",   d.isDefault);
    j.set("isBluetooth", d.isBluetooth);
    j.set("channels",    d.channels);
    j.set("sampleRate",  d.sampleRate);
    // SPEC 3.3: the device's real capability, so the UI can warn that a track
    // will not be bit-perfect BEFORE the user wonders why the badge is missing.
    j.set("hasExclusive", !d.exclusiveFormats.empty());
    Json formats = Json::array();
    for (const auto& f : d.exclusiveFormats) formats.push(Json(f));
    j.set("exclusiveFormats", std::move(formats));
    return j;
}

// CONTRACT 3.2: seek takes positionMs; volume is a 0.0-1.0 float. Both are
// validated here so a bad value produces a contract error instead of a
// silently clamped surprise.
bool readNumberField(const Json& cmd, const char* key, double& out) {
    const Json* value = cmd.find(key);
    if (!value || !value->isNumber()) return false;
    out = value->asDouble();
    return true;
}

} // namespace

App::App(Io& io) : io_(io), player_(*this) {}

const char* App::renderStageDescription() const {
#if TE_RT_TRACE
    return player_.renderStageDescription();
#else
    return "render stage tracing is off (build with -DTE_RT_TRACE=ON)";
#endif
}

App::~App() {
    player_.stop();
}

long long App::monotonicMs() const {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

long long App::commandId(const Json& cmd) const {
    const Json* id = cmd.find("id");
    return id ? id->asInt(-1) : -1;
}

void App::replyOk(const Json& cmd, Json data) {
    Json reply = Json::object();
    reply.set("id", commandId(cmd));
    reply.set("ok", true);
    reply.set("data", std::move(data));
    io_.emit(reply);
}

void App::replyError(const Json& cmd, const char* code, const std::string& message,
                     const char* kind) {
    Json error = Json::object();
    error.set("code", code);
    error.set("message", message);
    // Only present when the caller supplied one. DESIGN-A 6 needs ERR_UNSUPPORTED
    // to separate "the engine has not built this" from "this machine cannot do
    // it", because the two tell the user to do opposite things: wait, or switch
    // device. The message alone would leave the UI parsing English.
    if (kind != nullptr) error.set("kind", kind);

    Json reply = Json::object();
    reply.set("id", commandId(cmd));
    reply.set("ok", false);
    reply.set("error", std::move(error));
    io_.emit(reply);
}

void App::emitReady() {
    if (readySent_) return;
    readySent_ = true;

    // CONTRACT 3.3: the first line on stdout after startup. Devices are probed
    // before this point so the app never has to ask twice on the happy path.
    Json list = Json::array();
    for (const auto& d : devices_) list.push(deviceToJson(d));

    Json ready = Json::object();
    ready.set("ev", "ready");
    ready.set("protocol", kProtocolVersion);
    ready.set("version", kEngineVersion);
    ready.set("devices", std::move(list));
    io_.emit(ready);
    // First record in the diagnostic file, so a report always has a beginning:
    // the running version and the moment the engine came up.
    diagRecord("engine", std::string("start version=") + kEngineVersion);
}

void App::cmdHello(const Json& cmd) {
    Json data = Json::object();
    data.set("protocol", kProtocolVersion);
    data.set("version", kEngineVersion);
    // CONTRACT 3.2: the app sends its protocol version on hello, and an engine
    // that cannot speak it must say so rather than silently misbehave.
    const Json* p = cmd.find("protocol");
    const bool compatible = !p || p->asInt(kProtocolVersion) == kProtocolVersion;
    data.set("accepted", compatible);
    data.set("capabilities", [] {
        // Honest self-description, in both directions: claiming a capability that
        // does not work is a lie, and UNDER-reporting one that does work hides a
        // feature from the UI entirely -- DESIGN-A 5 states the interface only
        // draws what the engine declares, so dsp:false kept the DSP segment off
        // the signal path even after EQ and ReplayGain landed.
        Json caps = Json::object();
        caps.set("exclusive", true);
        caps.set("shared", true);
        caps.set("resampler", true);
        caps.set("bitPerfect", true);
        // EQ and ReplayGain are implemented (see dsp.hpp). Dither and the
        // libebur128 scanner are not, and dspActive/dspModules report what is
        // actually in force per track, so a capability here is never mistaken
        // for a state.
        caps.set("dsp", true);
        caps.set("queue", true);
        caps.set("seek", true);
        caps.set("meter", true);
        return caps;
    }());
    replyOk(cmd, std::move(data));
}

void App::cmdListDevices(const Json& cmd) {
    devices_ = enumerateRenderDevices();
    Json list = Json::array();
    for (const auto& d : devices_) list.push(deviceToJson(d));

    Json data = Json::object();
    data.set("devices", std::move(list));
    data.set("defaultDeviceId", defaultRenderDeviceId());
    replyOk(cmd, std::move(data));
}

void App::cmdListTracks(const Json& cmd) {
    Json tracks = Json::array();
    for (const auto& t : catalog_.tracks()) tracks.push(trackToJson(t));

    Json data = Json::object();
    data.set("tracks", std::move(tracks));
    replyOk(cmd, std::move(data));
}

void App::cmdScan(const Json& cmd) {
    const Json* pathValue = cmd.find("path");
    if (!pathValue || !pathValue->isString() || pathValue->asString().empty()) {
        replyError(cmd, err::kNotFound, "scan requires a non-empty path");
        return;
    }
    const std::string pathUtf8 = pathValue->asString();
    const std::filesystem::path dir = fromUtf8(pathUtf8);

    // CR-013 ruling 2. Absent means false, so every existing caller behaves
    // exactly as before -- the ruling required that, it was not a nicety.
    bool replace = false;
    if (const Json* replaceValue = cmd.find("replace")) {
        if (!replaceValue->isBool()) {
            replyError(cmd, err::kState, "scan replace must be a boolean");
            return;
        }
        replace = replaceValue->asBool();
    }

    // CR-017: both flags default to false, so a caller that sends neither gets
    // byte-for-byte the previous behaviour -- the CR-013 ruling stays intact.
    const auto readBoolFlag = [&](const char* name, bool& out) -> bool {
        const Json* value = cmd.find(name);
        if (!value) return true;
        if (!value->isBool()) {
            replyError(cmd, err::kState, std::string("scan ") + name + " must be a boolean");
            return false;
        }
        out = value->asBool();
        return true;
    };
    bool recursive = false, probe = false;
    if (!readBoolFlag("recursive", recursive) || !readBoolFlag("probe", probe)) return;

    std::error_code ec;
    const bool present = std::filesystem::is_directory(dir, ec) && !ec;
    if (!present && !replace) {
        replyError(cmd, err::kNotFound, "not a directory: " + pathUtf8);
        return;
    }

    // A directory the user removes is often a directory whose DRIVE is gone --
    // that is frequently WHY it was removed. So when replace is asked for, the
    // cleanup IS the job, and answering ERR_NOTFOUND would make the one useful
    // case impossible. The scan below simply finds nothing to read.
    io_.log("info", present ? "scan start: " + pathUtf8
                            : "scan replace: directory is gone, cleaning up only: " + pathUtf8);

    Catalog::ScanResult result = catalog_.scanDirectory(dir, [&](int done, int total) {
        Json progress = Json::object();
        progress.set("ev", "scan_progress");
        progress.set("done", done);
        progress.set("total", total);
        io_.emit(progress);

        // Keep the control loop responsive: a scan is the one long operation
        // that happens while the app may still be sending commands. Whatever
        // arrives mid-scan is DEFERRED, never discarded -- an earlier version
        // read these lines and threw them away, which silently swallowed both
        // the command and its reply whenever the app asked for state during a
        // scan. Commands are handled in the order they arrived, which is what
        // the app observes on the wire.
        std::string pending;
        while (io_.pollLine(pending, 0)) {
            if (pending.empty()) continue;
            pendingCommands_.push_back(pending);
        }
    }, replace, recursive, probe ? &isDecodable : nullptr);

    Json tracks = Json::array();
    for (const auto& t : catalog_.tracks()) tracks.push(trackToJson(t));

    Json data = Json::object();
    data.set("tracks", std::move(tracks));
    data.set("path", pathUtf8);
    // Only additions were reported before, which made a rescan of a known
    // directory indistinguishable from a scan that failed to see the files.
    // `skipped` says why added can be 0 while `scanned` is 91 (CR-013 ruling 1);
    // `removed` says what a replace took away.
    data.set("added", result.added);
    data.set("skipped", result.skipped);
    data.set("removed", result.removed);
    // CR-017: files the DECODER refused. Separate from `failed` (tags unreadable)
    // because the remedy is different and the user-visible claim is different:
    // these are the ones that would have shown up in the list and then refused
    // to play.
    data.set("unplayable", result.unplayable);
    {
        Json paths = Json::array();
        for (const auto& p : result.unplayablePaths) paths.push(Json(p));
        data.set("unplayablePaths", std::move(paths));
    }
    replyOk(cmd, std::move(data));

    Json done = Json::object();
    done.set("ev", "scan_done");
    done.set("added", result.added);
    done.set("skipped", result.skipped);
    done.set("removed", result.removed);
    done.set("failed", result.failed);
    done.set("unplayable", result.unplayable);
    io_.emit(done);

    io_.log("info", "scan done: added=" + std::to_string(result.added) +
                        " skipped=" + std::to_string(result.skipped) +
                        " removed=" + std::to_string(result.removed) +
                        " failed=" + std::to_string(result.failed) +
                        " unplayable=" + std::to_string(result.unplayable));
}

bool App::loadQueuedTrack(bool startPlaying, std::string& error) {
    const std::string& id = player_.queuedTrackId();
    if (id.empty()) {
        error = "the queue is empty";
        return false;
    }
    const Track* track = catalog_.findById(id);
    if (!track) {
        error = "the queue points at an unknown trackId: " + id;
        return false;
    }
    if (!player_.openTrack(*track, error)) return false;
    if (startPlaying) return player_.play(error);
    return true;
}

const Track* App::requireTrack(const Json& cmd, std::string& error) {
    const Json* idValue = cmd.find("trackId");
    if (!idValue || !idValue->isString() || idValue->asString().empty()) {
        error = "trackId is required";
        return nullptr;
    }
    const Track* track = catalog_.findById(idValue->asString());
    if (!track) {
        error = "unknown trackId: " + idValue->asString();
        return nullptr;
    }
    return track;
}

void App::cmdOpen(const Json& cmd) {
    std::string error;

    // CR-016: `url` and `trackId` are mutually exclusive, and supplying neither
    // is still ERR_NOTFOUND. The URL arm is checked first so that a command
    // carrying BOTH is refused rather than silently resolved to one of them --
    // an ambiguous open is a client bug, and picking a winner would hide it.
    const Json* urlValue = cmd.find("url");
    const Json* idValue  = cmd.find("trackId");
    const bool wantsUrl = urlValue && urlValue->isString() && !urlValue->asString().empty();

    if (wantsUrl && idValue && idValue->isString() && !idValue->asString().empty()) {
        replyError(cmd, err::kState, "open takes either url or trackId, not both");
        return;
    }

    // The declared source format. For a catalog track it comes from the scanned
    // metadata; for a URL there is no catalog row, so the decoder's own
    // measurement is the only authority and the queue can never contain it.
    int declaredRate = 0, declaredDepth = 0;
    std::string trackId;
    const Track* track = nullptr;
    int queueSlot = -1;

    if (!wantsUrl) {
        track = requireTrack(cmd, error);
        if (!track) {
            replyError(cmd, err::kNotFound, error);
            return;
        }
        declaredRate  = track->meta.sampleRate;
        declaredDepth = track->meta.bitDepth;
        trackId       = track->id;

        // If the app opened a track that is in the queue, the queue follows
        // along. Without this, next/prev after a manual double-click would jump
        // somewhere unrelated to what is playing.
        // Reset FIRST, then look: a track that is not in the queue must clear
        // the index rather than inherit the previous track's position, or the
        // queue view highlights a row that has nothing to do with what is
        // playing.
        const std::vector<std::string>& queue = player_.queue();
        for (size_t i = 0; i < queue.size(); ++i) {
            if (queue[i] == track->id) { queueSlot = static_cast<int>(i); break; }
        }
    }

    if (!player_.outputAvailable()) {
        // Try to open the output now: at startup no device may have been ready.
        player_.initialise(preferredDeviceId_);
        if (!player_.outputAvailable()) {
            replyError(cmd, err::kDevice, player_.outputError());
            return;
        }
    }

    // The URL is handed to the reader as a path; audio samples never cross
    // stdio (CONTRACT 3.2 iron rule 2). Range, auth and re-signing stay the
    // loopback proxy's business, and a transport failure below is reported as a
    // decode/device error -- never as a clean end of stream.
    const bool opened = wantsUrl
        ? player_.openUrl(urlValue->asString(), error)
        : player_.openTrack(*track, error);

    if (!opened) {
        // A decode failure and a device mismatch are different failures and the
        // app reacts differently to each, so they must not share a code.
        const bool device = !player_.outputAvailable();
        replyError(cmd, device ? err::kDevice : err::kDecode, error);
        return;
    }

    player_.noteTrackIsFromQueue(queueSlot);

    // A URL open has no catalog entry, so the decoder's measured format is what
    // this session actually runs at; trackId is legitimately empty (CR-016
    // constraint 3: metadata is the app's to supply, or left blank here).
    // The URL branch has no catalog row, so the decoder's measured format is what
    // this session actually runs at. CR-032 adds a second case with the same
    // property: a DSD file's catalog metadata is the SOURCE rate (2822400 Hz,
    // 1-bit) while playback delivers decimated PCM (176400 Hz, 24-bit). Both
    // numbers are true, but this reply's field means "what this session runs at",
    // so it must be the decoder's answer.
    if (wantsUrl || player_.sourceDsdRate() > 0) {
        declaredRate  = player_.sourceSampleRate();
        declaredDepth = player_.sourceBitDepth();
    }

    Json data = Json::object();
    data.set("trackId", trackId);
    data.set("durationMs", player_.durationMs());
    data.set("sampleRate", player_.outputSampleRate());
    data.set("sourceSampleRate", declaredRate);
    data.set("bitDepth", declaredDepth);
    data.set("channels", player_.outputChannels());
    data.set("outputMode", player_.outputStatus().outputMode);
    data.set("requestedOutputRate", static_cast<long long>(player_.requestedOutputRate()));
    // True whenever the track rate differs from the stream rate and SoXR is in
    // the path. The UI shows this instead of the bit-perfect badge.
    data.set("resampled", declaredRate != 0 &&
                          declaredRate != player_.outputSampleRate());
    data.set("bitPerfect", player_.isBitPerfect());

    // Probed capability for THIS track's rate: lets the app explain, before the
    // user asks, that e.g. 44.1 kHz cannot be bit-perfect on an endpoint that
    // only accepts 48 kHz exclusive. SPEC 3.3 in spirit: report what the
    // hardware does rather than what the design intended.
    bool exclusiveCapable = false;
    for (const auto& d : devices_) {
        if (d.id == player_.outputStatus().deviceId) {
            exclusiveCapable = d.supportsExclusiveAt(declaredRate, declaredDepth);
            break;
        }
    }
    data.set("exclusiveCapable", exclusiveCapable);
    // CR-007: the id of the playback session this open started. Every event
    // carrying a different id belongs to a session the client has replaced.
    data.set("operationId", player_.operationId());
    replyOk(cmd, std::move(data));
}

void App::cmdPlay(const Json& cmd) {
    std::string error;
    // Loadedness, not identity: a URL source (CR-016) has an empty trackId and
    // is still perfectly openable/playable.
    if (!player_.hasSource()) {
        // CONTRACT 3.4: play before open is a state error, not a device error.
        replyError(cmd, err::kState, "no track is open");
        return;
    }
    if (!player_.play(error)) {
        replyError(cmd, err::kDevice, error);
        return;
    }
    replyOk(cmd, Json::object());
}

void App::cmdPause(const Json& cmd) {
    if (player_.state() != PlayState::Playing) {
        replyError(cmd, err::kState, "nothing is playing");
        return;
    }
    player_.pause();
    replyOk(cmd, Json::object());
}

void App::cmdStop(const Json& cmd) {
    player_.stop();
    replyOk(cmd, Json::object());
}

void App::cmdNext(const Json& cmd) {
    if (player_.queue().empty()) {
        replyError(cmd, err::kState, "the queue is empty; call set_queue first");
        return;
    }
    const bool wasPlaying = (player_.state() == PlayState::Playing);
    std::string error;
    if (!player_.skipNext(error, true)) {
        replyError(cmd, err::kNotFound, error);
        return;
    }
    if (!loadQueuedTrack(wasPlaying, error)) {
        replyError(cmd, err::kDecode, error);
        return;
    }
    Json data = Json::object();
    // The session this next/prev started, so its events are distinguishable
    // from the ones the previous track may still have in flight (CR-007).
    // Same change in both next and prev on purpose: they are separate commands
    // whose clients need the same guarantee.
    data.set("operationId", player_.operationId());
    data.set("trackId", player_.currentTrackId());
    replyOk(cmd, std::move(data));
}

void App::cmdPrev(const Json& cmd) {
    if (player_.queue().empty()) {
        replyError(cmd, err::kState, "the queue is empty; call set_queue first");
        return;
    }
    const bool wasPlaying = (player_.state() == PlayState::Playing);
    std::string error;
    if (!player_.skipPrevious(error, true)) {
        replyError(cmd, err::kNotFound, error);
        return;
    }
    if (!loadQueuedTrack(wasPlaying, error)) {
        replyError(cmd, err::kDecode, error);
        return;
    }
    Json data = Json::object();
    // The session this next/prev started, so its events are distinguishable
    // from the ones the previous track may still have in flight (CR-007).
    // Same change in both next and prev on purpose: they are separate commands
    // whose clients need the same guarantee.
    data.set("operationId", player_.operationId());
    data.set("trackId", player_.currentTrackId());
    replyOk(cmd, std::move(data));
}

void App::handleTrackFinished(const std::string& endedTrackId) {
    Json ended = Json::object();
    ended.set("ev", "ended");
    // Emitted before the auto-advance below, so this still names the session
    // that just finished rather than the one about to start (CR-007).
    ended.set("operationId", player_.operationId());
    ended.set("trackId", endedTrackId);
    ended.set("reason", "eof");
    io_.emit(ended);

    // Auto-advance exactly like a "next" command would, so a finished track
    // continues the queue. When there is nowhere to go the engine simply stops:
    // reporting ended and then sitting quiet is the honest behaviour.
    if (player_.queue().empty()) return;
    if (endedTrackId != player_.queuedTrackId()) return;   // a one-off open, not a queue member

    std::string error;
    // Repeat-one replays the SAME track: advanceQueue() reports success without
    // moving the index, so reloading the queued track restarts it.
    if (!player_.advanceQueue(error)) return;

    // ── SKIP WHAT CANNOT BE PLAYED (CR-017) ─────────────────────────────────
    //
    // This used to try ONCE and give up: a single unreadable entry wrote a
    // warning and left playback stopped, so a corrupt file in the middle of a
    // queue ended the listening session and every track after it never played.
    // The user had to intervene for something that is not their fault and that
    // they cannot even see.
    //
    // Now each entry that fails to load is reported and STEPPED OVER, and the
    // first one that loads wins. Two guards keep this from spinning:
    //   * at most queue.size() attempts, and
    //   * stop when the index did not move -- which is what happens for a
    //     single-entry queue and for RepeatOne, where advanceQueue() reports
    //     success without advancing and would otherwise retry forever.
    for (size_t attempts = 0; attempts < player_.queue().size(); ++attempts) {
        if (loadQueuedTrack(true, error)) return;

        const std::string failedId = player_.queuedTrackId();
        io_.log("warn", "skipping unplayable track " + failedId + ": " + error);
        // CONTRACT 3.3 allows reason=error on `ended`, and naming the track is
        // what lets the client mark THAT row as unplayable: a bare log line has
        // no trackId to key off. The log line stays for the human reading stderr.
        Json failed = Json::object();
        failed.set("ev", "ended");
        failed.set("operationId", player_.operationId());
        failed.set("trackId", failedId);
        failed.set("reason", "error");
        failed.set("message", error);
        io_.emit(failed);

        if (!player_.advanceQueue(error)) return;          // nothing left to try
        if (player_.queuedTrackId() == failedId) return;   // no progress: stop, do not retry
    }
    io_.log("warn", "every track in the queue failed to load; stopping");
}

void App::cmdSeek(const Json& cmd) {
    double positionMs = 0;
    if (!readNumberField(cmd, "positionMs", positionMs)) {
        replyError(cmd, err::kState, "seek requires a numeric positionMs");
        return;
    }
    if (!player_.hasSource()) {
        replyError(cmd, err::kState, "no track is open");
        return;
    }
    std::string error;
    if (!player_.seek(static_cast<long long>(positionMs), error)) {
        replyError(cmd, err::kDevice, error);
        return;
    }
    Json data = Json::object();
    data.set("positionMs", player_.positionMs());
    replyOk(cmd, std::move(data));
}

void App::cmdSetVolume(const Json& cmd) {
    double volume = 0;
    if (!readNumberField(cmd, "volume", volume)) {
        replyError(cmd, err::kState, "set_volume requires a numeric volume");
        return;
    }
    // CONTRACT 3.1: volume is 0.0-1.0. A value outside that range is a caller
    // bug, so it is refused rather than clamped in silence.
    if (volume < 0.0 || volume > 1.0) {
        replyError(cmd, err::kState, "volume must be within 0.0 - 1.0");
        return;
    }
    player_.setVolume(static_cast<float>(volume));
    Json data = Json::object();
    data.set("volume", volume);
    replyOk(cmd, std::move(data));
}

void App::cmdSetMuted(const Json& cmd) {
    const Json* value = cmd.find("muted");
    if (!value || !value->isBool()) {
        replyError(cmd, err::kState, "set_muted requires a boolean muted");
        return;
    }
    player_.setMuted(value->asBool());
    Json data = Json::object();
    data.set("muted", value->asBool());
    // The volume is echoed because it is UNCHANGED by muting, and a client that
    // assumed mute meant "volume := 0" would otherwise get no correction.
    data.set("volume", static_cast<double>(player_.volume()));
    replyOk(cmd, std::move(data));
}

void App::cmdSetMeter(const Json& cmd) {
    const Json* enabled = cmd.find("enabled");
    if (!enabled || !enabled->isBool()) {
        replyError(cmd, err::kState, "set_meter requires a boolean enabled");
        return;
    }
    player_.setMeterEnabled(enabled->asBool());
    Json data = Json::object();
    data.set("enabled", player_.meterEnabled());
    replyOk(cmd, std::move(data));
}

// CR-020: FIR / room correction.
//
// Loading an impulse response is the only command in this engine that reads a
// FILE the user picked, so it is deliberately explicit: nothing is loaded
// implicitly, and a refusal says which constraint failed (channels, length,
// format) instead of "invalid IR".
void App::cmdSetIr(const Json& cmd) {
    const Json* path = cmd.find("path");
    const Json* enabled = cmd.find("enabled");
    const Json* preamp = cmd.find("preampDb");

    if (!path && !enabled && !preamp) {
        replyError(cmd, err::kState,
                   "set_ir needs at least one of path | enabled | preampDb");
        return;
    }

    if (path) {
        if (!path->isString() || path->asString().empty()) {
            replyError(cmd, err::kState, "set_ir: path must be a non-empty string");
            return;
        }
        std::string error;
        if (!player_.loadIr(path->asString(), error)) {
            replyError(cmd, err::kState, "set_ir: " + error);
            return;
        }
    }
    if (enabled) {
        if (enabled->asBool() && !player_.irLoaded()) {
            // 没有加载响应时"打开"没有意义。旧行为只是把 enabled 留在 false 并回 ok，
            // 那会让 UI 显示"已开启"而实际没生效——这里如实拒绝并说明。
            replyError(cmd, err::kState, "set_ir: no impulse response is loaded");
            return;
        }
        player_.setIrEnabled(enabled->asBool());
    }
    if (preamp) {
        // CR-020 的合法范围是 -24 .. +24 dB；拒绝而不是 clamp（与其它 setter 一致）。
        if (!preamp->isNumber()) {
            replyError(cmd, err::kState, "set_ir: preampDb must be a number");
            return;
        }
        if (!player_.setIrPreamp(static_cast<float>(preamp->asDouble()))) {
            replyError(cmd, err::kState, "set_ir: preampDb must be within -24 .. +24 dB");
            return;
        }
    }

    Json data = player_.dspJson();
    replyOk(cmd, std::move(data));
}

void App::cmdSetSpatial(const Json& cmd) {
    // CR-029：只增命令。省略的字段 = 保持当前值（与 set_channels 一致）。
    const Json* modeValue = cmd.find("mode");
    const Json* amountValue = cmd.find("amount");
    const Json* azimuthValue = cmd.find("azimuth");
    const Json* delayValue = cmd.find("delayMs");
    const Json* hrirValue = cmd.find("hrir");
    if (!modeValue && !amountValue && !azimuthValue && !delayValue) {
        replyError(cmd, err::kState, "set_spatial needs at least one of mode | amount | azimuth | delayMs");
        return;
    }
    if (hrirValue) {
        // 本轮只支持内置解析 HRIR；显式拒绝未知表，而不是静默忽略。
        if (!hrirValue->isString() || hrirValue->asString() != "builtin") {
            replyError(cmd, err::kState, "set_spatial: hrir only supports \"builtin\" in this build");
            return;
        }
    }
    SpatialMode mode = player_.spatialMode();
    if (modeValue) {
        if (!modeValue->isString() || !spatialModeFromName(modeValue->asString(), mode)) {
            replyError(cmd, err::kState, "set_spatial: mode must be off | crossfeed | wide | virtual");
            return;
        }
    }
    auto readFloat = [](const Json* value, double low, double high, double& out) {
        if (!value) return true;
        if (!value->isNumber()) return false;
        const double v = value->asDouble();
        if (v < low || v > high) return false;
        out = v;
        return true;
    };
    double amount = player_.spatialAmount();
    double azimuth = player_.spatialAzimuth();
    double delayMs = player_.spatialDelayMs();
    if (!readFloat(amountValue, 0.0, 1.0, amount)) {
        replyError(cmd, err::kState, "set_spatial: amount must be within 0..1");
        return;
    }
    if (!readFloat(azimuthValue, -90.0, 90.0, azimuth)) {
        replyError(cmd, err::kState, "set_spatial: azimuth must be within -90..90");
        return;
    }
    if (!readFloat(delayValue, 0.0, 1.0, delayMs)) {
        replyError(cmd, err::kState, "set_spatial: delayMs must be within 0..1");
        return;
    }
    std::string error;
    if (!player_.setSpatial(mode, static_cast<float>(amount), static_cast<float>(azimuth),
                            static_cast<float>(delayMs), error)) {
        replyError(cmd, err::kState, "set_spatial: " + error);
        return;
    }
    replyOk(cmd, player_.spatialJson());
}

// CR-031：限幅器可控。省略的字段 = 保持当前值；四个字段全缺省时拒绝，
// 与 set_channels/set_spatial 的口径一致（"什么都没要求"不是一条命令）。
void App::cmdSetLimiter(const Json& cmd) {
    const Json* enabledValue = cmd.find("enabled");
    const Json* ceilingValue = cmd.find("ceilingDb");
    const Json* releaseValue = cmd.find("releaseMs");
    const Json* lookaheadValue = cmd.find("lookaheadMs");
    if (!enabledValue && !ceilingValue && !releaseValue && !lookaheadValue) {
        replyError(cmd, err::kState,
                   "set_limiter needs at least one of enabled | ceilingDb | releaseMs | lookaheadMs");
        return;
    }
    const DspParams& current = player_.dspParams();
    bool enabled = current.limiterEnabled;
    if (enabledValue) {
        if (!enabledValue->isBool()) {
            replyError(cmd, err::kState, "set_limiter: enabled must be a boolean");
            return;
        }
        enabled = enabledValue->asBool();
    }
    double ceilingDb = current.limiterCeilingDb;
    double releaseMs = current.limiterReleaseMs;
    double lookaheadMs = current.limiterLookaheadMs;
    auto readNumber = [&](const Json* value, double& out) -> bool {
        if (!value) return true;
        if (!value->isNumber()) return false;
        out = value->asDouble();
        return true;
    };
    if (!readNumber(ceilingValue, ceilingDb)) {
        replyError(cmd, err::kState, "set_limiter: ceilingDb must be a number");
        return;
    }
    if (!readNumber(releaseValue, releaseMs)) {
        replyError(cmd, err::kState, "set_limiter: releaseMs must be a number");
        return;
    }
    if (!readNumber(lookaheadValue, lookaheadMs)) {
        replyError(cmd, err::kState, "set_limiter: lookaheadMs must be a number");
        return;
    }
    std::string error;
    if (!player_.setLimiter(enabled, static_cast<float>(ceilingDb), static_cast<float>(releaseMs),
                            static_cast<float>(lookaheadMs), error)) {
        replyError(cmd, err::kState, "set_limiter: " + error);
        return;
    }
    replyOk(cmd, player_.dspJson());
}

void App::cmdSetChannels(const Json& cmd) {
    // Partial update: each control can be changed without echoing its siblings.
    const Json* balance = cmd.find("balance");
    const Json* mono    = cmd.find("mono");
    const Json* width   = cmd.find("stereoWidth");
    const Json* swap    = cmd.find("swapChannels");
    const Json* gains   = cmd.find("channelGains");
    const Json* midGain = cmd.find("midGainDb");
    const Json* sideGain = cmd.find("sideGainDb");
    const Json* crossfeedEnabled = cmd.find("crossfeedEnabled");
    const Json* crossfeedPreset = cmd.find("crossfeedPreset");
    const Json* crossfeedFcHz = cmd.find("crossfeedFcHz");
    const Json* crossfeedFeedDb = cmd.find("crossfeedFeedDb");
    // CR-026 只增字段。
    const Json* monoMode = cmd.find("monoMode");
    const Json* bandGains = cmd.find("bandGains");
    const Json* delayMs = cmd.find("delayMs");

    if (!balance && !mono && !width && !swap && !gains && !midGain && !sideGain &&
        !crossfeedEnabled && !crossfeedPreset && !crossfeedFcHz && !crossfeedFeedDb &&
        !monoMode && !bandGains && !delayMs) {
        replyError(cmd, err::kState,
                   "set_channels needs at least one of balance | mono | stereoWidth "
                   "| swapChannels | channelGains | midGainDb | sideGainDb | "
                   "crossfeedEnabled | crossfeedPreset | crossfeedFcHz | crossfeedFeedDb | "
                   "monoMode | bandGains | delayMs");
        return;
    }

    auto inRange = [](const Json* value, double low, double high) {
        return !value || (value->isNumber() && value->asDouble() >= low && value->asDouble() <= high);
    };
    const bool presetValid = !crossfeedPreset || (crossfeedPreset->isNumber() &&
        crossfeedPreset->asDouble() >= 0.0 && crossfeedPreset->asDouble() <= 2.0 &&
        std::floor(crossfeedPreset->asDouble()) == crossfeedPreset->asDouble());
    bool gainsValid = !gains || (gains->isArray() && gains->arr().size() <= 2);
    if (gainsValid && gains) {
        for (const Json& value : gains->arr()) {
            if (!value.isNumber() || !(value.asDouble() >= -12.0 && value.asDouble() <= 12.0)) {
                gainsValid = false;
                break;
            }
        }
    }
    if (!inRange(balance, -1.0, 1.0) || (mono && !mono->isBool()) ||
        !inRange(width, 0.0, 2.0) || (swap && !swap->isBool()) || !gainsValid ||
        !inRange(midGain, -12.0, 12.0) || !inRange(sideGain, -12.0, 12.0) ||
        (crossfeedEnabled && !crossfeedEnabled->isBool()) || !presetValid ||
        !inRange(crossfeedFcHz, 100.0, 4000.0) || !inRange(crossfeedFeedDb, 0.0, 12.0)) {
        replyError(cmd, err::kState, "set_channels: invalid parameter type or range");
        return;
    }

    std::string error;
    if (midGain && !player_.setMidGain(static_cast<float>(midGain->asDouble()), error)) {
        replyError(cmd, err::kState, "set_channels: " + error);
        return;
    }
    if (sideGain && !player_.setSideGain(static_cast<float>(sideGain->asDouble()), error)) {
        replyError(cmd, err::kState, "set_channels: " + error);
        return;
    }
    if (crossfeedPreset && !player_.setCrossfeedPreset(
            static_cast<int>(crossfeedPreset->asInt()), error)) {
        replyError(cmd, err::kState, "set_channels: " + error);
        return;
    }
    if (crossfeedFcHz && !player_.setCrossfeedFcHz(
            static_cast<float>(crossfeedFcHz->asDouble()), error)) {
        replyError(cmd, err::kState, "set_channels: " + error);
        return;
    }
    if (crossfeedFeedDb && !player_.setCrossfeedFeedDb(
            static_cast<float>(crossfeedFeedDb->asDouble()), error)) {
        replyError(cmd, err::kState, "set_channels: " + error);
        return;
    }
    if (crossfeedEnabled) player_.setCrossfeedEnabled(crossfeedEnabled->asBool());

    if (balance) {
        if (!player_.setBalance(static_cast<float>(balance->asDouble()), error)) {
            replyError(cmd, err::kState, "set_channels: " + error);
            return;
        }
    }
    if (mono) player_.setMono(mono->asBool());
    if (swap) player_.setSwapChannels(swap->asBool());
    if (width) {
        if (!player_.setStereoWidth(static_cast<float>(width->asDouble()), error)) {
            replyError(cmd, err::kState, "set_channels: " + error);
            return;
        }
    }
    if (gains) {
        const auto& arr = gains->arr();
        for (std::size_t i = 0; i < arr.size(); ++i) {
            if (!player_.setChannelGain(static_cast<int>(i),
                                        static_cast<float>(arr[i].asDouble()), error)) {
                replyError(cmd, err::kState, "set_channels: " + error);
                return;
            }
        }
    }

    // ---- CR-026: monoMode / bandGains / delayMs ---------------------------
    if (monoMode) {
        if (!monoMode->isString()) {
            replyError(cmd, err::kState, "monoMode must be off | sum | left | right");
            return;
        }
        const std::string value = monoMode->asString();
        int mode = 0;
        if      (value == "off")   mode = 0;
        else if (value == "sum")   mode = 1;
        else if (value == "left")  mode = 2;
        else if (value == "right") mode = 3;
        else {
            replyError(cmd, err::kState, "monoMode must be off | sum | left | right");
            return;
        }
        if (!player_.setMonoMode(mode, error)) {
            replyError(cmd, err::kState, "set_channels: " + error);
            return;
        }
    }
    if (bandGains) {
        // {"low":[L,R],"mid":[L,R],"high":[L,R]}；缺省的键 = 保持当前值。
        if (!bandGains->isObject()) {
            replyError(cmd, err::kState, "bandGains must be an object with low/mid/high pairs");
            return;
        }
        const char* bandNames[3] = {"low", "mid", "high"};
        for (int band = 0; band < 3; ++band) {
            const Json* pair = bandGains->find(bandNames[band]);
            if (!pair) continue;
            if (!pair->isArray() || pair->arr().size() != 2 ||
                !pair->arr()[0].isNumber() || !pair->arr()[1].isNumber()) {
                replyError(cmd, err::kState,
                           "bandGains." + std::string(bandNames[band]) + " must be [leftDb, rightDb]");
                return;
            }
            for (int ch = 0; ch < 2; ++ch) {
                if (!player_.setBandGain(band, ch,
                                         static_cast<float>(pair->arr()[static_cast<std::size_t>(ch)].asDouble()),
                                         error)) {
                    replyError(cmd, err::kState, "set_channels: " + error);
                    return;
                }
            }
        }
    }
    if (delayMs) {
        if (!delayMs->isArray() || delayMs->arr().size() > 2) {
            replyError(cmd, err::kState, "delayMs must be an array of at most [leftMs, rightMs]");
            return;
        }
        const auto& arr = delayMs->arr();
        for (std::size_t i = 0; i < arr.size(); ++i) {
            if (!arr[i].isNumber()) {
                replyError(cmd, err::kState, "delayMs entries must be numbers");
                return;
            }
            if (!player_.setChannelDelay(static_cast<int>(i),
                                         static_cast<float>(arr[i].asDouble()), error)) {
                replyError(cmd, err::kState, "set_channels: " + error);
                return;
            }
        }
    }

    Json data = player_.dspJson();
    replyOk(cmd, std::move(data));
}

void App::cmdSetQueue(const Json& cmd) {
    const Json* ids = cmd.find("trackIds");
    if (!ids || !ids->isArray()) {
        replyError(cmd, err::kState, "set_queue requires a trackIds array");
        return;
    }
    std::vector<std::string> queue;
    for (const Json& entry : ids->arr()) {
        const std::string id = entry.asString();
        if (id.empty()) continue;
        if (!catalog_.findById(id)) {
            replyError(cmd, err::kNotFound, "unknown trackId in queue: " + id);
            return;
        }
        queue.push_back(id);
    }
    // CR-030：队列面板拖拽/删除/排序后保住"正在播放的那首"。
    bool keepCurrent = false;
    if (const Json* keepValue = cmd.find("keepCurrent")) {
        if (!keepValue->isBool()) {
            replyError(cmd, err::kState, "keepCurrent must be a boolean");
            return;
        }
        keepCurrent = keepValue->asBool();
    }
    std::string currentTrackId;
    if (const Json* currentValue = cmd.find("currentTrackId")) {
        if (!currentValue->isString()) {
            replyError(cmd, err::kState, "currentTrackId must be a trackId string");
            return;
        }
        currentTrackId = currentValue->asString();
        // 显式给了 currentTrackId 时，它必须存在（允许空串 = 没有当前项）。
        if (!currentTrackId.empty() && !catalog_.findById(currentTrackId)) {
            replyError(cmd, err::kNotFound, "unknown currentTrackId: " + currentTrackId);
            return;
        }
    }
    player_.setQueue(queue, keepCurrent, currentTrackId);
    Json data = Json::object();
    data.set("count", static_cast<long long>(queue.size()));
    // 如实回读重排后指向哪首：-1 表示当前曲目不在队列里（队列外点开的单曲）。
    data.set("queueIndex", static_cast<long long>(player_.queueIndex()));
    replyOk(cmd, std::move(data));
}

void App::cmdSetRepeat(const Json& cmd) {
    const Json* modeValue = cmd.find("mode");
    const std::string mode = modeValue ? modeValue->asString() : std::string();
    if (mode == "sequential")      player_.setRepeatMode(RepeatMode::Sequential);
    else if (mode == "one")        player_.setRepeatMode(RepeatMode::RepeatOne);
    else if (mode == "all")        player_.setRepeatMode(RepeatMode::RepeatAll);
    else if (mode == "shuffle")    player_.setRepeatMode(RepeatMode::Shuffle);
    else {
        replyError(cmd, err::kState, "mode must be one of sequential | one | all | shuffle");
        return;
    }
    Json data = Json::object();
    data.set("mode", mode);
    replyOk(cmd, std::move(data));
    emitEvent(player_.stateEventJson());
}

void App::cmdSetEq(const Json& cmd) {
    // A PARTIAL update on purpose. A UI moving one slider should not have to
    // echo the other nine bands back, and requiring a full snapshot would make
    // a state round-trip part of every adjustment.
    const Json* enabled  = cmd.find("enabled");
    const Json* bands    = cmd.find("bandGains");
    const Json* shapes   = cmd.find("bands");
    const Json* preamp   = cmd.find("preampDb");
    const Json* q        = cmd.find("q");
    const Json* autoHr   = cmd.find("autoHeadroom");

    // Nothing named means nothing changed: that is a caller bug, and saying so
    // beats replying ok to a command that did nothing.
    if (!enabled && !bands && !shapes && !preamp && !q && !autoHr) {
        replyError(cmd, err::kState,
                   "set_eq needs at least one of enabled | bandGains | bands | preampDb | q | autoHeadroom");
        return;
    }

    if (enabled) player_.setEqEnabled(enabled->asBool());
    if (preamp)  player_.setEqPreamp(static_cast<float>(preamp->asDouble()));
    if (autoHr)  player_.setAutoHeadroom(autoHr->asBool());

    if (q) {
        std::string error;
        if (!player_.setEqQ(static_cast<float>(q->asDouble()), error)) {
            replyError(cmd, err::kState, "set_eq: " + error);
            return;
        }
    }

    if (bands) {
        if (!bands->isArray()) {
            replyError(cmd, err::kState, "set_eq: bandGains must be an array");
            return;
        }
        const auto& arr = bands->arr();
        if (arr.size() > static_cast<std::size_t>(kEqBandCount)) {
            replyError(cmd, err::kState, "set_eq: bandGains has more than " +
                       std::to_string(kEqBandCount) + " entries");
            return;
        }
        for (std::size_t i = 0; i < arr.size(); ++i) {
            if (!arr[i].isNumber()) {
                replyError(cmd, err::kState, "set_eq: bandGains entries must be numbers");
                return;
            }
            std::string error;
            if (!player_.setEqBand(static_cast<int>(i),
                                   static_cast<float>(arr[i].asDouble()), error)) {
                replyError(cmd, err::kState, "set_eq: " + error);
                return;
            }
        }
    }

    // CR-019: per-band parametric shape. Index-aligned with the existing
    // bandGains array; only the fields present in each entry change, so a UI
    // can send one band while dragging and never echo the other nine.
    if (shapes) {
        if (!shapes->isArray()) {
            replyError(cmd, err::kState, "set_eq: bands must be an array");
            return;
        }
        const auto& shapeArr = shapes->arr();
        if (shapeArr.size() > static_cast<std::size_t>(kEqBandCount)) {
            replyError(cmd, err::kState, "set_eq: bands has more than " +
                       std::to_string(kEqBandCount) + " entries");
            return;
        }
        for (std::size_t i = 0; i < shapeArr.size(); ++i) {
            const Json& band = shapeArr[i];
            if (!band.isObject()) {
                replyError(cmd, err::kState, "set_eq: bands entries must be objects");
                return;
            }
            const int index = static_cast<int>(i);
            if (const Json* gain = band.find("gainDb")) {
                if (!gain->isNumber()) {
                    replyError(cmd, err::kState, "set_eq: bands[].gainDb must be a number");
                    return;
                }
                std::string error;
                if (!player_.setEqBand(index, static_cast<float>(gain->asDouble()), error)) {
                    replyError(cmd, err::kState, "set_eq: " + error);
                    return;
                }
            }
            if (const Json* freq = band.find("freq")) {
                if (!freq->isNumber()) {
                    replyError(cmd, err::kState, "set_eq: bands[].freq must be a number");
                    return;
                }
                std::string error;
                if (!player_.setEqBandFreq(index, static_cast<float>(freq->asDouble()), error)) {
                    replyError(cmd, err::kState, "set_eq: " + error);
                    return;
                }
            }
            if (const Json* bandQ = band.find("q")) {
                if (!bandQ->isNumber()) {
                    replyError(cmd, err::kState, "set_eq: bands[].q must be a number");
                    return;
                }
                std::string error;
                if (!player_.setEqBandQ(index, static_cast<float>(bandQ->asDouble()), error)) {
                    replyError(cmd, err::kState, "set_eq: " + error);
                    return;
                }
            }
            if (const Json* type = band.find("type")) {
                int value = -1;
                if (type->isNumber()) {
                    value = static_cast<int>(type->asDouble());
                } else if (type->isString()) {
                    const std::string name = type->asString();
                    value = name == "lowShelf" ? 1 : name == "highShelf" ? 2
                          : name == "peaking" ? 0 : -1;
                }
                std::string error;
                if (!player_.setEqBandType(index, value, error)) {
                    replyError(cmd, err::kState, "set_eq: " + error);
                    return;
                }
            }
        }
    }

    Json data = player_.dspJson();
    replyOk(cmd, std::move(data));
}

void App::cmdAnalyzeLoudness(const Json& cmd) {
    // SPEC 3.4 asks for a libebur128 scan so ReplayGain can be COMPUTED rather
    // than only applied. Measurement and application stay separate commands on
    // purpose: this one changes nothing about playback, so a caller can inspect
    // the numbers before deciding to act on them.
    const Json* ids = cmd.find("trackIds");
    if (!ids || !ids->isArray() || ids->arr().empty()) {
        replyError(cmd, err::kState, "analyze_loudness requires a non-empty trackIds array");
        return;
    }

    const Json* maxSecondsField = cmd.find("maxSeconds");
    const double maxSeconds = (maxSecondsField && maxSecondsField->isNumber())
                                  ? maxSecondsField->asDouble() : 0.0;
    if (maxSeconds < 0.0) {
        replyError(cmd, err::kState, "maxSeconds must not be negative");
        return;
    }

    // Resolve EVERY id before measuring anything. Failing on the third of five
    // tracks after a minute of decoding would waste the work and leave the caller
    // unable to tell which id was wrong.
    std::vector<const Track*> selected;
    selected.reserve(ids->arr().size());
    for (const Json& entry : ids->arr()) {
        const std::string id = entry.asString();
        const Track* track = catalog_.findById(id);
        if (track == nullptr) {
            replyError(cmd, err::kNotFound, "no such trackId: " + id);
            return;
        }
        selected.push_back(track);
    }

    // Whether the caller needs ALBUM gain, which is a different question from
    // per-track gain and costs a different amount of work.
    //
    // Album loudness is a gated combination of the parts, so it needs a decoder
    // state per track. A track served from the cache has none. That makes album
    // gain fundamentally incompatible with a warm cache -- so it is the CALLER's
    // decision, not a guess made here.
    //
    // The first version of this tried to be clever: serve the cache, and if the
    // album then could not be combined, silently re-run with decoding forced.
    // That is worse than useless -- it paid the full decode AND reported zero
    // cache hits, so the cache looked broken while doing exactly what it was
    // told. Explicitness beats cleverness when the two modes cost this differently.
    const Json* albumField = cmd.find("album");
    const bool wantAlbum = albumField ? albumField->asBool(false) : false;

    // Asynchronous mode: start the work and return immediately, then let the
    // control loop advance it in slices. Without this the command blocks the
    // whole engine for the length of the scan, which for the 91-track library is
    // about two minutes of being unable to answer anything at all.
    const Json* asyncField = cmd.find("async");
    const bool async = asyncField ? asyncField->asBool(false) : false;

    if (async) {
        // One at a time. Two concurrent scans would each hold decoder state and
        // their progress would interleave into nonsense.
        if (loudnessScan_) {
            replyError(cmd, err::kState, "a loudness scan is already running");
            return;
        }
        if (wantAlbum && selected.size() > 1) {
            // Refused rather than silently degraded: album gain needs a decoder
            // state per track, and the asynchronous path is exactly the one that
            // must not hold 91 of them (SPEC 8.2 budgets the engine at 60 MB).
            // Saying so is better than returning an album figure computed from a
            // subset, and far better than returning one that is wrong.
            replyError(cmd, err::kState,
                       "album gain is not available from an asynchronous scan; "
                       "run it synchronously with album:true");
            return;
        }

        auto request = std::make_unique<LoudnessScanRequest>();
        request->replyId = commandId(cmd);
        request->maxSeconds = maxSeconds;
        request->wantAlbum = wantAlbum;
        for (const Track* track : selected) request->ids.push_back(track->id);

        auto started = std::make_unique<LoudnessScan>();
        std::vector<std::filesystem::path> files;
        files.reserve(selected.size());
        for (const Track* track : selected) files.push_back(track->path);
        // wantAlbum forces decode; per-track-only scans stay on the cache and
        // therefore complete almost instantly.
        started->beginScan(files, maxSeconds, wantAlbum);

        loudnessScan_    = std::move(started);
        loudnessRequest_ = std::move(request);

        Json data = Json::object();
        data.set("accepted", true);
        data.set("total", static_cast<long long>(selected.size()));
        // The reply id lets the client match the completion event to this call
        // even if it issued other commands in between (CR-007's principle).
        data.set("replyId", loudnessRequest_->replyId);
        replyOk(cmd, std::move(data));
        return;
    }

    // Held by pointer, not by value: LoudnessScan owns a decoder state per track
    // and is deliberately non-copyable and non-movable.
    auto scan = std::make_unique<LoudnessScan>();
    std::string error;
    const auto runScan = [&](LoudnessScan& target, bool forceDecode, std::string& err) {
        for (const Track* track : selected) {
            if (!target.addFile(track->path, maxSeconds, err, forceDecode)) return false;
        }
        return true;
    };

    // Asking for album gain means decoding, because there is no other way to
    // combine the gated blocks. Asking only for per-track gain stays on the cache.
    if (!runScan(*scan, wantAlbum, error)) {
        replyError(cmd, err::kDecode, error);
        return;
    }

    LoudnessResult album;
    std::string albumError;
    bool albumOk = scan->album(album, albumError);
    if (albumOk) scan->cacheAlbumResult(album);

    const auto loudnessJson = [](const LoudnessResult& r) {
        Json j = Json::object();
        if (!r.ok) {
            // Silent or too short to gate. Reported as an explicit absence rather
            // than as a number: a caller that applied a gain derived from a
            // placeholder would be acting on fiction.
            j.set("ok", false);
            j.set("reason", "too short or too quiet to gate");
            return j;
        }
        j.set("ok", true);
        j.set("integratedLufs", r.integratedLufs);
        j.set("gainDb", replayGainDb(r.integratedLufs));
        j.set("truePeakDb", r.truePeakDb);
        // Linear as well as dB: the preventClip cap works in amplitude, and
        // making every caller do the conversion is how one of them gets it wrong.
        j.set("peakLinear", truePeakLinear(r.truePeakDb));
        return j;
    };

    Json list = Json::array();
    const auto& results = scan->tracks();
    for (std::size_t i = 0; i < selected.size() && i < results.size(); ++i) {
        Json entry = loudnessJson(results[i]);
        entry.set("trackId", selected[i]->id);
        list.push(std::move(entry));
    }

    Json data = Json::object();
    data.set("targetLufs", kReplayGainTargetLufs);
    data.set("tracks", std::move(list));
    data.set("analysedSeconds", scan->analysedSeconds());

    if (albumOk) {
        data.set("album", loudnessJson(album));
    } else {
        Json none = Json::object();
        none.set("ok", false);
        none.set("reason", albumError);
        data.set("album", std::move(none));
    }

    // Whether the measurements came from the cache, so a caller can see that a
    // repeat scan was free rather than taking it on faith.
    data.set("cacheHits", scan->cacheHits());
    data.set("cacheEntries", scan->cacheSize());
    data.set("cachePath", LoudnessScan::cacheFilePath());
    data.set("cacheMissReason", scan->cacheMissReason());
    // Stated explicitly so a caller never has to infer why the album is missing.
    data.set("albumRequested", wantAlbum);

    replyOk(cmd, std::move(data));

    // Write after replying: the caller's answer must not wait on a disk write,
    // and a cache that fails to persist is a missed optimisation rather than a
    // failed command, so it is not reported as one.
    std::string cacheError;
    scan->saveCache(cacheError);
}

void App::serviceLoudnessScan() {
    if (!loudnessScan_) return;

    // One slice per pass through the control loop.
    //
    // Both bounds matter and they do different jobs. The CHUNK bound caps how
    // much work one pass does; the TIME bound caps it when the machine is slow.
    //
    // Bounding by FILES was the first attempt and it failed: a single
    // 200-second track took ~1.5 s to measure, so a 15 ms budget still stalled
    // the loop for seconds (get_state took 2885 ms to answer).
    //
    // 64 chunks is about 6 seconds of audio per pass, which keeps the worst-case
    // pause around 30 ms while leaving the loop enough work to stay efficient --
    // smaller slices make the control loop's own 5 ms input poll dominate and
    // halve the scan's throughput.
    constexpr double kSliceMs = 20.0;
    constexpr size_t kSliceChunks = 64;
    const bool more = loudnessScan_->stepScan(kSliceChunks, kSliceMs);

    // Progress is reported at a HUMAN cadence, not once per slice.
    //
    // The first version emitted on every pass, which for this library was 26,558
    // events for one scan -- more traffic than the scan itself produces and a
    // flood the app would have to throttle back down.
    const long long nowMs = monotonicMs();
    const long long chunks = loudnessScan_->scanChunks();
    if (more && (lastLoudnessProgressMs_ == 0 ||
                 nowMs - lastLoudnessProgressMs_ >= kLoudnessProgressIntervalMs ||
                 chunks == 0)) {
        lastLoudnessProgressMs_ = nowMs;
        Json progress = Json::object();
        progress.set("ev", "loudness_progress");
        progress.set("done", static_cast<long long>(loudnessScan_->scanDone()));
        progress.set("total", static_cast<long long>(loudnessScan_->scanTotal()));
        // The fine-grained figure, so a progress bar moves smoothly instead of
        // in 91 steps.
        progress.set("chunks", chunks);
        io_.emit(progress);
    }

    if (!more) finishLoudnessScan();
}

void App::finishLoudnessScan() {
    if (!loudnessScan_ || !loudnessRequest_) {
        loudnessScan_.reset();
        loudnessRequest_.reset();
        return;
    }

    const auto loudnessJson = [](const LoudnessResult& r) {
        Json j = Json::object();
        if (!r.ok) {
            j.set("ok", false);
            j.set("reason", "too short, too quiet, or unreadable");
            return j;
        }
        j.set("ok", true);
        j.set("integratedLufs", r.integratedLufs);
        j.set("gainDb", replayGainDb(r.integratedLufs));
        j.set("truePeakDb", r.truePeakDb);
        j.set("peakLinear", truePeakLinear(r.truePeakDb));
        return j;
    };

    Json list = Json::array();
    const auto& results = loudnessScan_->tracks();
    const auto& ids = loudnessRequest_->ids;
    for (std::size_t i = 0; i < ids.size() && i < results.size(); ++i) {
        Json entry = loudnessJson(results[i]);
        entry.set("trackId", ids[i]);
        list.push(std::move(entry));
    }

    // Album gain is refused for an asynchronous scan (see the command), so the
    // field is present and explicitly unavailable rather than absent -- a client
    // should not have to distinguish "not requested" from "not possible".
    Json album = Json::object();
    if (loudnessRequest_->wantAlbum && ids.size() == 1) {
        LoudnessResult one;
        std::string albumError;
        if (loudnessScan_->album(one, albumError)) album = loudnessJson(one);
        else { album.set("ok", false); album.set("reason", albumError); }
    } else {
        album.set("ok", false);
        album.set("reason", "not available from an asynchronous scan");
    }

    Json data = Json::object();
    data.set("targetLufs", kReplayGainTargetLufs);
    data.set("tracks", std::move(list));
    data.set("album", std::move(album));
    data.set("analysedSeconds", loudnessScan_->analysedSeconds());
    data.set("cacheHits", loudnessScan_->cacheHits());
    data.set("albumRequested", loudnessRequest_->wantAlbum);

    Json done = Json::object();
    done.set("ev", "loudness_done");
    done.set("replyId", loudnessRequest_->replyId);
    done.set("data", std::move(data));
    io_.emit(done);

    std::string cacheError;
    loudnessScan_->saveCache(cacheError);

    loudnessScan_.reset();
    loudnessRequest_.reset();
    lastLoudnessProgressMs_ = 0;
}

void App::serviceDeviceChanges() {
    DeviceChange change;
    if (!takeDeviceChange(change)) return;

    // Coalesce a hot-plug storm into one reaction: unplugging a dock can raise
    // several notifications, and reopening the stream for each one would thrash
    // the device while the user is still plugging things in.
    // The stream is invalidated by TWO different events, and the first version
    // only caught one of them:
    //   * the device it is on was REMOVED (unplugged, disabled), or
    //   * the default moved to a DIFFERENT device and the engine is expected to
    //     follow it -- the user chose other speakers, so continuing to play into
    //     the old endpoint would be ignoring them.
    const std::string streamDevice = player_.outputStatus().deviceId;
    const bool deviceGone = change.currentRemoved && !streamDevice.empty() &&
                            change.removedId == streamDevice;
    const bool defaultMovedAway = change.defaultChanged && !streamDevice.empty() &&
                                   !change.newDefaultId.empty() &&
                                   change.newDefaultId != streamDevice;
    // 输出流已经没了（上一次热插拔重开失败时 reopenOutput 会关流），而这时默认
    // 端点又变了：streamDevice 是空串，上面两个条件都不成立，旧代码于是只发一个
    // device_changed 事件、**不重开流**。现场 diag 日志正是这个形状：
    //   removed=耳机 streamLost=1（重开失败，流被关掉）
    //   20~500 ms 后 defaultChanged=扬声器 streamLost=0（因为 streamDevice 已空）
    // 之后引擎一直无声，直到用户再点一次播放/切歌。这里把"没有流 + 默认端点变了"
    // 也算作必须恢复的丢失，交给 player 的默认端点回退去重建。
    const bool outputLost = !player_.outputAvailable();
    const bool streamLost = deviceGone || defaultMovedAway ||
                            (change.defaultChanged && outputLost);

    // SPEC 449 asks for the DEVICE-CHANGE history in the diagnostic file.
    // Recorded for every observed change, including the ones that are not news
    // to the client: "the stream did not move" is exactly what a reader needs
    // in order to know that the engine saw the notification and judged it
    // irrelevant, rather than never seeing it at all.
    diagRecord("device", std::string("defaultChanged=") + (change.defaultChanged ? "1" : "0") +
                        " removed=" + (change.currentRemoved ? "1" : "0") +
                        " newDefault=" + change.newDefaultId +
                        " removed=" + change.removedId +
                        " streamLost=" + (streamLost ? "1" : "0"));

    // NOTIFICATIONS ARRIVE ONCE PER AUDIO ROLE. Windows raises the default-change
    // callback for console, multimedia and communications separately, so setting
    // one device produces three. Only the FIRST one is news -- the others repeat
    // the same id, and forwarding them would show the user two or three
    // "device changed" notices for a single action.
    const bool defaultIsNews = change.defaultChanged &&
                               !change.newDefaultId.empty() &&
                               change.newDefaultId != reportedDefaultId_;

    if (change.defaultChanged && !change.newDefaultId.empty()) {
        preferredDeviceId_ = change.newDefaultId;
        reportedDefaultId_ = change.newDefaultId;
    }

    // Nothing happened that the client has not already been told.
    if (!streamLost && !defaultIsNews) return;

    if (streamLost) {
        // SPEC 3.3: release the stream and reopen, falling back to the default.
        // The player owns that sequence -- it has to preserve the source position
        // across the reopen, which is the part that is easy to get wrong.
        std::string error;
        if (!player_.reopenForDeviceChange(preferredDeviceId_, error)) {
            // Both the new device and the default failed. This IS a device error,
            // and the state event is how the client finds out.
            io_.log("warn", "device change could not be recovered: " + error);
        }
    }

    // CONTRACT 3.3 defines this event and the engine had NEVER emitted it, so a
    // client could not learn that the user unplugged their headphones -- the UI
    // went on showing a device that was no longer there.
    Json event = Json::object();
    event.set("ev", "device_changed");
    const OutputStatus& status = player_.outputStatus();
    event.set("deviceId", status.deviceId);
    event.set("deviceName", status.deviceName);
    // Which kind of change it was, so a UI can say "switched to the speakers"
    // or "your headphones were unplugged" rather than just showing a new name.
    event.set("defaultChanged", change.defaultChanged);
    event.set("streamLost", streamLost);
    if (!change.removedId.empty()) event.set("removedDeviceId", change.removedId);
    io_.emit(event);
}

void App::cmdSetReplayGain(const Json& cmd) {
    const Json* modeValue = cmd.find("mode");
    if (!modeValue) {
        replyError(cmd, err::kState, "set_replaygain requires a mode");
        return;
    }
    std::string error;
    if (!player_.setReplayGainMode(modeValue->asString(), error)) {
        replyError(cmd, err::kState, error);
        return;
    }

    // The gain and peak values describe the FILE, so they are optional here and
    // only applied when present. Until the libebur128 scanner lands (SPEC 3.4)
    // they arrive from the app side; when the engine computes them it will fill
    // exactly these fields, so nothing about this call has to change.
    const DspParams& cur = player_.dspParams();
    auto num = [&](const char* key, float fallback) -> float {
        const Json* v = cmd.find(key);
        return (v && v->isNumber()) ? static_cast<float>(v->asDouble()) : fallback;
    };
    const Json* prevent = cmd.find("preventClip");
    player_.setReplayGainValues(num("trackGainDb", cur.rgTrackGainDb),
                                num("albumGainDb", cur.rgAlbumGainDb),
                                num("preampDb",    cur.rgPreampDb),
                                num("trackPeak",   cur.rgTrackPeak),
                                num("albumPeak",   cur.rgAlbumPeak),
                                prevent ? prevent->asBool() : cur.preventClip);

    Json data = player_.dspJson();
    replyOk(cmd, std::move(data));
}

// CR-032：解码能力矩阵。只增命令，回答两个问题：
//   1) 这个引擎能解哪些格式（扩展名 + 是否无损 + 由谁解）；
//   2) 本机的系统解码器到底在不在（available 是本机实测，不是平台应有）。
//
// 为什么不让客户端自己维护一张扩展名表：那张表会和引擎漂移，而漂移的表现是
// "界面说能播、点了报 ERR_DECODE"。能力只能由有能力的那一侧回答。
void App::cmdGetCapabilities(const Json& cmd) {
    Json data = Json::object();
    Json decoders = Json::array();
    for (const auto& capability : decoderCapabilities()) {
        Json entry = Json::object();
        entry.set("ext", capability.ext);
        entry.set("label", capability.label);
        entry.set("kind", decoderKindName(capability.kind));
        entry.set("lossless", capability.lossless);
        entry.set("available", capability.available);
        decoders.push(std::move(entry));
    }
    data.set("protocol", kProtocolVersion);
    data.set("decoders", std::move(decoders));
    // CR-032 的形状：{supported, modes, output, decimationPcmRate}。留一个空对象
    // 会让客户端无法区分"引擎没实现"与"这次查询失败"——字段齐全才叫如实。
    {
        Json dsd = Json::object();
        dsd.set("supported", true);
        Json modes = Json::array();
        modes.push(std::string("dsd64"));
        modes.push(std::string("dsd128"));
        modes.push(std::string("dsd256"));
        dsd.set("modes", std::move(modes));
        // 本构建只做抽取到 PCM，不做 DoP / 原生 DSD 输出。谎报 "native" 会让
        // 任何 DAC 前的采样率断言都失效。
        dsd.set("output", "pcm");
        dsd.set("decimationPcmRate", 176400);
        data.set("dsd", std::move(dsd));
    }
    data.set("systemDecoders", mediaFoundationAvailable());
    replyOk(cmd, std::move(data));
}

void App::cmdGetState(const Json& cmd) {
    Json data = player_.stateEventJson();
    // get_state is the full picture, so it carries the DSP state as well. The
    // periodic state EVENT deliberately does not: it fires ten times a second,
    // and this content only changes when the user moves something.
    data.set("dsp", player_.dspJson());
    replyOk(cmd, std::move(data));
}

void App::cmdSetOutput(const Json& cmd) {
    const Json* modeValue = cmd.find("mode");
    // Omitted mode = keep the current preference. It used to default to "auto",
    // which meant a client that only wanted to change the output RATE silently
    // also reset the user's exclusive/shared choice.
    const std::string mode = modeValue ? modeValue->asString()
                                       : std::string(player_.outputModeName(player_.outputMode()));
    if (mode != "auto" && mode != "shared" && mode != "exclusive") {
        replyError(cmd, err::kState, "mode must be one of exclusive | shared | auto");
        return;
    }

    // CONTRACT 3.4 draws a careful line here, and it is worth restating: a
    // degradation is the ENGINE choosing a lesser mode (exclusive refused ->
    // shared), and that is NOT an error. A request the engine cannot honour at
    // all would be one. Exclusive IS honoured now, so the only way this returns
    // ok:false is a genuinely unknown mode.
    const Json* deviceValue = cmd.find("deviceId");
    if (deviceValue && deviceValue->isString()) preferredDeviceId_ = deviceValue->asString();

    // Optional fixed output rate. The allowed set is the same one the capability
    // probe reports (exclusive_format.hpp's rate list), so the command cannot ask
    // for a rate no endpoint could ever be tested at. 0 = follow the source.
    int requestedRate = player_.requestedOutputRate();
    if (const Json* rateValue = cmd.find("sampleRate")) {
        if (!rateValue->isNumber()) {
            replyError(cmd, err::kState, "sampleRate must be a number (0 = follow the source)");
            return;
        }
        const long long raw = rateValue->asInt(-1);
        const bool allowed = raw == 0 || raw == 44100 || raw == 48000 || raw == 88200 ||
                             raw == 96000 || raw == 176400 || raw == 192000 ||
                             raw == 352800 || raw == 384000;
        if (!allowed) {
            replyError(cmd, err::kState,
                       "sampleRate must be 0 (follow source), 44100, 48000, 88200, 96000, "
                       "176400, 192000, 352800 or 384000");
            return;
        }
        requestedRate = static_cast<int>(raw);
        player_.setOutputRate(requestedRate);
    }

    // CR-027：可选延迟档位。省略 = 保持当前（与 mode 同一语义）。
    if (const Json* latencyValue = cmd.find("latencyProfile")) {
        if (!latencyValue->isString()) {
            replyError(cmd, err::kState, "latencyProfile must be stable | balanced | lowLatency");
            return;
        }
        const std::string latency = latencyValue->asString();
        if      (latency == "stable")     player_.setLatencyProfile(LatencyProfile::Stable);
        else if (latency == "balanced")   player_.setLatencyProfile(LatencyProfile::Balanced);
        else if (latency == "lowLatency") player_.setLatencyProfile(LatencyProfile::LowLatency);
        else {
            replyError(cmd, err::kState, "latencyProfile must be stable | balanced | lowLatency");
            return;
        }
    }

    // CR-028（V3 §1.1）：transport 淡变时长与 pause-hold 开关。省略 = 保持当前。
    if (const Json* fadeValue = cmd.find("fadeMs")) {
        if (!fadeValue->isNumber()) {
            replyError(cmd, err::kState, "fadeMs must be a number (5..50, milliseconds)");
            return;
        }
        const long long ms = fadeValue->asInt(-1);
        if (ms < 5 || ms > 50) {
            replyError(cmd, err::kState, "fadeMs must be within 5..50 ms");
            return;
        }
        player_.setFadeMs(static_cast<int>(ms));
    }
    if (const Json* holdValue = cmd.find("pauseHold")) {
        if (!holdValue->isBool()) {
            replyError(cmd, err::kState, "pauseHold must be a boolean");
            return;
        }
        player_.setPauseHold(holdValue->asBool());
    }

    if (mode == "exclusive")      player_.setOutputMode(OutputMode::Exclusive);
    else if (mode == "shared")    player_.setOutputMode(OutputMode::Shared);
    else                          player_.setOutputMode(OutputMode::Auto);

    // Re-establish the stream so the change is audible now rather than at the
    // next track. With a track open this renegotiates at its source rate (or the
    // requested fixed rate); without one it just revalidates the device.
    //
    // It must RESUME afterwards: reopening tears the stream down, and a settings
    // change that silently stops the music is indistinguishable from a crash.
    const bool wasPlaying = (player_.state() == PlayState::Playing);
    // E10：显式改输出设置（模式/设备/固定采样率）必须让独占能力缓存失效——
    // 用户可能刚换了设备或改了系统独占设置，旧结论不再可信。
    player_.invalidateOutputCapabilities();
    player_.reopenOutput(preferredDeviceId_);
    if (wasPlaying) {
        std::string resumeError;
        if (!player_.play(resumeError)) {
            // The stream came back but did not start. Say so as a log event;
            // the state event that reopenOutput already emitted describes the
            // stream that IS open, and no claim of "playing" is made here.
            io_.log("error", "output reopened but playback did not resume: " + resumeError);
        }
    }

    const OutputStatus& status = player_.outputStatus();
    Json data = Json::object();
    data.set("requestedMode", mode);
    data.set("outputMode", status.outputMode);
    data.set("deviceId", status.deviceId);
    data.set("deviceName", status.deviceName);
    data.set("sampleRate", status.sampleRate);
    // Echoed back so the client never has to remember what it asked for: the
    // achieved rate above and this requested rate are two different facts.
    data.set("requestedOutputRate", static_cast<long long>(requestedRate));
    data.set("periodMs", status.periodMs);
    data.set("bitPerfect", player_.isBitPerfect());
    // Empty when nothing was degraded; otherwise the reason, so the UI can show
    // it instead of silently pretending the request was met.
    data.set("degradeReason", status.degradeReason);
    replyOk(cmd, std::move(data));
}


void App::cmdSetDither(const Json& cmd) {
    // CR-025：只增命令。mode 必填（省略=保持会让"成功但什么都没做"变得不可解释；
    // 与 set_resampler 的"至少一个字段"语义一致即可，但这里只有一个字段，直接必填）。
    const Json* modeValue = cmd.find("mode");
    if (!modeValue || !modeValue->isString()) {
        replyError(cmd, err::kState,
                   "set_dither requires mode = off | tpdf | highpass-tpdf | ns-5 | ns-9 | ultra-shaped");
        return;
    }
    DitherMode mode;
    if (!ditherModeFromName(modeValue->asString(), mode)) {
        replyError(cmd, err::kState,
                   "mode must be one of off | tpdf | highpass-tpdf | ns-5 | ns-9 | ultra-shaped");
        return;
    }
    player_.setDitherMode(mode);
    Json data = Json::object();
    // active 是"这次量化是否真的加抖动"，由当前流格式决定；没有流/等位深时为 false。
    data.set("mode", ditherModeName(player_.ditherMode()));
    data.set("active", player_.ditherActive());
    replyOk(cmd, std::move(data));
}

void App::cmdSetResampler(const Json& cmd) {
    // CR-024：字段全部可选（省略 = 保持当前），非法值 ERR_STATE —— 与既有 set_*
    // 一致：拒绝而不是 clamp，静默修正会把调用方的 bug 藏起来。
    const Json* qualityValue = cmd.find("quality");
    const Json* phaseValue   = cmd.find("phase");
    const Json* steepValue   = cmd.find("steep");
    if (!qualityValue && !phaseValue && !steepValue) {
        replyError(cmd, err::kState,
                   "set_resampler needs at least one of quality | phase | steep");
        return;
    }

    ResamplerConfig config = player_.resamplerConfig();
    if (qualityValue) {
        if (!qualityValue->isString()) {
            replyError(cmd, err::kState, "quality must be one of VHQ | HQ | 24BIT");
            return;
        }
        const std::string quality = qualityValue->asString();
        if      (quality == "VHQ")   config.quality = ResamplerQuality::VHQ;
        else if (quality == "HQ")    config.quality = ResamplerQuality::HQ;
        else if (quality == "24BIT") config.quality = ResamplerQuality::Bit24;
        else {
            replyError(cmd, err::kState, "quality must be one of VHQ | HQ | 24BIT");
            return;
        }
    }
    if (phaseValue) {
        if (!phaseValue->isString()) {
            replyError(cmd, err::kState, "phase must be one of linear | minimum | intermediate | maximum");
            return;
        }
        const std::string phase = phaseValue->asString();
        if      (phase == "linear")       config.phase = ResamplerPhase::Linear;
        else if (phase == "minimum")      config.phase = ResamplerPhase::Minimum;
        else if (phase == "intermediate") config.phase = ResamplerPhase::Intermediate;
        else if (phase == "maximum")      config.phase = ResamplerPhase::Maximum;
        else {
            replyError(cmd, err::kState, "phase must be one of linear | minimum | intermediate | maximum");
            return;
        }
    }
    if (steepValue) {
        if (!steepValue->isBool()) {
            replyError(cmd, err::kState, "steep must be a boolean");
            return;
        }
        config.steep = steepValue->asBool();
    }

    bool appliedNow = false;
    std::string error;
    if (!player_.setResampler(config, appliedNow, error)) {
        // 重建失败已回滚旧配置；这里如实报内部错误，不把失败说成成功。
        replyError(cmd, err::kInternal, "set_resampler: " + error);
        return;
    }
    Json data = Json::object();
    data.set("quality", resamplerQualityName(player_.resamplerConfig().quality));
    data.set("phase", resamplerPhaseName(player_.resamplerConfig().phase));
    data.set("steep", player_.resamplerConfig().steep);
    // applied 是"现在已生效"还是"下次 open 生效"：播放中重配从同一源码帧继续，
    // 不谎称无缝（CONTRACT 的诚实性要求）。
    data.set("applied", appliedNow);
    replyOk(cmd, std::move(data));
}

void App::cmdPickFolder(const Json& cmd) {
    // CONTRACT 3.2 lists pick_folder as an engine-side native folder picker.
    // Nobody has asked for it yet and AI-B currently passes an explicit path, so
    // it is reported honestly as unimplemented rather than half-built.
    replyError(cmd, err::kUnsupported,
               "pick_folder is not implemented in this build; the app side owns folder selection",
               "not_implemented");
}

void App::cmdShutdown(const Json& cmd) {
    // Close the device BEFORE replying and before run() returns. Releasing a
    // live WASAPI client from the destructor lands in the process-exit window,
    // which is exactly where the audio service is least forgiving.
    player_.releaseOutput();
    // ...and the decoder, for the same reason and one more: Media Foundation must
    // be shut down after every source reader it handed out is gone, and both
    // belong before the process-exit window rather than inside it.
    player_.releaseSource();
    shutdownMediaFoundation();
    // SPEC 449 wants the diagnostic record on disk, and a process exit is
    // exactly where an unflushed buffer is lost -- the same reason the device
    // is closed here rather than in a destructor.
    diagRecord("engine", "shutdown");
    diagClose();
    replyOk(cmd, Json::object());
    shutdownRequested_ = true;
}

// Commands that exist in the frozen contract but are not implemented yet answer
// with a truthful ERR_UNSUPPORTED rather than pretending to succeed: the app can
// then grey the control out instead of believing playback started.
void App::replyUnsupported(const Json& cmd) {
    const Json* nameField = cmd.find("cmd");
    const std::string name = nameField ? nameField->asString() : std::string("?");
    replyError(cmd, err::kUnsupported,
               "command not implemented in this build: " + name,
               "not_implemented");
}

void App::processLine(const std::string& line) {
    bool hasContent = false;
    for (char c : line) {
        if (c != ' ' && c != '\t' && c != '\r') { hasContent = true; break; }
    }
    if (!hasContent) return;

    auto parsed = Json::parse(line);
    if (!parsed) {
        // CONTRACT 3.2: a command with no id cannot be answered with a
        // correlated error, so the failure goes to the log channel where it
        // cannot corrupt the app parser.
        io_.log("error", "malformed JSON on stdin: " + line);
        return;
    }
    const Json& cmd = *parsed;

    const Json* nameField = cmd.find("cmd");
    const std::string name = nameField ? nameField->asString() : std::string();
    if (name.empty()) {
        replyError(cmd, err::kInternal, "command has no cmd field");
        return;
    }

    if (name == "hello")            cmdHello(cmd);
    else if (name == "list_devices") cmdListDevices(cmd);
    else if (name == "list_tracks")  cmdListTracks(cmd);
    else if (name == "scan")         cmdScan(cmd);
    else if (name == "open")         cmdOpen(cmd);
    else if (name == "play")         cmdPlay(cmd);
    else if (name == "pause")        cmdPause(cmd);
    else if (name == "stop")         cmdStop(cmd);
    else if (name == "next")         cmdNext(cmd);
    else if (name == "prev")         cmdPrev(cmd);
    else if (name == "seek")         cmdSeek(cmd);
    else if (name == "set_volume")   cmdSetVolume(cmd);
    else if (name == "set_muted")    cmdSetMuted(cmd);
    else if (name == "set_meter")    cmdSetMeter(cmd);
    else if (name == "set_channels") cmdSetChannels(cmd);
    else if (name == "set_limiter")  cmdSetLimiter(cmd);
    else if (name == "set_eq")       cmdSetEq(cmd);
    else if (name == "set_ir")       cmdSetIr(cmd);
    else if (name == "set_replaygain") cmdSetReplayGain(cmd);
    else if (name == "analyze_loudness") cmdAnalyzeLoudness(cmd);
    else if (name == "set_queue")    cmdSetQueue(cmd);
    else if (name == "set_repeat")   cmdSetRepeat(cmd);
    else if (name == "get_state")    cmdGetState(cmd);
    else if (name == "get_capabilities") cmdGetCapabilities(cmd);
    else if (name == "set_output")   cmdSetOutput(cmd);
    else if (name == "set_resampler") cmdSetResampler(cmd);
    else if (name == "set_dither")    cmdSetDither(cmd);
    else if (name == "set_spatial")   cmdSetSpatial(cmd);
    else if (name == "pick_folder")  cmdPickFolder(cmd);
    else if (name == "shutdown")     cmdShutdown(cmd);
    else                             replyUnsupported(cmd);
}

int App::run() {
    ComApartment com;
    if (!com.ok()) {
        io_.log("warn", "COM initialisation failed on the control thread");
    }

    devices_ = enumerateRenderDevices();
    io_.log("info", "render devices found: " + std::to_string(devices_.size()));

    player_.initialise("");
    if (player_.outputAvailable()) {
        const OutputStatus& status = player_.outputStatus();
        io_.log("info", "output opened: " + status.deviceName + "  shared  " +
                            std::to_string(status.sampleRate) + "Hz  " +
                            std::to_string(status.channels) + "ch  period " +
                            std::to_string(status.periodMs) + "ms");
        io_.log("info", "device mix format: tag=" + std::to_string(status.formatTag) +
                            " bits=" + std::to_string(status.bitsPerSample) +
                            " valid=" + std::to_string(status.validBits) +
                            " blockAlign=" + std::to_string(status.blockAlign) +
                            " float=" + (status.isFloat ? "yes" : "no"));
    } else {
        io_.log("warn", "no output device opened: " + player_.outputError());
    }

    startedAtMs_ = monotonicMs();
    // Listen for hot-plug from here on. Before this point there is no stream to
    // invalidate and no client to tell.
    startDeviceMonitor();
    emitReady();

    std::string line;
    for (;;) {
        // The control loop paces itself at the position-event cadence: a command
        // that needs more time turns into a no-op, which keeps this a single
        // ordered command stream without burning a core.
        // Anything the engine deferred during a long operation is handled
        // first, so the stream stays in arrival order.
        bool handled = false;
        while (!pendingCommands_.empty()) {
            std::string deferred = std::move(pendingCommands_.front());
            pendingCommands_.erase(pendingCommands_.begin());
            processLine(deferred);
            handled = true;
        }

        const bool gotLine = io_.pollLine(line, 5);
        if (gotLine) {
            processLine(line);
            handled = true;
        } else if (io_.stdinClosed() && !handled) {
            break;
        }
        if (shutdownRequested_) break;

        // SPEC 3.3: a hot-plug observed by the COM monitor is acted on here,
        // on the thread that owns the stream.
        serviceDeviceChanges();

        // An asynchronous scan advances here, for the same reason deferred
        // commands are pumped here: this is the only place that may do work
        // between commands without blocking the stream.
        serviceLoudnessScan();

        std::string endedTrackId;
        if (player_.tick(monotonicMs(), endedTrackId)) {
            // CONTRACT 3.3: reason is eof | stop | error. Reaching the end of the
            // stream is eof; a manual stop reports its own state change.
            handleTrackFinished(endedTrackId);
        }
    }

    player_.stop();
    io_.log("info", "engine exiting (CONTRACT 2 A7: no orphan engine process)");
    return 0;
}

} // namespace te
