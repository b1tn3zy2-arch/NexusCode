import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useToastStore, type ToastKind } from "../stores/toastStore";

const ICON: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
};

const COLOR: Record<ToastKind, string> = {
  info: "var(--accent-400)",
  success: "#22c55e",
  error: "#ef4444",
};

/** Bottom-right toast stack (visible feedback for menu/debug actions). */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className="fixed bottom-9 right-3 z-[200] flex w-[330px] max-w-[90vw] flex-col gap-2">
      <AnimatePresence initial={false}>
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 48, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 32, scale: 0.97 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] shadow-2xl"
            style={{
              background: "var(--bg-secondary)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            <Icon
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: COLOR[t.kind] }}
            />
            <div className="min-w-0 flex-1">
              <div className="break-words leading-snug">{t.text}</div>
              {t.action && (
                <button
                  className="btn-secondary mt-1.5 px-2 py-0.5 text-[12px]"
                  onClick={() => {
                    try {
                      t.action!.run();
                    } finally {
                      dismiss(t.id);
                    }
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              className="shrink-0 rounded p-0.5 opacity-60 transition-all hover:bg-[var(--hover)] hover:opacity-100 active:scale-90"
              onClick={() => dismiss(t.id)}
              aria-label="Закрыть"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        );
      })}
      </AnimatePresence>
    </div>
  );
}
