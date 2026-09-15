import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Play } from "lucide-react";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import { useContextMenuStore } from "../../stores/contextMenuStore";
import { copyText } from "../../lib/clipboard";
import { useTerminalStore } from "../../stores/terminalStore";
/* NOTE: TerminalPanel (xterm) is imported lazily in runInTerminal. */
import { logInfo, logWarn } from "../../stores/outputStore";
import { toast } from "../../stores/toastStore";

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "python",
        "rust",
        "json",
        "bash",
        "markdown",
        "html",
        "css",
        "sql",
        "yaml",
        "go",
        "diff",
      ],
    });
  }
  return highlighterPromise;
}

const htmlCache = new Map<string, string>();

export function CodeBlock({
  code,
  lang,
  dark,
}: {
  code: string;
  lang?: string;
  dark: boolean;
}) {
  const { t } = useTranslation();
  const onMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useContextMenuStore.getState().show(e.clientX, e.clientY, [
      {
        id: "copy-code",
        label: t("ctx.copyCode"),
        action: () => void copyText(code),
      },
    ]);
  };
  const themeName = dark ? "github-dark" : "github-light";
  const cacheKey = `${lang ?? ""}|${themeName}|${code}`;
  const [html, setHtml] = useState<string | null>(
    () => htmlCache.get(cacheKey) ?? null,
  );

  useEffect(() => {
    if (html !== null) return;
    let cancelled = false;

    void (async () => {
      try {
        const hl = await getHighlighter();
        let resolvedLang: BundledLanguage | "text" = "text";

        if (lang) {
          const loaded = hl.getLoadedLanguages() as string[];
          try {
            if (!loaded.includes(lang)) {
              await hl.loadLanguage(lang as BundledLanguage);
            }
            resolvedLang = lang as BundledLanguage;
          } catch {
            resolvedLang = "text";
          }
        }

        if (cancelled) return;
        const out = hl.codeToHtml(code, {
          lang: resolvedLang,
          theme: themeName,
        });
        htmlCache.set(cacheKey, out);
        setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, lang, dark, themeName, html]);

  const runInTerminal = () => {
    const { id } = useTerminalStore.getState().ensureShell();
    logInfo("terminal", t("codeblock.sentToTerminal", "Код отправлен в терминал"));
    void import("../TerminalPanel").then(({ sendToShell }) =>
      sendToShell(id, `${code}\r`).then((ok) => {
        if (!ok) {
          const fail = t("codeblock.sendFailed", "Терминал не принял код");
          logWarn("terminal", fail);
          toast.error(fail);
        }
      }),
    );
  };

  const header = (
    <div
      className="flex items-center gap-2 border-b px-2.5 py-1 text-[11px]"
      style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
    >
      <span className="font-mono">{lang || "text"}</span>
      <span className="flex-1" />
      <button
        className="flex items-center gap-1 rounded px-1.5 py-0.5 opacity-0 transition-opacity hover:bg-[var(--hover)] group-hover/code:opacity-100"
        title={t("codeblock.run", "Выполнить в терминале")}
        onClick={(e) => {
          e.stopPropagation();
          runInTerminal();
        }}
      >
        <Play className="h-3 w-3" />
        {t("codeblock.runShort", "Запустить")}
      </button>
      <button
        className="flex items-center gap-1 rounded px-1.5 py-0.5 opacity-0 transition-opacity hover:bg-[var(--hover)] group-hover/code:opacity-100"
        title={t("ctx.copyCode", "Копировать код")}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(code);
        }}
      >
        <Copy className="h-3 w-3" />
        {t("ctx.copy", "Копировать")}
      </button>
    </div>
  );

  if (html === null) {
    return (
      <div className="group/code overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
        {header}
        <pre className="code-fallback" onContextMenu={onMenu}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="group/code overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
      {header}
      <div className="code-block" onContextMenu={onMenu} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
