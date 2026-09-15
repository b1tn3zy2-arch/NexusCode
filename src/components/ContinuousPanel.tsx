import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedHeight } from "./AnimatedPanel";
import {
  Target,
  Check,
  X,
  Loader2,
  SkipForward,
  AlertTriangle,
  ChevronDown,
  Play,
  Pause,
  Square,
  RotateCcw,
  Circle,
} from "lucide-react";
import {
  continuousApi,
  type ContPlanStep,
} from "../services/backend";
import { useContStore } from "../stores/contStore";
import { useChatStore } from "../stores/chatStore";
import { useServerStore } from "../stores/serverStore";
import { Select } from "./Select";
import { stopReasonText } from "../lib/stopReasons";

const HIT_REASON_KEY: Record<string, string> = {
  limit_actions: "loop.phase.limit_actions",
  limit_time: "loop.phase.limit_time",
  limit_cost: "loop.phase.limit_cost",
  step_error: "loop.phase.step_error",
  validation_failed: "loop.phase.validation_failed",
};

function StepCard({ step, active }: { step: ContPlanStep; active: boolean }) {
  const { t } = useTranslation();
  const icon =
    step.status === "completed" ? (
      <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
    ) : step.status === "in_progress" ? (
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-400" />
    ) : step.status === "error" ? (
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
    ) : step.status === "skipped" ? (
      <SkipForward className="h-3.5 w-3.5 shrink-0 text-yellow-600" />
    ) : (
      <Circle className="h-3.5 w-3.5 shrink-0 text-gray-600" />
    );
  return (
    <div
      className="flex min-w-0 w-full max-w-full items-start gap-2 overflow-hidden rounded-lg border px-3 py-1.5 text-[13.5px] leading-snug"
      style={{
        borderColor:
          active ? "var(--accent)" : "var(--border-color)",
        background:
          step.status === "completed"
            ? "color-mix(in srgb, #22c55e 8%, transparent)"
            : undefined,
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void import("../lib/ctx").then(({ showCtx }) =>
          showCtx(e, [
            {
              id: "copy",
              label: t("cont.copyStep", "Копировать описание шага"),
              action: () =>
                void import("../lib/clipboard").then(({ copyText }) =>
                  copyText(`[${step.status}] ${step.description}`),
                ),
            },
          ]),
        );
      }}
    >
      {icon}
      <span className="min-w-0 flex-1 break-words">{step.description}</span>
      {(step.attempts ?? 0) > 1 && (
        <span
          className="badge shrink-0"
          title={t("cont.attemptsSuffix", "попытки")}
        >
          ×{step.attempts}
        </span>
      )}
    </div>
  );
}

function BudgetBar({
  label,
  cur,
  max,
  suffix,
  money,
}: {
  label: string;
  cur: number;
  max: number;
  suffix?: string;
  money?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
  const fmt = (v: number) => (money ? `$${v.toFixed(2)}` : `${Math.floor(v)}`);
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0">{label}</span>
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full"
        style={{ background: "var(--bg-quaternary)" }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: pct >= 90 ? "#ef4444" : "var(--accent-400)",
          }}
        />
      </div>
      <span className="shrink-0 tabular-nums">
        {fmt(cur)}/{money ? `$${max}` : `${max}${suffix ?? ""}`}
      </span>
    </div>
  );
}

export function ContinuousPanel() {
  const { t } = useTranslation();
  const snapshot = useContStore((s) => s.snapshot);
  const setSnapshot = useContStore((s) => s.setSnapshot);
  const activeId = useChatStore((s) => s.activeId);
  const sessions = useChatStore((s) => s.sessions);
  const serverStatus = useServerStore((s) => s.status);
  const activeSession = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  const sessionModel = activeSession?.model?.id ?? null;
  const sessionCost = activeSession?.cost ?? 0;

  const [goal, setGoal] = useState("");
  const [approvalMode, setApprovalMode] = useState<"auto" | "manual">("auto");
  const [maxActions, setMaxActions] = useState(200);
  const [maxTimeMinutes, setMaxTimeMinutes] = useState(720);
  const [maxCostUsd, setMaxCostUsd] = useState(20);
  const [checkpoints, setCheckpoints] = useState(true);
  const [detectSubtasks, setDetectSubtasks] = useState(true);
  const [autoVerify, setAutoVerify] = useState(true);
  const [verifyText, setVerifyText] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [maxRetries, setMaxRetries] = useState(3);
  const [untilDone, setUntilDone] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void continuousApi.status().then(setSnapshot).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = snapshot.running;
  // Belt-and-suspenders: wire data must never crash render.
  // (named cpList — `checkpoints` is already the form checkbox state)
  const steps = snapshot.steps ?? [];
  const cpList = snapshot.checkpoints ?? [];
  const doneCount = steps.filter((s) => s.status === "completed").length;
  const progress =
    steps.length > 0
      ? Math.round(((doneCount + (steps[snapshot.currentIndex]?.status === "in_progress" ? 0.5 : 0)) / steps.length) * 100)
      : 0;

  const elapsedMin =
    snapshot.startedAt > 0
      ? Math.max(0, Math.round((Date.now() - snapshot.startedAt) / 60000))
      : 0;

  const start = async () => {
    setError(null);
    try {
      const snap = await continuousApi.start({
        sessionId: activeId ?? "",
        goal,
        approvalMode,
        maxActions,
        maxTimeMinutes,
        maxCostUsd,
        checkpoints,
        runValidation: false,
        validationCommand: null,
        stopOnValidationError: true,
        detectSubtasks,
        verifyCommands: verifyText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        autoVerify,
        maxRetriesPerStep: maxRetries,
        untilDone,
      });
      setSnapshot(snap);
    } catch (e) {
      setError(String(e));
    }
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const cmds = await continuousApi.detectValidation(null);
      setVerifyText(cmds.join("\n"));
    } catch (e) {
      setError(String(e));
    } finally {
      setDetecting(false);
    }
  };

  const resumeSaved = async () => {
    setError(null);
    try {
      const snap = await continuousApi.resumeSaved();
      setSnapshot(snap);
    } catch (e) {
      setError(t("cont.noSavedRun", "нет сохранённого запуска"));
    }
  };

  return (
    <section className="section-card min-w-0 w-full max-w-full overflow-hidden">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <h3 className="section-header min-w-0 flex-1 !justify-start">
          <Target className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("cont.title")}</span>
        </h3>
        <span
          className="badge"
          style={{
            background:
              running || snapshot.phase === "awaiting_approval"
                ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                : "var(--bg-quaternary)",
            color:
              running || snapshot.phase === "awaiting_approval"
                ? "var(--accent-300)"
                : "var(--text-secondary)",
          }}
        >
          {t(`cont.phase.${snapshot.phase}`, snapshot.phase)}
        </span>
      </div>

      {!running && snapshot.phase !== "awaiting_approval" && (
        <>
          <textarea
            className="input-field h-20 resize-none"
            placeholder={t("cont.goalPlaceholder")}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onContextMenu={(e) =>
              void import("../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))
            }
          />
          <button
            className="mt-2 flex w-full select-none items-center justify-between rounded-md px-2 py-1 text-ui-xs hover:bg-white/5 hover:text-[var(--text-primary)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => setExpanded((v) => !v)}
          >
            <span>{t("loop.options")}</span>
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform duration-200"
              style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
          <AnimatedHeight open={expanded}>
              <div className="mt-2 min-w-0 space-y-2">
                  <label className="flex min-w-0 flex-wrap items-center gap-2 text-ui-sm" style={{ color: "var(--text-secondary)" }}>
                    <span className="shrink-0">{t("cont.approval")}</span>
                    <Select
                      className="!w-auto min-w-[110px] max-w-full"
                      value={approvalMode}
                      onChange={setApprovalMode}
                      options={[
                        { value: "manual", label: t("cont.manual") },
                        { value: "auto", label: t("cont.auto") },
                      ]}
                    />
                  </label>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Num label="steps" value={maxActions} onChange={setMaxActions} min={1} max={1000} w={56} />
                    <Num label="min" value={maxTimeMinutes} onChange={setMaxTimeMinutes} min={5} max={1440} w={64} />
                    <Num label="$" value={maxCostUsd} onChange={setMaxCostUsd} min={0.1} max={1000} w={60} />
                    <Num label={t("cont.retries", "попыток")} value={maxRetries} onChange={setMaxRetries} min={0} max={10} w={48} />
                  </div>
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <label className="checkbox-row">
                      <input type="checkbox" checked={checkpoints} onChange={(e) => setCheckpoints(e.target.checked)} />
                      {t("cont.checkpoints")}
                    </label>
                    <label className="checkbox-row">
                      <input type="checkbox" checked={detectSubtasks} onChange={(e) => setDetectSubtasks(e.target.checked)} />
                      {t("cont.subtasks")}
                    </label>
                    <label className="checkbox-row">
                      <input type="checkbox" checked={autoVerify} onChange={(e) => setAutoVerify(e.target.checked)} />
                      {t("cont.verify")}
                    </label>
                    <label className="checkbox-row">
                      <input type="checkbox" checked={untilDone} onChange={(e) => setUntilDone(e.target.checked)} />
                      {t("cont.untilDone")}
                    </label>
                  </div>
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-ui-xs" style={{ color: "var(--text-secondary)" }}>
                        {t("cont.verifyCommands")}
                      </span>
                      <button
                        className="btn-secondary shrink-0 px-2 py-0.5 text-ui-xs"
                        disabled={detecting}
                        onClick={() => void detect()}
                      >
                        {t("cont.detect", "Определить")}
                      </button>
                    </div>
                    <textarea
                      className="input-field h-16 resize-none font-mono"
                      placeholder="npm run build&#10;npm test"
                      value={verifyText}
                      onChange={(e) => setVerifyText(e.target.value)}
                      onContextMenu={(e) =>
                        void import("../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))
                      }
                    />
                  </div>
              </div>
          </AnimatedHeight>
        </>
      )}

      {/* awaiting approval */}
      {snapshot.phase === "awaiting_approval" && (
        <div className="space-y-2">
          <p className="text-ui-sm" style={{ color: "var(--text-secondary)" }}>
            {t("cont.planReady", { count: steps.length })}
          </p>
          <div className="max-h-52 space-y-1.5 overflow-y-auto">
            {steps.map((s) => (
              <StepCard key={s.id} step={{ ...s, status: "pending" }} active={false} />
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <button
              className="btn-primary flex-1 py-1.5"
              onClick={() => continuousApi.approvePlan(true).catch(() => {})}
            >
              <Check className="h-4 w-4" /> {t("cont.approve")}
            </button>
            <button
              className="btn-secondary flex-1 py-1.5"
              onClick={() => continuousApi.approvePlan(false).catch(() => {})}
            >
              <X className="h-4 w-4" /> {t("cont.reject")}
            </button>
          </div>
        </div>
      )}

      {/* executing / paused */}
      {(running || snapshot.paused) && (
        <>
          <div className="mb-1.5 flex items-center gap-1.5 text-ui-xs" style={{ color: "var(--text-tertiary)" }}>
            <span className="min-w-0 flex-1 truncate" title={activeSession?.title ?? ""}>
              {activeSession?.title ?? t("cont.noSession", "Сессия?")} · {sessionModel ?? "?"}
            </span>
          </div>
          <div className="mb-2 space-y-1 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
            <BudgetBar
              label={t("cont.budgetSteps", "Шаги")}
              cur={snapshot.actionsCount}
              max={maxActions}
            />
            <BudgetBar
              label={t("cont.budgetTime", "Время")}
              cur={elapsedMin}
              max={maxTimeMinutes}
              suffix={t("cont.minShort", "мин")}
            />
            <BudgetBar
              label="$"
              cur={snapshot.costUsd}
              max={maxCostUsd}
              money
            />
          </div>
          <div className="mb-1.5 flex items-center justify-between text-ui-sm">
            <span>
              {doneCount}/{snapshot.steps.length} · {elapsedMin}{t("cont.minShort")} · $
              {snapshot.costUsd.toFixed(3)}
            </span>
            <span style={{ color: "var(--text-secondary)" }}>{progress}%</span>
          </div>
          <div
            className="mb-3 h-1.5 overflow-hidden rounded-full"
            style={{ background: "var(--bg-quaternary)" }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress}%`,
                background: "linear-gradient(90deg, var(--accent-600), var(--accent-400))",
              }}
            />
          </div>

          {snapshot.hitReason && (
            <p className="mb-2 flex items-start gap-1.5 text-ui-xs" style={{ color: "#eab308" }}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t(HIT_REASON_KEY[snapshot.hitReason] ?? "", stopReasonText(snapshot.hitReason))}
            </p>
          )}

          {snapshot.lastVerify && (
            <p
              className="mb-2 flex min-w-0 items-start gap-1.5 text-ui-xs"
              style={{ color: snapshot.lastVerify.ok ? "#22c55e" : "#eab308" }}
              title={snapshot.lastVerify.outputTail || snapshot.lastVerify.command}
            >
              {snapshot.lastVerify.ok ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {t("cont.lastVerify")}: {snapshot.lastVerify.command} —{" "}
                {snapshot.lastVerify.ok
                  ? t("cont.verifyOk", "зелёная")
                  : t("cont.verifyFail", "красная")}
              </span>
            </p>
          )}

          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {steps.map((s, i) => (
              <StepCard key={s.id} step={s} active={i === snapshot.currentIndex} />
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            {!snapshot.paused ? (
              <button
                className="btn-secondary flex-1 py-1.5"
                onClick={() => continuousApi.pause(true).catch(() => {})}
              >
                <Pause className="h-4 w-4" />
              </button>
            ) : (
              <button
                className="btn-primary flex-1 py-1.5"
                onClick={() => continuousApi.resume().catch(() => {})}
              >
                <Play className="h-4 w-4" />
              </button>
            )}
            <button
              className="btn-secondary flex-1 py-1.5"
              onClick={() => continuousApi.skipStep().catch(() => {})}
              disabled={!running}
            >
              <SkipForward className="h-4 w-4" />
            </button>
            <button
              className="flex flex-1 items-center justify-center rounded-[10px] border border-red-500/50 py-1.5 text-red-500 hover:bg-red-500/10"
              onClick={() => continuousApi.stop().catch(() => {})}
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </div>

          {snapshot.paused && cpList.some((c) => c.hash) && (
            <button
              className="btn-secondary mt-2 w-full py-1.5"
              onClick={() => {
                const last = [...cpList].reverse().find((c) => c.hash);
                if (!last) return;
                // reset --hard destroys uncommitted work: explicit confirm.
                if (
                  !window.confirm(
                    t(
                      "cont.rollbackConfirm",
                      `Вернуть файлы к чекпоинту «${last.description}»? Несохранённые изменения пропадут.`,
                    ),
                  )
                )
                  return;
                void continuousApi.rollback(last.id).catch(() => {});
              }}
            >
              <RotateCcw className="h-4 w-4" /> {t("cont.rollback")}
            </button>
          )}
        </>
      )}

      {/* pre-start cost warning: the cap counts the whole session history */}
      {!running && snapshot.phase !== "awaiting_approval" && sessionCost > 0 && sessionCost >= maxCostUsd * 0.8 && (
        <p className="mt-2 flex items-start gap-1.5 text-ui-xs" style={{ color: "#eab308" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("cont.costWarn", `Сессия уже потратила $${sessionCost.toFixed(2)} из $${maxCostUsd} — подними лимит, иначе остановится сразу`)}
        </p>
      )}

      {/* finished summary */}
      {!running && !snapshot.paused && snapshot.stopReason && (
        <p className="mt-2 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
          {t("loop.stoppedAs")}: {stopReasonText(snapshot.stopReason)} · {doneCount}/{steps.length}
        </p>
      )}

      {!running && snapshot.phase !== "awaiting_approval" && (
        <>
          <button
            className="btn-primary mt-3 w-full py-2"
            disabled={!goal.trim() || !activeId || serverStatus !== "running"}
            onClick={() => void start()}
          >
            <Play className="h-4 w-4" /> {t("cont.start")}
          </button>
          <button
            className="btn-secondary mt-2 w-full py-1.5"
            disabled={!activeId || serverStatus !== "running"}
            onClick={() => void resumeSaved()}
          >
            <RotateCcw className="h-4 w-4" /> {t("cont.resumeSaved")}
          </button>
        </>
      )}

      {!activeId && (
        <p className="mt-2 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
          {t("loop.needsSession")}
        </p>
      )}
      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-ui-xs text-red-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {snapshot.lastError && (
        <p className="mt-2 flex items-start gap-1.5 truncate text-ui-xs" style={{ color: "#eab308" }} title={snapshot.lastError}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {snapshot.lastError}
        </p>
      )}
    </section>
  );
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
  w,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  w: number;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
      <input
        type="number"
        className="input-field !w-auto min-w-0 shrink-0 px-2 py-1"
        style={{ width: w, maxWidth: "100%" }}
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}
