import { invoke } from "@tauri-apps/api/core";

/**
 * Fetch restricted to LLM provider domains via the Rust client.
 * Honors the VPN kill-switch: while the VPN is on, traffic goes ONLY
 * through the local proxy (dead proxy = hard error, never direct).
 */
export async function fetchLlmJson<T>(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<T> {
  const res = await invoke<{ status: number; body: string }>("net_fetch", {
    url,
    method: init?.method ?? "GET",
    headers: init?.headers ?? null,
    body: init?.body ?? null,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  return JSON.parse(res.body) as T;
}
