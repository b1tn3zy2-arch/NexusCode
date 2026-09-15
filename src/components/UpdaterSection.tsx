import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  Download,
  Check,
  RefreshCw,
  AlertTriangle,
  Package,
  Loader2,
} from "lucide-react";
import { backend, opencode } from "../services/backend";
import { useServerStore } from "../stores/serverStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useModelsStore } from "../stores/modelsStore";

interface SidecarRelease {
  version: string;
  download_url: string;
  checksum_url: string | null;
  size: number;
  prerelease: boolean;
}

interface SidecarUpdateStatus {
  state: string;
  current_version: string | null;
  latest_version: string | null;
  progress: number;
  error: string | null;
}

function fmtSize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

const PHASE_LABEL: Record<string, string> = {
  checking: "Проверка...",
  downloading: "Скачивание...",
  verifying: "Проверка checksum...",
  installing: "Установка...",
};

interface InstallReceipt {
  version: string;
  path: string;
  at: number;
}

const RECEIPT_KEY = "nexuscode-sidecar-receipt";

function loadReceipt(): InstallReceipt | null {
  try {
    const raw = localStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as InstallReceipt;
    return r && typeof r.version === "string" ? r : null;
  } catch {
    return null;
  }
}

export function UpdaterSection() {
  const { t } = useTranslation();
  const [sidecarVersion, setSidecarVersion] = useState<string | null>(null);
  const [binaryPath, setBinaryPath] = useState<string | null>(null);
  const [release, setRelease] = useState<SidecarRelease | null>(null);
  const [status, setStatus] = useState<SidecarUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<InstallReceipt | null>(() => loadReceipt());
  const busyRef = useRef(false);
  busyRef.current = busy;

  const refreshStatus = useCallback(async () => {
    try {
      const st = await invoke<SidecarUpdateStatus>("sidecar_update_status");
      setStatus(st);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshVersion = useCallback(async () => {
    try {
      const path = await backend.resolveBinary(undefined);
      setBinaryPath(path);
      const v = await invoke<string>("sidecar_current_version", {
        sidecarPath: path,
      });
      setSidecarVersion(v || null);
    } catch {
      setSidecarVersion(null);
    }
  }, []);

  useEffect(() => {
    void refreshVersion();
    void refreshStatus();
    // Auto-check on open (settings toggle).
    try {
      if (useSettingsStore.getState().autoCheckUpdates) {
        void check();
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live progress while check/install runs (backend pushes state).
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void refreshStatus(), 500);
    return () => clearInterval(id);
  }, [busy, refreshStatus]);

  const check = async () => {
    setBusy(true);
    setError(null);
    setRelease(null);
    setUpToDate(false);
    try {
      let prerelease = false;
      try {
        prerelease = useSettingsStore.getState().updateChannel === "prerelease";
      } catch {
        /* default */
      }
      const r = await invoke<SidecarRelease | null>("sidecar_check", {
        includePrerelease: prerelease,
        // Backend compares against the version read from the actual file,
        // otherwise every check reports "update available".
        currentVersion: sidecarVersion,
      });
      if (r) {
        setRelease(r);
      } else {
        setUpToDate(true);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void refreshStatus();
    }
  };

  const install = async () => {
    if (!release) return;
    setBusy(true);
    setError(null);
    setUpToDate(false);
    const server = useServerStore.getState();
    const wasRunning = server.status === "running";
    try {
      // Windows locks the running binary — stop the server first.
      if (wasRunning) {
        await backend.serverStop();
        server.setStatus("stopped");
      }
      await invoke("sidecar_install", { release });
      setRelease(null);
      await refreshVersion();
      // Install receipt survives restarts — if the file version ever
      // disagrees with it, the binary was swapped externally.
      try {
        const path = await backend.resolveBinary(undefined);
        const rec: InstallReceipt = {
          version: release.version,
          path,
          at: Date.now(),
        };
        localStorage.setItem(RECEIPT_KEY, JSON.stringify(rec));
        setReceipt(rec);
      } catch {
        /* receipt is best-effort */
      }
      // New binary may ship a new model catalog — refresh it.
      try {
        await useModelsStore.getState().refresh();
      } catch {
        /* catalog keeps previous data */
      }
      // Restart the server on the fresh binary (keeps VPN proxy env).
      if (wasRunning) {
        const settings = useSettingsStore.getState();
        try {
          server.setStatus("starting");
          const { currentProxyUrl } = await import("../lib/vpn");
          const info = await backend.serverStart({
            binary_path: await backend.resolveBinary(
              settings.binaryPath || undefined,
            ),
            work_dir: settings.workDir,
            port: settings.port,
            proxy_url: await currentProxyUrl(),
          });
          try {
            const health = await opencode.health();
            if (health?.version) server.setVersion(health.version);
          } catch {
            /* version optional */
          }
          server.setRunning(info.port);
        } catch (e) {
          server.setError(String(e));
          throw new Error(`Обновлено, но сервер не перезапустился: ${e}`);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void refreshStatus();
    }
  };

  const phase = status ? (PHASE_LABEL[status.state] ?? null) : null;
  const showProgress = busy && phase !== null;

  const stateIcon =
    busy || status?.state === "downloading" || status?.state === "installing" || status?.state === "verifying" ? (
      <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
    ) : status?.state === "completed" ? (
      <Check className="h-4 w-4 text-green-500" />
    ) : status?.state === "error" ? (
      <AlertTriangle className="h-4 w-4 text-red-500" />
    ) : (
      <Package className="h-4 w-4" style={{ color: "var(--text-secondary)" }} />
    );

  return (
    <fieldset
      className="section-card !mb-0"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void import("../lib/ctx").then(({ showCtx }) =>
          showCtx(e, [
            {
              id: "check",
              label: t("updater.check", "Проверить обновления"),
              action: () => void check(),
            },
            {
              id: "copy-version",
              label: t("updater.copyVersion", "Копировать версию"),
              action: () =>
                void import("../lib/clipboard").then(({ copyText }) =>
                  copyText(sidecarVersion ?? t("status.unknown", "неизвестно")),
                ),
            },
            ...(binaryPath
              ? [
                  {
                    id: "copy-path",
                    label: t("updater.copyBinaryPath", "Копировать путь бинаря"),
                    action: () =>
                      void import("../lib/clipboard").then(({ copyText }) =>
                        copyText(binaryPath),
                      ),
                  } as const,
                ]
              : []),
          ]),
        );
      }}
    >
      <legend className="section-header px-1 !justify-start">
        <RefreshCw className="h-3.5 w-3.5 shrink-0" />
        OpenCode Sidecar
      </legend>

      <div className="space-y-2.5 pt-2">
        <div className="flex items-center gap-2 text-ui-sm">
          {stateIcon}
          <span className="min-w-0">
            Текущая версия:{" "}
            <span className="font-medium">
              {sidecarVersion ?? t("status.unknown", "неизвестно")}
            </span>
            {status?.state === "completed" && status.latest_version && (
              <span className="ml-2 badge">обновлён до {status.latest_version}</span>
            )}
            {(upToDate || status?.state === "uptodate") &&
              status?.state !== "completed" && (
                <span className="ml-2 badge">последняя версия</span>
              )}
            {binaryPath && (
              <span
                className="mt-0.5 block truncate font-mono text-ui-xs"
                style={{ color: "var(--text-tertiary)" }}
                title={binaryPath}
              >
                {binaryPath}
              </span>
            )}
          </span>
        </div>

        {receipt && sidecarVersion && receipt.version !== sidecarVersion && (
          <p className="flex items-start gap-1.5 text-ui-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Ставилось v{receipt.version}, а на диске v{sidecarVersion} — бинарь подменили снаружи или обновление не применилось
          </p>
        )}
        {receipt && !sidecarVersion && (
          <p className="text-ui-xs" style={{ color: "var(--text-tertiary)" }}>
            Ставилось v{receipt.version} · {new Date(receipt.at).toLocaleString()}
          </p>
        )}

        {release && !busy && (
          <div
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-ui-sm"
            style={{ borderColor: "var(--accent)" }}
          >
            <Download className="h-4 w-4 shrink-0 text-accent-400" />
            <span className="flex-1">
              Доступно: <b>v{release.version}</b> · {fmtSize(release.size)}
              {release.prerelease && <span className="badge ml-1">pre-release</span>}
            </span>
            <button className="btn-primary px-3 py-1 text-[13px]" onClick={() => void install()}>
              Обновить
            </button>
          </div>
        )}

        {showProgress && (
          <div>
            <div className="mb-1 flex justify-between text-ui-xs" style={{ color: "var(--text-secondary)" }}>
              <span>{phase}</span>
              <span>{(status?.progress ?? 0).toFixed(1)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--bg-quaternary)" }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${status?.progress ?? 0}%`,
                  background: "linear-gradient(90deg, var(--accent-600), var(--accent-400))",
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-ui-xs text-red-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        {status?.state === "error" && status.error && !error && (
          <p className="flex items-start gap-1.5 text-ui-xs text-red-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {status.error}
          </p>
        )}

        {!release && !busy && status?.state !== "completed" && (
          <button className="btn-secondary py-1.5 text-[13px]" disabled={busy} onClick={() => void check()}>
            <RefreshCw className="h-4 w-4" /> Проверить обновления
          </button>
        )}
      </div>
    </fieldset>
  );
}
