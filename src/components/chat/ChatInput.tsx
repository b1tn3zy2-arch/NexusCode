import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTranslation } from "react-i18next";
import { Paperclip, Camera, X, Square, SendHorizontal, Scissors, Copy, ClipboardPaste, Trash2, Send, OctagonX, BookOpenText, Plus } from "lucide-react";
import { VoiceButton } from "./VoiceButton";
/* NOTE: Monaco loads lazily — lib/monaco (workers, loader, theme) is pulled
   in by the lazy editor below, never statically here. */
const ChatMonacoEditor = lazy(() =>
  import("../../lib/monaco").then(() =>
    import("@monaco-editor/react").then((m) => ({ default: m.default })),
  ),
);
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useServerStore } from "../../stores/serverStore";
import { logError } from "../../stores/outputStore";
import { imagesApi, type PreparedImage } from "../../services/backend";
import type { ImageAttachment } from "../../types/opencode";
import { useMentions } from "../../hooks/useMentions";
import { MentionPopup } from "./MentionPopup";
import { usePromptStore } from "../../stores/promptStore";

const POPUP_H = 250;

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

async function fileToB64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Downscale huge screenshots so IPC + prepare stay fast. Returns original on failure. */
async function fitImage(file: File, maxDim = 2048): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width <= maxDim && bmp.height <= maxDim) {
      bmp.close();
      return file;
    }
    const scale = maxDim / Math.max(bmp.width, bmp.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close();
      return file;
    }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const out: Blob | null = await new Promise((res) =>
      canvas.toBlob((b) => res(b), "image/png"),
    );
    return out ?? file;
  } catch {
    return file;
  }
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

export function ChatInput() {
  const { t } = useTranslation();
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef<number>(-1);
  const [hasText, setHasText] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const activeId = useChatStore((s) => s.activeId);
  const busy = useChatStore((s) =>
    activeId ? (s.busy[activeId] ?? false) : false,
  );
  const serverStatus = useServerStore((s) => s.status);
  const theme = useSettingsStore((s) => s.theme);
  const mode = useSettingsStore((s) => s.mode);

  const mention = useMentions();

  const addPrepared = useCallback(
    (p: PreparedImage, name?: string) => {
      setImages((prev) => [
        ...prev,
        {
          id: uid(),
          mime: p.mime,
          width: p.width,
          height: p.height,
          size: p.size,
          b64: p.data_b64,
          name,
        },
      ]);
    },
    [],
  );

  // ---- drag & drop -------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const un = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (disposed) return;
      if (event.payload.type === "over") {
        setDragOver(true);
      } else if (event.payload.type === "leave") {
        setDragOver(false);
      } else {
        setDragOver(false);
        const imgPaths = event.payload.paths.filter((p) => IMAGE_EXT.test(p));
        void (async () => {
          setBusyAction(true);
          try {
            for (const p of imgPaths) {
              addPrepared(await imagesApi.readFile(p), baseName(p));
            }
          } catch (e) {
            console.error("drop load failed", e);
          } finally {
            setBusyAction(false);
          }
        })();
      }
    });
    return () => {
      disposed = true;
      void un.then((f) => f());
    };
  }, [addPrepared]);

  // ---- actions -----------------------------------------------------------
  const canSend = mode === "native" ? serverStatus === "running" : false;
  const canSendRef = useRef(canSend);
  const busyRef = useRef(busy);
  const doSendRef = useRef<() => void>(() => {});
  useEffect(() => {
    canSendRef.current = canSend;
  }, [canSend]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const doSend = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || busy || !canSend) return;
    if (mention.isActive()) return;
    const text = editor.getValue().trim();
    if (!text && images.length === 0) return;

    historyRef.current.unshift(text);
    if (historyRef.current.length > 100) historyRef.current.pop();
    historyPosRef.current = -1;

    void send(text, images);
    // Pre-run repo snapshot lives in chatStore.send (awaited there so it
    // can't race the agent's first write).
    editor.setValue("");
    mention.close();
    setImages([]);
    setHasText(false);
    editor.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, images, send, canSend]);

  // keep ref in sync for Monaco handlers
  doSendRef.current = doSend;

  // fallback global Enter handler if Monaco swallows the event (e.g. IME)
  useEffect(() => {
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const ed = editorRef.current;
      if (!ed || !ed.hasTextFocus()) return;
      if (mention.isActive()) return;
      if (!canSendRef.current || busyRef.current) return;
      const text = ed.getValue().trim();
      if (!text && images.length === 0) return;
      // only if Monaco didn't already handle it - check if event target is inside monaco
      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest(".monaco-editor")) return;
      e.preventDefault();
      doSendRef.current();
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, [images]);

  const cycleHistory = useCallback(
    (dir: -1 | 1) => {
      const editor = editorRef.current;
      if (!editor || mention.isActive()) return;
      if (historyRef.current.length === 0) return;
      const max = historyRef.current.length - 1;
      let pos = historyPosRef.current + dir;
      pos = Math.max(-1, Math.min(max, pos));
      historyPosRef.current = pos;
      const value = pos === -1 ? "" : historyRef.current[pos];
      if (editor.getValue() !== value) {
        editor.setValue(value);
        editor.setScrollTop(0);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectMention = useCallback(async () => {
    const editor = editorRef.current;
    const sel = mention.current();
    if (!editor || !sel) return false;
    const pos = editor.getPosition();
    if (!pos) return false;
    const { monaco } = await import("../../lib/monaco");
    editor.executeEdits("mention", [
      {
        range: new monaco.Range(
          sel.state.lineNumber,
          sel.state.startColumn,
          pos.lineNumber,
          pos.column,
        ),
        text: `${sel.state.trigger}${sel.item.insert} `,
      },
    ]);
    mention.close();
    editor.focus();
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attachFiles = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    setBusyAction(true);
    try {
      for (const p of paths) {
        if (typeof p !== "string") continue;
        addPrepared(await imagesApi.readFile(p), baseName(p));
      }
    } finally {
      setBusyAction(false);
    }
  }, [addPrepared]);

  const takeScreenshot = useCallback(async () => {
    setBusyAction(true);
    try {
      const shot = await imagesApi.captureScreen();
      addPrepared(
        shot,
        `screenshot-${new Date().toISOString().slice(11, 19)}.jpg`,
      );
    } catch (e) {
      console.error("screenshot failed", e);
    } finally {
      setBusyAction(false);
    }
  }, [addPrepared]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const dt = e.clipboardData;
      const files: File[] = [];
      // 1) DataTransferItems (kind=file, image/*) — Win+Shift+S, browser copy
      for (const it of Array.from(dt.items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      // 2) FileList fallback — some WebView2 builds put images only here
      if (files.length === 0) {
        for (const f of Array.from(dt.files)) {
          if (f.type.startsWith("image/")) files.push(f);
        }
      }
      // 3) Async clipboard fallback — getAsFile() can return null in WebView2
      if (files.length === 0) {
        try {
          const nav = navigator as Navigator & {
            clipboard?: { read?: () => Promise<ClipboardItem[]> };
          };
          const items = await nav.clipboard?.read?.();
          for (const item of items ?? []) {
            const type = item.types.find((mt) => mt.startsWith("image/"));
            if (!type) continue;
            const blob = await item.getType(type);
            files.push(
              new File([blob], `pasted-${Date.now()}.png`, { type: blob.type || type }),
            );
          }
        } catch {
          /* clipboard.read denied — ignore */
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setBusyAction(true);
      try {
        for (const file of files) {
          const fitted = await fitImage(file);
          const b64 = await fileToB64(fitted);
          addPrepared(
            await imagesApi.prepare(b64),
            file.name || `pasted-${Date.now()}.png`,
          );
        }
      } catch (err) {
        console.error("paste image failed", err);
        const msg = t("chat.pasteFailed", `Не вставилось: ${String(err)}`);
        logError("chat", msg);
        useChatStore.getState().setError({ message: msg });
      } finally {
        setBusyAction(false);
      }
    },
    [addPrepared, t],
  );

  // Catch paste globally: Monaco's onPaste doesn't bubble to our div, and
  // pasting with focus outside the input used to silently do nothing.
  // Images can't go anywhere else useful, so route them all to the chat.
  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      if (e.defaultPrevented) return;
      const hasImage = Array.from(e.clipboardData.files).some((f) => f.type.startsWith("image/")) ||
        Array.from(e.clipboardData.items).some((i) => i.kind === "file" && i.type.startsWith("image/"));
      if (!hasImage) return;
      // re-dispatch as React event
      void handlePaste(e as unknown as React.ClipboardEvent);
    };
    window.addEventListener("paste", onWindowPaste as unknown as EventListener);
    return () =>
      window.removeEventListener("paste", onWindowPaste as unknown as EventListener);
  }, [handlePaste]);

  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const popupStyle = (() => {
    if (popupPos.top > POPUP_H + 30) {
      return { top: popupPos.top - POPUP_H - 10, left: popupPos.left };
    }
    return { top: popupPos.top + 28, left: popupPos.left };
  })();

  return (
    <div
      className="shrink-0 border-t px-3 pb-3 pt-2.5"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-secondary)" }}
    >
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img) => (
            <div
              key={img.id}
              className="group relative overflow-hidden rounded-lg border"
              style={{
                borderColor: "var(--border-default)",
                boxShadow: "0 1px 2px rgba(0,0,0,.35)",
              }}
              title={`${img.name ?? ""} ${img.width}×${img.height} · ${(img.size / 1024).toFixed(0)}KB`}
            >
              <img
                src={`data:${img.mime};base64,${img.b64}`}
                alt={img.name ?? "attachment"}
                className="h-16 w-24 object-cover"
              />
              <span
                className="absolute inset-x-0 bottom-0 truncate px-1 py-px text-center text-[10px] text-white/90"
                style={{ background: "rgba(0,0,0,.55)" }}
              >
                {img.name ?? `${img.width}×${img.height}`}
              </span>
              <button
                className="absolute right-1 top-1 hidden rounded-full bg-black/70 p-0.5 text-white hover:bg-black/90 group-hover:block"
                onClick={() =>
                  setImages((prev) => prev.filter((x) => x.id !== img.id))
                }
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="relative overflow-hidden rounded-2xl border transition-all duration-150 focus-within:shadow-[0_0_0_3px_rgba(99,102,241,.18),0_4px_16px_rgba(0,0,0,.35)]"
        style={{
          borderColor: dragOver ? "var(--accent)" : "var(--border-default)",
          background: dragOver
            ? "color-mix(in srgb, var(--accent) 8%, var(--bg-tertiary))"
            : "var(--bg-tertiary)",
          boxShadow: "0 1px 2px rgba(0,0,0,.3)",
        }}
        onPaste={(e) => void handlePaste(e)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const ed = editorRef.current;
          const edit = (id: string) => ed?.trigger("ctx-menu", id, null);
          void import("../../lib/ctx").then(({ showCtx }) =>
            showCtx(e, [
              { id: "cut", label: t("ctx.cut", "Вырезать"), hint: "Ctrl+X", icon: <Scissors size={14} />, action: () => edit("editor.action.clipboardCutAction") },
              { id: "copy", label: t("ctx.copy", "Копировать"), hint: "Ctrl+C", icon: <Copy size={14} />, action: () => edit("editor.action.clipboardCopyAction") },
              { id: "paste", label: t("ctx.paste", "Вставить"), hint: "Ctrl+V", icon: <ClipboardPaste size={14} />, action: () => edit("editor.action.clipboardPasteAction") },
              { id: "select-all", label: t("ctx.selectAll", "Выделить всё"), hint: "Ctrl+A", action: () => edit("editor.action.selectAll") },
              {
                id: "clear",
                label: t("chat.clearInput", "Очистить"),
                icon: <Trash2 size={14} />,
                action: () => {
                  ed?.setValue("");
                  setImages([]);
                  setHasText(false);
                },
              },
              { id: "sep1", label: "", sep: true },
              busy
                ? { id: "stop", label: t("chat.stop", "Остановить"), icon: <OctagonX size={14} />, action: () => void abort() }
                : { id: "send", label: t("chat.send", "Отправить"), hint: "Enter", icon: <Send size={14} />, action: () => doSendRef.current() },
              {
                id: "attach",
                label: t("chat.attachFile", "Прикрепить файл"),
                icon: <Paperclip size={14} />,
                action: () => void attachFiles(),
              },
              {
                id: "screenshot",
                label: t("chat.screenshot", "Скриншот"),
                icon: <Camera size={14} />,
                action: () => void takeScreenshot(),
              },
            ]),
          );
        }}
      >
        <MentionPopup
          state={mention.state}
          top={popupStyle.top}
          left={popupStyle.left}
          onSelect={() => void selectMention()}
          onHover={mention.setIndex}
        />

        <Suspense
          fallback={
            <div className="h-[120px] animate-pulse rounded" style={{ background: "var(--bg-quaternary)" }} />
          }
        >
        <ChatMonacoEditor
          height="120px"          defaultLanguage="markdown"
          language="markdown"
          theme={dark ? "nexus-dark" : "vs"}
          options={{
            minimap: { enabled: false },
            lineNumbers: "off",
            lineNumbersMinChars: 0,
            folding: false,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: 13.5,
            fontFamily:
              "'JetBrains Mono', 'Cascadia Code', Consolas, 'Segoe UI', monospace",
            padding: { top: 10, bottom: 10 },
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            acceptSuggestionOnEnter: "off",
            tabCompletion: "off",
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
            unicodeHighlight: { ambiguousCharacters: false },
            bracketPairColorization: { enabled: false },
            dragAndDrop: false,
            contextmenu: false,
          }}
          onMount={(editor, m) => {
            editorRef.current = editor;

            editor.addCommand(m.KeyMod.Alt | m.KeyCode.UpArrow, () =>
              cycleHistory(-1),
            );
            editor.addCommand(m.KeyMod.Alt | m.KeyCode.DownArrow, () =>
              cycleHistory(1),
            );

            editor.onKeyDown((e) => {
              // mention popup has priority
              if (mention.isActive()) {
                if (e.keyCode === m.KeyCode.Escape) {
                  e.preventDefault();
                  e.stopPropagation();
                  mention.close();
                  return;
                }
                if (e.keyCode === m.KeyCode.Enter) {
                  e.preventDefault();
                  e.stopPropagation();
                  void selectMention();
                  return;
                }
                if (e.keyCode === m.KeyCode.UpArrow && !e.altKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  mention.move(-1);
                  return;
                }
                if (e.keyCode === m.KeyCode.DownArrow && !e.altKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  mention.move(1);
                  return;
                }
              }
              // Enter without Shift = send, Shift+Enter = newline (default)
              if (e.keyCode === m.KeyCode.Enter && !e.browserEvent.shiftKey) {
                if (!canSendRef.current || busyRef.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                const text = editor.getValue().trim();
                if (!text && images.length === 0) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                doSendRef.current();
              }
            });

            const syncCursor = () => {
              const model = editor.getModel();
              const pos = editor.getPosition();
              setHasText(editor.getValue().length > 0);
              if (!model || !pos) {
                mention.close();
                return;
              }
              const lineText = model.getLineContent(pos.lineNumber);
              mention.updateFromCursor(lineText, pos.lineNumber, pos.column);

              if (mention.state.active) {
                const vp = editor.getScrolledVisiblePosition({
                  lineNumber: mention.state.lineNumber,
                  column: mention.state.startColumn,
                });
                if (vp) {
                  setPopupPos({ top: vp.top, left: Math.max(0, vp.left) });
                }
              }
            };

            editor.onDidChangeModelContent(syncCursor);
            editor.onDidChangeCursorPosition(syncCursor);
            editor.onDidBlurEditorText(() => {
              window.setTimeout(() => {
                if (!editor.hasTextFocus()) mention.close();
              }, 150);
            });

            syncCursor();
            editor.focus();
          }}
        />
        </Suspense>

        {!hasText && (
          <div
            className="pointer-events-none absolute left-4 top-3 z-10 select-none text-[13.5px]"
            style={{ color: "var(--text-secondary)", opacity: 0.75 }}
          >
            {/* short placeholder — full hint is in the bar below to avoid duplication */}
            {t("chat.placeholder").split(" — ")[0].split(" Enter")[0]}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <VoiceButton
          onTranscript={(text) => {
            const editor = editorRef.current;
            if (!editor) return;
            const current = editor.getValue();
            editor.setValue(current ? `${current} ${text}` : text);
            editor.focus();
            editor.setPosition({
              lineNumber: editor.getModel()?.getLineCount() ?? 1,
              column: (editor.getModel()?.getLineMaxColumn(
                editor.getModel()?.getLineCount() ?? 1,
              ) ?? 0) + 1,
            });
          }}
        />
        <span
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 truncate text-[12px]"
          style={{ color: "var(--text-secondary)", opacity: 0.85 }}
        >
          <Hint kbd="Enter" label="отправить" />
          <Hint kbd="Shift+Enter" label="новая строка" />
          <Hint kbd="@" label="файл" />
          <Hint kbd="#" label="символ" />
          <Hint kbd="Alt+Up/Down" label="история" />
          {mode === "pty" && (
            <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-px text-[11px] font-medium text-amber-400/90">
              чат недоступен в PTY — переключитесь в Native
            </span>
          )}
        </span>

        <PromptLibraryButton
          getText={() => editorRef.current?.getValue() ?? ""}
          setText={(v) => {
            editorRef.current?.setValue(v);
            setHasText(v.trim().length > 0);
            editorRef.current?.focus();
          }}
        />
        <button
          title={t("input.attach")}
          className="shrink-0 rounded-lg p-2 transition-colors hover:bg-white/5 disabled:opacity-40"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => void attachFiles()}
          disabled={busyAction}
        >
          <Paperclip size={16} />
        </button>
        <button
          title={t("input.shot")}
          className="shrink-0 rounded-lg p-2 transition-colors hover:bg-white/5 disabled:opacity-40"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => void takeScreenshot()}
          disabled={busyAction}
        >
          <Camera size={16} />
        </button>

        {busy ? (
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-red-500/50 px-4 py-2 text-[13px] font-semibold text-red-500 transition-all hover:bg-red-500/10 active:scale-[.98]"
            onClick={() => void abort()}
          >
            <Square size={12} /> {t("chat.stop")}
          </button>
        ) : (
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] px-5 py-2 text-[13px] font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:brightness-110 active:scale-[.98] disabled:opacity-40 disabled:shadow-none"
            onClick={doSend}
            title={!canSend && mode === "pty" ? "Переключитесь в Native API (Настройки → Подключение)" : undefined}
            disabled={(!hasText && images.length === 0) || !canSend}
          >
            {t("chat.send")} <SendHorizontal size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function PromptLibraryButton({
  getText,
  setText,
}: {
  getText: () => string;
  setText: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [saveTitle, setSaveTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [varFor, setVarFor] = useState<string | null>(null);
  const [varVals, setVarVals] = useState<Record<string, string>>({});
  const items = usePromptStore((s) => s.items);

  // dynamic to keep ChatInput's initial bundle lean
  const store = () => import("../../stores/promptStore");

  const filtered = items.filter(
    (p) =>
      !q.trim() ||
      p.title.toLowerCase().includes(q.trim().toLowerCase()) ||
      p.body.toLowerCase().includes(q.trim().toLowerCase()),
  );

  const insert = (body: string, id: string) => {
    void store().then(({ fillVars, usePromptStore }) => {
      setText(fillVars(body, varVals));
      usePromptStore.getState().bumpUse(id);
      setOpen(false);
      setVarFor(null);
      setVarVals({});
    });
  };

  return (
    <div className="relative shrink-0">
      <button
        title="Библиотека промптов"
        className="rounded-lg p-2 transition-colors hover:bg-white/5"
        style={{ color: "var(--text-secondary)" }}
        onClick={() => {
          setOpen((v) => !v);
          setQ("");
          setSaving(false);
          setVarFor(null);
        }}
      >
        <BookOpenText size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="anim-pop-in absolute bottom-full right-0 z-50 mb-2 flex max-h-[320px] w-[300px] flex-col overflow-hidden rounded-xl border shadow-2xl"
            style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
          >
            <div className="flex items-center gap-1.5 border-b p-2" style={{ borderColor: "var(--border-subtle)" }}>
              <input
                autoFocus
                className="input-field min-w-0 flex-1 !py-1 text-[13px]"
                placeholder="Поиск…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button
                className="rounded-md p-1.5 hover:bg-[var(--hover)]"
                title="Сохранить текущий текст"
                onClick={() => {
                  const cur = getText().trim();
                  if (!cur) return;
                  setSaving((v) => !v);
                  setSaveTitle("");
                }}
              >
                <Plus size={14} />
              </button>
            </div>
            {saving && (
              <div className="flex items-center gap-1.5 border-b p-2" style={{ borderColor: "var(--border-subtle)" }}>
                <input
                  className="input-field min-w-0 flex-1 !py-1 text-[13px]"
                  placeholder="Название…"
                  value={saveTitle}
                  onChange={(e) => setSaveTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const cur = getText().trim();
                    if (!cur) return;
                    void store().then(({ usePromptStore }) => {
                      usePromptStore.getState().add(saveTitle || cur.slice(0, 40), cur);
                      setSaving(false);
                      setSaveTitle("");
                    });
                  }}
                />
                <button
                  className="btn-primary px-2.5 py-1 text-[12px]"
                  onClick={() => {
                    const cur = getText().trim();
                    if (!cur) return;
                    void store().then(({ usePromptStore }) => {
                      usePromptStore.getState().add(saveTitle || cur.slice(0, 40), cur);
                      setSaving(false);
                      setSaveTitle("");
                    });
                  }}
                >
                  OK
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {filtered.length === 0 && (
                <p className="px-2 py-3 text-center text-xs" style={{ color: "var(--text-secondary)" }}>
                  Пусто. Напишите текст и нажмите + чтобы сохранить.
                </p>
              )}
              {filtered.map((p) => (
                <PromptRow
                  key={p.id}
                  p={p}
                  varFor={varFor}
                  varVals={varVals}
                  setVarFor={setVarFor}
                  setVarVals={setVarVals}
                  onInsert={insert}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PromptRow({
  p,
  varFor,
  varVals,
  setVarFor,
  setVarVals,
  onInsert,
}: {
  p: { id: string; title: string; body: string; uses: number };
  varFor: string | null;
  varVals: Record<string, string>;
  setVarFor: (id: string | null) => void;
  setVarVals: (v: Record<string, string>) => void;
  onInsert: (body: string, id: string) => void;
}) {
  const [vars, setVars] = useState<string[] | null>(null);
  const openVars = varFor === p.id;

  const pick = () => {
    void import("../../stores/promptStore").then(({ extractVars }) => {
      const v = extractVars(p.body);
      if (v.length === 0) {
        onInsert(p.body, p.id);
      } else {
        setVars(v);
        setVarVals(Object.fromEntries(v.map((k) => [k, ""])));
        setVarFor(p.id);
      }
    });
  };

  return (
    <div
      className="rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--hover)]"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void import("../../lib/ctx").then(({ showCtx }) =>
          showCtx(e, [
            {
              id: "insert",
              label: "Вставить",
              action: pick,
            },
            {
              id: "delete",
              label: "Удалить",
              danger: true,
              action: () =>
                void import("../../stores/promptStore").then(({ usePromptStore }) =>
                  usePromptStore.getState().remove(p.id),
                ),
            },
          ]),
        );
      }}
    >
      <div className="flex cursor-pointer items-center gap-2" onClick={pick}>
        <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
        {p.uses > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            ×{p.uses}
          </span>
        )}
      </div>
      <div className="truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
        {p.body.slice(0, 80)}
      </div>
      {openVars && vars && (
        <div className="mt-1.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {vars.map((k) => (
            <input
              key={k}
              className="input-field w-full !py-1 font-mono text-[12px]"
              placeholder={`{{${k}}}`}
              value={varVals[k] ?? ""}
              onChange={(e) => setVarVals({ ...varVals, [k]: e.target.value })}
            />
          ))}
          <button className="btn-primary w-full py-1 text-[12px]" onClick={() => onInsert(p.body, p.id)}>
            Вставить
          </button>
        </div>
      )}
    </div>
  );
}

function Hint({ kbd, label }: { kbd: string; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
      <kbd
        className="rounded border px-1 py-px font-mono text-[10.5px] leading-tight"
        style={{
          borderColor: "var(--border-default)",
          background: "var(--bg-quaternary)",
          color: "var(--text-primary)",
        }}
      >
        {kbd}
      </kbd>
      <span className="truncate">{label}</span>
    </span>
  );
}
