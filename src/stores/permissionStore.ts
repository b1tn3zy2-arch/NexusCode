import { create } from "zustand";
import { autoApproveApi, type ActionLogEntry } from "../services/backend";

export interface PendingPermission {
  id: string;
  sessionID: string;
  kind: string;
  title: string;
  pattern?: string | string[];
  metadata: Record<string, unknown>;
}

interface PermissionState {
  pending: PendingPermission[];
  entries: ActionLogEntry[];
  lastAutoAction: { decision: string; tool: string; at: number } | null;

  pushPending: (p: PendingPermission) => void;
  removePending: (id: string) => void;
  noteResolved: (decision: string, tool: string, auto: boolean) => void;
  refreshLog: () => Promise<void>;
  clearLog: () => Promise<void>;
}

export const usePermissionStore = create<PermissionState>()((set) => ({
  pending: [],
  entries: [],
  lastAutoAction: null,

  pushPending: (p) =>
    set((st) => ({
      pending: st.pending.some((x) => x.id === p.id)
        ? st.pending
        : [...st.pending, p],
    })),

  removePending: (id) =>
    set((st) => ({ pending: st.pending.filter((x) => x.id !== id) })),

  noteResolved: (decision, tool, auto) =>
    // Manual replies must not clobber the auto-action record.
    auto
      ? set({ lastAutoAction: { decision, tool, at: Date.now() } })
      : set({}),

  refreshLog: async () => {
    try {
      const entries = await autoApproveApi.listLog(50);
      set({ entries });
    } catch {
      // log panel is non-critical
    }
  },

  clearLog: async () => {
    try {
      await autoApproveApi.clearLog();
      set({ entries: [] });
    } catch {
      // ignore
    }
  },
}));
