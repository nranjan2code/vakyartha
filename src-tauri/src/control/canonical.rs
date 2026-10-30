//! Bounded opaque canonical snapshot files. The actor's selected control
//! generation owns the revision pointer; these files are immutable payloads.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalSessionRecord {
    pub root_id: String,
    pub revision: u64,
    pub previous_revision: Option<u64>,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCommitReceipt {
    pub commit_id: String,
    pub session_id: String,
    pub root_id: String,
    pub root_revision: u64,
    pub contract_revision: u64,
    pub cancellation_epoch: u64,
    pub expected_canonical_revision: u64,
    pub canonical_revision: u64,
    pub digest: String,
    pub request_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateCommitRequest {
    pub session_id: String,
    pub commit_id: String,
    pub fence: super::state::ExecutionFence,
    pub expected_canonical_revision: u64,
    pub candidate_bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CanonicalStoreError {
    InvalidIdentity,
    InvalidCandidate,
    TooLarge,
    Conflict,
    Corrupt,
    Io(String),
    UnsupportedDurability,
}

impl CandidateCommitRequest {
    pub(super) fn validate(&self) -> Result<(), CanonicalStoreError> {
        if !valid_identity(&self.session_id) || !valid_identity(&self.commit_id) {
            return Err(CanonicalStoreError::InvalidIdentity);
        }
        if self.candidate_bytes.is_empty() || self.candidate_bytes.len() > MAX_CANDIDATE_BYTES {
            return Err(CanonicalStoreError::TooLarge);
        }
        let value: serde_json::Value = serde_json::from_slice(&self.candidate_bytes)
            .map_err(|_| CanonicalStoreError::InvalidCandidate)?;
        if !value.is_object() || !valid_identity(self.fence.root_id()) {
            return Err(CanonicalStoreError::InvalidCandidate);
        }
        Ok(())
    }

    pub(super) fn fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(b"vakyartha-canonical-candidate-commit-v1\0");
        let root_revision = self.fence.root_revision().to_be_bytes();
        let contract_revision = self.fence.contract_revision().to_be_bytes();
        let cancellation_epoch = self.fence.cancellation_epoch().to_be_bytes();
        let canonical_revision = self.expected_canonical_revision.to_be_bytes();
        for part in [
            self.session_id.as_bytes(),
            self.commit_id.as_bytes(),
            self.fence.root_id().as_bytes(),
            root_revision.as_slice(),
            contract_revision.as_slice(),
            cancellation_epoch.as_slice(),
            canonical_revision.as_slice(),
            self.candidate_bytes.as_slice(),
        ] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part);
        }
        let bytes: [u8; 32] = hash.finalize().into();
        hex(&bytes)
    }
}

pub(super) struct CanonicalContentStore {
    root: PathBuf,
}

impl CanonicalContentStore {
    pub(super) fn open(
        data_dir: &Path,
        sessions: &BTreeMap<String, CanonicalSessionRecord>,
    ) -> Result<Self, CanonicalStoreError> {
        Self::open_namespace(data_dir, sessions, "sessions")
    }

    pub(super) fn open_publications(
        data_dir: &Path,
        sessions: &BTreeMap<String, CanonicalSessionRecord>,
    ) -> Result<Self, CanonicalStoreError> {
        Self::open_namespace(data_dir, sessions, "publications")
    }

    fn open_namespace(
        data_dir: &Path,
        sessions: &BTreeMap<String, CanonicalSessionRecord>,
        namespace: &str,
    ) -> Result<Self, CanonicalStoreError> {
        if sessions.len() > MAX_SESSIONS
            || sessions.iter().any(|(id, record)| {
                !valid_identity(id)
                    || !valid_identity(&record.root_id)
                    || record.revision == 0
                    || record.digest.len() != 64
                    || !record.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || record
                        .previous_revision
                        .is_some_and(|previous| previous == 0 || previous >= record.revision)
            })
        {
            return Err(CanonicalStoreError::Corrupt);
        }
        let content = data_dir.join("content");
        ensure_private_dir(&content)?;
        let root = content.join(namespace);
        ensure_private_dir(&root)?;
        let store = Self { root };
        store.recover(sessions)?;
        Ok(store)
    }

    pub(super) fn write_candidate(
        &self,
        session_id: &str,
        revision: u64,
        bytes: &[u8],
    ) -> Result<String, CanonicalStoreError> {
        if !valid_identity(session_id) || revision == 0 {
            return Err(CanonicalStoreError::InvalidIdentity);
        }
        if bytes.is_empty() || bytes.len() > MAX_CANDIDATE_BYTES {
            return Err(CanonicalStoreError::TooLarge);
        }
        let parsed: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| CanonicalStoreError::InvalidCandidate)?;
        if !parsed.is_object() {
            return Err(CanonicalStoreError::InvalidCandidate);
        }
        let dir = self.session_dir(session_id);
        ensure_private_dir(&dir)?;
        let path = generation_path(&dir, revision);
        let digest = digest(bytes);
        if path.exists() {
            let existing = read_bounded(&path)?;
            return if existing == bytes {
                Ok(digest)
            } else {
                Err(CanonicalStoreError::Conflict)
            };
        }
        let temporary = write_temp_synced(&dir, bytes)?;
        rename_new(&temporary, &path).map_err(io_error)?;
        sync_directory(&dir)?;
        Ok(digest)
    }

    pub(super) fn verify_current(
        &self,
        session_id: &str,
        record: &CanonicalSessionRecord,
    ) -> Result<Vec<u8>, CanonicalStoreError> {
        if !valid_identity(session_id) {
            return Err(CanonicalStoreError::InvalidIdentity);
        }
        let bytes = read_bounded(&generation_path(
            &self.session_dir(session_id),
            record.revision,
        ))?;
        if digest(&bytes) != record.digest {
            return Err(CanonicalStoreError::Corrupt);
        }
        Ok(bytes)
    }

    pub(super) fn cleanup(
        &self,
        sessions: &BTreeMap<String, CanonicalSessionRecord>,
    ) -> Result<(), CanonicalStoreError> {
        self.recover(sessions)
    }

    fn recover(
        &self,
        sessions: &BTreeMap<String, CanonicalSessionRecord>,
    ) -> Result<(), CanonicalStoreError> {
        for (id, record) in sessions {
            self.verify_current(id, record)?;
            if let Some(previous) = record.previous_revision {
                read_bounded(&generation_path(&self.session_dir(id), previous))?;
            }
        }
        let entries = fs::read_dir(&self.root).map_err(io_error)?;
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_identity(&name) {
                return Err(CanonicalStoreError::Corrupt);
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
            if !metadata.file_type().is_dir() {
                return Err(CanonicalStoreError::Corrupt);
            }
            let Some(record) = sessions.get(&name) else {
                fs::remove_dir_all(entry.path()).map_err(io_error)?;
                sync_directory(&self.root)?;
                continue;
            };
            let keep = [Some(record.revision), record.previous_revision]
                .into_iter()
                .flatten()
                .collect::<std::collections::BTreeSet<_>>();
            let files = fs::read_dir(entry.path()).map_err(io_error)?;
            let mut changed = false;
            for file in files {
                let file = file.map_err(io_error)?;
                let file_name = file.file_name().to_string_lossy().into_owned();
                let Some(revision) = parse_generation(&file_name) else {
                    if is_owned_temp(&file_name) {
                        fs::remove_file(file.path()).map_err(io_error)?;
                        changed = true;
                        continue;
                    }
                    return Err(CanonicalStoreError::Corrupt);
                };
                let metadata = fs::symlink_metadata(file.path()).map_err(io_error)?;
                if !metadata.file_type().is_file() {
                    return Err(CanonicalStoreError::Corrupt);
                }
                if !keep.contains(&revision) {
                    fs::remove_file(file.path()).map_err(io_error)?;
                    changed = true;
                }
            }
            if changed {
                sync_directory(&entry.path())?;
            }
        }
        Ok(())
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.root.join(session_id)
    }
}

pub(super) fn validate_identity(value: &str) -> bool {
    valid_identity(value)
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn hex(value: &[u8; 32]) -> String {
    let mut output = String::with_capacity(64);
    for byte in value {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn generation_path(dir: &Path, revision: u64) -> PathBuf {
    dir.join(format!("generation-{revision:020}.json"))
}

fn parse_generation(name: &str) -> Option<u64> {
    let value = name.strip_prefix("generation-")?.strip_suffix(".json")?;
    (value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())?
}

fn is_owned_temp(name: &str) -> bool {
    name.strip_prefix(".candidate-")
        .and_then(|value| value.strip_suffix(".tmp"))
        .is_some_and(|value| {
            let mut parts = value.split('-');
            parts.next().is_some_and(|part| {
                !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
            }) && parts.next().is_some_and(|part| {
                !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
            }) && parts.next().is_none()
        })
}

fn ensure_private_dir(path: &Path) -> Result<(), CanonicalStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(CanonicalStoreError::Corrupt),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(CanonicalStoreError::Corrupt)?;
            fs::create_dir(path).map_err(io_error)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
            }
            sync_directory(parent)?;
        }
        Err(error) => return Err(io_error(error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    }
    Ok(())
}

fn write_temp_synced(dir: &Path, bytes: &[u8]) -> Result<PathBuf, CanonicalStoreError> {
    for _ in 0..32 {
        let sequence = super::TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = dir.join(format!(".candidate-{}-{sequence}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(error)),
        }
    }
    Err(CanonicalStoreError::Io(
        "canonical candidate temp namespace is exhausted".into(),
    ))
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, CanonicalStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_CANDIDATE_BYTES as u64
    {
        return Err(CanonicalStoreError::Corrupt);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(io_error)?
        .take(MAX_CANDIDATE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_CANDIDATE_BYTES {
        return Err(CanonicalStoreError::Corrupt);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::hard_link(from, to)?;
    fs::remove_file(from)
}

#[cfg(windows)]
fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), CanonicalStoreError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(io_error)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), CanonicalStoreError> {
    Err(CanonicalStoreError::UnsupportedDurability)
}

fn io_error(error: std::io::Error) -> CanonicalStoreError {
    CanonicalStoreError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("vak-canonical-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn opaque_candidate_is_bounded_exact_and_generation_owned() {
        let temp = root();
        let store = CanonicalContentStore::open(&temp, &BTreeMap::new()).unwrap();
        let bytes = br#"{"session":"session-1","surfaces":[{"id":"one"}]}"#;
        let digest = store.write_candidate("session-1", 1, bytes).unwrap();
        assert_eq!(
            store.verify_current(
                "session-1",
                &CanonicalSessionRecord {
                    root_id: "root-1".into(),
                    revision: 1,
                    previous_revision: None,
                    digest: digest.clone(),
                }
            ),
            Ok(bytes.to_vec())
        );
        assert_eq!(
            store.write_candidate("session-1", 1, bytes).unwrap(),
            digest
        );
        assert_eq!(
            store.write_candidate("session-1", 1, b"{\"other\":true}"),
            Err(CanonicalStoreError::Conflict)
        );
        assert_eq!(
            store.write_candidate("../escape", 1, bytes),
            Err(CanonicalStoreError::InvalidIdentity)
        );
        assert_eq!(
            store.write_candidate("session-1", 2, &vec![b'x'; MAX_CANDIDATE_BYTES + 1]),
            Err(CanonicalStoreError::TooLarge)
        );
        drop(store);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn recovery_keeps_current_and_previous_and_removes_unselected_generations() {
        let temp = root();
        let store = CanonicalContentStore::open(&temp, &BTreeMap::new()).unwrap();
        let first = br#"{"revision":1}"#;
        let second = br#"{"revision":2}"#;
        let third = br#"{"revision":3}"#;
        let d1 = store.write_candidate("session-1", 1, first).unwrap();
        let d2 = store.write_candidate("session-1", 2, second).unwrap();
        store.write_candidate("session-1", 3, third).unwrap();
        let selected = BTreeMap::from([(
            "session-1".into(),
            CanonicalSessionRecord {
                root_id: "root-1".into(),
                revision: 2,
                previous_revision: Some(1),
                digest: d2,
            },
        )]);
        store.cleanup(&selected).unwrap();
        assert!(generation_path(&store.session_dir("session-1"), 1).exists());
        assert!(generation_path(&store.session_dir("session-1"), 2).exists());
        assert!(!generation_path(&store.session_dir("session-1"), 3).exists());
        assert_eq!(d1, digest(first));
        drop(store);
        fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn selected_symlink_or_digest_mismatch_fails_closed() {
        let temp = root();
        let store = CanonicalContentStore::open(&temp, &BTreeMap::new()).unwrap();
        let bytes = br#"{"revision":1}"#;
        let digest = store.write_candidate("session-1", 1, bytes).unwrap();
        let record = CanonicalSessionRecord {
            root_id: "root-1".into(),
            revision: 1,
            previous_revision: None,
            digest,
        };
        let path = generation_path(&store.session_dir("session-1"), 1);
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", &path).unwrap();
        assert_eq!(
            store.verify_current("session-1", &record),
            Err(CanonicalStoreError::Corrupt)
        );
        drop(store);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reopening_with_a_corrupt_selected_generation_fails_closed() {
        let temp = root();
        let store = CanonicalContentStore::open(&temp, &BTreeMap::new()).unwrap();
        let bytes = br#"{"revision":1}"#;
        let digest = store.write_candidate("session-1", 1, bytes).unwrap();
        let selected = BTreeMap::from([(
            "session-1".into(),
            CanonicalSessionRecord {
                root_id: "root-1".into(),
                revision: 1,
                previous_revision: None,
                digest,
            },
        )]);
        fs::write(generation_path(&store.session_dir("session-1"), 1), b"{}").unwrap();
        drop(store);
        assert_eq!(
            CanonicalContentStore::open(&temp, &selected).err(),
            Some(CanonicalStoreError::Corrupt)
        );
        fs::remove_dir_all(temp).unwrap();
    }
}
