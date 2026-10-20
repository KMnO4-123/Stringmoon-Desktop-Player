# 三个播放器的可转化资产 · 给 AI-B（应用侧）

> **这不是契约。** 不影响 `CONTRACT.md` 与 `docs/SPEC-v2.1.md` 的权威性。
> 上位：[`REFS-B-app.md`](REFS-B-app.md)（QueMusic + ECHO 审计，本文件是其**续篇**）
> 本文件新增：**Folia**（AGPL，6350★）、**ECHOBridge**（AGPL）
>
> ⚠️ **许可纪律**：
> | 来源 | 许可 | 怎么用 |
> |---|---|---|
> | QueMusic / **Twilight_Echo** | **Apache-2.0** | ✅ 可直接抄代码（Twilight_Echo 归 A 侧） |
> | **Folia** / ECHOBridge / ECHOAndroid | AGPL-3.0 | ⚠️ **只学模式，不要复制代码** |
>
> **本文件 = §0 纠正 + §1 最高性价比 + §2 歌词流水线 + §3 取色 + §4 平台层 + §5 它为什么 6350★ + §6 行动**

---

## 0. ⚠️ 先纠正我上一轮说错的地方

**Folia 的真实元数据**（我上一轮报的有误）：

| 项 | 我上轮说的 | **实际** |
|---|---|---|
| 星数 | 6165 | **6350** |
| 创建时间 | 2026-11-28 | **2025-11-28**（早一年多） |
| forks | — | 614 |
| open issues | — | **52** |
| 语言 | TS | TS 21.7MB / JS 1.4MB / HTML 235KB / CSS 219KB / **Rust 69KB** / **Python 33KB** |

**我上一轮基于文档推断、后来被源码推翻的三处**：

| 我上轮的说法 | 源码事实 |
|---|---|
| 歌词动画是 CSS/Canvas | **PixiJS + WebGL**（`createLatticeLyricRuntime.ts` + 自定义 edge blur filter） |
| （未提曲库） | **没有 SQLite**，是 **Dexie/IndexedDB**（被浏览器存储逼出来的） |
| 播放层"没做音频质量的事" | **做了**：`playbackGraph.ts` 有 EQ + 效果链 + ReplayGain（Web Audio） |

> **这三处纠正很重要**：如果你按我上轮的描述去"参考它的做法"，会找错文件。

---

## 1. ⭐ 最高性价比：`latticeLyricFrameLoop.ts`（**1083 字节**）

**整份报告里投入产出比最高的一个文件。**

它的全部逻辑：

```ts
// 需求驱动 rAF：draw() 返回 moving 才继续下一帧
const moving = draw(delta)
if (moving) wake()           // 否则停下
app.ticker.stop()            // 静止即停

setVisible(false) → cancel   // 不可见直接取消
delta = Math.min(0.05, ...)  // 封顶：切回前台时不跳帧
```

**三条可直接抄进你的歌词层**：

| 规则 | 为什么 |
|---|---|
| **`draw()` 返回 `moving` 才调度下一帧** | 静止时不空转。你的歌词在暂停/无逐字时**应该完全停止 rAF** |
| **`setVisible(false)` 直接 cancel** | 你的主区/歌词视图可切换——**不可见时不该烧 CPU** |
| **`delta` 封顶 0.05s** | 窗口最小化再恢复时，`delta` 可能是几秒；不封顶会导致动画瞬移 |

**对你的额外优势**：它是 Web（时间从 rAF 拿），**你有引擎的 `position` 事件**——
所以你的版本更简单：**歌词进度直接由引擎时钟驱动，不需要自己累积 delta**。
`position` 事件本身就能告诉你"该动还是该停"。

> **结论**：抄它的**调度结构**（moving-gated + visibility-gated），但**时间源用你的引擎**。

---

## 2. ⭐ 歌词流水线：它全仓工程质量最高的部分

### 2.1 核心设计：**所有格式解码成中间态，不手写各格式解析器**

```
LyricParserFactory.ts (1.8KB)
  → 按 source.type 分发到 5 个 adapter（Embedded / Netease / Navidrome / LocalFile / Qrc）
  → 真正的解析全在 parserCore.ts (43KB)
  → 中间态：foliaLyricDocument.ts / ttmlConversion.ts / graphemeTiming.ts
             sentenceLayout.ts (20KB) / cjkSemanticLayout.ts (11.4KB)
```

**证据**：`src/utils/lrcParser.ts` 与 `yrcParser.ts` **各只有 258 字节**——纯 re-export shim。

**对你的意义**：你的 `src/shared/lrc.ts` 现在是"解析 LRC"。**如果将来要支持 TTML/VTT**，
按它的结构应该是「**多个解析器 → 一个中间态**」，而不是在 `lrc.ts` 里加 `if (format === 'ttml')`。

### 2.2 ⭐ `wordByWord` 的用法确认（你已经做对了）

它的 `docs/lyric-api.md` 明确规定：

> 逐行格式（LRC/VTT）进来后，**流水线强制合成逐字时间轴**，用顶层 `wordByWord: false` 标注"这是估算的"；
> **原生逐字（TTML/QRC）才 `true`**。

**这与你的 CONTRACT §4.3 完全一致**（你独立得出）。**报告特别指出**：

> 这个"原生/合成"布尔标记**比用 `words.length` 隐式判断干净**。

✅ **保持你现在的做法**，不要改成靠 `words.length` 判断。

### 2.3 分词：`realignSegmentsToText()` 是**与模型无关**的精华

**它用 LLM 做分词**（`shared/lyricSegmentationPrompt.mjs`），用途是：
**把没有逐字时间轴的整行文本切成"词"，让合成逐字轴按词而非按字分配**。

**为什么要 LLM**（它的实测）：CJK 无空格，`Intl.Segmenter` 对日语歌词给约 7 段/行**但语义断点不对**；
"抽象规则无效，日语示例行才把 9 行未切降到 1 行"。

**但真正值得抄的是它的对齐算法**（**与模型无关**）：

> `realignSegmentsToText()`：模型总把空格归一化，逐字比对会因一个尾随空格**废掉整首歌**。
> 于是**只信边界不信文本**——用原始行做游标消费非空白字符，
> **"输出的每一段都是原文切片，拼接等于原文是构造保证而非模型自觉"**。

**两条工程纪律**：

| 纪律 | 说明 |
|---|---|
| **只信边界，原文重建** | 不要让模型的输出文本成为事实来源 |
| **单行失败降级为 `null`** | 该行回退默认切分，**不抛错**；只有结构性错误（非 JSON / 行数不符）才抛 |

### 2.4 ⭐ 对你的建议：**本地分词优先，LLM 只兜底**

**它的做法**：每首歌调一次 LLM 做分词。
**你的更优解**：

| 语言 | 本地方案 | 成本 |
|---|---|---|
| 中文 | **jieba**（或 `nodejieba`） | 零延迟零成本 |
| 日文 | **kuromoji.js** / MeCab | 同上 |
| 兜底 | `Intl.Segmenter` | 内置 |

**建议**：**本地分词 → 只对失败行考虑 LLM**。
成本从"每首一次"降到"**每首零次**"，且**离线可用**（你是自用，不该依赖外部 LLM 服务）。
**`realignSegmentsToText` 的对齐逻辑照抄**（它是纯算法，不受许可影响的话可以照学思路）。

### 2.5 ⭐ 缓存分类学（一个教科书级细节）

> `src/services/lyricSegmentation.ts` 里，分词结果 key 前缀**故意用 `lyricSeg_` 而非 `lyric_`**，
> 因为 `lyric_` 会被 `cacheRepository` 的 'lyrics' 分类清扫——
> **用户清歌词缓存会静默销毁花过钱/花过手工的东西。**

**对你的意义**：你有 SQLite 与（将来的）缓存清理功能。**这条规则值得写进你的缓存设计**：

> **不同来源/成本的缓存必须分命名空间，否则"清理便宜的"会误删"贵的"。**

比如：在线下载的歌词（贵）vs 本地解析的歌词（免费）→ 不同前缀。
**手工修正过的歌词（最贵）→ 必须单独标记，永不随批量清理删除。**

### 2.6 逐字填充**按字形 advance 插值**，不是 per-char 均分

```
resolveMonetFillWidth 按 GraphemeTiming[] 插值已测量字形偏移
```

**对你的意义**：你的歌词逐字高亮如果按"字数均分"算宽度，**在中日文混排/全角半角混排时会不准**。
正确做法是**按已测量的字形宽度插值**。

**Web 侧实现**：`canvas.measureText()` 或 DOM `Range.getClientRects()` 拿每段实际宽度。
**推荐用 `GraphemeTiming`（字素簇）而非 code point**——组合字符（你的 91 首里就有 `Cytus - ͟͝͞Ⅱ́̕.flac`）会算错。

### 2.7 DPR 分辨率的实测教训

> `latticeLyricResolution(dpr) = Math.min(2, Math.max(1, Math.ceil(dpr)))`
>
> 注释记录了实测教训：**固定 2 在 1x 屏上让每帧多推 4 倍像素**过模糊/边缘 pass；
> **非整数比在 4K@125-175% 缩放时超采样不足会发虚**。

**对你的意义**：如果你用 Canvas 渲染歌词/频谱，**分辨率必须取整数比且上限 2**。

### 2.8 弹簧参数（可直接用）

```js
MONET_SCROLL_SPRING = { stiffness: 142, damping: 28, mass: 0.82 }
```

`resolveMonetTone` 按 status + 距离算 alpha/scale/blur。

> 与你的 `apple-design` 规范对照：这是**具名弹簧**（stiffness/damping/mass），
> 而 Apple 式是 `damping ratio + response`。**你的 DESIGN-v5 已选 Apple 式** ——
> **不要混用两套**，但可以拿它这组参数做一次手感对照。

### 2.9 优先级链（极简，值得对照）

```js
// sourcePriority.ts (1.2KB)
BASE = ['netease', 'amll', 'qq', 'kugou']
DEFAULT_PREFERRED = 'qq'
// 用户偏好置首 + 全量去重补全
```

**对照你的 CONTRACT §4.4**：你的链是「内嵌/本地 → AMLL → 网易云 yrc → LRCLIB 兜底」。
**它的链在第一位就不同**（它没有"本地优先"这一档——它是在线播放器）。
**但"用户偏好置首 + 去重补全"这个算法形状可以抄**：
如果你将来让用户在设置里选"歌词源偏好"，就用这个形状（把偏好的移到首位，其余按 BASE 顺序补全，去重）。

**另有值得知道的三个文件**（都在 `src/utils/lyrics/`）：
- `autoMatchBestLyric.ts`（**25KB**）——自动匹配打分主逻辑
- `matchScore.ts`（7.8KB）——打分算法
- `lyricOffsetMemory.ts`（3.5KB）——**按曲记忆时间偏移**（你 SPEC §6.2 提过"偏移校准存库"）

---

## 3. 封面取色：**它的弱项，你的强项**（报告明确说了）

### 3.1 它的做法（含一个真实的坑）

```js
// src/utils/colorExtractor.ts (4.5KB)
new Image() + crossOrigin = 'Anonymous'
→ 缩到 50×50 canvas → getImageData
→ 按饱和度排序 → RGB 欧氏距离 > 20 去重 → 取 N 色
```

**它踩的坑**：`loadImagePixels` 必须显式捕获 CORS 污染导致的 `SecurityError` 并 `resolve(null)`——
**注释指出：不捕获会让 Promise 永不 resolve。**

### 3.2 ⭐ 报告的核心结论：**这条路你不应该移植**

> 它的取色是"取几个代表色 → **直接当主题色**"，**没有色阶/对比度约束**（prompt 里一句"4.5:1"而已），
> **跨源污染就整条失败**。
>
> **我方（Twilight Echo）的三通道令牌若把"取色"降级为"给令牌提供种子色"，
> 再由令牌层保证对比度与色阶，是更高效也更稳的路线**：
> 原生侧读封面（**已在本地、无 CORS**）、**一次降采样即可，无需再经 canvas**。

**三条你的优势**：

| 它的约束 | 你的 |
|---|---|
| Web：封面必须走 HTTP/`crossOrigin`，**CORS 污染即失败** | **引擎侧读本地文件，无 CORS** |
| 只能 50×50 canvas + `getImageData` | 原生降采样，**任何尺寸** |
| 取色**直接当主题色**，无对比度保证 | **令牌层保证对比度**（你的 DESIGN-v5 §8 已有 R3） |

**结论**：**抄"取代表色作种子"的思路，落到你的令牌层**——但**实现走原生读封面**。
这也正好接上你 DESIGN-v5 的 `--cover-color-soft`（只驱动氛围光，不参与功能语义）。

**它另一条路**（`api-ts/generate-theme.ts` 12KB）：**Gemini 结构化输出**生成 light/dark 双主题 + `wordColors`（10-20 情绪词→色）+ `lyricsIcons`（Lucide 图标名）。
**这是"AI 生成主题"**。**对你的建议**：可以做，但**优先级低**——你的令牌系统已能保证质量，
且**它这条路正是你"不依赖外部 LLM"原则的反面**。

---

## 4. 平台接入层：三个可抄的概念

### 4.1 `PlayerCap` —— 音质能力协商会话

```
src/utils/playerCapMapping.ts (8.3KB)
src/utils/playerCapSession.ts (7.9KB)
src/utils/playerCapWebSource.ts (2KB)
```

**"PlayerCap" 是它的音质能力协商会话**。对照你的 CONTRACT §4.2 `MusicProvider.capabilities`——
**你的接口已经覆盖了**（`search` / `login` / `wordLevelLyrics` / `hiRes`）。
**但它把"会话"独立成一个模块**：音质档位不是请求时临时决定，而是**一个持续的会话状态**。
**这值得对照**：你的音质档位（128k/320k/flac）如果将来要做"随网络/设备自动降级"，会话化更干净。

### 4.2 ⭐ `sourceRevision` —— 播放源版本号

```
buildLocalSourceRevision / buildNavidromeSourceRevision
```

**用于判断重试时源是否已变**。

**对你的直接价值**：与你的 **CR-007（`operationId`）** 是**同一个问题的两种解法**——

| | 你（CR-007） | 它（`sourceRevision`） |
|---|---|---|
| 机制 | 每次 open 分配自增 id，事件带回 | 源（本地/Navidrome）计算版本号 |
| 解决的问题 | 过期响应 | **重试时源已变** |
| 关系 | **互补** | **互补** |

**建议**：两个都要。`operationId` 防"过期响应"，`sourceRevision` 防"源变了但我还在用旧缓存"。
（比如你 M3 接了 Navidrome 后，服务器换了一首歌的文件，客户端缓存没失效。）

### 4.3 `失败 ≠ 空结果` 的完整实现

```
handleOnlineMediaFailure.ts (3.7KB)
createOnlineRecoveryController.ts (9.7KB)
playbackRecovery/
```

**这与你在 REFS-B §8 已读的 QueMusic 结论一致**（"带 error 的失败响应不能当成没有数据"），
**但它多了一层**：`createOnlineRecoveryController` —— **失败后的恢复控制器**。

**对你的意义**：M3 接平台后，"请求失败 → 提示 → 用户重试"这条链要**独立成模块**，
而不是散在各个 `catch` 里。

### 4.4 账号：**扫码登录有诊断自检层**（运维姿势）

```
electron/neteaseLoginDiagnostics.cjs (7.2KB)
electron/neteaseLoginIdentity.cjs (4.8KB)
electron/loginSelfCheck.cjs (8.9KB)
electron/linuxPasswordStore.cjs  ← 证实用 safeStorage（Linux 有兜底）
src/utils/qrLoginDiagnosticReport.ts (7.9KB)
```

**这是 M3 最值得抄的一块**：扫码登录失败的方式很多（二维码过期 / 未确认 / 风控 / 网络），
**它做了一整套自检 + 可导出的诊断报告**。

**对你的意义**：你的 CONTRACT §5 有风控约束（`-460` 即停），但**没有"登录失败时怎么自查"**。
建议 M3 时：

1. 登录失败**分类**（二维码过期 / 未扫描 / 待确认 / 风控 / 网络）
2. **可导出诊断报告**（用户能贴给你）
3. **不记录凭据**（它用 `safeStorage`，你也必须）

---

## 5. ⭐ 它为什么 6350★：**用户要什么**

这一节最重要——**它告诉我们市场真正的需求在哪**。

### 5.1 它的差异化资产

| 资产 | 规模 |
|---|---|
| **14 套歌词动画模式**（cadenza / cappella / claddagh / classic / diorama / fume / lumiere / monet / partita / pendolo / sonnet / still / tempera / tilt） | `registry.tsx` 动态注册 + 每种配 `tuning.ts` |
| **Folium 模组系统** | `electron/modSystem/` 10 文件，`modSystem.cjs` **63KB**，fail-closed 清单 + 签名 + `folia-mod://` 只读协议 + **模组市场** |
| **Windows / macOS 壁纸模式** | `windowsWallpaperController.cjs` 16KB + `macWallpaperController.cjs` **44KB** |
| **OBS 浏览器源**（含 URL burn-in 配置码） | — |
| **本机只读歌词 API** | `http://127.0.0.1:32109`，**无鉴权、CORS `*`、`null` 表示无歌词** |
| AI 主题生成 | Gemini 结构化输出 |
| **随包分发 Python + htDEMUCs ONNX** | `htdemucs_runner.py` 16.6KB + `modelStore.cjs` 21KB + `buildPythonRuntime.mjs` 15KB |

### 5.2 那份报告的定性判断

> **用户要的不是"播放器"，是"歌词 PV + 可接入我现有播放器"。**
> 那个本机 HTTP API 是它撬动外部生态的关键杠杆。

**伊索 14 套动画 + 模组市场 + 本机 API** 这组**表现层与集成层**资产，是它的护城河。

### 5.3 Issue 侧：**UI 需求远多于播放内核需求**

| Issue | 评论数 |
|---|---|
| #228 [BUG] 酷狗登录后全部提示"歌曲已下架" | **15** |
| #110 [BUG] Windows 启动黑屏 | 10 |
| #203 [BUG] 逐字歌词相关问题 | — |
| #425 副字幕双行（罗马音+翻译） | — |
| #299 / #313 歌词页常显歌曲信息 | — |

**读法**：**没有一条是"音质不够好"**。全是**平台可用性**（酷狗）、**启动稳定性**、**歌词显示细节**。

**对你的直接启示**：

| 它的 Issue 类型 | 你的对策 |
|---|---|
| **平台登录/歌曲下架** | M3 必须做好**失败分类 + 诊断报告**（§4.4） |
| **逐字歌词问题** | 你的逐字高亮**按字形 advance 插值**（§2.6）能避免它踩的坑 |
| **罗马音+翻译双行** | 你的 `Lyrics` 结构**已有 `translation` / `romanization` 字段** ✅ 但要测**双行同时显示**的排版 |
| **歌词页常显歌曲信息** | 纯 UI 需求——你的三通道系统已把它归入 C3 |

---

## 6. 它的不足与技术债（别照抄）

| 不足 | 说明 |
|---|---|
| **分层违规（它自己的工具检测出来的）** | `src/stores/useVisualizerSettingsStore.ts → components/visualizer/registry.tsx` —— **store 不该依赖组件**；另有 7 处"目录归属存疑" |
| **巨型文件** | `electron/main.cjs` **251KB**、`src/App.tsx` **138KB**、`electron/stageApi.cjs` 77KB |
| **纯 Web 的先天税** | 必须**串行化 WebGL 上下文创建**（模块级 Promise 链），注释写明"防止取消的异步挂载临时分配第二个 WebGL 上下文" |
| **曲库用 IndexedDB** | 被浏览器存储逼出来的；你的 SQLite 是优势 |
| **背 Python 运行时** | 为了 htDEMUCs 人声分离**随包塞 Python**；你要做人声分离应走 **ONNX Runtime C++**，不该背 Python |
| **无真正的 gapless** | Web Audio 双 deck 交叉淡入是 automix，**不是 sample-accurate gapless** |
| **取色无对比度约束** | 见 §3 |

**它有一个好习惯值得学**：`docs/CODEMAP.md`（11KB）是**自生成的模块图**，
并**自动检测分层违规**（store → component 这种）。它承认"精确计数会引发无意义同步提交，故只报 2 的幂量级"。

> **对你的意义**：你的 AI-B 交接文档（`docs/HANDOFF-B-app.md`）已经有文件地图。
> 如果将来加一个"检查 import 方向"的小脚本，就得到它这个能力的简化版。

---

## 7. 行动建议（按性价比）

| # | 动作 | 成本 | 收益 |
|---|---|---|---|
| **1** | **抄 `latticeLyricFrameLoop` 的调度结构**（moving-gated + visibility-gated + delta 封顶），时间源用引擎 `position` | 小 | ⭐ **1083 字节的投入产出比最高**；防空转 |
| **2** | **逐字高亮按字形 advance 插值**（不是 per-char 均分），用字素簇而非 code point | 中 | ⭐ 修一个中日文混排会露馅的 bug |
| **3** | **缓存命名空间隔离**（在线歌词 / 本地解析 / **手工修正** 三类分开） | 小 | 防"清便宜的误删贵的" |
| **4** | **DPR 分辨率取整数比 + 上限 2** | 小 | 4K@125-175% 缩放不发虚 |
| **5** | **本地分词优先**（jieba / kuromoji），LLM 只兜底；`realignSegmentsToText` 的对齐逻辑照抄 | 中 | 零成本零延迟，离线可用 |
| **6** | M3：**登录失败分类 + 可导出诊断报告** | 中 | 它的 Issue 第一大类就是平台登录 |
| **7** | **`sourceRevision` 概念**（与 CR-007 互补） | 小 | 防"源变了但还用旧缓存" |
| **8** | 若做 TTML/VTT：**多解析器 → 一个中间态**的结构 | 中 | 别在 `lrc.ts` 里堆 `if` |
| **9** | **本机只读歌词 API**（`127.0.0.1:<port>`） | 中 | ⭐ 让外部播放器/工具用你的歌词——**这是它撬动生态的杠杆** |
| **10** | 检查 `src/main/index.ts` 是否过厚（对照它 251KB 的 `main.cjs`） | 半小时 | 已有建议（REFS-B §E3），这是反面教材 |
| — | ~~Dexie/IndexedDB~~ | — | 你的 SQLite 更好 |
| — | ~~背 Python 运行时~~ | — | 要做人声分离走 ONNX C++ |
| — | ~~LLM 生成主题~~ | — | 与你的令牌系统重复，且违背"不依赖外部服务" |

---

## 8. 一句话

> **它 6350★ 靠的是"14 套歌词动画 + 模组生态 + 本机歌词 API"——表现层与集成层资产。**
> **它的播放内核（Web Audio）明显弱于你的 C++ 引擎。**
>
> **但它的歌词流水线工程质量（帧循环、分词重建、缓存分类、字形插值）是全仓最值得逐函数学的部分**——
> 而且**那部分恰好是你 M1 之后的下一步**（逐字歌词 + 动画手感）。

---

## 附：取文件的方法（AGPL，只学模式）

```
https://raw.githubusercontent.com/chthollyphile/folia-major/main/docs/CODEMAP.md          ← ⭐ 自生成模块图
https://raw.githubusercontent.com/chthollyphile/folia-major/main/docs/lyric-api.md        ← 歌词数据契约（wordByWord 等）
https://raw.githubusercontent.com/chthollyphile/folia-major/main/docs/technical.md
https://raw.githubusercontent.com/chthollyphile/folia-major/main/src/utils/lrcParser.ts   ← 258 字节的 shim，看目录结构用
```

**稀疏克隆**（它 21.7MB TS，必须稀疏取）：

```
git clone --filter=blob:none --sparse https://github.com/chthollyphile/folia-major.git
cd folia-major && git sparse-checkout set docs src/utils/lyrics src/services/lyricSegmentation.ts
```

> ⚠️ **不要整读**：`electron/main.cjs`（**251KB**）、`src/App.tsx`（**138KB**）、
> `docs/ponder-copy.md`（**179KB**）、`docs/library-suites.md`（91KB）、`localMusicService.ts`（**79KB**）。
>
> **报告的方法说明**：`src/services` 与 `src/utils` 的完整清单只拿到树视图前 100KB（API 分页截断），
> 故改为**按需直取具体文件验证**——这也是你该用的方法：**先拿到目录名，再逐个取可疑的文件**。
