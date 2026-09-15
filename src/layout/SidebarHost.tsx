import { motion } from "framer-motion";
import { useUiStore } from "../stores/uiStore";
import { ExplorerPanel } from "../components/explorer/ExplorerPanel";
import { SearchPanel } from "../components/search/SearchPanel";
import { GitPanel } from "../components/git/GitPanel";
import { McpPanel } from "../components/mcp/McpPanel";
import { VpnPanel } from "../components/vpn/VpnPanel";

export function SidebarHost() {
  const view = useUiStore((s) => s.sidebarView);

  if (view === null) return null;

  return (
    <aside
      className="flex h-full min-w-0 w-full max-w-full flex-col overflow-hidden rounded-xl border"
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-subtle)",
      }}
    >
      <motion.div
        key={view ?? "none"}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        initial={{ opacity: 0, x: 10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.13, ease: "easeOut" }}
      >
        {view === "explorer" && <ExplorerPanel />}
        {view === "search" && <SearchPanel />}
        {view === "git" && <GitPanel />}
        {view === "mcp" && <McpPanel />}
        {view === "vpn" && <VpnPanel />}
      </motion.div>
    </aside>
  );
}
