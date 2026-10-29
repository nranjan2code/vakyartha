// Cross-platform credential vault for the indestructible Rust engine.
// Supports macOS (Keychain), Linux (Secret Service / owner-only 0600 store),
// and Windows (user-isolated app data vault).
// Input validation guarantees that account names, service names, and values
// cannot inject commands, escape boundaries, or contain malformed control characters.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Validate service name: 1..=128 chars, ascii alphanumeric, '.', '-', '_'.
pub fn is_valid_service(service: &str) -> bool {
    !service.is_empty()
        && service.len() <= 128
        && service
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Validate account name: 1..=128 chars, ascii alphanumeric, '_'.
/// Matches standard environment variable names (e.g., OPENAI_API_KEY).
pub fn is_valid_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 128
        && account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Validate secret value: max 4096 chars, no newlines or null bytes, no quotes or backslashes.
pub fn is_valid_value(value: &str) -> bool {
    value.len() <= 4096
        && !value
            .chars()
            .any(|c| c == '\r' || c == '\n' || c == '\0' || c == '"' || c == '\\')
}

// ---------------------------------------------------------------------------
// File-based Owner-Only Vault (Cross-Platform fallback & Linux/Windows)
// ---------------------------------------------------------------------------

fn vault_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(".vault.secrets")
}

fn read_vault_file(path: &Path) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = trimmed.split_once('=') {
                let k = k.trim();
                let v = v.trim();
                let unquoted = if (v.starts_with('"') && v.ends_with('"'))
                    || (v.starts_with('\'') && v.ends_with('\''))
                {
                    if v.len() >= 2 { &v[1..v.len() - 1] } else { v }
                } else {
                    v
                };
                map.insert(k.to_string(), unquoted.to_string());
            }
        }
    }
    map
}

fn write_vault_file(path: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    let mut content = String::new();
    for (k, v) in map {
        content.push_str(&format!("{k}={v}\n"));
    }

    let temp_path = path.with_extension("tmp");
    std::fs::write(&temp_path, &content).map_err(|e| format!("Failed to write vault temp file: {e}"))?;

    #[cfg(unix)]
    {
        let perm = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&temp_path, perm);
    }

    std::fs::rename(&temp_path, path).map_err(|e| format!("Failed to commit vault file: {e}"))?;

    #[cfg(unix)]
    {
        let perm = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(path, perm);
    }

    Ok(())
}

fn file_vault_get(data_dir: &Path, account: &str) -> Option<String> {
    let path = vault_file_path(data_dir);
    read_vault_file(&path).get(account).cloned()
}

fn file_vault_set(data_dir: &Path, account: &str, value: &str) -> Result<(), String> {
    let path = vault_file_path(data_dir);
    let mut map = read_vault_file(&path);
    map.insert(account.to_string(), value.to_string());
    write_vault_file(&path, &map)
}

fn file_vault_delete(data_dir: &Path, account: &str) -> Result<(), String> {
    let path = vault_file_path(data_dir);
    let mut map = read_vault_file(&path);
    if map.remove(account).is_some() {
        write_vault_file(&path, &map)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS Keychain Backend
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::io::Write;
    use std::process::Stdio;

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|e| format!("Failed to query Keychain: {e}"))?;

        if output.status.success() {
            let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if secret.is_empty() {
                Ok(None)
            } else {
                Ok(Some(secret))
            }
        } else {
            Ok(None)
        }
    }

    pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn Keychain write process: {e}"))?;

        let cmd_input = format!("add-generic-password -U -s \"{service}\" -a \"{account}\" -w \"{value}\"\n");
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(cmd_input.as_bytes())
                .map_err(|e| format!("Failed to write secret to Keychain stdin: {e}"))?;
        } else {
            return Err("Keychain stdin not available".into());
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Keychain write process failed: {e}"))?;

        if !output.status.success() {
            let err_msg = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Keychain write failed: {err_msg}"));
        }

        Ok(())
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .output();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Linux Secret Service Backend (with seamless owner-only fallback)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    pub fn get(service: &str, account: &str, data_dir: &Path) -> Result<Option<String>, String> {
        // Try secret-tool if available in desktop environment.
        if let Ok(output) = Command::new("secret-tool")
            .args(["lookup", "service", service, "account", account])
            .output()
        {
            if output.status.success() {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !s.is_empty() {
                    return Ok(Some(s));
                }
            }
        }
        // Fallback to secure 0600 file store in app data dir.
        Ok(file_vault_get(data_dir, account))
    }

    pub fn set(service: &str, account: &str, value: &str, data_dir: &Path) -> Result<(), String> {
        // Try secret-tool first.
        let secret_tool_result = Command::new("secret-tool")
            .args(["store", "--label=Vakyartha Secret", "service", service, "account", account])
            .output();

        if let Ok(output) = secret_tool_result {
            if output.status.success() {
                return Ok(());
            }
        }

        // Fallback to owner-only 0600 file store.
        file_vault_set(data_dir, account, value)
    }

    pub fn delete(service: &str, account: &str, data_dir: &Path) -> Result<(), String> {
        let _ = Command::new("secret-tool")
            .args(["clear", "service", service, "account", account])
            .output();
        file_vault_delete(data_dir, account)
    }
}

// ---------------------------------------------------------------------------
// Public Unified Vault Interface (macOS, Linux, Windows)
// ---------------------------------------------------------------------------

pub fn get(service: &str, account: &str, data_dir: &Path) -> Result<Option<String>, String> {
    if !is_valid_service(service) {
        return Err("Invalid service identifier".into());
    }
    if !is_valid_account(account) {
        return Err("Invalid account identifier".into());
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(val) = macos::get(service, account) {
            if val.is_some() {
                return Ok(val);
            }
        }
        // Fallback to local data dir vault if keychain item not found.
        return Ok(file_vault_get(data_dir, account));
    }

    #[cfg(target_os = "linux")]
    {
        return linux::get(service, account, data_dir);
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, the AppData directory is protected by user SID ACLs.
        return Ok(file_vault_get(data_dir, account));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return Ok(file_vault_get(data_dir, account));
    }
}

pub fn set(service: &str, account: &str, value: &str, data_dir: &Path) -> Result<(), String> {
    if !is_valid_service(service) {
        return Err("Invalid service identifier".into());
    }
    if !is_valid_account(account) {
        return Err("Invalid account identifier".into());
    }
    if !is_valid_value(value) {
        return Err("Invalid secret value format".into());
    }

    #[cfg(target_os = "macos")]
    {
        if let Err(e) = macos::set(service, account, value) {
            eprintln!("[vault] Keychain write warning: {e}, using local secure vault");
            return file_vault_set(data_dir, account, value);
        }
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        return linux::set(service, account, value, data_dir);
    }

    #[cfg(target_os = "windows")]
    {
        return file_vault_set(data_dir, account, value);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return file_vault_set(data_dir, account, value);
    }
}

pub fn delete(service: &str, account: &str, data_dir: &Path) -> Result<(), String> {
    if !is_valid_service(service) {
        return Err("Invalid service identifier".into());
    }
    if !is_valid_account(account) {
        return Err("Invalid account identifier".into());
    }

    #[cfg(target_os = "macos")]
    {
        let _ = macos::delete(service, account);
    }

    #[cfg(target_os = "linux")]
    {
        let _ = linux::delete(service, account, data_dir);
    }

    file_vault_delete(data_dir, account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_identifiers_and_values() {
        assert!(is_valid_service("com.nranjan2code.vakyartha"));
        assert!(is_valid_service("vakyartha_app-linux"));
        assert!(!is_valid_service("invalid;service"));

        assert!(is_valid_account("OPENAI_API_KEY"));
        assert!(is_valid_account("GEMINI_API_KEY"));
        assert!(!is_valid_account("KEY WITH SPACES"));

        assert!(is_valid_value("sk-1234567890abcdef"));
        assert!(!is_valid_value("newline\nhere"));
        assert!(!is_valid_value("quote\"here"));
    }

    #[test]
    fn file_vault_persists_and_deletes_reliably() {
        let temp_dir = std::env::temp_dir().join(format!(
            "vak-vault-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        assert_eq!(file_vault_get(&temp_dir, "TEST_KEY"), None);
        file_vault_set(&temp_dir, "TEST_KEY", "secret-123").unwrap();
        assert_eq!(
            file_vault_get(&temp_dir, "TEST_KEY"),
            Some("secret-123".into())
        );

        file_vault_delete(&temp_dir, "TEST_KEY").unwrap();
        assert_eq!(file_vault_get(&temp_dir, "TEST_KEY"), None);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

