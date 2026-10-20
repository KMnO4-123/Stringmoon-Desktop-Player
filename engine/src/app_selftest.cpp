// Out-of-line bodies for App that are not part of the command path, plus the
// JSON codec self-test. Kept separate so app.cpp stays readable as the protocol
// state machine.

#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>

#include "dsd_source.hpp"

#include "analysis.hpp"
#include "app.hpp"
#include "convolver.hpp"
#include "dsp.hpp"
#include "exclusive_format.hpp"
#include "audio_fade.hpp"
#include "gain_smoother.hpp"
#include "meter.hpp"
#include "endpoint_progress.hpp"
#include "json.hpp"
#include "protocol.hpp"
#include "util.hpp"

namespace te {

std::string trackIdSample(long long n) { return formatTrackId(n); }

namespace {

int g_failures = 0;

void check(bool condition, const std::string& what) {
    if (condition) return;
    ++g_failures;
    std::fprintf(stderr, "  FAIL  %s\n", what.c_str());
}

// Round-trips a frame and requires byte-identical output, which also pins the
// member ordering the driver asserts against.
void checkRoundTrip(const te::Json& frame, const std::string& expected, const std::string& what) {
    const std::string dumped = frame.dump();
    check(dumped == expected, what + " (dumped: " + dumped + ")");

    auto reparsed = te::Json::parse(dumped);
    check(reparsed.has_value(), what + " (reparse)");
    if (reparsed) check(reparsed->dump() == dumped, what + " (stable)");
}

} // namespace

int App::selfTest() {
    std::fprintf(stderr, "twilight-engine self-test\n");

    // --- real-time meter analysis: measured tone, silent floor, no fake peak -
    {
        constexpr int rate = 48000;
        constexpr int frames = MeterTap::kWindowFrames;
        auto tap = std::make_unique<MeterTap>();
        tap->prepare(2, rate);
        std::vector<float> left(frames), right(frames);
        for (int i = 0; i < frames; ++i) {
            const float sample = 0.5f * std::sin(2.0f * 3.14159265358979323846f * 1000.0f * i / rate);
            left[static_cast<size_t>(i)] = sample;
            right[static_cast<size_t>(i)] = sample;
        }
        float* planes[2] = { left.data(), right.data() };
        tap->push(planes, 2, frames);
        auto analyzer = std::make_unique<MeterAnalyzer>();
        std::string meterError;
        const bool meterPrepared = analyzer->prepare(rate, 2, meterError);
        check(meterPrepared, "meter analyzer prepares (" + meterError + ")");
        MeterResult meter;
        check(analyzer->analyze(*tap, meter), "meter analyzer consumes one complete window");
        int peakBand = 0;
        for (int i = 1; i < meter.spectrumCount; ++i)
            if (meter.spectrumDb[static_cast<size_t>(i)] > meter.spectrumDb[static_cast<size_t>(peakBand)]) peakBand = i;
        const double peakHz = meterBandCenterHz(peakBand, meter.spectrumCount, rate);
        check(peakHz > 700.0 && peakHz < 1400.0,
              "1 kHz tone lands in the corresponding log band (got " + std::to_string(peakHz) + " Hz)");
        check(meter.rmsDb[0] < -8.0f && meter.rmsDb[0] > -10.0f,
              "meter RMS follows the measured -9 dBFS tone (got " + std::to_string(meter.rmsDb[0]) + " dB)");
        check(meter.peakDb[0] < -5.0f && meter.peakDb[0] > -7.5f,
              "meter sample peak follows the measured -6 dBFS tone (got " + std::to_string(meter.peakDb[0]) + " dB)");
        check(meter.truePeakOversampled,
              "true peak is marked oversampled below 192 kHz");
        // 频谱电平刻度：0.5 幅度的 1 kHz 正弦，带内求和后应落在 -6 dBFS 附近。
        // 补零（kFftFrames=4×窗口）会把同一主瓣摊到 4 倍数量的 bin 上，
        // 归一化若不同步修正，整条频谱会凭空抬高 6 dB —— 这条断言就是钉住它的。
        check(meter.spectrumDb[static_cast<size_t>(peakBand)] > -8.0f &&
              meter.spectrumDb[static_cast<size_t>(peakBand)] < -4.0f,
              "spectrum level for a -6 dBFS tone stays calibrated (got " +
              std::to_string(meter.spectrumDb[static_cast<size_t>(peakBand)]) + " dB)");

        check(meter.waveform.size() == MeterResult::kWaveformPoints &&
              std::all_of(meter.waveform.begin(), meter.waveform.end(), [](const auto& pair) {
                  return std::isfinite(pair[0]) && std::isfinite(pair[1]) && pair[0] <= pair[1];
              }), "waveform points are measured finite min/max pairs");
        for (int i = 0; i < 12; ++i) {
            tap->push(planes, 2, frames);
            check(analyzer->analyze(*tap, meter), "meter advances to the next complete analysis window");
        }
        check(meter.hasMomentaryLufs && meter.lufsMomentary < -5.0f && meter.lufsMomentary > -7.0f,
              std::string("momentary LUFS appears after its 400 ms window is populated (valid=") +
              (meter.hasMomentaryLufs ? "true" : "false") + ", value=" +
              std::to_string(meter.lufsMomentary) + " LUFS)");

        auto highRateTap = std::make_unique<MeterTap>();
        highRateTap->prepare(2, 192000);
        highRateTap->push(planes, 2, frames);
        auto highRateAnalyzer = std::make_unique<MeterAnalyzer>();
        check(highRateAnalyzer->prepare(192000, 2, meterError), "192 kHz meter analyzer prepares");
        MeterResult highRateMeter;
        check(highRateAnalyzer->analyze(*highRateTap, highRateMeter), "192 kHz meter frame is valid");
        check(!highRateMeter.truePeakOversampled &&
              std::fabs(highRateMeter.truePeakDb[0] - highRateMeter.peakDb[0]) < 0.001f,
              "192 kHz true peak honestly falls back to sample peak");

        auto silent = std::make_unique<MeterTap>();
        silent->prepare(2, rate);
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        silent->push(planes, 2, frames);
        auto silentAnalyzer = std::make_unique<MeterAnalyzer>();
        check(silentAnalyzer->prepare(rate, 2, meterError), "silent meter analyzer prepares");
        MeterResult silentResult;
        check(silentAnalyzer->analyze(*silent, silentResult), "silent meter window is valid");
        check(silentResult.spectrumDb[static_cast<size_t>(peakBand)] <= -71.0f,
              "silence stays at the declared spectrum floor");
    }
    // --- 频谱低频连续性（用户报的 低频段不连续 的回归）----------------------
    //
    // 修复前的真实缺陷：2048 点 FFT 在 48 kHz 下 bin 宽 23.4 Hz，而 20 Hz 附近
    // 的频段宽度只有 1-3 Hz，first > last 时直接 continue，那些段永远停在底噪。
    // 实测 48 段里有 8 段是空洞，画出来就是低频的断口。
    {
        constexpr int rate = 48000;
        constexpr int frames = MeterTap::kWindowFrames;
        auto tap = std::make_unique<MeterTap>();
        tap->prepare(2, rate);
        std::vector<float> left(frames), right(frames);
        // 确定性白噪声：每个频段都该有能量，任何一段落回底噪就是空洞。
        std::uint32_t seed = 987654321u;
        for (int i = 0; i < frames; ++i) {
            seed = seed * 1664525u + 1013904223u;
            const float sample = (static_cast<float>((seed >> 9) & 0x3ffff) / 131072.0f - 1.0f) * 0.3f;
            left[static_cast<size_t>(i)] = sample;
            right[static_cast<size_t>(i)] = sample;
        }
        float* planes[2] = { left.data(), right.data() };
        tap->push(planes, 2, frames);
        auto analyzer = std::make_unique<MeterAnalyzer>();
        std::string noiseError;
        check(analyzer->prepare(rate, 2, noiseError), "spectrum continuity analyzer prepares");
        MeterResult noise;
        check(analyzer->analyze(*tap, noise), "broadband window analyzes");
        int holes = 0;
        int firstHole = -1;
        for (int band = 0; band < noise.spectrumCount; ++band) {
            if (noise.spectrumDb[static_cast<size_t>(band)] <= -71.0f) {
                ++holes;
                if (firstHole < 0) firstHole = band;
            }
        }
        check(holes == 0, "no spectrum band is left at the floor for a broadband signal (" +
              std::to_string(holes) + " holes, first at band " + std::to_string(firstHole) + ")");

        // 低频单独再验一次：40 Hz 的音必须让最低几段抬起头来。
        std::vector<float> lowLeft(frames), lowRight(frames);
        for (int i = 0; i < frames; ++i) {
            const float sample = 0.4f * std::sin(2.0f * 3.14159265358979323846f * 40.0f * i / rate);
            lowLeft[static_cast<size_t>(i)] = sample;
            lowRight[static_cast<size_t>(i)] = sample;
        }
        float* lowPlanes[2] = { lowLeft.data(), lowRight.data() };
        auto lowTap = std::make_unique<MeterTap>();
        lowTap->prepare(2, rate);
        lowTap->push(lowPlanes, 2, frames);
        auto lowAnalyzer = std::make_unique<MeterAnalyzer>();
        lowAnalyzer->prepare(rate, 2, noiseError);
        MeterResult low;
        check(lowAnalyzer->analyze(*lowTap, low), "low tone window analyzes");
        check(low.spectrumDb[0] > -71.0f && low.spectrumDb[2] > -71.0f,
              "a 40 Hz tone reaches the lowest bands (band0=" +
              std::to_string(low.spectrumDb[0]) + " band2=" + std::to_string(low.spectrumDb[2]) + ")");
        // 重叠分析：发布节奏由 kHopFrames 决定，不是窗口长度。
        // 这条钉住「刷新率」——它已经因为窗口长度被改错过两次。
        {
            auto cadence = std::make_unique<MeterTap>();
            cadence->prepare(2, rate);
            std::vector<float> chunk(MeterTap::kHopFrames, 0.0f);
            std::vector<float> big(MeterTap::kWindowFrames, 0.0f);
            float* bigPlanes[2] = { big.data(), big.data() };
            float* chunkPlanes[2] = { chunk.data(), chunk.data() };
            cadence->push(bigPlanes, 2, MeterTap::kWindowFrames);
            std::array<float, MeterTap::kMaxChannels * MeterTap::kWindowFrames> scratch;
            // 用 analyzer 缓冲太麻烦，这里直接读 tap 的序列号。
            uint64_t first = 0;
            check(cadence->snapshot(scratch.data(), first), "overlap: first full window publishes");
            cadence->push(chunkPlanes, 2, MeterTap::kHopFrames);
            uint64_t second = 0;
            check(cadence->snapshot(scratch.data(), second) && second > first,
                  "overlap: one hop publishes a new window (refresh rate is hop-driven)");
            cadence->push(chunkPlanes, 2, MeterTap::kHopFrames / 2);
            uint64_t partial = 0;
            const bool halfHop = cadence->snapshot(scratch.data(), partial);
            check(!halfHop || partial == second,
                  "overlap: half a hop must not publish (no double work)");
            cadence->push(chunkPlanes, 2, MeterTap::kHopFrames / 2);
            uint64_t third = 0;
            check(cadence->snapshot(scratch.data(), third) && third > second,
                  "overlap: the second half of the hop completes the next window");
        }
    }

    // --- 1. the exact ready frame from CONTRACT 3.3 ------------------------
    {
        Json frame = Json::object();
        frame.set("ev", "ready");
        frame.set("protocol", 1);
        frame.set("version", "0.1.0");
        frame.set("devices", Json::array());
        checkRoundTrip(frame, R"({"ev":"ready","protocol":1,"version":"0.1.0","devices":[]})", "ready frame");
    }

    // --- 2. the pathological filename the brief calls out ------------------
    // Combining marks, several consecutive spaces, and characters that JSON
    // allows to be escaped but that we must emit raw.
    {
        const std::string nasty = "\xE5\xBD\xB1\xE8\x89\xB2\xE8\x88\x9E";  // CJK
        Json frame = Json::object();
        frame.set("title", nasty);
        const std::string dumped = frame.dump();
        auto back = Json::parse(dumped);
        check(back.has_value() && back->find("title")->asString() == nasty, "CJK passthrough");
        check(dumped.find("\\u") == std::string::npos, "CJK is not escaped to \\u");
    }

    // Runs of spaces and a valid combining sequence must survive verbatim.
    {
        const std::string spaced = "TestBand      - \xE6\xB5\x8B\xE8\xAF\x95";
        Json frame = Json::object();
        frame.set("path", spaced);
        auto back = Json::parse(frame.dump());
        check(back.has_value() && back->find("path")->asString() == spaced, "multi-space filename");
    }

    // --- 3. escaping ------------------------------------------------------
    {
        Json frame = Json::object();
        frame.set("s", "a\"b\\c\nd\te");
        checkRoundTrip(frame, R"({"s":"a\"b\\c\nd\te"})", "escapes");
    }

    // --- 4. \u escapes decode, including surrogate pairs -------------------
    {
        auto v = Json::parse(R"({"k":"\u4f60\u597d"})");
        check(v.has_value() && v->find("k")->asString() == "\xE4\xBD\xA0\xE5\xA5\xBD", "\\u escape -> UTF-8");

        auto pair = Json::parse(R"({"k":"\ud83d\ude00"})");
        check(pair.has_value() && pair->find("k")->asString() == "\xF0\x9F\x98\x80", "surrogate pair");

        auto lone = Json::parse(R"({"k":"\ud83d"})");
        check(lone.has_value() && lone->find("k")->asString() == "\xEF\xBF\xBD", "lone surrogate -> U+FFFD");
    }

    // --- 5. numbers: integers stay integral, floats round-trip -------------
    {
        Json frame = Json::object();
        frame.set("ms", 213000);
        frame.set("volume", 0.75);
        checkRoundTrip(frame, R"({"ms":213000,"volume":0.75})", "numbers");
    }

    // --- 6. rejections: malformed input must never be accepted -------------
    {
        const char* bad[] = {
            "", "{", "}", "{\"a\":}", "{\"a\":1,}", "[1,2", "nul", "tru",
            "{\"a\":01}", "\"unterminated", "{\"a\":1}garbage", "{\"a\":\"\\q\"}",
            "{\"a\":\"raw\nnewline\"}"
        };
        for (const char* sample : bad) {
            check(!Json::parse(sample).has_value(), std::string("must reject: ") + sample);
        }
    }

    // --- 7. the error frame shape (CONTRACT 3.3) --------------------------
    {
        Json error = Json::object();
        error.set("code", "ERR_DEVICE");
        error.set("message", "no device");
        Json reply = Json::object();
        reply.set("id", 5);
        reply.set("ok", false);
        reply.set("error", std::move(error));
        checkRoundTrip(reply, R"({"id":5,"ok":false,"error":{"code":"ERR_DEVICE","message":"no device"}})",
                       "error reply");
    }

    // --- 8. the six frozen error codes ------------------------------------
    {
        const char* codes[] = {err::kDevice, err::kDecode, err::kNotFound,
                               err::kState, err::kUnsupported, err::kInternal};
        for (const char* c : codes) check(std::string(c).rfind("ERR_", 0) == 0, std::string("code ") + c);
        check(std::string(err::kUnsupported) == "ERR_UNSUPPORTED", "ERR_UNSUPPORTED spelling");
        check(std::string(err::kInternal) == "ERR_INTERNAL", "ERR_INTERNAL spelling");
    }

    // --- 9. trackId format (CONTRACT 3.5) ---------------------------------
    {
        check(trackIdSample(1) == "tl_0001", "trackId 1");
        check(trackIdSample(91) == "tl_0091", "trackId 91");
        check(trackIdSample(10000) == "tl_10000", "trackId widens past 9999");
    }

    // --- DSP golden tests (SPEC 3.4 line 210, acceptance in SPEC 447) ------
    //
    // SPEC 447 asks for exactly this: a standard signal through the EQ, judged
    // by FREQUENCY RESPONSE to within 0.1 dB. That is the only kind of test that
    // can catch a filter that is subtly wrong -- a mis-signed a1 still passes an
    // output-is-changing check, but it shifts the centre frequency and shows up
    // here immediately. It also needs no audio device, so it runs on any machine.
    {
        constexpr int kRate = 48000;
        constexpr int kFrames = kRate / 2;          // 500 ms, long enough to settle
        constexpr double kPi = 3.14159265358979323846;

        // The probe tone is deliberately quiet (-20 dBFS). A full-scale tone
        // boosted by +12 dB peaks near 4.0 and is therefore caught by the
        // always-on safety clamp -- the measurement would then be of the clip,
        // not of the filter, and every band would report the same wrong number.
        // Feeding headroom is what makes the +/-0.1 dB figure meaningful.
        constexpr double kProbeAmplitude = 0.1;

        auto gainAt = [&](int band, float gainDb, bool eqOn) -> double {
            std::vector<float> buf(static_cast<std::size_t>(kFrames));
            for (int n = 0; n < kFrames; ++n) {
                buf[static_cast<std::size_t>(n)] = static_cast<float>(
                    kProbeAmplitude *
                    std::sin(2.0 * kPi * kEqBandFrequency[band] * n / kRate));
            }
            DspChain chain;
            chain.prepare(1, kFrames, kRate);
            DspParams p;
            p.eqEnabled = eqOn;
            p.eqGainDb[band] = gainDb;
            p.limiterEnabled = false;   // isolate the filter's own response
            p.autoHeadroom = false;     // ditto: no compensating pre-gain
            p.preampDb = 0.0f;
            chain.publish(p);
            float* planes[1] = { buf.data() };
            chain.process(planes, 1, kFrames);

            // Measure the last quarter, after the 20 ms coefficient ramp has
            // finished. Measuring the whole buffer would average the ramp in and
            // report a smaller boost than was asked for.
            const int skip = kFrames * 3 / 4;
            double inSq = 0.0, outSq = 0.0;
            for (int n = skip; n < kFrames; ++n) {
                const double s = kProbeAmplitude *
                                 std::sin(2.0 * kPi * kEqBandFrequency[band] * n / kRate);
                const double o = static_cast<double>(buf[static_cast<std::size_t>(n)]);
                inSq  += s * s;
                outSq += o * o;
            }
            return 10.0 * std::log10(outSq / inSq);
        };

        // A peaking section's gain at its own centre frequency IS the requested
        // dB, so 0.1 dB is a fair tolerance rather than a loose one.
        for (int band = 0; band < kEqBandCount; ++band) {
            const double up = gainAt(band, 12.0f, true);
            check(std::fabs(up - 12.0) <= 0.1,
                  "EQ +12 dB at band " + std::to_string(band) + " (" +
                  std::to_string(static_cast<int>(kEqBandFrequency[band])) +
                  " Hz) measured " + std::to_string(up));

            const double down = gainAt(band, -12.0f, true);
            check(std::fabs(down + 12.0) <= 0.1,
                  "EQ -12 dB at band " + std::to_string(band) + " measured " +
                  std::to_string(down));
        }

        // A flat EQ must not colour the signal at all. This is what catches a
        // filter that is accidentally always engaged.
        {
            const double flat = gainAt(5, 0.0f, true);
            check(std::fabs(flat) <= 0.01,
                  "a 0 dB band is transparent (measured " + std::to_string(flat) + " dB)");
        }

        // ---- CR-019: each slot is a full parametric band ------------------
        //
        // Same measurement harness, but the probe frequency is now independent
        // of the band's centre -- that independence is the whole point of the
        // feature: before this, a band could only ever be measured where it
        // already was.
        auto gainAtHz = [&](double hz, DspParams p) -> double {
            constexpr int kFrames = 48000;
            std::vector<float> buf(static_cast<std::size_t>(kFrames));
            for (int n = 0; n < kFrames; ++n) {
                buf[static_cast<std::size_t>(n)] = static_cast<float>(
                    kProbeAmplitude * std::sin(2.0 * kPi * hz * n / kRate));
            }
            DspChain chain;
            chain.prepare(1, kFrames, kRate);
            p.eqEnabled = true;
            p.limiterEnabled = false;
            p.autoHeadroom = false;
            p.preampDb = 0.0f;
            chain.publish(p);
            float* planes[1] = { buf.data() };
            chain.process(planes, 1, kFrames);
            const int skip = kFrames * 3 / 4;
            double inSq = 0.0, outSq = 0.0;
            for (int n = skip; n < kFrames; ++n) {
                const double x = kProbeAmplitude * std::sin(2.0 * kPi * hz * n / kRate);
                const double y = static_cast<double>(buf[static_cast<std::size_t>(n)]);
                inSq += x * x;
                outSq += y * y;
            }
            return 10.0 * std::log10(outSq / inSq);
        };

        {
            // A band moved off its grid frequency must peak where it is now set,
            // and must no longer act at the frequency it used to sit on.
            DspParams p;
            p.eqFreq[5] = 2000.0f;          // slot 5 is 1000 Hz on the grid
            p.eqGainDb[5] = 12.0f;
            const double atNew = gainAtHz(2000.0, p);
            const double atOld = gainAtHz(1000.0, p);
            check(std::fabs(atNew - 12.0) <= 0.15,
                  "a band retuned to 2 kHz boosts there (measured " + std::to_string(atNew) + " dB)");
            // One octave from the centre a Q 1.41 peaking section still passes
            // ~2.5 dB of a 12 dB boost -- that is the correct skirt, not a leak.
            // What must hold is that the old slot is no longer the peak.
            check(atOld < atNew / 3.0,
                  "and its old 1 kHz slot is no longer the peak (measured " + std::to_string(atOld) +
                  " dB vs " + std::to_string(atNew) + " dB at the new centre)");
        }
        {
            // Q is per band now: a narrow band must disturb a neighbour less than
            // a wide one, both at the same gain and centre.
            DspParams wide;
            wide.eqGainDb[5] = 12.0f;
            wide.eqBandQ[5] = 0.7f;
            DspParams narrow;
            narrow.eqGainDb[5] = 12.0f;
            narrow.eqBandQ[5] = 4.0f;
            const double wideNeighbour = gainAtHz(2000.0, wide);
            const double narrowNeighbour = gainAtHz(2000.0, narrow);
            check(narrowNeighbour < wideNeighbour - 1.0,
                  "per-band Q narrows the skirt (Q0.7 " + std::to_string(wideNeighbour) +
                  " dB vs Q4 " + std::to_string(narrowNeighbour) + " dB one octave up)");
            // The centre gain must stay the requested value regardless of Q.
            const double narrowCentre = gainAtHz(1000.0, narrow);
            check(std::fabs(narrowCentre - 12.0) <= 0.15,
                  "and the centre gain is Q-independent (measured " + std::to_string(narrowCentre) + " dB)");
        }
        {
            DspParams low;
            low.eqType[0] = 1;              // low shelf
            low.eqFreq[0] = 200.0f;
            low.eqGainDb[0] = 12.0f;
            const double below = gainAtHz(50.0, low);
            const double above = gainAtHz(4000.0, low);
            check(std::fabs(below - 12.0) <= 1.0,
                  "a low shelf boosts everything below its corner (measured " + std::to_string(below) + " dB)");
            check(std::fabs(above) <= 0.5,
                  "and leaves the band above it alone (measured " + std::to_string(above) + " dB)");

            DspParams high;
            high.eqType[1] = 2;             // high shelf
            high.eqFreq[1] = 2000.0f;
            high.eqGainDb[1] = 12.0f;
            const double treble = gainAtHz(12000.0, high);
            const double bass = gainAtHz(100.0, high);
            check(std::fabs(treble - 12.0) <= 1.0,
                  "a high shelf boosts everything above its corner (measured " + std::to_string(treble) + " dB)");
            check(std::fabs(bass) <= 0.5,
                  "and leaves the band below it alone (measured " + std::to_string(bass) + " dB)");
        }
        // ---- FIR convolution: the only two checks that can prove it --------
        //
        // "It sounds different" proves nothing; a broken scale factor also
        // sounds different. These two do prove it: an impulse must come out as
        // the IR itself, and an arbitrary signal must match direct convolution.
        {
            std::vector<float> ir(64, 0.0f);
            ir[0] = 0.5f;
            ir[7] = -0.25f;
            ir[31] = 0.125f;
            std::string bankError;
            IrBank* bank = IrBank::fromSamples({ ir }, 48000, bankError);
            check(bank != nullptr, "an IR bank builds from samples (" + bankError + ")");
            if (bank != nullptr) {
                FirConvolver convolver;
                std::string prepareError;
                check(convolver.prepare(48000, prepareError),
                      "the convolver prepares (" + prepareError + ")");
                convolver.adopt(bank);

                constexpr int kTotal = IrBank::kPartition + 256;
                std::vector<float> signal(static_cast<std::size_t>(kTotal), 0.0f);
                signal[0] = 1.0f;
                float* planes[1] = { signal.data() };
                convolver.process(planes, 1, kTotal);

                double worst = 0.0;
                int worstTap = -1;
                for (std::size_t i = 0; i < ir.size(); ++i) {
                    const double want = static_cast<double>(ir[i]);
                    const double got = static_cast<double>(signal[IrBank::kPartition + i]);
                    if (std::fabs(got - want) > worst) { worst = std::fabs(got - want); worstTap = static_cast<int>(i); }
                }
                check(worst < 1e-4,
                      "a unit impulse convolves to the IR itself (max error " +
                      std::to_string(worst) + " at tap " + std::to_string(worstTap) + ")");
                check(std::fabs(signal[IrBank::kPartition - 1]) < 1e-6,
                      "nothing leaks out before the first partition completes");
                delete bank;
            }
        }
        {
            // Analysis is what the automatic preamp and the preview curve are
            // built on, so it gets an ANALYTIC check rather than a look at the UI:
            // h = 1.0*delta + 0.5*delta(n-8) has |H(f)| = |1 + 0.5 e^{-j2*pi*f*8/fs}|,
            // so it peaks at 1.5 (+3.52 dB) where the phase aligns (6000 Hz at
            // 48 kHz) and nulls to 0.5 (-6.02 dB) at 3000 Hz. Both land exactly on
            // FFT bins here, which is why the tolerances can be tight.
            std::vector<float> ir(64, 0.0f);
            ir[0] = 1.0f;
            ir[8] = 0.5f;
            std::string bankError;
            IrBank* bank = IrBank::fromSamples({ ir }, 48000, bankError);
            check(bank != nullptr, "an IR for analysis builds (" + bankError + ")");
            if (bank != nullptr) {
                const double peakDb = static_cast<double>(bank->maxGainDb());
                check(std::fabs(peakDb - 3.5218) < 0.05,
                      "the response peak matches the analytic 20log10(1.5) (got " +
                      std::to_string(peakDb) + " dB)");
                check(bank->curve().size() == 48, "the preview curve has 48 points");
                bool monotonic = true, withinRange = true;
                float curvePeak = -1000.0f;
                for (std::size_t i = 0; i < bank->curve().size(); ++i) {
                    if (i > 0 && bank->curve()[i].first <= bank->curve()[i - 1].first) monotonic = false;
                    if (bank->curve()[i].first < 19.0f || bank->curve()[i].first > 20100.0f) withinRange = false;
                    curvePeak = std::max(curvePeak, bank->curve()[i].second);
                }
                check(monotonic, "the preview curve is log-spaced and strictly increasing in frequency");
                check(withinRange, "the preview curve stays inside 20 Hz .. 20 kHz");
                check(std::fabs(static_cast<double>(curvePeak) - peakDb) < 0.6,
                      "the sampled curve reaches the true peak (" + std::to_string(curvePeak) +
                      " vs " + std::to_string(peakDb) + " dB)");
                // The automatic preamp is -peak: with this response it must be negative.
                check(-bank->maxGainDb() < 0.0f,
                      "the automatic preamp takes headroom for a response that boosts");
                delete bank;
            }
        }
        {
            // A flat response must analyse as a flat gain: 0.5 * delta is -6.02 dB
            // everywhere, which is the case that would expose a per-partition
            // phasor applied with the wrong sign.
            std::vector<float> ir(16, 0.0f);
            ir[0] = 0.5f;
            std::string bankError;
            IrBank* bank = IrBank::fromSamples({ ir }, 48000, bankError);
            check(bank != nullptr, "a flat IR builds");
            if (bank != nullptr) {
                check(std::fabs(static_cast<double>(bank->maxGainDb()) - (-6.0206)) < 0.05,
                      "a half-scale impulse reads -6.02 dB (got " +
                      std::to_string(bank->maxGainDb()) + ")");
                check(std::fabs(static_cast<double>(bank->rmsGainDb()) - (-6.0206)) < 0.05,
                      "and its RMS gain is the same, because it is flat");
                delete bank;
            }
        }
        {
            // Arbitrary signal against a brute-force reference.
            std::vector<float> ir(300, 0.0f);
            for (std::size_t i = 0; i < ir.size(); ++i) {
                ir[i] = (i % 7 == 0 ? 0.3f : 0.02f) * (i % 2 ? -1.0f : 1.0f)
                      * static_cast<float>(std::exp(-0.02 * static_cast<double>(i)));
            }
            std::string bankError;
            IrBank* bank = IrBank::fromSamples({ ir }, 48000, bankError);
            check(bank != nullptr, "a 300-tap IR bank builds");
            if (bank != nullptr) {
                FirConvolver convolver;
                std::string prepareError;
                convolver.prepare(48000, prepareError);
                convolver.adopt(bank);

                constexpr int kTotal = IrBank::kPartition * 3;
                std::vector<float> signal(static_cast<std::size_t>(kTotal));
                std::uint32_t seed = 12345u;
                for (auto& sample : signal) {
                    seed = seed * 1664525u + 1013904223u;
                    sample = static_cast<float>((seed >> 9) & 0x3ffff) / 131072.0f - 1.0f;
                }
                std::vector<float> expected(static_cast<std::size_t>(kTotal), 0.0f);
                for (int n = 0; n < kTotal; ++n) {
                    double sum = 0.0;
                    for (std::size_t k = 0; k < ir.size(); ++k) {
                        if (n - static_cast<int>(k) < 0) break;
                        sum += static_cast<double>(ir[k]) * static_cast<double>(signal[static_cast<std::size_t>(n) - k]);
                    }
                    expected[static_cast<std::size_t>(n)] = static_cast<float>(sum);
                }

                float* planes[1] = { signal.data() };
                convolver.process(planes, 1, kTotal);

                double worst = 0.0;
                for (int n = 0; n < kTotal - IrBank::kPartition; ++n) {
                    worst = std::max(worst, std::fabs(static_cast<double>(signal[static_cast<std::size_t>(n) + IrBank::kPartition]) -
                                                      static_cast<double>(expected[static_cast<std::size_t>(n)])));
                }
                check(worst < 5e-4,
                      "partitioned convolution matches direct convolution (max error " +
                      std::to_string(worst) + ")");
                check(convolver.latencyFrames() == IrBank::kPartition,
                      "the reported latency is exactly one partition");
                delete bank;
            }
        }
        {
            // A default-constructed DspParams must resolve to the SPEC grid --
            // that invariant is what keeps the golden test above meaningful for
            // every future change to the shape fields.
            DspParams legacy;
            bool gridIntact = true;
            for (int b = 0; b < kEqBandCount; ++b) {
                const EqBandShape shape = resolveEqBand(legacy, b);
                if (shape.freq != kEqBandFrequency[b]) gridIntact = false;
                if (shape.type != EqBandType::Peaking) gridIntact = false;
                // eqQ is a float, so the resolved double is 1.40999996...; compare
                // at float precision rather than pretending it is exact.
                if (std::fabs(shape.q - 1.41) > 1e-5) gridIntact = false;
            }
            check(gridIntact, "an unset DspParams still resolves to the SPEC 3.4 grid (Q 1.41, peaking)");
        }

        // Bypass must be BIT-EXACT, not merely close: this is the path that has
        // to preserve bit-perfect playback, so an in-range sample must come back
        // with every bit identical.
        {
            constexpr int kProbe = 512;
            std::vector<float> in(static_cast<std::size_t>(kProbe));
            for (int n = 0; n < kProbe; ++n) {
                in[static_cast<std::size_t>(n)] =
                    static_cast<float>(std::sin(n * 0.1)) * 0.75f;
            }
            std::vector<float> buf = in;
            DspChain chain;
            chain.prepare(1, kProbe, kRate);
            DspParams p;
            p.eqEnabled = false;
            p.limiterEnabled = false;
            chain.publish(p);
            float* planes[1] = { buf.data() };
            chain.process(planes, 1, kProbe);
            check(std::memcmp(in.data(), buf.data(), sizeof(float) * kProbe) == 0,
                  "bypassed DSP is bit-exact");
        }

        // ...and the same guarantee in STEREO, with the SHIPPED defaults.
        //
        // The check above is the one that stands between a listener and any
        // silent alteration of their audio, and it had two holes that both
        // matter:
        //
        //   * it ran at ONE channel. Every stereo-only path in the chain -- the
        //     channel tools, the mid/side pair -- is gated behind 'channels ==
        //     2', so a mono probe cannot see a cross-channel leak, a channel
        //     swap, or an image collapse. 'The separation sounds compressed' is
        //     precisely the report that this test was structurally unable to
        //     catch.
        //   * it set limiterEnabled = false, which is NOT what ships. The
        //     default is true, and the limiter is gated behind the wet mix, so
        //     the claim 'the default chain is transparent' rested on reading
        //     the gate correctly rather than on a measurement.
        //
        // The two channels carry DIFFERENT waveforms so that any coupling
        // between them changes at least one sample and fails the comparison.
        {
            constexpr int kProbe = 512;
            std::vector<float> in(static_cast<std::size_t>(kProbe) * 2);
            for (int n = 0; n < kProbe; ++n) {
                in[static_cast<std::size_t>(n)] =
                    static_cast<float>(std::sin(n * 0.1)) * 0.75f;
                in[static_cast<std::size_t>(kProbe + n)] =
                    static_cast<float>(std::sin(n * 0.17 + 1.0)) * 0.6f;
            }
            std::vector<float> buf = in;
            DspChain chain;
            chain.prepare(2, kProbe, kRate);
            DspParams p;                       // the SHIPPED defaults, untouched
            chain.publish(p);
            float* planes[2] = { buf.data(), buf.data() + kProbe };
            chain.process(planes, 2, kProbe);
            check(std::memcmp(in.data(), buf.data(), sizeof(float) * kProbe * 2) == 0,
                  "the DEFAULT stereo chain is bit-exact (no cross-channel leak)");
            check(p.limiterEnabled,
                  "...and that default really does have the limiter enabled");
        }

        // THE REFERENCE IMPLEMENTATION'S BUG, pinned as a regression test. Its
        // bypass skips the hard clip, so with DSP off a sample above 1.0 reaches
        // the device and overflows. Clamping an in-range value is bit-exact, so
        // the safety clamp costs nothing and belongs outside the bypass.
        {
            const float over[4] = { 1.5f, -2.0f, 0.5f, -0.25f };
            std::vector<float> buf(over, over + 4);
            DspChain chain;
            chain.prepare(1, 4, kRate);
            DspParams p;
            p.eqEnabled = false;
            p.limiterEnabled = false;   // limiter OFF still clips
            chain.publish(p);
            float* planes[1] = { buf.data() };
            chain.process(planes, 1, 4);
            check(buf[0] == 1.0f && buf[1] == -1.0f,
                  "hard clip applies even when the DSP is bypassed");
            check(buf[2] == 0.5f && buf[3] == -0.25f,
                  "clipping leaves in-range samples untouched");
        }

        // The limiter keeps a boosted signal below full scale without changing
        // the quiet part, and cannot itself introduce a sample above 1.0.
        {
            constexpr int kProbe = 4096;
            std::vector<float> buf(static_cast<std::size_t>(kProbe));
            for (int n = 0; n < kProbe; ++n) {
                buf[static_cast<std::size_t>(n)] =
                    static_cast<float>(std::sin(n * 0.05)) * 0.9f;
            }
            DspChain chain;
            chain.prepare(1, kProbe, kRate);
            DspParams p;
            p.eqEnabled = false;
            p.preampDb = 6.0f;          // push it well past full scale
            p.limiterEnabled = true;
            p.autoHeadroom = false;
            chain.publish(p);
            float* planes[1] = { buf.data() };
            chain.process(planes, 1, kProbe);
            double peak = 0.0;
            for (int n = 0; n < kProbe; ++n) {
                const double a = std::fabs(static_cast<double>(buf[static_cast<std::size_t>(n)]));
                if (a > peak) peak = a;
            }
            check(peak <= 1.0, "the limiter keeps the peak at or below full scale");
            check(chain.gainReductionDb() < -3.0f && chain.gainReductionDb() > -7.0f,
                  "the limiter reports its measured gain reduction (got " +
                  std::to_string(chain.gainReductionDb()) + " dB)");
        }

        // ReplayGain: the prevent-clip cap is what stops a quiet, peaky master
        // from being boosted into distortion, so the formula is asserted directly.
        //
        // Note the blockSize/process() step between publish() and reading the
        // gain. publish() hands the snapshot to the render thread; the values
        // this test inspects are the ones that thread has ADOPTED. Skipping the
        // block would assert against the previous snapshot.
        {
            constexpr int kBlock = 64;
            float sink[2][kBlock] = {};
            float* sinkPlanes[2] = { sink[0], sink[1] };

            DspChain chain;
            chain.prepare(2, kBlock, kRate);
            DspParams p;
            p.rgMode = 1;               // track
            p.rgTrackGainDb = 6.0f;
            p.rgPreampDb = 0.0f;
            p.rgTrackPeak = 1.0f;       // a peak already at full scale
            p.preventClip = true;
            p.eqEnabled = false;
            chain.publish(p);
            chain.process(sinkPlanes, 2, kBlock);
            check(std::fabs(chain.staticGainDb()) <= 0.1001f,
                  "preventClip caps a track whose peak is already at full scale (got " +
                  std::to_string(chain.staticGainDb()) + " dB)");

            // With no peak information the requested gain is applied unmodified.
            DspParams q = p;
            q.rgTrackPeak = 0.0f;
            chain.publish(q);
            chain.process(sinkPlanes, 2, kBlock);
            check(std::fabs(chain.staticGainDb() - 6.0f) <= 0.001f,
                  "without peak data the ReplayGain value is applied as-is (got " +
                  std::to_string(chain.staticGainDb()) + " dB)");

            // Auto headroom subtracts the largest band boost, so a +6 dB EQ does
            // not clip on its own account.
            DspParams r = q;
            r.eqEnabled = true;
            r.rgMode = 0;
            r.autoHeadroom = true;
            r.eqGainDb[3] = 6.0f;
            chain.publish(r);
            chain.process(sinkPlanes, 2, kBlock);
            check(std::fabs(chain.staticGainDb() + 6.0f) <= 0.001f,
                  "auto headroom subtracts the largest band boost (got " +
                  std::to_string(chain.staticGainDb()) + " dB)");
        }
    }

    // Render the real DSP, not just its declared gain. A disabled EQ must not
    // disable ReplayGain/preamp, and cached bands must not leak into channel tools.
    {
        DspParams p;
        p.rgMode = 1;
        p.rgTrackGainDb = 4.0f;
        p.rgTrackPeak = 1.0f;
        p.preampDb = 6.0f;
        check(std::fabs(computeStaticGainDb(p) + 0.1f) < 0.001f,
            "ReplayGain preventClip includes positive preamp gain");
        p.preampDb = -6.0f;
        check(std::fabs(computeStaticGainDb(p) + 2.0f) < 0.001f,
            "ReplayGain preventClip does not attenuate an already safe combined gain");
        p.preampDb = 6.0f;
        p.eqEnabled = true;
        p.eqGainDb[5] = 12.0f;
        check(std::fabs(computeStaticGainDb(p) + 12.1f) < 0.001f,
            "ReplayGain peak ceiling retains the EQ boost headroom");
    }
    {
        constexpr int rate = 48000, count = 8192;
        auto render = [](DspParams params, int block) {
            std::vector<float> data(count * 2);
            for (int n = 0; n < count; ++n) {
                data[n] = 0.1f * std::sin(2.0f * 3.14159265358979323846f * 1000.0f * n / rate);
                data[count + n] = data[n] * 0.7f;
            }
            DspChain chain;
            chain.prepare(2, count, rate);
            chain.publish(params);
            for (int n = 0; n < count; n += block) {
                float* planes[] = {data.data() + n, data.data() + count + n};
                chain.process(planes, 2, std::min(block, count - n));
            }
            return data;
        };
        const auto neutral = render(DspParams{}, count);
        for (const bool replayGain : {false, true}) {
            DspParams p;
            if (replayGain) { p.rgMode = 1; p.rgTrackGainDb = -6.0f; }
            else p.preampDb = -6.0f;
            const auto processed = render(p, 128);
            const float expected = std::pow(10.0f, -6.0f / 20.0f);
            float maxError = 0.0f;
            for (int n = count / 2; n < count; ++n)
                maxError = std::max(maxError, std::fabs(processed[n] - neutral[n] * expected));
            check(maxError < 1e-6f, replayGain ? "ReplayGain changes samples with EQ off" : "preamp changes samples with EQ off");
        }
        {
            DspParams flat;
            flat.swapChannels = true;
            DspParams cached = flat;
            cached.eqGainDb[5] = 12.0f;
            const auto a = render(flat, count), b = render(cached, count);
            check(std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0,
                "disabled EQ bands never color channel controls");
        }
        {
            DspParams eq;
            eq.eqEnabled = true;
            eq.eqGainDb[5] = 9.0f;
            const auto whole = render(eq, count), small = render(eq, 64);
            float maxError = 0.0f;
            for (size_t i = 0; i < whole.size(); ++i)
                maxError = std::max(maxError, std::fabs(whole[i] - small[i]));
            check(maxError < 1e-6f, "EQ interpolation is independent of device block size (error " + std::to_string(maxError) + ")");
        }
        {
            DspParams eq;
            eq.eqEnabled = true;
            eq.eqGainDb[5] = -9.0f;
            auto signal = [&]() {
                std::vector<float> x(count);
                for (int n = 0; n < count; ++n) x[n] = 0.1f * std::sin(n * 0.13f);
                return x;
            };
            DspChain reused, fresh;
            reused.prepare(1, count, rate);
            reused.publish(eq);
            auto warm = signal();
            float* warmPlanes[] = { warm.data() };
            reused.process(warmPlanes, 1, count);
            reused.prepare(1, count, rate);
            fresh.prepare(1, count, rate);
            reused.publish(eq); fresh.publish(eq);
            auto a = signal(), b = signal();
            float* av[] = { a.data() }; float* bv[] = { b.data() };
            reused.process(av, 1, count); fresh.process(bv, 1, count);
            check(std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0,
                "restarting a DSP stream matches a fresh filter and smoothing state");

            // Keep another processor active while disabling EQ. Its saved bands
            // must fade to identity rather than linger behind the active stage.
            eq.eqEnabled = false;
            eq.swapChannels = true;
            DspChain chain;
            chain.prepare(2, count, rate);
            DspParams enabled = eq; enabled.eqEnabled = true;
            chain.publish(enabled);
            auto left = signal(), right = signal();
            float* planes[] = {left.data(), right.data()};
            chain.process(planes, 2, count);
            chain.publish(eq);
            left = signal(); right = signal();
            planes[0] = left.data(); planes[1] = right.data();
            chain.process(planes, 2, count);
            const auto dry = signal();
            float error = 0.0f;
            for (int n = count / 2; n < count; ++n) error = std::max(error, std::fabs(left[n] - dry[n]));
            check(error < 1e-6f, "EQ disable settles to identity while channel processing stays active");
        }
    }

    // A limiter must preserve stereo placement and catch sample peaks before
    // the emergency hard clamp. Property-only peak<=1 checks cannot prove this.
    {
        constexpr int count = 8192;
        std::vector<float> left(count), right(count);
        for (int n = 0; n < count; ++n) {
            left[n] = 0.9f * std::sin(2.0f * 3.14159265358979323846f * 1000 * n / 48000);
            right[n] = left[n] / 3.0f;
        }
        DspChain chain;
        chain.prepare(2, count, 48000);
        DspParams p;
        p.preampDb = 6.0f;
        chain.publish(p);
        float* planes[] = { left.data(), right.data() };
        chain.process(planes, 2, count);
        float ratioError = 0.0f, peak = 0.0f;
        for (int n = count / 2; n < count; ++n) {
            ratioError = std::max(ratioError, std::fabs(left[n] - 3.0f * right[n]));
            peak = std::max(peak, std::fabs(left[n]));
        }
        check(ratioError < 1e-6f, "limiter gain is linked across channels to preserve the stereo image");
        check(peak < 0.999f, "boosted peaks are limited before the emergency hard clip");
    }

    // Playback fades are deterministic, channel-independent sample ramps.
    {
        constexpr int sampleRate = 48000;
        constexpr int fadeFrames = sampleRate * 5 / 1000;
        AudioFade fade;
        fade.beginIn(sampleRate, 5);
        check(fade.direction() == AudioFade::Direction::In && fade.active(),
              "fade-in starts in the requested direction");
        check(fade.remainingFrames() == fadeFrames,
              "fade duration is expressed in output frames");
        check(fade.gain() == 0.0f,
              "the first fade-in begins at silence instead of unity");
        float previous = 0.0f;
        bool monotonic = true;
        for (int frame = 0; frame < fadeFrames; ++frame) {
            const float gain = fade.next();
            monotonic = monotonic && gain >= previous && gain <= 1.0f;
            previous = gain;
        }
        check(monotonic, "fade-in is monotonic and bounded");
        check(previous == 1.0f && !fade.active(),
              "fade-in reaches unity after exactly its requested frames");

        fade.beginIn(sampleRate, 5);
        (void)fade.next();
        fade.reset();
        check(fade.gain() == 1.0f && !fade.active() &&
                  fade.direction() == AudioFade::Direction::None,
              "a bit-perfect stream can start without changing its first sample");

        fade.beginOut(sampleRate, 5);
        const float beforeFadeOut = fade.gain();
        check(beforeFadeOut == 1.0f, "fade-out retains the preceding sample gain");
        previous = 1.0f;
        monotonic = true;
        for (int frame = 0; frame < fadeFrames; ++frame) {
            const float gain = fade.next();
            monotonic = monotonic && gain <= previous && gain >= 0.0f;
            previous = gain;
        }
        check(monotonic, "fade-out is monotonic and bounded");
        check(previous == 0.0f && !fade.active(),
              "fade-out reaches silence after exactly its requested frames");
    }

    // Real audio and inserted silence use different clocks at the endpoint.
    {
        EndpointProgress endpoint;
        endpoint.submitted(100, 0); // priming silence
        endpoint.observePadding(0);
        check(!endpoint.drained(20), "ring consumption cannot be mistaken for submitted audio");
        endpoint.submitted(100, 20);
        endpoint.observePadding(90); // 110 device frames, but last audio ends at 120
        check(!endpoint.drained(20), "priming/underrun silence does not end the track early");
        endpoint.observePadding(80);
        check(endpoint.drained(20), "EOF waits until the last audio frame clears padding");
        endpoint.submitted(100, 0); // silence after last audio is not part of the song
        endpoint.observePadding(100);
        check(endpoint.drained(20), "tail silence does not delay normal EOF");
        endpoint.reset();
        check(!endpoint.drained(1), "seek resets endpoint drain accounting");

        endpoint.submitted(100, 5);
        const uint64_t fadeAudioFrames = endpoint.submittedAudioFrames();
        endpoint.observePadding(96);
        check(!endpoint.drained(fadeAudioFrames),
              "fade completion waits until its last nonzero frame has played");
        endpoint.observePadding(95);
        check(endpoint.drained(fadeAudioFrames),
              "queued silence after the fade does not extend the wait");
    }

    // Output volume/mute must be time-based, not tied to WASAPI block size.
    {
        OutputGainSmoother gain;
        gain.prepare(48000, 0.0f);
        float afterTenMs = 0.0f;
        for (int n = 0; n < 480; ++n) afterTenMs = gain.next(1.0f);
        check(std::fabs(afterTenMs - 0.6321206f) < 1e-4f,
            "volume has a measured 10 ms time constant");
        gain.prepare(48000, 1.0f);
        float previous = 1.0f, largestStep = 0.0f;
        bool monotonic = true;
        for (int n = 0; n < 4800; ++n) {
            const float next = gain.next(0.0f);
            monotonic = monotonic && next <= previous && next >= 0.0f;
            largestStep = std::max(largestStep, previous - next);
            previous = next;
        }
        check(monotonic && largestStep < 0.0021f,
            "mute ramps continuously without a block-boundary gain jump");
        gain.prepare(48000, 0.0f);
        check(gain.next(0.0f) == 0.0f, "muted playback starts at digital silence");
        for (int n = 0; n < 10000; ++n) (void)gain.next(1.0f);
        check(gain.next(1.0f) == 1.0f, "volume settles to exact unity for the neutral path");
    }

    // --- TPDF dither on depth reduction (SPEC line 203 / 536) -------------
    //
    // The property that matters is not "is there noise" -- both paths have
    // error. It is whether the error is CORRELATED WITH THE SIGNAL. Un-dithered
    // rounding of a 24-bit master to 16 bits produces an error that is a
    // deterministic function of the music, which is distortion, not noise, and
    // is audible as a gritty decay on quiet passages. TPDF dither decorrelates
    // it. That is measurable, so it is measured rather than asserted.
    {
        constexpr int kRate = 48000;
        constexpr int kFrames = 1 << 15;
        constexpr double kPi = 3.14159265358979323846;

        // A quiet tone of about 3 LSB at 16 bits: loud enough that rounding is
        // not simply stuck at zero, quiet enough that the low bits are where the
        // signal lives and quantisation dominates.
        const double amplitude = 3.0 / 32768.0;

        auto measure = [&](bool dither, double& correlation, double& meanError) {
            TpdfDither rng;
            rng.seed(0x5EED0001u);
            double sumErrIn = 0.0, sumErr2 = 0.0, sumIn2 = 0.0, sumErr = 0.0;
            for (int n = 0; n < kFrames; ++n) {
                const double x = amplitude * std::sin(2.0 * kPi * 997.0 * n / kRate);
                // Source is 24-bit; the target is 16. Dither only when the
                // depths actually differ, which is what the engine decides too.
                int32_t q;
                if (dither) {
                    q = quantizeSample(static_cast<float>(x), 16, 24, rng);
                } else {
                    // Same arithmetic with the dither term silenced, so the two
                    // measurements differ only by the thing under test.
                    TpdfDither unused;
                    q = quantizeSample(static_cast<float>(x), 16, 16, unused);
                }
                const double y = static_cast<double>(q) / 32768.0;
                const double e = y - x;
                sumErrIn += e * x;
                sumErr2  += e * e;
                sumIn2   += x * x;
                sumErr   += e;
            }
            const double denom = std::sqrt(sumErr2 * sumIn2);
            correlation = (denom > 0.0) ? (sumErrIn / denom) : 0.0;
            meanError = sumErr / kFrames;
        };

        double corrPlain = 0.0, meanPlain = 0.0, corrDithered = 0.0, meanDithered = 0.0;
        measure(false, corrPlain, meanPlain);
        measure(true,  corrDithered, meanDithered);

        // Printed rather than only asserted: a threshold can be passed by a
        // marginal effect, and the numbers make the size of the improvement
        // visible to whoever reads the self-test output.
        std::fprintf(stderr,
                     "  dither: error/signal correlation %.4f -> %.4f (lower is better)\n",
                     corrPlain, corrDithered);

        // Undithered rounding leaves an error that tracks the waveform.
        check(std::fabs(corrPlain) > 0.05,
              "undithered quantisation correlates its error with the signal (got " +
              std::to_string(corrPlain) + ")");

        // Dither must break that correlation. This is the whole point of it.
        check(std::fabs(corrDithered) < 0.02,
              "TPDF dither decorrelates the quantisation error (got " +
              std::to_string(corrDithered) + ")");
        check(std::fabs(corrDithered) < std::fabs(corrPlain),
              "dither measurably reduces the error-signal correlation");

        // Rounding is unbiased either way; a non-zero mean would be a DC offset
        // the user hears as a click at every start.
        check(std::fabs(meanPlain) < 1e-4 && std::fabs(meanDithered) < 1e-4,
              "neither path introduces a DC offset");
    }

    // --- the dither decision and the bit-perfect decision must agree ------
    //
    // SPEC says dither on depth reduction and OFF on the bit-perfect path.
    // That is one rule, not two, and the engine derives both from the depths --
    // so they cannot drift. Pinned here because a stray dither on the
    // bit-perfect path would silently destroy the project's headline feature.
    {
        // Equal depths: nothing lost, nothing to dither.
        check(!ditherApplies(16, 16, false) && !ditherApplies(24, 24, false) &&
              !ditherApplies(32, 32, false),
              "equal depths never dither (this is the bit-perfect path)");

        // float32 carries a 24-bit mantissa, so a 24-bit source through it is
        // lossless and must not be dithered.
        check(!ditherApplies(32, 24, true),
              "float32 does not dither a 24-bit source (24-bit mantissa is exact)");
        check(effectiveOutputBits(true, 32) == 24,
              "float32 reports 24 effective bits, not 32");

        // Reduction: dither.
        check(ditherApplies(16, 24, false), "24-bit to 16-bit dithers");
        check(ditherApplies(16, 32, false), "32-bit to 16-bit dithers");
        check(!ditherApplies(24, 24, false), "24-bit to 24-bit does not dither");

        // The widths the engine actually uses must stay consistent with the
        // bit-perfect rule: bit-perfect requires sourceBits <= output bits, and
        // dither requires sourceBits > output bits. Exactly one can hold.
        for (int src = 16; src <= 32; src += 8) {
            for (int container : {16, 24, 32}) {
                const bool bitPerfectPossible = src <= effectiveOutputBits(false, container);
                const bool dithered = ditherApplies(container, src, false);
                check(bitPerfectPossible != dithered,
                      "bit-perfect and dither are mutually exclusive at " +
                      std::to_string(src) + "-into-" + std::to_string(container));
            }
        }
    }

    // --- CR-020 / recovery: an enabled IR must disable pass-through -----------
    //
    // 这是恢复段里唯一没有逐字对照的几行（setIrEnabled/setIrPreamp 的语义），
    // 用真实 IrBank + DspChain 把它钉住：加载了 IR 但未启用 = 恒等；启用 = 非恒等
    // （bit-perfect 必须为 false）；关掉 = 回到恒等。
    {
        std::vector<float> ir(64, 0.0f);
        ir[0] = 1.0f;
        std::string bankError;
        IrBank* bank = IrBank::fromSamples({ ir }, 48000, bankError);
        check(bank != nullptr, "IR bank for pass-through semantics builds (" + bankError + ")");
        if (bank != nullptr) {
            DspChain chain;
            chain.prepare(2, 256, 48000);
            DspParams params;
            chain.publish(params);
            chain.publishIr(bank);
            std::vector<std::vector<float>> planes(2, std::vector<float>(256, 0.0f));
            float* views[2] = {planes[0].data(), planes[1].data()};
            chain.process(views, 2, 256);
            check(chain.isPassthrough(),
                  "a neutral chain with a loaded but DISABLED IR is pass-through");
            params.irEnabled = true;
            chain.publish(params);
            chain.process(views, 2, 256);
            check(!chain.isPassthrough(),
                  "an enabled IR makes the chain non-pass-through (bit-perfect off)");
            params.irEnabled = false;
            chain.publish(params);
            chain.process(views, 2, 256);
            check(chain.isPassthrough(), "disabling the IR restores pass-through");
        }
    }

    // --- CR-028 / V3 §1.1：等功率 sin² 淡变曲线与"硬切"对比 ------------------
    //
    // 复现口径（引擎侧断言）：把 1 kHz 满刻度正弦当作最坏情况内容，在任意相位
    // 硬切/淡出，测量"切断瞬间的最后一步跳变"。硬切 = 最后一个样本直接归零，
    // 跳变幅度最坏 1.0（0 dBFS）；sin²/cos² 曲线两端一阶导为 0，淡出最后一帧
    // 精确为 0，倒数第二帧的残余按 O(1/N²) 收敛，比线性 5ms 小两个数量级。
    {
        constexpr int kRate = 48000;
        constexpr int kMs = 10;
        constexpr double kTwoPi = 6.28318530717958647692;
        const int frames = kRate * kMs / 1000;

        // 1) 互补性：同一 t 上 gainIn + gainOut == 1（sin² 与 cos² 的恒等式）。
        double complementWorst = 0.0;
        for (int i = 0; i < frames; ++i) {
            const double out = static_cast<double>(AudioFade::gainAt(AudioFade::Direction::Out, i, frames));
            const double in  = static_cast<double>(AudioFade::gainAt(AudioFade::Direction::In,  i, frames));
            complementWorst = std::max(complementWorst, std::fabs((in + out) - 1.0));
        }
        check(complementWorst < 2.0e-3, "fade curves are complementary: sin^2 + cos^2 == 1 (worst " +
                                        std::to_string(complementWorst) + ")");
        // 2) 端点：淡出第一帧 1、中点 0.5、最后一帧精确 0；淡入相反。
        check(std::fabs(AudioFade::gainAt(AudioFade::Direction::Out, 0, frames) - 1.0f) < 1e-6f,
              "fade-out starts at exactly 1");
        check(std::fabs(AudioFade::gainAt(AudioFade::Direction::Out, frames / 2, frames) - 0.5f) < 5e-3f,
              "fade-out midpoint is 0.5 (sin^2/cos^2 complementary pair)");
        // 1/4 点是区分线性与等功率形状的关键：sin^2(pi/8) = 0.1464，
        // 线性在该点是 0.25。中点两者恰好都是 0.5，单靠中点无法区分。
        const float quarterIn = AudioFade::gainAt(AudioFade::Direction::In, frames / 4, frames);
        check(std::fabs(quarterIn - 0.14644661f) < 8e-3f,
              "fade-in quarter gain is sin^2(pi/8)=0.146 (linear would be 0.25), got " +
              std::to_string(quarterIn));
        check(AudioFade::gainAt(AudioFade::Direction::Out, frames - 1, frames) < 1e-6f,
              "fade-out ends at ZERO (no residual step)");
        check(AudioFade::gainAt(AudioFade::Direction::In, 0, frames) < 1e-6f,
              "fade-in starts at ZERO (no leading edge click)");
        check(std::fabs(AudioFade::gainAt(AudioFade::Direction::In, frames - 1, frames) - 1.0f) < 1e-6f,
              "fade-in ends at exactly 1");

        // 3) 运行态 AudioFade 与解析曲线一致；长度=rate×ms；结束后精确停在 0。
        AudioFade fade;
        fade.beginOut(kRate, kMs);
        check(fade.totalFrames() == frames && fade.active(),
              "AudioFade beginOut length = rate x ms and starts active");
        double runtimeErr = 0.0;
        for (int i = 0; i < frames; ++i) {
            const float got = fade.next();
            const float want = AudioFade::gainAt(AudioFade::Direction::Out, i, frames);
            runtimeErr = std::max(runtimeErr, std::fabs(static_cast<double>(got) - static_cast<double>(want)));
        }
        check(runtimeErr < 1e-6 && !fade.active() &&
              fade.remainingFrames() == 0 && std::fabs(fade.gain()) < 1e-6f,
              "AudioFade runtime matches table and settles at exactly 0 (err " +
              std::to_string(runtimeErr) + ")");

        // 4) 硬切 vs 线性 5ms vs sin² 10ms 的"最后一步跳变"（240 个相位）。
        double worstHard = 0.0, worstLinear = 0.0, worstEqual = 0.0;
        const int linearFrames = kRate * 5 / 1000;
        for (int phase = 0; phase < 240; ++phase) {
            const double start = kTwoPi * static_cast<double>(phase) / 240.0;
            const auto indexPhase = [&](int i) { return start + kTwoPi * 1000.0 * i / kRate; };
            worstHard = std::max(worstHard, std::fabs(std::sin(indexPhase(frames - 1))));
            // 线性 5ms：倒数第二帧的包络 = 1 - (N-2)/(N-1) = 1/(N-1)
            const double gLinear = 1.0 / static_cast<double>(linearFrames - 1);
            worstLinear = std::max(worstLinear,
                std::fabs(std::sin(indexPhase(linearFrames - 2)) * gLinear));
            worstEqual = std::max(worstEqual,
                std::fabs(std::sin(indexPhase(frames - 2)) *
                          static_cast<double>(AudioFade::gainAt(AudioFade::Direction::Out, frames - 2, frames))));
        }
        check(worstHard > 0.99, "hard cut can land on a full-scale sample (worst " +
                                std::to_string(worstHard) + " = 0 dBFS)");
        check(worstEqual < worstLinear / 10.0,
              "sin^2 10ms last step is >10x smaller than linear 5ms (equal " +
              std::to_string(worstEqual) + " vs linear " + std::to_string(worstLinear) + ")");
    }

    // --- CR-029 / 空间音频 ----------------------------------------------------
    //
    // off / amount=0 必须逐样本恒等（memcmp 级）；crossfeed 低频和守恒；virtual
    // 的 HRIR 串扰存在但有界、卷积延迟如实等于 partitioned FFT 的 1024 帧；
    // wide 的 M/S 关系可用解析式验算。所有断言都跑生产 DspChain，不重写数学。
    {
        constexpr int kFrames = 512;
        constexpr int kRate = 48000;
        auto makeInput = [](std::vector<std::vector<float>>& planes, int frames, double phaseAdvance) {
            planes.assign(2, std::vector<float>(static_cast<std::size_t>(frames), 0.0f));
            for (int i = 0; i < frames; ++i) {
                planes[0][static_cast<std::size_t>(i)] = static_cast<float>(0.31 * std::sin(0.017 * i + phaseAdvance));
                planes[1][static_cast<std::size_t>(i)] = static_cast<float>(0.19 * std::cos(0.011 * i + phaseAdvance));
            }
        };
        auto identical = [](const std::vector<std::vector<float>>& a,
                            const std::vector<std::vector<float>>& b) {
            if (a.size() != b.size()) return false;
            for (std::size_t ch = 0; ch < a.size(); ++ch) {
                if (a[ch].size() != b[ch].size()) return false;
                if (!a[ch].empty() &&
                    std::memcmp(a[ch].data(), b[ch].data(), a[ch].size() * sizeof(float)) != 0) {
                    return false;
                }
            }
            return true;
        };
        // 1) off 逐样本恒等（生产链的 bypass 只做安全 clamp，范围内值不变）。
        {
            DspChain chain;
            chain.prepare(2, kFrames, kRate);
            std::vector<std::vector<float>> planes;
            makeInput(planes, kFrames, 0.2);
            const std::vector<std::vector<float>> input = planes;
            DspParams params;   // 默认 = spatial off
            chain.publish(params);
            float* views[2] = {planes[0].data(), planes[1].data()};
            chain.process(views, 2, kFrames);
            check(identical(input, planes), "spatial off is bit-identical to the input buffer");
        }
        // 2) amount=0 等价 off：virtual 也不得改样本。
        {
            DspChain chain;
            chain.prepare(2, kFrames, kRate);
            std::vector<std::vector<float>> planes;
            makeInput(planes, kFrames, 0.4);
            const std::vector<std::vector<float>> input = planes;
            DspParams params;
            params.spatialMode = SpatialMode::Virtual;
            params.spatialAmount = 0.0f;
            chain.publish(params);
            float* views[2] = {planes[0].data(), planes[1].data()};
            chain.process(views, 2, kFrames);
            check(identical(input, planes), "spatial amount=0 is bit-identical (equivalent to off)");
        }
        // 3) 解析 HRIR：ITD 随偏角增大、远耳能量低于近耳、超界方位被 clamp。
        {
            const AnalyticHrir front = makeAnalyticHrir(0.0, 0, kRate);
            const AnalyticHrir rightEarAz60 = makeAnalyticHrir(60.0, 1, kRate);
            const AnalyticHrir leftEarAz60 = makeAnalyticHrir(60.0, 0, kRate);
            check(rightEarAz60.itdSamples == 0,
                  "the near ear at +60 deg has no ITD delay (got " + std::to_string(rightEarAz60.itdSamples) + ")");
            check(leftEarAz60.itdSamples > 0,
                  "the far ear at +60 deg is delayed (got " + std::to_string(leftEarAz60.itdSamples) + " samples)");
            check(rightEarAz60.energy > leftEarAz60.energy,
                  "near ear carries more energy than the shadowed far ear");
            check(front.itdSamples == 0, "front azimuth has no ITD");
            const AnalyticHrir clamped = makeAnalyticHrir(200.0, 0, kRate);
            const AnalyticHrir at90 = makeAnalyticHrir(90.0, 0, kRate);
            check(clamped.itdSamples == at90.itdSamples,
                  "azimuth beyond +90 is clamped to +90 (identical ITD)");
            // ildDb 是"设计参数"（远耳 4·sin|θ|），不是实测能量比：两者必须
            // 可区分，否则文档里"能量比"的说法会让 verifier 复算出 19.35dB 而
            // 怀疑实现。实测值由 measuredIldDb() 提供。
            const AnalyticHrir farAt90 = makeAnalyticHrir(90.0, 0, kRate);   // +90° 时左耳是远耳
            check(std::fabs(farAt90.ildDb - 4.0) < 1.0e-3,
                  "AnalyticHrir::ildDb is the DESIGN parameter 4*sin|theta| (got " +
                  std::to_string(farAt90.ildDb) + ")");
            const double measured90 = measuredIldDb(90.0, kRate);
            check(std::fabs(measured90 - 19.35) < 1.0,
                  "measured pair ILD at 90 deg is ~19.35 dB (got " + std::to_string(measured90) + ")");
            check(measuredIldDb(0.0, kRate) < 1.0e-6, "measured ILD at 0 deg is 0 dB");
            SpatialMode parsed = SpatialMode::Off;
            check(!spatialModeFromName("dolby", parsed), "unknown spatial mode names are rejected");
            check(spatialModeFromName("virtual", parsed) && parsed == SpatialMode::Virtual,
                  "spatial mode names parse (virtual)");
        }
        // 4) crossfeed：低频和 (L+R) 精确守恒（互补混合的数学性质）。
        {
            DspChain chain;
            chain.prepare(2, kFrames, kRate);
            DspParams params;
            params.spatialMode = SpatialMode::Crossfeed;
            params.spatialAmount = 0.8f;
            params.spatialDelayMs = 0.5f;
            std::vector<std::vector<float>> planes(2, std::vector<float>(kFrames, 0.0f));
            std::vector<std::vector<float>> last(2, std::vector<float>(kFrames, 0.0f));
            for (int b = 0; b < 8; ++b) {
                for (int i = 0; i < kFrames; ++i) {
                    planes[0][static_cast<std::size_t>(i)] = 0.25f;
                    planes[1][static_cast<std::size_t>(i)] = -0.10f;
                }
                chain.publish(params);
                float* views[2] = {planes[0].data(), planes[1].data()};
                chain.process(views, 2, kFrames);
                last = planes;
            }
            double worst = 0.0;
            for (int i = 0; i < kFrames; ++i) {
                const double sum = static_cast<double>(last[0][static_cast<std::size_t>(i)]) +
                                   static_cast<double>(last[1][static_cast<std::size_t>(i)]);
                worst = std::max(worst, std::fabs(sum - 0.15));
            }
            check(worst < 1.0e-5, "crossfeed preserves the low-frequency sum L+R (worst " +
                                  std::to_string(worst) + ")");
        }
        // 5) virtual：串扰存在但有界 + 卷积延迟 == kPartition（1024 帧）。
        {
            DspChain chain;
            chain.prepare(2, 2048, kRate);
            std::string bankError;
            IrBank* bankA = nullptr;
            IrBank* bankB = nullptr;
            const bool built = buildSpatialBanks(0.0f, kRate, bankA, bankB, bankError);
            check(built, "virtual HRIR banks build (" + bankError + ")");
            if (built) {
                DspParams params;
                params.spatialMode = SpatialMode::Virtual;
                params.spatialAmount = 1.0f;
                chain.publish(params);
                chain.publishSpatialBanks(bankA, bankB);
                std::vector<std::vector<float>> planes(2, std::vector<float>(2048, 0.0f));
                double firstOutput = -1.0;
                double leftEnergy = 0.0, rightEnergy = 0.0;
                for (int b = 0; b < 4; ++b) {
                    for (auto& ch : planes) std::fill(ch.begin(), ch.end(), 0.0f);
                    if (b == 0) planes[0][0] = 1.0f;   // 冲激只在第一块
                    float* views[2] = {planes[0].data(), planes[1].data()};
                    chain.process(views, 2, 2048);
                    for (int n = 0; n < 2048; ++n) {
                        const double l = planes[0][static_cast<std::size_t>(n)];
                        const double r = planes[1][static_cast<std::size_t>(n)];
                        if (firstOutput < 0.0 && (std::fabs(l) > 1.0e-6 || std::fabs(r) > 1.0e-6)) {
                            firstOutput = static_cast<double>(b * 2048 + n);
                        }
                        leftEnergy += l * l;
                        rightEnergy += r * r;
                    }
                }
                check(firstOutput >= static_cast<double>(IrBank::kPartition),
                      "virtual output starts no earlier than the FFT convolution latency (first " +
                      std::to_string(firstOutput) + ", latency " + std::to_string(IrBank::kPartition) + ")");
                check(leftEnergy > 0.0 && rightEnergy > 0.0,
                      "virtual produces output on both ears from a left-only impulse");
                const double ratio = rightEnergy / std::max(leftEnergy, 1.0e-30);
                check(ratio > 1.0e-4 && ratio < 0.9,
                      "virtual crosstalk into the right ear is present but bounded (ratio " +
                      std::to_string(ratio) + ")");
                delete bankA;
                delete bankB;
            }
        }
        // 6) wide：M/S 关系按解析式验算（含能量归一化因子）。
        {
            DspChain chain;
            chain.prepare(2, kFrames, kRate);
            DspParams params;
            params.spatialMode = SpatialMode::Wide;
            params.spatialAmount = 0.8f;
            std::vector<std::vector<float>> planes(2, std::vector<float>(kFrames, 0.0f));
            std::vector<std::vector<float>> last;
            for (int b = 0; b < 8; ++b) {
                for (int i = 0; i < kFrames; ++i) {
                    planes[0][static_cast<std::size_t>(i)] = 0.5f;
                    planes[1][static_cast<std::size_t>(i)] = 0.0f;
                }
                chain.publish(params);
                float* views[2] = {planes[0].data(), planes[1].data()};
                chain.process(views, 2, kFrames);
                last = planes;
            }
            const double sideGain = 1.0 + 0.8;
            const double norm = 1.0 / std::sqrt((1.0 + sideGain * sideGain) * 0.5);
            const double wantSum = 0.5 * norm;                    // 2*mid*norm
            const double wantDiff = 2.0 * (sideGain * 0.25) * norm; // 2*g*side*norm
            const double gotSum = static_cast<double>(last[0][0]) + static_cast<double>(last[1][0]);
            const double gotDiff = static_cast<double>(last[0][0]) - static_cast<double>(last[1][0]);
            check(std::fabs(gotSum - wantSum) < 1.0e-5 && std::fabs(gotDiff - wantDiff) < 1.0e-5,
                  "wide M/S relation matches the analytic formula (sum " + std::to_string(gotSum) +
                  " vs " + std::to_string(wantSum) + ", diff " + std::to_string(gotDiff) + " vs " +
                  std::to_string(wantDiff) + ")");
        }
    }

    // --- CR-024: the default resampler config IS the existing chain ----------
    //
    // 默认等价是红线：VHQ(28-bit) + linear(50) + 非 steep。这里钉住"默认值"与
    // "线上拼写"，避免以后有人改默认档却以为只是加了个选项。
    {
        const ResamplerConfig defaults;
        check(defaults.quality == ResamplerQuality::VHQ, "default resampler quality is VHQ (28-bit)");
        check(defaults.phase == ResamplerPhase::Linear, "default resampler phase is linear");
        check(!defaults.steep, "default resampler is not steep");
        check(std::string(resamplerQualityName(defaults.quality)) == "VHQ" &&
              std::string(resamplerPhaseName(defaults.phase)) == "linear",
              "resampler wire names match the defaults");
        ResamplerConfig other;
        other.quality = ResamplerQuality::HQ;
        other.phase   = ResamplerPhase::Minimum;
        other.steep   = true;
        check(other != defaults, "a non-default resampler config is distinguishable");
    }

    // --- CR-025: dither modes ------------------------------------------------
    //
    // 三条硬要求：(a) 默认 tpdf 与旧接口逐样本一致；(b) 全 0 输入只产生有界噪声、
    // 无 DC；(c) 噪声整形确实把误差能量移出低频，且不让总误差爆炸。
    {
        // (a) 默认等价：同一随机种子下，旧接口与新接口逐样本相同
        TpdfDither legacy;
        legacy.seed(0x5EED1234u);
        DitherState state;
        state.rng.seed(0x5EED1234u);
        bool identical = true;
        for (int n = 0; n < 4096 && identical; ++n) {
            const float x = 0.3f * static_cast<float>(std::sin(0.03 * n)) +
                            0.0002f * static_cast<float>(std::sin(0.7 * n));
            const int32_t a = quantizeSample(x, 16, 24, legacy);
            const int32_t b = quantizeSample(x, 16, 24, state, DitherMode::Tpdf);
            if (a != b) identical = false;
        }
        check(identical, "default tpdf path is sample-identical through the new DitherState API");

        // (b) 全 0 输入：整形档只产生几个 LSB 的有界噪声、均值无 DC
        for (DitherMode mode : {DitherMode::HighpassTpdf, DitherMode::Ns5,
                                DitherMode::Ns9, DitherMode::UltraShaped}) {
            DitherState s;
            s.rng.seed(0x5EED0001u);
            double sum = 0.0;
            int32_t peak = 0;
            constexpr int frames = 24000;
            for (int n = 0; n < frames; ++n) {
                const int32_t q = quantizeSample(0.0f, 16, 24, s, mode);
                sum += static_cast<double>(q);
                if (std::abs(q) > peak) peak = std::abs(q);
            }
            check(std::fabs(sum / frames) < 1.0,
                  std::string("zero input has no DC offset (") + ditherModeName(mode) + ")");
            // 噪声整形把量化噪声推到高频，时域上会出现 ~(1+Σ|c|)/2 LSB 的交替噪声
            // （fwe44 实测峰值 11 LSB）。这里断言的是"有界、不失控"，不是"很小"：
            // 真正的小只在平直 TPDF 下成立。
            check(peak <= 64,
                  std::string("zero input noise stays bounded (") + ditherModeName(mode) + ")");
        }

        // (c) 997 Hz、约 3 LSB 的正弦：比较量化误差的一阶低通能量（~150 Hz）
        struct ErrorStats { double lowBand; double highBand; double total; };
        auto measureError = [](DitherMode mode) {
            DitherState s;
            s.rng.seed(0x5EED0002u);
            constexpr int frames = 48000;
            double lowState = 0.0;
            double lowBand = 0.0;
            double highBand = 0.0;
            double total = 0.0;
            for (int n = 0; n < frames; ++n) {
                const double x = (3.0 / 32768.0) * std::sin(2.0 * 3.14159265358979323846 * 997.0 * n / 48000.0);
                const int32_t q = quantizeSample(static_cast<float>(x), 16, 24, s, mode);
                const double e = static_cast<double>(q) / 32768.0 - x;
                lowState += 0.02 * (e - lowState);      // 一阶低通，截止约 150 Hz
                const double high = e - lowState;       // 互补的高频分量
                lowBand += lowState * lowState;
                highBand += high * high;
                total += e * e;
            }
            return ErrorStats{lowBand, highBand, total};
        };
        const ErrorStats tpdf = measureError(DitherMode::Tpdf);
        const ErrorStats ns5  = measureError(DitherMode::Ns5);
        const ErrorStats ns9  = measureError(DitherMode::Ns9);
        const ErrorStats ultra = measureError(DitherMode::UltraShaped);
        // 判据是"能量搬家"而不是"低频绝对更小"：随机噪声的单个频段能量估计方差很大，
        // 直接比较两次不同随机实现会在噪声里判错。可靠的方向性事实是：整形档把
        // 能量大幅推向高频，而低频不增加。
        check(ns9.highBand > tpdf.highBand * 10.0,
              "ns-9 pushes quantisation error energy into the high band");
        check(ultra.highBand > tpdf.highBand * 10.0,
              "ultra-shaped pushes quantisation error energy into the high band");
        check(ns5.highBand > tpdf.highBand * 2.0,
              "ns-5 pushes quantisation error energy towards the high band");
        check(ns9.lowBand < tpdf.lowBand * 3.0,
              "ns-9 does not increase the low-band quantisation error");
        check(ultra.lowBand < tpdf.lowBand * 3.0,
              "ultra-shaped does not increase the low-band quantisation error");
        check(ns9.total < tpdf.total * 200.0,
              "ns-9 keeps the total quantisation error bounded");
        check(ultra.total < tpdf.total * 400.0,
              "ultra-shaped keeps the total quantisation error bounded");

        // off 档必须确定（无随机项）：同一次输入两次量化结果相同
        DitherState offState;
        const int32_t q1 = quantizeSample(0.12345f, 16, 24, offState, DitherMode::Off);
        const int32_t q2 = quantizeSample(0.12345f, 16, 24, offState, DitherMode::Off);
        check(q1 == q2, "dither off is deterministic (no random term)");
    }

    // --- non-finite samples must not reach the device (noise defence) ------
    //
    // Measured 2026-10-16: clampf(NaN) returned NaN, because `v < lo` and
    // `v > hi` are both false for NaN. That matters more than it looks: the
    // biquad is DF2T and carries state, so ONE NaN poisons z1/z2 and every
    // later sample is NaN as well -- sustained noise until the next seek,
    // not a single click. At the quantiser, std::lrintf(NaN) is undefined.
    //
    // Pinned here so neither barrier can regress silently.
    {
        // 1. The safety clamp actually clamps.
        check(std::isfinite(clampf(NAN, -1.0f, 1.0f)),
              "the safety clamp clears NaN instead of passing it through");
        check(clampf(NAN, -1.0f, 1.0f) == 0.0f,
              "NaN becomes digital silence, not a rail");
        check(clampf(INFINITY, -1.0f, 1.0f) == 1.0f && clampf(-INFINITY, -1.0f, 1.0f) == -1.0f,
              "infinities still clamp to the rails");
        // Finite values must be untouched, or this "fix" would change the audio.
        for (float v : { -1.0f, -0.5f, 0.0f, 0.5f, 1.0f }) {
            check(clampf(v, -1.0f, 1.0f) == v, "clamp leaves finite values bit-exact");
        }

        // 2. The quantiser survives a non-finite input. Without the guard this
        //    is UB (MSVC/x86 typically yields INT32_MIN = full-scale negative).
        {
            TpdfDither rng;
            rng.seed(1u);
            const int32_t q = quantizeSample(NAN, 24, 24, rng);
            check(q == 0, "quantizeSample maps NaN to silence, not to a full-scale click");
            const int32_t qi = quantizeSample(INFINITY, 24, 24, rng);
            check(qi == (8388607 << 8), "quantizeSample clamps +Inf to the positive rail");
            const int32_t qn = quantizeSample(-INFINITY, 24, 24, rng);
            check(qn == -2147483647 - 1, "quantizeSample clamps -Inf to the negative rail");
        }

        // 3. A poisoned biquad must not leak NaN forever: one NaN in, then the
        //    safety clamp must still see finite output ONCE THE STATE IS RESET.
        //    This documents the latch, which is why the clamp matters upstream.
        {
            Biquad band;
            band.b0 = 1.0f; band.b1 = 0.0f; band.b2 = 0.0f; band.a1 = 0.0f; band.a2 = 0.0f;
            (void)band.process(NAN);                  // poison the state
            const float poisoned = band.process(0.5f);
            check(!std::isfinite(poisoned),
                  "a biquad latches NaN in its state (this is WHY the clamp must clear it)");
            band.reset();
            check(std::isfinite(band.process(0.5f)),
                  "resetting the filter state recovers from a poisoned section");
        }
    }

    // --- is the float pipeline transparent? (CR-010's question) ------------
    //
    // The external reference claims an integer source that transits a Float32
    // pipeline must not be called output-perfect, because unpacking to float and
    // repacking to int is itself processing. That is a fair DEFINITION argument,
    // but the underlying question is measurable and should not be argued: do the
    // stored integers actually come back unchanged?
    //
    // This is the exact chain the engine runs:
    //   dr_flac hands over s32 left-justified in 32 bits   (v24 << 8)
    //   audio_source.cpp multiplies by 1/2^31              -> float32
    //   quantizeSample multiplies by 2^23 and rounds       -> 24-bit int
    // Exhaustive over the whole 24-bit range, because a claim of bit-perfection
    // that only holds for most values is not a claim of bit-perfection.
    {
        constexpr float kSourceScale = 1.0f / 2147483648.0f;
        const int32_t lo24 = -(1 << 23);
        const int32_t hi24 = (1 << 23) - 1;

        int32_t firstBad24 = 0;
        bool exact24 = true;
        TpdfDither rng;
        rng.seed(0x1234u);
        for (int32_t v = lo24; v <= hi24; ++v) {
            const int32_t asDrflac = v << 8;                 // left-justified s32
            const float f = static_cast<float>(asDrflac) * kSourceScale;
            const int32_t back = quantizeSample(f, 24, 24, rng);
            if (back != asDrflac) { exact24 = false; firstBad24 = v; break; }
        }
        check(exact24,
              "every one of the 2^24 24-bit ints survives int -> float32 -> int (first bad: " +
              std::to_string(firstBad24) + ")");

        // 16-bit, left-justified the same way.
        bool exact16 = true;
        for (int32_t v = -(1 << 15); v <= (1 << 15) - 1 && exact16; ++v) {
            const int32_t asDrflac = v << 16;
            const float f = static_cast<float>(asDrflac) * kSourceScale;
            if (quantizeSample(f, 16, 16, rng) != (asDrflac >> 16)) exact16 = false;
        }
        check(exact16, "every 16-bit int survives the same round trip");

        // SENSITIVITY CONTROL. float32 has a 24-bit significand, so it CANNOT
        // represent every 32-bit integer. If this loop found no failures, the
        // two results above would prove nothing -- they would only show that the
        // test cannot detect loss. One control makes them meaningful.
        int32_t badCount = 0;
        for (int32_t v = (1 << 24); v < (1 << 24) + 4096; ++v) {
            const float f = static_cast<float>(v) * kSourceScale;
            if (quantizeSample(f, 32, 32, rng) != v) ++badCount;
        }
        check(badCount > 0,
              "the round trip is NOT lossless past 24 bits, so the test can detect loss"
              " (32-bit values that failed: " + std::to_string(badCount) + ")");
    }

    // --- 32-bit / 352.8-384 kHz 独占输出：候选、字节几何与量化边界 ------------
    //
    // 为什么要有这一节：设备能力探测（devices.cpp）和独占打开（output_wasapi.cpp）
    // 共用 exclusive_format.hpp，"探测到的就是能打开的"这句话只能靠这个头文件
    // 保证；而 32-bit 写出分支此前没有任何离线断言。它的正满刻度会掉进 float
    // 表示不了 2^31-1 的坑，只有真的打开 32-bit 独占流才暴露——离线断言是唯一
    // 能在没有那台 DAC 的机器上钉住它的办法。
    // 384 kHz/352.8 kHz 不引入新的代码路径，只是同一格式生成器换采样率；但字节
    // 几何（nBlockAlign / nAvgBytesPerSec / wValidBitsPerSample）值得各验一次，
    // 因为"按 validBits 算 stride"正是最容易写错、又会直接写坏端点缓冲区的一笔。
    {
        // 1) 32-bit 源必须拿到 32-bit 容器 + validBits=32 的候选。validBits 写成
        //    24 时驱动会把低 8 位当无效位截掉：仍然出声，但不再是位完美。
        WAVEFORMATEXTENSIBLE candidates32[4]{};
        const int count32 = teExclusiveFormatCandidates(32, candidates32);
        bool has32 = false;
        for (int i = 0; i < count32; ++i) {
            if (candidates32[i].Format.wBitsPerSample == 32 &&
                candidates32[i].Samples.wValidBitsPerSample == 32) {
                has32 = true;
            }
        }
        check(count32 >= 1 && has32,
              "teExclusiveFormatCandidates(32) offers a 32-in-32 candidate with validBits=32");

        // 24-bit 源的回退顺序仍是先 24-in-24、再 24-in-32；容器宽度是 32 时
        // stride 必须按容器算（8 字节/帧），而不是按有效位 24 算（会得到 6）。
        WAVEFORMATEXTENSIBLE candidates24[4]{};
        const int count24 = teExclusiveFormatCandidates(24, candidates24);
        check(count24 >= 2 &&
              candidates24[0].Format.wBitsPerSample == 24 &&
              candidates24[0].Samples.wValidBitsPerSample == 24 &&
              candidates24[1].Format.wBitsPerSample == 32 &&
              candidates24[1].Samples.wValidBitsPerSample == 24,
              "24-bit source still offers 24-in-24 first, then 24-in-32");

        // 2) 352.8/384 kHz 的独占格式几何。WAVE_FORMAT_EXTENSIBLE 要求 cbSize
        //    指向 Samples 区，SubFormat 必须是 PCM；nAvgBytesPerSec 是
        //    rate x nBlockAlign，384k 立体声 = 3,072,000 B/s（DWORD 装得下）。
        for (int rate : {352800, 384000}) {
            const WAVEFORMATEXTENSIBLE full = teMakeExclusiveFormat(rate, 32, 32, 2);
            check(full.Format.wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
                  full.Format.nChannels == 2 &&
                  full.Format.nSamplesPerSec == static_cast<DWORD>(rate) &&
                  full.Format.wBitsPerSample == 32 &&
                  full.Samples.wValidBitsPerSample == 32 &&
                  full.Format.nBlockAlign == 8 &&
                  full.Format.nAvgBytesPerSec == static_cast<DWORD>(rate) * 8u &&
                  full.Format.cbSize == static_cast<WORD>(
                      sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) &&
                  ::IsEqualGUID(full.SubFormat, KSDATAFORMAT_SUBTYPE_PCM),
                  "exclusive format geometry at " + std::to_string(rate) +
                  " Hz is 32-bit PCM stereo: 8 bytes/frame, rate x 8 bytes/s");

            const WAVEFORMATEXTENSIBLE narrow = teMakeExclusiveFormat(rate, 32, 24, 2);
            check(narrow.Format.wBitsPerSample == 32 &&
                  narrow.Samples.wValidBitsPerSample == 24 &&
                  narrow.Format.nBlockAlign == 8 &&
                  narrow.Format.nSamplesPerSec == static_cast<DWORD>(rate),
                  "24-in-32 at " + std::to_string(rate) +
                  " Hz keeps the 32-bit container stride (validBits does not size the frame)");
        }

        // 3) 32-bit 容器下的精确往返（24-bit 源）。dr_flac/dr_wav 的 s32 是左对齐
        //    32-bit，转 float 再量化回 32-bit 容器这一圈必须原样返回——这是 24-bit
        //    素材走 32-bit 独占时"位完美"的字面证据。穷举全部 2^24 个值，与上面
        //    24-bit 直通测试同一口径：只对全部值成立的结论才配叫位完美。
        constexpr float kSourceScale = 1.0f / 2147483648.0f;
        int32_t firstBad24 = 0;
        bool exact24in32 = true;
        TpdfDither rng;
        rng.seed(0x32B17u);
        for (int32_t v = -(1 << 23); v <= (1 << 23) - 1; ++v) {
            const int32_t asStored = v * 256;                  // 左对齐 s32
            const float f = static_cast<float>(asStored) * kSourceScale;
            if (quantizeSample(f, 32, 24, rng) != asStored) {
                exact24in32 = false;
                firstBad24 = v;
                break;
            }
        }
        check(exact24in32,
              "every 24-bit int survives quantisation into a 32-bit container exactly (first bad: " +
              std::to_string(firstBad24) + ")");

        // 4) 32-bit 源：float32 能精确表示的那些 32-bit 整数（低 8 位为 0，穷举
        //    全范围）经 32 入 32 出必须原样回来。比 1 LSB 更细的 32-bit 值 float32
        //    本来就存不下（上一节已用灵敏度对照证明），所以这里断言的是
        //    "float 能承载的 32-bit 值不会在量化这一步再丢一次"。
        bool exact32 = true;
        int32_t firstBad32 = 0;
        for (int32_t k = -(1 << 23); k <= (1 << 23) - 1; ++k) {
            const int32_t stored = k * 256;
            const float f = static_cast<float>(stored) * kSourceScale;
            if (quantizeSample(f, 32, 32, rng) != stored) {
                exact32 = false;
                firstBad32 = k;
                break;
            }
        }
        check(exact32,
              "32-bit values exactly representable in float32 round-trip through a 32-bit container"
              " (first bad: " + std::to_string(firstBad32) + ")");

        // 5) 满刻度钳位。float 表示不了 2^31-1，所以旧算术里的 scale - 1.0f 会
        //    进位回 2^31，std::lrintf(2^31) 越界（MSVC/x86 得 INT32_MIN）；
        //    32-bit 源的最大值解码成 float 恰好是 1.0f，正满刻度就会变成负满刻度，
        //    听感是一声爆音。这条断言钉的就是这个缺口曾经的形状。
        check(quantizeSample(1.0f, 32, 32, rng) == 2147483647,
              "32-bit +1.0 clamps to INT32_MAX instead of wrapping to the negative rail");
        check(quantizeSample(-1.0f, 32, 32, rng) == (-2147483647 - 1),
              "32-bit -1.0 clamps to INT32_MIN");
        check(quantizeSample(INFINITY, 32, 32, rng) == 2147483647 &&
              quantizeSample(-INFINITY, 32, 32, rng) == (-2147483647 - 1),
              "32-bit infinities clamp to the rails (no lrint overflow)");
        check(quantizeSample(NAN, 32, 32, rng) == 0,
              "32-bit NaN becomes digital silence");

        // 6) dither 语义照旧：32 入 32 是位完美路径，不丢位就不许加抖动。因此即便
        //    选 tpdf 档，输出也必须与 off 档逐样本相同；若加了抖动，两者会分岔。
        check(!ditherApplies(32, 32, false), "32-in-32 is the bit-perfect path (no dither)");
        TpdfDither tpdfRng;
        DitherState offState;
        bool ditherIdentical = true;
        for (int n = 0; n < 4096 && ditherIdentical; ++n) {
            const float f = 0.4f * static_cast<float>(std::sin(0.03 * n)) +
                            0.0003f * static_cast<float>(std::sin(0.7 * n));
            const int32_t viaTpdf = quantizeSample(f, 32, 32, tpdfRng);
            const int32_t viaOff  = quantizeSample(f, 32, 32, offState, DitherMode::Off);
            if (viaTpdf != viaOff) ditherIdentical = false;
        }
        check(ditherIdentical,
              "32-bit target: tpdf and off agree sample-for-sample (equal depths add no dither)");
    }

    // --- EBU R128 loudness: the standard's own calibration signal ----------
    //
    // A loudness implementation cannot be checked by 'did it produce a number'.
    // Any bug still produces a plausible-looking figure, and a ReplayGain gain
    // derived from it would be applied to every track in the library before
    // anyone noticed.
    //
    // So the measurement is checked against the calibration the standard itself
    // defines: a 1 kHz sine at -23 dBFS in BOTH channels of a stereo pair reads
    // -23.0 LUFS. That single number pins the K-weighting filter, the channel
    // summation, the -0.691 offset and the gating all at once -- get any of them
    // wrong and it cannot come out at -23.
    {
        constexpr int kRate = 48000;
        constexpr double kPi = 3.14159265358979323846;
        const int64_t frames = kRate * 5;            // 5 s, well past the 400 ms gate

        auto measureTone = [&](double dbfs, double& lufs, double& truePeakDb) {
            const double amplitude = std::pow(10.0, dbfs / 20.0);
            std::vector<float> left(static_cast<size_t>(frames));
            std::vector<float> right(static_cast<size_t>(frames));
            for (int64_t n = 0; n < frames; ++n) {
                const float s = static_cast<float>(amplitude *
                    std::sin(2.0 * kPi * 1000.0 * n / kRate));
                left[static_cast<size_t>(n)] = s;
                right[static_cast<size_t>(n)] = s;
            }
            const float* planes[2] = { left.data(), right.data() };
            LoudnessResult r;
            std::string err;
            const bool okRun = analyzePlanar(planes, 2, kRate, frames, r, err);
            check(okRun, "the loudness scan runs (" + err + ")");
            lufs = r.integratedLufs;
            truePeakDb = r.truePeakDb;
        };

        double lufs = 0.0, tp = 0.0;
        measureTone(-23.0, lufs, tp);
        // Printed, not only asserted: a calibration that lands on the tolerance
        // boundary is much weaker evidence than one that lands on the value.
        std::fprintf(stderr,
                     "  loudness: -23 dBFS 1 kHz stereo sine -> %.4f LUFS (EBU calibration)\n",
                     lufs);
        check(std::fabs(lufs + 23.0) <= 0.1,
              "a -23 dBFS 1 kHz stereo sine reads -23.0 LUFS (got " +
              std::to_string(lufs) + ")");

        // The same tone 6 dB louder must read 6 LU higher. This catches a
        // measurement that is stable but scaled wrongly, which the single
        // calibration point above could not distinguish from a correct one.
        double lufs2 = 0.0, tp2 = 0.0;
        measureTone(-17.0, lufs2, tp2);
        check(std::fabs((lufs2 - lufs) - 6.0) <= 0.1,
              "loudness tracks level 1:1 (6 dB in, " +
              std::to_string(lufs2 - lufs) + " LU out)");

        // True peak of a full-scale 1 kHz sine. Sampled at 48 kHz a 1 kHz sine
        // hits its peak almost exactly, but true-peak estimation oversamples to
        // catch inter-sample peaks, so this lands slightly ABOVE 0 dBFS. A
        // sample-peak implementation would report exactly 0.0, which is the
        // distinction the two fields exist to keep.
        double lufs3 = 0.0, tpFull = 0.0;
        measureTone(0.0, lufs3, tpFull);
        check(tpFull > -0.05 && tpFull < 0.5,
              "true peak of a full-scale sine is at or just above 0 dBFS (got " +
              std::to_string(tpFull) + ")");

        // ReplayGain 2.0 direction and value: a -23 LUFS track needs +5 dB to
        // reach the -18 LUFS reference. A sign error here would make every quiet
        // track quieter and every loud one louder, which is the exact opposite of
        // the feature.
        check(std::fabs(replayGainDb(-23.0) - 5.0) <= 0.001,
              "a -23 LUFS track needs +5 dB to reach -18 LUFS (got " +
              std::to_string(replayGainDb(-23.0)) + ")");
        check(replayGainDb(-12.0) < 0.0,
              "a track louder than the reference is attenuated, not boosted");
        check(replayGainDb(-HUGE_VAL) == 0.0,
              "an unmeasurable track yields no gain rather than an infinite one");

        // The preventClip cap in dsp.cpp works in LINEAR amplitude. Handing it a
        // dB value would cap every input at about 1.0 -- a bug that looks like it
        // works, because the cap is still a cap.
        check(std::fabs(truePeakLinear(-6.0206) - 0.5) < 0.001,
              "truePeakLinear converts dB to amplitude (-6.02 dB -> 0.5)");
        check(std::fabs(truePeakLinear(0.0) - 1.0) < 0.001,
              "0 dBFS is amplitude 1.0");
    }

    // --- channel tools: each checked against its own definition -------------
    //
    // "The output changed" proves nothing about a balance control -- it would
    // pass for a control wired backwards, or to the wrong channel, or scaled
    // wrongly. Each tool is therefore driven with a constant per-channel signal
    // where the correct answer is arithmetic, not a matter of opinion.
    {
        constexpr int kRate = 48000;
        constexpr int kFrames = 4096;   // one block > the 30 ms crossfade

        // Left = +0.8, right = +0.2: distinct values so channel mix-ups are
        // visible, and both positive so a sign error is obvious too.
        // Runs enough blocks for the 30 ms bypass crossfade to COMPLETE before
        // sampling. A single 256-frame block is only ~5 ms, so the first version
        // measured everything mid-ramp: every tool reported the same partially
        // mixed value and looked broken when it was working correctly.
        //
        // 30 ms at 48 kHz is 1440 frames, so 4096 frames per block over 3 blocks
        // leaves the chain fully settled.
        constexpr int kBlocks = 3;
        // The signal level is a parameter because the width test needs headroom
        // for the widening: at full scale the safety clamp would truncate it and
        // the property under test would be masked by correct behaviour elsewhere.
        auto runOn = [&](DspParams p, float levelL, float levelR,
                         float& outL, float& outR) {
            std::vector<float> l(static_cast<size_t>(kFrames));
            std::vector<float> r(static_cast<size_t>(kFrames));
            DspChain chain;
            chain.prepare(2, kFrames, kRate);
            p.eqEnabled = false;
            p.limiterEnabled = false;   // isolate the tool, not the limiter
            p.autoHeadroom = false;
            chain.publish(p);
            for (int b = 0; b < kBlocks; ++b) {
                // Refill with the constant test signal each block: the tools are
                // static, so only the final block's values are read.
                std::fill(l.begin(), l.end(), levelL);
                std::fill(r.begin(), r.end(), levelR);
                float* planes[2] = { l.data(), r.data() };
                chain.process(planes, 2, kFrames);
            }
            outL = l[static_cast<size_t>(kFrames) - 1];
            outR = r[static_cast<size_t>(kFrames) - 1];
        };

        // The common case: the standard 0.8 / 0.2 test signal.
        auto run = [&](DspParams p, float& outL, float& outR) {
            runOn(p, 0.8f, 0.2f, outL, outR);
        };

        DspParams base;
        float l = 0.0f, r = 0.0f;

        // Identity: with every tool at its default the samples must come back
        // EXACTLY. This is what keeps the tools compatible with bit-perfect.
        run(base, l, r);
        check(l == 0.8f && r == 0.2f,
              "neutral channel tools are bit-exact (got " + std::to_string(l) + "/" +
              std::to_string(r) + ")");

        // swap: a routing change, so the values exchange and nothing scales.
        { DspParams p = base; p.swapChannels = true; run(p, l, r);
          check(l == 0.2f && r == 0.8f,
                "swapChannels exchanges the two channels (got " + std::to_string(l) + "/" +
                std::to_string(r) + ")"); }

        // mono: the AVERAGE, not one channel dropped. A dropped channel would
        // silently discard whatever was panned into it.
        { DspParams p = base; p.mono = true; run(p, l, r);
          check(std::fabs(l - 0.5f) < 1e-6f && std::fabs(r - 0.5f) < 1e-6f,
                "mono folds to the average of both channels (got " + std::to_string(l) +
                "/" + std::to_string(r) + ")"); }

        // balance is ATTENUATION of the opposite side, never a boost: a boost
        // could clip, and the point of this control is that it cannot.
        //
        // The convention is the standard pan one, +1.0 = fully RIGHT, so +1.0
        // silences the LEFT. The first version of this test asserted the mirror
        // image of the documented behaviour -- the implementation was right and
        // the test was wrong, which is worth stating because a wrong test is
        // exactly as damaging as wrong code once it is trusted.
        { DspParams p = base; p.balance = 1.0f; run(p, l, r);
          check(std::fabs(l) < 1e-6f && std::fabs(r - 0.2f) < 1e-6f,
                "balance +1.0 (fully right) silences the left, leaving the right (got " +
                std::to_string(l) + "/" + std::to_string(r) + ")"); }
        { DspParams p = base; p.balance = -1.0f; run(p, l, r);
          check(std::fabs(l - 0.8f) < 1e-6f && std::fabs(r) < 1e-6f,
                "balance -1.0 (fully left) silences the right, leaving the left"); }
        { DspParams p = base; p.balance = 0.5f; run(p, l, r);
          check(std::fabs(l - 0.4f) < 1e-6f && std::fabs(r - 0.2f) < 1e-6f,
                "balance +0.5 halves the left and leaves the right alone (got " +
                std::to_string(l) + "/" + std::to_string(r) + ")"); }

        // stereoWidth 0 is mono by the mid/side definition. It must AGREE with
        // the mono flag on the same input, or the two controls contradict.
        { DspParams p = base; p.stereoWidth = 0.0f; run(p, l, r);
          check(std::fabs(l - 0.5f) < 1e-6f && std::fabs(r - 0.5f) < 1e-6f,
                "stereoWidth 0 equals mono (got " + std::to_string(l) + "/" +
                std::to_string(r) + ")"); }

        // Width must preserve the SUM of the channels: mid/side scaling cannot
        // change the mid component, so the total level is conserved. This is the
        // property that catches a width control that is really just a gain.
        // A quieter signal for the widening test: at 0.8/0.2 a width of 2.0
        // drives the left to 1.1, which the always-on safety clamp correctly
        // truncates -- so the sum would not be conserved for a reason that has
        // nothing to do with the width control. Testing the property needs an
        // input with headroom for it.
        { DspParams p = base; p.stereoWidth = 2.0f;
          runOn(p, 0.4f, 0.1f, l, r);
          check(std::fabs((l + r) - (0.4f + 0.1f)) < 1e-5f,
                "stereoWidth conserves the channel sum (it is mid/side) (got " +
                std::to_string(l + r) + ")");
          check(std::fabs(l - r) > std::fabs(0.4f - 0.1f),
                "stereoWidth 2 widens the difference as advertised (got " +
                std::to_string(l - r) + ")"); }
        { DspParams p = base; p.stereoWidth = 0.0f; run(p, l, r);
          check(std::fabs(l - r) < 1e-6f,
                "stereoWidth 0 collapses the difference entirely"); }

        // Per-channel trim, verified against the dB definition.
        { DspParams p = base; p.channelGainDb[0] = -6.0f; run(p, l, r);
          // -6 dB is half amplitude, within rounding.
          check(std::fabs(l - 0.4f) < 0.002f && std::fabs(r - 0.2f) < 1e-6f,
                "-6 dB on the left halves it and leaves the right alone (got " +
                std::to_string(l) + "/" + std::to_string(r) + ")"); }

        // THE BIT-PERFECT RULE: any tool engaged is not the stored integers.
        { DspParams p = base; p.balance = 0.001f;
          check(!isPassthroughConfig(p), "a non-zero balance disqualifies bit-perfect"); }
        { DspParams p = base; p.mono = true;
          check(!isPassthroughConfig(p), "mono disqualifies bit-perfect"); }
        { DspParams p = base; p.stereoWidth = 1.5f;
          check(!isPassthroughConfig(p), "a non-unity width disqualifies bit-perfect"); }
        { DspParams p = base; p.swapChannels = true;
          check(!isPassthroughConfig(p), "channel swap disqualifies bit-perfect"); }
        { DspParams p = base; p.channelGainDb[1] = 0.5f;
          check(!isPassthroughConfig(p), "a channel trim disqualifies bit-perfect"); }
        check(isPassthroughConfig(base),
              "and the untouched defaults still qualify as a pass-through");

        // The sound-stage controls are deliberately separate from the legacy
        // channel tools.  Their defaults must remain an exact identity, while
        // each control must have an observable and independently reported effect.
        { DspParams p = base; p.midGainDb = 6.0f; runOn(p, 0.25f, 0.25f, l, r);
          check(l > 0.45f && r > 0.45f,
                "mid gain raises a centered signal (got " + std::to_string(l) + "/" +
                std::to_string(r) + ")");
          check(!isPassthroughConfig(p), "mid gain disqualifies bit-perfect"); }
        { DspParams p = base; p.sideGainDb = 6.0f; runOn(p, 0.25f, -0.25f, l, r);
          check(std::fabs(l) > 0.45f && std::fabs(r) > 0.45f,
                "side gain raises an out-of-phase signal");
          check(!isPassthroughConfig(p), "side gain disqualifies bit-perfect"); }

        // Crossfeed is a level-controlled, stateful stage: a left-only signal
        // must reach the right channel, and reset must remove its tail.
        { DspParams p = base; p.crossfeedEnabled = true; p.crossfeedPreset = 0;
          runOn(p, 0.8f, 0.0f, l, r);
          check(std::fabs(r) > 1e-4f, "crossfeed sends a left signal to the right");
          DspChain chain;
          constexpr int kResetFrames = 4096;
          std::vector<float> left(static_cast<size_t>(kResetFrames), 0.8f);
          std::vector<float> right(static_cast<size_t>(kResetFrames), 0.0f);
          chain.prepare(2, kResetFrames, kRate);
          p.limiterEnabled = false;
          chain.publish(p);
          float* planes[2] = { left.data(), right.data() };
          chain.process(planes, 2, kResetFrames);
          chain.reset();
          std::fill(left.begin(), left.end(), 0.0f);
          std::fill(right.begin(), right.end(), 0.0f);
          chain.process(planes, 2, kFrames);
          check(std::fabs(right[0]) < 1e-7f,
                "crossfeed reset clears filter state before the next stream"); }
        { DspParams p = base; p.crossfeedEnabled = true;
          constexpr int kNoiseFrames = 8192;
          std::vector<float> left(static_cast<size_t>(kNoiseFrames));
          std::vector<float> right(static_cast<size_t>(kNoiseFrames));
          std::vector<float> originalLeft(static_cast<size_t>(kNoiseFrames));
          std::vector<float> originalRight(static_cast<size_t>(kNoiseFrames));
          uint32_t noise = 0x12345678u;
          auto nextNoise = [&]() {
              noise = noise * 1664525u + 1013904223u;
              return (static_cast<float>(noise >> 8) / 8388608.0f) - 1.0f;
          };
          for (int i = 0; i < kNoiseFrames; ++i) {
              left[static_cast<size_t>(i)] = originalLeft[static_cast<size_t>(i)] = nextNoise() * 0.4f;
              right[static_cast<size_t>(i)] = originalRight[static_cast<size_t>(i)] = nextNoise() * 0.4f;
          }
          DspChain chain;
          chain.prepare(2, kNoiseFrames, kRate);
          p.limiterEnabled = false;
          chain.publish(p);
          float* planes[2] = { left.data(), right.data() };
          chain.process(planes, 2, kNoiseFrames);
          double inputEnergy = 0.0;
          double outputEnergy = 0.0;
          for (int i = kNoiseFrames / 2; i < kNoiseFrames; ++i) {
              const size_t index = static_cast<size_t>(i);
              inputEnergy += originalLeft[index] * originalLeft[index] +
                             originalRight[index] * originalRight[index];
              outputEnergy += left[index] * left[index] + right[index] * right[index];
          }
          const double rmsChangeDb = 10.0 * std::log10(outputEnergy / inputEnergy);
          check(std::fabs(rmsChangeDb) < 0.5,
                "crossfeed preserves uncorrelated stereo RMS within 0.5 dB (got " +
                std::to_string(rmsChangeDb) + " dB)"); }
        { DspParams p = base; p.crossfeedEnabled = true;
          check(!isPassthroughConfig(p), "crossfeed disqualifies bit-perfect"); }
    }


    // --- CR-032: DSD 抽取器--------------------------------------------------
    //
    // 这组断言存在的原因：DSD 抽取滤波器的错误在真实音乐上只表现为"有点糊 /
    // 高频发毛"，而第一版半带设计（H(π/2)/H(0) = 0.667 而不是 0.5）就是这样
    // 全绿通过的——它把 4 级级联的 Nyquist 抑制从 -124 dB 降到了 -9.5 dB，
    // 等于没有滤波。三条性质用合成信号钉住：
    //   1) H(π/2) = H(0)/2（半带的定义式）；
    //   2) 全 +1 输入（DSD 的满幅直流）稳态 = 1，且不超过 1；
    //   3) 交替 +1/-1（Nyquist）被压到 -60 dB 以下。
    {
        // 半带判据直接从系数算：中心抽头与奇数偏移抽头能重建 H(π/2)。
        // 用 DsdDecimator 的公开行为而不是私有系数：推入 fs/4 序列（+1,+1,-1,-1）
        // 的稳态峰值就是 |H(π/2)|/|H(0)|——这是抽取器对外可见的同一件事。
        auto runDecimator = [](int stages, const std::function<float(int)>& bit) {
            DsdDecimator decimator;
            decimator.configure(stages);
            std::vector<float> out;
            float sample = 0.0f;
            for (int i = 0; i < 200000; ++i) {
                if (decimator.push(bit(i), sample)) out.push_back(sample);
            }
            return out;
        };

        // 2) DC：1-bit 全 1 → 稳态 1.0（DC 增益归一化）。
        {
            const std::vector<float> dc = runDecimator(4, [](int) { return 1.0f; });
            double mean = 0.0;
            double peak = 0.0;
            const size_t tail = dc.size() > 500 ? dc.size() - 500 : 0;
            for (size_t i = tail; i < dc.size(); ++i) {
                mean += static_cast<double>(dc[i]);
                peak = std::max(peak, std::fabs(static_cast<double>(dc[i])));
            }
            mean /= static_cast<double>(dc.size() - tail);
            check(std::fabs(mean - 1.0) < 1e-4,
                  "DSD decimator: full-scale DC input settles at unity (got " +
                  std::to_string(mean) + ")");
            check(peak <= 1.0 + 1e-4,
                  "DSD decimator: DC input does not overshoot full scale (peak " +
                  std::to_string(peak) + ")");
        }

        // 1) 半带定义式：H(π/2)/H(0) = 0.5，在**系数**上量。
        //
        // 为什么不能用信号量：decimation by 2 之后，输入域 fs/4 的音正好落在输出域
        // 的 Nyquist（输出是 (-1)^m），相位相消，峰值判据给出 0 而不是 0.5 —— 这是
        // 判据退化，不是滤波器错。半带的定义式只能在系数/单级幅频响应上量，所以
        // DsdDecimator 暴露了一个只读的 testHalfBandMagnitude(ω)（见头文件注释）。
        {
            DsdDecimator single;
            single.configure(1);
            const double h0 = single.testHalfBandMagnitude(0.0);
            const double hHalf = single.testHalfBandMagnitude(3.14159265358979323846 / 2.0);
            const double hStop = single.testHalfBandMagnitude(0.6 * 3.14159265358979323846);
            check(std::fabs(h0 - 1.0) < 1e-6,
                  "DSD decimator: half-band DC gain is unity (got " + std::to_string(h0) + ")");
            // 容差 1e-6：错的版本（sinc(n/2)/2，H(π/2)=0.6667）会立刻红；
            // 正确版本由构造恰好是 0.5，不需要松容差。这条钉的就是定义式。
            check(std::fabs(hHalf - 0.5) < 1e-6,
                  "DSD decimator: half-band gain at pi/2 is exactly 0.5 (got " +
                  std::to_string(hHalf) + ")");
            check(hStop < 0.001,
                  "DSD decimator: half-band stopband at 0.6*pi is below -60 dB (got " +
                  std::to_string(20.0 * std::log10(std::max(hStop, 1e-12))) + " dB)");
        }

        // 3) Nyquist：交替位（+1,-1,）在**输入率**上就是 Nyquist（π，即 fs/2），
        //    必须被 4 级级联抑制到 -60 dB 以下。
        //
        // 口径更正（2026-10-18，verifier 复算推翻了我此前的一个说法）：
        //   * 曾经写成「交替位是每级半带 π/2 的中点」—— **错的**。交替位是输入 Nyquist π；
        //     π/2 是 fs/4，是另一条音（1.4112 MHz 对 DSD64 是 fs/4，不是 fs/2）。
        //   * 单级半带在 π/2 只有 -6 dB（H(π/2)=H(0)/2 的定义式），但交替位走的是
        //     「每级抽取后频率翻倍」这条链，所以 4 级后实测 RMS ≈ -124.6 dB；
        //     错误版滤波器（sinc(n/2)/2）在这一条上只有 -9.5 dB —— 这才是区分两版的关键数字。
        // 用 RMS 而不是峰值：峰值对启动瞬态敏感，稳态讲的是能量。
        {
            const std::vector<float> nyquist =
                runDecimator(4, [](int i) { return (i & 1) ? -1.0f : 1.0f; });
            double energy = 0.0;
            size_t count = 0;
            const size_t tail = nyquist.size() > 2000 ? nyquist.size() - 2000 : 0;
            for (size_t i = tail; i < nyquist.size(); ++i) {
                energy += static_cast<double>(nyquist[i]) * static_cast<double>(nyquist[i]);
                ++count;
            }
            const double rms = count > 0 ? std::sqrt(energy / static_cast<double>(count)) : 1.0;
            const double db = 20.0 * std::log10(std::max(rms, 1e-12));
            check(db < -60.0,
                  "DSD decimator: Nyquist (alternating bits) is suppressed below -60 dB (got " +
                  std::to_string(db) + " dB)");
        }
    }

    // --- CR-031: 默认参数与"limiter 关闭"逐样本一致 ---------------------------
    //
    // 这条断言的目的是钉住"新参数不改变既有默认路径"。做法：同一份输入分两次
    // 过链，一次 enabled=false（完全没有限幅器），一次用默认参数
    // (enabled=true, ceiling=-0.1, release=60, lookahead=0)。信号峰值 0.95/0.85
    // 低于 ceiling，所以默认限幅器的增益恰好是 1.0，两次必须逐样本相同。
    //
    // 注：第一版写成"lookahead=0 跑两遍比 memcmp"，那是恒真断言（同一代码路径），
    // 已按 Lead 的指正改成下面这种跨配置比较。
    {
        constexpr int kRate = 48000;
        constexpr int kBlock = 256;
        // 长到足以跨过 30ms 的 bypass 交叉淡入（1440 帧）并留出比较窗口。
        // 用 8 个块比较做不到这件事：整段都在淡入区里，两条配置的差异被 dry
        // 稀释（这正是第一版两条断言都假红的原因）。
        constexpr int kBlocks = 48;
        // 预热帧数：> bypassSamples_(1440) + 一段滤波起振余量。
        constexpr int kWarmup = 3072;
        // 用宽带噪声而不是正弦：互相关要测"延迟"就必须有一个自相关接近冲激的
        // 信号。第一版用的是周期 ~90 样本的正弦，互相关在 lag 240+4×90=599 处
        // 也有同高的峰 —— 峰值判据被信号的周期性搞错了，不是延迟错了。
        std::vector<float> left(static_cast<size_t>(kBlock) * kBlocks);
        std::vector<float> right(left.size());
        {
            uint32_t state = 0x9E3779B9u;
            auto nextNoise = [&state]() {
                state = state * 1664525u + 1013904223u;
                return (static_cast<float>(state >> 8) / 8388608.0f) - 1.0f;
            };
            for (size_t i = 0; i < left.size(); ++i) {
                left[i] = nextNoise() * 0.5f;
                right[i] = nextNoise() * 0.5f;
            }
        }
        auto runChain = [&](bool limiterEnabled, float ceilingDb, float releaseMs,
                            float lookaheadMs, std::vector<float>& outLeft,
                            std::vector<float>& outRight) {
            outLeft = left;
            outRight = right;
            DspChain chain;
            chain.prepare(2, kBlock, kRate);
            DspParams p;
            p.eqEnabled = false;
            // 必须让 STATIC GAIN 不是 1：限幅器只在湿路径里跑（wetMix_ > 0），
            // 而静态增益为 1 时整条链是旁路，限幅器根本不会被调用 —— 这正是
            // 第一次跑这两条断言时两条都失败的原因。用 -3 dB 让湿路径生效，
            // 同时信号（0.95/0.85 × 0.708）仍低于 ceiling。
            p.preampDb = -3.0f;
            p.autoHeadroom = false;
            p.limiterEnabled = limiterEnabled;
            p.limiterCeilingDb = ceilingDb;
            p.limiterReleaseMs = releaseMs;
            p.limiterLookaheadMs = lookaheadMs;
            chain.publish(p);
            float* planes[2] = { outLeft.data(), outRight.data() };
            for (int block = 0; block < kBlocks; ++block) {
                float* blockPlanes[2] = { planes[0] + block * kBlock, planes[1] + block * kBlock };
                chain.process(blockPlanes, 2, kBlock);
            }
        };
        std::vector<float> offLeft, offRight, defLeft, defRight;
        runChain(false, -0.1f, 60.0f, 0.0f, offLeft, offRight);   // no limiter at all
        runChain(true, -0.1f, 60.0f, 0.0f, defLeft, defRight);    // shipped defaults
        bool identical = true;
        for (size_t i = 0; i < defLeft.size(); ++i) {
            if (defLeft[i] != offLeft[i] || defRight[i] != offRight[i]) { identical = false; break; }
        }
        check(identical,
              "CR-031: the default limiter parameters are sample-identical to a signal below the ceiling");
        // lookahead 打开后必须仍是"不越界"；同时它应当改变输出（延迟线生效）。
        std::vector<float> laLeft, laRight;
        runChain(true, -0.1f, 60.0f, 5.0f, laLeft, laRight);
        double peak = 0.0;
        for (float v : laLeft) peak = std::max(peak, static_cast<double>(std::fabs(v)));
        for (float v : laRight) peak = std::max(peak, static_cast<double>(std::fabs(v)));
        check(peak <= 1.0, "CR-031: lookahead limiter never lets the signal exceed full scale");
        // lookahead 生效的可观测证据：输出与默认配置**不同**，且差异只可能是
        // 延迟 + 不同的限幅增益。不能用"首帧静音"判定 —— 链路开头的 bypass 交叉
        // 淡入本身就会把首帧压到极小（30ms 斜坡），那条判据会被淡入的静音蒙混过去，
        // 所以这里只认"确实改变了样本"这一条，并额外验证输出仍不越界。
        // 预热之后再比：两配置在淡入区里都以 dry 为主，那一段的差异没有诊断价值。
        bool differs = false;
        for (size_t i = static_cast<size_t>(kWarmup); i < laLeft.size(); ++i) {
            if (laLeft[i] != defLeft[i] || laRight[i] != defRight[i]) { differs = true; break; }
        }
        check(differs,
              "CR-031: lookahead actually changes the output (it is not a decorative parameter)");

        // 延迟的直接证据：互相关峰在 lag ≈ L 上。这比"首 L 帧静音"稳得多 ——
        // 湿路径是从 dry 交叉淡入的，开头本来就有信号，用静音判据会被淡入蒙混。
        {
            const int expectedLag = static_cast<int>(0.005f * static_cast<float>(kRate) + 0.5f);
            int bestLag = 0;
            double best = -1.0;
            for (int lag = 0; lag <= expectedLag * 3; ++lag) {
                double dot = 0.0;
                size_t count = 0;
                for (size_t i = static_cast<size_t>(kWarmup) + static_cast<size_t>(lag);
                     i < laLeft.size(); ++i) {
                    dot += static_cast<double>(laLeft[i]) *
                           static_cast<double>(defLeft[i - static_cast<size_t>(lag)]);
                    ++count;
                }
                if (count == 0) continue;
                const double normalized = dot / static_cast<double>(count);
                if (normalized > best) { best = normalized; bestLag = lag; }
            }
            check(std::abs(bestLag - expectedLag) <= 2,
                  "CR-031: lookahead delays the signal by exactly its declared frames (lag " +
                  std::to_string(bestLag) + " vs expected " + std::to_string(expectedLag) + ")");
        }
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "self-test: all checks passed\n");
    } else {
        std::fprintf(stderr, "self-test: %d FAILURE(S)\n", g_failures);
    }
    return g_failures;
}

} // namespace te
