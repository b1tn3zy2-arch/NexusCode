import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Animated mount/unmount for panels (framer-motion).
 * Geometry (width/height) + opacity, 250ms ease-out; interrupted
 * gestures reverse from the current point (motion default).
 */
const EASE = [0.4, 0, 0.2, 1] as const;

export function AnimatedWidth({
  open,
  width,
  minWidth,
  maxWidth,
  children,
  className,
  style,
  instant = false,
}: {
  open: boolean;
  width: number;
  minWidth?: number | string;
  maxWidth?: number | string;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** true while drag-resizing: follow the mouse with zero lag. */
  instant?: boolean;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="panel"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: instant ? 0 : 0.25, ease: EASE }}
          className={className}
          style={{ minWidth: 0, maxWidth, overflow: "hidden", ...style }}
        >
          <div style={{ width, minWidth, maxWidth: "100%" }} className="flex h-full">
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function AnimatedHeight({
  open,
  children,
  className,
  duration = 0.25,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  duration?: number;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="collapse"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration, ease: EASE }}
          className={className}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
