import { logError } from "../stores/outputStore";
import { toast } from "../stores/toastStore";

function report(label: string | undefined, e: unknown): void {
  const detail = e instanceof Error ? e.message : String(e);
  const msg = label ? `${label}: ${detail}` : detail;
  try {
    logError("menu", msg);
  } catch {
    /* logging must never break menus */
  }
  try {
    toast.error(msg);
  } catch {
    /* ignore */
  }
}

/**
 * Run a menu / context-menu action with visible error reporting.
 * Replaces fire-and-forget chains whose rejections used to vanish silently
 * (the "dropdown opens but nothing works" class of bugs).
 */
export function runMenuAction(
  action: (() => void | Promise<void>) | undefined,
  label?: string,
): void {
  if (!action) return;
  try {
    const r = action();
    if (r instanceof Promise) {
      r.catch((e) => report(label, e));
    }
  } catch (e) {
    report(label, e);
  }
}
