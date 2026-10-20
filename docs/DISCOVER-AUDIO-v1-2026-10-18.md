# DISCOVER-AUDIO-v1 · 「发现」页 + 专业音频/解码移植（2026-10-18）

> **状态**：已实施（自动化验证全绿；真机听感与真实上游联调待人工） · **日期**：2026-10-18 · **给**：owner / 后续接手者
> **上位**：[CONTRACT.md](../CONTRACT.md)（冻结，只读）、[contract-requests.md](contract-requests.md)（本轮新增 CR-031/CR-032）
> 解决什么问题：把上游 [Twilight Echo](https://github.com/Px-asen/Twilight_Echo)（Apache-2.0）的「音乐主页/发现」与「专业音频/解码」能力，以**不照搬实现、只复刻事实**的方式移植进 Stringmoon，并做成菜单栏一级入口。

---

## 0. 结论速览

| 需求 | 交付 | 证据 |
|---|---|---|
| 音乐主页功能 → 菜单栏「发现」 | 一级菜单第 2 项（home 之后），四区块（每日推荐/私人漫游/排行榜/发现歌单）+ 榜单详情抽屉 + 未登录诚实降级 | e2e 10 条断言；`views/Discover.tsx` |
| 专业音频与控制 | 「音效」页升级为**音频控制中心**四 tab：均衡 / 声场与空间 / 输出与解码 / 限幅与响度 | `components/AudioControlCenter.tsx`；e2e 9 条 |
| 专业解码 | 新增 **Media Foundation 系统解码兜底**（WMA/AC-3/AAC 等）+ **DSD（DSF/DFF）** 解到 176.4k PCM + 能力矩阵命令 | 引擎 `--probe-decode`/`--probe-format`；能力矩阵见 §4 |
| 高效方式实现 | 零新增第三方依赖、零新进程；MF 复用微软自带解码链；DSD 自写 4 级半带抽取（不引 libdsd/FFmpeg）；发现页复用既有节流/熔断/缓存 | §3、§4、§5 |

---

## 1. 上游调研（可复现）

- 上游仓库：`https://github.com/Px-asen/Twilight_Echo`（原 `asenyarzc-cpu/Twilight_Echo`），v1.3.1，**Apache-2.0**。
- 本机快照：`<本地工作区>\.scratch\twilight-echo-ref\Twilight_Echo-main`（`codeload` zip，28.4 MB）。
- 侦察报告：`UPSTREAM-AUDIT.md`（378 行，全 file:line）与 `OWN-AUDIT.md`（自有项目现状，347 行）。
  ⚠ 这两份位于本机 `.scratch/discover-port/`，属内部工作记录，**未随公开仓库发布**（`.scratch/` 在 `.gitignore` 内）。
- **事实与实现分离**：只复刻「接口形状 / 参数范围 / 判据 / 交互模型」；**不复制**其 Vue/C++ 代码。
  许可边界：其 `audio-engine/` 内 vendored `dstdec` 是 LGPL-2.1+（上游自注未 relicense），本轮**完全未使用**；
  未使用其字体/图标/截图。

### 1.1 上游发现页的真实形状（避免误判）

- 区块不是写死的：provider 用 `ui.streamingSections` 声明（`ncm-provider/index.mjs:77-81`），页面按能力过滤后取前 3。
- 上游**没有**独立「新歌」与「推荐 MV」区块；「新歌」只是排行榜的一条（id 3779629）。
- 降级是四层：provider 内吞 → 页面 `Promise.allSettled` 逐 section → 路由层按 method 分档超时 → 统一 friendly error。
  本轮**只复刻前两层**（我方没有插件路由层，超时统一在主进程 HTTP 层）。
- 取链是**质量降级阶梯 + 20 min TTL + 风控立即终止**；封面走 token 化 URL。本轮发现页只消费我方已有的取链/封面通道。

---

## 2. 「发现」页（应用侧）

### 2.1 数据契约（`app/src/shared/discover.ts`，新建）

```ts
DiscoverHome = { platform:'netease'; signedIn:boolean; sections:{ daily, fm, toplists, playlists }; notice:string|null }
DiscoverSection<T> = { items:T[]; error:string|null; needsLogin:boolean; updatedAt:number }
DiscoverPlaylistsPage = { items; hasMore; total; error }
AudioCapabilities = { formats: AudioFormatCapability[]; dsd: DsdCapability; engine: unknown }
```

**每个区块自带 error / needsLogin**，不让整页抛错：一屏四区块来自四个端点，一个失败不该打掉另外三个，
也避免「整页重试」把上游风控额度再花一遍（CONTRACT §5）。

### 2.2 主进程 provider（`app/src/main/streaming/discovery.ts`，新建 + `manager.ts` 扩展）

| 能力 | 上游端点 | 登录 | 缓存 |
|---|---|---|---|
| 每日推荐 | `GET /recommend/songs` → `data.dailySongs[]` | 需要 | 10 min |
| 私人漫游 | `GET /personal/fm/mode` 失败回退 `/personal_fm` | 需要 | 10 min |
| 排行榜 | `GET /toplist/detail` → `list[]` | 免登录 | 5 min |
| 推荐歌单 | `GET /recommend/resource` | 需要 | 5 min |
| 发现歌单广场 | `GET /top/playlist?cat&order&offset` | 免登录 | 5 min（按 cat/order/page 分键） |
| 榜单/歌单曲目 | `GET /playlist/track/all` | 免登录 | 10 min |

- **未登录硬短路**：`daily/fm/推荐歌单` 三个 section 直接返回 `needsLogin:true` 且**一个请求都不发**。
  单测用真实 `StreamingManager` + fetch 桩断言「未登录时请求清单严格等于 `['/toplist/detail']`」。
- 复用既有 `ensureStarted/base()/json()`（同平台 ≥1 s 串行节流 + 429/403/418/-460 熔断），**没有第二套 HTTP 或节流**。
- 登出/换账号清缓存（`cookieScope` 隔离，防止 A 账号的推荐串到 B 账号）。
- **无轮询、无后台预热**：只有渲染层显式调用才发请求（CONTRACT §5 硬要求）。

### 2.3 渲染层（`app/src/renderer/src/views/Discover.tsx` + `styles/discover.css`，新建）

- 布局**横向铺满**（用户明确要求）：`.discover-page` 无 `max-width`；卡片行 `repeat(6,minmax(0,1fr))`，
  1500/1180/860/620 逐级降 5/4/3/2 列。
- 交互反馈：每区块独立骨架屏 / 空态 / 错误行（带「重试」，只重试该区块）；
  可见反馈条 `.discover-notice[data-tone]`（播放失败/入队/刷新失败），并剥掉 Electron IPC 包装前缀；
  读屏用 `.sr-only[role=status]`；`prefers-reduced-motion` 下不动画。
- 详情抽屉：榜单/歌单点开列出曲目，可「播放全部 / 播放在线列表 / 单曲播放」。
- **在线曲目不进本地队列**（有意为之，见 §6.1）：`online:` 前缀不被引擎 `set_queue` 接受，
  塞进去会让队列高亮与下一首错位；因此用页内「在线播放列表」，文案也如实写「在线」而不是「队列」。
- 首屏请求串行（先公共歌单、后 home）：主进程同源 ≥1 s 串行节流，串行让首屏状态可预测，不改变功能。

### 2.4 集成点（`App.tsx`）

- `view` 联合加 `'discover'`；导航数组在 `home` 之后插入 `{id:'discover', label:'发现', icon: Sparkles}`；
  view-layer 增加分支；注释「固定 7 项」改 8 项。
- 「音效」页改为 `<div className="sound-page"><AudioControlCenter /></div>`（保留 `.sound-page` 壳给既有 e2e）。

---

## 3. 音频控制中心（`AudioControlCenter.tsx` + `audio-console.css` + `audioPreferences.ts` 扩展）

四个 tab，全部「请求值 vs 引擎实际值」分离显示，150–200 ms 防抖，`aria-live` 反馈（应用/已生效/未生效）。

| Tab | 内容 | 关键点 |
|---|---|---|
| 均衡 | 原 `FrequencyPanel`（compact=false）原样挂载 | 十段参数 EQ + IR + 频响 |
| 声场与空间 | balance / swapChannels / 整声道增益 / mid-side / 交叉馈送；空间音频 mode/amount/**azimuth**/**ITD** | 补齐 OWN-AUDIT 表 A 的 A1/A2/A5/A6/A7 |
| 输出与解码 | 输出模式 / 采样率 / 延迟档位 / fadeMs / pauseHold / **设备选择** / **解码能力矩阵** / bit-perfect chips | 补齐 A3/A4；能力矩阵按 `get_capabilities` 真实回包，`available:false` 置灰并标「本机不可用」；引擎未上报时退回静态说明并显式标注 |
| 限幅与响度 | 限幅器开关/ceiling/release/lookahead、true-peak 与 gain reduction 读数、ReplayGain off/track/album + 扫描 | CR-031；引擎回 `state.dsp.limiter` 时控件才可用 |

**不做假的取舍**：Short-term / 整段 LRA 不在 meter 事件里（引擎只发 Momentary），面板直写原因并留空，
不拿 Momentary 冒充 LRA。

---

## 4. 引擎侧：系统解码兜底 + DSD + 能力矩阵 + 可控限幅器

### 4.1 新增文件

| 文件 | 作用 |
|---|---|
| `engine/src/mf_source.cpp/.hpp` | 通用 `IMFSourceReader` 源（把原 `mp4_source` 的实现单一化）+ 能力矩阵 `decoderCapabilities()` |
| `engine/src/dsd_source.cpp/.hpp` | DSF(L回流)/DFF 解析 + 4 级半带抽取（DSD64→176400 Hz PCM），`DsdDecimator` 可单测 |

### 4.2 能力矩阵（`--probe-decode` 实测，11:56 exe）

```
.flac .wav .mp3 .ogg .oga .m4a   native   available=yes
.wma .ac3 .aac                  system   available=yes
.opus .aif .aiff                system   available=NO
.dsf .dff                       dsd      available=yes   (lossless)
system decoder runtime (Media Foundation): started
```

- `available` 的判据是**两个条件同时成立**：ByteStreamHandlers **子键**存在 + 解码器 MFT 存在。
  （踩过的坑：最初用 `RegQueryValueExW` 查值 → 恒 false → 系统解码"真能用却报不可用"。已修，verifier 复现并复核。）
- 本机 Opus MFT 存在但**.opus/.ogg 的 byte-stream handler 子键不存在** → 如实报 `available:false`，不谎报。
- MF **只在原生解码失败后兜底**，且只接本地文件（HTTP 流仍走既有 `MediaReader`，避免第二套传输层）。
- 原生路径零回归：FLAC 文件句柄 vs 内存路径 **PASS 156556 frames**；WAV/MP3/Ogg 抽检 ok=1。

### 4.3 DSD

- DSF(L回流)/DFF 头解析 → 1-bit 流 → 4 级半带抽取 → **176400 Hz / 24 bit PCM**，如实标 `lossless`。
- `state.source = {format:'dsd', dsdRate, decimationPcmRate}`；`state.sampleRate/sourceSampleRate` 仍报抽取后 PCM 率，
  **既有重采样 / bit-perfect / 独占协商逻辑一行不改**。
- 实测（fixtures，`<仓库根>\.smoke\verify4\dsd-fixtures`）：

  | 素材 | peak | outOfRange | frames |
  |---|---|---|---|
  | dc.dsf（满幅直流） | 1.000000 | **0** | 176144 |
  | nyquist.dsf（交替位） | 0.000001 | 0 | 176144 |
  | dc.dff | 1.000000 | 0 | 176146 |
  | nyquist.dff | 0.000001 | 0 | — |
  | taglib empty10ms.dsf/.dff | — | — | 1508（ok=1） |

- **抽头设计事故与修正**：第一版半带写成 `sinc(n/2)/2` → `H(π/2)/H(0)=0.6667`（应为 0.5），
  4 级级联 Nyquist 抑制只有 −9.5 dB（应为 −124.6 dB），等于没滤波；已被 verifier 复算抓出并修正。
  **selftest 判据也换掉了**：decimation by 2 后输入域 fs/4 落在输出域 Nyquist，峰值法退化（实测 0 而不是 0.5），
  改用 `DsdDecimator::testHalfBandMagnitude(π/2) = 0.5 ± 1e-6` + 0.6π 阻带 < −60 dB + DC 稳态 = 1 + 越界检查。
- 边界：**DST 压缩的 DFF 不解**（如实拒绝）；48 kHz 家族 DSD（3.072 MHz）不解（出口率不整除 176400，如实拒绝）；
  不做 DoP / 原生 DSD 输出（`dsd.output` 固定 `'pcm'`）。

### 4.4 CR-031 可控限幅器

- `set_limiter{enabled, ceilingDb, releaseMs, lookaheadMs}` → `state.dsp.limiter{enabled, ceilingDb, releaseMs, lookaheadMs, latencyFrames, truePeakActive, gainReductionDb}`。
- **默认等价（结构性证明三层）**：① lookaheadMs=0 走 else 分支 = 改动前那 4 行原封不动；
  ② ceiling 常数 `pow(10,-0.1/20)` 与旧 `0.9885531f` **bit-identical**（`0x3f7d11d1`）；
  ③ release 系数形式未变（60 ms 一阶）。
- 越界拒绝而非 clamp（ceilingDb ∈ [−12,0]、releaseMs ∈ [5,1000]、lookaheadMs ∈ [0,20]）。
- 实测往返：`ceilingDb:-3, releaseMs:120, lookaheadMs:5` → 回读一致，`latencyFrames=240`（5 ms×48 k）；`ceilingDb:-40` → ERR_STATE。

---

## 5. 为什么是「最高效的方式」（对照上游）

| 上游做法 | 我方做法 | 代价对比 |
|---|---|---|
| FFmpeg 编进引擎（vcpkg，LGPL/GPL 随 configure） | 复用 **Windows 自带 Media Foundation**（WMA/AC-3/AAC/ALAC）+ 既有 dr_libs/stb_vorbis | 零新增依赖、安装包不增大；口径如实（本机没有的解码器报 false） |
| DSD 走 FFmpeg + 自研 SACD/DST + 原生 DSD/DoP 输出链（数千行 + ASIO） | 自写 DSF/DFF reader + 4 级半带抽取到 PCM（~600 行） | 不引 FFmpeg/vcpkg/MinGW；不做 DoP（收益低、风险高） |
| 17 节点可配置 DSP 图 + DSP revision ACK | 固定链 + 本轮补的可控限幅器 | 固定链已覆盖真实需求，图化是体系级改造（明确不追） |
| 插件系统 / VST3 宿主 / 独立 helper 进程 | 不做 | 收益/成本比最差 |
| provider 声明式区块 + allSettled 降级 | 复刻同一模型（主进程 side） | 纯 TS，成本极低 |
| 令牌桶 + 读重试 + 风控短路 | 复用我方既有节流/熔断（同源 ≥1 s + 429/403/418/-460 封停 10 min） | 没有再写一套 |

---

## 6. 明确的取舍与偏离（写在这里免得下一个人误判）

1. **在线曲目不进引擎队列**：`online:` 前缀 trackId 不参与任何引擎命令（`store.ts` 注释即为约束）。
   塞进 `set_queue` 会让 `queueIndex`/下一首错位。故用页内「在线播放列表」，UI 文案不含「队列」。
2. **发现页只接网易云**：`DiscoverHome.platform` 写成字面量 `'netease'`，接第二个平台是一次显式变更。
3. **不做 `/top/playlist/highquality` 游标与歌单分类全量列表**：分类 chips 直接走 `/top/playlist` 的 `cat` 参数。
4. **不做上游的封面 token 化重写**：我方已有回环代理与 CSP `img-src https:`，本轮发现页直接消费平台封面 URL。
5. **版本号 0.2.0 → 0.3.0**：本轮发布准备（Lead 决定），非功能变更。

---

## 7. 验证（自动化全绿）

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（node+web） | exit 0 |
| `pnpm check:tokens` | 0 violations |
| `pnpm check:css` | braces balanced |
| `pnpm test:app` | **449 / 449 pass** |
| `pnpm build` | exit 0（main 474 KB / preload 12.2 KB / renderer 2.79 MB） |
| `pnpm test:electron`（真 Electron e2e） | **172 / 172 pass，0 fail**（Lead 与独立验证者各跑绿；两次假红均为并发/文件并发修改导致，已记录） |
| 引擎 `--selftest` | all checks passed（含 DSD 4 条 + CR-031 4 条） |
| 引擎 `test-playback-silent` | PASS 76 assertions / 3 source rates |
| 引擎 `--probe-decode` / `--probe-format` | 能力矩阵与 DSD 素材逐条符合预期 |

**测试纪律**：本轮全程未运行会出声的测试（`test:player/listening/integration/soak/drive`）。
**布局几何断言（横向铺满，用户明确要求）**：音频控制中心在 1280×800 下
`AUDIO_GEOMETRY {"consoleWidth":1031,"gridWidth":1031,"mainWidth":1105,"columns":3,"rightGap":42}`
—— 音频栅格宽 ≥ 主区域 85%、列数 ≥ 2（截图见 `.smoke/qa/audio-console-output-1280.png`、`.smoke/qa/discover-guest-1280.png`）。

e2e 新增/加固的断言：导航 8 项与顺序、发现页四区块顺序 + hero + 刷新、未登录 toplists≥4/playlists≥6、
daily+fm 空态含「登录」、榜单详情抽屉开合、音频中心四 tab 顺序与默认 eq、解码矩阵 kind 合法、
limiter 判据挂在 `get_state.dsp.limiter` 上、队列删除「标题出现次数减一」、发现页两区块各自 waitFor、
`run()` 失败打印失败表达式、`ensureSignalPopover()` 4 次重试 + DOM 双判据（修掉一处真实 flaky）。

---

## 8. 交付物

- 安装包：`app/release/Stringmoon-Setup-0.3.0.exe`（117,279,468 B；根目录也放了一份 `<仓库根>\Stringmoon-Setup-0.3.0.exe`）
  sha256 `c7596fc9c361cb8945b4fd78180333136612da4f4be8caa2a2ced3bd92aebb65`
  （包内 `app.asar` 的 main/renderer 与 `out/` 当前构建逐字节一致、包内引擎与 `engine/bin` 逐字节一致，已核）
- 随包引擎：`resources/engine/bin/twilight-engine.exe` sha256 `f0ed5d93…1741ec0`（与构建产物逐字节一致，已核）
- 更新清单：`app/release/latest.yml`（0.3.0）+ `.blockmap` + `SHA256SUMS.txt`
- 独立验证报告：`.smoke/verify4/VERIFICATION-REPORT.md`
- 侦察与计划：本机 `.scratch/discover-port/{PLAN,UPSTREAM-AUDIT,OWN-AUDIT}.md`（内部工作记录，未随公开仓库发布）

## 9. 待人工确认（自动化测不了）

1. **真实听感**：DSD（DSF/DFF）与 WMA/AAC 实际播出来是否正常；限幅器 ceiling/release/lookahead 调参听感；
   lookahead>0 引入的 5–20 ms 延迟是否能接受。
2. **真实网络**：发现页在真网易云服务端下的推荐/榜单/歌单是否顺畅（本轮 e2e 用 mock 服务端）；
   登录态下每日推荐/私人漫游的真实数据。
3. **真机 UI**：发现页在 91 首真实曲库 + 窄窗口下的手感；音频中心 4 个 tab 在 1280/1600 宽度下的布局。
4. **DST 压缩 DFF 与 48 kHz 家族 DSD** 目前如实拒绝 —— 若你有这类文件，需要另行排期。
