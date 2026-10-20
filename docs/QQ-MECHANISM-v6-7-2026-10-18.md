# QQ 音乐机制修复（v6.7，2026-10-18）

> 用户反馈：「无法获取我的任何歌曲，且依旧过期，查询也查不到，歌单/收藏/播放都不行；调用 MCP 工具研究 QQ 音乐和 Folia 的实现」。
> 本轮用三条证据源：① 上一版内置的 `login-diag.log`（用户复现的真实链路）；② 本机安装的 `qq-music-api@3.3.2` 的 dist 源码；③ Folia（`chthollyphile/folia-major`）的 QQ provider 一手源码。

## 1. 铁证：二维码为什么「一直过期」

`%APPDATA%\twilight-echo-app\login-diag.log` 里这一轮的真实记录：

```
qr.poll code=802 detail="QR code scanned"            ← 手机已经扫了、也确认了
qr.poll code=800 detail="This account has reached its login device limit.
                    Remove an old device in the QQ Music app, then try again."
             failureStage=credential-validation upstreamCode=1000 retryAfterMs=15000
```

**这不是二维码过期，是 QQ 音乐拒绝了这次登录：账号的登录设备数已达上限（上游码 20279）。**
软件没有任何办法绕过设备上限 —— 必须由用户在手机 QQ 音乐里移除一台旧设备。
Folia 对这件事有专门判定（`qqProvider.ts` 的 `QQ_DEVICE_LIMIT_UPSTREAM_CODE = 20279`），
并且在登录窗口里给出「去删旧设备」的操作指引，而不是让用户反复重新获取。

紧跟着的 429（`local-backoff`, retryAfterMs=15000）是后端对「登录太频繁」的退避；
我们旧代码把**任意 429 当成风控**、拉黑整个平台 10 分钟 —— 于是「登录失败」连锁成
「搜索/歌单/歌曲全都取不到」。本轮已改成：登录路径的 429 只提示等待秒数，不拉黑平台。

## 2. 铁证：网页登录为什么「服务端不认」

同一份日志里网页登录抓到的 cookie 名字是：

```
psrf_qqunionid, wxuin, qqmusic_key, qm_keyst, wxopenid, wxrefresh_token
```

这是**微信账号**在 y.qq.com 的浏览器凭证。而 qq-music-api 3.3.x 的鉴权是**不透明会话 token**：
只有扫码 803 才会发 `qqmusic_session=<token>`；它的 `getAuthToken()` 只认
`X-QQ-Session` 头 / `?cookie=` / Koa cookie 里的 `qqmusic_session`，**不解析 QQ 浏览器凭证**。
Folia 对 QQ 也只做扫码登录，没有网页 Cookie 登录这条路径。

## 3. 和 Folia 对齐后改了什么

| 位置 | 改动 | 依据 |
|---|---|---|
| 会话传输 | QQ 请求同时带 `X-QQ-Session: <裸 token>`（原来只带 Cookie 头） | Folia `qqTransport.ts`：header 收裸 token、`?cookie=` 收整串；Electron 用后者，Node 用 header 都行 |
| 网页登录 | QQ 移除入口并明确报错说明；只有网易云保留网页登录 | Folia 没有 QQ 网页登录；后端不解析浏览器凭证 |
| 429 | 登录路径的 429 → 「等 N 秒」，不再 block 平台 10 分钟 | qq-music-api `local-backoff` 语义 |
| 设备上限 | 800 的 `failureHint` 转成中文 + 明确操作 | Folia `QQ_DEVICE_LIMIT_UPSTREAM_CODE=20279` |
| 我喜欢 | `/user/liked-songs?limit=&offset=` 分页拉取（最多 500 首） | Folia `loadRawLikedTracks` |
| 歌单曲目 | **匿名 `/getSongListDetail/:disstid` 优先**；读不到（无 dissname）再回落 `/user/playlist-detail?tid=` | Folia：收藏歌单走带凭据路由会少付费歌；不公开自建歌单只能走带凭据 |

顺带：`mapSongListDetail` 用 **dissname 是否存在**区分「读不到」与「空歌单」——
上游对不公开歌单照样回 code 0，只是 cdlist[0] 没有名字（Folia 2026-09-11 真实账号实测）。

## 4. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（node+web） | exit 0 |
| `pnpm test:app` | 全绿（新增 4 条：token 解析 / 路由与分页 / dissname 判定 / 自建歌单形状） |
| `pnpm test:electron` | **201 / 201，0 fail** |
| tokens / css | 0 violations / balanced |

## 5. 仍需用户做的一步（软件无法替代）

**手机 QQ 音乐 → 设置 → 设备管理 → 移除一台旧设备**，然后再扫码。
在设备数降下来之前，扫码会稳定停在「登录设备数已达上限」，这不是二维码问题。

## 6. 拿到登录之后要一起验的

我的歌单、我喜欢、收藏歌单曲目、歌曲播放（`/getMusicPlay/{songmid}` 带 token 才有完整地址）。
如果其中任何一项仍为空，新一版 `login-diag.log` 会记下具体路由与 HTTP 状态，可继续定位。