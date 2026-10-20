# 应用侧实现与验收 · 2026-10-15

本轮落实协议/C2接入、歌词更新优化、Nothing/Apple 视觉要求，以及后续追加的音乐空间和动态频响。基准为 DESIGN-v5-encoding.md；不改变 CONTRACT 或 SPEC。CR-008 的 EQ 参数命令现已由 owner 接受，应用侧只消费已确认回复。

## 已实现

- `app/src/shared/protocol.ts` 接入 CR-009 的可选 DSP 字段、错误分类和 xrun 会话累计语义；扩展请求保留独立类型。`get_state` 可含 CR-008 DSP 详情，C2 使用顶层权威状态字段，不由参数推断效果。
- `app/src/renderer/src/ipc.ts` 在启动/ready 时握手并应用快照。修复 ready 晚于 hello 导致能力被清空的竞态：在途期间收到 ready 会补一次同步，无周期轮询。
- 错误经过主进程、preload 后仍保留 `code/kind`。应用内部采用结构化结果 envelope，在渲染层重建 Error；引擎协议不变。
- 断连使用独立 IPC 通道与 `connectionError`，恢复成功只清断连错误，保留协议解析诊断。
- `store.ts` 保存 DSP 能力/生效状态/模块名和权威 xrun 累计值，处理无曲目、未报告输出模式、暂停快照位置；相同高频进度不再通知全局 store。
- 真实 `engine/fixtures/state-traces.json` 已通过 store → C2 selector → encoder 回放，覆盖 DSP 开启/关闭、BP、真实独占回退共享。读取 fixture，未修改引擎文件。
- 歌词在文档隐藏或侧栏折叠时停止进度订阅，恢复时读取最新引擎快照；未增加 rAF 或本地计时。按曲目及路径隔离异步结果；翻译与罗马音分行显示，原文组合字符保持不拆分。
- C1 直接响应 xrun/设备变更/扫描完成，有限闪光结束后清理；移除原 100ms 轮询，并修复降级慢闪覆盖事件闪光的问题。

## 视觉系统

- 旧 theme.css 的蓝灰色覆盖、重复渐变、标题装饰性循环动画和按钮缩放已移除。中性色来自 v5 令牌，红色用于真实错误，降级使用琥珀虚线。
- 使用 Lucide React 线性 SVG 控件（1.5px 描边），替换播放/暂停/跳曲/停止/音量 emoji，并提供可访问名称与 tooltip。
- 字号、字重、行高、间距、曲线和时长统一令牌；所有文字字距为零。新增裸字号与秒级时长检查，历史违规 83 → 0，棘轮基线为 0。
- 曲库有独立选中态，单击只选中、双击或 Enter 播放。去掉未实现功能的导航入口，空曲库与无搜索结果提供直接操作。
- 播放栏现为 92px 高，C2 的 320px 画布移入信号弹层；900/1280 宽度下进度与音量互不遮挡。减少动态效果时状态保持可见。
- 封面未提供时显示明确占位；未生成或冒充真实封面。尚未接入 Punctum 字体或浅色主题。
- 后续按用户要求加入 CSS 液态玻璃效果：添加文件夹、当前导航项、播放按钮组各使用独立的单层透光材质、边缘高光、指针跟随与按压反馈。没有嵌套玻璃或背景循环动画；控件点击区域尺寸保持不变。
- 液态玻璃是 Windows/Electron 上的 CSS 实现，并非 Apple 原生材质 API。`prefers-reduced-motion` 取消入场、过渡和高光跟随；`prefers-reduced-transparency` 改为不透明表面；无 backdrop-filter 支持时使用实色回退。

## 验证与证据

工作目录：`<仓库根>/app`。

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 类型检查通过；令牌违规 0 |
| `pnpm build` | main、preload、renderer 构建通过 |
| `pnpm test:app` | 45 个用例通过 |
| `pnpm test:c2` | 11 个用例通过 |
| `pnpm test:protocol` | 31 项模拟引擎断言通过 |
| `pnpm test:integration` | 19 项真引擎断言通过 |
| `pnpm test:electron` | 33 项真实 Electron 检查通过 |
| `pnpm test:player` | 35 项 Playwright 实际窗口、封面、切歌、EQ 操作和像素检查通过 |

应用测试在新增能力前记录了对应失败；Electron 检查曾复现并推动修复播放栏重叠、启动能力丢失及告警闪光优先级。

Electron 验收使用构建后的真实 main/preload 和引擎；歌词解析边界替换成双字幕测试数据，降级场景注入已有真实 trace。它验证 DOM、计算样式、位置关系、快切歌词、重连恢复与 reduced-motion，不代表听感或完整动效手感验收。

- `app/.smoke/qa/result.json`：检查数量、失败数、所用引擎路径和 SHA-256；运行中二进制变化会导致失败。
- `app/.smoke/qa/electron.log`：验收日志。
- `app/.smoke/qa/`：测试场景截图（含专门的歌词 fixture）。
- `app/.smoke/player/music-space-1280.png`、`music-space-900.png`、`immersive-1280.png`、`immersive-900.png`、`artist-waterfall-1280.png`、`frequency-response-1280.png`、`playback-details-900.png`：当前真实引擎与本地曲库的界面截图。`result.json` 记录 35 项检查。
- `app/.smoke/player/custom-cover-1280.png`：实际选图 IPC 与主题色验收截图，图片明确标为 ARTWORK TEST，是测试素材，不是该歌曲原封面。测试用户配置位于同目录 `profile/`，不更改正常应用配置。
- `app/.smoke/design/glass-controls-1280.png`：指针触发播放控制组高光后的画面。
- 同目录 `*-mosaic.png`：24×16 缩放材料；未宣称低分辨率下全部 C2 几何可辨，仍需专项验收。

## 环境与后续边界

- 本轮未修改 `engine/`、CONTRACT、SPEC 或 CR 裁定状态；引擎可执行文件期间曾被其他工作更新，一次退出码 -1 原因未确定。最终验收记录固定本次使用的哈希，不将中途不同版本的结果混为一项证据。
- 后续重复验收使用 `.smoke/qa-runtime/twilight-app-qa.exe`（原引擎的独立副本，通过 `TWILIGHT_ENGINE` 指定），以隔离并行构建干扰；不是替换产品默认引擎。测试结果 JSON 记录实际路径和哈希。
- 原目录无 Git 元数据。旧样式备份在 `.scratch/theme-before-nothing-20261015.css`；本轮未提交或推送。
- 本会话 GraphFlow 只暴露 `gf_*` 接口，多次调用仅返回 `{ok:true}`，无摘要/anchors/指标；没有可调用的 `graphflow_index` 或本地 CLI。不能声称图谱已经更新。
- 未实现：实时 FFT（协议未提供音频样本）、复杂进度手势五项、按测量字形 advance 的渐进填充、全曲库缓存体系、在线平台接入、浅色主题和 Punctum。封面提取与有界缓存已在本轮加入；本轮没有复制外部播放器代码。
- 呼吸节奏、C2 形变手感和氛围光的人眼验收仍由 owner 真机确认。

## 音乐空间与动态层

首页变为唱片与曲目信息主视觉、歌词预览、可展开 EQ 频响、艺术家陈列和歌曲速览。曲库的歌曲/艺术家切换、搜索与艺术家筛选均操作实际元数据；瀑布卡片是生成的艺术家字形画面，不冒充专辑封面。沉浸播放把 3D 唱片与歌词分栏，900×600 窗口下缩小字号与间距；播放栏把信号路径收进弹层。

Three.js 唱片使用实体沟槽、标签纹理和环境反光，播放时旋转、指针移动时产生受限视差，离开后阻尼复位。Motion 负责视图景深切换、瀑布入场和按压弹性；`prefers-reduced-motion` 下停止持续动效，场景不可见或文档隐藏时不持续渲染。Electron 截图和像素差验证了非空画布、播放旋转、指针视差和复位。

EQ 页从真实引擎 `set_eq`/`get_state` 返回的完整 DSP 参数计算曲线：`OfflineAudioContext` 的 peaking `BiquadFilterNode.getFrequencyResponse` 在对数频轴上叠加响应，连同已应用的前级/重播增益；最近确认的参数可选择显示错位历史线。命令串行合并，待确认的控件草稿不冒充已经生效的曲线；旧引擎回复不能覆盖新的确认参数。它是**稳态 EQ 传递响应**，不是歌曲实时频谱、瀑布 FFT 或音频采样可视化。

## 封面、主题与参数台追加

- 新增 `music-metadata` 元数据读取和专用 artwork IPC。优先用户指定的本地图，其次嵌入图和同目录常见封面；JPG/PNG 真正解码成功后才展示/保存，限制字节与像素尺寸，缩到最大 1024px。损坏自定义图会回退，不能覆盖有效映射。主进程与渲染层各保留最多六项，避免缓存整个曲库原始图片。
- 参考曲库 91 首没有嵌入封面；默认曲目字形视觉明确标注。用户可悬停封面选图，配置保存在用户目录，原音乐文件不改动。切歌使用曲目键隔离进出场，旧封面异步结果不会替换新曲封面。
- 主题色从图片像素抽样，或在无图时按曲目生成稳定色相；开关可记忆。内容氛围、进度与 EQ 跟随颜色，告警语义不变。
- 首页曲线改为封面下方的 88px 短图，歌词在独立、有确定高度的右列滚动；修复长歌词撑开主舞台的问题。900×600 与 1280×800 均检查边界。
- EQ 十段控制与前级/Q/余量分栏，播放按钮层级和音量读数更明确。播放详情区分源文件与实时输出；输出精度消费 `containerBits/validBits`，不能用源 `bitDepth` 冒充；设备 `periodMs` 标作周期，不解释成总延迟。
- 实际测试发现原生引擎未初始化队列，之前上下首命令失败被吞掉。现在按能力声明先同步曲库队列，再打开目标曲目；过期的打开请求不会在新选择之后补发播放。切歌错误可见。
- 最后复验使用当前默认引擎的副本 `app/.smoke/qa-runtime/twilight-cover-qa.exe`，SHA-256 `fcec9698da4416fb763458cd5a014ac25e395a971848c252cdbd4e322eac4d28`。35 项播放器检查与 33 项 Electron 回归通过。固定 400ms 的动画结束断言改为等待实际有限动画完成，以避免后台帧调度造成误报。
