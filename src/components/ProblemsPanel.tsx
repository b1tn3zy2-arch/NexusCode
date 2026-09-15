import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  XCircle,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { useServerStore } from "../stores/serverStore";
import { useChatStore } from "../stores/chatStore";
import { useLoopStore } from "../stores/loopStore";
import { useContStore } from "../stores/contStore";
import { useEditorStore } from "../stores/editorStore";
import { useUiStore } from "../stores/uiStore";
import {
  useDiagnosticsStore,
  useFileDiagnostics,
} from "../stores/diagnosticsStore";
import type { FileDiagnostic } from "../lib/diagnostics";

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  id: string;
  severity: ProblemSeverity;
  source: string;
  message: string;
  file?: string;
}

function severityIcon(sev: ProblemSeverity, size = 14) {
  switch (sev) {
    case "error":
      return <XCircle size={size} className="shrink-0" style={{ color: "var(--error)" }} />;
    case "warning":
      return <AlertTriangle size={size} className="shrink-0" style={{ color: "var(--warning)" }} />;
    default:
      return <Info size={size} className="shrink-0" style={{ color: "var(--info)" }} />;
  }
}

export function useProblems(): Problem[] {
  const serverError = useServerStore((s) => s.error);
  const serverStatus = useServerStore((s) => s.status);
  const chatError = useChatStore((s) => s.errorBanner);
  const loopError = useLoopStore((s) => s.snapshot.lastError);
  const loopStop = useLoopStore((s) => s.snapshot.stopReason);
  const contError = useContStore((s) => s.snapshot.lastError);
  const contStop = useContStore((s) => s.snapshot.stopReason);
  const gitStatus = useEditorStore((s) => s.gitStatus);
  const gitError = useEditorStore((s) => s.gitError);
  const repoRoot = useEditorStore((s) => s.repoRoot);
  const root = useEditorStore((s) => s.root);

  return useMemo(() => {
    const out: Problem[] = [];

    if (serverStatus === "error" && serverError) {
      out.push({ id: "server", severity: "error", source: "server", message: serverError });
    }
    if (chatError?.message) {
      out.push({ id: "chat", severity: "error", source: "chat", message: chatError.message });
    }
    if (loopError) {
      out.push({ id: "loop", severity: "error", source: "loop", message: loopError });
    } else if (loopStop === "test_failure" || loopStop === "error") {
      out.push({ id: "loop-stop", severity: "warning", source: "loop", message: `Loop stopped: ${loopStop}` });
    }
    if (contError) {
      out.push({ id: "cont", severity: "error", source: "continuous", message: contError });
    } else if (contStop === "validation_failed" || contStop === "error") {
      out.push({ id: "cont-stop", severity: "warning", source: "continuous", message: `Continuous stopped: ${contStop}` });
    }
    if (gitError) {
      out.push({ id: "git-err", severity: "warning", source: "git", message: gitError });
    }
    if (repoRoot) {
      for (const [rel, code] of Object.entries(gitStatus)) {
        if (code === "conflicted") {
          out.push({
            id: `git-${rel}`,
            severity: "error",
            source: "git",
            message: "Merge conflict — resolve before commit",
            file: rel,
          });
        }
      }
    }
    if (!root) {
      out.push({
        id: "no-folder",
        severity: "info",
        source: "workspace",
        message: "No folder opened",
      });
    }
    return out;
  }, [serverError, serverStatus, chatError, loopError, loopStop, contError, contStop, gitStatus, gitError, repoRoot, root]);
}

/** Combined app + file counts for the tab badge. */
export function useTotalProblemCounts() {
  const app = useProblems();
  const byFile = useDiagnosticsStore((s) => s.byFile);
  let errors = 0;
  let warnings = 0;
  for (const p of app) {
    if (p.severity === "error") errors++;
    else if (p.severity === "warning") warnings++;
  }
  for (const diags of Object.values(byFile)) {
    for (const d of diags) {
      if (d.severity === "error") errors++;
      else if (d.severity === "warning") warnings++;
    }
  }
  return { total: errors + warnings, errors, warnings };
}

function fileLabel(abs: string): { name: string; dir: string } {
  const name = abs.split(/[\\/]/).pop() ?? abs;
  const dir = abs.slice(0, Math.max(0, abs.length - name.length)).replace(/[\\/]+$/, "");
  return { name, dir };
}

function gotoFileLine(absPath: string, line: number, col = 1) {
  const fire = () =>
    window.dispatchEvent(new CustomEvent("editor:goto-line", { detail: { line, col } }));
  void useEditorStore
    .getState()
    .openFile(absPath, { preview: false })
    .then(() => {
      // the model loads async — retry a couple of times (idempotent)
      fire();
      setTimeout(fire, 250);
      setTimeout(fire, 900);
    })
    .catch(() => {});
}

export function ProblemsPanel() {
  const { t } = useTranslation();
  const appProblems = useProblems();
  const fileDiags = useFileDiagnostics();
  const scanning = useDiagnosticsStore((s) => s.scanning);
  const refreshOpenTabs = useDiagnosticsStore((s) => s.refreshOpenTabs);
  const bottomTab = useUiStore((s) => s.bottomTab);
  const tabs = useEditorStore((s) => s.tabs);
  const activePath = useEditorStore((s) => s.activePath);

  const [query, setQuery] = useState("");
  const [showError, setShowError] = useState(true);
  const [showWarn, setShowWarn] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const tabsKey = tabs.map((tab) => `${tab.path}:${tab.dirty ? 1 : 0}`).join("|");

  // Re-scan open files when the tab opens, files change, or saves happen.
  useEffect(() => {
    if (bottomTab !== "problems") return;
    const id = setTimeout(() => {
      void refreshOpenTabs();
    }, 400);
    return () => clearTimeout(id);
  }, [bottomTab, tabsKey, activePath, refreshOpenTabs]);

  const visibleSev = (sev: ProblemSeverity) =>
    (sev === "error" && showError) || (sev === "warning" && showWarn) || (sev === "info" && showInfo);

  const q = query.trim().toLowerCase();
  const matchQuery = (text: string) => (q ? text.toLowerCase().includes(q) : true);

  const groups = useMemo(() => {
    const byPath = new Map<string, FileDiagnostic[]>();
    for (const d of fileDiags) {
      if (!visibleSev(d.severity)) continue;
      if (!matchQuery(`${d.message} ${d.file}`)) continue;
      const list = byPath.get(d.file) ?? [];
      list.push(d);
      byPath.set(d.file, list);
    }
    return [...byPath.entries()].map(([file, diags]) => ({
      file,
      ...fileLabel(file),
      errors: diags.filter((d) => d.severity === "error").length,
      warnings: diags.filter((d) => d.severity === "warning").length,
      diags,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileDiags, query, showError, showWarn, showInfo]);

  const workspace = useMemo(
    () =>
      appProblems.filter(
        (p) => visibleSev(p.severity) && matchQuery(`${p.message} ${p.source} ${p.file ?? ""}`),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appProblems, query, showError, showWarn, showInfo],
  );

  const totalErrors =
    groups.reduce((n, g) => n + g.errors, 0) + workspace.filter((p) => p.severity === "error").length;
  const totalWarnings =
    groups.reduce((n, g) => n + g.warnings, 0) + workspace.filter((p) => p.severity === "warning").length;
  const totalInfos = workspace.filter((p) => p.severity === "info").length +
    fileDiags.filter((d) => d.severity === "info" && visibleSev("info") && matchQuery(`${d.message} ${d.file}`)).length;

  const openWorkspaceFile = (rel: string) => {
    const root = useEditorStore.getState().root;
    const repoRoot = useEditorStore.getState().repoRoot;
    const base = repoRoot ?? root;
    if (!base || !rel) return;
    const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
    gotoFileLine(`${base}${sep}${rel}`, 1, 1);
    useUiStore.getState().setSidebarView("explorer");
  };

  const toggleGroup = (key: string) => setCollapsed((s) => ({ ...s, [key]: !s[key] }));

  const copyAllProblems = () => {
    const lines: string[] = [];
    for (const g of groups) {
      for (const d of g.diags) {
        lines.push(`${g.file}:${d.line}:${d.col}: [${d.severity}] ${d.message}${d.code ? ` [${d.code}]` : ""}`);
      }
    }
    for (const p of workspace) {
      lines.push(`[${p.source}] [${p.severity}] ${p.message}${p.file ? ` (${p.file})` : ""}`);
    }
    if (lines.length === 0) return;
    void import("../lib/clipboard").then(({ copyText }) => copyText(lines.join("\n")));
  };

  const onMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void import("../stores/contextMenuStore").then(({ useContextMenuStore }) => {
      useContextMenuStore.getState().show(e.clientX, e.clientY, [
        { id: "copy-all", label: t("ctx.copyAll"), action: copyAllProblems },
        { id: "refresh", label: t("ctx.refreshProblems"), action: () => void refreshOpenTabs() },
      ]);
    });
  };

  const isEmpty = groups.length === 0 && workspace.length === 0;
  const hasFilter = q.length > 0 || !showError || !showWarn || !showInfo;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" onContextMenu={onMenu}>
      {/* toolbar: filter + severity toggles + refresh */}
      <div className="flex min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1" style={{ borderColor: "var(--border-subtle)" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("bottom.problemsFilter", "Filter problems…")}
          className="input-field min-w-0 flex-1 !py-1 text-[12px]"
        />
        <button
          onClick={() => setShowError((v) => !v)}
          title="Errors"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
          style={{
            color: showError ? "var(--error)" : "var(--text-tertiary)",
            background: showError ? "var(--active)" : "transparent",
            opacity: showError ? 1 : 0.5,
          }}
        >
          <XCircle size={12} /> {totalErrors}
        </button>
        <button
          onClick={() => setShowWarn((v) => !v)}
          title="Warnings"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
          style={{
            color: showWarn ? "var(--warning)" : "var(--text-tertiary)",
            background: showWarn ? "var(--active)" : "transparent",
            opacity: showWarn ? 1 : 0.5,
          }}
        >
          <AlertTriangle size={12} /> {totalWarnings}
        </button>
        <button
          onClick={() => setShowInfo((v) => !v)}
          title="Infos"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
          style={{
            color: showInfo ? "var(--info)" : "var(--text-tertiary)",
            background: showInfo ? "var(--active)" : "transparent",
            opacity: showInfo ? 1 : 0.5,
          }}
        >
          <Info size={12} /> {totalInfos}
        </button>
        <button
          onClick={() => void refreshOpenTabs()}
          title={t("bottom.problemsRefresh", "Refresh diagnostics")}
          className="shrink-0 rounded p-1 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          <RefreshCw size={13} className={scanning ? "animate-spin" : undefined} />
        </button>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {isEmpty ? (
          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-hidden p-6 text-center">
            <CheckCircle2 size={22} style={{ color: "var(--success)" }} />
            <p className="max-w-full break-words text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {hasFilter ? t("bottom.problemsNoMatch", "No problems match the filter.") : t("bottom.problemsEmpty")}
            </p>
          </div>
        ) : (
          <div className="py-1">
            {groups.map((g) => {
              const isCollapsed = !!collapsed[g.file];
              return (
                <div key={g.file} className="min-w-0">
                  <button
                    onClick={() => toggleGroup(g.file)}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-semibold hover:bg-[var(--hover)]"
                    style={{ color: "var(--text-primary)" }}
                    title={g.file}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={13} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
                    ) : (
                      <ChevronDown size={13} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
                    )}
                    <span className="truncate">{g.name}</span>
                    <span className="min-w-0 flex-1 truncate font-normal" style={{ color: "var(--text-tertiary)" }}>
                      {g.dir}
                    </span>
                    <span className="shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                      {g.diags.length}
                    </span>
                  </button>
                  {!isCollapsed &&
                    g.diags.map((d, i) => (
                      <button
                        key={`${d.line}:${d.col}:${i}`}
                        onClick={() => gotoFileLine(d.file, d.line, d.col)}
                        className="group flex w-full min-w-0 items-start gap-2 rounded-md py-[3px] pl-7 pr-2 text-left hover:bg-[var(--hover)]"
                        title={`${g.name}:${d.line}:${d.col}`}
                      >
                        {severityIcon(d.severity, 13)}
                        <span className="min-w-0 flex-1 break-words text-[12px] leading-snug" style={{ color: "var(--text-primary)" }}>
                          {d.message}
                          {d.code && (
                            <span className="ml-1.5 rounded px-1 font-mono text-[10px]" style={{ background: "var(--bg-quaternary)", color: "var(--text-tertiary)" }}>
                              {d.code}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                          {d.line}:{d.col}
                        </span>
                      </button>
                    ))}
                </div>
              );
            })}

            {workspace.length > 0 && (
              <div className="min-w-0">
                <button
                  onClick={() => toggleGroup("__workspace")}
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-semibold hover:bg-[var(--hover)]"
                  style={{ color: "var(--text-primary)" }}
                >
                  {collapsed["__workspace"] ? (
                    <ChevronRight size={13} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
                  ) : (
                    <ChevronDown size={13} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
                  )}
                  <span className="truncate">Workspace</span>
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                    {workspace.length}
                  </span>
                </button>
                {!collapsed["__workspace"] &&
                  workspace.map((p) => (
                    <button
                      key={p.id}
                      onClick={p.file ? () => openWorkspaceFile(p.file!) : undefined}
                      disabled={!p.file}
                      className="group flex w-full min-w-0 items-start gap-2 rounded-md py-[3px] pl-7 pr-2 text-left hover:bg-[var(--hover)] disabled:cursor-default"
                    >
                      {severityIcon(p.severity, 13)}
                      <span className="min-w-0 flex-1 break-words text-[12px] leading-snug" style={{ color: "var(--text-primary)" }}>
                        <span className="mr-1.5 rounded px-1 font-mono text-[10px]" style={{ background: "var(--bg-quaternary)", color: "var(--text-tertiary)" }}>
                          {p.source}
                        </span>
                        {p.message}
                        {p.file && (
                          <span className="mt-0.5 block truncate font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                            {p.file}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
