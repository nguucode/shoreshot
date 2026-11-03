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
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
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
    Where-Object { $_.DisplayName -like "$AppName*" -and $_.UninstallString } |
    Select-Object -First 1
}

if ($Uninstall) {
  Say "Removing $AppName..."
  Stop-App
  $u = Find-Uninstaller
  if ($u) {
    $exe = ($u.UninstallString -replace '^"([^"]+)".*$', '$1')
    Start-Process -FilePath $exe -ArgumentList '/S' -Wait
    Ok 'Ran the uninstaller.'
  }
  foreach ($p in @($InstallDir, $StartMenuLnk, $DesktopLnk, (Join-Path $env:APPDATA $AppName))) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Ok "Removed $p" }
  }
  Ok 'Uninstalled.'
  return
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("shoreshot-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Install-FromRelease {
  Say 'Looking up the latest build on GitHub Releases...'
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'shoreshot-installer' }
  } catch { return $false }
  $asset = $rel.assets | Where-Object { $_.name -like "$AppName-Setup-*.exe" } | Select-Object -First 1
  if (-not $asset) { return $false }
  $setup = Join-Path $Tmp $asset.name
  Say "Downloading $($asset.name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -UseBasicParsing
  Stop-App
  Say 'Installing (silent)...'
  # /S: silent install, /currentuser: no Admin rights needed.
  Start-Process -FilePath $setup -ArgumentList '/S', '/currentuser' -Wait
  return $true
}

try {
  if (-not (Install-FromRelease)) { Die "No Windows build yet. See https://github.com/$Repo/releases" }

  $exe = Join-Path $InstallDir "$AppName.exe"
  if (-not (Test-Path $exe)) {
    $u = Find-Uninstaller
    if ($u -and $u.InstallLocation) { $exe = Join-Path $u.InstallLocation "$AppName.exe" }
  }

  Ok "Installed $AppName"
  Write-Host ''
  Write-Host '  - Default hotkey: Ctrl+Shift+X (change it from the tray icon > Change hotkey...)'
  Write-Host '  - Ctrl+C copies, Ctrl+V copies and pastes into the previous app.'
  Write-Host "  - Uninstall: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/main/scripts/install.ps1))) -Uninstall"
  Write-Host ''

  if (-not $NoLaunch -and (Test-Path $exe)) { Start-Process $exe }
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
