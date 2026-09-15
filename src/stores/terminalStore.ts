import { create } from "zustand";
import { useUiStore } from "./uiStore";
import { useSettingsStore } from "./settingsStore";
import { toast } from "./toastStore";
import { clearTermBuffer } from "../lib/termBuffer";
import type { TermKind } from "../lib/shell";

/** Max kept-alive terminal tabs (xterm buffers are cheap, backends less so). */
export const MAX_TERMS = 8;

function killBackend(id: string): void {
  clearTermBuffer(id);
  void import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke("pty_kill", { session: id }).catch(() => {}),
  );
}

export interface TermSession {
  id: string;
  title: string;
  kind: TermKind;
  profileId?: string | null;
}

interface TerminalState {
  sessions: TermSession[];
  activeId: string | null;
  /** Second visible pane for split view (session id) or null. */
  splitId: string | null;
  counter: number;
  /** Create a session and activate it. Returns the new id. */
  newSession: (kind?: TermKind, profileId?: string | null) => string;
  closeSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setActive: (id: string) => void;
  toggleSplit: () => void;
  /** Open the bottom terminal tab with a fresh session. */
  openTerminal: (kind?: TermKind) => string;
  /** Open the bottom terminal tab in split view. */
  splitTerminal: () => void;
  /** Ensure a shell session exists, open the terminal tab, return { id, fresh }. */
  ensureShell: () => { id: string; fresh: boolean };
}

const titleFor = (kind: TermKind, counter: number) =>
  kind === "shell" ? `Shell ${counter}` : `Opencode ${counter}`;

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  sessions: [],
  activeId: null,
  splitId: null,
  counter: 0,

  newSession: (kind = "opencode", profileId = null) => {
    // Evict the oldest inactive tab past the cap so backends don't pile up.
    const st = get();
    if (st.sessions.length >= MAX_TERMS) {
      const victim = st.sessions.find(
        (x) => x.id !== st.activeId && x.id !== st.splitId,
      );
      if (victim) {
        killBackend(victim.id);
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== victim.id),
        }));
        toast.info(`Вкладка «${victim.title}» закрыта (лимит ${MAX_TERMS})`);
      }
    }
    const counter = get().counter + 1;
    // Unique across reloads: counter alone would reuse term-N and a stale
    // pty_kill could hit the wrong backend.
    const id = `term-${counter}-${Date.now().toString(36)}`;
    let title = titleFor(kind, counter);
    if (kind === "shell" && profileId) {
      try {
        const p = useSettingsStore
          .getState()
          .terminalProfiles.find((x) => x.id === profileId);
        if (p) title = `${p.name} ${counter}`;
      } catch {
        /* default title */
      }
    }
    set((s) => ({
      sessions: [...s.sessions, { id, title, kind, profileId }],
      activeId: id,
      counter,
    }));
    return id;
  },

  renameSession: (id, title) => {
    const name = title.trim().slice(0, 60);
    if (!name) return;
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: name } : x)),
    }));
  },

  closeSession: (id) => {
    // Explicit close only: the backend dies here, never on tab switch.
    killBackend(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      let { activeId, splitId } = s;
      if (splitId === id) splitId = null;
      if (activeId === id) {
        activeId = sessions.length > 0 ? sessions[sessions.length - 1].id : null;
      }
      // If the split pane showed the session, fall back to another one.
      if (splitId && !sessions.some((x) => x.id === splitId)) splitId = null;
      return { sessions, activeId, splitId };
    });
  },

  setActive: (id) =>
    set((s) =>
      s.sessions.some((x) => x.id === id) ? { activeId: id } : {},
    ),

  toggleSplit: () => {
    const { sessions, activeId, splitId } = get();
    if (splitId) {
      set({ splitId: null });
      return;
    }
    let other = sessions.find((x) => x.id !== activeId);
    if (!other) {
      const counter = get().counter + 1;
      const src = sessions.find((x) => x.id === activeId);
      const kind = src?.kind ?? "opencode";
      other = {
        id: `term-${counter}-${Date.now().toString(36)}`,
        title: titleFor(kind, counter),
        kind,
        profileId: src?.profileId ?? null,
      };
      set((s) => ({
        sessions: [...s.sessions, other!],
        counter: s.counter + 1,
      }));
    }
    set({ splitId: other.id });
  },

  openTerminal: (kind = "opencode") => {
    const ui = useUiStore.getState();
    ui.setBottomOpen(true);
    ui.setBottomTab("terminal");
    return get().newSession(kind);
  },

  ensureShell: () => {
    const ui = useUiStore.getState();
    ui.setBottomOpen(true);
    ui.setBottomTab("terminal");
    const existing = get().sessions.find((s) => s.kind === "shell");
    if (existing) {
      set({ activeId: existing.id });
      return { id: existing.id, fresh: false };
    }
    return { id: get().newSession("shell"), fresh: true };
  },

  splitTerminal: () => {
    const ui = useUiStore.getState();
    ui.setBottomOpen(true);
    ui.setBottomTab("terminal");
    const { sessions, activeId } = get();
    if (sessions.length === 0) {
      get().newSession();
    } else if (!activeId) {
      set({ activeId: sessions[0].id });
    }
    get().toggleSplit();
  },
}));
