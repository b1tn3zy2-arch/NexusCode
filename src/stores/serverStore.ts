import { create } from "zustand";
import { autoApproveApi, backend, opencode } from "../services/backend";
import { useSettingsStore } from "./settingsStore";
import { logError, logInfo, logWarn } from "./outputStore";

export type ServerStatus = "stopped" | "starting" | "running" | "error";

interface ServerState {
  status: ServerStatus;
  port: number | null;
  version: string | null;
  error: string | null;
  booting: boolean;
  setStatus: (s: ServerStatus) => void;
  setRunning: (port: number) => void;
  setVersion: (v: string) => void;
  setError: (e: string) => void;
  reset: () => void;
  /** Full boot: resolve binary → start server → health → models/chat/vpn. */
  boot: () => Promise<void>;
  /**
   * Stop + start the server, optionally re-routing through a proxy.
   * Single choke point for App boot, VPN connect/disconnect and updater.
   */
  restart: (proxyUrl?: string | null) => Promise<void>;
}

// In-flight boot dedupe: concurrent callers share one run.
let bootPromise: Promise<void> | null = null;

function pushAutoApproveConfig() {
  const aa = useSettingsStore.getState().autoApprove;
  void autoApproveApi
    .setConfig({
      enabled: aa.enabled,
      profile: aa.profile,
      delay_ms: aa.delayMs,
      whitelist: aa.whitelist,
      blacklist: aa.blacklist,
      protected_files: aa.protectedFiles,
    })
    .catch(() => {});
}

async function startServer(proxyUrl?: string | null) {
  const settings = useSettingsStore.getState();
  const srv = useServerStore.getState();
  srv.setStatus("starting");

  if (settings.mode === "pty") {
    // PTY fallback: no HTTP server needed; terminal spawns on mount
    srv.setStatus("stopped");
    logInfo("app", "PTY mode — server not required");
    return;
  }

  const binaryPath = await backend.resolveBinary(
    settings.binaryPath || undefined,
  );
  if (binaryPath !== settings.binaryPath) {
    settings.setBinaryPath(binaryPath);
  }

  let workDir = settings.workDir;
  if (!workDir || !workDir.trim()) {
    workDir = await backend.defaultWorkdir();
    settings.setWorkDir(workDir);
  }

  const url =
    proxyUrl === undefined
      ? await import("../lib/vpn").then((m) => m.currentProxyUrl())
      : proxyUrl;
  const info = await backend.serverStart({
    binary_path: binaryPath,
    work_dir: workDir,
    port: settings.port,
    proxy_url: url,
  });

  // The HTTP layer can lag behind serverStart — retry briefly.
  let health: { healthy: boolean; version: string } | null = null;
  for (let i = 0; i < 6 && !health; i++) {
    try {
      health = await opencode.health();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (health?.version) srv.setVersion(health.version);
  srv.setRunning(info.port);
  logInfo(
    "server",
    `running on :${info.port}${health?.version ? ` (v${health.version})` : ""}`,
  );
}

export const useServerStore = create<ServerState>()((set) => ({
  status: "stopped",
  port: null,
  version: null,
  error: null,
  booting: false,
  setStatus: (status) =>
    set((st) => ({
      status,
      error: status === "starting" ? null : st.error,
      booting: status === "starting",
    })),
  setRunning: (port) => set({ status: "running", port, error: null, booting: false }),
  setVersion: (version) => set({ version }),
  setError: (error) => set({ status: "error", error, booting: false }),
  reset: () =>
    set({ status: "stopped", port: null, version: null, error: null, booting: false }),

  boot: () => {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const srv = useServerStore.getState();
      try {
        logInfo("app", "starting server…");
        await startServer();

        // Independent post-start work runs in parallel: model catalog,
        // chat session restore, auto-approve config push.
        pushAutoApproveConfig();
        const [{ useModelsStore }, { useChatStore }] = await Promise.all([
          import("./modelsStore"),
          import("./chatStore"),
        ]);
        const [modelsRes, chatRes] = await Promise.allSettled([
          useModelsStore.getState().refresh(),
          useChatStore.getState().init(),
        ]);
        if (modelsRes.status === "fulfilled") {
          logInfo(
            "models",
            `${useModelsStore.getState().models.length} models loaded`,
          );
        } else {
          logWarn("models", `catalog refresh failed: ${String(modelsRes.reason)}`);
        }
        if (chatRes.status === "rejected") {
          logWarn("chat", `session restore failed: ${String(chatRes.reason)}`);
        }
        // Restore the VPN session from the previous run (if any).
        try {
          const { useVpnStore } = await import("./vpnStore");
          const vpn = useVpnStore.getState();
          await vpn.loadServers();
          if (vpn.activeId && vpn.servers.some((s) => s.id === vpn.activeId)) {
            logInfo("vpn", "restoring previous session…");
            void vpn.connect(vpn.activeId);
          } else {
            void vpn.syncStatus();
          }
        } catch {
          /* vpn optional */
        }
        try {
          const t0 = (window as unknown as { __ncT0?: number }).__ncT0;
          logInfo(
            "app",
            typeof t0 === "number"
              ? `ready in ${Math.round(performance.now() - t0)}ms`
              : "ready",
          );
        } catch {
          logInfo("app", "ready");
        }
      } catch (e) {
        const msg = String(e);
        srv.setError(msg);
        logError("server", msg);
      } finally {
        bootPromise = null;
      }
    })();
    return bootPromise;
  },

  restart: async (proxyUrl?: string | null) => {
    try {
      await backend.serverStop().catch(() => {});
      await startServer(proxyUrl);
    } catch (e) {
      const msg = String(e);
      useServerStore.getState().setError(msg);
      logError("server", msg);
      throw e;
    }
  },
}));
