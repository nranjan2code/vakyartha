// Cross-platform credential vault for the indestructible Rust engine.
// Supports macOS (Keychain), Linux (Secret Service / owner-only 0600 store),
// and Windows (user-isolated app data vault).
// Input validation guarantees that account names, service names, and values
// cannot inject commands, escape boundaries, or contain malformed control characters.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "linux")]
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    crate::private_store::root(data_dir).join(".vault.secrets")
}

fn read_vault_file(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(map),
        Err(error) => return Err(format!("Failed to read vault file: {error}")),
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
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
    Ok(map)
}

fn write_vault_file(path: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    let mut content = String::new();
    for (k, v) in map {
        content.push_str(&format!("{k}={v}\n"));
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Vault file has no parent directory".to_string())?;
    let mut temp = None;
    for _ in 0..8 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".vault-{}-{sequence}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&temp_path) {
            Ok(file) => {
                temp = Some((temp_path, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create a private vault temp file: {error}"
                ));
            }
        }
    }
    let (temp_path, mut file) =
        temp.ok_or_else(|| "Failed to allocate a unique vault temp file".to_string())?;

    let result = (|| {
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write vault temp file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync vault temp file: {e}"))?;
        drop(file);
        std::fs::rename(&temp_path, path)
            .map_err(|e| format!("Failed to commit vault file: {e}"))?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("Failed to sync vault directory: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp_path);
    }
    result
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Secret reads are reserved for the native credential broker, which is not wired yet"
    )
)]
fn file_vault_get(data_dir: &Path, account: &str) -> Result<Option<String>, String> {
    ensure_vault_root(data_dir)?;
    let path = vault_file_path(data_dir);
    Ok(read_vault_file(&path)?.get(account).cloned())
}

fn ensure_vault_root(data_dir: &Path) -> Result<(), String> {
    let root = crate::private_store::root(data_dir);
    crate::private_store::ensure_root(&root)
        .map_err(|error| format!("Failed to prepare private vault directory: {error}"))
}

fn file_vault_set(data_dir: &Path, account: &str, value: &str) -> Result<(), String> {
    ensure_vault_root(data_dir)?;
    let path = vault_file_path(data_dir);
    let mut map = read_vault_file(&path)?;
    map.insert(account.to_string(), value.to_string());
    write_vault_file(&path, &map)
}

fn file_vault_delete(data_dir: &Path, account: &str) -> Result<(), String> {
    ensure_vault_root(data_dir)?;
    let path = vault_file_path(data_dir);
    let mut map = read_vault_file(&path)?;
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
            let secret = String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(['\r', '\n'])
                .to_string();
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

        let cmd_input =
            format!("add-generic-password -U -s \"{service}\" -a \"{account}\" -w \"{value}\"\n");
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

    pub(super) fn store_with_secret_tool(
        tool: &Path,
        service: &str,
        account: &str,
        value: &str,
    ) -> bool {
        let Ok(mut child) = Command::new(tool)
            .args([
                "store",
                "--label=Vakyartha Secret",
                "service",
                service,
                "account",
                account,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.wait();
            return false;
        };
        let write_ok = stdin.write_all(value.as_bytes()).is_ok();
        drop(stdin);
        let command_ok = child.wait().is_ok_and(|status| status.success());
        write_ok && command_ok
    }

    pub(super) fn clear_with_secret_tool(
        tool: &Path,
        service: &str,
        account: &str,
    ) -> Result<(), String> {
        match Command::new(tool)
            .args(["clear", "service", service, "account", account])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err("Secret Service refused to clear the stored credential".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Could not clear the Secret Service credential: {error}"
            )),
        }
    }

    pub fn get(service: &str, account: &str, data_dir: &Path) -> Result<Option<String>, String> {
        // Try secret-tool if available in desktop environment.
        if let Ok(output) = Command::new("secret-tool")
            .args(["lookup", "service", service, "account", account])
            .output()
            && output.status.success()
        {
            let s = String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(['\r', '\n'])
                .to_string();
            if !s.is_empty() {
                return Ok(Some(s));
            }
        }
        // Fallback to secure 0600 file store in app data dir.
        file_vault_get(data_dir, account)
    }

    pub fn set(service: &str, account: &str, value: &str, data_dir: &Path) -> Result<(), String> {
        if store_with_secret_tool(Path::new("secret-tool"), service, account, value) {
            return Ok(());
        }

        // Fallback to owner-only 0600 file store.
        file_vault_set(data_dir, account, value)
    }

    pub fn delete(service: &str, account: &str, data_dir: &Path) -> Result<(), String> {
        let service_result = clear_with_secret_tool(Path::new("secret-tool"), service, account);
        let file_result = file_vault_delete(data_dir, account);
        service_result.and(file_result)
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
        if let Ok(val) = macos::get(service, account)
            && val.is_some()
        {
            return Ok(val);
        }
        // Fallback to local data dir vault if keychain item not found.
        file_vault_get(data_dir, account)
    }

    #[cfg(target_os = "linux")]
    {
        linux::get(service, account, data_dir)
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, the AppData directory is protected by user SID ACLs.
        file_vault_get(data_dir, account)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        file_vault_get(data_dir, account)
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
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        linux::set(service, account, value, data_dir)
    }

    #[cfg(target_os = "windows")]
    {
        file_vault_set(data_dir, account, value)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        file_vault_set(data_dir, account, value)
    }
}

pub fn delete(service: &str, account: &str, data_dir: &Path) -> Result<(), String> {
    if !is_valid_service(service) {
        return Err("Invalid service identifier".into());
    }
    if !is_valid_account(account) {
        return Err("Invalid account identifier".into());
    }

    #[cfg(target_os = "linux")]
    {
        linux::delete(service, account, data_dir)
    }

    #[cfg(not(target_os = "linux"))]
    {
        #[cfg(target_os = "macos")]
        let _ = macos::delete(service, account);
        file_vault_delete(data_dir, account)
    }
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
        let temp_root = std::env::temp_dir().join(format!(
            "vak-vault-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();
        let temp_dir = temp_root.join("data");
        std::fs::create_dir(&temp_dir).unwrap();
        let legacy_path = temp_dir.join(".vault.secrets");
        let legacy_bytes = b"TEST_KEY=legacy-value\n";
        std::fs::write(&legacy_path, legacy_bytes).unwrap();

        assert_eq!(file_vault_get(&temp_dir, "TEST_KEY").unwrap(), None);
        file_vault_set(&temp_dir, "TEST_KEY", "secret-123").unwrap();
        assert!(!vault_file_path(&temp_dir).starts_with(&temp_dir));
        assert_eq!(std::fs::read(&legacy_path).unwrap(), legacy_bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(crate::private_store::root(&temp_dir))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert_eq!(
            file_vault_get(&temp_dir, "TEST_KEY").unwrap(),
            Some("secret-123".into())
        );
        file_vault_set(&temp_dir, "SPACED_KEY", "  secret with spaces  ").unwrap();
        assert_eq!(
            file_vault_get(&temp_dir, "SPACED_KEY").unwrap(),
            Some("  secret with spaces  ".into())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let mode = std::fs::metadata(vault_file_path(&temp_dir))
                .unwrap()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        file_vault_delete(&temp_dir, "TEST_KEY").unwrap();
        assert_eq!(file_vault_get(&temp_dir, "TEST_KEY").unwrap(), None);

        let vault_path = vault_file_path(&temp_dir);
        let corrupt = b"not valid utf-8: \xff\n";
        std::fs::write(&vault_path, corrupt).unwrap();
        assert!(file_vault_set(&temp_dir, "ANOTHER_KEY", "value").is_err());
        assert_eq!(std::fs::read(vault_path).unwrap(), corrupt);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_service_store_receives_exact_value_on_stdin() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = std::env::temp_dir().join(format!(
            "vak-secret-tool-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let tool = temp_dir.join("secret-tool");
        let received = temp_dir.join("received");
        let script = r#"#!/bin/sh
printf '%s\n' "$@" > "$(dirname "$0")/arguments"
cat > "$(dirname "$0")/received"
"#;
        std::fs::write(&tool, script).unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(linux::store_with_secret_tool(
            &tool,
            "com.example.vakyartha",
            "OPENAI_API_KEY",
            "  test secret  "
        ));
        assert_eq!(std::fs::read(&received).unwrap(), b"  test secret  ");
        let arguments = std::fs::read_to_string(temp_dir.join("arguments")).unwrap();
        assert!(!arguments.contains("test secret"));
        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_service_delete_reports_refusal_and_allows_missing_command() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = std::env::temp_dir().join(format!(
            "vak-secret-delete-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let success_tool = temp_dir.join("success-tool");
        let failure_tool = temp_dir.join("failure-tool");
        std::fs::write(&success_tool, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::write(&failure_tool, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&success_tool, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&failure_tool, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(
            linux::clear_with_secret_tool(&success_tool, "com.example.vakyartha", "OPENAI_API_KEY")
                .is_ok()
        );
        assert!(
            linux::clear_with_secret_tool(&failure_tool, "com.example.vakyartha", "OPENAI_API_KEY")
                .is_err()
        );
        assert!(
            linux::clear_with_secret_tool(
                &temp_dir.join("missing-tool"),
                "com.example.vakyartha",
                "OPENAI_API_KEY"
            )
            .is_ok()
        );
        std::fs::remove_dir_all(temp_dir).unwrap();
    }
}
