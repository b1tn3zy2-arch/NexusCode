// Downloads the embeddable CPython build for the current platform.
// Result: src-tauri/binaries/python/ (extracted, cached across builds).
// Only Windows ships official embed zips; other platforms skip gracefully
// (system python / winget flow remains the fallback).
// Pass --force to re-download.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "binaries", "python");
const force = process.argv.includes("--force");

// Pinned sidecar versions (scripts/versions.json); env wins for one-off bumps.
let PINS = {};
try {
  PINS = JSON.parse(readFileSync(path.join(root, "scripts", "versions.json"), "utf8"));
} catch {
  /* defaults below */
}
const PY_VERSION = process.env.NEXUS_PYTHON ?? PINS.python ?? "3.12.10";
const MARKER = path.join(outDir, ".version");

const ZIPS = {
  win32_x64: `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
  win32_arm64: `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-arm64.zip`,
};

function cached() {
  if (force) return false;
  try {
    if (!existsSync(path.join(outDir, "python.exe"))) return false;
    return readFileSync(MARKER, "utf8").trim() === PY_VERSION;
  } catch {
    return false;
  }
}

const platformKey = `${process.platform}_${process.arch}`;
const url = ZIPS[platformKey];
if (!url) {
  console.log(`[python] no embeddable build for ${platformKey}, skipping (system python fallback stays)`);
  process.exit(0);
}

if (cached()) {
  console.log(`[python] cached: ${outDir} (${PY_VERSION})`);
} else {
console.log(`[python] downloading embeddable Python ${PY_VERSION}...`);
const res = await fetch(url, { headers: { "User-Agent": "nexuscode-build" } });
if (!res.ok) {
  console.error(`[python] download failed: HTTP ${res.status}`);
  process.exit(1);
}
const tmpRoot = path.join(root, "node_modules", ".py-tmp");
mkdirSync(tmpRoot, { recursive: true });
const zipPath = path.join(tmpRoot, `python-embed-${PY_VERSION}.zip`);
writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
execSync(
  `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force"`,
  { stdio: "inherit" },
);
rmSync(tmpRoot, { recursive: true, force: true });
writeFileSync(MARKER, PY_VERSION + "\n");
console.log(`[python] placed: ${outDir}`);
} // end else (fresh embed download)

// ---- offline bootstrap payloads (get-pip.py + debugpy wheel) ----
// These ship inside the installer so first-run Python setup works with
// minimal network (or fully offline when already cached).
const wheelsDir = path.join(root, "src-tauri", "binaries", "python-wheels");
const wheelsMarker = path.join(wheelsDir, ".version");
const DEBUGPY_PIN = process.env.NEXUS_DEBUGPY ?? PINS.debugpy ?? null; // e.g. 1.8.21, else latest
async function fetchBuf(url, what) {
  const r = await fetch(url, { headers: { "User-Agent": "nexuscode-build" } });
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
try {
  const archTag = platformKey === "win32_arm64" ? "arm64" : "amd64";
  // Always present (possibly empty) so the tauri resources glob resolves.
  mkdirSync(wheelsDir, { recursive: true });
  if (!force && existsSync(path.join(wheelsDir, "get-pip.py"))) {
    console.log("[python] wheels cached");
  } else {
    console.log("[python] fetching get-pip.py...");
    writeFileSync(
      path.join(wheelsDir, "get-pip.py"),
      await fetchBuf("https://bootstrap.pypa.io/get-pip.py", "get-pip"),
    );
    console.log("[python] resolving debugpy wheel...");
    const meta = await (await fetch("https://pypi.org/pypi/debugpy/json", {
      headers: { "User-Agent": "nexuscode-build" },
    })).json();
    const version = DEBUGPY_PIN ?? meta?.info?.version;
    if (!version) throw new Error("no debugpy version");
    const files = (meta.urls ?? []).filter(
      (u) =>
        u.packagetype === "bdist_wheel" &&
        u.filename.includes("cp312") &&
        u.filename.includes(archTag) &&
        /\.whl$/.test(u.filename),
    );
    if (files.length === 0) throw new Error(`no cp312/${archTag} wheel`);
    const wheel = files[0];
    console.log(`[python] downloading ${wheel.filename}...`);
    writeFileSync(
      path.join(wheelsDir, wheel.filename),
      await fetchBuf(wheel.url, "debugpy wheel"),
    );
    writeFileSync(wheelsMarker, `${PY_VERSION} debugpy-${version}\n`);
  }
} catch (e) {
  // Offline build: python core still ships; pip/debugpy fall back to download.
  console.error(`[python] wheels skipped: ${e.message}`);
}
