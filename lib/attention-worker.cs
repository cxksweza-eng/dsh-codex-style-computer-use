// C# 5, Windows inbox .NET Framework only. No input injection or attached queues.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class AttentionWorker
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; public POINT(int x, int y) { X=x; Y=y; } }
    [StructLayout(LayoutKind.Sequential)] struct FLASH { public uint size; public IntPtr hwnd; public uint flags, count, timeout; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ENTRY {
        public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
    }
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder title, int length);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int n);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int t, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASH f);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr p, int flags, StringBuilder b, ref int n);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr s, ref ENTRY e);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr s, ref ENTRY e);

    const uint POSITION = 0x0001 | 0x0002 | 0x0010 | 0x0200 | 0x4000; // no size/move/activate/owner-z, async
    static readonly object outputLock = new object(), leaseLock = new object();
    static readonly Dictionary<long, Lease> leases = new Dictionary<long, Lease>();
    static string journal;
    class Lease { public IntPtr h; public uint pid; public long until; public string id; }
    static Dictionary<string,object> D(params object[] pairs) {
        var d = new Dictionary<string,object>(); for (int i=0;i<pairs.Length;i+=2) d[(string)pairs[i]]=pairs[i+1]; return d;
    }
    static void Write(object d) {
        lock(outputLock) {
            string s = new JavaScriptSerializer().Serialize(d);
            try { Console.WriteLine(s); Console.Out.Flush(); } catch { }
            if (journal != null) try { File.AppendAllText(journal, s+Environment.NewLine, new UTF8Encoding(false)); } catch { }
        }
    }
    static void Stage(string id, string stage, object data) { Write(D("id",id,"utc",DateTime.UtcNow.ToString("o"),"stage",stage,"data",data)); }
    static string S(Dictionary<string,object> d,string k,string fallback="") { return d.ContainsKey(k) ? Convert.ToString(d[k]) : fallback; }
    static long N(Dictionary<string,object> d,string k,long fallback=0) { return d.ContainsKey(k) ? Convert.ToInt64(d[k]) : fallback; }
    static bool B(Dictionary<string,object> d,string k) { return d.ContainsKey(k) && Convert.ToBoolean(d[k]); }
    static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h,out p); return p; }
    static string PathOf(uint pid) {
        IntPtr p=OpenProcess(0x1000,false,pid); if(p==IntPtr.Zero) return "";
        try { var b=new StringBuilder(32768); int n=b.Capacity; return QueryFullProcessImageName(p,0,b,ref n) ? b.ToString() : ""; }
        finally { CloseHandle(p); }
    }
    static HashSet<uint> Family(uint host) {
        var parents=new Dictionary<uint,uint>(); IntPtr snap=CreateToolhelp32Snapshot(2,0);
        try { ENTRY e=new ENTRY(); e.size=(uint)Marshal.SizeOf(typeof(ENTRY));
            if(Process32First(snap,ref e)) do { parents[e.pid]=e.parent; } while(Process32Next(snap,ref e));
        } finally { if(snap!=new IntPtr(-1)) CloseHandle(snap); }
        var family=new HashSet<uint>(); uint p=host;
        for(int i=0;i<32 && p!=0 && family.Add(p);i++) { if(!parents.TryGetValue(p,out p)) break; }
        return family;
    }
    static IntPtr Resolve(Dictionary<string,object> q) {
        string exe=S(q,"exe"); uint wanted=(uint)N(q,"ownerPid");
        var family=Family((uint)N(q,"hostPid")); var candidates=new List<IntPtr>();
        EnumWindows(delegate(IntPtr h,IntPtr unused) {
            uint p=Pid(h);
            if(GetWindow(h,4)!=IntPtr.Zero || GetWindowTextLength(h)==0 || (GetWindowLong(h,-20)&0x80)!=0) return true;
            if(wanted!=0 && p!=wanted) return true;
            var title=new StringBuilder(512); GetWindowText(h,title,title.Capacity);
            if(title.ToString()=="DSH Pet") return true; // legacy independent pet, never the main window
            if(!String.Equals(PathOf(p),exe,StringComparison.OrdinalIgnoreCase)) return true;
            candidates.Add(h); return true;
        },IntPtr.Zero);
        var related=candidates.FindAll(h=>family.Contains(Pid(h)));
        if(related.Count==1) return related[0];
        if(candidates.Count==1) return candidates[0];
        if(candidates.Count>1) throw new Exception("ambiguous-window: "+candidates.Count+" matching windows; no arbitrary selection");
        return IntPtr.Zero;
    }
    static bool Top(IntPtr h) { return (GetWindowLong(h,-20)&8)!=0; }
    static Dictionary<string,object> Probe(IntPtr h) {
        // Coordinates are derived and consumed on this same PMv2 thread.
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        int cloaked=0; int dwm=DwmGetWindowAttribute(h,14,out cloaked,4);
        RECT r; POINT origin=new POINT(0,0);
        bool bounds=GetClientRect(h,out r) && ClientToScreen(h,ref origin);
        bool shown=IsWindow(h) && IsWindowVisible(h) && !IsIconic(h) && dwm==0 && cloaked==0 && bounds && r.R>r.L && r.B>r.T;
        var owners=new List<long>(); int visible=0;
        if(shown) for(int y=1;y<=3;y++) for(int x=1;x<=3;x++) {
            IntPtr at=GetAncestor(WindowFromPoint(new POINT(origin.X+(r.R-r.L)*x/4,origin.Y+(r.B-r.T)*y/4)),2);
            owners.Add(at.ToInt64()); if(at==h) visible++;
        }
        return D("hwnd",h.ToInt64(),"pid",Pid(h),"foreground",GetForegroundWindow().ToInt64(),
            "focused",GetForegroundWindow()==h,"shown",shown,"minimized",IsIconic(h),"cloaked",cloaked,"dwmResult",dwm,
            "topmost",Top(h),"clientRect",new int[]{origin.X,origin.Y,r.R-r.L,r.B-r.T},
            "sampleOwners",owners,"exposedPoints",visible,"sampledVisible",shown && visible==9);
    }
    static bool Flash(IntPtr h, bool start) {
        FLASH f=new FLASH(); f.size=(uint)Marshal.SizeOf(typeof(FLASH)); f.hwnd=h;
        f.flags=start ? 2u|12u : 0u; f.count=uint.MaxValue;
        return FlashWindowEx(ref f); // PREVIOUS caption state, not success!
    }
    static void Cleanup(bool all) {
        lock(leaseLock) {
            foreach(var item in new List<Lease>(leases.Values)) {
                if(!all && DateTime.UtcNow.Ticks<item.until && GetForegroundWindow()!=item.h) continue;
                bool same=IsWindow(item.h) && Pid(item.h)==item.pid;
                bool requested=false;
                if(same) {
                    requested=SetWindowPos(item.h,new IntPtr(-2),0,0,0,0,POSITION);
                    for(int i=0;i<20 && Top(item.h);i++) Thread.Sleep(10);
                    if(GetForegroundWindow()==item.h) Flash(item.h,false);
                }
                bool restored=!same || !Top(item.h);
                Stage(item.id,"cleanup",D("hwnd",item.h.ToInt64(),"sameOwner",same,"requested",requested,"restored",restored));
                if(restored || all) leases.Remove(item.h.ToInt64());
            }
        }
    }
    static object Run(Dictionary<string,object> q) {
        string id=S(q,"id"), op=S(q,"op","probe");
        if(op=="cleanup") { Cleanup(true); return D("status","cleanup-complete"); }
        var clock=Stopwatch.StartNew(); IntPtr h=Resolve(q);
        if(h==IntPtr.Zero) return D("status","no-window","elapsedMs",clock.ElapsedMilliseconds,"visible",false,"focused",false);
        var before=Probe(h); Stage(id,"resolved",before);
        if(op=="probe") return before;
        if(op!="raise") throw new Exception("unsupported operation: "+op);
        bool foregroundApi=false, topApi=false, flashPrevious=false;
        bool already=(bool)before["focused"] && (bool)before["sampledVisible"];
        if(!already) {
            flashPrevious=Flash(h,true); Stage(id,"flash",D("state","requested","previousActive",flashPrevious,"observed",false));
            if(IsIconic(h)) ShowWindowAsync(h,9); else if(!IsWindowVisible(h)) ShowWindowAsync(h,4);
            if(!B(q,"skipFocus")) foregroundApi=SetForegroundWindow(h);
            // SetForegroundWindow has an asynchronous cross-queue phase; do not judge immediately.
            for(int i=0;i<5 && GetForegroundWindow()!=h;i++) Thread.Sleep(10);
            Stage(id,"focus",D("apiReturn",foregroundApi,"observed",GetForegroundWindow()==h,"skipped",B(q,"skipFocus")));
            var afterFocus=Probe(h);
            if(!(bool)afterFocus["sampledVisible"] || GetForegroundWindow()!=h || B(q,"skipFocus")) {
                lock(leaseLock) {
                    // Remember original state BEFORE promotion. A repeat extends the same lease.
                    Lease lease;
                    if(leases.TryGetValue(h.ToInt64(),out lease)) lease.until=DateTime.UtcNow.AddMilliseconds(4000).Ticks;
                    else if(!Top(h)) leases[h.ToInt64()]=new Lease {h=h,pid=Pid(h),id=id,until=DateTime.UtcNow.AddMilliseconds(4000).Ticks};
                    topApi=SetWindowPos(h,new IntPtr(-1),0,0,0,0,POSITION|0x0040);
                }
                Stage(id,"topmost-request",D("apiReturn",topApi,"lastError",topApi ? 0 : Marshal.GetLastWin32Error()));
            }
        }
        Dictionary<string,object> after=Probe(h);
        for(int i=0;i<25 && !(bool)after["sampledVisible"];i++) { Thread.Sleep(10); after=Probe(h); }
        bool visible=(bool)after["sampledVisible"], focused=(bool)after["focused"];
        return D("status",visible ? (focused ? "foreground" : "visible-without-focus") : "not-visible",
            "visible",visible,"focused",focused,"already",already,"elapsedMs",clock.ElapsedMilliseconds,
            "foregroundApi",foregroundApi,"topmostApi",topApi,"flash",already ? "not-needed" : "requested-unverified",
            "before",before,"after",after,"cleanupLeaseMs",4000);
    }
    static int Main(string[] args) {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length>0) { journal=args[0]; Directory.CreateDirectory(System.IO.Path.GetDirectoryName(journal)); }
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var timer=new Timer(_=>{try { Cleanup(false); } catch(Exception e) { Stage("","cleanup-error",e.ToString()); }},null,100,100);
        Stage("","ready",D("pid",Process.GetCurrentProcess().Id,"version","attention-v1","inputInjection",false,"attachedQueues",false));
        try {
            string line;
            while((line=Console.ReadLine())!=null) {
                string id="";
                try { var q=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line); id=S(q,"id");
                    object r=Run(q); Write(D("id",id,"utc",DateTime.UtcNow.ToString("o"),"result",r));
                } catch(Exception e) { Write(D("id",id,"utc",DateTime.UtcNow.ToString("o"),"error",e.ToString())); }
            }
        } finally { timer.Dispose(); Cleanup(true); }
        return 0;
    }
}
