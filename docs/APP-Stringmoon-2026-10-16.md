# Stringmoon · 本轮应用改动与验收

本轮按用户要求调整聆听布局，并追加更名 Stringmoon、制作与应用二次元黑发少女图标。工作范围为 `app/`，未修改引擎。

## 已落地

- 音乐空间改为唱片与精简元数据、歌词主列、右侧探索栏。艺术家和五首歌曲速览不再排在主舞台下方。探索栏独立滚动、可收放。
- 音乐空间和沉浸模式共用同一个 `MusicSpace`。切换不销毁 WebGL 画布、歌词 DOM 或浏览状态。沉浸时卸载额外 EQ / 监测面板，收起导航与探索栏。
- 歌词支持鼠标或键盘浏览、回到当前句、点击或 Enter/空格跳转、字号切换与翻译/罗马音开关。跟随时观察容器尺寸，暂停状态下切换布局也能重新居中。F 切换沉浸、Escape 返回。
- 修复未唱歌词透明不可读的问题；未来歌词以低亮度文字显示。滚动区改用独立占位元素，避免百分比 padding 挤出小窗口。
- 沉浸底部新增 40 条频谱光带。仅消费真实 meter 数据，通过 transform/opacity 更新，不使用 React 逐帧状态或持续 rAF。暂停、关闭、离屏、页面隐藏、减少动态效果时断开；450 ms 未收到新数据即清空。手动换曲开始及确认时丢弃旧频谱，避免旧曲光效挂到新曲上。
- 保留现有播放栏的播放/暂停、上一首/下一首、原生静音、四态循环、进度、输出模式和播放参数台。右侧播放来源面板支持添加本地音乐，在线服务显示真实未接入状态。
- 品牌、窗口标题、唱片排印、应用名称和 favicon 更新为 Stringmoon。图标为简约 JK 少女剪影，月亮按用户最新要求放大，改为经典黄橙、粉红、紫色渐变与水平切片的彩色蒸汽波风格；并修顺右上头顶发弧，移除脱离的紫色弧形发束和切片侵入。Windows ICO 包含 7 种尺寸。生成来源、提示词与文件列表见 `app/resources/stringmoon-icon.md`。
- 兼容 Electron 在执行主入口前根据 productName 改名的行为：默认 Stringmoon 配置目录映射回原 `twilight-echo-app`，显式自定义目录和测试目录保持有效。

## 验证

固定引擎副本：`app/.smoke/qa-runtime/twilight-qa-2026-10-16.exe`。窗口验证前已重新 build。

| 检查 | 结果 |
|---|---|
| `pnpm lint` | 类型检查通过，0 设计令牌违规 |
| `pnpm build` | 成功，已更新 out/ |
| `pnpm test:app` | 78 通过 |
| `pnpm test:c2` | 11 通过 |
| `pnpm test:protocol` | 42 通过 |
| `pnpm test:electron` | 53 通过 / 0 失败 |
| `pnpm test:player` | 64 通过 |
| `pnpm test:listening` | 35 通过 |
| 曲库目录集合回归 | 17 通过，使用独立临时目录运行同一脚本副本 |

新增界面测试覆盖 1280×800 与 900×600、侧栏相对位置、封面方形、歌词空间、浏览与真实引擎 seek、沉浸前后画布身份、字号、过期频谱、暂停与减少动态效果、可见性信号清理、改名前后的配置目录。实测歌词列约 385 px / 331 px 高。

测试宿主禁用后台节流，会让 Chromium 强制可见；因此隐藏生命周期由明确注入的浏览器 visibilitychange 信号验证。频谱测试数据也明确从测试宿主经真实 preload IPC 注入，并在普通界面截图前换曲清除。

原 `.smoke/library/` 目录被占用，不能清理。没有停止别人的进程；副本脚本是 `.smoke/verify-library-stringmoon.mjs`，只读写 `.smoke/stringmoon-library-check/`。

预览：`app/.smoke/listening/music-space-1280.png`、`music-space-900.png`、`immersive-1280.png`。

## 仍依赖外部能力

当前固定引擎不推送 CR-015 `meter`，生产界面如实等待数据，不能将测试频谱当作真实播放证据。网易云 / QQ provider 尚未接入。本轮没有实现远程账号、在线搜索或远程音频代理。

GraphFlow 当前只开放 gf_read / gf_edit / gf_exec / gf_macro，已使用 gf_read 定位与复核；context / plan / index 接口未开放，未声称完成重建图谱。
