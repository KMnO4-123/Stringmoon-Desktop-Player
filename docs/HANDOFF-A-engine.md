# 交接 · AI-A（引擎）

> **给下一个接手引擎的会话。** 目标：**十分钟内能开工，且不重犯已经付过代价的错。**
>
> 你不需要读完 `PROGRESS.md`（134 KB）—— 本文第 10 节是它的地图，按问题查。
> 本文写于 2026-10-16，所有「已验证」都指那一天在这台机器上的实测。

---

## 1. 你是谁，边界在哪

Twilight Echo 是**双 AI 分工**：**A＝引擎**（`engine/`，C++20，WASAPI），**B＝应用**（`app/`，Electron+TS）。
**两个会话不共享上下文**，唯一的共同语言是契约文件。

| 铁律 | 内容 |
|---|---|
| **冻结** | `CONTRACT.md` 与 `docs/SPEC-v2.1.md` **只读**。两边的 mtime 必须是 `2026/10/14`，改它们就是越权 |
| **契约变更** | 只能**追加**到 `docs/contract-requests.md`（CR），等 owner 裁定。**设计批准 ≠ 契约变更批准** |
| **禁入** | **不要进 `app/`**。那是 B 的地盘 |
| **裁定** | **所有需要 owner 裁定的问题一律走询问窗口 `ask_user_question`**，不要在回复正文里以文字提问。这是 owner 的明确要求 |
| **stdout** | 只有 JSON Lines。**所有日志走 stderr**（`diag_log` 除外，它写文件） |
| **降级不是错误** | 独占失败 → 共享，用 `state.outputMode` + `degradeReason` 表达，**绝不 `ok:false`** |

**工作方式上的三条纪律**（这个项目的验收标准比一般项目严）：

1. **不保留没有证据的断言。** 说「支持」之前先跑；说「不支持」之前先确认仪器本身可信。
2. **只在样本上成立的验收比没有更糟。** 「RSS 51.4 MB 通过」曾经成立，因为它只量了小文件（见 §7 坑 #1）。
3. **自检工具也会骗人。** 至少三次，是**诊断工具自己错了**（§7 坑 #5/#6/#7）。

---

## 2. 这台机器（不这样配就跑不起来）

| 项 | 值 |
|---|---|
| 编译器 | VS2022 BuildTools：`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat` |
| 生成器 | **`Visual Studio 17 2022`**（**Ninja 在这台机器上失败**，别试） |
| Node | `<系统工具目录>\node.exe`（该目录是**只读 ACL**，不要往里装东西） |
| 曲库 | `<测试曲库>`（91 首 FLAC，3427 MB，含 44.1/48/96 kHz 与 16/24 bit） |
| 网络 | `raw.githubusercontent.com` **不通**；用 `gh-proxy.com` 前缀。`codeload` 与 `api.github.com` 直连可用 |
| 审批 | 本会话 `approval policy = never`，**不要请求提权** |
| git | **不是 git 仓库。** 没有 commit 可依赖 —— 交接靠文件 mtime 与 PROGRESS |

**音频设备**：`NICEHCK HiFi Audio`（USB DAC，唯一有独占价值的端点）与内置 Conexant 编解码器。
实测：DAC 接受 **44100/48000/96000/192000 × 16/24/32**；内置端点独占也**可以**（§7 坑 #6）。

---

## 3. 构建与运行

```powershell
Set-Location <仓库根>
powershell -ExecutionPolicy Bypass -File engine\tools\build.ps1        # 依赖 + 配置 + 构建
```

依赖由 `engine/tools/fetch-deps.ps1` 拉进 `engine/third_party/`（TagLib / utfcpp / dr_libs / soxr / libebur128 / kissfft）。
**从不往系统里装东西。**

| 命令 | 用途 |
|---|---|
| `engine\bin\twilight-engine.exe --selftest` | 协议编解码 + **DSP 恒等性**（含新加的**立体声 + 出厂默认**逐样本恒等）+ 量化/dither 不变式 |
| `& "<系统工具目录>\node.exe" engine\tools\drive.mjs` | **全套协议验收**：22 步 / **462 断言** |
| `... drive.mjs --list` | 列步骤；`--step=<名>` 只跑一步 |
| `--probe-decode <dir>` | **解码逐位验证**（句柄路径 vs 整文件路径），FLAC |
| `--probe-spectrum <dir>` | 音源是否**真无损**（频谱边界 vs Nyquist） |
| `--probe-resample <in> <out.wav> <rate> [bits]` | 用**引擎自己的 SoXR** 造同曲异率的对照材料 |
| `--probe-exclusive [--device=]` | 端点独占能力矩阵 |
| `--probe-mf [--codec aac\|alac --write-tone <x.m4a>]` | Media Foundation 编解码器枚举 / 造测试素材 |
| `tools\soak.mjs --minutes=30 [--track-index=N]` | SPEC §9 压力播放；同时读诊断日志 |
| `tools\ab-switch.mjs` / `level-ab.mjs` / `rate-ab.mjs` | 真机听感对照（独占vs共享 / 电平 / 喂率），**按键 1/2/a/q 切换** |

运行期文件：`engine/bin/twilight-engine-diag.log`（xrun、缓冲史、设备变更史、`stall` 现场；有上限，**只在控制线程写**）。

---

## 4. 架构（改动前必读）

```
stdin(JSON Lines) → 控制线程 ──┬─→ 解码器（dr_flac〔含 Ogg-FLAC〕/ dr_wav / dr_mp3 / stb_vorbis〔Ogg Vorbis〕/ MediaFoundation-MP4）
                            ├─→ SoXR 重采样（仅共享模式，或源率≠设备率）
                            ├─→ SPSC PlanarRing (alignas 64, float32 平面)
                            └─→ 渲染线程(RT) → DSP 链 → WASAPI
```

- **渲染线程铁律：不分配、不日志、不做 I/O。** 分配只在 `prepare()`；FFT 之类归控制线程。
- 内部一律 **float32 平面**；交织与位深转换**只在输出边界**发生。
- 参数交给 RT 线程用 **seqlock 整份快照**（读取有重试上限，RT 宁可留用旧值也不自旋）。
- **DSP 链顺序**（`dsp.cpp`）：`EQ → 静态增益 → 声道工具 → 限幅 → 音量×淡变 → 安全钳位`。
  安全钳位**永远生效**（参考实现在旁路时连硬裁剪一起跳过，是最危险的坑）。

---

## 5. 当前状态（三维口径：build / runtime / device evidence）

### 已验证

| 项 | 证据 |
|---|---|
| 全套协议 | **462 断言 / 22 步 / 0 失败** |
| `--selftest` | 全过（含 2026-10-16 新增的**立体声 + 出厂默认逐样本恒等**） |
| **解码保真** | `--probe-decode`：**91 文件 / 934,929,691 帧 / 452 寻址探针 / 0 分歧** |
| **音源质量** | `--probe-spectrum`：91 首能量全部顶到**自身 Nyquist** → 真无损 |
| **RSS** | **16–19 MB 且与文件大小无关**（§7 坑 #1） |
| L1 格式 | MP3 / AAC / ALAC / WAV / FLAC **5/5**，有损/无损与 bit-perfect 的关系正确 |
| 四字段模型 | `pcmPassthrough` / `outputPerfect` / `sourceExact` / `bitPerfect`（= `outputPerfect` 的字面别名） |
| 独占 | DAC 上 16-16 与 32-24 在 3–50 ms 全部 12/12 |

### 未验证 / 未通过

| 项 | 状态 |
|---|---|
| **SPEC §9「30 min 独占最小缓冲 = 0 xrun」** | **尚未达成**。前三次 30 分钟跑**各失败一次**（3 次 xrun + 播放停顿）。根因已定位并修（§8 坑 #2），**单曲 5 分钟确定性复现已通过**（xrun=0），但**完整 30 分钟还没重跑成功过** —— 第四次跑到 12:00 时为让 owner 听音而中止。**接手后第一件事就是把它跑完。** |
| `serviceRenderLiveness()` 看门狗 | 负例已验（462 断言无误报），**正例未验**（造不出流失效现场） |
| `outputNotPerfectReason` | 音量低于单位增益时**为空**（CR-010 只定义了两种措辞）。小缺陷，未修 |

### 未实现

| 项 | 卡在哪 |
|---|---|
| **Gapless（SPEC §3.7）** | **卡在测试素材**：本库 91 首只有 1 首有 `album` 标签，**同专辑+连续音轨号的相邻对 = 0** → 触发条件从不成立。要验必须先造带标签素材（手写 WAV + RIFF `INFO` 块，TagLib 认）。设计已定，见 PROGRESS §0q |
| **SMTC（SPEC §6.5）** | **CR-014 已裁定接受**（引擎只发事件、不自己执行、本期不做封面），**未开工** |
| **DSD/DoP（SPEC §3.5）** | 本机无 DSD DAC，只能回环验证。owner 未选 |
| 裸 ADTS `.aac` | SPEC 未要求。owner 未选 |

---

## 6. 正在飞的东西（接手后最可能要做的）

### 6.1 `docs/DSP-A-engine.md` —— owner 已批准的落地指令，**P0 已完成**

音效链：**中侧阶段 + crossfeed + 电平监测**。插入位置 owner 规定**照抄不要重排**。

| 阶段 | 状态 |
|---|---|
| **P0** 引入 kissfft | **已完成**：7 个文件落在 `third_party/kissfft/`（**字节数与文档表格逐个一致**），已进 `fetch-deps.ps1` / `CMakeLists.txt` / `README.md`；`--probe-spectrum` 正在用它，**编译与运行都已验证** |
| **P0'** libebur128 实时真峰值 | **判定完成**：`ebur128_prev_true_peak` 是纯数组读（RT 安全），但**更新它的 `add_frames` 路径会 `malloc`**（`ebur128.c:767` / `:1015`）→ **按文档退路自写轻量检测器**。另：`samplerate >= 192000` 时 `interp = NULL`（`ebur128.c:350`），**真峰值退化为样本峰值** → 必须有 `truePeakBasis` 字段 |
| **P1** 中侧阶段抽象 | **未开始。先做这一步** —— 它是唯一「移动已有代码」的改动，文档 §3 表格列了**四处必须同步改**，漏一处就是「宽度生效了但仍报 passthrough」的静默 bug |
| **P2** crossfeed | 未开始。3 档预设，4 个状态量**必须进 `reset()` 且 seek/切歌清零** |
| **P3** 监测 tap | 未开始。RT 侧只做 O(n) 累加，**FFT 归控制线程** |
| **P4** CR | **已写**：`CR-015`（`ev:'meter'` + 五条口径），**待 owner 裁定** |
| **P5** FFT 与聚合 | 未开始。用 `kiss_fftr`（**实数版**），Hann 窗，聚合成 **32–64 个对数频段**，波形用 min/max 抽点对 |

**⚠️ 这一项与 owner 的真机听感直接相关**：见 §8。owner 报告「声场和分离度被压」，
而**中侧宽度（P1）正是控制那个量的旋钮**。

### 6.2 其它

- `CR-014`（SMTC）已接受未实现；`CR-015`（meter）待裁定；`CR-011/012/013` 均已落地；
- Gapless 需要先造素材（§5）。

---

## 7. 工具链的坑（会浪费你半天的那种）

1. **只在样本上成立的验收比没有更糟。** 文档写着「RSS 51.4 MB 通过」——因为那一步只量到小文件。真相是 46.5 MB 的曲子冲到 **75 MB**，**超过 SPEC §8.2 的 60 MB**。已改成文件句柄读取。
2. **一个坏掉的头部可以同时废掉两套机制。** 本库有 **3 个文件的 `dr_flac totalPCMFrameCount` 比实际音频长**（其中一个多 23,040 帧 = 523 ms）。它同时让「曲尾结束判定」和「渲染线程的 draining 标志」永不成立 → 曲子结束了没人宣告 → 环排空 → 缓冲重开 → **位置冻结、`state` 却在说 `playing`**。修法：**让解码器成为「还有没有」的权威**，不要相信声明的总数。
3. **记录点放在函数的哪个出口，决定它会不会静默失效。** `WasapiOutput::open()` 有**两个成功出口**（独占提前 return），记录挂在其中一个上会**漏掉所有独占流**。现在挂在包装函数上。
4. **`set_output` 的回复说的是「调用那一刻」的输出状态**，不是之后开流的状态。用它报 `rate=` 会让**同一首歌在两轮里报出两个采样率**，看起来像引擎 bug，实际是读数读错了消息。要读**开流之后**的 `get_state`。
5. **诊断工具也会骗人（三次）。** 内置端点的独占曾被判「做不到」，其实是探针的 pump 用了共享模式的写法（`padding < bufferFrames`），**从来没喂过设备**；修好是 12/12。**说「某硬件不支持」之前，先确认仪器本身可信。**
6. **`pffft` 不能当独立 TU 用**：`soxr-0.1.3/src/` 下那份是 SoXR 的私有内联实现（自带符号前缀），所以「已 vendored pffft」是错的。这就是 P0 要新引 kissfft 的原因。
7. **Media Foundation 用两种 GUID 说同一件事**：AAC 是 `{00001610-…}`（WAVE 形状），ALAC 是 `{616C6163-767A-494D-…}`（MP4 sample entry，Data1 是大端 `alac`）。**认不出的一律当有损。** 另：`.m4a` 的编解码器要从 TagLib 的 `codecId()`（atom 的 4CC）读，不是 `codec()`。
8. **`--probe-mf --write-tone` 的中文路径会让 `argv` 炸掉**（ANSI 代码页）：用 `CommandLineToArgvW(GetCommandLineW())`，不要用 `argv`。
9. **进程归属不能按镜像名算。** 机器上有 **B 侧的引擎实例**；按 image name 扫会把它算成你的孤儿进程。
10. **长压测会占用 owner 的设备出声。** 我的 30 分钟压测以独占模式占着 DAC 连播了 91 首，而 owner 正在听。**跑任何会出声的东西之前先问。**
11. **编辑后行号全部作废。** 用内容锚点，不要用行号定位（我因此损坏过一次 PROGRESS）。
12. `node "<exe>" script` 是**参数顺序错**：要 `& "<系统工具目录>\node.exe" tools/drive.mjs`。

---

## 8. owner 的真机听感报告（2026-10-16）——结论指向一个明确方向

owner 报告：**「糊、声场不够清晰、分离度也不足」**。这一轮把所有**能由软件改变**的变量逐个量掉了：

| 变量 | 结论 |
|---|---|
| 解码 | 逐位正确（9.34 亿帧） |
| 音源 | 真无损（91 首顶到 Nyquist） |
| DSP 链（立体声 + 出厂默认） | 逐样本恒等 |
| WASAPI 格式 | 声道掩码/PCM/validBits/blockAlign 全对 |
| 独占 vs 共享 | **独占更好**（owner 判定） |
| 数字电平 100/50/25% | 无明确胜负 |
| 喂 DAC 的采样率 44.1 vs 96 | **无差别** |

**引擎的输出缓冲之后，没有任何一个软件变量能解释它。**

而 owner 同时说「**别的播放器明显更好**」。逻辑上：

> **如果 B 比一条已被证实逐样本忠实的路径「更好」，那 B 就不是忠实的 —— B 加了东西。**

**这不是缺陷，是两件事。** owner 想要的可能是**被染色过的声音**，而忠实路径按定义给不了。
**而这个项目已经有一个正当的出口，且 owner 已批准过它** —— `docs/DSP-A-engine.md` 的音效链：
**定位就是「与 bit-perfect 严格互斥、由用户主动开启」**，而**中侧宽度正控制「声场和分离度」**。

**建议：不要把忠实路径改成「听起来更好」**（那是这个项目存在的理由），
**把染色做成一个用户可控、明示的层** —— 也就是把 P1/P2 做出来。

---

## 9. 我在这一轮里报错过一次（把它写下来，因为形状可复现）

我看 `app.cpp` 的 `set_output`，看到只有 `exclusive` 和 `shared` 两个分支，而 CONTRACT 把 `mode` 定义为 `exclusive | shared | auto`。**于是我断言「`auto` 是空操作」并写了补丁。**

**我错了。** `app.cpp:1110` 本来就有 `else player_.setOutputMode(OutputMode::Auto);`，而 `output_wasapi.hpp:46` 的注释写得清清楚楚：`Auto, // try exclusive, fall back to shared`。实测 `auto` 开流后就是 `outputMode=exclusive / outputPerfect=true`。

**错因**：我的检索写的是 `OutputMode::Shared|OutputMode::Exclusive` —— **它匹配不到 `Auto`**，而我把「检索没找到」读成了「不存在」。

> **一条只能匹配到你已经想到的东西的检索，会确认你已经相信的事。**

已撤销、重新编译、实测验证。**接手时请假定「我读过的地方我都可能读漏」**——尤其是 grep。

---

## 10. 文档地图（按问题查，不要通读 PROGRESS）

| 想知道什么 | 看哪 |
|---|---|
| 协议/事件/错误码 | `CONTRACT.md`（**只读**） |
| 需求与验收判据 | `docs/SPEC-v2.1.md`（**只读**） |
| 契约变更与裁定历史 | `docs/contract-requests.md`（CR-001…**CR-015**） |
| 引擎功能的设计理由 | `docs/DESIGN-A-engine.md`、`docs/REFS-A-engine.md`、`REFS-A2-engine.md` |
| 音效链落地指令 | `docs/DSP-A-engine.md`（母方案 `DSP-v1-effects-chain.md`） |
| 怎么用引擎 | `engine/README.md` |
| **每轮做了什么、为什么、踩了什么** | `engine/PROGRESS.md`：**最新在最上面**（`## 0u` 起往前读） |
| 状态总览 / 能力表 / 下一步 | `PROGRESS.md` §1 / §1.2（三维口径）/ §5 |
| 已知限制 | `PROGRESS.md` §6 |
| 坑表（#1–#70+） | `PROGRESS.md` 后段 |

`PROGRESS.md` 章节与本文的对应：

```
§0u  owner 真机听感报告（糊/声场）→ 本文 §8
§0t  SPEC §9 停顿的根因（超报帧数）→ 本文 §7 坑 #2
§0s  被重开清零的计数器      → 同上
§0r  压测第一次失败           → 本文 §5 未验证
§0q  Gapless 卡在素材上       → 本文 §5 未实现
§0p  RSS 超标与文件句柄       → 本文 §7 坑 #1
§0o  CR-013 目录身份
§0n  诊断工具骗人             → 本文 §7 坑 #5
§0m  MP4 / Media Foundation   → 本文 §7 坑 #7
§0l  MP3 与「有损≠链路不完美」
§0k  切歌防爆音 + 热插拔
```

---

## 11. 接手后的第一件事

```powershell
Set-Location <仓库根>
powershell -ExecutionPolicy Bypass -File engine\tools\build.ps1
& "<系统工具目录>\node.exe" engine\tools\drive.mjs          # 期望 462 / 0
& ".\engine\bin\twilight-engine.exe" --selftest               # 期望 all checks passed
Get-Item CONTRACT.md,docs\SPEC-v2.1.md                        # 期望 mtime 仍是 2026/10/14
```

全绿之后再动任何东西。**然后**：

1. **把 SPEC §9 的完整 30 分钟压测跑完**（先问 owner 能不能出声）：
   `& "<系统工具目录>\node.exe" engine\tools\soak.mjs --minutes=30`
   —— 它现在应当通过；**在没有一次完整的 30 分钟通过之前，不要宣称 §9 达成**。
2. 若 owner 要动音效链：从 `docs/DSP-A-engine.md` 的 **P1** 开始（§6.1）。

---

## 12. 一句话

> 这个项目的验收标准是：**宁可不做，也不要一个只在样本上成立、或者连仪器本身都没验过的结论。**
> 引擎侧已经有三次「是诊断工具错了而不是被诊断的对象错了」—— 保持怀疑，包括怀疑你自己刚写下的那句话。
