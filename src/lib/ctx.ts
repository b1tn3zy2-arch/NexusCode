import type { MouseEvent } from "react";
import type { CtxItem } from "../stores/contextMenuStore";

/**
 * Show the app's custom context menu for a right-click event.
 * Lazy-imports the store so call sites never pay for it upfront.
 */
export function showCtx(
  e: MouseEvent<Element> | globalThis.MouseEvent,
  items: CtxItem[],
) {
  e.preventDefault();
  e.stopPropagation();
  const { clientX, clientY } = e;
  void import("../stores/contextMenuStore").then(({ useContextMenuStore }) =>
    useContextMenuStore.getState().show(clientX, clientY, items),
  );
}

/**
 * Custom edit menu for <input>/<textarea> (they're excluded from the global
 * fallback so the native menu would show otherwise). All actions really work:
 * execCommand first, clipboard-API fallback for paste, plus Clear.
 */
export function textAreaMenu(
  e: MouseEvent<HTMLTextAreaElement | HTMLInputElement> | globalThis.MouseEvent,
  extra: CtxItem[] = [],
) {
  const el = e.target as HTMLTextAreaElement | HTMLInputElement | null;
  const focus = () => {
    try {
      (el as HTMLElement | null)?.focus?.();
    } catch {
      /* ignore */
    }
  };
  const exec = (cmd: string) => {
    focus();
    try {
      return document.execCommand(cmd);
    } catch {
      return false;
    }
  };
  const pasteSmart = async () => {
    focus();
    if (!el || el.readOnly || el.disabled) return;
    if (exec("paste")) return;
    try {
      const nav = navigator as Navigator & {
        clipboard?: { readText?: () => Promise<string> };
      };
      const text = await nav.clipboard?.readText?.();
      if (typeof text !== "string") return;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText(text, start, end, "end");
      // Native event bubbles to React root listener — controlled inputs update.
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      /* clipboard denied — nothing to do */
    }
  };
  // Undo needs the field focused; cut/copy need a selection.
  const items: CtxItem[] = [
    { id: "ta-undo", label: "Отменить", hint: "Ctrl+Z", action: () => void exec("undo") },
    { id: "ta-cut", label: "Вырезать", hint: "Ctrl+X", action: () => void exec("cut") },
    { id: "ta-copy", label: "Копировать", hint: "Ctrl+C", action: () => void exec("copy") },
    {
      id: "ta-paste",
      label: "Вставить",
      hint: "Ctrl+V",
      action: () => void pasteSmart(),
    },
    {
      id: "ta-paste-plain",
      label: "Вставить как обычный текст",
      hint: "Ctrl+Shift+V",
      action: () => void pasteSmart(),
    },
    { id: "ta-all", label: "Выбрать все", hint: "Ctrl+A", action: () => void exec("selectAll") },
    {
      id: "ta-clear",
      label: "Очистить",
      danger: true,
      action: () => {
        if (!el || el.readOnly || el.disabled) return;
        focus();
        el.select?.();
        if (!exec("delete") && !exec("cut")) {
          // Bypass React's value tracker via the prototype setter so the
          // dispatched event is picked up by controlled inputs.
          const proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      },
    },
    ...extra,
  ];
  showCtx(e, items);
}
