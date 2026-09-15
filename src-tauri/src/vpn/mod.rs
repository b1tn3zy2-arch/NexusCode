//! App-level VPN: sing-box sidecar exposing a local mixed proxy
//! (127.0.0.1) used ONLY for the app's own LLM traffic.
//!
//! Kill-switch behavior is fail-closed by construction: when the proxy is
//! down, clients get connection-refused instead of a silent direct route.

pub mod links;
pub mod singbox;

use links::ParsedServer;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct VpnStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub server_name: Option<String>,
    pub pid: Option<u32>,
}

pub struct VpnManager {
    child: Option<tokio::process::Child>,
    port: Option<u16>,
    server_name: Option<String>,
    config_path: Option<PathBuf>,
}

impl VpnManager {
    pub fn new() -> Self {
        Self {
            child: None,
            port: None,
            server_name: None,
            config_path: None,
        }
    }

    pub fn status(&mut self) -> VpnStatus {
        let alive = self
            .child
            .as_mut()
            .map(|c| matches!(c.try_wait(), Ok(None)))
            .unwrap_or(false);
        if !alive {
            self.child = None;
        }
        VpnStatus {
            running: alive,
            port: if alive { self.port } else { None },
            server_name: if alive { self.server_name.clone() } else { None },
            pid: self
                .child
                .as_ref()
                .and_then(|c| c.id()),
        }
    }

    /// Synchronous kill for exit paths (stop_internal).
    pub fn kill_blocking(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.try_wait();
        }
        self.port = None;
        self.server_name = None;
        if let Some(p) = self.config_path.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Resolve the sing-box binary: prod sidecar next to the exe, dev copy in
/// src-tauri/binaries, then PATH.
pub fn resolve_singbox() -> Result<String, String> {
    let triples: Vec<String> = {
        let mut v = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let pat = if cfg!(windows) { "sing-box-" } else { "sing-box-" };
                if let Ok(rd) = std::fs::read_dir(dir) {
                    for e in rd.flatten() {
                        let n = e.file_name().to_string_lossy().into_owned();
                        if n.starts_with(pat)
                            && (cfg!(windows) && n.ends_with(".exe") || !cfg!(windows) && !n.contains('.'))
                        {
                            v.push(e.path().to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
        v
    };
    if let Some(p) = triples.into_iter().next() {
        return Ok(p);
    }
    // Dev layout: src-tauri/binaries/sing-box-<triple>[.exe]
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Ok(rd) = std::fs::read_dir(manifest.join("binaries")) {
        let mut cands: Vec<String> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("sing-box-"))
                    .unwrap_or(false)
            })
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        // Prefer MSVC builds on Windows: fully self-contained, no MinGW
        // runtime quirks (a gnu build once died with 0xC0000142 when
        // spawned from the GUI app while working fine from a console).
        cands.sort_by_key(|p| (!cfg!(windows) || !p.contains("msvc")) as u8);
        if let Some(p) = cands.into_iter().next() {
            return Ok(p);
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        let exe = if cfg!(windows) { "sing-box.exe" } else { "sing-box" };
        for dir in std::env::split_paths(&path_var) {
            let c = dir.join(exe);
            if c.is_file() {
                return Ok(c.to_string_lossy().into_owned());
            }
        }
    }
    Err("sing-box binary not found (run scripts/download-singbox.mjs)".into())
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("HOME").map(|h| {
            let mut p = PathBuf::from(h);
            p.push(".local/share");
            p.into_os_string()
        }))
        .ok_or("no home directory")?;
    let mut dir = PathBuf::from(base);
    if cfg!(windows) {
        dir.push("nexuscode");
    } else {
        dir.push("nexuscode");
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("app data dir: {e}"))?;
    Ok(dir)
}

fn write_secret_file(path: &PathBuf, content: &str) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(path).map_err(|e| format!("vpn config write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    // NOTE: Windows has no chmod 600; the file lives in the user's own
    // AppData dir and is deleted on stop. ACL hardening is a v2 item.
    f.write_all(content.as_bytes())
        .map_err(|e| format!("vpn config write: {e}"))?;
    Ok(())
}

async fn wait_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    false
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

/// Start sing-box for one server outbound. Returns the local mixed port.
pub async fn start(
    mgr: &Mutex<VpnManager>,
    outbound: serde_json::Value,
    server_name: String,
) -> Result<u16, String> {
    {
        let mut m = mgr.lock().unwrap();
        m.kill_blocking();
    }
    let bin = resolve_singbox()?;
    crate::integrity::verify_sidecar(&bin)?;
    // Preflight: fail fast on bad JSON instead of a silent dead proxy.
    {
        let cfg = singbox::build_config(
            outbound.as_object().cloned().ok_or("bad outbound")?,
            1,
        );
        let probe = app_data_dir()?.join("nexuscode-vpn-check.json");
        write_secret_file(&probe, &serde_json::to_string_pretty(&cfg).unwrap())?;
        let out = tokio::process::Command::new(&bin)
            .args(["check", "-c"])
            .arg(&probe)
            .output()
            .await
            .map_err(|e| format!("sing-box check failed to run: {e}"))?;
        let _ = std::fs::remove_file(&probe);
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let detail = [stderr, stdout]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" | ");
            crate::log_line(&format!(
                "vpn preflight: {bin} check -c failed, exit {:?}: {}",
                out.status.code(),
                if detail.is_empty() { "(no output)" } else { &detail },
            ));
            return Err(format!(
                "sing-box config rejected (exit {:?}): {}",
                out.status.code(),
                if detail.is_empty() {
                    "no output — see opencode-gui.log".to_string()
                } else {
                    detail.chars().take(600).collect::<String>()
                },
            ));
        }
    }
    let port = free_port()?;
    let cfg = singbox::build_config(
        outbound.as_object().cloned().ok_or("bad outbound")?,
        port,
    );
    let cfg_path = app_data_dir()?.join("nexuscode-vpn.json");
    write_secret_file(&cfg_path, &serde_json::to_string_pretty(&cfg).unwrap())?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["run", "-c"]).arg(&cfg_path);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| format!("sing-box spawn: {e}"))?;
    if !wait_port(port, Duration::from_secs(10)).await {
        let mut m = mgr.lock().unwrap();
        m.kill_blocking();
        let _ = std::fs::remove_file(&cfg_path);
        return Err("sing-box did not open its local port in 10s".into());
    }
    // Egress preflight: an open local port proves NOTHING about the VPN
    // server. Without this, a dead outbound = "model thinks forever".
    // Fetch a tiny URL through the fresh proxy with a short timeout.
    match egress_ip_through(port).await {
        Ok(ip) => {
            eprintln!("[vpn] egress ok via {server_name}: {ip}");
        }
        Err(e) => {
            let mut child = child;
            let _ = child.start_kill();
            let _ = child.try_wait();
            let _ = std::fs::remove_file(&cfg_path);
            return Err(format!(
                "VPN-сервер недоступен через прокси ({server_name}): {e}. Проверьте подписку/ключ, время на часах и блокировки UDP."
            ));
        }
    }
    let mut m = mgr.lock().unwrap();
    m.child = Some(child);
    m.port = Some(port);
    m.server_name = Some(server_name);
    m.config_path = Some(cfg_path);
    Ok(port)
}

/// Public IP as seen through the local proxy. Used by preflight and by
/// the "Проверить IP" button. Short timeout on purpose: fail fast, loudly.
async fn egress_ip_through(port: u16) -> Result<String, String> {
    let proxy = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .proxy(reqwest::Proxy::all(&proxy).map_err(|e| format!("bad proxy url: {e}"))?)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.ipify.org?format=json")
        .send()
        .await
        .map_err(|e| {
            let s = e.to_string();
            // Translate the most common transport failures to human Russian.
            if s.contains("connection refused") || s.contains("Connection refused") {
                "локальный прокси не отвечает".to_string()
            } else if s.contains("timed out") || s.contains("timeout") || s.contains("deadline") {
                "таймаут: сервер не отвечает (проверьте UDP/фаервол/ключ)".to_string()
            } else if s.contains("tls") || s.contains("TLS") || s.contains("certificate") {
                format!("TLS-ошибка к VPN-серверу: {s}")
            } else if s.contains("proxy") || s.contains("Proxy") || s.contains("502") || s.contains("403") {
                format!("прокси отклонил запрос: {s}")
            } else {
                s
            }
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("ipify вернул HTTP {status}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("ipify ответ: {e}"))?;
    v.get("ip")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "ipify: нет поля ip".to_string())
}

pub fn stop(mgr: &Mutex<VpnManager>) {
    mgr.lock().unwrap().kill_blocking();
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub servers: Vec<ParsedServer>,
    pub failed: usize,
}

#[tauri::command]
pub fn vpn_parse_link(link: String) -> Result<ParsedServer, String> {
    links::parse_link(&link)
}

#[tauri::command]
pub async fn vpn_import_subscription(url: String) -> Result<ImportResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get(url.trim())
        .header("User-Agent", "nexuscode/1.0")
        .send()
        .await
        .map_err(|e| format!("subscription fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("subscription HTTP error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("subscription read failed: {e}"))?;
    let (servers, failed) = links::parse_subscription(&body);
    if servers.is_empty() {
        return Err(format!(
            "no servers parsed ({} bad line{}). Paste links manually?",
            failed,
            if failed == 1 { "" } else { "s" }
        ));
    }
    Ok(ImportResult { servers, failed })
}

#[tauri::command]
pub async fn vpn_start(
    state: tauri::State<'_, crate::AppState>,
    outbound: serde_json::Value,
    server_name: String,
) -> Result<u16, String> {
    start(&state.vpn, outbound, server_name).await
}

#[tauri::command]
pub fn vpn_stop(state: tauri::State<'_, crate::AppState>) {
    stop(&state.vpn);
}

#[tauri::command]
pub fn vpn_status(state: tauri::State<'_, crate::AppState>) -> VpnStatus {
    state.vpn.lock().unwrap().status()
}

/// LLM provider domains covered by the VPN kill-switch.
const LLM_DOMAINS: &[&str] = &[
    "openrouter.ai",
    "api.openai.com",
    "api.anthropic.com",
    "api.groq.com",
    "api.mistral.ai",
    "api.deepseek.com",
    "api.x.ai",
    "generativelanguage.googleapis.com",
    "api.cohere.com",
    "api.together.xyz",
    "api.fireworks.ai",
    "api.perplexity.ai",
    "api.nvidia.com",
    "api.ollama.com",
    "openai.com",
    "anthropic.com",
];

fn is_llm_url(url: &str) -> bool {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()));
    match host {
        None => false,
        Some(h) => LLM_DOMAINS
            .iter()
            .any(|d| h == *d || h.ends_with(&format!(".{d}"))),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NetFetchResult {
    pub status: u16,
    pub body: String,
}

/// Fetch restricted to LLM provider domains, honoring the VPN state.
///
/// Kill-switch: while the VPN is on, requests go ONLY through the local
/// proxy — a dead proxy is a hard error, never a silent direct fallback.
/// When the VPN is off, requests go direct. Anything outside the LLM
/// domain list is rejected (use plugin-http / direct clients for that).
#[tauri::command]
pub async fn net_fetch(
    state: tauri::State<'_, crate::AppState>,
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<NetFetchResult, String> {
    if !is_llm_url(&url) {
        return Err("net_fetch is restricted to LLM provider domains".into());
    }
    let st = state.vpn.lock().unwrap().status();
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(60));
    if st.running {
        let port = st.port.ok_or("VPN is on but the local proxy is down — refusing direct request")?;
        let proxy = format!("http://127.0.0.1:{port}");
        builder = builder.proxy(
            reqwest::Proxy::all(&proxy).map_err(|e| format!("bad proxy url: {e}"))?,
        );
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let m = method.unwrap_or_else(|| "GET".into()).to_uppercase();
    let mut req = match m.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| {
        if st.running {
            format!("VPN proxy request failed (no direct fallback): {e}")
        } else {
            format!("request failed: {e}")
        }
    })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok(NetFetchResult { status, body: text })
}

/// Egress IP seen through the active VPN proxy (or direct when VPN is off).
/// Lets the user compare "my IP" vs "VPN IP" in one click.
#[tauri::command]
pub async fn vpn_egress_ip(
    state: tauri::State<'_, crate::AppState>,
) -> Result<String, String> {
    let port = state.vpn.lock().unwrap().status().port;
    match port {
        Some(p) => egress_ip_through(p).await,
        None => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .get("https://api.ipify.org?format=json")
                .send()
                .await
                .map_err(|e| format!("прямой запрос: {e}"))?;
            let v: serde_json::Value =
                resp.json().await.map_err(|e| format!("ipify ответ: {e}"))?;
            v.get("ip")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "ipify: нет поля ip".to_string())
        }
    }
}

/// TCP-handshake latency to a server (no ICMP/admin rights needed).
#[tauri::command]
pub async fn vpn_ping(host: String, port: u16) -> Result<u64, String> {
    let addr = format!("{host}:{port}");
    let t0 = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("ping timeout: {addr}"))?
        .map_err(|e| format!("ping failed: {e}"))?;
    Ok(t0.elapsed().as_millis() as u64)
}
