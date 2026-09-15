import { useCallback, useEffect, useRef, useState } from "react";

export function useResizable(
  initialWidth: number,
  minWidth: number,
  maxWidth: number,
  side: "left" | "right",
) {
  const [width, setWidth] = useState(initialWidth);
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      const startX = e.clientX;
      let startWidth = width;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const delta = side === "left" ? dx : -dx;
        setWidth(Math.min(maxWidth, Math.max(minWidth, startWidth + delta)));
      };

      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        cleanupRef.current = null;
        setDragging(false);
      };

      // Re-read the current width at drag start to avoid stale closures
      startWidth = width;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      cleanupRef.current = onUp;
    },
    [side, minWidth, maxWidth, width],
  );

  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current();
    };
  }, []);

  return { width, onMouseDown, dragging };
}
