# 音频控制中心 · 横向铺满重做（v5，2026-10-18）

> 触发：用户反馈「音频控制界面做成横向展开的，不要居中或者缩成一块，留出一大片空白，
> 观感不舒服。同时美化 UI，统一主题。」
> 范围：只动渲染层（`audio-console.css` 重写 + `AudioControlCenter.tsx` 少量结构调整 + 侧栏文案），
> 以及一处由此暴露出来的真实缺陷（歌词逐字填充会被可见性状态锁死）。引擎、IPC、协议零改动。

## 1. 旧布局为什么「缩成一块」

旧实现是 `.audio-grid { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)) }`，
而每个 tab 里只有 1~4 张卡片。于是：

| 现象 | 原因 |
|---|---|
| 「输出」tab 只有左边一张窄卡、右边全空 | auto-fit 在 1031px 宽下排出 3 列，但 `输出` 只有 1 张卡，占 1/3 |
| 卡片内部控件竖着排、右边留白 | 卡片是纵向 flex，控件逐行堆叠，控件本身的宽度被压到卡片 1 列 |
| 2K 屏上更糟 | auto-fit 会排出 8~10 列，每列 200px，卡片被切碎 |

结论：**控制界面的正确模型是「整行控制带」而不是「网格里的小卡片」**。

## 2. 新布局模型（改这个文件的人先读这节）

```
.audio-console            纵向堆叠：头 → tab 条 → 面板 → 脚注
  .audio-tabs             整行等分（grid-auto-flow: column + 1fr），不再缩成左上角胶囊
  .audio-panel
    .audio-grid           纵向堆叠「控制带」（flex column）
      .audio-card         一条控制带：标题横跨整行；其下每个 .audio-field 在
                          repeat(3, 1fr) 栅格里横向流动（宽屏 4 列、≤1180px 2 列、≤620px 1 列）
```

- `.audio-card` 用**显式断点列数**（3 / 4 / 2 / 1），不用 auto-fit：auto-fit 在超宽屏会把控件压成窄缝。
- `.audio-card { align-items: start }`：每个控件盒子按自身内容收口，**不被邻格拉成一样高**。
  旧版用 stretch，「左右交换」这种只有一个复选框的格子会被撑到 172px，就是用户说的「一大片空白」。
- 个别控制带有自己的列数：`输出` 2 列（设备下拉 + 7 档采样率需要更宽）、`限幅器` 4 列（四个参数天然一组）。
- `.audio-card::before` 左侧一道 1px 强调线，`.audio-card-head` 右侧一句话说明；带之间有 16px 间距。
- 材质与设置页同源：`--surface-panel` + 一层 `--hover-strong` 顶部微光；hover 才加边框/阴影，
  静止态不抢注意力。所有色值/时长/字号都走 token（`check:tokens` 0 violations）。

## 3. 主题统一

| 位置 | 改动 |
|---|---|
| 侧栏 | 文案「音效」→「**音频**」（页面现在叫「音频控制中心」，四个 tab 也不止音效） |
| 音乐空间 | 快捷按钮「音效」→「音频」，tooltip 改为「均衡器、声道、输出与解码」 |
| 页面头 | 与设置页/发现页同一口径：eyebrow + h1 + 一句话说明；右侧引擎状态胶囊 + 应用反馈胶囊 |
| tab 条 | 整行等分胶囊条，选中项用 `--selection` + 下沿 1px `--track-accent` |
| 面板底色 | 加一层 `radial-gradient(... --track-wash)` 环境光，与发现页一致 |
| EQ tab | FrequencyPanel 套进与其它带相同的卡片材质（.audio-panel[data-audio-panel='eq']） |

## 4. 由此暴露的真实缺陷：歌词逐字填充会被可见性锁死

e2e 里「逐字填充」断言开始 **50% 概率假红**。加 `data-visible` 探针后确认：`.lyrics`
的 `data-visible="false"` —— IntersectionObserver 在视图切换的过渡里报了**一次** false
（元素瞬时零尺寸），此后 `visible` 再也没被救回来。

后果（真实用户可见）：`subscribe` 里 `if (!visible) return () => {}` 会让 position 订阅直接变空操作，
**歌词再也不逐字填充**，直到组件重挂载。这不是测试问题，是产品缺陷。

修复（`app/src/renderer/src/components/LyricsView.tsx`）：

1. `subscribe` **不再看 `visible`**：每次 position 事件按真实布局判断
   （`container.getClientRects().length === 0` 才算隐藏），可见就落格；
2. `visible` 只保留一个职责——决定补间 rAF 循环要不要开，并且观察器回调改为读 `getClientRects()`，
   同时监听 `window.resize` 兜底重判；
3. 根节点加 `data-visible` 属性：以后同类问题可以直接从 DOM 读状态，不用再猜。

修复后连跑 4 轮 e2e 全绿（`177/177, 0 fail` ×4）。

## 5. e2e 判据（新增 5 条，总数 172 → 177）

```
AUDIO_GEOMETRY {"bandWidth":1031,"mainWidth":1105,"tabsWidth":1031,"columns":2,"fields":6,"fieldRows":3,"rightGap":42}
```

- 每条控制带宽度 ≥ 主区域 85%（不是窄卡居中）
- tab 条宽度 ≥ 主区域 85%（不是左上角小胶囊）
- 控制带内栅格列数 ≥ 2（控件横向铺开）
- 同一带内控件行数 < 控件数（并排而不是竖排）
- **控件盒子不被拉伸**：`声道工具` 三个控件高度 73/76/172px、顶边对齐、极差 ≥ 20px
- 900×800 窄窗：页面与 .audio-console 无横向溢出，控制带仍 ≥ 2 列
- 截图证据：`audio-console-eq-1400.png` / `-stage-1400.png` / `-output-1280.png` / `-limiter-1400.png`

## 6. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（node + web） | exit 0 |
| `pnpm check:tokens` | 0 violations |
| `pnpm check:css` | braces balanced |
| `pnpm test:app` | 449 / 449 |
| `pnpm build` | exit 0（css 178.28 kB / renderer 2.79 MB） |
| `pnpm test:electron` | **177 / 177，0 fail**（修复前 50% 假红，修复后连跑 4 轮全绿） |

安装包：`app/release/Stringmoon-Setup-0.3.1.exe`（根目录 `<仓库根>\\Stringmoon-Setup-0.3.1.exe` 同份），
117,281,940 B，sha256 `a73492a2cf95644ba457b5532c14335d25ea955fa37f0fd93996a666c47e9b76`。
包内 `app.asar` 的 main/renderer 与 `out/` 逐字节一致、包内引擎与 `engine/bin` 逐字节一致（已核）。
