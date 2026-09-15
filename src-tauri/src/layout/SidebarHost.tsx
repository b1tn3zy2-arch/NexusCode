import { useTranslation } from "react-i18next";
import { FolderOpen, Search as SearchIcon, GitBranch } from "lucide-react";
import { useUiStore } from "../stores/uiStore";
import { ExplorerPanel } from "../components/explorer/ExplorerPanel";

function PhaseStub({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl"
        style={{ background: "var(--ai-subtle)", color: "var(--accent-400)" }}
      >
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-[220px] text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {hint}
      </p>
    </div>
  );
}

export function SidebarHost() {
  const { t } = useTranslation();
  const view = useUiStore((s) => s.sidebarView);

  if (view === null) return null;

  return (
    <aside
      className="flex h-full w-[280px] shrink-0 flex-col border-r"
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {view === "explorer" && <ExplorerPanel />}
      {view === "search" && (
        <PhaseStub
          icon={<SearchIcon size={22} />}
          title={t("nav.search")}
          hint={t("stub.search")}
        />
      )}
      {view === "git" && (
        <PhaseStub
          icon={<GitBranch size={22} />}
          title={t("nav.git")}
          hint={t("stub.git")}
        />
      )}
    </aside>
  );
}
