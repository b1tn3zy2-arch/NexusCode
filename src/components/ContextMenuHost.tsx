import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useContextMenuStore, clampMenuPos } from "../stores/contextMenuStore";
import { runMenuAction } from "../lib/menuSafe";

const MENU_W = 240;

export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu) return;
    const h = boxRef.current?.offsetHeight ?? 200;
    setPos(clampMenuPos(menu.x, menu.y, MENU_W, h));
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onResize = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menu, close]);

  if (!menu) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[90]"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={boxRef}
        className="fixed z-[100] min-w-[200px] rounded-lg border py-1 shadow-2xl"
        style={{
          width: MENU_W,
          left: pos.x,
          top: pos.y,
          background: "var(--bg-primary)",
          borderColor: "var(--border-default)",
          boxShadow: "0 12px 32px rgba(0,0,0,.5)",
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {menu.items.map((it) =>
          it.sep ? (
            <div key={it.id} className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
          ) : (
            <button
              key={it.id}
              disabled={it.disabled}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40"
              style={{ color: it.danger ? "#f87171" : "var(--text-primary)" }}
              onClick={() => {
                close();
                runMenuAction(() => it.action?.(), it.label);
              }}
            >
              {it.icon ? <span className="flex w-4 shrink-0 justify-center">{it.icon}</span> : null}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint ? (
                <span className="ml-2 shrink-0 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {it.hint}
                </span>
              ) : null}
            </button>
          ),
        )}
      </div>
    </>
  );
}
