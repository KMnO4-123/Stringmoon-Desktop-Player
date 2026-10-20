# Stringmoon

[English](README.md) · **中文**

**一个高性能的 Windows HiFi 音乐播放器：本地曲库 + 你自己的网易云 / QQ 音乐账号，配一台高性能的 C++20 音频引擎 Moonwave。**

WASAPI 独占直通 · 最高 384 kHz / 32 bit · bit-perfect · 十段参数均衡 · SoXR 重采样 · 卷积房间校正 · EBU R128 响度 · 设备热插拔恢复

> **旧名 Twilight Echo。** 更名只发生在品牌层（窗口标题、排印、图标）；目录名 `app/`、`engine/` 与协议里的标识符一律保持原样。
>
> **许可证：MIT**（见 [`LICENSE`](LICENSE)）。
>
> **这是一个个人自用 / 学习性质的项目。** 它不含、也不分发任何音乐内容；在线播放完全依赖你**自己的账号**与第三方非官方接口。动手之前请先读 [已知限制与诚实边界](#已知限制与诚实边界) 与 [免责声明](#免责声明)。

---

## 目录

[截图](#截图) · [这是什么](#这是什么) · [功能一览](#功能一览) · [架构](#架构) ·
[安装](#安装用现成安装包) · [从源码构建](#从源码构建) · [测试](#测试) ·
[已知限制](#已知限制与诚实边界) · [常见问题](#常见问题) · [目录结构](#目录结构) ·
[许可与致谢](#许可与致谢) · [免责声明](#免责声明)

---

## 截图

| | |
|---|---|
| ![我的曲库：左侧导航、曲目列表与歌单分栏、底部播放栏](docs/screenshots/main-library.png)<br><sub><b>我的曲库</b> —— 多曲库目录、歌单 / 艺术家分栏</sub> | ![发现页：每日推荐、刷歌雷达、排行榜](docs/screenshots/discover.png)<br><sub><b>发现</b> —— 未登录时如实降级，不假装有数据</sub> |
| ![十段参数均衡器：频响曲线与十路推子](docs/screenshots/audio-console-eq.png)<br><sub><b>音频控制中心 · 均衡</b> —— 频点 / 增益 / Q 均可单独调</sub> | ![设置 → 播放：输出模式与采样率档位](docs/screenshots/settings-output.png)<br><sub><b>设置 · 输出与规格</b> —— 模式、采样率与设备探测</sub> |
| ![沉浸播放：黑胶封面与逐字歌词](docs/screenshots/lyrics.png)<br><sub><b>沉浸播放</b> —— 黑胶封面与逐字歌词</sub> | 取自 **v0.4.0** 开发构建，合成测试曲库，不含个人路径或账号信息 |

> 每张对应的界面见 [`docs/screenshots/README.md`](docs/screenshots/README.md)；界面细节会随版本变化。

---

## 这是什么

Stringmoon 是一个**用来听自己音乐的桌面播放器**。它的两条主线：

1. **接自己的音乐平台账号**：网易云音乐、QQ 音乐，扫码登录后用你自己的会员/版权去取流，走本地回环代理交给引擎播放。
2. **把音频质量做到播放器该有的程度**：不是浏览器 `<audio>` 能做的事 —— WASAPI 独占直通、bit-perfect、参数均衡、响度归一、卷积校正、设备热插拔。

它**不是** foobar2000 / HQPlayer 的替代品，也不是通用播放器：不做社交、商店、下载器、DRM 解密、VST3 宿主、音乐地图。

分层的硬边界写在 [`CONTRACT.md`](CONTRACT.md)：**引擎是唯一的声音权威**（解码、DSP、WASAPI 输出、设备管理），应用负责界面、曲库与平台接入，两者之间只有 JSON Lines。

---

## 功能一览

### 本地曲库

| 能力 | 说明 |
|---|---|
| 多曲库目录 | 曲库目录是**一组**而不是一个，记在用户数据里，重启原样复现；某个目录不见了（拔盘/删目录）只提示哪几个不可用，不影响其它目录 |
| 扫描与标签 | 引擎用 TagLib 读标签与音频属性；容器按**内容**识别（魔数 / `ftyp` / `OggS` 页内编码标识），不按扩展名猜 |
| 音频格式 | **引擎内建解码**：FLAC、WAV、MP3、Ogg Vorbis、Ogg-FLAC（dr_libs / stb_vorbis）；**系统解码**：AAC / ALAC（`.m4a`，走 Windows Media Foundation）；**DSD**：DSF / DFF 抽取为 176.4 kHz / 24 bit PCM。`.opus` / `.wma` / `.ac3` / `.aif` 能否解取决于本机注册的 Media Foundation 组件，界面用能力矩阵如实显示「原生 / 系统解码 / 不支持」，而不是假装都能放 |
| 封面 | 嵌入图 → 同名图 → `cover/folder/front` → 字形封面；可自选封面，**移除只删映射，不动你的图片与音乐文件** |
| 标签编辑 | 可就地改标题 / 艺术家 / 专辑 / 流派 / 年份。修改只存进用户数据（`track-overrides.json`），**不改写你的音乐文件** |
| 歌单与视图 | 歌单、文件夹视图（层级 / 面包屑 / 整树入队）、播放队列（拖拽、上下移、删除、清空、5 种排序） |
| 歌词 | 本地 `.lrc` / `.ttml` / `.yrc`、内嵌歌词、在线取词；逐字、翻译、注音；可存回本地 |

### 在线平台

| 能力 | 说明 |
|---|---|
| 可选源 | **网易云音乐**、**QQ 音乐**、**通用源 Meting**（需 Docker 或自备兼容 Meting API 的服务端）、**GD 音乐台**（内置公共 HTTP 源，免登录） |
| 登录方式 | 扫码为主；**网易云另有网页登录**（主进程开窗口取 Cookie，凭据用 Electron `safeStorage`/DPAPI 加密落盘）。**QQ 只能扫码** —— 它的服务端不接受网页 Cookie 登录，界面里已去掉该入口 |
| 服务端形态 | 应用按需拉起**本地 API 服务端子进程**（动态端口、探活、崩溃退避重启），前端只访问 `127.0.0.1` |
| 发现页 | 网易云：每日推荐 / 私人漫游 / 排行榜 / 推荐歌单；QQ：每日 30 首 / 刷歌雷达 / 排行榜 / 推荐歌单。按平台切换，**未登录时如实降级**（不拉取、不假装有数据） |
| 全局搜索 | 跨本地与在线源统一搜索（含 GD 音乐台分组，第三方源不提供下载） |
| 下载 | 在线曲目可下载到本地并写标签（MP3 走 ID3v2）；第三方源（GD 音乐台）**不提供下载** |
| 账号保活 | 启动后约 8 s 首次校验、之后每 6 小时一次；网易云尽力自动续期，QQ 只校验并如实标「不支持续期」 |

> **GD 音乐台**是内置的第三方公共 HTTP 源（免登录取链），目前**已知有播放问题**，见 [已知限制](#已知限制与诚实边界)。

### 音频引擎 Moonwave

> 引擎的构建产物文件名保持 `twilight-engine.exe`（仓库历史命名，改了会牵动打包链路），**Moonwave 是它的名字与版本线**。

| 能力 | 说明 |
|---|---|
| 独立进程 | `twilight-engine.exe`（Moonwave），C++20 + CMake，与 Electron 只通过 stdin/stdout 的 JSON Lines 通信；音频样本**永不**穿过这条通道 |
| 输出模式 | WASAPI **独占**（按曲目原生采样率/位深直通）与**共享**，独占不可用时自动降级并在界面如实标注，不假装成功 |
| 采样率档位 | 跟随源 / 44.1 / 48 / 88.2 / 96 / 176.4 / 192 / 352.8 / 384 kHz。开发机实测：默认端点以独占 **384 kHz / 32 bit** 可真实打开（不同声卡上限不同，界面显示端点实测能力） |
| 重采样 | SoXR 0.1.3 流式重采样（设备采样率与源不同时进入链路，此时如实标记「已重采样」） |
| 均衡器 | **十段参数均衡**：31.25 / 62.5 / 125 / 250 / 500 / 1 k / 2 k / 4 k / 8 k / 16 k Hz 基准网格，RBJ 峰值默认、Q 0.5–4、±12 dB；每段可独立改频率 / Q / 类型（峰值 / 低架 / 高架）；支持 AutoEQ / Equalizer APO / CSV 曲线导入，内置 Harman 目标曲线拟合 |
| ReplayGain | EBU R128 响度扫描（整轨 + 专辑），track / album 模式、preamp、prevent-clip；结果有磁盘缓存 |
| 卷积校正 | 房间 / 耳机冲激响应，1024 帧均匀分区 overlap-add，任意块大小、播放中零分配，固定 1024 帧延迟 |
| 声场 | Bauer 式串音消除（crossfeed）、M/S 立体声加宽、24 方位解析 HRIR 的双耳虚拟环绕；另有平衡 / 单声道 / 交换 / 每声道增益 / 延迟等声道工具 |
| 去爆音 | 暂停 / 跳转 / 切歌的**淡出下限 15 ms**，淡出归零后再写 **15 ms 静音**、等设备真正排空才停流 |
| 设备热插拔 | 监听系统设备变更，拔插 USB DAC / 切换默认端点后自动回落到默认设备并重开流 |
| 限幅与计量 | 可控限幅器（ceiling / release / lookahead）、真峰值（TP）、频谱与电平表 |

### 界面与聆听

| 能力 | 说明 |
|---|---|
| 音乐空间 / 沉浸播放 | 黑胶唱片舞台、封面与歌词的沉浸布局、频谱光带 |
| 设计系统 | Nothing 的三通道状态编码（光 / 形 / 字）+ 液态玻璃材质；「系统」由 lint 强制（`check:tokens`），不靠自觉 |
| 启动续播 | 启动时回到上次播放的位置，**保持暂停、不自动出声**，可由设置关闭 |
| 托盘与单实例 | 系统托盘控制、单实例锁（第二次启动只唤起已有窗口） |

---

## 架构

三个 OS 进程（应用的两个进程 + Moonwave 引擎），两条进程边界（IPC 与 JSON Lines）：

```text
Electron 44 应用进程（app/）
├─ 渲染进程   React 19 + TypeScript
│              界面 · 歌词 · 频谱 · 状态编码
│              只经 preload 暴露的 contextBridge 与主进程通信
└─ 主进程     Node + TypeScript
               窗口 / 托盘 / 单实例 / 设置
               EngineHost          ── spawn 引擎、按自增 id 关联回复、超时显式失败
               StreamingManager    ── 按需拉起本地 API 服务端子进程（动态端口 + 探活）
               LoopbackMediaProxy  ── 把第三方直链包成 127.0.0.1/<token> 交给引擎

         │  stdin / stdout，一行一条 JSON（JSON Lines）        │  HTTP 127.0.0.1:<动态端口>
         ▼                                                    ▼
  twilight-engine.exe（Moonwave）                  本地 API 服务端子进程（可选）
  C++20 · 独立进程 · 唯一的声音权威                网易云 / QQ / Meting
  解码 → 重采样 → DSP → WASAPI 独占/共享
         │
         ▼
       声卡
```

### 引擎 ⇄ 应用：JSON Lines over stdio

协议冻结在 [`CONTRACT.md`](CONTRACT.md) §3。三条铁律：

1. **stdout 只允许出现 JSON Lines**（一行一条事件），任何日志都必须走 stderr —— 否则前端解析必崩；
2. **音频样本绝不穿过这条通道**，引擎直接对声卡输出，通道只传命令与状态；
3. 消息里的时间单位一律毫秒（整数），采样率 Hz，音量 0.0–1.0。

```jsonc
// stdin：命令流。每条带应用侧自增 id，回复必须带同一个 id
{"id":4,"cmd":"open","trackId":"tl_0001"}
{"id":5,"cmd":"play"}
{"id":12,"cmd":"set_output","mode":"exclusive","deviceId":"..."}

// stdout：事件流
{"ev":"ready","protocol":1,"version":"0.1.0","devices":[...]}
{"ev":"state","state":"playing","trackId":"tl_0001","outputMode":"exclusive",
 "sampleRate":384000,"bitDepth":32,"bitPerfect":true}
{"ev":"position","trackId":"tl_0001","positionMs":42000,"durationMs":213000}
```

**降级不是错误**：独占打不开时自动转共享，用 `state.outputMode` + `state.bitPerfect=false` 表达，不返回失败；只有两种模式都打不开设备才报 `ERR_DEVICE`。错误码共六个（`ERR_DEVICE` / `ERR_DECODE` / `ERR_NOTFOUND` / `ERR_STATE` / `ERR_UNSUPPORTED` / `ERR_INTERNAL`），全部冻结。

---

## 安装（用现成安装包）

不想自己编译的话：从**本仓库的 Releases 页面**（GitHub 仓库右侧「Releases」）下载 `Stringmoon-Setup-<版本>.exe`。

1. 双击安装包。如果 Windows 弹出「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」——
   **安装包未做代码签名**，这是预期行为，不是文件损坏。
2. 选择安装目录，一路下一步；装完从开始菜单启动 `Stringmoon`。
3. 本地播放：在「设置 → 本地曲库」添加音乐文件夹，等扫描完成即可播放。
4. 在线播放：在「设置 → 流媒体账户」里启动网易云 / QQ 音乐，然后扫码登录。
   安装包已内置运行环境（Node.js + 两个服务端），**目标机器不需要装 Node.js、npm 或 VC++ 运行库**。
   注意：**源码构建出来的包不含内置运行环境**，详见下一节。

数据目录是 `%APPDATA%\twilight-echo-app`（曲库索引、歌单、设置、登录态）；卸载默认保留，重装不丢。

---

## 从源码构建

**前置**：Windows 10/11 x64、Node.js ≥ 22.12、pnpm 11、CMake ≥ 3.25、MSVC（VS 2022 生成器或 Build Tools）。详细步骤、参数与踩坑见 [`docs/BUILD-FROM-SOURCE.md`](docs/BUILD-FROM-SOURCE.md)。

```powershell
# 1) 引擎（C++20）——第三方源码已随仓库提供，可离线构建
powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1
#    产物：engine/bin/twilight-engine.exe

# 2) 应用（Electron + React）
cd app
pnpm install
pnpm dev            # 开发模式；自动探测 engine/bin/twilight-engine.exe，缺失时用 mock 引擎（不发声）
pnpm build          # 产出 app/out/（main / preload / renderer）
pnpm dist           # 出 NSIS 安装包 → app/release/
```

- **引擎二进制不入库**：`engine/bin/` 是构建产物（`.gitignore` 里已排除）。新克隆的仓库必须先构建引擎，否则 `pnpm dev` 用的是 mock（不发声）、`pnpm dist` 出来的包也没有引擎。
- **第三方依赖已入库**：`engine/third_party/` 内含 TagLib 2.3.2、SoXR 0.1.3、dr_libs、stb_vorbis、kissfft、libebur128、utfcpp（724 个文件，7,522,241 字节 ≈ 7.2 MiB / 7.5 MB 十进制），因此**不需要联网**也能构建引擎。`engine/tools/fetch-deps.ps1` 只在你想重新拉取/升级依赖时才需要跑。
- **开发时换引擎**：设置环境变量 `TWILIGHT_ENGINE=<exe 路径>` 即可指定引擎；未设置时依次探测打包资源目录、`engine/bin/twilight-engine.exe`，最后回退到 mock 引擎（用于纯 UI 开发）。
- **安装包的内置运行环境（诚实说明）**：官方安装包内置了 Node.js 24 与两个平台服务端（`app/resources/runtime.zip`，解压后约 151 MB）。**该 zip 是官方打包时的一次性产物，仓库里不含生成脚本**；缺失时 electron-builder 只会打印 `file source doesn't exist` 告警并跳过该资源（**构建仍然成功**），安装包于是不含内置运行时 —— 在线功能需要你自己装 Node.js，并在「设置 → 流媒体账户」里填网易云 / QQ 两个 API 服务端的启动命令。详见 [`docs/BUILD-FROM-SOURCE.md`](docs/BUILD-FROM-SOURCE.md)。

---

## 测试

命令都在 `app/` 下执行（`pnpm <script>`）。下列结果为本仓库当前状态的实测值。

| 命令 | 做什么 | 当前结果 |
|---|---|---|
| `pnpm typecheck` | 主进程 + 渲染层双 tsconfig 类型检查 | exit 0 |
| `pnpm check:tokens` | 设计令牌零违规（棘轮基线） | 0 violations |
| `pnpm check:css` | CSS 括号/结构检查 | braces balanced |
| `pnpm test:app` | 单元测试（协议、曲库、歌词、EQ、播放记忆、更新器等） | **474 / 474 通过** |
| `pnpm test:protocol` | mock 引擎协议自测（CONTRACT §3 逐条断言） | 42 checks passed |
| `pnpm test:c2` | C2 状态编码断言 | 11 / 11 通过 |
| `pnpm test:electron` | 真实 Electron + 真实引擎端到端（含截图与布局断言） | 需独占音频设备、需先 `pnpm build` |
| `pnpm test:player` / `test:listening` / `test:startup` / `test:library` | Playwright 交互与像素验收 | 需先 build，且需要本地曲库 |
| `pnpm test:l2` | 回环代理 + 真引擎的集成验收（本地 HTTP 源，不联网） | 需 `engine/bin/twilight-engine.exe`，且**需要一个真实 FLAC 作参数**（见下） |

引擎侧自带诊断与自检：

```powershell
engine\bin\twilight-engine.exe --selftest        # 离线黄金测试（EQ 频响 / dither / 响度 / 声道），不碰声卡
node engine\tools\drive.mjs --list                # 列出 23 个端到端步骤
node engine\tools\drive.mjs --step=dsp            # EQ / ReplayGain / bit-perfect 诚实性
engine\bin\twilight-engine.exe --probe-format <file>   # 这个文件到底能不能播、为什么不能
```

> ⚠️ 部分测试会**真的出声**（`test:integration`、`drive.mjs` 的播放步骤），并且 e2e 会争用独占音频设备。**不要同时跑多个测试套件**，也不要在正在播放音乐时跑 e2e。
>
> `pnpm test:l2` 需要把一个真实 FLAC 作为参数传给底层脚本：
> `node tools/test-l2-integration.mjs <path-to-some.flac>`。不带参数会直接抛 `usage` 错误（这是设计如此，不是坏掉）。

---

## 已知限制与诚实边界

这些是**已知且暂时接受**的限制，写在这里而不是等你踩到：

1. **安装包未签名**。Windows SmartScreen 会提示「未知发布者」，需点「更多信息 → 仍要运行」。这是当前版本的正常现象，不是下载损坏。
2. **在线接口全是非官方的**。网易云 / QQ 的接口由社区服务端提供，**随时可能限流、改协议或失效**；发现页与搜索会因此偶发空结果。请只用自己的账号，自行承担平台条款与版权责任。
3. **QQ 音乐登录有设备数上限**（上游码 `20279`）。提示「登录设备数已达上限」时，需要你在手机 QQ 音乐里移除一台旧设备再扫码 —— 软件无法绕过，重启或换网络也无效。
4. **GD 音乐台目前有播放问题**，建议先不用；它的上游也是第三方公共 API，随时可能变化。
5. **共享模式永远不可能 384 kHz**。WASAPI 共享模式的流格式由设备混音格式决定（通常 48 kHz / 32 bit float），此时选高采样率不会生效；界面会同时显示「请求」与「实际」，这不是 bug。
6. **独占模式会被别的程序抢走**。默认输出端点被其他应用独占时，引擎会如实报错并降级到共享模式；此时听感正常但不再是 bit-perfect。
7. **仅支持 Windows x64**（Windows 10 1803+，内置运行环境需要系统自带 `tar.exe`）。Windows N 版播放需要安装 Media Feature Pack。
8. **DSD 不是原生输出**：DSF/DFF 被抽取为 176.4 kHz PCM 播放，不做 DoP。
9. **逐字歌词的质量取决于上游**：AMLL TTML DB / 网易云 / LRCLIB 拿不到的曲目只有行级歌词，甚至没有。
10. **源码构建默认不含内置运行环境**（见 [从源码构建](#从源码构建)），在线功能需要自备 Node.js 与服务端。
11. **端到端测试会抢独占音频设备**。`pnpm test:electron` 与几个 Playwright 套件需要真实引擎与默认输出端点；如果此时有别的程序正以独占方式占着声卡，测试会拿到 `0x8889000A`（设备占用）而失败 —— 那是环境问题，不是代码坏了。**不要并发跑多个套件**，也不要在放音乐时跑。

---

## 常见问题

**Q：启动后提示「缺少运行环境 / 在线功能起不来」？**
官方安装包首次使用在线功能时会花约 5 秒解压内置运行环境到 `%APPDATA%\twilight-echo-app\runtime`。若提示缺失，重装一次安装包可让它重新解压。从源码构建的版本没有内置环境，需要自己装 Node.js 24 并在「设置 → 流媒体账户」里填服务端命令。

**Q：没有声音，或者刚插拔耳机后没声音？**
先看「设置 → 输出与规格」里的输出设备与模式。设备热插拔后引擎会自动回落到默认端点；若仍未恢复，重新选一次设备。

**Q：独占模式打不开 / 提示设备被占用？**
说明默认输出端点正被别的程序独占。WASAPI 的错误码 `0x8889000A` 就是 `AUDCLNT_E_DEVICE_IN_USE`（设备正在被使用）。关掉别的播放器，或在设置里切到共享模式 —— 共享模式下能正常出声，只是不再 bit-perfect。

**Q：切歌、暂停还有轻微的咔哒声？**
当前版本已实现 15 ms 淡出 + 淡出后 15 ms 静音等设备排空。仍能听到的话，多半来自 USB DAC / 蓝牙在 Start/Stop 时的电源或时钟切换 —— 那属于驱动层，软件无法完全消除。

**Q：QQ 扫码一直提示「二维码已过期」？**
不一定是二维码问题。看提示文案：若是「登录设备数已达上限」，去手机 QQ 音乐「设置 → 设备管理」移除一台旧设备再扫。三种扫码通道（手机 QQ / 微信 / QQ 音乐 App）的码不通用，用哪个 App 扫就选哪个通道。

**Q：想换成自己部署的 API 服务端？**
「设置 → 流媒体账户」里每行都可以改启动命令，支持引号（安装目录常带空格）与 `$PORT` 占位符；端口由应用动态分配并通过环境变量传给服务端。

**Q：数据存在哪？卸载会丢吗？**
`%APPDATA%\twilight-echo-app`（曲库索引、歌单、设置、登录态；首次在线使用后多一个 `runtime` 目录约 151 MB）。卸载程序默认**保留**数据目录，需要彻底清理时手动删除。

---

## 目录结构

```
.
├─ app/                       Electron 应用（v0.4.0）
│  ├─ src/main/               主进程：引擎宿主、流媒体管理、回环代理、曲库与设置
│  ├─ src/preload/            contextBridge 桥
│  ├─ src/renderer/           React 19 界面（组件 / 视图 / 音频控制）
│  ├─ src/shared/             主进程与渲染层共享的协议、模型与纯函数
│  ├─ tools/                  单测、Playwright 验收、mock 引擎、打包与更新脚本
│  └─ electron-builder.yml    NSIS 打包与 extraResources（引擎 exe、内置运行环境）
├─ engine/                    C++20 音频引擎（v0.1.0）
│  ├─ src/                    入口 / 协议 / 解码 / DSP / WASAPI / 设备与诊断（Moonwave 引擎）
│  ├─ third_party/            已入库的第三方源码（TagLib、SoXR、dr_libs 等）
│  ├─ tools/                  fetch-deps.ps1、build.ps1、drive.mjs 验收套件、各类探针
│  ├─ fixtures/               真实事件序列与曲库快照（供应用侧测试用）
│  └─ CMakeLists.txt          构建定义（静态 CRT、/W4、C++20）
├─ docs/                      设计、规格、实现记录、截图与构建文档（中文为主）
│  ├─ BUILD-FROM-SOURCE.md    完整构建指南（工具链、参数、踩坑）
│  └─ screenshots/            README 引用的界面截图
├─ CONTRACT.md                引擎 ⇄ 应用协议与边界的冻结契约（只读）
└─ README.md                  本文件
```

---

## 许可与致谢

### 本仓库自有代码

**MIT License** —— 全文见仓库根目录的 [`LICENSE`](LICENSE)（Copyright © 2026 Stringmoon）。

### 第三方组件

完整清单与每一条的许可原文出处见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；第三方代码的溯源记录见 [`docs/PROVENANCE.md`](docs/PROVENANCE.md)。

需要特别说明的一处：**引擎以静态方式链接了 TagLib（LGPL-2.1 / MPL-1.1）与 SoXR（LGPL-2.1）**。
这两个库的**完整源码随仓库提供**（`engine/third_party/taglib-2.3.2/`、`engine/third_party/soxr-0.1.3/`），
构建脚本（`engine/tools/build.ps1`、`engine/tools/fetch-deps.ps1`）公开且可复现 ——
任何人都可以按 [`docs/BUILD-FROM-SOURCE.md`](docs/BUILD-FROM-SOURCE.md) 重新构建引擎，或替换成自己构建的同名库版本。

主要第三方组件（均为开源）：

| 组件 | 用途 | 许可 |
|---|---|---|
| [TagLib](https://github.com/taglib/taglib) 2.3.2 | 读音频标签与属性 | LGPL-2.1 / MPL-1.1 |
| [SoXR](https://github.com/chirlu/soxr) 0.1.3 | 流式重采样 | LGPL-2.1 |
| [dr_libs](https://github.com/mackron/dr_libs) | FLAC / WAV / MP3 解码 | 公有领域 / MIT-0 |
| [stb_vorbis](https://github.com/nothings/stb) | Ogg Vorbis 解码 | 公有领域（双许可 MIT） |
| [libebur128](https://github.com/jiixyj/libebur128) 1.2.6 | EBU R128 响度测量 | MIT |
| [kissfft](https://github.com/mborgerding/kissfft) | 频谱与卷积用的实数 FFT | BSD-3-Clause |
| [utfcpp](https://github.com/nemtrif/utfcpp) 4.2.1 | UTF-8 转换（TagLib 依赖） | BSL-1.0 |
| [Electron](https://github.com/electron/electron) 44 | 应用外壳 | MIT |
| [React](https://github.com/facebook/react) 19 | 渲染层 | MIT |

### 致谢

这个项目站在很多人的肩膀上。**下面把「引用 / 借鉴 / 参考」三档分开写清楚**，不是套话——
每一档的法律后果和道德义务都不一样，混在一起说对谁都不公平。

#### 一、引用（引用数据、文档与算法文献；不含代码）

| 来源 | 用途 | 说明 |
|---|---|---|
| [RBJ Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/)（Robert Bristow-Johnson） | 十段均衡的双二阶系数公式 | **公开文献的公式**，属于数学事实；引擎按它推导系数，非复制代码 |
| [EBU R128](https://tech.ebu.ch/docs/r/r128.pdf) / ITU-R BS.1770 | 响度归一与真峰值的判据 | 标准文档给出的测量方法 |
| [AutoEQ](https://github.com/jaakkopasanen/AutoEQ) 与 [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) 的**导出格式** | 让用户能导入自己已有的耳机补偿曲线 | 只实现「读取它们的文件格式」这一互操作能力，**不含其代码与数据** |
| [AMLL TTML DB](https://github.com/amll-dev/amll-ttml-db) 的 TTML 结构约定 | 支持逐字歌词的 `ttm:role` / 字级时间轴 | 只对齐格式规范 |

#### 二、借鉴（学习设计思路与参数，改写为自己的实现）

| 项目 | 许可 | 借鉴了什么 | 边界 |
|---|---|---|---|
| [Px-asen/Twilight_Echo](https://github.com/Px-asen/Twilight_Echo) | Apache-2.0 | 同为 Electron + C++20 原生引擎的整体分层；`outputPerfect` 双状态模型（「降级不是错误」的表达方式）；能力自报 `capabilities` 的思路 | 逐行比对有效代码行重合 **4.63%**，最长连续重合段为 `std::string title;` 类字段声明，**无实现级复制** |
| [BroNekoX/QueMusic](https://github.com/BroNekoX/QueMusic) | Apache-2.0 | `AudioDsp` 处理链的**顺序**与 auto-headroom 思路；其文档记录的两个坑（bypass 会连硬削一起跳过、限幅器关不等于不削波）被本引擎刻意规避 | 已在源码注释中点名出处（`engine/src/dsp.cpp` 文件头）；公式重写，未搬运代码 |
| [Moekotori/ECHO](https://github.com/Moekotori/ECHO) | AGPL-3.0 | 会话状态机、播放器生命周期分层、遥测字段的设计取舍 | **仅读设计，未复制代码**（行级比对最长连续命中 5 行，均为 COM 强制签名） |
| [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) | AGPL-3.0 | 界面组织与平台接入方式；其 issue 与踩坑记录省掉了大量试错 | **仅读设计，未复制代码**（12 个高嫌疑文件比对，最长连续命中 4 行） |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) / [Navidrome](https://github.com/navidrome/navidrome) 的**问题记录** | Unlicense / GPL-3.0 | 在线源取链失败模式、Subsonic 协议的坑 | 只读 issue 与文档，未使用其代码 |

#### 三、参考（只阅读、用来形成判断，不进入实现）

| 来源 | 参考点 |
|---|---|
| [Electron](https://github.com/electron/electron) / [React](https://github.com/facebook/react) 官方文档 | 进程模型、`contextBridge`、渲染层性能边界 |
| Windows WASAPI / IAudioClient3 文档 | 独占与共享的可用性判据、`AUDCLNT_E_*` 错误语义 |
| [Nothing](https://nothing.tech/) 的品牌与 GDK 设计语言 | 三通道状态编码（光 / 形 / 字）的**思想**；未使用其受限资产 |
| [Folia](https://github.com/chthollyphile/folia-major) / [ECHO](https://github.com/Moekotori/ECHO) 的公开讨论 | 「播放器该长什么样」的产品判断 |

#### 四、必须说明的边界

- **AGPL-3.0 项目（Folia / ECHO）在本仓库中只作为阅读与设计参考**：不包含其源代码，不链接其产物，未复制其表达性代码。
  逐条比对证据（含最长连续命中行数与文件）见 [`docs/PROVENANCE.md`](docs/PROVENANCE.md) §3。
- 若你打算把本项目与上述 AGPL 项目**合并分发**，请自行核对各自条款 —— 本仓库不对合并后的许可后果作任何判断。
- **如果这里遗漏了某个应当署名的来源，请开 issue 指出来**：补一条致谢比争一个例外便宜得多。

---

## 免责声明

- 本项目是**个人自用与学习性质**的软件，按「现状」提供，不附带任何明示或暗示的担保。
- 本项目**不提供、不分发、不托管任何音乐内容**，也不提供绕过付费墙、DRM 或地区限制的能力。在线播放所取到的流全部来自你本人账号在对应平台的合法权限。
- 网易云、QQ 音乐、GD 音乐台等第三方接口均为**非官方**通道，可能违反其服务条款，也可能随时失效。使用它们的一切后果与责任由使用者自行承担。
- 请只使用**你自己的账号**，不要用本软件做批量抓取、刷量或任何破坏平台正常服务的行为。项目名称、界面与图标由本项目创作；第三方组件与所借鉴的公开项目版权归其各自作者所有（见[许可与致谢](#许可与致谢)）。
