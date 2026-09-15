import { create } from "zustand";

interface AiFollowState {
  /** Auto-open files the agent edits + stream their changes (vibe watch). */
  enabled: boolean;
  /** Absolute path currently being watched, if any. */
  followedPath: string | null;
  setEnabled: (v: boolean) => void;
  setFollowed: (p: string | null) => void;
}

function loadEnabled(): boolean {
  try {
    const v = localStorage.getItem("nexuscode-ai-follow");
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

export const useAiFollowStore = create<AiFollowState>()((set) => ({
  enabled: loadEnabled(),
  followedPath: null,
  setEnabled: (enabled) => {
    try {
      localStorage.setItem("nexuscode-ai-follow", enabled ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ enabled });
  },
  setFollowed: (followedPath) => set({ followedPath }),
}));
