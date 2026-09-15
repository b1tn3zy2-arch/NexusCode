# Ensures every test binary under src-tauri\target\debug\deps carries a
# Common-Controls v6 activation manifest.
#
# Why: the Tauri build script (tauri-winres/windres) embeds the v6 manifest
# only into the main binary. Test harnesses get rustc's default manifest
# (trustInfo only), so they load comctl32 v5 and die in the loader with
# 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND on TaskDialogIndirect (via wry).
# Patching RT_MANIFEST (id 1) post-link fixes `cargo test` on Windows GNU.
# Idempotent: binaries that already declare Common-Controls are skipped.

param([string]$TargetDir = "")

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
if (-not $TargetDir) { $TargetDir = Join-Path $root "src-tauri\target\debug\deps" }
if (-not (Test-Path $TargetDir)) { Write-Host "[manifest] no deps dir: $TargetDir"; exit 0 }

$xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" /></dependentAssembly></dependency><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false" /></requestedPrivileges></security></trustInfo><compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" /></application></compatibility></assembly>'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NcResUpd {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
'@

function Test-HasV6Manifest([string]$path) {
  try {
    $bytes = [IO.File]::ReadAllBytes($path)
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    return $text.Contains("Microsoft.Windows.Common-Controls")
  } catch { return $true } # unreadable: leave alone
}

function Invoke-ResSession([string]$path, [scriptblock]$work, [bool]$commitOnSuccess) {
  # One Begin/End session. Returns $true only if $work succeeded AND the
  # session committed. Never leaves a session open.
  $h = [NcResUpd]::BeginUpdateResource($path, $false)
  if ($h -eq [IntPtr]::Zero) { return $false }
  $ok = $false
  try {
    $ok = [bool](& $work $h)
  } catch {
    $ok = $false
  } finally {
    [void][NcResUpd]::EndUpdateResource($h, (-not ($ok -and $commitOnSuccess)))
  }
  return ($ok -and $commitOnSuccess)
}

function Test-HasV6ManifestNow([string]$path) {
  try {
    $text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($path))
    return $text.Contains("Microsoft.Windows.Common-Controls")
  } catch { return $false }
}

function Set-V6Manifest([string]$path) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($xml)
  $size = [uint32]$bytes.Length
  # Freshly linked binaries can be briefly locked (AV scan, indexer).
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    # Strategy 1: overwrite the neutral-lang manifest in place. windres
    # emits neutral lang, so this is the common case. NOTE: delete+add of
    # the same resource inside ONE session fails — never combine them.
    $wrote = Invoke-ResSession $path {
      param($h)
      [NcResUpd]::UpdateResource($h, [IntPtr]24, [IntPtr]1, 0, $bytes, $size)
    } $true
    if ($wrote -and (Test-HasV6ManifestNow $path)) { return $true }
    # Strategy 2 (fallback): the original used another language id.
    # Delete all variants in one session, add ours in a FRESH session.
    [void](Invoke-ResSession $path {
      param($h)
      [void][NcResUpd]::UpdateResource($h, [IntPtr]24, [IntPtr]1, 0, $null, 0)
      [void][NcResUpd]::UpdateResource($h, [IntPtr]24, [IntPtr]1, 1033, $null, 0)
      return $true
    } $true)
    $wrote = Invoke-ResSession $path {
      param($h)
      [NcResUpd]::UpdateResource($h, [IntPtr]24, [IntPtr]1, 0, $bytes, $size)
    } $true
    if ($wrote -and (Test-HasV6ManifestNow $path)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$patched = 0
$skipped = 0
foreach ($exe in Get-ChildItem $TargetDir -Filter "*.exe" -File) {
  if (Test-HasV6Manifest $exe.FullName) { $skipped++; continue }
  if (Set-V6Manifest $exe.FullName) { $patched++ }
  else { Write-Host "[manifest] FAILED: $($exe.Name)" }
}
Write-Host "[manifest] patched=$patched skipped=$skipped"
