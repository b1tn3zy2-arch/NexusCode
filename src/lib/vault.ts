import { invoke } from "@tauri-apps/api/core";

/**
 * OS-protected secret storage (Credential Manager / Keychain).
 * Everything written here never touches plain files or logs.
 */
export const vault = {
  set: (account: string, secret: string) =>
    invoke<void>("vault_set", { account, secret }),
  get: (account: string) =>
    invoke<string | null>("vault_get", { account }),
  del: (account: string) => invoke<void>("vault_delete", { account }),
};

export const VPN_SERVERS_ACCOUNT = "vpn/servers";

const LS_KEY = "nexuscode-vpn";

/**
 * One-time migration: move stored VPN servers (which embed passwords)
 * from plain localStorage into the OS vault, then scrub them from
 * localStorage. Idempotent — safe to call on every boot.
 */
export async function migrateVpnSecrets(): Promise<boolean> {
  try {
    const existing = await vault.get(VPN_SERVERS_ACCOUNT);
    if (existing) return false;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(LS_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;
    const doc = JSON.parse(raw) as { state?: { servers?: unknown } };
    const servers = doc?.state?.servers;
    if (!Array.isArray(servers) || servers.length === 0) return false;
    await vault.set(VPN_SERVERS_ACCOUNT, JSON.stringify(servers));
    try {
      delete doc.state!.servers;
      localStorage.setItem(LS_KEY, JSON.stringify(doc));
    } catch {
      /* vault copy already safe */
    }
    return true;
  } catch {
    return false;
  }
}
