# Stringmoon 应用侧移交（2026-10-16）

> 项目根目录：`<仓库根>`  
> 应用目录：`<仓库根>\app`  
> 本文件是当前状态交接，上一版 `HANDOFF-B-app-2026-10-16-current.md` 保留作历史参考。

## 0. 一句话状态

Stringmoon 的本地播放链、歌词、曲库、歌单持久化、音效页、沉浸播放、实时频谱和托盘功能已经落地；当前又完成了左侧歌单导航、设置页和网易云/QQ 音乐播放源适配器骨架。真实流媒体登录、凭据存储、媒体代理和平台播放接口仍未接入。

| 模块 | 状态 |
|---|---|
| 本地曲库、播放栏、歌词、封面、音效、沉浸播放 | ✅ 完成 |
| 本地歌单持久化、创建、重命名、删除、排序、播放 | ✅ 完成 |
| 侧边歌单导航 | ✅ 完成 |
| 设置页：播放、界面、曲库、账户 | ✅ 完成界面骨架 |
| **扫描文件夹自动添加（递归 + 入库预检）** | ✅ **已完成**（§8） |
| **无法播放的歌曲：自动标记 / 移出列表 / 查看与恢复** | ✅ **已完成**（§8） |
| 网易云音乐 / QQ 音乐适配器 | 🟡 统一类型与状态骨架完成 |
| **回环媒体代理** | ✅ **已接通并经 L2 端到端验收（21/21）** |
| **在线播放所有者（token 生命周期）** | ✅ **已完成**（`app/src/main/online-playback.ts`） |
| **引擎 `write EPIPE` 弹窗** | ✅ **已修复**（2026-10-16 晚，见 §7） |
| 网易云 / QQ 真实登录与播放控制 | ⛔ 未接入（provider 仍是 `planned`） |
| 凭据安全存储 | ⛔ 未接入 |
| 主界面频谱 | ✅ 对数频轴、真实点位、平滑连续曲线、细分网格 |
| 沉浸模式频谱 | ✅ 连续 SVG 曲线 + 面积光效，不再使用柱状频谱 |

## 1. 当前关键入口

### 应用壳与导航

- `app/src/renderer/src/App.tsx`
  - 当前视图：`home`、`library`、`immersive`、`sound`、`settings`
  - 左侧导航包含音乐空间、我的曲库、沉浸播放、音效、我的歌单、设置
  - 点击左侧歌单会打开曲库的歌单标签，并选中对应歌单
  - 视图切换继续使用 `AnimatePresence` 与现有 `snap` 动效

- `app/src/renderer/src/styles/theme.css`
  - 左侧歌单项、设置入口、设置页面、流媒体账户卡片和交互动画
  - 设计令牌要求仍然有效：组件 CSS 不写字面颜色，颜色只从 `tokens.css` 取

### 设置与流媒体骨架

- `app/src/renderer/src/components/SettingsPage.tsx`
  - 播放：沉浸频谱光效开关
  - 界面：歌曲主题色跟随开关、减少动态效果提示
  - 曲库：本地优先状态说明
  - 账户：网易云音乐、QQ 音乐状态卡片
  - 当前平台卡片明确显示“未登录 / 即将接入”，不会伪造登录成功

- `app/src/renderer/src/streaming/sourceAdapters.ts`
  - `StreamingProviderId`: `netease | qq`
  - `StreamingProviderDescriptor`: 平台名称、能力、状态
  - `StreamingSessionState`: `signed-out | signing-in | signed-in | expired`
  - `providerStateLabel()`：统一状态文案

当前适配器状态只描述契约，尚未调用第三方接口。不要在渲染层直接加入账号 token 或平台请求。

### 本地歌单

- `app/src/renderer/src/libraryDataStore.ts`
  - 读取和更新持久化歌单
- `app/src/main/playlists.ts`
  - 配置文件：`userData/playlists.json`
  - 支持创建、重命名、删除、添加歌曲、删除歌曲、排序
- `app/src/renderer/src/components/LibraryList.tsx`
  - 新增 `initialTab`、`playlistId`，支持由左侧导航直接打开指定歌单
- `app/src/renderer/src/components/PlaylistView.tsx`
  - 支持由外部传入初始歌单 ID

### 频谱与监听曲线

- `app/src/renderer/src/audio/meterStore.ts`
  - meter 数据仍独立于全局 Zustand store，避免 30Hz 推动整棵 React 树
- `app/src/renderer/src/audio/spectrumGlowModel.ts`
  - `smoothMeasuredPath()`：对真实点位做包络受限的三次贝塞尔连接
  - `spectrumCurvePath()`：把 dB 频段映射成沉浸底部曲线
  - `freshSpectrum()`：过期帧判断
- `app/src/renderer/src/audio/SpectrumPanel.tsx`
  - 主界面使用对数频率轴
  - 保留每个真实频段点
  - 使用平滑曲线、dB 细分网格和标准频率参考线
- `app/src/renderer/src/audio/SpectrumGlow.tsx`
  - 沉浸底部使用单条 SVG 连续曲线与渐隐面积
  - 不再生成 `.spectrum-glow-bar` 柱状元素
- `app/src/renderer/src/styles/player.css`
  - 主频谱曲线、细网格、读数条
- `app/src/renderer/src/styles/listening.css`
  - 沉浸模式底部连续曲线光效

## 2. 验证证据

窗口测试必须先执行 `pnpm build`。窗口测试应串行运行，避免多个真实引擎同时抢占音频端点。

最近验证结果（**2026-10-16 晚复核，含本轮改动**）：

- `pnpm lint`：通过，typecheck 与 token 检查通过（0 违规）
- `pnpm build`：通过
- `pnpm test:app`：**158 项通过**（本轮 +15：unplayable 8、库过滤 7）
- `pnpm test:c2`：11 项通过
- `pnpm test:protocol`：42 项通过
- `pnpm test:integration`（真引擎契约）：19 项通过
- `pnpm test:electron`：58 项通过，0 failures
- `pnpm test:player`：70 项通过
- `pnpm test:listening`：34 项检查通过
- `pnpm test:library`：27 项通过
- ⭐ `pnpm test:l2 <真实FLAC路径>`：**21/21 通过**（见 §7）
- ⭐ `node engine/tools/test-scan-recovery.mjs`：**13/13 通过**（见 §8）
- `tools/spectrum-glow.test.mjs`：5 项通过
- `tools/streaming-adapters.test.mjs`：1 项通过

测试结束后确认没有残留 `twilight-engine` 进程。Listening UI 测试最后会启动品牌隔离窗口，若宿主会话没有自动退出，只关闭该测试会话即可；不要终止其他会话正在使用的引擎。

> ⚠️ **串跑注意**：`pnpm test:app` 里 `media-proxy.test.mjs` 用的 `LoopbackMediaProxy`
> 是模块级单例，测试结束必须 `mediaProxy.close()`，否则 `node --test` 跑完不退出。
> 新写的 `online-playback.test.mjs` 已按这条做（`test.after` 里关掉单例）。

## 3. 运行方式

```powershell
Set-Location -LiteralPath '<仓库根>\app'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm dev
```

常用检查：

```powershell
pnpm lint
pnpm test:app
pnpm build
pnpm test:electron
pnpm test:player
pnpm test:listening
pnpm test:library
```

如果音频端点被另一个引擎压测占用，先等待对方自然退出再重跑窗口测试。不要杀掉不属于当前会话的 `twilight-engine`。

## 4. 下一阶段建议

### 第一优先级：流媒体真实接入边界

按以下顺序实施：

1. 建立主进程 `MusicProvider` 接口，统一登录、搜索、歌单、队列和播放控制能力。
2. 实现安全凭据存储，优先使用 Electron `safeStorage`，不要把 token 暴露给渲染层。
3. 实现回环媒体代理，处理 Range、签名过期、续传、来源校验和退出失效。
4. 接入网易云音乐 provider。
5. 接入 QQ 音乐 provider。
6. 把设置页账户卡片从“即将接入”切换为真实状态，并增加登录失败、过期和重新授权状态。

### 第二优先级：播放源统一控制

- 本地、网易云、QQ 音乐都通过同一套播放源状态驱动播放栏。
- 当前曲目必须带 `source` 标记，避免同名歌曲互相覆盖。
- 歌单导入要保留平台来源和不可用条目，不能把平台歌曲静默当成本地文件。
- 播放控制失败时显示平台错误，不改变本地曲库的权威状态。

### 第三优先级：设置持久化

当前设置页的主题色和频谱光效使用 localStorage。后续如果增加音频输出、播放行为和账户设置，应迁移到明确的设置仓或主进程配置文件，避免 localStorage 成为第二份配置真相。

## 5. 已知边界

- 流媒体按钮目前是骨架状态，不能声称已经登录或可以播放。
- `SettingsPage` 中的登录状态是本地临时状态，刷新后恢复为未登录。
- 左侧歌单展示前五张歌单，完整歌单管理仍在曲库歌单页。
- 本地曲库的歌曲标签质量取决于音频文件自身；缺失标签会显示文件名或空字段，这是诚实回退。
- 频谱只消费引擎 meter 数据；没有有效数据时不绘制假曲线。
- `engine/` 由其他会话维护。修改前先检查 `engine/PROGRESS.md` 和文件 mtime，避免覆盖引擎侧工作。

## 6. 交接结论

当前应用已经可以作为稳定的本地优先音乐播放器继续开发。下一位接手者应从 `SettingsPage.tsx`、`sourceAdapters.ts` 和 `main/playlists.ts` 开始理解产品边界，再按“安全凭据 → 回环媒体代理 → provider → 统一播放源控制”的顺序接入真实网易云/QQ 能力。不要直接在渲染层写平台登录请求，也不要让未完成的 provider 状态伪装成已登录播放源。

⭐ **接入 provider 时，在线播放走 `main/online-playback.ts`，不要直接调用 `mediaProxy.register()`。**
那个模块是"一次播放一个资源版本"这条契约的所有者（切歌/退出即让 token 失效）。

## 7. 本轮新增与修复（2026-10-16 晚）

### 7.1 ⭐ 修复：反复弹出的 `write EPIPE` 主进程弹窗

**症状**：反复弹出 *"A JavaScript error occurred in the main process /
Uncaught Exception: Error: write EPIPE"*。

**成因**（已复现同一栈）：引擎消失时，主进程**已经排进 socket 缓冲区的写入**
会在之后才完成，并对死管道异步报错。两个反直觉之处：

1. 它**不是**写入那一刻抛的，所以 `request()` 里 `this.exited` 那道闸拦不住它；
2. `child.stdin` 上没有任何 `'error'` 监听时，Node 对无人处理的 `'error'` **直接抛出**。

于是"引擎没了"表现为**弹窗**，而不是应用重连。

**为什么看起来间歇**：只有"缓冲里还有没写完的数据"才炸。64 字节的命令行数太少
会直接写进管道；512 KiB 载荷稳定复现。所以它不随每条命令出现，取决于写入时管道是否已断。

**修复**：`src/main/engine-host.ts` 补 `child.stdin.on('error', ...)`，与进程 `exit`
共用同一个失败出口 `failEngine()`（先到者上报一次，去重，避免 renderer 反复闪断连）。
重启策略仍只属于 `exit`。

**回归**：`tools/engine-host.test.mjs`（2 项）。移除监听即复现 `Error: write EOF`
（与用户栈同一帧），加回即绿。另在**真实 Electron 主进程**做了对照。

### 7.2 ⭐ 修复：回环代理丢弃引擎的 `If-Range`

代理只把上游 validator 往下暴露给引擎，却**丢弃了引擎发上来的 `If-Range`**，
于是"版本钉住"这条保护在 CDN 侧从未生效。已转发（含 resume 路径），
并把 resume 的接受条件从"2xx"收紧为**必须 206**（否则会把整段 body 接到半截流中间，
静默损坏音频）。回归：`tools/media-proxy.test.mjs` +2。

### 7.3 新增：`src/main/online-playback.ts`

在线播放的唯一所有者：`register()` → 交给引擎 → 播放结束 `revoke`。
**一次播放一个 token**，所以签名可以变、内容不能变，而"换一首"必然换 token。
退出时在 `index.ts` 的 `will-quit` 里 `release()`（撤销是安全特性，不是资源回收）。
回归：`tools/online-playback.test.mjs`（6 项）。

### 7.4 新增：L2 端到端验收

`tools/test-l2-integration.mjs`（`pnpm test:l2 <真实FLAC路径>`）：本地 HTTP 源扮演 CDN
→ `register()` → `open {url}` → 真引擎，**21/21 通过**。

> ⚠️ **写这类测试的两个坑**（都实际踩过）：
> ① 断言**必须带 `Range` 头** —— 不带 Range 的请求本来就该回 `200`，拿 `206` 断言是测错形状；
> ② 引擎的 `If-Range` 只在**捕获到 validator 之后**的请求出现，看首个请求永远看不到它，
> 必须"open 之后再 seek 一次"。

## 8. 本轮新增：扫描自动添加 + 无法播放曲目的标记/移除/恢复（CR-017）

owner 要求：「扫描文件夹自动添加歌曲，自动标记无法播放的歌曲并移除出列表」，
并明确症状是**播放过程中遇到无法识别 / 解码失败 / 损坏的歌曲**。

### 8.1 先实测：三条独立缺陷（真引擎，不是推断）

| # | 缺陷 | 实测证据 |
|---|---|---|
| 1 | `scan` 非递归，多层级音乐目录会整层漏掉 | 顶层 + 子目录：默认扫描只看顶层 |
| 2 | ⭐ 入库了**永远播不了**的格式 | `.opus` 在扩展名白名单里，但本构建没有 Opus 解码器 → 入库后才 `ERR_DECODE`。<br>⚠️ **`.ogg` 那一半已修**（2026-10-17）：Vorbis 与 Ogg-FLAC 现在都能解码，`.oga` 也进了白名单；`.opus` 仍不解码，但拒绝原因**点名 Opus** 并进 `unplayablePaths` |
| 3 | ⭐ **坏歌卡死整个队列** | `queue=[好,坏,好]`：好歌播完 → `log[warn]` → `state=stopped`，不跳到下一首 |

### 8.2 实现（按 owner 裁定：预检 + 播放失败记录；启动扫描 + 手动重扫；递归；移除并记录可恢复）

- **引擎侧**：`scan` 新增 `recursive` / `probe`（缺省 false ⇒ 旧行为不变），
  `scan_done` 增加 `unplayable`；自动续播改为**跳过**打不开的条目并发
  `ended {reason:"error", trackId}` 点名是哪一条。详见 `engine/PROGRESS.md §0z2`。
- **应用侧目录**：
  - `src/main/unplayable.ts` —— 记录的**唯一所有者**（持久化 + 单条/全部恢复）。
    以**归一路径**为身份（与曲库其余部分同一套规则）；重复标记更新原因而不新增一行；
    坏记录/缺失文件按「没有记录」处理，不阻断启动。
  - `src/shared/unplayable.ts` —— 跨进程形状。
  - `src/renderer/src/store.ts` —— `visibleTracks()` 增加第三参：**可见集剔除已标记的曲目**。
  - `src/renderer/src/App.tsx` —— 启动先载记录再扫盘；`scanDirectory()` 开启
    `recursive + probe`；新增 `rescanAllDirectories()`（用 `replace: true` 重扫，
    只有替换语义能同时发现新增与丢掉已删除）。
  - `src/main/index.ts` —— 在 `ended reason=error` 事件路径上把 trackId 换成路径后落记录
    （放在主进程而不是渲染层：窗口没开也要记得住）。
  - `SettingsPage.tsx` —— 「无法播放的歌曲」区块：列文件名 + 原因 + 来源 + 时间，单条恢复 / 全部恢复。
  - `LibraryList.tsx` —— 目录面板新增「重新扫描」按钮。

### 8.3 ⭐ 两条必须记住的设计理由

1. **为什么移除是应用侧过滤，而不是让引擎删掉**：判定权在解码器，**显示权**在应用侧。
   过滤做成可逆的显示决定，就不是不可撤销的删除 —— 而「文件暂时读不到」（拔盘、权限、
   正在复制）与「文件真的坏了」在磁盘上**无法区分**，误判必须能捞回来。
2. **为什么预检用「打开文件」而不是再列一份支持的扩展名**：第二份清单就是第二个会漂移的
   真相。缺陷 2 的成因恰恰是「扩展名说能读、解码器读不了」。

### 8.4 边界（如实记）

- **截断/损坏但能解码到中途的文件不会被标记**：引擎报的是 `eof`（播完了）而不是
  `error`，界面看着像正常放完。要捕获它得逐帧完整性校验，代价与收益不成比例，本轮不做。
- 移除**不删除任何文件**；恢复只是忘掉判定。
- 「记录尚未载入」（`null`）时**不过滤** —— 宁可多显示，也不静默藏歌。
