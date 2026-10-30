//! Pure native admission primitives. The app does not enable this ledger until
//! every protected workload is routed through the owning control actor.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const STORE_VERSION: u16 = 20;
const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROOTS: usize = 10_000;
const MAX_CANDIDATE_RECEIPTS: usize = 10_000;
const MAX_ADMITTED_HOST_SESSIONS: usize = 10_000;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Keep Rust-owned authority and canonical bytes outside the sidecar's data root.
/// A contained worker can receive explicit grants for its own data without
/// inheriting a path to this sibling store.
fn native_store_root(data_dir: &Path) -> PathBuf {
    crate::private_store::root(data_dir)
}

pub mod bridge;
mod approval;
mod broker;
pub mod generation;
pub mod provider_io;
pub mod canonical;
pub mod publication;
pub mod canonical_runs;
pub mod delegation;
pub mod folder;
pub mod host_sessions;
pub mod registry;
pub mod root_runs;
pub mod tasks;
pub mod task_protocol;
pub mod worker_completion;
pub mod state;
use canonical::{
    CandidateCommitReceipt, CandidateCommitRequest, CanonicalContentStore, CanonicalSessionRecord,
};
use delegation::{ChildProposal, DelegationPolicy};
use folder::WorkspaceAdmissionPolicy;
use registry::{
    ProjectMembership, ProjectRecord, RegistryError, RegistryState, WorkspaceBinding,
    WorkspaceGrant, WorkspaceMode, WorkspaceRecord,
};
use state::{
    BudgetCharge, BudgetKind, BudgetLimits, CheckOutcome, ChildTask, ExecutionFence, Requirement,
    RootCreate, RootStatus, RootTask, StateError, StopCause, UserReview,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Resource {
    Generation,
    ProviderRequest,
    QueuedChild,
    ChildExecution,
    VerificationExecution,
    ToolInvocation,
    PersistentService,
    ContainedProcess,
    IntegrationProcess,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    InvalidIdentity,
    InvalidProfile,
    CapacityUnavailable(Resource),
    UnconfiguredResource(Resource),
    ReservedForControl(Resource),
    RootLimit(Resource),
    ConflictingRequestIdentity,
    RequestAlreadySettled,
    RequestLedgerFull,
    CandidateCommitLedgerFull,
    CandidateIdentityConflict,
    CandidateSessionMismatch,
    HostSessionAdmissionFull,
    HostSessionAdmissionHasData,
    CanonicalRevisionConflict,
    CanonicalSessionOwned,
    InvalidCandidate,
    UnknownLease,
    DuplicateRoot,
    RootLedgerFull,
    RootNotFound,
    RootRunNotFound,
    RootRunUnsettled,
    InvalidTask,
    TaskCapabilityUnavailable,
    WorkerCompletionUnavailable,
    ProviderApprovalRefused,
    ProviderBudgetExhausted,
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

    /// A metadata-only profile. Every execution resource remains unavailable
    /// until a measured profile explicitly configures it.
    pub fn unconfigured() -> Result<Self, AdmissionError> {
        Self::new(BTreeMap::new(), BTreeMap::new(), MAX_ROOTS)
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
    roots: BTreeMap<String, RootTask>,
    /// Rebuilt from durable roots; sessions can own multiple historical or
    /// concurrent tasks, so all associated roots remain indexed.
    roots_by_session: BTreeMap<String, BTreeSet<String>>,
    registry: RegistryState,
    canonical_sessions: BTreeMap<String, CanonicalSessionRecord>,
    candidate_receipts: BTreeMap<String, CandidateCommitReceipt>,
    root_runs: BTreeMap<String, root_runs::RootRun>,
    product_tasks: BTreeMap<String, tasks::TaskRecord>,
    provider_operations: BTreeMap<String, generation::OperationRecord>,
    provider_consents: BTreeMap<String, generation::ConsentRecord>,
    published_sessions: BTreeMap<String, CanonicalSessionRecord>,
    publication_receipts: BTreeMap<String, publication::PublicationReceipt>,
    canonical_runs: BTreeMap<String, canonical_runs::CanonicalRun>,
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
        {
            return Err(AdmissionError::InvalidIdentity);
        }
        if let Some(resource) = amounts
            .keys()
            .find(|resource| !profile.global.contains_key(resource))
        {
            return Err(AdmissionError::UnconfiguredResource(*resource));
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
            if let Some(root_limit) = profile.per_root.get(resource)
                && root_used
                    .and_then(|used| used.get(resource))
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(*amount)
                    > *root_limit
            {
                return Err(AdmissionError::RootLimit(*resource));
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

    fn active_lease(&self, id: u64) -> Option<Lease> {
        self.active.get(&id).cloned()
    }

    fn workspace_grant_is_current(&self, fixed: &WorkspaceGrant) -> bool {
        self.registry
            .grant(&fixed.session_id, fixed.binding_revision)
            .is_ok_and(|current| &current == fixed)
    }

    fn invalidate_queued_children_for_session(
        &mut self,
        session_id: &str,
    ) -> Result<(), ControlError> {
        let affected: Vec<_> = self
            .roots
            .iter()
            .filter(|(_, root)| {
                root.workspace_grant()
                    .is_some_and(|grant| grant.session_id == session_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for root_id in affected {
            let lease_ids = self
                .roots
                .get_mut(&root_id)
                .ok_or(ControlError::Admission(AdmissionError::RootNotFound))?
                .invalidate_execution_scope()
                .map_err(ControlError::TaskState)?;
            for lease_id in lease_ids {
                let lease = self
                    .active_lease(lease_id)
                    .ok_or(ControlError::Admission(AdmissionError::UnknownLease))?;
                self.release(&lease).map_err(ControlError::Admission)?;
            }
        }
        Ok(())
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
            roots: self.roots.clone(),
            registry: self.registry.clone(),
            canonical_sessions: self.canonical_sessions.clone(),
            candidate_receipts: self.candidate_receipts.clone(),
            root_runs: self.root_runs.clone(),
            product_tasks: self.product_tasks.clone(),
            provider_operations: self.provider_operations.clone(),
            provider_consents: self.provider_consents.clone(),
            published_sessions: self.published_sessions.clone(),
            publication_receipts: self.publication_receipts.clone(),
            canonical_runs: self.canonical_runs.clone(),
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
            roots: snapshot.roots,
            registry: snapshot.registry,
            canonical_sessions: snapshot.canonical_sessions,
            candidate_receipts: snapshot.candidate_receipts,
            root_runs: snapshot.root_runs,
            product_tasks: snapshot.product_tasks,
            provider_operations: snapshot.provider_operations,
            provider_consents: snapshot.provider_consents,
            published_sessions: snapshot.published_sessions,
            publication_receipts: snapshot.publication_receipts,
            canonical_runs: snapshot.canonical_runs,
            ..Self::default()
        };
        if ledger.canonical_sessions.len() > MAX_ROOTS
            || ledger.candidate_receipts.len() > MAX_CANDIDATE_RECEIPTS
            || ledger.canonical_sessions.iter().any(|(session_id, record)| {
                !canonical::validate_identity(session_id)
                    || !valid_identity(&record.root_id)
                    || record.revision == 0
                    || record.digest.len() != 64
                    || !record.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || record.previous_revision.is_some_and(|previous| {
                        previous == 0 || previous >= record.revision
                    })
            })
            || ledger.candidate_receipts.iter().any(|(commit_id, receipt)| {
                commit_id != &receipt.commit_id
                    || !valid_identity(commit_id)
                    || !canonical::validate_identity(&receipt.session_id)
                    || !valid_identity(&receipt.root_id)
                    || receipt.canonical_revision != receipt.expected_canonical_revision.saturating_add(1)
                    || receipt.digest.len() != 64
                    || receipt.request_fingerprint.len() != 64
            })
        {
            return Err(StoreError::Corrupt);
        }
        for receipt in ledger.candidate_receipts.values() {
            let Some(session) = ledger.canonical_sessions.get(&receipt.session_id) else {
                return Err(StoreError::Corrupt);
            };
            let Some(root) = ledger.roots.get(&receipt.root_id) else {
                return Err(StoreError::Corrupt);
            };
            if session.root_id != receipt.root_id
                || root.session_id() != Some(receipt.session_id.as_str())
                || receipt.root_revision > root.revision()
                || receipt.contract_revision > root.contract_revision()
            {
                return Err(StoreError::Corrupt);
            }
        }
        if ledger.roots.len() > MAX_ROOTS {
            return Err(StoreError::Corrupt);
        }
        let mut roots_by_session = BTreeMap::<String, BTreeSet<String>>::new();
        for (id, root) in &ledger.roots {
            if id != root.id() || root.validate().is_err() {
                return Err(StoreError::Corrupt);
            }
            if let Some(session) = root.session_id() {
                roots_by_session
                    .entry(session.to_owned())
                    .or_default()
                    .insert(id.clone());
            }
        }
        ledger.roots_by_session = roots_by_session;
        ledger
            .registry
            .validate()
            .map_err(|_| StoreError::Corrupt)?;
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
        let mut child_queue_lease_ids = std::collections::HashSet::new();
        let mut child_execution_lease_ids = std::collections::HashSet::new();
        for root in ledger.roots.values() {
            for child in root.children().values() {
                match child.status() {
                    state::ChildStatus::Queued => {
                        if !child_queue_lease_ids.insert(child.queue_lease_id()) {
                            return Err(StoreError::Corrupt);
                        }
                        let Some(lease) = ledger.active.get(&child.queue_lease_id()) else {
                            return Err(StoreError::Corrupt);
                        };
                        if lease.root_id() != root.id()
                            || lease.amounts() != &BTreeMap::from([(Resource::QueuedChild, 1)])
                        {
                            return Err(StoreError::Corrupt);
                        }
                    }
                    state::ChildStatus::Invalidated
                        if ledger.active.contains_key(&child.queue_lease_id()) =>
                    {
                        return Err(StoreError::Corrupt);
                    }
                    state::ChildStatus::Invalidated => {}
                    state::ChildStatus::Starting
                    | state::ChildStatus::Running
                    | state::ChildStatus::Interrupted => {
                        let Some(attempt) = child.attempt() else {
                            return Err(StoreError::Corrupt);
                        };
                        if !child_execution_lease_ids.insert(attempt.execution_lease_id()) {
                            return Err(StoreError::Corrupt);
                        }
                        let Some(lease) = ledger.active.get(&attempt.execution_lease_id()) else {
                            return Err(StoreError::Corrupt);
                        };
                        if lease.root_id() != root.id()
                            || lease.amounts() != &BTreeMap::from([(Resource::ChildExecution, 1)])
                        {
                            return Err(StoreError::Corrupt);
                        }
                    }
                    state::ChildStatus::Returned
                    | state::ChildStatus::Accepted
                    | state::ChildStatus::Rejected
                    | state::ChildStatus::Cancelled
                    | state::ChildStatus::Failed => {
                        let Some(attempt) = child.attempt() else {
                            return Err(StoreError::Corrupt);
                        };
                        if ledger.active.contains_key(&attempt.execution_lease_id()) {
                            return Err(StoreError::Corrupt);
                        }
                    }
                }
            }
        }
        if ledger.active.values().any(|lease| {
            lease.amounts().contains_key(&Resource::QueuedChild)
                && !child_queue_lease_ids.contains(&lease.id)
                || lease.amounts().contains_key(&Resource::ChildExecution)
                    && !child_execution_lease_ids.contains(&lease.id)
        }) {
            return Err(StoreError::Corrupt);
        }
        root_runs::validate(&ledger)?;
        tasks::validate(&ledger)?;
        generation::validate(&ledger)?;
        publication::validate(&ledger)?;
        canonical_runs::validate(&ledger)?;
        Ok(ledger)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerSnapshot {
    next_lease: u64,
    issued: Vec<Lease>,
    active_ids: Vec<u64>,
    request_ids: BTreeMap<String, u64>,
    roots: BTreeMap<String, RootTask>,
    registry: RegistryState,
    canonical_sessions: BTreeMap<String, CanonicalSessionRecord>,
    candidate_receipts: BTreeMap<String, CandidateCommitReceipt>,
    root_runs: BTreeMap<String, root_runs::RootRun>,
    product_tasks: BTreeMap<String, tasks::TaskRecord>,
    provider_operations: BTreeMap<String, generation::OperationRecord>,
    provider_consents: BTreeMap<String, generation::ConsentRecord>,
    published_sessions: BTreeMap<String, CanonicalSessionRecord>,
    publication_receipts: BTreeMap<String, publication::PublicationReceipt>,
    canonical_runs: BTreeMap<String, canonical_runs::CanonicalRun>,
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
    SessionRevisionConflict,
    SessionMigrationConflict,
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
    TaskState(StateError),
    Registry(RegistryError),
}

#[derive(Clone, Debug)]
pub enum RootMutation {
    StartAttempt {
        request_id: String,
    },
    WaitForInput,
    WaitForApproval,
    Stop {
        status: RootStatus,
        cause: StopCause,
        reason: String,
    },
    ReviseContract {
        goal: String,
        criteria: String,
    },
    RecordCheck {
        contract_revision: u64,
        requirement_id: String,
        outcome: CheckOutcome,
        receipt: Option<String>,
    },
    RequestReview,
    AcceptReview(UserReview),
}

enum RootRunAction {
    Read,
    SettleWorker,
    FinishReasoner,
    AbandonReasoner,
    Confirm(String),
    #[cfg(test)]
    Settle(String),
}

enum ActorCommand {
    ReasonerTaskDefinition { run_id: String, reply: SyncSender<Result<Option<tasks::TaskRequest>, ControlError>> },
    AdmitProductRun { id: String, revision: u64, request_id: String, reply: SyncSender<Result<root_runs::RootRun, ControlError>> },
    #[cfg(test)]
    PrepareProductFixture { id: String, revision: u64, request_id: String, reply: SyncSender<Result<root_runs::RootRun, ControlError>> },
    IssueProviderApproval { run_id: String, operation_id: String, attempt: u32, body: Vec<u8>, delivery: Option<generation::Delivery>, in_flight: Arc<std::sync::atomic::AtomicBool>, reply: SyncSender<Result<generation::Approval, ControlError>> },
    #[cfg(test)]
    DecideProviderApproval { ticket_id: String, fingerprint: String, decision: generation::Decision, reply: SyncSender<Result<generation::Dispatch, ControlError>> },
    ListProviderConsents { reply: SyncSender<Result<Vec<generation::ConsentView>, ControlError>> },
    ReadProviderConsent { id: String, fingerprint: String, offset: usize, reply: SyncSender<Result<generation::RequestSlice, ControlError>> },
    DecideProviderConsent { id: String, fingerprint: String, decision: generation::Decision, reply: SyncSender<Result<generation::ConsentReceipt, ControlError>> },
    BeginProvider { dispatch: Box<generation::Dispatch>, in_flight: Arc<std::sync::atomic::AtomicBool>, reply: SyncSender<Result<generation::StartedDispatch, ControlError>> },
    ProviderCurrent { id: String, reply: SyncSender<Result<(), ControlError>> },
    SettleProvider { id: String, receipt: generation::ResultReceipt, reply: SyncSender<Result<generation::OperationRecord, ControlError>> },
    ReadProvider { id: String, reply: SyncSender<Result<generation::OperationRecord, ControlError>> },
    PrepareWorkerCompletion { run_id: String, reply: SyncSender<Result<worker_completion::WorkerInvocation, ControlError>> },
    ProductTask { command: tasks::TaskCommand, reply: SyncSender<Result<serde_json::Value, ControlError>> },

    Ping {
        reply: SyncSender<()>,
    },
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
    CreateRoot {
        request: RootCreate,
        workspace_binding: Option<(String, u64)>,
        reply: SyncSender<Result<RootTask, ControlError>>,
    },
    AdmitChildren {
        root_id: String,
        expected_revision: u64,
        proposals: Vec<ChildProposal>,
        reply: SyncSender<Result<Vec<ChildTask>, ControlError>>,
    },
    StartChildAttempt {
        root_id: String,
        expected_root_revision: u64,
        child_id: String,
        expected_child_revision: u64,
        start_request_id: String,
        reply: SyncSender<Result<ChildTask, ControlError>>,
    },
    ConfirmChildStarted {
        root_id: String,
        expected_root_revision: u64,
        child_id: String,
        expected_child_revision: u64,
        supervisor_receipt: String,
        reply: SyncSender<Result<ChildTask, ControlError>>,
    },
    ReturnChildAttempt {
        root_id: String,
        child_id: String,
        expected_child_revision: u64,
        result_ref: String,
        reply: SyncSender<Result<ChildTask, ControlError>>,
    },
    MutateRoot {
        id: String,
        expected_revision: u64,
        mutation: RootMutation,
        reply: SyncSender<Result<RootTask, ControlError>>,
    },
    ChargeBudget {
        root_id: String,
        expected_revision: u64,
        kind: BudgetKind,
        request_id: String,
        reply: SyncSender<Result<(BudgetCharge, RootTask), ControlError>>,
    },
    ReadRootRunForStart {
        request_id: String,
        reply: SyncSender<Result<root_runs::RootRun, ControlError>>,
    },
    RootRunCommand {
        run_id: String,
        action: RootRunAction,
        reply: SyncSender<Result<root_runs::RootRun, ControlError>>,
    },
    ReadRoot {
        id: String,
        reply: SyncSender<Result<RootTask, ControlError>>,
    },
    ReadRootsForSession {
        session_id: String,
        reply: SyncSender<Result<Vec<String>, ControlError>>,
    },
    ReadCandidateReceipt {
        commit_id: String,
        reply: SyncSender<Result<Option<CandidateCommitReceipt>, ControlError>>,
    },
    AdmitHostSession {
        session_id: String,
        reply: SyncSender<Result<(), ControlError>>,
    },
    ReleaseHostSessionAdmission {
        session_id: String,
        reply: SyncSender<Result<(), ControlError>>,
    },
    LoadHostSession {
        session_id: String,
        reply: SyncSender<Result<Option<(u64, serde_json::Value)>, ControlError>>,
    },
    SaveHostSession {
        session_id: String,
        expected_revision: u64,
        snapshot: serde_json::Value,
        reply: SyncSender<Result<u64, ControlError>>,
    },
    ListHostSessions {
        reply: SyncSender<Result<Vec<host_sessions::SessionSummary>, ControlError>>,
    },
    RemoveHostSession {
        session_id: String,
        expected_revision: Option<u64>,
        reply: SyncSender<Result<(), ControlError>>,
    },
    PlanHostSessionMigration {
        reply: SyncSender<Result<host_sessions::SessionMigrationPlan, ControlError>>,
    },
    MigrateHostSessions {
        expected_digest: String,
        reply: SyncSender<Result<host_sessions::SessionMigrationReceipt, ControlError>>,
    },
    CheckExecutionFence {
        fence: ExecutionFence,
        reply: SyncSender<Result<(), ControlError>>,
    },
    AdmitCanonical { commit_id: String, reply: SyncSender<Result<canonical_runs::Invocation, ControlError>> },
    CanonicalCommand { id: String, action: CanonicalAction, in_flight: Option<Arc<std::sync::atomic::AtomicBool>>, reply: SyncSender<Result<canonical_runs::CanonicalRun, ControlError>> },
    ReadPublicationReceipt {
        commit_id: String,
        reply: SyncSender<Result<Option<publication::PublicationReceipt>, ControlError>>,
    },
    CommitCandidate {
        request: CandidateCommitRequest,
        app_worker: bool,
        in_flight: Arc<std::sync::atomic::AtomicBool>,
        reply: SyncSender<Result<CandidateCommitReceipt, ControlError>>,
    },
    CreateProject {
        id: String,
        name: String,
        reply: SyncSender<Result<ProjectRecord, ControlError>>,
    },
    RegisterWorkspace {
        id: String,
        path: PathBuf,
        reply: SyncSender<Result<WorkspaceRecord, ControlError>>,
    },
    BindWorkspace {
        id: String,
        session_id: String,
        workspace_id: String,
        realm_id: Option<String>,
        mode: WorkspaceMode,
        reply: SyncSender<Result<WorkspaceBinding, ControlError>>,
    },
    SetProjectMembership {
        session_id: String,
        project_id: Option<String>,
        expected_revision: Option<u64>,
        reply: SyncSender<Result<ProjectMembership, ControlError>>,
    },
    ReadProjectMembership {
        session_id: String,
        reply: SyncSender<Option<ProjectMembership>>,
    },
    SetProjectPreferredWorkspace {
        project_id: String,
        expected_revision: u64,
        workspace_id: Option<String>,
        reply: SyncSender<Result<ProjectRecord, ControlError>>,
    },
    RevokeWorkspace {
        session_id: String,
        expected_revision: u64,
        reply: SyncSender<Result<WorkspaceBinding, ControlError>>,
    },
    RebindWorkspace {
        session_id: String,
        expected_revision: u64,
        workspace_id: String,
        realm_id: Option<String>,
        mode: WorkspaceMode,
        reply: SyncSender<Result<WorkspaceBinding, ControlError>>,
    },
    ReadWorkspaceGrant {
        session_id: String,
        expected_revision: u64,
        reply: SyncSender<Result<WorkspaceGrant, ControlError>>,
    },
    Shutdown,
}

enum CanonicalAction { Read, Confirm(String), Finish(Option<Box<canonical_runs::Proposal>>), AbandonBeforeSpawn }

#[derive(Clone)]
pub struct ControlHandle {
    commands: SyncSender<ActorCommand>,
    response_timeout: Duration,
    candidate_in_flight: Arc<std::sync::atomic::AtomicBool>,
    provider_in_flight: Arc<std::sync::atomic::AtomicBool>,
}

impl ControlHandle {
    /// Trusted reasoning supervisor only. No IPC command offers this method.
    #[cfg(test)]
    pub fn issue_provider_approval(&self, run_id: String, operation_id: String, attempt: u32, body: Vec<u8>) -> Result<generation::Approval, ControlError> {
        self.issue_provider_approval_to(run_id, operation_id, attempt, body, None)
    }

    pub fn request_provider_consent(&self, run_id: String, operation_id: String, attempt: u32, body: Vec<u8>) -> Result<generation::PendingConsent, ControlError> {
        let (reply, response) = sync_channel(1);
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut wait = generation::PendingConsent { approval: None, reply: response, closed: closed.clone(), finished: false };
        let delivery = generation::Delivery { reply, closed, approval: None };
        wait.approval = Some(self.issue_provider_approval_to(run_id, operation_id, attempt, body, Some(delivery))?);
        Ok(wait)
    }
    fn issue_provider_approval_to(&self, run_id: String, operation_id: String, attempt: u32, body: Vec<u8>, delivery: Option<generation::Delivery>) -> Result<generation::Approval, ControlError> {
        if body.len() > 8_388_608 { return Err(ControlError::Admission(AdmissionError::ProviderApprovalRefused)); }
        self.provider_in_flight.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).map_err(|_| ControlError::QueueFull)?;
        let (reply, response) = sync_channel(1);
        if let Err(error) = self.commands.try_send(ActorCommand::IssueProviderApproval { run_id, operation_id, attempt, body, delivery, in_flight: self.provider_in_flight.clone(), reply }) {
            self.provider_in_flight.store(false, Ordering::Release); return Err(queue_error(error));
        }
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    /// Trusted approval controller only. The returned move-only value never
    /// crosses into the UI or reasoning process.
    #[cfg(test)]
    pub fn decide_provider_approval(&self, ticket_id: String, fingerprint: String, decision: generation::Decision) -> Result<generation::Dispatch, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::DecideProviderApproval { ticket_id, fingerprint, decision, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn list_provider_consents(&self) -> Result<Vec<generation::ConsentView>, ControlError> {
        let (reply, response) = sync_channel(1); self.commands.try_send(ActorCommand::ListProviderConsents { reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }
    pub fn read_provider_consent(&self, id: String, fingerprint: String, offset: usize) -> Result<generation::RequestSlice, ControlError> {
        let (reply, response) = sync_channel(1); self.commands.try_send(ActorCommand::ReadProviderConsent { id, fingerprint, offset, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }
    pub fn decide_provider_consent(&self, id: String, fingerprint: String, decision: generation::Decision) -> Result<generation::ConsentReceipt, ControlError> {
        let (reply, response) = sync_channel(1); self.commands.try_send(ActorCommand::DecideProviderConsent { id, fingerprint, decision, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    /// Only the native broker's settled I/O may supply this receipt.
    pub(super) fn begin_provider_dispatch(&self, dispatch: generation::Dispatch) -> Result<generation::StartedDispatch, ControlError> {
        if self.provider_in_flight.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() { return Err(ControlError::QueueFull); }
        let (reply, response) = sync_channel(1);
        if let Err(error) = self.commands.try_send(ActorCommand::BeginProvider { dispatch: Box::new(dispatch), in_flight: self.provider_in_flight.clone(), reply }) {
            self.provider_in_flight.store(false, Ordering::Release); return Err(queue_error(error));
        }
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }
    pub(super) fn provider_io_current(&self, id: String) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ProviderCurrent { id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }
    pub fn settle_provider_operation(&self, id: String, receipt: generation::ResultReceipt) -> Result<generation::OperationRecord, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::SettleProvider { id, receipt, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn read_provider_operation(&self, id: String) -> Result<generation::OperationRecord, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ReadProvider { id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }
    pub fn ping(&self) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::Ping { reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)
    }

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

    pub fn create_root(
        &self,
        id: String,
        goal: String,
        criteria: String,
        run_limit: u32,
        requirements: Vec<Requirement>,
    ) -> Result<RootTask, ControlError> {
        let delegation = DelegationPolicy::new(delegation::DelegationMode::Disabled, 0)
            .map_err(|error| ControlError::TaskState(StateError::Delegation(error)))?;
        self.create_root_with_delegation(id, goal, criteria, run_limit, requirements, delegation)
    }

    pub fn create_root_with_delegation(
        &self,
        id: String,
        goal: String,
        criteria: String,
        run_limit: u32,
        requirements: Vec<Requirement>,
        delegation: DelegationPolicy,
    ) -> Result<RootTask, ControlError> {
        self.create_root_with_budget(RootCreate {
            local_model: None,
            id,
            session_id: None,
            goal,
            criteria,
            run_limit,
            budget_limits: BudgetLimits::new(
                state::DEFAULT_MODEL_REQUEST_LIMIT,
                state::DEFAULT_TOOL_CALL_LIMIT,
            )
            .map_err(ControlError::TaskState)?,
            requirements,
            delegation,
        })
    }

    pub fn create_root_with_budget(&self, request: RootCreate) -> Result<RootTask, ControlError> {
        self.create_root_scoped(request, None)
    }

    pub fn create_root_in_workspace(
        &self,
        request: RootCreate,
        session_id: String,
        binding_revision: u64,
    ) -> Result<RootTask, ControlError> {
        self.create_root_scoped(request, Some((session_id, binding_revision)))
    }

    fn create_root_scoped(
        &self,
        request: RootCreate,
        workspace_binding: Option<(String, u64)>,
    ) -> Result<RootTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::CreateRoot {
                request,
                workspace_binding,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn admit_children(
        &self,
        root_id: String,
        expected_revision: u64,
        proposals: Vec<ChildProposal>,
    ) -> Result<Vec<ChildTask>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::AdmitChildren {
                root_id,
                expected_revision,
                proposals,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Atomically trades a queued-child lease for a child-execution lease and
    /// persists the attempt identity before returning it to a dispatcher.
    pub fn start_child_attempt(
        &self,
        root_id: String,
        expected_root_revision: u64,
        child_id: String,
        expected_child_revision: u64,
        start_request_id: String,
    ) -> Result<ChildTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::StartChildAttempt {
                root_id,
                expected_root_revision,
                child_id,
                expected_child_revision,
                start_request_id,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Confirms the prepared attempt only after the trusted process supervisor
    /// reports an exact launched invocation. This handle is not exposed to TS.
    pub fn confirm_child_started(
        &self,
        root_id: String,
        expected_root_revision: u64,
        child_id: String,
        expected_child_revision: u64,
        supervisor_receipt: String,
    ) -> Result<ChildTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ConfirmChildStarted {
                root_id,
                expected_root_revision,
                child_id,
                expected_child_revision,
                supervisor_receipt,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Records a child result claim after a trusted supervisor confirms exit,
    /// releasing execution capacity in the same durable transition. The result
    /// remains pending parent verification and parent review.
    pub fn return_child_attempt(
        &self,
        root_id: String,
        child_id: String,
        expected_child_revision: u64,
        result_ref: String,
    ) -> Result<ChildTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReturnChildAttempt {
                root_id,
                child_id,
                expected_child_revision,
                result_ref,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn mutate_root(
        &self,
        id: String,
        expected_revision: u64,
        mutation: RootMutation,
    ) -> Result<RootTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::MutateRoot {
                id,
                expected_revision,
                mutation,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Product task authority is callable only from the trusted native UI path.
    pub fn product_task(&self, command: tasks::TaskCommand) -> Result<serde_json::Value, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ProductTask { command, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    /// Native context adapter only; original file snapshots never come from a
    /// reasoning worker or a task DTO synthesized by the presentation layer.
    pub(crate) fn reasoner_task_definition(&self, run_id: String) -> Result<Option<tasks::TaskRequest>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ReasonerTaskDefinition { run_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn admit_product_run(&self, id: String, revision: u64, request_id: String) -> Result<root_runs::RootRun, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::AdmitProductRun { id, revision, request_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    #[cfg(test)]
    pub(crate) fn prepare_product_fixture(&self, id: String, revision: u64, request_id: String) -> Result<String, ControlError> {
        self.admit_product_run(id, revision, request_id).map(|run| run.id)
    }

    /// Trusted-supervisor entry points. These are not worker protocol operations.
    pub fn confirm_root_started(
        &self,
        run_id: String,
        receipt: String,
    ) -> Result<root_runs::RootRun, ControlError> {
        self.root_run_command(run_id, RootRunAction::Confirm(receipt))
    }

    #[cfg(test)]
    pub fn settle_root_exit(
        &self,
        run_id: String,
        receipt: String,
    ) -> Result<root_runs::RootRun, ControlError> {
        self.root_run_command(run_id, RootRunAction::Settle(receipt))
    }

    /// Trusted launcher only: no worker or webview operation accepts a path.
    pub fn prepare_worker_completion(&self, run_id: String) -> Result<worker_completion::WorkerInvocation, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::PrepareWorkerCompletion { run_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn finish_reasoner(&self, run_id: String) -> Result<root_runs::RootRun, ControlError> {
        self.root_run_command(run_id, RootRunAction::FinishReasoner)
    }
    pub fn abandon_reasoner_before_spawn(&self, run_id: String) -> Result<root_runs::RootRun, ControlError> {
        self.root_run_command(run_id, RootRunAction::AbandonReasoner)
    }

    pub fn settle_worker_completion(&self, run_id: String) -> Result<root_runs::RootRun, ControlError> {
        self.root_run_command(run_id, RootRunAction::SettleWorker)
    }

    pub fn read_root_run_for_start(
        &self,
        request_id: String,
    ) -> Result<root_runs::RootRun, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadRootRunForStart { request_id, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn read_root_run(&self, run_id: String) -> Result<root_runs::RootRun, ControlError> {
        self.root_run_command(run_id, RootRunAction::Read)
    }

    fn root_run_command(
        &self,
        run_id: String,
        action: RootRunAction,
    ) -> Result<root_runs::RootRun, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::RootRunCommand {
                run_id,
                action,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn read_root(&self, id: String) -> Result<RootTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadRoot { id, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Lists bounded root identities associated with a host session. This is
    /// lookup metadata; it does not establish which root owns an active run.
    pub fn root_ids_for_session(&self, session_id: String) -> Result<Vec<String>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadRootsForSession { session_id, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Reads a durable receipt for trusted recovery; absence never authorizes replay.
    pub fn read_candidate_receipt(
        &self,
        commit_id: String,
    ) -> Result<Option<CandidateCommitReceipt>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadCandidateReceipt { commit_id, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// A trusted shell must admit a chat before the sidecar may read or mutate its snapshot.
    /// Admission is process-ephemeral and therefore cleared on actor restart.
    pub fn admit_host_session(&self, session_id: String) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::AdmitHostSession { session_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    /// Releases an unused trusted admission after a failed UI operation.
    /// Existing snapshots keep their admission so cleanup cannot hide data.
    pub fn release_host_session_admission(&self, session_id: String) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ReleaseHostSessionAdmission { session_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn load_host_session(&self, session_id: String) -> Result<Option<(u64, serde_json::Value)>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::LoadHostSession { session_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn save_host_session(&self, session_id: String, expected_revision: u64, snapshot: serde_json::Value) -> Result<u64, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::SaveHostSession { session_id, expected_revision, snapshot, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn list_host_sessions(&self) -> Result<Vec<host_sessions::SessionSummary>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ListHostSessions { reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn remove_host_session(&self, session_id: String, expected_revision: Option<u64>) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::RemoveHostSession { session_id, expected_revision, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn plan_host_session_migration(&self) -> Result<host_sessions::SessionMigrationPlan, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::PlanHostSessionMigration { reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn migrate_host_sessions(&self, expected_digest: String) -> Result<host_sessions::SessionMigrationReceipt, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::MigrateHostSessions { expected_digest, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    /// Durably charges one model request before dispatch. A duplicate result
    /// is an idempotency signal, never permission to replay the request.
    pub fn charge_model_request(
        &self,
        root_id: String,
        expected_revision: u64,
        request_id: String,
    ) -> Result<(BudgetCharge, RootTask), ControlError> {
        self.charge_budget(
            root_id,
            expected_revision,
            BudgetKind::ModelRequest,
            request_id,
        )
    }

    /// Durably charges one tool invocation before dispatch. A duplicate result
    /// is an idempotency signal, never permission to replay the invocation.
    pub fn charge_tool_call(
        &self,
        root_id: String,
        expected_revision: u64,
        request_id: String,
    ) -> Result<(BudgetCharge, RootTask), ControlError> {
        self.charge_budget(root_id, expected_revision, BudgetKind::ToolCall, request_id)
    }

    fn charge_budget(
        &self,
        root_id: String,
        expected_revision: u64,
        kind: BudgetKind,
        request_id: String,
    ) -> Result<(BudgetCharge, RootTask), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ChargeBudget {
                root_id,
                expected_revision,
                kind,
                request_id,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Checks snapshot freshness only; it does not authorize or reserve an operation.
    /// The future broker must combine this state with capability policy at its serialized handoff.
    pub fn check_execution_fence(&self, fence: ExecutionFence) -> Result<(), ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::CheckExecutionFence { fence, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    /// Admission returns a one-use native launch context after both holds persist.
    pub fn admit_canonical(&self, commit_id: String) -> Result<canonical_runs::Invocation, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::AdmitCanonical { commit_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }
    pub fn read_canonical_run(&self, id: String) -> Result<canonical_runs::CanonicalRun, ControlError> { self.canonical_command(id, CanonicalAction::Read) }
    pub(crate) fn confirm_canonical_started(&self, id: String, receipt: String) -> Result<canonical_runs::CanonicalRun, ControlError> { self.canonical_command(id, CanonicalAction::Confirm(receipt)) }
    pub(crate) fn finish_canonical(&self, id: String, proposal: Option<canonical_runs::Proposal>) -> Result<canonical_runs::CanonicalRun, ControlError> { self.canonical_command(id, CanonicalAction::Finish(proposal.map(Box::new))) }
    pub(crate) fn abandon_canonical_before_spawn(&self, id: String) -> Result<canonical_runs::CanonicalRun, ControlError> { self.canonical_command(id, CanonicalAction::AbandonBeforeSpawn) }
    fn canonical_command(&self, id: String, action: CanonicalAction) -> Result<canonical_runs::CanonicalRun, ControlError> {
        let in_flight = if matches!(action, CanonicalAction::Finish(Some(_))) {
            if self.candidate_in_flight.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() { return Err(ControlError::QueueFull); }
            Some(self.candidate_in_flight.clone())
        } else { None };
        let (reply, response) = sync_channel(1);
        if let Err(error) = self.commands.try_send(ActorCommand::CanonicalCommand { id, action, in_flight: in_flight.clone(), reply }) {
            if let Some(flag) = in_flight { flag.store(false, Ordering::Release); }
            return Err(queue_error(error));
        }
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    pub fn read_publication_receipt(&self, commit_id: String) -> Result<Option<publication::PublicationReceipt>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands.try_send(ActorCommand::ReadPublicationReceipt { commit_id, reply }).map_err(queue_error)?;
        response.recv_timeout(self.response_timeout).map_err(response_error)?
    }

    /// Persists an opaque canonical candidate only when the task and canonical
    /// revisions still match. Replays return the durable receipt, never replay bytes.
    pub fn commit_candidate(
        &self,
        request: CandidateCommitRequest,
    ) -> Result<CandidateCommitReceipt, ControlError> {
        self.commit_candidate_from(request, false)
    }

    pub(crate) fn commit_app_candidate(&self, request: CandidateCommitRequest) -> Result<CandidateCommitReceipt, ControlError> {
        self.commit_candidate_from(request, true)
    }
    fn commit_candidate_from(&self, request: CandidateCommitRequest, app_worker: bool) -> Result<CandidateCommitReceipt, ControlError> {
        if self
            .candidate_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return Err(ControlError::QueueFull);
        }
        let (reply, response) = sync_channel(1);
        if let Err(error) = self.commands.try_send(ActorCommand::CommitCandidate {
            request,
            app_worker,
            in_flight: self.candidate_in_flight.clone(),
            reply,
        }) {
            self.candidate_in_flight.store(false, Ordering::Release);
            return Err(queue_error(error));
        }
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn create_project(&self, id: String, name: String) -> Result<ProjectRecord, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::CreateProject { id, name, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn register_workspace(
        &self,
        id: String,
        path: PathBuf,
    ) -> Result<WorkspaceRecord, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::RegisterWorkspace { id, path, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn bind_workspace(
        &self,
        id: String,
        session_id: String,
        workspace_id: String,
        realm_id: Option<String>,
        mode: WorkspaceMode,
    ) -> Result<WorkspaceBinding, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::BindWorkspace {
                id,
                session_id,
                workspace_id,
                realm_id,
                mode,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn revoke_workspace(
        &self,
        session_id: String,
        expected_revision: u64,
    ) -> Result<WorkspaceBinding, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::RevokeWorkspace {
                session_id,
                expected_revision,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn rebind_workspace(
        &self,
        session_id: String,
        expected_revision: u64,
        workspace_id: String,
        realm_id: Option<String>,
        mode: WorkspaceMode,
    ) -> Result<WorkspaceBinding, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::RebindWorkspace {
                session_id,
                expected_revision,
                workspace_id,
                realm_id,
                mode,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn read_workspace_grant(
        &self,
        session_id: String,
        expected_revision: u64,
    ) -> Result<WorkspaceGrant, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadWorkspaceGrant {
                session_id,
                expected_revision,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn set_project_membership(
        &self,
        session_id: String,
        project_id: Option<String>,
        expected_revision: Option<u64>,
    ) -> Result<ProjectMembership, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::SetProjectMembership {
                session_id,
                project_id,
                expected_revision,
                reply,
            })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)?
    }

    pub fn read_project_membership(
        &self,
        session_id: String,
    ) -> Result<Option<ProjectMembership>, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadProjectMembership { session_id, reply })
            .map_err(queue_error)?;
        response
            .recv_timeout(self.response_timeout)
            .map_err(response_error)
    }

    pub fn set_project_preferred_workspace(
        &self,
        project_id: String,
        expected_revision: u64,
        workspace_id: Option<String>,
    ) -> Result<ProjectRecord, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::SetProjectPreferredWorkspace {
                project_id,
                expected_revision,
                workspace_id,
                reply,
            })
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
        let native_dir = native_store_root(data_dir);
        crate::private_store::ensure_root(&native_dir).map_err(store_io)?;
        let (mut store, mut ledger) = ControlStore::open(&native_dir, profile_revision, &profile)?;
        let workspace_admission = WorkspaceAdmissionPolicy::new(data_dir).map_err(store_io)?;
        let mut recovered = false;
        let mut invalidated_child_leases = Vec::new();
        for root in ledger.roots.values_mut() {
            invalidated_child_leases.extend(
                root.invalidate_queued_children()
                    .map_err(|_| StoreError::Corrupt)?,
            );
            recovered |= root
                .recover_after_restart()
                .map_err(|_| StoreError::Corrupt)?;
            recovered |= root
                .interrupt_running_children()
                .map_err(|_| StoreError::Corrupt)?;
        }
        for lease_id in invalidated_child_leases {
            let lease = ledger.active_lease(lease_id).ok_or(StoreError::Corrupt)?;
            ledger.release(&lease).map_err(|_| StoreError::Corrupt)?;
            recovered = true;
        }
        for run in ledger.root_runs.values_mut() {
            if matches!(
                run.status,
                root_runs::RunStatus::Prepared | root_runs::RunStatus::Running
            ) {
                run.status = root_runs::RunStatus::Interrupted;
                recovered = true;
            }
        }
        recovered |= generation::recover(&mut ledger);
        recovered |= canonical_runs::recover(&mut ledger);
        if recovered {
            store.persist(&ledger, &profile)?;
        }
        let canonical_content = CanonicalContentStore::open(&native_dir, &ledger.canonical_sessions)
            .map_err(canonical_store_error)?;
        let published_content = CanonicalContentStore::open_publications(&native_dir, &ledger.published_sessions).map_err(canonical_store_error)?;
        let host_sessions = host_sessions::HostSessionStore::open(data_dir)?;
        if host_sessions.list().iter().any(|summary| ledger.product_tasks.contains_key(&summary.id)) { return Err(StoreError::Corrupt); }
        for id in ledger.published_sessions.keys() {
            publication::load(&ledger, &published_content, id).map_err(|_| StoreError::Corrupt)?;
        }
        let (commands, receiver) = sync_channel(queue_capacity);
        let join = thread::Builder::new()
            .name("vak-control".into())
            .spawn(move || actor_loop(receiver, &mut store, profile, ledger, workspace_admission, CanonicalStores { candidates: canonical_content, publications: published_content }, host_sessions))
            .map_err(store_io)?;
        Ok(Self {
            handle: ControlHandle {
                commands,
                response_timeout,
                candidate_in_flight: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                provider_in_flight: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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

fn decide_consent(
    store: &mut ControlStore,
    profile: &CapacityProfile,
    ledger: &mut CapacityLedger,
    approvals: &mut generation::Approvals,
    id: &str,
    fingerprint: &str,
    decision: generation::Decision,
) -> Result<generation::ConsentReceipt, ControlError> {
    use generation::{ConsentRejection, ConsentState, Decision};
    if let Some(record) = ledger.provider_consents.get(id) {
        return if record.fingerprint == fingerprint && record.decision == decision {
            Ok(record.receipt())
        } else {
            Err(ControlError::Admission(
                AdmissionError::ProviderApprovalRefused,
            ))
        };
    }
    if ledger.provider_consents.len() >= MAX_CANDIDATE_RECEIPTS {
        return Err(ControlError::Admission(
            AdmissionError::ProviderApprovalRefused,
        ));
    }
    let mut record = approvals.decision_scope(id, fingerprint, decision)?;
    let delivery = approvals.take_delivery(id, fingerprint)?;
    let mut next = ledger.clone();
    let mut rejection = None;
    let dispatch = if delivery.closed.load(Ordering::Acquire) {
        approvals.cancel_ticket(id);
        record.state = ConsentState::Cancelled;
        rejection = Some(ConsentRejection::Cancelled);
        None
    } else {
        let result = approvals.decide(&mut next, profile, id, fingerprint, decision);
        if decision == Decision::Deny {
            record.state = ConsentState::Denied;
            rejection = Some(ConsentRejection::Denied);
            None
        } else {
            match result {
                Ok(Some(dispatch)) => {
                    record.state = ConsentState::Allowed;
                    record.operation_id = Some(dispatch.operation().id.clone());
                    Some(dispatch)
                }
                Ok(None) => {
                    record.state = ConsentState::Refused;
                    rejection = Some(ConsentRejection::Refused);
                    None
                }
                Err(_) => {
                    next = ledger.clone();
                    record.state = ConsentState::Refused;
                    rejection = Some(ConsentRejection::Refused);
                    None
                }
            }
        }
    };
    next.provider_consents.insert(id.into(), record.clone());
    store.persist(&next, profile).map_err(ControlError::Store)?;
    *ledger = next;
    if let Some(dispatch) = dispatch {
        if delivery.reply.try_send(Ok(dispatch)).is_err() {
            let mut next = ledger.clone();
            generation::settle(
                &mut next,
                id,
                generation::ResultReceipt {
                    id: format!("consent-undelivered-{id}"),
                    outcome: generation::IoOutcome::NotDispatched,
                    status_code: None,
                    response_bytes: 0,
                },
            )?;
            record.state = ConsentState::Cancelled;
            next.provider_consents.insert(id.into(), record.clone());
            store.persist(&next, profile).map_err(ControlError::Store)?;
            *ledger = next;
        }
    } else {
        let _ = delivery
            .reply
            .try_send(Err(rejection.expect("native consent refusal")));
    }
    Ok(record.receipt())
}

fn commit_candidate(
    store: &mut ControlStore,
    profile: &CapacityProfile,
    ledger: &mut CapacityLedger,
    canonical_content: &mut CanonicalContentStore,
    request: CandidateCommitRequest,
) -> Result<CandidateCommitReceipt, ControlError> {
    request.validate().map_err(|error| match error {
        canonical::CanonicalStoreError::InvalidIdentity => {
            ControlError::Admission(AdmissionError::InvalidIdentity)
        }
        canonical::CanonicalStoreError::InvalidCandidate => {
            ControlError::Admission(AdmissionError::InvalidCandidate)
        }
        canonical::CanonicalStoreError::TooLarge => ControlError::Store(StoreError::TooLarge),
        other => ControlError::Store(canonical_store_error(other)),
    })?;
    let request_fingerprint = request.fingerprint();
    if let Some(receipt) = ledger.candidate_receipts.get(&request.commit_id) {
        return if receipt.request_fingerprint == request_fingerprint {
            Ok(receipt.clone())
        } else {
            Err(ControlError::Admission(
                AdmissionError::CandidateIdentityConflict,
            ))
        };
    }
    if ledger.candidate_receipts.len() >= MAX_CANDIDATE_RECEIPTS {
        return Err(ControlError::Admission(
            AdmissionError::CandidateCommitLedgerFull,
        ));
    }
    let Some(root) = ledger.roots.get(request.fence.root_id()) else {
        return Err(ControlError::Admission(AdmissionError::RootNotFound));
    };
    if root.session_id() != Some(request.session_id.as_str()) {
        return Err(ControlError::Admission(AdmissionError::CandidateSessionMismatch));
    }
    if root.status() != RootStatus::Running {
        return Err(ControlError::TaskState(StateError::InvalidTransition(
            root.status(),
        )));
    }
    if root.revision() != request.fence.root_revision()
        || root.contract_revision() != request.fence.contract_revision()
        || root.cancellation_epoch() != request.fence.cancellation_epoch()
        || !root_runs::has_running_invocation(ledger, root)
    {
        return Err(ControlError::TaskState(StateError::ExecutionFenceStale));
    }
    if root
        .workspace_grant()
        .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
    {
        return Err(ControlError::TaskState(StateError::WorkspaceGrantStale));
    }
    let prior = ledger.canonical_sessions.get(&request.session_id);
    if prior.is_some_and(|record| record.root_id != request.fence.root_id()) {
        return Err(ControlError::Admission(AdmissionError::CanonicalSessionOwned));
    }
    let current_revision = prior.map_or(0, |record| record.revision);
    if current_revision != request.expected_canonical_revision {
        return Err(ControlError::Admission(
            AdmissionError::CanonicalRevisionConflict,
        ));
    }
    if prior.is_none() && ledger.canonical_sessions.len() >= MAX_ROOTS {
        return Err(ControlError::Admission(AdmissionError::RootLedgerFull));
    }
    let canonical_revision = current_revision
        .checked_add(1)
        .ok_or(ControlError::Store(StoreError::Corrupt))?;
    let digest = canonical::digest(&request.candidate_bytes);
    let persisted_digest = canonical_content
        .write_candidate(
            &request.session_id,
            canonical_revision,
            &request.candidate_bytes,
        )
        .map_err(|error| ControlError::Store(canonical_store_error(error)))?;
    if persisted_digest != digest {
        return Err(ControlError::Store(StoreError::Corrupt));
    }
    let root_revision = root.revision();
    let record = CanonicalSessionRecord {
        root_id: request.fence.root_id().to_owned(),
        revision: canonical_revision,
        previous_revision: prior.map(|record| record.revision),
        digest: digest.clone(),
    };
    let receipt = CandidateCommitReceipt {
        commit_id: request.commit_id.clone(),
        session_id: request.session_id.clone(),
        root_id: request.fence.root_id().to_owned(),
        root_revision,
        contract_revision: request.fence.contract_revision(),
        cancellation_epoch: request.fence.cancellation_epoch(),
        expected_canonical_revision: current_revision,
        canonical_revision,
        digest,
        request_fingerprint,
    };
    let mut candidate = ledger.clone();
    candidate
        .canonical_sessions
        .insert(request.session_id, record);
    candidate
        .candidate_receipts
        .insert(request.commit_id, receipt.clone());
    store.persist(&candidate, profile).map_err(ControlError::Store)?;
    *ledger = candidate;
    canonical_content
        .cleanup(&ledger.canonical_sessions)
        .map_err(|error| ControlError::Store(canonical_store_error(error)))?;
    Ok(receipt)
}

fn canonical_store_error(error: canonical::CanonicalStoreError) -> StoreError {
    match error {
        canonical::CanonicalStoreError::TooLarge => StoreError::TooLarge,
        canonical::CanonicalStoreError::UnsupportedDurability => StoreError::UnsupportedDurability,
        canonical::CanonicalStoreError::Io(message) => StoreError::Io(message),
        canonical::CanonicalStoreError::InvalidIdentity
        | canonical::CanonicalStoreError::InvalidCandidate
        | canonical::CanonicalStoreError::Conflict
        | canonical::CanonicalStoreError::Corrupt => StoreError::Corrupt,
    }
}

struct CanonicalStores { candidates: CanonicalContentStore, publications: CanonicalContentStore }

fn actor_loop(
    receiver: Receiver<ActorCommand>,
    store: &mut ControlStore,
    profile: CapacityProfile,
    mut ledger: CapacityLedger,
    workspace_admission: WorkspaceAdmissionPolicy,
    content: CanonicalStores,
    mut host_sessions: host_sessions::HostSessionStore,
) {
    let CanonicalStores { candidates: mut canonical_content, publications: published_content } = content;
    let mut admitted_host_sessions = std::collections::BTreeSet::new();
    let mut provider_approvals = generation::Approvals::default();
    while let Ok(command) = receiver.recv() {
        provider_approvals.prune(&ledger);
        match command {
            ActorCommand::ReasonerTaskDefinition { run_id, reply } => {
                let result = ledger.root_runs.get(&run_id).ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))
                    .map(|run| ledger.product_tasks.get(&run.root_id).map(|record| record.request.clone()));
                let _ = reply.send(result);
            }
            ActorCommand::AdmitProductRun { id, revision, request_id, reply } => {
                let mut next = ledger.clone();
                let result = if !next.product_tasks.contains_key(&id) { Err(ControlError::Admission(AdmissionError::InvalidTask)) }
                else { root_runs::prepare(&mut next, &profile, &id, revision, &request_id).and_then(|_| {
                    if let Some(record) = next.product_tasks.get_mut(&id) {
                        record.updated = tasks::now();
                    }
                    store.persist(&next, &profile).map_err(ControlError::Store)?;
                    let run = next.root_runs.values().find(|run| run.request_id == request_id).cloned().ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
                    ledger = next; Ok(run)
                }) };
                let _ = reply.send(result);
            }
            #[cfg(test)]
            ActorCommand::PrepareProductFixture { id, revision, request_id, reply } => {
                let mut next = ledger.clone();
                let result = if !next.product_tasks.contains_key(&id) { Err(ControlError::Admission(AdmissionError::InvalidTask)) }
                else { root_runs::prepare(&mut next, &profile, &id, revision, &request_id).and_then(|_| {
                    if let Some(record) = next.product_tasks.get_mut(&id) {
                        record.updated = tasks::now();
                    }
                    store.persist(&next, &profile).map_err(ControlError::Store)?;
                    let run = next.root_runs.values().find(|run| run.request_id == request_id).cloned().ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
                    ledger = next; Ok(run)
                }) };
                let _ = reply.send(result);
            }
            ActorCommand::IssueProviderApproval { run_id, operation_id, attempt, body, delivery, in_flight, reply } => {
                let result = provider_approvals.issue(&ledger, run_id, operation_id, attempt, body).and_then(|ticket| {
                    if let Some(delivery) = delivery { provider_approvals.attach(&ticket, delivery)?; }
                    Ok(ticket)
                });
                in_flight.store(false, Ordering::Release);
                let _ = reply.send(result);
            }
            #[cfg(test)]
            ActorCommand::DecideProviderApproval { ticket_id, fingerprint, decision, reply } => {
                if provider_approvals.has_delivery(&ticket_id) { let _ = reply.send(Err(ControlError::Admission(AdmissionError::ProviderApprovalRefused))); continue; }
                let mut candidate = ledger.clone();
                match provider_approvals.decide(&mut candidate, &profile, &ticket_id, &fingerprint, decision) {
                    Err(error) => { let _ = reply.send(Err(error)); }
                    Ok(dispatch) => {
                        if let Err(error) = store.persist(&candidate, &profile) {
                            let _ = reply.send(Err(ControlError::Store(error))); break;
                        }
                        ledger = candidate;
                        let _ = reply.send(dispatch.ok_or(ControlError::Admission(AdmissionError::ProviderBudgetExhausted)));
                    }
                }
            }
            ActorCommand::ListProviderConsents { reply } => { let _ = reply.send(Ok(provider_approvals.views(&ledger))); }
            ActorCommand::ReadProviderConsent { id, fingerprint, offset, reply } => { let _ = reply.send(provider_approvals.consent_slice(&id, &fingerprint, offset)); }
            ActorCommand::DecideProviderConsent { id, fingerprint, decision, reply } => {
                let result = decide_consent(store, &profile, &mut ledger, &mut provider_approvals, &id, &fingerprint, decision);
                let fatal = matches!(result, Err(ControlError::Store(_)));
                let _ = reply.send(result); if fatal { break; }
            }
            ActorCommand::BeginProvider { dispatch, in_flight, reply } => {
                let mut next = ledger.clone();
                let result = generation::begin(&mut next, *dispatch).and_then(|dispatch| {
                    store.persist(&next, &profile).map_err(ControlError::Store)?;
                    ledger = next; Ok(dispatch)
                });
                in_flight.store(false, Ordering::Release);
                let fatal = matches!(result, Err(ControlError::Store(_)));
                let _ = reply.send(result);
                if fatal { break; }
            }
            ActorCommand::ProviderCurrent { id, reply } => { let _ = reply.send(generation::io_current(&ledger, &id)); }
            ActorCommand::SettleProvider { id, receipt, reply } => {
                let mut candidate = ledger.clone();
                match generation::settle(&mut candidate, &id, receipt) {
                    Err(error) => { let _ = reply.send(Err(error)); }
                    Ok(record) => {
                        if let Err(error) = store.persist(&candidate, &profile) { let _ = reply.send(Err(ControlError::Store(error))); break; }
                        ledger = candidate; let _ = reply.send(Ok(record));
                    }
                }
            }
            ActorCommand::ReadProvider { id, reply } => {
                let _ = reply.send(ledger.provider_operations.get(&id).cloned().ok_or(ControlError::Admission(AdmissionError::ProviderApprovalRefused)));
            }
            ActorCommand::PrepareWorkerCompletion { run_id, reply } => {
                let mut next = ledger.clone();
                let result = store.dir.parent().ok_or(ControlError::Store(StoreError::Corrupt))
                    .and_then(|native| worker_completion::prepare(&mut next, &profile, native, &run_id));
                match result {
                    Ok(invocation) => match store.persist(&next, &profile) {
                        Ok(_) => {
                            ledger = next;
                            if reply.send(Ok(invocation)).is_err() {
                                let mut next = ledger.clone();
                                if worker_completion::abandon_before_spawn(&mut next, &run_id).is_err() || store.persist(&next, &profile).is_err() { break; }
                                ledger = next;
                            }
                        }
                        Err(error) => { let _ = reply.send(Err(ControlError::Store(error))); break; }
                    },
                    Err(error) => { let _ = reply.send(Err(error)); }
                }
            }
            ActorCommand::ProductTask { command, reply } => {
                if let tasks::TaskCommand::Create { request } = &command
                    && !ledger.product_tasks.contains_key(&request.id) {
                        match host_sessions.load(&request.id) {
                            Ok(None) => {}
                            Ok(Some(_)) => { let _ = reply.send(Err(ControlError::Admission(AdmissionError::DuplicateRoot))); continue; }
                            Err(error) => { let _ = reply.send(Err(ControlError::Store(error))); continue; }
                        }
                }
                let selected = match &command {
                    tasks::TaskCommand::Create { request } => Some(request.id.clone()),
                    tasks::TaskCommand::Read { id }
                    | tasks::TaskCommand::Cancel { id, .. }
                    | tasks::TaskCommand::AdmitRun { id, .. }
                    | tasks::TaskCommand::WaitForInput { id, .. }
                    | tasks::TaskCommand::Input { id, .. }
                    | tasks::TaskCommand::Review { id }
                    | tasks::TaskCommand::Complete { id, .. }
                    | tasks::TaskCommand::Output { id, .. }
                    | tasks::TaskCommand::OutputContent { id, .. } => Some(id.clone()),
                    _ => None,
                };
                let removing = match &command { tasks::TaskCommand::Remove { id, .. } => Some(id.clone()), _ => None };
                if let Some(id) = removing.as_ref() {
                    match host_sessions.load(id) {
                        Ok(None) => {}
                        Ok(Some(_)) => { let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue; }
                        Err(error) => { let _ = reply.send(Err(ControlError::Store(error))); continue; }
                    }
                }
                if selected.as_ref().is_some_and(|id| !admitted_host_sessions.contains(id) && admitted_host_sessions.len() >= MAX_ADMITTED_HOST_SESSIONS) {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::HostSessionAdmissionFull))); continue;
                }
                let read_result = match &command {
                    tasks::TaskCommand::List => Some(tasks::list(&ledger)),
                    tasks::TaskCommand::Read { id } => Some(tasks::view(&ledger, id)),
                    tasks::TaskCommand::Review { id } => Some(tasks::review(&ledger, id)),
                    tasks::TaskCommand::OutputContent { id, run_id } => {
                        Some(tasks::output_content(&ledger, id, run_id))
                    }
                    tasks::TaskCommand::Create { request } if ledger.product_tasks.contains_key(&request.id) => {
                        Some(if ledger.product_tasks[&request.id].request == **request { tasks::view(&ledger, &request.id) } else { Err(ControlError::Admission(AdmissionError::DuplicateRoot)) })
                    }
                    _ => None,
                };
                if let Some(result) = read_result {
                    if result.is_ok() && let Some(id) = selected { admitted_host_sessions.insert(id); }
                    let _ = reply.send(result); continue;
                }
                let mut candidate = ledger.clone();
                match tasks::apply(&mut candidate, &profile, command) {
                    Err(error) => { let _ = reply.send(Err(error)); }
                    Ok(value) => {
                        if let Err(error) = store.persist(&candidate, &profile) {
                            let recoverable = error == StoreError::TooLarge;
                            let _ = reply.send(Err(ControlError::Store(error)));
                            if recoverable { continue; } else { break; }
                        }
                        ledger = candidate;
                        if let Some(id) = selected { admitted_host_sessions.insert(id); }
                        if let Some(id) = removing { admitted_host_sessions.remove(&id); }
                        let _ = reply.send(Ok(value));
                    }
                }
            }
            ActorCommand::Shutdown => break,
            ActorCommand::Ping { reply } => {
                let _ = reply.send(());
            }
            ActorCommand::Reserve {
                request_id,
                root_id,
                amounts,
                reply,
            } => {
                if let Some(resource @ (Resource::QueuedChild | Resource::ChildExecution)) =
                    amounts.keys().find(|resource| {
                        matches!(resource, Resource::QueuedChild | Resource::ChildExecution)
                    })
                {
                    let _ = reply.send(Err(ControlError::Admission(
                        AdmissionError::ReservedForControl(*resource),
                    )));
                    continue;
                }
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
                let owned_resource = if ledger.root_runs.values().any(|run| run.lease_id == lease.id()) {
                    Some(Resource::Generation)
                } else if ledger.root_runs.values().any(|run| run.worker_lease_id == Some(lease.id())) {
                    Some(Resource::ContainedProcess)
                } else if ledger.provider_operations.values().any(|record| record.lease_id == lease.id()) {
                    Some(Resource::ProviderRequest)
                } else if canonical_runs::owns(&ledger, lease.id()) { Some(Resource::VerificationExecution) } else { None };
                if let Some(resource) = owned_resource {
                    let _ = reply.send(Err(ControlError::Admission(
                        AdmissionError::ReservedForControl(resource),
                    )));
                    continue;
                }
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
            ActorCommand::CreateRoot {
                mut request,
                workspace_binding,
                reply,
            } => {
                if let Some((session_id, _)) = workspace_binding.as_ref() {
                    if request.session_id.as_deref().is_some_and(|bound| bound != session_id) {
                        let _ = reply.send(Err(ControlError::Admission(AdmissionError::CandidateSessionMismatch)));
                        continue;
                    }
                    request.session_id = Some(session_id.clone());
                }
                let id = request.id.clone();
                if ledger.product_tasks.contains_key(&id)
                    || request.session_id.as_ref().is_some_and(|session| ledger.product_tasks.contains_key(session)) {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue;
                }
                if let Some(existing) = ledger.roots.get(&id) {
                    let scope_matches =
                        match (workspace_binding.as_ref(), existing.workspace_grant()) {
                            (None, None) => true,
                            (Some((session_id, revision)), Some(grant)) => {
                                grant.session_id == *session_id
                                    && grant.binding_revision == *revision
                                    && request.session_id.as_deref() == Some(session_id.as_str())
                            }
                            _ => false,
                        };
                    if existing.creation_request_matches(&request) && scope_matches {
                        let _ = reply.send(Ok(existing.clone()));
                    } else {
                        let _ =
                            reply.send(Err(ControlError::Admission(AdmissionError::DuplicateRoot)));
                    }
                    continue;
                }
                if ledger.roots.len() >= MAX_ROOTS {
                    let _ =
                        reply.send(Err(ControlError::Admission(AdmissionError::RootLedgerFull)));
                    continue;
                }
                let workspace_grant = match workspace_binding {
                    Some((session_id, revision)) => {
                        match ledger.registry.grant(&session_id, revision) {
                            Ok(grant) => Some(grant),
                            Err(error) => {
                                let _ = reply.send(Err(ControlError::Registry(error)));
                                continue;
                            }
                        }
                    }
                    None => None,
                };
                let root = match RootTask::create_with_grant(request, workspace_grant) {
                    Ok(root) => root,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::TaskState(error)));
                        continue;
                    }
                };
                let mut candidate = ledger.clone();
                if let Some(session_id) = root.session_id() {
                    candidate
                        .roots_by_session
                        .entry(session_id.to_owned())
                        .or_default()
                        .insert(root.id().to_owned());
                }
                candidate.roots.insert(root.id().to_owned(), root.clone());
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(root));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::AdmitChildren {
                root_id,
                expected_revision,
                proposals,
                reply,
            } => {
                let Some(root) = ledger.roots.get(&root_id) else {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                    continue;
                };
                let new_count = match root.validate_child_admission(expected_revision, &proposals) {
                    Ok(count) => count,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::TaskState(error)));
                        continue;
                    }
                };
                if root
                    .workspace_grant()
                    .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
                {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::WorkspaceGrantStale,
                    )));
                    continue;
                }
                if new_count == 0 {
                    let root = ledger.roots.get_mut(&root_id).expect("root checked above");
                    let result = root.admit_children(expected_revision, proposals, &[]);
                    let _ = reply.send(result.map_err(ControlError::TaskState));
                    continue;
                }
                let mut candidate = ledger.clone();
                let mut queue_lease_ids = Vec::with_capacity(new_count);
                let mut reservation_error = None;
                for _ in 0..new_count {
                    let Some(next_lease) = candidate.next_lease.checked_add(1) else {
                        reservation_error =
                            Some(ControlError::Admission(AdmissionError::InvalidProfile));
                        break;
                    };
                    let request_id = format!("child-queue-{next_lease}");
                    let amounts = BTreeMap::from([(Resource::QueuedChild, 1)]);
                    match candidate.reserve(&profile, &request_id, &root_id, amounts) {
                        Ok(lease) => {
                            queue_lease_ids.push(lease.id);
                        }
                        Err(error) => {
                            reservation_error = Some(ControlError::Admission(error));
                            break;
                        }
                    }
                }
                if let Some(error) = reservation_error {
                    let _ = reply.send(Err(error));
                    continue;
                }
                let root = candidate
                    .roots
                    .get_mut(&root_id)
                    .expect("root cloned above");
                let children =
                    match root.admit_children(expected_revision, proposals, &queue_lease_ids) {
                        Ok(children) => children,
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::TaskState(error)));
                            continue;
                        }
                    };
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(children));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::StartChildAttempt {
                root_id,
                expected_root_revision,
                child_id,
                expected_child_revision,
                start_request_id,
                reply,
            } => {
                let Some(root) = ledger.roots.get(&root_id) else {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                    continue;
                };
                let Some(child) = root.children().get(&child_id) else {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::ChildAttemptUnavailable,
                    )));
                    continue;
                };
                if let Some(attempt) = child.attempt() {
                    if attempt.start_request_id() == start_request_id {
                        let _ = reply.send(Ok(child.clone()));
                    } else {
                        let _ = reply.send(Err(ControlError::TaskState(
                            StateError::ChildAttemptUnavailable,
                        )));
                    }
                    continue;
                }
                if root.revision() != expected_root_revision {
                    let _ = reply.send(Err(ControlError::TaskState(StateError::RevisionConflict)));
                    continue;
                }
                if root.status() != RootStatus::Running {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::InvalidTransition(root.status()),
                    )));
                    continue;
                }
                if root
                    .workspace_grant()
                    .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
                {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::WorkspaceGrantStale,
                    )));
                    continue;
                }
                if child.revision() != expected_child_revision
                    || child.status() != state::ChildStatus::Queued
                {
                    let _ = reply.send(Err(ControlError::TaskState(StateError::RevisionConflict)));
                    continue;
                }
                let mut candidate = ledger.clone();
                let queue_lease = match candidate.active_lease(child.queue_lease_id()) {
                    Some(lease) => lease,
                    None => {
                        let _ =
                            reply.send(Err(ControlError::Admission(AdmissionError::UnknownLease)));
                        continue;
                    }
                };
                if let Err(error) = candidate.release(&queue_lease) {
                    let _ = reply.send(Err(ControlError::Admission(error)));
                    continue;
                }
                let Some(next_lease) = candidate.next_lease.checked_add(1) else {
                    let _ =
                        reply.send(Err(ControlError::Admission(AdmissionError::InvalidProfile)));
                    continue;
                };
                let execution_request = format!("child-exec-{next_lease}");
                let execution = match candidate.reserve(
                    &profile,
                    &execution_request,
                    &root_id,
                    BTreeMap::from([(Resource::ChildExecution, 1)]),
                ) {
                    Ok(lease) => lease,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Admission(error)));
                        continue;
                    }
                };
                let result = candidate
                    .roots
                    .get_mut(&root_id)
                    .expect("root checked above")
                    .start_child_attempt(
                        expected_root_revision,
                        &child_id,
                        expected_child_revision,
                        start_request_id,
                        execution.id,
                    )
                    .map_err(ControlError::TaskState);
                match result {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok(child) => match store.persist(&candidate, &profile) {
                        Ok(_) => {
                            ledger = candidate;
                            let _ = reply.send(Ok(child));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Store(error)));
                            break;
                        }
                    },
                }
            }
            ActorCommand::ConfirmChildStarted {
                root_id,
                expected_root_revision,
                child_id,
                expected_child_revision,
                supervisor_receipt,
                reply,
            } => {
                let Some(root) = ledger.roots.get(&root_id) else {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                    continue;
                };
                let Some(child) = root.children().get(&child_id) else {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::ChildAttemptUnavailable,
                    )));
                    continue;
                };
                if child.status() == state::ChildStatus::Running
                    && child
                        .attempt()
                        .and_then(state::ChildAttempt::supervisor_receipt)
                        == Some(supervisor_receipt.as_str())
                {
                    let _ = reply.send(Ok(child.clone()));
                    continue;
                }
                if root.revision() != expected_root_revision {
                    let _ = reply.send(Err(ControlError::TaskState(StateError::RevisionConflict)));
                    continue;
                }
                if root.status() != RootStatus::Running {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::InvalidTransition(root.status()),
                    )));
                    continue;
                }
                if root
                    .workspace_grant()
                    .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
                {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::WorkspaceGrantStale,
                    )));
                    continue;
                }
                let mut candidate = ledger.clone();
                let result = candidate
                    .roots
                    .get_mut(&root_id)
                    .expect("root checked above")
                    .confirm_child_started(
                        expected_root_revision,
                        &child_id,
                        expected_child_revision,
                        supervisor_receipt,
                    )
                    .map_err(ControlError::TaskState);
                match result {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok(child) => match store.persist(&candidate, &profile) {
                        Ok(_) => {
                            ledger = candidate;
                            let _ = reply.send(Ok(child));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Store(error)));
                            break;
                        }
                    },
                }
            }
            ActorCommand::ReturnChildAttempt {
                root_id,
                child_id,
                expected_child_revision,
                result_ref,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let Some(root) = candidate.roots.get(&root_id) else {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                    continue;
                };
                let Some(child) = root.children().get(&child_id) else {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::ChildAttemptUnavailable,
                    )));
                    continue;
                };
                if child.status() == state::ChildStatus::Returned
                    && child.attempt().and_then(state::ChildAttempt::result_ref)
                        == Some(result_ref.as_str())
                {
                    let _ = reply.send(Ok(child.clone()));
                    continue;
                }
                let Some(attempt) = child.attempt() else {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::ChildAttemptUnavailable,
                    )));
                    continue;
                };
                let Some(execution_lease) = candidate.active_lease(attempt.execution_lease_id())
                else {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::UnknownLease)));
                    continue;
                };
                let changed = match candidate
                    .roots
                    .get_mut(&root_id)
                    .expect("root checked above")
                    .return_child_attempt(&child_id, expected_child_revision, result_ref)
                {
                    Ok(child) => child,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::TaskState(error)));
                        continue;
                    }
                };
                if let Err(error) = candidate.release(&execution_lease) {
                    let _ = reply.send(Err(ControlError::Admission(error)));
                    continue;
                }
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(changed));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::ReadRootRunForStart { request_id, reply } => {
                let _ = reply.send(
                    ledger
                        .root_runs
                        .values()
                        .find(|run| run.request_id == request_id)
                        .cloned()
                        .ok_or(ControlError::Admission(AdmissionError::RootRunNotFound)),
                );
            }
            ActorCommand::RootRunCommand { run_id, action, reply } => {
                if matches!(action, RootRunAction::Read) {
                    let _ = reply.send(ledger.root_runs.get(&run_id).cloned().ok_or(ControlError::Admission(AdmissionError::RootRunNotFound)));
                    continue;
                }
                let mut candidate = ledger.clone();
                let result = match action {
                    RootRunAction::Confirm(receipt) => root_runs::confirm(&mut candidate, &run_id, &receipt),
                    #[cfg(test)]
                    RootRunAction::Settle(receipt) => root_runs::settle(&mut candidate, &run_id, &receipt),
                    RootRunAction::FinishReasoner => store.dir.parent().ok_or(ControlError::Store(StoreError::Corrupt))
                        .and_then(|native| worker_completion::finish(&mut candidate, native, &run_id)),
                    RootRunAction::AbandonReasoner => worker_completion::abandon_before_spawn(&mut candidate, &run_id),
                    RootRunAction::SettleWorker => store.dir.parent().ok_or(ControlError::Store(StoreError::Corrupt))
                        .and_then(|native| worker_completion::finish(&mut candidate, native, &run_id))
                        .and_then(|run| root_runs::settle(&mut candidate, &run_id, run.worker_exit_receipt.as_deref().expect("verified worker exit"))),
                    RootRunAction::Read => unreachable!("read handled above"),
                };
                match result {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok(run) => match store.persist(&candidate, &profile) {
                        Ok(_) => {
                            ledger = candidate;
                            let _ = reply.send(Ok(run));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Store(error)));
                            break;
                        }
                    },
                }
            }
            ActorCommand::MutateRoot {
                id,
                expected_revision,
                mutation,
                reply,
            } => {
                let mut candidate = ledger.clone();
                if candidate.product_tasks.contains_key(&id) {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue;
                }
                if let RootMutation::StartAttempt { request_id } = &mutation {
                    let Some(root) = candidate.roots.get(&id) else {
                        let _ =
                            reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                        continue;
                    };
                    if root
                        .workspace_grant()
                        .is_some_and(|grant| !candidate.workspace_grant_is_current(grant))
                    {
                        let _ = reply.send(Err(ControlError::TaskState(
                            StateError::WorkspaceGrantStale,
                        )));
                        continue;
                    }
                    match root_runs::prepare(
                        &mut candidate,
                        &profile,
                        &id,
                        expected_revision,
                        request_id,
                    ) {
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                        Ok(root) => match store.persist(&candidate, &profile) {
                            Ok(_) => {
                                ledger = candidate;
                                let _ = reply.send(Ok(root));
                            }
                            Err(error) => {
                                let _ = reply.send(Err(ControlError::Store(error)));
                                break;
                            }
                        },
                    }
                    continue;
                }
                if matches!(
                    mutation,
                    RootMutation::RequestReview | RootMutation::AcceptReview(_)
                ) && (candidate
                    .root_runs
                    .values()
                    .any(|run| run.root_id == id && run.status != root_runs::RunStatus::Settled)
                    || generation::unsettled(&candidate, &id)
                    || canonical_runs::unsettled(&candidate, &id))
                {
                    let _ = reply.send(Err(ControlError::Admission(
                        AdmissionError::RootRunUnsettled,
                    )));
                    continue;
                }
                let (changed, invalidated_queue_ids) = {
                    let Some(root) = candidate.roots.get_mut(&id) else {
                        let _ =
                            reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                        continue;
                    };
                    let invalidate_children = matches!(
                        &mutation,
                        RootMutation::WaitForInput
                            | RootMutation::WaitForApproval
                            | RootMutation::Stop { .. }
                            | RootMutation::ReviseContract { .. }
                    );
                    let queued = if invalidate_children {
                        root.children()
                            .values()
                            .filter(|child| child.status() == state::ChildStatus::Queued)
                            .map(ChildTask::queue_lease_id)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let workspace_stale = root.workspace_grant().is_some_and(|fixed| {
                        candidate
                            .registry
                            .grant(&fixed.session_id, fixed.binding_revision)
                            .map_or(true, |current| &current != fixed)
                    });
                    let changed = if root.revision() != expected_revision {
                        Err(StateError::RevisionConflict)
                    } else if workspace_stale && !matches!(&mutation, RootMutation::Stop { .. }) {
                        Err(StateError::WorkspaceGrantStale)
                    } else {
                        match mutation {
                            RootMutation::StartAttempt { .. } => {
                                unreachable!("handled by native run admission")
                            }
                            RootMutation::WaitForInput => root.wait_for_input(expected_revision),
                            RootMutation::WaitForApproval => {
                                root.wait_for_approval(expected_revision)
                            }
                            RootMutation::Stop {
                                status,
                                cause,
                                reason,
                            } => root.stop(expected_revision, status, cause, reason),
                            RootMutation::ReviseContract { goal, criteria } => {
                                root.revise_contract(expected_revision, goal, criteria)
                            }
                            RootMutation::RecordCheck {
                                contract_revision,
                                requirement_id,
                                outcome,
                                receipt,
                            } => root.record_check(
                                expected_revision,
                                contract_revision,
                                &requirement_id,
                                outcome,
                                receipt,
                            ),
                            RootMutation::RequestReview => root.request_review(expected_revision),
                            RootMutation::AcceptReview(review) => {
                                root.accept_review(expected_revision, review)
                            }
                        }
                    };
                    (changed, queued)
                };
                if let Err(error) = changed {
                    let _ = reply.send(Err(ControlError::TaskState(error)));
                    continue;
                }
                let mut release_error = None;
                for lease_id in invalidated_queue_ids {
                    let Some(lease) = candidate.active_lease(lease_id) else {
                        release_error = Some(AdmissionError::UnknownLease);
                        break;
                    };
                    if let Err(error) = candidate.release(&lease) {
                        release_error = Some(error);
                        break;
                    }
                }
                if let Some(error) = release_error {
                    let _ = reply.send(Err(ControlError::Admission(error)));
                    continue;
                }
                let root = candidate
                    .roots
                    .get(&id)
                    .expect("root mutated above")
                    .clone();
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(root));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::ChargeBudget {
                root_id,
                expected_revision,
                kind,
                request_id,
                reply,
            } => {
                let Some(root) = ledger.roots.get(&root_id) else {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::RootNotFound)));
                    continue;
                };
                if root
                    .workspace_grant()
                    .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
                {
                    let _ = reply.send(Err(ControlError::TaskState(
                        StateError::WorkspaceGrantStale,
                    )));
                    continue;
                }
                let queued_child_leases = root
                    .children()
                    .values()
                    .filter(|child| child.status() == state::ChildStatus::Queued)
                    .map(ChildTask::queue_lease_id)
                    .collect::<Vec<_>>();
                let mut candidate = ledger.clone();
                let charged = candidate
                    .roots
                    .get_mut(&root_id)
                    .expect("root checked above")
                    .charge_budget(expected_revision, kind, request_id);
                let outcome = match charged {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::TaskState(error)));
                        continue;
                    }
                };
                if outcome == BudgetCharge::Duplicate {
                    let _ = reply.send(Ok((
                        outcome,
                        candidate
                            .roots
                            .get(&root_id)
                            .expect("root retained")
                            .clone(),
                    )));
                    continue;
                }
                if outcome == BudgetCharge::Exhausted {
                    let mut release_error = None;
                    for lease_id in queued_child_leases {
                        let Some(lease) = candidate.active_lease(lease_id) else {
                            release_error =
                                Some(ControlError::Admission(AdmissionError::UnknownLease));
                            break;
                        };
                        if let Err(error) = candidate.release(&lease) {
                            release_error = Some(ControlError::Admission(error));
                            break;
                        }
                    }
                    if let Some(error) = release_error {
                        let _ = reply.send(Err(error));
                        continue;
                    }
                }
                let updated = candidate
                    .roots
                    .get(&root_id)
                    .expect("root retained")
                    .clone();
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok((outcome, updated)));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::ReadRoot { id, reply } => {
                let result = ledger
                    .roots
                    .get(&id)
                    .cloned()
                    .ok_or(ControlError::Admission(AdmissionError::RootNotFound));
                let _ = reply.send(result);
            }
            ActorCommand::ReadRootsForSession { session_id, reply } => {
                let result = if valid_identity(&session_id) {
                    match ledger.roots_by_session.get(&session_id) {
                        Some(root_ids) => Ok(root_ids.iter().cloned().collect()),
                        None => Err(ControlError::Admission(AdmissionError::RootNotFound)),
                    }
                } else {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                };
                let _ = reply.send(result);
            }
            ActorCommand::ReadCandidateReceipt { commit_id, reply } => {
                let result = if valid_identity(&commit_id) {
                    Ok(ledger.candidate_receipts.get(&commit_id).cloned())
                } else {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                };
                let _ = reply.send(result);
            }
            ActorCommand::AdmitHostSession { session_id, reply } => {
                let result = if !valid_identity(&session_id) {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                } else if !admitted_host_sessions.contains(&session_id)
                    && admitted_host_sessions.len() >= MAX_ADMITTED_HOST_SESSIONS
                {
                    Err(ControlError::Admission(AdmissionError::HostSessionAdmissionFull))
                } else {
                    admitted_host_sessions.insert(session_id);
                    Ok(())
                };
                let _ = reply.send(result);
            }
            ActorCommand::ReleaseHostSessionAdmission { session_id, reply } => {
                let result = if !admitted_host_sessions.contains(&session_id) {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                } else {
                    let loaded = if ledger.product_tasks.contains_key(&session_id) {
                        publication::load(&ledger, &published_content, &session_id)
                    } else { host_sessions.load(&session_id).map_err(ControlError::Store) };
                    match loaded {
                        Ok(None) => { admitted_host_sessions.remove(&session_id); Ok(()) }
                        Ok(Some(_)) => Err(ControlError::Admission(AdmissionError::HostSessionAdmissionHasData)),
                        Err(error) => Err(error),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::LoadHostSession { session_id, reply } => {
                let result = if admitted_host_sessions.contains(&session_id) {
                    if ledger.product_tasks.contains_key(&session_id) {
                        publication::load(&ledger, &published_content, &session_id)
                    } else { host_sessions.load(&session_id).map_err(ControlError::Store) }
                } else {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                };
                let _ = reply.send(result);
            }
            ActorCommand::SaveHostSession { session_id, expected_revision, snapshot, reply } => {
                if ledger.product_tasks.contains_key(&session_id) {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue;
                }
                let result = if admitted_host_sessions.contains(&session_id) {
                    host_sessions.save(&session_id, expected_revision, snapshot).map_err(ControlError::Store)
                } else {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                };
                let fatal = matches!(&result, Err(ControlError::Store(error)) if !matches!(error, StoreError::SessionRevisionConflict | StoreError::TooLarge));
                let _ = reply.send(result);
                if fatal { break; }
            }
            ActorCommand::ListHostSessions { reply } => {
                let result = (|| {
                    let mut summaries = host_sessions.list();
                    for id in ledger.published_sessions.keys() {
                        let (_, snapshot) = publication::load(&ledger, &published_content, id)?.ok_or(ControlError::Store(StoreError::Corrupt))?;
                        summaries.push(host_sessions::validate_snapshot(id, &snapshot).map_err(ControlError::Store)?);
                    }
                    Ok(summaries)
                })();
                let _ = reply.send(result);
            }
            ActorCommand::RemoveHostSession { session_id, expected_revision, reply } => {
                if ledger.product_tasks.contains_key(&session_id) {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue;
                }
                let result = if admitted_host_sessions.contains(&session_id) {
                    host_sessions.remove(&session_id, expected_revision).map_err(ControlError::Store)
                } else {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                };
                let fatal = matches!(&result, Err(ControlError::Store(error)) if !matches!(error, StoreError::SessionRevisionConflict));
                if result.is_ok() { admitted_host_sessions.remove(&session_id); }
                let _ = reply.send(result);
                if fatal { break; }
            }
            ActorCommand::PlanHostSessionMigration { reply } => {
                let result = host_sessions.plan_legacy_import().map_err(ControlError::Store);
                let _ = reply.send(result);
            }
            ActorCommand::MigrateHostSessions { expected_digest, reply } => {
                if !ledger.product_tasks.is_empty() {
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue;
                }
                let result = host_sessions.migrate_legacy(&expected_digest).map_err(ControlError::Store);
                let fatal = matches!(&result, Err(ControlError::Store(error)) if !matches!(error, StoreError::SessionMigrationConflict | StoreError::TooLarge));
                let _ = reply.send(result);
                if fatal { break; }
            }
            ActorCommand::CheckExecutionFence { fence, reply } => {
                let result = match ledger.roots.get(fence.root_id()) {
                    None => Err(ControlError::Admission(AdmissionError::RootNotFound)),
                    Some(root) if root.status() != RootStatus::Running => Err(
                        ControlError::TaskState(StateError::InvalidTransition(root.status())),
                    ),
                    Some(root)
                        if root.revision() != fence.root_revision()
                            || root.contract_revision() != fence.contract_revision()
                            || root.cancellation_epoch() != fence.cancellation_epoch() =>
                    {
                        Err(ControlError::TaskState(StateError::ExecutionFenceStale))
                    }
                    Some(root)
                        if root
                            .workspace_grant()
                            .is_some_and(|grant| !ledger.workspace_grant_is_current(grant)) =>
                    {
                        Err(ControlError::TaskState(StateError::WorkspaceGrantStale))
                    }
                    Some(_) => Ok(()),
                };
                let _ = reply.send(result);
            }
            ActorCommand::AdmitCanonical { commit_id, reply } => {
                let mut next = ledger.clone();
                let result = canonical_runs::admit(&mut next, &profile, &canonical_content, &published_content, store.dir.parent().expect("native control parent"), &commit_id);
                match result {
                    Ok(invocation) => match store.persist(&next, &profile) {
                        Ok(_) => {
                            ledger = next;
                            // A failed send proves the sole launch object was
                            // never delivered. No process can have used it.
                            if let Err(undelivered) = reply.send(Ok(invocation)) {
                                let invocation = undelivered.0.expect("undelivered native admission");
                                let mut next = ledger.clone();
                                if canonical_runs::abandon_before_spawn(&mut next, invocation.id()).is_err() || store.persist(&next, &profile).is_err() { break; }
                                ledger = next;
                            }
                        }
                        Err(error) => { let _ = reply.send(Err(ControlError::Store(error))); break; }
                    },
                    Err(error) => { let _ = reply.send(Err(error)); }
                }
            }
            ActorCommand::CanonicalCommand { id, action, in_flight, reply } => {
                let mut next = ledger.clone();
                let read_only = matches!(action, CanonicalAction::Read);
                let result = match action {
                    CanonicalAction::Read => next.canonical_runs.get(&id).cloned().ok_or(ControlError::Admission(AdmissionError::WorkerCompletionUnavailable)),
                    CanonicalAction::Confirm(receipt) => canonical_runs::confirm(&mut next, &id, &receipt),
                    CanonicalAction::Finish(proposal) => canonical_runs::finish(&mut next, &published_content, store.dir.parent().expect("native control parent"), &id, proposal.map(|proposal| *proposal)),
                    CanonicalAction::AbandonBeforeSpawn => canonical_runs::abandon_before_spawn(&mut next, &id),
                };
                let result = result.and_then(|run| {
                    if !read_only {
                        store.persist(&next, &profile).map_err(ControlError::Store)?;
                        ledger = next;
                        published_content.cleanup(&ledger.published_sessions).map_err(|error| ControlError::Store(canonical_store_error(error)))?;
                    }
                    Ok(run)
                });
                if let Some(flag) = in_flight { flag.store(false, Ordering::Release); }
                let fatal = matches!(result, Err(ControlError::Store(_)));
                let _ = reply.send(result);
                if fatal { break; }
            }
            ActorCommand::ReadPublicationReceipt { commit_id, reply } => {
                let receipt = ledger.publication_receipts.values().find(|value| value.candidate.commit_id == commit_id).cloned();
                let _ = reply.send(Ok(receipt));
            }
            ActorCommand::CommitCandidate {
                request,
                app_worker,
                in_flight,
                reply,
            } => {
                if app_worker && (ledger.product_tasks.contains_key(&request.session_id) || ledger.product_tasks.contains_key(request.fence.root_id())) {
                    in_flight.store(false, Ordering::Release);
                    let _ = reply.send(Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable))); continue;
                }
                let result = commit_candidate(
                    store,
                    &profile,
                    &mut ledger,
                    &mut canonical_content,
                    request,
                );
                let fatal = matches!(result, Err(ControlError::Store(_)));
                in_flight.store(false, Ordering::Release);
                let _ = reply.send(result);
                if fatal {
                    break;
                }
            }
            ActorCommand::CreateProject { id, name, reply } => {
                let project = match ProjectRecord::new(id, name) {
                    Ok(project) => project,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Registry(error)));
                        continue;
                    }
                };
                let mut candidate = ledger.clone();
                if let Err(error) = candidate.registry.create_project(project.clone()) {
                    let _ = reply.send(Err(ControlError::Registry(error)));
                    continue;
                }
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(project));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::RegisterWorkspace { id, path, reply } => {
                let mut candidate = ledger.clone();
                let workspace =
                    match candidate
                        .registry
                        .register_workspace(id, &path, &workspace_admission)
                    {
                        Ok(workspace) => workspace,
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Registry(error)));
                            continue;
                        }
                    };
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(workspace));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::BindWorkspace {
                id,
                session_id,
                workspace_id,
                realm_id,
                mode,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let binding =
                    match candidate
                        .registry
                        .bind(id, session_id, workspace_id, realm_id, mode)
                    {
                        Ok(binding) => binding,
                        Err(error) => {
                            let _ = reply.send(Err(ControlError::Registry(error)));
                            continue;
                        }
                    };
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(binding));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::SetProjectMembership {
                session_id,
                project_id,
                expected_revision,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let membership = match candidate.registry.set_membership(
                    session_id,
                    project_id,
                    expected_revision,
                ) {
                    Ok(membership) => membership,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Registry(error)));
                        continue;
                    }
                };
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(membership));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::ReadProjectMembership { session_id, reply } => {
                let _ = reply.send(ledger.registry.membership(&session_id));
            }
            ActorCommand::SetProjectPreferredWorkspace {
                project_id,
                expected_revision,
                workspace_id,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let project = match candidate.registry.set_project_preferred_workspace(
                    &project_id,
                    expected_revision,
                    workspace_id,
                ) {
                    Ok(project) => project,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Registry(error)));
                        continue;
                    }
                };
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(project));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::RevokeWorkspace {
                session_id,
                expected_revision,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let binding = match candidate.registry.revoke(&session_id, expected_revision) {
                    Ok(binding) => binding,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Registry(error)));
                        continue;
                    }
                };
                if let Err(error) = candidate.invalidate_queued_children_for_session(&session_id) {
                    let _ = reply.send(Err(error));
                    continue;
                }
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(binding));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::RebindWorkspace {
                session_id,
                expected_revision,
                workspace_id,
                realm_id,
                mode,
                reply,
            } => {
                let mut candidate = ledger.clone();
                let binding = match candidate.registry.rebind(
                    &session_id,
                    expected_revision,
                    workspace_id,
                    realm_id,
                    mode,
                ) {
                    Ok(binding) => binding,
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Registry(error)));
                        continue;
                    }
                };
                if let Err(error) = candidate.invalidate_queued_children_for_session(&session_id) {
                    let _ = reply.send(Err(error));
                    continue;
                }
                match store.persist(&candidate, &profile) {
                    Ok(_) => {
                        ledger = candidate;
                        let _ = reply.send(Ok(binding));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(ControlError::Store(error)));
                        break;
                    }
                }
            }
            ActorCommand::ReadWorkspaceGrant {
                session_id,
                expected_revision,
                reply,
            } => {
                let grant = ledger
                    .registry
                    .grant(&session_id, expected_revision)
                    .map_err(ControlError::Registry);
                let _ = reply.send(grant);
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

    fn root_start() -> RootMutation {
        RootMutation::StartAttempt {
            request_id: format!(
                "native-start-{}",
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        }
    }

    #[test]
    fn product_tasks_have_one_native_writer_and_recover_without_worker_replay() {
        use tasks::{TaskCommand, TaskRequest};
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = CapacityProfile::unconfigured().unwrap();
        let request: TaskRequest = serde_json::from_value(serde_json::json!({
            "id":"product-task", "goal":"Prepare a checked report", "criteria":"Check original inputs and saved output", "provider":"ollama", "model":"qwen3.5:4b-mlx",
            "integrations":[],"confirmedFree":[],"spending":{"kind":"local_only"},"limits":{"runs":2,"modelRequests":12,"toolCalls":0,"activeMs":300000},
            "inputs":[{"name":"source.txt","content":"Original input"}],"output":{"kind":"markdown"},"diagnosticDays":0
        })).unwrap();
        let actor = ControlActor::open(&data, "unconfigured-v1", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        handle.admit_host_session("existing-chat".into()).unwrap();
        handle.save_host_session("existing-chat".into(), 0, serde_json::json!({"id":"existing-chat","title":"Existing chat","created":"2026-10-30T00:00:00.000Z","updated":"2026-10-30T00:00:00.000Z","messages":[],"timeline":[],"surfaces":[],"external":[]})).unwrap();
        let mut collision = request.clone(); collision.id = "existing-chat".into();
        assert_eq!(handle.product_task(TaskCommand::Create { request: Box::new(collision) }), Err(ControlError::Admission(AdmissionError::DuplicateRoot)));
        let created = handle.product_task(TaskCommand::Create { request: Box::new(request.clone()) }).unwrap();
        assert_eq!(created["state"], "queued");
        assert_eq!(created["runs"], 0);
        assert_eq!(created["inputs"][0]["sha256"], canonical::digest(b"Original input"));
        let shadow = RootCreate {
            local_model: None,
            id: "shadow-root".into(), session_id: Some(request.id.clone()),
            goal: request.goal.clone(), criteria: request.criteria.clone(), run_limit: 2,
            budget_limits: BudgetLimits::new(12, 0).unwrap(),
            requirements: vec![Requirement::new("check".into(), true).unwrap()],
            delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
        };
        assert_eq!(handle.create_root_with_budget(shadow), Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)));
        assert_eq!(handle.mutate_root("product-task".into(), 1, root_start()), Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)));
        let root = handle.read_root("product-task".into()).unwrap();
        assert_eq!(handle.commit_app_candidate(CandidateCommitRequest { session_id: "product-task".into(), commit_id: "forged-app-task-candidate".into(), fence: root.execution_fence(), expected_canonical_revision: 0, candidate_bytes: br#"{"session":"product-task","surfaces":[]}"#.to_vec() }), Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)));
        assert_eq!(handle.product_task(TaskCommand::Create { request: Box::new(request.clone()) }).unwrap(), created);
        let mut changed = request.clone(); changed.goal = "Changed request".into();
        assert!(handle.product_task(TaskCommand::Create { request: Box::new(changed) }).is_err());
        assert_eq!(handle.save_host_session("product-task".into(), 0, serde_json::json!({})), Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)));
        assert_eq!(handle.product_task(TaskCommand::Cancel { id: "product-task".into(), revision: 2 }), Err(ControlError::TaskState(StateError::RevisionConflict)));
        assert_eq!(handle.product_task(TaskCommand::Remove { id: "product-task".into(), revision: 1 }), Err(ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)));
        drop(handle); drop(actor);
        let reopened = ControlActor::open(&data, "unconfigured-v1", profile, 16, timeout).unwrap();
        let handle = reopened.handle();
        assert_eq!(handle.product_task(TaskCommand::Read { id: "product-task".into() }).unwrap(), created);
        assert_eq!(handle.product_task(TaskCommand::List).unwrap().as_array().unwrap().len(), 1);
        let cancelled = handle.product_task(TaskCommand::Cancel { id: "product-task".into(), revision: 1 }).unwrap();
        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(handle.product_task(TaskCommand::Remove { id: "product-task".into(), revision: 1 }), Err(ControlError::TaskState(StateError::RevisionConflict)));
        handle.product_task(TaskCommand::Remove { id: "product-task".into(), revision: 2 }).unwrap();
        assert!(handle.product_task(TaskCommand::List).unwrap().as_array().unwrap().is_empty());
        assert_eq!(handle.read_root("product-task".into()), Err(ControlError::Admission(AdmissionError::RootNotFound)));
        assert!(!data.join("tasks").exists());
        drop(handle); drop(reopened); remove_test_data(&data);
    }

    #[test]
    fn native_worker_completion_is_exact_private_and_retains_charges_across_restart() {
        let data = temp_data_dir();
        let profile = CapacityProfile::new(BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1)]), BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1)]), 32).unwrap();
        let actor = ControlActor::open(&data, "one-slot", profile.clone(), 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        for id in ["first", "second"] {
            handle.create_root(id.into(), "Bound work".into(), "Original outcome".into(), 2, vec![Requirement::new("check".into(), true).unwrap()]).unwrap();
        }
        let root = handle.mutate_root("first".into(), 1, RootMutation::StartAttempt { request_id: "start-1".into() }).unwrap();
        let run = handle.read_root_run_for_start("start-1".into()).unwrap();
        let invocation = handle.prepare_worker_completion(run.id.clone()).unwrap();
        let unavailable = Err(ControlError::Admission(AdmissionError::WorkerCompletionUnavailable));
        assert_eq!(handle.settle_worker_completion(run.id.clone()), unavailable);
        let write = |value: serde_json::Value| {
            let mut options = fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut file = options.open(&invocation.completion_record).unwrap();
            file.write_all(&serde_json::to_vec(&value).unwrap()).unwrap(); file.sync_all().unwrap();
        };
        let valid = serde_json::json!({"version":1,"invocation_id":run.id,"cleanup_verified":true,"exit_code":126});
        for bad in [
            serde_json::json!({"version":1,"invocation_id":run.id,"cleanup_verified":false,"exit_code":null}),
            serde_json::json!({"version":1,"invocation_id":"wrong-run","cleanup_verified":true,"exit_code":0}),
            serde_json::json!({"version":2,"invocation_id":run.id,"cleanup_verified":true,"exit_code":0}),
            serde_json::json!({"version":1,"invocation_id":run.id,"cleanup_verified":true,"exit_code":256}),
            serde_json::json!({"version":1,"invocation_id":run.id,"cleanup_verified":true,"exit_code":0,"extra":true}),
        ] {
            write(bad); assert_eq!(handle.settle_worker_completion(run.id.clone()), unavailable);
        }
        assert!(handle.prepare_worker_completion(run.id.clone()).is_err(), "existing evidence cannot be reset");
        write(valid.clone());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&invocation.completion_record, fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(handle.settle_worker_completion(run.id.clone()), unavailable);
            fs::set_permissions(&invocation.completion_record, fs::Permissions::from_mode(0o600)).unwrap();
            let saved = invocation.completion_record.with_extension("saved");
            fs::rename(&invocation.completion_record, &saved).unwrap();
            std::os::unix::fs::symlink(&saved, &invocation.completion_record).unwrap();
            assert_eq!(handle.settle_worker_completion(run.id.clone()), unavailable);
            fs::remove_file(&invocation.completion_record).unwrap(); fs::rename(saved, &invocation.completion_record).unwrap();
        }
        write(serde_json::json!({"version":1,"invocation_id":run.id,"cleanup_verified":false,"exit_code":null}));
        handle.confirm_root_started(run.id.clone(), "native-supervisor".into()).unwrap();
        handle.mutate_root(root.id().into(), root.revision(), RootMutation::Stop { status: RootStatus::Cancelled, cause: StopCause::UserCancelled, reason: "User cancelled".into() }).unwrap();
        drop(handle); drop(actor);
        let actor = ControlActor::open(&data, "one-slot", profile, 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        assert_eq!(handle.read_root_run(run.id.clone()).unwrap().status, root_runs::RunStatus::Interrupted);
        assert_eq!(handle.settle_worker_completion(run.id.clone()), unavailable);
        assert!(handle.mutate_root("second".into(), 1, RootMutation::StartAttempt { request_id: "start-second".into() }).is_err());
        write(valid);
        let settled = handle.settle_worker_completion(run.id.clone()).unwrap();
        assert_eq!(settled.status, root_runs::RunStatus::Settled);
        assert!(settled.exit_receipt.as_ref().unwrap().starts_with(&format!("worker-exit-{}-", run.id)));
        assert_eq!(handle.settle_worker_completion(run.id.clone()).unwrap(), settled);
        write(serde_json::json!({"version":1,"invocation_id":run.id,"cleanup_verified":true,"exit_code":127}));
        assert_eq!(handle.settle_worker_completion(run.id.clone()), Err(ControlError::Admission(AdmissionError::ConflictingRequestIdentity)));
        assert_eq!(handle.read_root("first".into()).unwrap().status(), RootStatus::Cancelled);
        assert_eq!(handle.mutate_root("second".into(), 1, RootMutation::StartAttempt { request_id: "start-second".into() }).unwrap().status(), RootStatus::Running);
        drop(handle); drop(actor); remove_test_data(&data);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "requires reviewed helper and Node paths in VAK_TEST_WORKER_HELPER and VAK_TEST_WORKER_NODE"]
    fn contained_worker_cleanup_settles_native_run_after_cancel_and_restart() {
        use std::io::BufRead;
        use std::process::Stdio;
        let helper = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_HELPER").expect("reviewed helper required"));
        let node = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_NODE").expect("Node required"));
        let data = temp_data_dir();
        let resources = data.with_extension("runtime"); fs::create_dir_all(&resources).unwrap();
        let app_private = data.join("worker/private"); fs::create_dir_all(app_private.parent().unwrap()).unwrap(); fs::write(&app_private, b"app-private").unwrap();
        let sibling_private = data.join("task-workers/run-999999/private"); fs::create_dir_all(sibling_private.parent().unwrap()).unwrap(); fs::write(&sibling_private, b"sibling-private").unwrap();
        let hostile = format!(r#"import fs from 'node:fs'; import {{Socket}} from 'node:net';
for (const target of [{}, {}]) {{ let denied=false; try {{fs.readFileSync(target);}} catch(error) {{denied=['EPERM','EACCES'].includes(error.code);}} if(!denied) throw Error('role grant escaped'); }}
if(process.env.VAK_NPM_CLI || process.env.VAK_SANDBOX_BIN) throw Error('app capability inherited');
fs.writeFileSync(process.env.VAK_DATA_DIR+'/positive','scratch-write-ok');
const io=new Socket({{fd:3,readable:true,writable:true}}); io.write('ready\n'); io.on('end',()=>{{}}); setInterval(()=>{{}},1000);
"#, serde_json::to_string(&app_private).unwrap(), serde_json::to_string(&sibling_private).unwrap());
        fs::write(resources.join("task-worker.mjs"), hostile).unwrap();
        let profile = CapacityProfile::new(BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1)]), BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1)]), 32).unwrap();
        let actor = ControlActor::open(&data, "one-slot", profile.clone(), 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        let root = handle.create_root("root".into(), "Bound work".into(), "Original outcome".into(), 2, vec![Requirement::new("check".into(), true).unwrap()]).unwrap();
        let root = handle.mutate_root(root.id().into(), root.revision(), RootMutation::StartAttempt { request_id: "start-1".into() }).unwrap();
        let run = handle.read_root_run_for_start("start-1".into()).unwrap();
        let invocation = handle.prepare_worker_completion(run.id.clone()).unwrap();
        let mut child = crate::worker::command_for_invocation(&helper, &node, &resources, &data, &invocation).unwrap()
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let owner = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (ready_tx, ready_rx) = sync_channel(1);
        thread::spawn(move || { let mut line = String::new(); let _ = std::io::BufReader::new(stdout).read_line(&mut line); let _ = ready_tx.send(line); });
        if ready_rx.recv_timeout(Duration::from_secs(15)).as_deref() != Ok("ready\n") {
            drop(owner); let _ = child.kill(); let _ = child.wait();
            let mut diagnostics = String::new();
            if let Some(stderr) = child.stderr.take() { let _ = stderr.take(4096).read_to_string(&mut diagnostics); }
            panic!("contained worker did not start: {diagnostics}");
        }
        handle.confirm_root_started(run.id.clone(), format!("supervisor-{}", run.id)).unwrap();
        handle.mutate_root(root.id().into(), root.revision(), RootMutation::Stop { status: RootStatus::Cancelled, cause: StopCause::UserCancelled, reason: "User cancelled".into() }).unwrap();
        assert_eq!(handle.settle_worker_completion(run.id.clone()), Err(ControlError::Admission(AdmissionError::WorkerCompletionUnavailable)));
        drop(handle); drop(actor);
        let actor = ControlActor::open(&data, "one-slot", profile, 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        assert_eq!(handle.read_root_run(run.id.clone()).unwrap().status, root_runs::RunStatus::Interrupted);
        drop(owner);
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); panic!("contained worker did not stop on owner EOF"); }
            thread::sleep(Duration::from_millis(10));
        }
        let settled = handle.settle_worker_completion(run.id.clone()).unwrap();
        assert_eq!(settled.status, root_runs::RunStatus::Settled);
        assert_eq!(handle.settle_worker_completion(run.id).unwrap(), settled);
        assert_eq!(handle.read_root(root.id().into()).unwrap().status(), RootStatus::Cancelled);
        assert_eq!(fs::read(data.join("task-workers").join(&invocation.run_id).join("positive")).unwrap(), b"scratch-write-ok");
        assert_eq!(fs::read(app_private).unwrap(), b"app-private"); assert_eq!(fs::read(sibling_private).unwrap(), b"sibling-private");
        drop(handle); drop(actor); remove_test_data(&data); fs::remove_dir_all(resources).unwrap();
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[ignore = "requires reviewed helper, Node paths, and bundled resources/task-worker.mjs"]
    fn bundled_reasoner_uses_bound_provider_proposals_without_app_or_canonical_authority() {
        use std::io::BufRead;
        use std::process::Stdio;
        use task_protocol::{Event, TaskChannel};
        let helper = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_HELPER").expect("reviewed helper required"));
        let node = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_NODE").expect("Node required"));
        let data = temp_data_dir();
        let resources = data.with_extension("task-runtime"); fs::create_dir_all(&resources).unwrap();
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/task-worker.mjs"), resources.join("task-worker.mjs")).expect("bundle the task worker before running this gate");
        let profile = CapacityProfile::new(BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1), (Resource::ProviderRequest, 1)]), BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1), (Resource::ProviderRequest, 1)]), 32).unwrap();
        let actor = ControlActor::open(&data, "one-slot", profile, 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        let root = handle.create_root_with_budget(RootCreate {
            local_model: Some(state::LocalModelPolicy { model: "qwen3.5:4b-mlx".into(), max_output_tokens: 256, max_request_bytes: 8_388_608 }),
            id: "root".into(), session_id: Some("task-session".into()), goal: "Check explicit context".into(), criteria: "Never publish a refused generation".into(), run_limit: 2,
            budget_limits: BudgetLimits::new(1, 0).unwrap(), requirements: vec![Requirement::new("check".into(), true).unwrap()], delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
        }).unwrap();
        let root = handle.mutate_root(root.id().into(), root.revision(), RootMutation::StartAttempt { request_id: "start-1".into() }).unwrap();
        let run = handle.read_root_run_for_start("start-1".into()).unwrap();
        let invocation = handle.prepare_worker_completion(run.id.clone()).unwrap();
        let mut protocol = TaskChannel::new(&run, "qwen3.5:4b-mlx".into()).unwrap();
        let mut child = crate::worker::command_for_invocation(&helper, &node, &resources, &data, &invocation).unwrap()
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let mut owner = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (frames_tx, frames_rx) = sync_channel(2);
        thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                if !matches!(reader.by_ref().take(task_protocol::MAX_FRAME as u64 + 1).read_until(b'\n', &mut bytes), Ok(count) if count > 0 && count <= task_protocol::MAX_FRAME && bytes.ends_with(b"\n")) { break; }
                if frames_tx.send(bytes).is_err() { break; }
            }
        });
        let receive = |protocol: &mut TaskChannel| protocol.receive(&frames_rx.recv_timeout(Duration::from_secs(15)).expect("bounded task response")).expect("native reasoning protocol");
        assert!(matches!(receive(&mut protocol), Event::Ready));
        handle.confirm_root_started(run.id.clone(), format!("supervisor-{}", run.id)).unwrap(); protocol.start().unwrap();
        let job = serde_json::json!({"v":2,"type":"task_start","job":{"runId":run.id,"session":"task-session","provider":"ollama","model":"qwen3.5:4b-mlx","goal":"Check explicit context","criteria":"Never publish a refused generation","instructions":"","inputs":[],"initialSurfaces":[],"maxSteps":1,"maxTokens":256,"activeMs":10000}});
        owner.write_all(format!("{job}\n").as_bytes()).unwrap();
        let Event::Provider(proposal) = receive(&mut protocol) else { panic!("expected a bound provider proposal"); };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&proposal.body).unwrap()["model"], "qwen3.5:4b-mlx");
        assert!(!proposal.operation_id.is_empty()); assert_eq!(proposal.attempt, 0);
        // The Rust test controller simulates the trusted approval interaction;
        // this is not product UI consent and no model/network request is sent.
        let ticket = handle.issue_provider_approval(run.id.clone(), proposal.operation_id.clone(), proposal.attempt, proposal.body.as_bytes().to_vec()).unwrap();
        assert_eq!(handle.read_root(root.id().into()).unwrap().model_requests_used(), 0);
        let dispatch = handle.decide_provider_approval(ticket.ticket_id.clone(), ticket.fingerprint.clone(), generation::Decision::AllowOnce).unwrap();
        let (operation, permit, exact_bytes) = dispatch.into_request();
        assert_eq!(exact_bytes, broker::prepare_generation_body(&permit, proposal.body.as_bytes()).unwrap());
        assert_eq!(handle.read_root(root.id().into()).unwrap().model_requests_used(), 1);
        assert!(handle.decide_provider_approval(ticket.ticket_id, ticket.fingerprint, generation::Decision::AllowOnce).is_err());
        handle.settle_provider_operation(operation.id, generation::ResultReceipt { outcome: generation::IoOutcome::NotDispatched, id: "harness-refused-before-network".into(), status_code: None, response_bytes: 0 }).unwrap();
        protocol.finish_provider(&proposal.id).unwrap();
        owner.write_all(format!("{}\n", serde_json::json!({"v":2,"id":proposal.id,"type":"provider_error","message":"Native provider dispatch is not enabled"})).as_bytes()).unwrap();
        let Event::Candidate(candidate) = receive(&mut protocol) else { panic!("expected the retained failed candidate"); };
        assert_eq!(candidate["result"]["stop"], "error"); assert_eq!(candidate["surfaces"], serde_json::json!([]));
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline { drop(owner); let _ = child.kill(); let _ = child.wait(); panic!("task worker did not exit"); }
            thread::sleep(Duration::from_millis(10));
        }
        drop(owner);
        let root = handle.read_root(root.id().into()).unwrap();
        handle.mutate_root(root.id().into(), root.revision(), RootMutation::Stop { status: RootStatus::Failed, cause: StopCause::ExecutionError, reason: "Provider dispatch was refused".into() }).unwrap();
        assert_eq!(handle.settle_worker_completion(run.id).unwrap().status, root_runs::RunStatus::Settled);
        assert_eq!(handle.read_root(root.id().into()).unwrap().status(), RootStatus::Failed);
        assert!(handle.list_host_sessions().unwrap().is_empty());
        assert!(!data.join("worker").exists()); assert!(!data.join("task-workers").join(&invocation.run_id).join("sessions").exists());
        drop(handle); drop(actor); remove_test_data(&data); fs::remove_dir_all(resources).unwrap();
    }

    #[test]
    fn native_root_run_holds_capacity_until_supervisor_exit_and_recovers_exactly() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 1)]),
            BTreeMap::from([(Resource::Generation, 1)]),
            32,
        )
        .unwrap();
        let actor = ControlActor::open(&data, "one-slot", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        let create = |id: &str| {
            handle
                .create_root_with_budget(RootCreate {
            local_model: None,
                    id: id.into(),
                    session_id: Some("shared-chat".into()),
                    goal: "Perform bounded work".into(),
                    criteria: "Require independently checked output".into(),
                    run_limit: 2,
                    budget_limits: BudgetLimits::new(2, 2).unwrap(),
                    requirements: vec![Requirement::new("output".into(), true).unwrap()],
                    delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0)
                        .unwrap(),
                })
                .unwrap()
        };
        let first = create("first-root");
        let second = create("second-root");
        let start = || RootMutation::StartAttempt {
            request_id: "first-launch".into(),
        };
        let callers: Vec<_> = (0..8)
            .map(|_| {
                let handle = handle.clone();
                let id = first.id().to_owned();
                let revision = first.revision();
                thread::spawn(move || {
                    handle.mutate_root(
                        id,
                        revision,
                        RootMutation::StartAttempt {
                            request_id: "first-launch".into(),
                        },
                    )
                })
            })
            .collect();
        let roots: Vec<_> = callers
            .into_iter()
            .map(|caller| caller.join().unwrap().unwrap())
            .collect();
        let running = roots[0].clone();
        assert!(roots.iter().all(|root| root == &running));
        assert_eq!(
            handle
                .mutate_root(first.id().into(), first.revision(), start())
                .unwrap(),
            running
        );
        let run = handle
            .read_root_run_for_start("first-launch".into())
            .unwrap();
        assert_eq!(
            handle.release(Lease {
                id: run.lease_id,
                request_id: run.request_id.clone(),
                root_id: run.root_id.clone(),
                amounts: ask(Resource::Generation, 1)
            }),
            Err(ControlError::Admission(AdmissionError::ReservedForControl(
                Resource::Generation
            )))
        );
        assert_eq!(run.status, root_runs::RunStatus::Prepared);
        assert_eq!(run.session_id.as_deref(), Some("shared-chat"));
        assert_eq!(
            handle.mutate_root(second.id().into(), second.revision(), root_start()),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::Generation)
            ))
        );
        assert_eq!(handle.read_root(second.id().into()).unwrap(), second);
        let launched = handle
            .confirm_root_started(run.id.clone(), "supervisor-first".into())
            .unwrap();
        assert_eq!(launched.status, root_runs::RunStatus::Running);
        assert_eq!(
            handle
                .confirm_root_started(run.id.clone(), "supervisor-first".into())
                .unwrap(),
            launched
        );
        assert_eq!(
            handle.mutate_root(
                running.id().into(),
                running.revision(),
                RootMutation::RequestReview
            ),
            Err(ControlError::Admission(AdmissionError::RootRunUnsettled))
        );
        let stopped = handle
            .mutate_root(
                running.id().into(),
                running.revision(),
                RootMutation::Stop {
                    status: RootStatus::Cancelled,
                    cause: StopCause::UserCancelled,
                    reason: "User cancelled the task".into(),
                },
            )
            .unwrap();
        assert_eq!(stopped.status(), RootStatus::Cancelled);
        assert_eq!(
            handle.mutate_root(second.id().into(), second.revision(), root_start()),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::Generation)
            ))
        );
        drop(handle);
        drop(actor);
        let reopened = ControlActor::open(&data, "one-slot", profile, 16, timeout).unwrap();
        let handle = reopened.handle();
        assert_eq!(
            handle.read_root_run(run.id.clone()).unwrap().status,
            root_runs::RunStatus::Interrupted
        );
        assert_eq!(
            handle.mutate_root(second.id().into(), second.revision(), root_start()),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::Generation)
            ))
        );
        let settled = handle
            .settle_root_exit(run.id.clone(), "supervisor-exit-first".into())
            .unwrap();
        assert_eq!(settled.status, root_runs::RunStatus::Settled);
        assert_eq!(
            handle
                .settle_root_exit(run.id.clone(), "supervisor-exit-first".into())
                .unwrap(),
            settled
        );
        assert_eq!(
            handle.settle_root_exit(run.id.clone(), "different-exit".into()),
            Err(ControlError::Admission(
                AdmissionError::ConflictingRequestIdentity
            ))
        );
        let second_running = handle
            .mutate_root(
                second.id().into(),
                second.revision(),
                RootMutation::StartAttempt {
                    request_id: "second-launch".into(),
                },
            )
            .unwrap();
        assert_eq!(second_running.status(), RootStatus::Running);
        let second_run = handle
            .read_root_run_for_start("second-launch".into())
            .unwrap();
        assert_eq!(
            handle.confirm_root_started(second_run.id.clone(), "supervisor-first".into()),
            Err(ControlError::Admission(
                AdmissionError::ConflictingRequestIdentity
            ))
        );
        let waiting = handle
            .mutate_root(
                second_running.id().into(),
                second_running.revision(),
                RootMutation::WaitForInput,
            )
            .unwrap();
        assert_eq!(
            handle.confirm_root_started(second_run.id.clone(), "late-supervisor-second".into()),
            Err(ControlError::TaskState(StateError::ExecutionFenceStale))
        );
        let revised = handle
            .mutate_root(
                waiting.id().into(),
                waiting.revision(),
                RootMutation::ReviseContract {
                    goal: "Continue the same bounded work".into(),
                    criteria: "Check current evidence".into(),
                },
            )
            .unwrap();
        assert_eq!(
            handle.mutate_root(revised.id().into(), revised.revision(), root_start()),
            Err(ControlError::Admission(AdmissionError::RootRunUnsettled))
        );
        handle
            .settle_root_exit(second_run.id, "exit-second".into())
            .unwrap();
        assert_eq!(
            handle
                .mutate_root(revised.id().into(), revised.revision(), root_start())
                .unwrap()
                .runs_started(),
            2
        );
        assert_eq!(
            handle.read_root(first.id().into()).unwrap().runs_started(),
            1
        );
        drop(handle);
        drop(reopened);
        remove_test_data(&data);
    }

    #[test]
    fn native_root_start_requires_configured_capacity_and_cannot_adopt_generic_lease() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let actor = ControlActor::open(
            &data,
            "no-execution",
            CapacityProfile::unconfigured().unwrap(),
            8,
            timeout,
        )
        .unwrap();
        let handle = actor.handle();
        let root = handle
            .create_root(
                "root".into(),
                "Bound work".into(),
                "Checked output".into(),
                2,
                vec![Requirement::new("check".into(), true).unwrap()],
            )
            .unwrap();
        assert_eq!(
            handle.mutate_root(root.id().into(), root.revision(), root_start()),
            Err(ControlError::Admission(
                AdmissionError::UnconfiguredResource(Resource::Generation)
            ))
        );
        assert_eq!(handle.read_root(root.id().into()).unwrap(), root);
        drop(handle);
        drop(actor);
        remove_test_data(&data);
        let data = temp_data_dir();
        let actor = ControlActor::open(&data, "configured", profile(), 8, timeout).unwrap();
        let handle = actor.handle();
        let root = handle
            .create_root(
                "root".into(),
                "Bound work".into(),
                "Checked output".into(),
                2,
                vec![Requirement::new("check".into(), true).unwrap()],
            )
            .unwrap();
        let lease = handle
            .reserve(
                "reserved".into(),
                root.id().into(),
                ask(Resource::Generation, 1),
            )
            .unwrap();
        assert_eq!(
            handle.mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt {
                    request_id: "reserved".into()
                }
            ),
            Err(ControlError::Admission(
                AdmissionError::ConflictingRequestIdentity
            ))
        );
        handle.release(lease).unwrap();
        assert_eq!(handle.read_root(root.id().into()).unwrap(), root);
        drop(handle);
        drop(actor);
        remove_test_data(&data);
    }

    #[test]
    fn root_run_recovery_rejects_missing_lease_mismatched_session_and_fake_settlement() {
        let mut ledger = CapacityLedger::default();
        let root = RootTask::create_with_grant(
            RootCreate {
            local_model: None,
                id: "root".into(),
                session_id: Some("chat".into()),
                goal: "Bound work".into(),
                criteria: "Checked output".into(),
                run_limit: 2,
                budget_limits: BudgetLimits::new(2, 2).unwrap(),
                requirements: vec![Requirement::new("check".into(), true).unwrap()],
                delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
            },
            None,
        )
        .unwrap();
        ledger.roots.insert("root".into(), root);
        root_runs::prepare(&mut ledger, &profile(), "root", 1, "launch").unwrap();
        assert_eq!(root_runs::validate(&ledger), Ok(()));
        let mut bad = ledger.clone();
        bad.root_runs.clear();
        assert!(matches!(
            CapacityLedger::restore(bad.snapshot(), &profile()),
            Err(StoreError::Corrupt)
        ));
        let mut bad = ledger.clone();
        bad.root_runs.get_mut("run-1").unwrap().session_id = Some("another-chat".into());
        assert!(matches!(
            CapacityLedger::restore(bad.snapshot(), &profile()),
            Err(StoreError::Corrupt)
        ));
        let mut bad = ledger.clone();
        bad.root_runs.get_mut("run-1").unwrap().status = root_runs::RunStatus::Settled;
        assert!(matches!(
            CapacityLedger::restore(bad.snapshot(), &profile()),
            Err(StoreError::Corrupt)
        ));
        let mut bad = ledger.clone();
        bad.active.clear();
        assert!(matches!(
            CapacityLedger::restore(bad.snapshot(), &profile()),
            Err(StoreError::Corrupt)
        ));
    }

    fn profile() -> CapacityProfile {
        CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 2), (Resource::ContainedProcess, 4)]),
            BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 2)]),
            8,
        )
        .unwrap()
    }

    #[test]
    fn unconfigured_profile_keeps_metadata_available_but_refuses_all_capacity() {
        let profile = CapacityProfile::unconfigured().unwrap();
        let mut ledger = CapacityLedger::default();
        assert_eq!(
            ledger.reserve(
                &profile,
                "request-1",
                "root-1",
                BTreeMap::from([(Resource::Generation, 1)]),
            ),
            Err(AdmissionError::UnconfiguredResource(Resource::Generation))
        );
        assert_eq!(ledger.active_leases(), 0);

        let data = temp_data_dir();
        fs::create_dir_all(&data).unwrap();
        let actor = ControlActor::open(
            &data,
            "unconfigured-test",
            profile,
            32,
            Duration::from_secs(1),
        )
        .unwrap();
        let handle = actor.handle();
        let request = serde_json::from_value(serde_json::json!({
            "id": "unconf-task",
            "goal": "Test goal",
            "criteria": "Test criteria",
            "provider": "ollama",
            "model": "qwen3.5:4b-mlx",
            "integrations": [],
            "confirmedFree": [],
            "spending": {"kind": "local_only"},
            "limits": {"runs": 1, "modelRequests": 1, "toolCalls": 0, "activeMs": 1000},
            "inputs": [],
            "diagnosticDays": 0
        })).unwrap();
        handle.product_task(tasks::TaskCommand::Create { request: Box::new(request) }).unwrap();
        let admit_err = handle.admit_product_run("unconf-task".into(), 1, "req-1".into());
        assert_eq!(admit_err, Err(ControlError::Admission(AdmissionError::UnconfiguredResource(Resource::Generation))));
        let task_admit_err = handle.product_task(tasks::TaskCommand::AdmitRun {
            id: "unconf-task".into(),
            revision: 1,
            request_id: "req-2".into(),
        });
        assert_eq!(task_admit_err, Err(ControlError::Admission(AdmissionError::UnconfiguredResource(Resource::Generation))));
        let view = handle.product_task(tasks::TaskCommand::Read { id: "unconf-task".into() }).unwrap();
        assert_eq!(view["state"], "queued");
        drop(actor);
        remove_test_data(&data);
    }

    #[test]
    fn metadata_only_actor_owns_and_releases_its_single_writer_store() {
        let data = temp_data_dir();
        fs::create_dir_all(&data).unwrap();
        let open = || {
            ControlActor::open(
                &data,
                "unconfigured-v1",
                CapacityProfile::unconfigured().unwrap(),
                32,
                Duration::from_secs(1),
            )
        };
        let actor = open().unwrap();
        actor.handle().ping().unwrap();
        let native_dir = native_store_root(&data);
        assert!(native_dir.join("control").is_dir());
        assert!(!data.join("control").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&native_dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(matches!(open(), Err(StoreError::WriterAlreadyOpen)));
        drop(actor);
        let reopened = open().unwrap();
        drop(reopened);
        remove_test_data(&data);
    }

    #[test]
    fn host_sessions_require_trusted_admission_and_use_revisioned_durable_storage() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let open = || ControlActor::open(&data, "unconfigured-v1", CapacityProfile::unconfigured().unwrap(), 16, timeout);
        let actor = open().unwrap();
        let handle = actor.handle();
        let native_sessions = native_store_root(&data).join("host-sessions");
        assert!(native_sessions.is_dir());
        assert!(!data.join("host-sessions").exists());
        handle.admit_host_session("unused-1".into()).unwrap();
        handle.release_host_session_admission("unused-1".into()).unwrap();
        assert!(matches!(handle.load_host_session("unused-1".into()), Err(ControlError::Admission(AdmissionError::InvalidIdentity))));
        assert!(matches!(handle.load_host_session("chat-1".into()), Err(ControlError::Admission(AdmissionError::InvalidIdentity))));
        handle.admit_host_session("chat-1".into()).unwrap();
        let snapshot = serde_json::json!({"id":"chat-1","title":"Revenue","created":"2026-10-30T00:00:00.000Z","updated":"2026-10-30T00:00:01.000Z","messages":[],"timeline":[],"surfaces":[],"external":[]});
        assert_eq!(handle.save_host_session("chat-1".into(), 0, snapshot.clone()), Ok(1));
        assert_eq!(handle.load_host_session("chat-1".into()), Ok(Some((1, snapshot))));
        assert_eq!(handle.release_host_session_admission("chat-1".into()), Err(ControlError::Admission(AdmissionError::HostSessionAdmissionHasData)));
        assert_eq!(handle.list_host_sessions().unwrap().len(), 1);
        let stale = serde_json::json!({"id":"chat-1","title":"stale","created":"2026-10-30T00:00:00.000Z","updated":"2026-10-30T00:00:02.000Z","messages":[],"timeline":[],"surfaces":[],"external":[]});
        assert_eq!(handle.save_host_session("chat-1".into(), 0, stale), Err(ControlError::Store(StoreError::SessionRevisionConflict)));
        drop(actor);

        let recovered = open().unwrap();
        let handle = recovered.handle();
        assert!(matches!(handle.load_host_session("chat-1".into()), Err(ControlError::Admission(AdmissionError::InvalidIdentity))));
        handle.admit_host_session("chat-1".into()).unwrap();
        assert_eq!(handle.load_host_session("chat-1".into()).unwrap().unwrap().0, 1);
        assert_eq!(handle.remove_host_session("chat-1".into(), Some(0)), Err(ControlError::Store(StoreError::SessionRevisionConflict)));
        handle.remove_host_session("chat-1".into(), Some(1)).unwrap();
        assert!(handle.list_host_sessions().unwrap().is_empty());
        drop(recovered);
        remove_test_data(&data);
    }

    #[test]
    fn cumulative_operation_budgets_persist_before_ack_and_retry_idempotently() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile();
        let actor =
            ControlActor::open(&data, "unconfigured-v1", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        let queued = handle
            .create_root_with_budget(RootCreate {
            local_model: None,
                id: "task-budget".into(),
                session_id: None,
                goal: "Complete the requested work".into(),
                criteria: "Preserve the original acceptance criteria".into(),
                run_limit: 2,
                budget_limits: BudgetLimits::new(1, 1).unwrap(),
                requirements: vec![Requirement::new("outcome".into(), true).unwrap()],
                delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
            })
            .unwrap();
        let running = handle
            .mutate_root(queued.id().into(), queued.revision(), root_start())
            .unwrap();
        let (first, after_model) = handle
            .charge_model_request(running.id().into(), running.revision(), "model-op-1".into())
            .unwrap();
        assert_eq!(first, BudgetCharge::Charged);
        assert_eq!(after_model.model_requests_used(), 1);
        assert_eq!(
            handle
                .read_root(after_model.id().into())
                .unwrap()
                .model_requests_used(),
            1
        );
        let (duplicate, duplicate_root) = handle
            .charge_model_request(running.id().into(), running.revision(), "model-op-1".into())
            .unwrap();
        assert_eq!(duplicate, BudgetCharge::Duplicate);
        assert_eq!(duplicate_root.revision(), after_model.revision());
        let (tool_charge, after_tool) = handle
            .charge_tool_call(
                after_model.id().into(),
                after_model.revision(),
                "tool-op-1".into(),
            )
            .unwrap();
        assert_eq!(tool_charge, BudgetCharge::Charged);
        let (exhausted, stopped) = handle
            .charge_model_request(
                after_tool.id().into(),
                after_tool.revision(),
                "model-op-2".into(),
            )
            .unwrap();
        assert_eq!(exhausted, BudgetCharge::Exhausted);
        assert_eq!(stopped.status(), RootStatus::LimitReached);
        assert_eq!(stopped.stop_cause(), Some(StopCause::BudgetLimit));
        assert_eq!(stopped.model_requests_used(), 1);
        assert_eq!(stopped.tool_calls_used(), 1);

        drop(handle);
        drop(actor);
        let reopened = ControlActor::open(&data, "unconfigured-v1", profile, 16, timeout).unwrap();
        let recovered = reopened.handle().read_root("task-budget".into()).unwrap();
        assert_eq!(recovered.status(), RootStatus::LimitReached);
        assert_eq!(recovered.model_requests_used(), 1);
        assert_eq!(recovered.tool_calls_used(), 1);
        drop(reopened);
        remove_test_data(&data);
    }

    #[test]
    fn candidate_commit_is_fenced_idempotent_and_selected_before_ack() {
        let data = temp_data_dir();
        let profile = profile();
        let timeout = Duration::from_secs(2);
        let actor = ControlActor::open(&data, "profile-1", profile.clone(), 8, timeout).unwrap();
        let handle = actor.handle();
        let queued = handle
            .create_root_with_budget(RootCreate {
            local_model: None,
                id: "task-candidate".into(),
                session_id: Some("session-candidate".into()),
                goal: "Prepare a verified candidate".into(),
                criteria: "Keep the exact candidate under native revision control".into(),
                run_limit: 2,
                budget_limits: BudgetLimits::new(2, 2).unwrap(),
                requirements: vec![Requirement::new("outcome".into(), true).unwrap()],
                delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
            })
            .unwrap();
        let running = handle
            .mutate_root(queued.id().into(), queued.revision(), root_start())
            .unwrap();
        let first_bytes = br#"{"session":"session-candidate","surfaces":[{"id":"main","version":1}]}"#.to_vec();
        let first = CandidateCommitRequest {
            session_id: "session-candidate".into(),
            commit_id: "commit-candidate-1".into(),
            fence: running.execution_fence(),
            expected_canonical_revision: 0,
            candidate_bytes: first_bytes.clone(),
        };
        let mut wrong_session = first.clone();
        wrong_session.session_id = "another-session".into();
        assert_eq!(
            handle.commit_candidate(wrong_session),
            Err(ControlError::Admission(AdmissionError::CandidateSessionMismatch))
        );
        assert_eq!(
            handle.commit_candidate(first.clone()),
            Err(ControlError::TaskState(StateError::ExecutionFenceStale)),
            "prepared capacity is not a supervisor-started invocation"
        );
        let invocation = handle.read_root_run("run-1".into()).unwrap();
        handle
            .confirm_root_started(invocation.id.clone(), "candidate-supervisor".into())
            .unwrap();
        let receipt = handle.commit_candidate(first.clone()).unwrap();
        assert_eq!(receipt.canonical_revision, 1);
        assert_eq!(receipt.root_revision, running.revision());
        assert_eq!(fs::read(native_store_root(&data).join("content/sessions/session-candidate/generation-00000000000000000001.json")).unwrap(), first_bytes);
        assert_eq!(handle.commit_candidate(first.clone()).unwrap(), receipt);
        assert_eq!(handle.read_candidate_receipt("commit-candidate-1".into()).unwrap(), Some(receipt.clone()));
        assert_eq!(handle.read_candidate_receipt("unknown-commit".into()).unwrap(), None);

        let mut conflicting = first.clone();
        conflicting.candidate_bytes = br#"{"session":"different"}"#.to_vec();
        assert_eq!(
            handle.commit_candidate(conflicting),
            Err(ControlError::Admission(AdmissionError::CandidateIdentityConflict))
        );
        let second = CandidateCommitRequest {
            session_id: "session-candidate".into(),
            commit_id: "commit-candidate-2".into(),
            fence: running.execution_fence(),
            expected_canonical_revision: 1,
            candidate_bytes: br#"{"session":"session-candidate","surfaces":[{"id":"main","version":2}]}"#.to_vec(),
        };
        let second_receipt = handle.commit_candidate(second).unwrap();
        assert_eq!(second_receipt.canonical_revision, 2);
        assert!(native_store_root(&data).join("content/sessions/session-candidate/generation-00000000000000000001.json").exists());
        assert!(native_store_root(&data).join("content/sessions/session-candidate/generation-00000000000000000002.json").exists());
        assert_eq!(
            handle.commit_candidate(CandidateCommitRequest {
                session_id: "session-candidate".into(),
                commit_id: "commit-candidate-stale".into(),
                fence: running.execution_fence(),
                expected_canonical_revision: 0,
                candidate_bytes: br#"{"stale":true}"#.to_vec(),
            }),
            Err(ControlError::Admission(AdmissionError::CanonicalRevisionConflict))
        );
        handle
            .settle_root_exit(invocation.id, "candidate-worker-exit".into())
            .unwrap();
        let mut after_exit = first.clone();
        after_exit.commit_id = "commit-after-exit".into();
        after_exit.expected_canonical_revision = 2;
        assert_eq!(
            handle.commit_candidate(after_exit),
            Err(ControlError::TaskState(StateError::ExecutionFenceStale))
        );
        assert_eq!(
            handle.commit_candidate(first.clone()).unwrap(),
            receipt,
            "a recorded receipt retry cannot dispatch or commit new bytes"
        );
        drop(handle);
        drop(actor);

        let recovered = ControlActor::open(&data, "profile-1", profile, 8, timeout).unwrap();
        assert_eq!(recovered.handle().read_candidate_receipt("commit-candidate-1".into()).unwrap(), Some(receipt.clone()));
        assert_eq!(recovered.handle().commit_candidate(first).unwrap(), receipt);
        drop(recovered);
        remove_test_data(&data);
    }

    #[test]
    fn host_session_indexes_multiple_durable_roots_across_restart() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = CapacityProfile::unconfigured().unwrap();
        let actor =
            ControlActor::open(&data, "unconfigured-v1", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        let request = RootCreate {
            local_model: None,
            id: "root-for-chat".into(),
            session_id: Some("chat-runtime-1".into()),
            goal: "Bind provider runs to native tasks".into(),
            criteria: "Preserve every root associated with the chat".into(),
            run_limit: 2,
            budget_limits: BudgetLimits::new(2, 2).unwrap(),
            requirements: vec![Requirement::new("bound-run".into(), true).unwrap()],
            delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
        };
        let first = handle.create_root_with_budget(request.clone()).unwrap();
        let second = handle
            .create_root_with_budget(RootCreate {
            local_model: None,
                id: "second-root".into(),
                ..request.clone()
            })
            .unwrap();
        assert_eq!(
            handle
                .root_ids_for_session("chat-runtime-1".into())
                .unwrap(),
            vec![first.id().to_owned(), second.id().to_owned()]
        );
        assert_eq!(
            handle.root_ids_for_session("../chat-runtime-1".into()),
            Err(ControlError::Admission(AdmissionError::InvalidIdentity))
        );
        drop(handle);
        drop(actor);

        let recovered = ControlActor::open(&data, "unconfigured-v1", profile, 16, timeout).unwrap();
        assert_eq!(
            recovered
                .handle()
                .root_ids_for_session("chat-runtime-1".into())
                .unwrap(),
            vec![first.id().to_owned(), second.id().to_owned()]
        );
        drop(recovered);
        remove_test_data(&data);
    }

    #[test]
    fn native_root_creation_retries_across_recovery_without_accepting_conflicts() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile();
        let actor =
            ControlActor::open(&data, "unconfigured-v1", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        let request = RootCreate {
            local_model: None,
            id: "task-create-retry".into(),
            session_id: None,
            goal: "Recover task creation safely".into(),
            criteria: "Return the original durable task".into(),
            run_limit: 2,
            budget_limits: BudgetLimits::new(2, 2).unwrap(),
            requirements: vec![Requirement::new("creation-receipt".into(), true).unwrap()],
            delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
        };
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let handle = handle.clone();
                let request = request.clone();
                thread::spawn(move || handle.create_root_with_budget(request))
            })
            .collect();
        let created: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect();
        assert!(created.iter().all(|root| root.revision() == 1));
        assert!(
            created
                .iter()
                .all(|root| root.status() == RootStatus::Queued)
        );
        let created = created[0].clone();
        let running = handle
            .mutate_root(created.id().into(), created.revision(), root_start())
            .unwrap();
        drop(handle);
        drop(actor);

        let recovered_actor =
            ControlActor::open(&data, "unconfigured-v1", profile, 16, timeout).unwrap();
        let recovered_handle = recovered_actor.handle();
        let recovered_state = recovered_handle
            .read_root("task-create-retry".into())
            .unwrap();
        let retried = recovered_handle
            .create_root_with_budget(request.clone())
            .unwrap();
        assert_eq!(retried.revision(), recovered_state.revision());
        assert_eq!(retried.status(), RootStatus::Interrupted);
        assert_eq!(retried.status(), recovered_state.status());
        assert!(retried.revision() > running.revision());

        let mut conflicting = request;
        conflicting.criteria = "Different contract under a reused identity".into();
        assert_eq!(
            recovered_handle.create_root_with_budget(conflicting),
            Err(ControlError::Admission(AdmissionError::DuplicateRoot))
        );
        assert_eq!(
            recovered_handle
                .read_root("task-create-retry".into())
                .unwrap()
                .revision(),
            recovered_state.revision()
        );
        drop(recovered_handle);
        drop(recovered_actor);
        remove_test_data(&data);
    }

    #[test]
    fn concurrent_unique_budget_charges_cannot_overshoot_the_root_limit() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(5);
        let profile = profile();
        let actor = ControlActor::open(&data, "unconfigured-v1", profile, 32, timeout).unwrap();
        let handle = actor.handle();
        let queued = handle
            .create_root_with_budget(RootCreate {
            local_model: None,
                id: "task-budget-race".into(),
                session_id: None,
                goal: "Finish the bounded operation".into(),
                criteria: "Do not exceed the model-call limit".into(),
                run_limit: 1,
                budget_limits: BudgetLimits::new(1, 1).unwrap(),
                requirements: vec![Requirement::new("outcome".into(), true).unwrap()],
                delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0).unwrap(),
            })
            .unwrap();
        let running = handle
            .mutate_root(queued.id().into(), queued.revision(), root_start())
            .unwrap();
        let expected_revision = running.revision();
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let handle = handle.clone();
                let root_id = running.id().to_owned();
                thread::spawn(move || {
                    handle.charge_model_request(
                        root_id,
                        expected_revision,
                        format!("model-race-{index}"),
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let charged: Vec<_> = results
            .iter()
            .filter_map(|result| match result {
                Ok((BudgetCharge::Charged, root)) => Some(root.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(charged.len(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(
                    result,
                    Err(ControlError::TaskState(StateError::RevisionConflict))
                ))
                .count(),
            7
        );
        assert_eq!(charged[0].model_requests_used(), 1);
        assert_eq!(charged[0].status(), RootStatus::Running);

        let (exhausted, stopped) = handle
            .charge_model_request(
                charged[0].id().into(),
                charged[0].revision(),
                "model-race-after-limit".into(),
            )
            .unwrap();
        assert_eq!(exhausted, BudgetCharge::Exhausted);
        assert_eq!(stopped.status(), RootStatus::LimitReached);
        assert_eq!(stopped.model_requests_used(), 1);
        drop(handle);
        drop(actor);
        remove_test_data(&data);
    }

    fn profile_with_queued_children(limit: u32) -> CapacityProfile {
        CapacityProfile::new(
            BTreeMap::from([
                (Resource::Generation, 2),
                (Resource::ContainedProcess, 4),
                (Resource::QueuedChild, limit),
                (Resource::ChildExecution, 1),
            ]),
            BTreeMap::from([
                (Resource::Generation, 1),
                (Resource::ContainedProcess, 2),
                (Resource::QueuedChild, limit),
                (Resource::ChildExecution, 1),
            ]),
            16,
        )
        .unwrap()
    }

    fn child_proposal(request_id: &str, write: &str) -> ChildProposal {
        ChildProposal {
            request_id: request_id.into(),
            objective: format!("Investigate {request_id}"),
            acceptance: format!("Return supported findings for {request_id}"),
            inputs: vec![format!("input-{request_id}")],
            reads: vec![],
            writes: vec![write.into()],
            benefit: delegation::ClaimedBenefit::IndependentJudgment,
        }
    }

    fn workspace_root(
        handle: &ControlHandle,
        id: &str,
        session_id: &str,
        binding_revision: u64,
    ) -> RootTask {
        handle
            .create_root_in_workspace(
                RootCreate {
            local_model: None,
                    id: id.into(),
                    session_id: None,
                    goal: "Inspect the fixed workspace".into(),
                    criteria: "Return supported findings".into(),
                    run_limit: 2,
                    budget_limits: BudgetLimits::new(96, 96).unwrap(),
                    requirements: vec![
                        Requirement::new(format!("requirement-{id}"), true).unwrap(),
                    ],
                    delegation: DelegationPolicy::new(
                        delegation::DelegationMode::BoundedAdaptive,
                        4,
                    )
                    .unwrap(),
                },
                session_id.into(),
                binding_revision,
            )
            .unwrap()
    }

    fn start_with_two_children(
        handle: &ControlHandle,
        root: RootTask,
        identity_prefix: &str,
    ) -> RootTask {
        let running = handle
            .mutate_root(root.id().into(), root.revision(), root_start())
            .unwrap();
        handle
            .admit_children(
                running.id().into(),
                running.revision(),
                vec![
                    child_proposal(
                        &format!("{identity_prefix}-a"),
                        &format!("{identity_prefix}-write-a"),
                    ),
                    child_proposal(
                        &format!("{identity_prefix}-b"),
                        &format!("{identity_prefix}-write-b"),
                    ),
                ],
            )
            .unwrap();
        handle.read_root(running.id().into()).unwrap()
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
    fn child_admission_is_unavailable_until_the_profile_configures_its_slot_domain() {
        let mut ledger = CapacityLedger::default();
        assert_eq!(
            ledger.reserve(
                &profile(),
                "child-request-1",
                "root-child-1",
                ask(Resource::ChildExecution, 1),
            ),
            Err(AdmissionError::UnconfiguredResource(
                Resource::ChildExecution
            ))
        );

        let configured = CapacityProfile::new(
            BTreeMap::from([(Resource::ChildExecution, 3)]),
            BTreeMap::from([(Resource::ChildExecution, 1)]),
            8,
        )
        .unwrap();
        ledger
            .reserve(
                &configured,
                "child-request-2",
                "root-child-1",
                ask(Resource::ChildExecution, 1),
            )
            .unwrap();
        assert_eq!(
            ledger.reserve(
                &configured,
                "child-request-3",
                "root-child-1",
                ask(Resource::ChildExecution, 1),
            ),
            Err(AdmissionError::RootLimit(Resource::ChildExecution))
        );
        assert!(
            ledger
                .reserve(
                    &configured,
                    "child-request-4",
                    "root-child-2",
                    ask(Resource::ChildExecution, 1),
                )
                .is_ok()
        );
    }

    #[test]
    fn child_queue_admission_is_atomic_idempotent_and_released_on_root_stop() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile_with_queued_children(2);
        let actor = ControlActor::open(&data, "profile-1", profile.clone(), 8, timeout).unwrap();
        let handle = actor.handle();
        let policy = DelegationPolicy::new(delegation::DelegationMode::BoundedAdaptive, 4).unwrap();
        let root = handle
            .create_root_with_delegation(
                "task-delegation".into(),
                "Deliver a verified result".into(),
                "Meet the declared requirements".into(),
                2,
                vec![Requirement::new("outcome".into(), true).unwrap()],
                policy,
            )
            .unwrap();
        let running = handle
            .mutate_root(root.id().into(), root.revision(), root_start())
            .unwrap();
        let proposal_a = child_proposal("request-a", "candidate-a");
        let proposal_b = child_proposal("request-b", "candidate-b");
        let proposal_c = child_proposal("request-c", "candidate-c");
        assert_eq!(
            handle.admit_children(
                running.id().into(),
                running.revision(),
                vec![proposal_a.clone(), proposal_b, proposal_c],
            ),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::QueuedChild)
            ))
        );
        let unchanged = handle.read_root(running.id().into()).unwrap();
        assert_eq!(unchanged.revision(), running.revision());
        assert!(unchanged.children().is_empty());

        let queued = handle
            .admit_children(
                running.id().into(),
                running.revision(),
                vec![
                    proposal_a.clone(),
                    child_proposal("request-b", "candidate-b"),
                ],
            )
            .unwrap();
        assert_eq!(queued.len(), 2);
        assert!(
            queued
                .iter()
                .all(|child| child.status() == state::ChildStatus::Queued)
        );
        assert_eq!(
            handle
                .admit_children(
                    running.id().into(),
                    running.revision(),
                    vec![proposal_a, child_proposal("request-b", "candidate-b")],
                )
                .unwrap(),
            queued
        );
        let stopped = handle
            .mutate_root(
                running.id().into(),
                running.revision() + 1,
                RootMutation::Stop {
                    status: RootStatus::Cancelled,
                    cause: StopCause::UserCancelled,
                    reason: "User stopped".into(),
                },
            )
            .unwrap();
        assert_eq!(stopped.children().len(), 2);
        assert!(
            stopped
                .children()
                .values()
                .all(|child| child.status() == state::ChildStatus::Invalidated)
        );
        drop(handle);
        drop(actor);

        let restarted = ControlActor::open(&data, "profile-1", profile, 8, timeout).unwrap();
        let recovered = restarted
            .handle()
            .read_root("task-delegation".into())
            .unwrap();
        assert_eq!(recovered, stopped);
        remove_test_data(&data);
    }

    #[test]
    fn restart_interrupts_roots_and_invalidates_unstarted_queued_children() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile_with_queued_children(2);
        let actor = ControlActor::open(&data, "profile-1", profile.clone(), 8, timeout).unwrap();
        let handle = actor.handle();
        let policy = DelegationPolicy::new(delegation::DelegationMode::BoundedAdaptive, 2).unwrap();
        let root = handle
            .create_root_with_delegation(
                "task-recovery".into(),
                "Deliver a verified result".into(),
                "Meet the declared requirements".into(),
                2,
                vec![Requirement::new("outcome".into(), true).unwrap()],
                policy,
            )
            .unwrap();
        let running = handle
            .mutate_root(root.id().into(), root.revision(), root_start())
            .unwrap();
        handle
            .admit_children(
                running.id().into(),
                running.revision(),
                vec![
                    child_proposal("request-a", "candidate-a"),
                    child_proposal("request-b", "candidate-b"),
                ],
            )
            .unwrap();
        drop(handle);
        drop(actor);

        let recovered_actor = ControlActor::open(&data, "profile-1", profile, 8, timeout).unwrap();
        let recovered = recovered_actor
            .handle()
            .read_root("task-recovery".into())
            .unwrap();
        assert_eq!(recovered.status(), RootStatus::Interrupted);
        assert!(
            recovered
                .children()
                .values()
                .all(|child| child.status() == state::ChildStatus::Invalidated)
        );
        drop(recovered_actor);
        remove_test_data(&data);
    }

    #[test]
    fn child_dispatch_atomically_trades_queue_capacity_and_persists_return_receipt() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile_with_queued_children(2);
        let actor = ControlActor::open(&data, "profile-1", profile.clone(), 8, timeout).unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle.reserve(
                "external-child-exec".into(),
                "task-child-run".into(),
                ask(Resource::ChildExecution, 1),
            ),
            Err(ControlError::Admission(AdmissionError::ReservedForControl(
                Resource::ChildExecution
            )))
        );
        let root = handle
            .create_root_with_delegation(
                "task-child-run".into(),
                "Deliver the checked result".into(),
                "Meet the child acceptance contract".into(),
                2,
                vec![Requirement::new("outcome-child-run".into(), true).unwrap()],
                DelegationPolicy::new(delegation::DelegationMode::BoundedAdaptive, 2).unwrap(),
            )
            .unwrap();
        let running_root = handle
            .mutate_root(root.id().into(), root.revision(), root_start())
            .unwrap();
        let queued = handle
            .admit_children(
                running_root.id().into(),
                running_root.revision(),
                vec![
                    child_proposal("child-run-request", "child-run-output"),
                    child_proposal("child-run-request-2", "child-run-output-2"),
                ],
            )
            .unwrap()
            .remove(0);
        let current_root = handle.read_root(running_root.id().into()).unwrap();
        let started = handle
            .start_child_attempt(
                current_root.id().into(),
                current_root.revision(),
                queued.id().into(),
                queued.revision(),
                "dispatch-child-run".into(),
            )
            .unwrap();
        assert_eq!(started.status(), state::ChildStatus::Starting);
        let retry = handle
            .start_child_attempt(
                running_root.id().into(),
                running_root.revision(),
                queued.id().into(),
                queued.revision(),
                "dispatch-child-run".into(),
            )
            .unwrap();
        assert_eq!(
            retry, started,
            "lost acknowledgement retries return the same attempt"
        );
        let waiting_child = handle
            .read_root(running_root.id().into())
            .unwrap()
            .children()
            .values()
            .find(|child| child.id() != started.id())
            .unwrap()
            .clone();
        assert_eq!(
            handle.start_child_attempt(
                running_root.id().into(),
                handle
                    .read_root(running_root.id().into())
                    .unwrap()
                    .revision(),
                waiting_child.id().into(),
                waiting_child.revision(),
                "dispatch-child-run-second".into(),
            ),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::ChildExecution)
            ))
        );
        let current_root = handle.read_root(running_root.id().into()).unwrap();
        let running = handle
            .confirm_child_started(
                current_root.id().into(),
                current_root.revision(),
                started.id().into(),
                started.revision(),
                "supervisor-child-run".into(),
            )
            .unwrap();
        assert_eq!(running.status(), state::ChildStatus::Running);
        assert_eq!(
            handle
                .confirm_child_started(
                    running_root.id().into(),
                    running_root.revision(),
                    started.id().into(),
                    started.revision(),
                    "supervisor-child-run".into(),
                )
                .unwrap(),
            running,
            "lost supervisor acknowledgement retries return the same started attempt"
        );
        let returned = handle
            .return_child_attempt(
                running_root.id().into(),
                running.id().into(),
                running.revision(),
                "immutable-child-receipt".into(),
            )
            .unwrap();
        assert_eq!(returned.status(), state::ChildStatus::Returned);
        assert_eq!(
            handle
                .return_child_attempt(
                    running_root.id().into(),
                    running.id().into(),
                    running.revision(),
                    "immutable-child-receipt".into(),
                )
                .unwrap(),
            returned,
            "lost return acknowledgement must not duplicate state or receipts"
        );
        let current_root = handle.read_root(running_root.id().into()).unwrap();
        let next_started = handle
            .start_child_attempt(
                current_root.id().into(),
                current_root.revision(),
                waiting_child.id().into(),
                waiting_child.revision(),
                "dispatch-child-run-second".into(),
            )
            .unwrap();
        assert_eq!(next_started.status(), state::ChildStatus::Starting);
        let current_root = handle.read_root(running_root.id().into()).unwrap();
        let next_running = handle
            .confirm_child_started(
                current_root.id().into(),
                current_root.revision(),
                next_started.id().into(),
                next_started.revision(),
                "supervisor-child-run-second".into(),
            )
            .unwrap();
        handle
            .return_child_attempt(
                current_root.id().into(),
                next_running.id().into(),
                next_running.revision(),
                "immutable-child-receipt-second".into(),
            )
            .unwrap();
        drop(handle);
        drop(actor);

        let restarted = ControlActor::open(&data, "profile-1", profile, 8, timeout).unwrap();
        let recovered = restarted
            .handle()
            .read_root("task-child-run".into())
            .unwrap();
        let recovered_child = recovered.children().values().next().unwrap();
        assert_eq!(recovered_child, &returned);
        remove_test_data(&data);
    }

    #[test]
    fn restart_marks_unsettled_child_interrupted_and_keeps_unknown_execution_charge() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile_with_queued_children(2);
        let actor = ControlActor::open(&data, "profile-1", profile.clone(), 8, timeout).unwrap();
        let handle = actor.handle();
        let root = handle
            .create_root_with_delegation(
                "task-child-interrupt".into(),
                "Deliver the checked result".into(),
                "Meet the child acceptance contract".into(),
                2,
                vec![Requirement::new("outcome-child-interrupt".into(), true).unwrap()],
                DelegationPolicy::new(delegation::DelegationMode::BoundedAdaptive, 2).unwrap(),
            )
            .unwrap();
        let running_root = handle
            .mutate_root(root.id().into(), root.revision(), root_start())
            .unwrap();
        let queued = handle
            .admit_children(
                running_root.id().into(),
                running_root.revision(),
                vec![
                    child_proposal("child-interrupt-request", "child-interrupt-output"),
                    child_proposal("child-interrupt-request-2", "child-interrupt-output-2"),
                ],
            )
            .unwrap()
            .remove(0);
        let current_root = handle.read_root(running_root.id().into()).unwrap();
        let started = handle
            .start_child_attempt(
                current_root.id().into(),
                current_root.revision(),
                queued.id().into(),
                queued.revision(),
                "dispatch-child-interrupt".into(),
            )
            .unwrap();
        drop(handle);
        drop(actor);

        let restarted = ControlActor::open(&data, "profile-1", profile, 8, timeout).unwrap();
        let recovered_handle = restarted.handle();
        let recovered = recovered_handle
            .read_root("task-child-interrupt".into())
            .unwrap();
        let interrupted = recovered.children().values().next().unwrap();
        assert_eq!(interrupted.status(), state::ChildStatus::Interrupted);
        assert_eq!(
            interrupted.attempt().unwrap().status(),
            state::ChildAttemptStatus::Interrupted
        );
        let other_root = recovered_handle
            .create_root_with_delegation(
                "task-after-restart".into(),
                "Inspect a separate result".into(),
                "Keep the job bounded".into(),
                1,
                vec![Requirement::new("outcome-after-restart".into(), true).unwrap()],
                DelegationPolicy::new(delegation::DelegationMode::BoundedAdaptive, 2).unwrap(),
            )
            .unwrap();
        let other_running = recovered_handle
            .mutate_root(other_root.id().into(), other_root.revision(), root_start())
            .unwrap();
        let other_children = recovered_handle
            .admit_children(
                other_running.id().into(),
                other_running.revision(),
                vec![
                    child_proposal("after-restart-a", "after-restart-write-a"),
                    child_proposal("after-restart-b", "after-restart-write-b"),
                ],
            )
            .unwrap();
        let queued = &other_children[0];
        let current_other = recovered_handle
            .read_root(other_running.id().into())
            .unwrap();
        assert_eq!(
            recovered_handle.start_child_attempt(
                current_other.id().into(),
                current_other.revision(),
                queued.id().into(),
                queued.revision(),
                "dispatch-after-restart".into(),
            ),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::ChildExecution)
            )),
            "an uncertain process cleanup does not refund the active execution lease"
        );
        assert_eq!(
            started.attempt().unwrap().id(),
            interrupted.attempt().unwrap().id()
        );
        remove_test_data(&data);
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
        let root = std::env::temp_dir().join(format!(
            "vak-control-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn remove_test_data(data: &Path) {
        fs::remove_dir_all(data).unwrap();
        let native = native_store_root(data);
        if native.exists() {
            fs::remove_dir_all(native).unwrap();
        }
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
        remove_test_data(&data);
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
        remove_test_data(&data);
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
        remove_test_data(&data);
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
        remove_test_data(&data);
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
        remove_test_data(&data);
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
        remove_test_data(&data);
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
        remove_test_data(&data);
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
        remove_test_data(&data);
    }

    #[test]
    fn actor_serializes_reserve_release_and_restart_recovery() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let actor = ControlActor::open(&data, "profile-1", profile(), 4, timeout).unwrap();
        let handle = actor.handle();
        let root = handle
            .create_root(
                "task-1".into(),
                "Produce a verified result".into(),
                "Meet the declared requirements".into(),
                3,
                vec![Requirement::new("outcome".into(), true).unwrap()],
            )
            .unwrap();
        let running = handle
            .mutate_root(root.id().into(), root.revision(), root_start())
            .unwrap();
        let checked = handle
            .mutate_root(
                running.id().into(),
                running.revision(),
                RootMutation::RecordCheck {
                    contract_revision: running.contract_revision(),
                    requirement_id: "outcome".into(),
                    outcome: CheckOutcome::Pass,
                    receipt: Some("receipt-1".into()),
                },
            )
            .unwrap();
        handle
            .settle_root_exit("run-1".into(), "exit-task-1".into())
            .unwrap();
        let ready = handle
            .mutate_root(
                checked.id().into(),
                checked.revision(),
                RootMutation::RequestReview,
            )
            .unwrap();
        let active = handle
            .create_root(
                "task-live".into(),
                "An interrupted task".into(),
                "Review uncertain effects".into(),
                3,
                vec![Requirement::new("outcome".into(), true).unwrap()],
            )
            .unwrap();
        let active = handle
            .mutate_root(active.id().into(), active.revision(), root_start())
            .unwrap();
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
        assert_eq!(handle.read_root("task-1".into()).unwrap(), ready);
        let recovered = handle.read_root("task-live".into()).unwrap();
        assert_eq!(recovered.status(), RootStatus::Interrupted);
        assert_eq!(recovered.stop_cause(), Some(StopCause::ControlRestart));
        assert_eq!(recovered.revision(), active.revision() + 1);
        assert!(
            recovered
                .stop_reason()
                .unwrap()
                .contains("in-flight effects")
        );
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
        remove_test_data(&data);
    }

    #[test]
    fn workspace_grants_share_native_durability_and_revocation_survives_restart() {
        let data = temp_data_dir();
        let source = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let actor = ControlActor::open(&data, "profile-1", profile(), 8, timeout).unwrap();
        let handle = actor.handle();
        let project = handle
            .create_project("project-0001".into(), "Research".into())
            .unwrap();
        assert_eq!(project.id(), "project-0001");
        let workspace = handle
            .register_workspace("workspace-001".into(), source.clone())
            .unwrap();
        assert_eq!(workspace.canonical_path(), source.canonicalize().unwrap());
        let project = handle
            .set_project_preferred_workspace(
                project.id().into(),
                project.revision(),
                Some(workspace.id().into()),
            )
            .unwrap();
        assert_eq!(project.revision(), 2);
        let binding = handle
            .bind_workspace(
                "binding-0001".into(),
                "session-0001".into(),
                workspace.id().into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();
        let root = handle
            .create_root_in_workspace(
                RootCreate {
            local_model: None,
                    id: "task-fixed-scope".into(),
                    session_id: None,
                    goal: "Inspect the selected workspace".into(),
                    criteria: "Return traceable findings".into(),
                    run_limit: 2,
                    budget_limits: BudgetLimits::new(96, 96).unwrap(),
                    requirements: vec![Requirement::new("workspace-review".into(), true).unwrap()],
                    delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0)
                        .unwrap(),
                },
                binding.session_id().into(),
                binding.revision(),
            )
            .unwrap();
        assert_eq!(root.workspace_grant().unwrap().workspace_id, workspace.id());
        handle
            .set_project_membership(binding.session_id().into(), Some(project.id().into()), None)
            .unwrap();
        let grant = handle
            .read_workspace_grant(binding.session_id().into(), binding.revision())
            .unwrap();
        assert_eq!(grant.binding_revision, binding.revision());
        let revoked = handle
            .revoke_workspace(binding.session_id().into(), binding.revision())
            .unwrap();
        assert_eq!(
            handle.create_root_in_workspace(
                RootCreate {
            local_model: None,
                    id: "task-revoked-scope".into(),
                    session_id: None,
                    goal: "Inspect the selected workspace".into(),
                    criteria: "Return traceable findings".into(),
                    run_limit: 2,
                    budget_limits: BudgetLimits::new(96, 96).unwrap(),
                    requirements: vec![Requirement::new("workspace-review".into(), true).unwrap()],
                    delegation: DelegationPolicy::new(delegation::DelegationMode::Disabled, 0)
                        .unwrap(),
                },
                revoked.session_id().into(),
                revoked.revision(),
            ),
            Err(ControlError::Registry(RegistryError::BindingRevoked))
        );
        drop(handle);
        drop(actor);

        let restarted = ControlActor::open(&data, "profile-1", profile(), 8, timeout).unwrap();
        let restarted_handle = restarted.handle();
        let persisted_membership = restarted_handle
            .read_project_membership("session-0001".into())
            .unwrap()
            .unwrap();
        assert_eq!(persisted_membership.project_id(), Some("project-0001"));
        let second_source = temp_data_dir();
        let second_workspace = restarted_handle
            .register_workspace("workspace-002".into(), second_source.clone())
            .unwrap();
        let rebound = restarted_handle
            .rebind_workspace(
                "session-0001".into(),
                revoked.revision(),
                second_workspace.id().into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();
        let current_grant = restarted_handle
            .read_workspace_grant(rebound.session_id().into(), rebound.revision())
            .unwrap();
        let persisted_root = restarted_handle
            .read_root("task-fixed-scope".into())
            .unwrap();
        let admitted_grant = persisted_root.workspace_grant().unwrap();
        assert_eq!(admitted_grant.workspace_id, "workspace-001");
        assert_ne!(admitted_grant.workspace_id, current_grant.workspace_id);
        assert_eq!(admitted_grant.binding_revision, binding.revision());
        assert_eq!(
            restarted_handle.mutate_root(
                persisted_root.id().into(),
                persisted_root.revision(),
                root_start(),
            ),
            Err(ControlError::TaskState(StateError::WorkspaceGrantStale))
        );
        assert_eq!(
            restarted_handle.mutate_root(
                persisted_root.id().into(),
                persisted_root.revision(),
                RootMutation::RequestReview,
            ),
            Err(ControlError::TaskState(StateError::WorkspaceGrantStale))
        );
        assert_eq!(
            restarted_handle.read_workspace_grant(revoked.session_id().into(), revoked.revision()),
            Err(ControlError::Registry(RegistryError::RevisionConflict))
        );
        drop(restarted_handle);
        drop(restarted);
        fs::remove_dir_all(second_source).unwrap();
        fs::remove_dir_all(source).unwrap();
        remove_test_data(&data);
    }

    #[test]
    fn workspace_rebind_and_revoke_atomically_invalidate_queued_children_and_release_capacity() {
        let data = temp_data_dir();
        let first_source = temp_data_dir();
        let second_source = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = profile_with_queued_children(2);
        let actor = ControlActor::open(&data, "profile-1", profile, 16, timeout).unwrap();
        let handle = actor.handle();
        let first = handle
            .register_workspace("workspace-rebind-a".into(), first_source.clone())
            .unwrap();
        let second = handle
            .register_workspace("workspace-rebind-b".into(), second_source.clone())
            .unwrap();
        let binding = handle
            .bind_workspace(
                "binding-rebind".into(),
                "session-rebind".into(),
                first.id().into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();

        let first_root = start_with_two_children(
            &handle,
            workspace_root(
                &handle,
                "root-rebind-a",
                "session-rebind",
                binding.revision(),
            ),
            "first-child",
        );
        let first_fence = first_root.execution_fence();
        assert_eq!(handle.check_execution_fence(first_fence.clone()), Ok(()));
        let rebound = handle
            .rebind_workspace(
                binding.session_id().into(),
                binding.revision(),
                second.id().into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();
        let invalidated_first = handle.read_root(first_root.id().into()).unwrap();
        assert_eq!(
            invalidated_first.cancellation_epoch(),
            first_root.cancellation_epoch() + 1
        );
        assert_eq!(
            handle.check_execution_fence(first_fence),
            Err(ControlError::TaskState(StateError::ExecutionFenceStale))
        );
        assert!(
            invalidated_first
                .children()
                .values()
                .all(|child| child.status() == state::ChildStatus::Invalidated)
        );
        assert_eq!(
            handle.admit_children(
                invalidated_first.id().into(),
                invalidated_first.revision(),
                vec![
                    child_proposal("stale-child-a", "stale-write-a"),
                    child_proposal("stale-child-b", "stale-write-b"),
                ],
            ),
            Err(ControlError::TaskState(StateError::WorkspaceGrantStale))
        );

        let second_root = start_with_two_children(
            &handle,
            workspace_root(
                &handle,
                "root-rebind-b",
                "session-rebind",
                rebound.revision(),
            ),
            "second-child",
        );
        let revoked = handle
            .revoke_workspace(rebound.session_id().into(), rebound.revision())
            .unwrap();
        let invalidated_second = handle.read_root(second_root.id().into()).unwrap();
        assert_eq!(
            invalidated_second.cancellation_epoch(),
            second_root.cancellation_epoch() + 1
        );
        assert!(
            invalidated_second
                .children()
                .values()
                .all(|child| child.status() == state::ChildStatus::Invalidated)
        );
        let rebound_again = handle
            .rebind_workspace(
                revoked.session_id().into(),
                revoked.revision(),
                first.id().into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();
        // Revocation does not prove that a worker exited.
        handle
            .settle_root_exit("run-1".into(), "exit-first-root".into())
            .unwrap();
        let third_root = start_with_two_children(
            &handle,
            workspace_root(
                &handle,
                "root-rebind-c",
                "session-rebind",
                rebound_again.revision(),
            ),
            "third-child",
        );
        assert!(
            third_root
                .children()
                .values()
                .all(|child| child.status() == state::ChildStatus::Queued)
        );

        drop(handle);
        drop(actor);
        fs::remove_dir_all(first_source).unwrap();
        fs::remove_dir_all(second_source).unwrap();
        remove_test_data(&data);
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
        let (_, ledger) = ControlStore::open(&native_store_root(&data), "profile-1", &profile()).unwrap();
        assert_eq!(ledger.active_leases(), 2);
        remove_test_data(&data);
    }
}
