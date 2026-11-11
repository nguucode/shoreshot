# ShoreShot installer for Windows (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex
#
# Options: download the script and run it with parameters
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1))) -Uninstall
#
#   -Uninstall    remove ShoreShot
#   -NoLaunch     don't open the app after installing
param(
  [switch]$Uninstall,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'nguucode/shoreshot'
$AppName = 'ShoreShot'
$InstallDir = Join-Path $env:LOCALAPPDATA $AppName                 # 2.x (Tauri, per-user NSIS)
$OldInstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"   # 1.x (Electron)
$StartMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Die($m) { Write-Host "ERR $m" -ForegroundColor Red; throw $m }

function Stop-App {
  Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

function Find-Uninstaller {
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "$AppName*" -and $_.UninstallString }
}

# Runs every ShoreShot uninstaller found. 1.x (Electron) and 2.x (Tauri) register different uninstall
# keys and folders, so installing 2.x over 1.x would otherwise leave two copies. Settings are kept.
function Remove-Installed {
  foreach ($u in @(Find-Uninstaller)) {
    $exe = ($u.UninstallString -replace '^"([^"]+)".*$', '$1')
    if (Test-Path $exe) { Start-Process -FilePath $exe -ArgumentList '/S' -Wait }
  }
}

if ($Uninstall) {
  Say "Removing $AppName..."
  Stop-App
  Remove-Installed
  foreach ($p in @($InstallDir, $OldInstallDir, $StartMenuLnk, $DesktopLnk, (Join-Path $env:APPDATA $AppName),
                   (Join-Path $env:APPDATA 'biz.ontheshore.shoreshot'), (Join-Path $env:LOCALAPPDATA 'biz.ontheshore.shoreshot'))) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Ok "Removed $p" }
  }
  Ok 'Uninstalled.'
  return
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("shoreshot-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

# GitHub's release CDN sometimes answers 502/503/504 for a while. One failed request
# must not kill the install, so try several downloaders, each with retries and resume.
function Test-Download($path, $expected) {
  if (-not (Test-Path $path)) { return $false }
  $len = (Get-Item $path).Length
  if ($expected -gt 0) { return $len -eq $expected }
  return $len -gt 0
}

function Get-File {
  param([string]$Url, [string]$OutFile, [long]$ExpectedSize = 0)
  # Native-command stderr + 'Stop' throws in Windows PowerShell 5.1; keep failures non-fatal here.
  $ErrorActionPreference = 'Continue'

  # 1) curl.exe (built into Windows 10 1803+): retries on 5xx/timeouts and resumes partial files.
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    $curlArgs = @('-sfL', '--retry', '5', '--retry-delay', '3', '--connect-timeout', '20',
                  '-C', '-', '-A', 'shoreshot-installer', '-o', $OutFile, $Url)
    # --retry-all-errors (curl 7.71+) also retries 504s; older built-in curl lacks it.
    if ((& $curl --help all) -match 'retry-all-errors') { $curlArgs = @('--retry-all-errors') + $curlArgs }
    for ($i = 1; $i -le 3; $i++) {
      & $curl @curlArgs
      if ($LASTEXITCODE -eq 0 -and (Test-Download $OutFile $ExpectedSize)) { return $true }
      if ($LASTEXITCODE -eq 33) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue } # server refused resume
      Write-Host "    curl attempt $i failed (exit $LASTEXITCODE), retrying..." -ForegroundColor DarkYellow
      Start-Sleep -Seconds (5 * $i)
    }
  }

  # 2) BITS: Windows' own background downloader, tolerant of flaky connections.
  if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
    try {
      Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
      Start-BitsTransfer -Source $Url -Destination $OutFile -ErrorAction Stop
      if (Test-Download $OutFile $ExpectedSize) { return $true }
    } catch {
      Write-Host "    BITS failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
  }

  # 3) Invoke-WebRequest with backoff.
  for ($i = 1; $i -le 4; $i++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers @{ 'User-Agent' = 'shoreshot-installer' }
      if (Test-Download $OutFile $ExpectedSize) { return $true }
    } catch {
      Write-Host "    Download attempt $i failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
    Start-Sleep -Seconds (5 * $i)
  }
  return $false
}

function Install-FromRelease {
  Say 'Looking up the latest build on GitHub Releases...'
  $rel = $null
  for ($i = 1; $i -le 3 -and -not $rel; $i++) {
    try {
      $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'shoreshot-installer' }
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $false } # no release yet
      Write-Host "    GitHub API attempt $i failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
      Start-Sleep -Seconds (3 * $i)
    }
  }
  if (-not $rel) { Die "Could not reach GitHub. Check your connection and run the command again." }
  $asset = $rel.assets | Where-Object { $_.name -like "$AppName-Setup-*.exe" } | Select-Object -First 1
  if (-not $asset) { return $false }
  $setup = Join-Path $Tmp $asset.name
  Say "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
  if (-not (Get-File -Url $asset.browser_download_url -OutFile $setup -ExpectedSize $asset.size)) {
    Die ("Could not download the installer from GitHub (server busy or network blocked). " +
         "Run this command again in a few minutes, or download it manually: https://github.com/$Repo/releases/latest")
  }
  Stop-App
  Remove-Installed
  Say 'Installing (silent)...'
  # /S: silent install, /currentuser: no Admin rights needed.
  Start-Process -FilePath $setup -ArgumentList '/S', '/currentuser' -Wait
  return $true
}

try {
  if (-not (Install-FromRelease)) { Die "No Windows build yet. See https://github.com/$Repo/releases" }

  $exe = Join-Path $InstallDir "$AppName.exe"
  if (-not (Test-Path $exe)) {
    $u = Find-Uninstaller | Select-Object -First 1
    if ($u -and $u.InstallLocation) { $exe = Join-Path $u.InstallLocation "$AppName.exe" }
  }

  Ok "Installed $AppName"
  Write-Host ''
  Write-Host '  - Default hotkey: Ctrl+Shift+X (change it from the tray icon > Settings...)'
  Write-Host '  - Ctrl+C copies, Ctrl+V copies and pastes into the previous app.'
  Write-Host "  - Uninstall: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/main/scripts/install.ps1))) -Uninstall"
  Write-Host ''

  if (-not $NoLaunch -and (Test-Path $exe)) { Start-Process $exe }
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
