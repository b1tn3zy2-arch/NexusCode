import { useSettingsStore } from "../stores/settingsStore";

/**
 * Fire an OS notification ("agent finished"). Respects the
 * `notifyOnDone` setting. Never throws — a missing notification
 * daemon must not break the agent flow.
 */
export async function notifyDone(title: string, body?: string): Promise<void> {
  try {
    if (!useSettingsStore.getState().notifyOnDone) return;
    const { sendNotification, requestPermission, isPermissionGranted } =
      await import("@tauri-apps/plugin-notification");
    try {
      if (!(await isPermissionGranted())) {
        await requestPermission().catch(() => {});
      }
    } catch {
      /* permission API may be unavailable — try sending anyway */
    }
    sendNotification({ title, body });
  } catch {
    /* notifications unavailable (e.g. headless) — silent */
  }
}
