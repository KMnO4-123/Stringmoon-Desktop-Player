# probe-loopback.ps1
#
# Purpose: answer ONE question before the Null Test project starts:
#   Can this machine record WASAPI loopback at all, and does the recording
#   actually contain the audio that was playing?
#
# This is a GATE, in the same spirit as G1 (--probe-io measured dr_flac's read
# pattern before the HTTP reader was written). Writing a Null Test harness on
# top of loopback capture that turns out to record silence would waste the whole
# effort, and worse, would produce "the other player added nothing" as a FALSE
# conclusion -- a difference of all zeros means nothing if the capture is silent.
#
# It does NOT touch the engine, does not modify anything, and only reads.

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Core Audio interop. Kept minimal on purpose: we need one capture client.
# ---------------------------------------------------------------------------

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace LoopbackProbe {

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity,
                   IntPtr format, IntPtr sessionGuid);
    int GetBufferSize(out int frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out int padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
    int ReleaseBuffer(int frames);
    int GetNextPacketSize(out int frames);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  public struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint   nSamplesPerSec;
    public uint   nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  public static class Api {
    public const int eRender = 0, eCapture = 1, eAll = 2;
    public const int DEVICE_STATE_ACTIVE = 0x1;
    public const int CLSCTX_ALL = 23;
    public const int AUDCLNT_SHAREMODE_SHARED = 0;
    public const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    public const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;

    public static readonly Guid IID_IAudioClient =
        new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    public static readonly Guid IID_IAudioCaptureClient =
        new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    // Enumerates ACTIVE render endpoints' friendly names + ids.
    public static string[] ListRenderEndpoints() {
      var results = new System.Collections.Generic.List<string>();
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDeviceCollection coll;
      if (enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out coll) != 0)
        return new string[] { "<<EnumAudioEndpoints failed>>" };

      int count;
      coll.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IMMDevice dev;
        if (coll.Item(i, out dev) != 0) continue;
        string id;
        dev.GetId(out id);
        results.Add(id);
      }
      return results.ToArray();
    }

    // Opens loopback capture on ONE endpoint id and returns what it measured.
    public static string[] CaptureLoopback(string deviceId, int millis) {
      var log = new System.Collections.Generic.List<string>();
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());

      IMMDevice dev;
      int hr = enumerator.GetDevice(deviceId, out dev);
      if (hr != 0) { log.Add("GetDevice failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }

      object ifaceObj;
      var iidAudioClient = IID_IAudioClient;
      hr = dev.Activate(ref iidAudioClient, CLSCTX_ALL, IntPtr.Zero, out ifaceObj);
      if (hr != 0) { log.Add("Activate(IAudioClient) failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var audioClient = (IAudioClient)ifaceObj;

      IntPtr fmtPtr;
      hr = audioClient.GetMixFormat(out fmtPtr);
      if (hr != 0) { log.Add("GetMixFormat failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }

      var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
      log.Add(string.Format("mix format: {0} Hz, {1} ch, {2} bits, tag={3}",
                            fmt.nSamplesPerSec, fmt.nChannels, fmt.wBitsPerSample, fmt.wFormatTag));

      // 200 ms of buffer in 100-ns units; periodicity 0 => let the engine choose.
      hr = audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_LOOPBACK,
                                  2000000, 0, fmtPtr, IntPtr.Zero);
      if (hr != 0) {
        log.Add("Initialize(LOOPBACK) failed hr=0x" + hr.ToString("X8"));
        log.Add("  -> 0x88890008 = unsupported format; 0x80070005 = access denied");
        return log.ToArray();
      }

      int bufferFrames;
      audioClient.GetBufferSize(out bufferFrames);
      log.Add("buffer frames: " + bufferFrames);

      object capObj;
      var iidCapture = IID_IAudioCaptureClient;
      hr = audioClient.GetService(ref iidCapture, out capObj);
      if (hr != 0) { log.Add("GetService(IAudioCaptureClient) failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var capture = (IAudioCaptureClient)capObj;

      hr = audioClient.Start();
      if (hr != 0) { log.Add("Start failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }

      // Poll for the requested window. We only need to know: did ANY non-silent
      // sample arrive, and how many packets came at all.
      int packets = 0, totalFrames = 0, nonZeroSamples = 0;
      double peakAbs = 0.0;
      var deadline = DateTime.UtcNow.AddMilliseconds(millis);
      var sleepMs = Math.Max(1, millis / 20);

      while (DateTime.UtcNow < deadline) {
        int next;
        capture.GetNextPacketSize(out next);
        if (next == 0) { System.Threading.Thread.Sleep(sleepMs); continue; }

        IntPtr data;
        int frames, flags;
        long devPos, qpc;
        hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc);
        if (hr != 0) break;

        if (frames > 0 && data != IntPtr.Zero) {
          packets++;
          totalFrames += frames;
          // Format here is float32 when tag==3 (IEEE_FLOAT). Sample a subset:
          // scanning every sample of a long capture is pointless for a gate.
          int floats = frames * fmt.nChannels;
          int stride = Math.Max(1, floats / 4096);
          unsafe {
            float* p = (float*)data.ToPointer();
            for (int i = 0; i < floats; i += stride) {
              float v = p[i];
              double a = v < 0 ? -v : v;
              if (a > peakAbs) peakAbs = a;
              if (v != 0.0f) nonZeroSamples++;
            }
          }
        }
        capture.ReleaseBuffer(frames);
      }

      audioClient.Stop();

      log.Add("packets: " + packets);
      log.Add("frames total: " + totalFrames);
      log.Add("non-zero samples (sparse scan): " + nonZeroSamples);
      log.Add("peak |sample|: " + peakAbs.ToString("F8"));

      bool silent = (totalFrames > 0) && (nonZeroSamples == 0);
      if (totalFrames == 0)
        log.Add("VERDICT: NO DATA -- loopback opened but delivered no packets");
      else if (silent)
        log.Add("VERDICT: SILENT -- packets arrived but every sample was 0 (nothing was playing, or capture is muted)");
      else
        log.Add("VERDICT: AUDIO PRESENT -- loopback capture works");

      return log.ToArray();
    }
  }
}
'@ -CompilerOptions '/unsafe'

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

Write-Host "=== WASAPI loopback capability probe ===" -ForegroundColor Cyan
Write-Host "This machine is NOT playing anything by itself; the probe reports what"
Write-Host "the loopback stream contains. Run it WHILE audio plays for a real test."
Write-Host ""

$endpoints = [LoopbackProbe.Api]::ListRenderEndpoints()
Write-Host ("Active render endpoints: " + $endpoints.Count)

$results = @()
foreach ($id in $endpoints) {
    Write-Host ""
    Write-Host ("--- " + $id) -ForegroundColor Yellow
    $lines = [LoopbackProbe.Api]::CaptureLoopback($id, 3000)
    foreach ($l in $lines) { Write-Host ("    " + $l) }
    $results += ,@($id, $lines)
}

Write-Host ""
Write-Host "=== summary ===" -ForegroundColor Cyan
foreach ($r in $results) {
    $verdict = ($r[1] | Where-Object { $_ -like 'VERDICT:*' }) -join '; '
    Write-Host ("  {0}`n      {1}" -f (Split-Path $r[0] -Leaf), $verdict)
}
