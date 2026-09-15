import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield, ShieldOff, Plus, Trash2, Star, RefreshCw, Zap } from "lucide-react";
import { useVpnStore } from "../../stores/vpnStore";
import { vpnApi } from "../../lib/vpn";
import { toast } from "../../stores/toastStore";

const PROTO_COLOR: Record<string, string> = {
  vless: "#8b5cf6",
  vmess: "#3b82f6",
  ss: "#22c55e",
  trojan: "#eab308",
  hysteria2: "#f97316",
  tuic: "#ec4899",
};

export function VpnDot({ size = 8 }: { size?: number }) {
  const status = useVpnStore((s) => s.status);
  const color =
    status === "connected"
      ? "#22c55e"
      : status === "connecting" || status === "reconnecting"
        ? "#eab308"
        : status === "error"
          ? "#ef4444"
          : "var(--text-tertiary)";
  return (
    <span
      className={
        status === "connecting" || status === "reconnecting"
          ? "animate-pulse"
          : undefined
      }
      title={`VPN: ${status}`}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 9999,
        background: color,
        boxShadow: status === "connected" ? "0 0 8px #22c55e88" : undefined,
        flexShrink: 0,
      }}
    />
  );
}

export function VpnSection() {
  const { t } = useTranslation();
  const servers = useVpnStore((s) => s.servers);
  const favorites = useVpnStore((s) => s.favorites);
  const activeId = useVpnStore((s) => s.activeId);
  const status = useVpnStore((s) => s.status);
  const error = useVpnStore((s) => s.error);
  const port = useVpnStore((s) => s.port);
  const pingCache = useVpnStore((s) => s.pingCache);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // Refresh pings once per mount (cached 60s in the store).
  useEffect(() => {
    const { servers: list, ping } = useVpnStore.getState();
    void (async () => {
      for (const s of list) {
        try {
          await ping(s.id);
        } catch {
          /* one host down must not block the rest */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile with a proxy left running by a previous session.
  useEffect(() => {
    void useVpnStore.getState().syncStatus();
  }, []);

  const add = async () => {
    const text = input.trim();
    if (!text) return;
    setBusy(true);
    try {
      if (/^https?:\/\//i.test(text)) {
        const { servers: fresh, failed } = await vpnApi.importSubscription(text);
        const { servers: cur, setServers } = useVpnStore.getState();
        const byId = new Map(cur.map((s) => [s.id, s]));
        for (const s of fresh) byId.set(s.id, s);
        setServers([...byId.values()]);
        setInput("");
        toast.success(
          failed > 0
            ? t("vpn.subPartial", `Подписка: ${fresh.length} ok, ${failed} не распознано`)
            : t("vpn.subOk", `Подписка: добавлено ${fresh.length}`),
        );
      } else {
        const srv = await vpnApi.parseLink(text);
        useVpnStore.getState().addServer(srv);
        setInput("");
        toast.success(t("vpn.added", `Добавлено: ${srv.name}`));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = servers.find((s) => s.id === activeId);

  return (
    <div className="space-y-4">
      {/* status */}
      <div
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]"
        style={{ borderColor: "var(--border-color)" }}
      >
        <VpnDot size={10} />
        <span className="font-medium">
          {status === "connected"
            ? t("vpn.connected", "Подключено")
            : status === "connecting" || status === "reconnecting"
              ? status === "reconnecting"
                ? t("vpn.reconnecting", "Переподключение…")
                : t("vpn.connecting", "Подключение…")
              : status === "error"
                ? t("vpn.error", "Ошибка")
                : t("vpn.off", "Отключено")}
        </span>
        {status === "connected" && active && (
          <span className="truncate" style={{ color: "var(--text-secondary)" }}>
            {active.name}
            {port ? ` · 127.0.0.1:${port}` : ""}
          </span>
        )}
        <span className="flex-1" />
        {status === "connected" ||
        status === "connecting" ||
        status === "reconnecting" ? (
          <button
            className="btn-ghost flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]"
            onClick={() => void useVpnStore.getState().disconnect()}
          >
            <ShieldOff className="h-3.5 w-3.5" />
            {t("vpn.disconnect", "Отключить")}
          </button>
        ) : null}
      </div>
      {status === "error" && error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* add key / subscription */}
      <div>
        <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          {t("vpn.addTitle", "Ключ или подписка (как в Happ)")}
        </span>
        <div className="flex gap-2">
          <input
            className="input-field min-w-0 flex-1 font-mono text-[12px]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="vless://… · hy2://… · ss://… · https://sub/…"
            spellCheck={false}
          />
          <button className="btn-primary flex items-center gap-1.5 px-3" disabled={busy || !input.trim()} onClick={() => void add()}>
            <Plus className="h-4 w-4" />
            {t("vpn.add", "Добавить")}
          </button>
        </div>
      </div>

      {/* servers */}
      <div className="space-y-1.5">
        {servers.length === 0 && (
          <p className="px-1 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            {t("vpn.empty", "Нет серверов — вставьте ключ или ссылку на подписку выше.")}
          </p>
        )}
        {servers.map((s) => {
          const isActive =
            s.id === activeId &&
            (status === "connected" || status === "reconnecting");
          const isFav = favorites.includes(s.id);
          const ping = pingCache[s.id];
          return (
            <div
              key={s.id}
              className="rounded-lg border px-3 py-2"
              style={{
                borderColor: isActive ? "#22c55e66" : "var(--border-subtle)",
                background: isActive ? "#22c55e0d" : undefined,
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-px font-mono text-[11px] font-semibold"
                  style={{
                    background: `${PROTO_COLOR[s.protocol] ?? "#888"}22`,
                    color: PROTO_COLOR[s.protocol] ?? "#aaa",
                  }}
                >
                  {s.protocol}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={`${s.name}\n${s.host}:${s.port}`}>
                  {isFav && <span className="mr-1 text-yellow-400">★</span>}
                  {s.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }} title="ping (TCP)">
                  {ping ? `${ping.ms}ms` : "—"}
                </span>
                <button
                  className="btn-ghost px-1.5 py-0.5 text-[12px]"
                  title="Ping"
                  onClick={() => void useVpnStore.getState().ping(s.id)}
                >
                  <Zap className="h-3 w-3" />
                </button>
                <button
                  className="btn-ghost px-1.5 py-0.5 text-[12px]"
                  title={isFav ? "Убрать из избранного" : "В избранное"}
                  onClick={() => useVpnStore.getState().toggleFavorite(s.id)}
                  style={isFav ? { color: "#eab308" } : undefined}
                >
                  <Star className="h-3 w-3" />
                </button>
                <button
                  className="btn-ghost px-1.5 py-0.5 text-[12px] hover:!text-red-400"
                  title={t("menu.delete", "Удалить")}
                  onClick={() => useVpnStore.getState().removeServer(s.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                {!isActive && (
                  <button
                    className="btn-primary flex items-center gap-1 px-2.5 py-1 text-[12px]"
                    disabled={status === "connecting"}
                    onClick={() => void useVpnStore.getState().connect(s.id)}
                  >
                    <Shield className="h-3 w-3" />
                    {t("vpn.connect", "Подключить")}
                  </button>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                {s.host}:{s.port}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
        {t(
          "vpn.hint",
          "Через VPN идёт только трафик к нейросетям. Подключение требует рестарта opencode (~10 сек). Ключи хранятся только локально.",
        )}
      </p>
      <button
        className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[12px]"
        onClick={() => {
          const { servers: list, ping } = useVpnStore.getState();
          void (async () => {
            for (const s of list) {
              try {
                await ping(s.id);
              } catch {
                /* next */
              }
            }
          })();
        }}
      >
        <RefreshCw className="h-3 w-3" />
        {t("vpn.reping", "Обновить пинг")}
      </button>
    </div>
  );
}
