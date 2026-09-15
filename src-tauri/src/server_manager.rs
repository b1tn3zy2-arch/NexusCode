use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub port: u16,
    pub pid: u32,
    pub work_dir: String,
    pub binary_path: String,
}

pub struct ManagedServer {
    pub child: Child,
    pub info: ServerInfo,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartConfig {
    pub binary_path: String,
    pub work_dir: String,
    pub port: Option<u16>,
    /// Local VPN proxy URL (http://127.0.0.1:PORT) or null for direct.
    #[serde(default)]
    pub proxy_url: Option<String>,
}

fn drain_to_buffer<R: std::io::Read + Send + 'static>(mut reader: R) -> Arc<std::sync::Mutex<String>> {
    let buffer = Arc::new(std::sync::Mutex::new(String::new()));
    let sink = Arc::clone(&buffer);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut guard = sink.lock().unwrap();
                    if guard.len() < 64 * 1024 {
                        guard.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
                Err(_) => break,
            }
        }
    });
    buffer
}

pub fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

pub fn spawn_server(cfg: &StartConfig) -> Result<ManagedServer, String> {
    let port = match cfg.port {
        Some(p) if p > 0 => p,
        _ => pick_free_port()?,
    };

    let mut cmd = Command::new(&cfg.binary_path);
    cmd.args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"])
        .current_dir(&cfg.work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // App-level VPN: only opencode's own upstream (LLM APIs) goes through
    // the local proxy. NO_PROXY keeps its localhost server comms direct —
    // without it the TUI/server link would loop through the proxy.
    if let Some(proxy) = cfg.proxy_url.as_ref().filter(|u| !u.trim().is_empty()) {
        cmd.env("HTTPS_PROXY", proxy)
            .env("https_proxy", proxy)
            .env("HTTP_PROXY", proxy)
            .env("http_proxy", proxy)
            .env("NO_PROXY", "localhost,127.0.0.1")
            .env("no_proxy", "localhost,127.0.0.1");
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{}': {}", cfg.binary_path, e))?;

    // Bun-compiled binaries misbehave with fully closed stdio; keep the pipes
    // open and drain them so the child never blocks on a full pipe buffer.
    if let Some(stdout) = child.stdout.take() {
        let buf = drain_to_buffer(stdout);
        *crate::LAST_CHILD_STDOUT.lock().unwrap() = Some(buf);
    }
    if let Some(stderr) = child.stderr.take() {
        let buf = drain_to_buffer(stderr);
        *crate::LAST_CHILD_STDERR.lock().unwrap() = Some(buf);
    }

    let info = ServerInfo {
        port,
        pid: child.id(),
        work_dir: cfg.work_dir.clone(),
        binary_path: cfg.binary_path.clone(),
    };

    Ok(ManagedServer { child, info })
}

pub fn is_alive(server: &mut ManagedServer) -> bool {
    matches!(server.child.try_wait(), Ok(None))
}
