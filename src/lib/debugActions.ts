import { invoke } from "@tauri-apps/api/core";
import { useDebugStore } from "../stores/debugStore";
import { useEditorStore } from "../stores/editorStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { logInfo, logWarn } from "../stores/outputStore";
import { toast } from "../stores/toastStore";
import { getActiveEditor } from "../components/editor/EditorInstance";
import {
  appendMissingConfig,
  buildRunCommand,
  ensureLaunchJson,
  readLaunchConfigs,
  type LaunchConfig,
} from "./launchConfig";
import { ensureBundledPython, resolvePip } from "./shell";

async function pickConfig(
  workDir: string,
): Promise<{ cfg: LaunchConfig | null; fromFile: boolean }> {
  const { configs } = await readLaunchConfigs(workDir);
  const active = useDebugStore.getState().activeConfig;
  const found = configs.find((c) => c.name === active) ?? configs[0] ?? null;
  return { cfg: found, fromFile: found !== null };
}

function openBottomTerminal(): void {
  void import("../stores/uiStore").then(({ useUiStore }) => {
    useUiStore.getState().setBottomOpen(true);
    useUiStore.getState().setBottomTab("terminal");
  });
}

async function openInBrowser(path: string, label: string): Promise<void> {
  try {
    if (/^https?:\/\//i.test(path)) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(path);
    } else {
      // NOTE: the plugin's JS openPath() is scope-gated and rejects local
      // files ("Not allowed to open path"). Our own `open_in_browser`
      // command calls the opener's Rust API directly — no scope check.
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_browser", { path });
    }
    logInfo("debug", `Opened in browser: ${label}`);
    toast.success(`Открыто в браузере: ${label}`);
  } catch (e) {
    const msg = `Не открылось в браузере: ${String(e)}`;
    logWarn("debug", msg);
    toast.error(msg);
  }
}

const HTML_RE = /\.(html?|xhtml)$/i;

/** Run active launch.json config (or auto-inferred file) in a shell tab. */
export async function debugStart(noDebug: boolean): Promise<void> {
  const workDir = useSettingsStore.getState().workDir;
  if (!workDir) {
    const msg = "Нет рабочей папки — откройте папку проекта";
    logWarn("debug", msg);
    toast.error(msg);
    return;
  }
  const activeFile = useEditorStore.getState().activePath ?? null;
  const { cfg } = await pickConfig(workDir);

  // HTML preview goes straight to the browser (no shell needed).
  const program = cfg?.program ?? activeFile ?? "";
  if (HTML_RE.test(program)) {
    const file = cfg?.program
      ? program
          .replace(/\$\{file\}/g, activeFile ?? "")
          .replace(/\$\{workspaceFolder\}/g, workDir)
      : (activeFile as string);
    await openInBrowser(file, file.split(/[\\/]/).pop() ?? file);
    return;
  }

  let cmd: string;
  let label: string;
  try {
    ({ cmd, label } = await buildRunCommand(workDir, cfg, activeFile));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn("debug", msg);
    toast.error(msg, {
      label: "Создать launch.json",
      run: () => void addConfiguration(),
    });
    return;
  }
  const t = useTerminalStore.getState();
  const id = t.newSession("shell");
  useTerminalStore.setState({ activeId: id });
  openBottomTerminal();
  const bps = useDebugStore.getState().breakpoints.filter((b) => b.enabled).length;
  const msg = `${noDebug ? "Run" : "Debug"}: ${label}${bps && !noDebug ? ` (${bps} breakpoints armed)` : ""}`;
  logInfo("debug", msg);
  toast.success(msg);
  const { sendToShell } = await import("../components/TerminalPanel");
  const ok = await sendToShell(id, `${cmd}\r`);
  if (!ok) {
    const fail = `Терминал не принял команду: ${label}`;
    logWarn("debug", fail);
    toast.error(fail);
    return;
  }
  useDebugStore.getState().setRun({
    label,
    termSessionId: id,
    cmd,
    startedAt: Date.now(),
  });
}

export async function debugStop(): Promise<void> {
  const run = useDebugStore.getState().run;
  if (!run) return;
  try {
    await invoke("pty_kill", { session: run.termSessionId });
  } catch {
    /* already dead */
  }
  useDebugStore.getState().setRun(null);
  logInfo("debug", `Stopped: ${run.label}`);
}

export async function debugRestart(): Promise<void> {
  const st = useDebugStore.getState();
  const last = st.run
    ? { label: st.run.label, cmd: st.run.cmd }
    : st.lastCmd;
  if (!last) {
    // nothing ran yet — plain start
    await debugStart(false);
    return;
  }
  if (st.run) await debugStop();
  const t = useTerminalStore.getState();
  const id = t.newSession("shell");
  useTerminalStore.setState({ activeId: id });
  openBottomTerminal();
  logInfo("debug", `Restart: ${last.label}`);
  const cmd = last.cmd;
  const { sendToShell } = await import("../components/TerminalPanel");
  const ok = await sendToShell(id, `${cmd}\r`);
  if (!ok) {
    const fail = `Терминал не принял команду: ${last.label}`;
    logWarn("debug", fail);
    toast.error(fail);
    return;
  }
  useDebugStore.getState().setRun({
    ...last,
    termSessionId: id,
    startedAt: Date.now(),
  });
}

/** Open .vscode/launch.json (create with defaults if missing). */
export async function openLaunchJson(): Promise<void> {
  const workDir = useSettingsStore.getState().workDir;
  if (!workDir) {
    const msg = "Нет рабочей папки — откройте папку проекта";
    logWarn("debug", msg);
    toast.error(msg);
    return;
  }
  try {
    const path = await ensureLaunchJson(workDir);
    await useEditorStore.getState().openFile(path, { preview: false });
  } catch (e) {
    const msg = `launch.json не открылся: ${String(e)}`;
    logWarn("debug", msg);
    toast.error(msg);
  }
}

/** Append the first missing default configuration, then open the file. */
export async function addConfiguration(): Promise<void> {
  const workDir = useSettingsStore.getState().workDir;
  if (!workDir) {
    const msg = "Нет рабочей папки — откройте папку проекта";
    logWarn("debug", msg);
    toast.error(msg);
    return;
  }
  try {
    const path = await appendMissingConfig(workDir);
    await useEditorStore.getState().openFile(path, { preview: false });
    logInfo("debug", `launch.json: ${path}`);
    toast.success("Конфигурация добавлена в launch.json");
  } catch (e) {
    const msg = `Не добавилось: ${String(e)}`;
    logWarn("debug", msg);
    toast.error(msg);
  }
}

function needEditor(): { path: string; line: number } | null {
  const ed = getActiveEditor();
  const path = useEditorStore.getState().activePath;
  const pos = ed?.getPosition();
  if (!path || !pos) {
    const msg = "Откройте файл и поставьте курсор на строку";
    logWarn("debug", msg);
    toast.info(msg);
    return null;
  }
  return { path, line: pos.lineNumber };
}

/** Toggle breakpoint at the cursor line of the active editor. */
export function toggleBreakpointAtCursor(): void {
  const at = needEditor();
  if (!at) return;
  useDebugStore.getState().toggle(at.path, at.line);
  const n = useDebugStore
    .getState()
    .breakpoints.filter((b) => b.path === at.path).length;
  toast.success(
    n > 0
      ? `Брейкпоинты в файле: ${n} (строка ${at.line} переключена)`
      : "Брейкпоинт снят",
  );
}

/** New breakpoint at cursor, optional condition via native prompt. */
export function newBreakpointAtCursor(): void {
  const at = needEditor();
  if (!at) return;
  const { path, line } = at;
  const cond = window.prompt("Условие брейкпоинта (пусто = обычный):", "");
  if (cond === null) return; // cancelled
  if (cond.trim()) {
    useDebugStore.getState().addConditional(path, line, cond);
    toast.success(`Условный брейкпоинт: строка ${line}`);
  } else {
    useDebugStore.getState().toggle(path, line);
  }
}

/** Install the Python debugger into the project venv (or system python). */
export async function installDebugpy(): Promise<void> {
  const workDir = useSettingsStore.getState().workDir;
  const pip = await resolvePip(workDir).catch(() => null);
  if (!pip) {
    const msg = "Python не найден — сначала установи Python";
    logWarn("debug", msg);
    toast.error(msg, {
      label: "Установить Python",
      run: () => void installPython(),
    });
    return;
  }
  // No pip module (rare) → bootstrap it first. Bare pip.exe needs no flags.
  const m = /^(.*) -m pip$/.exec(pip.cmd);
  const cmd = pip.hasPip
    ? `${pip.cmd} install debugpy`
    : m
      ? `${m[1]} -m ensurepip && ${pip.cmd} install debugpy`
      : `${pip.cmd} install debugpy`;
  const t = useTerminalStore.getState();
  const id = t.newSession("shell");
  useTerminalStore.setState({ activeId: id });
  openBottomTerminal();
  logInfo("debug", `Installing debugpy: ${cmd}`);
  const { sendToShell } = await import("../components/TerminalPanel");
  const ok = await sendToShell(id, `${cmd}\r`);
  if (!ok) {
    const fail = "Терминал не принял команду установки debugpy";
    logWarn("debug", fail);
    toast.error(fail);
  }
}

/**
 * One-click Python: bundled embeddable build first (offline after first
 * download), winget as fallback, python.org link as last resort.
 */
export async function installPython(): Promise<void> {
  toast.info("Готовлю встроенный Python (распаковка + pip)…");
  logInfo("python", "bundled setup started");
  try {
    const bin = await ensureBundledPython();
    if (bin) {
      const msg = `Python готов: ${bin}`;
      logInfo("python", msg);
      toast.success(msg);
      return;
    }
  } catch (e) {
    logWarn("python", `bundled setup failed: ${String(e)}, trying winget`);
  }
  const t = useTerminalStore.getState();
  const id = t.newSession("shell");
  useTerminalStore.setState({ activeId: id });
  openBottomTerminal();
  const cmd = "winget install -e --id Python.Python.3.12";
  logInfo("python", `Installing Python: ${cmd}`);
  toast.info("Ставлю Python через winget. После установки перезапусти терминал (+).", {
    label: "python.org",
    run: () => {
      void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
        openUrl("https://www.python.org/downloads/").catch(() => {}),
      );
    },
  });
  const { sendToShell } = await import("../components/TerminalPanel");
  const ok = await sendToShell(id, `${cmd}\r`);
  if (!ok) {
    const fail = "Терминал не принял команду. Открой https://www.python.org/downloads/ вручную.";
    logWarn("python", fail);
    toast.error(fail);
  }
}
