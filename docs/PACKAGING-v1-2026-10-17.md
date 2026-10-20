# 出安装包 + 无痛升级（v1 · 2026-10-17 第四轮）

> 用户要求：「深度整合，出包。而且要满足后续无痛升级功能。出安装包」
> 本轮把「仓库里能跑」变成「可安装、可升级、数据不丢、更新可自托管」的 Windows 产品形态。

## 0. 目标（可验收）

1. **出安装包**：`Stringmoon-Setup-<version>.exe`（NSIS，x64，无管理员权限、可改目录、保留用户数据）。
2. **深度整合**：引擎 exe 随包分发（resources/engine/bin），主进程按打包路径探测；图标/资源/asar 正确；单实例；安装后能正常扫描/播放/登录/设置。
3. **无痛升级**：
   - 覆盖安装（同 appId，数据目录不变 `%APPDATA%\twilight-echo-app`，卸载默认保留数据）；
   - 每次版本变化自动把关键 JSON 备份到 `userData/upgrade-backups/<fromVersion>/`（可人工回滚）；
   - 内置自动更新（electron-updater）：检查/下载/重启安装，自托管 generic 源（env 或 `userData/update-feed.json`）；开发模式优雅降级；未配置源时不偷打占位地址；
   - 设置页「关于与更新」：版本、数据目录、更新状态、检查/下载/重启安装按钮、配置指引。
4. 证据：本地静态更新源跑通 0.2.0 → 0.2.1 的「检查→下载→重启安装→版本变化、数据仍在」；独立验证者复核。

## 1. 架构与文件

- `app/electron-builder.yml`：appId（永久 `com.stringmoon.twilightecho`）、NSIS 配置、asar、`extraResources` 引擎、publish 占位。
- `app/package.json`：version **0.2.0**（首个发布版）；`dist` / `pack:dir` / `update-server` 脚本；author/license。
- `app/src/shared/update.ts`：`AppInfo` / `UpdateState` / `UpdateFeedConfig`（已由 Lead 冻结）。
- `app/src/main/updater.ts`：electron-updater 封装 + 状态机 + 更新源解析 + 事件广播。
- `app/src/main/upgrade-backup.ts`：版本变化时备份 userData 关键 JSON，保留最近 3 份。
- `app/src/main/index.ts`：单实例、`app-info`/`update-*` IPC、启动时 updater/backup 接线、退出安装更新前保存。
- `app/src/preload/index.ts` + `src/preload/index.d.ts`：`appInfo()`、`updateState()`、`checkForUpdates()`、`downloadUpdate()`、`installUpdate()`、`onUpdateStatus()`。
- `app/src/renderer/src/components/SettingsPage.tsx`：设置页新增「关于与更新」卡片（放在 `#appearance` 后或 `#accounts` 前；保留既有锚点/类）。
- `app/tools/release.mjs`：一条命令 build + NSIS + SHA256SUMS。
- `app/tools/update-server.mjs`：本地/自托管更新源静态服务器（演练用）。
- `docs/PACKAGING-v1-2026-10-17.md`：安装/升级/更新/回滚/签名/限制 + 验证证据。

## 2. 更新源与状态机

```text
TWILIGHT_UPDATE_URL (env, 最高)  →  userData/update-feed.json {url, note?}  →  未配置
只允许 http(s)；打包版才启用；开发模式 = disabled-dev。
phase: idle | unconfigured | disabled-dev | checking | available | downloading | downloaded | up-to-date | installing | error
```

- `autoUpdater.autoDownload=false`（尊重用户/流量），`autoInstallOnAppQuit=true`（已下载的更新退出时自动装），`allowDowngrade=false`。
- 启动后 12s 自动检查一次（仅配置了源）；失败只写状态，不弹错误框。
- 下载进度映射 percent；错误信息中文、单层原因，不带堆栈/URL 凭据。
- `installing`：调用 `quitAndInstall(false, true)`；应用退出后 NSIS 静默覆盖，再自动拉起。

## 3. 升级安全

- 覆盖安装：appId 不变 → NSIS 识别同一应用；`deleteAppDataOnUninstall:false`；userData 路径主进程钉死。
- 升级备份：启动最早阶段读 `app-meta.json` 的 `lastVersion`；若 ≠ 当前版本，先把已知 JSON（library/playlists/track-overrides/unplayable/lyrics/lyrics-online/eq-presets/eq-ir/artwork/playback-memory/streaming/downloads）复制到 `upgrade-backups/<old>/`，再写 meta；失败只记日志，绝不阻断启动、绝不删除原文件。
- 协议/数据向前兼容：新增字段可忽略；本轮不改引擎协议。
- 失败回滚：保留上一版安装包 + 备份目录说明；文档给出手动回滚步骤。

## 4. 测试

- 单测：`update-state.test.mjs`（feed 解析/状态推导/错误文案）、`upgrade-backup.test.mjs`（首启/升级/损坏 meta/备份上限）。
- e2e（dev，不打包）：设置页「关于与更新」卡片存在、版本显示、开发模式状态、preload API 四向对账（ipc-surface/preload-surface 更新）。
- 打包冒烟：`pnpm pack:dir` 后启动 `release/win-unpacked/Stringmoon.exe`（隔离 userData + Playwright），确认窗口渲染、引擎连接、版本、设置页；检查 resources/engine 存在。
- 安装/升级（本机、可逆）：静默安装到临时目录 → 启动/校验 FileVersion → 预置 userData 标记 → 安装新版覆盖 → 标记仍在 + `app-meta.lastVersion` 更新 + 备份目录出现；卸载保留数据。
- 自动更新：本地 `update-server` 托管 0.2.1 release；0.2.0 安装版以 `TWILIGHT_UPDATE_URL` 启动，Playwright 触发检查→下载→重启安装→版本变 0.2.1、userData 标记仍在。真实公网更新源属于人工项。

## 5. 签名与限制（诚实）

- 本轮**不做代码签名**（无证书）：Windows SmartScreen 会提示「未知发布者」；文档说明如何后续接入证书（CSC_LINK / Azure Trusted Signing）与自动更新签名校验。
- 只出 x64 NSIS；不含 ARM64/便携版（可后续加 target）。
- 真实公网自托管/对象存储/灰度未验证；只验证本地 generic 源。

---

## 6. 实施结果（2026-10-17 23:55 状态）

### 6.1 产物

| 文件 | 大小 | SHA256 |
|---|---|---|
| `app/release/Stringmoon-Setup-0.2.0.exe` | 117,202,476 B | `13B087384BA8A7818E208F5583802D5367A3C2F25C3D8C71E08C9A05B7628187` |
| `app/release-next/Stringmoon-Setup-0.2.1.exe`（演练新版） | 117,202,339 B | `BC14B55B74C85133DF4585521CCB72AA53E5AFEF599D9AD26E3F5857687D193A` |
| 两个目录的 `latest.yml` / `.blockmap` / `SHA256SUMS.txt` | — | latest.yml 的 sha512/size 与安装包实测一致 |

包内：`resources/app.asar` 含 `out/{main,preload,renderer}`、生产 `node_modules`（含 electron-updater）；`resources/engine/bin/twilight-engine.exe` = **静态 CRT 新引擎**（2,275,328 B，SHA256 `CCF2F1432948BD16C0383F1AC603D83C6BDF634A8D8BC2E96BBBAF1A95DE193A`，无 MSVCP/VCRUNTIME 依赖）；`resources/app-update.yml` 存在（占位地址，运行时未配置源不会使用）；`Stringmoon.exe` FileVersion 分别为 0.2.0 / 0.2.1。

### 6.2 已实测（Lead）

- **静默安装**：`Stringmoon-Setup-0.2.0.exe /S /D=<安装测试目录>` exit 0；安装目录含 Stringmoon.exe（0.2.0）、`Uninstall Stringmoon.exe`、resources（app.asar/engine/图标）、桌面快捷方式；`app-update.yml` 生成。
- **安装版启动**：0.2.0 隔离 userData 启动，`appInfo()` = {version 0.2.0, packaged true, userDataPath 隔离目录, platform win32}；updater `phase=unconfigured`、`feedConfigured=false`；引擎连接、设置页「关于」卡片显示版本；启动写入 `app-meta.json {lastVersion:0.2.0}`。
- **覆盖升级**：预置 userData（library/playlists/upgrade-marker）→ 静默装 0.2.1 覆盖同目录 → FileVersion 变 **0.2.1**，引擎替换、userData 标记文件仍在；启动 0.2.1 后 `app-meta.lastVersion=0.2.1`，生成 `upgrade-backups/0.2.0/library.json + playlists.json`。
- **自动更新（进行中）**：安装版 0.2.0 + 本地 `tools/update-server --dir release-next` + `TWILIGHT_UPDATE_URL=http://127.0.0.1:8787/`：检查→发现 0.2.1→下载成功（server 日志显示 GET latest.yml/blockmap/121MB installer；用户 data 下 `%LOCALAPPDATA%\twilight-echo-app-updater\pending\Stringmoon-Setup-0.2.1.exe` 117,202,217B）；**重启安装步骤由独立验证者完成**（见 VERIFICATION-REPORT §10）。
- **卸载**：待独立验证者复核（安装程序 `deleteAppDataOnUninstall:false`，预期保留 userData）。

### 6.3 打包环境坑（已解决，写进配置）

1. pnpm v11 的 `onlyBuiltDependencies`/`allowBuilds` 已迁移到 `pnpm-workspace.yaml`：需允许 `electron-winstaller` 的 install 脚本，否则 electron-builder 内部 `pnpm install` 以 ERR_PNPM_IGNORED_BUILDS 失败。
2. electron-builder 26.15.3 的 app-builder-lib 引用 `@electron/get` 3.1 才导出的 `ElectronDownloadCacheMode`，pnpm 原本解析到 3.0.0 → 打包崩溃 `Cannot read properties of undefined (reading 'ReadWrite')`；已在 `pnpm-workspace.yaml` 用 `overrides: '@electron/get': 3.1.0` 修复。
3. 本机 GitHub CDN 不稳：electron-builder 下载 Electron 会卡住；`electron-builder.yml` 配 `electronDownload.mirror`（npmmirror）并**直接使用** `node_modules/.pnpm/electron@44.7.2/node_modules/electron/dist` 作为 `electronDist`，不再联网下载。
4. 引擎静态 CRT：原 exe 依赖 MSVCP140/VCRUNTIME140(_1)，干净 Windows 会加载失败；已改全局 `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` 重建并验证；顺带用 `_wfopen` 修了中文安装路径 diag log 不生成的问题。

### 6.4 发布/升级操作手册

**发版**（版本号在 `app/package.json` 的 version）：
```powershell
cd <仓库根>\app
pnpm dist                       # build → NSIS → release/SHA256SUMS.txt
# 自托管：把 release/ 里的 exe + latest.yml + blockmap 上传到静态目录
```
**客户端更新源**（二选一，打包版生效）：
- 环境变量 `TWILIGHT_UPDATE_URL=https://<目录>/`；
- 或 `%APPDATA%\twilight-echo-app\update-feed.json`：`{ "url": "https://<目录>/" }`。
未配置 = `unconfigured`，不会联网；开发模式 = `disabled-dev`。

**升级**：用户只需运行新版安装包覆盖安装（同 appId），或由已下载更新在退出时自动安装；`%APPDATA%\twilight-echo-app` 数据不动，首次启动把上一版本关键 JSON 备份到 `userData/upgrade-backups/<旧版本>/`。

**回滚**：保留上一版安装包；退出应用后用旧安装包覆盖安装；如需恢复数据，从 `upgrade-backups/<版本>/` 复制回 userData（备份目录保留最近 3 份）。

**签名**：本轮未签名（SmartScreen 会提示未知发布者）。接入证书：设置 `CSC_LINK`/`CSC_KEY_PASSWORD`（或 Azure Trusted Signing）后重跑 `pnpm dist`；electron-updater 会随 electron-builder 生成的 `app-update.yml` 校验签名。

**Windows N**：引擎加载期依赖 MFPlat/MFReadWrite，Windows N 版需要安装 Media Feature Pack；标准 Windows 10/11 自带。
