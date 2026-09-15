import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GitBranch,
  GitCommitHorizontal,
  Plus,
  RotateCcw,
  RefreshCw,
} from "lucide-react";
import { useEditorStore, type GitStatusCode } from "../../stores/editorStore";
import { Select } from "../Select";

function statusMeta(status: GitStatusCode): { letter: string; color: string; label: string } {
  switch (status) {
    case "modified":
      return { letter: "M", color: "#e2b340", label: "Modified" };
    case "added":
      return { letter: "A", color: "#73c991", label: "Added" };
    case "deleted":
      return { letter: "D", color: "#f14c4c", label: "Deleted" };
    case "untracked":
      return { letter: "U", color: "#73c991", label: "Untracked" };
    case "conflicted":
      return { letter: "C", color: "#f14c4c", label: "Conflicted" };
    case "renamed":
      return { letter: "R", color: "#73c991", label: "Renamed" };
    case "copied":
      return { letter: "C", color: "#73c991", label: "Copied" };
    case "ignored":
      return { letter: "I", color: "var(--text-tertiary)", label: "Ignored" };
    default:
      return { letter: "", color: "", label: "" };
  }
}

export function GitPanel() {
  const { t } = useTranslation();
  const repoRoot = useEditorStore((s) => s.repoRoot);
  const gitStatus = useEditorStore((s) => s.gitStatus);
  const branches = useEditorStore((s) => s.gitBranches);
  const log = useEditorStore((s) => s.gitLog);
  const hunks = useEditorStore((s) => s.gitHunks);
  const loadGit = useEditorStore((s) => s.loadGit);
  const loadGitHunks = useEditorStore((s) => s.loadGitHunks);
  const gitStage = useEditorStore((s) => s.gitStage);
  const gitUnstage = useEditorStore((s) => s.gitUnstage);
  const gitDiscard = useEditorStore((s) => s.gitDiscard);
  const gitCommit = useEditorStore((s) => s.gitCommit);
  const gitCheckout = useEditorStore((s) => s.gitCheckout);

  const [commitMsg, setCommitMsg] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const currentBranch = branches.find((b) => b.current)?.name ?? null;

  useEffect(() => {
    if (repoRoot) {
      void loadGit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  const changes = useMemo(
    () => Object.entries(gitStatus).filter(([, s]) => s !== "ignored"),
    [gitStatus],
  );

  if (!repoRoot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <GitBranch size={22} style={{ color: "var(--accent-400)" }} />
        <p className="text-sm font-medium">{t("git.notRepo", "Не git-репозиторий")}</p>
        <p className="max-w-[220px] text-xs" style={{ color: "var(--text-secondary)" }}>
          {t("git.notRepoHint", "Откройте папку, которая является git-репозиторием.")}
        </p>
      </div>
    );
  }

  const onCommit = async () => {
    const msg = commitMsg.trim();
    if (!msg || changes.length === 0) return;
    setCommitting(true);
    try {
      await gitCommit(msg, changes.map(([p]) => p));
      setCommitMsg("");
    } finally {
      setCommitting(false);
    }
  };

  const toggleExpand = (rel: string) => {
    if (expanded === rel) {
      setExpanded(null);
      return;
    }
    setExpanded(rel);
    void loadGitHunks(rel);
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="section-header !justify-start flex-1">
          <GitCommitHorizontal className="h-4 w-4 shrink-0" />
          {t("nav.git")}
        </span>
        <button
          className="icon-btn !p-1"
          title={t("aa.refresh", "Обновить")}
          onClick={() => void loadGit()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Branch switcher */}
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
          <GitBranch size={14} className="shrink-0" style={{ color: "var(--accent-400)" }} />
          <Select
            className="min-w-0 flex-1"
            value={currentBranch ?? ""}
            onChange={(b) => void gitCheckout(b)}
            options={branches.map((b) => ({ value: b.name, label: b.name }))}
          />
        </div>

        {/* Commit box */}
        <div className="space-y-2 border-b px-3 py-3" style={{ borderColor: "var(--border-subtle)" }}>
          <textarea
            className="input-field w-full resize-none text-[13px]"
            rows={3}
            placeholder={t("git.commitPlaceholder", "Сообщение коммита…")}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onContextMenu={(e) =>
              void import("../../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))
            }
          />
          <button
            className="btn-primary w-full px-3 py-1.5 text-[13px]"
            disabled={!commitMsg.trim() || changes.length === 0 || committing}
            onClick={() => void onCommit()}
          >
            {t("git.commit", "Закоммитить")} ({changes.length})
          </button>
        </div>

        {/* Changes */}
        <div className="py-1">
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
            {t("git.changes", "Изменения")} ({changes.length})
          </div>
          {changes.length === 0 && (
            <div className="px-3 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
              {t("git.clean", "Нет изменений")}
            </div>
          )}
          {changes.map(([rel, status]) => {
            const meta = statusMeta(status);
            const fileHunks = hunks[rel] ?? [];
            return (
              <div key={rel}>
                <div
                  className="group flex cursor-pointer items-center gap-2 px-3 py-1 text-[13px] hover:bg-[var(--hover)]"
                  onClick={() => toggleExpand(rel)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const abs = `${repoRoot.replace(/[\\/]+$/, "")}/${rel}`;
                    void import("../../stores/contextMenuStore").then(({ useContextMenuStore }) => {
                      useContextMenuStore.getState().show(e.clientX, e.clientY, [
                        {
                          id: "open",
                          label: t("git.openFile", "Открыть файл"),
                          action: () => void useEditorStore.getState().openFile(abs, { preview: true }),
                        },
                        {
                          id: "stage",
                          label: t("git.stage", "Добавить в индекс (stage)"),
                          action: () => void gitStage([rel]),
                        },
                        {
                          id: "unstage",
                          label: t("git.unstage", "Убрать из индекса"),
                          action: () => void gitUnstage([rel]),
                        },
                        {
                          id: "copy",
                          label: t("menu.copyPath", "Копировать путь"),
                          action: () =>
                            void import("../../lib/clipboard").then(({ copyText }) => copyText(abs)),
                        },
                        {
                          id: "reveal",
                          label: t("menu.reveal", "Показать в проводнике"),
                          action: () =>
                            void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) =>
                              revealItemInDir(abs).catch(() => {}),
                            ),
                        },
                        {
                          id: "discard",
                          label: t("git.discard", "Отменить изменения"),
                          danger: true,
                          action: () => void gitDiscard([rel]),
                        },
                      ]);
                    });
                  }}
                >
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
                    style={{ color: meta.color, border: `1px solid ${meta.color}` }}
                    title={meta.label}
                  >
                    {meta.letter}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={rel}>
                    {rel.split("/").pop()}
                    <span className="ml-1 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                      {rel}
                    </span>
                  </span>
                  <button
                    className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--bg-tertiary)] group-hover:opacity-100"
                    title={t("git.stage", "Добавить в индекс (stage)")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void gitStage([rel]);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--bg-tertiary)] group-hover:opacity-100"
                    title={t("git.discard", "Отменить изменения")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void gitDiscard([rel]);
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-red-400" />
                  </button>
                </div>
                {expanded === rel && fileHunks.length > 0 && (
                  <div className="max-h-64 overflow-auto border-l-2 bg-black/20 px-3 py-2 font-mono text-[11px] leading-relaxed" style={{ borderColor: "var(--border-subtle)", marginLeft: 14 }}>
                    {fileHunks.flatMap((h) =>
                      h.lines.map((l, i) => (
                        <div
                          key={i}
                          style={{
                            color:
                              l.kind === "added"
                                ? "#73c991"
                                : l.kind === "removed"
                                  ? "#f14c4c"
                                  : "var(--text-secondary)",
                          }}
                        >
                          {l.kind === "added" ? "+ " : l.kind === "removed" ? "- " : "  "}
                          {l.text}
                        </div>
                      )),
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Commits */}
        <div className="py-1">
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
            {t("git.history", "История коммитов")}
          </div>
          {log.length === 0 && (
            <div className="px-3 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              {t("git.noCommits", "Нет коммитов")}
            </div>
          )}
          {log.map((c) => (
            <div key={c.hash} className="border-b px-3 py-1.5" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="truncate text-[13px]">{c.message}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                <span className="font-mono">{c.short_hash}</span>
                <span>{c.author}</span>
                <span>{c.date}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
