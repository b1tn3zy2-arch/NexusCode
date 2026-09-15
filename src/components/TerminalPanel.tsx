import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { TerminalSquare, Terminal as TerminalIcon, RotateCw, Eraser } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useContextMenuStore } from "../stores/contextMenuStore";
import { useTerminalMenu } from "./menus";
import { defaultShell, detectVenv, NEXUS_PROFILE_ID, type TermProfile } from "../lib/shell";

/** NexusCode palette for xterm — matches app theme tokens. */
function termPalette(dark: boolean, oled: boolean) {
  if (!dark) {
    return {
      background: "#ffffff",
      foreground: "#1a1a1a",
      cursor: "#4f46e5",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(99,102,241,.25)",
      black: "#3f3f46", red: "#dc2626", green: "#16a34a", yellow: "#d97706",
      blue: "#4f46e5", magenta: "#9333ea", cyan: "#0891b2", white: "#71717a",
      brightBlack: "#a1a1aa", brightRed: "#ef4444", brightGreen: "#22c55e",
      brightYellow: "#eab308", brightBlue: "#6366f1", brightMagenta: "#a855f7",
      brightCyan: "#06b6d4", brightWhite: "#18181b",
    };
  }
  const background = oled ? "#000000" : "#14141b";
  return {
    background,
    foreground: "#e8e8ef",
    cursor: "#818cf8",
    cursorAccent: background,
    selectionBackground: "rgba(99,102,241,.35)",
    black: "#1e1e26", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
    blue: "#818cf8", magenta: "#c084fc", cyan: "#67e8f9", white: "#e8e8ef",
    brightBlack: "#55556a", brightRed: "#fca5a5", brightGreen: "#86efac",
    brightYellow: "#fde047", brightBlue: "#a5b4fc", brightMagenta: "#d8b4fe",
    brightCyan: "#a5f3fc", brightWhite: "#ffffff",
  };
}

export function termIsDark(theme: string): { dark: boolean; oled: boolean } {
  if (theme === "dark") return { dark: true, oled: false };
  if (theme === "oled") return { dark: true, oled: true };
  if (theme === "light") return { dark: false, oled: false };
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { dark, oled: false };
}

/** Branded prompt for the NexusCode profile only (native shells untouched). */
const NEXUS_PS_PROMPT = [
  "function global:prompt {",
  "  $p = (Get-Location).Path.replace($HOME, '~');",
  "  Write-Host $p -NoNewline -ForegroundColor DarkGray;",
  "  Write-Host ' ❯' -NoNewline -ForegroundColor Magenta;",
  "  return ' '",
  "}",
].join(" ");
import { clearTermBuffer, pushTermChunk, replayTermBuffer } from "../lib/termBuffer";

interface SpawnSpec {
  bin: string;
  args: string[] | null;
  env: Record<string, string> | null;
  venv: string | null;
  /** NexusCode profile: backend prepends bundled python to PATH. */
  nexuscode: boolean;
}

async function buildSpawn(
  kind: "opencode" | "shell",
  binaryPath: string,
  workDir: string,
  shellPref: string,
  profile: TermProfile | null,
): Promise<SpawnSpec> {
  if (kind === "shell") {
    // venv auto-activation via env (works in PowerShell and cmd alike)
    let venv: string | null = null;
    try {
      venv = await detectVenv(workDir);
    } catch {
      venv = null;
    }
    if (profile) {
      // NexusCode profile: styled prompt, nothing else touched.
      let extraArgs = profile.args;
      if (
        profile.id === NEXUS_PROFILE_ID &&
        /powershell(\.exe)?$/i.test(profile.shell.trim()) &&
        !profile.args.some((a) => /^-Command$/i.test(a.trim()))
      ) {
        extraArgs = [...profile.args, "-NoExit", "-Command", NEXUS_PS_PROMPT];
      }
      let bin = profile.shell.trim();
      if (bin === "__bundled_python__") {
        const { bundledStatus } = await import("../lib/shell");
        const st = await bundledStatus().catch(() => null);
        if (!st?.installed || !st.bin) {
          throw new Error(
            "Python REPL: встроенный Python не распакован — Run → Install Python…",
          );
        }
        bin = st.bin;
      }
      if (!bin) throw new Error("В профиле не указан шелл");
      const args =
        extraArgs.length > 0
          ? extraArgs
          : /powershell(\.exe)?$/i.test(bin)
            ? ["-NoLogo"]
            : null;
      return { bin, args, env: profile.env ?? null, venv, nexuscode: true };
    }
    const bin = shellPref.trim() || defaultShell();
    const args = /powershell(\.exe)?$/i.test(bin) ? ["-NoLogo"] : null;
    return { bin, args, env: null, venv, nexuscode: true };
  }
  return { bin: binaryPath || "opencode", args: null, env: null, venv: null, nexuscode: false };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64FromText(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

interface PtyEvent {
  session: string;
  data: string;
}

export interface TermHandle {
  getSelection: () => string;
  paste: (text: string) => void;
  clear: () => void;
  focus: () => void;
}

const termHandles = new Map<string, TermHandle>();
let lastTermSession: string | null = null;

/** Handle of the last interacted-with (or first available) terminal. */
export function getTermHandle(sessionId?: string | null): (TermHandle & { sessionId: string }) | null {
  const pick = (id: string) => {
    const h = termHandles.get(id);
    return h ? { sessionId: id, ...h } : null;
  };
  if (sessionId) return pick(sessionId);
  if (lastTermSession) {
    const h = pick(lastTermSession);
    if (h) return h;
  }
  const first = termHandles.keys().next();
  if (!first.done) return pick(first.value);
  return null;
}

export async function pasteToTerm(sessionId: string, text: string): Promise<boolean> {
  if (!text) return true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    await invoke("pty_write", { session: sessionId, dataB64: btoa(bin) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write text to a (possibly just spawned) shell session, retrying while the
 * backend session appears. Returns false when it never became writable.
 */
export async function sendToShell(
  sessionId: string,
  text: string,
  timeoutMs = 6000,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (await pasteToTerm(sessionId, text)) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function TerminalPanel({
  sessionId,
  visible = true,
}: {
  sessionId: string;
  /** Hidden tabs stay mounted (buffer + backend survive switching). */
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [spawned, setSpawned] = useState(false);
  const [exited, setExited] = useState(false);

  const binaryPath = useSettingsStore((s) => s.binaryPath);
  const workDir = useSettingsStore((s) => s.workDir);
  const shellPref = useSettingsStore((s) => s.shell);
  const appTheme = useSettingsStore((s) => s.theme);
  const termFontSize = useSettingsStore((s) => s.fontSize);
  const { dark: isDarkTerm, oled: isOledTerm } = termIsDark(appTheme);
  const kind = useTerminalStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.kind ?? "opencode",
  );
  const profileId = useTerminalStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.profileId ?? null,
  );
  const profile = useSettingsStore((s) =>
    profileId ? (s.terminalProfiles.find((p) => p.id === profileId) ?? null) : null,
  );
  const specRef = useRef<SpawnSpec | null>(null);
  const termMenu = useTerminalMenu();
  const termMenuRef = useRef(termMenu);
  termMenuRef.current = termMenu;

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;

    const pal = termPalette(isDarkTerm, isOledTerm);
    const term = new Terminal({
      fontSize: termFontSize,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      cursorBlink: true,
      cursorStyle: "bar",
      theme: pal,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;
    lastTermSession = sessionId;
    termHandles.set(sessionId, {
      getSelection: () => {
        try {
          return term.getSelection();
        } catch {
          return "";
        }
      },
      paste: (text) => void pasteToTerm(sessionId, text).catch(() => {}),
      clear: () => {
        try {
          term.clear();
        } catch {
          /* ignore */
        }
      },
      focus: () => {
        try {
          term.focus();
        } catch {
          /* ignore */
        }
      },
    });

    term.onData((data) => {
      void invoke("pty_write", { session: sessionId, dataB64: b64FromText(data) }).catch(() => {});
    });

    const unlistenP = listen<PtyEvent>("oc-pty", (e) => {
      if (e.payload.session !== sessionId) return;
      if (e.payload.data === "__EXITED__") {
        setExited(true);
        return;
      }
      pushTermChunk(sessionId, e.payload.data);
      try {
        term.write(b64ToBytes(e.payload.data));
      } catch {
        /* ignore malformed chunk */
      }
    });

    const doFit = () => {
      try {
        fit.fit();
        invoke("pty_resize", { session: sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
      } catch {
        /* not sized yet */
      }
    };
    const ro = new ResizeObserver(() => {
      // wait a frame so flex layout settles, like VS Code
      requestAnimationFrame(doFit);
    });
    ro.observe(hostRef.current);
    // also refit when the whole window resizes
    window.addEventListener("resize", doFit);
    // initial fit after open
    requestAnimationFrame(doFit);
    setTimeout(doFit, 50);

    void (async () => {
      try {
        // Remount (panel reopen, tab switch at BottomPanel level): if the
        // backend process is still alive, attach instead of respawning —
        // respawning would wipe the running session.
        let alive = false;
        try {
          alive = await invoke<boolean>("pty_alive", { session: sessionId });
        } catch {
          alive = false;
        }
        if (!alive) {
          const spec = await buildSpawn(kind, binaryPath, workDir || ".", shellPref, profile);
          specRef.current = spec;
          await invoke("pty_spawn", {
            session: sessionId,
            binaryPath: spec.bin,
            workDir: workDir || ".",
            rows: term.rows,
            cols: term.cols,
            args: spec.args,
            env: spec.env,
            venv: spec.venv,
            bundled_python: spec.nexuscode,
          });
        }
        // Replay buffered scrollback so a remounted tab doesn't look blank.
        try {
          for (const c of replayTermBuffer(sessionId)) term.write(b64ToBytes(c));
        } catch {
          /* ignore malformed chunks */
        }
        setSpawned(true);
        term.focus();
      } catch (err) {
        setExited(true);
        term.writeln(`\r\n[spawn failed] ${err}`);
      }
    })();

    return () => {
      // NOTE: no pty_kill here on purpose — hiding a tab (switch/split)
      // must NOT kill the backend. Only explicit close kills (store).
      ro.disconnect();
      window.removeEventListener("resize", doFit);
      termHandles.delete(sessionId);
      if (lastTermSession === sessionId) lastTermSession = null;
      void unlistenP.then((un) => un());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setSpawned(false);
      setExited(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live-apply theme + font size without respawning the shell.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = termFontSize;
      term.options.theme = termPalette(isDarkTerm, isOledTerm) as never;
      fitRef.current?.fit();
    } catch {
      /* not ready */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termFontSize, appTheme]);

  // When a hidden tab becomes visible: refit (size was 0), sync backend,
  // focus. This is what makes switching lossless.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    lastTermSession = sessionId;
    const t = setTimeout(() => {
      try {
        fit.fit();
        invoke(
          "pty_resize",
          { session: sessionId, rows: term.rows, cols: term.cols },
        ).catch(() => {});
        term.focus();
      } catch {
        /* not sized yet */
      }
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId]);

  const restart = () => {
    // remount by key trick is handled by parent; here just respawn
    const term = termRef.current;
    if (!term) return;
    term.reset();
    clearTermBuffer(sessionId);
    setExited(false);
    const spec = specRef.current;
    const run = spec
      ? invoke("pty_spawn", {
          session: sessionId,
          binaryPath: spec.bin,
          workDir: workDir || ".",
          rows: term.rows,
          cols: term.cols,
          args: spec.args,
          env: spec.env,
          venv: spec.venv,
          bundled_python: spec.nexuscode,
        })
      : (async () => {
          const s = await buildSpawn(kind, binaryPath, workDir || ".", shellPref, profile);
          specRef.current = s;
          await invoke("pty_spawn", {
            session: sessionId,
            binaryPath: s.bin,
            workDir: workDir || ".",
            rows: term.rows,
            cols: term.cols,
            args: s.args,
            env: s.env,
            venv: s.venv,
            bundled_python: s.nexuscode,
          });
        })();
    void run.then(() => setSpawned(true)).catch(() => {});
  };

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <div
        className="flex w-full min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b px-3 py-1.5 text-xs"
        style={{ borderColor: "var(--border-color)", color: "var(--text-secondary)" }}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate font-medium" style={{ color: "var(--text-primary)" }}>
          {kind === "shell" ? (
            <TerminalIcon className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">
            {kind === "shell" ? t("terminal.shell", "Shell") : t("terminal.title")}
          </span>
        </span>
        <span className="flex-1" />
        <button
          className="shrink-0 rounded p-1 hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
          title={t("terminal.clear", "Очистить")}
          onClick={() => getTermHandle(sessionId)?.clear()}
        >
          <Eraser size={13} />
        </button>
        {exited && (
          <button className="btn-primary shrink-0 px-2 py-0.5 text-[13px]" onClick={restart}>
            <RotateCw className="h-3 w-3" /> {t("terminal.restart")}
          </button>
        )}
      </div>
      <div
        ref={hostRef}
        className="mx-2 mb-2 mt-1 min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl px-2 py-1"
        style={{
          // Borderless frame on matched background: no light edge lines,
          // only the radius reads as a frame.
          background: termPalette(isDarkTerm, isOledTerm).background,
        }}
        onMouseDown={() => {
          lastTermSession = sessionId;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          lastTermSession = sessionId;
          useContextMenuStore.getState().show(e.clientX, e.clientY, termMenuRef.current);
        }}
      />
      {!spawned && !exited && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>
          …
        </div>
      )}
    </div>
  );
}
