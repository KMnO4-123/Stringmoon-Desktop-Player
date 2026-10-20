# Building Stringmoon from source

[中文](BUILD-FROM-SOURCE.zh-CN.md) · **English**

> This is the extended version of the [README](../README.md) section "Build from source": the full toolchain
> requirements, step-by-step commands, where the artifacts land, and the pitfalls on the way.
>
> Target platform: **Windows 10 / 11 x64**. macOS / Linux are not built (the engine depends on WASAPI and Media Foundation).
>
> Code in this repository is released under **MIT** (see [`LICENSE`](../LICENSE) at the root); third-party
> licenses are listed in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). The engine statically links
> TagLib / SoXR (LGPL-2.1); their sources ship in `engine/third_party/` and can be rebuilt following this document.

---

## 0. One-minute overview

```powershell
git clone <this repository>
cd <repository>

# Engine (C++20) — third-party sources are committed, so this builds offline
powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1

# App (Electron + React)
cd app
pnpm install
pnpm dev            # development mode
pnpm build          # emits out/
pnpm dist           # NSIS installer → app/release/
```

---

## 1. Toolchain requirements

| Tool | Version | Notes |
|---|---|---|
| Windows | 10 / 11 x64 | the engine is hard-coded Windows-only; the CMake configure step rejects anything else |
| Node.js | **≥ 22.12** (or 20.19+) | required by the `engines` field of `vite 7` / `electron-vite 5`. The development machine runs v24.19.0 |
| pnpm | **11.x** | the repo relies on pnpm workspaces and `onlyBuiltDependencies`; the lockfile is `lockfileVersion 9.0` |
| CMake | **≥ 3.25** | `engine/CMakePresets.json` declares `cmakeMinimumRequired 3.25`; the development machine runs 4.4.4 |
| MSVC | VS 2022 generator or Build Tools | the engine uses `/W4 /permissive- /utf-8 /EHsc` and C++20; the default generator is `Visual Studio 17 2022` |
| Windows SDK | 10.0.x | WASAPI / Media Foundation headers |
| Disk | engine build + app dependencies | `app/node_modules` and the Electron binary are not small |

It is **normal for `cl.exe` not to be on PATH**: `engine/tools/build.ps1` opens a developer shell itself
(the Ninja branch sources `vcvars64.bat`; the VS branch lets CMake locate MSVC).

---

## 2. Engine: `engine/`

### 2.1 Third-party dependencies are committed

`engine/third_party/` ships every third-party source needed to build (**724 files / 7,522,241 bytes ≈ 7.2 MiB**):

| Directory | Component | Version | Used for | License |
|---|---|---|---|---|
| `taglib-2.3.2/` | TagLib | 2.3.2 | reading tags and audio properties | LGPL-2.1 / MPL-1.1 |
| `soxr-0.1.3/` | SoXR | 0.1.3 | streaming resampling | LGPL-2.1 |
| `dr_libs/` | dr_flac / dr_wav / dr_mp3 | master, single headers | FLAC / WAV / MP3 decoding | public domain / MIT-0 |
| `stb_vorbis/` | stb_vorbis | v1.22 | Ogg Vorbis decoding | public domain (dual-licensed MIT) |
| `kissfft/` | kissfft | master | real FFT for spectrum and convolution | BSD-3-Clause |
| `libebur128/` | libebur128 | v1.2.6 | EBU R128 loudness measurement | MIT |
| `utfcpp/` | utfcpp | 4.2.1 | UTF-8 conversion (hard dependency of TagLib 2.3+) | BSL-1.0 |

So the engine **builds offline** and `fetch-deps.ps1` does not have to run.

### 2.2 `fetch-deps.ps1`: only when you need to re-fetch

```powershell
powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1
```

It pulls TagLib / utfcpp / dr_libs / kissfft / SoXR into `engine/third_party/` and **installs nothing into the system**.
Two things in the script are specific to certain network environments and may need adjusting on another machine:

- when `raw.githubusercontent.com` is unreachable, individual headers go through the `gh-proxy.com` prefix;
- archives go through `codeload.github.com` (directly reachable), and the script still **installs nothing into the system**.
  If your machine reaches GitHub directly, drop the mirror prefixes.

> ⚠️ This script **updates** the versions inside `third_party/` (TagLib / utfcpp / SoXR are resolved to the latest release/tag).
> Run it only when you actually intend to upgrade dependencies — running it casually can desynchronise the build from the committed versions.

### 2.3 Build

```powershell
powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1

# optional flags
... build.ps1 -Clean                     # delete build/ and reconfigure
... build.ps1 -Configuration Debug       # Release by default
... build.ps1 -Generator Ninja           # use Ninja (needs a short enough path, see below)
... build.ps1 -RtTrace                   # record which render-thread call is running (diagnostics, off by default)
```

**The artifact always lands at `engine/bin/twilight-engine.exe`** (`CMakeLists.txt` pins it with
`RUNTIME_OUTPUT_DIRECTORY`, so it does not follow the config subdirectory). The script checks that the file
exists at the end and prints its size and timestamp.

### 2.4 Choosing a generator

| Generator | When to use it |
|---|---|
| `VisualStudio` (default, `Visual Studio 17 2022`) | the default choice. When CMake lives under a very deep path (a winget directory, for instance), Ninja stat()s CMake's own module files, hits the 260-character MAX_PATH limit and refuses to build (`Filename longer than 260 characters`); MSBuild is unaffected |
| `Ninja` | build directory: `engine/build/ninja`. Faster when the CMake path is short; the script finds Ninja inside the VS directory and sources `vcvars64.bat` |

`engine/CMakePresets.json` also provides `ninja-release` / `vs2022` presets if you prefer driving CMake directly:

```powershell
cmake --preset vs2022
cmake --build --preset vs2022-release
```

> The presets use the same build directories as `build.ps1` (`build/vs2022`, `build/ninja`);
> the output directory is likewise pinned to `engine/bin/` by `CMakeLists.txt`.

### 2.5 Build settings that matter (required reading if you touch the build)

- **Static CRT**: global `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` (`/MTd` in Debug).
  This is not an optimisation, it is **mandatory**: `MSVCP140 / VCRUNTIME140 / VCRUNTIME140_1` are not
  system components, and dynamic linking makes the engine fail to load on a machine without the
  VC++ 2015-2022 Redistributable (Electron's spawn reports "module not found" and nothing plays).
- **Third-party static libraries must inherit the same CRT**: mixing `/MT` and `/MD` objects gives each its own
  CRT heap and static state, which is far worse than a slightly larger binary.
- **`/utf-8` is required**: every source file in the project contains non-ASCII text.
- `NOMINMAX` / `WIN32_LEAN_AND_MEAN`: keeps the `windows.h` min/max macros from breaking `<algorithm>`.

---

## 3. App: `app/`

### 3.1 Install dependencies

```powershell
cd app
pnpm install
```

- `onlyBuiltDependencies` / `allowBuilds` in `pnpm-workspace.yaml` are **required**:
  without them electron-builder's internal `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.
- `overrides: '@electron/get': 3.1.0` is also required: app-builder-lib in electron-builder 26.15.3
  references a symbol only exported by `@electron/get` 3.1, and pinning it to 3.0.0 crashes packaging.
- The Electron binary comes from the npmmirror mirror (`app/.npmrc` and `pnpm-workspace.yaml` are both configured)
  because the GitHub CDN is unreliable on some networks. On a machine with direct access, drop the mirror lines.

### 3.2 Development

```powershell
pnpm dev
```

The main process resolves the engine in this order (see `app/src/main/engine-host.ts`):

1. the `TWILIGHT_ENGINE` environment variable (plus optional `TWILIGHT_ENGINE_ARGS`);
2. the packaged resources directory `resources/engine/bin/twilight-engine.exe`;
3. the in-repo `engine/bin/twilight-engine.exe` (**build the engine once and it is picked up automatically**);
4. otherwise `tools/mock-engine.mjs` (a fake engine for pure UI work: same protocol, no sound).

```powershell
$env:TWILIGHT_ENGINE = 'D:\path\to\twilight-engine.exe'
pnpm dev
```

### 3.3 Build and package

```powershell
pnpm build        # electron-vite: main / preload / renderer → app/out/
pnpm dist         # build + electron-builder NSIS + SHA256SUMS → app/release/
```

`pnpm dist` actually runs `app/tools/release.mjs`, in a fixed order:

1. `pnpm build`;
2. `electron-builder --win nsis --x64`;
3. compute SHA256 for `.exe` / `latest.yml` / `.blockmap` and write `release/SHA256SUMS.txt`.

There are two shortcuts:

```powershell
node tools/release.mjs --skip-build   # out/ is already built, only package
node tools/release.mjs --dir          # emit the unpacked directory only, to verify resource layout (and whether the engine made it in)
```

**Packaging puts two things into `resources/`** (see `app/electron-builder.yml`):

| Source | Target | When missing |
|---|---|---|
| `../engine/bin/twilight-engine.exe` | `resources/engine/bin/twilight-engine.exe` | ⚠️ **the engine must be built before packaging**. `engine/bin/` is not committed (`.gitignore`), so `pnpm dist` on a fresh clone produces a package **without an engine** and the app falls back to the mock (silent) |
| `resources/runtime.zip` | `resources/runtime.zip` | electron-builder logs a `file source doesn't exist` warning and **skips** that resource; the build still succeeds. The installer then has no bundled runtime |

> **`runtime.zip` is the official installer's bundled runtime** (Node.js 24 + the NetEase / QQ API backends and
> their production dependencies; contents: `node.exe`, `node_modules/`, license notices; about 61 MB, ~151 MB unpacked).
> It is **not committed**, and **no script in this repository generates it** — it is a one-off artifact prepared by hand
> during official packaging.
>
> A build from source may omit it, at the cost of an installer without the bundled runtime. The app's behaviour is
> then predictable: `prepareBundledRuntime()` in `app/src/main/streaming/bundled-runtime.ts` returns `null` when it
> cannot find the runtime, so `ensureBundledStreamingConfig()` **writes no streaming.json** (it deliberately refuses
> to write a file identical to the defaults, since that would merely hide "the runtime never made it into the package").
> Streaming configuration stays on `defaultStreamingConfig()`'s commands — that is,
> `npx -y @neteasecloudmusicapienhanced/api` and `npx -y @yakult-green-tea/qq-music-api`.
> The target machine then needs to run those two commands itself (Node.js + network).
>
> Also note: in development the app prefers the **unpacked** directory `app/resources/runtime/`.
> To have the bundled runtime available while developing, unpack the official installer's `runtime.zip` into
> `app/resources/runtime/` — `bundledRuntimeDir()` will find it and `prepareBundledRuntime()` returns immediately
> without extracting anything.

### 3.4 Version numbers

- The app version is `version` in `app/package.json` (currently 0.4.1); the installer name and `latest.yml` derive from it.
- The engine version is `project(... VERSION 0.1.0)` in `engine/CMakeLists.txt`, self-reported in the `ready` event
  (`twilight-engine (Moonwave) 0.1.0`). **The two are independent**; do not expect them to match.
- The `appId` (`com.stringmoon.twilightecho`) **must never change once released**: NSIS derives upgrade/uninstall identity from it.

### 3.5 Self-hosted auto-update (optional)

Packaged builds **check for updates over the network only when explicitly configured** (`publish.url` is a placeholder). Pick one:

- the environment variable `TWILIGHT_UPDATE_URL=https://<static directory>/`;
- `%APPDATA%\twilight-echo-app\update-feed.json` containing `{ "url": "https://<static directory>/" }`.

Local rehearsal: `pnpm update-server -- --dir release`.

---

## 4. Post-build checks

The most common trap is "it built but plays no sound", so verify in this order:

```powershell
# 1) Engine self-test: no audio device touched, fully offline (EQ response / dither / loudness / channels)
engine\bin\twilight-engine.exe --selftest
#    expect: self-test: all checks passed (exit 0)

# 2) Engine version self-report
engine\bin\twilight-engine.exe --version
#    expect: twilight-engine (Moonwave) 0.1.0

# 3) Can this file actually play? (the most useful one: the failure reason is printed)
engine\bin\twilight-engine.exe --probe-format <some music file>

# 4) Which exclusive formats this machine can open
engine\bin\twilight-engine.exe --probe-exclusive

# 5) App-side types and conventions
cd app
pnpm typecheck
pnpm check:tokens
pnpm check:css
```

> The engine's stdout carries **JSON Lines only**; logs always go to stderr (the CONTRACT §3.1 hard rule).
> If you see a half line of garbage or plain text on stdout, that is an engine bug, not a parser problem.

---

## 5. Common build problems

**Q: `build.ps1` reports `No MSVC toolchain found`**
`vcvars64.bat` was not found. Install Visual Studio 2022 (with the Desktop development with C++ workload) or VS Build Tools.

**Q: `build.ps1 -Generator Ninja` reports `Filename longer than 260 characters`**
The CMake installation path is too deep. Use the default VisualStudio generator, or install CMake under a short path.

**Q: the Electron binary fails to download during `pnpm install`**
The mirror did not take effect. Check that `electron_mirror` in `app/.npmrc` and `pnpm-workspace.yaml` points at a reachable mirror.

**Q: `pnpm dist` succeeds but the installed app has no sound**
Most likely the package has no engine exe. Run `node tools/release.mjs --dir` and check whether
`release/win-unpacked/resources/engine/bin/twilight-engine.exe` exists; if not, go back to `engine/` and build it.

**Q: `pnpm dev` starts the fake engine (silent)**
`engine/bin/twilight-engine.exe` does not exist and `TWILIGHT_ENGINE` is unset. Build the engine first, or point the variable at a path —
the main process logs `[engine] spawning: ...` at startup, which tells you exactly which one is in use.

**Q: "module not found" on a clean Windows machine at startup**
The engine exe was not built against the static CRT. Check that `CMAKE_MSVC_RUNTIME_LIBRARY` at the top of
`engine/CMakeLists.txt` has not been reverted to the default (`/MD`).

**Q: no sound on Windows N editions**
The engine depends on `MFPlat` / `MFReadWrite` at load time. Install the *Media Feature Pack*. Standard Windows 10/11 includes it.

---

## 6. Related documents

| Document | Contents |
|---|---|
| [`../README.md`](../README.md) | project overview, features, known limitations |
| [`../CONTRACT.md`](../CONTRACT.md) | engine ⇄ app protocol and boundary (frozen, read-only) |
| [`../engine/README.md`](../engine/README.md) | engine build, probes and self-test entry points |
| [`../engine/PROGRESS.md`](../engine/PROGRESS.md) | where the engine got to, and the pitfalls along the way (Chinese) |
| [`PACKAGING-v1-2026-10-17.md`](PACKAGING-v1-2026-10-17.md) | full record of packaging / upgrade / update / rollback / signing |
| [`BUNDLED-RUNTIME-v0.4-2026-10-18.md`](BUNDLED-RUNTIME-v0.4-2026-10-18.md) | why the bundled runtime exists and how it works |
| [`INDEX.md`](INDEX.md) | docs index (which document is current, which is void) |
