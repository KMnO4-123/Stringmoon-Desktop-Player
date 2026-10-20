# 界面系统落地指令 · 给 AI-B

> **这不是契约。** 不影响 `CONTRACT.md` 与 `docs/SPEC-v2.1.md` 的权威性。
> 上位文档：**`docs/DESIGN-v5-encoding.md`（界面系统 v5，唯一权威）**
> 本文件是它的**落地指令**——v5 讲"是什么"，本文件讲"怎么建、按什么顺序、怎么验收"。
>
> ⚠️ **`DESIGN-v3-still-water.md` / `DESIGN-v3-signal.md` / `DESIGN-v4-encoding.md` 全部作废**，不要读。
> （其中 `v3-signal.md` 有一处**编造的事实**：`font-variation-settings: 'DOTS'` —— 实测轴名是 `ROND`+`wght`，照它写会静默失效。）

---

## 0. 这次拆分是不对称的（先说清）

| | 工作量 | 内容 |
|---|---|---|
| **AI-A** | **极小** | 一条要求：`degradeReason` 全覆盖 + 导出 `state` trace 作 fixture（见 `DESIGN-A-engine.md`） |
| **你（AI-B）** | **几乎全部** | 设计系统的实现、强制层、C1/C2/C3、动效、验证 |

**这不是分配不公**——界面系统天然在 `app/`。但你要知道：**A 侧那条要求是这一切的前提**。
如果 A 静默降级而不报 `degradeReason`，**你的 C2 会画出一条实线，界面就撒谎了**。
你已经能拿到那个字段（`protocol.ts:110`），**先用起来，缺的部分走 CR**。

---

## 1. 读什么（按顺序）

| 顺序 | 文件 | 读什么 |
|---|---|---|
| 1 | **`docs/DESIGN-v5-encoding.md`** | **全文。这是唯一权威。** 尤其 §1（Nothing 的系统设计内核，有 GDK 一手证据）、§2（三通道）、§3（完整状态编码表）、§4（强制层）、§9（加新状态的规则） |
| 2 | `DESIGN-A-engine.md` | 了解 A 侧要交付什么（`degradeReason` + `state` trace） |
| 3 | 本文件 | 落地顺序与验收 |
| 4 | 现行 `app/src/renderer/src/styles/theme.css`（531 行） | **要继承什么、要改什么**（见 §8） |
| 5 | `app/src/shared/protocol.ts`（148 行） | **C2 画图的数据来源**，逐字段读 |

**不要读**：`DESIGN-v3-*.md`、`DESIGN-v4-encoding.md`（已作废）。

---

## 2. ⭐ 最重要的顺序：先建强制层，再做界面

**这是本指令与普通"设计规范"最大的区别。**

如果你先做界面、最后才建强制层，结局是：**半年后颜色漂移、两个 AI 各写一套、亮色主题要手工全查。**

所以顺序是**倒过来的**：

```
第 1 步  建令牌契约 + lint 强制 + 棘轮基线   ← 先做这个
第 2 步  在强制下实现 C2
第 3 步  在强制下实现 C1
第 4 步  动效 / 交互
第 5 步  验证
```

**为什么先建强制层**：它是**唯一能在"两个 AI 看不到对方代码"（CONTRACT §0 P8）的前提下产生一致视觉的机制**。
文档靠自觉，**lint 靠机器**——违反就红，不等人发现。

---

## 3. 第 1 步：强制层（照 ECHO 已验证的形态）

ECHO 的 `theme-contract.md` 是**一手证据**（同项目的 UI guide 与它配套）。照它的三个性质搬：

| 性质 | 效果 |
|---|---|
| **语义令牌，不是固定色** | `--surface-page` 而非 `#111` → 亮/暗主题**自动成立** |
| **CI 强制** | 违反就红，**不靠人自觉** |
| **棘轮（ratchet）** | 基线**只能降不能升** → 遗留债不会增长 |

### 3.1 建立 `tokens.css`

**唯一允许出现字面颜色的文件。** 令牌清单见 v5 §7（已给完整 CSS，直接抄）。

```
app/src/renderer/src/styles/tokens.css     ← 新建：语义令牌（字面颜色只在这里）
app/src/renderer/src/styles/theme.css      ← 改造：只允许引用 var(...)，不得有字面颜色
```

### 3.2 建立 `tools/check-tokens.mjs`

```js
// 检查三项，任一违规 exit 1：
// 1. src/renderer/**/*.{css,tsx} 里出现 /#[0-9a-fA-F]{3,8}\b|rgba?\(/ 且文件不是 tokens.css
// 2. 出现 /transition:\s*all/ 或 /ease-in\b/（animate 明令禁止）
// 3. 出现除 --dur-* / --ease-* 之外的时序字面量（如裸的 200ms）
//
// 逃生口（照 ECHO）：同一行或上一行有 /* token-allow: <理由> */ → 跳过并记录
// 棘轮：与 tools/token-baseline.json 比对
//   · 现有违规 > 基线  → exit 1（打印新增的违规）
//   · 现有违规 < 基线  → 提示可下调（不 exit 1）
```

**挂进 lint**：

```jsonc
// package.json
"scripts": {
  "check:tokens": "node tools/check-tokens.mjs",
  "lint": "eslint . && npm run check:tokens"
}
```

### 3.3 建立 `tools/token-baseline.json`

```json
{
  "generatedAt": "2026-10-15",
  "note": "只能下调。新增违规会让 lint 失败。",
  "files": {}
}
```

> **先跑一次 `check:tokens` 把现有 `theme.css` 的违规数记进基线**，然后开始改造。
> **基线数字只降不升**——每改完一个文件就下调基线，这就是棘轮。

### 3.4 ⚠️ 一条诚实的提醒

`theme.css` 有 **531 行**，全量改造是大工程。
**建议策略**：不要一次全改。**先让 `check:tokens` 跑起来，把基线设成当前值**，然后**每做一块界面就顺手把那一块降下来**。

**关键**：基线**一旦建立就不会回升**，所以你不会越改越乱。

---

## 4. 第 2 步：C2 —— 信号路径（系统的心脏）

### 4.1 它是什么

**六段几何编码，把引擎的音质遥测画成一条路径：**

```
  [解码] ── [源率] ── [转换] ── [DSP] ── [输出] ── BP
     ●        ││        ────      ～～       ○       ━
```

**完整语义表见 v5 §3.2。** 核心：

| 段 | 语法 | 数据来源 |
|---|---|---|
| 解码 | 实心方 / 空心方 | `state.trackId` |
| 源率 | **竖线高度** = 采样率 | `state.sourceSampleRate` |
| 转换 | **直线 = 直通**；**折线 ∧ = 重采样** | `state.resampled` |
| DSP | 无 = 不画；**波浪 ～～ = 生效** | ⚠️ 字段待 CR（见 §7.1） |
| 输出 | **实心圆 = 独占**；**空心圆 = 共享**；**圆+括号 = 蓝牙** | `state.outputMode` + `DeviceInfo.isBluetooth` |
| BP | **整条连续实线 = bit-perfect** | `state.bitPerfect` |

### 4.2 ⭐ 关键：把它做成**纯函数**

**不要直接在组件里拼 JSX 判断。** 做一个编码函数：

```ts
// src/renderer/src/c2/encodePath.ts
export type C2Seg = 'square' | 'bar' | 'line' | 'bend' | 'wave' | 'circle' | 'dashed'
export interface C2Path {
  segs: C2Seg[]           // 按顺序的段
  bp: boolean             // 是否连成不打断的实线
  severity: 'ok' | 'warn' | 'error'
}

export function encodePath(state: EngineStateSnapshot): C2Path {
  // 纯函数：输入引擎状态，输出可渲染的段序列
  // 不含任何 React / DOM 依赖 —— 这样才能被单元测试（§4.3）
}
```

**为什么必须是纯函数**：

1. **可单元测试**（把 v5 §3.2 的判定表变成可执行断言）
2. **可被 AI-A 的 trace fixture 直接喂**（`engine/fixtures/state-traces.json`）
3. **不含颜色**——保证 R3（色盲/亮色主题零损失）

### 4.3 ⭐ C2 语法断言（把判定表变成规格）

```ts
// src/renderer/src/c2/encodePath.test.ts
import { encodePath } from './encodePath'

// 1. 重采样 → 必有折线
expect(encodePath({ resampled: true }).segs).toContain('bend')

// 2. 降级 → 必有虚线
expect(encodePath({ degradeReason: '独占无回调，已回退共享' }).segs).toContain('dashed')

// 3. bit-perfect → 全链无改动（不得出现折线/虚线/波浪）
const bp = encodePath({ bitPerfect: true, resampled: false, dspActive: false })
expect(bp.segs).not.toContain('bend')
expect(bp.segs).not.toContain('dashed')
expect(bp.segs).not.toContain('wave')

// 4. 共享模式 → 输出段是空心圆（用 severity/样式区分，不是颜色）
expect(encodePath({ outputMode: 'shared' }).segs).toContain('circle')

// 5. 蓝牙 → 输出段带括号标记
expect(encodePath({ isBluetooth: true }).segs).toContain('paren')

// 6. 组合不冲突：重采样 + DSP 波浪 可同时出现（v5 §9 的例子）
const combo = encodePath({ resampled: true, dspActive: true })
expect(combo.segs).toEqual(expect.arrayContaining(['bend', 'wave']))
```

> **这六条断言是"系统"的最终形态**：不是描述状态，而是**能验证状态被正确编码**。

### 4.4 渲染实现

```tsx
// 用 SVG，不用 DOM 拼 —— 折线/波浪/虚线是路径语义，SVG 表达最自然
<svg className="c2-path" viewBox="0 0 320 24" aria-hidden={false} role="img">
  {/* 每一段按 segs 渲染 */}
</svg>
```

**性能纪律**（v5 §5.2 + ECHO UI guide）：
- 路径**只在 `state` 事件到达时重算**（不是每帧）
- 形变动效走 CSS `transition: d`（`--dur-geom`），**不进 React render path**
- **`aria-label` 必须有**：它是真实信息，不能只是视觉（v5 §10、R1）

### 4.5 位置

**播放栏左侧，紧邻封面，24px 高，宽 ≥ 320px**（v5 §2.1、§12）。
理由：它是"正在发生的事"，该在播放轴线上。

---

## 5. 第 3 步：C1 —— 光（照搬 GDK 的 5 个操作）

### 5.1 只有 5 个操作，不许发明第 6 个

**这是 Nothing GDK 的真实 API**（v5 §1.3，一手证据）：

| 操作 | GDK 对应 | 本项目用法 |
|---|---|---|
| 全暗 | `turnOff()` | 无曲目 / 引擎未连接 |
| 常亮 | `toggle()` | 已装载未播 / 暂停 |
| 呼吸 | `animate()` | **播放中**（周期 4s） |
| 进度 | `displayProgress()` | 加载 / 扫描 / seek |
| 进度+全亮 | `displayProgressAndToggle()` | 扫描中 + 引擎已就绪 |

**4 个编码维度**（同样照搬）：`通道(空间)` / `时长` / **`计数(闪几下)`** / **`节奏(interval)`**。
**不用颜色区分状态**（颜色只表达严重级别）。

### 5.2 载体（待 owner 裁决，但可以先做）

**建议**：**顶栏状态点（8×8px）+ 窗口左边缘 1px 光带**。
理由：边缘光在**余光中最有效**——它模仿的正是"机器边缘在发光"，是 Nothing 的物理。

> **这条是 v5 §12 的第 1 处待裁决项。** 如果你要开始做，先按建议实现，owner 若改主意只需换载体、编码逻辑不变（因为编码是纯函数式的）。

### 5.3 ⚠️ 硬规则：不允许"装饰性"的循环动画

> **C1 的每一次变化必须由真实事件触发**（`state` / `xrun` / `device_changed` / `scan_progress`）。
> **禁止"为了好看"加循环动画。**

依据：无因果的光会**稀释 C1 的信噪比**，违反 R1（状态必须可判定）。

---

## 6. 第 4 步：Apple 层（动效 / 交互）

**Apple 给"状态之间怎么过渡"，Nothing 给"是什么状态"。**

### 6.1 频率门控（`animate` 硬规则，先做减法）

| 交互 | 频率 | 决定 |
|---|---|---|
| 空格 / ←→ | **100+/日** | **零动画** |
| 列表 hover | 数十次/日 | **仅颜色**，无位移 |
| **C1 模式切换** | 每次状态变化 | **不插值，跳变**——光只有亮/灭，跳变才符合物理 |
| **C2 几何形变** | 切歌 / 换设备 | **动**（最有价值的动效） |
| 进度条拖动 | 手势 | 1:1 跟手 + 弹簧 |

### 6.2 C2 的形变（本方案最有价值的动效）

```css
/* 采样率竖线的高度 —— 像一根被拨动的弦 */
.c2-bar-src { transition: height var(--dur-geom) var(--ease-immerse); }
/* 直线 ↔ 折线 —— path 变形 */
.c2-seg-path { transition: d var(--dur-geom) var(--ease-in-out-screen); }
```

### 6.3 进度条（唯一需要复杂手势的地方）

**照 `apple-design` 的五条**（v5 §5.3 有完整表）：

| 环节 | 做法 |
|---|---|
| 抓取 | `setPointerCapture` + **尊重抓取偏移**（按下在 30% 就一直是 30%） |
| 拖动 | 1:1 跟随 + **时间码持续反馈** |
| 边界 | **橡皮筋**（渐进阻力，不硬停） |
| 释放 | **速度投影**决定落点 |
| 打断 | 从**当前显示值**继续，不从目标值 |

```js
// Apple 的投影函数（不是物理课本的 v²/2a）
function project(v, d = 0.998) { return (v / 1000) * d / (1 - d); }
const target = clamp(current + project(releaseVelocity), 0, duration);
```

### 6.4 「仪器按钮」纪律（Nothing 主导）

- 按下反馈用**变亮**（`rgba(255,255,255,0.07)`），**不用 `scale`** —— 仪器按钮不缩
- **焦点环固定高对比白**，**不得用 `--accent`**（浅色封面上会消失）

---

## 7. 需要走 CR 的部分（不要自己加字段）

### 7.1 ⚠️ DSP 段的字段还不存在

C2 第四段（DSP）需要"**本次播放中 DSP 是否生效**"，但现在只有 `capabilities.dsp`（能力声明）。

**建议的 CR**（接在已有 CR-007 之后）：

```
字段：state.dspActive: boolean
理由：capabilities.dsp 表示"有能力做"，不等于"当前正在做"。
     界面需要后者才能画波浪线；否则只能画一个永远存在的"能力"标记，
     那是把能力当状态，会误导。
参考：SPEC §3.5 已要求「EQ 开启时 Audio Status 必须表达 dspActive = true
     / bitPerfectCandidate = false / bitPerfectDisabledReason = eq_enabled」
     —— 这不是新需求，是把 SPEC 已有的要求补成协议字段。
```

**在字段到位之前**：DSP 段**不画**（`capabilities.dsp: false` → 不画这一段）。
**不要用别的方式猜**——那违反"界面只画引擎声明支持的东西"。

### 7.2 ⚠️ `ERR_UNSUPPORTED` 需要区分两种情况

| 情况 | 用户该做什么 |
|---|---|
| 引擎没实现（如 M1 的 `pick_folder`） | 等后续版本 |
| 本机硬件不支持（如独占格式受限） | **换设备或换格式——可以行动** |

**建议走 CR**：要么拆成两个错误码，要么在 `message` 里明确写清是哪一种。
**这直接影响 C3 的文案分级**（v5 §3.3、`DESIGN-A-engine.md` §6）。

### 7.3 `xrun` 的双来源（需要 A 定语义）

`state.xrunCount`（累计）与 `ev: 'xrun'`（瞬时）**用途不同**：

| 用途 | 来源 |
|---|---|
| C1 闪 2 次 | **`ev: 'xrun'`**（事件语义） |
| C2 抖动标记 | **`ev: 'xrun'`** |
| C3 数字 `xrun N` | **`state.xrunCount`** |

**风险**：两者不一致时界面会显示矛盾数字。**已在 `DESIGN-A-engine.md` §4 请 A 定语义**，你按结论接。

---

## 8. 对现行 `theme.css` 的处置

| 处置 | 项 |
|---|---|
| ✅ **原样保留** | 四条缓动曲线令牌（`animate` 硬规则 3：不分叉）· 湿玻璃三要素（收到**一处**使用，v5 §6.2）· 三区布局骨架 · 导航竖线生长动画 · 现有两块 `prefers-reduced-motion` · `.mono` 等宽数字传统 |
| 🔄 **修改** | 强调色 → 令牌 · 基底 → `--surface-*` · `--text-dim` 用于 `LIBRARY` 占位处**升到 `--c3-muted`**（那是信息，不是装饰；2.4:1 不达标） |
| ❌ **废弃** | 「澄明之境」蓝水隐喻 · 歌词纯 `blur` 过渡（升级为 Z 轴，v5 §6）· 16px 圆角 · **v3-signal 的工业网格线**（那是模仿产物，v5 §6.1 已论证撤销） |

**所有改动都必须在 `check:tokens` 下进行**（§3）。

---

## 9. 第 5 步：验证（三条可执行 + 三件人眼）

### 9.1 可执行的（你来跑）

| # | 检查 | 怎么做 | 通过标准 |
|---|---|---|---|
| **V1** | **马赛克测试（R1）** | 界面截图 → 缩到 24×16 再放大 | 仍能判断"在播吗 / 音质有没有问题" |
| **V2** | **令牌检查** | `npm run check:tokens` | exit 0，**且基线未上升** |
| **V3** | **C2 语法断言** | `npm test -- encodePath` | §4.3 六条全过 |

**V1 是设计系统的验收核心**——它直接检验 R1（状态必须在 C1/C2 中可判定）。
**V1 失败 = 有状态漏了通道**，回 v5 §3 的表查。

### 9.2 人眼的（必须 owner 看，你不自称通过）

| 项 | 怎么验 |
|---|---|
| **呼吸的节奏**（4s 是否合适） | 播放 5 分钟，用余光感受"是否会打扰" |
| **C2 折线形变的手感** | DevTools 动画检查器，**放慢 4×** 逐帧看 |
| **氛围光强度** | 换 3 张封面（暗/亮/单色），确认文字可读性不下降 |

> **不要在这三项上自称通过。** 它们只能由人在真机上看——这是 `verification-before-completion` 的边界。

---

## 10. 第 6 步：Punctum（点阵字，可选但推荐）

**已核实的一手事实**（v5 §13）：

| 事实 | 值 |
|---|---|
| **许可** | **OFL-1.1** ✅（仓库有 `OFL.txt`） |
| **可变轴** | **`ROND` + `wght`** ⚠️ **不是 `DOTS`**（那是我 v3 编的） |
| **Web 文件** | `Punctum-VF.woff2` —— **5.3KB，体积极小** |
| 另有 | `Punctum-Pixel{Thin..Black}.ttf`（49KB×5，更硬的像素感） |

```css
@font-face {
  font-family: 'Punctum';
  src: url('/fonts/Punctum-VF.woff2') format('woff2-variations');
  font-weight: 300 900;
}
.c2-label {
  font-family: 'Punctum', ui-monospace, monospace;
  font-size: 10px;                     /* 必须小：放大后点变粗块 */
  letter-spacing: 0.08em;              /* 点阵字必须放开字距 */
  font-variation-settings: 'ROND' 0.0; /* 0 = 最硬的方形点 */
}
```

**纪律（v5 §2.2）**：
1. **只用于 ≤14px 的标签与数字**
2. **绝不承载需要阅读的内容**（歌词、简介）——它是仪表盘，不是书
3. **字距必须放开**（点阵需要呼吸）

**OFL 义务**：保留版权声明，**不得单独售卖字体**。自用无碍；若将来分发，随包附 `OFL.txt`。

> ⚠️ **落地前先拉 `fonts/` 目录确认轴的实际取值范围**（我只核实了轴名，没核实范围）。

---

## 11. 落地顺序（完整）

| # | 步骤 | 产出 |
|---|---|---|
| **1** | `tokens.css` + `check-tokens.mjs` + 基线 | **强制层** |
| **2** | `encodePath.ts`（纯函数） | C2 的编码逻辑 |
| **3** | `encodePath.test.ts`（六条断言） | **把判定表变成规格** |
| **4** | C2 渲染（SVG）+ 放进播放栏 | **系统的心脏** |
| **5** | C1 的 5 个操作（顶栏点 + 边缘光） | 覆盖全部播放状态 |
| **6** | **V1 马赛克测试** | **做错了现在发现** |
| **7** | C2 几何形变动效 | 最有价值的动效 |
| **8** | 进度条 Apple 化 | 交互体验 |
| **9** | 氛围光 | 最后加 |
| **10** | Punctum 接入 | 性格 |
| **11** | 颜色令牌替换（渐进，基线只降） | **颜色最后做——它已是配角** |

> **做到第 6 步系统就成立**；7–11 是把它做漂亮。

---

## 12. 明确**不要**做的事

| 不要 | 为什么 |
|---|---|
| ❌ **抄 Nothing 的外观产物** | 黑底/点阵齐上/红点缀/工业网格线是**产物**。照抄 = 得到一套像它但**不会生长**的皮肤（v5 §0） |
| ❌ 画**装饰性网格线** | Nothing 的网格是**真实硬件结构**。软件里画满线是模仿产物（v5 §6.1 已论证撤销） |
| ❌ **为好看加循环动画** | 违反 R1（无因果的光会稀释 C1 信噪比） |
| ❌ 用**颜色**编码音质 | C2 必须**零色彩依赖**——否则色盲与亮色主题都要重做（v5 §8） |
| ❌ **降级用红色** | 本机长期降级，红色会失去信号价值。**用琥珀虚线**（v5 §3.2） |
| ❌ 自己加契约字段 | 走 `docs/contract-requests.md`（CONTRACT §8） |
| ❌ 让 position **进全局 store** | 你已经做对了（`positionStore`），**保持** |
| ❌ **一次全改 `theme.css` 531 行** | 渐进改造 + 棘轮基线（§3.4） |

---

## 13. 需要 owner 裁决的四处（来自 v5 §12）

| # | 问题 | 建议 | 影响你什么 |
|---|---|---|---|
| **1** | **C1 载体** | 顶栏状态点 + 窗口左边缘 1px 光带 | 可先按建议实现（编码是纯函数，换载体不动逻辑） |
| **2** | **C2 位置** | 播放栏左侧紧邻封面，24px 高 | 同上 |
| **3** | 降级用琥珀虚线不用红 | 接受 | **已在方案里**，除非 owner 改 |
| **4** | 是否引入 Punctum | 引入，只用于 C2 标注与数字 | §10 已给技术细节 |

---

## 14. 一句话

> **Nothing 画出了机器的内部，Apple 给了它光学与物理，北欧决定它什么时候闭嘴。**
>
> **你的 KPI**：让这三件事在**代码里成立**——不是写在文档里。
>
> **最强的检验是 V1**：把界面糊成马赛克，还能判断"在播吗 / 音质有没有问题"。
> **能，系统就活着；不能，回去看 v5 §3 的表，有状态漏了通道。**
