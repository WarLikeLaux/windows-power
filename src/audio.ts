// Core Audio COM interface method order is part of the Windows ABI.
export const muteAudioScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class AudioEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioDevices {
    int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IAudioDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioDevice {
    int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioVolume {
    int RegisterControlChangeNotify(IntPtr p);
    int UnregisterControlChangeNotify(IntPtr p);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, Guid context);
    int SetMasterVolumeLevelScalar(float level, Guid context);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
}
public class WindowsAudio {
    public static void Zero() {
        IAudioDevices devices = (IAudioDevices)(object)new AudioEnumerator();
        // Cover console, multimedia and communications output defaults.
        for (int role = 0; role < 3; role++) {
            IAudioDevice device;
            Marshal.ThrowExceptionForHR(devices.GetDefaultAudioEndpoint(0, role, out device));
            Guid iid = typeof(IAudioVolume).GUID;
            object instance;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
            IAudioVolume volume = (IAudioVolume)instance;
            Marshal.ThrowExceptionForHR(volume.SetMasterVolumeLevelScalar(0f, Guid.Empty));
            float actual;
            Marshal.ThrowExceptionForHR(volume.GetMasterVolumeLevelScalar(out actual));
            if (actual != 0f) throw new Exception("Volume verification failed");
        }
    }
}
'@
[WindowsAudio]::Zero()
[pscustomobject]@{ volumePercent = 0 } | ConvertTo-Json -Compress
`;
