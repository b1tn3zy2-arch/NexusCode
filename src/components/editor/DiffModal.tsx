import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { monaco, monacoTheme } from "../../lib/monaco";
import { langFromName } from "../../lib/languages";
import { readFile } from "../../stores/editorStore";

function isDark(): boolean {
  try {
    const theme = document.documentElement.classList.contains("theme-light")
      ? "light"
      : "dark";
    return theme !== "light";
  } catch {
    return true;
  }
}

/** Read-only disk-vs-editor diff for a tab (AI edits review). */
export function DiffModal() {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const p = (e as CustomEvent<{ path: string }>).detail?.path;
      if (p) {
        setEmpty(false);
        setPath(p);
      }
    };
    window.addEventListener("nc:open-diff", onOpen);
    return () => window.removeEventListener("nc:open-diff", onOpen);
  }, []);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPath(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);

  useEffect(() => {
    if (!path || !boxRef.current) return;
    let dead = false;
    let origModel: monaco.editor.ITextModel | null = null;
    let modModel: monaco.editor.ITextModel | null = null;
    void (async () => {
      try {
        const { getModelValue } = await import("./EditorInstance");
        const live = getModelValue(path);
        let disk = "";
        try {
          disk = await readFile(path);
        } catch {
          disk = "";
        }
        if (dead) return;
        const modified = typeof live === "string" ? live : disk;
        if (modified === disk) {
          setEmpty(true);
          return;
        }
        const name = path.split(/[\\/]/).pop() ?? path;
        const lang = langFromName(name) ?? "plaintext";
        const tag = path.replace(/[^a-zA-Z0-9]/g, "_");
        origModel = monaco.editor.createModel(
          disk,
          lang,
          monaco.Uri.parse(`ncdiff://original/${tag}`),
        );
        modModel = monaco.editor.createModel(
          modified,
          lang,
          monaco.Uri.parse(`ncdiff://modified/${tag}`),
        );
        if (dead) {
          origModel.dispose();
          modModel.dispose();
          return;
        }
        diffRef.current = monaco.editor.createDiffEditor(boxRef.current!, {
          theme: monacoTheme(isDark()),
          readOnly: true,
          renderSideBySide: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          // Custom menu only — never Monaco's native one.
          contextmenu: false,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
        });
        diffRef.current.setModel({ original: origModel, modified: modModel });
      } catch {
        if (!dead) setEmpty(true);
      }
    })();
    return () => {
      dead = true;
      try {
        diffRef.current?.dispose();
      } catch {
        /* ignore */
      }
      diffRef.current = null;
      try {
        origModel?.dispose();
        modModel?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, [path]);

  if (!path) return null;
  const name = path.split(/[\\/]/).pop() ?? path;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && setPath(null)}
    >
      <div
        className="anim-pop-in flex max-h-full w-[1100px] max-w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)", height: "80vh" }}
      >
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
          style={{ borderColor: "var(--border-subtle)" }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void import("../../lib/ctx").then(({ showCtx }) =>
              showCtx(e, [
                {
                  id: "copy-path",
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
                    void import("../menus").then(({ revealInExplorer }) =>
                      revealInExplorer(path),
                    ),
                },
                {
                  id: "close",
                  label: t("diff.close", "Закрыть"),
                  action: () => setPath(null),
                },
              ]),
            );
          }}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={path}>
            {name} <span style={{ color: "var(--text-tertiary)" }}>— {t("diff.title", "Изменения (диск ↔ редактор)")}</span>
          </span>
          <button className="icon-btn !p-1" title="Закрыть (Esc)" onClick={() => setPath(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {empty ? (
          <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>
            {t("diff.clean", "Нет несохранённых изменений")}
          </div>
        ) : (
          <div
            ref={boxRef}
            className="min-h-0 flex-1"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const ed = diffRef.current?.getModifiedEditor() ?? null;
              const sel = ed?.getSelection();
              const selected =
                ed && sel && !sel.isEmpty() ? (ed.getModel()?.getValueInRange(sel) ?? "") : "";
              void import("../../lib/ctx").then(({ showCtx }) =>
                showCtx(e, [
                  {
                    id: "copy-sel",
                    label: t("ctx.copySelection", "Копировать выделение"),
                    action: () => {
                      if (selected) {
                        void import("../../lib/clipboard").then(({ copyText }) =>
                          copyText(selected),
                        );
                      }
                    },
                  },
                  {
                    id: "select-all",
                    label: t("ctx.selectAll", "Выделить всё"),
                    action: () => {
                      const m = ed?.getModel();
                      if (ed && m) ed.setSelection(m.getFullModelRange());
                    },
                  },
                  {
                    id: "copy-path",
                    label: t("menu.copyPath", "Копировать путь"),
                    action: () =>
                      void import("../../lib/clipboard").then(({ copyText }) =>
                        copyText(path),
                      ),
                  },
                ]),
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

export function openDiff(path: string) {
  window.dispatchEvent(new CustomEvent("nc:open-diff", { detail: { path } }));
}
