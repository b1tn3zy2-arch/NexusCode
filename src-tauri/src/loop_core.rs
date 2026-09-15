//! Pure loop-mode types and helpers: no Tauri/tokio dependencies.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopConfig {
    pub session_id: String,
    pub prompt: String,
    pub max_iterations: u32,
    pub interval_ms: u64,
    pub auto_commit: bool,
    pub run_tests: bool,
    #[serde(default)]
    pub test_command: Option<String>,
    pub stop_on_test_failure: bool,
    pub no_changes_threshold: u32,
    #[serde(default)]
    pub success_pattern: Option<String>,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            prompt: String::new(),
            max_iterations: 5,
            interval_ms: 1500,
            auto_commit: true,
            run_tests: false,
            test_command: None,
            stop_on_test_failure: true,
            no_changes_threshold: 2,
            success_pattern: None,
        }
    }
}

pub const ITER_SUCCESS: &str = "success";
pub const ITER_CONVERGED: &str = "converged";
pub const ITER_ERROR: &str = "error";
pub const ITER_TEST_FAILURE: &str = "test_failure";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationResult {
    pub iteration: u32,
    pub status: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub files_changed: Vec<String>,
    pub shortstat: String,
    pub tests_ok: Option<bool>,
    pub commit_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSnapshot {
    pub running: bool,
    pub paused: bool,
    pub phase: String,
    pub iteration: u32,
    pub max_iterations: u32,
    pub history: Vec<IterationResult>,
    pub last_error: Option<String>,
    /// Non-error notice (e.g. git unavailable) — shown as warning, never error.
    pub notice: Option<String>,
    pub stop_reason: Option<String>,
    pub converged_count: u32,
    pub git_available: bool,
    pub session_id: Option<String>,
}

impl Default for LoopSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            paused: false,
            phase: "idle".to_string(),
            iteration: 0,
            max_iterations: 0,
            history: vec![],
            last_error: None,
            notice: None,
            stop_reason: None,
            converged_count: 0,
            git_available: true,
            session_id: None,
        }
    }
}

/// `git status --porcelain` → list of changed paths (rename target wins).
pub fn changed_files_from_porcelain(out: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let body = &line[3..];
        let path = match body.split_once(" -> ") {
            Some((_, new)) => new,
            None => body,
        };
        let path = path.trim_matches('"').trim();
        if !path.is_empty() && !files.contains(&path.to_string()) {
            files.push(path.to_string());
        }
    }
    files
}

pub fn success_pattern_matches(pattern: &str, text: &str) -> bool {
    let pattern = pattern.trim();
    // Untrusted frontend input: length cap + bounded program size (ReDoS).
    if pattern.is_empty() || pattern.len() > 500 {
        return false;
    }
    match regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
    {
        Ok(re) => re.is_match(text),
        Err(_) => false,
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
