# 音效链落地指令 · 给 AI-A（引擎）

> **这不是契约。** 不影响 `CONTRACT.md` 与 `docs/SPEC-v2.1.md` 的权威性。
> **母方案：`docs/DSP-v1-effects-chain.md`（511 行，含 owner 六项裁定）** —— 本文件是它的引擎侧落地指令。
>
> **分工说明**：本轮的**绝大部分工作在引擎**（crossfeed / 中侧 / 监测 tap / FFT），
> B 侧只有 UI 与事件消费。这不是分配不公，是功能性质决定的。
>
> 日期：2026-10-15 · 状态：**owner 已批准，可按 §3 顺序开工**

---

## 0. 三件必须先知道的事

### 0.1 ✅ FFT 许可已查清：两个候选都是 BSD-3-Clause

**母方案 §2.3 已核实**（一手证据）：

| 库 | 证据文件 | 原文关键行 | 判定 |
|---|---|---|---|
| **kissfft** `mborgerding/kissfft` | `COPYING`（246 B） | **`SPDX-License-Identifier: BSD-3-Clause`** | ✅ |
| **pffft** `marton78/pffft` | `LICENSE.txt`（1686 B） | 三条款（NCAR 变体） | ✅ |

**建议取 kissfft**，理由**不是性能而是结构干净**：只需 6 个文件 ≈30 KB；pffft 那个仓库是 **FFT benchmark 大杂烩**（含 `kissfft` / `pocketfft` / `greenffts` 三个 submodule）。

**AVX 对我们意义不大**：频谱只需 **30 Hz × 2048 点**，且跑在**控制线程**，不占 RT 线程。

### 0.2 ⚠️ 我此前的说法是错的，别按它做

| 我说过 | 实际 |
|---|---|
| "pffft 已 vendored，频谱零新依赖" | ❌ **`pffft.c` 在 `soxr-0.1.3/src/` 下，是 SoXR 的私有内联实现**（有自己的符号前缀与 `pffft32s.c`/`pffft64s.c` wrapper），**不能作独立 TU 外链** |
| （调研称）"你已 vendored kissfft" | ❌ **`third_party/` 只有 `dr_libs / libebur128 / soxr / taglib / utfcpp`**，**没有 kissfft**。**要新引入** |

### 0.3 定位：音效链与 bit-perfect **严格互斥**（owner 裁定 1）

SPEC 两处把「聆听房间/空间音频」列为 Won't（§3.8、§6.3），理由是"与听清原音相冲"。
**owner 裁定：定位为「音效链」，与 bit-perfect 严格互斥；SPEC 的「不做聆听房间」保持不动。**

| 规则 | 落地 |
|---|---|
| 音效链**任一非中性** → `outputPerfect = false` | 复用 CR-009 的 `dspActive` / `dspModules` |
| **不进 `degradeReason`** | 降级是"做不到"，音效是"主动改声"——两件事 |
| 全部中性时**完全跳过** | 与现有 `channelToolsNeutral()` 同一模式 |

---

## 1. 本次范围（owner 裁定 2）

| # | 功能 | 状态 |
|---|---|---|
| **A** | **crossfeed**（Bauer/bs2b 式） | 新增，**~200 行纯 IIR** |
| **B** | **中侧阶段**（mid/side 独立增益 + 宽度提升） | 改造 |
| **C** | **电平监测全套**（频谱 + 波形 + RMS/峰值 + LUFS 实时） | 新增 |

**不做**：HRTF（母方案 §7 有评估，与 60MB/零分配红线冲突）、上混、卷积混响、VST3、变速变调。

---

## 2. ⭐ 信号链：插入位置（本次最重要的问题）

### 2.1 现状（已核实 `dsp.cpp` 的 `DspChain::process`）

```
EQ 10 段 → 静态增益(preamp + RG − headroom) → 声道工具 → 限幅 → 音量×淡变 → 安全钳位
```

### 2.2 新链

```
EQ 10 段
  → 静态增益
  → ★ 中侧阶段（mid/side 增益 + 宽度）        ← B：从 channel tools 提升
  → ★ 交叉馈送 crossfeed                      ← A：新增
  → 声道工具（balance / mono / swap / trim）   ← 保留
  → ★ 电平监测 tap（只读，不改样本）           ← C：新增
  → 限幅
  → 音量 × 淡变
  → 安全钳位
```

### 2.3 每条插入的理由（**照抄，不要自己重排**）

| 位置 | 理由 |
|---|---|
| 中侧**在** crossfeed **之前** | **crossfeed 本身要在中侧域工作**（FFmpeg 的实现就是中侧域处理）。中侧是底座 |
| crossfeed **在** balance **之前** | balance 是"用户对最终听感的偏置"，该作用在**已经声场化**的信号上。反过来会让 balance 影响 crossfeed 的馈送量 |
| **监测在限幅之前** | ⭐ **这样能看出"限幅前是否过载"——那正是电平表存在的意义**。放限幅后表永远不超 0 dB，**表就废了** |
| 监测**非破坏性** | 只读，不改一个样本 |

---

## 3. 落地顺序（**按此顺序，不要跳**）

### P0 · 引入 kissfft（6 个文件 + COPYING）

从 `mborgerding/kissfft` 的 `master` 取：

```
kiss_fft.c            11,970 B
kiss_fft.h             5,051 B
kiss_fftr.c            5,411 B   ← real FFT，正是频谱要的
kiss_fftr.h            1,144 B
_kiss_fft_guts.h       5,465 B
kiss_fft_log.h           971 B
                      ─────────
                       约 30 KB
COPYING                  246 B   ← 必须一起放（BSD 要求保留声明）
```

**放** `engine/third_party/kissfft/`，并在 `engine/README.md` 的第三方清单加一行。

> ⚠️ **不要取 `kissfft.hh` / `kissfft_i32.hh`**（C++ 模板版，13.9 / 10.2 KB）——
> 只需 C 的 real FFT，多取只会让审查面变大。
> **不要取 `kiss_fftnd.c` / `kiss_fftndr.c`**（N 维 FFT，用不到）。

### P0' · 确认 libebur128 的实时真峰值入口

`analysis.hpp` 已有 `truePeakDb` / `samplePeakDb`，但在 **`LoudnessScan`（离线）** 路径里。
母方案 §2.5：**它的真峰值路径用 float 中间缓冲，不是严格 RT 安全**，但提供了实时入口（`ebur128_prev_true_peak` 一类）。

**判定**：若实时入口够用 → 用；**不够 → 自写一个 ~100 行轻量检测器**（4× 过采样 + 峰值保持）。
**绝不要把离线扫描的 `addFrames` 路径搬进 RT 线程。**

**192k 处理（owner 裁定 5：如实标注）**：`libebur128` 在 `sr ≥ 192000` 时**完全不过采样**（`interp = NULL`），真峰值退化为样本峰值。**我们支持到 192k，正好踩线。**

→ **不补过采样**，但**必须给出 basis 字段**（见 §5.4 的 `truePeakBasis`）。

### P1 · 中侧阶段抽象（**单独一步，先做**）

**这是唯一"移动已有代码"的改动**，最容易出现"宽度生效了但仍报 passthrough"这类**静默错误**。

把 `stereoWidth` 从 `applyChannelTools`（`dsp.cpp` 的文件内匿名命名空间）**提升为独立函数**：

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

**`stereoWidth` 语义不变**（1.0=原样 / 0=mono / 2=最大展开），只是换位置 + 与 mid/side 增益可叠加。

**保留现有注释**：*"mid/side, so it cannot alter the sum of the two channels"* —— 它是对的。

⚠️ **三处必须同步改，漏一处就是静默 bug**：

| 位置 | 改什么 |
|---|---|
| `channelToolsNeutral()` | **移除** `stereoWidth != 1.0f` 与新增的 mid/side 两个判断 |
| **新** `midSideNeutral()` | 加 `midGainDb` / `sideGainDb` / `stereoWidth` 三个判断 |
| `isPassthroughConfig()` | **必须同时调这两个 neutral**，否则会出现"宽度生效了但仍报 passthrough" |
| `DspChain::process` 的 `needChannels` | 现在要分成 `needChannels`（声道工具）与 `needMidSide`，并把后者也计入 `targetMix` |

> `targetMix` 的注释已经记着一个同类教训：*"Driving it from the EQ flag alone meant that turning the EQ off silently disabled balance, mono, width, swap and trim."*
> **中侧阶段独立后，这个坑会以新形式回来。** 请照现有做法把每个"会改样本的阶段"都计入。

### P2 · crossfeed（bs2b 式）

**算法骨架**（每声道）：

```
1. 一路低通（单极点，fc 由 preset 决定）
2. 一路高提升（单极点，补偿低频衰减）
3. 对侧信号经上述滤波后，按 feedDb 混合进来
4. 直通分量按 (1 - feed/2) 衰减，避免总能量升高
```

**为什么不用 FFT（官方理由，抄进注释）**：**bs2b 明确说 FFT 在 crossfeed 上难避恼人的梳状效应**；
单极点递归滤波与**模拟 RC 电路同性质**——这正是 Bauer 的设计意图。

**三档预设**（官方文档值）：

| # | 名称 | fc | feed | 说明 |
|---|---|---|---|---|
| **0** | default | **700 Hz** | **4.5 dB** | ≈30° 虚拟音箱（默认） |
| **1** | Chu Moy | **700 Hz** | **6.0 dB** | |
| **2** | Jan Meier | **650 Hz** | **9.5 dB** | 最强 |

**许可**：bs2b 是 **MIT** ✅（官方 license 原文）。活跃镜像 `alexmarsev/libbs2b`。

⚠️ **状态管理与 `reset()`**：每声道 2 个状态量（低通 + 高提升），**共 4 个 float**。
必须进 `reset()`，且 **`seek` / 切歌时要清零**——否则新曲开头会带着上一首的滤波器残响。

### P3 · 监测 tap（RT 线程侧，**不含 FFT**）

**三条硬要求**：

| # | 要求 | 做法 |
|---|---|---|
| **1** | RT 线程**零分配** | 所有缓冲区在 `prepare()` 期分配 |
| **2** | RT 线程**不做 FFT** | 见下 |
| **3** | 传值**无锁** | 照现有范式：`std::atomic` 单向发布（同 `renderWakes` / `playedFrames` / `xrunCount`） |

**推荐的 tap 设计**：

```
RT 线程（每块）：
  · 把本块的 |峰值| 与 sum-of-squares 累加进两个 atomic（relaxed）
  · 按块写入一个"分析窗口"环形缓冲（预分配，块写，无分配）
  · 递增一个 atomic 块计数

控制线程（按 meterPushHz，默认 30）：
  · 读原子量 → 算 RMS / 峰值 / 峰值保持 / 衰减
  · 从环形缓冲取最新 N 点 → 做 FFT（独立一份 kissfft 实例）→ 频谱
  · 组装成一个 JSON 事件推给应用
```

⭐ **分工的理由**：**FFT 有状态且不便宜，但它不需要在 RT 线程做。**
RT 线程只做 **O(n) 的累加与拷贝**（每样本 2 次乘加）；**O(n log n) 的部分归控制线程**。

**另一条**：**峰值保持与衰减必须由控制线程做**（RT 线程不做时间逻辑）。

### P4 · CR：`ev: 'meter'` 事件

**不要把字段直接加上去——走 `docs/contract-requests.md` 正规流程**（CONTRACT §8 铁律 3）。
母方案 §5.4 已给出建议字段与口径，条号接在 CR-013 之后。

⚠️ **这一条不能省**：`ev` 是契约事件，即使 owner 批准了设计文档，
**协议字段仍要经 CR 裁定**（设计批准 ≠ 契约变更批准）。

### P5 · 控制线程的 FFT 与聚合

用 kissfft 的 **real FFT**（`kiss_fftr`），不是复数版。

- 窗函数：Hann（母方案未一手核实窗函数选择，**先用 Hann**，这是频谱分析最通用的选择）
- **频谱聚合**：**不要推 2048/2 = 1024 个 bin** —— 按对数频段聚合成 **32–64 段**（带宽降 90%，且人耳本就是对数的）
- **波形**：推 **min/max 抽点对**，不是原始样本

---

## 4. 参数设计（`DspParams` 扩展）

**铁律：每个默认值都是恒等值（identity）** —— 不碰它们就保持 bit-perfect 可能。

```cpp
// --- mid/side stage (promoted from the channel tools) -------------------
// The width control already existed; it moved here because crossfeed also
// works in the mid/side domain. Keeping two separate implementations would
// guarantee they drift apart.
float midGainDb  = 0.0f;    // identity
float sideGainDb = 0.0f;    // identity
float stereoWidth = 1.0f;   // MOVED here (same semantic as before)

// --- crossfeed (Bauer/bs2b) ---------------------------------------------
// Defaults are the identity: enabled=false skips the stage entirely, exactly
// like the channel tools.
bool  crossfeedEnabled = false;
// 0 = default (700 Hz, 4.5 dB) / 1 = Chu Moy (700 Hz, 6.0 dB) / 2 = Jan Meier (650 Hz, 9.5 dB)
int   crossfeedPreset  = 0;
// Fine control on top of the preset. The presets are three points on a
// continuum, not three different algorithms.
float crossfeedFcHz    = 700.0f;
float crossfeedFeedDb  = 4.5f;

// --- metering (non-destructive tap) -------------------------------------
// These do NOT alter samples and are deliberately NOT part of dspModules.
bool meterEnabled  = false;
int  meterFftSize  = 2048;   // 2048 @48k ≈ 43 ms window; power of two only
int  meterPushHz   = 30;
```

⚠️ **`stereoWidth` 换位置后，`channelToolsNeutral()` 与 `isPassthroughConfig()` 都要同步改** —— 见 §3 的 P1 表。

---

## 5. 协议扩展（P4 的 CR 内容）

```json
{"ev":"meter","rmsDb":[-18.2,-18.4],"peakDb":[-6.1,-5.9],
 "peakHoldDb":[-3.2,-3.3],
 "truePeakDb":[-2.8,-2.7],
 "truePeakBasis":"oversampled",       // 'oversampled' | 'sample'
 "lufsMomentary":-16.4,
 "gainReductionDb":0.0,
 "spectrum":[/* 32–64 个对数频段 */],
 "waveform":[/* min/max 抽点对 */]}
```

### 5.1 五个必须写进 CR 的口径

| 问题 | 口径 |
|---|---|
| **推送频率** | **不跟随 position（20Hz）**，用 `meterPushHz`（默认 30），且**仅在 UI 可见时推** |
| **频谱 bin 数** | **32–64 个对数频段**，不是 1024 个 bin |
| **波形** | **min/max 抽点对**，不是原始样本 |
| **`lufsMomentary`** | 说清是"短时"还是"瞬时"；**建议先只给 Momentary（400ms 窗口）**，Short-term（3s）与 Integrated 留给离线 |
| **⭐ `truePeakBasis`** | **必须有**：`'oversampled'` = 真过采样测得；`'sample'` = 192k 下退化为样本峰值（**owner 裁定 5**） |
| **mono 源** | 数组长度**应为 1**，不是复制一份（否则表上出现两条一模一样的通道） |

### 5.2 ⚠️ 一个真实的成本：JSON 带宽

**30 Hz × 每帧几十个浮点，跨进程 JSON 序列化** —— 这**可能变成一个新的性能问题**（而不是发现性能问题）。

**必须做节流与聚合**，且在 CR 里写明。若实测带宽过高，退路是**把频谱与波形分成两个独立事件**（波形低频、频谱高频）。

---

## 6. 验收

### 6.1 可自动断言（⭐ 请加进 `drive.mjs`）

| # | 断言 | 方法 |
|---|---|---|
| **1** | **全中性 = 逐样本恒等** | 构造信号过链，**逐样本比对**（crossfeed off + 中侧 identity + 监测 on，输出必须与输入 bit-exact） |
| **2** | **监测不破坏 bit-perfect** | 只开监测时，`get_state` 的 `outputPerfect` **仍为 true** |
| **3** | **crossfeed 不改变总能量** | 白噪声过链，RMS 变化 < 0.5 dB（直通分量按 `1 - feed/2` 衰减） |
| **4** | **crossfeed 真的降低了声道间相关** | 单边信号（只左有）过链后，**右声道不再为 0** —— 这是 crossfeed 的定义 |
| **5** | **中侧增益可独立** | mid +6dB 时两侧**同相**增亮；side +6dB 时**反相**成分增亮 |
| **6** | **纯旁路仍恒等** | `isPassthrough()` 为 true 时输出与输入恒等 |
| **7** | **crossfeed 状态复位** | 播一段 → seek → 断言滤波器状态已清零（对比不 seek 的头几百样本） |

**第 1、2、6 条是本次的安全网**——它们保证"加了音效链之后，不碰它的人仍然拿到原音"。

### 6.2 必须人耳/人眼确认（**不自动判定，不自称通过**）

| 项 | 怎么验 |
|---|---|
| **crossfeed 三档预设的听感差异** | 用一首**强立体声混音**（人声居中、乐器两侧）试三档，确认"头中效应"确实减轻 |
| **中侧增益的听感** | mid +3dB 应"人声更前"，side +3dB 应"声场更宽"——**若听不出，说明参数范围不对** |
| **频谱/波形的可读性与刷新手感** | 30 Hz 是否够；换 60 Hz 是否更顺但更费 |
| **电平表在真实音乐下的动态** | 用一首动态大的曲子，确认峰值保持与衰减的节奏合适 |

> 按 `verification-before-completion`：**这四项只能由 owner 在真机上看，我不自称通过。**

---

## 7. 性能红线

| 项 | 预算 |
|---|---|
| crossfeed | 每样本 ~6 次乘加 × 2 声道（纯 IIR，可忽略） |
| 中侧阶段 | 每样本 ~4 次乘加（已在做） |
| **监测 tap（RT 线程）** | **每样本 2 次乘加**（`\|\|` 与平方累加）—— **不含 FFT** |
| 监测 FFT（控制线程） | 30 Hz × 2048 点 —— **与 RT 线程无关** |
| **新增常驻内存** | **< 1 MB** |
| 引擎 RSS 目标 | **仍为 ≤60MB**（现有 51.5MB，余量充足） |

> **最需要盯的是 JSON 带宽（§5.2），不是 CPU。**

---

## 8. 一致性检查（改完请逐条核对）

| 既有约束 | 是否遵守 |
|---|---|
| SPEC §3.8 L2「音频质量」 | ✅ 作为新子层，不改 L2 既有内容 |
| SPEC §6.3「不做聆听房间」 | ✅ **保持不动** |
| CR-009 `dspActive` / `dspModules` | ✅ 音效链进 `dspModules`；**监测不进**（不改样本） |
| CR-010 四字段模型 | ✅ 音效链生效 → `outputPerfect=false`；`sourceExact` 不受影响 |
| DESIGN-v5 §3.2 C2 波浪线 | ✅ DSP 生效即画 `～～` |
| DESIGN-v5 §7「降级用虚线不用红色」 | ✅ **音效不是降级**，走波浪线而非虚线 |
| 每参数默认 = 恒等值 | ✅ 全部遵守 |
| 零分配 / RT 无锁 | ✅ 分配在 `prepare()`；FFT 归控制线程 |

---

## 9. 一句话

> **你的 KPI 有两条**：
> **① 加了音效链之后，不碰它的人仍然拿到逐样本恒等的原音**（§6.1 的第 1、2、6 条）。
> **② RT 线程的开销不因为"能看频谱"而变化** —— FFT 归控制线程（§3 的 P3）。
>
> **这两条都做到，这个功能才是净收益。**
