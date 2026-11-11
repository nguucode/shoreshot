# Windows spike harness (GitHub Actions windows-latest). Presses the real global hotkey (Ctrl+Shift+X)
# with keybd_event, so the Tauri spike and the Electron app are measured the same way on the same machine.
# Writes logs, screenshots and summary.md to $Out.
param(
  [Parameter(Mandatory)] [string]$Exe,        # spike exe
  [Parameter(Mandatory)] [string]$Installer,  # spike NSIS installer
  [Parameter(Mandatory)] [string]$RepoRoot,   # Electron app (built with npm run build)
  [string]$Out = 'spike-out'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms @"
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Windows.Forms;
public static class K {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Chord(params byte[] vks) {
    foreach (var v in vks) keybd_event(v, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, 2, UIntPtr.Zero);
  }
  public static void Shot(string path) {
    var b = SystemInformation.VirtualScreen;
    using (var bmp = new Bitmap(b.Width, b.Height)) using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(b.Left, b.Top, 0, 0, bmp.Size); bmp.Save(path);
    }
  }
}
"@
function Hotkey { [K]::Chord(0x11, 0x10, 0x58) }   # Ctrl+Shift+X
function Esc { [K]::Chord(0x1B) }
function Shot($name) { [K]::Shot((Join-Path $Out "$name.png")) }

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
    WorkingSetMB = [math]::Round(($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
  }
}

function Start-App($path, $arguments, $envs) {
  foreach ($k in $envs.Keys) { Set-Item "env:$k" $envs[$k] }
  $p = if ($arguments) { Start-Process $path -ArgumentList $arguments -PassThru } else { Start-Process $path -PassThru }
  foreach ($k in $envs.Keys) { Remove-Item "env:$k" }
  $p
}

# Move a log into $Out (a run that never captured leaves no log: say so instead of failing).
function Take-Log($src, $name) {
  if (Test-Path $src) { Move-Item $src "$Out/$name" -Force } else { 'no capture.log' | Set-Content "$Out/$name" }
}

function Stop-Tree($p) { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null; Start-Sleep 1 }

# Hotkey -> wait -> (screenshot) -> Esc, $n times.
function Cycle($n, $prefix) {
  for ($i = 1; $i -le $n; $i++) {
    Hotkey; Start-Sleep -Milliseconds 1500
    if ($i -eq 2) { Shot "$prefix-overlay" }
    Esc; Start-Sleep -Milliseconds 2000
  }
}

$spikeLog = Join-Path $env:APPDATA 'ShoreShot-spike\capture.log'
$electronLog = Join-Path $env:APPDATA 'ShoreShot\logs\capture.log'
Remove-Item $spikeLog, $electronLog -ErrorAction SilentlyContinue
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$display = "$($screen.Bounds.Width)x$($screen.Bounds.Height)"

# 1. Tauri: idle RAM, then hotkey cycles.
$p = Start-App $Exe $null @{}
Start-Sleep 10
$tauriIdle = Tree-Memory $p.Id
Cycle 6 'tauri'
$tauriAfter = Tree-Memory $p.Id
Stop-Tree $p
Take-Log $spikeLog tauri-capture.log

# 2. Tauri drawing benchmark (scripted pen + rect strokes, then Enter = copy to clipboard).
$p = Start-App $Exe $null @{ SPIKE_BENCH = '1' }
Start-Sleep 18
Stop-Tree $p
Take-Log $spikeLog tauri-bench.log

# 3. Tauri with a modal dialog open: does the hotkey show the overlay over it, and does Esc still close it?
$p = Start-App $Exe $null @{ SPIKE_MODAL_TEST = '1' }
Start-Sleep 5
Shot 'modal-before-hotkey'
Hotkey; Start-Sleep -Milliseconds 1500
Shot 'modal-overlay'
Esc; Start-Sleep 1
Shot 'modal-after-esc'
Stop-Tree $p
Take-Log $spikeLog tauri-modal.log

# 4. Electron baseline, same hotkey, same machine.
$electronExe = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
$p = Start-App $electronExe "`"$RepoRoot`"" @{}
Start-Sleep 12
$electronIdle = Tree-Memory $p.Id
Cycle 6 'electron'
$electronAfter = Tree-Memory $p.Id
Stop-Tree $p
Take-Log $electronLog electron-capture.log

$exeMB = [math]::Round((Get-Item $Exe).Length / 1MB, 1)
$instMB = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
$summary = @"
## Windows spike ($display, $((Get-CimInstance Win32_OperatingSystem).Caption))

| | Electron (from source) | Tauri spike |
|---|---|---|
| Installer | 78-100 MB (release) | $instMB MB (NSIS; exe $exeMB MB) |
| Idle RAM, private (processes) | $($electronIdle.PrivateMB) MB ($($electronIdle.Count)) | $($tauriIdle.PrivateMB) MB ($($tauriIdle.Count)) |
| Idle RAM, working set | $($electronIdle.WorkingSetMB) MB | $($tauriIdle.WorkingSetMB) MB |
| After 6 captures, private | $($electronAfter.PrivateMB) MB | $($tauriAfter.PrivateMB) MB |

### Tauri capture.log
``````
$(Get-Content "$Out/tauri-capture.log" -Raw)
``````
### Electron capture.log
``````
$(Get-Content "$Out/electron-capture.log" -Raw)
``````
### Tauri bench
``````
$(Get-Content "$Out/tauri-bench.log" -Raw)
``````
### Tauri modal test
``````
$(Get-Content "$Out/tauri-modal.log" -Raw)
``````
"@
$summary | Set-Content "$Out/summary.md"
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content $env:GITHUB_STEP_SUMMARY }
$summary
