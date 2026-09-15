import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Columns2, RotateCcw } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { normPath, useEditorStore } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { checkpointsApi, revertRun } from "../../lib/checkpoints";
import { toast } from "../../stores/toastStore";
import { logWarn } from "../../stores/outputStore";

/**
 * Cursor-style always-on review layer (mounted once in App):
 * - paints green/red review decorations on the open file while its
 *   session has a pending review (no modal needed to see them);
 * - floating bar with per-run actions: open diff view, accept all,
 *   revert all (with model sync, unlike the old banner path).
 */
export function AutoReview() {
  const { t } = useTranslation();
  const activeId = useChatStore((s) => s.activeId);
  const review = useChatStore((s) =>
    activeId ? s.pendingReview[activeId] : undefined,
  );
  const activePath = useEditorStore((s) => s.activePath);
  const workDir = useSettingsStore((s) => s.workDir);
  const decorOn = useSettingsStore((s) => s.reviewDecorations);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const root = workDir ? normPath(workDir.replace(/[\\/]+$/, "")) : "";
  const abs = activePath ? normPath(activePath) : null;
  const rel =
    review && abs && root && abs.startsWith(`${root}/`)
      ? abs.slice(root.length + 1)
      : null;
  const inReview = !!review && !!rel && review.files.includes(rel);

  // Reset the revert-all confirm when the review changes.
  useEffect(() => {
    setConfirmAll(false);
  }, [review?.checkpointId]);

  // Auto decorations for the open reviewed file.
  const decoKey = useRef("");
  useEffect(() => {
    let dead = false;
    void (async () => {
      const mod = await import("./EditorInstance").catch(() => null);
      if (dead || !mod) return;
      if (!review || !decorOn || !abs || !rel || !inReview || !root) {
        if (abs) {
          try {
            mod.clearReviewDecorations(abs);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const key = `${review.checkpointId}::${abs}`;
      if (decoKey.current === key) return;
      try {
        const hunks = await checkpointsApi.hunks(root, review.checkpointId, rel);
        if (dead) return;
        decoKey.current = key;
        mod.setReviewDecorations(abs, hunks);
      } catch {
        /* decorations are best-effort */
      }
    })();
    return () => {
      dead = true;
    };
  }, [review, decorOn, abs, rel, inReview, root]);

  // Drop all review marks once the review is gone.
  const hadReview = useRef(false);
  useEffect(() => {
    if (hadReview.current && !review) {
      decoKey.current = "";
      void import("./EditorInstance").then(({ clearReviewDecorations }) =>
        clearReviewDecorations(),
      ).catch(() => {});
    }
    hadReview.current = !!review;
  }, [review]);

  if (!review || !inReview || !abs || !rel) return null;
  const fileName = rel.split("/").pop() ?? rel;

  const openView = () => {
    void import("./AiReviewModal").then(({ openReview }) =>
      openReview({
        sessionId: activeId!,
        checkpointId: review.checkpointId,
        files: review.files,
      }),
    );
  };

  const acceptAll = () => {
    useChatStore.getState().dismissReview(activeId!);
    toast.success(t("review.kept", "Изменения приняты"));
  };

  const revertAll = async () => {
    if (!confirmAll) {
      setConfirmAll(true);
      window.setTimeout(() => setConfirmAll(false), 4000);
      return;
    }
    setConfirmAll(false);
    if (busy || !root) return;
    setBusy(true);
    try {
      await revertRun(root, review.checkpointId);
      useChatStore.getState().dismissReview(activeId!);
      toast.success(t("review.reverted", "Изменения возвращены"));
    } catch (e) {
      logWarn("review", String(e));
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="anim-pop-in fixed bottom-10 left-1/2 z-40 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-xl border px-3 py-1.5 shadow-2xl backdrop-blur"
      style={{
        background: "color-mix(in srgb, var(--bg-secondary) 92%, transparent)",
        borderColor: "color-mix(in srgb, var(--accent-500) 45%, transparent)",
      }}
      title={abs}
    >
      <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--accent-400)]" />
      <span className="min-w-0 max-w-[220px] truncate font-mono text-[12px]" style={{ color: "var(--text-secondary)" }}>
        {fileName}
      </span>
      <span
        className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
        style={{ background: "var(--bg-quaternary)", color: "var(--text-secondary)" }}
      >
        {review.files.length}
      </span>
      <button
        className="btn-secondary flex shrink-0 items-center gap-1 px-2 py-1 text-[12px]"
        onClick={openView}
        title={t("review.viewTitle", "Side-by-side diff: принять или вернуть каждый файл (Ctrl+Enter / Ctrl+Backspace)")}
      >
        <Columns2 size={13} /> {t("review.view", "Просмотр")}
      </button>
      <button
        className="btn-primary flex shrink-0 items-center gap-1 px-2 py-1 text-[12px]"
        onClick={acceptAll}
        title={t("review.keep", "Оставить")}
      >
        <Check size={13} /> {t("review.keep", "Оставить")}
      </button>
      <button
        className={`flex shrink-0 items-center gap-1 rounded-[10px] border px-2 py-1 text-[12px] transition-colors ${
          confirmAll
            ? "border-red-500 bg-red-500/20 font-semibold text-red-400"
            : "border-red-500/50 text-red-500 hover:bg-red-500/10"
        }`}
        disabled={busy}
        onClick={() => void revertAll()}
        title={t("review.revert", "Вернуть")}
      >
        <RotateCcw size={12} />{" "}
        {confirmAll ? t("review.sure", "Точно вернуть?") : t("review.revert", "Вернуть")}
      </button>
    </div>
  );
}
