# 平台对接方案选型 + 歌曲管理 · 可转化资源

> 来源：`Px-asen/Twilight_Echo`（**Apache-2.0** ✅ 可直接抄，**316★**，2026-10-15 仍在推送，已发 1.3.0）
> 对比基准：**Folia**（`chthollyphile/folia-major`，AGPL，6350★）
> 我方现状：`CONTRACT.md` §4 的 `MusicProvider` 计划（**尚未实施**）
> 日期：2026-10-15
>
> ⚠️ **本文档经过四轮读源码更正**。最终结论见 **§8**、**附三 更正清单**、**附五 可搬代码清单**。
> **核心事实**：三方（Folia / Twilight_Echo / 我方原计划）**用的都是 `api-enhanced`** ——
> M3 最难的加密协议**不需要自己写**。差别只在"**怎么用好它**"。

---

## 0. 先说四个地址/前提纠正

### 0.1 仓库地址

**`asenyarzc-cpu/Twilight_Echo` 已经不存在了** —— GitHub 302 重定向到 **`Px-asen/Twilight_Echo`**。
**是同一个项目**（作者改过账号名）。星数已从 313 涨到 **316**，今天仍在推送。

### 0.2 ⚠️ 栈不是 React，是 **Vue 3**

全文（含前面几轮）我一直按"Electron + React"理解它。**实际是 Electron + Vue 3 + Vite**
（`src/renderer/src/App.vue`，devDeps 有 `vue`/`pinia`/`vue-tsc`/`@vitejs/plugin-vue`）。

**这对你仍然有用**（`app/` 也是 Electron + TS），但**抄组件要过一遍转换**：
Vue 的 `<script setup>` / `ref` / `watch` → React 的 hook + Zustand。

### 0.3 ⚠️⚠️ **它没有 SQLite** —— 而且它用实测否决了 SQLite

**这是本轮最有价值的一条，也是我此前最可能误导你的地方。**

| 我此前的假设 | 真相 |
|---|---|
| 它有 SQLite schema / 迁移 / 索引 / FTS | ❌ **没有**。曲库是**单一 JSON 文档** `music-library.json`（`LibraryRepository.ts:16` 的 `MAX_MUSIC_LIBRARY_BYTES = 100 MiB`），加兄弟文件 `music-library-file-index.json` |

**它把 SQLite 评测过并明确否决**（`docs/persistence-benchmark.md`，**50,000 轨实测**）：

| 操作 | **JSON** | SQLite | 结论 |
|---|---|---|---|
| full parse | **432 / 494 ms** | 963 / 1394 ms | JSON 快 |
| bulk mutation | **198 / 383 ms** | 552 / 624 ms | JSON 快 |
| 损坏恢复 | **124 / 191 ms** | 684 / 827 ms | JSON 快 |

原文结论：*"SQLite is slower in every recorded corrected 50,000-track operation… There is no case for a production migration now."*

**→ 对我方直接有用**：**我方曲库现在是引擎内的 `catalog`（内存）+ `scan` 追加**，
未来若要持久化，**这份 50k 轨实测直接支持"用 JSON 文档而不是 SQLite"**。
（注意：它是**单进程读全量**的场景；若你将来需要**跨进程并发写**，结论可能不同——
但自用场景下这个前提成立。）

### 0.4 ⚠️ **一个我可能误引的数字，必须澄清**

我在前面几轮提到过它的"16,813 首"性能。**子代理在全部 docs + audit-evidence 里 grep
`16813|16,813`：零命中。**

**该数字在任何一手来源中都不存在。** 它只有**合成基准**（重复检测 10,000 行；持久化 5k/20k/50k）。
**→ 请不要引用 16,813 这个数字。** 这是我的失误。

---

## 1. ⭐ 核心发现：宿主内部网关 + 插件适配层 + **本地缓存播**（**读源码后的两处更正**）

### 1.0 ⚠️ 更正一：它不是"插件自己实现加密协议"

我最初从文件体量推断它自己实现了加密。**读源码后更正**——它的关键代码是：

```js
export async function activate(context) {
  contextRef = context
  ncmApi = context.twilight.internal?.ncm
  if (!ncmApi) throw new Error('Built-in NetEase provider requires the internal NCM gateway')
  // ...
}
// 所有请求统一走这个出口：
const data = await ncmApi.request(path, cookie, { signal, idempotencyKey })
```

**加密与 HTTP 在宿主的内部网关里，不在插件里。** 插件是 **97 KB 的适配层**：
负责端点拼装、字段归一、缓存、限流、幂等、错误翻译。

### 1.0b ⚠️ 更正二：它的播放路径**不是回环代理，而是本地缓存**

我在下面 §1.1 初稿里从插件规范推断"回环媒体代理"是主播放路径。
**读 `getPlaybackUrl` 源码后更正**——它实际是：

```js
// 缓存命中且文件仍在：返回**本地缓存文件路径**
const cachedPath = await ncmApi.getCachedSong(songId)
if (cachedPath === cachedStreamEntry.cachedPath) return playbackIdentityResult(cachedPath, ...)

// 未命中：异步下载到受管缓存目录
void ncmApi.cacheSong(songId, url, fileName).then((cachedPath) => { entry.cachedPath = cachedPath })

// 缓存被清/失效时：**回退到签名流 URL**
// 源码注释：「Keep the signed stream URL and only reuse the exact managed file that still exists.」
```

**`proxyUrl` 只是"防御性兼容"的可选字段**（源码注释原文：
*「defensive compatibility for wrapped payloads and **the optional** proxy URL」*），**不是主路径**。

**→ 这与你选的方案 B 完全一致**。详见 §6。

### 1.1 真实架构

```
┌─ Electron 主进程 ────────────────────────────────────────────┐
│  NCM 网关（加密 / HTTP / cookie）                             │
│  受管媒体缓存（cacheSong / getCachedSong）                    │
├─ utilityProcess（可休眠）────────────────────────────────────┤
│  ncm-provider 插件（97 KB 适配层 + 94 KB 测试）               │
│  · 端点拼装 / 字段归一 / 令牌桶 / 幂等 / 错误翻译 / URL TTL     │
├─ Renderer ───────────────────────────────────────────────────┤
│  只消费 DTO                                                  │
└──────────────────────────────────────────────────────────────┘
```

**播放时的三级优先**（源码 `getPlaybackUrl` 的实际逻辑）：

```
① 本地缓存文件仍存在  → 直接返回本地路径（播放器读文件，引擎零改动）
② 缓存被清/失效      → 回退到签名流 URL
③ URL 也过期         → 重新请求并换更低的音质档（带退避）
```

**回环代理确实存在于它的插件规范里**（原文）：

> 若 `getPlaybackUrl` 成功返回 HTTP(S) 回环地址（`127.0.0.1` / `localhost` / `::1`），
> 当前宿主保持运行，直到显式停止/禁用/卸载/退出，
> **避免休眠关闭本地媒体代理、使正在播放、暂停或队列中已准备的链接失效**。
> 普通 CDN 地址和**本地缓存文件**不触发此例外。

⚠️ 注意最后一句：**"本地缓存文件不触发此例外"** —— 这本身就说明它的主路径是**本地缓存文件**，
回环代理是给"某些 provider 选择返回代理 URL"时准备的能力。

### 1.2 这个架构意味着什么

| 维度 | **Twilight_Echo（真实）** | Folia |
|---|---|---|
| 加密/协议在哪 | **宿主内部网关** | **外部 API 服务端**（`api-enhanced`） |
| 适配层在哪 | utilityProcess 插件（97 KB） | 前端薄适配（`api.ts` 1.9 KB） |
| 额外进程 | **无**（网关在主进程内） | **需要常驻 Node 服务端** |
| 音频怎么出 | ⭐ **回环媒体代理**（`127.0.0.1` + Range） | 前端直接拿 CDN URL |
| 崩溃隔离 | ✅ 插件在 utilityProcess | 取决于服务端 |
| 可休眠 | ✅ 5 分钟空闲即休眠 | ❌ 服务端常驻 |
| 许可 | **Apache-2.0** ✅ | AGPL ⚠️ |

### 1.3 已核实的功能清单（**全部来自 `index.mjs` 源码**）

你问的六件事，它**全部具备**：

| 你要的 | 它的实现（源码证据） |
|---|---|
| **① 扫码登录即用** | ✅ `authType: 'qr'` + `qrStatusCodes: { waiting: 801, scanned: 802, expired: 800, success: 803 }`；另有 `loginByPhonePassword` / `loginByPhoneCaptcha` / `loginByEmailPassword` / `openOfficialLogin` 四条备选 |
| **② 点击即听** | ✅ `getPlaybackUrl` → **回环媒体代理**（带 Range，边下边播） |
| **③ 调用歌单** | ✅ `fetchPlaylistTracks` / `fetchUserPlaylistsByUid` / `createPlaylist` / `deletePlaylist` / `addTracksToPlaylist` / `removeTracksFromPlaylist` |
| **④ 完整歌曲信息** | ✅ `normalizeTrack` 产出：`id/title/artist/artists[]{id,name}/album/albumId/duration/size/cover/coverSmall/format/sampleRate/bitrate/bpm` |
| **⑤ 歌词** | ✅ `/lyric/new` 优先（**YRC 逐字**），失败回退 `/lyric`；含 `tlyric` 翻译 |
| **⑥ 封面** | ✅ `?param=600y600` 大图 / `?param=140y140` 缩略图，自动归一 |
| **⑦ 更高效** | ✅ 无额外进程；插件可休眠；**令牌桶限流**（容量 5、回灌 ~5 req/s）；**流 URL 缓存 20 分钟**（因 CDN 签发地址会过期）；**写操作幂等**（`likeTrack`/关注/歌单增删，持久化到 settings） |

### 1.4 ⭐ 三条它的工程质量值得直接学

**① 风控错误被翻译成人话**（源码原文）：

```js
function isRiskControlMessage(message) {
  return /安全风险|设备环境异常|操作已拦截|高频|风控|ip 高频|IP 高频/i.test(message)
}
// 301 → 「登录态无效或接口缓存了未登录结果，请重新登录或等待 2 分钟后重试」
// 460 → 「网易云限制了当前网络环境，请切换到国内网络或稍后重试」
// 安全风险/设备环境异常 → 「请停止频繁重试，切换网络/设备或按官方提示 24 小时后再试」
```

**这直接对应我方 CONTRACT §5 的风控约束**——它把"失败码"变成了"下一步做什么"。

**② 音质档位带回退链**：

```js
const NCM_PLAYBACK_QUALITY_FALLBACKS = {
  auto:     ['hires', 'lossless', 'exhigh', 'standard'],
  hires:    ['hires', 'lossless', 'exhigh', 'standard'],
  lossless: ['lossless', 'exhigh', 'standard'],
  exhigh:   ['exhigh', 'standard'],
  standard: ['standard']
}
```

**③ 流 URL 缓存必须带 TTL**（源码注释原文）：

> CDN 签发地址会过期：无 TTL 的缓存会把 403 回放成多提供方大恢复，20 分钟内命中即可，超时强制重解析

**⭐ 歌词那条印证了我方既有判断**：源码注释写着
`Prefer YRC as the timed display payload when available (word-level timings)` ——
**它把 YRC 作为逐字显示的首选**，与 `CONTRACT §4.4` 的源优先级一致。

---

## 2. ⭐ 结论：按你的判据（六项功能 + 更高效），**Twilight_Echo 的架构胜出**

你的判据是：**「哪个可以直接扫码登录即用、点击即听、调用歌单、加载完整歌曲信息/歌词/封面，而且还更高效，就用哪个。」**

按这七条逐项对账（证据均来自 §1.3）：

| 判据 | **Twilight_Echo** | Folia | 胜 |
|---|---|---|---|
| 扫码登录即用 | ✅ `authType:'qr'` + 801/802/800/803 全状态 | ✅ 有（QQ 需 MQTT 长连接） | **平** |
| **点击即听** | ✅ **回环媒体代理 + Range** | ✅ 直接 CDN URL | **它更稳**（代理处理鉴权/过期） |
| 调用歌单 | ✅ 六个歌单 API + 创建/删除/增删曲 | ✅ 有 | **平** |
| 完整歌曲信息 | ✅ `artists[]{id,name}` **成对同序** + `bpm`/`format`/`sampleRate`/`bitrate` | ✅ 有 | **它更全** |
| 歌词 | ✅ `/lyric/new` **优先 YRC 逐字** + 翻译 + 回退 `/lyric` | ✅ AMLL TTML DB | **Folia 更强**（AMLL 是逐词标准） |
| 封面 | ✅ `?param=600y600` / `140y140` 自动归一 | ✅ 有 | **平** |
| **更高效** | ✅ **无额外进程** + 插件可休眠 | ❌ 常驻 Node 服务端 | **它胜** |

**七项中它胜四项（含"更高效"这项你的硬判据），平三项，只输歌词一项。**

→ **结论：采纳 Twilight_Echo 的架构。** 歌词那一项**可以两者兼得**——
它的回退链是"本地 → AMLL → YRC → LRCLIB"，**把 AMLL 插在 YRC 之前**即可。

---

## 3. 方案 B 的"失去即听"担心，被它的实际做法化解了

### 3.0 我原来的担心

| 你的回答 | 内容 |
|---|---|
| 问题 1（流媒体怎么进引擎） | **B：provider 落临时文件后播** |
| 问题 2（哪个方案） | 「**点击即听**…而且还更高效就用哪个」 |

我一度认为**B 的代价正是失去"点击即听"**（必须下载完才能播）。

### 3.1 ⭐ 实际不是——它证明 B 可以做到"点击即听"

它的做法（源码 `getPlaybackUrl`）：

```js
// 点下去的那一刻：立即取签名 URL 并**异步**开始下载
void ncmApi.cacheSong(songId, url, fileName)      // 不 await，播放不阻塞
     .then((cachedPath) => { entry.cachedPath = cachedPath })

// 返回时带上"身份"信息（供 AutoMix / 音质显示用），播放器立刻可用
return playbackIdentityResult(url, url, streamItem, options, null)
```

**关键**：**下载是异步的，播放不等它。**
第一次播放走签名 URL（或等首个块就绪），后续播放命中本地缓存。

**而且它的缓存优先级是"文件存在就用文件"**（源码）：

```js
const cachedPath = await ncmApi.getCachedSong(songId)
if (cachedPath === cachedStreamEntry.cachedPath)
  return playbackIdentityResult(cachedPath, ...)      // ← 本地文件优先
```

**这解决了我担心的三件事**：

| 我担心的 | 它的解法 |
|---|---|
| 必须下载完才能播 | **异步下载，不阻塞播放**；URL 立即可用 |
| 引擎要处理 Range/断点 | 播本地文件时**全部免费**（就是普通文件） |
| 网络错误进 RT 路径 | **不进**——播的是本地文件；网络只影响"下次播放能否命中缓存" |

### 3.2 所以引擎仍然**零改动**（方案 B，不是回环代理）

```
取签名 URL（TTL = min(20min, 上游 expi)）
   → 异步 cacheSong 下载到受管缓存目录
   → 播放器拿本地文件路径（★ 引擎读普通文件，现有路径全覆盖）
   → 缓存被清/失效时回退签名 URL
```

**这与你选的方案 B 完全一致，而且不需要引擎加 HTTP。**

### 3.3 回环代理的真实定位（降级为可选）

它确实**具备**回环代理能力（插件规范 §4.1 有明文），但：

| | 用途 | 优先级 |
|---|---|---|
| **本地缓存 + 回退签名 URL** | ⭐ **主路径**（它实际就是这么做的） | **P0** |
| 回环代理 | 不落盘时播放 / 首段预读降延迟 | **P2（可选）** |

**自用场景下回环代理不是必需的**——它的唯一价值是"不想落盘"或"改善首播延迟"。

### 3.3 融合方案全图

```
┌─ Electron 主进程 ────────────────────────────────────────┐
│  ★ NCM 网关（加密/HTTP/cookie）—— 参考它的 internal.ncm    │
│  ★ 受管媒体缓存（cacheSong / getCachedSong + 回退 URL）    │
├─ utilityProcess（可休眠，5 分钟空闲）────────────────────┤
│  provider 适配层（可改造 ncm-provider 的 97KB 思路）       │
│  · 令牌桶限流（容量 5 / ~5 req/s）—— 防 460 风控          │
│  · 流 URL 缓存 TTL = min(20min, 上游 expi)                │
│  · 音质回退阶梯 + 步间退避（250→500ms）                   │
│  · 风控命中即终止整条阶梯                                 │
│  · 写操作幂等（likeTrack / 歌单增删）                      │
├─ twilight-engine.exe（已有）──────────────────────────────┤
│  只做解码与输出，★ 不知道"在线"与"本地"的区别              │
└──────────────────────────────────────────────────────────┘
```

**三方各贡献了什么**：

| 来源 | 贡献 |
|---|---|
| **Twilight_Echo** | 网关/插件/缓存三层架构 · 可休眠 · 幂等 · 限流 · **风控退避纪律** |
| **Folia** | ⭐ **AMLL TTML DB**（逐词歌词标准，插在 YRC 之前）· 平台抽象契约的完整性 |
| **我方已有** | C++ 引擎（独占/EQ/RG/dither）· 三通道设计系统 · 424 断言验证纪律 |

---

## 3.4 ⭐ 歌曲管理：这次读到的硬结论

**读完了 `playlist-lifecycle.md` + `search-and-library-identity.md` + `network-music-sources.md`。**
以下是**有明文依据**的结论（不再是上一版的推断）。

### 3.4.1 ⭐ 身份模型：**文件路径是主键，不是顺序号**

**这是最直接命中我方 CR-013 的一条**（`search-and-library-identity.md` 原文）：

> 远程源键使用 provider 与 item ID；**本地键使用归一化路径与 CUE 段**，
> **因此用新生成的 track ID 重新扫描仍能保留覆盖**。**移动文件会改变它的键。**

**三条可直接采纳的设计**：

| # | 它的做法 | 对我方的意义 |
|---|---|---|
| **1** | **本地身份 = 归一化路径（+ CUE 段）**，**不是生成的顺序 ID** | ⭐ **正是 CR-013 裁定的方向**（"归一路径 + 跳过已存在"）。**它独立得出了同一结论** |
| **2** | **"重新扫描换了 track ID 也不丢用户数据"** | ⭐ 这是路径做键**真正的收益**——用户的手动标注、版本关系、播放记录**都挂在路径上，不挂在会变的 ID 上** |
| **3** | **"移动文件会改变它的键"** —— 明确承认这个代价 | 诚实。它的解法是"缺失文件修复"（§3.4.4） |

**⚠️ 这条对我方 CR-013 的裁定有一个补充**：我方裁定里 `trackId` 仍是 `tl_NNNN` 顺序号，
**归一化路径只用于"去重判定"**。而它是**把路径本身当身份**。

| | 我方 CR-013 | 它 |
|---|---|---|
| 去重判据 | 归一路径 | 归一路径 |
| **用户数据挂在** | `tl_NNNN`（会变） | **归一路径（稳定）** |
| 重扫后 | 顺序号可能变 | **用户数据不丢** |

**→ 建议：`trackId` 的稳定性要写进 CR-013 的验收**（我方裁定里已有一句"已入库的曲目不得因为归一而换 id"，**但没规定"重扫新增文件后旧 id 不变"**）。

### 3.4.2 专辑身份：**name 不是身份**

（`search-and-library-identity.md` 原文）

> **专辑显示名不是身份。** 本地专辑组在有 `albumId` 时用它；
> 否则用归一化的 **`albumArtist + album` 元组**，**以 `artist` 作为不带 album-artist 标签文件的遗留回退**。
> 专辑导航与 Vue key 用这个 group id，**所以两个歌手用同一个专辑名仍然分开**。

**三条**：
1. **"显示名不是身份"** —— 一条值得抄进注释的原则
2. **`albumArtist + album` 元组**，而不是只 `album`
3. **回退链明确**：`albumId` → `albumArtist + album` → `artist`

**跨源的合并规则**（原文）：

> **不同源的相同名称或 ID 永不自动合并。**
> 相等名称/ID 来自不同 provider 时，**绝不自动合并**。

### 3.4.3 ⭐ 搜索：**单调递增 request id 丢弃过期响应**

（原文，**与我方 CR-007 `operationId` 是同一个模式**）

> Renderer 搜索状态**只由最新的单调递增 request id 提交**。
> 每次流式搜索在调用 provider 前**快照** `query`/`type`/`source`/`offset`。
> **较旧快照的后续响应不得改变结果、加载态或错误态。**

> `pagehide` 与组件销毁会**使未完成的 request id 失效**。

> 输入时**立即清除旧的可选结果**；更新的查询与关闭会 abort provider 请求并失效迟到的网络库读取。

**⭐ 三条细节值得单独抄**：

| # | 细节 | 为什么 |
|---|---|---|
| **1** | **搜索前快照全部输入**（`query`/`type`/`source`/`offset`） | 否则响应回来时读到的已是新输入 → 结果错配 |
| **2** | **IME 组合中不搜索**（原文：*"IME composition does not search, execute, or dismiss the palette until the composition commits"*） | ⭐ 中文/日文输入法必备；**我方 91 首大量日文，这条直接相关** |
| **3** | **统一搜索每个源的一页上限 100，`hasMore` 来自各源自己的总数** | 不能把"合并总数"当成一个源的页数 |

### 3.4.4 缺失文件修复：**只在唯一匹配时自动修**

（`playlist-lifecycle.md` 原文）

> 自动修复**只在存在一个无歧义匹配时**才改播放列表，
> **优先精确文件名，其次 `title + artist + duration`（2 秒内）**。
> **多个候选保持不动**并报告给用户手动解决。
> 一次修复**同时替换存储的快照与 track id**，所以重启后顺序仍然稳定。

**⭐ 这条的设计哲学值得学**：**"不确定就不动，报给用户"**——
与我方 DESIGN-v5 的"诚实原则"一致。

### 3.4.5 队列会话：**保存身份，不保存解析结果**

（`playlist-lifecycle.md`**唯一的** Named Queue Sessions 节）

> 保存的条目含**稳定的源身份与紧凑显示元数据**。
> **它们省略已解析的流 URL、媒体授权、缓存路径、封面、歌词与分析载荷。**
> ……**播放时重新解析可播 URL，而不是跨会话保留。**

**限额**（明文）：

| 项 | 值 |
|---|---|
| 会话数 | 20 |
| 每会话条目 | 20,000 |
| 总计条目 | 40,000 |
| 文件字节上限 | 32 MiB |
| 播放历史 | 最近 200 次 |

**⭐ 这条对我方极有价值**：我方 `playlist-lifecycle` 对应物是**队列持久化**。
**它明确说"不保存解析后的 URL"——因为那些会过期。** 我方 M3 后会有同样问题。

### 3.4.6 网络源：**`resolvePlayback` 返回两种计划**（直接回答引擎问题）

（`network-music-sources.md` 原文）

> `resolvePlayback(profileId, entry)` 返回 `NetworkPlaybackPlan`：
> - **`direct-url`**：使用协议适配器提供的可播放地址
> - **`local-cache`**：使用经过缓存处理的本地媒体文件路径
>
> **渲染层将解析结果交给现有播放链路。网络源不建立独立播放内核。**

**⭐⭐ 这两行是我方 §6.1 问题的权威答案**：

**它把"给 URL"和"给本地文件"都做成了计划的两种形态，播放链路统一。**
**而它明确不建独立播放内核** —— 与我方"引擎是唯一音频权威"同构。

**另有一条已知限制值得注意**（原文）：

> **口令源的「播放全部」会先解析（下载）全部条目再开始播放，属预缓存设计。**

⚠️ **这是我方要避免的**：别让"播放全部"变成"下载全部"。

### 3.4.7 文件夹身份：前缀匹配 + 分隔符边界

（原文）

> 文件夹卡片代表配置的扫描根。根拥有**归一路径等于根本身或以根 + 路径分隔符开头**的曲目。
> 这包含嵌套目录，**同时排除前缀相似的兄弟目录**（如根 `C:\music` 之于 `C:\music-other`）。

**⭐ 这条直接适用于我方 CR-013 的 `replace: true`**：
我裁定里写的是"按归一路径前缀判定属于该目录"——**它明确了必须"前缀 + 分隔符"**，
否则 `C:\music` 会误吃 `C:\music-other`。

**→ 这条要补进 CR-013 的实现要求。**

---

## 4. （已并入 §3.4 与附四）

**曲库/身份/队列/网络源的全部结论见 §3.4** —— 那节是读完三份文档后的硬结论。
**可直接搬的代码清单见 附四** —— 约 2000 行 Apache-2.0。

本节原来是从 `DEVELOPER_README.md` 与插件规范**交叉推断**的内容，**已删除**，避免冲突。

### 4.1 仅保留一条仍有价值的推断

**曲目 ID 的来源标识**：它的 provider 层用 `provider + item ID` 作为远程源键
（§3.4.1 原文已证实：*"远程源键使用 provider 与 item ID"*）。

**对我方的意义**：`ncm:12345` 这种前缀让**本地与在线曲目在同一条队列里不撞车**。
我方现在是 `tl_0001` 顺序号（CONTRACT §3.5），**M3 接平台后必然要做这件事**。

> ⚠️ 这条在 §3.4.1 里已有更强的版本（本地键 = 归一化路径 + CUE 段）。
> **以 §3.4.1 为准。字面格式仍未在源码确认（见附五）。**

### 4.2 引擎侧要改的（如果走 §3.3 的融合方案）

| 改动 | 说明 |
|---|---|
| `audio_source.cpp` **不需要改** | §3.2 已确认：播本地缓存文件，**引擎零改动** |
| `catalog` 的 `trackId` 语义 | ⚠️ 与 §3.4.1 的"路径是身份"对齐 → **走 CR-013 的补充** |
| `scan` 与在线源的关系 | 在线曲目不进本地 catalog（除非用户显式下载） |
| **队列持久化的字段** | 照 §3.4.5：**保存身份，不保存解析 URL / 缓存路径 / 封面 / 歌词** |

---

## 5. 音频性能：三方横向对比

| 维度 | **Twilight_Echo** | Folia | **我方** |
|---|---|---|---|
| 引擎 | C++20 + C ABI/Node-API | **无**（Web Audio） | **C++20 独立进程** |
| 独占/bit-perfect | ✅ 四字段模型 | ❌ | ✅（本机硬件受限，USB DAC 上已跑通） |
| 线程模型 | 未取到本轮细节 | 无 | 三线程 + SPSC + seqlock |
| 零分配验证 | **`process()` 耗时监控 + 超时自动 bypass**（DSP 插件层） | 无 | **drive.mjs 424 断言** |
| 响度扫描 | ✅（`analyze_loudness`） | `replayGain.ts`（Web） | ✅（libebur128 + 磁盘缓存） |
| DSD | ✅ Native/DoP/SACD ISO/DST | ❌ | DoP 直通（无 DAC 验证） |
| 测试 | **`test:*` 脚本极多**（package.json 可见十多个专用测试命令） | 少 | 424 断言 / 21 步 |

**⭐ 它的 `test:*` 脚本清单本身就是一种可抄的纪律**（从 `package.json` 读到）：

```
test:memory-assets        test:diagnostics        test:ncm-api-compatibility
test:automix              test:ncm-toplists       test:plugin-tooling
test:audio-error-coverage test:backstack          test:app-update
test:app                  test:playback-routing   test:plugins
evidence:themes           report:ipc-channels
```

**三条值得学的**：

| 脚本 | 它解决什么 |
|---|---|
| **`test:audio-error-coverage`** | **音频错误码覆盖率** —— 保证每个错误路径都被测到。我方的错误码有六个，值得对账 |
| **`report:ipc-channels` + `:baseline`** | **IPC 通道清单 + 基线**（与 DESIGN-B §3 的令牌棘轮**同一个思路**） |
| **`test:ncm-api-compatibility`** | ⭐ **专门测"网易云 API 变更"** —— 这正是社区逆向协议最大的风险 |

**最后一条对你直接有用**：我方 M3 真的接了网易云后，**上游随时可能改**。
**照它做一个 `test:ncm-compat` 脚本**，能在上游变更时第一时间发现，而不是等用户报错。

---

## 6. 需要 owner 裁定的两项

### 6.1 ⚠️ 重要更正：它**不是用回环代理播**，而是**下载到本地缓存再播**

**读 provider 源码后的更正。** 我在 §1.1 从插件规范推断"回环媒体代理"是它的播放路径——
**实际不是**。`getPlaybackUrl` 的真实返回逻辑是：

```js
// 缓存命中且文件仍在：直接返回**本地缓存文件路径**
const cachedPath = await ncmApi.getCachedSong(songId)
if (cachedPath === cachedStreamEntry.cachedPath)
  return playbackIdentityResult(cachedPath, ...)   // ← 返回文件路径，不是 URL

// 未命中时：异步缓存，拿到路径后记进缓存条目
void ncmApi.cacheSong(songId, url, fileName)
     .then((cachedPath) => { entry.cachedPath = cachedPath })
```

**所以它的播放路径与你选的方案 B 完全一致**：

```
取签名 URL（20 分钟 TTL）→ ncmApi.cacheSong 下载到受管缓存目录
                          → 播放器拿到 cachedPath（本地文件）
                          → 播放时优先用缓存，失败才回退签名 URL
```

**而且它明确保留了回退**（源码注释）：

> Cache clearing, capacity eviction, or a cache-root change can remove a downloaded file while
> this URL entry is still fresh. **Keep the signed stream URL** and only reuse the exact managed
> file that still exists.

**这意味着**：`proxyUrl` 只是"防御性兼容"的可选字段（源码注释原文 *"defensive compatibility for wrapped payloads and **the optional** proxy URL"*），
**不是主路径**。

### 6.2 ⭐ 那么结论变成：**方案 B 是它的选择，也是更好的选择**

我在 §3.1 担心的"B 失去点击即听"——**它的实际做法化解了这个担心**：

| 环节 | 它的处理 |
|---|---|
| 首次点击 | 取 URL → **异步 cacheSong 开始下载** → 立刻返回（播放器等本地路径就绪） |
| 播放中 | 播本地缓存文件（**引擎零改动**，Range/seek 全部免费） |
| 缓存被清 | **回退到签名 URL**（注释明确保留） |
| URL 过期 | `expi` 字段驱动的 TTL，`Math.min(20min, item.expi * 1000)` |

**它的 TTL 逻辑还更细**（源码）：

```js
const ttl = Number(item.expi) > 0
  ? Math.min(STREAM_URL_CACHE_TTL_MS, Number(item.expi) * 1000)   // ← 用上游给的过期时间
  : STREAM_URL_CACHE_TTL_MS
```

**既尊重上游的 `expi`，又有自己的 20 分钟上限。**

### 6.3 所以裁定项简化为一句话

**采纳方案 B（下载到本地缓存再播）——这与它的实际做法一致，且引擎零改动。**

我在 §3 提的"回环代理"**仍然有价值，但降级为可选增强**（不是必需的架构）：

| | 用途 | 优先级 |
|---|---|---|
| **本地缓存 + 回退签名 URL** | ⭐ **主路径**（它的选择） | **P0** |
| 回环代理 | 预读首段 + 不落盘的即时播放 | P2（可选，若将来嫌弃"等下载"） |

**回环代理的唯一剩余价值**：不想落盘时（版权洁癖 / 磁盘空间），以及"首段预读"改善首播延迟。
**自用场景下它不是必需的。**

---

## 7. 投入产出比最高的六条

| # | 动作 | 依据 | 成本 |
|---|---|---|---|
| **1** | **采纳三层架构**：进程内网关 + provider 可休眠 + **本地缓存播** | `index.mjs` 全文 | 中 |
| **2** | ⭐ **本地缓存 + 回退签名 URL**（不是代理） | 源码 L1844-1935 + 注释 | 中 |
| **3** | **令牌桶限流**（容量 5 / ~5 req/s）+ **TTL 用 `min(20min, expi)`** | `acquireRequestToken` / `rememberStreamUrl` | 小 |
| **4** | **音质回退阶梯 + 步间退避**（250ms 起步封顶 500ms）+ **风控命中即终止整条阶梯** | `getPlaybackUrl` 的循环 + 注释 | 小 |
| **5** | **风控错误翻译成人话**（301/460/安全风险 各给下一步） | `describeApiError` | 小 |
| **6** | **写操作幂等**（`likeTrack`/关注/歌单增删，`idempotencyKey` + 持久化） | `runIdempotentProviderWrite` | 小 |

### 7.1 ⭐ 第 4 条是本次最值得学的一条（我原方案里没有）

它的回退阶梯有**两条纪律**（源码注释原文）：

> **回退阶梯步间退避（250ms 起步、封顶 500ms）**：连续失败的连打既放大风控概率，
> 也让低级音质的响应无意义地挤占带宽。

> **风控提示命中即终止整条阶梯**：继续连打只会加深风控。

> **风控命中后连灰色解锁也不再试**——它同样是上游请求，会把风控窗口越拉越长。

**这三条直接对应我方 CONTRACT §5 的风控约束**，而且比我原来写的"收到 -460 立即停止"更细：
**它连"回退到更低音质"这个看似无害的动作也停了**——因为那是另一次上游请求。

---

## 8. 一句话

> ⭐ **最终结论**：**三方用的都是 `api-enhanced`**（Folia 自备 / Twilight_Echo 主进程内启动 / 我方原计划）。
> **所以 M3 最难的一块（加密协议）不需要自己写** —— 我方 CONTRACT §4 的原计划是对的。
>
> **Twilight_Echo 真正的价值不是"替代方案"，而是"怎么用好 `api-enhanced`"**：
> ① 用字符串 `'0'` 让 OS 分配空闲端口（绕过上游 `port || 3000`）
> ② 写类/登录/个性化路径强制加时间戳，读类不加
> ③ `redactSensitiveText()` 的凭据脱敏正则
> ④ 双后端凭据信封（`safeStorage` + AES-GCM 机器指纹 + **scope 隔离** + 敏感键正则）
> ⑤ 令牌桶限流 / 回退阶梯步间退避 / **风控命中即终止整条阶梯**
> ⑥ **本地缓存播**（异步下载不阻塞，引擎零改动，缓存失效回退签名 URL）
>
> **你要的不是它的插件生态（`.tep`/索引签名/市场是给第三方的），而是这六条纪律。**

---

## 附：本轮读到与未读的

### ✅ 本轮已读（一手）

| 文件 | 体量 | 收获 |
|---|---|---|
| **`src/main/ncm/api.ts`** | **10.5 KB** | ⭐⭐ **网关真相**：`serveNcmApi()` + 四条工程细节（端口/时间戳/脱敏/幂等） |
| **`src/main/ncm/serverBinding.ts`** | 938 B | 端口获取 |
| **`src/main/security/secureStorage.ts`** | — | ⭐ **双后端信封 + scrypt 机器指纹 + scope 隔离 + 敏感键正则** |
| `resources/plugins/ncm-provider/index.mjs` | 96,936 B | ⭐ 播放路径三级优先 / 令牌桶 / TTL / 退避 / 幂等 |
| `resources/plugins/ncm-provider/plugin.json` | 498 B | 权限与能力声明 |
| `docs/playlist-lifecycle.md` | — | 队列会话 / 导入导出 / 缺失文件修复 / 版本关系 |
| `docs/search-and-library-identity.md` | — | ⭐ **身份模型**（路径是主键）/ 专辑身份 / 搜索 request id |
| `docs/network-music-sources.md` | — | ⭐ **`resolvePlayback` 两种计划** / WebDAV 行为 |
| `docs/twilight-echo-plugin-spec.md` | — | manifest / 权限枚举 / `.tep` 格式 |

### ✅ 已读（上一轮）

`audio-engine/README.md` · `docs/audio-engine-api.md` · `docs/release-capability-status.md` ·
`docs/DEVELOPER_README.md`（76 KB）· `package.json`

### ❌ 仍未读（如实说明）

| 项 | 位置 | 优先级 |
|---|---|---|
| SQLite schema / 迁移 / 重复检测 / 专辑聚合 | `src/main/library/**` | 中 |
| `src/main/security/` 其余文件 | — | 中 |
| 云盘传输（分片/断点） | `src/main/ncm/cloudTransfer.ts`（20.5 KB） | 低 |
| 回环代理实现 | 未定位 | **低（已降级 P2）** |

### ⚠️ 一处仍未核实的推断

`ncm:` 前缀 ID 的**具体字符串格式** —— §3.4.1 已证实"远程源键使用 provider 与 item ID"，
但**字面格式我没在源码里看到**。实现前请以源码为准。

---

## 附一：⭐ 一条对我方 CR 的直接建议（`secureStorage` 的四条）

我方 CONTRACT §5 只写了"凭据用 `safeStorage`"（且注意 Electron 46 移除同步 API）。
**它的实现给出了更完整的方案，建议照抄**：

```ts
// 我方建议的对应实现
interface SecureValueEnvelope {
  __twilightSecure: true
  version: 1
  backend: 'electron-safe-storage' | 'aes-256-gcm-machine'   // ★ 双后端
  ciphertext: string
  iv?: string
  tag?: string
}
```

| # | 采纳它的哪条 | 为什么 |
|---|---|---|
| **1** | **双后端 + 信封带 `backend`** | `safeStorage` 在部分 Windows 环境也会不可用；**自动回退且解密时知道用哪个** |
| **2** | **scrypt 机器指纹派生密钥** | 不需要额外密钥文件；**换机器解不开**（对自用是正确取舍） |
| **3** | ⭐ **`scope` 参与派生** | **防止跨 scope 的密文搬运**（多平台 cookie 各自隔离） |
| **4** | ⭐ **`isSensitiveStorageKey()` 正则** | **新增存储键时自动获得保护**，不靠人记得加密 |

**这四条要写进 CR**（CONTRACT §5 的补充），因为它改的是**凭据存储的实现约定**。

---

## 附二：⭐ 网关的真相（读完 `src/main/ncm/` 后的第三次更正）

### 结论：**它用的就是 `api-enhanced`——和我方 CONTRACT §4 原计划、以及 Folia 是同一个**

**决定性证据**（`src/main/ncm/api.ts` 源码原文）：

```js
async function startNcmServer(): Promise<void> {
  const { serveNcmApi } = await import('@neteasecloudmusicapienhanced/api/server.js')
  const ncmApp = await serveNcmApi({
    port: NCM_API_EPHEMERAL_PORT,     // 字符串 '0' → 操作系统分配空闲端口
    host: NCM_API_HOST,               // '127.0.0.1'
    checkVersion: false
  })
  runtime.ncmServer = ncmApp.server
  console.log(`网易云音乐服务已启动：http://${NCM_API_HOST}:${port}`)
}
```

**`src/main/ncm/` 只有 6 个文件**：

| 文件 | 体量 | 职责 |
|---|---|---|
| `api.ts` | **10.5 KB** | ⭐ **启动 `api-enhanced` 服务 + 转发请求**（不是加密实现！） |
| `cloudTransfer.ts` | 20.5 KB | 云盘上传/下载（大文件分片） |
| `cloudTransferHelpers.ts` | 5.8 KB | 云盘辅助 |
| `serverBinding.ts` | **938 B** | 只在监听后取端口 |
| `api.test.ts` | 5.3 KB | 测试 |
| `cloudTransferHelpers.test.ts` | 7.6 KB | 测试 |

**总计约 50 KB——其中一半是云盘传输，加密一行都没有。**

### ⭐ 所以最终架构是（与我上一条完全不同）

```
┌─ Electron 主进程 ──────────────────────────────────────────┐
│  ★ api-enhanced 的 serveNcmApi()（第三方 npm 包）           │
│     运行在 127.0.0.1:<OS 分配的随机空闲端口>                 │
│     ← 加密/签名全在这里                                     │
│  ★ requestNcmApi()（10.5 KB 转发层）                        │
│     · 路径校验 / cookie 归一 / 时间戳 / 幂等键 / 超时        │
│     · undici Agent（8 连接 + keep-alive 60s）               │
├─ utilityProcess（可休眠）──────────────────────────────────┤
│  ncm-provider 插件（97 KB 适配层）—— 经 internal.ncm 调用    │
├─ 受管媒体缓存（cacheSong / getCachedSong）                  │
├─ twilight-engine.exe（既有）                                │
└────────────────────────────────────────────────────────────┘
```

**所以三方其实是同一个方案**：

| | 协议实现 | 进程形态 |
|---|---|---|
| **Folia** | `api-enhanced` | 用户自备/内置服务端 |
| **Twilight_Echo** | **`api-enhanced`** | **主进程内启动，OS 分配端口** |
| 我方原计划 | `api-enhanced` | 主进程自动拉起 |

**→ 三方同源。差别只在"谁启动它、跑在哪个端口、有没有包一层 provider"。**

### ⭐ 但从这 10.5 KB 里挖到四条真东西

它的转发层虽然小，**但有四处工程细节值得直接抄**：

**① 用字符串 `'0'` 骗过上游的 `port || 3000`**（源码注释原文）：

```js
// The upstream server treats numeric 0 as absent (`options.port || 3000`).
// A string keeps the request for an OS-assigned port while still being
// converted to number 0 inside serveNcmApi.
const NCM_API_EPHEMERAL_PORT = '0' as unknown as number
```

**⭐ 这是"OS 分配空闲端口"的正确做法**，且注释解释了这个 trick 为什么必要。

**② 特定路径强制加时间戳**（防缓存）：

```js
const TIMESTAMPED_NCM_API_PATHS = [
  '/login', '/login/', '/playlist/create', '/playlist/delete', '/playlist/tracks',
  '/like', '/follow', '/personal_fm', '/personal/fm/mode'
]
```

**读类的 GET 不时间戳，写类与登录/个性化加** —— 精确的取舍。

**③ 凭据脱敏（`redactSensitiveText`）** —— 它对日志做的清洗：

```js
.replace(/(MUSIC_U=)[^;\s]+/gi, '$1[REDACTED]')            // 网易云主凭据
.replace(/(__csrf=)[^;\s]+/gi, '$1[REDACTED]')
.replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
.replace(/((?:X-Api-Key|X-Signature)\s*:\s*)[^\s,;]+/gi, '$1[REDACTED]')
// 以及 query 里的 password/captcha/token/cookie/... 全部脱敏
```

**⭐ 直接对应我方 CONTRACT §5 与 SPEC §9.4「日志里绝不能带 token」。**

**④ `secureStorage.ts` 的双后端设计**（这是**本轮最有价值的一条**）：

```js
export interface SecureValueEnvelope {
  __twilightSecure: true
  version: 1
  backend: 'electron-safe-storage' | 'aes-256-gcm-machine'   // ★ 双后端
  ciphertext: string
  iv?: string
  tag?: string
}

// 优先 Electron safeStorage；不可用时回退 AES-256-GCM + 机器指纹派生密钥
function deriveFallbackKey(scope: string): Buffer {
  const material = [
    'twilight-echo-secure-storage-v1',
    process.platform, process.arch,
    hostname(), user.username, user.homedir,
    scope                                                   // ★ 按 scope 隔离
  ].join('\0')
  return scryptSync(material, 'twilight-echo-local-machine', 32)
}
```

**三条设计**：

| # | 设计 | 为什么好 |
|---|---|---|
| **1** | **双后端 + 信封带 `backend` 字段** | Linux 等 `safeStorage` 不可用的环境自动回退，**且解密时知道用哪个后端** |
| **2** | **密钥从机器指纹派生（scrypt）** | 不需要额外密钥文件；换机器就解不开（**对自用是正确取舍**） |
| **3** | ⭐ **`scope` 参与派生** | **同一个 cookie 存在不同 scope 下密文不同** —— 防止跨插件/跨域的密文搬运 |
| **4** | **`isSensitiveStorageKey()` 正则**（按 key 名自动判定敏感） | 新增存储键时**自动获得保护**，不靠人记得加密 |

> ⚠️ **但它有一个诚实的局限**：AES 回退的密钥材料包含 `hostname/user/homedir`，
> **都是同机可取的信息**——它防的是"配置文件被拷走"，**不防"同机恶意程序"**。
> 自用场景下这是**正确的取舍**（它自己在注释里也没假装更强）。

### 我上一条说错的三处（汇总）

| # | 我原来说 | 真相 |
|---|---|---|
| **1** | 它自己实现加密协议（97 KB 插件） | ❌ **加密来自 `api-enhanced`**；插件是适配层 |
| **2** | 它用回环媒体代理播 | ❌ **下载到本地缓存再播** |
| **3** | 网关是它自研的（"最大工作量"） | ❌ **同一句话：它就是 `serveNcmApi()`**，**10.5 KB 转发层** |

**→ 三处更正都指向同一结论：M3 的最难一块（加密协议）三方都用 `api-enhanced` 解决，我方原计划就是对的。**

---

## 附三：本次"先读"带来的完整更正清单

| # | 我原来的说法 | 读后更正 |
|---|---|---|
| **1** | 它自己实现加密协议（97 KB 插件） | **加密在 `api-enhanced`**，插件是适配层 |
| **2** | 它用**回环媒体代理**播 | **下载到本地缓存再播**，`proxyUrl` 只是防御性兼容 |
| **3** | 方案 B 会失去"点击即听" | **不失去** —— 异步下载不阻塞播放 |
| **4** | 网关是自研的、是 M3 最大工作量 | **它就是 `serveNcmApi()` + 304 行转发层** |
| **5** | **它有 SQLite schema / 迁移 / 索引 / FTS** | ❌ **没有 SQLite**。单一 JSON 文档；**且它用 50k 轨实测否决了 SQLite** |
| **6** | **它的"16,813 首"性能** | ❌ **该数字在任何一手来源中都不存在**（docs + audit-evidence 零命中）。**请勿引用** |
| **7** | 它的栈是 **Electron + React** | ❌ **是 Vue 3 + Vite**。抄组件要过一遍转换 |
| **8** | 它的引擎是"同进程 C ABI" | ⚠️ **它已改为"可重启的 Audio Engine Service"**（`TWILIGHT_AUDIO_SERVICE=0` 可关）—— **已收敛到我方独立进程架构** |

**六条更正共同指向**：

1. **M3 的协议部分，我方原计划（用 `api-enhanced`）是对的** —— 三方同源；
2. **曲库部分它是"真金白银可搬的约 2000 行"**（见附四）；
3. **它的架构终点与本方一致**（可重启的独立音频服务）—— 独立进程不是"多一层开销"，是崩溃隔离的正确取舍。

---

## 附四：⭐⭐ 可直接搬的曲库工程（约 2000 行，全部 Apache-2.0）

**这是本次调研最实在的收获。** 我此前在 §4.3 说"没取到 schema/重复检测/聚合算法"——
**子代理取到了，而且它们都可以整文件照搬。**

### 4.1 最高价值四件（按性价比）

| # | 文件 | 行数 | 它能补齐我方什么 |
|---|---|---|---|
| **1** | **`src/main/library/duplicateDetection.ts`** | **351** | ⭐ **我方完全没有重复检测**。五级证据链（见 §4.2），10k 行 **p50 32.8ms / p95 57.9ms**（预算 1500/2500ms） |
| **2** | **`src/renderer/src/utils/musicMetadataMatching.ts`** | **274** | ⭐ **补全永不复写**的字段级规则（见 §4.3） |
| **3** | **`src/main/library/tagWriteService.ts`** | **252** | 批量标签编辑的**完整正确实现**：备份→写→日志→**逆序回滚**（含崩溃恢复） |
| **4** | **`src/main/library/scanPlanner.ts` + `fileIndex.ts`** | **82 + 204** | 纯函数增量扫描计划器 + 文件身份 `size + mtimeMs + cueSignature` |

**外加两个小件**：`src/shared/duplicateDetection.ts`（73 行，类型契约）、
`src/main/library/libraryRepository.ts`（400 行，**`revision` 乐观并发 + 原子替换 + 备份恢复**）。

### 4.2 ⭐ 五级证据链（`EVIDENCE_ORDER`，源码实测）

```ts
const EVIDENCE_ORDER = ['path', 'contentHash', 'audioFingerprint',
                        'metadataCandidate', 'logicalTrack']
//                      exact ─→ ─→ ─→ ─→ probable
```

| 级 | 判据 | 强度 | 关键细节 |
|---|---|---|---|
| **1** | `canonicalPathKey` | **exact** | `normalize()` + win32 小写 |
| **2** | `contentHash` | **exact** | 流式 SHA-256；**只对「size 相同且出现 ≥2 次」的候选算**（sizeCounts 预筛）；并发 1..8 默认 4 |
| **3** | `audioFingerprint` | exact | ⚠️ **仅当 `evidence === 'verifiedAcoustic'`**；注释明说**宿主当前不生成指纹**，legacy 一律降级 review-only |
| **4** | `metadataCandidate` | **possible** | `(duration 归到 0.5s, size, sampleRate, bitrate, format)` |
| **5** | `logicalTrack` | **probable** | `(归一化 title, artist, album, 0.5s 时长)` |

**三条设计值得学**：

1. **每级命中的候选从 `remaining` 移除** → 五级**互斥不重复计数**
2. ⭐ **哈希前先按 size 分组** → 避免对全部文件算 SHA-256（**性能关键**）
3. ⭐ **`createDuplicateActionPlans` 强制 `destructive: false`** —— **它只生成建议计划，不删任何文件**

> ⭐ **第 3 条与我方 DESIGN-v5 的诚实原则同构**：**工具只报告，不擅自破坏。**

### 4.3 ⭐ 元数据补全：**"弱来源"落实在字段级**

`enrichLocalTrackMetadata`（:115-169）的规则：

```ts
// artist/album 仅在"本地是占位符 且 远端不是占位符"时才取远端
if (isMetadataPlaceholder(local) && !isMetadataPlaceholder(remote)) { ... }

// 封面/歌词/翻译歌词：本地非空即胜出
const cover = localTrack.cover ?? metadata.cover ?? null
```

**占位符集合**（:34-42）：

```
unknown / unknown artist / unknown album / 未知 / 未知艺术家 / 未知歌手 / 未知专辑
```

**匹配门槛 `scoreMetadataMatch`**（:197）：

| 因子 | 规则 |
|---|---|
| 标题 | 须 **exact 或仅标点差异** |
| 艺人 | 须 **子集双向包含** |
| 时长 | 差 >20s **直接拒**；**艺人非全等时差必须 ≤8s**（防"同台嘉宾"误配） |
| 评级 | 分数 70 起；`exactArtists && score>=90` 才 `high` |

**网络补全不延迟首屏**：`LibraryMetadataEnrichmentQueue`（467 行），默认 **6 worker（钳制 4–8）**，
按 `归一化(title+artist)` 去重，失败**指数退避 15s→5min**。
⭐ **迟到结果用"源快照栅栏"丢弃**：更新携带 `source: Track` 原对象，**与当前记录不同即隔离**。

> ⚠️ **它不走 MusicBrainz** —— `musicMetadataSearch.ts` 只是对**已登录的流媒体 provider**
> `searchSongs` 的薄封装。**所以"网络补全"依赖你已接入的平台。**

### 4.4 ⭐ 文件身份：**`cueSignature` 入身份**（我方应抄）

```ts
sameLocalLibraryFileIdentity(known, identity)
// 比较：size + mtimeMs + cueSignature（+ 独立的 metadataVersion）
```

**`cueSignature` 入身份是聪明处**：**兄弟 CUE 变了要重解析音频**——
因为 CUE 决定分轨边界，改了 CUE 而不重解析就会用旧的 segmentation。

**扫描执行**（`libraryScanService.ts`，35.4 KB）**可取消/可暂停/可续跑**：

| 常量 | 值 |
|---|---|
| `SCAN_BATCH_SIZE` | 256 |
| `IDENTITY_BATCH_SIZE` | 1024 |
| `PARSE_CONCURRENCY` | 4 |
| `PARSE_TIMEOUT_MS` | 30,000 |
| `COVER_LOOKUP_TIMEOUT_MS` | 10,000 |

**续跑检查点**：`resumeCheckpoint{identities, completeIdentitySnapshot, completedFilePaths, parsedFileCount}`。
⭐ **删除判定要求 `completeIdentitySnapshot`**，否则不误删——**这是"扫描中断时不要误删"的正确做法。**

### 4.5 批量标签编辑：**备份→写→日志→逆序回滚**

```
逐文件 copyFileSync 备份 → 写标签（TagLib）→ 每步持久化 journal
   ↳ 任一步失败 → rollbackJournalEntries（:194）★ 逆序还原
```

| 项 | 值 |
|---|---|
| journal | `tag-write-journal.json`（v2，≤2 MiB） |
| IPC 上限 | **单批 ≤1000 文件**、文本 ≤1024 字符、封面 ≤8 MiB / ≤4096px |
| 语义 | ⭐ **空白字段不覆盖**（"typing then clearing" 不擦除标签） |
| 结果四态 | `success \| failed \| rolledBack \| notAttempted` |
| 缓存刷新 | ⭐ **只有确认成功且仍匹配快照的才刷新** |

### 4.6 专辑身份三级（`getAlbumIdentity`，补充 §3.4.2）

```ts
id:<albumId>                                  // 有 tag 就用
name:<albumArtist 小写>\u001f<album>          // ★ 仅当 albumArtist 确实区别于 artist
dir:<目录>\u001f<album>                       // 同目录多艺人的合辑
```

⭐ **第 2 级有个专门的防御**（:21-22）：**丢弃"旧扫描把 artist 塞进 ALBUMARTIST"的污染**——
只有当 `albumArtist` 确实不同于 `artist` 时才用它。**这是被真实数据坑过才会写的代码。**

**合辑判定**（`resolveAlbumArtist`）：owner 唯一→用它；否则 track artist 唯一→用它；
否则 `><多艺人> → '群星'`，无则 `'未知歌手'`。

**多碟排序**（`compareAlbumTrackOrder`）：discNumber → trackNumber → **`Intl.Collator('zh',{numeric:true})` 文件名** → 标题。

**同目录分轨的补救**（`mergeAlbumGroupsByReleaseEvidence`）：`dir:` 组按
**（封面身份, 归一化专辑名）** 二次归并；⭐ **显式 `id:`/`name:` 组永不进入该路径**。

> ⚠️ **对我方 91 首 FLAC 的具体影响**：**若无 albumArtist 标签，会落到 `dir:` 分支**——
> 这正合"一专辑一目录"的实际情况。

### 4.7 "曲库整理收件箱"：**从不可变快照派生，不解析、不哈希、不联网**

三类 issue：缺封面 / 必填标签（含⭐**标题==文件名主干**，明确标注为 *possible fallback*
而非"缺标签的证明"）/ 待确认的 medium 置信度匹配。

| 项 | 值 |
|---|---|
| 决策存储 | renderer localStorage `twilight.library-inbox.v1` |
| 上限 | **20,000 条** |
| 围栏 | **身份 + 内容指纹**；元数据一变 issue 重新变 pending |
| 单页 | 50 行 |

⭐ **它把"标题等于文件名"标注为 possible fallback 而不是"缺标签的证明"** ——
**这是诚实的：文件名主干可能本来就是真标题。**

### 4.8 ⭐ 引擎侧两条可吸收的（与我方独立进程架构有关）

**① epoch ACK 世代交接**（`docs/twilight-audio-engine-architecture.md:31-32`）：

> control thread 编译 / render callback 提交，用 **epoch ACK** 换图；
> 退役 `DecodeStream` 同样 epoch 回收 —— control 撤 render 指针后递增 `retiredStreamEpoch_`，
> render callback **读指针前采样该值**，每条退出路径末尾回 ACK。

**这是无锁世代交接**。**我方对应问题**：JSON Lines 架构下，
**"控制消息如何在不加锁的前提下切换 DSP 图/解码流"** —— 他们在**同进程**解决，
**我方在跨进程下必须解决得更小心**（seqlock 已有，但"世代 ACK"这个模式可以补上）。

**② typed PCM passthrough**（:49）：

> WASAPI Exclusive / ASIO 在严格 bypass 下，FFmpeg decode 输出、`AudioBuffer`、
> 后端 typed render **共享同一实际 PCM 格式**（Int16/Int24/Int32/Float32），避免中间转换。

**与我方 CR-010 的四字段模型同源**，但它把这做成**类型系统层面**的保证。

**③ 一个关键事实：它也已经收敛到我方的架构**

`docs/twilight-echo-plugin-spec.md:274-277` 原文：

> 生产宿主由**可重启 Audio Engine Service** 默认承载该引擎，
> **避免原生 DSP 硬崩溃退出 Electron 主进程**；`TWILIGHT_AUDIO_SERVICE=0` 关闭。

**即：它把音频引擎从"同进程 C ABI"改成了"可重启的独立服务"** ——
**这正是我方的架构选择。** 独立进程不是"多一层开销"，是**崩溃隔离的正确取舍**。

### 4.9 投入产出比最高的五条（子代理排序，我采纳）

| # | 动作 | 依据 | 成本 |
|---|---|---|---|
| **1** | ⭐ **照搬 `duplicateDetection.ts` + `metadataMatching.ts`（约 625 行）** | 补齐"无重复检测、无标签补全"，算法已验证（10k 行 p95 57.9ms），**不触碰引擎与协议**，纯新增 | **约两天** |
| **2** | 套用 `scanPlanner` + `fileIndex` 的 **`size+mtime+cueSignature` 身份** | 91 首无感，但这是**唯一会让你未来上万首时后悔**的地方 | 小 |
| **3** | M3 按「HTTP 服务端 + 薄 provider 接口」推进；**先只做 Navidrome + 网易云**；**不要自己写 eapi、不要照搬 Folia 三服务端** | 见 §2 与附二 | 中 |
| **4** | 抄 `tagWriteService` 的 **journal 回滚模式**；**立刻**把 `redactSensitiveText` 正则用在引擎与 provider 日志上 | 防 `MUSIC_U` 泄漏，**20 行** | **立即** |
| **5** | 吸收 **epoch ACK** 与 **typed PCM passthrough** 思路 | 见 §4.8 | 中 |

> ⭐ **为什么第 3 条建议先做 Navidrome**：**它是标准 Subsonic REST，无签名、无逆向**，
> 用现成 `subsonic-api` 或手写 5 个端点即可，**风险远低于网易云**。
> 而网易云那 2761 行的复杂度**全部来自上游协议**，不是你该承担的部分。

---

## 附五：⚠️ 仍未验证项（不要当结论用）

| 项 | 状态 |
|---|---|
| **"16,813 首"** | ❌ **不存在**。已 grep 全部 `docs/` + `audit-evidence/`，零命中。只有合成基准 10k / 5k / 20k / 50k |
| **QQ / 酷狗 / B站 / YouTube 的 provider 实现** | ❌ **源码不在该仓库**（在内置索引 `resources/plugin-index/plugins.json` 与第三方 `.tep` 包中） |
| **汽水音乐登录** | ❌ 依赖仓库外的 `qishui-auth-v6.cjs` **二进制组件**，实现未核实 |
| **`ncm:` 前缀 ID 的字面格式** | ⚠️ 已证实"远程源键使用 provider 与 item ID"，但**字面格式未在源码看到** |

### 已确认存在、但本轮未读的文件

| 项 | 位置 | 优先级 |
|---|---|---|
| 云盘传输（分片/断点/校验） | `src/main/ncm/cloudTransfer.ts`（20.5 KB） | 低（自用不一定用云盘） |
| 网络代理安全策略 | `src/main/plugins/proxyBootstrap.ts`（**541 行**） | 低（重定向降级防护完整） |
| `src/main/security/` 其余文件 | — | 中（`secureStorage.ts` 已给最大收获） |
| 回环代理实现 | 未定位 | **低（已降级 P2）** |

---

## 附六：一句话总结（最终版）

> **这不是"选一个更好的外部项目"的问题——三家用的都是 `api-enhanced`。**
>
> **Twilight_Echo 的价值是两份清单**：
>
> **① 「怎么用好 `api-enhanced`」的六条纪律**（端口 trick / 时间戳 / 脱敏 / 双后端凭据信封 /
> 令牌桶+退避 / **本地缓存播**）—— **这些是它踩过坑换来的，我方白拿。**
>
> **② 「一个自用播放器的曲库该怎么做」的约 2000 行 Apache-2.0 代码** ——
> **重复检测（五级证据链）、元数据补全（永不复写）、标签写入（journal 回滚）、
> 扫描身份（`size+mtime+cueSignature`）** —— **我方现在的曲库是这四块全空白。**
>
> **而且它的架构终点与我方一致**：**可重启的独立音频服务**。
> 它绕了一圈从"同进程 C++ 引擎"回到我方的独立进程模型 ——
> **这说明我方一开始的选择是对的，不必因为它而动摇。**
