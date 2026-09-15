//! Pure continuous-mode types and text processing: plan parsing,
//! subtask detection. No Tauri/tokio dependencies.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    Auto,
    Manual,
}

fn default_true() -> bool {
    true
}

fn default_retries() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuousConfig {
    pub session_id: String,
    pub goal: String,
    pub approval_mode: ApprovalMode,
    pub max_actions: u32,
    pub max_time_minutes: u64,
    pub max_cost_usd: f64,
    pub checkpoints: bool,
    pub run_validation: bool,
    #[serde(default)]
    pub validation_command: Option<String>,
    pub stop_on_validation_error: bool,
    pub detect_subtasks: bool,
    /// Explicit verify commands (one shell command per entry). Empty = auto.
    #[serde(default)]
    pub verify_commands: Vec<String>,
    /// Auto-detect build/test commands from project files when no explicit
    /// commands are given. Turn off to skip verification entirely.
    #[serde(default = "default_true")]
    pub auto_verify: bool,
    /// Fix retries per step after a failed verification (0 = no retries).
    #[serde(default = "default_retries")]
    pub max_retries_per_step: u32,
    /// Keep appending fix steps until the done-gate passes instead of
    /// finishing when the initial plan runs out.
    #[serde(default = "default_true")]
    pub until_done: bool,
}

impl Default for ContinuousConfig {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            goal: String::new(),
            approval_mode: ApprovalMode::Manual,
            // Day-scale budgets: a full app takes hours, not minutes.
            max_actions: 200,
            max_time_minutes: 720,
            max_cost_usd: 20.0,
            checkpoints: true,
            run_validation: false,
            validation_command: None,
            stop_on_validation_error: true,
            detect_subtasks: true,
            verify_commands: Vec::new(),
            auto_verify: true,
            max_retries_per_step: 3,
            until_done: true,
        }
    }
}

pub const STEP_PENDING: &str = "pending";
pub const STEP_IN_PROGRESS: &str = "in_progress";
pub const STEP_COMPLETED: &str = "completed";
pub const STEP_ERROR: &str = "error";
pub const STEP_SKIPPED: &str = "skipped";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub description: String,
    pub status: String,
    /// Fix attempts spent on this step (1 = first try).
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub ts: i64,
    pub description: String,
    pub hash: Option<String>,
}

/// Latest verification outcome (shown in UI, fed back to the agent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub command: String,
    pub ok: bool,
    pub attempt: u32,
    pub output_tail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuousSnapshot {
    pub running: bool,
    pub paused: bool,
    pub phase: String,
    pub goal: String,
    pub steps: Vec<PlanStep>,
    pub current_index: usize,
    pub checkpoints: Vec<Checkpoint>,
    pub started_at: i64,
    pub actions_count: u32,
    pub cost_usd: f64,
    pub last_error: Option<String>,
    pub hit_reason: Option<String>,
    pub stop_reason: Option<String>,
    pub git_available: bool,
    pub session_id: Option<String>,
    #[serde(default)]
    pub last_verify: Option<VerifyReport>,
}

impl Default for ContinuousSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            paused: false,
            phase: "idle".into(),
            goal: String::new(),
            steps: vec![],
            current_index: 0,
            checkpoints: vec![],
            started_at: 0,
            actions_count: 0,
            cost_usd: 0.0,
            last_error: None,
            hit_reason: None,
            stop_reason: None,
            git_available: true,
            session_id: None,
            last_verify: None,
        }
    }
}

/// Saved run for crash/restart recovery (config + latest snapshot).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRun {
    pub config: ContinuousConfig,
    pub snapshot: ContinuousSnapshot,
    pub saved_at: i64,
}

/// Detect one-shot build/test commands from project files.
/// Prefers the project's own scripts; capped so a verify pass stays bounded.
/// Pure std::fs — unit-testable with fixture dirs.
pub fn detect_verify_commands(workdir: &str) -> Vec<String> {
    let root = std::path::Path::new(workdir);
    let mut out: Vec<String> = Vec::new();

    // Node: respect the lockfile's package manager, run existing scripts.
    let pkg_path = root.join("package.json");
    if pkg_path.is_file() {
        let pm = if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
            "bun run"
        } else if root.join("yarn.lock").is_file() {
            "yarn"
        } else if root.join("pnpm-lock.yaml").is_file() {
            "pnpm"
        } else {
            "npm run"
        };
        if let Ok(text) = std::fs::read_to_string(&pkg_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                let has = |name: &str| {
                    v.pointer("/scripts")
                        .and_then(|s| s.get(name))
                        .and_then(|s| s.as_str())
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false)
                };
                // Build first (fast type errors), then the test suite.
                for script in ["build", "test"] {
                    if has(script) {
                        out.push(format!("{pm} {script}"));
                    }
                }
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        // Compiles AND runs tests — covers the build step too.
        out.push("cargo test".into());
    }
    if root.join("go.mod").is_file() {
        out.push("go test ./...".into());
    }
    if root.join("pytest.ini").is_file()
        || root.join("pyproject.toml").is_file()
        || root.join("setup.py").is_file()
    {
        out.push("pytest -x -q".into());
    }

    out.truncate(3);
    out
}

/// Extract numbered plan items from an assistant reply.
pub fn parse_plan(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^\s{0,8}(\d{1,2})\s*[.)\]]\s+(.{3,300})$").unwrap());

    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(caps) = re.captures(line) {
            let mut desc = caps[2].trim().to_string();
            // strip markdown emphasis and trailing punctuation
            desc = desc.replace("**", "").replace('`', "");
            while desc.ends_with('.') {
                desc.pop();
                desc = desc.trim_end().to_string();
            }
            if !desc.is_empty() && !out.contains(&desc) {
                out.push(desc);
            }
            if out.len() >= 30 {
                break;
            }
        }
    }
    out
}

const SUBTASK_PATTERNS: &[&str] = &[
    r"(?i)(?:now I need to|next,?\s*I(?:'ll| should| will| need to)|after that,?\s*I(?:'ll| will| need to)|then I(?:'ll| will| need to))\s+(.{10,200}?)(?:[.\n]|$)",
    r"(?i)(?:this requires|we'?(?:ll| should) also|we need to)\s+(.{10,200}?)(?:[.\n]|$)",
    r"(?i)(?:далее нужно|затем нужно|также нужно)\s+(.{10,200}?)(?:[.\n]|$)",
];

fn subtask_regexes() -> &'static Vec<Regex> {
    static RE: OnceLock<Vec<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        SUBTASK_PATTERNS
            .iter()
            .filter_map(|p| Regex::new(p).ok())
            .collect()
    })
}

/// Detect follow-up tasks the agent mentions in its reply.
pub fn detect_subtasks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for re in subtask_regexes() {
        for caps in re.captures_iter(text) {
            let mut t = caps[1].trim().to_string();
            t = t.replace("**", "").replace('`', "");
            if t.ends_with(',') {
                t.pop();
            }
            if t.len() < 10 || out.contains(&t) {
                continue;
            }
            out.push(t);
            if out.len() >= 3 {
                return out;
            }
        }
    }
    out
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
