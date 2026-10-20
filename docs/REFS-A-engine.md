# 外部参考资产 · 给 AI-A（引擎）

> **这不是契约。** 不影响 `CONTRACT.md` 与 `docs/SPEC-v2.1.md` 的权威性。两份来源，**许可不同**：
>
> | | 来源 | 许可 | 语言 | 怎么用 |
> |---|---|---|---|---|
> | **①** | **QueMusic** `BroNekoX/QueMusic`（211★） | **Apache-2.0** | Qt6/QML + C++20 | ✅ **可以直接抄代码**（保留版权声明） |
> | **②** | **ECHO** `Moekotori/ECHO`（1122★） | **AGPL-3.0-only** | Electron + TS + **C++** | ⚠️ **只学模式，不要复制代码** |
>
> **别把两边的代码混着搬。** 自用不分发时两者都不产生义务；但**若将来分发，AGPL 会传染整个仓库**。
> 读法：**不要整读任何一方**（QueMusic 自述文档 390KB；ECHO 的 `main.cpp` 单文件 160KB）。按下表定点取。
>
> **本文件 = 第一部分 QueMusic（§0–§6）+ 第二部分 ECHO（§E1–E6）+ 合并执行建议（§7）。**

---

## 0. 一句话结论（QueMusic）

它的音频层是**你的架构的一个更简单版本**：`FFmpeg 解码线程 → 无锁环 → 音频回调(DSP) → QAudioSink`。
**输出层不要抄**（它用 Qt `QAudioSink` 拉模式，"音频回调线程"其实是 Qt 定时器，不是 OS 实时线程；你的 WASAPI 事件驱动更强）。
**DSP 层值得抄**——它的 `AudioDsp` 正好是你 `PROGRESS.md` §5.4「M2 其余 L2：EQ（10 段 RBJ）、ReplayGain」要做的东西，而且是趟过坑的实现。

---

## 1. 直接可用：`cpp/audio/AudioDsp.{h,cpp}`（410 行 + 139 行头）

### 1.1 它的接口设计里有一条**必须学**的东西

```cpp
void setEqGains(const QList<qreal> &gainsDb);
// 音频线程专用：直接读数组，不构造 QList（回调内禁止分配）
void setEqGains(const double *gainsDb, int count);
```

**给自己留一个"裸指针、零分配"的重载。** 你的 SPEC §3.2 要求 RT 线程"无锁、无分配、无系统调用"，但如果接口只收容器类型，实现者**必然**违反——因为构造容器就是分配。这条把它变成接口层的约束，而不是纪律层的约定。

### 1.2 处理链的**精确顺序**（照抄这个顺序，不要自己排）

```
1) bypass?          → 只做 processVolume（跳过 EQ / 声道 / 限幅）
2) EQ               10 段 peaking biquad，逐样本；仅 gainDb != 0 的频段参与
3) 静态增益         gain = 10^(outputGainDb/20)
                    outputGainDb = preampDb + replayGainDb() - headroom
4) 声道工具         balance → mono → stereoWidth → swapChannels → channelGain[L]/[R]
5) 限幅             开：逐样本，attack 1.5ms / release 60ms 一阶平滑，再钳 ±1.0
                    关：逐样本硬裁剪 qBound(-1.0, v, 1.0)
6) volume × fade    逐样本（fade 进行中）或块级标量（fade == 1 时整块跳过）
```

**逐样本 vs 块级**（照它分，别一刀切）：

| 处理 | 粒度 | 原因 |
|---|---|---|
| EQ 10 段 | **逐样本** | 有状态滤波器 |
| preamp + RG − headroom | **块级标量乘** | 静态增益 |
| balance/mono/width/swap/channelGain | 逐样本（按帧，左右成对） | 它这么写，无状态但保持成对 |
| limiter | 逐样本 | 含增益包络状态 |
| 硬裁剪 | 逐样本 | **永远执行**（见 1.4） |
| volume × fade | fade 中逐样本，否则块级 | fade 状态在 DSP 内 |
| 时间伸缩 | 块级 | 你不做变速，忽略 |

### 1.3 参数表（与你 SPEC §3.5 的差异要留意）

| 项 | QueMusic | 你的 SPEC §3.5 | 处置 |
|---|---|---|---|
| 段数 | 10 | 10 | 一致 |
| 中心频率 | `31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k` | `31.25, 62.5, …, 16k`（1 倍频程） | 它用整数近似，你用精确倍频程——**用你的** |
| 滤波器 | RBJ peaking | RBJ peaking | 一致 |
| Q | 默认 **1.41**，范围 0.2–8.0 | 默认 **1.41**，范围 0.5–4 | 默认值一致；范围它更宽 |
| 增益范围 | **±24 dB** | **±12 dB / 0.5 dB 步进** | 你的更保守，**用你的**（±24 在音乐播放器上太容易削波） |
| 系数平滑 | 未提及（每次重算 biquad） | **≈20 ms 每样本插值** | **用你的**——这是你的方案更细的地方，它没有 |
| 旁路 | 开关式（跳过整条链） | **30 ms 交叉淡变** | **用你的**——硬切旁路会爆音 |
| auto headroom | `max(0, 所有波段 gainDb 的最大值)`，**不区分该段是否启用** | 你的 SPEC 写"自动前级" | 抄它的公式，注意"不区分是否启用"这个细节 |

> **结论**：参数表**以你的 SPEC 为准**（更保守、更细），**只抄它的两个公式**：auto headroom 的取法、preventClip 的取法（见下）。

### 1.4 ⚠️ 两个**反直觉的坑**（它踩过，会咬你）

**坑 1：旁路会连"硬裁剪"一起跳过。**

```
13. dspEnabled == false（bypass）会跳过 EQ、声道工具、限幅与硬裁剪，
    只保留音量与淡变 —— 也就是说关闭 DSP 后输出不会被钳到 ±1.0。
```

**后果**：关了 DSP 反而可能出现超 1.0 的样本 → 设备端溢出/爆音。
**你的决策**：既然你要做"旁路 30 ms 交叉淡变"，**别把硬裁剪放进被旁路的分支**——安全钳位应该永远生效。

**坑 2：关限幅 ≠ 不裁剪。**

```
14. 限幅关闭时仍逐样本硬裁剪 qBound(-1.0, v, 1.0)（float 溢出保护），
    不要误以为「关限幅 = 不裁剪」。
```

**采它的做法**：`limiter off` 时仍然 `qBound(-1, v, 1)`。这是 float 溢出保护，不是音质处理。

### 1.5 ReplayGain 的两个公式（直接可用）

```
outputGainDb = preampDb + replayGainDb() - headroom

replayGainDb = mode <= 0 ? 0
             : (mode == 2 ? albumGain : trackGain) + rgPreamp
             // preventClip && peak > 0 时：
             = min(replayGainDb, -20 * log10(peak))     ← 防削波上限

headroom = (autoHeadroom && eqEnabled) ? max(0, 所有波段 gainDb 的最大值) : 0
```

`peak == 0`（无标签）时**不作限制**——这个分支别漏。

### 1.6 它的 EQ 预设（可作参考，10 组，大小写不敏感）

`Flat, Rock, Pop, Jazz, Classical, Dance, Bass Boost, Treble Boost, Vocal, Loudness`
各 10 个增益值，源码在 `AudioDsp.cpp:26-37`。你的 SPEC 没提预设，属 M2 可选。

**一个它自己的小 bug（别照抄）**：`presetGains()` 未命中返回全 0，但 `applyEqPreset()` 仍把 `eqEnabled = true` —— 传空串会得到"空 EQ 但显示开启"。

---

## 2. 只能抄思路：`cpp/audio/AudioRing.h`（85 行）

**先说结论：你的 `src/ring_buffer.hpp` 已经比它好，不要换。** 对比：

| | QueMusic `AudioRing` | 你的 `PlanarRing` |
|---|---|---|
| 游标类型 | `quint64` 单调不回卷 | `uint64_t` 单调不回卷 | ✅ 都避开了溢出 |
| 防伪共享 | ❌ 无 `alignas` | ✅ `alignas(64)` 在游标上 |
| 数据布局 | 交错（interleaved） | **planar**（channel-major） | ✅ 你的符合 SPEC §3.2 |
| 通道遍历 | 单缓冲 | 每通道一段连续拷贝 | ✅ 你的免 stride |

**但它有一条注释替你确认了一个 bug 类别**：

```
// 取模只在落盘索引时做，游标本身永不复位：48kHz 下 int 会在约 6 小时后溢出
```

你已经用 `uint64_t` 避开了。**保留你的实现。**

**唯一值得留意**：它的 `configure()` **会 resize**，注释明确要求"必须冻结两个音频线程"。你的 `configure()` 也是 `data_.assign(...)`——同样会重新分配。**确认调用点只在消费者停靠时执行**（你的注释已经写了"Only call while the consumer is parked"，很好；要确认 `player.cpp` 真的做到了）。

---

## 3. 值得偷的知识：`cpp/audio/FfmpegDecoder.cpp`（383 行）

你用 dr_libs + SoXR（没有 FFmpeg），但**下面几条与库无关，是音频解码的通用规律**：

### 3.1 `thread_count = 1` 的理由（原文注释，值得抄进你的代码）

```
音频解码用不上帧级多线程：thread_count=0 会让 FFmpeg 按 CPU 核数创建线程上下文
及其私有缓冲（16 核即 16 份）。固定 1：48kHz 立体声的解码开销远小于一个线程
上下文的代价，而线程数与常驻缓冲会一直挂着。
```

**对你的意义**：如果你将来为流媒体引入 FFmpeg，**第一件事就是设 `thread_count = 1`**——否则单曲解码会挂 16 份线程上下文+buffer，直接顶穿 `SPEC §8.2` 的引擎 ≤60MB RSS。

### 3.2 seek 的正确姿势（你 `PROGRESS.md` §6 承认"SoXR 相位不连续，可能有极轻的咔哒"）

它的做法，比"丢弃 SoXR 内部缓冲"更完整：

```
1. avformat_seek_file(..., AVSEEK_FLAG_BACKWARD)   // 偏向关键帧之前
2. avcodec_flush_buffers(codecCtx)                  // ← 你缺的这步的等价物
3. swr_init(swr)                                    // ← 重采样器状态重置（不是丢弃）
4. 逐帧用 PTS 丢弃到目标位置（m_skipUntilMs）
5. 若目标落在帧中间，按 dropMs * outRate / 1000 设样本级偏移
```

**关键差异**：它是 `swr_init`（**重置**重采样器状态），不是"丢弃内部缓冲"。
**你的 SoXR 等价物**：`soxr_clear()` 会重置内部状态，比丢弃缓冲更接近"相位正确"。但这会引入输出不连续——它靠**样本级偏移**补偿。

> 你的 `Resampler::resetBuffers()` 注释说"丢弃比证明对齐更便宜"。**这个取舍在 M1 是合理的**。但 `PROGRESS.md` §6 把它列为已知限制——现在你有了一个更完整的参考实现，M2 可以做对。

### 3.3 其他可直接用的常量

| 常量 | 值 | 说明 |
|---|---|---|
| `kSeekThrottleMs` | **90** | 解码线程 seek 节流——拖动进度条会连发请求，**你也会遇到**（你的 `seek` 实测 32ms，很快，但连续拖动会堆积） |
| `kRingSeconds` | 2 | 每环容量 = 2s × rate |
| `kMaxChunkFrames` | 4096 | 解码块 / 渲染块 |
| `kBufferMsMin/Max/Default` | 10 / 100 / 30 | 设备缓冲（注释：再小易爆音，再大拖慢响应） |
| `kMinBufferFrames` | 256 | 缓冲帧数下限（10ms@48k 仅 480 帧） |
| `kClickGuardMs` | **12** | 每次换段的最小淡入，**消切换爆音** |

**`kClickGuardMs = 12` 这条对你特别有用**：你的 gapless（SPEC §3.7）要在同专辑曲目间做采样级拼接，但**任何一次段切换都需要 ≥12ms 淡入**——否则拼接点会有咔哒。它把这个值固化成常量，而不是每个调用点自己拍。

### 3.4 淡变在音频线程逐样本完成

```
// 淡变在音频线程逐样本完成，与 GUI 调度无关
void rampFade(double target, int frames);   // frames = ms * max(8000,outRate) / 1000
void jumpFade(double target);
void fadeInOnNextAudio(int ms);  // 记 pending，换段时才真正淡入
```

**`fadeInOnNextAudio` 这个语义值得抄**：切歌的淡入跟随"新音轨真正出声"的那一刻，而不是靠 UI 计时器猜时间。你的 SPEC §3.4 说"切换间隙 10–20ms 淡出/淡入"——用这个语义实现才对。

---

## 4. 最值钱的一个：`cpp/WindowsSmtcManager.cpp`（**977 行**）

### 4.1 为什么这个归你（归引擎），不归应用侧

你的 SPEC §6.5 列了 SMTC，但你的架构里 **Electron 侧没有现成方案**。而：

- **引擎进程就是 C++、就握着 WASAPI、就是 Windows 原生**
- 把 SMTC 做进引擎、通过 stdio 广播状态，比在 Node 里硬啃 WinRT 干净得多
- 它的实现**直连 WinRT ABI，不依赖 WRL**（MSVC 与 MinGW-w64 都可）

### 4.2 接口清单（可直接照抄的形状）

```cpp
initialize(QWindow *window);       // 需在窗口显示后调用
shutdown();
setControlsEnabled(bool play, bool pause, bool next, bool previous);
setPlaybackStatus(int status);     // 对应 Windows.Media.MediaPlaybackStatus
updateMediaInfo(title, artist, album, cover, mediaId);
updateTimeline(qint64 posMs, qint64 durMs);   // 每 5 秒一次即可

signals:
  playPressed / pausePressed / nextPressed / previousPressed
  seekRequested(qint64 positionMs)   // 由 PositionChangeRequested 触发
```

**它趟过的三个难点**（你抄的时候不用重踩）：
1. 媒体信息更新（标题/艺术家/专辑/封面，含封面 URL）
2. **按钮事件可能由 WinRT 工作线程调用** → 它做了线程安全入口 `postButtonPressed`
3. **时间线拖动**（`PositionChangeRequested`）→ 映射成 `seekRequested`

### 4.2.1 依赖已被核实：**零第三方，可直接搬**（这是它最值钱的一点）

深度审计确认（读源码，非文件名猜测）：

- **只依赖 Windows SDK 基础 COM + WinRT ABI**。文件头注释（`WindowsSmtcManager.cpp:10`）：*"直连 WinRT ABI（不使用 WRL），MSVC 与 MinGW-w64 均可编译"*
- 文件内**自带 IID GUID** 与**按 MIDL vtable 顺序手写的接口声明**（`:130-138`、`:260-314`）——你把 WinRT 那套最烦的样板都省了
- CMake 侧只需链：`runtimeobject ole32 shell32 advapi32 crypt32`
- 完整度：标题/歌手/专辑/封面（`ISystemMediaTransportControlsDisplayUpdater` + `IRandomAccessStreamReference` Thumbnail）、`UpdateTimelineProperties` 进度、`PositionChangeRequested` 拖动 seek、四个按钮回调

> **这是全仓库对引擎最划算的一个文件**：977 行、零依赖、正是你 SPEC §6.5 的缺口。见 §4.3 关于 HWND 与改契约的提醒。

### 4.3 落到你的架构

SMTC 要 `QWindow`（子类化窗口句柄）。你的引擎**没有窗口**——它有 HWND 吗？没有的话两条路：

- **A（推荐）**：引擎进程内创建一个**隐藏消息窗口**（message-only window），用它的 HWND 初始化 SMTC。这样 SMTC 完全归引擎，通过 `ev` 把按钮事件广播给应用侧。
- **B**：把 SMTC 留在 Electron 侧（用 Node 的 WinRT 绑定）。**不推荐**——生态薄弱，且要重复处理线程问题。

**如果要走 A，需要改契约**：新增 `ev` 类型（如 `smtc_button`、`smtc_seek`）与命令（`smtc_update`）。**走 `docs/contract-requests.md` 正规流程**，不要自己加字段。

### 4.4 许可提示
`SMTC-Bridge-Cpp` / `smtc_bridge_rust`（Cainongw）是它致谢里的 SMTC 参考实现——如果那 977 行有不好理解的地方，可以去那里看原始出处。

---

## 5. 明确**不要**抄的

| 部件 | 原因 |
|---|---|
| `QAudioSink` 输出层 | 拉模式 + Qt 定时器驱动，**不是 OS 实时线程**。你的 WASAPI 事件驱动 + 独占协商是更强的东西 |
| `AudioEngine` 整体（1338 行） | 与 Qt/QML 深度耦合（`Q_PROPERTY`、信号、`postToSelf`）。你的是 stdio 协议 + 独立进程，架构不同 |
| `PitchShifter` / `TimeStretch`（SOLA） | 变速变调已从你的 SPEC §6.3 砍掉 |
| 着色器 / QML / 插件系统 | 框架不同 |
| 它的 `readFrames` 返回约定 | 头文件说 `-1 = 出错`，实现从不返回 -1——**以实现为准**，别照抄它的注释 |

---

## 6. 补充：两条独立结论（一条可直接用，一条是分歧）

### 6.1 它踩过的一个 SQLite 坑：**不要默认用 WAL**

如果曲库落在 SQLite（你已有 `catalog.cpp`），这条值得先看——**反直觉但理由是真的**：

```
DbService.cpp:63  故意用 PRAGMA journal_mode = DELETE（而非 WAL）
```

它的注释给的理由：**WAL 会产生 `-wal` / `-shm` 副文件，被杀软或同步盘（OneDrive/网盘）拦截后整库变只读**。

**给你的决策依据**：
- 你的库在 `%LOCALAPPDATA%\TwilightEcho\`（SPEC §7.3），**不在同步盘**——风险比它低
- 但"杀软拦截副文件"与目录无关，Windows 上真实存在
- **WAL 的好处**（读写并发、更少 fsync）对你 91 首的规模**基本用不上**

**建议**：跟它一样用默认（DELETE），或至少**知道这个权衡的存在**——别因为"WAL 更现代"就无脑选它，然后在某台机器上遇到"库突然只读"却查不出原因。

**顺带两条它的 DB 经验**：
- 含 `addColumnIfMissing` 增量迁移 + **可写性探测（真建表试写）** —— 后者比"检查文件权限"可靠
- 换目录时 `migrateFrom` 搬库（不是重建）—— 你的 SPEC §7.2 有 `schema_version` 顺序迁移，思路一致

---

### 6.2 【分歧说明】关于 `AudioRing.h`：审计建议"直接换掉我们的"，**我不同意**

深度审计的结论是「48 行实现，**直接可用**」，并建议**换掉你的自研缓冲**。**这条我不采纳**，理由是实测对比：

| | QueMusic `AudioRing` | 你的 `PlanarRing` |
|---|---|---|
| 游标 | `quint64` 单调不回卷 | `uint64_t` 单调不回卷 | 平手 |
| 防伪共享 | ❌ 无 `alignas` | ✅ `alignas(64)` 在**两个游标上** | **你赢**（SPEC §3.2 明确要求） |
| 数据布局 | **交错**（interleaved） | **planar**（channel-major） | **你赢**（SPEC §3.2 要求 float32 planar） |
| 通道拷贝 | 单缓冲 | 每通道一段连续 memcpy，免 stride | **你赢** |
| 容量语义 | `available()` 夹到 `INT_MAX`（因返回 `int`） | 返回 `size_t`，无夹取需求 | 平手 |

**结论：保留你的实现。** 它的价值只在**注释确认了一个 bug 类别**（`int` 游标 48kHz 下约 6 小时溢出）——你已经用 `uint64_t` 避开了。

**唯一要核对的一件事**：它的 `configure()` 会 **resize**，注释要求"必须冻结两个音频线程"（否则音频线程手里还攥着旧指针 → 踩坏堆）。
你的 `configure()` 同样是 `data_.assign(...)`。你的注释写了 *"Only call while the consumer is parked"* —— **去 `player.cpp` 确认调用点真的做到了**，别让注释成为唯一的保证。

---

## 7. 【第一部分小结】QueMusic 的执行建议

**按性价比排序**：

| # | 动作 | 章节 | 量级 | 备注 |
|---|---|---|---|---|
| **1** | 抄 **`WindowsSmtcManager.cpp`** → 补 SMTC 缺口 | §4 | 977 行，**零依赖** | 但**先解决 HWND 从哪来**，并**走 CR 流程改契约** |
| **2** | 抄 **`AudioDsp`** → M2 的 EQ / ReplayGain | §1 | 410 行 | 抄顺序 + 两个公式 + 两个坑；**参数表用你自己 SPEC 的** |
| **3** | 用 **`journal_mode` 的决策**（是否用 WAL） | §6.1 | 一行 | 反直觉但理由真实 |
| **4** | **`kClickGuardMs = 12`** 用于 gapless 拼接点 | §3.3 | 一个常量 | 消切换爆音 |
| **5** | 若将来引入 FFmpeg：**先设 `thread_count = 1`** | §3.1 | 一行 | 否则 16 核 = 16 份线程上下文，顶穿 ≤60MB |
| — | ~~换掉你的 ring buffer~~ | §6.2 | — | **不要做**（你的实现更好） |

**做 M2 的 EQ 时**：先读它的 `AudioDsp.cpp`（410 行，一次读完），把处理链顺序、auto headroom 公式、preventClip 公式、以及两个坑（bypass 跳过裁剪 / 关限幅仍裁剪）抄进你的实现。

**做 SMTC 时**：读那 977 行，但**先想清楚 HWND 从哪来**，并**先走 CR 流程改契约**（新增 `ev`/`cmd` 属于契约变更）。

---

## 第二部分 · ECHO（`Moekotori/ECHO`，AGPL —— **只学模式，不要抄代码**）

> ⚠️ **许可警告**：ECHO 是 **AGPL-3.0-only**，且是 Steam 商业产品的社区版。
> 自用不分发时你无义务；**但若将来分发，抄它的代码会传染整个仓库**。所以第二部分**只给模式与依据，不给可复制的代码**。
> （对比：第一部分 QueMusic 是 Apache-2.0，可以直接抄。）

---

## E1. 它和你是同一套架构 —— 而且它踩了你绕开的坑

README 徽章：`Renderer: React + TypeScript` / `Bridge: Typed IPC` / `Main: Electron` / `Library: SQLite` / `Audio: Audio Core + Native Host`。

**它的原生目录树（从仓库 API 取，非猜测）**：

| 文件 | 大小 | 说明 |
|---|---|---|
| `native/audio-host/src/wasapi_shared.cpp` | **58.5 KB** | WASAPI 共享 |
| `native/audio-host/src/wasapi_exclusive.cpp` | **49.7 KB** | WASAPI 独占 |
| `native/audio-host/src/asio_host.cpp` | **76.2 KB** | ASIO |
| `native/audio-host/src/PcmRingAudioSource.cpp` | **45.1 KB** | PCM 环 + 输出回调 |
| `native/audio-host/src/main.cpp` | **160.1 KB** | host 主程序（device.configure 校验与 backend 打开） |
| `native/audio-host/src/NativePlaybackPipeline.cpp` | 37.6 KB | 路由 / SRC / SDM |
| `native/audio-engine/JsonRpcProtocol.cpp` | 46.9 KB | 控制协议 |
| `native/audio-host/src/miniaudio_output.cpp` | 11.7 KB | 另一个共享输出后端 |

**注意它把 WASAPI 共享与独占拆成两个文件**（58.5 + 49.7 KB），而你的 `output_wasapi.cpp` 是 34.8 KB 管两者。拆开通常意味着**内部事件模型差异较大**——值得去它那两个文件里看它怎么分（**看结构，不是抄代码**）。

### E1.1 ⭐ 最重的一条：它的迁移文档解释了"为什么必须独立进程"

原文（`docs/ECHO_NEXT_NATIVE_AUDIO_PIPELINE.md` §1）：

> 旧链路让 Electron 主进程参与本地文件读取、解码后的 PCM 搬运和格式 DSP。主线程出现 GC、IPC 高峰、封面处理或其他短暂停顿时，PCM 生产也可能跟着停顿；输出端耗尽缓冲后会卡住，恢复时进度和音频又可能突然追赶，表现为**"卡一下、播放也卡、然后跳一大段"**。
> 本次迁移的目标不是继续调大 JavaScript 缓冲，而是**切断主进程调度抖动与实时音频数据面的耦合**。

**这是你从第一天就避开的**（CONTRACT §3 铁律 2「音频样本绝不穿越此通道」+ 独立进程 + 引擎持有全部数据面）。

它留下的迁移痕迹可以验证这条：**被删除的文件**里有
`src/main/audio/EchoSrcFirWorkerTransform.ts`、`PcmToDsdDoPTransform.ts`、`transforms/PcmDitherTransform.ts`
——**全是"在 JS 里处理 PCM"的产物**。

**给 Owner 的备忘**：这条是"独立进程架构"最有力的外部佐证。如果将来有人问"为什么不用 napi 同进程加载引擎"（你的 CONTRACT §1 选了子进程），这份文档就是答案。

### E1.2 但它也划了一条边界：**控制面必须留 TS**

原文（同文档 §2）：

> 关键边界：主进程仍会生成 ECHO SRC 的 FIR 方案和 taps，但这只是**一次性控制配置**；逐帧卷积发生在 native host。
> **不要把"主进程生成系数"误解成"主进程仍在处理 PCM"。**

**这条和你 SPEC §8.2 的"引擎 ≤60MB RSS"直接相关**：你现在的 DSP 参数（EQ 系数、RG 增益）全部在引擎内计算。**这不是必须的**——设计放 TS、应用放 C++ 能省引擎的 CPU 与内存，代价是多一次握手。

**但不要现在就改**：你的引擎已经跑通且指标达标（RSS 51.4MB）。**这是记录在案的备选方案，不是待办。**

---

## E2. ⭐ 可直接对照的实现：`DspRackOrder.h`（1196 字节）

它是一个 **8 模块可重排的 DSP 机架**，而你的 SPEC §4.2 写了"三缓冲/seqlock"却**没有实现**。这是真实对照：

```
模块顺序（默认）：Equalizer → Convolution → ReplayGain → Compressor
                → Crossfeed → StereoField → ChannelMatrix → ChannelBalance
```

**核心是 seqlock 的用法**（原文注释）：

> JSON-RPC is the single writer. The audio thread reads a coherent fixed-size snapshot
> through this seqlock **without allocation, mutexes or shared_ptr traffic**.

```cpp
// 注释里的关键设计（不要改语义）
std::atomic<unsigned int> sequence_ { 0 };          // 写者自增，读者校验奇偶
std::array<std::atomic<int>, moduleCount> order_;   // 定长快照，无分配
```

**给 `player.cpp` 的三点启示**：

1. **定长 `std::array` + 原子序号**，而不是 `std::vector` + 锁 —— 你的 DSP 参数快照可以照这个形状做
2. **单写者 = 控制面**（它的是 JSON-RPC），**读者是音频线程**，全程无锁无分配
3. **顺序本身是可配的** —— 8 个枚举的排列而已，完全可以由 TS 下发。**你的 DSP 链现在是写死的**

> ⚠️ 它的 `DspRackModuleId` 里有 `Convolution`（房间校正卷积）、`Crossfeed`、`StereoField`、`ChannelMatrix`
> ——**这些都在你的"不做"清单里**（SPEC §6.3）。**只取 seqlock 模式，不要取整个机架**。

---

## E3. ⭐ 协议形态：两级 ready + `operationId`

它的协议文档（`native/echo-audio-daemon/docs/protocol-spec.md`）有三件事值得对照你的 CONTRACT §3：

### E3.1 两级 ready（你的 `ready` 只有一级）

```json
{"ready":true,"readyLevel":"process"}                                      // 进程活了，无设备
{"ready":true,"readyLevel":"device","sr":48000,"ch":2,"buffer":4096}       // 设备已开
```

**为什么这有用**：你的 `ready` 在进程起来时就发，但**设备能否打开是之后才知道的**。分两级后，应用侧能区分「引擎没起来」与「引擎起来了但设备打不开」——这正是你 SPEC §3.3 能力探测要表达的东西。

### E3.2 ⭐ `operationId` —— 你缺的"过期响应"的协议级解法

```
audio.position  →  {framesPlayed, bufferedFrames, inputEnded, operationId}
audio.ended     →  {operationId} 或 {operationId, queueAdvance, gaplessAdvance, nextTrackId, ...}
audio.openFile  →  {status:"probed", operationId:1, filePath, sampleRate, channels, durationSeconds, codec, ...}
```

**每个操作有 id，通知带着它回来。** 这比我上次给 B 侧建议的 "用 `trackId` 比对" **更干净**——因为同一首歌连续播放时 trackId 会重复，而 operationId 不会。

> **这条建议走 CR 流程**：CONTRACT §3 加一个 `operationId` 字段是**契约变更**，你我都要同意。见 §E3.4。

### E3.3 `inputEnded` 与 `drained` 必须分离（你已有，但要确认）

原文（§3）：

> - `inputEnded = true`：解码器不再产生新数据。
> - `isDrained() = true`：输入已结束并且输出 FIFO 已经播放完。
>
> 如果在 decoder EOF 时直接判定 ended，**尾部会被截断**，自动切歌和进度也会再次出现跳变。

**你的 `player.cpp` 有 `ended` 事件**（`reason: "eof"`）。**去确认它是在"输出 drain 完"之后发的，而不是解码器 EOF 时发的**——如果是后者，你会在**每首歌的尾部丢一小段**，而这件事在手动测试里几乎发现不了（差几十毫秒）。

> 你在 `PROGRESS.md` 的坑 #4 记过类似的问题（"seek 后 end-of-stream 再也到不了"），
> 说明这类"时间点判定"的坑对你特别有效。**这条是同类的。**

### E3.4 ⭐ `gaplessPrepare` 的 `following[]` 与"别用元数据估时长"

```json
{"method":"audio.gaplessPrepare",
 "params":{"filePath":"...02.flac","trackId":"track-02","itemId":"queue-02","sampleRate":48000,
           "following":[{"filePath":"...03.flac","trackId":"track-03","itemId":"queue-03"}]}}
```

文档里的两条硬规则：

> 该调用只有在**下一首的第一个 PCM 块已被接受**之后才成功。
> **Track changes are committed from decoded frame counts, never metadata duration estimates.**

**对你的 SPEC §3.7 gapless 的两点直接价值**：

1. **`following[]` 是数组**（不只是"下一首"）——支持连续多首预排
2. **"用解码帧数，不用元数据时长"** ——你的 SPEC §3.7 写"同专辑（album + album_artist + 连续 track_no）"判定，但**没有说切歌点用哪个时间源**。元数据里的 duration 和实际解码帧数会差几十毫秒（尤其是 VBR MP3），**用元数据就会在拼接点露馅**。

> 它的注释也给了失败语义：*"fail-closed for unsupported processing modes. The caller must continue ordinary playback when it returns an error; it must not route back to the legacy concat implementation."*
> ——**失败就退回普通播放，不要退回旧的拼接实现**。这条原则对你的降级链同样适用。

---

## E4. 不要抄的部分（它比你重得多，而且是有原因的）

| 部件 | 量级 | 为什么不要 |
|---|---|---|
| `asio_host.cpp` | 76.2 KB | 你暂无 ASIO 硬件（SPEC §6.3 已降级），且它随库存了完整 ASIO SDK |
| `wasapi_shared.cpp` / `wasapi_exclusive.cpp` | 58.5 / 49.7 KB | 你的 34.8 KB 已跑通并实测出本机驱动限制 |
| `NativeSdmProcessor` + `CudaSdmProcessor.cu` | 8.6 KB + 30.5 KB | PCM→DSD 调制，你已砍（SPEC §3.5） |
| `CudaFirProcessor.cu` + `cuda_fir.cu` | 24.2 + 17.9 KB | CUDA FIR；它的文档自己说**当前报告 `native_dsp_cpu_authoritative`**，即 CUDA 尚未成为权威路径 |
| `ConvolutionProcessor` / `SpatialDspProcessor` / `CompressorProcessor` | 19.8 / 7.6 / 6.1 KB | 房间校正 / 空间音频 / 压缩器，都在你的"不做"清单 |
| `AutomixTempoProcessor` | 6.1 KB | 自动混音，你已砍 |
| `libav_decoder.h` | 26.4 KB | 它走 FFmpeg（随包 115 MB）；你用 dr_libs + SoXR |
| `miniaudio.h` | **4.1 MB** | 单头文件库，它用来做另一个共享输出后端 |

**它随包分发的 FFmpeg**：`avcodec-62.dll` **92.9 MB** + `avformat-62.dll` 19.3 MB + `avutil-60.dll` 3 MB + `swresample-6.dll` 0.46 MB ≈ **115 MB**。
你用的是 dr_libs + SoXR（单头/小库）。**这是你有意识的交换**（换体积，牺牲格式覆盖）——
**但 SPEC §6.3 引流媒体后，网易云返回的 M4A/AAC 你的 dr_libs 覆盖不到**。这条要记着（见 §E6）。

---

## E5. 实测数字：它的内存不是在吹

README 截图（**16,813 首 / 1,856 专辑，播放中**）：**589.2 MB 内存、1.1% CPU**。

**对你的意义**：SPEC §8.1 引用 Elanis 基准得出"Electron 空窗口 ≈279MB"。
**加上真实曲库 + 原生宿主 + FFmpeg，落点接近 589MB。** 你的引擎自己只有 51.4 MB（达标），
但**整套应用的真实量级应该按这个数预期**——引用预算时用 589 而不是 279。

---

## E6. 关于 SMTC：两条独立路线都选了"不要在 Node 里做 WinRT"

| 来源 | 做法 | 体量 |
|---|---|---|
| QueMusic | C++ 直连 WinRT ABI（第一部分 §4） | 977 行，**在应用进程内** |
| **ECHO** | **独立原生进程** `echo-smtc-host.exe` | **15.6 KB** |

**两个互不相关的项目，都避开了在 Node/JS 里做 WinRT。** 这强化了第一部分 §4.3 的建议。

**而 ECHO 的做法给了你第三条路**：既不做进引擎（避免引擎承担窗口/系统集成职责），也不在 Node 里做，而是**再开一个极小的原生进程**。

**你的选择**（三选一，都要走 CR 流程）：

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 做进引擎（第一部分 §4.3 原建议） | 少一个进程 | 引擎要拿 HWND，职责变杂 |
| **B. 独立原生进程**（ECHO 路线） | **职责最干净**，15.6 KB 量级的先例 | 多一个进程 + 多一套生命周期管理 |
| C. Node 侧 WinRT 绑定 | 少写 C++ | 生态薄弱，两条独立路线都不选它 |

> 我倾向 **B**：它和你的"引擎只做音频"边界最一致，且 ECHO 证明了 15.6 KB 就够。

---

## E7. 它证明了你的架构是对的，也标出了你的上限

**它的功能表里有你砍掉的全部东西**：DSD/DoP/SDM、ASIO Native DSD、CUDA FIR、房间校正卷积、8 模块可重排 DSP、automix、AirPlay、Echo Link 局域网串流、创意工坊、壁纸引擎桥接。

**它是团队 + Steam 商业产品**：1122★、41 fork、有 Android 独立仓库、仓库里有 `private/echo-pro-activation/`（激活服务器）与 `private/echo-pro-cloud/`（云同步后端，含 nginx + systemd）；文档里的协作规则写着"方便**多人**并行 review 和回滚"。

**你是一人 10–20h/周。**

**结论**：它的存在**证明你的架构选择与一个商业产品一致**（这是好消息，也是最好的架构验证）；
但它同时说明 **"超越 ECHO" 不是可行目标**。你的目标是 SPEC §1.1 那条——
**"做一个自己用得上的、架构干净的播放器"**，且它的证据让你可以**省掉一些它交过学费的弯路**。

---

## 8. 合并执行建议（两部分的优先级放在一起）

| 优先级 | 动作 | 来源 | 量级 | 备注 |
|---|---|---|---|---|
| **P0** | 抄 **seqlock 快照模式** → DSP 参数 / 状态发布 | ECHO §E2 | 1196 字节对照 | 你 SPEC §4.2 写了却无实现 |
| **P0** | 确认 **`ended` 在输出 drain 后发**（不是解码 EOF） | ECHO §E3.3 | 查一次 `player.cpp` | 否则**每首尾部丢一小段**，手动测不出 |
| **P0** | 抄 **`WindowsSmtcManager.cpp`**（零依赖）或走独立进程 | QueMusic §4 / ECHO §E6 | 977 行 或 15.6 KB | **先想清 HWND，且先走 CR** |
| **P1** | **`gaplessPrepare` 的 `following[]` + "用解码帧数不用元数据时长"** | ECHO §E3.4 | 一个约定 | 你的 SPEC §3.7 没定时间源 |
| **P1** | 抄 **`AudioDsp`** → M2 的 EQ / ReplayGain | QueMusic §1 | 410 行 | 抄顺序 + 两个公式 + 两个坑；**参数表用你自己 SPEC 的** |
| **P2** | **两级 ready（process / device）** | ECHO §E3.1 | 协议小改 | 走 CR |
| **P2** | **`operationId`** 加进 CONTRACT §3 | ECHO §E3.2 | 协议变更 | **走 CR**；比 trackId 干净 |
| **P2** | `kClickGuardMs = 12` 用于拼接点 | QueMusic §3.3 | 一个常量 | 消切换爆音 |
| **P3** | 若引入 FFmpeg：先设 `thread_count = 1` | QueMusic §3.1 | 一行 | 否则 16 核 = 16 份上下文 |
| **P3** | 重新评估 dr_libs 的格式覆盖（M4A/AAC） | ECHO §E4 | 调研 | 引流量后网易云会返回 M4A |
| **P3** | 记下"SQLite 是否用 WAL"的决策 | QueMusic §6.1 | 一行 | 反直觉但理由真实 |
| — | ~~换掉你的 ring buffer~~ | QueMusic §6.2 | — | **不要做**（你的更好） |
| — | ~~抄 ECHO 的任何代码~~ | 许可 | — | **AGPL**：只学模式 |

**做 M2 的 EQ 时**：先读 QueMusic 的 `AudioDsp.cpp`（410 行，一次读完），但**先做 P0 的 seqlock**（ECHO 那份对照）——因为 DSP 参数快照是 EQ 的前置。

**做 SMTC 时**：读 QueMusic 的 977 行（要抄就抄它，Apache-2.0 干净），参考 ECHO 的**独立进程**形态；**先想清楚 HWND 从哪来**，并**先走 CR 流程改契约**。

---

## 附：取文件的方法

**定点取单个文件**（两边都适用）：

```
https://raw.githubusercontent.com/BroNekoX/QueMusic/main/<path>
https://raw.githubusercontent.com/Moekotori/ECHO/main/<path>
```

**ECHO 关键路径**（只学模式，不要整读）：

```
native/audio-engine/DspRackOrder.h                        1196 B  ← 最值得看的一个
native/echo-audio-daemon/docs/protocol-spec.md            7134 B  ← 完整协议定义
docs/ECHO_NEXT_NATIVE_AUDIO_PIPELINE.md                  12946 B  ← 迁移原因与硬性规则
docs/ECHO_NEXT_AUDIO_CORE.md                             13497 B  ← 模块职责与状态机
docs/ECHO_NEXT_ARCHITECTURE.md                           12412 B  ← 七层分层
native/audio-host/src/AudioDaemon.h                       9600 B  ← daemon 接口
native/audio-host/src/NativePlaybackPipeline.h            8823 B  ← 管线接口
native/audio-engine/JsonRpcProtocol.h                     4290 B  ← 协议头
```

**QueMusic 关键路径**：见本文件末尾（已在第一部分列出）。

**稀疏克隆**（比逐文件抓取可靠，两边都适用）：

```
git clone --filter=blob:none --sparse https://github.com/<owner>/<repo>.git
cd <repo> && git sparse-checkout set <需要的目录>
```
—— QueMusic 取 `cpp doc` 约 5.9 MB；ECHO 取 `native/audio-engine native/echo-audio-daemon/docs docs` 会小得多（**不要取 `native/audio-host`，`main.cpp` 单文件 160KB**）。

> ⚠️ **不要整读的东西**：QueMusic 的 `api/QCloudMusicApi/module.cpp`（5157 行，它自己的文档写"第三方，勿读勿改"）；
> ECHO 的 `native/audio-host/src/main.cpp`（**160 KB**）、`native/audio-host/tests/audio_engine_tests.cpp`（**156 KB**）、
> `native/audio-host/third_party/miniaudio.h`（**4.1 MB**，第三方单头库）。
> 也不要一次读完全套 `doc/project/`（约 390KB）——先读索引再只开命中的 1–2 个分片。
