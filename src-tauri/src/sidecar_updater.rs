// OpenCode sidecar updater.
// Checks GitHub releases (anomalyco/opencode), downloads the matching asset,
// verifies SHA-256, backs up and replaces the bundled sidecar binary with
// rollback on failure. Only touches OUR resolved sidecar path — never a
// blanket taskkill of every opencode process.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;

const RELEASES_API: &str = "https://api.github.com/repos/anomalyco/opencode/releases";
const USER_AGENT: &str = "NexusCode-Updater";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarRelease {
    pub version: String,
    pub download_url: String,
    pub checksum_url: Option<String>,
    pub size: u64,
    pub prerelease: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SidecarUpdateStatus {
    pub state: String, // idle | checking | available | downloading | verifying | installing | completed | uptodate | error
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub progress: f32,
    pub error: Option<String>,
}

pub struct SidecarUpdater {
    status: Mutex<SidecarUpdateStatus>,
}

impl SidecarUpdater {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(SidecarUpdateStatus {
                state: "idle".into(),
                current_version: None,
                latest_version: None,
                progress: 0.0,
                error: None,
            }),
        }
    }

    fn set(&self, s: SidecarUpdateStatus) {
        if let Ok(mut st) = self.status.lock() {
            *st = s;
        }
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    // No total timeout here: API calls set their own per-request timeout,
    // and the big binary download must not die on slow connections.
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Download one archive with live progress updates. No total timeout —
/// large binaries on slow links need it; failures surface as chunk errors.
async fn download_once(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    version: &str,
    total_hint: u64,
    state: &tauri::State<'_, SidecarUpdater>,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(total_hint);
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Create file failed: {e}"))?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Chunk error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        let progress = if total > 0 {
            (downloaded as f32 / total as f32) * 100.0
        } else {
            0.0
        };
        state.set(SidecarUpdateStatus {
            state: "downloading".into(),
            latest_version: Some(version.to_string()),
            current_version: None,
            progress,
            error: None,
        });
    }
    file.flush().await.ok();
    drop(file);
    Ok(())
}

#[tauri::command]
pub async fn sidecar_current_version(
    sidecar_path: String,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(&sidecar_path);
    cmd.arg("--version");
    no_window(&mut cmd);
    let out = cmd.output().await.map_err(|e| format!("run failed: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(extract_version(text.trim()))
}

#[tauri::command]
pub async fn sidecar_check(
    state: tauri::State<'_, SidecarUpdater>,
    include_prerelease: bool,
    current_version: Option<String>,
) -> Result<Option<SidecarRelease>, String> {
    state.set(SidecarUpdateStatus {
        state: "checking".into(),
        ..Default::default()
    });

    let client = http_client()?;
    let url = if include_prerelease {
        format!("{RELEASES_API}?per_page=10")
    } else {
        format!("{RELEASES_API}/latest")
    };

    // fetch with 3 retries and exponential backoff
    let mut last_err = String::new();
    let mut resp_opt: Option<reqwest::Response> = None;
    for attempt in 0..3 {
        match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
        {
            Ok(r) => {
                resp_opt = Some(r);
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(500 * (1 << attempt))).await;
                }
            }
        }
    }
    let resp = resp_opt.ok_or_else(|| {
        crate::log_line(&format!("sidecar_check network failed after retries: {last_err}"));
        "Не удалось проверить обновления. Проверьте подключение к интернету.".to_string()
    })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        crate::log_line(&format!("sidecar_check GitHub API status {status}"));
        if status == 403 || status == 429 {
            return Err("GitHub API временно недоступен (лимит запросов). Повторите позже.".into());
        }
        return Err(format!("GitHub API вернул ошибку {status}. Повторите позже."));
    }

    #[derive(Deserialize)]
    struct GhAsset {
        name: String,
        size: u64,
        browser_download_url: String,
    }
    #[derive(Deserialize)]
    struct GhRelease {
        tag_name: String,
        prerelease: bool,
        assets: Vec<GhAsset>,
    }

    // /latest returns single object, /releases returns array — handle both
    let releases: Vec<GhRelease> = if include_prerelease {
        resp.json().await.map_err(|e| {
            crate::log_line(&format!("sidecar_check parse array failed: {e}"));
            "GitHub вернул неожиданный ответ. Повторите позже.".to_string()
        })?
    } else {
        let single: GhRelease = resp.json().await.map_err(|e| {
            crate::log_line(&format!("sidecar_check parse single failed: {e}"));
            "GitHub вернул неожиданный ответ. Повторите позже.".to_string()
        })?;
        vec![single]
    };

    let want_windows = cfg!(target_os = "windows");
    let want_macos = cfg!(target_os = "macos");
    let arch_re: &str = if cfg!(target_arch = "aarch64") {
        "(arm64|aarch64)"
    } else {
        "(x64|amd64|x86_64)"
    };
    let arch_regex = regex::Regex::new(arch_re).unwrap();

    let release = releases
        .into_iter()
        .filter(|r| include_prerelease || !r.prerelease)
        .find(|r| {
            r.assets.iter().any(|a| {
                let n = a.name.to_lowercase();
                let os_match = if want_windows {
                    n.contains("windows")
                } else if want_macos {
                    n.contains("darwin") || n.contains("macos") || n.contains("mac")
                } else {
                    n.contains("linux")
                };
                os_match && arch_regex.is_match(&n) && (n.ends_with(".zip") || n.ends_with(".tar.gz"))
            })
        })
        .ok_or_else(|| "No matching release asset for this platform".to_string())?;

    let version = release.tag_name.trim_start_matches('v').to_string();
    let archive_asset = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            let os_match = if want_windows {
                n.contains("windows")
            } else if want_macos {
                n.contains("darwin") || n.contains("macos") || n.contains("mac")
            } else {
                n.contains("linux")
            };
            os_match && arch_regex.is_match(&n)
        })
        .ok_or_else(|| "No matching asset".to_string())?;

    // Some releases ship a separate checksums file
    let checksum_url = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            (n.ends_with("sha256") || n.ends_with("sha256.txt") || n.contains("checksum"))
                && !n.ends_with(".sig")
        })
        .map(|a| a.browser_download_url.clone());

    let info = SidecarRelease {
        version,
        download_url: archive_asset.browser_download_url.clone(),
        checksum_url,
        size: archive_asset.size,
        prerelease: release.prerelease,
    };

    // The frontend passes the version it read from the actual binary file.
    // (The old process-cached lookup always returned None → perpetual
    // "update available".)
    let cur = match current_version {
        Some(v) if !v.trim().is_empty() => Some(v),
        _ => current_sidecar_version_cached(),
    };
    let up_to_date = cur
        .as_deref()
        .map(|c| !is_newer(c, &info.version))
        .unwrap_or(false);

    state.set(SidecarUpdateStatus {
        state: if up_to_date { "uptodate" } else { "available" }.into(),
        latest_version: Some(info.version.clone()),
        current_version: cur,
        progress: 0.0,
        error: None,
    });

    Ok(if up_to_date { None } else { Some(info) })
}

#[tauri::command]
pub async fn sidecar_install(
    state: tauri::State<'_, SidecarUpdater>,
    release: SidecarRelease,
) -> Result<(), String> {
    // Resolve our own sidecar path via the shared resolver logic.
    let sidecar_path = crate::resolve_binary(None)?;

    state.set(SidecarUpdateStatus {
        state: "downloading".into(),
        latest_version: Some(release.version.clone()),
        current_version: None,
        progress: 0.0,
        error: None,
    });

    let client = http_client()?;
    let temp_dir = std::env::temp_dir().join("nexuscode-sidecar-update");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Temp dir failed: {e}"))?;
    let archive_path = temp_dir.join(format!(
        "opencode-update-{}.archive",
        std::process::id()
    ));

    // ---- Download with progress (2 attempts; stale partial file removed) ----
    let mut last_err = String::new();
    let mut downloaded_ok = false;
    for attempt in 0..2 {
        match download_once(
            &client,
            &release.download_url,
            &archive_path,
            &release.version,
            release.size,
            &state,
        )
        .await
        {
            Ok(()) => {
                downloaded_ok = true;
                break;
            }
            Err(e) => {
                last_err = e;
                let _ = tokio::fs::remove_file(&archive_path).await;
                if attempt == 0 {
                    log(&format!("download attempt 1 failed, retrying: {last_err}"));
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                }
            }
        }
    }
    if !downloaded_ok {
        let msg = format!("Download failed: {last_err}");
        state.set(SidecarUpdateStatus {
            state: "error".into(),
            latest_version: Some(release.version.clone()),
            current_version: None,
            progress: 0.0,
            error: Some(msg.clone()),
        });
        return Err(msg);
    }

    // ---- Verify checksum if provided ----
    if let Some(checksum_url) = &release.checksum_url {
        state.set(SidecarUpdateStatus {
            state: "verifying".into(),
            latest_version: Some(release.version.clone()),
            current_version: None,
            progress: 100.0,
            error: None,
        });

        let text = client
            .get(checksum_url)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("Checksum download failed: {e}"))?
            .text()
            .await
            .map_err(|e| format!("Checksum read failed: {e}"))?;

        let actual = file_sha256(&archive_path).await?;
        let expected_line = text
            .lines()
            .find(|l| l.to_lowercase().contains("opencode"))
            .unwrap_or_else(|| text.trim());
        let expected = expected_line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase();

        if expected.len() == 64 && expected != actual {
            let _ = tokio::fs::remove_file(&archive_path).await;
            let msg = format!("Checksum mismatch! Expected {expected}, got {actual}");
            state.set(SidecarUpdateStatus {
                state: "error".into(),
                error: Some(msg.clone()),
                ..Default::default()
            });
            return Err(msg);
        }
        if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
            // Fail closed: a checksum file we can't parse is not a green light.
            let _ = tokio::fs::remove_file(&archive_path).await;
            let msg = format!(
                "Checksum file from {checksum_url} has no usable sha256 entry; refusing to install"
            );
            state.set(SidecarUpdateStatus {
                state: "error".into(),
                error: Some(msg.clone()),
                ..Default::default()
            });
            return Err(msg);
        }
    }

    // ---- Extract binary from archive ----
    state.set(SidecarUpdateStatus {
        state: "installing".into(),
        latest_version: Some(release.version.clone()),
        current_version: None,
        progress: 100.0,
        error: None,
    });

    let new_bin = extract_opencode(&archive_path, &temp_dir).await?;

    // ---- Backup + replace (graceful, PID-scoped) ----
    install_binary(&sidecar_path, &new_bin).await?;

    // ---- Verify ----
    let mut cmd = tokio::process::Command::new(&sidecar_path);
    cmd.arg("--version");
    no_window(&mut cmd);
    let verify_ok = matches!(cmd.output().await, Ok(o) if o.status.success());

    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    if verify_ok {
        // New binary healthy — the rollback backup (~180MB) is junk now.
        let backup = backup_path(std::path::Path::new(&sidecar_path));
        let _ = tokio::fs::remove_file(&backup).await;
        state.set(SidecarUpdateStatus {
            state: "completed".into(),
            latest_version: Some(release.version.clone()),
            current_version: Some(release.version),
            progress: 100.0,
            error: None,
        });
        Ok(())
    } else {
        // Rollback
        let backup = backup_path(std::path::Path::new(&sidecar_path));
        if backup.exists() {
            let _ = tokio::fs::copy(&backup, &sidecar_path).await;
            let _ = tokio::fs::remove_file(&backup).await;
        }
        let msg = "Installation verification failed. Rolled back.".to_string();
        state.set(SidecarUpdateStatus {
            state: "error".into(),
            error: Some(msg.clone()),
            ..Default::default()
        });
        Err(msg)
    }
}

#[tauri::command]
pub async fn sidecar_update_status(
    state: tauri::State<'_, SidecarUpdater>,
) -> Result<SidecarUpdateStatus, String> {
    Ok(state.status.lock().map_err(|e| e.to_string())?.clone())
}

// ---------------------------------------------------------------------------

fn current_sidecar_version_cached() -> Option<String> {
    // Not cached yet — resolve synchronously on first use is avoided here;
    // version detection is async (sidecar_current_version), so cache starts empty.
    None
}

fn backup_path(sidecar: &std::path::Path) -> PathBuf {
    let mut name = sidecar
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.push_str(".backup");
    sidecar.with_file_name(name)
}

/// Terminate stray processes whose image path equals our sidecar file
/// (orphaned servers from GUI sessions killed without cleanup).
/// Strictly path-scoped: processes running any other binary are untouched.
/// Returns how many were terminated.
#[cfg(windows)]
fn kill_strays_using(sidecar: &std::path::Path) -> usize {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::*;

    fn norm(p: &str) -> String {
        p.replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase()
    }
    let want = norm(&sidecar.to_string_lossy());
    let mut killed = 0usize;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return 0;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let self_pid = std::process::id();
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != FALSE {
            let pid = entry.th32ProcessID;
            if pid != 0 && pid != self_pid {
                let h = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                    0,
                    pid,
                );
                if !h.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0 {
                        let img = String::from_utf16_lossy(&buf[..len as usize]);
                        if norm(&img) == want {
                            if TerminateProcess(h, 1) != 0 {
                                killed += 1;
                                log(&format!(
                                    "terminated stray sidecar pid {pid} holding {}",
                                    sidecar.display()
                                ));
                            }
                        }
                    }
                    CloseHandle(h);
                }
            }
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    killed
}

#[cfg(not(windows))]
fn kill_strays_using(_sidecar: &std::path::Path) -> usize {
    0
}

/// Wait until the sidecar file can be opened for writing (lock released by
/// dying processes), polling briefly. Returns true when writable.
async fn wait_file_writable(sidecar: &std::path::Path, wait_ms: u64) -> bool {
    let step = 250u64;
    let mut waited = 0u64;
    loop {
        match tokio::fs::OpenOptions::new().write(true).open(sidecar).await {
            Ok(_) => return true,
            Err(e)
                if e.kind() == std::io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(32) =>
            {
                if waited >= wait_ms {
                    return false;
                }
                tokio::time::sleep(std::time::Duration::from_millis(step)).await;
                waited += step;
            }
            Err(_) => return true, // missing file etc. — replace path handles it
        }
    }
}

async fn install_binary(sidecar: &str, new_bin: &std::path::Path) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let sidecar_path = PathBuf::from(sidecar);
    let parent = sidecar_path
        .parent()
        .ok_or("Sidecar has no parent dir")?
        .to_path_buf();

    // Backup current
    if sidecar_path.exists() {
        let backup = backup_path(&sidecar_path);
        let data = tokio::fs::read(&sidecar_path)
            .await
            .map_err(|e| format!("Backup read failed: {e}"))?;
        let mut f = tokio::fs::File::create(&backup)
            .await
            .map_err(|e| format!("Backup write failed: {e}"))?;
        f.write_all(&data)
            .await
            .map_err(|e| format!("Backup write failed: {e}"))?;
    }

    // Read new binary, then overwrite in place (works even if the old file
    // was memory-mapped by a dead process; retry briefly if locked).
    let payload = tokio::fs::read(new_bin)
        .await
        .map_err(|e| format!("Read new binary failed: {e}"))?;

    // The file may be locked by orphaned servers from earlier sessions —
    // terminate only processes running THIS exact binary, then wait for
    // the OS to release the handle before overwriting.
    if sidecar_path.exists() {
        let n = kill_strays_using(&sidecar_path);
        if n > 0 {
            log(&format!("terminated {n} stray holder(s), waiting for unlock"));
        }
        if !wait_file_writable(&sidecar_path, 10_000).await {
            return Err(
                "Файл занят другим процессом даже после ожидания. \
                 Закройте другие окна NexusCode и повторите обновление."
                    .to_string(),
            );
        }
    }

    let mut attempts = 0;
    loop {
        match tokio::fs::File::create(&sidecar_path).await {
            Ok(mut f) => {
                use tokio::io::AsyncWriteExt;
                f.write_all(&payload)
                    .await
                    .map_err(|e| format!("Replace write failed: {e}"))?;
                f.flush().await.ok();
                break;
            }
            Err(e)
                if (e.kind() == std::io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(32))
                    && attempts < 12 =>
            {
                attempts += 1;
                log(&format!("binary locked, retry {attempts}"));
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
            Err(e) => {
                return Err(format!(
                    "Replace failed: {e}. Если файл занят — закройте другие окна NexusCode и повторите."
                ))
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&sidecar_path, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| e.to_string())?;
    }

    let _ = parent; // keep parent binding used on all platforms
    Ok(())
}

async fn extract_opencode(archive: &std::path::Path, dest_root: &std::path::Path) -> Result<PathBuf, String> {
    let dest = dest_root.join(format!("extract-{}", std::process::id()));
    tokio::fs::create_dir_all(&dest)
        .await
        .map_err(|e| format!("Extract dir failed: {e}"))?;

    let name = archive
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let status = if name.ends_with(".zip") {
        #[cfg(windows)]
        {
            let mut cmd = tokio::process::Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    dest.display()
                ),
            ]);
            no_window(&mut cmd);
            cmd.status().await
        }
        #[cfg(not(windows))]
        {
            let mut cmd = tokio::process::Command::new("unzip");
            cmd.args(["-o"]).arg(archive).arg(&dest);
            no_window(&mut cmd);
            cmd.status().await
        }
    } else {
        let mut cmd = tokio::process::Command::new("tar");
        cmd.args(["-xzf"]).arg(archive).arg("-C").arg(&dest);
        no_window(&mut cmd);
        cmd.status().await
    };

    match status {
        Ok(s) if s.success() => {}
        Ok(s) => return Err(format!("Archive extraction failed: {s}")),
        Err(e) => return Err(format!("Archive tool not found: {e}")),
    }

    find_opencode_in(&dest).await
}

async fn find_opencode_in(dir: &std::path::Path) -> Result<PathBuf, String> {
    let wanted = format!("opencode{}", std::env::consts::EXE_SUFFIX);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&d).await.map_err(|e| e.to_string())?;
        while let Ok(Some(e)) = entries.next_entry().await {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .map(|n| n.eq_ignore_ascii_case(&wanted))
                .unwrap_or(false)
            {
                return Ok(p);
            }
        }
    }
    Err("opencode binary not found inside archive".into())
}

async fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_version(text: &str) -> String {
    let t = text.trim_start_matches('v');
    t.split_whitespace()
        .find(|w| w.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
        .unwrap_or(t)
        .trim_start_matches('v')
        .to_string()
}

fn is_newer(current: &str, remote: &str) -> bool {
    match (
        semver::Version::parse(current.trim_start_matches('v')),
        semver::Version::parse(remote.trim_start_matches('v')),
    ) {
        (Ok(c), Ok(r)) => r > c,
        _ => remote != current,
    }
}

fn log(msg: &str) {
    crate::log_line(&format!("sidecar-updater: {msg}"));
}

#[cfg(windows)]
fn no_window(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut tokio::process::Command) {}

impl Default for SidecarUpdater {
    fn default() -> Self {
        Self::new()
    }
}
