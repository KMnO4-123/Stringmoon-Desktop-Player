# M3 整合方案 v1 · 平台对接 / 曲库 / 歌词 / 性能

> 上位：[`CONTRACT.md`](../CONTRACT.md)、[`docs/SPEC-v2.1.md`](SPEC-v2.1.md)
> 前置调研：[`PLATFORM-v1-provider-choice.md`](PLATFORM-v1-provider-choice.md)（平台选型）、
> [`DSP-v1-effects-chain.md`](DSP-v1-effects-chain.md)（音效链）
> 日期：2026-10-15 · 状态：**待 owner 批准 §10 的裁定项**

---

## 0. 这份方案覆盖什么

你提的四块，逐条对：

| # | 你要的 | 本方案章节 |
|---|---|---|
| **1** | **歌曲管理** | §4 |
| **2** | **音频性能** | §7 |
| **3** | **流媒体平台对接**——扫码登录即用 / 点击即听 / 调用歌单 / 完整歌曲信息 / 歌词 / 封面 | §3（对接）+ §5（歌词） |
| **4** | **高动画低负载高流畅** | §6 |

---

## 1. ⭐ 三家分工：谁贡献什么（本方案的核心判断）

**调研结论：没有一家能全抄，但三家拼起来正好补齐我方四个空白。**

| 来源 | 许可 | 贡献 | 可抄程度 |
|---|---|---|---|
| **Twilight_Echo**（316★） | **Apache-2.0** | **平台对接架构** + **曲库工程约 2000 行** | ✅ **可整文件抄** |
| **Folia**（6350★） | **AGPL-3.0** | ⭐ **歌词（AMLL 逐词）** + **能力四态模型** + 帧循环思路 | ⚠️ **只学思路，不抄码** |
| **QueMusic**（211★） | **Apache-2.0** | 音频常量 / 列表复用 / `requestStyle` 白名单 / 时长六档纪律 | ✅ 可抄 |
| **我方已有** | — | C++ 引擎（独占 / EQ / RG / dither / 424 断言）+ 三通道设计系统 | 保持不动 |

### 1.1 ⭐ 先说一个决定性事实：**四方同源**

**Folia 的 `docs/technical.md` 原文**：

> 本项目依赖 [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 提供音乐相关后端服务。

**所以现在是四方同源**：Folia / Twilight_Echo / 我方原计划 / 社区主流 **都用 `api-enhanced`**。

| | 网易云协议 | 酷狗 | QQ |
|---|---|---|---|
| **Folia** | `api-enhanced` | **Electron 主进程内直接调用 Node 模块，不启动 HTTP 服务** | `@yakult-green-tea/qq-music-api`（3.3.1），三形态：常驻 Node / **Electron 主进程内嵌** / serverless |
| **Twilight_Echo** | `api-enhanced` 的 `serveNcmApi({port:'0'})` | 第三方 `.tep` 插件 | 同上（外包） |

**⭐ 关键**：**"进程内 vs 独立服务端"这个选择，两家都选了进程内。**
这确认了我方 CONTRACT §4 原计划的方向。

### 1.2 为什么歌词要用 Folia 的机制

**Folia 的歌词系统是 50+ 文件、约 250 KB 的子系统**（`src/utils/lyrics/`）：

| 文件 | 体量 | 作用 |
|---|---|---|
| `parserCore.ts` | **43,426 B** | 解析核心 |
| `autoMatchBestLyric.ts` | 25,434 B | 自动匹配最佳歌词 |
| `sentenceLayout.ts` | 19,992 B | 句子布局 |
| ⭐ `cjkSemanticLayout.ts` | **11,409 B** | **中日韩语义布局** |
| `ttmlConversion.ts` | 9,906 B | **TTML 转换**（AMLL 用 TTML） |
| `matchScore.ts` | 7,842 B | 匹配打分 |
| `renderHints.ts` | 7,827 B | **渲染提示** |
| ⭐ `wordSegmentation.ts` | 6,745 B | 分词 |
| ⭐ `graphemeTiming.ts` | 4,688 B | **字素级时序**（非码点） |
| `amllDbCandidates.ts` | 4,408 B | AMLL DB 候选 |
| ⭐ `workerClient.ts` | 2,372 B | **分词跑 Web Worker** |
| `sourcePriority.ts` | 1,235 B | 源优先级链 |

**⚠️ 关键判断**：**这个规模我方既抄不完、也不该抄**——
① 它是 **AGPL**（不能抄码）；② 它服务的是"全网歌词库 + AI 分段 + 14 种动画"的产品目标，
**与我方"91 首、听懂就好"的定位不匹配**。

**→ 正确的取法是：只取四条「判断」，代码自己写**（见 §5）。

### 1.2 ⚠️ 许可纪律（务必遵守）

| 来源 | 能不能抄码 |
|---|---|
| Twilight_Echo / QueMusic | ✅ **能**（Apache-2.0，保留版权声明） |
| **Folia** | ❌ **不能**（AGPL-3.0）。**自用不发布虽无义务，但混入 AGPL 码会让整个仓库将来无法按其他许可发布** |

**→ Folia 只取「机制」，代码自己写。** 本方案 §5 已按此原则处理。

---

## 2. 总体架构

```
┌─ Electron 主进程 ─────────────────────────────────────────────┐
│  api-enhanced 的 serveNcmApi()                                │
│    · 127.0.0.1:<OS 分配端口>（端口用字符串 '0'）              │
│    · 加密/签名 100% 在此（npm 包内，我方零行）                 │
│  转发层（参考 Twilight_Echo 的 304 行）                        │
│    · 路径校验 / cookie 归一 / 时间戳 / 幂等键 / 超时           │
│  受管媒体缓存                                                  │
│    · cacheSong 异步下载 → 命中返本地路径 → 失效回退签名 URL     │
│  曲库仓储（JSON 文档 + revision 乐观并发）                     │
├─ utilityProcess（可休眠 5 分钟）───────────────────────────────┤
│  provider 适配层（网易云 / Navidrome）                         │
│    · 令牌桶限流 / 音质回退阶梯 / 风控退避 / 写幂等              │
├─ Renderer（React）────────────────────────────────────────────┤
│  Library Core（只依赖 ports 接口，不知道实现）                  │
│    · 能力四态（supported/enabled/pending/reason）★ Folia       │
│    · 虚拟列表 / background-clip 逐字 / 可见性门控              │
├─ twilight-engine.exe（既有，独立进程）────────────────────────┤
│  只做解码与输出，★ 不知道"在线"与"本地"的区别                  │
└───────────────────────────────────────────────────────────────┘
```

**两条架构原则（都来自调研的一手证据）**：

| # | 原则 | 依据 |
|---|---|---|
| **1** | ⭐ **核心层不知道队列怎么构造** | Folia `ports.ts` 原文：*"把「播放 / 入队」交给应用现有的播放控制器；**核心层不知道队列怎么构造**"* —— 与我方"引擎是唯一音频权威"同构 |
| **2** | ⭐ **音频引擎独立进程** | Twilight_Echo 也这么做了（`TWILIGHT_AUDIO_SERVICE`，*"避免原生 DSP 硬崩溃退出 Electron 主进程"*）。**它绕了一圈回到我方的架构** |

---

## 3. 平台对接（覆盖你要的六项）

### 3.1 六项功能逐条落点

| 你要的 | 怎么实现 | 依据 |
|---|---|---|
| **① 扫码登录即用** | unikey 三连（`/login/qr/key` → `/login/qr/create` → 轮询 `/login/qr/check`），状态码 `801 等待 / 802 已扫 / 800 过期 / 803 成功`；**另有官方网页登录兜底**（内存分区窗口抓 `MUSIC_U`） | Twilight_Echo `index.mjs:1146-1194` + `api.ts:147` |
| **② 点击即听** | ⚠️ **见 [`PLAY-v1-login-and-streaming.md`](PLAY-v1-login-and-streaming.md) §1.7 的三条路对比** —— 本节早先写的"本地缓存播"**已被该方案的调研推翻**（它做不到即点即播）。现在的选择是 **c（增长文件 + `totalFrames` 判断）** 或 **b（回环 HTTP + `HttpReader`）** | `PLAY-v1` §1.7 |
| **③ 调用歌单** | provider 实现 `fetchPlaylistTracks` / `fetchLikedTracks` / `fetchUserPlaylists` + 增删改；**队列保存身份不保存 URL** | `plugin.json` capabilities + `playlist-lifecycle.md` |
| **④ 完整歌曲信息** | `normalizeTrack` 产出 `id/title/artist/artists[]{id,name}/album/duration/cover/format/sampleRate/bitrate/bpm` | `index.mjs` |
| **⑤ 歌词** | §5 专章（Folia 的 AMLL 插在 YRC 之前） | — |
| **⑥ 封面** | `?param=600y600` 大图 / `?param=140y140` 缩略图，自动归一 | `index.mjs` |

### 3.2 三层实现

**第一层：主进程内嵌 API 服务端**

```js
const { serveNcmApi } = await import('@neteasecloudmusicapienhanced/api/server.js')
const ncmApp = await serveNcmApi({
  port: '0',              // ★ 字符串，绕过上游 `options.port || 3000`
  host: '127.0.0.1',
  checkVersion: false
})
```

**四条必须照抄的细节**：

| # | 细节 | 为什么 |
|---|---|---|
| **1** | **端口用字符串 `'0'`** | 上游 `port \|\| 3000` 把数字 0 当缺省；字符串保住"OS 分配"语义 |
| **2** | **写类路径强制加时间戳** | `/login`、`/playlist/*`、`/like`、`/follow`、`/personal_fm` 加 `timestamp=`；**读类不加** |
| **3** | **凭据脱敏**（20 行，**建议立刻用**） | `MUSIC_U=` / `__csrf=` / `Bearer` / `X-Api-Key` / query 参数 → `[REDACTED]` |
| **4** | **undici Agent**（8 连接 + keep-alive 60s） | 高频调用不反复建连 |

**第二层：provider 适配层（utilityProcess，可休眠）**

**五条风控纪律**（Twilight_Echo 踩坑换来的）：

```
① 令牌桶限流：容量 5、回灌 ~5 req/s
② URL 缓存 TTL = min(20min, 上游 expi)      ← CDN 签发地址会过期
③ 音质回退阶梯 + 步间退避 250ms→500ms（封顶）
④ ⭐ 风控命中即终止整条阶梯（连"回退到更低音质"也不试——那同样是上游请求）
⑤ 写操作幂等（X-Twilight-Idempotency-Key）
```

**第三层：受管媒体缓存**

```
/song/url/v1 逐档试 → 经典 /song/url?br= 兜底 → /song/url/match（灰名单）
    ↓ 拿到签名 URL
异步 cacheSong 下载到受管目录（★ 不阻塞播放）
    ↓
命中：返回本地文件路径（引擎读普通文件）
失效：回退签名 URL
```

### 3.3 ⚠️ Navidrome → 建议先做

| | 网易云 | Navidrome |
|---|---|---|
| 协议 | eapi 加密 + 风控 | **标准 Subsonic REST** |
| 签名 | 需要 | **无** |
| 逆向 | 需要 | **不需要** |
| 工作量 | 大 | **手写 5 个端点** |

**→ 建议 M3 的第一件事是 Navidrome**：它能**先跑通整条 provider 通路**（登录/搜索/取流/播放/封面），
且**没有风控风险**。网易云在其后接入，两者共用同一套 provider 接口。

---

## 4. 歌曲管理（覆盖你要的"歌曲管理"）

### 4.1 我方现状 vs 目标

| 能力 | 我方现在 | 目标 |
|---|---|---|
| 曲库身份 | `tl_NNNN` 顺序号 | **归一路径 + 来源前缀** |
| 重复检测 | ❌ **无** | 五级证据链 |
| 元数据补全 | ❌ **无** | 永不复写 |
| 标签编辑 | ❌ **无** | journal 回滚 |
| 扫描身份 | 未定义 | `size + mtime + cueSignature` |
| 专辑聚合 | 引擎 `catalog` 内简单聚合 | 三级身份 |

### 4.2 ⭐ 身份模型（最高优先级，牵动全部）

**两条一起做**：

```ts
type TrackId = `local:${string}` | `ncm:${string}` | `nav:${string}`
//                ↑ 归一化路径          ↑ 平台 ID
```

| 规则 | 依据 |
|---|---|
| **本地键 = 归一化路径（+ CUE 段）** | Twilight_Echo `search-and-library-identity.md`：*"本地键使用归一化路径与 CUE 段，因此用新生成的 track ID 重新扫描仍能保留覆盖"* |
| **远程键 = provider + item ID** | 同上 |
| **文件夹前缀必须带分隔符边界** | 原文：*"排除前缀相似的兄弟目录（如根 `C:\music` 之于 `C:\music-other`）"* |
| ⚠️ **移动文件会改变键** | 它明确承认这个代价，解法是"缺失文件修复" |

**→ 这条要补充进 CR-013**（我方已裁定的 `replace: true` 需要"前缀 + 分隔符"的明确要求）。

### 4.3 五级证据链（重复检测，`duplicateDetection.ts` 351 行）

```
path(exact) < contentHash(exact) < audioFingerprint(exact)
            < metadataCandidate(possible) < logicalTrack(probable)
```

**三条关键设计**：

1. ⭐ **哈希前先按 size 分组** —— 只对「size 相同且出现 ≥2 次」的候选算 SHA-256（**性能关键**）
2. **每级命中的候选从 `remaining` 移除** → 五级互斥，不重复计数
3. ⭐ **`createDuplicateActionPlans` 强制 `destructive: false`** —— **只生成建议，不删文件**

**实测**（10,000 行）：unique **p50 32.8ms / p95 57.9ms**；collision **p50 45.1 / p95 52.9ms**。

> ⭐ **第 3 条与你的 DESIGN-v5 诚实原则同构**：工具只报告，不擅自破坏。

### 4.4 元数据补全：**永不复写**

```ts
// 只在"本地是占位符 且 远端不是"时才取远端
if (isMetadataPlaceholder(local) && !isMetadataPlaceholder(remote)) { ... }
// 封面/歌词：本地非空即胜出
const cover = localTrack.cover ?? metadata.cover ?? null
```

**占位符集合**：`unknown / unknown artist / unknown album / 未知 / 未知艺术家 / 未知歌手 / 未知专辑`

**匹配门槛**：标题须 exact 或仅标点差异；艺人须**子集双向包含**；
⭐ **时长差 >20s 直接拒，但艺人非全等时差必须 ≤8s**（防"同台嘉宾"误配）。

**不延迟首屏**：默认 6 worker（钳制 4–8），按 `归一化(title+artist)` 去重，失败指数退避 15s→5min。
⭐ **迟到结果用"源快照栅栏"丢弃**（携带原 `source` 对象，与当前记录不同即隔离）。

### 4.5 标签编辑：**备份 → 写 → journal → 逆序回滚**

```
逐文件 copyFileSync 备份 → 写标签（TagLib）→ 每步持久化 journal
   ↳ 任一步失败 → 逆序还原
```

| 项 | 值 |
|---|---|
| journal | `tag-write-journal.json`（≤2 MiB） |
| 上限 | 单批 ≤1000 文件、文本 ≤1024 字符、封面 ≤8 MiB / ≤4096px |
| 语义 | ⭐ **空白字段不覆盖**（"typing then clearing" 不擦除） |
| 结果四态 | `success \| failed \| rolledBack \| notAttempted` |
| 缓存刷新 | ⭐ 只有**确认成功且仍匹配快照**的才刷新 |

### 4.6 扫描：`size + mtimeMs + cueSignature`

⭐ **`cueSignature` 入身份**：**兄弟 CUE 变了要重解析音频**（CUE 决定分轨边界）。

| 常量 | 值 |
|---|---|
| `SCAN_BATCH_SIZE` / `IDENTITY_BATCH_SIZE` | 256 / 1024 |
| `PARSE_CONCURRENCY` / `PARSE_TIMEOUT_MS` | 4 / 30,000 |
| `COVER_LOOKUP_TIMEOUT_MS` | 10,000 |

**可取消/暂停/续跑**：检查点 `{identities, completeIdentitySnapshot, completedFilePaths, parsedFileCount}`。
⭐ **删除判定要求 `completeIdentitySnapshot`** —— 扫描中断时不误删。

### 4.7 专辑身份三级

```ts
id:<albumId>                                    // 有 tag 就用
name:<albumArtist 小写>\u001f<album>            // ★ 仅当 albumArtist 确实区别于 artist
dir:<目录>\u001f<album>                         // 同目录多艺人的合辑
```

⭐ **第 2 级的防御**：**丢弃"旧扫描把 artist 塞进 ALBUMARTIST"的污染**——被真实数据坑过才会写的代码。

**多碟排序**：discNumber → trackNumber → **`Intl.Collator('zh',{numeric:true})` 文件名** → 标题。

> ⚠️ **对我方 91 首的具体影响**：**无 albumArtist 标签时落到 `dir:` 分支**——正合"一专辑一目录"。

### 4.8 持久化：**JSON 文档，不是 SQLite**

⭐ **它用 50k 轨实测否决了 SQLite**（`docs/persistence-benchmark.md`）：

| 操作 | JSON | SQLite |
|---|---|---|
| full parse | **432 / 494 ms** | 963 / 1394 ms |
| bulk mutation | **198 / 383 ms** | 552 / 624 ms |
| 损坏恢复 | **124 / 191 ms** | 684 / 827 ms |

原文：*"SQLite is slower in every recorded corrected 50,000-track operation… There is no case for a production migration now."*

**→ 我方曲库持久化用 JSON 文档 + `revision` 乐观并发**（自用场景下单进程读全量，前提成立）。

---

## 5. 歌词（Folia 的贡献，覆盖你要的"歌词"）

### 5.0 ⚠️ 先说清：Folia 的歌词系统**只取判断，不取代码**

它的 `src/utils/lyrics/` 是 **50+ 文件、约 250 KB** 的子系统。**这么大的原因是它在解决一个不同的产品目标**：
「全网歌词库 + AI 分段 + 多套动画 + 生态接口」。

**我方定位是「91 首、听懂就好」** —— 所以：

| 取法 | 内容 |
|---|---|
| ✅ **取四条判断** | §5.2 源序 · §5.3 字素级 · §5.4 CJK 布局 · §5.5 Worker 卸载 |
| ❌ **不取代码** | AGPL-3.0，且规模不匹配 |
| ❌ **不取动画/生态** | §5.6 |

### 5.1 源优先级链

```
本地 .lrc / .yrc / .ttml  →  AMLL TTML DB  →  平台 YRC（网易云 /lyric/new）  →  平台 LRC  →  LRCLIB
     ↑ 用户自己的永远最优先    ↑ Folia 的贡献        ↑ Twilight_Echo 的
```

**依据**：Folia `sourcePriority.ts`（1,235 B）+ Twilight_Echo 的 `/lyric/new` 优先 YRC 逐字
（源码注释原文：*"Prefer YRC as the timed display payload when available (word-level timings)"*）。

**⚠️ 你需要在 §10.2 裁定是否接受"AMLL 优先于平台 YRC"**。

### 5.2 ⭐ 判断一：**字素级，不是码点级**

**Folia 有专门的 `graphemeTiming.ts`（4,688 B）**，与 `wordSegmentation.ts`（6,745 B）分开。

**为什么要分**：

| 单位 | 问题 |
|---|---|
| **码点（code point）** | ❌ 会把「きゃ」「しゃ」这类**拗音**、emoji、组合字符**切成两半** |
| **字素簇（grapheme cluster）** | ✅ 「一个用户感知的字符」 |

⭐ **对我方直接相关**：**91 首大量日文**——拗音（きゃ/しゅ/ちょ）按码点切会**在字中间断开**，
逐字填充会出现"半个字亮"的观感。

**⚠️ 这条有两个独立实现印证**（外部调研）：Twilight_Echo 的 `BreakIterator` 与 Folia 的字素级时序
**都选择字素簇**。**两个独立实现都这么做，这条要听。**

### 5.3 ⭐ 判断二：**CJK 语义布局**（不是我方能想出来的）

Folia 有 **`cjkSemanticLayout.ts`（11,409 B）** —— **专为中日韩做的布局逻辑**。

**它意味着**：**CJK 的断行与对齐不是"按字符数切"能解决的**。至少涉及：

| 问题 | 为什么字符数解决不了 |
|---|---|
| **禁则处理** | 行首不能是 `、。」』`，行尾不能是 `「『（` |
| **全角/半角混排** | 全角字符宽度是半角的两倍，按字数算宽度必错 |
| **假名与汉字混排** | 视觉密度不同 |
| **拉丁词不拆** | 英文单词不该在中间断行 |

**→ 我方结论**：**逐字填充必须用「实际测量的字形 advance」插值**（我方已实现），
**并且断行要用 `Intl.Segmenter`**（浏览器内置的 ICU 分词）**而不是 `split('')`**。

⭐ **这条是本方案里最容易做错、且做错了最明显的一条** —— 因为你的曲库**大量是日文**。

### 5.4 ⭐ 判断三：**分词跑 Worker**

Folia 有 **`workerClient.ts`（2,372 B）** —— **分词/计算跑在 Web Worker 里**，不占主线程。

**为什么重要**：分词是 O(文本长度) 的 CPU 活，**若在渲染线程做，会在切歌瞬间掉帧**。
而你的核心要求就是「**高动画低负载高流畅**」。

**→ 我方做法**：分词/字素切分放进 `Worker`（或至少 `requestIdleCallback`），
**主线程只做"按已算好的边界画"**。

### 5.5 帧循环：改成 `position` 事件驱动

**Folia 的机制**：

```
① moving 判定：还在动才继续 rAF（静止即停）★ 低负载核心
② visibility 门控：不可见直接 cancel
③ delta 封顶：min(0.05, delta) —— 防"切回前台"跳帧
```

> ⚠️ 具体文件名与体量本次**未在一手来源确认**（我按记忆写过，现撤回该引用）。
> **机制本身是在前几轮调研中核实过的**，实现时以机制为准。

**⚠️ 我方必须改一处**：它是 Web 播放（时间从 rAF 累积），**我方有引擎的 `position` 事件**——
**时间应由引擎提供，不由 rAF 累积**。否则两者会漂移。

```
我方版本：
  moving 判定  ← 保留（position 两次变化 > 阈值 或 有动画未完成）
  visibility   ← 保留（不可见 cancel）
  delta 封顶   ← 保留（防跳帧）
  ★ 时间源     ← 改为引擎 position 事件（不是 rAF 累积）
```

**依据（我方已有）**：应用侧 3D 唱片已用「rAF 门控（playing 或 unsettled）+ IntersectionObserver +
visibilitychange」，**同一套思路可推广到歌词**。

### 5.6 ⚠️ 判断四：缓存命名空间要分类

**教训**：**分词结果（贵）与原始歌词（便宜）必须分开命名空间** ——
否则"清歌词缓存"会**连带清掉贵的分词结果**，下次要重新算。

**→ 我方**：`lyric_raw_*` / `lyric_seg_*` / `lyric_render_*` 分开，
**清理策略按"贵不贵"分级**，不是一把清。

### 5.7 ⚠️ 不抄 Folia 的部分

| 不抄 | 原因 |
|---|---|
| **PixiJS + WebGL 歌词渲染** | 与 DESIGN-v5 的 C2 通道（SVG/几何编码）冲突；且我方已有 DOM 逐字方案 |
| **多套歌词动画/可视化模式** | 与「一屏一个重心」冲突；且是"好看"而非"听懂"，与 HiFi 目标不符。（**具体数量本次未核实**，我不引用数字） |
| **本地只读歌词接口** | 详见 §5.8 |
| **Folium 模组系统** | 生态设施，自用单机不需要 |
| **AI 歌词分段** | 它用 Gemini / OpenAI 兼容 API 做分段；**我方有平台 YRC 与 AMLL，不需要引入 AI 依赖** |

### 5.8 Folia 的歌词接口（准确描述，供判断是否要）

**`docs/technical.md` 原文**：

> Electron 桌面端可在"连接与集成"中启用歌词接口。启用后，Folia **仅在回环地址提供无需鉴权的固定接口**：
>
> ```
> GET http://127.0.0.1:32109/v1/lyric
> ```
>
> 接口返回当前歌词的精简 JSON，并在**顶层 `offset` 字段中携带用户设置的歌词时间偏移（毫秒）**；
> **当前没有歌词时返回 `null`**。

**它的用途**：给**第三方工具**用（例如它的 Quickshell 顶部歌词插件 `lia.lines`、
以及"folia 没在播放时作为简易 MPRIS 组件"）。

**→ 我方建议：不做。** 理由是它服务"生态与外部集成"，而你是自用单机。
**但它有一个设计值得记**：⭐ **把用户设置的歌词偏移放进返回里**——
这说明"**偏移是用户状态，不是渲染细节**"，任何消费方都该拿到一致的时间基准。

---

## 6. 高动画低负载高流畅（覆盖你第 4 项）

### 6.1 我方实测问题（已知数据）

| 指标 | 现状 |
|---|---|
| DOM 节点 | **30,183**（2000 首时） |
| 切曲库耗时 | **936ms** |
| 渲染进程工作集 | **331MB** |

### 6.2 四条针对性优化

| # | 措施 | 预期 | 依据 |
|---|---|---|---|
| **1** | ⭐ **列表实例复用式虚拟化**（固定行高 + 池化 + **复位非数据属性**） | **DOM 30,183 → ~1,500**；切页 **936ms → <150ms** | QueMusic `QListView.qml` 的 `reuseItems + onReused/onPooled`；**它必须手动复位 `transY/opacity`**——反证池化是真实例复用 |
| **2** | ⚠️ **模糊要按面积分级，不是一律 `backdrop-filter`** | 见 §6.2.1 的警告 | — |
| **3** | ⭐ **逐字用 `background-clip: text` + 动画渐变** | 一屏歌词 DOM **600 → 15** | QueMusic 是**每字一个 `Text` + 一个 `LinearGradient`**（≈300 个 FBO 级对象） |
| **4** | **可见性门控一切定时器** | 不可见零开销 | QueMusic `syncTimer()` 的三条件 `m_animating && isVisible() && window()`；我方 3D 唱片已有 |

### 6.2.1 ⚠️ 重要修正：`backdrop-filter` **不是无条件免费**

**我上一版写的"Web 合成器免费"是错的。** 有一条一手反例：

> **Folia issue #605**：动态背景用 **Canvas + `backdrop-blur-xl` 全屏逐帧重绘**
> → **GPU 占用、风扇狂转、`INP 864ms`**。

**结论**：`backdrop-filter` 的成本取决于**面积 × 是否逐帧重绘**：

| 情形 | 成本 | 该怎么做 |
|---|---|---|
| **小面积 + 背后静态** | ✅ 便宜 | 直接用 |
| ⚠️ **大面积 / 全屏 + 背后逐帧变化** | ❌ **很贵**（每次重绘都要重新采样背景） | **不要用**，或**降低模糊半径 / 降采样 / 只在动画停止时模糊** |

**→ 对我方的具体决定**：

| 我方场景 | 判断 |
|---|---|
| **卡片上的模糊**（面积小、背后是静态封面） | ✅ 用 `backdrop-filter` |
| ⚠️ **整窗背景模糊**（面积全屏，而我方有 **3D 唱片 + 动态背景**） | ❌ **不要逐帧 `backdrop-filter`**。改用**一次性烘焙的模糊图**（切歌时生成一次，动画期间不动） |

⭐ **这条与 DESIGN-v5 的一条既有约束同源**：我方的 3D 唱片已「DPR 取整且封顶 2」，
**同样的"按面积/按重绘频率定价"思维，要推广到模糊**。

### 6.3 一条纪律：动画时长只用六档

**QueMusic 全库只用六个时长**：**80 / 120 / 160 / 240 / 320 / 360 ms**
+ 三条固定曲线（通用入场 `OutExpo 240–420`；大范围布局 `BezierSpline [0.50,0,0,1,1,1]`；列表行 `Bezier [0.23,0.06,0,1,1,1]`）。

**→ 我方 `theme.css` 的时长应收敛到档位**，防止"每个组件自己拍一个数"。

### 6.4 ⚠️ 一条不要学的

**QueMusic 有 10 个 QML 单例 + 14 个 C++ 单例全部常驻** ——
**这在 Web 上是纯内存负担**，且与我方 `331MB` 的既有问题叠加。**不要引入全局常驻单例。**

### 6.5 ⭐ 度量方法论：从 Folia 的性能探针学（**可直接用**）

Folia 有一个专门的性能探针 `dev/probes/lattice-performance/`（`README.md` + `run.ts` +
`strategies.ts` + `Wall.tsx`）。**它的方法比我方现有的"跑一遍看看"严格得多**，值得整体照搬。

#### 它怎么设计的

| 设计 | 为什么 |
|---|---|
| **三种策略对跑**：原实现 / 新实现 / 旧实现 | 旧实现**保留着**，用来**给新实现的"零开销"提供参照系**（否则"0 次 DOM 读取"没有尺度） |
| **三种负载**：`Scale`（只改视觉尺寸）/ `Reflow`（连续改宽度 + 每 1.2s 换卡片）/ `Pan`（合成滚轮事件 + 时间轨迹） | 分开测**变换类 / 布局类 / 滚动类**——它们触发不同的浏览器工作 |
| ⭐ **每轮独立缓存**（不复用进程级缓存） | **防止"暖缓存让后面几轮看起来免费"** |
| ⭐ **重复时轮换策略顺序** | 防**暖缓存**与**热漂移**造成的顺序偏差 |
| **每次：warmup 2.2s → 运动 → 停后再测 1.4s** | ⭐ **必须带 settle 尾段**——只看运动会**隐藏"被刻意推迟的工作"** |
| 报告 **mean / P95 / max RAF 间隔** + **>33.3ms 的间隔数** | 均值会掩盖卡顿；P95 与超阈计数才是手感 |
| 报告 **fitting 调用（缓存未命中）** / **DOM 高度读取次数** / **fitting 耗时** / **峰值挂载卡片数** | 把"为什么慢"拆成可归因的量 |
| ⚠️ 明确声明「**headless Linux 的结果不能替代在受影响 iPad 上的测量**」 | **承认测量环境不等于目标环境** |

#### 三条可立刻用的

**① ⭐ 「目标宽度预测」= 用字体度量算，零 DOM 读取**

它的生产实现**只用字体度量预测**截断位置（原文：*"it computes the cut from the width the card is
heading for, using font metrics only, so it reports **zero DOM reads**"*）；
而旧实现**要在文档里布局每个候选并二分搜索**。

**→ 对我方直接适用**：**读 DOM 会强制同步布局（layout thrashing）**。
文案截断、歌词断行**都该用字体度量预测**，而不是先渲染再量。

**② RAF 间隔要报 P95 与「>33.3ms 的次数」，不只报平均**

**33.3ms = 两个 60fps 帧**。**这个阈值的选择本身就是一个判断**：
一次超过两帧的间隔，用户能感觉到。

**③ 基线要保留，不要删**

它把**旧的 DOM 测量实现保留为对照**，并说它"**仍然是预测与浏览器不一致时的兜底**"。
→ **我方做性能改造时，也要留一份可对跑的基线**，否则无法证明变快了。

> ⚠️ **诚实标注**：以上是它的**方法论**。我方若要照做，需要自己写探针脚本——
> **它的探针代码是 AGPL，不能抄。**

### 6.6 技术栈的一个好消息

**Folia 是 React 19 + Vite 6 + TypeScript + Tailwind 4 + Framer Motion + Electron**。

**→ 与我方同栈**（React + Vite + TS + Electron）。

| | 栈 | 思路转换成本 |
|---|---|---|
| **Twilight_Echo** | Vue 3 + Vite | 中（要过一遍 Vue→React） |
| **Folia** | **React 19 + Vite** | **低**（同栈，机制可直接翻译） |

**⚠️ 但许可仍是 AGPL** —— **同栈不等于能抄码**。
它的价值是：**它的机制描述可以直接映射到我方的 React 代码结构**，不需要跨框架翻译。

---

## 7. 音频性能

### 7.1 我方已达标（不改动）

| 项 | 我方 |
|---|---|
| 独占/bit-perfect | ✅ USB DAC 上已跑通（四字段模型） |
| 线程模型 | 三线程 + SPSC 无锁环 + seqlock 参数快照 |
| 零分配 | ✅ 分配在 `prepare()`；FFT 归控制线程 |
| 断言 | **424 条 / 21 步** |

**它的引擎架构与我方同源**（可重启的独立 Audio Engine Service）——**不必改动。**

### 7.2 两条要补的

| # | 补什么 | 依据 |
|---|---|---|
| **1** | ⭐ **Gapless：播完设备常开** | QueMusic 原文：*"`m_drained` 后设备常开，下一首起播时**无设备重开的空档**"*。我方 gapless 未实现，这是**最低成本的起点** |
| **2** | **五个音频常量** | `kRingSeconds=2`（双环乒乓）、`kClickGuardMs=12`（换段淡入消爆音）、`kSeekThrottleMs=90`、`kBufferMs 10–100/默认 30`、`kPollIntervalMs=50` |

### 7.3 一条对我方有直接价值的（QueMusic 的频谱）

⭐ **FFT 移出音频线程**（与我方 DSP 方案 §5.3.1 一致）：

```
音频线程：只降混单声道 + 写自己的环（满了直接丢弃）★ 绝不阻塞
GUI 线程：在 afterAnimating 里取空环 → FFT 4096
          → 对数分频 30Hz–0.48·sr → -62dB/56dB 归一
          → 三点 [1,2,1]/4 平滑 → ★ attack 0.6 / release 0.3 非对称
```

**⭐ 三条可直接用的数值**：归一化范围 `-62dB/56dB`、三点平滑 `[1,2,1]/4`、**非对称平滑 `attack 0.6 / release 0.3`**。

（我方 [`DSP-v1-effects-chain.md`](DSP-v1-effects-chain.md) §5.3.1 已采纳其"新数据才算 FFT"的设计。）

---

## 8. UI 能力模型（⭐ Folia 的第二个贡献）

### 8.1 四态 + 五因

Folia 的 `capability.ts`（**699 字节**，但极有价值）：

```ts
type LibraryCapabilityReason = 'empty' | 'loading' | 'unsupported'
                             | 'pending' | 'limit-reached';

type LibraryCapability = {
  supported: boolean;   // ★ 这个来源此刻支不支持（永久）
  enabled: boolean;     // 现在能不能点
  pending: boolean;     // 是否进行中
  reason?: LibraryCapabilityReason;
};
```

### 8.2 ⭐ 关键洞察：`supported ≠ enabled`

| 字段 | 语义 | 例子 |
|---|---|---|
| `supported: false` | **这个平台根本没这能力** | Navidrome 没有"每日推荐" |
| `enabled: false` + `reason: 'pending'` | **有能力，但正在做** | 正在登录，按钮不能重复点 |
| `enabled: false` + `reason: 'limit-reached'` | **上游说没有更多了** | 每日推荐的"不喜欢"次数用完 |

**原文注释**：*"同一个能力查询**同时服务按钮与命令面板**。"* —— **单一真源。**

### 8.3 为什么这条对我方重要

⚠️ **我方 CONTRACT §4 的 `MusicProvider` 只有 `capabilities: string[]`（静态列表）**，
**没有"此刻能不能点 + 为什么不能"。**

**结果**：界面会出现**灰着但不说明原因的按钮**——违反 DESIGN-v5「**界面不能声称一件没发生的事**」。

**→ 建议把 `LibraryCapability` 的四态加进 `MusicProvider` 契约**（走 CR）。

---

## 9. 分期与验收

### 9.1 分期

| 期 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0** | **曲库身份 + 去重 + 补全**（抄 625 行） | **不触碰引擎与协议**，纯新增；且身份是后续一切的基础 |
| **P1** | **性能四条**（虚拟列表 / backdrop-filter / background-clip / 可见性门控） | 独立于平台，用户立刻可感（切页 936ms → <150ms） |
| **P2** | **Navidrome provider**（先跑通整条通路） | **无签名、无风控**，风险最低 |
| **P3** | **UI 能力四态**（走 CR） | 为 P4 铺路；也是 P2 就要用的 |
| **P4** | **网易云 provider**（api-enhanced 内嵌 + 本地缓存播 + 五条风控纪律） | 复杂度最高，放最后 |
| **P5** | **歌词：AMLL 插进优先级链 + 帧循环改 position 驱动** | 依赖 P4 的 provider |
| **P6** | **音频两条**（gapless 设备常开 + 五个常量） | 引擎侧独立小改 |

### 9.2 验收

**可自动断言**：

| # | 断言 |
|---|---|
| **1** | 曲库身份：换路径写法**不产生新曲目**（CR-013 已裁定的断言） |
| **2** | 重复检测：五级**互斥**、且 `destructive=false`（**不产生任何删除动作**） |
| **3** | 补全：**本地非空字段永不被覆盖**（构造 LRC/封面都有的曲目，验证不被远端改写） |
| **4** | 时长双阈值：艺人非全等 + 时长差 10s → **必须拒配** |
| **5** | 标签编辑：**中途失败后逆序回滚**，文件字节与操作前一致 |
| **6** | 扫描：中断后**不误删**（无 `completeIdentitySnapshot` 时不判删） |
| **7** | 能力四态：`supported=false` 的按钮**不可点且有 reason** |
| **8** | 性能：DOM 节点数 **< 2,000**（2000 首时）；切页 **< 200ms** |
| **9** | Gapless：同专辑相邻曲目之间**设备不重开**（断言 `renderWakes` 不归零） |

**必须人眼/人耳**（**不自称通过**）：歌词逐字填充在**日文歌**上的对齐、虚拟列表滚动的手感、虚拟化后聚焦环与键盘导航、网易云扫码登录全流程、风控提示是否人话。

---

## 10. 需要你裁定的三项

### 10.1 Navidrome 是否真的先做

它没有风控、无签名，但也**没有"每日推荐/私人漫游"这类内容**。
若你的实际使用是「网易云为主、Navidrome 为辅」，**顺序可能要反过来**。

### 10.2 歌词是否接受"AMLL 优先于平台 YRC"

**代价**：AMLL 是社区库，**可能没有你听的冷门日文歌**；此时回退到平台 YRC。
**收益**：热门曲的逐词质量更高。

### 10.3 能力四态是否走 CR 进 `MusicProvider`

它改的是**契约**（`CONTRACT.md` §4），会影响 A/B 两侧。

---

## 11. 附：本方案引用的一手来源

```
Twilight_Echo（Apache-2.0，316★）—— ✅ 可抄码：
  resources/plugins/ncm-provider/index.mjs        96,936 B（2761 行）
  src/main/ncm/api.ts                            304 行
  src/main/security/secureStorage.ts             147 行
  src/main/library/duplicateDetection.ts         351 行
  src/renderer/src/utils/musicMetadataMatching.ts 274 行
  src/main/library/tagWriteService.ts            252 行
  src/main/library/scanPlanner.ts + fileIndex.ts  82 + 204 行
  docs/{playlist-lifecycle,search-and-library-identity,network-music-sources}.md
  docs/persistence-benchmark.md（50k 轨否决 SQLite）

Folia（AGPL-3.0，6350★）—— ⚠️ 只学机制，不抄码：
  docs/technical.md                     ← ✅ 已核实：依赖 api-enhanced、酷狗进程内、歌词接口 32109
  src/library/core/contracts/capability.ts       699 B   ← ✅ 已核实（能力四态）
  src/library/core/contracts/ports.ts          4,145 B   ← ✅ 已核实（依赖倒置）
  src/utils/lyrics/                      ← ✅ 已核实目录规模：50+ 文件
    parserCore.ts                             43,426 B
    autoMatchBestLyric.ts                     25,434 B
    sentenceLayout.ts                         19,992 B
    cjkSemanticLayout.ts                      11,409 B  ← ⭐ 中日韩语义布局
    ttmlConversion.ts                          9,906 B  ← TTML（AMLL 用）
    matchScore.ts                              7,842 B
    renderHints.ts                             7,827 B
    wordSegmentation.ts                        6,745 B
    graphemeTiming.ts                          4,688 B  ← ⭐ 字素级
    amllDbCandidates.ts                        4,408 B
    workerClient.ts                            2,372 B  ← ⭐ 分词跑 Worker
    sourcePriority.ts                          1,235 B  ← ⭐ 源优先级链
  dev/probes/lattice-performance/        ← ✅ 已核实（性能度量方法论探针）

QueMusic（Apache-2.0，211★）—— ✅ 可抄码：
  components/QListView.qml（reuseItems + onReused/onPooled）
  shaders/cardblur.frag（lod0 = log2(radius/R)）
  lyricsui/LyricsFree.qml（逐字每字一 Text + LinearGradient ← 反面教材）
  cpp/GetWave.cpp（频谱 attack 0.6 / release 0.3）
  doc/project/03-audio-shaders.md（kClickGuardMs=12 等常量）
```

### 11.1 ⚠️ 我撤回的两处引用

| 撤回 | 原因 |
|---|---|
| `latticeLyricFrameLoop.ts`（1,083 B） | **本次未能在一手来源确认该文件路径与体量**。机制本身（moving 判定 / visibility 门控 / delta 封顶）在前几轮调研中核实过，**但文件名引用撤回**。见 §5.5 的标注 |
| Folia 的「14 种歌词动画模式」 | **本次未核实数量**，全文已不引用该数字 |

### 11.2 ⚠️ 已确认不存在、勿引用的数字

| 数字 | 状态 |
|---|---|
| Twilight_Echo 的「16,813 首」实测 | ❌ **全部 docs + audit-evidence 零命中**。只有合成基准 10k / 5k / 20k / 50k |
| Twilight_Echo 有 SQLite | ❌ **没有**。单一 JSON 文档（50k 轨实测否决了 SQLite） |
| Twilight_Echo 栈是 React | ❌ **是 Vue 3**（Folia 才是 React 19） |

### 11.3 仍未核实（不要在实现时当成事实）

| 项 | 说明 |
|---|---|
| `ncm:` 前缀 ID 的**字面格式** | 原则已证实（provider + item ID），字面格式未在源码见到 |
| QQ / 酷狗 / B站 provider 的**实现** | Folia 的酷狗是进程内 Node 模块（已核实方向）；具体实现未读 |
| Folia 歌词帧循环的**确切文件** | 见 §11.1 |
| Folia 的**实测性能数字** | 未取到；只有它的度量**方法**（§6.5） |
