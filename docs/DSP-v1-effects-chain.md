# 音效链方案 v1（声场 / 声道 / 电平监测）

> 上位：[`CONTRACT.md`](../CONTRACT.md)、[`docs/SPEC-v2.1.md`](SPEC-v2.1.md)
> 本文件规划 **SPEC §3.8「L2 音频质量」的一个新子层**：`音效链`（Effects Chain）
> 日期：2026-10-15 · 状态：**待 owner 批准后按 §9 顺序实施**

---

## 0. 定位：与 bit-perfect 严格互斥（owner 已裁定）

**SPEC 两处把「聆听房间/空间音频」列为 Won't**（§3.8 功能分层、§6.3 砍功能清单），
理由是「大幅工程，且与"听清原音"的 HiFi 目标相冲」。

**owner 裁定：定位为「音效链」，与 bit-perfect 严格互斥。**

| 规则 | 落地 |
|---|---|
| 音效链**任何一项**非中性 → `outputPerfect = false` | 复用现成的四字段模型（`dspActive` / `dspModules`，CR-009 已裁定） |
| **不进 `degradeReason`** | 降级是"做不到"，音效是"主动改声"——两件事，走 `dspModules` 表达 |
| C2 画**波浪线**（`～～`） | DESIGN-v5 §3.2 已定义：DSP 生效即插波浪段 |
| 全部中性时**完全跳过** | 与现有 `channelToolsNeutral()` 同一模式，保证 bit-perfect 可达成 |
| **SPEC 的「不做聆听房间」保持不动** | 那是大型卷积混响（FFTConvolver + IR 管理），本次不做 |

> **这是一条清晰的界线**：用户想要"原音"就得到原音（全中性，`outputPerfect=true`）；
> 想要"好听"就得到音效链（明确告知不再是原音）。**两者不会混淆。**

---

## 1. 本次范围（owner 已选三项）

| # | 功能 | 状态 | 依赖 |
|---|---|---|---|
| **A** | **交叉馈送 crossfeed**（Bauer/bs2b 式） | 新增 | 无（纯 IIR） |
| **B** | **声道工具完整化**（mid/side 独立增益 + UI 面板） | 扩展 | 现有 `stereoWidth` |
| **C** | **电平监测全套**（频谱 + 波形 + RMS/峰值 + LUFS 实时） | 新增 | **pffft 已 vendored** |

**明确不在本次**（各自单独立项）：
HRTF 双耳渲染（§8 有评估）、上混 upmix、卷积混响/聆听房间、VST3、变速变调。

---

## 2. ⭐ 关键发现（调研的一手结论）

### 2.1 A：bs2b 是**唯一高确定性**项

| 项 | 值 |
|---|---|
| 许可 | **MIT**（官方 license 原文 "MIT License \| Copyright © 2005 Boris Mikhaylov"） |
| 算法 | **单极点递归滤波（低通 + 高提升），刻意避开 FFT** |
| 官方理由（原文） | *"FFT 在 crossfeed 上很难避免恼人的梳状效应"*，单极点递归数字滤波与模拟 RC 电路同性质 |
| 内核 | **≈200 行 C**（含预设与系数计算 ≈350 行） |
| 三档预设 | 默认 **700Hz / 4.5dB**（≈30° 虚拟音箱）/ **Chu Moy 700Hz / 6dB** / **Jan Meier 650Hz / 9.5dB** |
| 实时性 | **逐样本、零分配、无块延迟、无 FFT** —— 与我们的 RT 约束**完美同构** |

> **它解决的正是耳机听立体声混音的头中效应（in-head localization）**，是本次最高频的痛点。

**活跃镜像**：`alexmarsev/libbs2b`（MIT，C，被 sanear 使用）。SourceForge 主页 2005 年建，基本停更。

### 2.2 B：**中侧（mid/side）是所有空间化的共同底座**

调研的关键洞察：**FFmpeg 的 crossfeed 本身就是中侧域处理**；**CamillaDSP 也用 mixer 做中侧**。

**推论**：先把中侧抽象成**独立阶段**，后面每一项（crossfeed、宽度、未来的上混）都变便宜。

**我们现状**：`stereoWidth` 已在 `applyChannelTools` 里做 mid/side 宽度，但**没有独立的 mid/side 增益**。
**本次要做的是把它升级为一个可复用的中侧阶段**，而不是散在 channel tools 里。

### 2.3 ✅ FFT 引入：许可已核实（两个候选都是 BSD-3-Clause）

我原本以为可以直接用 SoXR 内 vendored 的 `pffft.c`（67.8 KB，AVX）。**实际不行**：

| 事实 | 后果 |
|---|---|
| `pffft.c` 在 `soxr-0.1.3/src/` 下，**是 SoXR 的私有内联实现** | 它被 SoXR 的构建包裹，**不能作为独立 TU 外链** |
| SoXR 的 pffft 有**自己的符号前缀与配置**（`pffft32s.c` / `pffft64s.c` 是 SoXR 的 wrapper） | 直接链接会**符号冲突**或需要改 SoXR 源码 |

⚠️ 另一件事：调研称"你已 vendored kissfft"——**但 `third_party/` 只有 `dr_libs / libebur128 / soxr / taglib / utfcpp`，没有 kissfft**。**要新引入。**

#### 已核实的许可（一手，逐条给出证据）

| 库 | 证据文件 | 原文关键行 | 判定 |
|---|---|---|---|
| **kissfft** `mborgerding/kissfft` | `COPYING`（246 B） | `SPDX-License-Identifier: BSD-3-Clause`（并有 `LICENSES/BSD-3-Clause`） | ✅ **BSD-3-Clause**（SPDX 明确标注） |
| **pffft** `marton78/pffft` | `LICENSE.txt`（1686 B） | 三条款：不得用 NCAR/UCAR 名字背书 · 源码保留声明 · 二进制复现声明 | ✅ **BSD-3-Clause 风格**（NCAR 变体） |

**两个都可以随包分发**（自用不发布更是无碍）。

#### 建议：**kissfft**，理由是体积与结构而非性能

| 对比 | kissfft | pffft（marton78） |
|---|---|---|
| 许可清晰度 | **SPDX 明确标注** ✅ | 需人工判读三条款 |
| 仓库性质 | **单一库，干净** | **FFT benchmark 大杂烩**：含 `kissfft` / `pocketfft` / `greenffts` **三个 git submodule** + `CMakeLists.txt` 12.8 KB |
| 需要的文件 | **6 个文件 ≈ 30 KB**（见下） | 需从大杂烩里挑，且带 submodule |
| Real FFT | ✅ **`kiss_fftr.c` = real FFT，正是频谱要的** | 有 |
| AVX 加速 | ❌（但有 SIMD 可选：`README.simd`） | ✅ AVX |

**为什么 AVX 对我们意义不大**：频谱只需 **30 Hz × 2048 点** FFT。即使用未加速的 kissfft，这个负载也远低于 1% CPU —— **而它跑在控制线程，不占 RT 线程**。

**要 vendored 的文件**（从 `mborgerding/kissfft` 的 `master`）：

```
kiss_fft.c            11,970 B
kiss_fft.h             5,051 B
kiss_fftr.c            5,411 B   ← real FFT
kiss_fftr.h            1,144 B
_kiss_fft_guts.h       5,465 B
kiss_fft_log.h           971 B
                      ─────────
                      29, 约 30 KB
COPYING                  246 B   ← 必须一起放（BSD 要求保留声明）
```

> ⚠️ **不要取 `kissfft.hh` / `kissfft_i32.hh`**（C++ 模板版，13.9 / 10.2 KB）——
> 我们只需 C 的 real FFT，多取只会让审查面变大。

**许可证义务**：BSD-3-Clause 要求**保留版权声明与免责声明**。做法：把 `COPYING` 一起放进 `third_party/kissfft/`，并在 `engine/README.md` 的第三方清单里加一行。

### 2.4 C：libebur128 的真峰值在 **192k 会退化**（owner 已裁定：如实标注）

调研在 `ebur128.c` 的 `ebur128_init_resampler()` 里读到确切逻辑：

```
sr <  96000  → 4× 过采样（49-tap 多相 FIR，Hanning 窗 sinc）
96000 ≤ sr < 192000 → 2×
sr ≥ 192000 → 完全不过采样（interp = NULL，真峰值退化为样本峰值）
```

⚠️ **我们的支持范围是 44.1k–192k，恰好在 192k 边界退化。**

**✅ owner 裁定：如实标注降级，不自己补过采样。** 理由充分：

| 方案 | 成本 | 收益 |
|---|---|---|
| 自己补 4× 过采样 | ~100 行 + 实时路径多一层计算 | 192k 下多一个真峰值数字 |
| **如实标注**（采纳） | **零** | 符合 DESIGN-v5 的诚实原则 |

**落地要求**：

1. `ev: 'meter'` 事件里**必须有字段区分**（例如 `truePeakIsSamplePeak: true`），
   或在真峰值字段旁给一个 `truePeakBasis: 'oversampled' | 'sample'`。
2. **UI 必须显示这个区别**——不能默默退化。按 DESIGN-v5 §3.2 的精神：
   **降级/受限要如实说出来**（就像 `degradeReason` 用虚线而不是假装没事）。
3. **192k 下不得把样本峰值标成"真峰值"** —— 那是声称一个没做的测量。

> 附带事实：`ebur128.c` 用 `#include <sys/queue.h>`（BSD STAILQ），MSVC 无此头 —— **已 vendored，确认已处理**。

### 2.5 C：libebur128 的真峰值路径**不是严格 RT 安全**

它用 float 中间缓冲。**但提供了实时入口**（`ebur128_prev_true_peak` 一类）。
**落地要求**：实时监测走**它的实时入口**，不要把离线扫描的 `addFrames` 路径搬进 RT 线程。
若实时入口不够用，**退路是自己写一个轻量真峰值检测器**（4× 过采样 + 峰值保持，约 100 行）——
**这比在 RT 线程里跑 libebur128 的完整分析安全得多。**

---

## 3. 信号链设计（⭐ 顺序是本次最重要的问题）

### 3.1 现有链（`dsp.cpp` 的 `DspChain::process`，已核实）

```
EQ 10 段 → 静态增益(preamp + RG − headroom) → 声道工具 → 限幅 → 音量×淡变 → 安全钳位
```

### 3.2 新链（插入位置与理由）

```
EQ 10 段
  → 静态增益
  → ★ 中侧阶段（mid/side 增益 + 宽度）        ← B：从 channel tools 提升为独立阶段
  → ★ 交叉馈送 crossfeed                      ← A：新增
  → 声道工具（balance / mono / swap / trim）   ← 保留
  → ★ 电平监测的采样点（tap，非破坏性）        ← C：只读，不改样本
  → 限幅
  → 音量 × 淡变
  → 安全钳位
```

**每条插入的理由**：

| 位置 | 理由 |
|---|---|
| 中侧**在** crossfeed **之前** | crossfeed 本身要在中侧域工作（FFmpeg 的实现就是如此）。**中侧是底座** |
| crossfeed **在** balance 之前 | balance 是"用户对最终听感的偏置"，应该作用在**已经声场化**的信号上。反过来会让 balance 影响 crossfeed 的馈送量 |
| **电平监测在限幅之前** | ⭐ **这样用户看到的是"限幅前是否有过载"** ——那正是电平表存在的意义。放在限幅后，表永远不超 0 dB，**表就废了** |
| 监测**非破坏性**（tap） | 它只读。放在链中但**不改一个样本**；它**不参与** `isPassthrough()` 判定（否则开个表就不是 bit-perfect 了，荒谬） |

### 3.3 ⚠️ 一条硬约束：**监测不得进入 `isPassthroughConfig()`**

`dspActive` / `dspModules` 的语义是"**有东西在改样本**"（CR-009 已定）。
**电平监测不改样本 → 不进 `dspModules`，不置 `outputPerfect=false`。**

- 只开监测：`outputPerfect` **仍可为 true**（它确实没改信号）
- 开 crossfeed 或中侧增益：`outputPerfect = false`，`dspModules` 含 `'crossfeed'` / `'midSide'`

> ⚠️ **但有一个真实张力**：监测要读信号，就得在链上有个 tap。
> **若实现成"复制一份去看"，那张 copy 有内存与 CPU 成本**；**若实现成"读同一个指针"，则零成本**。
> **必须选后者**（§5.3 详述）。

---

## 4. 参数设计（`DspParams` 扩展）

**全部遵守现有铁律：每个默认值都是恒等值（identity）**，这样不动它们就保持 bit-perfect 可能。

### 4.1 A：crossfeed

```cpp
// --- crossfeed (Bauer/bs2b style) ---------------------------------------
// Defaults are the identity: enabled=false means the stage is skipped
// entirely, exactly like the channel tools.
bool  crossfeedEnabled = false;
// Preset index maps to the three documented bs2b levels:
//   0 = default (700 Hz, 4.5 dB)  -- ~30 deg virtual speakers
//   1 = Chu Moy  (700 Hz, 6.0 dB)
//   2 = Jan Meier(650 Hz, 9.5 dB)
int   crossfeedPreset  = 0;
// Fine control, applied on top of the preset. Exposed because the presets
// are three points on a continuum, not three different algorithms.
float crossfeedFcHz     = 700.0f;
float crossfeedFeedDb   = 4.5f;
```

### 4.2 B：中侧阶段

```cpp
// --- mid/side stage -----------------------------------------------------
// The width control already lived in the channel tools; it is promoted here
// because crossfeed also works in the mid/side domain. Keeping two separate
// mid/side implementations would guarantee they drift apart.
float midGainDb  = 0.0f;    // identity
float sideGainDb = 0.0f;    // identity
float stereoWidth = 1.0f;   // MOVED here from channel tools (same semantic)
```

> ⚠️ **迁移注意**：`stereoWidth` 换位置后，`channelToolsNeutral()` 与 `isPassthroughConfig()`
> 都要同步改（否则会出现"宽度生效了但仍报 passthrough"）。**这是最容易漏的一处。**

### 4.3 C：监测（**参数是"开哪几路"与"UI 刷新率"，不是"改声"**）

```cpp
// --- metering (non-destructive tap) -------------------------------------
// These do NOT alter samples and are deliberately NOT part of dspModules.
bool meterEnabled    = false;   // master switch for the tap
int  meterFftSize    = 2048;    // 2048 @48k ≈ 43 ms window; power of two only
int  meterPushHz     = 30;      // how often the control thread samples the tap
```

---

## 5. 实现要点

### 5.1 A：crossfeed 的算法骨架（bs2b 式，≈200 行）

```
每声道：
  1. 一路低通（单极点，fc 由 preset 决定）
  2. 一路高提升（单极点，补偿低频衰减）
  3. 对侧信号经上述滤波后，按 feedDb 混合进来
  4. 直通分量按 (1 - feed/2) 衰减，避免总能量升高
```

**为什么不用 FFT**（官方理由，值得抄进注释）：**FFT 在 crossfeed 上难避梳状效应**；
单极点递归滤波与**模拟 RC 电路同性质**，这正是 Bauer 的设计意图。

⚠️ **单极点滤波器的状态**：每声道 2 个状态量（低通 + 高提升），**共 4 个 float**。
必须进 `reset()`，且 `seek` / 切歌时**要清零**（否则新曲开头会带着上一首的滤波器残响）。

### 5.2 B：中侧阶段——先抽象，再叠加

```cpp
inline void applyMidSide(float& l, float& r, const DspParams& p) noexcept {
    const float mid  = (l + r) * 0.5f;
    const float side = (l - r) * 0.5f;
    const float m = mid  * dbToLin(p.midGainDb);
    const float s = side * dbToLin(p.sideGainDb) * p.stereoWidth;
    l = m + s;
    r = m - s;
}
```

**注意**：`stereoWidth` 的语义**不变**（1.0=原样 / 0=mono / 2=最大展开），
只是**从 channel tools 搬到这个函数**，并且**与 mid/side 增益可叠加**。

> 现有的注释已经很对，值得保留：*"mid/side, so it cannot alter the sum of the two channels"*。

### 5.3 C：监测的 RT→UI 通路（⭐ 最关键的实现决定）

**三条硬要求**：

| # | 要求 | 做法 |
|---|---|---|
| **1** | RT 线程**零分配** | 所有缓冲区在 `prepare()` 期分配（FFT 的 `work`/`input`/`output` 数组） |
| **2** | RT 线程**不做 FFT** | ⚠️ **FFT 不能每块都做**。做法：RT 线程只做**廉价的 tap**（写入一个预分配的分析窗口，或更新原子量），**FFT 由控制线程按 `meterPushHz` 做** |
| **3** | 传值**无锁** | 照现有范式：`std::atomic` 单向发布（同 `renderWakes` / `playedFrames`） |

**推荐的 tap 设计**：

```
RT 线程（每块）：
  · 把本块的 |峰值| 与 sum-of-squares 累加进两个 atomic float（relaxed）
  · 把一个"分析窗口"的环形缓冲按块写入（预分配，块写，无分配）
  · 递增一个 atomic 块计数

控制线程（按 meterPushHz）：
  · 读原子量 → 算 RMS / 峰值 / 峰值保持
  · 从环形缓冲取最新 N 点 → 做 FFT（用独立一份 FFT 实例）→ 频谱
  · 组装成一个 JSON 事件推给应用
```

> ⭐ **分工的理由**：**FFT 有状态且不便宜，但它不需要在 RT 线程里做。**
> RT 线程只做 O(n) 的累加与拷贝；**O(n log n) 的部分归控制线程**。
> 这样 RT 线程的开销是每样本两个乘加，**完全可忽略**。

**另一条**：**电平表的"峰值保持"与"衰减"必须由控制线程做**（RT 线程不做时间逻辑）。

---

### 5.3.1 ⭐ 参照 QueMusic 的 `GetWave`：四处它比我们原设计更好

**来源**：`BroNekoX/QueMusic`（**Apache-2.0** ✅ 可抄）的 `cpp/GetWave.h/.cpp` +
**它的 `AudioSpectrumSink.h` 是一个 57 行的跨线程订阅协议**（`doc/project/03-audio-shaders.md` §3.6 有全文）。

**它的架构**（值得逐条对照）：

```
AudioEngine.render()  --pushSamples(交错 float, 设备采样率)-->  GetWave
   GetWave::pushSamples: 降混单声道 + 写自己的 AudioRing（空间不足直接丢弃）+ m_dataReady=1
   GetWave::updateSpectrum(): 连在 QQuickWindow::afterAnimating → FFT(4096) → spectrumData / wavePath
```

| # | 它的做法 | 我方原设计 | 谁对 |
|---|---|---|---|
| **1** | **`shared_ptr<Handle>` 而不是裸指针** | 未指定 | **它对** |
| **2** | **`detach()` 必须在订阅者析构体开头调用** | 未考虑 | **它对** |
| **3** | **`m_dataReady` 只置位，帧回调消费后才重算** | 未考虑 | **它对** |
| **4** | **`AudioRing` 满时"直接丢弃"，绝不阻塞音频线程** | 未指定溢出策略 | **它对** |

#### ① 裸指针的陷阱（它踩过，注释写明了）

> **绝不保存订阅者的裸指针**：`destroyed` 信号在 QObject 析构过程中发出，
> **派生类成员往往已析构**，音频线程此前读到旧地址仍会踩已销毁对象。

**它的解法**：音频线程只持 **`shared_ptr<Handle>`**，`Handle::push()` 持锁转发；
`detach()` 持锁置空 = **等待在途推送结束**。

**⭐ 对我方的直接价值**：我方是 **JSON Lines 独立进程**，不是 QObject——
但**同一个陷阱以另一种形式存在**：**控制线程持有"监测是否启用"的指针/引用，
而应用侧可能已关闭面板甚至退出**。

**照它的做法**：监测的启用状态用**原子布尔**（它就是这么做的：`std::atomic<bool> m_enabled`），
**不保存任何指向订阅者的指针**。控制线程每次推事件前**查一次原子量**，不看对象是否存在。

#### ② `detach()` 的顺序（一个非常具体的坑）

> `detach()` 必须在订阅者析构体**开头**调用，之后才退订。
> 不能依赖 `QObject::destroyed`。

**对我方的等价要求**：若将来做"监测可选订阅"（只有 UI 打开时才推），
**关闭路径必须先让引擎停止推送，再销毁消费端** —— 顺序反了就会有一次写进已释放内存。

**最省的做法**：按 ① 不用指针，只用一个**原子开关** → **顺序问题自动消失**。

#### ③ `m_dataReady` 只置位、消费后才重算（**性能关键**）

```cpp
QAtomicInteger<int> m_dataReady = 0;   // 音频线程置位，帧回调消费
// 帧回调（GUI 线程）：有新数据才重算频谱
```

**为什么这比"定时重算"好**：**没有新音频就不做 FFT**。
暂停时、静音时、曲目加载时 **FFT 完全不跑** —— 这正是"低负载"的关键。

**⭐ 对我方的直接改进**：我方原设计写的是"控制线程**按 `meterPushHz`（30）**做 FFT"——
**那是定时驱动，会在我方没在播音频时也空转**。

**改成它这样**：

```
RT 线程:  有新块 → 写环 → m_dataReady.store(1, release)
控制线程: 若 (m_dataReady.exchange(0) != 0) 才读环 + 做 FFT
          并且仍然用 meterPushHz 做上限节流（避免推太密）
```

**两个条件取交集**：`有新数据` **且** `距上次推送够久`。**这条同时满足"低负载"与"不丢帧"。**

#### ④ 环形缓冲满了要丢，不能等（它明确写了）

> `pushSamples` 必须**无阻塞、不分配、不取长锁**；`GetWave` 的做法是降混后写自己的 `AudioRing`，
> **满了直接丢弃**（注释：`绝不阻塞音频线程`）。

**对我方**：分析窗口环**满时覆盖最旧数据**（或丢弃），**绝不等待控制线程**。
**丢几帧频谱数据无感，卡住音频线程是灾难。**

#### ⑤ 分块大小与窗口（可对照的常量）

| 它的值 | 说明 |
|---|---|
| `m_fftSize = 4096` | FFT 点数 |
| `m_bands = 96` | ⚠️ **它输出 96 个频段**（不是我方原设计的 32–64） |
| 挂载点 | **`QQuickWindow::afterAnimating`** —— 即"**每帧渲染前**" |
| 推的是 | **DSP 之后**、设备采样率下的交错 float |

**⭐ `afterAnimating` 这个挂载点对我方的启示**：

它是"**跟着渲染帧走**"——**UI 不在刷新时，FFT 也不会被触发**（因为帧回调不跑）。
这比"固定 30 Hz 定时器"更省。

**对我方的等价做法**：**由渲染层"按需拉取"，而不是引擎主动推**。
但你方是跨进程 JSON，**拉取会变成请求/响应往返**。
**折中方案**：

- 引擎侧：**仍按 `m_dataReady` + 节流**决定"要不要算"
- 应用侧：**只在监测面板可见时才让引擎推**（一条 `set_meter` 命令控制原子开关）

**这样"不可见时不推"落在应用侧，"无新数据不算"落在引擎侧——两侧各管一半，都不浪费。**

**⚠️ 频段数**：它用 **96**段。我方原设计写 32–64。
**96 段在 1280px 宽的面板上每段约 13px**（够用），但 **JSON 体积翻倍**。
**建议：先 48 段**（与它的 96 相比减半，视觉上仍够），**实测带宽后再定**。

### 5.4 协议扩展（⬅ 需走 CR）

```json
{"ev":"meter","rmsDb":[-18.2,-18.4],"peakDb":[-6.1,-5.9],
 "peakHoldDb":[-3.2,-3.3],
 "truePeakDb":[-2.8,-2.7],
 "truePeakBasis":"oversampled",       // 'oversampled' | 'sample'
 "lufsMomentary":-16.4,
 "gainReductionDb":0.0,
 "spectrum":[/* 32–64 个对数频段，不是 1024 个 bin */],
 "waveform":[/* min/max 抽点对 */]}
```

**CR 要点**：

| 问题 | 建议 |
|---|---|
| **推送频率** | **不跟随 position（20Hz）**，而是 `meterPushHz`（默认 30）且**仅在 UI 可见时推** |
| **频谱 bin 数** | **不要推 1024 个 bin**——按对数频段聚合成 **32–64 段**再推（带宽降 90%，且人耳本就是对数的） |
| **波形** | 推 **min/max 抽点对**（不是原始样本）；每帧一对 |
| **`lufsMomentary`** | 是"短时"还是"瞬时"要说清；建议先只给 **Momentary（400ms 窗口）**，Short-term（3s）与 Integrated 留给离线 |
| **⭐ `truePeakBasis`** | **必须有**：`'oversampled'` = 真过采样测得；`'sample'` = 192k 下退化为样本峰值（§2.4 owner 裁定）。**UI 必须显示这个区别** |
| **mono 源** | 单声道源时数组长度**应为 1**，不是复制一份——否则表上会出现两条一模一样的通道 |

> ⚠️ **JSON 带宽是一个真实的成本**：30 Hz × 每帧几十个浮点，跨进程 JSON 序列化。
> **必须有节流与聚合**，否则监测会变成一个新的性能问题（而不是发现性能问题）。

---

## 6. 可转化资源（一手核实）

| 类别 | ✅ 直接可用 | 🔧 需改造 | 📖 只学思路 | ❌ 不适用 |
|---|---|---|---|---|
| **声场** | **bs2b/libbs2b（MIT, ~200 行）** | `af_crossfeed.c`（LGPL, ~330 行） | CamillaDSP 的 mixer+biquad 配置范式 | — |
| **虚拟声道** | libmysofa（BSD-3）+ **SADIE II（Apache-2.0）** / SONICOM（MIT） | libspatialaudio（LGPL-2.1+） | Steam Audio / Resonance Audio（已停） | — |
| **环绕** | **FFTConvolver（MIT, ~700 行）** | `af_surround.c`（LGPL, ~1700 行） | Equalizer APO 的 APO 注入架构 | Steam Audio 几何求解 |
| **电平监测** | **libebur128（MIT，已用）** | 192k 处自补真峰值过采样 | — | — |

### 6.1 许可注意（自用不发布无碍，但要知道）

| 来源 | 许可 | 说明 |
|---|---|---|
| bs2b | **MIT** ✅ | 首选 |
| FFTConvolver | **MIT** ✅ | 若做卷积 |
| libmysofa | **BSD-3** ✅ | 若做 HRTF |
| SADIE II 数据集 | **Apache-2.0** ✅ | ⭐ **可随包分发**；**受试者 D2 就是 KEMAR 人工头**（你想要 MIT KEMAR，它已在 Apache-2.0 之下） |
| CamillaDSP | **GPL-3.0 或 MPL-2.0 双授权** | **MPL-2.0 是文件级 copyleft → 可取用** |
| FFmpeg lavfi | **LGPL-2.1+** | ⚠️ 摘码进自有 `.cpp` 会传染（自用无碍，发布要注意） |
| **kissfft** `mborgerding/kissfft` | **BSD-3-Clause** ✅ | `COPYING` 明确标 `SPDX-License-Identifier: BSD-3-Clause` |
| **pffft** `marton78/pffft` | **BSD-3-Clause 风格** ✅ | `LICENSE.txt` 三条款（NCAR 变体） |

### 6.2 一条反直觉的发现：**CamillaDSP 没有 crossfeed 实现**

调研核实：它的 `src/filters/` 只有 8 个文件（`basicfilters / biquad / biquadcombo / diffeq / dither / fftconv / limiter / loudness`），
**crossfeed 是用 mixer（中侧）+ biquad 配置拼出来的**（`Wang-Yue/camilladsp-crossfeed` BSD-3 就是生成这类 YAML 的工具）。

**结论**：它是「**配置范式 + 思路**」来源，**不是抄码来源**（且 Rust 无法直接搬）。
**但它印证了 §2.2 的判断**：**中侧是 crossfeed 的天然实现域。**

### 6.3 FFTConvolver（MIT，~700 行）—— 为将来留的

`HiFi-LoFi/FFTConvolver`：MIT，376★，仓库仅 **64 KB**，非均匀分区，`prepare` 期分配、`process` 期无分配。
**本次不做**，但**聆听房间若将来解禁，这就是最小可用实现**（成本远低于自写）。

---

## 7. HRTF 评估（本次不做，但给出结论）

调研**修正了我此前的直觉**：

| 事实 | 后果 |
|---|---|
| SADIE II 最小受试者（H9–H20）也有 **2114 个测点** | 完整球面网格代价大 |
| SOFA 加载 + 卷积 → 必须引入 FFT 引擎、帧延迟、常驻状态内存 | **与 RSS ≤60MB / 零分配红线直接冲突** |
| crossfeed 用 **200 行**拿到大部分"声场出 head"收益 | 性价比对比悬殊 |

**若将来要做**：**只取 SADIE II 的 D2（KEMAR）的左右两个方位 HRIR 做单点双耳滤波**
（不建完整球面网格），可把成本压到**一次小卷积**。
**这仍属 SPEC §6.3「聆听房间」范畴，需 owner 单独裁定。**

---

## 8. 性能预算（必须守住）

| 项 | 预算 | 依据 |
|---|---|---|
| crossfeed | **每样本 ~6 次乘加 × 2 声道** | bs2b 纯 IIR，可忽略 |
| 中侧阶段 | 每样本 ~4 次乘加 | 已在做（原 stereoWidth） |
| **监测 tap（RT 线程）** | **每样本 2 次乘加**（\|\| 与平方累加） | **不含 FFT** |
| 监测 FFT（控制线程） | 30 Hz × 2048 点 FFT | 与 RT 线程无关 |
| **新增常驻内存** | **< 1 MB** | 2048×4 分析窗口 + FFT 工作区 + 频谱聚合数组 |
| 引擎 RSS 目标 | **仍为 ≤60MB**（SPEC §8.2） | 现有 51.5MB，余量充足 |

> **最需要盯的是 JSON 带宽**（§5.4），不是 CPU。

---

## 9. 落地顺序

| # | 步骤 | 为什么排这里 |
|---|---|---|
| **P0** | ✅ **已完成：kissfft / pffft 许可已核实**（两个都是 BSD-3-Clause，见 §2.3） | 前置解除，可直接进入引入 |
| **P0** | **把 kissfft 的 6 个文件 + `COPYING` 放进 `third_party/kissfft/`**，并在 `engine/README.md` 的第三方清单加一行 | BSD-3 要求保留声明 |
| **P0** | **确认 libebur128 的实时真峰值入口**（`ebur128_prev_true_peak` 一类）是否够用 | 不够则自写 ~100 行轻量检测器（见 §2.5） |
| **P1** | **中侧阶段抽象**（把 `stereoWidth` 从 channel tools 提升） | **它是 crossfeed 的底座**；且这次改动**会同时影响 `channelToolsNeutral` 与 `isPassthroughConfig`**，要先做、单独验证 |
| **P2** | **crossfeed**（bs2b 式，~200 行 + 三档预设） | 最高价值、最确定、零依赖 |
| **P3** | **监测 tap + 原子量**（RT 线程侧，不含 FFT） | 先打通"测得到" |
| **P4** | **CR：`ev: 'meter'` 事件 + 节流/聚合口径 + 真峰值 basis 字段** | 走正规流程，不要自己加字段 |
| **P5** | **控制线程的 FFT 与聚合**（kissfft real FFT） | 频谱/波形 |
| **P6** | 应用侧：**监测常驻主界面**（owner 已定） | UI |
| **P7** | 应用侧：**调节项进设置页** | UI |

> **P1 单独一步是刻意的**：它是唯一"移动已有代码"的改动，
> 最容易出现"宽度生效了但仍报 passthrough"这类**静默错误**。

---

## 10. 验收

### 10.1 引擎侧（可自动断言）

| # | 断言 | 方法 |
|---|---|---|
| **1** | **全中性 = 逐样本恒等** | 与现有 `--selftest` 同法：构造信号过链，**逐样本比对**（crossfeed off + 中侧 identity + 监测 on，输出必须与输入 bit-exact） |
| **2** | **监测不破坏 bit-perfect** | 只开监测时，`get_state` 的 `outputPerfect` **仍为 true** |
| **3** | **crossfeed 不改变总能量** | 白噪声过链，RMS 变化 < 0.5 dB（因为直通分量按 `1 - feed/2` 衰减） |
| **4** | **crossfeed 真的降低了声道间相关** | 单边信号（只左有）过链后，右声道**不再为 0**（这是 crossfeed 的定义） |
| **5** | **中侧增益可独立** | mid +6dB 时两侧**同相**增亮；side +6dB 时**反相**成分增亮 |
| **6** | **纯旁路仍恒等** | `isPassthrough()` 为 true 时，链的输出与输入恒等（含钳位不改变范围内样本） |
| **7** | **crossfeed 状态复位** | 播一段 → seek → 断言滤波器状态已清零（对比不 seek 的头几百样本） |

### 10.2 需要人眼/人耳确认（**不自动判定**）

| 项 | 怎么验 |
|---|---|
| **crossfeed 的三档预设听感差异** | 用一首**强立体声混音**（人声居中、乐器两侧）试三档，确认"头中效应"确实减轻 |
| **中侧增益的听感** | mid +3dB 应"人声更前"，side +3dB 应"声场更宽"——若听不出，说明参数范围不对 |
| **频谱/波形的可读性与刷新手感** | 30 Hz 是否够；换 60 Hz 是否更顺但更费 |
| **电平表在真实音乐下的动态** | 用一首动态大的曲子，确认峰值保持与衰减的节奏合适 |

> ⚠️ **按 `verification-before-completion`：这四项我不自称通过。**

---

## 11. 与既有设计的一致性检查

| 既有约束 | 本方案是否遵守 |
|---|---|
| SPEC §3.8 L2「音频质量」Must | ✅ 作为新子层，不改变 L2 的既有内容 |
| SPEC §6.3「不做聆听房间/空间音频」 | ✅ **保持不动**（HRTF 与卷积混响都不做） |
| CR-009 `dspActive` / `dspModules` 语义 | ✅ 音效链进 `dspModules`；**监测不进**（不改样本） |
| CR-010 四字段模型 | ✅ 音效链生效 → `outputPerfect=false`；`sourceExact` 不受影响 |
| DESIGN-v5 §3.2 C2 波浪线 | ✅ DSP 生效即画 `～～` |
| DESIGN-v5 §7「降级用虚线不用红色」 | ✅ 音效**不是降级**，走波浪线而非虚线 |
| 每参数默认 = 恒等值 | ✅ 全部遵守 |
| 零分配 / RT 无锁 | ✅ 分配在 `prepare()`；FFT 归控制线程 |
| 引擎 RSS ≤60MB | ✅ 新增 < 1 MB |

---

## 12. 附：本方案引用的一手来源

```
bs2b 官方许可：      https://bs2b.sourceforge.net/license.html   （MIT，原文 "MIT License"）
bs2b 活跃镜像：      github.com/alexmarsev/libbs2b
SADIE II 数据库：    https://www.york.ac.uk/sadie-project/database.html （Apache-2.0，D2 = KEMAR）
FFTConvolver：      github.com/HiFi-LoFi/FFTConvolver            （MIT，376★，64KB）
libmysofa：         github.com/hoene/libmysofa                   （BSD-3）
libebur128 真峰值：  ebur128.c 的 ebur128_init_resampler()       （4× / 2× / 无）
FFmpeg 参考实现：    af_crossfeed.c / af_headphone.c / af_surround.c  （LGPL-2.1+）
CamillaDSP：        github.com/HEnquist/camilladsp              （GPL-3.0 或 MPL-2.0）

★ 本方案已核实的两项新许可（逐条给出证据文件）：
kissfft  COPYING：    https://raw.githubusercontent.com/mborgerding/kissfft/master/COPYING
                     → "SPDX-License-Identifier: BSD-3-Clause"
pffft    LICENSE.txt：https://raw.githubusercontent.com/marton78/pffft/master/LICENSE.txt
                     → 三条款（NCAR 变体，不得用名字背书 / 保留声明 / 二进制复现声明）
```

**未一手取证、本方案未依据的条目**（勿当结论）：
VU/PPM 标准时间常数 · 波形抽点算法 · MIT KEMAR/CIPIC 原始许可 ·
商业软件（FxSound/Boom3D/Dolby）功能矩阵 · foobar2000 组件源码可得性 ·
SONICOM 许可（作者论文口径，非许可原文）。

---

## 13. Owner 裁定记录

| # | 问题 | 裁定 | 日期 |
|---|---|---|---|
| **1** | 与 SPEC「不做空间音频」的冲突 | **定位为「音效链」，与 bit-perfect 严格互斥**；SPEC 的「不做聆听房间」保持不动 | 2026-10-15 |
| **2** | 本次做哪几项 | **crossfeed + 声道工具完整化 + 电平监测全套**（HRTF / 上混 / 卷积混响不做） | 2026-10-15 |
| **3** | UI 放哪 | **监测常驻主界面，调节项进设置页** | 2026-10-15 |
| **4** | FFT 引入 | **先查清许可再定** → 已查清：**kissfft 与 pffft 均为 BSD-3-Clause**，建议取 kissfft（见 §2.3） | 2026-10-15 |
| **5** | 真峰值 192k 退化 | **如实标注降级**，不自己补过采样（`truePeakBasis` 字段 + UI 显示） | 2026-10-15 |
| **6** | 监测 tap 位置 | **限幅之前**（这样能看出"限幅前是否过载"——那正是电平表的意义） | 2026-10-15 |
