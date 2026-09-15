import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./i18n";
import { applyTheme } from "./stores/settingsStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useServerStore } from "./stores/serverStore";
import { useChatStore } from "./stores/chatStore";
import { usePermissionStore, type PendingPermission } from "./stores/permissionStore";
import { useLoopStore } from "./stores/loopStore";
import { useContStore } from "./stores/contStore";
import type { LoopSnapshot, ContinuousSnapshot } from "./services/backend";
import type { OcEvent } from "./types/opencode";

import { ActivityBar } from "./layout/ActivityBar";
import { SidebarHost } from "./layout/SidebarHost";
import { EditorArea } from "./layout/EditorArea";
import { AIPanel } from "./layout/AIPanel";
import { BottomPanel } from "./layout/BottomPanel";
import { TitleBar, newFileAction, openFolderAction } from "./layout/TitleBar";
import { AnimatedWidth } from "./components/AnimatedPanel";
import { DebugToolbar } from "./components/DebugToolbar";
import { runMenuAction } from "./lib/menuSafe";
import { stopReasonText } from "./lib/stopReasons";
import { Toasts } from "./components/Toasts";
import { PermissionDialog } from "./components/PermissionDialog";
const DiffModal = lazy(() =>
  import("./components/editor/DiffModal").then((m) => ({ default: m.DiffModal })),
);
const AiReviewModal = lazy(() =>
  import("./components/editor/AiReviewModal").then((m) => ({ default: m.AiReviewModal })),
);
// On-demand dialogs stay out of the initial bundle (opened via shortcuts).
const QuickOpen = lazy(() =>
  import("./components/QuickOpen").then((m) => ({ default: m.QuickOpen })),
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
import { usePaletteStore } from "./stores/paletteStore";
import { useQuickOpenStore } from "./stores/quickOpenStore";
import { useUiStore } from "./stores/uiStore";
import { KNOWN_MODELS } from "./lib/models";
import { useResizable } from "./hooks/useResizable";
import { logInfo, logWarn, logError } from "./stores/outputStore";
import { useEditorStore } from "./stores/editorStore";
import { langFromName, languageLabel } from "./lib/languages";
import { LanguagePicker } from "./components/LanguagePicker";
import { AiFileFollow } from "./components/AiFileFollow";
import { useAiFollowStore } from "./stores/aiFollowStore";
import { Eye, EyeOff } from "lucide-react";
import { ContextMenuHost } from "./components/ContextMenuHost";
import { useContextMenuStore } from "./stores/contextMenuStore";
import { useAppMenu } from "./components/menus";
import { AutoReview } from "./components/editor/AutoReview";

interface OcPermissionPayload {
  kind: "request" | "resolved" | "replied";
  request?: PendingPermission;
  decision?: string;
  auto?: boolean;
  permissionID?: string;
}

export default function App() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const theme = useSettingsStore((s) => s.theme);
  const animations = useSettingsStore((s) => s.animations);
  const status = useServerStore((s) => s.status);
  const sidebarView = useUiStore((s) => s.sidebarView);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const sidebarResizable = useResizable(
    (() => {
      try {
        const v = localStorage.getItem("nexuscode-sidebar-width");
        return v ? Math.min(400, Math.max(200, parseInt(v, 10))) : 280;
      } catch {
        return 280;
      }
    })(),
    200,
    400,
    "left",
  );
  const aiResizable = useResizable(
    (() => {
      try {
        const v = localStorage.getItem("nexuscode-ai-width");
        return v ? Math.min(900, Math.max(300, parseInt(v, 10))) : 360;
      } catch {
        return 360;
      }
    })(),
    280,
    900,
    "right",
  );
  useEffect(() => {
    try {
      localStorage.setItem("nexuscode-sidebar-width", String(sidebarResizable.width));
    } catch {}
  }, [sidebarResizable.width]);
  useEffect(() => {
    try {
      localStorage.setItem("nexuscode-ai-width", String(aiResizable.width));
    } catch {}
  }, [aiResizable.width]);

  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1920);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Compact mode: auto-collapse side panels on narrow windows, restoring
  // them when space returns (manual closes are respected, never forced).
  const autoAiRef = useRef(false);
  const autoSideRef = useRef(false);
  useEffect(() => {
    const ui = useUiStore.getState();
    if (windowWidth < 1100) {
      if (ui.aiPanelOpen && !autoAiRef.current) {
        autoAiRef.current = true;
        ui.setAiPanelOpen(false);
      }
    } else if (autoAiRef.current) {
      autoAiRef.current = false;
      ui.setAiPanelOpen(true);
    }
    if (windowWidth < 900) {
      if (ui.sidebarView !== null && !autoSideRef.current) {
        autoSideRef.current = true;
        ui.setSidebarView(null);
      }
    } else if (autoSideRef.current) {
      autoSideRef.current = false;
      if (ui.sidebarView === null) ui.setSidebarView("explorer");
    }
    // Manual reopen while narrow: stop fighting the user until next resize.
    if (windowWidth < 1100 && ui.aiPanelOpen) autoAiRef.current = false;
    if (windowWidth < 900 && ui.sidebarView !== null) autoSideRef.current = false;
  }, [windowWidth]);

  // Global right-click fallback: custom menu everywhere. Text fields get
  // the edit menu; zones with their own menu stop propagation before us.
  const appMenu = useAppMenu();
  const appMenuRef = useRef(appMenu);
  appMenuRef.current = appMenu;
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof Element)) return;
      if (t.closest(".monaco-editor")) return;
      if (t.closest("select, [contenteditable='true']")) return;
      const field = t.closest("input, textarea") as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (field && !field.disabled) {
        e.preventDefault();
        e.stopPropagation();
        void import("./lib/ctx").then(({ textAreaMenu }) =>
          textAreaMenu(e, []),
        );
        return;
      }
      e.preventDefault();
      useContextMenuStore.getState().show(e.clientX, e.clientY, appMenuRef.current);
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Clamp panel widths so sidebars never squeeze the editor out.
  // Reserve at least 220px for the center editor + 48px activity bar.
  const ACTIVITY_W = 48;
  const MIN_EDITOR = 220;
  const availForPanels = Math.max(0, windowWidth - ACTIVITY_W - MIN_EDITOR);
  let sidebarEff = Math.min(sidebarResizable.width, 400);
  let aiEff = Math.min(aiResizable.width, 900);
  // Cap each panel to a share of available space on narrow windows.
  if (windowWidth < 1400) {
    sidebarEff = Math.min(sidebarEff, Math.max(200, Math.floor(availForPanels * 0.35)));
    aiEff = Math.min(aiEff, Math.max(280, Math.floor(availForPanels * 0.6)));
  }
  // If both still don't fit, scale down proportionally.
  const totalPanels = (sidebarView !== null ? sidebarEff : 0) + (aiPanelOpen ? aiEff : 0);
  if (totalPanels > availForPanels && totalPanels > 0) {
    const scale = availForPanels / totalPanels;
    if (sidebarView !== null) sidebarEff = Math.max(180, Math.floor(sidebarEff * scale));
    if (aiPanelOpen) aiEff = Math.max(260, Math.floor(aiEff * scale));
  }

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(useSettingsStore.getState().theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // ---- event bridges ----
  useEffect(() => {
    // Coalesce chat events per animation frame: bursts (e.g. an agent
    // reading 20 files in a second) apply in one batch instead of
    // re-rendering 20 times. 16ms lag is imperceptible.
    const chatQueue: OcEvent[] = [];
    let chatFlushScheduled = false;
    const flushChatQueue = () => {
      chatFlushScheduled = false;
      if (chatQueue.length === 0) return;
      const batch = chatQueue.splice(0, chatQueue.length);
      const apply = useChatStore.getState().applyEvent;
      for (const p of batch) apply(p);
    };
    const unlistenPromise = listen<OcEvent>("oc-event", (e) => {
      const payload = e.payload;
      const type = (payload as { type?: string })?.type ?? "unknown";
      if (type.startsWith("bridge.")) {
        const reason = (payload as { properties?: { reason?: unknown } })?.properties?.reason;
        if (type === "bridge.fatal") logError("bridge", `fatal: ${String(reason ?? "stream failed")}`);
        else if (type === "bridge.disconnected") logWarn("bridge", `disconnected: ${String(reason ?? "stream ended")}`);
        else logInfo("bridge", type);
      } else if (type === "session.error") {
        const props = (payload as { properties?: Record<string, unknown> })?.properties ?? {};
        const err = props.error ?? props.message ?? type;
        const text = typeof err === "string" ? err : JSON.stringify(err);
        // Self-inflicted abort is not an error — don't scare the user.
        if (/abort/i.test(text)) {
          logInfo("server", "остановлено пользователем");
        } else {
          logError("server", text);
        }
      }
      chatQueue.push(payload);
      if (!chatFlushScheduled) {
        chatFlushScheduled = true;
        requestAnimationFrame(flushChatQueue);
      }
    });
    const unlistenPermPromise = listen<OcPermissionPayload>(
      "oc-permission",
      (e) => {
        const p = e.payload;
        const perm = usePermissionStore.getState();
        if (p.kind === "request" && p.request) {
          perm.pushPending(p.request);
          logWarn("permissions", `request: ${p.request.kind ?? "permission"} ${p.request.title ?? p.request.id}`);
        } else if (p.kind === "resolved") {
          if (p.request) {
            perm.removePending(p.request.id);
            if (p.auto) void perm.refreshLog();
            logInfo("permissions", `resolved: ${p.decision ?? "done"}${p.auto ? " (auto)" : ""}`);
          }
        } else if (p.kind === "replied" && p.permissionID) {
          perm.removePending(p.permissionID);
          logInfo("permissions", `replied: ${p.permissionID}`);
        }
      },
    );
    // NOTE: oc-loop/oc-continuous carry BOTH full snapshots AND bare event
    // fragments ({type: "iteration_complete", ...} with no history/steps).
    // Blindly setSnapshot() with a fragment wipes the arrays and red-screens
    // the panels on the next `.length` read — route by shape instead.
    const unlistenLoopPromise = listen<LoopSnapshot>("oc-loop", (e) => {
      const p = e.payload as Partial<LoopSnapshot> & { type?: string };
      if (!p || typeof p !== "object") return;
      const st = useLoopStore.getState();
      if (Array.isArray((p as LoopSnapshot).history)) {
        const prev = st.snapshot.lastError;
        const prevNotice = st.snapshot.notice;
        const prevStop = st.snapshot.stopReason;
        st.setSnapshot(p as LoopSnapshot);
        const next = (p as LoopSnapshot).lastError;
        if (next && next !== prev) logError("loop", next);
        const notice = (p as LoopSnapshot).notice;
        if (notice && notice !== prevNotice) logWarn("loop", notice);
        const stop = (p as LoopSnapshot).stopReason;
        if (stop) logInfo("loop", `stopped: ${stop}`);
        if (stop && !prevStop && stop !== "user" && stop !== "stopped") {
          void import("./lib/notify").then(({ notifyDone }) =>
            notifyDone("Loop: готово", stopReasonText(stop)),
          );
        }
      } else {
        st.patchFromEvent(p);
      }
    });
    const unlistenContPromise = listen<ContinuousSnapshot>(
      "oc-continuous",
      (e) => {
        const p = e.payload as Partial<ContinuousSnapshot> & { type?: string };
        if (!p || typeof p !== "object") return;
        const st = useContStore.getState();
        if (Array.isArray((p as ContinuousSnapshot).steps)) {
          const prev = st.snapshot.lastError;
          const prevStop = st.snapshot.stopReason;
          st.setSnapshot(p as ContinuousSnapshot);
          const next = (p as ContinuousSnapshot).lastError;
          if (next && next !== prev) logError("continuous", next);
          const stop = (p as ContinuousSnapshot).stopReason;
          if (stop) logInfo("continuous", `stopped: ${stop}`);
          if (stop && !prevStop && stop !== "user" && stop !== "stopped") {
            void import("./lib/notify").then(({ notifyDone }) =>
              notifyDone("Continuous: готово", stopReasonText(stop)),
            );
          }
        } else {
          st.patchFromEvent(p);
        }
      },
    );
    return () => {
      flushChatQueue();
      void unlistenPromise.then((un) => un());
      void unlistenPermPromise.then((un) => un());
      void unlistenLoopPromise.then((un) => un());
      void unlistenContPromise.then((un) => un());
    };
  }, []);

  // ---- boot (orchestrated in serverStore; retries share one run) ----
  const boot = () => useServerStore.getState().boot();

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-run Python: unpack bundled interpreter + debugger in the
  // background, once. python/debugpy then work out of the box.
  useEffect(() => {
    let dead = false;
    const KEY = "nexuscode-py-autosetup";
    void (async () => {
      try {
        if (localStorage.getItem(KEY)) return;
        const { bundledStatus } = await import("./lib/shell");
        const st = await bundledStatus().catch(() => null);
        // Nothing to do: no bundle shipped, or already installed.
        if (!st || !st.available || st.installed) {
          try {
            localStorage.setItem(KEY, "1");
          } catch {
            /* ignore */
          }
          return;
        }
        const [{ toast }, { logInfo }] = await Promise.all([
          import("./stores/toastStore"),
          import("./stores/outputStore"),
        ]);
        if (dead) return;
        toast.info("Первый запуск: распаковываю встроенный Python…");
        logInfo("python", "first-run bundled setup started");
        const { invoke } = await import("@tauri-apps/api/core");
        const bin = await invoke<string>("setup_bundled_python");
        if (dead) return;
        try {
          localStorage.setItem(KEY, "1");
        } catch {
          /* ignore */
        }
        logInfo("python", `bundled python ready: ${bin}`);
        toast.success("Встроенный Python готов (pip + отладчик внутри)");
      } catch (e) {
        if (dead) return;
        try {
          const { logWarn } = await import("./stores/outputStore");
          logWarn("python", `bundled setup skipped: ${String(e)}`);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  // ---- shortcuts ----
  useEffect(() => {
    const dbg = (fn: (m: typeof import("./lib/debugActions")) => void) =>
      runMenuAction(
        () => import("./lib/debugActions").then((m) => fn(m)),
        "Debug",
      );
    const onKey = (e: KeyboardEvent) => {
      // Debug function keys (skip inside the terminal so the TUI keeps them).
      const inTerm = !!(e.target as HTMLElement | null)?.closest?.(".xterm");
      if (!inTerm && (e.key === "F5" || e.key === "F9")) {
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.key === "F5" && !ctrl && !e.shiftKey) {
          e.preventDefault();
          void import("./stores/debugStore").then(({ useDebugStore }) => {
            if (useDebugStore.getState().run) {
              logInfo("debug", "Continue требует debug-адаптер (скоро)");
            } else {
              dbg((m) => m.debugStart(false));
            }
          });
          return;
        }
        if (e.key === "F5" && ctrl && !e.shiftKey) {
          e.preventDefault();
          dbg((m) => m.debugStart(true));
          return;
        }
        if (e.key === "F5" && e.shiftKey && !ctrl) {
          e.preventDefault();
          dbg((m) => m.debugStop());
          return;
        }
        if (e.key === "F5" && ctrl && e.shiftKey) {
          e.preventDefault();
          dbg((m) => m.debugRestart());
          return;
        }
        if (e.key === "F9" && !ctrl && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          dbg((m) => m.toggleBreakpointAtCursor());
          return;
        }
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        usePaletteStore.getState().toggle();
      } else if (k === "p") {
        e.preventDefault();
        useQuickOpenStore.getState().toggle();
      } else if (k === "b") {
        e.preventDefault();
        const ui = useUiStore.getState();
        ui.setSidebarView(ui.sidebarView === null ? "explorer" : null);
      } else if (k === "j") {
        e.preventDefault();
        const ui = useUiStore.getState();
        ui.setBottomOpen(!ui.bottomOpen);
      } else if (k === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void useChatStore.getState().createSession();
      } else if (k === "n" && e.altKey && !e.shiftKey) {
        e.preventDefault();
        void newFileAction();
      } else if (k === "o" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void openFolderAction();
      } else if (k === "s" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        void useEditorStore.getState().saveAll().then((n) => {
          if (n > 0) logInfo("menu", `Saved ${n} file(s)`);
        });
      } else if (k === "g" && !e.shiftKey && !e.altKey) {
        // Outside Monaco: Go to Line via QuickOpen. Inside Monaco the
        // editor's own Ctrl+G handles it.
        const inMonaco = !!(e.target as HTMLElement | null)?.closest?.(".monaco-editor");
        if (!inMonaco) {
          e.preventDefault();
          useQuickOpenStore.getState().openWith(":");
        }
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    const onOpenSettings = () => setSettingsOpen(true);
    window.addEventListener("ocgui:open-settings", onOpenSettings);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ocgui:open-settings", onOpenSettings);
    };
  }, []);

  // In-app animation master switch: ON forces animations even when the
  // OS reports reduced motion; OFF kills them regardless of the OS.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("anim-force", animations);
    root.classList.toggle("anim-off", !animations);
  }, [animations]);

  return (
    <MotionConfig reducedMotion={animations ? "never" : "always"}>
    <div className="flex h-full flex-col">
      {windowWidth < 620 && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 p-8 text-center">
          <div className="rounded-lg bg-[#1a1a23] p-6">
            <h2 className="text-lg font-semibold">Window too small</h2>
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
              Minimum width is 620px. Please enlarge the window.
            </p>
          </div>
        </div>
      )}
      <TitleBar />
      <DebugToolbar />

      {/* main zones — floating cards with gaps, resizable with 4px handles */}
      <div className="flex min-h-0 min-w-0 flex-1 gap-1.5 overflow-hidden p-1.5">
        <ActivityBar />
        <AnimatedWidth
          open={sidebarView !== null}
          width={sidebarEff}
          minWidth={180}
          maxWidth="45vw"
          instant={sidebarResizable.dragging}
          className="flex min-w-0 max-w-full shrink-0"
        >
          <div className="flex min-w-0 min-h-0 flex-1 overflow-hidden">
            <SidebarHost />
          </div>
          <div
            className="group flex w-[4px] shrink-0 cursor-col-resize items-center justify-center bg-transparent hover:bg-[var(--accent-500)]/10 transition-colors"
            onMouseDown={sidebarResizable.onMouseDown}
            title="Drag to resize"
          >
            <div className="h-full w-[1px] bg-[var(--border-subtle)] group-hover:bg-[var(--accent-500)] group-hover:w-[2px] group-active:w-[3px] group-active:bg-[var(--accent-500)]/60 transition-all" />
          </div>
        </AnimatedWidth>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
          <EditorArea />
          <BottomPanel />
        </div>
        <AnimatedWidth
          open={aiPanelOpen}
          width={aiEff}
          minWidth={260}
          maxWidth="50vw"
          instant={aiResizable.dragging}
          className="flex min-w-0 max-w-full shrink-0"
        >
          <div
            className="group flex w-[4px] shrink-0 cursor-col-resize items-center justify-center bg-transparent hover:bg-[var(--accent-500)]/10 transition-colors"
            onMouseDown={aiResizable.onMouseDown}
            title="Drag to resize"
          >
            <div className="h-full w-[1px] bg-[var(--border-subtle)] group-hover:bg-[var(--accent-500)] group-hover:w-[2px] group-active:w-[3px] group-active:bg-[var(--accent-500)]/60 transition-all" />
          </div>
          <div className="flex min-w-0 min-h-0 flex-1 overflow-hidden">
            <AIPanel onClose={() => useUiStore.getState().setAiPanelOpen(false)} />
          </div>
        </AnimatedWidth>
      </div>

      <PermissionDialog />
      <Suspense fallback={null}>
        <DiffModal />
        <AiReviewModal />
      </Suspense>
      <AutoReview />
      <Suspense fallback={null}>
        <CommandPalette />
        <QuickOpen />
      </Suspense>
      <AiFileFollow />
      <ContextMenuHost />
      <Toasts />

      <StatusBarLite onOpenSettings={() => setSettingsOpen(true)} />

      <Suspense fallback={null}>
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            void boot();
          }}
        />
      </Suspense>

      {status === "error" && !settingsOpen && (
        <button
          className="fixed right-4 bottom-10 z-40 rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-red-600"
          onClick={() => setSettingsOpen(true)}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {t("settings.title")}
          </div>
        </button>
        )}
    </div>
    </MotionConfig>
  );
}

function StatusBarLite({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const status = useServerStore((s) => s.status);
  const port = useServerStore((s) => s.port);
  const version = useServerStore((s) => s.version);
  const error = useServerStore((s) => s.error);
  const lang = useSettingsStore((s) => s.lang);
  const theme = useSettingsStore((s) => s.theme);

  const workDir = useSettingsStore((s) => s.workDir);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeId);
  const currentModelId = selectedModel ?? sessions.find((s) => s.id === activeId)?.model?.id;
  const modelInfo = currentModelId ? KNOWN_MODELS.find((m) => m.id === currentModelId) : null;
  const dot =
    status === "running"
      ? "var(--success)"
      : status === "starting"
        ? "var(--warning)"
        : status === "error"
          ? "var(--error)"
          : "var(--text-tertiary)";

  const onStatusMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ui = useUiStore.getState();
    void import("./lib/ctx").then(({ showCtx }) =>
      showCtx(e, [
        {
          id: "settings",
          label: t("settings.title"),
          hint: "Ctrl+,",
          action: () => onOpenSettings(),
        },
        {
          id: "sidebar",
          label: "Explorer",
          hint: "Ctrl+B",
          action: () =>
            ui.setSidebarView(ui.sidebarView === null ? "explorer" : null),
        },
        {
          id: "bottom",
          label: "Toggle Bottom Panel",
          hint: "Ctrl+J",
          action: () => ui.setBottomOpen(!ui.bottomOpen),
        },
        {
          id: "ai",
          label: "AI Panel",
          action: () => ui.setAiPanelOpen(!ui.aiPanelOpen),
        },
        { id: "s1", label: "", sep: true },
        {
          id: "copy-ver",
          label: t("status.copyVersion", "Копировать версию"),
          action: () =>
            void import("./lib/clipboard").then(({ copyText }) =>
              copyText(
                `NexusCode ${version ?? "?"} · server ${status}${port ? ` :${port}` : ""} · ${useSettingsStore.getState().mode} · ${workDir}`,
              ),
            ),
        },
      ]),
    );
  };

  return (
    <footer
      className="flex h-[26px] shrink-0 items-center gap-3 border-t px-3 text-[12px]"
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-secondary)",
        color: "var(--text-secondary)",
      }}
      onContextMenu={onStatusMenu}
    >
      <button
        className="flex items-center gap-1.5 transition-all hover:opacity-80 active:scale-95"
        onClick={onOpenSettings}
        title={t("settings.title")}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: dot }}
        />
        {error
          ? `${t("status.error")}: ${error.slice(0, 50)}`
          : t(`status.${status}`)}
        {port && status === "running" ? ` ·:${port}` : ""}
      </button>

      <span className="min-w-0 flex-1 truncate text-center" title={workDir}>
        {workDir}
      </span>

      {modelInfo && (
        <span
          className="hidden items-center gap-1 md:inline-flex"
          title={`${modelInfo.provider} · ${modelInfo.maxTokens ?? ""}${modelInfo.vision ? " · 👁️ vision" : ""}${modelInfo.cost ? ` · ${modelInfo.cost}` : ""}${modelInfo.description ? ` — ${modelInfo.description}` : ""}`}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: modelInfo.tag === "free" ? "#22c55e" : modelInfo.tag === "local" ? "#3b82f6" : "#eab308" }} />
          {modelInfo.label} · {modelInfo.maxTokens}
          {modelInfo.vision ? " · 👁️" : ""}
        </span>
      )}

      <span>{lang.toUpperCase()}</span>
      <FollowToggle />
      <FileLanguageButton />
      <span title={t("settings.theme")}>
        {theme === "system" ? "SYS" : theme === "dark" ? "DARK" : theme === "oled" ? "OLED" : "LIGHT"}
      </span>
      <span>{version ? `v${version}` : ""}</span>
    </footer>
  );
}

function FollowToggle() {
  const { t } = useTranslation();
  const enabled = useAiFollowStore((s) => s.enabled);
  const setEnabled = useAiFollowStore((s) => s.setEnabled);
  const followedPath = useAiFollowStore((s) => s.followedPath);
  return (
    <button
      className="flex items-center hover:text-[var(--accent)]"
      style={enabled ? { color: "var(--accent-400)" } : undefined}
      title={enabled ? t("ai.followOn") : t("ai.followOff")}
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      {enabled && followedPath ? (
        <span className="ml-1 max-w-[160px] truncate font-mono text-[11px]" title={followedPath}>
          {followedPath.split(/[\\/]/).pop()}
        </span>
      ) : null}
      <span className="sr-only">{t("ai.follow")}</span>
    </button>
  );
}

function FileLanguageButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const activePath = useEditorStore((s) => s.activePath);
  const tabs = useEditorStore((s) => s.tabs);
  const overrides = useEditorStore((s) => s.langOverrides);
  const activeTab = tabs.find((x) => x.path === activePath) ?? null;
  if (!activeTab) return null;
  const currentId = overrides[activeTab.path] ?? langFromName(activeTab.name);
  return (
    <>
      <button
        className="hover:text-[var(--accent)]"
        title={t("editor.languageTitle")}
        onClick={() => setOpen(true)}
      >
        {languageLabel(currentId)}
      </button>
      <LanguagePicker open={open} onClose={() => setOpen(false)} />
    </>
  );
}
