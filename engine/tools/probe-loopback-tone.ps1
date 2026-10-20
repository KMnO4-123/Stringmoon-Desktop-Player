# probe-loopback-tone.ps1
#
# Gate test for the Null Test project.
#
# probe-loopback.ps1 proved loopback can be OPENED but delivered no packets --
# because silence really does deliver nothing. That is the whole point of this
# second probe: prove loopback can capture audio that is actually playing.
#
# It emits a very quiet tone (-40 dBFS, 1 kHz, ~2 s) on an endpoint and captures
# that same endpoint in loopback, then reports what came back.
#
# Deliberate choices:
#   * -40 dBFS, not full scale. This is a capability gate, not a listening test.
#   * Default endpoint is the BUILT-IN speaker, so headphones plugged into the
#     DAC are not driven. Pass -EndpointId to aim it somewhere else.
#   * The tone is generated in-process. Nothing is downloaded, nothing is
#     installed, and no file on disk is modified.

param(
    [string] $EndpointId = "",
    [int]    $Millis     = 2000,
    [double] $Dbfs       = -40.0,
    [int]    $FreqHz     = 1000
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace LbTone {

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

  [Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioRenderClient {
    int GetBuffer(int frames, out IntPtr data);
    int ReleaseBuffer(int frames, int flags);
  }

  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
    int ReleaseBuffer(int frames);
    int GetNextPacketSize(out int frames);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  public struct WAVEFORMATEX {
    public ushort wFormatTag; public ushort nChannels;
    public uint nSamplesPerSec; public uint nAvgBytesPerSec;
    public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
  }

  public static class Api {
    public const int eRender = 0;
    public const int DEVICE_STATE_ACTIVE = 0x1;
    public const int CLSCTX_ALL = 23;
    public const int SHARED = 0;
    public const int LOOPBACK = 0x00020000;
    public static readonly Guid IID_AC  = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    public static readonly Guid IID_CAP = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
    public static readonly Guid IID_REN = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");

    static IAudioClient Open(string id, IMMDeviceEnumerator en, out WAVEFORMATEX fmt, out IntPtr fmtPtr) {
      IMMDevice dev;
      int hr = (id == null || id.Length == 0)
        ? en.GetDefaultAudioEndpoint(eRender, 0, out dev)
        : en.GetDevice(id, out dev);
      if (hr != 0) throw new Exception("GetDevice failed hr=0x" + hr.ToString("X8"));

      object o; var iid = IID_AC;
      hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
      if (hr != 0) throw new Exception("Activate failed hr=0x" + hr.ToString("X8"));
      var ac = (IAudioClient)o;
      hr = ac.GetMixFormat(out fmtPtr);
      if (hr != 0) throw new Exception("GetMixFormat failed hr=0x" + hr.ToString("X8"));
      fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
      return ac;
    }

    public static string[] Run(string endpointId, int millis, double dbfs, int freq) {
      var log = new System.Collections.Generic.List<string>();
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());

      // --- capture side (loopback) ---
      WAVEFORMATEX cfmt; IntPtr cfmtPtr;
      var cap = Open(endpointId, en, out cfmt, out cfmtPtr);
      int hr = cap.Initialize(SHARED, LOOPBACK, 2000000, 0, cfmtPtr, IntPtr.Zero);
      if (hr != 0) { log.Add("capture Initialize failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      object co; var ic = IID_CAP;
      hr = cap.GetService(ref ic, out co);
      if (hr != 0) { log.Add("GetService(capture) failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var cclient = (IAudioCaptureClient)co;

      // --- render side (shared, so it goes through the audio engine) ---
      WAVEFORMATEX rfmt; IntPtr rfmtPtr;
      var ren = Open(endpointId, en, out rfmt, out rfmtPtr);
      hr = ren.Initialize(SHARED, 0, 2000000, 0, rfmtPtr, IntPtr.Zero);
      if (hr != 0) { log.Add("render Initialize failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      object ro; var ir = IID_REN;
      hr = ren.GetService(ref ir, out ro);
      if (hr != 0) { log.Add("GetService(render) failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var rclient = (IAudioRenderClient)ro;

      log.Add(string.Format("format: {0} Hz, {1} ch, {2} bits, tag={3}",
                            rfmt.nSamplesPerSec, rfmt.nChannels, rfmt.wBitsPerSample, rfmt.wFormatTag));

      int bufFrames; ren.GetBufferSize(out bufFrames);
      log.Add("render buffer frames: " + bufFrames);

      double amp = Math.Pow(10.0, dbfs / 20.0);
      log.Add(string.Format("tone: {0} Hz at {1} dBFS (amplitude {2:F6})", freq, dbfs, amp));

      cap.Start();
      ren.Start();

      // Fill the render buffer repeatedly in small chunks AND drain the capture
      // buffer at the same time, on one thread. If we only rendered, capture
      // would overflow; if we only captured, we'd render nothing.
      int ch = rfmt.nChannels;
      double phase = 0.0, dphase = 2.0 * Math.PI * freq / rfmt.nSamplesPerSec;
      int renderedTotal = 0, capturedFrames = 0, packets = 0, nonZero = 0;
      double peak = 0.0, sumSq = 0.0;

      var end = DateTime.UtcNow.AddMilliseconds(millis);
      int chunk = Math.Min(bufFrames > 0 ? bufFrames / 4 : 512, 2048);
      if (chunk < 64) chunk = 64;

      unsafe {
        while (DateTime.UtcNow < end) {
          // ---- render ----
          // AUDCLNT_E_BUFFER_TOO_LARGE (0x88890006) is what you get for asking
          // for more frames than the buffer has FREE. A renderer must ask for
          // (bufferSize - currentPadding), never for a fixed chunk: the engine
          // still holds whatever it has not played yet.
          int padding;
          if (ren.GetCurrentPadding(out padding) == 0) {
            int free = bufFrames - padding;
            if (free > 0) {
              int want = Math.Min(free, chunk);
              IntPtr rd;
              if (rclient.GetBuffer(want, out rd) == 0 && rd != IntPtr.Zero) {
                float* p = (float*)rd.ToPointer();
                for (int i = 0; i < want; i++) {
                  float s = (float)(Math.Sin(phase) * amp);
                  for (int c = 0; c < ch; c++) p[i * ch + c] = s;
                  phase += dphase;
                  if (phase > Math.PI * 2) phase -= Math.PI * 2;
                }
                rclient.ReleaseBuffer(want, 0);
                renderedTotal += want;
              }
            }
          }

          // ---- capture ----
          int next;
          cclient.GetNextPacketSize(out next);
          int guard = 0;
          while (next > 0 && guard++ < 64) {
            IntPtr cd; int frames, flags; long dp, qp;
            if (cclient.GetBuffer(out cd, out frames, out flags, out dp, out qp) != 0) break;
            if (frames > 0 && cd != IntPtr.Zero) {
              packets++; capturedFrames += frames;
              int floats = frames * cfmt.nChannels;
              float* q = (float*)cd.ToPointer();
              for (int i = 0; i < floats; i++) {
                float v = q[i];
                double a = v < 0 ? -v : v;
                if (a > peak) peak = a;
                if (v != 0.0f) nonZero++;
                sumSq += (double)v * v;
              }
            }
            cclient.ReleaseBuffer(frames);
            cclient.GetNextPacketSize(out next);
          }
          Thread.Sleep(1);
        }
      }

      ren.Stop();
      cap.Stop();

      log.Add("rendered frames (asked): " + renderedTotal);
      log.Add("captured packets: " + packets);
      log.Add("captured frames: " + capturedFrames);
      log.Add("non-zero captured samples: " + nonZero);
      log.Add("captured peak |sample|: " + peak.ToString("F8"));
      if (capturedFrames > 0)
        log.Add("captured RMS (dBFS): " + (10.0 * Math.Log10(sumSq / Math.Max(1, capturedFrames * ch))).ToString("F2"));

      if (capturedFrames == 0)
        log.Add("VERDICT: FAIL -- loopback delivered no packets even with audio playing");
      else if (nonZero == 0)
        log.Add("VERDICT: FAIL -- packets arrived but all samples were zero");
      else
        log.Add("VERDICT: PASS -- loopback captured the tone; Null Test is feasible on this endpoint");

      return log.ToArray();
    }

    public static string[] ListRender() {
      var res = new System.Collections.Generic.List<string>();
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDeviceCollection coll; en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out coll);
      int n; coll.GetCount(out n);
      for (int i = 0; i < n; i++) { IMMDevice d; coll.Item(i, out d); string id; d.GetId(out id); res.Add(id); }
      return res.ToArray();
    }
  }
}
'@ -CompilerOptions '/unsafe'

# ---------------------------------------------------------------------------

Write-Host "=== loopback tone gate ===" -ForegroundColor Cyan

$target = $EndpointId
if (-not $target) {
    # Prefer the built-in speaker so headphones are not driven.
    $all = [LbTone.Api]::ListRender()
    Write-Host ("active render endpoints: " + $all.Count)
    foreach ($id in $all) { Write-Host ("   " + $id) }
    # The probe earlier identified {10ecfbb1-...} as "扬声器 (Audio Device)".
    # Match on that GUID so we do not fall back to the DAC by accident.
    $builtin = $all | Where-Object { $_ -like '*10ecfbb1-44d4-43b7-8e83-84711e2fa8ef*' }
    if ($builtin) { $target = $builtin[0]; Write-Host "using built-in speaker endpoint" }
    else { $target = $all[0]; Write-Host "built-in not found; using first endpoint" }
}

Write-Host ("target: " + $target) -ForegroundColor Yellow
$lines = [LbTone.Api]::Run($target, $Millis, $Dbfs, $FreqHz)
foreach ($l in $lines) { Write-Host ("    " + $l) }
