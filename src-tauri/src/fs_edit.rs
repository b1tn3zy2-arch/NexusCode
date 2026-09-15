// Minimal atomic file write for the editor (temp file + rename).

use std::path::PathBuf;

/// Upper bound for a single read/write payload (editor + drag&drop).
/// The Monaco side already refuses huge files; this caps IPC/memory abuse.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "file too large ({} bytes, limit {} MB)",
            content.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("mkdir failed: {e}"))?;

    // Atomic-ish write: temp file in the same dir, then rename over.
    let tmp = parent.join(format!(
        ".nexuscode-write-{}-{}",
        std::process::id(),
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into())
    ));

    tokio::fs::write(&tmp, content.as_bytes())
        .await
        .map_err(|e| format!("write temp failed: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).await;
    }

    match tokio::fs::rename(&tmp, &target).await {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows rename-over-existing can fail; fall back to copy+remove.
            tokio::fs::copy(&tmp, &target)
                .await
                .map_err(|e| format!("replace failed: {e}"))?;
            let _ = tokio::fs::remove_file(&tmp).await;
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<String, String> {
    // Read raw bytes first so non-UTF8 files (e.g. CP1251 on Windows) do not
    // turn into mojibake or a hard error. Try UTF-8 → Windows-1251 → lossy.
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "file too large ({} bytes, limit {} MB)",
            bytes.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }
    // encoding_rs handles the Windows-1251 (and other single-byte) case without
    // pulling in a heavy chardet crate. The `WINDOWS_1251` label covers CP1251.
    let (cow, _, had_errors) = encoding_rs::WINDOWS_1251.decode(&bytes);
    if !had_errors {
        return Ok(cow.into_owned());
    }
    // Last resort: lossy UTF-8 (replaces invalid sequences).
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
