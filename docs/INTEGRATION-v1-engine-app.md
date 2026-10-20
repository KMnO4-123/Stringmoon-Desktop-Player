# 两边对接方案 · 引擎 ↔ 应用（回环媒体通路）

> **状态**：✅ **已接通并通过 L2 验收** · **日期**：2026-10-16（更新于当晚） · **给谁**：AI-A（引擎）+ AI-B（应用）
> **上位**：[`PLAY-v1-login-and-streaming.md`](PLAY-v1-login-and-streaming.md) §1 · [`contract-requests.md`](contract-requests.md) CR-016
> **性质**：这是**已有件之间的最后一公里** —— 两侧都已完成，只差一个字段与一次调用
>
> ⭐ **2026-10-16 晚更新：这一公里已经走完。** 引擎 `url` 分支已实施，
> 应用侧接线也已就位（`app/src/main/online-playback.ts`），
> **L2 端到端 21/21 通过**（`pnpm test:l2`，本地 HTTP 源扮演 CDN）。
> 下文"⏳ 待实施 / ❌ 没有"的状态表保留作历史对照，当前状态见 §0.1。

---

## 0.1 ✅ 当前状态（2026-10-16 晚，已验收）

| 组件 | 状态 | 位置 |
|---|---|---|
| 引擎 `cmdOpen` 的 `url` 分支 | ✅ **已完成** | `engine/src/app.cpp`：`url` 与 `trackId` 互斥；两者同时给返回 `ERR_STATE` |
| 引擎载入状态与身份分离 | ✅ **已完成** | `Player::sourceLoaded_` / `hasSource()`：URL 源的 `trackId` 合法为空 |
| 单一路径复用 | ✅ **已完成** | `Player::openSourcePath()`：`openTrack` 与 `openUrl` 共用全部下游逻辑 |
| 应用侧回环代理 | ✅ 已完成 | `app/src/main/media-proxy.ts`（含 `refresh()` 重签） |
| 应用侧在线播放所有者 | ✅ **已完成** | `app/src/main/online-playback.ts`：一次播放一个 token，切歌/退出即失效 |
| **If-Range 版本钉住** | ✅ **已修复** | 代理原本**丢弃**引擎的 `If-Range`；现已转发，并在 L2 断言 |
| L2 端到端验收 | ✅ **21/21** | `app/tools/test-l2-integration.mjs`（`pnpm test:l2 <flac>`） |
| L3/L4（真 provider / 弱网） | ⏳ 待做 | 依赖 provider 接入 |

⭐ **L2 实际断言覆盖**（见该脚本）：代理字节等价、`open {url}` 成功且 `trackId` 为空、
源码格式取自解码器、Range 真的到达代理（证明走的是 HTTP 后端而非本地读）、
256 KiB 窗口、HTTP 上的 seek、416 形状、**If-Range 真的到达 CDN**、
过期签名 `refresh()` 自愈、撤销 token 后打开报 `ERR_DECODE`（传输失败不是 EOF）。

---

## 0. 先说最重要的一句

> ⭐ **两侧都已经做完了。缺的不是功能，是"接上"。**

| 组件 | 状态 | 证据 |
|---|---|---|
| **应用侧回环代理** | ✅ **已完成** | `app/src/main/media-proxy.ts`（**310 行**）：`LoopbackMediaProxy` 类、`206`/`416`/`Accept-Ranges`、`Content-Range` 解析、**`refresh()` 自动重签**、`requestWithRefresh()` |
| **应用侧引擎宿主** | ✅ 已完成 | `app/src/main/engine-host.ts`（194 行），含真引擎探测（`..\..\engine\bin\twilight-engine.exe`） |
| **引擎侧 IO 后端** | ✅ **已完成** | `FileReader` 的 WinHTTP Range 后端；`--probe-decode` 本地/HTTP 两条路径**逐样本对照**通过（5 seek / 5,722,416 帧） |
| **引擎侧 `cmdOpen`** | ✅ **已完成**（CR-016） | `app.cpp` 的 `cmdOpen` 现有 `url` 分支，与 `trackId` 互斥 |
| **应用侧 `register()` 调用** | ✅ **已完成** | `app/src/main/online-playback.ts`（`onlinePlayback.open()` → `register()` → 引擎），退出时 `release()` 失效 token |

**→ 对接 = ① 引擎加 `url` 入口（CR-016）+ ② 应用侧把 `register()` 接上。二者均已完成。**

---

## 1. ✅ CR-016：**已裁定接受**（2026-10-16，owner）

**引擎侧已提出，待裁定。** 内容（`docs/contract-requests.md`）：

```json
{"cmd":"open","url":"http://127.0.0.1:<port>/media/<token>"}
```

**五条约束**（原文，均已与项目铁律一致）：

| # | 约束 | 为什么它是对的 |
|---|---|---|
| **1** | `url` 与 `trackId` **互斥**；缺二者仍 `ERR_NOTFOUND` | 不产生歧义 |
| **2** | ⭐ **URL 只作为路径交给引擎，音频样本不穿越 stdio** | 符合 CONTRACT §3 **铁律 2** |
| **3** | 元数据由应用侧提供，或 `state` 里留空；**本 CR 不新增元数据命令** | 范围最小 |
| **4** | ⭐ Range / 鉴权 / 重签**继续由回环代理负责**；引擎在网络失败时**停止并报告错误，不把失败当作 EOF** | ⭐ 正是 `read_proc` 契约的要求（见 §4） |
| **5** | 现有本地 `trackId` 路径与既有回复字段**不变** | 无回归 |

**→ ✅ 已裁定接受，五条约束无修改。** 两个 AI 现在都可以开工 —— 见 §7 的推进顺序。

---

## 2. 时序：一次在线播放的完整链路

```
[应用侧]                                       [引擎侧]
   │
   │ ① provider 取签名 URL
   │    （网易云 / QQ，含 TTL 与 Referer/UA 要求）
   │
   │ ② mediaProxy.register({
   │      url, referer, userAgent,
   │      refresh: () => provider.renew()      ← ★ 重签钩子（已实现）
   │    })
   │    → 返回 http://127.0.0.1:<port>/media/<token>
   │
   │ ③ {"cmd":"open","url":"http://127.0.0.1:.../media/<tok>"}
   ├──────────────────────────────────────────────▶
   │                                   ④ 嗅探头部 16 字节判容器
   │                                   ⑤ FileReader 选 WinHTTP Range 后端
   │                                   ⑥ dr_flac/dr_mp3 用 4096 字节读
   │                                      （实测的最大请求，见 §4）
   │ ⑦ 代理转发到 CDN ──▶ Range ──▶ 206 + Content-Range
   │ ◀──────────────────────────────────────────────
   │                                   ⑧ 出声
```

**⭐ 关键设计点**：**④⑤ 在引擎侧，⑥ 才第一次真正发 HTTP** ——
所以"点开"到"出声"的延迟主要在第 ⑥ 步的首字节，而不是代理。

---

## 3. 应用侧改动（AI-B）—— **只需接线**

### 3.1 在播放路径上调用 `register()`

```ts
import { mediaProxy } from './media-proxy'

async function openOnlineTrack(track: OnlineTrack) {
  // provider 返回签名 URL 及其约束
  const creds = await provider.getPlaybackUrl(track)

  // ⭐ 注册到回环代理；refresh 让它能在签名过期时自愈
  const loopbackUrl = await mediaProxy.register({
    url:       creds.url,
    referer:   creds.referer,      // 部分 CDN 要求
    userAgent: creds.userAgent,
    refresh:   () => provider.renewPlaybackUrl(track),   // ★ 重签
  })

  // 交给引擎（需 CR-016 已裁定）
  await engine.send({ cmd: 'open', url: loopbackUrl })
  await engine.send({ cmd: 'play' })
}
```

### 3.2 ⚠️ 三条必须注意的

| # | 注意 | 为什么 |
|---|---|---|
| **1** | ⭐ **本地文件仍走 `trackId`** | 不要为了统一而把本地也绕代理 —— **那是无谓的一跳**（本地路径引擎直读更快、且不引入网络失败面） |
| **2** | ⚠️ **代理 URL 的生命周期** | 它与 `register()` 的 token 绑定；**引擎换曲时应用侧要保证 token 仍有效**（或让 `refresh` 覆盖足够长的窗口） |
| **3** | ⭐ **代理的 `validateUrl()` 只允许 https 或回环 http** | 这是**好设计**（防止把任意 http 喂进来）→ 上线前确认 provider 返回的确实是 https |

### 3.2b ⭐⭐ 引擎侧新增的一条要求：**代理在一次播放期间必须固定资源版本**

**来源**：引擎 `PROGRESS §0w`（2026-10-16）的明确边界陈述：

> **没有 validator 的源若在播放中被等长替换，生产端无法仅从 HTTP 长度证明它是同一版本；
> 回环代理应固定一次播放的资源版本。**

**为什么这条重要**：引擎的新 Range 实现会校验
**`206` + `Content-Range` 精确区间、总长度、编码、ETag / Last-Modified**（I/O 错误 sticky，超时 3 秒）。

⚠️ **它与 `refresh()` 重签存在真实张力**：

| | 行为 | 风险 |
|---|---|---|
| **引擎期望** | 一次播放期间资源**版本不变** | — |
| **代理的 `refresh()`** | 签名过期时**换一个新 URL** | ⚠️ 若新 URL 的内容与旧的**等长但不相同**，引擎**无法从长度判断** |

**→ 三条落实办法**（按优先级）：

| # | 办法 | 说明 |
|---|---|---|
| **1** | ⭐ **`refresh()` 返回的 URL 必须指向同一资源版本** | 签名变了、**内容不能变**。这是契约要求，不是优化。 |
| **2** | ⭐ **代理转发并向引擎暴露上游的 `ETag` / `Last-Modified`** | 有 validator 时引擎能证明版本；**没有 validator 时才是危险的那一种** |
| **3** | ⚠️ **若上游确实会换版本**（重新转码、CDN 回源不同） | **应在代理层终止本次播放并让应用侧重新取源**，而不是让引擎读到混合版本 |

⭐ **第 1 条是最关键的一句**：
**"签名会变"与"内容不变"必须同时成立** ——
签名是取用凭证，**不是资源身份**。（这与 `sourceRevision` 剥离签名的思路**同源**。）

> ✅ **落实与实测结果（2026-10-16 晚）**
>
> - **第 1 条**：由 `app/src/main/online-playback.ts` 承载 —— **一次播放一个 token**，
>   切歌/退出即 `revoke`。换一首必然换 token，所以两个版本不可能共用一句柄。
> - **第 2 条**：⚠️ **当天查出一个真实缺陷并已修复**。
>   代理**只**把上游 validator 往下暴露给引擎，却**丢弃了引擎发上来的 `If-Range`** ——
>   于是"引擎钉版本"这条保护在 CDN 那一侧从未生效（引擎发了，CDN 没收到）。
>   证据：直连代理发 `If-Range` 时上游看到 `if-range=null`；修复后上游收到 `"stable-v1"`。
>   现在 §5.2 第 8 条是**自动断言**（`pnpm test:l2`）。
> - 同一轮把 resume 的接受条件从"2xx"收紧为**必须 206**：上游因版本不匹配回过 `200` 时，
>   把整段 body 接到半截流中间会**静默损坏音频**，必须拒绝而不是拼接。
> - **第 3 条**：仍未实现（需要 provider 才知道"上游会不会换版本"），
>   属于 L3/L4 范围。当前代理对 200-on-resume 的拒绝是它的最后一道防线。

### 3.2c ⭐ 引擎路线图要求的第二条：**请求取消必须绑定到源拆除**

**来源**：`engine/AUDIO-QUALITY-ROADMAP.md`（2026-10-16）P1「Transport identity and cancellation」：

> **Add explicit request cancellation tied to source teardown
> so skip/stop does not wait for the receive timeout.**

**为什么这条是体验问题而不是内部优化**：
引擎的 HTTP 超时是 **3 秒**（`media_reader`，I/O 错误 sticky）。
**若切歌 / 停止时不主动取消在途请求**，用户会看到**最长 3 秒的卡顿**。

**→ 应用侧的对应动作**：

| # | 动作 |
|---|---|
| **1** | ⭐ **切歌 / 停止 / 关闭时，代理侧要 `abort` 在途的上游请求**（`mediaProxy` 已有 `AbortController` 基础设施） |
| **2** | **代理的 token 与该次播放绑定** —— 播放结束时让 token 失效 |
| **3** | ⚠️ **不要靠"等超时"来清理** —— 那是 3 秒的死等 |

**⭐ 一个可测的判据**：
**在慢速上游（或人为延迟的本地源）上按"下一首"，断言切换在 200ms 内完成** ——
而不是等满 3 秒。**这一条可以做成自动断言**（见 §5.2 第 7 条）。

### 3.2d ✅ 引擎侧"已完成基础"的准确表述（供对接时对照）

`AUDIO-QUALITY-ROADMAP.md` 开头的「Completed foundation」，**比 `PROGRESS §0v` 更新、更准确**：

| 项 | 原文要点 |
|---|---|
| **读取器已隔离** | *"The byte reader is isolated from codec and resampler code. Local files and HTTP streams **share one small seek/read/size/error interface**."* |
| ⭐ **HTTP 严格要求** | *"require `206 Content-Range`, a **bounded body**, **identity encoding**, and a **stable length**"* |
| ⭐ **版本钉住** | *"**Strong ETag or Last-Modified is pinned with `If-Range`** when supplied."* |
| **故障隔离** | *"Timeouts and **sticky failures keep transport faults separate from decoder EOF**."* |
| **feeder 加固** | *"reads only what fits in the planar ring. Its **cross-thread drained count is atomic**, and **source failures are handled before device recovery**."* |

⭐ **最后一条（`source failures before device recovery`）是一条重要的顺序判断**：
**"输入坏了"要先于"设备恢复"处理** —— 否则会把一个输入故障当成设备问题去重开设备。

**→ 对接时如果看到"设备重开"而根因其实是输入故障，就是这条顺序被破坏了。**

### 3.3 顺带把 `close()` 语义补全

现在 `index.ts:266` 只在退出时 `void mediaProxy.close()`。
**建议**：切换 provider / 登出时**也清一次** —— 让 token 失效是安全特性，不是资源回收。

---

## 4. ⚠️ 引擎侧必须守住的一条（**已有实测依据**）

**`read_proc` 契约**（`dr_flac.h` L428 / `dr_mp3.h` L357 / `dr_wav.h` L393，**三处一字不差**）：

> A return value of **less than `bytesToRead` indicates the end of the stream**.
> Do _not_ return from this callback until either the entire bytesToRead is filled or you have reached the end.

**→ 所以 HTTP 后端的正确行为是**：

| 情况 | 行为 |
|---|---|
| 数据可用但尚未下载到该位置 | ⭐ **阻塞等待**（绝不返回短读） |
| **确实到达文件末尾** | 返回短读（合法的 EOS） |
| ⚠️ **请求失败** | **不能返回 0** —— 那会被解码器当成"正常播完"，**静默截断歌曲** |

**✅ 这条已实现并验证**（PROGRESS §0v）：
*"网络断开探针返回非零并保留 WinHTTP 错误；**feeder 不把失败当作 EOF**，也不把部分块写入环形缓冲。"*

### 4.1 预读窗口的实测依据（**不是猜的**）

`--probe-io` 记录了**生产 `dr_flac`** 的真实调用：

| 项 | 实测值 |
|---|---|
| 最大请求 | **4096 字节** |
| 主要请求 | **4096** |
| 尾部 | 3 次合法短读 |
| **→ 预读窗口** | **256 KiB**（由实测支撑） |

---

## 5. 验收（**这是"对接成功"的定义**）

### 5.1 分级验收（**不必等 provider 接好就能验**）

| 级别 | 内容 | 依赖 |
|---|---|---|
| **L1** ✅ **已完成** | 引擎：本地文件 vs 回环 HTTP **逐样本对照** | 无 |
| **L2** ✅ **已完成（21/21，2026-10-16 晚）** | ⭐ **端到端：代理 + 引擎**，用一个**本地 HTTP 源**当远端 | CR-016 ✅ |
| **L3** | **接真 provider**（网易云/QQ） | provider |
| **L4** | **弱网 / 签名过期 / 中途断网** | L3（签名过期一项已在 L2 覆盖） |

⭐ **L2 是关键的一级**：它用**本地起的 HTTP 源**当"远端"，所以**排除了所有外网变量**，
能单独证明"代理与引擎接对了"。**建议先只做 L2。**

> ✅ **L2 已跑通**：`pnpm test:l2 <真实FLAC路径>` → `L2 integration: 21/21 checks passed`。
> 脚本 `app/tools/test-l2-integration.mjs`，构造与 §5.2b 一致（本地 HTTP 源扮演 CDN，
> 签名会过期并返回 403 以验证 `refresh()` 真的被调用）。
> ⚠️ 两点实测记录：
> ① 断言**必须带 `Range` 头** —— 不带 Range 的请求本来就该回 `200`，拿 `206` 去断言是测错形状；
> ② 引擎的 `If-Range` 只在**捕获到 validator 之后**的请求上出现，所以版本钉住必须用
> "open 之后再 seek 一次"来观察，不能看首个请求。

#### ⚠️ 一个会阻塞 L2 的技术约束（已核实）

代理取上游用的是 **`fetch(target)`**，而它的 `validateUrl()` **只放行 `https:` 或回环 `http:`**：

```ts
const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)
if (url.protocol !== 'https:' && !loopbackHttp) throw ...
```

**→ 它无法代理 `file://` 本地文件。**

**这不是缺陷**（那条校验是好设计：防止把任意 http 喂进来），
**但它决定了 L2 的构造方式** —— 见下。

### 5.2 L2 的验收清单

| # | 断言 |
|---|---|
| **1** | ⭐ **代理 URL 与原始文件逐字节等价**：同一文件，`file://` 直读 vs 「本地 HTTP 源 → 代理 → 引擎」 → **字节流相同** |
| **2** | ⭐ **seek 正确**：随机 seek N 次，读出的字节与文件对应位置一致 |
| **3** | **`SEEK_END` 正确**：取最后 64 字节，与文件尾部一致 |
| **4** | ⭐ **不重复下载同一区间**：同一 Range 在预读窗口内**只发一次请求** |
| **5** | **代理真的收到 Range 请求**（断言请求头里有 `Range:`）—— 证明引擎走的是 HTTP 后端而**不是碰巧读了本地文件** |
| **6** | **`416` 行为**：请求越界 → 代理回 `416` + `Content-Range: bytes */size` |
| **7** | ⭐ **切歌不等超时**：在慢速源上按"下一首"，断言切换 **< 200ms**（**不是等满 3 秒**） |
| **8** | ⭐ **版本钉住生效**：代理转发上游 `ETag`，断言引擎的请求带 `If-Range`（或至少代理暴露了 validator） |

⭐ **第 5 条是"这一步真的生效了吗"的证明** ——
**否则测试可能因为引擎悄悄走了本地路径而全绿。**（这与项目里"诊断工具骗人"那族教训同形。）

### 5.2b ⭐ L2 的具体构造法（**可直接执行**）

**因为代理只接受 https 或回环 http，L2 的最小构造是"本地 HTTP 源"**：

```
┌─ 测试脚本（Node，约 60 行）────────────────────────────┐
│  ① 起一个本地 HTTP 服务（127.0.0.1:随机端口）           │
│       只服务一个真实 FLAC，支持 Range（206/416）        │
│  ⭐ 它故意"扮演 CDN"：签名会过期（返回 403 一次）        │
│       用来验证代理的 refresh() 真的被调用               │
│                                                        │
│  ② mediaProxy.register({                                │
│       url: 'http://127.0.0.1:<源端口>/track.flac',      │
│       refresh: () => ({ url: '...?sig=<新签名>' })      │
│     })                                                 │
│                                                        │
│  ③ 把返回的回环 URL 交给引擎：                            │
│       {"cmd":"open","url":"http://127.0.0.1:.../..."}   │
│                                                        │
│  ④ 断言（见 §5.2 六条）                                  │
└────────────────────────────────────────────────────────┘
```

⭐ **这个构造的价值**：

| 它排除的 | 它保留的 |
|---|---|
| ❌ 外网、DNS、CDN、TLS | ✅ 真实的 Range 往返 |
| ❌ provider 与账号 | ✅ 真实的签名过期与重签 |
| ❌ 风控与限流 | ✅ 引擎的 HTTP 后端与预读窗口 |
| ❌ 其他会话抢设备 | ✅ 字节级等价性 |

**→ 所以它能证明"接线对不对"，而这正是当前唯一未知的事。**

**⚠️ 而且它要用真实 FLAC**（不是合成 WAV）——
因为 §4.1 的预读窗口结论是基于 **dr_flac 的实测读取模式（4096 字节）**，
用别的解码器测不到同一条路径。

### 5.3 必须人工确认

- **暂停 / 继续 / 切歌**时代理是否泄漏 socket
- **签名过期的自愈**（`refresh` 真的被调用了吗 —— 需要日志证据）
- **弱网下的表现**：是等待还是报错（**不该是"静默播完"**）

---

## 6. 分工（硬边界）

| | AI-A（引擎） | AI-B（应用） |
|---|---|---|
| **改什么** | `cmdOpen` 加 `url` 分支（**CR-016 裁定后**）—— ✅ **已完成** | 在播放路径调用 `mediaProxy.register()` —— ✅ **已完成**（`online-playback.ts`） |
| **不改什么** | ❌ 不改解码器回调（**已零改动**，本轮同样零改动） | ❌ 不改 `LoopbackMediaProxy` 内部（**已完成**；本轮只补了它漏转的 `If-Range`） |
| **验证** | L1（已过）+ L2 的引擎侧断言 —— ✅ | L2 的代理侧断言 + L3 —— ✅ L2 已过 |
| **红线** | ⭐ **网络失败不得当作 EOF**（L2 已断言） | ⭐ **本地文件不绕代理**（协议层由 `trackId` 路径保证） |

---

## 7. ⭐ 一个建议的推进顺序

| 顺序 | 动作 | 为什么 |
|---|---|---|
| **1** | ✅ **裁定 CR-016** | **已完成**（2026-10-16，接受，五条约束无修改） |
| **2** | 引擎加 `url` 分支 | 改动小（`cmdOpen` 里一个分支） |
| **3** | ⭐ **先做 L2**（本地文件当远端） | **排除网络变量**，单独证明接线正确 |
| **4** | 应用侧接 `register()` | — |
| **5** | 接真 provider | L3/L4 |

⭐ **第 3 步的顺序很重要**：**不要先接 provider 再验通路** ——
那样一旦失败，**网络问题、provider 问题、接线问题会混在一起**。

---

## 8. 一句话

> **这不是一个"要造什么"的方案，是一个"已经造好的两件东西怎么接"的方案。**
>
> **两侧的实现都完成了**（代理 310 行含重签、引擎 Range 后端含逐样本对照），
> **缺的是一个契约字段（CR-016）和一次 `register()` 调用。**
>
> ⭐ **CR-016 已裁定，所以下一步是：把 L2 跑通**（本地 HTTP 源当远端）——
> 那一步不需要网络、不需要 provider、不需要账号，却能证明整条接线是对的。
