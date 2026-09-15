//! Permission interception flow: SSE event -> engine decision -> respond/log/emit.
//! Pure decision logic lives in `auto_approve_core` (unit-testable standalone).

use serde_json::Value;

pub use crate::auto_approve_core::{AutoApproveConfig, Decision, PermissionRequest, RuleEngine};

use crate::action_log::ActionLog;
use crate::api;
use crate::AppState;
use tauri::{AppHandle, Emitter, Manager};

pub const PERMISSION_EVENT: &str = "oc-permission";

async fn respond(
    app: &AppHandle,
    session_id: &str,
    permission_id: &str,
    response: &str,
) -> Result<(), String> {
    let port = {
        let state = app.state::<AppState>();
        let guard = state.server.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.info.port,
            None => return Err("server is not running".to_string()),
        }
    };

    api::oc_request(
        port,
        api::OcRequest {
            method: "POST".to_string(),
            path: format!("/session/{session_id}/permissions/{permission_id}"),
            body: Some(serde_json::json!({ "response": response })),
        },
    )
    .await
    .map(|_| ())
}

fn emit_permission(app: &AppHandle, payload: Value) {
    let _ = app.emit(PERMISSION_EVENT, payload);
}

fn log_action(
    app: &AppHandle,
    req: &PermissionRequest,
    decision: &str,
    reason: Option<&str>,
    auto: bool,
) {
    if let Some(log) = app.try_state::<ActionLog>() {
        let detail = serde_json::to_string(&req.metadata).ok();
        let _ = log.insert(
            Some(&req.session_id),
            Some(&req.id),
            Some(&req.kind),
            detail.as_deref(),
            decision,
            reason,
            auto,
        );
    }
}

/// Entry point called from the SSE bridge for every `permission.updated` event.
pub async fn handle_permission(app: AppHandle, props: Value) {
    let req: PermissionRequest = match serde_json::from_value(props) {
        Ok(r) => r,
        Err(e) => {
            crate::log_line(&format!("auto_approve: failed to parse permission: {e}"));
            return;
        }
    };

    let engine = {
        let state = app.state::<AppState>();
        let guard = state.engine.lock().unwrap();
        guard.clone()
    };

    let decision = engine
        .as_ref()
        .map(|e| e.evaluate(&req))
        .unwrap_or(Decision::Manual);

    match decision {
        Decision::Approve => {
            log_action(&app, &req, "approved", Some("auto-approve rule"), true);

            let delay = engine.as_ref().map(|e| e.config().delay_ms).unwrap_or(0);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }

            match respond(&app, &req.session_id, &req.id, "once").await {
                Ok(()) => emit_permission(
                    &app,
                    serde_json::json!({
                        "kind": "resolved",
                        "decision": "approved",
                        "auto": true,
                        "request": req,
                    }),
                ),
                Err(e) => {
                    crate::log_line(&format!(
                        "auto_approve: approve POST failed ({}), falling back to manual",
                        e
                    ));
                    let state = app.state::<AppState>();
                    state
                        .pending
                        .lock()
                        .unwrap()
                        .insert(req.id.clone(), req.clone());
                    drop(state);
                    emit_permission(
                        &app,
                        serde_json::json!({ "kind": "request", "request": req }),
                    );
                }
            }
        }

        Decision::Reject(reason) => {
            log_action(&app, &req, "rejected", Some(&reason), true);
            if let Err(e) = respond(&app, &req.session_id, &req.id, "reject").await {
                crate::log_line(&format!("auto_approve: reject POST failed: {e}"));
            }
            emit_permission(
                &app,
                serde_json::json!({
                    "kind": "resolved",
                    "decision": "rejected",
                    "auto": true,
                    "reason": reason,
                    "request": req,
                }),
            );
        }

        Decision::Manual => {
            let state = app.state::<AppState>();
            state
                .pending
                .lock()
                .unwrap()
                .insert(req.id.clone(), req.clone());
            drop(state);
            emit_permission(
                &app,
                serde_json::json!({ "kind": "request", "request": req }),
            );
        }
    }
}

/// Called when the server reports a permission was answered elsewhere.
pub fn handle_replied(app: &AppHandle, props: &Value) {
    let permission_id = props.get("permissionID").and_then(|v| v.as_str());

    if let Some(pid) = permission_id {
        let state = app.state::<AppState>();
        if state.pending.lock().unwrap().remove(pid).is_some() {
            emit_permission(
                app,
                serde_json::json!({
                    "kind": "replied",
                    "permissionID": pid,
                    "response": props.get("response"),
                }),
            );
        }
    }
}

/// User answered the dialog in the UI.
#[tauri::command]
pub async fn permission_respond(
    app: AppHandle,
    session_id: String,
    permission_id: String,
    response: String,
) -> Result<(), String> {
    if !matches!(response.as_str(), "once" | "always" | "reject") {
        return Err(format!("invalid response: {response}"));
    }

    let pending_req = {
        let state = app.state::<AppState>();
        let mut guard = state.pending.lock().unwrap();
        guard.remove(&permission_id)
    };

    respond(&app, &session_id, &permission_id, &response).await?;

    if let Some(req) = pending_req {
        let decision = if response == "reject" {
            "rejected"
        } else {
            "approved"
        };
        log_action(&app, &req, decision, None, false);
        emit_permission(
            &app,
            serde_json::json!({
                "kind": "resolved",
                "decision": decision,
                "auto": false,
                "request": req,
            }),
        );
    }

    Ok(())
}

#[tauri::command]
pub fn set_auto_approve_config(state: tauri::State<'_, AppState>, config: AutoApproveConfig) {
    *state.engine.lock().unwrap() = Some(std::sync::Arc::new(RuleEngine::new(config)));
}

#[tauri::command]
pub fn action_log_list(
    log: tauri::State<'_, ActionLog>,
    limit: Option<i64>,
) -> Result<Vec<crate::action_log::LogEntry>, String> {
    log.list(limit.unwrap_or(50))
}

#[tauri::command]
pub fn action_log_clear(log: tauri::State<'_, ActionLog>) -> Result<(), String> {
    log.clear()
}
