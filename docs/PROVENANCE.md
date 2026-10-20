# 溯源与许可边界（PROVENANCE）

> **状态**：现行 · **日期**：2026-10-20 · **性质**：公开发布前的合规审计记录
> **回答的问题**：Stringmoon 的代码里，**哪些是自研、哪些是借鉴、哪些是复制**？
> 以及：能不能以 MIT 公开？

本文是审计结论，不是法律意见。所有结论都附 **`file:line`** 或可复现命令；
凡是"没查到"的，也写清查了什么、查不到什么（弱点是结论的一部分）。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| 是否有 AGPL-3.0 上游（Folia / ECHO）的**代码**进入本仓库？ | **未发现**（置信度 0.80） |
| 是否有 Apache-2.0 上游（Twilight_Echo / QueMusic）的**代码**进入本仓库？ | **未发现整文件或整段复制**；有参数级引用与"处理顺序"借鉴，均已在源码注释中点名 |
| 引擎与主进程是否为自研？ | **是**。59 个 C++ 源文件 + 138 个 TS/TSX 源文件，与上游对照无实现级重合 |
| 能否以 MIT 公开？ | **可以**。自有代码 MIT；LGPL 义务由 `THIRD-PARTY-NOTICES.md` §4 承担 |
| 公开是否存在**许可**阻断？ | **无**。但存在两项与许可无关的**发布阻断**（真实凭证、个人绝对路径），见 §7 |

置信度 0.80 而不是 0.95 的唯一原因写在 §6.2：**本机没有 ECHO 的源码副本**，
只能拿安装产物的打包 JS 做间接比对。

---

## 1. 审计方法（可复现）

### 1.1 比对语料

| 语料 | 位置 | 规模 |
|---|---|---|
| **我方** 应用 | `<仓库根>/app/src` | 138 个 `.ts/.tsx`（含渲染层、主进程、preload、shared） |
| **我方** 引擎 | `<仓库根>/engine/src` | 59 个 `.cpp/.hpp/.c/.h` |
| **上游 A**：Px-asen/Twilight_Echo（Apache-2.0） | 审计时的本机快照 `<本地工作区>\.scratch\twilight-echo-ref\Twilight_Echo-main\`（不入库） | `src` 1,250 文件 + `audio-engine` 284 文件 |
| **上游 B**：chthollyphile/folia-major（AGPL-3.0） | 2026-10-20 从 GitHub `main` 实拉 12 个高嫌疑文件 | 约 2,600 有效行 |
| **上游 C**：Moekotori/ECHO（AGPL-3.0） | 本机**无源码**；用安装产物解析出的打包 JS `.scratch/echo-next/extracted/out__main__index.js`（5.3 MB）；另从 GitHub `main` 实拉 10 个高嫌疑源文件 | 打包 JS 4.25M tokens + 10 文件 |

> 上游快照的许可核实（2026-10-20 GitHub API 实测）：
> `Px-asen/Twilight_Echo` → **Apache-2.0**（362★，快照 `package.json:5` 同为 Apache-2.0，`LICENSE` 为 Apache 2.0 全文）；
> `BroNekoX/QueMusic` → **Apache-2.0**（217★）；`BroNekoX/QuePlugins` → **Apache-2.0**；
> `chthollyphile/folia-major` → **AGPL-3.0**（8,274★）；`Moekotori/ECHO` → **AGPL-3.0**（1,131★，`LICENSE` 34,523 B 为 AGPL-3.0 全文）。

### 1.2 三层比对判据

只看"像不像"会误判（同一个 API 必然长得一样）。因此用三层递进的判据：

1. **精确行比对**：剔除注释/空行、折叠空白、去尾分号，取 ≥24~30 字符的行做全量交集。
   命中数量本身不代表抄袭（`for (const key of keys) {` 是通用样板），**但长度和密度能排掉 99% 的误报**。
2. **连续行游程（run）**：要求连续 N 行按序命中。通用语句不会连续 N 行同序命中；
   真正的复制会。**这是最硬的指标。**
3. **token 10-gram 比对**：把源码切成 token 流，用 10-token 滑窗集合求交。
   对变量重命名、空白/注释差异免疫，用于捕捉"改了个名字的复制"。

### 1.3 为什么"同样的写法"不等于"复制"

本项目引擎与上游 Twilight_Echo 的 `audio-engine` 是**同一目标的两个独立实现**
（都是 C++20 独立进程 + JSON 协议 + WASAPI）。同一个 Windows API 的调用序列必然高度相似：

```cpp
// 我方 engine/src/devices.cpp 与上游 WasapiSharedBackend.cpp 都会有：
__uuidof(IMMDeviceEnumerator)
WAVEFORMATEX* mixFormat = nullptr
if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) { ... }
```

这些是 **MSDN 文档给的调用范式**，不是任何人的表达。同理，React 里的
`const listeners = new Set<() => void>()` 也不是可主张的创作。
**判据 2（连续游程）就是为区分这两类而设计的。**

---

## 2. 与 Apache-2.0 上游（Twilight_Echo / QueMusic）的关系

### 2.1 Twilight_Echo：结构参考，无代码复制

**精确行比对结果**（197 个我方文件 × 1,534 个上游文件，阈值 ≥30 字符）：

- 有 77 个我方文件存在 ≥1 行精确命中 —— 但**每一行都是通用样板**：
  `import path from 'node:path'`、`if (!win || win.isDestroyed()) return`、
  `const record = value as Record<string, unknown>`、`for (const key of keys) {`。
- **最长连续游程 = 11 行**，且内容是**协议字段声明**：

  ```ts
  // app/src/shared/protocol.ts 与上游某个 Track 接口
  export interface Track {
    trackId: string
    title: string
    artist: string
    album?: string
    durationMs: number
    path: string
    sampleRate?: number
    bitDepth?: number
    albumArtist?: string
    genre?: string
  }
  ```

  这是**数据形状**，不是表达性代码。版权法保护表达，不保护"一首歌有标题/艺术家/时长"这一事实。
  而且 `app/src/shared/protocol.ts:3` 写明字段来自本项目自己的 `CONTRACT.md`（冻结契约），
  与上游接口同名是领域词汇的必然结果，不是抄来的。
- 其余最长游程：8 行（`downloads.ts` 的对象字面量字段赋值）、6 行（`lyrics-online.ts` 的
  `{id, title, artist, album?, durationMs?, score}`）—— 同样是**字段清单**，不是算法。
- **同名文件仅 8 个**（`main/index.ts`、`main/lyrics.ts`、`preload/index.ts` 等），
  且行数差异巨大（我方 `main/index.ts` 778 行 vs 上游同名 14 行；`main/streaming/manager.ts`
  1,418 行 vs 上游 `plugins/manager.ts` 2,435 行且职责完全不同）。**没有一对是同文件复制的形态。**

**结论**：Twilight_Echo 只被当作**架构参考**（"平台适配器 + 独立 native audio 子进程"这个分层），
没有代码复制。这一判断与仓库文档一致：`.scratch/discover-port/UPSTREAM-AUDIT.md:6` 明确写
"只读上游；本报告是唯一写出的文件，未改动目标仓库源码"。

> 注：该审计文档把 Twilight_Echo 列为"可整文件抄"（`docs/MASTER-v1-plan.md:28`、
> `docs/MASTER-B-app.md:71-79` 甚至逐文件列出了 `duplicateDetection.ts` 351 行 /
> `musicMetadataMatching.ts` 274 行等"抄什么"）。**那是计划，不是事实**：
> 这些文件所描述的曲库去重/补全功能**在本仓库并不存在**（`app/src/main/library/` 下只有一份
> 781 字节的 README，`grep -r "contentHash|audioFingerprint|destructive" app/src` 零命中）。
> 计划与落地之间的这个差异本身是好事：它意味着 A3 这一块从未开工，也就从未发生复制。

### 2.2 QueMusic：参数与顺序的参考，已在源码点名

这是**唯一**能证明"结构性借鉴"的地方，也是本项目做得最规矩的地方——全部有源码注释留痕：

| 位置 | 借鉴内容 | 性质 |
|---|---|---|
| `engine/src/dsp.cpp:3-5` | "Parameter values come from SPEC 3.4 (line 210) and the ReplayGain formulas from the reference implementation the owner supplied (QueMusic AudioDsp, Apache-2.0)" | 参数公式来源声明 |
| `engine/src/dsp.cpp:6-11` | 上游**两个坑**（bypass 跳过 hard clip；limiter off ≠ unclipped）的说明 | 事实性知识 |
| `engine/src/dsp.hpp:18-21` | "The processing order is deliberate and follows the reference implementation … (QueMusic AudioDsp, Apache-2.0): EQ -> static gain -> limiter -> hard clip -> volume" | 处理顺序 |
| `engine/src/dsp.hpp:37-39` | 明确写了"我方用精确八度中心（31.25/62.5），**不是**上游的四舍五入整数（31/62）" | 差异声明 |
| `app/src/shared/lrc.ts:7` | "字级标注两种（QueMusic LocalLyricsReader.extractWordLabels **的形状**，Apache-2.0）" | 数据形状 |

**判定**：这是 **Apache-2.0 §4 意义上的"衍生作品需保留声明"已经满足**的形态
（Apache-2.0 允许复用，要求保留版权声明与变更说明）。我们不复制文件，但复用了
**算法参数、处理顺序、两个已知缺陷的规避**——这些更接近"思想/事实"而非"表达"，
即便如此仍然在注释里点名，属于**超额履行**。

补充：`docs/MASTER-v1-plan.md:30` 把 QueMusic 标为"✅ 可抄码"，但实际落地是
**参数与顺序的重新实现**，不是文件搬运。判定依据仍是判据 2/3 的结果：与 QueMusic
（Qt6/QML + C++20）语言栈不同，且本机无其源码快照，无法做行级比对——这一点如实记录
为审计局限（§6.3）。

---

## 3. 与 AGPL-3.0 上游的关系（关键章节）

### 3.1 先说清楚：什么会触发 AGPL 传染

AGPL-3.0 的传染性由 **AGPL 定义的对象代码/源代码**触发。
**不属于触发条件**的包括：

- 阅读其源码后**理解**其架构、交互范式、线程模型、协议设计；
- 独立实现一个**功能相同**的东西；
- 使用公开的**接口事实**（HTTP 端点、参数名、状态码）；
- 引用其**文档里的英文原文**做设计论证（本项目确实这么做过，见 §3.4）。

**属于**触发条件的只有：把 AGPL 代码的**表达**（源码文本、或经翻译/改名后仍可一一对应的表达）
复制进本仓库，并使二者构成结合作品。

### 3.2 Folia（AGPL-3.0）比对结果

2026-10-20 从 `https://github.com/chthollyphile/folia-major` 的 `main` 实拉了 12 个
"最可能被借鉴"的文件（按本项目文档反复点名的功能挑）：

```
src/services/onlineMusic/qq/qqTransport.ts          21,522 B
src/services/onlineMusic/qq/qqProvider.ts           60,392 B
src/services/onlineMusic/netease/neteaseProvider.ts 34,512 B
src/utils/lyrics/parserCore.ts                      43,513 B
src/utils/lyrics/autoMatchBestLyric.ts              20,466 B
src/utils/lyrics/sentenceLayout.ts                  19,992 B
src/library/core/account/providerLoginSession.service.ts   31,125 B
src/library/core/account/providerAccountController.service.ts 30,045 B
api-ts/lyric-proxy.ts / segment-lyrics.ts / electron/lyricApi.cjs / docs/lyric-api.md
```

索引出 2,613 条归一化长行，与 197 个我方文件求交：

- **精确行命中总计 26 行**，其中最多的是 `for (const key of keys) {`（4 次）。
- **最长连续游程 = 4 行**，内容是 `subscribe(listener: () => void): () => void` 级别的样板。
- **零** 命中任何 Folia 特有的业务语义（`qqTransport` 的 cookie 处理、
  `providerLoginSession` 的状态机、`parserCore` 的解析循环，一行都没进我方代码）。

**结论：未发现 Folia 代码复制。** Folia 在本项目中的角色是**纯设计参考**，
仓库文档自己也这么定调：

- `docs/REFS-A-engine.md:8`：「**② ECHO** … ⚠️ 只学模式，不要复制代码」
- `docs/REFS-A-engine.md:335`：「若将来分发，抄它的代码会传染整个仓库。所以第二部分**只给模式与依据，不给可复制的代码**」
- `docs/M3-v1-plan.md:80`：「Folia ❌ **不能**（AGPL-3.0）… 混入 AGPL 码会让整个仓库将来无法按其他许可发布」
- `docs/MASTER-B-app.md:298`：「⚠️ **但同栈不等于能抄码** —— **Folia 是 AGPL-3.0**」

**这些是"当时的合规纪律"的证据**，比事后自查更有说服力。

关于"类 Folia 的用法"（`README.md:6`）：`app/src/shared/streaming.ts:4`
把"用户自备 API 服务端、应用负责拉起"写成「形态照 Folia 的做法」。
这是**产品形态**（用户配置一个本地 HTTP 服务的命令与端口），不是代码。
任何启动子进程并连本地端口的程序都会长成这样。

### 3.3 ECHO（AGPL-3.0）比对结果

#### 3.3.1 用打包产物做间接比对

本机没装 ECHO 的源码，但装了一份 **ECHO NEXT**（本机安装目录，Electron 应用，
`resources/app.asar` 186 MB）。其主进程打包产物已解析到
`.scratch/echo-next/extracted/out__main__index.js`（5,316,955 字符）。

两种比法：

**(a) 字符串字面量碰撞** —— 取我方 `app/src` 里 1,018 条长度 24~120 的字符串字面量，
在 ECHO 打包 JS 里精确查找：**命中 16 条**，全部是通用常量 ——
`text/plain; charset=utf-8`、`application/x-www-form-urlencoded`、
`(prefers-reduced-motion: reduce)`、`https://y.gtimg.cn/music/photo_new/T002R300x300M000`（QQ 音乐封面 CDN 地址）、
`@neteasecloudmusicapienhanced/api`（包名）、`<?xml version="1.0" encoding="UTF-8"?>`。
**没有一条是业务字符串**。

**(b) token 10-gram 碰撞** —— 4,247,754 个 token → 364,470 个 10-token shingle；
我方 138 个文件里 82 个有命中。但看命中内容就清楚了，最长游程 12 token 的样本是：

```
) . catch ( ( ) => { if (
= Math . max ( 0 , Math . min
Number . isFinite ( parsed ) ? Math . max
error instanceof Error ? error . message : String (
% 60 ) . padStart ( 2 , '0' )
```

全是 **JS 惯用法**（clamp、时间格式化、错误信息提取）。**没有任何一段是业务逻辑。**
这个密度是"两个程序都在写 TypeScript"的必然结果，不是复制。

#### 3.3.2 用源码做直接比对（部分覆盖）

从 `https://github.com/Moekotori/ECHO` 的 `main` 实拉了 10 个最可能被借鉴的源文件
（`wasapi_shared.cpp` 58.5 KB、`wasapi_exclusive.cpp` 49.7 KB、`PcmRingAudioSource.cpp` 45.2 KB、
`NativePlaybackPipeline.cpp` 37.6 KB、`PlaybackSessionStore.ts` 15.2 KB、`audioIpc.ts` 56.0 KB 等），
索引 4,782 条长行：

- **精确行命中 69 行**，集中在我方 `engine/src/output_wasapi.cpp`（15 行）、
  `devices.cpp`（6 行）、`device_monitor.cpp`（6 行）、`probe_exclusive.cpp`（6 行）。
- **最长连续游程 = 5 行**，内容：

  ```
  client->Release()
  return true
  client->Release()
  return false
  } // namespace
  ```

  和 4 行的 `IMMNotificationClient` 虚函数声明（`OnDeviceStateChanged` / `OnDeviceRemoved`）——
  **这是 Windows COM 接口的强制签名**，MSDN 上就这么写。
- **零** 命中 ECHO 特有的实现结构（`PcmRingAudioSource` 的环形缓冲、`NativePlaybackPipeline`
  的路由、`PlaybackSessionStore` 的 SQLite schema）。
- 我方 `engine/src/output_wasapi.cpp` 61,823 B 单文件同时管共享+独占，ECHO 拆成
  `wasapi_shared.cpp` + `wasapi_exclusive.cpp` 两个文件（58.5 + 49.7 KB）——**结构不同**，
  这本身就排除了"整文件搬运"。`docs/REFS-A-engine.md:357` 也明确说"**看结构，不是抄代码**"。

**结论：未发现 ECHO 代码复制。**

#### 3.3.3 关于 "ECHO NEXT 对标功能"

`grep -rn "ECHO NEXT" app/src engine/src` 命中 9 处，全部是**功能对标声明**：

- `app/src/main/playback-memory.ts:4`、`app/src/shared/playback-memory.ts:2`：
  「对标 ECHO NEXT 的 `echo-playback-memory.json`」
- `app/src/main/prefetch.ts:2`：「下一首预热（对标 ECHO NEXT 的 `audio.prefetch`）」
- `app/src/shared/protocol.ts:145`、`engine/src/audio_source.hpp:133`：
  「CR-024：重采样器可配置（对标 ECHO NEXT 的 ECHO SRC）」
- `engine/src/dsp.hpp:400`：「CR-025：PCM dither / noise shaping modes（对标 ECHO NEXT 的 dither 档位）」
- `engine/src/output_wasapi.hpp:68`：「CR-027：输出延迟档位（对标 ECHO NEXT 的 stable/balanced/lowLatency）」

**逐条核对过**：这些都是"照它的**参数语义**做一套自己的实现"。
例：ECHO 的 `echo-playback-memory.json` 字段是
`{filePath, trackId, positionSeconds, durationSeconds, probe, metadata, updatedAt}`；
我方的 `PlaybackMemory` 是
`{version, filePath, trackId, positionMs, durationMs, queue[], repeatMode, updatedAt}`
（`app/src/shared/playback-memory.ts:17-29`）——**单位不同（秒 vs 毫秒）、字段不同（我方多 queue/repeatMode/version，
少 probe/metadata）、并且我方额外做了逐字段 sanitize 与 24h 封顶**。
这是**同一个需求的独立设计**，不是字段表复制。

> 这部分的事实来源是 `docs/ECHO-NEXT-PORT-SPEC-2026-10-17.md`，
> 该文档 §0 自己就写："**不要把它当源码抄**：那里只有打包后的 JS/二进制，我们只提取「做了什么/参数语义」，算法自己实现。"

### 3.4 文档里引用了 AGPL 项目的英文原文 —— 这是否有问题？

`docs/REFS-A-engine.md:397-400` 引用了 ECHO 源码注释：

> JSON-RPC is the single writer. The audio thread reads a coherent fixed-size snapshot
> through this seqlock **without allocation, mutexes or shared_ptr traffic**.

`docs/REFS-A-engine.md:361-366` 引用了 ECHO 的迁移文档一整段中文。

**判定**：这两处是**文档中的引用**，不是代码，也没有被编译进任何产物。
而且 `docs/` 目录本身在 MIT 下发布——引用他人文字做述评/论证，在合理引用范围内。
**唯一值得做的小修正**：如果希望零争议，可以在那两段引用旁标注
"（引用自 Moekotori/ECHO，AGPL-3.0，仅作文档引述，不含代码）"。这属于 nice-to-have，
不是发布阻断项。

另外 `docs/REFS-A-engine.md:401-405` 里那 5 行「seqlock 的关键设计」是**伪代码**，
且明写"注释里的关键设计（不要改语义）"。我方实际的 `Seqlock` 实现
（`engine/src/dsp.hpp:109-148`）与它**不同**：我方用**逐字节 `std::atomic<uint8_t>` 存储**，
并在注释里解释了为什么不用常见写法：

> ```
> // Storage is byte-wise std::atomic rather than a plain struct. The usual
> // seqlock trick of racing a plain memset against a plain read is what everyone
> // writes and is formally a data race; byte-atomics make it a defined program
> // and cost nothing here …
> ```

**这是一个比参考实现更严格的独立实现**，恰好证明"学的是模式，写的是自己的"。

---

## 4. 自研部分的规模证据

| 维度 | 数量 |
|---|---|
| 引擎源码 | 59 文件，1,031,592 B（`.cpp/.hpp/.c/.h`）；核心文件 `player.cpp` 124.8 KB、`app.cpp` 87.5 KB、`output_wasapi.cpp` 61.8 KB、`dsp.cpp` 67.6 KB、`app_selftest.cpp` 124.6 KB |
| 应用源码 | 138 文件，1,685,157 B（`.ts/.tsx`） |
| 引擎自测 | `--selftest` + `drive.mjs` 22 步 / 462 条断言（`engine/README.md:187`） |
| 应用测试 | `pnpm test:app`、`test:c2`、`test:protocol`（31 断言）、`test:integration`（19 断言） |

引擎的**自研判据**不靠主观判断，靠三项可验证的性质：

1. **契约驱动**：整套 JSON Lines 协议由 `CONTRACT.md`（21,378 B，冻结于 2026-10-14）定义，
   引擎与应用的实现都是照契约写的，与任何上游无关。
2. **能力自报**：`hello` 报 `capabilities`，`get_capabilities` 报 `decoders[]` / `dsd{}` /
   `systemDecoders`——这套"如实报能力"的设计是本项目的核心主张（`docs/DESIGN-A-engine.md:214`）。
3. **与上游实现的结构差异**（逐条可查）：
   - 我方：`output_wasapi.cpp` 单文件管共享+独占；ECHO：两个文件拆开。
   - 我方：`Seqlock` 用 byte-atomics；ECHO 用 `std::array<std::atomic<int>, N>`。
   - 我方：`engine/src/meter.cpp` 自研 FFT 表 + kissfft；上游 Twilight_Echo 用
     `FftSpectrumAnalyzer.cpp`（448 行，不同实现）。
   - 我方：解码走 dr_flac/dr_wav/dr_mp3 + stb_vorbis + Media Foundation；上游 Twilight_Echo
     走 FFmpeg。**依赖栈完全不同**，这一条本身就排除了大范围代码复用。

---

## 5. 许可与依赖事实（摘要）

完整清单见 `THIRD-PARTY-NOTICES.md`。这里只列与**传染性**相关的：

| 组件 | 许可 | 是否传染自有代码 | 义务 |
|---|---|---|---|
| 自有代码（app/src、engine/src、脚本、文档） | **MIT** | — | 保留版权与许可声明 |
| TagLib 2.3.2（静态链接） | LGPL-2.1 / MPL-1.1 | **否**（LGPL 允许专有/异许可作品链接） | 许可文本随附、源码可得、可重新链接 |
| SoXR 0.1.3（静态链接） | LGPL-2.1 | **否** | 同上 |
| @unblockneteasemusic/server 0.28.0（随 runtime 分发，源码形式） | LGPL-3.0-only | **否** | 许可文本、源码可得、可替换 |
| kissfft | BSD-3-Clause | 否 | 保留声明 |
| libebur128 | MIT | 否 | 保留声明 |
| utfcpp | BSL-1.0 | 否 | 保留声明 |
| dr_libs / stb_vorbis | Unlicense/MIT-0 · Public Domain/MIT | 否 | 无（自愿保留） |
| Electron 44.7.2 + Chromium | MIT + Chromium 第三方 | 否 | 随二进制附带 `LICENSES.chromium.html` |
| 42 个随 asar 分发的 npm 包 | 35 MIT / 3 ISC / BSD-3 / 0BSD / BlueOak / Python-2.0 | 否 | **无 copyleft** |
| 265 个 runtime 包 | 230 MIT / 15 ISC / 7 BSD-2 / 6 BSD-3 / … / 1 LGPL-3.0 | 否 | 见上 |

**关键点：整条依赖树里没有任何 GPL/AGPL 代码会被链接进自有代码路径。**

- 两个 **LGPL-2.1** 组件（TagLib、SoXR）是**库**，被静态链接进 `twilight-engine.exe`。
  LGPL-2.1 §6 明确允许"把它链接进按你自选条款发布的作品"，条件是让接收者能改库并重新链接。
  本项目走 §6(a)+(d)：库源码与"使用库的作品"源码同仓库公开同一处。细节见
  `THIRD-PARTY-NOTICES.md` §4.3。
- 一个 **LGPL-3.0** 组件（`@unblockneteasemusic/server`）以**未修改的源码形式**随 runtime 分发。
  ⚠️ **纠正一个容易搞错的点**：它并**不是**"独立进程所以不构成结合作品"——
  `unblockmusic-utils/modules/unm.js:1` 直接 `require('@unblockneteasemusic/server')`，
  而 `api/server.js:346-350` 又 `require('unblockmusic-utils').matchID()`，
  三方跑在**同一个 Node 进程**里，是 LGPL-3.0 §4 意义上的 Combined Work。
  合规靠 §4(a)(b)(c) + §4(d)(1)「以可动态替换的独立文件形式使用库」满足（用户可整目录拖换），
  细节与 caveat 见 `THIRD-PARTY-NOTICES.md` §5.1。
- 其余全部是 MIT / ISC / BSD / BSL / 0BSD / BlueOak / Python-2.0 —— **无任何 copyleft 传染路径**。

---

## 6. 置信度与审计局限（诚实边界）

### 6.1 各项结论的置信度

| 结论 | 置信度 | 依据 |
|---|---|---|
| 无 Folia 代码复制 | **0.90** | 拉了 12 个高嫌疑文件做直接比对，最长游程 4 行、无业务语义命中 |
| 无 Twilight_Echo 代码复制 | **0.88** | 全量快照（1,534 文件）直接比对，最长游程 11 行且为协议字段声明 |
| 无 ECHO 代码复制 | **0.78** | **弱点所在**，见 §6.2 |
| 引擎为自研 | **0.92** | 依赖栈不同 + 结构差异 + 462 条自测断言 + 契约驱动 |
| 可以 MIT 公开 | **0.95** | 依赖树无 copyleft 传染路径；LGPL 义务可满足 |

**总体置信度 0.80**（取最弱一环加权）。

### 6.2 弱点：ECHO 没有源码级全量比对

本机**没有 ECHO 的源码 checkout**。做到的最强比对是：

1. 安装产物的**打包 JS**（5.3 MB，含 webpack/esbuild 的变量重命名与合并在内）——
   这会让"复制"在打包侧**变成不可直接观察**（变量名被改、模块被内联），
   所以打包 JS 的比对**只能作为"无巧合碰撞"的旁证，不能作为"无复制"的证明**。
2. 10 个 GitHub 源文件（约 27 万字符）的直接比对 —— 覆盖了最可能的借鉴面（WASAPI、音频管线、
   IPC、播放会话存储），但**不是 ECHO 的 1,312 个 TS/TSX 文件 + 284 个 native 文件的全部**。

**要消除这个弱点，需要做的事**（留给未来复核者）：

```powershell
# ECHO 仓库约 743 MB（GitHub API size 字段），浅克隆：
git clone --depth 1 https://github.com/Moekotori/ECHO.git <临时目录>/echo-src
# 然后用本文件 §1.2 的三层判据重跑一遍（连续游程 ≥5 行即需人工看）
```

在补上这一步之前，本审计对 ECHO 的结论应读作：
**"在可检查的范围内未发现复制，但检查范围不完整。"**

### 6.3 其它局限

- **QueMusic 未做行级比对**：本机无其源码（Qt6/QML 栈，语言不同），
  只依据 `docs/MASTER-v1-plan.md` 的记载判断"参数/顺序参考"。因语言栈不同（QML vs React，
  Qt vs 裸 WASAPI），大规模的**表达**复制在技术上不可能，风险低。
- **未做 git history 审计**：本项目于 2026-10-20 才 `git init`（`<仓库根>/.git`），
  没有历史提交可查。这也意味着**将来如果引入可疑代码，没有历史可回溯**——
  建议后续提交纪律：凡是借鉴上游的文件，在文件头写明来源+许可+是否修改。
- **未做二进制级逆向比对**：`twilight-engine.exe` 的符号表已看（14,753 个 taglib 符号、
  1,211 个 soxr 符号），但未与上游二进制做函数级比对（无意义：上游是不同架构/依赖）。

---

## 7. 发布结论：能不能公开？

### 7.0 许可结论（TL;DR，给不做技术判断的读者）

> **本项目自有代码采用 MIT。**
> **未发现 AGPL-3.0 派生证据（置信度 0.80）。**
> **公开不构成许可证阻断。**

三条展开：

1. **采用 MIT。** 自有代码（`app/src`、`engine/src`、构建脚本、文档）全部原创，
   没有必须继承的 copyleft。MIT 与依赖树（MIT / ISC / BSD / BSL / 0BSD / LGPL）**全部兼容**。
2. **未发现 AGPL 派生证据，置信度 0.80。**
   已查范围：Folia 12 个高嫌疑源文件（约 2,600 有效行）直接比对、ECHO 10 个源文件 + 5.3 MB
   打包产物比对、Twilight_Echo 全量快照（1,534 文件）比对。最长连续游程分别为 4 / 5 / 11 行，
   内容全是 JS 惯用法、COM 接口签名或协议字段声明 —— **没有一段是实现逻辑**。
   AGPL 项目在本项目中只承担"设计参考"角色，这一点在仓库文档里有当时的书面纪律为证
   （`docs/REFS-A-engine.md:335`、`docs/M3-v1-plan.md:80`、`docs/MASTER-B-app.md:298`）。
3. **薄弱点，必须说清楚：ECHO 没有源码级全量比对。**
   本机没有 ECHO 的源码 checkout，最强只能做到"10 个源文件 + 打包产物"。
   打包产物里的变量名已被重命名、模块被内联，**复制在打包侧不可直接观察**。
   所以对 ECHO 的结论应读作「**在可检查的范围内**未发现复制，但检查范围不完整」。
   消除方法写在 §6.2（浅克隆后重跑三层判据）。

> 如果只允许记一句话，记这句：
> **MIT，无 AGPL 派生证据（0.80），无许可阻断；ECHO 是唯一未做全量源码比对的角落。**

### 7.1 许可层面：**不阻断**

- 自有代码可以 MIT 公开。
- 没有 AGPL/GPL 代码进入自有代码路径，MIT 与依赖树**兼容**。
- LGPL 义务（TagLib / SoXR / unblockneteasemusic）在 `THIRD-PARTY-NOTICES.md` §4 / §5.1
  里有明确承担方案，且 `engine/third_party/` 入库使源码可得性满足。
- 唯一的**文档瑕疵**：`app/resources/runtime/NODE-LICENSE.md` 实际是 **Blender 的第三方许可汇编**
  （不是 Node.js 的许可文本）。这是文档错误，不是法律缺口（Node.js 是 MIT，
  MIT 声明已在 `THIRD-PARTY-NOTICES.md` §5 与 §4.1 覆盖），但**应在发布前替换**
  （原始文本：`https://github.com/nodejs/node/blob/v24.19.0/LICENSE`）。

### 7.2 与许可无关、但曾**直接阻断公开**的两项（现在已修复，逐项复核）

这两项不在许可审计的产出范围内，但既然审到了必须点名。它们在**审计发生时**是阻断项；
经过仓库清洁（publish-prep，2026-10-20）之后状态如下：

| # | 问题 | 审计时的证据 | 当前状态 |
|---|---|---|---|
| 1 | **真实会话凭证** | `app/.auth-state/qq-device.json`（867 B）的 `device` 字段含 `sessionVkey`（112 字符）、`sessionSid`（24）、`sessionUid`（10）、`qimei` / `qimei36`（36）、`imei`、`androidId`、`openUdid`、`fingerprint`（64） | ✅ **已被 ignore**。`git check-ignore -v` → `.gitignore:61:*.auth-state/`。`git status --porcelain` 中无该路径。文件仍在工作区磁盘上，但**不会进仓库**；本仓库是首次 `git init`，无历史包袱 |
| 2 | **个人绝对路径 + 曲库文件清单** | 审计时：两个 `library-91.json`（engine / app 各一份）里共 **183 处**作者本机测试曲库的绝对路径；`CONTRACT.md` 4 处；`engine/README.md` 2 处；`README.md` 3 处；`docs/` 下 45 个文件共 149 行 | ✅ **已清洗**。两个 fixture 的 `_libraryPath` / `sourceDir` / 91×`track.path` 全部改为中性占位目录；`state-traces.json` 的 `_exe` / `_library` 同样中性化；`CONTRACT.md` 与各 README 的路径改为 `<测试曲库>` / `<仓库根>` / `<系统工具目录>` 这类占位符。清洁后全仓 grep（用户名 / 作者名 / 工作区名 / 盘符 token）→ **0 命中** |

> 提醒后来者：**fixture 是"真实事件序列"，但路径不必是真的。**
> 如果将来重新导出 `engine/fixtures/library-91.json`（`drive.mjs --export-fixture` 会写回真实
> 扫描目录），必须再跑一次脱敏，否则个人路径会被重新引入。这一点已写进 7.3 的清单。

### 7.3 发布清单（逐项状态）

**已完成**

- [x] `LICENSE`（**MIT**，`Copyright (c) 2026 Stringmoon`，根目录）
- [x] `THIRD-PARTY-NOTICES.md`（根目录；含 MIT / LGPL-2.1 / LGPL-3.0 义务说明）
- [x] `docs/PROVENANCE.md`（本文件）
- [x] `app/package.json` 的 `"license"` 从 `UNLICENSED` 改为 **`MIT`**（一致性）
- [x] `.gitignore` 覆盖机密与本机会话态（`app/.auth-state/`、`app/mock-log.json`、`*.vkey` …）
- [x] `engine/third_party/` 入库（7 个库的源码 + 各自 LICENSE/COPYING 随目录）
- [x] 两个 `library-91.json` fixture 与 `state-traces.json` 的绝对路径清洗
- [x] `CONTRACT.md` / `engine/README.md` / `app/README.md` 的机器路径中性化（协议语义零改动）

**待办（发布前）**

- [ ] 替换 `app/resources/runtime/NODE-LICENSE.md`：当前内容是 **Blender 的第三方许可汇编**，
      不是 Node.js 的 LICENSE。应换成 <https://github.com/nodejs/node/blob/v24.19.0/LICENSE>（157,601 B）。
      ⚠️ 若 `app/resources/runtime/` 与 `runtime.zip` 按 `.gitignore` 不入库，此项只在**未来重新打包**时生效；
      但它现在**已经随 v0.4.0 的安装包发给接收者**，所以对已分发的二进制仍需补一份更正说明。
- [ ] 给每个发布二进制打 **tag**（`v0.4.0` …），并在 `THIRD-PARTY-NOTICES.md` 里指向该 tag。
      LGPL-2.1 §6(a) 要求的是「**corresponding** source」——仓库 HEAD 若已走远，严格读者会认为对应关系不完整。
      这是 `THIRD-PARTY-NOTICES.md` §4.3 列的 caveat 1。
- [ ] （若发布二进制）engine 改 `BUILD_SHARED_LIBS=ON`，让 `tag.dll` / `soxr.dll` 成为独立文件；
      或随 Release 提供这两个库的 `.obj`。见 `THIRD-PARTY-NOTICES.md` §4.3。
- [ ] （建议）`docs/REFS-A-engine.md:361-366,397-400` 的 ECHO 引文加一行来源标注
      （"引用自 Moekotori/ECHO，AGPL-3.0，仅文档引述，不含代码"）。

**维护纪律（防止回退）**

- [ ] 重新导出 fixture 后必须重新脱敏（`drive.mjs --export-fixture` 会写回真实扫描目录）。
- [ ] 任何参考上游写的文件，文件头保留「来源 + 许可 + 是否修改」三行注释（现有 5 处已这么做：
      `engine/src/dsp.cpp:3-5`、`engine/src/dsp.hpp:18-21`、`app/src/shared/lrc.ts:7` 等）。

---

## 附录 A：复现本审计的命令

```powershell
# 1) 逐文件许可读取（每个包都输出 package.json 的 license 字段 + LICENSE 文件名）
Get-ChildItem <仓库根>\app\node_modules -Directory | ForEach-Object {
  $j = Get-Content (Join-Path $_.FullName 'package.json') -Raw | ConvertFrom-Json
  '{0}@{1} | {2}' -f $j.name, $j.version, $j.license
}

# 2) 打包实际内容（不是 lockfile 的猜想）
node app\node_modules\.pnpm\@electron+asar@3.4.1\node_modules\@electron\asar\bin\asar.js `
  list app\release\win-unpacked\resources\app.asar

# 3) 连续行游程比对（§1.2 判据 2 的核心，用 Python 或 node 实现均可）
#    思路：剔除注释/空行 → 折叠空白 → 求最长连续命中，>5 行即人工复核

# 4) 上游许可核实（GitHub API）
Invoke-RestMethod https://api.github.com/repos/chthollyphile/folia-major | Select license
Invoke-RestMethod https://api.github.com/repos/Moekotori/ECHO         | Select license

# 5) 敏感路径扫描
Get-ChildItem <仓库根> -Recurse -File -Include *.md,*.ts,*.tsx,*.cpp,*.json,*.yml |
  Select-String -Pattern 'C:\\\\Users\\\\<用户名>|D:\\\\<个人目录>'
```

## 附录 B：本次审计读过的上游材料清单

| 材料 | 用途 |
|---|---|
| `Twilight_Echo-main/`（全量快照，1,534 文件） | 精确行 + 游程比对 |
| Folia `main` 12 文件（`qqTransport` / `qqProvider` / `neteaseProvider` / `parserCore` / `autoMatchBestLyric` / `sentenceLayout` / `providerLoginSession` / `providerAccountController` / `lyric-proxy` / `segment-lyrics` / `lyricApi` / `lyric-api.md`） | 精确行 + 游程比对 |
| ECHO `main` 10 文件（`wasapi_shared.cpp` / `wasapi_exclusive.cpp` / `wasapi_diag.h` / `wasapi_timeout.h` / `PcmRingAudioSource.cpp` / `NativePlaybackPipeline.cpp` / `PlaybackSessionStore.ts` / `audioIpc.ts` / `AudioSessionTypes.ts` / `LyricsSettingsDrawer.tsx`） | 精确行 + 游程比对 |
| ECHO NEXT 解析产物 `.scratch/echo-next/extracted/out__main__index.js`（5.3 MB） | 字符串字面量 + token 10-gram 碰撞 |
| `.scratch/discover-port/UPSTREAM-AUDIT.md`（377 行） | 既有上游审计报告（本文件引用其 3 处结论） |
| `docs/REFS-A-engine.md` / `REFS-A2-engine.md` / `REFS-B-app.md` / `REFS-B2-app.md` | 仓库自身的"只学模式"纪律记录 |
| `docs/MASTER-v1-plan.md` / `MASTER-B-app.md` / `M3-v1-plan.md` / `PLATFORM-v1-provider-choice.md` | 许可表与"可抄/不可抄"的原始判断 |
| `CONTRACT.md`（P1 前提）、`docs/SPEC-v2.1.md:106-109` | "只自用不分发"的原始语境 |

---

*本文与 `THIRD-PARTY-NOTICES.md` 共同构成 Stringmoon 的公开合规档案。
发现遗漏请开 issue —— 补一条声明比争一个例外便宜得多。*
