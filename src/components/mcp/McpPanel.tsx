import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Blocks,
  Plus,
  RefreshCw,
  Trash2,
  KeyRound,
  Bug,
  Globe,
  MonitorDown,
} from "lucide-react";
import {
  loadMcp,
  upsertMcpServer,
  setMcpEnabled,
  deleteMcpServer,
  describeServer,
  isLocal,
  type McpEntry,
  type McpListResult,
  type McpScope,
  type McpServer,
} from "../../lib/mcp";
import { showCtx } from "../../lib/ctx";
import { toast } from "../../stores/toastStore";

function restartAction() {
  return {
    label: "Перезапустить сервер",
    run: () => {
      void import("../../lib/vpn").then(({ restartOpencode }) =>
        restartOpencode()
          .then(() => toast.success("Сервер перезапущен"))
          .catch((e) => toast.error(`Рестарт не удался: ${e}`)),
      );
    },
  };
}

function afterChange(msg: string) {
  toast.success(msg, restartAction());
}

async function runInTerminal(cmd: string) {
  const { useTerminalStore } = await import("../../stores/terminalStore");
  const { sendToShell } = await import("../TerminalPanel");
  const { useSettingsStore } = await import("../../stores/settingsStore");
  const settings = useSettingsStore.getState();
  const bin = settings.binaryPath?.trim() || "opencode";
  const id = useTerminalStore.getState().openTerminal("shell");
  const ok = await sendToShell(id, `"${bin}" ${cmd}\r`);
  if (!ok) toast.error("Терминал ещё запускается — повторите");
}

function statusColor(s: McpEntry["status"]): string {
  if (!s || s.state === "unknown") return "var(--text-tertiary)";
  return s.state === "ok" ? "#22c55e" : "#f14c4c";
}

function McpRow({
  entry,
  projectPath,
  globalPath,
  onChanged,
}: {
  entry: McpEntry;
  projectPath: string | null;
  globalPath: string;
  onChanged: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = entry.server.enabled !== false;
  const local = isLocal(entry.server);

  const toggle = async (v: boolean) => {
    try {
      await setMcpEnabled(entry, v, projectPath, globalPath);
      onChanged(v ? `Включено: ${entry.name}` : `Выключено: ${entry.name}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const remove = async () => {
    if (!window.confirm(t("mcp.deleteConfirm", `Удалить сервер ${entry.name}?`))) return;
    try {
      await deleteMcpServer(entry, projectPath, globalPath);
      onChanged(`Удалено: ${entry.name}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div
      className="group rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--border-subtle)", opacity: enabled ? 1 : 0.55 }}
      onContextMenu={(e) =>
        showCtx(e, [
          {
            id: "copy",
            label: t("mcp.copyTarget", "Копировать команду/URL"),
            action: () =>
              void import("../../lib/clipboard").then(({ copyText }) =>
                copyText(describeServer(entry.server)),
              ),
          },
          {
            id: "open-conf",
            label: t("mcp.openConfig", "Открыть конфиг"),
            action: () =>
              void import("../../stores/editorStore").then(({ useEditorStore }) => {
                const file =
                  entry.scope === "project" ? projectPath : globalPath;
                if (file) void useEditorStore.getState().openFile(file, { preview: false });
              }),
          },
          { id: "del", label: t("menu.delete", "Удалить"), danger: true, action: () => void remove() },
        ])
      }
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          title={entry.status?.detail || t("mcp.noStatus", "Статус неизвестен")}
          style={{ background: statusColor(entry.status) }}
        />
        <span className="min-w-0 flex-1 truncate font-medium" title={entry.name}>
          {entry.name}
        </span>
        <span
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-px font-mono text-[11px]"
          style={{
            background: "color-mix(in srgb, var(--accent-500) 16%, transparent)",
            color: "var(--accent-300)",
          }}
          title={entry.scope === "project" ? projectPath ?? "" : globalPath}
        >
          {local ? <MonitorDown className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
          {local ? "local" : "remote"} · {entry.scope === "project" ? "proj" : "glob"}
        </span>
        <label className="flex shrink-0 cursor-pointer items-center" title={enabled ? "Включён" : "Выключен"}>
          <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        </label>
      </div>
      <div className="mt-1 truncate font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }} title={describeServer(entry.server)}>
        {describeServer(entry.server)}
      </div>
      <div className="mt-1 hidden gap-1 group-hover:flex">
        {!local && (
          <button
            className="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-[12px]"
            title="opencode mcp auth"
            onClick={() => void runInTerminal(`mcp auth ${entry.name}`).catch((e) => toast.error(String(e)))}
          >
            <KeyRound className="h-3 w-3" /> Auth
          </button>
        )}
        <button
          className="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-[12px]"
          title="opencode mcp debug"
          onClick={() => void runInTerminal(`mcp debug ${entry.name}`).catch((e) => toast.error(String(e)))}
        >
          <Bug className="h-3 w-3" /> Debug
        </button>
        <span className="flex-1" />
        <button
          className="btn-ghost px-1.5 py-0.5 text-[12px] hover:!text-red-400"
          title={t("menu.delete", "Удалить")}
          onClick={() => void remove()}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^=\s]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function AddDialog({
  projectPath,
  globalPath,
  onClose,
  onChanged,
}: {
  projectPath: string | null;
  globalPath: string;
  onClose: () => void;
  onChanged: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<McpScope>(projectPath ? "project" : "global");
  const [kind, setKind] = useState<"local" | "remote">("local");
  const [command, setCommand] = useState("npx -y ");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("https://");
  const [headers, setHeaders] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const id = name.trim();
    if (!/^[A-Za-z0-9_][\w\-.]*$/.test(id)) {
      setError(t("mcp.badName", "Имя: латиница, цифры, _ - ."));
      return;
    }
    let server: McpServer;
    if (kind === "local") {
      const parts = splitCommand(command.trim());
      if (parts.length === 0) {
        setError(t("mcp.badCommand", "Укажите команду запуска"));
        return;
      }
      server = { type: "local", command: parts, enabled: true };
      const e = parseKv(env);
      if (Object.keys(e).length > 0) server.environment = e;
    } else {
      if (!/^https?:\/\/.+\..+/.test(url.trim())) {
        setError(t("mcp.badUrl", "Укажите корректный URL"));
        return;
      }
      server = { type: "remote", url: url.trim(), enabled: true };
      const h = parseKv(headers);
      if (Object.keys(h).length > 0) server.headers = h;
    }
    try {
      await upsertMcpServer(scope, id, server, projectPath, globalPath);
      onChanged(`Добавлено: ${id}`);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="anim-pop-in w-[440px] max-w-full rounded-xl border p-4 shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
      >
        <h3 className="mb-3 text-[15px] font-semibold">{t("mcp.add", "Добавить MCP-сервер")}</h3>
        {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Имя</span>
            <input className="input-field w-full text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="context7" />
          </label>
          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Scope</span>
              <select className="input-field w-full text-sm" value={scope} onChange={(e) => setScope(e.target.value as McpScope)}>
                <option value="project" disabled={!projectPath}>Project{projectPath ? "" : " (нет проекта)"}</option>
                <option value="global">Global</option>
              </select>
            </label>
            <label className="block flex-1">
              <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Тип</span>
              <select className="input-field w-full text-sm" value={kind} onChange={(e) => setKind(e.target.value as "local" | "remote")}>
                <option value="local">local (команда)</option>
                <option value="remote">remote (URL)</option>
              </select>
            </label>
          </div>
          {kind === "local" ? (
            <>
              <label className="block">
                <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Команда</span>
                <input className="input-field w-full font-mono text-sm" value={command} onChange={(e) => setCommand(e.target.value)} placeholder='npx -y "@modelcontextprotocol/server-everything"' />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Env (K=V построчно)</span>
                <textarea className="input-field w-full font-mono text-sm" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="API_KEY=xxx" onContextMenu={(e) => void import("../../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))} />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>URL</span>
                <input className="input-field w-full font-mono text-sm" value={url} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Headers (K=V построчно)</span>
                <textarea className="input-field w-full font-mono text-sm" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization=Bearer xxx" onContextMenu={(e) => void import("../../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))} />
              </label>
            </>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-[13px]" onClick={onClose}>Отмена</button>
          <button className="btn-primary px-3 py-1.5 text-[13px]" onClick={() => void submit()}>Добавить</button>
        </div>
      </div>
    </div>
  );
}

export function McpPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<McpListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadMcp());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changed = useCallback(
    (msg: string) => {
      afterChange(msg);
      void refresh();
    },
    [refresh],
  );

  const project = data?.entries.filter((e) => e.scope === "project") ?? [];
  const global = data?.entries.filter((e) => e.scope === "global") ?? [];

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="section-header !justify-start flex-1">
          <Blocks className="h-4 w-4 shrink-0" />
          {t("nav.mcp", "MCP")}
        </span>
        <button className="icon-btn !p-1" title={t("mcp.add", "Добавить MCP-сервер")} onClick={() => setShowAdd(true)}>
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button className="icon-btn !p-1" title={t("aa.refresh", "Обновить")} onClick={() => void refresh()}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {loading && !data && (
          <p className="px-2 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
            {t("mcp.loading", "Читаю конфиги и статусы…")}
          </p>
        )}
        {data && project.length + global.length === 0 && !data.raw && (
          <p className="px-2 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
            {t("mcp.empty", "Серверов нет — добавьте первый кнопкой +")}
          </p>
        )}
        {project.length > 0 && (
          <section className="space-y-1.5">
            <h4 className="px-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
              Project
            </h4>
            {project.map((e) => (
              <McpRow key={`p:${e.name}`} entry={e} projectPath={data?.projectPath ?? null} globalPath={data?.globalPath ?? ""} onChanged={changed} />
            ))}
          </section>
        )}
        {global.length > 0 && (
          <section className="space-y-1.5">
            <h4 className="px-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
              Global
            </h4>
            {global.map((e) => (
              <McpRow key={`g:${e.name}`} entry={e} projectPath={data?.projectPath ?? null} globalPath={data?.globalPath ?? ""} onChanged={changed} />
            ))}
          </section>
        )}
        {data && data.raw && (
          <pre className="overflow-auto rounded-lg border p-2 font-mono text-[11px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {data.raw}
          </pre>
        )}
      </div>

      {showAdd && (
        <AddDialog
          projectPath={data?.projectPath ?? null}
          globalPath={data?.globalPath ?? ""}
          onClose={() => setShowAdd(false)}
          onChanged={changed}
        />
      )}
    </div>
  );
}
