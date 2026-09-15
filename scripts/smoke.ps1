# Smoke test: build + boot + health check. Exit 0 = PASS.
# Usage: powershell -File scripts\smoke.ps1 [-SkipFrontend]
param([switch]$SkipFrontend)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$fail = 0

function Step($name, $ok) {
    if ($ok) { Write-Host "PASS $name" }
    else { Write-Host "FAIL $name"; $script:fail++ }
}

# refresh PATH (fresh shells may miss node)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User") + ";C:\msys64\mingw64\bin"

Write-Host "== frontend =="
if (-not $SkipFrontend) {
    Push-Location $root
    npm run build 2>&1 | Out-Null
    Step "npm run build" ($LASTEXITCODE -eq 0)
    Pop-Location
}

Write-Host "== rust =="
Push-Location "$root\src-tauri"
cargo build 2>&1 | Out-Null
Step "cargo build" ($LASTEXITCODE -eq 0)

Write-Host "== unit bins =="
cargo run --example rule_tests 2>&1 | Out-Null;      Step "rule_tests"   ($LASTEXITCODE -eq 0)
cargo run --example loop_tests 2>&1 | Out-Null;      Step "loop_tests"   ($LASTEXITCODE -eq 0)
cargo run --example cont_tests 2>&1 | Out-Null;      Step "cont_tests"   ($LASTEXITCODE -eq 0)
Pop-Location

Write-Host "== cargo tests =="
& "$root\scripts\cargo-test.ps1" --lib 2>&1 | Out-Null
Step "cargo test --lib" ($LASTEXITCODE -eq 0)

Write-Host "== runtime boot =="
Remove-Item "$env:TEMP\opencode-gui.log" -ErrorAction SilentlyContinue

# vite dev server
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev" -WindowStyle Hidden -WorkingDirectory $root | Out-Null
$viteOk = $false
foreach ($i in 1..25) {
    Start-Sleep -Milliseconds 700
    try { Invoke-WebRequest -Uri "http://localhost:1420" -UseBasicParsing -TimeoutSec 2 | Out-Null; $viteOk = $true; break } catch {}
}
Step "vite dev server" $viteOk

$app = Start-Process -FilePath "$root\src-tauri\target\debug\nexuscode.exe" -PassThru
$healthy = $false
foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 800
    if ($app.HasExited) { break }
    $line = Get-Content "$env:TEMP\opencode-gui.log" -ErrorAction SilentlyContinue | Select-String "healthy on :" | Select-Object -Last 1
    if ($line) { $healthy = $true; break }
}
Step "opencode serve healthy" $healthy

# surgical cleanup: only OUR children, never the host opencode process
taskkill /F /IM nexuscode.exe 2>&1 | Out-Null
Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" |
    Where-Object { $_.CommandLine -match "serve --port" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "vite|1420" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host ""
if ($fail -eq 0) { Write-Host "SMOKE: ALL PASSED"; exit 0 }
else { Write-Host "SMOKE: $fail FAILED"; exit 1 }
