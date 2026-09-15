import { create } from "zustand";
import { analyzeFile, type FileDiagnostic } from "../lib/diagnostics";
import { readFile, useEditorStore } from "./editorStore";

const MAX_FILES = 40;

interface DiagnosticsState {
  byFile: Record<string, FileDiagnostic[]>;
  scanning: boolean;
  updatedAt: number;
  refreshFile: (path: string) => Promise<void>;
  refreshOpenTabs: () => Promise<void>;
  clear: () => void;
}

let runToken = 0;

async function loadContent(path: string): Promise<string | null> {
  try {
    const { getModelValue } = await import("../components/editor/EditorInstance");
    const live = getModelValue(path);
    if (typeof live === "string") return live;
  } catch {
    /* editor not mounted yet */
  }
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export const useDiagnosticsStore = create<DiagnosticsState>()((set) => ({
  byFile: {},
  scanning: false,
  updatedAt: 0,

  refreshFile: async (path) => {
    const content = await loadContent(path);
    if (content === null) {
      set((st) => {
        if (!(path in st.byFile)) return st;
        const byFile = { ...st.byFile };
        delete byFile[path];
        return { byFile, updatedAt: Date.now() };
      });
      return;
    }
    const diags = analyzeFile(path, content);
    set((st) => ({ byFile: { ...st.byFile, [path]: diags }, updatedAt: Date.now() }));
  },

  refreshOpenTabs: async () => {
    const token = ++runToken;
    const tabs = useEditorStore.getState().tabs.slice(0, MAX_FILES);
    if (tabs.length === 0) {
      set({ byFile: {}, updatedAt: Date.now() });
      return;
    }
    set({ scanning: true });
    const next: Record<string, FileDiagnostic[]> = {};
    for (const tab of tabs) {
      if (token !== runToken) return; // superseded
      const content = await loadContent(tab.path);
      if (token !== runToken) return;
      if (content !== null) {
        next[tab.path] = analyzeFile(tab.path, content);
      }
    }
    if (token !== runToken) return;
    // drop entries for closed tabs
    set({ byFile: next, scanning: false, updatedAt: Date.now() });
  },

  clear: () => set({ byFile: {}, updatedAt: Date.now() }),
}));

export function useFileDiagnostics(): FileDiagnostic[] {
  const byFile = useDiagnosticsStore((s) => s.byFile);
  const tabs = useEditorStore((s) => s.tabs);
  const order = new Map(tabs.map((t, i) => [t.path, i]));
  const all: FileDiagnostic[] = [];
  for (const diags of Object.values(byFile)) {
    for (const d of diags) all.push(d);
  }
  all.sort((a, b) => {
    const oa = order.get(a.file) ?? Number.MAX_SAFE_INTEGER;
    const ob = order.get(b.file) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  });
  return all;
}

export function diagnosticsCount(): { total: number; errors: number; warnings: number } {
  const byFile = useDiagnosticsStore.getState().byFile;
  let total = 0;
  let errors = 0;
  let warnings = 0;
  for (const diags of Object.values(byFile)) {
    for (const d of diags) {
      total++;
      if (d.severity === "error") errors++;
      else if (d.severity === "warning") warnings++;
    }
  }
  return { total, errors, warnings };
}

export function useDiagnosticsCount() {
  const byFile = useDiagnosticsStore((s) => s.byFile);
  let total = 0;
  let errors = 0;
  let warnings = 0;
  for (const diags of Object.values(byFile)) {
    for (const d of diags) {
      total++;
      if (d.severity === "error") errors++;
      else if (d.severity === "warning") warnings++;
    }
  }
  return { total, errors, warnings };
}

export function invalidateDiagnostics() {
  runToken++;
  useDiagnosticsStore.setState({ scanning: false });
}
