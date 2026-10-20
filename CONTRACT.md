# Twilight Echo · 冻结契约书 (CONTRACT)

> **这份文件是两个 AI 唯一的共同语言。**
> 它们看不到对方的代码、看不到对方的会话。凡是两边都要用到的名字、格式、边界，
> 只有写在这里才算数；没写在这里的，各自实现，合并时以这里为准。
>
> 冻结日期：2026-10-14 · 版本 v1.0
> 上位文档：`docs/SPEC-v2.1.md`；历史参考：`docs/SPEC-v2.0-legacy.txt`
>
> **改动规则**：本文件由人（项目 owner）修改。两个 AI 只读，不得自行修改。
> 需要改动时，在 `docs/contract-requests.md` 追加一条请求，由 owner 裁定。

---

## 0. 硬前提（所有决策的地基，不得推翻）

| # | 前提 | 后果 |
|---|---|---|
| P1 | **只自用，不对外分发** | 许可传染无效：GPL/AGPL 代码可读可抄；Slint 免版税、Rubber Band 商业授权等纠结全部作废；§12 合规红线章、Inno Setup/WinSparkle/signtool/appcast 全部删除 |
| P2 | **面向 Windows 10/11 单平台** | 平台抽象层保留最薄形态（一个接口文件），不做跨平台设计 |
| P3 | **本地曲库只有 91 首 FLAC**（`<测试曲库>`，多为 24bit/96k 级） | "10k 曲目 <5min 首扫"、音乐地图、指纹去重等规模功能失去意义 |
| P4 | **无独立 DAC；日常含蓝牙** | 蓝牙链路必然重编码 → bit-perfect 作废。**双模式**：有线=独占 HiFi，蓝牙=共享降级并在 UI 明示 |
| P5 | **主力账号登录平台（用户已知风险并接受）** | 必须实现低频访问约束（见 §5），不实现刷歌/自动扫描 |
| P6 | **业余 10–20h/周，无外部期限** | 范围按 MoSCoW 严管；阶段 0 必须在一周内可完成 |
| P7 | **代码主要交给 AI 写，用户做架构与验收** | 本文件的存在理由 |
| P8 | **两个 AI 各自独立会话，不共享上下文** | 接口必须先冻结；共享事实（库的生死、版本号）必须写进本文件 |

---

## 1. 技术栈（已定，不再讨论）

| 层 | 选择 | 理由 / 备注 |
|---|---|---|
| 外壳 | **Electron 44.x**（实测 44.7.2） | 主进程即完整 Node，API 服务端/扫码 MQTT 天然有位；自带 Chromium → blur/backdrop-filter 满血 |
| 渲染层 | **TypeScript + React**（Chromium/WebView2 无关） | 动画实现力最强；可参考 Folia 的 React 实现思路（AGPL，自用无约束） |
| 音频引擎 | **C++20 独立进程**（Moonwave，高性能架构） | Rust 侧缺口见 §6；引擎必须独立进程，不能是同进程 native module |
| 平台层 | **Node/TS** + 第三方 API 服务端 | 生态在 Node（见 §6），别在 C++ 里写平台协议 |
| 构建（引擎） | CMake + MSVC | 工具链见 §7 |
| 曲库 | SQLite（引擎侧或主进程侧，见 §4 的边界） | 最小可用集即可，不上 FTS5/trigram 直到曲库真的变大 |
| 互转 | **JSON Lines over stdio** | 见 §3 接口 A。可读、可调试、跨语言零胶水 |

### 明确不选（连同理由，避免重复讨论）

- **Slint**（v2.0 原选型）：三条设计语言核心效果在平台层做不到——逐元素模糊（slint#2066 open）、自定义图片光标/光晕指针（#3905 open）、鼠标点击穿透（#6021 open）。且 1.18 默认 skia 后端实测空闲内存跳到 ~155MB（#13470），"内存可控"不再是它的优势。手写歌词动画工期约为 Web 栈的 5–10 倍。
- **Tauri**：Windows 实测常驻 **≈307MB**，**高于** Electron 的 ≈279MB（因 msedgewebview2 子进程计入）；且不带 Node，需额外 sidecar 托 API 服务端。
- **Rust 引擎**：cpal **不支持 WASAPI 独占**（issue #106 自 2016 至今 open；PR #843 已关闭未合并；PR #1368 标记 postponed）；VST3 **宿主**生态几乎空白（vst3-sys 停在 2023-06，vst-rs 已 archived 且只是 VST2.4，唯一像样的 rust-vst3-host 仅 39★）；Symphonia 不支持 WavPack，APE 完全没有。仅 rubato（重采样）成熟。

---

## 2. 目标端（双方都必须能复现；这是唯一的"完成"定义）

**第一个里程碑（唯一验收标准）：**

> **在用户的 91 首 FLAC 上放出声来；界面上能看到歌词动画。**

拆成可判定的条目：

| 编号 | 判据 | 归属 |
|---|---|---|
| A1 | `pnpm dev` 起 Electron，显示应用壳（三区布局 + 播放栏） | 前端 |
| A2 | 扫描 `<测试曲库>`，列出 91 首，显示标题/艺术家/时长 | 前端（曲库）+ 引擎（读标签） |
| A3 | 双击任一曲目 → **从本机声卡放出声**，进程不崩 | 引擎 |
| A4 | 播放/暂停/停止/上下曲/Seek/音量全部可用，UI 状态与引擎一致 | 双方按接口 A |
| A5 | 进度条随播放推进（不必是最终视觉） | 前端 |
| A6 | 至少一种歌词视觉动起来（数据源：AMLL TTML DB 或内嵌/本地 LRC） | 前端 |
| A7 | 应用退出时引擎进程不残留 | 引擎 |

**明确不在第一个里程碑内**：平台账号登录、Navidrome、EQ、ReplayGain、DSD、VST3、主题系统、迷你模式、音乐地图、安装包。

---

## 3. 接口 A：引擎 ⇄ 应用（冻结）

### 3.1 进程与通道

```
twilight-engine.exe           ← 独立进程，由主进程 spawn
  stdin   : 命令流（JSON Lines，UTF-8，\n 结尾）
  stdout  : 事件流（JSON Lines，UTF-8，\n 结尾，严格一行一条）
  stderr  : 人类可读日志（不要用 stdout 写日志！）
```

**铁律**：
1. **stdout 只允许出现 JSON Lines**。任何 `printf`/库的调试输出都必须走 stderr，否则前端解析必崩。
2. **音频样本绝不穿越此通道**。引擎直接对声卡输出。此通道只传命令与状态。
3. 消息中的时间单位一律**毫秒（整数）**；采样率单位 Hz；音量 0.0–1.0（float）。

### 3.2 命令（应用 → 引擎）

每条命令**必须有 `id`**（应用侧自增整数），引擎的回复必须带同一个 `id`。

```jsonc
{"id":1,"cmd":"hello","protocol":1}
{"id":2,"cmd":"pick_folder"}                                  // 引擎侧弹原生目录选择，返回 path
{"id":3,"cmd":"scan","path":"<测试曲库>"}       // 扫描并入库
{"id":4,"cmd":"open","trackId":"tl_0001"}                     // 装载（不自动播放）
{"id":5,"cmd":"play"}
{"id":6,"cmd":"pause"}
{"id":7,"cmd":"stop"}
{"id":8,"cmd":"next"}
{"id":9,"cmd":"prev"}
{"id":10,"cmd":"seek","positionMs":42000}
{"id":11,"cmd":"set_volume","volume":0.75}
{"id":12,"cmd":"set_output","mode":"exclusive","deviceId":"..."}  // mode: exclusive | shared | auto
{"id":13,"cmd":"list_devices"}
{"id":14,"cmd":"list_tracks"}
{"id":15,"cmd":"shutdown"}
```

### 3.3 事件（引擎 → 应用）

```jsonc
{"ev":"ready","protocol":1,"version":"0.1.0","devices":[...]}       // 进程起来后第一条
{"id":2,"ok":true,"data":{"path":"..."}}                            // 命令回复（ok:true）
{"id":5,"ok":false,"error":{"code":"ERR_DEVICE","message":"..."}}   // 命令回复（ok:false）
{"ev":"position","trackId":"tl_0001","positionMs":42000,"durationMs":213000}
{"ev":"state","state":"playing","trackId":"tl_0001","outputMode":"exclusive","sampleRate":96000,"bitDepth":24,"bitPerfect":true}
{"ev":"ended","trackId":"tl_0001","reason":"eof"}                   // reason: eof | stop | error
{"ev":"scan_progress","done":40,"total":91}
{"ev":"scan_done","added":91,"failed":0}
{"ev":"device_changed","deviceId":"...","name":"..."}
{"ev":"xrun","count":1,"bufferMs":6}                                // 欠载计数
{"ev":"log","level":"warn","message":"..."}                         // 需要上报给 UI 的告警
{"ev":"fatal","code":"ERR_DEVICE","message":"..."}                  // 进程即将退出
```

`state` 事件的字段是**权威值**，UI 不得自行推断播放状态。

### 3.4 错误码（冻结）

| 码 | 含义 |
|---|---|
| `ERR_DEVICE` | 输出设备打不开 / 被独占 / 已失效 |
| `ERR_DECODE` | 解码失败（损坏文件、不支持的编码） |
| `ERR_NOTFOUND` | trackId 或路径不存在 |
| `ERR_STATE` | 当前状态下不允许该命令（如未 open 就 play） |
| `ERR_UNSUPPORTED` | 该能力当前不可用（如 DSD / 独占被降级） |
| `ERR_INTERNAL` | 其他内部错误 |

**降级不是错误**：独占不可用时自动转共享，用 `state.outputMode` + `state.bitPerfect=false` 表达，不返回 `ok:false`。只有当两种模式都打不开设备时才返回 `ERR_DEVICE`。

### 3.5 trackId

格式：`tl_` + 4 位序号（`tl_0001`）。由引擎在扫描时分配并持久化，前端不得自行生成。
（若前端需要自己的 id，用 `ui_` 前缀，并以后端 trackId 为准。）

---

## 4. 接口 B：平台层（冻结）

### 4.1 形态

**用户自备 API 服务端 + 应用内置自动启动**（Folia 桌面版做法）：
Electron 主进程在启动时拉起 API 服务端子进程，前端只访问本地 URL。

```
主进程
  ├─ 起 netease API 服务端   → http://127.0.0.1:<port>
  ├─ 起 qq API 服务端        → http://127.0.0.1:<port>
  └─ 通过 preload 暴露的 window.twilight.* 给渲染层
```

**端口不得硬编码**：启动时取空闲端口，通过 IPC 告知渲染层；渲染层不得假设 3000/18080。

### 4.2 平台提供者接口（每个平台实现同一套）

```ts
interface MusicProvider {
  readonly id: 'netease' | 'qq' | 'navidrome' | 'local';
  readonly displayName: string;
  readonly capabilities: {
    search: boolean;
    login: 'qr' | 'cookie' | 'none';
    wordLevelLyrics: boolean;   // true 仅当该源原生提供字级时间轴
    hiRes: boolean;
  };

  login(): Promise<void>;                     // 扫码或 cookie 注入；登录态不得落盘明文
  isLoggedIn(): Promise<boolean>;

  search(q: string, limit?: number): Promise<Track[]>;
  getPlayUrl(trackId: string): Promise<{ url: string; format: string; bitrate?: number }>;
  getLyrics(trackId: string): Promise<Lyrics | null>;
}
```

### 4.3 歌词归一化格式（冻结 —— 前端动画只认这一个）

无论来源是 TTML / YRC / QRC / LRC，**取到后必须归一化成本结构**：

```ts
interface Lyrics {
  lines: Array<{
    startMs: number;
    endMs: number;
    words: Array<{ text: string; startMs: number; endMs: number }>;  // 可空数组
    text: string;            // 该行纯文本（= words 拼接，或在无 words 时原文）
    translation?: string;    // 翻译行
    romanization?: string;   // 罗马音/音译
    background?: boolean;    // 背景人声
  }>;
  wordByWord: boolean;   // true=数据源原生字级；false=本方插值合成。**必须如实标注**
  source: 'amll-ttml' | 'netease-yrc' | 'qq-qrc' | 'lrclib' | 'local' | 'embedded';
}
```

**插值兜底**：只有行级数据时，按字/词等分线性插值到 `[startMs, endMs]`，或按字符数加权。此时 `wordByWord` 必须为 `false`。

### 4.4 歌词数据源优先级（冻结）

1. **内嵌/本地歌词文件**（同目录同名 `.lrc` / `.ttml`）
2. **AMLL TTML DB** —— 逐词 TTML 事实标准，CC0-1.0，按各平台歌曲 ID 直链：
   `https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/ncm-lyrics/<歌曲ID>.ttml`
3. **网易云 `yrc`** —— 请求时带 `yv=-1` 即返回字级：`[行起点,行时长](字起点,字时长,0)字`
   （注意：`klyric` 字段实测多为空串，不要用它）
4. QQ QRC —— **不做**（需自建解密，性价比最低）
5. LRCLIB —— **只作行级兜底**；其 `hasWordSync` 字段实测恒为 false，不要当词级源用

---

## 5. 账号与风控约束（硬要求）

用户使用**主力账号**，因此以下为强制实现约束：

| 约束 | 具体要求 |
|---|---|
| 访问频率 | 同一平台请求间隔 ≥1s；**禁止**任何批量/循环拉取 |
| 禁止行为 | 不实现刷歌、不实现自动签到、不实现后台自动扫描歌单、不做推荐流轮询 |
| 请求节流 | 统一在平台层做令牌桶，任何调用方都不得绕过 |
| 失败退避 | 收到风控类错误码（如 `-460`）立即停止该平台全部请求并提示用户，不重试 |
| 凭据存放 | 用 Electron `safeStorage`（Windows=DPAPI）。**Electron 46 起同步 API 已移除**，现在就用异步版：`isAsyncEncryptionAvailable()` / `encryptStringAsync()` / `decryptStringAsync()` |
| QQ 特例 | 上游 `20279` = 登录设备数超限 → 提示用户去「设备管理」清理，不要自动重试 |

已知风险（事实，不是猜测）：`-460 Cheating` 出现过 24 小时未恢复；有报告称用 API 后**网页端歌单全部无法播放**；约 1 次/分钟的高频访问即被封。

---

## 6. 共享事实表（两个 AI 各自去搜会搜出不同答案，所以写在这里）

### 6.1 组件生死表

| 组件 | 状态 | 用哪个 |
|---|---|---|
| **NeteaseCloudMusicApi**（Binaryify） | **已 archived**，最后 push 2024-02-28，迁 GitLab | ❌ 不要用 |
| **api-enhanced**（NeteaseCloudMusicApiEnhanced） | 活跃，MIT，push 2026-10-06，npm `@neteasecloudmusicapienhanced/api` | ✅ 用这个 |
| **QQMusicApi**（jsososo） | 最后 push 2024-06-25，停滞 | ⚠️ 别用 |
| **qq-music-api**（Rain120 / 活跃 fork `@yakult-green-tea/qq-music-api`） | Rain120 版 push 2026-10-11 | ✅ Folia 用的就是这个 fork |
| **Navidrome** | 活跃，GPL-3.0，push 2026-10-13 | ✅ |
| **OpenSubsonic 规范** | 活跃，Apache-2.0，有完整 `openapi/openapi.json`（36KB）可代码生成 | ✅ 但**没有现成 TS 客户端**，自己生成 |
| **AMLL TTML DB** | 活跃，**CC0-1.0**，逐词 TTML | ✅ 歌词主源 |
| **Folia**（参照物） | 6165★，AGPL-3.0，TypeScript，push 2026-10-14 | 只读参考（自用无许可约束） |

### 6.2 音频/平台事实（会影响实现，不要凭记忆写）

| 事实 | 影响 |
|---|---|
| **WASAPI 独占最小周期**：板载 HD Audio 3ms（44.1k/132 帧）**可用**；**USB 类驱动的事件驱动独占劣化到 9ms**（MS Q&A 2022-05，至今无修复）；MS 官方示例直接取 10ms；**<10ms 才升 MMCSS「Pro Audio」**；共享模式 `GetSharedModeEnginePeriod` 官方示例 default=448 帧 ≈**10.16ms** | "3ms 周期 ×2 起步"是**部分硬件的终点，不是默认起点**。必须做能力探测，并把实际落点报给 UI |
| **DoP 现行只有 v1.1（2012-03-30）**，无新版。DSD64→176.4k、DSD128→352.8k 未变；**DSD256→705.6k 是外推**（规范正文只写到 128FS）。接收端需**连续 32 个标记字节**才切 DSD；不支持 352.8k 的链路改走"通道对 + 另一标记字节" | 写进实现注释，别把外推当规范 |
| **RTSan 不支持 Windows**（官方 README 明确；运行库只发 macOS/Linux） | **不能作为 Windows CI 门禁**。实时安全验证只能在 Linux/WSL 跑，或退回人工断言 + 压力测试 + xrun 计数 |
| **Electron 与 WASAPI 独占无已知冲突**（electron/electron 全仓按标题搜 0 条） | 风险是 Chromium 自身以共享模式占着端点 → **独占播放必须由独立子进程完成，并且让它先拿到设备** |
| **TagLib 是 LGPL-2.1 / MPL-1.1**（不是 MPL-2.0） | 自用无约束，但别写错 |
| **Chromaprint** 自身 MIT 但内含 FFmpeg 代码 → **整体按 LGPL-2.1 对待** | 已砍（去重不做） |
| **SoXR 停更于 2018-02-24**；**libebur128 停更于 2021-02-14** | 音频数学稳定，实用风险低，但知道它们不再修 |
| **signalsmith-stretch 无 release tag** | 只能按 commit 锁定（若将来用到） |
| **SoundTouch 仓库已迁 Codeberg**，GitHub 地址 404 | v2.0 附录 B 的链接是坏的 |
| FFmpeg 现行稳定 **9.0.2**（2026-09-18）；LGPL-2.1+，需 `--disable-gpl` **及 `--disable-nonfree`** | 自用可放宽，但构建脚本沿用官方清单更省事 |
| VST3 自 3.8（2025-10-20）**MIT**，无 GPL 残留；**但 VSTGUI 与 mda-vst3 示例是 BSD 式**，VST2 API 不在内 | 若做 VST3 宿主注意边界 |

---

## 7. 构建环境（开发机实测）

```
MSVC 14.44.35207   C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
                   └ VC\Auxiliary\Build\vcvars64.bat  ✅
MSVC 14.51.36231   Visual Studio 2026 18.10（装在非系统盘、路径含非 ASCII 字符） ✅
                   ⚠ 同一台机器上还有一份 18.11 的残缺安装（缺 C++ 工作负载），别选它
Windows SDK        10.0.26100.0
CMake              4.4.4  (WinGet)
Node               独立安装目录下的 node.exe（不在系统目录）
pnpm               %APPDATA%\npm\pnpm.ps1
git                任意 Git for Windows 安装（cmd\git.exe 在 PATH 上即可）
磁盘               C: 48GB 可用 / D: 421GB 可用
```

- `cl.exe` **不在 PATH 上**（这是正常的）。构建前 source `vcvars64.bat`，或用 CMake 的 Visual Studio generator 让它自己找。
  `engine/tools/build.ps1` 用 `vswhere` 自动定位 Visual Studio，不要手工填安装路径。
- **Node 所在目录是只读 ACL，不要往那里装任何东西。**
- 本机 shell 执行策略会挡 `.ps1` 脚本直跑（DSH 环境准备脚本曾因此失败），需要时用 `powershell -ExecutionPolicy Bypass -File`。

---

## 8. 分工与文件边界（**硬边界，越界即冲突**）

| | **引擎侧（AI-A）** | **应用侧（AI-B）** |
|---|---|---|
| 语言 | C++20 + CMake | TypeScript + React + Electron |
| 目录 | `engine/` | `app/` |
| 产出 | `twilight-engine.exe` | Electron 应用 |
|  owns | 解码、重采样、DSP、WASAPI 输出、设备管理、标签读取、扫描 | UI、歌词动画、曲库展示、平台接入、登录态、设置 |
| 只读引用 | `CONTRACT.md` §3 | `CONTRACT.md` §4 §5 |

**边界铁律**：
1. **`CONTRACT.md` 与 `docs/SPEC-v2.1.md` 双方只读**，不得修改。
2. **不得进入对方目录改代码**。
3. 需要接口变更 → 在 `docs/contract-requests.md` 追加请求，等 owner 裁定；**不要自行扩展 JSON 字段**（多余字段会被对方忽略，但别指望对方理解）。
4. `engine/README.md` 与 `app/README.md` 各自维护自己的构建步骤。

---

## 9. 第一个里程碑之前，双方各自的第一件事

**开工指令（每个 AI 只读自己那一份，里面有完整步骤）**：

- AI-A（引擎）→ **`docs/BRIEF-A-engine.md`**
- AI-B（应用）→ **`docs/BRIEF-B-app.md`**

| AI-A（引擎） | AI-B（应用） |
|---|---|
| 建 `engine/` 的 CMake 工程，产出一个能跑 `hello`/`ready` 的**空引擎**（先不解码），stdout 严格 JSON Lines | 建 `app/` 的 Electron + React + TS 工程，出一条能显示三区布局的窗口 |
| 同时写 `engine/tools/drive.mjs`：spawn 引擎、喂命令、解析 stdout —— **这是 A 的自测工具与"假应用"** | 同时写 `app/tools/mock-engine.mjs`：假装自己是引擎、严格按本契约收发 —— **这是 B 的"假引擎"** |
| 加 `scan`：遍历目录、TagLib 读标签、返回 91 首（**不做 FTS5、不做断点续扫**） | 接 `scan` 结果，用列表显示曲目（虚拟列表先不做） |
| 加 `open`+`play`：WASAPI **共享模式**先跑通放声（独占放第二步） | 接六个命令，做出播放栏与进度 |
| 导出 `engine/fixtures/library-91.json`（真实元数据） | 先用自造占位 fixture，等 A 的那份出现后替换 |

### 9.1 握手契约（**双方并行不阻塞的关键**）

**两个 AI 都不得等待对方。** 各自实现契约的另一侧：

```
   ┌──────────────┐                      ┌──────────────┐
   │   AI-A 侧    │                      │   AI-B 侧    │
   │              │                      │              │
   │  真引擎 exe   │◄─── CONTRACT §3 ────►│   真应用     │
   │              │                      │              │
   │  drive.mjs   │  ← A 写的"假应用"     │              │
   │  (A 自测用)   │                      │ mock-engine  │  ← B 写的"假引擎"
   └──────────────┘                      └──────────────┘
```

- **A 用 `drive.mjs` 验证引擎**，不需要 B 的 UI 存在
- **B 用 `mock-engine.mjs` 开发 UI**，不需要 A 的引擎存在
- 两边**唯一真实的交接点**：`CONTRACT §3` 的字节，以及 `engine/fixtures/library-91.json`

**合并判据**：把 B 的 spawn 目标从 `mock-engine.mjs` 换成真 exe，**协议代码应当一行都不用改**。
若需要改动，说明其中一方偏离了契约 → 走 `docs/contract-requests.md`，**不要私下迁就**。

**为什么先共享模式**：先证明"能放出声"，再证明"放得对"。独占是第二个里程碑。

---

## 10. 本文件不覆盖的内容

- UI/UX 视觉细节 → 见 `docs/SPEC-v2.1.md` §5（含已确认不可实现的三条效果及其替代形态）
- 引擎内部线程模型、DSP 算法 → 见 `docs/SPEC-v2.1.md` §3
- 部署/打包 → 自用，暂不需要（§9.3 大部分已删）

---

**变更记录**

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-14 | v1.0 | 首版冻结。基于一次完整拷问：确立 Electron + C++20 独立进程 + Node 平台层；确定 91 首 FLAC 为测试库；三个接口冻结；两个 AI 的边界划定 |
| 2026-10-14 | v1.1 | 补 §9 开工指令指针（BRIEF-A / BRIEF-B）与 **§9.1 握手契约**：明确两个 AI 各自实现契约另一侧、不得互相等待；给出合并判据 |
