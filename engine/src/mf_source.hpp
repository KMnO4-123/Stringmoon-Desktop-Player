#pragma once
// mf_source.hpp -- 系统解码兜底：IMFSourceReader 通用源 + 能力矩阵（CR-032）。
//
// 为什么需要它：MP4（AAC/ALAC）已经用 MF 解了（mp4_source.cpp），同一个
// IMFSourceReader 还能解 Windows 自带的其它解码器（WMA / AC-3 / Opus ...）。
// 把这些接进来是"零新依赖"的扩容：不加 third_party、不加 DLL、不引 FFmpeg。
//
// 边界（有意为之）：
//   * 只接本地文件。HTTP 流继续走既有 MediaReader 路径；把 MF 的 URL 源接进
//     播放链等于在引擎里放第二套传输层（Range/重定向/鉴权语义都不同）。
//   * 只在原生解码器（FLAC/WAV/MP3/Ogg/MP4）全部失败后兜底。原生路径的输出
//     必须逐样本不变——这是默认行为等价的硬要求，也是 --probe-format 能验的。
//   * lossless 走白名单：认不出的 codec 一律报 lossy。把有损报成 lossless 会让
//     state.sourceExact 撒谎，而这个方向的错误无法向用户解释。
//
// 本头不包含任何 MF 头：调用方（audio_source.cpp / app.cpp / probe）只看到
// 能力枚举与一个 AudioSource 工厂。windows.h 的宏污染留在 .cpp 里。
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace te {

class AudioSource;

// 解码能力类别：native = 引擎自带解码器（dr_libs / stb_vorbis / 自写）；
// system = Windows 提供的 Media Foundation 源/解码器；dsd = 1-bit 源经抽取转 PCM。
enum class DecoderKind { Native, System, Dsd };

struct DecoderCapability {
    std::string ext;            // 小写、带点：".flac"
    std::string label;          // 人读名字："FLAC"
    DecoderKind kind = DecoderKind::Native;
    bool        lossless = false;
    bool        available = true;   // false = 本机确实没有这条解码链（如实报告，不猜）
};

// 能力矩阵（CR-032）。顺序固定：native → system → dsd，客户端按顺序分组即可。
// available 字段是"本机实测"不是"平台应该有"：system 项由 MFTEnumEx 枚举判定。
std::vector<DecoderCapability> decoderCapabilities();

// 用 IMFSourceReader 打开一个本地文件。成功返回非空；失败返回 nullptr 并填 error。
// 时长取不到时返回失败：totalFrames 驱动 EOS，0 会让每首歌一打开就被判为已结束。
//
// label 只影响错误文案与 stderr 的那行诊断（"MP4" 与 "system decoder" 对用户
// 是两件不同的事：一个是容器路径、一个是兜底路径）。唯一实现是
// openMfContainerSource()，openMfSource() 只是它的兜底标签版本。
std::unique_ptr<AudioSource> openMfSource(const std::filesystem::path& file,
                                          std::string& error);
std::unique_ptr<AudioSource> openMfContainerSource(const std::filesystem::path& file,
                                                   std::string& error, const char* label);

// 线上拼写（CR-032 的 decoders[].kind）。
const char* decoderKindName(DecoderKind kind);

// MF 运行时（进程级一次）。mp4_source.cpp 的 MP4 路径与这里的兜底共用同一份，
// 所以 MFStartup/MFShutdown 永远成对且只发生一次。
bool ensureMediaFoundation(std::string& error);
bool mediaFoundationAvailable();

} // namespace te
