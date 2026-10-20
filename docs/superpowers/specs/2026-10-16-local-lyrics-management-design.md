# Local Lyrics Management Design

**Status:** Approved and implemented  
**Date:** 2026-10-16

## Goal

Give users clear control over local lyric sources and per-track synchronization without changing the frozen audio protocol or increasing the cost of the existing karaoke renderer.

## Current State

- The main process resolves a same-directory, same-name `.lrc` first, then packaged fixture lyrics, including demos.
- The LRC parser normalizes line, translation, romanization, and word-level timing into the existing shared `Lyrics` shape.
- The renderer protects against stale async responses, follows the active line, lets users seek by lyric line, and paints word progress without React re-rendering on every frame.
- Lyrics are read synchronously in the main process. There is no user-managed association for a separately located `.lrc` file and no per-track offset.

## Product Boundaries

1. This phase supports local LRC files and does not query online lyric services.
2. It does not alter `CONTRACT.md`, `Lyrics` protocol semantics, or the audio engine.
3. Packaged demo lyrics are test fixtures only. A release build with no matching lyrics must show an honest no-lyrics state.
4. The app never edits the chosen LRC file in place. Source text and timing remain untouched.

## Source Selection

Use this priority:

1. A user-attached local LRC file for the current audio path.
2. A same-directory, same-stem `.lrc` file beside the audio.
3. No lyrics.

If an attached file is missing or invalid, retain the association and report it as unavailable, then try the sidecar. Keep the source label visible and specific: **Attached LRC**, **Sidecar LRC**, or **No lyrics**. Demo fixtures can be injected explicitly by tests or smoke mode but must never be a normal production fallback.

## Data and Main-Process Boundary

Persist associations and offsets in a versioned `userData/lyrics.json`, keyed by normalized audio path using `libraryPathKey()`. Store the user-selected LRC path separately from the original audio path. Store a signed integer `offsetMs` in the range -10,000 to +10,000 with 50 ms steps. The offset is an application preference; it never rewrites source timestamps.

Use explicit preload operations to choose an LRC file, read resolved lyrics, save/reset an association, and save/reset an offset. Validate selected file type and request shape in the main process. Do not expose general filesystem access to the renderer.

Read lyric sources asynchronously. Keep parsed lyric content in a bounded LRU cache keyed by source path, modification time, and file size; cap both entry count and retained estimated bytes. Keep offsets outside the parsed-source cache. Applying an offset creates a per-track adjusted model once when the track or offset changes, never inside the animation frame loop.

## Interaction Design

Keep the current lyrics column and toolbar. Add an accessible source action with commands to attach an LRC, restore automatic sidecar selection, or clear an attached source. Add a compact synchronization control showing the current signed offset in milliseconds, with 50 ms decrease/increase buttons, a numeric entry, and reset. Use tooltips for icon-only actions. Keep translation/romanization toggles and lyric-size/follow controls as they are.

Applying an offset shifts line start/end and word start/end together. Clamp shifted timestamps at zero for rendering, but retain the signed configured offset so resetting remains exact. Clicking a lyric seeks to its adjusted start time. Empty and unavailable states show the source and a direct attach action without replacing the lyric area with instructional copy.

## Performance and Correctness

- Preserve `LyricsView`'s visible-position subscription and direct DOM paint path.
- Do not recalculate adjusted lyrics on every position event or animation frame.
- Do not load or parse a lyric file for a track that has already been superseded; retain the existing stale-response guard.
- When the lyrics view is offscreen or the document is hidden, preserve existing animation gates.
- Cache invalidation uses source mtime and size; a changed LRC is reparsed without requiring an app restart.

## Acceptance Checks

1. Attached source wins over sidecar, sidecar wins over no lyrics, and packaged demo files never appear in production resolution.
2. Missing attachments are reported and the sidecar fallback remains available.
3. Offset tests verify line timing, word timing, seeking, negative offsets, zero clamping, and reset.
4. Async read tests cover rapid track changes and stale results.
5. Cache tests cover hits, mtime/size invalidation, and eviction at configured limits.
6. Electron UI checks cover file selection, source labels, keyboard-accessible offset controls, and visible empty/error states.
7. Existing karaoke timing and rendering tests continue to pass, and long-lyric DOM/frame work does not regress.

## Delivery Order

1. Add a pure offset transform and source-priority tests.
2. Add async source resolution, versioned persistence, and bounded cache.
3. Add preload methods and lyrics toolbar interactions.
4. Run app tests, type checking, build, and Electron listening-view checks at desktop and compact window sizes.

## Review Notes

- This is a separate deliverable from the library/playlists workspace because lyrics source ownership and timing state have different lifecycle and validation needs.
- Keep both data files keyed by the existing path identity rule; do not use runtime `trackId` for persistence.
- The current workspace is not a Git repository, so this specification cannot be committed here.
