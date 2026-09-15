import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileCode2, Search, Sparkles } from "lucide-react";
import { LANGUAGES, langFromName } from "../lib/languages";
import { useEditorStore } from "../stores/editorStore";
/* NOTE: EditorInstance (Monaco) stays out of the initial bundle. */

export function LanguagePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const activePath = useEditorStore((s) => s.activePath);
  const tabs = useEditorStore((s) => s.tabs);
  const overrides = useEditorStore((s) => s.langOverrides);
  const setOverride = useEditorStore((s) => s.setLangOverride);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((x) => x.path === activePath) ?? null;
  const autoId = activeTab ? langFromName(activeTab.name) : undefined;
  const currentId = activePath ? (overrides[activePath] ?? autoId) : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (l) =>
        l.label.toLowerCase().includes(q) ||
        l.id.includes(q) ||
        l.extensions.some((e) => e.includes(q)),
    );
  }, [query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open ]);

  useEffect(() => {
    listRef.current
      ?.querySelector("[data-active='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  if (!open) return null;

  const apply = (id: string | null) => {
    if (activePath && activeTab) {
      setOverride(activePath, id);
      void import("./editor/EditorInstance").then(({ setModelLanguage }) =>
        setModelLanguage(activePath, activeTab.name, id ?? undefined),
      );
    }
    onClose();
  };

  // index 0..filtered.length-1 map to rows; auto-detect row handled separately
  const pick = (i: number) => {
    const lang = filtered[i];
    if (lang) apply(lang.id);
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(0,0,0,.4)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-[520px] max-w-[92vw] overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
      >
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: "var(--border-color)" }}
        >
          <Search size={15} className="shrink-0 opacity-60" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
            placeholder={t("editor.languageSearch")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(index);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
        </div>
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          <div
            className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-[var(--hover)]"
            onMouseDown={(e) => {
              e.preventDefault();
              apply(null);
            }}
            onMouseEnter={() => setIndex(-1)}
          >
            <span className="flex w-5 justify-center" style={{ color: "var(--text-secondary)" }}>
              <Sparkles size={15} />
            </span>
            <span className="flex-1">{t("editor.autoDetect")}</span>
            {activePath && !overrides[activePath] && (
              <Check size={14} style={{ color: "var(--accent)" }} />
            )}
          </div>
          {filtered.length === 0 && (
            <p className="px-4 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
              {t("editor.noLanguages")}
            </p>
          )}
          {filtered.map((l, i) => {
            const active = l.id === currentId;
            return (
              <div
                key={l.id}
                data-active={i === index}
                className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm"
                style={{
                  background:
                    i === index
                      ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                      : undefined,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                onMouseEnter={() => setIndex(i)}
              >
                <span className="flex w-5 justify-center" style={{ color: "var(--text-secondary)" }}>
                  <FileCode2 size={15} />
                </span>
                <span className="flex-1 truncate">{l.label}</span>
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  ({l.id})
                </span>
                {active && <Check size={14} style={{ color: "var(--accent)" }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
