import {
  Files,
  Search,
  GitBranch,
  Blocks,
  Shield,
  TerminalSquare,
  Settings,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../stores/uiStore";

/** Open Settings without importing the (lazy) CommandPalette module. */
export function openSettings() {
  window.dispatchEvent(new CustomEvent("ocgui:open-settings"));
}

interface ItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  bottom?: boolean;
}

function Item({ icon, label, active, onClick, onContextMenu, bottom }: ItemProps) {
  return (
    <button
      title={label}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="pressable group relative flex h-12 w-12 items-center justify-center transition-colors"
      style={{ color: active ? "var(--accent-400)" : "var(--text-secondary)" }}
    >
      {/* active indicator bar */}
      <span
        className="absolute left-0 h-6 w-[2px] rounded-r transition-all"
        style={{
          background: active ? "var(--accent-500)" : "transparent",
          boxShadow: active ? "0 0 12px var(--ai-glow)" : undefined,
        }}
      />
      <span
        className="flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150 group-hover:bg-[var(--hover)] group-hover:scale-105 group-active:scale-90"
        style={
          active
            ? { background: "var(--ai-subtle)" }
            : undefined
        }
      >
        {icon}
      </span>
      <span className="pointer-events-none absolute left-14 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-xs opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100 -translate-x-1"
        style={{
          background: "var(--bg-quaternary)",
          borderColor: "var(--border-default)",
        }}
      >
        {label}
      </span>
      {bottom && <span className="sr-only">bottom</span>}
    </button>
  );
}

export function ActivityBar() {
  const { t } = useTranslation();
  const sidebarView = useUiStore((s) => s.sidebarView);
  const toggleSidebarView = useUiStore((s) => s.toggleSidebarView);
  const bottomOpen = useUiStore((s) => s.bottomOpen);
  const setBottomOpen = useUiStore((s) => s.setBottomOpen);

  const viewMenu = (e: React.MouseEvent, view: "explorer" | "search" | "git" | "mcp" | "vpn", label: string) => {
    e.preventDefault();
    e.stopPropagation();
    void import("../lib/ctx").then(({ showCtx }) =>
      showCtx(e, [
        {
          id: "open",
          label,
          action: () => useUiStore.getState().setSidebarView(view),
        },
        {
          id: "hide",
          label: t("sidebar.hide", "Скрыть сайдбар"),
          hint: "Ctrl+B",
          action: () => useUiStore.getState().setSidebarView(null),
        },
        { id: "sep1", label: "", sep: true },
        {
          id: "palette",
          label: t("ctx.cmdPalette", "Палитра команд"),
          hint: "Ctrl+K",
          action: () =>
            void import("../stores/paletteStore").then(({ usePaletteStore }) =>
              usePaletteStore.getState().toggle(),
            ),
        },
      ]),
    );
  };

  return (
    <div
      className="flex h-full w-12 shrink-0 flex-col items-center justify-between py-2"
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-subtle)",
      }}
    >
      <div className="flex flex-col items-center gap-1">
        <Item
          icon={<Files size={20} />}
          label={t("nav.explorer")}
          active={sidebarView === "explorer"}
          onClick={() => toggleSidebarView("explorer")}
          onContextMenu={(e) => viewMenu(e, "explorer", t("nav.explorer"))}
        />
        <Item
          icon={<Search size={20} />}
          label={t("nav.search")}
          active={sidebarView === "search"}
          onClick={() => toggleSidebarView("search")}
          onContextMenu={(e) => viewMenu(e, "search", t("nav.search"))}
        />
        <Item
          icon={<GitBranch size={20} />}
          label={t("nav.git")}
          active={sidebarView === "git"}
          onClick={() => toggleSidebarView("git")}
          onContextMenu={(e) => viewMenu(e, "git", t("nav.git"))}
        />
        <Item
          icon={<Blocks size={20} />}
          label={t("nav.mcp", "MCP")}
          active={sidebarView === "mcp"}
          onClick={() => toggleSidebarView("mcp")}
          onContextMenu={(e) => viewMenu(e, "mcp", t("nav.mcp", "MCP"))}
        />
        <Item
          icon={<Shield size={20} />}
          label={t("nav.vpn", "VPN")}
          active={sidebarView === "vpn"}
          onClick={() => toggleSidebarView("vpn")}
          onContextMenu={(e) => viewMenu(e, "vpn", t("nav.vpn", "VPN"))}
        />
      </div>

      <div className="flex flex-col items-center gap-1">
        <Item
          icon={<TerminalSquare size={20} />}
          label={t("nav.terminal")}
          active={bottomOpen}
          onClick={() => setBottomOpen(!bottomOpen)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void import("../lib/ctx").then(({ showCtx }) =>
              showCtx(e, [
                {
                  id: "toggle",
                  label: bottomOpen ? t("terminal.hide", "Скрыть терминал") : t("terminal.show", "Показать терминал"),
                  hint: "Ctrl+J",
                  action: () => setBottomOpen(!bottomOpen),
                },
                {
                  id: "new",
                  label: t("terminal.new", "New terminal"),
                  action: () =>
                    void import("../stores/terminalStore").then(({ useTerminalStore }) =>
                      useTerminalStore.getState().openTerminal(),
                    ),
                },
              ]),
            );
          }}
        />
        <Item
          icon={<Settings size={20} />}
          label={t("settings.title")}
          onClick={() => openSettings()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void import("../lib/ctx").then(({ showCtx }) =>
              showCtx(e, [
                {
                  id: "open",
                  label: t("settings.title"),
                  hint: "Ctrl+,",
                  action: () => openSettings(),
                },
                {
                  id: "palette",
                  label: t("ctx.cmdPalette", "Палитра команд"),
                  hint: "Ctrl+K",
                  action: () =>
                    void import("../stores/paletteStore").then(({ usePaletteStore }) =>
                      usePaletteStore.getState().toggle(),
                    ),
                },
              ]),
            );
          }}
        />
      </div>
    </div>
  );
}
