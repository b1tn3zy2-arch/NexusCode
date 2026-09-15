import { useEffect, useRef } from "react";
import type { Part, Session } from "../types/opencode";
import { useChatStore } from "../stores/chatStore";
import { useEditorStore, readFile } from "../stores/editorStore";
import { useAiFollowStore } from "../stores/aiFollowStore";
/* NOTE: EditorInstance (Monaco) loads lazily — never import it statically here. */
const eiLazy = () => import("./editor/EditorInstance");

const WRITE_TOOL_RE = /edit|write|create|apply|patch|update|save|delete|move|rename|refactor|format/i;
const PATH_KEYS = [
  "filePath",
  "path",
  "file",
  "filename",
  "file_name",
  "absPath",
  "absolutePath",
  "targetFile",
  "file_path",
  "filepath",
];

function looksLikePath(s: string): boolean {
  if (!s || s.length > 500 || s.includes("\n")) return false;
  return /[\\/]/.test(s) || /\.[a-z0-9]{1,5}$/i.test(s);
}

function extractToolPath(part: Part): string | null {
  const input = part.state?.input;
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() && looksLikePath(v)) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const k of PATH_KEYS) {
        const s = o[k];
        if (typeof s === "string" && s.trim() && looksLikePath(s)) return s.trim();
      }
    }
  }
  return null;
}

function isWriteTool(tool: string | undefined, input: unknown): boolean {
  if (tool && WRITE_TOOL_RE.test(tool)) return true;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (
      typeof o["content"] === "string" ||
      typeof o["newText"] === "string" ||
      typeof o["new_string"] === "string" ||
      typeof o["edits"] !== "undefined" ||
      typeof o["diff"] === "string"
    ) {
      return true;
    }
  }
  return false;
}

function resolveAiPath(
  raw: string,
  sessionID: string | undefined,
  sessions: Session[],
  root: string,
): string | null {
  const p = raw.trim().replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith("/")) return p;
  const sess = sessions.find((s) => s.id === sessionID);
  const base = (sess?.directory || root || "").replace(/\\/g, "/").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/${p.replace(/^\.\//, "")}`;
}

function changedRange(oldText: string, newText: string): { from: number; to: number } | null {
  if (oldText === newText) return null;
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let from = 0;
  while (from < a.length && from < b.length && a[from] === b[from]) from++;
  let ai = a.length - 1;
  let bi = b.length - 1;
  while (ai >= from && bi >= from && a[ai] === b[bi]) {
    ai--;
    bi--;
  }
  return { from: from + 1, to: Math.max(from + 1, bi + 1) };
}

/**
 * Vibe-coding watch mode: while the agent edits files, automatically open
 * the touched file and smoothly stream disk changes into the editor with a
 * fading highlight — so you can watch the AI write code live.
 */
export function AiFileFollow() {
  const activeId = useChatStore((s) => s.activeId);
  // NOTE: never `?? []` inside a zustand selector — a fresh array each
  // snapshot makes useSyncExternalStore loop forever (max update depth).
  const messagesMap = useChatStore((s) => s.messagesBySession);
  const messages = activeId ? (messagesMap[activeId] ?? []) : [];
  const busy = useChatStore((s) => (activeId ? (s.busy[activeId] ?? false) : false));
  const enabled = useAiFollowStore((s) => s.enabled);
  const followedPath = useAiFollowStore((s) => s.followedPath);

  const seenRef = useRef<Set<string>>(new Set());
  const lastShownRef = useRef<{ path: string; text: string } | null>(null);

  useEffect(() => {
    seenRef.current.clear();
    lastShownRef.current = null;
    void eiLazy().then((m) => m.cancelAllStreams());
  }, [activeId]);

  // 1) Detect fresh write-tool activity -> open the file, sync once.
  useEffect(() => {
    if (!enabled || !activeId) return;
    const st = useChatStore.getState();
    const root = useEditorStore.getState().root;
    for (const m of messages) {
      if (m.info.role !== "assistant") continue;
      for (const p of m.parts) {
        if (p.type !== "tool" || seenRef.current.has(p.id)) continue;
        const status = p.state?.status;
        if (status !== "running" && status !== "completed") continue;
        if (!isWriteTool(p.tool, p.state?.input)) continue;
        const raw = extractToolPath(p);
        if (!raw) continue;
        seenRef.current.add(p.id);
        const abs = resolveAiPath(raw, m.info.sessionID, st.sessions, root);
        if (!abs) continue;
        useAiFollowStore.getState().setFollowed(abs);
        void (async () => {
          try {
            await useEditorStore.getState().openFile(abs, { preview: false });
          } catch {
            /* file may not exist yet — poll will pick it up */
          }
          try {
            const ei = await eiLazy();
            const disk = await readFile(abs);
            const modelText = ei.getModelValue(abs);
            lastShownRef.current = { path: abs, text: disk };
            if (modelText === undefined || modelText === disk) return;
            // Disk is already ahead (late detection) — animate old -> new
            // instead of popping the finished code instantly.
            ei.streamModelValue(abs, disk, () => {
              try {
                useEditorStore.getState().markSaved(abs);
              } catch {
                /* ignore */
              }
            });
          } catch {
            /* file may not exist yet */
          }
        })();
      }
    }
  }, [messages, enabled, activeId]);

  // 2) While the agent is busy, poll the followed file and stream changes.
  useEffect(() => {
    if (!enabled || !busy || !followedPath) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const ei = await eiLazy();
        const disk = await readFile(followedPath);
        if (stop) return;
        const last = lastShownRef.current;
        const base =
          last && last.path === followedPath ? last.text : ei.getModelValue(followedPath);
        if (base === undefined) {
          lastShownRef.current = { path: followedPath, text: disk };
          return;
        }
        if (disk !== base) {
          const modelNow = ei.getModelValue(followedPath);
          if (modelNow !== undefined && modelNow !== base) {
            // user typed meanwhile (or our own stale frame) — stop any
            // animation and rebase silently instead of fighting
            ei.cancelStream(followedPath);
            lastShownRef.current = { path: followedPath, text: modelNow };
            return;
          }
          const range = changedRange(base, disk);
          lastShownRef.current = { path: followedPath, text: disk };
          const done = () => {
            try {
              useEditorStore.getState().markSaved(followedPath);
            } catch {
              /* ignore */
            }
            if (range) {
              const mid = Math.round((range.from + range.to) / 2);
              if (ei.revealPathLine(followedPath, mid)) {
                ei.flashPathLines(followedPath, range.from, range.to);
              }
            }
          };
          // Smoothly type out the change; if the model isn't live yet
          // (tab still opening) just finalize state — the open effect
          // loads the same content.
          if (!ei.streamModelValue(followedPath, disk, done)) done();
        }
      } catch {
        /* file may appear later */
      }
    };
    const id = window.setInterval(() => void tick(), 350);
    void tick();
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [enabled, busy, followedPath]);

  return null;
}
