import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Breakpoint {
  id: string;
  path: string;
  line: number;
  enabled: boolean;
  condition?: string;
}

export interface DebugRun {
  label: string;
  termSessionId: string;
  cmd: string;
  startedAt: number;
}

interface DebugState {
  breakpoints: Breakpoint[];
  activeConfig: string | null;
  /** live run (stop/restart enabled) */
  run: DebugRun | null;
  /** last command (restart works even after stop) */
  lastCmd: { label: string; cmd: string } | null;
  toggle: (path: string, line: number) => void;
  addConditional: (path: string, line: number, condition: string) => void;
  remove: (id: string) => void;
  removeAll: () => void;
  setEnabled: (id: string, enabled: boolean) => void;
  setAllEnabled: (enabled: boolean) => void;
  setActiveConfig: (name: string | null) => void;
  setRun: (run: DebugRun | null) => void;
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `bp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useDebugStore = create<DebugState>()(
  persist(
    (set) => ({
      breakpoints: [],
      activeConfig: null,
      run: null,
      lastCmd: null,

      toggle: (path, line) =>
        set((s) => {
          const ix = s.breakpoints.findIndex(
            (b) => b.path === path && b.line === line,
          );
          if (ix >= 0) {
            const next = [...s.breakpoints];
            next.splice(ix, 1);
            return { breakpoints: next };
          }
          return {
            breakpoints: [
              ...s.breakpoints,
              { id: uid(), path, line, enabled: true },
            ],
          };
        }),

      addConditional: (path, line, condition) =>
        set((s) => {
          const ix = s.breakpoints.findIndex(
            (b) => b.path === path && b.line === line,
          );
          const bp: Breakpoint = {
            id: uid(),
            path,
            line,
            enabled: true,
            condition: condition.trim() || undefined,
          };
          if (ix >= 0) {
            const next = [...s.breakpoints];
            next[ix] = { ...bp, id: next[ix].id };
            return { breakpoints: next };
          }
          return { breakpoints: [...s.breakpoints, bp] };
        }),

      remove: (id) =>
        set((s) => ({ breakpoints: s.breakpoints.filter((b) => b.id !== id) })),

      removeAll: () => set({ breakpoints: [] }),

      setEnabled: (id, enabled) =>
        set((s) => ({
          breakpoints: s.breakpoints.map((b) =>
            b.id === id ? { ...b, enabled } : b,
          ),
        })),

      setAllEnabled: (enabled) =>
        set((s) => ({
          breakpoints: s.breakpoints.map((b) => ({ ...b, enabled })),
        })),

      setActiveConfig: (name) => set({ activeConfig: name }),

      setRun: (run) =>
        set((s) => ({
          run,
          lastCmd: run
            ? { label: run.label, cmd: run.cmd }
            : s.lastCmd,
        })),
    }),
    {
      name: "nexuscode-debug",
      partialize: (s) => ({
        breakpoints: s.breakpoints,
        activeConfig: s.activeConfig,
      }) as Partial<DebugState>,
    },
  ),
);

/** Enabled breakpoint at path+line? (plain helper for hot paths — don't subscribe.) */
export function hasEnabledBp(
  list: Breakpoint[],
  path: string,
  line: number,
): boolean {
  return list.some((b) => b.path === path && b.line === line && b.enabled);
}
