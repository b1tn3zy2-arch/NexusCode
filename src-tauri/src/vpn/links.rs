//! Share-link + subscription parsers (Happ-compatible formats).
//!
//! Supported: vless://, vmess://, ss://, trojan://, hysteria2://,
//! hy2:// (alias), tuic://, plus base64 subscription bodies.
//! Output is a sing-box-ready outbound JSON per server.
//!
//! NOTE: sing-box itself has no share-link import — this conversion is ours.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use url::Url;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ParsedServer {
    pub id: String,
    pub name: String,
    /// 2-letter country code extracted from the name ("NL", "DE"), if any.
    pub country: Option<String>,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub outbound: Value,
    /// Original share-link (secrets included — vault only, never log).
    /// Lets future versions re-parse stored servers after parser fixes.
    #[serde(default)]
    pub link: Option<String>,
}

/// Sanitize + split country code in one step for provider-given names.
fn final_name(raw: &str, fallback: &str) -> (String, Option<String>) {
    let clean = sanitize_name(raw, fallback);
    let (cc, rest) = split_country(&clean);
    if cc.is_empty() {
        (clean, None)
    } else {
        (rest, Some(cc))
    }
}

fn decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 1 && i + 2 <= b.len() {
            if let Ok(hex) = std::str::from_utf8(&b[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let t = s.trim().replace('-', "+").replace('_', "/");
    let padded = match t.len() % 4 {
        2 => format!("{t}=="),
        3 => format!("{t}="),
        _ => t,
    };
    B64.decode(padded)
        .map_err(|e| format!("base64 decode failed: {e}"))
}

/// Stable across renames: identity is protocol+host+port, never the remark.
fn stable_id(protocol: &str, host: &str, port: u16) -> String {
    let mut h = Sha256::new();
    h.update(format!("{protocol}|{host}|{port}"));
    hex::encode(&h.finalize()[..8])
}

fn query_map(url: &Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

/// Make a provider-given name display-safe.
/// Providers use '+' as space ("NL+Foo") and stuff remarks with emoji
/// (kept) plus random unrenderable junk (dropped): only Unicode
/// letters/digits, emoji pictographs (+ ZWJ/VS16 for compounds) and a
/// small punctuation set survive.
pub fn sanitize_name(raw: &str, fallback: &str) -> String {
    use std::sync::OnceLock;
    static KEEP: OnceLock<regex::Regex> = OnceLock::new();
    let keep = KEEP.get_or_init(|| {
        // Regional indicators (flag pairs) are NOT Extended_Pictographic in
        // this regex version — list U+1F1E6..U+1F1FF explicitly, or flags die.
        regex::Regex::new(
            r"^([\p{L}\p{N}\p{Extended_Pictographic}🇦-🇿\u200d\ufe0f \-_.()\[\]+:/|])$",
        )
        .expect("name keep-list regex")
    });
    let mut out = String::with_capacity(raw.len());
    for ch in raw.replace('+', " ").chars() {
        if ch.is_control() {
            out.push(' ');
        } else {
            let mut b = [0u8; 4];
            if keep.is_match(ch.encode_utf8(&mut b)) {
                out.push(ch);
            } else {
                out.push(' ');
            }
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed
        .trim()
        .trim_matches(['-', '_', '.', ' ', '|'])
        .trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Split a leading/trailing 2-letter country code ("NL - Foo", "[DE] Bar").
/// Returns (country_code_uppercase_or_empty, remaining_name).
pub fn split_country(name: &str) -> (String, String) {
    let t = name.trim();
    // [CC] rest
    if let Some(rest) = t.strip_prefix('[') {
        if rest.len() >= 3 {
            let code = &rest[..2];
            let tail = &rest[2..];
            if code.chars().all(|c| c.is_ascii_alphabetic()) && tail.starts_with(']') {
                return (code.to_uppercase(), tail[1..].trim().trim_start_matches(['-', '_', '|', ' ']).to_string());
            }
        }
    }
    // CC - rest / CC rest
    let mut parts = t.splitn(2, char::is_whitespace);
    let first = parts.next().unwrap_or("");
    let core = first.trim_matches(['-', '_', '|']);
    if core.len() == 2 && core.chars().all(|c| c.is_ascii_alphabetic()) {
        if let Some(rest) = parts.next() {
            let rest = rest.trim().trim_start_matches(['-', '_', '|', ' ']);
            if !rest.is_empty() {
                return (core.to_uppercase(), rest.to_string());
            }
        }
    }
    // rest - CC / rest CC
    if let Some(idx) = t.rfind(char::is_whitespace) {
        let (head, tail) = t.split_at(idx);
        let tail_core = tail.trim().trim_matches(['-', '_', '|', '[', ']']);
        if tail_core.len() == 2 && tail_core.chars().all(|c| c.is_ascii_alphabetic()) {
            let head = head.trim().trim_end_matches(['-', '_', '|', ' ']);
            if !head.is_empty() {
                return (tail_core.to_uppercase(), head.to_string());
            }
        }
    }
    (String::new(), t.to_string())
}

/// TLS section shared by stream-based protocols.
fn tls_section(q: &HashMap<String, String>, host: &str) -> Option<Value> {
    let security = q.get("security").map(|s| s.as_str()).unwrap_or("");
    // Xray-style links use `security=reality` (TLS + REALITY handshake);
    // treat it as TLS-on, otherwise the outbound silently goes plaintext.
    if security != "tls" && security != "reality" {
        return None;
    }
    let sni = q
        .get("sni")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| host.to_string());
    let mut tls = Map::new();
    tls.insert("enabled".into(), json!(true));
    tls.insert("server_name".into(), json!(sni));
    if let Some(fp) = q.get("fp").filter(|s| !s.is_empty() && *s != "none") {
        tls.insert("utls".into(), json!({ "enabled": true, "fingerprint": fp }));
    }
    if let Some(pbk) = q.get("pbk").filter(|s| !s.is_empty()) {
        let mut reality = Map::new();
        reality.insert("enabled".into(), json!(true));
        reality.insert("public_key".into(), json!(pbk));
        reality.insert(
            "short_id".into(),
            json!(q.get("sid").cloned().unwrap_or_default()),
        );
        tls.insert("reality".into(), Value::Object(reality));
    }
    // Self-signed / IP certs are common in private setups.
    if q.get("insecure").map(|s| s == "1" || s == "true").unwrap_or(false)
        || q.get("allowInsecure").map(|s| s == "1" || s == "true").unwrap_or(false)
    {
        tls.insert("insecure".into(), json!(true));
    }
    if let Some(alpn) = q.get("alpn").filter(|s| !s.is_empty()) {
        let list: Vec<&str> = alpn.split(',').map(|s| s.trim()).collect();
        tls.insert("alpn".into(), json!(list));
    }
    Some(Value::Object(tls))
}

/// Transport section (`type` param: ws / grpc / httpupgrade / h2).
fn transport_section(q: &HashMap<String, String>, host: &str) -> Option<Value> {
    match q.get("type").map(|s| s.as_str()).unwrap_or("tcp") {
        "ws" | "websocket" => {
            let mut ws = Map::new();
            ws.insert("type".into(), json!("ws"));
            ws.insert(
                "path".into(),
                json!(q.get("path").cloned().unwrap_or_else(|| "/".into())),
            );
            let h = q.get("host").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| host.to_string());
            ws.insert("headers".into(), json!({ "Host": h }));
            if let Some(eds) = q.get("ed").filter(|s| !s.is_empty()) {
                if let Ok(n) = eds.parse::<u64>() {
                    ws.insert("early_data_header_name".into(), json!("Sec-WebSocket-Protocol"));
                    ws.insert("max_early_data".into(), json!(n));
                }
            }
            Some(Value::Object(ws))
        }
        "grpc" => {
            let mut g = Map::new();
            g.insert("type".into(), json!("grpc"));
            g.insert(
                "service_name".into(),
                json!(q.get("serviceName").or_else(|| q.get("authority")).cloned().unwrap_or_default()),
            );
            Some(Value::Object(g))
        }
        "httpupgrade" => {
            let mut h = Map::new();
            h.insert("type".into(), json!("httpupgrade"));
            h.insert("path".into(), json!(q.get("path").cloned().unwrap_or_else(|| "/".into())));
            h.insert("host".into(), json!(q.get("host").cloned().unwrap_or_else(|| host.to_string())));
            Some(Value::Object(h))
        }
        "http" | "h2" => {
            let mut h = Map::new();
            h.insert("type".into(), json!("http"));
            h.insert("host".into(), json!([q.get("host").cloned().unwrap_or_else(|| host.to_string())]));
            h.insert("path".into(), json!(q.get("path").cloned().unwrap_or_else(|| "/".into())));
            Some(Value::Object(h))
        }
        _ => None,
    }
}

fn parse_vless(link: &str) -> Result<ParsedServer, String> {
    let url = Url::parse(link).map_err(|e| format!("bad vless link: {e}"))?;
    let uuid = decode(url.username());
    if uuid.is_empty() {
        return Err("vless: missing uuid".into());
    }
    let host = url.host_str().ok_or("vless: missing host")?.to_string();
    let port = url.port().unwrap_or(443);
    let q = query_map(&url);
    let raw_frag = decode(url.fragment().unwrap_or(""));
    let (name, country) = if raw_frag.trim().is_empty() {
        (format!("vless {host}:{port}"), None)
    } else {
        final_name(&raw_frag, &format!("vless {host}:{port}"))
    };
    let mut ob = Map::new();
    ob.insert("type".into(), json!("vless"));
    ob.insert("server".into(), json!(host));
    ob.insert("server_port".into(), json!(port));
    ob.insert("uuid".into(), json!(uuid));
    if let Some(flow) = q.get("flow").filter(|s| !s.is_empty() && *s != "none") {
        ob.insert("flow".into(), json!(flow));
    }
    if let Some(enc) = q.get("encryption").filter(|s| !s.is_empty() && *s != "none") {
        ob.insert("packet_encoding".into(), json!(enc));
    }
    if let Some(tls) = tls_section(&q, &host) {
        ob.insert("tls".into(), tls);
    }
    if let Some(t) = transport_section(&q, &host) {
        ob.insert("transport".into(), t);
    }
    Ok(ParsedServer {
        id: stable_id("vless", &host, port),
        name,
        country,
        protocol: "vless".into(),
        host,
        port,
        outbound: Value::Object(ob),
        link: None,
    })
}

fn parse_vmess(link: &str) -> Result<ParsedServer, String> {
    let body = link["vmess://".len()..].split('#').next().unwrap_or("").trim();
    let raw = b64_decode(body)?;
    let v: Value =
        serde_json::from_slice(&raw).map_err(|e| format!("vmess: bad json: {e}"))?;
    let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let host = g("add");
    if host.is_empty() {
        return Err("vmess: missing address".into());
    }
    let port: u16 = g("port").parse().map_err(|_| "vmess: bad port")?;
    let (name, country) = {
        let ps = g("ps");
        if ps.trim().is_empty() {
            (format!("vmess {host}:{port}"), None)
        } else {
            final_name(&ps, &format!("vmess {host}:{port}"))
        }
    };
    let tls_on = g("tls") == "tls";
    let sni = {
        let s = g("sni");
        if s.is_empty() {
            g("host").split(',').next().unwrap_or(&host).to_string()
        } else {
            s
        }
    };
    let mut ob = Map::new();
    ob.insert("type".into(), json!("vmess"));
    ob.insert("server".into(), json!(host));
    ob.insert("server_port".into(), json!(port));
    ob.insert("uuid".into(), json!(g("id")));
    let sec = g("security");
    ob.insert("security".into(), json!(if sec.is_empty() { "auto" } else { &sec }));
    let aid: u16 = g("aid").parse().unwrap_or(0);
    ob.insert("alter_id".into(), json!(aid));
    if tls_on {
        let mut tls = Map::new();
        tls.insert("enabled".into(), json!(true));
        tls.insert("server_name".into(), json!(if sni.is_empty() { host.clone() } else { sni }));
        if g("fp") != "" && g("fp") != "none" {
            tls.insert("utls".into(), json!({ "enabled": true, "fingerprint": g("fp") }));
        }
        ob.insert("tls".into(), Value::Object(tls));
    }
    // Transport from `net`.
    let net = g("net");
    if !net.is_empty() && net != "tcp" {
        let mut q = HashMap::new();
        q.insert("type".into(), if net == "ws" { "ws".into() } else { net.clone() });
        q.insert("path".into(), g("path"));
        q.insert("host".into(), g("host"));
        if net == "grpc" {
            q.insert("serviceName".into(), g("path"));
        }
        if let Some(t) = transport_section(&q, &host) {
            ob.insert("transport".into(), t);
        }
    }
    Ok(ParsedServer {
        id: stable_id("vmess", &host, port),
        name,
        country,
        protocol: "vmess".into(),
        host,
        port,
        outbound: Value::Object(ob),
        link: None,
    })
}

fn parse_ss(link: &str) -> Result<ParsedServer, String> {
    // Two forms:
    //   ss://BASE64(method:password)@host:port#name
    //   ss://BASE64(method:password@host:port)#name
    let rest = &link["ss://".len()..];
    let (head, frag) = match rest.rsplit_once('#') {
        Some((h, f)) => (h, decode(f)),
        None => (rest, String::new()),
    };
    let (method, password, host, port): (String, String, String, u16) =
        if head.contains('@') {
            let (b64info, hp) = head.rsplit_once('@').ok_or("ss: bad format")?;
            let info = String::from_utf8(b64_decode(b64info)?).map_err(|_| "ss: bad userinfo")?;
            let (m, p) = info.split_once(':').ok_or("ss: bad method:password")?;
            let (h, pt) = hp.rsplit_once(':').ok_or("ss: bad host:port")?;
            (m.to_string(), p.to_string(), h.to_string(), pt.parse().map_err(|_| "ss: bad port")?)
        } else {
            let info = String::from_utf8(b64_decode(head)?).map_err(|_| "ss: bad payload")?;
            let (mp, hp) = info.rsplit_once('@').ok_or("ss: bad format")?;
            let (m, p) = mp.split_once(':').ok_or("ss: bad method:password")?;
            let (h, pt) = hp.rsplit_once(':').ok_or("ss: bad host:port")?;
            (m.to_string(), p.to_string(), h.to_string(), pt.parse().map_err(|_| "ss: bad port")?)
        };
    if host.is_empty() {
        return Err("ss: missing host".into());
    }
    let (name, country) = if frag.trim().is_empty() {
        (format!("shadowsocks {host}:{port}"), None)
    } else {
        final_name(&frag, &format!("shadowsocks {host}:{port}"))
    };
    let mut ob = Map::new();
    ob.insert("type".into(), json!("shadowsocks"));
    ob.insert("server".into(), json!(host));
    ob.insert("server_port".into(), json!(port));
    ob.insert("method".into(), json!(method));
    ob.insert("password".into(), json!(password));
    Ok(ParsedServer {
        id: stable_id("ss", &host, port),
        name,
        country,
        protocol: "ss".into(),
        host,
        port,
        outbound: Value::Object(ob),
        link: None,
    })
}

fn parse_trojan(link: &str) -> Result<ParsedServer, String> {
    let url = Url::parse(link).map_err(|e| format!("bad trojan link: {e}"))?;
    let password = decode(url.username());
    if password.is_empty() {
        return Err("trojan: missing password".into());
    }
    let host = url.host_str().ok_or("trojan: missing host")?.to_string();
    let port = url.port().unwrap_or(443);
    let q = query_map(&url);
    let raw_frag = decode(url.fragment().unwrap_or(""));
    let (name, country) = if raw_frag.trim().is_empty() {
        (format!("trojan {host}:{port}"), None)
    } else {
        final_name(&raw_frag, &format!("trojan {host}:{port}"))
    };
    let mut ob = Map::new();
    ob.insert("type".into(), json!("trojan"));
    ob.insert("server".into(), json!(host));
    ob.insert("server_port".into(), json!(port));
    ob.insert("password".into(), json!(password));
    // Trojan is always TLS; force-enable with sni fallback.
    let mut q2 = q.clone();
    q2.entry("security".into()).or_insert_with(|| "tls".into());
    if let Some(tls) = tls_section(&q2, &host) {
        ob.insert("tls".into(), tls);
    } else {
        let sni = q.get("sni").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| host.clone());
        ob.insert("tls".into(), json!({ "enabled": true, "server_name": sni }));
    }
    if let Some(t) = transport_section(&q, &host) {
        ob.insert("transport".into(), t);
    }
    Ok(ParsedServer {
        id: stable_id("trojan", &host, port),
        name,
        country,
        protocol: "trojan".into(),
        host,
        port,
        outbound: Value::Object(ob),
        link: None,
    })
}

fn parse_hysteria2(link: &str) -> Result<ParsedServer, String> {
    let scheme_end = link.find("://").ok_or("hy2: bad link")?;
    let proto = &link[..scheme_end];
    let fixed = format!("hy2{}", &link[scheme_end..]);
    let url = Url::parse(&fixed).map_err(|e| format!("bad hysteria2 link: {e}"))?;
    let password = decode(url.username());
    if password.is_empty() {
        return Err("hysteria2: missing password".into());
    }
    let host = url.host_str().ok_or("hysteria2: missing host")?.to_string();
    let port = url.port().unwrap_or(443);
    let q = query_map(&url);
    let raw_frag = decode(url.fragment().unwrap_or(""));
    let (name, country) = if raw_frag.trim().is_empty() {
        (format!("hy2 {host}:{port}"), None)
    } else {
        final_name(&raw_frag, &format!("hy2 {host}:{port}"))
    };
    let mut tls = Map::new();
    tls.insert("enabled".into(), json!(true));
    tls.insert(
        "server_name".into(),
        json!(q.get("sni").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| host.clone())),
    );
    if q.get("insecure").map(|s| s == "1" || s == "true").unwrap_or(false) {
        tls.insert("insecure".into(), json!(true));
    }
    if let Some(alpn) = q.get("alpn").filter(|s| !s.is_empty()) {
        tls.insert("alpn".into(), json!([alpn]));
    } else {
        tls.insert("alpn".into(), json!(["h3"]));
    }
    let mut ob = Map::new();
    ob.insert("type".into(), json!("hysteria2"));
    ob.insert("server".into(), json!(host));
    ob.insert("server_port".into(), json!(port));
    ob.insert("password".into(), json!(password));
    ob.insert("tls".into(), Value::Object(tls));
    if let Some(obfs) = q.get("obfs").filter(|s| *s == "salamander") {
        let _ = obfs;
        ob.insert(
            "obfs".into(),
            json!({
                "type": "salamander",
                "password": q.get("obfs-password").cloned().unwrap_or_default(),
            }),
        );
    }
    Ok(ParsedServer {
        id: stable_id(proto, &host, port),
        name,
        country,
        protocol: "hysteria2".into(),
        host,
        port,
        outbound: Value::Object(ob),
        link: None,
    })
}

fn parse_tuic(link: &str) -> Result<ParsedServer, String> {
    let url = Url::parse(link).map_err(|e| format!("bad tuic link: {e}"))?;
    let uuid = decode(url.username());
    let password = url.password().map(decode).unwrap_or_default();
    if uuid.is_empty() {
        return Err("tuic: missing uuid".into());
    }
    let host = url.host_str().ok_or("tuic: missing host")?.to_string();
    let port = url.port().unwrap_or(443);
    let q = query_map(&url);
    let raw_frag = decode(url.fragment().unwrap_or(""));
    let (name, country) = if raw_frag.trim().is_empty() {
        (format!("tuic {host}:{port}"), None)
    } else {
        final_name(&raw_frag, &format!("tuic {host}:{port}"))
    };
    let mut tls = Map::new();
    tls.insert("enabled".into(), json!(true));
    tls.insert(
        "server_name".into(),
        json!(q.get("sni").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| host.clone())),
    );
    if let Some(alpn) = q.get("alpn").filter(|s| !s.is_empty()) {
        tls.insert("alpn".into(), json!([alpn]));
    }
    let mut ob = Map::new();
    ob.insert("type".into(), json!("tuic"));
    ob.insert("server".into(), json!(host));
    ob.insert("server_port".into(), json!(port));
    ob.insert("uuid".into(), json!(uuid));
    ob.insert("password".into(), json!(password));
    if let Some(cc) = q.get("congestion_control").filter(|s| !s.is_empty()) {
        ob.insert("congestion_control".into(), json!(cc));
    }
    if let Some(urm) = q.get("udp_relay_mode").filter(|s| !s.is_empty()) {
        ob.insert("udp_relay_mode".into(), json!(urm));
    }
    ob.insert("tls".into(), Value::Object(tls));
    Ok(ParsedServer {
        id: stable_id("tuic", &host, port),
        name,
        country,
        protocol: "tuic".into(),
        host,
        port,
        outbound: Value::Object(ob),
        link: None,
    })
}

/// Parse one share-link into a sing-box-ready server.
pub fn parse_link(link: &str) -> Result<ParsedServer, String> {
    let t = link.trim();
    if t.is_empty() {
        return Err("empty link".into());
    }
    let scheme = t.split("://").next().unwrap_or("").to_lowercase();
    let mut s = match scheme.as_str() {
        "vless" => parse_vless(t),
        "vmess" => parse_vmess(t),
        "ss" | "shadowsocks" => parse_ss(t),
        "trojan" => parse_trojan(t),
        "hysteria2" | "hy2" => parse_hysteria2(t),
        "tuic" => parse_tuic(t),
        other => Err(format!("unsupported scheme: {other} (need vless/vmess/ss/trojan/hysteria2/tuic)")),
    }?;
    // Keep the original link (secrets inside — vault only, never log) so
    // stored servers can be re-parsed after future parser fixes.
    s.link = Some(t.to_string());
    Ok(s)
}

/// Parse a subscription body: base64 blob or plain lines of share-links.
/// Returns (servers, failed_count).
pub fn parse_subscription(body: &str) -> (Vec<ParsedServer>, usize) {
    let text = match b64_decode(body.trim()) {
        Ok(raw) => String::from_utf8_lossy(&raw).into_owned(),
        Err(_) => body.to_string(),
    };
    let mut out = Vec::new();
    let mut failed = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match parse_link(line) {
            Ok(s) => out.push(s),
            Err(_) => failed += 1,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    (out, failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vless_basic() {
        let s = parse_link("vless://11111111-2222-3333-4444-555555555555@vpn.example.com:443?security=tls&sni=vpn.example.com&fp=chrome&type=ws&path=%2Fws&host=vpn.example.com#Test%20VLESS").unwrap();
        assert_eq!(s.protocol, "vless");
        assert_eq!(s.host, "vpn.example.com");
        assert_eq!(s.port, 443);
        assert_eq!(s.name, "Test VLESS");
        assert_eq!(s.outbound["tls"]["server_name"], json!("vpn.example.com"));
        assert_eq!(s.outbound["transport"]["type"], json!("ws"));
    }

    #[test]
    fn hy2_alias_reality_free() {
        let s = parse_link("hy2://secret@203.0.113.7:8443?sni=cdn.example.com&insecure=1#Hy2%20Test").unwrap();
        assert_eq!(s.protocol, "hysteria2");
        assert_eq!(s.port, 8443);
        assert_eq!(s.outbound["tls"]["insecure"], json!(true));
        assert_eq!(s.outbound["tls"]["alpn"], json!(["h3"]));
    }

    #[test]
    fn subscription_mixed() {
        let body = "trojan://pass@tro.example.com:443#Tro\nnot-a-link\nss://YWVzLTI1Ni1nY206c2VjcmV0@ss.example.com:8388#SS";
        let (servers, failed) = parse_subscription(body);
        assert_eq!(servers.len(), 2);
        assert_eq!(failed, 1);
    }
}
