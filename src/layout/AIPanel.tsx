import { useTranslation } from "react-i18next";
import { MessageSquare, History, Bot, ChevronRight } from "lucide-react";
import { ChatContainer } from "../components/chat/ChatContainer";
import { ChatInput } from "../components/chat/ChatInput";
import { SessionList } from "../components/sessions/SessionList";
import { AutoApprovePanel } from "../components/AutoApprovePanel";
import { LoopPanel } from "../components/LoopPanel";
import { ContinuousPanel } from "../components/ContinuousPanel";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useUiStore } from "../stores/uiStore";

export function AIPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const tab = useUiStore((s) => s.aiTab);
  const setTab = useUiStore((s) => s.setAiTab);

  return (
    <div
      className="flex h-full min-w-0 w-full max-w-full flex-col overflow-hidden rounded-xl border"
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {/* header */}
      <div
        className="flex min-w-0 w-full shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
        style={{ borderColor: "var(--border-subtle)" }}
        onContextMenu={(e) =>
          void import("../lib/ctx").then(({ showCtx }) =>
            showCtx(e, [
              {
                id: "new-chat",
                label: "New Chat",
                hint: "Ctrl+N",
                action: () =>
                  void import("../stores/chatStore").then(({ useChatStore }) =>
                    useChatStore.getState().createSession(),
                  ),
              },
              {
                id: "history",
                label: t("ai.tab.history"),
                action: () => setTab("history"),
              },
              { id: "s1", label: "", sep: true },
              ...(onClose
                ? [
                    {
                      id: "close",
                      label: t("ai.closePanel", "Скрыть AI-панель"),
                      action: () => onClose(),
                    } as const,
                  ]
                : []),
            ]),
          )
        }
      >
        <TabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageSquare size={14} />} label={t("ai.tab.chat")} />
        <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={<History size={14} />} label={t("ai.tab.history")} />
        <TabButton active={tab === "agents"} onClick={() => setTab("agents")} icon={<Bot size={14} />} label={t("ai.tab.agents")} />
        <span className="min-w-2 flex-1" />
        {onClose && (
          <button
            className="shrink-0 rounded p-1 transition-all hover:bg-[var(--hover)] active:scale-90"
            style={{ color: "var(--text-secondary)" }}
            onClick={onClose}
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>

      {/* body */}
      {tab === "chat" && (
        <>
          <ChatContainer />
          <ChatInput />
        </>
      )}

      {tab === "history" && (
        <div className="flex min-h-0 flex-1 flex-col pt-2">
          <SessionList />
        </div>
      )}

      {tab === "agents" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-3 w-full min-w-0">
          <ErrorBoundary name="Loop">
            <LoopPanel />
          </ErrorBoundary>
          <ErrorBoundary name="Continuous">
            <ContinuousPanel />
          </ErrorBoundary>
          <AutoApprovePanel onOpenSettings={() =>
            window.dispatchEvent(new CustomEvent("ocgui:open-settings"))
          } />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="pressable flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--active)" : "transparent",
      }}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
