import { create } from "zustand";
import type { LoopSnapshot } from "../services/backend";

interface LoopState {
  snapshot: LoopSnapshot;
  setSnapshot: (s: LoopSnapshot) => void;
  patchFromEvent: (payload: Partial<LoopSnapshot> & { type?: string }) => void;
}

const DEFAULT_SNAPSHOT: LoopSnapshot = {
  running: false,
  paused: false,
  phase: "idle",
  iteration: 0,
  maxIterations: 0,
  history: [],
  lastError: null,
  notice: null,
  stopReason: null,
  convergedCount: 0,
  gitAvailable: true,
  sessionId: null,
};

/** Fill server-shape gaps so a partial payload can never crash render. */
export function normalizeLoopSnapshot(
  s: Partial<LoopSnapshot>,
): LoopSnapshot {
  return {
    running: s.running ?? false,
    paused: s.paused ?? false,
    phase: typeof s.phase === "string" ? s.phase : "idle",
    iteration: typeof s.iteration === "number" ? s.iteration : 0,
    maxIterations: typeof s.maxIterations === "number" ? s.maxIterations : 0,
    history: Array.isArray(s.history) ? s.history : [],
    lastError: s.lastError ?? null,
    notice: typeof s.notice === "string" ? s.notice : null,
    stopReason: s.stopReason ?? null,
    convergedCount: typeof s.convergedCount === "number" ? s.convergedCount : 0,
    gitAvailable: s.gitAvailable ?? true,
    sessionId: s.sessionId ?? null,
  };
}

/** True when the payload is a full snapshot (not an event fragment). */
export function isLoopSnapshot(p: unknown): p is LoopSnapshot {
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray((p as { history?: unknown }).history)
  );
}

export const useLoopStore = create<LoopState>()((set) => ({
  snapshot: DEFAULT_SNAPSHOT,
  setSnapshot: (snapshot) => set({ snapshot: normalizeLoopSnapshot(snapshot) }),
  patchFromEvent: (payload) =>
    set((st) => ({
      snapshot: normalizeLoopSnapshot({ ...st.snapshot, ...stripEventType(payload) }),
    })),
}));

function stripEventType(
  payload: Partial<LoopSnapshot> & { type?: string },
): Partial<LoopSnapshot> {
  const { type, ...rest } = payload;
  void type;
  return rest;
}
