# Cover and Playback Console Plan

**Goal:** Display actual local cover art when available, animate cover/record changes, make room for lyrics, and expose authoritative playback parameters.

**Architecture:** Main-process artwork reader returns bounded image data through a narrow preload method. Renderer caches the current artwork, derives a restrained surface accent, and renders a track-keyed cover plus existing 3D record. Engine state and track metadata remain the sole parameter sources. The existing EQ response remains a static transfer curve and becomes compact on the home view.

**Constraints:** No audio samples through JSON, no fake FFT, no changes to engine or frozen contract. Missing covers use labeled typographic art. Theme changes never recolor C1 severity or C2 semantics. Honor reduced motion and transparency. All static styling remains tokenized.

## Tasks

- [x] Add artwork reader for embedded and sidecar images with size/type bounds, cache, IPC bridge, and failure tests.
- [x] Add artwork hook/theme extraction and track-keyed cover/record transition in home and immersive views; reuse cover in playbar.
- [x] Recompose home to give lyrics and cover priority; shrink compact EQ, improve playback, controls and EQ panel ergonomics.
- [x] Add song source details and current output/device/DSP detail panel from confirmed metadata and state.
- [x] Build, run unit and real Electron tests, inspect 1280×800 and 900×600 screenshots and pixel changes.

Final evidence: 45 app tests, 35 actual player UI checks, 33 Electron regression checks; type/token/build and 11 C2 / 31 mock / 19 real engine checks pass. Selected artwork tests use a separate profile. Output precision comes from containerBits/validBits rather than source bitDepth. Real next/previous needed set_queue before manual open; this integration is now covered.
