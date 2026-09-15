import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageSquareCode, AlertTriangle, X, Cpu, Plus, RefreshCw } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useEditorStore } from "../../stores/editorStore";
import { MessageBubble } from "./MessageBubble";
import { Select } from "../Select";
import {
  useModelsStore,
  toSelectGroups,
  findModel,
  fmtTokens,
  fmtContext,
} from "../../stores/modelsStore";
import { AddModelDialog } from "./AddModelDialog";
import { Check, RotateCcw, Eye, Columns2 } from "lucide-react";
import { toast } from "../../stores/toastStore";
import { logInfo, logWarn } from "../../stores/outputStore";
import { useSettingsStore } from "../../stores/settingsStore";

/** Expandable per-file diff with +/- highlighting for the review banner. */
function ReviewDiff({ files, extra }: { files: string[]; extra: number }) {
  const { t } = useTranslation();
  const [openFile, setOpenFile] = useState<string | null>(null);
  const hunks = useEditorStore((s) => (openFile ? s.gitHunks[openFile] : undefined));
  const loadGitHunks = useEditorStore((s) => s.loadGitHunks);

  useEffect(() => {
    if (openFile) void loadGitHunks(openFile).catch(() => {});
  }, [openFile, loadGitHunks]);

  return (
    <div
      className="mt-1.5 max-h-[180px] overflow-y-auto font-mono text-[11.5px] leading-relaxed"
      style={{ color: "var(--text-secondary)" }}
      title={files.join("\n")}
    >
      {files.map((f) => (
        <div key={f}>
          <button
            className="flex w-full items-center gap-1 truncate rounded px-1 py-px text-left hover:bg-[var(--hover)]"
            onClick={() => setOpenFile((cur) => (cur === f ? null : f))}
            title={t("review.showDiff", "Показать дифф")}
          >
            <span
              className="inline-block shrink-0 transition-transform"
              style={{
                transform: openFile === f ? "rotate(90deg)" : undefined,
                fontSize: 9,
              }}
            >
              ▶
            </span>
            <span className="truncate">{f}</span>
          </button>
          {openFile === f && (
            <div className="mb-1 ml-3 max-h-[220px] overflow-auto rounded-lg border p-1.5" style={{ borderColor: "var(--border-subtle)", background: "rgba(0,0,0,0.25)" }}>
              {!hunks ? (
                <div className="px-1 py-0.5 opacity-60">…</div>
              ) : hunks.length === 0 ? (
                <div className="px-1 py-0.5 opacity-60">
                  {t("review.noHunks", "Ханков нет (возможно, файл новый или уже закоммичен)")}
                </div>
              ) : (
                hunks.slice(0, 8).map((h, hi) => (
                  <div key={hi} className="mb-1 last:mb-0">
                    <div className="px-1 opacity-50">
                      @@ -{h.old_start},{h.old_lines} +{h.new_start},{h.new_lines} @@
                    </div>
                    {h.lines.slice(0, 80).map((l, li) => (
                      <div
                        key={li}
                        className="whitespace-pre-wrap break-all px-1"
                        style={{
                          color:
                            l.kind === "added"
                              ? "#73c991"
                              : l.kind === "removed"
                                ? "#f16c6c"
                                : undefined,
                          background:
                            l.kind === "added"
                              ? "rgba(115,201,145,0.08)"
                              : l.kind === "removed"
                                ? "rgba(241,108,108,0.08)"
                                : undefined,
                        }}
                      >
                        {l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}
                        {l.text}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}
      {extra > 0 && <div>… +{extra}</div>}
    </div>
  );
}

/** Cursor-style review banner: accept (default) or revert the run's changes. */
function ReviewBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const review = useChatStore((s) => s.pendingReview[sessionId]);
  const dismissReview = useChatStore((s) => s.dismissReview);
  const workDir = useSettingsStore((s) => s.workDir);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  if (!review) return null;
  const files = review.files;

  const accept = () => {
    dismissReview(sessionId);
    toast.success(t("review.kept", "Изменения приняты"));
  };

  const reviewByAgent = async () => {
    if (!workDir || busy || files.length === 0) return;
    setBusy(true);
    try {
      const { useEditorStore } = await import("../../stores/editorStore");
      const ed = useEditorStore.getState();
      const chunks: string[] = [];
      for (const f of files.slice(0, 12)) {
        try {
          await ed.loadGitHunks(f);
          const hunks = useEditorStore.getState().gitHunks[f] ?? [];
          if (hunks.length === 0) continue;
          chunks.push(`--- ${f} ---`);
          for (const h of hunks.slice(0, 6)) {
            chunks.push(`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`);
            for (const l of h.lines.slice(0, 60)) {
              chunks.push(`${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`);
            }
          }
        } catch {
          /* one bad file must not kill the review */
        }
      }
      const diff = chunks.join("\n").slice(0, 12000);
      if (!diff.trim()) {
        toast.info(t("review.noDiff", "Дифф пустой — нечего ревьюить"));
        return;
      }
      const chat = useChatStore.getState();
      const created = await chat.createSession();
      if (!created) throw new Error("no session");
      await chat.send(
        `Проведи код-ревью этих изменений как второй агент: баги, риски, стиль. ` +
          `В конце — вердикт одной строкой: OK или список проблем.\n\n\`\`\`diff\n${diff}\n\`\`\``,
      );
      toast.success(t("review.started", "Ревью запущено в новой сессии"));
    } catch (e) {
      logWarn("review", String(e));
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (!confirm) {
      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    setConfirm(false);
    if (!workDir || busy) return;
    setBusy(true);
    try {
      const { revertRun } = await import("../../lib/checkpoints");
      await revertRun(workDir, review.checkpointId);
      logInfo("review", `reverted to ${review.checkpointId}`);
      toast.success(t("review.reverted", "Изменения возвращены"));
      dismissReview(sessionId);
    } catch (e) {
      logWarn("review", String(e));
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="anim-pop-in mx-3 mt-2 shrink-0 rounded-xl border px-3 py-2"
      style={{
        borderColor: "color-mix(in srgb, var(--accent-500) 45%, transparent)",
        background: "color-mix(in srgb, var(--accent-500) 8%, var(--bg-primary))",
      }}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--accent-400)]" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {t("review.title", "Агент изменил файлы — проверить?")}
        </span>
        <span
          className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
          style={{ background: "var(--bg-quaternary)", color: "var(--text-secondary)" }}
        >
          {files.length}
        </span>
      </div>
      {files.length > 0 && (
        <ReviewDiff files={files.slice(0, 12)} extra={files.length - 12} />
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="btn-primary flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[13px]"
          onClick={accept}
        >
          <Check size={14} /> {t("review.keep", "Оставить")}
        </button>
        <button
          className="btn-secondary flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[13px]"
          disabled={busy || files.length === 0}
          onClick={() => {
            void import("../editor/AiReviewModal").then(({ openReview }) =>
              openReview({ sessionId, checkpointId: review.checkpointId, files }),
            );
          }}
          title={t("review.viewTitle", "Side-by-side diff: принять или вернуть каждый файл (Ctrl+Enter / Ctrl+Backspace)")}
        >
          <Columns2 size={14} /> {t("review.view", "Просмотр")}
        </button>
        <button
          className="btn-secondary flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[13px]"
          disabled={busy || files.length === 0}
          onClick={() => void reviewByAgent()}
          title={t("review.agentTitle", "Второй агент проверит изменения")}
        >
          <Eye size={14} /> {t("review.agent", "Ревью")}
        </button>
        <button
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border py-1.5 text-[13px] transition-colors ${
            confirm
              ? "border-red-500 bg-red-500/20 font-semibold text-red-400"
              : "border-red-500/50 text-red-500 hover:bg-red-500/10"
          }`}
          disabled={busy}
          onClick={() => void revert()}
        >
          <RotateCcw size={13} />{" "}
          {confirm ? t("review.sure", "Точно вернуть?") : t("review.revert", "Вернуть")}
        </button>
      </div>
    </div>
  );
}
import { Checkpoints } from "./Checkpoints";

export function ChatContainer() {
  const { t } = useTranslation();
  const activeId = useChatStore((s) => s.activeId);
  const messagesMap = useChatStore((s) => s.messagesBySession);
  const busy = useChatStore((s) => (activeId ? (s.busy[activeId] ?? false) : false));
  const errorBanner = useChatStore((s) => s.errorBanner);
  const setError = useChatStore((s) => s.setError);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setModel = useChatStore((s) => s.setModel);
  const sessions = useChatStore((s) => s.sessions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showRaw, setShowRaw] = useState(false);
  const [showNewBtn, setShowNewBtn] = useState(false);

  const activeSession = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  const currentModel = selectedModel ?? activeSession?.model?.id;

  const storeModels = useModelsStore((s) => s.models);
  const ratings = useModelsStore((s) => s.ratings);
  const ratingsUpdatedAt = useModelsStore((s) => s.ratingsUpdatedAt);
  const ratingsLoading = useModelsStore((s) => s.ratingsLoading);
  const refreshPricing = useModelsStore((s) => s.refreshPricing);
  const [addOpen, setAddOpen] = useState(false);
  const groups = useMemo(
    () => toSelectGroups(storeModels, currentModel, ratings, ratingsUpdatedAt),
    [storeModels, currentModel, ratings, ratingsUpdatedAt],
  );
  const ratingsHint = ratingsUpdatedAt
    ? t("chat.ratingsFresh", `Рейтинги от ${new Date(ratingsUpdatedAt).toLocaleDateString()}. Обновить?`)
    : t("chat.ratingsRefresh", "Обновить рейтинги моделей");
  const liveModel = findModel(storeModels, currentModel);
  const tok = activeSession?.tokens;
  const tokIn = (tok?.input ?? 0) + (tok?.cache?.read ?? 0);
  const tokOut = (tok?.output ?? 0) + (tok?.reasoning ?? 0);
  const hasUsage = tokIn > 0 || tokOut > 0 || (activeSession?.cost ?? 0) > 0;
  const ctxPct =
    liveModel && liveModel.context > 0 && tokIn > 0
      ? Math.min(100, (tokIn / liveModel.context) * 100)
      : 0;

  const messages = activeId ? (messagesMap[activeId] ?? []) : [];

  // Virtualize the message list: long sessions render only visible rows.
  // Dynamic heights are measured per row; estimate keeps the scrollbar sane.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    overscan: 6,
  });

  useEffect(() => {
    if (!stickToBottom.current) {
      // user is reading history — show button instead of auto-scrolling
      setShowNewBtn(true);
      return;
    }
    setShowNewBtn(false);
    if (messages.length === 0) return;
    // Defer a tick so fresh measurements land before jumping to the end.
    const id = requestAnimationFrame(() => {
      try {
        virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
      } catch {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight });
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy, activeId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = isBottom;
    if (isBottom) setShowNewBtn(false);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottom.current = true;
    setShowNewBtn(false);
  };

  if (!activeId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="text-center">
          <MessageSquareCode className="mx-auto h-10 w-10 opacity-40" />
          <h2 className="mt-3 text-lg font-semibold">{t("chat.emptyTitle")}</h2>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--text-secondary)" }}
          >
            {t("chat.emptySubtitle")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {errorBanner && (
        <div
          className="absolute inset-x-3 top-2 z-10 rounded-lg border px-3 py-2 text-xs"
          style={{
            borderColor: "rgba(239,68,68,0.35)",
            background: "color-mix(in srgb, #ef4444 10%, var(--bg-primary))",
          }}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-red-400">{t("chat.errorTitle")}</p>
              <p className="mt-0.5 break-words text-red-200/90">
                {errorBanner.message}
              </p>
              {errorBanner.raw && errorBanner.raw !== errorBanner.message && (
                <button
                  className="mt-1 text-[11px] text-red-400/80 hover:text-red-300 hover:underline"
                  onClick={() => setShowRaw((v) => !v)}
                >
                  {showRaw ? t("chat.errorHide") : t("chat.errorDetails")}
                </button>
              )}
              {showRaw && errorBanner.raw && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[11px] leading-relaxed text-red-200/70">
                  {errorBanner.raw}
                </pre>
              )}
            </div>
            <button
              onClick={() => {
                setShowRaw(false);
                setError(null);
              }}
              className="hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <Cpu size={14} className="shrink-0" style={{ color: "var(--accent-400)" }} />
        <span
          className="shrink-0 text-ui-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          {t("chat.model")}
        </span>
        <Select
          className="min-w-[200px] flex-1"
          value={currentModel ?? ""}
          onChange={(v) => void setModel(v)}
          groups={groups}
        />
        <button
          className="shrink-0 rounded-md p-1.5 hover:bg-[var(--hover)]"
          title={t("chat.addModel", "Добавить свою модель")}
          onClick={() => setAddOpen(true)}
        >
          <Plus size={14} style={{ color: "var(--text-secondary)" }} />
        </button>
        <Checkpoints />
        <button
          className="shrink-0 rounded-md p-1.5 hover:bg-[var(--hover)]"
          title={ratingsHint}
          onClick={() => void refreshPricing(true)}
        >
          <RefreshCw
            size={13}
            className={ratingsLoading ? "animate-spin" : ""}
            style={{ color: "var(--text-secondary)" }}
          />
        </button>
      </div>

      {hasUsage && (
        <div
          className="flex items-center gap-2 border-b px-3 py-1.5 text-ui-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
          title={
            liveModel
              ? `${liveModel.name} · ctx ${fmtContext(liveModel.context) || "?"}`
              : undefined
          }
        >
          <span className="shrink-0">
            ↑{fmtTokens(tokIn)} ↓{fmtTokens(tokOut)}
          </span>
          {(activeSession?.cost ?? 0) > 0 && (
            <span className="shrink-0">${activeSession!.cost!.toFixed(4)}</span>
          )}
          {ctxPct > 0 && (
            <>
              <div
                className="h-1 min-w-[60px] flex-1 overflow-hidden rounded-full"
                style={{ background: "var(--bg-quaternary)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${ctxPct.toFixed(1)}%`,
                    background:
                      ctxPct > 85
                        ? "#ef4444"
                        : "linear-gradient(90deg, var(--accent-600), var(--accent-400))",
                  }}
                />
              </div>
              <span className="shrink-0 tabular-nums">{ctxPct.toFixed(0)}%</span>
            </>
          )}
        </div>
      )}
      {addOpen && <AddModelDialog onClose={() => setAddOpen(false)} />}
      {activeId && <ReviewBanner sessionId={activeId} />}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4"
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const m = messages[vi.index];
            if (!m) return null;
            const isLive =
              busy && vi.index === messages.length - 1 && m.info.role === "assistant";
            return (
              <div
                key={m.info.id}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                  paddingBottom: 16,
                }}
              >
                <MessageBubble
                  message={m}
                  liveThinking={isLive}
                  streaming={isLive}
                />
              </div>
            );
          })}
        </div>

        {busy && (
          <div
            className="flex items-center gap-2 text-xs animate-pulse"
            style={{ color: "var(--text-secondary)" }}
          >
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            {t("chat.working")}
          </div>
        )}
      </div>

      {showNewBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg transition-all hover:scale-105"
          style={{
            background: "var(--bg-secondary)",
            borderColor: "var(--accent-500)",
            color: "var(--accent-400)",
            boxShadow: "0 4px 12px var(--ai-glow)",
          }}
        >
          ↓ {t("chat.newMessages", "Новые сообщения")}
        </button>
      )}
    </div>
  );
}
