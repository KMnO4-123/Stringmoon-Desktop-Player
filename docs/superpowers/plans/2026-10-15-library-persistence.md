# App Bounded Work Plan · 2026-10-15 · 曲库目录记忆 + 封面移除 + 扫描去重

**Goal:** 让用户选择的音乐目录在重启后仍然生效；让自定义封面可以被撤销；让重复扫描不再把曲库变成两倍。

**Parent / Authority:** `docs/HANDOFF-B-app-2026-10-15-current.md` §6 未实现清单（启动目录持久化、清除自定义封面的 UI）。
用户本轮裁定：两项都做；引擎重复扫描走 CR-013 + 应用侧去重。

**Architecture:** 新增主进程 `library-config.ts`，持有 `userData/library.json`（`{ directory }`），经 preload 白名单暴露 `libraryDir()` / `setLibraryDir(dir)`。
渲染层启动时读该值代替硬编码常量；用户选目录成功后写入。
封面移除在既有 `artwork.ts` 上增加 `removeArtwork` + `twilight:remove-artwork`，与 `setArtwork` 共用同一配置文件与原子写。
去重发生在 `store.setTracks`（应用侧曲库归一边界），按 `trackId` 保留首次出现。

**Constraint:**
- 不改 `engine/`、`CONTRACT.md`、SPEC（CONTRACT §8 硬边界）。引擎侧重复扫描只写 CR-013。
- 不改 JSON Lines 协议；新增能力全在应用 IPC。
- 记住的目录可能已不存在（拔掉的盘）→ 必须**在交给引擎前**校验，引擎 `scan` 对缺失目录回 `ERR_NOTFOUND`。
- 令牌违规基线保持 0；reduced-motion / reduced-transparency 降级不变。

**Baseline (本轮实测复现，非引用文档):** lint 0 违规；app 45 / C2 11 / protocol 31 / integration 19 / electron 33 / player 35 全绿；引擎 SHA-256 `fcec9698…4d28` 与移交文件一致。

**TDD Route:** mode `off`（项目无 TDD 指令），决策 `light`，权威=项目既有验收惯例；测试姿态=先按现有 6 套检查补断言，再实现；验证=下方逐命令。

## Tasks

- [x] **T1 · 扫描去重（先决条件）** — `store.setTracks` 按 trackId 保留首次出现；app-state 断言 91 重复输入 → 91 唯一。
- [x] **T2 · 曲库目录记忆** — 新增 `src/main/library-config.ts`；`main/index.ts` 注册 `library-dir`/`set-library-dir`；preload + `index.d.ts`；`App.tsx` 去掉硬编码常量，启动读记忆值、选择成功后写入，记忆目录不可用时显示原因并回退。
- [x] **T3 · 自定义封面移除** — `artwork.ts` 增加 `removeArtwork`（删除映射并原子写）；IPC + preload；`CoverRecord` 仅在 `source === 'custom'` 时显示移除入口。
- [x] **T4 · CR-013** — 追加到 `docs/contract-requests.md`，含实测证据与不修改引擎的说明。
- [x] **T5 · 证据** — lint/build/app/c2/protocol/integration/electron/player 全跑；更新截图与移交文档。

## Verification
`pnpm lint` · `pnpm test:app` · `pnpm test:c2` · `pnpm test:protocol` · `pnpm build` · `pnpm test:integration` · `pnpm test:electron` · `pnpm test:player`（后三者用 `.smoke/qa-runtime/twilight-cover-qa.exe`，事后比对哈希）。

## Risks
- 主进程测试隔离：`test:electron` 未覆写 `userData`，新持久化会写真实配置目录 → T2/T3 的验证必须在隔离 profile 内进行（player 测试已用 `.smoke/player/profile`）。
- 去重改变 `uiIndex` 语义 → 需确认速览列表与艺术家计数跟随。

## Retirement
无旧路径退役：`LIBRARY_DIR` 常量删除后由持久化值取代；`setArtwork` 保留（移除是新增能力，不是替代）。

## 落地结果（2026-10-15）

- T1 去重：**按归一 path 去重**，不是按 trackId —— 实测证明同目录换个写法会拿到 182 个互不相同的
  trackId（详见 CR-013），按 id 去重抓不到。另加「同一会话不重扫已扫目录」。
- T2 曲库目录记忆：`library-config.ts` + `library.json` + 两个 IPC；记忆目录不可用时明确提示且不静默换库。
- T3 封面移除：`removeArtwork` 复用同一份原子写；入口只在 `source === 'custom'` 时出现，且隐藏时关掉命中测试。
- T4 CR-013 已追加（含两组实测数字与两种重复的区分）。
- T5 证据：应用 51 / C2 11 / 协议 31 / 集成 19 / Electron 33 / 播放器 41 / 曲库 11；lint 0 违规；引擎哈希未变。
- 额外修掉自查出的问题：两个底部横幅原为同坐标绝对定位会互相遮挡 → 改为纵向堆叠并加断言；
  `test:electron` 未隔离 userData，启动读记忆目录后会随本机真实配置漂移 → 已隔离到 `.smoke/qa/profile`。
- 自查出的两个自身缺陷（测试抓到后修掉）：`configureLibrary` 切换配置时未清空记忆值，导致「配置损坏」
  会继承上一个文件；异步读取缺代际保护。

---

# 第二轮 · 曲库目录从「一个」改成「一组」（2026-10-15）

**Goal:** 让「这次看到的曲库」与「下次启动拿到的曲库」永远是同一份，并允许用户把目录移出去。

**触发：** 第一轮交付后自查发现的自造缺口 —— 记忆只存**最后一个**目录，而引擎 `scan` 只增不换
（§3 命令表里没有 clear/replace），于是会话内是累加、重启后只剩最后一个：一次探索性的
「添加文件夹」会把原来的曲库顶掉，而且**换不回来**。用户裁定：多目录累加 + 可移除。

**Architecture:** `library.json` 从 `{directory}` 变为 `{directories, configured}`（旧形状自动迁移）。
主进程负责「生效目录 + 哪个不可用」；渲染层把它变成**可见集** = 引擎全量条目 ∩ 当前目录。
移除目录只改这份列表与可见集，**不重扫盘**（引擎仍留着条目，重新加回来立刻恢复）。
「正在播放」改从引擎全量列表解析，曲库列表只显示所选目录。

**Constraint:** 不改 `engine/`、CONTRACT、SPEC。引擎缺「清空 catalog」的能力已写进 CR-013 追加请求。

## Tasks

- [x] **T1 持久化改成集合** — `{directories, configured}`；迁移旧 `{directory}`；增删都只接受存在的绝对目录、
      按归一 path 去重；`configured` 区分「从未选过」（回退内置默认）与「明确移除到空」（保持为空）。
- [x] **T2 一致性：首次增删固化默认目录** — 否则会话内是「默认+新目录」、重启后只剩新目录。
- [x] **T3 可见集与身份** — `visibleTracks`（∩ 目录 + 归一 path 去重）、`isUnderRoot`（边界掐在分隔符上，
      `D:\Music2` 不算在 `D:\Music` 下）；`roots=null` 表示未解析、不过滤。
- [x] **T4 移除不必重扫盘** — 引擎没有清空命令，所以移除只是「不再显示/入队」；重新加回来立刻恢复。
- [x] **T5 正在播放不许被换掉** — `selectLoadedTrack` 从引擎全量列表解析（`Player::stop()` 不清
      `currentTrackId_`，所以「先停再移除」解不开这个死结）。
- [x] **T6 目录面板** — 曲库视图 `<details>` 面板：列出目录、标不可用、逐个移除、添加入口。
- [x] **T7 证据** — 单元 11 项（迁移/移除到空/不可用/幂等/边界）、真机六次启动 16 项、
      全量回归 app 56 / C2 11 / 协议 31 / 集成 19 / Electron 33 / 播放器 41；lint 0 违规；引擎哈希未变。

## 本轮自查出并修掉的问题

- 测试夹具顺序错：先造第二个目录、又 `rmSync` 整个 `.smoke` 把它删掉，于是应用如实报「不存在或不可访问」
  —— 是测试错了，不是产品错了（这次先看现场状态再改代码，没有直接猜）。
- 测试用错了量尺：首页的 `.track-row` 是 5 条压缩速览，量它会得到假数字；空曲库时组件提前返回，
  连 `.library` 外壳都没有。两处都改成按真实形态取。
- 移除默认目录时按调用方拼写找按钮不成立：默认目录常量用的是正斜杠，得按应用**自己存下来的拼写**定位。

## 未做（明确边界）

- 引擎仍持有被移除目录的条目（无 clear/replace）—— 已在 CR-013 追加请求，拿到之前应用侧过滤是必需的。
- 目录面板只做在曲库视图；首页的压缩速览不显示目录管理入口（有意，保持首页轻）。
