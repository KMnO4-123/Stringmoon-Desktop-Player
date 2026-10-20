# Moonrise startup integration

Approved reference: `design/startup-moonrise/preview.html`, 3.6-second Moonrise sequence.

1. Add failing unit tests for a bounded startup lifecycle: ready before/after the identity hold, delayed bootstrap fallback, skip, reduced motion, cleanup and responsive disc alignment. Run with `node --import ./tools/register-source.mjs --test tools/startup-sequence.test.mjs`.
2. Implement `startupSequence.ts`: `createStartupSequence({ reducedMotion, onExit, onComplete, schedule })` owns cancellable intro/deadline/exit timers. `ready()` resolves the loading gate, `skip()` starts a short dissolve, `finish()` handles hiding, and `dispose()` removes all work without completion. Normal timing is 2320ms intro + 1280ms exit; slow bootstrap is bounded at 5000ms before exit. Reduced motion is 250ms intro + 400ms dissolve with an earlier deadline.
3. Rebuild the approved SVG and motion as `components/startup/StartupIntro.tsx`, `startupMotion.ts` and `styles/startup.css`. Use existing fonts and new startup color/easing tokens in `tokens.css`. Read target bounds from the live record, scale the scene uniformly and recalculate the final landing when the window resizes. Native animations replace the preview transport loop. Cancel animations, observers and listeners on completion, skip, hide and unmount.
4. Mount the intro beside the live app shell in `App.tsx`, keep the shell inert until completion and signal readiness from `bootstrap().finally(...)`. Keep the component outside page transitions so navigation and tray restoration cannot replay it. Import the styles in `main.tsx`.
5. Run unit tests, `pnpm lint` and `pnpm build`. Verify actual Electron startup at 1280×800 and 900×600, natural completion, skip/Escape, reduced motion, resizing during exit, hide/restore and no remaining startup animations. Run existing Electron and listening interaction suites after building, sequentially and with isolated profiles. Keep the engine sources and executable unchanged.

The preview is retained as a design reference. Production uses the real application surface and inline SVG; no screenshot, video, network request or extra runtime dependency is added to startup.

Implemented and verified on 2026-10-16. `pnpm lint` and `pnpm build` passed; application tests passed 125/125, startup Electron checks 16/16, native Electron diagnostics 56/56, player interactions 64/64, listening interactions 35/35, and library interactions 27/27. Startup checks additionally verified retargeting while resizing, retained-node animation cancellation, native window hiding, runtime reduced motion changes, and unavailable animation support. No native audio engine remained after verification; the native engine executable hash was unchanged.

Windows visibility evidence required one adjustment: hiding a window did not immediately update `document.hidden` in the test session. The main process now forwards hide/minimize through the explicit `onWindowHidden` preload subscription; startup unsubscribes during cleanup. The identity component is memoized to isolate it from scan/transport telemetry rerenders.

GraphFlow context/plan/index tools were not exposed in this session. Available `gf_read` supplied targeted code anchors; an index refresh could not be requested.
