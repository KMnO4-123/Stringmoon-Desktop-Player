# Stringmoon · Moonrise

Approved design reference. The production startup is now implemented in `src/renderer/src/components/startup/StartupIntro.tsx` and uses the live application rather than this preview's snapshot.

- Open `preview.html` directly, or run `node design/startup-moonrise/serve.mjs` and visit http://127.0.0.1:5182.
- The preview has replay, pause, a scrubber, four chapter stops, skip, and reduced motion. Space toggles playback, R replays, Esc skips.
- `stringmoon-moonrise.mp4` is the review video. `stringmoon-moonrise.webm` is its 60 fps source. The motion is 3.6 seconds with a short final hold in the video.
- `hero.png` and `review-page.png` show the finished identity frame and the review surface.
- `preview.template.html` contains the SVG artwork and Web Animations timeline. `build-preview.mjs` embeds the local app snapshot into a standalone HTML file.
- The final transition uses a snapshot of the actual listening room with a real local track; it demonstrates the transition only.
- Figma storyboard: https://www.figma.com/design/WJQrCsOJohrDmvXbihFMgV?node-id=5-2

Motion: 0–0.6s a string is plucked; 0.4–1.5s the sliced vaporwave moon and JK silhouette appear; 1.5–2.3s the identity settles; 2.3–3.6s the circle becomes a record and gives way to the listening room.

The animation uses SVG, transforms and opacity with native Web Animations. No external fonts, images, video, WebGL, dependency or network request is needed at playback. Preview transport updates stop when playback ends; the preview pauses while hidden. The reduced motion alternative uses a brief crossfade.

Production integration preserves the 3.6-second motion when the library is ready, allows skip/Escape, follows reduced motion, and uses a bounded static hold during slow preparation. It cancels all startup work on completion/unmount and listens to native Electron hide/minimize events as well as page visibility. The disc landing follows the live record bounds, including window resizing during the exit. Navigation and tray restore do not replay it. Run `pnpm test:startup` for the Electron startup checks.
