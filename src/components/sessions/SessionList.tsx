import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Globe, Search } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { cn } from "../../lib/cn";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Session } from "../../types/opencode";

function sameDir(a: string, b: string): boolean {
  return (
    a.replace(/[\\/]+$/, "").toLowerCase() ===
    b.replace(/[\\/]+$/, "").toLowerCase()
  );
}

function timeAgo(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  const min = Math.floor(d / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const days = Math.floor(h / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн назад`;
  return new Date(ts).toLocaleDateString();
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function SessionItem({
  session,
  active,
  project,
  onSelect,
  onDelete,
}: {
  session: Session;
  active: boolean;
  project: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const now = Date.now();
  const label = timeAgo(session.time.updated, now);
  const tok = session.tokens;
  const tokTotal =
    (tok?.input ?? 0) + (tok?.output ?? 0) + (tok?.cache?.read ?? 0);

  return (
    <div
      className={cn(
        "pressable group mx-2 mb-1.5 cursor-pointer rounded-lg border px-3 py-2 text-sm",
        !active && "hover:bg-[var(--hover)]",
      )}
      style={
        active
          ? {
              background:
                "color-mix(in srgb, var(--accent-500) 14%, transparent)",
              borderColor: "color-mix(in srgb, var(--accent-500) 45%, transparent)",
            }
          : { borderColor: "transparent" }
      }
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void import("../../stores/contextMenuStore").then(({ useContextMenuStore }) => {
          useContextMenuStore.getState().show(e.clientX, e.clientY, [
            { id: "switch", label: "Перейти к сессии", action: onSelect },
            {
              id: "export",
              label: "Экспорт в markdown",
              action: () =>
                void import("../../lib/sessionExport").then(({ exportSessionMarkdown }) =>
                  exportSessionMarkdown(session.id)
                    .then((p) =>
                      p &&
                      void import("../../stores/toastStore").then(({ toast }) =>
                        toast.success(`Сохранено: ${p}`),
                      ),
                    )
                    .catch((err) =>
                      void import("../../stores/toastStore").then(({ toast }) =>
                        toast.error(String(err)),
                      ),
                    ),
                ),
            },
            {
              id: "copy-id",
              label: "Копировать ID",
              action: () =>
                void import("../../lib/clipboard").then(({ copyText }) => copyText(session.id)),
            },
            { id: "delete", label: "Удалить", danger: true, action: onDelete },
          ]);
        });
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium" title={session.title || session.id}>
          {session.title || session.id}
        </span>
        <button
          title="Delete"
          className="hidden shrink-0 rounded px-1 opacity-60 hover:bg-[var(--border-default)] hover:opacity-100 group-hover:block"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]"
        style={{ color: "var(--text-secondary)" }}
      >
        {!project && (
          <span title={session.directory}>
            <Globe className="h-3 w-3" />
          </span>
        )}
        <span className="shrink-0">{label}</span>
        {session.model?.id && (
          <span
            className="min-w-0 max-w-[55%] truncate rounded px-1.5 py-px font-mono text-[11px]"
            style={{
              background: "color-mix(in srgb, var(--accent-500) 16%, transparent)",
              color: "var(--accent-300)",
            }}
            title={session.model.id}
          >
            {session.model.id}
          </span>
        )}
        {tokTotal > 0 && (
          <span className="shrink-0 tabular-nums" title="Токены сессии">
            {fmtTok(tokTotal)} tok
          </span>
        )}
        {(session.cost ?? 0) > 0 && (
          <span className="shrink-0 tabular-nums" title="Стоимость сессии">
            ${session.cost!.toFixed(3)}
          </span>
        )}
      </div>
    </div>
  );
}

export function SessionList() {
  const { t } = useTranslation();
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeId);
  const selectSession = useChatStore((s) => s.selectSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const workDir = useSettingsStore((s) => s.workDir);
  const [filter, setFilter] = useState("");

  const { project, other } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const proj: Session[] = [];
    const rest: Session[] = [];
    for (const s of sessions) {
      if (
        q &&
        !(s.title || "").toLowerCase().includes(q) &&
        !(s.model?.id || "").toLowerCase().includes(q)
      ) {
        continue;
      }
      (workDir && sameDir(s.directory, workDir) ? proj : rest).push(s);
    }
    return { project: proj, other: rest };
  }, [sessions, workDir, filter]);

  const renderList = (list: Session[], isProject: boolean) =>
    list.map((s) => (
      <SessionItem
        key={s.id}
        session={s}
        active={s.id === activeId}
        project={isProject}
        onSelect={() => void selectSession(s.id)}
        onDelete={() => {
          if (window.confirm(t("sidebar.deleteConfirm")))
            void deleteSession(s.id);
        }}
      />
    ));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {sessions.length > 4 && (
        <div className="mx-2 mb-1.5 flex items-center gap-1.5 rounded-md border px-2 py-1.5" style={{ borderColor: "var(--border-subtle)" }}>
          <Search className="h-3.5 w-3.5 shrink-0 opacity-50" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            placeholder={t("sidebar.search", "Поиск по историям…")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => setFilter("")}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {project.length > 0 && (
        <div
          className="px-4 pt-2 pb-1 text-[12px] font-medium uppercase tracking-wide"
          style={{ color: "var(--text-secondary)" }}
        >
          {t("sidebar.thisProject")}
        </div>
      )}
      {renderList(project, true)}
      {other.length > 0 && (
        <div
          className="px-4 pt-3 pb-1 text-[12px] font-medium uppercase tracking-wide"
          style={{ color: "var(--text-secondary)" }}
        >
          {t("sidebar.otherProjects")}
        </div>
      )}
      {renderList(other, false)}
      {sessions.length === 0 && (
        <p
          className="px-4 pt-6 text-center text-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          {t("sidebar.empty")}
        </p>
      )}
    </div>
  );
}
