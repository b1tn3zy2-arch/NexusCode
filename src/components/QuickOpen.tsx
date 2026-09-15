import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Clock, Hash } from "lucide-react";
import { useQuickOpenStore } from "../stores/quickOpenStore";
import { useEditorStore, readFile } from "../stores/editorStore";
import { usePaletteStore } from "../stores/paletteStore";
import { fileColor, fileIcon } from "../lib/fileIcons";
import { isImageFile } from "../lib/files";

interface FileItem {
  path: string;
  name: string;
}

// Sublime-style fuzzy score: contiguous/subsequence match, earlier & consecutive
// characters score higher. Returns null when no subsequence match.
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let lastIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = lastIdx === ti - 1 ? streak + 1 : 0;
      score += 1 + streak;
      if (ti === 0 || "/\\".includes(t[ti - 1])) score += 5; // word boundary bonus
      lastIdx = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

function parseSymbols(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const re = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([A-Za-z0-9_]+)/gm;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(content)) && i < 500) {
    const line = content.slice(0, m.index).split("\n").length;
    out.push({ name: m[1], line });
    i++;
  }
  return out;
}

export function QuickOpen() {
  const { t } = useTranslation();
  const open = useQuickOpenStore((s) => s.open);
  const setOpen = useQuickOpenStore((s) => s.setOpen);
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const { root, mru, openFile } = useEditorStore();

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [allFiles, setAllFiles] = useState<FileItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<{ name: string; line: number }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const preset = useQuickOpenStore((s) => s.preset);

  // Apply one-shot preset query (e.g. ":" from Go to Line) on open.
  useEffect(() => {
    if (!open) return;
    setQuery(preset ?? "");
    setSel(0);
    setPreview(null);
    if (preset) useQuickOpenStore.setState({ preset: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load the full file index when the palette opens.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      if (root) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const paths = await invoke<string[]>("fs_list_all", { path: root, max: 20000 });
          setAllFiles(
            paths.map((p) => ({
              path: p,
              name: p.split(/[\\/]/).pop() ?? p,
            })),
          );
        } catch {
          setAllFiles([]);
        }
      }
    })();
  }, [open, root]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  const prefix = query[0];
  const isCmd = prefix === ">";
  const isLine = prefix === ":";
  const isSymbol = prefix === "@" || prefix === "#";
  const search = isCmd || isLine || isSymbol ? query.slice(1) : query;

  const items = useMemo<FileItem[]>(() => {
    if (isCmd || isLine) return [];
    if (!search.trim()) {
      // MRU when empty
      return mru
        .slice(0, 12)
        .map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }));
    }
    const scored: { item: FileItem; score: number }[] = [];
    for (const f of allFiles) {
      const sName = fuzzyScore(search, f.name);
      const sPath = fuzzyScore(search, f.path);
      const best = Math.max(sName ?? -1, sPath ?? -1);
      if (best >= 0) scored.push({ item: f, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((s) => s.item);
  }, [search, allFiles, mru, isCmd, isLine]);

  // Symbol mode: parse symbols from the active file (loaded on demand).
  useEffect(() => {
    if (!isSymbol) {
      setSymbols([]);
      return;
    }
    const active = useEditorStore.getState().activePath;
    if (!active) {
      setSymbols([]);
      return;
    }
    let cancelled = false;
    void readFile(active)
      .then((content) => {
        if (cancelled) return;
        const syms = parseSymbols(content);
        setSymbols(
          !search.trim()
            ? syms.slice(0, 60)
            : syms
                .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
                .slice(0, 60),
        );
      })
      .catch(() => {
        if (!cancelled) setSymbols([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isSymbol, query, search]);

  const onPick = async (item: FileItem) => {
    await openFile(item.path, { preview: false });
    setOpen(false);
  };

  const onPickSymbol = async (sym: { name: string; line: number }) => {
    const active = useEditorStore.getState().activePath;
    if (active) {
      window.dispatchEvent(
        new CustomEvent("editor:goto-line", { detail: sym.line }),
      );
    }
    setOpen(false);
  };

  const onLineGoto = () => {
    const n = parseInt(search, 10);
    if (!isNaN(n) && n > 0) {
      window.dispatchEvent(new CustomEvent("editor:goto-line", { detail: n }));
    }
    setOpen(false);
  };

  // VS Code-like mode rows when the query is empty (click fills the prefix).
  const showModes = !search.trim() && !isCmd && !isLine && !isSymbol;
  const modes = showModes
    ? [
        { prefix: ">", label: "Show and Run Commands", hint: "Ctrl+K" },
        { prefix: "@", label: "Go to Symbol in Editor", hint: "" },
        { prefix: ":", label: "Go to Line", hint: "Ctrl+G" },
      ]
    : [];

  const onEnter = () => {
    if (isCmd) {
      setPaletteOpen(true);
      setOpen(false);
    } else if (isLine) {
      onLineGoto();
    } else if (isSymbol) {
      if (symbols[sel]) void onPickSymbol(symbols[sel]);
      else setOpen(false);
    } else if (sel < modes.length) {
      setQuery(modes[sel].prefix);
      setSel(0);
    } else if (items[sel - modes.length]) {
      void onPick(items[sel - modes.length]);
    }
  };

  // Preview content for the highlighted file.
  useEffect(() => {
    if (isCmd || isLine || isSymbol) {
      setPreview(null);
      return;
    }
    const it = items[sel - modes.length];
    if (!it || isImageFile(it.name)) {
      // images preview in their own tab, not as text
      setPreview(null);
      return;
    }
    let cancelled = false;
    void readFile(it.path)
      .then((c) => {
        if (!cancelled) setPreview(c);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sel, items, isCmd, isLine, isSymbol]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[8vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => setOpen(false)}
      />
      <div
        className="anim-pop-in relative z-10 flex max-h-[80vh] min-h-[320px] w-[980px] max-w-[94vw] flex-col overflow-hidden rounded-xl border bg-[var(--bg-primary)] shadow-2xl"
        style={{ borderColor: "var(--border-subtle)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
          <Search className="h-4 w-4 opacity-60" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-[16px] outline-none"
            placeholder={t("quickopen.placeholder", "Перейти к файлу…  (> команды, : строка, @ символ)")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, Math.max(0, modes.length + items.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                onEnter();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
        </div>

        <div ref={listRef} className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {isCmd && (
              <div className="px-3 py-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {t("quickopen.cmdHint", "Открыть палитру команд…")}
              </div>
            )}
            {isLine && (
              <div className="px-3 py-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {t("quickopen.lineHint", "Перейти к строке")} {search || "—"}
              </div>
            )}
            {!isCmd && !isLine && items.length === 0 && !isSymbol && (
              <div className="px-3 py-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {t("quickopen.noResults", "Ничего не найдено")}
              </div>
            )}
            {!isSymbol && showModes && modes.map((m, i) => (
              <div
                key={`mode:${m.prefix}`}
                className={`pressable flex cursor-pointer items-center gap-2 px-4 py-2 text-[13.5px] ${
                  i === sel ? "bg-[var(--hover)]" : ""
                }`}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  setQuery(m.prefix);
                  setSel(0);
                }}
              >
                <span className="w-4 shrink-0 text-center font-mono opacity-60">{m.prefix}</span>
                <span className="truncate">{m.label}</span>
                {m.hint && (
                  <kbd className="ml-auto shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-px font-mono text-[10.5px] opacity-70">
                    {m.hint}
                  </kbd>
                )}
              </div>
            ))}
            {!isSymbol && showModes && items.length > 0 && (
              <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider opacity-50">
                {t("quickopen.recent", "Recently opened")}
              </div>
            )}
            {!isSymbol &&
              items.map((it, i) => {
                const isMru = !search.trim() && i < mru.length;
                const ItemIcon = fileIcon(it.name);
                const idx = modes.length + i;
                return (
                  <div
                    key={it.path}
                    className={`pressable flex cursor-pointer items-center gap-2 px-4 py-2 text-[13.5px] ${
                      idx === sel ? "bg-[var(--hover)]" : ""
                    }`}
                    onMouseEnter={() => setSel(idx)}
                    onClick={() => void onPick(it)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void import("../lib/ctx").then(({ showCtx }) =>
                        showCtx(e, [
                          {
                            id: "open",
                            label: t("quickopen.open", "Открыть"),
                            hint: "Enter",
                            action: () => void onPick(it),
                          },
                          {
                            id: "copy-path",
                            label: t("menu.copyPath", "Копировать путь"),
                            action: () =>
                              void import("../lib/clipboard").then(({ copyText }) =>
                                copyText(it.path),
                              ),
                          },
                          {
                            id: "copy-rel",
                            label: t("menu.copyRelativePath", "Копировать относительный путь"),
                            action: () =>
                              void Promise.all([
                                import("../lib/clipboard"),
                                import("../stores/editorStore"),
                              ]).then(([{ copyText }, { useEditorStore }]) => {
                                const root = useEditorStore.getState().root;
                                void copyText(root && it.path.startsWith(root) ? it.path.slice(root.length).replace(/^[/\\]+/, "") : it.path);
                              }),
                          },
                          {
                            id: "reveal",
                            label: "Reveal in File Explorer",
                            action: () =>
                              void import("./menus").then(({ revealInExplorer }) =>
                                revealInExplorer(it.path),
                              ),
                          },
                          {
                            id: "diff",
                            label: t("ctx.diff", "Дифф (диск ↔ редактор)"),
                            action: () =>
                              void import("./editor/DiffModal").then(({ openDiff }) =>
                                openDiff(it.path),
                              ),
                          },
                        ]),
                      );
                    }}
                  >
                    <ItemIcon className="h-4 w-4 shrink-0" style={{ color: fileColor(it.name) }} />
                    <span className="truncate">{it.path.replace(/^.*[\\/]/, "")}</span>
                    <span className="truncate text-[11px] opacity-50">
                      {it.path.replace(/[\\/][^\\/]+$/, "")}
                    </span>
                    {isMru && <Clock className="ml-auto h-3 w-3 opacity-50" />}
                  </div>
                );
              })}
            {isSymbol &&
            symbols.map((s, i) => (
              <div
                key={s.name + s.line}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] ${
                  i === sel ? "bg-[var(--hover)]" : ""
                }`}
                onMouseEnter={() => setSel(i)}
                onClick={() => void onPickSymbol(s)}
              >
                <Hash className="h-4 w-4 shrink-0 opacity-60" />
                <span>{s.name}</span>
                <span className="ml-auto opacity-50">{s.line}</span>
              </div>
            ))}
          </div>

          {preview && !isCmd && !isLine && !isSymbol && (
            <pre className="min-h-0 w-[42%] overflow-auto border-l p-4 text-[13px] leading-relaxed" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
              {preview.slice(0, 4000)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
