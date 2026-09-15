import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  RefreshCw,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  ChevronsDownUp,
  ExternalLink,
  Terminal,
  Scissors,
  ClipboardPaste,
  Map as MapIcon,
} from "lucide-react";
import { useEditorStore, type FileEntry, type GitStatusCode } from "../../stores/editorStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { toast } from "../../stores/toastStore";
/* NOTE: TerminalPanel (xterm) is imported lazily via openShellHere. */
import { clampMenuPos } from "../../stores/contextMenuStore";
import { showCtx } from "../../lib/ctx";
import { fileColor, fileIcon } from "../../lib/fileIcons";

/** Open a shell tab cd'ed into dir (TerminalPanel loads lazily on demand). */
function openShellHere(dir: string) {
  const id = useTerminalStore.getState().openTerminal("shell");
  void import("../TerminalPanel").then(({ sendToShell }) =>
    sendToShell(id, `cd "${dir}"\r`).then((ok) => {
      if (!ok) toast.error("Терминал ещё запускается — повторите");
    }),
  );
}

interface FlatRow {
  entry: FileEntry;
  depth: number;
}

interface MenuState {
  entry: FileEntry;
  x: number;
  y: number;
  renaming?: boolean;
  creatingFile?: boolean;
  creatingFolder?: boolean;
}

function relPath(root: string, path: string): string {
  const normRoot = root.replace(/[\\/]+$/, "").replace(/^[/\\]+/, "");
  const norm = path.replace(/^[/\\]+/, "");
  if (norm.startsWith(normRoot)) {
    return norm.slice(normRoot.length).replace(/^[/\\]+/, "");
  }
  return path;
}

// repo-relative path for git lookups (works on either slash style)
function relOf(root: string, path: string): string {
  return relPath(root, path).replace(/\\/g, "/");
}

function gitBadge(status: GitStatusCode): { letter: string; color: string; label: string } {
  switch (status) {
    case "modified":
      return { letter: "M", color: "#e2b340", label: "Modified" };
    case "added":
      return { letter: "A", color: "#73c991", label: "Added" };
    case "deleted":
      return { letter: "D", color: "#f14c4c", label: "Deleted" };
    case "untracked":
      return { letter: "U", color: "#73c991", label: "Untracked" };
    case "conflicted":
      return { letter: "C", color: "#f14c4c", label: "Conflicted" };
    case "renamed":
      return { letter: "R", color: "#73c991", label: "Renamed" };
    case "copied":
      return { letter: "C", color: "#73c991", label: "Copied" };
    case "ignored":
      return { letter: "I", color: "var(--text-tertiary)", label: "Ignored" };
    default:
      return { letter: "", color: "", label: "" };
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard may be unavailable */
  }
}

async function openFolderDialog(onPick: (p: string) => void) {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") onPick(selected);
  } catch (e) {
    console.error("open folder failed", e);
  }
}

export function ExplorerPanel() {
  const { t } = useTranslation();
  const {
    root,
    entries,
    expanded,
    loadDir,
    toggleDir,
    openFile,
    activePath,
    openFolder,
    createFile,
    createDir,
    rename,
    remove,
    pasteInto,
    repoRoot,
    gitStatus,
  } = useEditorStore();
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (root && !entries[root]) void loadDir(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const rows = useMemo<FlatRow[]>(() => {
    if (!root) return [];
    const out: FlatRow[] = [];
    const walk = (dir: string, depth: number) => {
      const children = entries[dir] ?? [];
      for (const entry of children) {
        if (
          filter.trim() &&
          !entry.name.toLowerCase().includes(filter.trim().toLowerCase())
        ) {
          continue;
        }
        out.push({ entry, depth });
        if (entry.is_dir && expanded[entry.path]) {
          walk(entry.path, depth + 1);
        }
      }
    };
    if (entries[root]) walk(root, 0);
    return out;
  }, [root, entries, expanded, filter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const onDropNode = (targetPath: string, isDir: boolean) => {
    const src = dragPath;
    setDragPath(null);
    if (!src || src === targetPath) return;
    const name = src.split(/[\\/]/).pop() ?? src;
    const destDir = isDir ? targetPath : targetPath.replace(/[\\/][^\\/]+$/, "");
    if (destDir === src.replace(/[\\/][^\\/]+$/, "")) return; // same folder
    void rename(src, `${destDir}/${name}`.replace(/\\/g, "/"));
  };

  const entryByPath = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const r of rows) m.set(r.entry.path, r.entry);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const dirOf = (entry: FileEntry) =>
    entry.is_dir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, "");

  const deleteEntry = (entry: FileEntry) => {
    // fs_delete is permanent (no trash): explicit confirm.
    if (
      !window.confirm(
        t("explorer.deleteConfirm", `Удалить «${entry.name}» без возможности восстановления?`),
      )
    )
      return;
    remove(entry.path).then(
      () => toast.success(`Удалено: ${entry.name}`),
      (e) => toast.error(`Не удалось удалить: ${e}`),
    );
  };

  const cutEntry = (entry: FileEntry) => {
    useEditorStore.getState().cutEntries([entry.path]);
    toast.info(`Вырезано: ${entry.name}`);
  };

  const pasteToDir = (dir: string) => {
    pasteInto(dir).then(
      ({ moved, failed }) => {
        if (moved > 0) toast.success(`Перемещено: ${moved}`);
        else if (failed.length === 0) toast.info("Нечего перемещать");
        if (failed.length > 0) toast.error(`Не удалось: ${failed.length}`);
      },
      (e) => toast.error(`Вставка не удалась: ${e}`),
    );
  };

  // Right-click on empty space: folder-level actions for the workspace root.
  const onBgMenu = (e: React.MouseEvent) => {
    if (!root) return;
    if ((e.target as HTMLElement | null)?.closest?.("[data-row]")) return;
    const dir = root;
    const canPaste = useEditorStore.getState().cutPaths.length > 0;
    const blank = {
      name: "",
      path: dir,
      is_dir: true,
      is_symlink: false,
      size: 0,
      modified: null,
    } as FileEntry;
    showCtx(e, [
      {
        id: "new-file",
        label: t("menu.newFile"),
        action: () =>
          setMenu({ entry: blank, x: e.clientX, y: e.clientY, creatingFile: true }),
      },
      {
        id: "new-folder",
        label: t("menu.newFolder"),
        action: () =>
          setMenu({ entry: blank, x: e.clientX, y: e.clientY, creatingFolder: true }),
      },
      { id: "s1", label: "", sep: true },
      {
        id: "paste",
        label: "Paste",
        hint: "Ctrl+V",
        disabled: !canPaste,
        action: () => pasteToDir(dir),
      },
      { id: "refresh", label: t("aa.refresh", "Обновить"), action: () => void loadDir(dir) },
      { id: "s2", label: "", sep: true },
      { id: "reveal", label: "Reveal in File Explorer", action: () => void revealInOs(dir) },
      {
        id: "terminal",
        label: "Open in Integrated Terminal",
        action: () => openShellHere(dir),
      },
      { id: "copy", label: t("menu.copyPath"), action: () => void copyText(dir) },
      { id: "s3", label: "", sep: true },
      {
        id: "overview",
        label: t("explorer.overview", "Карта проекта: онбординг в чат"),
        action: () =>
          void import("../../lib/projectMap").then(({ sendProjectOverview }) =>
            sendProjectOverview(dir).catch((e) => toast.error(String(e))),
          ),
      },
    ]);
  };

  // Explorer-local shortcuts (work when focus is on the rows, not in inputs).
  const onExplorerKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, .monaco-editor")) return;
    const sel = selected ? entryByPath.get(selected) : undefined;
    if (!sel) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "F2" && !ctrl) {
      e.preventDefault();
      const r = scrollRef.current?.getBoundingClientRect();
      setMenu({ entry: sel, x: (r?.left ?? 80) + 200, y: (r?.top ?? 80) + 60, renaming: true });
    } else if ((e.key === "Delete" || e.key === "Backspace") && !ctrl) {
      e.preventDefault();
      deleteEntry(sel);
    } else if (e.key === "Enter" && ctrl) {
      e.preventDefault();
      if (sel.is_dir) void toggleDir(sel.path);
      else void useEditorStore.getState().openFile(sel.path, { preview: false });
    } else if (ctrl && (e.key.toLowerCase() === "x" || e.key.toLowerCase() === "ч")) {
      e.preventDefault();
      cutEntry(sel);
    } else if (ctrl && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "с")) {
      e.preventDefault();
      void copyText(sel.path);
    } else if (ctrl && (e.key.toLowerCase() === "v" || e.key.toLowerCase() === "м")) {
      e.preventDefault();
      pasteToDir(dirOf(sel));
    }
  };

  // Native OS file-drop: Tauri v2 does not expose real paths through the DOM
  // drag-and-drop `DataTransfer` (the `File.path` property was removed), so we
  // listen on the webview window's own drag-drop events instead — the same
  // pattern already used in ChatInput.tsx.
  useEffect(() => {
    const un = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const destDir = root || "";
      const srcPaths = event.payload.paths;
      if (srcPaths.length === 0) return;
      void (async () => {
        for (const src of srcPaths) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const data = await invoke<number[]>("read_file_bytes", { path: src });
            const bytes = new Uint8Array(data);
            const name = src.split(/[\\/]/).pop() ?? src;
            const abs = `${destDir.replace(/[\\/]$/, "")}/${name}`.replace(/\\/g, "/");
            await invoke("fs_write_bytes", { path: abs, data: Array.from(bytes) });
          } catch (err) {
            console.error("os drop failed", err);
          }
        }
        if (destDir) await loadDir(destDir);
      })();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [root, loadDir]);

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="section-header !justify-start flex-1">
          <FolderOpen className="h-4 w-4 shrink-0" />
          {t("nav.explorer")}
        </span>
        <button
          className="icon-btn !p-1"
          title={t("menu.newFile")}
          onClick={() => {
            if (!root) return;
            setMenu({
              entry: { name: "", path: root, is_dir: true, is_symlink: false, size: 0, modified: null },
              x: 0,
              y: 80,
              creatingFile: true,
            });
          }}
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
        <button
          className="icon-btn !p-1"
          title={t("menu.newFolder")}
          onClick={() => {
            if (!root) return;
            setMenu({
              entry: { name: "", path: root, is_dir: true, is_symlink: false, size: 0, modified: null },
              x: 0,
              y: 80,
              creatingFolder: true,
            });
          }}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button
          className="icon-btn !p-1"
          title="Collapse All"
          onClick={() => useEditorStore.setState({ expanded: {} })}
        >
          <ChevronsDownUp className="h-3.5 w-3.5" />
        </button>
        <button
          className="icon-btn !p-1"
          title={t("aa.refresh", "Обновить")}
          onClick={() => {
            if (root) {
              useEditorStore.setState((s) => ({
                entries: { ...s.entries, [root]: [] },
              }));
              void loadDir(root);
            }
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          className="icon-btn !p-1"
          title={t("explorer.overview", "Карта проекта: онбординг в чат")}
          onClick={() => {
            if (!root) return;
            void import("../../lib/projectMap").then(({ sendProjectOverview }) =>
              sendProjectOverview(root).catch((e) => toast.error(String(e))),
            );
          }}
        >
          <MapIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-2 pt-2">
        <input
          className="input-field !py-1.5 text-[13px]"
          placeholder={t("explorer.filter", "Фильтр файлов…")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div ref={scrollRef} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto py-1 outline-none" onKeyDown={onExplorerKeyDown} onContextMenu={onBgMenu} onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
        {!root && (
          <div className="flex flex-col items-center gap-2 break-words px-4 py-8 text-center text-ui-sm max-w-full" style={{ color: "var(--text-secondary)" }}>
            <FolderOpen className="h-8 w-8 opacity-40" />
            <span className="break-words max-w-full">{t("explorer.noFolder", "Папка не открыта")}</span>
            <button
              className="btn-primary mt-1 px-3 py-1.5 text-[13px]"
              onClick={() => void openFolderDialog(openFolder)}
            >
              {t("welcome.openFolder")}
            </button>
          </div>
        )}

        {root && rows.length === 0 && !filter && (
          <div className="flex flex-col items-center gap-2 break-words py-8 text-center text-ui-sm max-w-full" style={{ color: "var(--text-secondary)" }}>
            <FolderOpen className="h-8 w-8 opacity-40" />
            <span className="break-words">{t("explorer.empty", "Пусто")}</span>
          </div>
        )}

        {root && rows.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const { entry, depth } = rows[vi.index];
              return (
                <NodeRow
                  key={entry.path}
                  entry={entry}
                  depth={depth}
                  active={activePath === entry.path}
                  expanded={!!expanded[entry.path]}
                  top={vi.start}
                  gitStatus={repoRoot ? gitStatus[relOf(repoRoot, entry.path)] : undefined}
                  onOpen={() => {
                    setSelected(entry.path);
                    if (entry.is_dir) void toggleDir(entry.path);
                    else void openFile(entry.path, { preview: true });
                  }}
                  onContext={(x, y) => {
                    setSelected(entry.path);
                    setMenu({ entry, x, y });
                  }}
                  onRename={(name) => void rename(entry.path, name)}
                  onDragStartNode={(p) => setDragPath(p)}
                  onDropNode={onDropNode}
                />
              );
            })}
          </div>
        )}
      </div>

      <ContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onNewFile={(dir) =>
          setMenu({
            entry: { name: "", path: dir, is_dir: true, is_symlink: false, size: 0, modified: null },
            x: menu?.x ?? 80,
            y: menu?.y ?? 80,
            creatingFile: true,
          })
        }
        onNewFolder={(dir) =>
          setMenu({
            entry: { name: "", path: dir, is_dir: true, is_symlink: false, size: 0, modified: null },
            x: menu?.x ?? 80,
            y: menu?.y ?? 80,
            creatingFolder: true,
          })
        }
        onRename={(entry) => setMenu({ entry, x: menu?.x ?? 80, y: menu?.y ?? 80, renaming: true })}
        onDelete={deleteEntry}
        onCut={cutEntry}
        onPaste={pasteToDir}
        onReveal={(entry) => void revealInOs(entry.path)}
        onOpenTerminal={openShellHere}
        onCopyPath={(entry) => void copyText(entry.path)}
        onCopyRel={(entry) => void copyText(relPath(root, entry.path))}
        onInlineCreate={async (dir, name, isDir) => {
          if (isDir) await createDir(dir, name);
          else await createFile(dir, name);
        }}
        onRenameCommit={rename}
      />
    </div>
  );
}

function NodeRow({
  entry,
  depth,
  active,
  expanded,
  top,
  gitStatus,
  onOpen,
  onContext,
  onRename,
  onDragStartNode,
  onDropNode,
}: {
  entry: FileEntry;
  depth: number;
  active: boolean;
  expanded: boolean;
  top: number;
  gitStatus: GitStatusCode | undefined;
  onOpen: () => void;
  onContext: (x: number, y: number) => void;
  onRename: (name: string) => void;
  onDragStartNode: (path: string) => void;
  onDropNode: (targetPath: string, isDir: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.name);
  const color = entry.is_dir ? undefined : fileColor(entry.name);
  const Icon = entry.is_dir ? null : fileIcon(entry.name);
  const git = gitStatus ? gitBadge(gitStatus) : null;

  const commit = () => {
    setEditing(false);
    if (value.trim() && value.trim() !== entry.name) onRename(value.trim());
  };

  return (
    <div
      data-row={entry.path}
      className={`pressable group absolute left-0 mx-1 flex w-[calc(100%-8px)] cursor-pointer select-none items-center gap-1 rounded-md px-1.5 py-[3px] text-[13.5px] ${
        active ? "" : "hover:bg-[var(--hover)]"
      }`}
      style={{
        top,
        height: 28,
        paddingLeft: 6 + depth * 16,
        background: active ? "rgba(99,102,241,0.12)" : undefined,
        boxShadow: active ? "inset 2px 0 0 var(--accent-500)" : undefined,
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
      }}
      onClick={() => (editing ? undefined : onOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-node", entry.path);
        e.dataTransfer.effectAllowed = "move";
        onDragStartNode(entry.path);
      }}
      onDragOver={(e) => {
        if (entry.is_dir) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropNode(entry.path, entry.is_dir);
      }}
    >
      {entry.is_dir ? (
        expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      {entry.is_dir ? (
        expanded ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-accent-400" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-accent-400" />
        )
      ) : (
        Icon ? <Icon className="h-4 w-4 shrink-0" style={{ color }} /> : null
      )}
      {editing ? (
        <input
          autoFocus
          className="input-field !py-0 !text-[13px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span
          className="truncate"
          style={git ? { color: git.color } : undefined}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setValue(entry.name);
            setEditing(true);
          }}
        >
          {entry.name}
        </span>
      )}
      {git && (
        <span
          className="ml-auto shrink-0 pl-2 text-[10px] font-bold"
          style={{ color: git.color }}
          title={git.label}
        >
          {git.letter}
        </span>
      )}
    </div>
  );
}

async function revealInOs(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (e) {
    toast.error(`Не удалось открыть в проводнике: ${e}`);
  }
}

function ContextMenu({
  menu,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCut,
  onPaste,
  onReveal,
  onOpenTerminal,
  onCopyPath,
  onCopyRel,
  onInlineCreate,
  onRenameCommit,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onCut: (entry: FileEntry) => void;
  onPaste: (dir: string) => void;
  onReveal: (entry: FileEntry) => void;
  onOpenTerminal: (dir: string) => void;
  onCopyPath: (entry: FileEntry) => void;
  onCopyRel: (entry: FileEntry) => void;
  onInlineCreate: (dir: string, name: string, isDir: boolean) => Promise<void>;
  onRenameCommit: (path: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Hooks must run unconditionally (before any early return).
  const cutCount = useEditorStore((s) => s.cutPaths.length);

  useEffect(() => {
    if (menu && (menu.renaming || menu.creatingFile || menu.creatingFolder)) {
      setValue(menu.renaming ? menu.entry.name : "");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [menu]);

  if (!menu) return null;

  const dir = menu.entry.is_dir
    ? menu.entry.path
    : menu.entry.path.replace(/[\\/][^\\/]+$/, "");

  const commitInline = async () => {
    const name = value.trim();
    if (!name) return onClose();
    if (menu.creatingFile) await onInlineCreate(dir, name, false);
    else if (menu.creatingFolder) await onInlineCreate(dir, name, true);
    else if (menu.renaming) await onRenameCommit(menu.entry.path, name);
    onClose();
  };

  if (menu.renaming || menu.creatingFile || menu.creatingFolder) {
    const dlg = clampMenuPos(menu.x || 80, menu.y || 80, 240, 140);
    return (
      <div
        className="fixed z-50 rounded-lg border bg-[var(--bg-primary)] p-2 shadow-xl"
        style={{ borderColor: "var(--border-subtle)", top: dlg.y, left: dlg.x }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="mb-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
          {menu.creatingFolder
            ? t("menu.newFolder")
            : menu.creatingFile
              ? t("menu.newFile")
              : t("menu.rename")}
        </div>
        <input
          ref={inputRef}
          className="input-field !py-1.5 text-[13px]"
          value={value}
          placeholder="name"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitInline();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn-ghost px-2 py-1 text-[12px]" onClick={onClose}>
            Отмена
          </button>
          <button className="btn-primary px-2 py-1 text-[12px]" onClick={() => void commitInline()}>
            OK
          </button>
        </div>
      </div>
    );
  }

  const items = [
    { icon: <ExternalLink className="h-3.5 w-3.5" />, label: "Open to the Side", hint: "Ctrl+Enter", action: () => void useEditorStore.getState().openFile(menu.entry.path, { preview: false }) },
    { icon: <FolderOpen className="h-3.5 w-3.5" />, label: "Reveal in File Explorer", action: () => onReveal(menu.entry) },
    { icon: <Terminal className="h-3.5 w-3.5" />, label: "Open in Integrated Terminal", action: () => onOpenTerminal(dir) },
    { sep: true },
    { icon: <FilePlus className="h-3.5 w-3.5" />, label: t("menu.newFile"), action: () => onNewFile(dir) },
    { icon: <FolderPlus className="h-3.5 w-3.5" />, label: t("menu.newFolder"), action: () => onNewFolder(dir) },
    { sep: true },
    { icon: <Scissors className="h-3.5 w-3.5" />, label: "Cut", hint: "Ctrl+X", action: () => onCut(menu.entry) },
    { icon: <ClipboardPaste className="h-3.5 w-3.5" />, label: "Paste", hint: "Ctrl+V", disabled: cutCount === 0, action: () => onPaste(dir) },
    { icon: <Copy className="h-3.5 w-3.5" />, label: t("menu.copyPath"), hint: "Ctrl+C", action: () => onCopyPath(menu.entry) },
    { icon: <Copy className="h-3.5 w-3.5" />, label: t("menu.copyRelativePath"), action: () => onCopyRel(menu.entry) },
    { sep: true },
    { icon: <Pencil className="h-3.5 w-3.5" />, label: t("menu.rename"), hint: "F2", action: () => onRename(menu.entry) },
    { icon: <Trash2 className="h-3.5 w-3.5" />, label: t("menu.delete"), hint: "Del", danger: true, action: () => onDelete(menu.entry) },
  ];

  const pos = clampMenuPos(menu.x, menu.y, 250, 420);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 min-w-[180px] rounded-lg border bg-[var(--bg-primary)] py-1 shadow-xl"
        style={{ borderColor: "var(--border-subtle)", top: pos.y, left: pos.x }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) =>
          "sep" in it && it.sep ? (
            <div key={i} className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
          ) : (
            <button
              key={i}
              disabled={"disabled" in it && !!(it as any).disabled}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              style={{ color: "danger" in it && it.danger ? "#f87171" : "var(--text-primary)" }}
              onClick={() => {
                if ("disabled" in it && (it as any).disabled) return;
                onClose();
                (it as any).action?.();
              }}
            >
              {"icon" in it ? it.icon : null}
              <span className="flex-1">{"label" in it ? (it as any).label : null}</span>
              {"hint" in it && (it as any).hint ? (
                <span className="ml-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {(it as any).hint}
                </span>
              ) : null}
            </button>
          ),
        )}
      </div>
    </>
  );
}
