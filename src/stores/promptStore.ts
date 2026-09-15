import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  uses: number;
  updatedAt: number;
}

interface PromptState {
  items: SavedPrompt[];
  add: (title: string, body: string) => void;
  remove: (id: string) => void;
  bumpUse: (id: string) => void;
}

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function extractVars(body: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_а-яА-ЯёЁ.-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 12);
}

export function fillVars(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([A-Za-z0-9_а-яА-ЯёЁ.-]+)\s*\}\}/g, (_, k: string) =>
    k in values && values[k] !== "" ? values[k] : `{{${k}}}`,
  );
}

export const usePromptStore = create<PromptState>()(
  persist(
    (set) => ({
      items: [],
      add: (title, body) =>
        set((st) => ({
          items: [
            { id: uid(), title: title.trim().slice(0, 80) || "Без названия", body, uses: 0, updatedAt: Date.now() },
            ...st.items,
          ].slice(0, 200),
        })),
      remove: (id) => set((st) => ({ items: st.items.filter((p) => p.id !== id) })),
      bumpUse: (id) =>
        set((st) => ({
          items: st.items.map((p) =>
            p.id === id ? { ...p, uses: p.uses + 1, updatedAt: Date.now() } : p,
          ),
        })),
    }),
    { name: "nexuscode-prompts" },
  ),
);
