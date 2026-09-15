import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Temporary boot-error overlay: paint any startup crash on screen so a
// black window becomes a readable error instead of a mystery.
function paintFatal(kind: string, err: unknown) {
  try {
    const msg =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    // Post-mount async noise (e.g. Monaco worker hiccups) must not cover
    // the UI — only paint fullscreen when React never mounted anything.
    const booted = !!document.getElementById("root")?.hasChildNodes();
    if (booted) {
      console.error(`[non-fatal:${kind}]`, err);
      return;
    }
    document.title = `BOOT ERROR: ${msg.split("\n")[0]}`;
    document.body.style.background = "#1a0505";
    // A fatal screen must always offer a way out — one click to retry.
    if (!document.getElementById("boot-reload")) {
      const btn = document.createElement("button");
      btn.id = "boot-reload";
      btn.textContent = "↻ Перезагрузить";
      btn.style.cssText =
        "position:fixed;top:16px;right:16px;z-index:100000;padding:8px 16px;" +
        "color:#fff;background:#6366f1;border:none;border-radius:8px;" +
        "font:600 13px system-ui;cursor:pointer;";
      btn.onclick = () => window.location.reload();
      document.body.appendChild(btn);
    }
    if (document.getElementById("boot-fatal")) return;
    const pre = document.createElement("pre");
    pre.id = "boot-fatal";
    pre.textContent = `[${kind}] ${msg}`;
    pre.style.cssText =
      "position:fixed;inset:12px;top:64px;z-index:99999;overflow:auto;white-space:pre-wrap;" +
      "color:#ffb4b4;background:#1a0505;font:12px/1.5 monospace;margin:0;";
    document.body.appendChild(pre);
  } catch {
    /* ignore */
  }
}
window.addEventListener("error", (e) => paintFatal("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) =>
  paintFatal("unhandledrejection", e.reason),
);

try {
  (window as unknown as { __ncT0?: number }).__ncT0 = performance.now();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* MotionConfig lives inside App: it follows the in-app toggle. */}
      <App />
    </React.StrictMode>,
  );
  // First paint done — drop the splash (double rAF = after commit).
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      try {
        document.getElementById("nc-splash")?.remove();
      } catch {
        /* ignore */
      }
    }),
  );
} catch (e) {
  paintFatal("render", e);
}
