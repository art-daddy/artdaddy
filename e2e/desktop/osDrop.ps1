# A REAL Windows shell drag-drop onto the app window.
#
# `dragDropEnabled: true` is the one fact no unit test can reach: it decides whether WebView2's own
# drop handler is replaced by Tauri's, i.e. whether a dropped file arrives as a PATH (link it in
# place) or as an HTML5 File with no path (copy it). Only an actual OLE drag can tell those apart.
#
# TWO safety properties, both learned the hard way:
#   * synthetic input goes to whatever window is under the cursor, so the release point is checked
#     against the expected process BEFORE the drag and again before the button is released;
#   * DoDragDrop runs a MODAL loop, so a drag that never completes hangs holding the left button
#     down system-wide. A watchdog force-releases it and exits rather than leaving that state.
#
#   powershell -File osDrop.ps1 -File <path> -X <screenX> -Y <screenY> -Process app
param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [string]$Process = "artdaddy",
  [int]$TimeoutSec = 25
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$src = @"
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class ShellDrag {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  static StringBuilder log = new StringBuilder();
  static void Log(string s) { lock (log) { log.Append(s).Append("; "); } }
  static bool dragStarted = false;

  // The window directly under the cursor is the WebView2 CHILD, which lives in msedgewebview2 --
  // judging that would reject the app's own window. Walk to the root (GA_ROOT) first.
  public static string ProcessAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return "<none>";
    IntPtr root = GetAncestor(h, 2);
    if (root != IntPtr.Zero) h = root;
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "<gone>"; }
  }

  public static string Run(string file, int tx, int ty, string expect, int timeoutSec) {
    SetProcessDPIAware();
    string at = ProcessAt(tx, ty);
    if (at != expect) return "ABORT: target point belongs to '" + at + "', expected '" + expect + "'";

    var form = new Form();
    form.StartPosition = FormStartPosition.Manual;
    form.Location = new Point(4, 4);
    form.Size = new Size(200, 120);
    form.TopMost = true;
    form.Text = "artdaddy drag source";
    form.FormBorderStyle = FormBorderStyle.FixedToolWindow;
    form.BackColor = Color.DarkRed;

    form.MouseDown += delegate(object s, MouseEventArgs e) {
      if (dragStarted) return;
      dragStarted = true;
      Log("mousedown");
      DataObject data = new DataObject(DataFormats.FileDrop, new string[] { file });
      // Move + release on another thread: DoDragDrop runs a modal loop on this one.
      Thread mover = new Thread(delegate() {
        Thread.Sleep(350);
        int sx = form.Left + form.Width / 2, sy = form.Top + form.Height / 2;
        for (int i = 1; i <= 30; i++) {
          SetCursorPos(sx + (tx - sx) * i / 30, sy + (ty - sy) * i / 30);
          Thread.Sleep(30);
        }
        Thread.Sleep(600);
        string now = ProcessAt(tx, ty);
        Log("release over '" + now + "'");
        if (now != expect) Log("ABORT mid-drag");
        mouse_event(LEFTUP, 0, 0, 0, 0);
      });
      mover.IsBackground = true;
      mover.Start();
      string effect = form.DoDragDrop(data, DragDropEffects.Copy | DragDropEffects.Link).ToString();
      Log("effect=" + effect);
      try { form.BeginInvoke((MethodInvoker)delegate() { form.Close(); }); } catch { }
    };

    form.Shown += delegate(object s, EventArgs e) {
      Thread clicker = new Thread(delegate() {
        Thread.Sleep(600);
        SetForegroundWindow(form.Handle);
        Thread.Sleep(250);
        // A click on an inactive window can be consumed activating it, so press until the
        // handler actually runs rather than assuming the first one lands.
        for (int i = 0; i < 3 && !dragStarted; i++) {
          SetCursorPos(form.Left + form.Width / 2, form.Top + form.Height / 2);
          Thread.Sleep(150);
          mouse_event(LEFTDOWN, 0, 0, 0, 0);
          Thread.Sleep(400);
          if (!dragStarted) mouse_event(LEFTUP, 0, 0, 0, 0);
        }
        if (!dragStarted) Log("no mousedown reached the form");
      });
      clicker.IsBackground = true;
      clicker.Start();

      // Watchdog: a modal drag that never ends would hold the left button down forever.
      Thread dog = new Thread(delegate() {
        Thread.Sleep(timeoutSec * 1000);
        Log("TIMEOUT");
        mouse_event(LEFTUP, 0, 0, 0, 0);
        Console.Out.WriteLine(log.ToString());
        Console.Out.Flush();
        Thread.Sleep(400);
        mouse_event(LEFTUP, 0, 0, 0, 0);
        Environment.Exit(2);
      });
      dog.IsBackground = true;
      dog.Start();
    };

    Application.Run(form);
    mouse_event(LEFTUP, 0, 0, 0, 0);   // belt and braces: never leave the button down
    lock (log) { return log.ToString(); }
  }
}
"@

Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing -Language CSharp
Write-Output ([ShellDrag]::Run($File, $X, $Y, $Process, $TimeoutSec))
