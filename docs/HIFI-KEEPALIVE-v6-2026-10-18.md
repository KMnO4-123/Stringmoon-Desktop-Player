# 账号保活 · 自动续播 · 384k/32bit 高保真（v6，2026-10-18）

> **状态**：现行 · **日期**：2026-10-18 · **给谁**：owner / 下一轮接手者
> **上位**：CONTRACT.md（协议冻结）、PLAN-v6（`.scratch/discover-port/PLAN-v6.md`）
> 本轮把「不用反复登录」「开机接着听」「384k/32bit 全规格」三件事落地，并修掉两个由此暴露的真实缺陷。

## 1. 三件事各自落在哪

| 需求 | 实现 | 结果 |
|---|---|---|
| 账号保活（不用频繁登录） | 主进程新增 `verifySessions()`：启动后 ~8s 首次校验、之后 6 小时一次；网易云先 `/login/refresh` 尽力续期（新 cookie 走 safeStorage 落盘），再 `/login/status` 定论；QQ 无续期接口，只校验并标 `unsupported` | 设置页「流媒体账户」每张卡新增「保活」行 + 「立即校验」按钮；结论分 ok / expired / error / unsupported / idle，**error ≠ expired** |
| 自动回到上次播放 | 渲染层 `playbackResume` 接线：启动读记忆 → open → seek（**带落地确认与重试**）→ 保持不播放；提示条写「已回到上次播放：曲名 · 0:42（暂停）」；设置页「播放体验」新增开关（默认开，关掉退回手动入口） | e2e 实测：重挂载后引擎 `trackId` 正确、`positionMs=42000`、state 不为 playing |
| 384kHz / 32bit 全规格 | 引擎：设备探测表补 352800/384000；修 32-bit 满刻度溢出（正满刻度会变负）；新增 14 条自检。渲染层：输出采样率选项补 352.8k/384k（播放栏信号面板 7→9 档、音频控制中心、设置页三处一致），输出设备行显示端点独占最高规格 | 本机实测：默认端点独占 **384000 / 32bit 真实打开**（containerBits=32、validBits=32、period 6ms、0 xrun）；352.8k 驱动拒绝 → 如实回落 shared 48k 并给出 degradeReason |

## 2. 修掉的两个真实缺陷（不是测试问题）

### 2.1 自动恢复总是回到 0:00

两处叠加：
1. **主进程记忆跟随器把 `stopped` 一律写成位置 0**。引擎在「已装载、未开始播放」时也报 `stopped`，但事件里带真实位置；旧代码忽略它，于是 open/seek 之后位置被记为 0。现在判据是事件自带的 `positionMs`：>0 照抄，只有真正的 stop（位置 0）才归零。
2. **渲染层启动顺序**：记忆记录器先于「读记忆」启动，重载时 store 的 playState 从 no-track 变 stopped 会触发一次 `saveNow()`，用位置 0 覆盖刚写好的记忆。现在先读 offer 再挂记录器。

e2e 回归：`playback-memory.test.mjs` 增加「stopped 带位置要保留 / 真 stop 归零」两条；e2e 增加整链路自动恢复断言。

### 2.2 seek 没有落地确认

`resumePlayback` 以前发一次 `seek` 就当成功（异常被吞），但 open 回复先于源就绪的瞬间会被引擎以 `no track is open` 拒绝——界面显示 42 秒、引擎停在 0 秒。现在按回复里的 `positionMs` 校验，不一致重试最多 4 次，最终以引擎回读为准。

## 3. 引擎侧（engine-hifi 交付）

| 文件 | 改动 |
|---|---|
| `engine/src/devices.cpp` | `kProbeRates` 补 352800/384000（保持升序） |
| `engine/src/dsp.cpp` | 修 `quantizeSample` 32-bit 满刻度溢出：float 表示不了 2^31-1，旧算术进位后 `lrintf` 越界→INT32_MIN（正满刻度变负 = 爆音）。32-bit 改走 double 钳位 + llrint；16/24-bit 逐样本不变 |
| `engine/src/exclusive_format.hpp` | 补 `#include <ks.h>`（ksmedia.h 要求），让 probe/open 共用头自包含 |
| `engine/src/app_selftest.cpp` | 新增 32-bit / 352.8-384k 自检 14 条（32 容器候选、字节几何、2^24 穷举往返、±满刻度/Inf/NaN 钳位、32-in-32 不 dither） |
| `engine/src/output_wasapi.cpp` | 仅注释：32bit 写出 stride 由容器位宽/nBlockAlign 决定 |

引擎产物：`engine/bin/twilight-engine.exe` 2,394,624 B sha256 `d1e7f7886bcdaed3281ceb261132ea5aaa841b2d07d2bae92165f6dbbe8277cf`；
`--selftest` 全绿（all checks passed）；`test-playback-silent.mjs` 76 assertions / 3 source rates（全程 muted）。

## 4. 界面与交互

- 设置 → 播放体验：新增「启动时自动回到上次播放」开关（默认开），说明写清「保持暂停，不自动出声」。
- 设置 → 流媒体账户：每张登录卡新增「保活」事实行（会话有效/已续期/已过期/校验失败/服务端未启动，带校验时刻）与「立即校验」按钮。
- 播放栏信号面板、音频控制中心、设置页三处的输出采样率都补到 9 档（0/44.1/48/88.2/96/176.4/192/352.8/384k）。
- 音频控制中心「输出设备」说明改为端点实测能力：「独占最高 384 kHz / 32 bit · 支持 384k 家族」，设备不支持时如实写。

## 5. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（node + web） | exit 0 |
| `pnpm check:tokens` / `check:css` | 0 violations / braces balanced |
| `pnpm test:app` | **458 / 458**（新增 9 条保活 + 播放记忆回归 2 条） |
| `pnpm test:electron` | **186 / 186，0 fail**（新增 9 条：保活 UI 3、384k 2、自动恢复 3、样本率档位 1） |
| 引擎 `--selftest` | all checks passed |
| 引擎 `test-playback-silent.mjs` | 76 assertions / 3 source rates（muted） |

## 5.1 交付物

安装包：`app/release/Stringmoon-Setup-0.3.2.exe`（根目录 `<仓库根>\\Stringmoon-Setup-0.3.2.exe` 同份）
117,285,488 B，sha256 `40b888dc20ecffa2733377372b5d7ba6446e1910e40856378078d56acee20669`。
包内 `app.asar` 的 main/renderer 与 `out/` 逐字节一致；包内引擎与 `engine/bin` 一致（sha256 `d1e7f788…77cf`）。

## 6. 诚实边界（界面与文档都照此写）

- 共享模式永远跑设备混音格式（本机 48k/32f），**不可能** 384k 保真；界面同时显示「请求」与「实际」。
- 384k 是否可用取决于 DAC/驱动：本机默认端点实测 384000/32bit 可开；352.8k 本机不支持 → 引擎如实回落并给 `degradeReason`。
- 在线源的最高规格由上游决定（网易云 hires 档为 24bit/192kHz），不假装有 384k 源。
- 账号保活只能「续期 + 尽早发现过期」，不能绕过平台风控或强制重新认证；校验失败（网络）不会把用户标成掉登录。
- 本机驱动没有 32-in-32 独占格式的实测样本；`teExclusiveFormatCandidates(24)` 的候选表有重复项（engine-hifi 已报告、未改，属下一轮候选）。