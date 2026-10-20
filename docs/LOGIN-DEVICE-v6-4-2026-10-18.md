# 登录修复 + 设备热插拔恢复（v6.4，2026-10-18）

> **状态**：登录部分已交付；设备部分引擎已修 + 自检绿，真机拔插待你验证；GD 音乐台部分待确认需求。
> **上位**：`docs/DISCOVER-QQ-v6-3-2026-10-18.md`、`docs/HIFI-KEEPALIVE-v6-2026-10-18.md`

## 1. 登录：网页登录为什么不行

`web-login.ts` 的白名单把**所有**请求都拦在平台域内：

```css
音乐.163.com 页面自身的 CSS/JS 在 s4.music.126.net（不在白名单）→ 页面残缺
y.qq.com 的静态资源在 *.gtimg.cn / *.qlogo.cn（不在白名单）→ 页面残缺
```

现在白名单只拦 **mainFrame 导航**（安全目标本来就是「别把窗口导航到第三方」），
子资源放行；cookie 仍只从一次性内存分区读，关窗 clearStorageData。
同时 QQ 的会话判定删掉了 `uin`（未登录访客也有 uin，旧逻辑会在 600ms 内关窗，
再报「服务端不认这个会话」），只认 `qqmusic_key / qm_keyst / musickey / p_skey`。

## 2. 登录：扫码为什么一直「二维码过期」

实测（对用户正在运行的网易云/QQ 服务端直接打接口）：

- `/login/qr/key` → `data.unikey`、`/login/qr/create` → `data.qrimg`、`/login/qr/check` → 801：
  **链路本身是通的**，二维码图片也能正常解出来；
- 真正的问题在通道与轮询方式：
  1. QQ 服务端支持 `qq`（手机 QQ）/`wechat`（微信）/`qqmusic`（QQ 音乐 App）三种通道，
     旧版固定 `qqmusic`，用手机 QQ 扫就永远不会有事件，3 分钟后必「过期」；
  2. UI 用固定 2s `setInterval` 轮询，而微信通道的 check 是**长轮询**（上游最多等 15s）：
     15s 内叠 7 个并发 check，上游会回 800；主进程 12s 超时又会先 abort；
  3. 800 回包里的 `failureReason/failureHint` 被丢掉，界面只能写「过期」，用户无法判断原因。

修复：

- `/login/channels` 读出可用通道，界面显示「手机 QQ / 微信 / QQ 音乐 App」可切换，默认手机 QQ；
- 轮询改成**串行**（上一次回来才排下一次），check 请求超时放宽到 25s；
- 过期时原样展示上游原因（`failureHint.message` / `failureReason`）；
- 非法通道回退默认值，不把任意字符串透传给服务端。

## 3. 设备热插拔（引擎）

用户：拔插 USB DAC / 切设备后扬声器与耳机都没声。根因（引擎 diag 日志 + stdin 探针复现）：

1. 拔掉后 `serviceDeviceChanges` 用**刚消失的 preferredDeviceId** 重开 → 必失败并关流；
2. 随后的默认端点变化因 `streamDevice` 已空被判 `streamLost=0`，不再重开；
3. 失败只写 `outputError_`，`degradeReason` 为空；
4. 流关闭后 `play()` 直接 `ERR_DEVICE`，没有恢复路径。

修复（`engine/src/player.cpp`、`engine/src/app.cpp`）：

- 打开失败时每个候选重试 2×120ms，并回退系统默认端点；
- 设备变化时若请求的正是刚失效端点，直接改用默认端点；
- 默认端点变化且输出流已丢失时也走 streamLost 恢复；
- `play()` 先尝试重建输出再报错；失败原因写进 `degradeReason`。

引擎重建：`engine/bin/twilight-engine.exe` 2,398,720 B，
sha256 `8fae1b701ed8f0df06fc8119125e0afbdb6328edba2df282f12a83ff4782b1ac`，`--selftest` 全绿。

## 4. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（node + web） | exit 0 |
| `pnpm check:tokens` / `check:css` | 0 violations / balanced |
| `pnpm test:app` | **465 / 465** |
| `pnpm test:electron` | **201 / 201，0 fail**（新增 3 条 QQ 三通道：默认手机QQ / 切微信 / 非法通道回退） |
| 引擎 `--selftest` | all checks passed |
| 静音播放回归 | 本机默认端点被用户正在运行的实例以独占方式占用，测试引擎无法打开默认端点，属环境限制；已改由引擎自检 + 静音探针覆盖（见交接） |

## 5. GD 音乐台（未定）

实测：`music-api.gdstudio.xyz` 的 `types=search`、`types=url` 均正常返回（FLAC/320k 直链），
本仓库 `manager.resolvePlay('gdstudio')` 也能取到可 206 播放的地址。
「无法播放」需要具体现场（哪个页面、什么报错）才能定位；「他那一套抓取和播放功能」
指的是上游 Twilight_Echo 的哪套实现也在侦察中。