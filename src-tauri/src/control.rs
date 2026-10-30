//! Pure native admission primitives. The app does not enable this ledger until
//! every protected workload is routed through the owning control actor.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const STORE_VERSION: u16 = 12;
const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROOTS: usize = 10_000;
const MAX_CANDIDATE_RECEIPTS: usize = 10_000;
const MAX_ADMITTED_HOST_SESSIONS: usize = 10_000;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub mod bridge;
mod approval;
mod broker;
pub mod canonical;
pub mod delegation;
pub mod folder;
pub mod host_sessions;
pub mod registry;
pub mod state;
use delegation::{ChildProposal, DelegationPolicy};
use canonical::{CandidateCommitReceipt, CandidateCommitRequest, CanonicalContentStore, CanonicalSessionRecord};
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
    registry: RegistryState,
    canonical_sessions: BTreeMap<String, CanonicalSessionRecord>,
    candidate_receipts: BTreeMap<String, CandidateCommitReceipt>,
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
        if ledger.roots.len() > MAX_ROOTS
            || ledger
                .roots
                .iter()
                .any(|(id, root)| id != root.id() || root.validate().is_err())
        {
            return Err(StoreError::Corrupt);
        }
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
    StartAttempt,
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

enum ActorCommand {
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
    ReadRoot {
        id: String,
        reply: SyncSender<Result<RootTask, ControlError>>,
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
    CommitCandidate {
        request: CandidateCommitRequest,
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

#[derive(Clone)]
pub struct ControlHandle {
    commands: SyncSender<ActorCommand>,
    response_timeout: Duration,
    candidate_in_flight: Arc<std::sync::atomic::AtomicBool>,
}

impl ControlHandle {
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

    pub fn read_root(&self, id: String) -> Result<RootTask, ControlError> {
        let (reply, response) = sync_channel(1);
        self.commands
            .try_send(ActorCommand::ReadRoot { id, reply })
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

    /// Persists an opaque canonical candidate only when the task and canonical
    /// revisions still match. Replays return the durable receipt, never replay bytes.
    pub fn commit_candidate(
        &self,
        request: CandidateCommitRequest,
    ) -> Result<CandidateCommitReceipt, ControlError> {
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
        let (mut store, mut ledger) = ControlStore::open(data_dir, profile_revision, &profile)?;
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
        if recovered {
            store.persist(&ledger, &profile)?;
        }
        let canonical_content = CanonicalContentStore::open(data_dir, &ledger.canonical_sessions)
            .map_err(canonical_store_error)?;
        let host_sessions = host_sessions::HostSessionStore::open(data_dir)?;
        let (commands, receiver) = sync_channel(queue_capacity);
        let join = thread::Builder::new()
            .name("vak-control".into())
            .spawn(move || actor_loop(receiver, &mut store, profile, ledger, workspace_admission, canonical_content, host_sessions))
            .map_err(store_io)?;
        Ok(Self {
            handle: ControlHandle {
                commands,
                response_timeout,
                candidate_in_flight: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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

fn actor_loop(
    receiver: Receiver<ActorCommand>,
    store: &mut ControlStore,
    profile: CapacityProfile,
    mut ledger: CapacityLedger,
    workspace_admission: WorkspaceAdmissionPolicy,
    mut canonical_content: CanonicalContentStore,
    mut host_sessions: host_sessions::HostSessionStore,
) {
    let mut admitted_host_sessions = std::collections::BTreeSet::new();
    while let Ok(command) = receiver.recv() {
        match command {
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
            ActorCommand::MutateRoot {
                id,
                expected_revision,
                mutation,
                reply,
            } => {
                let mut candidate = ledger.clone();
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
                            RootMutation::StartAttempt => root.start_attempt(expected_revision),
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
                    match host_sessions.load(&session_id) {
                        Ok(None) => { admitted_host_sessions.remove(&session_id); Ok(()) }
                        Ok(Some(_)) => Err(ControlError::Admission(AdmissionError::HostSessionAdmissionHasData)),
                        Err(error) => Err(ControlError::Store(error)),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::LoadHostSession { session_id, reply } => {
                let result = if admitted_host_sessions.contains(&session_id) {
                    host_sessions.load(&session_id).map_err(ControlError::Store)
                } else {
                    Err(ControlError::Admission(AdmissionError::InvalidIdentity))
                };
                let _ = reply.send(result);
            }
            ActorCommand::SaveHostSession { session_id, expected_revision, snapshot, reply } => {
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
                let _ = reply.send(Ok(host_sessions.list()));
            }
            ActorCommand::RemoveHostSession { session_id, expected_revision, reply } => {
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
            ActorCommand::CommitCandidate {
                request,
                in_flight,
                reply,
            } => {
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
        assert!(matches!(open(), Err(StoreError::WriterAlreadyOpen)));
        drop(actor);
        let reopened = open().unwrap();
        drop(reopened);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn host_sessions_require_trusted_admission_and_use_revisioned_durable_storage() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let open = || ControlActor::open(&data, "unconfigured-v1", CapacityProfile::unconfigured().unwrap(), 16, timeout);
        let actor = open().unwrap();
        let handle = actor.handle();
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
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn cumulative_operation_budgets_persist_before_ack_and_retry_idempotently() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = CapacityProfile::unconfigured().unwrap();
        let actor =
            ControlActor::open(&data, "unconfigured-v1", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        let queued = handle
            .create_root_with_budget(RootCreate {
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
            .mutate_root(
                queued.id().into(),
                queued.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
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
            .mutate_root(
                queued.id().into(),
                queued.revision(),
                RootMutation::StartAttempt,
            )
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
        let receipt = handle.commit_candidate(first.clone()).unwrap();
        assert_eq!(receipt.canonical_revision, 1);
        assert_eq!(receipt.root_revision, running.revision());
        assert_eq!(fs::read(data.join("content/sessions/session-candidate/generation-00000000000000000001.json")).unwrap(), first_bytes);
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
        assert!(data.join("content/sessions/session-candidate/generation-00000000000000000001.json").exists());
        assert!(data.join("content/sessions/session-candidate/generation-00000000000000000002.json").exists());
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
        drop(handle);
        drop(actor);

        let recovered = ControlActor::open(&data, "profile-1", profile, 8, timeout).unwrap();
        assert_eq!(recovered.handle().read_candidate_receipt("commit-candidate-1".into()).unwrap(), Some(receipt.clone()));
        assert_eq!(recovered.handle().commit_candidate(first).unwrap(), receipt);
        drop(recovered);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn native_root_creation_retries_across_recovery_without_accepting_conflicts() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(2);
        let profile = CapacityProfile::unconfigured().unwrap();
        let actor =
            ControlActor::open(&data, "unconfigured-v1", profile.clone(), 16, timeout).unwrap();
        let handle = actor.handle();
        let request = RootCreate {
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
            .mutate_root(
                created.id().into(),
                created.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn concurrent_unique_budget_charges_cannot_overshoot_the_root_limit() {
        let data = temp_data_dir();
        let timeout = Duration::from_secs(5);
        let profile = CapacityProfile::unconfigured().unwrap();
        let actor = ControlActor::open(&data, "unconfigured-v1", profile, 32, timeout).unwrap();
        let handle = actor.handle();
        let queued = handle
            .create_root_with_budget(RootCreate {
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
            .mutate_root(
                queued.id().into(),
                queued.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
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
            .mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt,
            )
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
            .mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
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
            .mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
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
            .mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
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
            .mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt,
            )
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
            .mutate_root(
                other_root.id().into(),
                other_root.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
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
            .mutate_root(
                root.id().into(),
                root.revision(),
                RootMutation::StartAttempt,
            )
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
            .mutate_root(
                active.id().into(),
                active.revision(),
                RootMutation::StartAttempt,
            )
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
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn workspace_grants_share_native_durability_and_revocation_survives_restart() {
        let data = temp_data_dir();
        let source = temp_data_dir();
        fs::create_dir(&source).unwrap();
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
        fs::create_dir(&second_source).unwrap();
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
                RootMutation::StartAttempt,
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
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn workspace_rebind_and_revoke_atomically_invalidate_queued_children_and_release_capacity() {
        let data = temp_data_dir();
        let first_source = temp_data_dir();
        let second_source = temp_data_dir();
        fs::create_dir(&first_source).unwrap();
        fs::create_dir(&second_source).unwrap();
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
