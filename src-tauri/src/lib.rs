mod action_log;
mod api;
mod auto_approve;
mod auto_approve_core;
mod continuous;
mod continuous_core;
mod images;
mod loop_core;
mod loop_engine;
mod pty;
mod python;
mod server_manager;
mod sse_bridge;
mod fs_edit;
mod fs_explorer;
mod git;
mod sidecar_updater;
mod voice_input;
mod integrity;
pub mod vault;
pub mod vpn;

use action_log::ActionLog;
use auto_approve::AutoApproveConfig;
use server_manager::{ManagedServer, ServerInfo, StartConfig};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

pub static LAST_CHILD_STDOUT: Mutex<Option<Arc<Mutex<String>>>> = Mutex::new(None);
pub static LAST_CHILD_STDERR: Mutex<Option<Arc<Mutex<String>>>> = Mutex::new(None);

/// Append-only log with size rotation (2 MB → `.1`, keeps 2 files).
/// Never throws: logging must not break the app it instruments.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

pub fn log_line(msg: &str) {
    use std::io::Write;
    let Ok(temp) = std::env::var("TEMP") else { return };
    let path = std::path::Path::new(&temp).join("opencode-gui.log");
    // Rotate before appending so a runaway loop can't fill the disk.
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
        let prev = std::path::Path::new(&temp).join("opencode-gui.log.1");
        let _ = std::fs::remove_file(&prev);
        let _ = std::fs::rename(&path, &prev);
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now(), msg);
}

// ---------------------------------------------------------------------------
// single-instance lock
// ---------------------------------------------------------------------------

fn app_data_dir() -> std::path::PathBuf {
    let base = if cfg!(windows) {
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into())
    } else {
        std::env::var("XDG_DATA_HOME")
            .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.local/share")))
            .unwrap_or_else(|_| ".".into())
    };
    std::path::Path::new(&base).join("nexuscode")
}

#[cfg(target_os = "windows")]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        // verify it's actually a nexuscode process (avoid pid reuse false positive)
        let mut buf = [0u16; 260];
        let len = GetProcessImageFileNameW(h, buf.as_mut_ptr(), buf.len() as u32);
        CloseHandle(h);
        if len == 0 {
            return false;
        }
        let name = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        // stale if not nexuscode / not alive
        name.contains("nexuscode")
    }
}

#[cfg(not(target_os = "windows"))]
fn pid_alive(_pid: u32) -> bool {
    // conservative: assume another instance is alive
    true
}

fn acquire_instance_lock() -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("app.lock");

    let try_create = || -> Result<(), std::io::Error> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        write!(f, "{}", std::process::id())?;
        Ok(())
    };

    match try_create() {
        Ok(()) => return Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }

    // stale lock check
    let stale = std::fs::read_to_string(&path)
        .ok()
        .and_then(|txt| txt.trim().parse::<u32>().ok())
        .map(|pid| pid != std::process::id() && !pid_alive(pid))
        .unwrap_or(true);

    if stale {
        let _ = std::fs::remove_file(&path);
        try_create().map_err(|e| e.to_string())?;
        return Ok(path);
    }

    Err("another OpenCode GUI instance is already running".into())
}

fn release_instance_lock(path: &std::path::PathBuf) {
    let _ = std::fs::remove_file(path);
}

pub struct AppState {
    pub vpn: Mutex<vpn::VpnManager>,
    server: Mutex<Option<ManagedServer>>,
    sse_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    engine: Mutex<Option<Arc<auto_approve::RuleEngine>>>,
    pending: Mutex<HashMap<String, auto_approve::PermissionRequest>>,
    loop_handle: Mutex<Option<loop_engine::LoopHandle>>,
    continuous_handle: Mutex<Option<continuous::ContinuousHandle>>,
    pty: Mutex<HashMap<String, pty::PtySlot>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            vpn: Mutex::new(vpn::VpnManager::new()),
            server: Mutex::new(None),
            sse_task: Mutex::new(None),
            engine: Mutex::new(Some(Arc::new(auto_approve::RuleEngine::new(
                AutoApproveConfig::default(),
            )))),
            pending: Mutex::new(HashMap::new()),
            loop_handle: Mutex::new(None),
            continuous_handle: Mutex::new(None),
            pty: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct StatusPayload {
    pub running: bool,
    pub info: Option<ServerInfo>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
fn resolve_binary(configured: Option<String>) -> Result<String, String> {
    if let Some(path) = configured {
        let trimmed = path.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
            return Ok(trimmed.to_string());
        }
    }

    // 1) Bundled sidecar next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(format!("opencode{}", std::env::consts::EXE_SUFFIX));
            if sidecar.is_file() {
                return Ok(sidecar.to_string_lossy().into_owned());
            }
        }
    }

    // 2) PATH
    if let Ok(path_var) = std::env::var("PATH") {
        let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }

    // 3) Standard install location
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let candidate = std::path::Path::new(&home)
            .join(".opencode")
            .join("bin")
            .join(if cfg!(windows) { "opencode.exe" } else { "opencode" });
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }

    Err("OpenCode binary not found. Reinstall NexusCode (bundled CLI) or set the path in Settings.".to_string())
}

#[tauri::command]
fn default_workdir() -> String {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

/// Open a local file with the default application (e.g. html in browser).
/// Goes through the opener's Rust API directly: unlike the JS `openPath`,
/// local paths are NOT subject to the frontend scope policy that rejects
/// them with "Not allowed to open path".
#[tauri::command]
fn open_in_browser(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Файл не найден: {path}"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct McpListPayload {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run `opencode mcp list` for connection statuses. Runs in `work_dir`
/// when set so project-level servers resolve correctly.
#[tauri::command]
async fn mcp_list(binary_path: String, work_dir: Option<String>) -> Result<McpListPayload, String> {
    use tokio::process::Command;
    let mut cmd = Command::new(&binary_path);
    cmd.args(["mcp", "list"]);
    if let Some(dir) = work_dir.filter(|d| !d.trim().is_empty()) {
        cmd.current_dir(dir);
    }
    // Hide the console window on Windows (tokio provides this inherently).
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| "opencode mcp list timed out (20s)".to_string())?
        .map_err(|e| format!("failed to run opencode mcp list: {e}"))?;
    Ok(McpListPayload {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn stop_internal(state: &State<AppState>) {
    // VPN first: kill sing-box so no proxied traffic outlives the app.
    state.vpn.lock().unwrap().kill_blocking();
    if let Some(loop_h) = state.loop_handle.lock().unwrap().as_ref() {
        loop_h.control.stop.store(true, AtomicOrdering::Relaxed);
    }
    if let Some(cont_h) = state.continuous_handle.lock().unwrap().as_ref() {
        cont_h.control.stop.store(true, AtomicOrdering::Relaxed);
    }

    // Graceful settle: loop/continuous tasks are intentionally detached (flags
    // only, no JoinHandle), so give them up to ~3s to observe `stop` and park
    // their snapshots. Otherwise a following server_start races a dying run's
    // abort/prompt calls against the fresh port.
    for _ in 0..30 {
        let loop_running = state
            .loop_handle
            .lock()
            .unwrap()
            .as_ref()
            .map(|h| h.control.snapshot.lock().unwrap().running)
            .unwrap_or(false);
        let cont_running = state
            .continuous_handle
            .lock()
            .unwrap()
            .as_ref()
            .map(|h| h.control.snapshot.lock().unwrap().running)
            .unwrap_or(false);
        if !loop_running && !cont_running {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    if let Some(task) = state.sse_task.lock().unwrap().take() {
        task.abort();
    }

    if let Some(mut server) = state.server.lock().unwrap().take() {
        let _ = server.child.kill();
        let _ = server.child.wait();
    }

    pty::pty_kill_all_inner(&state);
}

#[tauri::command]
async fn server_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config: StartConfig,
) -> Result<ServerInfo, String> {
    log_line("server_start: begin");
    stop_internal(&state);

    let work_dir = std::path::Path::new(&config.work_dir);
    if !work_dir.is_dir() {
        let msg = format!("work_dir does not exist: {}", config.work_dir);
        log_line(&msg);
        return Err(msg);
    }

    // Refuse to execute a tampered sidecar (neutral error, no details).
    integrity::verify_sidecar(&config.binary_path)?;

    log_line(
        &format!(
            "server_start: spawning '{}' in '{}' (requested port {:?})",
            config.binary_path, config.work_dir, config.port
        ),
    );
    // Decisive diagnostic: was the sidecar given proxy env or not?
    // (Only on/off is logged — never URLs, keys or server names.)
    if config
        .proxy_url
        .as_ref()
        .map(|u| !u.trim().is_empty())
        .unwrap_or(false)
    {
        log_line("server_start: VPN proxy env ON for sidecar");
    } else {
        log_line("server_start: VPN proxy env OFF (direct)");
    }

    let mut managed = tokio::task::spawn_blocking({
        let cfg = config.clone();
        move || server_manager::spawn_server(&cfg)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Close the resolve→verify→spawn TOCTOU window: re-hash the image right
    // after spawn. If it changed under us, kill the child and refuse.
    if let Err(e) = integrity::verify_sidecar(&config.binary_path) {
        log_line("server_start: post-spawn integrity FAILED, killing child");
        let _ = managed.child.kill();
        let _ = managed.child.wait();
        stop_internal(&state);
        return Err(e);
    }

    let port = managed.info.port;
    log_line(&format!("server_start: spawned pid {}, waiting health on :{port}", managed.info.pid));

    match api::wait_for_health(port, 20_000).await {
        Ok(health) => {
            log_line(&format!("server_start: healthy on :{port}"));
            let handle = sse_bridge::start(app.clone(), port);
            *state.sse_task.lock().unwrap() = Some(handle);
            let info = clone_info(&managed.info);
            *state.server.lock().unwrap() = Some(managed);

            let _ = app.emit(
                sse_bridge::EVENT_NAME,
                serde_json::json!({
                    "type": "bridge.connected",
                    "properties": { "port": port, "health": health }
                }),
            );

            Ok(info)
        }
        Err(e) => {
            let stderr_tail = LAST_CHILD_STDERR
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|buf| {
                    let s = buf.lock().unwrap();
                    Some(s.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>())
                })
                .unwrap_or_default();
            let msg = format!("{e}; child stderr: {stderr_tail}");
            log_line(&format!("server_start failed: {msg}"));
            stop_internal(&state);
            Err(msg)
        }
    }
}

#[tauri::command]
fn server_stop(state: State<'_, AppState>) {
    stop_internal(&state);
}

#[tauri::command]
fn server_status(state: State<'_, AppState>) -> StatusPayload {
    let mut guard = state.server.lock().unwrap();

    match guard.as_mut() {
        Some(server) => {
            if server_manager::is_alive(server) {
                StatusPayload {
                    running: true,
                    info: Some(clone_info(&server.info)),
                }
            } else {
                *guard = None;
                StatusPayload {
                    running: false,
                    info: None,
                }
            }
        }
        None => StatusPayload {
            running: false,
            info: None,
        },
    }
}

fn clone_info(info: &ServerInfo) -> ServerInfo {
    ServerInfo {
        port: info.port,
        pid: info.pid,
        work_dir: info.work_dir.clone(),
        binary_path: info.binary_path.clone(),
    }
}

#[tauri::command]
async fn oc_request(state: State<'_, AppState>, request: api::OcRequest) -> Result<Value, String> {
    let port = {
        let guard = state.server.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.info.port,
            None => return Err("server is not running".to_string()),
        }
    };
    api::oc_request(port, request).await
}

// note: kept sync-free; heavy work off the IPC thread
#[tauri::command]
async fn prepare_image(data_b64: String) -> Result<images::PreparedImage, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&data_b64)
            .map_err(|e| format!("bad base64: {e}"))?;
        images::prepare_bytes(&raw)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_image_file(path: String) -> Result<images::PreparedImage, String> {
    tokio::task::spawn_blocking(move || images::read_image_file(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn capture_screen() -> Result<images::PreparedImage, String> {
    // GDI screen capture must run on the main thread on some setups; keep it sync-fast.
    images::capture_screen()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_line("app: starting");
    // panic=abort still runs this hook; capture a backtrace explicitly since
    // abort skips the runtime's own trace printing.
    std::panic::set_hook(Box::new(|info| {
        let trace = std::backtrace::Backtrace::force_capture();
        log_line(&format!("PANIC: {info}\n{trace}"));
    }));

    let lock_path = match acquire_instance_lock() {
        Ok(p) => p,
        Err(e) => {
            log_line(&format!("instance lock: {e}"));
            eprintln!("OpenCode GUI: {e}");
            return;
        }
    };

    let action_log = match ActionLog::open() {
        Ok(log) => Some(log),
        Err(e) => {
            log_line(&format!("action_log open failed: {e}"));
            None
        }
    };

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(sidecar_updater::SidecarUpdater::new())
        .manage(voice_input::VoiceInput::new());

    if let Some(log) = action_log {
        builder = builder.manage(log);
    }

    builder.invoke_handler(tauri::generate_handler![
            greet,
            resolve_binary,
            default_workdir,
            open_in_browser,
            mcp_list,
            vpn::vpn_parse_link,
            vpn::vpn_import_subscription,
            vpn::vpn_start,
            vpn::vpn_stop,
            vpn::vpn_status,
            vpn::vpn_ping,
            vpn::vpn_egress_ip,
            vpn::net_fetch,
            vault::vault_set,
            vault::vault_get,
            vault::vault_delete,
            server_start,
            server_stop,
            server_status,
            oc_request,
            auto_approve::set_auto_approve_config,
            auto_approve::permission_respond,
            auto_approve::action_log_list,
            auto_approve::action_log_clear,
            prepare_image,
            read_image_file,
            capture_screen,
            loop_engine::loop_start,
            loop_engine::loop_stop,
            loop_engine::loop_pause,
            loop_engine::loop_status,
            continuous::continuous_start,
            continuous::continuous_stop,
            continuous::continuous_pause,
            continuous::continuous_resume,
            continuous::continuous_approve_plan,
            continuous::continuous_skip_step,
            continuous::continuous_status,
            continuous::continuous_rollback,
            continuous::continuous_resume_saved,
            continuous::continuous_detect_validation,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_alive,
            python::detect_python,
            python::python_bundled_status,
            python::setup_bundled_python,
            voice_input::voice_start,
            voice_input::voice_stop,
            voice_input::voice_status,
            voice_input::voice_check_availability,
            sidecar_updater::sidecar_current_version,
            sidecar_updater::sidecar_check,
            sidecar_updater::sidecar_install,
            sidecar_updater::sidecar_update_status,
            fs_edit::fs_write_file,
            fs_edit::fs_read_file,
            fs_explorer::fs_list,
            fs_explorer::fs_tree,
            fs_explorer::fs_create_file,
            fs_explorer::fs_create_dir,
            fs_explorer::fs_rename,
            fs_explorer::fs_delete,
            fs_explorer::fs_exists,
            fs_explorer::fs_list_all,
            fs_explorer::read_file_bytes,
            fs_explorer::fs_write_bytes,
            git::git_repo_root,
            git::git_status_map,
            git::git_hunks,
            git::git_hunks_workdir,
            git::git_branch,
            git::git_branches,
            git::git_checkout,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_log,
            git::checkpoint_create,
            git::checkpoint_list,
            git::checkpoint_restore,
            git::checkpoint_diff,
            git::checkpoint_prune,
            git::checkpoint_file,
            git::checkpoint_hunks,
            git::checkpoint_restore_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            if let RunEvent::Exit = event {
                log_line("app: exit requested, stopping child server");
                stop_internal(&app_handle.state::<AppState>());
                release_instance_lock(&lock_path);
            }
        });
}
