# Third-Party Notices

**Stringmoon** (formerly *Twilight Echo*) — Windows desktop music player.
This file lists every third-party component that ships with, or is required to build,
the Stringmoon desktop application and its audio engine.

- Project: Stringmoon 0.4.0
- Own license: **MIT** (see [`LICENSE`](LICENSE))
- Generated from the actual tree on 2026-10-20; every entry names the file it was read from.

> **How this file is organised**
> 1. [Our own license](#1-our-own-license)
> 2. [Bundled JS runtime (Electron app)](#2-bundled-js-runtime-electron-app)
> 3. [Audio engine: statically linked C/C++ libraries](#3-audio-engine-statically-linked-cc-libraries)
> 4. [LGPL obligations (read this if you redistribute)](#4-lgpl-obligations-read-this-if-you-redistribute)
> 5. [Bundled Node.js runtime + platform API servers](#5-bundled-nodejs-runtime--platform-api-servers)
> 6. [Electron / Chromium](#6-electron--chromium)
> 7. [Acknowledgements to upstream projects](#7-acknowledgements-to-upstream-projects)
> 8. [Non-software notices](#8-non-software-notices)

---

## 1. Our own license

Stringmoon's own source code (everything in `app/src/`, `engine/src/`, the build
scripts, and the documentation) is licensed under the **MIT License**:

    MIT License

    Copyright (c) 2026 Stringmoon

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

MIT covers **our** code only. It does not relicense any third-party component
below; in particular it does not relicense the LGPL-2.1 / LGPL-3.0 components,
which remain under their own licenses.

**No AGPL code.** See [`docs/PROVENANCE.md`](docs/PROVENANCE.md) for the full
provenance audit. In short: no AGPL-3.0 (Folia, ECHO) source code was copied into
this project; those projects were read as *design* references only. The only
upstream code whose structure was deliberately followed is Apache-2.0
(BroNekoX/QueMusic and Px-asen/Twilight_Echo) — and where that happened it is
annotated in the source and credited in §7.

---

## 2. Bundled JS runtime (Electron app)

These packages are the **production** dependencies. They are bundled into
`app.asar` and therefore ship inside every installer.

They were enumerated by extracting the shipped `app/release/win-unpacked/resources/app.asar`
(`@electron/asar list`, 4,337 entries) — i.e. **this is what a recipient actually receives**,
not what a lockfile hopes for. 42 packages in total: 35 MIT, 3 ISC, 1 BSD-3-Clause,
1 0BSD, 1 BlueOak-1.0.0, 1 Python-2.0. There is **no copyleft package in this set**.

| Package | Version | License | Copyright | Where the text lives |
|---|---|---|---|---|
| electron-updater | 6.8.9 | MIT | Vladimir Krivosheev | `node_modules/electron-updater/LICENSE` |
| react | 19.3.0 | MIT | Meta Platforms, Inc. and affiliates | `node_modules/react/LICENSE` |
| react-dom | 19.3.0 | MIT | Meta Platforms, Inc. and affiliates | `node_modules/react-dom/LICENSE` |
| scheduler | 0.28.0 | MIT | Meta Platforms, Inc. and affiliates | `node_modules/scheduler/LICENSE` |
| motion | 14.2.0 | MIT | Matt Perry | `node_modules/motion/LICENSE.md` |
| framer-motion | 14.2.0 | MIT | Matt Perry | `node_modules/framer-motion/LICENSE.md` |
| motion-dom | 14.2.0 | MIT | Matt Perry | `node_modules/motion-dom/LICENSE.md` |
| motion-utils | 14.1.1 | MIT | Matt Perry | `node_modules/motion-utils/LICENSE.md` |
| three | 0.186.1 | MIT | three.js authors (mrdoob) | `node_modules/three/LICENSE` |
| zustand | 5.0.15 | MIT | Paul Henschel | `node_modules/zustand/LICENSE` |
| lucide-react | 1.57.0 | **ISC** | Lucide Icons and Contributors | `node_modules/lucide-react/LICENSE` |
| music-metadata | 12.2.0 | MIT | Borewit | `node_modules/music-metadata/LICENSE.txt` |
| strtok3 | 10.5.0 | MIT | Borewit | `node_modules/strtok3/LICENSE.txt` |
| token-types | 6.1.2 | MIT | Borewit | `node_modules/token-types/LICENSE.txt` |
| @borewit/text-codec | 0.2.2 | MIT | Borewit | `node_modules/@borewit/text-codec/LICENSE.txt` |
| file-type | 22.1.1 | MIT | Sindre Sorhus | `node_modules/file-type/license` |
| uint8array-extras | 1.6.0 | MIT | Sindre Sorhus | `node_modules/uint8array-extras/license` |
| node-id3 | 0.2.9 | MIT | Jan Metzger | `node_modules/node-id3/LICENSE` |
| iconv-lite | 0.6.2 | MIT | Alexander Shtuchkin | `node_modules/iconv-lite/LICENSE` |
| safer-buffer | 2.1.2 | MIT | Nikita Skovoroda | `node_modules/safer-buffer/LICENSE` |
| builder-util-runtime | 9.7.0 | MIT | Vladimir Krivosheev | `node_modules/builder-util-runtime/LICENSE` |
| lazy-val | 1.0.5 | MIT | Vladimir Krivosheev | *package.json only; no LICENSE file upstream* |
| tiny-typed-emitter | 2.1.0 | MIT | Zurab Benashvili | `node_modules/tiny-typed-emitter/LICENSE` |
| fs-extra | 10.1.0 | MIT | JP Richardson | `node_modules/fs-extra/LICENSE` |
| jsonfile | 6.2.1 | MIT | JP Richardson | `node_modules/jsonfile/LICENSE` |
| universalify | 2.0.1 | MIT | Ryan Zimmerman | `node_modules/universalify/LICENSE` |
| graceful-fs | 4.2.11 | **ISC** | Isaac Z. Schlueter | `node_modules/graceful-fs/LICENSE` |
| semver | 7.7.4 | **ISC** | GitHub Inc. | `node_modules/semver/LICENSE` |
| js-yaml | 4.3.2 | MIT | Vladimir Zapparov | `node_modules/js-yaml/LICENSE` |
| argparse | 2.0.1 | **Python-2.0** | Python Software Foundation | `node_modules/argparse/LICENSE` |
| lodash.isequal | 4.5.0 | MIT | John-David Dalton | `node_modules/lodash.isequal/LICENSE` |
| lodash.escaperegexp | 4.1.2 | MIT | John-David Dalton | `node_modules/lodash.escaperegexp/LICENSE` |
| debug | 4.4.3 | MIT | Josh Junon | `node_modules/debug/LICENSE` |
| ms | 2.1.3 | MIT | Vercel / Zeit | `node_modules/ms/license.md` |
| @tokenizer/inflate | 0.4.1 | MIT | Borewit | `node_modules/@tokenizer/inflate/LICENSE` |
| @tokenizer/token | 0.3.0 | MIT | Borewit | *package.json only; no LICENSE file upstream* |
| content-type | 3.1.1 | MIT | Douglas Christopher Wilson | `node_modules/content-type/LICENSE` |
| media-typer | 2.0.0 | MIT | Douglas Christopher Wilson | `node_modules/media-typer/LICENSE` |
| ieee754 | 1.2.1 | **BSD-3-Clause** | Fair Oaks Labs, Inc. | `node_modules/ieee754/LICENSE` |
| sax | 1.6.1 | **BlueOak-1.0.0** | Isaac Z. Schlueter | `node_modules/sax/LICENSE.md` |
| tslib | 2.8.1 | **0BSD** | Microsoft Corporation | `node_modules/tslib/LICENSE.txt` |
| win-guid | 0.2.1 | MIT | Borewit | `node_modules/win-guid/LICENSE.txt` |

### Build-time only (not shipped)

These are `devDependencies`. They are **not** present in `app.asar` (verified: the
extracted asar contains none of them) and therefore create no distribution
obligation — but they are listed for completeness and because anyone rebuilding
from source will install them:

| Package | Version | License |
|---|---|---|
| electron | 44.7.2 | MIT |
| electron-builder | 26.15.3 | MIT |
| electron-vite | 5.0.0 | MIT |
| vite | 7.3.7 | MIT |
| @vitejs/plugin-react | 5.2.0 | MIT |
| typescript | 5.9.2 | **Apache-2.0** (`node_modules/typescript/LICENSE.txt`) |
| playwright-core | 1.64.0 | **Apache-2.0** (`node_modules/playwright-core/LICENSE` + `NOTICE`) |
| @types/node | 24.19.2 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| @types/three | 0.186.0 | MIT |

If you redistribute a **source** tarball that includes the lockfile, the Apache-2.0
NOTICE from `playwright-core` must travel with it (Apache-2.0 §4(d)). The MIT ones
require only the copyright + permission notice, which is in each package's LICENSE file.

---

## 3. Audio engine: statically linked C/C++ libraries

`engine/` builds `twilight-engine.exe` (C++20, MSVC, static CRT) which statically links
the libraries below. All of them are **vendored as source** under
`engine/third_party/` and are committed to this repository, so the exact source of
every binary you can build is in-tree.

Verified linking evidence: `engine/bin/twilight-engine.map` contains 14,753 `taglib`
symbol references, 1,211 `soxr` symbols, 120 `ebur128` and 57 `kiss_fft` symbols;
`twilight-engine.exe` imports only OS DLLs
(ADVAPI32, AVRT, dbghelp, KERNEL32, MFReadWrite, ole32, SHELL32, USER32, WINHTTP).

| Library | Version | SPDX | Copyright holder | License text in repo | Usage |
|---|---|---|---|---|---|
| **TagLib** | 2.3.2 | **LGPL-2.1 / MPL-1.1** (dual) | Scott Wheeler, Lukas Lalinsky, Tsuda Kageyu, Stephen F. Booth, Ismael Orenstein, Allan Sandfeld Jensen, Teemu Tervo, Mathias Panzenböck, Damien Plisson, Urs Fleisch (see `taglib-2.3.2/AUTHORS`, 23 lines) | `engine/third_party/taglib-2.3.2/COPYING.LGPL` (26,530 B) and `COPYING.MPL` (25,755 B) | Tag reading + audio properties only (`engine/src/metadata.cpp`) |
| **SoXR** (SoX Resampler) | 0.1.3 | **LGPL-2.1** | Rob Sykes `<robs@users.sourceforge.net>` (2007-18) | `engine/third_party/soxr-0.1.3/LICENCE` (1,024 B) + `COPYING.LGPL` (26,432 B) | Sample-rate conversion |
| **kissfft** | master (6 files) | **BSD-3-Clause** | Mark Borgerding, 2003-2010 | `engine/third_party/kissfft/COPYING` | Real FFT for the spectrum meter |
| **libebur128** | 1.2.6 (`ebur128.h:15-17`) | **MIT** | Jan Kokemüller, 2011 | `engine/third_party/libebur128/COPYING` | EBU R128 loudness scan |
| **utfcpp** | 4.2.1 (`CMakeLists.txt:3`) | **BSL-1.0** (Boost) | Nemanja Trifunović, 2006 | `engine/third_party/utfcpp/LICENSE` | UTF-8/16 conversion, required by TagLib 2.3+ |
| **dr_libs** — dr_flac 0.13.4, dr_wav 0.14.6, dr_mp3 0.7.4 | as vendored | **Unlicense OR MIT-0** (dual) | David Reid | License text at the **bottom** of each header (`dr_flac.h` from line ~12,700: "ALTERNATIVE 1 – Public Domain … ALTERNATIVE 2 – MIT No Attribution, Copyright 2023 David Reid") | FLAC / WAV / MP3 decode |
| **stb_vorbis** | 1.22 | **Public Domain OR MIT** (dual) | Sean Barrett, 2007-2017 (v1.22 file trailer: "ALTERNATIVE A – MIT License, Copyright (c) 2017 Sean Barrett") | License text at the **bottom** of `stb_vorbis.c` (last ~45 lines) | Ogg **Vorbis** decode |

Notes on the two dual-licensed families:

- **TagLib** is offered as LGPL-2.1 **or** MPL-1.1 ("Alternatively, this file is
  available under the Mozilla Public License Version 1.1", `taglib/toolkit/taglib.h:18-22`).
  We rely on the LGPL branch and satisfy it as described in §4. **We do not modify
  the vendored TagLib tree** — all 539 files (370 `.cpp`/`.h`) carry one identical
  mtime (2026-09-05 12:17:23, the upstream tarball's timestamp), and there is no
  patch file anywhere under `engine/third_party/`.
- **SoXR** is LGPL-2.1. Its bundled `src/pffft.c` is separately copyrighted
  (Julien Pommier 2013, based on FFTPACKv4 / UCAR, BSD-style terms embedded at
  `pffft.c:23-60`). It **is** compiled in: `engine/build/vs2022/soxr/src/Release/soxr.lib`
  contains `pffft32s.obj` and `pffft64s.obj` (pffft is on by default,
  `soxr-0.1.3/CMakeLists.txt:66-68`), so the UCAR/FFTPACK BSD notice must travel
  with the binary too. It also contains `fft4g32.obj`/`fft4g64.obj` —
  Takuya Ooura's FFT (1996-2001, "may use, copy, modify and distribute this code for
  any purpose … without fee", `soxr-0.1.3/src/fft4g.c:1-6`).
  SoXR's `lsr-tests/` directory ships under **GPL-2.0**
  (`soxr-0.1.3/lsr-tests/COPYING`), but `engine/CMakeLists.txt:123,126` force
  `BUILD_TESTS OFF` and `WITH_LSR_BINDINGS OFF`, so **no GPL-2.0 code is compiled in**.
  Its `examples/` are explicitly *not* derivative works of a program using the
  library (`soxr-0.1.3/LICENCE`, note 1).

**Not vendored, OS-provided:** Media Foundation (`mfplat` / `mfreadwrite` / `mfuuid`,
`shell32`), WinHTTP, WASAPI, AVRT. These are Windows components and are not
redistributed by us.

---

## 4. LGPL obligations (read this if you redistribute)

The engine **statically links** two LGPL-2.1 libraries: **TagLib 2.3.2** and
**SoXR 0.1.3**. Static linking is permitted under LGPL-2.1 §6, but only if the
recipient can modify the library and relink the combined work. This section states
exactly how that is satisfied, and what the two remaining caveats are.

> **Short version:** we satisfy **LGPL-2.1 §6(a)** — full Library source + full
> work-that-uses-the-Library source + a working build script, all in this repository at the
> same place the binary is offered (§6(d)). Object files are *an* allowed form under §6(a),
> not a requirement; §6(a) says "as object code **and/or** source code". Details and the two
> honest caveats are in §4.3. If you want zero argument, build with `BUILD_SHARED_LIBS=ON`
> (that satisfies §6(b) instead) — see §4.3's last paragraph.

### 4.1 License texts travel with the distribution

| Where | What |
|---|---|
| Repository | `engine/third_party/taglib-2.3.2/COPYING.LGPL` (26,530 B) + `COPYING.MPL` (25,755 B); `engine/third_party/soxr-0.1.3/COPYING.LGPL` (26,432 B) + `LICENCE` (1,024 B); plus the BSD/MIT/BSL/public-domain texts of §3 (kissfft `COPYING`, libebur128 `COPYING`, utfcpp `LICENSE`, dr_libs + stb_vorbis license blocks at the bottom of each header) |
| Repository root | this file (`THIRD-PARTY-NOTICES.md`) — the readable index that tells a recipient *which* files above matter and *what* they must do |
| Installer / binary release | ship this file next to the installer; the full license texts are in the repository the release points at |
| Bundled runtime | `app/resources/runtime/THIRD-PARTY-NOTICES.txt` plus every package's own LICENSE inside the runtime archive (both LGPL-3.0 texts for `@unblockneteasemusic/server` are there) |

LGPL-2.1 §6 additionally says: *"If the work during execution displays copyright notices, you
must include the copyright notice for the Library among them, as well as a reference directing
the user to the copy of this License."*

**Checked, and the condition is not currently triggered:** the app's About panel
(`app/src/renderer/src/components/SettingsPage.tsx:584-630`, 「关于与更新」) shows version,
run mode, data directory and update state — **no copyright line at all**, ours or anyone's.
So §6's conditional clause does not fire today. If a copyright line is ever added there, the
TagLib/SoXR notices must be added alongside it (one string each) — noted in
`docs/PROVENANCE.md` §7.3 as a maintenance rule, not an open gap.

### 4.2 Source availability

The complete, unmodified source of TagLib 2.3.2 and SoXR 0.1.3 is **committed to this
repository** under `engine/third_party/` (7.17 MB total: taglib 5.07 MB, dr_libs 1.06 MB,
soxr 0.53 MB, utfcpp 0.21 MB, stb_vorbis 0.18 MB, libebur128 0.09 MB, kissfft 0.03 MB).
Upstream URLs, for the record:

- TagLib 2.3.2 — <https://github.com/taglib/taglib> (release tarball `v2.3.2`)
- SoXR 0.1.3 — <https://github.com/chirlu/soxr> (tag `v0.1.3`)
- utfcpp 4.2.1 — <https://github.com/nemtrif/utfcpp>
- dr_libs — <https://github.com/mackron/dr_libs>
- stb_vorbis 1.22 — <https://github.com/nothings/stb/blob/master/stb_vorbis.c>
- libebur128 1.2.6 — <https://github.com/jiixyj/libebur128>
- kissfft — <https://github.com/mborgerding/kissfft>

Because we do not modify either library, the in-tree copy **is** the corresponding
source. If you build the engine yourself, that source is what gets linked.

### 4.3 Relinking: how to rebuild with a modified TagLib or SoXR

The exact clause is **LGPL-2.1 §6** (`engine/third_party/taglib-2.3.2/COPYING.LGPL`, line 271
onward). It says that if you combine the Library with a "work that uses the Library" and
distribute the combination, you must give prominent notice, supply the license, **and do one
of these things**:

> (a) Accompany the work with the complete corresponding machine-readable source code for
> the Library … **and, if the work is an executable linked with the Library, with the complete
> machine-readable "work that uses the Library", as object code and/or source code**, so that
> the user can modify the Library and then relink to produce a modified executable …
> (b) Use a suitable shared library mechanism …
> (c) Accompany the work with a written offer … to give the same user the materials specified
> in Subsection 6a …
> (d) If distribution of the work is made by offering access to copy from a designated place,
> offer equivalent access to copy the above specified materials from the same place.

**We satisfy §6(a) with source code.** The clause reads *"as object code **and/or** source
code"* — object files are one acceptable form, **not a requirement**. What we ship, in the same
repository, at the same place (§6(d)):

| §6(a) needs | Where it is |
|---|---|
| "complete corresponding machine-readable source code for the Library, including whatever changes were used" | `engine/third_party/taglib-2.3.2/` and `engine/third_party/soxr-0.1.3/` — **unmodified** upstream trees (one single mtime across all 539 TagLib files, no patch files anywhere) |
| "the complete machine-readable 'work that uses the Library' … as … source code" | `engine/src/` — all 59 files, 1,031,592 B, MIT-licensed, so the user *can* modify and redistribute their changes |
| "so that the user can modify the Library and then relink" | the CMake project + build script below |

**How to actually relink** (this is the part the license is really asking about — it must be
mechanically possible, not just theoretically allowed):

```
engine/tools/fetch-deps.ps1     # restores engine/third_party/ (already committed; only needed after deletion)
engine/tools/build.ps1          # configures + builds -> engine/bin/twilight-engine.exe
```

- Replace `engine/third_party/taglib-2.3.2/` (or `soxr-0.1.3/`) with your modified copy. Nothing
  else changes: both are consumed by glob, not by a pinned path —
  `engine/CMakeLists.txt:66` `file(GLOB ... "third_party/taglib-*")` feeding `:95`
  `add_subdirectory(...)`; `:113` + `:135` for SoXR.
- Toolchain is stock: CMake ≥ 3.25 + MSVC (VS 2022 Build Tools or VS 2026) + Windows SDK
  10.0.26100. No private SDK, no signing key, no vendor tool. `engine/tools/build.ps1` is
  4,540 B of readable PowerShell.
- If you would rather swap a DLL without rebuilding: flip `BUILD_SHARED_LIBS` to `ON` at
  `engine/CMakeLists.txt:89` (TagLib) and `:128` (SoXR) — they are currently forced `OFF`
  (static). Route §6(b) then also becomes available.

**What is *not* required, and why we say so:** LGPL-2.1 §6(a) does **not** demand `.lib`/`.obj`
artifacts if the complete source of both the Library and the work-that-uses-it is provided.
Our engine source is MIT and public, so the "relink" condition is met the moment a user has
a compiler — which is exactly the standard a source-available project is held to. Shipping
`twilight-engine.obj` instead would satisfy the same clause by a different route; it is not
needed, and would add ~35 MB to every release.

**Two real caveats, stated plainly (these are the only honest gaps):**

1. **The source must correspond to the shipped binary.** LGPL-2.1 §6(a) says *"the complete
   corresponding … source code"*. If the repository `HEAD` has moved past the commit the
   installer was built from, a strict reader could call the correspondence incomplete.
   → **Fix:** tag every binary release (`v0.4.0`) and have this notice point at that tag. Until
   that is done, the safest phrasing for a recipient is "the source at tag v0.4.0".
2. **A mirror must carry the offer with it.** §6(d) is only discharged when the place the
   binary is downloaded from also offers the source. GitHub Releases attached to this
   repository satisfies it; a third-party mirror that rehosts only the `.exe` does not.
   → **Fix:** nothing to change in-tree; it is a distribution-policy point for whoever
   redistributes.

**Recommendation for any public binary release:** flip `BUILD_SHARED_LIBS` to `ON`. It costs
nothing at runtime (two extra DLLs next to the engine) and removes both caveats from the
conversation, because §6(b) is then satisfied by construction. This is a recommendation, not a
gap: as it stands the project is compliant via §6(a)+(d).

### 4.4 What we do *not* claim

- We do not claim the engine is "LGPL-free". It is not: it contains TagLib and SoXR.
- We do not relicense TagLib/SoXR under MIT. The MIT `LICENSE` at the repo root covers
  our code; the LGPL texts govern those two libraries, and a redistributor must keep
  both sets of notices intact.
- MPL-1.1 (TagLib's alternative branch) would be satisfied by the same source
  availability, but we are not relying on it.

---

## 5. Bundled Node.js runtime + platform API servers

Stringmoon v0.4.0 ships a self-contained runtime so the online-music feature works on a
machine with no Node.js installed. It is **not** part of the Electron app's own code; it
is a separate payload that the app unpacks on first use.

- Source directory: `app/resources/runtime/` (151 MB unpacked)
- Shipped as: `app/resources/runtime.zip` (63,914,239 B ≈ 61 MB), declared as
  `extraResources` in `app/electron-builder.yml:38-39`
- Contains 265 packages, 8,416 zip entries — **full, unminified source of every package**,
  not a bundle.

| Component | Version | License | Evidence |
|---|---|---|---|
| **Node.js** | v24.19.0 | **MIT** | `node.exe` (92,825,416 B) reports `v24.19.0`; SHA-256 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`; official Windows build of that release is `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73` for `node-v24.19.0-win-x64.zip` (from `https://nodejs.org/dist/v24.19.0/SHASUMS256.txt`) |
| **@neteasecloudmusicapienhanced/api** | 4.41.1 | **MIT** | `runtime/node_modules/@neteasecloudmusicapienhanced/api/LICENSE` — "Copyright (c) 2013-2022 Binaryify"; `package.json` `"license": "MIT"` |
| **@yakult-green-tea/qq-music-api** | 3.3.2 | **MIT** | `runtime/node_modules/@yakult-green-tea/qq-music-api/LICENSE` — "Copyright (c) 2019"; `package.json` `"license": "MIT"` |
| **@unblockneteasemusic/server** | 0.28.0 | **LGPL-3.0-only** | `runtime/node_modules/@unblockneteasemusic/server/COPYING` (GPL-3.0, 35,149 B) + `COPYING.LESSER` (LGPL-3.0, 7,651 B); `package.json` `"license": "LGPL-3.0-only"` |

### 5.1 About `@unblockneteasemusic/server` (LGPL-3.0-only) — **shipped as source, not bundled**

It is a transitive dependency: `@neteasecloudmusicapienhanced/api` →
`@neteasecloudmusicapienhanced/unblockmusic-utils@0.4.5` → `@unblockneteasemusic/server@^0.28.0`.
It is used only when the user explicitly turns on the general-unblock path
(`@neteasecloudmusicapienhanced/api/server.js:338`, guarded by `ENABLE_GENERAL_UNBLOCK === 'true'`).

**It is not bundled or minified into a single file.** The zip contains 105 entries under
`node_modules/@unblockneteasemusic/server/`, including the complete, untouched source tree —
all **50** files under `src/` (`src/app.js`, `src/provider/match.js`, `src/provider/qq.js`, …) —
and both license texts. `src/provider/match.js` is plain, unminified CommonJS (7,810 B, first line
`const find = require('./find');`). A `precompiled/app.js` (231,371 B) does exist upstream
and is the package's `bin` entry, but **our app never invokes it** — `app/src/main/streaming/`
contains no reference to it, and the only entry point the app starts is
`@neteasecloudmusicapienhanced/api/app.js` (`app/src/main/streaming/bundled-runtime.ts:85-88`).

**Conclusion: yes, shipping it as source + dependencies satisfies LGPL-3.0 — but be precise
about *which* route, because the naive answer is wrong.**

The naive argument is "it's a separate process, so it's not a combined work". **That is
false here.** The call chain is entirely in-process:

```
@neteasecloudmusicapienhanced/api/server.js:346-350
  require('@neteasecloudmusicapienhanced/unblockmusic-utils').matchID(id)
    → unblockmusic-utils/src/match.js  (dynamic require of ./modules/*.js)
      → unblockmusic-utils/modules/unm.js:1   require('@unblockneteasemusic/server')
```

`modules/unm.js:1` is literally `const match = require('@unblockneteasemusic/server');`
and `:13` calls `match(id, sources)` — the LGPL library's `src/provider/match.js` runs **inside
the same Node process** as the MIT-licensed API server. Same address space ⇒ *Combined Work*
under LGPL-3.0 §4, and §4's conditions apply. (This only happens when the operator sets
`ENABLE_GENERAL_UNBLOCK=true`; the modules are lazy-loaded, but that changes *when*, not *whether*.)

They are satisfied as follows:

| LGPL-3.0 §4 requires | Status |
|---|---|
| §4(a) prominent notice that the Library is used and is under this License | ✅ this section |
| §4(b) accompany with a copy of the GNU GPL + this License | ✅ `COPYING` + `COPYING.LESSER` ship inside the package directory in the zip |
| §4(c) if the work displays copyright notices during execution, include the Library's | ✅ **not triggered** — the app displays no copyright notice (see §4.1) |
| §4(d) convey the Combined Work under terms that permit modification + reverse engineering for debugging, **and** do §4(d)(0) or §4(d)(1) | ✅ see below |

§4(d) gives two routes:

- **§4(d)(0)** — convey the *Minimal Corresponding Source* under GPLv3 **and** the
  *Corresponding Application Code* in a form suitable for relinking. For JavaScript this would
  mean shipping our application source too (we do publish it, MIT) plus a documented rebuild.
- **§4(d)(1) — "Use a suitable shared library mechanism"** — the library must be a **separate
  file, dynamically loaded at run time**, and must work with a user-installed modified version
  that is interface-compatible. ✅ **This is the route we take.**

Why §4(d)(1) fits here: `@unblockneteasemusic/server` is never inlined or statically copied
into our code — it is a directory of `.js` files resolved by Node's module loader at runtime,
and replacing it with a modified build takes one drag-and-drop in
`%APPDATA%\twilight-echo-app\runtime\node_modules\@unblockneteasemusic\server\` — no
recompilation, no relinking, no access to our source. That is exactly the situation §4(d)(1)
protects.

**Honest caveat:** §4(d)(1) is the *stronger* reading for a non-native language. A conservative
licensor could argue the "shared library mechanism" language was written for dynamic
`.so`/`.dll` and that JavaScript modules are not it, pushing you to §4(d)(0). If a downstream
redistributor wants to be unimpeachable, §4(d)(0) is satisfied *for free* by this project,
because our application source is public under MIT — the Corresponding Application Code is
already in the repository. **Either way the project is compliant; the ambiguity is about which
clause you cite, not about whether the obligation is met.**

**Two things that would break this and must not happen:**

1. **Bundling/minifying it into one `app.js`** (webpack/esbuild single-file). Then the file is
   no longer separately replaceable, §4(d)(1) fails, and you fall back to §4(d)(0) — which
   requires shipping the Minimal Corresponding Source *and* the Corresponding Application
   Code in a relink-able form. Doable, but strictly worse. **Preserve the current
   `node_modules` source-tree layout.**
2. **Deleting `COPYING`/`COPYING.LESSER` from the packaged tree** (e.g. a zip filter that keeps
   only `src/**`). §4(b) would fail. The current build keeps them; keep it that way.

Note the runtime.zip is currently **not committed** (`.gitignore`) — it is a build artifact.
Whoever regenerates it must preserve both points above. There is no generation script in the
repo today (`docs/PROVENANCE.md` §7.3 tracks that as an open item).

### 5.2 The rest of the runtime (263 packages)

A full audit of the 265 packages in `runtime/node_modules/` gives:

| License | Count |
|---|---|
| MIT | 230 |
| ISC | 15 |
| BSD-2-Clause | 7 |
| BSD-3-Clause | 6 |
| **(BSD-3-Clause OR GPL-2.0)** — `node-forge@1.4.0`; we take BSD-3-Clause | 1 |
| LGPL-3.0-only — `@unblockneteasemusic/server@0.28.0` (see §5.1) | 1 |
| Apache-2.0 | 1 |
| BlueOak-1.0.0 — `sax@1.6.1` | 1 |
| 0BSD — `tslib@2.8.1` | 1 |
| MIT-0 | 1 |
| *no `license` field* — `only@0.0.2` | 1 |

Two entries deserve a note:

- **`node-forge@1.4.0`** is dual `(BSD-3-Clause OR GPL-2.0)`. We elect **BSD-3-Clause**,
  which carries no copyleft. Its `LICENSE` file is in the runtime tree.
- **`only@0.0.2`** (a 6-line Koa helper, dependency of `koa`) declares **no `license` field
  in `package.json`** and ships **no LICENSE file** — {a 247-byte `index.js`}. Its
  `Readme.md` does contain the MIT text: *"(The MIT License) Copyright (c) 2012 TJ Holowaychuk
  <tj@vision-media.ca>"*. This is the one place where a runtime license is carried by a README
  rather than a LICENSE file; it is still MIT by the author's own words. Nothing to fix, but
  worth knowing if an automated license scanner reports it.

14 packages have no dedicated LICENSE *file* but do declare the license in `package.json`
(`@tokenizer/token`, `agent-base`, `cache-content-type`, `copy-to`, `degenerator`, `gzip`,
`https`, `https-proxy-agent`, `isarray`, `koa-compose`, `koa-static`, `saxes` — all MIT/ISC).
`koa` itself is MIT.

### 5.3 `NODE-LICENSE.md` — **this file is wrong, and must be regenerated**

`app/resources/runtime/NODE-LICENSE.md` (225,452 B, 4,031 lines) is **not the Node.js license**.
It is **Blender's third-party license compilation**: the header says *"Generated by `make license`…
paths relative to Blender projects root"* and the body says *"Blender itself is released under
GPU-GPL 3.0 or later, © 2011-2026 Blender Foundation"*. It contains no Node.js text at all
(zero case-insensitive matches for "node.js"/"nodejs"/"OpenJS").

The *correct* Node.js license text is
<https://github.com/nodejs/node/blob/v24.19.0/LICENSE> (157,601 B: "Node.js is licensed for use as
follows … Copyright Node.js contributors. All rights reserved." plus the bundled-dependency
licenses). **This is a documentation defect, not a legal gap** — Node.js is MIT and the MIT
notice is what §4.1's repo-level `THIRD-PARTY-NOTICES.md` carries — but shipping a Blender GPL
file under the filename `NODE-LICENSE.md` is misleading and should be replaced before any public
release. It also means the runtime's own `THIRD-PARTY-NOTICES.txt` line 7 ("许可：MIT（全文见
NODE-LICENSE.md…）") points at the wrong text.

---

## 6. Electron / Chromium

The Electron runtime itself is redistributed inside the installer.

- `electron@44.7.2` — **MIT**, "Copyright (c) Electron contributors / Copyright (c) 2013-2020
  GitHub Inc." — `app/node_modules/electron/LICENSE`
- Chromium's own license stack ships with the binary as
  `LICENSES.chromium.html` (20,477,229 B). Verified present in
  `app/release/win-unpacked/LICENSES.chromium.html` and
  `app/release/win-unpacked/LICENSE.electron.txt` — i.e. electron-builder already places both
  notices next to `Stringmoon.exe`. That satisfies Electron's MIT notice and Chromium's
  third-party notice requirement without further action.
- Electron embeds Node.js and V8; their notices are inside `LICENSES.chromium.html`.

---

## 7. Acknowledgements to upstream projects

Stringmoon's **design** was informed by four open-source music players. Two are Apache-2.0
and were used as legitimate code references; two are AGPL-3.0 and were read for design only.
The full audit — what was studied, what was copied, and what was deliberately not — is in
[`docs/PROVENANCE.md`](docs/PROVENANCE.md). Summary:

| Project | License | How we used it |
|---|---|---|
| [BroNekoX/QueMusic](https://github.com/BroNekoX/QueMusic) | **Apache-2.0** | DSP chain ordering and its two documented pitfalls are cited in `engine/src/dsp.cpp:3-11` and `engine/src/dsp.hpp:18-21`; word-level LRC label shapes are cited in `app/src/shared/lrc.ts:7`. Upstream constants (EQ band count/Q range, ReplayGain targets) were used as parameter references. |
| [Px-asen/Twilight_Echo](https://github.com/Px-asen/Twilight_Echo) | **Apache-2.0** | Read as an architecture reference for a platform-adapter layer and a native audio engine. No files were copied verbatim; line-level comparison against a local snapshot shows only shared data-shape declarations, no copied implementation. |
| [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) | **AGPL-3.0** | **Design reference only.** Studied for the shape of the login-diagnostics layering and for platform-adapter structure; no code copied. |
| [Moekotori/ECHO](https://github.com/Moekotori/ECHO) | **AGPL-3.0** | **Design reference only.** Studied for its "live config" playback-memory idea and its WASAPI split; no code copied. |

We thank the authors of all four. Their licenses are **not** changed by this project, and
nothing here should be read as an endorsement of Stringmoon by them.

Additional acknowledgements:

- **lucide-react** (ISC) — icon set used throughout the UI.
- **three.js** (MIT) — WebGL rendering for the record / spectrum visuals.
- **motion / framer-motion** (MIT) — UI animation.
- **music-metadata**, **node-id3** (MIT) — the app-side metadata fallbacks.
- **TagLib**, **SoXR**, **libebur128**, **kissfft**, **dr_libs**, **stb_vorbis**, **utfcpp** —
  the audio engine would not exist without them.
- **@neteasecloudmusicapienhanced/api**, **@yakult-green-tea/qq-music-api**,
  **@unblockneteasemusic/server** — the online-music backend layers.
- **AMLL TTML DB** (<https://github.com/amll-dev/amll-ttml-db>, **CC0**) — word-level lyric
  data fetched at runtime, never redistributed.
- **LRCLIB** (<https://lrclib.net>) — line-level lyric fallback, fetched at runtime.

---

## 8. Non-software notices

- **Fonts.** The UI uses only fonts already present on Windows / common system fonts
  (`tokens.css:112-114`: Georgia, Times New Roman, Source Han Serif SC, Inter, Segoe UI,
  Microsoft YaHei, PingFang SC, Cascadia Code, JetBrains Mono, Consolas). **No font file is
  bundled**, so no font license is triggered. (An earlier design doc mentioned the OFL-licensed
  *Punctum* font; it was never integrated — `grep -r Punctum app/src` returns nothing.)
- **Icons / artwork.** `app/resources/stringmoon*.png`, `stringmoon.ico` and
  `app/src/renderer/public/stringmoon-icon.png` are original works of this project.
- **Music content.** Stringmoon ships **no** music, lyrics, or cover art. Everything played is
  either the user's own files or fetched from the user's own platform account at runtime.
  The API servers bundled in §5 are unofficial and are not affiliated with or endorsed by
  NetEase Cloud Music or Tencent QQ Music; users are responsible for their own accounts,
  the platforms' terms of service, and the copyright of the content they play.
- **Trademarks.** "Electron", "Node.js", "Chromium", "TagLib", "SoXR" and the other names
  above are the property of their respective owners and are used only for identification.

---

## Reporting

If you believe something in this file is wrong or a notice is missing, please open an issue
in the repository. We would rather fix a notice than argue about one.
