import { create } from "zustand";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_ENTRIES = 500;
let nextId = 1;

interface OutputState {
  entries: LogEntry[];
  push: (level: LogLevel, source: string, message: string) => void;
  clear: () => void;
}

function truncate(msg: string, max = 2000): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max) + "…";
}

export const useOutputStore = create<OutputState>()((set) => ({
  entries: [],
  push: (level, source, message) =>
    set((st) => {
      const entry: LogEntry = {
        id: nextId++,
        ts: Date.now(),
        level,
        source,
        message: truncate(String(message ?? "")),
      };
      const entries = [...st.entries, entry];
      if (entries.length > MAX_ENTRIES) {
        return { entries: entries.slice(entries.length - MAX_ENTRIES) };
      }
      return { entries };
    }),
  clear: () => set({ entries: [] }),
}));

export function logInfo(source: string, message: string) {
  try {
    useOutputStore.getState().push("info", source, message);
  } catch {
    /* store not ready */
  }
}

export function logWarn(source: string, message: string) {
  try {
    useOutputStore.getState().push("warn", source, message);
  } catch {
    /* ignore */
  }
}

export function logError(source: string, message: string) {
  try {
    useOutputStore.getState().push("error", source, message);
  } catch {
    /* ignore */
  }
}
