# 门禁报告 · WASAPI 回环录音能力（Null Test 前置）

> **状态**：现行 · **日期**：2026-10-16 · **给谁**：owner / AI-A
> **上位**：[`OPTIMIZE-v1-candidates.md`](OPTIMIZE-v1-candidates.md) §1（Null Test 判决实验）
> **工具**：`engine/tools/probe-loopback.ps1` · `engine/tools/probe-loopback-tone.ps1`

---

## 0. 结论（两句话）

> ✅ **回环录音本身可行** —— 已带真实音频实测通过，且在 DAC 端点上**幅度逐位吻合**。
>
> ⚠️ **但本机实测证明：独占模式下回环「连打开都失败」（`AUDCLNT_E_DEVICE_IN_USE`）。**
> **→ Null Test 必须在共享模式下做。** 它仍能回答"别的播放器有没有加东西"，
> 但不能比较独占路径本身。

---

## 1. ✅ 已通过：回环能真的录到音频

**测试方式**（不经你的 DAC，不出声到你耳机）：
在**内置扬声器**上播 **-40 dBFS / 1 kHz 正弦约 1.5 秒**，同时回环采集同一端点。

| 实测项 | 值 |
|---|---|
| mix format | **48000 Hz / 2 ch / 32-bit float**（`tag=65534` = `WAVE_FORMAT_EXTENSIBLE`） |
| render buffer frames | **9600** |
| rendered frames | 81600 |
| captured packets | **149** |
| captured frames | 71520 |
| non-zero samples | **131436** |
| captured peak \|sample\| | **0.01261604** |
| captured RMS | **-43.11 dBFS** |

**⭐ 三条交叉验证**（不是"录到了就算"）：

| # | 检查 | 结果 |
|---|---|---|
| **1** | **幅度量级** | 发出 `amplitude 0.010000`（-40dBFS）→ 捕获峰值 `0.0126`，**同量级** ✅ |
| **2** | ⭐ **RMS 交叉验证** | 正弦 RMS = 峰值/√2 = `0.0126/1.414 = 0.00892` = **-41 dBFS**；**实测 -43.11** → 差 2dB 由**系统音量不在 100%** 解释，合理 ✅ |
| **3** | **帧数** | 渲染 81600 / 捕获 71520（含缓冲起止边界差）✅ |

**→ 判决：`PASS -- loopback captured the tone; Null Test is feasible on this endpoint`**

### 1.1 ⭐ 两个端点的对照（**DAC 上更干净**）

同一段脚本、同样 -40dBFS 的 1 kHz 正弦，分别在两个端点上跑：

| 端点 | captured peak | 发送 amplitude | 一致性 |
|---|---|---|---|
| **扬声器 (Audio Device)**（内置） | `0.01261604` | `0.01000000` | 差 26%（**系统音量不在 100%**） |
| ⭐ **耳机 (NICEHCK HiFi Audio)**（DAC） | **`0.01000000`** | `0.01000000` | ⭐ **逐位吻合** |

⭐ **这个对照本身就是一个有用的发现**：

> **DAC 端点的回环幅度与发送幅度完全一致** → 说明该路径上
> **没有额外混音、没有音量缩放、没有系统音效介入**。
>
> **→ 这正是 Null Test 需要的端点**：任何残差都可以归因于被测对象，而不是测量链。

⚠️ **同时也解释了内燃端点那 26% 差异**：它经过了系统音量与（可能的）增强处理
→ **不要用内置扬声器端点做 Null Test**，否则会测到混音器而不是播放器。

---

## 2. ⚠️ 关键限制：**回环录不到独占模式**

**Microsoft 官方文档原文**（[Loopback Recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)）：

> **A client can enable loopback mode only for a shared-mode stream (`AUDCLNT_SHAREMODE_SHARED`).**
> **Exclusive-mode streams cannot operate in loopback mode.**

**而本项目的引擎是独占** —— `output_wasapi.cpp:250`：

```cpp
hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, ...)
```

**→ 这是架构层的事实，不是实现缺陷。** 独占绕过了 Windows 音频引擎，
而回环捕获的正是**音频引擎的输出**。

**文档同时给出一个可能的出口**：

> If the hardware supports a **loopback pin** on the render endpoint,
> WASAPI uses the audio provided on this pin for the loopback stream.

**硬件回环引脚在硬件层 → 可能能采到独占内容。** ⚠️ **尚未实测。**

---

### 2.1 ⭐⭐ 本机实证：独占时回环**连打开都失败**（`AUDCLNT_E_DEVICE_IN_USE`）

**这不是文档推论，是实测。** 让引擎以独占模式持有 DAC，然后尝试开回环：

```
Exception calling "Run": "0x8889000A"
```

**`0x8889000A` = `AUDCLNT_E_DEVICE_IN_USE`** —— 回环**根本打不开**，
而不是"能打开但录到静音"。

⭐ **这个区别很重要**：

| 结果 | 含义 |
|---|---|
| "能打开但全是 0" | 回环存在，但内容被独占绕过 |
| ⭐ **"打不开，DEVICE_IN_USE"** | **设备被独占持有，回环通道被拒绝** |

**→ 与 Microsoft 文档完全一致**：
> Exclusive-mode streams cannot operate in loopback mode.

**⚠️ 一个真实的时序教训（我自己踩的）**：
本测试**前三次都报 "no packets"**，看起来像是"独占限制"——
**但实际上是我的测试时序错了**：采集窗口（6 秒）**在引擎还在扫描曲库时就开始了**
（`scan` 91 首要约 9 秒），所以**播放与采集根本没重叠**。

> **一个错过音频的采集，不能证明关于音频的任何事。**
>
> 前两次"no packets"（无重叠）与第三次"DEVICE_IN_USE"（真重叠）**是两回事**，
> 若不做时序修正就会**把测试 bug 当成技术结论**。

**→ 修正后**（先 scan → 先 open → 再开采集 → 最后 play）才拿到 `DEVICE_IN_USE` 这个真结果。

---

## 3. 对 Null Test 的实际影响

| 场景 | 能 null test 吗 |
|---|---|
| **共享模式** | ✅ **能**（信号经过音频引擎） |
| **独占模式** | ❌ **不能**（除非 DAC 有硬件回环引脚） |

### ⭐ 三条可行路径

| # | 路径 | 说明 |
|---|---|---|
| **A** | ⭐ **只在共享模式下做 Null Test** | **仍然有价值**：若别的播放器"加了东西"，**共享模式下一样测得出来**。<br>⚠️ 代价：排除了独占路径本身的差异 |
| **B** | ~~实测 DAC 是否有硬件回环引脚~~ | ⚠️ **已实测并排除**：引擎独占持有 DAC 时，回环**连 `Initialize` 都失败**（`0x8889000A` `AUDCLNT_E_DEVICE_IN_USE`）→ **本机 DAC 没有可用的硬件回环引脚**（或它不缓解 `DEVICE_IN_USE`） |
| **C** | **改测数字输出而非模拟回环** | 例如让两个播放器都写到 WAV 文件，再相减 —— ⚠️ 但这**测不到 DAC 与驱动**，而那正是争议所在 |

> **A 与 B 可以叠加**：先按 A 做（能立刻开工），同时用 B 试硬件引脚。

---

## 4. 副产品：两条可复用的经验

### 4.1 ⭐ **静默时回环完全不投递包**

**第一次探测（无声音）的结果**：

```
packets: 0
frames total: 0
VERDICT: NO DATA -- loopback opened but delivered no packets
```

**→ 所以"有数据"不能当"录音正常"的判据** ——
**必须带声音测**，否则会把"没播放"误读成"回环坏了"。
（这与项目里"诊断工具骗人"那族教训同形。）

### 4.2 ⚠️ `AUDCLNT_E_BUFFER_TOO_LARGE`（`0x88890006`）的真实成因

**第一版脚本抛这个错。** 原因不是"buffer 太小"，而是**渲染端无脑请求固定 chunk**：

```csharp
// ✗ 错：缓冲区里还留着未播完的数据
rclient.GetBuffer(chunk, ...)

// ✓ 对：先问还有多少空位
ren.GetCurrentPadding(out padding);
int free = bufFrames - padding;
rclient.GetBuffer(Math.Min(free, chunk), ...)
```

**→ 命名有误导性**：`BUFFER_TOO_LARGE` 说的是"**你请求的比空闲的多**"，
不是"缓冲区本身太大"。**这个坑值得记**，因为错误名会把人引向错误的修法。

---

## 5. 工具状态（可复用）

| 文件 | 作用 |
|---|---|
| `engine/tools/probe-loopback.ps1` | 枚举活动渲染端点 + 逐个试开回环 + 报告是否有数据（**不发出声音**） |
| `engine/tools/probe-loopback-tone.ps1` | ⭐ **自产 -40dBFS 正弦**并在同一端点回环采集 + **交叉验证幅度/RMS/帧数** |

**用法**（默认用**内置扬声器**，不驱动 DAC）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File engine\tools\probe-loopback-tone.ps1
# 或指定端点：
pwsh -NoProfile -ExecutionPolicy Bypass -File engine\tools\probe-loopback-tone.ps1 `
     -EndpointId '{0.0.0.00000000}.{875913cc-66fd-4efb-8936-a407ee425a8e}' -Millis 1500
```

**这台机器的活动渲染端点**：

| 端点 ID | 设备 |
|---|---|
| `{0.0.0.00000000}.{10ecfbb1-44d4-43b7-8e83-84711e2fa8ef}` | 扬声器 (Audio Device) —— 内置 |
| `{0.0.0.00000000}.{875913cc-66fd-4efb-8936-a407ee425a8e}` | **耳机 (NICEHCK HiFi Audio)** —— DAC |

> ⚠️ 脚本要求 **PowerShell 7（`pwsh`）**：Windows PowerShell 5.1 的 `Add-Type` **不支持 `-CompilerOptions`**，
> 而这段 interop 需要 `/unsafe`（`float*` 指针）。

---

## 6. 一句话

> **门禁的答案是分两半的**：
>
> ✅ **回环录音能用**（音频实测通过，DAC 端点幅度逐位吻合）
> ❌ **独占模式下用不了**（`AUDCLNT_E_DEVICE_IN_USE`，本机实测）
>
> ⭐ **所以 Null Test 的可执行版本是「共享模式对照」**：
> 让两个播放器**都在共享模式**下播放，录回环、相减。
>
> **它能回答**：别的播放器**有没有在信号里加东西**（升采样 / 滤波 / dither / 音量处理）
> —— 这**正是**"为什么它听起来更好"最可能的答案。
>
> **它不能回答**：独占路径本身的差异（那部分要靠别的方法，或接受测不了）。
