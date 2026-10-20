# 发现页接入 QQ 音乐（v6.3，2026-10-18）

> **状态**：现行 · **日期**：2026-10-18 · **给谁**：owner / 下一轮接手者
> **上位**：`docs/HIFI-KEEPALIVE-v6-2026-10-18.md`、`docs/EQ-CONSOLE-v6-2-2026-10-18.md`
> 用户：「发现页面不只是网易云，还有 QQ 音乐的也要」。
> 本轮把发现页从「只接网易云」改成**两个平台可切换**，数据/缓存/登录态全部按平台隔离。

## 1. 上游依据（不是猜的）

QQ 侧读的是 `@yakult-green-tea/qq-music-api` 3.3.x 的公开路由（`src/routes/router.ts` 与
`docs/README.md`），每个区块都对应一条真实存在的路由：

| 发现页区块 | 网易云（原有） | QQ 音乐（本轮） | 登录要求 |
|---|---|---|---|
| 每日推荐 / 每日 30 首 | `/recommend/songs` | `/user/daily-songs` | 需登录；未登录**不发请求**，给登录引导 |
| 私人漫游 / 刷歌雷达 | `/personal/fm/mode` → `/personal_fm` | `/recommend/radar?page=` | 公开（登录后更贴合口味），一页约 10 首 |
| 排行榜 | `/toplist/detail` | `/recommend/toplists`（`groups[].toplists[]`） | 公开 |
| 推荐歌单 | `/recommend/resource`（需登录） | `/recommend/playlists?limit=30` | 公开 |
| 榜单详情 | `/playlist/track/all?id=` | `/recommend/toplist?id=&limit=` | 公开 |
| 歌单详情 | `/playlist/track/all?id=` | `/getSongListDetail/:disstid` | 公开；官方歌单匿名不可读时回 `code:10` → 明确提示登录 |

QQ 的「私人漫游」在客户端叫**刷歌模式（雷达）**，所以区块标题在 QQ 平台下显示「刷歌雷达」；
这不是换个名字装同一条端点，是真的换了上游。

## 2. 架构：平台参数一路传到底

```
Discover.tsx（平台切换 UI + 按平台缓存）
  → preload discoverHome(platform) / discoverToplist(platform,id) / …
    → main/index.ts：平台值收敛成 netease|qq（非法值抛中文错误）
      → StreamingManager.discover*(platform, …)
        → DiscoveryCore.home(platform) / tracksFor(platform,…) / playlistSquare(platform,…)
          → deps.send(platform, path) —— 仍走该平台自己的节流/熔断桶
```

关键点：

- `DiscoveryCore.deps` 从 `scope()/send(path)/signedIn()` 变成带平台参数的三件套；
- **缓存键带平台**（`platform|scope|key`），两个平台的同名区块不会互相命中；
- 登出仍清全部缓存（`reset()`）；界面切平台时不再整页闪骨架：60 秒内看过的平台直接摆缓存；
- QQ 的推荐歌单是单条流（上游 `HasMore` 语义不完整），所以 QQ 下**隐藏分类/排序/加载更多**，
  并如实标注「QQ 音乐只提供一条推荐歌单流（不分页）」，不假装能翻页。

## 3. 界面

- Hero 增加分段控件「网易云 / QQ 音乐」（`aria-pressed` 表达当前平台），选择记在
  `localStorage: stringmoon.discover-platform`；
- 平台切换后：登录态 chip 变成「QQ 音乐 · 已登录 / 未登录」，区块标题跟着换
  （每日 30 首、刷歌雷达、推荐歌单）；
- 未登录时每日 30 首显示「登录后即可看到每日 30 首。在「设置 → 账号」里扫码登录 QQ 音乐」；
- 四个区块仍各自降级：任一平台的服务端没起/某端点上头，只影响那一块。

## 4. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（node + web） | exit 0 |
| `pnpm check:tokens` / `check:css` | 0 violations / balanced |
| `pnpm test:app`（单测） | **464 / 464**（新增 6 条：QQ 曲目/榜单/歌单/详情映射、QQ 首屏未登录降级、**双平台缓存不串台**） |
| `pnpm test:electron` | **198 / 198，0 fail**（新增 7 条：平台切换控件、切到 QQ 后公共区块渲染、刷歌雷达匿名可读、分类 chips 隐藏、每日 30 首登录引导、QQ 榜单详情走通、切回网易云恢复分类） |
| 截图证据 | `.smoke/qa/discover-qq-1280.png` |

## 5. 涉及文件

```
app/src/shared/discover.ts                         DiscoverPlatform = 'netease' | 'qq'
app/src/main/streaming/discovery.ts                QQ paths + 6 个 QQ 映射器 + 平台化内核
app/src/main/streaming/manager.ts                  discover*(platform, …) + discoverPlatformOf
app/src/main/index.ts                              IPC 平台参数消毒
app/src/preload/index.ts / index.d.ts              桥签名
app/src/renderer/src/views/Discover.tsx            平台切换 + 标签 + 按平台缓存
app/src/renderer/src/styles/discover.css           .discover-platform-switch/.discover-platform-tab
app/tools/mock-streaming-server.mjs                QQ 形状的 /recommend/*、/getSongListDetail/*
app/tools/discover-provider.test.mjs               QQ 映射与双平台缓存测试
app/tools/test-electron.cjs                        QQ 发现页 e2e（并启用 QQ mock server）
```

## 6. 诚实边界

- QQ 每日 30 首**必须登录**；未登录时这一块只给登录引导，不发请求（省风控额度）。
- QQ 没有分类广场：不提供「华语/欧美」这类网易云分类，也不提供翻页；
- QQ 歌单详情对「官方算法歌单」匿名会回 `code:10`，这时提示登录而不是显示空歌单；
- 封面来自 `y.gtimg.cn`（T002 专辑图），e2e 用 mock mid 拼出的地址在离线环境不会真的加载，
  卡片仍按无封面渲染；真实服务端会给真实 mid。
- 账号保活（v6）的 `verifySessions` 按平台分别探测，本轮没有改它的语义。