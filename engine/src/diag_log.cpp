#include "diag_log.hpp"

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <system_error>
#include <string>
#include <vector>

#include "util.hpp"

namespace te {
namespace {

// 512 KB holds tens of thousands of records; a session produces a handful.
constexpr long long kCapBytes = 512 * 1024;
constexpr long long kKeepBytes = 256 * 1024;

std::mutex  g_mutex;
std::FILE*  g_file = nullptr;
bool        g_tried = false;
std::string g_path;
long long   g_written = 0;

// 用宽字符路径打开日志文件。
//
// 为什么不能直接用 std::fopen：g_path 是 UTF-8 字节串，而窄字符 fopen 会按
// 当前 ANSI 代码页解释它。安装路径一旦含非 ASCII（中文用户名、
// %LOCALAPPDATA% 下的中文目录），fopen 会静默失败——实测中文路径下 diag log
// 永远不生成且不报错。Windows 上统一走 _wfopen；日志格式/512KB 上限/压缩策略
// 都不变。非 Windows 分支保留原实现（本工程只支持 Windows，分支只为可读性）。
std::FILE* openLogFile(const char* mode) {
#ifdef _WIN32
    const std::wstring widePath = fromUtf8(g_path).wstring();
    wchar_t wideMode[8] = {};
    for (std::size_t i = 0; i < 7 && mode[i] != '\0'; ++i) {
        wideMode[i] = static_cast<wchar_t>(mode[i]);
    }
    return ::_wfopen(widePath.c_str(), wideMode);
#else
    return std::fopen(g_path.c_str(), mode);
#endif
}

std::string executableDir() {
    wchar_t buffer[MAX_PATH] = {};
    const DWORD n = ::GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    if (n == 0) return std::string();
    const std::filesystem::path exe(std::wstring(buffer, n));
    return toUtf8(exe.parent_path());
}

std::string timestamp() {
    SYSTEMTIME st;
    ::GetLocalTime(&st);
    char buf[40];
    std::snprintf(buf, sizeof buf, "%04u-%02u-%02u %02u:%02u:%02u.%03u",
                  st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    return buf;
}

// Keeps only the newest kKeepBytes of the file and reports how many bytes that
// is. Read-then-rewrite is deliberate: the alternative (start a fresh file) is
// what makes a diagnostic useless exactly when it is needed, because the fault
// that filled the previous file is the one being investigated.
long long compactLocked() {
    std::FILE* in = openLogFile("rb");
    if (!in) return 0;
    std::fseek(in, 0, SEEK_END);
    const long long size = std::ftell(in);
    if (size <= 0) { std::fclose(in); return 0; }

    const long long start = size > kKeepBytes ? size - kKeepBytes : 0;
    std::vector<char> tail(static_cast<size_t>(size - start));
    std::fseek(in, static_cast<long>(start), SEEK_SET);
    const size_t got = std::fread(tail.data(), 1, tail.size(), in);
    std::fclose(in);
    tail.resize(got);

    // Drop a partial first line so the file stays line-oriented.
    size_t begin = 0;
    if (start > 0) {
        const auto newline = std::find(tail.begin(), tail.end(), '\n');
        begin = (newline == tail.end()) ? tail.size() : static_cast<size_t>(newline - tail.begin()) + 1;
    }

    std::FILE* out = openLogFile("wb");
    if (!out) return 0;
    const long long kept = static_cast<long long>(tail.size() - begin);
    if (kept > 0) std::fwrite(tail.data() + begin, 1, static_cast<size_t>(kept), out);
    std::fclose(out);
    return kept;
}

bool openLocked() {
    if (g_tried) return g_file != nullptr;
    g_tried = true;

    const std::string dir = executableDir();
    if (dir.empty()) return false;
    g_path = dir + "\\twilight-engine-diag.log";

    std::error_code ec;
    const auto size = std::filesystem::file_size(g_path, ec);
    if (!ec && static_cast<long long>(size) > kCapBytes) {
        g_written = compactLocked();
    } else if (!ec) {
        g_written = static_cast<long long>(size);
    }

    g_file = openLogFile("ab");
    return g_file != nullptr;
}

} // namespace

void diagRecord(const char* category, const std::string& message) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!openLocked()) return;

    if (g_written > kCapBytes) {
        std::fclose(g_file);
        g_file = nullptr;
        g_written = compactLocked();
        g_file = openLogFile("ab");
        if (!g_file) return;
    }

    const std::string line = timestamp() + " " + category + " " + message + "\n";
    const size_t written = std::fwrite(line.data(), 1, line.size(), g_file);
    std::fflush(g_file);
    g_written += static_cast<long long>(written);
}

std::string diagLogPath() {
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_path;
}

void diagClose() {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_file) {
        std::fflush(g_file);
        std::fclose(g_file);
        g_file = nullptr;
    }
}

} // namespace te