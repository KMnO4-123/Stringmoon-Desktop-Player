> # ⛔ 本文档已作废 —— 请读 [`DESIGN-v5-encoding.md`](DESIGN-v5-encoding.md)
>
> 作废原因：**它抄的是 Nothing 的外观产物**（黑底/点阵字/红点缀/工业网格线），不是系统设计。
> **另有一处事实错误**：本文 §2.1 写的 `font-variation-settings: 'DOTS'` 是**编造的**。
> 实测 Punctum 的轴名是 **`ROND` + `wght`**（文件名 `Punctum[ROND,wght].ttf`）——照本文写会**静默失效**。
>
> 仍被 v5 采纳的：信号路径的概念（升级为 C2 完整语法）、双字体对位、C1 的多模式。

# Twilight Echo · 界面方案 v3「信号」（SIGNAL）

> **Nothing 主导 · Apple 提供光感 / 动效 / 交互体验 · 北欧只负责克制**
>
> 上位文档：`CONTRACT.md` §2、`docs/SPEC-v2.1.md` §5
> 本文件取代 `SPEC-v2.0-legacy.txt` §5「澄明之境」作为**视觉方向**；其中四条缓动曲线与湿玻璃公式**保留**（§7 继承表）。
> 状态：待 owner 批准后落到 `app/src/renderer/src/styles/`

---

## 0. 层级（这是本方案的第一条规定）

| 角色 | 负责 | **不负责** |
|---|---|---|
| **Nothing · 主导** | **结构、排版、色彩、信息坦诚** —— 界面的"骨架与态度" | 不负责让东西动起来 |
| **Apple · 光感 / 动效 / 交互** | **光怎么打、东西怎么动、手怎么用** —— 界面的"物理" | 不决定界面长什么样 |
| 北欧 · 克制 | **只决定"什么时候不该有"** —— 减少发光、减少动、减少元素 | **不参与任何造型决策** |

**一句话**：

> **Nothing 画出了这台机器的内部，Apple 给了它光学与物理，北欧决定它什么时候闭嘴。**

**与上一版的区别**（必须先说清，否则会照着错的那份做）：上一版让北欧驱动了基底色彩与留白结构，结果是一份"安静但无性格"的方案。**现在北欧被降为唯一的否决权，不再有造型权。**

---

## 1. Nothing 主导什么（五条，都是可落地的）

Nothing 的美学不是"黑底白字 + 点阵字"，那是表面。它的内核是 **工程透明**——透明后壳让你看见螺丝、线圈、电路板。**翻译到音频播放器，就是让用户看见声音走过了什么。**

### 1.1 五条主导原则

| # | 原则 | 具体 |
|---|---|---|
| **N1** | **信息坦诚** | 界面上永远看得见"此刻声音的真实状态"——输出模式、采样率、是否 bit-perfect、有没有降级。**藏起来才是错的。** |
| **N2** | **双字体对位** | **点阵字**（Punctum，OFL）承载标签/规格/数字；**中性无衬线**承载曲名/歌词等需要阅读的内容。**两者的对比就是签名。** |
| **N3** | **工业网格** | 网格是**可见的结构**（发丝分隔、单元格对齐），不是看不见的辅助线 |
| **N4** | **单一点缀色** | 黑与白承担 95%；**一个强调色**只用在"当前/激活"；**红色只用于"需要你注意"** |
| **N5** | **工程化的形态** | 圆角**更小**（不是 iOS 那种），控件像仪器面板上的按钮，不是 App 里的胶囊 |

### 1.2 ⭐ 核心装置：**信号路径（Signal Path）**

**这是整个方案的记忆点，也是 Nothing 精神的完整落地。**

你的引擎能报 `outputMode` / `sampleRate` / `sourceSampleRate` / `resampled` / `bitPerfect` / `degradeReason` / `xrunCount` / `bufferedFrames`——**这些数据现在几乎没地方去**（只有播放栏一句「共享 · 44.1k→48k 重采样」）。

**信号路径把整条链画出来：**

```
┌─ 信号路径 ─────────────────────────────────────────────────┐
│                                                            │
│   ●───────●───────○───────●───────●                       │
│   FLAC   44.1k   SRC     无 DSP  共享                      │
│   24bit  源率    →48k    ▸直通   WASAPI                    │
│                                                            │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ← 光在走的路径   │
│                                                            │
│   位深 16 · 缓冲 24ms · xrun 0 · 已通 00:42:17            │
└────────────────────────────────────────────────────────────┘
```

**每一段的语义（全部来自真实遥测，不是装饰）：**

| 节点 | 亮起（实心 ●） | 熄灭（空心 ○） | 数据来源 |
|---|---|---|---|
| **解码** | 文件已装载 | 未装载 | `state.trackId` |
| **源率** | 显示真实源格式 `FLAC / 24bit / 96k` | — | `sourceSampleRate` + `bitDepth` |
| **SRC** | **点亮 = 正在重采样**（44.1k→48k） | **熄灭 = 同率直通** | `resampled` |
| **DSP** | 点亮 = EQ/RG 生效（此时**必然不是** bit-perfect） | 熄灭 = 直通 | 未来 M2 的 DSP 状态 |
| **输出** | `独占` / `共享` / `ASIO` | 设备不可用（红） | `outputMode` |
| **bit-perfect** | `BP` 徽标亮（**全链无改动**） | 不显示 | `bitPerfect` |

**Apple 给它的"光感"**（§6 详述）：**光沿路径流动**——播放时一个小光点从"解码"走到"输出"，每个节点被经过时短暂增亮。这不是装饰动画，它**映射真实的播放位置**（`framesPlayed`）。

> **为什么这个装置值得做**：它同时满足三家——
> **Nothing** 的工程透明（看见内部）、**Apple** 的光与运动（光在路径上走）、**北欧**的克制（不播放时整条路径是暗的，只有一圈极细的轮廓）。

---

## 2. 排版：双字体对位（N2）

### 2.1 字体选择

| 用途 | 字体 | 许可 | 为什么 |
|---|---|---|---|
| **标签 / 规格 / 数字 / 状态** | **Punctum**（`sundyme/punctum`） | **OFL-1.1** ✅ | 免费**可变**点阵字体：5×7 点阵，**两个可变轴（点大小 + 点形状）**。这正是 Nothing 的招牌 |
| 曲名 / 艺术家 / 歌词 / 正文 | `Inter` 或系统 UI 无衬线 | OFL / 系统 | 需要长时间阅读，点阵字不适合 |
| 时间码 / 位深 / 采样率的具体数字 | `Punctum`（数字）或等宽 | OFL | 数字用点阵，规格感立刻出来 |

**Punctum 的可变轴是关键**——它让点阵字**有音量**：

```css
/* 轴名以仓库 fonts/ 里的实际定义为准；这里是用法示意 */
.spec-label {
  font-family: 'Punctum', ui-monospace, monospace;
  font-variation-settings: 'DOTS' 0.85;   /* 点大小：小字用大点，避免糊 */
  letter-spacing: 0.08em;                 /* 点阵字必须放开字距 */
}
.spec-value-loud {
  font-variation-settings: 'DOTS' 1.0;    /* 关键数字：饱满 */
}
```

> ⚠️ **Punctum 的 OFL 要求**：保留版权声明，**不得单独售卖字体本身**。自用无碍；若将来分发，随包附 `OFL.txt`。
> 落地前先确认仓库 `fonts/` 里的**实际轴名与可用字重**（我只核实了它存在且是可变字体，没有逐个读轴定义）。

### 2.2 点阵字的**三条使用纪律**（否则会变成"廉价科幻风"）

1. **只用于 ≤14px 的标签与数字**。点阵字放大后点会变粗块，失去细腻感——**Nothing 的克制在于它用得很小**
2. **绝不用它承载需要阅读的内容**（歌词、简介）。它是"仪表盘"，不是"书"
3. **字距必须放开**（`+0.06em ~ +0.10em`），因为点与点之间需要呼吸

### 2.3 排版层级（Apple §15：tracking 随字号变化）

| 层级 | 字体 | 字号 | 字距 | 行高 |
|---|---|---|---|---|
| 播放中的曲名 | Inter 500 | `28px` | `-0.02em` | `1.15` |
| 列表曲名 | Inter 450 | `14px` | `0` | `1.4` |
| 艺术家 / 专辑 | Inter 400 | `13px` | `+0.01em` | `1.4` |
| **规格标签** | **Punctum 500** | **`10px`** | **`+0.08em`** | `1.2` |
| **规格数值** | **Punctum 600** | **`11px`** | **`+0.06em`** | `1.2` |
| 歌词（当前行） | Inter 500 | `20px` | `-0.01em` | `1.35` |
| 歌词（相邻） | Inter 400 | `15px` | `0` | `1.35` |

---

## 3. 色彩：黑、白、一个点缀（N4）

### 3.1 基底 —— **比上一版更黑**（Nothing 是纯黑，不是深灰）

| 令牌 | 值 | 上一版 | 变化理由 |
|---|---|---|---|
| `--bg-void` | **`#000000`** | — | **新增**：窗口最底层、播放栏底、信号路径底 |
| `--bg-far` | `#0A0A0B` | `#0A0B0D` | 更中性（Nothing 的黑是无色的黑） |
| `--bg-mid` | `#111112` | `#101215` | 同上 |
| `--bg-near` | `#1A1A1C` | `#17191E` | 略提，拉开与 void 的差距 |

> **`--bg-void` 的存在是本方案与上一版最直观的差别**：Nothing 的屏幕是**真的黑**，内容浮在纯黑上。这需要 OLED 才完美，但 LCD 上同样成立——因为它提供的是"边界感"。

### 3.2 文字（四级，全部达标）

| 令牌 | 值 | 对 `#000` | 对 `#0A0A0B` | 用途 |
|---|---|---|---|---|
| `--text-primary` | `#FFFFFF` | 21:1 ✅ AAA | 19.6:1 ✅ AAA | 曲名、**关键数值** |
| `--text-secondary` | `#B0B0B4` | 9.6:1 ✅ AAA | 9.0:1 ✅ AAA | 艺术家、次要值 |
| `--text-muted` | `#757579` | 4.7:1 ✅ AA | 4.4:1 ✅ AA | **点阵标签**、单位 |
| `--text-ghost` | `#4A4A4E` | 2.4:1 ⚠️ | 2.2:1 ⚠️ | **仅未激活节点轮廓，不承载信息** |

> Nothing 的高对比是刻意的：**第一级用纯白**（不是 `#f0f0f2` 那种灰白）。这是它"工程感"的来源之一。

### 3.3 强调色 —— **一个，且由状态决定**（不是由封面决定）

**这里我推翻上一版的一个决定。** 上一版让强调色跟封面走——那是北欧/Apple 的思路。**Nothing 不这么干**：它的点缀色是**固定的品牌色**，因为点缀色的作用是"标出当前项"，**颜色变化会削弱这个功能**。

```css
--accent: #D71921;        /* Nothing 式的红。只用于：当前项、激活节点、播放中的光 */
--accent-dim: #6E0F14;    /* 未激活但"属于当前上下文" */
--accent-glow: rgba(215, 25, 33, 0.35);
```

> ⚠️ **对红色的一点克制**：Nothing 用红做点缀；但红色同时是"错误"的通用语义。解法是**用形状而非颜色区分**——
> **激活节点 = 实心 + 发光**；**错误 = 红色 + 一个明确的图标/文字**。不要让"正在播放"和"出错了"长得一样。

**封面取色不再驱动强调色**，改为驱动**唯一的装饰光**（§6.3 的氛围光）——保留"色彩来自音乐"的效果，但**不参与功能语义**。

### 3.4 语义色（红色已被占用，所以）

| 令牌 | 值 | 唯一用途 |
|---|---|---|
| `--warn` | `#C9A227` | 降级提示（琥珀，"能用但不是最佳"） |
| `--error` | `--accent` + 图标 | 失败（**必须配图标**，见上） |
| `--ok` | `--text-primary` | **正常态不着色**（Nothing：不必要时不用色） |

---

## 4. 工业网格（N3）

### 4.1 网格是**看得见的**

上一版（北欧主导）删掉了侧栏分隔线——**这是错的，改回来，而且做得更明确**：

```css
/* 结构线：极细、极暗、但确实存在 */
--grid-line: rgba(255, 255, 255, 0.055);
--grid-line-strong: rgba(255, 255, 255, 0.09);

.sidebar { border-right: 1px solid var(--grid-line); }     /* 改回 1px，不再是 0.5px */
.topbar  { border-bottom: 1px solid var(--grid-line); }
.playbar { border-top: 1px solid var(--grid-line-strong); } /* 播放栏更重，它是"底盘" */
```

**为什么 1px 而不是 0.5px**：Nothing 的线是**工程线**，它要看得见。0.5px 在 1x 屏上会被抹成几乎不可见——那是"精致"，不是"结构"。

### 4.2 布局：更接近仪器面板

| 区域 | 现行 | 本方案 | 理由 |
|---|---|---|---|
| 顶栏 | 56px | **48px** | Nothing 的顶栏很窄，它是状态条不是导航 |
| 导航 | 200px | **208px** | 容纳点阵标签 + 更大的字距 |
| 播放栏 | 72px | **84px** | **必须变高**：要塞进信号路径 |
| 信息栏 | 280px | **312px** | 规格表的自然宽度 |
| 圆角 | 8/10/12/16 | **4px / 8px / 12px** | **整体收小**（N5：工程化形态） |

```css
--radius-xs: 4px;    /* 按钮、输入框、标签 */
--radius-sm: 8px;    /* 列表行、小卡 */
--radius-md: 12px;   /* 面板、封面 */
/* 不再有 16px —— Nothing 没有大圆角 */
```

### 4.3 列表：格子化

现行列表是"行"。**本方案改为格子**——每列有明确对齐的轨道，且**列间用竖网格线暗示结构**（不是全画，只在 hover 时显现）：

```
┌────┬──────────────────────────┬────────────────┬────────┐
│ 01 │ 测试曲目 001                  │ Test Artist          │  5:04  │
├────┼──────────────────────────┼────────────────┼────────┤
│ 02 │ 测试曲目 002                  │ Test Artist 02       │  2:54  │
└────┴──────────────────────────┴────────────────┴────────┘
  ↑ 序号用 Punctum           ↑ 曲名 Inter      ↑ 时长 Punctum
```

**轨道宽度固定**（`64px | 1fr | 240px | 72px`），让竖列形成视觉网格。

---

## 5. Apple · 光感（第一条：光怎么打）

Nothing 给了结构和黑，**Apple 决定光从哪里来。**

### 5.1 材质：湿玻璃公式保留，但**只在两处**

| 层 | 场景 | 配方 |
|---|---|---|
| **M0 底** | 窗口、导航、主区 | **纯色**（`--bg-void` / `--bg-far` / `--bg-mid`）。**不透明** |
| **M1 玻璃** | 播放栏、队列面板、弹层 | 湿玻璃三要素 + `backdrop-filter: blur(20px) saturate(120%)` |
| M2 卡片 | 封面 | 无 blur，用内描边 + 边缘辉光 + 环境遮蔽 |

**Apple §12 的一条硬规则必须遵守**：**"Never stack a light translucent surface on another"**。
所以：**M1 之上不许再有 M1**。队列面板打开时，播放栏**不再叠加**，而是让主内容后退（§8.3）。

### 5.2 边缘光（Nothing 的"透光"）

**这是 Nothing 与 Apple 最自然的交汇点**：Nothing 的机器有透光边缘，Apple 的材质有 bright top edge。

```css
/* 所有 M1 玻璃的顶边有一条亮线 = 光打在材质的上缘 */
.material-glass {
  background: linear-gradient(180deg,
    rgba(255,255,255,0.045) 0%,
    rgba(255,255,255,0.012) 22%,
    rgba(0,0,0,0) 60%);
  background-color: rgba(17, 17, 18, 0.72);
  backdrop-filter: blur(20px) saturate(120%);
  border-top: 1px solid rgba(255,255,255,0.10);
  /* 环境遮蔽（原湿玻璃三要素之三） */
  box-shadow: 0 -24px 48px rgba(0,0,0,0.55);
}

/* 发丝内描边（原湿玻璃三要素之一） */
.inset-hairline {
  box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.08);
}
```

### 5.3 氛围光：**封面取色的唯一去处**

```css
/* 封面后方的色光 —— 让音乐"照亮"界面，但不参与任何功能语义 */
.ambient-glow {
  position: absolute;
  inset: -12%;
  background: radial-gradient(58% 58% at 50% 52%, var(--cover-color-soft), transparent 72%);
  filter: blur(64px);
  opacity: 0.42;
  z-index: 0;
  pointer-events: none;
  transition: background 800ms var(--ease-in-out-screen), opacity 600ms var(--ease-in-out-screen);
}
```

**播放时 `opacity` 提到 `0.55`，暂停时降到 `0.28`** —— 光随音乐"呼吸"。这是 Apple 的"feedback"，也是 Nothing 的"机器活着"。

### 5.4 光点是可累积的：`--accent-glow`

**激活节点 = 实心红 + 光晕**。光晕用 `box-shadow` 而非 `filter: blur`（前者在元素少时更省）：

```css
.node-active {
  background: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-dim), 0 0 12px 2px var(--accent-glow);
}
```

---

## 6. Apple · 动效（第二条：东西怎么动）

### 6.1 门控表（`animate` 的频率判据，先说"不做什么"）

| 交互 | 频率 | 决定 |
|---|---|---|
| 空格播放/暂停、←/→ seek | **100+/日** | **零动画**（`animate` 硬规则：键盘动作取消资格） |
| 列表 hover | 数十次/日 | 仅**颜色 + 1px 内描边**；**无位移** |
| 列表行选中 → 播放 | 数十次/日 | **可以动**：曲名从行内"升起"到播放栏（空间一致性） |
| 信号路径光点 | 每首 1 次 | **动**，且**映射真实播放进度** |
| 歌词逐字高亮 | 每首数百次 | **CSS transition**（必须离主线程） |
| 队列面板开合 | 偶尔 | 标准 + 可打断 |
| 首次启动 / 扫描完成 | 罕见 | **愉悦预算在这里** |

### 6.2 时长双轨（Apple 手势 vs 非手势）

```
手势驱动（拖进度条、拖队列）→ 180–260ms，可打断，继承释放速度
非手势（面板开合、内容切换）→ 300–420ms，缓入缓出
```

### 6.3 曲线：继承现有四条，**新增两条**（不自建体系）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ease-immerse` | `cubic-bezier(0.16, 1, 0.3, 1)` | **默认入场**（保留） |
| `--ease-dissolve` | `cubic-bezier(0.4, 0, 1, 1)` | 出场 / 溶解（保留） |
| `--ease-pop` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | **仅**抓取释放类（保留） |
| `--ease-list` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | hover / 颜色（保留） |
| **`--ease-out-strong`** | `cubic-bezier(0.23, 1, 0.32, 1)` | **新增**：UI 入场，比 immerse 更锐 |
| **`--ease-in-out-screen`** | `cubic-bezier(0.77, 0, 0.175, 1)` | **新增**：屏内移动/形变 |

**禁止**：`ease-in`、`transition: all`、`scale(0)`。

### 6.4 ⭐ 信号路径的光点：把"装饰"变成"信息"

**这是本方案动效的核心，因为它同时是装饰和信息。**

```js
// 播放位置驱动光点，不是定时器。用 positionStore（已存在的独立订阅，不推全树）
// 映射：framesPlayed / durationFrames → 路径上的 0..1 位置
// 光点经过节点时，该节点短暂增亮 200ms（--ease-out-strong），然后回落到常态
```

**关键约束**：
- 光点用 `transform: translateX()` **只改合成层**，绝不改 `left`
- 用 `requestAnimationFrame` 节流到**显示刷新率**，不是每个 `position` 事件都动（`position` 是 100ms 一次，足够了）
- **`prefers-reduced-motion` 时**：光点改为**离散的进度条填充**（不移动，只增长）

### 6.5 曲名"升起"（Apple 的空间一致性）

双击列表行 → 曲名从**那一行的位置**落进播放栏：

```css
@starting-style {
  .playbar-title { opacity: 0; transform: translateY(-14px) scale(0.96); }
}
.playbar-title {
  transition: opacity 320ms var(--ease-out-strong), transform 420ms var(--ease-immerse);
}
```

**方向说明**：列表在上、播放栏在下，内容是**从上往下落**，所以起点是 `translateY(-14px)`（负值 = 在目标位置上方）。
**这一条要在真机上试**——凭代码判断方向容易搞反，且反了会明显不对。

### 6.6 队列面板：可打断 + 主内容后退

```css
/* 面板：transform + opacity，可被打断（transition 而非 keyframes） */
.queue-panel {
  transform: translateY(100%);
  transition: transform 420ms var(--ease-immerse), opacity 300ms var(--ease-immerse);
}

/* 主内容后退（Apple §12：dim to focus, push the background back） */
.app-shell.queue-open .main,
.app-shell.queue-open .sidebar {
  transform: scale(0.985);
  filter: brightness(0.92);
  transition: transform 420ms var(--ease-immerse), filter 420ms var(--ease-immerse);
}
```

**`scale 0.985`（比上一版的 0.98 更轻）**——Nothing 的机器是硬的，剧烈的后退不合它的性格。

---

## 7. Apple · 交互体验（第三条：手怎么用）

### 7.1 进度条：1:1 跟手 + 速度继承 + 投影落点

现行进度条是点击跳转。**本方案升级为标准 Apple 交互**：

| 环节 | 做法 | 依据 |
|---|---|---|
| 抓取 | `setPointerCapture`，**尊重抓取偏移**（按下点是 30% 就一直跟 30%） | `apple-design` §2 |
| 拖动中 | 1:1 跟随，**持续反馈**（时间码同步显示） | §1 |
| 边界 | **橡皮筋**（拖过 0% 或 100% 时渐进制动） | §9 |
| 释放 | **速度投影**决定落点 + 弹簧继承释放速度 | §5 §6 |
| 打断 | 拖动中再次按下 → 从**当前显示值**继续，不从目标值 | §3 |

```js
// Apple 的投影函数（不是物理课本的 v²/2a）
function project(v, d = 0.998) { return (v / 1000) * d / (1 - d); }
const target = clamp(current + project(releaseVelocity), 0, duration);
```

### 7.2 反馈在 pointer-down（不是 release）

```css
/* 所有按钮：按下的瞬间就有反馈 */
.btn:active { transform: none; background: rgba(255,255,255,0.07); }  /* Nothing 用亮度，不用缩放 */
```

> **与 Apple 的默认不同**：Apple 用 `scale(0.97)`。**Nothing 的按钮是仪器按钮，它不"缩"，它"变亮"**——这条我按 Nothing 主导来定。

### 7.3 悬停门控（必须）

```css
@media (hover: hover) and (pointer: fine) {
  .track-row:hover { background: rgba(255,255,255,0.035); box-shadow: inset 0 0 0 1px var(--grid-line); }
}
```

### 7.4 键盘（Nothing 的仪器感需要键盘）

- `Space` 播放/暂停（已有）
- `←/→` seek 5s（已有）
- **`J/K/L`**：← 快退 / 空格 播放 / → 快进（视频播放器惯例，可选）
- **`Tab` 焦点环**：**固定高对比色，不跟强调色**（浅色封面上红环会看不见）→ 用 `--text-primary`

```css
:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
  /* 焦点环必须是固定的，不得使用 --accent */
}
```

---

## 8. 景深（三家合力的地方）

景深不是模糊。**四件事同时成立才有纵深**：

| # | 手段 | 在哪一层用 | 归谁 |
|---|---|---|---|
| 1 | **尺度差** | 队列打开时主内容 `0.985` | Apple §12 |
| 2 | **清晰度差** | 只允许 M1 层 blur；远层不额外模糊 | Apple §12 |
| 3 | **运动视差** | 氛围光（远层）随指针反向位移 2–4px | Apple §9 |
| 4 | **明度差** | `brightness(0.92)` 后退 | Apple §12 |

### 8.1 鼠标视差：**只给氛围光，不给内容**

```css
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  .ambient-glow {
    transform: translate3d(
      calc(var(--pointer-x) * -4px),
      calc(var(--pointer-y) * -4px), 0);
    transition: transform 600ms var(--ease-immerse);  /* 缓慢跟随 = 远 */
  }
}
```

**三条纪律**（`apple-design` §9 + `animate` §4）：
1. **幅度上限 4px**，超过 6px 变晕船
2. **只动氛围光**。**列表、歌词、播放栏都不动**——那是"数据在动"，`animate` §2 明令禁止
3. **弹簧收敛**（`damping 1.0, response 0.4`，Apple 的 Move/reposition 档），不要直接绑 `pointermove`

### 8.2 歌词的 Z 轴（比上一版更克制）

| 行 | `translateY` | `scale` | `blur` | `opacity` |
|---|---|---|---|---|
| 当前行 | 0 | **1.00** | 0 | 1.0 |
| 相邻 | ±12px | **0.96** | 0.5px | 0.52 |
| 更远 | ±24px | **0.93** | 1.2px | 0.26 |
| 最远 | ±36px | **0.90** | 2.0px | 0.10 |

**尺度差收窄到 0.90–1.00**（上一版是 0.88）——Nothing 主导意味着变化更硬朗、更少。

---

## 9. 继承与废弃（对现行 `theme.css` 531 行的处置）

### ✅ 原样保留
四条缓动曲线令牌 · 湿玻璃三要素 · 三区布局骨架 · 导航竖线生长动画 · 现有 `prefers-reduced-motion` 两块 · `.mono` 的等宽数字传统

### 🔄 修改

| 现有 | 改为 | 理由 |
|---|---|---|
| 强调色 `#6ea8b8`（霜蓝） | **`#D71921`（Nothing 红）** | N4：点缀色要固定，不跟封面 |
| 基底 `#0b0c10`（蓝偏） | `#0A0A0B` + 新增 `#000` | Nothing 的黑是无色的 |
| `--text-primary: #f0f0f2` | **`#FFFFFF`** | Nothing 的高对比是刻意的 |
| 圆角 8/10/12/16 | **4/8/12** | N5：工程化形态 |
| 侧栏 `border-right: 0.5px` | **`1px`** | N3：网格要看得见 |
| 播放栏 72px | **84px** | 容纳信号路径 |
| 顶栏 56px | **48px** | Nothing 的状态条很窄 |

### ❌ 废弃
「澄明之境」的蓝水隐喻 · **封面驱动强调色**（改为只驱动氛围光）· 歌词的纯 `blur` 过渡（升级为 §8.2 的 Z 轴）· 16px 圆角

---

## 10. 无障碍（随方案交付）

```css
/* ① 减少动态：关视差、关光点移动，保留透明度 */
@media (prefers-reduced-motion: reduce) {
  .ambient-glow { transform: none !important; }
  .signal-dot { transition: none !important; }        /* 光点改为离散进度 */
  .lyrics-line { transform: none !important; filter: none !important; }
  * { transition-duration: 140ms !important; }
}

/* ② 减少透明：M1 退化为不透明 */
@media (prefers-reduced-transparency: reduce) {
  .material-glass { background: var(--bg-near); backdrop-filter: none; }
}

/* ③ 提高对比 */
@media (prefers-contrast: more) {
  .material-glass { background: var(--bg-near); border: 1px solid rgba(255,255,255,0.30); }
  .grid-line { background: rgba(255,255,255,0.20); }
}
```

**另三条硬要求**：
- **焦点环固定高对比**（§7.4），**不得**使用 `--accent`
- **信号路径的每个节点必须有 `aria-label`**（它承载真实信息，不能只是视觉）
- **`--text-ghost` 不承载任何信息**（2.4:1 不达标）

---

## 11. 落地顺序（按性价比）

| # | 步骤 | 成本 | 收益 |
|---|---|---|---|
| **1** | 换色彩令牌（§3）+ 网格线恢复（§4.1）+ 圆角收小（§4.2） | 小 | **立刻**从"澄明之境"变成 Nothing 的骨架 |
| **2** | **信号路径（§1.2）** —— 静态版（点亮节点，不动） | 中 | **本方案的记忆点**，且你已有全部遥测 |
| **3** | 接入 **Punctum**（§2） | 小 | 点阵字一上，性格立刻成立 |
| **4** | 播放栏改造（84px + 信号路径 + 点阵规格） | 中 | 信息坦诚的集中地 |
| **5** | 进度条 Apple 化（§7.1） | 中 | 交互体验的最大提升 |
| **6** | 信号路径**光点动画**（§6.4） | 中 | 从"信息"变成"信息 + 生命" |
| **7** | 氛围光 + 视差（§5.3 §8.1） | 小 | 锦上添花 |
| **8** | 队列面板 + 主内容后退（§6.6） | 中 | 景深 |

> **做到第 4 步方案就已经成立。** 第 6 步是"从好到惊艳"的那一步。

---

## 12. 需要 owner 裁决的三处

| # | 问题 | 我的建议 |
|---|---|---|
| **1** | 强调色用 **Nothing 红**，还是保留现有的霜蓝？ | **用红**。理由：Nothing 主导要求固定点缀色；霜蓝在纯黑上缺乏"工程感"。若你觉得红太刺激，退路是 **`#E8E8E8`（白）+ 单一红色只做错误态**——那是更极端的 Nothing |
| **2** | **封面取色完全退为氛围光**，接受吗？ | 接受。这是"Nothing 主导"的直接代价，但它保住了"音乐照亮界面"的效果 |
| **3** | Punctum 落地前需确认**实际轴名与可用字重**（我只核实了存在 + OFL） | 先拉 `fonts/` 看，再定 `font-variation-settings` 的具体值 |

---

## 附录：可直接落地的令牌（替换 `theme.css` 的 `:root`）

```css
:root {
  /* ── 基底（Nothing：真黑） ── */
  --bg-void: #000000;
  --bg-far: #0A0A0B;
  --bg-mid: #111112;
  --bg-near: #1A1A1C;

  /* ── 文字（第一级纯白，这是 Nothing 的工程感） ── */
  --text-primary: #FFFFFF;
  --text-secondary: #B0B0B4;
  --text-muted: #757579;
  --text-ghost: #4A4A4E;        /* 仅未激活轮廓，不承载信息 */

  /* ── 强调色（N4：固定，不跟封面） ── */
  --accent: #D71921;
  --accent-dim: #6E0F14;
  --accent-glow: rgba(215, 25, 33, 0.35);

  /* ── 语义 ── */
  --warn: #C9A227;
  --error: var(--accent);       /* 必须配图标，勿单靠颜色 */

  /* ── 网格（N3：看得见的结构） ── */
  --grid-line: rgba(255, 255, 255, 0.055);
  --grid-line-strong: rgba(255, 255, 255, 0.09);
  --hairline: rgba(255, 255, 255, 0.08);   /* 保留：湿玻璃内描边 */

  /* ── 圆角（N5：工程化，收小） ── */
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: 12px;

  /* ── 字体：双字体对位（N2） ── */
  --font-dot: 'Punctum', ui-monospace, 'Cascadia Code', monospace;   /* 标签/规格/数字 */
  --font-ui: 'Inter', 'Segoe UI', 'Microsoft YaHei', sans-serif;     /* 阅读内容 */

  /* ── 缓动：继承四条 + 新增两条（不自建体系） ── */
  --ease-immerse: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-dissolve: cubic-bezier(0.4, 0, 1, 1);
  --ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-list: cubic-bezier(0.25, 0.1, 0.25, 1);
  --ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);      /* NEW */
  --ease-in-out-screen: cubic-bezier(0.77, 0, 0.175, 1);  /* NEW */

  /* ── 封面取色：只驱动氛围光，不参与功能语义 ── */
  --cover-color-soft: rgb(110 110 120 / 0.5);   /* 由 ColorExtractor 写入 */

  /* ── 指针（视差用，由 JS 写入 -1..1） ── */
  --pointer-x: 0;
  --pointer-y: 0;
}
```
