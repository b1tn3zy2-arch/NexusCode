// Downloads the sing-box core as a NexusCode sidecar for the current platform.
// Result: src-tauri/binaries/sing-box-<target-triple>[.exe]
// Cached across builds; pass --force to re-download.
// Pinned version: bump SINGBOX_VERSION deliberately after testing.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "binaries");
const force = process.argv.includes("--force");

// Pinned sidecar versions (scripts/versions.json); env wins for one-off bumps.
let PINS = {};
try {
  PINS = JSON.parse(readFileSync(path.join(root, "scripts", "versions.json"), "utf8"));
} catch {
  /* pinned fallback below */
}
const SINGBOX_VERSION = process.env.NEXUS_SINGBOX ?? PINS.singbox ?? "v1.14.0";

const TRIPLE_MAP = {
  "win32_x64": "x86_64-pc-windows-msvc",
  "win32_arm64": "aarch64-pc-windows-msvc",
  "darwin_arm64": "aarch64-apple-darwin",
  "darwin_x64": "x86_64-apple-darwin",
  "linux_x64": "x86_64-unknown-linux-gnu",
  "linux_arm64": "aarch64-unknown-linux-gnu",
};

const platformKey = `${process.platform}_${process.arch}`;
// NOTE: tauri validates against ITS OWN host triple. On this machine the rust
// default is x86_64-pc-windows-gnu, so accept an override env first.
const triple =
  process.env.NEXUS_TARGET_TRIPLE ?? TRIPLE_MAP[platformKey] ?? null;
if (!triple) {
  console.error(`[sing-box] unsupported platform: ${platformKey}`);
  process.exit(1);
}

const exeSuffix = triple.includes("windows") ? ".exe" : "";
const outPath = path.join(outDir, `sing-box-${triple}${exeSuffix}`);

if (!force && existsSync(outPath)) {
  console.log(`[sing-box] cached: ${outPath}`);
  process.exit(0);
}

console.log(`[sing-box] fetching ${SINGBOX_VERSION} for ${triple}...`);

const { fetchJson, fetchBuf } = await import("./fetch-retry.mjs");
let release;
try {
  release = await fetchJson(
    `https://api.github.com/repos/SagerNet/sing-box/releases/tags/${SINGBOX_VERSION}`,
    "sing-box release metadata",
  );
} catch (e) {
  console.error(`[sing-box] GitHub API failed: ${e.message}`);
  process.exit(1);
}

// Desktop archives look like:
//   sing-box-1.14.0-windows-amd64.zip
//   sing-box-1.14.0-darwin-arm64.tar.gz
//   sing-box-1.14.0-linux-amd64.tar.gz
const assets = release.assets ?? [];
const pick = (osRe, archRe) => {
  const cands = assets.filter(
    (a) =>
      osRe.test(a.name) &&
      archRe.test(a.name) &&
      /\.(zip|tar\.gz)$/i.test(a.name) &&
      !/\.deb$|\.rpm$|\.pkg$|\.apk$/i.test(a.name),
  );
  // Prefer the regular build over the legacy-windows-7 one.
  return cands.find((a) => !/legacy/i.test(a.name)) ?? cands[0] ?? null;
};

let asset = null;
if (triple.startsWith("x86_64-pc-windows") || triple.startsWith("aarch64-pc-windows")) {
  const archRe = triple.startsWith("aarch64") ? /(arm64|aarch64)/i : /(x64|amd64|x86_64)/i;
  asset = pick(/windows/i, archRe);
} else if (triple.includes("apple-darwin")) {
  const archRe = triple.includes("aarch64") ? /(arm64|aarch64)/i : /(x64|amd64|x86_64)/i;
  asset = pick(/darwin/i, archRe);
} else if (triple.includes("linux")) {
  const archRe = triple.includes("aarch64") ? /(arm64|aarch64)/i : /(x64|amd64|x86_64)/i;
  asset = pick(/linux/i, archRe);
}

if (!asset) {
  console.error("[sing-box] no matching asset. Available:");
  for (const a of assets) console.error("  -", a.name);
  process.exit(1);
}

console.log(`[sing-box] downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)...`);
let assetBuf;
try {
  assetBuf = await fetchBuf(asset.browser_download_url, `sing-box asset ${asset.name}`);
} catch (e) {
  console.error(`[sing-box] download failed: ${e.message}`);
  process.exit(1);
}
const tmpRoot = path.join(root, "node_modules", ".singbox-tmp");
mkdirSync(tmpRoot, { recursive: true });
const archivePath = path.join(tmpRoot, asset.name);
await writeFile(archivePath, assetBuf);

mkdirSync(outDir, { recursive: true });

const dest = path.join(tmpRoot, "unpacked-" + Date.now());
mkdirSync(dest, { recursive: true });
if (/\.zip$/i.test(asset.name)) {
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${dest}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -o "${archivePath}" -d "${dest}"`, { stdio: "inherit" });
  }
} else {
  execSync(`tar -xzf "${archivePath}" -C "${dest}"`, { stdio: "inherit" });
}
const found = findBinary(dest);
if (!found) {
  console.error("[sing-box] binary not found inside archive");
  process.exit(1);
}
await rename(found, outPath);

await rm(tmpRoot, { recursive: true, force: true });

if (process.platform !== "win32") {
  try {
    execSync(`chmod +x "${outPath}"`, { stdio: "inherit" });
  } catch {
    /* non-fatal */
  }
}

console.log(`[sing-box] placed: ${outPath}`);

// Record the hash for the runtime integrity check (src-tauri/binaries/SHA256SUMS).
{
  const { createHash } = await import("node:crypto");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const digest = createHash("sha256").update(readFileSync(outPath)).digest("hex");
  const sumsPath = path.join(outDir, "SHA256SUMS");
  const base = path.basename(outPath);
  let lines = [];
  try {
    lines = readFileSync(sumsPath, "utf8").split("\n");
  } catch {
    /* fresh manifest */
  }
  const body = lines.filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith("#")) return true;
    return !t.endsWith(` ${base}`);
  });
  body.push(`${digest}  ${base}`);
  writeFileSync(sumsPath, body.join("\n") + "\n");
  console.log(`[sing-box] hash recorded: ${digest.slice(0, 16)}…`);
}

function findBinary(dir) {
  const wanted = triple.includes("windows")
    ? /^sing-box(\.exe)?$/i
    : /^sing-box$/i;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && wanted.test(entry.name)) return full;
    if (entry.isDirectory()) {
      const nested = findBinary(full);
      if (nested) return nested;
    }
  }
  return null;
}
