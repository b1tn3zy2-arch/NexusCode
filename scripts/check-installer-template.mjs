// Syntax-checks src-tauri/installer.nsi with makensis.
//
// The template contains tauri-bundler handlebars placeholders, so we render
// it with dummy values (mirroring what bundler 2.9.x substitutes) into a
// temp dir next to the vendored helpers (scripts/installer-check/vendor/)
// and run makensis on the result. The real template is never modified.
//
// The nsis_tauri_utils plugin is built by Tauri at bundle time, so its calls
// are stubbed with Nop for the check only.
//
// Usage: node scripts/check-installer-template.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tpl = readFileSync(path.join(root, "src-tauri/installer.nsi"), "utf8");

// Collect every {{...}} placeholder used by the template.
const vars = new Set();
for (const m of tpl.matchAll(/\{\{\{?([^{}|]+?)\}?\}\}/g)) {
  vars.add(m[1].trim().split(/\s+/)[0]);
}
console.log("placeholders:", [...vars].sort().join(", "));

const dummies = {
  compression: "lzma",
  manufacturer: "Dummy",
  product_name: "Dummy",
  version: "0.0.0",
  version_with_build: "0.0.0.0",
  homepage: "https://example.com",
  install_mode: "currentUser",
  license: "",
  installer_icon: "",
  sidebar_image: "",
  header_image: "",
  uninstaller_icon: "",
  uninstaller_header_image: "",
  main_binary_name: "dummy",
  main_binary_path: "C:\\dummy.exe",
  bundle_id: "dummy",
  copyright: "Dummy",
  out_file: "C:\\dummy-out.exe",
  arch: "x64",
  additional_plugins_path: ".",
  allow_downgrades: "true",
  display_language_selector: "false",
  install_webview2_mode: "downloadBootstrapper",
  webview2_installer_args: "",
  webview2_bootstrapper_path: "",
  webview2_installer_path: "",
  minimum_webview2_version: "",
  uninstaller_sign_cmd: "",
  estimated_size: "0",
  start_menu_folder: "Dummy",
  languages: ["English"],
  language_files: [],
  resources: [],
  resources_dirs: [],
  resources_ancestors: [],
  binaries: [],
  file_associations: [],
  deep_link_protocols: [],
};

let out = tpl;
out = out.replace(/\{\{\{([^{}]+?)\}\}\}/g, (_, e) => dummies[e.trim().split(/\s+/)[0]] ?? "");
// {{#each}}...{{/each}} with empty arrays -> drop blocks, innermost first
// (handles nesting like file_associations/ext).
{
  const inner = /\{\{#each[^{}]*\}\}(?:(?!\{\{#each)[\s\S])*?\{\{\/each\}\}/g;
  let prev;
  do {
    prev = out;
    out = out.replace(inner, "");
  } while (out !== prev);
}
// {{#if X}}...{{/if}} -> keep inner (makensis handles !if on defines we set)
out = out.replace(/\{\{#if [\w.]+}}/g, "");
out = out.replace(/\{\{\/if}}/g, "");
// remaining simple placeholders
out = out.replace(/\{\{([\w.]+)}}/g, (_, k) => dummies[k] ?? "");
// drop the optional signed-plugins block entirely for the syntax check
out = out
  .split("\n")
  .filter((l) => !l.includes("signed_plugins_path"))
  .join("\n");
const localAppData =
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "C:", "AppData", "Local");
out = out.replace(
  '!addplugindir ""',
  `!addplugindir "${path.join(localAppData, "tauri", "NSIS", "Plugins")}"`,
);

const dir = path.join(tmpdir(), `nc-nsi-check-${Date.now()}`);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(tmpdir(), "nc-nsi-dummy.exe"), Buffer.from("MZ dummy"));
const vendor = path.join(root, "scripts/installer-check/vendor");
for (const f of ["utils.nsh", "FileAssociation.nsh"]) {
  const target = path.join(dir, f);
  copyFileSync(path.join(vendor, f), target);
  // Same plugin stub inside the helper (syntax check only).
  writeFileSync(
    target,
    readFileSync(target, "utf8").replace(/nsis_tauri_utils::\w+[^\n]*/g, "Nop"),
  );
}
writeFileSync(path.join(dir, "empty-hooks.nsh"), "; stub\n");
// The nsis_tauri_utils plugin is built by Tauri at bundle time; stub its
// calls for the syntax check only (the real template is untouched).
out = out.replace(/nsis_tauri_utils::\w+[^\n]*/g, "Nop");
out = out.replace('!include ""', `!include "${path.join(dir, "empty-hooks.nsh")}"`);
// Point the dummy binary at the temp file we actually created.
out = out.replaceAll("C:\\dummy.exe", path.join(tmpdir(), "nc-nsi-dummy.exe"));
writeFileSync(path.join(dir, "check.nsi"), out);

const makensis = path.join(localAppData, "tauri", "NSIS", "makensis.exe");
try {
  execSync(`"${makensis}" "${path.join(dir, "check.nsi")}"`, { stdio: "pipe" });
  console.log("MAKENSIS: syntax OK");
} catch (e) {
  console.log("MAKENSIS FAILED:");
  console.log((e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") + e.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
