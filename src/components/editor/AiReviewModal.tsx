import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Columns2, RotateCcw, X } from "lucide-react";
import { monaco, monacoTheme } from "../../lib/monaco";
import { readFile } from "../../stores/editorStore";
import { checkpointsApi } from "../../lib/checkpoints";
import { toast } from "../../stores/toastStore";
import { logWarn } from "../../stores/outputStore";

function isDark(): boolean {
  try {
    return !document.documentElement.classList.contains("theme-light");
  } catch {
    return true;
  }
}

export interface ReviewRequest {
  sessionId: string;
  checkpointId: string;
  /** repo-relative paths (as stored in pendingReview) */
  files: string[];
}

type FileState = "pending" | "accepted" | "rejected";

/**
 * Cursor-style AI review: side-by-side diff (checkpoint vs now) per file,
 * Accept / Reject per file, Ctrl+Enter / Ctrl+Backspace hotkeys.
 * Accept keeps the code, Reject restores the pre-run version.
 */
export function AiReviewModal() {
  const { t } = useTranslation();
  const [req, setReq] = useState<ReviewRequest | null>(null);
  const [states, setStates] = useState<Record<string, FileState>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const stateRef = useRef({ req, states, current, busy });
  stateRef.current = { req, states, current, busy };

  // ---- open / close ----
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<ReviewRequest>).detail;
      if (d?.sessionId && d?.checkpointId && Array.isArray(d.files)) {
        const init: Record<string, FileState> = {};
        for (const f of d.files) init[f] = "pending";
        setStates(init);
        setCurrent(d.files[0] ?? null);
        setBusy(false);
        setReq(d);
      }
    };
    window.addEventListener("nc:open-review", onOpen);
    return () => window.removeEventListener("nc:open-review", onOpen);
  }, []);

  const close = useCallback(() => {
    setReq(null);
    setCurrent(null);
    void import("./EditorInstance").then(({ clearReviewDecorations }) =>
      clearReviewDecorations(),
    ).catch(() => {});
  }, []);

  const decideCount = useMemo(() => {
    const vals = Object.values(states);
    return {
      done: vals.filter((v) => v !== "pending").length,
      total: vals.length,
    };
  }, [states]);

  const finishIfDone = useCallback(
    (next: Record<string, FileState>, sessionId: string) => {
      const vals = Object.values(next);
      if (vals.length > 0 && vals.every((v) => v !== "pending")) {
        void import("../../stores/chatStore").then(({ useChatStore }) =>
          useChatStore.getState().dismissReview(sessionId),
        ).catch(() => {});
        toast.success(t("review.allAccepted", "Ревью завершено"));
        close();
        return true;
      }
      return false;
    },
    [close, t],
  );

  const nextPending = useCallback(
    (next: Record<string, FileState>, after: string | null) => {
      const keys = Object.keys(next);
      if (keys.length === 0) return;
      const from = after ? keys.indexOf(after) : -1;
      for (let i = 1; i <= keys.length; i++) {
        const k = keys[(from + i) % keys.length];
        if (next[k] === "pending") {
          setCurrent(k);
          return;
        }
      }
    },
    [],
  );

  // ---- per-file actions ----
  const acceptFile = useCallback(async () => {
    const { req: r, states: st, current: cur, busy: b } = stateRef.current;
    if (!r || !cur || b || st[cur] !== "pending") return;
    const next = { ...st, [cur]: "accepted" as FileState };
    setStates(next);
    if (!finishIfDone(next, r.sessionId)) nextPending(next, cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishIfDone, nextPending]);

  const rejectFile = useCallback(async () => {
    const { req: r, states: st, current: cur, busy: b } = stateRef.current;
    if (!r || !cur || b || st[cur] !== "pending") return;
    const { useSettingsStore } = await import("../../stores/settingsStore");
    const rootDir = useSettingsStore.getState().workDir;
    if (!rootDir) {
      toast.error(t("review.noRoot", "Нет открытой папки"));
      return;
    }
    setBusy(true);
    try {
      const info = await checkpointsApi.file(rootDir, r.checkpointId, cur);
      if (!info.existed) {
        const ok = window.confirm(
          t("review.deleteNewConfirm", `Файл «${cur}» создан агентом. Удалить его?`),
        );
        if (!ok) {
          setBusy(false);
          return;
        }
      }
      await checkpointsApi.restoreFile(rootDir, r.checkpointId, cur);
      // Sync an open tab with the restored disk state.
      const abs = `${rootDir.replace(/[\\/]+$/, "")}/${cur}`;
      try {
        const { getModelValue, setModelValue } = await import("./EditorInstance");
        const { useEditorStore } = await import("../../stores/editorStore");
        const ed = useEditorStore.getState();
        if (info.existed) {
          const disk = await readFile(abs).catch(() => info.content);
          if (getModelValue(abs) !== undefined) setModelValue(abs, disk);
          ed.markSaved(abs);
        } else {
          await ed.closeTab(abs);
        }
        const { useDiagnosticsStore } = await import("../../stores/diagnosticsStore");
        if (info.existed) {
          await useDiagnosticsStore.getState().refreshFile(abs).catch(() => {});
        }
      } catch {
        /* model sync is best-effort */
      }
      const next = { ...st, [cur]: "rejected" as FileState };
      setStates(next);
      toast.success(t("review.rejected", "Файл возвращён"));
      if (!finishIfDone(next, r.sessionId)) {
        nextPending(next, cur);
        // Force the diff effect below to reload the now-clean file.
        setReloadKey((k) => k + 1);
      }
    } catch (e) {
      logWarn("review", String(e));
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishIfDone, nextPending, t]);

  const acceptAll = useCallback(async () => {
    const { req: r, busy: b } = stateRef.current;
    if (!r || b) return;
    const next: Record<string, FileState> = {};
    for (const k of Object.keys(stateRef.current.states)) next[k] = "accepted";
    setStates(next);
    finishIfDone(next, r.sessionId);
    toast.success(t("review.kept", "Изменения приняты"));
  }, [finishIfDone, t]);

  // ---- hotkeys (modal scope only) ----
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void acceptFile();
        return;
      }
      if (mod && e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        void rejectFile();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req, close, acceptFile, rejectFile]);

  // ---- load diff for current file ----
  // (reloadKey forces a refresh after Reject restores the file)
  useEffect(() => {
    if (!req || !current || !boxRef.current) return;
    let dead = false;
    setLoading(true);
    void (async () => {
      try {
        const { useSettingsStore } = await import("../../stores/settingsStore");
        const rootDir = useSettingsStore.getState().workDir;
        const [{ getModelValue }, { useEditorStore }] = await Promise.all([
          import("./EditorInstance"),
          import("../../stores/editorStore"),
        ]);
        const abs = rootDir
          ? `${rootDir.replace(/[\\/]+$/, "")}/${current}`
          : current;
        // Open in background so inline decorations have a model to attach to.
        if (rootDir) {
          await useEditorStore.getState().openFile(abs, { preview: true }).catch(() => {});
        }
        const [cp, hunks] = await Promise.all([
          rootDir
            ? checkpointsApi.file(rootDir, req.checkpointId, current).catch(() => ({ existed: false as boolean, content: "" }))
            : Promise.resolve({ existed: false as boolean, content: "" }),
          rootDir
            ? checkpointsApi.hunks(rootDir, req.checkpointId, current)
            : Promise.resolve([]),
        ]);
        if (dead) return;
        try {
          const { setReviewDecorations } = await import("./EditorInstance");
          setReviewDecorations(abs, hunks);
        } catch {
          /* decorations are best-effort */
        }
        const live = getModelValue(abs);
        let disk = "";
        try {
          disk = await readFile(abs);
        } catch {
          disk = "";
        }
        if (dead) return;
        const modified = typeof live === "string" ? live : disk;
        const name = current.split(/[\\/]/).pop() ?? current;
        const { langFromName } = await import("../../lib/languages");
        const lang = langFromName(name) ?? "plaintext";
        const tag = `${req.checkpointId}-${current}`.replace(/[^a-zA-Z0-9]/g, "_");
        const origModel = monaco.editor.createModel(
          cp.content,
          lang,
          monaco.Uri.parse(`ncreview://original/${tag}`),
        );
        const modModel = monaco.editor.createModel(
          modified,
          lang,
          monaco.Uri.parse(`ncreview://modified/${tag}`),
        );
        if (dead) {
          origModel.dispose();
          modModel.dispose();
          return;
        }
        // Dispose the previous diff editor AND its models (disposing the
        // editor alone leaks the two text models).
        try {
          const prevHolder = diffRef.current as unknown as {
            __models?: monaco.editor.ITextModel[];
          } | null;
          const prevModels = prevHolder?.__models ?? [];
          try {
            diffRef.current?.dispose();
          } catch {
            /* ignore */
          }
          for (const m of prevModels) {
            try {
              m.dispose();
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        diffRef.current = monaco.editor.createDiffEditor(boxRef.current!, {
          theme: monacoTheme(isDark()),
          readOnly: true,
          renderSideBySide: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          contextmenu: false,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
        });
        diffRef.current.setModel({ original: origModel, modified: modModel });
        (diffRef.current as unknown as { __models?: monaco.editor.ITextModel[] }).__models = [origModel, modModel];
      } catch (e) {
        if (!dead) {
          logWarn("review", String(e));
        }
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
      try {
        const holder = diffRef.current as unknown as { __models?: monaco.editor.ITextModel[] } | null;
        holder?.__models?.forEach((m) => {
          try {
            m.dispose();
          } catch {
            /* ignore */
          }
        });
        diffRef.current?.dispose();
      } catch {
        /* ignore */
      }
      diffRef.current = null;
    };
  }, [req, current, reloadKey]);

  // Clear decorations when fully closed.
  useEffect(() => {
    if (!req) {
      void import("./EditorInstance").then(({ clearReviewDecorations }) =>
        clearReviewDecorations(),
      ).catch(() => {});
    }
  }, [req]);

  const files = useMemo(() => (req ? req.files : []), [req]);
  if (!req) return null;
  const decided = decideCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="anim-pop-in flex max-h-full w-[1200px] max-w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)", height: "84vh" }}
      >
        {/* header */}
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <Columns2 className="h-4 w-4 shrink-0" style={{ color: "var(--accent-400)" }} />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {t("review.modalTitle", "Ревью изменений агента")}{" "}
            <span style={{ color: "var(--text-tertiary)" }}>
              {decided.done}/{decided.total}
            </span>
          </span>
          <button
            className="btn-secondary px-2.5 py-1 text-xs"
            disabled={busy}
            onClick={() => void acceptAll()}
            title="Ctrl+Enter — принять текущий, эта кнопка — принять всё"
          >
            <Check className="h-3.5 w-3.5" /> {t("review.acceptAll", "Принять всё")}
          </button>
          <button className="icon-btn !p-1" title="Esc" onClick={close}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* file list */}
          <div className="w-56 shrink-0 overflow-y-auto border-r p-2" style={{ borderColor: "var(--border-subtle)" }}>
            {files.map((f) => {
              const st = states[f] ?? "pending";
              return (
                <button
                  key={f}
                  onClick={() => setCurrent(f)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--hover)]"
                  style={{
                    background: f === current ? "var(--ai-subtle)" : undefined,
                  }}
                  title={f}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background:
                        st === "accepted"
                          ? "#22c55e"
                          : st === "rejected"
                            ? "#f87171"
                            : "var(--text-tertiary)",
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{f.split(/[\\/]/).pop()}</span>
                </button>
              );
            })}
          </div>

          {/* diff */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[12px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
              <span className="min-w-0 flex-1 truncate font-mono" title={current ?? ""}>{current}</span>
              {loading && <span>{t("review.loading", "Загрузка…")}</span>}
            </div>
            <div ref={boxRef} className="min-h-0 flex-1" />
            {/* per-file actions */}
            <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2" style={{ borderColor: "var(--border-subtle)" }}>
              <button
                className="btn-primary flex-1 py-1.5"
                disabled={busy || !current || states[current ?? ""] !== "pending"}
                onClick={() => void acceptFile()}
                title="Ctrl+Enter"
              >
                <Check className="h-4 w-4" /> {t("review.acceptFile", "Принять файл")} <kbd className="ml-1 opacity-60">Ctrl+Enter</kbd>
              </button>
              <button
                className="btn-secondary flex-1 py-1.5 !border-red-500/50 !text-red-400 hover:!bg-red-500/10"
                disabled={busy || !current || states[current ?? ""] !== "pending"}
                onClick={() => void rejectFile()}
                title="Ctrl+Backspace"
              >
                <RotateCcw className="h-4 w-4" /> {t("review.rejectFile", "Вернуть файл")} <kbd className="ml-1 opacity-60">Ctrl+Backspace</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function openReview(req: ReviewRequest) {
  window.dispatchEvent(new CustomEvent("nc:open-review", { detail: req }));
}
