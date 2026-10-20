#include "io.hpp"

#include <windows.h>

#include <fcntl.h>
#include <io.h>

namespace te {

Io::Io() {
    // Binary mode on stdout: the protocol is '\n'-terminated UTF-8, never CRLF.
    _setmode(_fileno(stdout), _O_BINARY);
    std::setvbuf(stdout, nullptr, _IOFBF, 1u << 16);
    std::setvbuf(stderr, nullptr, _IONBF, 0);

    inBuffer_.reserve(1 << 16);
    inHandle_ = ::GetStdHandle(STD_INPUT_HANDLE);

    // If stdin is unusable there is nobody to talk to; the caller sees EOF and
    // shuts down rather than hanging.
    if (!inHandle_ || inHandle_ == INVALID_HANDLE_VALUE) {
        eof_ = true;
        return;
    }
    reader_ = std::thread([this] { readerLoop(); });
}

Io::~Io() {
    {
        std::lock_guard<std::mutex> lock(inMutex_);
        stopping_ = true;
    }
    inCv_.notify_all();
    // The reader is normally blocked in ReadFile on stdin. It is detached from
    // here rather than joined, because a blocking ReadFile cannot be cancelled
    // portably and process teardown is about to close the handle anyway. The
    // thread touches no engine state, so this is safe.
    if (reader_.joinable()) reader_.detach();
    std::fflush(stdout);
}

void Io::readerLoop() {
    HANDLE handle = static_cast<HANDLE>(inHandle_);
    char   chunk[8192];

    for (;;) {
        DWORD got = 0;
        const BOOL readOk = ::ReadFile(handle, chunk, static_cast<DWORD>(sizeof chunk), &got, nullptr);

        std::lock_guard<std::mutex> lock(inMutex_);
        if (stopping_) return;

        if (!readOk || got == 0) {
            // The app closed stdin. CONTRACT 2 / A7: the engine follows it down.
            eof_ = true;
            inCv_.notify_all();
            return;
        }
        inBuffer_.append(chunk, got);
        inCv_.notify_all();
    }
}

bool Io::extractLineLocked(std::string& out) {
    const size_t pos = inBuffer_.find('\n');
    if (pos == std::string::npos) return false;
    out.assign(inBuffer_, 0, pos);
    inBuffer_.erase(0, pos + 1);
    if (!out.empty() && out.back() == '\r') out.pop_back();
    return true;
}

bool Io::pollLine(std::string& out, int timeoutMs) {
    std::unique_lock<std::mutex> lock(inMutex_);
    if (extractLineLocked(out)) return true;
    if (eof_) return false;

    if (timeoutMs < 0) {
        inCv_.wait(lock, [this] { return eof_ || inBuffer_.find('\n') != std::string::npos; });
        return extractLineLocked(out);
    }

    inCv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                   [this] { return eof_ || inBuffer_.find('\n') != std::string::npos; });
    return extractLineLocked(out);
}

bool Io::readLine(std::string& out) {
    return pollLine(out, -1);
}

bool Io::stdinClosed() const {
    std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(inMutex_));
    return eof_;
}

void Io::emit(const Json& frame, std::size_t reserveHint) {
    std::string line = frame.dump(reserveHint);
    line += '\n';
    std::lock_guard<std::mutex> lock(outMutex_);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);            // the app is blocked on this line
}

void Io::log(const char* level, const std::string& message) {
    std::fprintf(stderr, "[%s] %s\n", level, message.c_str());
    std::fflush(stderr);
}

} // namespace te