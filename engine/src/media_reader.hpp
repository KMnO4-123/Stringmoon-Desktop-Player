#pragma once
// Blocking, seekable compressed bytes. Used only by decoder/control threads.
// A short read is EOF only when hasError() is false. Errors remain sticky until
// open(); seek never hides a transport failure. HTTP keeps one bounded window.
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace te {
struct ReaderTrace {
    uint64_t readCalls = 0, bytesRequested = 0, bytesReturned = 0;
    uint64_t shortReads = 0, seekCalls = 0, tellCalls = 0;
    size_t maxReadRequest = 0;
    std::vector<size_t> readRequestSizes, readReturnSizes;
};

class MediaReader {
public:
    static constexpr size_t kHttpWindowBytes = 256u * 1024u;
    explicit MediaReader(ReaderTrace* trace = nullptr);
    ~MediaReader();
    MediaReader(MediaReader&&) noexcept;
    MediaReader& operator=(MediaReader&&) noexcept;
    MediaReader(const MediaReader&) = delete;
    MediaReader& operator=(const MediaReader&) = delete;

    bool open(const std::filesystem::path& pathOrUrl);
    size_t read(void* out, size_t bytes);
    // origin: 0=beginning, 1=current position, 2=end. No network request.
    bool seek(int64_t offset, int origin);
    int64_t tell() const;
    uint64_t size() const;
    bool hasError() const;
    std::string errorMessage() const;
    void close();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    ReaderTrace* trace_ = nullptr;
};
} // namespace te
