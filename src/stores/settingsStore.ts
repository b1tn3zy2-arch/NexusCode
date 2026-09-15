import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  defaultTerminalProfiles,
  NEXUS_PROFILE_ID,
  type TermProfile,
} from "../lib/shell";

export type Theme = "system" | "dark" | "oled" | "light";
export type Lang = "en" | "ru";
export type AaProfile = "paranoid" | "developer" | "autopilot";
export type ConnectionMode = "native" | "pty";

export interface AutoApproveConfig {
  enabled: boolean;
  profile: AaProfile;
  delayMs: number;
  whitelist: string[];
  blacklist: string[];
  protectedFiles: string[];
}

export const DEFAULT_AUTO_APPROVE: AutoApproveConfig = {
  enabled: false,
  profile: "developer",
  delayMs: 1000,
  whitelist: [],
  blacklist: [],
  protectedFiles: [
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/secrets/**",
  ],
};

interface SettingsState {
  theme: Theme;
  lang: Lang;
  binaryPath: string;
  workDir: string;
  port: number | null;
  autoApprove: AutoApproveConfig;
  mode: ConnectionMode;
  /** Prefix outgoing prompts so models answer in Russian. Default ON. */
  respondRussian: boolean;
  /** Editor font size, px. */
  fontSize: number;
  /** Shell for plain terminal tabs ("" = auto: powershell.exe). */
  shell: string;
  /** Stream animation speed multiplier (0.5 slow .. 2 fast). */
  streamSpeed: number;
  /** Auto-check sidecar updates when Settings opens. */
  autoCheckUpdates: boolean;
  /** Update channel. */
  updateChannel: "stable" | "prerelease";
  /** Custom terminal profiles (VS Code style). */
  terminalProfiles: TermProfile[];
  /** Default profile id for new shell tabs. */
  defaultProfileId: string;
  /** OS notification when an agent run goes idle (loop/continuous/chat). */
  notifyOnDone: boolean;
  /** Monaco minimap (second render layer — off saves GPU on weak machines). */
  minimap: boolean;
  /** In-app UI animations. ON overrides the OS reduced-motion setting. */
  animations: boolean;
  setTheme: (t: Theme) => void;
  setLang: (l: Lang) => void;
  setBinaryPath: (p: string) => void;
  setWorkDir: (d: string) => void;
  setPort: (p: number | null) => void;
  setAutoApprove: (c: AutoApproveConfig) => void;
  setMode: (m: ConnectionMode) => void;
  setRespondRussian: (v: boolean) => void;
  setFontSize: (n: number) => void;
  setShell: (s: string) => void;
  setStreamSpeed: (n: number) => void;
  setAutoCheckUpdates: (v: boolean) => void;
  setUpdateChannel: (c: "stable" | "prerelease") => void;
  setTerminalProfiles: (p: TermProfile[]) => void;
  setDefaultProfileId: (id: string) => void;
  setNotifyOnDone: (v: boolean) => void;
  setMinimap: (v: boolean) => void;
  setAnimations: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      lang: "ru",
      binaryPath: "",
      workDir: "",
      port: null,
      autoApprove: DEFAULT_AUTO_APPROVE,
      mode: "native",
      respondRussian: true,
      fontSize: 14,
      shell: "",
      streamSpeed: 1,
      autoCheckUpdates: true,
      updateChannel: "stable",
      terminalProfiles: defaultTerminalProfiles(),
      defaultProfileId: "nexuscode",
      notifyOnDone: true,
      minimap: true,
      animations: true,
      setTheme: (theme) => set({ theme }),
      setLang: (lang) => set({ lang }),
      setBinaryPath: (binaryPath) => set({ binaryPath }),
      setWorkDir: (workDir) => set({ workDir }),
      setPort: (port) => set({ port }),
      setAutoApprove: (autoApprove) => set({ autoApprove }),
      setMode: (mode) => set({ mode }),
      setRespondRussian: (respondRussian) => set({ respondRussian }),
      setFontSize: (fontSize) =>
        set({
          fontSize: Number.isFinite(fontSize)
            ? Math.min(24, Math.max(10, Math.round(fontSize)))
            : 14,
        }),
      setShell: (shell) => set({ shell }),
      setStreamSpeed: (streamSpeed) =>
        set({
          streamSpeed: Number.isFinite(streamSpeed)
            ? Math.min(2, Math.max(0.5, streamSpeed))
            : 1,
        }),
      setAutoCheckUpdates: (autoCheckUpdates) => set({ autoCheckUpdates }),
      setUpdateChannel: (updateChannel) => set({ updateChannel }),
      setTerminalProfiles: (terminalProfiles) => {
        const clean = (terminalProfiles ?? [])
          .filter((p) => p && p.id && p.name && p.shell)
          .map((p) => ({
            id: String(p.id),
            name: String(p.name),
            shell: String(p.shell),
            args: Array.isArray(p.args) ? p.args.map(String) : [],
            icon: typeof p.icon === "string" ? p.icon : undefined,
            env:
              p.env && typeof p.env === "object"
                ? Object.fromEntries(
                    Object.entries(p.env).map(([k, v]) => [k, String(v)]),
                  )
                : undefined,
          }));
        set((s) => ({
          terminalProfiles: clean,
          defaultProfileId: clean.some((p) => p.id === s.defaultProfileId)
            ? s.defaultProfileId
            : (clean[0]?.id ?? "powershell"),
        }));
      },
      setDefaultProfileId: (defaultProfileId) => set({ defaultProfileId }),
      setNotifyOnDone: (notifyOnDone) => set({ notifyOnDone }),
      setMinimap: (minimap) => set({ minimap }),
      setAnimations: (animations) => set({ animations }),
    }),
    {
      name: "ocgui-settings",
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        const merged = {
          ...current,
          ...p,
          autoApprove: { ...DEFAULT_AUTO_APPROVE, ...(p.autoApprove ?? {}) },
        };
        // One-time migration: ensure the blessed NexusCode profile exists
        // and becomes the default unless the user explicitly picked another
        // (legacy installs defaulted to plain "powershell").
        try {
          const list = Array.isArray(merged.terminalProfiles)
            ? [...merged.terminalProfiles]
            : defaultTerminalProfiles();
          if (!list.some((x) => x?.id === NEXUS_PROFILE_ID)) {
            const nx = defaultTerminalProfiles().find(
              (x) => x.id === NEXUS_PROFILE_ID,
            );
            if (nx) list.unshift(nx);
          }
          merged.terminalProfiles = list;
          if (
            merged.defaultProfileId === "powershell" &&
            list.some((x) => x?.id === NEXUS_PROFILE_ID)
          ) {
            merged.defaultProfileId = NEXUS_PROFILE_ID;
          }
        } catch {
          /* keep merged as-is */
        }
        return merged;
      },
    },
  ),
);

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("theme-dark", "theme-light", "theme-oled");
  const effective: Exclude<Theme, "system"> =
    theme !== "system"
      ? theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  root.classList.add(`theme-${effective}`);
}
