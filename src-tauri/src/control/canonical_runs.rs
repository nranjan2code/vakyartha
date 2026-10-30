//! Canonical execution is admitted and settled separately from reasoning. Only
//! protected helper evidence releases its holds; a model response cannot do so.
use super::{AdmissionError, CapacityLedger, CapacityProfile, ControlError, Resource, StoreError};
use super::{
    canonical::CanonicalContentStore,
    publication::{self, PublicationPreparation, PublicationProposal},
    root_runs::RunStatus,
    worker_completion::{self, WorkerInvocation},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Published { receipt_id: String },
    Rejected,
    WorkerFailed,
    NotLaunched,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalRun {
    pub id: String,
    pub commit_id: String,
    pub context_id: String,
    pub root_id: String,
    pub lease_id: u64,
    pub status: RunStatus,
    pub supervisor_receipt: Option<String>,
    pub exit_receipt: Option<String>,
    pub exit_code: Option<i32>,
    pub outcome: Option<Outcome>,
}
// No deserializer, clone or ambient launch token. This object is returned once
// after durable admission and moved into its native canonical-role supervisor.
pub struct Invocation {
    pub(crate) worker: WorkerInvocation,
    preparation: PublicationPreparation,
}
pub struct Proposal {
    run_id: String,
    proposal: PublicationProposal,
}
impl Invocation {
    pub fn id(&self) -> &str {
        &self.worker.run_id
    }
    pub fn frame(&self) -> serde_json::Value {
        self.preparation.frame()
    }
    pub(crate) fn response(self, bytes: &[u8]) -> Result<Proposal, ControlError> {
        Ok(Proposal {
            run_id: self.worker.run_id,
            proposal: self.preparation.response(bytes)?,
        })
    }
}
fn unavailable() -> ControlError {
    ControlError::Admission(AdmissionError::WorkerCompletionUnavailable)
}
fn amounts() -> BTreeMap<Resource, u32> {
    BTreeMap::from([
        (Resource::VerificationExecution, 1),
        (Resource::ContainedProcess, 1),
    ])
}
pub(super) fn unsettled(ledger: &CapacityLedger, root: &str) -> bool {
    ledger
        .canonical_runs
        .values()
        .any(|run| run.root_id == root && run.status != RunStatus::Settled)
}
pub(super) fn owns(ledger: &CapacityLedger, lease: u64) -> bool {
    ledger
        .canonical_runs
        .values()
        .any(|run| run.lease_id == lease)
}

pub(super) fn admit(
    ledger: &mut CapacityLedger,
    profile: &CapacityProfile,
    candidates: &CanonicalContentStore,
    publications: &CanonicalContentStore,
    native: &Path,
    commit_id: &str,
) -> Result<Invocation, ControlError> {
    let preparation = publication::prepare(
        ledger,
        candidates,
        publications,
        commit_id,
        super::tasks::now(),
    )?;
    let root_id = preparation.candidate().root_id.clone();
    if unsettled(ledger, &root_id) || ledger.canonical_runs.len() >= super::MAX_CANDIDATE_RECEIPTS {
        return Err(unavailable());
    }
    let sequence = ledger.next_lease.checked_add(1).ok_or_else(unavailable)?;
    let id = format!("canonical-{sequence}");
    let worker = worker_completion::prepare_path(native, &id)?;
    let lease = ledger
        .reserve(profile, &id, &root_id, amounts())
        .map_err(ControlError::Admission)?;
    ledger.canonical_runs.insert(
        id.clone(),
        CanonicalRun {
            id,
            commit_id: commit_id.into(),
            context_id: preparation.id().into(),
            root_id,
            lease_id: lease.id(),
            status: RunStatus::Prepared,
            supervisor_receipt: None,
            exit_receipt: None,
            exit_code: None,
            outcome: None,
        },
    );
    Ok(Invocation {
        worker,
        preparation,
    })
}

pub(super) fn confirm(
    ledger: &mut CapacityLedger,
    id: &str,
    receipt: &str,
) -> Result<CanonicalRun, ControlError> {
    if !super::valid_identity(receipt)
        || ledger
            .canonical_runs
            .values()
            .any(|run| run.id != id && run.supervisor_receipt.as_deref() == Some(receipt))
    {
        return Err(unavailable());
    }
    let run = ledger.canonical_runs.get(id).ok_or_else(unavailable)?;
    if run.status == RunStatus::Running && run.supervisor_receipt.as_deref() == Some(receipt) {
        return Ok(run.clone());
    }
    if run.status != RunStatus::Prepared {
        return Err(unavailable());
    }
    let candidate = ledger
        .candidate_receipts
        .get(&run.commit_id)
        .ok_or_else(unavailable)?;
    publication::current(ledger, candidate)?;
    let run = ledger
        .canonical_runs
        .get_mut(id)
        .expect("checked canonical run");
    run.status = RunStatus::Running;
    run.supervisor_receipt = Some(receipt.into());
    Ok(run.clone())
}

pub(super) fn finish(
    ledger: &mut CapacityLedger,
    publications: &CanonicalContentStore,
    native: &Path,
    id: &str,
    proposal: Option<Proposal>,
) -> Result<CanonicalRun, ControlError> {
    let run = ledger
        .canonical_runs
        .get(id)
        .ok_or_else(unavailable)?
        .clone();
    if run.status == RunStatus::Settled {
        return Ok(run);
    }
    let exit = worker_completion::verified_exit(native, id)?;
    let mut outcome = if exit.code == 0 {
        Outcome::Rejected
    } else {
        Outcome::WorkerFailed
    };
    if let Some(proposal) = proposal {
        if proposal.run_id != id || proposal.proposal.context_id() != run.context_id {
            return Err(unavailable());
        }
        if run.status == RunStatus::Running && exit.code == 0 {
            match publication::stage(ledger, publications, proposal.proposal) {
                Ok((next, receipt)) => {
                    *ledger = next;
                    outcome = Outcome::Published {
                        receipt_id: receipt.id,
                    };
                }
                Err(ControlError::Store(error)) => return Err(ControlError::Store(error)),
                Err(_) => {}
            }
        }
    }
    settle(ledger, id, Some(exit.receipt), Some(exit.code), outcome)
}

pub(super) fn abandon_before_spawn(
    ledger: &mut CapacityLedger,
    id: &str,
) -> Result<CanonicalRun, ControlError> {
    let run = ledger.canonical_runs.get(id).ok_or_else(unavailable)?;
    if run.status == RunStatus::Settled && run.outcome == Some(Outcome::NotLaunched) {
        return Ok(run.clone());
    }
    if run.status != RunStatus::Prepared {
        return Err(unavailable());
    }
    settle(ledger, id, None, None, Outcome::NotLaunched)
}
fn settle(
    ledger: &mut CapacityLedger,
    id: &str,
    receipt: Option<String>,
    code: Option<i32>,
    outcome: Outcome,
) -> Result<CanonicalRun, ControlError> {
    let run = ledger.canonical_runs.get(id).ok_or_else(unavailable)?;
    let lease = ledger.active_lease(run.lease_id).ok_or_else(unavailable)?;
    ledger.release(&lease).map_err(ControlError::Admission)?;
    let run = ledger
        .canonical_runs
        .get_mut(id)
        .expect("checked canonical run");
    run.status = RunStatus::Settled;
    run.exit_receipt = receipt;
    run.exit_code = code;
    run.outcome = Some(outcome);
    Ok(run.clone())
}

pub(super) fn recover(ledger: &mut CapacityLedger) -> bool {
    let mut changed = false;
    for run in ledger.canonical_runs.values_mut() {
        if matches!(run.status, RunStatus::Prepared | RunStatus::Running) {
            run.status = RunStatus::Interrupted;
            changed = true;
        }
    }
    changed
}
pub(super) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    if ledger.canonical_runs.len() > super::MAX_CANDIDATE_RECEIPTS {
        return Err(StoreError::Corrupt);
    }
    let mut active_roots = BTreeSet::new();
    let mut supervisors = BTreeSet::new();
    for (id, run) in &ledger.canonical_runs {
        let candidate = ledger
            .candidate_receipts
            .get(&run.commit_id)
            .ok_or(StoreError::Corrupt)?;
        let lease = ledger
            .issued
            .get(&run.lease_id)
            .ok_or(StoreError::Corrupt)?;
        let settled = run.status == RunStatus::Settled;
        let not_launched = run.outcome == Some(Outcome::NotLaunched);
        if id != &run.id
            || id != &format!("canonical-{}", run.lease_id)
            || candidate.root_id != run.root_id
            || lease.root_id() != run.root_id
            || lease.request_id != *id
            || lease.amounts() != &amounts()
            || !run
                .context_id
                .strip_prefix("publication-")
                .is_some_and(|value| {
                    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
                })
            || settled == ledger.active.contains_key(&run.lease_id)
            || settled != run.outcome.is_some()
            || (settled && !not_launched) != run.exit_receipt.is_some()
            || (settled && !not_launched) != run.exit_code.is_some()
            || run.exit_code.is_some_and(|code| !(0..=255).contains(&code))
            || run.exit_receipt.as_ref().is_some_and(|receipt| {
                !receipt
                    .strip_prefix(&format!("worker-exit-{id}-"))
                    .is_some_and(|digest| {
                        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
            })
            || run.supervisor_receipt.as_ref().is_some_and(|receipt| {
                !super::valid_identity(receipt) || !supervisors.insert(receipt)
            })
            || run.status == RunStatus::Prepared && run.supervisor_receipt.is_some()
            || run.status == RunStatus::Running && run.supervisor_receipt.is_none()
            || not_launched && run.supervisor_receipt.is_some()
            || !settled && !active_roots.insert(&run.root_id)
        {
            return Err(StoreError::Corrupt);
        }
        if matches!(run.outcome, Some(Outcome::Rejected)) && run.exit_code != Some(0)
            || matches!(run.outcome, Some(Outcome::WorkerFailed))
                && !run.exit_code.is_some_and(|code| code > 0)
        {
            return Err(StoreError::Corrupt);
        }
        if let Some(Outcome::Published { receipt_id }) = &run.outcome {
            let receipt = ledger
                .publication_receipts
                .get(receipt_id)
                .ok_or(StoreError::Corrupt)?;
            if receipt.id != run.context_id
                || receipt.candidate != *candidate
                || run.exit_code != Some(0)
                || run.supervisor_receipt.is_none()
            {
                return Err(StoreError::Corrupt);
            }
        }
    }
    Ok(())
}
