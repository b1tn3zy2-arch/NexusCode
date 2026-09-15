import { create } from "zustand";

// Split editor layout (Phase B.5). The editor area is divided into one or
// more *groups*; each group is a column holding an ordered list of open tab
// paths and a focused path. Ctrl+\ splits the active group; tabs can be
// dragged between groups.

export interface EditorGroupsState {
  groups: string[][]; // each group: ordered tab paths
  active: (string | null)[]; // focused path per group (parallel to `groups`)
  focusedGroup: number;
  split: () => void; // split the focused group
  setFocusedGroup: (i: number) => void;
  setActive: (group: number, path: string) => void;
  closeTab: (group: number, path: string) => void;
  moveTab: (path: string, fromGroup: number, toGroup: number, index?: number) => void;
  ensure: (path: string) => void; // make sure a tab exists in the focused group
  removeEverywhere: (path: string) => void;
}

export const useEditorGroups = create<EditorGroupsState>()((set, get) => ({
  groups: [[]],
  active: [null],
  focusedGroup: 0,

  split: () => {
    const { groups, active, focusedGroup } = get();
    if (groups.length >= 3) return; // cap at 3 splits
    const path = active[focusedGroup] ?? null;
    const newGroup = path ? [path] : [];
    set({
      groups: [...groups, newGroup],
      active: [...active, path],
      focusedGroup: groups.length,
    });
  },

  setFocusedGroup: (i) => set({ focusedGroup: i }),

  setActive: (group, path) =>
    set((s) => {
      const active = [...s.active];
      active[group] = path;
      return { active, focusedGroup: group };
    }),

  closeTab: (group, path) =>
    set((s) => {
      const groups = s.groups.map((g) => g.filter((p) => p !== path));
      const active = [...s.active];
      if (active[group] === path) {
        const remaining = groups[group];
        active[group] = remaining[remaining.length - 1] ?? null;
      }
      return { groups, active };
    }),

  moveTab: (path, fromGroup, toGroup, index) =>
    set((s) => {
      const groups = s.groups.map((g) => [...g]);
      groups[fromGroup] = groups[fromGroup].filter((p) => p !== path);
      const dest = groups[toGroup] ? groups[toGroup] : (groups[toGroup] = []);
      const at = index ?? dest.length;
      dest.splice(at, 0, path);
      const active = [...s.active];
      if (s.active[fromGroup] === path && groups[fromGroup].length === 0) {
        active[fromGroup] = null;
      }
      active[toGroup] = path;
      return { groups, active, focusedGroup: toGroup };
    }),

  ensure: (path) =>
    set((s) => {
      if (s.groups[s.focusedGroup]?.includes(path)) return {};
      const groups = s.groups.map((g) => [...g]);
      groups[s.focusedGroup] = [...groups[s.focusedGroup], path];
      const active = [...s.active];
      active[s.focusedGroup] = path;
      return { groups, active };
    }),

  removeEverywhere: (path) =>
    set((s) => {
      const groups = s.groups.map((g) => g.filter((p) => p !== path));
      const active = s.active.map((a, i) =>
        a === path ? (groups[i][groups[i].length - 1] ?? null) : a,
      );
      return { groups, active };
    }),
}));
