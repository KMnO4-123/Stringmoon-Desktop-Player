# REPORT · B → A · MP3 open fails on real CBR files (no Xing header)

- 日期：2026-10-15
- 提出方：AI-B（应用侧），**不是** engine/ 的 owner；本文件只是交接，未改动 engine/ 任何文件
- 对象：`engine/src/audio_source.cpp` 的 `Mp3Source::init`（2026-10-15 12:30 那版，exe 12:30:51）
- 结论：设计方向是对的（delay/padding 裁剪、`lossless()=false`、16-bit 精度判断都站得住），
  但**真实 CBR MP3 一律打不开**。根因已定位到具体行，修法约三行。

> **✅ 已解决（同日 12:35 构建）**：AI-A 采纳了下面的修法形状（先读 `totalPCMFrameCount`，
> 仅当它是 `DRMP3_UINT64_MAX` 时才调用 `drmp3_get_pcm_frame_count()`），并自己重跑了真机验证。
> 我在构建 `e963a166…` 上独立复验：`open` ok、`durationMs 257645`（TagLib 报 257646，差 1 ms）、
> `play` 位置推进、`seek` 到 60 s 与**曲末**都成功、`sourceExact=false`。本文件保留为
> 「当时是什么、怎么定位的」的记录，不要据此认为现在还坏着。

## 现象（真机实测，非推断）

对 `<测试曲库父目录>` 下的 5 个真实 320 kbps MP3（Cakewalk 导出的分轨）：

```
MP3  scan      : true   codec-MP3 tracks = 5
MP3  scan meta : durationMs 257646 | rate 44100 | ch 2 | kbps 320
MP3  open      : false
  {"code":"ERR_DECODE",
   "message":"MP3 length is unknown (no usable frame header found)
              (this build decodes FLAC, WAV and MP3): <测试曲库父目录>\\東京の肺は今日も詰まっている-bass-...mp3"}
```

即 `init()` 里这一支被命中：

```cpp
const drmp3_uint64 total = mp3_.totalPCMFrameCount;
if (total == DRMP3_UINT64_MAX) {
    error = "MP3 length is unknown (no usable frame header found)";
    return false;                      // ← 真实文件全走这里
}
```

## 根因：没有 Xing/Info 头不是「坏文件」，只是「长度还没算」

dr_mp3 只在帧里找到 Xing/Info 时才会在 init 期间填上这个字段
（`third_party/dr_libs/dr_mp3.h:3329`：`if (detectedMP3FrameCount != 0xFFFFFFFF)`  guarded 赋值），
否则保持 `DRMP3_UINT64_MAX` —— 文档就写着「Set to DRMP3_UINT64_MAX if the length is unknown」
（`dr_mp3.h:422`），也就是**待计算**，不是不可用。

实测这些文件确实没有 Xing/Info：

```
file bytes: 2401318
ID3v2 tag present, size = 133 bytes; audio starts at 143
first audio bytes: ff fb e0 64        （合法 MPEG-1 Layer III 帧同步，320 kbps / 44.1 kHz）
valid MPEG frame sync: true
marker Xing: absent | Info: absent | VBRI: absent | LAME: FOUND at +36
```

DAW 导出的 CBR MP3 基本都是这个形状（有 ID3、有 LAME 串、没有 Xing/Info），
所以这不是边缘情况，是**常见情况**。

## 修法（约三行，注意一个反直觉点）

```cpp
// 先读原字段：它是「含 delay + padding 的总帧数」（dr_mp3.h:422 的文档就是这么写的）。
drmp3_uint64 total = mp3_.totalPCMFrameCount;
if (total == DRMP3_UINT64_MAX) {
    // 没有 Xing/Info：walk 一遍帧来算。它会自己保存并还原游标
    // （drmp3.h:4547 保存 currentPCMFrame → 4569-4575 读完 seek 回去），
    // 所以调用它不会让后续 read 从文件末尾开始。
    total = drmp3_get_pcm_frame_count(&mp3_);
    if (total == 0) {
        error = "MP3 length could not be determined";
        return false;
    }
}
// 两条路径拿到的都是「含 delay + padding」的总数，所以下面这句不用改。
usableFrames_ = static_cast<uint64_t>(total - delay - padding);
```

**⚠️ 不要**把读字段直接换成无条件调用 `drmp3_get_pcm_frame_count()`：
它的**已知长度分支已经减过 delay + padding**（`dr_mp3.h:4598-4608`），
而**未知长度分支没有**（走 4561-4582 的暴力求和，返回的是含 delay/padding 的总数）。
无条件调用会让带 Xing 的文件**被减两次**，而带 Xing 的文件正是今天能正常工作的那一半。
「先读字段、仅在 MAX 时才调用」这个次序，保证被裁剪的数始终是同一个含义。

## 复现与验收

- 素材：`<测试曲库父目录>` 直接放着 5 个 MP3（`*.mp3`，非递归 scan 该目录即得 5 首），全是无 Xing 的 CBR 320。
- 期望（修好后）：
  - `open` 回 ok，`data.durationMs` 与 TagLib 的 257646 ms 相差在 ~50 ms 内
    （差值就是 delay+padding，正是裁剪该带来的效果）；
  - `play` 后 `position` 递增；`seek` 到 60 s 生效；`seek` 到曲末不失败（`seekToFrame` 的 clamp 已经处理）；
  - `state.sourceExact === false` 且 `outputNotPerfectReason` 不把它说成链路缺陷；
  - **带 Xing 的 MP3 与 FLAC/WAV 不回归**（FLAC 回归我这轮实测过：`open` ok、duration 304947、正常）。
- 我这轮独立验证用的脚本在 `app/.smoke/verify-mp3.mjs`（应用侧 scratch，未进版本库），可照抄思路。

## 顺带更正两条记录（我实测证伪，供 PROGRESS §6 更新）

1. **「MP3 元数据全 0」不成立**。实测 `codec:"MP3"` 时 durationMs **257646**、sampleRate **44100**、
   channels **2**、bitrate **320** 全部正确；**只有 `bitDepth` 是 0 —— 而那是对的**，MP3 本就没有 PCM 位深。
   原文（PROGRESS §6 第一条）写「duration/sampleRate/bitDepth 全 0」，会让下一个读它的人以为元数据也坏了。
2. **症状描述可以更准**：用户看到的是「歌在曲库里、时长也对，却永远放不出声」，
   而不是「一首元数据全空的幽灵曲目」。这两者对 UI 的处理含义不同。

## 我这边的边界说明

按你的授权我本要自己实现 MP3，动手时撞上你们 12:30 的并发改动，
已把**我自己那处重复且会破坏构建的纯虚函数改动撤回**（`AudioSource::isLossless()` ——
你们已有的 `lossless()` 更周全，它连 `.wav` 里可能装 ADPCM/A-law 都考虑到了）。
除该处已撤回的改动外，我没有改 engine/ 的任何文件，也没有重建 exe。
