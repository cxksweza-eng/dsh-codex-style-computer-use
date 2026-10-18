// dsh-computer-use · native worker (stage-0)
//
// A single-file, self-contained C# 5 console program — deliberately C# 5
// because the only compiler guaranteed to exist on every Windows box is the
// legacy csc.exe at %windir%\Microsoft.NET\Framework64\v4.0.30319, which is
// frozen at C# 5 / .NET 4.5 reference assemblies. No SDK, no node-gyp, no
// network. Speaks NDJSON over stdio: one {"op","args"} per line in, one
// {"id","ok","data"|"error"} per line out; first line out is the ready event.
//
// References: System.Drawing, System.Web.Extensions, UIAutomationClient,
//             UIAutomationTypes (resolved from the GAC by full path).
//
// Safety model: the worker is a faithful actuator. Policy (approvals,
// blacklists, masking) lives in the DSH plugin / MCP gate layers. Worker-side
// guards: exact physical Ctrl+Esc for manual pause, event-driven human ownership,
// and accepted-input cleanup. Physical activity yields until three seconds quiet.

using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms; // Clipboard (watch out: bare Point stays our own struct)

namespace DshComputerUse.Worker
{
    // Monotonic, event-driven ownership. A brief touch yields immediately; two seconds
    // of continued input/holding enters waiting. Only three seconds with no held input
    // and no physical event returns control. Ordinary input never creates a STOP file.
    public sealed class HumanInputState
    {
        public const int SustainedMs = 2000, IdleMs = 3000;
        readonly object sync = new object();
        readonly HashSet<int> held = new HashSet<int>();
        bool enabled, seen;
        string phase = "idle", lastKind = "none";
        long first, last, revision, burst;
        public string Phase { get { lock (sync) { return phase; } } }
        public long Revision { get { lock (sync) { return revision; } } }
        public bool Active { get { lock (sync) { return phase != "idle"; } } }
        public string LastKind { get { lock (sync) { return lastKind; } } }
        public bool Held(int vk)
        {
            lock (sync)
            {
                if (held.Contains(vk)) return true;
                if (vk == 0x10) return held.Contains(0xA0) || held.Contains(0xA1);
                if (vk == 0x11) return held.Contains(0xA2) || held.Contains(0xA3);
                if (vk == 0x12) return held.Contains(0xA4) || held.Contains(0xA5);
                if (vk == 0xA0 || vk == 0xA1) return held.Contains(0x10);
                if (vk == 0xA2 || vk == 0xA3) return held.Contains(0x11);
                if (vk == 0xA4 || vk == 0xA5) return held.Contains(0x12);
                return false;
            }
        }
        public void Enable(bool on, long now)
        {
            lock (sync)
            {
                if (enabled == on) return;
                enabled = on;
                if (!on) { phase = "idle"; return; }
                if (held.Count > 0 || (seen && now - last < IdleMs)) Start(now);
            }
        }
        void Start(long now) { phase = "yielding"; first = now; if (!seen) last = now; burst++; }
        public void Record(int key, bool down, bool up, long now)
        {
            lock (sync)
            {
                bool continued = held.Count > 0 || (seen && now - last < IdleMs);
                lastKind = key == 0 ? "pointer-or-wheel" : key <= 6 ? "button" : "keyboard";
                if (key != 0) { if (down) held.Add(key); if (up) held.Remove(key); }
                seen = true; last = now; revision++;
                if (!enabled) return;
                if (phase == "idle" || !continued) Start(now);
                if (now - first >= SustainedMs) phase = "waiting";
            }
        }
        public void Tick(long now)
        {
            lock (sync)
            {
                if (!enabled || phase == "idle") return;
                if (held.Count == 0 && now - last >= IdleMs) { phase = "idle"; return; }
                if (held.Count > 0 && now - first >= SustainedMs) phase = "waiting";
            }
        }

        /// <summary>
        /// Drop the accumulated physical-input burst and return to `idle`, without forgetting which
        /// keys are still physically held. Used when an approval hold is released: the movement that
        /// reached the approval button must not be mistaken for a takeover, but a key the human is
        /// still holding must still be honoured (Held/`held` is left untouched).
        /// </summary>
        public void Rebaseline(long now)
        {
            lock (sync)
            {
                phase = "idle";
                seen = false;
                first = now;
                last = now;
                // `held`, `burst` and `revision` are deliberately preserved: the revision counter is a
                // monotonic witness other code compares against, and a held key is a fact about the
                // physical keyboard, not about the burst we are resetting.
            }
        }
        public object Snapshot(long now, bool approvalHold = false)
        {
            lock (sync) return Program.Dict("phase", phase, "active", phase != "idle",
                "approvalHold", approvalHold,
                "revision", revision, "burst", burst, "heldCount", held.Count, "lastKind", lastKind,
                "quietRemainingMs", phase == "idle" ? 0 : held.Count > 0 ? IdleMs : Math.Max(0, IdleMs - (now - last)),
                "sustainedMs", SustainedMs, "idleMs", IdleMs);
        }
    }

    // A temporary pause is an explicit, single-use claim. No clock grants permission.
    public sealed class RecoveryPermit
    {
        public string Id = Guid.NewGuid().ToString("N");
        public long Target, InputVersion;
        public uint Pid, InputTick;
        public bool Observed;
        public string Problem(string id, bool live, bool exited, bool stopped, long input,
            uint tick, bool targetExists, long foreground, uint pid)
        {
            if (id != Id || string.IsNullOrEmpty(id)) return "pause credential changed";
            if (!live || exited || !stopped) return "pause no longer belongs to a live cycle";
            if (!Observed) return "read the current target state after this pause first";
            if (input != InputVersion || tick == 0 || tick != InputTick) return "external input occurred after the pause";
            if (Target == 0 || Pid == 0 || !targetExists || foreground != Target || pid != Pid) return "target changed or lost focus";
            return null;
        }
    }

    // Compare and delete the exact exclusively opened file, never a path checked earlier.
    public static class OwnedStopRecord
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access,
            uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
            int kind, ref byte value, uint size);
        public static bool TryRelease(string path, string expected, out string problem)
        {
            problem = "";
            try
            {
                using (var handle = CreateFile(path, 0x80010000u, 0, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (handle.IsInvalid) { problem = "stop unavailable or locked"; return false; }
                    using (var stream = new FileStream(handle, FileAccess.Read))
                    {
                        if (stream.Length > 8192) { problem = "stop record changed"; return false; }
                        byte[] bytes = new byte[(int)stream.Length];
                        int count = 0, read;
                        while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) > 0) count += read;
                        if (count != bytes.Length || Encoding.UTF8.GetString(bytes) != expected) { problem = "stop record changed"; return false; }
                        byte delete = 1; // FILE_DISPOSITION_INFO is one BOOLEAN.
                        if (!SetFileInformationByHandle(handle, 4, ref delete, 1)) { problem = "stop release failed"; return false; }
                    }
                }
                if (File.Exists(path)) { problem = "a newer stop stands"; return false; }
                return true;
            }
            catch (Exception ex) { problem = ex.Message; return false; }
        }
    }

    // Text-first kickoff: activation binds an intended window before desktop pixels are read.
    // This decision class has no Win32 calls; the native dispatcher supplies fresh observations.
    public sealed class KickoffFocus
    {
        readonly object sync = new object();
        long hwnd;
        uint pid;
        public long Target { get { lock (sync) { return hwnd; } } }
        public void Reset() { lock (sync) { hwnd = 0; pid = 0; } }
        public void Confirm(long target, uint process)
        {
            lock (sync) { hwnd = target; pid = process; }
        }
        public string CaptureProblem(bool active, bool paused, bool exited,
                                     bool targetExists, long foreground, uint process, bool host)
        {
            // Inspecting a paused/exited machine remains read-only and never re-focuses it.
            if (!active || paused || exited) return null;
            lock (sync)
            {
                if (hwnd == 0 || pid == 0) return "no target has been activated in this cycle";
                if (!targetExists) return "the activated target window no longer exists";
                if (host) return "the agent host is in front of the target window";
                if (hwnd != foreground || pid != process) return "the foreground no longer matches the activated target";
                return null;
            }
        }
        public static string InputProblem(long expected, bool exists, long foreground)
        {
            if (expected == 0) return null; // legacy unbound callers have no expected identity
            if (!exists) return "the expected window no longer exists; enumerate windows and activate the new target";
            if (foreground != expected) return "activation did not bring the expected window to the foreground";
            return null;
        }
    }

    // ---------- interop ----------
    // Win32 INPUT is a tagged union: [DWORD type][union { MOUSEINPUT | KEYBDINPUT | HARDWAREINPUT }].
    //
    // CRITICAL (found 2026-09-12, the hard way): the three union members MUST be
    // overlapped — LayoutKind.Explicit, all at FieldOffset(0). When they are declared
    // sequentially (the original form) Marshal.SizeOf(INPUT) is 80 instead of 40, and
    // SendInput validates cbSize against the OS's sizeof(INPUT) (40 on x64, 28 on x86):
    // every call returns 0 with ERROR_INVALID_PARAMETER (87) and injects NOTHING —
    // mouse and keyboard alike. Because the old code never checked the return value,
    // the worker kept replying ok:true while the cursor never moved, which is invisible
    // to anyone (or any model) that cannot see the screen. SendInputChecked() below now
    // turns any such failure into a loud error.
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg, wParamL, wParamH; }
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct CURSORINFO { public uint cbSize, flags; public IntPtr hCursor; public POINT ptScreenPos; }

    static class Native
    {
        public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
            MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
            MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040,
            MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000,
            MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
        // Right-hand Ctrl/Alt/Win produce an E0-prefixed scan code ("extended" keys) — Microsoft's
        // KEYBDINPUT.dwFlags documents KEYEVENTF_EXTENDEDKEY as that prefix. Right SHIFT is NOT an
        // extended key (its own scan code 0x36, no E0), so it must NOT carry this flag.
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint WHEEL_DELTA = 120;
        public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77,
            SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79, SM_CMONITORS = 80;
        public const uint WM_CLOSE = 0x0010;
        public const int SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_RESTORE = 9, SW_SHOWNOACTIVATE = 4, SW_SHOW = 5;
        public const uint CURSOR_SHOWING = 0x00000001, DI_NORMAL = 0x0003;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value); // -4 = PerMonitorV2
        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

        // "Has the human touched ANYTHING?" — the system-wide last-input tick.
        // This is how the ask op knows whether the human answered inside the window: it is a fact
        // about the machine, not a guess about intent. Synthetic input bumps it too, which is why
        // the ask op must send NOTHING while it waits.
        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        // ---- the wheel hook: "a hand on the mouse" that the cursor monitor cannot see -----------
        // GetCursorPos does not move when the wheel turns, so a human scrolling the page out from
        // under the agent was invisible to the monitor. A low-level mouse hook sees WM_MOUSEWHEEL
        // with the same dwExtraInfo magic the keyboard hook uses, so OUR OWN scrolling (SendMouse
        // stamps OwnMagic) is excluded by construction rather than by guessing.
        public const int WH_MOUSE_LL = 14;
        public const int WM_MOUSEWHEEL_ = 0x020A;
        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
        public static uint LastInputTick()
        {
            try
            {
                LASTINPUTINFO li = new LASTINPUTINFO();
                li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
                if (GetLastInputInfo(ref li)) return li.dwTime;
            }
            catch { }
            return 0;
        }
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
        // ---- focus / integrity probing (2026-09-13 "typing never lands" investigation) ----
        [DllImport("user32.dll")]
        public static extern IntPtr GetParent(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr h, ref POINT p);
        // ground-truth probes (see ProbePoint/ProbeFocus)
        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr h, int index);
        [DllImport("user32.dll")]
        public static extern bool IsWindowEnabled(IntPtr h);
        [DllImport("user32.dll")]
        public static extern bool IsHungAppWindow(IntPtr h);
        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr h);
        // UIPI drops synthetic input aimed at a higher-integrity window WITHOUT any error —
        // the one failure mode a "did my click work?" probe cannot see from the outside.
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr h);
        // ---- host guard: which executable is the process that owns this window? ----
        // OpenProcess + QueryFullProcessImageName is the ONLY safe way to ask: Process.MainModule
        // throws for any process this worker may not read (see IsHostPid).
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder buf, ref int size);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr token, int cls, out uint info, uint len, out uint ret);
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x0008;
        public const int TokenElevation = 20;
        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int x1, int y1, uint rop);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr obj);
        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint biColors; }
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
        [DllImport("user32.dll")]
        public static extern bool GetCursorInfo(ref CURSORINFO pci);
        [DllImport("user32.dll")]
        public static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyHeight, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, uint diFlags);
        [DllImport("user32.dll")]
        public static extern uint SendNotifyMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

        // ---- low-level keyboard hook: the human's emergency brake ----
        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetMessage(out NativeMsg msg, IntPtr hWnd, uint min, uint max);
        [DllImport("user32.dll")]
        public static extern bool TranslateMessage(ref NativeMsg msg);
        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref NativeMsg msg);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(string cls, string win);
        [DllImport("user32.dll")]
        public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);
        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct NativeMsg { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int ptX, ptY; }
        public const int WH_KEYBOARD_LL = 13, WM_KEYDOWN_ = 0x0100, WM_SYSKEYDOWN_ = 0x0104,
                         WM_KEYUP_ = 0x0101, WM_SYSKEYUP_ = 0x0105;
        // KBDLLHOOKSTRUCT.flags bit 4: the key did NOT come from the physical keyboard — some
        // program called SendInput/keybd_event (a remote-control session, a macro tool, ourselves).
        // Microsoft documents this as LLKHF_INJECTED; it is the only field that separates "a hand on
        // this keyboard" from "another program typing on its behalf" (D, 2026-09-13).
        public const uint LLKHF_INJECTED = 0x10;
        public const int VK_ESCAPE = 0x1B, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_Q = 0x51, VK_SHIFT = 0x10, VK_R = 0x52;
        // Mice and the left Windows key, needed by ReleaseStuck(): a release may only be sent for a
        // button/key the OS reports as DOWN (bug, 2026-09-13).
        public const int VK_LBUTTON = 0x01, VK_RBUTTON = 0x02, VK_MBUTTON = 0x04, VK_LWIN = 0x5B;
    }

    // ---------- agent activity indicator (GPT-desktop-style cue) ----------
    // While the agent is driving the mouse/keyboard, a soft blue glow hugs the border of
    // the screen, so the human always knows who owns the pointer — the visual answer to
    // "is the machine doing something right now?".
    //
    // Deliberate properties:
    //   * click-through (WS_EX_TRANSPARENT) and never-activating (WS_EX_NOACTIVATE):
    //     the overlay can never steal focus from the app being driven.
    //   * uses the built-in "STATIC" window class, so there is no RegisterClass / WndProc
    //     to get wrong.
    //   * the glow bitmap is rendered ONCE; showing/hiding only changes the layered
    //     window's constant alpha (~0 cost per frame), which keeps it smooth during drags.
    static class Glow
    {
        const int WS_POPUP = unchecked((int)0x80000000);
        const int WS_EX_LAYERED = 0x00080000, WS_EX_TRANSPARENT = 0x00000020,
                  WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000,
                  WS_EX_TOPMOST = 0x00000008;
        const int ULW_ALPHA = 2, AC_SRC_OVER = 0, AC_SRC_ALPHA = 1;
        const int SW_SHOWNOACTIVATE = 4, SW_HIDE = 0;
        const uint PM_REMOVE = 1;

        [StructLayout(LayoutKind.Sequential)] struct POINTL { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct SIZEL { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int ptX, ptY; }

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr CreateWindowEx(int exStyle, string cls, string name, int style,
            int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
        [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref Native.BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINTL pptDst, ref SIZEL psize,
            IntPtr src, ref POINTL pptSrc, int colorKey, ref BLENDFUNCTION blend, int flags);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

        static Thread _thread;
        static volatile int _lastTouchMs;       // 0 = never; else Environment.TickCount of the last actuation
        static volatile int _holdMs = 900;
        static volatile bool _enabled = true;
        static volatile string _label = "AI 正在操控此电脑 · 监听中";

        /// Mark "the agent is acting right now" — the glow stays lit for holdMs afterwards.
        public static void Touch(int holdMs)
        {
            if (!_enabled) return;
            _holdMs = holdMs < 200 ? 200 : holdMs;
            _lastTouchMs = Environment.TickCount;
            EnsureStarted();
        }
        public static void Off() { _lastTouchMs = 0; _thinking = false; }

        // ---- "INPUT IS HAPPENING RIGHT NOW" IS A FACT, NOT A GUESS (indicator bug, 2026-09-13) ----
        // Measured on the production build: a real move(moveDurationMs=3500) took 3823 ms, and the
        // deep-blue ACTING border had already expired at its fixed 1200 ms hold WHILE SendInput steps
        // were still being injected — pixels went blue at 1737 ms, then cyan/green at 2153/3438 ms with
        // moveStillPending:true on all eight frames. Nothing here lengthens the hold: the hold is
        // still 1200 ms. What changes is WHERE IT IS ANCHORED (the last real injection, not the moment
        // the op began) and that an injection SEQUENCE in flight is a state the light can read.
        static int _injecting = 0;               // refcount; Interlocked supplies the barriers
        public static void InputBegin() { Interlocked.Increment(ref _injecting); }
        public static void InputEnd() { if (Interlocked.Decrement(ref _injecting) < 0) _injecting = 0; }
        public static bool Injecting { get { return _injecting > 0; } }
        /// Re-anchor the ACTING light on the injection itself: called from the ONE function every real
        /// SendInput goes through, so a multi-step op (type/drag/scroll/key/animated move) stays blue
        /// for as long as its events keep coming, and still fades on the same short tail once they
        /// stop. The old behaviour anchored on the op's START, so any op longer than the hold went
        /// cyan mid-flight — the "not a long think, the input is still running" report.
        public static void KeepActing() { _lastTouchMs = Environment.TickCount; }

        // Emergency stop must LOOK like one. The normal fade is a slow ease (~1.6 s) which,
        // during a panic, reads as "nothing happened" — so this snaps the overlay to zero on
        // the very next tick instead of easing down.
        static volatile bool _killNow = false;
        public static void Kill()
        {
            _lastTouchMs = 0; _thinking = false; _flashStart = 0;
            _killNow = true;
        }

        // Cyan thinking/monitoring is a lifecycle latch, with no elapsed-time expiry. Off/Kill
        // clear it on explicit lifecycle transitions; approval waits and thinking may take as
        // long as needed. A bool also avoids TickCount wraparound changing a long-lived cycle.
        static volatile bool _thinking = false;
        public static void HumanYield() { EnsureStarted(); }
        public static bool ThinkingActive { get { return _enabled && _thinking; } }

        /// Mark "the agent is engaged" until an explicit Off/Kill. The holdMs argument remains
        /// for caller compatibility but cannot impose an expiry on the computer-use cycle.
        public static void Thinking(int holdMs)
        {
            if (!_enabled) return;
            _thinking = true;
            EnsureStarted();
        }

        // yellow "a screenshot was just taken" flash, drawn around the captured region
        static volatile int _flashStart = 0, _flashMs = 620;
        static volatile int _fx, _fy, _fw, _fh;
        static volatile bool _stoppedMode = false;
        static volatile bool _askMode = false;
        /// **The agent is asking a question** — the ONE red border the human did not raise.
        ///
        /// It must be unmistakable in two ways at once (human spec 2026-09-12): RED like a stop,
        /// but BREATHING AT TWICE THE CYAN RATE (1250 ms vs 2500 ms).
        ///
        /// THERE IS NO CLOCK (merge-design.md §5.1 item 10). This comment used to say the state was
        /// TIME-BOXED and that the human's look "hands over to the ordinary steady red: the clock is
        /// gone" — there is no clock to be gone at either end now: `beginAsk` engages this state and
        /// returns, and `endAsk` leaves it either way, and the answer comes from the client-UI card
        /// with no countdown. What the card's ①/② choice decides is whether the brake STAYS (Ask off,
        /// Stopped on: the ordinary steady pause, the human's own) or goes (both off).
        public static void Ask(bool on) { _askMode = on; }

        /// The ONE derivation of "which light is on screen", as a pure function of the panic flags.
        ///
        /// F2 (2026-09-13): this used to be computed inline in the render loop from `_askMode`,
        /// `_stoppedMode` and the flash, with `Panic.Exited` handled only by imperatively calling
        /// Glow.Kill()/Stopped(false) from Exit(). That is a check-then-paint race: the ask state's
        /// own ending (now `EndAsk`, running on the op thread when `endAsk` arrives) could
        /// set `_stoppedMode` again a microsecond AFTER the teardown had cleared it, and the very
        /// next frame painted the steady red of a pause on a session that had just been ended.
        /// With the derivation here, "an exit outranks every other flag" is structural: there is no
        /// window between the check and the paint, because there is no check to race — the frame
        /// simply derives 0 for as long as the record stands.
        public static int DeriveWant(bool flashOn, int committed)
        {
            if (Panic.Exited) return 0;
            return _askMode ? 5 : (_stoppedMode ? 4 : (Panic.HumanActive ? 6 : (flashOn ? 2 : committed)));
        }
        /// The title states the same fact as the light, derived the same way (an ended session must
        /// not advertise "已暂停 · Ctrl+Alt+R 继续" in the window list).
        public static string DeriveTitle(string label)
        {
            if (Panic.Exited) return "AI 已停止操控 · 未监听";
            return _askMode ? "AI 正在提问 · 在 DSH 聊天里回答 · 无倒计时（Ctrl+Alt+R 撤销）"
                : (_stoppedMode ? "已暂停 · Ctrl+Alt+R 继续 · Ctrl+Alt+Q 退出" : Panic.HumanActive ? "已让出键鼠 · 等待人操作 · 静默 3 秒后继续" : label);
        }
        static volatile string _shownTitle = null;
        // What the indicator is ACTUALLY rendering right now, readable from outside via `probe`.
        // The light is a fact about the machine, so it gets the same treatment as every other fact
        // in this file: it must be observable without a screenshot and without trusting prose.
        static volatile int _want = 0;
        public static int Want { get { return _want; } }
        public static string ShownTitle { get { return _shownTitle; } }
        static IntPtr _hwnd = IntPtr.Zero;
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool SetWindowText(IntPtr h, string text);
        public static void Stopped(bool on)
        {
            _stoppedMode = on;
            // The overlay's WINDOW TITLE is part of the text channel: renaming it means any
            // window list — the agent's own computer_windows, or a human's Task Manager —
            // states plainly that the session is stopped, with no screenshot required.
            if (_hwnd != IntPtr.Zero)
            {
                try { SetWindowText(_hwnd, on ? "已暂停 · Ctrl+Alt+R 继续 · Ctrl+Alt+Q 退出" : _label); } catch { }
            }
        }

        /// Mark "the agent just captured the screen": a yellow border flashes around the
        /// captured rectangle (the whole screen for a full-screen grab), so the human can
        /// see exactly which step took the picture.
        public static void Flash(int x, int y, int w, int h, int ms)
        {
            // A capture must read as an EVENT, and since 2026-09-12 it reads as a THREE-BEAT cue
            // (user-requested): two quick pulses to "charge up", then a burst at full brightness,
            // then a short fade. The shape lives in FlashAlpha(); this only sets the window.
            // (2026-09-13 history: the frame used to look "always on" because a 900 ms throttle
            // dropped most flashes and the alpha eased slowly; then it went INVISIBLE entirely
            // because the present was gated on an alpha change it had already snapped past.)
            _fx = x; _fy = y; _fw = w; _fh = h;
            _flashMs = Math.Max(200, Math.Min(900, ms));
            _flashStart = Environment.TickCount;
            if (_flashStart == 0) _flashStart = 1;
            EnsureStarted();
        }

        // Layer alpha that means "full" for every state (80% of 255, per the human's request).
        public const int FullAlpha = 204;

        /// The capture cue's brightness envelope, in ms since the flash started:
        ///   0- 70  pulse 1, about half brightness      (charge)
        ///  70-130  off
        /// 130-200  pulse 2, about three quarters       (charge)
        /// 200-250  off
        /// 250-300  BURST at full brightness            ("啪" )
        /// 300-560  short fade out
        /// Returns the LAYER alpha only: the bitmap keeps its own soft gradient, so the cue stays
        /// a glow rather than a hard stripe.
        static int FlashAlpha(int e)
        {
            if (e < 0) return 0;
            if (e < 70) return (int)(FullAlpha * 0.45);
            if (e < 130) return (int)(FullAlpha * 0.10);
            if (e < 200) return (int)(FullAlpha * 0.75);
            if (e < 250) return (int)(FullAlpha * 0.15);
            if (e < 300) return FullAlpha;
            double t = (e - 300) / 260.0;
            if (t >= 1.0) return 0;
            return (int)Math.Round(FullAlpha * Math.Pow(1 - t, 1.7));
        }

        public static bool Enabled { get { return _enabled; } set { _enabled = value; } }

        /// Force the overlay into existence. Used when a stop is ADOPTED from another process:
        /// the red border must be visible even though this process never actuated anything.
        public static void Reveal() { _enabled = true; EnsureStarted(); }

        static void EnsureStarted()
        {
            if (_thread != null) return;
            lock (typeof(Glow))
            {
                if (_thread != null) return;
                _thread = new Thread(ThreadProc);
                _thread.IsBackground = true;
                _thread.Name = "dsh-glow";
                _thread.Start();
            }
        }

        static void ThreadProc()
        {
            try { Run(); } catch { /* the indicator must never break actuation */ }
        }

        static void Run()
        {
            int vx = GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (vw <= 0 || vh <= 0) return;

            IntPtr hwnd = CreateWindowEx(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                "STATIC", _label, WS_POPUP, vx, vy, vw, vh, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (hwnd == IntPtr.Zero) return;
            _hwnd = hwnd;

            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            Native.BITMAPINFO bmi = new Native.BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = vw;
            bmi.bmiHeader.biHeight = -vh;          // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0;
            IntPtr bits;
            IntPtr dib = CreateDIBSection(screenDc, ref bmi, 0, out bits, IntPtr.Zero, 0);
            if (dib == IntPtr.Zero) { DeleteDC(memDc); ReleaseDC(IntPtr.Zero, screenDc); return; }
            IntPtr oldBmp = SelectObject(memDc, dib);

            POINTL dst = new POINTL(); dst.x = vx; dst.y = vy;
            POINTL src = new POINTL(); src.x = 0; src.y = 0;
            SIZEL size = new SIZEL(); size.cx = vw; size.cy = vh;

            // ---- state machine with dwell hysteresis (no strobing) ----
            int curBitmap = 0;      // 0 = none, 1 = blue border, 2 = yellow flash
            int paintedFlash = 0;
            int alpha = 0;
            bool visible = false;
            int committed = 0;      // 0 idle / 1 acting / 3 thinking, committed after a dwell
            int pending = -1;
            int pendingSince = 0;
            while (true)
            {
                // ACTING = input in flight (a sequence, across its sleeps) OR the short tail after the
                // last injection. Never "a longer guess": the hold is unchanged and the tail still ends.
                bool acting = _enabled && (Injecting ||
                    (_lastTouchMs != 0 && unchecked(Environment.TickCount - _lastTouchMs) < _holdMs));
                bool thinking = ThinkingActive;
                bool flashOn = _flashStart != 0 && unchecked(Environment.TickCount - _flashStart) < _flashMs;

                int live = acting ? 1 : (thinking ? 3 : 0);
                // The flash is an OVERRIDE, never a state that lingers.
                //
                // 2026-09-13: the flash used to write `committed = 2`, so once it ended the dwell
                // hysteresis (600 ms) held the yellow bitmap on screen — with the border snapped to
                // full alpha that read as "the yellow frame is permanently lit", and the human lost
                // the ability to tell WHICH step took a screenshot. Now yellow shows only while the
                // flash is actually running (<=400 ms) and the border drops straight back to deep
                // blue when acting, or pale breathing when thinking.
                if (!flashOn)
                {
                    if (live != committed)
                    {
                        // require a state to hold for 600 ms before switching: kills strobe
                        if (pending != live) { pending = live; pendingSince = Environment.TickCount; }
                        else if (unchecked(Environment.TickCount - pendingSince) >= 600) { committed = live; pending = -1; }
                    }
                    else { pending = -1; }
                }

                // ONE derivation (Glow.DeriveWant): the exit flag outranks ask/stop/flash/committed,
                // so no later state change on another thread can paint a light on an ended session.
                int want = DeriveWant(flashOn, committed);
                _want = want;            // publish it: the state the light is showing, as a fact

                // Keep the overlay's WINDOW TITLE in sync with the state, from the render loop.
                // 2026-09-13: the title was only written by Stopped(), which runs BEFORE this thread
                // creates the window — so a process that INHERITED a stop (SyncFromFile at startup)
                // showed a red border with the title "AI 正在操控此电脑". The title is the text
                // channel the agent and the human both read, so a lying title is worse than none.
                // It is derived from the same flags (Glow.DeriveTitle) and a hidden window still has
                // a title — leaving "监听中" on a window whose cycle is over is the same class of lie.
                string wantTitle = DeriveTitle(_label);
                if (wantTitle != _shownTitle)
                {
                    _shownTitle = wantTitle;
                    try { SetWindowText(hwnd, wantTitle); } catch { }
                }

                // hard cut on emergency stop: no easing, no afterglow
                if (_killNow)
                {
                    _killNow = false;
                    alpha = 0;
                    if (visible) { ShowWindow(hwnd, SW_HIDE); visible = false; }
                    curBitmap = 0; committed = 0; pending = -1; paintedFlash = 0;
                    MSG mk; while (PeekMessage(out mk, hwnd, 0, 0, PM_REMOVE)) { }
                    Thread.Sleep(12);
                    continue;
                }
                // want: 0 idle | 1 acting (deep blue) | 3 thinking (pale blue) | 2 flash (yellow)
                //       4 emergency-stopped (RED, steady — the session is dead until re-armed)
                int needBitmap = want == 6 ? 5 : want == 2 ? 2 : (want == 0 ? curBitmap : (want == 1 ? 3 : (want == 4 || want == 5 ? 4 : 1)));
                // A REPAINT MUST REACH THE SCREEN EVEN WHEN ALPHA DOES NOT MOVE.
                //
                // The present below used to be gated on `diff != 0` alone, while the flash snaps
                // alpha straight to its target three lines further down. So on a flash:
                //   alpha = 204, target = 204, diff = 0  ->  UpdateLayeredWindow never ran, the
                // yellow frame sat in the offscreen bitmap and was NEVER SHOWN (reported
                // 2026-09-12: "screenshots never flash yellow"). The same gate could swallow the
                // RED frame when the border happened to be at full alpha already — whether the
                // brake was visible was luck. Present when EITHER the bitmap or the alpha changed.
                bool repaint = false;
                if (needBitmap == 2 && paintedFlash != _flashStart) { PaintFlash(bits, vw, vh); paintedFlash = _flashStart; curBitmap = 2; alpha = 204; repaint = true; /* snap ON at 80%: a flash is an event, not a fade */ }
                else if (needBitmap == 5 && curBitmap != 5) { PaintHumanYield(bits, vw, vh); curBitmap = 5; repaint = true; }
                else if (needBitmap == 4 && curBitmap != 4) { PaintStop(bits, vw, vh); curBitmap = 4; repaint = true; }
                else if (needBitmap == 3 && curBitmap != 3) { PaintBlue(bits, vw, vh, true); curBitmap = 3; repaint = true; }
                else if (needBitmap == 1 && curBitmap != 1) { PaintBlue(bits, vw, vh, false); curBitmap = 1; repaint = true; }

                // Perceived brightness = bitmap alpha x THIS constant alpha, so the "80% as dense"
                // request is implemented here and only here (the bitmaps keep their own peaks).
                const int FULL = FullAlpha;                // 204 = 80% of 255
                int target;
                bool flashFrame = false;
                bool breathFrame = false;      // breathing states are ABSOLUTE, never eased
                if (want == 0) target = 0;
                else if (want == 2)
                {
                    // The capture cue runs its OWN envelope (wind-up, burst, short fade): an absolute
                    // brightness per frame, never something to ease towards.
                    target = FlashAlpha(unchecked(Environment.TickCount - _flashStart));
                    flashFrame = true;
                }
                else if (want == 1) target = FULL;
                else if (want == 4) target = FULL;         // steady red, no breathing
                else if (want == 6)
                {
                    target = HumanYieldAlpha(Environment.TickCount);
                    breathFrame = true;
                }
                else if (want == 5)
                {
                    // ASK: red like a stop, but at TWICE the cyan breath rate (1250 ms vs 2500 ms)
                    // and FULL SWING 0..100, so the pulse is unmistakable at a glance.
                    double askPhase = (Environment.TickCount % 1250) / 1250.0;
                    target = 50 + (int)(Math.Sin(askPhase * 2 * Math.PI) * 50);
                    breathFrame = true;
                }
                else
                {
                    // Faint blue "thinking", breathing so a still screen still shows life.
                    // 2.5 s cycle = 20% faster than the original 3.0 s.
                    // FULL SWING 0..100 (human spec 2026-09-12). The old 58..104 band was chosen so
                    // the trough never read as "the agent went away" — but between the damped band
                    // and the easing below, the border barely moved at all, which is strictly worse:
                    // a border that is always faintly there says nothing. 0 at the trough is the
                    // point: the ring INHALES and goes dark, then comes back.
                    double phase = (Environment.TickCount % 2500) / 2500.0;
                    target = 50 + (int)(Math.Sin(phase * 2 * Math.PI) * 50);
                    breathFrame = true;
                }

                // Exponential ease, deliberately slow: the blue border glides between
                // states over ~1.5-2 s (the user asked for a gradient, never a blink).
                // The yellow screenshot cue keeps a middling speed so it still reads as
                // an event without lingering on screen.
                int diff = target - alpha;
                // The cue AND the breathing states are absolute: an envelope that is then smoothed
                // by a ~430 ms ease cannot show a 1250 ms pulse. Steady states keep the glide.
                if (flashFrame || breathFrame) alpha = target;
                else if (diff != 0)
                {
                    double k = (curBitmap == 2 ? 0.30 : 0.028);
                    int step = (int)Math.Round(diff * k);
                    if (step == 0) step = diff > 0 ? 1 : -1;
                    alpha += step;
                    if ((diff > 0 && alpha > target) || (diff < 0 && alpha < target)) alpha = target;
                    if (alpha < 0) alpha = 0;
                    if (alpha > 255) alpha = 255;
                }

                // Present on a new bitmap, a moving alpha, or a cue frame (see the flags above).
                if (diff != 0 || repaint || flashFrame)
                {
                    BLENDFUNCTION bf = new BLENDFUNCTION();
                    bf.BlendOp = AC_SRC_OVER; bf.BlendFlags = 0;
                    bf.SourceConstantAlpha = (byte)alpha; bf.AlphaFormat = AC_SRC_ALPHA;
                    if (alpha > 0)
                    {
                        if (!visible)
                        {
                            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                            SetWindowPos(hwnd, new IntPtr(-1), vx, vy, vw, vh, 0x0004 | 0x0010 | 0x0040);
                            visible = true;
                        }
                        UpdateLayeredWindow(hwnd, screenDc, ref dst, ref size, memDc, ref src, 0, ref bf, ULW_ALPHA);
                    }
                    else if (visible) { ShowWindow(hwnd, SW_HIDE); visible = false; }
                }
                MSG m;
                while (PeekMessage(out m, hwnd, 0, 0, PM_REMOVE)) { }
                Thread.Sleep(16);
            }
        }

        /// The agent's activity border, in two clearly different states.
        ///
        /// 2026-09-12 (human request): the two states no longer share a width, and they no longer
        /// share a hue. "thinking" is now a WIDER CYAN halo and "acting" a NARROWER DEEP BLUE one,
        /// so the pair reads unambiguously: an outer cyan ring breathing = the agent is thinking
        /// (it has not touched the machine yet), the inner steady blue = it is driving right now.
        /// The old design made them the same shape and the same hue at different densities, which
        /// is exactly the case where "is it doing something?" becomes a guess.
        ///
        /// Drawn as N concentric rounded-rect strokes whose alpha follows (1-t)^1.8 — a
        /// hand-rolled gradient guaranteed to reach alpha 0 at the INNER edge (a residual
        /// tint there read as a hard seam against near-black windows).
        static void PaintBlue(IntPtr bits, int w, int h, bool intense)
        {
            WithGraphics(bits, w, h, delegate (System.Drawing.Graphics g)
            {
                // Width and intensity are both scaled from ONE place per state, and the layered
                // window's constant alpha does the intensity: perceived brightness = bitmap alpha x
                // layer alpha, so scaling BOTH would give 0.64 where the human asked for 0.8.
                // (2026-09-13: "all frames 80% as dense, 80% as wide".)
                // The CAP has to carry the width: at 1600p the cap is what binds, so a divisor
                // change alone moves nothing (min(46, 1600/26) == min(46, 1600/32) == 46).
                //   acting  : 37 px  (80% of the original 46) — stays INSIDE the thinking ring
                //   thinking: 52 px  (~40% wider)              — reaches OUTSIDE it
                int band = intense
                    ? Math.Max(22, Math.Min(37, Math.Min(w, h) / 32))
                    : Math.Max(30, Math.Min(52, Math.Min(w, h) / 23));
                int r = band + 10;
                int peak = intense ? 240 : 168;
                System.Drawing.Color col = intense
                    ? System.Drawing.Color.FromArgb(255, 46, 132, 255)     // deep, saturated blue
                    : System.Drawing.Color.FromArgb(255, 34, 226, 240);    // cyan halo (thinking)
                const int N = 60;
                float step = (float)band / N;
                for (int i = 0; i < N; i++)
                {
                    double t = (double)i / N;
                    int a = (int)Math.Round(peak * Math.Pow(1 - t, intense ? 2.0 : 1.8));
                    if (a <= 0) continue;
                    float inset = i * step;
                    using (System.Drawing.Pen pen = new System.Drawing.Pen(
                               System.Drawing.Color.FromArgb(a, col.R, col.G, col.B), step + 1.2f))
                    {
                        System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath();
                        AddRound(path, inset, inset, w - inset * 2, h - inset * 2, Math.Max(1, r - inset));
                        g.DrawPath(pen, path);
                        path.Dispose();
                    }
                }
                PaintEscBadge(g, intense ? 238 : 148);
            });
        }

        /// Semi-transparent badge in the top-left corner. The human must be able to SEE that a
        /// brake exists (and whether it is currently on) — a brake nobody can see feels exactly
        /// like no brake at all.
        public static int HumanYieldAlpha(int tick)
        { return 48 + (int)Math.Round(30 * (1 - Math.Cos((unchecked((uint)tick) % 2800) * 2 * Math.PI / 2800.0))); }
        static void PaintHumanYield(IntPtr bits, int w, int h)
        {
            WithGraphics(bits, w, h, delegate(System.Drawing.Graphics g) {
                int band = Math.Max(20, Math.Min(40, Math.Min(w, h) / 30));
                for (int i = 0; i < 48; i++)
                {
                    float inset = (float)i * band / 48;
                    int alpha = (int)(175 * Math.Pow(1 - i / 48.0, 1.8));
                    using (var pen = new Pen(Color.FromArgb(alpha, 255, 231, 151), band / 48f + 1.2f))
                    using (var shape = new System.Drawing.Drawing2D.GraphicsPath())
                    { AddRound(shape, inset, inset, w - 2 * inset, h - 2 * inset, Math.Max(1, band + 8 - inset)); g.DrawPath(pen, shape); }
                }
                PaintBadge(g, "已让出键鼠 · 静默 3 秒后继续 · Ctrl+Esc 暂停", 175, false);
            });
        }

        static void PaintEscBadge(System.Drawing.Graphics g, int opacity)
        {
            PaintBadge(g, "监听中 · Ctrl+Esc 暂停 · Ctrl+Alt+Q 退出", opacity, false);
        }

        static void PaintBadge(System.Drawing.Graphics g, string txt, int opacity, bool red)
        {
            // The human asked for a QUIETER badge (2026-09-13): they already know what the overlay
            // means, so it must inform without shouting. Font at 75% (15 -> 11.25 pt), and text,
            // outline and background all pulled well below full opacity.
            int o = Math.Max(40, Math.Min(255, opacity));
            using (System.Drawing.Font f = new System.Drawing.Font("Microsoft YaHei", 11.25f, System.Drawing.FontStyle.Bold))
            {
                System.Drawing.SizeF sz = g.MeasureString(txt, f);
                float bw = sz.Width + 24f, bh = sz.Height + 12f;
                float x = 22f, y = 22f;
                System.Drawing.Drawing2D.GraphicsPath p = new System.Drawing.Drawing2D.GraphicsPath();
                AddRound(p, x, y, bw, bh, 10f);
                System.Drawing.Color edge = red
                    ? System.Drawing.Color.FromArgb((int)(o * 0.42), 255, 150, 150)
                    : System.Drawing.Color.FromArgb((int)(o * 0.34), 150, 200, 255);
                using (System.Drawing.SolidBrush b = new System.Drawing.SolidBrush(
                           red ? System.Drawing.Color.FromArgb((int)(o * 0.30), 46, 8, 12)
                               : System.Drawing.Color.FromArgb((int)(o * 0.26), 10, 14, 22)))
                    g.FillPath(b, p);
                using (System.Drawing.Pen pen = new System.Drawing.Pen(edge, 1.4f))
                    g.DrawPath(pen, p);
                p.Dispose();
                using (System.Drawing.SolidBrush tb = new System.Drawing.SolidBrush(
                           red ? System.Drawing.Color.FromArgb((int)(o * 0.70), 255, 226, 226)
                               : System.Drawing.Color.FromArgb((int)(o * 0.62), 236, 245, 255)))
                    g.DrawString(txt, f, tb, x + 12f, y + 6f);
            }
        }

        /// The stopped state: a RED border plus a red badge, steady (no breathing) — the
        /// computer-use session is dead until a human re-arms it.
        static void PaintStop(IntPtr bits, int w, int h)
        {
            WithGraphics(bits, w, h, delegate (System.Drawing.Graphics g)
            {
                int band = Math.Max(22, Math.Min(37, Math.Min(w, h) / 32));   // 80% of what it was (cap included)
                int r = band + 10;
                const int N = 60;
                float step = (float)band / N;
                for (int i = 0; i < N; i++)
                {
                    double t = (double)i / N;
                    int a = (int)Math.Round(248 * Math.Pow(1 - t, 2.0));
                    if (a <= 0) continue;
                    float inset = i * step;
                    using (System.Drawing.Pen pen = new System.Drawing.Pen(
                               System.Drawing.Color.FromArgb(a, 238, 66, 74), step + 1.2f))
                    {
                        System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath();
                        AddRound(path, inset, inset, w - inset * 2, h - inset * 2, Math.Max(1, r - inset));
                        g.DrawPath(pen, path);
                        path.Dispose();
                    }
                }
                PaintBadge(g, "已暂停 · Ctrl+Alt+R 继续 · Ctrl+Alt+Q 退出", 252, true);
            });
        }

        /// Yellow "a screenshot was just taken" rectangle around the captured region —
        /// same stepped-gradient treatment, no strokes, no hard edges.
        static void PaintFlash(IntPtr bits, int w, int h)
        {
            int fx = _fx, fy = _fy, fw = _fw, fh = _fh;
            if (fw <= 0 || fh <= 0) { fx = 0; fy = 0; fw = w; fh = h; }
            if (fx < 0) { fw += fx; fx = 0; }
            if (fy < 0) { fh += fy; fy = 0; }
            if (fx + fw > w) fw = w - fx;
            if (fy + fh > h) fh = h - fy;
            if (fw < 8 || fh < 8) { fx = 0; fy = 0; fw = w; fh = h; }

            WithGraphics(bits, w, h, delegate (System.Drawing.Graphics g)
            {
                // 2026-09-12 (human): the capture cue on its own, 40% narrower again — 32 -> 19.
                // The corner radius scales with it (13 -> 8) so the strip still reads as a thin
                // glow instead of a fat rounded rectangle. Width only: the alpha profile is
                // untouched, so the cue keeps its brightness.
                int band = 19;
                int r = 8;
                const int N = 40;
                float step = (float)band / N;
                for (int i = 0; i < N; i++)
                {
                    double t = (double)i / N;
                    int a = (int)Math.Round(200 * Math.Pow(1 - t, 1.9));
                    if (a <= 0) continue;
                    float inset = i * step;
                    using (System.Drawing.Pen pen = new System.Drawing.Pen(
                               System.Drawing.Color.FromArgb(a, 255, 186, 20), step + 1.2f))
                    {
                        System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath();
                        AddRound(path, fx + inset, fy + inset, fw - inset * 2, fh - inset * 2, Math.Max(1, r - inset));
                        g.DrawPath(pen, path);
                        path.Dispose();
                    }
                }
            });
        }

        static void WithGraphics(IntPtr bits, int w, int h, Action<System.Drawing.Graphics> draw)
        {
            using (System.Drawing.Bitmap bmp = new System.Drawing.Bitmap(w, h, w * 4,
                       System.Drawing.Imaging.PixelFormat.Format32bppPArgb, bits))
            {
                using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.Clear(System.Drawing.Color.Transparent);
                    draw(g);
                }
            }
        }

        static void AddRound(System.Drawing.Drawing2D.GraphicsPath p, float x, float y, float w, float h, float r)
        {
            if (r < 1) r = 1;
            p.AddArc(x, y, r * 2, r * 2, 180, 90);
            p.AddArc(x + w - r * 2, y, r * 2, r * 2, 270, 90);
            p.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
            p.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
            p.CloseFigure();
        }
    }

    // ---------- emergency stop ----------
    // Ctrl+Esc pauses; Ctrl+Alt+R clears that pause; Ctrl+Alt+Q ends the cycle.
    // Other physical input uses automatic handoff and never writes STOP.
    static class Panic
    {
        public static readonly IntPtr OwnMagic = new IntPtr(0x44534831); // 'DSH1'
        static volatile bool _engaged;
        // Ctrl+Alt+Q is FINAL: after it the worker shows NO border and runs NO human monitor.
        // ONLY Ctrl+Alt+R brings the session back (human's model, 2026-09-12: "R 就是要恢复监测";
        // "按住 Q 之后你再也不该亮红灯"). Nothing else may clear this flag — see the note on
        // AgentActed(), where an earlier version quietly undid Q and lit the box again.
        static volatile bool _exited = false;

        // WHO ended it, WHEN, and on WHAT EVIDENCE (2026-09-13). The record used to be one sentence
        // — "human hit Ctrl+Alt+Q" — written by two different detectors and readable nowhere else,
        // so a latch nobody could attribute was handed back to the human as an accusation ("you
        // pressed Ctrl+Alt+Q") two minutes later, in a DIFFERENT session, while the indicator was
        // still breathing cyan. A claim about the human's keyboard has to name its witness.
        static volatile string _exitSource = "";      // hook | poll | agent | adopted
        static volatile string _exitAt = "";
        static volatile string _exitEvidence = "";

        // ---- WHOSE Ctrl AND Alt? (2026-09-13, the "我什么都没有动" report) ---------------------
        // GetAsyncKeyState reports the ASYNC state: it cannot tell the human's Ctrl from one THIS
        // worker injected (RefocusWindow taps Alt on purpose, ReleaseStuck releases modifiers), and
        // it is also what makes AltGr read as Ctrl+Alt on layouts that define it. Judging a chord on
        // that state alone is how "the human hit Ctrl+Alt+Q" could be produced by a chord the human
        // never touched. The low-level hook is the ONE witness that sees dwExtraInfo and can say
        // whose key it was — so the chord is judged on ITS record, and the async state must agree.
        static volatile bool _humanCtrl = false, _humanAlt = false;
        static readonly HashSet<uint> HumanModifiers = new HashSet<uint>();
        public static bool HumanCtrlDown { get { return _humanCtrl; } }
        public static bool HumanAltDown { get { return _humanAlt; } }

        /// THE ONE classification of a keyboard event, and the ONLY place the human-modifier track is
        /// updated (D, 2026-09-13). `dwExtraInfo == OwnMagic` identifies OUR OWN input; the OS's
        /// LLKHF_INJECTED flag identifies every OTHER program's injection. Only a key that is neither
        /// counts as "a hand on this keyboard" — and that answer is what the brake, the chord
        /// detectors and the evidence line all read, so it must exist exactly once. The hook calls
        /// this, and the `keyClass` diagnostic op calls the SAME function, so a test measures the
        /// production transition instead of re-implementing it.
        public static bool ClassifyAndTrackKey(uint vkCode, bool down, bool up, IntPtr extraInfo, uint flags)
        {
            bool ours = extraInfo == OwnMagic;
            bool injected = (flags & Native.LLKHF_INJECTED) != 0;
            bool human = !ours && !injected;
            if (human && (down || up))
            {
                lock (HumanModifiers)
                {
                    if (IsCtrlVk(vkCode) || IsAltVk(vkCode))
                    { if (down) HumanModifiers.Add(vkCode); if (up) HumanModifiers.Remove(vkCode); }
                    _humanCtrl = HumanModifiers.Any(IsCtrlVk);
                    _humanAlt = HumanModifiers.Any(IsAltVk);
                }
            }
            return human;
        }

        /// Zero the track (test seam only: a fixture must be able to start from a known state).
        public static void ResetHumanTrack()
        { lock (HumanModifiers) { HumanModifiers.Clear(); _humanCtrl = false; _humanAlt = false; } }
        static void ReconcileModifiers(bool ctrl, bool alt)
        {
            lock (HumanModifiers)
            {
                if (!ctrl) { HumanModifiers.RemoveWhere(IsCtrlVk); _humanCtrl = false; }
                if (!alt) { HumanModifiers.RemoveWhere(IsAltVk); _humanAlt = false; }
            }
        }

        /// Are ANOTHER program's injected keys the human's? NO — never, and this is not configurable.
        /// `flags & LLKHF_INJECTED` means some process called SendInput on its own behalf; the answer
        /// to "did a hand on this keyboard do it" is then "no", and a policy knob that could relax
        /// that would turn the one honest field we have back into a guess. (A remote-control session's
        /// keys are injected too: they are not counted as human input, and that consequence is stated
        /// in the delivery notes rather than papered over with a trust switch.)
        // Read-only views of the record, for `probe`: an exit is a fact about the machine, so it has
        // to be checkable without reading a file and without trusting anyone's prose.
        public static string ExitSource { get { return _exitSource; } }
        public static string ExitAt { get { return _exitAt; } }
        public static string ExitEvidence { get { return _exitEvidence; } }
        static bool IsCtrlVk(uint vk) { return vk == Native.VK_CONTROL || vk == 0xA2 || vk == 0xA3; }
        static bool IsAltVk(uint vk) { return vk == Native.VK_MENU || vk == 0xA4 || vk == 0xA5; }

        // Ctrl+Alt+Q must hold ACROSS worker restarts — this process gets replaced (every deploy
        // kills it) and a fresh worker has no memory of Q, which is why the box kept coming back.
        // So the latch is persisted exactly like the brake: an EXITED marker on disk. Every worker
        // adopts it, and the ONLY thing that clears it is the agent calling a computer-use op —
        // the human's own words (2026-09-12): "下次再亮起，必须是我又让你调用 computer use 之后".
        static string ExitMarkerPath()
        {
            // Overridable so a TEST can point the whole exit latch at a temp directory: the real
            // record in %LOCALAPPDATA% is live evidence for a real incident and no test may move it.
            // Same shape as ResolveStopPath()'s DSH_COMPUTER_USE_STOP_FILE.
            try
            {
                string env = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_EXIT_FILE");
                if (!string.IsNullOrEmpty(env)) return env;
            }
            catch { }
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-computer-use");
            return Path.Combine(dir, "EXITED");
        }

        /// The record on disk: the sentence, then the fields a human or an agent can CHECK.
        static string ExitRecordText(string why)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(why);
            sb.Append(Environment.NewLine).Append("source=").Append(_exitSource);
            sb.Append(Environment.NewLine).Append("at=").Append(_exitAt);
            if (!string.IsNullOrEmpty(_exitEvidence))
                sb.Append(Environment.NewLine).Append("evidence=").Append(_exitEvidence);
            sb.Append(Environment.NewLine)
              .Append("note=Ctrl+Alt+R re-arms (human only); a new computer-use cycle is opened by the plugin on the first computer_* call of a later turn");
            return sb.ToString();
        }

        static string MarkerLine(string prefix)
        {
            try
            {
                string[] lines = File.ReadAllLines(ExitMarkerPath());
                foreach (string l in lines)
                    if (l != null && l.StartsWith(prefix, StringComparison.Ordinal))
                        return l.Substring(prefix.Length).Trim();
            }
            catch { }
            return "";
        }

        /// Something a human can check without reading the code: what was measured, by which
        /// witness, when. This is the ONLY form in which an exit may be reported outwards —
        /// the plugin quotes it verbatim instead of telling the human what they did.
        public static string ExitSummary()
        {
            string s = string.IsNullOrEmpty(_why) ? "Ctrl+Alt+Q" : _why;
            if (!string.IsNullOrEmpty(_exitAt)) s += " at " + _exitAt;
            if (!string.IsNullOrEmpty(_exitSource)) s += " (source=" + _exitSource + ")";
            if (!string.IsNullOrEmpty(_exitEvidence)) s += " [" + _exitEvidence + "]";
            return s;
        }

        /// The ONE teardown of a dead cycle. A DETECTED exit and an ADOPTED one must be
        /// indistinguishable from outside: sharing this is what keeps "exited" from being a flag
        /// that leaves the cyan breathing border and the monitors running (the human's report).
        static void ApplyExitTeardown()
        {
            // THE ORDERED BOUNDARY (Codex review #1, 2026-09-13). Every consumer of "the cycle is
            // live" — lighting it in the dispatcher, arming its monitors, raising a brake — and the
            // exit that ends it share this ONE lock. A Ctrl+Alt+Q landing on the hook/poll thread can
            // therefore only happen entirely BEFORE such a transition (which then refuses: nothing is
            // lit) or entirely AFTER it (and then this teardown clears what it lit). The old code
            // computed `cycleOp = ... && !Panic.Exited` and then wrote CycleLit/Arm()/Thinking as
            // separate statements, so a Q between the check and the write re-lit a dead cycle.
            lock (SyncLock)
            {
                _temporary = null;
                _engaged = false;
                _stopped = false;
                CycleLit = false;             // R2: the cycle is dead and must not be revived by anyone
                Disarm();                     // ... and its monitors die WITH it, not at the next turn
                try { Glow.Kill(); } catch { }
                try { Glow.Ask(false); } catch { }
                try { Glow.Stopped(false); } catch { }
                // EXIT PRIORITY IS UNTOUCHED BY A FAILED RELEASE (2026-09-13): the EXITED record is
                // the authority and the light derivation returns 0 while it stands, so a STOP that
                // could not be deleted must not — and does not — bring the red back. The result is
                // deliberately ignored here; the audit line records it.
                if (!DeleteStopFile())
                    Program.AuditRecord("EXIT-STOP-RELEASE-FAILED",
                        "teardown could not delete the STOP file: " + LastStopError + " — the exit still stands");
            }
        }

        /// Light a live cycle — the ONLY way CycleLit/Arm/Thinking are turned on for a new cycle op.
        /// Returns false when the cycle is already dead. Atomic with Panic.Exit (same lock).
        public static bool TryLightCycle(int thinkMs)
        {
            lock (SyncLock)
            {
                if (_exited) return false;
                if (!CycleLit) Program.ResetKickoffFocus();
                CycleLit = true;      // an agent cycle is live: cyan is on (R1)
                Arm();                // "Computer use 一旦启用，立即挂打断监听"
                // A BRAKE OUTRANKS "THINKING" (cold-start bug, 2026-09-13): if a stop is already
                // standing — inherited at startup, or raised in another process — the cycle lights
                // but the light must show the ordinary PAUSE red, not cyan. Painting thinking here
                // is what made the first signed op hide a brake the human had already set.
                if (_engaged || _stopped)
                {
                    try { Glow.Kill(); } catch { }
                    try { Glow.Stopped(true); } catch { }
                    // START the overlay too: `Thinking()` was the only thing that ever did, so a
                    // cycle whose FIRST call arrives with a brake already standing painted nothing at
                    // all (measured: cycleLit/armed/stopped all true, want 0). Same call SyncFromFile
                    // uses when it shows the red.
                    try { Glow.Reveal(); } catch { }
                }
                else
                {
                    Glow.Thinking(thinkMs);
                }
                return true;
            }
        }

        /// Was the record written after this process started? Only then is it news rather than an
        /// inherited fact. (The record carries its own `at=` line precisely so this is answerable
        /// without guessing from file timestamps.)
        static bool RecordIsNewerThanProcess()
        {
            try
            {
                DateTime rec;
                if (!DateTime.TryParse(_exitAt, out rec)) return false;
                return rec >= Process.GetCurrentProcess().StartTime.AddSeconds(-1);
            }
            catch { return false; }
        }

        public static void SyncExitedFromFile()
        {
            // THE WHOLE ADOPTION IS ONE TRANSACTION (Codex review, 2026-09-13). Judging the record,
            // reading it and setting `_exited` used to sit OUTSIDE SyncLock, while AgentCalling
            // cleared the record and `_exited` INSIDE it — so the poll thread could judge a record
            // that a `resume` then deleted, and carry on to tear down a cycle that had just been
            // opened, leaving the flag and the machine disagreeing. Everything below happens under
            // the same lock AgentCalling and Exit use.
            //
            // SCOPE, stated honestly: this ordering is IN-PROCESS. Other worker processes share the
            // record FILE, not this lock, so the compare-and-delete in AgentCalling is atomic against
            // THIS process's writers only; against another process the record's own text is the
            // defence (a resume refuses a record that no longer matches what the opener saw). Nothing
            // here claims machine-wide atomicity, and no test may assert it.
            bool announce = false;
            bool adopted = false;
            lock (SyncLock)
            {
                if (_exited) return;
                try
                {
                    if (!File.Exists(ExitMarkerPath())) return;
                    _exited = true;
                    string first = "";
                    try
                    {
                        string[] lines = File.ReadAllLines(ExitMarkerPath());
                        if (lines != null && lines.Length > 0 && lines[0] != null) first = lines[0].Trim();
                    }
                    catch { }
                    _why = first.Length > 0 ? first : "Ctrl+Alt+Q";
                    string src = MarkerLine("source=");
                    _exitSource = src.Length > 0 ? (src + "/adopted") : "adopted";
                    _exitAt = MarkerLine("at=");
                    string ev = MarkerLine("evidence=");
                    _exitEvidence = ev.Length > 0 ? ev : "";
                    // 2026-09-13: adopting the record used to flip ONE flag and nothing else, so this
                    // process said "exited" while its own cyan border kept breathing and its monitors
                    // stayed armed. An adopted exit is an exit: same teardown, same silence.
                    ApplyExitTeardown();
                    // A DETECTED EXIT AND AN ADOPTED ONE MUST CLEAN UP THE SAME WAY (bug, 2026-09-13):
                    // Exit() releases held input, but this adoption path tore down without it, so a
                    // Shift this agent was holding stayed DOWN after another process's Ctrl+Alt+Q —
                    // and the KEYUP that would have released it is now refused by the injection gate.
                    // The release runs OUTSIDE the lock (below), once per adoption: `_exited` is already
                    // true, so Exit()/a second poll tick cannot run it again, and ReleaseStuck() itself
                    // only releases what the OS says is still down — no duplicate, no ghost lift.
                    adopted = true;
                    Program.AuditRecord("EXIT-ADOPTED", ExitSummary());
                    // Announce ONLY a record that appeared while THIS process was already alive. An
                    // inherited record is history — the plugin settles it at a later real call — and
                    // re-announcing it is how a 01:17:44 exit came back as a fresh "the human just
                    // pressed Ctrl+Alt+Q" notice in a session that started at 01:19.
                    announce = RecordIsNewerThanProcess();
                }
                catch { }
            }
            // OUTSIDE the lock: Notify writes to stdout, and a full pipe must never hold the lock the
            // exit and the cycle-opener share.
            if (adopted) ReleaseStuck();   // adopted exit == detected exit, cleanup included
            if (announce) Notify("exit", ExitSummary());
        }

        /// The plugin says a NEW CYCLE may begin (it sends this from the ONE place a real call opens
        /// one, lib/index.js ensureCycle): the ONLY place Ctrl+Alt+Q's latch is released.
        ///
        /// `expectExit` is the record text the CALLER saw when it decided to open a cycle ("" = it saw
        /// no record at all). Under the same lock that Exit() writes the record in, this re-reads it
        /// and REFUSES when it no longer matches: an exit that landed while the opener was spawning a
        /// worker or writing to stdin is NEWER than the caller's decision, and clearing it here is
        /// exactly how a Ctrl+Alt+Q gets undone. Returns false when that newer record stands.
        public static bool AgentCalling(string expectExit)
        {
            lock (SyncLock)
            {
                // Deliberately does NOT Arm(). Arming belongs to a LIVE CYCLE and happens in the
                // dispatcher when the plugin's first `__cycle` op of the turn arrives. Arming here
                // left the human monitors running through turns that never touched this machine.
                // UNCONDITIONALLY clears when it does proceed (2026-09-13): the old `if (!_exited)
                // return;` made it a NO-OP on exactly the process that needed it — the plugin writes
                // `resume` the instant the worker says `ready`, while a fresh worker adopts the record
                // only on its first poll tick, so the ONE call that exists to release the latch raced
                // the adoption and lost, leaving the record alive for hours with a live worker on it.
                if (expectExit != null)
                {
                    string found = ReadMarkerText();
                    if (found == null)
                    {
                        // NULL IS NOT "NO RECORD" (API bug, 2026-09-13): the file exists but could not
                        // be read. Reporting that as "" made a locked record look like an empty one —
                        // and an empty one is exactly what a caller who also failed to read it expects.
                        LastResumeError = "the exit record exists but could not be READ (held open by another process?) — refusing to clear it";
                        Program.AuditRecord("RESUME-REFUSED", LastResumeError);
                        return false;
                    }
                    if (found != expectExit)
                    {
                        LastResumeError = "the exit record changed while the cycle was opening; expected " +
                            expectExit.Length + " bytes, found " + found.Length + " — the newer record stands";
                        Program.AuditRecord("RESUME-REFUSED", LastResumeError);
                        return false;
                    }
                }
                // CLEAR IT FOR REAL, THEN BELIEVE IT (API bug, 2026-09-13). This used to flip
                // `_exited = false` FIRST and then delete inside a swallowing try/catch, returning
                // true unconditionally: with the record held open by another process (FileShare.Read
                // makes it readable but undeletable) `resume` answered cycleOpen:true while the record
                // was still on disk — the in-memory flag said "no exit" and the disk said "exit", and
                // a signed op then lit the cycle (measured: cycleLit/armed=true, exited=false, EXITED
                // still present). Success is now conditional on the record actually being gone.
                string path = ExitMarkerPath();
                if (File.Exists(path))
                {
                    try { File.Delete(path); }
                    catch (Exception ex)
                    {
                        LastResumeError = "the exit record could not be DELETED (" + ex.Message +
                            ") — the exit stands and nothing was cleared";
                        Program.AuditRecord("RESUME-REFUSED", LastResumeError);
                        return false;                     // _exited stays TRUE: flag and disk agree
                    }
                    if (File.Exists(path))
                    {
                        // Delete() returning without throwing is not proof: verify, do not assume.
                        LastResumeError = "the exit record is STILL PRESENT after a delete — the exit stands";
                        Program.AuditRecord("RESUME-REFUSED", LastResumeError);
                        return false;
                    }
                }
                _exited = false;                          // only now, and only because the disk agrees
                LastResumeError = "";
                return true;
            }
        }

        /// The record as it is on disk right now: its text, "" when there is GENUINELY NO FILE, and
        /// NULL when the file exists but could not be read. The distinction is the API bug this helper
        /// used to hide — a read failure must never be reported as "nothing to clear".
        public static string ReadMarkerText()
        {
            try
            {
                string p = ExitMarkerPath();
                if (!File.Exists(p)) return "";
                return File.ReadAllText(p);
            }
            catch { return null; }
        }

        /// Why the last resume was refused ("" when it succeeded) — carried into the op's error text.
        public static volatile string LastResumeError = "";
        static volatile string _why = "";
        static IntPtr _hook = IntPtr.Zero;
        static Native.LowLevelKeyboardProc _proc;      // keep alive: the GC must not collect it
        static IntPtr _mouseHook = IntPtr.Zero;
        static Native.LowLevelMouseProc _mouseProc;    // same: the GC must not collect it
        static Thread _thread;

        public static bool Engaged { get { return _engaged; } }
        public static string Why { get { return _why; } }

        // ---- the brake is a fact about the MACHINE, not about one process --------------------
        //
        // 2026-09-13 incident: the human hit ESC while a ONE-SHOT `worker.exe --op click`
        // process — spawned by a shell script — was driving the mouse. The resident worker did
        // engage its own brake, but every fresh process starts with _engaged = false and simply
        // kept clicking, so from the human's chair the emergency stop did nothing at all:
        // "急停之后还在控制". The engaged state (and its reason) is therefore PERSISTED, and every
        // process — resident or one-shot, already running or started later — refuses to actuate
        // until a human re-arms it.
        static readonly object SyncLock = new object();
        static long _stopStamp = -1;

        static readonly string StopPath = ResolveStopPath();

        static string ResolveStopPath()
        {
            try
            {
                string env = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_STOP_FILE");
                if (!string.IsNullOrEmpty(env)) return env;
            }
            catch { }
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-computer-use", "STOP");
        }

        public static string StopFilePath { get { return StopPath; } }

        static void WriteStopFile(string why)
        {
            lock (SyncLock)
            {
                try
                {
                    string dir = Path.GetDirectoryName(StopPath);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    File.WriteAllText(StopPath, why ?? "emergency stop", new UTF8Encoding(false));
                    _stopStamp = File.GetLastWriteTimeUtc(StopPath).Ticks;
                }
                catch { /* an unwritable brake file must not stop the brake from working */ }
            }
        }

        /// Release the brake by deleting the STOP file — and REPORT WHETHER IT REALLY WENT.
        ///
        /// Returns true only when the file is verified ABSENT afterwards. This method no longer
        /// touches `_engaged`/`_stopped`/`_why`: a failed delete must leave the brake standing, and
        /// the caller is the only one that knows what its own state change means. The old body
        /// swallowed the exception and set `_stopStamp = -1` unconditionally (bug, 2026-09-13, real
        /// FileShare.Read lock): Clear() and EndAsk then reported a release that had not happened
        /// — "the machine is YOURS AGAIN" with the STOP still on disk — and the next poll re-adopted
        /// it, so the receipt was wrong and the light drifted back to red.
        static bool DeleteStopFile()
        {
            lock (SyncLock)
            {
                try
                {
                    if (!File.Exists(StopPath)) { _stopStamp = -1; LastStopError = ""; return true; }
                    try { File.Delete(StopPath); }
                    catch (Exception ex) { LastStopError = ex.Message; return false; }
                    if (File.Exists(StopPath)) { LastStopError = "the STOP file is still present after a delete"; return false; }
                    _stopStamp = -1;
                    LastStopError = "";
                    return true;
                }
                catch (Exception ex) { LastStopError = ex.Message; return false; }
            }
        }

        /// Why the last STOP release failed ("" when it succeeded) — carried into audit lines.
        public static volatile string LastStopError = "";

        // ---- IDENTIFYING AN ASK'S STOP RECORD, SO AN ORPHAN IS DETECTABLE ---------------------
        //
        // merge-design.md §4. An ask writes `question\nsource=agent-ask\naskPid=<pid>`: the question
        // stays the FIRST line (that is what a human reads if they open the file), and the two
        // markers are what let the NEXT process tell "a live asker is waiting for this answer" from
        // "the asker is gone and nobody can ever wait for it". Without this the leaked brake of the
        // measured incident (`ENGAGE-ASK -> ENGAGE-ADOPTED`, no RELEASE, every op refused until a
        // human pressed Ctrl+Alt+R) was indistinguishable from a brake somebody still owned.

        /// The value of a `key=value` marker line, or null when the marker is absent.
        /// Matched anywhere in the text (not only at the start of a line) so a caller that has
        /// already trimmed/indented the text still gets the marker rather than a silent miss.
        static string StopMarker(string text, string prefix)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(prefix)) return null;
            string[] lines = text.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.StartsWith(prefix, StringComparison.Ordinal)) return line.Substring(prefix.Length).Trim();
            }
            return null;
        }

        /// The first line of the STOP record: the human-readable reason (the raw question, for an ask).
        static string FirstLine(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            int nl = text.IndexOf('\n');
            return (nl < 0 ? text : text.Substring(0, nl)).Trim();
        }

        /// Is that pid a process that is still running? The whole orphan test rests on this one
        /// question, so it answers with a measurement and never guesses: a process that cannot be
        /// found is not running, and any failure to ask is answered "running" — the SAFE direction,
        /// because a false "running" only means an orphan is adopted (today's failure mode, curable
        /// with Ctrl+Alt+R), while a false "not running" would delete a live asker's brake.
        static bool PidIsRunning(int pid)
        {
            if (pid <= 0 || pid == Process.GetCurrentProcess().Id) return true;
            Process p = null;
            try
            {
                p = Process.GetProcessById(pid);
                return !p.HasExited;
            }
            catch { return false; }
            finally { if (p != null) { try { p.Dispose(); } catch { } } }
        }

        /// Sweep a STOP record left by an ask whose asker is GONE. Returns true only when the file
        /// was VERIFIED deleted, i.e. only when the caller must not adopt it.
        ///
        /// Never touches a human brake (no `source=agent-ask`), never touches a live asker's brake
        /// (its pid answers), and never touches our own (we are the asker: adopt it).
        static bool TrySweepOrphanAskStop(string text)
        {
            if (StopMarker(text, "source=") != "agent-ask") return false;   // human/agent brakes are never swept
            int pid;
            if (!int.TryParse(StopMarker(text, "askPid="), out pid) || pid <= 0) return false;
            if (pid == Process.GetCurrentProcess().Id) return false;        // our own live ask: adopt it
            if (PidIsRunning(pid)) return false;                            // another LIVE asker: adopt it
            if (!DeleteStopFile()) return false;                            // verified delete, or keep the brake
            Program.AuditRecord("ASK-ORPHAN-SWEPT",
                "an ask brake written by pid " + pid + " was swept: that process is gone and nobody can " +
                "wait for its answer; question=" + FirstLine(text));
            return true;
        }

        /// Adopt a stop written by ANY process — and honour a re-arm performed elsewhere.
        /// Called at startup and before every operation; costs one stat when nothing changed.
        public static void SyncFromFile()
        {
            lock (SyncLock)
            {
                try
                {
                    bool exists = File.Exists(StopPath);
                    long stamp = exists ? File.GetLastWriteTimeUtc(StopPath).Ticks : 0;
                    if (stamp == _stopStamp) return;                 // nothing changed since last look
                    _temporary = null;                              // inherited/replaced stop has no recovery claim
                    _stopStamp = stamp;
                    if (exists)
                    {
                        string why = "";
                        try { why = File.ReadAllText(StopPath); } catch { }
                        why = (why ?? "").Trim();
                        // THE ORPHAN SWEEP RUNS ON THE UNTRUNCATED TEXT (merge-design.md §4, item 2).
                        // The 240-char cut below would amputate the `askPid=` line of a long
                        // question — and a record that no longer names its asker is adopted instead
                        // of swept, which is precisely the leak this exists to remove.
                        if (TrySweepOrphanAskStop(why)) return;   // do NOT adopt a dead asker's brake
                        // DO NOT TAKE OWNERSHIP OF AN ADOPTED ASK BRAKE. Two independent audits, and a
                        // first attempt at exactly this, are why (2026-09-15):
                        //
                        //   * MINTING AN ID CANNOT WORK. The plugin's `endAsk` carries the id the DEAD
                        //     process issued, but `_askSeq` is reset NOWHERE, so a fresh process mints 1
                        //     for its first ask, 2 for its second, ... The adopter's minted id therefore
                        //     coincides with the dead asker's ONLY when that asker's ask was its first.
                        //     From the session's second ask onward the release is refused again and the
                        //     freeze returns — with a green guard, because the guard hardcoded askId 1.
                        //   * TAKING OWNERSHIP CAN DELETE A LIVE ASKER'S BRAKE. Adoption is gated on the
                        //     RECORD's text, not on the asker being dead: `PidIsRunning` only makes the
                        //     SWEEP decline. A live asker's brake would then answer to an id that is also
                        //     the adopter's own first-ask id, so an unrelated `endAsk` could release a
                        //     brake whose question is still on a card.
                        //
                        // So an ask brake whose asker is alive-but-not-waiting is cleared the way every
                        // other stuck brake is: the human's Ctrl+Alt+R, or a later process's orphan
                        // sweep once that pid is really gone. A frozen machine the human can free is
                        // strictly better than a guard that deletes a brake it has no right to touch.
                        // (See blocker1-adopted-brake.md — the first fix and its retraction.)
                        if (why.Length > 240) why = why.Substring(0, 240);
                        if (!_engaged)
                        {
                            _why = why.Length > 0 ? why : "emergency stop engaged in another process";
                            _engaged = true;
                            _stopped = true;         // THE FACT: always adopted, whoever wrote it
                            // THE BRAKE IS A STATE CHANGE: the audit log must carry it. `Exit` got this
                            // record on 2026-09-13 for exactly the reason below, and `Engage` never did —
                            // so a stop was reconstructable only from a STOP file that the human's own
                            // Ctrl+Alt+R DELETES, i.e. a phantom stop and a real one left the same trace:
                            // none. `source`/`evidence` are copied from Exit's shape so the one record a
                            // human re-reads after an incident states the witness, not a verdict.
                            Program.AuditRecord("ENGAGE-ADOPTED",
                                "stop adopted from the STOP file written by another process; why=" + _why +
                                "; cycleLit=" + (CycleLit ? 1 : 0) + "; exited=" + (_exited ? 1 : 0));
                            // THE SIGNAL: only for a live cycle that has not been exited. This path
                            // used to check NEITHER, so a stale STOP file — a crashed one-shot
                            // worker, a leftover script, our own deploy probe — re-lit the red
                            // border on a session the human had already ended. That was the one
                            // true "红框复生", and R2 exists precisely to forbid it.
                            // R2, UNCHANGED IN SCOPE (2026-09-13): the red is for a stop that lands on a
                            // LIVE cycle. Showing it whenever a STOP file exists would paint a red border
                            // for a bare worker start — a health probe, a deploy check, no computer use
                            // at all — which is the old "red with nothing running" lie, and the cycle is
                            // supposed to open on the FIRST REAL USE. A cold start that inherited a STOP
                            // is therefore silent here on purpose: the first signed call lights the cycle,
                            // and TryLightCycle paints the ordinary PAUSE red because the brake stands.
                            bool showRed = !_exited && CycleLit;
                            if (showRed)
                            {
                                try { Glow.Kill(); } catch { }
                                try { Glow.Stopped(true); } catch { }
                                try { Glow.Reveal(); } catch { }
                            }
                            ReleaseStuck();
                            // ... and the announcement is tied to the same fact: an inherited stop, or a
                            // stop adopted outside a cycle, is never dressed up as a key press that just
                            // happened.
                            if (showRed) Notify("panic", _why);
                        }
                    }
                    else if (_engaged)
                    {
                        Clear();                                     // a human re-armed elsewhere
                    }
                }
                catch { }
            }
        }

        public static void Init()
        {
            SyncFromFile();     // a previous process may already have hit the brake
            if (_thread != null) return;
            lock (typeof(Panic))
            {
                if (_thread != null) return;
                _thread = new Thread(HookThread);
                _thread.IsBackground = true;
                _thread.Name = "dsh-panic-hook";
                _thread.Start();
                // ...plus an independent watcher, so a missed keydown can never leave the machine
                // stopped with no discoverable way back.
                Thread poll = new Thread(PollThread);
                poll.IsBackground = true;
                poll.Name = "dsh-panic-poll";
                poll.Start();
            }
        }

        static void HookThread()
        {
            try
            {
                _proc = HookCallback;
                IntPtr hmod = Native.GetModuleHandle(null);
                _hook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _proc, hmod, 0);
                // Same thread, same message loop: a second low-level hook for the wheel.
                _mouseProc = MouseHookCallback;
                _mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _mouseProc, hmod, 0);
                Native.NativeMsg msg;
                while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    Native.TranslateMessage(ref msg);
                    Native.DispatchMessage(ref msg);
                }
            }
            catch { /* the brake must never take the worker down */ }
        }

        // Hook callbacks only record ownership and enqueue control work. Serial execution
        // preserves Ctrl+Esc / resume / exit ordering without blocking the OS hook on I/O.
        static int _pendingPauses;
        public static bool PauseRequested { get { return Volatile.Read(ref _pendingPauses) > 0; } }
        static readonly ConcurrentQueue<Action> ControlQueue = new ConcurrentQueue<Action>();
        static int _controlWorkQueued;
        internal static void QueueControl(Action action)
        {
            ControlQueue.Enqueue(action);
            if (Interlocked.CompareExchange(ref _controlWorkQueued, 1, 0) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate {
                do {
                    Action next;
                    while (ControlQueue.TryDequeue(out next)) { try { next(); } catch { } }
                    Interlocked.Exchange(ref _controlWorkQueued, 0);
                } while (!ControlQueue.IsEmpty && Interlocked.CompareExchange(ref _controlWorkQueued, 1, 0) == 0);
            });
        }
        public static string ControlHotkey(uint vk, bool down, bool human, bool ctrl, bool alt, bool shift, bool win, bool live)
        {
            if (!down || !human) return "";
            if (vk == Native.VK_ESCAPE && ctrl && !alt && !shift && !win && live) return "pause";
            if (ctrl && alt && vk == Native.VK_Q) return "exit";
            if (ctrl && alt && vk == Native.VK_R) return "resume";
            return "";
        }
        static bool _suppressPauseEsc;
        static bool _havePhysicalPoint;
        static POINT _physicalPoint;
        public static bool PhysicalEvent(IntPtr extra, uint flags, uint injectedMask)
        { return extra != OwnMagic && (flags & injectedMask) == 0; }

        static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0)
                {
                    var m = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
                    if (m.dwExtraInfo != OwnMagic) Interlocked.Increment(ref _externalInput);
                    if (PhysicalEvent(m.dwExtraInfo, m.flags, 3))
                    {
                        int message = wParam.ToInt32(), key = 0;
                        bool down = false, up = false, activity = true;
                        switch (message)
                        {
                            case 0x200:
                                activity = !_havePhysicalPoint || m.pt.X != _physicalPoint.X || m.pt.Y != _physicalPoint.Y;
                                _physicalPoint = m.pt; _havePhysicalPoint = true; break;
                            case 0x201: key = 1; down = true; break;
                            case 0x202: key = 1; up = true; break;
                            case 0x204: key = 2; down = true; break;
                            case 0x205: key = 2; up = true; break;
                            case 0x207: key = 4; down = true; break;
                            case 0x208: key = 4; up = true; break;
                            case 0x20B: key = ((m.mouseData >> 16) & 0xFFFF) == 1 ? 5 : 6; down = true; break;
                            case 0x20C: key = ((m.mouseData >> 16) & 0xFFFF) == 1 ? 5 : 6; up = true; break;
                            case 0x20A: case 0x20E: activity = unchecked((short)(m.mouseData >> 16)) != 0; break;
                            default: activity = false; break;
                        }
                        if (activity) RecordHumanInput(key, down, up);
                    }
                }
            }
            catch { }
            return Native.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
        }

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0)
                {
                    int m = wParam.ToInt32();
                    var k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                    if (k.dwExtraInfo != OwnMagic) Interlocked.Increment(ref _externalInput);
                    bool down = m == Native.WM_KEYDOWN_ || m == Native.WM_SYSKEYDOWN_;
                    bool up = m == Native.WM_KEYUP_ || m == Native.WM_SYSKEYUP_;
                    bool human = ClassifyAndTrackKey(k.vkCode, down, up, k.dwExtraInfo, k.flags);
                    if (human && (down || up))
                    {
                        RecordHumanInput((int)k.vkCode, down, up);
                        if (k.vkCode == Native.VK_ESCAPE && _suppressPauseEsc)
                        { if (up) _suppressPauseEsc = false; return new IntPtr(1); }
                        bool ctrl = _humanCtrl && (Native.GetAsyncKeyState(Native.VK_CONTROL) & 0x8000) != 0;
                        bool alt = _humanAlt && (Native.GetAsyncKeyState(Native.VK_MENU) & 0x8000) != 0;
                        string hotkey = ControlHotkey(k.vkCode, down, human, ctrl, alt,
                            Handoff.Held(0x10), Handoff.Held(0x5B) || Handoff.Held(0x5C), CycleLit && !_exited);
                        if (hotkey == "pause")
                        {
                            _suppressPauseEsc = true;
                            Interlocked.Increment(ref _pendingPauses);
                            // The hook marks ownership immediately; do not perform SendInput or
                            // filesystem work on this OS hook thread.
                            string evidence = ChordEvidence(k, ctrl, alt);
                            QueueControl(delegate {
                                try { Engage("Ctrl+Esc chord detected", false, "hook", evidence); }
                                finally { Interlocked.Decrement(ref _pendingPauses); }
                            });
                            return new IntPtr(1); // Ctrl+Esc must not also open the Windows Start menu.
                        }
                        if (hotkey == "exit")
                        {
                            string evidence = ChordEvidence(k, ctrl, alt);
                            QueueControl(delegate { Exit("Ctrl+Alt+Q chord detected", "hook", evidence); });
                        }
                        else if (hotkey == "resume")
                            QueueControl(delegate { Clear(); });
                    }
                }
            }
            catch { }
            return Native.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        public static void Exit(string why) { Exit(why, "unknown", ""); }

        /// `why` is a MEASUREMENT sentence, not a verdict about the human: the detectors say what
        /// they saw ("Ctrl+Alt+Q chord"), never who meant it. `source` names the witness and
        /// `evidence` carries the raw fields, so the next incident is a log line, not a debate.
        public static void Exit(string why, string source, string evidence)
        {
            // IDEMPOTENT and ATOMIC: the low-level hook AND the 40 ms polling fallback both see
            // Ctrl+Alt+Q, so without the guard every press emitted the exit TWICE — and the human's
            // chat filled with paired "computer-use exited" cards (their screenshot of the storm was
            // the proof). The guard, the flag and the RECORD WRITE now happen inside the same lock as
            // AgentCalling(), which is what makes "the cycle opener cannot clear a record that is
            // newer than the one it saw" a real ordering instead of a hope: a `resume` carrying the
            // old record's text either runs entirely before this write (and then the write stands) or
            // entirely after it (and then it finds text that does not match and refuses).
            lock (SyncLock)
            {
                if (_exited) return;
                _exited = true;              // final: no border and no monitors until the agent drives
                _exitSource = source == null ? "unknown" : source;
                _exitAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                _exitEvidence = evidence == null ? "" : evidence;
                _why = why;
                try { File.WriteAllText(ExitMarkerPath(), ExitRecordText(why), new UTF8Encoding(false)); } catch { }
            }
            // EVERY visual flag, not just the stop one. _askMode is what the render loop reads
            // FIRST, so leaving it set painted the fast-breathing red border back on the frame after
            // Kill() hid it — a red box that could never be turned off, which is the
            // "Ctrl+Alt+Q 之后不该再亮起" rule broken by omission. (The render loop now DERIVES the
            // light from _exited as well, so this is belt and braces rather than the only guard.)
            ApplyExitTeardown();
            // CLEANUP ON EXIT (mid-action stop bug, 2026-09-13): the teardown never released held
            // input, so a Ctrl+Alt+Q landing in the middle of a drag left the left button DOWN for
            // whatever the human did next. Outside the lock, and deliberately not through
            // SendInputChecked (which now refuses after an exit): releasing what is stuck is exactly
            // the cleanup that must still be allowed.
            ReleaseStuck();
            Program.AuditRecord("EXIT", _exitSource + "\t" + why + "\t" + _exitEvidence);
            Notify("exit", ExitSummary());
        }

        /// The chord as it was SEEN: the fields someone can re-check, including whose Ctrl/Alt the
        /// hook recorded and which window was in front. Deliberately verbose — this line is the
        /// difference between "the human pressed it" and "we cannot know who pressed it".
        static string ChordEvidence(Native.KBDLLHOOKSTRUCT k, bool ctrl, bool alt)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("vk=0x").Append(k.vkCode.ToString("X2"));
            sb.Append(" extra=0x").Append(unchecked((ulong)k.dwExtraInfo.ToInt64()).ToString("X"));
            sb.Append(" trackedCtrl=").Append(_humanCtrl ? "1" : "0");
            sb.Append(" trackedAlt=").Append(_humanAlt ? "1" : "0");
            sb.Append(" asyncCtrl=").Append(ctrl ? "1" : "0");
            sb.Append(" asyncAlt=").Append(alt ? "1" : "0");
            // WHOSE KEY WAS IT (D): 1 = the OS marked it LLKHF_INJECTED, i.e. some program sent it
            // rather than a hand on this keyboard. Recorded on every chord so nobody has to guess
            // later whether "the human pressed it" was ever measurable — and note that OURSELVES
            // (extra=OUR_MAGIC) is a different, stronger answer than "some injector".
            sb.Append(" injected=").Append((k.flags & Native.LLKHF_INJECTED) != 0 ? "1" : "0");
            try
            {
                IntPtr fg = Native.GetForegroundWindow();
                uint fgPid;
                Native.GetWindowThreadProcessId(fg, out fgPid);
                sb.Append(" fgPid=").Append(fgPid);
                try { sb.Append(" fg=").Append(Process.GetProcessById((int)fgPid).ProcessName); } catch { }
                StringBuilder t = new StringBuilder(256);
                if (Native.GetWindowText(fg, t, 256) > 0)
                {
                    string title = t.ToString();
                    if (title.Length > 60) title = title.Substring(0, 60);
                    sb.Append(" fgTitle=\"").Append(title.Replace("\t", " ")).Append('"');
                }
            }
            catch { }
            return sb.ToString();
        }

        /// Polling fallback for the human's combos.
        ///
        /// The low-level hook is the primary path, but it only reports what Windows hands it: a
        /// missed keydown would leave the machine stopped with no discoverable way back. This thread
        /// independently watches the key STATE — the "pressed since the last call" bit cannot be
        /// missed when polled every 40 ms — so Q always exits and R always releases, hook or no hook.
        static void PollThread()
        {
            bool prevQ = false, prevR = false;
            int warm = 0;
            while (true)
            {
                Thread.Sleep(40);
                try
                {
                    // This fallback exists for a MISSED keydown, and that is all it may ever do.
                    // It cannot see dwExtraInfo or LLKHF_INJECTED, so it must not be allowed to decide
                    // WHOSE chord this is: the modifier half comes from the hook's own track (real
                    // keydowns only, D), the agent must have been quiet for a moment (our own injected
                    // Q must never read as the human's), and the OS "pressed since last query" bits are
                    // drained on start-up, because those bits survive from BEFORE this thread existed
                    // and a fresh process used to inherit a stale Q as a live chord.
                    //
                    // THE ASYNC STATE IS MEASURED HERE, NOT ASSUMED (D, 2026-09-13). The evidence line
                    // used to be built with ChordEvidence(kk, true, true): it *claimed* "asyncCtrl=1
                    // asyncAlt=1" without ever asking, which made the one record a human re-reads
                    // after a false exit state a confirmation that had never happened. And a stale
                    // hook track (a key-up the hook never saw) could then fire a chord nobody pressed:
                    // the async state is the arbiter of "is the key still down", so it is both checked
                    // and reported.
                    bool asyncCtrl = (Native.GetAsyncKeyState(Native.VK_CONTROL) & 0x8000) != 0;
                    bool asyncAlt = (Native.GetAsyncKeyState(Native.VK_MENU) & 0x8000) != 0;
                    ReconcileModifiers(asyncCtrl, asyncAlt);
                    bool q = (Native.GetAsyncKeyState(Native.VK_Q) & 1) != 0;
                    bool r = (Native.GetAsyncKeyState(Native.VK_R) & 1) != 0;
                    bool agentQuiet = _agentActAt == 0 || unchecked(Environment.TickCount - _agentActAt) > 400;
                    if (warm < 3) warm++;
                    else if (_humanCtrl && _humanAlt && asyncCtrl && asyncAlt && agentQuiet)
                    {
                        // R FIRST: Ctrl+Alt+R is the human's explicit re-arm, and a stale Q bit must
                        // never beat it — pressing the key that brings computer use BACK used to be
                        // able to END it instead.
                        if (r && !prevR) QueueControl(delegate { Clear(); });
                        else if (q && !prevQ)
                        {
                            Native.KBDLLHOOKSTRUCT kk = new Native.KBDLLHOOKSTRUCT();
                            kk.vkCode = Native.VK_Q;
                            string evidence =
                                 "q-latch + hook-tracked modifiers + measured async key state " +
                                 "(no keydown was seen by the hook); " +
                                 ChordEvidence(kk, asyncCtrl, asyncAlt);
                            QueueControl(delegate { Exit("Ctrl+Alt+Q chord detected", "poll", evidence); });
                        }
                    }
                    prevQ = q; prevR = r;
                    MonitorHuman();
                }
                catch { /* the brake must never take the worker down */ }
            }
        }

        // ---------- human-presence monitor: a hand on the mouse ----------
        //
        // Physical activity yields visibly. Automatic handoff is independent of the
        // durable manual brake and never creates a STOP record.
        static int _agentActAt;
        static volatile bool _armed = false;
        public static volatile bool CycleLit;
        public static bool Armed { get { return _armed; } }
        public static bool Exited { get { return _exited; } }
        static readonly Stopwatch HumanClock = Stopwatch.StartNew();
        static readonly HumanInputState Handoff = new HumanInputState();
        static readonly object HandoffPublishLock = new object();
        static string _publishedHandoff = "idle";
        static int _handoffWorkQueued;
        public static bool HumanActive { get { return Handoff.Active; } }
        public static long HumanRevision { get { return Handoff.Revision; } }
        public static bool HumanHolds(int vk) { return Handoff.Held(vk); }
        public static object CooperationState() { return Handoff.Snapshot(HumanClock.ElapsedMilliseconds, _approvalHold); }
        static void ResetMonitorRun() { /* Manual recovery must not erase physical input history. */ }
        // ---------------------------------------------------------------------------------------
        // APPROVAL HOLD (2026-10-16). The human must click "approve once" on the DSH card to let a
        // `standard`-mode actuation through — and that click IS physical input. Measured on the real
        // machine: `computer_move` returned HUMAN_REOBSERVE / outcome=not-dispatched because the mouse
        // movement that reached the approval button was classified as "the human is taking over".
        //
        // The approval card is Harness chrome, not the application being driven, so input that arrives
        // while an approval is pending is NOT evidence of a takeover. `Arm`/`RecordHumanInput`/
        // `MonitorHuman` therefore all consult HandoffShouldArm(): while an approval is pending the
        // handoff monitor stays idle, so no `handoff` event is published and no ordering changes.
        //
        // WHAT IS DELIBERATELY NOT DISABLED: the low-level hooks still run, physical input is still
        // recorded, Ctrl+Esc / Ctrl+Alt+Q / Ctrl+Alt+R still work, and `CheckHumanInput` still refuses
        // on a brake or a cancellation. The takeover path is only deferred — `ReleaseApprovalHold`
        // re-baselines the handoff and clears the hold, so the very next real input yields again.
        // A takeover that happened during the approval window is caught later by target re-validation,
        // which refuses to act when the environment no longer matches what was approved.
        // ---------------------------------------------------------------------------------------
        static volatile bool _approvalHold;
        public static bool HeldForApproval { get { return _approvalHold; } }
        static bool HandoffShouldArm()
        {
            return _armed && CycleLit && !_exited && !_approvalHold;
        }

        /// <summary>Suspend takeover classification while an approval card is pending. Idempotent.</summary>
        public static void BeginApprovalHold(string actionId)
        {
            _approvalHold = true;
            Handoff.Enable(false, HumanClock.ElapsedMilliseconds);
            PublishHandoff();
            // AUDIT (2026-10-16). `PublishHandoff` returns EARLY when the phase did not change, and the
            // phase is "idle" both before and during a hold — so arming a hold left NO trace at all in
            // worker-audit.log. That made "the grace actually suppressed the takeover" and "the grace
            // never armed" produce byte-identical logs, i.e. the fix could not be verified. This line
            // and its counterpart in ReleaseApprovalHold are the ONLY additions for that purpose: they
            // change no behaviour, they only make the state transition observable.
            Program.AuditRecord("APPROVAL-HOLD",
                "on/action=" + (string.IsNullOrEmpty(actionId) ? "<none>" : actionId) +
                "; phase=" + Handoff.Phase + "; revision=" + HumanRevision +
                "; cycleLit=" + (CycleLit ? "1" : "0") + "; ceased=" + (_exited ? "1" : "0"));
        }

        /// <summary>
        /// Clear the hold and re-baseline the handoff so input that happened while the card was up
        /// (moving to and clicking the button) does not immediately re-enter `yielding`.
        /// </summary>
        public static void ReleaseApprovalHold(string actionId)
        {
            _approvalHold = false;
            Handoff.Rebaseline(HumanClock.ElapsedMilliseconds);
            Handoff.Enable(HandoffShouldArm(), HumanClock.ElapsedMilliseconds);
            PublishHandoff();
            // See BeginApprovalHold. The phase recorded here is the RE-BASELINED one, so a reader can
            // tell whether the hold actually contained the approval gesture (phase=idle) or whether a
            // real burst was already in flight when the card settled (phase=yielding/waiting).
            Program.AuditRecord("APPROVAL-HOLD",
                "off/action=" + (string.IsNullOrEmpty(actionId) ? "<none>" : actionId) +
                "; phase=" + Handoff.Phase + "; revision=" + HumanRevision +
                "; cycleLit=" + (CycleLit ? "1" : "0") + "; ceased=" + (_exited ? "1" : "0"));
        }
        public static void Arm() { _armed = true; Handoff.Enable(HandoffShouldArm(), HumanClock.ElapsedMilliseconds); }
        public static void Disarm() { _armed = false; Handoff.Enable(false, HumanClock.ElapsedMilliseconds); PublishHandoff(); }
        public static void AgentActed() { _agentActAt = Environment.TickCount; }
        static bool IsBareModifier(uint vk)
        {
            return vk == Native.VK_SHIFT || vk == Native.VK_CONTROL || vk == Native.VK_MENU ||
                   vk == 0xA0 || vk == 0xA1 || vk == 0xA2 || vk == 0xA3 ||
                   vk == 0xA4 || vk == 0xA5 || vk == 0x5B || vk == 0x5C;
        }
        public static void RecordHumanInput(int key, bool down, bool up)
        {
            long now = HumanClock.ElapsedMilliseconds;
            bool was = Handoff.Active;
            Handoff.Enable(HandoffShouldArm(), now);
            Handoff.Record(key, down, up, now);
            if (!was && Handoff.Active && Interlocked.CompareExchange(ref _handoffWorkQueued, 1, 0) == 0)
                ThreadPool.QueueUserWorkItem(delegate {
                    try { Program.ReleaseOwnedInputs(); PublishHandoff(); }
                    finally { Interlocked.Exchange(ref _handoffWorkQueued, 0); }
                });
        }
        static void PublishHandoff()
        {
            lock (HandoffPublishLock)
            {
                string phase = Handoff.Phase;
                if (phase == _publishedHandoff) return;
                _publishedHandoff = phase;
                if (phase != "idle") Glow.HumanYield();
                Program.AuditRecord("HUMAN-HANDOFF", "phase=" + phase + "; revision=" + HumanRevision + "; kind=" + Handoff.LastKind);
                Notify("handoff", phase);
            }
        }
        static void MonitorHuman()
        {
            SyncExitedFromFile();
            long now = HumanClock.ElapsedMilliseconds;
            Handoff.Enable(HandoffShouldArm(), now);
            Handoff.Tick(now);
            if (Handoff.Active) Program.ReleaseOwnedInputs();
            PublishHandoff();
        }

        static RecoveryPermit _temporary;
        static long _externalInput;
        public static string TemporaryPauseId { get { lock (SyncLock) { return _temporary == null ? "" : _temporary.Id; } } }
        public static void ObserveTemporary(string id)
        {
            lock (SyncLock) { if (_temporary != null && _temporary.Id == id) _temporary.Observed = true; }
        }
        public static object RecoverTemporary(string id)
        {
            SyncExitedFromFile(); SyncFromFile();
            lock (SyncLock)
            {
                if (_temporary == null) return Program.Dict("recovered", false, "reason", "only an explicit agent temporary pause can be recovered");
                IntPtr target = new IntPtr(_temporary.Target);
                IntPtr foreground = Native.GetForegroundWindow();
                uint pid; Native.GetWindowThreadProcessId(foreground, out pid);
                string problem = _temporary.Problem(id, CycleLit, _exited, _stopped,
                    Interlocked.Read(ref _externalInput), Native.LastInputTick(), Native.IsWindow(target), foreground.ToInt64(), pid);
                if (problem != null) return Program.Dict("recovered", false, "reason", problem);
                string expected = _why + "\nsource=agent-temporary\npauseId=" + _temporary.Id;
                if (!OwnedStopRecord.TryRelease(StopPath, expected, out problem))
                    return Program.Dict("recovered", false, "reason", problem);
                _temporary = null; _stopStamp = -1;
                _engaged = false; _stopped = false; _why = "";
                try { Glow.Stopped(false); } catch { }
                ResetMonitorRun();
                Program.AuditRecord("RECOVER", "agent temporary pause released after checks; no human R event");
                return Program.Dict("recovered", true, "source", "agent-temporary");
            }
        }
        public static void Engage(string why) { Engage(why, false); }
        public static void Engage(string why, bool temporary) { Engage(why, temporary, "unknown", ""); }
        /// `source` names the WITNESS that fired the brake, `evidence` the raw measurement behind it.
        /// Both are audit-only (same shape as Exit's): the detectors say what they saw, never who
        /// meant it, and without them every stop in the log would read as an anonymous event.
        public static void Engage(string why, bool temporary, string source, string evidence)
        {
            SyncExitedFromFile();
            bool announce = false;
            // Same ordered boundary as TryLightCycle/ApplyExitTeardown: a Q landing on the hook thread
            // can no longer sit between "not exited" and "paint the red border".
            lock (SyncLock)
            {
                bool wasTemporary = _temporary != null;
                _temporary = null;           // every newer stop revokes an earlier recovery claim
                if (_exited) return;         // Ctrl+Alt+Q already ended this session: stay silent
                if (_engaged)
                {
                    if (wasTemporary)
                    {
                        _why = why; WriteStopFile(why); Notify("panic", why);
                        // A RE-ENGAGE CHANGES THE RECORD, so it gets its own line: otherwise the STOP
                        // file's sentence is replaced with no trace, and a later RELEASE prints a
                        // releasedWhy that no ENGAGE line ever introduced (defect D7).
                        Program.AuditRecord("ENGAGE-UPDATE",
                            "source=" + (source == null ? "unknown" : source) +
                            "; replaced=temporary-permit; cycleLit=" + (CycleLit ? 1 : 0) +
                            "; why=" + why + "; evidence=" + (evidence == null ? "" : evidence));
                    }
                    return;
                }
                // R1: NO RED WITHOUT A LIVE CYCLE. Nothing is running, so there is nothing to stop and
                // a red border would be the exact lie this rule outlaws. This also closes the class of
                // "phantom brake" bugs at the root: a stray panic() from anywhere — another session's
                // aborted turn, a leftover script — can no longer paint the screen red on its own.
                if (!CycleLit) return;
                _why = why;
                _engaged = true;
                _stopped = true;                 // session-level, not just "this one action is refused"
                WriteStopFile(why);              // persist it: EVERY process must obey, not just this one
                if (temporary)
                {
                    uint targetPid;
                    long target = Program.RecoveryTarget(out targetPid);
                    _temporary = new RecoveryPermit { Target = target, Pid = targetPid,
                        InputVersion = Interlocked.Read(ref _externalInput), InputTick = Native.LastInputTick() };
                    WriteStopFile(why + "\nsource=agent-temporary\npauseId=" + _temporary.Id);
                }
                try { Glow.Kill(); } catch { }
                try { Glow.Stopped(true); } catch { }   // red border + red badge: unmistakable
                // THE BRAKE IS A STATE CHANGE, SO IT GETS A LINE (2026-09-14). This is the record the
                // "red frame appeared and nobody touched anything" report needs: the STOP file carries
                // the sentence, but Ctrl+Alt+R DELETES that file, so before this line every stop was
                // unattributable after the fact and a false positive was indistinguishable from a real
                // human hand. `source` is the witness ("hook" | "poll" | "monitor" | "agent" | "file"),
                // and `evidence` is the raw measurement — never a claim about who meant it.
                //
                // `engagedBy` is a LITERAL, not a read of `announce`: this line runs one statement
                // before `announce = true`, so interpolating it printed "already-engaged" on every
                // single ENGAGE record — a field that was structurally incapable of being right
                // (defect D6, found by review). Reaching here means THIS call engaged the brake.
                Program.AuditRecord("ENGAGE", "source=" + (source == null ? "unknown" : source) +
                    "; temporary=" + (temporary ? 1 : 0) + "; cycleLit=" + (CycleLit ? 1 : 0) +
                    "; engagedBy=this-process" +
                    "; why=" + why + "; evidence=" + (evidence == null ? "" : evidence));
                announce = true;
            }
            ReleaseStuck();                      // outside the lock: SendInput can block on a hung app
            if (announce) Notify("panic", why);
        }

        /// **The agent asks** — the same brake, a different reason, and a different announcement.
        ///
        /// It writes the STOP file like any stop (every process must obey), but it does NOT emit
        /// the "panic" event: that event tells the AGENT to wrap up, and the agent is the one
        /// asking. The "ask" event carries the QUESTION instead, so the plugin can put it in front
        /// of the human.
        ///
        /// Every ask carries an ID (F2, 2026-09-13): the window can end LATE, and a late ending must
        /// not touch a machine that a newer state — above all Ctrl+Alt+Q — now owns.
        public static void EngageAsk(string why)
        {
            SyncExitedFromFile();
            bool announce = false;
            lock (SyncLock)
            {
                _temporary = null;
                if (_exited) return;
                if (_engaged) return;            // already stopped for another reason: the stop wins
                // Same rule as the brake, R1: NO RED WITHOUT A LIVE CYCLE — an ask IS a red border, and
                // a question asked outside a computer-use cycle asks the human to answer something that
                // no cycle is waiting on. (It also reported "stopped: true" while stopping nothing.)
                if (!CycleLit) return;
                _why = why;
                _engaged = true;
                _stopped = true;
                _askId = ++_askSeq;              // this ask owns the countdown from here on
                // THE RECORD NAMES ITS ASKER (merge-design.md §4, item 3; precedent: the
                // `source=agent-temporary\npauseId=` record written by Engage() above). The
                // question stays the FIRST line — that is what a human reads — and the two markers
                // are what let the NEXT process sweep this brake instead of adopting it when the
                // asker died without releasing (host crash, worker kill, power cut).
                WriteStopFile(why + "\nsource=agent-ask\naskPid=" + Process.GetCurrentProcess().Id);
                _askStopStamp = _stopStamp;      // ... and it owns exactly THIS stop file
                // AN ASK IS A BRAKE TOO, so it must appear in the same log: without this line the
                // STOP file could be written, deleted by Ctrl+Alt+R, and leave a RELEASE whose
                // releasedWhy refers to a stop that was never introduced by an ENGAGE (defect D7).
                Program.AuditRecord("ENGAGE-ASK", "source=agent" +
                    "; askPid=" + Process.GetCurrentProcess().Id +
                    "; cycleLit=" + (CycleLit ? 1 : 0) + "; why=" + why);
                try { Glow.Kill(); } catch { }
                try { Glow.Ask(true); } catch { }        // fast-breathing RED, not the steady stop
                announce = true;
            }
            ReleaseStuck();                      // outside the lock: SendInput can block on a hung app
            if (announce) Notify("ask", why);
        }

        /// **The question is over — end it, exactly once, through exactly one method.**
        ///
        /// This is `AskSettled` and `AskExpired` FOLDED INTO ONE (merge-design.md §2.3, §5.1 item 4):
        /// the two used to be chosen by the worker from its own clock and its own input sampler, and
        /// the worker no longer judges anything — the answer, the dismissal, the abort and the
        /// deadline all arrive here from the client UI on the plugin side.
        ///
        /// `keepPause` is the HUMAN's decision, not a derivation from HOW the call ended: under D3
        /// the card offers "① 让你停" and "② 放你走" as ordinary options, so a submitted answer is
        /// NOT automatically a pause — it is a pause only when they clicked ①. Every other ending
        /// (②, a typed custom answer, a card dismissal, an aborted turn, the tool deadline, the
        /// answer channel throwing) releases the brake: an unanswered brake would freeze the machine
        /// while the human watches. `via` is carried into the audit log and decides nothing.
        ///
        /// ID-CHECKED and EXIT-CHECKED (F2). A stale ending must not unwind a newer ask, and an
        /// exit — Ctrl+Alt+Q, or an exit the agent requested — owns the machine and the screen, so
        /// this touches neither the lights nor the stop file.
        public static void EndAsk(int id, bool keepPause, string via)
        {
            // A REFUSAL MUST BE DIAGNOSABLE. This used to return silently, so the plugin's retry saw
            // only "no release" with nothing in the audit to explain it — and a refusal-by-RETURN never
            // rejects, so the core's one retry never even ran (audit finding 2, 2026-09-15). The two
            // refusals below already name themselves (ASK-RELEASE-FOREIGN-STOP / -STOP-LOCKED); this one
            // must too, so the next reader is not left guessing which of the three fired.
            if (id != _askId)
            {
                Program.AuditRecord("ASK-RELEASE-STALE-ID",
                    "via=" + (via == null ? "" : via) + "; endAsk carried askId=" + id + " but this process's " +
                    "owning ask is " + _askId + " (0 = it never raised or adopted one); the brake, if any, was " +
                    "NOT released by this call");
                return;                      // a NEWER ask owns the brake now: not ours to end
            }
            SyncExitedFromFile();
            string v = via == null ? "" : via;
            lock (SyncLock)
            {
                if (_exited) return;         // the exit owns the machine and the screen
                if (keepPause)
                {
                    // ① THE HUMAN SAID STOP: the drop of the fast-breathing cursor is all this
                    // branch does. The STOP file stays, `_engaged`/`_stopped` stay, and the steady
                    // red of an ordinary pause takes over — the human owns it, and only their
                    // Ctrl+Alt+R hands it back.
                    try { Glow.Ask(false); } catch { }
                    try { Glow.Stopped(true); } catch { }
                    Program.AuditRecord("ASK-RELEASE",
                        "via=" + v + "; keptPause=1; the human chose the pause, so the brake stands " +
                        "until Ctrl+Alt+R; stopped=" + (_stopped ? 1 : 0) + "; cycleLit=" + (CycleLit ? 1 : 0) +
                        "; why=" + _why);
                    return;
                }
                if (!_engaged || !_stopped) return;   // a newer state already changed the brake
                // OWNERSHIP OF THE BRAKE (native finding, 2026-09-13). This ask may release only the
                // STOP it wrote. A newer STOP planted while the question was open — another process's
                // stop, a stop raised by hand — is somebody else's brake, and deleting it here would
                // hand back a machine that nobody handed back (measured: an ask plus a STOP written
                // 300 ms in → the expiry deleted it and reported "the machine is YOURS AGAIN").
                if (CurrentStopStamp() != _askStopStamp)
                {
                    // The ASK's own cue must end anyway: a fast-breathing border whose title promises
                    // a decision that has already been made is the same class of lie we are removing.
                    // The machine IS stopped — by somebody else — so show the ordinary steady stop and
                    // say so in the audit log; release nothing.
                    try { Glow.Ask(false); } catch { }
                    try { Glow.Stopped(true); } catch { }
                    Program.AuditRecord("ASK-RELEASE-FOREIGN-STOP",
                        "via=" + v + "; the ask did not release a newer STOP (the brake changed hands while " +
                        "the question was open): " + _why);
                    return;
                }
                // OUR OWN BRAKE, BUT IT WILL NOT COME OFF (2026-09-13, real FileShare.Read lock): the
                // question still ends — as an ORDINARY PAUSE. `_engaged`/`_stopped` stay true, the
                // steady red replaces the fast-breathing ask cue, and the reply is derived from the
                // state machine, so it can no longer say "the machine is YOURS AGAIN" while the STOP
                // is still on disk.
                if (!DeleteStopFile())
                {
                    try { Glow.Ask(false); } catch { }
                    try { Glow.Stopped(true); } catch { }
                    Program.AuditRecord("ASK-RELEASE-STOP-LOCKED",
                        "via=" + v + "; the ask brake could not be released: " + LastStopError + " — the pause stands");
                    return;
                }
                _engaged = false;
                _stopped = false;
                // The released sentence has to be captured BEFORE `_why` is cleared — the audit pair
                // is only reconstructable if the RELEASE line quotes the stop it closed (D7).
                string releasedWhy = FirstLine(_why);
                _why = "";
                DeleteStopFile();
                try { Glow.Ask(false); } catch { }
                try { Glow.Stopped(false); } catch { }
                ResetMonitorRun();           // stale travel must not brake the moment we resume
                // THE PAIR IS CLOSED IN THE LOG TOO. `ENGAGE-ASK` without a matching `ASK-RELEASE`
                // is the one-line health check for this whole design (merge-design.md §8.6), so the
                // release states what ended it and that the brake really is gone.
                Program.AuditRecord("ASK-RELEASE",
                    "via=" + v + "; released=1; stopped=0; cycleLit=" + (CycleLit ? 1 : 0) +
                    "; releasedWhy=" + releasedWhy);
            }
        }

        /// Push the state change OUT of the request/response loop.
        ///
        /// 2026-09-13: the brake used to be invisible until the agent happened to make its next
        /// call — if the human hit ESC while the model was thinking, the model kept believing it
        /// was driving the machine, and only learned otherwise on the human's NEXT message. The
        /// worker now writes an unsolicited NDJSON event the instant the brake changes, which the
        /// Node layer turns into a session-visible notice (see computer-use-core's `panic` event).
        /// Three kinds of state change, three distinct events: `panic` (ESC — abort, machine stays
        /// stopped), `resume` (Ctrl+Alt+R), `exit` (Ctrl+Alt+Q — the session is over).
        public static Action<string, string> Changed;
        // One-shot mode (`worker.exe --op X`) has exactly ONE line of stdout: the response. An
        // unsolicited event written there would land in the middle of a machine-read answer, so
        // events are resident-only BY CONSTRUCTION rather than by luck.
        static volatile bool _quiet = false;
        public static void SetQuiet(bool on) { _quiet = on; }

        static void Notify(string kind, string why)
        {
            if (_quiet) return;
            try { Action<string, string> cb = Changed; if (cb != null) cb(kind, why); } catch { }
        }

        // Emergency stop ends the SESSION, not just the current action. While stopped every op
        // is refused except a tiny allowlist (health probe + the re-arm itself), so the agent
        // cannot quietly keep working after the human hit the brake.
        static volatile bool _stopped = false;
        public static bool Stopped { get { return _stopped; } }
        // ASK IDENTITY (F2): the ask window is time-boxed, so its ending always arrives LATE relative
        // to whatever may have happened meanwhile. Every ending carries the id of the ask that opened
        // it, and an ending for a stale id is refused instead of repainting the screen.
        static volatile int _askSeq = 0, _askId = 0;
        /// The id of the ask that currently owns the countdown; AskOp stamps it into every ending.
        public static int AskId { get { return _askId; } }
        /// The STOP file stamp THIS ask wrote. A different stamp at expiry means the brake changed
        /// hands while the question was open (another process wrote a newer stop, or someone deleted
        /// it) — and an ask may only release the brake IT raised (native finding, 2026-09-13).
        /// Not `volatile`: a long cannot be, and every read/write happens under SyncLock.
        static long _askStopStamp = 0;
        /// The STOP file's current write stamp, or 0 when there is none.
        static long CurrentStopStamp()
        {
            try { return File.Exists(StopPath) ? File.GetLastWriteTimeUtc(StopPath).Ticks : 0; }
            catch { return 0; }
        }
        static readonly HashSet<string> StopAllowlist = new HashSet<string> {
            "selftest", "cursor", "panic", "resume", "echoargs", "ping"
        };

        // The brake stops CONTROL, not OBSERVATION. Refusing to let the agent look at the screen
        // while stopped would only make it blind AND stopped — it could not even report why it is
        // stuck. Everything here reads; none of it drives anything.
        // Ops that actually DRIVE this machine — the ONLY ones allowed to clear an EXITED session.
        //
        // ALLOWLIST ON PURPOSE (2026-09-12). The old gate was a denylist, and a denylist drifts
        // silently: `probe` — the op our own deploy script runs to verify a fresh build — was never
        // on it, so every deploy deleted the EXITED marker and quietly re-opened a session the human
        // had ended with Ctrl+Alt+Q. Hours later the plugin's "an interrupted turn is a brake" rule
        // had a live session to brake and a red border appeared from nowhere. (Third time this shape
        // bit us: calm, then resume, then probe.) New ops are powerless here by default; if one
        // should re-open the session, it has to be said HERE, on purpose.
        public static readonly HashSet<string> DrivesMachineOps = new HashSet<string> {
            "click", "shiftClick", "move", "drag", "scroll", "select", "selectRange", "type", "key",
            "uiaAct", "windowOp", "activate", "clipWrite", "hover", "press", "marks", "ask", "exit",
            // "calibrate" drives too — it walks the pointer across the screen to prove pixel==click.
            // (selectRange / shiftClick / calibrate were found by build/test-op-classification.mjs on
            // its first run: three real dispatcher ops the hand-written list had simply missed.)
            "calibrate"
        };

        static readonly HashSet<string> ReadOnlyOps = new HashSet<string> {
            "selftest", "cursor", "panic", "resume", "recover", "echoargs", "ping", "screens",
            "windows", "uia", "uiaFromPoint", "uiaFocused", "waitForIdle", "clipRead",
            "capture", "annotate", "waitStable", "waitChange", "focus", "frameSig", "probe",
            // diagnostics that must be able to ANSWER while a brake is up: they send no input and
            // light nothing, which is exactly when someone needs to inspect the release decision
            "keyClass", "stuckPlan",
            // THE TWO ASK OPS BELONG HERE (merge-design.md §2.1, §2.2, §5.1 item 8). `beginAsk`
            // RAISES the brake and `endAsk` DROPS it, so both must answer while a brake is up —
            // that is their entire job, and `CheckOp` (below) refuses anything that is not in this
            // set while stopped, which would make the ask unable to open and, far worse, unable to
            // release. Neither may re-open a Q-ended session either, which is what the OTHER set
            // means; so: read-only, beside keyClass/stuckPlan.
            "beginAsk", "endAsk"
        };

        public static void CheckOp(string op)
        {
            SyncFromFile();                  // another process may have hit the brake a moment ago
            // "exit" is the ONE driving op the brake must let through: the ask protocol hands the
            // decision back to the agent, and "stop the whole session" is one of its two answers.
            // Refusing it there would strand the human holding a stopped machine with an agent that
            // cannot even say Q. Still gated by the EXITED latch, and idempotent either way.
            // A DEAD CYCLE DRIVES NOTHING. Not even a one-shot `worker.exe --op click` from a
            // script: that process only ever consulted the BRAKE, so after Ctrl+Alt+Q (which clears
            // the brake and ends the session) it drove the machine anyway — the exact "所有相关进程
            // 都必须等下一轮拉起" rule broken by omission. Read-only stays open on purpose: the
            // diagnosis of a dead session must still work.
            if (_exited && op != null && DrivesMachineOps.Contains(op))
                // THE WORDING IS PART OF THE BUG (2026-09-13). This sentence used to read
                // "Ctrl+Alt+Q ended computer use for this session", with no time and no witness —
                // and an agent that read it in a BRAND-NEW session told the human "you pressed
                // Ctrl+Alt+Q" for a key press that had happened 4 minutes earlier, in another
                // session, possibly not by them at all. Say what is on the record, say when, and
                // say plainly that it is history rather than an event.
                throw new Exception("CYCLE-ENDED: no computer-use cycle is live on this machine — it ended at " +
                    (_exitAt.Length > 0 ? _exitAt : "an earlier time") + " by " +
                    (_why.Length > 0 ? _why : "Ctrl+Alt+Q") + " (source=" + _exitSource + "). " +
                    "That is a RECORD of an earlier moment, not something that just happened, and it does " +
                    "not say whose keys they were: report it as measured, and do NOT tell the human that " +
                    "they pressed Ctrl+Alt+Q. Nothing drives again until a new computer-use cycle is " +
                    "opened — the plugin opens it on the first computer_* call of a later turn, so " +
                    "the right move is to tell the human what the record says and wait, not to retry. " +
                    "Refused: " + op);
            if (!_stopped || op == null || ReadOnlyOps.Contains(op) || op == "exit") return;
            throw new Exception("ABORTED: the computer-use session is stopped (" + _why +
                "). Nothing that DRIVES the machine runs until the HUMAN lifts it: Ctrl+Alt+R is the " +
                "only key that does, and no tool call of yours can (the old 'or call the resume op' " +
                "was a lie the moment resume became the cycle-opening op). Tell the human to press " +
                "Ctrl+Alt+R, then STOP and wait — do not retry. Ctrl+Alt+Q exits instead. " +
                "Observation tools still work. Refused: " + op);
        }

        public static void Clear()
        {
            bool was = false;
            // The same ordered boundary: re-arming must not interleave with an exit's teardown.
            lock (SyncLock)
            {
                _temporary = null;
                if (!_engaged && !_stopped) return;   // hook + poll both see R: fire once
                // RELEASE FIRST, AND ONLY BELIEVE IT IF IT REALLY HAPPENED (bug, 2026-09-13): the STOP
                // is a fact about the MACHINE, so a release that did not reach the disk (another
                // process holding the file) must leave every in-memory flag, the red border and the
                // monitors exactly as they were — otherwise Ctrl+Alt+R reports "继续", the agent is
                // woken, and the next poll re-adopts the stop. No notification is sent on failure.
                if (!DeleteStopFile())
                {
                    Program.AuditRecord("CLEAR-FAILED",
                        "Ctrl+Alt+R could not release the brake: " + LastStopError + " — the stop stands");
                    return;
                }
                if (CycleLit) Arm(); else Disarm();
                was = _engaged;
                // CLOSE THE PAIR (2026-09-14): the STOP file is DELETED right above, so without this
                // line the only on-disk trace of the brake disappeared with it — the incident could
                // not be reconstructed even in principle. The released `why` is the whole point of
                // the matching ENGAGE line; `via=human-R` says only that Clear() ran, never that the
                // human pressed R (the agent's own recover op reaches recoverTemporary, not this path).
                Program.AuditRecord("RELEASE", "via=human-R-or-external-clear; was=" + (was ? 1 : 0) +
                    "; stopped=" + (_stopped ? 1 : 0) + "; cycleLit=" + (CycleLit ? 1 : 0) +
                    "; releasedWhy=" + _why);
                _engaged = false;
                _stopped = false;
                _why = "";
                // (the release already happened and was verified above — a second delete here was the
                // old body's way of "making sure", and it is exactly what hid the failure)
                try { Glow.Ask(false); } catch { }
                try { Glow.Stopped(false); } catch { }
                // Re-arming re-baselines the human monitor: the travel that tripped the brake must not
                // still be sitting in the accumulator, or the very next poll would brake again.
                _agentActAt = 0;
            }
            if (was) Notify("resume", "");
        }

        /// Never leave a button or modifier held down after an abort.
        /// Is this key/button REALLY down right now? The only question a release may be based on.
        static bool KeyIsDown(int vk)
        {
            try { return (Native.GetAsyncKeyState(vk) & 0x8000) != 0; } catch { return false; }
        }

        /// Total EVENTS THE OS ACTUALLY INSERTED by ReleaseStuck() in this process. Counted from
        /// SendInput's return value, never from the plan: a plan of three releases whose SendInput
        /// returned 0 (or threw) must not read as three successes.
        static long _stuckInserted = 0;
        public static long StuckInserted { get { return _stuckInserted; } }

        /// THE PLAN: which releases are justified, given which keys/buttons are down. Pure decision —
        /// no input is sent by this function, which is what lets a fixture measure WHICH events the
        /// release would send without pressing anything on a live desktop.
        ///
        /// A plan proves the DECISION, never that the OS released anything: `StuckInserted` is the
        /// field that reports insertions. Modifier families are therefore resolved to the SPECIFIC
        /// left/right variant that is down (0xA0/0xA1 shift, 0xA2/0xA3 ctrl, 0xA4/0xA5 alt, 0x5B/0x5C
        /// win) and only fall back to the generic VK when the specific ones do not report down — a
        /// release for the wrong variant is exactly the kind of thing a plan string would hide.
        static List<string> StuckPlan(Func<int, bool> down)
        {
            List<string> plan = new List<string>();
            if (down(Native.VK_LBUTTON)) plan.Add("LEFTUP");
            if (down(Native.VK_RBUTTON)) plan.Add("RIGHTUP");
            if (down(Native.VK_MBUTTON)) plan.Add("MIDDLEUP");
            AddModifier(plan, down, new ushort[] { 0xA0, 0xA1 }, Native.VK_SHIFT);   // L/R shift, else shift
            AddModifier(plan, down, new ushort[] { 0xA2, 0xA3 }, Native.VK_CONTROL); // L/R ctrl,  else ctrl
            AddModifier(plan, down, new ushort[] { 0xA4, 0xA5 }, Native.VK_MENU);    // L/R alt,   else alt
            AddModifier(plan, down, new ushort[] { 0x5B, 0x5C }, 0);                // L/R Win,   else none
            return plan;
        }
        static void AddModifier(List<string> plan, Func<int, bool> down, ushort[] specific, int generic)
        {
            // EVERY side that is down gets a release — the `return` that used to sit inside this loop
            // planned ONE release and dropped the other, so an interrupt would leave the second side
            // unreleased (PRODUCTION PLAN measured: down=[160,161] planned only UP:0xA0). Note what
            // that evidence IS: a plan-level measurement on the deployed build; the OS-level residue of
            // a real two-sided hold is NOT measured and is not claimed. The generic VK is a FALLBACK
            // for a state that names no side, never an addition to a specific one — releasing both a
            // specific and the generic form of the same physical key would send a second, needless key-up.
            bool any = false;
            foreach (ushort vk in specific) if (down(vk)) { plan.Add("UP:0x" + vk.ToString("X2")); any = true; }
            if (!any && generic != 0 && down(generic)) plan.Add("UP:0x" + ((ushort)generic).ToString("X2"));
        }

        /// Is this virtual key one of the E0-prefixed "extended" keys? Right Ctrl/Alt (0xA3/0xA5) and
        /// BOTH Windows keys (0x5B left, 0x5C right) are — the Windows keys emit E0 5B / E0 5C, and the
        /// Keyboard Input Overview's extended-key flag section counts them among the extended keys, so
        /// excluding the LEFT one was an omission. Right SHIFT (0xA1) is NOT extended (scan code 0x36,
        /// no E0) and must not be flagged.
        /// SCOPE: this only decides what prefix the synthesised RELEASE carries; the end-to-end effect
        /// on a physically held key is not measured in this round (no key is injected while the machine
        /// is paused for the physical-R acceptance).
        internal static bool IsExtendedVk(ushort vk) { return vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5; }

        /// The same plan for the machine's CURRENT state (read-only: sends nothing).
        public static List<string> StuckPlanForLive() { return StuckPlan(KeyIsDown); }
        /// The same plan for an explicit down-set (the diagnostic op's entry point).
        public static List<string> StuckPlanFor(Func<int, bool> down) { return StuckPlan(down); }

        /// Never leave a button or modifier held down after an abort — AND NEVER INVENT ONE (bug,
        /// 2026-09-13, measured on screen). This used to send LEFTUP/RIGHTUP/MIDDLEUP and
        /// Shift/Ctrl/Alt/Win key-ups UNCONDITIONALLY: a plain pause with no input at all therefore
        /// produced a ghost RIGHTUP (a context menu) and a ghost Alt KEYUP (the menu bar and its
        /// letter hints — the "凭空弹右键菜单和 Alt 提示" report). Every event is now gated on the OS
        /// saying that button/key is really down, while a genuinely held one — an interrupted drag, a
        /// stuck combo — is still released, which is the whole reason this function exists.
        static void ReleaseStuck()
        {
            try { _stuckInserted += Program.ReleaseOwnedInputs(); } catch { }
        }
        static INPUT MouseInput(uint flags)
        {
            INPUT i = new INPUT(); i.type = Native.INPUT_MOUSE; i.u.mi.dwFlags = flags;
            i.u.mi.dwExtraInfo = OwnMagic;
            // Re-baseline the human monitor at the moment of the ACTUAL input — NOT at the start of
            // the op. A click resolves its target first (UIA lookups, hundreds of ms) and only then
            // moves the pointer, so the stamp taken in FailsafeCheck() had long expired by the time
            // the pointer jumped: the monitor read our own 939 px jump as "the human moved the
            // mouse" and braked the session with nobody touching anything (reported 2026-09-12,
            // "hands off the mouse and it lit up red by itself"). Same discipline the keyboard
            // already uses: tag the input where it is SENT.
            AgentActed();
            return i;
        }

        /// Called by every actuation: throws while the brake is on.
        public static void Check(string op)
        {
            SyncFromFile();                  // long ops re-check: the brake can land mid-flight
            // EXIT IS A BRAKE TOO (mid-action stop bug, 2026-09-13): this tested `_engaged` only, so an
            // op entering while the session was already ENDED could still drive. `_stopped` is included
            // for the same reason: a stop that is engaged but not yet marked engaged is still a stop.
            if (_exited)
                throw new Exception("CYCLE-ENDED: computer use was ended for this session" +
                    (_exitAt.Length > 0 ? " at " + _exitAt : "") + " - " + op + " refused. A NEW cycle is " +
                    "opened by the first real computer-use call of a LATER TURN, never by this op and " +
                    "never by resume; observation tools still work. Do not tell the human they pressed anything.");
            if (_engaged || _stopped)
                throw new Exception("ABORTED: the session is stopped (" + _why + ") — " + op +
                    " refused. Nothing that DRIVES this machine runs until the HUMAN lifts it with " +
                    "Ctrl+Alt+R: no tool call of yours can (the resume op opens a cycle, it does not clear " +
                    "a human's brake). Observation tools still work. Tell the human to press Ctrl+Alt+R, " +
                    "then STOP and wait - do not retry. " +
                    "Ctrl+Alt+Q exits the session.");
        }
    }

    // These scopes are exercised with injected devices; native adapters stay at the boundary.
    public static class KeyboardChord
    {
        public static void Run(IList<ushort> keys, Action<ushort, bool> send,
            Action<ushort> release, Func<ushort, bool> isDown, Action hold)
        {
            foreach (ushort key in keys)
                if (isDown(key))
                {
                    var refusal = new Exception("KEY_ALREADY_DOWN: a requested key is already held; no chord input sent.");
                    refusal.Data["code"] = "KEY_ALREADY_DOWN";
                    refusal.Data["outcome"] = "not-dispatched";
                    throw refusal;
                }
            var pressed = new List<ushort>();
            try
            {
                foreach (ushort key in keys) { send(key, false); pressed.Add(key); }
                hold();
                while (pressed.Count > 0)
                {
                    int last = pressed.Count - 1;
                    send(pressed[last], true);
                    pressed.RemoveAt(last);
                }
            }
            catch (Exception original)
            {
                var failed = new List<string>();
                for (int i = pressed.Count - 1; i >= 0; i--)
                    try { release(pressed[i]); }
                    catch { failed.Add("0x" + pressed[i].ToString("X2")); }
                if (failed.Count > 0)
                {
                    var error = new Exception(original.Message + "; KEY_CLEANUP_FAILED: could not release " +
                        string.Join(",", failed.ToArray()) + ". Check the keyboard state before continuing.", original);
                    error.Data["keyCleanup"] = "failed";
                    throw error;
                }
                original.Data["keyCleanup"] = "completed";
                throw;
            }
        }
    }

    public sealed class ClipboardBytes
    {
        public uint Format;
        public byte[] Bytes;
        public ClipboardBytes(uint format, byte[] bytes) { Format = format; Bytes = bytes; }
    }

    public interface IClipboardSession : IDisposable
    {
        uint Sequence { get; }
        List<ClipboardBytes> Snapshot();
        void Replace(List<ClipboardBytes> formats);
    }

    public interface IClipboardAccess
    {
        IClipboardSession Open();
    }

    // Comparison and restoration use the SAME exclusive clipboard lock, not a check-then-write.
    public sealed class ClipboardLease
    {
        readonly IClipboardAccess access;
        readonly List<ClipboardBytes> previous;
        readonly uint written;
        bool finished;
        ClipboardLease(IClipboardAccess access, List<ClipboardBytes> previous, uint written)
        { this.access = access; this.previous = previous; this.written = written; }
        public static ClipboardLease Begin(IClipboardAccess access, string text)
        {
            using (var session = access.Open())
            {
                if (session.Sequence == 0) throw new Exception("Clipboard sequence unavailable; clipboard was not changed.");
                var previous = session.Snapshot(); // refuse unsupported formats BEFORE clearing anything
                try
                {
                    session.Replace(new List<ClipboardBytes> {
                        new ClipboardBytes(13, Encoding.Unicode.GetBytes(text + "\0")) });
                }
                catch (Exception writeError)
                {
                    try { session.Replace(previous); }
                    catch { throw new Exception("CLIPBOARD_WRITE_AND_RESTORE_FAILED: inspect clipboard before retrying.", writeError); }
                    throw;
                }
                uint written = session.Sequence;
                if (written == 0)
                {
                    session.Replace(previous);
                    throw new Exception("Clipboard sequence unavailable after write; previous bytes restored.");
                }
                return new ClipboardLease(access, previous, written);
            }
        }
        public bool StillOwned()
        {
            using (var session = access.Open()) { return !finished && session.Sequence != 0 && session.Sequence == written; }
        }
        public string Restore()
        {
            if (finished) return "already-finished";
            using (var session = access.Open())
            {
                if (session.Sequence == 0) throw new Exception("Clipboard sequence unavailable; restoration skipped.");
                if (session.Sequence != written) { finished = true; return "skipped-changed"; }
                session.Replace(previous);
                finished = true;
                return "restored";
            }
        }
    }

    // Copy only explicitly supported HGLOBAL formats. Unknown/private or GDI formats are refused
    // without mutation; callers can use Unicode input instead of losing an opaque clipboard item.
    public sealed class NativeClipboardAccess : IClipboardAccess, IDisposable
    {
        readonly NativeWindow window = new NativeWindow();
        public NativeClipboardAccess()
        {
            window.CreateHandle(new CreateParams { Caption = "DSH clipboard lease", Parent = new IntPtr(-3) });
        }
        public void Dispose() { window.DestroyHandle(); }
        public IClipboardSession Open() { return new Session(window.Handle); }
        [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll")] static extern bool CloseClipboard();
        [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll", SetLastError = true)] static extern uint EnumClipboardFormats(uint format);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatName(uint format, StringBuilder name, int count);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
        [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
        [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
        static Exception Unavailable(string reason)
        {
            var error = new Exception("CLIPBOARD_PRESERVATION_UNAVAILABLE: " + reason +
                "; clipboard unchanged. Use mode:unicode if suitable for the target editor.");
            error.Data["code"] = "CLIPBOARD_PRESERVATION_UNAVAILABLE";
            error.Data["outcome"] = "not-dispatched";
            return error;
        }
        public static bool Supported(uint format, string name)
        {
            if (format == 1 || format == 7 || format == 8 || format == 13 || format == 15 || format == 16 || format == 17) return true;
            if (format < 0xC000) return false;
            return name == "HTML Format" || name == "Rich Text Format" || name == "Rich Text Format Without Objects" ||
                name == "PNG" || name == "CSV" || name == "text/html" || name == "text/plain";
        }
        sealed class Session : IClipboardSession
        {
            bool opened;
            public Session(IntPtr owner)
            {
                for (int attempt = 0; attempt < 8; attempt++)
                {
                    if (OpenClipboard(owner)) { opened = true; return; }
                    Thread.Sleep(10);
                }
                throw new Exception("Clipboard busy; exclusive access unavailable.");
            }
            public uint Sequence { get { return GetClipboardSequenceNumber(); } }
            public void Dispose() { if (opened) { CloseClipboard(); opened = false; } }
            public List<ClipboardBytes> Snapshot()
            {
                var formats = new List<uint>();
                uint format = 0;
                while (true)
                {
                    SetLastError(0);
                    format = EnumClipboardFormats(format);
                    if (format == 0)
                    {
                        if (Marshal.GetLastWin32Error() != 0) throw Unavailable("format enumeration failed");
                        break;
                    }
                    var name = new StringBuilder(256);
                    if (format >= 0xC000) GetClipboardFormatName(format, name, name.Capacity);
                    if (!Supported(format, name.ToString())) throw Unavailable("unsupported format " + format);
                    formats.Add(format);
                    if (formats.Count > 64) throw Unavailable("too many formats");
                }
                var result = new List<ClipboardBytes>();
                long total = 0;
                foreach (uint id in formats)
                {
                    IntPtr handle = GetClipboardData(id);
                    if (handle == IntPtr.Zero) throw Unavailable("data unavailable for format " + id);
                    ulong size = GlobalSize(handle).ToUInt64();
                    if (size == 0 || size > 32 * 1024 * 1024 || total + (long)size > 32 * 1024 * 1024)
                        throw Unavailable("clipboard snapshot exceeds supported size");
                    total += (long)size;
                    IntPtr data = GlobalLock(handle);
                    if (data == IntPtr.Zero) throw Unavailable("clipboard data could not be locked");
                    try
                    {
                        var bytes = new byte[(int)size]; Marshal.Copy(data, bytes, 0, bytes.Length);
                        result.Add(new ClipboardBytes(id, bytes));
                    }
                    finally { GlobalUnlock(handle); }
                }
                return result;
            }
            public void Replace(List<ClipboardBytes> formats)
            {
                // Allocate and copy everything before EmptyClipboard so allocation failure is harmless.
                var handles = new List<IntPtr>();
                try
                {
                    foreach (var format in formats)
                    {
                        IntPtr handle = GlobalAlloc(0x0002, new UIntPtr((uint)format.Bytes.Length));
                        if (handle == IntPtr.Zero) throw new Exception("Clipboard allocation failed.");
                        handles.Add(handle);
                        IntPtr data = GlobalLock(handle);
                        if (data == IntPtr.Zero) throw new Exception("Clipboard allocation lock failed.");
                        try { Marshal.Copy(format.Bytes, 0, data, format.Bytes.Length); }
                        finally { GlobalUnlock(handle); }
                    }
                    if (!EmptyClipboard()) throw new Exception("Clipboard clear failed.");
                    for (int i = 0; i < formats.Count; i++)
                    {
                        if (SetClipboardData(formats[i].Format, handles[i]) == IntPtr.Zero)
                            throw new Exception("Clipboard write failed for format " + formats[i].Format);
                        handles[i] = IntPtr.Zero; // ownership transferred to Windows
                    }
                }
                finally { foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) GlobalFree(handle); }
            }
        }
    }

    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static int _reqId = 0;
        static readonly object OutLock = new object();   // responses AND unsolicited events share stdout
        static readonly DateTime Epoch = new DateTime(1970, 1, 1);

        // Position correction is diagnostic only. Physical input immediately yields;
        // no distance, reversal, wheel-count or screen-corner rule latches a pause.
        static int _positionCorrections;
        static string _dpiNote = "unset";
        static readonly HashSet<string> ObsOps = new HashSet<string>
        {
            "ping", "echoargs", "screens", "cursor", "capture", "annotate",
            "windows", "uia", "uiaFromPoint", "uiaFocused", "waitForIdle", "clipRead",
            "selftest", "indicator", "waitStable", "waitChange", "focus", "frameSig", "probe"
        };

        static int Dist(POINT p, int x, int y) { return Math.Abs(p.X - x) + Math.Abs(p.Y - y); }

        static readonly HashSet<string> ActOps = new HashSet<string>
        {
            "move", "click", "drag", "scroll", "key", "type", "clipWrite",
            "activate", "windowOp", "calibrate", "selectRange", "uiaAct"
        };
        static readonly object InputLock = new object();
        static readonly Dictionary<string, INPUT> OwnedUps = new Dictionary<string, INPUT>();
        static readonly ConcurrentDictionary<int, bool> CancelledRequests = new ConcurrentDictionary<int, bool>();
        static long _cancelGeneration;
        static long _operationCancelGeneration, _operationHumanRevision;
        static volatile bool _operationLive, _operationDispatched;
        static volatile int _activeRequestId, _lastCompletedRequestId;
        // The seam is internal to the compiled program; no tool can replace it.
        internal static Func<INPUT[], uint> InputSender = delegate(INPUT[] inputs) {
            return Native.SendInput((uint)inputs.Length, inputs, InputCbSize);
        };

        static Exception InputInterrupted(string code, string message)
        {
            var error = new Exception(code + ": " + message);
            error.Data["code"] = code;
            error.Data["outcome"] = _operationDispatched ? "unknown" : "not-dispatched";
            return error;
        }
        public static void CheckHumanInput()
        {
            if (Panic.PauseRequested)
                throw InputInterrupted("ABORTED", "Ctrl+Esc requested a manual pause; wait for manual recovery.");
            if (_operationLive && _operationCancelGeneration != Interlocked.Read(ref _cancelGeneration))
                throw InputInterrupted("INPUT_CANCELLED", "the owning tool was cancelled; no further input will be sent.");
            // THE APPROVAL GRACE (2026-10-16). Input that arrives while an approval card is pending is
            // the human reaching for "approve once" — Harness chrome, not the application being driven.
            // Treating it as a takeover is what made `standard` mode self-defeating on a single-mouse
            // desktop. The grace is deliberately NARROW:
            //   * only while the card is actually pending (`HeldForApproval`),
            //   * and only BEFORE this operation has dispatched anything — once
            //     `_operationDispatched` is set the real takeover rule applies unconditionally, so a
            //     human who grabs the machine mid-gesture still interrupts the gesture.
            // It never suppresses the brake (above) or the cancellation (above).
            bool approvalGrace = Panic.HeldForApproval && !_operationDispatched;
            if (!approvalGrace &&
                (Panic.HumanActive || (_operationLive && _operationHumanRevision != Panic.HumanRevision)))
                throw InputInterrupted("HUMAN_YIELD", "Physical input owns the desktop. Wait for three quiet seconds, then inspect the current target before continuing; never replay a partial write.");
        }
        static void MarkMutation()
        {
            Panic.Check("actuation"); CheckHumanInput(); _operationDispatched = true;
        }
        public static bool CancelInput(int requestId)
        {
            if (requestId <= 0 || requestId <= _lastCompletedRequestId) return false;
            CancelledRequests[requestId] = true;
            if (_activeRequestId == requestId)
            { Interlocked.Increment(ref _cancelGeneration); ReleaseOwnedInputs(); }
            return true;
        }
        static string InputKey(INPUT input, out bool up, out INPUT release, out int physical)
        {
            release = input; up = false; physical = 0;
            if (input.type == Native.INPUT_KEYBOARD)
            {
                up = (input.u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0;
                release.u.ki.dwFlags |= Native.KEYEVENTF_KEYUP;
                if ((input.u.ki.dwFlags & Native.KEYEVENTF_UNICODE) != 0) return "unicode:" + input.u.ki.wScan;
                physical = input.u.ki.wVk; return "key:" + physical;
            }
            if (input.type != Native.INPUT_MOUSE) return null;
            uint f = input.u.mi.dwFlags, downFlag = 0, upFlag = 0;
            if ((f & (Native.MOUSEEVENTF_LEFTDOWN | Native.MOUSEEVENTF_LEFTUP)) != 0)
            { physical = 1; downFlag = Native.MOUSEEVENTF_LEFTDOWN; upFlag = Native.MOUSEEVENTF_LEFTUP; }
            else if ((f & (Native.MOUSEEVENTF_RIGHTDOWN | Native.MOUSEEVENTF_RIGHTUP)) != 0)
            { physical = 2; downFlag = Native.MOUSEEVENTF_RIGHTDOWN; upFlag = Native.MOUSEEVENTF_RIGHTUP; }
            else if ((f & (Native.MOUSEEVENTF_MIDDLEDOWN | Native.MOUSEEVENTF_MIDDLEUP)) != 0)
            { physical = 4; downFlag = Native.MOUSEEVENTF_MIDDLEDOWN; upFlag = Native.MOUSEEVENTF_MIDDLEUP; }
            if (downFlag == 0) return null;
            up = (f & upFlag) != 0;
            release.u.mi.dwFlags = upFlag; release.u.mi.dx = release.u.mi.dy = 0;
            return "mouse:" + physical;
        }
        static uint SendTrackedInput(INPUT[] inputs)
        {
            lock (InputLock)
            {
                CheckHumanInput();
                // Never acquire Panic.SyncLock while owning InputLock: adopting a
                // cross-process STOP may hold SyncLock while releasing owned input.
                if (Panic.Engaged || Panic.Stopped || Panic.Exited)
                    throw InputInterrupted("ABORTED", "manual pause or exit owns the desktop; no further input will be sent.");
                if (inputs.Length == 1)
                {
                    bool isUp; INPUT release; int physical;
                    string key = InputKey(inputs[0], out isUp, out release, out physical);
                    if (isUp && key != null && !OwnedUps.ContainsKey(key)) return 1;
                }
                uint sent = InputSender(inputs);
                if (sent > 0) _operationDispatched = true;
                for (int i = 0; i < Math.Min(sent, inputs.Length); i++)
                {
                    bool isUp; INPUT release; int physical;
                    string key = InputKey(inputs[i], out isUp, out release, out physical);
                    if (key == null) continue;
                    if (isUp) OwnedUps.Remove(key); else OwnedUps[key] = release;
                }
                return sent;
            }
        }
        static uint ReleaseOwnedKey(string key)
        {
            INPUT input;
            if (!OwnedUps.TryGetValue(key, out input)) return 0;
            bool up; INPUT release; int physical;
            InputKey(input, out up, out release, out physical);
            // A physical down transfers this key/button to the user. Releasing it here
            // would terminate the user's own drag/chord. Their physical up will release it.
            if (physical != 0 && Panic.HumanHolds(physical)) { OwnedUps.Remove(key); return 0; }
            uint sent = InputSender(new INPUT[] { release });
            if (sent == 1) OwnedUps.Remove(key);
            return sent;
        }
        public static uint ReleaseOwnedInputs()
        {
            lock (InputLock)
            {
                uint sent = 0;
                foreach (string key in OwnedUps.Keys.Reverse().ToArray())
                    try { sent += ReleaseOwnedKey(key); } catch { }
                return sent;
            }
        }

        static readonly string AuditPath = ResolveAuditPath();

        static string ResolveAuditPath()
        {
            try
            {
                string env = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_AUDIT_LOG");
                if (!string.IsNullOrEmpty(env)) return env;
            }
            catch { }
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-computer-use", "worker-audit.log");
        }

        static void AuditActuation(string reqLine, Dictionary<string, object> resp)
        {
            try
            {
                Dictionary<string, object> req = Json.Deserialize<Dictionary<string, object>>(reqLine);
                object o;
                string op = req != null && req.TryGetValue("op", out o) ? o as string : null;
                if (op == null || !ActOps.Contains(op)) return;
                object av;
                Dictionary<string, object> args = (req.TryGetValue("args", out av) && av is Dictionary<string, object>)
                    ? (Dictionary<string, object>)av : new Dictionary<string, object>();
                Dictionary<string, object> safe = new Dictionary<string, object>();
                foreach (KeyValuePair<string, object> kv in args)
                    safe[kv.Key] = (kv.Key == "text" && kv.Value != null)
                        ? ("<" + Convert.ToString(kv.Value).Length + " chars>") : kv.Value;
                bool ok = false; object okv;
                if (resp != null && resp.TryGetValue("ok", out okv)) { try { ok = Convert.ToBoolean(okv); } catch { } }
                string status = ok ? "ok"
                    : ("error=" + (resp != null && resp.ContainsKey("error") ? Convert.ToString(resp["error"]) : "?"));

                string dir = Path.GetDirectoryName(AuditPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                StringBuilder sb = new StringBuilder();
                sb.Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"));
                sb.Append('\t').Append(op);
                sb.Append('\t').Append(Json.Serialize(safe));
                sb.Append('\t').Append(status);
                sb.Append("\tpid=").Append(Process.GetCurrentProcess().Id);
                File.AppendAllText(AuditPath, sb.ToString() + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { /* auditing must never break actuation */ }
        }

        /// Records that are not actuations — exits, brake changes, chord detections. Same file, same
        /// shape as AuditActuation on purpose: one `tail worker-audit.log` must answer "what happened
        /// at 01:17:44" with a line instead of a theory. (2026-09-13: the exit was the ONE state
        /// change the audit log did not carry, so the incident had to be reconstructed from a
        /// sentence on disk and two session transcripts.)
        public static void AuditRecord(string what, string detail)
        {
            try
            {
                string p = AuditPath;
                if (string.IsNullOrEmpty(p)) return;
                string dir = Path.GetDirectoryName(p);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                StringBuilder sb = new StringBuilder();
                sb.Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"));
                sb.Append('\t').Append(what);
                sb.Append('\t').Append(detail == null ? "" : detail.Replace("\t", " ").Replace("\r", " ").Replace("\n", " "));
                sb.Append("\tpid=").Append(Process.GetCurrentProcess().Id);
                File.AppendAllText(p, sb.ToString() + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { /* an audit line must never break the brake */ }
        }

        /// Animated absolute move: the pointer visibly travels from wherever it
        /// is to (tx,ty) along an ease-in-out curve — the human can watch it.
        static void AnimatedMove(int tx, int ty, int durationMs)
        {
            POINT c; Native.GetCursorPos(out c);
            int dist = Dist(c, tx, ty);
            if (dist > 2)
            {
                int steps = Math.Max(6, Math.Min(40, dist / 18));
                if (durationMs < 60) durationMs = 60;
                int stepMs = Math.Max(4, durationMs / steps);
                Stopwatch sw = Stopwatch.StartNew();
                // THE SEQUENCE, not one step, is what is in flight: the light must stay blue across
                // the sleeps between steps (the measured 3823 ms move whose blue died at 1200 ms).
                Glow.InputBegin();
                try
                {
                    for (int i = 0; i < steps; i++)
                    {
                        double t = Math.Min(1.0, (double)sw.ElapsedMilliseconds / durationMs);
                        double e = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2; // easeInOutQuad
                        int ix = c.X + (int)((tx - c.X) * e), iy = c.Y + (int)((ty - c.Y) * e);
                        int ax, ay; ToAbs(ix, iy, out ax, out ay);
                        SendMouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
                        Thread.Sleep(stepMs);
                    }
                }
                finally { Glow.InputEnd(); }
            }
            int fx, fy; ToAbs(tx, ty, out fx, out fy);
            SendMouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, fx, fy, 0);
        }

        [STAThread]
        static int Main(string[] args)
        {
            // DPI awareness first: it decides the coordinate space of everything below
            // (GetSystemMetrics, GetCursorPos, capture pixels, UIA rects AND the
            // interpretation of SendInput's absolute coordinates). Record which call won.
            try
            {
                if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) _dpiNote = "PerMonitorV2";
                else if (Native.SetProcessDPIAware()) _dpiNote = "SystemAware(fallback)";
                else _dpiNote = "UNAWARE(CRITICAL: coordinates will be silently scaled)";
            }
            catch { _dpiNote = "UNAWARE(CRITICAL: SetProcessDpiAwarenessContext threw)"; }
            Panic.Init();   // install the human's emergency brake before doing anything else
            // The brake reports itself the moment it changes: an unsolicited NDJSON event on
            // stdout (no `id`, so it can never be confused with a reply). This is what makes
            // "you have been emergency-stopped" reach the model mid-turn instead of on the
            // human's next message.
            Panic.Changed = delegate(string kind, string why)
            {
                try
                {
                    // THE HINT MUST NOT NAME A KEY PRESS NOBODY MEASURED (2026-09-13, Codex review).
                    // It used to say "ABORTED by the human (ESC)" / "EXITED by the human (Ctrl+Alt+Q)"
                    // / else "the human resumed" — three claims about a human, on an event whose only
                    // witness is a detector, and `ask` fell into the `else` and was reported as a
                    // RESUME. The hint now reports the KIND and quotes the worker's own `why`, which
                    // is where a measured sentence like "Ctrl+Alt+Q chord detected ... (source=hook)"
                    // lives; the consumer can read the fields and draw no conclusion the worker did
                    // not record itself.
                    string hint;
                    if (kind == "panic" && !string.IsNullOrEmpty(Panic.TemporaryPauseId))
                        hint = "Agent temporary diagnostic pause. Inspect the current target, then use checked recover only if the blocker is resolved. Credential: " + Panic.TemporaryPauseId;
                    else if (kind == "panic")
                        hint = "STOPPED (brake engaged). The machine is stopped: nothing that drives it runs " +
                               "until a human resumes with Ctrl+Alt+R. WRAP UP NOW: one short summary of what " +
                               "was interrupted and where things stand, then stop working and wait. Do not " +
                               "retry, do not call resume yourself. The worker's own record: " + why;
                    else if (kind == "exit")
                        hint = "SESSION OVER (the exit record stands). Stop immediately, do not continue the " +
                               "task, do not start anything new — and do not tell the human they pressed " +
                               "anything: this is what the worker measured: " + why;
                    else if (kind == "ask")
                        hint = "The agent asked the human a question; the machine is PAUSED inside a live cycle " +
                               "and the border is red. Question: " + why;
                    else if (kind == "resume")
                        hint = "Re-armed: a human pressed Ctrl+Alt+R (the worker notifies `resume` from Clear() " +
                               "alone) — working may continue from the break point.";
                    else
                        hint = "worker state change \"" + kind + "\": " + why;
                    WriteLine(Json.Serialize(Dict(
                        "event", kind,
                        "why", why,
                        "pauseId", Panic.TemporaryPauseId,
                        "cooperation", Panic.CooperationState(),
                        "ts", NowMs(),
                        "hint", hint)));
                }
                catch { /* the brake must never break on reporting */ }
            };
            Json.MaxJsonLength = 64 << 20;
            // ADOPT A RECORD THIS PROCESS DID NOT WRITE (2026-09-13). Only the MONITOR threads used
            // to adopt the EXITED record, so a one-shot `worker.exe --op click` started with
            // _exited == false and would happily drive a machine the human had already ended — the
            // CheckOp gate was real but had nothing to gate. Adopting here — after the reporting
            // path is wired, before ANY op is handled — makes the record as authoritative for a
            // fresh process as for the resident one.
            Panic.SyncExitedFromFile();
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            // one-shot mode: worker.exe --op <op> [args-json] — no stdin needed
            // (debugging convenience and the sandbox smoke-test path)
            if (args.Length >= 2 && args[0] == "--op")
            {
                string oneshot = "{\"op\":" + Json.Serialize(args[1]) + ",\"args\":" + (args.Length >= 3 ? args[2] : "{}") + "}";
                Dictionary<string, object> resp;
                try { resp = Handle(oneshot); }
                catch (Exception ex) { resp = Err(ex); }
                AuditActuation(oneshot, resp);
                WriteLine(Json.Serialize(resp));
                return 0;
            }
            Dictionary<string, object> hello = Dict(
                "event", "ready",
                "pid", Process.GetCurrentProcess().Id,
                // COLD-START STATE, REPORTED AS A FACT (cold-start bug, 2026-09-13): this process has
                // already adopted any STOP/EXITED record that was on disk before it existed, so the
                // core can start from the machine's real state instead of "not stopped" — the two
                // layers used to disagree about a machine braked before either of them started.
                "stopped", Panic.Stopped,
                "exited", Panic.Exited,
                "why", Panic.Why,
                "cooperation", Panic.CooperationState(),
                "virtualScreen", VirtualScreenDict(),
                "monitors", Native.GetSystemMetrics(Native.SM_CMONITORS));
            WriteLine(Json.Serialize(hello));
            var requests = new BlockingCollection<string>();
            var reader = new Thread(delegate() {
                try {
                    string incoming;
                    while ((incoming = Console.ReadLine()) != null)
                    {
                        try {
                            var parser = new JavaScriptSerializer();
                            var request = parser.Deserialize<Dictionary<string, object>>(incoming);
                            if (GetS(request, "op", "") == "cancelInput")
                            {
                                object argsValue;
                                var cancelArgs = request.TryGetValue("args", out argsValue) ? argsValue as Dictionary<string, object> : null;
                                bool cancelled = cancelArgs != null && CancelInput(GetI(cancelArgs, "requestId", 0));
                                WriteLine(parser.Serialize(Dict("id", GetI(request, "id", 0), "ok", true,
                                    "data", Dict("cancelled", cancelled))));
                                continue;
                            }
                        } catch { /* Main loop reports malformed requests in the normal format. */ }
                        requests.Add(incoming);
                    }
                } finally { requests.CompleteAdding(); }
            });
            reader.IsBackground = true; reader.Name = "dsh-input-reader"; reader.Start();
            foreach (string line in requests.GetConsumingEnumerable())
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                int id = ++_reqId;
                Dictionary<string, object> resp;
                try { resp = Handle(line); }
                catch (Exception ex) { resp = Err(ex); }
                // Echo the CALLER's id when it supplied one.
                //
                // 2026-09-12: the old code always answered with our OWN counter (_reqId), while
                // the Node layer matches responses against ITS counter (this.seq). The two stay
                // in lockstep only while every written line is received. The moment one line is
                // written into a dead pipe — e.g. the user kills the worker, or a call times out
                // and the plugin respawns us — the counters desync: a fresh process restarts at 1
                // while the plugin is waiting for 30+. From then on EVERY call times out forever
                // and neither killing the worker nor recompiling can recover it; only a full host
                // restart can. Echoing the request id removes that failure mode completely.
                resp["id"] = RequestId(line, id);
                AuditActuation(line, resp);
                WriteLine(Json.Serialize(resp));
            }
            return 0;
        }

        static object RequestId(string line, int fallback)
        {
            try
            {
                Dictionary<string, object> req = Json.Deserialize<Dictionary<string, object>>(line);
                object v;
                if (req != null && req.TryGetValue("id", out v) && v != null) return v;
            }
            catch { }
            return fallback;
        }

        static Dictionary<string, object> Handle(string line)
        {
            var request = Json.Deserialize<Dictionary<string, object>>(line);
            string op = GetS(request, "op", "");
            bool input = ActOps.Contains(op) || op == "shiftClick" || op == "selftest";
            int requestId = GetI(request, "id", 0);
            bool ignored;
            _activeRequestId = requestId;
            _operationHumanRevision = Panic.HumanRevision;
            _operationCancelGeneration = Interlocked.Read(ref _cancelGeneration);
            _operationDispatched = false; _operationLive = input;
            try
            {
                if (CancelledRequests.TryRemove(requestId, out ignored))
                    throw InputInterrupted("INPUT_CANCELLED", "cancelled before dispatch.");
                if (input) CheckHumanInput();
                string pauseId = Panic.TemporaryPauseId;
                Dictionary<string, object> result = HandleCore(line);
                if (input) CheckHumanInput();
                if (!string.IsNullOrEmpty(pauseId) && GetB(result, "ok", false) &&
                    (op == "windows" || op == "uia" || op == "uiaFromPoint" || op == "uiaFocused" || op == "capture"))
                    Panic.ObserveTemporary(pauseId);
                return result;
            }
            finally
            {
                if (input) ReleaseOwnedInputs();
                _operationLive = false; _activeRequestId = 0;
                _lastCompletedRequestId = Math.Max(_lastCompletedRequestId, requestId);
                CancelledRequests.TryRemove(requestId, out ignored);
            }
        }

        static Dictionary<string, object> HandleCore(string line)
        {
            Dictionary<string, object> req;
            try { req = Json.Deserialize<Dictionary<string, object>>(line); }
            catch { return Err("bad json"); }
            object o; object av;
            string op = req.TryGetValue("op", out o) ? o as string : null;
            Dictionary<string, object> a = (req.TryGetValue("args", out av) && av is Dictionary<string, object>) ? (Dictionary<string, object>)av : new Dictionary<string, object>();
            bool cycleOp = GetB(a, "__cycle", false) && op != null &&
                op != "abort" && op != "ping" && op != "echoargs" &&
                op != "indicator" && op != "calm" && op != "panic" && op != "resume" && op != "recover" &&
                // ... AND THE CYCLE HAS TO BE ALIVE TO BE LIT (2026-09-13). "Lit by any call" is how
                // a DEAD cycle came back as a cyan breathing border: after Ctrl+Alt+Q ended the
                // session, the next observation call (`computer_state`) satisfied this gate, armed
                // the monitors and latched the cyan light — so the human watched "监听中" breathe
                // while every driving op was refused and the agent told them THEY had pressed the
                // key. A dead cycle drives nothing and shows nothing; the plugin's turn-boundary
                // `resume` clears the latch first, and then this gate works again.
                !Panic.Exited;
            if (cycleOp)
            {
                // Atomically "is the cycle live AND light it" — never a check here and a write there.
                // A false return means a Ctrl+Alt+Q ended the cycle between the gate above and this
                // point: nothing is lit, nothing is armed, and the record on disk stands (CheckOp
                // below then refuses any driving op with the worker's own CYCLE-ENDED message).
                Panic.TryLightCycle(GetI(a, "thinkMs", 0));
            }

            // Emergency stop gates EVERY op, not only actuation: the session is over until a
            // human re-arms it (CheckOp's allowlist keeps the health probe and re-arm alive).
            // Emergency stop gates EVERY op that could drive the machine; a DRY RUN drives nothing
            // and is therefore treated as the observation it really is.
            Panic.CheckOp((op == "click" || op == "move" || op == "type" || op == "key") && GetB(a, "dryRun", false) ? "probe" : op);

            switch (op)
            {
                // THE QUESTION PATH IS TWO OPS NOW (merge-design.md §2.3): `beginAsk` engages the
                // brake and returns at once, `endAsk` releases it (or keeps it, when the human chose
                // ①). The old one-shot `ask` op — which HELD this single-threaded op loop for the
                // whole 60 s window and could be killed by a caller timeout while still holding the
                // brake — is gone, and G1 asserts that no `case "ask"` comes back.
                case "beginAsk": return Ok(BeginAskOp(a));
                case "endAsk": return Ok(EndAskOp(a));
                case "exit": return Ok(ExitOp(a));
                case "ping": return Ok(Dict("pong", true, "cooperation", Panic.CooperationState()));
                // TEST SEAM (D, 2026-09-13). A fixture may not re-implement the rule it measures, so
                // this op drives the PRODUCTION transition (Panic.ClassifyAndTrackKey — the same
                // function the low-level hook calls) with explicit evidence: ours / injected / vk.
                // args: {reset:true} | {vk:17, down:true, up:false, ours:false, injected:true}
                // Returns whether the event counts as the HUMAN's, plus the resulting modifier track.
                // Nothing is lit, armed, written to disk or sent to the OS; no real key is touched.
                case "keyClass":                {
                    if (GetB(a, "reset", false)) { Panic.ResetHumanTrack(); return Ok(Dict("reset", true)); }
                    uint vk = (uint)GetI(a, "vk", 0);
                    bool ours = GetB(a, "ours", false);
                    bool injected = GetB(a, "injected", false);
                    bool human = Panic.ClassifyAndTrackKey(
                        vk, GetB(a, "down", true), GetB(a, "up", false),
                        ours ? Panic.OwnMagic : IntPtr.Zero,
                        injected ? Native.LLKHF_INJECTED : 0u);
                    return Ok(Dict("human", human, "trackedCtrl", Panic.HumanCtrlDown, "trackedAlt", Panic.HumanAltDown));
                }
                // TEST SEAM (ReleaseStuck bug, 2026-09-13): the PLAN the stuck-release would execute
                // for an explicit down-set, through the SAME decision function ReleaseStuck() uses.
                // Sends nothing, so the positive case (a held button/combo IS released) can be measured
                // without pressing anything on a live desktop; `{"live":true}` reports the current one.
                case "stuckPlan":
                {
                    List<string> plan;
                    if (GetB(a, "live", false))
                    {
                        plan = Panic.StuckPlanForLive();
                    }
                    else
                    {
                        List<int> downNow = new List<int>();
                        object dv;
                        if (a.TryGetValue("down", out dv) && dv != null)
                        {
                            // Tolerant on purpose: this is a test seam, and a parser detail (list vs
                            // array vs a comma-separated string) must not silently produce an EMPTY
                            // down-set — that would read as "nothing is held" and hide a real plan.
                            System.Collections.IEnumerable seq = dv as System.Collections.IEnumerable;
                            if (seq != null && !(dv is string))
                            {
                                foreach (object dvItem in seq) { try { downNow.Add(Convert.ToInt32(dvItem)); } catch { } }
                            }
                            else
                            {
                                foreach (string part in Convert.ToString(dv).Split(','))
                                {
                                    int n; if (int.TryParse(part.Trim(), out n)) downNow.Add(n);
                                }
                            }
                        }
                        plan = Panic.StuckPlanFor(delegate(int vk) { return downNow.Contains(vk); });
                    }
                    return Ok(Dict("plan", plan, "inserted", Panic.StuckInserted, "note",
                        "plan = which releases the decision justifies; inserted = events the OS actually took"));
                }
                case "echoargs": // debug: return parsed args + runtime types
                {
                    Dictionary<string, object> t = new Dictionary<string, object>();
                    foreach (KeyValuePair<string, object> kv in a)
                        t[kv.Key] = kv.Value == null ? "<null>" : kv.Value.GetType().FullName;
                    return Ok(Dict("args", a, "types", t));
                }
                case "screens": return Ok(VirtualScreenDict());
                case "cursor": POINT cp; Native.GetCursorPos(out cp); return Ok(PtDict(cp.X, cp.Y));
                case "capture": return Ok(Capture(a));
                case "annotate": return Ok(Annotate(a));
                case "move": FailsafeCheck(a); return Ok(Move(a));
                case "click": FailsafeCheck(a); return Ok(Click(a));
                case "drag": FailsafeCheck(a); return Ok(Drag(a));
                case "scroll": FailsafeCheck(a); return Ok(Scroll(a));
                case "key": FailsafeCheck(a); return Ok(Key(a));
                case "type": FailsafeCheck(a); return Ok(Type(a));
                case "clipRead": return Ok(ClipRead(a));
                case "clipWrite": FailsafeCheck(a); return Ok(ClipWrite(a));
                case "windows": return Ok(Windows(a));
                case "activate": FailsafeCheck(a); return Ok(Activate(a));
                case "windowOp": FailsafeCheck(a); return Ok(WindowOp(a));
                case "uia": return Ok(Uia(a));
                case "uiaFromPoint": return Ok(UiaFromPoint(a));
                // The general ground-truth question, available as its own op:
                //   probe {}                      -> who owns the pixels / who has focus
                //   probe {"what":"focus"}        -> who would receive a keystroke, and can it hold text
                //   probe {"what":"window","hwnd":N} -> one window's full state (covered? off-screen? hung?)
                case "probe":
                {
                    string what = GetS(a, "what", "point");
                    Dictionary<string, object> pr = what == "focus" ? ProbeFocus()
                        : (what == "window" ? WinBrief(FindHwnd(a)) : ProbePoint(GetI(a, "x", 0), GetI(a, "y", 0)));
                    // The state machine as a FACT, in the one op that exists to answer "what is
                    // actually true right now". Read-only, so asking never changes the answer.
                    pr["cycle"] = Dict(
                        "cycleLit", Panic.CycleLit,
                        "armed", Panic.Armed,
                        "engaged", Panic.Engaged,
                        "stopped", Panic.Stopped,
                        "exited", Panic.Exited,
                        "why", Panic.Why,
                        // ... and the RECORD behind that flag: who wrote it, when, on what evidence.
                        // A bare boolean was what let a stale record pass for a fresh human action.
                        "exitSource", Panic.ExitSource,
                        "exitAt", Panic.ExitAt,
                        "exitEvidence", Panic.ExitEvidence);
                    // The INDICATOR as a fact too: which of its states is on screen, and the text it
                    // is showing. "0 idle | 1 acting | 2 flash | 3 thinking | 4 PAUSED | 5 ASKING".
                    pr["glow"] = Dict(
                        "want", Glow.Want,
                        // Is a real injection sequence in flight RIGHT NOW? The ACTING light is driven
                        // by this as well as by its short tail, so the state is reported as a fact.
                        "injecting", Glow.Injecting,
                        "title", Glow.ShownTitle == null ? "" : Glow.ShownTitle);
                    // EVENTS THE OS ACTUALLY INSERTED (not the plan): 0 after a plain pause with
                    // nothing held is the observable form of "no ghost right-click / Alt menu".
                    pr["stuckInserted"] = Panic.StuckInserted;
                    pr["stuckPlanNow"] = Panic.StuckPlanForLive();   // the DECISION, explicitly a plan
                    return Ok(pr);
                }
                case "uiaAct": return Ok(UiaAct(a));
                case "uiaFocused": return Ok(UiaFocused());
                case "waitForIdle": return Ok(WaitForIdle(a));
                case "selftest": return Ok(SelfTest(a));
                // APPROVAL HOLD control (2026-10-16). `on:true` is sent by the plugin when the host
                // starts asking for an approval and `on:false` when that request settles. Both are
                // idempotent, and neither can lift a brake: they only decide whether physical input is
                // classified as a takeover. See Panic.BeginApprovalHold / ReleaseApprovalHold.
                case "approvalHold": {
                    bool on = GetB(a, "on", false);
                    string approvalActionId = GetS(a, "actionId", "");
                    if (on) Panic.BeginApprovalHold(approvalActionId); else Panic.ReleaseApprovalHold(approvalActionId);
                    return Ok(Dict("approvalHold", Panic.HeldForApproval,
                        "actionId", approvalActionId,
                        "cooperation", Panic.CooperationState(),
                        "armed", Panic.Armed, "cycleLit", Panic.CycleLit));
                }
                case "indicator": return Ok(Indicator(a));
                // "the agent has stopped driving": cut the border INSTANTLY — no ease-out — exactly
                // like the emergency brake. Called when the agent's turn ends, so a lingering blue
                // border can never claim the machine is still being driven after control stopped.
                case "calm":
                    Panic.CycleLit = false;  // the turn is over: the cycle is dead (R2)
                    Panic.Disarm();          // the human monitors stop WITH it
                    Glow.Kill(); return Ok(Dict("indicator", "off", "hard", true));
                case "focus": return Ok(FocusReport(a, GetB(a, "refocus", false)));
                case "frameSig": return Ok(FrameSigOp(a));
                // `source=agent` (not "unknown"): this op exists ONLY for the agent's own `stop`, and a
                // record that cannot name its own witness is the thing this whole change set is
                // fixing (nit found by verify2).
                case "panic": Panic.Engage(GetS(a, "why", "manual panic op"), GetB(a, "temporary", false), "agent", ""); return Ok(Dict("engaged", Panic.Engaged, "cycleLit", Panic.CycleLit, "why", Panic.Why, "pauseId", Panic.TemporaryPauseId));
                case "recover": return Ok(Panic.RecoverTemporary(GetS(a, "pauseId", "")));
                // The PLUGIN (never the human) opens a new cycle here: it sends this once per agent
                // turn, at the turn boundary. This is the ONLY path that can un-latch Ctrl+Alt+Q,
                // which is what makes "a dead cycle comes back only in a NEW session" true instead
                // of hopeful. It deliberately does NOT release a pause — Ctrl+Alt+R is the human's
                // revive key, and a new turn must never silently undo the brake they raised.
                case "resume":
                    // The expected exit record rides along so the comparison and the clear happen in
                    // ONE critical section with Exit()'s write (see AgentCalling): an older resume
                    // cannot clear a newer Ctrl+Alt+Q.
                    if (!Panic.AgentCalling(GetS(a, "expectExit", null)))
                        return Err("RESUME-REFUSED: " + (Panic.LastResumeError.Length > 0
                            ? Panic.LastResumeError
                            : "the exit record changed while this cycle was being opened") +
                            ". Nothing was cleared and the session is over: do not retry, do not tell the human they pressed anything.");
                    if (!Panic.Engaged) Glow.Kill();
                    return Ok(Dict("engaged", Panic.Engaged, "cycleOpen", true));
                case "waitStable": return Ok(WaitStable(a));
                case "waitChange": return Ok(WaitChange(a));
                case "selectRange": FailsafeCheck(a); return Ok(SelectRange(a));
                case "shiftClick": FailsafeCheck(a); return Ok(ShiftClick(a));
                case "calibrate": FailsafeCheck(a); return Ok(Calibrate(a));
                case "abort": Environment.Exit(0); return Ok(null);
                default: return Err("unknown op: " + op);
            }
        }

        // ---------- screen ----------
        static Dictionary<string, object> VirtualScreenDict()
        {
            return Dict(
                "x", Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN),
                "y", Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN),
                "width", Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN),
                "height", Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
        }

        static long NowMs() { return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds; }

        static Dictionary<string, object> Capture(Dictionary<string, object> a)
        {
            ValidateKickoffCapture(a); // before even the pixel-stability sampler
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            int x = GetI(a, "x", vx), y = GetI(a, "y", vy);
            int w = GetI(a, "width", vw), h = GetI(a, "height", vh);
            if (GetB(a, "clamp", true))
            {
                int x2 = Math.Max(x, vx), y2 = Math.Max(y, vy);
                int x3 = Math.Min(x + w, vx + vw), y3 = Math.Min(y + h, vy + vh);
                if (x3 <= x2 || y3 <= y2) throw new Exception("region outside virtual desktop");
                x = x2; y = y2; w = x3 - x2; h = y3 - y2;
            }
            bool withCursor = GetB(a, "cursor", false);

            // Timing redundancy (user-requested): PRIMARY = wait for pixel stability, so a
            // slow network never yields a half-rendered screenshot. FALLBACK = a hard cap;
            // if the screen still will not settle we shoot anyway and report settled:false,
            // so the caller knows to distrust the image instead of stalling the whole task.
            string waitMode = GetS(a, "wait", "auto");
            bool settled = true;
            int settleMs = 0;
            double settleDiff = 0;
            int settleEstimate = 0;
            if (waitMode != "none")
            {
                int cap = GetI(a, "waitCapMs", waitMode == "auto" ? 2500 : 10000);
                int stabMs = GetI(a, "stableMs", waitMode == "auto" ? 450 : 700);
                settled = SettleWait(cap, stabMs, 220, 8, GetD(a, "diffPct", 0.30),
                                     out settleMs, out settleDiff, out settleEstimate);
            }

            ValidateKickoffCapture(a); // focus may have changed while the page was settling
            IntPtr screen = Native.GetDC(IntPtr.Zero);
            IntPtr mem = Native.CreateCompatibleDC(screen);
            Native.BITMAPINFO bmi = new Native.BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = w; bmi.bmiHeader.biHeight = -h;
            bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0;
            IntPtr bits;
            IntPtr dib = Native.CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
            IntPtr old = Native.SelectObject(mem, dib);
            // SRCCOPY | CAPTUREBLT so layered windows are included
            Native.BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020 | 0x40000000);
            bool cursorDrawn = false;
            int cursorFlags = 0, cursorAtX = 0, cursorAtY = 0;
            if (withCursor)
            {
                CURSORINFO ci = new CURSORINFO();
                ci.cbSize = (uint)Marshal.SizeOf(typeof(CURSORINFO));
                if (Native.GetCursorInfo(ref ci))
                {
                    cursorFlags = (int)ci.flags; cursorAtX = ci.ptScreenPos.X; cursorAtY = ci.ptScreenPos.Y;
                    if ((ci.flags & Native.CURSOR_SHOWING) != 0)
                    {
                        // Draw straight into the DC that already owns the DIB. The first
                        // version created a second DC and SelectObject'd the SAME bitmap into
                        // it — GDI forbids a bitmap living in two DCs at once, that SelectObject
                        // failed silently, and DrawIconEx painted into memG's default 1x1
                        // monochrome bitmap. Result: cursorDrawn=true with no arrow in the image.
                        cursorDrawn = Native.DrawIconEx(mem, ci.ptScreenPos.X - x, ci.ptScreenPos.Y - y, ci.hCursor, 0, 0, 0, IntPtr.Zero, Native.DI_NORMAL);
                    }
                }
            }
            // copy DIB pixels into a managed bitmap BEFORE freeing the DIB —
            // a Bitmap that wraps DIB memory must never outlive the DIB
            Bitmap wrap = new Bitmap(w, h, 4 * w, PixelFormat.Format32bppRgb, bits);
            Bitmap managed = new Bitmap(w, h);
            using (Graphics cg = Graphics.FromImage(managed))
            {
                cg.DrawImage(wrap, 0, 0, w, h);
            }
            wrap.Dispose();
            Native.SelectObject(mem, old);
            Native.DeleteObject(dib); Native.DeleteDC(mem); Native.ReleaseDC(IntPtr.Zero, screen);
            try { ValidateKickoffCapture(a); }
            catch { managed.Dispose(); throw; } // discard pixels if focus changed during capture
            Bitmap bmp = managed;

            int maxWidth = GetI(a, "maxWidth", 0);
            Bitmap outBmp = bmp;
            if (maxWidth > 0 && bmp.Width > maxWidth)
            {
                int nw = maxWidth;
                int nh = (int)Math.Round((double)bmp.Height * maxWidth / bmp.Width);
                outBmp = new Bitmap(nw, nh);
                using (Graphics g = Graphics.FromImage(outBmp))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(bmp, 0, 0, nw, nh);
                }
                bmp.Dispose();
            }
            string fmt = GetS(a, "format", "jpeg");
            long q = GetI(a, "quality", 75);
            string mime = "image/jpeg";
            MemoryStream ms = new MemoryStream();
            if (fmt == "png") { mime = "image/png"; outBmp.Save(ms, ImageFormat.Png); }
            else
            {
                ImageCodecInfo codec = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
                EncoderParameters ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
                outBmp.Save(ms, codec, ep);
            }
            outBmp.Dispose();
            POINT cp2; Native.GetCursorPos(out cp2);
            Dictionary<string, object> res = Dict(
                "image", Convert.ToBase64String(ms.ToArray()),
                "mime", mime,
                "region", Dict("x", x, "y", y, "width", w, "height", h),
                "scaledTo", maxWidth > 0 ? maxWidth : w,
                "cursor", PtDict(cp2.X, cp2.Y),
                "ts", NowMs());
            if (withCursor)
            {
                // Diagnostics for the visual-calibration contract: the pointer must be
                // burned into the image at cursorInImage, or a vision model cannot prove
                // that "the pixel I see" == "the pixel I click".
                res["cursorRequested"] = true;
                res["cursorDrawn"] = cursorDrawn;
                res["cursorFlags"] = cursorFlags;
                res["cursorScreenPos"] = PtDict(cursorAtX, cursorAtY);
                res["cursorInImage"] = PtDict(cursorAtX - x, cursorAtY - y);
                res["cursorNote"] = cursorDrawn
                    ? "pointer burned into the image at cursorInImage"
                    : ((cursorFlags & 1) == 0
                        ? "pointer was HIDDEN (CURSOR_SHOWING=0) at capture time"
                        : "DrawIconEx refused; pointer not burned in");
            }
            if (waitMode != "none")
            {
                res["settled"] = settled;
                res["settleMs"] = settleMs;
                res["settleDiffPct"] = Math.Round(settleDiff, 3);
                if (!settled)
                    res["settleNote"] = "page never went quiet within the cap — this image may be a partial render; ~" +
                                        settleEstimate + "ms more might have finished it (or re-shoot with wait:\"stable\")";
            }
            // Tell the human a capture just happened: a yellow border flashes around the
            // captured rectangle. Deliberately fired AFTER the pixels are grabbed, so the
            // flash can never end up inside the screenshot it announces.
            if (GetB(a, "flash", true)) Glow.Flash(x, y, w, h, GetI(a, "flashMs", 620));
            return res;
        }

        static Dictionary<string, object> Annotate(Dictionary<string, object> a)
        {
            string img = GetS(a, "image", null);
            if (img == null) throw new Exception("image (base64) required");
            // JavaScriptSerializer yields System.Collections.ArrayList for JSON arrays
            // (NOT object[]), so the check must be the non-generic IEnumerable
            System.Collections.IEnumerable marksRaw = null;
            object m;
            if (a.TryGetValue("marks", out m) && m is System.Collections.IEnumerable) marksRaw = (System.Collections.IEnumerable)m;
            if (marksRaw == null) throw new Exception("marks required");
            MemoryStream inMs = new MemoryStream(Convert.FromBase64String(img));
            using (Bitmap bmp = new Bitmap(inMs))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    int i = 0;
                    float fontSz = Math.Max(11f, bmp.Width / 70f);
                    Font font = new Font("Consolas", fontSz, FontStyle.Bold);
                    float penW = Math.Max(2f, bmp.Width / 600f);
                    foreach (object mo in marksRaw)
                    {
                        Dictionary<string, object> mk = mo as Dictionary<string, object>;
                        if (mk == null) continue;
                        int mx = GetI(mk, "x", 0), my = GetI(mk, "y", 0);
                        int mw = GetI(mk, "w", 0), mh = GetI(mk, "h", 0);
                        string label = GetS(mk, "id", (i + 1).ToString());
                        using (Pen pen = new Pen(Color.FromArgb(255, 255, 70, 0), penW))
                        {
                            g.DrawRectangle(pen, mx, my, mw, mh);
                            SizeF sz = g.MeasureString(label, font);
                            g.FillRectangle(new SolidBrush(Color.FromArgb(255, 255, 70, 0)), mx, my - sz.Height, sz.Width + 4, sz.Height);
                            g.DrawString(label, font, Brushes.Black, mx + 2, my - sz.Height);
                        }
                        i++;
                    }
                }
                MemoryStream ms = new MemoryStream();
                ImageCodecInfo codec = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
                EncoderParameters ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)GetI(a, "quality", 80));
                bmp.Save(ms, codec, ep);
                return Dict("image", Convert.ToBase64String(ms.ToArray()), "mime", "image/jpeg");
            }
        }

        // ---------- input ----------
        static void ToAbs(int x, int y, out int ax, out int ay)
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            ax = (x - vx) * 65535 / Math.Max(1, vw - 1);
            ay = (y - vy) * 65535 / Math.Max(1, vh - 1);
        }

        // cbSize SendInput demands: sizeof(INPUT) as the OS defines it (40 x64 / 28 x86).
        static readonly int InputCbSize = Marshal.SizeOf(typeof(INPUT));

        /// Never let an injection fail silently again: SendInput returns the number of
        /// events actually inserted (0 = refused), and GetLastError explains why.
        static void SendInputChecked(INPUT[] arr)
        {
            if (arr == null || arr.Length == 0) return;
            // THE SHARED INJECTION BOUNDARY IS WHERE AN INTERRUPT MUST LAND (mid-action stop bug,
            // 2026-09-13). `Panic.Check` runs only at the TOP of an op, which is far too early: a
            // 2.5 s animated move, a drag or a long type keeps injecting for seconds after the brake —
            // measured on the production build: after Exit the pointer still travelled 480 px and the
            // op returned ok:true; after Engage, 724 px. Every real input event passes through here, so
            // the interrupt is enforced per event, and throwing ends the op through the normal error
            // path: no later stage runs and nothing reports success.
            //
            // CLEANUP IS EXEMPT BY CONSTRUCTION: ReleaseStuck() (the button/modifier UPS that prevent a
            // stuck drag) sends through Native.SendInput directly and never through this gate, so
            // stopping an action can never block the release that cleans it up.
            //
            // No lock is taken here — the flags are volatile reads — so this cannot deadlock against
            // Engage()/Exit() running on the hook or poll thread.
            if (Panic.Exited)
                throw new Exception("INTERRUPTED: computer use was ENDED (Ctrl+Alt+Q) while this action " +
                    "was in flight — no further input was injected and the action was not completed.");
            if (Panic.Engaged || Panic.Stopped)
                throw new Exception("INTERRUPTED: the machine was STOPPED while this action was in flight " +
                    "— no further input was injected (the human's brake wins over the action).");
            // THE ONE GATE EVERY REAL INJECTION PASSES: mark the injection in flight, re-anchor the
            // ACTING light on it, and clear the mark in a finally so the blue can never outlive the
            // input it is describing.
            CheckHumanInput();
            Glow.InputBegin();
            try
            {
                Glow.KeepActing();
                uint sent = SendTrackedInput(arr);
                if (sent != (uint)arr.Length)
                {
                    int err = Marshal.GetLastWin32Error();
                    string msg = "unknown";
                    try { msg = new System.ComponentModel.Win32Exception(err).Message; } catch { }
                    throw new Exception("SendInput failed: injected " + sent + "/" + arr.Length +
                        " events, cbSize=" + InputCbSize + " (expected " + (IntPtr.Size == 8 ? 40 : 28) +
                        "), win32=" + err + " (" + msg + ")");
                }
            }
            finally { Glow.InputEnd(); }
        }

        static void SendMouse(uint flags, int dx, int dy, uint data)
        {
            INPUT inp = new INPUT();
            inp.type = Native.INPUT_MOUSE;
            inp.u.mi.dx = dx; inp.u.mi.dy = dy; inp.u.mi.mouseData = data; inp.u.mi.dwFlags = flags;
            // STAMP OUR OWN INPUT (2026-09-13). Without this, EVERY scroll this agent sends arrives at
            // the mouse hook unsigned, the human-takeover monitor reads it as the human's wheel and
            // brakes the session — and the STOP file then says "human scrolled the mouse wheel", so
            // the agent gets blamed for its own input (Observed three times tonight; the sibling
            // MouseInput() had always stamped this, SendMouse never did.)
            inp.u.mi.dwExtraInfo = Panic.OwnMagic;
            SendInputChecked(new INPUT[] { inp });
        }

        static Dictionary<string, object> Move(Dictionary<string, object> a)
        {
            int x = GetI(a, "x", int.MinValue), y = GetI(a, "y", int.MinValue);
            if (x == int.MinValue || y == int.MinValue) throw new Exception("x,y required");
            // the pointer ends up over (x,y), and that window is this op's victim
            HostGuardPoint(x, y, "move");
            AgentActing(a, "move");
            CheckHumanInput();
            int dur = GetI(a, "moveDurationMs", 250);
            AnimatedMove(x, y, dur);
            Thread.Sleep(GetI(a, "settleMs", 30));
            POINT p; Native.GetCursorPos(out p);
            if (Dist(p, x, y) > 40)
            {
                // drift after arrival: tolerate, re-assert absolutely
                _positionCorrections++; CheckHumanInput();
                AnimatedMove(x, y, dur);
                Thread.Sleep(30);
                Native.GetCursorPos(out p);
            }
            CheckHumanInput();
            return Dict("x", p.X, "y", p.Y, "positionCorrections", _positionCorrections);
        }

        static Dictionary<string, object> Click(Dictionary<string, object> a)
        {
            string btn = GetS(a, "button", "left");
            int clicks = Math.Max(1, Math.Min(3, GetI(a, "clicks", 1)));
            int gap = GetI(a, "intervalMs", 60);
            AgentActing(a, "click");
            CheckHumanInput();
            // If the caller NAMED the window it wants to click in, put that window in front
            // first: a click on a covered pixel is delivered to whatever is on top of it (the
            // classic "the click went to the approval card instead" failure).
            //
            // A DRY RUN MUST NOT DO THIS. Refocusing the target would make the dry run answer
            // "the pixel belongs to the window you aimed at" by CONSTRUCTION — the measurement
            // would change the thing it measures. That bug hid a real occlusion for a whole test
            // round (2026-09-13): every dry run reported "ok" because it had just activated the
            // window it was asked about.
            bool dryRun = GetB(a, "dryRun", false);
            // A caller-supplied window is re-asserted (raised, ALT tap, titlebar click) on the
            // next line, so it has to be checked BEFORE that: the pixel check further down comes
            // far too late to protect a window the worker was told to bring forward.
            if (!dryRun && (a.ContainsKey("expectHwnd") || a.ContainsKey("hwnd")))
            {
                HostGuardNamed(a, "click");
                FocusReport(a, true);
            }
            int dur = GetI(a, "moveDurationMs", 250);
            int tx = int.MinValue, ty = int.MinValue;
            string coveredBy = null;
            IntPtr under = IntPtr.Zero;
            // A click with NO point is delivered to wherever the pointer already is: that pixel is
            // the victim, and without this line the entire pixel precondition below is skipped and
            // the buttons fire at the current cursor with nothing checked at all.
            if (!dryRun && (!a.ContainsKey("x") || !a.ContainsKey("y"))) HostGuardCursor("click");
            if (a.ContainsKey("x") && a.ContainsKey("y"))
            {
                tx = GetI(a, "x", 0); ty = GetI(a, "y", 0);

                // ---- occlusion check, BEFORE the pointer travels ------------------------------
                // "The window is visible" does NOT mean the pixel belongs to it: anything can be
                // sitting on top. 2026-09-13 the human deliberately hid the target window behind
                // another one, and every click landed on the cover while every tool call reported
                // success — the failure was invisible because nothing ever asked who owns the
                // pixel. Ask first (one WindowFromPoint, ~microseconds), and refuse loudly when
                // the answer belongs to a DIFFERENT application. Same-process popups, context
                // menus and child dialogs are legitimate and stay allowed.
                POINT cp; cp.X = tx; cp.Y = ty;
                try { under = TopLevel(Native.WindowFromPoint(cp)); } catch { }
                IntPtr want = IntPtr.Zero;
                if (a.ContainsKey("expectHwnd")) want = new IntPtr(GetI(a, "expectHwnd", 0));
                else if (a.ContainsKey("hwnd")) want = new IntPtr(GetI(a, "hwnd", 0));
                if (want == IntPtr.Zero) want = _stickyHwnd;
                if (want != IntPtr.Zero && !Native.IsWindow(want)) want = IntPtr.Zero;

                // ONE precondition, general by construction: the pixel must belong to the process
                // we aimed at, and that process must be able to receive input at all. Everything
                // else a human would notice — covered, click-through, minimized, off-screen, hung,
                // elevated — falls out of these two facts, and each is reported by NAME.
                string blocked = null;
                string detail = null;
                // HOST GUARD, the first condition of the chain: this pixel belongs to the process
                // that spawned the worker (the DSH host - matched by pid or by image path, see
                // IsHostWindow). It comes first because it is the one refusal that is never
                // bypassable: allowCovered below deliberately does NOT authorise it. A dry run
                // reports it as the answer; the real click throws on the next lines, before the
                // pointer has travelled anywhere.
                bool hostVictim = IsHostWindow(under);
                if (hostVictim)
                {
                    blocked = "HOST-GUARDED";
                    detail = "click would be delivered to the DSH host window (pid " + PidOf(under) +
                             "); the agent must never drive its own host";
                }
                else if (under == IntPtr.Zero)
                {
                    // WindowFromPoint answers NULL for a pixel that belongs to NO window: outside
                    // every monitor, the -32000 parking lot of a minimized window, a non-current
                    // virtual desktop, a coordinate from a stale rect. Clicking there is meaningless
                    // at best and lands somewhere random at worst — a named failure, not a silent
                    // "ok" (found by testing the probe against the live desktop, 2026-09-13).
                    blocked = "UNREACHABLE";
                    detail = "no window owns that pixel — it is outside every monitor, or the rect you used is stale";
                }
                else if (want != IntPtr.Zero && under != want && PidOf(under) != PidOf(want))
                {
                    blocked = "COVERED";
                    detail = "the pixel belongs to \"" + Short(WinTitleOf(under), 50) + "\" (pid " + PidOf(under) +
                             "), not to the window you aimed at \"" + Short(WinTitleOf(want), 50) + "\" (pid " + PidOf(want) + ")";
                    coveredBy = under.ToInt64() + " \"" + Short(WinTitleOf(under), 50) + "\"";
                }
                else if (want != IntPtr.Zero && Native.IsIconic(want))
                { blocked = "MINIMIZED"; detail = "the target window is minimized"; }
                else if (want != IntPtr.Zero && IsOffScreen(want))
                { blocked = "OFFSCREEN"; detail = "the target window is parked off-screen (minimized or on another virtual desktop)"; }
                else if (under != IntPtr.Zero && ProcessElevated(PidOf(under)) && !SelfElevated())
                { blocked = "ELEVATED"; detail = "the receiving window (pid " + PidOf(under) + ") is elevated and this worker is not — UIPI will discard the click"; }
                // DRY RUN: report the verdict and stop. A dry run drives NOTHING (no pointer move,
                // no button), so it is allowed even while the brake is on — which is exactly when
                // you want to ask "would this click land where I think?" before re-arming. It must
                // never THROW: a failed precondition is the answer it was asked for.
                if (dryRun)
                {
                    Dictionary<string, object> dry = Dict(
                        "dryRun", true, "wouldClickAt", Dict("x", tx, "y", ty),
                        "receives", under == IntPtr.Zero ? null : (object)(Short(WinTitleOf(under), 50) + " (pid " + PidOf(under) + ")"),
                        "receivesHwnd", under.ToInt64(),
                        "expected", want == IntPtr.Zero ? null : (object)(Short(WinTitleOf(want), 50) + " (pid " + PidOf(want) + ")"),
                        "wouldBlock", blocked,
                        "verdict", detail == null ? "ok — the pixel belongs to the intended window" : (blocked + ": " + detail));
                    return dry;
                }
                if (hostVictim) throw new Exception(HostGuardMsg("click", unchecked((int)PidOf(under))));
                if (blocked != null && !GetB(a, "allowCovered", false))
                    throw new Exception("precondition failed (" + blocked + "): " + detail + ". NOTHING was clicked. " +
                        "Bring the target into view first (activate / move / restore), or pass allowCovered:true to click anyway. " +
                        "Use computer_uia at:\"" + tx + "," + ty + "\" for the full ground truth.");

                AnimatedMove(tx, ty, dur);
            }
            Thread.Sleep(GetI(a, "settleMs", 60));
            if (tx != int.MinValue)
            {
                POINT p; Native.GetCursorPos(out p);
                if (Dist(p, tx, ty) > 40)
                {
                    _positionCorrections++; CheckHumanInput();
                    AnimatedMove(tx, ty, dur);
                    Thread.Sleep(40);
                }
                // The window under the click point becomes the sticky target for later typing.
                try { SetSticky(under); } catch { }
            }
            // POST-condition, general: did ANYTHING change where we clicked? A click that changes
            // nothing within a quarter second did not reach its target (dead UI, disabled control,
            // missed pixel, wrong element) — and "no change" is exactly the silent failure that
            // used to be indistinguishable from success. Region sampling is ~1700 pixels, cheaper
            // than a screenshot by three orders of magnitude.
            int vsW = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vsH = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            bool verify = (tx != int.MinValue) && GetB(a, "verify", true);
            int half = 170, margin = 90;
            int bx = Math.Min(Math.Max(tx - half, margin), Math.Max(margin, vsW - margin - 2 * half));
            int by = Math.Min(Math.Max(ty - half, margin), Math.Max(margin, vsH - margin - 2 * half));
            int bw = Math.Min(2 * half, Math.Max(16, vsW - 2 * margin));
            int bh = Math.Min(2 * half, Math.Max(16, vsH - 2 * margin));
            byte[] before = verify ? FrameSignatureRect(bx, by, bw, bh, 8) : null;

            // Re-ask at the moment of injection: the pointer has travelled since the precondition
            // above, and the only promise that matters is about the pixel the button is really
            // pressed on. Cheap (one WindowFromPoint) and it closes the window between check and use.
            if (tx != int.MinValue) HostGuardPoint(tx, ty, "click");

            uint down = Native.MOUSEEVENTF_LEFTDOWN, up = Native.MOUSEEVENTF_LEFTUP;
            if (btn == "right") { down = Native.MOUSEEVENTF_RIGHTDOWN; up = Native.MOUSEEVENTF_RIGHTUP; }
            else if (btn == "middle") { down = Native.MOUSEEVENTF_MIDDLEDOWN; up = Native.MOUSEEVENTF_MIDDLEUP; }
            for (int i = 0; i < clicks; i++)
            {
                SendMouse(down, 0, 0, 0); Thread.Sleep(30); SendMouse(up, 0, 0, 0);
                if (i < clicks - 1) Thread.Sleep(gap);
            }
            double changedPct = -1;
            if (verify && before != null)
            {
                Thread.Sleep(GetI(a, "verifyDelayMs", 240));
                byte[] after = FrameSignatureRect(bx, by, bw, bh, 8);
                if (after != null) changedPct = Math.Round(SigDiffPct(before, after, 8), 2);
            }
            POINT fp; Native.GetCursorPos(out fp);
            Dictionary<string, object> clickFocus = FocusReport(a, false);
            CheckHumanInput();
            Dictionary<string, object> clickOut = Dict("x", fp.X, "y", fp.Y, "positionCorrections", _positionCorrections, "focus", clickFocus);
            if (_lastRefocus != null) clickOut["refocused"] = _lastRefocus;
            if (coveredBy != null) clickOut["coveredBy"] = coveredBy;
            if (under != IntPtr.Zero)
                clickOut["receiver"] = Short(WinTitleOf(under), 40) + " (pid " + PidOf(under) + ")";
            if (changedPct >= 0)
            {
                clickOut["changedPct"] = changedPct;
                if (changedPct < 0.15 && !a.ContainsKey("verify"))
                    clickOut["warning"] = "nothing changed near the click point within ~240ms: the click may not have reached " +
                        "its target (dead UI, disabled control, or a wrong pixel). Probe the point before retrying.";
            }
            return clickOut;
        }

        static Dictionary<string, object> Drag(Dictionary<string, object> a)
        {
            int fx = GetI(a, "fromX", int.MinValue), fy = GetI(a, "fromY", int.MinValue);
            int tx = GetI(a, "toX", int.MinValue), ty = GetI(a, "toY", int.MinValue);
            if (fx == int.MinValue || fy == int.MinValue || tx == int.MinValue || ty == int.MinValue)
                throw new Exception("fromX,fromY,toX,toY required");
            // both ends are input destinations - the button goes down under (fx,fy) and comes up
            // under (tx,ty) - so either one can be the host window
            HostGuardPoint(fx, fy, "drag");
            HostGuardPoint(tx, ty, "drag");
            int steps = Math.Max(2, GetI(a, "steps", 25));
            int durMs = Math.Max(50, GetI(a, "durationMs", 350));
            AgentActing(a, "drag");
            CheckHumanInput();
            AnimatedMove(fx, fy, GetI(a, "moveDurationMs", 250));
            Thread.Sleep(80);
            SendMouse(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
            Thread.Sleep(80);
            POINT probe0; Native.GetCursorPos(out probe0);
            if (Dist(probe0, fx, fy) > 24)
            {
                _positionCorrections++; CheckHumanInput();
                AnimatedMove(fx, fy, 150); // tolerate and re-anchor instead of aborting
            }
            Stopwatch sw = Stopwatch.StartNew();
            for (int i = 1; i <= steps; i++)
            {
                double t = Math.Min(1.0, (double)sw.ElapsedMilliseconds / durMs);
                double e = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2; // easeInOutQuad
                int ix = fx + (int)((tx - fx) * e), iy = fy + (int)((ty - fy) * e);
                int ax, ay; ToAbs(ix, iy, out ax, out ay);
                SendMouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
                POINT cur; Native.GetCursorPos(out cur);
                if (Dist(cur, ix, iy) > 24)
                {
                    _positionCorrections++; CheckHumanInput();
                    int rx, ry; ToAbs(ix, iy, out rx, out ry); // re-anchor, keep dragging
                    SendMouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, rx, ry, 0);
                }
                Thread.Sleep(Math.Max(4, durMs / steps));
            }
            Thread.Sleep(60);
            SendMouse(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0);
            POINT p; Native.GetCursorPos(out p);
            CheckHumanInput();
            return Dict("x", p.X, "y", p.Y, "positionCorrections", _positionCorrections);
        }

        static Dictionary<string, object> Scroll(Dictionary<string, object> a)
        {
            string dir = GetS(a, "direction", "down");
            int lines = Math.Max(1, Math.Min(30, GetI(a, "lines", 3)));
            uint flag = (dir == "left" || dir == "right") ? Native.MOUSEEVENTF_HWHEEL : Native.MOUSEEVENTF_WHEEL;
            int sign = (dir == "up" || dir == "left") ? 1 : -1;
            // the wheel is delivered to the window under the CURSOR: at (x,y) when the caller gave
            // a point, otherwise wherever the pointer already happens to be
            if (a.ContainsKey("x") && a.ContainsKey("y")) HostGuardPoint(GetI(a, "x", 0), GetI(a, "y", 0), "scroll");
            else HostGuardCursor("scroll");
            AgentActing(a, "scroll");
            if (a.ContainsKey("x") && a.ContainsKey("y")) Move(a);
            for (int i = 0; i < lines; i++)
            {
                SendMouse(flag, 0, 0, unchecked((uint)(sign * (int)Native.WHEEL_DELTA)));
                Thread.Sleep(25);
            }
            POINT p; Native.GetCursorPos(out p);
            return PtDict(p.X, p.Y);
        }

        // Physical ownership is checked before focus or input, for every action.

        /// The sticky target IS the window the agent is working in, so an input op must not be
        /// delivered to whatever happens to be in front. Windows' foreground lock makes this the
        /// single most common cause of "the click / the typing did nothing at all" — the agent
        /// usually only notices several steps later, from a screenshot.
        ///
        /// 2026-09-13: the host re-takes the foreground every time an image is rendered, so this
        /// stopped being a manual step. Every input op re-asserts the target itself and reports it.
        static string _lastRefocus = null;
        static string EnsureTargetForeground()
        {
            IntPtr want = _stickyHwnd;
            if (want == IntPtr.Zero || !Native.IsWindow(want)) return null;
            if (IsForeground(want)) return null;
            string how = RefocusWindow(want, true);
            if (how != null && !IsForeground(want)) how = null;   // it claimed success but did not
            return how;
        }

        static void AgentActing(Dictionary<string, object> a, string op)
        {
            Panic.Check(op);
            CheckHumanInput();
            // Re-assert the target window before any op whose input goes to the FOREGROUND. Not for
            // `activate`/`windowOp` (they are deliberately changing windows) nor for ops that drive
            // nothing (clipWrite / calibrate / indicator).
            if (op == "click" || op == "move" || op == "drag" || op == "scroll" ||
                op == "key" || op == "type" || op == "selectRange" || op == "shiftClick" || op == "uiaAct")
            {
                _lastRefocus = EnsureTargetForeground();
            }
            // Stays lit across the agent's thinking gaps: the glow means "the agent is
            // driving this machine right now", not "a click happened a moment ago".
            // 1200 ms, not 30000 (2026-09-13). The hold is how long the DEEP BLUE "acting" border
            // stays after an input injection — and 30 s meant a 50 ms click painted half a minute of
            // "I am driving the machine", during which the cyan "thinking" state could never show
            // (the render loop shows acting in preference to thinking). The human watched the blue
            // light sit still through a whole page read and asked, correctly, why. Blue now means
            // "input, right now, plus a short tail"; cyan is what a reading agent looks like.
            int hold = GetI(a, "indicatorMs", 1200);
            Glow.Touch(hold);
        }

        static Dictionary<string, object> Indicator(Dictionary<string, object> a)
        {
            bool on = GetB(a, "on", true);
            bool soft = GetB(a, "soft", false);
            if (on) { Glow.Enabled = true; Glow.Touch(GetI(a, "ms", 30000)); }
            else if (soft) Glow.Off();    // legacy slow ease-out, kept for callers that want a fade
            else Glow.Kill();             // default: vanish instantly, identical to the brake
            return Dict("indicator", on ? "on" : "off", "enabled", Glow.Enabled, "hard", !on && !soft);
        }

        // ---------- declarative range selection ----------
        // Drag-select is fragile by nature: the pointer must hold the button while the view
        // auto-scrolls, so the end of the range depends on drag duration, edge distance and
        // where the drag happened to start — the reason a "select section 1.4" attempt could
        // land inside the next section. This op replaces the drag with the classic
        // anchor + shift-click idiom:
        //   1. click once on the START ("the anchor") — a collapsed caret, nothing selected;
        //   2. scroll freely until the END is visible — a caret survives scrolling, unlike a
        //      live drag that needs the view to stay put;
        //   3. hold SHIFT and click the END — the selection extends exactly from the anchor.
        // Both ends are ordinary, precisely clickable points, so the boundaries are exact.
        static Dictionary<string, object> SelectRange(Dictionary<string, object> a)
        {
            int fx = GetI(a, "fromX", int.MinValue), fy = GetI(a, "fromY", int.MinValue);
            int tx = GetI(a, "toX", int.MinValue), ty = GetI(a, "toY", int.MinValue);
            if (fx == int.MinValue || fy == int.MinValue || tx == int.MinValue || ty == int.MinValue)
                throw new Exception("fromX,fromY,toX,toY required");
            // both ends receive a click (the anchor, then shift+click), so check both
            HostGuardPoint(fx, fy, "selectRange");
            HostGuardPoint(tx, ty, "selectRange");
            int fromClicks = Math.Max(1, Math.Min(3, GetI(a, "fromClicks", 1)));
            int toClicks = Math.Max(1, Math.Min(3, GetI(a, "toClicks", 1)));
            int dur = Math.Max(60, GetI(a, "moveDurationMs", 200));
            int scrollClicks = GetI(a, "scrollClicks", 0);
            int scrollAtX = GetI(a, "scrollAtX", tx), scrollAtY = GetI(a, "scrollAtY", ty);
            int settle = Math.Max(40, GetI(a, "settleMs", 110));
            // the wheel may be aimed at a point of its own (scrollAtX/scrollAtY) rather than at an
            // endpoint, and that pixel is a victim too
            if (scrollClicks != 0) HostGuardPoint(scrollAtX, scrollAtY, "selectRange");

            AgentActing(a, "selectRange");
            CheckHumanInput();

            // 1) anchor
            AnimatedMove(fx, fy, dur);
            Thread.Sleep(settle);
            ClickTimes(fromClicks);
            Thread.Sleep(settle);

            // 2) scroll without touching the selection
            if (scrollClicks != 0)
            {
                AnimatedMove(scrollAtX, scrollAtY, dur);
                uint flag = Native.MOUSEEVENTF_WHEEL;
                int sign = scrollClicks > 0 ? -1 : 1;
                for (int i = 0; i < Math.Abs(scrollClicks); i++)
                {
                    SendMouse(flag, 0, 0, unchecked((uint)(sign * (int)Native.WHEEL_DELTA)));
                    Thread.Sleep(28);
                }
                Thread.Sleep(settle);
            }

            // 3) extend to the far end with SHIFT held
            AnimatedMove(tx, ty, dur);
            Thread.Sleep(settle);
            SendKey(0x10, false);            // VK_SHIFT down
            Thread.Sleep(40);
            ClickTimes(toClicks);
            Thread.Sleep(40);
            SendKey(0x10, true);             // VK_SHIFT up
            Thread.Sleep(settle);
            CheckHumanInput();
            return Dict("anchor", PtDict(fx, fy), "focus", PtDict(tx, ty),
                        "fromClicks", fromClicks, "toClicks", toClicks, "scrollClicks", scrollClicks);
        }

        // Shift+click: the missing half of the anchor idiom. A plain click sets the anchor,
        // scrolling moves the view without disturbing it, and this extends the selection to
        // the clicked point. Composing these three is far more debuggable than one long drag,
        // because every step can be verified with a screenshot before the next one runs.
        static Dictionary<string, object> ShiftClick(Dictionary<string, object> a)
        {
            int x = GetI(a, "x", int.MinValue), y = GetI(a, "y", int.MinValue);
            if (x == int.MinValue || y == int.MinValue) throw new Exception("x,y required");
            HostGuardPoint(x, y, "shiftClick");
            int clicks = Math.Max(1, Math.Min(3, GetI(a, "clicks", 1)));
            AgentActing(a, "shiftClick");
            CheckHumanInput();
            AnimatedMove(x, y, Math.Max(60, GetI(a, "moveDurationMs", 200)));
            Thread.Sleep(GetI(a, "settleMs", 90));
            SendKey(0x10, false);            // VK_SHIFT down
            Thread.Sleep(40);
            ClickTimes(clicks);
            Thread.Sleep(40);
            SendKey(0x10, true);             // VK_SHIFT up
            Thread.Sleep(GetI(a, "settleMs", 90));
            CheckHumanInput();
            return Dict("x", x, "y", y, "clicks", clicks);
        }

        static void ClickTimes(int n)
        {
            for (int i = 0; i < n; i++)
            {
                SendMouse(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
                Thread.Sleep(28);
                SendMouse(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0);
                if (i < n - 1) Thread.Sleep(70);
            }
        }

        // ---------- frame-difference helpers: pick the RIGHT moment to screenshot ----------
        // Capturing a half-loaded page burns a whole vision round-trip, and a fixed sleep is
        // either too short (skeleton UI) or too long (dead time). These two ops decide from
        // the pixels themselves:
        //   waitStable — the screen stopped changing  -> safe to capture
        //   waitChange — the screen changed at all     -> the click actually did something
        // Both sample a coarse luminance signature (every `step`-th pixel) so a poll costs
        // ~40 ms instead of a full screenshot.
        static byte[] FrameSignature(int step)
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            IntPtr screen = Native.GetDC(IntPtr.Zero);
            IntPtr mem = Native.CreateCompatibleDC(screen);
            Native.BITMAPINFO bmi = new Native.BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = vw; bmi.bmiHeader.biHeight = -vh;
            bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32; bmi.bmiHeader.biCompression = 0;
            IntPtr bits;
            IntPtr dib = Native.CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
            if (dib == IntPtr.Zero) { Native.DeleteDC(mem); Native.ReleaseDC(IntPtr.Zero, screen); return null; }
            IntPtr old = Native.SelectObject(mem, dib);
            Native.BitBlt(mem, 0, 0, vw, vh, screen, vx, vy, 0x00CC0020 | 0x40000000);
            int n = ((vw - 1) / step + 1) * ((vh - 1) / step + 1);
            byte[] sig = new byte[n];
            int k = 0;
            for (int y = 0; y < vh; y += step)
                for (int x = 0; x < vw; x += step)
                {
                    int off = (y * vw + x) * 4;
                    int b = Marshal.ReadByte(bits, off);
                    int g = Marshal.ReadByte(bits, off + 1);
                    int r = Marshal.ReadByte(bits, off + 2);
                    sig[k++] = (byte)((r * 3 + g * 6 + b) / 10);
                }
            Native.SelectObject(mem, old);
            Native.DeleteObject(dib); Native.DeleteDC(mem); Native.ReleaseDC(IntPtr.Zero, screen);
            return sig;
        }

        static double SigDiffPct(byte[] a, byte[] b, int threshold)
        {
            if (a == null || b == null || a.Length != b.Length || a.Length == 0) return 100;
            int diff = 0;
            for (int i = 0; i < a.Length; i++)
            {
                int d = a[i] - b[i];
                if (d < 0) d = -d;
                if (d > threshold) diff++;
            }
            return 100.0 * diff / a.Length;
        }

        /// Same idea as FrameSignature, but over an arbitrary screen RECTANGLE.
        ///
        /// This is what makes a CACHED element map safe to reuse without another screenshot:
        /// re-hash the window's interior and compare with the hash taken when the map was built.
        /// The caller insets the rectangle (`insetPct`) precisely so the breathing blue activity
        /// border — painted along the SCREEN edges, over everything — can never make a static
        /// window look "changed".
        static byte[] FrameSignatureRect(int rx, int ry, int rw, int rh, int step)
        {
            if (rw <= 16 || rh <= 16) return null;
            IntPtr screen = Native.GetDC(IntPtr.Zero);
            IntPtr mem = Native.CreateCompatibleDC(screen);
            Native.BITMAPINFO bmi = new Native.BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = rw; bmi.bmiHeader.biHeight = -rh;
            bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32; bmi.bmiHeader.biCompression = 0;
            IntPtr bits;
            IntPtr dib = Native.CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
            if (dib == IntPtr.Zero) { Native.DeleteDC(mem); Native.ReleaseDC(IntPtr.Zero, screen); return null; }
            IntPtr old = Native.SelectObject(mem, dib);
            Native.BitBlt(mem, 0, 0, rw, rh, screen, rx, ry, 0x00CC0020 | 0x40000000);
            int n = ((rw - 1) / step + 1) * ((rh - 1) / step + 1);
            byte[] sig = new byte[n];
            int k = 0;
            for (int y = 0; y < rh && k < n; y += step)
                for (int x = 0; x < rw && k < n; x += step)
                {
                    int off = (y * rw + x) * 4;
                    int b = Marshal.ReadByte(bits, off), g = Marshal.ReadByte(bits, off + 1), r = Marshal.ReadByte(bits, off + 2);
                    sig[k++] = (byte)((r * 3 + g * 6 + b) / 10);
                }
            Native.SelectObject(mem, old);
            Native.DeleteObject(dib); Native.DeleteDC(mem); Native.ReleaseDC(IntPtr.Zero, screen);
            return sig;
        }

        /// `frameSig` — a cheap, image-free fingerprint of a window's interior.
        /// A change invalidates the cached snapshot. This sampled hash is not a semantic element identity.
        static Dictionary<string, object> FrameSigOp(Dictionary<string, object> a)
        {
            int step = Math.Max(4, GetI(a, "step", 16));
            int inset = Math.Max(0, Math.Min(40, GetI(a, "insetPct", 10)));
            IntPtr h = IntPtr.Zero;
            try { if (a.ContainsKey("hwnd") || a.ContainsKey("titleContains") || a.ContainsKey("titleExact")) h = FindHwnd(a); }
            catch { h = IntPtr.Zero; }
            if (h == IntPtr.Zero) h = TopLevel(Native.GetForegroundWindow());
            int rx, ry, rw, rh;
            if (h != IntPtr.Zero && Native.IsWindow(h))
            {
                RECT r; Native.GetWindowRect(h, out r);
                int w = r.Right - r.Left, ht = r.Bottom - r.Top;
                int ix = w * inset / 100, iy = ht * inset / 100;
                rx = r.Left + ix; ry = r.Top + iy; rw = w - 2 * ix; rh = ht - 2 * iy;
            }
            else
            {
                rx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
                ry = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
                rw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
                rh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
                h = IntPtr.Zero;
            }
            byte[] sig = FrameSignatureRect(rx, ry, rw, rh, step);
            if (sig == null) throw new Exception("frame signature failed (region " + rw + "x" + rh + ")");
            ulong hash = 14695981039346656037UL;
            for (int i = 0; i < sig.Length; i++) { hash ^= sig[i]; hash *= 1099511628211UL; }
            uint pid = 0;
            if (h != IntPtr.Zero) Native.GetWindowThreadProcessId(h, out pid);
            // Identical pixels after moving a window must not validate old absolute coordinates.
            foreach (long value in new long[] { rx, ry, rw, rh, h.ToInt64(), pid })
                foreach (byte b in BitConverter.GetBytes(value)) { hash ^= b; hash *= 1099511628211UL; }
            return Dict(
                "sig", hash.ToString("x16"),
                "samples", sig.Length,
                "region", Dict("x", rx, "y", ry, "width", rw, "height", rh),
                "hwnd", h.ToInt64(),
                "pid", pid,
                "step", step);
        }

        /// Shared settle engine. PRIMARY: stop when the frame signature stops changing.
        /// FALLBACK (so a slow or never-quiet page can never stall the loop): a hard cap;
        /// when it trips we also extrapolate how much longer the screen *would* have needed,
        /// so the caller can decide to re-shoot instead of guessing blindly.
        static bool SettleWait(int capMs, int stableMs, int pollMs, int step, double diffPct,
                               out int waitedMs, out double lastDiff, out int estimateMs)
        {
            return SettleSampleWait(capMs, stableMs, pollMs, diffPct, delegate { return FrameSignature(step); },
                                    out waitedMs, out lastDiff, out estimateMs);
        }

        static bool SettleSampleWait(int capMs, int stableMs, int pollMs, double diffPct, Func<byte[]> sample,
                                     out int waitedMs, out double lastDiff, out int estimateMs)
        {
            long t0 = NowMs();
            byte[] prev = sample();
            long stableSince = NowMs();
            lastDiff = 100.0;
            estimateMs = 0;
            double prevDiff = -1;
            while (NowMs() - t0 < capMs)
            {
                Thread.Sleep(pollMs);
                byte[] cur = sample();
                double d = SigDiffPct(prev, cur, 8);
                prev = cur;
                lastDiff = d;
                if (d <= diffPct)
                {
                    if (NowMs() - stableSince >= stableMs)
                    {
                        waitedMs = (int)(NowMs() - t0);
                        estimateMs = 0;
                        return true;
                    }
                }
                else
                {
                    // decay estimate: how fast is the changing area shrinking?
                    if (prevDiff >= 0 && prevDiff > d)
                    {
                        double perMs = (prevDiff - d) / Math.Max(1, pollMs);
                        if (perMs > 0) estimateMs = (int)Math.Min(4000, (d - diffPct) / perMs);
                    }
                    stableSince = NowMs();
                }
                prevDiff = d;
            }
            waitedMs = (int)(NowMs() - t0);
            return false;
        }

        // Explicit window scope excludes unrelated desktop animation without loosening the
        // change threshold. A moved/minimized/replaced window invalidates the observation.
        static Func<byte[]> WaitSampler(Dictionary<string, object> a, int step, out object scope)
        {
            if (!a.ContainsKey("hwnd") || GetI(a, "hwnd", 0) == 0)
            {
                scope = Dict("kind", "virtual-desktop");
                return delegate { return FrameSignature(step); };
            }
            IntPtr h = new IntPtr(GetI(a, "hwnd", 0));
            if (!Native.IsWindow(h) || Native.IsIconic(h))
                throw new Exception("WAIT_TARGET_UNAVAILABLE: window is closed or minimized; restore/requery first");
            RECT original; Native.GetWindowRect(h, out original);
            uint pid = PidOf(h);
            Rectangle virtualRect = SystemInformation.VirtualScreen;
            Rectangle visible = Rectangle.Intersect(virtualRect, Rectangle.FromLTRB(original.Left, original.Top, original.Right, original.Bottom));
            if (visible.Width <= 16 || visible.Height <= 16)
                throw new Exception("WAIT_TARGET_UNAVAILABLE: window has no usable visible screen region");
            scope = Dict("kind", "window", "hwnd", h.ToInt64(), "region", Dict("x", visible.X, "y", visible.Y, "width", visible.Width, "height", visible.Height));
            return delegate {
                RECT current;
                if (!Native.IsWindow(h) || Native.IsIconic(h) || PidOf(h) != pid || !Native.GetWindowRect(h, out current) ||
                    current.Left != original.Left || current.Top != original.Top || current.Right != original.Right || current.Bottom != original.Bottom)
                    throw new Exception("WAIT_TARGET_CHANGED: window identity or bounds changed during sampling; requery before waiting again");
                return FrameSignatureRect(visible.X, visible.Y, visible.Width, visible.Height, step);
            };
        }

        static Dictionary<string, object> WaitStable(Dictionary<string, object> a)
        {
            int capMs = Math.Max(400, GetI(a, "timeoutMs", 8000));
            int stableMs = Math.Max(150, GetI(a, "stableMs", 600));
            int pollMs = Math.Max(120, GetI(a, "pollMs", 240));
            int step = Math.Max(4, Math.Min(64, GetI(a, "step", 8)));
            double diffPct = GetD(a, "diffPct", 0.30);
            int waited, estimate; double lastDiff;
            object scope; Func<byte[]> sample = WaitSampler(a, step, out scope);
            bool ok = SettleSampleWait(capMs, stableMs, pollMs, diffPct, sample, out waited, out lastDiff, out estimate);
            return Dict("stable", ok, "waitedMs", waited, "lastDiffPct", Math.Round(lastDiff, 3),
                        "estimateMs", estimate, "scope", scope,
                        "note", ok ? "sampled pixels settled; this does not verify task completion"
                                   : "cap reached; sampled pixels did not settle. lastDiffPct is only the final pair. Inspect target state; persistent animation may require UIA readback instead of another pixel wait.");
        }

        static Dictionary<string, object> WaitChange(Dictionary<string, object> a)
        {
            int timeoutMs = Math.Max(300, GetI(a, "timeoutMs", 6000));
            int pollMs = Math.Max(100, GetI(a, "pollMs", 220));
            int step = Math.Max(4, Math.Min(64, GetI(a, "step", 8)));
            double diffPct = GetD(a, "diffPct", 0.30);
            object scope; Func<byte[]> sample = WaitSampler(a, step, out scope);
            byte[] first = sample();
            long t0 = NowMs();
            int samples = 0;
            while (NowMs() - t0 < timeoutMs)
            {
                Thread.Sleep(pollMs);
                byte[] cur = sample();
                samples++;
                double d = SigDiffPct(first, cur, 8);
                if (d > diffPct)
                    return Dict("changed", true, "afterMs", NowMs() - t0, "diffPct", Math.Round(d, 3), "samples", samples, "scope", scope);
            }
            return Dict("changed", false, "afterMs", NowMs() - t0, "samples", samples, "scope", scope,
                        "note", "no sampled pixel change exceeded the threshold; inspect task state before retrying a write");
        }

        // ---------- calibration / self-test ----------
        // The whole vision loop rests on one invariant: "the pixel the model SEES in a
        // screenshot is the pixel SendInput TARGETS". These two ops measure it —
        // selftest numerically (non-intrusive, pointer never moves), calibrate both
        // numerically and visually (a cursor-marked crop centred on a known coordinate,
        // so a vision model can confirm the pointer is drawn exactly where it claims).
        static Dictionary<string, object> SelfTest(Dictionary<string, object> a)
        {
            POINT before; Native.GetCursorPos(out before);
            // probe the input path WITHOUT disturbing the user: absolute-move to where
            // the pointer already is, then check SendInput's own return value.
            int ax, ay; ToAbs(before.X, before.Y, out ax, out ay);
            INPUT probe = new INPUT();
            probe.type = Native.INPUT_MOUSE;
            probe.u.mi.dx = ax; probe.u.mi.dy = ay;
            probe.u.mi.dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK;
            CheckHumanInput();
            probe.u.mi.dwExtraInfo = Panic.OwnMagic;
            uint sent = SendTrackedInput(new INPUT[] { probe });
            // GetLastError is only meaningful when the call FAILED: a successful SendInput
            // leaves whatever code the thread carried before, which we saw reported as a
            // bogus "win32Error 1008" next to inputInjection:"ok". Report 0 on success.
            int err = sent == 1 ? 0 : Marshal.GetLastWin32Error();
            string msg = "";
            try { if (err != 0) msg = new System.ComponentModel.Win32Exception(err).Message; } catch { }
            Thread.Sleep(30);
            POINT after; Native.GetCursorPos(out after);
            int expected = IntPtr.Size == 8 ? 40 : 28;
            bool ok = sent == 1 && InputCbSize == expected && _dpiNote.StartsWith("PerMonitorV2");
            return Dict(
                "inputInjection", sent == 1 ? "ok" : "FAILED",
                "sendInputReturn", sent,
                "win32Error", err,
                "win32Message", msg,
                "inputCbSize", InputCbSize,
                "inputCbSizeExpected", expected,
                "process64", IntPtr.Size == 8,
                "dpiAwareness", _dpiNote,
                "virtualScreen", VirtualScreenDict(),
                "monitors", Native.GetSystemMetrics(Native.SM_CMONITORS),
                "cursorBefore", PtDict(before.X, before.Y),
                "cursorAfter", PtDict(after.X, after.Y),
                "cursorStable", Dist(before, after.X, after.Y) <= 1,
                "healthy", ok,
                "hint", ok ? "input path healthy; screenshots, UIA rects and click coordinates share one pixel space"
                           : "input path BROKEN (see win32Error / inputCbSize / dpiAwareness)");
        }

        static Dictionary<string, object> Calibrate(Dictionary<string, object> a)
        {
            int tol = Math.Max(0, GetI(a, "tolerancePx", 2));
            int dur = Math.Max(60, GetI(a, "moveDurationMs", 220));
            bool restore = GetB(a, "restore", true);
            // fullSweep is OPT-IN on purpose (2026-09-12): the first version always toured
            // the four corners + centre, which the user experienced as "the mouse is flying
            // all over my screen". A calibration run must be almost invisible by default.
            bool fullSweep = GetB(a, "fullSweep", false);
            int span = Math.Max(40, Math.Min(200, GetI(a, "spanPx", 55)));   // local-cross radius
            int margin = Math.Max(80, Math.Min(700, GetI(a, "margin", 220)));
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            POINT origin; Native.GetCursorPos(out origin);
            AgentActing(a, "calibrate");
            long startedAt = NowMs();

            List<int[]> targets = new List<int[]>();
            string mode;
            if (fullSweep)
            {
                mode = "full-sweep";
                targets.Add(new int[] { vx + vw / 8, vy + vh / 8 });
                targets.Add(new int[] { vx + vw - vw / 8, vy + vh / 8 });
                targets.Add(new int[] { vx + vw - vw / 8, vy + vh - vh / 8 });
                targets.Add(new int[] { vx + vw / 8, vy + vh - vh / 8 });
                targets.Add(new int[] { vx + vw / 2, vy + vh / 2 });
            }
            else
            {
                // default: a cross of ±span px around wherever the pointer already is, kept
                // away from the screen edges. Measures the exact same mapping, disturbs nothing.
                mode = "local-cross";
                int cx = Math.Min(Math.Max(origin.X, vx + span), vx + vw - span);
                int cy = Math.Min(Math.Max(origin.Y, vy + span), vy + vh - span);
                targets.Add(new int[] { cx + span, cy });
                targets.Add(new int[] { cx - span, cy });
                targets.Add(new int[] { cx, cy + span });
                targets.Add(new int[] { cx, cy - span });
            }

            List<object> probes = new List<object>();
            int maxErr = 0;
            bool humanAbort = false;
            foreach (int[] t in targets)
            {
                // if the user has taken the mouse, stop at once and do NOT drag it back
                CheckHumanInput();
                AnimatedMove(t[0], t[1], dur);
                Thread.Sleep(70);
                // Record where we put it, otherwise CountSpontaneousMove() has no reference
                // point and the human-takeover abort below can never fire (it would be dead code).
                CheckHumanInput();
                POINT p; Native.GetCursorPos(out p);
                int e = Dist(p, t[0], t[1]);
                if (e > maxErr) maxErr = e;
                probes.Add(Dict("want", PtDict(t[0], t[1]), "got", PtDict(p.X, p.Y), "errPx", e));
            }

            // visual anchor: the pointer is on the last target right now — photograph it.
            int ax2 = targets[targets.Count - 1][0], ay2 = targets[targets.Count - 1][1];
            int rx = ax2 - margin, ry = ay2 - margin;
            object img = null; object mime = null;
            try
            {
                Dictionary<string, object> shot = Capture(Dict(
                    "x", rx, "y", ry, "width", margin * 2, "height", margin * 2,
                    "cursor", true, "quality", 92, "maxWidth", 0, "clamp", true));
                img = shot["image"]; mime = shot["mime"];
                object reg; if (shot.TryGetValue("region", out reg)) { rx = GetI((Dictionary<string, object>)reg, "x", rx); ry = GetI((Dictionary<string, object>)reg, "y", ry); }
            }
            catch (Exception ex) { mime = "error: " + ex.Message; }
            CheckHumanInput();
            // Never drag the pointer back while the user is holding the mouse.
            if (restore && !humanAbort) { AnimatedMove(origin.X, origin.Y, 180); Thread.Sleep(40); CheckHumanInput(); }

            return Dict(
                "mode", mode,
                "points", probes,
                "maxErrorPx", maxErr,
                "tolerancePx", tol,
                "inputPass", maxErr <= tol && !humanAbort,
                "humanAbort", humanAbort,
                "restoredPointer", restore && !humanAbort,
                "startedAt", startedAt,
                "finishedAt", NowMs(),
                "dpiAwareness", _dpiNote,
                "virtualScreen", VirtualScreenDict(),
                "visualAnchor", Dict(
                    "screenPoint", PtDict(ax2, ay2),
                    "region", Dict("x", rx, "y", ry, "width", margin * 2, "height", margin * 2),
                    "cursorPixelsInImage", Dict("x", ax2 - rx, "y", ay2 - ry),
                    "note", "the drawn pointer must sit exactly at cursorPixelsInImage in the returned image"),
                "image", img,
                "mime", mime);
        }

        static readonly Dictionary<string, ushort> KeyMap = BuildKeyMap();
        static Dictionary<string, ushort> BuildKeyMap()
        {
            Dictionary<string, ushort> d = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            d["ctrl"] = 0x11; d["control"] = 0x11; d["shift"] = 0x10; d["alt"] = 0x12;
            d["win"] = 0x5B; d["lwin"] = 0x5B; d["rwin"] = 0x5C;
            d["enter"] = 0x0D; d["return"] = 0x0D; d["esc"] = 0x1B; d["escape"] = 0x1B;
            d["tab"] = 0x09; d["space"] = 0x20; d["bksp"] = 0x08; d["backspace"] = 0x08;
            d["delete"] = 0x2E; d["del"] = 0x2E; d["insert"] = 0x2D; d["ins"] = 0x2D;
            d["home"] = 0x24; d["end"] = 0x23; d["pgup"] = 0x21; d["pageup"] = 0x21;
            d["pgdn"] = 0x22; d["pagedown"] = 0x22;
            d["up"] = 0x26; d["down"] = 0x28; d["left"] = 0x25; d["right"] = 0x27;
            d["caps"] = 0x14; d["capslock"] = 0x14; d["apps"] = 0x5D;
            d["prtsc"] = 0x2C; d["printscreen"] = 0x2C; d["numlock"] = 0x90;
            d["plus"] = 0xBB; d["minus"] = 0xBD; d["comma"] = 0xBC; d["period"] = 0xBE;
            for (int i = 1; i <= 24; i++) d["f" + i] = (ushort)(0x6F + i);
            return d;
        }

        static ushort VkOf(string k)
        {
            ushort vk;
            if (KeyMap.TryGetValue(k, out vk)) return vk;
            if (k.Length == 1)
            {
                char c = k[0];
                if (c >= '0' && c <= '9') return (ushort)c;
                if (c >= 'a' && c <= 'z') return (ushort)char.ToUpper(c);
                if (c >= 'A' && c <= 'Z') return (ushort)c;
            }
            throw new Exception("unknown key: " + k);
        }

        static void SendKey(ushort vk, bool up)
        {
            INPUT inp = new INPUT();
            inp.type = Native.INPUT_KEYBOARD;
            inp.u.ki.wVk = vk; inp.u.ki.wScan = 0;
            inp.u.ki.dwFlags = (up ? Native.KEYEVENTF_KEYUP : 0) |
                (Panic.IsExtendedVk(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0);
            inp.u.ki.dwExtraInfo = Panic.OwnMagic;   // the hook must know this one is ours
            SendInputChecked(new INPUT[] { inp });
        }

        // Cleanup must bypass the stopped-input gate, but may send ONLY the scope's accepted downs.
        static void ReleaseKeyForCleanup(ushort vk)
        {
            lock (InputLock)
            {
                string key = "key:" + vk;
                bool owned = OwnedUps.ContainsKey(key);
                ReleaseOwnedKey(key);
                if (owned && OwnedUps.ContainsKey(key)) throw new Exception("Cleanup SendInput did not release the owned key.");
            }
        }
        static void WaitForKeyHold(int milliseconds)
        {
            var timer = Stopwatch.StartNew();
            while (true)
            {
                if (Panic.Exited || Panic.Engaged || Panic.Stopped)
                    throw new Exception("INTERRUPTED: keyboard chord stopped; releasing its accepted key downs.");
                CheckHumanInput();
                long remaining = milliseconds - timer.ElapsedMilliseconds;
                if (remaining <= 0) return;
                Thread.Sleep((int)Math.Min(10, remaining));
            }
        }

        static Dictionary<string, object> Key(Dictionary<string, object> a)
        {
            string combo = GetS(a, "combo", null);
            if (combo == null) throw new Exception("combo required (e.g. 'ctrl+shift+t', 'enter')");
            List<string> keys = new List<string>();
            foreach (string s in combo.Split('+')) { string t = s.Trim().ToLowerInvariant(); if (t.Length > 0) keys.Add(t); }
            if (keys.Count == 0) throw new Exception("empty combo");
            AgentActing(a, "key");
            // Keyboard input goes to the FOREGROUND window — re-assert the window the agent is
            // working in, and report which window actually received the keys.
            // A window the caller NAMED is re-asserted by FocusReport (foreground + titlebar
            // click), so it is refused first - a later refusal would already have driven it.
            HostGuardNamed(a, "key");
            Dictionary<string, object> focus = FocusReport(a, true);
            // Keystrokes are not addressed to a window at all: they land in the FOREGROUND one.
            // So the guard is asked AFTER FocusReport re-asserted the target - it then answers
            // about the window that will really receive the keys, not about whichever window
            // happened to be in front when the call arrived.
            HostGuardForeground("key");
            List<ushort> vks = new List<ushort>();
            foreach (string k in keys) { ushort vk = VkOf(k); if (!vks.Contains(vk)) vks.Add(vk); }
            KeyboardChord.Run(vks, SendKey, ReleaseKeyForCleanup,
                delegate(ushort vk) { return (Native.GetAsyncKeyState(vk) & 0x8000) != 0; },
                delegate { WaitForKeyHold(Math.Max(20, GetI(a, "holdMs", 60))); });
            Thread.Sleep(30);
            Dictionary<string, object> keyOut = Dict("combo", combo, "focus", focus);
            if (_lastRefocus != null) keyOut["refocused"] = _lastRefocus;
            return keyOut;
        }

        static Dictionary<string, object> Type(Dictionary<string, object> a)
        {
            string text = GetS(a, "text", null);
            if (text == null) throw new Exception("text required");
            AgentActing(a, "type");
            // Same contract as `key`: re-assert the intended window, then say which window the
            // characters actually went to.
            HostGuardNamed(a, "type");
            Dictionary<string, object> focus = FocusReport(a, true);
            HostGuardForeground("type");   // same rule as `key`: the foreground window is the victim
            // ...and whether whatever owns the focus can hold text at all. Typing into a control
            // with no editable pattern is silently discarded, or interpreted as shortcuts.
            string typeWarn = null;
            bool nonEditableButton = false;
            try
            {
                AutomationElement fe = AutomationElement.FocusedElement;
                if (fe != null && !Editable(fe))
                {
                    string ctl = "?";
                    try { if (fe.Current.ControlType != null) ctl = fe.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { }
                    typeWarn = "the focused element (\"" + Short(fe.Current.Name, 30) + "\", " + ctl +
                        ") exposes no editable pattern — the text may be discarded or read as shortcuts. Click the text field first.";
                    // Observed with Notepad's Add tab InvokePattern: activation succeeded, but
                    // focus stayed on the button and all characters were discarded. Refuse this
                    // known role before SendInput or clipboard writes. Unknown/custom editors
                    // retain the warning path, since absent UIA patterns alone prove nothing.
                    nonEditableButton = fe.Current.ControlType == ControlType.Button;
                }
            }
            catch { }
            if (nonEditableButton)
                throw NotDispatched("TYPE_FOCUS_NOT_EDITABLE",
                    "TYPE_FOCUS_NOT_EDITABLE: " + typeWarn +
                    " Use computer_uia_act focus on the observed editor, then retry; no text input sent.");
            string mode = GetS(a, "mode", "unicode");
            if (mode == "paste")
            {
                bool keep = GetB(a, "restoreClipboard", false);
                string restore = "not-requested";
                if (keep)
                {
                    using (var access = new NativeClipboardAccess())
                    {
                        CheckHumanInput();
                        ClipboardLease lease = ClipboardLease.Begin(access, text);
                        Exception inputError = null;
                        try
                        {
                            Thread.Sleep(60);
                            if (!lease.StillOwned())
                                throw NotDispatched("CLIPBOARD_CHANGED", "CLIPBOARD_CHANGED: clipboard changed before paste; no paste keystrokes sent.");
                            Key(Dict("combo", "ctrl+v", "holdMs", 40, "indicatorMs", 800));
                        }
                        catch (Exception error) { inputError = error; throw; }
                        finally
                        {
                            // Preserve the original dispatch result even when optional restoration fails.
                            Thread.Sleep(150);
                            try { restore = lease.Restore(); }
                            catch { restore = "restore-failed"; }
                            if (inputError != null) inputError.Data["clipboardRestore"] = restore;
                        }
                    }
                }
                else
                {
                    MarkMutation();
                    Clipboard.SetDataObject(text, true);
                    Thread.Sleep(60);
                    Key(Dict("combo", "ctrl+v", "holdMs", 40, "indicatorMs", 800));
                }
                Dictionary<string, object> pr = Dict("mode", "paste", "chars", text.Length, "focus", focus,
                    "clipboardRestore", restore);
                if (restore == "skipped-changed" || restore == "restore-failed")
                    pr["clipboardWarning"] = "Clipboard changed or could not be restored. Verify the target value before repeating input.";
                if (typeWarn != null) pr["warning"] = typeWarn;
                if (_lastRefocus != null) pr["refocused"] = _lastRefocus;
                return pr;
            }
            int charDelay = GetI(a, "charDelayMs", 8);
            foreach (char ch in text)
            {
                if (ch == '\r') continue;
                if (ch == '\n') { SendKey(0x0D, false); SendKey(0x0D, true); Thread.Sleep(15); continue; }
                INPUT down = new INPUT();
                down.type = Native.INPUT_KEYBOARD;
                // STAMP OUR OWN INPUT (2026-09-13, caught by a live run): without dwExtraInfo the
                // keyboard hook sees a character with no signature, classifies it as THE HUMAN
                // TYPING, and brakes the session — so the agent's own Unicode typing stopped
                // itself. Any CJK character goes down this path (its VK is VK_PACKET 0xE7), which
                // is what the brake reported verbatim: "human is typing ... (vk 0xE7)". The plain
                // key path has always stamped this (SendKey, line ~3086); this path was missing it.
                down.u.ki.wScan = ch; down.u.ki.dwFlags = Native.KEYEVENTF_UNICODE;
                down.u.ki.dwExtraInfo = Panic.OwnMagic;
                INPUT up = new INPUT();
                up.type = Native.INPUT_KEYBOARD;
                up.u.ki.wScan = ch; up.u.ki.dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP;
                up.u.ki.dwExtraInfo = Panic.OwnMagic;
                SendInputChecked(new INPUT[] { down, up });
                Thread.Sleep(charDelay);
            }
            Dictionary<string, object> tr = Dict("mode", "unicode", "chars", text.Length, "focus", focus);
            if (typeWarn != null) tr["warning"] = typeWarn;
            if (_lastRefocus != null) tr["refocused"] = _lastRefocus;
            return tr;
        }

        // ---------- clipboard ----------
        static Dictionary<string, object> ClipRead(Dictionary<string, object> a)
        {
            if (Clipboard.ContainsText()) return Dict("kind", "text", "text", Clipboard.GetText(), "truncated", false);
            if (Clipboard.ContainsImage()) return Dict("kind", "image", "note", "image clipboard: use clipReadImage");
            return Dict("kind", "empty");
        }
        static Dictionary<string, object> ClipWrite(Dictionary<string, object> a)
        {
            string text = GetS(a, "text", "");
            // Changing the clipboard IS changing the machine: deep steady blue, like any other
            // actuation — even though no pointer or key is involved.
            AgentActing(a, "clipWrite");
            MarkMutation();
            Clipboard.SetDataObject(text, true);
            return Dict("written", true, "chars", text.Length);
        }

        // ---------- windows ----------
        static Dictionary<string, object> RectDict(RECT r)
        {
            return Dict("x", r.Left, "y", r.Top, "width", r.Right - r.Left, "height", r.Bottom - r.Top);
        }
        static Dictionary<string, object> WinDict(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(512); Native.GetWindowText(h, sb, 512);
            StringBuilder cb = new StringBuilder(256); Native.GetClassName(h, cb, 256);
            RECT r; Native.GetWindowRect(h, out r);
            uint pid; Native.GetWindowThreadProcessId(h, out pid);
            string proc = null;
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            return Dict(
                "hwnd", h.ToInt64(), "pid", pid, "process", proc,
                "title", sb.ToString(), "class", cb.ToString(),
                "rect", RectDict(r),
                "active", h == Native.GetForegroundWindow(),
                "minimized", Native.IsIconic(h));
        }

        static Dictionary<string, object> Windows(Dictionary<string, object> a)
        {
            List<object> list = new List<object>();
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                StringBuilder sb = new StringBuilder(512);
                if (Native.GetWindowText(h, sb, 512) == 0) return true;
                list.Add(WinDict(h));
                return true;
            }, IntPtr.Zero);
            return Dict("windows", list);
        }

        static IntPtr FindHwnd(Dictionary<string, object> a)
        {
            if (a.ContainsKey("hwnd")) return new IntPtr(GetI(a, "hwnd", 0));
            string title = GetS(a, "titleContains", null);
            string exact = GetS(a, "titleExact", null);
            if (title == null && exact == null) return IntPtr.Zero;

            // Collect EVERY match. A substring match is genuinely ambiguous — "MarkPilot"
            // matches both the editor and a browser tab titled ".../markpilot: ...", and the
            // old code silently activated whichever window EnumWindows reached first. Now an
            // ambiguous selector throws with the candidate list instead of guessing, which is
            // the difference between a wrong window and a fixable error.
            List<IntPtr> hits = new List<IntPtr>();
            List<string> names = new List<string>();
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                StringBuilder sb = new StringBuilder(512); Native.GetWindowText(h, sb, 512);
                string t = sb.ToString();
                bool match = exact != null
                    ? string.Equals(t, exact, StringComparison.OrdinalIgnoreCase)
                    : t.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0;
                if (match) { hits.Add(h); names.Add(t); }
                return true;
            }, IntPtr.Zero);

            if (hits.Count == 0) return IntPtr.Zero;
            if (hits.Count == 1 || GetB(a, "pickFirst", false)) return hits[0];

            StringBuilder msg = new StringBuilder();
            msg.Append("ambiguous window selector: ").Append(hits.Count).Append(" visible windows match ");
            msg.Append(exact != null ? ("titleExact=\"" + exact + "\"") : ("titleContains=\"" + title + "\""));
            msg.Append(". Pass hwnd instead. Candidates:");
            for (int i = 0; i < hits.Count && i < 8; i++)
            {
                uint pid; Native.GetWindowThreadProcessId(hits[i], out pid);
                string proc = "";
                try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
                msg.Append(" [").Append(hits[i].ToInt64()).Append("] ").Append(proc).Append(" — ");
                string t = names[i]; if (t.Length > 60) t = t.Substring(0, 60) + "…";
                msg.Append(t).Append(';');
            }
            throw new Exception(msg.ToString());
        }

        static Dictionary<string, object> Activate(Dictionary<string, object> a)
        {
            IntPtr h = FindHwnd(a);
            if (h == IntPtr.Zero) throw new Exception("window not found");
            HostGuard(h, "activate");
            AgentActing(a, "activate");
            // The whole ladder now lives in RefocusWindow (shared with the keyboard focus
            // guard, which must re-assert the same window before typing).
            string how = RefocusWindow(h, GetB(a, "clickFallback", true));
            if (how == null || !Native.IsWindow(h) || !IsForeground(h)) how = "failed";
            else
            {
                SetSticky(h);
                _kickoffFocus.Confirm(h.ToInt64(), PidOf(h));
            }
            CheckHumanInput();
            return Dict("activated", how != "failed", "activatedVia", how,
                        "hwnd", h.ToInt64(),
                        "hint", how == "failed"
                            ? "foreground lock refused every method; click the window (or its taskbar button) and retry"
                            : null);
        }

        static bool IsForeground(IntPtr h) { return h == Native.GetForegroundWindow(); }

        // ---------- focus discipline: where will the keystrokes land? ----------
        //
        // 2026-09-13: "moving the mouse into the DSH chat box and typing basically never
        // worked". Synthetic KEYBOARD input is not addressed to a window at all — SendInput
        // types into whatever owns the FOREGROUND, so a click that lands perfectly can still be
        // followed by text that goes somewhere else (an approval card, the agent host, a toast)
        // and NOTHING errors. Two hard rules follow, and both live here:
        //   1. before any keyboard op, re-assert the window the agent last worked in and report
        //      which window actually received the keys;
        //   2. if that window belongs to an ELEVATED process while we are not, UIPI silently
        //      drops every event — say so loudly instead of reporting a successful no-op.
        static IntPtr _stickyHwnd = IntPtr.Zero;
        static readonly KickoffFocus _kickoffFocus = new KickoffFocus();
        public static void ResetKickoffFocus() { _kickoffFocus.Reset(); }
        public static long RecoveryTarget(out uint pid)
        {
            IntPtr foreground = Native.GetForegroundWindow();
            Native.GetWindowThreadProcessId(foreground, out pid);
            long target = _kickoffFocus.Target;
            string problem = _kickoffFocus.CaptureProblem(true, false, false,
                Native.IsWindow(new IntPtr(target)), foreground.ToInt64(), pid, false);
            return problem == null ? target : 0;
        }
        static void ValidateKickoffCapture(Dictionary<string, object> a)
        {
            if (!GetB(a, "__kickoff", true)) return; // stamped by the core for read-only mode
            if (!Panic.CycleLit || Panic.Stopped || Panic.Exited) return;
            IntPtr target = new IntPtr(_kickoffFocus.Target);
            IntPtr fg = TopLevel(Native.GetForegroundWindow());
            string problem = _kickoffFocus.CaptureProblem(Panic.CycleLit, Panic.Stopped, Panic.Exited,
                target != IntPtr.Zero && Native.IsWindow(target), fg.ToInt64(), PidOf(fg), IsHostWindow(fg));
            if (problem != null) throw new Exception(
                "KICKOFF-FOCUS-REQUIRED: " + problem + ". No screenshot was returned. " +
                "First use computer_state {windows:true} to identify the intended app by window/process. " +
                "Then computer_window {hwnd:...,op:'activate'}: it restores minimized windows and tries " +
                "the foreground/attachment, topmost and verified-titlebar fallback methods. " +
                "Require activated:true before taking a screenshot. If activation fails, inspect the text " +
                "result and re-identify the target; do not treat the agent desktop as the task page.");
        }

        static IntPtr TopLevel(IntPtr h)
        {
            if (h == IntPtr.Zero) return IntPtr.Zero;
            IntPtr cur = h, parent;
            int guard = 0;
            while (guard++ < 32 && (parent = Native.GetParent(cur)) != IntPtr.Zero) cur = parent;
            return cur;
        }

        static string WinTitleOf(IntPtr h)
        {
            try { StringBuilder sb = new StringBuilder(512); Native.GetWindowText(h, sb, 512); return sb.ToString(); }
            catch { return ""; }
        }

        static string Short(string s, int n)
        {
            if (s == null) return "";
            s = s.Replace("\r", " ").Replace("\n", " ").Trim();
            return s.Length <= n ? s : s.Substring(0, n) + "…";
        }

        /// Remember "this is the window the agent is working in" — set by activate, by every
        /// click (from the window under the click point) and by uiaAct.
        static void SetSticky(IntPtr h)
        {
            IntPtr t = TopLevel(h);
            // The host is never "the window the agent is working in": 2026-09-12 the sticky
            // target followed the host window and the next click went into it. Click/activate
            // already refuse a host window, so this only removes the retry path.
            if (t != IntPtr.Zero && Native.IsWindow(t) && !IsHostWindow(t)) _stickyHwnd = t;
        }

        static uint PidOf(IntPtr h) { uint pid = 0; try { Native.GetWindowThreadProcessId(h, out pid); } catch { } return pid; }

        // ---------- host guard: never drive the process that spawned us ----------
        // index.js spawns this worker FROM the DSH host process and hands it two facts about
        // that host: DSH_CU_HOST_PID (the parent's own pid) and DSH_CU_HOST_EXE (its
        // executable). The host is Electron, so the window a human actually interacts with
        // belongs to a DIFFERENT process of the same application (main / renderer / GPU) than
        // the parent pid - matching the IMAGE PATH catches all of them at once, the pid is the
        // narrower second condition. 2026-09-12: the human typed into the DSH chat window, it
        // took the foreground, the sticky target followed it and a click was delivered INTO the
        // host. Driving the host must be impossible, so every op that resolves a VICTIM window
        // (the pixel it would click, the window that owns the foreground, the window it would
        // move/close) asks here first and refuses BEFORE any input is sent. Observation-only
        // ops (capture, uia, probe, windows, focus, ...) never ask, so looking at the host stays
        // allowed. Both variables absent, or a pid <= 0, means the guard is disabled - a one-shot
        // CLI worker started by hand from a shell keeps working exactly as before.
        static int _hostPid = -1;          // -1 = not read yet, 0 = guard disabled
        static string _hostExe = null;     // null = no path condition
        static bool _hostCfgRead = false;

        static void HostGuardInit()
        {
            if (_hostCfgRead) return;
            _hostCfgRead = true;
            try
            {
                string s = Environment.GetEnvironmentVariable("DSH_CU_HOST_PID");
                int p;
                if (!string.IsNullOrEmpty(s) && int.TryParse(s.Trim(), out p) && p > 0) _hostPid = p;
                else _hostPid = 0;
            }
            catch { _hostPid = 0; }
            try
            {
                string e = Environment.GetEnvironmentVariable("DSH_CU_HOST_EXE");
                _hostExe = string.IsNullOrEmpty(e) ? null : e.Trim();
            }
            catch { _hostExe = null; }
        }

        /// Full image path of a process. Deliberately NOT Process.GetProcessById(pid).MainModule:
        /// that throws for every process this worker may not read, which would turn a lookup
        /// failure into a refusal. Here an unreadable process simply does not match.
        static string ProcessImagePath(uint pid)
        {
            IntPtr hp = IntPtr.Zero;
            try
            {
                hp = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (hp == IntPtr.Zero) return null;
                int cap = 1024;
                StringBuilder sb = new StringBuilder(cap);
                int len = cap;
                if (!Native.QueryFullProcessImageName(hp, 0, sb, ref len)) return null;
                return sb.ToString(0, len);
            }
            catch { return null; }
            finally { try { if (hp != IntPtr.Zero) Native.CloseHandle(hp); } catch { } }
        }

        /// Why the host exemption did or did not match — one sentence, written once per process.
        ///
        /// 2026-09-14: a keystroke aimed at the DSH CHAT was classified as "typing at some other
        /// window" and braked the machine. The window belonged to pid 51912 while the plugin had
        /// armed the guard with pid 51632 — BOTH `...\DSH Desktop.exe`, i.e. exactly the case the
        /// image-path fallback below exists for — so the fallback (or the variable feeding it) is
        /// what failed, and nothing recorded which. The guard now says so the first time it is asked,
        /// and the brake's evidence carries the same fields, so the next incident is a log line.
        static volatile bool _hostDiagLogged = false;

        static string HostGuardDiag(int pid)
        {
            HostGuardInit();
            string fgPath = ProcessImagePath((uint)pid);
            return "askedPid=" + pid +
                "; armedPid=" + _hostPid +
                "; hostExe=" + (_hostExe == null ? "<null>" : _hostExe) +
                "; askedExe=" + (fgPath == null ? "<unreadable>" : fgPath.Trim()) +
                "; match=" + (((_hostPid > 0 && pid == _hostPid) ? "pid" :
                    (fgPath != null && _hostExe != null &&
                     string.Equals(fgPath.Trim(), _hostExe, StringComparison.OrdinalIgnoreCase)) ? "path" : "none"));
        }

        /// Is this pid the host, or one of the host application's other processes?
        /// A failed or unreadable lookup returns false: the guard must fail OPEN, never blocking
        /// legitimate work because a third-party process could not be opened.
        static bool IsHostPid(int pid)
        {
            if (pid <= 0) return false;
            HostGuardInit();
            if (_hostPid <= 0 && _hostExe == null) return false;
            if (_hostPid > 0 && pid == _hostPid) return true;
            if (_hostExe == null) return false;
            string path = ProcessImagePath((uint)pid);
            bool matched = path != null && string.Equals(path.Trim(), _hostExe, StringComparison.OrdinalIgnoreCase);
            // RECORD ONLY THE INTERESTING MISS (defect R3, found by verify2). A once-per-process
            // record was spent by the FIRST ordinary window the guard ever looked at (measured:
            // askedExe=explorer.exe), so the case this diagnostic exists for — the DSH window itself
            // failing to match — was normally never logged, and every session collected one record
            // that meant nothing. The interesting miss is the one whose image is the SAME FILE NAME
            // as the host's but did not match: that is an Electron sibling process (the exact
            // 2026-09-14 incident: window pid 51912 vs armed 51632, both DSH Desktop.exe).
            bool sameImageName = false;
            try
            {
                if (path != null && _hostExe != null)
                    sameImageName = string.Equals(Path.GetFileName(path.Trim()), Path.GetFileName(_hostExe),
                        StringComparison.OrdinalIgnoreCase);
            }
            catch { }
            if (!matched && sameImageName && !_hostDiagLogged)
            {
                _hostDiagLogged = true;   // once per process: enough to diagnose, never a log storm
                Program.AuditRecord("HOSTGUARD-MISS", HostGuardDiag(pid));
            }
            return matched;
        }

        /// The DSH host's own top-level window — what to raise when the agent has a question.
        ///
        /// The host is Electron, so the plugin's pid is NOT the window's pid; the match is by IMAGE
        /// PATH (IsHostPid), the same rule the guard uses. Several windows share that image
        /// (utility/hidden ones), so the largest visible titled one is the app window.
        public static IntPtr HostMainWindow()
        {
            if (!HostConfigured()) return IntPtr.Zero;
            IntPtr best = IntPtr.Zero; long bestArea = 0;                 // a restored app window
            IntPtr bestIconic = IntPtr.Zero; long bestIconicArea = 0;     // MINIMIZED — still the host
            try
            {
                Native.EnumWindows(delegate(IntPtr h, IntPtr l)
                {
                    try
                    {
                        if (!Native.IsWindowVisible(h)) return true;
                        // IDENTITY FIRST, MINIMIZED OR NOT (desktop finding, 2026-09-13). Skipping
                        // iconic windows made a MINIMIZED DSH invisible to the ask op: HostMainWindow()
                        // returned zero, so nothing was raised and the caret was placed nowhere —
                        // measured hostRaised:false/caretPlaced:false with DSH minimized, while the
                        // same call succeeded with DSH on screen. A minimized window is still the host;
                        // restoring it is the CALLER's job (see AskOp), not a reason to hide it.
                        if (!IsHostWindow(h) || (Native.GetWindowLong(h, -20) & 0x80) != 0) return true;
                        StringBuilder sb = new StringBuilder(512);
                        if (Native.GetWindowText(h, sb, 512) == 0) return true;
                        if (sb.ToString() == "DSH Pet") return true; // legacy pet windows without TOOLWINDOW
                        Dictionary<string, object> wd = WinDict(h);
                        Dictionary<string, object> rr = (Dictionary<string, object>)wd["rect"];
                        long area = Convert.ToInt64(rr["width"]) * Convert.ToInt64(rr["height"]);
                        if (Native.IsIconic(h))
                        {
                            if (area > bestIconicArea) { bestIconicArea = area; bestIconic = h; }
                        }
                        else if (area > bestArea) { bestArea = area; best = h; }
                    }
                    catch { }
                    return true;
                }, IntPtr.Zero);
            }
            catch { }
            // A restored window always wins; the minimized one is the fallback, never nothing.
            return best != IntPtr.Zero ? best : bestIconic;
        }

        /// Put the caret in the DSH composer — a UIA SetFocus, NOT input injection.
        ///
        /// HOST-GUARD EXEMPTION, deliberate and narrow: raising the host and focusing its composer
        /// is the POINT of the ask feature ("切出 DSH 窗口来问我，光标直接落在输入栏"). The guard
        /// exists so the agent never drives its own host BY ACCIDENT while chasing a target; this is
        /// not that. NOTHING here clicks and NOTHING here types: one SetForegroundWindow and one
        /// SetFocus. If it fails it returns false and the human clicks the box themselves.
        /// Diagnostics from the last FocusHostComposer() call. Returned to the agent by the ask op
        /// so a failure carries NUMBERS ("4 Edits, 0 big enough, tree still lazy") instead of a
        /// shrug — the rule that every failed guard must say why it failed.
        public static volatile string CaretDiag = "";

        public static bool FocusHostComposer(IntPtr host)
        {
            try
            {
                // 1. The ROOT itself can be late: FromHandle on a window that has just been raised
                //    sometimes yields nothing at all. Retry before believing it.
                AutomationElement root = null;
                for (int i = 0; i < 10 && root == null; i++)
                {
                    try { root = AutomationElement.FromHandle(host); } catch { }
                    if (root == null) Thread.Sleep(150);
                }
                if (root == null) { CaretDiag = "FromHandle(host) returned null after 10 tries"; return false; }

                double top = 0, bottom = 0;
                try { System.Windows.Rect hr = root.Current.BoundingRectangle; top = hr.Top; bottom = hr.Bottom; } catch { }

                int lastEdit = 0, lastDoc = 0, lastBig = 0;
                for (int attempt = 0; attempt < 8; attempt++)
                {
                    AutomationElement best = null; double bestArea = 0;
                    int edits = 0, docs = 0, big = 0;
                    foreach (ControlType ct in new ControlType[] { ControlType.Edit, ControlType.Document })
                    {
                        AutomationElementCollection found = null;
                        try
                        {
                            found = root.FindAll(TreeScope.Descendants,
                                new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
                        }
                        catch { }
                        if (found == null) continue;
                        foreach (AutomationElement el in found)
                        {
                            if (ct == ControlType.Edit) edits++; else docs++;
                            try
                            {
                                System.Windows.Rect r = el.Current.BoundingRectangle;
                                if (r.IsEmpty) continue;
                                if (r.Width < 300 || r.Height < 24) continue;               // the composer is BIG
                                if (bottom > top && r.Top < top + (bottom - top) * 0.5) continue;  // bottom half only
                                if (!el.Current.IsEnabled) continue;
                                big++;
                                double area = r.Width * r.Height;
                                if (area > bestArea) { bestArea = area; best = el; }
                            }
                            catch { }
                        }
                    }
                    lastEdit = edits; lastDoc = docs; lastBig = big;
                    if (best != null)
                    {
                        // The window must be foreground for SetFocus to take; it was just raised, but
                        // a slow Electron main thread can steal it back, so re-assert and retry.
                        for (int f = 0; f < 5; f++)
                        {
                            try { best.SetFocus(); } catch { }
                            Thread.Sleep(120);
                            bool mine = false;
                            try
                            {
                                AutomationElement focus = AutomationElement.FocusedElement;
                                mine = focus != null && (focus.Equals(best) ||
                                       (best.Current.AutomationId != null &&
                                        best.Current.AutomationId.Length > 0 &&
                                        best.Current.AutomationId == focus.Current.AutomationId));
                            }
                            catch { }
                            if (mine)
                            {
                                CaretDiag = "focused on attempt " + (attempt + 1) + " (edits " + edits +
                                            ", docs " + docs + ", big " + big + ")";
                                return true;
                            }
                        }
                        CaretDiag = "candidate found (edits " + edits + ", docs " + docs + ", big " + big +
                                    ") but SetFocus never took";
                        return false;
                    }
                    // LAZY TREE: nothing matched yet. Give the content process a moment and look again.
                    Thread.Sleep(180);
                }
                CaretDiag = "no candidate after 8 tries (edits " + lastEdit + ", docs " + lastDoc +
                            ", big enough " + lastBig + ") — the tree may still be lazy, or the composer " +
                            "is not Edit/Document";
                return false;
            }
            catch (Exception e) { CaretDiag = "exception: " + e.Message; return false; }
        }

        public static bool IsHostWindow(IntPtr h)   // Panic's human monitor asks this too
        {
            if (h == IntPtr.Zero) return false;
            return IsHostPid(unchecked((int)PidOf(h)));
        }

        /// Did the host identity reach us from the launcher? The keyboard half of the human-presence
        /// monitor is gated on it (see Panic.MonitorHuman / HookCallback): without it we cannot
        /// exempt "the human is talking to the agent in the chat", and braking on every chat message
        /// would be far worse than not monitoring the keyboard at all. The MOUSE half needs no host
        /// identity — a hand on the mouse always yields — so it works immediately, config or not.
        public static bool HostConfigured()
        {
            HostGuardInit();
            return _hostPid > 0 || _hostExe != null;
        }

        static string HostGuardMsg(string op, int pid)
        {
            return "HOST-GUARDED: " + op + " would be delivered to the DSH host window (pid " + pid + "). " +
                   "The agent must never drive its own host — activate the intended application first.";
        }

        /// The refusal itself. It throws, exactly like the click precondition below, so Main
        /// answers through the existing error helper Err(...) -> {"ok":false,"error":"HOST-GUARDED: ..."}
        /// and the Node layer rejects the call with that message. Returning an Err(...) dict from a
        /// handler would NOT work: the dispatcher wraps every handler result in Ok(...).
        static void HostGuard(IntPtr window, string op)
        {
            if (!IsHostWindow(window)) return;
            throw new Exception(HostGuardMsg(op, unchecked((int)PidOf(window))));
        }

        static void HostGuardPid(int pid, string op)
        {
            if (!IsHostPid(pid)) return;
            throw new Exception(HostGuardMsg(op, pid));
        }

        /// For ops whose victim is the window under a POINT: the pixel decides, exactly as the
        /// click path asks WindowFromPoint.
        static void HostGuardPoint(int x, int y, string op)
        {
            POINT p; p.X = x; p.Y = y;
            IntPtr h = IntPtr.Zero;
            try { h = TopLevel(Native.WindowFromPoint(p)); } catch { }
            HostGuard(h, op);
        }

        /// Same, for ops whose target point defaults to wherever the pointer already is.
        static void HostGuardCursor(string op)
        {
            POINT p; Native.GetCursorPos(out p);
            HostGuardPoint(p.X, p.Y, op);
        }

        /// For ops whose victim is whatever owns the FOREGROUND: that is where a synthetic
        /// keystroke actually lands (SendInput is not addressed to a window).
        static void HostGuardForeground(string op)
        {
            IntPtr h = IntPtr.Zero;
            try { h = TopLevel(Native.GetForegroundWindow()); } catch { }
            HostGuard(h, op);
        }

        /// For the window a caller NAMED (expectHwnd / hwnd) or left sticky - the same resolution
        /// FocusReport does, asked BEFORE FocusReport re-asserts it: re-asserting means
        /// SetForegroundWindow, an ALT tap and a titlebar click, so that window must be refused
        /// first or the refusal would arrive after the worker had already driven it.
        static void HostGuardNamed(Dictionary<string, object> a, string op)
        {
            IntPtr want = IntPtr.Zero;
            if (a != null && a.ContainsKey("expectHwnd")) want = new IntPtr(GetI(a, "expectHwnd", 0));
            else if (a != null && a.ContainsKey("hwnd")) want = new IntPtr(GetI(a, "hwnd", 0));
            if (want == IntPtr.Zero) want = _stickyHwnd;
            HostGuard(want, op);
        }

        static string ClassOf(IntPtr h)
        {
            try { StringBuilder cb = new StringBuilder(256); Native.GetClassName(h, cb, 256); return cb.ToString(); }
            catch { return ""; }
        }

        /// Parked off-screen: minimized windows live at -32000, and windows on another virtual
        /// desktop are moved out of reach. Both look "visible" to IsWindowVisible.
        static bool IsOffScreen(IntPtr h)
        {
            try
            {
                RECT r; Native.GetWindowRect(h, out r);
                if (r.Right <= 0 || r.Bottom <= 0 || r.Left >= 32000 || r.Top >= 32000) return true;
                if (Native.IsIconic(h) && r.Left <= -30000) return true;
            }
            catch { }
            return false;
        }

        // ---------- ground truth: what will actually RECEIVE this input? ----------
        //
        // The OS decides where input lands by rules the worker can ASK about instead of guessing:
        //   * a click goes to whatever owns the PIXEL — WindowFromPoint already accounts for
        //     z-order, WS_EX_TRANSPARENT click-through and disabled windows;
        //   * a keystroke goes to whatever owns the FOCUS;
        //   * and in both cases the integrity level (UIPI) can discard the event with NO error.
        //
        // One probe answers all of it. This is deliberately NOT a list of special cases — covered,
        // click-through, off-screen, minimized, stale rect, disabled, hung, elevated, on another
        // desktop — those are simply the FIELDS the report exposes. So a mismatch is always a
        // NAMED mismatch (with the window, pid and reason) instead of a mystery. That is the
        // general capability: 2026-09-13 the human hid the target window behind another one and
        // every click landed on the cover while every tool call reported success.
        static Dictionary<string, object> WinBrief(IntPtr h)
        {
            if (h == IntPtr.Zero || !Native.IsWindow(h)) return null;
            RECT r; Native.GetWindowRect(h, out r);
            uint pid = PidOf(h);
            string proc = null;
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            int ex = 0;
            try { ex = Native.GetWindowLong(h, -20); } catch { }
            bool icon = false, vis = false, en = false, hung = false;
            try { icon = Native.IsIconic(h); } catch { }
            try { vis = Native.IsWindowVisible(h); } catch { }
            try { en = Native.IsWindowEnabled(h); } catch { }
            try { hung = Native.IsHungAppWindow(h); } catch { }
            bool off = (r.Right <= 0 || r.Bottom <= 0 || r.Left >= 32000 || r.Top >= 32000 || (icon && r.Left <= -30000));
            Dictionary<string, object> d = Dict(
                "hwnd", h.ToInt64(), "pid", pid, "process", proc,
                "class", ClassOf(h), "title", Short(WinTitleOf(h), 60),
                "rect", RectDict(r),
                "visible", vis, "enabled", en, "minimized", icon, "offScreen", off, "hung", hung,
                // WS_EX_TRANSPARENT = the window is CLICK-THROUGH: the input goes to what is below
                "clickThrough", (ex & 0x20) != 0,
                "layered", (ex & 0x80000) != 0,
                "topmost", (ex & 0x8) != 0);
            if (pid != 0 && ProcessElevated(pid) && !SelfElevated()) d["elevated"] = true;
            try { d["dpi"] = Native.GetDpiForWindow(h); } catch { }
            return d;
        }

        static List<object> AncestorsOf(AutomationElement e, int hops)
        {
            List<object> anc = new List<object>();
            try
            {
                TreeWalker walker = TreeWalker.ControlViewWalker;
                AutomationElement cur = walker.GetParent(e);
                int n = 0;
                while (cur != null && !AutomationElement.Equals(cur, AutomationElement.RootElement) && n < hops)
                {
                    anc.Add(ElemDict(cur));
                    cur = walker.GetParent(cur);
                    n++;
                }
            }
            catch { }
            return anc;
        }

        /// "Who owns this pixel, and what would a click there actually do?" — text only.
        static Dictionary<string, object> ProbePoint(int x, int y)
        {
            POINT p; p.X = x; p.Y = y;
            IntPtr leaf = IntPtr.Zero, root = IntPtr.Zero;
            try { leaf = Native.WindowFromPoint(p); } catch { }
            try { root = TopLevel(leaf); } catch { }

            List<object> chain = new List<object>();
            IntPtr cur = leaf;
            int guard = 0;
            while (cur != IntPtr.Zero && guard++ < 12)
            {
                Dictionary<string, object> b = WinBrief(cur);
                if (b != null) chain.Add(b);
                IntPtr parent = Native.GetParent(cur);
                if (parent == IntPtr.Zero) break;
                cur = parent;
            }

            Dictionary<string, object> d = Dict("point", Dict("x", x, "y", y));
            object leafB = leaf == IntPtr.Zero ? null : (object)WinBrief(leaf);
            d["receives"] = leafB;                     // the window a click would be delivered to
            d["root"] = root == IntPtr.Zero ? null : (object)WinBrief(root);
            d["chain"] = chain;                        // leaf -> ... -> root
            // the APPLICATION-level answer (may be a descendant of `receives`)
            try
            {
                AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                if (e != null)
                {
                    Dictionary<string, object> ed = ElemDict(e);
                    ed["ancestors"] = AncestorsOf(e, 4);
                    d["element"] = ed;
                }
            }
            catch { }
            // focus context: a keystroke never goes to the pixel, it goes to the focus
            try
            {
                AutomationElement f = AutomationElement.FocusedElement;
                if (f != null)
                {
                    Dictionary<string, object> fd = ElemDict(f);
                    fd["editable"] = Editable(f);
                    d["focused"] = fd;
                    d["typingWouldReach"] = SameProcess(f, root);
                }
            }
            catch { }
            return d;
        }

        /// "Who would receive a keystroke right now, and can it even hold text?" — text only.
        static Dictionary<string, object> ProbeFocus()
        {
            IntPtr fg = Native.GetForegroundWindow();
            IntPtr root = TopLevel(fg);
            Dictionary<string, object> d = Dict("foreground", root == IntPtr.Zero ? null : (object)WinBrief(root));
            try
            {
                AutomationElement f = AutomationElement.FocusedElement;
                if (f != null)
                {
                    Dictionary<string, object> fd = ElemDict(f);
                    fd["editable"] = Editable(f);
                    fd["ancestors"] = AncestorsOf(f, 4);
                    d["focused"] = fd;
                    d["sameProcessAsForeground"] = SameProcess(f, root);
                }
                else d["focused"] = null;
            }
            catch (Exception ex) { d["focusedError"] = ex.Message; }
            return d;
        }

        static bool Editable(AutomationElement e)
        {
            try
            {
                foreach (AutomationPattern ap in e.GetSupportedPatterns())
                    if (ap == ValuePattern.Pattern || ap == TextPattern.Pattern) return true;
            }
            catch { }
            return false;
        }

        /// Does this element live inside that window's process? (menus/popups share the process)
        static bool SameProcess(AutomationElement e, IntPtr root)
        {
            try
            {
                int pid = e.Current.ProcessId;
                return pid != 0 && pid == (int)PidOf(root);
            }
            catch { return false; }
        }

        static bool ProcessElevated(uint pid)
        {
            if (pid == 0) return false;
            IntPtr proc = IntPtr.Zero, tok = IntPtr.Zero;
            try
            {
                proc = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (proc == IntPtr.Zero) return false;
                if (!Native.OpenProcessToken(proc, Native.TOKEN_QUERY, out tok)) return false;
                uint info, ret;
                if (!Native.GetTokenInformation(tok, Native.TokenElevation, out info, 4, out ret)) return false;
                return info != 0;
            }
            catch { return false; }
            finally
            {
                if (tok != IntPtr.Zero) { try { Native.CloseHandle(tok); } catch { } }
                if (proc != IntPtr.Zero) { try { Native.CloseHandle(proc); } catch { } }
            }
        }

        static bool _selfElevated = false, _selfElevatedKnown = false;
        static bool SelfElevated()
        {
            if (!_selfElevatedKnown)
            {
                try { _selfElevated = ProcessElevated((uint)Process.GetCurrentProcess().Id); } catch { }
                _selfElevatedKnown = true;
            }
            return _selfElevated;
        }

        /// The activation ladder, shared by `activate` and the focus guard.
        /// Returns the method that worked, or null.
        static string RefocusWindow(IntPtr h, bool clickFallback)
        {
            if (h == IntPtr.Zero || !Native.IsWindow(h)) return null;
            bool wasTopmost = (Native.GetWindowLong(h, -20) & 8) != 0;
            try { return RefocusWindowCore(h, clickFallback, wasTopmost); }
            finally
            {
                // Activation must not demote an existing floating pet, even if
                // an earlier foreground method returned or threw before fallback.
                if (wasTopmost && Native.IsWindow(h) && (Native.GetWindowLong(h, -20) & 8) == 0)
                    Native.SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200);
            }
        }

        static string RefocusWindowCore(IntPtr h, bool clickFallback, bool wasTopmost)
        {
            CheckHumanInput();
            if (h == IntPtr.Zero || !Native.IsWindow(h)) return null;
            if (!Native.IsWindowVisible(h)) Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE);
            if (Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_RESTORE);
            Thread.Sleep(40);
            CheckHumanInput();
            if (IsForeground(h)) return "already-foreground";

            // 1. Become the owner of the LAST INPUT event. Windows releases the foreground lock for
            //    that process, which is THE documented reason SetForegroundWindow silently fails
            //    while another app is in front. (2026-09-13: the agent host re-took the foreground
            //    after every rendered image, and neither SetForegroundWindow, SwitchToThisWindow
            //    nor a title-bar click could win the target window back — the agent simply could
            //    not reach the window it was told to work in.)
            try { SendKey(Native.VK_MENU, false); Thread.Sleep(30); SendKey(Native.VK_MENU, true); Thread.Sleep(30); } catch { }

            CheckHumanInput();

            IntPtr fg = Native.GetForegroundWindow();
            uint fgPid;
            uint fgThread = Native.GetWindowThreadProcessId(fg, out fgPid);
            uint myThread = Native.GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (fgThread != myThread) attached = Native.AttachThreadInput(fgThread, myThread, true);
                CheckHumanInput();
                Native.SetForegroundWindow(h);
            }
            finally { if (attached) Native.AttachThreadInput(fgThread, myThread, false); }
            Thread.Sleep(80);
            if (IsForeground(h)) return "SetForegroundWindow(last-input)";

            CheckHumanInput();
            Native.SwitchToThisWindow(h, true);
            Thread.Sleep(80);
            if (IsForeground(h)) return "SwitchToThisWindow";

            // 2. Temporarily promote normal windows, preserving pre-existing
            //    topmost windows (pets/tool overlays) on success and failure.
            try
            {
                try
                {
                    CheckHumanInput();
                    Native.SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
                    Thread.Sleep(70);
                    CheckHumanInput();
                    Native.SetForegroundWindow(h);
                    Thread.Sleep(70);
                }
                finally
                {
                    if (Native.IsWindow(h)) Native.SetWindowPos(h, new IntPtr(wasTopmost ? -1 : -2), 0, 0, 0, 0,
                        0x0001 | 0x0002 | 0x0010 | 0x0200); // restore without focus or owner-z changes
                }
                Thread.Sleep(60);
            }
            catch { }
            CheckHumanInput();
            if (IsForeground(h)) return "topmost-toggle";

            if (!clickFallback) return null;
            // 3. Last resort: a REAL click on the title bar — but ONLY when that pixel is actually
            //    ours. If the window is covered there, clicking would hand the foreground to the
            //    covering window instead of to the target (exactly backwards).
            RECT r; Native.GetWindowRect(h, out r);
            int cx = r.Left + Math.Max(40, (r.Right - r.Left) / 4);
            int cy = r.Top + Math.Max(8, Math.Min(14, (r.Bottom - r.Top) / 20));
            POINT cp; cp.X = cx; cp.Y = cy;
            IntPtr owner = IntPtr.Zero;
            try { owner = TopLevel(Native.WindowFromPoint(cp)); } catch { }
            if (owner != h) return null;
            AnimatedMove(cx, cy, 180);
            Thread.Sleep(50);
            SendMouse(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
            Thread.Sleep(30);
            SendMouse(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0);
            Thread.Sleep(140);
            if (IsForeground(h)) return "titlebar-click";
            return null;
        }

        /// Focus contract for every keyboard op. Returns a report the model can READ (no
        /// screenshot needed): which window owns the foreground, whether it matched the
        /// intended target, whether it had to be re-asserted, and whether the target is out of
        /// reach because of integrity levels.
        static Dictionary<string, object> FocusReport(Dictionary<string, object> a, bool refocus)
        {
            IntPtr want = IntPtr.Zero;
            if (a != null && a.ContainsKey("expectHwnd")) want = new IntPtr(GetI(a, "expectHwnd", 0));
            else if (a != null && a.ContainsKey("hwnd")) want = new IntPtr(GetI(a, "hwnd", 0));
            if (want == IntPtr.Zero) want = _stickyHwnd;
            if (refocus)
            {
                string missing = KickoffFocus.InputProblem(want.ToInt64(),
                    want != IntPtr.Zero && Native.IsWindow(want), want.ToInt64());
                if (missing != null) throw new Exception("INPUT-TARGET-REFUSED: " + missing + ". The requested input was not sent.");
            }

            string repaired = null;
            IntPtr fg = Native.GetForegroundWindow();
            if (refocus && want != IntPtr.Zero && TopLevel(fg) != want)
            {
                repaired = RefocusWindow(want, true);
                Thread.Sleep(50);
                fg = Native.GetForegroundWindow();
            }
            IntPtr root = TopLevel(fg);
            if (refocus)
            {
                string mismatch = KickoffFocus.InputProblem(want.ToInt64(),
                    want != IntPtr.Zero && Native.IsWindow(want), root.ToInt64());
                if (mismatch != null) throw new Exception("INPUT-TARGET-REFUSED: " + mismatch + ". The requested input was not sent.");
            }
            uint pid = PidOf(root);
            Dictionary<string, object> rep = Dict(
                "hwnd", root.ToInt64(),
                "title", WinTitleOf(root),
                "pid", pid,
                "expected", want == IntPtr.Zero ? null : (object)want.ToInt64(),
                "match", want == IntPtr.Zero ? null : (object)(root == want),
                "refocused", repaired);
            if (ProcessElevated(pid) && !SelfElevated())
                rep["warning"] = "ELEVATED TARGET: the foreground window belongs to an elevated process (pid " + pid +
                    ") while this worker is not elevated — Windows (UIPI) silently discards synthetic input to it. " +
                    "Nothing was typed/clicked as far as the target is concerned. Fix: run that app and DSH at the same elevation.";
            return rep;
        }



        static Dictionary<string, object> WindowOp(Dictionary<string, object> a)
        {
            IntPtr h = FindHwnd(a);
            if (h == IntPtr.Zero) throw new Exception("window not found");
            HostGuard(h, "windowOp");
            string op = GetS(a, "op", "minimize");
            AgentActing(a, "windowOp");
            MarkMutation();
            switch (op)
            {
                case "minimize": Native.ShowWindow(h, Native.SW_MINIMIZE); break;
                case "maximize": Native.ShowWindow(h, Native.SW_MAXIMIZE); break;
                case "restore": Native.ShowWindow(h, Native.SW_RESTORE); break;
                // deterministic placement — no mouse involved, so a coordinate test can move the
                // target to an ARBITRARY (x,y,size) and re-derive its element map from UIA.
                case "move":
                {
                    RECT cur; Native.GetWindowRect(h, out cur);
                    int mx = GetI(a, "x", cur.Left), my = GetI(a, "y", cur.Top);
                    int mw = GetI(a, "width", cur.Right - cur.Left), mh = GetI(a, "height", cur.Bottom - cur.Top);
                    if (Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_RESTORE);
                    Native.SetWindowPos(h, IntPtr.Zero, mx, my, mw, mh, 0x0004 | 0x0010); // NOZORDER | NOACTIVATE
                    Thread.Sleep(140);
                    RECT nr; Native.GetWindowRect(h, out nr);
                    return Dict("done", "move", "rect", RectDict(nr));
                }
                case "close": Native.SendNotifyMessage(h, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero); break;
                default: throw new Exception("op must be minimize|maximize|restore|close");
            }
            Thread.Sleep(80);
            return Dict("done", op);
        }

        // ---------- UIA ----------
        static Dictionary<string, object> ElemDict(AutomationElement e)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            string name = "";
            try { name = e.Current.Name ?? ""; } catch { }
            if (name.Length > 160) name = name.Substring(0, 160);
            string ctype = "";
            try { if (e.Current.ControlType != null) ctype = e.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); }
            catch { }
            System.Windows.Rect r = e.Current.BoundingRectangle;
            d["name"] = name;
            d["role"] = ctype;
            d["rect"] = Dict("x", (int)r.X, "y", (int)r.Y, "width", (int)r.Width, "height", (int)r.Height);
            try { d["automationId"] = e.Current.AutomationId; } catch { }
            try { d["className"] = e.Current.ClassName; } catch { }
            try { d["runtimeId"] = String.Join(".", e.GetRuntimeId()); d["pid"] = e.Current.ProcessId; } catch { }
            try { d["isPassword"] = e.Current.IsPassword; } catch { }
            try
            {
                List<string> pats = new List<string>();
                foreach (AutomationPattern p in e.GetSupportedPatterns())
                {
                    // "ValuePatternIdentifiers." / "InvokePattern" → clean short names
                    string s = p.ProgrammaticName.Replace("PatternIdentifiers", "").Replace("Pattern", "").TrimEnd('.', ' ');
                    if (s.Length > 0) pats.Add(s);
                }
                d["patterns"] = pats;
            }
            catch { }
            try
            {
                object vp;
                if (e.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) d["value"] = ((ValuePattern)vp).Current.Value;
            }
            catch { }
            return d;
        }

        static Dictionary<string, object> Uia(Dictionary<string, object> a)
        {
            IntPtr root = FindHwnd(a);
            AutomationElement rootEl = root != IntPtr.Zero ? AutomationElement.FromHandle(root) : AutomationElement.RootElement;
            int maxDepth = Math.Max(1, Math.Min(24, GetI(a, "depth", 6)));
            int maxNodes = Math.Max(10, Math.Min(1200, GetI(a, "maxNodes", 300)));
            if (GetB(a, "query", false))
            {
                int scanned; bool truncated;
                List<AutomationElement> matches = FindUiMatches(rootEl, GetS(a, "nameContains", null),
                    GetS(a, "automationId", null), GetS(a, "role", null), maxDepth, maxNodes,
                    Math.Max(1, Math.Min(80, GetI(a, "limit", 80))), out scanned, out truncated);
                List<object> selected = new List<object>();
                string witness = root != IntPtr.Zero && GetB(a, "targets", false) ? UiWindowWitness(root) : null;
                var ancestorCache = new Dictionary<string, List<object>>();
                foreach (AutomationElement match in matches)
                {
                    try {
                        var item = ElemDict(match);
                        if (witness != null) {
                            try { item["target"] = RememberUiTarget(match, root, witness, rootEl, ancestorCache, item); }
                            catch { item["targetUnavailable"] = true; }
                        }
                        selected.Add(item);
                    } catch { truncated = true; }
                }
                if (witness != null && witness != UiWindowWitness(root)) throw new Exception("TARGET_STALE: window changed during observation; retry the query");
                return Dict("flat", selected, "count", selected.Count, "scanned", scanned, "truncated", truncated,
                    "hwnd", root.ToInt64(), "pid", root == IntPtr.Zero ? 0 : PidOf(root));
            }
            List<object> flat = new List<object>();
            bool treeTruncated = false;
            // breadth-first so the first `maxNodes` elements cover the shallow UI evenly
            Queue<KeyValuePair<AutomationElement, int>> q = new Queue<KeyValuePair<AutomationElement, int>>();
            q.Enqueue(new KeyValuePair<AutomationElement, int>(rootEl, 0));
            while (q.Count > 0 && flat.Count < maxNodes)
            {
                KeyValuePair<AutomationElement, int> kv = q.Dequeue();
                try { flat.Add(ElemDict(kv.Key)); }
                catch { treeTruncated = true; continue; }
                if (kv.Value < maxDepth)
                {
                    try
                    {
                        foreach (AutomationElement c in kv.Key.FindAll(TreeScope.Children, Condition.TrueCondition))
                        {
                            if (flat.Count + q.Count >= maxNodes) { treeTruncated = true; break; }
                            q.Enqueue(new KeyValuePair<AutomationElement, int>(c, kv.Value + 1));
                        }
                    }
                    catch { treeTruncated = true; }
                }
                else try { if (kv.Key.FindFirst(TreeScope.Children, Condition.TrueCondition) != null) treeTruncated = true; } catch { treeTruncated = true; }
            }
            return Dict("root", ElemDict(rootEl), "flat", flat, "count", flat.Count, "truncated", treeTruncated || q.Count > 0);
        }

        // Observed native identities are private to this worker, bounded, and never reconstructed
        // from model-supplied names. Rebinding is opt-in and requires complete unique evidence.
        sealed class ObservedUiTarget
        {
            public string Token, Key, Witness, RuntimeId, Evidence, AutoId, Name, Role;
            public IntPtr Hwnd;
            public AutomationElement Element;
            public long At;
        }
        static readonly Dictionary<string, ObservedUiTarget> UiTargets = new Dictionary<string, ObservedUiTarget>();
        static readonly Dictionary<string, string> UiTargetKeys = new Dictionary<string, string>();
        static readonly Queue<string> UiTargetOrder = new Queue<string>();
        static string UiWindowWitness(IntPtr hwnd)
        {
            RECT rect;
            if (!Native.IsWindow(hwnd) || !Native.GetWindowRect(hwnd, out rect)) throw new Exception("TARGET_STALE: window disappeared; no action sent");
            uint pid = PidOf(hwnd);
            long started = Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks;
            return Json.Serialize(new object[] { hwnd.ToInt64(), pid, started, WinTitleOf(hwnd), ClassOf(hwnd), rect.Left, rect.Top, rect.Right, rect.Bottom });
        }
        static string UiText(string text) { return (text ?? "").Normalize(NormalizationForm.FormKC).Trim(); }
        static object UiSemanticPart(AutomationElement element)
        {
            return new object[] { element.Current.ControlType.ProgrammaticName, UiText(element.Current.Name), element.Current.AutomationId, element.Current.ClassName };
        }
        static string UiTargetEvidence(AutomationElement element, IntPtr hwnd)
        {
            return UiTargetEvidence(element, AutomationElement.FromHandle(hwnd), new Dictionary<string, List<object>>(), null);
        }
        static string UiTargetEvidence(AutomationElement element, AutomationElement root, Dictionary<string, List<object>> cache, Dictionary<string, object> item)
        {
            var ancestors = new List<object>();
            AutomationElement current = TreeWalker.ControlViewWalker.GetParent(element);
            string parentId = current == null ? "" : String.Join(".", current.GetRuntimeId());
            if (parentId.Length == 0 || !cache.TryGetValue(parentId, out ancestors)) {
                ancestors = new List<object>();
                bool rooted = Automation.Compare(element, root);
                for (int depth = 0; current != null && depth < 24; depth++) {
                    ancestors.Add(UiSemanticPart(current));
                    if (Automation.Compare(current, root)) { rooted = true; break; }
                    current = TreeWalker.ControlViewWalker.GetParent(current);
                }
                if (!rooted) throw new Exception("TARGET_STALE: control is outside the observed window or ancestry is incomplete");
                if (parentId.Length > 0) cache[parentId] = ancestors;
            }
            if (item == null) item = ElemDict(element);
            var patterns = new List<string>();
            object raw;
            if (!item.TryGetValue("patterns", out raw)) throw new Exception("TARGET_STALE: native patterns unavailable");
            foreach (string pattern in (List<string>)raw) patterns.Add(pattern);
            patterns.Sort(StringComparer.Ordinal);
            // AutomationId is a separate identity channel, so a unique semantic replacement can
            // still be recognized if a provider regenerates IDs. Ancestor identities remain strict.
            return Json.Serialize(new object[] { item["role"], UiText(element.Current.Name),
                item["className"], item["isPassword"], patterns, ancestors });
        }
        static string RememberUiTarget(AutomationElement element, IntPtr hwnd, string witness, AutomationElement root, Dictionary<string, List<object>> cache, Dictionary<string, object> item)
        {
            string runtimeId = GetS(item, "runtimeId", "");
            if (runtimeId.Length == 0) throw new Exception("native control has no runtime identity");
            string evidence = UiTargetEvidence(element, root, cache, item);
            string autoId = GetS(item, "automationId", "");
            string key = Json.Serialize(new object[] { witness, runtimeId, evidence, autoId });
            string existing; ObservedUiTarget old;
            if (UiTargetKeys.TryGetValue(key, out existing) && UiTargets.TryGetValue(existing, out old)) {
                old.Element = element; old.At = NowMs(); return existing;
            }
            string token = "T" + Guid.NewGuid().ToString("N");
            var target = new ObservedUiTarget { Token = token, Key = key, Hwnd = hwnd, Witness = witness, RuntimeId = runtimeId,
                Evidence = evidence, AutoId = autoId, Name = element.Current.Name,
                Role = GetS(item, "role", ""), Element = element, At = NowMs() };
            UiTargets[token] = target; UiTargetKeys[key] = token; UiTargetOrder.Enqueue(token);
            while (UiTargets.Count > 512) {
                string expired = UiTargetOrder.Dequeue(); ObservedUiTarget entry;
                if (UiTargets.TryGetValue(expired, out entry)) { UiTargets.Remove(expired); UiTargetKeys.Remove(entry.Key); }
            }
            return token;
        }
        static ObservedUiTarget GetUiTarget(string token)
        {
            ObservedUiTarget target;
            if (!UiTargets.TryGetValue(token, out target) || NowMs() - target.At > 300000)
                throw NotDispatched("TARGET_STALE", "TARGET_STALE: target expired or worker restarted; query again; no action sent");
            if (target.Witness != UiWindowWitness(target.Hwnd))
                throw NotDispatched("TARGET_STALE", "TARGET_STALE: window identity, title or bounds changed; query again; no action sent");
            return target;
        }
        static AutomationElement ResolveUiTarget(ObservedUiTarget target, bool rebind, int depth, int budget, out string mode, out int seen)
        {
            mode = "runtime-id"; seen = 0;
            try {
                if (String.Join(".", target.Element.GetRuntimeId()) == target.RuntimeId &&
                    target.Element.Current.AutomationId == target.AutoId && UiTargetEvidence(target.Element, target.Hwnd) == target.Evidence)
                    return target.Element;
            } catch { }
            if (!rebind) throw new Exception("TARGET_STALE: observed control was replaced or changed; query again or explicitly request rebind; no action sent");
            var start = AutomationElement.FromHandle(target.Hwnd);
            bool truncated; int visited;
            List<AutomationElement> candidates = new List<AutomationElement>();
            if (!String.IsNullOrEmpty(target.AutoId)) {
                candidates = FindUiMatches(start, null, target.AutoId, null, depth, budget, budget, out visited, out truncated);
                seen += visited;
                if (truncated) throw new Exception("INCOMPLETE_UIA_SEARCH: cannot prove unique target recovery; no action sent");
                if (candidates.Count > 1) throw new Exception("AMBIGUOUS_UIA_TARGET: native identity matches multiple controls; no action sent");
                if (candidates.Count == 1) {
                    if (UiTargetEvidence(candidates[0], target.Hwnd) != target.Evidence)
                        throw new Exception("TARGET_SEMANTICS_CHANGED: native ID now names a different control/context; no action sent");
                    mode = "native-identifier";
                }
            }
            if (candidates.Count == 0) {
                if (String.IsNullOrWhiteSpace(target.Name)) throw new Exception("TARGET_STALE: target has no usable semantic name; no action sent");
                var matches = FindUiMatches(start, target.Name, null, target.Role, depth, budget, budget, out visited, out truncated);
                seen += visited;
                if (truncated) throw new Exception("INCOMPLETE_UIA_SEARCH: cannot prove unique semantic recovery; no action sent");
                foreach (AutomationElement element in matches)
                    if (UiTargetEvidence(element, target.Hwnd) == target.Evidence) candidates.Add(element);
                if (candidates.Count > 1) throw new Exception("AMBIGUOUS_UIA_TARGET: semantic recovery matches multiple controls; no action sent");
                if (candidates.Count == 0) throw new Exception("TARGET_STALE: no control retains the observed identity/context; no action sent");
                mode = "semantic";
            }
            if (target.Witness != UiWindowWitness(target.Hwnd)) throw new Exception("TARGET_STALE: window changed during recovery; no action sent");
            return candidates[0];
        }

        // ---------- low-level UI action: drive a control through its accessibility pattern ----------
        // The cheapest click is the one that never happens. When a control exposes a UIA
        // pattern, pressing it costs one COM call: no pointer travel, no focus games, no zoom
        // level to keep straight — and it either works or throws, so there is nothing to
        // verify with a screenshot. Tabs, buttons, checkboxes, combos, list items and text
        // fields all expose one. Use it for: selecting a browser tab, pressing a dialog
        // button, expanding a dropdown, filling a field.
        static bool ElementMatches(AutomationElement e, string nameFilter, string autoIdFilter, string roleFilter)
        {
            if (autoIdFilter != null && !String.Equals(e.Current.AutomationId, autoIdFilter, StringComparison.Ordinal)) return false;
            if (roleFilter != null && !String.Equals(e.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""), roleFilter, StringComparison.OrdinalIgnoreCase)) return false;
            if (nameFilter != null && (e.Current.Name ?? "").IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) < 0) return false;
            return true;
        }

        // Filter before materializing patterns, values and rectangles. Bounds apply
        // to visited nodes as well as matches, so a rare selector cannot scan forever.
        static List<AutomationElement> FindUiMatches(AutomationElement start, string name, string autoId,
            string role, int depth, int maxNodes, int limit, out int seen, out bool truncated)
        {
            var matches = new List<AutomationElement>();
            var q = new Queue<KeyValuePair<AutomationElement, int>>();
            q.Enqueue(new KeyValuePair<AutomationElement, int>(start, 0));
            seen = 0; truncated = false;
            while (q.Count > 0 && seen < maxNodes)
            {
                var kv = q.Dequeue(); seen++;
                try
                {
                    if (ElementMatches(kv.Key, name, autoId, role))
                    {
                        matches.Add(kv.Key);
                        if (matches.Count >= limit) { truncated = true; break; }
                    }
                    if (kv.Value < depth)
                        foreach (AutomationElement child in kv.Key.FindAll(TreeScope.Children, Condition.TrueCondition))
                        {
                            if (seen + q.Count >= maxNodes) { truncated = true; break; }
                            q.Enqueue(new KeyValuePair<AutomationElement, int>(child, kv.Value + 1));
                        }
                    else if (kv.Key.FindFirst(TreeScope.Children, Condition.TrueCondition) != null)
                        truncated = true;
                }
                catch { truncated = true; }
            }
            if (q.Count > 0) truncated = true;
            return matches;
        }

        static Dictionary<string, object> UiaAct(Dictionary<string, object> a)
        {
            string action = GetS(a, "action", "invoke");
            string token = GetS(a, "target", null);
            ObservedUiTarget observed = token == null ? null : GetUiTarget(token);
            if (observed != null && (GetS(a, "nameContains", null) != null || GetS(a, "automationId", null) != null || GetS(a, "role", null) != null || a.ContainsKey("index")))
                throw new Exception("TARGET_SELECTOR_CONFLICT: use target or selectors, not both; no action sent");
            IntPtr root = observed == null ? FindHwnd(a) : observed.Hwnd;
            if (observed != null && a.ContainsKey("hwnd") && FindHwnd(a) != root) throw new Exception("TARGET_STALE: target belongs to another window; no action sent");
            if (root != IntPtr.Zero) HostGuard(root, "uiaAct");
            AutomationElement start = root != IntPtr.Zero ? AutomationElement.FromHandle(root) : AutomationElement.RootElement;
            string name = GetS(a, "nameContains", null);
            string autoId = GetS(a, "automationId", null);
            string role = GetS(a, "role", null);
            int index = Math.Max(0, GetI(a, "index", 0));
            int depth = Math.Max(1, Math.Min(24, GetI(a, "depth", 12)));
            int maxNodes = Math.Max(20, Math.Min(4000, GetI(a, "maxNodes", 2000)));
            bool unique = GetB(a, "requireUnique", !a.ContainsKey("index"));
            List<object> skipped = new List<object>();
            int seen = 0; bool truncated = false; string resolution = null;
            var matches = observed == null ? FindUiMatches(start, name, autoId, role, depth, maxNodes,
                unique ? 2 : index + 1, out seen, out truncated) : new List<AutomationElement> {
                    ResolveUiTarget(observed, GetB(a, "allowRebind", false), depth, maxNodes, out resolution, out seen) };
            if (unique && matches.Count > 1)
                throw new Exception("AMBIGUOUS_UIA_TARGET: multiple controls match; no action sent. Query computer_uia, then specify hwnd and an exact id.");
            if (unique && truncated)
                throw new Exception("INCOMPLETE_UIA_SEARCH: uniqueness could not be verified; no action sent. Narrow the target window or query with greater depth.");
            AutomationElement found = matches.Count > index ? matches[index] : null;
            if (!unique) for (int i = 0; i < Math.Min(index, matches.Count); i++)
                try { skipped.Add(ElemDict(matches[i])); } catch { }
            if (found == null)
                throw new Exception("uiaAct: no element matched (nameContains=" + (name ?? "-") +
                    ", automationId=" + (autoId ?? "-") + ", role=" + (role ?? "-") +
                    ", index=" + index + ") among " + seen + " elements");

            // This changes the UI, so the human gets the cue — but there is no pointer to
            // fight, so the quiet gate is skipped on purpose.
            // A selector WITHOUT hwnd searches the whole desktop, so there the element that
            // actually matched decides the victim - and a host control is never driven through
            // its automation pattern either.
            int foundPid = 0;
            try { foundPid = found.Current.ProcessId; } catch { }
            HostGuardPid(foundPid, "uiaAct");
            Panic.Check("uiaAct");
            CheckHumanInput();
            Glow.Touch(GetI(a, "indicatorMs", 1200));   // same reason: see AgentActing

            object pat = null;
            string via = null;
            MarkMutation();
            switch (action)
            {
                case "invoke":
                    if (found.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { MarkMutation(); ((InvokePattern)pat).Invoke(); via = "InvokePattern"; }
                    break;
                case "select":
                    if (found.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { MarkMutation(); ((SelectionItemPattern)pat).Select(); via = "SelectionItemPattern"; }
                    break;
                case "expand":
                    if (found.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { MarkMutation(); ((ExpandCollapsePattern)pat).Expand(); via = "ExpandCollapsePattern.Expand"; }
                    break;
                case "collapse":
                    if (found.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { MarkMutation(); ((ExpandCollapsePattern)pat).Collapse(); via = "ExpandCollapsePattern.Collapse"; }
                    break;
                case "toggle":
                    if (found.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { MarkMutation(); ((TogglePattern)pat).Toggle(); via = "TogglePattern"; }
                    break;
                case "setValue":
                    {
                        string val = GetS(a, "value", "");
                        if (found.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) { MarkMutation(); ((ValuePattern)pat).SetValue(val); via = "ValuePattern"; }
                        break;
                    }
                case "focus":
                    MarkMutation(); found.SetFocus(); via = "SetFocus"; break;
                case "scrollIntoView":
                    if (found.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pat)) { MarkMutation(); ((ScrollItemPattern)pat).ScrollIntoView(); via = "ScrollItemPattern"; }
                    break;
                default:
                    throw new Exception("action must be invoke|select|expand|collapse|toggle|setValue|focus|scrollIntoView");
            }
            if (via == null)
                throw new Exception("element does not support '" + action + "': " + ElemDict(found)["name"]);

            Thread.Sleep(GetI(a, "settleMs", 120));
            Dictionary<string, object> res = Dict("action", action, "via", via, "element", ElemDict(found), "scanned", seen);
            if (observed != null) res["resolution"] = Dict("target", token, "mode", resolution, "rebound", resolution != "runtime-id");
            if (skipped.Count > 0) res["skippedEarlierMatches"] = skipped;
            return res;
        }

        /// **The agent ends the session by itself** — the programmatic twin of Ctrl+Alt+Q.
        ///
        /// It exists because the ask protocol hands the decision back to the agent ("if you cannot
        /// proceed, stop like Ctrl+Alt+Q") and until now there was no way to SAY Q. Semantics are
        /// exactly the human's key: the EXITED latch is persisted, the border and every monitor go
        /// silent, and the plugin cancels the turn. That is NOT a brake — a brake is temporary and
        /// Ctrl+Alt+R clears it; this is final until an agent drives this machine again.
        ///
        /// Reachable while stopped (see CheckOp) on purpose: after an ask the agent IS stopped, and
        /// that is precisely when it must be able to answer "I cannot proceed".
        static Dictionary<string, object> ExitOp(Dictionary<string, object> a)
        {
            string why = GetS(a, "why", "could not proceed");
            Panic.Exit("the agent ended the session on its own: " + why, "agent",
                       "requested by the agent (this is NOT a human key press)");
            return Dict("exited", true, "why", why,
                "note", "The session is over: no border, no monitors, and the plugin cancels this " +
                        "turn. It re-opens only when an agent drives this machine again.");
        }

        // >>>BEGIN-ASK-OPS<<<
        /// **The agent stops the machine to ask ONE question** (human spec 2026-09-12; merged with
        /// the client-UI answer path 2026-09-14 — merge-design.md §1, §2.1).
        ///
        /// Only for the rare case where the agent is genuinely blocked on a decision it must not
        /// make alone. It is a brake the human did not raise, so it is built to be impossible to
        /// confuse with one they did: RED but breathing at twice the cyan rate, and the session
        /// title says plainly where the answer is given.
        ///
        /// **THERE IS NO CLOCK HERE AND NO WAIT.** This op ENGAGES the brake and RETURNS, in well
        /// under a second; the waiting happens on the plugin side, on the client-UI card, with no
        /// countdown at all. The old body held the worker's single-threaded op loop for the whole
        /// 60 s window, which is why a second op written to stdin was never answered while a
        /// question was open (verify4 §3.B) and why a caller-side timeout could kill the worker
        /// while it still held the brake — the leak this merge removes. A loop or a clock read in
        /// this method re-creates both, which is what guard G1 asserts against.
        ///
        /// `timeoutMs` is still ACCEPTED and IGNORED, so an older caller's argument cannot make the
        /// op throw; the reply no longer contains a `timeoutMs` field (G6: the old reply returned
        /// `"timeoutMs", 0` to the model while the doc comment promised it waited that long).
        static Dictionary<string, object> BeginAskOp(Dictionary<string, object> a)
        {
            string q = GetS(a, "question", "");
            if (q == null || q.Trim().Length == 0) throw new Exception("question required");

            Panic.EngageAsk(q);            // STOP file + fast-breathing red + notify("ask")
            if (!Panic.Engaged)
                throw new Exception("NO-CYCLE: an ask belongs to a LIVE computer-use cycle and there " +
                    "is none right now (or another stop owns the machine). Nothing was displayed, " +
                    "nothing was stopped, and the human was not disturbed.");
            int askId = Panic.AskId;       // THIS ask owns the window: every ending must present this id

            IntPtr host = HostMainWindow();
            bool raised = false, caret = false;
            if (host != IntPtr.Zero)
            {
                // RESTORE FIRST, THEN RAISE, THEN VERIFY (desktop finding, 2026-09-13). SetForegroundWindow
                // on a MINIMIZED window does nothing, so an ask in that state was raised at nobody and
                // the caret was never placed — the design ("切出 DSH 提问，光标落在输入框") silently did
                // not happen. And a "raised" flag set because we CALLED the API is worthless: the
                // window is asked whether it is really up and in front, and the answer is reported.
                bool wasIconic = false;
                try { wasIconic = Native.IsIconic(host); } catch { }
                if (wasIconic)
                {
                    try { Native.ShowWindow(host, Native.SW_RESTORE); } catch { }
                    Thread.Sleep(180);          // the restore animation/placement needs a beat
                }
                try { Native.SetForegroundWindow(host); } catch { }
                Thread.Sleep(260);              // Electron needs a beat before its tree answers
                IntPtr fg = IntPtr.Zero; bool pidMatch = false;
                try
                {
                    fg = Native.GetForegroundWindow();
                    uint fgPid = 0, hostPid = 0;
                    Native.GetWindowThreadProcessId(fg, out fgPid);
                    Native.GetWindowThreadProcessId(host, out hostPid);
                    pidMatch = fgPid != 0 && fgPid == hostPid;
                }
                catch { }
                try { raised = !Native.IsIconic(host) && (fg == host || pidMatch); } catch { raised = false; }
                // The caret may only be claimed from a window that is REALLY in front: searching a
                // background window's UIA tree would happily find a composer nobody can see (and
                // FocusHostComposer does not check the foreground itself).
                if (raised) caret = FocusHostComposer(host);
                else CaretDiag = "window not raised (wasIconic=" + (wasIconic ? "1" : "0") +
                    " fgMatchesHostPid=" + (pidMatch ? "1" : "0") + " fg=0x" + fg.ToInt64().ToString("X") +
                    " host=0x" + host.ToInt64().ToString("X") +
                    ") — the composer was NOT searched: a textbox found in a background window is not focus";
            }

            // THE REPLY REPORTS WHAT *THIS* CALL DID, never a state the worker no longer judges
            // (native finding, 2026-09-13, kept through the merge): `engaged` is verified above, and
            // `stopped` is the measured fact that a brake is now on disk and every process obeys it.
            // The ENDING is not reported here — it arrives through `endAsk`, from the plugin's
            // `finally`, which is the only place any ending is allowed to finish.
            return Dict(
                "askId", askId,
                "engaged", true,
                "question", q,
                "hostRaised", raised,
                "caretPlaced", caret,
                "caretDiag", CaretDiag,
                "stopped", Panic.Stopped,
                "note", "The brake is ENGAGED and this op returned immediately: the machine is " +
                        "stopped, the border breathes red, and the question is on the client-UI card. " +
                        "The answer comes from that card — there is no countdown and nothing to wait " +
                        "for here.");
        }

        /// **The question is over: release the brake (or keep it, because the human said so).**
        ///
        /// The plugin calls this from the `finally` of the one `try` that contains `beginAsk`, so
        /// EVERY ending goes through it: the answered card, the dismissed card, an aborted turn, the
        /// tool deadline, and the answer channel throwing. It is issued with `killOnTimeout: false`,
        /// because killing the worker here would be an ending with no release — the one thing this
        /// whole design exists to remove.
        ///
        /// `keepPause` is the HUMAN's decision under D3 (the card offers ①让你停 / ②放你走), not a
        /// derivation from `via`: `via` is an audit label and decides nothing.
        static Dictionary<string, object> EndAskOp(Dictionary<string, object> a)
        {
            int askId = GetI(a, "askId", -1);
            string via = GetS(a, "via", "ok");
            bool keepPause = GetB(a, "keepPause", false);
            Panic.EndAsk(askId, keepPause, via);
            // READ THE STATE AFTER THE ENDING, never a derivation from what we asked for (native
            // finding, 2026-09-13): a release that refused — because the brake changed hands, or the
            // file would not come off disk — leaves the machine STOPPED, and a reply of "released"
            // would be a lie the agent then acts on. `released` means the STOP FILE IS GONE; callers
            // read `stopped`/`exited` for state and never infer it from `released`.
            bool exists = false;
            try { exists = File.Exists(Panic.StopFilePath); } catch { exists = false; }
            bool stopped = Panic.Stopped;
            string reason = Panic.Exited ? "exited"
                : (keepPause && stopped && exists) ? "kept-pause"
                : (!exists && !stopped) ? "released"
                : "stop-locked";
            return Dict(
                "released", !exists,
                "reason", reason,
                "stopped", stopped,
                "exited", Panic.Exited,
                "cycleLit", Panic.CycleLit,
                "releaseNote", exists
                    ? "the STOP file is still on disk: the brake stands and only the human's Ctrl+Alt+R " +
                      "or the orphan sweep can clear it (the audit log names which branch ran)"
                    : "the STOP file is verified gone");
        }
        // >>>END-ASK-OPS<<<

        static Dictionary<string, object> UiaFromPoint(Dictionary<string, object> a)
        {
            int x = GetI(a, "x", int.MinValue), y = GetI(a, "y", int.MinValue);
            if (x == int.MinValue) throw new Exception("x,y required");
            // The hit test IS the ground-truth probe: which window owns the pixel, which element
            // the app thinks is there, and who would receive a keystroke right now.
            Dictionary<string, object> p = ProbePoint(x, y);
            try
            {
                object el;
                if (p.TryGetValue("element", out el) && el is Dictionary<string, object>)
                {
                    object anc;
                    if (((Dictionary<string, object>)el).TryGetValue("ancestors", out anc)) p["ancestors"] = anc;
                }
            }
            catch { }
            if (!p.ContainsKey("element")) p["element"] = null;
            if (!p.ContainsKey("ancestors")) p["ancestors"] = new List<object>();
            return p;
        }

        static Dictionary<string, object> UiaFocused()
        {
            AutomationElement e = AutomationElement.FocusedElement;
            if (e == null) return Dict("element", null);
            return Dict("element", ElemDict(e));
        }

        // ---------- wait ----------
        static string WinSig()
        {
            IntPtr fg = Native.GetForegroundWindow();
            StringBuilder sb = new StringBuilder(512); Native.GetWindowText(fg, sb, 512);
            string focused = "";
            try
            {
                AutomationElement f = AutomationElement.FocusedElement;
                string ct = "";
                if (f.Current.ControlType != null) ct = f.Current.ControlType.ProgrammaticName;
                focused = (f.Current.Name ?? "") + "|" + ct;
            }
            catch { }
            return fg.ToString() + "|" + sb.ToString() + "|" + focused;
        }

        static Dictionary<string, object> WaitForIdle(Dictionary<string, object> a)
        {
            int timeoutMs = Math.Max(100, GetI(a, "timeoutMs", 5000));
            int stableMs = Math.Max(100, GetI(a, "stableMs", 350));
            int pollMs = Math.Max(50, GetI(a, "pollMs", 120));
            string lastSig = WinSig();
            Stopwatch since = Stopwatch.StartNew();
            Stopwatch stable = Stopwatch.StartNew();
            while (since.ElapsedMilliseconds < timeoutMs)
            {
                Thread.Sleep(pollMs);
                string sig = WinSig();
                if (sig == lastSig)
                {
                    if (stable.ElapsedMilliseconds >= stableMs)
                        return Dict("idle", true, "waitedMs", since.ElapsedMilliseconds);
                }
                else { lastSig = sig; stable.Restart(); }
            }
            return Dict("idle", false, "waitedMs", since.ElapsedMilliseconds, "timeout", true);
        }

        // ---------- helpers ----------
        static void FailsafeCheck(Dictionary<string, object> a)
        {
            // Compatibility entry point: no coordinate/frequency/quietMs override can
            // disable the event-driven handoff. Plain Esc and the screen corner are ordinary UI.
            CheckHumanInput();
            Panic.AgentActed();
        }

        public static Dictionary<string, object> Dict(params object[] kv)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }
        static int GetI(Dictionary<string, object> d, string k, int def)
        {
            object v;
            // `v != null` IS LOAD-BEARING (screenshot bug, 2026-09-15). Convert.ToInt32(null) returns
            // 0, NOT the default — so an argument the caller left unset arrived as JSON null and became
            // the coordinate ZERO, not "use the default region". The plugin serialises an undefined
            // option as `"x":null`, so EVERY plain screenshot asked for the region (0,0,…) and the
            // default full-virtual-screen path was unreachable: `computer_shot` failed with "region
            // outside virtual desktop" while the same op with the keys ABSENT succeeded (measured:
            // null -> FAIL, absent -> ok 121,545 bytes). GetS below always had this guard; GetI did not.
            try { if (d.TryGetValue(k, out v) && v != null) return Convert.ToInt32(v); } catch { }
            return def;
        }
        static string GetS(Dictionary<string, object> d, string k, string def)
        {
            object v;
            try { if (d.TryGetValue(k, out v) && v != null) return v.ToString(); } catch { }
            return def;
        }
        static bool GetB(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            try { if (d.TryGetValue(k, out v)) return Convert.ToBoolean(v); } catch { }
            return def;
        }
        static double GetD(Dictionary<string, object> d, string k, double def)
        {
            object v;
            try { if (d.TryGetValue(k, out v)) return Convert.ToDouble(v); } catch { }
            return def;
        }
        static Dictionary<string, object> PtDict(int x, int y) { return Dict("x", x, "y", y); }
        static Dictionary<string, object> Ok(object data)
        {
            Dictionary<string, object> r = Dict("ok", true);
            if (data != null) r["data"] = data;
            return r;
        }
        static Exception NotDispatched(string code, string message)
        {
            var error = new Exception(message);
            error.Data["code"] = code;
            error.Data["outcome"] = "not-dispatched";
            return error;
        }
        static Dictionary<string, object> Err(Exception error)
        {
            var result = Err(error.Message);
            if (error.Data["code"] != null)
            {
                result["code"] = (string)error.Data["code"];
                result["outcome"] = error.Data["outcome"] ?? "unknown";
            }
            foreach (string key in new string[] { "keyCleanup", "clipboardRestore" })
                if (error.Data[key] != null)
                {
                    result[key] = error.Data[key];
                    result["error"] = (string)result["error"] + "; " + key + "=" + error.Data[key];
                }
            return result;
        }
        static Dictionary<string, object> Err(string msg) { return Dict("ok", false, "error", msg); }
        static void WriteLine(string s) { lock (OutLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
    }
}
