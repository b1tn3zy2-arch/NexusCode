import { invoke } from "@tauri-apps/api/core";
import { opencode } from "../services/backend";

export type TermKind = "opencode" | "shell";

export interface TermProfile {
  id: string;
  name: string;
  shell: string;
  args: string[];
  icon?: string;
  env?: Record<string, string>;
}

/**
 * Built-in profiles (user-editable in Settings, persisted).
 * "nexuscode" is the blessed default: PowerShell with the bundled
 * interpreter on PATH, so bare `pip` / `python` just work.
 */
export const NEXUS_PROFILE_ID = "nexuscode";

export function defaultTerminalProfiles(): TermProfile[] {
  return [
    { id: NEXUS_PROFILE_ID, name: "NexusCode", shell: "powershell.exe", args: ["-NoLogo"], icon: "terminal" },
    { id: "powershell", name: "PowerShell", shell: "powershell.exe", args: ["-NoLogo"], icon: "terminal" },
    { id: "cmd", name: "Command Prompt", shell: "cmd.exe", args: [], icon: "terminal" },
    { id: "pyrepl", name: "Python REPL", shell: "__bundled_python__", args: [], icon: "bot" },
  ];
}

/** Git Bash auto-detect (offered in the +-menu, not stored). */
export async function detectGitBash(): Promise<string | null> {
  for (const p of [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
  ]) {
    if (await exists(p)) return p;
  }
  return null;
}

/** Default interactive shell (VS Code parity: PowerShell on Windows). */
export function defaultShell(): string {
  if (typeof navigator !== "undefined" && /win/i.test(navigator.userAgent)) {
    return "powershell.exe";
  }
  return "powershell.exe"; // NexusCode targets Windows; harmless elsewhere
}

async function exists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("fs_exists", { path });
  } catch {
    return false;
  }
}

const join = (dir: string, ...rest: string[]) =>
  [dir.replace(/[\\/]+$/, ""), ...rest].join("/");

const VENV_DIRS = [".venv", "venv", "env"];

/**
 * Find a Python venv in the work dir (first match wins).
 * Returns the venv root dir, or null.
 */
export async function detectVenv(workDir: string): Promise<string | null> {
  if (!workDir) return null;
  const isWin =
    typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);
  for (const d of VENV_DIRS) {
    const root = join(workDir, d);
    const py = isWin ? join(root, "Scripts/python.exe") : join(root, "bin/python");
    if (await exists(py)) return root;
  }
  return null;
}

/** Short venv label for the status bar, e.g. ".venv". Null = system python. */
export async function detectVenvLabel(workDir: string): Promise<string | null> {
  const v = await detectVenv(workDir);
  if (!v) return null;
  return v.split("/").pop() ?? v;
}

export interface PipResolution {
  /** Ready-to-paste pip invocation, e.g. `"C:\...\python.exe" -m pip` */
  cmd: string;
  hasPip: boolean;
  source: "venv" | "bundled" | "system";
}

export interface BundledStatus {
  available: boolean;
  installed: boolean;
  bin: string | null;
}

export async function bundledStatus(): Promise<BundledStatus | null> {
  try {
    return await invoke<BundledStatus>("python_bundled_status");
  } catch {
    return null;
  }
}

/**
 * Bundled python binary, running first-run setup if needed.
 * Returns null when the bundle isn't shipped or setup failed.
 */
export async function ensureBundledPython(): Promise<string | null> {
  const st = await bundledStatus().catch(() => null);
  if (!st) return null;
  if (st.installed && st.bin) return st.bin;
  if (!st.available) return null;
  try {
    return await invoke<string>("setup_bundled_python");
  } catch {
    return null;
  }
}

const q = (s: string) =>
  /\s/.test(s) && !s.startsWith('"') ? `"${s}"` : s;

/**
 * Resolve a WORKING pip invocation: project venv → bundled python → system
 * (`python -m pip`, never bare `pip` — it is often missing from PATH).
 * Returns null when no Python exists at all (bundled setup NOT triggered
 * here — call ensureBundledPython() explicitly from install flows).
 */
export async function resolvePip(workDir: string): Promise<PipResolution | null> {
  try {
    const venv = workDir ? await detectVenv(workDir) : null;
    if (venv) {
      const root = venv.replace(/[\\/]+$/, "");
      const isWin =
        typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);
      const pip = isWin ? `${root}\\Scripts\\pip.exe` : `${root}/bin/pip`;
      if (await exists(pip)) return { cmd: q(pip), hasPip: true, source: "venv" };
      const py = isWin ? `${root}\\Scripts\\python.exe` : `${root}/bin/python`;
      if (await exists(py)) return { cmd: `${q(py)} -m pip`, hasPip: true, source: "venv" };
    }
  } catch {
    /* fall through to system */
  }
  try {
    const st = await bundledStatus().catch(() => null);
    if (st?.installed && st.bin)
      return { cmd: `${q(st.bin)} -m pip`, hasPip: true, source: "bundled" };
  } catch {
    /* fall through to system */
  }
  try {
    const info = await opencode.detectPython();
    if (!info) return null;
    const parts = [q(info.bin), ...info.args, "-m", "pip"];
    return { cmd: parts.join(" "), hasPip: info.has_pip, source: "system" };
  } catch {
    return null;
  }
}

/** True when the project needs Python (for the missing-python hint). */
export async function needsPythonForDir(workDir: string): Promise<boolean> {
  if (!workDir) return false;
  return (
    (await exists(join(workDir, "requirements.txt"))) ||
    (await exists(join(workDir, "pyproject.toml")))
  );
}

/**
 * Detect how to run/install the project, VS Code style.
 * First match wins. pip commands use the resolved interpreter.
 */
export async function detectRunCommand(workDir: string): Promise<string | null> {
  if (!workDir) return null;
  if (await exists(join(workDir, "package.json"))) return "npm run dev";
  const pip = await resolvePip(workDir).catch(() => null);
  const pipCmd = pip ? pip.cmd : "pip";
  if (await exists(join(workDir, "requirements.txt")))
    return `${pipCmd} install -r requirements.txt`;
  if (await exists(join(workDir, "pyproject.toml"))) return `${pipCmd} install -e .`;
  if (await exists(join(workDir, "Cargo.toml"))) return "cargo run";
  if (await exists(join(workDir, "go.mod"))) return "go run .";
  return null;
}
