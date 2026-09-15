//! Continuous orchestrator: goal -> plan -> sequential execution with
//! checkpoints, limits, HITL approval and subtask detection.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::api;
use crate::continuous_core::{
    detect_subtasks, detect_verify_commands, now_ms, parse_plan, ApprovalMode, Checkpoint,
    ContinuousConfig, ContinuousSnapshot, PlanStep, SavedRun, VerifyReport, STEP_COMPLETED,
    STEP_ERROR, STEP_IN_PROGRESS, STEP_PENDING, STEP_SKIPPED,
};
use crate::loop_engine::{
    abort_session, git, last_assistant_ended_after, last_assistant_text, run_test_command_sync,
    send_prompt,
};
use crate::AppState;

pub const CONTINUOUS_EVENT: &str = "oc-continuous";
const RUN_FILE: &str = "continuous-run.json";
/// Safety net on top of budgets: appended fix rounds never run away.
const MAX_APPENDED_FIX_STEPS: usize = 20;

// approval: 0 = pending, 1 = approved, 2 = rejected
pub struct ContControl {
    pub stop: Arc<AtomicBool>,
    pub pause: Arc<AtomicBool>,
    pub approval: Arc<AtomicI8>,
    pub skip_step: Arc<AtomicBool>,
    pub snapshot: Arc<Mutex<ContinuousSnapshot>>,
    /// Serialized config, used to persist the run for crash recovery.
    pub config_json: String,
}

pub struct ContinuousHandle {
    // NOTE: no JoinHandle stored on purpose — stop/pause flow through
    // `control` flags; the spawned task is intentionally detached.
    pub control: Arc<ContControl>,
}

fn push(app: &AppHandle, snap: &ContinuousSnapshot) {
    let _ = app.emit(
        CONTINUOUS_EVENT,
        serde_json::to_value(snap).unwrap_or(Value::Null),
    );
}

fn update<F: FnOnce(&mut ContinuousSnapshot)>(app: &AppHandle, snap: &Arc<Mutex<ContinuousSnapshot>>, f: F) {
    {
        let mut g = snap.lock().unwrap();
        f(&mut g);
    }
    let g = snap.lock().unwrap();
    push(app, &g);
}

fn run_file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(RUN_FILE))
}

/// Persist {config, snapshot} for crash/restart recovery. Best-effort.
fn persist_run(app: &AppHandle, control: &Arc<ContControl>) {
    let Some(path) = run_file_path(app) else { return };
    let snap = control.snapshot.lock().unwrap();
    let Ok(cfg_val) = serde_json::from_str::<Value>(&control.config_json) else { return };
    let doc = json!({
        "config": cfg_val,
        "snapshot": &*snap,
        "savedAt": now_ms(),
    });
    if let Ok(text) = serde_json::to_string(&doc) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, text);
    }
}

fn clear_saved_run(app: &AppHandle) {
    if let Some(path) = run_file_path(app) {
        let _ = std::fs::remove_file(&path);
    }
}

fn load_saved_run(app: &AppHandle) -> Result<SavedRun, String> {
    let path = run_file_path(app).ok_or_else(|| "no app data dir".to_string())?;
    let text =
        std::fs::read_to_string(&path).map_err(|_| "no saved continuous run".to_string())?;
    serde_json::from_str::<SavedRun>(&text).map_err(|e| format!("saved run corrupt: {e}"))
}

async fn session_cost(port: u16, session_id: &str) -> f64 {
    let Ok(rows) = api::oc_request(
        port,
        api::OcRequest {
            method: "GET".into(),
            path: format!("/session/{session_id}/message?limit=100"),
            body: None,
        },
    )
    .await else { return 0.0 };
    let mut sum = 0.0;
    if let Some(arr) = rows.as_array() {
        for row in arr {
            sum += row.pointer("/info/cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
        }
    }
    sum
}

fn step_prompt(goal: &str, steps: &[PlanStep], index: usize) -> String {
    let completed: Vec<String> = steps[..index]
        .iter()
        .filter(|s| s.status == STEP_COMPLETED)
        .map(|s| format!("  - {}", s.description))
        .collect();
    let completed_block = if completed.is_empty() {
        "(none yet)".to_string()
    } else {
        completed.join("\n")
    };

    format!(
        "We are working toward this GOAL:\n{goal}\n\n\
Plan progress — completed so far:\n{completed_block}\n\n\
Execute ONLY the following plan step and nothing else:\n\
STEP {}: {}\n\n\
Rules:\n\
- Make the smallest change that completes the step; do not refactor unrelated code.\n\
- If the project has tests for this area, extend them; if it has none yet, add a basic test when reasonable.\n\
- Do NOT start dev servers, watchers or background processes — one-shot commands only.\n\
- When the step is finished, briefly summarize what was done and which files changed.",
        index + 1,
        steps[index].description
    )
}

/// Follow-up prompt after a failed verification pass.
fn fix_prompt(step_desc: &str, index: usize, failing_cmd: &str, output_tail: &str, stuck: bool) -> String {
    let nudge = if stuck {
        "\nNote: the last attempts changed no files — you seem stuck. \
Step back, reconsider the approach, break the problem down differently, \
or clearly state what blocks you.\n"
    } else {
        ""
    };
    format!(
        "The previous attempt at this plan step FAILED verification.\n\
STEP {}: {}\n\n\
Failing command: {}\n\
Output (tail):\n{}\n{}Fix the code with the smallest change that makes the failing command pass.\n\
Do not start servers or watchers. End with a short summary of the fix.",
        index + 1,
        step_desc,
        failing_cmd,
        output_tail,
        nudge
    )
}

/// Short `git status` fingerprint to detect "agent did nothing" rounds.
fn work_sig(workdir: &str, git_ok: bool) -> String {
    if !git_ok {
        return String::new();
    }
    git(workdir, &["status", "--porcelain"]).unwrap_or_default()
}

fn tail4000(s: &str) -> String {
    s.chars().rev().take(4000).collect::<String>().chars().rev().collect()
}

/// Run every verify command sequentially. Returns (all_ok, failing_cmd, tail).
async fn run_verify_all(workdir: &str, cmds: &[String]) -> (bool, String, String) {
    for cmd in cmds {
        let wd = workdir.to_string();
        let cmd_s = cmd.clone();
        let outcome = tokio::task::spawn_blocking(move || run_test_command_sync(&wd, &cmd_s))
            .await
            .unwrap_or(crate::loop_engine::TestOutcome { ok: false, output: "join failed".into() });
        if !outcome.ok {
            return (false, cmd.clone(), tail4000(&outcome.output));
        }
    }
    (true, String::new(), String::new())
}

enum WaitRes {
    Done,
    Skipped,
    Timeout,
}

/// Wait until the agent goes idle. Updates the step for skip/timeout.
/// Returns None when the user stopped (caller finishes the run).
async fn wait_step_end(
    app: &AppHandle,
    control: &Arc<ContControl>,
    port: u16,
    session_id: &str,
    idx: usize,
    step_started_ms: i64,
) -> Option<WaitRes> {
    let snap = &control.snapshot;
    let ws = std::time::Instant::now();
    loop {
        if control.stop.load(Ordering::Relaxed) {
            abort_session(port, session_id).await;
            return None;
        }
        if control.skip_step.swap(false, Ordering::Relaxed) {
            abort_session(port, session_id).await;
            update(app, snap, |s| {
                if let Some(st) = s.steps.get_mut(idx) { st.status = STEP_SKIPPED.into(); }
            });
            return Some(WaitRes::Skipped);
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if last_assistant_ended_after(port, session_id, step_started_ms).await {
            return Some(WaitRes::Done);
        }
        if ws.elapsed().as_secs() > 900 {
            abort_session(port, session_id).await;
            update(app, snap, |s| {
                if let Some(st) = s.steps.get_mut(idx) { st.status = STEP_ERROR.into(); }
                s.last_error = Some(format!("step {} timed out", idx + 1));
            });
            return Some(WaitRes::Timeout);
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn run(
    app: AppHandle,
    control: Arc<ContControl>,
    cfg: ContinuousConfig,
    workdir: String,
    port: u16,
    resume: bool,
) {
    let snap = &control.snapshot;

    macro_rules! finish {
        ($reason:expr) => {{
            let mut s = snap.lock().unwrap();
            s.running = false;
            s.phase = "done".into();
            if s.stop_reason.is_none() {
                s.stop_reason = Some($reason.to_string());
            }
            let terminal_ok = matches!(
                s.stop_reason.as_deref(),
                Some("completed") | Some("verified_done")
            );
            drop(s);
            // Terminal success clears the recovery file; anything else
            // (user stop, error, budget pause) stays resumable.
            if terminal_ok {
                clear_saved_run(&app);
            } else {
                persist_run(&app, &control);
            }
        }};
    }

    let git_ok = git(&workdir, &["rev-parse", "HEAD"]).is_ok();
    if resume {
        // Crash/restart recovery: the snapshot was preloaded by the caller.
        // In-flight steps go back to pending; the loop re-runs them.
        update(&app, snap, |s| {
            s.running = true;
            s.paused = false;
            s.phase = "executing".into();
            s.hit_reason = None;
        });
        persist_run(&app, &control);
    } else {
    {
        let mut s = snap.lock().unwrap();
        *s = ContinuousSnapshot {
            running: true,
            phase: "planning".into(),
            goal: cfg.goal.clone(),
            started_at: now_ms(),
            git_available: git_ok,
            session_id: Some(cfg.session_id.clone()),
            ..Default::default()
        };
    }
    {
        let g = snap.lock().unwrap();
        push(&app, &g);
    }

    // ---------------- planning ----------------
    // The plan must be verifiable: small steps, acceptance built in.
    let planning_prompt = format!(
        "Analyze the following GOAL and produce a concrete numbered implementation plan \
for an autonomous coding agent that will execute it step by step over many hours.\n\
Rules:\n\
- Do NOT execute anything. Do NOT use any tools. Output ONLY a numbered list:\n\
1. First step\n2. Second step\n...\n\
- Order steps so each one is independently completable and verifiable \
(build + tests stay green after every step).\n\
- Prefer small steps (each should fit in one focused work session).\n\
- If the goal needs it, include steps that add or extend automated tests.\n\
- The LAST step must always be: full end-to-end verification that the GOAL is achieved.\n\n\
GOAL: {}",
        cfg.goal
    );

    let plan_started = now_ms();
    if send_prompt(port, &cfg.session_id, &planning_prompt).await.is_err() {
        update(&app.clone(), snap, |s| s.last_error = Some("failed to send planning prompt".into()));
        finish!("error");
        let g = snap.lock().unwrap(); push(&app, &g); return;
    }

    let wait_start = std::time::Instant::now();
    loop {
        if control.stop.load(Ordering::Relaxed) { finish!("user"); break; }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if last_assistant_ended_after(port, &cfg.session_id, plan_started).await { break; }
        if wait_start.elapsed().as_secs() > 300 {
            abort_session(port, &cfg.session_id).await;
            update(&app.clone(), snap, |s| s.last_error = Some("planning timed out".into()));
            finish!("error");
            break;
        }
    }

    if !snap.lock().unwrap().running {
        let g = snap.lock().unwrap(); push(&app, &g); return;
    }

    let plan_text = last_assistant_text(port, &cfg.session_id).await;
    let descriptions = parse_plan(&plan_text);
    if descriptions.is_empty() {
        update(&app.clone(), snap, |s| {
            s.last_error = Some("could not parse a numbered plan from the reply".into())
        });
        finish!("error");
        let g = snap.lock().unwrap(); push(&app, &g); return;
    }

    {
        let mut s = snap.lock().unwrap();
        s.steps = descriptions
            .iter()
            .enumerate()
            .map(|(i, d)| PlanStep {
                id: format!("step-{i}"),
                description: d.clone(),
                status: STEP_PENDING.into(),
                attempts: 0,
            })
            .collect();
    }
    persist_run(&app, &control);

    // ---------------- approval gate ----------------
    if cfg.approval_mode == ApprovalMode::Manual {
        control.approval.store(0, Ordering::Relaxed);
        snap.lock().unwrap().phase = "awaiting_approval".into();
        {
            let g = snap.lock().unwrap();
            push(&app, &g);
        }

        loop {
            if control.stop.load(Ordering::Relaxed) { finish!("user"); break; }
            match control.approval.load(Ordering::Relaxed) {
                1 => break,
                2 => {
                    finish!("plan_rejected");
                    break;
                }
                _ => tokio::time::sleep(Duration::from_millis(300)).await,
            }
        }
        if !snap.lock().unwrap().running {
            let g = snap.lock().unwrap(); push(&app, &g); return;
        }
    }
    } // end fresh-start block (planning + approval); resume skips it

    // ---------------- execution ----------------
    // Verify pipeline: explicit commands win, legacy single command merges
    // in, otherwise auto-detect from project files. Empty = trust the agent.
    let mut verify_cmds: Vec<String> = cfg
        .verify_commands
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if cfg.run_validation {
        if let Some(cmd) = cfg
            .validation_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            if !verify_cmds.iter().any(|c| c == cmd) {
                verify_cmds.push(cmd.to_string());
            }
        }
    }
    if verify_cmds.is_empty() && cfg.auto_verify {
        verify_cmds = detect_verify_commands(&workdir);
    }
    let verify_enabled = !verify_cmds.is_empty();
    {
        let g = snap.lock().unwrap();
        push(&app, &g);
    }
    snap.lock().unwrap().phase = "executing".into();
    {
        let g = snap.lock().unwrap();
        push(&app, &g);
    }
    persist_run(&app, &control);

    'outer: loop {
        // pause / stop gates first — responsive even with an empty plan
        while control.pause.load(Ordering::Relaxed) {
            if control.stop.load(Ordering::Relaxed) { finish!("user"); break 'outer; }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        if control.stop.load(Ordering::Relaxed) { finish!("user"); break; }

        let (cur_index, total_steps) = {
            let g = snap.lock().unwrap();
            (g.current_index, g.steps.len())
        };
        if cur_index >= total_steps {
            if cfg.until_done && verify_enabled {
                // Final acceptance gate: done only when green.
                let gate_no = snap.lock().unwrap().actions_count + 1;
                let (ok, fcmd, ftail) = run_verify_all(&workdir, &verify_cmds).await;
                update(&app.clone(), snap, |s| {
                    s.last_verify = Some(VerifyReport {
                        command: if ok { "(final gate)".into() } else { fcmd.clone() },
                        ok,
                        attempt: gate_no,
                        output_tail: if ok { String::new() } else { ftail.clone() },
                    });
                });
                let _ = app.emit(
                    CONTINUOUS_EVENT,
                    json!({"type":"validation","index":-1,"ok":ok,"attempt":gate_no}),
                );
                persist_run(&app, &control);
                if ok {
                    finish!("verified_done");
                    break;
                }
                let appended = snap
                    .lock()
                    .unwrap()
                    .steps
                    .iter()
                    .filter(|st| st.id.starts_with("step-fix-"))
                    .count();
                if appended >= MAX_APPENDED_FIX_STEPS {
                    update(&app.clone(), snap, |s| {
                        s.last_error = Some(format!(
                            "verification still failing after {MAX_APPENDED_FIX_STEPS} fix rounds"
                        ));
                    });
                    finish!("error");
                    break;
                }
                let desc = format!(
                    "Fix remaining verification failures ({}):\n{}",
                    fcmd,
                    ftail.chars().take(800).collect::<String>()
                );
                update(&app.clone(), snap, |s| {
                    s.steps.push(PlanStep {
                        id: format!("step-fix-{}", now_ms()),
                        description: desc,
                        status: STEP_PENDING.into(),
                        attempts: 0,
                    });
                });
                persist_run(&app, &control);
                continue;
            } else {
                break;
            }
        }

        let idx = cur_index;

        // limits (checked at step boundaries); guard released before any await
        enum LimitHit { None, Actions, Time, Cost }
        let hit = {
            let g = snap.lock().unwrap();
            let elapsed_min = (now_ms() - g.started_at).max(0) as f64 / 60_000.0;
            if cfg.max_actions > 0 && g.actions_count >= cfg.max_actions {
                LimitHit::Actions
            } else if elapsed_min > cfg.max_time_minutes as f64 {
                LimitHit::Time
            } else if cfg.max_cost_usd > 0.0 && g.cost_usd >= cfg.max_cost_usd {
                LimitHit::Cost
            } else if g.paused {
                // already paused (e.g. validation failure from previous step)
                LimitHit::Time /* reuse wait path below */
            } else {
                LimitHit::None
            }
        };

        match hit {
            LimitHit::None => {}
            reason => {
                if !matches!(reason, LimitHit::Time) {
                    update(&app.clone(), snap, |s| {
                        s.paused = true;
                        s.phase = "paused".into();
                        s.hit_reason = Some(
                            match reason {
                                LimitHit::Actions => "limit_actions",
                                LimitHit::Time => "limit_time",
                                LimitHit::Cost => "limit_cost",
                                LimitHit::None => unreachable!(),
                            }
                            .into(),
                        );
                    });
                }
                // wait for resume or stop
                loop {
                    if control.stop.load(Ordering::Relaxed) { finish!("user"); break 'outer; }
                    let paused_now = control.pause.load(Ordering::Relaxed)
                        || snap.lock().unwrap().paused;
                    if !paused_now {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
                continue;
            }
        }

        // checkpoint before step
        if cfg.checkpoints && git_ok {
            let hash = git(&workdir, &["rev-parse", "HEAD"]).ok();
            let cp = Checkpoint {
                id: format!("cp-{}", now_ms()),
                ts: now_ms(),
                description: format!("before step {}", idx + 1),
                hash,
            };
            update(&app.clone(), snap, |s| {
                s.checkpoints.push(cp);
                if s.checkpoints.len() > 50 {
                    s.checkpoints.remove(0);
                }
            });
        }

        update(&app.clone(), snap, |s| {
            if let Some(step) = s.steps.get_mut(idx) {
                step.status = STEP_IN_PROGRESS.into();
            }
            s.current_index = idx;
        });
        persist_run(&app, &control);

        // ---- attempt loop: agent turn -> verify -> fix prompt -> retry ----
        let max_attempts = 1 + cfg.max_retries_per_step;
        let mut attempt: u32 = 0;
        let mut send_fails: u32 = 0;
        let mut sig_before = work_sig(&workdir, git_ok);
        let mut stuck_rounds: u32 = 0;
        let mut fail_cmd = String::new();
        let mut fail_tail = String::new();

        enum AttemptEnd { Completed, Skipped, TimedOut, Parked }
        let mut stopped = false;
        let end = loop {
            if control.stop.load(Ordering::Relaxed) {
                abort_session(port, &cfg.session_id).await;
                finish!("user");
                stopped = true;
                break AttemptEnd::Parked;
            }
            if control.skip_step.swap(false, Ordering::Relaxed) {
                abort_session(port, &cfg.session_id).await;
                update(&app.clone(), snap, |s| {
                    if let Some(st) = s.steps.get_mut(idx) { st.status = STEP_SKIPPED.into(); }
                });
                persist_run(&app, &control);
                break AttemptEnd::Skipped;
            }

            let prompt = if attempt == 0 {
                let g = snap.lock().unwrap();
                step_prompt(&cfg.goal, &g.steps, idx)
            } else {
                let desc = snap
                    .lock()
                    .unwrap()
                    .steps
                    .get(idx)
                    .map(|s| s.description.clone())
                    .unwrap_or_default();
                fix_prompt(&desc, idx, &fail_cmd, &fail_tail, stuck_rounds >= 2)
            };

            if send_prompt(port, &cfg.session_id, &prompt).await.is_err() {
                // Transient transport failure: bounded retries, then park.
                // (Skip is re-checked at the top of the next iteration.)
                send_fails += 1;
                if send_fails > 3 {
                    update(&app.clone(), snap, |s| {
                        if let Some(st) = s.steps.get_mut(idx) { st.status = STEP_ERROR.into(); }
                        s.last_error = Some("failed to send step prompt".into());
                        s.paused = true;
                        s.phase = "paused".into();
                        s.hit_reason = Some("step_error".into());
                    });
                    persist_run(&app, &control);
                    break AttemptEnd::Parked;
                }
                tokio::time::sleep(Duration::from_millis(2000)).await;
                continue;
            }

            let step_started = now_ms();
            match wait_step_end(&app, &control, port, &cfg.session_id, idx, step_started).await {
                None => {
                    finish!("user");
                    stopped = true;
                    break AttemptEnd::Parked;
                }
                Some(WaitRes::Skipped) => break AttemptEnd::Skipped,
                Some(WaitRes::Timeout) => break AttemptEnd::TimedOut,
                Some(WaitRes::Done) => {}
            }

            attempt += 1;
            let reply = last_assistant_text(port, &cfg.session_id).await;
            let cost_now = session_cost(port, &cfg.session_id).await;
            update(&app.clone(), snap, |s| {
                if let Some(st) = s.steps.get_mut(idx) {
                    st.attempts = attempt;
                }
                s.actions_count += 1;
                s.cost_usd = cost_now;
                if cfg.detect_subtasks && !reply.is_empty() {
                    let mut offset = 1usize;
                    for task in detect_subtasks(&reply) {
                        if s.steps.iter().any(|x| x.description == task) {
                            continue;
                        }
                        let id = format!("step-sub-{}-{}", now_ms(), s.steps.len());
                        s.steps.insert(
                            (idx + offset).min(s.steps.len()),
                            PlanStep { id, description: task, status: STEP_PENDING.into(), attempts: 0 },
                        );
                        offset += 1;
                    }
                }
            });
            persist_run(&app, &control);

            if !verify_enabled {
                update(&app.clone(), snap, |s| {
                    if let Some(st) = s.steps.get_mut(idx) {
                        let terminal = matches!(
                            st.status.as_str(),
                            STEP_SKIPPED | STEP_ERROR
                        );
                        if !terminal {
                            st.status = STEP_COMPLETED.into();
                        }
                    }
                });
                persist_run(&app, &control);
                break AttemptEnd::Completed;
            }

            let (ok, fcmd, ftail) = run_verify_all(&workdir, &verify_cmds).await;
            update(&app.clone(), snap, |s| {
                s.last_verify = Some(VerifyReport {
                    command: if ok { "(step gate)".into() } else { fcmd.clone() },
                    ok,
                    attempt,
                    output_tail: if ok { String::new() } else { ftail.clone() },
                });
            });
            let _ = app.emit(
                CONTINUOUS_EVENT,
                json!({"type":"validation","index":idx,"ok":ok,"attempt":attempt}),
            );
            persist_run(&app, &control);

            let sig_after = work_sig(&workdir, git_ok);
            if sig_after != sig_before {
                stuck_rounds = 0;
            } else {
                stuck_rounds += 1;
            }
            sig_before = sig_after;

            if ok {
                update(&app.clone(), snap, |s| {
                    if let Some(st) = s.steps.get_mut(idx) {
                        let terminal = matches!(
                            st.status.as_str(),
                            STEP_SKIPPED | STEP_ERROR
                        );
                        if !terminal {
                            st.status = STEP_COMPLETED.into();
                        }
                    }
                });
                persist_run(&app, &control);
                break AttemptEnd::Completed;
            }

            fail_cmd = fcmd;
            fail_tail = ftail;
            if attempt >= max_attempts {
                let tail_head: String = fail_tail.chars().take(300).collect();
                let cmd_head = fail_cmd.clone();
                update(&app.clone(), snap, |s| {
                    if let Some(st) = s.steps.get_mut(idx) { st.status = STEP_ERROR.into(); }
                    s.paused = true;
                    s.phase = "paused".into();
                    s.hit_reason = Some("validation_failed".into());
                    s.last_error = Some(format!("{cmd_head}: {tail_head}"));
                });
                persist_run(&app, &control);
                break AttemptEnd::Parked;
            }
            // Otherwise loop back with the fix prompt.
        };

        if stopped {
            break;
        }
        match end {
            AttemptEnd::Parked => continue, // paused gate at top waits
            AttemptEnd::Completed => {}
            AttemptEnd::Skipped | AttemptEnd::TimedOut => {
                // Same tail the old code ran for every wait outcome.
                let reply = last_assistant_text(port, &cfg.session_id).await;
                let cost_now = session_cost(port, &cfg.session_id).await;
                update(&app.clone(), snap, |s| {
                    s.cost_usd = cost_now;
                    if cfg.detect_subtasks && !reply.is_empty() {
                        let mut offset = 1usize;
                        for task in detect_subtasks(&reply) {
                            if s.steps.iter().any(|x| x.description == task) {
                                continue;
                            }
                            let id = format!("step-sub-{}-{}", now_ms(), s.steps.len());
                            s.steps.insert(
                                (idx + offset).min(s.steps.len()),
                                PlanStep { id, description: task, status: STEP_PENDING.into(), attempts: 0 },
                            );
                            offset += 1;
                        }
                    }
                });
                persist_run(&app, &control);
            }
        }

        // advance
        update(&app.clone(), snap, |s| s.current_index = s.steps.iter().position(|st| st.status == STEP_PENDING).unwrap_or(s.steps.len()));
        persist_run(&app, &control);

        // hitl on error pause loops back to gate at top
        if snap.lock().unwrap().paused {
            continue;
        }
    }

    {
        let mut s = snap.lock().unwrap();
        s.running = false;
        s.phase = "done".into();
        if s.stop_reason.is_none() {
            s.stop_reason = Some("completed".into());
        }
        let terminal_ok = matches!(
            s.stop_reason.as_deref(),
            Some("completed") | Some("verified_done")
        );
        drop(s);
        if terminal_ok {
            clear_saved_run(&app);
        } else {
            persist_run(&app, &control);
        }
    }
    let g = snap.lock().unwrap();
    push(&app, &g);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

fn ensure_idle(state: &State<'_, AppState>) -> Result<(), String> {
    if let Some(h) = state.continuous_handle.lock().unwrap().as_ref() {
        if h.control.snapshot.lock().unwrap().running {
            return Err("continuous mode is already running".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn continuous_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ContinuousConfig,
) -> Result<ContinuousSnapshot, String> {
    ensure_idle(&state)?;
    if config.goal.trim().is_empty() {
        return Err("goal is empty".into());
    }
    if config.session_id.trim().is_empty() {
        return Err("session is not selected".into());
    }
    let (port, workdir) = {
        let g = state.server.lock().unwrap();
        match g.as_ref() {
            Some(s) => (s.info.port, s.info.work_dir.clone()),
            None => return Err("server is not running".into()),
        }
    };

    let control = Arc::new(ContControl {
        stop: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(AtomicBool::new(false)),
        approval: Arc::new(AtomicI8::new(0)),
        skip_step: Arc::new(AtomicBool::new(false)),
        config_json: serde_json::to_string(&config).unwrap_or_default(),
        snapshot: Arc::new(Mutex::new(ContinuousSnapshot {
            running: true,
            phase: "planning".into(),
            goal: config.goal.clone(),
            session_id: Some(config.session_id.clone()),
            started_at: now_ms(),
            ..Default::default()
        })),
    });

    tokio::spawn(run(
        app.clone(),
        Arc::clone(&control),
        config,
        workdir,
        port,
        false,
    ));

    *state.continuous_handle.lock().unwrap() = Some(ContinuousHandle {
        control: Arc::clone(&control),
    });

    let snapshot_now = control.snapshot.lock().unwrap().clone();
    Ok(snapshot_now)
}

/// Continue a previously saved run (after app restart, crash or user stop).
/// Picks up the persisted snapshot, re-queues in-flight steps and continues
/// execution with the same session. Refuses finished runs.
#[tauri::command]
pub async fn continuous_resume_saved(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ContinuousSnapshot, String> {
    ensure_idle(&state)?;
    let saved = load_saved_run(&app)?;
    if matches!(
        saved.snapshot.stop_reason.as_deref(),
        Some("completed") | Some("verified_done")
    ) {
        return Err("saved run already finished".into());
    }
    let (port, workdir) = {
        let g = state.server.lock().unwrap();
        match g.as_ref() {
            Some(s) => (s.info.port, s.info.work_dir.clone()),
            None => return Err("server is not running".into()),
        }
    };
    // The opencode session must still exist (sessions persist server-side).
    let probe = api::oc_request(
        port,
        api::OcRequest {
            method: "GET".into(),
            path: format!("/session/{}", saved.config.session_id),
            body: None,
        },
    )
    .await;
    if probe.is_err() {
        return Err("saved session is gone — start a fresh run".into());
    }

    let mut snap = saved.snapshot;
    snap.running = true;
    snap.paused = false;
    snap.phase = "executing".into();
    snap.hit_reason = None;
    snap.last_error = None;
    for st in snap.steps.iter_mut() {
        if st.status == STEP_IN_PROGRESS {
            st.status = STEP_PENDING.into();
        }
    }
    snap.current_index = snap
        .steps
        .iter()
        .position(|st| st.status == STEP_PENDING)
        .unwrap_or(snap.steps.len());

    let control = Arc::new(ContControl {
        stop: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(AtomicBool::new(false)),
        approval: Arc::new(AtomicI8::new(0)),
        skip_step: Arc::new(AtomicBool::new(false)),
        config_json: serde_json::to_string(&saved.config).unwrap_or_default(),
        snapshot: Arc::new(Mutex::new(snap)),
    });

    tokio::spawn(run(
        app.clone(),
        Arc::clone(&control),
        saved.config,
        workdir,
        port,
        true,
    ));

    *state.continuous_handle.lock().unwrap() = Some(ContinuousHandle {
        control: Arc::clone(&control),
    });

    let snapshot_now = control.snapshot.lock().unwrap().clone();
    Ok(snapshot_now)
}

/// Preview auto-detected verify commands for a workdir (UI helper).
#[tauri::command]
pub fn continuous_detect_validation(
    state: State<'_, AppState>,
    workdir: Option<String>,
) -> Result<Vec<String>, String> {
    let wd = match workdir.map(|w| w.trim().to_string()).filter(|w| !w.is_empty()) {
        Some(w) => w,
        None => state
            .server
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.info.work_dir.clone())
            .ok_or_else(|| "server is not running".to_string())?,
    };
    Ok(detect_verify_commands(&wd))
}

#[tauri::command]
pub fn continuous_stop(state: State<'_, AppState>) {
    if let Some(h) = state.continuous_handle.lock().unwrap().as_ref() {
        h.control.stop.store(true, Ordering::Relaxed);
        h.control.pause.store(false, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn continuous_pause(state: State<'_, AppState>, paused: bool) {
    if let Some(h) = state.continuous_handle.lock().unwrap().as_ref() {
        h.control.pause.store(paused, Ordering::Relaxed);
        let mut s = h.control.snapshot.lock().unwrap();
        s.paused = paused;
        if paused && s.running {
            s.phase = "paused".into();
        } else if !paused && s.hit_reason.is_some() {
            s.hit_reason = None;
            if s.running {
                s.phase = "executing".into();
            }
        }
    }
}

/// Resume after an automatic HITL pause (clears pause AND hit_reason).
#[tauri::command]
pub fn continuous_resume(state: State<'_, AppState>) {
    if let Some(h) = state.continuous_handle.lock().unwrap().as_ref() {
        h.control.pause.store(false, Ordering::Relaxed);
        let mut s = h.control.snapshot.lock().unwrap();
        s.paused = false;
        s.hit_reason = None;
        if s.running {
            s.phase = "executing".into();
        }
    }
}

#[tauri::command]
pub fn continuous_approve_plan(state: State<'_, AppState>, approved: bool) {
    if let Some(h) = state.continuous_handle.lock().unwrap().as_ref() {
        h.control.approval.store(if approved { 1 } else { 2 }, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn continuous_skip_step(state: State<'_, AppState>) {
    if let Some(h) = state.continuous_handle.lock().unwrap().as_ref() {
        h.control.skip_step.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn continuous_status(state: State<'_, AppState>) -> ContinuousSnapshot {
    match state.continuous_handle.lock().unwrap().as_ref() {
        Some(h) => h.control.snapshot.lock().unwrap().clone(),
        None => ContinuousSnapshot::default(),
    }
}

#[tauri::command]
pub async fn continuous_rollback(
    state: State<'_, AppState>,
    checkpoint_id: String,
) -> Result<(), String> {
    let (hash, workdir) = {
        let h_guard = state.continuous_handle.lock().unwrap();
        let Some(h) = h_guard.as_ref() else {
            return Err("no continuous run".into());
        };
        let snap = h.control.snapshot.lock().unwrap();
        if snap.running && !snap.paused {
            return Err("stop or pause before rollback".into());
        }
        let cp = snap
            .checkpoints
            .iter()
            .find(|c| c.id == checkpoint_id)
            .ok_or_else(|| "checkpoint not found".to_string())?;
        let Some(hash) = cp.hash.clone() else {
            return Err("checkpoint has no git hash".into());
        };
        let wd = state
            .server
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.info.work_dir.clone())
            .ok_or_else(|| "server not running".to_string())?;
        (hash, wd)
    };

    crate::loop_engine::git(&workdir, &["reset", "--hard", &hash])
        .map_err(|e| format!("reset failed: {e}"))?;
    Ok(())
}
