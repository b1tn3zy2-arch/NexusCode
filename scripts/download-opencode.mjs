// Downloads the OpenCode CLI as a Tauri sidecar for the current platform.
// Result: src-tauri/binaries/opencode-<target-triple>[.exe]
// Cached across builds; pass --force to re-download.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "binaries");
const force = process.argv.includes("--force");

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
  console.error(`[sidecar] unsupported platform: ${platformKey}`);
  process.exit(1);
}

// Pinned sidecar version (scripts/versions.json) — reproducible builds.
// Env NEXUS_OPENCODE wins for one-off bumps (e.g. NEXUS_OPENCODE=v9.9.9).
let PINS = {};
try {
  PINS = JSON.parse(readFileSync(path.join(root, "scripts", "versions.json"), "utf8"));
} catch {
  /* latest fallback below */
}
const OPENCODE_PIN = process.env.NEXUS_OPENCODE ?? PINS.opencode ?? null;

const exeSuffix = triple.includes("windows") ? ".exe" : "";
const outPath = path.join(outDir, `opencode-${triple}${exeSuffix}`);

if (!force && existsSync(outPath)) {
  console.log(`[sidecar] cached: ${outPath}`);
  process.exit(0);
}

const releaseUrl = OPENCODE_PIN
  ? `https://api.github.com/repos/anomalyco/opencode/releases/tags/${OPENCODE_PIN}`
  : "https://api.github.com/repos/anomalyco/opencode/releases/latest";
console.log(`[sidecar] fetching ${OPENCODE_PIN ? `pinned OpenCode ${OPENCODE_PIN}` : "latest OpenCode release"} for ${triple}...`);

const { fetchJson } = await import("./fetch-retry.mjs");
let release;
try {
  release = await fetchJson(releaseUrl, "opencode release metadata");
} catch (e) {
  console.error(`[sidecar] GitHub API failed: ${e.message} (${releaseUrl})`);
  process.exit(1);
}
if (OPENCODE_PIN && release.tag_name !== OPENCODE_PIN) {
  console.error(`[sidecar] tag mismatch: wanted ${OPENCODE_PIN}, got ${release.tag_name}`);
  process.exit(1);
}

const assets = release.assets ?? [];
const pickWindows = () =>
  assets.find((a) => /windows/i.test(a.name) && /(x64|amd64|x86_64)/i.test(a.name) && /\.zip$/i.test(a.name));
const pickDarwin = () =>
  assets.find((a) => /darwin|macos|mac/i.test(a.name) && /(arm64|aarch64)/i.test(a.name) && /\.(zip|tar\.gz)$/i.test(a.name));
const pickLinux = (archRe) =>
  assets.find((a) => /linux/i.test(a.name) && archRe.test(a.name) && /\.(zip|tar\.gz)$/i.test(a.name));

let asset = null;
if (triple.startsWith("x86_64-pc-windows")) asset = pickWindows();
else if (triple.includes("apple-darwin") && triple.includes("aarch64")) asset = pickDarwin();
else if (triple.includes("linux") && triple.includes("aarch64")) asset = pickLinux(/(arm64|aarch64)/i);
else if (triple.includes("linux")) asset = pickLinux(/(x64|amd64|x86_64)/i);

if (!asset) {
  console.error("[sidecar] no matching asset. Available:");
  for (const a of assets) console.error("  -", a.name);
  process.exit(1);
}

console.log(`[sidecar] downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)...`);
const { fetchBuf } = await import("./fetch-retry.mjs");
let assetBuf;
try {
  assetBuf = await fetchBuf(asset.browser_download_url, `opencode asset ${asset.name}`);
} catch (e) {
  console.error(`[sidecar] download failed: ${e.message}`);
  process.exit(1);
}
const tmpRoot = path.join(root, "node_modules", ".sidecar-tmp");
mkdirSync(tmpRoot, { recursive: true });
const archivePath = path.join(tmpRoot, asset.name);
await writeFile(archivePath, assetBuf);

mkdirSync(outDir, { recursive: true });

if (/\.zip$/i.test(asset.name)) {
  const dest = path.join(tmpRoot, "unzipped-" + Date.now());
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${dest}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -o "${archivePath}" -d "${dest}"`, { stdio: "inherit" });
  }
  const found = findBinary(dest);
  if (!found) {
    console.error("[sidecar] binary not found inside archive");
    process.exit(1);
  }
  await rename(found, outPath);
} else {
  // tar.gz
  const dest = path.join(tmpRoot, "untarred-" + Date.now());
  mkdirSync(dest, { recursive: true });
  execSync(`tar -xzf "${archivePath}" -C "${dest}"`, { stdio: "inherit" });
  const found = findBinary(dest);
  if (!found) {
    console.error("[sidecar] binary not found inside archive");
    process.exit(1);
  }
  await rename(found, outPath);
}

await rm(tmpRoot, { recursive: true, force: true });

console.log(`[sidecar] placed: ${outPath}`);

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
  console.log(`[sidecar] hash recorded: ${digest.slice(0, 16)}…`);
}

function findBinary(dir) {
  const wanted = triple.includes("windows")
    ? /^opencode(\.exe)?$/i
    : /^opencode$/i;
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
