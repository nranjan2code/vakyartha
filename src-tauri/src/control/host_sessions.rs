//! Native-owned durable chat snapshots. The control actor is the only caller;
//! selected session admission is checked at the actor boundary before I/O.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};

const FORMAT: u8 = 1;
const MAX_SESSION_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub updated: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMigrationPlan {
    pub session_count: usize,
    pub bytes: u64,
    pub source_digest: String,
    pub already_migrated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMigrationReceipt {
    pub imported: usize,
    pub already_present: usize,
    pub bytes: u64,
    pub source_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredSession {
    format: u8,
    revision: u64,
    snapshot: Value,
}

struct LegacyScan {
    records: Vec<(String, Value)>,
    bytes: u64,
    digest: String,
}

pub(super) struct HostSessionStore {
    root: PathBuf,
    legacy_dir: PathBuf,
    summaries: BTreeMap<String, SessionSummary>,
    migration_receipt: Option<SessionMigrationReceipt>,
}

impl HostSessionStore {
    pub(super) fn open(data_dir: &Path) -> Result<Self, super::StoreError> {
        let native_root = super::native_store_root(data_dir);
        crate::private_store::ensure_root(&native_root).map_err(super::store_io)?;
        let root = native_root.join("host-sessions");
        ensure_private_dir(&root)?;
        let mut store = Self { root, legacy_dir: data_dir.join("sessions"), summaries: BTreeMap::new(), migration_receipt: None };
        store.recover()?;
        Ok(store)
    }

    pub(super) fn plan_legacy_import(&self) -> Result<SessionMigrationPlan, super::StoreError> {
        if let Some(receipt) = &self.migration_receipt {
            return Ok(SessionMigrationPlan {
                session_count: receipt.imported + receipt.already_present,
                bytes: receipt.bytes,
                source_digest: receipt.source_digest.clone(),
                already_migrated: true,
            });
        }
        let scan = scan_legacy(&self.legacy_dir)?;
        Ok(SessionMigrationPlan { session_count: scan.records.len(), bytes: scan.bytes, source_digest: scan.digest, already_migrated: false })
    }

    pub(super) fn migrate_legacy(&mut self, expected_digest: &str) -> Result<SessionMigrationReceipt, super::StoreError> {
        if let Some(receipt) = &self.migration_receipt {
            return Ok(receipt.clone());
        }
        let scan = scan_legacy(&self.legacy_dir)?;
        if scan.digest != expected_digest { return Err(super::StoreError::SessionMigrationConflict); }
        let mut imported = 0;
        let mut already_present = 0;
        for (id, snapshot) in scan.records {
            if self.summaries.contains_key(&id) {
                already_present += 1;
            } else {
                self.save(&id, 0, snapshot)?;
                imported += 1;
            }
        }
        let receipt = SessionMigrationReceipt { imported, already_present, bytes: scan.bytes, source_digest: scan.digest };
        let stored = serde_json::to_vec(&receipt).map_err(|_| super::StoreError::Corrupt)?;
        let temp = super::write_temp_synced(&self.root, "host-session-migration", &stored)?;
        if let Err(error) = super::replace_file(&temp, &self.root.join("legacy-import-v1.json")) {
            let _ = fs::remove_file(&temp);
            return Err(super::store_io(error));
        }
        super::sync_directory(&self.root)?;
        self.migration_receipt = Some(receipt.clone());
        Ok(receipt)
    }

    pub(super) fn load(&self, id: &str) -> Result<Option<(u64, Value)>, super::StoreError> {
        if !super::valid_identity(id) { return Err(super::StoreError::Corrupt); }
        let path = self.path(id);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return if self.summaries.contains_key(id) { Err(super::StoreError::Corrupt) } else { Ok(None) };
            }
            Err(error) => return Err(super::store_io(error)),
            Ok(metadata) if !metadata.file_type().is_file() => return Err(super::StoreError::Corrupt),
            Ok(_) => {}
        }
        let stored = read_record(&path)?;
        let summary = validate_snapshot(id, &stored.snapshot)?;
        if self.summaries.get(id) != Some(&summary) { return Err(super::StoreError::Corrupt); }
        Ok(Some((stored.revision, stored.snapshot)))
    }

    pub(super) fn save(&mut self, id: &str, expected: u64, snapshot: Value) -> Result<u64, super::StoreError> {
        if !super::valid_identity(id) { return Err(super::StoreError::Corrupt); }
        let summary = validate_snapshot(id, &snapshot)?;
        let current = self.summaries.get(id).map(|_| self.read_revision(id)).transpose()?.unwrap_or(0);
        if current != expected { return Err(super::StoreError::SessionRevisionConflict); }
        if current == u64::MAX { return Err(super::StoreError::Corrupt); }
        if self.summaries.len() >= MAX_SESSIONS && current == 0 { return Err(super::StoreError::TooLarge); }
        let revision = current + 1;
        let bytes = serde_json::to_vec(&StoredSession { format: FORMAT, revision, snapshot }).map_err(|_| super::StoreError::Corrupt)?;
        if bytes.len() > MAX_SESSION_BYTES { return Err(super::StoreError::TooLarge); }
        let temp = super::write_temp_synced(&self.root, "host-session", &bytes)?;
        if let Err(error) = super::replace_file(&temp, &self.path(id)) {
            let _ = fs::remove_file(&temp);
            return Err(super::store_io(error));
        }
        super::sync_directory(&self.root)?;
        self.summaries.insert(id.to_owned(), summary);
        Ok(revision)
    }

    pub(super) fn list(&self) -> Vec<SessionSummary> {
        self.summaries.values().cloned().collect()
    }

    pub(super) fn remove(&mut self, id: &str, expected: Option<u64>) -> Result<(), super::StoreError> {
        if !super::valid_identity(id) { return Err(super::StoreError::Corrupt); }
        let current = self.summaries.get(id).map(|_| self.read_revision(id)).transpose()?;
        match (current, expected) {
            (None, None) => return Ok(()),
            (Some(current), Some(expected)) if current == expected => {}
            _ => return Err(super::StoreError::SessionRevisionConflict),
        }
        fs::remove_file(self.path(id)).map_err(super::store_io)?;
        super::sync_directory(&self.root)?;
        self.summaries.remove(id);
        Ok(())
    }

    fn read_revision(&self, id: &str) -> Result<u64, super::StoreError> {
        let stored = read_record(&self.path(id))?;
        let summary = validate_snapshot(id, &stored.snapshot)?;
        if self.summaries.get(id) != Some(&summary) { return Err(super::StoreError::Corrupt); }
        Ok(stored.revision)
    }

    fn path(&self, id: &str) -> PathBuf { self.root.join(format!("session-{id}.json")) }

    fn recover(&mut self) -> Result<(), super::StoreError> {
        let mut removed_temp = false;
        for entry in fs::read_dir(&self.root).map_err(super::store_io)? {
            let entry = entry.map_err(super::store_io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = fs::symlink_metadata(entry.path()).map_err(super::store_io)?;
            if !meta.file_type().is_file() { return Err(super::StoreError::Corrupt); }
            if is_temp(&name) {
                fs::remove_file(entry.path()).map_err(super::store_io)?;
                removed_temp = true;
                continue;
            }
            if name == "legacy-import-v1.json" {
                let bytes = read_bounded(&entry.path(), 64 * 1024)?;
                let receipt: SessionMigrationReceipt = serde_json::from_slice(&bytes).map_err(|_| super::StoreError::Corrupt)?;
                if receipt.source_digest.len() != 64
                    || !receipt.source_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || receipt.imported.checked_add(receipt.already_present).is_none_or(|count| count > MAX_SESSIONS)
                {
                    return Err(super::StoreError::Corrupt);
                }
                self.migration_receipt = Some(receipt);
                continue;
            }
            let Some(id) = name.strip_prefix("session-").and_then(|v| v.strip_suffix(".json")) else {
                return Err(super::StoreError::Corrupt);
            };
            if !super::valid_identity(id) || self.summaries.len() >= MAX_SESSIONS { return Err(super::StoreError::Corrupt); }
            let record = read_record(&entry.path())?;
            let summary = validate_snapshot(id, &record.snapshot)?;
            if self.summaries.insert(id.to_owned(), summary).is_some() { return Err(super::StoreError::Corrupt); }
        }
        if removed_temp { super::sync_directory(&self.root)?; }
        Ok(())
    }
}

fn validate_snapshot(id: &str, snapshot: &Value) -> Result<SessionSummary, super::StoreError> {
    let Some(object) = snapshot.as_object() else { return Err(super::StoreError::Corrupt); };
    let string = |key: &str, limit: usize| -> Result<String, super::StoreError> {
        object.get(key).and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= limit)
            .map(str::to_owned).ok_or(super::StoreError::Corrupt)
    };
    if string("id", 120)? != id
        || !["messages", "timeline", "surfaces", "external"].iter().all(|key| object.get(*key).is_some_and(Value::is_array))
    { return Err(super::StoreError::Corrupt); }
    Ok(SessionSummary { id: id.to_owned(), title: string("title", 512)?, updated: string("updated", 64)? })
}

fn read_record(path: &Path) -> Result<StoredSession, super::StoreError> {
    let bytes = read_bounded(path, MAX_SESSION_BYTES)?;
    let stored: StoredSession = serde_json::from_slice(&bytes).map_err(|_| super::StoreError::Corrupt)?;
    if stored.format != FORMAT || stored.revision == 0 { return Err(super::StoreError::Corrupt); }
    Ok(stored)
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, super::StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(super::store_io)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > limit as u64 {
        return Err(super::StoreError::Corrupt);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path).map_err(super::store_io)?.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(super::store_io)?;
    if bytes.len() > limit { return Err(super::StoreError::TooLarge); }
    Ok(bytes)
}

fn scan_legacy(dir: &Path) -> Result<LegacyScan, super::StoreError> {
    let mut files = match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_dir() => fs::read_dir(dir).map_err(super::store_io)?.map(|entry| entry.map_err(super::store_io)).collect::<Result<Vec<_>, _>>()?,
        Ok(_) => return Err(super::StoreError::Corrupt),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(super::store_io(error)),
    };
    files.retain(|entry| entry.path().extension().is_some_and(|extension| extension == "json"));
    files.sort_by_key(|entry| entry.file_name());
    let mut hasher = Sha256::new();
    let mut total_bytes = 0u64;
    let mut sessions = Vec::with_capacity(files.len());
    let mut ids = std::collections::BTreeSet::new();
    for entry in files {
        let path = entry.path();
        let bytes = read_bounded(&path, MAX_SESSION_BYTES)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        hasher.update((name.len() as u64).to_be_bytes());
        hasher.update(name.as_bytes());
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(&bytes);
        total_bytes = total_bytes.checked_add(bytes.len() as u64).ok_or(super::StoreError::TooLarge)?;
        let snapshot: Value = serde_json::from_slice(&bytes).map_err(|_| super::StoreError::Corrupt)?;
        let id = snapshot.get("id").and_then(Value::as_str).ok_or(super::StoreError::Corrupt)?.to_owned();
        validate_snapshot(&id, &snapshot)?;
        if !ids.insert(id.clone()) { return Err(super::StoreError::Corrupt); }
        sessions.push((id, snapshot));
    }
    let digest = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    Ok(LegacyScan { records: sessions, bytes: total_bytes, digest })
}

fn is_temp(name: &str) -> bool {
    name.strip_prefix(".host-session-").and_then(|v| v.strip_suffix(".tmp")).is_some_and(|v| {
        let v = v.strip_prefix("migration-").unwrap_or(v);
        let mut parts = v.split('-');
        parts.next().is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            && parts.next().is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            && parts.next().is_none()
    })
}

fn ensure_private_dir(path: &Path) -> Result<(), super::StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err(super::StoreError::Corrupt),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(super::StoreError::Corrupt)?;
            fs::create_dir(path).map_err(super::store_io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(super::store_io)?;
            }
            super::sync_directory(parent)?;
        }
        Err(error) => return Err(super::store_io(error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(super::store_io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let name = format!("vak-host-session-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let path = std::env::temp_dir().join(name);
        fs::create_dir(&path).unwrap();
        path
    }

    fn snapshot(id: &str, title: &str) -> Value {
        serde_json::json!({"id":id,"title":title,"created":"2026-10-30T00:00:00.000Z","updated":"2026-10-30T00:00:01.000Z","messages":[],"timeline":[],"surfaces":[],"external":[]})
    }

    #[test]
    fn save_load_compare_and_set_list_remove_and_restart_are_consistent() {
        let dir = temp();
        let mut store = HostSessionStore::open(&dir).unwrap();
        assert_eq!(store.save("chat-1", 0, snapshot("chat-1", "first")), Ok(1));
        assert_eq!(store.save("chat-1", 0, snapshot("chat-1", "stale")), Err(super::super::StoreError::SessionRevisionConflict));
        assert_eq!(store.load("chat-1").unwrap(), Some((1, snapshot("chat-1", "first"))));
        assert_eq!(store.list(), vec![SessionSummary { id: "chat-1".into(), title: "first".into(), updated: "2026-10-30T00:00:01.000Z".into() }]);
        drop(store);

        let mut recovered = HostSessionStore::open(&dir).unwrap();
        assert_eq!(recovered.load("chat-1").unwrap(), Some((1, snapshot("chat-1", "first"))));
        assert_eq!(recovered.save("chat-1", 1, snapshot("chat-1", "second")), Ok(2));
        recovered.remove("chat-1", Some(2)).unwrap();
        assert_eq!(recovered.load("chat-1").unwrap(), None);
        assert!(recovered.list().is_empty());
    }

    #[test]
    fn corrupt_or_oversized_records_fail_closed() {
        let dir = temp();
        let store = HostSessionStore::open(&dir).unwrap();
        fs::write(store.path("bad"), b"not json").unwrap();
        assert!(matches!(HostSessionStore::open(&dir), Err(super::super::StoreError::Corrupt)));
    }

    #[test]
    fn legacy_import_is_dry_runnable_non_destructive_and_receipted() {
        let dir = temp();
        let legacy = dir.join("sessions");
        fs::create_dir(&legacy).unwrap();
        let bytes = serde_json::to_vec(&snapshot("chat-1", "preserved chat")).unwrap();
        fs::write(legacy.join("chat-1.json"), &bytes).unwrap();
        let mut store = HostSessionStore::open(&dir).unwrap();
        let plan = store.plan_legacy_import().unwrap();
        assert_eq!(plan.session_count, 1);
        assert_eq!(plan.bytes, bytes.len() as u64);
        assert!(!plan.already_migrated);
        assert_eq!(store.load("chat-1").unwrap(), None);

        let receipt = store.migrate_legacy(&plan.source_digest).unwrap();
        assert_eq!(receipt.imported, 1);
        assert_eq!(receipt.already_present, 0);
        assert_eq!(store.load("chat-1").unwrap(), Some((1, snapshot("chat-1", "preserved chat"))));
        assert_eq!(fs::read(legacy.join("chat-1.json")).unwrap(), bytes);
        assert!(store.plan_legacy_import().unwrap().already_migrated);
        assert_eq!(store.migrate_legacy(&plan.source_digest).unwrap(), receipt);
        fs::remove_file(legacy.join("chat-1.json")).unwrap();
        assert!(store.plan_legacy_import().unwrap().already_migrated);
    }
}
