import { create } from "zustand";
import type { ContinuousSnapshot, ContVerifyReport } from "../services/backend";

interface ContState {
  snapshot: ContinuousSnapshot;
  setSnapshot: (s: ContinuousSnapshot) => void;
  patchFromEvent: (
    payload: Partial<ContinuousSnapshot> & { type?: string },
  ) => void;
}

const DEFAULT_SNAPSHOT: ContinuousSnapshot = {
  running: false,
  paused: false,
  phase: "idle",
  goal: "",
  steps: [],
  currentIndex: 0,
  checkpoints: [],
  startedAt: 0,
  actionsCount: 0,
  costUsd: 0,
  lastError: null,
  hitReason: null,
  stopReason: null,
  gitAvailable: true,
  sessionId: null,
  lastVerify: null,
};

function normalizeVerify(v: unknown): ContVerifyReport | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.command !== "string" || typeof r.ok !== "boolean") return null;
  return {
    command: r.command,
    ok: r.ok,
    attempt: typeof r.attempt === "number" ? r.attempt : 0,
    outputTail: typeof r.outputTail === "string" ? r.outputTail : "",
  };
}

/** Fill server-shape gaps so a partial payload can never crash render. */
export function normalizeContSnapshot(
  s: Partial<ContinuousSnapshot>,
): ContinuousSnapshot {
  return {
    running: s.running ?? false,
    paused: s.paused ?? false,
    phase: typeof s.phase === "string" ? s.phase : "idle",
    goal: typeof s.goal === "string" ? s.goal : "",
    steps: Array.isArray(s.steps) ? s.steps : [],
    currentIndex: typeof s.currentIndex === "number" ? s.currentIndex : 0,
    checkpoints: Array.isArray(s.checkpoints) ? s.checkpoints : [],
    startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
    actionsCount: typeof s.actionsCount === "number" ? s.actionsCount : 0,
    costUsd: typeof s.costUsd === "number" ? s.costUsd : 0,
    lastError: s.lastError ?? null,
    hitReason: s.hitReason ?? null,
    stopReason: s.stopReason ?? null,
    gitAvailable: s.gitAvailable ?? true,
    sessionId: s.sessionId ?? null,
    lastVerify: normalizeVerify(s.lastVerify),
  };
}

/** True when the payload is a full snapshot (not an event fragment). */
export function isContSnapshot(p: unknown): p is ContinuousSnapshot {
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray((p as { steps?: unknown }).steps)
  );
}

export const useContStore = create<ContState>()((set) => ({
  snapshot: DEFAULT_SNAPSHOT,
  setSnapshot: (snapshot) =>
    set({ snapshot: normalizeContSnapshot(snapshot) }),
  patchFromEvent: (payload) => {
    const { type, ...rest } = payload;
    void type;
    const clean: Partial<ContinuousSnapshot> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
    }
    set((st) => ({
      snapshot: normalizeContSnapshot({ ...st.snapshot, ...clean }),
    }));
  },
}));
