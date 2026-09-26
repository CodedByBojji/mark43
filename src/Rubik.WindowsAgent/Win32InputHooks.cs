using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Rubik.WindowsAgent;

/// <summary>Low-level callbacks only copy a few fields; no UIA, logging, allocation-heavy work, or disk I/O.</summary>
internal sealed class Win32InputHooks : IDisposable
{
    private readonly Action<RawInput> _enqueue;
    private readonly HookProc _mouseProc, _keyboardProc;
    private readonly IntPtr _mouse, _keyboard;
    private bool _disposed;
    public Win32InputHooks(Action<RawInput> enqueue)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows hooks require an interactive Windows session.");
        _enqueue = enqueue; _mouseProc = MouseCallback; _keyboardProc = KeyboardCallback;
        _mouse = SetWindowsHookEx(14, _mouseProc, IntPtr.Zero, 0);
        if (_mouse == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        _keyboard = SetWindowsHookEx(13, _keyboardProc, IntPtr.Zero, 0);
        if (_keyboard == IntPtr.Zero) { UnhookWindowsHookEx(_mouse); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    }
    private IntPtr MouseCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            int msg = unchecked((int)wParam.ToInt64());
            if (msg is 0x0201 or 0x0204 or 0x0207) _enqueue(new(ObservationKind.MouseClick, data.Point.X, data.Point.Y, true));
            else if (msg == 0x020A) _enqueue(new(ObservationKind.MouseWheel, data.Point.X, data.Point.Y, true));
        }
        return CallNextHookEx(_mouse, code, wParam, lParam);
    }
    private IntPtr KeyboardCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            int msg = unchecked((int)wParam.ToInt64());
            // Only control keys; printable keys and all text are deliberately discarded.
            if (msg is 0x0100 or 0x0104)
            {
                string? key = data.VirtualKey switch { 0x0D => "Enter", 0x09 => "Tab", 0x1B => "Escape", 0x08 => "Backspace", 0x2E => "Delete", 0x25 => "Left", 0x26 => "Up", 0x27 => "Right", 0x28 => "Down", 0x70 => "F1", 0x71 => "F2", 0x72 => "F3", 0x73 => "F4", _ => null };
                if (key is not null) _enqueue(new(ObservationKind.ControlKey, ControlKey: key));
            }
        }
        return CallNextHookEx(_keyboard, code, wParam, lParam);
    }
    public void Dispose() { if (_disposed) return; _disposed = true; UnhookWindowsHookEx(_mouse); UnhookWindowsHookEx(_keyboard); }
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT Point; public uint MouseData, Flags, Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint VirtualKey, ScanCode, Flags, Time; public UIntPtr ExtraInfo; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
}
