import { Suspense, lazy, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { FolderOpen, Command, ChevronRight, X as XIcon } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
// Monaco (~4MB) loads only when the editor area first renders.
const EditorInstance = lazy(() =>
  import("../components/editor/EditorInstance").then((m) => ({ default: m.EditorInstance })),
);

function EditorSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-2 p-4" aria-hidden>
      <div className="h-4 animate-pulse rounded" style={{ background: "var(--bg-quaternary)", width: "40%" }} />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded"
          style={{ background: "var(--bg-quaternary)", width: `${88 - i * 7}%` }}
        />
      ))}
    </div>
  );
}
import { fileColor, fileIcon } from "../lib/fileIcons";
import { cn } from "../lib/cn";
import { useContextMenuStore } from "../stores/contextMenuStore";
import { buildTabMenu } from "../components/menus";
import { useEditorStore } from "../stores/editorStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePaletteStore } from "../stores/paletteStore";
import { useEditorGroups } from "../stores/editorGroupsStore";

export function EditorArea() {
  const { t } = useTranslation();
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const { root, activePath, openFolder } = useEditorStore();
  const { groups, active, setFocusedGroup, setActive, closeTab, split, moveTab } =
    useEditorGroups();

  // Auto-open the configured working directory once on first mount.
  useEffect(() => {
    if (root) return;
    const wd = useSettingsStore.getState().workDir;
    if (wd && wd.trim()) openFolder(wd.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+\ to split the focused group.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        split();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [split]);

  const pickFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") openFolder(selected);
    } catch (e) {
      console.error("open folder failed", e);
    }
  };

  const crumbs = root && activePath ? buildCrumbs(root, activePath) : [];

  return (
    <div
      className="relative flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-hidden rounded-xl border"
      style={{ background: "var(--bg-primary)", borderColor: "var(--border-subtle)" }}
    >
      {activePath && (
        <div
          className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-3 py-1 text-[12px]"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
              <span className={i === crumbs.length - 1 ? "text-[var(--text-primary)]" : ""} style={{ whiteSpace: "nowrap" }}>
                {c}
              </span>
            </span>
          ))}
        </div>
      )}

      {root ? (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {groups.map((paths, gi) => (
            <div
              key={gi}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              style={{ borderRight: gi < groups.length - 1 ? "1px solid var(--border-subtle)" : undefined }}
              onMouseDown={() => setFocusedGroup(gi)}
            >
              <TabBar
                group={gi}
                paths={paths}
                activePath={active[gi] ?? null}
                onActivate={(p) => setActive(gi, p)}
                onClose={(p) => {
                  closeTab(gi, p);
                  const stillOpen = useEditorGroups
                    .getState()
                    .groups.some((g) => g.includes(p));
                  if (!stillOpen) useEditorStore.getState().closeTab(p);
                }}
                onDropTab={(path, fromGroup, index) =>
                  moveTab(path, fromGroup, gi, index)
                }
              />
              <Suspense fallback={<EditorSkeleton />}>
                <EditorInstance activePath={active[gi] ?? null} />
              </Suspense>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          onContextMenu={(e) =>
            void import("../lib/ctx").then(({ showCtx }) =>
              showCtx(e, [
                {
                  id: "new-file",
                  label: "New File",
                  hint: "Ctrl+Alt+N",
                  action: () =>
                    void import("./TitleBar").then((m) => m.newFileAction()),
                },
                {
                  id: "open-folder",
                  label: "Open Folder",
                  hint: "Ctrl+O",
                  action: () =>
                    void import("./TitleBar").then((m) => m.openFolderAction()),
                },
                { id: "s1", label: "", sep: true },
                {
                  id: "palette",
                  label: "Command Palette",
                  hint: "Ctrl+K",
                  action: () =>
                    void import("../stores/paletteStore").then(({ usePaletteStore }) =>
                      usePaletteStore.getState().toggle(),
                    ),
                },
                {
                  id: "settings",
                  label: t("settings.title"),
                  hint: "Ctrl+,",
                  action: () =>
                    window.dispatchEvent(new CustomEvent("ocgui:open-settings")),
                },
              ]),
            )
          }
        >
          <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(600px 300px at 50% 38%, var(--ai-subtle), transparent 70%)" }} />
          <div className="relative z-10 flex flex-col items-center gap-5 text-center">
            <LogoMark size={72} />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">NexusCode</h1>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                {t("welcome.slogan")}
              </p>
            </div>
            <button className="btn-primary mt-2 flex items-center gap-2 px-5 py-2" onClick={pickFolder}>
              <FolderOpen size={16} />
              {t("welcome.openFolder")}
            </button>
            <button className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }} onClick={() => setPaletteOpen(true)}>
              <Command size={13} />
              Ctrl+K — {t("cmd.placeholder")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TabBar({
  group,
  paths,
  activePath,
  onActivate,
  onClose,
  onDropTab,
}: {
  group: number;
  paths: string[];
  activePath: string | null;
  onActivate: (p: string) => void;
  onClose: (p: string) => void;
  onDropTab: (path: string, fromGroup: number, index?: number) => void;
}) {
  const { tabs } = useEditorStore();
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1 py-1" style={{ borderColor: "var(--border-subtle)" }}>
      <AnimatePresence initial={false} mode="popLayout">
      {paths.map((path, i) => {
        const tab = tabs.find((t) => t.path === path);
        const isActive = path === activePath;
        const TabIcon = fileIcon(tab?.name ?? path);
        return (
          <motion.div
            key={path}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="shrink-0"
          >
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-tab", JSON.stringify({ path, fromGroup: group }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const data = e.dataTransfer.getData("application/x-tab");
              if (!data) return;
              try {
                const { path: p, fromGroup } = JSON.parse(data);
                onDropTab(p, fromGroup, i);
              } catch {
                /* ignore */
              }
            }}
            className={cn("group flex max-w-[200px] cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors", isActive ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]")}
            style={{
              background: isActive ? "var(--bg-primary)" : "transparent",
              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              borderBottom: isActive ? "2px solid var(--accent-500)" : "2px solid transparent",
              fontStyle: tab?.preview ? "italic" : "normal",
              opacity: tab?.pinned ? 1 : undefined,
            }}
            onClick={() => onActivate(path)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              useContextMenuStore.getState().show(e.clientX, e.clientY, buildTabMenu(t, path));
            }}
            title={`${path}${tab?.pinned ? " · pinned" : ""}${tab?.preview ? " · preview" : ""}`}
          >
            {tab?.pinned && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-400)]" title="Pinned" />}
            <TabIcon className="h-3.5 w-3.5 shrink-0" style={{ color: fileColor(tab?.name ?? path) }} />
            <span className="truncate">{tab?.name ?? path.split(/[\\/]/).pop()}</span>
            <button
              className={`flex h-4 w-4 items-center justify-center rounded transition-all ${tab?.dirty ? "" : "opacity-0 group-hover:opacity-100"} hover:bg-[var(--hover)] active:scale-90`}
              title="Закрыть"
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
            >
              {tab?.dirty ? <span className="h-2 w-2 rounded-full bg-[var(--accent-400)]" /> : <XIcon className="h-3 w-3" />}
            </button>
          </div>
          </motion.div>
        );
      })}
      </AnimatePresence>
    </div>
  );
}

function buildCrumbs(root: string, path: string): string[] {
  const normRoot = root.replace(/[\\/]+$/, "");
  const rel = path.replace(/^[/\\]+/, "").replace(normRoot, "").replace(/^[/\\]+/, "");
  const rootName = normRoot.split(/[\\/]/).filter(Boolean).pop() ?? normRoot;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return [rootName, ...parts];
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="nc-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="220" fill="url(#nc-bg)" />
      <line x1="300" y1="700" x2="724" y2="324" stroke="#fff" strokeWidth="46" strokeLinecap="round" />
      <line x1="300" y1="324" x2="300" y2="700" stroke="rgba(238,242,255,.8)" strokeWidth="40" strokeLinecap="round" />
      <line x1="724" y1="324" x2="724" y2="700" stroke="rgba(238,242,255,.8)" strokeWidth="40" strokeLinecap="round" />
      <circle cx="300" cy="700" r="95" fill="#fff" />
      <circle cx="724" cy="324" r="95" fill="#fff" />
      <text x="300" y="712" textAnchor="middle" dominantBaseline="middle" fontFamily="Geist Variable, Segoe UI, sans-serif" fontWeight="800" fontSize="150" fill="#4f46e5">N</text>
      <text x="724" y="336" textAnchor="middle" dominantBaseline="middle" fontFamily="Geist Variable, Segoe UI, sans-serif" fontWeight="800" fontSize="150" fill="#4f46e5">C</text>
    </svg>
  );
}
