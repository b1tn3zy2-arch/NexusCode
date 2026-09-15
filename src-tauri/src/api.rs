use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tokio::time::sleep;

pub async fn wait_for_health(port: u16, max_ms: u64) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{}/global/health", port);
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(max_ms);

    while tokio::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(body) = resp.json::<Value>().await {
                if body.get("healthy").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return Ok(body);
                }
            }
        }
        sleep(Duration::from_millis(250)).await;
    }

    Err(format!(
        "opencode server did not become healthy on port {} within {} ms",
        port, max_ms
    ))
}

#[derive(Deserialize)]
pub struct OcRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
}

pub async fn oc_request(port: u16, req: OcRequest) -> Result<Value, String> {
    let method = req.method.to_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PATCH" | "DELETE" | "PUT") {
        return Err(format!("unsupported method: {}", method));
    }
    let path = req.path.trim_start_matches('/').to_string();
    let url = format!("http://127.0.0.1:{}/{}", port, path);

    let client = reqwest::Client::new();
    let mut builder = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.put(&url),
    };

    if let Some(body) = &req.body {
        builder = builder.json(body);
    }

    let resp = builder
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        // Try to extract a human-readable message before truncating the raw payload,
        // so the 500-char cut in the original code does not break JSON parsing in
        // `toChatError` on the frontend.
        let friendly = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("error"))
                    .or_else(|| v.get("msg"))
                    .or_else(|| v.get("detail"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            });
        let detail = friendly.unwrap_or_else(|| truncate(&text, 4000));
        return Err(format!("HTTP {}: {}", status.as_u16(), detail));
    }

    if text.trim().is_empty() {
        return Ok(Value::Null);
    }

    serde_json::from_str(&text).or_else(|_| Ok(Value::String(text)))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{}…", truncated)
}
