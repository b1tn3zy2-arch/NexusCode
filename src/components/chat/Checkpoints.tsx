import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Camera, RotateCcw } from "lucide-react";
import { checkpointsApi, type Checkpoint } from "../../lib/checkpoints";
import { useSettingsStore } from "../../stores/settingsStore";
import { toast } from "../../stores/toastStore";
import { logInfo, logWarn } from "../../stores/outputStore";

/** Snapshot button + rollback list in the chat header. */
export function Checkpoints() {
  const { t } = useTranslation();
  const workDir = useSettingsStore((s) => s.workDir);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Checkpoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workDir) {
      setList([]);
      return;
    }
    setList(await checkpointsApi.list(workDir));
  }, [workDir]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!confirmId) return;
    const id = window.setTimeout(() => setConfirmId(null), 4000);
    return () => window.clearTimeout(id);
  }, [confirmId]);

  const snapshot = async () => {
    if (!workDir || busy) return;
    setBusy(true);
    try {
      const cp = await checkpointsApi.create(workDir, `ручной ${new Date().toLocaleTimeString()}`);
      logInfo("checkpoint", `snapshot: ${cp.id} (${cp.label})`);
      toast.success(t("checkpoint.created", "Снапшот создан"));
      await refresh();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("no local changes")) {
        toast.info(t("checkpoint.clean", "Изменений нет — снапшот не нужен"));
      } else {
        logWarn("checkpoint", msg);
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const restore = async (cp: Checkpoint) => {
    if (confirmId !== cp.id) {
      setConfirmId(cp.id);
      return;
    }
    setConfirmId(null);
    setOpen(false);
    try {
      await checkpointsApi.restore(workDir, cp.id);
      logInfo("checkpoint", `rollback to ${cp.id}`);
      toast.success(t("checkpoint.restored", "Откачено к снапшоту"));
    } catch (e) {
      logWarn("checkpoint", String(e));
      toast.error(String(e));
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        className="rounded-md p-1.5 hover:bg-[var(--hover)]"
        title={t("checkpoint.title", "Снапшоты / откат")}
        onClick={() => setOpen((v) => !v)}
      >
        <History size={14} style={{ color: "var(--text-secondary)" }} />
        {list.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold leading-[14px] text-white">
            {list.length}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="anim-pop-in absolute right-0 top-full z-50 mt-1 w-[280px] rounded-xl border p-2 shadow-2xl"
            style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
          >
            <button
              className="btn-secondary flex w-full items-center justify-center gap-1.5 py-1.5 text-[13px]"
              disabled={busy || !workDir}
              onClick={() => void snapshot()}
            >
              <Camera size={14} />
              {t("checkpoint.snapshot", "Снапшот сейчас")}
            </button>
            <div className="mt-1.5 max-h-[220px] space-y-1 overflow-y-auto">
              {list.length === 0 && (
                <p className="px-2 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                  {t("checkpoint.empty", "Снапшотов пока нет")}
                </p>
              )}
              {list.map((cp) => (
                <div
                  key={cp.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--hover)]"
                  title={cp.message}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void import("../../lib/ctx").then(({ showCtx }) =>
                      showCtx(e, [
                        {
                          id: "restore",
                          label: t("checkpoint.restore", "Откатить к этому"),
                          action: () => void restore(cp),
                        },
                      ]),
                    );
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{cp.label || cp.id}</span>
                  <button
                    className={`shrink-0 rounded px-2 py-0.5 text-[12px] transition-colors ${
                      confirmId === cp.id
                        ? "bg-red-500/20 font-semibold text-red-400"
                        : "opacity-60 hover:bg-[var(--hover)] hover:opacity-100"
                    }`}
                    title={t("checkpoint.restore", "Откатить к этому")}
                    onClick={() => void restore(cp)}
                  >
                    {confirmId === cp.id ? (
                      <span className="flex items-center gap-1">
                        <RotateCcw size={12} /> Точно?
                      </span>
                    ) : (
                      <RotateCcw size={13} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
