//! Only the trusted window supplies a decision. Dispatch objects travel through
//! a native receiver owned by the requesting supervisor, never through IPC.
use super::*;
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, SyncSender, TryRecvError},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConsentRejection {
    Denied,
    Cancelled,
    Expired,
    Refused,
    Unavailable,
}
#[derive(Clone, Debug, Serialize)]
pub struct ConsentView {
    pub root_id: String,
    pub session_id: String,
    pub goal: String,
    pub remaining_seconds: u64,
    pub approval: PendingApproval,
}
#[derive(Clone, Debug, Serialize)]
pub struct ConsentReceipt {
    pub ticket_id: String,
    pub state: &'static str,
    pub operation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentState {
    Allowed,
    Denied,
    Refused,
    Cancelled,
}
impl ConsentState {
    fn label(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Denied => "denied",
            Self::Refused => "refused",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConsentRecord {
    pub ticket_id: String,
    pub fingerprint: String,
    pub root_id: String,
    pub run_id: String,
    pub fence: ExecutionFence,
    pub decision: Decision,
    pub state: ConsentState,
    pub operation_id: Option<String>,
    pub at: String,
}
impl ConsentRecord {
    pub(in crate::control) fn receipt(&self) -> ConsentReceipt {
        ConsentReceipt {
            ticket_id: self.ticket_id.clone(),
            state: self.state.label(),
            operation_id: self.operation_id.clone(),
        }
    }
}

pub struct PendingConsent {
    pub(in crate::control) approval: Option<PendingApproval>,
    pub(in crate::control) reply: Receiver<Result<Dispatch, ConsentRejection>>,
    pub(in crate::control) closed: Arc<AtomicBool>,
    pub(in crate::control) finished: bool,
}
impl PendingConsent {
    pub fn approval(&self) -> &PendingApproval {
        self.approval.as_ref().expect("native issued consent")
    }
    /// Retain the receiver until an actor barrier has retired its producer.
    /// A buffered permit can then be recovered as definitely not dispatched.
    pub fn close(&mut self) {
        self.closed.store(true, Ordering::Release);
    }
    pub fn try_decision(&mut self) -> Option<Result<Dispatch, ConsentRejection>> {
        if self.finished {
            return None;
        }
        let result = match self.reply.try_recv() {
            Ok(result) => Some(result),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err(ConsentRejection::Unavailable)),
        };
        if result.is_some() {
            self.finished = true;
        }
        result
    }
}
impl Drop for PendingConsent {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
    }
}
pub(in crate::control) struct Delivery {
    pub reply: SyncSender<Result<Dispatch, ConsentRejection>>,
    pub closed: Arc<AtomicBool>,
    pub approval: Option<PendingApproval>,
}

impl Approvals {
    pub(in crate::control) fn decision_scope(
        &self,
        id: &str,
        fingerprint: &str,
        decision: Decision,
    ) -> Result<ConsentRecord, ControlError> {
        let pending = self.pending.get(id).ok_or_else(refused)?;
        Ok(ConsentRecord {
            ticket_id: id.into(),
            fingerprint: fingerprint.into(),
            root_id: pending.fence.root_id().into(),
            run_id: pending.run_id.clone(),
            fence: pending.fence.clone(),
            decision,
            state: ConsentState::Refused,
            operation_id: None,
            at: super::super::tasks::now(),
        })
    }
    pub(in crate::control) fn has_delivery(&self, id: &str) -> bool {
        self.deliveries.contains_key(id)
    }
    pub(in crate::control) fn cancel_ticket(&mut self, id: &str) {
        self.pending.remove(id);
        self.tickets.discard(id);
    }
    pub(in crate::control) fn attach(
        &mut self,
        ticket: &PendingApproval,
        mut delivery: Delivery,
    ) -> Result<(), ControlError> {
        if !self.pending.contains_key(&ticket.ticket_id)
            || self.deliveries.contains_key(&ticket.ticket_id)
        {
            return Err(refused());
        }
        delivery.approval = Some(ticket.clone());
        self.deliveries.insert(ticket.ticket_id.clone(), delivery);
        Ok(())
    }
    pub(in crate::control) fn views(&self, ledger: &CapacityLedger) -> Vec<ConsentView> {
        self.deliveries
            .iter()
            .filter_map(|(id, delivery)| {
                let pending = self.pending.get(id)?;
                let root = ledger.roots.get(pending.fence.root_id())?;
                Some(ConsentView {
                    root_id: root.id().into(),
                    session_id: root.session_id()?.into(),
                    goal: root.goal().into(),
                    remaining_seconds: APPROVAL_TTL
                        .saturating_sub(pending.created.elapsed())
                        .as_secs(),
                    approval: delivery.approval.clone()?,
                })
            })
            .collect()
    }
    pub(in crate::control) fn consent_slice(
        &self,
        id: &str,
        fingerprint: &str,
        offset: usize,
    ) -> Result<RequestSlice, ControlError> {
        if !self.deliveries.contains_key(id) {
            return Err(refused());
        }
        self.tickets
            .read_slice(id, fingerprint, offset)
            .map_err(|_| refused())
    }
    pub(in crate::control) fn take_delivery(
        &mut self,
        id: &str,
        fingerprint: &str,
    ) -> Result<Delivery, ControlError> {
        let delivery = self.deliveries.get(id).ok_or_else(refused)?;
        if delivery.closed.load(Ordering::Acquire)
            || delivery
                .approval
                .as_ref()
                .is_none_or(|view| view.fingerprint != fingerprint)
        {
            return Err(refused());
        }
        self.deliveries.remove(id).ok_or_else(refused)
    }
}

pub(in crate::control) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    if ledger.provider_consents.len() > MAX_OPERATIONS {
        return Err(StoreError::Corrupt);
    }
    for (id, record) in &ledger.provider_consents {
        let root = ledger
            .roots
            .get(&record.root_id)
            .ok_or(StoreError::Corrupt)?;
        let run = ledger
            .root_runs
            .get(&record.run_id)
            .ok_or(StoreError::Corrupt)?;
        if record.ticket_id != *id
            || !super::super::valid_identity(id)
            || record.root_id != record.fence.root_id()
            || run.root_id != record.root_id
            || record.fingerprint.len() != 64
            || !record
                .fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || record.fence.root_revision() == 0
            || record.fence.root_revision() > root.revision()
            || record.fence.contract_revision() == 0
            || record.fence.contract_revision() > root.contract_revision()
            || record.fence.cancellation_epoch() != run.cancellation_epoch
            || !super::super::tasks::valid_timestamp(&record.at)
        {
            return Err(StoreError::Corrupt);
        }
        if let Some(operation) = &record.operation_id {
            let operation = ledger
                .provider_operations
                .get(operation)
                .ok_or(StoreError::Corrupt)?;
            if operation.id != *id
                || operation.approval_fingerprint != record.fingerprint
                || operation.fence != record.fence
                || record.decision != Decision::AllowOnce
            {
                return Err(StoreError::Corrupt);
            }
            if record.state == ConsentState::Cancelled
                && operation
                    .receipt
                    .as_ref()
                    .is_none_or(|r| r.outcome != IoOutcome::NotDispatched)
            {
                return Err(StoreError::Corrupt);
            }
        }
        if record.state == ConsentState::Allowed
            && (record.operation_id.as_deref() != Some(id)
                || record.decision != Decision::AllowOnce)
            || record.state == ConsentState::Denied
                && (record.operation_id.is_some() || record.decision != Decision::Deny)
            || record.state == ConsentState::Refused
                && (record.operation_id.is_some() || record.decision != Decision::AllowOnce)
        {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}
