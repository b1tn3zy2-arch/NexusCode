import { create } from "zustand";

export interface ToastAction {
  label: string;
  run: () => void;
}

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  show: (
    text: string,
    opts?: { kind?: ToastKind; action?: ToastAction; timeoutMs?: number },
  ) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  show: (text, opts) => {
    const id = nextId++;
    const kind = opts?.kind ?? "info";
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id, kind, text, action: opts?.action }],
    }));
    const ttl = opts?.timeoutMs ?? (kind === "error" ? 0 : 4500);
    if (ttl > 0) {
      setTimeout(() => get().dismiss(id), ttl);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Fire-and-forget helpers (safe to call from anywhere, incl. menu actions). */
export const toast = {
  info: (text: string, action?: ToastAction) =>
    useToastStore.getState().show(text, { kind: "info", action }),
  success: (text: string, action?: ToastAction) =>
    useToastStore.getState().show(text, { kind: "success", action }),
  error: (text: string, action?: ToastAction) =>
    useToastStore.getState().show(text, { kind: "error", action }),
};
