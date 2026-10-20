# Local Library Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable local playlists, application-level metadata corrections, and responsive cross-field library search without changing the audio-engine protocol.

**Architecture:** The main process owns versioned JSON documents for playlists and track overrides; the preload exposes explicit validated operations. The renderer resolves saved paths against the engine catalog, builds a searchable metadata index when data changes, and passes the selected playlist context to the existing `set_queue` command.

**Tech Stack:** Electron main/preload IPC, TypeScript, React, Zustand, node:test, Playwright Electron checks.

**Spec:** `docs/superpowers/specs/2026-10-16-library-management-design.md`

**Status:** Complete  
**Verification:** `pnpm test:app` (112 passing), `pnpm lint`, `pnpm build`, Electron library/player/listening checks, and `tools/library-search-benchmark.mjs`.

## Global Constraints

- Do not change `CONTRACT.md`, `src/shared/protocol.ts` engine semantics, or `engine/`.
- Persist local media by `libraryPathKey(path)`, never by runtime `trackId`.
- Removing a library entry or playlist reference must never delete the media file.
- Preserve the pooled virtual-list row slots and fixed `--row-height` contract.
- Missing saved paths stay visible as unavailable and never enter `set_queue`.
- Do not add dependencies, provider login, smart playlists, M3U, or embedded-tag writes.
- The workspace is not a Git repository; verify each task without Git commits.

---

### Task 1: Persistent Playlist Store

**Files:**
- Create: `app/src/shared/playlists.ts`
- Create: `app/src/main/playlists.ts`
- Test: `app/tools/playlists.test.mjs`
- Reuse: `app/src/shared/library.ts` and the atomic temp-file rename pattern in `app/src/main/library-config.ts`

**Interfaces:**
- `PlaylistEntry = { path: string }`
- `SavedPlaylist = { id: string; name: string; createdAt: string; updatedAt: string; entries: PlaylistEntry[] }`
- `configurePlaylists(file: string): void`
- `readPlaylists(): Promise<SavedPlaylist[]>`
- `createPlaylist(name: string): Promise<SavedPlaylist[]>`
- `renamePlaylist(id: string, name: string): Promise<SavedPlaylist[]>`
- `deletePlaylist(id: string): Promise<SavedPlaylist[]>`
- `addPlaylistEntries(id: string, paths: string[]): Promise<SavedPlaylist[]>`
- `removePlaylistEntry(id: string, path: string): Promise<SavedPlaylist[]>`
- `reorderPlaylist(id: string, orderedPaths: string[]): Promise<SavedPlaylist[]>`

- [x] **Step 1: Write failing storage tests**

Add tests that configure an isolated temporary JSON file and assert:

```js
test('playlist mutations persist and path variants add only one entry', async () => {
  configurePlaylists(configFile)
  const [playlist] = await createPlaylist('Night drive')
  await addPlaylistEntries(playlist.id, ['D:/Music/A.flac', 'd:\\music\\a.flac'])
  assert.equal((await readPlaylists())[0].entries.length, 1)
})
```

Also cover rename, delete, removal, exact reorder validation, invalid names, corrupt-file recovery, failed-write preservation of the last good file, and reload from a fresh configuration instance. Use real temporary files rather than mocked filesystem calls.

- [x] **Step 2: Run the focused tests and verify the expected failure**

Run from `<仓库根>\app`:

```powershell
node --import ./tools/register-source.mjs --test tools/playlists.test.mjs
```

Expected: the test reports an assertion failure that the playlist store API cannot be loaded; catch a dynamic import error and fail with `assert.fail()` so Node reports a test failure rather than an uncaught module-load error.

- [x] **Step 3: Implement the minimal versioned JSON store**

Validate playlist names after trimming (1-80 characters), accept only absolute paths, generate IDs with `randomUUID()`, compare entries with `libraryPathKey()`, and make duplicate adds idempotent. `reorderPlaylist` must contain each existing normalized path exactly once. Persist `{ version: 1, playlists }` to `<file>.tmp`, then rename; do not replace the last good document when validation or writing fails.

- [x] **Step 4: Run the focused tests and confirm persistence and validation**

Run the same node:test command. Expected: all playlist store tests pass, including a new module configuration reading the saved file.

---

### Task 2: Application Metadata Overrides

**Files:**
- Create: `app/src/shared/track-overrides.ts`
- Create: `app/src/main/track-overrides.ts`
- Test: `app/tools/track-overrides.test.mjs`
- Reuse: `app/src/shared/library.ts`

**Interfaces:**
- `TrackMetadataOverride = Partial<{ title: string; artist: string; album: string; genre: string; year: number }>`
- `TrackOverrides = Record<string, TrackMetadataOverride>` keyed by `libraryPathKey(path)`
- `configureTrackOverrides(file: string): void`
- `readTrackOverrides(): Promise<TrackOverrides>`
- `setTrackOverride(path: string, patch: TrackMetadataOverride): Promise<TrackOverrides>`
- `resetTrackOverride(path: string, field?: keyof TrackMetadataOverride): Promise<TrackOverrides>`

- [x] **Step 1: Write failing override tests**

Test normalized-path lookup, trimmed string values, valid integer year, partial updates, per-field reset, full reset, missing paths retained, corrupt-file recovery, and persistence after reconfiguration.

```js
test('partial overrides survive path spelling changes and can reset one field', async () => {
  configureTrackOverrides(configFile)
  await setTrackOverride('D:/Music/A.flac', { title: 'Corrected title', artist: 'Test Artist' })
  await resetTrackOverride('d:\\music\\a.flac', 'artist')
  assert.deepEqual(await readTrackOverrides(), { 'd:\\music\\a.flac': { title: 'Corrected title' } })
})
```

- [x] **Step 2: Verify the focused tests fail for missing behavior**

Run:

```powershell
node --import ./tools/register-source.mjs --test tools/track-overrides.test.mjs
```

- [x] **Step 3: Implement a small versioned override store**

Use a separate `track-overrides.json` file, merge partial fields, remove empty override objects after reset, retain entries for missing files, and write atomically using the same good-file-preserving behavior as Task 1.

- [x] **Step 4: Run the focused override tests**

Run the same node:test command. Expected: all override behavior and reload tests pass.

---

### Task 3: Main-Process and Preload APIs

**Files:**
- Modify: `app/src/main/index.ts`
- Modify: `app/src/preload/index.ts`
- Modify: `app/src/preload/index.d.ts`
- Create: `app/src/renderer/src/libraryDataStore.ts`
- Test: `app/tools/test-electron.cjs` using its isolated `.smoke/qa/profile`
- Consume: playlist and override stores from Tasks 1-2

**Interfaces:**
- Expose typed `playlists`, `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `addPlaylistEntries`, `removePlaylistEntry`, and `reorderPlaylist` methods on `window.twilight`.
- Expose typed `trackOverrides`, `setTrackOverride`, and `resetTrackOverride` methods.
- Initialize `configurePlaylists(userData/playlists.json)` and `configureTrackOverrides(userData/track-overrides.json)` in `app.whenReady()`.
- Keep playlist and override snapshots in a separate renderer library-data store so playback, position, and meter events do not wake collection views.
- Load both snapshots once during app bootstrap and update renderer state only after each main-process mutation succeeds.

- [x] **Step 1: Add Electron tests for the allowlisted bridge**

Add browser-context assertions that the new methods round-trip playlist create/delete, return the override snapshot, reject invalid names, and do not expose `fs`, `child_process`, or a generic IPC invoke method. Keep these checks in the existing isolated QA profile so tests never mutate the user's real `userData`.

```js
const bridge = await page.evaluate(async () => {
  const before = await window.twilight.playlists()
  const after = await window.twilight.createPlaylist('UI test')
  return { before, after, hasFs: 'fs' in window.twilight }
})
```

- [x] **Step 2: Build and run the Electron test to verify it fails on missing bridge methods**

Run:

```powershell
pnpm build
pnpm test:electron
```

Expected: the new bridge assertion fails because the test app does not yet expose the typed playlist API.

- [x] **Step 3: Register explicit IPC handlers and preload wrappers**

Validate each argument in the main process before passing it to the stores. Keep every channel name literal and expose only typed one-purpose wrappers in preload and `index.d.ts`.

- [x] **Step 4: Rebuild and rerun Electron checks**

Run `pnpm build` followed by `pnpm test:electron`. Expected: new bridge checks and existing player checks pass in the isolated QA profile.

---

### Task 4: Indexed Cross-Field Search Model

**Files:**
- Modify: `app/src/renderer/src/libraryModel.ts`
- Modify: `app/src/renderer/src/display.ts` only if needed to apply overrides without changing protocol values
- Test: `app/tools/library-model.test.mjs`
- Consume: override types from Task 2

**Interfaces:**
- `buildSearchDocuments(tracks: Track[], overrides: TrackOverrides): SearchDocument[]`
- `filterSearchDocuments(documents: SearchDocument[], query: string, filters?: LibraryFilters): SearchDocument[]`
- `resolveTrackDisplay(track: Track, overrides?: TrackMetadataOverride): TrackDisplay`
- `SearchDocument = { key: string; track: Track; display: TrackDisplay; fields: string[]; normalizedFields: string[] }`
- `LibraryFilters = { artist?: string; album?: string; genre?: string; year?: number; codec?: string; folder?: string }`

- [x] **Step 1: Add failing search tests for all required fields**

Cover title, artist, album artist, album, genre, year, codec, filename/path, overrides, multiple tokens in any order, Latin diacritics, CJK, artist filters, and empty query.

```js
test('search tokens may match different metadata fields', () => {
  const docs = buildSearchDocuments(tracks, {})
  assert.deepEqual(filterSearchDocuments(docs, 'test artist live').map(x => x.track.trackId), ['tl_0001'])
})
```

- [x] **Step 2: Run `tools/library-model.test.mjs` and confirm the new tests fail**

Run:

```powershell
node --import ./tools/register-source.mjs --test tools/library-model.test.mjs
```

- [x] **Step 3: Implement normalized documents and pure filtering**

Normalize each searchable field once when the track snapshot or override map changes. Split queries on whitespace; require each token to match at least one field. Normalize case and Latin diacritics while preserving CJK. Do not add fuzzy search, timers, or workers.

- [x] **Step 4: Run the model tests and a non-asserting search benchmark**

Run the focused test and then measure 10,000 synthetic rows with `performance.now()` in a small test helper. Record the result; do not add a fragile wall-clock unit-test threshold.

---

### Task 5: Playlist Playback Context

**Files:**
- Modify: `app/src/renderer/src/ipc.ts`
- Modify: `app/src/renderer/src/libraryDataStore.ts`
- Test: `app/tools/playback-queue.test.mjs`
- Consume: main/preload playlist APIs from Task 3

**Interfaces:**
- `openAndPlay(trackId: string, queueTrackIds?: string[]): Promise<void>`
- When `queueTrackIds` is supplied, send it through `set_queue` before `open` and `play`.
- When it is omitted, retain the existing visible-library queue behavior.

- [x] **Step 1: Add failing playback-context tests**

Test queue order from a selected playlist, omission of missing/out-of-root entries, selected track inclusion, no change to the default library queue, rapid track selection superseding an older request, and queue-capability false behavior.

- [x] **Step 2: Run `tools/playback-queue.test.mjs` and confirm the new context cases fail**

Run:

```powershell
node --import ./tools/register-source.mjs --test tools/playback-queue.test.mjs
```

- [x] **Step 3: Implement explicit queue context**

Pass the selected playlist IDs at the UI call site. Preserve the current request sequence guard and begin-intent/fail-intent transitions. Never pass unavailable entries to `set_queue`.

- [x] **Step 4: Run playback queue and existing state tests**

Run:

```powershell
node --import ./tools/register-source.mjs --test tools/playback-queue.test.mjs tools/app-state.test.mjs
```

---

### Task 6: Songs and Playlists Workspace

**Files:**
- Modify: `app/src/renderer/src/components/LibraryList.tsx`
- Create: `app/src/renderer/src/components/PlaylistView.tsx`
- Modify: `app/src/renderer/src/App.tsx`
- Modify: `app/src/renderer/src/components/MusicSpace.tsx`
- Modify: `app/src/renderer/src/components/Playbar.tsx`
- Modify: `app/src/renderer/src/components/InfoPanel.tsx`
- Modify: `app/src/renderer/src/libraryModel.ts` artist grouping call sites
- Modify: the existing library styles under `app/src/renderer/src/styles/`
- Test: `app/tools/test-library-ui.mjs`

**Interfaces:**
- Library workspace tabs: Songs, Playlists, Artists.
- Song selection and actions use normalized path identity while virtual row elements keep slot keys.
- Playlist view receives resolved entries, unavailable-entry status, and callbacks; it does not own persistence.

- [x] **Step 1: Add failing UI checks for management workflows**

Cover switching among the three views, creating/renaming/deleting a playlist, adding/removing selected tracks, reorder controls accessible by keyboard, playing from a playlist, no duplicate adds, unavailable saved entries, sorting by each supported key, every metadata filter, and metadata override/reset feedback in the library, music space, information panel, artist view, and playbar.

- [x] **Step 2: Build and run `pnpm test:library` to verify new UI checks fail**

The UI test consumes `out/`, so build first:

```powershell
pnpm build
pnpm test:library
```

- [x] **Step 3: Implement the workspace with existing design tokens**

Use compact tabs and unframed workspace sections. Keep the shared search field visible in Songs and Playlists. Keep the existing artist masonry. Add selection actions and a playlist detail list with direct reorder buttons plus pointer reorder; no nested cards. Use `useDeferredValue` for query updates and keep the virtual list mounted only for the active long-list view. Resolve metadata overrides consistently in every track-facing component while leaving the engine's `Track` objects unchanged.

- [x] **Step 4: Run the library Electron checks at both supported sizes**

Run `pnpm build` and `pnpm test:library`. Expected: all new workflows pass at 1280-wide and 900x600, with no overlap with the playbar and the existing lyric-area floor preserved. A 10,000-track synthetic range test verifies bounded rows at initial and deep scroll positions; `tools/library-search-benchmark.mjs` measures index and query cost separately.

---

### Task 7: Full Verification

**Files:** none beyond completed tasks.

- [x] **Step 1: Run app tests, lint, and build**

```powershell
pnpm test:app
pnpm lint
pnpm build
```

- [x] **Step 2: Run Electron library and player checks**

```powershell
pnpm test:library
pnpm test:player
```

Run these only after the latest build and only if the native engine/audio endpoint is free; never stop another engine process.

- [x] **Step 3: Review the final behavior against the spec**

Verify that persisted references survive rescans, missing entries remain unavailable, file contents are never changed, only supported playlist IDs reach the engine, search stays virtualized, and all errors leave the last persisted document intact.

