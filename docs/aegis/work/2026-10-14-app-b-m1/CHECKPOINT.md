# App-B M1 · 持久检查点（Aegis long-task-continuation）

> 载体：本文件即唯一持久记录（不另建 per-slice 记录）。更新纪律：每个 slice 完成后改写 Todo/Evidence/Drift 段。

## TaskIntentDraft（意图）
- 用户目标：按 docs/BRIEF-B-app.md 执行 M1 应用侧（AI-B）：Electron 44 + TS/React 壳 → mock 引擎 → 曲库+播放控制 → 歌词浸入动画。
- KPI：换真引擎时协议代码零改动（CONTRACT §9.1 合并判据）。
- 停止条件：done = BRIEF §5 判据逐条有证据；blocked / needs-verification / scope-exceeded 见 Drift 段。

## BaselineReadSetHint（基线读取集）
- 已读（acknowledged）：CONTRACT.md 全文、docs/SPEC-v2.1.md（§1/§2/§3/§8/§10.1/附录A）、docs/SPEC-v2.0-legacy.txt §5（287–469 行设计圣经）、docs/BRIEF-B-app.md 全文、docs/contract-requests.md（空）。
- 未读（by design）：docs/BRIEF-A-engine.md —— CONTRACT §9 明确"每个 AI 只读自己那一份"，不跨读。
- 引用中（cited）：契约字段以 CONTRACT.md 2026-10-14 v1.1 版为准。

## TaskStartSnapshot（开工快照）
- 根：<仓库根> · 日期：2026-10-14
- git：**不是 git 仓库**（无 HEAD/分支/暂存区）；无进行中的 git 操作；无 worktree。
- 现状：app/ 不存在；engine/ 已有 third_party/taglib-2.3.2 与 README.md（AI-A 已开工）；engine/fixtures/ 为空；曲库目录 <测试曲库> 实测 91 首 FLAC；无 .lrc。
- 预存状态保持：不 stash/reset/clean（无 git 可操作）。

## 范围围栏（scope fence）
- 只写 <仓库根>\app\ 与本检查点目录 docs/aegis/work/；CONTRACT.md、docs/SPEC-v2.1.md 只读；不进 engine\ 改文件；不自创契约 JSON 字段；不读 BRIEF-A。
- app/fixtures/ 的 library JSON 是本方占位 schema，A 的 engine/fixtures/library-91.json 出现后在接入层适配（README 记录）。

## TodoCheckpointDraft（最终）
- [x] T-1 侦察+基线审读+检查点建立
- [x] T0 工程脚手架（electron-vite 5 + vite 7 + React 19.3 + TS 5.9 + electron 44.7.2）
- [x] T1 壳窗口 + 三区布局骨架 + #0B0C10（截图证据）
- [x] T2 mock-engine.mjs + 协议自测 31/31 PASS
- [x] T3 EngineHost（JSONL 坏行即报 / id 关联 / 超时 / 断连自动重启×3）+ preload 白名单
- [x] T4 fixtures/library-91.json（真实文件名 + 确定性伪时长）
- [x] T5 曲库列表（组合字符 Ⅱ́̕ / 多空格 TestBand / 长标题均不乱版，截图证据）
- [x] T6 播放栏六命令+音量+水滴进度（position 驱动 / 拖拽 seek / state 权威 / 双模式徽标）
- [x] T7 LRC → §4.3 归一化 → 效果⑤浸入（截图证据：活性行亮 + 相邻行暗 + 来源如实标注）
- [x] T8 M1 验收核查（§5 七条全过）+ app/README.md + 检查点闭合

## DriftCheckDraft（闭合）
- drift 决策：**done**（BRIEF §5 七条判据逐条有证据；无范围漂移；契约硬边界全程未越——CONTRACT/SPEC 只读、未进 engine\ 写文件、未自创契约字段、CR-001 走正规请求流程）。
- 环境战果（对 BRIEF §9 预言的勘误与补充）：
  1. pwsh 执行策略坑本会话未复现（PS 7.6.6 RemoteSigned）；
  2. **新坑（已记入 app/README）**：Electron 二进制 0 字节占位 → pnpm 不跑 electron postinstall → 手动 node install.js（镜像环境变量）；
  3. **新坑**：pnpm 11 构建白名单/镜像配置的家在 pnpm-workspace.yaml（package.json 的 pnpm 字段被忽略）；
  4. **新坑（最阴险）**：DSH pwsh 宿主环境带 ELECTRON_RUN_AS_NODE=1，electron.exe 被降格为纯 Node——主进程 spawn mock 引擎必须显式 ELECTRON_RUN_AS_NODE=1（Electron 官方子进程 node 模式）。
- 遗留交接：CR-001 等 owner 裁定；AI-A 的 engine/fixtures/library-91.json 出现后替换占位 fixture；换真引擎 = 设 TWILIGHT_ENGINE 环境变量（协议代码零改动）。

## 续轮记录（2026-10-15 · 「继续完善」= 合并判据 + 集成硬化）
- **§9.1 合并判据通过**：spawn 目标换成 `engine/bin/twilight-engine.exe`，协议代码零改动；端到端冒烟截图（真实播放 测试曲目 001 0:07/5:04，徽标「共享 · 44.1k→48k 重采样」按引擎 resampled/sourceSampleRate 如实明示）。
- 新增 `pnpm test:integration`（tools/test-real-engine.mjs，19 断言全过；含 shutdown 竞态修复——引擎回复后 ~6ms 即退，exit 监听必须先挂）。
- AI-A 的 CR-002~005 已消化：get_state 接入 bootstrap（mock 下静默降级）；目录选择落应用侧（CR-005 方案 1）；protocol.ts 按 CR-004 只增不改升级；state 空串 trackId 防御。
- 展示层拆分（display.ts）：标签为空的 FLAC 按文件名惯例显示，协议数据不动。
- CR-001 按**双方实测形状**升级（scan→{tracks}, open→{trackId,durationMs,...}, play/pause/stop→{}；set_volume 双侧分叉待裁定）。
- 全量证据：typecheck 0 错 · build 0 错 · mock 31/31 · real 19/19 · 真引擎冒烟 exit 0。
- drift 决策：continue →（本轮完成）done（合并判据闭合；剩余待 owner 裁定 CR-001~005，非应用侧阻塞）。
- 收尾修正：EngineHost **默认探测 engine\bin\twilight-engine.exe**（文档先行于实现的缺口已补齐）——未设 TWILIGHT_ENGINE 的裸 `pnpm dev` 现在直接跑真引擎；最终冒烟截图确认 engine ready + 真实时长 + 重采样徽标。

## REFS-B 执行轮（2026-10-15 · docs/REFS-B-app.md §12 清单落地）
- **intent 状态机（E1.1/E1.2 B 方案）**：store 重写为 intent + 权威状态模型；playState 扩为 no-track/loading/playing/paused；seekPending 中间态；过期事件按 intent.trackId 丢弃（连点下一首跳回 bug 治本）。
- **position 移出全局 store（E1.3）**：positionStore.ts（useSyncExternalStore 局部订阅），只有播放栏与歌词视图订阅；dur/position 均不再触发全树重渲染。
- **请求计数 loading（QueMusic §2）**：ipc.ts push/pop + 20s 看门狗强制归零；顶栏流光条；歌词请求刻意不计数。
- **增强 LRC 词级（QueMusic §4.1.1）**：lrc.ts 支持 <mm:ss.xx> 绝对 + <offset,dur,0> KRC 风格（同行混用以标注多者为准）；demo-word.lrc 全词级 fixture；LyricsView 卡拉OK高亮（sung/current/未唱三态）；来源如实标注「词级」。
- **审计通过项**：index.ts 106 行未过厚（窗口/IPC/生命周期，无业务分支）；App useEffect 有 offEvent/offErr cleanup；store 全部单字段窄选择器。
- **预留**：src/main/library/README.md（M3 双曲库来源归一层，不建空壳代码）；CR-007（operationId，E1.2 A 方案）已提交；CR-006（AI-A 独占不可达）消化其 degradeReason 入徽标。
- **验证**：typecheck 0 错 · build 0 错 · mock 31/31 · real 19/19 · 冒烟截图词级高亮生效（「逐字示例 · demo-word.lrc · 词级」）。
- drift 决策：done（REFS §12 九条全部处置：7 落地 + 2 审计通过；M3 前置项记入 library/README 与 CR-007）。
- 许可纪律：ECHO（AGPL）只学了状态机模式与 IPC 判据，未复制任何代码；QueMusic（Apache-2.0）借鉴了 extractWordLabels 的正则形状（已注明出处）。

## 美化轮（2026-10-15 · 用户指令「美化界面」；**光晕指针被用户明确否决，未实现**）
- 效果④ 封面玻璃板：鼠标倾斜 ≤2°（--rx/--ry CSS 变量 + perspective）+ 径向高光跟随（--mx/--my）+ 离开 400ms 弹簧复位；reduced-motion 静止。
- 效果⑨ 搜索光流：lib-filter 底部 1px 光线 scaleX(0→1) 生长，弹性曲线。
- Now Playing 排版：衬线 26px/-0.02em（§5.5 曲名规格）；播放中标题微呼吸（4s opacity）；播放中缩略图微光。
- 层次深度：信息栏近层面板渐变 + 主区径向辉光（§5.1 三层深度差）。
- 歌词活性行左侧强调竖线（青色渐变，呼应导航 active 线语言）。
- 交互精修：列表 hover 文字提亮、playing 行青色序号 + 文字微光、音量杆 hover 放大、进度头 hover 缩放、键盘 focus 可见环。
- 无障碍：全局 prefers-reduced-motion 守卫（动画/过渡时长归零、流光条隐藏）。
- 验证：typecheck 0 错 · build 0 错 · 冒烟截图两轮（词级高亮 + 强调线均可见）。
- drift 决策：done（静态可验证项全落地；动效手感类留待用户实机体验反馈）。

## v5 编码系统轮（2026-10-15 · docs/DESIGN-B-app.md + DESIGN-v5-encoding.md 落地，§11 顺序 1-5）
- **D1 强制层**：styles/tokens.css（唯一字面颜色文件，v5 §7 令牌全量）；tools/check-tokens.mjs（字面色/坏曲线/裸时序三查 + token-allow 逃生口 + 棘轮）；tools/token-baseline.json（首跑 84 → 现基线 83，棘轮首次下调）；pnpm lint = typecheck + check:tokens。checker 误报修复：--ease-in-out-screen 被 \bease-in\b 命中（负向前瞻修复）。新代码零欠债（3 处 token-allow 均注明 C1 跳变/进度底轨语义）。
- **D2/D3 C2 编码**：c2/encodePath.ts 纯函数（六段语法：square/bar/line/bend/dash/wave/circle/paren/gap；BP=引擎声明且全链无改动；矛盾输入防御 bp=false；capabilities 守门 dsp 段）；describePath aria 文案；**11/11 断言过**（§4.3 六条 + 4 条补充：矛盾防御/能力守门/错误路径/源率单调/降级原文可朗读）。测试归位 tools/（node --test strip-types；tsconfig.node allowImportingTsExtensions）。
- **D4 C2 渲染**：C2PathView.tsx SVG（各段几何映射；BP 连续实线合龙；severity 类驱动颜色；aria-label 必备；形变 CSS transition 走 --dur-geom）。布局：播放栏 4 列 grid（meta/c2 320px/center/right），C2 在播放轴线上。冒烟截图：■─│─∧─○ 正确编码真实引擎的 44.1k→48k 重采样 + 共享模式。
- **D5 C1 光**：C1Light.tsx 顶栏点 + 左缘 1px 光带；5 操作（off/on/breath 4s/progress 填充/扫描进度）；颜色只表严重级（白/琥珀/红）；xrun 闪 2、设备变更闪 3（事件驱动非循环）；降级琥珀慢闪；reduced-motion 降级（呼吸→常亮）。
- **DSP 段纪律**：CR-008 语义（周期 state 不带 dsp 字段，需 get_state）→ dspActive 未上报时不画波浪（不猜）；等 owner 裁定字段后接 get_state 轮询。
- **V1 马赛克**：24×16 重采样可判「在播吗」（亮区/进度结构）；C2 细线在马赛克下不可辨——**如实记录**：音质可判定性全尺寸成立、马赛克尺度部分成立（C2 线宽 1.5px 是 v5 语义值，加大线宽违反 §3.2 几何语法，接受此权衡）。
- **验证**：typecheck 0 · build 0 · tokens 0（基线 83 内）· C2 11/11 · mock 31/31 · real 19/19 · 冒烟 exit 0。
- drift 决策：done（§11 步骤 1-5 完成，系统成立；6-9 形变动效/进度 Apple 化/氛围光/颜色令牌全量替换留待下轮）。
- **未做（下一步）**：§11 步骤 6（C2 形变动效已有 CSS 钩子，待真机验手感）、7（进度条五条 Apple 手势）、8（氛围光 --cover-color-soft 待封面源）、9（theme.css 83 处历史债渐进清零）、Punctum 字体接入（需先拉 fonts/ 核实轴范围）。

## 移交轮（2026-10-15 · 整体移交）
- 交接文件：**docs/HANDOFF-B-app.md**（系统现状/文件地图/验证体系/八条铁律/第一批任务/审美提升七条路线）。
- 地面核实：engine/fixtures/state-traces.json（28KB，AI-A DESIGN-A 交接物）已就位；protocol.ts(148行) 尚未消费 CR-009 的 dspActive/dspModules/error.kind —— 已列为接手者第一任务。
- owner 指令「系统全面提升审美优化」已转译为 HANDOFF §7 七条路线（图标/排版令牌/北欧间距/C2 视觉配重/空态文案/微交互/亮色主题），每条带验收标准且受 V1/tokens/C2 三重门约束。
- drift 决策：done —— 应用侧 M1 完成、合并判据通过、v5 系统成立、移交文件就绪。本检查点归档。

## EvidenceBundleDraft（最终）
- 协议自测：`pnpm test:protocol` → **31/31 ALL CHECKS PASSED**（hello/ready/scan 91/open 非自动播放/position 推进/seek/音量/pause 权威/跳曲 ended(stop)/ERR_NOTFOUND/ERR_UNSUPPORTED/shutdown exit 0）
- typecheck：双 tsconfig **exit 0**；build：main 11.85kB / preload 0.85kB / renderer 663.61kB **exit 0**
- 冒烟截图：`app/.smoke/window.png`（2218×1339）——91/91 曲库 + 测试曲目 001 播放中 0:07/1:50 + 歌词浸入 + EXCL·96.0k/24bit·BP 徽标 + 示例歌词·demo.lrc·行级 标注
- `pnpm dev` 一条命令：job 内 22s 内出窗口 + 冒烟捕获成功
- 已知非缺陷：曲库列表滚动到底部时最后数行可见（91 条直接渲染，M1 不做虚拟列表）；播放出声要等 AI-A 真引擎（BRIEF §5 预期"此时多半还在用假引擎"）

## ResumeStateHint
- 恢复顺序：读本文件 → 重读 BRIEF-B §4/§5 与 CONTRACT §3 → 核对 app/ 实况与 Todo 段差异 → 执行最小下一步。
- 下一步：T0 脚手架（先探明 electron@44 / electron-vite / vite 可用版本再 pnpm init）。
