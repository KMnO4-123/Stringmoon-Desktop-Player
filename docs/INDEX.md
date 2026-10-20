# docs 索引 · 该读哪份、哪份别读

> **这份文件解决一个真实发生过的事故**：
> 有人读了 **已作废** 的 `DESIGN-v3-signal.md`，照它写 `font-variation-settings: 'DOTS'`
> —— **那个轴名是编造的**，实测是 `ROND` + `wght`，照写会**静默失效**。
>
> **所以每份文档都必须能被一眼判定：它是什么、什么时候写的、还有效吗。**
>
> 最近核实：2026-10-16

---

## 0. 先读这四份（按顺序）

| # | 文件 | 为什么 |
|---|---|---|
| **1** | [`../CONTRACT.md`](../CONTRACT.md) | **冻结契约**。两个 AI 唯一的共同语言。**只读，mtime 必须是 2026/10/14** |
| **2** | [`../README.md`](../README.md) | 项目全貌、技术栈、分工硬边界、本机环境 |
| **3** | ⭐ [`MASTER-v1-plan.md`](MASTER-v1-plan.md) | **总方案入口**：三家贡献总表 + 拉平的执行路线 + 集中裁定清单 + **§6.0 三条决定方向的事实** |
| **4** | 落地文件（按你是哪个 AI） | [`MASTER-A-engine.md`](MASTER-A-engine.md) / [`MASTER-B-app.md`](MASTER-B-app.md) |

**接手某个角色时再加读**：[`HANDOFF-A-engine.md`](HANDOFF-A-engine.md) 或
[`HANDOFF-B-app-2026-10-16-current.md`](HANDOFF-B-app-2026-10-16-current.md)。

---

## 1. ⛔ 不要读（已作废）

| 文件 | 状态 | 危害 |
|---|---|---|
| `DESIGN-v3-signal.md` | ⛔ **作废** | ⚠️ **含一处编造的事实**（`font-variation-settings: 'DOTS'`）→ 照写**静默失效** |
| `DESIGN-v3-still-water.md` | ⛔ **作废** | 被 v5 取代 |
| `DESIGN-v4-encoding.md` | ⛔ **作废** | 被 v5 取代 |
| `SPEC-v2.0-legacy.txt` | 历史参考 | ⚠️ **唯一例外**：它的 **§5「澄明之境」设计规范仍在使用中** |
| `SPEC-v1.1-legacy.txt` | 历史存档 | 无 |
| `HANDOFF-B-app.md` | 早期版本 | 被 2026-10-15 版取代 |
| `HANDOFF-B-app-2026-10-15-current.md` | 历史记录 | 被 2026-10-16 版取代（**只留逐轮决策记录**） |
| `HANDOFF-A-engine.md` | ⚠️ **仍现行** | 不是历史！见 §2 |
| `PLATFORM-v1-provider-choice.md` | 调研存档 | 结论已并入 MASTER / M3 / PLAY |

---

## 2. 按「我该读什么」分类

### 🧊 冻结契约（只读，不得修改）

| 文件 | 内容 |
|---|---|
| [`../CONTRACT.md`](../CONTRACT.md) | 接口 / 边界 / 共享事实 / 风险控制 |
| [`SPEC-v2.1.md`](SPEC-v2.1.md) | 施工口径唯一版本 |
| [`contract-requests.md`](contract-requests.md) | **CR-001 … CR-021**（**追加式**，两个 AI 都能写；等 owner 裁定） |

### 📋 方案（会变，但现行）

| 文件 | 覆盖 | 状态 |
|---|---|---|
| [`MASTER-v1-plan.md`](MASTER-v1-plan.md) | **总纲** | 3 项待裁定 + 1 项待实测 |
| [`MASTER-A-engine.md`](MASTER-A-engine.md) | **引擎侧落地** | — |
| [`MASTER-B-app.md`](MASTER-B-app.md) | **应用侧落地** | — |
| ⭐ [`OPTIMIZE-v1-candidates.md`](OPTIMIZE-v1-candidates.md) | **优化与新增候选**（含「已完成项」纠正 + 10 条优先级） | 待 owner 定优先级 |
| ⭐ [`CREATIVE-v1-human-and-pro.md`](CREATIVE-v1-human-and-pro.md) | **人性化 / 专业度 / 体验与情绪价值**（10 项，含**两处对我方既有结论的更正**） | 待 owner 定取舍 |
| ⭐ [`FIX-preventClip-peak-basis.md`](FIX-preventClip-peak-basis.md) | **`preventClip` 的 peak 口径修复**（正确性问题 + dB→线性转换陷阱） | 待实施 |
| ⭐ [`INTEGRATION-v1-engine-app.md`](INTEGRATION-v1-engine-app.md) | **引擎 ↔ 应用对接**（回环媒体通路）—— CR-016 已实施，**L2 端到端 21/21 通过**（`pnpm test:l2`） | ✅ **已接通** |
| [`DESIGN-v5-encoding.md`](DESIGN-v5-encoding.md) | **设计系统唯一权威** | 4 项待裁定 |
| [`DSP-v1-effects-chain.md`](DSP-v1-effects-chain.md) | 音效链母方案 | **6 项已裁定** |
| [`M3-v1-plan.md`](M3-v1-plan.md) | 平台 / 曲库 / 歌词 / 性能 | 3 项待裁定 |
| ⭐ [BUNDLED-RUNTIME-v0.4-2026-10-18.md](BUNDLED-RUNTIME-v0.4-2026-10-18.md) | **v0.4.0 交付**：傻瓜版——安装包内置 Node.js 24 + 网易云/QQ 服务端（压成 runtime.zip，首启解压到 userData），对方无需装任何环境；474 单测 / 201 e2e 全绿 | ✅ 已实施 |
| ⭐ [QQ-MECHANISM-v6-7-2026-10-18.md](QQ-MECHANISM-v6-7-2026-10-18.md) | **v6.7 交付**：按 Folia 一手源码对齐 QQ 机制——X-QQ-Session 裸 token 传输、移除 QQ 网页登录、登录 429 不再拉黑平台、设备上限中文化、我喜欢分页、歌单曲目匿名优先+自建回落；diag 日志定位到「设备数上限」是扫码 800 的真因 | ✅ 已实施（待用户移除旧设备后复测） |
| ⭐ [LOGIN-DIAGNOSTICS-v6-6-2026-10-18.md](LOGIN-DIAGNOSTICS-v6-6-2026-10-18.md) | **v6.6 交付**：登录系统性排查——修 `p_skey` 提前关窗（网页登录「服务端不认」的直接原因）、cookie 只取平台域并按名字挑选 + 800ms 宽限重读；扫码通道在过期态也可见；新增 `login-diag.log` 全链路诊断（qr.start/qr.poll/account.verify/web.capture/http.error）；e2e 201/201 | ✅ 已实施（等用户复现取日志） |
| ⭐ [DECLICK-v6-5-2026-10-18.md](DECLICK-v6-5-2026-10-18.md) | **v6.5 交付**：去爆音——stop/seek/切歌淡出下限 5→15ms，并在停流/暂停 hold 前写 15ms 静音等设备排空；probe-transport paddingAtStop 0→720 帧、188 条断言全绿；e2e 被用户独占设备挡住（0x8889000A） | ✅ 已实施（真机听感待验证） |
| ⭐ [LOGIN-DEVICE-v6-4-2026-10-18.md](LOGIN-DEVICE-v6-4-2026-10-18.md) | **v6.4 交付**：登录修复——网页登录白名单改为只拦主框架（CDN 子资源放行）、QQ 会话不再误认 uin；扫码——三条通道（手机QQ/微信/QQ音乐App）可切换、串行轮询、check 超时 25s、过期显示上游原因；设备——引擎修掉拔插 DAC 后不回落默认端点/不重开流的根因（player.cpp/app.cpp），selftest 全绿；e2e 201/201 | ✅ 已实施（真机拔插待验证） |
| ⭐ [`DISCOVER-QQ-v6-3-2026-10-18.md`](DISCOVER-QQ-v6-3-2026-10-18.md) | **v6.3 交付**：发现页接入 QQ 音乐——平台分段切换（网易云/QQ）、QQ 每日30首/刷歌雷达/排行榜/推荐歌单/榜单详情/歌单详情全部映射到真实路由；缓存与登录态按平台隔离；e2e 198/198 | ✅ 已实施 |
| ⭐ [`EQ-CONSOLE-v6-2-2026-10-18.md`](EQ-CONSOLE-v6-2-2026-10-18.md) | **v6.2 交付**：EQ 完整编辑器恢复「调音台模式」——十路竖向推子并排、44px dB 刻度、每路自带频率/Q/类型/复位；修掉 v5 起 input[type=range] 权重把竖向推子压成 22px 横条的根因；e2e 191/191 | ✅ 已实施 |
| ⭐ [`HIFI-KEEPALIVE-v6-2026-10-18.md`](HIFI-KEEPALIVE-v6-2026-10-18.md) | **v6 交付**：流媒体账号保活（启动校验 + 6h 巡检 + 网易云续期 + 手动立即校验）、启动自动回到上次播放（暂停态、位置落地确认）、输出规格补到 384kHz/32bit（引擎设备探测 + 32bit 满刻度溢出修复 + 三处采样率选项）；顺带修掉「自动恢复总是 0:00」的两处真实缺陷 | ✅ 已实施（e2e 185/185；真机听感/真实上游待人工） |
| ⭐ [`AUDIO-CONSOLE-v5-2026-10-18.md`](AUDIO-CONSOLE-v5-2026-10-18.md) | **v5 交付**：音频控制中心改为横向整行控制带（不再窄卡居中/留大片空白）、四 tab 整行等分、材质与设置页统一、侧栏「音效」→「音频」；顺带修掉歌词逐字填充被可见性状态锁死的真实缺陷 | ✅ 已实施（e2e 177/177） |
| ⭐ [`DISCOVER-AUDIO-v1-2026-10-18.md`](DISCOVER-AUDIO-v1-2026-10-18.md) | **v4 交付**：菜单栏「发现」页（每日推荐/私人漫游/排行榜/发现歌单 + 未登录诚实降级 + 榜单详情抽屉）、音频控制中心四 tab、引擎系统解码兜底（MF）+ DSD(DSF/DFF→176.4k PCM) + 能力矩阵 + 可控限幅器（CR-031/CR-032） | ✅ 已实施（真机听感/真实上游待人工） |
| ⭐ [`V3-v1-2026-10-18.md`](V3-v1-2026-10-18.md) | **v3 交付**：暂停/切歌爆音治理（CR-028）、空间音频 crossfeed/wide/virtual（CR-029）、GD 音乐台+Embeat 相似（含 SSRF/禁下载）、播放队列+文件夹视图+排序（CR-030） | ✅ 已实施（真机听感待人工） |
| [`V3-SPEC-2026-10-18.md`](V3-SPEC-2026-10-18.md) | v3 需求规格与代码勘测（含撤回假设的修正） | 现行 |
| ⭐ [`PACKAGING-v1-2026-10-17.md`](PACKAGING-v1-2026-10-17.md) | **出安装包 + 无痛升级**：NSIS 安装包（引擎静态 CRT 随包）、覆盖升级与数据备份、electron-updater 自托管更新、卸载保留数据、发版/回滚手册 | ✅ 已实施（未签名；真实公网源待人工） |
| ⭐ [`PLAYBACK-v2-2026-10-17.md`](PLAYBACK-v2-2026-10-17.md) | **播放链路 v2**：ECHO NEXT 专业功能移植（CR-024..027）+ E10b 切歌 + 深播优化 + ReplayGain/播放记忆/预热 + 功能落地审计 | ✅ 已实施 |
| ⭐ [`SETTINGS-LOGIN-v1-2026-10-17.md`](SETTINGS-LOGIN-v1-2026-10-17.md) | **设置/登录 v1**：设置页全宽化 + 高级音频子卡片（实际值 chips/恢复默认/应用反馈）+ 登录状态机与失败下一步 + 成功/失败动画 + 焦点归还 + e2e 121 条 | ✅ 已实施（真实扫码/网页登录待人工） |
| [`ECHO-NEXT-PORT-SPEC-2026-10-17.md`](ECHO-NEXT-PORT-SPEC-2026-10-17.md) | ECHO NEXT（本机安装物）专业功能/播放性能提取与移植取舍（证据可复现） | 现行 |
| ⭐ [`PERF-v1-2026-10-17.md`](PERF-v1-2026-10-17.md) | **性能与占用优化已落地**（引擎 meter/JSON/分析门控 + 流媒体按需启动 + 应用侧门控/去重 + 渲染层绘制与画布）——测量方法、before/after、两条待裁定 CR | ✅ 已实施 |
| ⭐ [`STREAMING-v1-2026-10-17.md`](STREAMING-v1-2026-10-17.md) | **平台接入已落地**：按 Folia 方式拉起用户自备的 API 服务端（网易云 / QQ / Meting 含酷狗），动态端口 + 探活 + 退避重启；搜索/直链/歌词/扫码登录；§5 风控约束全落实 | ✅ **已实施**（真实上游联调未做，文档已标明） |
| ⭐ [`EQ-v1-parametric-2026-10-17.md`](EQ-v1-parametric-2026-10-17.md) | **均衡器 v1 已落地**：十段参数带（PK/低架/高架 + 任意频率/Q）、预设分组、外部导入（AutoEQ/APO/REW/CSV）、Harman 目标曲线、耳机补偿库 | ✅ **已实施**（CR-019 已裁定；FIR/卷积未做） |
| ⭐ [`LYRICS-v1-online-2026-10-17.md`](LYRICS-v1-online-2026-10-17.md) | **歌词 v1 已落地**：TTML/YRC 解析、逐字+注音+翻译、在线取词链路（AMLL→网易云→LRCLIB）、计分与节流 | ✅ **已实施**（引擎零改动；待 CR-018 裁定） |
| ⭐ [`../engine/AUDIO-QUALITY-ROADMAP.md`](../engine/AUDIO-QUALITY-ROADMAP.md) | **引擎侧音质实现队列**（P1/P2 优先级）—— **与本文档的候选清单高度重合** | 引擎侧维护 |
| [`PLAY-v1-login-and-streaming.md`](PLAY-v1-login-and-streaming.md) | 多渠道扫码 + 即点即播 | **2 项已裁定**，1 项待裁定 |

### 🎯 落地指令（直接执行，不必再推导）

| 文件 | 给谁 |
|---|---|
| [`DSP-A-engine.md`](DSP-A-engine.md) | AI-A：音效链落地（**P0 已完成**，从 **P1** 开始） |
| [`DSP-B-app.md`](DSP-B-app.md) | AI-B：音效链 UI + 事件消费 |
| [`DESIGN-A-engine.md`](DESIGN-A-engine.md) | AI-A：`degradeReason` 全覆盖 + 导出 `state` trace |
| [`DESIGN-B-app.md`](DESIGN-B-app.md) | AI-B：强制层 / C2 路径 / C1 光 / 动效 / 验证 |

### 📚 调研存档（**不是契约**，不影响权威性）

| 文件 | 重点 |
|---|---|
| [`REFS-A-engine.md`](REFS-A-engine.md) · [`REFS-A2-engine.md`](REFS-A2-engine.md) | QueMusic / ECHO / Twilight_Echo（引擎相关） |
| [`REFS-B-app.md`](REFS-B-app.md) · [`REFS-B2-app.md`](REFS-B2-app.md) | QueMusic / ECHO / Folia（应用相关） |
| [`PLATFORM-v1-provider-choice.md`](PLATFORM-v1-provider-choice.md) | 平台选型逐项对比（**结论已并入上方方案**） |
| [`BRIEF-A-engine.md`](BRIEF-A-engine.md) · [`BRIEF-B-app.md`](BRIEF-B-app.md) | 各自包含的开工指令 |

### 🔄 交接（每轮更新）

| 文件 | 状态 |
|---|---|
| ⭐ [`GATE-loopback-2026-10-16.md`](GATE-loopback-2026-10-16.md) | ✅ **门禁报告**：WASAPI 回环能否录到引擎输出（**Null Test 的前置**）—— **共享能、独占不能**（已实测） |
| [`HANDOFF-A-engine-2026-10-16-current.md`](HANDOFF-A-engine-2026-10-16-current.md) | ✅ **现行**（引擎侧）—— ⚠️ 已修正一处错误声明（曾称 URL 分支已存在，实为未实施） |
| [`HANDOFF-C-app-2026-10-16-current.md`](HANDOFF-C-app-2026-10-16-current.md) | ✅ **现行**（应用侧，取代 B） |
| [`HANDOFF-A-engine.md`](HANDOFF-A-engine.md) | ⚠️ **仍现行**（2026-10-16）—— 含 **§6.0 三条决定方向的事实** |
| [`HANDOFF-B-app-2026-10-16-current.md`](HANDOFF-B-app-2026-10-16-current.md) | 上一版应用交接（被 C 取代） |
| [`APP-Stringmoon-2026-10-16.md`](APP-Stringmoon-2026-10-16.md) | 本轮应用改动与验收（更名 / 沉浸 / 频谱光带） |
| [`APP-B-implementation-2026-10-15.md`](APP-B-implementation-2026-10-15.md) | 上一轮应用实现记录 |
| [`REPORT-B-mp3-no-xing-2026-10-15.md`](REPORT-B-mp3-no-xing-2026-10-15.md) | 单题报告 |

---

## 3. ⚠️ 文档纪律（**本项目已经付过代价**）

| # | 纪律 | 代价 |
|---|---|---|
| **1** | ⭐ **调研存档里的条目不会自动进入方案** | 曾**三轮核对才补完 21 项**"有记录但执行者看不到"的条目 |
| **2** | ⭐ **写文档要写函数名/文件路径**，不能只写中文描述 | 执行者**按函数名搜索**，只有中文描述 = **搜不到** |
| **3** | **作废文档要显式标注 ⛔**，不能只靠读者推断 | `'DOTS'` 那处编造的事实就是这么传下去的 |
| **4** | **行号会因编辑作废** —— 用**内容锚点**定位 | 曾因此损坏过一次 `PROGRESS.md` |
| **5** | **每轮调研结束时跑一次覆盖核对** | 见 [`MASTER-v1-plan.md`](MASTER-v1-plan.md) §10.4 的可复现命令 |

---

## 4. 结构约定（新增文档请遵守）

每份文档的**前 12 行内**应含：

```markdown
# 标题

> **状态**：现行 / 历史 / ⛔作废 · **日期**：2026-MM-DD · **给谁**：AI-A / AI-B / owner
> **上位**：指向它所依赖的契约或方案
> （一句话说它解决什么问题）
```

**判据**：读者**只看前 12 行**就能决定「要不要继续读」。

⚠️ **当前 31 份文档里有 13 份不满足**（缺日期或缺状态）——
**新增文档不要让这个数字变大。**
