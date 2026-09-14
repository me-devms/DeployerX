param([long]$WindowHandle, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class VncKeyboard {
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    static readonly Hook callback = Handle;
    static readonly HashSet<int> captured = new HashSet<int>();
    static IntPtr hook, window;
    static long lease;
    static bool Held(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    public static bool ShouldCapture(int key, bool alt, bool ctrl) {
        return key == 0x5b || key == 0x5c || key == 0x2c ||
            (alt && (key == 9 || key == 0x73 || key == 27 || key == 32)) || (ctrl && key == 27);
    }
    static IntPtr Handle(int code, IntPtr message, IntPtr data) {
        if (code < 0) return CallNextHookEx(hook, code, message, data);
        int key = Marshal.ReadInt32(data);
        bool down = message.ToInt64() == 0x100 || message.ToInt64() == 0x104;
        bool active = GetForegroundWindow() == window && DateTime.UtcNow.Ticks < Interlocked.Read(ref lease);
        if (!active) return CallNextHookEx(hook, code, message, data);
        if (captured.Contains(key) || (down && ShouldCapture(key, Held(0x12), Held(0x11)))) {
            if (down) captured.Add(key); else captured.Remove(key);
            Console.WriteLine(key + ":" + (down ? "1" : "0"));
            return new IntPtr(1);
        }
        return CallNextHookEx(hook, code, message, data);
    }
    public static void Run(long handle) {
        window = new IntPtr(handle);
        hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var input = new Thread(() => {
            string line;
            while ((line = Console.ReadLine()) != null) {
                Interlocked.Exchange(ref lease, line == "on" ? DateTime.UtcNow.AddSeconds(1).Ticks : 0);
            }
            Environment.Exit(0);
        });
        input.IsBackground = true;
        input.Start();
        var timer = new System.Windows.Forms.Timer { Interval = 50 };
        timer.Tick += (sender, args) => {
            if (GetForegroundWindow() == window && DateTime.UtcNow.Ticks < Interlocked.Read(ref lease)) return;
            foreach (int key in captured) Console.WriteLine(key + ":0");
            captured.Clear();
        };
        timer.Start();
        Console.WriteLine("ready");
        try { Application.Run(); } finally { timer.Dispose(); UnhookWindowsHookEx(hook); }
    }
}
'@
if ($CheckOnly) {
    if (![VncKeyboard]::ShouldCapture(0x5b, $false, $false)) { throw 'Windows key missing' }
    if (![VncKeyboard]::ShouldCapture(9, $true, $false)) { throw 'Alt+Tab missing' }
    if ([VncKeyboard]::ShouldCapture(65, $false, $false)) { throw 'Ordinary typing captured' }
    if ([VncKeyboard]::ShouldCapture(27, $false, $false)) { throw 'Plain Escape captured' }
    'Keyboard checks passed'
} else { [VncKeyboard]::Run($WindowHandle) }
