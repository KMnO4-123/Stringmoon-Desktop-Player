# Music Space Implementation Plan

**Goal:** 将现有文件列表主界面改为音乐空间，提供真实 EQ 频响、沉浸播放、3D 唱片、艺术家瀑布布局与有限弹性动效。

**Architecture:** 播放仍由现有 C++ 引擎负责，React 只消费状态。EQ 使用已接受的 CR-008 命令与 OfflineAudioContext 计算参数的稳态频响；Three.js 负责唱片场景，Motion 负责路由、列表和指针弹性。GraphFlow 查询仅返回 ok，本轮按已有文件路径定向读取。

**Tech Stack:** Electron/React/TypeScript/Zustand，新增 Motion、Three.js。

**Spec:** 用户 2026-10-15 最新布局与动效要求；CONTRACT/SPEC 音频边界保持，新的表现层允许景深、视差、果冻与瀑布入场。

## Constraints

- 不修改 engine/、CONTRACT 或 SPEC，不把音频样本搬到 UI；不假造 FFT 或实时频谱。
- 无封面时用唱片/艺术家分组视觉，不声称是原专辑封面。
- 限制动画生命周期：暂停、文档隐藏、画布不可见和 reduced-motion 均有明确降级。
- 所有颜色、字号、曲线及时长保持令牌约束，棘轮基线为零。
- 无 Git 元数据，验证后记录文件与测试结果，不创建虚假提交。

## Task 1 · EQ response (independent worker)

- [x] 在 shared/protocol.ts、store.ts、ipc.ts 接入已裁定 set_eq 与完整 dsp 快照，防止请求竞争与旧回复覆盖。
- [x] 新建 audio/FrequencyPanel.tsx，默认导出 `{compact?: boolean, onExpand?: () => void}`。
- [x] 原生离线 Biquad 响应、对数频轴、十段控制、预设、旁路、有限形变和真实参数历史轨迹。
- [x] 单元/浏览器验证平直、中心增益、边界、禁用及失败恢复。

## Task 2 · 3D record (independent worker)

- [x] 新建 RecordStage.tsx/recordScene.ts，props title/artist/playing/compact/className。
- [x] Three.js 唱片、真实曲目标签、物理光照、指针视差和阻尼复位。
- [x] ResizeObserver/IntersectionObserver/visibilitychange/reduced-motion 控制渲染与清理。
- [x] Electron 像素、交互与窄窗口验证。

## Task 3 · Player layout (root)

- [x] App 视图导航：音乐空间、曲库、沉浸播放、音效，全部提供实际内容。
- [x] 音乐空间以唱片与当前曲目为重心；艺术家分组、可播放歌曲速览；曲库支持歌曲/艺术家视图与过滤。
- [x] 播放栏重新分配元数据/控制/音量空间，信号路径改为可展开信息，保留状态可读性。
- [x] 加入景深切换、瀑布错落入场、卡片视差和果冻反馈；不移动工具按钮命中区域。
- [x] 调整 LyricsView 为侧栏预览和沉浸阅读共用，位置仍来自引擎。

## Task 4 · Integration and evidence

- [x] 保留并扩展已有协议/状态/歌词测试；增加实际 EQ 命令、导航、搜索/分组、图表和 WebGL 像素检查。
- [x] lint、build、app/c2/protocol/integration/Electron 检查；900×600、1280×800 与 reduced-motion 验证。
- [x] 保存正常数据和测试场景截图，明确实时 FFT 尚未提供的边界。
