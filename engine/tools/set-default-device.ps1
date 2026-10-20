param([string]$DeviceId)
# Set the Windows default render endpoint through the documented policy interface.
#
# Everything happens in C#: PowerShell returns a bare __ComObject from
# Activator.CreateInstance and loses the interface cast, which works fine in C#.
# The vtable order still matters -- calls dispatch by slot, so every earlier
# method needs a signature even though it is unused.
$src = @"
using System;
using System.Runtime.InteropServices;
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
    int GetMixFormat(string id, IntPtr fmt);
    int GetDeviceFormat(string id, bool def, IntPtr fmt);
    int ResetDeviceFormat(string id);
    int SetDeviceFormat(string id, IntPtr end, IntPtr mix);
    int GetProcessingPeriod(string id, bool def, IntPtr a, IntPtr b);
    int SetProcessingPeriod(string id, IntPtr period);
    int GetShareMode(string id, IntPtr mode);
    int SetShareMode(string id, IntPtr mode);
    int GetPropertyValue(string id, IntPtr key, IntPtr value);
    int SetPropertyValue(string id, IntPtr key, IntPtr value);
    int SetDefaultEndpoint(string id, int role);
    int SetEndpointVisibility(string id, bool visible);
}
public static class PolicyConfig {
    public static int SetDefault(string deviceId) {
        var type = Type.GetTypeFromCLSID(new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9"));
        var pc = (IPolicyConfig)Activator.CreateInstance(type);
        // All three roles: setting only eConsole can leave the multimedia role
        // pointing at the old device, which is what some apps still use.
        // eConsole only (role 0), because that is the role the engine follows.
        // Setting the other two would raise notifications the engine ignores and
        // would make the first one arrive out of context.
        pc.SetDefaultEndpoint(deviceId, 0);
        return 0;
    }
}
"@
Add-Type -TypeDefinition $src
[void][PolicyConfig]::SetDefault($DeviceId)
Write-Output "default render endpoint set to $DeviceId"