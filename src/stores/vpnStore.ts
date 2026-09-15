import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  vpnApi,
  proxyUrlFor,
  restartOpencode,
  cleanServer,
  type VpnServerJson,
} from "../lib/vpn";

function normalizeServer(s: VpnServerJson): VpnServerJson {
  const { name, country } = cleanServer(
    s.name,
    `${s.protocol} ${s.host}`,
    s.country,
  );
  return { ...s, name, country };
}
import { toast } from "./toastStore";

export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

/** Ping cache TTL (60s per spec). */
const PING_TTL = 60_000;

/** Write the server list (with secrets) to the OS vault. */
async function persistServers(servers: VpnServerJson[]): Promise<void> {
  const { vault, VPN_SERVERS_ACCOUNT } = await import("../lib/vault");
  await vault.set(VPN_SERVERS_ACCOUNT, JSON.stringify(servers));
}

interface VpnState {
  servers: VpnServerJson[];
  /** True once servers were loaded from the vault (not persisted). */
  serversLoaded: boolean;
  favorites: string[];
  activeId: string | null;
  status: VpnStatus;
  error: string | null;
  port: number | null;
  pingCache: Record<string, { ms: number; at: number }>;
  /** Merge servers (e.g. subscription refresh) without losing favorites. */
  setServers: (servers: VpnServerJson[]) => void;
  addServer: (s: VpnServerJson) => void;
  removeServer: (id: string) => void;
  toggleFavorite: (id: string) => void;
  loadServers: () => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: () => Promise<void>;
  syncStatus: () => Promise<void>;
  ping: (id: string) => Promise<number | null>;
}

export const useVpnStore = create<VpnState>()(
  persist(
    (set, get) => ({
      servers: [],
      serversLoaded: false,
      favorites: [],
      activeId: null,
      status: "disconnected",
      error: null,
      port: null,
      pingCache: {},

      setServers: (servers) => {
        const cleaned = servers.map(normalizeServer);
        const fav = new Set(get().favorites);
        // Favorites first, then the rest alphabetically.
        const sorted = [...cleaned].sort((a, b) => {
          const fa = fav.has(a.id) ? 0 : 1;
          const fb = fav.has(b.id) ? 0 : 1;
          return fa - fb || a.name.localeCompare(b.name);
        });
        set({ servers: sorted });
        // Secrets live in the OS vault, never in plain localStorage.
        void persistServers(sorted).catch((e) => toast.error(String(e)));
      },

      addServer: (s) => {
        const clean = normalizeServer(s);
        const next = get().servers.some((x) => x.id === clean.id)
          ? get().servers.map((x) => (x.id === clean.id ? clean : x))
          : [...get().servers, clean];
        set({ servers: next });
        void persistServers(next).catch((e) => toast.error(String(e)));
      },

      removeServer: (id) => {
        const st = get();
        const next = st.servers.filter((x) => x.id !== id);
        set({
          servers: next,
          favorites: st.favorites.filter((x) => x !== id),
          ...(st.activeId === id
            ? { activeId: null as string | null }
            : {}),
        });
        void persistServers(next).catch((e) => toast.error(String(e)));
      },

      /** Load servers from the OS vault (after one-time localStorage migration). */
      loadServers: async () => {
        if (get().serversLoaded) return;
        try {
          const { migrateVpnSecrets, vault, VPN_SERVERS_ACCOUNT } = await import("../lib/vault");
          await migrateVpnSecrets();
          const blob = await vault.get(VPN_SERVERS_ACCOUNT);
          if (blob) {
            const arr = JSON.parse(blob) as VpnServerJson[];
            if (Array.isArray(arr)) get().setServers(arr);
          }
        } catch {
          /* vault unavailable — run without saved servers */
        } finally {
          set({ serversLoaded: true });
        }
      },

      toggleFavorite: (id) =>
        set((st) => ({
          favorites: st.favorites.includes(id)
            ? st.favorites.filter((x) => x !== id)
            : [...st.favorites, id],
        })),

      connect: async (id) => {
        const st = get();
        const srv = st.servers.find((x) => x.id === id);
        if (!srv) {
          set({ error: "Сервер не найден" });
          return;
        }
        set({ status: "connecting", error: null });
        try {
          const port = await vpnApi.start(srv.outbound, srv.name);
          // Proxy is up but opencode still restarts through it (10s+):
          // "reconnecting" until the restart lands.
          set({ port, activeId: id, status: "reconnecting" });
          // Route opencode through the new proxy (10s+ restart).
          await restartOpencode(proxyUrlFor(port));
          set({ status: "connected" });
          toast.success(`VPN: подключено (${srv.name})`);
        } catch (e) {
          try {
            await vpnApi.stop();
          } catch {
            /* already down */
          }
          set({ status: "error", error: String(e), port: null });
          toast.error(`VPN не подключился: ${e}`);
        }
      },

      disconnect: async () => {
        try {
          await vpnApi.stop();
        } catch {
          /* already down */
        }
        set({ status: "disconnected", activeId: null, port: null, error: null });
        try {
          await restartOpencode(null);
        } catch (e) {
          toast.error(`Рестарт без VPN не удался: ${e}`);
        }
      },

      syncStatus: async () => {
        try {
          const s = await vpnApi.status();
          const st = get().status;
          if (!s.running && (st === "connected" || st === "reconnecting")) {
            // Proxy died externally → error, never silent direct.
            set({
              status: "error",
              error: "sing-box остановлен извне — LLM-запросы заблокированы",
              port: null,
            });
          } else if (s.running && st === "disconnected") {
            set({ status: "connected", port: s.port });
          }
        } catch {
          /* backend unavailable */
        }
      },

      ping: async (id) => {
        const srv = get().servers.find((x) => x.id === id);
        if (!srv) return null;
        const cached = get().pingCache[id];
        if (cached && Date.now() - cached.at < PING_TTL) return cached.ms;
        try {
          const ms = await vpnApi.ping(srv.host, srv.port);
          set((st) => ({ pingCache: { ...st.pingCache, [id]: { ms, at: Date.now() } } }));
          return ms;
        } catch {
          return null;
        }
      },
    }),
    {
      name: "nexuscode-vpn",
      // Secrets are NOT persisted here anymore — servers live in the OS
      // vault (see loadServers + migrateVpnSecrets).
      partialize: (s) => ({
        favorites: s.favorites,
        activeId: s.activeId,
      }),
    },
  ),
);
