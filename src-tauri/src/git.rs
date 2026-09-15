// Git integration (Phase B) implemented over the `git` CLI.
//
// A native `git2` binding would avoid shelling out, but on Windows it pulls in
// a libgit2 C build (cmake + MSVC) that is slow and fragile. The CLI path
// gives the same feature set — status, per-file hunks, branch, checkout,
// stage/unstage, commit, log — with zero extra crate weight, and works as
// long as `git` is on PATH.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
    Ignored,
    Conflicted,
    Renamed(String),
    Copied,
}

#[derive(Serialize, Clone)]
pub struct DiffLine {
    pub kind: String, // "context" | "added" | "removed"
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone)]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

fn git(args: &[&str], root: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    if !out.status.success() {
        // Many git commands legitimately print to stderr (e.g. "not a repo").
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        if !stderr.is_empty() {
            return Err(stderr.trim().to_string());
        }
        return Err(stdout.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn has_git() -> bool {
    Command::new("git")
        .args(["--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Walk up from `start` to find the repository root, or None if not in a repo.
fn repo_root(start: &str) -> Option<String> {
    let mut dir = PathBuf::from(start);
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().into_owned());
        }
        if !dir.pop() {
            return None;
        }
    }
}

#[tauri::command]
pub fn git_repo_root(start: String) -> Option<String> {
    if !has_git() {
        return None;
    }
    repo_root(&start)
}

#[tauri::command]
pub fn git_status_map(root: String) -> Result<std::collections::HashMap<String, GitStatus>, String> {
    if !has_git() {
        return Ok(std::collections::HashMap::new());
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(std::collections::HashMap::new()),
    };
    // porcelain v2 gives stable, machine-parseable output
    let out = git(
        &[
            "status",
            "--porcelain=v2",
            "-u",
            "--untracked-files=normal",
        ],
        &root,
    )
    .unwrap_or_default();
    let mut map: std::collections::HashMap<String, GitStatus> = std::collections::HashMap::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let head = parts.next().unwrap_or("");
        if head == "1" {
            // 1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let xy = parts.next().unwrap_or("");
            let path = line.rsplitn(2, ' ').last().unwrap_or("").to_string();
            let x = xy.chars().next().unwrap_or(' ');
            let y = xy.chars().nth(1).unwrap_or(' ');
            let status = classify_xy(x, y, &mut map, &path, &root);
            map.insert(path, status);
        } else if head == "?" {
            let path = line.trim_start_matches("? ").to_string();
            map.insert(path, GitStatus::Untracked);
        } else if head == "u" {
            let path = line.rsplitn(2, ' ').last().unwrap_or("").to_string();
            map.insert(path, GitStatus::Conflicted);
        } else if head == "2" {
            // rename/copy
            let path = line.rsplitn(2, ' ').last().unwrap_or("").to_string();
            let renamed = GitStatus::Renamed(path.clone());
            map.insert(path, renamed);
        } else if head == "!" {
            let path = line.trim_start_matches("! ").to_string();
            map.insert(path, GitStatus::Ignored);
        }
    }
    Ok(map)
}

fn classify_xy(
    x: char,
    y: char,
    _map: &mut std::collections::HashMap<String, GitStatus>,
    _path: &str,
    _root: &str,
) -> GitStatus {
    match (x, y) {
        ('A', _) | (_, 'A') => GitStatus::Added,
        ('D', _) | (_, 'D') => GitStatus::Deleted,
        ('U', _) | (_, 'U') => GitStatus::Conflicted,
        ('M', _) | (_, 'M') => GitStatus::Modified,
        ('R', _) => GitStatus::Renamed(_path.to_string()),
        ('C', _) => GitStatus::Copied,
        _ => GitStatus::Modified,
    }
}

#[tauri::command]
pub fn git_hunks(root: String, path: String) -> Result<Vec<DiffHunk>, String> {
    if !has_git() {
        return Ok(vec![]);
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let rel = to_rel(&root, &path);
    // staged + unstaged combined; use HEAD for committed base
    let out = git(&["diff", "--no-color", "-U0", "HEAD", "--", &rel], &root).unwrap_or_default();
    Ok(parse_diff(&out, &root))
}

#[tauri::command]
pub fn git_hunks_workdir(root: String, path: String) -> Result<Vec<DiffHunk>, String> {
    if !has_git() {
        return Ok(vec![]);
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let rel = to_rel(&root, &path);
    let out = git(&["diff", "--no-color", "-U0", "--", &rel], &root).unwrap_or_default();
    let mut hunks = parse_diff(&out, &root);
    // also unstaged additions for brand-new untracked files (diff against /dev/null)
    let untracked = git(
        &["ls-files", "--others", "--exclude-standard", "--", &rel],
        &root,
    )
    .unwrap_or_default();
    if !untracked.trim().is_empty() {
        let added = git(&["diff", "--no-color", "-U0", "--no-index", "/dev/null", &rel], &root)
            .unwrap_or_default();
        hunks.extend(parse_diff(&added, &root));
    }
    Ok(hunks)
}

fn to_rel(root: &str, path: &str) -> String {
    let r = root.replace('\\', "/");
    let p = path.replace('\\', "/");
    if let Some(stripped) = p.strip_prefix(&r) {
        stripped.trim_start_matches('/').to_string()
    } else {
        path.to_string()
    }
}

fn parse_diff(out: &str, _root: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut current: Option<DiffHunk> = None;
    for line in out.lines() {
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            // @@ -old,old_lines +new,new_lines @@
            let range = line.splitn(2, '@').nth(1).unwrap_or("");
            let range = range.trim_end_matches('@').trim();
            let (old_part, new_part) = range.split_once(' ').unwrap_or(("", ""));
            let old_start = parse_start(old_part);
            let old_lines = parse_count(old_part);
            let new_start = parse_start(new_part);
            let new_lines = parse_count(new_part);
            current = Some(DiffHunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
        } else if let Some(h) = current.as_mut() {
            if let Some(text) = line.strip_prefix('+') {
                h.lines.push(DiffLine { kind: "added".into(), text: text.to_string() });
            } else if let Some(text) = line.strip_prefix('-') {
                h.lines.push(DiffLine { kind: "removed".into(), text: text.to_string() });
            } else if let Some(text) = line.strip_prefix(' ') {
                h.lines.push(DiffLine { kind: "context".into(), text: text.to_string() });
            }
            // lines starting with '\' (no newline marker) are ignored
        }
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }
    hunks
}

fn parse_start(part: &str) -> usize {
    part.trim_start_matches(['-', '+'])
        .split(',')
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
}

fn parse_count(part: &str) -> usize {
    part.split(',')
        .nth(1)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
}

#[tauri::command]
pub fn git_branch(root: String) -> String {
    if !has_git() {
        return String::new();
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return String::new(),
    };
    git(&["rev-parse", "--abbrev-ref", "HEAD"], &root)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[derive(Serialize, Clone)]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
}

#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<GitBranchInfo>, String> {
    if !has_git() {
        return Ok(vec![]);
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let current = git(&["rev-parse", "--abbrev-ref", "HEAD"], &root)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let out = git(&["branch", "--format=%(refname:short)"], &root).unwrap_or_default();
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|name| GitBranchInfo {
            current: name == current,
            name,
        })
        .collect())
}

#[tauri::command]
pub fn git_checkout(root: String, branch: String) -> Result<(), String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    git(&["checkout", &branch], &root)?;
    Ok(())
}

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    let rels: Vec<String> = paths.iter().map(|p| to_rel(&root, p)).collect();
    let mut args: Vec<&str> = vec!["add"];
    for r in &rels {
        args.push(r);
    }
    git(&args, &root)?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    let rels: Vec<String> = paths.iter().map(|p| to_rel(&root, p)).collect();
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for r in &rels {
        args.push(r);
    }
    git(&args, &root)?;
    Ok(())
}

#[tauri::command]
pub fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    let rels: Vec<String> = paths.iter().map(|p| to_rel(&root, p)).collect();
    let mut args: Vec<&str> = vec!["restore", "--"];
    for r in &rels {
        args.push(r);
    }
    git(&args, &root)?;
    Ok(())
}

#[tauri::command]
pub fn git_commit(root: String, message: String, files: Vec<String>) -> Result<String, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    // stage selected files first (partial commit)
    if files.is_empty() {
        git(&["add", "-A"], &root)?;
    } else {
        let rels: Vec<String> = files.iter().map(|p| to_rel(&root, p)).collect();
        let mut args: Vec<&str> = vec!["add"];
        for r in &rels {
            args.push(r);
        }
        git(&args, &root)?;
    }
    let out = git(&["commit", "-m", &message], &root)?;
    Ok(out.trim().to_string())
}

#[tauri::command]
pub fn git_log(root: String, max_count: Option<usize>) -> Result<Vec<Commit>, String> {
    if !has_git() {
        return Ok(vec![]);
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let n = max_count.unwrap_or(50).min(200);
    let format = "%H%x1f%h%x1f%s%x1f%an%x1f%ad";
    let out = git(
        &[
            "log",
            &format!("--max-count={n}"),
            "--date=short",
            &format!("--pretty=format:{format}"),
        ],
        &root,
    )
    .unwrap_or_default();
    let mut commits = Vec::new();
    for line in out.lines() {
        let p: Vec<&str> = line.split('\x1f').collect();
        if p.len() >= 5 {
            commits.push(Commit {
                hash: p[0].to_string(),
                short_hash: p[1].to_string(),
                message: p[2].to_string(),
                author: p[3].to_string(),
                date: p[4].to_string(),
            });
        }
    }
    Ok(commits)
}

// ---------------------------------------------------------------------------
// Checkpoints (chat rollback): stash-based snapshots with a fixed prefix.
// ---------------------------------------------------------------------------

const CP_PREFIX: &str = "nexuscode-cp:";

#[derive(Serialize, Clone)]
pub struct Checkpoint {
    pub id: String, // e.g. "stash@{0}"
    pub label: String,
    pub message: String,
}

fn cp_entries(root: &str) -> Result<Vec<(String, String)>, String> {
    let out = git(&["stash", "list", "--format=%gd%x1f%s"], root).unwrap_or_default();
    let mut v = Vec::new();
    for line in out.lines() {
        let p: Vec<&str> = line.splitn(2, '\x1f').collect();
        if p.len() == 2 && p[1].starts_with(CP_PREFIX) {
            v.push((p[0].to_string(), p[1][CP_PREFIX.len()..].to_string()));
        }
    }
    Ok(v)
}

#[tauri::command]
pub fn checkpoint_create(root: String, label: String) -> Result<Checkpoint, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    let label = label.trim().chars().take(80).collect::<String>();
    let msg = format!("{CP_PREFIX}{label}");
    match git(&["stash", "push", "-u", "-m", &msg], &root) {
        Ok(_) => {}
        Err(e) if e.contains("No local changes") => {
            return Err("no local changes to snapshot".into())
        }
        Err(e) => return Err(e),
    }
    // The new entry lands on top of the stack.
    let entries = cp_entries(&root)?;
    match entries.into_iter().next() {
        Some((id, message)) => Ok(Checkpoint { id, label, message }),
        None => Err("snapshot vanished right after creating it".into()),
    }
}

#[tauri::command]
pub fn checkpoint_list(root: String) -> Result<Vec<Checkpoint>, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    Ok(cp_entries(&root)?
        .into_iter()
        .map(|(id, message)| {
            let label = message.clone();
            Checkpoint { id, label, message }
        })
        .collect())
}

#[tauri::command]
pub fn checkpoint_restore(root: String, id: String) -> Result<(), String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    if !id.starts_with("stash@{") || !id.ends_with('}') {
        return Err("refusing to restore a non-checkpoint ref".into());
    }
    // Restore tracked files first.
    git(&["checkout", &id, "--", "."], &root).map_err(|e| {
        format!("restore failed (tracked files): {e}. Your work is untouched — the snapshot is still in the stash list.")
    })?;
    // Then untracked files recorded in the stash's third parent (^3).
    let untracked = git(&["ls-tree", "-r", "--name-only", &format!("{id}^3")], &root)
        .unwrap_or_default();
    let files: Vec<&str> = untracked.lines().filter(|l| !l.trim().is_empty()).collect();
    if !files.is_empty() {
        let mut args: Vec<&str> = vec!["checkout", &id, "--"];
        args.extend(files);
        // Best-effort: untracked restore must not fail the whole rollback.
        let _ = git(&args, &root);
    }
    Ok(())
}

/// Files changed in the workdir relative to a checkpoint: tracked diff
/// plus currently-untracked files. Powers the review banner file list.
#[tauri::command]
pub fn checkpoint_diff(root: String, id: String) -> Result<Vec<String>, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    if !id.starts_with("stash@{") || !id.ends_with('}') {
        return Err("refusing to diff a non-checkpoint ref".into());
    }
    let mut out: Vec<String> = git(&["diff", "--name-only", &id, "--", "."], &root)
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    for line in git(&["ls-files", "--others", "--exclude-standard"], &root)
        .unwrap_or_default()
        .lines()
    {
        let f = line.trim().to_string();
        if !f.is_empty() && !out.contains(&f) {
            out.push(f);
        }
    }
    out.sort();
    out.truncate(50);
    Ok(out)
}

/// Drop oldest checkpoints (same prefix) keeping the newest `keep`.
/// Stash indices shift on every drop — always drop index 0 of the
/// filtered list, which is the current oldest.
#[tauri::command]
pub fn checkpoint_prune(root: String, keep: usize) -> Result<usize, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    let mut dropped = 0;
    loop {
        let entries = cp_entries(&root)?;
        if entries.len() <= keep {
            break;
        }
        // Oldest = last in `git stash list` order.
        let (oldest_id, _) = entries.last().cloned().unwrap();
        git(&["stash", "drop", &oldest_id], &root)?;
        dropped += 1;
    }
    Ok(dropped)
}

/// Validate a checkpoint ref (`stash@{N}`). Shared by review commands.
fn check_cp_id(id: &str) -> Result<(), String> {
    if id.starts_with("stash@{") && id.ends_with('}') {
        Ok(())
    } else {
        Err("refusing a non-checkpoint ref".into())
    }
}

/// Validate a review path: relative, no escapes, stays inside the repo.
fn check_cp_path(root: &str, path: &str) -> Result<String, String> {
    let p = path.replace('\\', "/");
    let p = p.trim().trim_start_matches('/').to_string();
    if p.is_empty() {
        return Err("empty path".into());
    }
    let mut depth = 0i32;
    for part in p.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            depth -= 1;
        } else {
            depth += 1;
        }
        if depth < 0 {
            return Err("path escapes the repo".into());
        }
    }
    // Defensive: joined path must stay under root.
    let joined = std::path::Path::new(root).join(&p);
    let root_n = root.replace('\\', "/").trim_end_matches('/').to_string() + "/";
    let joined_n = joined.to_string_lossy().replace('\\', "/");
    if !joined_n.starts_with(&root_n) && joined_n != root_n.trim_end_matches('/') {
        return Err("path escapes the repo".into());
    }
    Ok(p)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    /// False when the file did not exist at the checkpoint (agent-created).
    pub existed: bool,
    pub content: String,
}

/// File content at a checkpoint (for side-by-side AI review).
/// New files report `existed: false` with empty content.
#[tauri::command]
pub fn checkpoint_file(root: String, id: String, path: String) -> Result<CheckpointFile, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    check_cp_id(&id)?;
    let rel = check_cp_path(&root, &path)?;
    // `git cat-file -e` probes existence without printing (also guards
    // against directories/submodules, which `git show` would dump).
    let probe = git(&["cat-file", "-e", &format!("{id}:{rel}")], &root);
    if probe.is_err() {
        return Ok(CheckpointFile { existed: false, content: String::new() });
    }
    let content = git(&["show", &format!("{id}:{rel}")], &root).map_err(|e| e.to_string())?;
    Ok(CheckpointFile { existed: true, content })
}

/// Hunks of the workdir relative to a checkpoint (per-file AI review +
/// inline editor decorations). New files diff as fully-added.
#[tauri::command]
pub fn checkpoint_hunks(
    root: String,
    id: String,
    path: String,
) -> Result<Vec<DiffHunk>, String> {
    if !has_git() {
        return Ok(vec![]);
    }
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    check_cp_id(&id)?;
    let rel = check_cp_path(&root, &path)?;
    let out = git(&["diff", "--no-color", "-U3", &id, "--", &rel], &root).unwrap_or_default();
    let mut hunks = parse_diff(&out, &root);
    if hunks.is_empty() {
        // Brand-new file (absent at checkpoint): diff against /dev/null.
        let probe = git(&["cat-file", "-e", &format!("{id}:{rel}")], &root);
        if probe.is_err() {
            let added = git(
                &["diff", "--no-color", "-U3", "--no-index", "/dev/null", &rel],
                &root,
            )
            .unwrap_or_default();
            hunks = parse_diff(&added, &root);
        }
    }
    Ok(hunks)
}

/// Restore ONE file from a checkpoint (per-file Reject).
/// Files absent at the checkpoint (agent-created) are deleted instead.
#[tauri::command]
pub fn checkpoint_restore_file(
    root: String,
    id: String,
    path: String,
) -> Result<bool, String> {
    let root = match repo_root(&root) {
        Some(r) => r,
        None => return Err("not a git repository".into()),
    };
    check_cp_id(&id)?;
    let rel = check_cp_path(&root, &path)?;
    let existed = git(&["cat-file", "-e", &format!("{id}:{rel}")], &root).is_ok();
    if existed {
        git(&["checkout", &id, "--", &rel], &root).map_err(|e| {
            format!("restore failed: {e}. Your work is untouched.")
        })?;
    } else {
        std::fs::remove_file(std::path::Path::new(&root).join(&rel))
            .map_err(|e| format!("delete failed: {e}"))?;
    }
    Ok(existed)
}
