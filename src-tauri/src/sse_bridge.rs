use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use std::time::Duration;

pub const EVENT_NAME: &str = "oc-event";
pub fn start(app: AppHandle, port: u16) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let url = format!("http://127.0.0.1:{}/event", port);
        let mut backoff_ms: u64 = 1000;

        loop {
            let client = reqwest::Client::new();
            let result = run_stream(&client, &url, &app).await;

            match result {
                StreamOutcome::Disconnected(reason) => {
                    let _ = app.emit(
                        EVENT_NAME,
                        serde_json::json!({
                            "type": "bridge.disconnected",
                            "properties": { "reason": reason }
                        }),
                    );
                }
                StreamOutcome::Fatal(reason) => {
                    let _ = app.emit(
                        EVENT_NAME,
                        serde_json::json!({
                            "type": "bridge.fatal",
                            "properties": { "reason": reason }
                        }),
                    );
                    return;
                }
            }

            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(10_000);
        }
    })
}

enum StreamOutcome {
    Disconnected(String),
    Fatal(String),
}

fn dispatch_special(app: &AppHandle, value: &serde_json::Value) {
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "permission.updated" => {
            let app = app.clone();
            let props = value
                .get("properties")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            tokio::spawn(async move {
                crate::auto_approve::handle_permission(app, props).await;
            });
        }
        "permission.replied" => {
            crate::auto_approve::handle_replied(app, value);
        }
        _ => {}
    }
}

async fn run_stream(client: &reqwest::Client, url: &str, app: &AppHandle) -> StreamOutcome {
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return StreamOutcome::Disconnected(e.to_string()),
    };

    if !resp.status().is_success() {
        return StreamOutcome::Fatal(format!("HTTP {}", resp.status().as_u16()));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => return StreamOutcome::Disconnected(e.to_string()),
        };

        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line: String = buffer.drain(..=pos).collect();
            let line = line.trim_end_matches(['\r', '\n']);

            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim_start();
                if data.is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(data) {
                    Ok(value) => {
                        dispatch_special(app, &value);
                        let _ = app.emit(EVENT_NAME, value);
                    }
                    Err(_) => {
                        let _ = app.emit(
                            EVENT_NAME,
                            serde_json::json!({
                                "type": "bridge.raw",
                                "properties": { "data": data }
                            }),
                        );
                    }
                }
            }
        }

        if buffer.len() > 4 * 1024 * 1024 {
            buffer.clear();
        }
    }

    StreamOutcome::Disconnected("stream ended".to_string())
}
