# 修复方案 · `preventClip` 的 peak 口径

> **状态**：现行 · **日期**：2026-10-16 · **给谁**：AI-B（应用侧为主）+ AI-A（引擎侧一行）
> **上位**：[`OPTIMIZE-v1-candidates.md`](OPTIMIZE-v1-candidates.md) §2.1b
> **性质**：**正确性问题**，不是听感问题

---

## 0. 结论（先说清现在到底有没有事）

> **生产路径上现在没事（因为还没接线）；而测试路径上它是被验证过的。**

| 事实 | 依据 |
|---|---|
| 引擎**不会**用扫描出的 peak 自动填 `dspParams_` | `setReplayGainValues` 全仓只有两个调用点：`app.cpp:1116`（命令处理）与 selftest |
| 应用侧**从未调用** `set_replaygain` | 全 `app/src` 搜索**零命中**；它只**读** `dspState`，不**写** |
| 应用侧读 `rgTrackPeak` 吗 | ❌ 没有 —— `dspState.ts:81` 只解析 `mode / trackGainDb / albumGainDb` |

**→ 所以生产路径上 `rgTrackPeak` 一直是默认值 `0.0f`**，
而 `dsp.cpp:139` 有 `if (peak > 0.0f)` 守卫 → 封顶逻辑在**生产**中不生效。

### 0.1 ⚠️ 更正：它**不是**"从未被执行过"

**我上一版写"这段代码从未被执行过"——那是错的。** `app_selftest.cpp` 里**两条分支都被断言了**：

```cpp
// ① 封顶生效
p.rgTrackGainDb = 6.0f;
p.rgTrackPeak   = 1.0f;      // ← 非零，且注释写着 "a peak already at full scale"
p.preventClip   = true;
check(fabs(chain.staticGainDb()) <= 0.1001f,
      "preventClip caps a track whose peak is already at full scale");

// ② 无 peak 数据时按原值应用
DspParams q = p;
q.rgTrackPeak = 0.0f;
check(fabs(chain.staticGainDb() - 6.0f) <= 0.001f,
      "without peak data the ReplayGain value is applied as-is");
```

**→ 这个模块的测试质量比我上一版判断的高。**
`1.0`（线性满刻度）→ `-20*log10(1.0) = 0` → ceiling `-0.1` → **断言 `<= 0.1001` 正好命中**。

**⚠️ 所以真正的问题不是"代码没测过"，而是**：
**测试覆盖了"peak 对/不对"两种，但没有覆盖"peak 是用哪种口径算的"** ——
**而后者正是生产接线时唯一会出错的地方。**

---

## 1. 问题（为什么会错）

`dsp.cpp:137-144` **只接受一个 peak**：

```cpp
if (params.preventClip) {
    const float peak = album ? params.rgAlbumPeak : params.rgTrackPeak;
    if (peak > 0.0f) {
        const float ceiling = -20.0f * std::log10(peak) - 0.1f;   // 封顶到 -0.1 dBFS
        rg = std::min(rg, ceiling);
    }
}
```

**而引擎同时算出两个**（`analysis.cpp:78-92`）：

```cpp
double truePeak = 0.0, samplePeak = 0.0;
truePeak   = std::max(truePeak,   tp);
samplePeak = std::max(samplePeak, sp);
out.truePeakDb   = linearToDb(truePeak);
out.samplePeakDb = linearToDb(samplePeak);
```

**⚠️ 关键**：`truePeak >= samplePeak` **恒成立**（真峰值包含样本间过冲）。
所以：

| 传哪个 | 后果 |
|---|---|
| **samplePeak**（RG2 默认口径） | ⚠️ **封顶算得过松** —— 可能允许一个真的会削波的增益 |
| **truePeak** | ✅ **正确** —— 削波发生在**重建后的模拟波形**上 |

**差值可达 1–3 dB**（在有样本间过冲的素材上）。

---

## 2. ⭐ 但真正的缺陷比"传错值"更根本

**引擎的 `DspParams` 无法表达"我用的是哪种 peak"。**

即使应用侧传了 `truePeak`，**外界（UI / 日志 / 未来的 C2 通道）也无从知道**。
而 `truePeakBasis`（`'oversampled'` | `'sample'`）这个字段已经存在于 **CR-015 的 meter 事件**里 ——
**同一个概念在两条路径上的表达不一致。**

**→ 所以修法分两层**：
**① 传对值**（应用侧）；**② 让口径可被表达**（契约，一个字面量）。

---

## 3. 方案

### 3.1 应用侧（AI-B）：传 `truePeakDb`，并**做 dB→线性 转换**

`analysis.cpp:91-92` 产出的是 **dB**，而 `set_replaygain` 的 `trackPeak` 要的是**线性**（见 §5）。

```ts
// 应用侧接线 ReplayGain 时应这样传
const rg = await engine.analyzeLoudness({ trackIds })

await engine.setReplayGain({
  mode: 'track',
  trackGainDb: rg.trackGainDb,
  trackPeak:   Math.pow(10, rg.truePeakDb / 20),   // ⚠️ 必须转换，漏了就静默算错
  preventClip: true,
})
```

**⚠️ 这个转换是本次最容易被漏掉的一步** —— 因为**漏了不会报错**（见 §5 的后果分析）。

**⚠️ 三条纪律**：

| # | 纪律 |
|---|---|
| **1** | ⭐ **用 `truePeakDb`，不用 `samplePeakDb`** |
| **2** | ⚠️ **注意 192k 退化**：`samplerate >= 192000` 时 `interp = NULL` → **真峰值退化为样本峰值**。此时两者相同，**但 UI 必须如实标注** |
| **3** | ⭐ **`truePeakBasis` 要能看到** —— 否则用户不知道"真峰值"是不是真的 |

### 3.2 引擎侧（AI-A）：让"峰值口径"成为可核对的事实

**这是必须走 CR 的部分**（`dspModules` / `get_state.dsp` 是契约）。

```
CR-017（建议）：在 get_state.dsp.replayGain 下增加 peakBasis 字段
  "peakBasis": "true" | "sample" | null

  语义：
    "true"   = preventClip 用的是真峰值（≥ 样本峰值，含过冲）
    "sample" = 用的是样本峰值（192k 退化，或调用方明确选择）
    null     = preventClip 未启用或 peak 为 0
```

**为什么值得进契约**（而不是只在 UI 里注一句）：

| 理由 | 说明 |
|---|---|
| **与 CR-015 的 `truePeakBasis` 同一概念** | 两条路径应有**一致的字面量**，否则将来会分叉 |
| **满足「界面不能声称一件没发生的事」** | 若 UI 显示"防削波已启用"但它用的是样本峰值，**那是失真宣称** |
| **它让"封顶到底有没有生效"可核对** | 现在 `peak > 0.0f` 守卫会让整段逻辑静默不执行 |

### 3.3 顺带修一条：**`peak <= 0` 时应当被记录，而不是静默跳过**

```cpp
if (params.preventClip) {
    const float peak = album ? params.rgAlbumPeak : params.rgTrackPeak;
    if (peak > 0.0f) { ... }
    // ⚠️ 现在这里没有 else：peak == 0 时封顶被静默跳过
}
```

**`peak == 0` 是合法的**（selftest 就构造过：`q.rgTrackPeak = 0.0f`——
"一个 peak 为 0 的文件"在语义上就是"不知道 peak"，**不是"没有过冲"**）。

**→ 建议**：`peak == 0` 时**不让 `preventClip` 静默通过**，
而是让 `outputNotPerfectReason` 或 `peakBasis: null` 表达出来 ——
**"我不知道 peak"和"peak 是安全的"是两件事。**

---

## 4. 验收

| # | 断言 | 怎么测 |
|---|---|---|
| **1** | ⭐ **`truePeak >= samplePeak` 恒成立** | 造一个**有意过冲**的信号（如 0.99 幅度的方波经重采样）→ 断言两值关系 |
| **2** | ⭐ **传 truePeak 时的封顶比传 samplePeak 更保守** | 同一素材，两种传法 → 断言 `truePeak` 得到的增益 ≤ `samplePeak` 的 |
| **3** | **`peak == 0` 时不静默通过** | 传 0 → 断言 `peakBasis` 为 `null`（或有明确原因），**不是假装封顶成功** |
| **4** | **192k 退化被如实标注** | 192k 素材 → `peakBasis` 应为 `'sample'`，且 UI 有可见标注 |
| **5** | **封顶确实生效** | 造"peak 高到会削波"的素材 + 大增益 → 断言输出**不削波**（这正是这段逻辑存在的理由，而它**从未被执行过**） |

⭐ **第 5 条仍然重要，但理由要更正**：
**它在自检里已被覆盖**（`peak = 1.0` → 断言封顶到 `-0.1 dB`），
**但那条断言用的是"假设已知的 peak"**。

**生产要补的是端到端**：
**从 `analyze_loudness` 的真峰值 → `dB→线性` 转换 → `set_replaygain` → 封顶生效**，
并断言**最终输出真的不削波**。

**→ 缺的不是"公式对不对"，而是"接线对不对"。**

---

## 5. ✅ 单位已确定：**`trackPeak` 是线性值**（不是 dB）

**上一版我把它列为"未知"。它其实有确定答案，四条证据一致：**

| # | 证据 | 说明 |
|---|---|---|
| **1** | ⭐ `app_selftest.cpp`：`p.rgTrackPeak = 1.0f; // a peak already at full scale` | **1.0 = 满刻度 → 线性** |
| **2** | `dsp.cpp:142`：`-20*log10(peak)` | ⭐ **公式要求线性输入**（传 dB 会得到无意义结果） |
| **3** | 参数名 `trackPeak`（**无 `Db` 后缀**） | 命名约定指向线性 |
| **4** | 自检断言 `fabs(staticGainDb()) <= 0.1001f` 配合 `peak = 1.0` | ⭐ **`-20*log10(1.0) = 0` → ceiling `-0.1` → 断言正好命中**，**公式被直接验证过** |

**→ 结论：线性。应用侧必须做 `dB → 线性` 转换。**

⚠️ **这个转换正是最容易漏的一步**：
`analysis.cpp:91-92` 产出的是 **`truePeakDb`（dB）**，
而 `set_replaygain` 的 `trackPeak` 要的是**线性**。

```ts
trackPeak: Math.pow(10, result.truePeakDb / 20)   // ← 必须做，漏了就会静默算错
```

**漏掉的后果**：若把 `-3.0`（dB）当线性传进去，
`-20*log10(-3.0)` → **`NaN`** → `std::min(rg, NaN)` 的行为未定义
→ **可能静默取消封顶，或产生无意义的增益**。**不会报错。**

---

## 6. 一句话

> **这条的价值不在于"改一个参数"**，而在于：
>
> ⭐ **它揭示了一段从未被执行过的代码。**
> `preventClip` 是 SPEC 3.4 明确要求的功能，**有测试、有字段、有注释** ——
> 但因为 `rgTrackPeak` 一直是 0，**它的封顶分支从来没跑过**。
>
> **所以真正该做的是：让它跑起来，并证明它真的防住了削波。**
> 顺带把口径（true / sample）变成**可核对的事实**。
