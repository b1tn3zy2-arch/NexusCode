import { create } from "zustand";
import type { ReactNode } from "react";

export interface CtxItem {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  action?: () => void;
}

interface ContextMenuState {
  menu: { x: number; y: number; items: CtxItem[] } | null;
  show: (x: number, y: number, items: CtxItem[]) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>()((set) => ({
  menu: null,
  show: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}));

/** Clamp popup position so it never leaves the viewport. */
export function clampMenuPos(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(pad, Math.min(x, vw - w - pad)),
    y: Math.max(pad, Math.min(y, vh - h - pad)),
  };
}
