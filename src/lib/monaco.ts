import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
// Named import (not via `any`) so the bundler must include + execute the
// TypeScript language-service module. Property access through `any` does NOT
// guarantee that — and indeed `monaco.languages.typescript` is undefined at
// runtime (register.js only re-exports; it never assigns `languages.*`).
import { typescript as tsLangApi } from "monaco-editor";
import { logInfo } from "../stores/outputStore";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// NOTE: short subpaths (no `esm/vs` prefix, no `.js`) — they resolve via the
// package export map (`"./*": "./esm/vs/*.js"`). Full `esm/...` paths break
// resolution and white-screen the app.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "json") return new JsonWorker() as unknown as Worker;
    if (label === "css" || label === "scss" || label === "less")
      return new CssWorker() as unknown as Worker;
    if (label === "html" || label === "handlebars" || label === "razor")
      return new HtmlWorker() as unknown as Worker;
    if (
      label === "typescript" ||
      label === "javascript" ||
      label === "typescriptreact" ||
      label === "javascriptreact"
    )
      return new TsWorker() as unknown as Worker;
    return new EditorWorker() as unknown as Worker;
  },
};

loader.config({ monaco });

// TypeScript/JavaScript language-service defaults.
//
// The editor opens plain workspace files without the project's node_modules
// types, so every bare import would otherwise be underlined with
// "Cannot find module" (TS2307). Modern resolver settings fix relative
// imports; code 2307 is ignored so third-party imports stay quiet while
// all other semantic checks keep working.
// Numeric TS enum values (stable across monaco 0.5x builds, no enum lookup).
const TS_TARGET_ESNEXT = 99;
const TS_MODULE_ESNEXT = 99;
const TS_MODULERES_BUNDLER = 100;
const TS_JSX_REACTJSX = 4;

function tsReport(where: string, detail: string): void {
  try {
    // eslint-disable-next-line no-console
    console.info(`[monaco] ${where}: ${detail}`);
    logInfo("monaco", `${where}: ${detail}`);
  } catch {
    /* logging must never break the editor */
  }
}

try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = monaco as any;
  const byImport =
    (tsLangApi as any)?.typescriptDefaults != null ? (tsLangApi as any) : null;
  const tsApi = byImport
    ? { api: byImport, where: "named import { typescript }" }
    : m?.languages?.typescript?.typescriptDefaults != null
      ? { api: m.languages.typescript, where: "monaco.languages.typescript" }
      : m?.typescript?.typescriptDefaults != null
        ? { api: m.typescript, where: "monaco.typescript (top-level)" }
        : null;
  if (!tsApi) {
    tsReport(
      "ts-defaults",
      `MISSING (named=${!!byImport}, languages.typescript=${!!m?.languages?.typescript}, top-level=${!!m?.typescript}) — import squiggles cannot be suppressed`,
    );
  } else {
    const compilerOptions = {
      target: TS_TARGET_ESNEXT,
      module: TS_MODULE_ESNEXT,
      moduleResolution: TS_MODULERES_BUNDLER,
      jsx: TS_JSX_REACTJSX,
      allowJs: true,
      checkJs: false,
      strict: false,
      skipLibCheck: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
    };
    const diagnosticsOptions = {
      noSemanticValidation: false,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true,
      // 2307 = "Cannot find module", 7016 = "implicit any module"
      // (no node_modules types exist inside the editor — both are noise)
      diagnosticCodesToIgnore: [2307, 7016],
    };
    tsApi.api.typescriptDefaults.setCompilerOptions(compilerOptions);
    tsApi.api.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
    tsApi.api.javascriptDefaults.setCompilerOptions(compilerOptions);
    tsApi.api.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
    let back: unknown = "?";
    try {
      back =
        tsApi.api.typescriptDefaults.getDiagnosticsOptions?.()
          ?.diagnosticCodesToIgnore ?? "?";
    } catch {
      /* read-back unsupported */
    }
    tsReport(
      "ts-defaults",
      `applied via ${tsApi.where}, ignore read-back=${JSON.stringify(back)}`,
    );
  }
} catch (e) {
  tsReport("ts-defaults", `FAILED: ${e instanceof Error ? e.message : String(e)}`);
}

export function monacoTheme(dark: boolean): string {
  return dark ? "nexus-dark" : "vs";
}

// define custom dark theme that matches NexusCode bg #0f0f14 / #0a0a0f
if (typeof window !== "undefined") {
  // defer until monaco is available
  setTimeout(() => {
    try {
      monaco.editor.defineTheme("nexus-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#0f0f14",
          "editorGutter.background": "#0f0f14",
          "editorLineNumber.foreground": "#606070",
          "editorLineNumber.activeForeground": "#a0a0b0",
          "editorCursor.foreground": "#6366f1",
          "editor.selectionBackground": "#6366f14d",
          "editor.inactiveSelectionBackground": "#6366f126",
          "editorIndentGuide.background": "#1a1a23",
          "editorIndentGuide.activeBackground": "#2a2a33",
          // Overlay-style scrollbars matching the app theme (thin, subtle).
          "scrollbarSlider.background": "#ffffff14",
          "scrollbarSlider.hoverBackground": "#ffffff24",
          "scrollbarSlider.activeBackground": "#6366f159",
          "scrollbar.shadow": "#00000000",
          "minimap.background": "#0f0f14",
        },
      });
    } catch {
      /* monaco not ready yet */
    }
  }, 0);
}

export { monaco };
