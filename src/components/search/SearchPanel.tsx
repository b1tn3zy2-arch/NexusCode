import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, CornerDownLeft } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { fileColor, fileIcon } from "../../lib/fileIcons";
import { showCtx } from "../../lib/ctx";

export function SearchPanel() {
  const { t } = useTranslation();
  const root = useEditorStore((s) => s.root);
  const searchFiles = useEditorStore((s) => s.searchFiles);
  const openFile = useEditorStore((s) => s.openFile);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const id = setTimeout(async () => {
      const r = await searchFiles(q);
      if (!cancelled) {
        setResults(r);
        setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query, searchFiles]);

  if (!root) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Search size={22} style={{ color: "var(--accent-400)" }} />
        <p className="text-sm font-medium">{t("search.noFolder", "Папка не открыта")}</p>
        <p className="max-w-[220px] text-xs" style={{ color: "var(--text-secondary)" }}>
          {t("search.noFolderHint", "Откройте папку, чтобы искать файлы.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="section-header !justify-start flex-1">
          <Search className="h-4 w-4 shrink-0" />
          {t("nav.search")}
        </span>
      </div>

      <div className="px-2 pt-2">
        <input
          autoFocus
          className="input-field !py-1.5 text-[13px]"
          placeholder={t("search.placeholder", "Поиск файлов по имени…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {query.trim() && !loading && results.length === 0 && (
          <div className="px-3 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
            {t("search.none", "Ничего не найдено")}
          </div>
        )}
        {results.map((path) => {
          const name = path.split(/[/\\]/).pop() ?? path;
          const dir = path.slice(0, path.length - name.length).replace(/[/\\]$/, "");
          const ResultIcon = fileIcon(name);
          return (
            <button
              key={path}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--hover)]"
              onClick={() => void openFile(path, { preview: false })}
              onContextMenu={(e) =>
                showCtx(e, [
                  {
                    id: "open",
                    label: t("search.open", "Открыть"),
                    action: () => void openFile(path, { preview: false }),
                  },
                  {
                    id: "side",
                    label: "Open to the Side",
                    hint: "Ctrl+Enter",
                    action: () =>
                      void useEditorStore.getState().openFile(path, { preview: false }),
                  },
                  {
                    id: "copy",
                    label: t("menu.copyPath", "Копировать путь"),
                    action: () =>
                      void import("../../lib/clipboard").then(({ copyText }) =>
                        copyText(path),
                      ),
                  },
                  {
                    id: "reveal",
                    label: "Reveal in File Explorer",
                    action: () =>
                      void import("@tauri-apps/plugin-opener").then(
                        ({ revealItemInDir }) => revealItemInDir(path).catch(() => {}),
                      ),
                  },
                ])
              }
            >
              <ResultIcon className="h-4 w-4 shrink-0" style={{ color: fileColor(name) ?? "var(--accent-400)" }} />
              <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
              <span className="min-w-0 shrink-0 truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                {dir}
              </span>
              <CornerDownLeft className="h-3 w-3 shrink-0 opacity-40" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
