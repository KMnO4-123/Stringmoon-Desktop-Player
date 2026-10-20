#pragma once
// Twilight Echo - minimal JSON for the engine <-> app protocol (CONTRACT §3).
//
// Design goals, in order:
//   1. UTF-8 in / UTF-8 out. Non-ASCII is NEVER escaped on output -- every path
//      in this project contains Chinese, and some filenames carry combining
//      marks and runs of several spaces.
//   2. Object member order is preserved, so a frame serialises to identical
//      bytes every time (diffable stderr logs, stable driver assertions).
//   3. Parsing reports failure by return value, not exceptions.
//   4. Header-only, zero dependencies.
//
// Deliberately not general-purpose: no comments, no NaN/Inf. That is
// everything the frozen protocol in CONTRACT §3 needs.

#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <system_error>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace te {

class Json {
public:
    enum class Type : uint8_t { Null, Bool, Number, String, Array, Object };

    using Array  = std::vector<Json>;
    using Member = std::pair<std::string, Json>;
    using Object = std::vector<Member>;   // insertion-ordered

    Json() = default;
    Json(std::nullptr_t) {}
    Json(bool v)               : type_(Type::Bool),   bool_(v) {}
    Json(int v)                : type_(Type::Number), num_(double(v)), isInt_(true), i64_(v) {}
    Json(long long v)          : type_(Type::Number), num_(double(v)), isInt_(true), i64_(v) {}
    Json(unsigned v)           : type_(Type::Number), num_(double(v)), isInt_(true), i64_(v) {}
    Json(unsigned long long v) : type_(Type::Number), num_(double(v)), isInt_(true), i64_(long long(v)) {}
    Json(double v)             : type_(Type::Number), num_(v) {}
    Json(const char* s)        : type_(Type::String), str_(s ? s : "") {}
    Json(std::string s)        : type_(Type::String), str_(std::move(s)) {}
    Json(std::string_view s)   : type_(Type::String), str_(s) {}

    static Json array()  { Json j; j.type_ = Type::Array;  return j; }
    static Json object() { Json j; j.type_ = Type::Object; return j; }

    Type type()     const { return type_; }
    bool isNull()   const { return type_ == Type::Null; }
    bool isBool()   const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray()  const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    // ---- readers (permissive: a wrong type yields the supplied fallback) ----
    bool        asBool(bool d = false)   const { return type_ == Type::Bool ? bool_ : d; }
    long long   asInt(long long d = 0)   const {
        if (type_ != Type::Number) return d;
        return isInt_ ? i64_ : (long long)(num_ < 0 ? num_ - 0.5 : num_ + 0.5);
    }
    double      asDouble(double d = 0.0) const { return type_ == Type::Number ? num_ : d; }
    std::string asString(const std::string& d = std::string()) const {
        return type_ == Type::String ? str_ : d;
    }

    // ---- array accessors ----
    const Array& arr() const { static const Array empty; return type_ == Type::Array ? arr_ : empty; }
    Array&       arr()       { if (type_ != Type::Array) { type_ = Type::Array; arr_.clear(); } return arr_; }
    const Object& obj() const { static const Object empty; return type_ == Type::Object ? obj_ : empty; }
    Object&      obj()       { if (type_ != Type::Object) { type_ = Type::Object; obj_.clear(); } return obj_; }

    // ---- object accessors ----
    const Json* find(std::string_view key) const {
        if (type_ != Type::Object) return nullptr;
        for (const auto& m : obj_) if (m.first == key) return &m.second;
        return nullptr;
    }
    bool has(std::string_view key) const { return find(key) != nullptr; }

    Json& set(std::string key, Json v) {
        if (type_ != Type::Object) { type_ = Type::Object; obj_.clear(); }
        for (auto& m : obj_) if (m.first == key) { m.second = std::move(v); return m.second; }
        obj_.emplace_back(std::move(key), std::move(v));
        return obj_.back().second;
    }
    void push(Json v) {
        if (type_ != Type::Array) { type_ = Type::Array; arr_.clear(); }
        arr_.push_back(std::move(v));
    }

    // ------------------------------------------------------------------
    // Serialisation
    // ------------------------------------------------------------------
    void dump(std::string& out) const {
        switch (type_) {
        case Type::Null:   out += "null"; break;
        case Type::Bool:   out += bool_ ? "true" : "false"; break;
        case Type::Number: dumpNumber(out); break;
        case Type::String: dumpString(out, str_); break;
        case Type::Array:
            out += '[';
            for (size_t i = 0; i < arr_.size(); ++i) { if (i) out += ','; arr_[i].dump(out); }
            out += ']';
            break;
        case Type::Object:
            out += '{';
            for (size_t i = 0; i < obj_.size(); ++i) {
                if (i) out += ',';
                dumpString(out, obj_[i].first);
                out += ':';
                obj_[i].second.dump(out);
            }
            out += '}';
            break;
        }
    }
    std::string dump() const { std::string s; s.reserve(512); dump(s); return s; }
    // 体积已知时（meter 帧）预分配，省掉一到两次"写满再翻倍"的拷贝。
    std::string dump(std::size_t reserveHint) const {
        std::string s;
        s.reserve(reserveHint);
        dump(s);
        return s;
    }

    // ------------------------------------------------------------------
    // Parsing - returns nullopt on malformed input (trailing garbage included)
    // ------------------------------------------------------------------
    static std::optional<Json> parse(std::string_view in) {
        Parser p{in, 0};
        p.skipWs();
        auto v = p.value(0);
        if (!v) return std::nullopt;
        p.skipWs();
        if (p.i != in.size()) return std::nullopt;
        return v;
    }

private:
    struct Parser {
        std::string_view s;
        size_t i;

        void skipWs() {
            while (i < s.size()) {
                char c = s[i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++i; else break;
            }
        }
        bool lit(std::string_view w) {
            if (s.size() - i < w.size()) return false;
            if (s.compare(i, w.size(), w) != 0) return false;
            i += w.size();
            return true;
        }

        std::optional<Json> value(int depth) {
            if (depth > 64) return std::nullopt;              // hostile nesting guard
            skipWs();
            if (i >= s.size()) return std::nullopt;
            char c = s[i];
            if (c == 'n') return lit("null")  ? std::optional<Json>(Json()) : std::nullopt;
            if (c == 't') return lit("true")  ? std::optional<Json>(Json(true)) : std::nullopt;
            if (c == 'f') return lit("false") ? std::optional<Json>(Json(false)) : std::nullopt;
            if (c == '"') { auto str = string(); return str ? std::optional<Json>(Json(std::move(*str))) : std::nullopt; }
            if (c == '[') return array(depth);
            if (c == '{') return object(depth);
            return number();
        }

        std::optional<Json> array(int depth) {
            ++i;
            Json a = Json::array();
            skipWs();
            if (i < s.size() && s[i] == ']') { ++i; return a; }
            for (;;) {
                auto v = value(depth + 1);
                if (!v) return std::nullopt;
                a.push(std::move(*v));
                skipWs();
                if (i >= s.size()) return std::nullopt;
                if (s[i] == ',') { ++i; continue; }
                if (s[i] == ']') { ++i; return a; }
                return std::nullopt;
            }
        }

        std::optional<Json> object(int depth) {
            ++i;
            Json o = Json::object();
            skipWs();
            if (i < s.size() && s[i] == '}') { ++i; return o; }
            for (;;) {
                skipWs();
                if (i >= s.size() || s[i] != '"') return std::nullopt;
                auto key = string();
                if (!key) return std::nullopt;
                skipWs();
                if (i >= s.size() || s[i] != ':') return std::nullopt;
                ++i;
                auto v = value(depth + 1);
                if (!v) return std::nullopt;
                o.set(std::move(*key), std::move(*v));
                skipWs();
                if (i >= s.size()) return std::nullopt;
                if (s[i] == ',') { ++i; continue; }
                if (s[i] == '}') { ++i; return o; }
                return std::nullopt;
            }
        }

        static void utf8Append(std::string& out, uint32_t cp) {
            if (cp <= 0x7Fu) {
                out += (char)cp;
            } else if (cp <= 0x7FFu) {
                out += (char)(0xC0u | (cp >> 6));
                out += (char)(0x80u | (cp & 0x3Fu));
            } else if (cp <= 0xFFFFu) {
                out += (char)(0xE0u | (cp >> 12));
                out += (char)(0x80u | ((cp >> 6) & 0x3Fu));
                out += (char)(0x80u | (cp & 0x3Fu));
            } else {
                out += (char)(0xF0u | (cp >> 18));
                out += (char)(0x80u | ((cp >> 12) & 0x3Fu));
                out += (char)(0x80u | ((cp >> 6) & 0x3Fu));
                out += (char)(0x80u | (cp & 0x3Fu));
            }
        }

        bool hex4(uint32_t& out) {
            if (s.size() - i < 4) return false;
            uint32_t v = 0;
            for (int k = 0; k < 4; ++k) {
                char c = s[i + k];
                v <<= 4;
                if      (c >= '0' && c <= '9') v |= uint32_t(c - '0');
                else if (c >= 'a' && c <= 'f') v |= uint32_t(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') v |= uint32_t(c - 'A' + 10);
                else return false;
            }
            i += 4;
            out = v;
            return true;
        }

        std::optional<std::string> string() {
            ++i;
            std::string out;
            for (;;) {
                if (i >= s.size()) return std::nullopt;
                unsigned char c = (unsigned char)s[i];
                if (c == '"') { ++i; return out; }
                if (c == '\\') {
                    ++i;
                    if (i >= s.size()) return std::nullopt;
                    char e = s[i++];
                    if      (e == '"')  out += '"';
                    else if (e == '\\') out += '\\';
                    else if (e == '/')  out += '/';
                    else if (e == 'b')  out += '\b';
                    else if (e == 'f')  out += '\f';
                    else if (e == 'n')  out += '\n';
                    else if (e == 'r')  out += '\r';
                    else if (e == 't')  out += '\t';
                    else if (e == 'u') {
                        uint32_t cp = 0;
                        if (!hex4(cp)) return std::nullopt;
                        if (cp >= 0xD800u && cp <= 0xDBFFu) {          // high surrogate
                            bool paired = false;
                            if (s.size() - i >= 6 && s[i] == '\\' && s[i + 1] == 'u') {
                                size_t save = i;
                                i += 2;
                                uint32_t lo = 0;
                                if (hex4(lo) && lo >= 0xDC00u && lo <= 0xDFFFu) {
                                    cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
                                    paired = true;
                                } else {
                                    i = save;
                                }
                            }
                            if (!paired) cp = 0xFFFDu;                // lone high surrogate
                        } else if (cp >= 0xDC00u && cp <= 0xDFFFu) {   // lone low surrogate
                            cp = 0xFFFDu;
                        }
                        utf8Append(out, cp);
                    } else {
                        return std::nullopt;
                    }
                    continue;
                }
                if (c < 0x20) return std::nullopt;      // raw control char inside a string
                out += (char)c;                          // raw UTF-8 passthrough
                ++i;
            }
        }

        std::optional<Json> number() {
            size_t start = i;
            if (i < s.size() && s[i] == '-') ++i;
            bool any = false, isInt = true;
            size_t intDigits = 0;
            bool   leadingZero = false;
            while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
                if (intDigits == 0 && s[i] == '0') leadingZero = true;
                ++intDigits;
                ++i;
                any = true;
            }
            // "01" is not a JSON number; strictness here keeps a malformed app
            // frame from being silently reinterpreted.
            if (leadingZero && intDigits > 1) return std::nullopt;
            if (i < s.size() && s[i] == '.') {
                isInt = false;
                ++i;
                while (i < s.size() && s[i] >= '0' && s[i] <= '9') { ++i; any = true; }
            }
            if (!any) return std::nullopt;
            if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
                isInt = false;
                ++i;
                if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
                bool expAny = false;
                while (i < s.size() && s[i] >= '0' && s[i] <= '9') { ++i; expAny = true; }
                if (!expAny) return std::nullopt;
            }
            std::string tmp(s.substr(start, i - start));
            Json j;
            j.type_ = Type::Number;
            j.num_  = std::strtod(tmp.c_str(), nullptr);
            if (isInt) {
                errno = 0;
                char* end = nullptr;
                long long v = std::strtoll(tmp.c_str(), &end, 10);
                if (errno == 0 && end && *end == '\0') { j.isInt_ = true; j.i64_ = v; }
            }
            return j;
        }
    };

    // 数字写出走 std::to_chars 的最短往返表示，而不是 snprintf("%.*g") + strtod 校验。
    //
    // 为什么：这是 meter 事件的成本大头。MSVC 14.51 /O2 实测（bench_hot.cpp）：
    // 旧实现 1.130 µs/个数字，to_chars 最短往返 0.028 µs/个 —— 40 倍。一帧 meter
    // 约 190 个数字、60 帧/秒，旧实现单这一项就吃掉约 1.3% 单核。
    //
    // 语义不变：两者都输出"能唯一还原这个 double 的最短十进制"，都是合法 JSON 数字；
    // 差别只是旧实现从 15 位有效数字起试、新实现从真正的最短位数起算，所以新输出有时
    // 更短（对 IPC 是收益），先 dump 再 parse 得到的是逐位相同的 double
    // （bench_hot 里有随机/边界值的逐位相等校验）。整数分支同理，to_string 换成
    // to_chars 只为省掉一次堆分配。
    //
    // 非有限值仍然写 null：协议不接受 NaN/Inf，而 to_chars 会写出 "nan"/"inf"
    // 这种非法 JSON 字面量。
    void dumpNumber(std::string& out) const {
        if (isInt_) {
            char buf[24];
            const auto result = std::to_chars(buf, buf + sizeof buf, i64_);
            out.append(buf, result.ptr);
            return;
        }
        if (!std::isfinite(num_)) { out += "null"; return; }   // the protocol never carries NaN
        char buf[40];
        const auto result = std::to_chars(buf, buf + sizeof buf, num_);
        if (result.ec != std::errc()) { out += "null"; return; }   // 40 字节对 double 最短表示足够
        out.append(buf, result.ptr);
    }

    static void dumpString(std::string& out, std::string_view v) {
        out += '"';
        for (unsigned char c : v) {
            if      (c == '"')  out += "\\\"";
            else if (c == '\\') out += "\\\\";
            else if (c == '\b') out += "\\b";
            else if (c == '\f') out += "\\f";
            else if (c == '\n') out += "\\n";
            else if (c == '\r') out += "\\r";
            else if (c == '\t') out += "\\t";
            else if (c < 0x20) {
                char esc[8];
                std::snprintf(esc, sizeof esc, "\\u%04x", (unsigned)c);
                out += esc;
            } else {
                out += (char)c;                 // UTF-8 passthrough, never escaped
            }
        }
        out += '"';
    }

    Type        type_  = Type::Null;
    bool        bool_  = false;
    bool        isInt_ = false;
    long long   i64_   = 0;
    double      num_   = 0.0;
    std::string str_;
    Array       arr_;
    Object      obj_;
};

} // namespace te