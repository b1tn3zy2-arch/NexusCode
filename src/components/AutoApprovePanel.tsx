import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Shield,
  CheckCircle2,
  Ban,
  Trash2,
  RefreshCw,
  Settings,
  Inbox,
} from "lucide-react";
import { autoApproveApi } from "../services/backend";
import {
  usePermissionStore,
} from "../stores/permissionStore";
import {
  useSettingsStore,
  type AaProfile,
} from "../stores/settingsStore";

const PROFILE_LABEL: Record<AaProfile, string> = {
  paranoid: "Paranoid",
  developer: "Developer",
  autopilot: "Autopilot",
};

export function AutoApprovePanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const autoApprove = useSettingsStore((s) => s.autoApprove);
  const setAutoApprove = useSettingsStore((s) => s.setAutoApprove);
  const entries = usePermissionStore((s) => s.entries);
  const refreshLog = usePermissionStore((s) => s.refreshLog);
  const clearLog = usePermissionStore((s) => s.clearLog);

  useEffect(() => {
    void refreshLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async () => {
    const next = { ...autoApprove, enabled: !autoApprove.enabled };
    setAutoApprove(next);
    try {
      await autoApproveApi.setConfig({
        enabled: next.enabled,
        profile: next.profile,
        delay_ms: next.delayMs,
        whitelist: next.whitelist,
        blacklist: next.blacklist,
        protected_files: next.protectedFiles,
      });
    } catch {
      // config push retried on next boot
    }
  };

  const setProfile = async (p: AaProfile) => {
    const next = { ...autoApprove, profile: p };
    setAutoApprove(next);
    try {
      await autoApproveApi.setConfig({
        enabled: next.enabled,
        profile: next.profile,
        delay_ms: next.delayMs,
        whitelist: next.whitelist,
        blacklist: next.blacklist,
        protected_files: next.protectedFiles,
      });
    } catch {
      /* retried later */
    }
  };

  return (
    <section className="section-card min-w-0 w-full max-w-full overflow-hidden">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <h3 className="section-header min-w-0 flex-1 !justify-start">
          <Shield className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("aa.title")}</span>
        </h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={autoApprove.enabled}
            onChange={() => void toggle()}
            title={autoApprove.enabled ? t("aa.on") : t("aa.off")}
          />
          <span className="toggle-slider">
            <span className="toggle-knob" />
          </span>
        </label>
      </div>

      <div className="segmented mb-3 flex min-w-0 w-full max-w-full">
        {(Object.keys(PROFILE_LABEL) as AaProfile[]).map((p) => (
          <button
            key={p}
            className={`min-w-0 flex-1 truncate px-1 text-xs ${autoApprove.profile === p ? "active" : ""}`}
            onClick={() => void setProfile(p)}
          >
            {PROFILE_LABEL[p]}
          </button>
        ))}
      </div>

      <div className="max-h-44 space-y-1.5 overflow-y-auto">
        {entries.length === 0 && (
          <div
            className="flex flex-col items-center gap-1.5 py-4 text-ui-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            <Inbox className="h-5 w-5 opacity-50" />
            {t("aa.empty")}
          </div>
        )}
        {entries.slice(0, 8).map((e) => (
          <div
            key={e.id}
            className="flex items-center gap-2 text-ui-sm"
            title={`${e.tool ?? ""} ${e.reason ?? ""}`}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              void import("../lib/ctx").then(({ showCtx }) =>
                showCtx(ev, [
                  {
                    id: "copy",
                    label: t("aa.copyEntry", "Копировать запись"),
                    action: () =>
                      void import("../lib/clipboard").then(({ copyText }) =>
                        copyText(
                          `[${new Date(e.ts).toLocaleString()}] ${e.decision} ${e.tool ?? "?"}${e.reason ? ` — ${e.reason}` : ""}`,
                        ),
                      ),
                  },
                ]),
              );
            }}
          >
            {e.decision === "approved" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            ) : (
              <Ban className="h-4 w-4 shrink-0 text-red-400" />
            )}
            <span style={{ color: "var(--text-secondary)" }}>
              {new Date(e.ts).toLocaleTimeString()}
            </span>
            <span className="truncate font-medium">{e.tool ?? "?"}</span>
            {!e.auto && <span className="badge ml-auto">manual</span>}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between border-t pt-2.5" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex gap-1">
          <button
            className="icon-btn"
            onClick={() => void refreshLog()}
            title={t("aa.refresh", "Обновить")}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            className="icon-btn"
            onClick={() => void clearLog()}
            title={t("aa.clear", "Очистить")}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <button className="icon-btn" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          {t("aa.configure")}
        </button>
      </div>
    </section>
  );
}
