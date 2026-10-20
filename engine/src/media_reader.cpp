#include "media_reader.hpp"
#include "util.hpp"
#include <windows.h>
#include <winhttp.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string_view>
#include <utility>

namespace te {
namespace {
struct HttpHandle {
    HINTERNET value = nullptr;
    ~HttpHandle() { if (value) ::WinHttpCloseHandle(value); }
};
std::string lastHttpError() { return "WinHTTP error " + std::to_string(::GetLastError()); }
std::wstring header(HINTERNET request, DWORD query) {
    DWORD bytes = 0;
    ::WinHttpQueryHeaders(request, query, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &bytes, WINHTTP_NO_HEADER_INDEX);
    // Headers are metadata, never a reason for an unbounded allocation.
    if (bytes == 0 || bytes > 16384) return {};
    std::wstring result(bytes / sizeof(wchar_t), L'\0');
    if (!::WinHttpQueryHeaders(request, query, WINHTTP_HEADER_NAME_BY_INDEX, result.data(), &bytes, WINHTTP_NO_HEADER_INDEX)) return {};
    result.resize(bytes / sizeof(wchar_t));
    while (!result.empty() && result.back() == L'\0') result.pop_back();
    return result;
}
bool decimal(std::wstring_view text, uint64_t& value) {
    if (text.empty()) return false;
    value = 0;
    for (wchar_t c : text) {
        if (c < L'0' || c > L'9') return false;
        const unsigned digit = static_cast<unsigned>(c - L'0');
        if (value > (std::numeric_limits<uint64_t>::max() - digit) / 10) return false;
        value = value * 10 + digit;
    }
    return true;
}
bool parseRange(std::wstring_view text, uint64_t& start, uint64_t& end, uint64_t& total) {
    if (!text.starts_with(L"bytes ")) return false;
    text.remove_prefix(6);
    const auto dash = text.find(L'-'), slash = text.find(L'/');
    return dash != text.npos && slash != text.npos && dash < slash &&
        decimal(text.substr(0, dash), start) &&
        decimal(text.substr(dash + 1, slash - dash - 1), end) &&
        decimal(text.substr(slash + 1), total) && start <= end && end < total &&
        total <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max());
}
} // namespace

struct MediaReader::Impl {
    std::FILE* file = nullptr;
    HINTERNET session = nullptr, connection = nullptr;
    std::wstring requestPath;
    bool secure = false, failed = false;
    uint64_t length = 0, position = 0, cacheStart = 0;
    std::vector<uint8_t> cache;
    std::wstring validator;
    DWORD validatorQuery = WINHTTP_QUERY_ETAG;
    std::string error;
    ~Impl() {
        if (file) std::fclose(file);
        if (connection) ::WinHttpCloseHandle(connection);
        if (session) ::WinHttpCloseHandle(session);
    }
    bool fail(std::string reason) { failed = true; error = std::move(reason); return false; }

    bool fetch(uint64_t start, uint64_t end, std::vector<uint8_t>& body, uint64_t& total) {
        HttpHandle request{::WinHttpOpenRequest(connection, L"GET", requestPath.c_str(), nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0)};
        if (!request.value) return fail(lastHttpError());
        std::wstring headers = L"Accept-Encoding: identity\r\nRange: bytes=" +
            std::to_wstring(start) + L"-" + std::to_wstring(end) + L"\r\n";
        if (!validator.empty()) headers += L"If-Range: " + validator + L"\r\n";
        if (!::WinHttpSendRequest(request.value, headers.c_str(), static_cast<DWORD>(headers.size()),
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) || !::WinHttpReceiveResponse(request.value, nullptr))
            return fail("HTTP Range request failed: " + lastHttpError());
        DWORD status = 0, statusBytes = sizeof(status);
        if (!::WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusBytes, WINHTTP_NO_HEADER_INDEX))
            return fail("HTTP response had no status code");
        if (status != 206)
            return fail("HTTP server did not honor Range (status " + std::to_string(status) + ")");
        const auto encoding = header(request.value, WINHTTP_QUERY_CONTENT_ENCODING);
        if (!encoding.empty() && encoding != L"identity") return fail("HTTP byte stream used a content encoding");

        uint64_t expected = 0;
        const auto range = header(request.value, WINHTTP_QUERY_CONTENT_RANGE);
        const auto contentLength = header(request.value, WINHTTP_QUERY_CONTENT_LENGTH);
        if (status == 206) {
            uint64_t first = 0, last = 0;
            if (!parseRange(range, first, last, total) || first != start ||
                last != std::min(end, total - 1)) return fail("HTTP Content-Range does not match requested bytes");
            expected = last - first + 1;
        }
        uint64_t declared = 0;
        if (!contentLength.empty() && (!decimal(contentLength, declared) || declared != expected))
            return fail("HTTP Content-Length disagrees with byte range");
        if (expected > kHttpWindowBytes) return fail("HTTP Range exceeded cache limit");
        if (length != 0 && total != length) return fail("HTTP resource length changed during playback");
        if (!validator.empty() && header(request.value, validatorQuery) != validator)
            return fail("HTTP resource identity changed during playback");
        if (length == 0) {
            validator = header(request.value, WINHTTP_QUERY_ETAG);
            if (validator.starts_with(L"W/")) validator.clear();
            if (validator.empty()) {
                validatorQuery = WINHTTP_QUERY_LAST_MODIFIED;
                validator = header(request.value, validatorQuery);
            }
        }
        body.resize(static_cast<size_t>(expected));
        size_t filled = 0;
        while (filled < body.size()) {
            DWORD got = 0;
            if (!::WinHttpReadData(request.value, body.data() + filled, static_cast<DWORD>(body.size() - filled), &got))
                return fail("HTTP body read failed: " + lastHttpError());
            if (got == 0) return fail("HTTP Range response was short");
            filled += got;
        }
        // Read at most one extra byte to detect overlong chunked bodies without
        // ever resizing the cache from server-controlled data-available values.
        uint8_t extra = 0;
        DWORD got = 0;
        if (!::WinHttpReadData(request.value, &extra, 1, &got)) return fail("HTTP body read failed: " + lastHttpError());
        if (got != 0) return fail("HTTP Range response was overlong");
        return true;
    }

    bool open(const std::filesystem::path& target) {
        const auto text = toUtf8(target), lower = toLowerAscii(text);
        if (!lower.starts_with("http://") && !lower.starts_with("https://")) {
            file = ::_wfopen(target.c_str(), L"rb");
            if (!file) return fail("cannot open local audio file");
            if (_fseeki64(file, 0, SEEK_END) != 0) return fail("cannot size local audio file");
            const auto size = _ftelli64(file);
            if (size <= 0 || _fseeki64(file, 0, SEEK_SET) != 0) return fail("empty or unseekable audio file");
            length = static_cast<uint64_t>(size);
            return true;
        }
        const auto url = fromUtf8(text).wstring();
        URL_COMPONENTS parts{};
        parts.dwStructSize = sizeof(parts);
        parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = static_cast<DWORD>(-1);
        if (!::WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) return fail(lastHttpError());
        if (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS)
            return fail("unsupported URL scheme");
        const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
        if (parts.dwUrlPathLength) requestPath.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
        if (requestPath.empty()) requestPath = L"/";
        if (parts.dwExtraInfoLength) requestPath.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
        const auto fragment = requestPath.find(L'#');
        if (fragment != requestPath.npos) requestPath.resize(fragment);
        secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
        session = ::WinHttpOpen(L"TwilightEcho/0.1", WINHTTP_ACCESS_TYPE_NO_PROXY,
            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!session) return fail(lastHttpError());
        if (!::WinHttpSetTimeouts(session, 3000, 3000, 3000, 3000)) return fail(lastHttpError());
        connection = ::WinHttpConnect(session, host.c_str(), parts.nPort, 0);
        if (!connection) return fail(lastHttpError());
        uint64_t total = 0;
        if (!fetch(0, kHttpWindowBytes - 1, cache, total)) return false;
        length = total;
        return true;
    }
    size_t read(void* out, size_t bytes) {
        if (failed || !out || bytes == 0 || position >= length) return 0;
        if (file) {
            const auto got = std::fread(out, 1, bytes, file);
            position += got;
            if (std::ferror(file)) fail("local audio file read failed");
            else if (got < bytes && position < length) fail("local audio file ended before its declared length");
            return failed ? 0 : got;
        }
        const size_t wanted = static_cast<size_t>(std::min<uint64_t>(bytes, length - position));
        size_t copied = 0;
        while (copied < wanted) {
            if (position < cacheStart || position - cacheStart >= cache.size()) {
                const auto end = position + std::min<uint64_t>(kHttpWindowBytes, length - position) - 1;
                uint64_t total = 0;
                // Fixed capacity, even when the decoder requests several windows.
                if (!fetch(position, end, cache, total)) return 0;
                cacheStart = position;
            }
            const size_t offset = static_cast<size_t>(position - cacheStart);
            const size_t count = std::min(wanted - copied, cache.size() - offset);
            std::memcpy(static_cast<uint8_t*>(out) + copied, cache.data() + offset, count);
            copied += count;
            position += count;
        }
        return copied;
    }
    bool seek(int64_t offset, int origin) {
        if (failed || origin < 0 || origin > 2) return false;
        const uint64_t base = origin == 0 ? 0 : origin == 1 ? position : length;
        uint64_t target = 0;
        if (offset < 0) {
            const auto distance = static_cast<uint64_t>(-(offset + 1)) + 1;
            if (distance > base) return false;
            target = base - distance;
        } else {
            if (static_cast<uint64_t>(offset) > length - base) return false;
            target = base + static_cast<uint64_t>(offset);
        }
        if (file && _fseeki64(file, static_cast<int64_t>(target), SEEK_SET) != 0) return fail("local audio file seek failed");
        position = target;
        return true;
    }
};

MediaReader::MediaReader(ReaderTrace* trace) : trace_(trace) {}
MediaReader::~MediaReader() = default;
MediaReader::MediaReader(MediaReader&&) noexcept = default;
MediaReader& MediaReader::operator=(MediaReader&&) noexcept = default;
bool MediaReader::open(const std::filesystem::path& target) {
    impl_ = std::make_unique<Impl>();
    return impl_->open(target);
}
size_t MediaReader::read(void* out, size_t bytes) {
    const auto got = impl_ ? impl_->read(out, bytes) : 0;
    if (trace_) {
        ++trace_->readCalls; trace_->bytesRequested += bytes; trace_->bytesReturned += got;
        if (got < bytes) ++trace_->shortReads;
        trace_->maxReadRequest = std::max(trace_->maxReadRequest, bytes);
        if (trace_->readRequestSizes.size() < 4096) {
            trace_->readRequestSizes.push_back(bytes); trace_->readReturnSizes.push_back(got);
        }
    }
    return got;
}
bool MediaReader::seek(int64_t offset, int origin) {
    if (trace_) ++trace_->seekCalls;
    return impl_ && impl_->seek(offset, origin);
}
int64_t MediaReader::tell() const {
    if (trace_) ++trace_->tellCalls;
    return impl_ ? static_cast<int64_t>(impl_->position) : -1;
}
uint64_t MediaReader::size() const { return impl_ ? impl_->length : 0; }
bool MediaReader::hasError() const { return impl_ && impl_->failed; }
std::string MediaReader::errorMessage() const { return impl_ ? impl_->error : std::string(); }
void MediaReader::close() { impl_.reset(); }
} // namespace te
