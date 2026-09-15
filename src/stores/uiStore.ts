import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarView = "explorer" | "search" | "git" | "mcp" | "vpn" | null;
export type BottomTab = "terminal" | "output" | "problems";
export type AiTab = "chat" | "history" | "agents";

interface UiState {
  sidebarView: SidebarView;
  aiPanelOpen: boolean;
  aiTab: AiTab;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  setSidebarView: (v: SidebarView) => void;
  toggleSidebarView: (v: Exclude<SidebarView, null>) => void;
  setAiPanelOpen: (v: boolean) => void;
  setAiTab: (t: AiTab) => void;
  setBottomOpen: (v: boolean) => void;
  setBottomTab: (t: BottomTab) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarView: "explorer",
      aiPanelOpen: true,
      aiTab: "chat",
      bottomOpen: false,
      bottomTab: "terminal",
      setSidebarView: (sidebarView) => set({ sidebarView }),
      toggleSidebarView: (v) =>
        set((st) => ({ sidebarView: st.sidebarView === v ? null : v })),
      setAiPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      setAiTab: (aiTab) => set({ aiTab }),
      setBottomOpen: (bottomOpen) => set({ bottomOpen }),
      setBottomTab: (bottomTab) => set({ bottomTab }),
    }),
    {
      name: "nexuscode-ui",
      partialize: (s) => ({
        sidebarView: s.sidebarView,
        aiPanelOpen: s.aiPanelOpen,
        aiTab: s.aiTab,
        bottomOpen: s.bottomOpen,
        bottomTab: s.bottomTab,
      }),
    },
  ),
);
