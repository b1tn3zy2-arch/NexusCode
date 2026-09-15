import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedHeight } from "./AnimatedPanel";
import {
  Repeat,
  Target,
  FlaskConical,
  Play,
  Pause,
  Square,
  AlertTriangle,
  ChevronDown,
  Check,
  Info,
} from "lucide-react";
import {
  loopApi,
} from "../services/backend";
import { useLoopStore } from "../stores/loopStore";
import { useChatStore } from "../stores/chatStore";
import { useServerStore } from "../stores/serverStore";
import { stopReasonText } from "../lib/stopReasons";

function useServerStatus() {
  return useServerStore((s) => s.status);
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  success: <Check className="h-3.5 w-3.5 text-green-500" />,
  converged: <Target className="h-3.5 w-3.5 text-accent-400" />,
  error: <AlertTriangle className="h-3.5 w-3.5 text-red-500" />,
  test_failure: <FlaskConical className="h-3.5 w-3.5 text-red-400" />,
};

export function LoopPanel() {
  const { t } = useTranslation();
  const snapshot = useLoopStore((s) => s.snapshot);
  const setSnapshot = useLoopStore((s) => s.setSnapshot);

  const activeId = useChatStore((s) => s.activeId);
  const sessions = useChatStore((s) => s.sessions);
  const serverStatus = useServerStatus();
  const activeSession = activeId ? sessions.find((s) => s.id === activeId) : undefined;

  const [prompt, setPrompt] = useState("");
  const [maxIterations, setMaxIterations] = useState(5);
  const [intervalMs, setIntervalMs] = useState(1500);
  const [autoCommit, setAutoCommit] = useState(true);
  const [runTests, setRunTests] = useState(false);
  const [testCommand, setTestCommand] = useState("npm test");
  const [noChangesThreshold, setNoChangesThreshold] = useState(2);
  const [successPattern, setSuccessPattern] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loopApi.status().then(setSnapshot).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = snapshot.running;
  // Belt-and-suspenders: wire data must never crash render, even if a
  // malformed event payload ever slips past store normalization.
  const history = snapshot.history ?? [];

  const start = async () => {
    setError(null);
    try {
      const snap = await loopApi.start({
        sessionId: activeId ?? "",
        prompt,
        maxIterations,
        intervalMs,
        autoCommit,
        runTests,
        testCommand: testCommand || null,
        stopOnTestFailure: true,
        noChangesThreshold,
        successPattern: successPattern || null,
      });
      setSnapshot(snap);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="section-card min-w-0 w-full max-w-full overflow-hidden">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <h3 className="section-header min-w-0 flex-1 !justify-start">
          <Repeat className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("loop.title")}</span>
        </h3>
        <span
          className="badge"
          style={{
            background:
              snapshot.phase === "done" || snapshot.phase === "idle"
                ? "var(--bg-quaternary)"
                : "color-mix(in srgb, var(--accent) 20%, transparent)",
            color:
              snapshot.phase === "done" || snapshot.phase === "idle"
                ? "var(--text-secondary)"
                : "var(--accent-300)",
          }}
        >
          {t(`loop.phase.${snapshot.phase}`, snapshot.phase)}
        </span>
      </div>

      {!running && (
        <>
          <p className="mb-2 text-ui-xs" style={{ color: "var(--text-tertiary)" }}>
            {t("loop.how", "Повторяет промпт до лимита итераций: тесты → коммит → проверка изменений. Стоп: лимит, success-паттерн или N пустых итераций подряд.")}
          </p>
          <textarea
            className="input-field h-20 resize-none"
            placeholder={t("loop.promptPlaceholder")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
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
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <NumField label={t("loop.maxIter")} value={maxIterations} onChange={setMaxIterations} min={1} max={200} width={64} />
                    <NumField label={t("loop.interval")} value={intervalMs} onChange={setIntervalMs} min={0} max={600000} width={80} />
                    <NumField label={t("loop.noChanges")} value={noChangesThreshold} onChange={setNoChangesThreshold} min={0} max={50} width={52} />
                  </div>

                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <label className="checkbox-row">
                      <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
                      {t("loop.autoCommit")}
                    </label>
                    <label className="checkbox-row">
                      <input type="checkbox" checked={runTests} onChange={(e) => setRunTests(e.target.checked)} />
                      {t("loop.runTests")}
                    </label>
                  </div>
                  {runTests && (
                    <input
                      className="input-field font-mono"
                      value={testCommand}
                      onChange={(e) => setTestCommand(e.target.value)}
                      placeholder="npm test"
                    />
                  )}
                  <input
                    className="input-field font-mono"
                    value={successPattern}
                    onChange={(e) => setSuccessPattern(e.target.value)}
                    placeholder={t("loop.successPattern")}
                  />
                </div>
          </AnimatedHeight>
        </>
      )}

      {running && activeSession && (
        <div className="mb-1.5 truncate text-ui-xs" style={{ color: "var(--text-tertiary)" }} title={activeSession.title}>
          {activeSession.title} · {activeSession.model?.id ?? "?"}
        </div>
      )}

      {running && (
        <div className="mb-2 flex items-center gap-2 text-ui-sm">
          <span>{t("loop.progress", {
            iteration: snapshot.iteration,
            max: snapshot.maxIterations,
          })}</span>
          {snapshot.convergedCount > 0 && (
            <span className="flex items-center gap-1" style={{ color: "var(--text-secondary)" }}>
              · <Target className="h-3.5 w-3.5 text-accent-400" />{snapshot.convergedCount}
            </span>
          )}
        </div>
      )}

      {(running || snapshot.paused) && (
        <div className="mb-2 flex gap-2">
          {snapshot.running && (
            <button
              className="btn-secondary flex-1 py-1.5"
              onClick={() => void loopApi.pause(!snapshot.paused)}
            >
              {snapshot.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
          )}
          <button
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-red-500/50 py-1.5 text-sm text-red-500 hover:bg-red-500/10"
            onClick={() => void loopApi.stop()}
          >
            <Square className="h-3.5 w-3.5" /> {t("chat.stop")}
          </button>
        </div>
      )}

      {!running && (
        <button
          className="btn-primary mt-2 w-full py-2"
          disabled={!prompt.trim() || !activeId || serverStatus !== "running"}
          onClick={() => void start()}
        >
          <Play className="h-4 w-4" /> {t("loop.start")}
        </button>
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
      {snapshot.notice && (
        <p
          className="mt-2 flex items-start gap-1.5 text-ui-xs"
          style={{ color: "var(--text-secondary)" }}
          title={snapshot.notice}
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {snapshot.notice}
        </p>
      )}
      {snapshot.lastError && (
        <p
          className="mt-2 flex items-start gap-1.5 truncate text-ui-xs"
          style={{ color: "#eab308" }}
          title={snapshot.lastError}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {snapshot.lastError}
        </p>
      )}
      {snapshot.stopReason && !running && (
        <p className="mt-2 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
          {t("loop.stoppedAs")}: {stopReasonText(snapshot.stopReason)}
        </p>
      )}

      {history.length > 0 && (
        <table className="mt-3 w-full text-left text-ui-xs">
          <thead style={{ color: "var(--text-secondary)" }}>
            <tr>
              <th className="pr-2 pb-1 font-medium">#</th>
              <th className="pr-2 pb-1 font-medium">{t("loop.files")}</th>
              <th className="pr-2 pb-1 font-medium">{t("loop.diff")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().slice(0, 8).map((it) => (
              <tr
                key={it.iteration}
                title={it.shortstat}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void import("../lib/ctx").then(({ showCtx }) =>
                    showCtx(e, [
                      {
                        id: "copy-stat",
                        label: t("loop.copyStat", "Копировать статистику"),
                        action: () =>
                          void import("../lib/clipboard").then(({ copyText }) =>
                            copyText(`#${it.iteration} ${it.shortstat}`),
                          ),
                      },
                      ...(it.commitHash
                        ? [
                            {
                              id: "copy-hash",
                              label: t("loop.copyHash", "Копировать хеш коммита"),
                              action: () =>
                                void import("../lib/clipboard").then(({ copyText }) =>
                                  copyText(it.commitHash!),
                                ),
                            } as const,
                          ]
                        : []),
                    ]),
                  );
                }}
              >
                <td className="py-1">{it.iteration}</td>
                <td>{(it.filesChanged ?? []).length}</td>
                <td className="max-w-[90px] truncate">{it.shortstat.replace("file(s) changed", "")}</td>
                <td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {STATUS_ICON[it.status] ?? it.status}
                    {it.testsOk === false && <FlaskConical className="h-3.5 w-3.5 text-red-400" />}
                    {it.commitHash && (
                      <span className="font-mono">{it.commitHash.slice(0, 6)}</span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  width,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  width: number;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
      <input
        type="number"
        className="input-field !w-auto min-w-0 shrink-0 px-2 py-1"
        style={{ width, maxWidth: "100%" }}
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
        }}
      />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}
