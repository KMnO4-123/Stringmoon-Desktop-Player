# Twilight Echo · 应用侧当前移交

> ⚠️ **本文件是历史记录**：当前状态的移交见 [`HANDOFF-B-app-2026-10-16-current.md`](./HANDOFF-B-app-2026-10-16-current.md)。
> 这里保留的价值是**逐轮的决策与踩坑记录**（第十一轮止），新接手请以新文件为准。

更新时间：2026-10-15 19:4x（Asia/Shanghai）。项目根目录 `<仓库根>`，应用工作目录 `<仓库根>\app`。

> **2026-10-15 增补（第一轮）**：补上曲库目录记忆与自定义封面撤销，并修掉一个实测到的引擎侧
> 重复扫描缺陷（应用侧归一 + CR-013）。
>
> **2026-10-15 增补（第十一轮）**：继续按 `docs/MASTER-B-app.md` 推进 —— **A1 凭据脱敏**已落地并接到全部日志出口；
> **E1（generation 代次去重）经核实前提已过时**：应用侧早有等价机制（`ipc.ts` 的 `playbackRequestSequence` +
> store 里 `confirmIntent/failIntent` 的 trackId 匹配），缺的只是**没有测试盯着它**，已补确定性竞态测试。
> 两条更正与落地标注已写回 `MASTER-B-app.md`。
> 验收：lint 0 违规、应用 **71**、协议 42、C2 11、集成 19、Electron **53**、曲库 **17**、播放器 58。

> **2026-10-15 增补（第十轮）**：按 `docs/MASTER-B-app.md` 作战地图做 **A4-1 列表虚拟化**，并顺带打掉视图切换的固定开销。
> **虚拟化**：固定行高 + 槽位池化（key 用槽位不是曲目 id，窗口滑动时复用 DOM 实例）+ 高度撑开 + ARIA windowing
> （`aria-rowcount` / `aria-rowindex`）。行高读 CSS token `--row-height`（单一出处）。
> 2000 首实测：**DOM 30,183 → 370**（验收 §4.1-7 要求 <2,000 ✓）、渲染行 2000 → 12、工作集 **331MB → 214MB**。
> **切页**：先量出慢的那部分与曲库规模无关（91 首 670ms ≈ 2000 首 673ms），定位到 `mode="wait"` 等退场动画判完成，
> 而退场里最后收敛的是**整屏 `filter: blur()`**（红线 6 明令大面积模糊不要逐帧；主线程 longtask 为空）。
> 去掉 blur + 快速弹簧（`snap`）+ 交叠式过渡后：**新视图 9ms 进 DOM、14ms 画出首行**（原 246ms 才开始出现）。
> 验收：app 67 / 协议 42 / C2 11 / 集成 19 / Electron 51+1 / 曲库 17 / 播放器 58，lint 0 违规。

> **2026-10-15 增补（第九轮）**：歌词显示与动效的**两层拆分**。
> 引擎 position 实测约 **9–10 Hz**，而逐字填充原来就按这个频率跳（一个字 350ms 中间只落 2–3 格）；
> 现在：**React 只画结构**（只订阅「活性行下标」，同一行内的事件不唤醒它），**填充由画笔按显示刷新率驱动**
> （`lyricPlayhead` 补间 + ref 直接改 `--fill`/类名）。补间遵守项目自己的规矩：新事件**直接对齐**不做平滑追赶、
> **数字不外插**、事件迟到 >400ms **冻结**、**减少动态效果时不跑补间**（只按事件落格）。
> 新增断言：补间的线性推进/冻结/对齐（单元）+「12 帧内填充出现 ≥5 个不同值」＝按帧重画而非按事件跳格（Electron）。
> 全部检查：lint 0 违规、应用 67、协议 42、C2 11、集成 19、Electron 51、曲库 16、播放器 58。

> **2026-10-15 增补（第八轮）**：播放栏横向配比与唱片右侧信息列。
> **播放栏**：三块不再均分（`theme.css` 里那份列定义一直是被 `player.css` 覆盖的死代码 —— 已删，
> 配比归到 `player.css` 单一出处），改成 `0.87 / 1.6 / 1.14fr`：左块只要缩略图 + 曲名，
> 右块要塞信号/音量/沉浸三控件。音量滑条 **66 → 98px**（原来 0–100% 挤在 66px 里没法精调），
> 读数带单位（`42%`，静音时仍显示用户选的档位）。
> **信息列**：艺术家与技术参数**合成一行**（左靠左可省略、右靠右不压缩）—— 原来是两行各自稀疏的短文本、
> 右边一大片留白。合并后既补上此前只在「播放详情」弹层里能看到的**专辑与年份**，又不新增行：
> 信息块 177.5 → **153px**，歌词列 185.3 → **209.7px**。
> ⚠️ 曲库实情（引擎实测）：**91 首里只有 1 首带标签**，其余 artist 为空、title 是文件名；`displayTrack`
> 按「Artist - Title」惯例拆分显示，所以专辑/年份在这份曲库上大多**如实为空** —— 不是没做，是没有。
> 全部检查：lint 0 违规、应用 65、协议 42、C2 11、集成 19、Electron 50、曲库 16、播放器 58。

> **2026-10-15 增补（第七轮）**：频谱面板落地 + 首页布局重排 + 播放栏压缩。
> **布局**：首页底部成了一条监测带 —— 左列「EQ 频响」、右列「频谱」，**底边对齐**（列内多余留白落到图的上方）；
> 舞台 480→**540px**，频谱绘图区与 EQ 紧凑图同为 88px。高度是两条既有质量线倒推的，不是拍出来的：
> 歌词列在 1280 下 **185.3px**（≥160）、在 900×600 下 **134.4px**（≥120，频谱此时收成读数条）。
> **播放栏 92→76px**（正是 DESIGN v3/v5 原本写的 72–84px 区间），高度收进令牌 `--playbar-height`，
> 外壳网格行与 `.playbar` 共用它。
> 顺手修掉测试不稳的根因：被遮挡的窗口 Chromium 会停发帧，而 `AnimatePresence mode="wait"` 的新视图
> 要等旧视图退场动画播完才挂载 → 脚本点导航会「状态变了、页面不动」。测试侧关掉后台节流修掉
> （产品行为不变，真实用户点不到被遮挡的窗口）。
> 全部检查：lint 0 违规、应用 65、协议 42、C2 11、集成 19、Electron 50、曲库 16、播放器 58。

> **2026-10-15 增补（第六轮）**：首页加了**实时频谱/电平监测**（EQ 频响图右侧、歌词下面那块区域），
> 与 EQ 图同一套画布语法（对数频轴 + dB 纵轴 + 线/面），数据源是 **CR-015 的 `ev:'meter'`**。
> owner 已裁定**接受 CR-015 原文六条口径**（裁定已写进 `docs/contract-requests.md`），引擎侧 FFT 尚未落地，
> 所以面板**如实显示「等待引擎推送」而不是画假曲线**；数据一到就亮。
> 应用侧还有两处口径假设写进了 `meterStore.ts` 并在该 CR 下请引擎确认：spectrum 按 **dB**、频段是
> **20 Hz–20 kHz 等对数间距**。
> 全部检查：lint 0 违规、应用 65、协议 42、C2 11、集成 19、Electron 48、曲库 16、播放器 58。

> **2026-10-15 增补（第五轮）**：播放栏加了三个控件 —— **循环模式四态**（含随机）、**原生静音**、**输出模式偏好**。
> 三样引擎早已支持（`state` 里就带 `repeatMode`/`muted`，注释写明「客户端只记住自己发过什么是错的」），应用侧此前完全没用；
> 静音原来是「把音量设 0」冒充的，现在走 `set_muted`，音量不再被改写。
> 顺带查清并修掉一个**测试环境构造问题**：视图切换由 `AnimatePresence mode="wait"` 编排，
> 新视图要等旧视图退场动画播完才挂载，而动画靠帧 —— 测试窗口被遮挡时 Chromium 停发帧，
> 于是「点了导航状态变了、页面不动」，恢复可见后自愈（已用隐藏窗口确定性复现并记录）。
> 全部检查：lint 0 违规、应用 60、协议 42、C2 11、集成 19、Electron 36、曲库 16、播放器 41。

> **2026-10-15 增补（第四轮）**：按「完善界面 / 优化动效 / 优化负载」做了一轮**先测量再动手**的工作。
> 结论：主线程与 GPU 本来就很轻（静止 **0.01%** CPU；播放 ~1.3%，其中 GPU 0.9%；20Hz 位置事件 +
> 2800 个歌词 span 也只要 ~0.3%）；真正有量级问题的是**曲库规模**。已改并复测：
> 2000 首时切到曲库 **1224ms → 936ms**、渲染进程工作集 **509MB → 331MB**。
> 全量检查：lint 0 违规、应用 58、C2 11、协议 31、集成 19、Electron 36、曲库 16、播放器 41。
> 见 §3「长列表」与 §4。

> **2026-10-15 增补（第三轮）**：歌词逐字填充（REFS-B2 §2.6 的「按已测量字形宽度插值」）已实现，
> 并修掉一个实测到的真 bug —— 词级歌词把作者写的空格吃掉了（"增强LRC wordByWord" 渲染成
> "增强LRCwordByWord"）。另交接了引擎侧 MP3 打不开的根因（`docs/REPORT-B-mp3-no-xing-2026-10-15.md`）。
> 全部检查：lint 0 违规、应用 **58**、C2 11、协议 31、集成 19、Electron **36**、曲库 16、播放器 41。
>
> **2026-10-15 增补（第二轮）**：把「曲库目录」从**单个**改成**一组**并支持移除 ——
> 上一轮只记住最后一个目录，而引擎的 `scan` 只增不换，导致「会话内是累加、重启后只剩最后一个」，
> 一次探索性的添加就会把原来的曲库顶掉。现在：一组目录、启动全扫、可逐个移除、移除不必重扫盘。
> 全部检查在真机重跑：lint 0 违规、应用 **56**、C2 11、协议 31、集成 19、Electron 33、
> 播放器 41、曲库 **16**；引擎 SHA-256 未变。详见 §3、§4 与 §6。

这是当前应用状态的移交记录，不是新的开发需求。本轮用户要求整理移交；此前封面、切歌动效、主题色、布局与播放参数台已实现并验证。本次整理重新读取了代码与测试结果文件，没有重新执行整套测试。

## 1. 接手先看这里

- 应用是 Electron + React + TypeScript + Zustand；独立 C++ 引擎通过 JSON Lines over stdio 播放音频。界面采用 Nothing 的黑色底与状态编码，叠加用户明确要求的 Apple 风格液态玻璃、景深、3D、视差、弹性与瀑布布局。
- 当前默认首页为「音乐空间」：左侧歌曲封面与 3D 黑胶叠层，下面是 88px 短 EQ 曲线；右侧曲目信息和独立滚动歌词。另有曲库、沉浸播放、音效页。
- 封面可自动读取或手动选择；切歌时封面/唱片成组进出场；主题色可随封面变化并关闭。播放栏可展开信号路径和详细参数，提供音量读数、静音/恢复和真实上下首。
- 上一轮结果：类型/令牌/build 通过，应用测试 **45**，C2 **11**，模拟协议 **31**，真引擎 **19**，Electron 回归 **33**，Playwright 播放器检查 **35**，全部通过。
- 当前结果（可复现）：应用 **58**、C2 **11**、协议 **31**、真引擎 **19**、Electron **36**、播放器 **41**、曲库目录 **16**，全部通过；引擎 SHA-256 仍为 `fcec9698…4d28`。
- 当前目录没有 `.git`，没有本轮提交或推送。实现直接保存在工作目录，`app/out/` 已构建。
- 本轮应用工作未修改 `engine/`、`CONTRACT.md`、SPEC 或 CR 裁定。引擎由其他工作推进，读接口时以当前代码和已接受的 CR 为证据。

**历史文档注意：** `docs/HANDOFF-B-app.md` 与 `docs/REFS-B2-app.md` 是早期参考。旧的「只做列表」「无封面」「固定强调色」「无 3D」不能覆盖用户后续明确提出的界面要求；音频协议边界、真实数据与状态语义仍须保持。当前情况以本文件、实际代码和用户后续要求为准。

## 2. 环境与复现

PowerShell；Node 24、pnpm 11。本机包版本以 `app/package.json` 和锁文件为准。主要新增依赖为 `three`、`motion`、`music-metadata`，实际窗口测试用 `playwright-core`。

正常启动：

```powershell
Set-Location -LiteralPath '<仓库根>\app'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm dev
```

默认引擎：`<仓库根>\engine\bin\twilight-engine.exe`；不存在时应用回退到 mock。**曲库目录是一组、并已持久化**：用户加进来的目录都记在 `userData/library.json`（`{directories, configured}`），下次启动按顺序全部扫描，所以「这次看到的曲库 = 下次拿到的曲库」。从未管理过目录时回退到内置默认目录 `<测试曲库>`（`src/main/library-config.ts` 的 `DEFAULT_DIRECTORY`，已从 `App.tsx` 移到主进程），它在用户第一次增删时被固化进列表。曲库视图顶部有「N 个曲库目录」面板：看每个目录、标出不可用的、逐个移除（只影响曲库，不删文件）。某个目录不见了只提示不可用并继续扫可用的那些。
旧配置形状 `{directory}` 会自动迁移到 `{directories}`，不丢用户已选的那份。

完整检查：

```powershell
Set-Location -LiteralPath '<仓库根>\app'
pnpm lint
pnpm test:app
pnpm test:c2
pnpm test:protocol
pnpm build
$env:TWILIGHT_ENGINE = '<仓库根>\app\.smoke\qa-runtime\twilight-cover-qa.exe'
pnpm test:integration
pnpm test:electron
pnpm test:player
Remove-Item Env:TWILIGHT_ENGINE -ErrorAction SilentlyContinue
```

`test:electron`、`test:player` 消费构建后的 `out/`，源码变更后先 build。`test:integration` 会短暂真实出声；播放器 UI 测试播放时音量为零，静音恢复检查在暂停状态运行。两组窗口测试宜顺序执行，减少焦点和帧调度干扰。

最终验证引擎副本：

```text
<仓库根>\app\.smoke\qa-runtime\twilight-cover-qa.exe
SHA-256: fcec9698da4416fb763458cd5a014ac25e395a971848c252cdbd4e322eac4d28
```

**2026-10-15 追加：引擎侧更新后的复验。** AI-A 在 12:30 重建了 `engine/bin/twilight-engine.exe`
（加 MP3 解码，动了 `player.cpp`/`player.hpp` —— 正是应用消费 `state` 事件的地方），
新哈希 `3a43a558972733f57d55fdf3063137a1d45aac0a702d4beb4f37a806f18b35e5`（1,491,968 B）。
应用侧对着这个新引擎复跑：单元全过、集成 **19**、Electron **33**、曲库 **16**、播放器 **41**，（逐字填充追加 3 条断言后，Electron 对同一新引擎再跑为 **36/36**）
跑期间二进制哈希未变 —— 引擎这次改动**没有**影响应用的协议/状态消费。
该副本来自 2026-10-15 18:04:29 的默认引擎，大小 1,452,544 bytes。

（另存了一份 `.smoke/qa-runtime/twilight-mp3-1231.exe` 作为本次固定副本，避免并行重建打断验证。）
应用侧对 MP3 的可见行为：交接时是「曲库能列出、时长正确，但 `open` 会失败」（引擎侧缺陷，见
`docs/REPORT-B-mp3-no-xing-2026-10-15.md`）。**同日 12:35 的构建已修好**，我在 `e963a166…` 上独立复验：
5 个真实 CBR MP3 `open` ok、`durationMs 257645`（TagLib 257646，差 1 ms）、播放位置推进、seek 到 60 s 与曲末均成功、
`sourceExact=false`（有损不冒充）、`bitDepth 16`。应用侧对此**无需任何改动** —— 引擎一修好就自然能放。
应用对着 `e963a166…` 复跑：集成 **19**、Electron **36/36**（副本 `.smoke/qa-runtime/twilight-mp3-fixed.exe`）。旧 `twilight-app-qa.exe` 是更早版本，不能和本次结果混用。若默认引擎更新，先对比哈希再解释测试结果；不要覆盖其他工作的引擎产物。

## 3. 当前功能与代码入口

以下路径均相对 `<仓库根>\app`。

| 区域 | 入口 | 接手要点 |
|---|---|---|
| 页面与主题开关 | `src/renderer/src/App.tsx` | 四个视图；当前曲目封面与主题状态；本地选图入口；启动/重连握手 |
| 音乐空间 | `src/renderer/src/components/MusicSpace.tsx` | 唱片右侧信息列：状态点 → 标题 → 艺术家 · 专辑（同一行）→ 年份/采样率/位深/编码/码率 → 播放与沉浸按钮 → 歌词 → 频谱 | 封面/短 EQ 左列、歌词右列；艺术家陈列与歌曲速览 |
| 封面/唱片切换 | `src/renderer/src/components/CoverRecord.tsx` | 曲目键驱动 Motion 进出场；旧场景退出后释放；减少动态效果时降级 |
| 3D 唱片 | `src/renderer/src/components/RecordStage.tsx`、`recordScene.ts` | 实体沟槽、标签纹理、光照、播放旋转与指针弹簧；完整资源清理 |
| 封面读取与保存 | `src/main/artwork.ts` | 自定义图 → 嵌入图 → 同名图 → cover/folder/front；真实解码与有界缓存；`removeArtwork` 只删映射、不删用户图片 |
| 曲库目录集合 | `src/main/library-config.ts`、`src/shared/library.ts` | `userData/library.json` = `{directories, configured}`；只接受存在的绝对目录；读回时报告哪些不可用；旧 `{directory}` 自动迁移；`libraryPathKey`/`isUnderRoot` 负责身份归一与目录归属 |
| 日志脱敏 | `src/shared/redact.ts` + `engine-host.ts` / `main/index.ts` / `store.ts` | 黑名单式遮蔽，接到全部日志出口（引擎 stderr 原样打印是最大泄漏面）；断言「秘密子串不得出现在输出里」+ 无凭据行逐字节原样通过 |
| 长列表虚拟化 | `LibraryList.tsx`、`theme.css` `.track-list/.track-window` | 只渲染可见窗口（10 行 + overscan 4）；**key 用槽位**做池化复用；`aria-rowcount`/`aria-rowindex` 交代总数与位置；键盘导航跨窗口先滚后聚焦；行高读 `--row-height` 单一出处 |
| 视图切换 | `App.tsx`、`motionPresets.ts` 的 `snap` | 只动 opacity/y、**无整屏 blur**（红线 6）、交叠式过渡：新视图 9ms 进 DOM、14ms 画出首行 |
| 长列表规模（旧） | `LibraryList.tsx`、`theme.css` `.track-row` | 行不用虚拟列表，但开 `content-visibility: auto` + `contain-intrinsic-size: auto var(--row-height)`（屏幕外行不参与布局/绘制，DOM 仍在）；行入场是 **CSS** 而非每行一个 Motion 实例 |
| 曲库归一边界 | `src/renderer/src/store.ts` `setTracks`/`setLibraryDirectories`/`visibleTracks` | 可见集 = 引擎全量条目 ∩ 当前目录，再按归一 path 去重；移除目录不必重扫盘；`roots=null`（未解析）时不过滤 |
| 正在播放的解析 | `src/renderer/src/store.ts` `selectLoadedTrack` | 从**引擎全量列表**取，不从可见集取：移除正在播放那首歌的目录后，曲库列表少掉它、播放栏仍报它自己的名字 |
| 曲库目录面板 | `src/renderer/src/components/LibraryList.tsx`、`theme.css` `.library-dirs` | 原生 `<details>`；列出目录 + 不可用标记 + 逐个移除 + 添加入口 |
| 封面 IPC | `src/shared/artwork.ts`、`src/main/index.ts`、`src/preload/index.ts` / `index.d.ts` | 独立应用 IPC，未扩展引擎音频协议 |
| 前端封面与取色 | `src/renderer/src/artwork.ts` | 按路径隔离异步回复；24×24 像素取色；无图时稳定曲目配色 |
| 播放栏 | `src/renderer/src/components/Playbar.tsx` | **高 76px**（令牌 `--playbar-height`，外壳网格行共用）；**横向配比只在 `player.css` 定义**（`0.87/1.6/1.14fr`），音量滑条 ~98px，读数带 `%` | 进度/音量/静音/上下首；**循环模式四态**、**原生静音**、**输出模式偏好**；信号与详情弹层；点外部或 Esc 关闭 |
| 首页监测带 | `MusicSpace.tsx`、`player.css` `.listening-media/.listening-stage` | EQ 图与频谱**底边对齐**（`.listening-media` 纵向 flex + EQ 图 `margin-top:auto`，矮窗口无余量时 auto 自动为 0）；舞台 540px、频谱绘图区 88px 由两条歌词质量线倒推；改数字前跑 `.smoke/probe-layout.mjs` |
| 实时频谱 | `src/renderer/src/audio/SpectrumPanel.tsx`、`meterStore.ts` | 与 EQ 图同一套坐标语法；30 Hz 数据**不进 React**（ref 直接改 path 的 d），走独立订阅仓；没数据不画曲线；纵轴固定；换曲/断连清空；mono 不复制通道 |
| 播放栏扩展控件 | `Playbar.tsx` + `store.ts`（`repeatMode`/`muted`/`outputPreference`） | 三个离散控件都是「乐观设置 + 失败回滚」；权威值一律来自 `state`；旧引擎不发 `repeatMode`/`muted` 时**保持当前值**；静音不改音量（拖动音量才显式取消静音）；输出模式把**请求**与**实际**分开展示 |
| 参数台 | `src/renderer/src/components/PlaybackDetails.tsx` | 音源与当前输出分别展示；进度局部订阅，不做本地时间外插 |
| EQ 图与操作台 | `src/renderer/src/audio/FrequencyPanel.tsx`、`frequencyResponse.ts` | 十段、预设、Q、前级、余量；确认后的频响与有限历史轨迹 |
| EQ 请求状态 | `src/renderer/src/audio/eqCommandQueue.ts`、`eqCommands.ts`、`dspState.ts` | 串行合并、草稿与确认值分离、旧引擎回复失效 |
| 播放状态与命令 | `src/renderer/src/store.ts`、`ipc.ts`、`positionStore.ts` | intent/权威状态；队列同步；旧打开请求防护；高频进度独立 |
| 歌词 | `src/renderer/src/components/LyricsView.tsx`、`src/main/lyrics.ts` | 原生逐字/行级区分、翻译和罗马音分行、隐藏停止订阅 |
| 歌词动效分层 | `LyricsView.tsx`、`lyricPlayhead.ts`、`lyricFill.ts` 的 `activeLineIndex` | React 只管结构（快照是**下标**，同行情内不重渲染）；填充由画笔按 rAF 驱动、事件到达即对齐；减少动态效果不补间 |
| 逐字填充 | `src/renderer/src/lyricFill.ts`、`src/shared/lrc.ts`、`theme.css` `.lyric-word` | 按字形宽度插值的连续填充（`--fill` + `background-clip: text`）；词切分按标签下标、不做 code point 切分；**空格属于排版**，`words.join('')` 必须逐字等于 `line.text` |
| 曲库 | `src/renderer/src/components/LibraryList.tsx`、`ArtistArtwork.tsx`、`libraryModel.ts` | 真元数据搜索、艺术家分组、瀑布与卡片弹性；单击选择、双击播放 |
| 视觉样式 | `src/renderer/src/styles/tokens.css`、`theme.css`、`player.css` | `player.css` 后加载；令牌违规基线为 0 |

### 封面与主题细节

- 当前参考库 **91 首均没有嵌入封面**，这经过元数据读取核对。默认展示明确标注「曲目视觉」的字形封面，不代表正式专辑封面。未接在线封面搜索。
- 悬停封面可点「添加封面/更换封面」。映射保存在 Electron `app.getPath('userData')/artwork.json`；保存的是音频绝对路径到图片绝对路径的映射，不复制图片、不修改音乐文件。移动或删除图片后会回退。
- 支持 JPG/PNG，8 MiB 字节上限、边长不超过 8192、总像素不超过 3200 万；Electron `nativeImage` 解码成功后最大缩到 1024px。当前解码器实测不支持 WebP，因此选择器与自动读取入口已移除 WebP。
- 两端各最多缓存六项，按请求检查 60 秒有效期；主进程同时校验音频大小/mtime。没有文件监视器，在外部替换图片时不会立即主动刷新当前已显示图片。
- 「随曲主题」偏好在 `localStorage['twilight.theme-follow']`。图片彩色像素估算色相；无可用颜色时采用稳定的路径配色。颜色变量在 `.app-shell` 定义，避免根节点提前计算后失去跟随。
- 主题作用于音乐背景、进度和 EQ；C1 严重级别与 C2 信号语义仍独立。液态玻璃是 Electron/CSS 实现，不是 Apple 原生 API。

### 频响、遥测和队列语义

- 当前曲线是 **稳态 EQ 传递响应，不是歌曲实时 FFT**。原生引擎没有提供实时频谱帧；`analysis.cpp` 是响度扫描，不是实时频谱接口。
- 频响使用浏览器原生离线 Biquad 响应，叠加引擎确认的静态增益；不创建发声的 Web Audio 播放链。历史线记录最近确认的参数变化，不是音频瀑布图。
- `state.bitDepth` 是**源位深**。输出精度读取可选 `containerBits` / `validBits`；缺失显示未知。设备 `periodMs` 表示调度周期，不等于总延迟。xrun 使用会话累计值。
- 详情展示文件格式/专辑/采样率/码率/大小/年份/风格，以及当前位置、设备、模式、输出采样率/声道、容器/有效位、DSP、增益、周期、欠载、音量。断连/ready 清除旧输出遥测。
- 手动播放在 `queueCapable === true` 时先 `set_queue` 再 `open` / `play`；引擎打开曲目后会定位队列索引。该步骤修复了原本上下首报空队列而被静默吞掉的问题。打开序列号防止较早选择晚到后再次发 play。
- 所有播放音频仍由 C++ 引擎负责。音频样本不经过 JSON，也不由前端伪造进度或频谱。

## 4. 验证证据与看图入口

| 检查 | 最后结果 | 证据或覆盖重点 |
|---|---|---|
| `pnpm lint` / `pnpm build` | 通过，令牌违规 0 | 主进程/渲染层类型；三产物构建 |
| `pnpm test:app` | 58 通过 | 状态、DSP、队列竞态、歌词（空格不变量、`wordFill` 单调/钳位/零长度）、原生图片解码、原生离线 EQ、3D 清理策略、曲库目录集合（迁移/移除/不可用）、可见集过滤、按归一 path 去重 |
| `pnpm test:c2` | 11 通过 | 信号路径编码；有既存 Node 模块类型警告，无失败 |
| `pnpm test:protocol` | 31 通过 | mock 命令/事件行为 |
| `pnpm test:integration` | 19 通过 | 真引擎播放/暂停/seek/扫描/关闭 |
| `pnpm test:electron` | 36 通过 | `app/.smoke/qa/result.json` 与 `electron.log`；含逐字填充的连续推进（`--fill` 采样）与像素证据（半填充时左半更亮） |
| `pnpm test:player` | 41 通过 | `app/.smoke/player/result.json`；实际 Playwright 操作、布局与画布像素；含自定义封面移除 |
| `pnpm test:library` | 16 通过 | `app/.smoke/library/profile/` 隔离配置；连续**六次**真实启动验证一致性契约：默认目录 → 加第二个目录 → 重启复现两个 → 移除 → 重启复现 → 移除到空 → 重启仍是空；含「正在播放的目录被移除后不许显示成别的歌」 |

**负载实测（Electron `app.getAppMetrics()` 整进程，含 GPU）**

| 场景 | 结论 |
|---|---|
| 静止（无曲目） | 总 CPU **0.01%**，Tab 工作集 ~152MB |
| 播放（首页） | 总 CPU **~1.3%**（GPU 0.9% / 渲染 0.4%） |
| 20Hz 位置事件 + 2800 个歌词 span | 总 CPU **~0.3~0.45%**，rAF 仍有 ~90fps |
| 曲库 2000 首（同一脚本，改前/改后） | 切到曲库 **1224ms → 936ms**；Tab 工作集 **509MB → 331MB**；DOM 30,183（未变） |

CSS 动效层审计：**没有任何 `linear` 缓动**（只有渐变里的 `linear-gradient`）；全部 `@keyframes` 只动 `opacity`；
唯一一个布局属性过渡是 C2 的 SVG 矩形，且只在 xrun/降级时触发。

压测与验证脚本（应用侧 scratch，未进版本库）：`.smoke/measure-scale.mjs <N>`（注入 N 首伪造曲目，量切到曲库的渲染时间 / DOM / 工作集 / 静止 CPU；`N=91` 与 `N=2000` 各跑一次即可复现上表）、`.smoke/measure-lyrics.mjs [--long]`（20Hz 位置事件下的歌词渲染代价）、`.smoke/probe-worstcase-rows.mjs`（最坏命名的截断 / 换行 / 聚焦环 / 远处行）。三个都**不需要音频端点**（用 IPC 桩注入数据）。

**⚠️ 窗口测试还需要「窗口真的看得见」。** 视图切换由 `AnimatePresence mode="wait"` 编排：
新视图要等旧视图的**退场动画播完**才挂载，而动画靠帧；窗口被遮挡/隐藏时 Chromium 停发帧，
于是脚本点导航会「React 状态变了、DOM 还是旧页面」，直到窗口恢复可见才自愈。
`.smoke/probe-hidden-view.mjs` 可确定性复现（`BrowserWindow.hide()` → 点导航 → 卡住 → `show()` → 自愈）。
判断：**真实用户看不到、也点不到一个被遮挡的窗口**，所以这不是用户会遇到的画面，而是测试环境的构造问题 ——
`test-electron.cjs` 因此在开头显式 `win.show()` + `win.focus()`。
（若将来想让导航彻底不依赖帧，可去掉 `mode="wait"`，代价是入场/离场从「先后」变成「交叠」，那是动效设计决定。）

**⚠️ 窗口测试需要音频端点：** 引擎侧（AI-A）在同一个仓库并行工作，若它正以**独占**模式占着端点，
应用的共享模式开流会被拒（`ERR_DEVICE` / `0x8889000A`），表现为 `test:integration`/`test:electron`/`test:player`
中途失败 —— **那是端点争用，不是回归**。判定：`Get-Process -Name 'twilight-engine*'` 有空就等，别改代码。

优先查看当前截图，而不是早期 `.smoke/design/`：

- `app/.smoke/player/music-space-1280.png`、`music-space-900.png`：当前正常曲库、字形封面、独立歌词与短 EQ。
- `app/.smoke/player/immersive-1280.png`、`immersive-900.png`：沉浸播放；当前行的逐字填充停在字中间（填充边界 = 已唱到的位置），空格保留（「夜色沉入水底 光在层与层之间呼吸」）。
- `app/.smoke/player/frequency-response-1280.png`：真实 EQ 调节台。
- `app/.smoke/player/playback-details-900.png`：源/输出参数台与窄窗边界。
- `app/.smoke/player/custom-cover-1280.png`：本地选图与提取主题色，**封面印有 ARTWORK TEST，是验收素材**。
- `app/.smoke/player/cover-removed-1280.png`：撤销自定义封面后回到字形封面，且「移除封面」入口随之消失。
- `app/.smoke/library-directories-1280.png`：曲库目录面板（两个目录、各自移除入口、添加入口）。
- `app/.smoke/player/artist-waterfall-1280.png`：艺术家瀑布。

`tools/player-test-app.cjs` 用独立 `.smoke/player/profile/` 运行真实构建，选图只替换系统对话框的返回路径，其余 IPC/解码/配置保存都走产品代码。不会把测试封面写进正常用户配置。`test-electron.cjs` 的歌词边界使用特定双字幕 fixture，和正常截图的歌词来源不同。

Windows 当前缩放为 175%，请求 900×600 内容尺寸时 Electron 实际返回约 901×601；测试保留亚像素容差并检查元素边界。不要用截图物理像素数直接当 CSS 尺寸。有限动画检查等待实际结束，不用固定 400ms 墙钟时间。

**⚠️ 跑测试前先确认没有并发的引擎进程。** 引擎侧（AI-A）在同一个仓库里并行工作，而应用测试会真的开音频流：
若对方此刻以**独占**模式占着端点，应用的共享模式开流会被拒，报
`ERR_DEVICE: shared-mode stream refused (0x8889000A)`（= `AUDCLNT_E_DEVICE_IN_USE`），
表现为 `test:electron`/`test:player` 中途失败 —— **那是端点争用，不是回归**。
本轮真实发生过一次：`Get-Process twilight-engine` 看到 PID 21460 正在跑，等它退出后重跑即 36/36。
判定方法：`Get-Process -Name 'twilight-engine*'` 有空就等，别急着改代码。

自动化检查覆盖布局/状态/实际交互和像素变化，不等于用户已确认全部审美、听感或动效手感。

## 5. 接手后的检查顺序

1. 根据用户新要求定位上述入口；当前没有待执行的补丁或测试会话。若用户仅说继续，先打开现有界面并阅读本文件的边界，避免重复实现。
   启动路径现在先读 `userData/library.json`：改曲库相关行为时先看 `App.tsx` 的 `bootstrap`/`pickAndScan` 与 `library-config.ts`，别再把目录当成常量。
2. 先尝试项目 GraphFlow context。当前会话只暴露 `gf_*`，调用 `gf_read` 仅得到 `{ok:true}`，没有摘要、anchors；也没有可调用的 `graphflow_index`。本轮因此按已知路径定向阅读，**不能称图谱已更新**。下个会话若恢复完整工具，再做索引。
3. 修改相应源码、运行相关单元检查，build 后再做实际 Electron 交互验收。保留 reduced-motion、reduced-transparency、窗口隐藏/画布不可见时的降级与资源释放。
4. 涉及封面或参数的变化，优先回归 `tools/artwork.test.mjs`、`playback-details.test.mjs`、`playback-queue.test.mjs` 与 `test-player-ui.mjs`。检查生成图片和状态字段来源，不只看 DOM 是否存在。

本轮已完成（原列在未实现里）：**启动目录持久化**、**清除自定义封面的 UI**。

尚未实现的方向，只有在用户继续要求时再安排：实时 FFT 接口（协议未提供音频样本，属引擎侧）、在线平台/封面匹配、浅色主题、Punctum 字体、更复杂进度手势。

（**全曲库缓存**曾列在这里，本轮实测后不建议做：引擎启动 200 ms、91 首全库扫描 **45 ms**、`list_tracks` 15 ms ——
缓存最多省几十毫秒，代价是第二份真相源与失效策略。引擎自己的 `catalog.hpp` 也写着「91 首不值得提前付规模成本」。
只有曲库规模上去（数千首、多目录、网络盘）才值得重新评估。）

**本轮实测发现的引擎侧缺陷**（应用侧已归一，引擎仍需修）：`scan` 用「调用方给的目录字符串 + 文件名」当曲目身份，
同一目录换个写法（正斜杠 ↔ 反斜杠）会重新入库并拿到新 trackId —— 91 首变 182 首，
对话框返回反斜杠而默认常量是正斜杠，首次选同一个目录即触发。已提 **CR-013**（`docs/contract-requests.md`），
应用侧按归一 path 去重并在同一会话内跳过重扫。修好后这两处都是恒等变换，不需要撤。

**同一 CR 追加的第二项请求**：引擎**没有清空/替换 catalog 的命令**，所以用户在应用里移除一个曲库目录后，
引擎仍然持有那批条目（`list_tracks` 会把它们一并返回）。应用只能自己过滤（曲库列表 + `set_queue` 都用可见集），
行为正确但**状态不干净**：任何直接信 `list_tracks` 的消费方都会看到不该存在的曲目。已在 CR-013 请求补一条
`scan` 的 `replace: true` 或 `clear_library`。拿到之前，这层过滤是必需的。

历史决策与更完整记录：

- `<仓库根>\docs\APP-B-implementation-2026-10-15.md`
- `<仓库根>\docs\superpowers\plans\2026-10-15-cover-console.md`
- `<仓库根>\docs\superpowers\plans\2026-10-15-music-space.md`
- `<仓库根>\app\README.md`
- 涉及引擎扩展时查 `<仓库根>\docs\contract-requests.md`，不要把参考文档中的建议误当成已接受的协议。

## 6. 可复制到新会话的入口

> 项目在 <仓库根>，应用在 <仓库根>\app。请先阅读 <仓库根>\docs\HANDOFF-B-app-2026-10-15-current.md，按我的后续要求继续。该文件是当前状态移交，不是新任务；旧 HANDOFF/REFS 的 UI 描述有历史内容。保留已完成的封面（含撤销）、3D 唱片切换、主题色、短 EQ/歌词布局、参数台和曲库目录记忆，播放状态以原生引擎为准。
