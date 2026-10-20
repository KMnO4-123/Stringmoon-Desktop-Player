# Twilight Echo · 应用侧移交（2026-10-16）

> 更新时间：2026-10-16 · 项目根目录 `<仓库根>` · 应用目录 `<仓库根>\app`
> 这是**当前状态的移交**，不是新的开发需求。上一份是 `HANDOFF-B-app-2026-10-15-current.md`（保留作历史）。
> 作战地图是 `docs/MASTER-B-app.md`（A1/A4-1 的落地标注与 E1 的前提更正已写回该文件）。
>
> **2026-10-17 增补：歌词链路已换掉**（本地多格式 + 在线取词 + 逐字/注音/翻译）。
> 细节与实测见 [`LYRICS-v1-online-2026-10-17.md`](LYRICS-v1-online-2026-10-17.md)，契约侧的追加请求见 **CR-018**。
> 本文件 §3 的表格已按新实现更新，§0 的状态表同步。

## 0. 一句话状态

| 块 | 状态 |
|---|---|
| M1 本地播放（曲库 / 播放栏 / 歌词 / C1 光通道 / C2 信号路径 / 沉浸播放 / 音效页） | ✅ 完成，长期回归 |
| M2 音频质量链 UI（EQ 10 段、ReplayGain、限幅、声道、**中侧增益 / 交叉馈送**、信号路径叙事） | ✅ 完成（中侧与交叉馈送是**今天由另一个写者**补的，见 §6 第 14 条） |
| 播放栏扩展（循环四态 / 原生静音 / 输出模式偏好） | ✅ 完成（引擎 `set_repeat`/`set_muted`/`set_output`） |
| 实时频谱 / 电平监测面板 | 🟢 `ev:'meter'` 已接入真实样本；连续曲线无数据不绘制。owner 已允许 `set_meter`，主进程统一同步窗口可见性 |
| 性能（列表虚拟化 / 切页 / 日志脱敏） | ✅ 见 §4 |
| 歌词（本地多格式 + 在线取词 + 逐字/注音/翻译） | ✅ **2026-10-17 完成**（见 `LYRICS-v1-online-2026-10-17.md`）；在线链路真实网络验收 5/5，冷启动 1.3–2.4 s；**行级歌词也会逐字填充**（渲染视图插值，如实标注）；**可保存为音乐旁同名 `.ttml`**（之后本地优先、不再联网）；匹配另有**时间轴自洽校验**；**字级 yrc**（weapi 加密，中文歌约 3/6）、**候选人工纠正**、**内嵌歌词**（`source:'embedded'`，不动引擎）；预取按 owner 裁定**不做**；`test:app` 210、`test:electron` 69 |
| M3 平台接入（回环媒体代理 + 网易云 + QQ） | ⛔ **未开工**。前置里 A1 已做，A2/A5 未做，A3（曲库 625 行）未做。⚠️ 歌词这一块**已经先走了一条不依赖登录的窄路**（未登录公开接口），平台层开工时不要重复实现 |

## 1. 接手先看这里（五件事，按重要性）

### ① `engine/` 不属于你，且它在被另一个会话实时改动

`engine/PROGRESS.md` 写明那是 **AI-A（引擎）** 的记录。同工作区协作纪律：**动 `engine/` 前先看 mtimes 与 PROGRESS 归属**。
本会话早期就撞过一次（我按需求加了一个纯虚函数，而 AI-A 已用别的形状实现），已回滚 —— 那次教训写进 §6。

**音频端点会被周期性独占**：AI-A 跑 30 分钟独占压测时，应用的共享模式开流会被拒，报
`ERR_DEVICE: shared-mode stream refused (0x8889000A)`（= `AUDCLNT_E_DEVICE_IN_USE`）。
表现为 `test:integration` / `test:electron` / `test:player` / `test:library` 中途失败。
**那是争用，不是回归**。判定与处置：`Get-Process -Name 'twilight-engine*'` 有就等它自然退出（每轮约 30 分钟），
**不要去杀别人的进程**。本会话靠这条规矩跑完了十余轮验证。

### ② 窗口测试必须先 `pnpm build`

`test:electron` / `test:player` / `test:library` 消费构建后的 `out/`；**改了 renderer 或 main 源码不 build 就跑，测的是旧产物**。
本轮就吃过：端到端断言先 FAIL，查下来是源码改了、`out/` 没重建（单元测试直接 import 源码，所以只有窗口测试会暴露）。

### ③ 诚实性是硬约束，不是风格偏好

这个项目的红线集中在「**界面不得声称一件没发生的事**」：

- **监测不算 DSP**：`dspModules` 的语义是「有东西在改样本」。只开频谱时 C2 路径必须与「什么都没开」**完全一致**，
  `outputPerfect` 仍为 true（有断言钉住，`tools/meter.test.mjs`）。
- **没有数据就不画**：频谱在没有 `meter` 事件时不画曲线（画一条平的等于宣称「此刻静音」）；
  歌词在无数据时不假装逐字（`BRIEF-B-app.md:184`）。
- **不冒充**：位深 / 位精确 / 封面来源都如实标注（封面 alt 文案区分嵌入图与本地图；
  3D 唱片的中心标签是排印元数据，注释明写 never claimed album art）。
- **数字不外插**：补间只用于视觉（歌词填充）；时间、进度、音量等数字一律取引擎权威值。

### ④ 曲库这份「参考曲库」没有标签

`<测试曲库>` 的 91 首 FLAC 里**只有 1 首带标签**（专辑/年份/风格），其余 `artist` 为空、
`title` 就是文件名（`Test Artist - 测试曲目 001`）。应用侧 `displayTrack` 按「Artist - Title」惯例拆分显示，
所以**专辑与年份在这份曲库上大多如实为空** —— 不是没做，是文件里没有。
封面同理：91 首**全部**取不到图（0 嵌入图、目录里 0 张同名/cover 图），所以看到的是排印兜底封面。

### ⑤ 文档权威顺序（别看错）

`CONTRACT.md` / `SPEC-v2.1.md`（契约，最高）→ `docs/MASTER-v1-plan.md` + `MASTER-B-app.md`（作战地图）→
`DESIGN-v5-encoding.md`（设计系统唯一权威）→ `docs/DSP-B-app.md` / `M3-v1-plan.md` / `PLAY-v1-*.md`（专题落地）→
`REFS-B-app.md` / `REFS-B2-app.md`（外部参考的印象）。
**`docs/HANDOFF-B-app.md` 是早期版本**，它的「UI 描述」已被后来的用户要求覆盖，但音频协议边界仍然有效。

## 2. 环境与复现

```powershell
Set-Location -LiteralPath '<仓库根>\app'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 见 §6 第一条坑
pnpm dev          # 正常启动（引擎默认 engine/bin/twilight-engine.exe，不存在时回退 mock）
```

**完整检查**（顺序敏感：先 build 再窗口测试）：

```powershell
pnpm lint         # typecheck + 设计令牌检查（tokens.css 是唯一允许字面色值的文件）
pnpm test:app     # 单元：状态机、DSP 解析、歌词、频谱仓、脱敏、封面、曲库模型…
pnpm test:c2      # C2 路径编码
pnpm test:protocol# mock 引擎协议自测
pnpm build
$env:TWILIGHT_ENGINE = '<仓库根>\app\.smoke\qa-runtime\twilight-mp3-fixed.exe'
pnpm test:integration  # 真引擎播放/暂停/seek/扫描/关闭（会短暂真实出声）
pnpm test:electron     # 真实 Electron + 真 preload + 真引擎（53 项）
pnpm test:player       # Playwright 真实交互、布局与像素（播放时音量为 0）
pnpm test:library      # 曲库目录集合的一致性契约（连续多次真实启动）
```

窗口测试用的隔离与固定副本：

- 用户配置隔离：`test:electron` → `.smoke/qa/profile`；`test:player` → `.smoke/player/profile`；`test:library` → `.smoke/library/profile`。
  **真实用户配置 `%APPDATA%\twilight-echo-app\` 不会被这些测试写入**（有断言与人工核查）。
- **固定引擎副本（当前）**：`.smoke/qa-runtime/twilight-qa-2026-10-16.exe`
  （SHA-256 `3fb18a4db339478c9f3cac15906a9b7a95d2090a2ff856861dde0d921cd00c14`，2026-10-16 11:33 构建）。

  **为什么换了**：旧副本 `.smoke/qa-runtime/twilight-mp3-fixed.exe`（`e963a166…`，10-15 20:36）**早于引擎的中侧/交叉馈送实现**，
  跑音效页那几条断言会失败，而且**失败方式很像产品 bug**：滑块按右键没反应、`get_state.dsp.channels` 里干脆没有
  `midGainDb`/`sideGainDb` 字段，直接发命令只得到
  `[ERR_STATE] set_channels needs at least one of balance | mono | stereoWidth | swapChannels | channelGains`
  —— **引擎用它接受的字段名单自己招认了能力**，这是最快的判据（原文见 §6）。
  旧副本与更早的 `.smoke/qa-runtime/twilight-cover-qa.exe`（`fcec9698…`）都保留作对照，但**不要再用来验收音效页**。

  规矩：**固定副本的版本要 ≥ 应用所消费的引擎能力**；AI-A 加新能力后，跑 `test:player` 前先确认副本里有它。
  **`engine/bin/twilight-engine.exe` 由 AI-A 持续重建**，哈希随时会变 —— 别把它写进任何期望值。


## 3. 当前功能与代码入口

路径均相对 `<仓库根>\app`。行数为写作时的实测值，用来判断「改一处要读多少」。

### 主进程（`src/main/`）

| 文件 | 行 | 职责与要点 |
|---|---|---|
| `engine-host.ts` | 195 | **唯一 spawn 点**；stdout 只走 JSON Lines，stderr 只当日志（**已脱敏**，见 §4） |
| `index.ts` | 128 | IPC 汇总：曲库目录集合、封面、歌词、协议转发；`configureLibrary(userData/library.json)` |
| `library-config.ts` | 131 | 曲库目录是**一组**并持久化（`{directories,configured}`，旧 `{directory}` 自动迁移）；只接受存在的绝对目录 |
| `artwork.ts` | 121 | 封面四级回退：自定义 → 嵌入图（`music-metadata`）→ 同名图 → `cover/folder/front`；带魔数/尺寸/解码校验与 60s 缓存 |
| `lyrics.ts` | 342 | 本地歌词：附加文件 → 同名 `.lrc`/`.ttml`/`.yrc`（**格式按内容判**）→ fixtures；另有 `resolveOnlineLyrics()`（缓存优先，绝不重复联网） |
| `lyrics-online.ts` | 560 | **在线取词**：网易云搜索并计分 → AMLL TTML（逐字+翻译+注音）→ 网易云行级（原文+中译+罗马音）→ LRCLIB；平台级节流 + `-460` 熔断 |
| `lyrics-cache.ts` | 118 | 在线结果持久化（`lyrics-online.json`）：命中永不重查，未命中记 7 天，纯音乐记为结论 |

### 渲染层（`src/renderer/src/`）

| 文件 | 行 | 职责与要点 |
|---|---|---|
| `store.ts` | 391 | 权威状态 + intent 状态机；**position / meter 不进全局 store**（各自独立仓） |
| `App.tsx` | 269 | 四视图、启动握手与曲库扫描、横幅堆叠；**视图切换只动 opacity/y、无整屏 blur、交叠式** |
| `components/Playbar.tsx` | 267 | 传输控制 + 进度 + 循环/静音/输出模式 + 信号与详情弹层；**横向配比只在 player.css 定义** |
| `components/LibraryList.tsx` | 170 | 曲库列表：**虚拟化**（槽位池化）、目录面板、歌曲/艺术家切换、搜索与筛选 |
| `components/LyricsView.tsx` | 300 | 歌词：React 只画结构（快照是**活性行下标**），填充由画笔按帧驱动；行级数据在渲染前插值补词；命中信息与高风险标记进悬浮说明 |
| `lyricFill.ts` / `lyricPlayhead.ts` | — | 逐字填充数学（按实测宽度插值）/ 视觉播放头（补间规矩见 §6） |
| `audio/SpectrumPanel.tsx` + `meterStore.ts` | 156 + 122 | 实时频谱与电平读数（**消费 CR-015 的 `ev:'meter'`**，30Hz 走独立订阅 + ref 直接改 DOM） |
| `audio/FrequencyPanel.tsx` + `frequencyResponse.ts` | 292 + — | EQ 频响图与十段控制；**音效页同时有中侧增益（`midGainDb`）与交叉馈送（预设 + 开关）**，走 `channelCommandQueue.ts` 合并式命令队列 |
| `c2/encodePath.ts` + `C2PathView.tsx` | 136 + 189 | 信号路径六段编码与渲染；**DSP 段用波浪线、监测不占段** |
| `components/recordScene.ts` | 380 | three.js 黑胶；rAF 只在「播放中或未收敛」时续，`IntersectionObserver` + `visibilitychange` 双门控，`ceil(DPR)` 封顶 2 |
| `styles/tokens.css` | 155 | **唯一允许字面色值的文件**；`--row-height` / `--playbar-height` 等被 JS 读取 |

### 共享（`src/shared/`）

| 文件 | 行 | 职责 |
|---|---|---|
| `protocol.ts` | 254 | CONTRACT §3/§4.3 的 TS 形状 + 引擎实测附加字段（含 CR-015 的 meter 事件） |
| `redact.ts` | — | **日志脱敏**（MASTER-B-app §A1）：cookie 名 / 鉴权头 / URL 签名参数 / Bearer |
| `library.ts` | — | `libraryPathKey()` 归一与 `isUnderRoot()`（**带分隔符边界**，`D:\Music2` 不算 `D:\Music` 之下） |
| `lrc.ts` | 175 | LRC → §4.3；增强标签与 KRC 都解析；**段内空格原样保留**（见 §6） |
| `ttml.ts` | 432 | **AMLL TTML** → §4.3：逐字 `<span>`、行内翻译/罗马音、背景人声并进同一行、**ruby 注音（`word.ruby`）**、`<iTunesMetadata>` 按 `itunes:key` 回填；自带无依赖 XML 扫描器，畸形输入返回 null |
| `yrc.ts` | 74 | 网易云 YRC（`[行起点,行时长](字偏移,字时长,0)字`）→ §4.3 |
| `netease-lyrics.ts` | 122 | 网易云三轨（`lrc`/`tlyric`/`romalrc`）按**时间戳**配对（±400 ms）；剥头部的作词/作曲名单；识别「暂无歌词 / 纯音乐，请欣赏」占位符 |
| `lyrics-parse.ts` | 46 | 一个入口按**内容**判格式再分发（多解析器 → 一个中间态，不在 `lrc.ts` 里堆 if） |
| `netease-weapi.ts` | 96 | **weapi 参数加密**（两次 AES-128-CBC + 教科书式 RSA，只用 node:crypto/BigInt）—— 明文接口永远不给 `yrc`，只有加密接口给；会被限流，故 best-effort + 熔断 |
| `embedded-lyrics.ts` | 84 | **内嵌歌词**：`music-metadata` 读 `LYRICS/USLT/SYLT`，只收带时间轴的（实测 0/91 有） |
| `lyrics-quality.ts` | 62 | **时间轴自洽校验**：歌词末尾超出曲长 75 s 丢弃、30 s 记风险、覆盖 <45% 记风险（阈值由 8 首真实曲目量得） |
| `ttml-write.ts` | 96 | Lyrics → AMLL TTML 文本，可被 `parseTtml` 原样读回（含注音/翻译/罗马音/背景人声） |
| `lyrics-interpolate.ts` | 96 | **行级歌词的填充插值**：CJK 按字素、拉丁按词、按可演唱字符加权；只生成渲染视图，`wordByWord` 与缓存保持源样 |
| `track-identity.ts` | 76 | 曲目身份：有标签用标签，没标签按第一个「空格-空格」切「艺人 / 曲名」；另有仅供匹配的 `matchKey`/`artistTokens`（不改写展示文本） |

## 4. 验证证据

> **验证状态**：下表**全部**在**当前固定副本** `twilight-qa-2026-10-16.exe`（`3fb18a4d…`）上复验过，时间为 2026-10-16 13:0x（本地）。
>
> ⚠️ 复验过程里 `test:library` 失败过一次，**单独重跑即通过（17/17）** —— 那是三个套件连跑时抢音频端点导致的，
> 不是回归。**这条经验请记住：窗口套件串跑容易互相踩端点，失败先单独重跑再判断。**

| 检查 | 最近一次结果 | 证据文件 |
|---|---|---|
| `pnpm lint` | **0 令牌违规**（typecheck + 设计令牌） | 控制台 |
| `pnpm test:app` | ★ **74 通过 / 0 失败**（16 个文件） | 控制台 |
| `pnpm test:c2` | ★ **11 通过** | 控制台 |
| `pnpm test:protocol` | ★ **42 项全过** | 控制台 |
| `pnpm test:integration` | ★ **19 项全过**（真引擎） | 控制台 |
| `pnpm test:electron` | ★ **53 项 / 0 失败** | `.smoke/qa/result.json`、`electron.log` |
| `pnpm test:player` | ★ **64 项全过** | `.smoke/player/result.json` |
| `pnpm test:library` | ★ **17 项全过**（单独跑；串跑易被端点争用打断） | `.smoke/library/profile/` 的配置与多次启动记录 |

### 性能实测（2000 首伪造曲库，同一脚本前后对比）

| 指标 | 虚拟化前 | 虚拟化后 | 计划要求 |
|---|---|---|---|
| DOM 节点 | 30,183 | **370** | < 2,000 ✓ |
| 渲染行 | 2,000 | 12 | — |
| 渲染进程工作集 | 331MB | **214MB** | — |
| 切到曲库 | 936ms | **14ms 画出首行**（新视图 9ms 进 DOM） | < 200ms ✓ |
| 静止 CPU（首页 / 曲库顶部 / 深滚后） | — | 0.02% / 0.18% / 0.09% | — |

度量脚本（scratch，未进版本库）：

- `.smoke/measure-scale.mjs <N>`：注入 N 首伪造曲目，量切页时间 / DOM / 工作集 / 静止 CPU。**不需要声卡**。
- `.smoke/probe-layout.mjs`：量两种尺寸下歌词列与监测带的几何（虚拟化与舞台高度改动的门禁）。
- `.smoke/probe-navcost.mjs`：切页时间的构成（状态提交 / 挂载 / 绘制 + 静止 CPU）。
- `.smoke/probe-hidden-view.mjs`：**确定性复现**「窗口被遮挡 → 视图切换卡住 → 恢复可见自愈」。
- `.smoke/probe-worstcase-rows.mjs`：最坏命名（超长/emoji/组合字符）下的截断、换行、聚焦环、远处行。
- `.smoke/measure-lyrics.mjs`、`.smoke/verify-mp3.mjs`：歌词渲染代价 / 引擎 MP3 链路验证。

### 当前截图（看图入口）

- `.smoke/player/music-space-1280.png`、`music-space-900.png`：首页（唱片 + 信息列 + 歌词 + 监测带 + 播放栏）
- `.smoke/player/immersive-1280.png`、`immersive-900.png`：沉浸播放（逐字填充停在字中间）
- `.smoke/player/frequency-response-1280.png`：音效页 EQ 频响
- `.smoke/player/custom-cover-1280.png`、`cover-removed-1280.png`：自定义封面与撤销（印有 ARTWORK TEST 的验收素材）
- `.smoke/player/artist-waterfall-1280.png`、`playback-details-900.png`：艺术家瀑布 / 参数台
- `.smoke/library-directories-1280.png`：曲库目录面板
- `.smoke/scale-2000.png`、`scale-91.png`：虚拟化前后的曲库（2000 首）
- `.smoke/crop-playbar.png`、`crop-copy.png`：播放栏与信息列的局部特写

## 5. 已知缺口与下一步

### 5.1 引擎侧与协议状态

| 项 | 状态 |
|---|---|
| CR-015 `ev:'meter'`（实时电平 + 频谱） | 已实现固定窗采样、48 段对数频谱、逐声道 RMS/峰值/峰值保持/真峰值、Momentary LUFS、限幅衰减及波形 min/max 抽点；仅在收到帧后画曲线 |
| CR-015 可见性口径 | owner 已允许扩展 `set_meter {enabled:boolean}`。引擎默认不发帧；主进程同步窗口 show/hide/minimize/restore/closed，引擎重启后重发当前可见性；隐藏时不推 JSON、不转发 meter IPC，播放继续 |
| 应用侧对 CR-015 的频谱口径 | `spectrum` 按 **dB**、频段是 **20 Hz–20 kHz 等对数间距**，当前引擎按该口径发送 |
| 系统媒体键（CR-011 SMTC） | 已裁定「引擎只发事件、应用调既有命令」，引擎未实现 → 应用无事件可消费 |

### 5.2 应用侧未做（按作战地图）

| 编号 | 项 | 依赖 / 说明 |
|---|---|---|
| **A2** | 双后端凭据信封（`safeStorage` → AES-256-GCM，`scope` 参与派生） | ~147 行，平台前置；A1（脱敏）已完成 |
| **A3** | 曲库：身份 + 五级去重 + 补全（**~625 行，Apache-2.0 可整文件抄**） | 本机**没有参考仓库的 checkout**，需先解决源文件获取（GitHub CDN 被墙，用 gh-proxy 前缀） |
| **A4-2** | 模糊按面积分级 | 现状合规：视图层整屏 blur 已去掉；`backdrop-filter` 都属「小面积 + 背后静态」 |
| **A5** | 写 CR：能力四态进 `MusicProvider` | 纯文档 |
| **B1** | **回环媒体代理**（owner 已裁定走 b） | 可**先于引擎**开工、用本地文件自测；M3 最关键一环：`/media/<token>`、Range 转发（206/416 + `Accept-Ranges`）、Referer/UA、签名过期重签续传、token 退出即失效 |
| **C1-C4** | 网易云 / QQ provider | 依赖 B1 + A1 + A2；六个实操坑与「QQ 后端不能重启」等约束见 `MASTER-B-app.md` §C |
| **D3/D4** | 分词/字素切分跑 Worker、歌词缓存命名空间 | 当前没有分词阶段，无对象可缓存（字素级判断本身已满足：词切分按标签下标，不做码点切分） |
| **E2** | `sourceRevision`（剥掉 URL 签名做身份） | 平台阶段才有对象 |

### 5.3 明确不建议做的

- **全曲库缓存**：实测引擎启动 200ms、91 首全库扫描 **45ms**、`list_tracks` 15ms —— 缓存最多省几十毫秒，
  代价是第二份真相源与失效策略。（`engine/src/catalog.hpp` 自己也写着「91 首不值得提前付规模成本」。）

## 6. 踩过的坑（都带证据，别重复踩）

| # | 坑 | 现象 / 处置 |
|---|---|---|
| 1 | **`ELECTRON_RUN_AS_NODE=1` 是 DSH 宿主的环境变量** | 从这里启动 `electron.exe` 会被降格成纯 Node。**启动前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**；主进程 spawn 工具型子进程时反而应显式设它 |
| 2 | **音频端点被独占** | `ERR_DEVICE 0x8889000A`；等对方 30 分钟压测结束，别杀进程（§1①） |
| 3 | **窗口被遮挡 → 视图切换卡住** | Chromium 对隐藏/遮挡窗口停发帧，而视图切换当时用 `mode="wait"`（等退场动画判完成）。`.smoke/probe-hidden-view.mjs` 可确定性复现（hide → 点击 → 卡住 → show → 自愈）。已改交叠式，且测试宿主关掉后台节流 |
| 4 | **整屏 `filter: blur()`** | 它既是大面积逐帧模糊（红线 6），又是退出弹簧里最后收敛的一项：退出动画 306ms 视觉到位、554ms 才判完成 → 切页 630ms。去掉后 632 → 246ms，再改交叠式 → 14ms 出首行 |
| 5 | **CSS 同名规则被后加载文件整条覆盖** | `theme.css` 的 `.playbar` 列定义一直是被 `player.css` 覆盖的死代码（改了不生效）。规矩：**一个属性一个出处** |
| 6 | **`run()` 是 `executeJavaScript`** | 表达式求值成函数（如 `console.warn = …`）会报 `An object could not be cloned`，末尾加 `; undefined` |
| 7 | **改了源码没 build 就跑窗口测试** | 端到端断言会先在旧产物上失败（单元测试直接 import 源码，不暴露） |
| 8 | **LRC 段内 `.trim()` 吃掉空格** | 「增强LRC wordByWord」曾渲染成「增强LRCwordByWord」。现在有不变式：`words.join('') === line.text` |
| 9 | **`position` 实测约 9–10 Hz** | 事件驱动填充会一顿一顿；项目规矩是「可轻量补间但必须能被真实状态纠正」。补间不追平、不外插、迟到 >400ms 冻结、减少动态效果不补间 |
| 10 | **rAF 循环的启停条件写在 effect 里但依赖不全** | 漏 `playState` → 挂载时若是暂停，之后按播放永远起不来（要等换行撞上）。是「12 帧内 `--fill` 应出现 ≥5 个不同值」的断言抓出来的 |
| 11 | **测试里点 toggle 按钮** | 信号弹层是 toggle，测试前面已打开过时再点会把它关掉；应按 `aria-expanded` 判断后再点 |
| 12 | **并发写 `engine/`** | 开工前看 mtimes 与 `PROGRESS.md` 归属；本会话撞过一次并已回滚 |
| 13 | **固定引擎副本落后于应用消费的能力** | 症状：音效页控件"没反应"、`get_state` 里字段"不存在"，看起来像产品 bug，实际是副本太老（§2）。判据：直接发一条命令，**引擎会在 `ERR_STATE` 里列出它接受的字段名** |
| 14 | ⚠️ **`app/` 今天不止一个写者** | 2026-10-16 11:29–11:45（本地）有另一个会话批量改了 `FrequencyPanel.tsx`/`channelCommandQueue.ts`/`player.css`（三文件 mtime 同毫秒）与 `test-player-ui.mjs`，并相应更新了引擎。**接手时先看 mtimes**；本文件的数字取自当天最后一次全量复验 |

## 7. 一句话交接

> 应用侧**本地播放这条链已经完整且长期回归**（74 + 11 + 42 + 19 + 53 + 58 + 17 项检查、0 令牌违规，全部可复现）。
> 下一步的真缺口只有一个方向：**M3 平台接入** —— 先做 **B1 回环媒体代理**（本机就能自测），
> 它的前置 A1 已完成、A2 未做；`engine/` 那边由 AI-A 负责，你只需要在它落地 CR-015 时确认频谱面板亮起来。
> 所有结论都尽量留了**可复现的脚本或断言**，接手时先跑 §2 那串命令，再动手。

