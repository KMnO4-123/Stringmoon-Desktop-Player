# 致 AI-A · Twilight Echo 音频引擎

> **这是你的开工指令。** 如果你是收到这份文件的项目 AI，先完整读完本文件，再按 §4 的顺序动手。
> 工作目录：`<仓库根>\` · 你的目录：`<仓库根>\engine\`

---

## 1. 你是谁，你负责什么

你是 **AI-A**，负责 Twilight Echo 的 **音频引擎**：

- **C++20**，编译成独立可执行文件 **`twilight-engine.exe`**
- 它是**唯一的音频权威**：解码、DSP、输出、设备管理、标签读取、文件扫描
- 它与应用之间**只通过 stdin/stdout 的 JSON Lines 通信**（协议见 `CONTRACT.md` §3）
- **音频样本绝不穿越这个通道** —— 引擎直接对声卡输出

**你不负责**：UI、React、平台账号接入、歌词渲染、曲库展示。那是 AI-B 的活，它在 `app\` 目录，你看不到它，它也看不到你。

---

## 2. 开工必读（按顺序，别跳）

| 顺序 | 文件 | 读什么 |
|---|---|---|
| 1 | `<仓库根>\CONTRACT.md` | **全文**。尤其 §0 硬前提、**§3 接口 A（你的协议，逐字照做）**、§6 共享事实表、§7 构建环境、§8 分工边界、§9 第一件事 |
| 2 | `<仓库根>\docs\SPEC-v2.1.md` | §3 引擎架构、§8 性能预算、§10.1 M1 验收 |
| 3 | `<仓库根>\engine\README.md` | 你自己的构建说明（第一次由你创建） |

`docs\SPEC-v2.0-legacy.txt` 是历史参考，**已被 v2.1 取代**，只在你想知道"为什么改"时翻。

---

## 3. 硬边界（越界即冲突）

1. **禁止修改** `CONTRACT.md` 和 `docs\SPEC-v2.1.md`。它们是冻结契约，**双方只读**。
2. **禁止进入 `app\` 目录改任何文件。**
3. **禁止自己扩展 JSON 字段名。** 契约里写的字段一字不差地实现；你多写的字段对方会忽略，但别指望对方理解它。
4. **`stdout` 只允许出现 JSON Lines。** 任何调试输出、库的日志、`printf` 全部走 `stderr`。这条违反了对方必崩。
5. 需要改契约时：在 `docs\contract-requests.md` 追加一条（用文件里的模板），**然后等 owner 裁定**，不要自己动手改。

---

## 4. 你的第一个任务（M1 的引擎侧）

按顺序做，**每一步都要能独立验证**。

### 第 0 步：空引擎（先证明通道通）

在 `engine\` 建 CMake 工程，产出一个**只会说话、不会放音**的可执行文件：

- 启动后往 stdout 发一条 `{"ev":"ready","protocol":1,"version":"0.1.0","devices":[]}`
- 从 stdin 按行读 JSON，认 `hello`、`list_devices`、`shutdown` 三条命令
- 每条命令回复 `{"id":<同一个id>,"ok":true,"data":{...}}`
- 收到 `shutdown` 干净退出

**同时写 `engine\tools\drive.mjs`**（Node 脚本）：spawn 这个 exe，喂一串命令，把 stdout 逐行解析并打印。**这个脚本是你后续每一步的自测工具**——它会变成你的"假应用"。

> 为什么先写驱动力脚本：你需要一个不存在的应用来测你的协议，就像 AI-B 需要一个不存在的引擎来测它的 UI。**双方各自实现契约的另一侧，是这份契约真正生效的方式。**

### 第 1 步：`scan`

认 `{"id":N,"cmd":"scan","path":"..."}`：

- 遍历目录（不递归子目录也可以，先跑通）
- 用 TagLib 读标签，取：标题、艺术家、专辑、时长、采样率、位深、声道
- 分配 `trackId`（格式 `tl_0001`，见 CONTRACT §3.5）
- 期间上报 `{"ev":"scan_progress","done":N,"total":M}`
- 完成时回 `{"id":N,"ok":true,"data":{"tracks":[...]}}` 并发 `{"ev":"scan_done","added":91,"failed":0}`

**真实测试数据**（必须用这个）：

```
<测试曲库>
```

预期 **91 个 FLAC**，多为 24bit/96k 级。**注意这几个坑**：

- 路径可能含空格与中文，JSON 里要正确转义
- 文件名里有**连续多个空格**（例：`TestBand      - 测试曲.flac`）—— 不要把多空格当分隔符压缩
- 存在**带组合字符的 Unicode 文件名**（例：`Cytus - ͟͝͞Ⅱ́̕.flac`）—— 这是你的编码压力测试。用 UTF-8 处理，不要转成 ANSI
- 有些文件名很长，别用固定长度缓冲

**不要**在这一步做：FTS5、断点续扫、指纹、多级封面缓存。91 首不需要，见 SPEC §7.1。

### 第 2 步：`open` + `play`（**共享模式**先跑通）

- `open`：装载文件、解码、准备输出（不自动播放）
- `play` / `pause` / `stop` / `seek` / `set_volume`：按契约实现
- 播放中周期上报 `{"ev":"position",...}`（约 100ms 一次）
- 状态变化时上报 `{"ev":"state",...,"state":"playing","outputMode":"shared","bitPerfect":false}`

**为什么先共享模式**：先证明"能放出声"，再证明"放得对"。**独占模式是 M2 的事，现在不要碰。**

**架构要求（即使共享模式也要照做）**：

- 三线程模型（SPEC §3.2）：渲染(RT) / 控制 / I/O
- SPSC 环形缓冲，`alignas(64)` 防伪共享，索引只用 acquire/release
- RT 线程内**无锁、无分配、无系统调用**；RT 里不写日志，只计数
- 内部 float32 planar，仅在输出边界交织并做位深转换

### 第 3 步：`next` / `prev` 与播放队列

- 队列模式：顺序 / 单曲 / 列表 / 随机
- 播完上报 `{"ev":"ended","trackId":"...","reason":"eof"}`

### 第 4 步：给 AI-B 的 fixture

把你 `scan` 出来的**真实 91 首元数据**导出成 JSON 一份，放在 **`engine\fixtures\library-91.json`**（同时在 CONTRACT 允许的范围内告知 owner）。

AI-B 看不到你的代码，但它需要真实数据来写 UI。这份 fixture 是你们之间唯一的"数据交接点"。

---

## 5. M1 的判据（你会被这样验收）

| 判据 | 怎么验 |
|---|---|
| 空引擎跑通 | `node engine\tools\drive.mjs` 能发出 `hello` 并收到 `ready` 与回复 |
| scan 拿到 91 首 | 同一脚本让 `scan` 跑 `<测试曲库>`，`scan_done` 报 `added:91` |
| 放出声 | 双击/调用后，**本机声卡真的有声音**（共享模式即可） |
| 六个控制命令 | play/pause/stop/next/prev/seek + set_volume 全部可用且状态事件正确 |
| stdout 干净 | **每一行**都是合法 JSON。用脚本断言：任何一行 `JSON.parse` 失败即失败 |
| 退出无残留 | 应用退出后引擎进程不存在（收到 `shutdown` 或 stdin 关闭即退） |

---

## 6. 环境（本机实测，别猜）

```
MSVC 14.44.35207   C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
                   └ VC\Auxiliary\Build\vcvars64.bat   ← 构建前 source 它
MSVC 14.51.36231   Visual Studio 2026 18.10（装在非系统盘、路径含非 ASCII 字符）
                   ⚠ 同机还有一份 18.11 的残缺安装（缺 C++ 工作负载），不要用
Windows SDK        10.0.26100.0
CMake              4.4.4
Node               独立安装目录下的 node.exe（不在系统目录）
git                任意 Git for Windows 安装（cmd\git.exe 在 PATH 上即可）
磁盘               C: 48GB 可用 / D: 421GB 可用
```

**三条会绊人的：**

1. **`cl.exe` 不在 PATH 上**（正常）。构建前 source `vcvars64.bat`，或用 CMake 的 Visual Studio generator 让它自己找；`engine/tools/build.ps1` 已用 `vswhere` 自动定位。
2. **Node 所在目录是只读 ACL** —— 绝对不要往那里装任何东西。
3. 本机 PowerShell 执行策略会挡 `.ps1` 直跑 → 用 `powershell -ExecutionPolicy Bypass -File`。

---

## 7. 不要自己发明的东西

这些**必须逐字照 `CONTRACT.md`**，一个字符都不要改：

- 命令名与字段名（`cmd` / `ev` / `id` / `ok` / `error` / `data` …）
- **错误码**（只有六个：`ERR_DEVICE` / `ERR_DECODE` / `ERR_NOTFOUND` / `ERR_STATE` / `ERR_UNSUPPORTED` / `ERR_INTERNAL`）
- **trackId 格式**：`tl_` + 4 位序号
- 时间单位：**毫秒整数**；音量 0.0–1.0 的 float
- **"降级不是错误"**：独占失败自动转共享时**不要**返回 `ok:false`，用 `state.outputMode` + `bitPerfect:false` 表达。只有两种模式都打不开设备才回 `ERR_DEVICE`

---

## 8. 卡住的时候

| 情况 | 做什么 |
|---|---|
| 契约里有东西实现不了 | 写 `docs\contract-requests.md`，说明现状/请求/理由/替代方案，**继续做别的部分** |
| 不确定某个字段含义 | 先按契约字面实现，把疑问写进 `contract-requests.md` |
| 编译环境问题 | 先试另一套 MSVC（14.51.36231）；`build.ps1` 会用 `vswhere` 自动找安装位置 |
| 独占模式打不开 | **M1 不需要它**。用共享模式，把设备能力探测结果记进日志就行 |

---

## 9. 一句话记住

> **你的 KPI 不是"引擎能出声"，是"应用侧不用读你的源码就能正确驱动你"。**
> 做到这一点，AI-B 才能在你完全不知情的情况下把 UI 做完；做不到，两边合并时会全盘重来。
