import { invoke } from "@tauri-apps/api/core";
import type {
  MessageInfo,
  OcEvent,
  Part,
  ServerInfoPayload,
  Session,
} from "../types/opencode";

export const backend = {
  resolveBinary: (configured?: string): Promise<string> =>
    invoke<string>("resolve_binary", { configured: configured ?? null }),
  defaultWorkdir: (): Promise<string> => invoke<string>("default_workdir"),
  serverStart: (config: {
    binary_path: string;
    work_dir: string;
    port: number | null;
    proxy_url?: string | null;
  }): Promise<ServerInfoPayload> => invoke<ServerInfoPayload>("server_start", { config }),
  serverStop: (): Promise<void> => invoke<void>("server_stop"),
  serverStatus: (): Promise<{ running: boolean }> =>
    invoke<{ running: boolean }>("server_status"),
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("oc_request", {
    request: { method, path, body: body ?? null },
  });
}

/** Raw provider entry from GET /config/providers. Shapes vary by source
 *  (models.dev cache vs custom): capabilities/cost may be objects or arrays. */
export interface ProviderModelRaw {
  id: string;
  providerID?: string;
  name?: string;
  capabilities?: {
    input?: string[] | Record<string, boolean>;
    output?: string[] | Record<string, boolean>;
    tools?: boolean;
    toolcall?: boolean;
  };
  cost?: { input?: number; output?: number } | { input?: number; output?: number }[];
  limit?: { context?: number; input?: number; output?: number };
  status?: string;
  release_date?: string;
}

export interface ProviderRaw {
  id: string;
  name?: string;
  models?: Record<string, ProviderModelRaw>;
}

/** System Python found by the backend (Store stub excluded, version probed). */
export interface PythonInfo {
  bin: string;
  args: string[];
  has_pip: boolean;
}

export const opencode = {
  health: () =>
    api<{ healthy: boolean; version: string }>("GET", "/global/health"),
  detectPython: (): Promise<PythonInfo | null> =>
    invoke<PythonInfo | null>("detect_python"),
  getProviders: () =>
    api<{ providers: ProviderRaw[] }>("GET", "/config/providers"),
  listSessions: () => api<Session[]>("GET", "/session"),
  createSession: (title?: string, model?: string) =>
    api<Session>(
      "POST",
      "/session",
      title || model
        ? { ...(title ? { title } : {}), ...(model ? { model } : {}) }
        : {},
    ),
  deleteSession: (id: string) => api<boolean>("DELETE", `/session/${id}`),
  getMessages: (id: string) =>
    api<{ info: MessageInfo; parts: Part[] }[]>(
      "GET",
      `/session/${id}/message`,
    ),
  promptAsync: (id: string, parts: unknown[]) =>
    api<void>("POST", `/session/${id}/prompt_async`, { parts }),
  setSessionModel: (id: string, model: string) =>
    api<unknown>("PATCH", `/session/${id}`, { model }),
  abortSession: (id: string) => api<boolean>("POST", `/session/${id}/abort`, {}),
};

export interface AaConfigPayload {
  enabled: boolean;
  profile: string;
  delay_ms: number;
  whitelist: string[];
  blacklist: string[];
  protected_files: string[];
}

export interface ActionLogEntry {
  id: number;
  ts: number;
  session_id: string | null;
  permission_id: string | null;
  tool: string | null;
  detail: string | null;
  decision: "approved" | "rejected";
  reason: string | null;
  auto: boolean;
}

export interface PreparedImage {
  data_b64: string;
  mime: string;
  width: number;
  height: number;
  size: number;
}

export const imagesApi = {
  prepare: (dataB64: string) =>
    invoke<PreparedImage>("prepare_image", { dataB64 }),
  readFile: (path: string) => invoke<PreparedImage>("read_image_file", { path }),
  captureScreen: () => invoke<PreparedImage>("capture_screen"),
};

export interface SymbolItem {
  label: string;
  detail?: string;
  insert: string;
}

export interface LoopConfig {
  sessionId: string;
  prompt: string;
  maxIterations: number;
  intervalMs: number;
  autoCommit: boolean;
  runTests: boolean;
  testCommand?: string | null;
  stopOnTestFailure: boolean;
  noChangesThreshold: number;
  successPattern?: string | null;
}

export interface LoopIteration {
  iteration: number;
  status: string;
  startedAt: number;
  finishedAt: number;
  filesChanged: string[];
  shortstat: string;
  testsOk?: boolean | null;
  commitHash?: string | null;
}

export interface LoopSnapshot {
  running: boolean;
  paused: boolean;
  phase: string;
  iteration: number;
  maxIterations: number;
  history: LoopIteration[];
  lastError?: string | null;
  notice?: string | null;
  stopReason?: string | null;
  convergedCount: number;
  gitAvailable: boolean;
  sessionId?: string | null;
}

export interface ContinuousConfig {
  sessionId: string;
  goal: string;
  approvalMode: "auto" | "manual";
  maxActions: number;
  maxTimeMinutes: number;
  maxCostUsd: number;
  checkpoints: boolean;
  runValidation: boolean;
  validationCommand?: string | null;
  stopOnValidationError: boolean;
  detectSubtasks: boolean;
  verifyCommands?: string[];
  autoVerify?: boolean;
  maxRetriesPerStep?: number;
  untilDone?: boolean;
}

export interface ContPlanStep {
  id: string;
  description: string;
  status: string;
  attempts?: number;
}

export interface ContVerifyReport {
  command: string;
  ok: boolean;
  attempt: number;
  outputTail: string;
}

export interface ContCheckpoint {
  id: string;
  ts: number;
  description: string;
  hash?: string | null;
}

export interface ContinuousSnapshot {
  running: boolean;
  paused: boolean;
  phase: string;
  goal: string;
  steps: ContPlanStep[];
  currentIndex: number;
  checkpoints: ContCheckpoint[];
  startedAt: number;
  actionsCount: number;
  costUsd: number;
  lastError?: string | null;
  hitReason?: string | null;
  stopReason?: string | null;
  gitAvailable: boolean;
  sessionId?: string | null;
  lastVerify?: ContVerifyReport | null;
}

export const continuousApi = {
  start: (config: ContinuousConfig) =>
    invoke<ContinuousSnapshot>("continuous_start", { config }),
  stop: () => invoke<void>("continuous_stop"),
  pause: (paused: boolean) => invoke<void>("continuous_pause", { paused }),
  resume: () => invoke<void>("continuous_resume"),
  approvePlan: (approved: boolean) =>
    invoke<void>("continuous_approve_plan", { approved }),
  skipStep: () => invoke<void>("continuous_skip_step"),
  status: () => invoke<ContinuousSnapshot>("continuous_status"),
  rollback: (checkpointId: string) =>
    invoke<void>("continuous_rollback", { checkpointId }),
  resumeSaved: () =>
    invoke<{ snapshot: ContinuousSnapshot; config: ContinuousConfig }>(
      "continuous_resume_saved",
    ),
  detectValidation: (workdir?: string | null) =>
    invoke<string[]>("continuous_detect_validation", {
      workdir: workdir ?? null,
    }),
};

export const loopApi = {
  start: (config: LoopConfig) =>
    invoke<LoopSnapshot>("loop_start", { config }),
  stop: () => invoke<void>("loop_stop"),
  pause: (paused: boolean) => invoke<void>("loop_pause", { paused }),
  status: () => invoke<LoopSnapshot>("loop_status"),
};

export const findApi = {  files: async (query: string): Promise<string[]> => {
    const q = query.trim();
    if (!q) return [];
    return api<string[]>(
      "GET",
      `/find/file?query=${encodeURIComponent(q)}&limit=12`,
    );
  },
  symbols: async (query: string): Promise<SymbolItem[]> => {
    const q = query.trim();
    if (!q) return [];
    const raw = await api<
      { name?: string; kind?: string; path?: string; location?: { path?: string } }[]
    >("GET", `/find/symbol?query=${encodeURIComponent(q)}`);
    return raw.slice(0, 12).map((s) => {
      const p = s.path ?? s.location?.path ?? "";
      return {
        label: s.name ?? "(symbol)",
        detail: p,
        insert: s.name ?? "",
      };
    });
  },
};

export const autoApproveApi = {
  setConfig: (cfg: AaConfigPayload) =>
    invoke<void>("set_auto_approve_config", { config: cfg }),
  respond: (
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ) => invoke<void>("permission_respond", {
      sessionId,
      permissionId,
      response,
    }),
  listLog: (limit = 50) =>
    invoke<ActionLogEntry[]>("action_log_list", { limit }),
  clearLog: () => invoke<void>("action_log_clear"),
};

export function subscribeOcEvents(
  handler: (event: OcEvent) => void,
): Promise<() => void> {
  return listenToOcEvents(handler);
}

function listenToOcEvents(handler: (event: OcEvent) => void) {
  return import("@tauri-apps/api/event").then(({ listen }) =>
    listen<OcEvent>("oc-event", (e) => handler(e.payload)),
  );
}
