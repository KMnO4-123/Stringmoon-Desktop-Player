# Audio Quality and Engine Roadmap

This is an implementation queue, not a contract. `CONTRACT.md`, `SPEC-v2.1.md`,
and accepted contract requests remain authoritative.

## Completed foundation

- The byte reader is isolated from codec and resampler code. Local files and
  HTTP streams share one small seek/read/size/error interface.
- HTTP reads require `206 Content-Range`, a bounded body, identity encoding, and
  a stable length. Strong ETag or Last-Modified is pinned with `If-Range` when
  supplied. Timeouts and sticky failures keep transport faults separate from
  decoder EOF.
- The feeder reads only what fits in the planar ring. Its cross-thread drained
  count is atomic, and source failures are handled before device recovery.
- A no-device reader test and a muted playback lifecycle test are available.

## Priorities

### P1: Live signal meter, accepted CR-015

The accepted event now has an RT-safe tap and control-thread aggregation for
RMS, sample peak, true-peak basis, 400 ms momentary loudness, limiter gain
reduction, 48 log-frequency bands, and 64 min/max waveform points. The tap reads
post-DSP, post-volume samples after the output buffer is submitted; the render
thread does no allocation, locking, or FFT. `engine/tools/test-playback-silent.mjs`
checks the event during muted real-device playback at three source rates.

The owner approved an additive visibility signal: `set_meter {enabled:boolean}`.
Push defaults to disabled. The Electron main process synchronizes show/hide and
minimize/restore, reapplying current visibility on engine restart. Hidden windows
receive no meter IPC, and the engine skips JSON serialization/push while retaining
analysis history. This gate changes neither samples nor the DSP quality state.

### P1: Transport identity and cancellation

When a server provides no strong validator, two equal-length versions of a
resource cannot be distinguished from Range metadata alone. The byte comparison
probe detects a mixed-version stream, but production playback has no independent
reference. The loopback proxy should pin an immutable resource revision for the
playback lifetime. Add explicit request cancellation tied to source teardown so
skip/stop does not wait for the receive timeout.

### P2: Headphone crossfeed fidelity

The current crossfeed is a one-pole approximation. Compare it with a measured
interaural-delay/filtered crossfeed implementation before adding more presets.
Acceptance: preserve unity perceived loudness within 0.2 dB on decorrelated
stereo noise, verify the opposite channel receives no high-frequency excess,
reset every filter state on seek/track change, and do level-matched listener A/B
tests on strongly panned material.

### P2: Natural peak protection

The limiter tracks sample peaks; inter-sample peaks can exceed 0 dBFS after
resampling or EQ. Add a measured oversampled true-peak ceiling with channel-linked
gain and a visible gain-reduction value. Test high-frequency full-scale tones,
oversampled impulse peaks, and release behavior without changing the neutral
path.

### P2: Gapless handoff

The output currently stops at EOF before the next queued source is opened. Keep
the device open for compatible consecutive tracks and predecode the next source
into a second bounded queue. Acceptance: no silent device restart, no overlap or
missing samples, bounded memory during long-track transitions, and an explicit
fallback when format changes require reopening.

### P3: Broader source formats

Use the source seam to add Ogg/Opus or other user-requested codecs without
spreading transport code into decoder callbacks. Each adapter needs local/HTTP
byte equivalence, random-seek samples, malformed-file coverage, and an honest
lossless/source-exact classification before it appears as supported.

## User-facing polish

- Keep `outputNotPerfectReason` focused on the active processing stages, with
  simple wording that does not expose internal reason tokens.
- Keep `sourceExact` separate from `outputPerfect`; explain a lossy source,
  resampling, shared-system mixing, and user-enabled DSP as distinct facts.
- Provide a safe level-matched comparison flow for crossfeed, width, ReplayGain,
  and output modes. Human listening remains a required check for tuning claims.
