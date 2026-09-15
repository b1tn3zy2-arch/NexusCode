# NexusCode dev launcher
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$lock = "$env:APPDATA\nexuscode\app.lock"
Write-Host "[launch] cleaning stale lock..."
if (Test-Path $lock) {
  try {
    $pidInLock = (Get-Content $lock -Raw).Trim()
    $proc = Get-Process -Id $pidInLock -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne "nexuscode") {
      Remove-Item $lock -Force
      Write-Host "[launch] removed stale lock pid $pidInLock"
    } else {
      Write-Host "[launch] lock held by live pid $pidInLock"
    }
  } catch {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
  }
}
Write-Host "[launch] ensuring Vite on :1420..."
$viteUp = $false
try { $r = Invoke-WebRequest http://localhost:1420 -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $viteUp = $true; Write-Host "[launch] Vite already up" } } catch {}
if (-not $viteUp) {
  Write-Host "[launch] starting Vite..."
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "C:\Program Files\nodejs\npm.cmd"
  $psi.Arguments = "run dev"
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  Write-Host "[launch] vite pid $($p.Id) waiting 8s..."
  Start-Sleep -Seconds 8
  try { $r = Invoke-WebRequest http://localhost:1420 -UseBasicParsing -TimeoutSec 3; Write-Host "[launch] Vite OK $($r.StatusCode)" } catch { Write-Host "[launch] Vite not yet" }
} else {
  Write-Host "[launch] Vite already running"
}
Write-Host "[launch] checking debug binary..."
$exe = Join-Path $root "src-tauri\target\debug\nexuscode.exe"
if (-not (Test-Path $exe)) {
  Write-Host "[launch] no exe - running cargo check..."
  Set-Location "$root\src-tauri"
  $env:PATH = "C:\msys64\mingw64\bin;$env:PATH"
  # Reap orphaned sidecar servers from earlier sessions (they lock
  # target/debug copies and break the build script). Only ours under
  # this repo's target dir — never global/npm opencode installs.
  Get-Process opencode,sing-box -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$root\src-tauri\target*" } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  cargo check
  if ($LASTEXITCODE -ne 0) { Write-Host "[launch] cargo check failed"; exit 1 }
  if (-not (Test-Path $exe)) {
    Write-Host "[launch] building debug..."
    cargo build
  }
}
if (Test-Path $exe) {
  Write-Host "[launch] starting NexusCode..."
  $psi2 = New-Object System.Diagnostics.ProcessStartInfo
  $psi2.FileName = $exe
  $psi2.UseShellExecute = $false
  $p2 = [System.Diagnostics.Process]::Start($psi2)
  Write-Host "[launch] nexuscode pid $($p2.Id)"
  Start-Sleep -Seconds 3
  Get-Process -Id $p2.Id -ErrorAction SilentlyContinue | Format-Table Id,MainWindowTitle -AutoSize
} else {
  Write-Host "[launch] ERROR no exe at $exe"
  exit 1
}
Write-Host "[launch] done Vite http://localhost:1420 Tauri NexusCode"
Write-Host "[launch] logs $env:TEMP\opencode-gui.log"
