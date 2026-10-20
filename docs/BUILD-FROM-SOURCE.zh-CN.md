# 从源码构建 Stringmoon

[English](BUILD-FROM-SOURCE.md) · **中文**

> 本文是 [`README.md`](../README.md)「从源码构建」一节的扩展版：完整工具链要求、逐步命令、
> 产物去哪、以及这条路上会绊人的坑。
>
> 目标平台：**Windows 10 / 11 x64**。本项目不构建 macOS / Linux（引擎依赖 WASAPI 与 Media Foundation）。
>
> 本仓库自有代码以 **MIT** 许可发布（见仓库根 [`LICENSE`](../LICENSE)）；第三方组件许可见
> [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。引擎以静态方式链接的 TagLib / SoXR 为 LGPL-2.1，
> 其源码随仓库提供于 `engine/third_party/`，可按本文重新构建。

---

## 0. 一分钟速览

```powershell
git clone <本仓库>
cd <仓库>

# 引擎（C++20）——第三方源码已入库，可离线构建
powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1

# 应用（Electron + React）
cd app
pnpm install
pnpm dev            # 开发模式
pnpm build          # 产出 out/
pnpm dist           # 出 NSIS 安装包 → app/release/
```

---

## 1. 工具链要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 x64 | 引擎硬编码 Windows-only；CMake 配置阶段就会拒绝非 Windows |
| Node.js | **≥ 22.12**（或 20.19+） | `vite 7` / `electron-vite 5` 的 `engines` 要求。实测开发机为 v24.19.0 |
| pnpm | **11.x** | 仓库用 pnpm 的 workspace 与 `onlyBuiltDependencies`；lockfile 是 `lockfileVersion 9.0` |
| CMake | **≥ 3.25** | `engine/CMakePresets.json` 声明 `cmakeMinimumRequired 3.25`。实测机为 4.4.4 |
| MSVC | VS 2022 生成器或 Build Tools | 引擎用 `/W4 /permissive- /utf-8 /EHsc` 与 C++20；默认生成器是 `Visual Studio 17 2022` |
| Windows SDK | 10.0.x | WASAPI / Media Foundation 头文件 |
| 磁盘 | 引擎构建 + 应用依赖 | `app/node_modules` 与 Electron 二进制体积不小 |

`cl.exe` **不在 PATH 是正常的**：`engine/tools/build.ps1` 自己开 developer shell
（Ninja 分支 source `vcvars64.bat`；VS 分支让 CMake 自己找 MSVC）。

---

## 2. 引擎：`engine/`

### 2.1 第三方依赖已入库

`engine/third_party/` 里随仓库提供了构建所需的全部第三方源码（**724 个文件 / 7,522,241 字节 ≈ 7.2 MiB**）：

| 目录 | 组件 | 版本 | 用途 | 许可 |
|---|---|---|---|---|
| `taglib-2.3.2/` | TagLib | 2.3.2 | 读标签与音频属性 | LGPL-2.1 / MPL-1.1 |
| `soxr-0.1.3/` | SoXR | 0.1.3 | 流式重采样 | LGPL-2.1 |
| `dr_libs/` | dr_flac / dr_wav / dr_mp3 | master 单头 | FLAC / WAV / MP3 解码 | 公有领域 / MIT-0 |
| `stb_vorbis/` | stb_vorbis | v1.22 | Ogg Vorbis 解码 | 公有领域（双许可 MIT） |
| `kissfft/` | kissfft | master | 频谱与卷积的实数 FFT | BSD-3-Clause |
| `libebur128/` | libebur128 | v1.2.6 | EBU R128 响度测量 | MIT |
| `utfcpp/` | utfcpp | 4.2.1 | UTF-8 转换（TagLib 2.3+ 硬依赖） | BSL-1.0 |

因此**离线也能构建引擎**，`fetch-deps.ps1` 不必跑。

### 2.2 `fetch-deps.ps1`：只在需要重新拉取时用

```powershell
powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1
```

它把 TagLib / utfcpp / dr_libs / kissfft / SoXR 拉到 `engine/third_party/`，**不往系统里装任何东西**。
脚本里有两处只对特定网络环境成立的做法，换机器时可能需要调整：

- `raw.githubusercontent.com` 不通时，逐个头文件走 `gh-proxy.com` 前缀；
- 归档走 `codeload.github.com`（可直连），并且脚本**不往系统里装任何东西**。
  如果你的机器能直连 GitHub，把镜像前缀去掉即可。

> ⚠️ 该脚本会**更新** `third_party/` 里的版本（TagLib / utfcpp / SoXR 是按「最新 release/tag」解析的）。
> 只有在你确实想升级依赖时才跑它 —— 随便跑一次可能让构建与已入库版本不一致。

### 2.3 构建

```powershell
powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1

# 可选参数
... build.ps1 -Clean                     # 删掉 build/ 重新配置
... build.ps1 -Configuration Debug       # 默认 Release
... build.ps1 -Generator Ninja           # 用 Ninja（需要路径足够短，见下）
... build.ps1 -RtTrace                   # 记录渲染线程正在执行的调用（诊断用，默认关）
```

**产物固定落在 `engine/bin/twilight-engine.exe`**（`CMakeLists.txt` 用
`RUNTIME_OUTPUT_DIRECTORY` 钉死，不随配置子目录变化）。构建脚本最后会检查这个文件存在，
并打印大小与时间戳。

### 2.4 生成器怎么选

| 生成器 | 什么时候用 |
|---|---|
| `VisualStudio`（默认，`Visual Studio 17 2022`） | 默认选它。CMake 装在很深的路径时（例如 winget 目录），Ninja 会 stat CMake 自己的模块文件，路径超过 260 字符的 MAX_PATH 限制后直接拒绝构建（`Filename longer than 260 characters`）；MSBuild 不受影响 |
| `Ninja` | 构建目录：`engine/build/ninja`。CMake 路径短时更快；脚本会在 VS 目录里找 Ninja 并 source `vcvars64.bat` |

`engine/CMakePresets.json` 另提供 `ninja-release` / `vs2022` 两个 preset，若你想直接驱动 CMake：

```powershell
cmake --preset vs2022
cmake --build --preset vs2022-release
```

> preset 用的是默认构建目录（`build/vs2022`、`build/ninja`），**与 `build.ps1` 相同**；
> 但产物输出目录同样被 `CMakeLists.txt` 钉到 `engine/bin/`。

### 2.5 构建配置要点（改构建的人必读）

- **静态 CRT**：全局 `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`（Debug 用 `/MTd`）。
  这不是优化，是**必须**：`MSVCP140 / VCRUNTIME140 / VCRUNTIME140_1` 不是系统组件，
  动态链接会让引擎在没装 VC++ 2015-2022 Redistributable 的机器上加载失败
  （Electron spawn 报「找不到模块」，播放全不可用）。
- **第三方静态库必须继承同一个 CRT**：混用 `/MT` 与 `/MD` 对象会产生各自的 CRT 堆与静态状态，
  比体积增长严重得多。
- **`/utf-8` 是必须的**：工程里每个源文件都含非 ASCII 文本。
- `NOMINMAX` / `WIN32_LEAN_AND_MEAN`：避免 `windows.h` 的 min/max 宏破坏 `<algorithm>`。

---

## 3. 应用：`app/`

### 3.1 安装依赖

```powershell
cd app
pnpm install
```

- `pnpm-workspace.yaml` 里的 `onlyBuiltDependencies` / `allowBuilds` 是**必须的**：
  没有它们，electron-builder 内部的 `pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS` 失败。
- `overrides: '@electron/get': 3.1.0` 也是必须的：electron-builder 26.15.3 的 app-builder-lib
  引用了 `@electron/get` 3.1 才导出的符号，被锁到 3.0.0 会在打包时崩溃。
- Electron 二进制走 npmmirror 镜像（`app/.npmrc` 与 `pnpm-workspace.yaml` 都已配好），
  因为部分网络下 GitHub CDN 不稳。能直连的环境把镜像行去掉即可。

### 3.2 开发

```powershell
pnpm dev
```

主进程按以下顺序解析引擎（见 `app/src/main/engine-host.ts`）：

1. 环境变量 `TWILIGHT_ENGINE`（+ 可选 `TWILIGHT_ENGINE_ARGS`）；
2. 打包资源目录 `resources/engine/bin/twilight-engine.exe`；
3. 仓库内 `engine/bin/twilight-engine.exe`（**构建过引擎就自动用它**）；
4. 都没有 → `tools/mock-engine.mjs`（纯 UI 开发用的假引擎，协议一致但不发声）。

```powershell
$env:TWILIGHT_ENGINE = 'D:\path\to\twilight-engine.exe'
pnpm dev
```

### 3.3 构建与打包

```powershell
pnpm build        # electron-vite：main / preload / renderer → app/out/
pnpm dist         # build + electron-builder NSIS + SHA256SUMS → app/release/
```

`pnpm dist` 实际跑的是 `app/tools/release.mjs`，顺序固定：

1. `pnpm build`；
2. `electron-builder --win nsis --x64`；
3. 对 `.exe` / `latest.yml` / `.blockmap` 算 SHA256 写进 `release/SHA256SUMS.txt`。

还有两个快捷开关：

```powershell
node tools/release.mjs --skip-build   # out/ 已经构建过，只打包
node tools/release.mjs --dir          # 只出未安装目录，快速验证资源布局（并检查引擎是否进了包）
```

**打包会把两样东西塞进 `resources/`**（见 `app/electron-builder.yml`）：

| 来源 | 目标 | 缺失时 |
|---|---|---|
| `../engine/bin/twilight-engine.exe` | `resources/engine/bin/twilight-engine.exe` | ⚠️ 打包前**必须先构建引擎**。`engine/bin/` 不入库（`.gitignore`），所以新克隆的仓库直接 `pnpm dist` 出来的包**没有引擎**，应用会退回 mock（不发声） |
| `resources/runtime.zip` | `resources/runtime.zip` | electron-builder 打印 `file source doesn't exist` 告警并**跳过**该资源，构建仍成功。安装包于是不含内置运行环境 |

> **`runtime.zip` 是官方安装包的内置运行环境**（Node.js 24 + 网易云 / QQ 两个 API 服务端及其生产依赖，
> 内容物：`node.exe`、`node_modules/`、许可声明；约 61 MB，解压后约 151 MB）。它**不入库**，
> 而且**仓库里没有生成它的脚本** —— 它是官方打包时手工准备的一次性产物。
>
> 从源码构建时可以不提供它，代价是安装包不含内置运行时。此时应用的行为是可预期的：
> `app/src/main/streaming/bundled-runtime.ts` 的 `prepareBundledRuntime()` 找不到运行环境就返回 `null`，
> `ensureBundledStreamingConfig()` 于是**不写 streaming.json**（它明确拒绝写一份与默认配置一样的文件，
> 因为那只会掩盖「运行环境没打进包」），流媒体配置保持 `defaultStreamingConfig()` 的默认命令 ——
> 也就是 `npx -y @neteasecloudmusicapienhanced/api` 与 `npx -y @yakult-green-tea/qq-music-api`。
> 目标机器需要能自己跑通这两条命令（Node.js + 网络）。
>
> 另外注意：开发态会优先用 `app/resources/runtime/` 这个**解开态目录**。
> 想要「本地开发也能用内置运行环境」，把官方安装包里的 `runtime.zip` 解开到 `app/resources/runtime/` 即可
> —— `bundledRuntimeDir()` 会找到它，`prepareBundledRuntime()` 直接返回，不触发解压。

### 3.4 版本号

- 应用版本在 `app/package.json` 的 `version`（当前 0.4.0），安装包名与 `latest.yml` 都从它派生。
- 引擎版本在 `engine/CMakeLists.txt` 的 `project(... VERSION 0.1.0)`，通过 `ready` 事件自报
  （`twilight-engine (Moonwave) 0.1.0`）。**两者不同步**，不要指望它们一致。
- `appId`（`com.stringmoon.twilightecho`）**一经发布永不修改**：NSIS 的升级/卸载身份由它派生。

### 3.5 自托管自动更新（可选）

打包版默认**不联网检查更新**（`publish.url` 是占位）。要启用需显式配置更新源，二选一：

- 环境变量 `TWILIGHT_UPDATE_URL=https://<静态目录>/`；
- `%APPDATA%\twilight-echo-app\update-feed.json` 写 `{ "url": "https://<静态目录>/" }`。

本地演练：`pnpm update-server -- --dir release`。

---

## 4. 构建后的自检

最容易踩的坑是「构建成功但跑起来没声音」，所以建议按这个顺序验：

```powershell
# 1) 引擎自检：不碰声卡，纯离线（EQ 频响 / dither / 响度 / 声道）
engine\bin\twilight-engine.exe --selftest
#    期望：self-test: all checks passed（exit 0）

# 2) 引擎版本自报
engine\bin\twilight-engine.exe --version
#    期望：twilight-engine (Moonwave) 0.1.0

# 3) 这个文件到底能不能播（最有用的一条：失败原因会打印出来）
engine\bin\twilight-engine.exe --probe-format <某个音乐文件>

# 4) 本机能开什么独占格式
engine\bin\twilight-engine.exe --probe-exclusive

# 5) 应用侧类型与规范
cd app
pnpm typecheck
pnpm check:tokens
pnpm check:css
```

> 引擎的 stdout **只有 JSON Lines**，日志一律走 stderr（CONTRACT §3.1 铁律）。
> 如果你在 stdout 看到半行乱码或普通文本，那是引擎的 bug，不是解析器的问题。

---

## 5. 常见构建问题

**Q：`build.ps1` 报 `No MSVC toolchain found`**
没找到 `vcvars64.bat`。装 Visual Studio 2022（含 C++ 桌面开发工作负载）或 VS Build Tools。

**Q：`build.ps1 -Generator Ninja` 报 `Filename longer than 260 characters`**
CMake 安装路径太深。用默认的 VisualStudio 生成器，或把 CMake 装到短路径。

**Q：`pnpm install` 之后 electron 二进制下载失败**
镜像没生效。确认 `app/.npmrc` 与 `pnpm-workspace.yaml` 里的 `electron_mirror` 指向可达的镜像。

**Q：`pnpm dist` 成功，但装完没有声音**
多半是包里没有引擎 exe。用 `node tools/release.mjs --dir` 检查
`release/win-unpacked/resources/engine/bin/twilight-engine.exe` 是否存在；不存在就先回 `engine/` 构建。

**Q：`pnpm dev` 起来是假引擎（不发声）**
`engine/bin/twilight-engine.exe` 不存在，且 `TWILIGHT_ENGINE` 未设置。先构建引擎，或显式指定路径 ——
主进程启动日志会打印 `[engine] spawning: ...`，从那里能直接看出用的是哪个。

**Q：在干净 Windows 机器上启动就报「找不到模块」**
引擎 exe 不是静态 CRT 构建的。确认 `engine/CMakeLists.txt` 顶部的
`CMAKE_MSVC_RUNTIME_LIBRARY` 没有被改回默认值（`/MD`）。

**Q：Windows N 版没有声音**
引擎加载期依赖 `MFPlat` / `MFReadWrite`。安装 *Media Feature Pack*。标准 Windows 10/11 自带。

---

## 6. 相关文档

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 项目总览、功能、已知限制 |
| [`../CONTRACT.md`](../CONTRACT.md) | 引擎 ⇄ 应用协议与边界（冻结，只读） |
| [`../engine/README.md`](../engine/README.md) | 引擎的构建、探针与自测接入口 |
| [`../engine/PROGRESS.md`](../engine/PROGRESS.md) | 引擎做到哪儿了、踩过的坑 |
| [`PACKAGING-v1-2026-10-17.md`](PACKAGING-v1-2026-10-17.md) | 安装包 / 升级 / 更新 / 回滚 / 签名的完整记录 |
| [`BUNDLED-RUNTIME-v0.4-2026-10-18.md`](BUNDLED-RUNTIME-v0.4-2026-10-18.md) | 内置运行环境的来龙去脉 |
| [`INDEX.md`](INDEX.md) | docs 索引（哪份有效、哪份作废） |
