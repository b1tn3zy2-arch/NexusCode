import { invoke } from "@tauri-apps/api/core";

export interface VpnServerJson {
  id: string;
  name: string;
  /** 2-letter country code ("NL"), extracted from the name. */
  country?: string | null;
  protocol: string;
  host: string;
  port: number;
  outbound: unknown;
}

const COUNTRY_NAMES: Record<string, string> = {
  NL: "Нидерланды", DE: "Германия", US: "США", GB: "Великобритания",
  FR: "Франция", FI: "Финляндия", SE: "Швеция", NO: "Норвегия",
  CH: "Швейцария", AT: "Австрия", PL: "Польша", CZ: "Чехия",
  ES: "Испания", IT: "Италия", PT: "Португалия", IE: "Ирландия",
  CA: "Канада", SG: "Сингапур", JP: "Япония", KR: "Корея",
  HK: "Гонконг", TW: "Тайвань", IN: "Индия", BR: "Бразилия",
  AU: "Австралия", NZ: "Новая Зеландия", MX: "Мексика",
  TR: "Турция", UA: "Украина", KZ: "Казахстан", BY: "Беларусь",
  MD: "Молдова", GE: "Грузия", AM: "Армения", AZ: "Азербайджан",
  IL: "Израиль", AE: "ОАЭ", ZA: "ЮАР", RO: "Румыния",
  BG: "Болгария", HU: "Венгрия", GR: "Греция", DK: "Дания",
  BE: "Бельгия", LU: "Люксембург", IS: "Исландия", EE: "Эстония",
  LV: "Латвия", LT: "Литва", SK: "Словакия", SI: "Словения",
  HR: "Хорватия", RS: "Сербия", NO_: "", RU: "Россия",
};

/** Flag emoji from a 2-letter code (regional indicators). */
export function flagEmoji(cc: string): string {
  const c = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(
    ...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65),
  );
}

export function countryName(cc: string): string {
  return COUNTRY_NAMES[cc.toUpperCase()] ?? cc.toUpperCase();
}

/** Split a leading/trailing country code left by older parses. */
function splitCountry(name: string): { cc: string; rest: string } {
  let t = name.trim();
  const head = t.match(/^\[?([A-Za-z]{2})\]?\s*[-_|–—\s]+\s*(.+)$/);
  if (head && head[2].trim()) return { cc: head[1].toUpperCase(), rest: head[2].trim() };
  const tail = t.match(/^(.+?)\s*[-_|–—\s]+\s*\[?([A-Za-z]{2})\]?$/);
  if (tail && tail[1].trim()) return { cc: tail[2].toUpperCase(), rest: tail[1].trim() };
  return { cc: "", rest: t };
}

export interface VpnStatusJson {
  running: boolean;
  port: number | null;
  server_name: string | null;
  pid: number | null;
}

export const vpnApi = {
  parseLink: (link: string) =>
    invoke<VpnServerJson>("vpn_parse_link", { link }),
  importSubscription: (url: string) =>
    invoke<{ servers: VpnServerJson[]; failed: number }>(
      "vpn_import_subscription",
      { url },
    ),
  start: (outbound: unknown, serverName: string) =>
    invoke<number>("vpn_start", { outbound, serverName }),
  stop: () => invoke<void>("vpn_stop"),
  status: () => invoke<VpnStatusJson>("vpn_status"),
  ping: (host: string, port: number) =>
    invoke<number>("vpn_ping", { host, port }),
  egressIp: () => invoke<string>("vpn_egress_ip"),
};

export function proxyUrlFor(port: number | null): string | null {
  return port ? `http://127.0.0.1:${port}` : null;
}

/**
 * Normalize a stored/legacy name: '+' -> space, drop unrenderable junk
 * (keep letters/digits/emoji), strip a leftover country code.
 */
export function cleanServer(
  raw: string,
  fallback: string,
  knownCountry?: string | null,
): { name: string; country: string | null } {
  const spaced = raw.replace(/\+/g, " ");
  const kept = [...spaced]
    .map((ch) =>
      /[\p{L}\p{N}\p{Extended_Pictographic}\u200d\ufe0f \-_.()[\]+:/|]/u.test(ch)
        ? ch
        : " ",
    )
    .join("");
  const collapsed = kept.split(/\s+/).join(" ").trim().replace(/^[-_.| ]+|[-_.| ]+$/g, "").trim();
  const base = collapsed || fallback;
  if (knownCountry) return { name: base, country: knownCountry };
  const { cc, rest } = splitCountry(base);
  return cc ? { name: rest, country: cc } : { name: base, country: null };
}

/** Back-compat wrapper (name only). */
export function cleanName(raw: string, fallback: string): string {
  return cleanServer(raw, fallback).name;
}

/** Current proxy URL from the VPN store (null = direct). */
export async function currentProxyUrl(): Promise<string | null> {
  const { useVpnStore } = await import("../stores/vpnStore");
  const v = useVpnStore.getState();
  return v.status === "connected" ||
    v.status === "connecting" ||
    v.status === "reconnecting"
    ? proxyUrlFor(v.port)
    : null;
}

/**
 * Restart opencode, preserving the VPN proxy env when connected.
 * Pass an explicit URL to override (connect/disconnect flows).
 * Thin wrapper over the server orchestrator (single choke point).
 */
export async function restartOpencode(proxyUrl?: string | null): Promise<void> {
  const { useServerStore } = await import("../stores/serverStore");
  return useServerStore.getState().restart(proxyUrl);
}
