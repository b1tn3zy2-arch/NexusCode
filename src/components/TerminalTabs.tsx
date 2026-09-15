import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, Columns2, TerminalSquare, Terminal, Play, Bot, Pencil, Copy, Eraser, XCircle, Wrench } from "lucide-react";
import { useTerminalStore } from "../stores/terminalStore";
import { TerminalPanel, sendToShell, getTermHandle } from "./TerminalPanel";
import { useContextMenuStore } from "../stores/contextMenuStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { logInfo, logWarn } from "../stores/outputStore";
import { toast } from "../stores/toastStore";
import { detectGitBash, detectRunCommand, needsPythonForDir, resolvePip, type TermProfile } from "../lib/shell";

export function TerminalTabs() {
  const { t } = useTranslation();
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const splitId = useTerminalStore((s) => s.splitId);
  const newSession = useTerminalStore((s) => s.newSession);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const setActive = useTerminalStore((s) => s.setActive);
  const toggleSplit = useTerminalStore((s) => s.toggleSplit);
  const profiles = useSettingsStore((s) => s.terminalProfiles);
  const defaultProfileId = useSettingsStore((s) => s.defaultProfileId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Auto-register detected Git Bash as a profile (once, if missing).
  useEffect(() => {
    let dead = false;
    void detectGitBash().then((bin) => {
      if (dead || !bin) return;
      const st = useSettingsStore.getState();
      if (st.terminalProfiles.some((p) => p.id === "gitbash")) return;
      const gitbash: TermProfile = {
        id: "gitbash",
        name: "Git Bash",
        shell: bin,
        args: ["--login", "-i"],
        icon: "terminal",
      };
      st.setTerminalProfiles([...st.terminalProfiles, gitbash]);
    });
    return () => {
      dead = true;
    };
  }, []);

  // Always keep at least one session while the tab is visible.
  useEffect(() => {
    if (sessions.length === 0) {
      newSession();
    } else if (!activeId || !sessions.some((s) => s.id === activeId)) {
      setActive(sessions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length, activeId]);

  const splitSession = splitId ? sessions.find((s) => s.id === splitId) ?? null : null;

  const openNewMenu = (x: number, y: number) => {
    const def = profiles.find((p) => p.id === defaultProfileId) ?? profiles[0];
    useContextMenuStore.getState().show(x, y, [
      {
        id: "new-opencode",
        label: t("terminal.newOpencode", "Opencode session"),
        icon: <Bot size={14} />,
        action: () => void newSession("opencode"),
      },
      {
        id: "new-shell",
        label: def
          ? `${t("terminal.newShell", "Shell")} (${def.name})`
          : t("terminal.newShell", "Shell"),
        icon: <Terminal size={14} />,
        action: () => void newSession("shell", def?.id ?? null),
      },
      ...profiles
        .filter((p) => p.id !== def?.id)
        .map((p) => ({
          id: `new-profile-${p.id}`,
          label: p.name,
          icon: <Terminal size={14} />,
          action: () => void newSession("shell", p.id),
        })),
    ]);
  };

  const commitRename = () => {
    if (renamingId) renameSession(renamingId, renameDraft);
    setRenamingId(null);
  };

  const tabMenu = (x: number, y: number, id: string) => {
    const st = useTerminalStore.getState();
    const s = st.sessions.find((x) => x.id === id);
    if (!s) return;
    useContextMenuStore.getState().show(x, y, [
      {
        id: "rename",
        label: t("terminal.rename", "Переименовать"),
        icon: <Pencil size={14} />,
        action: () => {
          setActive(id);
          setRenamingId(id);
          setRenameDraft(s.title);
        },
      },
      {
        id: "duplicate",
        label: t("terminal.duplicate", "Дублировать"),
        icon: <Copy size={14} />,
        action: () => void st.newSession(s.kind, s.profileId ?? null),
      },
      {
        id: "clear",
        label: t("terminal.clearTab", "Очистить"),
        icon: <Eraser size={14} />,
        action: () => getTermHandle(id)?.clear(),
      },
      {
        id: "split",
        label: t("terminal.split", "Split terminal"),
        icon: <Columns2 size={14} />,
        action: () => {
          st.setActive(id);
          st.toggleSplit();
        },
      },
      { id: "sep1", label: "", sep: true },
      {
        id: "close",
        label: t("terminal.close", "Close terminal"),
        icon: <X size={14} />,
        action: () => st.closeSession(id),
      },
      {
        id: "close-others",
        label: t("terminal.closeOthers", "Закрыть остальные"),
        icon: <XCircle size={14} />,
        danger: true,
        action: () => {
          for (const x of st.sessions) {
            if (x.id !== id) st.closeSession(x.id);
          }
        },
      },
    ]);
  };

  const fixLastError = async () => {
    const st = useTerminalStore.getState();
    const active = st.sessions.find((s) => s.id === st.activeId);
    if (!active || active.kind !== "shell") {
      toast.info(t("terminal.fixNeedShell", "Откройте shell-вкладку с выводом команды"));
      return;
    }
    const { getTermTail } = await import("../lib/termBuffer");
    const tail = getTermTail(active.id, 80);
    if (!tail.trim()) {
      toast.info(t("terminal.fixEmpty", "В терминале пока пусто"));
      return;
    }
    const chat = (await import("../stores/chatStore")).useChatStore.getState();
    let sid = chat.activeId;
    if (!sid) {
      const created = await chat.createSession().catch(() => null);
      sid = created?.id ?? null;
      if (!sid) {
        toast.error(t("terminal.fixNoSession", "Не удалось создать чат-сессию"));
        return;
      }
    }
    const preset =
      `В терминале команда завершилась с ошибкой (или вывод выглядит как ошибка). ` +
      `Объясни, что случилось, и предложи конкретное исправление.\n\n` +
      `Вывод терминала:\n\`\`\`\n${tail}\n\`\`\``;
    await chat.send(preset, []).catch((e) => toast.error(String(e)));
    useUiStore.getState().setAiPanelOpen(true);
    logInfo("terminal", "вывод отправлен в чат на разбор");
  };

  const runProject = async () => {
    const workDir = useSettingsStore.getState().workDir;
    // Python project without any Python → offer one-click install instead
    // of typing a doomed `pip ...` into the shell.
    if (await needsPythonForDir(workDir)) {
      const pip = await resolvePip(workDir).catch(() => null);
      if (!pip) {
        const msg = "Python не найден — pip ставить не во что";
        logWarn("terminal", msg);
        toast.error(msg, {
          label: "Установить Python",
          run: () => {
            void import("../lib/debugActions").then((m) => m.installPython());
          },
        });
        return;
      }
    }
    const cmd = await detectRunCommand(workDir);
    if (!cmd) {
      logWarn("terminal", t("terminal.noRunTarget", "No runnable project found (package.json / requirements.txt / pyproject.toml / Cargo.toml / go.mod)"));
      return;
    }
    const st = useTerminalStore.getState();
    const active = st.sessions.find((s) => s.id === st.activeId);
    let id = st.activeId;
    if (!active || active.kind !== "shell") {
      id = st.newSession("shell");
    }
    useUiStore.getState().setBottomOpen(true);
    useUiStore.getState().setBottomTab("terminal");
    logInfo("terminal", `run: ${cmd}`);
    const ok = await sendToShell(id!, `${cmd}\r`);
    if (!ok) {
      const fail = `Терминал не принял команду: ${cmd}`;
      logWarn("terminal", fail);
      toast.error(fail);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <div
        className="flex w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {sessions.map((s) => (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === activeId}
            onClick={() => setActive(s.id)}
            onDoubleClick={() => {
              setRenamingId(s.id);
              setRenameDraft(s.title);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              tabMenu(e.clientX, e.clientY, s.id);
            }}
            className="group flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]"
            style={{
              color: s.id === activeId ? "var(--text-primary)" : "var(--text-secondary)",
              background: s.id === activeId ? "var(--active)" : "transparent",
            }}
            title={s.title}
          >
            {s.kind === "shell" ? (
              <Terminal size={12} className="shrink-0 opacity-70" />
            ) : (
              <TerminalSquare size={12} className="shrink-0 opacity-70" />
            )}
            {renamingId === s.id ? (
              <input
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="truncate">{s.title}</span>
            )}
            <button
              className="rounded p-0.5 opacity-0 hover:bg-[var(--hover)] group-hover:opacity-100"
              title={t("terminal.close", "Close terminal")}
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="shrink-0 rounded-md p-1.5 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
          title={t("terminal.new", "New terminal")}
          onClick={(e) => openNewMenu(e.clientX, e.clientY)}
        >
          <Plus size={14} />
        </button>
        <button
          className="shrink-0 rounded-md p-1.5 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
          title={t("terminal.runProject", "Run project")}
          onClick={() => void runProject()}
        >
          <Play size={14} />
        </button>
        <button
          className="shrink-0 rounded-md p-1.5 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
          title={t("terminal.fixError", "Почини ошибку: отправить вывод в чат")}
          onClick={() => void fixLastError()}
        >
          <Wrench size={14} />
        </button>
        <span className="flex-1" />
        <button
          className="shrink-0 rounded-md p-1.5 hover:bg-[var(--hover)]"
          style={{
            color: splitId ? "var(--accent)" : "var(--text-secondary)",
            background: splitId ? "var(--active)" : "transparent",
          }}
          title={t("terminal.split", "Split terminal")}
          onClick={() => toggleSplit()}
        >
          <Columns2 size={14} />
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* All sessions stay mounted so scrollback + backend survive
            switching; inactive ones are just hidden. */}
        {sessions.map((s) => {
          const shown = s.id === activeId && s.id !== splitId;
          const inSplit = splitSession !== null && s.id === splitSession.id;
          if (!shown && !inSplit) {
            return (
              <div key={s.id} className="hidden" aria-hidden>
                <TerminalPanel sessionId={s.id} visible={false} />
              </div>
            );
          }
          return (
            <div
              key={s.id}
              className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
              style={
                inSplit && !shown
                  ? { borderLeft: "1px solid var(--border-subtle)" }
                  : undefined
              }
            >
              <TerminalPanel sessionId={s.id} visible />
            </div>
          );
        })}
        {!activeId && sessions.length === 0 && (
          <div
            className="flex flex-1 items-center justify-center text-[13px]"
            style={{ color: "var(--text-secondary)" }}
          >
            {t("terminal.empty", "No terminal — create one with +")}
          </div>
        )}
      </div>
    </div>
  );
}
