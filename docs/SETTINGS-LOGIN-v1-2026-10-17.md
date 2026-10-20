# 设置界面优化 + 登录反馈与成败动画（v1 · 2026-10-17 第三轮）

> 用户原话：「还有优化设置界面，给登录界面的反馈，给登陆成功与失败的反馈动画。」
> 交付对象：设置页（`SettingsPage`/音频高级设置）、登录入口与扫码/网页登录反馈、登录成功/失败动效。
> 依据：`docs/DESIGN-v5-encoding.md` §5（动效频率门控/Apple 层）、§6（时长双轨）、§7（颜色）；`docs/PLAY-v1-login-and-streaming.md` §2.7（结构化失败：失败要说下一步）；`app/src/renderer/src/styles/tokens.css`；`ui-ux-governance` 的交互状态与恢复规则。

## 0. 范围与不做

**做**：
1. 设置页信息架构与视觉优化：输出卡片拆「输出 / 设备 / 高级音频」，高级音频加实测状态汇总、恢复默认、应用反馈；目录与响应式、可及性改进；轮询在页面不可见时暂停。
2. 登录反馈：扫码登录模态状态机（准备/等待/已扫描/成功/过期/失败），每态一句「现在怎么样 + 下一步做什么」；网页登录显示等待中的可取消说明。
3. 登录成功/失败动画：成功对勾绘制 + 光环脉冲 + 卡片收束（约 1.1s 后自动关闭）；失败琥珀色提示 + 图标两下轻微摆动，保持打开并给出重试/网页登录。

**不做**：不新增 IPC（网页登录沿用「关闭窗口即取消」现有语义）；不做登录自检分层定位器（下一轮）；不改引擎/协议；不改默认听感与 bit-perfect 语义。

## 1. 动效决策（不是菜单，是判断）

| 判断 | 结论 | 依据 |
|---|---|---|
| 要不要动 | 登录是低频/首次操作 → 用「稀有/首次」预算 | animate 频率门控 |
| 目的 | 成功=状态指示+确认（允许一点惊喜）；失败=反馈+恢复引导 | animate §2 |
| 工具 | **CSS 过渡/关键帧**（预定动作、离主线程更稳；项目 `prefers-reduced-motion` 会全局关掉 animation/transition） | animate §3 |
| 属性 | 只动 `opacity`/`transform`；对勾用 `stroke-dashoffset`（仅此一处） | animate §4 |
| 曲线/时长 | 进入用 `--ease-out-strong` + `--dur-state`；对勾/光环用 `--dur-geom`/`--dur-env`；失败摆动 `--dur-state` | tokens + DESIGN §6 双轨 |
| 降级 | 基础样式即最终态，动画只做「from」；reduced-motion 下动画被禁用后仍显示完整对勾/静态失败提示 | DESIGN §8 + animate §7 |
| 颜色 | 成功用 `--track-accent`/`--c1-ok`；失败用 `--c1-warn`（琥珀，可重试的降级），**不用红**（红只留 ERR/fatal） | DESIGN §7 |
| 自动关闭 | 成功态至少停留 1000ms 再关闭，别让动画放一半就消失 | 可用性 |

## 2. 登录状态机（扫码）

| phase | 触发 | 标题 | 说明/下一步 | 主操作 |
|---|---|---|---|---|
| `preparing` | 打开模态、拉二维码/等 server | 正在准备登录… | 首次拉起平台服务端可能要几十秒 | — |
| `waiting` | 二维码已出 | 用手机扫码 | 用对应 App 扫描；二维码约 3 分钟有效 | 重新获取 |
| `scanned` | 轮询 802 | 已扫描 | 请在手机上确认登录 | — |
| `success` | 轮询 803 且服务端核验通过 | 登录成功 | 显示账号昵称（若已拿到）；自动关闭 | — |
| `expired` | 轮询 800 / 无会话 | 二维码已过期 | 点「重新获取」；如反复过期改用网页登录 | 重新获取 |
| `error` | IPC 拒绝 | 登录未完成 | 由 `describeLoginError` 给出下一步（设备上限/网络/风控/窗口关闭/超时…） | 重试 / 网页登录 |

失败原因→下一步（`loginFlow.ts` 纯函数，可单测）：
- `20279|设备数已超限` → 手机 QQ「设置 → 设备管理」移除旧设备（重启/换网无效）。
- `ECONNRESET|502|fetch failed|网络` → 等 10 秒重试；仍失败改用网页登录/换网络。
- `登录窗口已关闭` → 已取消网页登录；可重新扫码或再开网页。
- `超时（180 秒）` → 重新打开网页登录，或改用扫码。
- `没有进行中的扫码会话|已过期` → 二维码已过期，重新获取。
- `cookie|不接受这个会话|读取账号失败` → 重试一次；仍失败改用网页登录。
- 默认 → 原样显示消息 + 「重试一次；仍失败改用网页登录」。

## 3. 设置页结构调整

保留既有锚点 `#playback / #output / #appearance / #library / #accounts` 与 e2e 依赖的类/数据属性（`.provider-card[data-provider][data-state]`、`.settings-page`、`.device-row`、`.settings-index`、`.settings-metric`）。

`#output` 卡片内部：
1. **输出**（静态当前输出 / 输出模式 / 输出规格）——先看现在是什么。
2. **端点能力** → `<details class="settings-device">`，展开时才探测（原 IntersectionObserver 改为 details 打开触发，避免没展开也探测）。
3. **高级音频** → 子卡片 `<section class="settings-subcard settings-advanced">`：顶部一行「实际生效」chips（重采样/dither/延迟/声道工具），再放四组控件；末尾「恢复默认」+「已恢复默认」瞬时反馈；控件下发中显示「正在应用…」，成功后 1.6s「已生效 ✓」（`aria-live="polite"`）。

视觉：子卡片用 `--surface-2`/hairline；分组标题用 eyebrow；说明文字从长段落改为 1–2 行 + `title` 悬浮补全；右侧控件列最大 420px；滑杆/分段控件统一间距；760px 以下单列。

性能：设置页 `streamingStatus` 轮询只在 `document.visibilityState === 'visible'` 时跑（回到前台立即刷新一次）；离开设置页组件本来就会卸载，保持。

## 4. 登录入口

- 设置 → 流媒体账户卡片：`扫码` 按钮走统一 `startLogin(platform)`（先 ensureStarted，再开模态）；卡片上加「登录中/已登录」状态与成功短暂高亮（`data-login-flash`）。
- 歌曲中心账号栏（当前只有「未登录」和刷新，没有登录入口）：加「登录」按钮（未登录时显示），点击后同样 ensureReady → 打开模态；成功后刷新账号与歌单。
- 网页登录：按钮进入 pending 状态，卡片内提示「已打开网页登录窗口：完成登录后自动返回；关闭窗口即取消。」；成功/失败给 inline 反馈条（成功 1.6s 后淡出；失败保留并给重试）。

## 5. 测试契约（DOM）

- 模态：`.qr-overlay[data-phase]`、`.qr-card[data-phase]`、`.qr-hint`、`.qr-image`、`.qr-success`、`.qr-check`、`.qr-fail`、`.qr-next`、`.qr-actions button`。
- 设置：`.settings-subcard.settings-advanced`、`.settings-actual-chips .chip`、`.settings-apply[data-state]`、`button.settings-reset-defaults`、`.settings-device[open]`。
- 登录成功后：`.provider-card[data-login-flash="success"]`（约 1.6s）、`.account-head[data-login-flash]`。

## 6. 验收

1. `pnpm lint` / `pnpm test:app` / `pnpm build` / `pnpm test:electron` 全绿；既有 105 条断言不回退。
2. 新增单测：`login-flow.test.mjs`（phase 推导、失败原因→下一步、空/未知错误不吞消息）。
3. e2e 新增（用 mock streaming server 控制 QR 模式）：成功流看到 waiting→scanned→success 且模态自动关闭、账号名更新；失败流看到 `[data-phase=error]` + 下一步 + 重试可恢复；设置页高级音频子卡片、恢复默认、应用反馈可见。
4. 独立验证：截图（设置页 1280/900、登录成功/失败）、reduced-motion 下成功态仍可见且自动关闭、键盘 Escape/焦点、长文案与窄窗不溢出、现有门禁。

## 7. 证据与未覆盖面

- 真实扫码全流程需要真机与真账号；本轮用 mock 服务端覆盖状态机与动画的 DOM/逻辑，**真实三渠道登录仍需人工验收**（PLAY-v1 §6 已列为必须人工项）。
- 网页登录成功/取消的真实窗口流程也在人工项内；e2e 只覆盖入口与 pending 文案。

---

## 8. 结果（截至 2026-10-17 22:15）

**构建（最终）**：JS `out/renderer/assets/index-DdhX5SAq.js`（2,614.51 kB）/ CSS `index-C1-3YnZe.css`（129.29 kB）；main 392.7KB / preload 9.98KB；引擎 exe 未变（`9DD47E13…F209ED`）。

**交付内容**：
1. 设置页 #output 拆「输出 / 端点能力（details，展开才探测）/ 高级音频子卡片」；实际生效 chips、恢复默认、正在应用/已生效/未生效反馈、滑杆实色 token、band/delay 对齐、760px 单列；设置页轮询 hidden 暂停。
2. 登录反馈：`loginFlow` 纯函数状态机（preparing/waiting/scanned/success/expired/error + 错误→下一步，剥 Electron IPC 前缀）；`QrLogin` 重写；设置卡片扫码准备提示、失败内联下一步、网页登录 pending/成功/失败反馈；歌曲中心账号栏新增登录入口。
3. 成败动画（CSS）：成功对勾 stroke 绘制 + 光环 + 卡片 glow，≥1.1s 后自动关闭；失败琥珀图标两下轻摆 + 中性底 + 下一步，不自动关闭；reduced-motion 下基础态=最终态（对勾已画完/静态提示）。

**自动化证据**：
- `pnpm lint` ✅（typecheck / check:tokens 0 违规 / check:css）
- `pnpm test:app` ✅ **356/356**（新增 login-flow 单测 6 条：phase 推导/每态下一步/20279/网络·窗口·超时·会话·cookie/未知错误不吞原文/IPC 前缀剥离）
- `pnpm build` ✅
- `pnpm test:electron` ✅ **121/121**（105 旧 + 14 登录/设置新 + 2 条 900 窄窗；4 条歌词 fill 回归已由 paintRef 韧性修复恢复）；截图 `app/.smoke/qa/{login-failure,login-success,settings-advanced-1280,settings-advanced-900,settings-fullwidth-1600}.png`（1600 打点：layoutWidth 1351 / cardWidth 1130 / bandWidth=delayWidth **658** / cardRightGap 59，右侧无大空洞）
- mock 服务端新增可控 QR 模式（fast/sequence/expired/error），e2e 用 sequence/error 覆盖 scanned→success 与失败恢复；mock WAV 3s→8s 修掉既有在线曲竞态。

**独立验证**：见 `app/.smoke/perf-verify/VERIFICATION-REPORT.md` §9（待验证者补充）。

**过程中发现并修掉的自身问题**：player.css 一次 read→拼接→write 触发 read 字符预算导致尾部块丢失，已用 append 恢复并逐项核对；LyricsView 的 paintRef 被 effect cleanup 清空后不复位（e2e 偶发歌词填充全 0 的根因），改为 render 期赋值、删除 cleanup 清空。
**收尾追加（用户直接反馈）**：「操作的、控制的相关界面横向占满，不要居中一点点」。落地：`.settings-layout` 从 `148px + minmax(0,720px)/max-width:980px` 改为 `148px + minmax(0,1fr)/max-width:none`；`.sound-page` 去 `max-width:1280px` 与居中；高级音频控件列 `min(720px,60%)`、band/delay `min(720px,100%)`、`.settings-tools` 解除 round-2 遗留 420px 上限（实测 1600 下控件宽 **658px**，1280 下随卡片收窄，900 无溢出）。另修：关闭登录模态焦点归还触发按钮（`returnFocusTo`，父组件点击时记录 trigger——异步 ensureReady 期间 button disabled 会让 activeElement 掉到 body）；test:startup harness 中段竞态（几何检查移到 entering 阶段、截图异步、等待预算放宽，断言不变，连跑 3 次 16/16）。

**人工项（未覆盖，不能自称通过）**：真实三渠道扫码全流程（真机+真账号）、真实网页登录窗口完成/取消、真机听感与动效手感、reduced-motion 真机偏好切换。
