# Changelog

All notable changes to NexusCode are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Cursor-style AI review: side-by-side diff per file (`checkpoint_file`,
  `checkpoint_hunks`, `checkpoint_restore_file` backend commands), per-file
  Accept (`Ctrl+Enter`) / Reject (`Ctrl+Backspace`), inline green/red
  decorations in the open editor
- Continuous autopilot v2: verify-after-step with auto fix retries,
  done-gate (finish only when build/tests green), stuck detection,
  day-scale budgets, crash recovery via `continuous_resume_saved`,
  auto-detected verify commands (`continuous_detect_validation`)
- VPN stored-link healing: servers re-parse on load, stale entries flagged
  for re-import instead of failing cryptically
- `scripts/versions.json`: single source of truth for sidecar pins
  (opencode / sing-box / python / debugpy)

### Fixed
- `security=reality` VLESS links built a plaintext outbound (no TLS section)
- Flag emoji stripped from VPN server names
- `getTermTail` base64 join breaking on padded chunks (terminal «fix error»)
- Chat session delete double-DELETE, cross-session stream parts fallback
- Pre-run checkpoint race (moved into `chatStore.send`, awaited)
- Event loss for unloaded sessions (per-session buffer + replay)
- Terminal id reuse across reloads (`term-N-timestamp`)
- VPN status lying during opencode restart (`reconnecting` state)
- Checkbox spacing in Loop/Continuous options
- `cargo test --lib` on Windows GNU (manifest stamp wrapper)

### Security
- 64 MB caps on file read/write payloads
- Regex length/count/compiled-size limits (ReDoS)
- Strict sidecar checksum verification (fail closed)
- Post-spawn sidecar integrity re-check (TOCTOU window)
- CSP: dropped remote `connect-src` (`https:`/`wss:`)
- Confirm dialogs on permanent file delete and continuous rollback
- Log rotation (2 MB) + panic backtraces

## [1.0.0] — TBD (release in progress, see plan in chat)
