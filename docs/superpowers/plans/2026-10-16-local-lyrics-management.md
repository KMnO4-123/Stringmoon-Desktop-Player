# Local Lyrics Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-managed local LRC sources and per-track timing offsets while preserving the existing low-load karaoke renderer.

**Architecture:** Pure lyric timing transforms stay outside the animation loop. A main-process repository owns source association, asynchronous file reads, bounded parsed-content caching, and JSON persistence; explicit preload APIs provide file selection and mutations.

**Tech Stack:** Electron main/preload IPC, Node `fs/promises`, TypeScript, React, existing LRC parser, node:test and Playwright Electron checks.

**Spec:** `docs/superpowers/specs/2026-10-16-local-lyrics-management-design.md`

**Status:** Complete  
**Verification:** `pnpm test:app` (112 passing), `pnpm lint`, `pnpm build`, and Electron listening checks at 1280×800 and 900×600.

## Global Constraints

- Do not change `CONTRACT.md`, the audio engine, or the shared `Lyrics` protocol shape.
- Persist lyric association and offset by `libraryPathKey(audioPath)`, never by runtime `trackId`.
- User LRC files are read-only; never rewrite source timestamps or files.
- Production source priority is attached LRC, same-name sidecar, then no lyrics; demo fixtures are explicit test/smoke input only.
- Offset range is -10,000..10,000 ms in 50 ms steps and is applied once per track/offset change.
- Keep direct DOM painting, visibility gates, reduced-motion behavior, and stale-response protection.
- The workspace is not a Git repository; verify each task without Git commits.

---

### Task 1: Pure Offset Transform and Source-Selection Tests

**Files:**
- Create: `app/src/shared/lyrics-model.ts`
- Test: `app/tools/lyrics-management.test.mjs`
- Reuse: `app/src/shared/lrc.ts`, `app/src/shared/protocol.ts`

**Interfaces:**
- `LyricsSourceResult = { lyrics: Lyrics; resolvedPath: string; source: 'attached' | 'sidecar' }`
- `applyLyricsOffset(lyrics: Lyrics, offsetMs: number): Lyrics`
- `selectLyricsSource(attached: LyricsSourceResult | null, sidecar: LyricsSourceResult | null): LyricsSourceResult | null`

- [x] **Step 1: Write failing pure-model tests**

Cover attached-source priority, sidecar fallback, no source, invalid offsets, positive/negative line and word shifts, zero clamping, unchanged text/translation/romanization, and original object immutability.

```js
test('offset shifts line and word timestamps without mutating source lyrics', () => {
  const adjusted = applyLyricsOffset(lyrics, -500)
  assert.equal(adjusted.lines[0].startMs, 0)
  assert.equal(adjusted.lines[0].words[0].endMs, lyrics.lines[0].words[0].endMs - 500)
  assert.equal(lyrics.lines[0].startMs, 200)
})
```

- [x] **Step 2: Run the focused test and confirm it fails for missing exports**

Run:

```powershell
node --import ./tools/register-source.mjs --test tools/lyrics-management.test.mjs
```

- [x] **Step 3: Implement immutable validation and offset transform**

Reject non-integer/out-of-range offsets. Clone only the line and word records whose timestamps change; clamp shifted timestamps at zero. Keep text fields and source files untouched.

- [x] **Step 4: Run the focused test and existing lyric timing tests**

```powershell
node --import ./tools/register-source.mjs --test tools/lyrics-management.test.mjs tools/lyrics.test.mjs
```

---

### Task 2: Asynchronous Lyrics Repository and Cache

**Files:**
- Modify: `app/src/main/lyrics.ts` or create `app/src/main/lyrics-repository.ts` and keep `lyrics.ts` as a compatibility wrapper
- Create: `app/src/main/lyrics-config.ts` if persistence is kept separate from source resolution
- Test: `app/tools/lyrics-management.test.mjs`
- Reuse: `app/src/shared/library.ts`, `app/src/shared/lrc.ts`

**Interfaces:**
- `LyricsConfig = { version: 1; tracks: Record<string, { attachedPath?: string; offsetMs: number }> }`
- `configureLyrics(file: string): void`
- `loadLyrics(audioPath: string): Promise<LyricsLoadResult>`
- `attachLyrics(audioPath: string, lrcPath: string): Promise<LyricsConfig>`
- `clearAttachedLyrics(audioPath: string): Promise<LyricsConfig>`
- `setLyricsOffset(audioPath: string, offsetMs: number): Promise<LyricsConfig>`
- `LyricsLoadResult = { lyrics: Lyrics | null; resolvedPath: string | null; source: 'attached' | 'sidecar' | 'none'; attachedUnavailable: boolean; offsetMs: number }`

- [x] **Step 1: Add failing repository tests**

Use temporary audio and LRC files to test source priority, sidecar fallback, no demo fixture in ordinary production resolution, missing attached-source reporting, valid/invalid LRC handling, offset persistence, and stale file changes.

- [x] **Step 2: Verify tests fail because the repository/config behavior is missing**

Run the focused node:test command from Task 1.

- [x] **Step 3: Implement asynchronous resolution and versioned persistence**

Read with `fs/promises`, validate `.lrc`, parse through `parseLrc`, retain missing associations, and atomically write a versioned `userData/lyrics.json`. `loadLyrics` returns no fixture unless an explicit test/smoke option is passed.

- [x] **Step 4: Add and test a bounded LRU cache**

Cache parsed source content by normalized source path plus `mtimeMs` and file size. Limit to 128 entries and 8 MiB estimated retained text. Evict least-recently-used entries until both limits hold. Test cache hit, file-change invalidation, and both eviction limits.

- [x] **Step 5: Run repository and parser tests**

```powershell
node --import ./tools/register-source.mjs --test tools/lyrics-management.test.mjs tools/lyrics.test.mjs
```

---

### Task 3: Main IPC and LRC File Picker

**Files:**
- Modify: `app/src/main/index.ts`
- Modify: `app/src/preload/index.ts`
- Modify: `app/src/preload/index.d.ts`
- Modify: `app/tools/test-electron.cjs`
- Consume: repository APIs from Task 2

**Interfaces:**
- `window.twilight.loadLyrics({ path })`
- `window.twilight.attachLyrics({ audioPath, lrcPath })`
- `window.twilight.chooseLyrics(audioPath)` returns a selected LRC path or `null`
- `window.twilight.clearAttachedLyrics(audioPath)`
- `window.twilight.setLyricsOffset({ audioPath, offsetMs })`

- [x] **Step 1: Add failing Electron bridge tests**

Verify cancel returns `null`, non-LRC paths are rejected, a selected path is persisted, and preload exposes only the explicit lyric functions.

- [x] **Step 2: Build and run Electron tests to confirm missing bridge behavior**

```powershell
pnpm build
pnpm test:electron
```

- [x] **Step 3: Register explicit handlers and a filtered LRC picker**

Use `dialog.showOpenDialog` with `openFile` and an `lrc` extension filter. Validate paths again in the main process. Initialize `configureLyrics(userData/lyrics.json)` during app startup.

- [x] **Step 4: Rebuild and rerun Electron bridge tests**

Run `pnpm build` then `pnpm test:electron`; expect all bridge checks to pass.

---

### Task 4: Lyrics Toolbar and Offset Behavior

**Files:**
- Modify: `app/src/renderer/src/components/LyricsView.tsx`
- Modify: `app/src/renderer/src/ipc.ts` only if a dedicated lyric action wrapper belongs there
- Modify: `app/src/renderer/src/styles/listening.css` and `app/src/renderer/src/styles/theme.css` if required
- Test: `app/tools/test-listening-ui.mjs`
- Consume: bridge and pure transform from Tasks 1-3

**Interfaces:**
- The lyric view loads `{ lyrics, resolvedPath, source, attachedUnavailable, offsetMs }`.
- It constructs adjusted lyrics only when the loaded source or `offsetMs` changes.
- Lyric click and keyboard seek use the adjusted `line.startMs`.

- [x] **Step 1: Add failing UI checks**

Cover attached/sidecar/no-lyrics labels, attach/cancel/clear actions, +/-50 ms offset buttons, numeric offset entry and reset, seeking with adjusted line time, keyboard accessibility, and missing attachment fallback.

- [x] **Step 2: Build and run `pnpm test:listening` to confirm the new assertions fail**

```powershell
pnpm build
pnpm test:listening
```

- [x] **Step 3: Implement controls without touching the frame loop**

Keep all persistence operations in explicit event handlers. Feed the adjusted model to `activeLineIndex`, `wordFill`, and line seeking; do not create the adjusted model in position subscriptions or `requestAnimationFrame` callbacks. Keep source controls compact and preserve existing toolbar behavior.

- [x] **Step 4: Rebuild and rerun lyric UI checks**

Run `pnpm build` and `pnpm test:listening`. Expected: lyric attach/offset UI works and existing continuous word-fill checks remain green.

---

### Task 5: Full Verification

**Files:** none beyond completed tasks.

- [x] **Step 1: Run app tests, lint, and build**

```powershell
pnpm test:app
pnpm lint
pnpm build
```

- [x] **Step 2: Run Electron listening-view checks**

```powershell
pnpm test:listening
```

Run after the latest build and only while the native audio endpoint is free; never stop another engine process.

- [x] **Step 3: Review lyric performance and source truthfulness**

Verify no normal production path returns demo fixtures, attached files remain unchanged, cache limits are enforced, stale results cannot replace the current track, and no extra per-frame React work was introduced.

