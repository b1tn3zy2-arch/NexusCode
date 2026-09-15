import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Minus, Square, X, Search } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { logInfo } from "../stores/outputStore";
import { VpnDot } from "../components/settings/VpnSection";
import { useEditorStore } from "../stores/editorStore";
import { useServerStore } from "../stores/serverStore";
import { useDebugStore } from "../stores/debugStore";
import { runMenuAction } from "../lib/menuSafe";

const appWindow = getCurrentWebviewWindow();

type MenuItem = {
  label: string;
  shortcut?: string;
  separator?: boolean;
  disabled?: boolean;
  hint?: string;
  action?: () => void | Promise<void>;
};

const dbg = (fn: (m: typeof import("../lib/debugActions")) => void) => () =>
  void import("../lib/debugActions").then((m) => fn(m));

export async function newFileAction() {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({
      title: "New File",
      defaultPath: "untitled.txt",
    });
    if (!picked || typeof picked !== "string") return;
    const { useEditorStore } = await import("../stores/editorStore");
    const parent = picked.replace(/[\\/][^\\/]+$/, "") || picked;
    const name = picked.split(/[\\/]/).pop() ?? picked;
    await useEditorStore.getState().createFile(parent, name);
    logInfo("menu", `Created ${picked}`);
  } catch (e) {
    logInfo("menu", `New File failed: ${String(e)}`);
  }
}

export async function openFolderAction() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") {
      const { useEditorStore } = await import("../stores/editorStore");
      useEditorStore.getState().openFolder(sel);
    }
  } catch {
    /* dialog cancelled */
  }
}

async function editDoc(action: "undo" | "redo" | "cut" | "copy" | "paste") {
  try {
    const { getActiveEditor } = await import("../components/editor/EditorInstance");
    const ed = getActiveEditor();
    if (ed) {
      if (action === "undo") {
        ed.trigger("menu", "undo", null);
        return;
      }
      if (action === "redo") {
        ed.trigger("menu", "redo", null);
        return;
      }
      const id =
        action === "cut"
          ? "editor.action.clipboardCutAction"
          : action === "copy"
            ? "editor.action.clipboardCopyAction"
            : "editor.action.clipboardPasteAction";
      const act = ed.getAction(id);
      if (act) {
        await act.run();
        return;
      }
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    document.execCommand(action);
  } catch {
    /* ignore */
  }
}

const MENU_ITEMS: Record<string, MenuItem[]> = {
  File: [
    { label: "New File", shortcut: "Ctrl+Alt+N", action: () => void newFileAction() },
    { label: "New Chat", shortcut: "Ctrl+N", action: () => void import("../stores/chatStore").then(({ useChatStore }) => useChatStore.getState().createSession()) },
    { label: "Open Folder", shortcut: "Ctrl+O", action: () => void openFolderAction() },
    {
      label: "Save",
      shortcut: "Ctrl+S",
      action: () =>
        void import("../stores/editorStore").then(({ useEditorStore }) =>
          useEditorStore.getState().saveActive(),
        ),
    },
    {
      label: "Save All",
      shortcut: "Ctrl+Shift+S",
      action: () =>
        void import("../stores/editorStore").then(async ({ useEditorStore }) => {
          const n = await useEditorStore.getState().saveAll();
          if (n > 0) logInfo("menu", `Saved ${n} file(s)`);
        }),
    },
    { label: "", separator: true },
    { label: "Exit", shortcut: "Alt+F4", action: () => void appWindow.close() },
  ],
  Edit: [
    { label: "Undo", shortcut: "Ctrl+Z", action: () => void editDoc("undo") },
    { label: "Redo", shortcut: "Ctrl+Y", action: () => void editDoc("redo") },
    { label: "", separator: true },
    { label: "Cut", shortcut: "Ctrl+X", action: () => void editDoc("cut") },
    { label: "Copy", shortcut: "Ctrl+C", action: () => void editDoc("copy") },
    { label: "Paste", shortcut: "Ctrl+V", action: () => void editDoc("paste") },
  ],
  View: [
    {
      label: "Command Palette",
      shortcut: "Ctrl+K",
      action: () => {
        import("../stores/paletteStore").then(({ usePaletteStore }) =>
          usePaletteStore.getState().toggle(),
        );
      },
    },
    {
      label: "Explorer",
      shortcut: "Ctrl+B",
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) =>
          useUiStore.getState().toggleSidebarView("explorer"),
        );
      },
    },
    {
      label: "Search",
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) =>
          useUiStore.getState().setSidebarView("search"),
        );
      },
    },
    {
      label: "Source Control",
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) =>
          useUiStore.getState().setSidebarView("git"),
        );
      },
    },
    {
      label: "AI Panel",
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) => {
          const s = useUiStore.getState();
          s.setAiPanelOpen(!s.aiPanelOpen);
        });
      },
    },
    {
      label: "Toggle Bottom Panel",
      shortcut: "Ctrl+J",
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) =>
          useUiStore.getState().setBottomOpen(!useUiStore.getState().bottomOpen),
        );
      },
    },
  ],
  Go: [
    {
      label: "Go to File",
      shortcut: "Ctrl+P",
      action: () => {
        import("../stores/quickOpenStore").then(({ useQuickOpenStore }) =>
          useQuickOpenStore.getState().toggle(),
        );
      },
    },
    {
      label: "Go to Line",
      shortcut: "Ctrl+G",
      action: () => {
        import("../stores/quickOpenStore").then(({ useQuickOpenStore }) =>
          useQuickOpenStore.getState().openWith(":"),
        );
      },
    },
  ],
  Terminal: [
    {
      label: "New Terminal",
      action: () => {
        import("../stores/terminalStore").then(({ useTerminalStore }) =>
          useTerminalStore.getState().openTerminal(),
        );
      },
    },
    {
      label: "Split Terminal",
      action: () => {
        import("../stores/terminalStore").then(({ useTerminalStore }) =>
          useTerminalStore.getState().splitTerminal(),
        );
      },
    },
  ],
  Help: [
    {
      label: "Documentation",
      action: () => {
        import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
          openUrl("https://opencode.ai").catch(() => {}),
        );
      },
    },
    {
      label: "About",
      action: () => window.dispatchEvent(new CustomEvent("ocgui:open-about")),
    },
  ],
};

const MENU_ORDER = ["File", "Edit", "View", "Go", "Run", "Terminal", "Help"];

const NO_ADAPTER = "Требуется debug-адаптер (скоро)";

function runMenuItems(debugging: boolean, canRestart: boolean): MenuItem[] {
  return [
    { label: "Start Debugging", shortcut: "F5", action: dbg((m) => m.debugStart(false)) },
    { label: "Run Without Debugging", shortcut: "Ctrl+F5", action: dbg((m) => m.debugStart(true)) },
    { label: "Stop Debugging", shortcut: "Shift+F5", disabled: !debugging, action: dbg((m) => m.debugStop()) },
    { label: "Restart Debugging", shortcut: "Ctrl+Shift+F5", disabled: !canRestart, action: dbg((m) => m.debugRestart()) },
    { label: "", separator: true },
    { label: "Open Configurations", action: dbg((m) => m.openLaunchJson()) },
    { label: "Add Configuration…", action: dbg((m) => m.addConfiguration()) },
    { label: "", separator: true },
    { label: "Step Over", shortcut: "F10", disabled: true, hint: NO_ADAPTER },
    { label: "Step Into", shortcut: "F11", disabled: true, hint: NO_ADAPTER },
    { label: "Step Out", shortcut: "Shift+F11", disabled: true, hint: NO_ADAPTER },
    { label: "Continue", disabled: true, hint: NO_ADAPTER },
    { label: "", separator: true },
    { label: "Toggle Breakpoint", shortcut: "F9", action: dbg((m) => m.toggleBreakpointAtCursor()) },
    { label: "New Breakpoint…", action: dbg((m) => m.newBreakpointAtCursor()) },
    { label: "", separator: true },
    {
      label: "Enable All Breakpoints",
      action: () => useDebugStore.getState().setAllEnabled(true),
    },
    {
      label: "Disable All Breakpoints",
      action: () => useDebugStore.getState().setAllEnabled(false),
    },
    {
      label: "Remove All Breakpoints",
      action: () => useDebugStore.getState().removeAll(),
    },
    { label: "", separator: true },
    { label: "Install Python Debugger (debugpy)…", action: dbg((m) => m.installDebugpy()) },
    { label: "Install Python…", action: dbg((m) => m.installPython()) },
  ];
}

function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const serverVersion = useServerStore((s) => s.version);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open ]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,.4)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-[380px] max-w-[92vw] rounded-xl border p-5 shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
      >
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          {t("about.title")}
        </h2>
        <div className="mt-3 space-y-1.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <div className="flex justify-between gap-4">
            <span>{t("about.version")}</span>
            <span className="font-mono" style={{ color: "var(--text-primary)" }}>
              {appVersion ?? "…"}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span>{t("about.server")}</span>
            <span className="font-mono" style={{ color: "var(--text-primary)" }}>
              {serverVersion ? `v${serverVersion}` : "—"}
            </span>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="btn-primary px-4 py-1.5 text-[13px]" onClick={onClose}>
            {t("about.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** VS Code-like command center: active file, click opens QuickOpen. */
function CommandCenter() {
  const open = () =>
    void import("../stores/quickOpenStore").then(({ useQuickOpenStore }) =>
      useQuickOpenStore.getState().toggle(),
    );
  return (
    <button
      className="flex h-7 w-full max-w-[560px] items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 text-[12.5px] text-[#a0a0b0] transition-colors hover:bg-white/10 hover:text-[#f0f0f5]"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={open}
      title="Go to File (Ctrl+P)"
    >
      <Search size={13} className="shrink-0 opacity-70" />
      <CommandCenterLabel />
      <kbd className="shrink-0 rounded border border-white/10 bg-white/5 px-1 text-[10.5px] opacity-70">
        Ctrl+P
      </kbd>
    </button>
  );
}

function CommandCenterLabel() {
  const activePath = useEditorStore((s) => s.activePath);
  const name = activePath ? (activePath.split(/[\\/]/).pop() ?? activePath) : null;
  return <span className="truncate" title={activePath ?? undefined}>{name ?? "NexusCode"}</span>;
}

export function TitleBar() {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const debugging = useDebugStore((s) => s.run !== null);
  const canRestart = useDebugStore(
    (s) => s.run !== null || s.lastCmd !== null,
  );
  const menus: Record<string, MenuItem[]> = {
    ...MENU_ITEMS,
    Run: runMenuItems(debugging, canRestart),
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const onAbout = () => setAboutOpen(true);
    window.addEventListener("ocgui:open-about", onAbout);
    return () => window.removeEventListener("ocgui:open-about", onAbout);
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button === 0) {
      const target = e.target as HTMLElement;
      if (target.closest(".window-controls")) return;
      void appWindow.startDragging();
    }
  };

  const barMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".window-controls")) return;
    e.preventDefault();
    e.stopPropagation();
    void import("../lib/ctx").then(({ showCtx }) =>
      showCtx(e, [
        { id: "min", label: "Свернуть", action: () => void appWindow.minimize() },
        { id: "max", label: "Развернуть", action: () => void appWindow.toggleMaximize() },
        { id: "sep1", label: "", sep: true },
        {
          id: "palette",
          label: "Палитра команд",
          hint: "Ctrl+K",
          action: () =>
            void import("../stores/paletteStore").then(({ usePaletteStore }) =>
              usePaletteStore.getState().toggle(),
            ),
        },
        {
          id: "settings",
          label: t("settings.title", "Настройки"),
          hint: "Ctrl+,",
          action: () => window.dispatchEvent(new CustomEvent("ocgui:open-settings")),
        },
        {
          id: "about",
          label: t("about.title", "О приложении"),
          action: () => setAboutOpen(true),
        },
        { id: "sep2", label: "", sep: true },
        { id: "close", label: "Закрыть окно", danger: true, action: () => void appWindow.close() },
      ]),
    );
  };

  return (
    <>
      <div
        className="h-9 flex items-center select-none bg-[#1a1a23] border-b border-white/5 shrink-0"
        onContextMenu={barMenu}
      >
        <div className="flex items-center gap-3 px-3 h-full" ref={menuRef}>
          <div className="flex items-center gap-2 cursor-default" onMouseDown={startDrag}>
            <svg width={16} height={16} viewBox="0 0 1024 1024" aria-hidden className="shrink-0">
              <defs>
                <linearGradient id="nc-title" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#4f46e5" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
              <rect width="1024" height="1024" rx="220" fill="url(#nc-title)" />
              <circle cx="300" cy="700" r="95" fill="#fff" />
              <circle cx="724" cy="324" r="95" fill="#fff" />
              <text x="300" y="712" textAnchor="middle" dominantBaseline="middle" fontFamily="Geist Variable, sans-serif" fontWeight="800" fontSize="150" fill="#4f46e5">N</text>
              <text x="724" y="336" textAnchor="middle" dominantBaseline="middle" fontFamily="Geist Variable, sans-serif" fontWeight="800" fontSize="150" fill="#4f46e5">C</text>
            </svg>
            <span className="text-sm font-semibold text-[#f0f0f5]">NexusCode</span>
          </div>
          <div className="flex items-center gap-0.5 text-[13px] text-[#a0a0b0]">
            {MENU_ORDER.map((item) => (
              <div key={item} className="relative">
                <span
                  onClick={() => setOpenMenu(openMenu === item ? null : item)}
                  className={`cursor-pointer px-2 py-1 rounded transition-colors block ${
                    openMenu === item
                      ? "bg-white/10 text-[#f0f0f5]"
                      : "hover:bg-white/5 hover:text-[#f0f0f5]"
                  }`}
                >
                  {item}
                </span>
                <AnimatePresence>
                {openMenu === item && (
                  <motion.div
                    key="menu-pop"
                    initial={{ opacity: 0, scale: 0.97, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97, y: -4 }}
                    transition={{ duration: 0.13, ease: "easeOut" }}
                    style={{ transformOrigin: "top left" }}
                    className="absolute top-full left-0 mt-1 min-w-[220px] bg-[#1e1e2e] border border-white/10 rounded-lg shadow-2xl py-1 z-[100]"
                  >
                    {menus[item].map((sub, idx) =>
                      sub.separator ? (
                        <div key={idx} className="my-1 border-t border-white/10" />
                      ) : (
                        <div
                          key={idx}
                          title={sub.hint}
                          onClick={() => {
                            if (sub.disabled) return;
                            runMenuAction(sub.action, sub.label);
                            setOpenMenu(null);
                          }}
                          className={`pressable flex items-center justify-between px-3 py-2 text-[13px] transition-colors ${
                            sub.disabled
                              ? "text-[#606070] cursor-default"
                              : "text-[#f0f0f5] hover:bg-[#6366f1]/20 hover:text-white cursor-pointer"
                          }`}
                        >
                          <span>{sub.label}</span>
                          {sub.shortcut && <span className="text-[11px] text-[#606070] ml-4">{sub.shortcut}</span>}
                        </div>
                      ),
                    )}
                  </motion.div>
                )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-0 h-full flex items-center justify-center gap-2" onMouseDown={startDrag}>
          <CommandCenter />
          <span
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => window.dispatchEvent(new CustomEvent("ocgui:open-settings"))}
            title="VPN — открыть настройки"
            className="cursor-pointer rounded p-1 hover:bg-white/10"
          >
            <VpnDot size={9} />
          </span>
        </div>
        <div className="window-controls flex items-center h-full shrink-0">
          <button
            onClick={() => void appWindow.minimize()}
            className="group h-full w-11 flex items-center justify-center text-[#a0a0b0] hover:bg-white/10 hover:text-[#f0f0f5] transition-all duration-150 active:scale-95"
            title="Minimize"
          >
            <Minus size={14} className="transition-transform duration-150 group-hover:scale-110" />
          </button>
          <button
            onClick={() => void appWindow.toggleMaximize()}
            className="group h-full w-11 flex items-center justify-center text-[#a0a0b0] hover:bg-white/10 hover:text-[#f0f0f5] transition-all duration-150 active:scale-95"
            title="Maximize"
          >
            <Square size={12} className="transition-transform duration-150 group-hover:scale-110" />
          </button>
          <button
            onClick={() => void appWindow.close()}
            className="group h-full w-11 flex items-center justify-center text-[#a0a0b0] hover:bg-red-500/80 hover:text-white transition-all duration-150 active:scale-95"
            title="Close"
          >
            <X size={14} className="transition-transform duration-150 group-hover:scale-110 group-hover:rotate-90" />
          </button>
        </div>
      </div>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}
