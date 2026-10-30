//! Native execution records retain their capacity charge until the trusted
//! supervisor proves exit. A task status change is never an exit receipt.
use super::state::{RootStatus, RootTask, StateError};
use super::{AdmissionError, CapacityLedger, CapacityProfile, ControlError, Resource, StoreError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Prepared,
    Running,
    Interrupted,
    Settled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RootRun {
    pub id: String,
    pub request_id: String,
    pub root_id: String,
    pub session_id: Option<String>,
    pub lease_id: u64,
    pub admission_revision: u64,
    pub cancellation_epoch: u64,
    pub status: RunStatus,
    pub supervisor_receipt: Option<String>,
    pub exit_receipt: Option<String>,
    pub worker_lease_id: Option<u64>,
    pub worker_exit_receipt: Option<String>,
    pub worker_exit_code: Option<i32>,
    #[serde(default)]
    pub active_ms: u64,
    #[serde(default)]
    pub charged_ms: u64,
}

pub(super) fn prepare(
    ledger: &mut CapacityLedger,
    profile: &CapacityProfile,
    root_id: &str,
    expected_revision: u64,
    request_id: &str,
) -> Result<RootTask, ControlError> {
    if !super::valid_identity(request_id) {
        return Err(ControlError::Admission(AdmissionError::InvalidIdentity));
    }
    if let Some(run) = ledger
        .root_runs
        .values()
        .find(|run| run.request_id == request_id)
    {
        if run.root_id != root_id || run.admission_revision != expected_revision {
            return Err(ControlError::Admission(
                AdmissionError::ConflictingRequestIdentity,
            ));
        }
        return ledger
            .roots
            .get(root_id)
            .cloned()
            .ok_or(ControlError::Admission(AdmissionError::RootNotFound));
    }
    if ledger.request_ids.contains_key(request_id) {
        return Err(ControlError::Admission(
            AdmissionError::ConflictingRequestIdentity,
        ));
    }
    if super::generation::unsettled(ledger, root_id)
        || super::canonical_runs::unsettled(ledger, root_id)
    {
        return Err(ControlError::Admission(AdmissionError::RootRunUnsettled));
    }
    if ledger
        .root_runs
        .values()
        .any(|run| run.root_id == root_id && run.status != RunStatus::Settled)
    {
        return Err(ControlError::Admission(AdmissionError::RootRunUnsettled));
    }
    let root = ledger
        .roots
        .get_mut(root_id)
        .ok_or(ControlError::Admission(AdmissionError::RootNotFound))?;
    root.start_attempt(expected_revision)
        .map_err(ControlError::TaskState)?;
    if root.status() != RootStatus::Running {
        return Ok(root.clone());
    }
    let root = root.clone();
    let lease = ledger
        .reserve(
            profile,
            request_id,
            root_id,
            BTreeMap::from([(Resource::Generation, 1)]),
        )
        .map_err(ControlError::Admission)?;
    let id = format!("run-{}", lease.id());
    ledger.root_runs.insert(
        id.clone(),
        RootRun {
            id,
            request_id: request_id.into(),
            root_id: root_id.into(),
            session_id: root.session_id().map(str::to_owned),
            lease_id: lease.id(),
            admission_revision: expected_revision,
            cancellation_epoch: root.cancellation_epoch(),
            status: RunStatus::Prepared,
            supervisor_receipt: None,
            exit_receipt: None,
            worker_lease_id: None,
            worker_exit_receipt: None,
            worker_exit_code: None,
            active_ms: 0,
            charged_ms: 0,
        },
    );
    Ok(root)
}

pub(super) fn confirm(
    ledger: &mut CapacityLedger,
    run_id: &str,
    receipt: &str,
) -> Result<RootRun, ControlError> {
    if !super::valid_identity(receipt) {
        return Err(ControlError::Admission(AdmissionError::InvalidIdentity));
    }
    if ledger
        .root_runs
        .values()
        .any(|run| run.id != run_id && run.supervisor_receipt.as_deref() == Some(receipt))
    {
        return Err(ControlError::Admission(
            AdmissionError::ConflictingRequestIdentity,
        ));
    }
    let run = ledger
        .root_runs
        .get_mut(run_id)
        .ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
    if run.status == RunStatus::Running && run.supervisor_receipt.as_deref() == Some(receipt) {
        return Ok(run.clone());
    }
    let root = ledger
        .roots
        .get(&run.root_id)
        .ok_or(ControlError::Admission(AdmissionError::RootNotFound))?;
    if run
        .worker_lease_id
        .is_some_and(|id| !ledger.active.contains_key(&id))
        || run.status != RunStatus::Prepared
        || root.status() != RootStatus::Running
        || root.cancellation_epoch() != run.cancellation_epoch
        || root.workspace_grant().is_some_and(|grant| {
            ledger
                .registry
                .grant(&grant.session_id, grant.binding_revision)
                .map_or(true, |current| &current != grant)
        })
    {
        return Err(ControlError::TaskState(StateError::ExecutionFenceStale));
    }
    run.status = RunStatus::Running;
    run.supervisor_receipt = Some(receipt.into());
    Ok(run.clone())
}

pub(super) fn settle(
    ledger: &mut CapacityLedger,
    run_id: &str,
    receipt: &str,
) -> Result<RootRun, ControlError> {
    if !super::valid_identity(receipt) {
        return Err(ControlError::Admission(AdmissionError::InvalidIdentity));
    }
    if ledger
        .root_runs
        .values()
        .any(|run| run.id != run_id && run.exit_receipt.as_deref() == Some(receipt))
    {
        return Err(ControlError::Admission(
            AdmissionError::ConflictingRequestIdentity,
        ));
    }
    let run = ledger
        .root_runs
        .get(run_id)
        .ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
    if run.status == RunStatus::Settled {
        return if run.exit_receipt.as_deref() == Some(receipt) {
            Ok(run.clone())
        } else {
            Err(ControlError::Admission(
                AdmissionError::ConflictingRequestIdentity,
            ))
        };
    }
    if run
        .worker_lease_id
        .is_some_and(|id| ledger.active.contains_key(&id))
    {
        return Err(ControlError::Admission(
            AdmissionError::WorkerCompletionUnavailable,
        ));
    }
    let lease = ledger
        .active_lease(run.lease_id)
        .ok_or(ControlError::Admission(AdmissionError::UnknownLease))?;
    ledger.release(&lease).map_err(ControlError::Admission)?;
    let run = ledger.root_runs.get_mut(run_id).expect("run checked above");
    run.status = RunStatus::Settled;
    run.exit_receipt = Some(receipt.into());
    Ok(run.clone())
}

/// A current root fence alone does not prove an executing invocation exists.
/// This check belongs inside the actor transaction that accepts a new effect.
pub(super) fn has_running_invocation(ledger: &CapacityLedger, root: &RootTask) -> bool {
    root.status() == RootStatus::Running
        && ledger.root_runs.values().any(|run| {
            run.root_id == root.id()
                && run.status == RunStatus::Running
                && run.session_id.as_deref() == root.session_id()
                && run.cancellation_epoch == root.cancellation_epoch()
                && ledger.active.contains_key(&run.lease_id)
        })
}

pub(super) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    let mut active_roots = std::collections::BTreeSet::new();
    let mut leases = std::collections::BTreeSet::new();
    let mut starts = std::collections::BTreeSet::new();
    let mut exits = std::collections::BTreeSet::new();
    let mut counts = BTreeMap::<&str, usize>::new();
    for (id, run) in &ledger.root_runs {
        *counts.entry(&run.root_id).or_default() += 1;
        let root = ledger.roots.get(&run.root_id).ok_or(StoreError::Corrupt)?;
        let lease = ledger
            .issued
            .get(&run.lease_id)
            .ok_or(StoreError::Corrupt)?;
        if let Some(worker_id) = run.worker_lease_id {
            let worker = ledger.issued.get(&worker_id).ok_or(StoreError::Corrupt)?;
            if !leases.insert(worker_id)
                || worker.root_id() != root.id()
                || worker.request_id != format!("reasoner-{}", run.id)
                || worker.amounts() != &BTreeMap::from([(Resource::ContainedProcess, 1)])
                || ledger.active.contains_key(&worker_id) == run.worker_exit_receipt.is_some()
                || run.status == RunStatus::Settled && run.worker_exit_receipt.is_none()
            {
                return Err(StoreError::Corrupt);
            }
        } else if run.worker_exit_receipt.is_some() || run.worker_exit_code.is_some() {
            return Err(StoreError::Corrupt);
        }
        if let Some(receipt) = &run.worker_exit_receipt {
            let valid = if run.worker_exit_code.is_some() {
                receipt
                    .strip_prefix(&format!("worker-exit-{}-", run.id))
                    .is_some_and(|hash| {
                        hash.len() == 64
                            && hash
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
            } else {
                *receipt == format!("reasoner-not-launched-{}", run.id)
            };
            if !valid {
                return Err(StoreError::Corrupt);
            }
        }
        if run
            .worker_exit_code
            .is_some_and(|code| !(0..=255).contains(&code))
            || run.worker_exit_code.is_some() && run.worker_exit_receipt.is_none()
            || run
                .worker_exit_receipt
                .as_deref()
                .is_some_and(|receipt| !super::valid_identity(receipt))
        {
            return Err(StoreError::Corrupt);
        }
        if id != &format!("run-{}", run.lease_id)
            || run.id != *id
            || !super::valid_identity(&run.request_id)
            || run.session_id.as_deref() != root.session_id()
            || run.admission_revision == 0
            || run.admission_revision >= root.revision()
            || run.cancellation_epoch == 0
            || run.cancellation_epoch > root.cancellation_epoch()
            || lease.root_id() != root.id()
            || lease.request_id != run.request_id
            || lease.amounts() != &BTreeMap::from([(Resource::Generation, 1)])
            || !leases.insert(run.lease_id)
            || run
                .supervisor_receipt
                .as_ref()
                .is_some_and(|receipt| !starts.insert(receipt))
            || run
                .exit_receipt
                .as_ref()
                .is_some_and(|receipt| !exits.insert(receipt))
            || run
                .supervisor_receipt
                .as_deref()
                .is_some_and(|receipt| !super::valid_identity(receipt))
            || run
                .exit_receipt
                .as_deref()
                .is_some_and(|receipt| !super::valid_identity(receipt))
            || (run.status == RunStatus::Running && run.supervisor_receipt.is_none())
            || (run.status == RunStatus::Prepared && run.supervisor_receipt.is_some())
            || (run.status == RunStatus::Settled) != run.exit_receipt.is_some()
            || (run.status != RunStatus::Settled) != ledger.active.contains_key(&run.lease_id)
            || (run.status != RunStatus::Settled && !active_roots.insert(&run.root_id))
        {
            return Err(StoreError::Corrupt);
        }
    }
    for root in ledger.roots.values() {
        if counts.get(root.id()).copied().unwrap_or(0) != root.runs_started() as usize {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}
