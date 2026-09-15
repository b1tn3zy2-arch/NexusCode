import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Shield,
  ShieldOff,
  Power,
  Plus,
  Trash2,
  Star,
  RefreshCw,
  Zap,
  Globe,
} from "lucide-react";
import { useVpnStore } from "../../stores/vpnStore";
import { vpnApi, flagEmoji, countryName } from "../../lib/vpn";
import { showCtx } from "../../lib/ctx";
import { toast } from "../../stores/toastStore";

/**
 * One-click proof of where traffic exits: queries ipify through the
 * active VPN proxy (or direct when VPN is off). Compare the two IPs —
 * different = VPN works, same = traffic bypasses it.
 */
function CheckIpButton() {
  const { t } = useTranslation();
  const status = useVpnStore((s) => s.status);
  const [ip, setIp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      const got = await vpnApi.egressIp();
      setIp(got);
    } catch (e) {
      toast.error(String(e));
      setIp(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
      <button
        className="btn-ghost mx-auto flex items-center gap-1.5 px-3 py-1 text-[12px]"
        disabled={busy}
        onClick={() => void check()}
        title={t(
          "vpn.checkIpHint",
          "Узнать внешний IP через VPN (или напрямую, если VPN выключен)",
        )}
      >
        <Globe className="h-3.5 w-3.5" />
        {busy
          ? "…"
          : ip
            ? t("vpn.myIp", `Мой IP: ${ip}`)
            : t("vpn.checkIp", "Проверить IP")}
      </button>
      {ip && (
        <div className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          {status === "connected"
            ? t("vpn.ipVia", "выход через VPN ↑ — сравните с выключенным")
            : t("vpn.ipDirect", "прямой выход (VPN выключен)")}
        </div>
      )}
    </div>
  );
}

function CountryBadge({ cc }: { cc: string | null | undefined }) {
  if (!cc) return null;
  return (
    <span
      className="shrink-0 rounded px-1.5 py-px text-[11px] font-medium"
      style={{ background: "var(--bg-quaternary)", color: "var(--text-secondary)" }}
      title={countryName(cc)}
    >
      {flagEmoji(cc)} {cc}
    </span>
  );
}

/**
 * Emoji runs get an explicit emoji-font span: some UI webfonts claim the
 * glyph range but render tofu, so never rely on stack fallback for emoji.
 */
export function EmojiText({ text }: { text: string }) {
  const parts = text.split(/(\p{Extended_Pictographic}\uFE0F?)/u);
  return (
    <>
      {parts.map((p, i) =>
        /^\p{Extended_Pictographic}/u.test(p) ? (
          <span
            key={i}
            style={{
              fontFamily: '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif',
              fontWeight: 400,
            }}
          >
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const PROTO_COLOR: Record<string, string> = {
  vless: "#8b5cf6",
  vmess: "#3b82f6",
  ss: "#22c55e",
  trojan: "#eab308",
  hysteria2: "#f97316",
  tuic: "#ec4899",
};

function fmtPing(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function VpnPanel() {
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
  const [selectedId, setSelectedId] = useState<string | null>(activeId);

  useEffect(() => {
    if (activeId) setSelectedId(activeId);
  }, [activeId]);

  useEffect(() => {
    void (async () => {
      const st = useVpnStore.getState();
      await st.loadServers();
      await st.syncStatus();
      const { servers, ping } = useVpnStore.getState();
      for (const s of servers) {
        try {
          await ping(s.id);
        } catch {
          /* next */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setSelectedId(srv.id);
        setInput("");
        toast.success(t("vpn.added", `Добавлено: ${srv.name}`));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = status === "connected";
  const busy_ = status === "connecting" || status === "reconnecting";
  const selected = servers.find((s) => s.id === selectedId) ?? null;
  const selectedPing = selected ? pingCache[selected.id]?.ms : undefined;

  const togglePower = () => {
    if (connected || busy_) {
      void useVpnStore.getState().disconnect();
    } else if (selected) {
      void useVpnStore.getState().connect(selected.id);
    } else {
      toast.info(t("vpn.pickFirst", "Сначала выберите сервер"));
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="section-header !justify-start flex-1">
          <Shield className="h-4 w-4 shrink-0" />
          {t("nav.vpn", "VPN")}
        </span>
        <button
          className="icon-btn !p-1"
          title={t("aa.refresh", "Обновить")}
          onClick={() => {
            void useVpnStore.getState().syncStatus();
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
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* hero: selected server + power button */}
        <div
          className="relative overflow-hidden rounded-2xl border p-4 text-center"
          style={{
            borderColor: connected ? "#22c55e55" : "var(--border-subtle)",
            background: connected
              ? "radial-gradient(240px 140px at 50% 0%, #22c55e22, transparent 70%), var(--bg-secondary)"
              : status === "error"
                ? "radial-gradient(240px 140px at 50% 0%, #ef444422, transparent 70%), var(--bg-secondary)"
                : "var(--bg-secondary)",
          }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>
            {connected
              ? t("vpn.connected", "Подключено")
              : busy_
                ? status === "reconnecting"
                  ? t("vpn.reconnecting", "Переподключение…")
                  : t("vpn.connecting", "Подключение…")
                : status === "error"
                  ? t("vpn.error", "Ошибка")
                  : t("vpn.off", "Отключено")}
          </div>
          <div className="mt-1 flex min-h-[20px] items-center justify-center gap-1.5" title={selected ? `${selected.name}\n${selected.host}:${selected.port}` : undefined}>
            {selected?.country && <CountryBadge cc={selected.country} />}
            <span className="min-w-0 truncate text-[15px] font-semibold">
              {selected ? <EmojiText text={selected.name} /> : t("vpn.noServer", "Нет сервера")}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {selected ? (
              <>
                <span
                  className="mr-1.5 rounded px-1 py-px text-[10px] font-semibold"
                  style={{
                    background: `${PROTO_COLOR[selected.protocol] ?? "#888"}22`,
                    color: PROTO_COLOR[selected.protocol] ?? "#aaa",
                  }}
                >
                  {selected.protocol}
                </span>
                {selected.host}:{selected.port} · {fmtPing(selectedPing)}
                {connected && port ? ` · :${port}` : ""}
              </>
            ) : (
              "—"
            )}
          </div>
          <button
            onClick={togglePower}
            disabled={busy_ || (!connected && !selected)}
            title={connected ? t("vpn.disconnect", "Отключить") : t("vpn.connect", "Подключить")}
            className={`mx-auto mt-3 flex h-20 w-20 items-center justify-center rounded-full border-2 transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${connected ? "anim-glow-pulse" : ""}`}
            style={{
              borderColor: connected ? "#22c55e" : "var(--border-default)",
              background: connected
                ? "radial-gradient(circle, #22c55e33, #22c55e11)"
                : "var(--bg-tertiary)",
              boxShadow: connected ? "0 0 28px #22c55e44" : "none",
              color: connected ? "#22c55e" : "var(--text-secondary)",
            }}
          >
            {busy_ ? (
              <RefreshCw className="h-8 w-8 animate-spin" />
            ) : connected ? (
              <Shield className="h-8 w-8" />
            ) : (
              <Power className="h-8 w-8" />
            )}
          </button>
          <div className="mt-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {connected
              ? t("vpn.heroHintOn", "Трафик к нейросетям идёт через VPN")
              : t("vpn.heroHintOff", "Нажмите кнопку для подключения")}
          </div>
          <CheckIpButton />
        </div>

        {status === "error" && error && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {/* add key / subscription */}
        <div className="flex gap-2">
          <input
            className="input-field min-w-0 flex-1 font-mono text-[12px]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="vless://… · hy2://… · https://sub/…"
            spellCheck={false}
          />
          <button className="btn-primary flex shrink-0 items-center gap-1 px-3" disabled={busy || !input.trim()} onClick={() => void add()}>
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* server list */}
        <div className="space-y-1.5 pb-2">
          {servers.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center" style={{ borderColor: "var(--border-subtle)" }}>
              <Globe className="h-7 w-7 opacity-30" />
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {t("vpn.empty", "Вставьте ключ или ссылку на подписку выше — как в Happ.")}
              </p>
            </div>
          )}
          {servers.map((s) => {
            const isSel = s.id === selectedId;
            const isActive =
              s.id === activeId && (connected || status === "reconnecting");
            const isFav = favorites.includes(s.id);
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSelectedId(s.id);
                }}
                onContextMenu={(e) =>
                  showCtx(e, [
                    {
                      id: "connect",
                      label: t("vpn.connect", "Подключить"),
                      action: () => void useVpnStore.getState().connect(s.id),
                    },
                    {
                      id: "fav",
                      label: isFav ? "Убрать из избранного" : "В избранное",
                      action: () => useVpnStore.getState().toggleFavorite(s.id),
                    },
                    {
                      id: "copy",
                      label: "Копировать адрес",
                      action: () =>
                        void import("../../lib/clipboard").then(({ copyText }) =>
                          copyText(`${s.host}:${s.port}`),
                        ),
                    },
                    {
                      id: "del",
                      label: t("menu.delete", "Удалить"),
                      danger: true,
                      action: () => useVpnStore.getState().removeServer(s.id),
                    },
                  ])
                }
                className="pressable cursor-pointer rounded-xl border px-3 py-2 hover:bg-[var(--hover)]"
                style={{
                  borderColor: isActive ? "#22c55e66" : isSel ? "var(--accent-500)" : "var(--border-subtle)",
                  background: isActive ? "#22c55e0d" : undefined,
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: isActive ? "#22c55e" : "var(--text-tertiary)" }}
                  />
                  <CountryBadge cc={s.country} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={s.name}>
                    {isFav && <span className="mr-1 text-yellow-400">★</span>}
                    <EmojiText text={s.name} />
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                    {fmtPing(pingCache[s.id]?.ms)}
                  </span>
                  <button
                    className="rounded p-1 hover:bg-[var(--hover)]"
                    title="Ping"
                    onClick={(e) => {
                      e.stopPropagation();
                      void useVpnStore.getState().ping(s.id);
                    }}
                  >
                    <Zap className="h-3 w-3 opacity-60" />
                  </button>
                  <button
                    className="rounded p-1 hover:bg-[var(--hover)]"
                    title={isFav ? "Убрать из избранного" : "В избранное"}
                    style={isFav ? { color: "#eab308" } : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      useVpnStore.getState().toggleFavorite(s.id);
                    }}
                  >
                    <Star className="h-3 w-3 opacity-70" />
                  </button>
                  <button
                    className="rounded p-1 hover:bg-[var(--hover)] hover:!text-red-400"
                    title={t("menu.delete", "Удалить")}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isActive) void useVpnStore.getState().disconnect();
                      useVpnStore.getState().removeServer(s.id);
                      if (selectedId === s.id) setSelectedId(null);
                    }}
                  >
                    <Trash2 className="h-3 w-3 opacity-60" />
                  </button>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  <span
                    className="rounded px-1 text-[10px] font-semibold"
                    style={{
                      background: `${PROTO_COLOR[s.protocol] ?? "#888"}22`,
                      color: PROTO_COLOR[s.protocol] ?? "#aaa",
                    }}
                  >
                    {s.protocol}
                  </span>
                  <span className="truncate">
                    {s.host}:{s.port}
                  </span>
                  {s.needsReimport && (
                    <span
                      className="shrink-0 rounded px-1 text-[10px] font-semibold"
                      style={{ background: "#eab30822", color: "#eab308" }}
                      title={t("vpn.staleHint", "Ключ сохранён старой версией — удалите и добавьте заново (или обновите подписку)")}
                    >
                      {t("vpn.stale", "устарел")}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {connected && (
          <button
            className="btn-ghost flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12.5px]"
            style={{ borderColor: "var(--border-subtle)" }}
            onClick={() => void useVpnStore.getState().disconnect()}
          >
            <ShieldOff className="h-3.5 w-3.5" />
            {t("vpn.disconnect", "Отключить")}
          </button>
        )}
      </div>
    </div>
  );
}
