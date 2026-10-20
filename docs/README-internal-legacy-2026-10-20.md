# Stringmoon（历史存档）

> 历史存档：本文件是仓库根 `README.md` 的**旧版原件**（2026-10-20 前的内部版本），为公开仓库做了
> **机器路径脱敏**（`<仓库根>`、`<Visual Studio 2026 安装目录>`、`<工具目录>` 等占位符），正文其余内容与原文一致。
> 文中的相对链接（`docs/...`、`CONTRACT.md`）沿用原件**从仓库根书写**的形态，因此在这里点击会 404 ——
> 请按仓库根解析，或直接查看 `docs/` 下的同名文件。

> **旧名 Twilight Echo。** 引擎与应用目录名（`engine/`、`app/`）、契约与规格里的标识符**保持原样不动**
> —— 更名只发生在品牌层（窗口标题、排印、图标、favicon）。见 [`docs/APP-Stringmoon-2026-10-16.md`](docs/APP-Stringmoon-2026-10-16.md)。

自用的 Windows 桌面音乐播放器：**接自己的音乐平台账号**（类 [Folia](https://github.com/chthollyphile/folia-major) 的用法），但用 **C++20 自研音频引擎** 做 Folia 做不到的事——WASAPI 独占、bit-perfect、EQ、ReplayGain。

> **只自用，不对外分发。** 这不是一个要发布的产品。

---

## 先读什么

| 顺序 | 文件 | 作用 |
|---|---|---|
| **0** | ⭐ **[`docs/INDEX.md`](docs/INDEX.md)** | **文档索引**：该读哪份、哪份别读（含 ⛔ 作废清单） |
| 1 | **[`CONTRACT.md`](CONTRACT.md)** | **冻结契约书。两个 AI 唯一的共同语言。** 接口、边界、共享事实全在这里 |
| 2 | [`docs/SPEC-v2.1.md`](docs/SPEC-v2.1.md) | 施工口径唯一版本（方案主体） |
| 3 | [`docs/SPEC-v2.0-legacy.txt`](docs/SPEC-v2.0-legacy.txt) | 历史参考，**已被 v2.1 取代**——但 **§5「澄明之境」设计规范仍在使用中**（UI 要逐条照它做） |
| 4 | [`docs/SPEC-v1.1-legacy.txt`](docs/SPEC-v1.1-legacy.txt) | 更早的历史参考 |

> ⚠️ **本项目有过一次真实事故**：有人读了**已作废**的 `DESIGN-v3-signal.md`，
> 照它写 `font-variation-settings: 'DOTS'` —— **那个轴名是编造的**，
> 实测是 `ROND` + `wght`，照写会**静默失效**。
> **→ 所以有一份 [`docs/INDEX.md`](docs/INDEX.md) 专门标注每份文档是否仍有效。**

### 交给 AI 的开工指令

| 交给谁 | 文件 | 一句话 |
|---|---|---|
| **AI-A（引擎）** | [`docs/BRIEF-A-engine.md`](docs/BRIEF-A-engine.md) | 自包含开工指令：C++20 + CMake → `twilight-engine.exe`，JSON Lines 协议 |
| **AI-B（应用）** | [`docs/BRIEF-B-app.md`](docs/BRIEF-B-app.md) | 自包含开工指令：Electron + React → UI / 平台接入 / 歌词动画 |

**两份都是自包含的**：各自读完即可起步，不需要看对话历史、不需要读对方那份。
**双方并行不阻塞**：A 写 `drive.mjs` 自测，B 写 `mock-engine.mjs` 开发 UI——见 CONTRACT §9.1。

### 界面系统（Nothing 系统设计 + Apple 物理 + 北欧克制）

**唯一权威：[`docs/DESIGN-v5-encoding.md`](docs/DESIGN-v5-encoding.md)**

| 给谁 | 文件 | 工作量 |
|---|---|---|
| **AI-A（引擎）** | [`docs/DESIGN-A-engine.md`](docs/DESIGN-A-engine.md) | **极小**：`degradeReason` 全覆盖 + 导出 `state` trace 作 fixture |
| **AI-B（应用）** | [`docs/DESIGN-B-app.md`](docs/DESIGN-B-app.md) | **几乎全部**：强制层 / C2 路径 / C1 光 / 动效 / 验证 |

> ⚠️ **`DESIGN-v3-still-water.md` / `DESIGN-v3-signal.md` / `DESIGN-v4-encoding.md` 全部作废，不要读。**
> 其中 `v3-signal.md` 有一处**编造的事实**（`font-variation-settings: 'DOTS'`）——实测轴名是 `ROND`+`wght`，照它写会**静默失效**。

**核心机制**：三个通道各有硬上限——**C1 光**（≤5 个操作，照搬 Nothing GDK 真实 API）、**C2 形**（几何编码音质，**零色彩依赖**）、**C3 字**（完整语义）。
检验方式是把界面**糊成马赛克**，仍能判断"在播吗 / 音质有没有问题"。
**"系统"不是写下来的，是机器强制的**——`check:tokens` 进 lint + 棘轮基线（见 DESIGN-B §3）。

## ⭐ 从这里开始：[`docs/MASTER-v1-plan.md`](docs/MASTER-v1-plan.md)

**总方案 v1** 是入口（不是内容容器）。它做四件子方案做不到的事：

| # | 它做什么 |
|---|---|
| **1** | **三家贡献总表** —— 一眼看清 Twilight_Echo / Folia / QueMusic 各自给了什么 |
| **2** | ⭐ **拉平成一条执行路线** —— 把三份子方案的 P0–P8 去重、理清依赖，分成 A/B/C/D 四阶段 |
| **3** | ⭐ **集中所有裁定项** —— 10 项待裁定 + 已裁定清单（勿重复问） |
| **4** | ⭐ **跨方案找矛盾** —— **本次整合已发现并修正 2 处**（"即点即播"的做法冲突、`backdrop-filter` 我给错的建议） |

### 子方案

| # | 文档 | 覆盖 | 状态 |
|---|---|---|---|
| ① | [`DESIGN-v5-encoding.md`](docs/DESIGN-v5-encoding.md) | **设计系统（唯一权威）** | 4 项待裁定 |
| ② | [`DSP-v1-effects-chain.md`](docs/DSP-v1-effects-chain.md) | 音效链（crossfeed / 中侧 / 监测） | **已裁定** |
| ③ | [`M3-v1-plan.md`](docs/M3-v1-plan.md) | 平台对接 / 曲库 / 歌词 / 性能 | 3 项待裁定 |
| ④ | [`PLAY-v1-login-and-streaming.md`](docs/PLAY-v1-login-and-streaming.md) | **多渠道扫码 + 即点即播** | 3 项待裁定 |
| ⑤ | [`PLATFORM-v1-provider-choice.md`](docs/PLATFORM-v1-provider-choice.md) | 平台选型调研证据 | 存档 |

### ⭐ 落地文件（**给两个 AI 的作战地图**）

**从总方案抽出的，每个 AI 读自己那份就知道做什么、等谁、验收什么。**

| 给谁 | 文件 | 核心里程碑 |
|---|---|---|
| **AI-A（引擎）** | [`docs/MASTER-A-engine.md`](docs/MASTER-A-engine.md) | ⭐ **门禁：实测 `dr_flac` 读取模式** → IO 后端（回环 HTTP）→ 音效链 → gapless |
| **AI-B（应用）** | [`docs/MASTER-B-app.md`](docs/MASTER-B-app.md) | 曲库（625 行可抄）→ 回环代理 → 网易云/QQ → 歌词 → 性能四条 |

**两条核心 KPI**：

- **AI-A**：**`HttpReader` 与 `FileReader` 逐字节等价** + **不碰音效链的人仍拿到逐样本恒等的原音**
- **AI-B**：**C2 正确区分「改了声音」与「只是在看」** + **DOM 3 万 → 1,500**

### 音效链（声场 / 声道 / 电平监测）

**母方案：[`docs/DSP-v1-effects-chain.md`](docs/DSP-v1-effects-chain.md)**（含 owner 六项裁定）

| 给谁 | 文件 | 工作量 |
|---|---|---|
| **AI-A（引擎）** | [`docs/DSP-A-engine.md`](docs/DSP-A-engine.md) | **几乎全部**：kissfft 引入 / 中侧抽象 / crossfeed / 监测 tap / FFT |
| **AI-B（应用）** | [`docs/DSP-B-app.md`](docs/DSP-B-app.md) | UI + 事件消费（**有一个易错的契约边界**：监测不算 DSP） |

**定位（owner 裁定 1）**：音效链与 **bit-perfect 严格互斥**——开了任何一项即 `outputPerfect=false`（C2 画波浪线）；
**但监测只读不改样本，不进 `dspModules`，`outputPerfect` 仍可为 true**。
SPEC §6.3 的「不做聆听房间」**保持不动**（HRTF / 卷积混响不做）。

**本轮三项**：crossfeed（bs2b 式，MIT，~200 行纯 IIR）+ 中侧阶段（从 `stereoWidth` 提升）+ 电平监测全套。
**FFT**：kissfft（**BSD-3-Clause**，已核实）——⚠️ **不是 pffft**：SoXR 内那份是私有内联实现，不能外链。

### 外部参考资产（**不是契约**，不影响 CONTRACT/SPEC 的权威性）

**四个来源，许可不同**——**不要混着抄**：

| | 来源 | 许可 | 语言 | 怎么用 |
|---|---|---|---|---|
| ① | [`BroNekoX/QueMusic`](https://github.com/BroNekoX/QueMusic)（211★） | **Apache-2.0** | Qt6/QML + C++20 | ✅ **可直接抄代码**（保留版权声明） |
| ② | [`Moekotori/ECHO`](https://github.com/Moekotori/ECHO)（1122★） | **AGPL-3.0** | Electron + TS + C++ | ⚠️ **只学模式，不要复制代码** |
| ③ | [`Px-asen/Twilight_Echo`](https://github.com/Px-asen/Twilight_Echo)（**316★**） | **Apache-2.0** | Electron + **C++20 原生引擎** | ✅ **可直接抄代码** |
| ④ | [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major)（**6540★**） | **AGPL-3.0** | TS/React + PixiJS | ⚠️ **只学模式** |

> ⚠️ **星数与 issue 数按最新核实**（2026-10-16）：Twilight_Echo **316★**、Folia **6540★ / 58 open**（其中 `is:issue is:open` 实为 **46**）。
> **早期文档里写的 313★ / 6350★ / 52 issues 都是过时数据。**

> 自用不分发 ⇒ 都不产生义务。**但若将来分发，AGPL 会传染整个仓库。**
>
> ⚠️ **`Px-asen/Twilight_Echo` 与本项目同名**（它 2026-05-02 创建，已发 1.3.0）。
> **同名不是问题**（自用不发布），但**它是最值得看的一个**：同为 Electron + C++20 原生引擎，
> 且它揭示了一个我们**可能在误报**的判定 —— 见 **CR-010**。

| 给谁 | 文件 | 重点 |
|---|---|---|
| **AI-A（引擎）** | [`docs/REFS-A-engine.md`](docs/REFS-A-engine.md) | QueMusic：`AudioDsp` 处理链与两个坑、auto headroom / preventClip 公式、SMTC（977 行、零依赖）、SQLite WAL 决策<br>ECHO：**seqlock 快照**、**两级 ready**、**`operationId`**、`inputEnded` vs `drained`、`gaplessPrepare` |
| **AI-A（引擎）·续** | [`docs/REFS-A2-engine.md`](docs/REFS-A2-engine.md) | ⭐ **Twilight_Echo：`outputPerfect` 双状态（CR-010）、`LoudnessAnalyzer`、`WasapiFormatNegotiator`、`bitperfect_tests`、三维能力模型**<br>ECHOAndroid：**Echo Link 协议全套**（现成对接说明书） |
| **AI-B（应用）** | [`docs/REFS-B-app.md`](docs/REFS-B-app.md) | QueMusic：**过期响应/代次**、请求计数→loading、`paytype` 归一、**增强 LRC 逐字**<br>ECHO：**9 状态 session 机**、**IPC 六条判据**、大曲库四条红线、模块地图 |
| **AI-B（应用）·续** | [`docs/REFS-B2-app.md`](docs/REFS-B2-app.md) | ⭐ **Folia：需求驱动 rAF（1083 字节）、字形 advance 插值、缓存命名空间隔离、本地分词优先**<br>它为什么 6350★（14 套动画 + 模组生态 + 本机歌词 API） |

> **ECHO / Twilight_Echo 的栈与 `app/` 逐项对应**（Electron + TS + 独立原生音频进程），
> 所以它们的架构决策与踩坑记录对 AI-B 直接适用；QueMusic 用 QML、Folia 是纯 Web，代码抄不过来但逻辑可移植。
>
> ⚠️ 四份都标注了优先级与「**不要抄的**」清单。QueMusic 的输出层（Qt `QAudioSink`）不是 OS 实时线程；
> ECHO 的原生 host 是 160KB 单文件 + 115MB FFmpeg；Folia 的 `main.cjs` **251KB** —— **都不要整读**。

---

## 这是什么 / 不是什么

**是**：
- 一个能放好我自己音乐的工具（本地 91 首 FLAC + 网易云 + QQ 音乐）
- 一次把「音频质量」和「动画手感」做到超过 Folia 的尝试

> ⚠️ **Navidrome 已于 2026-10-16 移出范围**（owner 裁定「跳过 Navidrome，只做网易云 + QQ」）。
> 早期文档里把它列为目标是过时的。理由记录在 [`docs/PLAY-v1-login-and-streaming.md`](docs/PLAY-v1-login-and-streaming.md) §7.2
> —— 它原本承担「最安全的通路验证」角色，跳过它意味着**第一个接入的就是最难的网易云**，故加了三条补偿措施。

**不是**：
- 不是 foobar2000 / HQPlayer 的替代品，也不是通用播放器
- 不做社交、商店、下载器、DRM 解密、音乐地图、VST3 宿主
- ~~不打包、不签名、不自动更新（自用不需要）~~ → **2026-10-17 owner 改判：出 Windows 安装包 + 支持自托管自动更新**（未签名；详见 [`docs/PACKAGING-v1-2026-10-17.md`](docs/PACKAGING-v1-2026-10-17.md)）。仍然不做社交、商店、VST3 等。

---

## 技术栈（已冻结，不再讨论）

```
Electron 44.x (TypeScript + React)   ← 外壳 + UI + 平台层 + 曲库
        │  JSON Lines over stdio
twilight-engine.exe (C++20)          ← 解码 / DSP / WASAPI 输出（独立进程）
        │
Node API 服务端（api-enhanced 等）    ← 主进程自动启动
```

**为什么不是 Slint**：三条设计语言核心效果在平台层做不到（逐元素模糊 #2066、自定义光标 #3905、点击穿透 #6021），且 1.18 默认后端空闲内存跳到 ~155MB（#13470）。

**为什么不是 Tauri**：Windows 实测常驻 ≈307MB，**高于** Electron 的 ≈279MB；且不带 Node。

**为什么引擎不是 Rust**：cpal 不支持 WASAPI 独占（#106 自 2016 至今 open，PR #1368 被 postponed）；VST3 宿主生态几乎空白（唯一像样的库仅 39★）；Symphonia 不支持 WavPack/APE。

细节与依据见 [`docs/SPEC-v2.1.md`](docs/SPEC-v2.1.md) §2。

---

## 第一个里程碑（唯一的"完成"定义）

> **在用户的 91 首 FLAC 上放出声来；界面上能看到歌词动画。**

可判定条目见 [`CONTRACT.md`](CONTRACT.md) §2（A1–A7）。

---

## 目录结构

```
<仓库根>\
├─ CONTRACT.md            ← 冻结契约书（双方只读）
├─ README.md              ← 本文件
├─ docs\
│  ├─ SPEC-v2.1.md        ← 现行施工口径
│  ├─ SPEC-v2.0-legacy.txt
│  ├─ SPEC-v1.1-legacy.txt
│  └─ contract-requests.md ← 接口变更请求入口（两个 AI 都能写这里）
├─ engine\                ← AI-A：C++20 引擎（CMake）
└─ app\                   ← AI-B：Electron + React 应用
```

---

## 本机环境备忘

```
MSVC 14.44.35207   C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools   ✅
MSVC 14.51.36231   <Visual Studio 2026 安装目录>  (VS Community 2026 18.10)                      ✅
                   <Visual Studio 2026 安装目录>   (VS Community 2026 18.11)                      ❌ 残缺，勿用
Windows SDK        10.0.26100.0
CMake              4.4.4
Node / pnpm / git  已装
磁盘               C: 48GB 可用 / D: 421GB 可用
```

- `cl.exe` **不在 PATH**（正常），构建前 source `vcvars64.bat` 或用 CMake 的 VS generator
- **`<工具目录>` 是只读 ACL，不要往那里装东西**
- 本机 PowerShell 执行策略会挡 `.ps1` 直跑 → 用 `powershell -ExecutionPolicy Bypass -File`

---

## 分工（硬边界）

| | AI-A（引擎） | AI-B（应用） |
|---|---|---|
| 目录 | `engine/` | `app/` |
| 语言 | C++20 + CMake | TypeScript + React + Electron |
| 产出 | `twilight-engine.exe` | Electron 应用 |
| 引用 | `CONTRACT.md` §3 | `CONTRACT.md` §4 §5 |

**两边都不得修改 `CONTRACT.md` 与 `docs/SPEC-v2.1.md`；不得进入对方目录改代码。** 需要接口变更 → 写 `docs/contract-requests.md`，等 owner 裁定。
