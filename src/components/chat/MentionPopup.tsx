import type { MentionState } from "../../hooks/useMentions";
import { File, Folder, Hash } from "lucide-react";

interface Props {
  state: MentionState;
  top: number;
  left: number;
  onSelect: () => void;
  onHover: (index: number) => void;
}

export function MentionPopup({ state, top, left, onSelect, onHover }: Props) {
  if (!state.active) return null;

  return (
    <div
      className="absolute z-40 w-[360px] max-w-[80%] overflow-hidden rounded-lg border shadow-xl"
      style={{
        top,
        left,
        background: "var(--bg-secondary)",
        borderColor: "var(--border-color)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="max-h-[240px] overflow-y-auto py-1">
        {state.items.length === 0 && (
          <p className="px-3 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            {state.loading ? "…" : "no matches"}
          </p>
        )}
        {state.items.map((item, i) => (
          <div
            key={`${item.insert}-${i}`}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
            style={{
              background:
                i === state.index
                  ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                  : "transparent",
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect();
            }}
            onMouseEnter={() => onHover(i)}
          >
            <span className="flex w-4 justify-center" style={{ color: "var(--text-secondary)" }}>
              {item.icon === "dir" ? (
                <Folder className="h-3.5 w-3.5" />
              ) : item.icon === "file" ? (
                <File className="h-3.5 w-3.5" />
              ) : item.icon === "symbol" ? (
                <Hash className="h-3.5 w-3.5" />
              ) : null}
            </span>
            <span className="truncate font-medium">{item.label}</span>
            {item.detail && (
              <span
                className="ml-auto truncate text-[11px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {item.detail}
              </span>
            )}
          </div>
        ))}
      </div>
      <div
        className="border-t px-3 py-1 text-[11px]"
        style={{ borderColor: "var(--border-color)", color: "var(--text-secondary)" }}
      >
        {state.trigger === "@" ? "@file · @folder" : "#symbol"} — Up/Down, Enter, Esc
      </div>
    </div>
  );
}
