//! System Python discovery.
//!
//! Order: `py` launcher → real `python` on PATH → well-known install dirs.
//! The Microsoft Store stub (`WindowsApps\python.exe`, 0 bytes) is skipped
//! explicitly: spawning it would pop the Store window instead of Python.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct PythonInfo {
    /// Binary to run (absolute path, or `py` launcher name).
    pub bin: String,
    /// Extra args before the subcommand (e.g. `["-3"]` for the launcher).
    pub args: Vec<String>,
    /// Whether `python -m pip` works.
    pub has_pip: bool,
}

#[cfg(windows)]
fn no_window(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut tokio::process::Command) {}

fn silent(cmd: &mut tokio::process::Command) {
    use std::process::Stdio;
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
    no_window(cmd);
}

async fn probe(bin: &str, extra: &[&str]) -> Option<PythonInfo> {
    let mut cmd = tokio::process::Command::new(bin);
    for a in extra {
        cmd.arg(a);
    }
    cmd.arg("--version");
    silent(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }

    let mut pip = tokio::process::Command::new(bin);
    for a in extra {
        pip.arg(a);
    }
    pip.args(["-m", "pip", "--version"]);
    silent(&mut pip);
    let has_pip = matches!(
        tokio::time::timeout(Duration::from_secs(10), pip.output()).await,
        Ok(Ok(o)) if o.status.success()
    );

    Some(PythonInfo {
        bin: bin.to_string(),
        args: extra.iter().map(|s| s.to_string()).collect(),
        has_pip,
    })
}

/// Real `python` on PATH, skipping the Store stub.
pub(crate) fn path_python() -> Option<String> {
    let exe = if cfg!(windows) { "python.exe" } else { "python3" };
    let path_var = std::env::var_os("PATH")?;
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    for dir in std::env::split_paths(&path_var) {
        let p = dir.join(exe);
        let s = p.to_string_lossy().to_lowercase();
        if s.contains("windowsapps") {
            continue; // Store stub, not Python
        }
        if p.is_file() {
            cands.push(p);
        }
    }
    cands.into_iter().next().map(|p| p.to_string_lossy().into_owned())
}

fn well_known() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        let mut roots: Vec<String> = Vec::new();
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            roots.push(format!(
                "{}/Programs/Python/Python3*/python.exe",
                local.to_string_lossy().replace('\\', "/")
            ));
        }
        roots.push("C:/Python3*/python.exe".into());
        roots.push("C:/Program Files/Python3*/python.exe".into());
        roots.push("C:/Program Files (x86)/Python3*/python.exe".into());
        let mut hits: Vec<String> = Vec::new();
        for pat in roots {
            if let Ok(paths) = glob::glob(&pat) {
                for p in paths.flatten() {
                    // glob already guarantees existence
                    hits.push(p.to_string_lossy().into_owned());
                }
            }
        }
        // Newest first: Python312 > Python311 > ...
        hits.sort();
        hits.reverse();
        out.extend(hits);
    }
    #[cfg(not(windows))]
    {
        for exe in ["python3", "python"] {
            if let Ok(path_var) = std::env::var("PATH") {
                for dir in std::env::split_paths(&path_var) {
                    let p = dir.join(exe);
                    if p.is_file() {
                        out.push(p.to_string_lossy().into_owned());
                        break;
                    }
                }
            }
            if !out.is_empty() {
                break;
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct BundledPythonStatus {
    /// Embeddable build ships with the app (resources or dev tree).
    pub available: bool,
    /// Unpacked into app data and pip-ready.
    pub installed: bool,
    pub bin: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    }
}

/// Source tree shipped with the app: installed resources, then dev fallback.
fn bundle_source_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let d = res.join("python");
        if d.join(exe_name()).is_file() {
            return Some(d);
        }
    }
    // `cargo dev` / debug exe: src-tauri/binaries/python
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("python");
    if dev.join(exe_name()).is_file() {
        return Some(dev);
    }
    None
}

fn appdata_python_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("python"))
}

/// Installed bundled interpreter binary (appdata copy), if present.
pub(crate) fn installed_bin(app: &AppHandle) -> Option<PathBuf> {
    let bin = appdata_python_dir(app)?.join(exe_name());
    bin.is_file().then_some(bin)
}

/// Offline bootstrap payloads shipped with the app (get-pip.py, *.whl).
/// Same lookup order as the interpreter itself: resources, then dev tree.
fn bundled_payload(name: &str, app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("python-wheels").join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("python-wheels")
        .join(name);
    if dev.is_file() {
        return Some(dev);
    }
    None
}

fn bundled_wheel(app: &AppHandle) -> Option<PathBuf> {
    // Prefer an exact local wheel; fall back to any debugpy wheel present.
    let dir_candidates = (|| {
        let mut v = Vec::new();
        if let Ok(res) = app.path().resource_dir() {
            v.push(res.join("python-wheels"));
        }
        v.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join("python-wheels"),
        );
        v
    })();
    for dir in dir_candidates {
        let entries = std::fs::read_dir(&dir).ok()?;
        let mut wheels: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().map(|e| e == "whl").unwrap_or(false)
                    && p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("debugpy"))
                        .unwrap_or(false)
            })
            .collect();
        wheels.sort();
        if let Some(w) = wheels.into_iter().next() {
            return Some(w);
        }
    }
    None
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else if ft.is_file() {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

/// Embeddable builds ship `python3XX._pth` with `import site` commented out,
/// which breaks pip. Uncomment it. Returns true when patched.
fn patch_pth(dir: &Path) -> bool {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("python") || !name.ends_with("._pth") {
            continue;
        }
        let p = entry.path();
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        if text.lines().any(|l| l.trim() == "import site") {
            return false; // already enabled
        }
        let patched = text.replace("#import site", "import site");
        if patched != text {
            return std::fs::write(&p, patched).is_ok();
        }
    }
    false
}

async fn run_quiet(
    bin: &str,
    args: &[&str],
    workdir: &Path,
    timeout_secs: u64,
) -> Result<(bool, String), String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args).current_dir(workdir);
    silent(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| "timed out".to_string())
        .map_err(|e| e.to_string())?;
    let out = out.map_err(|e| e.to_string())?;
    let txt: String = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .chars()
    .take(1500)
    .collect();
    Ok((out.status.success(), txt))
}

#[tauri::command]
pub async fn python_bundled_status(
    app: AppHandle,
) -> Result<BundledPythonStatus, String> {
    let installed_bin = appdata_python_dir(&app)
        .map(|d| d.join(exe_name()))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned());
    Ok(BundledPythonStatus {
        available: bundle_source_dir(&app).is_some(),
        installed: installed_bin.is_some(),
        bin: installed_bin,
    })
}

/// First-run setup: unpack the embeddable build into app data, enable
/// `import site`, bootstrap pip via get-pip.py. Returns the python binary.
#[tauri::command]
pub async fn setup_bundled_python(app: AppHandle) -> Result<String, String> {
    let src = bundle_source_dir(&app)
        .ok_or_else(|| "встроенный Python не входит в сборку".to_string())?;
    let dst = appdata_python_dir(&app).ok_or_else(|| "нет доступа к app data".to_string())?;
    let bin = dst.join(exe_name());
    let bin_s = bin.to_string_lossy().into_owned();

    if !bin.is_file() {
        copy_dir(&src, &dst).map_err(|e| format!("copy failed: {e}"))?;
        let _ = patch_pth(&dst);
    }
    if !bin.is_file() {
        return Err("распаковка не удалась: нет python.exe".to_string());
    }

    // pip bootstrap (embeddable builds ship without pip).
    // Prefer the get-pip.py bundled with the installer; download fallback.
    let has_pip = run_quiet(&bin_s, &["-m", "pip", "--version"], &dst, 20)
        .await
        .map(|(ok, _)| ok)
        .unwrap_or(false);
    if !has_pip {
        let getpip = dst.join("get-pip.py");
        if !getpip.is_file() {
            if let Some(bundled) = bundled_payload("get-pip.py", &app) {
                let _ = std::fs::copy(&bundled, &getpip);
            }
        }
        if !getpip.is_file() {
            let client = reqwest::Client::builder()
                .user_agent("NexusCode-Python")
                .connect_timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let bytes = client
                .get("https://bootstrap.pypa.io/get-pip.py")
                .timeout(Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| format!("get-pip download failed: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("get-pip read failed: {e}"))?;
            std::fs::write(&getpip, &bytes).map_err(|e| e.to_string())?;
        }
        let (ok, log) = run_quiet(&bin_s, &["get-pip.py", "--no-warn-script-location"], &dst, 180).await?;
        if !ok {
            return Err(format!("get-pip failed: {log}"));
        }
        let _ = std::fs::remove_file(&getpip);
    }

    let (ok, _) = run_quiet(&bin_s, &["-m", "pip", "--version"], &dst, 20).await?;
    if !ok {
        return Err("pip не завёлся после установки".to_string());
    }

    // Pre-install the debugger from the bundled wheel (offline-capable),
    // so Run → debugging works out of the box.
    let dbg_ok = run_quiet(&bin_s, &["-m", "debugpy", "--version"], &dst, 20)
        .await
        .map(|(ok, _)| ok)
        .unwrap_or(false);
    if !dbg_ok {
        if let Some(wheel) = bundled_wheel(&app) {
            let wheel_s = wheel.to_string_lossy().into_owned();
            let (ok, log) = run_quiet(
                &bin_s,
                &["-m", "pip", "install", "--no-index", "--no-warn-script-location", &wheel_s],
                &dst,
                120,
            )
            .await?;
            if !ok {
                crate::log_line(&format!("bundled debugpy install failed: {log}"));
            }
        }
    }
    Ok(bin_s)
}

#[tauri::command]
pub async fn detect_python() -> Result<Option<PythonInfo>, String> {
    // 1) py launcher (Windows)
    #[cfg(windows)]
    if let Some(info) = probe("py", &["-3"]).await {
        return Ok(Some(info));
    }
    // 2) real python on PATH
    if let Some(bin) = path_python() {
        if let Some(info) = probe(&bin, &[]).await {
            return Ok(Some(info));
        }
    }
    // 3) well-known install locations
    for bin in well_known() {
        if let Some(info) = probe(&bin, &[]).await {
            return Ok(Some(info));
        }
    }
    Ok(None)
}
