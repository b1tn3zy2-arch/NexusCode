# cargo test wrapper for Windows GNU: builds test harnesses, stamps the
# Common-Controls v6 manifest into them (see ensure-test-manifest.ps1),
# then runs the suite. Without the stamp, test binaries die in the loader
# with 0xc0000139 (TaskDialogIndirect missing from comctl32 v5).
# Usage: powershell -File scripts\cargo-test.ps1 [-- extra cargo test args]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArgs)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

# windres (tauri-winres) lives in msys mingw64; make sure cargo can find it.
if (Test-Path "C:\msys64\mingw64\bin\windres.exe") {
  if (($env:PATH -split ";" | Where-Object { $_ -eq "C:\msys64\mingw64\bin" }).Count -eq 0) {
    $env:PATH = "C:\msys64\mingw64\bin;" + $env:PATH
  }
}

Push-Location "$root\src-tauri"
try {
  Write-Host "[ctest] building harnesses..."
  cargo test --no-run 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { Write-Host "[ctest] build FAILED"; exit 1 }

  Write-Host "[ctest] stamping manifests..."
  & "$root\scripts\ensure-test-manifest.ps1"
  if ($LASTEXITCODE -ne 0) { Write-Host "[ctest] manifest stamp FAILED"; exit 1 }

  Write-Host "[ctest] running..."
  if ($TestArgs.Count -eq 0) { cargo test 2>&1 }
  else { cargo test @TestArgs 2>&1 }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
