# 多渠道扫码登录 + 即点即播 方案 v1

> 上位：[`M3-v1-plan.md`](M3-v1-plan.md)（M3 整合方案）· [`CONTRACT.md`](../CONTRACT.md)
> 日期：2026-10-15 · 状态：**待 owner 批准 §7 的裁定项**

---

## 0. 这份方案解决两个**不同**的问题

| # | 问题 | 我方难度 |
|---|---|---|
| **A** | **多渠道扫码登录**（网易云 / QQ / 酷狗） | **中等**——三家都有现成协议层 |
| **B** | ⭐ **即点即播** | **高**——**这是我方独有的难题**，两家参考实现都没有 |

### 0.1 为什么 B 是我方独有的

| | 播放器 | 能直接播 HTTP URL？ |
|---|---|---|
| Folia | **前端 Chromium** | ✅ 能 → **"即点即播"是免费的** |
| Twilight_Echo | **前端 Chromium** | ✅ 能 |
| **我方** | **C++ 引擎进程** | ❌ **不能**，只读本地文件 |

**→ A 的问题是"接哪几家、怎么登"，B 的问题是"URL 怎么进引擎"。**

---

## 1. ⭐ 即点即播：解法已经找到（决定性发现）

### 1.1 引擎的 IO 层**已经是抽象的**

读 `engine/src/audio_source.cpp` 发现——**三个解码器全部使用自定义 IO 回调**：

```cpp
// dr_flac（L156-160 / L233）
drflac_bool32 flacSeek(void* user, int offset, drflac_seek_origin origin) {
    return seekReader(static_cast<FileReader*>(user), offset, static_cast<int>(origin))
}
handle_ = drflac_open(flacRead, flacSeek, flacTell, &reader_, nullptr);

// dr_mp3（L181-182 / L339）
drmp3_init(&mp3_, mp3Read, mp3Seek, mp3Tell, nullptr, &reader_, nullptr)

// dr_wav（L167-168 / L283）
drwav_init(&wav_, wavRead, wavSeek, wavTell, &reader_, nullptr)
```

**`FileReader` 是一个三回调抽象**：`read` / `seek` / `tell`。
**目前它们都转到 `std::fseek` / `_fseeki64`。**

### 1.2 所以：**只换 IO 后端，解码器一行不改**

```
现在：  dr_flac ──read/seek/tell──▶ FileReader ──▶ FILE* + fseek + fread
改成：  dr_flac ──read/seek/tell──▶ HttpReader ──▶ WinHTTP + Range 请求
                                    ↑ 同样三个回调，实现换掉
```

**`seek` 的语义天然匹配 HTTP Range**：

| 回调 | 现在（文件） | 改成（回环 HTTP） |
|---|---|---|
| `read(buf, n)` | `fread` | `GET` + `Range: bytes=<pos>-<pos+n-1>` |
| `seek(offset, origin)` | `_fseeki64` | **只改逻辑偏移**（不立即发请求） |
| `tell()` | `_ftelli64` | 返回逻辑偏移 |

⭐ **`seek` 变成"只记账、不动作"是关键的优化**——dr_flac 会频繁 seek，
若每次 seek 都发 HTTP 会灾难性变慢。真正的读取推迟到下一次 `read`。

### 1.3 三条备选路，及为什么选这条

| 路 | 做法 | 问题 |
|---|---|---|
| **A** ⭐ **回环 HTTP + `HttpReader`** | provider 起 `127.0.0.1` 代理，引擎换 IO 后端 | **推荐**。见下表 |
| B | 引擎读**正在增长的文件**（边下边播） | ⚠️ **引擎无法区分"文件结束"与"还没下到"** → 会误判播放结束。**我方 SPEC 9 压测的根因就是这类"谁回答还有没有"的问题**，代价高 |
| C | 下载完整文件再播 | ❌ **失去即点即播**——与你的要求冲突 |

**为什么 A 最好**：

| 维度 | 回环 HTTP |
|---|---|
| TLS 握手 | ❌ **无**（明文回环） |
| DNS | ❌ **无**（固定 127.0.0.1） |
| 公网不可达 | ❌ **不会**（本机 socket） |
| **seek** | ✅ **免费**（Range 天然支持） |
| 鉴权/过期/重试 | ✅ **全在代理里**，引擎不知道 |
| 依赖 | ✅ **WinHTTP = Windows 内置**，零第三方 |
| 解码器改动 | ✅ **零**（只换 IO 后端） |

### 1.4 ⭐ 改动面是精确的三处（已读出入口代码）

```cpp
std::unique_ptr<AudioSource> openAudioSource(const std::filesystem::path& file, std::string& error) {
    // ① 只读 16 字节文件头 → 判断容器。★ 16 字节对 HTTP 极其友好
    if (readFileHead(file, head, 16, error) < 0) return nullptr;
    const bool named = sniffContainer(head, container);

    if (named && container == Container::IsoBmff) return openMp4Source(file, error);  // ② 不改

    if (named && container == Container::Flac) {
        FileReader reader;
        if (!reader.open(file)) { error = reader.error; return nullptr; }   // ③ 只需换这里
        flac->init(reader, initError);
    }
    if (named && container == Container::Wav) { /* 同上 */ }
    // MP3 同理
}
```

| # | 改动点 | 工作量 |
|---|---|---|
| **①** | `readFileHead` 支持 HTTP（读前 16 字节） | 小 |
| **②** | MP4 路径（`openMp4Source` → Media Foundation） | **不改** |
| **③** | `FileReader` 加 HTTP 后端 | **主要工作量**（约 250–350 行） |

**⭐ 最小改动做法**：`FileReader` **保持具体类**，内部加一个模式：

```cpp
class FileReader {
public:
    bool open(const std::filesystem::path& file);   // 现有：FILE* + fseek
    bool openUrl(const std::string& url);           // ★ 新增：WinHTTP + Range
    // read / seek / tell 内部分发 —— ★ 签名不变
};
```

**为什么这样最小**：`FlacSource::init(FileReader&)`、`WavSource::init(FileReader&)`、
`Mp3Source::init(FileReader&)` **都接受引用**——
**只要 `FileReader` 的公开签名不变，三个 `init` 与三个解码器全部零改动。**

⚠️ **注意 `dr_libs` 存 `pUserData` 是逐字保存的**（源码注释原文：
*"dr_libs stores pUserData verbatim -- handing it the address of a local is the live bug this structure exists to prevent"*）。
**HTTP 模式下传给 dr_libs 的 `user` 指针仍必须是稳定的**——即 `FileReader` 对象的地址，
**不能是临时对象的地址**。这是已知陷阱的同一形态。

### 1.5 架构

```
┌─ Electron 主进程 ────────────────────────────────────────┐
│  api-enhanced serveNcmApi()（127.0.0.1:随机端口）         │
│  ★ 回环媒体代理（另一个随机端口）                          │
│     · 收到 /media/<token> → 转发到 CDN 签名 URL            │
│     · 带 Referer / UA（部分 CDN 要求）                     │
│     · ★ 转发 Range、回传 206 + Content-Range               │
│     · 签名过期 → 自动重签并续传                             │
│     · token 只在本机有效，进程退出即失效                    │
├─ twilight-engine.exe ────────────────────────────────────┤
│  ★ HttpReader（新，约 250–350 行）                        │
│     read / seek / tell + 小块预读缓存                      │
│  解码器（dr_flac / dr_mp3 / dr_wav）★ 零改动              │
└──────────────────────────────────────────────────────────┘
```

### 1.6 ⭐ 四条必须在写码前核实的点（P0）

**⭐ 第 ① 条是硬约束，且有源码依据——它同时判了备选 B 的死刑。**

#### ① `drflac_read_proc` 契约：**"读不满 = 流结束"**

⭐ **这是 dr_libs 家族的统一契约，三个解码器措辞一字不差**：

| 解码器 | 位置 |
|---|---|
| `drflac_read_proc` | `dr_flac.h` **L428** |
| `drmp3_read_proc` | `dr_mp3.h` **L357** |
| `drwav_read_proc` | `dr_wav.h` **L393** |

**契约原文（三个文件逐字相同）**：

> A return value of less than `bytesToRead` indicates the end of the stream.
> **Do _not_ return from this callback until either the entire bytesToRead is filled** or you have reached the end of the stream.

**这意味着三条**：

| # | 含义 |
|---|---|
| **1** | **`read` 不能返回"部分数据"** —— 那会被当成 EOS |
| **2** | **数据未就绪时必须阻塞等待**，不能返回短读 |
| **3** | ⭐ **这判了备选 B 死刑**：读一个**正在增长的文件**时，`fread` 在文件末尾必然返回短读 → **三个解码器都会以为播完了** |

⭐ **所以 §1.7 的"边下边播"不是"实现麻烦"，而是"与解码器契约冲突"** ——
除非在引擎侧引入"输入未结束"的新信号（那正是我方 SPEC 9 压测踩过的同类问题：
**"还有没有"该由谁回答**）。

**代理侧的正确行为**：

```
若数据可用但尚未下载到该位置  → ★ 阻塞等待（绝不返回短读）
若确实到达文件末尾            → 返回短读（合法的 EOS）
若请求失败                    → 不能返回 0（会被当成正常结束）→ 必须走错误路径
```

⚠️ **最后一条容易被忽略**：**"网络失败"绝不能退化成"返回 0"**，
否则**解码器会把一次网络错误当成正常播完**——静默地截断歌曲。

#### ② 预读窗口是**必需**的（不只是优化）

`dr_flac` 的内部缓冲是 **`DR_FLAC_BUFFER_SIZE = 4096`**（`dr_flac.h` L233），
且它有个 `cacheL2[DR_FLAC_BUFFER_SIZE/sizeof(drflac_cache_t)]`（**L547**）——**会频繁小读**。

→ `HttpReader` 内部需要一个**预读窗口（建议 256 KB）**，命中窗口内直接返回、不发请求。

**这个窗口的命中率决定成败**，必须先验证 dr_flac 的实际读取模式。
**它不只是性能优化——它是满足第 ① 条契约的手段**（一次 HTTP 取一大块，才能稳定填满 `bytesToRead`）。

#### ③ 要确认 dr_flac 不要求"先知道文件大小"

`readFileHead` 用 `fseek(0, SEEK_END)` 看大小（`audio_source.cpp` L74-76 / L125-127）。
HTTP 层面看大小要一次 HEAD，**或从 `Content-Range` 的总长度得到**。

→ **代理必须在第一个响应里给出总长度**，否则 dr_flac 可能拒开。

#### ④ seek 与 `SEEK_END`

`seekReader` 处理了 `SEEK_END`（L147）。**HTTP 的 `Range: bytes=-N` 表达"最后 N 字节"**，
→ 代理必须支持这个形态，或 `HttpReader` 把它翻成"总长度 − N"。

> ⚠️ **这四条只核实了源码契约，没有实测。**
> **实测 dr_flac 的读取模式（trace 一次 read 调用序列）是 P0 的第一件事。**

### 1.7 ⭐ 三条路的正式对比（含一条我修正过的判断）

**先确立共同原则**（来自 Folia 的实践，我完全采纳）：

> ⭐ **样本不穿越进程，穿越的是路径。**
> Folia 的 `transcode/service.cjs:writeSource` —— 主进程 `net.fetch(URL)` 把远端音频落成本地文件，
> **再把「路径」交给外部进程**（FFmpeg / Python sidecar）。

**这条与我方硬约束（音频样本绝不穿越通道）完全一致**，所以：
**问题不是"要不要把远端变成引擎可读的东西"，而是"变成文件还是变成 HTTP 资源"。**

#### 三条路

| | **a) 落盘（路径交接）** | **b) 回环 HTTP + `HttpReader`** | **c) 增长文件 + `totalFrames` 判断** |
|---|---|---|---|
| 即点即播 | ❌ 要等下载完 | ✅ **真流式** | ⚠️ **能开播**（见下） |
| 引擎改动 | **零** | **中**（约 250–350 行 IO 后端） | **小**（"短读不等于结束"的等待逻辑） |
| **seek** | ✅ 完整（文件在） | ✅ **完整**（Range） | ⚠️ **只能 seek 到已下载范围** |
| MP4/AAC | ✅ | ✅ | ⚠️ **非流式 MP4 的 moov 可能在文件尾** → 必须下完 |
| 网络失败处理 | 简单（下载失败=播放失败） | 中（要区分"失败"与"结束"，见 §1.6①） | ⚠️ **要能区分"还没下到"与"下载失败"** |
| 复用现有代码 | ✅ **全部** | 只换 IO 后端 | ✅ 全部 |

#### ⚠️ 我必须修正自己上次的判断

**上次我直接推荐 b、并说"落盘只能做到第二遍快"——这个结论过于果断。**

**c 是可行的**，理由是我方引擎有一个它们都没有的东西：

> ⭐ **引擎知道 `totalFrames()`** → **它能自己判断"还没读完"**。
> 读到短读时：**若 `framesRead < totalFrames` → 等待并重试**；若已达总帧数 → 正常结束。

**这与 SPEC 9 压测的修法同构**（当时的结论是「**让喂料端成为"还有没有"的权威**」）——
**同一个形状的问题，我方已经解过一次。**

**c 的真实代价**：**seek 只能到已下载范围**。对"从头听"的场景无影响，对"跳着听"有影响。

#### ⚠️ 关于子代理的"回环代理不要做"——我要指出一个适用性缺口

子代理的论据是「**Folia 对音频一个回环代理都没用**」。**这个事实我核实过，是真的。**
**但它不能推出"我方也不该做"**，原因是：

| Folia 的实际情况 | 推论边界 |
|---|---|
| 在线歌 → `getAudioSource()` 拿 CDN 直链 → **直接交给 Chromium 播** | ✅ 已核实 |
| **Chromium 能直接播 HTTP URL** | → **Folia 不需要回环代理，是因为它不需要**，不是因为它判断不好 |
| Folia 的落盘（`writeSource`）**只服务 local/navidrome 转码** | → **它明说"在线音源根本不走这条路"** |
| 且它的转码**"冷启动＝整首编码完才有第一个字节"** | → **它明确不追求即点即播** |

**所以**：子代理举的"落盘+路径交接"是对的**原则**，
**但那个场景不要求即点即播**——**用它来论证"即点即播不需要回环代理"是不成立的。**

**我方恰恰属于**回环代理"划算"的那种情形：**必须把远端媒体变成引擎可读的资源，且不能等。**

#### 我的建议（仍推荐 b，但理由更窄）

**推荐 b，理由只有一条**：**seek 完整**。

- 若你**接受"只能 seek 已下载范围"**（听完一遍就够了）→ **选 c**，引擎改动最小
- 若你**要求随时能跳**（跳着听、反复听某段）→ **选 b**

⭐ **这是一个偏好问题，不是技术优劣问题** —— 见 §7.1 的裁定项。

#### 落盘方案（a/c）的配套件：直接照抄 Folia

无论选哪条，**下载/缓存的工程细节**都该照抄它：

| 件 | 值/做法 | 为什么 |
|---|---|---|
| **content-type 校验** | `json\|xml\|text/html` 判为非音频 → `SOURCE_NOT_AUDIO` | 防把错误页当歌播 |
| **双重上限** | `content-length` **与流式计数**都要查 → `SOURCE_SIZE_INVALID` | 只信一个会被骗 |
| **重定向** | `redirect: 'follow'` | CDN 常跳转 |
| **原子发布** | 写 `.publishing` 暂存 → rename | 防止半截文件被读到 |
| **内容寻址** | `sha256({version, kind, songKey, sourceRevision})` | 版本变了自动失效 |
| ⭐ **pin 正在播的** | `MAX_PINNED_CACHE_KEYS = 4` | **动机（原注释）**：*"媒体元素缓冲满后不再读文件，mtime 变旧，LRU 会把正在播的条目删掉"* |
| **LRU 按 mtime** | `selectEvictions` 按 `usedAt`（= 文件 mtime，**每次播放读回都刷新**） | 语义是"最后播放"而非"首次下载" |
| ⭐ **容量 0 是特殊值** | `resolveCacheLimit(0) = Infinity` | **"0 = 用户明确要不设上限"，是有意义的答案**，不是"没设置" |
| 默认上限 | **5 GiB** | |
| **显式错误码** | `FFMPEG_UNAVAILABLE` / `SOURCE_HTTP_ERROR` / `SOURCE_NOT_AUDIO` / `CANCELLED` / `TIMEOUT` / `INVALID_OUTPUT` | **绝不静默失败** |

---

## 2. 多渠道扫码登录

### 2.1 三家渠道的形态（一手证据）

| 渠道 | 协议层 | 登录方式 | 进程形态 | 可靠性 |
|---|---|---|---|---|
| **网易云** | `api-enhanced` | **扫码**（801/802/800/803）+ 官方网页兜底 | ⭐ **唯一真起回环 HTTP 服务**（`serveNcmApi`，`LISTEN_HOST` 固定 IPv4） | **最稳** |
| **QQ** | `@yakult-green-tea/qq-music-api` **锁 3.3.1** | **微信 + QQ 双扫码**（QQ 走 **MQTT over wss**） | 三形态；**主进程内嵌**（我方选它） | ⚠️ **风控最重** |
| **酷狗** | `KuGouMusicApi`（`kugoumusicapi`） | 扫码（`login_qr_key/create/check` + `register_dev`） | ⭐ **进程内直调模块函数，零端口零 HTTP** | **次之** |

**⭐ 一个反直觉的事实**：**"进程内"不等于"不起服务"** ——
- **网易云**：进程内 **起**回环 HTTP 服务（因为包的设计就是 server）
- **QQ**：进程内 **起**回环 HTTP 服务（**且在 `require` 时就 listen**）
- **酷狗**：进程内 **不起**服务，**直接调模块函数**

**→ 我方选"进程内"是对的，但三个渠道的接入方式各不相同**（见 §2.2–2.4）。

**⚠️ 顺带一条**：Folia 的**波点（bodian）**也不是回环代理，而是
**「登记 URL + CORS 白名单」**（`register(url)`，TTL **2h**、上限 **2048**，
只放行 `media|xhr|image` + `GET|HEAD|OPTIONS`，`followRedirect` 续登跳转目标）。
**这是"让 Chromium 直接取远端资源"的另一种解法**——但我方不用（详见 §1.7 的讨论）。

### 2.2 ⭐ 网易云：两套端点 + **六个实操坑**

#### 两套端点都存在（分别来自两个 Apache/AGPL 实现）

| 实现 | 端点 |
|---|---|
| **Twilight_Echo**（Apache-2.0） | `/login/qr/key` → `/login/qr/create?key=…&qrimg=true&ua=pc` → 轮询 `/login/qr/check?key=…` |
| **Folia**（AGPL，★ 只学机制） | `/api/login/qrcode/unikey` → 轮询 `/api/login/qrcode/client/login` `{key, type: 3}` |

**两者都基于 `api-enhanced`**，只是调了不同端点。
**→ 实现时先在实测里确认哪一套在你的依赖版本上可用**，两套都留着作为回退。

**状态机（Twilight_Echo 的码，必须照抄）**：

| 码 | 含义 | UI 该做什么 |
|---|---|---|
| **801** | 等待扫码 | 继续轮询，提示"请扫码" |
| **802** | 已扫码，待确认 | 提示"已扫码，请在手机上确认" |
| **800** | 二维码过期 | **停止轮询，重新生成** |
| **803** | 成功 | `data.cookie` → 保存 → 停止轮询 |

#### ⭐ Folia 挖出的六个坑（都是我照源码看不出来的）

| # | 坑 | 后果 / 对策 |
|---|---|---|
| **1** | ⚠️ **上游 `util/request` 在 `require` 时同步读 `os.tmpdir()/anonymous_token`** | **缺失即 ENOENT 崩 Electron** → **必须先写一个空文件**（＋`xeapi_public_key`） |
| **2** | ⚠️ **`serveNcmApi` 没有关闭入口** | **二次调用会泄漏端口** → `startPromise` **单飞**，绝不重复启动 |
| **3** | ⭐ **来源 IP 头会被上游写成 `127.0.0.1` 或随机国内 IP** | **与手机实际位置不符会让扫码确认失败** → 需要"来源 IP 策略"（Folia 用 `withoutImplicitClientIp`，仅在显式要求时才留伪造 IP） |
| **4** | ⭐ **`LISTEN_HOST` 要固定 IPv4** | 若监听 `::1`，上游会走**不同的来源 IP 分支** → 固定 `127.0.0.1` |
| **5** | ⚠️ **上游 `login_qr_check` 有 bug** | 它的 catch 分支引用了 try 里的 `result` → 请求被拒时抛 **ReferenceError**，server 只回一个 **`404 Not Found`**，**真实原因（风控 8821）被吞掉** → 必须自己替换这个模块 |
| **6** | ⭐ **扫码请求可能被 ECONNRESET**（按出口 IP/设备） | 对策①：**网络重试**——`{status:502, body.code:502}` 时延时 **300ms** 重发一次<br>对策②：**身份轮换**——遇 ECONNRESET 只置 `pendingRotation`，**下一次 unikey 前才真换 deviceId**（保证一轮 key+轮询同一身份） |

#### 官方网页登录兜底（保留，价值高）

开**内存分区**（`partition` 不落盘）窗口加载 `https://music.163.com/#/login`，
监听 `session.cookies` 直到拿到 `MUSIC_U`，**180 秒超时**，导航白名单只放行 `*.music.163.com`。

**⭐ 价值**：扫码通道失效时**用户仍有路可走** —— 比"报错让人重装"好得多。

#### 登录态存哪：**两者都选择了"不在 Electron 明文存"**

| | 做法 |
|---|---|
| **Twilight_Echo** | cookie 由**本地 NCM 服务自持**，渲染进程只经 HTTP 访问 |
| **Folia** | 同上（cookie 在回环服务里）；`neteaseLoginDiagnostics` **只记 `MUSIC_U`/`MUSIC_A` 是否存在、不记值** |

> ⭐ Folia 的注释值得抄进我方代码：**"贴进公开 issue 等于交出账号"**。
> 它的诊断缓冲上限：`MAX_ENTRIES = 40`、`MAX_MESSAGE_LENGTH = 300`、**deviceId 只留末 8 位**。

### 2.3 QQ：三形态 + ⚠️ **一个必须提前知道的致命约束**

| 形态 | 微信扫码 | **QQ 扫码** | 登录态 | 备注 |
|---|---|---|---|---|
| Vercel | ✅ | ❌ | 加密令牌 | "没有可跨请求持有这条连接的运行时原语" |
| Cloudflare（默认） | ✅ | ❌ | 加密令牌 | |
| Cloudflare + Durable Object | ✅ | ✅ | 加密令牌 | 需 `QQ_QR_CHANNEL` → `QqQrChannel` |
| Docker / 裸 Node | ✅ | ✅ | 服务端会话＋可选加密文件 | VPS / NAS 长期自托管 |
| ⭐ **Electron 桌面版** | ✅ | ✅ | **系统安全存储** | **免部署（我方选这个）** |

**根因**：**微信通道处处可用（不需要长连接）；QQ 通道必须有进程持有 MQTT over WebSocket。**
扫码事件走 **MQTT over wss**（`u.y.qq.com` / `mu.y.qq.com` / `api.tencentmusic.com` / `open.weixin.qq.com`）。

#### ⚠️ 三条硬事实（都已核实）

| # | 事实 | 后果 |
|---|---|---|
| **1** | ⭐⭐ **该包在 `require` 时就 `app.listen()`，且 require 缓存导致"每进程只能调一次"** | **QQ 没有重启路径**（`qqBackend.cjs` 原文明写"重启不可能"）。二次调用会**返回上一个端口上的旧 server 却报告新端口** |
| **2** | ⭐ **QQ 二维码最多存活约 3 分钟**（**已核实为真**，`docs/qq-music-deployment.md` 原文） | 是**二维码寿命**，不是 token TTL。契约对应 `getQrTtlMs?()` —— **UI 要自己计时，到点停止轮询** |
| **3** | **登录设备上限**（`20279`） | 失败原因应是 `device-limit`，引导用户去 QQ 音乐"设置→设备管理"清旧设备——**重启或换网络无效** |

**第 1 条对我方的直接影响**：**不能设计成"重启 QQ 后端"**。
出错时只有**整个应用重启**一条路 → **UI 文案要如实说"请重启应用"，而不是给一个按了没用的按钮。**

#### 版本与凭据

**锁 `3.3.1`**：3.3.0 加了电台 / 私人 FM / 推荐歌单 / 歌单增删 / 收藏歌单；3.3.1 加了红心与收藏专辑。

**凭据存储**（可照抄）：`SESSION_KEY='QQ_API_AUTH_SESSION_V1'`、`ENVELOPE_VERSION=1`、
`kind:'electron-safe-storage'`；`safeStorage.encryptString(JSON)` → base64 → electron-store。
⭐ **渲染进程只留一个不透明的 `qqmusic_session`** ——
**musickey / refresh_key / 设备上下文不过 IPC**。

#### ⭐ 一个诊断工程技巧

该包对客户端**只回白名单化的 `failureStage` / `failureReason`**（界面只看到一句 `"QR login failed"`），
**它自己的日志也只记 `error.name`** → **信息被包方主动削掉了**。

Folia 的对策：**猴补（monkey-patch）它的内部 `failSession` / `failBootstrap` 与 logger**，抓 `qq-auth.*`。

⚠️ **代价**：这依赖包的内部文件布局（`dist/src/services/auth/qrLogin.node.js`），
**版本一变就可能失效** → Folia 的做法是"装不上只降级为『钩子不可用』，不影响启动"。
**这个降级姿态要学。**

### 2.4 酷狗：**进程内，不起 HTTP**

Folia 的做法（一手来源）：

> Electron 版在主进程中直接调用内置的 KuGouMusicApi Node 模块，**不会再启动一个酷狗 HTTP 服务**。

**它的登录日志纪律值得抄**：

> 日志位于 `%APPDATA%\Folia\logs\kugou-provider.log`。日志只记录**请求阶段、状态、字段名和错误摘要**，
> **token、Cookie、userid、dfid 会被脱敏**。

### 2.5 ⭐ 登录态存储：照抄 Twilight_Echo 的双后端信封

**`secureStorage.ts` 的四条**（我方 CONTRACT §5 只写了"用 safeStorage"，这个更完整）：

```ts
interface SecureValueEnvelope {
  __twilightSecure: true
  version: 1
  backend: 'electron-safe-storage' | 'aes-256-gcm-machine'   // ★ 双后端
  ciphertext: string
  iv?: string
  tag?: string
}
```

| # | 设计 | 为什么 |
|---|---|---|
| **1** | **双后端 + 信封带 `backend`** | safeStorage 在部分环境不可用；**自动回退且解密时知道用哪个** |
| **2** | **scrypt 机器指纹派生密钥** | 不需密钥文件；换机器解不开（对自用是正确取舍） |
| **3** | ⭐ **`scope` 参与派生** | **同一个 cookie 在不同 scope 下密文不同** → **防止跨渠道密文搬运** |
| **4** | **`isSensitiveStorageKey()` 正则** | 按 key 名自动判定敏感 → **新增渠道的存储键自动获得保护** |

**⚠️ 三条 cookie 的 scope 要分开**：`ncm` / `qq` / `kugou` —— 这正是第 3 条的价值。

### 2.6 ⭐ 凭据脱敏（**建议立刻用，20 行**）

```js
.replace(/(MUSIC_U=)[^;\s]+/gi, '$1[REDACTED]')            // 网易云主凭据
.replace(/(__csrf=)[^;\s]+/gi, '$1[REDACTED]')
.replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
.replace(/((?:X-Api-Key|X-Signature)\s*:\s*)[^\s,;]+/gi, '$1[REDACTED]')
// 以及 query 里的 password/captcha/token/cookie/...
```

**直接对应我方 CONTRACT §5 与 SPEC §9.4「日志里绝不能带 token」。**
**多渠道之后，三个 cookie 都有泄漏风险，这条的优先级上升。**

---

### 2.7 ⭐⭐ 结构化失败模式：让错误能**引导用户**

Folia 没有把登录失败当成一个字符串，而是**三个正交维度**：

```ts
type QrLoginState = 'waiting' | 'scanned' | 'confirmed' | 'expired'
                  | { error: { message, reason, retryAfterMs?, transient?, detail? } };

type QrLoginErrorReason =
  | 'canceled-on-device'    // 用户在手机上取消
  | 'connection-reset'      // 连接被重置
  | 'device-limit';         // 登录设备数超限
```

**⭐ 三个 reason 各自给出不同的下一步**：

| reason | 该提示什么 | ⚠️ 不该做什么 |
|---|---|---|
| `canceled-on-device` | **正常行为**，重试即可 | ⚠️ **不给"复制诊断"入口**——Folia 明确说"未扫码就过期＝正常，不给诊断" |
| `connection-reset` | **换网络**（如手机热点）或**重启应用** | 不要只说"登录失败" |
| `device-limit` | 去 QQ 音乐「设置→设备管理」**清旧设备** | ⚠️ **重启或换网络无效**——提示这些会让用户白折腾 |

另有 `QrLoginFailureKind`（**7 值**），**专门用作"要不要给『复制诊断』入口"的判据**。

> ⭐ **这条与我方 DESIGN-v5 的诚实原则同构**：
> **"失败要说出下一步做什么"，而不是把用户丢在一个"登录失败"上。**

### 2.8 ⭐⭐ 登录自检：一个**分层定位器**

Folia 的 `loginSelfCheck.cjs` 是本次调研里**最值得整体照搬的工程设施**。
它把"登录不行"从一个模糊状态变成**可分层的诊断**：

| 层 | 测什么 | 关键细节 |
|---|---|---|
| **① 本地后端** | `status === 'running'` **＋ GET `/`**（**任何 HTTP 响应即算活**） | `BACKEND_TIMEOUT_MS = 3000` |
| **② 代理** | env `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` **＋ `session.resolveProxy`** | 凭据**掩成 `//***@`**；`isFakeIp` 认 **`198.18.0.0/15` = TUN fake-ip** |
| **③ 每个上游域名** | DNS（`all` + `verbatim`）→ ⭐ **对首个 IPv4 与首个 IPv6 各做一次独立的 TCP+TLS** → 一次真 HTTPS GET，并用 `Date` 头算 **`clockSkewMs`** | ⭐ **分开测 v4/v6 才分得清"只有 IPv6 被重置"** |

`DEFAULT_TIMEOUT_MS = 5000`，各域名**并行**，约 **10 秒**出结果。
**verdict 由渲染进程推**（`core/model/loginSelfCheckRules`）—— **主进程只测，不判**。

**⭐ 它的用户侧清单也值得抄**（`docs/qq-music-deployment.md`）：

```
两条简单办法（重启应用再扫码 / 换网络如手机热点再重启）
  → 自动检查（本地服务 · 凭据保存 · DNS · IPv4 与 IPv6 各自的 TCP 与 TLS · HTTPS · 代理 · 系统时间）
  → 收起式「还是不行？」
  → 复制诊断 / 反馈
  → 另附 14 行「一句话排错表」
```

**⭐ 三个设计判断值得记**：

| # | 判断 | 为什么 |
|---|---|---|
| **1** | **"任何 HTTP 响应即算活"** | 不要用"返回 200"当判据——**有响应就说明服务在** |
| **2** | **v4 与 v6 分开测** | 合并测会**掩盖"只有一条路被重置"**这种最常见的失败 |
| **3** | **算 `clockSkewMs`** | **系统时间偏差会让签名校验失败**——而用户绝不会想到这一条 |

> ⚠️ **它报告"复制诊断"时是安全的**：诊断只记**凭据是否存在**，不记值
> （Folia 注释：*"贴进公开 issue 等于交出账号"*）。

---

## 3. 统一抽象：两种做法，我建议**取 Folia 的**

三个渠道的登录方式不同，**但 UI 只该看到一套**。**这里有两种做法，我建议取 Folia 的。**

### 3.1 做法 A：数据驱动（Twilight_Echo）

```ts
type AuthType = 'qr' | 'phone' | 'email' | 'webview' | 'server' | 'none';

interface ProviderAuthDescriptor {
  authType: AuthType;
  loginInstructions: string;                  // 给用户看的一句话
  qrStatusCodes?: { waiting; scanned; expired; success };   // 仅 qr
  extraActions?: Array<{ label: string; method: string }>;  // 兜底入口
}
```

**实例**（`ncm-provider` 的 `register()`）：

```js
ui: {
  icon: 'pi pi-cloud', color: '#c20c0c', description: '内置基础音源',
  authType: 'qr',
  loginInstructions: '请使用网易云音乐 App 扫码登录',
  qrStatusCodes: { waiting: 801, scanned: 802, expired: 800, success: 803 },
  loginExtraActions: [{ label: '使用官方网页登录', method: 'openOfficialLogin' }]
}
```

**优点**：**状态码是数据** → 一套 UI 服务所有渠道。
**局限**：表达不了"**这个渠道有两种扫码方式**"、表达不了 **TTL**、表达不了**自检**。

### 3.2 ⭐ 做法 B：行为驱动 + 渐进增强（Folia）

**它的抽象是一组全可选的方法**（`OnlineAuthProvider`）：

```ts
getLoginStatus()
logout()
getQrLoginMethods?()          // → QrLoginMethod[]  [{id:'qq', labelKey, iconKey}, {id:'wechat', ...}]
resolveQrLoginMethods?()
getQrKey?(methodId)           // 要码
createQr?(key)                // 出二维码
checkQr?(key)                 // 轮询
cancelQr?(key)
getQrTtlMs?()                 // ★ 二维码有效期（QQ 的 3 分钟）
getQrLoginDiagnostics?()
canRunQrLoginSelfCheck?()
runQrLoginSelfCheck?()
```

**⭐ 三条设计精华**：

| # | 设计 | 为什么强 |
|---|---|---|
| **1** | **全可选（`?`）+「不声明即代表只有单一方式，UI 维持单步流程」** | **渐进增强**：简单渠道只实现两个方法；复杂渠道实现全部。**同一套 UI 自然适配** |
| **2** | **`getQrLoginMethods()` 返回数组** | **能表达"QQ 有两种扫码方式"**（`'qq'` / `'wechat'`）—— 做法 A 做不到 |
| **3** | **`getQrTtlMs()` 让 UI 自己计时** | ⭐ **直接应对 QQ 的 3 分钟**：UI 到点停止轮询，而不是**一直转圈等超时** |

**⚠️ 注意**：它的抽象里**没有 `authType: 'qr'` 这个字面量**——
**"是不是扫码"是通过"你有没有实现 `getQrKey`"隐式表达的。**

### 3.3 我的建议：**取 B 的方法集，保留 A 的数据**

| 取什么 | 来自 | 理由 |
|---|---|---|
| **方法集（含 `getQrLoginMethods` / `getQrTtlMs` / 自检两方法）** | **B** | 能表达多方式、TTL、自检 |
| **`qrStatusCodes` 作为数据** | **A** | 状态码确实该是数据（B 把它们藏在实现里了） |
| **`extraActions` 兜底入口** | **A** | 网易云的"官方网页登录"是真实需要 |

**→ 合起来**：**用 B 的方法签名，把 A 的 `qrStatusCodes` 作为方法返回值的一部分。**

⭐ **对我方三个渠道正好**：

| 渠道 | 要实现什么 |
|---|---|
| **网易云** | 基础方法 + `qrStatusCodes` + `extraActions`（网页兜底） |
| **QQ** | **全部方法**（双方式 + `getQrTtlMs` 3 分钟 + 自检） |
| **酷狗** | 基础方法（零端口，最简） |

## 4. ⭐ 能力四态（与 [`M3-v1-plan.md`](M3-v1-plan.md) §8 同一条）

登录页与播放按钮都需要回答"**为什么不能点**"。Folia 的 `capability.ts`：

```ts
type Reason = 'empty' | 'loading' | 'unsupported' | 'pending' | 'limit-reached';
type Capability = { supported: boolean; enabled: boolean; pending: boolean; reason?: Reason };
```

**在多渠道场景下尤其重要**：

| 场景 | `supported` | `enabled` | `reason` |
|---|---|---|---|
| 未接 QQ | **false** | false | `unsupported` |
| QQ 已接、未登录 | true | **false** | — （提示去登录） |
| 正在扫码轮询 | true | **false** | `pending` |
| 二维码过期 | true | **false** | — （提示重新生成） |
| serverless 形态的 QQ（无 QQ 扫码） | **false**（仅 QQ 扫码这一项） | false | `unsupported` |

**→ 这样"QQ 扫码"按钮在 serverless 形态下是"不可用且有原因"，而不是"点了没反应"。**

---

## 5. 播放链路时序（即点即播）

```
用户点歌
  │
  ├─① 解析播放地址（provider → api-enhanced → 网易云）
  │      ~100–300 ms（有 20 分钟 URL 缓存时近乎 0）
  │
  ├─② 代理登记 token → 返回 http://127.0.0.1:<port>/media/<token>
  │      ~0 ms（纯内存操作）
  │
  ├─③ 引擎 open(trackId) → HttpReader 首次 read
  │      ★ 这里才真正发 HTTP → 代理 → CDN
  │      首字节 ~200–500 ms（本地 socket + 跨网 CDN）
  │
  ├─④ dr_flac 探测到 STREAMINFO → totalFrames() 可用
  │
  └─⑤ 出声
         合计目标：**< 1 s**（与本地文件的 149 ms 相比，多的是 CDN 首字节）
```

⭐ **关键设计**：**①、② 在点歌时同步做（快），③ 的首字节延迟才是用户感知的等待。**
所以优化点是**让 ③ 尽早开始**（可以在 ① 成功后就预连接，不等用户确认播放）。

---

## 6. 分期与验收

| 期 | 内容 | 依赖 |
|---|---|---|
| **P0** | ⭐ **实测 `dr_flac` 的读取模式**（trace 一次 read/seek 调用序列） | **不实测不能开工**（§1.6） |
| **P0** | **裁定 §7.1**（c 还是 b） | 决定后面几步 |
| **P1** | ⭐ **凭据脱敏 + 双后端信封**（**20 行 + 147 行**） | **建议最先做，成本最低** |
| **P2** | ⭐ **登录自检的分层定位器**（§2.8） | 独立，且**三个渠道都受益** |
| **P3** | **Navidrome provider**（无签名、无风控，先跑通整条通路） | — |
| **P4** | 若选 b：**回环媒体代理 + `HttpReader`**<br>若选 c：**增长文件读取 + `totalFrames` 判断** | P0 |
| **P5** | **网易云 provider**（扫码 + 六个坑 + 网页兜底） | P4 |
| **P6** | **QQ provider**（主进程内嵌，锁 3.3.1，**接受"无法重启"**） | P5 |
| **P7** | **酷狗 provider**（进程内直调，零端口） | P6 |
| **P8** | **能力四态 UI**（走 CR） | P3 |

### 验收

**可自动断言**：

| # | 断言 |
|---|---|
| **1** | **`HttpReader` 与 `FileReader` 逐字节等价**：同一文件，两种 reader 读出的字节流**完全相同** |
| **2** | **seek 后 read 正确**：随机 seek 到 N 个位置，读出的字节与文件对应位置一致 |
| **3** | **`SEEK_END` 正确**：取"最后 64 字节"，与文件尾部一致 |
| **4** | **不重复下载同一区间**：断言同一个 Range 在预读窗口内**只发一次请求**（预读缓存生效） |
| **5** | 扫码状态机：构造 801→802→803 序列，**断言 UI 文案依次正确**；800 时**重新生成** |
| **6** | 凭据脱敏：日志里**不含** `MUSIC_U` / `__csrf` / 任何 cookie 明文 |
| **7** | 能力四态：未接渠道的按钮**不可点且有 reason** |

⭐ **第 1 条是最强的保证**：**它证明"换 IO 后端"对解码器完全透明**——
**若这一条通过，即点即播就不可能在解码层引入任何回归。**

**必须人工/真机**（**不自称通过**）：
三渠道扫码全流程 · 首字节延迟实测 · 弱网与 CDN 切换表现 · seek 手感 · 二维码过期后重新生成。

---

## 7. 需要你裁定的三项

### 7.1 ✅ 已裁定：**走 b（回环 HTTP + `HttpReader`）**

**理由（owner）**：要 **seek 完整**（跳着听、反复听某段），
接受引擎加约 250–350 行 IO 后端。

**→ 实施要点已明确**：

| # | 要做的事 | 依据 |
|---|---|---|
| **1** | **先实测 `dr_flac` 的读取模式**（P0 门禁，见 §1.6） | 不实测会做出错的预读窗口 |
| **2** | 回环代理：Range 转发（`206` / `416` / `Accept-Ranges`）+ 鉴权重签 + token 登记 | §1.5 |
| **3** | `FileReader` 加 `openUrl()`，**公开签名不变** → 三个 `init` 与三个解码器零改动 | §1.4 |
| **4** | ⚠️ **网络失败绝不能退化成"返回 0"** —— 否则解码器把错误当成正常播完，**静默截断歌曲** | §1.6① |
| **5** | 预读窗口（建议 256 KB）—— **它是满足 `read_proc` 契约的手段，不只是性能优化** | §1.6② |

### 7.2 ✅ 已裁定：**跳过 Navidrome，只做网易云 + QQ**

**⚠️ 一个连带风险，我要指出**：Navidrome 原本是**最安全的通路验证**
（无签名、无风控、无加密），跳过它意味着**第一个接入的就是最难的网易云**。

**→ 三条补偿措施**（写进 §6 的分期）：

| # | 措施 |
|---|---|
| **1** | ⭐ **先用本地文件测通"回环代理 + `HttpReader`"**（B4 先于 C4）——
让引擎侧 IO 后端**在没有网络变量的情况下**先验证（§6 验收 1–4 全是本地可测） |
| **2** | ⭐ **先做登录自检分层定位器**（§2.8）—— 网易云失败时能**分层指出**是 DNS / v4-v6 / TLS / 代理 / 时间偏差 |
| **3** | **保留官方网页登录兜底** —— 扫码失效时用户仍有路 |

### 7.3 仍待裁定：**QQ 用「主进程内嵌」还是「serverless」**

| 形态 | 微信扫码 | QQ 扫码 | 我方判断 |
|---|---|---|---|
| **主进程内嵌** | ✅ | ✅ | ⭐ **推荐**（免部署 + 双扫码） |
| serverless（Vercel / Cloudflare） | ✅ | ❌（需 Durable Object） | 少一个进程，但**只有微信扫码** |

---

## 8. 附：本方案的一手来源

```
即点即播（我方引擎，本地已核实）：
  engine/src/audio_source.cpp
    L156-160  flacSeek 回调          L233  drflac_open(flacRead, flacSeek, flacTell, ...)
    L167-168  wavSeek                L283  drwav_init(&wav_, wavRead, wavSeek, wavTell, ...)
    L181-182  mp3Seek                L339  drmp3_init(&mp3_, mp3Read, mp3Seek, mp3Tell, ...)
    L144-147  seekReader（转 std::fseek / _fseeki64）
    L74-76, L125-127  fseek(0, SEEK_END) 取大小
  engine/src/audio_source.hpp
    AudioSource 抽象基类：readFrames / seekToFrame / sampleRate / channels / bitDepth /
                          totalFrames / lossless
  engine/CMakeLists.txt
    target_link_libraries(... mfplat mfreadwrite mfuuid shell32 ole32 oleaut32 uuid)

网易云扫码（Twilight_Echo，Apache-2.0，已核实）：
  resources/plugins/ncm-provider/index.mjs
    L1146-1194  unikey 三连；L73  qrStatusCodes {801,802,800,803}
    L1174-1177  502 时 &noCookie=true 重试
  src/main/ncm/api.ts
    L147  openNcmOfficialLogin()（内存分区 + 180s 超时 + 导航白名单）
  src/main/security/secureStorage.ts  147 行（双后端信封 + 脱敏正则）

QQ / 酷狗 / 登录自检 / 回环代理（Folia，AGPL-3.0，★ 只学机制）：
  docs/technical.md      ← ✅ 已核实：依赖 api-enhanced；酷狗进程内不起 HTTP；
                            歌词接口 127.0.0.1:32109/v1/lyric
  docs/qq-music-deployment.md（15,868 B）  三形态差异
  electron/kugouApiBridge.cjs（13,894 B）
  src/utils/lyrics/…（50+ 文件，约 250 KB）

Folia 的能力四态（AGPL，★ 只学机制）：
  src/library/core/contracts/capability.ts   699 B  ← ✅ 已核实
```

### 8.1 ✅ 上一版列为"待核实"的项，本轮**已全部查实**

| 上一版的状态 | 现在 |
|---|---|
| ⚠️「QQ 扫码 3 分钟有效期」 | ✅ **属实**。`docs/qq-music-deployment.md` 原文"**QQ 二维码最多存活约 3 分钟**"。**是二维码寿命，非 token TTL** |
| ⚠️ QQ 扫码通道 | ✅ **MQTT over WebSocket**（`u.y.qq.com` / `mu.y.qq.com` / `api.tencentmusic.com` / `open.weixin.qq.com`） |
| ⚠️ Folia 的自定义协议 | ✅ **`folia-transcode://media/<64位hex cacheKey>/audio.flac`**。**但它只服务 local/navidrome 转码，在线音源不走** |
| ⚠️ 酷狗的登录方式 | ✅ `login_qr_key` / `login_qr_create` / `login_qr_check` / `register_dev`；**进程内直调模块函数，零端口** |
| ⚠️ 网易云扫码端点 | ✅ 两套并存（见 §2.2）；且挖出**六个实操坑** |

### 8.2 ⚠️ 仍未核实（实现前以实测为准）

| 项 | 状态 |
|---|---|
| ⭐ **`dr_flac` 的实际读取模式**（小读频率、是否依赖 `SEEK_END`） | ⚠️ **§1.6 的 P0，必须实测**。源码契约已确认，但**没有 trace 过真实调用序列** |
| **`folia-transcode` 是否真流式** | ✅ 已确认**不是**——它是"整首转码完才有第一个字节"。**所以它不能作为"即点即播"的先例**（见我 §1.7 的修正） |
| `electron/stageApi.cjs`（77,669 B） | ⚠️ 未读，**不判断它是否暴露媒体流** |
| QQ 的实际首字节延迟 / 转码延迟 | ⚠️ **无实测数据**（Folia 自己也只记 `elapsedMs`，未公开） |
| **c 方案的"seek 受限"手感** | ⚠️ 需要实测：**跳到未下载区域时，UI 该显示什么** |

### 8.3 数据更正（上一版我写错的）

| 项 | 上一版 | 正确 |
|---|---|---|
| Folia 星数 | 6350 | **6540** |
| Folia 未关闭 issue | 52 | **46**（`open_issues_count: 58` 含 PR） |
