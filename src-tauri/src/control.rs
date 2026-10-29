//! Pure native admission primitives. The app does not enable this ledger until
//! every protected workload is routed through the owning control actor.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const STORE_VERSION: u16 = 1;
const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Resource {
    Generation,
    ProviderRequest,
    ContainedProcess,
    IntegrationProcess,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    InvalidIdentity,
    InvalidProfile,
    CapacityUnavailable(Resource),
    RootLimit(Resource),
    ConflictingRequestIdentity,
    RequestAlreadySettled,
    RequestLedgerFull,
    UnknownLease,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CapacityProfile {
    global: BTreeMap<Resource, u32>,
    per_root: BTreeMap<Resource, u32>,
    max_request_identities: usize,
}

impl CapacityProfile {
    /// Profiles are explicit inputs; this module does not invent machine limits.
    pub fn new(
        global: BTreeMap<Resource, u32>,
        per_root: BTreeMap<Resource, u32>,
        max_request_identities: usize,
    ) -> Result<Self, AdmissionError> {
        if max_request_identities == 0
            || global.is_empty()
            || global.values().any(|limit| *limit == 0)
            || per_root.iter().any(|(resource, limit)| {
                *limit == 0
                    || global
                        .get(resource)
                        .is_none_or(|global_limit| limit > global_limit)
            })
        {
            return Err(AdmissionError::InvalidProfile);
        }
        Ok(Self {
            global,
            per_root,
            max_request_identities,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Lease {
    id: u64,
    request_id: String,
    root_id: String,
    amounts: BTreeMap<Resource, u32>,
}

impl Lease {
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn root_id(&self) -> &str {
        &self.root_id
    }
    pub fn amounts(&self) -> &BTreeMap<Resource, u32> {
        &self.amounts
    }
}

#[derive(Clone, Debug, Default)]
pub struct CapacityLedger {
    next_lease: u64,
    active: HashMap<u64, Lease>,
    issued: HashMap<u64, Lease>,
    request_ids: HashMap<String, u64>,
    used: BTreeMap<Resource, u32>,
    used_by_root: HashMap<String, BTreeMap<Resource, u32>>,
}

impl CapacityLedger {
    pub fn reserve(
        &mut self,
        profile: &CapacityProfile,
        request_id: &str,
        root_id: &str,
        amounts: BTreeMap<Resource, u32>,
    ) -> Result<Lease, AdmissionError> {
        if !valid_identity(request_id)
            || !valid_identity(root_id)
            || amounts.is_empty()
            || amounts.values().any(|amount| *amount == 0)
            || amounts
                .keys()
                .any(|resource| !profile.global.contains_key(resource))
        {
            return Err(AdmissionError::InvalidIdentity);
        }
        if let Some(existing_id) = self.request_ids.get(request_id) {
            let Some(existing) = self.active.get(existing_id) else {
                return Err(AdmissionError::RequestAlreadySettled);
            };
            if existing.root_id == root_id && existing.amounts == amounts {
                return Ok(existing.clone());
            }
            return Err(AdmissionError::ConflictingRequestIdentity);
        }
        if self.request_ids.len() >= profile.max_request_identities {
            return Err(AdmissionError::RequestLedgerFull);
        }

        let root_used = self.used_by_root.get(root_id);
        for (resource, amount) in &amounts {
            let global_limit = profile
                .global
                .get(resource)
                .copied()
                .ok_or(AdmissionError::InvalidProfile)?;
            if self
                .used
                .get(resource)
                .copied()
                .unwrap_or(0)
                .saturating_add(*amount)
                > global_limit
            {
                return Err(AdmissionError::CapacityUnavailable(*resource));
            }
            if let Some(root_limit) = profile.per_root.get(resource) {
                if root_used
                    .and_then(|used| used.get(resource))
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(*amount)
                    > *root_limit
                {
                    return Err(AdmissionError::RootLimit(*resource));
                }
            }
        }

        self.next_lease = self
            .next_lease
            .checked_add(1)
            .ok_or(AdmissionError::InvalidProfile)?;
        let lease = Lease {
            id: self.next_lease,
            request_id: request_id.to_owned(),
            root_id: root_id.to_owned(),
            amounts,
        };
        for (resource, amount) in &lease.amounts {
            *self.used.entry(*resource).or_default() += amount;
            *self
                .used_by_root
                .entry(root_id.to_owned())
                .or_default()
                .entry(*resource)
                .or_default() += amount;
        }
        self.request_ids.insert(request_id.to_owned(), lease.id);
        self.active.insert(lease.id, lease.clone());
        self.issued.insert(lease.id, lease.clone());
        Ok(lease)
    }

    /// Release only an issued lease; retries after a committed release are idempotent.
    pub fn release(&mut self, lease: &Lease) -> Result<(), AdmissionError> {
        let Some(issued) = self.issued.get(&lease.id) else {
            return Err(AdmissionError::UnknownLease);
        };
        if issued != lease {
            return Err(AdmissionError::UnknownLease);
        }
        let Some(active) = self.active.remove(&lease.id) else {
            return Ok(());
        };
        for (resource, amount) in &active.amounts {
            if let Some(used) = self.used.get_mut(resource) {
                *used -= amount;
            }
            if let Some(root) = self.used_by_root.get_mut(&active.root_id) {
                if let Some(used) = root.get_mut(resource) {
                    *used -= amount;
                    if *used == 0 {
                        root.remove(resource);
                    }
                }
                if root.is_empty() {
                    self.used_by_root.remove(&active.root_id);
                }
            }
        }
        Ok(())
    }

    pub fn active_leases(&self) -> usize {
        self.active.len()
    }

    fn snapshot(&self) -> LedgerSnapshot {
        let mut issued: Vec<_> = self.issued.values().cloned().collect();
        issued.sort_by_key(|lease| lease.id);
        let mut active_ids: Vec<_> = self.active.keys().copied().collect();
        active_ids.sort_unstable();
        LedgerSnapshot {
            next_lease: self.next_lease,
            issued,
            active_ids,
            request_ids: self
                .request_ids
                .iter()
                .map(|(id, lease)| (id.clone(), *lease))
                .collect(),
        }
    }

    fn restore(snapshot: LedgerSnapshot, profile: &CapacityProfile) -> Result<Self, StoreError> {
        if snapshot.request_ids.len() > profile.max_request_identities
            || snapshot.request_ids.iter().any(|(id, lease)| {
                !valid_identity(id) || *lease == 0 || *lease > snapshot.next_lease
            })
        {
            return Err(StoreError::Corrupt);
        }
        let mut ledger = Self {
            next_lease: snapshot.next_lease,
            ..Self::default()
        };
        for lease in snapshot.issued {
            if lease.id == 0
                || lease.id > snapshot.next_lease
                || !valid_identity(&lease.root_id)
                || !valid_identity(&lease.request_id)
                || lease.amounts.is_empty()
                || lease.amounts.values().any(|amount| *amount == 0)
                || snapshot.request_ids.get(&lease.request_id) != Some(&lease.id)
                || ledger.issued.contains_key(&lease.id)
            {
                return Err(StoreError::Corrupt);
            }
            for (resource, amount) in &lease.amounts {
                let Some(limit) = profile.global.get(resource) else {
                    return Err(StoreError::ProfileMismatch);
                };
                if amount > limit
                    || profile
                        .per_root
                        .get(resource)
                        .is_some_and(|root_limit| amount > root_limit)
                {
                    return Err(StoreError::Corrupt);
                }
            }
            ledger.issued.insert(lease.id, lease.clone());
        }
        let mut seen_active = std::collections::HashSet::new();
        for lease_id in snapshot.active_ids {
            if !seen_active.insert(lease_id) {
                return Err(StoreError::Corrupt);
            }
            let Some(lease) = ledger.issued.get(&lease_id).cloned() else {
                return Err(StoreError::Corrupt);
            };
            for (resource, amount) in &lease.amounts {
                let Some(limit) = profile.global.get(resource) else {
                    return Err(StoreError::ProfileMismatch);
                };
                let global_used = ledger
                    .used
                    .get(resource)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(*amount)
                    .ok_or(StoreError::Corrupt)?;
                if global_used > *limit {
                    return Err(StoreError::Corrupt);
                }
                let root = ledger
                    .used_by_root
                    .entry(lease.root_id.clone())
                    .or_default();
                let root_used = root
                    .get(resource)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(*amount)
                    .ok_or(StoreError::Corrupt)?;
                if profile
                    .per_root
                    .get(resource)
                    .is_some_and(|root_limit| root_used > *root_limit)
                {
                    return Err(StoreError::Corrupt);
                }
                ledger.used.insert(*resource, global_used);
                root.insert(*resource, root_used);
            }
            ledger.active.insert(lease.id, lease);
        }
        for (request_id, lease_id) in &snapshot.request_ids {
            if ledger
                .issued
                .get(lease_id)
                .is_none_or(|lease| lease.request_id != *request_id)
            {
                return Err(StoreError::Corrupt);
            }
        }
        ledger.request_ids = snapshot.request_ids.into_iter().collect();
        Ok(ledger)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerSnapshot {
    next_lease: u64,
    issued: Vec<Lease>,
    active_ids: Vec<u64>,
    request_ids: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ControlSnapshot {
    version: u16,
    sequence: u64,
    profile_revision: String,
    profile: CapacityProfile,
    ledger: LedgerSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StoreError {
    Io(String),
    Corrupt,
    ProfileMismatch,
    WriterAlreadyOpen,
    TooLarge,
    UnsupportedDurability,
    CommitUncertain,
    FileExists,
    InvalidProfile,
}

/// Sole-path, generation-based persistence for the native capacity ledger.
/// A caller must persist a candidate before acknowledging its transition or dispatch.
#[derive(Debug)]
pub struct ControlStore {
    dir: PathBuf,
    profile_revision: String,
    sequence: u64,
    poisoned: bool,
    _writer_lock: File,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlError {
    Admission(AdmissionError),
    Store(StoreError),
    QueueFull,
    Closed,
    TimedOut,
}

enum ActorCommand {
    Reserve {
        request_id: String,
        root_id: String,
        amounts: BTreeMap<Resource, u32>,
        reply: SyncSender<Result<Lease, ControlError>>,
    },
    Release {
        lease: Lease,
        reply: SyncSender<Result<(), ControlError>>,
    },
    Shutdown,
}

#[derive(Clone)]
pub struct ControlHandle {
    commands: SyncSender<ActorCommand>,
    response_timeout: Duration,
}

impl ControlHandle {
    pub fn reserve(
        &self,
        request_id: String,
        root_id: String,
        amounts: BTreeMap<Resource, u32>,
    ) -> Result<Lease, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::Reserve {
                request_id,
                root_id,
                amounts,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn release(&self, lease: Lease) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::Release { lease, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }
}

/// Single-threaded owner for the native capacity ledger. Not wired to product
/// workloads until the complete authority cutover is ready.
pub struct ControlActor {
    handle: ControlHandle,
    join: Option<JoinHandle<()>>,
}

impl ControlActor {
    pub fn open(
        data_dir: &Path,
        profile_revision: &str,
        profile: CapacityProfile,
        queue_capacity: usize,
        response_timeout: Duration,
    ) -> Result<Self, StoreError> {
        if queue_capacity == 0 || response_timeout.is_zero() {
            return Err(StoreError::InvalidProfile);
        }
        let (mut store, ledger) = ControlStore::open(data_dir, profile_revision, &profile)?;
        let (commands, receiver) = sync_channel(queue_capacity);
        let join = thread::Builder::new()
            .name("vak-control".into())
            .spawn(move || actor_loop(receiver, &mut store, profile, ledger))
            .map_err(store_io)?;
        Ok(Self {
            handle: ControlHandle {
                commands,
                response_timeout,
            },
            join: Some(join),
        })
    }

    pub fn handle(&self) -> ControlHandle {
        self.handle.clone()
    }
}

impl Drop for ControlActor {
    fn drop(&mut self) {
        let _ = self.handle.commands.send(ActorCommand::Shutdown);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn actor_loop(
    receiver: Receiver<ActorCommand>,
    store: &mut ControlStore,
    profile: CapacityProfile,
    mut ledger: CapacityLedger,
) {
    while let Ok(command) = receiver.recv() {
        match command {
            ActorCommand::Shutdown => break,
            ActorCommand::Reserve {
                request_id,
                root_id,
                amounts,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let result = candidate
                    .reserve(&profile, &request_id, &root_id, amounts)
                    .map_err(ControlError::Admission);
                match result {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok(lease) => match store.persist(&candidate, &profile) {
                        Ok(_) => {
                            ledger = candidate;
                            let _ = reply.send(Ok(lease));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Store(error)));
                            break;
                        }
                    },
                }
            }
            ActorCommand::Release { lease, reply } => {
                let mut candidate = ledger.clone();
                match candidate.release(&lease) {
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Admission(error)));
                    }
                    Ok(()) => match store.persist(&candidate, &profile) {
                        Ok(_) => {
                            ledger = candidate;
                            let _ = reply.send(Ok(()));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Store(error)));
                            break;
                        }
                    },
                }
            }
        }
    }
}

fn queue_error(error: TrySendError<ActorCommand>) -> ControlError {
    match error {
        TrySendError::Full(_) => ControlError::QueueFull,
        TrySendError::Disconnected(_) => ControlError::Closed,
    }
}

fn response_error(error: std::sync::mpsc::RecvTimeoutError) -> ControlError {
    match error {
        std::sync::mpsc::RecvTimeoutError::Timeout => ControlError::TimedOut,
        std::sync::mpsc::RecvTimeoutError::Disconnected => ControlError::Closed,
    }
}

impl ControlStore {
    pub fn open(
        data_dir: &Path,
        profile_revision: &str,
        profile: &CapacityProfile,
    ) -> Result<(Self, CapacityLedger), StoreError> {
        if !valid_identity(profile_revision) {
            return Err(StoreError::ProfileMismatch);
        }
        let dir = data_dir.join("control");
        fs::create_dir_all(&dir).map_err(store_io)?;
        let metadata = fs::symlink_metadata(&dir).map_err(store_io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StoreError::Corrupt);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(store_io)?;
        }
        sync_directory(data_dir)?;
        let writer_lock = acquire_writer_lock(&dir)?;
        let current = dir.join("current");
        let pointer_metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_file() => Some(metadata),
            Ok(_) => return Err(StoreError::Corrupt),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(store_io(error)),
        };
        let (sequence, ledger) = if let Some(metadata) = pointer_metadata {
            if metadata.len() > 64 {
                return Err(StoreError::Corrupt);
            }
            let mut pointer = Vec::new();
            File::open(&current)
                .map_err(store_io)?
                .take(64)
                .read_to_end(&mut pointer)
                .map_err(store_io)?;
            let pointer = std::str::from_utf8(&pointer).map_err(|_| StoreError::Corrupt)?;
            let Some(value) = pointer.strip_suffix('\n') else {
                return Err(StoreError::Corrupt);
            };
            if value.len() != 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(StoreError::Corrupt);
            }
            let sequence = value.parse::<u64>().map_err(|_| StoreError::Corrupt)?;
            if sequence == 0 {
                return Err(StoreError::Corrupt);
            }
            let file = dir.join(format!("generation-{sequence:020}.json"));
            let snapshot = read_snapshot(&file)?;
            if snapshot.version != STORE_VERSION || snapshot.sequence != sequence {
                return Err(StoreError::Corrupt);
            }
            if snapshot.profile_revision != profile_revision {
                return Err(StoreError::ProfileMismatch);
            }
            if snapshot.profile != *profile {
                return Err(StoreError::ProfileMismatch);
            }
            let ledger = CapacityLedger::restore(snapshot.ledger, profile)?;
            remove_unselected_generations(&dir, sequence)?;
            sync_directory(&dir)?;
            (sequence, ledger)
        } else {
            if has_generation(&dir)? {
                return Err(StoreError::Corrupt);
            }
            (0, CapacityLedger::default())
        };
        if remove_stale_temps(&dir)? {
            sync_directory(&dir)?;
        }
        Ok((
            Self {
                dir,
                profile_revision: profile_revision.to_owned(),
                sequence,
                poisoned: false,
                _writer_lock: writer_lock,
            },
            ledger,
        ))
    }

    pub fn persist(
        &mut self,
        ledger: &CapacityLedger,
        profile: &CapacityProfile,
    ) -> Result<u64, StoreError> {
        if self.poisoned {
            return Err(StoreError::CommitUncertain);
        }
        // Validate all persisted counters against the active profile before writing.
        let snapshot_ledger = ledger.snapshot();
        CapacityLedger::restore(snapshot_ledger.clone(), profile)?;
        let result = self.persist_checked(snapshot_ledger, profile);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn persist_checked(
        &mut self,
        snapshot_ledger: LedgerSnapshot,
        profile: &CapacityProfile,
    ) -> Result<u64, StoreError> {
        remove_unselected_generations(&self.dir, self.sequence)?;
        sync_directory(&self.dir)?;
        let sequence = self.sequence.checked_add(1).ok_or(StoreError::Corrupt)?;
        let snapshot = ControlSnapshot {
            version: STORE_VERSION,
            sequence,
            profile_revision: self.profile_revision.clone(),
            profile: profile.clone(),
            ledger: snapshot_ledger,
        };
        let bytes = serde_json::to_vec(&snapshot).map_err(|_| StoreError::Corrupt)?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err(StoreError::TooLarge);
        }
        let generation = self.dir.join(format!("generation-{sequence:020}.json"));
        let generation_tmp = write_temp_synced(&self.dir, "generation", &bytes)?;
        rename_new(&generation_tmp, &generation).map_err(store_io)?;
        sync_directory(&self.dir)?;

        let pointer_tmp =
            write_temp_synced(&self.dir, "current", format!("{sequence:020}\n").as_bytes())?;
        replace_file(&pointer_tmp, &self.dir.join("current")).map_err(store_io)?;
        sync_directory(&self.dir)?;
        self.sequence = sequence;
        remove_unselected_generations(&self.dir, sequence)?;
        sync_directory(&self.dir)?;
        Ok(sequence)
    }
}

fn acquire_writer_lock(dir: &Path) -> Result<File, StoreError> {
    let path = dir.join("writer.lock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_file() => return Err(StoreError::Corrupt),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(store_io(error)),
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(store_io)?;
    match file.try_lock() {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(store_io)?;
            }
            Ok(file)
        }
        Err(std::fs::TryLockError::WouldBlock) => Err(StoreError::WriterAlreadyOpen),
        Err(std::fs::TryLockError::Error(error)) => Err(store_io(error)),
    }
}

fn read_snapshot(path: &Path) -> Result<ControlSnapshot, StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            StoreError::Corrupt
        } else {
            store_io(error)
        }
    })?;
    if !metadata.file_type().is_file() {
        return Err(StoreError::Corrupt);
    }
    if metadata.len() > MAX_SNAPSHOT_BYTES {
        return Err(StoreError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(store_io)?
        .take(MAX_SNAPSHOT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(store_io)?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(StoreError::TooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)
}

fn has_generation(dir: &Path) -> Result<bool, StoreError> {
    for entry in fs::read_dir(dir).map_err(store_io)? {
        let entry = entry.map_err(store_io)?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("generation-")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn remove_unselected_generations(dir: &Path, selected: u64) -> Result<(), StoreError> {
    for entry in fs::read_dir(dir).map_err(store_io)? {
        let entry = entry.map_err(store_io)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("generation-") {
            continue;
        }
        let Some(sequence) = name
            .strip_prefix("generation-")
            .and_then(|value| value.strip_suffix(".json"))
            .filter(|value| value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
        else {
            return Err(StoreError::Corrupt);
        };
        if sequence.parse::<u64>().map_err(|_| StoreError::Corrupt)? != selected {
            fs::remove_file(entry.path()).map_err(store_io)?;
        }
    }
    Ok(())
}

fn remove_stale_temps(dir: &Path) -> Result<bool, StoreError> {
    let mut removed = false;
    for entry in fs::read_dir(dir).map_err(store_io)? {
        let entry = entry.map_err(store_io)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let owned_temp = [".generation-", ".current-"].iter().any(|prefix| {
            name.strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix(".tmp"))
                .is_some_and(|parts| {
                    let mut parts = parts.split('-');
                    parts.next().is_some_and(|value| {
                        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                    }) && parts.next().is_some_and(|value| {
                        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                    }) && parts.next().is_none()
                })
        });
        if !owned_temp {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(store_io)?;
        if !metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
            return Err(StoreError::Corrupt);
        }
        fs::remove_file(entry.path()).map_err(store_io)?;
        removed = true;
    }
    Ok(removed)
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            StoreError::FileExists
        } else {
            store_io(error)
        }
    })?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(store_io(error));
    }
    Ok(())
}

fn write_temp_synced(dir: &Path, prefix: &str, bytes: &[u8]) -> Result<PathBuf, StoreError> {
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".{prefix}-{}-{sequence}.tmp", std::process::id()));
        match write_new_synced(&path, bytes) {
            Ok(()) => return Ok(path),
            Err(StoreError::FileExists) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(StoreError::Io(
        "temporary control file namespace is exhausted".into(),
    ))
}

#[cfg(not(windows))]
fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::hard_link(from, to)?;
    fs::remove_file(from)
}

#[cfg(windows)]
fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    windows_move(from, to, 0x0000_0008)
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    windows_move(from, to, 0x0000_0001 | 0x0000_0008)
}

#[cfg(windows)]
fn windows_move(from: &Path, to: &Path, flags: u32) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // The OS primitive provides same-volume rename; WRITE_THROUGH requests completion before return.
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(store_io)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), StoreError> {
    // Windows has no standard-library directory-sync primitive. Do not
    // acknowledge snapshot selection or cleanup as durable until a supported
    // filesystem contract is implemented and verified for this platform.
    Err(StoreError::UnsupportedDurability)
}

fn store_io(error: std::io::Error) -> StoreError {
    if error.kind() == std::io::ErrorKind::Unsupported {
        StoreError::UnsupportedDurability
    } else {
        StoreError::Io(error.to_string())
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn profile() -> CapacityProfile {
        CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 2), (Resource::ContainedProcess, 4)]),
            BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 2)]),
            8,
        )
        .unwrap()
    }

    fn ask(resource: Resource, amount: u32) -> BTreeMap<Resource, u32> {
        BTreeMap::from([(resource, amount)])
    }

    #[test]
    fn explicit_profile_refuses_zero_and_impossible_limits() {
        assert_eq!(
            CapacityProfile::new(
                BTreeMap::from([(Resource::Generation, 0)]),
                BTreeMap::new(),
                1
            )
            .unwrap_err(),
            AdmissionError::InvalidProfile
        );
        assert_eq!(
            CapacityProfile::new(
                BTreeMap::from([(Resource::Generation, 1)]),
                BTreeMap::from([(Resource::Generation, 2)]),
                1
            )
            .unwrap_err(),
            AdmissionError::InvalidProfile
        );
        assert_eq!(
            CapacityProfile::new(
                BTreeMap::from([(Resource::Generation, 1)]),
                BTreeMap::new(),
                0
            )
            .unwrap_err(),
            AdmissionError::InvalidProfile
        );
    }

    #[test]
    fn reservations_cannot_oversubscribe_global_capacity() {
        let mut ledger = CapacityLedger::default();
        ledger
            .reserve(&profile(), "r1", "root-a", ask(Resource::Generation, 1))
            .unwrap();
        ledger
            .reserve(&profile(), "r2", "root-b", ask(Resource::Generation, 1))
            .unwrap();
        assert_eq!(
            ledger
                .reserve(&profile(), "r3", "root-c", ask(Resource::Generation, 1))
                .unwrap_err(),
            AdmissionError::CapacityUnavailable(Resource::Generation)
        );
    }

    #[test]
    fn root_limits_apply_even_when_global_capacity_is_free() {
        let mut ledger = CapacityLedger::default();
        ledger
            .reserve(
                &profile(),
                "r1",
                "root-a",
                ask(Resource::ContainedProcess, 2),
            )
            .unwrap();
        assert_eq!(
            ledger
                .reserve(
                    &profile(),
                    "r2",
                    "root-a",
                    ask(Resource::ContainedProcess, 1)
                )
                .unwrap_err(),
            AdmissionError::RootLimit(Resource::ContainedProcess)
        );
        assert!(
            ledger
                .reserve(
                    &profile(),
                    "r3",
                    "root-b",
                    ask(Resource::ContainedProcess, 2)
                )
                .is_ok()
        );
    }

    #[test]
    fn request_retries_are_idempotent_but_identity_reuse_is_rejected() {
        let mut ledger = CapacityLedger::default();
        let first = ledger
            .reserve(
                &profile(),
                "request-1",
                "root-a",
                ask(Resource::Generation, 1),
            )
            .unwrap();
        assert_eq!(
            ledger
                .reserve(
                    &profile(),
                    "request-1",
                    "root-a",
                    ask(Resource::Generation, 1)
                )
                .unwrap(),
            first
        );
        assert_eq!(
            ledger
                .reserve(
                    &profile(),
                    "request-1",
                    "root-b",
                    ask(Resource::Generation, 1)
                )
                .unwrap_err(),
            AdmissionError::ConflictingRequestIdentity
        );
        assert_eq!(ledger.active_leases(), 1);
    }

    #[test]
    fn settled_request_identity_cannot_be_replayed() {
        let mut ledger = CapacityLedger::default();
        let lease = ledger
            .reserve(
                &profile(),
                "request-1",
                "root-a",
                ask(Resource::Generation, 1),
            )
            .unwrap();
        ledger.release(&lease).unwrap();
        assert_eq!(
            ledger
                .reserve(
                    &profile(),
                    "request-1",
                    "root-a",
                    ask(Resource::Generation, 1)
                )
                .unwrap_err(),
            AdmissionError::RequestAlreadySettled
        );
    }

    #[test]
    fn request_identity_retention_is_bounded_by_the_explicit_profile() {
        let bounded = CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 2)]),
            BTreeMap::new(),
            1,
        )
        .unwrap();
        let mut ledger = CapacityLedger::default();
        let first = ledger
            .reserve(
                &bounded,
                "request-1",
                "root-a",
                ask(Resource::Generation, 1),
            )
            .unwrap();
        ledger.release(&first).unwrap();
        assert_eq!(
            ledger
                .reserve(
                    &bounded,
                    "request-2",
                    "root-a",
                    ask(Resource::Generation, 1)
                )
                .unwrap_err(),
            AdmissionError::RequestLedgerFull
        );
    }

    #[test]
    fn only_the_issued_lease_releases_capacity_and_release_is_idempotent() {
        let mut ledger = CapacityLedger::default();
        let first = ledger
            .reserve(
                &profile(),
                "request-1",
                "root-a",
                ask(Resource::Generation, 1),
            )
            .unwrap();
        let forged = Lease {
            root_id: "root-b".into(),
            ..first.clone()
        };
        assert_eq!(
            ledger.release(&forged).unwrap_err(),
            AdmissionError::UnknownLease
        );
        ledger.release(&first).unwrap();
        ledger.release(&first).unwrap();
        assert_eq!(ledger.active_leases(), 0);
        assert!(
            ledger
                .reserve(
                    &profile(),
                    "request-2",
                    "root-b",
                    ask(Resource::Generation, 1)
                )
                .is_ok()
        );
    }

    fn temp_data_dir() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEST_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "vak-control-{}-{stamp}-{sequence}",
            std::process::id()
        ))
    }

    #[test]
    fn store_recovers_live_holds_and_persists_release_before_ack() {
        let data = temp_data_dir();
        let constrained = CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 4)]),
            BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 2)]),
            8,
        )
        .unwrap();
        let (mut store, mut ledger) = ControlStore::open(&data, "profile-1", &constrained).unwrap();
        let first = ledger
            .reserve(
                &constrained,
                "request-1",
                "root-a",
                ask(Resource::Generation, 1),
            )
            .unwrap();
        assert_eq!(store.persist(&ledger, &constrained).unwrap(), 1);
        drop(store);

        let (mut store, mut recovered) =
            ControlStore::open(&data, "profile-1", &constrained).unwrap();
        assert_eq!(recovered.active_leases(), 1);
        assert_eq!(
            recovered
                .reserve(
                    &constrained,
                    "request-1",
                    "root-a",
                    ask(Resource::Generation, 1)
                )
                .unwrap(),
            first
        );
        assert_eq!(
            recovered
                .reserve(
                    &constrained,
                    "request-2",
                    "root-b",
                    ask(Resource::Generation, 1)
                )
                .unwrap_err(),
            AdmissionError::CapacityUnavailable(Resource::Generation)
        );
        recovered.release(&first).unwrap();
        assert_eq!(store.persist(&recovered, &constrained).unwrap(), 2);
        drop(store);

        let (_, mut settled) = ControlStore::open(&data, "profile-1", &constrained).unwrap();
        assert_eq!(settled.active_leases(), 0);
        assert_eq!(
            settled
                .reserve(
                    &constrained,
                    "request-1",
                    "root-a",
                    ask(Resource::Generation, 1)
                )
                .unwrap_err(),
            AdmissionError::RequestAlreadySettled
        );
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn store_keeps_only_the_selected_generation_after_each_commit() {
        let data = temp_data_dir();
        let (mut store, ledger) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        for expected_sequence in 1..=4 {
            assert_eq!(
                store.persist(&ledger, &profile()).unwrap(),
                expected_sequence
            );
            let generations: Vec<_> = fs::read_dir(data.join("control"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .filter(|name| name.to_string_lossy().starts_with("generation-"))
                .collect();
            assert_eq!(generations.len(), 1);
            assert_eq!(
                generations[0].to_string_lossy(),
                format!("generation-{expected_sequence:020}.json")
            );
        }
        drop(store);
        let (_, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn store_allows_only_one_writer_and_releases_lock_when_closed() {
        let data = temp_data_dir();
        let (store, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        assert_eq!(
            ControlStore::open(&data, "profile-1", &profile()).unwrap_err(),
            StoreError::WriterAlreadyOpen
        );
        drop(store);

        let (store, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        drop(store);
        fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn store_writer_lock_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let data = temp_data_dir();
        let lock_path = data.join("control/writer.lock");
        fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        fs::write(&lock_path, b"").unwrap();
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o644)).unwrap();
        let (store, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        let mode = fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        drop(store);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn store_writer_lock_is_exclusive_across_processes() {
        const PROBE: &str = "VAK_CONTROL_LOCK_PROBE";
        if let Ok(expectation) = std::env::var(PROBE) {
            let data = PathBuf::from(std::env::var_os("VAK_CONTROL_LOCK_DATA").unwrap());
            match expectation.as_str() {
                "busy" => assert_eq!(
                    ControlStore::open(&data, "profile-1", &profile()).unwrap_err(),
                    StoreError::WriterAlreadyOpen
                ),
                "available" => {
                    let (store, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
                    drop(store);
                }
                _ => panic!("invalid writer-lock probe expectation"),
            }
            return;
        }

        let data = temp_data_dir();
        let (store, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        let probe = |expectation: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "control::tests::store_writer_lock_is_exclusive_across_processes",
                ])
                .env(PROBE, expectation)
                .env("VAK_CONTROL_LOCK_DATA", &data)
                .status()
                .unwrap()
        };
        assert!(probe("busy").success());
        drop(store);
        assert!(probe("available").success());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn store_fails_closed_on_profile_change_and_corrupt_selected_pointer() {
        let data = temp_data_dir();
        let (mut store, ledger) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        store.persist(&ledger, &profile()).unwrap();
        drop(store);
        assert_eq!(
            ControlStore::open(&data, "profile-2", &profile()).unwrap_err(),
            StoreError::ProfileMismatch
        );
        let changed_limits = CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 1)]),
            BTreeMap::from([(Resource::Generation, 1)]),
            8,
        )
        .unwrap();
        assert_eq!(
            ControlStore::open(&data, "profile-1", &changed_limits).unwrap_err(),
            StoreError::ProfileMismatch
        );
        fs::write(data.join("control/current"), b"not-a-sequence\n").unwrap();
        assert_eq!(
            ControlStore::open(&data, "profile-1", &profile()).unwrap_err(),
            StoreError::Corrupt
        );
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn store_removes_unselected_generation_after_interrupted_commit() {
        let data = temp_data_dir();
        let (mut store, ledger) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        store.persist(&ledger, &profile()).unwrap();
        drop(store);
        fs::write(
            data.join("control/generation-00000000000000000002.json"),
            b"orphan",
        )
        .unwrap();
        fs::write(data.join("control/.generation-123-4.tmp"), b"partial").unwrap();
        fs::write(data.join("control/.current-123-5.tmp"), b"partial").unwrap();
        let (_, _) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        assert!(
            !data
                .join("control/generation-00000000000000000002.json")
                .exists()
        );
        assert!(!data.join("control/.generation-123-4.tmp").exists());
        assert!(!data.join("control/.current-123-5.tmp").exists());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn store_does_not_fall_back_when_selected_generation_is_corrupt() {
        let data = temp_data_dir();
        let (mut store, ledger) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        store.persist(&ledger, &profile()).unwrap();
        drop(store);
        fs::write(
            data.join("control/generation-00000000000000000001.json"),
            b"{}",
        )
        .unwrap();
        assert_eq!(
            ControlStore::open(&data, "profile-1", &profile()).unwrap_err(),
            StoreError::Corrupt
        );
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn actor_serializes_reserve_release_and_restart_recovery() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let actor = ControlActor::open(&data, "profile-1", profile(), 4, timeout).unwrap();
        let handle = actor.handle();
        let lease = handle
            .reserve(
                "request-1".into(),
                "root-a".into(),
                ask(Resource::Generation, 1),
            )
            .unwrap();
        assert!(matches!(
            handle.reserve(
                "request-2".into(),
                "root-b".into(),
                ask(Resource::Generation, 2)
            ),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::Generation)
            ))
        ));
        handle.release(lease.clone()).unwrap();
        handle.release(lease.clone()).unwrap();
        drop(handle);
        drop(actor);

        let restarted = ControlActor::open(&data, "profile-1", profile(), 4, timeout).unwrap();
        let handle = restarted.handle();
        assert!(matches!(
            handle.reserve(
                "request-1".into(),
                "root-a".into(),
                ask(Resource::Generation, 1)
            ),
            Err(ControlError::Admission(
                AdmissionError::RequestAlreadySettled
            ))
        ));
        assert!(
            handle
                .reserve(
                    "request-3".into(),
                    "root-b".into(),
                    ask(Resource::Generation, 1)
                )
                .is_ok()
        );
        drop(handle);
        drop(restarted);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn concurrent_roots_cannot_race_past_global_capacity() {
        let data = temp_data_dir();
        let actor =
            ControlActor::open(&data, "profile-1", profile(), 16, Duration::from_secs(10)).unwrap();
        let handle = actor.handle();
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let handle = handle.clone();
                thread::spawn(move || {
                    handle.reserve(
                        format!("request-{index}"),
                        format!("root-{index}"),
                        ask(Resource::Generation, 1),
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let admitted = results.iter().filter(|result| result.is_ok()).count();
        let saturated = results
            .iter()
            .filter(|result| {
                matches!(
                    result,
                    Err(ControlError::Admission(
                        AdmissionError::CapacityUnavailable(Resource::Generation)
                    ))
                )
            })
            .count();
        assert_eq!(admitted, 2);
        assert_eq!(saturated, 6);
        drop(handle);
        drop(actor);
        let (_, ledger) = ControlStore::open(&data, "profile-1", &profile()).unwrap();
        assert_eq!(ledger.active_leases(), 2);
        fs::remove_dir_all(data).unwrap();
    }
}
