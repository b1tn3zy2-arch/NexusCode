import { useTranslation } from "react-i18next";
import {
  Scissors,
  Copy,
  ClipboardPaste,
  CornerDownLeft,
  Command,
  Search,
  Settings,
  FolderOpen,
  FilePlus,
  Plus,
  Columns2,
  X,
  PanelBottom,
  PanelRight,
  Sparkles,
} from "lucide-react";
import type { TFunction } from "i18next";
import type { CtxItem } from "../stores/contextMenuStore";
import { copyText, readClipboardText } from "../lib/clipboard";

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function relPathOf(root: string, path: string): string {
  const normRoot = root.replace(/[\\/]+$/, "").replace(/^[/\\]+/, "");
  const norm = path.replace(/^[/\\]+/, "");
  if (norm.startsWith(normRoot)) {
    return norm.slice(normRoot.length).replace(/^[/\\]+/, "");
  }
  return path;
}

/** Expand the explorer tree so the file becomes visible. */
export async function revealInExplorer(absPath: string) {
  const { useEditorStore, normPath } = await import("../stores/editorStore");
  const { useUiStore } = await import("../stores/uiStore");
  const st = useEditorStore.getState();
  const root = st.root;
  useUiStore.getState().setSidebarView("explorer");
  if (!root) return;
  const lower = (p: string) => normPath(p).toLowerCase();
  const rootN = lower(root);
  const parentOf = (p: string) => {
    const n = normPath(p);
    const cut = n.replace(/\/[^/]+$/, "");
    return cut || n;
  };
  const chain: string[] = [];
  let cur = parentOf(absPath);
  while (cur && lower(cur).startsWith(rootN) && cur.length > root.length) {
    chain.unshift(cur);
    const next = parentOf(cur);
    if (next === cur) break;
    cur = next;
  }
  for (const dir of chain) {
    try {
      const s = useEditorStore.getState();
      if (!s.entries[dir]) await s.loadDir(dir);
      useEditorStore.setState((prev) => ({
        expanded: { ...prev.expanded, [dir]: true },
      }));
    } catch {
      /* ignore */
    }
  }
}

/** Monaco-aware edit action with clipboard fallback. */
async function monacoEdit(kind: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") {
  try {
    const { getActiveEditor } = await import("./editor/EditorInstance");
    const ed = getActiveEditor();
    if (ed) {
      if (kind === "undo") {
        ed.trigger("ctx-menu", "undo", null);
        return;
      }
      if (kind === "redo") {
        ed.trigger("ctx-menu", "redo", null);
        return;
      }
      if (kind === "selectAll") {
        const a = ed.getAction("editor.action.selectAll");
        if (a) {
          await a.run();
          return;
        }
      } else {
        const id =
          kind === "cut"
            ? "editor.action.clipboardCutAction"
            : kind === "copy"
              ? "editor.action.clipboardCopyAction"
              : "editor.action.clipboardPasteAction";
        const a = ed.getAction(id);
        if (a) {
          await a.run();
          return;
        }
      }
    }
  } catch {
    /* fall through */
  }
  try {
    if (kind === "paste") {
      const text = await readClipboardText();
      if (text !== null) {
        const { getActiveEditor } = await import("./editor/EditorInstance");
        const ed = getActiveEditor();
        if (ed) {
          const sel = ed.getSelection();
          if (sel) {
            ed.executeEdits("ctx-paste", [
              { range: sel, text, forceMoveMarkers: true },
            ]);
            ed.focus();
            return;
          }
        }
      }
      return;
    }
    document.execCommand(kind === "selectAll" ? "selectAll" : kind);
  } catch {
    /* ignore */
  }
}

const sep = (id: string): CtxItem => ({ id, label: "", sep: true });

/* ------------------------------------------------------------------ */
/* editor (monaco) menu                                                */
/* ------------------------------------------------------------------ */

export function useEditorMenu(activePath: string | null): CtxItem[] {
  const { t } = useTranslation();
  return [
    { id: "cut", label: t("ctx.cut"), hint: "Ctrl+X", icon: <Scissors size={14} />, action: () => void monacoEdit("cut") },
    { id: "copy", label: t("ctx.copy"), hint: "Ctrl+C", icon: <Copy size={14} />, action: () => void monacoEdit("copy") },
    { id: "paste", label: t("ctx.paste"), hint: "Ctrl+V", icon: <ClipboardPaste size={14} />, action: () => void monacoEdit("paste") },
    sep("s1"),
    { id: "select-all", label: t("ctx.selectAll"), hint: "Ctrl+A", action: () => void monacoEdit("selectAll") },
    {
      id: "goto-line",
      label: t("ctx.goToLine"),
      hint: "Ctrl+G",
      icon: <CornerDownLeft size={14} />,
      action: () => {
        import("../stores/quickOpenStore").then(({ useQuickOpenStore }) =>
          useQuickOpenStore.getState().openWith(":"),
        );
      },
    },
    {
      id: "palette",
      label: t("ctx.cmdPalette"),
      hint: "Ctrl+K",
      icon: <Command size={14} />,
      action: () => {
        import("../stores/paletteStore").then(({ usePaletteStore }) =>
          usePaletteStore.getState().toggle(),
        );
      },
    },
    sep("s2"),
    {
      id: "copy-path",
      label: t("ctx.copyPath"),
      action: () => {
        if (activePath) void copyText(activePath);
      },
    },
    {
      id: "copy-rel",
      label: t("ctx.copyRelPath"),
      action: () => {
        void (async () => {
          const { useEditorStore } = await import("../stores/editorStore");
          const st = useEditorStore.getState();
          if (st.activePath) void copyText(relPathOf(st.root, st.activePath));
        })();
      },
    },
    {
      id: "reveal",
      label: t("ctx.revealExplorer"),
      icon: <FolderOpen size={14} />,
      action: () => {
        void (async () => {
          const { useEditorStore } = await import("../stores/editorStore");
          const p = useEditorStore.getState().activePath;
          if (p) await revealInExplorer(p);
        })();
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* editor tab menu                                                     */
/* ------------------------------------------------------------------ */

export function buildTabMenu(t: TFunction, path: string): CtxItem[] {
  const closeOne = () => {
    void (async () => {
      const [{ useEditorStore }, { useEditorGroups }] = await Promise.all([
        import("../stores/editorStore"),
        import("../stores/editorGroupsStore"),
      ]);
      useEditorGroups.getState().removeEverywhere(path);
      useEditorStore.getState().closeTab(path);
    })();
  };
  const closeMany = (which: "others" | "right") => {
    void (async () => {
      const [{ useEditorStore }, { useEditorGroups }] = await Promise.all([
        import("../stores/editorStore"),
        import("../stores/editorGroupsStore"),
      ]);
      const tabs = useEditorStore.getState().tabs.map((x) => x.path);
      const idx = tabs.indexOf(path);
      const victims =
        which === "others" ? tabs.filter((p) => p !== path) : idx >= 0 ? tabs.slice(idx + 1) : [];
      const groups = useEditorGroups.getState();
      for (const p of victims) {
        groups.removeEverywhere(p);
        useEditorStore.getState().closeTab(p);
      }
    })();
  };
  return [
    { id: "close", label: t("ctx.close"), icon: <X size={14} />, action: closeOne },
    { id: "close-others", label: t("ctx.closeOthers"), action: () => closeMany("others") },
    { id: "close-right", label: t("ctx.closeRight"), action: () => closeMany("right") },
    sep("s1"),
    { id: "copy-path", label: t("ctx.copyPath"), icon: <Copy size={14} />, action: () => void copyText(path) },
    {
      id: "copy-rel",
      label: t("ctx.copyRelPath"),
      action: () => {
        void (async () => {
          const { useEditorStore } = await import("../stores/editorStore");
          void copyText(relPathOf(useEditorStore.getState().root, path));
        })();
      },
    },
    { id: "reveal", label: t("ctx.revealExplorer"), icon: <FolderOpen size={14} />, action: () => void revealInExplorer(path) },
    {
      id: "diff",
      label: t("ctx.diff", "Дифф (диск ↔ редактор)"),
      icon: <Columns2 size={14} />,
      action: () => {
        void import("./editor/DiffModal").then(({ openDiff }) => openDiff(path));
      },
    },
  ];
}

export function useTabMenu(path: string): CtxItem[] {
  const { t } = useTranslation();
  return buildTabMenu(t, path);
}

/* ------------------------------------------------------------------ */
/* terminal menu                                                       */
/* ------------------------------------------------------------------ */

export function useTerminalMenu(): CtxItem[] {
  const { t } = useTranslation();
  return [
    {
      id: "copy-sel",
      label: t("ctx.copySelection"),
      icon: <Copy size={14} />,
      action: () => {
        void (async () => {
          const { getTermHandle } = await import("./TerminalPanel");
          const h = getTermHandle();
          if (h) void copyText(h.getSelection());
        })();
      },
    },
    {
      id: "paste",
      label: t("ctx.paste"),
      hint: "Ctrl+V",
      icon: <ClipboardPaste size={14} />,
      action: () => {
        void (async () => {
          const { getTermHandle } = await import("./TerminalPanel");
          const h = getTermHandle();
          if (!h) return;
          const text = await readClipboardText();
          if (text) h.paste(text);
        })();
      },
    },
    {
      id: "clear",
      label: t("ctx.clearTerminal"),
      action: () => {
        void (async () => {
          const { getTermHandle } = await import("./TerminalPanel");
          getTermHandle()?.clear();
        })();
      },
    },
    sep("s1"),
    {
      id: "new",
      label: t("ctx.newTerminal"),
      icon: <Plus size={14} />,
      action: () => {
        import("../stores/terminalStore").then(({ useTerminalStore }) =>
          useTerminalStore.getState().newSession(),
        );
      },
    },
    {
      id: "split",
      label: t("ctx.splitTerminal"),
      icon: <Columns2 size={14} />,
      action: () => {
        import("../stores/terminalStore").then(({ useTerminalStore }) =>
          useTerminalStore.getState().toggleSplit(),
        );
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* generic app fallback menu                                           */
/* ------------------------------------------------------------------ */

export function useAppMenu(): CtxItem[] {
  const { t } = useTranslation();
  return [
    {
      id: "palette",
      label: t("ctx.cmdPalette"),
      hint: "Ctrl+K",
      icon: <Command size={14} />,
      action: () => {
        import("../stores/paletteStore").then(({ usePaletteStore }) =>
          usePaletteStore.getState().toggle(),
        );
      },
    },
    {
      id: "goto-file",
      label: t("quickopen.placeholder", "Go to file…"),
      hint: "Ctrl+P",
      icon: <Search size={14} />,
      action: () => {
        import("../stores/quickOpenStore").then(({ useQuickOpenStore }) =>
          useQuickOpenStore.getState().toggle(),
        );
      },
    },
    {
      id: "new-file",
      label: t("ctx.newFile"),
      icon: <FilePlus size={14} />,
      action: () => {
        void (async () => {
          const [{ useEditorStore }, { useUiStore }] = await Promise.all([
            import("../stores/editorStore"),
            import("../stores/uiStore"),
          ]);
          const st = useEditorStore.getState();
          const dir = st.root;
          if (!dir) return;
          useUiStore.getState().setSidebarView("explorer");
          const name = `untitled-${Date.now().toString(36)}.txt`;
          try {
            await st.createFile(dir, name);
          } catch {
            /* ignore */
          }
        })();
      },
    },
    sep("s1"),
    {
      id: "sidebar",
      label: t("ctx.toggleSidebar"),
      hint: "Ctrl+B",
      icon: <PanelRight size={14} />,
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) =>
          useUiStore.getState().toggleSidebarView("explorer"),
        );
      },
    },
    {
      id: "bottom",
      label: t("ctx.toggleBottom"),
      hint: "Ctrl+J",
      icon: <PanelBottom size={14} />,
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) => {
          const s = useUiStore.getState();
          s.setBottomOpen(!s.bottomOpen);
        });
      },
    },
    {
      id: "ai",
      label: t("ctx.toggleAI"),
      icon: <Sparkles size={14} />,
      action: () => {
        import("../stores/uiStore").then(({ useUiStore }) => {
          const s = useUiStore.getState();
          s.setAiPanelOpen(!s.aiPanelOpen);
        });
      },
    },
    sep("s2"),
    {
      id: "settings",
      label: t("ctx.settings"),
      icon: <Settings size={14} />,
      action: () => window.dispatchEvent(new CustomEvent("ocgui:open-settings")),
    },
  ];
}
