import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

// ---------------------------------------------------------------------------
// Native filesystem access (Phase B).
//
// We no longer go through the OpenCode HTTP API — the Rust backend exposes
// `fs_list` / `fs_read_file` / `fs_write_file` / `fs_create_*` / `fs_rename` /
// `fs_delete` commands (see src-tauri/src/fs_explorer.rs and fs_edit.rs).
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string; // absolute
  is_dir: boolean;
  is_symlink: boolean;
  size: u64;
  modified: number | null; // epoch ms
  children?: FileEntry[];
}

export interface OpenTab {
  path: string; // absolute
  name: string;
  dirty: boolean;
  preview: boolean; // VS Code-style preview tab
  pinned: boolean;
}

export type GitStatusCode =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "renamed"
  | "copied";

export interface GitHunkLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export interface GitHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: GitHunkLine[];
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

interface EditorState {
  root: string;
  entries: Record<string, FileEntry[]>; // absolute dir -> children (lazy)
  expanded: Record<string, boolean>;
  tabs: OpenTab[];
  activePath: string | null;
  loadingDirs: Record<string, boolean>;
  error: string | null;
  mru: string[];
  /** Per-file language override (Monaco id), chosen via the language picker. */
  langOverrides: Record<string, string>;

  // git
  repoRoot: string | null;
  gitStatus: Record<string, GitStatusCode>; // rel path -> status
  gitBranches: GitBranchInfo[];
  gitLog: GitCommit[];
  gitHunks: Record<string, GitHunk[]>; // rel path -> hunks (workdir <-> index)
  gitError: string | null;

  openFolder: (path: string) => void;
  loadDir: (absDir: string) => Promise<void>;
  toggleDir: (absDir: string) => Promise<void>;
  openFile: (path: string, opts?: { preview?: boolean }) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  markSaved: (path: string) => void;
  setDirty: (path: string, dirty: boolean) => void;
  pinTab: (path: string) => void;
  unpinTab: (path: string) => void;
  setLangOverride: (path: string, lang: string | null) => void;
  /** Write the live model of the active tab to disk (no-op if clean). */
  saveActive: () => Promise<boolean>;
  /** Write all dirty tabs to disk. Returns number of saved files. */
  saveAll: () => Promise<number>;

  loadGit: () => Promise<void>;
  loadGitBranches: () => Promise<void>;
  loadGitLog: () => Promise<void>;
  loadGitHunks: (relPath: string) => Promise<void>;
  gitStage: (paths: string[]) => Promise<void>;
  gitUnstage: (paths: string[]) => Promise<void>;
  gitDiscard: (paths: string[]) => Promise<void>;
  gitCommit: (message: string, files?: string[]) => Promise<void>;
  gitCheckout: (branch: string) => Promise<void>;

  createFile: (parentDir: string, name: string) => Promise<void>;
  createDir: (parentDir: string, name: string) => Promise<void>;
  rename: (path: string, newName: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** Cut buffer for file move (Cut/Paste in explorer). */
  cutPaths: string[];
  cutEntries: (paths: string[]) => void;
  pasteInto: (dir: string) => Promise<{ moved: number; failed: string[] }>;
  searchFiles: (query: string) => Promise<string[]>;
}

type u64 = number;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function readFile(path: string): Promise<string> {
  return invoke<string>("fs_read_file", { path });
}

async function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("fs_write_file", { path, content });
}

export { langFromName } from "../lib/languages";

/**
 * Single normalization for every path entering the store: forward slashes,
 * no trailing separator (except a bare drive root like `C:/`), no dupes.
 * Kills the mixed `\` + `/` bugs in create/rename/paste comparisons.
 */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// Supersede token for searchFiles: a new query cancels in-flight batches.
let searchRunToken = 0;

export const useEditorStore = create<EditorState>()((set, get) => ({
  root: "",
  entries: {},
  expanded: {},
  tabs: [],
  activePath: null,
  loadingDirs: {},
  error: null,
  mru: [],
  langOverrides: {},
  repoRoot: null,
  gitStatus: {},
  gitBranches: [],
  gitLog: [],
  gitHunks: {},
  gitError: null,

  openFolder: (path) => {
    const root = normPath(path);
    set({
      root,
      entries: {},
      expanded: {},
      tabs: [],
      activePath: null,
      mru: [],
      error: null,
      repoRoot: null,
      gitStatus: {},
    });
    // Last opened folder = working dir: restored on next launch.
    try {
      if (useSettingsStore.getState().workDir !== root) {
        useSettingsStore.getState().setWorkDir(root);
      }
    } catch {
      /* settings unavailable */
    }
    void get().loadDir(root);
    void get().loadGit();
  },

  loadDir: async (rawDir) => {
    const absDir = normPath(rawDir);
    if (get().loadingDirs[absDir]) return;
    set((s) => ({ loadingDirs: { ...s.loadingDirs, [absDir]: true } }));
    try {
      const items = await invoke<FileEntry[]>("fs_list", {
        path: absDir,
        showHidden: false,
      });
      // Normalize at the Rust boundary: every consumer (tree walk, expanded
      // keys, tabs) then speaks one separator dialect.
      const normed = items.map((it) => ({ ...it, path: normPath(it.path) }));
      set((s) => ({
        entries: { ...s.entries, [absDir]: normed },
        loadingDirs: { ...s.loadingDirs, [absDir]: false },
      }));
    } catch (e) {
      set((s) => ({
        error: String(e),
        loadingDirs: { ...s.loadingDirs, [absDir]: false },
      }));
    }
  },

  toggleDir: async (rawDir) => {
    const absDir = normPath(rawDir);
    const isOpen = !!get().expanded[absDir];
    set((s) => ({ expanded: { ...s.expanded, [absDir]: !isOpen } }));
    if (!isOpen && !get().entries[absDir]) {
      await get().loadDir(absDir);
    }
  },

  openFile: async (rawPath, opts) => {
    const path = normPath(rawPath);
    const preview = opts?.preview ?? true;
    let tabs = get().tabs;
    let activePath = path;
    let mru = get().mru.filter((p) => p !== path);

    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      tabs = tabs.map((t) =>
        t.path === path ? { ...t, preview: preview ? t.preview : false } : t,
      );
    } else {
      const name = path.split(/[\\/]/).pop() ?? path;
      tabs = [...tabs, { path, name, dirty: false, preview, pinned: false }];
    }
    mru = [path, ...mru].slice(0, 50);
    set({ tabs, activePath, mru });

    // Make sure the tab is visible in the focused split group.
    try {
      const { useEditorGroups } = await import("./editorGroupsStore");
      useEditorGroups.getState().ensure(path);
    } catch {
      /* groups store unavailable */
    }

    const parent = path.replace(/\/[^/]+$/, "") || "";
    if (parent && !get().entries[parent]) {
      await get().loadDir(parent);
    }
  },

  closeTab: (rawPath) => {
    const path = normPath(rawPath);
    const { tabs, activePath } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    let active = activePath;
    if (activePath === path) {
      const fallback =
        next[Math.min(idx, next.length - 1)]?.path ?? get().mru[0] ?? null;
      active = fallback;
    }
    set({ tabs: next, activePath: active });
    // Free the Monaco model once nothing references the path anymore
    // (tabs or split groups) — otherwise the heap grows forever.
    void import("../components/editor/EditorInstance").then(({ disposeModel }) =>
      import("./editorGroupsStore").then(({ useEditorGroups }) => {
        try {
          const stillOpen =
            get().tabs.some((t) => t.path === path) ||
            get().activePath === path;
          if (stillOpen) return;
          if (useEditorGroups.getState().groups.some((g) => g.includes(path))) return;
          if (useEditorGroups.getState().active.includes(path)) return;
          disposeModel(path);
        } catch {
          /* editor not mounted — nothing to free */
        }
      }),
    );
  },

  setActive: (path) => {
    const mru = [path, ...get().mru.filter((p) => p !== path)].slice(0, 50);
    set({ activePath: path, mru });
  },

  markSaved: (path) => {
    set({
      tabs: get().tabs.map((t) =>
        t.path === path ? { ...t, dirty: false } : t,
      ),
    });
  },

  setDirty: (path, dirty) => {
    set({
      tabs: get().tabs.map((t) =>
        t.path === path ? { ...t, dirty, preview: false } : t,
      ),
    });
  },

  pinTab: (path) =>
    set({
      tabs: get().tabs.map((t) =>
        t.path === path ? { ...t, pinned: true } : t,
      ),
    }),

  unpinTab: (path) =>
    set({
      tabs: get().tabs.map((t) =>
        t.path === path ? { ...t, pinned: false } : t,
      ),
    }),

  setLangOverride: (path, lang) =>
    set((s) => {
      const langOverrides = { ...s.langOverrides };
      if (lang) langOverrides[path] = lang;
      else delete langOverrides[path];
      return { langOverrides };
    }),

  saveActive: async () => {
    const { activePath, tabs } = get();
    if (!activePath) return false;
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab || !tab.dirty) return false;
    const { getModelValue } = await import("../components/editor/EditorInstance");
    const content = getModelValue(activePath);
    if (content === undefined) return false;
    await writeFile(activePath, content);
    get().markSaved(activePath);
    return true;
  },

  saveAll: async () => {
    const { tabs } = get();
    const dirty = tabs.filter((t) => t.dirty);
    if (dirty.length === 0) return 0;
    const { getModelValue } = await import("../components/editor/EditorInstance");
    let saved = 0;
    for (const tab of dirty) {
      const content = getModelValue(tab.path);
      if (content === undefined) continue;
      try {
        await writeFile(tab.path, content);
        get().markSaved(tab.path);
        saved++;
      } catch {
        /* keep dirty flag so the user can retry */
      }
    }
    return saved;
  },

  createFile: async (parentDir, name) => {
    const abs = normPath(`${normPath(parentDir)}/${name}`);
    await invoke<void>("fs_create_file", { path: abs });
    await get().loadDir(normPath(parentDir));
    await get().openFile(abs, { preview: false });
  },

  createDir: async (parentDir, name) => {
    const dir = normPath(parentDir);
    const abs = normPath(`${dir}/${name}`);
    await invoke<void>("fs_create_dir", { path: abs });
    await get().loadDir(dir);
    await get().toggleDir(abs);
  },

  rename: async (path, newName) => {
    const src = normPath(path);
    const parent = src.replace(/\/[^/]+$/, "") || src;
    const newPath = normPath(`${parent}/${newName}`);
    await invoke<void>("fs_rename", { oldPath: src, newPath });
    // Update any open tab pointing at the old path.
    const tabs = get().tabs.map((t) =>
      normPath(t.path) === src
        ? { ...t, path: newPath, name: newName }
        : t,
    );
    const activePath =
      get().activePath && normPath(get().activePath!) === src
        ? newPath
        : get().activePath;
    set({ tabs, activePath });
    await get().loadDir(parent);
  },

  remove: async (path) => {
    const target = normPath(path);
    await invoke<boolean>("fs_delete", { path: target });
    const parent = target.replace(/\/[^/]+$/, "");
    const tabs = get().tabs.filter((t) => normPath(t.path) !== target);
    const activePath =
      get().activePath && normPath(get().activePath!) === target
        ? null
        : get().activePath;
    set({ tabs, activePath });
    if (parent) await get().loadDir(parent);
  },

  cutPaths: [],

  cutEntries: (paths) => set({ cutPaths: [...paths] }),

  pasteInto: async (dir) => {
    const normDir = normPath(dir);
    const cuts = get().cutPaths.filter(Boolean).map(normPath);
    const failed: string[] = [];
    const renames: [string, string][] = [];
    for (const src of cuts) {
      const parent = src.replace(/\/[^/]+$/, "") || src;
      if (parent === normDir) continue; // same dir — noop, still clears buffer
      const base = src.split("/").pop() ?? src;
      const dst = `${normDir}/${base}`;
      try {
        await invoke<void>("fs_rename", { oldPath: src, newPath: dst });
        renames.push([src, dst]);
      } catch {
        failed.push(src);
      }
    }
    if (renames.length > 0) {
      const remap = (p: string) => {
        const np = normPath(p);
        for (const [src, dst] of renames) {
          if (np === src) return dst;
          if (np.startsWith(src + "/")) {
            return dst + np.slice(src.length);
          }
        }
        return p;
      };
      const tabs = get().tabs.map((t) => {
        const np = remap(t.path);
        return np === t.path
          ? t
          : { ...t, path: np, name: np.split("/").pop() ?? np };
      });
      const activePath = get().activePath ? remap(get().activePath!) : get().activePath;
      set({ tabs, activePath, cutPaths: [] });
      const dirs = new Set<string>([normDir]);
      for (const [src] of renames) {
        const p = src.replace(/\/[^/]+$/, "");
        if (p) dirs.add(p);
      }
      for (const d of dirs) {
        try {
          await get().loadDir(d);
        } catch {
          /* keep going */
        }
      }
    } else {
      set({ cutPaths: [] });
    }
    return { moved: renames.length, failed };
  },

  searchFiles: async (query) => {
    const root = get().root;
    if (!root || !query.trim()) return [];
    // New call supersedes in-flight ones (debounced keystrokes in SearchPanel).
    const token = ++searchRunToken;
    const q = query.toLowerCase();
    const out: string[] = [];
    const MAX = 500;
    const MAX_DEPTH = 12;
    const CONCURRENCY = 8;
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && out.length < MAX) {
      if (token !== searchRunToken) return [];
      const batch = queue.splice(0, CONCURRENCY);
      const results = await Promise.all(
        batch.map((b) =>
          invoke<FileEntry[]>("fs_list", {
            path: b.dir,
            showHidden: false,
          }).catch(() => [] as FileEntry[]),
        ),
      );
      if (token !== searchRunToken) return [];
      for (let i = 0; i < batch.length; i++) {
        if (out.length >= MAX) break;
        const depth = batch[i].depth;
        for (const it of results[i]) {
          if (out.length >= MAX) break;
          if (it.name.toLowerCase().includes(q)) out.push(it.path);
          if (it.is_dir && depth < MAX_DEPTH)
            queue.push({ dir: it.path, depth: depth + 1 });
        }
      }
    }
    return out;
  },

  loadGit: async () => {
    if (!get().root) return;
    try {
      const rr = await invoke<string | null>("git_repo_root", {
        start: get().root,
      });
      if (!rr) {
        set({ repoRoot: null, gitStatus: {}, gitBranches: [], gitLog: [] });
        return;
      }
      const map = await invoke<Record<string, GitStatusCode>>("git_status_map", {
        root: rr,
      });
      set({ repoRoot: rr, gitStatus: map });
      await Promise.all([get().loadGitBranches(), get().loadGitLog()]);
    } catch {
      set({ repoRoot: null, gitStatus: {}, gitBranches: [], gitLog: [] });
    }
  },

  loadGitBranches: async () => {
    const rr = get().repoRoot;
    if (!rr) return;
    try {
      const branches = await invoke<GitBranchInfo[]>("git_branches", { root: rr });
      set({ gitBranches: branches });
    } catch (e) {
      set({ gitError: String(e) });
    }
  },

  loadGitLog: async () => {
    const rr = get().repoRoot;
    if (!rr) return;
    try {
      const log = await invoke<GitCommit[]>("git_log", { root: rr, maxCount: 50 });
      set({ gitLog: log });
    } catch (e) {
      set({ gitError: String(e) });
    }
  },

  loadGitHunks: async (relPath) => {
    const rr = get().repoRoot;
    if (!rr) return;
    try {
      const hunks = await invoke<GitHunk[]>("git_hunks_workdir", {
        root: rr,
        path: relPath,
      });
      set((s) => ({ gitHunks: { ...s.gitHunks, [relPath]: hunks } }));
    } catch (e) {
      console.error("git hunks failed", e);
    }
  },

  gitStage: async (paths) => {
    const rr = get().repoRoot;
    if (!rr) return;
    try {
      await invoke<void>("git_stage", { root: rr, paths });
      await get().loadGit();
    } catch (e) {
      console.error("git stage failed", e);
    }
  },

  gitUnstage: async (paths) => {
    const rr = get().repoRoot;
    if (!rr) return;
    try {
      await invoke<void>("git_unstage", { root: rr, paths });
      await get().loadGit();
    } catch (e) {
      console.error("git unstage failed", e);
    }
  },

  gitDiscard: async (paths) => {
    const rr = get().repoRoot;
    if (!rr) return;
    try {
      await invoke<void>("git_discard", { root: rr, paths });
      await get().loadGit();
      // Reload file content for open tabs that were discarded — push the fresh
      // bytes into the live Monaco model so the editor reflects the revert.
      for (const p of paths) {
        if (!get().tabs.some((t) => t.path === p)) continue;
        try {
          const fresh = await readFile(p);
          try {
            const { monaco } = await import("../lib/monaco");
            const uri = monaco.Uri.parse(`file:///${p.replace(/^[/\\]+/, "")}`);
            const model = monaco.editor.getModel(uri);
            if (model) model.setValue(fresh);
          } catch {
            /* monaco may not be loaded yet */
          }
          set({
            tabs: get().tabs.map((t) =>
              t.path === p ? { ...t, dirty: false } : t,
            ),
          });
        } catch {
          /* read may fail if file was deleted */
          set({
            tabs: get().tabs.map((t) =>
              t.path === p ? { ...t, dirty: false } : t,
            ),
          });
        }
      }
    } catch (e) {
      console.error("git discard failed", e);
    }
  },

  gitCommit: async (message, files) => {
    const rr = get().repoRoot;
    if (!rr) return;
    await invoke<string>("git_commit", {
      root: rr,
      message,
      files: files ?? [],
    });
    await get().loadGit();
  },

  gitCheckout: async (branch) => {
    const rr = get().repoRoot;
    if (!rr) return;
    await invoke<void>("git_checkout", { root: rr, branch });
    await get().loadGit();
  },
}));

export { readFile, writeFile };
