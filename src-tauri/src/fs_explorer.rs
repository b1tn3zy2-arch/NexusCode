// Native filesystem commands for the editor (Phase B core).
//
// These replace the previous HTTP-API-based file access so the frontend no
// longer depends on a running OpenCode server just to browse/edit files.
// Listing is *lazy* (one directory at a time) which keeps the virtualized
// tree responsive even with 10k+ files; `fs_tree` is provided for callers
// that need a full recursive snapshot.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Last-modified time as epoch milliseconds (None if unavailable).
    pub modified: Option<i64>,
    /// Populated only by `fs_tree`. `None` for files and for lazily-listed dirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

fn to_millis(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
}

fn build_entry(path: &Path, allow_children: bool) -> std::io::Result<FileEntry> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let sym = std::fs::symlink_metadata(path)?;
    let is_symlink = sym.file_type().is_symlink();
    let meta = std::fs::metadata(path)?; // follows symlinks
    let is_dir = meta.is_dir();
    let size = meta.len();
    let modified = to_millis(Ok(meta.modified()?));
    // Lazy listing never expands children; the frontend requests them on demand.
    let children = if allow_children && is_dir && !is_symlink {
        None
    } else {
        None
    };
    Ok(FileEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        is_symlink,
        size,
        modified,
        children,
    })
}

fn list_dir(dir: &Path, show_hidden: bool) -> std::io::Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        entries.push(build_entry(&path, true)?);
    }
    sort_entries(&mut entries);
    Ok(entries)
}

fn build_tree(dir: &Path, depth: usize, max_depth: usize) -> std::io::Result<FileEntry> {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("root")
        .to_string();
    let meta = std::fs::metadata(dir)?;
    let is_dir = meta.is_dir();
    let children = if is_dir && depth < max_depth {
        let mut kids = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let n = match path.file_name().and_then(|x| x.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if n.starts_with('.') {
                continue;
            }
            // Don't recurse into heavy generated directories — just show them.
            let heavy = matches!(
                n.as_str(),
                "node_modules" | "target" | "dist" | ".next" | "build" | "out"
            );
            if heavy && depth > 0 {
                kids.push(build_entry(&path, false)?);
            } else {
                kids.push(build_tree(&path, depth + 1, max_depth)?);
            }
        }
        sort_entries(&mut kids);
        Some(kids)
    } else {
        None
    };
    Ok(FileEntry {
        name,
        path: dir.to_string_lossy().into_owned(),
        is_dir,
        is_symlink: false,
        size: meta.len(),
        modified: to_millis(Ok(meta.modified()?)),
        children,
    })
}

#[tauri::command]
pub async fn fs_list(path: String, show_hidden: Option<bool>) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("not a directory: {path}"));
        }
        list_dir(&root, show_hidden.unwrap_or(false)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_tree(path: String, max_depth: Option<usize>) -> Result<FileEntry, String> {
    let depth = max_depth.unwrap_or(20).min(40);
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.exists() {
            return Err(format!("path does not exist: {path}"));
        }
        build_tree(&root, 0, depth).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recursively collect every file under `root` (dirs excluded) for Quick Open /
/// project-wide search. Skips heavy generated folders and honours a hard cap.
#[tauri::command]
pub async fn fs_list_all(
    path: String,
    max: Option<usize>,
) -> Result<Vec<String>, String> {
    let cap = max.unwrap_or(20000).min(50000);
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        let mut out: Vec<String> = Vec::new();
        collect_files(&root, &mut out, cap);
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn collect_files(dir: &Path, out: &mut Vec<String>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        let heavy = matches!(
            name,
            "node_modules" | "target" | "dist" | ".next" | "build" | "out" | "vendor"
        );
        if p.is_dir() {
            if heavy {
                continue;
            }
            collect_files(&p, out, cap);
        } else if let Some(s) = p.to_str() {
            out.push(s.to_string());
        }
    }
}


#[tauri::command]
pub async fn fs_create_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
        {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(format!("file already exists: {path}"))
            }
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_rename(old_path: String, new_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let old = PathBuf::from(&old_path);
        let new = PathBuf::from(&new_path);
        if !old.exists() {
            return Err(format!("source does not exist: {old_path}"));
        }
        if new.exists() {
            return Err(format!("target already exists: {new_path}"));
        }
        if let Some(parent) = new.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&old, &new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_delete(path: String) -> Result<bool, String> {
    // Phase B: permanent delete (the frontend shows a confirmation modal first).
    // Trash support can be layered on later without changing this signature.
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("path does not exist: {path}"));
        }
        if p.is_dir() {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p)
        }
        .map(|_| true)
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

// Read raw bytes (used by file drag-and-drop from the OS file manager).
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > crate::fs_edit::MAX_FILE_BYTES {
            return Err(format!(
                "file too large ({} bytes, limit {} MB)",
                meta.len(),
                crate::fs_edit::MAX_FILE_BYTES / 1024 / 1024
            ));
        }
        std::fs::read(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Write raw bytes (used by file drag-and-drop from the OS file manager).
#[tauri::command]
pub async fn fs_write_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    if data.len() as u64 > crate::fs_edit::MAX_FILE_BYTES {
        return Err(format!(
            "payload too large ({} bytes, limit {} MB)",
            data.len(),
            crate::fs_edit::MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, &data).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
