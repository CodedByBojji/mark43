using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Rubik.WindowsAgent;

internal static class WindowsNative
{
    public static WindowContext? GetForegroundContext(bool includeTitle)
    {
        var hwnd = GetForegroundWindow(); if (hwnd == IntPtr.Zero) return null;
        GetWindowThreadProcessId(hwnd, out uint pid);
        string process = "unknown";
        try { process = Process.GetProcessById((int)pid).ProcessName; } catch { }
        string? title = null;
        if (includeTitle) { var sb = new StringBuilder(512); int n = GetWindowText(hwnd, sb, sb.Capacity); if (n > 0) title = sb.ToString(0, n); }
        GetWindowRect(hwnd, out var r);
        var monitor = MonitorFromWindow(hwnd, 2);
        var dpi = GetDpiForWindow(hwnd); if (dpi == 0) dpi = 96;
        var device = new MONITORINFOEX { Size = Marshal.SizeOf<MONITORINFOEX>() };
        string? monitorId = GetMonitorInfo(monitor, ref device) ? device.Device : null;
        return new(pid, process, title, monitorId, dpi, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top);
    }
    public static Coordinate GetCoordinate(int x, int y)
    {
        var point = new POINT { X = x, Y = y };
        var monitor = MonitorFromPoint(point, 2);
        var info = new MONITORINFOEX { Size = Marshal.SizeOf<MONITORINFOEX>() };
        string? id = GetMonitorInfo(monitor, ref info) ? info.Device : null;
        uint dpi = 96;
        if (monitor != IntPtr.Zero && GetDpiForMonitor(monitor, 0, out var dx, out _) == 0) dpi = dx;
        return new(x, y, "physical_screen", id, dpi);
    }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MONITORINFOEX
    { public int Size; public RECT Monitor, Work; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Device; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(POINT point, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
}
