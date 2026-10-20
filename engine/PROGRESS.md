# engine/PROGRESS.md

**AI-A（引擎）的工作记录。** 只写三件事：做到哪了、下一步是什么、踩过哪些坑。
构建与使用说明在 [README.md](README.md)；协议与边界在仓库根目录 [CONTRACT.md](../CONTRACT.md)。

## 0z8. 播放过渡与默认输出链路（2026-10-17）

用户反馈播放、暂停、切歌时有明显杂音，且自动输出听感发糊。根因集中在三处：

1. 新引擎默认停在 shared，渲染层 `auto` 又因采样率为 0 跳过了握手下发，导致自动模式没有机会优先尝试独占；现在默认请求为 `auto`，握手后总是重发偏好，独占失败时保留明确的 shared 降级原因。
2. 播放和重启路径曾把独占流的淡入关闭，任意波形位置直接起播；所有 `start()` 路径统一使用 5 ms 淡入。
3. 淡出完成判断曾等待渲染线程退出，且短读的静音补帧不推进淡出时钟，暂停/切歌经常超时后硬停；现在按设备已播放帧判断端点排空，并按每个输出帧推进淡出。

同时把 meter 的 IPC 序列化恢复为 `set_meter enabled:true` 可见性门控，避免隐藏监测时持续传输大帧。新增 `tools/test-default-output.mjs` 覆盖自动输出的真实降级原因。

验证：`--selftest`、默认输出回归、静音播放生命周期 73 项、应用测试 298 项、Electron 全链路 105 项，以及 lint/build 均通过。

## 0z7. 频谱低频断口（2026-10-17）

用户反馈「频谱图低频段不连续」。**先算，再改**——算出来的结果是确凿的：

```text
48 段是 20 Hz–20 kHz 的对数分布，最低几段的绝对宽度只有 1–3 Hz
2048 点 FFT @48 kHz → bin 宽 23.4 Hz，比那些段本身还宽
first = ceil(low*N/fs)，last = floor(high*N/fs)，first > last 时直接 continue
→ 实测 48 段里有 8 段永远停在底噪（band 0/2/3/4/5/7/8…），画出来就是断口
```

两处改动：

1. **kWindowFrames 2048 → 8192**（bin 宽 23.4 → 5.86 Hz）。48 段里的空洞从 8 个降到 2 个。
2. **空区间不再 continue**：用中心两侧的 bin 按位置线性插值。低频段比一个 bin 还窄是物理事实，
   **留空是错误处理**——插值至少保证这一段有值，而不是让底噪冒充数据。

### 顺手修掉一个栈溢出

把窗口改成 8192 之后，`--selftest` 直接 `STATUS_STACK_OVERFLOW`（0xC00000FD）。
原因：`te::App` 是 `main()` 的**栈上局部变量**，而 App → Player → MeterAnalyzer/MeterTap 里
的缓冲随 kWindowFrames 线性增长（8192 时约 1.4 MB），超过 1 MB 默认栈。

修法不是在 main 里加大栈，而是把这些**一次分配、之后只读写**的缓冲移到堆上：
`MeterTap::slots_` 与 `MeterAnalyzer` 的六个数组改成 `std::unique_ptr<T[]>`，在 `prepare()` 里分配。
这同时保住了「渲染线程零分配」——分配发生在控制线程。


### 追加：8192 点窗口把刷新率拖垮了（用户：帧率好低，观感很卡）

把 kWindowFrames 提到 8192 换低频分辨率，代价是**帧率**：`MeterTap::push` 每填满一个窗口才发布一帧，
8192 @48 kHz = **5.9 帧/秒**。实测 `ev: meter` 事件 **6.0 次/秒**（原来 23.4），肉眼就是卡顿。

修法不是二选一，而是把两件事解耦：

```text
窗口（决定刷新率）  = 2048  → 23.4 帧/秒
FFT（决定 bin 宽）  = 8192  → 5.86 Hz/bin（补零，不增加真实分辨率）
```

补零的代价是**归一化**：同一主瓣被摊到 4 倍数量的 bin 上，全带求和会放大 4 倍 → 不修正就凭空抬高 6 dB。
所以幅度除以 sqrt(kFftFrames / kWindowFrames)，并新增一条断言把刻度钉住：0.5 幅度、1 kHz 正弦的峰值段
必须落在 -8…-4 dB（实测 -4.65 dB，差值是带内求和与 Hann 换能）。

```text
修复后实测：meter 21.3 次/秒；最低 8 段 = -72.0 -71.7 -69.3 -68.2 -65.7 -63.7 -61.9 -55.9（连续渐变）
--selftest all checks passed   --step=dsp 24/24   app 271/271   electron 79/79
```

### 追加二：21 帧 → 65 帧（继续优化）

21.3 帧/秒还是不够顺。逐层量过之后，天花板不在 FFT 上：

```text
tap 发布      94 次/秒（kHopFrames=512 的重叠分析）
analyze       44 次/秒
emitMeter 调用 39 次/秒   ← 卡在这里
控制循环       65 次/秒   ← 真正的上限
```

两个错配，都是「节流参数与真实节拍对不上」：

1. `pollLine(5ms)` 让控制循环稳定在 **65 次/秒**（每轮约 15 ms），
   而事件节流写的是 **16 ms** —— 两个 15 ms 才凑够 16，实测只有 40 帧/秒。
   改成 8 ms 之后，每轮循环都发一帧，上限自然落到循环节拍上（实测 63–65 帧/秒）。
2. 渲染层原来**每个事件都写一次 DOM**。65 帧/秒的引擎事件与 60/120/144 Hz 的显示器不同频，
   会出现「一帧画两次、下一帧空着」的抖动。新增 `createFrameDraw` 把绘制合并到 rAF，
   SpectrumGlow 与 SpectrumPanel 都改用它。

重叠分析的三个连带修正（都不是顺手，是必须）：

```text
峰值保持衰减  用 kHopFrames 而不是窗口长度，否则峰值掉得慢 4 倍
EBU 响度      只喂最新 hop 那一小段，否则同一段样本被积分 4 次、LUFS 被抬高
槽位重叠拷贝  在写者自己拥有的槽上做，读者无共享，仍然无锁无竞争
```

还有一次自己制造的 bug：改发布条件时把 `++writeFrame_` 一起删了，写指针永远不前进，
一帧都发不出来（selftest 24 条全红）。这类「条件语句里夹带副作用」的改动必须逐字核对。

```text
新增回归断言：窗口填满后每 kHopFrames 必须发布新窗口；半个 hop 不得发布
实测：63–65 帧/秒  --selftest all checks passed  app 271/271  electron 79/79
```
### 回归测试（做了 RED 反证）

```text
白噪声下 48 段都必须高于底噪      → 修复前 2 段仍是空洞（8192 下）
40 Hz 正弦必须让最低几段抬头      → 修复前 band0/band2 都是 -72 dB
```

把插值分支换回 continue 后两条断言立刻失败，还原后全绿。

```text
--selftest  all checks passed   --step=dsp 24/24
app 271/271  electron 79/79
```

## 0z6. FIR / 房间卷积（CR-020，2026-10-17）


EQ 只能修幅度，修不了**时域**：房间低频驻波、耳机/音箱的冲激响应，参数均衡表达不了。这一轮把卷积做进去了。

### 三个决定，都不是默认选项

| 决定 | 为什么 |
|---|---|
| **IR 不走 seqlock** | 参数快照是标量；IR 是几 MB 频域数组。用独立原子指针交接，RT 只在块边界换指针，控制线程保留所有权，**RT 线程从不 delete** |
| **全湿，没有 dry/wet** | 校正冲激响应本身包含直达声；混回干声就是梳状滤波。也因此 IR 生效必须**强制**走湿路径 |
| **固定 1024 帧延迟并如实上报** | 21.3 ms @48k。分块是精度/CPU 折中；延迟写进 `latencyFrames`，不藏 |

### 验收测试就是全部证据

「听起来变了」什么都证明不了 —— 比例因子错了听起来也「变了」。所以尺子是两条：

```text
单位冲激卷积 → 输出逐样本等于冲激响应本身   (误差 < 1e-4)
任意信号     → 与离线暴力直接卷积逐样本对照 (误差 < 5e-4)
第一分区填满前无泄漏 / 上报延迟 == 分区长度
```

**做了 RED 反证**：把 IFFT 的 1/N 去掉，两条断言立刻失败（最大误差 1023.5 / 2444.7）。
这说明 (a) 测试有牙，(b) `kiss_fftri` 确实是不归一化的 —— 这个事实是测出来的，不是猜的。

### 踩到的三个坑

1. **`dr_wav` 的 IMPLEMENTATION 只能有一处**（`audio_source.cpp`），探针里再定义一次就是 LNK2005。
2. **`drwav_seek_origin_*` 常量在 `DR_WAV_NO_STDIO` 下不存在**，要按既有代码把 origin 直接转 int 传。
3. **协议来的路径是 UTF-8**，而 `MediaReader::open(std::string)` 会按 ANSI 解释 —— 中文目录直接「文件不存在」。
   必须过 `fromUtf8()`。这个坑很隐蔽：`--probe-ir` 用控制台 argv（ANSI）反而正常，只有走 JSON 的那条路才炸。

另外又一次验证了那条老规矩：**恢复源码后 `cmake --build` 不会重编**（mtime 比 .obj 旧），
看到「修好了却还失败」先 `touch` 再说。

### 驱动步骤 `--step=ir`（32 断言）

协议层原本只有手工探针，等于没有覆盖。现在 `node engine/tools/drive.mjs --step=ir` 自己写一个
**解析已知**的 WAV（`h = 1.0·δ + 0.5·δ(n-8)`，峰值 `20log10(1.5) = +3.5218 dB`），
再逐项断言 tap 数 / 分区 / 延迟 / 文件名 / 峰值 / 自动电平 / 预览曲线 / dspModules，以及**三条拒绝路径**。

它立刻抓到一个真 bug：**载入 IR 后（未播放时）`passthrough` 仍报 true**。
原因是链上的判断读渲染线程**已采纳**的指针，而停止时渲染线程根本没跑。
这正好是这个项目的老教训（「从配置报告，不从渲染线程的已采纳副本报告」）在新增状态上的重现。
修法：`dspJson` 里按配置算 `irInForce`，再与 `isPassthroughConfig` 取与。

### 实测

```text
--selftest        all checks passed（含 4 条卷积断言）
--step=ir         32/32
--step=dsp        24/24（IR 默认关闭，黄金频响不变）
协议：载入 24000 抽头立体声 48 kHz IR → 24 分区 / 延迟 1024 帧；
      enable/disable/preamp 生效；坏路径与空参数各自给出具体错误
```

## 0z5. EQ 从「十段固定」扩成「十个参数槽位」（CR-019，2026-10-17）


owner 要求「EQ 无极调节 + 曲线预设 + 外部导入 + 耳机补偿曲线」。现有 EQ 是 SPEC 3.4 的**十段固定频率**
（31.25…16 kHz）+ **一个全局 Q**，外部曲线与耳机补偿写不进去 —— AutoEQ 的参数预设里既有
`LSC/HSC` 架式滤波，也有 `PK 4001 Hz Gain 2.3 dB Q 0.25`、`PK 6639 Hz Gain 2.2 dB Q 5.82`
（后者超出全局 Q 上限 4）。所以把十个槽位改成完整的参数带：每段自己的频率、Q、类型。

### 兼容性是这次改动的硬约束

`DspParams` 里 `eqFreq/eqBandQ/eqType` **全部零初始化**，零值语义是「沿用 SPEC 网格频率 / 全局 Q / 峰值」。
于是默认构造的 `DspParams` 产生的系数与改动前**逐位相同**，既有黄金频响测试（±0.1 dB）
一个数都不用改就继续通过 —— 这正是选择「零值 = 默认」而不是「构造时填表」的原因：
后者会让默认行为依赖于初始化代码是否被执行过。

### 新增

| 项 | 说明 |
|---|---|
| `set_eq.bands[]` | 按索引局部更新 `{freq, gainDb, q, type}`；`freq:0` 回网格、`q:0` 回全局 |
| RBJ 低架 / 高架 | Q 形式（不是斜率 S 形式），因为 AutoEQ/APO 的架式滤波器给的是 Q |
| `get_state.dsp.eq.bands[].q/.type` | 报告**解析后**的生效值，客户端不必再复刻解析规则 |
| `Player::setEqBandFreq/Q/Type` | 各自带范围校验与具体错误文案 |

### 实测

```text
--selftest   all checks passed（含新增的参数带断言）
--step=dsp   24/24（黄金频响未变，证明向后兼容）
协议探针：set_eq {bands:[{type:'lowShelf'}]} → 回读 lowShelf；
          非法频率/类型被拒（"EQ band frequency must be 0 (default) or within 10 .. 24000 Hz"）；
          freq:0/q:0 复位回 1000 Hz / Q 1.41 / peaking
```

### 一条测试自身的教训

第一版断言写的是「把 1 kHz 的带移到 2 kHz 后，1 kHz 处应该几乎没有增益」——**它失败了，测量值 2.5 dB**。
那不是 bug：Q 1.41 的峰值滤波器在倍频程外本来就还有约 2.5 dB 的裙边。断言改成
「旧槽位不再是峰（< 新中心 1/3）」才是正确的物理事实。**先算清楚再写断言**，
否则会把正确实现改成错的。

## 0z4. `.ogg`：容器不等于编码，两半都得能放


owner 要求「`.ogg` 的无损播放」，并在澄清时明确**两种都要**——因为流媒体传输走 `.ogg`。

`.ogg` 是一个**容器**，同一个扩展名装两种东西：

| 容器里的编码 | 性质 | 解码器 | 实测 |
|---|---|---|---|
| Vorbis | **有损** | stb_vorbis v1.22（新引入，vendored） | ✅ 峰值 0.63 / 0.96 / 0.82，单声道也过 |
| Ogg-encapsulated FLAC | **无损** | dr_flac（原有，只是之前被 `DR_FLAC_NO_OGG` 关掉了） | ✅ `lossless=1`，与原生 FLAC 同一份代码 |

`state.sourceExact` 由 `AudioSource::lossless()` 决定，所以**不能按扩展名猜**：猜错一头会把有损文件
报成透明，猜错另一头会让人去查一个不存在的缺陷。现在由解码器回答，`.ogg` 里装的是哪一个由
`sniffOggCodec()` 在**文件头**里读出来。

### 关键技术选择：pushdata API + 自己管分页

stb_vorbis 的 pull API 只接受 `FILE*`，而本引擎必须经 `MediaReader` 读（宽字符中文路径、
HTTP URL 都是在 `MediaReader` 这层解决的）。所以走 **pushdata** API，代价是它
**既不知道长度也无法 seek**，两件事都得自己做：

1. **长度** = 本逻辑流的**最后一页**的 granule position（Vorbis 的 granule 就是累计 PCM 帧数）。
   反向扫文件尾部 128 KiB 找该页。判定一个候选必须同时满足：`OggS` magic、版本 0、
   **serial 与本流一致**、lacing 表完整、granule 非 `-1`、且不超过 24 小时上限。
   后三条不是形式主义——`OggS` 只是 4 个字节，压缩数据里也会出现，从假的页头读出来的
   granule 就是**从噪声里读出的时长**。
2. **seek** = 在页 granule 上按字节二分/回退找页，然后 ⭐**让解码器自己报告落点**
   （`stb_vorbis_get_sample_offset`，只有在解到带 granule 的页之后才有效），再把差出来的那段
   **解码丢弃**。也就是说 seek **自校验**：不依赖"我算对了"这个假设。
   只选**非续接页**（flags bit0 未置位），因为从续接页开头解码会把包的中段当作新包，那一段
   解出来是噪声。

### 实测（全部来自真实引擎，不是单测断言）

```
# 真实 Vorbis 音乐（D 盘游戏 BGM，48 kHz 立体声 / 44.1 kHz 单声道）
MusicEx_Normal.ogg  frames=1540096  lossless=0  peak=0.634682  全解码 produced=claimed 精确
Chat_11706.ogg      frames=304289   单声道      peak=0.820040  全解码精确
empty_flac.oga      frames=163392   lossless=1  全解码精确

# seek：与「全新打开 + 顺序解码到同一点」逐样本对比
seek 0 / 1 / 500 / 3000 / 7500 / 15000 / 31000 ms  →  maxDiff=0.000000000  matched=1（七个点全过）
```

⚠️ **新发现的坑（已记，避免复犯）**：taglib 测试数据里的 `test.ogg` / `empty*.oga`
**解码出来是纯静音**（peak=0.0）。只用它们验证，一个返回全 0 的解码器会「通过」。
所以 `--probe-format` 必须同时报 `peak` / `nonZero`，Ogg 测试改用**磁盘上真实的 `.ogg` 音乐**，
并对照测试里**独立实现的页解析器**（不是对照引擎自己算的数）。

### 新增诊断：`--probe-format`

「这个构建放不了这个文件」是测试套件唯一无法追问的回答——`isDecodable()` 把一切原因压成
一个 bool 加一个只有调用者能看到的字符串。MP3、MP4，以及这次的 Ogg，都是靠猜那个字符串
debug 的。现在它被打印出来：`ok/rate/channels/bitDepth/frames/lossless/peak/nonZero`。
`--full` 解到结尾并与声称长度对比；`--seek <ms>` 拿**独立的重放**当基准比样本。

### 已知边界（不掩饰）

- **多路复用 Ogg（multiplexed）不支持**：taglib 的 `multiplex.ogg` 里有两个 logical stream，
  stb_vorbis 直接报 error 34。纯音频 `.ogg` 基本不会这样（那是视频 Ogv 的形态），
  但它是真实存在的 Ogg 能力，记在这里而不是假装没有。
- **Opus 不解码**：`.opus` 仍在扩展名白名单里（README 承认的过滤器 ≠ 能力），
  所以它会进 `unplayablePaths` 并在原因里**点名 Opus**，不再伪装成「not decodable as MP3」。
- **尾页 granule 完全可信的前提是该页属于本 serial**。链式 Ogg（一个文件里串接多段曲目）
  会只报到第一段链的长度。这种文件在音乐库里罕见，未处理。

## 0z3. 噪声防护：安全钳位挡不住 NaN（已实测修掉）

owner 要求「检查链路，防止噪声」，指向**播放时可听见的噪声/瑕疵**。这一节记的是
查证过程与结论，包括**被我自己的实测否掉的两个怀疑**——因为「以为有 bug」和
「真有 bug」之间的区别，正是这个项目反复付学费的地方。

### ⭐ 真实缺陷：`clampf` 不拦 NaN，而滤波器状态会把 NaN 永久锁住

`clampf` 原本是 `v < lo ? lo : (v > hi ? hi : v)`。**NaN 与任何数比较都是 false**，
所以两个分支都不走，NaN 被原样返回 —— 而它名义上是「永远生效的安全钳位」。

用**引擎真实头文件**编译验证（`Biquad` 的 DF2T 递推 + `clampf` 原样取出）：

```
n=2 in=NAN y=NAN clamp=NAN finite=0
n=3 in=num y=NAN clamp=NAN finite=0     <-- 输入已恢复正常
n=4 in=num y=NAN clamp=NAN finite=0
frames_after_injection_NON_FINITE_after_clamp=5
```

**一个 NaN 进入 biquad 后，z1/z2 被污染，之后每个样本都是 NaN，钳位完全清不掉。**
这对应的是**持续嘶声**而不是一次爆音；只有下次 seek/切歌（`resetSourcePosition`
→ `output_.resetDsp()`）才会恢复。在量化器那端，`std::lrintf(NaN)` 是**未定义行为**，
MSVC/x86 通常给出 `INT32_MIN` = 满幅负值。

**修复**（两处独立屏障，都在 dsp 侧）：
1. `clampf` 显式处理 NaN → 返回 `0.0f`（数字静音）。有限值路径**分支完全不变**，
   bit-perfect 不受影响；该函数现在从 `dsp.cpp` 的匿名命名空间提升为 `dsp.hpp`
   声明的接口，因为它是**契约**而不是实现细节，测试必须能对**同一份**算术断言。
2. `quantizeSample` 入口再挡一次 NaN（`!(sample == sample)`）。这是浮点变整数的
   **唯一**位置，双重防护是有意的。

### 被我实测否掉的两个怀疑（重要，避免"修复"不存在的问题）

| 怀疑 | 实测结果 |
|---|---|
| **CR-017 的 `probe` 预检会饿死音频线程**（每次入库都开一次解码器） | ❌ 否。24 首 95 MB FLAC 的 `replace+recursive+probe` 重扫耗时 7 ms、`xrun` 增量 **0**。原因是 FLAC/WAV 只读文件头即可判定可解码性，不需要全解码。 |
| **`quantizeSample` 的 `value <<= 8` 会在钳位边界溢出成负值** | ❌ 否。钳位发生在 `lrintf` **之前**且封顶在 `limit`，实测 `limit`、`2*limit`、`1e30` 全部落在 `2147483392`，`<<8` 不溢出。 |

另确认一条**入口很窄**的事实：FLAC/WAV 走 `dr*_read_pcm_frames_s32`（整数路径，
dr_libs 内部转换已钳位），MP4 走 Media Foundation；**只有 MP3 的
`interleavedFloatToPlanar` 是纯浮点透传**。所以 NaN 很难从正常文件进来 ——
但"很难"不是"不能"，而且一旦进来就是**持久**的，所以两道屏障都该在。

### 验证

- `--selftest` 新增 3 组断言（钳位清 NaN / 量化器映射 NaN 为静音 / biquad 确实会锁住
  NaN 因而钳位必须在上游清掉）。**RED 反证**：临时移除 NaN 分支 → `2 FAILURE(S)`；
  还原 → `all checks passed`。
- 静音播放回归 **73 项通过**；CR-017 扫描 **13/13**；HTTP reader **0 失败**；
  应用全套（158/11/42/19/58/70/34/27）与 L2 **21/21** 全绿。
- 端到端对比：含 NaN 突发的 WAV 与干净 WAV 的 meter 读数一致
  （peak -26.2286 vs -26.2291 dB），**无任何非有限测量值**。

### 边界

- 本轮修的是**「非有限值不该到达设备」**这一条，不声称解决所有听感问题。
  真机人耳听感仍未验证。
- 若将来某条解码路径引入非有限样本（例如网络流的中断残帧），这道屏障会把它
  变成静音而不是噪声；**但它不修根因** —— 根因属于那条路径。

## 0z2. CR-017 扫描递归 + 入库预检 + 坏歌跳过

owner 本轮要求：「扫描文件夹自动添加歌曲，并自动标记无法播放的歌曲、移除出列表」，
并明确指出了症状「在播放过程遇到无法识别和解码失败歌曲或者损坏的歌曲」。

### 先实测，再动手 —— 三条彼此独立的缺陷（真引擎，非推断）

| # | 缺陷 | 实测证据 |
|---|---|---|
| **1** | `scan` 非递归（`directory_iterator`），「歌手/专辑/曲目」层级会整层漏掉 | 顶层 3 个文件 + 子目录里的文件：默认扫描只看得到顶层 |
| **2** | ⭐ **入库了永远播不了的格式**：`kSupportedExtensions` 含 `.ogg`/`.opus`，解码器只有 FLAC/WAV/MP3/MP4 | `.ogg` 入库 `codec=Vorbis`、`.opus` 入库 `codec=Opus`；`open` 才 `ERR_DECODE`（"not decodable as MP3"） |
| **3** | ⭐ **坏歌卡死整个队列**：自动续播遇到打不开的条目只写一条 `log[warn]`，随后 `state=stopped`，**不跳到下一首** | `queue=[好,坏,好]`：好歌播完 → `log[warn] could not continue to the next queued track` → 停在坏歌上，后面的好歌永远不播 |

另外确认了一条**不是 bug 但会误导用户**的行为：损坏/截断的 FLAC 会播到坏处然后报
`ended reason=eof` —— 界面看起来像「正常放完了」。它**不是**解码错误，所以不会被
本次的标记逻辑捕获；这是已知边界，见下。

### 改动（全部在引擎侧，缺省行为不变）

1. `scan` 新增可选 `recursive`（缺省 false）：遍历子目录。身份仍走 CR-013 的归一路径。
2. `scan` 新增可选 `probe`（缺省 false）：入库前用**生产解码器**开一次文件；
   打不开的不入库，计入新字段 `unplayable`（计数）与 `unplayablePaths`（路径列表，最多 200 条）。
3. `scan_done` 增加 `unplayable`。
4. ⭐ `handleTrackFinished` 现在**跳过**打不开的条目并继续往后找：每跳过一个就发一条
   `ended {reason:"error", trackId, message}`（点名是哪一条，应用据此标记），
   再由 `advanceQueue` 前进。两道护栏防死循环：最多尝试 `queue.size()` 次，
   且索引没前进就停（单条队列 / `RepeatOne` 正是这种情况）。

**关键设计判断**：`isDecodable()` 是**打开文件再关掉**，而不是再写一份「支持的扩展名」
清单。第二份清单就是第二个会漂移的真相 —— 缺陷 2 的成因恰恰是「扩展名说能读、
解码器读不了」。判定权必须留在解码器手里。

**分层**：`catalog.hpp` 不 include 解码器头（那是它刻意保持的自由），所以
`isPlayable` 由**调用方注入**（`app.cpp` 传 `&isDecodable`），catalog 只记录结论。

### 验证

- ⭐ `engine/tools/test-scan-recovery.mjs`：**13/13**，连跑 3 次稳定。覆盖
  默认行为不变（非递归、不预检）、递归找到子目录、`probe` 把 `.ogg` 挡在库外并点名、
  `scan_done.unplayable`、以及**队列跳过坏歌抵达下一首好歌**。
- 静音播放回归 **73 项通过**（与上轮同数，无回归）。
- HTTP reader **0 失败**；自测通过。

### 边界（如实记下）

- **截断的文件不算错误**：它能解码到坏点之前，引擎报的是 `eof` 而不是 `error`，
  所以不会被标记。要捕获它需要逐帧完整性校验（等于每次播放都完整解码一遍），
  代价与收益不成比例，本轮不做。
- 预检会为 `.mp4/.m4a` 启动 Media Foundation（进程级、不可逆）。`cmdShutdown` 已有
  `shutdownMediaFoundation()`，且预检对象在判定后立即析构，所以没有新增生命周期风险。

## 0y. CR-016 `open {url}` 引擎入口 + L2 端到端已跑通

`cmdOpen` 现在接受互斥的 `url` 与 `trackId`：两者同时给出返回 `ERR_STATE`，
都不给仍是 `ERR_NOTFOUND`。URL 只作为**路径**交给 `MediaReader` 的 WinHTTP 后端，
音频样本不穿越 stdio；Range / 鉴权 / 重签仍由回环代理负责，网络失败继续按
`read_proc` 契约报告错误而不是当 EOF。

本轮最关键的一处判断：**"载入了源"与"知道它的 trackId"是两件事**。
CR-016 约束 3 规定 URL 打开时 `trackId` 留空，而 `play()` / `seek()` /
`reopenForDeviceChange()` 原本都用 `currentTrackId_.empty()` 表示"什么都没打开"
—— 照原样保留就会让 URL 源**无法播放也无法 seek**，正好抵消这个入口存在的意义。
现在由 `Player::sourceLoaded_` 单独表达载入状态，并由 `hasSource()` 暴露；
身份与载入状态各自成词，不再互相冒充。

数据链路的复用方式：`openTrack` 与 `openUrl` 收敛到同一个私有
`openSourcePath(path, trackId, error)`。本地文件与 HTTP 流的差别**只在字节从哪里来**，
所以格式协商、重采样器配置、ring 尺寸、operationId 自增必须完全一致 ——
两条并行的实现就是两份会漂移的真相。

### 验证

- 引擎构建通过（仅既有 MSB8062 等警告）；自测通过。
- 静音播放回归 **73 项通过，3 种源采样率**（与上一轮同数，无回归）。
- HTTP reader 离线回归 **0 失败**（22 场景）。
- ⭐ **L2 端到端 21/21 通过**（`app/tools/test-l2-integration.mjs`）：
  本地 HTTP 源扮演 CDN → `mediaProxy.register()` → `open {url}` → 真引擎。
  覆盖字节等价、HTTP 上的 seek、416 形状、**If-Range 版本钉住**、过期签名 refresh 自愈、
  以及"传输失败不是 EOF"（撤销 token 后打开返回 `ERR_DECODE`）。
- 应用侧同轮：lint 0 违规、构建通过、单测 **143/143**、协议 **42/42**、
  真引擎集成 **19/19**、窗口 58/70/34/27。

### 过程中查实并修掉的两个真实缺陷（都在应用侧，已在本轮闭环）

1. ⭐ **回环代理丢弃 `If-Range`**。引擎会把捕获到的 ETag 作为 `If-Range` 发出去，
   但代理**只把上游 validator 往下转发给引擎、没有把引擎的 `If-Range` 往上转发**，
   于是版本钉住这条保护"引擎发了、CDN 从没收到"，静默失效。
   证据：直连代理发 `If-Range` 时上游 `if-range=null`；修复后上游收到 `"stable-v1"`。
   同时把 resume 的判定从"2xx"收紧为**必须 206** —— 上游因版本不匹配回过 `200` 时，
   把整段 body 接到半截流的中间会**静默损坏音频**。
2. ⭐ **`EngineHost` 从不监听 `child.stdin` 的 `error`**（详见 §0z）。

### 边界

- 一次播放固定一个资源版本仍成立：`refresh()` 换签名不得换内容，
  "换一首"必须换 token（应用侧 `online-playback.ts` 用一次播放一个 token 表达）。
- 真机听感仍未验证；本轮证明的是数据链路与契约行为。

## 0z. 踩坑：`write EPIPE` 弹窗（Electron 主进程未捕获异常）

**症状**：反复弹出 *"A JavaScript error occurred in the main process /
Uncaught Exception: Error: write EPIPE"*，栈顶为
`Socket._write → WriteWrap.onWriteComplete → afterWriteDispatched`。

**成因**：引擎消失时，主进程**已经排进 socket 缓冲区的写入**会在之后才完成，
并对死管道异步报错。这条错误有两个反直觉之处：

1. 它**不是**写入那一刻抛的，所以 `EngineHost.request()` 里 `this.exited` 那道闸
   拦不住它 —— 写入发出时引擎看起来还活着；
2. `child.stdin` 上没有任何 `'error'` 监听时，Node 对无人处理的 `'error'`
   **直接抛出**，Electron 主进程随即弹窗。于是"引擎没了"表现为**弹窗**而不是重连。

**为什么看起来是间歇性的**：只有"缓冲里还有没写完的数据"才会炸。
64 字节的命令行数太少会直接写进管道而不报错；512 KiB 的载荷稳定复现。
所以它**不是每条命令都炸**，而是取决于写入时管道是否已经断了。

**修复位置**：`app/src/main/engine-host.ts` —— 在唯一所有者上补
`child.stdin.on('error', ...)`，并让它与进程 `exit` 共用**同一个失败出口**
`failEngine()`：先到者上报一次断连并让后续 `request()` 立刻拒绝（去重，避免
renderer 反复闪断连）。重启策略仍只属于 `exit`，因为只有它证明进程真的结束了。

**验证**：`app/tools/engine-host.test.mjs`（新，2 项）。移除监听即复现
`Error: write EOF`，与用户栈同一帧；加回即绿。另在**真实 Electron 主进程**里
做了对照：无监听 → 未捕获异常（即弹窗）；有监听 → 0 未捕获。

最后更新：2026-10-16 · 对应可执行文件 `engine/bin/twilight-engine.exe`

---

## 0x. CR-015 监测可见性扩展

owner 已明确允许补充可见性命令，裁定追加到 `docs/contract-requests.md`。
新增 `set_meter {enabled:boolean}`，缺失或类型非法返回 `ERR_STATE`；默认不推送、同值幂等。
控制线程继续维护只读 tap 与分析历史，仅在播放且启用时组装/推送 meter，节流上限 30 Hz。
Electron 主进程按窗口显示/隐藏/最小化/恢复同步；引擎 ready 后重发最新状态，旧进程迟到错误不影响新进程。

验证：引擎自测通过；三种源采样率的静音播放回归 **73 项通过**，覆盖默认关闭、参数校验、关闭确认后零帧、恢复推送及播放质量状态不变。
应用类型检查、token 检查、生产构建通过；应用单测 **132/132**、真实播放窗口 **70/70**（含隐藏/最小化停帧与恢复）、Electron 集成 **56/56**。

## 0w. Range reader 与播放管线加固

本轮将原来嵌在 `audio_source.cpp` 的 WinHTTP/本地文件读取器拆到独立的
`media_reader` 深模块。Range 响应现在严格要求 `206 Content-Range`，检查精确区间、总长度、编码、短/长响应与可用的 ETag/Last-Modified；
窗口固定为 256 KiB，I/O 错误保持 sticky，超时为 3 秒。`openAudioSource` 复用嗅头时的同一个 reader，不再重复打开/下载首个窗口。

播放器侧修复了帧计数的并发读写，按 ring 空余空间限制 feeder pull，避免环形缓冲短写丢失已解码样本；输入故障优先于恢复和 EOF 处理。

离线回归覆盖 22 个场景：Range 格式与范围错误、缺失/变化长度、短/长 body、编码、ETag 变化、503、超时、缓存复用、等长内容混合探测，以及真实 FLAC 和合成 WAV/MP3 的字节与解码对照。另有静音设备生命周期测试，三种输入采样率下检查播放、暂停、seek 和 EOF。

边界：没有 validator 的源若在播放中被等长替换，生产端无法仅从 HTTP 长度证明它是同一版本；回环代理应固定一次播放的资源版本。公共 `open` 仍只接受 `trackId`；CR-016 已裁定接受，URL 入口待实施。CR-015 的 meter 基线与可见性命令已实现。真峰值限制器、完整耳机交叉馈音、gapless 和更多 codec 仍排在后续，见 [AUDIO-QUALITY-ROADMAP.md](AUDIO-QUALITY-ROADMAP.md)；本轮没有声称完成人耳听感验证。

最后更新：2026-10-16 · 对应可执行文件 `engine/bin/twilight-engine.exe`

---

## 0v. 回环 HTTP reader：G1 观测与 Range 后端已完成

### 已完成

- 新增 `--probe-io <file-or-http-url>`：直接记录生产 `dr_flac` 的 `read/seek/tell`。
  在真实 FLAC 上实测最大请求为 **4096 字节**，主要请求为 4096，尾部有 3 次合法短读；
  这为 256 KiB 预读窗口提供了证据，而不是沿用猜测。
- `FileReader` 现在按输入选择本地 `FILE*` 或 WinHTTP Range 后端。URL 读取有逻辑 seek、
  单窗口缓存、资源长度校验和 Range 不被支持时的明确错误。
- 生产 FLAC/WAV/MP3 解码器回调未改；reader 对象改为稳定的 move-only 所有权，避免
  WinHTTP 句柄复制/双重关闭。
- 新增 `--probe-decode <file-or-http-url>` 文件/URL 单目标模式。真实 FLAC 的本地文件与
  本地 Range HTTP 两条路径均通过 **5 次 seek、5,722,416 帧、逐样本对照**。
- 网络断开探针返回非零并保留 WinHTTP 错误；feeder 不把失败当作 EOF，也不把部分块写入环形缓冲。

### 尚未完成

- `open` 仍按冻结契约只接受 `trackId`。URL 入口已追加 CR-016，待 owner 裁定后再改应用命令。
- 回环代理本身属于应用侧；本轮没有实现代理、鉴权、续签或 MP4 URL 流式路径。

---

## 0u. 真机听感报告：「糊、声场不清晰、分离度不足」——查到哪一步了

owner 在真机上报告听感发糊。这一节记录**已经用测量排除掉的**和**仍然未知的**，
不下没有证据的结论。

### 先认错：那 30 分钟是我的压测在占着设备

owner 听到的是我挂在后台的 **SPEC §9 压测**（`tools/soak.mjs --minutes=30`），
它以**独占模式**占着 DAC 连播了 91 首。**这是我的疏忽** —— 长压测会占着用户的设备出声，
开工前应当先问。已停（引擎进程 0）。

### 用测量排除掉的三件事

| 方向 | 结论 | 证据 |
|---|---|---|
| **解码是否失真** | **逐位相同** | 新增 `--probe-decode`：**91 文件 / 934,929,691 帧 / 452 次寻址探针 / 0 分歧** |
| **音源是否假无损** | **是真无损** | 新增 `--probe-spectrum`：44.1k 文件能量顶到 22050 Hz（Nyquist），96k 文件到 24–34 kHz；有损转码会在 16–20 kHz 断掉 |
| **DSP 链是否被动过** | **默认全程恒等** | `balance=0 / mono=false / stereoWidth=1.0 / swap=false / trim={0,0} / EQ off / RG off / preamp=0` |

### 限幅器那条假设：查了，排除了

`limiterEnabled` 默认 **true**，而 `dspModules` **不列它**、`dspActive` 因此为 false ——
看上去正是「注释写了规则、代码没实现」的 CR-010 翻版。**但它不是**：

```cpp
if (wetMix_ > 0.0f && limiterOn) { ... }        // dsp.cpp:388  限幅器的门
const float targetMix = (current_.eqEnabled || needChannels) ? 1.0f : 0.0f;   // dsp.cpp:231
```

**EQ 关、声道工具恒等时 `wetMix_` 就是 0**，限幅器根本不进循环；而一旦 EQ 开着，
`isPassthroughConfig()` 早就返回 false 了。所以 `outputPerfect=true` 没有撒谎。
（注释里那句「at unity gain it changes nothing」措辞不准——它其实是被 wetMix 门住的——
但结论对。**如实记下这处措辞问题**。）

`process()` 在 `wetMix_==0` 时写出的就是 `clampf(dry)`，即输入样本本身（±1.0 内恒等）。

### 两条路径的差别，现在是数字

新增 `tools/ab-switch.mjs`（同一音乐窗口原地切换：按 1 独占 / 按 2 共享）。实测：

| | 独占 | 共享 |
|---|---|---|
| `resampled` | **false** | **true** |
| `outputPerfect` | **true** | **false** |
| `sourceExact` | **true** | **false** |
| 容器 | **源位深** | 32-bit float |

- 44.1 kHz 曲目：独占 44100/24 直通；共享 44.1 → 48 kHz 重采样 + 系统混音器；
- **96 kHz 曲目（`TestBand - テスト曲`）：独占 96000/24 直通；共享是 96 → 48 kHz 的 2:1 抽取**——
  这是这台机器上两条路径差别最大的一首，也是最好的试听材料。

### 踩过的坑（都是「读数读错了」，不是引擎错）

1. **`set_output` 的回复说的是调用那一刻的输出状态**，不是之后开流的状态。
   我用它报 `rate=`，于是**同一首在两轮里报了 48000 和 44100**，看起来像引擎 bug。
   实际是：第一轮调用时引擎还停在启动时的 48000。读数必须从**开流之后**的 `get_state` 取。
2. **对照实验的设计本身就是变量**：第一版 `tools/ab.mjs` 两段之间隔几十秒、顺序还交替，
   owner 的反馈是「听得出来但分不清哪个更好」——那正是这种设计的必然结果。
   人耳对这类判断的记忆只有几秒，所以第二版把窗口锚定、由听者自己按键。

### ⚠️ 我在这一轮里报错了一次，记下来（它是可复现的错误形状）

我看 `app.cpp` 的 `set_output` 分支，看到：

```cpp
if (mode == "exclusive")      player_.setOutputMode(OutputMode::Exclusive);
else if (mode == "shared")    player_.setOutputMode(OutputMode::Shared);
```

而 CONTRACT 第 104 行把 `mode` 定义为 `exclusive | shared | auto`，校验也接受 `"auto"`。
**于是我断言：「`auto` 掉下去什么都不做」**，并写了一段「实现它」的补丁。

**我错了。** 源码是权威：

```
output_wasapi.hpp:46   Auto,        // try exclusive, fall back to shared
output_wasapi.hpp:129  mode is what to TRY: Exclusive and Auto fall back
app.cpp:1126           else player_.setOutputMode(OutputMode::Auto);   ← 本来就在
```

**`auto` 一直有实现，语义正是「先试独占、不行再降级」。** 实测（开流后读 `get_state`）：

```
mode=auto       -> outputMode=exclusive  resampled=false  outputPerfect=true   container=24bit
mode=shared     -> outputMode=shared     resampled=true   outputPerfect=false  container=32bit
mode=exclusive  -> outputMode=exclusive  resampled=false  outputPerfect=true   container=24bit
```

**错在哪**：我先前的检索写的是 `OutputMode::Shared|OutputMode::Exclusive` ——
**它匹配不到 `Auto`**。而我把「检索没找到」读成了「不存在」。
我在写下结论之后、动手之前又读了一遍编辑处的上下文，才看见第 1126 行那个 `else`。

> **一条只能匹配到你已经想到的东西的检索，会确认你已经相信的事。**
> 这与 §0t 那条教训是同一个形状的另一面：那边是「不打印关键中间量会追错根因」，
> 这边是**「只按已知模式检索会把沉默当成不存在」**。

已撤销，并重新编译验证（`bin/` 里的 exe 一度装着我那版错的，这一点也一并处理了）。

### 喂给 DAC 的采样率：也排除了

最后一个**能由软件改变**的变量：我们按源采样率喂 DAC（44.1 kHz 就是 44.1），
而别的播放器走共享、喂 48 kHz。有些 USB DAC 对 44.1 kHz 的内部处理就是更差。

为了公平，同一条音乐必须两个喂法都在：新增 `--probe-resample`，
**用引擎自己的 SoXR（HQ，与共享路径同一个调用）**把 44100 转成 96000，
位深跟随源（16-bit 源就出 16-bit，**否则对照里同时变了率又变了容器**）。
然后用 `tools/rate-ab.mjs` 在**独占**下交替播两份：

```
NATIVE     44100 Hz 原生      resampled=false  outputPerfect=true  exclusive
RESAMPLED  96000 Hz 副本      resampled=false  outputPerfect=true  exclusive
```

两份都是 `resampled=false`——因为 96k 那份**文件里本来就是 96k 样本**，
播放时引擎一个样本都不重采样。**唯一的差别就是 DAC 收到 44.1 还是 96。**

owner 判定（天球，16 秒/段，3 轮）：**两份都差不多。**

### 合并结论

| 变量 | 结论 |
|---|---|
| 解码 | **逐位正确**（9.34 亿帧） |
| 音源 | **真无损**（91 首频谱顶到 Nyquist） |
| DSP 链（立体声 + 出厂默认） | **逐样本恒等**（新断言，通过） |
| WASAPI 格式 | 声道掩码/PCM/validBits/blockAlign **全对** |
| 独占 vs 共享 | **独占更好**（owner 判定） |
| 数字电平 100/50/25% | 无明确胜负 |
| 喂给 DAC 的采样率 44.1 vs 96 | **无差别** |

**所以：引擎的输出缓冲之后，没有任何一个软件变量能解释 owner 听到的「声场和分离度被压」。**

### 一个逻辑上站得住的推论

owner 说「**别的播放器明显更好**」。
而我们这条路径已经被证实是**逐样本忠实**的（文件里的整数到达了设备）。

> **如果 B 比一个忠实的路径「更好」，那 B 就不是忠实的——B 加了东西。**

这不是说 B 有问题，也不是说 owner 的听感有错。
**它说的是：owner 想要的可能是「被染色过的声音」，而忠实路径按定义给不了那个。**

**而这件事恰好有一个正当的出口，而且 owner 已经批准过它** ——
`docs/DSP-A-engine.md` 的音效链（中侧宽度 + crossfeed），它的定位就是
「与 bit-perfect 严格互斥、由用户主动开启」。「声场和分离度」正是**中侧宽度**控制的量。

**这是我这一轮唯一的建议**：不要为了让引擎「听起来更好」而破坏忠实路径
（那正是这个项目存在的理由），而是**把染色做成一个用户可控的、明示的层**。

### 仍然未知

- **owner 尚未给出「两条路径哪条糊」的判断** —— 这是决定往哪优化的唯一输入；
- 若**两条都糊**：引擎的输出路径就可以排除（独占下它交给 DAC 的就是文件样本），
  要转向 DAC / Windows 端点 / 耳机；
- 若**只有共享糊**：那就是重采样 + 系统混音器的代价，优化方向是让高保真路径成为默认；
- **尚未做**：WASAPI 回环采集（`AUDCLNT_STREAMFLAGS_LOOPBACK`）——它能给出
  「系统混音器到底对信号做了什么」的客观数字（串扰、着色），不依赖耳朵。
  这一条是下一步最该做的测量。

---
## 0t. 根因坐实：**一个超报的帧数毒死了两套机制** —— SPEC §9 复现已通过

第三次压测**又**停在同一首、同一毫秒（295597）。这不再是竞态，是确定性的，
于是我用两次记录把答案逼了出来。

### 第一步：把结束判定的**每一项**都打出来

在 `stall` 记录旁边加一条 `stall-eos`，打印 `feederDone && ringDry && deviceDrained && everRan` 的**全部输入**：

```
stall-eos delivered=13035844 trackTotal=13058884 fed=13035844 devicePlayed=13138920 rendered=0
         | feederDone=0 ringDry=1 deviceDrained=1 everRan=1 srcFrames=23040
```

**唯一为假的是 `feederDone`**，因为 `delivered` 比 `trackTotal` **少 23,040 帧**。
`23040 / 44100 = 0.5224 s` ── 正好是冻结位置 295597 与声明时长 296120 之差。

> **`dr_flac` 报的 `totalPCMFrameCount` 比它真正交出的帧数大了 23,040。**
> 这个文件的 STREAMINFO 声明的样本数比流里实际有的多 0.52 秒。

### 第二步：把 xrun **现场**也打出来

```
xrun count=3 ringBuffered=0 inputExhausted=1 delivered=13035844 trackTotal=13058884
```

喂料端**知道**输入已经结束、环是空的 ── 而渲染线程**仍然**把这 3 个饿死的块记成了 xrun。
去看它为什么抑制不了：

```cpp
const bool draining = feederDone_.load(...);
if (!quiet && got < available && !priming && !draining) { ++xrun ... }
```

`draining` 确实会抑制 ── **但 `feederDone_` 全工程只有一个地方设置**：

```cpp
if (trackTotalFrames_ > 0 && consumed >= trackTotalFrames_) output_.setFeederDone(true);
```

**就是那个这个文件永远满足不了的比较。**

### 所以一个坏掉的头部，同时废掉了两套安全机制

| 机制 | 由什么驱动 | 结果 |
|---|---|---|
| 结束判定（控制线程） | `deliveredFrames_ >= trackTotalFrames_` | 永远不成立 → **曲子结束了没人宣告** → 环排空 → 缓冲重开 → 位置冻结、`state` 说 playing |
| `draining`（渲染线程） | 同一个比较设置的 `feederDone_` | 永远不成立 → **正常的曲尾被记成 xrun** → 触发一次毫无必要的缓冲升高 |

两件事是**同一个根因的两个症状**，而我前两轮分别在追它们各自的表象。

### 修法：让**解码器**成为「还有没有」的权威

「文件头说还应该有」和「确实还有」是两件事。哪一个为真，**只有喂料端能观察到**：

```cpp
// feeder，pull() 返回 0 时：
inputExhausted_.store(true, release);   // 控制线程的结束判定
output_.setFeederDone(true);            // 渲染线程的 draining
// 又有帧可拉时（seek / gapless 拼接）：两者一起清掉
```

`fedFrames_` 与 `inputExhausted_` 的关系也顺手理顺了：
计数比较**保留**（它覆盖「喂料端刚好在两次读取之间」的瞬间），但**不再是唯一依据**。

### 验证

**确定性复现（单曲队列，5 分钟）**：

| | 修前 | 修后 |
|---|---|---|
| `advances`（曲子推进） | 0（永远停在那首） | **1**（正常结束并续播） |
| xrun | **3** | **0** |
| 缓冲 | 6 → 10 ms（被误判推高） | **6 ms 全程不变** |
| anomalies | 反复降级 + `state became stopped` | **none** |
| 结果 | SOAK FAILED | **SOAK PASSED** |

**全套 462 断言 / 22 步 / 0 失败**（结束判定是每条播放路径的必经之处）。

### 这一轮的方法论，值得单独记下来

三次失败的压测，两次靠**把症状现场的全部输入打进日志**定位：

1. 第一次只打印「我停住了」+ 几个计数器 → 只能确认「没东西可放」，但**说不清哪一项为假**；
2. 把 `stall-eos` 的全部输入打出来后，**一次复现就指出 `feederDone=0`**；
3. 把 xrun 现场打出来后，**再一次复现就指出 `draining` 的驱动器就是同一个比较**。

> 这与 §0n 那条教训是同一件事的两面：
> 那边是**「不打印关键中间量，会把『我喂错了』显示成『硬件坏了』」**；
> 这边是**「不打印关键中间量，会把一个根因的两个症状追成两个 bug」**。

### 还剩什么

- **§0s 里那个"`played > 0` 守卫"的修复保留**（它确实是个真缺陷，只是**不是**这次的根因）；
- **§0r 那条 `serviceRenderLiveness()` 保留** ── 它这次**没有触发**（`anomalies: none` 里没有它），
  因为结束判定修好之后这条路径在一个 tick 内就被正常流程处理掉了。它是给**别种**流失效用的安全网；
- **第四次压测（完整 30 分钟、全库）正在跑**。单曲 5 分钟复现已 `SOAK PASSED`，
  但 SPEC §9 的判据是 **30 分钟**，在它跑完之前我不改结论；
- 顺带一个**如实记下的数据事实**：本库有一首 FLAC 的声明长度比实际音频长 523 ms。
  引擎现在不会因为它卡住，但**报告的 `durationMs` 仍是文件声明的那个数**
  （位置会在 295597 结束而时长显示 296120）── 这是文件的性质，不是引擎的。

---
## 0s. 停顿的根因找到了：一行守卫 + 一个被重开清零的计数器

第二次 30 分钟压测**又失败了**，但这次新加的 `stall` 诊断**第一次就把答案写下来了**：

```
22:55:38.504 xrun count=3  → buffer increased to 10 ms
22:55:40.882 stall no frames for 2005 ms at position 295597;
             rendered=0  wakes=202  devicePlayed=67443515  ringBuffered=0  mode=exclusive
22:55:42.889 stall rendered=0  wakes=277  ringBuffered=0
22:55:44.900 stall rendered=0  wakes=276  ringBuffered=0
22:55:44.916 stall gave up after 3 attempts
```

**四个数字一起把话说清楚了**：设备在响（`wakes` 202→277 持续增长）、渲染线程活着、
但 `rendered=0` 且**环是空的**。不是「流死了」，是**没东西可放**。

时间也对得上：那首曲子 22:50:42 开流，冻结位置 **295597 ms ≈ 4:56**，
`22:50:42 + 4:56 = 22:55:38` —— **正好是 xrun 那一刻**。曲子到结尾了。

### 根因：结束判定的守卫用的是**会被重开清零的那个计数器**

```cpp
if (feederDone && ringDry && deviceDrained && played > 0) {
    endOfStreamReached_ = true;
}
```

`played` 就是 `framesRendered_`。而**自适应缓冲重开必须把它清零** ——
设备时钟随新流重来，位置基准要重新建立（同一段代码里就有 `framesRendered_.store(0)`）。

于是：**「重开之后曲子正好走到结尾」这种情形，永远无法满足 `played > 0`。**
喂料端已经送完、环已经空了、设备也已经放完了，而结束判定被这一行挡住，**永不触发**。
引擎就停在那里，`state` 说 `playing`，位置冻在重开时存下的那个数上 ——
和第一次压测观察到的一模一样，只是这次有了四个数字做证据。

### 修法：用「有没有喂过」代替「有没有渲过」

```cpp
const bool everRan = (played > 0) || (fedFrames_ > 0);
```

守卫**想表达的**是「还没开始 vs 已经结束」，而区分这两者的其实是**有没有喂过料**：
`fedFrames_` 由 `open()` 和 `seek()` 重置，**但重开不动它** ——
所以在那个被清零的计数器失效之后，它仍然意味着守卫本来想说的意思。

### 为什么这个 bug 之前没被抓到

它需要**两个事件在同一首曲子的结尾附近同时发生**：
一次 xrun 风暴（≥3 次 → 触发缓冲重开 → 清零计数器）**撞上**这首曲子的自然结束。
两次压测都是这样中的（第一次在 25 分钟、第二次在 7 分钟左右），
而 5 分钟的短测、以及那两次 CPU 压力实验（**一次 xrun 都没造出来**）都碰不到。

> 这条正好是 SPEC §9 存在的理由：**有些缺陷只有在够长、够真实的运行里才出现**，
> 而它们一旦出现，就是用户听到静音、界面说在播的那种。

### 与 §0r 那条看门狗的关系

两者是**互补**的，不是重复：

- `serviceRenderLiveness()` 管的是「**流失效**」——不知道什么原因，渲染停了；它会重开一次，
  不行就如实停止；
- 这一条管的是「**曲子结束了但没人宣告**」——重开治不了它（没有更多音频可放），
  只能靠结束判定正常工作。

修好之后，这条路径会在**一个 tick（约 5 ms）内**由正常结束流程处理掉，
根本走不到 2 秒的看门狗。

### ⚠️ 本节的结论**不完整**，以 §0t 为准

`played > 0` 那个守卫**确实是一个真缺陷**，修它也确实是必要的 ——
但第三次压测证明它**不是这次停顿的根因**（同一首、同一毫秒又停了一次）。

真正的根因是**同一个比较**同时驱动了两套机制，而 `played > 0` 只是其中一环：
见 **§0t**。本节保留，因为它忠实记录了「我当时是怎么想的、为什么那样改」，
那也是这件事的一部分。

**修完 §0t 之后**：确定性复现（单曲 5 分钟）`SOAK PASSED`，xrun 从 3 变成 **0**，
整套 462 断言零回归；完整 30 分钟压测正在跑，结果出来之前不改结论。

---
## 0r. 30 分钟压测**失败**了 —— 它抓到的东西正是它存在的理由

第一次完整的 30 分钟独占压测（SPEC §9）跑完了，结果是**失败**。这一节按证据记录，**不含推测**。

### 发生了什么

```
25:01  pos=04:29  played=24:09  xrun=0  bufferMs=6
26:01  pos=04:56  played=24:36  xrun=3  bufferMs=10   ← 3 次 xrun，缓冲自适应升到 10 ms
27:01  pos=04:56  played=24:36  xrun=3  bufferMs=10   ← 位置冻住
28:01  pos=04:56  ...
30:01  pos=04:56  ...
```

1. 第 25 分钟出现 **3 次 xrun** → SPEC §3.2 的机制**正确工作**：缓冲 6 ms → 10 ms；
2. **紧接着播放永久停住**：位置冻在 04:56 直到结束（4.5 分钟）；
3. 期间 **`state` 一直是 `playing`**、引擎每次 `get_state` 都在 **2 ms** 内应答、
   **没有任何错误、没有任何降级原因**（除了那条缓冲升高的说明）。

> 用户听到的是静音，界面显示「正在播放」。
> 这正是 §0c 里那条纪律的反面：**引擎在撒谎，而且是它自己不知道自己在撒谎。**

### 抓出的真缺陷：看门狗是**一次性**的

```cpp
bool Player::checkExclusiveWatchdog(...) {
    if (output_.status().renderWakes.load() > 0) {
        exclusiveWatchdogArmed_ = false;   // 设备响过了，独占没问题
        return false;
    }
    ...
}
```

它只覆盖「**从没响过**」，**解除警戒之后再不看第二眼**。
于是「响了 25 分钟然后默默死掉」在引擎内部**完全不可见** —— 这正是它当初要消灭的那团模糊，
只是漏了另一半。

**新增 `serviceRenderLiveness()`**：`state == playing` 时若 `framesRendered_` **2 秒没有推进**，
就当作流失效 —— 写一条 `stall` 诊断记录（**带上三段管道计数**，让下一次不需要猜：
`rendered` / `wakes` / `devicePlayed` / `ringBuffered` / `mode`）、发一条 `log` 警告事件、
**按源帧保住位置重开一次**；连续两次仍不行就**如实停止**并写明原因 ——
**停止的播放器是诚实的，「正在播放」的静音播放器不是。**

2 秒这个阈值是有依据的：缓冲区重开停渲染线程约 50 ms、seek 几毫秒、喂料预热根本不停它（写静音），
所以 2 秒比一切正常停顿高两个数量级，同时用户丢声后两秒内就会被告知。

### ⚠️ 这条看门狗的**正例未被验证**

按 §1.2 的三维口径：build=**available**，runtime **unverified**。试过两条路，都没能造出停顿：

| 尝试 | 结果 |
|---|---|
| 让第二个引擎以独占抢同一端点 | **被拒绝**（`0x8889000A` AUDCLNT_E_DEVICE_IN_USE），持有一方**完全不受影响**（位置 5197→12270 平滑、零降级） |
| 4 个 CPU 忙循环 + 4 分钟独占播放 | **一次 xrun 都没有**，更没触发缓冲升高 |

第二条同时**推翻了我原本的头号假设**（「别的进程抢走了端点」）：争用是**被拒绝**的，不是被偷走的。
**所以停顿的成因当时未确定** —— 但**第二次压测把它定下来了**，见 §0s：
根因是结束判定的一行守卫（`played > 0`）用了会被自适应缓冲重开清零的计数器。
本节保留原样，因为「我当时是怎么想的、怎么排除的」本身是记录的一部分；
**结论以 §0s 为准。**

### 一处我解释不了的矛盾（如实记录）

同一份诊断日志里，**我的压测引擎从 21:48:08 起一直持有该端点独占**，
而 **22:00:53 / 22:04:00 / 22:08:39 有三条来自别的进程的 `output opened mode=exclusive`**，同一个设备 GUID。

按上面那个争用实验，这三条**本应失败**。它们没有。我不知道为什么 ——
可能是驱动在某些情况下允许多个独占客户端，也可能我的争用实验与那三次的请求形状不同。
**没有证据，所以不下结论。** 日志和实验都在，下次可以接着查。

### 结论

- **SPEC §9 的「30 分钟 0 xrun」当时是失败的**（3 次 xrun）→ 第二次复现并由 §0s 定位根因；
  修好后正在跑第三次压测，**结果未出之前仍然算未通过**；
- 附带抓出一个**独立的真缺陷**（流失效不可见）并已修，但**修法的正例未验证**；
- 下一次压测应当**在没有其他引擎实例的安静机器上**跑 ——
  诊断日志已经证明那一次不是隔离环境（期间有 5 个别的引擎实例启动）。
  这条与 B 侧记录里「对方跑 30 分钟独占压测时本机不要跑重活」是同一件事。

---
## 0q. Gapless 还没做，而且先卡在「素材」上：这个曲库没有专辑元数据

owner 裁定「先做 Gapless」。动手前我先确认能不能**验证**它 —— 于是量了一下库里的专辑信息：

```
91 首曲目
有 album 标签的：      1 首
不同的 专辑||专辑艺术家 组合： 2 个
同专辑 + 连续 trackNo 的相邻对： 0 对      ← SPEC §3.7 的触发条件
```

**SPEC §3.7 的 Gapless 触发条件是「同专辑（album + album_artist + 连续 track_no）」。**
这个曲库**从不满足它**。所以在现有素材上，Gapless 的行为是「永不被触发」——
我可以把代码写出来、让它编译通过、跑一套永远走不到那条分支的测试，然后说「Gapless 做完了」。

> 那正是 §0l 里 MP3 缺口的同一个形状：**测试素材决定验过什么。**
> 407 条断言全绿而 MP3 一行都放不出来，就是因为库里 91 首全是 FLAC。

### 所以下一步不是写拼接，而是先造出能触发它的素材

需要的是一对**带标签的、无损的、连续的**文件。可以做到，而且不需要新依赖：

- **手写一个 WAV + RIFF `INFO` 块**（`INAM`/`IART`/`IPRD`/`ITRK`）——
  TagLib 的 WAV 读取器认 RIFF INFO，而 `readMetadata()` 走的就是 TagLib；
- 两个文件给**同一张假专辑**、`trackNo` 1 与 2，内容是**相位连续的同一段正弦**；
- 于是「是否无缝」就有了可判定的观测：

| 非 Gapless（今天的路径） | Gapless（目标） |
|---|---|
| 曲子边界处 `output_.stop()` + 重新开流 | **不 stop、不重开流** |
| `state` 事件出现 `stopped` | `state` 全程 `playing` |
| 诊断日志多一条 `output opened` | **没有新的 opened 记录** |
| `renderedFrames` 在边界处断档 | 单调增长穿过边界 |

最后一条尤其有用：**它把「无缝」变成了一个可断言的数字**，而不是「听起来没有咔哒」。
（真机听感仍然要人耳，我不会声称测过那个。）

### 已经落地的那一半：它的前置条件

§0p 的整文件读入改文件句柄**不是顺手的优化，是 Gapless 的前置条件** ——
整文件读入下「预解码下一首」意味着两个文件同时在堆上（常规 ~70 MB、最坏 183 MB），
而 SPEC §8.2 只有 60 MB。**旧设计里 Gapless 与预算互斥。**
那一半已经落地并验证：RSS 从 75 MB 降到 **16–19 MB 且与文件大小无关**，且 462 条断言零回归。

### 拼接本身的设计（已定，未实现）

记在这里免得下次重新推一遍：

1. **预解码在控制线程做**（开文件 + 配置它自己的 SoXR 到设备率），产物放在
   `gaplessSource_`/`gaplessResampler_`，只在**拼接那一刻**才交给 feeder 持有；
2. **拼接在 feeder 里做**：`pull()` 返回 0 且候选就绪时，在同一轮循环里换掉 source/resampler，
   环**不排空**，所以听不到缝。这是唯一能保持连续的地方 —— 控制线程一做 `stop()` 就是缝；
3. ⚠️ **不能立刻改位置时钟**：拼接那一刻环里还有约 1 秒旧曲音频。
   所以 feeder 记下「拼接发生在第几帧」，控制线程等到 `devicePlayedFrames()` 越过那条边界
   才宣告旧曲结束、换上新的 `trackId` 并把位置归零。否则 UI 会**提前约 1 秒**跳曲；
4. **`ended.reason` 用既有的 `eof`**（CONTRACT §3.3 只有 eof | stop | error，旧曲确实到了流末），
   **不需要改契约**；`operationId` 照 CR-007 递增（拼接也是一次新会话）；
5. 队列索引按 `advanceQueue` 的规则推进；**App 不会重复推进**，因为拼接路径不通过
   `tick()` 的返回值报告结束，而是自己发 `ended` + `state`。

### 如实记录

- **Gapless 未实现**，一行代码都没写；
- 已经完成的是它的**前置条件**（§0p，已验证）与**验证方案**（本节）；
- 顺序是有意的：把前置条件验证落地，好过把两个未验证的改动叠在一起。

---
## 0p. 一次量出来的 SPEC 违规：整文件读入 —— 以及为什么它是 Gapless 的前置条件

这一节起于一件小事：跑 30 分钟压测时顺手看了一眼引擎的 RSS，**75 MB**。
而 SPEC §8.2 写的是 **≤60 MB**，PROGRESS §1.1 也一直写着「实测 51.4 MB，通过」。

### 先量，再改

91 首 FLAC 的**文件大小**：

```
91 首，共 3427 MB，单文件 最小 8.1 / 中位 34.8 / 最大 91.5 MB
```

而 `audio_source.cpp` 从第一天起就是 `readWholeFile()` —— **把整个压缩文件读进堆**。
压测队首那首是 46.5 MB，`46.5 + 环路 + DSP + SoXR + catalog ≈ 75 MB`，数字对得上。

> **那 51.4 MB 是怎么来的**：`--step=latency` 只播**它挑的那一首**。
> 预算从来没有「达标」，只是**恰好量到的都是小文件**。

> 这与本文档里反复出现的失败形状是**同一个**：**那句话对样本成立，对总体不成立**。

### 改动：文件句柄，不是文件副本

`MemoryReader` → `FileReader`（`_wfopen` + `_fread`/`_fseeki64`/`_ftelli64`），三个解码器
（FLAC / WAV / MP3）的回调签名**一个都没变**，只有函数体从内存算偏移变成 stdio。
原来那条所有权纪律照旧：reader 住在 source **里面**，比解码器活得久，并且在解码器之后关闭。

`FileReader` **故意没有析构函数** —— 有的话每一次拷贝都会变成一次重复关闭，而这个句柄只属于一个 source。

### 实测（按 PID 量，不按镜像名）

```
scan 完 91 首                RSS 16 MB
播最大的一首（文件 91.5 MB）  RSS 18 MB      ← 改动前是 75 MB+
播中位的一首（文件 34.4 MB）  RSS 18 MB
播最小的一首（文件  8.1 MB）  RSS 19 MB
```

**RSS 现在与文件大小无关**，而且**每一首都落在 60 MB 预算内** ——
不是「量到哪首就哪首达标」，是这件事**对整库成立**。

### 为什么这同时是 Gapless 的前置条件（SPEC §3.7）

§3.7 要求「**预解码：下一首常驻缓冲**」。而整文件读入意味着拼接时**两个解码器同时活着**：

| | 常规 | 最坏 |
|---|---|---|
| 整文件读入 | ~70 MB | **183 MB** |
| 文件句柄 | 解码器状态（几百 KB） | 同左 |

也就是说：**在旧设计下，Gapless 与 60 MB 预算是互斥的** —— 这不是「顺便优化一下」，
而是「不先做这个，§3.7 就不可能同时满足 §8.2」。

### 与既有行为的关系

- 三个解码器的**回调签名与语义未变**；
- `readWholeFile()` 被删除，`readFileHead()` 保留（它只读 16 字节用于认容器）；
- MP4 那条路本来就不整文件读（§0m），现在三条路一致了；
- 失败路径的所有权：`init()` 一拿到 reader 就归 source，所以**开流失败也会经析构函数关闭句柄**，
  既不泄漏也不重复关闭。

---
## 0o. CR-013 落地：目录身份按归一路径，`replace` 按目录替换

裁定两条都实现并验过。这一节只记**为什么这么写**，逐条口径在 `docs/contract-requests.md` 的回复里。

### 那个用户可见的症状

`scan` 以前拿**调用方给的那个字符串**当曲目身份。于是同一个目录换个写法（正斜杠 ↔ 反斜杠，
对话框给反斜杠、默认常量是正斜杠）就是**另一个曲库**：

```
scan <测试曲库>   →  added 91
scan <测试曲库>   →  added 91   ← 同一批文件，91 首变成 182 首、182 个互不相同的 id
```

而且 `findByPath` 命中之后**仍然 `push_back`** —— 同一首歌在 catalog 里出现两次、两条共用一个 id。
**复用了 id 让它看起来已经被处理，实际什么都没处理** —— 数量是错的，`findById` 返回的是先来的那条。

### 归一是**复刻**，不是自己发明

裁定明确要求与 `app/src/shared/library.ts` 的 `libraryPathKey` 一致。
理由是：**两侧各有一套归一，新的不一致会比现在这个重复更难查。**

所以连**局限**都照抄了：不合并连续分隔符、不特殊处理 UNC 前导 `\\` ——
因为这两种形状都出不了目录选择框。多写的每一行「更正确」的归一见解，都是下一次不一致的种子。

**唯一分歧**（按裁定要求写明）：大小写折叠我走 `LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE)`
（Windows 的 Unicode 简单映射），对面是 JS 的 `toLowerCase()`。
中文 + 拉丁路径上逐字节相同；理论分叉点是区域相关映射（土耳其语的 `İ`）。已写进回复由应用侧定夺。

### `replace` 的两个反直觉处，都是裁定点名的

1. **路径不存在时要成功**。不带 `replace` 仍然回 `ERR_NOTFOUND`；带了就**清理并正常返回**。
   理由是真的：**用户移除一个目录，常见原因正是那个盘已经不在了** ——
   这时「不再扫盘、只做清理」是唯一合理的语义。
2. **id 不复用**。被 `replace` 释放的 id **不会**交给别的曲子。
   把一个空出来的 id 给另一首歌，比让旧 id 悬空更糟：
   客户端还握着旧 id 时会**默默作用到错误的曲目**上，而不是什么都不做。
   其他目录的 id 一个都不动（有断言钉住，这是 `replace` 最容易写错的地方）。

### 一个顺带的性能副作用

「已存在则跳过」的判断放在 `readMetadata()` **之前**，所以**重扫一个已知目录不再做任何元数据读取**。
以前每首都要过一次 TagLib。跳过语义和这个优化是同一行代码带来的。

### 新增两个字段，理由都是「没有它就分不清」

`scan` 回复与 `scan_done` 都多给 `skipped` 与 `removed`（只增不改，CR-004 口径）：

- 没有 `skipped` 时，重扫的 `added:0` 与「扫描没看见文件」在协议上**无法区分**；
- 没有 `removed` 时，「按目录替换」与「扫了一个空目录」也无法区分。

### 验收

```
drive.mjs --step=identity    # 26 条断言，裁定给的三条 + 两条边界
```

跑在**两个临时目录**上（硬链接自真实曲库，零拷贝、跑完即删），文件集互不相交 ——
这样「A 的 id 变了」和「B 的 id 变了」不可能被互相混淆。

| 裁定给的三条 | 实测 |
|---|---|
| scan A(反斜杠) → 91；scan A(正斜杠) → added 0、count 91、uniqueIds 91 | ✅ |
| 同一字符串连扫两次 → count 不增长、added 0、**id 未变** | ✅ |
| A → B → A `replace:true` → total = |B| + |A|、A 的 id 全新、**B 的 id 未变** | ✅ |
| 边界：不存在的目录（无 replace）→ `ERR_NOTFOUND` | ✅ 与今天一致 |
| 边界：不存在的目录（`replace:true`）→ `ok:true`、added 0、removed 0 | ✅ |
| 我另加的：`replace:"yes"` → `ERR_STATE`，不猜不强转 | ✅ |

### 与既有行为的关系（旧调用方零影响）

- 不带 `replace` → 语义与今天**完全一致**，只有「重复条目」和「计数」被修掉；
- 已入库曲目的 id **不因归一而改变**（归一只是查找键变了，id 仍由序号单调分配）；
- `list_tracks`、`tracks` 数组形状、`scan_progress` 全都没动。

---
## 0n. ⚠️ 一条被自己的诊断工具骗了很久的结论：内置端点的独占其实是好的

发现它是**顺手的**：§0m 做完后跑全套，`honesty` 的 A1 报了一条失败，追下去发现 A1 拿错了字段（见下），
但同一行输出里还有一句 `trace contains a degradation: false` ——
内置端点上的独占**没有被看门狗降级**。于是去量了一下：

```
mode=exclusive  state=playing  pos=612  rendered=29376   wakes=102
mode=exclusive  state=playing  pos=1626 rendered=78048   wakes=271
mode=exclusive  state=playing  pos=2634 rendered=126432  wakes=439
mode=exclusive  state=playing  pos=3648 rendered=175104  wakes=608
mode=exclusive  state=playing  pos=5154 rendered=247392  wakes=859   degrade=""
```

**内置端点的独占是真的在跑**：唤醒持续增长、帧数持续增长、位置连续推进五秒。

### 那 `1/12` 是哪来的

`--probe-exclusive` 仍报 `1 / 12`。**引擎和探针在同一个端点上给出相反的答案，而引擎那一边在出声。**
去看探针的等待循环，第 135 行：

```c
if (SUCCEEDED(client->GetBufferSize(&bufferFrames)) && padding < bufferFrames) { ... 写入 ... }
```

**那是共享模式（FIFO）的判据。** 独占周期流的 `padding` 在每次唤醒时**等于整个缓冲**，
所以 `padding < bufferFrames` **永远为假**：探针只在 `Start` 前填过一次缓冲，
此后再没写过任何数据，设备要不到数据就不再发事件 —— 干净、可重复、**完全错误**的硬件结论。

这和引擎自己踩过的坑是**同一个**（坑表 #46：用共享模式的节奏驱动独占周期流），
引擎那边先修了，探针从来没拿到修复。而探针正是当初「是端点不是机器」这个结论的**唯一证据来源**。

### 修正后的结论

```
  容器       缓冲    Initialize Start   事件触发      padding / buffer
  16-16      3.00    ok         ok      12 / 12       144 / 144
  16-16      50.00   ok         ok      12 / 12       2400 / 2400
  32-24      3.00    ok         ok      12 / 12       144 / 144
  32-24      50.00   ok         ok      12 / 12       2400 / 2400
  24-24 / 32-32     FAIL       0x88890008（端点确实不接受这两个容器）
```

**内置端点（Intel SST + Conexant）一直支持独占渲染**：16-16 与 32-24，3–50 ms 全部 12/12。
当初引擎在它上面不出声，是**引擎的三个 bug**（§0g：共享模式节奏、24-in-24 越界、看门狗用错信号），
不是端点不干活。**「是端点不是机器」这句是错的** —— 正确的说法是「**当时是代码，不是硬件**」。

顺带一条实际能力：内置端点接受 **16-16**，所以**16-bit / 48 kHz 的文件在它上面可以真正 bit-perfect**。
（§0m 里那条 `not-perfect reason` 说的 24-bit 装进 32-bit 容器，是**另一个**事实，两者不矛盾。）

### 探针现在把 padding 打出来了

报告里新增 `padding / buffer` 一列。**这一列就是当初能一眼看穿这件事的那个数字** ——
它在每次唤醒都等于整缓冲，而旁边写着 `1 / 12`，两件事放一起就自己说出原因了。
一个不打印关键中间量的诊断，会把「我喂错了」显示成「硬件坏了」。

### 教训（与坑表 #39 是同一族，但方向相反）

> #39 是「限制清单停留在过去，说少了」。这一条是**「诊断工具说错了，而文档把它当成事实抄下来了」**。
> 两者的共同点是：**没有第二个人去核对那个『事实』是怎么来的**。

以后凡是「某硬件不支持」这类结论，都要能回答：**用什么量的、那个量具自己验过吗**。

### 顺带修掉的那个测试错误：`honesty` A1 用错了字段

全套第一次跑出 `416 / 1`：`A1: exclusive either reports why it is not bit-perfect, or is bit-perfect`，
载荷是 `{"bp":false,"reason":""}`。

断言用 **`degradeReason`** 去回答「为什么不是 bit-perfect」，而这两个问题不同：
`degradeReason` 的意思是**请求的模式被放弃了**；而「24-bit 音频装进 32-bit 容器」**不是降级** ——
音频完全一样，只是打包不同，这一点 owner 在 CR-010 已经裁定过。
所以 `degradeReason` **理应为空**，而 `bitPerfect` 理应为 false。

引擎给出的原因是**对的**，只是断言问错了字段：

```
exclusive achieved; not-perfect reason="integer passthrough unavailable:
  24-bit audio in a 32-bit container (this endpoint refuses a 24-bit container)"
```

改成读 `get_state.data.outputNotPerfectReason`。这条断言此前一直通过，只是因为**这台机器的 USB DAC
恰好接受窄容器** —— 换到内置端点，它就把一个正确行为报成了缺陷。

---
## 0m. L1 格式补齐：MP4（AAC / ALAC）—— 以及 Media Foundation 用两种 GUID 说同一件事

§0l 之后的 L1 是 **3/5**（FLAC / WAV / MP3）。本轮把 AAC 与 ALAC 做完，**L1 现在是 5/5**。

### 先查机器，再决定能不能做

新增 `--probe-mf`：一个只读的 Media Foundation 侦察工具。
「Windows 有 AAC 解码器」是关于**平台**的陈述，不是关于**这台机器**的 ——
而差别决定了这个功能是能实现，还是只能如实回 `ERR_UNSUPPORTED`。
枚举出来的是**全部**音频编解码器，不是我以为该有的那几个：一份我自己写的清单只能证实我自己的假设，
而我最没把握的那个（ALAC）恰恰只能靠枚举回答。

```
解码器（这台机器）：Microsoft AAC / ALAC / FLAC / MPEG / MP3 / Opus Decoder MFT …
编码器（这台机器）：Microsoft AAC / ALAC / FLAC Audio Encoder MFT …
```

**ALAC 能解也能编** —— 所以测试素材不必靠「平台应该有」来论证，可以**直接造出来**。

### 素材：造，而不是假设

`--probe-mf --write-tone <path> --codec aac|alac` 用系统编码器写出**真的** MP4：

```
tone-aac.m4a   34292 B   ftyp mp42 → moov/trak/mdia/minf/stbl/stsd → mp4a  (2ch/16bit)
tone-alac.m4a  45857 B   ftyp mp42 → moov/trak/mdia/minf/stbl/stsd → alac  (2ch/16bit)
```

（盒结构是逐层走出来的，不是我按扩展名认的。）

### ⚠️ 这个工具第一次跑就**一声不响地死了**

`--write-tone` 指向一个中文目录，退出码 `0xC0000409`、**没有任何输出**。
原因是 Windows 的 `argv` 在**活动 ANSI 代码页**里，中文路径到程序里已经是坏字节；
再把那些字节喂给项目的 `fromUtf8()`，等于请它把一个代码页当 UTF-8 解码 ——
那不是「答错」，而是**病态输入**：`std::filesystem::path` 抛异常，异常没人接，进程 fail-fast。

**引擎本身从来没有这个问题**，因为路径是走 stdin 的 UTF-8 JSON 进来的。
这个诊断工具是全项目**唯一**从命令行收路径的地方，所以只有它必须向 Windows 要真正的 UTF-16 命令行
（`CommandLineToArgvW`），并且把编码包在 `try` 里 ——
**一个会在坏参数上静默死掉的诊断，比一个明确拒绝它的诊断更糟**（这条本项目已经吃过一次）。

### ⚠️ 核心那颗雷：MF 用**两种** GUID 形状命名同一个 codec

我把 ALAC 文件判成了**有损**。日志给出了全部的答案：

```
AAC  文件: subtype {00001610-0000-0010-8000-00AA00389B71}    ← WAVE 式：Data1 低 16 位是 codec tag
ALAC 文件: subtype {616C6163-767A-494D-B478-F29D25DC9037}    ← MP4 采样描述式：Data1 是四字符原子名
```

第二种是 `MFMPEG4Format_Base {00000000-767A-494D-…}` 把**采样描述原子名**放进 Data1，
`0x616C6163` 就是按大端读的 `alac`。我只比对第一种形状，于是
**一个真正的无损文件被报成有损** —— 而这正是**唯一不能出错的方向**：
它等于告诉用户「你的无损文件不是无损的」。

修法是把两种拼法都认，而不是猜一个：`codecIdentity()` 先看是不是 MP4 式（比对 GUID 尾段），
再看是不是 WAVE 式（比对标准模板），两者都返回一个可比较的数，然后 ALAC / FLAC 各写两种拼法。
**未知 codec 一律判为有损**：反过来会承诺一件无法收回的事。

### 又一处「从代理推断事实」：扩展名决定不了 MP4 里装的是什么

`.m4a` 里装 AAC 和装 ALAC 是**同一个容器**，而目录把它们**都**叫 `AAC`，因为文件名是这么暗示的。
它决定 `sourceExact` 能不能亮，所以不是标签问题。

TagLib 其实能回答，但要挑对访问器：`codec()` 枚举**只认它自己认得的那种形状** ——
TagLib 2.3.2 只在采样描述原子**正好 88 字节**时才把 ALAC 认出来，
而 MF 写出来的 ALAC 原子是 **72 字节**，于是枚举报 `Unknown`，**而文件里明明白白写着 `alac`**。
改用 `codecId()`：它直接返回采样描述里的四字符码，是**文件自己说的**。

### 又一次「赋值顺序」：我自己的修正被覆盖了

改完 metadata 后目录**仍然**报 `AAC`。原因是我把新逻辑插在音频属性块里（第 92 行），
而函数末尾（第 106 行）还有一句 `out.codec = codecFromExtension(file);` ——
**它在我后面执行，把我的修正整个抹掉**。
往一条已有的赋值链里插新逻辑，必须确认**后面没有更晚的赋值**。

### MP4 按**路径**打开，不整文件读入

这是唯一一个不把文件读进内存的解码器，理由是硬性的：
媒体库发的就是 `.mp4`，**本机自己的素材里就有 400–950 MB 的**，而 SPEC §8.2 给整个引擎进程 60 MB。
「先全读进来，再挑解码器」在这个引擎里是不可负担的决定。
所以 `openAudioSource` 改成**先读 16 字节头**再选容器，MP4 分支把路径交给 MF 自己去 seek。

代价是**释放顺序**：活的 `IMFSourceReader` 不能活到 `MFShutdown` 之后。
为此加了 `Player::releaseSource()`，`cmdShutdown` 里先放设备、再放解码器、最后才关 MF ——
与当初那个 `AUDIOSES.DLL+0x4016E` 的退出崩溃是**同一类**时序错误，不能再犯。

### 验收

```
drive.mjs --step=formats    # 25 条断言（含 MP4 的 8 条）
```

| 断言 | 为什么它值得存在 |
|---|---|
| ALAC 文件被目录标成 `ALAC`，AAC 标成 `AAC` | 扩展名分不出这两者，这一条钉住「读文件而不是读文件名」 |
| 两个文件都能 open / 播放推进位置 | 容器与解码器确实接上了 |
| **AAC 永远不是 sourceExact** | 有损文件任何链路都不该被说成源精确 |
| **ALAC 的 sourceExact 恰好等于 outputPerfect** | 无损文件的对偶关系，**在任何输出模式下都成立**，所以它是一台没有好声卡的机器上也能跑的断言 |
| `bitPerfect === outputPerfect` | 别名不变式，在有损/无损两种源上都要成立 |

### ⚠️ 本轮**没能**验证的那一条

`--step=formats` 跑到一半，USB DAC **被拔掉了**（`render devices found: 1`，只剩内置编解码器）。
内置端点的独占是死的（§0g），所以独占拿不到，
**ALAC 在独占 + 16-bit 容器下 `sourceExact=true` 这一对没能演示出来**。
步骤如实打印了这件事，而不是把它算成通过：

```
(exclusive not achieved here, so ALAC sourceExact=true could NOT be shown -- the invariant above still holds)
```

仍然成立的是那条**不变式**（`sourceExact === outputPerfect`），它在共享模式下同样被断言。
解码器一侧的无损判定**是验过的**：MP4 打开时会打一行
`[info] mp4 decode: subtype {616C6163-…} lossless=1`，那是 `lossless_` 的实测值。
要补上剩下的半条，把 DAC 插回来重跑 `--step=formats` 即可。

### 已知边界

- **只取第一条音轨**：`.mp4` 里的视频流被显式取消选择，所以打开一个 950 MB 的视频文件只解音频。
  但这样打开一个视频文件仍然不是正常用法 —— `scan` 不列 `.mp4`（只列 `.m4a` / `.aac`）。
- **`.aac`（裸 ADTS 流）没有实现**：TagLib 与 MF 都能处理 `.m4a`，但裸 ADTS 没测过，所以不宣称。
- **输出格式回退只到 16-bit PCM**：浮点优先，失败则 16-bit。本机两个编码器都用不上更宽的路。
- **`--probe-mf` 是只读的**，除了显式的 `--write-tone`。

---
## 0l. L1 音频格式：MP3 解码 + 把「有损」和「链路不完美」分开（本轮新增）

SPEC §3.8 L1 写的是「MP3/AAC/WAV/FLAC/ALAC 解码」。引擎实际只有 `dr_flac` / `dr_wav`，
`sniffContainer` 只有 `{Flac, Wav}` 两个分支 —— **MP3 从来没实现过**。

**它藏在一套 407 条全绿的断言后面**，因为**测试库 91 首全是 FLAC**（实测统计：`.flac` 91 / 其他 0）。
这是「测试素材决定了验过什么」的教科书案例：断言全绿只证明**被测的东西**对。

### 症状（实测）

真 MP3 是这样的：

```
scan  -> ok，曲目被正常列出，durationMs=257646 / 44100 Hz / 320 kbps 全是真值
open  -> ERR_DECODE: unrecognised audio container
```

**扫描一个字都不报**：曲目信息完整显示，用户双击才会发现它永远放不出声。
（我第一次是用手工构造的 ID3 文件探的，那时元数据全是 0 —— 真文件的元数据是全的。
差别在于 TagLib 本来就认识 MP3，**只有解码器不认识**。）

### 实现

- `third_party/dr_libs/dr_mp3.h` **早就 vendored 了**（209 KB），只是从没 `#include`。
  与 dr_flac / dr_wav 同族、同许可、同回调约定，所以这**不是新增依赖**。
- MP3 **没有魔数**（可能以 ID3 开头、可能直接是帧、可能什么都没有），所以它**不能靠 sniff**：
  `sniffContainer` 认不出它，就交给解码器去开 —— 只有它能分辨真帧和巧合。
- **故意加了 ISO-BMFF 这一支**：MP4 里到处是与 MPEG 帧同步字相同的字节序列，
  放任它落到 MP3 分支，dr_mp3 会「成功」并放出噪声而回报成功。现在它被显式认出并**指名拒绝**。
- `DR_MP3_FLOAT_OUTPUT` **故意不定义**：dr_mp3 的默认输出就是 16 bit，而这不是要绕开的限制 ——
  MPEG-1 Layer III 重建的就是 16 bit 量级的信号。开了浮点路径，交付的样本会比格式的真实分辨率更宽，
  `bitDepth()` 就成了一个样本支撑不起的数字。
- `drmp3_read_pcm_frames_s32` **不存在**（dr_mp3 只有 `_f32` 和 `_s16`），所以走 f32 路径 + 一个交错转平面。

### ⚠️ 第一颗雷：`totalPCMFrameCount` 含编码器延迟与填充

dr_mp3 自己写着 *"Includes delay and padding"*，而它的读取端会**跳过开头的延迟、在填充处截断**。
把那个原始数字当曲长用，会同时错两件事：

- 时长长出**一个编码器延迟**（44100 Hz 下 1105 帧 = 25 ms，进度条上看得见）；
- **尾永远到不了** —— 结束判定是「已交出帧数 ≥ 总帧数」，而读取端提前停了。
  曲子会**永远停在 99%**。

交付出去的其实是可听的那一段：

```
usableFrames = totalPCMFrameCount - delayInPCMFrames - paddingInPCMFrames
```

### ⚠️ 第二颗雷：dr_mp3 只在有 Xing/Info 头时才知道长度

`drmp3_init_memory()` 之后 `totalPCMFrameCount` 仍是 `DRMP3_UINT64_MAX`，
意思是**这个流没有 Xing/Info 头**（普通 CBR 就是这样；本机这 5 个真 MP3 全是）。
它之所以不在 init 里替你数，是因为数一遍是 **O(文件)** 的。

**我们付这个代价**：`drmp3_get_pcm_frame_count()` 走一遍，实测 **open 47 ms**（SPEC 8.2 预算 1000 ms）。
**不能猜** —— 这个数字是结束判定的基准，猜小了截尾、猜大了永远播不完。

顺带一个诚实的边界：没有 LAME 标签就没有 delay/padding 可读，
所以这类文件的**编码器延迟无法裁掉**，只能按原始长度报。

### ⭐ 真正值钱的那条：`sourceExact` 终于有了用武之地

上一轮（§0e）把 `bitPerfect` 拆成三段时，`sourceExact` 的注释写着：
「今天它对每首曲子都等于 `outputPerfect`，但等有损解码器落地，两者必须**已经**是不同的意思，
而不是在压力下临时拆一个布尔。」

**有损解码器落地了。** 实测同一条完美链路、同一台设备、两个文件：

```
lossy   : mode=exclusive container=16 outputPerfect=true pcmPassthrough=true sourceExact=false
lossless: mode=exclusive container=24 outputPerfect=true pcmPassthrough=true sourceExact=true
```

**链路一样完美，区别只在文件本身** —— 这正是单个布尔表达不了的那对事实。
而且顺带拿到一个此前拿不到的结果：**MP3 在本机现在能跑到真 bit-perfect**
（44100 Hz 源、独占 16-bit 容器、无重采样）。

「有损文件算不算 bit-perfect」现在答案是可显示的：徽标亮（链路交付无改动）
**同时** `sourceExact=false`（文件本来就是有损的）。用户不会再把它读成「信号链有问题」。

`AudioSource::lossless()` 由**解码器**回答，不从扩展名猜：`FlacSource` 恒 true；
`WavSource` 看 `translatedFormatTag`（**`.wav` 是容器不是承诺** —— ADPCM / A-law / mu-law
都是 dr_wav 会解的有损格式，而 `EXTENSIBLE` 要先解析子格式）；`Mp3Source` 恒 false。

### 怎么验的

```
drive.mjs --step=formats    # 17 条断言，跑在真 MP3 上
```

新步骤用**硬链接**把真 MP3 链进一个临时目录（同字节、零 I/O、不复制 10 MB），
所以它扫的是 2 个文件而不是 owner 工作目录里的 11k 个。断言包括：

- 每首 MP3 的 duration / rate / channels / bitrate 都是真值，不是 0；
- **解码器算出的时长与 TagLib 的相差 ≤ 5 ms** —— 两个不共享代码的实现互相印证。
  实测差 **1 ms**（257645 vs 257646）；
- open 不再回 `ERR_DECODE`（**这就是回归断言**）；
- 播放真的推进位置；seek 落到目标附近；**自然播完发 `ended reason:"eof"`**；
- `bitPerfect === outputPerfect` 别名不变式在有损曲目上依然成立；
- **有损文件在任何链路下 `sourceExact` 都是 false**；无损文件的 `sourceExact` 恰好等于 `outputPerfect`（两种模式都成立）；
- 只有一个 ID3 标签、没有任何 MPEG 帧的文件被**拒绝**，而不是被猜成音频放出噪声。

### 一处被测出来的真实性能特性（不是缺陷）

**无 Xing 索引的 MP3，seek 是「解码并丢弃到目标」**：跳到一首 4 分钟曲子的中点，
要解码 2 分钟的音频。实测 **159 ms**。有 Xing/Info 头的文件带 seek 表，走的是另一条路。
**本机这 5 个文件恰好都没有索引**，所以测到的是慢路径；快路径（带索引）**未实测**。
步骤里的断言因此写的是「这是一条命令，不是卡死」，而 SPEC 8.2 的 seek 预算
由 `--step=latency` 在能按偏移定位的格式上量。

### 顺手修掉的一个测试缺陷：断言把「全机」当成了「自己」

全套第一次跑出 **424 断言 / 1 失败**：`lifecycle` 报「残留 1 个 twilight-engine 进程」。

**查证（不是猜）**：

- `app/src/main/engine-host.ts:60` —— 应用**默认探测并 spawn 同一个** `engine/bin/twilight-engine.exe`；
- `app/.smoke/qa/result.json` 与 `electron.log` 的写入时间是 **20:46:31** —— B 侧当时正在跑它的 Electron 测试。

那个「残留」是**邻居的引擎**，不是我的。

**但这仍然是我的缺陷**：`tasklist` 按镜像名统计全机，然后把它当成关于**本次运行**的证据。
反方向的盲区更糟 —— **真正的泄漏可以躲在邻居的健康进程后面**。

改成：断言**自己 spawn 的**子进程（`EngineClient` 维护存活集合，`exit` 时移除），
全机扫描降级为 `warn`（「有不是本次启动的引擎在跑 —— 应用 spawn 的是同一个 exe」）。
**问「我留下东西了吗」，不要去数别人的东西。**

### 还没做：AAC / ALAC

**MP4/M4A 容器仍未实现。** 现在它被显式认出并给出指名错误：

```
ERR_DECODE: MP4/M4A (AAC/ALAC) is not decoded by this build -- it decodes FLAC, WAV and MP3
```

比笼统的「无法识别的容器」有用得多：用户不会去找一个并不存在的损坏文件。
下一步用 Media Foundation 解 MP4（Windows 自带 AAC 与 ALAC 解码器，零新依赖），
但**本机一个 .m4a 都没有** —— 需要先用 MF 的 AAC 编码器造出真实测试文件，
否则又会退化成「没有素材就没有验过」。

---
## 0k. 切歌防爆音 + 设备热插拔（本轮新增，SPEC/CONTRACT 的欠账）

这两项不是新功能，是**规范要求我有、而我一直没有**的东西。

### 一、切歌 5 ms 淡出（SPEC §3.7 line 237 / 540）

SPEC 原文：**「手动切歌不交叉，仅 5 ms 淡出防爆音」**。
此前切歌是**直接把波形切断** —— 一个阶跃就是宽带信号，那一声「啪」是真实存在的，
而且**用户每跳一首就听到一次**。

实现要点：

- 淡变**必须是逐样本**的。5 ms 比典型缓冲周期还短，按块做要么整个跳过、要么变成一次阶跃 ——
  而阶跃正是它要消除的东西。
- **每帧推进一次**，不是每样本：两个声道必须用同一个系数，否则淡出期间声像会偏移。
- 必须**等它走完**再 `stop()`，否则淡变的尾巴根本到不了设备；
  同时有**截止时间**兜底 —— 如果设备已经不响应（正是独占看门狗处理的那种故障），
  标志位永远不会清零，没有兜底就会把控制线程挂死。

**只挂在切歌路径上**：SPEC 没有要求 seek 淡变，而 SPEC §8.2 的 seek 预算是 150 ms，
给它加一次等待会白吃掉余量。

### 二、设备热插拔（SPEC §3.3 line 203 + CONTRACT §3.3 的 `device_changed`）

CONTRACT 定义了 `device_changed` 事件，而引擎**从来没有发出过**。
于是用户拔掉耳机、或把默认输出换到别处，**UI 完全不知道**，还在显示一个已经不在使用的设备。

新增 `device_monitor.{hpp,cpp}`（`IMMNotificationClient`）：

- **回调只记录，不干活**。它跑在系统线程上，与音频 API 的时序无关；
  真正的重开流交给控制线程 —— 那是唯一被允许碰流的线程。
  在回调里重开流等于从一个自己无法控制时序与公寓的线程重入音频 API。
- **只跟 eConsole**。Windows 对 console / multimedia / communications 三个角色**分别**回调，
  一次切换会产生三条通知。
- **一次用户动作 = 一条事件**：先按角色过滤，再与「上次已上报的默认设备」比对去重。

控制线程侧（`serviceDeviceChanges`）判断两件事**都会让流失效**：

| 情况 | 语义 |
|---|---|
| 当前设备被**移除** | 拔耳机 / 设备被禁用 |
| 默认设备**移动到别的设备** | 用户在系统里选了别的输出 —— 引擎应当跟随，否则就是无视用户 |

恢复时按 SPEC §3.3：短暂淡出 → 释放流 → 按 ID 重开 → 失败回退默认 → 恢复播放。
**位置按「源帧」保存**，因为新设备可能跑在别的采样率上，用设备帧换算会落到曲目里的错误位置。

### 实测（真机，切系统默认输出）

```
playing on: 耳机 (NICEHCK HiFi Audio)  pos=810
切到内置扬声器 → device_changed { deviceName: 扬声器, defaultChanged: true, streamLost: true }
  device=扬声器  pos=3990  state=playing     ← 跟随了默认设备，位置连续
切回 DAC       → device_changed { deviceName: 耳机, defaultChanged: true, streamLost: true }
  device=耳机    pos=7130  state=playing
device_changed 事件数：2（一次切换一条）
```

### 途中修掉的两个自己的错

1. **`streamLost` 判漏了一半**：只判「当前设备被移除」，没判「默认移动到别处」。
   后者同样让流失效 —— 用户既然选了别的输出，引擎继续往旧设备放就是无视他。
2. **第一条通知命名的是「正在离开」的设备**：因为我按三个角色都设了默认，
   而引擎只跟 eConsole —— 于是**第一条通知来自一个引擎不跟的角色**，事件里的设备名是旧的。
   只跟 eConsole 之后，事件命名的是**移动到的**那个设备。

### 验收

```
drive.mjs --step=hotplug    # 9 条断言：真机切换默认输出、验证事件命名与去重、播放不断
drive.mjs                   # 全套 462 条断言（22 个步骤）
```

新步骤会**把机器设置改回原样**，且只有一个回放端点时如实跳过（不假装测过）。

---

## 0j. 播放控制补齐 + 声道工具（面向 UI 对接）

owner 要求「把音频相关的控制做出来，方便和后面的 UI 对接」。本轮做了两块：
**补上引擎已经知道、但从不上报的信息**，以及**一组此前完全没有的声道工具**。

### 一、三处「UI 无法知道」的缺口

这三处都不需要新命令，是**状态事件缺字段** —— 引擎知道，UI 猜不到：

| 缺口 | 症状 |
|---|---|
| `repeatMode` 从不回报 | `set_repeat` 收下模式、引擎也存了，却没人报回去；UI 只能记住自己上次发的，任何别处改动就错 |
| 队列内容与位置从不回报 | UI 无法知道队列里有什么、当前播第几首 |
| **`queueIndex` 语义错误** | 它是 `size_t`，**表示不了「不在队列里」** → 双击队列外的曲子后索引仍留着上一首的位置，**UI 会高亮错误的行** |

第三条是个真 bug，不只是缺字段：改成 `int`（-1 = 不是队列成员），并在打开时**先重置再查找**。

### 二、`set_muted`：静音是独立状态，不是「音量=0」

把静音建模成「记住旧音量 → 设 0 → 再放回去」会对 UI **双向撒谎**：
用户看不到自己设的音量仍然有效，取消静音也无法还原。
所以 `muted` 与 `volume` 是两个字段，回复里同时给出两者。
渲染端把静音折进**既有的 10 ms 平滑增益**，所以静音/取消静音都不会爆音——复用已有的斜坡，没有新增机制。

### 三、声道工具（CR-012）

`balance` / `mono` / `stereoWidth` / `swapChannels` / `channelGains`，一条 `set_channels` 局部更新。
三条参考播放器都有，引擎此前**一个都没有**。

**四条语义都是刻意的**：

1. **balance 衰减对侧，不提升本侧** —— 提升会削波，而这个控件存在的意义就是它不可能削波。
2. **mono 取平均，不丢弃一路** —— 丢弃会静默丢掉被声像放到那一路的内容。
3. **stereoWidth 是 mid/side**，所以**不改变两声道之和**（有断言钉住）；
   0 与 `mono:true` 必须给出相同结果，两个控件不能互相矛盾。
4. **越界拒绝，不静默钳位** —— 与 `set_eq` 同口径。

**实现顺序**（照 QueMusic）：增益 → 声道工具 → 限幅 → 钳位 → 音量。
限幅必须在声道工具**之后**，否则一次宽度提升可能在限幅判定「安全」之后又越过满刻度。

### ⭐ bit-perfect 与这些控件的关系

> **任何一个声道工具被启用，就撤销 bit-perfect 声明**，理由与 EQ 完全相同。
> **全部处于默认值（balance 0 / width 1.0 / 其余 off）时整条链是直通的**，
> 所以从不动这些控件的用户，bit-perfect 完全不受影响。

这条有 6 条断言钉住（5 个工具各一条 + 默认通过一条）。

### 这轮我自己造的一个 bug（记进坑表）

**声道工具最初被 EQ 的旁路开关一起关掉了。**
`wetMix_` 原本由 `eqEnabled` 驱动，而声道工具跑在同一条 wet 路径上 ——
于是**关掉 EQ 会静默禁用 balance / mono / width / swap / trim**。
改成「EQ 或任一工具启用」即 wet。**一个控件依赖另一个不相关的开关，是最难被发现的那种错。**

两个测试自身的错也值得记：balance 的断言方向写反了（**代码是对的、测试是错的**），
以及 width 测试用了会削波的输入（0.8/0.2 在 width=2 时左声道到 1.1，被安全钳位截断）——
**测试错了和代码错了一样有害，一旦它被信任。**

### 验收

```
twilight-engine.exe --selftest      # 17 条离线断言，逐个对「定义」验证，而非「输出变了」
drive.mjs --step=channels           # 25 条协议断言
drive.mjs                           # 全套 392 条断言（19 个步骤）
```

离线断言刻意不满足于「输出变了」：那对**接反了、接错声道、比例写错**的控件一样通过。
每个工具都用**每声道恒定信号**驱动，正确答案是算术，不是观感。

---

## 0i. 异步响度扫描：让引擎在干活时还能答话

CR-011 的缓存让**重复**扫描几乎瞬时（1 ms）。但**第一次**全库扫描仍是同步阻塞的：
91 首约 2 分钟，期间引擎**什么都答不了** —— 没有进度、没法取消、连 `get_state` 都要等。

### 结果

```
同步：     阻塞 137.0 s 期间完全无响应
异步：     完成 147.9 s（仅慢 8%），最差命令延迟 37 ms
全库：     19653 s 音频（5.5 小时）在 147.9 s 内测完，约 133 倍实时
91/91 条结果，replyId 对得上，无崩溃
```

**用 8% 的吞吐换来了全程可响应**，这笔账很划算。

### 设计要点

- **按 chunk 边界让出**，不是按文件。第一版按文件让出，而单首约 200 秒音频要 ~1.5 秒才测完，
  于是「15 ms 预算」实际产生**数秒的卡顿**（实测 `get_state` 要 2885 ms）。改成每 4096 帧一个 chunk 后降到 37 ms。
- **每次让出做 64 个 chunk**（约 6 秒音频）。太小反而更慢：控制循环自身的 5 ms 输入轮询会占主导，
  切片从 8 chunk 提到 64 chunk 后总耗时从 ~200 s 回到 147.9 s。
- **进度事件按人类节奏节流**（250 ms）。第一版每片发一次，全库会发出 **26,558 条**事件 ——
  比扫描本身的产出还多，应用还得反过来限流。现在 547 条，并附带 `chunks` 计数让进度条平滑移动。
- **异步不提供专辑增益，而且是明确拒绝**：专辑响度需要每首的解码器状态同时存活，
  91 首约 10–20 MB，而 SPEC §8.2 给整个引擎的预算是 60 MB。
  与其返回一个按子集算出的数字，不如回 `ERR_STATE` 并说明「用同步的 album:true」。
- **内存不随库大小增长**：任何时刻只有**一个**解码器 + 一个 ebur128 状态活着。

### 这轮我自己造的两个 bug（都记进坑表）

1. **把「文件是否打开」推断成「缓冲区是否为空」** —— 缓冲区是每次调用的局部变量，
   函数返回即清空，于是每一片都以为没有文件在打开，**重新打开同一个解码器** → 在解码器里访问违例。
2. **把临时缓冲区放在每次调用的局部** —— 即使改成显式标志，缓冲区仍然每片重建，
   于是每片都把进度丢一次：**永远前进 8 个 chunk 再丢掉，永不完成**。

缓冲区现在随**文件**存活（在 `openNextScanFile` 里分配，跨片复用）。

### 验收

```
node engine\tools\drive.mjs --step=loudness   # 64 条断言，含异步延迟/节流/并发拒绝/完成事件
node engine\tools\drive.mjs                   # 全套 367 条断言
```

---

## 0h. 扫描缓存 + operationId（owner 裁定项）

### 响度扫描的磁盘缓存（CR-011 裁定「加缓存」）

**这一条就是「低负载」本身**：91 首全库扫描原本每次都要重新解码全部音频。

```
  重复扫描：4575 ms  →  1 ms      cacheHits 3/3
```

- 位置：与可执行文件同目录的 `bin/loudness-cache.json`（与崩溃转储、链接映射同一处；
  引擎本来就往那里写）。
- **失效判据是路径 + 文件大小 + 修改时间**。只按路径缓存会把「原地重新编码过」的文件
  的旧测量结果喂给用户——而**错误的 ReplayGain 会被应用到音频上**，不只是显示错。
- **原子写**（临时文件 + rename），SPEC §8 要求。写到一半崩溃只会留下旧缓存，
  而不是一个下次启动必须当成损坏的截断文件。
- 缓存**读不出来/损坏/版本不符**都不是错误：代价只是重新测量一次，
  所以它降级成「冷扫描」而不是让用户要的那次扫描失败。

#### ⚠️ 设计上的一个真问题：专辑增益与缓存天然冲突

专辑响度是**各部分的 gating 组合**，需要**每首曲子的解码器状态同时存活**。
**而缓存命中的曲子根本没有状态**——它压根没被解码。

我第一版想「聪明」一点：先走缓存，如果专辑合不出来就**悄悄重跑一次带解码的**。
**那比不做还糟**——它付了全量解码的代价，还报出 `cacheHits: 0`，
于是缓存看起来是坏的，而它其实完全照吩咐做了。

**改成让调用方显式决定**：`analyze_loudness` 增加 `album: true`。

| 调用方要什么 | 代价 |
|---|---|
| 只要**单曲**增益（ReplayGain 单曲模式） | **走缓存，不解码** |
| 要**专辑**增益 | 必须解码——这是算法本身的要求，不是实现偷懒 |

两者代价差这么多，就不该由引擎替调用方猜。
**求稳的「自动重试」在这里正好是错的**：它把两种代价完全不同的模式混成了一个看起来一样的命令。

另外，专辑结果本身也按**精确曲目列表**缓存（不用哈希：单曲条目已经证明了文件没变，
所以比对列表既充分又不可能碰撞——而碰撞在这里意味着给出一个错误的专辑增益）。

### operationId（CR-007 裁定「采纳」）

每次 `open` 由**引擎**分配自增 id，出现在 `open` 回复与 `state` / `position` / `ended` 事件里。

- **在引擎侧**，因为只有引擎知道一个事件属于哪条流；客户端计数器只是对顺序的猜测。
- 从 **1** 开始，所以载荷里的 `0` 只可能是「无会话」，不会被读成「第一个会话」。
- 在 **`openTrack`** 里递增，不在 `play()` 里：open 才是让上一个会话说失效的事件，
  **暂停/继续不得制造新会话**（有断言钉住）。
- 它解决的是 `trackId` **表达不了**的那种情况：**同一首曲子连开两次**（单曲循环、重播），
  以及快速连点 next 时两个会话的事件交错。

### 验收

```
node engine\tools\drive.mjs --step=loudness   # 43 条断言，含「重复扫描 hit 满且不重新解码」
node engine\tools\drive.mjs --step=session    # 12 条断言，operationId 单调、别名一致、暂停不换会话
node engine\tools\drive.mjs                   # 全套 343 条断言
```

新增步骤：`session`。全套 321 → 346 条（含 `lifecycle` 新增的「退出不留 dump」闸门）。

---

## 0g. ⭐ 独占真的跑起来了：插上 USB DAC 之后（本轮改写）

**结论从「本机 bit-perfect 不可达」翻成了「能跑」。**

### 第一步：挖驱动 —— 是端点，不是机器

`--probe-exclusive`（常驻引擎）把三件事**分开**报：初始化成功 / 启动成功 / **设备到底有没有真的发过缓冲区事件**。
内置编解码器上：`16-16` 与 `32-24` 能开流，但**事件只响 1 次 / 12 次等待**，然后再也不发。
排除了「我没喂它」（改成每次唤醒都喂满仍是 1/12）与「缓冲区太小」（3–50 ms 五档一样）。
**设备不消耗缓冲区 ⇒ 驱动没实现独占渲染。**

同时发现：**用户有一个 NICEHCK HiFi Audio USB DAC，注册在册但没插。**

### 第二步：插上 DAC —— 三次「原来如此」

```
独占格式：44100/48000/96000/192000 × 16/24/32，共 12 种
事件触发：16-16、24-24、32-32 全部 12/12（不是 1/12）
```

然后引擎仍然不出声。逐个查下来，**三个 bug 全是我的，而且全都只在「真正支持独占的设备」上才会暴露**：

| # | bug | 为什么以前从没暴露 |
|---|---|---|
| 1 | **用共享模式的节奏驱动独占周期流** | `available = buffer - padding` 是共享模式（FIFO）的惯用法；独占周期流的 padding 会一直等于整缓冲 → `available` 恒为 0 → 渲染循环在 `continue` 上空转：**设备每周期都在发事件、环里满是数据，却一个字节都没写出去** |
| 2 | **24-in-24 容器写越界** | `bits == 24` 分支写 `int32_t`（4 字节），而真 24 位容器 `blockAlign` 是 **3 字节**/样本 → 每样本多写 1 字节，缓冲区堆越界，**直接崩**。此前所有端点只接受 24-in-32（stride 4），该路径从不可达 |
| 3 | **看门狗用错了信号** | 它拿 `framesRendered_ == 0` 当「设备没发事件」，但那只是「环里当时没数据」。**刚 play 时喂料线程还在预热，这个条件必然成立** → 在一个已经报了 `outputPerfect=true` 的流上触发降级：**引擎把自己劝退了** |

修复后：

```
landed: exclusive 44100Hz bitPerfect=true resampled=false
-> exclusive delivering bit-perfect output
output-perfect reached: 24-bit, container 24, exclusive
pos=2007ms（2 秒播放后），xrun=0，rendered 正常增长
```

### 第三步：为此新增的可观测性（保留）

能查出来靠的是把**管道按阶段拆开上报**：

```
renderWakes     设备发了几次事件   ← 「流活着吗」
feederDelivered 喂料产出了多少帧  ← 「上游有货吗」
ringBuffered    环里积压多少帧    ← 「中间堵住了吗」
renderedFrames  设备吃掉多少帧    ← 「下游动了吗」
```

任一为 0 都指向不同阶段。**「没有声音」在引擎内部原本是一团模糊，现在是三段可分辨的失败。**

### ✅ 已解决：独占模式下进程**退出时**访问违例

**现象**：`shutdown` 之后进程以 `0xC0000005` 结束，位置在引擎打印 `engine exiting` **之后**，
即 `app.run()` 返回后的析构阶段。播放本身完全正常。

#### 定位过程（三个「不是」换来一个「是」）

1. **先把崩溃报告修好。** 原来只打印 exe 基址并让人自己减——但第一次用就发现崩溃地址离 exe 基址约 2.8 GB，
   减出来的是个无意义的 RVA。**一个会悄悄指错方向的诊断比不诊断更糟。**
   改成用 `GetModuleHandleExA(FROM_ADDRESS)` 直接解析**出错模块**，并只在模块是自己的时候才给 RVA。
   结果一次就说清了：**`AUDIOSES.DLL+0x4016E`**（Windows 音频会话服务，不是我的代码）。
2. **不是渲染线程的收尾**：三种场景都是独占就崩、共享就干净——包括**开了独占但从未 play** 的那一种，
   那时渲染线程根本没起来。
3. **不是我那几个释放步骤**：用临时的 env 开关逐个跳过 `CoUninitialize` / `client->Stop()` / `CloseHandle(event)` /
   释放顺序——**全都照崩**。
   （那个临时开关**已删除**：一个会跳过 `CoUninitialize` 的环境变量留在产品代码里，比它要查的崩溃更危险。）

#### 真正的原因

`cmdShutdown` 只调了 `player_.stop()`，**没有关设备**，紧跟着 `player_.stop()` 里那句
「已经在停止状态就提前 return」还把 `stop` 变成了 no-op。
于是**独占的 WASAPI client 一直开着**，最后由 `App` 析构时的 `~WasapiOutput()` 去释放 ——
**那已经是进程退出阶段**，而 `AUDIOSES` 在那里最不宽容。

共享模式为什么没事：它从没被 `set_output` 打开过，释放路径不同。
（`output_.open(...)` 每次都先 `close()`，所以「还没开始播」也能留下一个活着的 client。）

#### 修法

`cmdShutdown` 里显式、同步地把设备关掉：

```cpp
void App::cmdShutdown(const Json& cmd) {
    // 先关设备再回复、再返回：把释放挪出进程退出窗口。
    player_.releaseOutput();
    replyOk(cmd, Json::object());
    shutdownRequested_ = true;
}
```

**四个场景全部干净**（回归实测）。

#### 为什么它能躲过一整套全绿的套件

**没有任何断言去看过快照文件。** 播放完美、位置准确、xrun 为 0，崩溃发生在引擎已经记录了
「正常退出」之后。已补上回归闸门：`--step=lifecycle` 现在跑一次独占播放然后
**断言 `bin/twilight-engine-crash.dmp` 不存在**。

断言查 dump 文件而不是退出码是刻意的：崩溃的收尾在若干路径上退出码仍读作成功，dump 不会。

### （历史）原文：未解决

> 以下为修复前的记录，保留以说明当时的判断边界。

```
shutdown -> ok=true
engine exited: code=3221225477 (0xC0000005)
```

- **播放本身完全正常**（位置准确、`bitPerfect=true`、`xrun=0`）
- 崩溃在引擎打印 `engine exiting` **之后**，即 `app.run()` 返回后的析构/静态销毁阶段
- 共享模式退出干净（`--step=lifecycle` 通过）
- 已排除：COM 释放顺序（`releaseAll()` 先放对象再 `CoUninitialize`，顺序正确）；
  渲染线程的 `CoUninitialize`（去掉后仍崩，**该实验性改动已回滚**，因为它没修好任何东西）
- **未定位。** 影响面：独占模式退出时留一个 dump，不影响播放。已记入 CR-006，没有假装它不存在。

---

## 0g-old. （历史）原文：独占之谜解开了：不是这台机器，是这个端点

owner 让「继续深挖驱动」。挖出了一个此前不知道的事实，结论整个翻过来。

### 当前端点是什么

```
扬声器 (Audio Device) = Intel 智音技术(SST) + Conexant 编解码器
                        INTELAUDIO\FUNC_01&VEN_14F1&DEV_1F87
```

即**笔记本内置扬声器**，也是本机唯一处于 present 状态的回放端点。

### 新增 `--probe-exclusive`：把三件事分开报

「初始化成功」「启动成功」「**设备到底有没有真的发过缓冲区事件**」——
这三件事在引擎内部看起来完全一样，而只有第三件意味着能出声。

```
  container  buffer(ms)      Initialize  Start   event fired / waits
  16-16      3/6/12/20/50    ok          ok      1 / 12      ← 只响一次
  32-24      3/6/12/20/50    ok          ok      1 / 12      ← 只响一次
  24-24      all             FAIL        FAIL    0x88890008
  32-32      all             FAIL        FAIL    0x88890008
```

**「只响一次」就是答案**：`Start` 之后设备要了**一次**缓冲区，然后再也不发事件。

排除了两种解释：
- **不是「我没喂它」**：第一版探针只在 Start 前填一次缓冲，改成**每次被唤醒都喂满**之后——还是 1/12。
- **不是缓冲区太小**：3 ms 到 50 ms 五档**完全一样**。

> 设备要了一次数据之后不再要第二次，说明**它根本没有在消耗缓冲区**。
> 一个不消耗缓冲区的独占流不可能出声——而所有 API 都返回成功。

**所以是驱动没实现独占渲染，不是我的开流方式不对。**
这也解释了那条「能开流、报 bitPerfect=true、却一个采样都不出」：三个 API 全绿，设备不干活。
看门狗抓的正是这个。

### ⭐ 真正有用的那条：你有一个 USB DAC，现在没插

```
  扬声器 (2- NICEHCK HiFi Audio)   ← USB DAC，注册在册，当前不在位
  耳机   (NICEHCK HiFi Audio)      ← 同上
  扬声器 (ECHO MINI)               ← 蓝牙音箱，当前不在位
```

**插上 NICEHCK USB DAC，跑 `--probe-exclusive`，看它是否报满 12/12。**

**引擎一行都不用改**：格式探测、能力上报、开流协商、看门狗、降级明示全是能力驱动的。
这是当初把它们做成「探测驱动」而不是「硬编码」的回报。

### 顺带修正一条说法

CR-010 回复里我写「本机 bit-perfect 有两条独立原因」。更准确的是**两条都源自同一个端点**：
它既不做独占渲染，也只接受 24-in-32。**换端点两条可能同时消失。**

---

## 0f. ReplayGain 的测量端：EBU R128 扫描

SPEC §3.4 要求「libebur128 扫描（整轨 + 专辑），目标 -18 LUFS，用 track_peak 防削波」。
增益的应用早就做好了，**但引擎算不出 `trackGainDb` / `albumGainDb`** ——
那是功能的一半，而且是缺了以后另一半无法使用的那一半。本轮补上。

### 依赖：libebur128 v1.2.6（MIT），已 vendored

它就是 SPEC §2.6 组件表点名的那一个，**没有换实现**。
响度是被规范定义的量，差 0.1 LU 就是差 0.1 LU——
用一个大家必须一致的参考实现，比自己读一遍标准再写一遍更诚实。
（该 release 停更于 2021-02-14，与 SPEC 的记载一致。）

vendored 为源码而非配置时下载：组件自 2021 年定版，
**一个无法离线复现的构建，比仓库里多 53 KB 更糟**。

接进来踩到两个坑，都是库自己的文档写明的正路（没有改第三方文件）：

| 现象 | 正路 |
|---|---|
| `sys/queue.h` 找不到（BSD 头，MSVC 没有） | 库自带 `queue/sys/queue.h`，上游 CMake 就是在系统缺失时把它加进 include path |
| `M_PI` 未声明 | 库源码注释明写「You may have to define `_USE_MATH_DEFINES` if you use MSVC」 |

### ⚠️ 它最容易做错的地方：专辑响度**不是**各曲的平均

> **专辑响度是整个专辑做 gating 后的结果，不是各曲响度的平均值。**

libebur128 为此提供 `ebur128_loudness_global_multiple`，
**需要各曲的 state 同时存活**——所以扫描是「一次累积多个 track」而不是「一次一个文件」。

按曲独立测量再平均，会得到一个**完全合理但错误**的专辑数字，而且没人能一眼看出来。
实测差异（本机 5 首）：**专辑 -7.53 LUFS vs 各曲均值 -8.46 LUFS**，差 0.93 LU。

这一步有断言钉住：**专辑值必须不等于均值**。将来谁把它「简化」成平均，会当场失败。

### 验证（两层，都不需要音频硬件）

```
--selftest   -23 dBFS 1 kHz 立体声正弦 -> -22.9933 LUFS   ← EBU 自己的校准信号
             同一信号 +6 dB -> 响度 +6.00 LU              ← 钉住量纲
             满幅正弦真实峰值 >= 0 dBFS（sample peak 会报恰好 0.0）
--step=loudness   5 首真实曲目，33 条断言
```

**-22.9933 对 -23.0，误差 0.007 dB** —— 不是勉强落在容差里。

那个校准点一次钉住四件事：K 加权滤波器、声道求和、-0.691 偏移、gating。**任何一项错都到不了 -23。**
第二条（6 dB 进 → 6.00 LU 出）是必要的补充：单点校准查不出**缩放错误**——
一个稳定但比例错的实现同样会在 -23 点附近通过。

`+6 dB -> +6.00 LU` 那条尤其值得留，因为**它正是单点校准测不出的那类错**。

### 性能与已知缺口

**1063 秒音频（5 首，44.1k/96k，16/24-bit）用 6.6 秒分析完，约 160 倍实时。**

- **扫描结果没有持久化**：SPEC §8 要求缓存到磁盘避免重复扫描，目前每次调用都重新解码。
  91 首全库一次约 2 分钟，可接受但不理想。已在 CR-011 里问 owner 要不要加缓存。
- 命令是**同步阻塞**的。全库扫描期间引擎不响应别的命令（它有界：看 `maxSeconds`）。

### 一个我自己制造的路径 bug（记下来）

`openAudioSource` 收的是 `std::filesystem::path`，我却在中间插了一次 `toUtf8` 往返。
narrow string 构造 `path` 会按**活动 ANSI 代码页**解释字节 ——
于是整个中文库的路径变成一串乱码（盘符之后的中文目录名被按 ANSI 代码页逐字节错误解释）。

这正是 `util.hpp` 顶部注释警告的那件事，而我仍然踩了：**因为我在一个已经正确的 API 上多加了一次转换。**
修法是**不转换**。

---

## 0e. CR-010：`bitPerfect` 曾经误报（本轮新增，**已修**）

REFS-A2 §0 提出一个具体质疑：**「整数 PCM 源如果被转换到 Float32 管线再打包为整数输出，
不能标记为 outputPerfect=true」**，并问我们「24-bit 装进 32-bit 容器时会不会误报」。

**核实结果：会，而且这是一条我自己写在注释里、却没写进代码的规则。**

### 实测（本机端点）

```
--- 48k/24-bit 文件，独占 ---
mode=exclusive  src=24bit  container=32  valid=24
  修复前: bitPerfect=true        ← 误报
  修复后: bitPerfect=false  outputPerfect=false  pcmPassthrough=false
          reason="integer passthrough unavailable: 24-bit audio in a 32-bit
                  container (this endpoint refuses a 24-bit container)"
```

机制：候选格式**按容器由窄到宽**依次尝试，24-in-24 被本机端点拒绝，于是落到 24-in-32。
而我原来的 `isBitPerfect()` 里注释写着「更宽的容器不是位精确投递，因此不得如此宣称」，
**下一行却没有那个检查**——注释写了规则，代码没写。

### 但「float 管线」那半条，我核实后结论不同，而且理由是可测的

它说整数经过 float32 管线就不能算 perfect。**作为定义成立，但不是数值缺陷。我把它测了：**

```
twilight-engine.exe --selftest
  dither: error/signal correlation 0.1633 -> 0.0096
  全部 2^24 个 24-bit 整数经 int -> float32 -> int 往返后逐一精确相等
  灵敏度对照：超过 24 bit 的值往返会失败（float32 只有 24 位尾数）
```

对照那条是关键：**它证明这个测试能测出精度损失**，所以前一条不是空过的断言。
本引擎交付的整数确实与文件中的整数相同。

所以分工是：**容器那一条完全采纳**（它就是误报来源，已修）；
**float 管线按「数值是否改变」处理**（可测、测过、无损）。
若按定义就该判否，则需要一条**整数直通路径**（绕开 float 环）才能报 true——
那是真正的功能，不只是判定改动。**已请 owner 裁定走哪条**（CR-010 回复）。

### 三个字段已落地（CR-010 的字段名一字不差）

| 字段 | 回答的问题 | 本机实测 |
|---|---|---|
| `pcmPassthrough` | **格式**是否原样（容器 == 源精度） | **false** |
| `outputPerfect` | **链路**有没有改动样本 | false |
| `sourceExact` | **文件**是否无损且格式一致 | false |

`bitPerfect` 保留为 **`outputPerfect` 的字面别名**。

另加两个**让宣称可被核对**的字段：`containerBits` / `validBits`，以及 `outputNotPerfectReason`。
没有前两个，用户无法核对一个 bit-perfect 徽标——那是**承诺**不是**事实**。
理由串还会点明是**端点拒绝窄容器**（硬件约束）还是代码本可做得更好。

### 顺带：`sourceExact` 解决了本引擎此前无法表达的一件事

> **有损源可以 outputPerfect=true，而 sourceExact=false。**

MP3 解码后直通输出，旧模型只会报 `bitPerfect=false`——
**用户会读成「信号链有问题」，而真相是「源就是有损的，链路没问题」。**
本 build 的两种解码器（FLAC / WAV）都是无损，所以今天两者恒等；
但字段现在就分开表述，将来加有损解码器时不会是在压力下临时拆一个布尔。

### 一个我自己制造又抓出来的 bug（值得记）

我最初只把新逻辑给了 `outputPerfect`，`bitPerfect` 仍读输出层那个不含容器判断的检查 ——
于是**同一个 state 事件里两个字段互相矛盾**（`bitPerfect:true` 而 `outputPerfect:false`）。
**两个都声称是同义词却不等，比只有一个更糟。**

抓到它的是新步骤 `--step=bitperfect` 的第一条不变式。现在那条不变式是永久回归闸门。

### 验收

```
node engine\tools\drive.mjs --step=bitperfect   # 34 条断言，四字段一致性矩阵
node engine\tools\drive.mjs                     # 全套 288 条断言
```

矩阵覆盖 shared/exclusive/auto × 48k24 / 44.1k16 / 48k16，并直接断言
「容器比源精度宽 ⇒ pcmPassthrough=false」，而不只是依赖通用不变式。

### 本机总结（两条独立原因）

这台机器上 bit-perfect **不可达**：① 独占不触发缓冲区事件（CR-006）；
② 即使开流成功，24-bit 也只能进 32-bit 容器。**后者是端点能力，不是代码缺陷。**

---

## 0d. TPDF dither：把失真换成噪声

SPEC line 203 / 536：「输出位深低于源位深时 TPDF dither，bit-perfect 路径禁用」。
本轮补上。**这不是一个可选项**——它是 24-bit 母带经 16-bit 独占流时唯一能保住低电平细节的办法。

### 为什么必须做

把 24-bit 样本四舍五入到 16-bit，被丢弃的低位变成**量化误差**，
而那个误差是**信号的确定性函数**——它不是噪声，是**失真**：它跟着音乐走，
在安静段落听感上是一片颗粒感的、沙哑的衰减。

加入一个小的随机偏移再做舍入，就把这份失真换成了一层平稳的底噪。

**用 TPDF（三角）而不是 RPDF（矩形）**：矩形 dither 会留下被信号调制的误差**方差**，
听起来像随音乐起伏的呼吸噪声；三角分布是两个独立矩形之和，把这个调制去掉了。

### 实现要点

- `quantizeSample()` 是**唯一**把 float 变成整数的地方，渲染循环与离线测试共用它。
  测试若自己复制一份算术，就只能证明副本和它自己一致。
- 两条规则**由同一次深度比较导出**（`ditherApplies`）：
  bit-perfect 要求 `源位深 ≤ 输出位深`，dither 要求 `源位深 > 输出位深`——**恰好一条成立**。
  自测里对 16/24/32 的每个组合穷举断言了这一点。
- **float32 算 24 bit**（尾数 24 位）：这正是 24-bit 源经 float32 共享流无损、
  因此**不该**加 dither 的原因。把它当 32 会让 16-bit 流对着一个它其实精确复现的源去加噪声。
- **每声道独立 RNG**：两个声道用同一份 dither 是**相关的（单声道）噪声**，
  会定位在声场中央，听起来像一声轻微的口哨，而不是良性的嘶嘶声。

### 验收（离线，不需要音频硬件）

衡量的是**误差与信号的相关性**，而不是「有没有噪声」——两条路都有误差。

```
twilight-engine.exe --selftest
  dither: error/signal correlation 0.1633 -> 0.0096 (lower is better)
```

**降低约 17 倍。** 阈值只要求 <0.02，实际到 0.0096，所以它证明的是一个真实效应而非勉强通过。

### 顺带修掉的一个「偶然正确」

`sourceBits`（源位深）过去**只在独占模式**被写入，共享模式恒为 0。
于是共享模式下「不做 dither」是对一个**从未被提出的问题**的回答——
对 float32 混音格式恰好正确，但靠的是运气不是推理，
而一旦共享模式下出现需要 dither 的整数流，它就会静默地不加。已改为两种模式都传源位深。

---

## 0c. DESIGN-A：界面系统的引擎侧要求

DESIGN-A 的核心是一句话：**C2 那条六段信号路径不是界面自己画的图，是我上报字段的可视化。**
**我少报一个字段，界面就会画出一条假的线。**

它给了 5 条验收（A1–A5）。逐条走完，**查出 7 个问题，其中 3 个是我在撒谎**——只是没人说出来。

### 我确实在撒谎的地方

**1. `capabilities.dsp` 报的是 false，而 DSP 上一轮就做完了。**
DESIGN-A §5 说「界面只画引擎声明支持的东西」。所以这个 false 让**整条 DSP 段从信号路径上消失**——
功能做了，界面永远不显示。**低估自己和虚报一样是撒谎**，只是方向相反。

**2. 蓝牙端点静默走共享。**
SPEC P4 说蓝牙链路必然重编码、只能共享。我确实走了共享，但**没设 `degradeReason`**——
于是界面看到「resampled=false、degradeReason=null」，画出一条**干净的实线**，
而真相是这条路径根本不可能 HiFi。DESIGN-A §2 把这种后果说得很直白：**界面在撒谎，而且是我让它撒的。**

**3. xrun 导致缓冲上调时什么都没说。**
只发了一条 `log` 事件了事。用户听到的那次音频中断，在界面上看起来什么也没发生。

### 反向的错：我也虚报过

选定独占模式而**尚未开曲**时，我原来会设 `degradeReason`（"no track open yet..."）。
但那不是降级——此刻连信号路径都还不存在，这是再普通不过的先后顺序。
结果是界面会为一次普通操作画虚线。DESIGN-A §2.2 明文禁止这种虚报，**已删除**。

> 这条最值得记：**「报全」和「不虚报」是同一条纪律的两面。**
> 我原来只盯着「别忘了报降级」，却忘了「不是降级就别报」。

### 补上的协议缺口

- **`state.dspActive` / `state.dspModules`**（CR-009）：C2 的 DSP 段靠它画。
  > 我在 CR-008 里判断错了：当时把 DSP 信息只放进 `get_state`，理由是「状态事件每秒发 10 次，而它只在用户操作时变」。
  > **这个理由在 C2 面前不成立**——界面不是按需查询，是跟着事件流重绘的。已改正。
- **`ev: 'xrun'` 事件此前根本不存在**：AI-B 的 `protocol.ts` 早就声明了 `{ev:'xrun',count,bufferMs}`，
  而我**从来没有发过**。C1 的闪烁和 C2 的抖动标记一直**没有触发源**。现已发出（由控制线程，RT 线程不许写 stdout）。
- **`state.xrunCount` 改为会话累计**：DESIGN-A §4.1 点出最坏的一种语义——
  缓冲自适应会重开流，若在那里归零，用户会在 underrun 正发生时看到数字回到 0，**像故障自己好了**。
- **`error.kind`** 区分两种 `ERR_UNSUPPORTED`（没实现 / 硬件不支持）。
  **没有拆错误码**：CONTRACT §3.1 冻结了「恰好六个」，拆码是契约级改动，不该我单方面做。

### 一处发现：状态事件不会因 DSP 变化而重发

`tick()` 只周期性发 `position`，`state` 事件只在显式 `emitState()` 时发。
所以改 EQ 之后**界面永远不会知道** `dspActive` 变了——除非恰好有别的原因触发状态事件。
已让每个 DSP setter 结尾发一次状态事件（`set_volume` 一直就是这么做的，因为它影响 bit-perfect）。

### 交付物

**`engine/fixtures/state-traces.json`** —— DESIGN-A §8 说的**唯一跨目录交接物**。
真实事件序列，**含一次真实降级**（本机独占静音看门狗回退，附可读原因）。
特意让它包含降级：一份干净的 trace 会让「从不画降级路径」的界面**拿真实数据通过自己的测试**。

### 验收

```
node engine\tools\drive.mjs --step=honesty --export-trace   # A1–A5，20 条断言
node engine\tools\drive.mjs                                 # 全套 256 条断言
```

---

## 0a. M2 音频质量链：10 段 EQ、ReplayGain、限幅

SPEC §1.1 把 EQ 与 ReplayGain 和 bit-perfect 并列为「唯一不可替代的差异」，M2 的 L2 是 Must。
本轮做完了，**236 条断言全绿**。

### 实现

- **`engine/src/dsp.{hpp,cpp}`**（约 450 行）：10 段 RBJ peaking EQ、ReplayGain、
  前馈限幅、永远生效的安全钳位。参数全部来自 SPEC §3.4：
  频段 31.25/62.5/125/250/500/1k/2k/4k/8k/16k，Q 默认 1.41（0.5–4），增益 ±12 dB/0.5 步进，
  系数 ≈20 ms **逐样本线性插值**，旁路 30 ms 交叉淡变。
- **无锁参数交接（seqlock）**：控制线程发布整份快照，渲染线程在每个音频块边界读取。
  整份快照而不是逐字段，是为了让「改了 3 段」永远不会被观察成「只改了一半」。
  读取有**重试次数上限**——RT 线程宁可留用旧参数，也不能自旋等一个可能已被抢占的控制线程。
- **零分配**：链上唯一一次分配在 `prepare()`（控制线程、渲染线程启动前）。
  音频回调里没有 new/malloc/lock/log，符合 SPEC §3.2。
- **两条新命令**：`set_eq`（局部更新）与 `set_replaygain`，`get_state.data.dsp` 可读全量。
  已提 **CR-008** 请 owner 裁定字段名（沿用 CR-002 先例：先实现、标明待裁）。

### 两个必须记住的设计点

**1. `state.bitPerfect` 在 DSP 生效时必须是 false。**
SPEC §1.1 说 bit-perfect 是「存储的整数原样到达设备」。一旦经过 EQ 或任何增益，
那就不再是存储的整数——不管听起来多好。链自己上报 `passthrough`，
只有 `appliedGainDb` 归零且 `passthrough` 为真时才可能报 bit-perfect。
`--step=dsp` 把这条当断言钉住了，包括**恢复设置后徽标要能回来**
（否则一个开关就把标志永久锁死在 false）。

**2. 安全钳位在旁路之外，永远执行。**
参考实现（QueMusic，Apache-2.0）的旁路会连硬裁剪一起跳过，
于是**关掉 DSP 反而可能有超过 1.0 的样本到达设备**。这是它最危险的坑，已按相反做法实现，
并在 `--selftest` 里钉成回归测试。对已在范围内的样本，钳位是位精确的恒等操作，
所以它一分钱保真度都不花。

### 验收（三层，都不需要音频硬件）

```
twilight-engine.exe --selftest      # 黄金测试：10 段 × ±12 dB 频响，容差 ±0.1 dB（SPEC 447 要求）
drive.mjs --step=dsp                # 协议、量程拒绝、bit-perfect 诚实性、DSP 生效后仍出声
drive.mjs                           # 全套 236 断言
```

频响测试用**精确频点正弦**测增益，而不是「输出有没有变化」——
后者对 a1 符号写错这类 bug 完全不敏感，而前者立刻显示中心频率偏移。
探针幅度故意取 -20 dBFS：满幅信号 +12 dB 会撞上安全钳位，
那样测到的是钳位不是滤波器（**第一版就踩了这个，10 段全部报 2.5 dB**）。

---

## 0. 按 docs/REFS-A-engine.md 审自己代码，查出 3 个真 bug

REFS-A 是 owner 给的外部参考清单（QueMusic Apache-2.0 可抄代码 / ECHO AGPL 只学模式）。
**它的价值不在于「有什么可抄」，而在于它列的坑让我去查自己的代码，一查就有。**
下面三条都是**引擎已经「通过验收」之后**才查出来的，且前两条影响每一首曲子。

### 3.1 尾部被截掉一整段（最严重）

§E3.3 明确区分 `inputEnded`（解码器没数据了）与 `isDrained`（设备真的播完了）。
我的判断条件里没有第二个：用**渲染线程从环里取走的帧数**当「播完」。

> 取走 ≠ 听到。环一空，端点缓冲区里还有**最多一个设备周期**的音频没播。

`handleTrackFinished()` 紧接着就 `stop()` 开流，那一段直接丢掉——**每一首，静默地**。
手动听是听不出来的（10ms 的尾巴），但它是每次都错。

修法试了两次才对，两次错法都记在注释里免得后人再走：

| 做法 | 结果 |
|---|---|
| `IAudioClock::GetPosition` 当基准 | ❌ 该时钟是**按流**的，seek 后归零，而设备缓冲里还有 seek 前的音频 → 报 61ms 缺口、卡死判断 |
| 在外部轮询 `padding == 0` | ❌ **永远不会为 0**：环一空，渲染循环立刻用**静音**回填。只有回调迟到的异常情况才会到 0 |
| 渲染线程内算 `已交出帧 − 当前 padding` | ✅ 两个数在同一时刻、同一线程取得，精确 |

修好后 `--step=completion` 短差 **0 ms**（此前 41~61 ms 抖动），且长曲尾部位置能跑到真实总长。

### 3.2 环重建时两个音频线程还在跑（潜在堆损坏）

§6.2 让我确认「环形缓冲区重建时消费者是否真的停住了」。**没有。**

`ring_.configure()` 内部是 `data_.assign()`，**会重新分配**。而我原来的顺序是：
先 `configure()`，再 `stopFeeder()` / `output_.stop()`。

> 也就是说重新分配那一刻，生产者线程可能正往里写、渲染线程可能正从里读——
> 两边都可能拿着**已释放内存**的指针。

**它从没在这套库上炸过，因为 91 首全是立体声**，`channels()` 没变过这个分支就不进。
等于一颗等着**第一个非立体声文件**（或换声道数的设备）触发的雷。已改成先停两个线程再重建。

### 3.3 每首曲子结尾都被记 3 次 xrun（连带把播放卡成 paused）

查 3.1 时顺带暴露：解码器送完后环必然短暂为空，渲染线程把这当成 underrun，
于是**每首歌结束都报 3 个 xrun** → 触发 SPEC §3.2「连续 3 次 xrun 就把缓冲翻倍」→
重开流；而重开路径会先 pause 再释放设备，**没人把播放态恢复回来** → 音乐停下。

两处都修了：解码器送完就置 `feederDone`，此后短块是**正常收尾不是故障**；
重开路径显式恢复 `Playing`（和独占看门狗那次是同一类错误——**这个项目已经栽在同一个坑里两次**）。

### 3.4 §8 清单其余项的结论

- **可抄的**（QueMusic Apache-2.0，抄要留版权声明）：§1.2 处理链顺序、§1.5 两个 ReplayGain 公式、
  §1.4 两个反直觉坑（旁路会连硬裁剪一起跳过；关限幅 ≠ 不裁剪）。这些归入 M2 其余项。
- **不抄的**：§1.3 参数表以 SPEC §3.5 为准（我的更保守更细）；§1.1「零分配重载」的思路值得学，
  但对 EQ 目前还不是瓶颈。
- **ECHO 只学模式**（AGPL 传染）：§E3.3 的状态区分就是这次用上的那个。

---

## 0b. M2 进展：WASAPI 独占 + bit-perfect

SPEC §1.1 说「音频质量高于 Folia」是**唯一不可替代的差异**，这件事本轮做出来了。

### 已实现

- **独占模式**：`set_output {mode: exclusive|shared|auto}`，在**源采样率与位深**上开流，
  信号链里没有系统混音器。这是 bit-perfect 的定义。
- **能力探测**（SPEC §3.3）：`hello` / `list_devices` 会回报该端点**实测**接受的独占格式，
  `ready.devices[].exclusiveFormats`，例如本机是 `["48000:16", "48000:24"]`。
- **降级链与明示**（SPEC §3.3 / CONTRACT §3.4）：独占失败 → 共享，且**不返回 ok:false**，
  用 `state.outputMode` + `state.bitPerfect` + `state.degradeReason` 表达。
- **bit-perfect 判定**是严格且诚实的：独占 + 源采样率 + 无重采样 + 无增益，缺一不可。
  音量一旦低于 1.0 就立刻变成 `bitPerfect:false`（增益不是「原样」）。

### 本机实测结论（这条比代码更重要）

```
端点：扬声器 (Audio Device)，混音格式 2ch @ 48000Hz float32
独占实测支持：48000:16, 48000:24
```

- 该端点**只接受 48 kHz 独占**。44.1 kHz 与 96 kHz 的独占请求被驱动直接拒绝。
  因此本库 **74 首 44.1k + 6 首 96k = 80 首，在这台机器上无论如何都不可能 bit-perfect**；
  能谈 bit-perfect 的只有那 **11 首 48 kHz**。
- 更关键：**这 11 首的独占流能开起来、能报 bitPerfect:true，但驱动不给缓冲区事件——
  一个采样都不出声。** 引擎为此加了看门狗（见下），如实降级回共享并说明原因。

> 结论要写清楚：**在这台机器 + 这个驱动上，独占模式目前无法真正出声。**
> 引擎能正确协商、正确判定、正确降级，但「听到 HiFi」还差一个能跑独占的驱动/端点。
> 这不是引擎的 bug——共享模式 91/91 首正常，独占路径已按规范实现并通过验收。

### 新增的两道保险

1. **独占静音看门狗**（本轮最重要的一个设计决定）
   独占流「开得起来、报 bit-perfect、却一个采样都不出」是**最危险的失败**：
   协议层所有信号都说成功，用户只是听不到声音。
   引擎在开流后 400ms 内若无任何帧被渲染，就判定该独占流不可用，
   自动回退到共享并从原位置继续播放，同时发 `log` 事件与 `degradeReason` 说明。
2. **`renderStarved`**（state 事件新增字段）：非零表示渲染线程活着但设备从不触发缓冲区事件。
   没有它，「静音的独占流」与「正常播放」在协议层完全无法区分。

### 验收

```
node engine\tools\drive.mjs --step=exclusive    # 26 条断言
```
覆盖：能力探测、独占协商、源采样率、bit-perfect 判定、音量破坏 bit-perfect、
看门狗降级后仍在播放、auto 语义、未知 mode 拒绝。

---

## 1. 状态总览

> ⚠️ 本轮我把 `drive.mjs` 截断过一次（无 git、无备份），已重建并验证。
> 原因与规则见 §4b——**改文件一律优先用 `edit`，不要整文件覆盖**。

M1 的**引擎侧**已经跑通，用真实 91 首 FLAC 验证：

| M1 判据（BRIEF-A 5） | 状态 | 怎么验的 |
|---|---|---|
| 空引擎跑通 | OK | `node engine/tools/drive.mjs --step=hello` |
| scan 拿到 91 首 | OK | `--step=scan`，`scan_done` 报 `added:91 failed:0` |
| **放出声** | OK | `--step=library`：**91/91 首**都 open→play→位置真实推进 |
| 六个控制命令 | OK | `--step=playback`：play/pause/stop/next/prev/seek + set_volume |
| stdout 干净 | OK | 每个步骤都断言「每一行都能 JSON.parse」 |
| 退出无残留 | OK | `--step=lifecycle`：shutdown 与 stdin 关闭两条路径 |

```
node engine\tools\drive.mjs            # 462 条断言，全绿（22 个步骤）
> 这不是不稳定 —— 是那个步骤拒绝假装测过它测不了的东西。
> 这不是不稳定 —— 是那个步骤拒绝假装测过它测不了的东西。
node ... --selftest                     # 另有离线黄金测试：10 段频响 ±0.1 dB、dither 相关性、2^24 全量往返
```

M1 的四步（BRIEF-A 4）全部完成，另加两件 brief 里没写但**不做就不成立**的事（见 3.1 重采样、3.2 流式解码）。

### 1.1 SPEC 8.2 性能预算：**实测值**（不再是设计推导）

跑 `--step=latency` 实测，每一项都在真实播放中量：

| SPEC 8.2 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 启动到发声（本地文件） | < 1000 ms | **152 ms** | 通过 |
| Seek 响应（声回） | < 150 ms | **32 ms** | 通过 |
| 引擎进程 RSS（播放中） | ≤ 60 MB | **16–19 MB，与文件大小无关** | 通过（见 §0p） |
| 音频稳定性（xrun） | 0 | **0** | 通过 |

> 这几项之前是「按设计推导」的，现在是真的量过了。启动到发声的 152 ms 里有 135 ms 是**播放开始后设备第一个周期**，
> 也就是说引擎自身的准备开销只有约 17 ms。
>
> ⚠️ **RSS 那一行曾经是 51.4 MB，而那个数字只对「恰好被量到的那一首」成立** ——
> §0p 查出整文件读入让它在 46.5 MB 的曲子上冲到 75 MB，**超过预算**。
> 改成文件句柄后它与文件大小无关，对**整库**成立。**一条只在样本上成立的验收，比没有更糟。**

### 1.2 能力状态：把「做了」和「验过」分开（照 REFS-A2 §1.1 的三维模型）

> **没有真实设备证据的，一律标 `unverified`** —— 既不能因为缺设备就当成失败，
> 也**不能由设备名猜成可用**。「代码编译进去了」只说明有这个受控维度，
> **不替代真机证据**。

| 能力 | 代码/构建 | 运行时可观测 | **真机证据** |
|---|---|---|---|
| WASAPI 共享 | available | available | **verified** —— `--step=library` 91/91 首真实出声 |
| WASAPI 独占 | available | available | **verified，但只限特定端点** —— NICEHCK USB DAC 上真出声；**内置 Intel SST + Conexant 端点实测不可用**（驱动不发缓冲区事件，看门狗如实降级） |
| bit-perfect（容器 == 源精度） | available | available | **verified** —— DAC，44100 Hz/24-bit，容器 24，`--step=exclusive` |
| SoXR 重采样 | available | available | **verified** —— 44.1k 源播到 48k 设备，位置推进正确、xrun 0 |
| DSP 链（EQ / RG / 声道工具 / 限幅 / dither） | available | available | **verified（离线）** —— `--selftest` 黄金测试；**真机听感 unverified** |
| EBU R128 响度扫描 | available | available | **verified** —— -23 dBFS 校准信号实测 -22.9933 LUFS |
| 设备热插拔（`device_changed`） | available | available | **verified** —— 真机切换默认输出，位置连续、一次一条事件 |
| 流失效检测（`serviceRenderLiveness`） | available | available | **正例 unverified** —— 30 分钟压测抓到过真实停顿，但两次尝试都造不出停顿（争用被拒、CPU 压力无 xrun）；见 §0r |
| SPEC §9「30 min 独占最小缓冲 = 0 xrun」 | —— | —— | **未通过（第三次压测进行中）** —— 前两次各 3 次 xrun 并停顿；根因已定位并修（§0s），验证待第三次压测 |
| MP3 解码 | available | available | **verified** —— 真 320 kbps CBR MP3：播放、seek、自然播完；见 §0l |
| AAC（MP4 / M4A）解码 | available | available | **verified** —— MF 编码器造出的真 AAC：打开、播放、位置推进；见 §0m |
| ALAC（MP4 / M4A）解码 | available | available | **verified** —— 独占下 `outputPerfect=true` 且 `sourceExact=true`；同一链路下 AAC 是 `sourceExact=false`，见 §0m |
| **Gapless** | **not-built** | —— | unverified |
| **DSD / DoP 直通** | **not-built** | —— | unverified（本机无 DSD DAC） |
| **SMTC（系统媒体控制）** | **not-built** | —— | unverified |

这张表存在的理由：我这一路反复在同一类错误上翻车 —— **「做了」被读成「验过了」**。
独占是这样（代码能跑 ≠ 这个端点能出声），格式也是这样（断言全绿 ≠ 格式都支持）。

---

## 2. 各步骤实际做到什么

### 第 0 步 · 空引擎
`hello` / `list_devices` / `shutdown` 三条命令，`ready` 是 stdout 第一条。
`--selftest` 用 9 组断言把 JSON 编解码钉死（含组合字符、连续空格、代理对、非法输入拒绝）。

### 第 1 步 · `scan`
TagLib 读标签，`tl_0001` 起顺序分配 trackId，`scan_progress` 逐首上报，结束回 `tracks` 数组并发 `scan_done`。
91 首的**每一条路径都与 Node 读到的磁盘路径逐字节相同**（不是抽查三个陷阱样本，是全量集合比对）。

### 第 2 步 · `open` / `play` / `pause` / `stop` / `seek` / `set_volume`
WASAPI **共享模式**（独占是 M2）。三线程模型按 SPEC 3.2 落实：
渲染线程（wasapi 事件回调）/ 控制线程（命令与状态机）/ 喂料线程（解码 + 重采样）。
`state` 事件是权威值，共享模式一律 `outputMode:"shared"` + `bitPerfect:false`。

### 第 3 步 · `next` / `prev` / 队列
`set_queue` 设定队列，`next`/`prev` 会**真的装载并继续播放**（不是只回一个 id）。
播完发 `{"ev":"ended","reason":"eof"}` 并自动续播下一首；`set_repeat` 支持 sequential/one/all/shuffle。

### 第 4 步 · fixture
`engine/fixtures/library-91.json` —— 91 首真实元数据，AI-B 的 UI 数据源。
用 `node engine\tools\drive.mjs --step=scan --export-fixture` 随时重新生成。

---

## 3. 越出 brief 字面、但不做就不成立的两件事

### 3.1 重采样（SoXR）—— **不做就只有 11 首能出声**
brief 只在共享模式里说「先放出声」。但实测本机音频设备混音格式是 **48000Hz / 2ch / float32**，
而测试库是 **74 首 44.1k + 11 首 48k + 6 首 96k**：

- 不做重采样 → **80 首打不开**（引擎会如实回 `ERR_DECODE` 并说明原因，不会静音假成功）
- 所以按 SPEC 3.4 的选型引入 **SoXR 0.1.3**（LGPL-2.1，与 SPEC 2.6 组件表一致）

同采样率时**完全不创建转换器**（SPEC 3.4：「同率时跳过」），只有不同率才走 SoXR。

### 3.2 流式解码，而不是「整首解进内存」
原计划整首解码。实测：96k/24bit 的一首约 **178MB** float32，本库最长一首约 **172MB**；
整首解码 + 重采样副本会冲到约 360MB，直接顶穿 SPEC 8.2 的**引擎 ≤60MB RSS** 目标。

改为**喂料线程按块解码 + 按块重采样**（每次约 46ms 输入），内存与曲长无关。
代价是 `seek` 要让喂料线程重定位——已在 `--step=playback` 里断言。

---

## 4. 踩过的坑（都会再咬人，按严重程度排）

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 61 | **在同一份文件上连着改两处时用了过期的行号** | 第一次 `edit` 让文件短了 4 行，第二次仍按**改动前**的行号读区间 → 读到的是**错位**内容，替换掉的是另一段；`## 7. 交付物` 标题和 `---` 分隔符被一并吃掉，§6 顶部还留下四条已过期的旧条目 | **一次编辑之后，之前的所有行号全部作废**：要么重新读，要么用**内容锚点**（唯一字符串）定位；改完必须**回读确认**这一段 |
| 73 | **用调用方给的字符串当身份** | `scan` 拿目录字符串当曲目身份 → 同一目录正/反斜杠两种写法就是两个曲库：91 首变 182 首、**182 个互不相同的 id**，按 trackId 去重完全抓不到 | 身份必须是**归一后的键**；归一规则两侧要**复刻**而不是各自发明 —— 各有一套的话，新的不一致比原来那个重复更难查（CR-013 裁定原话） |
| 72 | **复用 id 让「已处理」看起来成立了** | `findByPath` 命中后**仍然 `push_back`** → 同一首歌在 catalog 里两条、共用一个 id。复用了 id 让人以为重复已被处理，实际上数量是错的、`findById` 返回先来的那条 | 「找到了」和「处理了」是两件事：跳过要**真的跳过**（`continue`）。同族：只把一半逻辑写对，让结果**看起来**合理 |
| 70 | **诊断工具自己坏了，而文档把它的话当成了硬件事实** | `--probe-exclusive` 用共享模式的判据 `padding < bufferFrames` 去驱动**独占周期流**（padding 恒等于整缓冲）→ 它一次都没喂过缓冲区，设备要不到数据就不再发事件 → 稳定复现的 `1/12`，被写成「这个端点不实现独占渲染」，并在文档里挂了很久。**同一份代码在引擎里早修过（#46），探针没拿到修复** | 修 pump（每次唤醒写整块）；**把 `padding / buffer` 打进报告** —— 关键中间量不打印，就会把「我喂错了」显示成「硬件坏了」。**凡是「某硬件不支持」的结论，都要能回答：用什么量的、那个量具自己验过吗** |
| 71 | **断言用错字段回答了另一个问题** | `honesty` A1 拿 `degradeReason` 去问「为什么不是 bit-perfect」。`degradeReason` 的意思是**请求的模式被放弃**；「24-bit 装进 32-bit 容器」不是降级（音频一样，只是打包不同，CR-010 已裁定），所以它理应为空。引擎给的原因是对的，断言问错了字段 —— 而它此前一直通过，只因为**这台机器恰好有一台接受窄容器的 DAC** | 问 A 就用回答 A 的字段（`outputNotPerfectReason`）。**一条只在某台硬件上通过的断言，测的是那台硬件** |
| 69 | **自己写的新逻辑被同一函数里更晚的一句赋值覆盖** | metadata 里把 MP4 codec 判定插进音频属性块，而函数**末尾**还有一句 `out.codec = codecFromExtension(file)` → 目录**仍然**把 ALAC 报成 AAC，看起来像判定本身写错了 | 往一条已有的赋值链里插新逻辑，先确认**后面没有更晚的赋值**。这类错最难查，因为错的地方看起来是对的 |
| 68 | **同一个 codec，MF 用两种 GUID 形状命名** | AAC 文件报 WAVE 式 `{00001610-…}`，ALAC 文件报 MP4 采样描述式 `{616C6163-767A-494D-…}`（Data1 是大端四字符 `alac`）。只比对一种 → **真正的无损文件被报成有损**，而那是唯一不能出错的方向 | 两种拼法都认；**未知 codec 一律判有损**（反过来会承诺一件收不回的事） |
| 67 | **把代码页字节当 UTF-8 解码 → 抛异常 → 静默 fail-fast** | Windows 的 `argv` 在活动 ANSI 代码页里，中文路径到程序里已是坏字节；喂给 `fromUtf8()` 让 `std::filesystem::path` 抛异常，无人接住 → 退出码 `0xC0000409` 且**零输出** | 命令行路径向 Windows 要真 UTF-16（`CommandLineToArgvW`），转换包进 `try`。**会在坏参数上静默死掉的诊断，比明确拒绝它的更糟** |
| 66 | **库认不出的形状 ≠ 文件没有那个事实** | TagLib 的 `MP4::Properties::codec()` 只在采样描述原子**正好 88 字节**时认出 ALAC，而 MF 写的是 **72 字节** → 枚举报 `Unknown`，而文件里明明写着 `alac` | 用 `codecId()`（返回原子里的四字符码，**文件自己说的**），不要拿「库认识的形状」代表事实 |
| 65 | **测试量的是全机，却把结果当成关于自己的证据** | `lifecycle` 的「无残留进程」用 `tasklist` 按**镜像名**统计全机的 `twilight-engine.exe`。而应用 spawn 的是**同一个 exe**（`app/src/main/engine-host.ts:60` 默认探测 `engine/bin/twilight-engine.exe`）→ B 侧一跑 Electron 测试，我这边就报「残留 1 个」。**更糟的是反方向**：真正的泄漏可以躲在邻居的健康进程后面 | 断言**自己 spawn 的**子进程（跟踪 `EngineClient` 的存活集合 + 自己的 pid）；全机扫描降级为 `warn`，只报不断言。**问「我留下东西了吗」，不要去数别人的东西** |
| 64 | **在模板字符串里生成代码时用反斜杠转义引号** | 我写 `'the decoder\'s duration...'`，而生成器本身就是模板字符串 —— `\'` 到文件里只剩 `'`，单引号字符串当场截断 → `drive.mjs` 直接 SyntaxError | **不要靠转义**：换不含引号的措辞，或用双引号字符串。与 #61 同类：**生成器的规则会咬生成结果** |
| 63 | **dr_mp3 只在有 Xing/Info 头时才知道长度** | `drmp3_init_memory` 之后 `totalPCMFrameCount` 仍是 `DRMP3_UINT64_MAX`（普通 CBR 就是这样）。它不在 init 里数是因为那是 O(文件) 的 | 付这个代价：`drmp3_get_pcm_frame_count()`，实测 open 47 ms。**不能猜** —— 这个数是结束判定的基准，猜小了截尾、猜大了永远播不完 |
| 62 | **把「含延迟与填充的帧数」当成曲长** | dr_mp3 文档明写 *"Includes delay and padding"*，而读取端会跳过开头延迟、在填充处截断 → 时长长 25 ms，**而且尾永远到不了，曲子停在 99%** | 交付出去的是可听的那段：`total - delayInPCMFrames - paddingInPCMFrames` |
| 1 | **dr_libs 保存 pUserData 原样复用** | 把栈上 MemoryReader 的地址交给 drflac_open，函数返回后解码读到悬空指针 → **play 时必崩 0xC0000005**，且崩溃地址每次都不同（甚至 0x0） | 让 source 对象**先持有 bytes 和 reader**，再在对象内部打开解码器。见 audio_source.cpp 顶部注释 |
| 2 | **同步管道句柄永远是 signalled** | 用 WaitForSingleObject(stdin) 判「对端关闭」，结果**引擎一启动就立刻退出** | 用专门的读线程阻塞在 ReadFile + condition_variable。见 io.hpp 顶部注释 |
| 3 | **durationMs 除以了设备采样率** | 44.1k 曲目在 48k 设备上时长**短了 44100/48000**（5 分钟的歌少 25 秒） | 时长 = **源**帧数 ÷ **源**采样率。player.cpp 有注释 |
| 4 | **seek 后 end-of-stream 再也到不了** | 喂料计数是「累计消耗」，seek 后仍大于曲长 → ended 永不触发，队列自动续播失效 | seek 时把计数**重置为 seek 目标帧**。这一条正是 `--step=queue` 抓出来的 |
| 5 | CMake 装在很深的 winget 路径 | Ninja 报 Filename longer than 260 characters，拒绝构建 | 默认改用 **Visual Studio 17 2022 生成器**；`-Generator Ninja` 保留 |
| 6 | TagLib 2.3+ 硬依赖 utfcpp | utfcpp not found，而 release tar 里没有（是 git submodule） | fetch-deps.ps1 一并拉 utfcpp，CMake 把路径喂给 TagLib 自己的 find_path |
| 7 | TagLib 的 in-tree 头文件布局 | tfile.h / tpropertymap.h 找不到（TagLib 只在目录作用域设 include） | 把各子目录与 taglib/ 都加进 include path，源码用**扁平头名**（与安装布局一致） |
| 8 | functiondiscoverykeys_devpkey.h | 需要 INITGUID 才能定义符号，否则一片未声明 | 自建 win_props.hpp 只声明用到的那两个 PROPERTYKEY |
| 9 | SoXR 的 CMakeLists 用 CMAKE_SOURCE_DIR | 作为子工程时它指向 engine/ → SetSystemProcessor 找不到 | CMake 侧把 soxr/cmake/Modules 提前加入 CMAKE_MODULE_PATH（不改第三方文件） |
| 10 | SoXR / TagLib 的 cmake_minimum_required 太老 | CMake 4.x 直接拒绝 <3.5 | 设 CMAKE_POLICY_VERSION_MINIMUM=3.5（不改第三方文件） |
| 11 | `$PSScriptRoot` 在 param() 默认值里不一定有值 | 脚本找不到自己的目录 | 在函数体里用 `$MyInvocation.MyCommand.Path` 解析 |
| 12 | **scan 期间静默吞掉命令** | scan 的进度回调里读一行 stdin 却**扔掉**，于是 scan 期间发的 `get_state` 既没回复、命令也没了（应用会一直等）。是**写自测脚本验证**才发现的 | 改成本轮**延迟处理**：存进 `pendingCommands_`，控制循环按到达顺序补处理。`--step=concurrency` 现在钉住这条 |
| 13 | **xrun 计数按帧累加** | 一个 480 帧的空块 +了 480 次，报出 `xrunCount: 1440`。而 SPEC 8.2 的预算是「0 xrun」——一个数字若是每帧加的，它就不是 xrun 计数 | 改成**每个饿死的块计 1 次**；启动/seek 后的预热期不算（否则每次 play 都像出故障）。现在稳定报 0 |
| 14 | **position 混用两个时钟** | `seekBaseFrame_` 是**源**帧、`framesRendered_` 是**设备**帧，却相加后除以一个采样率。重采样时比值是 44100/48000 → 进度条**慢约 8%**，5 分钟的歌到结尾还差 25 秒 | 先把设备帧换算回源帧再相加。`--step=completion` 用「末尾 20 秒自然播完」钉住：修复前缺口 6642 ms，修复后 51 ms |
| 15 | **自然播完不发 state 事件** | 曲目自然结束时引擎内部停了，但没有 `state` 事件，而契约说 state 事件是权威值、UI 不得自行推断 → UI 会一直显示 playing | 自然结束也发 `state:stopped`，且在 `ended` **之前**发 |
| 16 | **自适应缓冲是个死标志位** | SPEC 3.2 要求「连续 3 次 xrun → 缓冲 ×2（上限 50ms）」。渲染线程设了标志，但**没人消费**——原来它是个 no-op | 控制线程在 `tick()` 里消费并重开流；重开时按**源帧**保住播放位置 |
| 58 | **规范要求有、而我一直没有** | SPEC §3.7 要求「手动切歌 5 ms 淡出防爆音」，而切歌一直是**直接切断波形**；CONTRACT 定义了 `device_changed`，引擎**从未发出过**。两项都在全套断言全绿的情况下缺席 | 规范条目要**逐条对账**，不能靠「测试全绿」推断已实现；测试只证明被测的东西对 |
| 59 | **`streamLost` 判漏一半失效条件** | 只判「当前设备被移除」，没判「默认移动到别处」——后者同样让流失效，因为用户既然选了别的输出，引擎继续往旧设备放就是无视他 | 失效条件要**穷举**：设备没了、以及用户换了目标，是两件事 |
| 60 | **只跟了三个角色中的一个，却按三个都设了默认** | 事件里命名的是「正在离开」的设备而非「移动到」的，因为**第一条通知来自一个引擎不跟的角色** | 回调过滤与触发端必须对**同一个**角色；一次用户动作 = 一条事件 |
| 55 | **一个控件被另一个不相关的开关关掉** | 声道工具跑在 EQ 的 wet 路径上，而 `wetMix_` 由 `eqEnabled` 驱动 → **关掉 EQ 会静默禁用 balance / mono / width / swap / trim**。控件看起来完全没反应 | 「是否需要走 wet 路径」必须由**所有**相关功能共同决定，不能由其中一个代表 |
| 56 | **`queueIndex` 用 `size_t` 表示不了「不在队列里」** | 双击队列外的曲子后，索引仍留着上一首的位置 → **UI 高亮错误的行**。类型选错导致一个真实状态无法表达 | 改 `int`，-1 = 不是队列成员；打开时**先重置再查找** |
| 57 | **测试断言方向写反 / 输入过激** | balance 的断言与文档约定相反（**代码对、测试错**）；width 测试用 0.8/0.2，width=2 时左声道到 1.1 被安全钳位截断，于是「和守恒」失败得毫无道理 | **测试错了和代码错了一样有害，一旦被信任**；每个断言都要能说出它证伪什么 |
| 52 | **把「文件开着吗」推断成「缓冲区空吗」** | 缓冲区是每次调用的局部变量，返回即清空 → 每片都以为没文件打开、**重新打开同一解码器**，与其自身状态打架，在解码器里访问违例（RVA 0x1DA90） | 「文件是否打开」必须显式记录，不能从别的东西的存在性推断 |
| 53 | **临时缓冲区放在每次调用的局部** | 即使加了显式标志，缓冲区仍每片重建 → 每片都把进度丢一次：**前进 8 个 chunk 再丢掉，永不完成** | 缓冲区随**文件**存活：在开文件时分配、跨片复用 |
| 54 | **进度事件按切片发** | 全库一次扫描发出 **26,558 条**事件，比扫描本身的产出还多，应用得反过来限流 | 按人类节奏节流（250 ms），并附带 chunk 计数让进度条平滑 |
| 50 | **诊断只会指回自己的 exe** | 崩溃报告只打印 exe 基址并让人自己减；第一次用就发现崩溃地址离它约 2.8 GB，减出来是无意义 RVA。**会悄悄指错方向的诊断比不诊断更糟** | 用 `GetModuleHandleExA(FROM_ADDRESS)` 解析**出错模块**，只在自己模块时给 RVA；一次就查出是 `AUDIOSES.DLL+0x4016E` |
| 51 | **退出时设备还开着** | `cmdShutdown` 只 `stop()` 不关设备，且 `stop()` 在已停止时提前 return → 独占 client 活到进程退出阶段才由析构释放，`AUDIOSES` 在那里最不宽容 → `0xC0000005`。共享模式从没 `set_output` 打开过，所以没事 | 关设备挪进 `cmdShutdown`（同步、在仍存活时完成）；并给 `--step=lifecycle` 补上「断言 dump 文件不存在」的闸门 |
| 46 | **用共享模式的节奏驱动独占周期流** | `available = buffer - padding` 在独占周期流上恒为 0 → 循环空转：**设备每周期都在发事件、环里满是数据，却一个字节都没写出去**。只在真正支持独占的设备上暴露 | 独占按周期模型整块写；`GetBuffer` 被拒才退回 padding 口径 |
| 47 | **24-in-24 容器写越界** | `bits == 24` 写 `int32_t`（4 字节），真 24 位容器 stride 是 **3 字节** → 每样本多写 1 字节，堆越界**直接崩**。此前所有端点只接受 24-in-32，该路径从不可达 | 按 `bytesPerSample` 分派：4 字节写左对齐 int32，3 字节打包小端 24 位 |
| 48 | **看门狗把「环里没数据」当成「设备没发事件」** | `framesRendered_ == 0` 在刚 play、喂料还在预热时必然成立 → 在已报 `outputPerfect=true` 的流上触发降级：**引擎把自己劝退了** | 改用 `renderWakes`；并把三段管道计数全部上报 |
| 49 | **三位字段重构时丢了音量条件** | `outputPerfect()` 不再调用 `WasapiOutput::isBitPerfect()`，而音量检查留在那边 → **50% 音量仍宣称 bit-perfect**。断言此前「通过」是因为独占从没真的跑起来 | 别名必须覆盖全部条件；这条是被真正跑通的独占抓出来的 |
| 45 | **「聪明」的自动重试反而废掉了缓存** | 专辑增益需要解码状态，缓存命中没有；我让它悄悄重跑一次带解码的 → **付了全量解码，还报 cacheHits:0**，缓存看起来是坏的而它做对了 | 把选择权交给调用方（`album: true`）。**两种模式代价差一个数量级时，不该由引擎猜** |
| 44 | **「开流成功」被当成了「能出声」** | 独占三个 API 全绿、报 bitPerfect=true，设备却一个采样都不出。**引擎内部这三件事看起来完全一样** | 把「设备有没有真的发过事件」当成独立事实上报；`--probe-exclusive` 把三件事分开报，并在帧计数为 0 时由看门狗如实降级 |
| 42 | **在已经正确的 API 上多插了一次路径转换** | `openAudioSource` 收 `path`，我却先 `toUtf8` 再传 → narrow string 构造 `path` 按 **ANSI 代码页**解释字节，整个中文库变成 `浠诲闇朶鏂板缓...` | **不转换**。`util.hpp` 顶上就写着这个坑，我仍然踩了——因为它藏在一次「看起来无害」的往返里 |
| 43 | **专辑响度差点做成各曲平均** | 专辑响度是整个专辑 gating 的结果，按曲独立测量再平均会得到**完全合理但错误**的数字（实测差 0.93 LU） | 用 `ebur128_loudness_global_multiple`，各曲 state 同时存活；断言「专辑值 ≠ 均值」把它钉住 |
| 40 | **注释写了规则，代码没写** | `isBitPerfect()` 的注释说「更宽的容器不是位精确投递，不得如此宣称」，下一行却没有那个检查 → **24-bit 装进 32-bit 容器时报 bitPerfect=true**。是外部参考文件指出了才发现的 | 注释不能替代断言；这条现在由 `--step=bitperfect` 的容器断言钉住 |
| 41 | **两个声称同义的字段各算各的** | 只把新逻辑给了 `outputPerfect`，`bitPerfect` 仍读旧的输出层检查 → 同一个 state 事件里 `bitPerfect:true` 而 `outputPerfect:false` | 别名必须**字面上**调用同一个函数；一致性不变式现在是回归闸门。**两个都说是同义词却不等，比只有一个更糟** |
| 38 | **`sourceBits` 在共享模式恒为 0** | 「不做 dither」是对一个**从未被提出的问题**的回答：对 float32 恰好正确，靠运气不靠推理；一旦共享出现整数流就会静默不加 dither | 两种模式都传源位深，让决策从事实导出 |
| 39 | **文档还在说「独占未实现 / 无 DSP」** | PROGRESS §6 的限制清单停留在 M1，而两项都已实现。**这方向的错最容易被留下**，因为它读起来像谦虚 | 实现后回头改限制清单；「限制」也会过期 |
| 31 | **`capabilities.dsp` 报 false 而 DSP 已实现** | 界面「只画引擎声明支持的东西」→ **整条 DSP 段从信号路径上消失**，功能做了却不显示。低估自己与虚报同样是撒谎 | 实现后必须回头改能力声明；能力与状态要分开报（`capabilities.dsp` vs `state.dspActive`） |
| 32 | **蓝牙端点静默走共享** | 没设 `degradeReason` → 界面画出一条干净实线，真相是这条路径不可能 HiFi | 蓝牙强制共享**并说明原因**；理由要写「链路重编码」这种可行动的话，而不是「设备拒绝了格式」这种症状 |
| 33 | **xrun 缓冲上调时不说** | 只发 log 事件 → 用户听到的中断在界面上完全不存在 | 缓冲上调也进 `degradeReason`，且必须在 `reopenOutput` **之后**设——之前设会被 `resetStatus()` 清掉 |
| 34 | **不是降级却设了 `degradeReason`** | 选独占但尚未开曲是正常时序，界面会为一次普通操作画虚线：**虚报** | 「报全」与「不虚报」是同一条纪律的两面；把「有没有信号路径」当作判据 |
| 35 | **`state` 事件不会因 DSP 变化而重发** | `tick()` 只周期发 `position`，所以改了 EQ 界面永远不知道 `dspActive` 变了 | 每个 DSP setter 结尾发一次状态事件（`set_volume` 一直这么做，因为它影响 bit-perfect） |
| 36 | **`ev:'xrun'` 事件从来没发过** | AI-B 的 `protocol.ts` 早就声明了它；C1 的闪烁与 C2 的抖动标记**一直没有触发源** | 由控制线程在计数增长时发（RT 线程不许写 stdout）；`state.xrunCount` 为唯一权威累计值 |
| 37 | **`xrunCount` 曾随重开归零** | 缓冲自适应会重开流 → 用户会在 underrun 正发生时看到数字回到 0，**像故障自己好了** | 改为会话累计、永不重置；这是 DESIGN-A §4.1 点名的最坏语义 |
| 27 | **参考实现的旁路会跳过安全钳位** | DSP 关闭时可能有 >1.0 的样本到达设备，溢出/爆音 | 钳位放在旁路之外**永远执行**；对范围内样本是位精确恒等，零代价。已钉成回归测试 |
| 28 | **`publish()` 之后立刻读 `staticGainDb()` 读到旧值** | 发布是给渲染线程的，读到的是它**已采纳**的快照；中间差一个音频块 | 测试里先 `process()` 一个块再断言；并在头文件写明该访问器返回「已采纳」值 |
| 29 | **黄金测试用满幅探针 → 测到的是钳位不是滤波器** | +12 dB 后峰值近 4.0，被安全钳位压住，10 段全部报 ~2.5 dB，看起来像滤波器写错了 | 探针降到 -20 dBFS，给增益留出余量；±0.1 dB 才有意义 |
| 30 | **`appliedGainDb` 在没有流时报 0** | 值取自渲染线程的已采纳快照，而没开流时链根本没 prepare 过；UI 在停止状态下配 EQ 会看到 0 | 改为按**配置**计算（`computeStaticGainDb` 自由函数，与实时路径共用同一个公式，不会漂移），另加 `streaming` 字段说明当前有没有流 |
| 23 | **结尾截断：把「取走」当成「听到」** | `inputEnded` 与 `isDrained` 混为一谈，环一空就判完；端点缓冲里剩的一个设备周期被 `stop()` 丢掉 | 设备侧真正播完才算完（见 §3.1，两次错误修法也记在那里） |
| 24 | **环重建时两个音频线程还在跑** | 先 `configure()`（内部 realloc）后停线程，双方都可能持有已释放内存 | 先 `stop()`/`stopFeeder()` 把两个线程停稳，再重建 |
| 25 | **收尾的静音空块被记成 xrun** | 每首结尾必报 3 次 xrun → 触发缓冲翻倍 → 重开流 | 解码器送完置 `feederDone`，此后短块属于正常收尾 |
| 26 | **缓冲自适应的重开路径同样没恢复播放态** | 与 #22 同一类错误：reopen 先 pause，没人恢复 | 显式恢复 `Playing` 并重新 `start()`；**同一个坑栽了两次，已写成模式** |
| 18 | **独占探测漏了 24-in-32** | 探测只问 `容器位数 == 源位数`，于是把 24-bit 报成「不支持」。但硬件常把 24-bit 装在 32-bit 容器里带 24 个有效位——**引擎因此谎称设备做不到 bit-perfect** | 探测与开流共用 `exclusive_format.hpp` 的候选集（24-in-24 / 24-in-32 / 32），两边永远一致 |
| 19 | **独占 + EVENTCALLBACK 的 hnsPeriodicity 必须非零** | 传 0，于是一个明明支持独占的设备直接拒绝开流 | 按 MS 文档：`hnsPeriodicity` 必须非零且**等于** `hnsBufferDuration` |
| 20 | **`AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED` 要换新 client 重试** | 在**同一个** IAudioClient 上重新 Initialize「返回成功」，但事件永不触发——流看起来完美，实际一个采样都不出 | 按官方序列：记下驱动要求的帧数 → **Release 掉 client → 重新 Activate** → 用对齐后的时长再 Initialize |
| 21 | **`set_output exclusive` 在没开曲时把输出整个拆了** | 无源格式可协商 → 独占开流失败 → 连共享兜底都没有，回包里 deviceId/sampleRate 全空 | 没开曲时把模式记成**偏好**，先按共享保持可用，开曲时再真正协商 |
| 22 | **看门狗降级后停在 paused** | 回退本身成功，但 `reopenOutput()` 会先 pause，没人恢复播放态 | 回退后显式恢复 `Playing` 并重新 `start()`；共享也起不来才置 `Stopped` |
| 17 | **`repeat: one` 播完不会重播** | 自然结束走的是 `advanceQueue()`，而 one 模式下它返回 true 但不移动索引，然后**没人重新装载那一首** | 自然结束后按队列重新装载当前曲目；`--step=queue` 用「末尾 1.2 秒自然播完 → 应从 0 重播」钉住 |

---

## 4b. ⚠️ 一次自己造成的破坏（务必记住）

本轮我把 **`engine/tools/drive.mjs` 截断了**：读到的是文件的一部分（约 970 行），
我把它当成全文写回，**后半段（completion 尾部 / exclusive / lifecycle / 运行器）直接消失**。

- 原因：`write` 是**整文件覆盖**，而读可能只返回前 N 行。两者配在一起就是数据丢失。
- 本项目**不是 git 仓库**，没有版本历史，也**没有任何备份**，临时目录里也没有命中。
- 已按记忆重建丢失部分，并改用 `edit` 精确拼接而不是 `write` 整文件覆盖。
  重建后的 `completion` / `exclusive` / `lifecycle` / 运行器均已重新验证通过。

### 规则（写给下一个我）

1. **改文件优先用 `edit`**，只在创建新文件时用 `write`。
2. 确实要整文件 `write` 之前，先确认读回来的行数**等于**文件真实行数
   （`totalLines` 与 `lines.length` 对照），不等就别写。
3. 大文件尤其如此：读有上限，写没有。
4. 这个仓库没有 git、也没有备份——**没有第二次机会**。
5. **一次 `edit` 之后，之前读到的行号全部作废。** 要改第二处就重新读，
   或者用**内容锚点**（唯一字符串）定位——别把两处编辑建立在同一份行号上（见坑表 #61）。

重建的步骤与原版可能有个别断言措辞差异，但覆盖的保证一致，且都已重新跑通。
若后续发现某条断言缺失，按本节补齐即可。

---
## 5. 下一步（按依赖顺序）

0. ~~**补 L1 的音频格式**（MP3 / AAC / ALAC）~~ **已完成**（§0l MP3、§0m AAC/ALAC）。
   SPEC §3.8 的 L1 现在是 **5/5：MP3 / AAC / WAV / FLAC / ALAC**。
   **遗留项已关闭**：DAC 插回后 `--step=formats` 跑出了那一对 ——
   `AAC: exclusive outputPerfect=true sourceExact=false` /
   `ALAC: exclusive outputPerfect=true sourceExact=true`（同一台设备、同一条链路，只有文件性质不同）。
1. **联调 fixture**：`engine/fixtures/library-91.json` 是 CONTRACT §9.1 的唯一交接点 —— 已生成，等 AI-B 接
2. ~~`pick_folder`~~ **已裁定**（CR-005）：移到应用侧，用 Electron 的 `dialog.showOpenDialog`；
   契约把它标为「可选 / 由应用侧提供」，引擎保留 `ERR_UNSUPPORTED` 并在错误里说明归谁
3. ~~**M2 · WASAPI 独占**~~ **已实现**（§0g），**两个端点都能跑**：
   - USB DAC：真 bit-perfect（`exclusive 44100Hz bitPerfect=true resampled=false`，容器 24，44.1k 全家族可用）；
   - 内置端点（Intel SST + Conexant）：16-16 与 32-24，3–50 ms 缓冲全部 12/12（**§0n 修正**）。
   ⚠️ 别再引用旧结论「内置端点的独占是死的」—— 那是引擎的三个 bug 加探针的一个 bug 造成的误判。
4. **M2 · 其余 L2**：EQ / dither / ReplayGain 测量 / 扫描缓存 / 异步扫描 **全部已完成**
   （§0a §0d §0f §0h §0i）；CR-011 裁定的加缓存也已落地（重复扫描 4575 ms → 1 ms）
5. ~~RSS 实测~~ **已完成并修正**：§0p 查出「整文件读入」让 RSS 与文件大小成正比（46.5 MB 的曲子实测 75 MB，**超过 60 MB 预算**）。
   改成文件句柄后实测 **16–19 MB 且与文件大小无关** —— 对整库成立，不再只对量到的那首成立。
   同一步也量了启动到发声 152 ms、Seek 32 ms、xrun 0
6. **⚠️ 仍未做：30 min 独占最小缓冲压测 = 0 xrun**（SPEC 181 / 418 / 448）——
   现在有真能跑独占的 DAC 了，这条**从「做不了」变成「可以做」**，是 SPEC 剩下的硬指标
7. **仍未做：xrun 计数与缓冲史写入独立日志文件**（SPEC 182 / 449）——
   目前只在 `state` 事件里上报会话累计值，没有独立诊断日志
8. **仍未做：Gapless**（SPEC §3.7 保留项）—— 详见 §6
9. **仍未做：DSD/DoP 直通**（SPEC §3.5 降级保留）—— 本机无 DSD DAC，只能做回环波形验证

---

## 6. 已知限制（如实记录，不含糊）

> 这份清单在 2026-10-15 **逐条重核过一遍**。此前有三条已经过期的「限制」还挂在这里
> （独占未实现 / ReplayGain 只有应用没有测量 / 扫描不持久化），会误导下一个读它的人。
> 教训：**规范条目要逐条对账，不能靠「测试全绿」推断已实现**；文档同理。

- ~~L1 的音频格式只做了 2/5~~ → **5/5**（§0l MP3、§0m AAC/ALAC）。
  下面几条是 MP4 路径**真实存在、且未被验证或被刻意排除**的边界：
- **裸 ADTS `.aac` 未实现也未测试**：`.m4a` 走 MF，`.aac` 的裸流没测过，所以不宣称。
- **MP4 只取第一条音轨**，视频流被显式取消选择。打开一个 950 MB 的视频文件只解音频，
  但 `scan` 不列 `.mp4`（只列 `.m4a` / `.aac`），所以那不是正常用法。
- ~~ALAC 的 `sourceExact=true` 那半条未演示~~ → **已验证**（DAC 插回后）：
  同一台设备、同一条独占链路下 `AAC sourceExact=false` 而 `ALAC sourceExact=true` ——
  这就是拆三字段时要表达的那对事实。仍成立的相关边界见上一条（`scan` 不列 `.mp4`）。
- **MF 的两种 GUID 拼法只覆盖了实测到的两种**。将来出现第三种，症状会是
  「无损文件被报成有损」—— 所以 `--probe-mf` 那行 `mp4 decode: subtype {...} lossless=N` 要留着。
- **MP3 无索引时 seek 是 O(目标位置)**：没有 Xing/Info 头的 CBR 文件跳到中点要解码一半音频，
  实测 159 ms（4 分钟曲目）。有索引的文件走 seek 表，**那条路径未实测**。见 §0l。
- ~~独占在本机内置端点上跑不了~~ → **这句是错的**，见 §0n。
  内置端点（Intel SST + Conexant）实测支持独占 **16-16 与 32-24，3–50 ms 缓冲全部 12/12**，
  引擎在它上面连续渲染（唤醒 102→859、位置 612→5154 ms）。
  当初的「一个采样都不出」是**引擎的三个 bug**；当初的「事件只响 1/12」是**探针自己的 bug**
  （用共享模式的 padding 判据驱动独占周期流）。⚠️ 凡是「某硬件不支持」的结论，
  都要能回答：**用什么量的、那个量具自己验过吗**。
- **独占在内置端点上的实际能力边界**：接受 16-16 与 32-24，**拒绝 24-24 与 32-32**（`0x88890008`）。
  所以 16-bit / 48 kHz 的文件在它上面**可以** bit-perfect；24-bit 文件只能进 32-bit 容器，
  因此 `pcmPassthrough=false` —— 那是打包事实，不是降级。
- **Gapless 未实现**（SPEC §3.7）：没有任何「预解码下一首」的逻辑，
  同专辑曲目之间是**设备缓冲级的静音缝**，不是采样级拼接。
  手动切歌的 5 ms 淡出已实现（§0k），但那**不是** Gapless
- **DSD/DoP 未实现**（SPEC §3.5）：本机无 DSD DAC，这条只能做回环波形验证，做了也听不到
- **30 min 压测未通过**（SPEC §9）：**不是"未做"** —— 已跑过三次，**三次都在同一首、同一毫秒（295597 ms）停住**，
  根因已坐实并修（§0t 的超报帧数），**确定性复现（单曲 5 分钟）已 `SOAK PASSED`**（xrun 3→0）。
  但**完整 30 分钟全库从未跑完通过**（第四次跑到 12:00 时为让 owner 听音而中止）。
  ⚠️ **在没有一次完整的 30 分钟通过之前，不要宣称 §9 达成**。
  另：xrun 计数只在短时步骤里被断言为 0。
- **异步扫描不提供专辑增益**，且是**明确拒绝**（`album.ok=false` + 原因）而非近似：
  专辑响度要求每首的解码器状态同时存活（91 首约 10–20 MB），
  而 SPEC §8.2 给整个引擎的预算是 60 MB（§0i）
- **异步扫描并发第二次被拒**（`ERR_STATE`），不是排队或并行 —— 一次只允许一个扫描
- **声道映射未实现**：源声道数与设备不一致时如实拒绝（本库 91 首全为 2ch，不阻塞）。
  注意这与「声道工具」是两件事：balance / mono / stereoWidth / swapChannels / channelGains 已实现（§0j）
- ~~整文件读入内存~~ → **已改**：`audio_source.cpp` L71-91 记录了这个决定——
  曾经每个解码器都被交给一个装着**整个压缩文件**的 `std::vector<uint8_t>`，实测**是错的**：
  本库 91 首 FLAC 共 3427 MB（中位 34.8 MB，最大 91.5 MB），
  那让 46.5 MB 的曲子量到 **75 MB RSS**（超 SPEC §8.2 的 60 MB）——
  **预算从来没真正达成过**，它只是恰好在延迟步骤挑到的小文件上达成。
  ⭐ **它同时挡住了 SPEC §3.7 的 gapless**（预解码下一首要重叠两份文件大小 = 常态 70 MB / 最坏 183 MB）。
  **现在用文件句柄，重叠的代价是解码器状态** → **gapless 的前置条件已满足**。
  ⚠️ **本条此前写着"仍把压缩文件整读"——那是过时记录**，已于 2026-10-16 对账更正。
- **`seek` 会丢弃 SoXR 内部缓冲**：重采样相位不连续，听感上可能有一次极轻的咔哒。
  正确做法是精确相位重置，留到 M2
- **dither 的决策依赖源位深**。32-bit 源文件在本库中不存在，
  所以「float32 装不下 32-bit 源」这条路径**未实测**
- **崩溃转储**：`SetUnhandledExceptionFilter` 会写 `bin/twilight-engine-crash.dmp`，
  并打印**出错模块**与线程归属；本机**没有调试器**，所以配 `/MAP` 链接（`bin/twilight-engine.map`）供 RVA 反查
- **`TE_RT_TRACE`**：默认关闭。`build.ps1 -RtTrace` 打开后，崩溃报告会指出渲染线程正卡在哪个调用
- **RTSan 不可用**：Windows 不支持（SPEC §3.2），实时安全靠人工断言 + 压力测试 + xrun 计数

---

## 7. 交付物

```
engine/
├─ bin/twilight-engine.exe        产物（固定路径）
├─ bin/twilight-engine.map        崩溃地址反查
├─ fixtures/library-91.json       给 AI-B 的真实元数据
├─ tools/build.ps1                构建
├─ tools/fetch-deps.ps1           第三方依赖
├─ tools/drive.mjs                A 侧「假应用」+ 验收脚本（462 条断言 / 22 步；只有一个回放端点时 hotplug 跳过，少 8 条）
├─ src/                           见 README 5 源码地图
└─ third_party/                   TagLib / utfcpp / dr_libs / soxr
```

---

## 8. 输出规格可指定 + 重采样质量（2026-10-17，对应 CR-021）

用户要求「192kHz 等等几种规格的输出」。独占路径原来**只能跟着源采样率**，这一轮让它可被指定：

- `Player::setOutputRate(rate)`（0 = 跟随源）；`set_output { mode?, sampleRate? }`。
  `mode` 省略时保持当前偏好（以前省略即 auto，只改规格会顺手重置模式）。
  合法档位：0 / 44100 / 48000 / 88200 / 96000 / 176400 / 192000 / 352800 / 384000；非法值 ERR_STATE。
- 独占/自动路径按请求的流率开流；共享模式无法采纳（WASAPI 只能跑设备混音格式），
  状态里同时报告 `requestedOutputRate`（请求）与 `sampleRate`（实际）。
- 非零且与源不同 ⇒ 重采样器进入链路 ⇒ `outputPerfect=false`、`resampled=true`、
  `outputNotPerfectReason="resampled"`。**升频不会冒充 bit-perfect。**
- `state` 新增只读字段 `requestedOutputRate`；`open` 回复同步带上。
- 两个顺带修的真问题（只有真的用起来才会暴露）：
  1. `reopenOutput()` 原来**不发 state 事件** —— `set_output` 回包是新格式，
     而界面还在画旧流（下一轮无关事件才纠正）。现在成功/失败都发。
  2. 改设置会重开流，但**不自动恢复播放** —— 一次设置等于一次静音。
     `cmdSetOutput` 记住 wasPlaying，重开成功后接着放；恢复失败写一条 error 日志，不谎称在播。
- 重采样：SoXR `HQ` → `VHQ`（28-bit 精度）。只在 rate 不同时创建，直通路径零改动。
- 实测（内置端点 48000/24 独占可用；源 44100/24）：
  ```text
  set_output 96000 → requested=96000 实际 48000 degradeReason 点名 "96000 Hz / 24-bit PCM"
  set_output 48000 → exclusive 48000 resampled=true bitPerfect=false reason=resampled
  播放 4 秒        → position 4103ms xrun 0 renderedFrames 196992（≈48000/s）
  set_output 12345 → ERR_STATE
  ```
- 可复现证据：`node engine/tools/probe-output-rate.mjs`（真实引擎 + 真实端点，逐档打印请求/实际/
  degradeReason，并断言非法值被拒）。本机端点只接受 48k 独占，所以 96k/192k 在这里如实报「未被采纳」。
- 下一步（未做）：`--selftest` 里加一条「强制率 + 重采样」的自动断言；192k 的真实开流仍需那块 USB DAC
  （插上后跑 `--probe-exclusive` 即可确认）。

## 9. 性能与占用优化（2026-10-17，对应 CR-022；app 侧记录见 docs/PERF-v1-2026-10-17.md）

用户要求「深度优化整个应用的性能开销、降低占用、不影响功能」。引擎侧先量、再改、再加闸；默认 DSP/输出/内存路径保持不动（默认旁路 0.102% 单核、RSS 16–21MB，均远低于 SPEC §8.2）。

- **E1 json.hpp 数字序列化**：dumpNumber 从 snprintf + strtod 往返校验改为 std::to_chars 最短往返。
  微基准：1.130 µs/个 → 0.071 µs/个；meter 一帧约 190 个数字，60 fps 下约 1.05% → 0.08% 单核。
  语义不变（同样是最短可还原表示、合法 JSON 数字；非有限值仍写 null）；20k+ 随机/边界值 dump→parse 逐位相等。
- **E4 MeterTap::snapshot**：只 memcpy channels_ × kWindowFrames，不再按 kMaxChannels 拷满 8 声道
  （2ch 每帧少搬 48KB；2.02 → 0.32 µs/帧，收益小但零风险）。
- **E3 meter 事件构造**：对象/数组按已知大小 reserve，emitEvent(event, 512) 预分配行缓冲。
- **R8 meter 载荷瘦身**：不再发送 waveform（应用侧 meterStore 从不消费；真机每帧 749B 里约 550B 是它）；
  各 dB 数值量化到 0.1 dB。meter 单帧约 793B → 330B，带宽 51.2 → 20.8–22.4 KB/s（-58%）。
  engine/tools/test-playback-silent.mjs 的断言改为「不再发送 waveform」+ 0.1dB 断言。
- **E2 meter 关闭时停分析**：emitMeter() 在 meterEnabled_ == false 时直接返回，不再做
  FFT(8192×2ch) + EBU true-peak（每帧约 393 µs ≈ 2.36% 单核）。setMeterEnabled(true) 复位分析器，
  2–3 个控制循环（≤50 ms）内第一帧就是当前窗口；EBU Momentary 需 400 ms 窗口重填（约 1 s 爬回真实值）。
  **这是有意的行为变化**：窗口隐藏/无消费者时 meter 读数暂停推进（记入 CR-022）。
- **R3**：probe_resample.cpp 注释 HQ→VHQ 更正（音频链路交接把 HQ 改成 VHQ 后注释漂移）。
- **E7（批量 flush）故意不做**：收益约 0.05% 单核，却要区分「回复立即 flush / 事件缓冲 flush」两条路径，风险大于收益。

### 9.1 干净 A/B（44.1k 源 / shared 48k / 24bit / 静音 / 30s 每段 / 页缓存预热 / 无并发测量；5s 分段中位数）

| 场景 | before 单核 | after 单核 | 说明 |
|---|---|---|---|
| meter off（=隐藏/关闭监测） | 3.8–3.9% | 0.3–1.7% | 两轮 0.28 / 1.67；少掉的是分析成本 |
| meter on（可见） | 4.96–4.98% | 2.80–3.45% | 两轮；mean 口径 5.68/4.44 → 3.73/3.46 |
| meter 帧体积 | 793 B / 51.2 KB/s | 330 B / 20.8–22.4 KB/s | -58% |
| xrun | 0 | 0 | 播放 30s 无 underrun |
| RSS | 19.9–20.6 MB | 19.9–20.6 MB | 不涨 |

- 顺带钉死了旧基线里的疑问：meter-on/off 的真实增量约 +1.0–1.3%（旧 exe 干净 A/B + bench 1.05% 三方吻合），
  早前 3.85%→7.08% 的 3.23% 差值是环境噪声，不是序列化成本。
- 已知代价：exe 1,801,216 → 1,924,096 B（+123KB，MSVC 浮点 to_chars/Ryu 表），运行时 RSS 无变化。

### 9.2 复现

```powershell
engine\bin\twilight-engine.exe --selftest
node engine\tools\test-playback-silent.mjs "<测试曲库>"   # 先 mute 再 play，不出声
node engine\tools\test-default-output.mjs                               # 已补 set_muted(true)
# 微基准（可重跑）：.smoke/perf-audit/perf-engine/bench/bench_hot.exe
```

### 9.3 未完成 / 后续

- **E8 已量（窗口前）**：SoXR VHQ 在 44.1→48 的增量 = 0.125s CPU / 101.4s 音频 = **0.12% 单核**（含 interleave）。
  → VHQ 不是 CPU 问题，**不要为了性能回退音质**。
- **E10 已量**：shared 打开中位 76.7ms（48k 同率 1.3–4.7ms；44.1/96k 跨率 71–150ms；auto 中位 67.4ms）。
- ⚠️ **E10b 新发现（未修，exe 已冻结，建议下一轮）**：shared 模式**跨采样率切歌**会整段重开 WASAPI 流 ——
  `player.cpp:773` 的 `formatChanged` 用源采样率比较，而 shared 输出的流率是设备混音率，于是每次跨率 open 都重开流。
  diag log 10 次 open 出现 7 条 `output opened`；单次 70–150ms，但 **CPU 只有 4.7ms**，是驱动/COM 等待而非计算。
  修法：shared 分支不要用源码率判格式变化，sourceBits 走 setter 更新、不重开流；预计 70–150ms → 2–5ms。
- **E2 恢复实测**：`set_meter(true)` → 首帧 15.2ms、稳定 63.6 帧/秒。注意 tap 在增益/静音之后（`output_wasapi.cpp:1061`），
  静音纪律下读数为底噪是正确行为，所以「首帧非底噪」无法断言；EBU Momentary 需 400ms 窗回填（约 1s 爬回真实值）。
- E5（启动并行化：设备枚举与共享流打开串行，spawn→ready 中位 136.6ms）需改 ready 语义，属协议/行为裁定，未做。
- R1/R2 数据风险（只读发现，未改）：meter.cpp 的 sequence 注释声称会跳过重复窗口，实际只在无新窗口时返回；
  当前 hop 发布率高于控制循环，不会触发；32k 输出等低 hop 场景才会暴露。

## 10. 播放链路 v2：ECHO NEXT 专业功能移植 + 切歌性能（2026-10-17 第二轮，CR-024..027）

用户要求「转化 ECHO NEXT 的专业功能和播放性能、尤其深度播放状态、并检查功能是否真实落地」。引擎侧最终 exe：20:56:00 / 1,963,008B / SHA256 `9DD47E13…F209ED`（冻结）。

- **E10 + E10b（播放性能）**：独占协商结果缓存（设备+格式，`device_changed` 失效）+ shared 跨采样率切歌不再整段重开 WASAPI（`formatChanged` 不再用源码率比较，sourceBits 走 setter）。
  - 引擎内部：shared 跨率 `open` 中位 **76.7ms → 1.1ms**（max 3.4ms，`output opened` 增量 0）；`open→playing` 中位 **83.9ms → 34ms**（≤50ms 验收）。
  - 残余 34ms 是 `output_.stop()/start()`（渲染线程 teardown + AVRT MMCSS 声明 + 5ms 淡出排空），与 stream reuse/gapless 同一块底座 → 记下轮。
- **feeder 等待**：2–3ms 轮询 → 条件变量 timed wait（`waitFeeder`/`notifyFeeder`），行为等价。
- **CR-024 `set_resampler`**：quality `HQ|VHQ|24BIT`、phase `linear|minimum|intermediate|maximum`、steep；成功 emitState；默认 VHQ/linear/非 steep 与现状一致（selftest 断言）；播放中改配置重建重采样器并恢复源码位置（≤100ms，如实 applied）。
- **CR-025 `set_dither`**：off/tpdf/highpass-tpdf/ns-5/ns-9/ultra-shaped（lip44 5 抽头 / fwe44 9 抽头 / shi44 20 抽头，来自 SoX v14.4.2 `src/dither.c`，只抄常数并注明来源）；默认 tpdf 与原算法逐样本一致；float/bit-perfect 永不 dither；`state.dither{mode,active}`。
- **CR-026 `set_channels` 扩展**：`monoMode`、低/中/高（LR2 200Hz/2kHz）左右增益、每声道延迟 0–10ms；全 0 逐位旁路（selftest 逐样本恒等）；`dspJson.channels` 回读 + `dspModules` 增加 bandGain/channelDelay；命令回复保持全量 dsp 对象。
- **CR-027 `set_output.latencyProfile`**：stable(8192 帧)/balanced(现状)/lowLatency(请求最小周期，拿不到报实际)；实测：stable bufferMs=171、balanced=22、lowLatency=22（共享系统下限）、xrun=0。
- **IR 恢复段口径**（截断事故恢复后补齐）：无 IR 时 `set_ir{enabled:true}` → ok:false 且 state 不变；preamp 越界 ±24 拒绝（loadIr 自动 preamp 允许界内 clamp）；IR 生效时 passthrough=false。selftest 新增 loaded-but-disabled/enabled 断言。

### 10.1 事故与教训（必须保留）

改 CR-024 时用「整文件读→字符串替换→整文件写回」改 `player.cpp`，但读工具对 >50KB 文件有 ~50KB 截断，导致尾部约 700 行被截掉。已用 `engine/build/playback-quality-baseline/player.cpp`（10-16 副本）+ 备份 `<仓库根>-backup-20261017-1912`（19:12）重新以备份为基座重建，并逐函数/逐头文件成员核对零丢失（verifier 独立复核：删除行全部可归因到已知改动）。**教训：大文件只用 anchor edit，禁止整文件回写。**

### 10.2 未做（下轮）

- meter FFT 补零 4×→2× 实验（要改 meter.hpp 常量并重链，会让冻结 sha 变化）；E5 启动并行化；stream reuse/gapless；true-peak limiter（把现有 sample-peak limiter 换成真峰值检测）；transport cancellation；preventClip 的 true-peak 口径（已在应用侧用引擎返回的 peakLinear 实现接线）。
- 详见 `app/.smoke/perf-audit/perf-engine/ENGINE-FEATURE-AUDIT-2026-10-17.md`。
