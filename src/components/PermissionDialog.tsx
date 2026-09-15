import { useTranslation } from "react-i18next";
import {
  X,
  RefreshCw,
  Check,
  ShieldAlert,
} from "lucide-react";
import { autoApproveApi } from "../services/backend";
import { usePermissionStore } from "../stores/permissionStore";

function prettyMeta(meta: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(meta, null, 2);
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  } catch {
    return String(meta);
  }
}

export function PermissionDialog() {
  const { t } = useTranslation();
  const pending = usePermissionStore((s) => s.pending);
  const removePending = usePermissionStore((s) => s.removePending);
  const refreshLog = usePermissionStore((s) => s.refreshLog);

  if (pending.length === 0) return null;
  const req = pending[0];

  const answer = async (response: "once" | "always" | "reject") => {
    removePending(req.id);
    try {
      await autoApproveApi.respond(req.sessionID, req.id, response);
    } finally {
      void refreshLog();
    }
  };

  return (
    <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
      <div
        className="w-[560px] max-w-full rounded-xl border shadow-2xl"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "#eab308",
        }}
      >
        <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--border-color)" }}>
          <ShieldAlert className="h-4 w-4 text-yellow-500" />
          <h3 className="flex-1 text-sm font-semibold">{t("perm.title")}</h3>
          <span
            className="rounded px-1.5 py-0.5 text-[11px] font-medium uppercase"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
          >
            {req.kind}
          </span>
        </div>

        <div className="px-4 py-3">
          <p className="text-sm break-words">{req.title || req.id}</p>
          {Object.keys(req.metadata ?? {}).length > 0 && (
            <pre
              className="mt-2 max-h-40 overflow-auto rounded-md p-2 text-[12px] leading-snug"
              style={{ background: "var(--bg-tertiary)" }}
            >
              {prettyMeta(req.metadata)}
            </pre>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-2.5" style={{ borderColor: "var(--border-color)" }}>
          <button
            className="rounded-md border border-red-500/50 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10"
            onClick={() => void answer("reject")}
          >
            <X className="h-3.5 w-3.5" /> {t("perm.deny")}
          </button>
          <button
            className="btn-secondary"
            onClick={() => void answer("always")}
          >
            <RefreshCw className="h-3.5 w-3.5" /> {t("perm.alwaysAllow")}
          </button>
          <button
            className="btn-primary"
            onClick={() => void answer("once")}
          >
            <Check className="h-3.5 w-3.5" /> {t("perm.allowOnce")}
          </button>
        </div>
      </div>
    </div>
  );
}
