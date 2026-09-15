//! Loop engine runtime: drives the agent in iterations until a stop condition hits.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::api;
use crate::loop_core::{
    changed_files_from_porcelain, now_ms, success_pattern_matches, IterationResult,
    LoopConfig, LoopSnapshot, ITER_CONVERGED, ITER_ERROR, ITER_SUCCESS,
    ITER_TEST_FAILURE,
};
use crate::AppState;

pub const LOOP_EVENT: &str = "oc-loop";

const ITERATION_TIMEOUT_MS: u64 = 15 * 60 * 1000;
const TEST_TIMEOUT_MS: u64 = 3 * 60 * 1000;

pub struct LoopControl {
    pub stop: Arc<AtomicBool>,
    pub pause: Arc<AtomicBool>,
    pub snapshot: Arc<Mutex<LoopSnapshot>>,
}

pub struct LoopHandle {
    // NOTE: no JoinHandle stored on purpose — stop/pause flow through
    // `control` flags; the spawned task is intentionally detached.
    pub control: Arc<LoopControl>,
}

fn emit_snapshot(app: &AppHandle, snap: &LoopSnapshot) {
    let _ = app.emit(
        LOOP_EVENT,
        serde_json::to_value(snap).unwrap_or(Value::Null),
    );
}

fn set_stop_reason(snap: &Arc<Mutex<LoopSnapshot>>, phase_done: bool, reason: &str) {
    let mut g = snap.lock().unwrap();
    if phase_done {
        g.phase = "done".into();
        g.running = false;
    }
    if g.stop_reason.is_none() {
        g.stop_reason = Some(reason.to_string());
    }
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

pub(crate) fn git(workdir: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(workdir)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---------------------------------------------------------------------------
// agent interaction
// ---------------------------------------------------------------------------

pub(crate) async fn send_prompt(port: u16, session_id: &str, prompt: &str) -> Result<(), String> {
    api::oc_request(
        port,
        api::OcRequest {
            method: "POST".to_string(),
            path: format!("/session/{session_id}/prompt_async"),
            body: Some(json!({ "parts": [{ "type": "text", "text": prompt }] })),
        },
    )
    .await
    .map(|_| ())
}

/// Completion criterion: the latest assistant message has a completion
/// timestamp newer than `after_ms`. Field name varies by server version:
/// `time.completed` in v1.18.x, older drafts used `time.end`. Also note
/// `/session/status` omits idle sessions entirely (returns `{}`).
pub(crate) async fn last_assistant_ended_after(
    port: u16,
    session_id: &str,
    after_ms: i64,
) -> bool {
    let Ok(rows) = api::oc_request(
        port,
        api::OcRequest {
            method: "GET".to_string(),
            path: format!("/session/{session_id}/message?limit=5"),
            body: None,
        },
    )
    .await else {
        return false;
    };

    let Some(arr) = rows.as_array() else { return false };
    for row in arr.iter().rev() {
        let role = row.pointer("/info/role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "assistant" {
            continue;
        }
        let ts = row
            .pointer("/info/time/completed")
            .or_else(|| row.pointer("/info/time/end"))
            .and_then(|v| v.as_i64());
        return ts.map(|t| t > after_ms).unwrap_or(false);
    }
    false
}

pub(crate) async fn abort_session(port: u16, session_id: &str) {
    let _ = api::oc_request(
        port,
        api::OcRequest {
            method: "POST".to_string(),
            path: format!("/session/{session_id}/abort"),
            body: None,
        },
    )
    .await;
}

pub(crate) async fn last_assistant_text(port: u16, session_id: &str) -> String {
    let Ok(rows) = api::oc_request(
        port,
        api::OcRequest {
            method: "GET".to_string(),
            path: format!("/session/{session_id}/message?limit=20"),
            body: None,
        },
    )
    .await else {
        return String::new();
    };

    let Some(arr) = rows.as_array() else {
        return String::new();
    };
    for row in arr.iter().rev() {
        let role = row.pointer("/info/role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "assistant" {
            continue;
        }
        let mut text = String::new();
        if let Some(parts) = row.get("parts").and_then(|v| v.as_array()) {
            for p in parts {
                if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                }
            }
        }
        return text;
    }
    String::new()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

pub(crate) struct TestOutcome {
    pub(crate) ok: bool,
    pub(crate) output: String,
}

pub(crate) fn run_test_command_sync(workdir: &str, command: &str) -> TestOutcome {
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", command])
        .current_dir(workdir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    #[cfg(not(target_os = "windows"))]
    let spawned = std::process::Command::new("sh")
        .args(["-c", command])
        .current_dir(workdir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return TestOutcome { ok: false, output: format!("spawn failed: {e}") },
    };

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let t_out = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        if let Some(p) = stdout_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let t_err = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + Duration::from_millis(TEST_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = t_out.join().unwrap_or_default();
                let err = t_err.join().unwrap_or_default();
                let mut combined = String::from_utf8_lossy(&out).into_owned();
                combined.push('\n');
                combined.push_str(&String::from_utf8_lossy(&err));
                let truncated: String = combined
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                return TestOutcome { ok: status.success(), output: truncated };
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = t_out.join();
                    let _ = t_err.join();
                    return TestOutcome { ok: false, output: "test timed out".into() };
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => return TestOutcome { ok: false, output: format!("wait failed: {e}") },
        }
    }
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

async fn run(app: AppHandle, control: Arc<LoopControl>, cfg: LoopConfig, workdir: String, port: u16) {
    let snap = &control.snapshot;

    let git_ok = git(&workdir, &["rev-parse", "HEAD"]).is_ok();
    {
        let mut s = snap.lock().unwrap();
        s.running = true;
        s.paused = false;
        s.phase = "starting".into();
        s.iteration = 0;
        s.max_iterations = cfg.max_iterations;
        s.history.clear();
        s.last_error = None;
        s.stop_reason = None;
        s.converged_count = 0;
        s.git_available = git_ok;
        s.session_id = Some(cfg.session_id.clone());
    }

    if !git_ok {
        let mut s = snap.lock().unwrap();
        // Notice, not error: the loop still works, only git features off.
        s.notice =
            Some("git not available in workdir — convergence/commit disabled".into());
    }
    {
        let g = snap.lock().unwrap();
        emit_snapshot(&app, &g);
    }

    'outer: for n in 1..=cfg.max_iterations {
        // pause gate
        while control.pause.load(Ordering::Relaxed) {
            if control.stop.load(Ordering::Relaxed) {
                set_stop_reason(snap, true, "user");
                break 'outer;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        if control.stop.load(Ordering::Relaxed) {
            set_stop_reason(snap, true, "user");
            break;
        }

        {
            let mut s = snap.lock().unwrap();
            s.iteration = n;
            s.phase = "waiting_agent".into();
        }
        let _ = app.emit(LOOP_EVENT, json!({ "type": "iteration_started", "iteration": n }));

        let started_at = now_ms();

        if let Err(e) = send_prompt(port, &cfg.session_id, &cfg.prompt).await {
            {
                let mut s = snap.lock().unwrap();
                s.last_error = Some(e.clone());
                s.history.push(IterationResult {
                    iteration: n,
                    status: ITER_ERROR.into(),
                    started_at,
                    finished_at: now_ms(),
                    files_changed: vec![],
                    shortstat: String::new(),
                    tests_ok: None,
                    commit_hash: None,
                });
            }
            set_stop_reason(snap, true, "error");
            let _ = app.emit(LOOP_EVENT, json!({ "type": "error", "message": e }));
            break;
        }

        // wait for completion: poll for the assistant reply's end timestamp
        let wait_started = std::time::Instant::now();
        loop {
            if control.stop.load(Ordering::Relaxed) {
                abort_session(port, &cfg.session_id).await;
                set_stop_reason(snap, true, "user");
                break 'outer;
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if last_assistant_ended_after(port, &cfg.session_id, started_at).await {
                break;
            }
            if wait_started.elapsed().as_millis() as u64 > ITERATION_TIMEOUT_MS {
                abort_session(port, &cfg.session_id).await;
                {
                    let mut s = snap.lock().unwrap();
                    s.last_error = Some("iteration exceeded time limit".into());
                }
                set_stop_reason(snap, true, "iteration_timeout");
                break 'outer;
            }
        }

        if control.stop.load(Ordering::Relaxed) {
            set_stop_reason(snap, true, "user");
            break;
        }

        snap.lock().unwrap().phase = "capturing".into();

        // diff capture
        let (files_changed, shortstat) = if git_ok {
            let porcelain = git(&workdir, &["status", "--porcelain"]).unwrap_or_default();
            let files = changed_files_from_porcelain(&porcelain);
            let stat = git(&workdir, &["diff", "--shortstat", "HEAD"]).unwrap_or_default();
            (files, stat.trim().to_string())
        } else {
            (Vec::new(), String::new())
        };

        // convergence
        if git_ok && files_changed.is_empty() {
            let count = {
                let mut s = snap.lock().unwrap();
                s.converged_count += 1;
                s.converged_count
            };
            if cfg.no_changes_threshold > 0 && count >= cfg.no_changes_threshold {
                {
                    let mut s = snap.lock().unwrap();
                    s.history.push(IterationResult {
                        iteration: n,
                        status: ITER_CONVERGED.into(),
                        started_at,
                        finished_at: now_ms(),
                        files_changed,
                        shortstat,
                        tests_ok: None,
                        commit_hash: None,
                    });
                }
                set_stop_reason(snap, true, "converged");
                break;
            }
        } else {
            snap.lock().unwrap().converged_count = 0;
        }

        // tests
        let mut tests_ok: Option<bool> = None;
        if cfg.run_tests {
            if let Some(cmd) = cfg.test_command.as_deref().filter(|c| !c.trim().is_empty()) {
                snap.lock().unwrap().phase = "testing".into();
                let wd = workdir.clone();
                let cmd_s = cmd.to_string();
                let outcome = tokio::task::spawn_blocking(move || run_test_command_sync(&wd, &cmd_s))
                    .await
                    .unwrap_or(TestOutcome { ok: false, output: "join failed".into() });
                tests_ok = Some(outcome.ok);
                let _ = app.emit(
                    LOOP_EVENT,
                    json!({"type":"tests_result","iteration":n,"ok":outcome.ok,"output":outcome.output}),
                );
            }
        }

        // auto-commit
        let mut commit_hash: Option<String> = None;
        if cfg.auto_commit && git_ok && !files_changed.is_empty() {
            snap.lock().unwrap().phase = "committing".into();
            let msg = format!("loop[bot]: iteration {n}");
            let _ = git(&workdir, &["add", "-A"]);
            match git(&workdir, &["commit", "-m", &msg, "--no-verify"]) {
                Ok(_) => {
                    commit_hash = git(&workdir, &["rev-parse", "HEAD"]).ok();
                    let _ = app.emit(
                        LOOP_EVENT,
                        json!({"type":"committed","iteration":n,"hash":commit_hash}),
                    );
                }
                Err(e) => {
                    let mut s = snap.lock().unwrap();
                    s.last_error = Some(format!("commit failed: {e}"));
                }
            }
        }

        // success pattern against last assistant message
        let last_text = last_assistant_text(port, &cfg.session_id).await;
        let pattern_hit = cfg
            .success_pattern
            .as_deref()
            .map(|p| success_pattern_matches(p, &last_text))
            .unwrap_or(false);

        {
            let mut s = snap.lock().unwrap();
            s.history.push(IterationResult {
                iteration: n,
                status: ITER_SUCCESS.into(),
                started_at,
                finished_at: now_ms(),
                files_changed,
                shortstat,
                tests_ok,
                commit_hash,
            });
            s.phase = "waiting_interval".into();
        }
        let _ = app.emit(LOOP_EVENT, json!({"type":"iteration_complete","iteration":n}));

        if pattern_hit {
            set_stop_reason(snap, false, "success_pattern");
            break;
        }
        if tests_ok == Some(false) && cfg.stop_on_test_failure {
            if let Some(g) = snap.lock().unwrap().history.last_mut() {
                g.status = ITER_TEST_FAILURE.into();
            }
            set_stop_reason(snap, false, "test_failure");
            break;
        }
        if n == cfg.max_iterations {
            set_stop_reason(snap, false, "max_iterations");
            break;
        }

        // interruptible interval
        let interval_end = std::time::Instant::now() + Duration::from_millis(cfg.interval_ms);
        while std::time::Instant::now() < interval_end {
            if control.stop.load(Ordering::Relaxed) {
                set_stop_reason(snap, true, "user");
                break 'outer;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    {
        let mut g = snap.lock().unwrap();
        g.phase = "done".into();
        g.running = false;
        if g.stop_reason.is_none() {
            g.stop_reason = Some("stopped".into());
        }
    }
    let guard = snap.lock().unwrap();
    emit_snapshot(&app, &guard);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn loop_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config: LoopConfig,
) -> Result<LoopSnapshot, String> {
    {
        let guard = state.loop_handle.lock().unwrap();
        if let Some(existing) = guard.as_ref() {
            if existing.control.snapshot.lock().unwrap().running {
                return Err("loop is already running".into());
            }
        }
    }

    if config.prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if config.session_id.trim().is_empty() {
        return Err("session is not selected".into());
    }

    let (port, workdir) = {
        let server_guard = state.server.lock().unwrap();
        match server_guard.as_ref() {
            Some(s) => (s.info.port, s.info.work_dir.clone()),
            None => return Err("server is not running".into()),
        }
    };

    let control = Arc::new(LoopControl {
        stop: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(AtomicBool::new(false)),
        snapshot: Arc::new(Mutex::new(LoopSnapshot {
            running: true,
            max_iterations: config.max_iterations,
            session_id: Some(config.session_id.clone()),
            ..Default::default()
        })),
    });

    tokio::spawn(run(
        app.clone(),
        Arc::clone(&control),
        config,
        workdir,
        port,
    ));

    *state.loop_handle.lock().unwrap() = Some(LoopHandle { control: Arc::clone(&control) });

    let snap = control.snapshot.lock().unwrap().clone();
    Ok(snap)
}

#[tauri::command]
pub fn loop_status(state: State<'_, AppState>) -> LoopSnapshot {
    match state.loop_handle.lock().unwrap().as_ref() {
        Some(h) => h.control.snapshot.lock().unwrap().clone(),
        None => LoopSnapshot::default(),
    }
}

#[tauri::command]
pub fn loop_stop(state: State<'_, AppState>) {
    if let Some(handle) = state.loop_handle.lock().unwrap().as_ref() {
        handle.control.stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn loop_pause(state: State<'_, AppState>, paused: bool) {
    if let Some(handle) = state.loop_handle.lock().unwrap().as_ref() {
        handle.control.pause.store(paused, Ordering::Relaxed);
        let mut snap = handle.control.snapshot.lock().unwrap();
        snap.paused = paused;
        if paused && snap.running {
            snap.phase = "paused".into();
        }
    }
}
