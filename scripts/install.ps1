# ShoreShot installer for Windows (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex
#
# Tuỳ chọn: tải script về rồi chạy với tham số
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1))) -Uninstall
#
#   -Uninstall    gỡ ShoreShot
#   -NoLaunch     cài xong không mở app
param(
  [switch]$Uninstall,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest nhanh hơn nhiều khi tắt progress bar
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
  Say "Gỡ $AppName..."
  Stop-App
  $u = Find-Uninstaller
  if ($u) {
    $exe = ($u.UninstallString -replace '^"([^"]+)".*$', '$1')
    Start-Process -FilePath $exe -ArgumentList '/S' -Wait
    Ok 'Đã chạy trình gỡ cài đặt.'
  }
  foreach ($p in @($InstallDir, $StartMenuLnk, $DesktopLnk, (Join-Path $env:APPDATA $AppName))) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Ok "Đã xoá $p" }
  }
  Ok 'Gỡ xong.'
  return
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("shoreshot-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Install-FromRelease {
  Say 'Tìm bản build sẵn mới nhất trên GitHub Releases...'
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'shoreshot-installer' }
  } catch { return $false }
  $asset = $rel.assets | Where-Object { $_.name -like "$AppName-Setup-*.exe" } | Select-Object -First 1
  if (-not $asset) { return $false }
  $setup = Join-Path $Tmp $asset.name
  Say "Tải $($asset.name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -UseBasicParsing
  Stop-App
  Say 'Cài đặt (silent)...'
  # /S: cài im lặng, /currentuser: không cần quyền Admin.
  Start-Process -FilePath $setup -ArgumentList '/S', '/currentuser' -Wait
  return $true
}

try {
  if (-not (Install-FromRelease)) { Die "Chưa có bản build sẵn cho Windows. Xem https://github.com/$Repo/releases" }

  $exe = Join-Path $InstallDir "$AppName.exe"
  if (-not (Test-Path $exe)) {
    $u = Find-Uninstaller
    if ($u -and $u.InstallLocation) { $exe = Join-Path $u.InstallLocation "$AppName.exe" }
  }

  Ok "Đã cài $AppName"
  Write-Host ''
  Write-Host '  - Phím tắt mặc định: Ctrl+Shift+X (đổi ở icon khay hệ thống > Đổi phím tắt...)'
  Write-Host '  - Ctrl+C copy, Ctrl+V copy và tự dán vào app trước đó.'
  Write-Host "  - Gỡ: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/main/scripts/install.ps1))) -Uninstall"
  Write-Host ''

  if (-not $NoLaunch -and (Test-Path $exe)) { Start-Process $exe }
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
