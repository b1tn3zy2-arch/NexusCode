import { invoke } from "@tauri-apps/api/core";
import type { GitHunk } from "../stores/editorStore";

export interface Checkpoint {
  id: string;
  label: string;
  message: string;
}

export interface CheckpointFile {
  existed: boolean;
  content: string;
}

export const checkpointsApi = {
  create: (root: string, label: string) =>
    invoke<Checkpoint>("checkpoint_create", { root, label }),
  list: (root: string) =>
    invoke<Checkpoint[]>("checkpoint_list", { root }).catch(() => [] as Checkpoint[]),
  restore: (root: string, id: string) =>
    invoke<void>("checkpoint_restore", { root, id }),
  diff: (root: string, id: string) =>
    invoke<string[]>("checkpoint_diff", { root, id }).catch(() => [] as string[]),
  prune: (root: string, keep: number) =>
    invoke<number>("checkpoint_prune", { root, keep }).catch(() => 0),
  /** File content at a checkpoint (side-by-side AI review). */
  file: (root: string, id: string, path: string) =>
    invoke<CheckpointFile>("checkpoint_file", { root, id, path }),
  /** Workdir hunks vs a checkpoint (inline review decorations). */
  hunks: (root: string, id: string, path: string) =>
    invoke<GitHunk[]>("checkpoint_hunks", { root, id, path }).catch(() => [] as GitHunk[]),
  /** Per-file Reject: restore one file (or delete if agent-created). */
  restoreFile: (root: string, id: string, path: string) =>
    invoke<boolean>("checkpoint_restore_file", { root, id, path }),
};

/** Max auto snapshots kept per repo (Cursor-style, oldest pruned). */
export const PRE_RUN_KEEP = 20;

/** Pre-run snapshot id per chat session (in-memory, set on send). */
const preRunBySession = new Map<string, string>();

export function setPreRunCheckpoint(sessionId: string, id: string | null) {
  if (id) preRunBySession.set(sessionId, id);
  else preRunBySession.delete(sessionId);
}

export function takePreRunCheckpoint(sessionId: string): string | null {
  return preRunBySession.get(sessionId) ?? null;
}

/**
 * Snapshot the repo before an agent run. Returns the checkpoint id or
 * null when clean / not a repo. Never throws. Prunes old auto snapshots.
 */
export async function ensurePreRunSnapshot(
  root: string,
  label: string,
): Promise<string | null> {
  try {
    if (!root) return null;
    const clean = label.trim().slice(0, 60);
    if (!clean) return null;
    const cp = await checkpointsApi
      .create(root, clean)
      .catch(() => null);
    await checkpointsApi.prune(root, PRE_RUN_KEEP).catch(() => null);
    return cp ? cp.id : null;
  } catch {
    return null;
  }
}

/** Auto-snapshot on send, but only when the repo has no snapshots yet. */
export async function maybeAutoCheckpoint(root: string, label: string): Promise<void> {
  try {
    if (!root) return;
    const list = await checkpointsApi.list(root);
    if (list.length > 0) return;
    const clean = label.trim().slice(0, 60);
    if (!clean) return;
    await checkpointsApi.create(root, clean).catch(() => null);
  } catch {
    /* never break sending */
  }
}

/**
 * Revert a whole run to its pre-run checkpoint AND sync open editor tabs
 * with the restored disk state (otherwise tabs keep showing stale text).
 * Throws on restore failure; tab sync is best-effort.
 */
export async function revertRun(root: string, checkpointId: string): Promise<void> {
  await checkpointsApi.restore(root, checkpointId);
  try {
    const { readFile, useEditorStore } = await import("../stores/editorStore");
    const tabs = useEditorStore.getState().tabs.map((t) => t.path);
    const { getModelValue, setModelValue } = await import(
      "../components/editor/EditorInstance"
    );
    const ed = useEditorStore.getState();
    await Promise.all(
      tabs.map(async (p) => {
        try {
          const disk = await readFile(p);
          if (getModelValue(p) !== undefined) setModelValue(p, disk);
          ed.markSaved(p);
        } catch {
          /* one bad tab must not kill the sync */
        }
      }),
    );
    try {
      const { useDiagnosticsStore } = await import("../stores/diagnosticsStore");
      const diag = useDiagnosticsStore.getState();
      await Promise.all(tabs.map((p) => diag.refreshFile(p).catch(() => {})));
    } catch {
      /* diagnostics are best-effort */
    }
  } catch {
    /* model sync is best-effort */
  }
}
