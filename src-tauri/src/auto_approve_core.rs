//! Pure rule-engine core: no Tauri dependencies, fully unit-testable.

use glob::Pattern;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Paranoid,
    Developer,
    Autopilot,
}

impl Default for Profile {
    fn default() -> Self {
        Profile::Developer
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoApproveConfig {
    pub enabled: bool,
    pub profile: Profile,
    pub delay_ms: u64,
    pub whitelist: Vec<String>,
    pub blacklist: Vec<String>,
    pub protected_files: Vec<String>,
}

impl Default for AutoApproveConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            profile: Profile::Developer,
            delay_ms: 1000,
            whitelist: vec![],
            blacklist: vec![],
            protected_files: vec![
                "**/.env".to_string(),
                "**/.env.*".to_string(),
                "**/*.pem".to_string(),
                "**/*.key".to_string(),
                "**/id_rsa*".to_string(),
                "**/secrets/**".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub pattern: Option<Value>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Approve,
    Reject(String),
    Manual,
}

const BUILTIN_DANGEROUS: &[&str] = &[
    r"rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z\s]*\s+/",
    r"mkfs(\.\w+)?\s",
    r"dd\s+if=",
    r">\s*/dev/sd[a-z]",
    r"curl[^|]*\|\s*(sudo\s+)?(ba)?sh",
    r"wget[^|]*\|\s*(sudo\s+)?(ba)?sh",
    r":\(\)\{.*\};:",
    r"shutdown(\.exe)?\b",
    r"format\s+[a-z]:",
    r"[Rr]emove-[Ii]tem\b[^|]*-Recurse\b[^|]*\s-[Ff]orce\b",
];

const BUILTIN_SAFE_BASH: &[&str] = &[
    r"^git\s+(status|log|diff|show|branch|remote|rev-parse|stash\s+list)",
    r"^(ls|dir|pwd|echo|which|where|tree)\b",
    r"^(cat|type|head|tail|wc|file|stat)\b",
    r"^(npm|pnpm|yarn)\s+(test|run\s+(test|lint|typecheck)|lint|outdated)",
    r"^cargo\s+(build|check|test|clippy|fmt|tree)",
    r"^go\s+(test|vet|fmt|version)",
    r"^(pytest|python3?\s+-m\s+pytest)\b",
    r"^(node|python3?|git|cargo|go|npm)\s+(-v|--version)\b",
    r"^(grep|rg|findstr|fd)\b",
];

pub struct RuleEngine {
    cfg: AutoApproveConfig,
    whitelist: Vec<Regex>,
    blacklist: Vec<Regex>,
    protected_files: Vec<Pattern>,
    dangerous: Vec<Regex>,
    safe_bash: Vec<Regex>,
}

/// Frontend-supplied patterns are untrusted: cap length/count and the
/// compiled program size so a hostile `(a+)+$` can't ReDoS the event loop.
const MAX_PATTERN_LEN: usize = 500;
const MAX_PATTERN_COUNT: usize = 100;

fn compile_one(pattern: &str) -> Option<Regex> {
    if pattern.len() > MAX_PATTERN_LEN {
        return None;
    }
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
        .ok()
}

fn compile_regexes(patterns: &[String]) -> Vec<Regex> {
    patterns
        .iter()
        .take(MAX_PATTERN_COUNT)
        .filter_map(|p| compile_one(p))
        .collect()
}

impl RuleEngine {
    pub fn new(cfg: AutoApproveConfig) -> Self {
        Self {
            whitelist: compile_regexes(&cfg.whitelist),
            blacklist: compile_regexes(&cfg.blacklist),
            protected_files: cfg
                .protected_files
                .iter()
                .filter_map(|p| Pattern::new(p).ok())
                .collect(),
            dangerous: BUILTIN_DANGEROUS
                .iter()
                .filter_map(|p| compile_one(p))
                .collect(),
            safe_bash: BUILTIN_SAFE_BASH
                .iter()
                .filter_map(|p| compile_one(p))
                .collect(),
            cfg,
        }
    }

    pub fn config(&self) -> &AutoApproveConfig {
        &self.cfg
    }

    fn pattern_strings(req: &PermissionRequest) -> Vec<String> {
        match req.pattern.as_ref() {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => vec![],
        }
    }

    fn metadata_strings(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|v| Self::metadata_strings(v, out)),
            Value::Object(o) => o.values().for_each(|v| Self::metadata_strings(v, out)),
            _ => {}
        }
    }

    /// The primary string rules are matched against: for bash — the joined
    /// command line; otherwise the pattern entries or the title. Anchored
    /// regexes (`^…`) therefore behave intuitively.
    fn primary_subject(req: &PermissionRequest) -> String {
        if req.kind == "bash" {
            let mut meta = vec![];
            Self::metadata_strings(&req.metadata, &mut meta);
            if !meta.is_empty() {
                return joined_bounded(&meta);
            }
        }

        let mut parts = Self::pattern_strings(req);
        if parts.is_empty() {
            parts.push(req.title.clone());
        }
        joined_bounded(&parts)
    }

    fn path_candidates(req: &PermissionRequest) -> Vec<String> {
        let mut all = Self::pattern_strings(req);
        let mut meta = vec![];
        Self::metadata_strings(&req.metadata, &mut meta);
        all.extend(meta);

        all.into_iter()
            .filter(|s| {
                s.len() < 500
                    && (s.contains('/') || s.contains('\\') || s.starts_with('.'))
                    && !s.contains('\n')
            })
            .collect()
    }

    pub fn evaluate(&self, req: &PermissionRequest) -> Decision {
        if !self.cfg.enabled {
            return Decision::Manual;
        }

        let subject = Self::primary_subject(req);

        for re in &self.dangerous {
            if re.is_match(&subject) {
                return Decision::Reject(format!("dangerous pattern: {}", re.as_str()));
            }
        }

        for re in &self.blacklist {
            if re.is_match(&subject) {
                return Decision::Reject(format!("blacklist: {}", re.as_str()));
            }
        }

        for pat in &self.protected_files {
            for cand in Self::path_candidates(req) {
                if pat.matches(&cand) {
                    return Decision::Reject(format!("protected file: {cand}"));
                }
            }
        }

        match self.cfg.profile {
            Profile::Paranoid => Decision::Manual,
            Profile::Autopilot => Decision::Approve,
            Profile::Developer => {
                for re in &self.whitelist {
                    if re.is_match(&subject) {
                        return Decision::Approve;
                    }
                }

                match req.kind.as_str() {
                    "read" | "list" | "glob" | "grep" | "grep_glob" => Decision::Approve,
                    "bash" => {
                        for re in &self.safe_bash {
                            if re.is_match(subject.trim()) {
                                return Decision::Approve;
                            }
                        }
                        Decision::Manual
                    }
                    _ => Decision::Manual,
                }
            }
        }
    }
}

fn joined_bounded(parts: &[String]) -> String {
    let joined = parts.join(" \u{1} ");
    joined.chars().take(4000).collect()
}
