# twilight-engine

Twilight Echo 的音频引擎。C++20，独立进程，通过 **JSON Lines over stdio** 与 Electron 应用通信。

> 版本：引擎与应用的版本号**独立演进**（当前引擎自报 `0.1.0`，应用 `0.4.0`）；
> 二者靠冻结的协议版本号（`protocol: 1`）对齐，不靠应用版本号推断引擎版本。

> 协议与边界由仓库根目录的 [CONTRACT.md](../CONTRACT.md) 冻结。本文件只讲**怎么构建、怎么跑、怎么自测**。
> 分工：本目录（**engine/**）是 AI-A 的，**不得进入 app/**；CONTRACT.md 与 docs/SPEC-v2.1.md 双方只读。

---

## 1. 构建

```powershell
# 一次性：拉齐第三方依赖（TagLib / utfcpp / dr_libs / soxr / libebur128 / kissfft）
powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1

# 构建
powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1
```

产物固定落在 **`engine/bin/twilight-engine.exe`**（单一固定路径，驱动脚本与应用都不必猜配置子目录）。

可选参数：

```powershell
... build.ps1 -Clean                      # 删掉 build/ 重新配置
... build.ps1 -Configuration Debug        # 默认 Release
... build.ps1 -Generator Ninja            # 见下方说明
```

### 关于生成器（本机实测，别踩）

- **默认用 Visual Studio 17 2022 生成器**。原因：本机 CMake 装在很深的 winget 路径下，Ninja 会把这些 CMake 模块文件当依赖去 stat，**路径超过 260 字符**（Windows MAX_PATH），Ninja 直接报
  `Filename longer than 260 characters` 并拒绝构建。MSBuild 不受影响。
- `-Generator Ninja` 保留可用；CMake 路径短的机器上它更快（Ninja 取 VS 自带的 `Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe`）。
- `cl.exe` 不在 PATH 上是**正常的**：脚本自己 source `vcvars64.bat`（Ninja 分支），或让 CMake 自己找（VS 分支）。

### 第三方依赖

| 依赖 | 版本 | 用途 | 许可 |
|---|---|---|---|
| [TagLib](https://github.com/taglib/taglib) | v2.3.2 | 读标签与音频属性 | LGPL-2.1 / MPL-1.1 |
| [utfcpp](https://github.com/nemtif/utfcpp) | v4.2.1 | TagLib 2.3+ 硬依赖 | BSL-1.0 |
| [dr_libs](https://github.com/mackron/dr_libs) | master | 解码：`dr_flac`（含 Ogg-FLAC）/ `dr_wav` / `dr_mp3`（MPEG-1 Layer III） | 公有领域 / MIT-0 |
| [stb_vorbis](https://github.com/nothings/stb) | v1.22 | Ogg **Vorbis** 解码（流媒体最常见的容器）。走 pushdata API + 自己做分页，因为它的 pull API 只收 `FILE*`，过不了 `MediaReader`（中文宽路径 / HTTP） | 公有领域（双许可 MIT） |
| [SoXR](https://github.com/chirlu/soxr) | 0.1.3 | 重采样（SPEC §2.6 点名）—— 不做它，本库 80/91 首在 48 kHz 设备上开不了 | LGPL-2.1 |
| [libebur128](https://github.com/jiixyj/libebur128) | v1.2.6 | EBU R128 响度测量（SPEC §2.6 点名）—— ReplayGain 的测量端 | MIT |
| [kissfft](https://github.com/mborgerding/kissfft) | master | 频谱表用的**实数** FFT（`kiss_fftr`）—— 只跑在**控制线程**，与 RT 线程无关 | BSD-3-Clause |
| *Media Foundation* | 随 Windows | AAC / ALAC 解码（`.m4a`）。**不是 vendored 依赖**，是 OS 组件，所以有一个诚实的前提：能力随机器而变 —— `--probe-mf` 就是用来把这件事说清楚的 | OS 组件 |

`fetch-deps.ps1` 不往系统里装任何东西（**`<系统工具目录>` 是只读 ACL**），全部落在 `engine/third_party/`。
本机 **raw.githubusercontent.com 不通**，所以逐个头文件下载走 `gh-proxy.com`；`codeload.github.com` 可直连。

---

## 2. 运行

```powershell
engine\bin\twilight-engine.exe            # 启动，第一条 stdout 是 ready
engine\bin\twilight-engine.exe --selftest # 协议编解码自检 + 离线黄金测试（频响 / dither / 响度 / 声道）
engine\bin\twilight-engine.exe --probe-exclusive  # 独占诊断：逐格式 × 逐缓冲，报设备是否真的发事件
engine\bin\twilight-engine.exe --probe-mf         # Media Foundation 有哪些音频编解码器（本机实测）
engine\bin\twilight-engine.exe --probe-mf --codec alac --write-tone x.m4a   # 用它造一个真 ALAC 文件
engine\bin\twilight-engine.exe --probe-io <file-or-http-url>                # dr_flac read/seek/tell 请求模式
engine\bin\twilight-engine.exe --probe-decode <file-or-http-url>            # 逐样本对照生产 reader 与内存参考
engine\bin\twilight-engine.exe --verify-media <local-file> <url>            # 本地/HTTP 字节、seek 与生产解码对照
engine\bin\twilight-engine.exe --probe-format <file...> [--full] [--seek <ms>]  # 生产解码路径的真实结果 + 样本
engine\bin\twilight-engine.exe --probe-ir <file.wav...>                     # 房间冲激响应能不能被卷积器吃下（走生产 reader 路径）
node engine/tools/test-http-reader.mjs <large-flac>                          # Range 故障矩阵与 FLAC/WAV/MP3 回归
node engine/tools/test-playback-silent.mjs <library-folder>                  # 静音设备播放生命周期回归
node engine/tools/test-ogg-decode.mjs                                       # Ogg Vorbis / Ogg-FLAC / Opus 拒绝
engine\bin\twilight-engine.exe --version
```

`--probe-format` 是「这个构建到底放不放得了这个文件」的**唯一**可追问入口：`isDecodable()` 把
一切原因压成一个 bool 加一个只有调用者看得到的字符串，MP3/MP4/Ogg 都是靠猜那个字符串 debug 的。
`--full` 解到结尾与声称长度对比；`--seek` 拿**独立重放**比样本，所以「seek 落点对不对」是可证的。

FLAC/WAV/MP3 的生产 reader 也接受 `http://` / `https://` URL。HTTP 路径使用
WinHTTP Range 请求和 256 KiB 预读窗口；seek 只移动逻辑偏移，不立即发请求。
远端服务必须返回总长度和有效的 `206 Content-Range`，否则 reader 会拒绝资源。
当前 `open` 的 JSON 入口仍只接受曲库 `trackId`；URL 入口见待裁定的 CR-016。
如果远端既不发送强 ETag 也不发送 Last-Modified，引擎可检测长度变化，但无法证明等长分段仍来自同一版本；
本地回环代理应为单次播放固定资源版本，或提供稳定校验器。每个 Range 响应最多缓存 256 KiB。
高保真与结构改进的分级队列见 [AUDIO-QUALITY-ROADMAP.md](AUDIO-QUALITY-ROADMAP.md)。

**能解的格式：FLAC、WAV、MP3、AAC（.m4a）、ALAC（.m4a）、Ogg Vorbis（.ogg/.oga）、Ogg FLAC（.ogg/.oga）**
—— SPEC §3.8 的 L1 是 5/5。Ogg 的两半是后来补的，见 [PROGRESS.md](PROGRESS.md) §0z4。

| 格式 | 解码器 | 性质 |
|---|---|---|
| FLAC / WAV | dr_flac / dr_wav | 无损（WAV 里的 ADPCM / A-law 是有损，`lossless()` 按 `translatedFormatTag` 判） |
| MP3 | dr_mp3 | 有损 |
| AAC (.m4a) | Media Foundation | 有损 |
| ALAC (.m4a) | Media Foundation | **无损** |
| Ogg **Vorbis** (.ogg/.oga) | stb_vorbis | 有损 |
| Ogg **FLAC** (.ogg/.oga) | dr_flac（同一份代码；Ogg 分页层由它自己剥） | **无损** |

⚠️ `.ogg` 是**容器**不是编码：同一个扩展名装 Vorbis（有损）或 Ogg-FLAC（无损），所以
`lossless()` 由 `sniffOggCodec()` 从文件头读出的编码决定，**不能按扩展名猜**——猜错一头会把
有损文件报成透明，猜错另一头会让人去查一个不存在的缺陷。
`.opus` 在扩展名白名单里但**本构建不解码**：它进 `unplayablePaths`，原因里**点名 Opus**。

容器是按**内容**认的，不是按扩展名：FLAC 与 WAV 靠魔数，MP4 靠偏移 4 处的 `ftyp`，
Ogg 靠 `OggS` 再往页里读编码标识（`\x01vorbis` / `\x7fFLAC` / `OpusHead`），
MP3 **没有魔数**（可能以 ID3 开头、可能直接是帧、可能什么都没有），所以它由解码器试着打开来决定。

⚠️ **MP4 是按路径打开的，不读进内存** —— 媒体库里就有 400–950 MB 的 `.mp4`，
而 SPEC §8.2 给整个引擎 60 MB。所以 `openAudioSource` 先读 16 字节头再选容器。
**未实现**：裸 ADTS `.aac`。

**运行时产生三个文件**（都在 exe 旁边）：

| 文件 | 是什么 |
|---|---|
| `bin/loudness-cache.json` | 响度扫描缓存（按路径+大小+修改时间失效） |
| `bin/twilight-engine-crash.dmp` | 只在崩溃时出现 |
| `bin/twilight-engine-diag.log` | **音频诊断记录**（SPEC §8 / 449）：xrun、缓冲史、设备变更史。有上限（超 512 KB 丢最旧的一半），由**控制线程**写 —— RT 线程按 SPEC §3.2 只允许改计数器 |

它不会自己出声，也不会自己退出 —— 它等 stdin 上的命令。按 CONTRACT 3.1：

- `stdin` = 命令流（JSON Lines）
- `stdout` = **只有 JSON Lines**（一行一条，绝无日志）
- `stderr` = 人类可读日志

**stdin 关闭即退出**（CONTRACT 2 / A7：应用退出后引擎进程不得残留）。

---

## 3. 自测

```powershell
node engine\tools\drive.mjs                    # 全部步骤
node engine\tools\drive.mjs --list             # 看看有哪些步骤
node engine\tools\drive.mjs --step=scan        # 只跑一步
node engine\tools\drive.mjs --export-fixture   # 顺带导出给 AI-B 的 fixture
```

当前 **23 个步骤**、本机全套 **462 条断言**全绿。

**RSS 与文件大小无关**（16–19 MB）：解码器读的是**文件句柄**，不是整个压缩文件的副本。
这一条曾经不成立 —— 46.5 MB 的曲子会冲到 75 MB，超过 SPEC §8.2 的 60 MB（见 PROGRESS §0p）。
只有一个回放端点时 `hotplug` 会如实跳过（少 8 条）。几个值得单独跑的：

```powershell
node engine\tools\drive.mjs --step=selftest    # 离线黄金测试（进程内，不碰音频）
node engine\tools\drive.mjs --step=contract    # 铁律：stdout 只有 JSON Lines、六个错误码、trackId 形状
node engine\tools\drive.mjs --step=dsp         # EQ / ReplayGain / bit-perfect 诚实性
node engine\tools\drive.mjs --step=exclusive   # 独占协商与诚实降级
node engine\tools\drive.mjs --step=completion  # 结尾不被截断（设备真正播完才算完）
node engine\tools\drive.mjs --step=honesty --export-trace   # 降级是否都说了、有没有虚报
node engine\tools\drive.mjs --step=bitperfect # 四字段一致性矩阵（容器比源精度宽 ⇒ 不是直通）
node engine\tools\drive.mjs --step=loudness   # EBU R128 扫描；含「专辑 ≠ 各曲均值」与缓存命中
node engine\tools\drive.mjs --step=session    # operationId：会话可辨认、暂停不换会话
node engine\tools\drive.mjs --step=channels   # 声道工具：balance / mono / width / swap / trim
node engine\tools\drive.mjs --step=formats    # L1 格式：真 MP3 / AAC / ALAC；有损文件永不 sourceExact
node engine\tools\drive.mjs --step=identity   # CR-013：目录换个写法仍是同一个曲库；replace 按目录替换
node engine\tools\drive.mjs --step=hotplug    # 真机切换默认输出，验证 device_changed（会改回原样）
node engine\tools\drive.mjs --step=lifecycle  # 退出无残留进程，且不留崩溃 dump
```

还有一个**不属于套件**的长时间压测（SPEC §9「30 min 独占最小缓冲 = 0 xrun」）：

```powershell
node engine\tools\soak.mjs                      # 默认 30 分钟，每 20 s 采一次样
node engine\tools\soak.mjs --minutes=2          # 冒烟用
```

它**故意不是 `drive.mjs` 的一个步骤**：三十分钟不是一个断言，是一班岗，而半小时的套件等于没人跑。
它同时读上面那个诊断日志，所以一次压测产出的是**证据**而不是结论。
```

`engine/fixtures/state-traces.json` 是给 B 侧渲染 C2 的**真实事件序列**，
**特意包含一次真实降级**——一份干净的 trace 会让「从不画降级路径」的界面拿真实数据通过自己的测试。

`--selftest` 里还有一层**不碰音频硬件**的黄金测试：10 段 EQ 的频响（CR-019 之后仍按 SPEC 网格 + 全局 Q 断言，证明参数化没有改变默认行为），
容差 ±0.1 dB（SPEC §447 的要求）。它测的是**频响**而不是「输出有没有变」——
后者对 a1 符号写错这类 bug 完全不敏感。

`drive.mjs` 是 **A 侧的"假应用"**（CONTRACT 9.1）：它 spawn 引擎、按契约喂命令、逐行解析 stdout。
它同时是验收工具 —— **任何一行 stdout 解析失败即判定失败**。

它用的真实测试库是 `<测试曲库>`（91 首 FLAC）。可覆盖：

```
--library=<目录>     换一个目录扫
--exe=<路径>         换一个可执行文件
```

**已知的编码陷阱**（脚本会断言它们没被破坏）：

- 路径含空格与中文（如 `<测试曲库>\07 音乐 合集\`）
- 文件名里有**连续多个空格**：`TestBand      - 测试曲.flac`（多空格不得被压缩）
- **组合字符** Unicode 文件名：`Cytus - ͟͝͞Ⅱ́̕.flac`
- 很长的文件名（不用定长缓冲）

---

## 4. 契约交接点

`engine/fixtures/library-91.json` —— 用 `--export-fixture` 从真实扫描结果生成，是 AI-B 写 UI 时的真实数据源（CONTRACT 9.1 里两边唯一的真实交接点）。

```powershell
node engine\tools\drive.mjs --step=scan --export-fixture
```

---

## 5. 源码地图

| 文件 | 职责 |
|---|---|
| **入口与命令** | |
| `src/main.cpp` | 入口、命令行开关（`--selftest` / `--probe-exclusive` / `--version`） |
| `src/app.hpp/.cpp` | 命令分发：一条命令 → 一条回复 + 若干事件；控制循环、扫描步进、设备变更服务 |
| `src/app_selftest.cpp` | `--selftest`：JSON 编解码自检 + 离线黄金测试（EQ 频响 / dither / 2^24 往返 / EBU 校准 / 声道工具） |
| **协议与 I/O** | |
| `src/protocol.hpp` | 冻结常量：协议版本、**六个错误码**、trackId 前缀 |
| `src/json.hpp` | 极简 JSON（**UTF-8 原样输出，不转义非 ASCII**，保持成员顺序） |
| `src/io.hpp/.cpp` | stdin/stdout/stderr 通道，把 CONTRACT 3.1 的铁律封在一处 |
| **曲库** | |
| `src/catalog.hpp/.cpp` | 曲目表与 `tracks` JSON 形状 |
| `src/metadata.hpp/.cpp` | TagLib 读标签（全工程唯一的 TagLib 隔离点） |
| **音频链** | |
| `src/audio_source.hpp/.cpp` | 解码器（FLAC / WAV / **MP3** / **Ogg Vorbis** / **Ogg-FLAC**）；按**内容**选容器（先读 16 字节头；`.ogg` 再往里读编码标识）；**先持有 bytes 与 reader**（坑表 #1 就出在这里）；`lossless()` 由解码器回答，不从扩展名猜 |
| `src/stb_vorbis_shim.c` | stb_vorbis 的 C 边界：解码器**按值返回结构体**且没有头文件，所以只有这一个编译单元看得到它的类型，跨界的一个是标量一个是 `void*` |
| `src/probe_format.cpp` | `--probe-format`：打印生产解码路径的真实结果 / 拒绝原因 / 样本峰值；`--full` 验长度、`--seek` 验落点 |
| `src/mp4_source.cpp` | **AAC / ALAC（MP4）**，走 Media Foundation；**按路径打开**（不整文件读入）；认 MF 的**两种** GUID 拼法；`shutdownMediaFoundation()` 必须晚于所有 source reader |
| `src/diag_log.hpp/.cpp` | **音频诊断日志**（SPEC §8 / 449）；有上限的追加写；只在控制线程调用 —— 它被放在 `WasapiOutput::open()` 的**包装函数**里，而不是某个调用点上，因为那里有两个成功出口 |
| `src/ring_buffer.hpp` | SPSC 环形缓冲（`alignas(64)`，索引只用 acquire/release） |
| `src/dsp.hpp` | **M2 音频质量链**：seqlock 无锁参数交接（整份快照，读取有重试上限） |
| `src/convolver.cpp` | **CR-020：FIR / 房间卷积**——1024 帧均匀分区 overlap-add，任意块大小，零分配，固定 1024 帧延迟；IR 用独立原子指针交接（不走 seqlock，RT 线程从不 delete）。载入时算出峰值/RMS 增益与 48 点频响曲线（供自动电平与界面预览） |
| `src/dsp.cpp` | 10 段 RBJ EQ（CR-019 起每段可设自己的频率 / Q / 类型：峰值 / 低架 / 高架）、ReplayGain、**声道工具**（balance / mono / mid-side width / swap / trim）、限幅、安全钳位、TPDF dither |
| `src/analysis.hpp/.cpp` | **EBU R128 响度扫描**（libebur128 v1.2.6）；整轨 + 专辑 gating；磁盘缓存（按路径+大小+修改时间失效）；**可增量步进** |
| **输出与设备** | |
| `src/devices.hpp/.cpp` | WASAPI 端点枚举 + 设备能力探测（含独占格式实测） |
| `src/exclusive_format.hpp` | 独占格式候选集（探测与开流共用，两边永不漂移） |
| `src/output_wasapi.hpp/.cpp` | WASAPI 共享/独占、事件驱动渲染线程、自适应缓冲、独占静音看门狗、整体淡变 |
| `src/device_monitor.hpp/.cpp` | **设备热插拔**：`IMMNotificationClient`（**只跟 eConsole**），回调只记录、控制线程干活 |
| `src/player.hpp/.cpp` | 三线程播放器：开曲/播放/跳转/队列/结束判定（**设备真正播完才算完**）、切歌 5 ms 淡出、热插拔重开 |
| `src/probe_exclusive.cpp` | `--probe-exclusive`：独占诊断，逐格式 × 逐缓冲报「设备是否真的发过缓冲区事件」+ `padding / buffer`（**这一列才看得出「没喂数据」和「硬件不响」的区别**，见 PROGRESS §0n） |
| `src/probe_mf.cpp` | `--probe-mf`：Media Foundation 音频编解码器枚举（**只读**）；`--write-tone <path> --codec aac\|alac` 用系统编码器造真测试素材 |
| `src/probe_ir.cpp` | `--probe-ir`：**FIR/房间卷积还没有实现**，这个探针先把「素材这一半」问清楚 —— 冲激响应的格式、长度、峰值/直流、能量起止、在 1024 帧均匀分块卷积下要多少分区、以及**能不能被吃下**。走的是播放同一条 `MediaReader` 路径，所以中文路径/长路径与真实信号链一致 |
| **平台辅助** | |
| `src/util.hpp` | **UTF-8 ↔ path** 显式转换（Windows 上不转换会按 ANSI 代码页解析，中文路径必坏） |
| `src/win_util.hpp` | COM/宽窄字符等 Windows 辅助 |
| `src/win_props.hpp` | 用到的那两个 PROPERTYKEY（`functiondiscoverykeys_devpkey.h` 需要 INITGUID） |
| `src/crash_attribution.hpp` | 崩溃时用 `GetModuleHandleExA(FROM_ADDRESS)` 解析**出错模块**，只在自己模块时给 RVA |
| `src/CMakeLists.txt` | 源文件清单 + `te_ebur128` 静态库（含 `queue/` include 与 `_USE_MATH_DEFINES`） |
| `third_party/` | TagLib / utfcpp / dr_libs / soxr / libebur128 / kissfft（见 §1 依赖表） |

---

## 6. 当前状态

见 **`engine/PROGRESS.md`**（做到哪一步、下一步是什么、踩过的坑）。
本文件只描述**怎么用**，不描述**做到哪**。
