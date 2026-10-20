# capture-loopback.ps1
#
# Pure loopback capture: opens WASAPI loopback on the DEFAULT render endpoint
# and reports what it saw. It never renders audio and never writes a file --
# exclusive-loopback-test.mjs uses it to watch what the engine is playing.
#
# The default endpoint is used deliberately. If the engine is in exclusive mode
# on the DAC, that is the endpoint we must watch; asking for the built-in
# speaker would answer a question nobody asked.

param(
    [int]    $Seconds    = 6,
    [string] $EndpointId = ""
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace LbCapture {

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
  public interface IMMDeviceCollection { int GetCount(out int c); int Item(int i, out IMMDevice d); }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
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
    int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr h);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out int frames, out int flags, out long devPos, out long qpc);
    int ReleaseBuffer(int frames);
    int GetNextPacketSize(out int frames);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  public struct WAVEFORMATEX {
    public ushort wFormatTag; public ushort nChannels;
    public uint nSamplesPerSec; public uint nAvgBytesPerSec;
    public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
  }

  public static class Cap {
    const int eRender = 0, CLSCTX_ALL = 23, SHARED = 0, LOOPBACK = 0x00020000;
    static readonly Guid IID_AC  = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    static readonly Guid IID_CAP = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    public static string[] Run(string endpointId, int seconds) {
      var log = new System.Collections.Generic.List<string>();
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());

      IMMDevice dev;
      int hr = (endpointId == null || endpointId.Length == 0)
        ? en.GetDefaultAudioEndpoint(eRender, 0, out dev)
        : en.GetDevice(endpointId, out dev);
      if (hr != 0) { log.Add("GetDevice failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }

      string devId; dev.GetId(out devId);
      log.Add("endpoint: " + devId);

      object o; var iid = IID_AC;
      hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
      if (hr != 0) { log.Add("Activate failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var ac = (IAudioClient)o;

      IntPtr fmtPtr;
      hr = ac.GetMixFormat(out fmtPtr);
      if (hr != 0) { log.Add("GetMixFormat failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
      log.Add(string.Format("format: {0} Hz, {1} ch, {2} bits, tag={3}",
                            fmt.nSamplesPerSec, fmt.nChannels, fmt.wBitsPerSample, fmt.wFormatTag));

      hr = ac.Initialize(SHARED, LOOPBACK, 2000000, 0, fmtPtr, IntPtr.Zero);
      if (hr != 0) {
        // 0x8889000A = AUDCLNT_E_DEVICE_IN_USE -- the expected failure if the
        // engine holds this endpoint exclusively and it refuses to share.
        log.Add("capture Initialize failed hr=0x" + hr.ToString("X8"));
        if (hr == unchecked((int)0x8889000A)) log.Add("  -> AUDCLNT_E_DEVICE_IN_USE");
        if (hr == unchecked((int)0x8889001C)) log.Add("  -> AUDCLNT_E_DEVICE_INVALIDATED");
        return log.ToArray();
      }

      object co; var ic = IID_CAP;
      hr = ac.GetService(ref ic, out co);
      if (hr != 0) { log.Add("GetService failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }
      var cap = (IAudioCaptureClient)co;

      hr = ac.Start();
      if (hr != 0) { log.Add("Start failed hr=0x" + hr.ToString("X8")); return log.ToArray(); }

      int packets = 0, capturedFrames = 0, nonZero = 0;
      double peak = 0.0, sumSq = 0.0;
      var end = DateTime.UtcNow.AddSeconds(seconds);

      unsafe {
        while (DateTime.UtcNow < end) {
          int next;
          cap.GetNextPacketSize(out next);
          int guard = 0;
          while (next > 0 && guard++ < 64) {
            IntPtr cd; int frames, flags; long dp, qp;
            if (cap.GetBuffer(out cd, out frames, out flags, out dp, out qp) != 0) break;
            if (frames > 0 && cd != IntPtr.Zero) {
              packets++; capturedFrames += frames;
              int floats = frames * fmt.nChannels;
              float* q = (float*)cd.ToPointer();
              for (int i = 0; i < floats; i++) {
                float v = q[i];
                double a = v < 0 ? -v : v;
                if (a > peak) peak = a;
                if (v != 0.0f) nonZero++;
                sumSq += (double)v * v;
              }
            }
            cap.ReleaseBuffer(frames);
            cap.GetNextPacketSize(out next);
          }
          Thread.Sleep(2);
        }
      }

      ac.Stop();

      log.Add("captured packets: " + packets);
      log.Add("captured frames: " + capturedFrames);
      log.Add("non-zero captured samples: " + nonZero);
      log.Add("captured peak |sample|: " + peak.ToString("F8"));
      if (capturedFrames > 0)
        log.Add("captured RMS (dBFS): " + (10.0 * Math.Log10(sumSq / Math.Max(1, capturedFrames * fmt.nChannels))).ToString("F2"));
      return log.ToArray();
    }
  }
}
'@ -CompilerOptions '/unsafe'

foreach ($l in [LbCapture.Cap]::Run($EndpointId, $Seconds)) { Write-Output $l }
