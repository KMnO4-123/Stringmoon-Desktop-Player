# 接口变更请求（contract-requests）

> 两个 AI 都可以在这里追加请求，**但不得自行修改 `CONTRACT.md`**。
> 格式统一如下，一条一段，追加在文件末尾（不要改写别人的条目）。

---

## 模板（复制这一段来用）

```markdown
### CR-000 · <一句话标题>
- 提出方：AI-A（引擎） / AI-B（应用）
- 日期：YYYY-MM-DD
- 涉及：CONTRACT §<章节>，具体条目：<字段或命令名>
- 现状：<现在契约怎么写的>
- 请求：<希望改成什么>
- 理由：<为什么现在这样不行 / 会阻塞什么>
- 若不改的替代方案：<有没有绕法>
- 裁定：（owner 填）接受 / 拒绝 / 修改后接受 · 日期
```

---

## 已裁定

（暂无）

---

## 待裁定

### CR-001 · 补齐 §3 各命令回复的 data 形状（list_tracks / hello / open / seek / set_volume / next / prev / list_devices）
- 提出方：AI-B（应用）
- 日期：2026-10-14
- 涉及：CONTRACT §3.2/§3.3，具体条目：`list_tracks`、`hello`、`open`、`seek`、`set_volume`、`next`、`prev`、`list_devices` 的回复 `data`
- 现状：§3.2 定义了命令、§3.3 定义了事件，但上述命令回复的 `data` 字段结构没有明文。应用侧（React/TS）需要把回复渲染成强类型。 Particularly `list_tracks`：曲库列表的唯一来源，字段（title/artist/album/durationMs/path/sampleRate/bitDepth）与命名必须双方一致，否则合并时必然返工。
- 请求：在 §3.3 之后补一节「回复 data 形状」，建议：
  - `hello` → `{ protocol: 1, version: string }`（`ready` 事件之外，回复也带版本，便于请求-应答式探测）
  - `list_tracks` → `{ tracks: Track[] }`，其中 `Track = { trackId, title, artist, album?, durationMs, path, sampleRate?, bitDepth? }`（时间毫秒整数；字段名与 §3.3 事件一致）
  - `open` → `{ trackId, durationMs }`；`seek` → `{ positionMs }`；`set_volume` → `{ volume }`；`next`/`prev` → `{ trackId }`（跳转后的当前曲目）；`list_devices` → `{ devices: DeviceInfo[] }`，`DeviceInfo = { id, name, isDefault? }`
- 理由：应用侧在 mock 引擎上按上述形状实现并已跑通协议自测（31 项断言）。若 A 侧另取形状，合并时协议代码必改，违背 §9.1「换真引擎零改动」判据。
- 若不改的替代方案：应用侧把回复 data 当 unknown 处理、只从事件取状态 —— 但曲库列表只能来自 `list_tracks`，没有事件替代，无法绕开。
- 裁定：接受 · 2026-10-15 —— 回复 data 形状照引擎已实现者，B 侧不再需要兼容层
---

### CR-002 · 队列与播放模式需要三条命令（引擎侧已实现，请裁定字段名）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2 命令表
- 现状：§3.2 的命令表里没有 set_queue / set_repeat / get_state，但它同时给了 next / prev，
  而 M1 判据（SPEC §10.1 的 L1 层、BRIEF-A 第 3 步）要求「队列模式：顺序 / 单曲 / 列表 / 随机」。
  没有 set_queue，应用无法告诉引擎「下一首是谁」，引擎也无法自己续播。
- 请求：把下面三条补进 §3.2 的命令表（字段名已经这么跑了，直接固定即可）：

  {"id":16,"cmd":"set_queue","trackIds":["tl_0001","tl_0002"]}
      → {"id":16,"ok":true,"data":{"count":2}}
      队列里出现未知 trackId 时整条命令失败回 ERR_NOTFOUND（不部分接受）

  {"id":17,"cmd":"set_repeat","mode":"sequential"}
      → {"id":17,"ok":true,"data":{"mode":"sequential"}}
      合法值 sequential | one | all | shuffle；其他值回 ERR_STATE

  {"id":18,"cmd":"get_state"}
      → {"id":18,"ok":true,"data":{...}}   // 与 state 事件同结构
      用途：应用重连 / 刷新时主动要一次权威状态，不必等下一次状态变化

- 理由：不阻塞（引擎已实现，多出来的命令对旧应用无害），但**不写进契约 AI-B 就不知道该发什么**。
- 若不改的替代方案：应用在自己的主进程里维护队列，每次自己决定下一首再发 open。
  但那样队列所有权落在应用侧，SPEC §3.7 的 gapless（「下一首常驻缓冲」）就无法实现——引擎不知道下一首是谁，没法预解码。
- 裁定：接受 · 2026-10-15 —— set_queue / set_repeat / get_state 字段名照实现

---

### CR-003 · 采样率不一致怎么办：引擎已按 SPEC §3.4 实现重采样，请确认口径
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.4（降级不是错误）、SPEC §3.4 / §3.3
- 现状：本机音频设备混音格式**实测**为 48000Hz / 2ch / float32；测试库 91 首里
  **74 首 44.1k、11 首 48k、6 首 96k**。若只在「源率 == 设备率」时播放，**80 首打不开**，
  M1 判据 A3「双击任一曲目 → 从本机声卡放出声」直接不成立。
- 请求：确认以下口径：
  1. 引擎按 SPEC §3.4 引入 **SoXR**（组件表 §2.6 已列），源率 ≠ 设备率时自动重采样；**同率时不创建转换器**（SPEC §3.4「同率时跳过」）
  2. 重采样属**降级不是错误**：不返回 `ok:false`，用 `state.resampled:true` + `state.bitPerfect:false` 表达
  3. 引擎**没有**因此实现 EQ / ReplayGain / 位深转换——那些仍属 M2
  4. 独占请求（`set_output mode=exclusive`）仍回 `ERR_UNSUPPORTED`（M2 范围）：
     §3.4 说「降级不是错误」指的是**引擎自己**降级（独占失败转共享）；
     应用**主动请求**一个尚不存在的能力是另一回事，应如实告知，**不静默转共享**——
     否则应用分不清「用户要独占」和「系统自动降级」，UI 文案会说错
- 理由：这条必须由 owner 定口径，否则 AI-B 可能以为「引擎该自己转采样」或「引擎不该转采样」。
- 若不改的替代方案：应用侧自己重采样再喂 PCM —— 那要求音频样本穿越 stdout 通道，直接违反 §3.1 铁律 2，不可行。
- 裁定：接受 · 2026-10-15 —— （此条未单独提问，随「字段名全部接受」同批确认；如需单独复议请指出）

---

### CR-004 · §3.3 回复与事件的补充字段（只增不改，请确认清单）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.3
- 现状：**CR-001（AI-B）请求的字段，引擎已全部实现并通过一致性断言**
  （`node engine/tools/drive.mjs --step=contract` → 28 条断言全绿），
  字段名逐字一致。引擎另外多发几个字段，均属 §3.3 允许的「多余字段」（对方忽略即可），
  此处只是把清单固定下来，免得 AI-B 去猜。
- 请求：确认以下补充字段可以存在：
  - `hello` 回复额外带 **`capabilities`**：
    `{exclusive:false, shared:true, resampler:true, dsp:false, queue:true, seek:true}`
    引擎**如实自报能力**，应用应据此灰掉独占 / EQ 等还没做的控件，而不是等命令失败。
    这同时满足了 CR-001 里「便于请求-应答式探测」的意图。
  - `state` 事件与 `open` 回复额外带 **`resampled` / `sourceSampleRate`**：
    源率 ≠ 设备率时为 true。共享模式本来就 `bitPerfect:false`，但这一位区分
    「是重采样了」还是「源率恰好等于设备率」，UI 文案可以据此分开写。
  - `state` 事件额外带 `deviceId` / `deviceName` / `periodMs` / `xrunCount`
    （对应 SPEC §3.3「实际落点必须报给 UI」与 SPEC §8.2 的 xrun 口径）
  - `open` 回复额外带 `sourceSampleRate` / `bitDepth` / `channels` / `outputMode` / `resampled`
  - `scan` 回复额外带 `data.path`（原样回显请求的目录）
- 理由：只增不改；固定下来才好让 AI-B 把它们渲染出来。
- 若不改的替代方案：AI-B 只读它需要的字段、其余忽略。功能上可行。
- 裁定：接受 · 2026-10-15 —— 补充字段清单照实现，只增不改
---

### CR-005 · `pick_folder` 应该由哪一侧提供（引擎 or 应用）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2，具体条目：`pick_folder`；§8 分工表
- 现状：§3.2 把 `pick_folder` 描述为「引擎侧弹原生目录选择，返回 path」，但 §8 的分工表把
  UI / 交互划给应用侧，引擎 owns 的是「解码、重采样、DSP、WASAPI 输出、设备管理、标签读取、扫描」。
  引擎是**独立进程**，让它弹原生对话框会把 UI 逻辑塞进音频进程，而且引擎目前不链接任何 UI 库。
- 现状（实现层面）：这是 M1 里**唯一**还回 `ERR_UNSUPPORTED` 的 M1 命令（`set_output mode=exclusive` 是有意留给 M2 的）。
- 请求：在下面两个方案里裁定一个：
  1. **移到应用侧**（我倾向这个）：应用用 Electron 的 `dialog.showOpenDialog` 拿到路径，
     再发 `scan {"path": ...}`。契约里把 `pick_folder` 标为「可选 / 由应用侧提供」。
     好处：不跨边界、不引 UI 依赖进引擎、弹框跟随应用主题。
  2. **留在引擎侧**：那么需要额外裁定一件事——**弹框时引擎要不要暂停播放**、
     以及弹框期间 `ready`/事件流是否照常（模态对话框会阻塞控制线程，
     而控制线程同时也负责发 `position` 事件）。这会是引擎里第一个会阻塞的东西。
- 理由：这条不确定会让 AI-B 不知道该不该实现自己的目录选择（可能两份都写，或都不写）。
- 若不改的替代方案：应用侧直接自己实现（方案 1），完全不需要这条命令。
- 裁定：移到应用侧 · 2026-10-15 —— 用 Electron dialog.showOpenDialog；契约把 pick_folder 标为「可选 / 由应用侧提供」。引擎侧保留 ERR_UNSUPPORTED 并说明归谁
---

### CR-006 · 本机端点无法真正跑 WASAPI 独占：bit-perfect 在这台机器上不可达（需要 owner 决策）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.4、SPEC §1.1 / §3.3 / §10.2（M2）
- 现状：**独占模式已按 SPEC §3.3 实现完毕**——能力探测、在源采样率与位深上开流、bit-perfect 判定、
  降级明示、静音看门狗都有，验收 26 条断言全绿（`node engine/tools/drive.mjs --step=exclusive`）。
  但**实测结果是：这台机器听不到独占输出**。三条实测数据：
  1. 端点混音格式 2ch @ 48000Hz float32，**独占只接受 48000:16 与 48000:24**
  2. 因此 91 首里 **74 首 44.1k + 6 首 96k = 80 首**，在这台机器上**不可能** bit-perfect
  3. 那 11 首 48 kHz 的独占流**能开起来、报 bitPerfect:true，但驱动的缓冲区事件从不触发——
     一个采样都不出声**。引擎的看门狗检测到后自动降级回共享并继续播放，同时发 log 与 degradeReason。
- 请求：owner 裁定下面几条，因为「听到 HiFi」这条路现在堵在硬件/驱动上，不在代码上：
  1. **接受现状**：SPEC §1.1 的差异点改为「波形/整数链路上可达 bit-perfect，
     实际出声受端点驱动限制」。M2 其余项（EQ / ReplayGain）照常推进——它们不依赖独占。
  2. **换端点再验**：接一个独立 DAC（USB 或板载另一路），重跑 `--step=exclusive`。
     引擎不需要改一行，探测会自动报出新格式。若新端点支持 44.1k 独占，74 首立刻可 bit-perfect。
  3. **查系统独占开关**：Windows「声音 → 设备属性 → 高级」里有「允许应用程序独占控制该设备」，
     若被关掉，独占会直接失败。本次实测**该开关是开着的**（探测能返回可用格式），
     所以问题在驱动的事件回调，不在系统开关。
- 理由：这是本项目**唯一不可替代的差异点**，而它现在卡在硬件上。
  如果不说清楚，AI-B 那边会把 bit-perfect 徽标做出来，用户打开却听不到区别。
  引擎已经做到「不撒谎」：听不到就不报 bit-perfect，这也意味着 UI 可以安全地按 state.bitPerfect 显示。
- 若不改的替代方案：没有绕法。SPEC §3.6 已明确 Native DSD 依赖 ASIO、无硬件；
  独占在 WASAPI 层已经做到头了，再往下就是驱动和端点的事。
- 附带请求：**建议给 AI-B 的 UI 文案约定**——
  用 `state.bitPerfect` 决定是否显示 bit-perfect 徽标，
  用 `state.degradeReason`（非空时）显示原因，
  用 `ready.devices[].exclusiveFormats` 在设置页提前说明「这台设备能 bit-perfect 哪些采样率」。
- 裁定：继续深挖驱动 · 2026-10-15 —— owner 要求再查一次独占开流路径，不急于接受现状

#### ✍️ AI-A 回复（2026-10-15）：**挖到了，结论变了 —— 不是这台机器的限制，是这个「端点」的限制**

owner 要求继续深挖。挖出了一个**此前不知道的事实**，它把结论从「硬件不支持，只能接受」
改成了「**你手上有一个很可能能用的端点，只是没插**」。

**1. 当前活跃端点到底是什么**

```
扬声器 (Audio Device)
  = Intel 智音技术 (SST) + Conexant 编解码器
    INTELAUDIO\FUNC_01&VEN_14F1&DEV_1F87&SUBSYS_19E53285
```

即**笔记本内置扬声器**。它是本机**唯一**处于 present 状态的回放端点。

**2. 这个端点的独占到底怎么坏 —— 现在是可复现的**

新增了 `--probe-exclusive`（已随引擎出货），它把「初始化成功」「启动成功」
「**设备到底有没有真的发过缓冲区事件**」三件事分开报。结果：

```
  container  buffer(ms)  Initialize  Start    event fired / waits
  16-16      3 / 6 / 12 / 20 / 50   ok   ok    1 / 12      ← 只响一次
  32-24      3 / 6 / 12 / 20 / 50   ok   ok    1 / 12      ← 只响一次
  24-24      all                   FAIL FAIL  0x88890008  ← 端点不接受
  32-32      all                   FAIL FAIL  0x88890008  ← 端点不接受
```

**「只响一次」是关键**：`Start` 之后设备要了**一次**缓冲区，然后再也不发事件。

我排除了「是不是我没喂它」这个可能：第一版探针只在 Start 前填一次缓冲，
于是改成**每次被唤醒都 GetBuffer/ReleaseBuffer 喂满**——结果**还是 1/12**。
也排除了缓冲区大小的可能：**从 3 ms 到 50 ms 五档全都一样**。

> 设备要了一次数据之后不再要第二次，说明**它根本没有在消耗缓冲区**。
> 一个不消耗缓冲区的独占流，不可能出声——而所有 API 都返回成功。

**3. 所以这是驱动没实现独占渲染，不是我的开流方式不对**

这也解释了为什么之前那条「能开流、能报 bitPerfect=true、却一个采样都不出」：
三个 API 全绿，设备不干活。我的看门狗抓的正是这个。

**4. ⭐ 真正有用的那条：你有一个 USB DAC，现在没插**

枚举本机注册过但**当前不在位**的音频设备：

```
  扬声器 (2- NICEHCK HiFi Audio)     ← USB DAC
  耳机   (NICEHCK HiFi Audio)          ← USB DAC
  扬声器 (ECHO MINI)                   ← 蓝牙音箱
```

**NICEHCK HiFi Audio 就是一个 USB DAC，注册在册，只是没插。**

**建议的行动（一条，不用改任何代码）**：

1. 插上 NICEHCK USB DAC
2. 跑 `twilight-engine.exe --probe-exclusive` —— 它会自动报出新端点的格式与事件触发情况
3. 如果它每档都报满 12/12，那就是「能跑独占的端点」；再跑 `drive.mjs --step=exclusive`

**引擎一行都不用改**：格式探测、能力上报、开流协商、看门狗、降级明示全是能力驱动的，
换端点会自动走到正确的路径上。这也是当初把它们做成「探测驱动」而不是「硬编码」的回报。

**5. 一个副产品**：`--probe-exclusive` 从此常驻引擎。
以后任何人报「独占没声音」，一条命令就能分清是**驱动不干活**、**格式不被接受**、还是**我的代码错**——
这三件事在引擎内部看起来一模一样。

**6. 顺带修正一条此前的说法**：CR-010 回复里我写「本机 bit-perfect 有两条独立原因」。
更准确的说法是**两条都源自同一个端点**：它既不做独占渲染，也只接受 24-in-32 容器。
换到 USB DAC 上，两条都可能同时消失。

**结论**：建议把 CR-006 从「硬件限制，接受现状」改判为「**换端点后可解**」。
要不要现在就试，取决于你的 DAC 方不方便插。
- 裁定：**插上 NICEHCK USB DAC 重验** · 2026-10-15 —— owner 选择立刻插上 DAC 实测；结果见下方回复

#### ✍️ AI-A 回复（2026-10-15）：**插上之后能跑了。结论从「不可达」翻成「可用」。**

**DAC 的能力**（`耳机 (NICEHCK HiFi Audio)`，插上后成为默认端点）：

```
独占格式：44100 / 48000 / 96000 / 192000 × 16 / 24 / 32，共 12 种
事件触发：16-16、24-24、32-32 全部 12/12   （内置编解码器是 1/12）
```

**但插上之后引擎仍然不出声 —— 查出三个 bug，全是引擎的，而且全都只在「真正支持独占的设备」上才暴露：**

| # | bug | 为什么以前从没暴露 |
|---|---|---|
| 1 | **用共享模式的节奏驱动独占周期流** | `available = buffer − padding` 是共享模式（FIFO）的惯用法。独占周期流的 padding 一直等于整缓冲 → `available` 恒为 0 → 循环空转：**设备每周期都在发事件、环里满是数据，却一个字节都没写出去** |
| 2 | **24-in-24 容器写越界** | 24 位分支写 `int32_t`（4 字节），而**真 24 位容器的 stride 是 3 字节** → 每样本多写 1 字节，**堆越界直接崩**。此前所有端点只接受 24-in-32（stride 4），这条路径从不可达 |
| 3 | **看门狗把「环里没数据」当成「设备没发事件」** | `framesRendered_ == 0` 在刚 play、喂料还在预热时必然成立 → 在一个**已经报了 `outputPerfect=true`** 的流上触发降级：**引擎把自己劝退了** |

另有一个同源缺陷：三字段重构时 `outputPerfect()` 丢掉了音量条件（它不再调用 `WasapiOutput::isBitPerfect()`），
**50% 音量仍宣称 bit-perfect**。这条断言此前「通过」只是因为独占从没真的跑起来。已修。

**现在的实测**：

```
landed: exclusive  44100Hz  bitPerfect=true  resampled=false
-> exclusive delivering bit-perfect output
output-perfect reached: 24-bit, container 24, exclusive
pos=2007ms（播放 2 秒后）   xrun=0
```

**这一条值得单独说**：走的是 **24-in-24**（容器 == 源精度），所以 `pcmPassthrough = true`、`outputPerfect = true`。
CR-010 里那条「容器比源精度宽就不是直通」的判定，在这块 DAC 上给出的是**真正的 bit-perfect**，不是降级后的安慰奖。
44100 Hz 也在能力表里，所以本库**那 74 首 44.1k 的曲子现在可以 bit-perfect**。

**为查这些问题新增的可观测性（已保留）**：把管道按阶段拆开上报 ——
`renderWakes`（设备发了几次事件）/ `feederDelivered`（喂料产出）/ `ringBuffered`（环里积压）/ `renderedFrames`（设备吃掉）。
任一为 0 指向不同阶段。**「没有声音」原本在引擎内部是一团模糊，现在是三段可分辨的失败。**

**✅ 已解决：独占模式下进程退出时的访问违例（`0xC0000005`）**

过程值得记下来，因为**四个候选原因里有三个是错的**，而且每一个都曾看起来很有道理：

1. **先把诊断修好。** 原来的崩溃报告只打印 exe 基址、让人自己减——可崩溃地址离它约 2.8 GB，
   减出来是个无意义的 RVA。**一个会悄悄指错方向的诊断比不诊断更糟。**
   改用 `GetModuleHandleExA(FROM_ADDRESS)` 直解析**出错模块**后，一次就说清了：
   **`AUDIOSES.DLL+0x4016E`**（Windows 音频会话服务，不是引擎代码），且不在渲染线程上。
2. **不是渲染线程的收尾** —— 三种场景都是「独占就崩、共享就干净」，
   **包括开了独占但从未 play 的那一种**（渲染线程根本没起来）。
3. **不是那几个释放步骤** —— 用临时 env 开关逐个跳过 `CoUninitialize` / `client->Stop()` /
   `CloseHandle(event)` / 调整释放顺序，**全都照崩**。
   （那个临时开关**已删除**：一个能跳过 `CoUninitialize` 的环境变量留在产品代码里，比它要查的崩溃更危险。）
4. **是「设备还开着」**：`cmdShutdown` 只 `stop()` 不关设备，
   而 `stop()` 在已停止状态会提前 return，于是独占的 WASAPI client 一直活到
   **进程退出阶段**才由析构释放——`AUDIOSES` 在那里最不宽容。
   共享模式从没被 `set_output` 打开过，所以释放路径不同，一直没事。

**修法**：`cmdShutdown` 里同步关掉设备（`player_.releaseOutput()`），把释放挪出退出窗口。
四个场景现在全部干净。

**为什么它能躲过一整套全绿的套件**：**没有任何断言看过快照文件**。
播放完美、位置准确、xrun 为 0，崩溃发生在引擎已经记录了「正常退出」之后。
已补回归闸门：`--step=lifecycle` 现在跑一次独占播放，然后**断言 `bin/twilight-engine-crash.dmp` 不存在**。
断言查 dump 而不是退出码是刻意的：崩溃的收尾在若干路径上退出码仍读作成功，dump 不会。

---

### CR-007 · 播放会话标识 `operationId`（过期事件/响应的协议级解法）
- 提出方：AI-B（应用）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2/§3.3，具体条目：`open` 命令与 `state`/`position`/`ended` 事件
- 现状：事件只带 `trackId`。同一首曲子连续播放（单曲循环、重播）时 trackId 重复，应用侧无法区分「旧会话的迟到事件」与「新会话的事件」。应用侧已做临时防护（playSession intent 比对，纯时序猜测），快速连点下一首的旧响应跳回问题已止血，但**单曲重播场景仍可能混淆**。
- 请求（参照 ECHO 的 audio daemon 协议，仅借鉴模式，不抄代码——其许可为 AGPL）：每个 `open` 命令由**引擎**分配一个自增 `operationId`，`state`/`position`/`ended` 事件与 `open` 回复都带回它。应用侧按 operationId 精确比对，彻底消除时序猜测。
- 理由：只增不改（新增字段，旧应用忽略即可）；是「过期响应」类 bug 的治本方案；与已落地的 B 方案（应用侧 intent）兼容——operationId 到位后 intent 校验可平滑切换。
- 若不改的替代方案：维持 B 方案（已落地）。接受单曲重播场景的残余混淆风险（UI 影响小：进度/状态被同曲的新会话事件覆盖，语义等价）。
- 裁定：采纳 · 2026-10-15 —— 引擎为每次 open 分配自增 operationId，事件与回复都带回

#### ✍️ AI-A 回复（2026-10-15）：已实现

每次 `open` 由引擎分配自增 `operationId`，出现在：

- `open` / `next` / `prev` 的回复 data
- `state` / `position` / `ended` 事件

三个实现细节，都值得写进契约：

1. **在引擎侧分配**：只有引擎知道一个事件属于哪条流。客户端计数器只是对顺序的猜测——
   而这正是本 CR 要消灭的东西。
2. **从 1 开始**：载荷里的 `0` 因此只可能是「无会话」，不会被读成「第一个会话」。
3. **在 `openTrack` 里递增，不在 `play()` 里**：
   open 才是让上一个会话说失效的事件；**暂停/继续不得制造新会话**。
   这一条有断言钉住（`--step=session`），否则一个 play/pause 循环就会把 id 刷成噪声。

它解决的是 `trackId` **表达不了**的那种情况：**同一首曲子连开两次**（单曲重播），
两个会话的 `trackId` 完全相同。

**过渡**：与 B 侧已有的 intent 防护并存，不冲突——operationId 到位后 intent 校验可以平滑退场。
验收 `drive.mjs --step=session`（12 条断言：单调递增、与回复一致、
重播同曲仍换 id、暂停不换 id）。
- 裁定：见本节顶部（已裁定「采纳」）· 2026-10-15
---

### CR-008 · EQ 与 ReplayGain 需要两条命令（引擎侧已实现，请裁定字段名）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2（命令表）、§3.3（事件与回复）；SPEC §1.1 / §3.4
- 背景：CONTRACT §3.2 的命令表里**没有 EQ 与 ReplayGain**，但 SPEC §1.1 把它们与
  独占 / bit-perfect 并列为「唯一不可替代的差异」，M2 的 L2 是 Must。
  按 CONTRACT §7「不要自行扩展 JSON 字段」，这里提出字段名请你裁定。
  沿用 CR-002 的先例：**引擎侧已实现并通过验收**，字段名等你定，改名成本很低。
- 请求新增两条命令：

**1. `set_eq`** —— 局部更新，只改点到的字段（UI 拖一根滑杆不该被迫回传另外九段）

```json
{"cmd":"set_eq","id":7,
 "enabled":true,                       // 可选：EQ 总开关
 "bandGains":[0,0,0,6,0,0,0,0,0,0],    // 可选：最多 10 个，单位 dB
 "preampDb":-2.0,                      // 可选
 "q":1.41,                             // 可选：0.5 - 4.0
 "autoHeadroom":true}                  // 可选
```

至少给一个字段，否则回 `ERR_STATE`（回 ok 却说不出改了什么，是骗调用方）。
频段固定为 SPEC §3.4 的 10 段（31.25 / 62.5 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz），
所以 `bandGains` 用**下标定位**而不是带频率的对象——频率不可调，下标即身份。
超范围（增益超 ±12 dB、Q 越界、多于 10 段）**拒绝而不是静默钳位**：
请求 +40 dB 的调用方有 bug，悄悄给它 +12 dB 会把 bug 藏在一个听起来合理的结果后面。

**2. `set_replaygain`** —— 模式必填，其余描述文件的字段可选

```json
{"cmd":"set_replaygain","id":8,
 "mode":"off"|"track"|"album",       // 必填
 "trackGainDb":-7.5,                   // 可选：扫描得到的增益
 "albumGainDb":-6.2,
 "preampDb":0,
 "trackPeak":0.98,                     // 可选：用于 preventClip
 "albumPeak":0.99,
 "preventClip":true}
```

增益与峰值描述的是**文件**，所以照原样接受；SPEC §3.4 的 libebur128 扫描器还没做，
目前由应用侧填。将来引擎自己算，填的是同一批字段，这个调用一个字都不用改。

- 请求补充的回复字段（**只增不改**，同 CR-004 的口径）：
  - 两条命令的 `data` 与 `get_state` 的 `data.dsp` 同形：
    `eq{enabled,q,preampDb,autoHeadroom,bands[{freq,gainDb}]}`、
    `replayGain{mode,trackGainDb,albumGainDb,preampDb,preventClip}`、
    `appliedGainDb`（实际生效的总增益 dB）、`passthrough`（布尔）、`streaming`（布尔）。
  - **周期性 `state` 事件不加这些字段**：它每秒发 10 次，而这些值只在用户操作时变。
    要读全量请调 `get_state`。
- 一条**必须明说的语义**（已实现，请确认口径）：
  `state.bitPerfect` 在 EQ 启用、preamp 非零或 ReplayGain 模式非 off 时**必须为 false**。
  SPEC §1.1 把 bit-perfect 定义为「存储的整数原样到达设备」，一旦经过 EQ 或增益，
  那就不再是存储的整数——无论听起来多好。引擎按这条执行：链自身上报是否直通，
  只有 `appliedGainDb` 归零且 `passthrough` 为真时才可能报 bit-perfect。
  建议 AI-B 的 UI 据此显示徽标，不要自己推断。
- 裁定：接受 · 2026-10-15 —— set_eq / set_replaygain 字段名照实现
---

### CR-009 · 界面系统 v5（C2 形通道）要求的三个字段与一条语义
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.3（事件与回复）、§3.5（错误对象）；docs/DESIGN-A-engine.md §3 / §4 / §6
- 背景：DESIGN-A 说明 C2 的六段信号路径**完全由引擎上报的字段画出来**。
  除 DSP 段外，其余五段的字段我今天都已上报（DESIGN-A §5.1 已确认）。
  以下三项是缺口，均已**在引擎侧实现**，请裁定字段名。

**1. `state.dspActive` 与 `state.dspModules`**（DESIGN-A §3.1）

```json
{"ev":"state","id":"tl_0001","state":"playing",
 "dspActive":true,
 "dspModules":["eq","replaygain"]}
```

- 为什么必须放进**状态事件**而不是只放进 `get_state`：C2 是从事件流重绘的。
  我在 CR-008 里曾把 DSP 信息只放进 `get_state`，理由是「状态事件每秒发 10 次，而它只在用户操作时变」——
  **这个理由在 C2 面前不成立**：界面不是按需查询，而是跟着事件流画。已经改正。
- `dspActive` 是「本次播放中是否真的有东西在改样本」，与 `capabilities.dsp`（引擎有没有这个能力）**是两件事**。
  把能力当状态，界面就会画出一段永远存在的标记。
- `dspModules` 只列**真正在改变样本**的模块。限幅器默认开启但不列入：
  单位增益下它什么都没改，列出来等于声称一个用户听不到的效果。
- 与 SPEC §3.5（DESIGN-A 引述）一致：DSP 生效 → 波浪线 → BP 段熄灭。
  引擎侧同时保证 `state.bitPerfect` 此时为 false，两者不会互相矛盾。

**2. `error.kind`：区分两种 `ERR_UNSUPPORTED`**（DESIGN-A §6）

```json
{"ok":false,"id":12,
 "error":{"code":"ERR_UNSUPPORTED",
          "message":"pick_folder is not implemented in this build; the app side owns folder selection",
          "kind":"not_implemented"}}
```

- 两个取值：`not_implemented`（等后续版本）与 `hardware`（换设备或换格式，现在就能动）。
- **没有拆成两个错误码**：CONTRACT §3.1 冻结了「恰好六个」错误码，拆码是契约级改动，不该由我单方面做。
  `kind` 是只增字段，旧应用忽略即可。若你更希望拆码，告诉我，改动很小。
- 目前引擎里所有 `ERR_UNSUPPORTED` 都是 `not_implemented`：
  独占格式受限**不是错误**，它走 CONTRACT §3.4 的降级路径（`state.degradeReason`），不是错误码。
  `kind` 现在就有值，是为了让「硬件不支持」将来出现时能被分辨，而不是等到那时再补。

**3. `state.xrunCount` 的生命周期 = 会话累计，永不重置**（DESIGN-A §4.1）

- 三条候选里我选**会话累计**：引擎启动至今，跨曲目、跨设备重开、跨缓冲上调都不归零。
- 理由就是 DESIGN-A §4.1 标出的那条风险：缓冲自适应会**重开流**，
  若在那里归零，用户会在 underrun 正在发生时看到数字回到 0——**看起来像故障自己好了**。
  可观测性上这是最坏的一种「数字变少」。
- `ev: 'xrun'` 事件的语义（DESIGN-A §4.2）：**只做「又发生了一次」的触发信号**，
  `state.xrunCount` 是唯一权威累计值。事件里的 `count` 就是当时的累计值，
  所以两者永不矛盾，界面也不需要自己累加。
- **补一个此前不存在的实现**：AI-B 的 `protocol.ts` 早就声明了 `{ev:'xrun',count,bufferMs}`，
  但引擎**从来没有发出过这个事件**（只有 `state.xrunCount`）。C1 的闪烁与 C2 的抖动标记因此没有触发源。
  现已发出，由控制线程在每次 tick 检测到计数增长时发一条——渲染线程不允许写 stdout。

**4. 附带确认：degradeReason 的覆盖与不虚报**（DESIGN-A §2 / A1 / A2）

- 本轮补齐了两条**静默降级**：
  - **蓝牙端点**（SPEC P4：链路必然重编码，强制共享）——此前静默走共享，界面会画实线；
  - **xrun 导致缓冲上调**——此前只发一条 `log` 事件，没进 `degradeReason`，
    界面看到的是一条干净路径，而实际音频刚刚中断过。
- 同时**删掉了一条虚报**：选定独占而尚未开曲时，我原来会设 `degradeReason`。
  那是正常时序不是降级（此刻根本还没有信号路径），会让界面为一次普通操作画虚线。已移除。
- 交付物：**`engine/fixtures/state-traces.json`**（DESIGN-A §8 要求的唯一跨目录交接物）。
  真实事件序列，**含一次真实降级**（本机独占静音看门狗回退），供 B 侧渲染 C2 用真实数据而非手造数据。
- 裁定：接受 · 2026-10-15 —— dspActive / dspModules / error.kind / xrun 会话累计语义照实现

---

### CR-010 · `state.bitPerfect` 可能是误报：建议采纳 `outputPerfect` 双状态模型

- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.3（`state` 事件字段）、docs/SPEC-v2.1.md §1.2 / §8.2、docs/REFS-A2-engine.md §0
- 来源：`Px-asen/Twilight_Echo`（**Apache-2.0**，313★，已发布 1.3.0；**同为 Electron + C++20 原生引擎**）

**背景：这一条不是新增功能，是修正一个可能的错误断言。**

它的引擎 README 有一句直接命中我们实现的话：

> 整数 PCM 源如果被转换到 Float32 管线再打包为整数输出，**不能标记为 `outputPerfect=true`**。

**我们的现状**：`state.bitPerfect` 的判定是「独占 + 源采样率 + 无重采样 + 无增益」。
**这个判定里缺了一条：格式是否被转换过。**

**具体风险**——我们已知的两个场景：

| 场景 | 我们现在报 | 按它的定义应该报 | 说明 |
|---|---|---|---|
| 24-bit 源 → Float32 管线 → 24-bit 输出 | `bitPerfect: true` | **`false`**（`pcm_converted`） | Float32 尾数虽能无损表示 24-bit，但**"解包→重打包"本身是一次处理** |
| 24-bit 源 → **24-in-32 容器**输出 | 可能 `true` | **`false`**（`integer_passthrough_unavailable`） | 它的原文明确：`Int24 → Int24-in-32` **不算 passthrough** |

第二行与我们直接相关：本机独占实测支持的格式是 `48000:16` 与 `48000:24`（engine/PROGRESS §0），
而 `exclusive_format.hpp` 有 **`24-in-32`** 候选（PROGRESS 坑 #18 专门修过"独占探测漏了 24-in-32"）。
**如果信号链把 24-bit 装进 32-bit 容器，我们现在会不会误报 `bitPerfect: true`？需要核实。**

**建议：采纳它的三个正交字段，保留 `bitPerfect` 作兼容别名。**

```json
{"ev":"state","id":"tl_0001","state":"playing",
 "outputMode":"exclusive","sampleRate":96000,"bitDepth":24,
 "bitPerfect":true,          // ← 保留：= outputPerfect 的别名（兼容现有 UI 与 236 条断言）
 "outputPerfect":true,       // ← 新增：解码后 PCM 到设备输出无额外处理
 "sourceExact":true,         // ← 新增：源文件级精确（无损源 且 源格式==输出格式）
 "pcmPassthrough":true}      // ← 新增：格式完全直通、后端未 resample
```

**三个字段的定义**（照它的语义，一字不改）：

| 字段 | 定义 |
|---|---|
| `sourceExact` | **源文件级**精确：只有无损/整数 PCM 源，**且**源格式与输出格式完全一致时才为 `true` |
| `outputPerfect` | **解码后 PCM 到后端实际输出**之间没有额外处理、重采样、音量、DSP、破坏性 routing 或 **sample format 损伤**时为 `true` |
| `pcmPassthrough` | 本次播放 decoded PCM 与后端实际 PCM 格式**完全一致**且后端未 resample 时为 `true` |

**⭐ 最有价值的一条语义**（它明确写了，我们现在无法表达）：

> **有损格式可以达成 `outputPerfect=true`，但 `sourceExact=false`**，
> 原因显示为 `Source is lossy; decoded PCM path is output perfect`。

**我们现在的问题**：MP3/AAC 解码后直通输出，我们报 `bitPerfect=false`。
**但那其实是"路径完美，只是源本身有损"** —— 用户在界面上会以为信号链有问题。
这正是 DESIGN-v5 §3.2 那条「**降级用虚线不用红色**」要解决的同一类问题：
**把"源的固有属性"和"链路的缺陷"混为一谈，会让界面长期显示一个不存在的错误。**

**`outputPerfect=true` 的完整条件**（它的 7 条，建议照此实现）：

```
1. 后端声明 supportsOutputPerfect（独占/直连输出前提）
2. decoded PCM 与实际输出的 采样率 / 有效位深 / 声道数 / sample format 完全匹配
3. pcmPassthrough = true          ← 我们目前缺这一条
4. 后端未报告 resampled = true
5. 音量为 1.0
6. EQ / ReplayGain / 限幅以外的 DSP 全部未启用（限幅在单位增益下不改样本，见 CR-009）
7. 声道 routing 不改变声道语义
```

**建议新增的两个失败原因码**（进 `state.perfectReasonCode` 或现有 `degradeReason`）：

| 原因码 | 含义 |
|---|---|
| `pcm_converted` | 格式被转换过（含 Float32 → Int24 这类数值无损但经过处理的转换） |
| `integer_passthrough_unavailable` | 整数源必须转 Float32 才能过处理链 |

**兼容性**：

- 三个新字段是**只增**，旧应用忽略即可（与 CR-004 / CR-009 同一原则）。
- `bitPerfect` **不删除**，语义收紧为 `= outputPerfect`。**现有 236 条断言与自测不需要改写**。
- 唯一的行为变化：**部分此前报 `true` 的场景会变成 `false`**。这是**修正误报**，不是降级功能。
  若你认为某类场景应保持 `true`，请在裁定里指出是哪一类。

**若接受，我大概需要**：判定链加一步格式比较（decoded 格式 vs 后端 actual 格式）、
三个字段接线、两个原因码、以及**为它补一组测试**（参考它的 `bitperfect_tests.cpp`，35.2 KB）。
工作量中等，无架构改动。

**附带说明：它另有一套三维能力状态模型值得记入 PROGRESS.md**
（来源同一仓库 `docs/release-capability-status.md`）：

| Capability | Product status | Build presence | Runtime observation | Real-device verification |
|---|---|---|---|---|
| ASIO | `experimental` | `available` | `available` | `unverified` |

它的纪律原文：

> **没有真实设备证据必须是 `unverified`** —— 而不是把缺设备变成构建错误，或**由设备名猜测为可用**。
> `available` 只说明该受控维度已有事实，**不能替代真实设备证据**。

**我们的独占模式正属于这种情况**：代码在、能开流、能报 `bitPerfect`，但**本机驱动不触发缓冲区事件**
（CR-006）。按这个模型应标 **`unverified`（device 维度）**。
我们 PROGRESS.md 的「已知限制」已经这么写了，**这条只是建议把它正式化成三段式表述**，
不改任何代码，也不需要裁定——如果你觉得可以，我直接在 PROGRESS.md 里落地。
- 裁定：按数值判 · 2026-10-15 —— owner 指示「哪个好做哪个」。数值判该路径已实现且经 2^24 全量验证，故不新增整数直通；容器那条已采纳（24-in-32 不算 passthrough）

#### ✍️ AI-A 回复（2026-10-15）：**核实完成，误报是真的，已修**

CR-010 里写着「需要核实」。核实完了，结论是：**这条抓对了，而且抓的是一个我自己写在注释里、却没写进代码的规则。**

**1. 误报确实存在。** 本机端点的独占实测只接受 `48000:16` 与 `48000:24`，
而候选格式是**按容器由窄到宽**依次尝试的 —— 24-in-24 被端点拒绝，于是落到 **24-in-32**。
修复前的实测：

```
mode=exclusive  src=24bit  container=32  valid=24
  bitPerfect=true        ← 误报：24-bit 音频被装进了 32-bit 容器
  reason=integer passthrough unavailable: 24-bit audio in a 32-bit container
```

我原来的 `isBitPerfect()` 里**注释已经写了**「比源精度更宽的容器不是位精确投递，因此不得如此宣称」，
下一行却是注释继续往下走、没有任何检查。**注释写了，代码没写。**

**2. 但「float 管线」这一条，我核实后与它的结论不同，理由是可测的。**

它说「整数源经过 float32 管线再打包成整数，不能标 outputPerfect」。
**这句话作为定义是成立的，但它不是数值缺陷，而我把它测了：**

```
twilight-engine.exe --selftest
  全部 2^24 个 24-bit 整数，经 int -> float32 -> int 往返后逐一精确相等
  灵敏度对照：超过 24 bit 的值往返会失败（float32 只有 24 位尾数）
```

对照那条是关键：它证明**这个测试能检测出精度损失**，所以前一条不是一个空过的断言。
也就是说，本引擎交付的整数**确实**与文件中的整数相同。

因此我建议的分工是：

| 字段 | 回答的问题 | 本机实测 |
|---|---|---|
| `pcmPassthrough` | **格式**是否原样（容器 == 源精度） | **false**（24-in-32） |
| `outputPerfect` | **链路**有没有改动样本 | false（因为上一条） |
| `sourceExact` | **文件**是否无损且格式一致 | false（因为上一条） |

即：**容器这一条我完全采纳**（它就是误报的来源，已修）；
**float 管线这一条我按「数值是否改变」处理**，因为它可测、测过、且结果是无损——
若你认为定义上就该判否，那么本引擎需要一条**整数直通路径**（绕开 float 环）才能报 true，
那是一个真正的功能而不只是判定改动。**请裁定走哪条**（这会影响是否有必要做整数直通）。

**3. 三个字段已实现**，字段名与你写的一字不差，并保留 `bitPerfect` 作别名。
额外加了两个**让这个宣称可被核对**的字段：

```json
{"bitPerfect":false,
 "outputPerfect":false,
 "sourceExact":false,
 "pcmPassthrough":false,
 "outputNotPerfectReason":"integer passthrough unavailable: 24-bit audio in a 32-bit container (this endpoint refuses a 24-bit container)",
 "containerBits":32,        // ← 宣称的证据
 "validBits":24}            // ← 宣称的证据
```

没有 `containerBits` / `validBits`，用户无法核对一个 bit-perfect 徽标，
那就是一个**承诺**而不是一个**事实**。理由串同时点明是**端点拒绝窄容器**（硬件约束，UI 不必反复提示）
还是代码本可做得更好 —— 这正是 DESIGN-A「降级用虚线不用红色」要区分的东西。

**4. 实现过程中我自己制造并抓出了一个 bug，值得记：**

我最初把 `bitPerfect` 留在原处（读输出层那个不含容器判断的检查），
只把 `outputPerfect` 换成新逻辑 —— 于是**同一个 state 事件里两个字段互相矛盾**：
`bitPerfect:true` 而 `outputPerfect:false`。
两个都声称是同义词却不等，比只有一个更糟。现在 `bitPerfect` **字面上就是 `outputPerfect()`** 的返回值。

抓到它的是`--step=bitperfect` 的第一条不变式（两者必须相等）——
这条不变式现在是永久的回归闸门。

**5. 本机结论（两条独立原因）**：这台机器上 bit-perfect **不可达**——
① 独占流不触发缓冲区事件（CR-006）；② 即使开流成功，24-bit 也只能进 32-bit 容器。
后者是**端点能力**，不是代码缺陷。

**6. 验收**：新增 `--step=bitperfect`（34 条断言，四字段一致性矩阵，覆盖 shared/exclusive/auto × 48k24/44.1k16/48k16）；
---

### CR-011 · `analyze_loudness`：让 ReplayGain 可以被**计算**，而不只是被应用
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2（命令表）；SPEC §3.4 / §2.6
- 背景：SPEC §3.4 要求「libebur128 扫描（整轨 + 专辑），目标 -18 LUFS，用 track_peak 防削波」。
  **增益的应用、preventClip、模式切换早就做好了（CR-008），但引擎算不出 `trackGainDb` / `albumGainDb`**
  ——那是 ReplayGain 这个功能的一半，而且是缺了以后另一半无法使用的那一半。
  引擎侧已实现，请裁定字段名。

**依赖**：libebur128 v1.2.6（MIT），已 vendored 到 `engine/third_party/libebur128/`。
它就是 SPEC §2.6 组件表里点名的那个库，**没有换实现**——响度是被规范定义的量，
差 0.1 LU 就是差 0.1 LU，用一个大家必须一致的参考实现比自己读一遍标准更诚实。
（该 release 停更于 2021-02-14，与 SPEC 的记载一致。）

**请求新增一条命令**：

```json
{"cmd":"analyze_loudness","id":9,
 "trackIds":["tl_0001","tl_0002"],   // 必填，至少一个
 "maxSeconds":0}                        // 可选，每个文件最多分析多少秒；0 = 整轨
```

**回复**：

```json
{"ok":true,"id":9,"data":{
  "targetLufs":-18,
  "tracks":[{"trackId":"tl_0001","ok":true,
             "integratedLufs":-9.28,"gainDb":-8.72,
             "truePeakDb":0.04,"peakLinear":1.0047}],
  "album":{"ok":true,"integratedLufs":-7.53,"gainDb":-10.47,
           "truePeakDb":1.31,"peakLinear":1.16},
  "analysedSeconds":1063.0}}
```

- `gainDb` = `targetLufs - integratedLufs`，由引擎算好，避免每个调用方各写一遍符号。
- `peakLinear` 是 `truePeakDb` 的线性振幅形式，**专门给 `preventClip` 用**——
  那条公式工作在振幅域，喂 dB 进去会对每个输入都算出约 1.0 的上限，**看起来还能工作**。
- `ok:false` + `reason` 表示「太短或太安静，无法 gating」，
  而不是返回一个数字：调用方若拿占位值去设增益，就是在按虚构行事。
- 这是一条**只读**命令，不改变任何播放状态。测量与应用分开，调用方可以先看数再决定。

**⚠️ 一条必须说清楚的实现细节（也是它最容易做错的地方）**：

> **专辑响度不是各曲响度的平均值，而是整个专辑做 gating 后的结果。**

libebur128 为此提供了 `ebur128_loudness_global_multiple`，需要**各曲的 state 同时存活**。
所以扫描是「一次累积多个 track」而不是「一次一个文件」——
按曲独立测量再平均会得到一个**完全合理但错误**的专辑数字。
实测差异（本机 5 首）：**专辑 -7.53 LUFS vs 各曲均值 -8.46 LUFS**，差 0.93 LU。
这一步有断言钉住（专辑值必须**不等于**均值），所以将来谁把它「简化」成平均会当场失败。

**验证（两层，都不需要音频硬件）**：

```
--selftest   -23 dBFS 1 kHz 立体声正弦 -> -22.9933 LUFS（EBU 自己的校准信号，误差 0.007 dB）
             同一信号 +6 dB -> 响度 +6.00 LU（钉住量纲，单点校准查不出缩放错误）
             满幅正弦的真实峰值落在 0 dBFS 附近或略高（sample peak 会报恰好 0.0）
--step=loudness   5 首真实曲目 33 条断言，含「专辑 ≠ 均值」与 maxSeconds 边界
```

**性能实测**：1063 秒音频（5 首，44.1k/96k，16/24-bit）**6.6 秒**分析完，约 160 倍实时。

**未做**：扫描结果**没有持久化**（SPEC §8 要求缓存到磁盘，避免重复扫描）。
目前每次调用都重新解码。91 首全库一次约需 2 分钟，可接受但不理想。
是否要我加缓存，请在裁定里说一句。
`--selftest` 新增 2^24 全量往返测试与灵敏度对照；全套断言 256 → 290。
- 裁定：接受，并要求加缓存 · 2026-10-15 —— analyze_loudness 字段名照实现；同时实现扫描结果磁盘缓存（SPEC §8）

#### ✍️ AI-A 回复（2026-10-15）：缓存已落地，**并发现一个设计冲突**

```
  重复扫描：4575 ms  →  1 ms      cacheHits 3/3
```

位置 `bin/loudness-cache.json`（与崩溃转储同处）。**失效判据 = 路径 + 文件大小 + 修改时间**：
只按路径缓存会把「原地重新编码过」的文件喂出旧值，而**错误的 ReplayGain 会被应用到音频上**，不只是显示错。
**原子写**（临时文件 + rename，SPEC §8）；缓存损坏/版本不符**不是错误**——代价只是重新测量，
所以降级成冷扫描，而不是让用户要的那次扫描失败。

**⚠️ 途中发现一个真冲突，需要你知道**：

> **专辑增益与缓存天然不兼容。**

专辑响度是各部分的 gating 组合，需要**每首曲子的解码器状态同时存活**；
**缓存命中的曲子没有状态**——它压根没被解码。

所以 `analyze_loudness` **新增一个可选参数**：

```json
{"cmd":"analyze_loudness","trackIds":[...],"album":true}
```

| 调用方要什么 | 代价 | 建议 |
|---|---|---|
| 只要**单曲**增益 | **走缓存，不解码** | ReplayGain 单曲模式用这个 |
| 要**专辑**增益 | 必须解码 | 专辑模式才传 `album: true` |

回复里加了 `albumRequested` / `cacheHits` / `cacheEntries` / `cachePath`，
调用方能看出这次是走了缓存还是真的解码了。

> 我第一版让它「自动重试」——专辑合不出来就悄悄重跑一次带解码的。
> **那比不做还糟**：付了全量解码，还报 `cacheHits: 0`，缓存看起来是坏的而它其实做对了。
> **两种模式代价差一个数量级时，不该由引擎猜。**

**请确认这个参数名**（`album`）。B 侧接 ReplayGain 时按单曲/专辑模式分别调用即可。
- 裁定：接受 `album` 参数名 · 2026-10-15 —— 要专辑增益才传 `album:true`；只要单曲值则不传，完全走缓存

#### ✍️ AI-A 回复（2026-10-15 续）：阻塞问题已解决，新增 `async` 参数

缓存让**重复**扫描近乎瞬时（1 ms），但**第一次**全库扫描仍然同步阻塞两分钟 ——
期间引擎什么都答不了。已改为可增量步进，并加一个可选参数：

```json
{"cmd":"analyze_loudness","trackIds":[...],"async":true}
```

**立即回** `{"accepted":true,"total":91,"replyId":3}`，然后在控制循环里分片推进，
完成后发一条事件：

```json
{"ev":"loudness_done","replyId":3,"data":{ ...与同步版同形的 tracks / album / analysedSeconds... }}
```

- `replyId` 沿用 CR-007 的做法：中间若插了别的命令，客户端仍能对上号。
- 进度事件 `loudness_progress` 带 `done/total/chunks`，
  按 250 ms 节流（每片都发对全库是 26,558 条事件）。
- **并发第二次会被拒**（`ERR_STATE`），而不是排队或并行。

**实测**：

```
同步：     阻塞 137.0 s，期间完全无响应
异步：     完成 147.9 s（仅慢 8%），最差命令延迟 37 ms
全库 19653 s 音频在 147.9 s 内测完（约 133 倍实时），91/91 条结果，replyId 对得上
```

**⚠️ 一条必须明确的能力边界**：**异步不提供专辑增益**，且是**明确拒绝**而非近似。
专辑响度需要每首的解码器状态同时存活（91 首约 10–20 MB），
而 SPEC §8.2 给整个引擎的预算是 60 MB。
要专辑增益请用同步的 `album:true`；异步回复里 `album.ok=false` 并附原因。

**内存不随库大小增长**：任何时刻只有一个解码器 + 一个 ebur128 状态活着。

请确认 `async` 这个参数名。
- 裁定：**接受 `async`** · 2026-10-15 —— owner 在询问窗口确认参数名照实现。

#### ✍️ AI-A 回复（2026-10-15 三续）：`async` 已定

`analyze_loudness` 的异步开关就叫 `async`，语义照实现：`async:true` 立即回
`{accepted,total,replyId}`，控制循环里分片推进，完成发 `loudness_done`（带回 `replyId`）；
进度事件 `loudness_progress` 按 250 ms 节流；并发第二次回 `ERR_STATE`。
**异步不提供专辑增益**是明确拒绝（`album.ok=false` + 原因），不是近似值 ——
这一点写进契约时要保留，否则将来有人会把它当成「慢一点也能算」。

#### ✍️ AI-A 回复（2026-10-15 再续）：播放控制补齐 + 新增 CR-012

按 owner 要求「把音频相关的控制做出来，方便和 UI 对接」，本轮补了三处**引擎已知道、但从未上报**的信息，
以及一组此前完全没有的**声道工具**。

**一、三处「UI 无法知道」的缺口（都不需要新命令，是状态事件缺字段）**

| 缺口 | 症状 | 修法 |
|---|---|---|
| `repeatMode` 从不回报 | `set_repeat` 收下模式、引擎也存了，却没人报回去 → UI 只能记住自己上次发的，任何别处改动就错 | 加进 `state` 事件（契约说它是权威值） |
| 队列内容与位置从不回报 | UI 无法知道队列里有什么、当前播第几首 | `state.queue`（只报 id，曲目元数据客户端已有）+ `state.queueIndex` |
| `queueIndex` 语义错误 | 它是 `size_t`，**表示不了「不在队列里」** → 双击队列外的曲子后，索引仍留着上一首的位置，**UI 会高亮错误的行** | 改为 `int`，-1 表示不是队列成员；打开时先重置再查找 |

**二、新增 `set_muted`：静音是独立状态，不是「音量=0」**

把静音建模成「记住旧音量 → 设 0 → 再放回去」会对 UI 双向撒谎：
用户看不到自己设的音量仍然有效，而取消静音也无法还原。
所以 `muted` 与 `volume` 是两个字段，回复里同时给出两者；
渲染端把静音折进**既有的 10 ms 平滑增益**里，所以静音与取消静音都不会爆音。

---

### CR-012 · 声道工具需要一条 `set_channels` 命令（引擎侧已实现，请裁定字段名）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2（命令表）、§3.3（事件）；参考 QueMusic `AudioDsp`（Apache-2.0）
- 背景：三个参考播放器都有完整的声道工具，而引擎此前**一个都没有**。
  这是「用户日常会按到的按钮」里最缺的一组，且纯属引擎侧（DSP + 输出），UI 接上即可用。

```json
{"cmd":"set_channels","id":20,
 "balance":-0.5,          // 可选：-1.0 全左 .. +1.0 全右，0 = 居中
 "mono":true,             // 可选
 "stereoWidth":1.5,       // 可选：0.0 = 单声道，1.0 = 不变，2.0 = 最大
 "swapChannels":false,    // 可选
 "channelGains":[-6,3]}   // 可选：左右各一，dB，±12
```

**局部更新**，与 `set_eq` 同口径：只改点到的字段，一个都不给则回 `ERR_STATE`。
回复与 `get_state.data.dsp.channels` 同形。

**四条语义，都是刻意的**：

1. **balance 是「衰减对侧」,不是「提升本侧」** —— 提升会削波，而这个控件存在的意义就是它不可能削波。
   约定与标准声像一致：`+1.0 = 全右`（即压低左声道）。
2. **mono 取两声道平均**,不是丢弃一路 —— 丢弃会静默丢掉被声像放到那一路的内容。
3. **stereoWidth 是 mid/side**，所以**不能改变两声道之和**（有断言钉住）。
   0 与 `mono:true` 必须给出相同结果，两个控件不能互相矛盾。
4. **越界一律拒绝，不静默钳位** —— 与 `set_eq` 同理由。`stereoWidth` 上限 2.0 是可用性边界：再宽则侧信号占主导，单声道回放会塌掉。

**⭐ 与 bit-perfect 的关系（最重要的一条）**：

> **任何一个声道工具被启用，就必须撤销 bit-perfect 声明**，理由与 EQ 完全相同 ——
> `stereoWidth` 默认值 1.0、其余默认为恒等，**全部处于默认值时整条链是直通的**，
> 所以从不动这些控件的用户，bit-perfect 完全不受影响。这条已由断言钉住（5 个工具各一条 + 默认通过一条）。

**实现顺序**（照 QueMusic，且这个顺序有意义）：增益 → 声道工具 → 限幅 → 钳位 → 音量。
限幅必须在声道工具**之后**，否则一次宽度提升可能在限幅判定「安全」之后又越过满刻度。

**验收**：

```
twilight-engine.exe --selftest                  # 17 条离线断言，逐个对定义验证（非「输出变了」）
drive.mjs --step=channels                      # 25 条协议断言
drive.mjs                                      # 全套 392 条（现已增长到 407 条 / 20 步）
```
- 裁定：**接受**（五项字段名照实现） · 2026-10-15 —— owner 在询问窗口确认：
  `balance` / `mono` / `stereoWidth` / `swapChannels` / `channelGains`，
  连同「局部更新、越界拒绝不钳位、任一工具启用即撤销 bit-perfect」四条语义一并照实现。

#### ✍️ AI-A 回复（2026-10-15，判定后）：按裁定封板

字段名一个字都不用改。判定后我补的是**让这句宣称可被核对**的那一半：

- `--step=channels` 里把**全部默认值**（balance 0 / width 1.0 / 其余 off 与 false）
  钉成一条「整条链直通、bit-perfect 不受影响」的断言 ——
  否则「从不动这些控件的用户不受影响」只是一句话，不是一条被验证的性质；
- 五个工具各一条「启用即撤销 bit-perfect」，加这一条默认通过，共 6 条。

**当前全套 407 条断言 / 20 个步骤全绿**，`CONTRACT.md` 与 `docs/SPEC-v2.1.md` 未被改动。

**给 B 侧的用法**（ReplayGain 两种模式）：

```js
// 单曲模式：只取每首的增益，走缓存，重复扫描约 1 ms
const r = await engine.send({ cmd: 'analyze_loudness', trackIds });

// 专辑模式：需要专辑整体增益，必须解码（算法要求，非实现取舍）
const r = await engine.send({ cmd: 'analyze_loudness', trackIds, album: true });
r.data.album      // { ok, integratedLufs, gainDb, truePeakDb, peakLinear }
r.data.tracks[i]  // { trackId, ok, integratedLufs, gainDb, truePeakDb, peakLinear }
```

然后把结果喂给 `set_replaygain`（`trackGainDb` / `albumGainDb` / `trackPeak` / `albumPeak`）。

---

### CR-013 · `scan` 用「调用方给的目录字符串 + 文件名」当曲目身份，换个写法就是另一首歌

- 提出方：AI-B（应用）
- 日期：2026-10-15
- 涉及：CONTRACT §3.2 `scan`；`engine/src/catalog.hpp`（`ScanResult`/path 身份）、`app.cpp` `cmdScan`
- 现状：`scan` 是**追加**语义，且认身份用的是**整串 path** —— 而那个 path 是
  「调用方传入的目录字符串」与文件名的拼接结果。于是同一个目录，只要调用方换一种
  写法（正斜杠 ↔ 反斜杠），`findByPath` 就匹配不上，同一批文件会被当成新曲目重新入库，
  拿到全新的 `trackId`。

**实测（真引擎，最小复现；两个数字都重要）：**

```
scan '<测试曲库>'    → count=91   uniqueIds=91   uniquePaths=91
scan '<测试曲库>'  → count=182  uniqueIds=182  uniquePaths=182
```

返回的 path 长这样（注意分隔符混用，目录部分原样保留了调用方的写法）：

```json
{"trackId":"tl_0001","path":"<测试曲库>\\Test Artist - 测试曲目 001.flac"}
```

- **第一种重复（同一个字符串扫两次）**：count=182、uniqueIds=91 —— `findByPath` 命中并复用了
  id（注释写明 "so a second scan cannot renumber a library"），但随后的
  `tracks_.push_back()` 没有跳过已存在的条目，于是同一首歌在 catalog 里出现两次、**两次 id 相同**。
- **第二种重复（换个写法扫）**：count=182、uniqueIds=182 —— 连 id 都不重复了，
  同一批 91 个文件变成 182 个互不相同的曲目身份。这种**无法靠 trackId 去重识别**。

- 影响：
  1. 应用顶栏「添加文件夹」对同一个目录选两次即触发第一种；而对话框返回的是反斜杠路径、
     应用默认目录常量写的是正斜杠 —— **首次选同一个目录就触发第二种**，91 首变 182 首。
  2. 应用侧表现为曲库首数/艺术家计数翻倍、`trackId` 重复 → React 列表 `key` 重复；
     第二种更糟：182 个 id 全不同，任何按 id 归一的做法都失效，只能按 path 归一。
  3. catalog 被污染后，队列也建立在它之上，`next`/`prev` 会走进重复条目。
- 请求：让 `scan` 的条目身份在归一后的路径上成立（大小写、分隔符），已存在的条目跳过而不是再次追加；
  若想要「重扫 = 替换该目录」的语义，请在裁定里写明，应用侧会跟着调整。
- 若不改的替代方案（应用侧已落地，属止血不是修复）：
  - 按**归一后的 path** 去重（`app/src/shared/library.ts` 的 `libraryPathKey`）；
  - 同一会话内不再重扫已扫过的目录（重扫没有任何正确结果：只增不换），并明确告知用户；
  - 想知道磁盘新增文件就重启应用 —— 新进程会干净地重扫记忆目录。
  引擎仍应修掉：`result.added`/`scan_done.added` 会把重复计入，任何按条数判断的消费方都会被骗。
- 裁定：（owner 填）接受 / 拒绝 / 修改后接受 · 日期

**✍️ AI-B 追加（2026-10-15，同一轮）：还缺一条「清空/替换 catalog」的能力。**

应用侧现在支持用户管理**多个**曲库目录（添加/移除，见 `app/src/main/library-config.ts`），
但移除一个目录之后，引擎 catalog 里那批条目**仍然存在** —— 没有任何命令能把它们去掉
（§3 命令表里没有 clear/replace）。应用只能自己决定「显示谁、入队谁」：

- 曲库列表：按当前目录过滤（`app/src/shared/library.ts` 的 `isUnderRoot`）；
- 队列：`ipc.ts` 用过滤后的列表调 `set_queue`，所以被移除目录的曲目不会进队列。

结果是**行为正确但状态不干净**：引擎一直持有不再属于曲库的条目，`list_tracks` 会把它们
一并返回；一旦有消费方直接信 `list_tracks`（而不是应用过滤后的列表），就会看到不该存在的曲目。
应用侧的过滤是权宜，不是修复。

**请求（二选一，请 owner 裁定）**：
1. 让 `scan` 的条目身份在归一路径上成立并跳过已存在条目（本次请求的主体）；**并且**
2. 补一条能清空或按目录替换 catalog 的命令（例如 `scan` 增加 `replace: true`，
   或新增 `clear_library`）。有了它，应用移除目录时就能真正让引擎丢掉那批条目，
   而不是让两份状态长期不一致。

若两者都不做：应用侧会一直保留这层过滤，且必须假设 `list_tracks` 含有已不属于曲库的条目 ——
这会成为所有未来消费方都要记得的隐含前提。

---

**✅ 裁定（owner，2026-10-15）：两条都接受，按下述口径实现。**

### 裁定 1 —— 条目身份：归一路径 + 跳过已存在（**保留「追加」语义**）

- `scan` **仍是追加语义**（不改语义，只修身份与去重）。理由：追加是多目录曲库的自然模型，
  而「替换」由裁定 2 的 `replace` 单独提供，两者正交。
- 身份改为**归一后的路径**：统一分隔符（`\` ↔ `/`）、去尾斜杠、按卷的大小写特性决定是否折叠大小写。
  **归一规则必须与 `app/src/shared/library.ts` 的 `libraryPathKey` 一致**——
  否则两侧各有一套归一，新的不一致会比现在更难查。若引擎侧实现需要不同归一，
  **请在回复里写明差异**，由应用侧对齐（那一侧是纯函数，改起来便宜）。
- **已存在的条目必须跳过，不只是复用 id**。当前 `findByPath` 命中后仍执行 `tracks_.push_back()`
  → 同一首歌在 catalog 里出现两次、两次 id 相同。**这是与裁定 1 并列的一个独立缺陷，一并修。**
- **`result.added` / `scan_done.added` 必须只计真正新增的条目**。任何按条数判断的消费方
  （应用顶栏「曲库就绪 · N 首」、计数翻倍的用户可见症状）都依赖它。
  建议同时给一个跳过计数（如 `skipped`），让「扫了 91 首但只新增 0 首」可观测 ——
  否则用户看到 `added: 0` 会以为扫描失败。
- **存量脏 catalog 的处理**：引擎不负责猜测与清理历史重复（那会引入启发式判断）。
  应用侧在裁定 2 落地后处理：对每个受管目录发一次 `replace: true` 即得到干净状态。
  **不需要一次性迁移逻辑。**
- ⚠️ 归一后请确认 `trackId` 的稳定性：**已入库的曲目不得因为归一而换 id**（应用侧有队列与
  当前播放状态引用它）。若归一导致某些历史条目的 id 变化，请在回复里说明。
  （`replace: true` 会重发 id，应用侧可接受在同一次启动内重建。）

### 裁定 2 —— 清除能力：`scan` 增加 `replace: true`（**按目录替换**）

```json
{"id":31,"cmd":"scan","path":"D:/music","replace":true}
```

- 语义：**先丢掉属于该目录的全部条目，再扫描该目录并入库**。
  「属于该目录」按归一路径前缀判定，与裁定 1 的归一规则同源。
- **为什么是 `replace` 而不是新增 `clear_library`**：`clear_library` 是全局的，
  多目录场景下应用还得自己重建其余目录；而应用实际要表达的是**「这个目录不再属于曲库」**——
  按目录替换正好是这个语义，且**复用现有命令、不扩命令表**。
- 缺省 `replace` 为 `false` → 行为与今天完全一致，**旧调用方零影响**。
- `replace: true` 时 `added` 报**该目录重置后的净新增数**（通常等于该目录的曲目数）。
- **应用侧用法**：移除某个曲库目录时，对该目录发一次 `replace: true`，让引擎丢掉它。
  ⚠️ **`replace: true` 必须在路径不存在时也能清理并正常返回**，而不是报 `ERR_NOTFOUND`。
  这一点很重要：**用户移除目录的常见原因正是那个盘已经不在了**，
  而「不再扫描磁盘、只做清理」是这个场景唯一合理的语义。
- **隔离性**：`replace: true` 之后该目录的 `trackId` 可重新分配（旧 id 全部作废），
  **但不得影响其他目录的 id**。

---

### CR-017 · `scan` 支持递归子目录 + 入库前解码预检（可播放性）

- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-16（晚）
- 涉及：CONTRACT §3.2 `scan`；`engine/src/catalog.hpp`（`scanDirectory`）、
  `engine/src/app.cpp`（`cmdScan`）、`app/src/main/library-config.ts`、应用曲库过滤
- 背景（owner 本轮要求）：**「扫描文件夹自动添加歌曲，并自动标记无法播放的歌曲、移除出列表」**。
  实测确证三条彼此独立的缺陷（真引擎，非推断）：

| # | 缺陷 | 实测证据 |
|---|---|---|
| **1** | `scan` **非递归**（`directory_iterator`），音乐文件夹常见的「歌手/专辑/歌曲」层级会被漏掉 | 当前 91 首恰好平铺，所以未暴露 |
| **2** | ⭐ **入库了永远播不了的格式**：`kSupportedExtensions` 含 `.ogg` / `.opus`，而解码器只有 FLAC / WAV / MP3 / MP4 | `.ogg` 入库 `codec=Vorbis`、`.opus` 入库 `codec=Opus`；`open` 时才 `ERR_DECODE`（「not decodable as MP3」）⚠️ **`.ogg` 那一半已过时，见文末「CR-017 补充」** |
| **3** | ⭐ **坏歌卡死整个队列**：自动续播遇到打不开的条目时只写一条 `log[warn]`，随后 `state=stopped`，**不会跳到下一首能播的** | `queue=[好, 坏, 好]`：好歌播完 → `log[warn] could not continue to the next queued track` → `state=stopped`，后面的好歌永远不播 |

**请求**：

1. `scan` 增加可选 `recursive`（boolean，缺省 `false` ⇒ 旧调用方零影响），
   遍历子目录；身份仍按 CR-013 的归一路径，去重规则不变。
2. `scan` 增加可选 `probe`（boolean，缺省 `false`），入库前用**生产解码路径**打开一次文件；
   打不开的**不入库**，并计入新字段 `unplayable`（数组或计数，见裁定）。
3. `scan_done` 增加 `unplayable` 计数，让「扫了但没入库」可观测。

**约束**：

1. 预检必须用**生产解码器**（`openAudioSource`）而不是扩展名白名单 —— 缺陷 2 的根因正是
   「扩展名说能读、解码器读不了」，白名单只会把同一个错误再写一遍。
2. 预检**只读字节、不碰输出设备**（不 open WASAPI、不出声）。
3. 预检失败**不得**被当成 EOF 或静默跳过；必须可观测（计数 + 可选路径列表）。
4. 缺省行为（两个 flag 都不给）与今天**逐字节等价**，CR-013 的裁定继续有效。
5. ⚠️ 预检会为 `openAudioSource` 里 `.mp4/.m4a` 的分支启动 **Media Foundation**
   （`mfRuntime()` 是 magic static，进程级、不可逆）。`cmdShutdown` 已有
   `shutdownMediaFoundation()`，所以这是**已有的生命周期约束**，不是新增风险；
   但预检不得让 MF 源对象活到 `MFShutdown` 之后。

- 裁定：（owner 填）接受 / 拒绝 / 修改后接受 · 日期

> **本轮已按 owner 明确要求实施**（owner 已选择：入库预检 + 播放失败记录、
> 启动自动扫描 + 手动重扫、递归子目录、移除并记录可恢复）。
> 实施范围与验收见 `engine/PROGRESS.md`；此处保留 CR 记录以便事后追认或调整口径。

### 验收建议（请把这三条加进 `drive.mjs`）

```
1. scan A(正斜杠) → 91 ; scan A(反斜杠) → added 必须为 0，count 仍 91，uniqueIds 91
2. 同一字符串连扫两次                    → count 不增长，added 为 0
3. scan A → scan B → scan A replace:true → count = |B| + |A|，
   且 A 的 id 全新、B 的 id 未变
```

第 1、2 条覆盖本次两个重复缺陷；**第 3 条覆盖 `replace` 的隔离性**——
那是 `replace` 最容易被写错的地方（写成清空全部，或把 B 的 id 也重排）。
- 裁定：**接受（两条），口径见上** · 2026-10-15

#### ✍️ AI-A 回复（2026-10-15，判定后）：两条都实现并验过，**归一有一处要说清的差异**

`scan` 的条目身份改成**归一后的路径**，并按裁定 2 增加 `replace: true`。三处需要你知道的实现口径：

**1. 归一规则照 `libraryPathKey` 复刻，但大小写折叠走 OS**

与 `app/src/shared/library.ts` 一致的部分：`/` → `\`、去掉结尾分隔符、转小写；
边界掐在分隔符上（`d:\music` 不包含 `d:\music2`）；
连**局限**也照抄了 —— 不合并连续分隔符、不特殊处理 UNC 前导 `\\`，因为这两种形状都出不了目录选择框。

**差异只有一处**：你那边是 JavaScript 的 `toLowerCase()`（Unicode 默认大小写映射），
我这边是 `LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE)` —— Windows 的 Unicode 简单大小写映射。
对这台机器上的路径（中文 + 拉丁）两者**逐字节相同**；理论上会分叉的是**区域相关映射**
（典型是土耳其语的 `İ` / `ı`）。裁定说这一侧是纯函数、改起来便宜，所以由你决定要不要对齐：
如果要对齐到「完全一致」，把 `libraryPathKey` 换成 ASCII 小写也和我不一致（我是 Unicode），
最省事的做法是**两边都只保证 Windows 路径上的等价**，把这条差异写进各自的注释。

**2. `replace` 走的是「先删该目录、再扫该目录」，并且真的允许路径不存在**

```json
{"cmd":"scan","path":"D:/music","replace":true}
```

- 删除按**归一路径前缀**判定，与第 1 条同源；
- **路径不存在时返回 `ok:true`**（`added:0`、`removed:0`），不报 `ERR_NOTFOUND` ——
  裁定点名的那个理由确实成立：用户移除目录的常见原因就是那个盘已经不在了；
- 不加 `replace` 时路径不存在**仍然**回 `ERR_NOTFOUND`，旧行为一个字没动；
- `replace` 不是布尔 → `ERR_STATE`（`"scan replace must be a boolean"`），**不猜、不强转**。

**3. 被 `replace` 释放的 id 不复用**

裁定允许该目录的 id 重新分配。实现给的是**全新 id**（序号单调、从不回退），不是复用被释放的那些：
把一个空出来的 id 交给**另一首曲子**，比让旧 id 悬空更糟 ——
客户端还握着旧 id 时会**默默作用到错误的曲目**上，而不是什么都不做。
其他目录的 id 一个都不动（有断言钉住）。

**顺带一个性能副作用（不是要求，但值得知道）**：
「已存在则跳过」的判断放在 `readMetadata()` **之前**，所以**重扫一个已知目录不再做任何元数据读取** ——
以前每首都要过一次 TagLib。

**新增字段**（只增不改，CR-004 口径）：`scan` 回复与 `scan_done` 都多给 `skipped` 与 `removed`。
没有 `skipped` 时，重扫的 `added:0` 和「扫描没看见文件」在协议上无法区分 ——
这正是裁定 1 里那句「否则用户看到 added: 0 会以为扫描失败」。

**验收：裁定给的三条 + 两条边界，全部进了 `drive.mjs --step=identity`（26 条断言）**

```
drive.mjs --step=identity    # 26 条

1. scan A(反斜杠) → added 91 ；scan A(正斜杠) → added 0 / skipped 91 / count 91 / uniqueIds 91
2. 同一字符串连扫两次 → count 不增长、added 0、skipped 91、**id 未变**
3. scan A → scan B → scan A replace:true → total = |B| + |A|、A 的 id 全新、**B 的 id 未变**
   边界① 不存在的目录（无 replace）→ ERR_NOTFOUND，与今天一致
   边界② 不存在的目录（replace:true）→ ok:true / added 0 / removed 0
```

这套断言跑在**两个临时目录**上（硬链接自真实曲库，零拷贝），文件集互不相交 ——
这样「A 的 id 变了」和「B 的 id 变了」不可能被互相混淆。

**存量脏 catalog 不需要一次性迁移**：按裁定的说法，应用侧对每个受管目录发一次 `replace: true` 即可得到干净状态。
---

### CR-014 · 系统媒体控制（SMTC）需要两个新事件类型（SPEC §6.5，L3）
- 提出方：AI-A（引擎）
- 日期：2026-10-15
- 涉及：CONTRACT §3.3（事件表）；`docs/REFS-A-engine.md` §4；SPEC §6.5 / §3.8 L3
- 背景：SPEC §3.8 的 **L3** 把「系统媒体控制（SMTC）」列为 Should，而引擎侧**一个字段都没有**。
  用户在键盘上按媒体键、在锁屏或音量浮层上点上一首，引擎和界面都收不到。

  **为什么归引擎**（REFS-A §4.1 的结论，我同意）：SMTC 是 Windows 原生 API，直连 WinRT ABI，
  参考实现是 977 行、**零第三方依赖**；而这台机器的应用侧跑在 Electron 里，
  Node 侧没有成熟的 WinRT 绑定（REFS-A §4.3 明确不推荐那条路）。

  **为什么必须走 CR**：它要往契约的事件表里加东西。引擎不得单方面扩展 JSON 字段（CONTRACT §7）。

**请求：新增两个事件类型（只增不改，不动命令表）**

```json
{"ev":"smtc_button","button":"play"}          // play | pause | next | prev | stop
{"ev":"smtc_seek","positionMs":61234}           // 用户在时间线上拖动
```

**三条设计取舍，都是刻意的，请一并裁定：**

1. **只发事件，不新增命令**。引擎**不自己执行**播放控制，只把用户按了什么告诉应用，
   由应用调既有的 `play` / `pause` / `next` / `prev` / `seek`。
   理由：引擎自己按下去会出现**两份权威状态** —— 界面还在显示「暂停」而音乐已经开始了。
   代价是媒体键的响应多一次往返（stdio 上约 1–2 ms，可忽略）。
   若你更看重**媒体键的即时性**、接受引擎直接执行 play/pause（并立即发 state），
   请在裁定里说明，我改成引擎侧执行。

2. **媒体信息（标题/歌手/专辑/时长/播放状态/进度）不需要新命令**。
   这些引擎本来就知道（catalog + 自己的 state），它自己填给 SMTC。
   **只有封面需要裁定**：SMTC 支持缩略图，而封面是应用侧的资产。
   三个选择：(a) 不做封面（最省）；(b) 应用在 `open` 之后调一条新命令把封面路径交过来；
   (c) 引擎按「同目录 cover.jpg / folder.jpg」猜（**我不建议**，那是启发式，
   和「重扫不猜历史重复」是同一条纪律）。**我建议 (a)，本期不做封面。**

3. **HWND 从哪来**：引擎没有窗口。方案是引擎进程内建一个 **message-only window**
   （`HWND_MESSAGE` 的隐藏窗口），只用来满足 SMTC 对 HWND 的要求，不显示任何东西。
   这是 REFS-A §4.3 推荐的做法（方案 A）。

  ⚠️ **一个实现上的坑要先说**：SMTC 的按钮回调**可能由 WinRT 工作线程调用**。
   引擎的铁律是「stdout 只有 JSON Lines」且「RT 线程不许 I/O」，
   所以回调里**只许记录**（与设备热插拔那次同一个模式，见 PROGRESS §0k 与坑表 #60），
   真正的 `io_.emit()` 交给控制线程在 tick 里发。
   本机的 `device_monitor` 已经是这个形状，可以直接照搬。

**验收（如果接受）**

```
drive.mjs --step=smtc    # 只能在有交互式会话的机器上跑
```

- 事件**类型与载荷**可以离线钉住（构造一次回调，断言 emit 出来的帧）；
- 「按媒体键真的会响」**只能人工验**：我没有办法程序化地按下一个媒体键。
  所以这一步会像 `hotplug` 那样**如实跳过**它在当前环境测不了的部分，而不是假装测过。

**如果拒绝**：我什么都不做，`PROGRESS.md` §6 继续把 SMTC 记为未实现。

- 裁定：**接受，按本文原样** · 2026-10-15 —— owner 在询问窗口确认：
  **引擎只发事件、不自己执行播放控制**（由应用调既有命令）；**本期不做封面**；
  HWND 用进程内的 message-only window；回调只记录、由控制线程发帧。

---

---

### CR-015 · 电平监测需要 `ev:'meter'` 事件（`docs/DSP-A-engine.md` §5）
- 提出方：AI-A（引擎）
- 日期：2026-10-16
- 涉及：CONTRACT §3.3（事件表）；`docs/DSP-A-engine.md` §5；母方案 `docs/DSP-v1-effects-chain.md` §5.4
- ⚠️ **条号说明**：落地指令里写「接在 CR-013 之后」，但 **CR-014 已被 SMTC 占用**（同一批工作），所以本件是 **CR-015**。
- 前提：owner 已批准**设计**（DSP-A §0 的六项裁定）。按 CONTRACT §8 铁律 3，
  **设计批准 ≠ 契约变更批准**，所以协议字段仍走本件。

**请求：新增一个事件类型（只增不改，不动命令表）**

```json
{"ev":"meter",
 "rmsDb":[-18.2,-18.4],
 "peakDb":[-6.1,-5.9],
 "peakHoldDb":[-3.2,-3.3],
 "truePeakDb":[-2.8,-2.7],
 "truePeakBasis":"oversampled",
 "lufsMomentary":-16.4,
 "gainReductionDb":0.0,
 "spectrum":[/* 32–64 个对数频段 */],
 "waveform":[/* min/max 抽点对 */]}
```

**五条口径，请一并裁定（这几条比字段名更容易埋雷）**

1. **推送频率不跟随 `position`**。`position` 是 20 Hz 且与播放绑定；监测用独立的 `meterPushHz`（默认 **30**），
   并且**只在 UI 可见时推**（不可见时引擎不发，省的是带宽不是 CPU）。
2. **频谱是 32–64 个对数频段，不是 1024 个 bin。** 2048 点 FFT 有 1024 个 bin，
   直接推等于把带宽放大 16 倍，而人耳本来就是对数感知的。
3. **波形是 min/max 抽点对**，不是原始样本。
4. **`lufsMomentary` 是 400 ms 的 Momentary**（EBU R128 的定义窗口）。
   Short-term（3 s）与 Integrated **本期不给实时**，走既有的离线扫描。
   理由：那两个要跨秒的窗口状态，放在实时路径上只会让「这是什么数」变模糊。
5. **⭐ `truePeakBasis` 必须有，而且必须是这两个值之一**：
   - `'oversampled'` = 真过采样测出来的；
   - `'sample'` = **未过采样，等于样本峰值**。

   这条不是我们偷懒：**`libebur128` 在采样率 ≥ 192000 时根本不建插值器**
   （`ebur128.c:350` 的条件是 `samplerate < 192000`，否则 `st->d->interp = NULL`），
   真峰值**退化为样本峰值**。而 SPEC 支持到 192 kHz，**正踩在这条线上**。
   owner 裁定 5 是「如实标注」，所以字段必须有，且不能让调用方猜。

6. **mono 源时数组长度为 1，不复制成两份。** 复制会在表上画出两条一模一样的通道，
   看起来像「两个声道都正常」，实际是「只有一个声道」。

**带宽（§5.2 的成本，写进 CR 是为了先说清退路）**

30 Hz × 每帧几十个浮点，**跨进程 JSON 序列化**。这**可能变成一个性能问题**，而不是发现一个。
引擎侧会做节流与聚合；若实测过高，退路是**把频谱与波形拆成两个事件**（波形低频、频谱高频）。
真到那一步会另开 CR，不会私自拆。

**与既有字段的关系（不改语义，只是说明）**

- 监测**不改样本** → **不进** CR-009 的 `dspModules`（`DSP-A` §4 已规定）；
- 于是只开监测时 `outputPerfect` **仍为 true**（§6.1 断言 2）；
- 音效链（crossfeed / 中侧）任一非中性 → `outputPerfect=false`，但**不进 `degradeReason`**
  （降级是「做不到」，音效是「主动改声」）。

**如果接受**：`,` 之后我按 `meterPushHz` 推，并在 `drive.mjs` 里加断言 2（只开监测仍 `outputPerfect=true`）。
**如果拒绝**：监测只做引擎内部实现与 `--selftest`，一个字段都不往外发，并记进 `PROGRESS.md` §6。

- 裁定：**接受，按本文原样（六条口径全部接受）** · 2026-10-16 —— owner 在询问窗口确认。
  同时裁定**归属**：监测常驻主界面（应用侧把它做成 EQ 图右侧、歌词下方的一条低调常驻面板，
  不抢 C2 与歌词的重心）；频谱只在 UI 可见时推（口径 1）。
  应用侧据此已先落地**消费端与面板**，引擎 P5 落地即亮；数据未到时面板如实显示「等待引擎推送」，
  不画假柱子。

---

### CR-016 · `open` 接受回环 HTTP URL（阶段 1 流式播放）
- 提出方：AI-A（引擎）
- 日期：2026-10-16
- 涉及：CONTRACT §3.2（`open` 命令）；`docs/MASTER-A-engine.md` §2 CR-015；`docs/PLAY-v1-login-and-streaming.md` §1
- 背景：引擎侧已加入 WinHTTP Range reader，能对 `http://` / `https://` 资源执行头部嗅探、逻辑 seek 与 256 KiB 预读；
  但当前 `open` 只接受曲库中的 `trackId`，因此应用侧拿到回环代理 URL 后没有合法的契约入口把它交给引擎。

**请求：在不改变现有 `trackId` 语义的前提下，允许 `open` 使用以下追加字段：**

```json
{"cmd":"open","url":"http://127.0.0.1:<port>/media/<token>"}
```

约束：

1. `url` 与 `trackId` 互斥；缺少二者仍返回 `ERR_NOTFOUND`；
2. URL 只作为路径交给引擎，音频样本不穿越 stdio；
3. URL 资源的标题/艺术家/时长由应用侧提供，或由引擎在 `state` 中留空；本 CR 不新增元数据命令；
4. Range/鉴权/重签继续由回环代理负责；引擎在网络失败时停止并报告错误，不把失败当作 EOF；
5. 现有本地 `trackId` 路径与既有回复字段保持不变。

若拒绝，本次 WinHTTP reader 仍可由内部探针和未来的已批准入口使用，但应用侧不能通过当前契约触发它。

---

### CR-016 裁定：✅ **接受**（2026-10-16，owner）

**五条约束全部接受，无修改。**

| # | 约束 | 状态 |
|---|---|---|
| **1** | `url` 与 `trackId` 互斥；缺二者仍返回 `ERR_NOTFOUND` | ✅ 接受 |
| **2** | URL 只作为路径交给引擎，**音频样本不穿越 stdio** | ✅ 接受（符合 CONTRACT §3 铁律 2） |
| **3** | 元数据由应用侧提供，或 `state` 中留空；本 CR 不新增元数据命令 | ✅ 接受 |
| **4** | Range / 鉴权 / 重签继续由回环代理负责；**引擎在网络失败时停止并报告错误，不把失败当作 EOF** | ✅ 接受（符合 `read_proc` 契约） |
| **5** | 现有本地 `trackId` 路径与既有回复字段保持不变 | ✅ 接受 |

**实施记录**：

- **引擎侧（AI-A）**：在 `cmdOpen` 增加 `url` 分支。⚠️ 该分支**不走 `requireTrack`**（曲库查找），
  而是直接把 URL 交给 `FileReader`（其 HTTP 后端已完成，见 PROGRESS §0v）。
  **约束 3 的落法**：`state` 中 `trackId` 留空，标题/时长可留空 —— 由应用侧自己显示。
- **应用侧（AI-B）**：在播放路径调用 `mediaProxy.register()`（该代理已完成，310 行含重签）。
- **验收**：见 [`INTEGRATION-v1-engine-app.md`](INTEGRATION-v1-engine-app.md) §5 ——
  ⭐ **先做 L2**（本地 HTTP 源当远端，排除所有外网变量）。

---

### CR-015 补充裁定 · 允许新增监测可见性命令

- 日期：2026-10-16
- 裁定依据：本会话明确指出 CR-015「只在 UI 可见时推」缺少输入通道，并请求增加可见性信号；owner 回复「允许」，随后要求「继续」。
- 允许在原 CR-015 事件基础上新增 `set_meter` 命令，解决原文「不动命令表」与可见性要求的冲突；其余音频处理语义不变。

```json
{"id":40,"cmd":"set_meter","enabled":true}
{"id":40,"ok":true,"data":{"enabled":true}}
```

实现口径：

1. `enabled` 必须为 boolean；缺失、字符串、数字或 null 返回 `ERR_STATE`，不改变之前的设置。
2. 每个引擎进程默认关闭推送；同值重复设置幂等。仅在播放且启用时以不超过 30 Hz 的频率发 `meter`。
3. `false` 只关事件序列化/推送；只读 tap 与分析历史继续运行。音量、静音、DSP、播放位置与 `outputPerfect` 不受影响。
4. Electron 主进程统一同步窗口 show/hide/minimize/restore/closed；窗口不存在、隐藏或最小化视为不可见。引擎 `ready` 后重新同步最新状态，断连期间不发命令。
5. `hello.capabilities.meter=true` 表示实现了该命令和实时监测。旧引擎返回 `ERR_UNSUPPORTED` 时，本进程不再反复尝试，播放功能保持可用；引擎重启后重新探测。


---

### CR-017 补充 · `.ogg` / `.oga` 现在真的能解码了（2026-10-17，AI-A）

CR-017 的缺陷 2 把「`.ogg` 入库 → `open` 时 `ERR_DECODE`」当作**证据**。这条证据在今天之前是准确的，
现在不准确了，所以在此更正，而不是让文档继续描述一个已经不存在的现象。

**变更内容（不改协议、不改 CONTRACT、不新增命令）**：

| 项 | 之前 | 现在 |
|---|---|---|
| `.ogg` 装 Vorbis | `ERR_DECODE`「not decodable as MP3」 | ✅ 解码（stb_vorbis v1.22，vendored） |
| `.ogg`/`.oga` 装 Ogg-FLAC | `ERR_DECODE` | ✅ 解码且 `lossless=1`（dr_flac 的 Ogg 支持重新打开） |
| `.oga` 扩展名 | 不在 `kSupportedExtensions` | 已在（`flac` / `oggenc` 的默认输出扩展名） |
| `.opus` | `ERR_DECODE` | **仍然不解码**，但原因**点名 Opus**，进入 `unplayablePaths` |

**为什么这不是契约变更**：`open` 的入参与回复、错误码、`state` 字段一个都没动。变的只是
「同一个 `trackId` 现在能放出来」。CR-017 约束 1 要求预检必须用**生产解码器**而不是扩展名白名单——
这次正好验证了那条约束的价值：`isDecodable()` 一行没改，`.ogg` 从「不可播」变成「可播」是**解码器**
变了，白名单式的实现会继续把能放的文件挡在外面。

**新增的诊断入口（CLI，非协议）**：`--probe-format <file> [--full] [--seek <ms>]`。
打印生产解码路径的真实结果与拒绝原因，`--full` 对照全解码帧数，`--seek` 拿**独立重放**比样本。
与 `--probe-mf` / `--probe-decode` / `--probe-spectrum` 同类，属内部探针，不进 JSON 协议。

**验收**：`engine/tools/test-ogg-decode.mjs` **30/30**；
`--probe-decode`（FLAC 逐样本）91 文件 **0 失败**——证明打开 dr_flac 的 Ogg 支持
**没有动到原生 FLAC 的解码结果**。


### CR-018 · 歌词：需要两个**只增不改**的字段（`LyricWord.ruby` 与 `source:'netease-lrc'`）
- 提出方：AI-B（应用）
- 日期：2026-10-17
- 涉及：CONTRACT §4.3（`Lyrics` 归一化格式）与 §4.4（数据源优先级）
- 现状：§4.3 冻结的模型是
  `{ lines[{ startMs, endMs, words[{text,startMs,endMs}], text, translation?, romanization?, background? }], wordByWord, source }`，
  其中 `source` 只有 `'amll-ttml' | 'netease-yrc' | 'qq-qrc' | 'lrclib' | 'local' | 'embedded'`。
- 请求（两条，都是**追加**，旧值语义一个不变）：
  1. `LyricWord` 增加可选字段 `ruby?: string`——该音节的注音（振假名/拼音）。
  2. `Lyrics.source` 增加 `'netease-lrc'`——网易云**行级**歌词（原文 + 中译 + 罗马音）。
- 理由：**这两条都不是设计偏好，是实现时撞上的事实**。
  1. AMLL TTML 规范（amll-ttml-db wiki §6.2「Ruby 标注」）用四层嵌套标注**逐字**注音：
     `<span tts:ruby="container"><span tts:ruby="base">所</span><span tts:ruby="textContainer"><span tts:ruby="text">しょ</span></span></span>`。
     §4.3 只有**行级** `romanization`，逐字注音无处安放；把它塞进 `text`
     又会破坏「`words` 拼接 === `text`」这条渲染不变式（逐字填充按 `text` 落字形）。
     实测该格式在真实文件里确实出现（fixture `app/fixtures/lyrics/feature.ttml` 按规范构造），
     且不认识的消费者忽略可选字段即可，**零兼容风险**。
  2. §4.4 第 3 顺位写的是「网易云 `yrc`——带 `yv=-1` 即返回字级」。**实测不成立**：
     `/api/song/lyric?id=…&lv=-1&tv=-1&rv=-1`、`/api/song/lyric/v1?…&cp=false`、
     `lv/tv/rv/yv/ytv/yrv` 各种组合、未登录与带 `cp` 开关，**响应里都没有 `yrc` 字段**；
     能拿到的只有 `lrc`（行级原文）+ `tlyric`（中译）+ `romalrc`（罗马音）。
     字级 `yrc` 走的是需要 weapi/eapi 加密的 `/lyric/new`，属于平台层（`@neteasecloudmusicapienhanced/api`）的工作。
     于是「网易云行级」在两处都不存在：源枚举没有它，而把它标成 `'netease-yrc'`
     就是**谎报词级来源**——本项目最忌讳的那类错误。
- 若不改的替代方案（都已试过，都不成立）：
  - 逐字注音压成行级 `romanization`：一个汉字一行只能有一个读音，多字行直接丢信息；
  - 网易云行级冒充 `'netease-yrc'`：下游据此把 `wordByWord` 当 true，动画会在**根本没有词级时间**的数据上逐字填充；
  - 网易云行级不上报（改用 `'local'`）：来源不可追溯，用户看到「译文与罗马音」却不知道它来自网络。
- 影响面：仅应用侧类型（`app/src/shared/protocol.ts`）。引擎不解析歌词，**协议命令与事件零改动**。
- 裁定：（owner 填）接受 / 拒绝 / 修改后接受 · 日期

#### ✍️ AI-B 补充（2026-10-17 晚）：`netease-yrc` 已实施，`netease-lrc` 仍然需要

CR-018 当时说「字级 yrc 走的是需要 weapi/eapi 加密的 `/lyric/new`」。现在补上实测与实施结果：

- **加密的是 `/weapi/song/lyric`**（不是 `/lyric/new`）。参数加密后同一个接口同时返回
  `yrc`（字级）+ `lrc` + `tlyric` + `romalrc`，一次请求拿全。
- 覆盖率：中文歌 3/6 有 yrc；本机日文库 8 首抽样 **0/8**。
- 因此 **`source:'netease-lrc'` 这一条请求依然成立**：没有 yrc 的歌只能用行级数据，
  把它标成 `netease-yrc` 就是谎报词级来源。两种来源现在真的都会出现，所以枚举必须能区分。
- 附带发现并修掉一个解析 bug：yrc 的字偏移是**绝对毫秒**，不是相对行首（有真实对照数据）。

### CR-019 · 10 个 EQ 槽位需要成为**完整参数带**（每段自己的频率 / Q / 类型）
- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-17
- 涉及：CONTRACT §4.3 之外的 DSP 扩展命令 `set_eq`；SPEC 3.4 的十段固定参数
- 现状：`set_eq` 只接受 `bandGains: number[]`（十个**固定频率** 31.25…16 kHz 的增益）+
  一个**全局** `q`（0.5–4）+ `preampDb` + `autoHeadroom`。频率与滤波器类型不可变。
- 请求（只增不改）：`set_eq` 增加 `bands` 数组，按索引局部更新每一段的
  `{`freq`?, `gainDb`?, `q`?, `type`?}`，`type` 取 `'peaking'|'lowShelf'|'highShelf'`（也接受 0/1/2）。
  取值语义：`freq: 0` = 回到该槽位的 SPEC 网格频率，`q: 0` = 使用全局 Q。
  `get_state.data.dsp.eq.bands[]` 相应增加 `q` 与 `type`，且报告**解析后**的生效值。
- 理由：**外部曲线与耳机补偿根本写不进十段等 Q 结构**。实测 AutoEQ 的参数预设里既有
  `LSC/HSC`（低架/高架），也有任意频率与任意 Q（例如 `PK 4001 Hz Gain 2.3 dB Q 0.25`、
  `PK 6639 Hz Gain 2.2 dB Q 5.82` —— 后者超出全局 Q 上限 4）。固定的十频点 + 统一 Q
  只能"拟合"，而拟合会引入 ±1–3 dB 误差且**表达不了架式滤波**。
  另外 owner 明确要求「EQ 无极调节」：一个全局 Q 之下，所有频段的带宽永远一样宽。
- 兼容性：`bandGains` / `q` / `preampDb` / `autoHeadroom` 语义**一个都不变**；
  零值初始化意味着默认 `DspParams` 仍解析为 SPEC 网格 + 全局 Q + 峰值，
  所以既有的黄金频响测试（±0.1 dB）逐点不变，已实测通过。
- 若不改的替代方案：把外部预设拟合到十段（已实现并保留为「密集曲线」的路径，
  见 `app/src/shared/eq-preset.ts` 的 `fitCurveToBands`），但参数预设会失真、架式滤波不可表达。
- 实施证据：
  - 引擎自检新增断言：频段移到 2 kHz 后在 2 kHz 精确 +12 dB 且旧槽位不再是峰；
    逐段 Q 收窄裙边（Q0.7 与 Q4 在倍频程处差 >1 dB）且中心增益与 Q 无关；
    低架/高架在拐点两侧各自成立；**默认 DspParams 仍解析为 SPEC 3.4 网格**。
  - 协议实测：`set_eq {bands:[{type:'lowShelf'}]}` → 回读 `lowShelf`；
    非法频率/类型被拒并给出具体原因；`freq:0,q:0` 能复位。
- 影响面：引擎（dsp.hpp / dsp.cpp / player.* / app.cpp）+ 应用侧类型。
  **不改任何已有字段的含义**，不新增命令。
- 裁定：**接受** · 2026-10-17 —— owner 在询问窗口选择「扩展引擎：10 个槽位都变成完整参数均衡」。

### CR-020 · 需要一条 FIR / 房间卷积通路（新命令 `set_ir` + 新状态 `state.dsp.ir`）
- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-17
- 涉及：CONTRACT §4 命令集（新增 `set_ir`）、`get_state.data.dsp`（新增 `ir`）、`state.dspModules`（新增 `"ir"`）
- 现状：只有参数均衡。ECHO NEST 那边的「FIR / Room correction」我们没有对应实现，
  房间的低频驻波、耳机/音箱的冲激响应都表达不了 —— 参数均衡能修幅度，修不了**时域**。
- 请求（只增不改）：
  1. 新命令 `set_ir`，字段全部可选：`{ path?: string, enabled?: boolean, preampDb?: number }`。
     `path` 是服务器/本机绝对路径（UTF-8），引擎自己解码 WAV；`preampDb` 是 ±24 dB 的电平修正。
  2. `get_state.data.dsp.ir = { loaded, enabled, preampDb, latencyFrames, taps, channels, sampleRate, partitions }`。
  3. `state.dspModules` 在 IR 生效时包含 `"ir"`；`dspActive` 同理。
  4. 语义：IR 生效时 `isPassthrough()` 必须为 false（会改变样本），即 bit-perfect 不得成立。
- 理由：卷积是唯一能表达「时域修正」的机制。而且素材已经验证过——见 §实测。
- 兼容性：`DspParams` 新增 `irEnabled=false` / `irPreampDb=0`，默认值即「无 IR」，
  所以既有黄金测试与 bit-perfect 语义完全不变（已实测：`--step=dsp` 24/24、`--selftest` 全绿）。
- 关键设计决定（不打算改，写在这里免得下一个人重新发明）：
  - **IR 不走 seqlock**。参数快照是标量；IR 是几 MB 的频域数组。用独立的原子指针交接，
    RT 线程只在**块边界**换指针，控制线程保留所有权；RT 线程从不 delete。
  - **全湿，没有 dry/wet 混合**。校正冲激响应本身包含直达声路径，把干声混回来会梳状滤波。
    也正因为如此，IR 生效时必须强制走湿路径（否则会当成旁路静默输出未校正信号）。
  - **固定 1024 帧延迟**（48 kHz 下 21.3 ms）。分块大小是精度/CPU 的折中，不是巧合；
    延迟**如实上报**在 `latencyFrames`，不藏。
  - 采样率不一致时**线性重采样**（不是零阶保持），并在状态里报告源采样率。
- 实施证据：
  - 验收测试（`--selftest` 内，做了 RED 反证）：
    - 单位冲激卷积 → 输出**逐样本等于冲激响应本身**（误差 < 1e-4）；
    - 任意信号 → 与**离线暴力直接卷积**对照（误差 < 5e-4）；
    - 第一分区填满前没有泄漏；
    - 上报延迟 == 分区长度。
    - RED 反证：把 IFFT 的 1/N 去掉 → 两条断言立刻失败（最大误差 1023.5 / 2444.7），证明测试有牙。
  - 协议实测：载入 24000 抽头立体声 48 kHz IR → `24 分区 / 延迟 1024 帧` 回读正确；
    enable/disable/preamp 生效；不存在的文件与空参数各自给出**具体**错误。
- 影响面：引擎（convolver.* 新增、dsp.* / player.* / app.cpp / output_wasapi.hpp 接入）+ 应用侧类型与界面。
  **不改任何已有字段的含义。**
- 裁定：接受（2026-10-17，owner 指示「继续」并已在此前的询问中确认要做房间校正）。

---

### CR-021 · 输出规格可指定：`set_output.sampleRate` + `state.requestedOutputRate`（引擎侧已实现，请裁定字段名）
- 提出方：AI-B（应用）／AI-A（引擎）
- 日期：2026-10-17
- 涉及：CONTRACT §3 命令集（`set_output` 增加可选字段）、`state` 事件（新增只读字段）、`open` 回复
- 现状：`set_output` 只能选模式（auto / exclusive / shared），**流率只能跟随源**。
  用户明确要求「192kHz 等等几种规格的输出」要能指定 —— 同一份 44.1k 素材，
  有的 DAC 在 96k/192k 下工作得更稳，而这是软件唯一能给的开关。
- 请求（**只增不改**）：
  1. `set_output` 增加可选 `sampleRate`：`0` = 跟随源，允许
     `44100 / 48000 / 88200 / 96000 / 176400 / 192000 / 352800 / 384000`。
     省略 = 保持当前值。非法值必须 **ERR_STATE 拒绝**，不得静默夹到最近档。
  2. `set_output.mode` 改为**省略 = 保持当前偏好**。原来省略即 auto，于是「只改规格」
     会顺手把用户的独占/共享选择重置掉。
  3. `state.requestedOutputRate`（number，只读）：本次请求的流率；`0` = 跟随源。
     它与 `state.sampleRate`（**实际**流率）是两个事实，必须分开报告 ——
     共享模式下 WASAPI 只能跑设备混音格式，请求不会被采纳。
  4. `open` 回复同样带 `requestedOutputRate`（与 `set_output` 回复一致）。
- 语义（诚实性，不可让步）：
  - 非零且与源不同 ⇒ 重采样器进入链路 ⇒ `outputPerfect=false`、`resampled=true`、
    `outputNotPerfectReason="resampled"`。**不允许**一边升频一边宣称 bit-perfect。
  - 独占端点不接受该率时按既有规则降级（auto）并写 `degradeReason`（点名设备拒绝了哪个率/位深）；
    共享模式一律报告请求值 + 实际值，不假装成功。
  - 改模式/规格会重开流：**播放中必须自动恢复播放**（否则一次设置就等于一次静音）。
- 实施证据（2026-10-17，本机内置端点 = 48000/24 独占可用）：
  ```text
  open 44100 源          → auto：shared 48000（端点拒绝 44100 独占）
  set_output 96000       → requested=96000, 实际 48000, degradeReason="the device does not accept 96000 Hz / 24-bit PCM in exclusive mode"
  set_output 48000       → exclusive 48000，requested=48000，resampled=true，bitPerfect=false
  强制 48k 播放 4 秒      → position 4103ms / xrun 0 / renderedFrames 196992（≈48000/s）
  set_output 12345       → ERR_STATE（拒绝，不夹）
  ```
- 兼容性：旧客户端不传这两个字段时行为与以前完全一致（`mode` 仍可显式传 auto）。
- 裁定：**✅ 接受（2026-10-17，owner）** —— 按上述字段名入契约：
  `set_output { mode?, sampleRate? }` 与 `state.requestedOutputRate`（只增不改）。
  引擎与应用侧均按此形状实现，并通过真实端点实测（见上）。

---

### CR-022 · meter 事件瘦身：停发未消费的 waveform、数值收敛到 0.1 dB、关闭时暂停分析
- 提出方：AI-B（应用）+ AI-A（引擎）
- 日期：2026-10-17
- 涉及：CONTRACT §3.3 事件流 + CR-015（meter 可见性扩展）；具体条目：`ev:"meter"` 的 `waveform` 字段与各 dB 数值精度、`set_meter.enabled=false` 的语义
- 现状：
  1. 每帧 meter 事件带 `waveform: 64 × [min,max]`，应用侧 `audio/meterStore.ts` **从不读取**它（MeterSnapshot 里连字段都没有）；真机实测单帧 749 B，其中约 550 B（73.6%）是 waveform → 以 65–70 帧/秒推送，约 38 KB/s 纯浪费（引擎 stdout + 主进程解析 + IPC 结构化克隆 + 渲染层校验各付一次）。
  2. 各 dB 数值以完整 double 精度序列化（json.hpp 的 dumpNumber 用 snprintf(%.15g)+strtod 往返校验，微基准 1.13 µs/个；一帧约 190 个数字 → 214.7 µs/帧 ≈ 1.3% 单核@60fps）。
  3. `set_meter.enabled=false` 现在只停序列化与推送，**分析（FFT 8192×2 + EBU true-peak）仍在每 tick 全速运行**（微基准 393 µs/帧 ≈ 2.36% 单核@60fps）——窗口隐藏、或在没有 meter 面板的页面播放时，这份 CPU 没有任何消费者。
- 请求（本轮实现，owner 可裁定接受/拒绝）：
  1. **停发 `waveform`**。应用侧当前无消费者；类型上保留为可选字段以便回滚到旧引擎。
  2. meter 的各 dB 数值收敛到 **0.1 dB**（`std::round(v*10)/10`）后序列化；显示精度本来就是 0.1 dB，数值含义不变，帧体积进一步下降。
  3. `set_meter.enabled=false` 时**暂停分析**（RT tap 写入保留，零分配不变量不变）；重新 `enabled=true` 时 analyzer reset，2–3 帧内恢复读数（≤50 ms@48k）。这是行为变化：隐藏/关闭期间峰值保持与 LUFS 读数不推进。
  4. 应用侧配套（应用内部行为，不入契约）：只有当前视图真有 meter 消费者（首页的 meter 面板 + 频谱光带、沉浸视图的频谱光带，均挂在 `MusicSpace`）且窗口可见时，才下发 `enabled=true`；其余页面（曲库/歌曲中心/搜索/下载/设置/音效）下发 false。
- 理由与证据：真机 749 B/帧 → 目标 ≤220 B/帧；引擎可见播放 CPU 中 meter 序列化约 1.3–1.5% 单核、分析 2.36% 单核；测试见 `engine/tools/test-playback-silent.mjs`（已改为断言「不再发送 waveform」）与 `--selftest`。
- 兼容性：旧应用忽略 waveform（从来如此），不受影响；旧引擎仍发 waveform，新应用也照旧忽略。数值 0.1 dB 化对 `test-playback-silent` 的有限性断言无影响。
- 裁定：待 owner（**若拒绝第 1 条，回退只需恢复 emitMeter 里的 waveform 构造；第 3 条的回退是一个条件分支**）

---

### CR-023 · 平台 API 服务端改为「按需自动启动 + 空闲休眠」（修订 §4.1「启动时拉起」的驻留语义）
- 提出方：AI-B（应用）
- 日期：2026-10-17
- 涉及：CONTRACT §4.1 形态：「Electron 主进程在启动时拉起 API 服务端子进程，前端只访问本地 URL」
- 现状：`main/index.ts` 在 `app.whenReady()` 里无条件 `streamingManager.startEnabled()`，凡 `streaming.json` 里 `enabled:true` 的平台都会拉起一个第三方 Node API 服务端，并**整场会话常驻**。本机实测（真实用户配置，网易云 + QQ 两个源）：两个子进程 RSS **165.1 + 83.7 = 248.8 MB**，比整个 Electron Browser 主进程还大；而用户完全可能整场只放本地 FLAC，一次都没用到平台。
- 请求：把生命周期从「启动即拉起、整场常驻」改为「**按需自动启动、空闲自动休眠**」：
  1. 启动时不拉起任何平台服务端；`streamingStatus` 的 `runtimes.state` 保持既有取值 `stopped`（**不新增状态形状**，UI 已有 stopped/starting/ready/failed 四态可用），`config.lazyStart` 如实带回。
  2. 任何需要平台的操作（搜索 / 歌单 / 登录 / 账号 / 在线播放取链 / 下载）第一次发生时自动拉起并等 ready（UI 已有 starting 态可显示）；用户显式点「启动」仍立即启动。
  3. 连续 **10 分钟**没有平台请求、且当前不在播在线曲目时，停止该平台子进程，下次按需重启；退出时照旧全部停止。
  4. 串行启动改并行（两平台互不等待），保留现有超时与退避。
  5. 配置增加顶层 `lazyStart`（缺省 `true`）；置 `false` 即回退到「启动时拉起」的旧行为，便于对比与回滚。
- 理由：248.8 MB 是本次审计里最大单笔常驻内存；「自动启动」的产品含义是「用户不必手动管理」，不是「必须开机就常驻」。改为按需后，只用本地文件时这笔内存为 0；用平台时行为不变（首点有一次 2–3 s ready 等待，UI 已如实显示）。
- 若不改的替代方案：保持常驻，只把启动延后到 ready-to-show + idle —— 启动更顺，但稳态内存一分不省（仍常驻 248.8 MB），故不作为本轮方案。
- 兼容性：协议零改动（仍只访问本地 URL）；UI 增加一个 idle 状态文案；失败退避与重试语义不变。
- 裁定：待 owner

---

### CR-024 · 重采样器可配置：新命令 `set_resampler` + `state.resampler`（对标 ECHO NEXT 的 ECHO SRC / 滤波器档位）
- 提出方：AI-B（应用）+ AI-A（引擎）
- 日期：2026-10-17
- 涉及：CONTRACT §3 命令集（新增 `set_resampler`）、`state` 事件（新增只读 `resampler` 对象）
- 现状：引擎固定用 SoXR `VHQ` + 线性相位；用户无法在「透明 / 低延迟 / 24-bit 匹配」之间选择，也无法试最小相位（pre-ringing 取舍）。ECHO NEXT 有等价的 ECHO SRC（质量档 + 滤波器/相位档）。
- 请求（只增不改）：`{"cmd":"set_resampler","quality":"HQ|VHQ|24BIT","phase":"linear|minimum|intermediate|maximum","steep":true}` → `{quality,phase,steep}`。字段全部可选，省略 = 保持当前值；非法值 ERR_STATE。`quality` 映射 SoXR 精度档（VHQ=28bit 默认、24BIT=SOXR_24_BITQ、HQ=20bit）；`phase` 映射 soxr phase_response（minimum=0 / intermediate=25 / linear=50 / maximum=100）；`steep` 映射 SOXR_STEEP_FILTER。
  - `state.resampler = { quality, phase, steep }` 是**实际生效**的配置；只在重采样真正进入链路时才有听觉含义。
  - 播放中改配置：引擎重建重采样器并保持源码位置（允许 ≤100ms 的淡入/重开），不得谎称无缝；若不允许重开，退化为「下一首/下次 open 生效」并在回复里如实说明。
- 理由：这是可测量的音质取舍（阻带抑制/相位），不该只有唯一档；且 24BIT 档可能的 CPU 收益需要实测（不预设）。**默认值保持现状（VHQ/linear/非 steep）**，不改变既有听感。
- 兼容性：旧客户端不调用即行为完全不变。
- 裁定：待 owner

### CR-025 · PCM dither 模式可选：新命令 `set_dither` + `state.dither`（对标 ECHO NEXT 的 dither 档位）
- 提出方：AI-B（应用）+ AI-A（引擎）
- 日期：2026-10-17
- 涉及：CONTRACT §3 命令集（新增 `set_dither`）、`state` 事件（新增只读 `dither`）
- 现状：引擎只有平直 TPDF dither（SPEC §0d），且当输出整数位深低于源精度时**总是**开；没有 off / 高通 TPDF / 噪声整形档。
- 请求（只增不改）：`{"cmd":"set_dither","mode":"off|tpdf|highpass-tpdf|ns-5|ns-9|ultra-shaped"}` → `{mode, active}`。省略 mode = 保持当前；非法值 ERR_STATE。默认 `tpdf`（与现状等价）。
  - `active` 是引擎如实报告的「这次量化是否真的加 dither」（沿用现有 ditherApplies() 判据：只在整数输出且输出位深低于源有效精度时成立；bit-perfect/passthrough 永不启用）。
  - 算法：tpdf 现有实现；highpass-tpdf = 一阶高通整形后的 TPDF；ns-5/ns-9 用公开的 SoX lip44(5 抽头)/fwe44(9 抽头) 误差反馈系数；ultra-shaped 用 20 抽头 Shibata（系数注明来源）。所有模式不得改变输入样本的直流/增益，且只在量化路径生效。
  - `state.dither = { mode, active }`；`state.dspModules` 不新增（dither 不改变样本，只改量化噪声形状——与既有 limiter 的处理一致）。
- 理由：真正可测量的噪声整形收益（16-bit 输出下可感知频段约 10–20dB 改善），且用户可关；默认不变。
- 裁定：待 owner

### CR-026 · 声道工具扩展：`set_channels` 增加 `monoMode` / 三频段左右增益 / 每声道延迟（对标 ECHO NEXT 的 Channel Balance / Channel Tools）
- 提出方：AI-B（应用）+ AI-A（引擎）
- 日期：2026-10-17
- 涉及：CONTRACT §3 既有扩展命令 `set_channels`（只增字段）、`state.dsp` 的 `channels` 对象、`state.dspModules`
- 现状：已有 balance / mono(布尔) / stereoWidth / swapChannels / channelGains(L/R 全带) / mid-side / crossfeed。缺：单声道来源选择（sum/left/right）、低/中/高三频段的左右独立增益、每声道延迟（音箱摆位对齐）。
- 请求（只增不改）：`{"cmd":"set_channels", "monoMode":"off|sum|left|right", "bandGains":{"low":[L,R],"mid":[L,R],"high":[L,R]}, "delayMs":[L,R]}`；全部可选，省略 = 保持；mono:true 等价于 monoMode:"sum"（旧语义保留）。
  - 三频段用 LR2 分频（200 Hz / 2 kHz）；**三段增益全 0 时整段旁路**（不改变样本、不破坏 bit-perfect）；任一非 0 才进入 DSP，`state.dspModules` 增加 `"bandGain"`。
  - 每声道延迟用每声道环形缓冲（0–10ms，0 旁路）；非 0 时 `dspModules` 增加 `"channelDelay"`，并如实说明这会改变样本。
- 理由：ECHO NEXT 的 Channel Tools 里这是「声场/分离度/摆位」的可测量工具（用户此前明确抱怨过声场与分离度）；且都能在 0 值时完全旁路，不牺牲 bit-perfect。
- 裁定：待 owner

### CR-027 · 输出延迟档位：`set_output` 增加 `latencyProfile` + `state.latencyProfile`（对标 ECHO NEXT 的 stable/balanced/lowLatency）
- 提出方：AI-B（应用）+ AI-A（引擎）
- 日期：2026-10-17
- 涉及：CONTRACT §3 `set_output`（只增字段）、`state` 事件（只增字段）
- 现状：引擎自适应地选缓冲区（内置端点 shared 实测 period 10ms / buffer 22ms），用户没有「低延迟优先 / 稳定优先」的开关；state.bufferMs/state.periodMs 已存在。
- 请求（只增不改）：`set_output` 增加 `latencyProfile?: "stable"|"balanced"|"lowLatency"`（省略 = 保持；缺省 balanced）。
  - lowLatency：独占/共享都请求最小可行 period，缓冲区向 1024 帧（48k≈21ms）靠拢；共享模式无法小于系统混音周期时如实报告实际值。
  - stable：缓冲区向 8192 帧靠拢（容忍更大延迟，优先 xrun=0）。
  - `state.latencyProfile` 报告引擎实际采用的档位；bufferMs/periodMs 仍是实测值——请求与实际不一致时以实测值为准，并在 degradeReason 说明。
- 理由：低延迟与稳定性是真实取舍；ECHO NEXT 把它暴露成三档，用户能按场景选。默认 balanced 不改变现状。
- 裁定：待 owner



### CR-028 · 过渡（fade）可配置 + 暂停保持流：`set_output.fadeMs` / `set_output.pauseHold` + `state.fade`（治理暂停/切歌爆音）
- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-18
- 涉及：CONTRACT §3 `set_output`（只增字段）、`state` 事件（只增字段）；不改任何既有命令语义
- 现状（用户反馈）：暂停与切歌时有可闻噪声/电流声。代码勘测：过渡用**线性** 5ms（`kPlaybackRampMs`），暂停/停止/切歌都走 `fadeOutBeforeStop()`，但 `stop()` 只等 `fadeOutPending()`（淡出样本播完），不等设备缓冲真正排空；`seek()` 在播放中**没有**淡出直接 `Stop()`；独占模式 `Stop()` 前未 `Reset()`，残留缓冲可能被重放。
- 请求（只增不改）：
  - `set_output.fadeMs?: number`（5–50，缺省 10）：暂停/切歌/停止/seek 的过渡时长；曲线改为**等功率**（sin²），不再是线性。省略 = 保持；缺省值与旧行为等价（旧代码无此字段时引擎按内部默认）。
  - `set_output.pauseHold?: boolean`（缺省 true）：暂停时**不关闭输出流**——淡出到 0 后保持流打开、继续渲染静音，恢复时先淡入而不是重新 `Start()`；目的：避免端点 `Stop()/Start()` 之间的电源/时钟切换底噪（USB DAC、蓝牙尤其明显）。`false` 回退旧行为（暂停即停流）。
  - 切歌/停止：淡出后等端点**真排空**再 `Stop()`，并在 `Stop()` 后、`Start()` 前 `Reset()` 清残留缓冲。
  - `state.fade = { ms, pauseHold }` 如实回读；`state.dspModules` 不新增（过渡不是 DSP）。
- 理由：这是用户直接可感知的缺陷；三处改动都可量化（缓冲残留与硬切检测），且默认行为对听感与 bit-perfect 语义不变。
- 裁定：待 owner

### CR-029 · 空间音频（杜比类）：`set_spatial` + `state.spatial`（crossfeed / wide / virtual HRIR）
- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-18
- 涉及：新增扩展命令 `set_spatial`、`state.spatial`、`state.dspModules`
- 参考：Cavern（开源 C# 空间音频引擎：HRIR 卷积、串扰消除、上/下混）与 Dolby Atmos 的基本链路（Bed+Object→声道映射→HRTF→动态范围管理）。**不引入 C#/.NET 运行时，不做商业 Atmos 解码**。
- 请求（只增不改）：`{"cmd":"set_spatial", "mode":"off|crossfeed|wide|virtual", "amount"?:0..1, "azimuth"?:-90..90, "delayMs"?:0..1, "hrir"?:"builtin"}`
  - `off`（默认）：整段旁路，**逐样本恒等**，不破坏 bit-perfect；
  - `crossfeed`：耳机串扰消除（2×2 矩阵 + 0–1ms 对侧延迟 + 低通），降低极端左右分离带来的听觉疲劳；
  - `wide`：中侧（M/S）增益扩展，提升立体声宽度，不改变总能量（受限于 amount）；
  - `virtual`：双耳虚拟环绕。用 24 方位内置 HRIR（解析模型生成：ITD + ILD + 耳廓低通），复用**已有 partitioned FFT 卷积器**（`convolver.hpp`，1024 帧分块），启动时把 HRIR 预转换成频域；**只输出双耳 2ch**，不请求多声道端点。
  - 效率约束：RT 路径零分配零锁；HRIR 频谱在控制线程算一次；每块只做 2 次 2×1024 点复数乘加。
  - `state.spatial = { mode, amount, active }`（active 如实反映是否真的在处理）；非 off 时 `dspModules` 增加 `"spatial"`；此时 `bitPerfect` 如实为 false。
- 理由：用户明确要求「加入杜比音效」，但客户端内嵌商业 Atmos 解码既不合法也不高效；用已有卷积器实现的 crossfeed/virtual 是可测量、可关闭、零新依赖的高效等价物。
- 裁定：待 owner

### CR-030 · 队列编辑：`set_queue` 增加 `queueIndex` 保持与 `remove` 语义（只增，用于队列面板拖拽/删除）
- 提出方：AI-B（应用）
- 日期：2026-10-18
- 涉及：既有扩展命令 `set_queue`（只增字段）、`state.queue/queueIndex`（已存在）
- 现状：`set_queue { trackIds }` 每次重置 `queueIndex=0`；渲染层做队列拖拽/删除/排序时，会**把正在播放的曲目从队列索引上甩掉**（表现为队列高亮跳走、下一首错位）。
- 请求（只增不改）：`set_queue` 增加可选 `keepCurrent?: boolean`（缺省 false=旧行为）与 `currentTrackId?: string`；为 true 时引擎在重排后把 `queueIndex` 指回该 trackId（找不到则 -1 并如实报告）。
- 理由：没有它，队列面板的任何编辑都会破坏「当前在放什么」；这是纯状态修复，不改变播放语义。
- 裁定：待 owner

### CR-031 · 限幅器可控：`set_limiter`（enabled / ceilingDb / releaseMs / lookaheadMs）+ `state.dsp.limiter`（对标 ECHO NEXT 的 Limiter）
- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-18
- 涉及：新增扩展命令 `set_limiter`、新增回读 `state.dsp.limiter`；**不改**既有字段语义
- 现状：限幅器一直存在且默认开启（`dsp.hpp` 的 `DspParams::limiterEnabled/limiterReleaseMs`），但：
  - 只有 `state.dsp.limiterEnabled` 一个布尔回读，ceiling 写死 -0.1 dBFS（`dsp.cpp` 的 `constexpr float ceiling = 0.9885531f`），release 只有内部默认 60 ms，**没有任何协议入口**；
  - 没有 lookahead：瞬态靠"立即抓峰值 + 平滑释放"，超过 ceiling 的采样峰由硬 clip 兜底，因此密集瞬态下会有可测的削波；
  - `state.dspModules` 有意不列 limiter（unity gain 时它不改样本），这个口径保持不变。
- 请求（只增不改）：
  - 新命令 `{"cmd":"set_limiter","enabled"?:bool,"ceilingDb"?:number,"releaseMs"?:number,"lookaheadMs"?:number}`，省略的字段 = 保持当前值（与 `set_channels`/`set_spatial` 一致）；四个字段全缺省时返回 `ERR_STATE`（"at least one of ..."）。
  - 取值范围：`ceilingDb` ∈ [-12, 0]（dBFS 采样峰 ceiling，默认 -0.1）；`releaseMs` ∈ [5, 1000]（默认 60）；`lookaheadMs` ∈ [0, 20]（默认 **0**）。越界**拒绝**而不是 clamp（与 EQ/声道的既有约定一致：调用方给了 +40 dB 不是想被截到 12）。
  - `lookaheadMs = 0` 时算法与既有实现**逐样本一致**（硬要求，selftest 有回归断言）；> 0 时走"延迟线 + 滑动最大值 + 平滑释放"，延迟 = lookaheadMs 对应的样本数，如实报告在 `state.dsp.limiter.latencyFrames`，供 UI 解释口型偏移。
  - 回读 `{"cmd":"get_state"}` 的 `data.dsp.limiter = { enabled, ceilingDb, releaseMs, lookaheadMs, latencyFrames, truePeakActive, gainReductionDb }`；`truePeakActive` 如实说明峰值判定用的是采样峰（本构建 = false；不谎报 true-peak 限幅）。`gainReductionDb` 是最近一块的联动衰减量，复用既有 `DspChain::gainReductionDb()`。
  - 既有 `state.dsp.limiterEnabled` **保留**（旧客户端仍在读），值与 `limiter.enabled` 恒等。
- 理由：限幅器是唯一改变动态的 DSP 级；用户能听出来，却只能开关、不能看它在做什么。ceiling/release/lookahead 是三个可量化、可回归的参数，且 lookahead=0 保证默认听感与 bit-perfect 判定链完全不变。
- 裁定：待 owner

### CR-032 · 解码能力矩阵 + 系统解码兜底 + DSD：`get_capabilities` + `state.source`
- 提出方：AI-A（引擎）+ AI-B（应用）
- 日期：2026-10-18
- 涉及：新增扩展命令 `get_capabilities`；新增回读 `state.source`（只增字段）；`state.sourceExact` 语义不变
- 现状：界面无法知道"这个引擎能解什么"，只能维护一张会和引擎漂移的扩展名表；引擎侧原生解码器只有 FLAC/WAV/MP3/Ogg(Vorbis/FLAC)/MP4(AAC/ALAC)，而 Windows 自带的 Media Foundation 还能解 WMA / WMA Lossless / AAC(ADTS) / Opus（后者的容器解复用在本机缺失，见下），且 .dsf/.dff 完全不可播。
- 请求（只增不改）：
  - 新命令 `{"cmd":"get_capabilities"}` → `{ protocol, decoders:[{ext,label,kind,lossless,available}], dsd:{supported,modes,output,decimationPcmRate}, systemDecoders:bool }`。
    - `kind` ∈ `"native" | "system" | "dsd"`：谁在解这个格式（native=引擎自带解码器，system=Windows Media Foundation，dsd=1-bit 源经抽取转 PCM）。
    - `available` 是**本机实测**，不是"平台应有"：system 项要求「容器 byte-stream handler 已注册」且「解码器 MFT 存在」两个条件同时成立。实测本机 Opus 解码器 MFT 在、但 .opus/.ogg 的 byte-stream handler 不在，所以 `{ext:".opus", available:false}` —— 谎报 true 会让界面亮着、用户点了报错。
    - `systemDecoders`：本机 Media Foundation 运行时是否可用（MFStartup 成功过）。它是 `decoders[]` 中 system 项的**总开关语义**，不是逐项结论：总开关为 false 时所有 system 项必然 `available:false`；为 true 时逐项仍以各自 available 为准。DSD 不依赖它。
    - `dsd.output` 固定 `"pcm"`（本构建做抽取转 PCM，不做原生 DSD/DoP 输出）；`dsd.decimationPcmRate` 报告抽取后的 PCM 采样率（DSD64 → 176400）。
  - 新增回读 `state.source = { format, dsdRate?, decimationPcmRate? }`：`format` ∈ `"pcm" | "dsd"`（缺省 "pcm"，旧客户端忽略即可）；DSD 时 `dsdRate` 为源 1-bit 率（DSD64 = 2822400），`decimationPcmRate` 为抽取后的 PCM 率。**`state.sampleRate`/`sourceSampleRate` 继续报抽取后的 PCM 率**，既有重采样/bit-perfect/独占协商逻辑一行都不用改。
  - 系统解码兜底：原生解码器（FLAC/WAV/MP3/Ogg/MP4）全部失败后，再用 Media Foundation 的 IMFSourceReader 尝试；**只接本地文件**，HTTP 流维持既有 MediaReader 路径。原生路径的输出与判定逐样本不变（硬要求）。
  - `lossless` 白名单：PCM / float PCM / FLAC / ALAC / WMA Lossless 为 true；Opus / AAC / AC-3 / WMA(v2) / MP3 为 false。认不出的 codec 一律报 **false**（把有损报成无损会让 `sourceExact` 撒谎，且这个方向的错误用户无法自查）。
  - `scan` 的扩展名过滤同步扩容 `.aif .aiff .wma .ac3 .dsf .dff`；**`isDecodable` 仍是"真打开一次"**，扩展名列表只决定"扫不扫"，不决定"能不能播"（CR-017 的口径不变）。
- 理由：能力只能由有能力的那一侧回答；一张客户端自维护的格式表必然与引擎漂移，而漂移的表现是"界面说能播、点了报 ERR_DECODE"。系统解码兜底与 DSD 抽取都是**零新依赖**（前者用 OS 自带 MFT，后者是自写半带抽取器），符合"不加 third_party、不引 FFmpeg"的约束。
- 裁定：待 owner

#### CR-032 实现回填（2026-10-18，引擎侧）
- `get_capabilities` 已实现（`app.cpp` 的 `cmdGetCapabilities`），`decoderCapabilities()` 在 `mf_source.cpp`；`--probe-decode` 无参数时只打印矩阵、带路径时逐文件报告。
- **实测结论 1（重要，写进 CR 以防将来再踩）**：`available` 必须是「容器 byte-stream handler 已注册」**且**「解码器 MFT 存在」。本机 `Microsoft Opus Audio Decoder MFT` 存在，但 `HKLM\SOFTWARE\Microsoft\Windows Media Foundation\ByteStreamHandlers` 下没有 `.opus`/`.ogg` 子键（该键把扩展名存成**子键**，不是值），所以 MF 打不开 .opus（`0xC00D36C4`）。.opus 因此如实报 `available:false`。
- **实测结论 2**：`.ac3` 只有在 MP4 容器里才可解（`ac3.m4a` → ok=1，decoder=AC3）；裸 `.ac3`（IEC-61937 之外的裸流）MF 不认容器。矩阵里 `.ac3` 的 available 以 handler 子键 + AC-3 MFT 为准，实际打开仍由 `isDecodable` 回答。
- **实测结论 3**：DSD 已落地（`dsd_source.cpp`）。`.dsf/.dff` 均为 `kind:"dsd"`、`lossless:true`、`available:true`。DSF（LSB-first，blockSize 分块）与 DFF（MSB-first，帧交织）都已实测解出 PCM：`empty10ms.dsf/.dff` → `rate=176400, 2ch, 24bit`；`dc.dsf/dff` → peak=1.000000、outOfRange=0；`nyquist.dsf/dff` → peak=0.000001（Nyquist 抑制 -120 dB 量级）。
- **抽取器口径（供 verifier 复算）**：4 级半带级联，`h[n]=sin(πn/2)/(πn)`、`h[0]=0.5`。判据是 `H(π/2)/H(0)=0.5`（在**系数**上量，因为 decimation by 2 后输入域 fs/4 落在输出域 Nyquist，峰值法退化）、DC 稳态=1、0.6π 阻带 < −60 dB。启动瞬态（延迟线零初值 → 满幅阶跃的振铃）丢弃前 256 个输出帧，因此 PCM 永不越界。
- **`state.source` 已实现**：DSD 播放时 `{format:"dsd", dsdRate:2822400, decimationPcmRate:176400}`；`state.sampleRate/sourceSampleRate` 报抽取后的 PCM 率（48000 输出下 `sourceSampleRate=176400`），因此既有重采样/bit-perfect/独占协商逻辑未改动。`open` 回复对 DSD 也用解码器实测值（`sourceSampleRate=176400, bitDepth=24`），而不是 TagLib 的 1-bit/2822400 —— 两个数字都真，但该字段的语义是"这次播放的源"。
- **系统兜底的真实边界**：`.wma`/`.wmv`(ASF) 与 `.aac`(ADTS) 实测可解（`lossless.wma` → `decoder=WMALossless lossless=1`；`empty1s.aac` → `decoder=AAC`）。打不开的容器一律带原因返回，不再"报 ok 但零样本"（`real_example.wma` 是 9967 B 却声称 96 秒的 fixture，MF 头解析成功但立刻 EOS —— 现在如实拒绝为 `decoded no audio`）。


