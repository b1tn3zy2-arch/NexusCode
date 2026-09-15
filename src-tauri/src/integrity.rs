//! Anti-tamper: verify sidecar binaries we execute (opencode, sing-box)
//! against hashes recorded at download time.
//!
//! The manifest is baked in at compile time from
//! `src-tauri/binaries/SHA256SUMS` (written by the download scripts).
//! Unknown files pass with a warning (dev builds, manual placement) —
//! known files with a wrong hash are refused with a neutral error.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;

const MANIFEST: &str = include_str!("../binaries/SHA256SUMS");

fn manifest_map() -> HashMap<String, String> {
    let mut m = HashMap::new();
    for line in MANIFEST.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        if let (Some(hash), Some(name)) = (it.next(), it.next()) {
            m.insert(name.to_string(), hash.to_lowercase());
        }
    }
    m
}

/// Refuse to execute a tampered sidecar. Neutral error, no details leaked.
pub fn verify_sidecar(path: &str) -> Result<(), String> {
    let file_name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let expected = match manifest_map().get(&file_name) {
        Some(h) => h.clone(),
        None => return Ok(()), // dev/manual binary — allow
    };
    let mut f = std::fs::File::open(path).map_err(|_| "Integrity check failed (code 3)".to_string())?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|_| "Integrity check failed (code 3)".to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let actual = hex::encode(h.finalize());
    if actual == expected {
        Ok(())
    } else {
        Err("Integrity check failed (code 3)".to_string())
    }
}
