# 外部参考资产 · 给 AI-B（应用侧）

> **这不是契约。** 不影响 `CONTRACT.md` 与 `docs/SPEC-v2.1.md` 的权威性。两份来源，**许可不同**：
>
> | | 来源 | 许可 | 语言 | 怎么用 |
> |---|---|---|---|---|
> | **①** | **QueMusic** `BroNekoX/QueMusic`（211★） | **Apache-2.0** | Qt6/QML + C++20 | ✅ **可以直接抄代码**（保留版权声明） |
> | **②** | **ECHO** `Moekotori/ECHO`（1122★） | **AGPL-3.0-only** | **Electron + React/TS** + C++ | ⚠️ **只学模式，不要复制代码** |
>
> **别把两边的代码混着搬。** 自用不分发时两者都不产生义务；但**若将来分发，AGPL 会传染整个仓库**。
>
> **ECHO 的栈和你几乎一样**（Electron + React/TS + 类型化 IPC + 独立原生音频进程），
> 所以它的**架构决策与踩坑记录对你直接适用**——尤其 §E1、§E2 直接命中你现有的缺口。
> QueMusic 用 QML，**代码抄不过来，但那边 §1–§4 是纯逻辑，与框架无关**。
>
> **本文件 = 第一部分 QueMusic（§0–§11）+ 第二部分 ECHO（§E1–§E7）+ 合并执行建议（§11）。**

---

## 0. 按优先级别读

| 优先级 | 章节 | 为什么 |
|---|---|---|
| **P0** | §1 过期响应 / 代次 | **你的 CONTRACT §3 没有这个概念，而你一定会遇到** |
| **P0** | §2 请求计数 → loading 态 | 你目前没有 loading 态；M3 接平台后 = 假死 |
| **P1** | §3 paytype 归一 | M3 前置，不归一 = VIP 标静默失效 |
| **P1** | §4 歌词：原生逐字 vs 重建 | 决定你歌词动画的上限 |
| P2 | §5 取色 / §6 平台层路线 / §7 账号 | M3 及以后 |
| P3 | §8 错误语义 / §9 UI 性能 | 随时可读 |

---

## 1. 【P0】过期响应与代次计数器 —— **你的契约里没有**

### 1.1 问题

用户快速连点「下一首」时，**旧曲目的异步响应会晚到**。没有代次校验，旧响应会：

```
过期响应若继续处理会把音源切回上一首，并按它的 hash 改队列索引
```

——听众感觉是"点了下一首，界面又跳回去了"。**这个 bug 在慢速手动测试里几乎不出现**，只在真人快速操作时暴露。

### 1.2 QueMusic 的做法（三套独立的代次）

| 代次 | 形态 | 作用 |
|---|---|---|
| 播放 | `m_playGeneration`（每次 `getMusicInfo` 自增）+ `m_playHash`/`m_playSource` | 丢弃过期的取流响应 |
| 歌词 | `QHash<QString,int> m_playLyricGenerations`（**按 hash 分别记**） | 丢弃过期歌词；表 >32 条时清理非当前代次 |
| 本地歌词 | `m_localLyricsGeneration` | 连续切歌丢弃过期解析结果 |

关键判定（注意那条**空值豁免**）：

```
isStalePlayResponse(hash, source)：
    hash != 当前hash || source != 当前source  → 丢弃
    但 hash 或 当前hash 为空时不判过期 —— 以免吞掉真实错误
```

### 1.3 落到你的架构

你的轨道身份是 **`trackId`**（`tl_0001`），由引擎分配。所以判据比它更简单：

```
当前 trackId = X
收到 trackId != X 的事件/回复 → 丢弃（getLyrics / 取流 / 元数据 都适用）
```

### 1.4 但这里有个**契约缺口要 owner 裁定**

CONTRACT §3.3 的 `position` / `state` / `ended` 事件**都带 `trackId`** —— 够了。
但**取歌词、取封面、取播放地址这类应用侧发起的异步请求，回复里没有身份**（那些是 M3 的平台层，不是引擎协议）。

**建议（走 `docs/contract-requests.md`，不要自己加字段）**：
平台层的 `getLyrics(trackId)` / `getPlayUrl(trackId)` **必须在返回的 Promise 里带上请求时的 `trackId`**，由调用方比对。这是 `MusicProvider` 接口（CONTRACT §4.2）的内部约定，**现在补进契约几乎零成本**。

> ⚠️ **不要**用"最后一个请求胜出"的简单写法（后发先至的响应会被误丢，早发的慢响应会被误留）。**必须按 trackId 比对。**

---

## 2. 【P0】请求计数派生 loading 态

### 2.1 机制

```
beginRequest()  → 计数 +1，loading = true
endRequest()    → 计数 -1，归零才 loading = false
```

**为什么不是布尔标志**：并发请求（比如首页同时拉推荐+榜单）里，**先回来的那个会把动画提前关掉**，剩下那个还在转——用户看到的是"动画停了但内容还没出来"。

### 2.2 三条配套硬规则（都是花过 bug 的钱）

1. **每个请求路径必须保证"无论如何都回调一次"** —— 包括失败、无权限、被风控。它的酷狗注释专门强调：*无权限/风控时也必须回传结果*，否则 loading 永不停。
2. **有一个 action 刻意不计数** —— `getLyricInfo` 不 `endRequest()`，因为它在取流链路内触发，跟着减会让别的请求提前收尾。**你的对话是：歌词请求要不要计入全局 loading？**（建议不计——歌词加载不该阻塞整个界面）
3. **看门狗兜底** —— 20 秒超时强制归零并关 loading。他们的注释承认有一条不计数路径**没有看门狗保护**，是已知窄点。

### 2.3 落到你的应用

你现在只有曲库/播放栏/信息栏/歌词，**还没有 loading 态**。M3 接平台后，一次搜索要 1–3 秒。建议放在 `src/renderer/src/store.ts` 或 `ipc.ts` 的请求层，**一个计数器**，多个组件订阅。

---

## 3. 【P1】`paytype` 必须归一到 `0/3` —— 否则静默失效

他们的 `ApiCommon.h` 顶部有一条长注释，记录了这个 bug 的完整因果：

```cpp
// paytype 取值约定（唯一权威，各平台必须把自家枚举归一到这两个值之一）：
//   0 = 免费可播放；3 = 需要会员/付费
// 消费端只认 3：VIP 角标、「仅免费 / 仅 VIP」筛选。
// 所以平台侧绝不能把自家枚举原样透传 ——
// 网易云 fee=1（VIP专享）被映射成 1、酷狗 pay_type=1（会员）被直传成 1，
// 两边都落进没有消费端认的槽位，会员曲目反而不显示 VIP 角标。
```

**这是"不报错、只是不工作"的典型**。各平台原始字段与归一逻辑：

| 平台 | 原始字段 | 归一 |
|---|---|---|
| 网易云 | `privilege.fee`，回退 `song.fee` | `(fee == 1 \|\| fee == 4) ? 3 : 0` |
| 酷狗 | `pay_type` | `pay_type == 0 ? 0 : 3`（实测只出现 0/1/3） |
| B 站 | 无 | 恒为 `0` |

**落到你的 M3**：`MusicProvider` 的 `Track` 类型（CONTRACT §4.3 附近）需要一个付费标记，**现在就把取值定死为两个值**，别叫 `fee` 也别叫 `payType` 然后各处自己解释。

### 3.1 顺带：统一字段表（他们有 11 个常量）

`title` `artist` `cover` `hash`（通用 ID）`hashhq` `hashsq` `paytype` `duration`（**秒**）`album` `playcount`

注意两条：
- **`hash` 是"通用 ID"槽位**：酷狗是文件 hash、网易云是数字 id 字符串、B站是 bvid / `season:<sid>:<mid>`。**多个平台共用一个槽位**——你的 `Track.platformId` 应该照这个思路。
- **`playcount` 缺失时归一为 `0`**（有的平台用 `4294967295` 表示缺失）。

**⚠️ 单位陷阱**：他们的 `duration` 是**秒**，而你的引擎协议是**毫秒整数**（CONTRACT §3.1 铁律）。
M3 从平台层拿到的时长**必须显式 ×1000**，并在类型里区分（比如 `durationSec` vs `durationMs`）。他们的代码里就有这一层转换，`timeLength < 1000 ? *1000 : 1` 这种兼容写法是坑的来源。

---

## 4. 【P1】歌词：原生逐字 vs 重建逐字 —— 决定你动画的上限

### 4.1 他们的 `LocalLyricsReader`（493 行）支持什么

```
parseLrc(contents)                    → 标准 LRC + 增强的逐字时间戳
parseLrcWithTranslation(contents)     → 额外识别"与上一行共用时间轴的翻译行"
read(filePath)                        → 先读 sidecar LRC，再读内嵌元数据歌词
```

**读取顺序**（确认过）：sidecar `.lrc` / `.txt` → 内嵌 **USLT** / TagLib `LYRICS` PropertyMap → **SYLT**。

**内嵌歌词**：ID3v2 的 **SYLT**（同步歌词）与 **USLT**（非同步），以及 TagLib 能识别的 `LYRICS` 文本元数据（**常见于 FLAC / Ogg-Opus / MP4-M4A**）。
**明确不支持**：TTML、KRC 原生、QRC（KRC 仅作为 `<...>` 标注格式被识别，不是容器）。

**一条关键的来源标注**：

```cpp
QString source;   // SYLT 逐音节重建时为 "embedded-sylt"（无翻译，需在线补）
```

**`"embedded-sylt"` 这个标记的意义**：SYLT 是**按音节同步**的，但重建成一行的"逐字"时，字与字的边界是**推算**出来的，不是原生提供。他们如实标了来源，没有假装是原生逐字。

> **这与你的 CONTRACT §4.3 的 `wordByWord` 是同一个思路**（`true`=数据源原生字级，`false`=本方插值合成）。
> **你们独立得出了一致的语义——这说明这个标注是必要的。** 保持它，并且**把 SYLT 重建归入 `wordByWord: false`**（这一点他们的命名比你的更细，你可以借鉴：在 `source` 里区分 `'embedded-sylt'`）。

### 4.1.1 ⭐ 最值得抄的一段：`extractWordLabels()`（`:71-98`，约 28 行）

**这是全仓库对 B 侧最划算的一段代码**——它是**一条正则**，同时吃两种逐字标注格式：

| 格式 | 形态 | 含义 |
|---|---|---|
| 增强 LRC | `<mm:ss.fff>` | **绝对时间** |
| KRC 风格 | `<offset,duration,flag>` | **相对行**的偏移与时长 |

统一产出 `info: [{offset, duration, text}]`，**与在线歌词同契约**（也就是说：本地逐字与在线逐字对你上层的形状完全一样）。

**两个额外细节值得一起抄**：
1. **SYLT 无行级歌词时按停顿切行**（`groupSyllables()`）——不是所有 SYLT 都带行边界
2. **双语翻译靠"同时间戳相邻行"配对**（`isTranslationOf`）——**按时间戳，不按行号**

**落到你的 `src/shared/lrc.ts`**：你要做的正是这个。它给了你两件现成的：**正则的形状**、以及「本地逐字与在线逐字走同一契约」这个决定（你的 CONTRACT §4.3 已经这么做了，很好）。

### 4.2 增强 LRC（逐字）是**现在就能拿到的**

你 M1 的歌词是行级（`wordByWord=false`，`demo.lrc`）。增强 LRC 用 `<mm:ss.xx>` 标记字级时间轴：

```
[00:12.00]<00:12.00>这<00:12.30>是<00:12.60>一<00:12.90>行
```

**你的 `src/shared/lrc.ts` 现在只解析行级。** 加上 `<...>` 解析就是原生逐字（`wordByWord: true`），**不需要平台、不需要联网**。这是 M1→歌词动画升级之间成本最低的一步。

### 4.3 ⚠️ 一处方向性修正：**逐字歌词不在网易云侧，在酷狗侧**

我原本以为它的网易云实现能拿到逐字。**读源码后确认：不能。**

- `NeteaseCloudApi::getLyricInfo` 走 `member="lyric"`，**只拿 LRC**（`parseLyrics()` 把 `info` 恒置为 `QVariant()`，`:101`）
- 它投递的那个库（`module.h:499`）**声明了** `lyric_new`（注释："新版歌词 - 包含逐字歌词"），但**全仓未调用**；`module.cpp`（5157 行）里 **grep `yrc` 零命中**
- **真正已实现的逐字在酷狗侧**：`KugouApi.cpp:146-185` 用裸 zlib（含手动补 zlib 头 + 算 adler32）解 KRC，`krcToLyrics()` 出字级 `info`

**对你的三个结论**：

1. **网易云 `yrc` 仍然是你最省事的逐字路径**（CONTRACT §4.4：加 `yv=-1` 参数）——但这个格式**没有任何现成实现可以抄**，你得自己按格式解析（`[行起点,行时长](字起点,字时长,0)字`）。**格式已在契约里，解析器要自己写。**
2. **`lyric_new` 这个方法名的存在，本身是一条情报**——说明网易云服务端确有逐字接口。如果 `yrc` 那条路不顺，`lyric_new` 是备选侦查方向。
3. **别去抄它的酷狗 KRC 解密**——你只做网易云（CONTRACT §6.1 的优先级表）。列在这里只为说明：**逐字歌词在各平台都是"要做一层解码"，网易云是其中最省事的。**

### 4.4 翻译与音译

他们用 **时间戳对齐**把翻译行配到歌词行（不是按索引）。你的 CONTRACT §4.3 的 `translation` / `romanization` 字段是同样思路。
**对齐要按时间戳，不要按行号** —— 中译英行数不总是相等。

---

## 5. 【P2】封面取色 `ColorExtractor` —— **~80 行可 1:1 移植**

### 5.1 架构（三个值得抄的设计）

```cpp
Q_INVOKABLE void extractColorsFromUrl(const QUrl &url);   // 立即返回，结果经信号回传
```

1. **全部在工作线程完成**，切歌不阻塞 UI
2. **`int m_generation`** —— 丢弃切歌后的过期结果（和 §1 同一个模式）
3. **`QCache<QString, ExtractionResult>`（128 项）** —— 按 cacheKey 复用，命中不重算

### 5.2 ⭐ 算法：**不是 k-means**，是 15-bit 量化哈希桶

深度审计读源码确认（`ColorExtractor.cpp`，7.4KB），步骤精确如下：

```
1. 降采样到 48×48
2. 过滤像素：跳过近白（r+g+b > 690）与近灰（max-min < 5）
3. 量化：15-bit 桶键 = (r>>3)<<10 | (g>>3)<<5 | (b>>3)
4. 每桶取均值色
5. 按桶内像素数降序排列
6. 去重：平方距离 < 120² 的丢弃
7. 取前 3 色 → 转 HSV → 提饱和 +42、压明度 −32
8. 兜底：不足 3 色时补齐
```

**为什么这比 k-means 好**（对你的场景）：确定性、无迭代、零参数调优、CPU 开销可预测。取色只需要"几个有代表性的颜色"，**不需要聚类精度**。

**Qt 耦合仅 `QImage` / `QColor`** —— 你在 TS 侧用 `OffscreenCanvas` + `getImageData` 重写这个算法，**逻辑一行不用改**。

### 5.3 ⚠️ 它与你的 SPEC §5.1 **不是同一件事**，别直接替换

| | QueMusic | 你的 SPEC §5.1 |
|---|---|---|
| 输出 | 3 色，转 HSV 后**提饱和 +42 / 压明度 −32** | 封面取色后**饱和 −15%、明度 60–70%、色相 +5% 蓝偏** |
| 意图 | 让颜色**更鲜艳**、当主题色用 | 让颜色**像透过水面**、当强调色用 |

**结论**：**抄它的"取色"（前 6 步），用你自己的"光学处理"（第 7 步）**——它把 HSV 那一步调成"更艳"，而你 SPEC 要的是"更淡更蓝"。**这两步是分开的**，替换第 7 步即可。

### 5.4 调用形状

它的结果是**异步信号**，不是返回 Promise。你用 TS 重写时**保留这个异步形状**，别写成同步——取色是 CPU 活（48×48 = 2304 像素 × 每像素若干运算），同步会卡帧。

---

## 6. 【P2】M3 平台层路线：不引入 Qt，但偷协议知识

### 6.1 发现

QueMusic 内嵌 **`api/QCloudMusicApi/`** —— 深度审计确认它是第三方 **`s12mmm3/QCloudMusicApi`（MIT, ©2023）**，即 `Binaryify/NeteaseCloudMusicApi` 的 **Qt C++ 移植**：

- `module.cpp` **5157 行 / 143KB**，`module.h` 32KB，**≈800 个 `Q_INVOKABLE` 接口**
- `api_c.h` 暴露**纯 C ABI**：`invoke(member, json)` / `invokeUrl` / `set_cookie` / `freeApi`
- 加密只做**网易云请求体加密**（weapi / linuxapi / eapi + AES + RSA）——**没有 QQ 音乐、没有 QRC**
- 依赖**仅 QtCore + QtNetwork**（CMake 原文：Qt 5.12+）

| | 你的 CONTRACT §4 | QueMusic 路线 |
|---|---|---|
| 形态 | Node API 服务端（Electron 主进程拉起） | C++ 进程内直调 |
| 依赖 | `api-enhanced`（npm，社区逆向） | QCloudMusicApi（C++，MIT，活跃） |
| 额外进程 | 需要 | 不需要 |

### 6.2 建议：**别把 Qt 拖进来，但把协议知识抄走**

**⚠️ 这是本次审计最重要的一条修正**：我原本以为它内嵌的是「QQ 音乐协议的 C++ 实现」——**错**。全仓 grep `QQMusic|QRC|qrc_decrypt` **零命中**，它纯粹是网易云的 Qt 移植。

**为什么不应该取代 Node 服务端**（三条，按权重）：

1. **架构冲突**：接进引擎 = 把 QtCore + QtNetwork + cryptopp 拖进一个刻意保持薄的 JSON-Lines 独立进程，**与 CONTRACT §1 的原始决策正相反**，还要多养一套 MinGW/MSVC 双 ABI 构建链。
2. **它不提供你最想要的逐字歌词**（见 §4.3）——`lyric_new` 未接线，逐字能力在酷狗侧。
3. **它本身就是 NeteaseCloudMusicApi 的移植**——**绕一圈回到你的 Node 原型**。你要的多样性没有增加，只是换了个语言。

**但值得拿的是「协议知识」**：weapi/eapi 的字段结构、`lyric_new` 这个方法名的存在（等价于「服务端确有逐字接口」的情报）、酷狗三 hash 对应三档音质、B 站 WBI 签名、`md5(salt + sorted + salt)` 签名形状。**这些直接提升你 Node 侧的 `api-enhanced` 使用质量。**

**唯一值得重新考虑的场景**：如果将来想要**零 Node 运行时的单 exe 交付**，那么 `QCloudMusicApi`（MIT、仅 QtCore/Network、有 C ABI）是成熟选项。**但那是产品形态决策，不是当前缺口的解法。**

### 6.3 他们的请求封装（57 行，值得整块借鉴逻辑）

`api/ApiHttp.h` 里三条规则：
1. **只在 `https` 时携带 Cookie** —— 明文端点不传凭证（酷狗还有 `http://` 域名）
2. **失败也回调** —— 传输失败时在 JSON 对象里塞一个 `"error"` 键，让上层能区分"失败"与"业务成功但空数据"（见 §8）
3. **失败日志只打 `scheme://host/path`**，**丢掉 query** —— 因为查询串里可能带 token

**第 3 条对你有直接价值**：你的 SPEC §9.4 要求"网络活动"页可查请求。**日志里绝不能带 query 全串**，否则 token 会进日志文件。

### 6.4 音质档位与降级（它的做法）

| 值 | 语义 |
|---|---|
| 0 | 标准 128k |
| 1 | 高清 320k（**默认**） |
| 2+ | 无损 flac |

**酷狗的特例**：同一首歌的不同音质是**三个不同 hash**（`hash` / `hashhq` / `hashsq`）——这是它的字段表里为什么有三个 ID 槽位。
**网易云**：hash 就是 id，音质由请求参数决定。
**队列/收藏统一用普通 hash 当身份**，否则同一首歌会因音质不同在队列里出现多条。

---

## 7. 【P2】账号与会话（`AccountManager`，924 行）

### 7.1 凭据流向是**拉模式**

```
每次请求分发前调一次 syncSource(source)：
  把当时的 cookie / 设备信息推给平台类
没有 connect 登录变更信号 —— 登录/登出不影响已发出的请求，下一次请求才生效
```

### 7.2 两条对你有用的细节

1. **网易云未登录也带稳定身份**：它用 `mergeNeteaseIdentity(cookie)`，**未登录也会带 deviceId + `os=pc`** —— 注释说是"避免被判异常环境"。**这对你的风控约束（CONTRACT §5）是互补的**：光有"低频访问"不够，稳定的设备身份同样重要。
2. **扫码登录的二维码是用纯 JS 生成的**（`api/qrcode.js`，514 行，零依赖，byte mode，纠错 L/M，版本 1-10，注释："登录二维码足够"）。你的 Electron 侧有 `qrcode` 这类 npm 包，不必自己写，但**知道"版本上限 10 足够"**可以省掉一个纠结。

### 7.3 ⚠️ 两处必须知道的负面事实（读源码确认）

**① 它的 Cookie 是明文落盘的 —— 你不许照抄这一点。**

```
AccountManager.cpp:46    m_configPath = applicationDirPath() + "/Account.ini"
AccountManager.cpp:800-815   QSettings::IniFormat 直接 setValue("cookie", m_neteaseCookie)
```

**明文，无 DPAPI、无系统凭据库**（DPAPI 它只用在 WebDAV 密码上）。自用尚可接受，但**你的 SPEC §9.5 与 CONTRACT §5 明确要求 `safeStorage`** —— 这条**不要学它**。

> 顺带一个发现：它把账号文件放在 **`applicationDirPath()`**（程序目录），而不是用户数据目录。**如果程序装在 `Program Files`，这会导致写不进去。** 别沿用这个选择——用 `app.getPath('userData')`。

**② 扫码登录的实现是分平台的，不是一套通吃。**

- 网易云：走 `QCloudMusicApi` 的 `login_qr_*` 系列（**这是库提供的**，不是你写）
- 酷狗：自建 `/v2/qrcode`
- 另有**三条备选登录**：粘贴 Cookie / 短信验证码 / 内嵌 WebView

**对你的意义**：M3 只做网易云的话，扫码这条路**依赖 `api-enhanced` 是否提供 `login_qr_*`**（它移植自 NeteaseCloudMusicApi，应该有）。**M3 开工前先确认这一个接口存在**——它是整条登录链的前提。

### 7.4 一个易踩的坑（他们踩过）

```
网易云 worker 的 ApiHelper debug 日志被关闭
（setFilterRules("QCloudMusicApi.debug=false")），别打开：
每个请求三行会刷满控制台。
```

**你的对应物**：M3 接平台后，HTTP 日志级别要能单独关，别让它淹掉引擎的协议日志。

---

## 8. 【P3】错误语义：**"失败"≠"空结果"**

他们踩过的一个具体 bug：

```
带 error 的失败响应不能当成「没有数据/歌词」，
否则网络故障会显示成「纯音乐，请欣赏」
```

**三个必须区分的地方**：
1. 私人漫游/私人雷达 —— **空表且非失败**才提示"未登录"
2. 歌词 —— 失败要提示重试并**保留当前歌词**，不能显示成"纯音乐"
3. 本地搜词 —— 只在**非失败**时才报"没找到"

**落到你的 TS**：`MusicProvider` 的方法要么返回 `T | null`（区分"没有"与"有但为空"），要么抛错 —— **不要用空数组同时表示"没有结果"和"请求失败"**。

---

## 9. 【P3】UI 性能经验（README 里那段，与框架无关）

他们用 QML，但四条原则对 React 一样成立：

```
1. 少嵌套：能用一个 Item 解决的不套两层（减少重复绘制与无效变换）
2. 定位越简单越贵不了：x/y/width/height → anchors → Row/Column → Layouts
3. 绑定要精：只让真正变化的属性参与绑定，避免一条数据改动引发整棵子树重算
4. 页面按需加载：切换页面走异步 Loader，重对象在后台线程构建
```

**第 3 条对 React 的直接对应**：避免把整个 store 对象塞进依赖数组；**选择器要窄**。你的 `store.ts` 值得按这条审一遍。

**他们的实测基线**（i5-12400 + UHD 730 核显，1080P/60FPS 歌词页）：CPU ≈4%、GPU ≈15%。
**这是 QML + GPU 场景图的数字**。你是 Electron，**别拿这个当目标**——你的 SPEC §8.1 已实测 ≈279MB 常驻，那个才是你的现实。

---

## 10. 不要抄的

| 部件 | 原因 |
|---|---|
| QML 组件 / 着色器 / 插件系统 | 框架不同——但**着色器思路**可移植：README 记录了从 `ShaderEffectSource + MultiEffect` 到**单个着色器合并（取样→模糊→提饱和→圆角裁剪）**的性能演进，和你的湿玻璃 `/ backdrop-filter` 性能取舍是同类问题 |
| `OnlineListModel`（121 行） | 它是为了"用 C++ 复刻 QML ListModel"，你的数据层是 TS，没有这个问题 |
| 它的整套 QML 单例装配（`main.qml` 1068 行） | 与你的 React store 模型不同 |
| 它的 SMTC 实现 | **归 AI-A**（做进引擎进程或独立原生进程）——见 `REFS-A-engine.md` §4 与 §E6 |

---

## 11. 【第一部分小结】QueMusic 的执行建议

**现在做（不依赖 M3，按性价比排序）**：

| # | 动作 | 成本 | 收益 |
|---|---|---|---|
| **1** | 应用层加**请求计数 → loading 态**（§2） | 小 | M3 不做就是假死 |
| **2** | `src/shared/lrc.ts` 加**增强 LRC（`<mm:ss.xx>`）解析** → 原生逐字，`wordByWord: true`（§4.1.1 有正则形状） | 小 | **立刻**解锁逐字歌词动画，最强性价比 |
| **3** | 给平台层预留 **trackId 比对**（§1.4），并**走 CR 流程**写进 CONTRACT | 半小时 | 防一个必然会出的 bug |
| **4** | `store.ts` 按「选择器要窄」审一遍（§9） | 小 | 防整棵子树重算 |

**M3 前做**：`paytype` 归一到 `0/3`（§3）、字段表与**秒↔毫秒单位转换**（§3.1）、HTTP 日志丢 query（§6.3）、确认 `api-enhanced` 有 `login_qr_*`（§7.3）。

> ⚠️ 第 3 条在**第二部分 §E1.2** 被升级：ECHO 的做法是用 **`operationId`** 而不是 trackId（同曲循环时 trackId 会重复）。
> 见第二部分的合并建议表——**先做临时 B 方案止血，再走 CR 换 A 方案**。

---

## 11.1 关于第 2 条：为什么它值得排在很前面

你的 SPEC §6.5 把「动画手感」定为两个差异点之一。而**逐字歌词是"歌词动画"与"歌词动画得像样"之间的门槛**——

- 只有行级（`wordByWord: false`）时，你只能做「整行淡入淡出 + 行间位移」
- 一旦有字级时间轴，**卡拉OK 式逐字高亮**才成立

**而且增强 LRC 这条路完全不依赖平台、不依赖联网、不依赖 M3**——你手上任何带 `<mm:ss.xx>` 标注的 `.lrc` 都能立刻跑起来。这是全项目**投入产出比最高的一步**。

---

## 第二部分 · ECHO（`Moekotori/ECHO`）—— **它的栈和你几乎一样**

> ⚠️ **许可警告**：ECHO 是 **AGPL-3.0-only**，且是 Steam 商业产品的社区版。
> 自用不分发时你无义务；**但若将来分发，抄它的代码会传染整个仓库**。所以第二部分**只给模式与依据，不给可复制的代码**。
> （对比：第一部分 QueMusic 是 Apache-2.0，可以直接抄。）

**为什么这一部分对你比 QueMusic 更重要**：它的技术栈是
**Electron + React + TypeScript + 类型化 IPC + SQLite + 独立原生音频进程** ——
**和你的 `app/` 逐项对应**。QueMusic 用 QML，你只能抄逻辑；**ECHO 的架构决策与踩坑记录你可以直接对照。**

---

## E1. ⭐ 它踩过你现有缺口的每一个（且有文档佐证）

它的架构文档（`docs/ECHO_NEXT_ARCHITECTURE.md`、`ECHO_NEXT_AUDIO_CORE.md`）里有几条**直接命中你还空着的地方**。

### E1.1 ⭐⭐ Session 状态机有 **9 个状态**，你只有 3 个

它的 `AudioSession` 状态：**`idle` / `loading` / `playing` / `paused` / `seeking` / `buffering` / `ended` / `stopped` / `error`**

**你现在有什么**：CONTRACT §3.3 的 `state` 事件是 `playing / paused / stopped` 三态 + `ended` 事件。

**为什么它需要 9 个**（它的文档原文要求）：

> - `playing` 必须来自真实播放链路，不是 UI 猜测。
> - `paused` 时进度不能继续假动。
> - `loading` 失败要保留清楚错误。
> - **切歌时旧状态不能覆盖新 intent。**
> - seek 后进度要和输出侧确认对齐。

**其中第 4 条正是你的 P0 缺口**（§1 过期响应）——**它不是"响应过期"问题，是"状态机缺少 intent 概念"**：

- 你快速连点下一首 → 引擎的 `state` 事件按到达顺序覆盖
- 正确做法：**应用侧记"当前 intent"，只有匹配 intent 的状态才生效**（§E1.2 给了它的判据）

**落到你的 `store.ts`**：把播放状态从"最后一个收到的 state"改成 **"当前 intent + 与之匹配的权威状态"**。这比在事件里加 trackId 更根本。

> ⚠️ **不要照搬 9 个状态**——它的 `buffering` 是为网络流准备的，你的本地 91 首不需要。
> **建议你加的是**：`loading`（打开文件到出声之间）与 `seeking`（你有 `seek 32ms`，期间 UI 不该假装已完成）。

### E1.2 ⭐⭐ "过期响应"的**协议级**解法：`operationId`

上次我建议你用 `trackId` 比对。**ECHO 的协议里用的是 `operationId`，比 trackId 干净**：

```
audio.openFile  →  {status:"probed", operationId:1, filePath, sampleRate, channels, durationSeconds, codec, ...}
audio.position  →  {framesPlayed, bufferedFrames, inputEnded, operationId}
audio.ended     →  {operationId} 或 {operationId, queueAdvance, gaplessAdvance, nextTrackId, ...}
```

**为什么比 trackId 好**：同一首歌连续播放（单曲循环）时 trackId 会重复，operationId 不会。

**落到你这里两条路**：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | CONTRACT §3 加 `operationId`：每个 `open` 分配一个自增号，`state`/`position`/`ended` 都带回 | **要改契约，走 CR 流程** |
| B | 应用侧自增"playSession"计数，发 `open` 时记下，收到事件时比对 | 不改契约，但**引擎不知道这个号**，只能靠时序猜 |

**A 更彻底**；B 是当下可做的临时措施。**建议先做 B 止血，再走 CR 换 A。**

### E1.3 进度不能来自 UI timer —— 你已经是这么做的，但它给了判据

> 不要：用 Renderer `setInterval` 当权威进度、用解码速度推断实际播放位置、用 UI 乐观状态覆盖输出侧错误。
> 可以：UI 做轻量补间显示，但**必须能被真实状态纠正**；高频 position 事件节流；**只让播放栏局部订阅，避免全局重渲染**。

**你的 `app/README.md` 写着"position 只由 `position` 事件推进"** —— 方向对。但现在**没有节流**，而且如果 `store.ts` 把 position 放进全局 state，**每 100ms 会推动整棵树重渲染**（你说的 SPEC §8.2 "动效 p95 <16.7ms" 会在这里失守）。

**建议**：position **不进全局 store**，用独立的轻量订阅（一个 `useSyncExternalStore` 或直接 ref + `requestAnimationFrame`）。

---

## E2. ⭐⭐ 它的"请求计数 → loading"和你需要的**不是同一个东西**

上次我给你的 §2（QueMusic 的请求计数）是**平台 API 层**的 loading。**ECHO 这份是播放链路的 loading，两者互补**：

| | QueMusic（第一部分 §2） | ECHO（本节） |
|---|---|---|
| 场景 | 搜索/取歌单要 1–3 秒 | 打开文件→出声之间 |
| 机制 | 请求计数，归零才关 | **状态机里的 `loading` 态** |
| 你的现状 | 没有 | 没有（`state` 只有三态） |

**两处都要做，但归口不同**：平台层用计数（并发多），播放层用状态（单一路径）。

---

## E3. ⭐ IPC 分层的六条判据（你的 preload 现在还很薄）

它的架构文档给"新增 IPC 前先问"的六条，**这是你 M3 之前最该读的一段**：

```
1. 这个能力属于哪个域。            （library / audio / renderer / plugin / network / settings）
2. 输入能否被严格校验。
3. 返回值是否会变得过大。          ← 你的曲库 91 首，将来会爆
4. 是否会暴露路径、token、内部错误等敏感信息。
5. 是否会让 Renderer 绕过服务边界。
6. 是否需要事件订阅而不是轮询。
7. 是否会在播放期间触发重任务。
```

**配套的规则**（同样直接适用）：

- channel 名按域分组
- **handler 不做大段业务，转给 service**
- 错误返回要稳定，**不泄漏不必要内部细节**
- **高频状态需要节流或局部订阅**
- **事件要能取消订阅**

**还有一条针对你 `engine-host.ts` 的**：

> `src/main/index.ts` 应保持薄：初始化 app、注册 IPC、启动服务、处理退出。
> **只要这个文件开始出现大量业务 if/else，就是架构走偏的信号。**

**去检查你的 `src/main/index.ts`** —— 如果引擎协议处理、歌词加载、状态合并都在里面，该拆了。

### E3.1 preload 的四条禁止（比你现在更严）

> 禁止：暴露 raw `ipcRenderer`；暴露 Node.js `fs/path/process`；**在 preload 做业务逻辑**；在 preload 解析音频、扫描文件、处理封面；把任意 IPC channel 透传给 Renderer。

**你的 preload 现在暴露了 `loadLyrics` 与 `pickFolder`** —— 按它的标准这两个都"在 preload 做了业务"。
**但你的 `loadLyrics` 是走主进程的**（`src/main/lyrics.ts`），**这是对的**。值得对照确认的是：**preload 里有没有 `fs` 或路径拼接**。

---

## E4. ⭐ 大曲库的四条性能红线（你现在 91 首，将来会撞）

```
- 大曲库必须分页或虚拟化。          ← 你的列表是直接渲染 91 条
- 播放进度不能推动全 App 重渲染。    ← 见 §E1.3
- 列表只拿缩略图 URL，不拿大封面或 base64。   ← 你的封面还没做
- 搜索输入要 debounce。
```

**它自己的数字**：**16,813 首 / 1,856 专辑，589.2 MB 内存、1.1% CPU**（播放中）。

**对你的意义**：你的 SPEC §8.1 引用的是 Electron **空窗口**基准（≈279MB）。**真实曲库 + 原生宿主后的量级应该按 589MB 预期**——引用预算时用这个数。

**另一条它明说的红线**：*"启动不扫描全库"* —— 你的 `scan` 是应用侧触发的（`pick_folder` → `scan`），**已经是这个行为**，很好。

---

## E5. 事件流要能取消订阅（你的 mock 与真引擎都要检查）

> 事件要能取消订阅。

**去检查 `engine-host.ts`**：`onEvent` 有没有返回 unsubscribe？如果 React 组件在 `useEffect` 里订阅而无 cleanup，**快速切页会累积监听器**——这是典型的"越用越卡"。

---

## E6. 它的层级划分，可以直接当你的模块地图

```
Renderer UI          pages, components, routes, stores, visual state
Typed Preload Bridge window.echo.* typed APIs
Electron Main         IPC, app lifecycle, windows, service composition
  +-- Library Core    SQLite, scans, metadata, covers, search, playlists
  +-- Audio Core      playback session, decoder, output bridge, devices, clock
  +-- Native Hosts    WASAPI, ASIO, EQ, SMTC, native DSP / output helpers
  +-- Experience      lyrics, MV, streaming, downloads, plugins, remote sources
```

**对照你的现状**：

| 它的层 | 你的 | 差距 |
|---|---|---|
| Renderer UI | `src/renderer/` | 有 |
| Typed Bridge | `src/preload/` + `src/shared/protocol.ts` | 有，**形状一致** ✅ |
| Electron Main | `src/main/index.ts` | 有，但**可能过厚**（见 §E3） |
| **Library Core** | ❌ **空** | 曲库在引擎里，应用侧只显示 |
| Audio Core | `src/main/engine-host.ts` | 有，**但没有 session 状态机** |
| **Experience Services** | ❌ **空** | M3 的平台层要落在这里 |

**最值得注意的**：它把 **Library Core 和应用主进程分开**，而**你的曲库在 `twilight-engine.exe` 里**。
这不是错（你的引擎就是唯一权威），但意味着 **M3 之后会出现两处曲库来源**：本地（引擎 `scan`）+ 在线（平台层）。
**建议现在就在 `src/main/` 下留一个 `library/` 目录**，让两者最终在同一层归一。

### E6.1 一条给 Owner 的备忘（它替你作证了架构选择）

它的迁移文档（`docs/ECHO_NEXT_NATIVE_AUDIO_PIPELINE.md` §1）解释为什么要把 PCM 数据面迁出主进程：

> 旧链路让 Electron 主进程参与本地文件读取、解码后的 PCM 搬运和格式 DSP。主线程出现 GC、IPC 高峰、封面处理或其他短暂时，PCM 生产也可能跟着停顿……表现为**"卡一下、播放也卡、然后跳一大段"**。
> 目标不是继续调大 JavaScript 缓冲，而是**切断主进程调度抖动与实时音频数据面的耦合**。

**你的 `EngineHost` 从第一天就是独立进程 + 纯控制协议**（CONTRACT §3 铁律 2）。**这条不需要你做什么，但值得知道：一个 1122★ 的商业产品交了学费才走到你的起点。**

---

## E7. 它的 UI 侧数字（别拿它当目标）

它有完整 UI：封面墙、深浅主题、桌面歌词窗、迷你播放器、壁纸引擎桥接、创意工坊。

**但它是团队 + Steam 商业产品**（1122★、有 Android 独立仓库、有 `private/echo-pro-cloud` 云同步后端）。
**你是一人 10–20h/周。**

**它的存在证明你的架构对，但不说明你能追上它的功能量。** 你的 SPEC §6.3 砍掉的那些（场景模式、智能播放列表、音乐地图、主题编辑器）**它的功能表里全有**——那些是团队产能的结果，不是单人该追的目标。

**你要守住的还是 SPEC §1.1 那两条**：音频质量（引擎已达标）+ 动画手感（歌词逐字是最省事的一步，见第一部分 §11.1）。

---

## 12. 合并执行建议（两部分放在一起，按性价比排序）

| # | 动作 | 来源 | 成本 | 为什么排这里 |
|---|---|---|---|---|
| **1** | 应用层加**请求计数 → loading 态** | QueMusic §2 | 小 | M3 不做就是假死 |
| **2** | `store.ts`：**播放状态改成"intent + 匹配的权威状态"** | ECHO §E1.1 | 中 | 比"过滤过期事件"更根本；直接解决连点下一首跳回 |
| **3** | 加**播放会话计数**（临时 B 方案，止血过期响应） | ECHO §E1.2 | 半小时 | 不改契约；A 方案走 CR |
| **4** | `src/shared/lrc.ts` 加**增强 LRC `<mm:ss.xx>` 解析** | QueMusic §4.1.1 | 小 | **立刻**解锁逐字歌词，不依赖 M3 |
| **5** | **position 移出全局 store** + 节流 | ECHO §E1.3 | 小 | 防每 100ms 全树重渲染 |
| **6** | 检查 `src/main/index.ts` **是否过厚** | ECHO §E3 | 半小时 | 拆早比拆晚便宜 |
| **7** | 检查 `onEvent` **有无 unsubscribe** | ECHO §E5 | 小 | 防监听器累积 |
| **8** | 在 `src/main/` 留 `library/` 目录 | ECHO §E6 | 零 | 为 M3 的两处曲库来源预留归一位置 |
| **9** | `store.ts` 按"选择器要窄"审一遍 | QueMusic §9 | 小 | 防整棵子树重算 |
| **M3 前** | `paytype` 归一 `0/3`、秒↔毫秒、HTTP 日志丢 query、确认 `login_qr_*` | QueMusic §3 §6.3 §7.3 | — | — |

### 12.1 关于第 2 条：为什么它比"过滤过期事件"更重要

**过滤过期事件**是"收到坏消息时扔掉"——治标。
**intent + 权威状态**是"我只认属于当前意图的消息"——治本。

而且它顺带解决了另一件事：你的 `state` 事件只有 `playing/paused/stopped`，
**加上 `loading`（打开到出声）与 `seeking`（32ms 内 UI 不该假装完成）** 之后，
UI 才有正确的中间态可表达。**这是"动效手感"的前提**——没有中间态，动画只能在两个已定状态间硬切。

---

## 附：取文件的方法

**定点取单个文件**（两边都适用）：

```
https://raw.githubusercontent.com/BroNekoX/QueMusic/main/<path>
https://raw.githubusercontent.com/Moekotori/ECHO/main/<path>
```

**ECHO 关键路径**（只学模式，不要整读）：

```
docs/ECHO_NEXT_ARCHITECTURE.md              12412 B  ← ⭐ 七层分层 + IPC 六条判据 + 性能红线
docs/ECHO_NEXT_AUDIO_CORE.md                13497 B  ← ⭐ 9 状态机 + Renderer 契约
docs/ECHO_NEXT_NATIVE_AUDIO_PIPELINE.md     12946 B  ← ⭐ 为什么要独立进程 + 硬性规则
native/echo-audio-daemon/docs/protocol-spec.md  7134 B  ← operationId + 两级 ready + gaplessPrepare
docs/ECHO_NEXT_LIBRARY_CORE.md              19249 B  ← 曲库层（你 M3 会用到）
docs/ECHO_NEXT_UI_GUIDE.md                  （见仓库） ← UI 规则
docs/ECHO_NEXT_EQ.md                         8520 B  ← EQ 的 UI 侧
```

**QueMusic 关键路径**：见本文件前半部分（`ApiCommon.h` 79 行、`ApiHttp.h` 57 行、`LocalLyricsReader.h`、`doc/project/04-api-layer.md`）。

**稀疏克隆**（比逐文件抓取可靠）：

```
git clone --filter=blob:none --sparse https://github.com/Moekotori/ECHO.git
cd ECHO && git sparse-checkout set docs native/echo-audio-daemon
```
—— **只取文档和协议定义，不要取 `native/audio-host`**（`main.cpp` 单文件 160KB，`tests/` 156KB）。

> ⚠️ **不要整读**：ECHO 的 `native/audio-host/src/main.cpp`（**160 KB**）、`tests/audio_engine_tests.cpp`（**156 KB**）、
> `third_party/miniaudio.h`（**4.1 MB**）；QueMusic 的 `api/QCloudMusicApi/module.cpp`（5157 行，它自己的文档写"勿读"）。
