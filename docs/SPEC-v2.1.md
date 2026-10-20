# 桌面音乐播放器 · 方案 v2.1

> 由 v2.0 修订而来 · 施工口径唯一版本 · 冻结接口见 [`CONTRACT.md`](../CONTRACT.md)
> 修订日期：2026-10-14
> 历史参考：`SPEC-v2.0-legacy.txt`、`SPEC-v1.1-legacy.txt`（原地保留，不再维护）

---

## 0. 本次修订的性质

v2.0 是一次**在纸面上做得很好、但地基有四处错位**的方案。v2.1 修正的不是细节，是那四处错位：

| # | v2.0 的假设 | 实况 | 影响面 |
|---|---|---|---|
| **错位 1** | 核心是"高性能播放器"，UI 选型为审美服务 | 实际用途是**接入音乐平台账号**（类 Folia） | 第 2 章选型、第 4 章桥接、第 9 章工程化 |
| **错位 2** | Slint 能做到"澄明之境" | **三条核心效果平台层做不到**；且 1.18 默认后端内存反升 | 第 5 章 UI 全部 |
| **错位 3** | 曲库 10k、内存 ≤90MB、WASAPI 独占 3ms 起步、RTSan 进 CI | 本地仅 **91 首**；RTSan **Windows 不可用**；3ms 是**部分硬件的终点** | 第 7/8/9 章 |
| **错位 4** | 完整工程闭环（打包/更新/签名/崩溃上报/合规清单） | **只自用，不发布** | 第 9 章大幅删除、第 12 章整章删除 |

**一句话总结**：这是一个**自用、Windows 单平台、以"动画手感 + 音频质量"为差异**的类 Folia 播放器，引擎用 C++20 自研，壳用 Electron，平台协议层用 Node 现成服务端。

---

## 1. 概述与目标

### 1.1 目标（重写）

- **能天天用**：接自己账号（网易云为主），能搜、能播、能看歌词，本地 91 首也能放
- **音频质量高于 Folia**：Folia 是 Web 栈，做不到 WASAPI 独占 / bit-perfect / EQ / ReplayGain / ASIO —— **这是唯一不可替代的差异**
- **动画手感高于 Folia**：不追数据量（Folia 已接入 AMLL 逐词库），追**过渡曲线、阻尼、响应速度**的手感
- **不臃肿**：刻意不做清单见 §6.5
- **可验收**：第一个里程碑是"在 91 首上放出声 + 歌词动画动起来"（见 CONTRACT §2）

### 1.2 口径（写入验收标准，替代 v2.0 §1 的口径说明）

| 项 | v2.0 口径 | **v2.1 口径** |
|---|---|---|
| 内存 | 空闲 ≤90MB / 播放 ≤100MB | **Electron 外壳实测 ≈279MB 常驻**（Win x64 空窗口 + 1 渲染进程，Elanis 基准）。不再把内存当卖点；引擎自身 RSS 目标 ≤60MB |
| 延迟 | 应用侧 ≤6ms / 端到端 8–14ms | **按硬件分档报告**：板载独占可达 3ms 级；**USB 类驱动事件驱动独占劣化到 9ms**；共享模式典型 10.16ms。实际值由能力探测决定并显示在设置页 |
| 平台 | Windows + "后续 macOS/Linux" | **仅 Windows 10/11**。平台抽象层保留最薄形态 |
| 实时安全 | RTSan 纳入 CI | **RTSan 不支持 Windows** → 改为人工断言 + 压力测试 + xrun 计数；如需 RTSan，在 Linux/WSL 单独跑 |

### 1.3 参照物：Folia

`chthollyphile/folia-major` —— 6165★，AGPL-3.0，TypeScript，**2026-10-14 仍在提交**。
它已经做到：本地 / Navidrome(OpenSubsonic) / 网易云 / QQ / 酷狗 五源、扫码登录、**AMLL 逐词 TTML 歌词**、词级动画、Mod 平台。

**结论：凡是 Folia 已经做好的（平台接入、歌词数据、歌词动画、曲库浏览），不要指望用更慢的技术栈重做得更好。** 本项目只在两处发力：音频质量、动画手感。

---

## 2. 选型与许可

### 2.1 主选型（已冻结）

```
Electron 44.x (TypeScript + React)     ← 外壳 + UI + 平台层 + 曲库
        │  JSON Lines over stdio（见 CONTRACT §3）
twilight-engine.exe (C++20, 独立进程)  ← 解码 / DSP / WASAPI 输出
        │
Node API 服务端（api-enhanced 等，主进程自动启动）
```

### 2.2 为什么不选 Slint（v2.0 原选型）

**三条设计语言核心效果在 Slint 平台层做不到**（截至 1.18.1）：

| 效果 | Slint 状况 | 来源 |
|---|---|---|
| 逐元素模糊 / backdrop-filter | **不支持**（#2066 仍 open，#13502 作为重复被关闭） | github.com/slint-ui/slint/issues/2066 |
| 自定义图片光标（光晕指针） | **不支持**（#3905 仍 open）；只能隐藏系统光标或切换系统光标 | issues/3905 |
| 鼠标点击穿透（迷你模式） | **不支持**（#6021 仍 open） | issues/6021 |

外加两条：
- **内存优势消失**：同一 Windows 应用空闲实测 1.17.1+renderer-skia ≈19.5MB，而 **1.18.0 默认 skia ≈155.5MB**（wgpu-30 进默认 feature，Windows 建 D3D surface）；换 `renderer-skia-opengl` 才回到 ≈46.1MB（#13470）。**内存基线成了"钉了哪个 feature"的函数，且版本间会跳。**
- **工期末日**：§5.3 那九条效果在 React/CSS 里是日常活，在 Slint DSL 里要 Path 自绘、位图预渲染、逐元素手写插值——而移交对象是 AI，**AI 在 Web 栈上的动画成功率远高于 Slint DSL**。

### 2.3 为什么是 Electron 而不是 Tauri

**反直觉但实测如此**（Elanis 跨框架基准，GitHub CI，Win x64 空窗口，主进程+子进程中位数）：

| 壳 | Release 常驻 | 系统空闲差值 |
|---|---|---|
| **Electron 44.7.2** | **≈279MB** | ≈100MB |
| Tauri 2.12.3（WebView2） | ≈307MB | ≈187MB |
| Wails 2.14 | ≈317MB | — |

Tauri 在 Windows **更高**，因为 `msedgewebview2.exe` 子进程被计入。而 Tauri 还不带 Node —— 平台 API 服务端得再塞一个 sidecar。**Electron 主进程本身就是完整 Node，另提供 `UtilityProcess`（官方建议优先于 `child_process.fork`）跑带 MessagePort 的子进程。**

### 2.4 为什么引擎仍是 C++20（Rust 被否决的实测依据）

| 能力 | Rust 侧现实 |
|---|---|
| WASAPI **独占** | **无现成库**。cpal 至今不支持：issue #106 自 2016-03-02 开到现在仍 open；PR #843（"Added WASAPI exclusive host"）2024-11 关闭未合并；PR #1368（2026-09-13，已在 Windows ARM + Schiit USB DAC 端到端验证）标记 **postponed**。必须自己写 windows-rs 层 |
| **VST3 宿主** | 生态极薄：vst3-sys（331★）停在 2023-06；vst-rs（1060★）**已 archived** 且只是 VST2.4；nih-plug 是"写插件"不是宿主；唯一像样的宿主 rust-vst3-host 仅 **39★** |
| 解码 | Symphonia（3435★）覆盖 FLAC/ALAC/MP3/AAC/WAV/AIFF/Vorbis，**WavPack 与 Opus 未完成，APE 完全没有** |
| 重采样 | rubato 5.0.1 —— **唯一真正成熟且达标的** |
| 实战 | 无 foobar/HQPlayer 级的 Rust Windows HiFi 播放器（最好的 WaveFlow 仅 75★） |

**反向确认**：C++ 侧 WASAPI/ASIO SDK/VST3 SDK/libsoxr/libebur128/FFmpeg **全部成熟且有官方支持**。

> 换取结论：换 Rust = 重写引擎 + 自造独占层 + 放弃 VST3 宿主，只为语言手感。不划算。

### 2.5 许可（大幅简化）

P1 = **只自用、不对外分发**。据此：

- **§12 合规红线与发布清单（v2.0 整章）→ 删除**。Slint 署名义务、LGPL "可替换库"文档、ASIO 许可留档、隐私声明、更新签名密钥留档全部作废。
- **AGPL 传染无效** → Folia 的代码可以自由阅读参考，Slint 那套许可纠结不再存在。
- 保留的仅为**事实备忘**（写进 CONTRACT §6.1，避免两个 AI 各自搜出不同答案）：VST3 3.8+ 为 MIT（VSTGUI/mda-vst3 示例除外，VST2 不在内）；TagLib 是 LGPL-2.1/**MPL-1.1**；Chromaprint 整体按 LGPL-2.1 对待；NeteaseCloudMusicApi 原版**已 archived**，继任是 **api-enhanced**。

### 2.6 组件清单（按 v2.1 范围裁剪）

| 用途 | 组件 | 状态/备注 |
|---|---|---|
| 外壳 | Electron 44.x | 实测 44.7.2；注意 **46 起 safeStorage 移除同步 API**，现在就用异步版 |
| UI | TypeScript + React | 动画能力最强 |
| 解码 | FFmpeg（LGPL 构建）或 dr_libs 起步 | 自用可放宽；FFmpeg 现行稳定 9.0.2 |
| 标签 | TagLib | LGPL-2.1 / MPL-**1.1** |
| 输出 | WASAPI（IAudioClient3） | ASIO 暂缓（无硬件） |
| 重采样 | SoXR（**停更于 2018-02-24**） | 音频数学稳定，风险低 |
| 响度 | libebur128（**停更于 2021-02-14**） | 同上 |
| EQ | 自研 10 段 IIR（RBJ Cookbook） | 无许可问题 |
| 曲库 | SQLite | 最小集即可（§7） |
| 平台层 | api-enhanced（网易云）/ Navidrome | 见 CONTRACT §6.1 |
| 歌词 | AMLL TTML DB + 网易云 yrc | 见 CONTRACT §4.4 |
| 构建 | CMake + MSVC | 见 CONTRACT §7 |

**已从清单移除**：Chromaprint/AcoustID（去重砍）、VST3 SDK（宿主砍）、signalsmith-stretch/SoundTouch（变速砍）、SpeexDSP、libsndfile、miniaudio/RtAudio、WinSparkle（自用无更新）、sentry-native/Crashpad（自用只留本地 dump）、Clang RTSan（Windows 不可用）。

---

## 3. 引擎架构

> 本章 v2.0 内容**大部分保留**（这是全篇质量最高的部分），只修正被实测打穿的条款。

### 3.1 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│ UI 层（React/TS，瘦客户端：渲染/交互/订阅，不做音频处理）      │
└──────────────────────┬──────────────────────────────────────┘
                       │ Electron IPC（命令 / 状态快照）
┌──────────────────────▼──────────────────────────────────────┐
│ 应用主进程（Node）：平台层、曲库展示、登录态、窗口管理         │
└──────────────────────┬──────────────────────────────────────┘
                       │ JSON Lines over stdio（CONTRACT §3）
┌──────────────────────▼──────────────────────────────────────┐
│ twilight-engine.exe（C++20）：唯一音频权威                    │
│ ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐            │
│ │ 解码层 │ │ DSP 层 │ │ 混音/输出│ │ 元数据   │            │
│ │ FFmpeg │ │EQ/RG   │ │ WASAPI   │ │ TagLib   │            │
│ └────────┘ └────────┘ └──────────┘ └──────────┘            │
│ 实时约束：无锁、无分配、无系统调用（人工断言 + 压力测试）      │
└──────────────────────┬──────────────────────────────────────┘
                       │ WASAPI（共享 / 独占）
┌──────────────────────▼──────────────────────────────────────┐
│ 平台适配层：Windows only                                      │
└─────────────────────────────────────────────────────────────┘
```

**原则不变**：引擎是唯一音频权威；UI 只发命令、订状态；**音频样本绝不穿越通道**。

**新增原则（来自 Electron 实测）**：**独占播放必须由独立进程完成，并且让它先拿到设备。** 原因是 Chromium 自身会以共享模式占用音频端点（electron/electron 全仓无独占冲突报告，唯一真实风险就是这个）。

### 3.2 线程模型与实时安全

三线程模型保留：

| 线程 | 职责 | 约束 |
|---|---|---|
| 渲染(RT) | 音频回调、DSP、混音输出 | 无锁 / 无分配 / 无系统调用 |
| 控制 | 命令、播放状态机 | 可阻塞；SPSC 下行命令 |
| I/O | 解码、元数据 | 可阻塞；SPSC 上行 PCM |

保留：MMCSS `AvSetMmThreadCharacteristics("Pro Audio")`（失败降级 HIGHEST 并记日志）；优先级 RT=HIGHEST / 解码=BELOW_NORMAL；SPSC 环形缓冲 `alignas(64)`，索引仅 acquire/release；命令在音频块边界处理（单块 ≤32 条）；背压；内部 float32 planar；欠载恢复（连续 3 次 xrun → 缓冲 ×2，上限 50ms）。

**修正（v2.0 §3.3 末段）**：
- **RTSan 不能用于 Windows CI**（官方 README：RealtimeSanitizer does not yet support Windows；运行库只发 macOS/Linux）。实时安全验证方式改为：
  1. RT 路径人工断言 + code review 清单
  2. 30min 独占最小缓冲压力播放 = 0 xrun 断言
  3. xrun 计数与缓冲史写入独立日志，供反馈
  4. （可选）在 Linux/WSL 上跑 RTSan 作为补充证据

### 3.3 输出与低延迟策略（**口径已修正**）

**能力探测优先**（新增，替代"3ms 周期 ×2 起步"的断言式写法）：

```
1. 枚举设备 → 对每个设备查询实际能力
   独占：IAudioClient::GetDevicePeriod（默认周期与最小周期）
   共享：IAudioClient3::GetSharedModeEnginePeriod（default / fundamental / min）
2. 按探测值选择缓冲，落点分档记录到日志并显示在设置页：
   ├─ 板载 HD Audio 独占：可达 3ms（44.1k / 132 帧）
   ├─ USB 类驱动独占：事件驱动劣化到 9ms（MS Q&A 2022-05，至今无官方修复）
   ├─ 共享模式：官方示例 default = 448 帧 ≈ 10.16ms
   └─ 蓝牙：≥20ms
3. 独占失败 → 回退设备默认周期 → 回退共享模式 → 记录实际落点
```

**MMCSS 门槛（重要）**：只有周期 **<10ms** 才升到 "Pro Audio" 特性。10ms 及以上的共享模式拿不到该特性。

保留其余条款：采样率切换（独占按源采样率重开流，间隙 10–20ms 淡出/淡入；共享不重开，源≠设备率时启用 SoXR，同率时跳过）；位深（输出<源位深时 TPDF dither，bit-perfect 路径禁用）；音量（float 域一阶 ≈10ms 平滑；拖音量提示"将退出 bit-perfect"）；设备热插拔（`IMMNotificationClient`，漂移 10ms 淡出 → 释放流 → 按 ID 重开 → 失败回退默认 → 20ms 淡入；蓝牙自动降级共享；独占被占静默降级共享）。

**新增：双模式明示**（来自 P4）。UI 必须显示当前状态：有线独占 → "bit-perfect"；蓝牙/共享 → "已降级（蓝牙链路会重编码）"。用户已确认接受"蓝牙降级、有线才能 HiFi"的双模式。

### 3.4 DSP 层（裁剪版）

**保留**：
- **EQ**：10 段 IIR（31.25/62.5/125/250/500/1k/2k/4k/8k/16k Hz），RBJ peaking，Q 默认 1.41，±12dB/0.5dB 步进，系数 ≈20ms 每样本插值平滑，旁路 30ms 交叉淡变，预分配零分配
- **重采样**：SoXR，仅在采样率不一致时激活，缓存实例
- **ReplayGain 2.0**：libebur128 扫描（整轨+专辑），目标 -18 LUFS，用 track_peak 防削波（超限衰减至 -0.1dBFS），模式 关/单曲/专辑 切换 30ms 平滑

**移除**：变速不变调（signalsmith-stretch/SoundTouch）、独立变调、交叉淡入淡出引擎（保留 Gapless）、实时限幅开关。
（理由：91 首曲库、业余工期、且均非音频质量差异点。）

### 3.5 DSD（**大幅降级**）

P4：无独立 DAC，日常含蓝牙。因此：

- **保留接口与直通逻辑**：DoP 走 WASAPI 独占，DSD64→176.4k / DSD128→352.8k；**DoP 路径禁止一切 DSP**；数字音量不可用 → 直通并在 UI 明示
- **标注为外推**：DoP 现行规范只有 v1.1（2012-03-30）。DSD256→705.6k **属规范允许的向上扩展，正文只写到 128FS**，实现时按实验能力处理
- **两条会咬人的细节（写进实现注释）**：接收端需**连续 32 个标记字节**才切 DSD；不支持 352.8k 的链路改走"通道对 + 另一标记字节"替代法
- **移出范围**：Native DSD（依赖 ASIO 驱动，无硬件）、DSD→PCM 抽取、**PCM→DSD 调制输出（原排期最后的 Could 级，直接删除）**
- **无法真听**：本机无 DSD DAC，此路径只能做回环波形验证

### 3.6 VST3 宿主（**移出范围**）

v2.0 的 §3.7（v1 进程内 + v2 沙箱）**整体移出范围**。原因为范围管理：VST3 宿主是独立的大工程，而它与"放好音乐"无直接关系。

> 注意：本机确实装了 VST3（`C:\Program Files\Common Files\VST3` 下有 Synthesizer V Studio 2 的 ARA 与 VST3 插件），所以这项**可能**与"做音乐"的用途有关。若确有此需求，单独立项，不并入本项目。

### 3.7 Gapless（保留，简化）

- 预解码：下一首常驻缓冲（本地 ≥2s 前导）
- Gapless：同专辑（album + album_artist + 连续 track_no 且非手动切歌）采样级拼接；异采样率先各自重采样到设备率再拼接
- 手动切歌不交叉，仅 5ms 淡出防爆音
- **移除**：交叉淡入淡出（等功率曲线、尾部渐弱/硬切判断）

### 3.8 功能分层（重写）

| 层 | 内容 | 状态 |
|---|---|---|
| **L1 基础播放** | MP3/AAC/WAV/FLAC/ALAC 解码；播放/暂停/停止/上下曲/Seek/音量；队列（顺序/单曲/列表/随机）；100ms 状态快照 | Must |
| **L2 音频质量** | WASAPI 独占+共享（能力探测）；EQ；ReplayGain；SoXR；bit-perfect 路径与降级明示 | Must（**项目存在的理由**） |
| **L3 体验** | 歌词（AMLL/网易云 yrc + 本地）；动画手感；迷你模式；全局快捷键；系统媒体控制（SMTC）；托盘；智能续听 | Should |
| **L4 平台** | 网易云（扫码登录 + 搜索 + 取流 + 歌词）；Navidrome（OpenSubsonic）；本地文件夹 | Must（**第二个里程碑**） |
| **L5 按需** | QQ 音乐（风控最重）；酷狗；主题系统；DSD 直通 | Could |
| **不做** | VST3 宿主、音乐地图、指纹去重、聆听房间/空间音频、场景模式、智能播放列表、变速变调、安装包/自动更新/签名、MQA | Won't |

---

## 4. 引擎 ⇄ 应用接口

**接口定义已冻结，见 [`CONTRACT.md`](../CONTRACT.md) §3。** 本章不再重复；此处只记录设计原则：

1. **JSON Lines over stdio** 而非 C ABI/napi —— 独立进程 + 零胶水 + 可读可调试；崩溃隔离；**独占设备由引擎进程先取**（§3.1 新增原则）
2. **stdout 只走 JSON Lines**，日志走 stderr
3. **音频样本绝不穿越通道**
4. 快照采用**事件推送**（v2.0 的 pull/三缓冲模型在跨进程下不再必要）
5. **降级不是错误**（`state.outputMode` + `bitPerfect:false` 表达，不走 `ok:false`）

---

## 5. UI / UX（澄明之境）

### 5.1 设计语言保留，实现方式改变

**§5.1–§5.6 的视觉与动效规范全部保留**（光/水/空气的色彩基底、三层深度、湿玻璃三要素、不对称布局、九大独特效果、动效曲线表、字体排版表、刻意避免表）。

**改变的是实现层**：从 Slint DSL 改为 CSS/React。「澄明之境」原本就是**围绕 Web 能力描述的设计语言**（backdrop-filter、blur、CSS 缓动、自定义光标），换到 Web 栈后是**回到它的自然栖息地**。

### 5.2 九大效果的实现能力对照（**这是本次修订的核心收益**）

| v2.0 §5.3 效果 | 原 Slint 状况 | Web 实现 |
|---|---|---|
| ① 光晕指针 | **做不到**（#3905） | ✅ CSS 自绘 `cursor:none` + 跟随元素 |
| ② 列表项悬浮 | 需手动 | ✅ 原生 |
| ③ 水滴进度条 | Path 自绘 | ✅ CSS + SVG |
| ④ 封面玻璃板（鼠标倾斜） | 需手动 | ✅ transform + 鼠标跟随 |
| ⑤ **歌词逐行浸入 + blur(4→0)** | **做不到**（#2066） | ✅ **原生 `filter: blur()`** |
| ⑥ 播放栏光带 | 需手动 | ✅ 原生 |
| ⑦ 队列玻璃板（blur 背景） | **无 backdrop-filter** | ✅ **原生 `backdrop-filter`** |
| ⑧ 迷你模式（点穿） | **做不到**（#6021） | ⚠️ 仍受限（Electron 窗口级 click-through 需自行实现，可能只能做"置顶 + 无边框"） |
| ⑨ 搜索光流 | 需手动 | ✅ 原生 |

**结论：九条里从"三条做不到 + 六条要手写"变成"一条受限 + 八条原生"。**

### 5.3 湿玻璃材质（v2.0 §5.1 保留，但注意）

原设计刻意避开毛玻璃、主张"湿玻璃（内描边 + 边缘辉光 + 环境遮蔽）"。在 Web 栈上 **`backdrop-filter` 可用**，但**建议仍按 v2.0 的湿玻璃公式实现**——那是本设计的辨识度所在，且 `backdrop-filter` 有性能代价（合成层开销）。两者可共存：静态面板用湿玻璃，浮起层（队列玻璃板 §5.3⑦）用 `backdrop-filter`。

### 5.4 主题系统（保留，降优先级）

v2.0 §5.8 的完整主题系统保留设计（~35 项令牌、6 预设、自定义三档、颜料入水切换、每个主题的强调色光学处理），但**排期降到 L5**。原因：它是纯 UI 工程，不影响两个差异点；且 Web 栈上实现成本远低于原计划，可以随时补。

### 5.5 字体

保留 §5.5 的排版表。**注意**：原表建议的中文衬线（思源宋体）与等宽（Sarasa Mono）**授权需确认**——但 P1 是自用，不再构成障碍。Web 栈下字体可直接用 `@font-face` 引入，比 Slint 灵活。

---

## 6. 功能范围

### 6.1 L4 平台接入（第二个里程碑）

按 CONTRACT §4 的 `MusicProvider` 接口：

| 平台 | 优先级 | 登录 | 说明 |
|---|---|---|---|
| **本地文件夹** | P0（第一个里程碑） | 无 | 91 首 FLAC |
| **Navidrome / OpenSubsonic** | P0（第一个里程碑） | 用户名密码 | 规范有完整 `openapi.json`（36KB）可代码生成；**但现成 TS 客户端几乎不存在**，需自己生成 |
| **网易云** | P1（第二个里程碑） | 扫码（unikey + 轮询） | 用 `api-enhanced`；`yv=-1` 白拿逐字歌词 |
| QQ 音乐 | P2 | 扫码（需 MQTT 长连接） | 风控最重；QRC 需自建解密 → **不做** |
| 酷狗 | P3 | — | 暂不做 |

**风控约束见 CONTRACT §5**（≥1s 间隔、禁刷歌、令牌桶、-460 即停）。

### 6.2 歌词

数据源优先级见 CONTRACT §4.4。要点：
- **AMLL TTML DB** 是逐词事实标准（CC0，按歌曲 ID 直链，含背景人声/翻译/音译），**Folia 已接入它**
- 网易云 `yrc` 加 `yv=-1` 即可得字级
- LRCLIB 的 `hasWordSync` **实测恒为 false**，只作行级兜底
- **插值兜底必须如实标注** `wordByWord:false`

### 6.3 已砍功能（本轮决定，连同理由）

| 砍掉 | 理由 |
|---|---|
| **音乐地图**（二维光点） | 91 首上无意义；且是最重的自绘 UI 工程 |
| DSD 调制输出、Native DSD、DSD→PCM | 无 DSD DAC，无法真听 |
| VST3 宿主 | 独立大工程，与"放好音乐"无关（若因做音乐需要，单独立项） |
| 聆听房间/空间音频 | 大幅工程，且与"听清原音"的 HiFi 目标相冲 |
| 场景模式 / 智能播放列表 / 快捷键三级作用域 | 低频高认知负荷功能群 |
| 变速不变调 / 独立变调 | 非差异点；移除一条依赖链（signalsmith-stretch/SoundTouch） |
| 指纹去重 | 91 首无重复可去 |
| 交叉淡入淡出 | 简化；只留 Gapless |
| 打包 / 自动更新 / 签名 / 崩溃上报 / 托盘之外的安装体验 | P1 自用（§9） |
| QQ QRC 歌词 | 需自建解密，性价比最低 |
| 多平台同时接入 | 先只通网易云；QQ 真测风控最重 |

### 6.4 刻意不做（长期有效，继承 v2.0）

社交（好友/排行/评论）、沉浸互动（养鱼/3D）、商店/推荐流、内置下载器、AI 音效黑盒、MQA 渲染、**DRM 解密（.ncm/.qmc 等）**。

> **DRM 那条需要单独说明**：网易云下载文件是 `.ncm` 加密容器（缓存为 `.uc`/`.uc!`），QQ 音乐是 `.qmc0/.qmcflac/.mflac/.mgg`，**会员身份不解除加密**。解密属"避开技术措施"，有明确先例：2022-11-08 GitHub 依反规避条款对 unlock-music 整个网络（含全部 fork）**497 个仓库执行下架**，API 现返回 451。**本项目不内置任何解密能力**——这与"自用"不矛盾：自用豁免的是分发风险，不豁免绕过技术措施本身。

### 6.5 与 Folia 的边界（避免重复劳动）

| 不重做（Folia 已好） | 只做这里（差异） |
|---|---|
| 平台协议接入、扫码登录 | **WASAPI 独占 / bit-perfect / EQ / ReplayGain** |
| 歌词数据获取（AMLL 已是最优） | **动画手感**（曲线、阻尼、打断处理） |
| 曲库浏览界面 | 引擎侧标签读取与音频管线 |
| Mod 平台、B 站点歌台等扩展 | — |

---

## 7. 曲库与数据层（**缩减**）

### 7.1 规模现实

本地 91 首（`<测试曲库>`，多为 24bit/96k 级 FLAC）。因此：

- **不上 FTS5 + trigram 分词**（91 首直接内存过滤 + `LIKE` 就够）
- **不上断点续扫/scan_state**（首扫秒级完成）
- **不上封面临时尺寸 40/56/96/300/600 多级缓存**（单级缩略图即可）
- **保留**：`tracks` 表主干、`folders`、封面缓存目录、`playstate.json` 原子写

> 何时升级：当曲库真的上千首，再按 v2.0 §7.3 的扫描管线补。**不要提前支付规模成本。**

### 7.2 Schema（最小可用集）

```sql
folders(id, path)
tracks(id, path, folder_id, title, album, artist, album_artist,
       track_no, disc_no, year, genre, duration_ms, sample_rate,
       channels, bit_depth, bitrate, codec, size_bytes, mtime,
       rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak,
       added_at, last_played_at, play_count)
settings(key, value)
schema_version  -- 顺序迁移脚本；升级前备份 DB
```

（相比 v2.0：合并 albums/artists 为文本字段；去掉 playlists/playlist_items/lyrics/themes/images/scan_state —— 歌单与歌词暂不入库，主题降优先级。）

### 7.3 存放位置

`%LOCALAPPDATA%\TwilightEcho\`：`library.db`、`covers/`、`logs/`、`playstate.json`。

### 7.4 playstate.json

原子写（临时文件 + rename），每 5s + 关键事件 + 退出时；损坏回退 `.bak`。内容：曲目、位置、队列、循环模式、音量、EQ、输出设备。**不含登录凭据**（那些走 `safeStorage`）。

---

## 8. 性能预算（**重写**）

### 8.1 实测基线（不可再假设）

| 项 | 实测值 | 来源 |
|---|---|---|
| Electron Win x64 空窗口 + 1 渲染进程 | **≈279MB** 常驻 / ≈100MB 系统空闲差值（Release） | Elanis 基准 |
| Tauri 同条件 | ≈307MB / ≈187MB | 同上 |
| Wails 同条件 | ≈317MB | 同上 |

### 8.2 本项目目标

| 场景 | 目标 | 备注 |
|---|---|---|
| 应用空闲（Electron 已起） | **不做承诺**；工程上避免无谓泄漏即可 | v2.0 的 ≤90MB 不可达，已删（理由：Shell 基线 ≈279MB） |
| **引擎进程 RSS** | **≤60MB**（播放中） | 这是真正可控的部分 |
| 播放中 CPU（无 DSP） | <1% | — |
| 播放中 CPU（EQ + 重采样） | <3% | — |
| 最坏叠加（全部视觉效果 + DSP） | CPU <8% | 去掉内存增量预算 |
| **应用侧延迟** | **按硬件分档报告**（见 §3.3） | 板载独占 3ms 级 / USB 独占 9ms / 共享 10.16ms |
| 音频稳定性 | 30min 压力 0 xrun；长播 <1 xrun/10h | 独占最小缓冲 |
| 启动到发声 | <1s（本地文件） | — |
| Seek 响应 | UI <50ms / 声回 <150ms | — |
| 动效 | p95 <16.7ms | 开发机构建断言 |
| 曲库 91 首 | 首屏 <100ms | 规模下调，指标同步下调 |

**测点**：空闲 = 主窗显示后 60s；播放 = 96k/24bit FLAC 独占 5min 峰值+稳态。**引擎与外壳分开测**（v2.0 没区分，导致预算失真）。

---

## 9. 工程化（**大幅缩减**）

P1 = 只自用。据此删除：

| 删除 | 理由 |
|---|---|
| Inno Setup 安装包 | 自用，直接跑目录 |
| WinSparkle 自动更新 / appcast / 两阶段灰度 | 无分发 |
| signtool 签名 + 时间戳 | 无分发（SmartScreen 弹窗可接受） |
| Crashpad/sentry 上传 + 符号服务器 | 本地 dump 即可 |
| HKCU 文件关联 | 可选，非必须 |
| 首启向导三步 | 简化为设置页 |

保留：

| 保留 | 说明 |
|---|---|
| **Release 构建 + 便携目录** | 引擎 exe + Electron 产物放一起，双击即用 |
| **CMake Presets**（引擎） | 保证两个 AI 用同一套构建参数 |
| **单元测试**（Catch2/doctest） | 重点：DSP 黄金测试（标准 WAV → EQ/重采样/增益 → 频响 ±0.1dB）；RG 与 loudgain 对齐 ±0.05dB；标签/歌词解析器（含中文与损坏样本） |
| **压力测试脚本** | 30min 独占最小缓冲 = 0 xrun 断言 |
| **本地日志** | 环形缓冲 + 异步写；音频诊断段（xrun/缓冲史/设备变更史）单独文件 |
| **clang-format** | 引擎侧统一风格 |
| 隐私 | 自用，但仍保留"网络活动"页（自查哪个平台在什么时候被请求了） |

**CI 说明**：自用单人项目，**不建 CI**。RTSan 那条本来也只能在 Linux 跑，不值得为它建一条流水线。替代方案见 §3.2。

---

## 10. 里程碑

### 10.1 M1 —— "能听歌"（唯一验收标准，见 CONTRACT §2）

> **在 91 首 FLAC 上放出声；界面能看到歌词动画。**

| 步骤 | 交付 | 归属 |
|---|---|---|
| M1.1 | Electron + React 壳起得来，三区布局可见 | 前端 |
| M1.2 | 引擎空进程跑通（`hello`/`ready`，stdout 严格 JSON Lines） | 引擎 |
| M1.3 | `scan` 返回 91 首（TagLib 读标签） | 引擎 |
| M1.4 | 列表显示曲目；双击播放；**共享模式先放出声** | 双方 |
| M1.5 | 播放/暂停/停止/上下曲/Seek/音量 | 双方 |
| M1.6 | 歌词动起来（AMLL 或本地 LRC） | 前端 |

### 10.2 M2 —— "放得对"

WASAPI **独占** + 能力探测 + bit-perfect 明示 + EQ + ReplayGain + 双模式降级提示。

### 10.3 M3 —— "接我的账号"

网易云扫码登录（`api-enhanced`）+ 搜索 + 取流播放 + `yrc` 逐字歌词 + 风控约束。

### 10.4 M4 —— 曲库与体验

Navidrome 接入、迷你模式、SMTC、托盘、快捷键、智能续听。

### 10.5 已删除的 v2.0 阶段划分

- **阶段 0 的八项技术验证（S1–S8）→ 取消**。它们是为"未知风险"设计的；而本次修订已把主要未知（Slint 效果支持、RTSan 可用性、内存路线、独占周期）全部查清。剩下真正的未知只有两个：**引擎能不能在独立进程里稳定跑独占**、**平台层能不能登录成功**——这两条分别并入 M2 和 M3 的验收。
- **阶段 4"工程化收口"→ 取消**（§9 已缩）。
- **阶段 5"扩展"→ 收缩为 §6.3 的砍功能清单**。
- **"60MB 软渲染决策点"→ 删除**（已否决 Slint 路线）。

---

## 11. 风险登记册（重写）

| # | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| R1 | **平台 API 失效**（社区逆向，无官方兜底） | 高 | **高** | 平台层做成可插拔 provider；本地文件 + Navidrome 始终可用 |
| R2 | **账号风控/封号**（-460 有 24h 未恢复先例） | 高 | 中 | CONTRACT §5 的低频约束 + 令牌桶 + 失败即停 |
| R3 | **两个 AI 接口分叉** | 高 | 中 | CONTRACT 冻结 + 硬目录边界 + `contract-requests.md` |
| R4 | 实时 xrun / glitch | 中 | 中 | 压力测试 + 自适应缓冲 + 人工 RT 断言 |
| R5 | Electron 壳内存偏高 | 低 | **已发生** | 已接受（§8.1），不再当卖点 |
| R6 | USB 驱动独占劣化到 9ms | 中 | **高**（若用 USB DAC） | 能力探测 + 分档报告（§3.3） |
| R7 | 工期超支（业余 10–20h/周） | 高 | **高** | M1–M4 门禁；§6.3 已砍一半功能 |
| R8 | 中文衬线/等宽字体授权与渲染 | 低 | 中 | 自用；`@font-face` 直接引 |
| R9 | 蓝牙链路使 HiFi 失效 | 中 | **高**（P4） | 双模式明示（§3.3） |
| R10 | FFmpeg LGPL 合规疏漏 | 低 | 低 | 自用；沿用 `--disable-gpl --disable-nonfree` 构建脚本 |
| R11 | Folia 快速迭代使本项目功能落后 | 低 | 中 | 不与之在平台接入/歌词数据上竞争（§6.5） |

**已消除的风险**（v2.0 有、v2.1 无）：Slint 效果支持不足（改用 Web）、内存超预算（已接受实测值）、VST3 插件崩溃（移出范围）、平台接入法律风险（自用不发布）、更新机制被劫持（无更新机制）、中文 IME/字体 POC（Web 栈无此问题）。

---

## 12. 已删除章节说明

| v2.0 章节 | 处置 | 理由 |
|---|---|---|
| **§12 合规红线与发布清单** | **整章删除** | P1 只自用不发布；DRM 那条已并入 §6.4 |
| §9.3 打包/更新/安装 | 删除 | §9 |
| §9.4 崩溃上报/符号服务器 | 缩减为本地 dump | §9 |
| §10.1 阶段 0 八项验证 | 取消 | §10.5（未知已被本轮查清） |
| §3.7 VST3 宿主 | 移出范围 | §3.6 |
| §5.7 Slint 实现要点与降级预案 | **删除** | 已换栈；其内容被 §5.2 的能力对照表取代 |
| §2.4 选型对比表（Tauri/Flutter/Electron） | 更新为实测数据 | §2.3 |
| §3.6①②③④⑤ DSD 全套 | 大幅降级 | §3.5 |

---

## 附录 A · 关键常量（修正版）

```
【输出】
- 独占缓冲：能力探测决定；板载可达 3ms×2，USB 类驱动可能 9ms，上限 50ms 自适应
- 共享缓冲：设备最小周期 ×2；官方示例 default 448 帧 ≈10.16ms
- MMCSS "Pro Audio"：仅周期 <10ms 时有效
- 蓝牙：≥20ms
- Dither：输出 < 源位深时 TPDF；bit-perfect 禁用

【播放】
- 预解码：本地 ≥2s 前导
- 切歌淡出 5ms；采样率切换间隙 10–20ms 淡出/淡入
- 状态快照 100ms

【DSP】
- EQ：10 段 31.25–16k；RBJ peaking；Q 1.41（0.5–4 可调）；±12dB/0.5dB
      系数平滑 20ms；旁路 30ms 交叉淡变
- RG：目标 -18 LUFS（备选 -23/-16/-14）；防削波 -0.1dBFS；切换平滑 30ms
- 音量平滑 10ms

【DSD（如启用）】
- DoP：DSD64→176.4k / DSD128→352.8k；24bit；标记 0x05/0xFA 交替
       DSD256→705.6k 属规范外推（正文只到 128FS）
- 接收端需连续 32 个标记字节才切 DSD
- DoP 路径禁止一切 DSP

【平台层】
- 请求间隔 ≥1s；令牌桶；风控错误即停
- 凭据：safeStorage 异步 API（Electron 46 移除同步版）

【UI】
- 主题令牌 ≈35 项；切换插值 600ms / 颜料扩散 800ms；正文对比度 ≥4.5:1
- 动效 p95 <16.7ms
```

## 附录 B · 资源链接（修正版）

```
Electron       electronjs.org · github.com/electron/electron（注意 46 移除 safeStorage 同步 API）
Folia（参照）  github.com/chthollyphile/folia-major（AGPL-3.0，6165★）
网易云 API     github.com/NeteaseCloudMusicApiEnhanced/api-enhanced（原 Binaryify 版已 archived）
QQ API         github.com/Rain120/qq-music-api · github.com/yakult-green-tea/qq-music-api
Navidrome      github.com/navidrome/navidrome
OpenSubsonic   github.com/opensubsonic/open-subsonic-api（有 openapi.json 可生成客户端）
AMLL TTML DB   github.com/amll-dev/amll-ttml-db（CC0-1.0，逐词 TTML 事实标准）
FFmpeg         ffmpeg.org（现行稳定 9.0.2；legal.html 有合规清单）
TagLib         github.com/taglib/taglib（LGPL-2.1 / MPL-1.1）
SoXR           github.com/chirlu/soxr（停更于 2018-02）
libebur128     github.com/jiixyj/libebur128（停更于 2021-02）
SoundTouch     codeberg.org/soundtouch/soundtouch（已迁 Codeberg，GitHub 404 —— v2.0 链接是坏的）
VST3 SDK       github.com/steinbergmedia/vst3sdk（3.8+ MIT；VSTGUI/mda-vst3 示例除外）
Clang RTSan    clang.llvm.org/docs/RealtimeSanitizer.html（不支持 Windows）
公式参考       RBJ "Audio EQ Cookbook"；dCS "DoP Open Standard" v1.1（2012-03-30）
```

## 附录 C · 相对 v2.0 的变更清单（逐条 + 依据）

**A 类：事实性硬伤（已核实，必须改）**

| # | 位置 | v2.0 | v2.1 |
|---|---|---|---|
| A1 | §9.1/§9.2/S3 | RTSan 纳入 CI | **RTSan 不支持 Windows**（官方 README），改为人工断言 + 压力测试；如需则在 Linux/WSL |
| A2 | §2.3 | TagLib 选 MPL-**2.0** | 实为 **MPL-1.1** |
| A3 | §1/§3.4/§8 | "独占 3ms 周期 ×2 起步"、延迟 ≤6ms | 3ms **只是板载可达**；**USB 类驱动劣化到 9ms**；共享官方示例 10.16ms；<10ms 才升 MMCSS。改为**能力探测 + 分档报告** |
| A4 | §5.7 | OGL 纹理 API `create_from_borrowed_gl_2d_rgba_texture` | 该 API **自 1.2 起弃用**；但整节已随换栈删除 |
| A5 | 附录 B | SoundTouch GitHub 链接 | 已迁 **Codeberg**，原地址 404 |
| A6 | §3.6① | DSD256→705.6k 视为规范 | **属规范外推**（正文只到 128FS）；补"连续 32 标记字节"细节 |
| A7 | §2.2① | VST3 "整个 SDK" MIT | MIT 覆盖 SDK 本体；**VSTGUI 与 mda-vst3 示例是 BSD 式**；VST2 不在内 |

**B 类：被实测推翻的选型（改地基）**

| # | 位置 | 变更 | 依据 |
|---|---|---|---|
| B1 | 全篇 | Slint → **Electron + React/TS** | 三条核心效果平台层做不到（#2066/#3905/#6021）；1.18 默认后端内存反升（#13470）；AI 在 Web 栈动画成功率更高 |
| B2 | §2.4 | 选型对比表 | 换为 Elanis 实测：Electron 279MB < **Tauri 307MB** < Wails 317MB |
| B3 | §4.1 | "主引擎与 UI 同进程" | 改为**独立进程**（JSON Lines over stdio）：崩溃隔离 + **独占设备由引擎先取** |
| B4 | §3.3 | SPSC/共享内存/三缓冲 pull 模型 | 跨进程下改为事件推送；SPSC 仍在引擎**内部**使用 |

**C 类：范围调整（依据新前提）**

| # | 变更 | 依据 |
|---|---|---|
| C1 | 核心用途 → **平台账号接入**（类 Folia） | 用户明确 |
| C2 | §8 内存 ≤90MB → 不做承诺（Shell 基线 279MB） | Elanis 实测 |
| C3 | §7 曲库 10k → **91 首**，删 FTS5/断点续扫/多级封面 | 本机实测 |
| C4 | §3.7 VST3 宿主 → 移出范围 | 范围管理 |
| C5 | §3.6 DSD 全套 → 只留 DoP 直通 | 无 DSD DAC |
| C6 | 砍：音乐地图、指纹去重、聆听房间、场景模式、智能播放列表、变速变调、交叉淡入淡出 | 用户选择 + 范围管理 |
| C7 | §9 工程化：删安装包/更新/签名/崩溃上传/CI | 只自用 |
| C8 | **§12 整章删除** | 只自用不发布 |
| C9 | §10.1 阶段 0 八项验证 → 取消，并入 M2/M3 | 未知已被查清 |

**D 类：新增（v2.0 没有的）**

| # | 新增 | 理由 |
|---|---|---|
| D1 | **`CONTRACT.md`** 冻结契约书 | 两个 AI 不共享上下文，必须有一份共同语言 |
| D2 | 平台层 `MusicProvider` 接口 + 歌词归一化格式 | 同上；且 Folia 的实际形态就是"薄适配 + 外部 API 服务端" |
| D3 | 风控约束（§5） | 用户用主力账号 |
| D4 | 双模式明示（有线 HiFi / 蓝牙降级） | 用户实际用法 |
| D5 | 歌词源优先级（AMLL → 网易云 yrc → LRCLIB 兜底） | Folia 已接入 AMLL；LRCLIB 实测无词级 |
| D6 | §6.5 与 Folia 的边界表 | 避免在与 Folia 的正面战场重复劳动 |

---

**文档结束 · v2.1**
**下一步：M1（见 §10.1 与 CONTRACT §9）——两个 AI 各自先跑通自己那半的空壳。**
