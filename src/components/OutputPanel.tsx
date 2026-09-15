import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Copy, Check, ArrowDownToLine } from "lucide-react";
import { useOutputStore, type LogLevel } from "../stores/outputStore";

type Filter = "all" | LogLevel;

const FILTERS: Filter[] = ["all", "info", "warn", "error"];

function levelColor(level: LogLevel): string {
  switch (level) {
    case "error":
      return "var(--error)";
    case "warn":
      return "var(--warning)";
    default:
      return "var(--text-tertiary)";
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function OutputPanel() {
  const { t } = useTranslation();
  const entries = useOutputStore((s) => s.entries);
  const clear = useOutputStore((s) => s.clear);
  const [filter, setFilter] = useState<Filter>("all");
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.level === filter)),
    [entries, filter],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible.length, pinned]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPinned(atBottom);
  };

  const copyAll = async () => {
    const text = visible
      .map((e) => `[${formatTime(e.ts)}] [${e.level}] [${e.source}] ${e.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const onMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void import("../stores/contextMenuStore").then(({ useContextMenuStore }) => {
      useContextMenuStore.getState().show(e.clientX, e.clientY, [
        { id: "copy-all", label: t("ctx.copyAll"), action: () => void copyAll() },
        { id: "clear", label: t("ctx.clearOutput"), action: () => clear() },
      ]);
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" onContextMenu={onMenu}>
      <div className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex min-w-0 items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors"
              style={{
                color: filter === f ? "var(--text-primary)" : "var(--text-secondary)",
                background: filter === f ? "var(--active)" : "transparent",
              }}
            >
              {t(`bottom.filter.${f}`, f)}
            </button>
          ))}
        </div>
        <span className="min-w-2 flex-1" />
        <span className="hidden shrink-0 text-[11px] tabular-nums md:inline" style={{ color: "var(--text-tertiary)" }}>
          {visible.length}
        </span>
        <button
          onClick={() => setPinned((v) => !v)}
          title={t("bottom.autoscroll", "Autoscroll")}
          className="shrink-0 rounded p-1 hover:bg-[var(--hover)]"
          style={{ color: pinned ? "var(--accent-400)" : "var(--text-secondary)" }}
        >
          <ArrowDownToLine size={14} />
        </button>
        <button
          onClick={() => void copyAll()}
          title={t("bottom.copy", "Copy")}
          className="shrink-0 rounded p-1 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          onClick={clear}
          title={t("bottom.clear", "Clear")}
          className="shrink-0 rounded p-1 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-2 font-mono text-[12px] leading-relaxed">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: "var(--text-tertiary)" }}>
            <p className="max-w-full break-words text-[12px]">{t("bottom.outputEmpty", "No output yet — run the agent or server to see logs.")}</p>
          </div>
        ) : (
          visible.map((e) => (
            <div key={e.id} className="flex min-w-0 items-start gap-2 rounded-md px-1 py-px hover:bg-[var(--hover)]">
              <span className="shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                {formatTime(e.ts)}
              </span>
              <span className="w-10 shrink-0 font-semibold uppercase" style={{ color: levelColor(e.level), fontSize: 10 }}>
                {e.level}
              </span>
              <span className="shrink-0 truncate" style={{ color: "var(--accent-400)", maxWidth: 140 }} title={e.source}>
                {e.source}
              </span>
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
                {e.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
