//! sing-box config generation for a single selected server.
//!
//! The proxy exposes ONE local endpoint (mixed HTTP+SOCKS5 on 127.0.0.1)
//! that only our own traffic uses: opencode (via HTTPS_PROXY env) and the
//! Rust `net_fetch` client. Nothing system-wide, no TUN.

use serde_json::{json, Map, Value};

/// Build a minimal sing-box config routing everything via `outbound`.
/// A `direct` outbound exists for sing-box internals (DNS), but the final
/// route is always the proxy — clients never get a direct path.
pub fn build_config(mut outbound: Map<String, Value>, mixed_port: u16) -> Value {
    outbound.insert("tag".into(), json!("nx-proxy"));
    json!({
        "log": { "level": "warn" },
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": mixed_port
            }
        ],
        "outbounds": [
            Value::Object(outbound),
            { "type": "direct", "tag": "direct" }
        ],
        // NOTE: sing-box >= 1.13 removed legacy inbound `sniff` — protocol
        // sniffing is a route rule action now.
        "route": { "rules": [{ "action": "sniff" }], "final": "nx-proxy" }
    })
}
