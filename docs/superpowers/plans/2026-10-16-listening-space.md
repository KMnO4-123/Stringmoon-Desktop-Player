# Unified listening space

Goal: give lyrics most of the listening surface, move discovery beside it, and make immersion a continuous expansion of the same player.

Implementation uses the existing React, Motion, Three.js and independent meter store. Keep all changes in app/. The shared workspace has no Git repository; original touched files are preserved under .scratch/listening-2026-10-16/.

- [x] Keep MusicSpace mounted between home and immersive, preserving the record canvas and lyric scroll state. Move track metadata below the record and place artists / five-song preview in a separately scrolling right rail. Collapse the rail on demand and during immersion.
- [x] Add lyric follow / browse control, accessible click-to-seek, adjustable type size and translation visibility. Retain authoritative playback timestamps and the existing word fill pipeline.
- [x] Add an immersive bottom spectrum glow from real meter events. Pool a bounded number of frequency bins; write transforms directly without React frames. Unsubscribe while hidden, paused, disabled or reduced motion. Clear stale samples and all teardown resources.
- [x] Offer explicit playback-source controls: local library works; NetEase / QQ remain visibly unavailable until providers exist. Keep existing transport, native mute, four repeat modes, output path and parameter console.
- [x] Verify frequency pooling and freshness with unit tests; run lint, application tests, build, real Electron layout / interaction checks at 1280×800 and 900×600. Preserve engine work and do not stop another session's audio process.

Additional user steering implemented: rename to Stringmoon; generate and apply a black-haired anime girl icon to the window, Windows taskbar and renderer brand/favicon. Preserve legacy default userData and explicit test/custom profiles.

Engine boundary: production meter events and remote providers are still absent. Glow is verified by explicitly injected QA meter events through real preload IPC, not by fabricating live product data. GraphFlow exposes gf_read/edit/exec/macro only in this session; context, plan and index tools were unavailable.

Validation: pnpm lint; pnpm test:app; pnpm build; pnpm test:player against .smoke/qa-runtime/twilight-qa-2026-10-16.exe. Add focused mock-backed interface checks if the native audio endpoint is occupied.
