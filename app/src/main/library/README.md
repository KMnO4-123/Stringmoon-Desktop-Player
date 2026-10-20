# library/ —— 曲库归一层（预留，M3 启用）

现状（M1）：曲库唯一来源是引擎的 `scan` + `list_tracks`（`EngineHost` 透传），应用侧只显示。

M3 接平台层后会出现第二个来源（在线搜索结果 / 歌单）。本目录届时承载**归一逻辑**：

- 平台 `Track`（含 `platformId`、`paytype` 归一 0/3、`durationSec×1000`）→ 统一 `TrackRow`
- 本地/在线双来源的 id 命名空间（引擎 `tl_NNNN` vs 平台 id，参照 QueMusic `hash` 槽位思路）
- 封面取色结果缓存（未来 `ColorExtractor` TS 移植，OffscreenCanvas；算法抄 QueMusic 前 6 步、光学处理用 SPEC §5.1 自己的第 7 步）

在出现两处来源之前，**此目录保持只有这份说明**（不建空壳代码）。
