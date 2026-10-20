# Stringmoon icon

Final artwork (v8): minimalist black-and-white JK girl silhouette in front of a larger classic vaporwave moon. The 848-pixel disc uses a yellow / orange / pink / magenta / violet gradient with horizontal slices. The upper-right crown now has one smooth continuous arc instead of a double hump, while the lower locks and sailor silhouette remain. Exterior corners remain transparent.

The base illustration was generated through Figma's image generation tool (`gpt-image-2.5-sunburst`). Subsequent moon and hair cleanup edits use Pillow. V5 removed three connected purple artifacts; V7 cleaned the side lock; V8 redraws the requested crown edge with an antialiased Bezier contour. The full resolution source is saved locally; no temporary asset URL is required at runtime.

- `stringmoon-icon-source.png`: 1024 × 1024 master with transparent exterior corners.
- `stringmoon-icon-silhouette-v2.png`: unmodified generator output.
- `stringmoon-icon-vaporwave-v3.png`: previous purple crescent master.
- `stringmoon-icon-vaporwave-preview.png`: previous purple crescent preview.
- `stringmoon-icon-vaporwave-color-v4.png`: current full-color master.
- `stringmoon-icon-vaporwave-color-preview.png`: current 256 pixel preview.
- `stringmoon-icon-vaporwave-clean-v5.png`: current cleaned master.
- `stringmoon-icon-vaporwave-clean-preview.png`: current cleaned 256 pixel preview.
- `stringmoon-icon-hair-smooth-v7.png`: current smooth-hair master.
- `stringmoon-icon-hair-smooth-preview.png`: current smooth-hair 256 pixel preview.
- `stringmoon-icon-crown-v8.png`: current smooth-crown master.
- `stringmoon-icon-crown-preview.png`: current smooth-crown 256 pixel preview.
- `stringmoon.ico`: Windows icon with 16, 24, 32, 48, 64, 128 and 256 pixel frames.
- `stringmoon-icon.png`: 256 pixel preview.
- `../src/renderer/public/stringmoon-icon.png`: 64 pixel app brand and favicon.
- `stringmoon-icon-sizes.png`: small-size readability preview.
- `icon-archive/portrait-v1/`: previous portrait assets, replaced at the user's request.
- `icon-archive/jk-silhouette-v2/`: preceding flat-moon version.
- `icon-archive/vaporwave-v3/`: preceding purple vaporwave version.
- `icon-archive/vaporwave-color-v4/`: preceding full-color version with hair artifacts.
- `icon-archive/hair-clean-v5/`: preceding hair-cleaned version.
- `icon-archive/hair-smooth-v7/`: preceding smoothed side lock.

V4 edit recipe: disc centered at (476,449), radius 424. Gradient stops at 0 / .22 / .48 / .72 / 1: RGB (255,235,145), (255,169,104), (246,101,166), (198,66,191), (109,68,218). Increasing horizontal gaps reveal the tile. V5 removes the three extra connected components with bounds (117,674)–(163,720), (744,674)–(835,728), and (222,771)–(239,796).

V7 hair recipe: upper-right crown path runs from (580,174) through (770,160) and down to (764,531), with the interior redrawn as RGB (19,19,22), matching the original silhouette tile.

V8 crown recipe: replace only the top-right hair boundary with two connected cubic curves from (430,219) through (700,147) to (829,268), antialiased at 4x before downsampling.

V3 edit recipe: moon selection bounds (133, 87)–(609, 594), 61,546 pixels. Gradient stops at 0 / 0.48 / 1: RGB (205,176,255), (192,130,228), (125,77,194). Horizontal gaps at y 220–231, 292–309, 365–388, 441–470 and 518–551 reveal the original tile color.

Base illustration generation prompt (v2):

> Use case: logo-brand. Create ONE finished minimalist app icon for Stringmoon, a music player. User direction in Chinese: 黑白紫剪影的简约JK少女. STRICTLY a simple Japanese school-uniform girl SILHOUETTE logo, limited to 3 solid colors: near black, pure white, and one muted violet purple. A large elegant head-and-shoulders silhouette in three-quarter side profile facing slightly right. Long BLACK hair with a few very broad flowing locks and clean geometric bangs, blank WHITE face shape with no facial features, modest black Japanese sailor uniform with a bold white sailor collar and a single violet necktie. Distinctive understated JK school-uniform identity. Behind the head place one large flat violet crescent / partial circle, integrated with the hair silhouette. Near-black rounded-square tile, central graphic occupies roughly 76 percent of the square, generous safe margins. Extremely simple flat vector-style visual: approximately 8 to 12 broad filled shapes, crisp edges, carefully balanced negative space, calm premium music-brand identity, easily recognizable at 24px. NO detailed anime portrait, NO eyes, NO nose, NO mouth, NO blush, NO realistic shading, NO gradients, NO glow, NO textures, NO fine hair strands, NO headphones, NO small stars, NO lettering, NO watermark, NO mockup. A graphic silhouette emblem with black, white and violet only.
