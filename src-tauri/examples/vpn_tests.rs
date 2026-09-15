#[path = "../src/vpn/links.rs"]
mod links;

use links::*;

fn main() {
    let mut failures = 0;

    macro_rules! check {
        ($name:expr, $cond:expr) => {
            if $cond {
                println!("PASS {}", $name);
            } else {
                println!("FAIL {}", $name);
                failures += 1;
            }
        };
    }

    // vless with TLS + ws transport + fragment name
    let s = parse_link("vless://11111111-2222-3333-4444-555555555555@vpn.example.com:443?security=tls&sni=vpn.example.com&fp=chrome&type=ws&path=%2Fws&host=vpn.example.com#Test%20VLESS").unwrap();
    check!("vless proto", s.protocol == "vless");
    check!("vless host/port", s.host == "vpn.example.com" && s.port == 443);
    check!("vless name", s.name == "Test VLESS");
    check!("vless tls sni", s.outbound["tls"]["server_name"] == serde_json::json!("vpn.example.com"));
    check!("vless ws", s.outbound["transport"]["type"] == serde_json::json!("ws"));
    check!("vless id stable", s.id == parse_link("vless://other-uuid@vpn.example.com:443#Test%20VLESS").unwrap().id);

    // vless reality
    let s = parse_link("vless://uuid@r.example.com:443?security=tls&sni=r.example.com&fp=chrome&pbk=ABCDEF123456&sid=deadbeef&flow=xtls-rprx-vision#R").unwrap();
    check!("vless reality", s.outbound["tls"]["reality"]["public_key"] == serde_json::json!("ABCDEF123456"));
    check!("vless flow", s.outbound["flow"] == serde_json::json!("xtls-rprx-vision"));

    // hy2 alias + insecure + default h3 alpn
    let s = parse_link("hy2://secret@203.0.113.7:8443?sni=cdn.example.com&insecure=1#Hy2%20Test").unwrap();
    check!("hy2 proto", s.protocol == "hysteria2");
    check!("hy2 port", s.port == 8443);
    check!("hy2 insecure", s.outbound["tls"]["insecure"] == serde_json::json!(true));
    check!("hy2 alpn", s.outbound["tls"]["alpn"] == serde_json::json!(["h3"]));

    // hysteria2 salamander obfs
    let s = parse_link("hysteria2://pw@h.example.com:443?obfs=salamander&obfs-password=obf#O").unwrap();
    check!("hy2 obfs", s.outbound["obfs"]["type"] == serde_json::json!("salamander"));

    // trojan forces TLS
    let s = parse_link("trojan://pass@tro.example.com:443?sni=tro.example.com#Tro").unwrap();
    check!("trojan tls", s.outbound["tls"]["enabled"] == serde_json::json!(true));

    // ss full form
    let s = parse_link("ss://YWVzLTI1Ni1nY206c2VjcmV0@ss.example.com:8388#SS").unwrap();
    check!("ss proto", s.protocol == "ss");
    check!("ss method", s.outbound["method"] == serde_json::json!("aes-256-gcm"));
    check!("ss pass", s.outbound["password"] == serde_json::json!("secret"));

    // ss embedded form
    let s = parse_link("ss://YWVzLTI1Ni1nY206c2VjcmV0QHNzMi5leGFtcGxlLmNvbTo4Mzg4#SS2").unwrap();
    check!("ss embedded host", s.host == "ss2.example.com" && s.port == 8388);

    // tuic
    let s = parse_link("tuic://uuid-123:pass@tu.example.com:443?congestion_control=bbr&udp_relay_mode=native&sni=tu.example.com#TU").unwrap();
    check!("tuic proto", s.protocol == "tuic");
    check!("tuic cc", s.outbound["congestion_control"] == serde_json::json!("bbr"));

    // vmess (classic JSON)
    let vmess_json = r#"{"v":"2","ps":"VM","add":"vm.example.com","port":"10086","id":"uuid-1","aid":"0","net":"ws","type":"none","host":"vm.example.com","path":"/p","tls":"tls","sni":"vm.example.com"}"#;
    let vmess_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        vmess_json.as_bytes(),
    );
    let s = parse_link(&format!("vmess://{vmess_b64}")).unwrap();
    check!("vmess host/port", s.host == "vm.example.com" && s.port == 10086);
    check!("vmess tls", s.outbound["tls"]["enabled"] == serde_json::json!(true));
    check!("vmess ws", s.outbound["transport"]["type"] == serde_json::json!("ws"));

    // subscription: plain + base64, failures counted
    let body = "trojan://pass@tro.example.com:443#Tro\nnot-a-link\nss://YWVzLTI1Ni1nY206c2VjcmV0@ss.example.com:8388#SS";
    let (servers, failed) = parse_subscription(body);
    check!("sub count", servers.len() == 2);
    check!("sub failed", failed == 1);
    let b64sub = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, body.as_bytes());
    let (servers2, _) = parse_subscription(&b64sub);
    check!("sub base64", servers2.len() == 2);

    // Happ-style names: '+' -> space, country code extracted, emoji kept
    let s = parse_link("vless://11111111-2222-3333-4444-555555555555@nl-50.gnodes.club:443#NL+%D0%9B%D0%B5%D1%82%D1%83%D1%87%D0%B8%D0%B9+%D0%93%D0%BE%D0%BB%D0%BB%D0%B0%D0%BD%D0%B4%D0%B5%D1%86+%F0%9F%8F%86").unwrap();
    check!("name plus->space", s.name == "Летучий Голландец 🏆");
    check!("country NL", s.country.as_deref() == Some("NL"));
    let s = parse_link("vless://11111111-2222-3333-4444-555555555555@de-28.gnodes.club:443#[DE]+%D0%9E%D0%BA%D1%82%D0%BE%D0%B1%D0%B5%D1%80%D1%84%D0%B5%D1%81%D1%82").unwrap();
    check!("name brackets", s.name == "Октоберфест");
    check!("country DE", s.country.as_deref() == Some("DE"));

    // vless reality via `security=reality` (Xray style, no flow)
    let s = parse_link("vless://uuid@r.example.com:443?security=reality&fp=firefox&sni=r.example.com&pbk=PUBKEY123&alpn=h2#R").unwrap();
    check!("reality security implies tls", s.outbound["tls"]["enabled"] == serde_json::json!(true));
    check!("reality sni", s.outbound["tls"]["server_name"] == serde_json::json!("r.example.com"));
    check!("reality pbk", s.outbound["tls"]["reality"]["public_key"] == serde_json::json!("PUBKEY123"));
    check!("reality alpn", s.outbound["tls"]["alpn"] == serde_json::json!(["h2"]));

    // flag emoji (regional indicators U+1F1E6..U+1F1FF) survive sanitizing
    let s = parse_link("vless://11111111-2222-3333-4444-555555555555@nl-56.gnodes.club:443#%F0%9F%87%B3%F0%9F%87%B1+%D0%A2%D0%B5%D1%81%D1%82").unwrap();
    check!("flag emoji kept", s.name == "🇳🇱 Тест");

    // errors, not panics
    check!("bad scheme", parse_link("socks5://a@b:1").is_err());
    check!("empty", parse_link("   ").is_err());
    check!("vless no uuid", parse_link("vless://@h:443").is_err());

    if failures > 0 {
        println!("{failures} FAILURES");
        std::process::exit(1);
    }
    println!("all vpn link tests passed");
}
