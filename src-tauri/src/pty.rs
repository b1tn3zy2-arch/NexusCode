//! Embedded PTY sessions (fallback mode): runs OpenCode TUI inside the app.
//!
//! Multiple concurrent sessions are supported, keyed by a frontend-provided
//! session id. Events are emitted as `{ session, data }` objects where `data`
//! is base64 output, or the `"__EXITED__"` sentinel when the child ends.

use base64::Engine as _;
use portable_pty::{
    native_pty_system, CommandBuilder, MasterPty, PtySize,
};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

pub const PTY_EVENT: &str = "oc-pty";

pub struct PtySlot {
    pub master: Option<Box<dyn MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub dead: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
pub struct PtySpawnResult {
    pub ok: bool,
}

fn emit_data(app: &AppHandle, session: &str, data: &str) {
    let _ = app.emit(
        PTY_EVENT,
        serde_json::json!({ "session": session, "data": data }),
    );
}

fn reader_thread(
    app: AppHandle,
    session: String,
    mut reader: Box<dyn Read + Send>,
    dead: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let payload = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                emit_data(&app, &session, &payload);
            }
            Err(_) => break,
        }
        if dead.load(Ordering::Relaxed) {
            break;
        }
    }
    emit_data(&app, &session, "__EXITED__");
}

fn kill_slot(slot: &PtySlot) {
    slot.dead.store(true, Ordering::Relaxed);
    let _ = slot.child.lock().unwrap().kill();
}

/// Kill every live PTY session (used on server stop / app exit).
pub fn pty_kill_all_inner(state: &State<'_, AppState>) {
    let mut guard = state.pty.lock().unwrap();
    for (_, slot) in guard.iter() {
        kill_slot(slot);
    }
    guard.clear();
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    session: String,
    binary_path: String,
    work_dir: String,
    rows: u16,
    cols: u16,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    venv: Option<String>,
    bundled_python: Option<bool>,
) -> Result<PtySpawnResult, String> {
    if session.trim().is_empty() {
        return Err("session id is empty".into());
    }

    // Replace any previous session with the same id.
    if let Some(old) = state.pty.lock().unwrap().remove(&session) {
        kill_slot(&old);
    }

    if !std::path::Path::new(&work_dir).is_dir() {
        return Err(format!("work_dir does not exist: {work_dir}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&binary_path);
    cmd.cwd(&work_dir);
    cmd.args(args.unwrap_or_default());
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    // Layered PATH, highest priority last-prepended:
    // process PATH -> bundled interpreter -> project venv (wins).
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut path = std::env::var("PATH").unwrap_or_default();
    // Bundled interpreter (+Scripts) on PATH so bare `python` / `pip`
    // just work. Used when forced (NexusCode profile) or as automatic
    // fallback when no venv and no system python exist. Venv below wins.
    let venv_empty = venv
        .as_ref()
        .map(|d| d.trim().trim_end_matches(['/', '\\']).is_empty())
        .unwrap_or(true);
    let want_bundled =
        bundled_python.unwrap_or(false) || (venv_empty && crate::python::path_python().is_none());
    if want_bundled {
        if let Some(bin) = crate::python::installed_bin(&app) {
            if let Some(dir) = bin.parent() {
                let scripts = dir.join(if cfg!(windows) { "Scripts" } else { "bin" });
                path = format!(
                    "{dir}{sep}{scripts}{sep}{path}",
                    dir = dir.display(),
                    scripts = scripts.display(),
                    sep = sep,
                    path = path,
                );
            }
        }
    }
    // Python venv: point PATH at its Scripts/bin dir so `python`/`pip`
    // resolve to the venv, like VS Code's activated terminal.
    if let Some(dir) = venv {
        let dir = dir.trim().trim_end_matches(['/', '\\']).to_string();
        if !dir.is_empty() {
            let scripts = if cfg!(windows) {
                format!("{dir}\\Scripts")
            } else {
                format!("{dir}/bin")
            };
            cmd.env("VIRTUAL_ENV", &dir);
            path = format!("{scripts}{sep}{path}");
        }
    }
    cmd.env("PATH", &path);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let dead = Arc::new(AtomicBool::new(false));

    // process exit closes the pty => reader hits EOF and emits __EXITED__
    std::thread::spawn({
        let app = app.clone();
        let dead = Arc::clone(&dead);
        let session = session.clone();
        move || reader_thread(app, session, reader, dead)
    });

    state.pty.lock().unwrap().insert(
        session,
        PtySlot {
            master: Some(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            dead,
        },
    );

    Ok(PtySpawnResult { ok: true })
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, session: String, data_b64: String) -> Result<(), String> {
    use base64::Engine as _;
    let guard = state.pty.lock().unwrap();
    let Some(slot) = guard.get(&session) else {
        return Err("no pty session".into());
    };
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| e.to_string())?;
    let mut w = slot.writer.lock().unwrap();
    w.write_all(&raw).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// True when the backend still holds a RUNNING process for the session.
/// Used on remount to avoid respawning (and wiping) a live session.
/// Dead slots are reaped on the spot.
#[tauri::command]
pub fn pty_alive(state: State<'_, AppState>, session: String) -> bool {
    let mut guard = match state.pty.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let alive = guard
        .get(&session)
        .map(|slot| {
            if slot.dead.load(Ordering::Relaxed) {
                return false;
            }
            match slot.child.lock() {
                Ok(mut child) => matches!(child.try_wait(), Ok(None)),
                Err(_) => false,
            }
        })
        .unwrap_or(false);
    if !alive {
        guard.remove(&session);
    }
    alive
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, session: String, rows: u16, cols: u16) -> Result<(), String> {
    let guard = state.pty.lock().unwrap();
    let Some(slot) = guard.get(&session) else {
        return Err("no pty session".into());
    };
    if let Some(master) = slot.master.as_ref() {
        master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(app: AppHandle, state: State<'_, AppState>, session: String) {
    if let Some(slot) = state.pty.lock().unwrap().remove(&session) {
        kill_slot(&slot);
    }
    emit_data(&app, &session, "__EXITED__");
}
