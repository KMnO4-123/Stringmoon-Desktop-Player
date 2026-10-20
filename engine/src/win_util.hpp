#pragma once
// Windows-only helpers shared by device enumeration and the output backend.
// Kept in its own header so that <windows.h> never leaks into the protocol
// layer (json.hpp / io.hpp / catalog.hpp stay platform-free).

#include <windows.h>
#include <objbase.h>   // CoInitializeEx / COINIT_MULTITHREADED

#include <string>
#include <string_view>

namespace te {

inline std::string wideToUtf8(const wchar_t* w) {
    if (!w) return std::string();
    const int need = ::WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (need <= 1) return std::string();
    std::string out(static_cast<size_t>(need - 1), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), need, nullptr, nullptr);
    return out;
}

inline std::wstring utf8ToWide(std::string_view s) {
    if (s.empty()) return std::wstring();
    const int need = ::MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (need <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(need), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), need);
    return out;
}

inline std::string hresultToString(HRESULT hr) {
    char buf[64];
    ::wsprintfA(buf, "0x%08lX", static_cast<unsigned long>(hr));
    return buf;
}

// RAII COM apartment for a thread. Call on every thread that touches audio APIs
// (the control thread and the render thread both do).
class ComApartment {
public:
    explicit ComApartment(DWORD model = COINIT_MULTITHREADED) {
        hr_ = ::CoInitializeEx(nullptr, model);
        ok_ = SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE;   // already initialised is fine
    }
    ~ComApartment() {
        if (SUCCEEDED(hr_)) ::CoUninitialize();
    }
    ComApartment(const ComApartment&)            = delete;
    ComApartment& operator=(const ComApartment&) = delete;

    bool ok() const { return ok_; }
    HRESULT hr() const { return hr_; }

private:
    HRESULT hr_ = E_FAIL;
    bool    ok_ = false;
};

} // namespace te
