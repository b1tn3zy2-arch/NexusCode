# Installer template check helpers

`vendor/utils.nsh` and `vendor/FileAssociation.nsh` are copied verbatim from
the official Tauri bundler (`tauri-bundler` crate, v2.9.4) and are used ONLY
by `../check-installer-template.mjs` to syntax-check our custom
`src-tauri/installer.nsi` with makensis.

If Tauri is upgraded and the template drifts, refresh these two files from
the matching `tauri-bundler` release and re-run the check.
