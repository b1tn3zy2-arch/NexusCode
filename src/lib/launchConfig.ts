import { invoke } from "@tauri-apps/api/core";
import { detectVenv } from "./shell";

export interface LaunchConfig {
  name: string;
  type: string;
  request: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export function launchJsonPath(workDir: string): string {
  return `${workDir.replace(/[\\/]+$/, "")}/.vscode/launch.json`;
}

export function defaultConfigs(): LaunchConfig[] {
  return [
    {
      name: "Python: Current File",
      type: "debugpy",
      request: "launch",
      program: "${file}",
      console: "integratedTerminal",
    },
    {
      name: "Node: Current File",
      type: "node",
      request: "launch",
      program: "${file}",
      console: "integratedTerminal",
    },
  ];
}

function blankLaunchJson(): string {
  return (
    "{\n" +
    '  "version": "0.2.0",\n' +
    '  "configurations": [\n' +
    defaultConfigs()
      .map(
        (c) =>
          "    {\n" +
          `      "name": "${c.name}",\n` +
          `      "type": "${c.type}",\n` +
          `      "request": "${c.request}",\n` +
          `      "program": "${c.program}",\n` +
          `      "console": "integratedTerminal"\n` +
          "    }",
      )
      .join(",\n") +
    "\n  ]\n}\n"
  );
}

export async function readLaunchConfigs(
  workDir: string,
): Promise<{ configs: LaunchConfig[]; path: string; exists: boolean }> {
  const path = launchJsonPath(workDir);
  try {
    const raw = await invoke<string>("fs_read_file", { path });
    const parsed = JSON.parse(raw) as { configurations?: LaunchConfig[] };
    const configs = Array.isArray(parsed.configurations)
      ? parsed.configurations.filter((c) => c && typeof c.name === "string")
      : [];
    return { configs, path, exists: true };
  } catch {
    return { configs: [], path, exists: false };
  }
}

/** Create .vscode/launch.json with defaults if missing. Returns the path. */
export async function ensureLaunchJson(workDir: string): Promise<string> {
  const path = launchJsonPath(workDir);
  try {
    await invoke<string>("fs_read_file", { path });
    return path;
  } catch {
    /* missing — create */
  }
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  try {
    await invoke<void>("fs_create_dir", { path: dir });
  } catch {
    /* may already exist */
  }
  await invoke<void>("fs_write_file", { path, content: blankLaunchJson() });
  return path;
}

/** Append the first missing default config (python, then node). */
export async function appendMissingConfig(workDir: string): Promise<string> {
  const path = await ensureLaunchJson(workDir);
  const raw = await invoke<string>("fs_read_file", { path });
  let parsed: { version?: string; configurations?: LaunchConfig[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  if (!Array.isArray(parsed.configurations)) parsed.configurations = [];
  const names = new Set(parsed.configurations.map((c) => c?.name));
  const missing = defaultConfigs().find((c) => !names.has(c.name));
  if (!missing) return path;
  parsed.configurations.push(missing);
  const out =
    JSON.stringify({ version: parsed.version ?? "0.2.0", configurations: parsed.configurations }, null, 2) +
    "\n";
  await invoke<void>("fs_write_file", { path, content: out });
  return path;
}

const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

function substitute(
  s: string,
  vars: { file: string; workspaceFolder: string; fileDirname: string },
): string {
  return s
    .replace(/\$\{file\}/g, vars.file)
    .replace(/\$\{workspaceFolder\}/g, vars.workspaceFolder)
    .replace(/\$\{fileDirname\}/g, vars.fileDirname);
}

async function pythonBin(workDir: string): Promise<string> {
  try {
    const venv = await detectVenv(workDir);
    if (venv) {
      const root = venv.replace(/[\\/]+$/, "");
      const isWin =
        typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);
      return q(isWin ? `${root}\\Scripts\\python.exe` : `${root}/bin/python`);
    }
  } catch {
    /* fall through */
  }
  return "python";
}

function inferFromFile(file: string): { type: string; program: string } | null {
  if (/\.(mjs|cjs|js)$/i.test(file)) return { type: "node", program: file };
  if (/\.py$/i.test(file)) return { type: "python", program: file };
  return null;
}

/**
 * Build the shell command for a launch config (or auto-inferred file).
 * No DAP yet — the program runs in the integrated shell; breakpoints
 * stay armed for the future adapter.
 */
export async function buildRunCommand(
  workDir: string,
  cfg: LaunchConfig | null,
  activeFile: string | null,
): Promise<{ cmd: string; label: string }> {
  const vars = {
    file: activeFile ?? "",
    workspaceFolder: workDir,
    fileDirname: (activeFile ?? workDir).replace(/[\\/][^\\/]+$/, "") || workDir,
  };
  let type = cfg?.type ?? "";
  let program = cfg?.program ? substitute(cfg.program, vars) : "";
  const args = (cfg?.args ?? []).map((a) => substitute(String(a), vars));
  const cwd = cfg?.cwd ? substitute(cfg.cwd, vars) : "";

  if (!program && activeFile) {
    const inferred = inferFromFile(activeFile);
    if (inferred) {
      type = inferred.type;
      program = inferred.program;
    }
  }
  if (!program) {
    throw new Error("Нечего запускать: нет program и нет открытого файла (.py/.js)");
  }
  const t = type.toLowerCase();
  let bin: string;
  if (t.includes("py")) {
    bin = await pythonBin(workDir);
  } else if (t.includes("node") || /\.(mjs|cjs|js)x?$/i.test(program)) {
    bin = "node";
  } else if (/\.py$/i.test(program)) {
    bin = await pythonBin(workDir);
  } else {
    throw new Error(`Не знаю чем запускать: type="${type || "?"}", file="${program}"`);
  }
  const parts = [bin, q(program), ...args.map((a) => q(a))];
  const cmd = cwd ? `cd ${q(cwd)}; ${parts.join(" ")}` : parts.join(" ");
  return { cmd, label: cfg?.name ?? program.split(/[\\/]/).pop() ?? program };
}
