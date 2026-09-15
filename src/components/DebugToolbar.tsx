import { useTranslation } from "react-i18next";
import {
  Play,
  StepForward,
  ArrowDownToLine,
  ArrowUpFromLine,
  RotateCw,
  Square,
  Bug,
} from "lucide-react";
import { useDebugStore } from "../stores/debugStore";

const NO_ADAPTER = "Требуется debug-адаптер (скоро)";

/** Floating debug toolbar, shown while a run session is live. */
export function DebugToolbar() {
  const { t } = useTranslation();
  const run = useDebugStore((s) => s.run);

  if (!run) return null;

  const stop = () =>
    void import("../lib/debugActions").then((m) => m.debugStop());
  const restart = () =>
    void import("../lib/debugActions").then((m) => m.debugRestart());

  const deadBtn =
    "flex items-center justify-center rounded p-1.5 opacity-35 cursor-not-allowed";
  const liveBtn =
    "flex items-center justify-center rounded p-1.5 hover:bg-white/10 transition-colors";

  return (
    <div className="pointer-events-none absolute inset-x-0 top-9 z-[60] flex justify-center">
      <div
        className="pointer-events-auto flex items-center gap-0.5 rounded-lg border px-1.5 py-1 shadow-2xl"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "var(--border-default)",
        }}
        title={run.label}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void import("../lib/ctx").then(({ showCtx }) =>
            showCtx(e, [
              {
                id: "restart",
                label: `${t("debug.restart", "Restart")} (Ctrl+Shift+F5)`,
                action: restart,
              },
              {
                id: "stop",
                label: `${t("debug.stop", "Stop")} (Shift+F5)`,
                action: stop,
              },
              { id: "sep1", label: "", sep: true },
              {
                id: "copy-label",
                label: t("debug.copyLabel", "Копировать название"),
                action: () =>
                  void import("../lib/clipboard").then(({ copyText }) =>
                    copyText(run.label),
                  ),
              },
            ]),
          );
        }}
      >
        <span className="flex items-center gap-1.5 px-2 text-[12px]" style={{ color: "var(--text-secondary)" }}>
          <Bug className="h-3.5 w-3.5 text-green-500" />
          <span className="max-w-[220px] truncate">{run.label}</span>
        </span>
        <span className="mx-1 h-4 w-px" style={{ background: "var(--border-subtle)" }} />
        <button disabled className={deadBtn} title={`${t("debug.continue", "Continue")} — ${NO_ADAPTER}`}>
          <Play className="h-4 w-4" />
        </button>
        <button disabled className={deadBtn} title={`${t("debug.stepOver", "Step Over")} (F10) — ${NO_ADAPTER}`}>
          <StepForward className="h-4 w-4" />
        </button>
        <button disabled className={deadBtn} title={`${t("debug.stepInto", "Step Into")} (F11) — ${NO_ADAPTER}`}>
          <ArrowDownToLine className="h-4 w-4" />
        </button>
        <button disabled className={deadBtn} title={`${t("debug.stepOut", "Step Out")} — ${NO_ADAPTER}`}>
          <ArrowUpFromLine className="h-4 w-4" />
        </button>
        <button
          className={liveBtn}
          title={`${t("debug.restart", "Restart")} (Ctrl+Shift+F5)`}
          onClick={restart}
        >
          <RotateCw className="h-4 w-4 text-green-500" />
        </button>
        <button
          className={liveBtn}
          title={`${t("debug.stop", "Stop")} (Shift+F5)`}
          onClick={stop}
        >
          <Square className="h-4 w-4 text-red-500" />
        </button>
      </div>
    </div>
  );
}
