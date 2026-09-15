import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TerminalSquare, ScrollText, AlertTriangle, X } from "lucide-react";
import { useUiStore, type BottomTab } from "../stores/uiStore";
import { showCtx } from "../lib/ctx";
import { AnimatedHeight } from "../components/AnimatedPanel";
// xterm (~330KB + workers) loads only when the terminal tab first opens.
const TerminalTabs = lazy(() =>
  import("../components/TerminalTabs").then((m) => ({ default: m.TerminalTabs })),
);

function TermSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-3" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded"
          style={{ background: "var(--bg-quaternary)", width: `${92 - i * 13}%` }}
        />
      ))}
    </div>
  );
}
import { OutputPanel } from "../components/OutputPanel";
import { ProblemsPanel, useTotalProblemCounts } from "../components/ProblemsPanel";

export function BottomPanel() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.bottomOpen);
  const setOpen = useUiStore((s) => s.setBottomOpen);
  const tab = useUiStore((s) => s.bottomTab);
  const setTab = useUiStore((s) => s.setBottomTab);

  // drag-resize height — persisted, VS Code-like range
  const getMaxHeight = () =>
    Math.max(200, window.innerHeight - 200); // leave room for title/tabs/statusbar
  const [height, setHeight] = useState(() => {
    try {
      const saved = localStorage.getItem("nexuscode-bottom-height");
      if (saved) {
        const n = parseInt(saved, 10);
        if (Number.isFinite(n)) return Math.max(100, Math.min(800, n));
      }
    } catch {
      /* ignore */
    }
    return 260;
  });
  const draggingRef = useRef(false);
  const maxRef = useRef(800);

  useEffect(() => {
    try {
      localStorage.setItem("nexuscode-bottom-height", String(height));
    } catch {
      /* ignore */
    }
  }, [height]);

  // Clamp saved height when window shrinks so panel never overflows
  useEffect(() => {
    const onResize = () => {
      const max = getMaxHeight();
      maxRef.current = max;
      setHeight((h) => Math.max(100, Math.min(max, h)));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const h = window.innerHeight - e.clientY - 26; // minus statusbar
      setHeight(Math.max(100, Math.min(maxRef.current, h)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  // Double-click handle toggles maximized like VS Code
  const toggleMaximize = () => {
    setHeight((h) => {
      const max = maxRef.current;
      // if already near max, collapse back to default
      return h > max - 40 ? 260 : max;
    });
  };

  // Animate open/close (height+fade) instead of instant mount/unmount —
  // terminal sessions and scroll positions survive inside.
  return (
    <AnimatedHeight open={open} className="min-w-0 w-full max-w-full shrink-0">
    <div
      className="flex min-w-0 w-full max-w-full flex-col overflow-hidden rounded-xl border"
      style={{
        height,
        minHeight: 100,
        maxHeight: "calc(100% - 80px)",
        background: "var(--bg-secondary)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {/* drag handle — 4px per spec, accent glow on hover/drag */}
      <div
        className="group h-[6px] w-full shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-[var(--accent-500)]/40"
        onMouseDown={startDrag}
        onDoubleClick={toggleMaximize}
        title="Drag to resize · double-click to maximize"
      >
        <div className="h-full w-full bg-transparent group-hover:bg-[var(--accent-500)]/60 transition-colors" style={{ height: "2px", marginTop: "2px" }} />
      </div>

      {/* tabs row */}
      <div
        className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1"
        onContextMenu={(e) =>
          showCtx(e, [
            {
              id: "hide",
              label: t("bottom.hide", "Скрыть панель"),
              hint: "Ctrl+J",
              action: () => setOpen(false),
            },
            {
              id: "clear-out",
              label: t("output.clear", "Очистить вывод"),
              action: () =>
                void import("../stores/outputStore").then(({ useOutputStore }) =>
                  useOutputStore.getState().clear(),
                ),
            },
            {
              id: "new-term",
              label: t("terminal.new", "Новый терминал"),
              action: () =>
                void import("../stores/terminalStore").then(({ useTerminalStore }) =>
                  useTerminalStore.getState().openTerminal("shell"),
                ),
            },
            { id: "s1", label: "", sep: true },
            {
              id: "settings",
              label: t("settings.title", "Настройки"),
              hint: "Ctrl+,",
              action: () =>
                window.dispatchEvent(new CustomEvent("ocgui:open-settings")),
            },
          ])
        }
      >
        <BottomTabBtn tab="terminal" current={tab} setTab={setTab} icon={<TerminalSquare size={13} />} label={t("bottom.terminal")} />
        <BottomTabBtn tab="output" current={tab} setTab={setTab} icon={<ScrollText size={13} />} label={t("bottom.output")} />
        <ProblemsTabBtn current={tab} setTab={setTab} />
        <span className="flex-1" />
        <button
          className="rounded p-1 transition-all hover:bg-[var(--hover)] active:scale-90"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </button>
      </div>

      <div className="mx-2 mb-2 min-h-0 min-w-0 flex-1 w-auto max-w-full overflow-hidden rounded-xl">
        {/* All tabs stay mounted so terminal sessions (and scroll) survive
            tab switches; inactive ones are just hidden. */}
        <div className="flex h-full min-h-0 w-full flex-col" style={{ display: tab === "terminal" ? undefined : "none" }} aria-hidden={tab !== "terminal"}>
          <Suspense fallback={<TermSkeleton />}>
            <TerminalTabs />
          </Suspense>
        </div>
        <div className="flex h-full min-h-0 w-full flex-col" style={{ display: tab === "output" ? undefined : "none" }} aria-hidden={tab !== "output"}>
          <OutputPanel />
        </div>
        <div className="flex h-full min-h-0 w-full flex-col" style={{ display: tab === "problems" ? undefined : "none" }} aria-hidden={tab !== "problems"}>
          <ProblemsPanel />
        </div>
      </div>
    </div>
    </AnimatedHeight>
  );
}

function ProblemsTabBtn({ current, setTab }: { current: BottomTab; setTab: (t: BottomTab) => void }) {
  const { t } = useTranslation();
  const { total, errors } = useTotalProblemCounts();
  const active = current === "problems";
  return (
    <button
      onClick={() => setTab("problems")}
      className="pressable flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium transition-colors"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--active)" : "transparent",
      }}
    >
      <AlertTriangle size={13} />
      {t("bottom.problems")}
      {total > 0 && (
        <span
          className="rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
          style={{
            background: errors > 0 ? "var(--error)" : "var(--warning)",
            color: "#fff",
          }}
        >
          {total}
        </span>
      )}
    </button>
  );
}

function BottomTabBtn({
  tab,
  current,
  setTab,
  icon,
  label,
}: {
  tab: BottomTab;
  current: BottomTab;
  setTab: (t: BottomTab) => void;
  icon: React.ReactNode;
  label: string;
}) {
  const active = tab === current;
  return (
    <button
      onClick={() => setTab(tab)}
      className="pressable flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium transition-colors"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--active)" : "transparent",
      }}
    >
      {icon}
      {label}
    </button>
  );
}
