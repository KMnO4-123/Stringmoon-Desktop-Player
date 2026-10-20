# EQ 完整参数 / 卡住 / 无法撤销（2026-10-17）

用户反馈三件事：**没有完整的 EQ 参数**、**会卡住**、**无法撤销**。三个都是真的，而且两个是同一个根因。

## 1. 根因：解析器仍然强制 SPEC 固定网格

引擎早就支持每段独立频率（CR-019），但 `app/src/renderer/src/audio/dspState.ts` 里还留着：

```ts
if (band.freq !== EQ_FREQUENCIES[index]) return null
```

后果是一条完整的故障链：

```text
把某个频段拖离 31.25/62.5/… 网格
  → 引擎回包里 freq 不再等于网格值
  → 整份参数被判为非法，parseDspState 返回 null
  → store 里 dsp 变 null
  → 面板显示「完整参数尚未就绪」/「尚未取得完整的均衡器参数」
  → ready=false，所有控件与撤销按钮一起变灰
  → 点「重新读取」读回来还是同一份 → 永久卡住
```

「没有完整的 EQ 参数」「会卡住」「无法撤销」是这一条链上的三个症状。

**频段的身份是槽位下标，不是它的频率。** 现在只校验范围（10–24000 Hz）。

## 2. 第二个缺陷：每段的 type/q 在解析时被丢掉

引擎发的是 `{freq, gainDb, q, type}`，解析器只留了 `{freq, gainDb}`：

```ts
bands.push({ freq, gainDb })   // ← q 与 type 消失
```

于是「所选频段」的类型/Q 控件永远显示默认值，改了也回不来，频响曲线也一律按
全局 Q 的 peaking 计算 —— 画的不是引擎在跑的东西。两处都修了：

- 解析：保留并校验 `q`（0.1–10）与 `type`（peaking/lowShelf/highShelf）。
- 曲线：`calculateResponse` 按段设置 `filter.type` 与 `filter.Q = band.q ?? eq.q`。

## 3. 撤销：只有「应用预设」会压快照

滑杆、拖动把手、形状控件改完都进不了撤销栈，按钮一直是灰的。
改成**手势级**粒度（800 ms 内只压一次）：

```text
一次拖动 = 一步撤销（不是每像素一步，也不是零步）
覆盖：增益滑杆 / 拖动把手 / 频段类型 / 频段频率 / 频段 Q / 前级增益 / 全局 Q / EQ 开关 / 归零
```

顺带修了 Ctrl+Z 监听器：原来没有依赖数组，每次渲染都重挂一遍；现在挂一次、用 ref 取最新实现。

## 4. 「读取中」永不结束

`refreshDspDetails` 的 promise 一旦挂住就再也不会清空 `refreshing`，界面永远停在「正在读取」。
加了 6 秒超时 + 明确报错，至少留一个能点的重试。

## 5. 验证

```text
真实引擎往返：set_eq 把第 4 段设成 freq=1234.5 / lowShelf / q=2.2
  → get_state → 应用的真实解析器
  → {"freq":1234.5,"gainDb":4.5,"q":2.2,"type":"lowShelf"}   修复前这里是 null

新增 3 条断言（frequency-state.test.mjs）：
  离开网格的频段仍得到完整参数 / 每段 type+q 保留 / 非法值仍被拒绝

app 274/274   electron 79/79   tokens 0   build 通过
```
