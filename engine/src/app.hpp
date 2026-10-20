#pragma once
// Engine core: owns every piece of state and turns one command line into one
// reply plus zero or more events.
//
// CONTRACT 3.2 fixes the command set and CONTRACT 3.3 the event set; this class
// is the only place that decides what they mean. The control loop is
// deliberately single-threaded: commands are handled in the order they arrive,
// which is exactly the order the app observes on the wire.

#include <chrono>
#include <memory>
#include <string>
#include <vector>

#include "analysis.hpp"

#include "catalog.hpp"
#include "devices.hpp"
#include "io.hpp"
#include "json.hpp"
#include "player.hpp"

namespace te {

class App {
public:
    explicit App(Io& io);
    ~App();

    // Runs until shutdown or stdin EOF. Returns the process exit code.
    int run();

    // Event sink used by the player. Never called from the render thread.
    void emitEvent(const Json& event) { io_.emit(event); }
    // 体积已知的事件（meter 帧）用这个重载：帧约 300–400 B，预分配后 dump 只分配一次。
    void emitEvent(const Json& event, std::size_t reserveHint) { io_.emit(event, reserveHint); }

    // Handles one already-received command line. The control loop passes
    // everything through here, including lines that arrived while a long
    // operation was running, so no command can be silently dropped.
    void dispatchLine(const std::string& line) { processLine(line); }

    // Crash diagnostics: which render-thread call was in progress. Only
    // meaningful in a TE_RT_TRACE build.
    const char* renderStageDescription() const;

    // Used by --selftest: exercises the JSON codec against the exact shapes the
    // protocol carries, including the pathological filenames of the test
    // library. Prints to stderr and returns the number of failures.
    static int selfTest();

private:
    void emitReady();
    void processLine(const std::string& line);
    long long monotonicMs() const;

    // --- command handlers -------------------------------------------------
    void cmdHello(const Json& cmd);
    void cmdListDevices(const Json& cmd);
    void cmdListTracks(const Json& cmd);
    void cmdScan(const Json& cmd);
    void cmdOpen(const Json& cmd);
    void cmdPlay(const Json& cmd);
    void cmdPause(const Json& cmd);
    void cmdStop(const Json& cmd);
    void cmdNext(const Json& cmd);
    void cmdPrev(const Json& cmd);
    void cmdSeek(const Json& cmd);
    void cmdSetVolume(const Json& cmd);
    void cmdSetMuted(const Json& cmd);
    void cmdSetMeter(const Json& cmd);
    void cmdSetChannels(const Json& cmd);
    // CR-031：限幅器 enabled / ceilingDb / releaseMs / lookaheadMs（只增命令）。
    void cmdSetLimiter(const Json& cmd);
    // CR-029：空间音频（off/crossfeed/wide/virtual + amount/azimuth/delayMs）。
    void cmdSetSpatial(const Json& cmd);
    void cmdSetEq(const Json& cmd);
    void cmdSetIr(const Json& cmd);
    void cmdSetReplayGain(const Json& cmd);
    void cmdAnalyzeLoudness(const Json& cmd);
    // Continues an analyze_loudness started with async:true. Called from the
    // control loop, never from the command handler, so the loop stays the only
    // place that advances work.
    void serviceLoudnessScan();
    // Emitted when an asynchronous scan finishes, including its own failures.
    void finishLoudnessScan();
    // SPEC 3.3: act on a device hot-plug that the COM monitor observed. Runs on
    // the control loop, never in the notification callback.
    void serviceDeviceChanges();
    // The default endpoint the client was last told about. Notifications arrive
    // once per audio role, so one user action produces several; comparing against
    // what was actually reported collapses them into one event.
    std::string reportedDefaultId_;
    void cmdSetQueue(const Json& cmd);
    void cmdSetRepeat(const Json& cmd);
    void cmdGetState(const Json& cmd);
    // CR-032：解码能力矩阵（只增命令）。旧客户端不会发它；发了的客户端会得到
    // 一份"本机实测"的清单，而不是从扩展名猜出来的能力表。
    void cmdGetCapabilities(const Json& cmd);
    void cmdSetOutput(const Json& cmd);
    // CR-024 / CR-025：重采样器档位与 dither 模式（只增命令）。
    void cmdSetResampler(const Json& cmd);
    void cmdSetDither(const Json& cmd);
    void cmdPickFolder(const Json& cmd);
    void cmdShutdown(const Json& cmd);
    void replyUnsupported(const Json& cmd);

    // --- reply helpers ----------------------------------------------------
    void replyOk(const Json& cmd, Json data);
    // kind is optional and currently used only for ERR_UNSUPPORTED, to separate a
    // missing implementation from a hardware limitation (DESIGN-A 6).
    void replyError(const Json& cmd, const char* code, const std::string& message,
                    const char* kind = nullptr);
    long long commandId(const Json& cmd) const;

    // Resolves a trackId from a command, or reports ERR_NOTFOUND.
    const Track* requireTrack(const Json& cmd, std::string& error);

    // Loads the track the queue currently points at and, when the caller asks,
    // starts it. This is what turns "next" from an index bump into playback.
    bool loadQueuedTrack(bool startPlaying, std::string& error);

    // Emits the ended event and continues the queue when there is somewhere to
    // go. Called from the control loop when the player reports end of stream.
    void handleTrackFinished(const std::string& endedTrackId);

    Io&                     io_;
    Catalog                 catalog_;
    std::vector<DeviceInfo> devices_;
    Player                  player_;
    std::string             preferredDeviceId_;
    // Commands received while a long operation was running. Drained by the
    // control loop in arrival order, before anything read from stdin later.
    std::vector<std::string> pendingCommands_;

    // The in-flight asynchronous loudness scan. unique_ptr for the same reason
    // the synchronous path uses one: LoudnessScan owns a decoder state per track
    // and is deliberately non-copyable and non-movable.
    std::unique_ptr<LoudnessScan> loudnessScan_;
    struct LoudnessScanRequest {
        std::vector<std::string> ids;      // in request order, for the reply
        long long                replyId = 0;
        double                   maxSeconds = 0.0;
        bool                     wantAlbum = false;
    };
    std::unique_ptr<LoudnessScanRequest> loudnessRequest_;
    // Throttles progress events to a human cadence. 0 means "none sent yet".
    long long lastLoudnessProgressMs_ = 0;
    static constexpr long long kLoudnessProgressIntervalMs = 250;
    bool                    shutdownRequested_ = false;
    bool                    readySent_         = false;
    long long               startedAtMs_       = 0;
};

} // namespace te
