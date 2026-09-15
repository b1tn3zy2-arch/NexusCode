//! OS-protected secret storage (Credential Manager / Keychain / Secret Service).
//!
//! VPN keys, subscriptions and any future API tokens live here — never in
//! plain localStorage files. Service name is fixed to the app identifier.

use keyring::Entry;

const SERVICE: &str = "ai.nexuscode.app";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("vault unavailable: {e}"))
}

#[tauri::command]
pub fn vault_set(account: String, secret: String) -> Result<(), String> {
    if account.trim().is_empty() || account.len() > 128 {
        return Err("bad vault account".into());
    }
    if secret.len() > 1_000_000 {
        return Err("secret too large".into());
    }
    entry(&account)
        .and_then(|e| e.set_password(&secret).map_err(|e| format!("vault write: {e}")))
}

#[tauri::command]
pub fn vault_get(account: String) -> Result<Option<String>, String> {
    let e = entry(&account)?;
    match e.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("vault read: {e}")),
    }
}

#[tauri::command]
pub fn vault_delete(account: String) -> Result<(), String> {
    let e = entry(&account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("vault delete: {e}")),
    }
}
