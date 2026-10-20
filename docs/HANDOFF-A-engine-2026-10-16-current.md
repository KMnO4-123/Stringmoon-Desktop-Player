# Twilight Echo · 引擎侧当前交接（2026-10-16）

> 项目根目录：`<仓库根>`  
> 适用对象：接手音频引擎、播放质量链、实时监测与引擎协议的维护者。  
> 本文件是当前状态交接；旧版 `docs/HANDOFF-A-engine.md` 保留作历史参考。

## 0. 当前结论

本轮已完成本地播放链加固、真实样本监测、连续曲线数据、监测可见性门控，以及对应的应用侧窗口同步。引擎构建和静音播放回归通过；应用单测、真实播放窗口和 Electron 集成也通过。

当前最重要的新增协议是 `set_meter`：默认不推送，应用窗口可见时由 Electron 主进程打开，隐藏、最小化或关闭时关闭。它只控制 meter 事件的序列化与发送，不改变音频样本、DSP、音量、静音、播放位置或 `outputPerfect`。

`CR-016`（`open` 接收回环 HTTP URL）**已实施并经 L2 端到端验收通过**（21/21）。完整状态以 [engine/PROGRESS.md](../engine/PROGRESS.md) 顶部为准。

> ⚠️ **本文件上一版的一处错误（2026-10-16 晚核实）**：
> 它曾写"CR-016 已裁定接受**并已有引擎侧 URL 分支**"。裁定确实接受了，
> 但**当时引擎侧并没有 URL 分支** —— `engine/src` 里搜不到任何 `"url"`，
> `cmdOpen` 只有 `requireTrack` 一条路径。照那一版读会以为可以直接调 `open {url}`。
> 该分支已在本轮补齐，见 `engine/PROGRESS.md §0y`。

## 1. 接手顺序

按以下顺序阅读，避免把历史方案当成当前实现：

1. [CONTRACT.md](../CONTRACT.md)：协议与不可违反的边界。
2. [docs/contract-requests.md](contract-requests.md)：CR-015 原裁定、`set_meter` 补充裁定，以及 CR-016 接受记录。
3. [engine/PROGRESS.md](../engine/PROGRESS.md)：引擎最新进度、测试数字和下一步。
4. [engine/AUDIO-QUALITY-ROADMAP.md](../engine/AUDIO-QUALITY-ROADMAP.md)：音质路线、已完成项与未完成项。
5. [docs/HANDOFF-B-app-2026-10-16-current.md](HANDOFF-B-app-2026-10-16-current.md)：应用侧如何消费 meter、同步窗口可见性和构建验证。

发生冲突时遵循：`CONTRACT.md` > 已裁定的 `contract-requests.md` > 当前代码与测试 > 本交接说明 > 历史交接文件。

## 2. 当前实现地图

| 范围 | 当前状态 | 关键位置 |
|---|---|---|
| 解码、重采样、环形缓冲 | 已完成并有回归 | `engine/src/audio_source.*`, `engine/src/player.*` |
| 播放输出 | WASAPI 共享/独占路径均保留 | `engine/src/output_wasapi.*` |
| DSP / EQ / ReplayGain / 限幅 | 已接入，meter 不改变 DSP | `engine/src/dsp.*` |
| 真实 meter tap | 已接在最终增益之后、格式转换之前 | `engine/src/output_wasapi.cpp`, `engine/src/meter.*` |
| 频谱 | 48 个对数频段，应用绘制为连续曲线 | `engine/src/meter.cpp`, `app/src/renderer/components/Player.tsx` |
| 波形 | 64 个真实 min/max 抽点对 | `engine/src/meter.cpp` |
| 真峰值 | `libebur128`；按采样率标注 basis | `engine/src/meter.cpp`, `player.cpp` |
| meter 可见性 | 引擎 `set_meter` + 主进程状态机 | `engine/src/app.*`, `engine/src/player.*`, `app/src/main/meter-visibility.ts` |
| 协议类型 | 已补 `meter` 能力、命令与事件字段 | `app/src/shared/protocol.ts` |

## 3. 音频数据路径与“精准采样”口径

实际路径是：

```text
decoder / source
  -> resampler
  -> PCM ring
  -> DSP chain
  -> volume / fade gain
  -> MeterTap + WASAPI format conversion
  -> device buffer
```

`MeterTap` 取的是送往输出设备前的最终浮点样本，已经包含 DSP、音量和淡入淡出增益，但还没有经过整数格式量化、抖动或设备端转换。因此 meter 反映“用户当前真正听到的引擎输出”，同时不会反过来修改播放样本。

“精准采样”在这里表示：

- 不是从 UI 伪造数值，也不是从压缩后的频谱柱反推样本；
- tap 读取真实输出帧，固定缓冲保存，控制线程异步分析；
- RMS、sample peak、peak hold、true peak、LUFS、频谱和波形都从真实 tap 数据计算；
- UI 可以对测量点做视觉插值以形成丝滑曲线，但协议中的 `spectrum` 与 `waveform` 仍是测量结果。

渲染线程不做 FFT、动态分配或阻塞锁。tap 使用固定 2048 帧、3 槽所有权状态；KissFFT、libebur128 和事件 JSON 组装在控制线程完成。meter 关闭时仍保留只读分析历史，但不组装或推送 meter JSON。

## 4. meter 事件和字段定义

事件形状如下：

```json
{
  "ev": "meter",
  "rmsDb": [-18.2, -18.4],
  "peakDb": [-6.1, -5.9],
  "peakHoldDb": [-3.2, -3.3],
  "truePeakDb": [-2.8, -2.7],
  "truePeakBasis": "oversampled",
  "lufsMomentary": -16.4,
  "gainReductionDb": 0.0,
  "spectrum": [-72.0, -68.5],
  "waveform": [[-0.4, 0.3], [-0.2, 0.2]]
}
```

- 通道数组按实际输出通道数返回；mono 源长度为 1，不复制成两份。
- `spectrum` 固定为 48 个 20 Hz–20 kHz 对数频段，单位 dB；不是 1024 个 FFT bin，也不是柱状图数据。
- `waveform` 固定为 64 个 `[min, max]` 抽点对，来自真实样本窗口。
- `lufsMomentary` 是 400 ms Momentary；历史不足时可暂不提供。
- `gainReductionDb` 是限幅器实际最大衰减，未触发时为 `0`。
- `truePeakBasis` 只有 `oversampled` 或 `sample`：采样率低于 192 kHz 时通常为过采样测量，192 kHz 及以上按库能力退化为样本峰值并明确标注。

## 5. `set_meter` 协议与生命周期

请求和回复：

```json
{"id":40,"cmd":"set_meter","enabled":true}
{"id":40,"ok":true,"data":{"enabled":true}}
```

约束已经记录在 `docs/contract-requests.md` 的“CR-015 补充裁定”：

1. `enabled` 必须是 boolean；缺失、字符串、数字或 null 返回 `ERR_STATE`，且不改变旧状态。
2. 每个引擎进程默认关闭；同值设置幂等。
3. 只有播放中且已启用时才推送，频率上限约 30 Hz；`tick()` 内部仍使用约 34 ms 的节流间隔。
4. `false` 只关闭事件序列化/发送，tap 和分析历史继续推进。
5. hello 能力包含 `capabilities.meter=true`。

应用侧由 `app/src/main/meter-visibility.ts` 维护单一状态机：

- `ready` 后发送当前可见状态；
- `show`、`hide`、`restore`、`minimize`、`closed` 都会同步；窗口不存在、隐藏或最小化都算不可见；
- 引擎断连期间不发命令，重连后重新同步；
- 旧引擎返回 `ERR_UNSUPPORTED` 时停止重试，播放继续可用；换新引擎后重新探测；
- 主进程还会丢弃不可见窗口收到的迟到 `meter` 事件，避免 renderer 收到过期帧。

不要把 `set_meter` 当作音频处理开关，也不要把 meter 能力加入 `dspModules`。监测面板只读，必须保持“只开监测时 DSP 路径与全关闭完全一致”。

## 6. 已完成验证

在 `<仓库根>` 执行过以下验证：

```powershell
cmake --build engine/build/vs2022 --config Release -- /verbosity:quiet
node engine/tools/drive.mjs --step=selftest
node engine/tools/test-playback-silent.mjs '<测试曲库>'
node --import ./tools/register-source.mjs --test tools/meter-visibility.test.mjs
pnpm typecheck
pnpm check:tokens
pnpm build
pnpm test:app
pnpm test:player
pnpm test:electron
```

结果：

- 引擎 Release 构建成功；仅有既有编译/链接警告，没有新增失败。
- 引擎自测通过。
- 静音播放回归：**73 项通过，3 种源采样率**，覆盖默认关闭、参数校验、启停、恢复、通道数组、48 频段、64 波形、true peak basis、DSP/播放质量状态不变。
- meter 可见性单测：**4/4 通过**。
- 应用单测：**132/132**。
- 真实播放窗口：**70/70**，含隐藏/最小化停帧与恢复。
- Electron 集成：**56/56**，引擎退出码为 0。

当前可执行文件：`engine/bin/twilight-engine.exe`。窗口测试消费构建后的 `app/out/`，改动 renderer 或 main 后必须先重新执行 `pnpm build`。

## 7. 已知边界与下一步

优先级建议如下：

1. ✅ **已完成：CR-016 的 L2 应用集成验收**（本地 HTTP 源当远端，排除全部外网变量）。
   结果 21/21，含字节等价、HTTP seek、416、If-Range 版本钉住、签名过期自愈、
   "传输失败不是 EOF"。回归命令见 `app/package.json` 的 `test:l2`。
2. 继续 gapless、更多 codec、完整耳机交叉馈送和长时间独占输出验证，状态见 `engine/AUDIO-QUALITY-ROADMAP.md`。
3. 对 meter 做长时运行观察：确认窗口反复 show/hide、引擎重启和高采样率切换时无旧事件泄漏、无队列增长。
4. 如果需要改字段或命令，先追加 `docs/contract-requests.md` 并取得 owner 裁定；不要直接编辑 `CONTRACT.md`。
5. ⚠️ **一次播放固定一个资源版本**这条约束现在有了应用侧所有者
   （`app/src/main/online-playback.ts`：一次播放一个 token，切歌/退出即失效）。
   接真 provider 时不要绕过它直接 `register()`。

当前没有声称完成“人耳听感”验证；已有结果证明的是数据链路、输出状态和回归行为。构建中出现的 MSB8062、C4324、C4456、C4267、LNK4098 等属于已有警告，除非后续证据表明与本轮改动相关，否则不要把它们误判为 meter 回归。

## 8. 交接纪律

- `engine/PROGRESS.md` 是引擎侧唯一的实时进度入口；每次改动后同步更新顶部记录和验证数字。
- 应用侧会同时修改 `app/`；动跨边界协议前先读 `docs/HANDOFF-B-app-2026-10-16-current.md`，避免重复实现可见性状态机。
- 不要删除或重写旧交接文件；新状态另建当前日期文件。
- 不要在 render thread 引入 FFT、JSON、堆分配或等待；不要把 UI 插值结果写回引擎测量值。
- 音频设备可能被独占压测占用。若测试出现 `AUDCLNT_E_DEVICE_IN_USE (0x8889000A)`，先判断是否有另一个 `twilight-engine` 正在运行，再区分环境争用和代码回归。

