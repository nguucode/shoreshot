# ShoreShot installer for Windows (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex
#
# Tuỳ chọn: tải script về rồi chạy với tham số
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1))) -FromSource
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1))) -Uninstall
#
#   -FromSource   bỏ qua bản build sẵn, build từ source (cần git + Node.js 18+)
#   -Uninstall    gỡ ShoreShot
#   -NoLaunch     cài xong không mở app
param(
  [switch]$FromSource,
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

function New-Shortcut($path, $target) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = $target
  $s.WorkingDirectory = Split-Path $target
  $s.Save()
}

function Install-FromSource {
  Say 'Build từ source...'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'Cần git. Cài: winget install Git.Git' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Cần Node.js 18+. Cài: winget install OpenJS.NodeJS.LTS' }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 18) { Die "Node.js $major quá cũ, cần 18+." }

  $src = Join-Path $Tmp 'src'
  git clone --depth 1 "https://github.com/$Repo.git" $src 2>$null | Out-Null
  if (-not (Test-Path (Join-Path $src 'package.json'))) { Die 'Không clone được repo.' }
  Push-Location $src
  try {
    Say 'npm install (lần đầu mất 1 đến 3 phút)...'
    npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Die 'npm install lỗi.' }
    npm run build --silent
    if ($LASTEXITCODE -ne 0) { Die 'Build TypeScript lỗi.' }
    Say 'Đóng gói app...'
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    npx --no-install electron-builder --win --dir --x64 | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'electron-builder lỗi.' }
  } finally { Pop-Location }

  $unpacked = Join-Path $src 'release\win-unpacked'
  if (-not (Test-Path (Join-Path $unpacked "$AppName.exe"))) { Die "Build xong nhưng không thấy $AppName.exe." }

  Stop-App
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item -Path (Join-Path $unpacked '*') -Destination $InstallDir -Recurse -Force
  $exe = Join-Path $InstallDir "$AppName.exe"
  New-Shortcut $StartMenuLnk $exe
  New-Shortcut $DesktopLnk $exe
}

try {
  if ($FromSource) {
    Install-FromSource
  } elseif (-not (Install-FromRelease)) {
    Say 'Chưa có bản build sẵn cho Windows, chuyển sang build từ source.'
    Install-FromSource
  }

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
