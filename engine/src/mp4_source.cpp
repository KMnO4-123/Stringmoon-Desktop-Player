// mp4_source.cpp -- MP4（AAC / ALAC）解码入口。
//
// 实现已经搬到 mf_source.cpp：同一个 IMFSourceReader 读者现在同时服务 MP4 与
// 系统解码兜底（Opus / WMA / AIFF / AC-3 ...）。搬家的理由写在那里，一句话是
// "用 IMFSourceReader 按块取 PCM"只该有一个实现 —— 否则关于 ALAC lossless
// 判定的那次修正只会落在其中一份拷贝上，两条路径随后会对同一个文件给出不同的
// state.sourceExact。
//
// 这个文件保留下来，是为了让 openMp4Source 的契约（"按 PATH 打开，不把容器
// 读进内存"）有一个明确的落点，而不是让调用方去猜它现在住在哪。
#include <filesystem>
#include <memory>
#include <string>

#include "audio_source.hpp"
#include "mf_source.hpp"

namespace te {

std::unique_ptr<AudioSource> openMp4Source(const std::filesystem::path& file,
                                           std::string& error) {
    return openMfContainerSource(file, error, "MP4");
}

} // namespace te
