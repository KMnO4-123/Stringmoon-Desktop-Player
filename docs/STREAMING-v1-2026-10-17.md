# 平台接入 v1 · 网易云 / QQ 音乐 / Meting（含酷狗）（2026-10-17）

> 契约依据：[`CONTRACT.md`](../CONTRACT.md) §4（接口 B：平台层）与 §5（账号与风控约束）。
> 参照实现：Folia 桌面版（用户自备 API 服务端 + 应用内置自动启动）。
> 相关：`app/src/shared/streaming.ts`、`app/src/main/streaming/*`、`app/src/renderer/src/streaming/*`。

---

## 0. 一句话结论

平台接入**从占位变成了真实现**：主进程按需拉起用户自备的 API 服务端（动态端口、探活、崩溃退避重启、退出清理），
三个源（网易云 / QQ 音乐 / Meting）走同一套 provider 接口，提供 搜索 → 取播放地址 → 播放 → 歌词，
并落实了 §5 的全部硬约束。

> **诚实边界**：本机没有安装这三个服务端（按裁定是「用户自备」），所以**没有做过对着真实服务端的端到端联调**。
> 端点的形状是对着各自的**官方文档**写的，并用**文档里给出的真实响应样例**做单元测试；
> 服务端生命周期用真实的本地 HTTP 进程测过。见 §5「验证到哪一步」。

---

## 1. 之前是什么样

`sourceAdapters.ts` 里两个 `status: 'planned'` 的描述符，设置页的「登录」按钮会在 420 ms 后
假装回到未登录。没有任何服务端、没有登录、没有搜索、没有播放。**结论：没做。**

---

## 2. 架构（照 Folia 的方式）

```text
渲染层  ──IPC──▶  主进程 StreamingManager
                    ├─ ApiServer(netease)  → spawn 用户命令 → 127.0.0.1:<动态端口>
                    ├─ ApiServer(qq)       → spawn 用户命令 → 127.0.0.1:<动态端口>
                    ├─ ApiServer(meting)   → spawn 用户命令 → 127.0.0.1:<动态端口>
                    └─ 取到直链 → LoopbackMediaProxy（带 Referer/UA）→ 引擎 open { url }
```

三个不可让步的点：

1. **端口一律动态分配**（`listen(0)` 拿空闲端口再关掉），通过各自的环境变量交给服务端：
   网易云与 QQ 读 `PORT`，**Meting 读 `HTTP_PORT`**（写错就永远起不来，所以它是 spec 里的字段，不是常量）。
2. **就绪判据是「能建立 HTTP 连接」**，不是「某个业务接口返回 200」——探测业务接口会打上游、消耗风控额度。
3. **直链不经渲染层**：主进程把 URL 注册进回环代理，引擎只看到 `http://127.0.0.1:<proxy>/media/<token>`。
   token 与这次播放同生共死，换一首必然换 token（`online-playback.ts` 既有约束）。

---

## 3. 三个源的真实端口与端点（来源：各自官方文档）

| 源 | 包 | 端口变量 | 搜索 | 播放地址 | 歌词 | 登录 |
|---|---|---|---|---|---|---|
| 网易云 | `@neteasecloudmusicapienhanced/api` 4.41.1 | `PORT` | `/search?keywords=` | `/song/url/v1?id=&level=` | `/lyric?id=&yv=-1&tv=-1` | `/login/qr/{key,create,check}` |
| QQ 音乐 | `@yakult-green-tea/qq-music-api` 3.3.2 | `PORT`（默认 3200） | `/search?keyword=&type=song` | `/getMusicPlay/<songmid>?quality=best&resType=play` | `/getLyric?id=&trans=1` | `/login/qr/{key,create,check}`（801/802/803/800） |
| Meting | `meting-api`（metowolf，Hono） | `HTTP_PORT` | `/api?server=&type=search&id=` | `/api?server=&type=url&id=&token=` → **302** | `/api?server=&type=lrc&id=&token=` | 无 |

细节：

- 网易云 `yv=-1` 才会回字级 `yrc`（CONTRACT §4.4 的既有实测结论）。
- QQ 的播放接口认 **songmid**，不是数字 songid；`interval` 是**秒**。
- QQ 不登录时 `search` 常被上游拒绝（`502 / search.rejected`，上游码 2001）——这不是「搜不到」，会给出可行动提示。
- Meting 的搜索结果**不给 id**，只给三条它自己的 API 链接，id 必须从链接的 query 里取。
- Meting 的 `url`/`lrc`/`pic` 需要 `HMAC-SHA1(METING_TOKEN, server+type+id)`；`search` 不需要（多带反而可能被严格实现拒绝，所以不带）。
- Meting 对 QQ 的 `server` 名是 `tencent`，不是 `qq`。酷狗就是 `kugou`（这就是「酷狗接入」的落地路径：**没有维护中的专用服务端**，走通用源）。

---

## 4. §5 硬约束的落实

| 约束 | 实现 |
|---|---|
| 同平台请求间隔 ≥1s | `Throttle` 串行化，**在 manager 里**，任何调用方都绕不过 |
| 风控立即停 | 收到 429 立刻封停该平台 10 分钟并报错，**不重试** |
| QQ 设备数超限（20279） | 单独识别，提示去「设备管理」清理 |
| 凭据不落明文 | `safeStorage` **异步** API（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）；没有加密后端时**不保存**，也不退化成明文 |
| 不批量、不轮询 | 没有后台扫描/推荐轮询；只有用户点一次才发一次请求 |
| 播放直链 | 经回环代理转发，带 Referer/UA（CDN 对无 UA 请求常回 403） |

**一处显式放宽**：平台 CDN 大量回 `http://` 直链，而 `media-proxy` 的默认策略是拒绝明文上游。
为此给 `MediaSource` 加了 `allowInsecure`，**只由平台适配层显式设置**，不是「校验失败就放宽」的自动降级；
收紧的默认值仍然在，https→http 的降级规则也只在它被显式打开时才不适用。

---

## 5. 验证到哪一步（重要）

| 项目 | 状态 |
|---|---|
| 服务端生命周期（拉起 / 动态端口 / 探活 / 停止 / 退出重试上限） | ✅ **用真实子进程测过**（起一个本地 HTTP 进程当服务端，全程 loopback） |
| 命令解析与端口传递（引号、`$PORT`、Windows 下 npx 包装） | ✅ 单测 |
| 三个平台的 URL 构造与响应映射 | ✅ 单测，形状取自**各自官方文档的响应样例** |
| 响应形状不符时的可诊断性 | ✅ 单测（错误里带「看到了哪些顶层字段」） |
| 配置消毒（未知平台、超长命令、非法 meting sub-source） | ✅ 单测 |
| 节流 / 429 封停 / 20279 / search.rejected 的**分支** | ✅ 代码路径确定，未对真实上游触发 |
| 扫码登录 → 拿会话 → 加密落盘 | ⚠️ **未对真实服务端跑过**（需要服务端与真账号） |
| 搜索 → 取直链 → 引擎播放 | ⚠️ **未对真实服务端跑过** |

这不是「做完了」的含糊表述：能被本地证据覆盖的都覆盖了，
覆盖不了的部分（真实账号、真实上游）**明确标为未验证**，而不是靠「应该没问题」收尾。

---

## 6. 怎么用

1. 设置 → **流媒体账户**。
2. 每个源有它的启动命令（默认 `npx -y <官方包>`，首次运行会联网下载；也可以改成你本机已有的路径）。
3. 点「启动」→ 状态变「运行中 · 端口 xxxxx」。
4. 网易云 / QQ 点「扫码登录」；Meting 若服务端设了 `METING_TOKEN`，在同一个卡片里填令牌。
5. 下面选平台、搜关键词、点结果即可播放。

不想要某个源：把命令清空或点「停止」，它不会占用任何端口。

---

## 7. 界面（左栏 + 歌曲中心 + 批量操作）

### 7.1 左栏

聆听    音乐空间 / 我的曲库 / 歌曲中心 / 沉浸播放 / 音效
来源    本地曲库 · 网易云 · QQ 音乐 · 通用源；每行右侧是**真实状态**（就绪 / 未登录 / 启动中 / 未启动 / 启动失败），悬停展开 登录 · 退出 · 启动 · 停止
歌单    [本地 | 网易 | QQ] 页签 + 该来源的歌单列表

- 点平台来源 = 切换当前来源；服务端没起来会**顺带拉起**（省掉用户先去设置页点一次）。
- 平台歌单需要登录态：未登录时这一档显示「登录后可见你的歌单」，而不是空列表。
- 点本地歌单 → 曲库视图；点平台歌单 → 歌曲中心并直接拉取该歌单曲目。

### 7.2 扫码登录

`QrLogin` 对话框：打开时才请求二维码，**只在对话框存在期间轮询**（2 s），关掉立刻停。
801 等待 / 802 已扫 / 803 成功 / 800 过期；过期会明确显示「已过期，请重新获取」，不会让二维码永远转圈。
两个平台的数字码是同一套，所以一份实现覆盖两边。

### 7.3 歌曲中心

一个视图里放三种内容：本地曲库搜索结果、平台搜索结果、打开的一张平台歌单。
顶部是**来源切换**（本地 / 网易云 / QQ / 通用源）+ 搜索框。
平台曲目双击或点播放键即播（走回环代理 → 引擎 `open { url }`）。

### 7.4 批量操作

| 位置 | 能力 |
|---|---|
| 曲库列表 | 多选（Ctrl 点选 / Shift 连选）、全选、反选、播放选中、添加到歌单、加入队列、下一首播放 |
| 歌曲中心（本地档） | 全选、反选、播放选中、加入队列、下一首播放 |
| 歌单视图 | 勾选 + 全选 / 反选 + 从这张歌单移除（逐条调既有接口，不新增批量命令） |

队列操作每次先读 `get_state.queue` 再改（`queueActions.ts`）。**不在界面里维护一份自以为的队列**：
两处一旦不同步，下一首就会插到错误的位置，而且不会有任何东西报错。

### 7.5 这一轮新增的后端接口

| 用途 | 网易云 | QQ |
|---|---|---|
| 账号资料 | `/login/status` | `/login/status` |
| 我的歌单 | `/user/playlist?uid=` | `/user/playlist` |
| 歌单曲目 | `/playlist/track/all?id=&limit=&offset=` | `/user/playlist-detail?tid=&limit=&offset=` |

Meting 没有登录态，所以不参与账号与歌单（它的定位是通用搜索 / 播放源）。

### 7.6 验证

```text
electron 78/78（新增 6 条：来源行存在且可切、歌单页签可切、歌曲中心有来源切换与搜索框、
              本地默认有曲目、全选会更新计数、切到平台档会给出登录或加载反馈）
app      268/268   typecheck 干净   tokens 0 违规   build 通过
```

仍未验证的部分与第 5 节相同：**没有真实服务端**，所以登录/歌单/搜索/播放的实际回包没有跑过。
界面侧断言证明的是「该出现的控件存在且能切」，不是「对上游真的可用」。
---

## 8. 真实服务端实测（2026-10-17 补，推翻了第 5 节的「未验证」）

在本机真的装起两个服务端，把所有假设逐条对照。下面每条都是**实测**，不是文档推断。

### 8.1 网易云 `@neteasecloudmusicapienhanced/api` 4.41.1

| 检查 | 结果 |
|---|---|
| `/search` 的响应形状 | **老结构**：`result.songs[].artists / album / duration`，**没有** `ar / al / dt` |
| `mapSearch` | ✅ 正常（兜底键正好覆盖老结构），id/标题/艺术家/专辑/时长全对 |
| `/song/url/v1` | ✅ 返回真实直链，形如 `http://m702.music.126.net/...mp3` —— **是 http**，所以 `allowInsecure` 是必需的，不是保守估计 |
| `/lyric?id=&yv=-1&tv=-1` | ✅ lrc 1517 字符、tlyric 1377 字符；**未登录时 yrc 为空**（字级歌词需要登录） |
| `/playlist/track/all` | ✅ `songs[]` → `mapPlaylistTracks` 正常 |
| `/user/playlist?uid=` | ✅ `playlist[]` → `mapPlaylists` 正常 |
| `/login/status` | 未登录时 `data.profile = null`、`data.account` 是匿名账号 → `mapAccount` 正确判为未登录 |

### 8.2 QQ 音乐 `@yakult-green-tea/qq-music-api` 3.3.2

| 检查 | 结果 |
|---|---|
| `/search` 未登录 | 502 `search.rejected`（upstreamCode 2001）——会被翻成「先扫码登录」的可行动提示 ✅ |
| `/login/status` 未登录 | `{code:200, data:{}}` → `mapAccount` 判为未登录 ✅ |
| `/user/playlist` 未登录 | 401 `Login required` ✅ |
| `/login/qr/key?channel=qqmusic` | `{data:{unikey}}` → `mapQrKey` 正常 ✅ |
| **`/getLyric`** | **参数名是 `songmid`，写 `id` 直接 400 `no songmid`** ❌→ 已修 |
| **`/getLyric` 的返回** | **不是纯 LRC 文本，是 `{response:{lyric:"[ti:...]"}}`** ❌→ 已修 |
| **`/getMusicPlay/<mid>`** | 拿不到地址时是 **HTTP 200 + 业务错误**：`data.playUrl.<mid>{url:"", error:"暂无播放链接", restriction.codes.result:104003}` ❌→ 已修成报出真实原因 |

### 8.3 Meting

**`meting-api` 不是 npm 包**（registry 404）——原来给的 `npx -y meting-api` 是一条**必然失败**的默认命令。
官方分发方式是 Docker 镜像 `ghcr.io/metowolf/meting-api`，所以默认命令改成 Docker；
没有 Docker 的机器需要自备兼容 Meting API 的服务端（本机就没有 Docker，所以 Meting 这条仍未实测）。

### 8.4 端到端：真实直链 → 回环代理 → 引擎

```text
付费歌（fee=1，未登录）：引擎读到 35000ms —— 这是匿名试听片段，不是 bug
                        播放正常，xrun 0
免费歌（fee=0）        ：引擎读到 172224ms = 官方时长，mp3 320kbps，xrun 0，进度按真实时间走
```

这条链证明了三件事：**代理真的把 http 直链喂给了引擎**、**引擎的 WinHTTP Range 读得动 CDN**、
**时长是按真实流报的**（所以试听片段会如实显示 0:35，而不是假装 4:21）。

### 8.5 修掉的三处

1. QQ 歌词参数 `id` → `songmid`；返回解析加上 `response.lyric`。
2. QQ 播放地址：200 里的业务错误改成报出 `暂无播放链接 / code=104003`，不再当成「响应形状不对」。
3. Meting 默认命令：`npx meting-api`（不存在）→ Docker 镜像命令，并在界面上说清需要 Docker。

三处都补了回归单测（`streaming-adapters.test.mjs` 现为 19 条断言）。
---

## 9. 左栏收敛成 7 项 + 全局搜索 + 下载（2026-10-17 第三轮）

用户要求：左栏**只有 7 个功能栏、不许展开**，来源列表不再堆在侧栏；全局搜索与下载各自独立成栏。

```text
音乐空间 · 我的曲库 · 歌曲中心 · 全局搜索 · 下载 · 音效 · 设置
```

### 9.1 原先堆在侧栏的东西去哪了

| 原先 | 现在 |
|---|---|
| 来源列表（本地/网易云/QQ/通用源 + 登录/启停） | **设置 → 流媒体账户**（整张卡，本来就是完整面板） |
| 本地歌单列表 | **我的曲库** 的「歌单」页签 |
| 平台歌单（来源页签） | **歌曲中心** 里打开（打开后直接拉该歌单曲目） |
| 沉浸播放（左栏第 4 项） | 播放栏那个按钮（它本来就是个展示模式，不是功能） |

`'immersive'` 仍保留在视图联合类型里，只是不再是导航项。

### 9.2 全局搜索

一次输入，搜遍**所有已启动的来源**（网易云 / QQ / 通用源），结果标注来源、可播放、可下载。
没启动任何来源时报「先在设置里启动至少一个服务端」，而不是给一个空列表。
某个来源失败不会让整体失败——收集每个源的错误，全部失败才抛。

### 9.3 下载

- 队列**一次只跑一个**（并发请求会被平台风控）；先写 `.part` 再改名。
- 落盘 `歌手 - 歌名`，同时写同名 `.lrc` 与封面图；**MP3 写入 ID3 标签**（node-id3）。
- 失败只影响那一条，不中断队列；取消对排队中与下载中都有效。
- 目录可配置（默认 `userData/Downloads`），配置存 `downloads.json`。

### 9.4 实测（真实服务端）

```text
下载一首免费歌：6891146 字节 → 6.8MB mp3 + 364 字节 lrc + 76KB 封面
extras = ["歌词","封面","标签"]
读回标签：title/artist/album 都在，内嵌封面 1 张（mp3 体积 6891146 → 6967589，正好多出封面）
```

**这一步抓到一个真 bug**：`node-id3` 是 CJS，`await import('node-id3')` 拿到的是 `{ default: module }`，
直接调 `id3.write` 会抛 `is not a function`——而它被下面的 `catch` 吞掉，表现成「下载成功但标签没写」。
第一版就是这样：extras 只有 `["歌词","封面"]`，MP3 里读不到任何标签。修成取 `.default` 后才真正写进去。

### 9.5 侧栏合同（现在由测试守着）

```text
恰好 7 个 [data-view-target]，且顺序固定
.source-rail / .sidebar-playlists 数量必须为 0（不许再堆二级列表）
全局搜索视图有自己的搜索框；下载视图能读到真实目录且队列初始为空
```

electron 79/79（新增 4 条侧栏与两个新视图的断言）、app 271/271、tokens 0、build 通过。
---

## 10. 登录失败排查 + 网页登录兜底 + 设置界面（2026-10-17 第四轮）

### 10.1 先量：链路本身是通的

用**真实应用**（不是构造数据）走了一遍：

```text
qrStart -> image 2666 字符（data:image/png）+ qrurl
qrPoll  -> state=waiting（801）
session -> signing-in
```

所以失败不在二维码生成。逐个对照 Folia 的实读笔记（docs/PLAY-v1-login-and-streaming.md §2.2）后，
找到三处**会让用户直接看到失败**的地方：

### 10.2 三处真问题

| # | 问题 | 后果 |
|---|---|---|
| 1 | 登录按钮只在 `running` 时渲染 | 服务端没起来时**按钮直接消失**，无从登录 |
| 2 | `login()` 不负责拉起服务端 | 点了只会得到「服务端没有运行」 |
| 3 | 803 一到就宣布登录成功 | 扫码确认 ≠ 会话可用；不发那次 `/login/status` 核验，用户会在接下来的搜索/播放里才发现没登上，而界面一直显示已登录 |

第 3 条是最坏的一种：**显示成功但实际不可用**。现在 803 之后必须把 cookie 交给服务端核验，
认了才算登录；不认就删掉 cookie、退回未登录并明确说「服务端不接受这个会话」。

### 10.3 按 Folia 的坑补的

| Folia 的坑 | 我们的处理 |
|---|---|
| 上游 `login_qr_check` 的 catch 引用未定义变量 → 只回空 404、真实风控码被吞 | 404 单独翻译成「上游拒绝，常见于扫码风控，等 10 秒重试或改用网页登录」，不再原样透传 |
| 扫码请求可能被 ECONNRESET / 502，重发一次常常就好 | 扫码路径单独一个 `qrRequest`：命中 502/连接重置则 300 ms 后重试一次。**只对扫码重试**，搜索/播放重试只会让风控更难缠 |
| 扫码通道失效时要有别的路 | 新增**网页登录兜底** |

### 10.4 网页登录兜底

内存分区窗口打开官方登录页，轮询该分区 cookie，出现会话键即结束：

```text
网易云：MUSIC_U          白名单 music.163.com / 163.com / .163.com / …
QQ    ：qqmusic_key、qm_keyst、uin
超时 180 秒；用户关窗也算结束；结束后清空该分区的存储
```

白名单抽成纯函数（`shared/web-login.ts`）并加了断言，因为它是这里唯一有安全含义的部分：

```text
evil-qq.com        → 拒绝（不做 includes，“包含”是同类白名单最经典的洞）
qq.com.evil.example→ 拒绝
music.qq.com       → 放行
```

拿到 cookie 之后**仍然走同一套核验**（`acceptWebLogin` → `/login/status`），
所以扫码和网页登录不存在两套真相。

### 10.5 设置界面

- 来源卡片顶部加**状态总览**：每个源一个 chip（就绪/未登录/已登录/启动中/启动失败），一眼看清。
- 左侧目录改成**跟着滚动高亮**（IntersectionObserver + `aria-current`）。设置页很长，静态目录等于让用户自己找位置。
- 登录按钮常驻；登录时自动拉起服务端并等待（首次 npx 下载慢的话会明确说 30 秒没就绪）。

### 10.6 验证

```text
真实应用链路：qrStart 2666 字符二维码 → 801 → signing-in
新增 web-login.test.mjs 3 条断言（白名单精确匹配 / 会话键判定 / 登录页域名必须放行）
app 277/277   electron 79/79   tokens 0   build 通过
```

仍未验证：**真正扫一次码**（需要手机）。803 之后的核验路径因此没有实测数据，只有代码路径与错误分支。
---

## 11. 二维码不弹出 + 设置界面（2026-10-17 第五轮）

### 11.1 为什么点了「扫码登录」没有码

`.streaming-qr` 是**行内块**，渲染在来源卡片列表的最下方。设置页很长，
用户点卡片上的按钮时，二维码出现在下面看不见的位置——看起来就是「没弹出来」。

项目里本来就有一个 `position: fixed` 的模态 `QrLogin`（侧栏版本留下的），设置页却没用它。
改成复用它之后：

```text
实测：.qr-overlay position=fixed，内含 .qr-image（data:image/png，180×180）
```

顺带修了 `QrLogin` 的一处隐患：它的轮询 effect 依赖 `onSignedIn`/`onClose`，
而父组件传的是内联箭头函数 → 每次渲染都是新引用 → **2 秒轮询被反复重启**。
回调改放 ref，依赖只剩 `[ticket, platform]`。

### 11.2 数据目录：一个会静默丢配置的隐患

排查「服务端不自动启动」时发现 `app.getPath('userData')` 会随**启动方式**变化：
打包/预览时解析成 `twilight-echo-app`，直接 spawn 一个脚本时解析成 `Electron`。
而代码是按「当前 userData」推导目标目录的，于是换个启动方式就换了一个空仓库——
表现是「设置全没了、服务端也不起」，但文件其实还在原地。

现在只有两条路径：测试注入的隔离目录，或**固定的**历史目录。名字只用于显示。

```text
实测（同一个 node -e spawn 方式）：修复前 0/3 就绪、配置是默认值
                          修复后 netease:8469 / qq:8493，8 秒内就绪
```

### 11.3 设置界面

| 改动 | 为什么 |
|---|---|
| 顶部**状态条**：曲库 / 输出 / 来源 / 已移除 | 原来只有一句「把播放、界面和音乐来源放在同一张控制台」的标语，没有任何实时信息 |
| 状态条**每 2 秒刷新** | 服务端是后台拉起的，只读一次会长期显示「0 / 3」，比不显示更误导（实测：就绪后从 0/3 变成 2/3） |
| 状态项可点击跳转到对应小节 | 控制台的意义是能用，不是能看 |
| 目录**跟随滚动高亮** + 强调条 | 设置页很长，静态目录等于让用户自己找位置 |
| 来源卡片顶部**状态 chips** | 一眼看清哪个源没起来、哪个已登录 |

### 11.4 验证

```text
electron 82/82（新增 3 条：状态条四项都在 / 每项都有值 / 目录恰好高亮一个）
app 277/277   tokens 0   build 通过
截图核对：状态条显示 来源 2/3，目录高亮「播放」
```

---

## 12. 「服务端不识别这个会话」的根因：cookie 送错了通道

扫码 803 成功、cookie 也存下来了，但之后每个请求仍被当成匿名 → 我加的核验判定「会话不被接受」。

### 12.1 实证

直接在服务端源码里找读 cookie 的地方：

```js
// 网易 util/option.js
cookie: query.cookie || process.env.NETEASE_COOKIE

// QQ controllers/login.js
query.cookie ?? ctx.cookies.get(AUTH_COOKIE_NAME)
```

**两家都从 query 读会话**。我一直用的是 HTTP `Cookie` 请求头——它们根本不看。

线上对照实验（真实服务端）：

```text
不带 cookie              → account=18043089769/type1000，profile=null   （服务端自己造个匿名身份）
?cookie=MUSIC_U=BOGUS123 → account=null，profile=null                   （读到了，判定无效）
```

带假 cookie 时匿名账号**消失**，说明 query 通道确实被解析；
而走请求头会表现得与「完全没带」一模一样——所以核验永远失败。

### 12.2 修法

`shared/streaming.ts` 新增纯函数 `appendSessionCookie(url, cookie)`：

- 拼进 query，值 `encodeURIComponent`（cookie 里有 `;`、空格、`=`，不编码会被截断）；
- 已有 `cookie=` 参数时不重复拼；
- 没有会话时原样返回。

`manager.request()` 统一经过它；`meting` 的 secrets 是 HMAC 令牌不是 cookie，显式排除。
请求头保留为兜底（QQ 在 query 缺失时会回落到 `ctx.cookies`）。

### 12.3 验证

```text
新增 3 条断言：编码 / 保留既有参数且不重复 / 空会话不动 URL
app 280/280   electron 83/83   lint（含 CSS 括号）通过   build 通过
```

仍未验证的部分：**真扫一次码**需要手机。803 之后的核验逻辑现在通道正确，但没有一次真实的登录态往返样本。
---

## 13. cookie 未被识别：系统性排查与修复

### 13.1 排查方法

真实扫码需要手机，803 之后的链路没有确定性验证。所以先造了一个**假 API 服务端**
（`tools/mock-streaming-server.mjs`），按真实形状回包，并用 `tools/login-flow-check.cjs`
在真实主进程里跑完整链路。它一开始就复现了用户看到的同一句错误，
这正是排查需要的东西：**可重放的失败**。

### 13.2 逐个环节的结论

| 环节 | 结论 |
|---|---|
| 传输通道 | server.js 两条都收：`?cookie=` 走**有损**的 `cookieToJson`（值里有 `=` 就整条丢），并**覆盖** `req.cookies`；`Cookie` 头走**宽容**解析（按第一个 `=` 切）。所以正确通道是**请求头** |
| 上游回包形态 | `login_qr_check` 把 Set-Cookie 数组 `join(';')` 塞进 body：`MUSIC_U=…; Path=/; Expires=Wed, 01 Jan 2031 … GMT;__csrf=…` |
| 由此产生的损坏 | `join(';')` **不带空格**，而服务端按 `;\s+` 切分 → `GMT;__csrf=deadbeef` 被并进 `Expires` 的值，**`__csrf` 消失**；属性 `Path=/`、`Expires=` 一并混进会话 |
| 我们这一侧 | 对着假服务端验证：qrStart/qrPoll/account 全通，说明应用逻辑本身没问题 |

### 13.3 修法

1. **清洗**（`normalizeCookie`，纯函数 + 4 条断言）：用正则把 `name=value` 全部抽出来
   （`[^;]*` 在分号处停下，即使 `;` 后面没有空格也能取到下一对），丢掉属性名，
   按 `'; '` 重拼。值里的 `=` 填充完整保留。
2. **只走请求头**：`?cookie=` 会把更完整的那份覆盖成有损解析的结果。

### 13.4 验证

```text
假服务端（严格判据：值含 '=' 必须完整 / __csrf 必须在 / 不得残留 Path= Expires=）
  qrPoll → confirmed
  account → signedIn: true, uid 42, 昵称「模拟用户」
  收到的会话 = MUSIC_U=MOCK-VALUE==; __csrf=deadbeef    query 为空

app 279/279   electron 83/83   lint（含 CSS 括号）通过   build 通过
```

### 13.5 这套工具留着

```text
tools/mock-streaming-server.mjs   假服务端（真实回包形状 + 严格会话判据）
tools/login-flow-check.cjs        在真实主进程里跑完整登录链路（需先 pnpm build）
```

真实扫码仍然只能由人来做，但**803 之后的所有环节**从此可以确定性重放。
---

## 14. 账号收藏 / 账号歌单 / 歌单搜索（2026-10-17）

### 14.1 后端

| 能力 | 网易云 | QQ |
|---|---|---|
| 账号收藏 | `/likelist?uid=` 拿 id，再 `/song/detail?ids=` 批量换歌名（每批 100） | `/user/liked-songs` |
| 我的歌单 | `/user/playlist?uid=` | `/user/playlist` |
| 歌单搜索 | `/cloudsearch?keywords=&type=1000`（1000 = 歌单） | `/search?keyword=&type=playlist` |

网易云要先 id 再换详情，因为 `/likelist` 只回 id；一次几百个 id 会把 URL 撑爆，所以分批。

映射沿用既有纪律：认不出结构就抛 `ShapeError` 并报出**实际看到的顶层字段**，
而不是静默返回空列表——空列表会被用户读成「这个账号没有收藏」。

### 14.2 界面

歌曲中心从「一个列表」改成 **账号栏 + 主区**：

```text
┌───────────────┬────────────────────────────────┐
│ ● 昵称 / 未登录 │ [搜索歌曲…………………][搜索]      │
│ ♥ 我的收藏      │                                │
│ ≡ 我的歌单      │  曲目列表 或 歌单卡片            │
│ 歌单搜索        │                                │
│ [关键词…][搜索] │                                │
└───────────────┴────────────────────────────────┘
```

几个刻意的选择：

- **未登录时账号栏仍然显示**，按钮点了会明确说「先登录」，而不是把入口藏起来让用户以为没有这个功能。
- 主区用**显式视图**（曲目 / 歌单）而不是「看哪个数组非空」：两者都为空时那种写法会退化成猜，
  用户分不清「没有」和「没查」。
- 歌单卡片显示封面 + 名字 + 曲目数；点开就是原来那条「打开歌单 → 拉曲目」的路，没有第二套逻辑。

### 14.3 验证

用假服务端（`tools/mock-streaming-server.mjs`，同时伺候两个平台的回包形状）驱动真实界面：

```text
歌单搜索 → 2 张卡片（搜索歌单一 / 搜索歌单二），名称与曲目数正确
未登录点「我的收藏」→ 明确拒绝：先登录 网易云音乐，收藏要看账号
app 284/284（新增 3 条映射断言）   electron 85/85（新增 2 条账号栏断言）
```

真实的收藏/歌单数据要登录后才有，但**从接口到界面这条链**已经被假服务端跑通了。
---

## 15. 「无法播放」与「搜索不全」（2026-10-17）

### 15.1 无法播放：allowInsecure 在中间层被丢掉

报错 `Media URLs must use HTTPS (or loopback HTTP for local sources).` 来自回环代理的校验。

链路是 `streaming-play → onlinePlayback.open(source) → mediaProxy.register(...)`，
`index.ts` 把 `allowInsecure` 放进了 source，**但 `online-playback.ts` 调 register 时没有把它传下去**：

```ts
// 之前
mediaProxy.register({ url, referer, userAgent, refresh })          // ← allowInsecure 凭空消失
```

于是平台 CDN 的 http 直链全被拒。修好之后顺带把错误消息改成可行动的：

```text
这个音频地址是明文 http（http://media.example），而代理没有为它开启 allowInsecure。
平台直链需要适配层显式允许明文：检查 resolvePlay() 是否带上了 allowInsecure。
```

原来的消息只说「必须 HTTPS」，收到它的人只会以为地址有问题。

### 15.2 搜索不全：两个平台都只取了第一页

| 平台 | 之前 | 现在 |
|---|---|---|
| 网易云 | 老 `/search?limit=20`，无翻页 | `/cloudsearch?type=1&limit=30&offset=`，支持翻页 |
| QQ | `/search?page=1&limit=20` 写死第一页 | 吃 `page`，每页上限 20（服务端 MAX_LIMIT），靠翻页拿更多 |
| Meting | 无翻页 | 不变，offset>0 如实回空 |

界面在结果列表底部加「加载更多」；翻页失败**不清空已有结果**——已经看到的不该因为一次翻页失败消失。

### 15.3 三家参考实现怎么做的（第一手核对）

**GD 音乐台**（读了它自己的 `js/ajax.js`）：搜索是 `types=search` / `search_album` / `search_playlist`，
参数 `source` `name` `count` `pages`，**按页码翻页**（`rem.loadPage` 自增），并有一个统一聚合 API
（`music-api-*.gdstudio.xyz/api.php`）替它扇出到各平台。结论与我们一致：**必须翻页**。

**Folia**：走 NeteaseCloudMusicApi 的同一套端点，同样分页（项目里的 `docs/PLAY-v1-login-and-streaming.md`
第 2.2 节有它的实读记录）。

**ECHO NEST**：本机没有它的源码，联网也未能定位到可核对的一手仓库，所以**这里不做断言**。
按名字猜它的实现没有意义，宁可留白。

### 15.4 验证

```text
新增断言：cloudsearch 带 offset / QQ 每页钳到 20 且吃 page / 代理拒绝时点名地址与开关且开启后放行
app 286/286   electron 85/85   lint（含 CSS 括号）通过   build 通过
```

---

## 16. 「正在播放」、歌单外壳、输出规格与歌曲中心（2026-10-17 第六轮）

用户这一轮报的是五件事：**歌单取不到**、**播了但界面什么都没反映**、**192kHz 等输出规格没实现**、
**歌曲中心布局被挤/被砍**、**搜索结果看不到详细信息**。逐条落地的位置如下。

### 16.1 歌单取不到：QQ 的外壳是 `{ code, playlist, total, more }`

真实回包（服务端 `dist/src/services/user/userPlaylistResponse.js` 的 `toUserPlaylistBody`，逐字）：

```json
{ "code": 200, "playlist": [ ... ], "total": 12, "more": false }
```

**没有 data 这一层**。旧映射只找 `data.list` / `record.list` / `*.playlists`，于是登录成功、
歌单也存在，界面却报「响应里没有预期的字段」。修法：四种外壳都认（`playlist` 在顶层或 data 下、
list / playlists 兜底），条目同时兼容自建（`tid / dirName / songNum`）与收藏
（`dissid / dissname / logo / song_count`）两套字段名，封面统一升级成 https。
歌单曲目 / 收藏 / 我喜欢共用同一个 `qqMapSongs`（songmid、interval 秒、album.mid → y.gtimg.cn 封面）。

### 16.2 播了但界面没反映：URL 源的 trackId 是空串

引擎对 `open { url }` 的 state 事件里 `trackId` 恒为空（CR-016 约束 3：URL 源没有曲库条目，
元数据归应用侧）。旧 store 把「空 trackId」直接判成 `no-track`，于是：有声音、没有标题、
没有进度、按钮全灰。**空 trackId 不等于没有在播**——这是两件事。

修法（`store.ts`）：

- 新增 `onlineTrack`（平台曲目元数据）与 `beginOnlinePlayback / confirmOnlinePlayback / failOnlinePlayback`；
- `state` 事件里「有没有歌」由 `onlineTrack` 回答，「在不在放」仍由引擎回答；
- `selectLoadedTrack` 在本地 id 缺席时合成 `online:<platform>:<id>` 的展示 Track，
  于是播放栏 / 音乐空间 / 歌词 / 播放详情**不需要各写一套分支**；
- 时长取**引擎实测**（试听切片如实 0:35），不是平台给的整首长度；
- 本地曲目接管 / 引擎停止 / 引擎重启 都会收起在线元数据；
- 上一首 / 下一首对在线单曲**禁用并说明原因**（它不在引擎队列里，点了只会得到 queue empty）。

`streaming/play.ts` 的 `playStreamingTrack` 先落元数据再要直链——顺序反了，第一个 state 事件
到达时 store 还不知道在线曲目，界面就永远停在「未在播放」。

封面：适配层补 `cover`（网易云 `al.picUrl`、QQ `album.mid` → `y.gtimg.cn`），
CSP 的 `img-src` 放行 https；跨域封面取色会抛 SecurityError，已退回哈希色。

歌词：平台歌词走 `streamingLyrics`，网易云的 `yrc` 用 `parseYrc`、否则 `parseLrc`，
翻译行按同一时间戳合并；没有就明说「这个平台没有给出歌词」。

### 16.3 输出规格：`set_output.sampleRate`（引擎 + 应用）

- 引擎：新增 `Player::setOutputRate`；独占/自动路径按请求的流率开流（非零时重采样器进入链路），
  共享模式无法采纳（WASAPI 只能跑设备混音格式）并如实报告请求值与实际值；
  `state.requestedOutputRate` 为只读字段；`set_output.mode` 省略 = 保持当前偏好；
  非法的率 **ERR_STATE 拒绝**，不静默夹到最近档。
- 顺带修了两个只有真正用起来才会暴露的问题：
  1. `reopenOutput` 原来**不发 state 事件** —— 改完模式后回包是新格式，而界面还在画旧流；
  2. 改设置会重开流，但**不自动恢复播放** —— 一次设置等于一次静音。现在播放中改设置会接着放。
- 重采样质量：SoXR `HQ`（20-bit）→ `VHQ`（28-bit）。这条链路现在是**用户可选**的
  （44.1k 源强制 192k 输出），精度比纳秒更值；它只在 rate 不同时创建，直通路径一个字节没动。
- 应用侧：播放栏信号面板与设置页都有 **跟随源 / 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz** 七档，
  同时显示「请求」与「实际」；设置页新增**端点能力（实测）**一节，直接调 `list_devices`
  列出每个端点的独占格式（`44100:24` → `44.1k / 24bit`），不是一张编出来的规格表。
- 偏好持久化：输出模式与规格存 localStorage，握手成功后由 `applyOutputPreference()` 重新下发
  （引擎是无状态进程，重启会丢）。

### 16.4 平台音质档位

| 平台 | 档位 | 说明 |
|---|---|---|
| 网易云 | 标准 / 较高 / 极高 / 无损 / **Hi-Res 24bit/192kHz** | `/song/url/v1?level=` |
| QQ | 自动最佳（FLAC→320→128）/ FLAC / 320 / 128 | 服务端 `quality` 参数实测取值；**没有 192k 这档** |

请求档位与**实测解码**分开显示：档位只是请求，真实采样率/位深以引擎 `sourceSampleRate/bitDepth` 为准。
配置存 `providers[].quality`，经 `sanitizeConfig` 白名单校验。

### 16.5 歌曲中心与搜索结果

- 高度：`.view-center` 不再滚动，`.song-center` 用 `height:100%` 把剩余高度交给列表，
  `.center-scroll` 自己滚。原来的 `max-height: 56vh` 在滚动容器里再套一个滚动区，底部行**看起来就是被砍掉**。
- 宽度：账号栏 232px 固定、主区 `minmax(0,1fr)`；窄于 1020px 时侧栏换到下方，不再挤压主区。
- 本地档不再画侧栏（数据源就一行曲库），整宽列表；平台档保留账号栏，并显示服务端状态。
- 恢复/补齐：曲目/歌单两个显式视图、打开的歌单有「返回歌单」、收藏/歌单/歌单搜索、
  来源状态点、批量操作（本地）、加载更多。
- 搜索结果行：**封面 + 标题 + 艺人 · 专辑 + 时长 + 来源 chip**；展开看曲目 ID、专辑、时长、
  平台歌词预览，动作有播放 / 下载 / 查看歌词 / 复制信息。全局搜索按来源分组，同样的详情面板。

### 16.6 验证

```text
引擎实测（内置端点，44100 源 / 24bit）：
  open            → shared 48000（端点拒绝 44100 独占）
  set_output 96000 → requested=96000，实际 48000，degradeReason 点名 "96000 Hz / 24-bit PCM"
  set_output 48000 → exclusive 48000，resampled=true，bitPerfect=false，reason=resampled
  强制 48k 播放 4s → position 4103ms / xrun 0 / renderedFrames 196992（≈48000/s）
  set_output 12345 → ERR_STATE（拒绝）
QQ 歌单形状回归：{code, playlist, total, more} 自建+收藏各一条；歌单曲目 songmid/秒/封面。
在线 now-playing 单测 9 条（播放/暂停/停止/本地接管/空 trackId/引擎重启/合成 Track/
  selector 引用稳定 / open 期间那条 stopped 不算结束）。
真实 Electron + 真实引擎 + 真实回环代理 + 假服务端（tools/mock-streaming-server.mjs 现可发 WAV）：
  服务端动态端口 ready → 扫码登录核验 → 我的歌单 1 张卡 → 歌单曲目 2 行（带封面槽）
  → 点播放 → 播放栏标题「在线曲一」+ 平台名 + has-playing + 进度前进
  → 音乐空间显示同一首、平台歌词出现在歌词区
  同时验证：歌曲中心不越出视图且列表在 .center-scroll 内滚；设置页列出实测端点能力；
  全局搜索按来源分组、展开详情有专辑/时长/曲目 ID 与播放/下载/复制
app 298/298   electron 105/105（0 failures）   player 70   listening 34   startup 16
typecheck 干净   tokens 0   CSS 括号平衡   build 通过
```