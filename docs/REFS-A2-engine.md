# 三个播放器的可转化资产 · 给 AI-A（引擎）

> **这不是契约。** 不影响 `CONTRACT.md` 与 `docs/SPEC-v2.1.md` 的权威性。
> 上位：[`REFS-A-engine.md`](REFS-A-engine.md)（QueMusic + ECHO 审计，本文件是其**续篇**）
> 本文件新增三个来源：**Twilight_Echo**（Apache-2.0）、**Folia**（AGPL）、**ECHOBridge**（AGPL）
>
> ⚠️ **许可纪律仍然生效**：
> | 来源 | 许可 | 怎么用 |
> |---|---|---|
> | **QueMusic** `BroNekoX/QueMusic` | **Apache-2.0** | ✅ **可直接抄代码** |
> | **Twilight_Echo** `Px-asen/Twilight_Echo` | **Apache-2.0** | ✅ **可直接抄代码** |
> | Folia `chthollyphile/folia-major` | AGPL-3.0 | ⚠️ 只学模式 |
> | ECHOBridge / ECHOAndroid | AGPL-3.0 | ⚠️ 只学模式 |
>
> **本文件 = §0 最重要的发现 + §1 可抄清单 + §2 你的优势 + §3 行动建议**

---

## 0. ⭐ 最重要的发现：`outputPerfect` 双状态 —— 你可能在误报

**来源**：`Px-asen/Twilight_Echo`（**Apache-2.0，313★，已发布 1.3.0，和你同名同架构**）。
它的引擎也是 **C++20 + Electron + C ABI/Node-API**，目录树几乎与你的 `engine/` 逐项对应。

### 0.1 它的洞察（原文）

> **整数 PCM 源如果被转换到 Float32 管线再打包为整数输出，不能标记为 `outputPerfect=true`。**

### 0.2 为什么这直接命中你

你的记忆里记着 dither 的实现要点：

> "float32 算 24 bit（尾数 24 位），**这正是 24-bit 源经 float32 无损、不该加 dither 的原因**"

**这句话的数学是对的，但结论可能需要修正。**

| 场景 | 你的 `bitPerfect` | 它的 `outputPerfect` | 谁对 |
|---|---|---|---|
| 24-bit 源 → Float32 管线 → 24-bit 输出 | `true` | **`false`**（`pcm_converted`） | **它对** |

**理由**：Float32 尾数确实能无损表示 24-bit，但**信号经过了"解包到 float → 重新打包回 int"这个动作**。
它的定义是：

> `outputPerfect`：**解码后 PCM 到后端实际输出之间没有额外处理**、重采样、音量、DSP、破坏性 routing 或 **sample format 损伤**时为 `true`。

**"格式转换"本身就是一次处理**，即使这次转换在数值上无损。

### 0.3 它的完整模型（三个正交字段，比你单个 `bitPerfect` 精确）

| 字段 | 定义 | 关键性质 |
|---|---|---|
| **`sourceExact`** | **源文件级**精确：无损源 **且** 源格式 == 输出格式 | 只有无损/整数 PCM 源可能为 true |
| **`outputPerfect`** | **解码后 PCM 到设备输出**无额外处理 | ⭐ **有损源也能 `true`** |
| **`pcmPassthrough`** | decoded PCM 与实际输出格式**完全一致**且后端未 resample | 由管线比较后写入，**不由后端自行声明** |

**最有价值的一条**（原文）：

> **有损格式可以达成 `outputPerfect=true`，但 `sourceExact=false`**，原因显示为
> `Source is lossy; decoded PCM path is output perfect`。

**你现在无法表达这个区别**：MP3 解码后直通输出，你的 `bitPerfect=false`——**但那其实是路径完美的**，只是源本身有损。用户在界面上会以为"信号链有问题"，**而真相是"源就是有损的，路径没问题"**。

### 0.4 `outputPerfect=true` 的完整条件（它的 7 条）

```
1. 后端声明 supportsOutputPerfect=true
2. decoded PCM 与实际输出的 采样率/有效位深/声道数/sample format 完全匹配
3. pcmPassthrough=true   ← 关键：格式转换会破坏这一条
4. 后端未报告 resampled=true
5. 音量为 1.0
6. ReplayGain / EQ / Convolver / Crossfeed / Crossfade 全部未启用
7. 声道 routing 不改变声道语义
```

**对照你的判定**（`PROGRESS.md`：独占 + 源采样率 + 无重采样 + 无增益）：

| 它的第 3 条 | 你的对应 |
|---|---|
| `pcmPassthrough`（格式直通） | ⚠️ **你没有这一条** —— 你只看"是否重采样"，没看"是否经过格式转换" |

**这条差异就是 §0.2 那个潜在误报的根源。**

### 0.5 一个具体的失败原因码（值得抄）

```
integer_passthrough_unavailable   ← 整数源必须转 float32 才能过处理链
pcm_converted                     ← 格式被转换过
```

**它明确写了**：

> Int16 → Float32、Int24 → Float32、**Int24 → Int24-in-32** 等 sample format 或容器变化**都不算 passthrough**。

> ⚠️ **`Int24 → Int24-in-32` 不算 passthrough** —— 这一条你可能正在违反。
> 你的 `exclusive_format.hpp` 有 `24-in-32` 候选格式（PROGRESS 坑 #18 记着"独占探测漏了 24-in-32"），
> 那么**把 24-bit 源装进 32-bit 容器输出时，你会不会报 `bitPerfect: true`？** 按它的定义，**不该报**。

### 0.6 怎么办

**已写成 CR-010**（见 `docs/contract-requests.md`），建议：

1. `state` 事件**新增三个字段**：`sourceExact` / `outputPerfect` / `pcmPassthrough`
2. **保留 `bitPerfect` 作为兼容别名**（等于 `outputPerfect`），避免推翻现有 UI 与自测
3. 判定链加一条"格式直通"检查，并提供失败原因码

**这是本轮唯一需要改引擎语义的项**，其余都是"抄代码"。

---

## 1. 可直接抄的清单（Twilight_Echo，Apache-2.0）

**它的 `audio-engine/` 目录与你逐项对应**，以下是按你缺口排序的价值表：

| # | 文件 | 体量 | 补你的什么缺口 |
|---|---|---|---|
| **1** | **`analysis/LoudnessAnalyzer.cpp`** + `.h` + `.test.cjs` | 11.2 KB + 8.3 KB | ⭐ **你说的"剩余唯一 L2"**：libebur128 扫描器（增益应用你已做，但算不出 `trackGainDb`/`albumGainDb`） |
| **2** | **`WasapiFormatNegotiator.cpp`** + 测试 | 22.2 KB + **39.2 KB** | ⭐ **格式协商的五类失败区分**（sample rate / bit depth / channel / sample format / exclusive open）。你的探测比它粗 |
| **3** | **`tests/bitperfect_tests.cpp`** | **35.2 KB** | ⭐ **bit-perfect 判定的测试矩阵** —— 你正缺；且它是"双状态模型"的验收 |
| **4** | `analysis/BpmAnalyzer.cpp` | 13.3 KB | 若要做 AutoMix 就需要；否则跳过 |
| **5** | `automix-native/am_plan.c` / `am_graph.c` | 36.6 + 21.0 KB | AutoMix 规划与图（你已砍 AutoMix，**除非改主意**） |
| **6** | `output/asio/windows/AsioDriverSession.cpp` | **53.0 KB** | ASIO 会话（你有 ASIO4ALL 但无真 ASIO 硬件） |
| **7** | `tests/dsd_dop_tests.cpp` / `dsd_downrate_tests.cpp` | 71.0 + 7.9 KB | DSD 测试（你的 SPEC §3.5 只留 DoP 直通） |
| **8** | `tests/runtime_queue_reroute_tests.cpp` | **224 KB** | ⚠️ 队列重路由测试——**你的 CR-007（`operationId`）完整解法可能在这里** |
| **9** | `smtc/twilight_smtc_node.cpp` | 31.3 KB | **SMTC 的第三条路线**：Node-API 原生模块（另两条：QueMusic 应用内 C++ 977 行 / ECHO 独立进程 15.6 KB） |
| **10** | `automix-native/am_kernels.c` + `am_stretch.c` | 16.3 + 9.0 KB | WSOLA 变速核（你已砍变速） |

**它的第三方**：`miniaudio`（0.11.25，MIT-0/Unlicense）、`kissfft`。
**它的 VST3**：状态是 `available`（build）+ `unverified`（runtime/device）——**和你砍掉 VST3 的决定一致**。

### 1.1 ⭐ 比代码更值钱：它的三维能力状态模型

`docs/release-capability-status.md` 是**发布门禁**的机器可读声明：

| Capability | Product status | Build presence | Runtime observation | **Real-device verification** |
|---|---|---|---|---|
| ASIO | `experimental` | `available` | `available` | **`unverified`** |
| VST3 | `available` | `available` | `unverified` | **`unverified`** |
| SoXR | `unverified` | `unverified` | `unverified` | **`unverified`** |
| CUDA | `not-built` | `not-built` | `not-built` | `unverified` |

**核心纪律（原文）**：

> **没有真实设备证据必须是 `unverified`** —— 而不是把缺设备变成构建错误，或**由设备名猜测为可用**。
> `available` 只说明该受控维度已有事实，**不能替代真实设备证据**。

**另一条最狠的**：

> 真实设备 smoke **不进入默认 CI 门禁**；发布前可加 `--require-complete` 让证据不完整时 **exit 非 0**。
> **mock 与未知来源只验证逻辑，绝不计入硬件覆盖。**

**对你的意义**：你的独占模式**本机听不到**（驱动不触发缓冲区事件）。按它的模型，你的独占应标：

```
Build presence:        available    （代码编译进去了）
Runtime observation:   available    （能开流、能报 bitPerfect）
Real-device verification: unverified  ← ⭐ 本机驱动不触发回调，等于无真机证据
```

**你的 `PROGRESS.md` 已经在这么做**（"如实记录，不含糊"）。**这条模型只是把它正式化** —— 建议抄进 `PROGRESS.md` 或契约。

---

## 2. 你相对它的优势（不必妄自菲薄）

| 维度 | Twilight_Echo | 你 |
|---|---|---|
| 构建链 | **MinGW + vcpkg + w64devkit + GNU patch**（复杂，且要处理 `Access is denied` 重试） | **MSVC + CMake**，简单得多 |
| SoXR | 只作为 **FFmpeg 的可选 resampler**，标 `unverified` | **直接集成 SoXR** ✅ |
| 真机门禁 | `test:no-real-device` **不含真机** | `drive.mjs` **236 断言含真机** ✅ |
| CUDA | `not-built` | 不适用（你不需要） |
| 版本 | 已发 1.3.0（功能远多） | M2 完成（功能少但底盘干净） |

**它的功能清单里有你砍掉的全部**：AutoMix（自然/DJ 双模式 + 分轨）、DSD Native/SACD ISO/DST、32 段参数 EQ、VST3、CUDA、主题工坊、插件工坊、IEM 校正（OPRA/AutoEQ）、网络源（WebDAV/FTP/SFTP/SMB）、电台播客、统计仪表盘、P2P 备份恢复……

**它是 313★ 的成熟项目，你是一人自用。这不是要你追上它** —— 而是说：**你可以直接抄它的 Apache-2.0 代码，省掉它交过的学费。**

---

## 3. 行动建议（按性价比）

| # | 动作 | 来源 | 成本 | 收益 |
|---|---|---|---|---|
| **1** | **采纳 `outputPerfect` 双状态**（补 3 字段 + 格式直通检查） | Twilight_Echo | 中 | ⭐ **修正潜在误报**；**已写 CR-010，等 owner 裁定** |
| **2** | **抄 `LoudnessAnalyzer.cpp`** 补 libebur128 扫描器 | Twilight_Echo | 小 | ⭐ **完成"剩余唯一 L2"** |
| **3** | **抄 `WasapiFormatNegotiator`** 的五类失败区分 | Twilight_Echo | 小 | 你的探测更诚实（C2 的降级原因更准） |
| **4** | **抄 `bitperfect_tests.cpp`** 做判定矩阵 | Twilight_Echo | 小 | 双状态模型的验收 |
| **5** | **三维能力状态正式化**（build/runtime/**device**） | Twilight_Echo | 小 | 你已在做，写进 `PROGRESS.md` |
| **6** | 看 `runtime_queue_reroute_tests.cpp`（224 KB）如何测重路由 | Twilight_Echo | 中 | 参考 CR-007 的 `operationId` 设计 |
| **7** | SMTC 选一条路线（第三条：Node-API 模块 31.3 KB） | Twilight_Echo | 中 | 你 SPEC §6.5 的缺口 |
| — | ~~AutoMix / VST3 / CUDA / SACD~~ | — | — | **你已砍，不要因为别人有就加回来** |

---

## 5. ⭐ ECHOAndroid 的 Echo Link 协议：一份**现成的对接说明书**

**来源**：`Moekotori/ECHOAndroid`（Kotlin，**LGPL-3.0**，13★）。
**新增来源**：`ECHOBridge`（C#，AGPL）也实现了同一协议的另一半。

### 5.1 为什么这条对你价值极高

它在**仓库根部放了三份写给 PC 侧的实现规约**：

```
ECHO_LINK_PC_PROMPT.md        (5.0 KB)   ← 第一阶段
ECHO_LINK_PC_PROMPT_PHASE2.md (11.8 KB)
ECHO_LINK_PC_PROMPT_CAST.md   (2.8 KB)
```

**其中一份明确写着是写给 `moekotori/echosteam`（PC 侧）的实现规约**——
也就是说，**这是一份"手机端 → PC 端"的正式协议说明书，另一端是 PC**。

### 5.2 协议全貌（可直接实现）

| 项 | 值 |
|---|---|
| 传输 | **HTTP REST + SSE** |
| 端口 | **26789** |
| 路径 | `/echo-link/v1/` 与 `/v2/` |
| 鉴权 | **Bearer** + `X-ECHO-Link-Version` 头 |
| 配对 URI | `echo://pair?host=&port=26789&token=&name=&scheme=http`（token ≥16 字符） |
| 发现 | **mDNS `_echo-link._tcp.`**，TXT 记录 = `name` / `version` / `deviceId` / `direct` |
| 端点 | `/status` · `/playback/command` · `/playback/queue` · `/library/{tracks,albums,albums/:id/tracks,playlists/:id/tracks,folders}` · `/library/tracks/:id/{stream,lyrics}` · `/lyrics/:id` · `/artwork/:token` · `/media/:token` |

**发现层的两个细节**（`EchoLinkDiscoveryPolicy`）：
- **IPv6 方括号归一化**、**排除 `fe80:` 链路本地地址**、**IPv4 优先**

### 5.3 ⭐ 三个设计亮点（比端点表更值钱）

| # | 亮点 | 为什么值得学 |
|---|---|---|
| **1** | **SSE 快照带"字段存在性标记"做部分更新** | 它有 `queueIncluded` / `trackArtworkIncluded` / `volumeControlIncluded` / `outputIncluded` / `playbackOrderIncluded` —— **缺失的字段保留旧值，而不是清空**。这是**部分更新的正确做法**（对比：你现在的 `state` 事件是全量快照，每个字段都必须带） |
| **2** | **V2 action 带 `requestId` 幂等** | ⭐ **和你的 CR-007（`operationId`）是同一个问题的第三种解法**。它用 `requestId` 保证"重发不重复执行" |
| **3** | **队列 revision + 409** | 乐观并发：客户端拿旧 revision 提交时返回 **409 Conflict**。**你的 `TAE_SelectQueueIndex` 类操作可以直接用这个模式** |

### 5.4 ⭐⭐ 最直接的一条：它的 `status` JSON 已经用你的措辞

> **`status` JSON 直接写 `outputMode: "WASAPI Shared"`，与我们引擎同构，近零成本对接。**

**这说明**：ECHO 的 PC 端与你的引擎**用了同一套输出模式语义**。
如果你将来想做「手机遥控 PC 播放」或「让其他客户端接入你的引擎」，
**你的 `state` 事件已经是最接近的格式** —— 加一层 HTTP + 字段存在性标记即可。

### 5.5 它的"更高效"对照（报告给的，反过来对你有用）

报告明确回答了"能否用系统库替代自研"——**它自己就绕开了系统库**：

| 它的做法 | 你的更高效处 |
|---|---|
| **DSP 全自研**，刻意不用 `AudioEffect`/`DynamicsProcessing` | —（**证明"自研 DSP"是正确判断**） |
| Kotlin 手写 RBJ biquad + **逐 buffer 过 JNI** | ⭐ **你 C++20 原生 10 段，零 JNI** |
| **为 bit-perfect 自造约 80 KB USB 音频栈**（等时传输 + 描述符解析 + 反馈时钟） | ⭐ **你 WASAPI 独占 + 能力探测 + 看门狗即可**（Android 没有 WASAPI，被逼自造） |
| 逐字扫光需约 **200 行 `Path` 缓存 + 字形 `Rect` 裁剪 + 帧率调速**（Compose 无按词扫光 API） | ⭐ **你用 CSS `background-clip: text` + 动画 `linear-gradient`，合成器硬件完成** |
| `preferredFrameRate` 可变刷新率补丁 | **桌面无需** |
| 扫描双策略（MediaStore + SAF） | **沙箱所迫；你直接遍历 + TagLib** |

**这六条是"你的技术栈在 Windows 上更省"的独立佐证** —— 一个 13★ 的 Android 实现，
为了同样的目标付出了你不需要付的代价。

### 5.6 可直接抄的歌词能力（它比 Folia 更全）

它的歌词格式覆盖比 Folia 更广：

```
LRC / TTML / ASS / VTT / SPL(QQ) / SBV / SAMI / JSON
```

- `EchoLyricsParser.kt`（13.5 KB）调度
- `EchoLyricsTextDecoder` —— **编码嗅探**（BOM/UTF-16 等）
- `OnlineLyricsResolver.kt`（15.1 KB）+ `LyricsCandidateMatcher` —— **候选打分**

**对你的意义**：你只有 LRC / 增强 LRC / KRC 风格。**TTML 是你 CONTRACT §4.4 已列为主源但没解析器的**。
**ASS / SPL / SAMI / SBV** 是它多出来的——**优先级低**，但知道存在。

**它的逐字高亮实现**（`KaraokeLyricHighlight.kt`）——**报告说我们要做得更省**：

> 用 `getPathForRange()` 累积 `Path`、逐 glyph `getBoundingBox()` 出 `Rect` 按分数填充、
> `BreakIterator` 取字素边界、`getBidiRunDirection` 支持 RTL，按 plan+multiParagraph 身份缓存。

**两条对你仍有价值的细节**：

| 细节 | 价值 |
|---|---|
| **`BreakIterator` 取字素边界** | ⭐ 与 Folia 的结论一致（**用字素簇，不用 code point**）——两个独立实现都这么做，**这条要听** |
| **`getBidiRunDirection` 支持 RTL** | 你的 91 首里没有阿拉伯语，但**日文歌词可能含拉丁/RTL 混排**；低优先级 |

**一个 APK 级的事实**：它用 `Rhino 1.7.15` 做 **JS 插件系统**（Android 上的插件方案）。
**对你的意义**：你的插件系统如果要做，**JS 是一个不需要重编译的选择**——但优先级低。

### 5.7 别抄的部分（它的技术债）

| 不足 | 证据 |
|---|---|
| **4 个月内 Room schema 迁移 21 次** | `EchoLibraryDatabase` 已 `version 21`，`schemas/` 有 21 个 JSON —— **迁移太快是设计不稳定的信号**，别学它的节奏 |
| **多个 God object** | `EchoAppRoot.kt` **131 KB**、`EchoLibraryRepository.kt` **115 KB**、`EchoSettingsStore.kt` **109 KB**、`NowPlayingScreen.kt` 67.5 KB |
| **三个未关闭的真实缺陷** | #9 USB DAC 独占不弹授权、卡"等待解码"（**同机 UAPP 正常**）；#10 MediaSession 概率失灵；#11 连 Navidrome 后开网盘冷启闪退 |
| **PR#12 自认未真机验证** | 锁屏歌词 / widget / DSD / USB 都未验证 —— **又一个"未验证 ≠ 不可用"的实例**（对照 §1.1 的三维模型） |
| 根目录残留 813 KB png 与 hot-reload 日志 | 卫生问题 |

> ⚠️ **#9 这条对你有间接价值**：**USB DAC 独占在同一台机器上 UAPP 正常、它不正常** ——
> 说明"独占失败"经常是**实现细节**而非硬件不支持。
> **你的独占看门狗（400ms 无帧渲染即降级）正是这类问题的正确应对** ——
> 你选择"如实降级"而不是"死磕"，是对的。

---

## 6. 一句话

> **它给了你三样东西**：
> **① 一个你可能在误报的判定模型（`outputPerfect` 双状态）；**
> **② 一批可直接抄的 Apache-2.0 代码（响度、格式协商、判定测试）；**
> **③ 一套"诚实报告能力"的纪律（build/runtime/device 三维）。**
>
> **外加 §5 那份 Echo Link 协议 —— 如果你要做手机遥控或让外部客户端接入，那是现成的说明书。**
>
> **它没有给你的是"必须追上它"的压力** —— 你是自用，它是产品。

---

## 附：取文件的方法

```
https://raw.githubusercontent.com/Px-asen/Twilight_Echo/main/audio-engine/README.md
https://raw.githubusercontent.com/Px-asen/Twilight_Echo/main/docs/audio-engine-api.md          ← ⭐ 最重要，双状态模型全文
https://raw.githubusercontent.com/Px-asen/Twilight_Echo/main/docs/release-capability-status.md ← 三维能力模型
https://raw.githubusercontent.com/Px-asen/Twilight_Echo/main/audio-engine/analysis/LoudnessAnalyzer.cpp
https://raw.githubusercontent.com/Px-asen/Twilight_Echo/main/audio-engine/output/wasapi/WasapiFormatNegotiator.cpp
https://raw.githubusercontent.com/Px-asen/Twilight_Echo/main/audio-engine/tests/bitperfect_tests.cpp
```

**稀疏克隆**（`main.cpp` 类大文件多，不要整取）：

```
git clone --filter=blob:none --sparse https://github.com/Px-asen/Twilight_Echo.git
cd Twilight_Echo && git sparse-checkout set docs audio-engine/analysis audio-engine/output/wasapi
```

> ⚠️ **不要整读**：`runtime_queue_reroute_tests.cpp`（**224 KB**）、`asio_backend_tests.cpp`（103 KB）、
> `audio-engine/CMakeLists.txt`（43.7 KB）。用 grep 定位。
