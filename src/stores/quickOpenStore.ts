import { create } from "zustand";

interface QuickOpenState {
  open: boolean;
  /** One-shot initial query (e.g. ":" for Go to Line), consumed on open. */
  preset: string | null;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  /** Open with a preset query. */
  openWith: (query: string) => void;
}

export const useQuickOpenStore = create<QuickOpenState>()((set) => ({
  open: false,
  preset: null,
  setOpen: (v) => set((s) => ({ open: v, preset: v ? s.preset : null })),
  toggle: () => set((s) => ({ open: !s.open, preset: null })),
  openWith: (query) => set({ open: true, preset: query }),
}));
