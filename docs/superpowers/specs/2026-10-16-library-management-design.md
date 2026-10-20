# Local Library Management Design

**Status:** Approved and implemented  
**Date:** 2026-10-16

## Goal

Make local song discovery and saved playlists a coherent, persistent workflow while keeping the audio engine authoritative for playback and preserving the existing large-library performance model.

## Current State

- The engine scans configured folders and returns tracks. The renderer filters the engine catalog to the configured library roots and deduplicates path variants.
- The library page has a song/artist switch, a title-and-artist text filter, and a virtualized song list. It does not have persistent playlists or metadata correction controls.
- Manual playback sends the visible library's track IDs as the engine queue. The engine extension exposes `set_queue`, but no command to read back or edit the live queue.
- `libraryPathKey()` provides the existing Windows path identity rule. `trackId` is an engine runtime identifier and is not a suitable key for saved user data.
- Library-directory settings already use a separate main-process JSON file and atomic replacement. File deletion is outside the library-directory contract.

## Product Boundaries

1. This phase manages local files and application metadata only. It does not implement provider login, remote playlists, remote search, or online lyrics.
2. The design leaves room for future provider-owned track identities, but provider records are not mixed into the local path key.
3. No audio-engine protocol or `engine/` changes are required.
4. The app never deletes a song file when removing a library folder, playlist entry, or metadata override.
5. Tag editing inside audio files, content-hash duplicate detection, smart playlists, and M3U/PLS import/export are out of scope for the first implementation.

## Information Architecture

Extend the existing library workspace with three views: **Songs**, **Playlists**, and **Artists**. Keep the current sidebar navigation and use one shared library search field above the active view. Preserve the existing compact row density, design tokens, keyboard accessibility, and virtualized rendering for long song and playlist lists.

The Songs view supports sorting by title, artist, album, duration, and file path; filtering by available metadata such as artist, album, genre, year, codec, and folder; multi-selection; play; and add-to-playlist. Metadata corrections are application-level overrides rather than writes to the audio file. An override can change the displayed title, artist, album, genre, or year and can be reset independently.

The Playlists view separates saved playlists from the engine's temporary playback queue. It supports create, rename, delete, add selected songs, remove entries, manual reorder, and play from a playlist. Playlist playback sends that playlist's currently resolved track IDs through the existing `set_queue` command before opening the selected track. Editing a saved playlist does not silently mutate a queue already sent to the engine; the next explicit playlist play applies the new order. Because the engine has no queue-read command, the UI must not claim it can display or edit arbitrary engine queue state.

## Data Model and Persistence

Persist playlists in `userData/playlists.json`, separate from `library.json`. Persist application metadata overrides in `userData/track-overrides.json`. Both files are owned by the main process and written with the existing temporary-file-plus-rename pattern.

The playlist document is versioned:

```json
{
  "version": 1,
  "playlists": [
    {
      "id": "stable-app-generated-id",
      "name": "Late night",
      "createdAt": "2026-10-16T00:00:00.000Z",
      "updatedAt": "2026-10-16T00:00:00.000Z",
      "entries": [{ "path": "D:\\Music\\track.flac" }]
    }
  ]
}
```

Persist the original path for display and recovery, and derive its comparison key with `libraryPathKey()` when loading. Do not persist `trackId`. Preserve entries whose files are missing or are outside the currently scanned roots; render them as unavailable and do not send them to the engine. The first implementation does not allow duplicate paths inside one playlist. Re-adding an existing entry is idempotent.

Metadata overrides are keyed by the same normalized path identity. Missing paths retain their overrides so a moved folder can be restored without losing user corrections. Invalid or corrupt configuration must degrade to an empty collection with a visible non-blocking notice; it must not break app startup.

Renderer access is limited to explicit preload methods for listing and mutating playlists and overrides. The renderer never receives filesystem access. All mutation inputs are validated in the main process, including non-empty bounded playlist names, known operation shapes, and absolute paths.

## Search and Performance

Search matches normalized tokens against displayed title, artist, album artist, album, genre, year, codec, filename, and path. Every whitespace-separated query token must match somewhere in the searchable fields; matching is case-insensitive and ignores Latin diacritics while preserving CJK text. Search scope follows the active view: the full visible library in Songs, entries in the selected playlist in Playlists, and artist names in Artists.

Build normalized search documents when the engine track snapshot or metadata overrides change, not on every keystroke. Keep filtering pure and memoized. Use React deferred input state to keep typing responsive. Do not add a worker or fuzzy edit-distance search until measurement demonstrates that indexed filtering misses its interaction budget.

Keep the existing virtual-list strategy and fixed row-height contract. Search must not expand all rows into the DOM. Use normalized path identity for selection and per-track actions; retain slot keys for the intentionally pooled virtual row elements. The target is an interactive input with no main-thread task over 50 ms for a 10,000-track synthetic fixture on the supported test machine; this is a benchmark target, not a timing assertion in a unit test.

## Error and Empty States

- An empty library offers folder selection; an empty search result offers a one-action clear-filter control.
- A playlist with unresolved entries reports their count and preserves them. Playback skips unresolved entries and reports when no playable entries remain.
- Folder removal affects library visibility but does not remove files or saved playlist references.
- Failed persistence leaves the prior saved document intact and reports an actionable error. UI state must not falsely present a failed write as durable.
- Metadata overrides are visibly distinguished from embedded file tags and can be reset per field or per track.

## Acceptance Checks

1. Playlist create, rename, reorder, add/remove, delete, reload persistence, and corrupt-file recovery have focused main-process tests.
2. A rescan that produces new `trackId` values still resolves playlist entries by normalized path.
3. Missing playlist files remain visible as unavailable, are not passed to `set_queue`, and recover when the same path returns.
4. Search tests cover each metadata field, token order independence, diacritics, CJK, artist filters, and overrides.
5. UI tests cover keyboard navigation, multi-selection, playlist operations, empty states, and queue handoff.
6. Electron visual checks at 1280-wide and 900x600 retain the existing lyric-space minimum and avoid overlap with the playbar.
7. A synthetic 10,000-track virtual-range test verifies bounded row windows at initial and deep scroll positions; a measured benchmark checks indexing and filtering cost.

## Delivery Order

1. Add the main-process playlist/override stores and tests.
2. Add renderer store actions and the Songs/Playlists/Artists workspace, using the existing queue command.
3. Expand indexed search and add focused performance and Electron checks.
4. Implement local lyric-source management in a separate design and implementation plan.
5. Revisit M3U import/export and online provider libraries after the local workflow is stable.

## Review Notes

- Keep `CONTRACT.md`, engine protocol semantics, and engine ownership unchanged.
- Retain files under `docs/superpowers/specs/` and review this specification before writing the implementation plan.
- The current workspace is not a Git repository, so this specification cannot be committed here.
