#pragma once
// stdin / stdout / stderr plumbing for the JSON Lines channel (CONTRACT 3.1).
//
// The iron rules of 3.1 are enforced here so no other translation unit can
// break them:
//   * stdout carries JSON Lines and nothing else. Every write is one complete
//     frame followed by a single '\n', and stdout is put in binary mode so the
//     C runtime never injects '\r'. Any debug print from any library goes to
//     stderr instead.
//   * diagnostics go to stderr only.
//
// Reading stdin is done by a dedicated reader thread rather than inline, for a
// reason worth recording: the control thread has to wait for a command *and*
// keep ticking the player, and Windows gives no correct way to poll a
// synchronous pipe for "no data yet" versus "the app closed us". A synchronous
// pipe handle is always signalled, so WaitForSingleObject cannot tell those
// apart -- using it made the engine exit the moment it started. A blocking
// reader thread plus a condition variable is the version that is simply right.
// This is the I/O thread of SPEC 3.2.

#include <condition_variable>
#include <cstddef>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

#include "json.hpp"

namespace te {

class Io {
public:
    Io();
    ~Io();

    Io(const Io&)            = delete;
    Io& operator=(const Io&) = delete;

    // Serialise the frame and write it to stdout as exactly one line, then
    // flush. Safe from any thread. The RT thread must never call this: per
    // SPEC 3.2 the render thread only bumps counters.
    //
    // reserveHint 是构造行字符串时的预分配量。体积已知的事件（meter 帧）用它
    // 免掉 dump 过程中的一次翻倍拷贝；命令回复用默认值即可。
    void emit(const Json& frame, std::size_t reserveHint = 512);

    // Waits up to timeoutMs for one complete command line. Returns true when a
    // line was produced, false on timeout or EOF.
    bool pollLine(std::string& out, int timeoutMs);

    // Blocks until a line arrives or stdin ends.
    bool readLine(std::string& out);

    // Human-readable diagnostics. Never stdout.
    void log(const char* level, const std::string& message);

    bool stdinClosed() const;

private:
    void readerLoop();
    bool extractLineLocked(std::string& out);

    std::mutex              outMutex_;

    std::mutex              inMutex_;
    std::condition_variable inCv_;
    std::string             inBuffer_;
    bool                    eof_      = false;
    bool                    stopping_ = false;
    void*                   inHandle_ = nullptr;   // HANDLE
    std::thread             reader_;
};

} // namespace te