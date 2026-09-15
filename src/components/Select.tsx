import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  tag?: string;
  description?: string;
  badge?: string;
  badgeTitle?: string;
  badgeColor?: string;
}

interface SelectGroup<T extends string> {
  label: string;
  options: SelectOption<T>[];
}

interface SelectProps<T extends string> {
  value: T;
  options?: SelectOption<T>[];
  groups?: SelectGroup<T>[];
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
}

/**
 * Custom dropdown that replaces native <select> so the control matches the
 * app's dark theme instead of the OS-styled widget. Keyboard accessible
 * (Enter/Arrow/Escape) and closes on outside click.
 */
export function Select<T extends string>({
  value,
  options,
  groups,
  onChange,
  className,
  buttonClassName,
  ariaLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const flat: SelectOption<T>[] = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  const selected = flat.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const choose = (v: T) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) choose(flat[active].value);
      else {
        setActive(flat.findIndex((o) => o.value === value));
        setOpen(true);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`select-trigger ${buttonClassName ?? ""}`}
        onClick={() => {
          setActive(flat.findIndex((o) => o.value === value));
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="truncate flex items-center gap-1.5">
          {selected?.label ?? value}
          {selected?.tag && (
            <span
              className="rounded px-1 py-0.5 text-[10px] font-bold uppercase"
              style={{
                background:
                  selected.tag === "free"
                    ? "rgba(34,197,94,0.15)"
                    : selected.tag === "local"
                      ? "rgba(59,130,246,0.15)"
                      : "rgba(234,179,8,0.15)",
                color:
                  selected.tag === "free"
                    ? "#22c55e"
                    : selected.tag === "local"
                      ? "#3b82f6"
                      : "#eab308",
              }}
            >
              {selected.tag}
            </span>
          )}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="select-content max-h-[380px] overflow-y-auto" role="listbox">
          {groups
            ? groups.map((g) => (
                <div key={g.label}>
                  <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                    {g.label}
                  </div>
                  {g.options.map((o) => {
                    const idx = flat.findIndex((f) => f.value === o.value);
                    const isActive = idx === active;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="option"
                        aria-selected={o.value === value}
                        className={`select-item select-item-row items-center gap-3 ${o.value === value ? "active" : ""} ${isActive ? "!bg-[var(--hover)]" : ""}`}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => choose(o.value)}
                        title={o.description ?? o.label}
                      >
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block truncate">{o.label}</span>
                          {o.description && (
                            <span
                              className="block truncate text-[11px]"
                              style={{ color: "var(--text-tertiary)" }}
                            >
                              {o.description}
                            </span>
                          )}
                        </span>
                        {o.badge && (
                          <span
                            className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                            title={o.badgeTitle ?? o.badge}
                            style={{
                              background: "rgba(139,92,246,0.15)",
                              color: o.badgeColor ?? "#a78bfa",
                            }}
                          >
                            {o.badge}
                          </span>
                        )}
                        {o.tag && (
                          <span
                            className="ml-1 shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                            style={{
                              background:
                                o.tag === "free"
                                  ? "rgba(34,197,94,0.15)"
                                  : o.tag === "local"
                                    ? "rgba(59,130,246,0.15)"
                                    : "rgba(234,179,8,0.15)",
                              color:
                                o.tag === "free"
                                  ? "#22c55e"
                                  : o.tag === "local"
                                    ? "#3b82f6"
                                    : "#eab308",
                            }}
                          >
                            {o.tag}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            : flat.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`select-item ${o.value === value ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                >
                  {o.label}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}
