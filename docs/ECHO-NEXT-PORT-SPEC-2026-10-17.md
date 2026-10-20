# ECHO NEXT 专业功能与播放性能 · 移植规格（v1）

> **状态**：现行 · **日期**：2026-10-17 · **给谁**：本轮实现者（engine/main/renderer）+ 下一位接手者
> **上位**：`CONTRACT.md` §3（只读，扩展走 `docs/contract-requests.md` CR-024…027）、`docs/PERF-v1-2026-10-17.md`（上一轮性能基线）
> **它解决什么问题**：用户要求「转化 ECHO NEST（本机安装的 `ECHO NEXT`）的专业功能和播放性能，加载进来；保证高优化；尤其深度播放状态；同时检查功能是否真实落地」。本文是从 ECHO NEXT 的安装产物里**实测/提取**出来的事实与移植取舍（不是猜测）。

## 0. 证据来源（可复现）

- 安装物：`<移植参考安装目录>\`（Electron 应用，`resources\app.asar` 186MB，`resources\echo-audio-host.exe`，`@lox-audioserver`）。
- 已解析产物：`.scratch/echo-next/`（工作区）——`file-list.json`（13,232 文件）、`extracted/out__main__index.js`（5.3MB）、`feature-scan.txt`、`playback-details.txt`。**不要把它当源码抄**：那里只有打包后的 JS/二进制，我们只提取「做了什么/参数语义」，算法自己实现。
- 用户数据（只读参考）：`%APPDATA%\ECHO NEXT\echo-settings.json`（完整功能开关）、`eq-state.json`、`echo-playback-memory.json`、`eq-backups/`。

## 1. ECHO NEXT 的专业音频功能（提取到的事实）

| 功能 | ECHO NEXT 的事实（参数/语义） | 我们的对应物 / 缺口 |
|---|---|---|
| ECHO SRC（升采样） | modes: `off / compatibility48 / family2x / family4x / family8x`；quality: `transparent / balanced / lowLatency`；filter profiles 30+（poly-sinc-*、sinc-*、apod-*、brickwall 等）；advanced 模式下 1x/Nx 可分别选；compute `cpu/cuda` | 我们固定 SoXR `VHQ` + 线性相位。**本轮：暴露 quality/phase/steep（CR-024）**；不移植 HQPlayer 级滤波器族与 CUDA |
| PCM dither | `off / tpdf / highpass-tpdf / ns-5 / ns-9 / ultra-shaped`；只在整数输出且非 shared 时经 native processing 应用 | 我们只有平直 TPDF 且不可关。**本轮：全部档位（CR-025）** |
| 声道工具（Channel Balance / Channel Tools） | balance ±1、L/R gain −12…+6dB；低/中/高三频段 L/R 增益 −6…+3dB；每声道延迟 0–10ms；monoMode `sum/left/right/off` | 我们有 balance/mono/立体声宽/swap/全带 L/R gain/mid-side/crossfeed；缺 monoMode、三频段增益、每声道延迟。**本轮：CR-026** |
| 延迟档位 | `stable`(8192 帧) / `balanced`(2048) / `lowLatency`(1024) 帧；lowLatency 上限 2048、独占最低 8ms；`bufferSizeFrames` 可记住 | 我们自适应 buffer（内置端点 period 10ms / buffer 22ms），无用户档位。**本轮：CR-027** |
| 输出后端 | native host（echo-audio-host）/ miniaudio / libav decode / ASIO / system；releaseExclusiveOnPause（实验）；exclusiveInstabilityFallback | 我们 WASAPI 独占/共享/auto；**不移植** ASIO/miniaudio/DSD/SDM（范围与许可风险，见 §4） |
| 无间隙播放 | 守护进程 `audio.gaplessPrepare`（下一首 + following 列表）、`audio.prefetch`（预热解码器）；队列由守护进程自主推进 | 我们 `set_queue` 有队列但换曲要整段重开（有间隙）。**本轮：至少做「下一首文件预热」（app 侧，见 §2.3）；真 gapless 留下轮** |
| 播放记忆 | `echo-playback-memory.json`（filePath/trackId/positionSeconds/duration/metadata/updatedAt）+ 会话 sqlite | 我们没有。**本轮：播放记忆/恢复（app 侧）** |
| 播放速度 | 0.5–2×，`playbackSpeedMode: nightcore`（变速+变调） | 我们没有。**本轮不做**（无变调需求时需时间伸缩库，属新依赖） |
| ReplayGain | enabled/mode track/album；target LUFS −14；preamp；preventClipping；analyzeOnPlay；missing-on-scan opt-in | 我们有 track gain + preventClip（sample peak 口径，OPTIMIZE §2.1b 说应改 true peak）；**本轮只做只增的 target/preamp 暴露评估，不强制** |
| 传输淡变 | `audioTransportFadeEnabled/fadeInMs/fadeOutMs/curve` | 我们起播/暂停/seek/切歌固定 5ms 淡入淡出（上一轮音频交接）。**本轮不改** |
| DSP 辅助 | `dsp.setHeadroom` / `dsp.setSafetyLimiter`；EQ 每段 enabled + APO 导入导出 + 预设导出 + 预览导入 | 我们有 EQ 10 段/预设/APO 导入；缺每段 enable、A/B、撤销、headroom 显式控制。**本轮：EQ A/B + 撤销（app 侧）** |
| 电平/可视化 | levelMeter interval 可配；waveform progress；music-reactive visuals（本机 disabled） | 我们 meter 固定 ~64Hz、无 waveform（已 CR-022 停发）。**本轮：meter 间隔可配（低频省 CPU）作为深度播放优化候选** |

## 2. 本轮移植范围（可交付、可测量）

### 2.1 引擎（engine/src）
1. **CR-024 resampler**：`set_resampler` + state.resampler；默认 VHQ/linear/非 steep 不变。播放中改配置允许 ≤100ms 重开并如实说明。
2. **CR-025 dither**：`set_dither` + state.dither；默认 tpdf 与现状等价；off 时整数输出不加 dither（仍保留安全钳位）。
3. **CR-026 channel tools**：`set_channels` 只增 `monoMode` / `bandGains` / `delayMs`；0 值时完全旁路（bit-perfect 不变）。
4. **CR-027 latencyProfile**：`set_output.latencyProfile` + state.latencyProfile；balanced 为现状。
5. **播放性能**：E10b（shared 跨率切歌不再整段重开 WASAPI，目标 70–150ms → 2–5ms）；feeder 空闲等待从 2ms 轮询改条件变量/更长超时；meter 分析 FFT 的 4× 补零若实测可降（先量后改，测频谱数值差异）；输出给 `state` 的 meter 间隔可配（可选）。

### 2.2 应用主进程（app/src/main）
- **播放记忆**：`playback-memory.json`（filePath/trackId/positionMs/queue/repeatMode/updatedAt，节流写、退出补写）；启动后渲染层可读取，恢复「已加载但暂停」的状态（不自动出声）。
- **下一首预热**：收到渲染层 `prefetch` 请求后，用 `fs.open/read` 把下一首文件前若干 MB 读进内存丢弃（预热 OS 页缓存/解码器），后台低优先级、可取消；不得影响当前播放。
- 门禁级功能修复/补漏（审计产物另出）。

### 2.3 渲染层（app/src/renderer）
- **音频设置面板**：设置页「输出与规格」下新增「重采样 / dither / 延迟档位 / 声道工具」四组控件（值持久化 localStorage，握手后与 `applyOutputPreference` 一起重下发；旧引擎 ERR_UNSUPPORTED 时显示「引擎不支持」而不是假装成功）。
- **EQ A/B + 撤销**：快照栈（上限 20），撤销恢复上一次参数；A/B 在两份快照间切换（引擎命令沿用 set_eq/set_channels）。
- **播放恢复提示**：启动时若有播放记忆，显示一条可操作的「继续上次」入口（位置/曲目），点击后 open+seek 并保持暂停。
- **深度播放 UI 优化**：以 `probe-deep-play` 的沉浸场景（歌词+频谱光带+唱片+meter）为对象，Profile 后做等价优化；不降视觉频率除非有数据支撑。

## 3. 测量与验收（本轮统一口径）

- 深播三场景（`app/.smoke/perf/probe-deep-play.mjs`）：`home-visible-eq-on` / `immersive-lyrics-meter` / `sound-page-eq-ui`，各 ≥10s，引擎 CPU 用稳定单 pid 采样（避免 Get-Process 波动），记录 Tab/GPU/Browser CPU + privateMem + 帧率 + meter fps。
- 切歌延迟（新增 `probe-track-switch.mjs`）：10 次 open→playing 的毫秒数（冷/热分开）、跨采样率切歌（44.1↔48/96）中位数；E10b 前后对照。
- 引擎 DSP 成本：measure-engine 增加 `eq-on` / `channel-tools-on` / `dither-ns9` / `src-24bit` 分相。
- 每个功能必须给出：命令形状实测（真实引擎、静音）、CPU 成本、bit-perfect 语义未破坏（selftest/身份测试）。
- **会出声的测试本轮仍不跑**（test:player/listening/integration/soak/drive）；用静音 + 假数据替代。

## 4. 明确不移植（诚实边界）

- DSD / SDM（pcmToDsd、dsd64–512、HQPlayer 级 poly-sinc 滤波器族）：需要全新的 SDM 调制器 + 大量滤波器系数，且本机无 DSD DAC，属独立项目，不做。
- ASIO / miniaudio / libav-decode / CUDA / AirPlay / HQPlayer 集成：新依赖或新原生后端，超出本轮「高优化 + 专业功能」范围。
- MV（B 站/YouTube 视频）、桌面歌词独立窗、任务栏播放器、主题工坊、插件系统、云盘/远程库：产品面扩展，不是「播放链路专业功能」。
