import { invoke } from "@tauri-apps/api/core";
import {
  parse,
  modify,
  applyEdits,
  type ModificationOptions,
  type ParseError,
} from "jsonc-parser";

export type McpScope = "project" | "global";

export interface McpLocal {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  timeout?: number;
}

export interface McpRemote {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown> | false;
  enabled?: boolean;
  timeout?: number;
}

export type McpServer = McpLocal | McpRemote;

export interface McpEntry {
  name: string;
  server: McpServer;
  scope: McpScope;
  /** Raw `mcp list` row matched by name, if any. */
  status?: McpStatus;
}

export interface McpStatus {
  name: string;
  state: "ok" | "error" | "unknown";
  detail: string;
}

export interface McpListResult {
  entries: McpEntry[];
  globalPath: string;
  projectPath: string | null;
  /** Raw CLI output (fallback view when parsing fails). */
  raw: string;
}

const MOD_OPTS: ModificationOptions = {
  formattingOptions: { insertSpaces: true, tabSize: 2 },
};

function join(base: string, name: string): string {
  const b = base.replace(/[\\/]+$/, "");
  const sep = b.includes("\\") && !b.includes("/") ? "\\" : "/";
  return `${b}${sep}${name}`;
}

async function homeDir(): Promise<string> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    return await homeDir();
  } catch {
    return "";
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await invoke<string>("fs_read_file", { path });
  } catch {
    return null;
  }
}

function parseMcp(text: string | null): Record<string, McpServer> {
  if (!text) return {};
  try {
    const errors: ParseError[] = [];
    const doc = parse(text, errors, { allowTrailingComma: true }) as unknown;
    if (doc && typeof doc === "object") {
      const mcp = (doc as Record<string, unknown>).mcp;
      if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
        return mcp as Record<string, McpServer>;
      }
    }
  } catch {
    /* malformed config — treat as empty, never crash */
  }
  return {};
}

function isLocal(s: McpServer): s is McpLocal {
  return (s as { type?: string }).type !== "remote";
}

/**
 * Best-effort parse of `opencode mcp list` output.
 * Prefers structured JSON when the CLI emits it, falls back to the
 * (brittle) ANSI-table heuristic. Unknown lines stay `unknown`.
 */
export function parseMcpList(stdout: string): McpStatus[] {
  const fromJson = tryParseMcpJson(stdout);
  if (fromJson) return fromJson;
  const out: McpStatus[] = [];
  // eslint-disable-next-line no-control-regex
  const ansi = /\u001b\[[0-9;]*m/g;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(ansi, "").trim();
    if (!line) continue;
    // Skip TUI decorations (box-drawing, headers, hints).
    if (/^[┌│└├┤┬┴┼─═║]+/.test(line)) continue;
    if (/^(mcp servers|no mcp servers configured|add servers with:)/i.test(line)) continue;
    // Skip table headers / separators.
    if (/^(name|server|status|─+|-+|═+|=+)\b/i.test(line) && !/[:/\\]/.test(line)) continue;
    // Strip leading status glyphs (● ○ ▲ ✗ ✓ …), then name + rest.
    const bare = line.replace(/^[●○▲✗✖✓✔×⚠◌◍*]+\s*/u, "");
    const m = bare.match(/^([A-Za-z0-9_][\w\-.]*)\s*(.*)$/);
    if (!m) continue; // continuation/detail line of the previous row
    const [, name, rest] = m;
    const low = rest.toLowerCase();
    const state: McpStatus["state"] = /disabled/.test(low)
      ? "unknown"
      : /connected|ready|\bok\b|✓|●/.test(low)
        ? "ok"
        : /fail|error|disconnect|✗|×|timeout/.test(low)
          ? "error"
          : "unknown";
    out.push({ name, state, detail: rest.trim() || line });
  }
  return out;
}

/** Parse `mcp list` JSON if the CLI ever emits it (array or {servers}). */
function tryParseMcpJson(stdout: string): McpStatus[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const rows = Array.isArray(doc)
    ? doc
    : (doc as { servers?: unknown })?.servers;
  if (!Array.isArray(rows)) return null;
  const out: McpStatus[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const name =
      typeof rec.name === "string" && rec.name ? rec.name : null;
    if (!name) continue;
    const rawState = `${rec.state ?? rec.status ?? ""}`.toLowerCase();
    const state: McpStatus["state"] = /connected|ready|\bok\b/.test(rawState)
      ? "ok"
      : /fail|error|disconnect|timeout/.test(rawState)
        ? "error"
        : "unknown";
    const detailSrc = rec.detail ?? rec.error ?? rec.state ?? rec.status;
    out.push({
      name,
      state,
      detail: typeof detailSrc === "string" && detailSrc ? detailSrc : name,
    });
  }
  return out;
}

async function runMcpList(binaryPath: string, workDir: string): Promise<string> {
  try {
    const res = await invoke<{ code: number; stdout: string; stderr: string }>(
      "mcp_list",
      { binaryPath, workDir: workDir || null },
    );
    return res.stdout || res.stderr;
  } catch {
    return "";
  }
}

/** Load merged MCP entries (project first, then global-only). */
export async function loadMcp(): Promise<McpListResult> {
  const { useEditorStore } = await import("../stores/editorStore");
  const { useSettingsStore } = await import("../stores/settingsStore");
  const ed = useEditorStore.getState();
  const settings = useSettingsStore.getState();
  const root = ed.root || settings.workDir || "";

  const home = await homeDir();
  const globalPath = home ? join(join(home, ".config"), "opencode") : "";
  const globalFile = async (): Promise<string | null> => {
    if (!globalPath) return null;
    for (const n of ["opencode.jsonc", "opencode.json"]) {
      const t = await readText(join(globalPath, n));
      if (t !== null) return t;
    }
    return null;
  };

  const projectPath = root ? join(root, "opencode.json") : null;
  const [globalText, projectText] = await Promise.all([
    globalFile(),
    projectPath ? readText(projectPath) : Promise.resolve(null),
  ]);

  const globalMcp = parseMcp(globalText);
  const projectMcp = parseMcp(projectText);

  const raw = await runMcpList(settings.binaryPath || "opencode", root);
  const statuses = parseMcpList(raw);
  const byName = new Map(statuses.map((s) => [s.name.toLowerCase(), s]));

  const entries: McpEntry[] = [];
  for (const [name, server] of Object.entries(projectMcp)) {
    entries.push({ name, server, scope: "project", status: byName.get(name.toLowerCase()) });
  }
  for (const [name, server] of Object.entries(globalMcp)) {
    if (projectMcp[name] !== undefined) continue; // project overrides
    entries.push({ name, server, scope: "global", status: byName.get(name.toLowerCase()) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    entries,
    globalPath: globalPath ? join(globalPath, "opencode.json") : "",
    projectPath,
    raw: statuses.length > 0 ? "" : raw,
  };
}

/** Resolve the concrete file backing a scope (prefers existing .jsonc). */
async function scopeFile(scope: McpScope, projectPath: string | null, globalPath: string): Promise<string> {
  if (scope === "project") {
    if (!projectPath) throw new Error("Нет открытого проекта");
    for (const cand of [projectPath, projectPath + "c"]) {
      try {
        if (await invoke<boolean>("fs_exists", { path: cand })) return cand;
      } catch {
        /* try next */
      }
    }
    return projectPath;
  }
  for (const cand of [globalPath, globalPath + "c"]) {
    if (!cand) continue;
    try {
      if (await invoke<boolean>("fs_exists", { path: cand })) return cand;
    } catch {
      /* try next */
    }
  }
  if (!globalPath) throw new Error("Не найден global-конфиг");
  return globalPath;
}

type McpOp = [(string | number)[], unknown];

async function editMcpFile(file: string, ops: McpOp[]): Promise<void> {
  const current = (await readText(file)) ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  let parsed: unknown;
  try {
    parsed = parse(current);
  } catch {
    throw new Error(`Конфиг повреждён: ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Конфиг повреждён: ${file}`);
  }
  let next = current;
  for (const [path, value] of ops) {
    next = applyEdits(next, modify(next, path, value, MOD_OPTS));
  }
  await invoke("fs_write_file", { path: file, content: next });
}

/** Add or replace a server in the given scope. */
export async function upsertMcpServer(
  scope: McpScope,
  name: string,
  server: McpServer,
  projectPath: string | null,
  globalPath: string,
): Promise<void> {
  const file = await scopeFile(scope, projectPath, globalPath);
  await editMcpFile(file, [[["mcp", name], server]]);
}

/** Toggle `enabled` for a server (writes explicit boolean). */
export async function setMcpEnabled(
  entry: McpEntry,
  enabled: boolean,
  projectPath: string | null,
  globalPath: string,
): Promise<void> {
  const file = await scopeFile(entry.scope, projectPath, globalPath);
  await editMcpFile(file, [[["mcp", entry.name, "enabled"], enabled]]);
}

/** Remove a server from its scope file. */
export async function deleteMcpServer(
  entry: McpEntry,
  projectPath: string | null,
  globalPath: string,
): Promise<void> {
  const file = await scopeFile(entry.scope, projectPath, globalPath);
  await editMcpFile(file, [[["mcp", entry.name], undefined]]);
}

export function describeServer(s: McpServer): string {
  if (isLocal(s)) return (s.command ?? []).join(" ") || "local";
  return s.url || "remote";
}

export { isLocal };
