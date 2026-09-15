# NexusCode

Desktop AI-IDE for Windows: a fast native shell (editor, terminals, git, MCP)
around an autonomous coding agent, with built-in VPN routing for LLM traffic.

Built with [Tauri 2](https://tauri.app/) + React 19 + Monaco + xterm.js.
AI runs through an [opencode](https://github.com/anomalyco/opencode) sidecar binary.

## Features

- **Editor** — Monaco with split groups, tabs, minimap, git gutter, breakpoints
- **AI chat + agents** — sessions, model picker, checkpoints with Accept/Revert review,
  per-file side-by-side diff review (`Ctrl+Enter` / `Ctrl+Backspace`)
- **Autopilot modes** — Loop (repeat a prompt) and Continuous (plan → execute →
  verify with build/tests → fix → repeat until green, resumable after restart)
- **Terminal** — real PTY tabs (`node-pty`/`portable-pty` backend), split view
- **Git panel** — status, stage/discard, commit, history, per-file hunks
- **MCP** — project + global servers, add/toggle over JSONC
- **VPN** — sing-box sidecar, app-level proxy for LLM traffic only
  (system proxy and TUN untouched; kill-switch is fail-closed)
- **Voice input**, **prompt library**, **i18n (EN/RU)**, **auto-updating sidecar**

## Requirements

- Windows 10/11 64-bit, [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Win11)
- Node.js 20+ and Rust stable (GNU toolchain + `windres` via MSYS2) to build from source

## Develop

```powershell
npm install
npm run dev:launch        # Vite + debug backend (scripts/launch-dev.ps1)
npm run dev:check         # tsc + cargo check
```

Tests:

```powershell
powershell -File scripts/cargo-test.ps1 --lib   # rust unit tests
powershell -File scripts/smoke.ps1              # build + boot + example suites
```

## Build a release

```powershell
npm run build:secure      # obfuscated frontend into dist/
cd src-tauri && cargo build --release
npx tauri build           # NSIS installer (downloads sidecars first)
```

Sidecar binaries (`src-tauri/binaries/`) are fetched, not committed —
see `scripts/download-*.mjs`. Pinned versions live in the download scripts.

## Project layout

- `src/` — React frontend (`components/`, `stores/` (zustand), `services/`, `lib/`)
- `src-tauri/` — Rust backend (`src/*.rs`), Tauri config, NSIS installer assets
- `scripts/` — dev/CI helpers (`smoke.ps1`, `cargo-test.ps1`, sidecar downloaders)

## License

TBD — no license file yet; all rights reserved by default.
