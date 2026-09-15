import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { monaco, monacoTheme } from "../../lib/monaco";
import {
  useEditorStore,
  readFile,
  writeFile,
  type GitHunk,
} from "../../stores/editorStore";
import { langFromName } from "../../lib/languages";
import { isImageFile } from "../../lib/files";
import { ImagePreview } from "./ImagePreview";
import { useSettingsStore } from "../../stores/settingsStore";
import { useContextMenuStore } from "../../stores/contextMenuStore";
import { useDebugStore } from "../../stores/debugStore";
import { useEditorMenu } from "../menus";

// A single Monaco editor instance bound to one split group (Phase B.5).
// Tab ownership/switching lives in EditorArea; this component just renders the
// model for `activePath` and keeps git gutter decorations in sync.

const models = new Map<string, MonacoEditorNS.ITextModel>();

/** Debounced live-diagnostics refresh per path (Problems update as you type). */
const diagTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleDiagRefresh(path: string) {
  const prev = diagTimers.get(path);
  if (prev) clearTimeout(prev);
  diagTimers.set(
    path,
    setTimeout(() => {
      diagTimers.delete(path);
      try {
        if (!useEditorStore.getState().tabs.some((t) => t.path === path)) return;
      } catch {
        /* store not ready */
      }
      void import("../../stores/diagnosticsStore").then(({ useDiagnosticsStore }) =>
        useDiagnosticsStore.getState().refreshFile(path).catch(() => {}),
      );
    }, 800),
  );
}

/** Mounted editors (one per split group) + last focused, for menu actions. */
const mountedEditors = new Set<MonacoEditorNS.IStandaloneCodeEditor>();
let lastFocused: MonacoEditorNS.IStandaloneCodeEditor | null = null;

function effectiveLang(path: string, name: string): string | undefined {
  try {
    const override = useEditorStore.getState().langOverrides[path];
    if (override) return override;
  } catch {
    /* store not ready */
  }
  return langFromName(name);
}

function getOrCreateModel(path: string, content: string, name: string) {
  const uri = monaco.Uri.parse(`file:///${path.replace(/^[/\\]+/, "")}`);
  let model = models.get(path);
  if (model && !model.isDisposed()) {
    const want = effectiveLang(path, name);
    try {
      if (want && model.getLanguageId() !== want) {
        monaco.editor.setModelLanguage(model, want);
      }
    } catch {
      /* ignore */
    }
    return model;
  }
  model =
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(content, effectiveLang(path, name), uri);
  models.set(path, model);
  return model;
}

/** The currently focused editor, if any (used by Edit menu actions). */
export function getActiveEditor(): MonacoEditorNS.IStandaloneCodeEditor | null {
  if (lastFocused) {
    try {
      const model = lastFocused.getModel();
      if (model && !model.isDisposed()) return lastFocused;
    } catch {
      /* fall through */
    }
  }
  for (const ed of mountedEditors) {
    try {
      if (ed.hasTextFocus()) {
        lastFocused = ed;
        return ed;
      }
    } catch {
      /* ignore */
    }
  }
  return lastFocused;
}

/** Switch the highlighting language of an open tab's model. */
export function setModelLanguage(path: string, name: string, lang: string | undefined) {
  const model = models.get(path);
  if (!model || model.isDisposed()) return;
  const want = lang ?? langFromName(name) ?? "plaintext";
  try {
    if (model.getLanguageId() !== want) {
      monaco.editor.setModelLanguage(model, want);
    }
  } catch {
    /* ignore */
  }
}

/** Overwrite an open tab's model content (AI streaming). Returns false if no model. */
export function setModelValue(path: string, content: string): boolean {
  const m = models.get(path);
  if (!m || m.isDisposed()) return false;
  try {
    cancelStream(path);
    if (m.getValue() !== content) {
      m.pushEditOperations([], [{ range: m.getFullModelRange(), text: content }], () => null);
    }
    return true;
  } catch {
    return false;
  }
}

/** Dispose the text model for a closed path (frees Monaco heap). Safe to call repeatedly. */
export function disposeModel(path: string): void {
  const m = models.get(path);
  if (!m) return;
  models.delete(path);
  try {
    cancelStream(path);
  } catch {
    /* ignore */
  }
  try {
    if (!m.isDisposed()) m.dispose();
  } catch {
    /* ignore */
  }
}

const streamTimers = new Map<string, number>();

/** Stop a running reveal animation for path (idempotent). */
export function cancelStream(path: string): void {
  const t = streamTimers.get(path);
  if (t !== undefined) {
    try {
      window.clearTimeout(t);
    } catch {
      /* ignore */
    }
    streamTimers.delete(path);
  }
}

/** Stop all reveal animations (session switch / unmount). */
export function cancelAllStreams(): void {
  for (const path of [...streamTimers.keys()]) cancelStream(path);
}

function followFrontier(m: MonacoEditorNS.ITextModel, line: number): void {
  for (const ed of mountedEditors) {
    try {
      if (ed.getModel() === m) ed.revealLine(Math.max(1, line));
    } catch {
      /* editor tearing down */
    }
  }
}

/**
 * Smoothly reveal newText in the model, animating only the changed region:
 * unchanged head is set instantly, new middle lines type out in chunks with
 * the viewport following the frontier, unchanged tail snaps in at the end.
 *
 * Aborts silently if the model is disposed/replaced or the user types
 * meanwhile (caller rebases on its next pass). onDone fires only when the
 * final content lands (or immediately when nothing changed).
 * Returns false when there is no live model for path.
 */
export function streamModelValue(
  path: string,
  newText: string,
  onDone?: () => void,
): boolean {
  const m = models.get(path);
  if (!m || m.isDisposed()) return false;
  cancelStream(path);
  let oldText: string;
  try {
    oldText = m.getValue();
  } catch {
    return false;
  }
  if (oldText === newText) {
    try {
      onDone?.();
    } catch {
      /* ignore */
    }
    return true;
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let from = 0;
  while (
    from < oldLines.length &&
    from < newLines.length &&
    oldLines[from] === newLines[from]
  ) {
    from++;
  }
  let oldSuffix = 0;
  let newSuffix = 0;
  while (
    oldSuffix < oldLines.length - from &&
    newSuffix < newLines.length - from &&
    oldLines[oldLines.length - 1 - oldSuffix] ===
      newLines[newLines.length - 1 - newSuffix]
  ) {
    oldSuffix++;
    newSuffix++;
  }
  const head = newLines.slice(0, from).join("\n");
  const middle = newLines.slice(from, newLines.length - newSuffix);

  const writeAll = (text: string): boolean => {
    try {
      const cur = models.get(path);
      if (!cur || cur !== m || cur.isDisposed()) return false;
      cur.pushEditOperations(
        [],
        [{ range: cur.getFullModelRange(), text }],
        () => null,
      );
      return true;
    } catch {
      return false;
    }
  };

  // Pure deletion / no new lines — single jump, still follow + done.
  if (middle.length === 0) {
    if (!writeAll(newText)) return false;
    followFrontier(m, from + 1);
    try {
      onDone?.();
    } catch {
      /* ignore */
    }
    return true;
  }

  // Silky mode: 1-2 lines per frame, ~30ms cadence, ~1.2s budget.
  const chunk = middle.length <= 24 ? 1 : middle.length <= 120 ? 2 : 8;
  const steps = Math.ceil(middle.length / chunk);
  // User speed multiplier from settings (0.5 slow .. 2 fast).
  let speed = 1;
  try {
    const s = useSettingsStore.getState().streamSpeed;
    if (Number.isFinite(s) && s > 0) speed = s;
  } catch {
    /* defaults */
  }
  const interval = Math.min(180, Math.max(12, Math.round(1100 / steps / speed)));
  let expected = head;
  let i = 0;

  if (!writeAll(head)) return false;
  followFrontier(m, from + 1);

  const step = () => {
    let cur: MonacoEditorNS.ITextModel | undefined;
    try {
      cur = models.get(path);
      if (!cur || cur !== m || cur.isDisposed() || cur.getValue() !== expected) {
        // replaced, closed, or the user typed meanwhile — abort silently
        streamTimers.delete(path);
        return;
      }
    } catch {
      streamTimers.delete(path);
      return;
    }
    i++;
    const shown = middle.slice(0, i * chunk);
    if (i * chunk >= middle.length) {
      streamTimers.delete(path);
      if (!writeAll(newText)) return;
      followFrontier(m, from + middle.length);
      try {
        onDone?.();
      } catch {
        /* ignore */
      }
      return;
    }
    const value = (head ? head + "\n" : "") + shown.join("\n");
    if (!writeAll(value)) return;
    expected = value;
    followFrontier(m, from + shown.length);
    try {
      streamTimers.set(path, window.setTimeout(step, interval));
    } catch {
      streamTimers.delete(path);
    }
  };

  try {
    streamTimers.set(path, window.setTimeout(step, interval));
  } catch {
    streamTimers.delete(path);
    return false;
  }
  return true;
}

/** Smooth-scroll an open tab to a line without stealing focus. */
export function revealPathLine(path: string, line: number): boolean {
  const m = models.get(path);
  if (!m || m.isDisposed()) return false;
  const target = Math.max(1, Math.min(line, m.getLineCount()));
  for (const ed of mountedEditors) {
    try {
      if (ed.getModel() === m) {
        ed.revealLineInCenter(target);
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

const flashDecos = new Map<string, string[]>();

/** Briefly highlight a line range in an open tab (AI edit flash). */
export function flashPathLines(path: string, from: number, to: number) {
  const m = models.get(path);
  if (!m || m.isDisposed()) return;
  const start = Math.max(1, Math.min(from, m.getLineCount()));
  const end = Math.max(start, Math.min(to, m.getLineCount()));
  try {
    const old = flashDecos.get(path) ?? [];
    const next = m.deltaDecorations(old, [
      {
        range: new monaco.Range(start, 1, end, 1),
        options: { isWholeLine: true, className: "ai-stream-line" },
      },
    ]);
    flashDecos.set(path, next);
    window.setTimeout(() => {
      try {
        const cur = flashDecos.get(path) ?? [];
        if (!m.isDisposed()) m.deltaDecorations(cur, []);
        flashDecos.delete(path);
      } catch {
        /* ignore */
      }
    }, 2400);
  } catch {
    /* ignore */
  }
}

const reviewDecos = new Map<string, string[]>();

function reviewDecoList(
  m: MonacoEditorNS.ITextModel,
  hunks: GitHunk[],
): MonacoEditorNS.IModelDeltaDecoration[] {
  const out: MonacoEditorNS.IModelDeltaDecoration[] = [];
  const lineCount = m.getLineCount();
  const clampLine = (n: number) => Math.max(1, Math.min(n, lineCount));
  for (const h of hunks) {
    const added = h.lines.filter((l) => l.kind === "added").length;
    const removed = h.lines.filter((l) => l.kind === "removed");
    const start = h.new_start;
    const end = h.new_start + Math.max(h.new_lines, 0) - 1;
    if (h.new_lines > 0 && added > 0 && start >= 1) {
      // Green: lines the agent added/changed.
      out.push({
        range: new monaco.Range(clampLine(start), 1, clampLine(end), 1),
        options: {
          isWholeLine: true,
          className: "ai-review-added",
          linesDecorationsClassName: "ai-review-added-gutter",
        },
      });
    }
    if (removed.length > 0) {
      // Red: anchor where the agent deleted code + hover with the text.
      const anchor = h.new_lines > 0 ? clampLine(start) : clampLine(Math.max(1, start));
      const quoted = removed
        .slice(0, 40)
        .map((l) => l.text)
        .join("\n");
      out.push({
        range: new monaco.Range(anchor, 1, anchor, 1),
        options: {
          linesDecorationsClassName: "ai-review-removed-gutter",
          hoverMessage: {
            value: `**Удалено агентом:**\n\`\`\`\n${quoted}\n\`\`\``,
          },
        },
      });
    }
  }
  return out;
}

/**
 * Cursor-style inline review highlight for AI-touched lines.
 * Green = added, red gutter marker = deletion point (hover shows text).
 * Pass empty hunks (or another path) to switch; use clear below to remove.
 */
export function setReviewDecorations(path: string, hunks: GitHunk[]) {
  const m = models.get(path);
  if (!m || m.isDisposed()) return;
  try {
    const old = reviewDecos.get(path) ?? [];
    const next = m.deltaDecorations(old, reviewDecoList(m, hunks));
    reviewDecos.set(path, next);
  } catch {
    /* ignore */
  }
}

/** Remove review highlight for one path (or all when omitted). */
export function clearReviewDecorations(path?: string) {
  const paths = path ? [path] : [...reviewDecos.keys()];
  for (const p of paths) {
    try {
      const m = models.get(p);
      const old = reviewDecos.get(p) ?? [];
      if (m && !m.isDisposed()) m.deltaDecorations(old, []);
      reviewDecos.delete(p);
    } catch {
      /* ignore */
    }
  }
}

/** Live (possibly unsaved) content of an open tab, if its model exists. */
export function getModelValue(path: string): string | undefined {  const m = models.get(path);
  if (!m || m.isDisposed()) return undefined;
  try {
    return m.getValue();
  } catch {
    return undefined;
  }
}

interface GutterInfo {
  line: number;
  kind: "added" | "modified" | "removed";
  original: string;
}

interface EditorInstanceProps {
  activePath: string | null;
  onGotoLine?: (line: number) => void;
}

export function EditorInstance({ activePath }: EditorInstanceProps) {
  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const minimap = useSettingsStore((s) => s.minimap);
  const isDark =
    theme === "dark" ||
    theme === "oled" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const { tabs, setDirty, markSaved } = useEditorStore();
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef<(() => void) | null>(null);
  const decoRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(
    null,
  );
  const bpDecoRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(
    null,
  );
  // Stable array ref — re-renders only when breakpoints actually change.
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const gutterRef = useRef<Map<number, GutterInfo>>(new Map());
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    info: GutterInfo;
  } | null>(null);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  // Images preview as photos — never create text models for them.
  const isImageTab = activeTab ? isImageFile(activeTab.name) : false;
  const editorMenu = useEditorMenu(activePath);
  const editorMenuRef = useRef(editorMenu);
  editorMenuRef.current = editorMenu;

  const applyGutter = useCallback((path: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const rr = useEditorStore.getState().repoRoot;
    if (!rr) {
      decoRef.current?.clear();
      gutterRef.current.clear();
      return;
    }
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const hunks = await invoke<GitHunk[]>("git_hunks_workdir", {
          root: rr,
          path,
        });
        const map = new Map<number, GutterInfo>();
        const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [];
        for (const h of hunks) {
          let line = h.new_start;
          // Buffer removals so we can emit modified vs pure added/removed.
          let pendingRemoved: string[] = [];
          const flushRemoved = (atLine: number) => {
            for (const orig of pendingRemoved) {
              const key = atLine * -1 - pendingRemoved.indexOf(orig);
              // Use negative key trick to keep removed entries distinct from line keys.
              map.set(key, { line: atLine, kind: "removed", original: orig });
              decorations.push({
                range: new monaco.Range(atLine, 1, atLine, 1),
                options: { glyphMarginClassName: "git-gutter-removed" },
              });
            }
            pendingRemoved = [];
          };
          for (const l of h.lines) {
            if (l.kind === "removed") {
              pendingRemoved.push(l.text);
            } else if (l.kind === "added") {
              if (pendingRemoved.length > 0) {
                const orig = pendingRemoved.shift()!;
                map.set(line, { line, kind: "modified", original: orig });
                decorations.push({
                  range: new monaco.Range(line, 1, line, 1),
                  options: {
                    glyphMarginClassName: "git-gutter-modified",
                    linesDecorationsClassName: "git-gutter-modified",
                  },
                });
              } else {
                map.set(line, { line, kind: "added", original: l.text });
                decorations.push({
                  range: new monaco.Range(line, 1, line, 1),
                  options: {
                    glyphMarginClassName: "git-gutter-added",
                    linesDecorationsClassName: "git-gutter-added",
                  },
                });
              }
              line += 1;
            } else {
              // context line — any leftover pendingRemoved are pure deletions
              if (pendingRemoved.length > 0) flushRemoved(Math.max(1, line));
              line += 1;
            }
          }
          if (pendingRemoved.length > 0) flushRemoved(Math.max(1, line));
        }
        gutterRef.current = map;
        if (!decoRef.current) {
          decoRef.current = ed.createDecorationsCollection(decorations);
        } else {
          decoRef.current.set(decorations);
        }
      } catch {
        /* not a git file */
      }
    })();
  }, []);

  /** Render breakpoint dots for the current model (own collection). */
  const applyBreakpoints = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || !ready) return;
    const model = ed.getModel();
    if (!model) return;
    const path = [...models.entries()].find(([, m]) => m === model)?.[0];
    if (!path) return;
    const list = useDebugStore.getState().breakpoints.filter((b) => b.path === path);
    const decos = list.map((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        glyphMarginClassName: b.enabled
          ? b.condition
            ? "debug-bp-conditional"
            : "debug-bp"
          : "debug-bp-disabled",
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    try {
      if (!bpDecoRef.current) {
        bpDecoRef.current = ed.createDecorationsCollection(decos);
      } else {
        bpDecoRef.current.set(decos);
      }
    } catch {
      /* editor tearing down */
    }
  }, [ready]);

  useEffect(() => {
    applyBreakpoints();
  }, [applyBreakpoints, activePath, breakpoints]);

  const save = useCallback(async () => {
    const ed = editorRef.current;
    const tab = useEditorStore
      .getState()
      .tabs.find((t) => t.path === useEditorStore.getState().activePath);
    const target = tab?.path ?? activePath;
    if (!ed || !target) return;
    // The editor may be unmounted (e.g. an image-preview tab) while the ref
    // is stale — never write another model's content into this file.
    const model = ed.getModel();
    const modelPath = model
      ? [...models.entries()].find(([, mm]) => mm === model)?.[0]
      : undefined;
    if (!model || modelPath !== target) return;
    const content = model.getValue() ?? "";
    try {
      await writeFile(target, content);
      markSaved(target);
      // Saved content is authoritative — refresh Problems immediately.
      const pending = diagTimers.get(target);
      if (pending) {
        clearTimeout(pending);
        diagTimers.delete(target);
      }
      void import("../../stores/diagnosticsStore").then(({ useDiagnosticsStore }) =>
        useDiagnosticsStore.getState().refreshFile(target).catch(() => {}),
      );
    } catch (e) {
      console.error("save failed", e);
    }
  }, [markSaved, activePath]);

  saveRef.current = () => void save();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Swap model when activePath changes (no editor recreation).
  // Image tabs have no text model — the preview renders instead.
  useEffect(() => {
    if (!ready || !editorRef.current || !activeTab) return;
    if (isImageFile(activeTab.name)) return;
    let cancelled = false;
    (async () => {
      let content = activeTab.dirty
        ? models.get(activeTab.path)?.getValue()
        : undefined;
      if (content === undefined) {
        try {
          content = await readFile(activeTab.path);
        } catch {
          content = "";
        }
      }
      if (cancelled) return;
      const model = getOrCreateModel(activeTab.path, content, activeTab.name);
      editorRef.current?.setModel(model);
      // Self-heal: if the model stayed empty while disk had content
      // (mount race), force it once instead of showing a blank editor.
      try {
        if (content && model.getValue() === "" && !model.isDisposed()) {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: content }],
            () => null,
          );
        }
        editorRef.current?.layout();
      } catch {
        /* ignore */
      }
      if (!cancelled) applyGutter(activeTab.path);
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, activeTab?.path, activeTab?.dirty, ready, applyGutter]);

  useEffect(() => {
    const handler = (e: Event) => {
      const ed = editorRef.current;
      if (!ed) return;
      const d = (e as CustomEvent<number | { line: number; col?: number }>).detail;
      const line = typeof d === "number" ? d : d?.line;
      const col = typeof d === "number" ? 1 : (d?.col ?? 1);
      if (typeof line === "number" && line > 0) {
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: Math.max(1, col) });
        ed.focus();
      }
    };
    window.addEventListener("editor:goto-line", handler);
    return () => window.removeEventListener("editor:goto-line", handler);
  }, []);

  const handleMount: OnMount = (ed) => {
    editorRef.current = ed;
    mountedEditors.add(ed);
    // Attach ONLY an already-loaded model here. Creating an empty one would
    // poison the `models` map: the swap effect below would then return it
    // as-is and the disk content would never land (blank first file).
    // The swap effect (fires on `ready`) creates the model with real content.
    if (activeTab) {
      const existing = models.get(activeTab.path);
      if (existing && !existing.isDisposed()) ed.setModel(existing);
    }
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current?.(),
    );
    ed.onDidChangeModelContent(() => {
      const m = ed.getModel();
      if (!m) return;
      const p = [...models.entries()].find(([, mm]) => mm === m)?.[0];
      if (!p) return;
      setDirty(p, true);
      scheduleDiagRefresh(p);
    });
    // Click on the glyph margin toggles a breakpoint (VS Code parity).
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (line == null) return;
      const m = ed.getModel();
      if (!m) return;
      const p = [...models.entries()].find(([, mm]) => mm === m)?.[0];
      if (!p) return;
      useDebugStore.getState().toggle(p, line);
    });
    // Ctrl+Click (Cmd on macOS) on an import path jumps to the file.
    ed.onMouseDown((e) => {
      const mod = e.event.ctrlKey || e.event.metaKey;
      if (!mod) return;
      if (
        e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      ) {
        return;
      }
      const pos = e.target.position;
      if (!pos) return;
      const m = ed.getModel();
      if (!m) return;
      const lang = m.getLanguageId();
      if (!/^(typescript|javascript|typescriptreact|javascriptreact)$/.test(lang)) return;
      const curPath = [...models.entries()].find(([, mm]) => mm === m)?.[0];
      if (!curPath) return;
      const lineText = m.getLineContent(pos.lineNumber);
      // find the quoted specifier under the cursor: from "x" | import("x") | require("x") | import "x"
      const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)(['"])((?:(?!\1).)+)\1/g;
      let hit: string | null = null;
      for (let mt: RegExpExecArray | null = re.exec(lineText); mt; mt = re.exec(lineText)) {
        const startCol = mt.index + mt[0].indexOf(mt[2]) + 1;
        const endCol = startCol + mt[2].length;
        if (pos.column >= startCol && pos.column <= endCol + 1) {
          hit = mt[2];
          break;
        }
      }
      if (!hit || (!hit.startsWith(".") && !/^[a-zA-Z]:[\\/]/.test(hit) && !hit.startsWith("/"))) {
        return; // bare package import — not resolvable to a workspace file
      }
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const sep = curPath.includes("\\") ? "\\" : "/";
          const dir = curPath.replace(/[\\/][^\\/]+$/, "");
          const norm = (p: string) => p.replace(/\//g, sep);
          const base = /^[a-zA-Z]:[\\/]/.test(hit!) || hit!.startsWith("/")
            ? norm(hit!)
            : norm(`${dir}${sep}${hit}`);
          const cands = [base];
          if (!/\.[a-z0-9]+$/i.test(base)) {
            for (const ext of [".ts", ".tsx", ".js", ".jsx", ".json"]) cands.push(base + ext);
            for (const idx of ["/index.ts", "/index.tsx", "/index.js"]) {
              cands.push(base + idx.replace(/\//g, sep));
            }
          }
          for (const c of cands) {
            try {
              if (await invoke<boolean>("fs_exists", { path: c })) {
                await useEditorStore.getState().openFile(c, { preview: false });
                return;
              }
            } catch {
              /* try next candidate */
            }
          }
        } catch {
          /* navigation unavailable */
        }
      })();
    });
    ed.onMouseMove((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        if (hover) setHover(null);
        return;
      }
      const line = e.target.position?.lineNumber;
      if (line == null) return;
      const info = gutterRef.current.get(line) ?? gutterRef.current.get(line * -1);
      if (info) setHover({ x: e.event.posx, y: e.event.posy, info });
      else if (hover) setHover(null);
    });
    ed.onMouseLeave(() => setHover(null));
    ed.onDidFocusEditorText(() => {
      lastFocused = ed;
    });
    // NOTE: do not clear on blur — clicking a menu blurs the editor first,
    // and Edit actions still need to know which editor was active.
    setReady(true);
    if (activeTab) applyGutter(activeTab.path);
  };

  useEffect(() => {
    // NOTE: read the ref at unmount time — the mount-time snapshot is null
    // (handleMount runs later), and text<->image switches remount the editor.
    return () => {
      const ed = editorRef.current;
      if (ed) {
        mountedEditors.delete(ed);
        if (lastFocused === ed) lastFocused = null;
        editorRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onContextMenu={(e) => {
        // Custom menu over the whole editor, including code text
        // (Monaco's native menu is disabled via `contextmenu: false`).
        e.preventDefault();
        e.stopPropagation();
        useContextMenuStore.getState().show(e.clientX, e.clientY, editorMenuRef.current);
      }}
    >
      <div className="min-h-0 flex-1 animate-[fadeIn_150ms_ease-out]" style={{ background: "#0f0f14" }}>
        {activeTab && isImageTab ? (
          <ImagePreview path={activeTab.path} name={activeTab.name} />
        ) : activeTab ? (
          <Editor
            height="100%"
            theme={monacoTheme(isDark)}
            options={{
              fontFamily:
                "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
              fontSize,
              fontLigatures: true,
              minimap: { enabled: minimap, renderCharacters: false },
              glyphMargin: true,
              folding: true,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "on",
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              formatOnPaste: true,
              formatOnType: true,
              padding: { top: 10 },
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
                useShadows: false,
              },
              // Our own context menu everywhere — never Monaco's native one.
              contextmenu: false,
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
            }}
            onMount={handleMount}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-ui-sm"
            style={{ color: "var(--text-secondary)" }}
          >
            Откройте файл из проводника
          </div>
        )}
      </div>

      {hover && (
        <div
          className="git-gutter-hover"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          <span className="ggh-title">
            {hover.info.kind === "added"
              ? "Добавленная строка"
              : hover.info.kind === "removed"
                ? "Удалённая строка (оригинал)"
                : "Изменённая строка"}
          </span>
          {hover.info.original || "(пустая строка)"}
        </div>
      )}
    </div>
  );
}
