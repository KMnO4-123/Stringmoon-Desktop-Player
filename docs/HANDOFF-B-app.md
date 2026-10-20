# HANDOFF-B-app · 应用侧整体移交书

> **移交人**：AI-B（上一任） · **日期**：2026-10-15 · **接手人**：下一任 AI-B
> **上位权威**（按序）：`CONTRACT.md`（冻结，只读）→ `docs/SPEC-v2.1.md`（只读）→ `docs/DESIGN-v5-encoding.md`（界面唯一权威）→ 本文件（现状与起点）。
> **你的第一条任务在 §7**：owner 指令「系统全面提升审美优化」——但先读完 §1–§6，否则会拆坏已经成立的东西。

---

## 1. 现在的系统长什么样（30 秒版）

Electron 44 + TS + React 19 + zustand。引擎是**独立 C++ 进程**（AI-A，`engine/bin/twilight-engine.exe`，M1+M2 已完成、256 断言全绿），经 JSON Lines over stdio 通信。**应用侧协议代码零改动通过合并判据**（CONTRACT §9.1）——这是本项目的 KPI，接手后一切改动不得破坏它。

三通道界面系统（DESIGN v5）已立：
- **C1 光**：顶栏状态点 + 窗口左缘 1px 光带（`C1Light.tsx`）——GDK 五操作（off/on/呼吸/进度/进度+全亮），事件驱动，禁装饰动画
- **C2 形**：六段信号路径 SVG（`c2/encodePath.ts` 纯函数 + `c2/C2PathView.tsx`）——引擎音质遥测的几何编码，**零色彩依赖**
- **C3 字**：正文
- **强制层**：`styles/tokens.css`（唯一字面颜色文件）+ `tools/check-tokens.mjs`（棘轮基线 83）+ `pnpm lint`——**新增字面色/坏曲线/裸时序 = lint 红**

## 2. 文件地图（全部在 `app/`）

| 路径 | 职责 | 接手须知 |
|---|---|---|
| `src/main/engine-host.ts` | 协议层，唯一 spawn 点 | 坏行即报 / id 关联 / 断连重启×3；默认探测 engine/bin 真引擎，`TWILIGHT_ENGINE` 可覆盖 |
| `src/main/index.ts` | 窗口/IPC 注册/冒烟截图 | 106 行刻意薄（E3 判据：出现业务 if/else 就是架构走偏） |
| `src/main/lyrics.ts` | LRC 解析回退链 | 同名 .lrc → fixtures 同名 → demo-word（词级）→ demo（行级） |
| `src/shared/protocol.ts` | CONTRACT §3/§4.3 的 TS 形状 | **148 行，落后于引擎**——见 §5 第一任务 |
| `src/shared/lrc.ts` | LRC→§4.3 归一化 | 增强 LRC `<mm:ss.xx>` + KRC `<off,dur,0>` 双格式，wordByWord 诚实标注 |
| `src/renderer/src/store.ts` | intent + 权威状态机 | state 事件权威；intent 在途丢弃过期事件；loading/seekPending 中间态 |
| `src/renderer/src/positionStore.ts` | 高频进度仓 | **position 绝不进全局 store**（E1.3）；useSyncExternalStore 局部订阅 |
| `src/renderer/src/ipc.ts` | 请求计数 + 20s 看门狗 | 歌词请求刻意不计数 |
| `src/renderer/src/c2/` | C2 编码+渲染 | encodePath 纯函数 11 断言；渲染层不做语义判断 |
| `src/renderer/src/components/` | C1Light / Playbar / LibraryList / InfoPanel / LyricsView | InfoPanel 有封面倾斜（效果④）；歌词有卡拉OK词级高亮 |
| `src/renderer/src/styles/` | tokens.css + theme.css(627行) | **theme.css 有 83 处历史债（棘轮基线），只许降不许升** |
| `tools/` | mock-engine(假引擎) / test-mock(31断言) / test-real(19断言) / check-tokens / encodePath.test(11断言) / gen-fixture | `pnpm dev` 一条命令起全套 |

## 3. 验证体系（改完任何东西跑这个）

```
pnpm lint          # typecheck + tokens 棘轮（新增违规即红）
pnpm build         # 三产物
pnpm test:protocol # mock 引擎 31 断言
pnpm test:integration # 真引擎 19 断言（play 会真的出声几秒；exe 缺失自动 SKIP）
pnpm test:c2       # C2 编码断言 11 条
```
**V1 马赛克测试**（验收核心）：截图 → 缩 24×16 → 放大，仍能判断「在播吗 / 音质有没有问题」。已知权衡：C2 细线在马赛克下不可辨（线宽 1.5px 是 v5 §3.2 语义值，不加大）。
冒烟：环境变量 `TWILIGHT_SMOKE=1` → 8 秒自动截图 `.smoke/window.png` 并退出。
**三件人眼项你不许自称通过**：呼吸节奏 4s、C2 形变手感（DevTools 放慢 4×）、氛围光强度——只能 owner 真机看。

## 4. 铁律（违反 = 返工）

1. `CONTRACT.md`/`SPEC-v2.1.md` 只读；不进 `engine/` 改文件；改契约走 `docs/contract-requests.md`（**CR-001~009 已在排队等 owner**，先读再动手——CR-008/009 的字段引擎已实现）
2. **界面只画引擎声明支持的东西**（P1）——字段未上报就不画，不猜。AI-A 的教训：虚报与漏报同样是撒谎
3. 降级用琥珀虚线不用红；红只给 ERR_*/fatal（本机长期降级，红会失去信号价值）
4. C1 禁装饰性循环动画——每次光变必须由真实事件触发
5. position 不进全局 store；state 事件是权威，UI 不自行推断
6. 令牌棘轮：theme.css 83 处历史债只降不升；新代码零欠债（token-allow 需注明语义理由）
7. 许可：ECHO(AGPL) 只学模式不抄码；QueMusic(Apache-2.0) 抄码保留版权声明；Punctum(OFL-1.1) 未接入
8. 环境坑（必读）：DSH pwsh 宿主带 `ELECTRON_RUN_AS_NODE=1`（启动 electron 前必清）；pnpm 11 白名单在 pnpm-workspace.yaml；electron 二进制 0 字节时进包目录 `node install.js`

## 5. 你的第一批任务（按序）

1. **protocol.ts 升级**：消费 CR-009 字段（`state.dspActive`/`dspModules`、`error.kind`、`xrunCount` 会话累计语义）——引擎已发，我方类型未接（148 行落后）。然后接 `get_state` 的 `data.dsp` 轮询驱动 C2 DSP 段（CR-008：周期 state 不带 dsp，别按秒轮询，DSP setter 已改为触发状态事件）
2. **喂 trace fixture**：`engine/fixtures/state-traces.json`（AI-A 交付，含一次真实降级）——把它灌进 encodePath 断言，验证 C2 对真实降级路径的编码
3. **§7 审美提升**（owner 指令，见下）
4. CR-001~009 中 owner 已裁定的，落地后从 contract-requests 移到「已裁定」

## 6. 未完成清单（DESIGN-B §11 步骤 6–11）

- C2 形变动效：CSS 钩子已留（`.c2-src`/`.c2-seg-path` transition d），手感未验
- 进度条 Apple 五条手势：抓取偏移/1:1+时间码/橡皮筋/速度投影(`project(v,d=0.998)`)/打断从当前值——目前只有基础拖拽
- 氛围光：`--cover-color-soft` 令牌已备，无封面源（引擎封面提取 = 跨边界，走 CR）
- Punctum 点阵字：OFL-1.1 已核实轴名 `ROND`+`wght`（**'DOTS' 是编造的，v3 文档已作废**）；接入前必须拉 fonts/ 实测轴范围；只用于 ≤14px 的 C2 标注与数字
- theme.css 83 处历史债：渐进清零，每清一块下调基线
- 亮色主题：令牌已语义化，加一套亮色值即可成立（C2 零色彩依赖是免费收益）

## 7. ⭐ owner 指令：系统全面提升审美优化

**边界先说死**：v5 系统是骨架，审美在系统内提升——不是换皮肤。验收不变：V1 马赛克可判读、tokens 棘轮绿、C2 断言绿。**任何以牺牲 R1（状态可判定）为代价的美化都是倒退。**

按性价比排序的七条路线（每条都给了验收标准）：

1. **图标语言**（最高优先）：播放控制现在是 emoji（⏮▶⏹⏭）——廉价感的主要来源。换**内联 SVG 线性图标**：1.5px 描边（与 C2 线宽同语言）、`--c2-line` 色、hover 变 `--c3-primary`。验收：马赛克测试下播放/暂停仍可辨；无 emoji。
2. **排版系统化**：现在只有曲名 26px 衬线是成体系的。把 §5.5 的字阶做成令牌（`--type-*`）：列表曲名 14/450、艺术家 13/400+0.01em、时长等宽 12/400+0.02em、歌词当前行 18 衬线、C3 注释 11 mono。行高与字距一并进令牌。验收：全界面无裸 font-size（加进 check-tokens 检查项）。
3. **北欧间距落地**：§6.1 的 4/16/40 三档令牌（`--space-*` 已建未用）。曲库行高 46px→呼吸感重排；信息栏三块（封面/元数据/歌词）之间用组间 16px 区隔；播放栏三区用空白分组不画线。验收：同组元素间距 ≤8px，组间 ≥16px，区段 ≥40px。
4. **C2 视觉配重**：路径现在是功能性细线，作为「一屏重心」（§6.1：播放中重心在 C2）偏轻。允许的提升：节点 8→10px、线宽 1.5→2（**这是全局语义值变更，先在 encodePath 断言旁记录版本**）、BP 实线加微辉光（`filter: drop-shadow`，非渐变色）。验收：V1 马赛克下 C2 段可辨——把上轮「不可辨」的权衡翻案。
5. **空态与降级文案**（学 ECHO 文案表，v5 §10.3）：「曲库为空——等待引擎 scan」→「选择一个音乐文件夹开始扫描」（配顶栏按钮指引）；错误横幅补「下一步」动作。验收：每个空态/错误都有下一步动词。
6. **微交互抛光**：列表 hover 已有；补列表选中态（单击选中 vs 双击播放的视觉区分）、滚动惯性 CSS（`overscroll-behavior`）、封面倾斜的 hover 进入过渡（现在直接跟随，加 100ms  ease-out-strong 进入）。
7. **亮色主题**（压轴）：tokens 语义层已就绪，加 `[data-theme='light']` 令牌组；C2 零色彩依赖使代价极小。验收：两主题下 V1 马赛克同等可判读。

**禁止事项**（重申 §12）：不抄 Nothing 外观产物（黑底堆点阵/红点缀/装饰网格线）；不为好看加循环动画；不用颜色编码音质；不把歌词/正文交给 Punctum（它是仪表盘不是书）。

## 8. 一句话

> 三通道已立、强制层已红、引擎已真——你接手的是一台**活着的机器**。
> owner 要的「审美提升」不是给它化妆，是**把它的仪表盘做到配得上它的诚实**。
> 每动一步：`pnpm lint` 绿、断言绿、V1 可判读——系统就会在你的手里继续生长。
