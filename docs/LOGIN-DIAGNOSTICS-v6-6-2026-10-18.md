# 登录系统性排查：v6.6（2026-10-18）

> 用户反馈「依旧无法登录，说服务端不认；扫码的二维码依旧过期」。这一轮做三件事：
> 1) 修掉两个**确定**的客户端缺陷；2) 加**可落盘的登录诊断日志**；3) 把扫码通道在过期态也暴露出来。

## 1. 已确认的客户端缺陷（本轮修复）

### 1.1 网页登录「服务端不认」

上一版把 `p_skey` 当成会话键。`ptlogin2.qq.com` 在 **QQ 登录成功的瞬间**就下发 `p_skey`，
而这时窗口还没完成 y.qq.com 的授权跳转、音乐站会话（`qqmusic_key/qm_keyst/musickey`）还没建立 ——
于是我们**提前 1 秒关窗**，抓到的是一份没有音乐会话的 cookie，服务端当然不认。

现在：
- 只认 `qqmusic_key / qm_keyst / musickey`（不再有 `p_skey`、`uin`、`p_uin`）；
- **只保留平台域**（y.qq.com/qq.com；网易云 163/126）下的 cookie，按服务端需要的名字挑，同名留更长值；
- 检测到会话键后**再等 800ms 重读一次**：登录 cookie 是分几拍写的，立刻读会拿到「有 key 缺 uin」的半套。

### 1.2 扫码一直「过期」

- 通道选择器之前只在「等待」状态显示，**过期卡片上没有通道按钮** → 用户只能反复重新获取同一个错的通道。
  现在过期/出错时也显示「手机 QQ / 微信 / QQ 音乐 App」，并说明三种二维码不通用。
- 二维码约 3 分钟有效；三种码分别对应三个 App，扫错 App 的唯一表现就是「过期」。

### 1.3 顺带修复的测试脆弱点

`engine-host.test.mjs` 的 disconnect 计数断言：等 1500ms 会跨过引擎自动重启退避（1200ms），
机器快的时候会拉起下一代引擎再死一次 → 合法地变成 2 条。改成「等到第一次上报就立刻关停」，确定性。

## 2. 新增：登录诊断日志（v6.6 的重点）

打包后的应用没有控制台，这是这轮卡住的根本原因。现在主进程会把登录全链路写到：

```
%APPDATA%\twilight-echo-app\login-diag.log
```

记录内容（**只记名字/长度/code，绝不记 cookie/token 值**）：

| 事件 | 内容 |
|---|---|
| `qr.start` / `qr.start.ok` | 平台、请求通道、服务端支持通道、key 长度、图片长度、服务端状态与最近 6 行日志 |
| `qr.poll`（仅非 801） | 上游 code（800/802/803）、`failureReason/failureHint` 原文、服务端状态与日志尾 |
| `account.verify` | cookie 名字与长度、`/login/status` 的 data 键、是否带 profile |
| `web.capture` / `web.accept` / `web.normalized` | 抓到的 cookie 名字、域名过滤后的最终名字与长度 |
| `http.error` / `http.status` | 登录路径的失败/非 2xx 响应（脱敏后正文前 300 字） |

日志上限 256KB，超了轮转一份 `.1`；写失败不影响登录。

## 3. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test:app` | **467 / 467**（新增 cookie 过滤/去重、p_skey 非会话键两条） |
| `check:tokens` / `check:css` | 0 / balanced |
| e2e | 见安装包同批验证 |

## 4. 下一步（需要用户复现一次）

1. 安装 0.3.8 并**完整退出旧实例**；
2. 复现一次失败（扫码或网页登录，任选；扫码建议先切到对应通道）；
3. 把 `%APPDATA%\twilight-echo-app\login-diag.log` 交给 Lead —— 里面能直接看出：
   - 二维码轮询到底拿到 800 还是 803；800 时上游 `failureReason` 是什么（MQTT 断开？会话丢失？）；
   - cookie 抓到哪些名字、服务端 `/login/status` 返回了什么形状；
   - QQ 服务端进程有没有重启/崩溃（服务端日志尾）。