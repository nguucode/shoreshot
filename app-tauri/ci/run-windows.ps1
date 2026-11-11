# Windows end-to-end harness for the Tauri app (GitHub Actions windows-latest, Windows PowerShell 5.1).
# Drives the real app with real input only (no test hooks except the modal dialog): global hotkeys via
# keybd_event, mouse drags via SetCursorPos/mouse_event. Runs the same suite against the Electron app on the
# same machine as the baseline. Writes logs, screenshots and summary.md to $Out; exits 1 if a Tauri check fails.
param(
  [Parameter(Mandatory)] [string]$Exe,          # Tauri app exe (release build)
  [Parameter(Mandatory)] [string]$Installer,    # Tauri NSIS installer
  [Parameter(Mandatory)] [string]$RepoRoot,     # Electron app (built with npm run build)
  [Parameter(Mandatory)] [string]$TauriDataDir, # folder of the Tauri app's config.json
  [string]$TauriLog = (Join-Path $env:APPDATA 'ShoreShot\logs\capture.log'),
  [string]$Out = 'windows-out'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms @"
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Windows.Forms;
public static class K {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int L, T, R, B; }
  public static void Chord(params byte[] vks) {
    foreach (var v in vks) keybd_event(v, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, 2, UIntPtr.Zero);
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(50);
    mouse_event(2, 0, 0, 0, UIntPtr.Zero);
    for (int i = 1; i <= 20; i++) { SetCursorPos(x1 + (x2 - x1) * i / 20, y1 + (y2 - y1) * i / 20); System.Threading.Thread.Sleep(15); }
    mouse_event(4, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
  }
  // A visible top-level window of this process that is on screen and at least 200x200 (the overlay;
  // Tauri parks it at -32000 while painting, which does not count).
  public static bool Overlay(uint pid) {
    var vs = SystemInformation.VirtualScreen; bool found = false;
    EnumWindows((h, p) => {
      uint wp; GetWindowThreadProcessId(h, out wp); RECT r;
      if (wp == pid && IsWindowVisible(h) && GetWindowRect(h, out r) && r.R - r.L >= 200 && r.B - r.T >= 200
          && r.L < vs.Right && r.R > vs.Left && r.T < vs.Bottom && r.B > vs.Top) found = true;
      return !found;
    }, IntPtr.Zero);
    return found;
  }
  public static void Shot(string path) {
    var b = SystemInformation.VirtualScreen;
    using (var bmp = new Bitmap(b.Width, b.Height)) using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(b.Left, b.Top, 0, 0, bmp.Size); bmp.Save(path);
    }
  }
}
"@
$VK = @{ Ctrl = 0x11; Shift = 0x10; X = 0x58; W = 0x57; R = 0x52; Enter = 0x0D; Esc = 0x1B }
function Key([string[]]$names) { [K]::Chord([byte[]]($names | ForEach-Object { $VK[$_] })) }
function Shot($name) { [K]::Shot((Join-Path $Out "$name.png")) }
function WaitFor([scriptblock]$cond, $ms = 3000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 50 }
  $false
}

# Memory of a process and all its descendants (WebView2 / Chromium helpers are children of the app).
function Tree-Memory($rootId) {
  $all = Get-CimInstance Win32_Process
  $ids = @($rootId); $grew = $true
  while ($grew) {
    $more = $all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object ProcessId
    $grew = [bool]$more; $ids += $more
  }
  $procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Count = $procs.Count
    PrivateMB = [math]::Round(($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB)
  }
}

function Clipboard-Image {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  $formats = ([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats() | Sort-Object) -join ', '
  [pscustomobject]@{ Size = if ($img) { "$($img.Width)x$($img.Height)" } else { 'none' }; W = $img.Width; H = $img.Height; Formats = $formats }
}

# Both apps read hotkeys from config.json: area Ctrl+Shift+X (default), window Ctrl+Shift+W.
function Write-Config($dir) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  '{"hotkeys":{"area":"CommandOrControl+Shift+X","full":"","window":"CommandOrControl+Shift+W"},"retina1x":false,"screenAsked":true}' |
    Set-Content (Join-Path $dir 'config.json') -Encoding ascii
}

$results = [ordered]@{}
function Check($app, $name, [bool]$ok, $detail = '') {
  if (-not $results[$name]) { $results[$name] = @{} }
  $results[$name][$app] = (@('FAIL', 'pass')[[int]$ok]) + $(if ($detail) { " ($detail)" } else { '' })
}

# The suite, the same for both apps. $p = the started process.
function Suite($app, $p) {
  $id = [uint32]$p.Id
  Start-Sleep 10
  $script:mem[$app] = Tree-Memory $p.Id

  # 1. Hotkey -> overlay -> Esc, 6 times.
  $shown = 0; $closed = 0
  for ($i = 1; $i -le 6; $i++) {
    Key Ctrl, Shift, X
    if (WaitFor { [K]::Overlay($id) }) { $shown++ }
    Start-Sleep -Milliseconds 700
    if ($i -eq 2) { Shot "$app-overlay" }
    Key Esc
    if (WaitFor { -not [K]::Overlay($id) }) { $closed++ }
    Start-Sleep -Milliseconds 1200
  }
  Check $app 'Hotkey shows the overlay (6x)' ($shown -eq 6) "$shown/6"
  Check $app 'Esc closes it (6x)' ($closed -eq 6) "$closed/6"

  # 2. Select an area, draw a rectangle, Enter = copy. 500x350 at 100 %.
  [System.Windows.Forms.Clipboard]::Clear()
  Key Ctrl, Shift, X
  $null = WaitFor { [K]::Overlay($id) }
  Start-Sleep -Milliseconds 500
  [K]::Drag(200, 150, 700, 500); Start-Sleep -Milliseconds 300
  Key R; [K]::Drag(300, 250, 500, 400); Start-Sleep -Milliseconds 300
  Shot "$app-draw"
  Key Enter
  $hidden = WaitFor { -not [K]::Overlay($id) }
  Start-Sleep -Milliseconds 500
  $clip = Clipboard-Image
  Check $app 'Draw + Enter copies the selection' ($hidden -and $clip.W -eq 500 -and $clip.H -eq 350) $clip.Size
  $script:formats[$app] = $clip.Formats

  # 3. Window mode: frame a Notepad window placed at a known rect, click it, Enter.
  [System.Windows.Forms.Clipboard]::Clear()
  $np = Start-Process notepad -PassThru
  $null = WaitFor { $np.Refresh(); $np.MainWindowHandle -ne 0 } 5000
  [K]::SetWindowPos($np.MainWindowHandle, [IntPtr]::Zero, 150, 120, 600, 400, 0x40) | Out-Null
  [K]::SetForegroundWindow($np.MainWindowHandle) | Out-Null
  Start-Sleep 1
  Key Ctrl, Shift, W
  $null = WaitFor { [K]::Overlay($id) }
  Start-Sleep -Milliseconds 1000 # the window list arrives after the overlay is visible
  Shot "$app-window-mode"
  [K]::Click(450, 320); Start-Sleep -Milliseconds 300
  Key Enter
  $null = WaitFor { -not [K]::Overlay($id) }
  Start-Sleep -Milliseconds 500
  $clip = Clipboard-Image
  Stop-Process $np -Force -ErrorAction SilentlyContinue
  # The DWM frame of a 600x400 window is a few px smaller than its GetWindowRect (no invisible border).
  Check $app 'Window mode copies the clicked window' ($clip.W -ge 570 -and $clip.W -le 600 -and $clip.H -ge 370 -and $clip.H -le 400) $clip.Size

  $script:after[$app] = Tree-Memory $p.Id
  & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
  Start-Sleep 1
}

function Take-Log($src, $name) {
  if (Test-Path $src) { Move-Item $src "$Out/$name" -Force } else { 'no capture.log' | Set-Content "$Out/$name" }
}

# "visible N" in every capture.log line. Electron: "visible 63 · …"; Tauri: "visible (bitmap ipc 0 ms) 63 · …",
# so take the last number before the next "·".
function Latency($log) {
  $ms = Get-Content $log | ForEach-Object { if ($_ -match 'visible[^·]*?(\d+)\s*(·|$)') { [int]$Matches[1] } }
  if (-not $ms) { return 'n/a' }
  $s = $ms | Sort-Object
  "$($s[0])-$($s[-1]) ms (median $($s[[int][math]::Floor(($s.Count - 1) / 2)]), n=$($s.Count))"
}

$mem = @{}; $after = @{}; $formats = @{}
$electronLog = Join-Path $env:APPDATA 'ShoreShot\logs\capture.log'
Remove-Item $TauriLog, $electronLog -ErrorAction SilentlyContinue
Write-Config $TauriDataDir
Write-Config (Join-Path $env:APPDATA 'ShoreShot')

# Tauri
$p = Start-Process $Exe -PassThru
Suite 'tauri' $p
Take-Log $TauriLog tauri-capture.log

# Tauri with a MessageBox open on its main thread (the v1.0.0 freeze setup): hotkey, Esc, dialog intact.
$env:SHORESHOT_TEST_MODAL = '1'
$p = Start-Process $Exe -PassThru
Remove-Item env:SHORESHOT_TEST_MODAL
$id = [uint32]$p.Id
# [NullString]::Value, not $null: PowerShell turns $null into "" for a string parameter, and FindWindow("", …)
# only matches windows whose class name is empty.
$modal = WaitFor { [K]::FindWindow([NullString]::Value, 'ShoreShot modal test') -ne [IntPtr]::Zero } 10000
Key Ctrl, Shift, X
$shown = WaitFor { [K]::Overlay($id) }
Start-Sleep -Milliseconds 700
Shot 'tauri-modal-overlay'
Key Esc
$closed = WaitFor { -not [K]::Overlay($id) }
Start-Sleep -Milliseconds 500
$intact = [K]::FindWindow([NullString]::Value, 'ShoreShot modal test') -ne [IntPtr]::Zero
Shot 'tauri-modal-after-esc'
Check 'tauri' 'MessageBox open: overlay shows, Esc closes, dialog intact' ($modal -and $shown -and $closed -and $intact) "dialog $modal, shown $shown, closed $closed, intact $intact"
& taskkill /PID $p.Id /T /F 2>&1 | Out-Null
Take-Log $TauriLog tauri-modal.log

# Electron baseline, same suite, same machine.
$electronExe = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
$p = Start-Process $electronExe -ArgumentList "`"$RepoRoot`"" -PassThru
Suite 'electron' $p
Take-Log $electronLog electron-capture.log

$tauriLat = Latency "$Out/tauri-capture.log"
$electronLat = Latency "$Out/electron-capture.log"
$rows = ($results.Keys | ForEach-Object { "| $_ | $($results[$_]['electron']) | $($results[$_]['tauri']) |" }) -join "`n"
$instMB = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$summary = @"
## Windows end-to-end ($($screen.Width)x$($screen.Height), $((Get-CimInstance Win32_OperatingSystem).Caption))

| Check | Electron (from source) | Tauri |
|---|---|---|
$rows
| Hotkey -> overlay visible | $electronLat | $tauriLat |
| Idle RAM, private (processes) | $($mem['electron'].PrivateMB) MB ($($mem['electron'].Count)) | $($mem['tauri'].PrivateMB) MB ($($mem['tauri'].Count)) |
| After the suite, private | $($after['electron'].PrivateMB) MB | $($after['tauri'].PrivateMB) MB |
| Installer | 78-100 MB (release) | $instMB MB (NSIS) |
| Clipboard formats after copy | $($formats['electron']) | $($formats['tauri']) |

### Tauri capture.log
``````
$(Get-Content "$Out/tauri-capture.log" -Raw)
``````
### Electron capture.log
``````
$(Get-Content "$Out/electron-capture.log" -Raw)
``````
"@
$summary | Set-Content "$Out/summary.md"
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content $env:GITHUB_STEP_SUMMARY }
$summary
$failed = $results.Keys | Where-Object { $results[$_]['tauri'] -like 'FAIL*' }
if ($failed) { Write-Host "Tauri failed: $($failed -join '; ')"; exit 1 }
