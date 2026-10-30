//! One-use, in-memory approval binding for normalized provider requests.
//!
//! The digest identifies the disclosed operation. Authorization still returns
//! the exact retained bytes; it never reconstructs a request from the digest.
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const MAX_PENDING: usize = 4;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 512;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ApprovalFence {
    pub(super) root_id: String,
    pub(super) root_revision: u64,
    pub(super) contract_revision: u64,
    pub(super) cancellation_epoch: u64,
}

impl From<&super::state::ExecutionFence> for ApprovalFence {
    fn from(fence: &super::state::ExecutionFence) -> Self {
        Self {
            root_id: fence.root_id().to_owned(),
            root_revision: fence.root_revision(),
            contract_revision: fence.contract_revision(),
            cancellation_epoch: fence.cancellation_epoch(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct OperationDisclosure {
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) operation: String,
    pub(super) destination: String,
    pub(super) max_output_tokens: u32,
    pub(super) preview: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PendingApproval {
    pub(super) ticket_id: String,
    pub(super) fingerprint: String,
    pub(super) disclosure: OperationDisclosure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ApprovalDecision {
    AllowOnce,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ApprovalError {
    InvalidRequest,
    QueueFull,
    DuplicateTicket,
    UnknownTicket,
    FingerprintMismatch,
    StaleFence,
    Denied,
}

struct Ticket {
    fence: ApprovalFence,
    operation_id: String,
    attempt: u32,
    disclosure: OperationDisclosure,
    bytes: Vec<u8>,
    fingerprint: [u8; 32],
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct ApprovedOperation {
    pub(super) fence: ApprovalFence,
    pub(super) operation_id: String,
    pub(super) attempt: u32,
    pub(super) disclosure: OperationDisclosure,
    bytes: Vec<u8>,
    fingerprint: [u8; 32],
}

impl ApprovedOperation {
    pub(super) fn request_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(super) fn fingerprint(&self) -> &[u8; 32] {
        &self.fingerprint
    }
}

#[derive(Default)]
pub(super) struct ApprovalTickets {
    pending: HashMap<String, Ticket>,
}

impl ApprovalTickets {
    pub(super) fn issue(
        &mut self,
        fence: ApprovalFence,
        operation_id: String,
        attempt: u32,
        mut disclosure: OperationDisclosure,
        bytes: Vec<u8>,
    ) -> Result<PendingApproval, ApprovalError> {
        if !valid_id(&operation_id)
            || attempt > 16
            || !valid_id(&fence.root_id)
            || disclosure.provider.is_empty()
            || disclosure.provider.len() > 64
            || disclosure.model.is_empty()
            || disclosure.model.len() > 256
            || disclosure.operation.is_empty()
            || disclosure.operation.len() > 64
            || disclosure.destination.is_empty()
            || disclosure.destination.len() > 512
            || disclosure.max_output_tokens == 0
            || bytes.is_empty()
            || bytes.len() > MAX_REQUEST_BYTES
        {
            return Err(ApprovalError::InvalidRequest);
        }
        if self.pending.contains_key(&operation_id) {
            return Err(ApprovalError::DuplicateTicket);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(ApprovalError::QueueFull);
        }
        let preview_len = bytes.len().min(MAX_PREVIEW_BYTES);
        disclosure.preview = String::from_utf8_lossy(&bytes[..preview_len]).into_owned();
        if bytes.len() > preview_len {
            disclosure.preview.push('…');
        }
        let fingerprint = fingerprint(&fence, &operation_id, attempt, &disclosure, &bytes);
        let public = PendingApproval {
            ticket_id: operation_id.clone(),
            fingerprint: hex(&fingerprint),
            disclosure: disclosure.clone(),
        };
        self.pending.insert(
            operation_id.clone(),
            Ticket {
                fence,
                operation_id,
                attempt,
                disclosure,
                bytes,
                fingerprint,
            },
        );
        Ok(public)
    }

    /// A decision consumes the ticket whether it allows, denies, or finds a
    /// stale fence. Restart recovery creates a fresh, empty registry.
    pub(super) fn decide(
        &mut self,
        ticket_id: &str,
        displayed_fingerprint: &str,
        decision: ApprovalDecision,
        current_fence: &ApprovalFence,
    ) -> Result<ApprovedOperation, ApprovalError> {
        let ticket = self
            .pending
            .remove(ticket_id)
            .ok_or(ApprovalError::UnknownTicket)?;
        if decision == ApprovalDecision::Deny {
            return Err(ApprovalError::Denied);
        }
        if hex(&ticket.fingerprint) != displayed_fingerprint {
            return Err(ApprovalError::FingerprintMismatch);
        }
        if &ticket.fence != current_fence {
            return Err(ApprovalError::StaleFence);
        }
        Ok(ApprovedOperation {
            fence: ticket.fence,
            operation_id: ticket.operation_id,
            attempt: ticket.attempt,
            disclosure: ticket.disclosure,
            bytes: ticket.bytes,
            fingerprint: ticket.fingerprint,
        })
    }

    pub(super) fn cancel_root(&mut self, root_id: &str) {
        self.pending
            .retain(|_, ticket| ticket.fence.root_id != root_id);
    }

    pub(super) fn clear(&mut self) {
        self.pending.clear();
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.pending.len()
    }
}

fn fingerprint(
    fence: &ApprovalFence,
    operation_id: &str,
    attempt: u32,
    disclosure: &OperationDisclosure,
    bytes: &[u8],
) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"vakyartha-provider-approval-v1\0");
    let root_revision = fence.root_revision.to_be_bytes();
    let contract_revision = fence.contract_revision.to_be_bytes();
    let cancellation_epoch = fence.cancellation_epoch.to_be_bytes();
    let attempt = attempt.to_be_bytes();
    let max_output_tokens = disclosure.max_output_tokens.to_be_bytes();
    for part in [
        fence.root_id.as_bytes(),
        root_revision.as_slice(),
        contract_revision.as_slice(),
        cancellation_epoch.as_slice(),
        operation_id.as_bytes(),
        attempt.as_slice(),
        disclosure.provider.as_bytes(),
        disclosure.model.as_bytes(),
        disclosure.operation.as_bytes(),
        disclosure.destination.as_bytes(),
        max_output_tokens.as_slice(),
        bytes,
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn hex(value: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fence(revision: u64) -> ApprovalFence {
        ApprovalFence {
            root_id: "root-1".into(),
            root_revision: revision,
            contract_revision: 3,
            cancellation_epoch: 5,
        }
    }

    fn disclosure() -> OperationDisclosure {
        OperationDisclosure {
            provider: "openai".into(),
            model: "model-a".into(),
            operation: "responses".into(),
            destination: "api.openai.com".into(),
            max_output_tokens: 1024,
            preview: String::new(),
        }
    }

    #[test]
    fn exact_buffer_is_returned_only_for_matching_one_use_fence_and_fingerprint() {
        let mut tickets = ApprovalTickets::default();
        let bytes = br#"{"input":"bounded"}"#.to_vec();
        let pending = tickets
            .issue(
                fence(8),
                "operation-1".into(),
                1,
                disclosure(),
                bytes.clone(),
            )
            .unwrap();
        assert_eq!(
            pending.disclosure.preview,
            String::from_utf8(bytes.clone()).unwrap()
        );
        let approved = tickets
            .decide(
                &pending.ticket_id,
                &pending.fingerprint,
                ApprovalDecision::AllowOnce,
                &fence(8),
            )
            .unwrap();
        assert_eq!(approved.request_bytes(), bytes);
        assert_eq!(approved.operation_id, "operation-1");
        assert_eq!(tickets.len(), 0);
        assert_eq!(
            tickets.decide(
                &pending.ticket_id,
                &pending.fingerprint,
                ApprovalDecision::AllowOnce,
                &fence(8),
            ),
            Err(ApprovalError::UnknownTicket)
        );
    }

    #[test]
    fn allow_consumes_stale_or_changed_disclosure_tickets_without_returning_bytes() {
        let mut tickets = ApprovalTickets::default();
        let stale = tickets
            .issue(
                fence(8),
                "operation-2".into(),
                0,
                disclosure(),
                b"payload".to_vec(),
            )
            .unwrap();
        assert_eq!(
            tickets.decide(
                &stale.ticket_id,
                &stale.fingerprint,
                ApprovalDecision::AllowOnce,
                &fence(9),
            ),
            Err(ApprovalError::StaleFence)
        );
        let changed = tickets
            .issue(
                fence(8),
                "operation-3".into(),
                0,
                disclosure(),
                b"payload".to_vec(),
            )
            .unwrap();
        assert_eq!(
            tickets.decide(
                &changed.ticket_id,
                &"0".repeat(64),
                ApprovalDecision::AllowOnce,
                &fence(8),
            ),
            Err(ApprovalError::FingerprintMismatch)
        );
        assert_eq!(tickets.len(), 0);
    }

    #[test]
    fn ticket_count_and_request_preview_are_bounded_and_root_cancel_clears_tickets() {
        let mut tickets = ApprovalTickets::default();
        for index in 0..MAX_PENDING {
            let pending = tickets
                .issue(
                    fence(8),
                    format!("operation-{index}"),
                    0,
                    disclosure(),
                    vec![b'x'; MAX_PREVIEW_BYTES + 10],
                )
                .unwrap();
            assert_eq!(
                pending.disclosure.preview.len(),
                MAX_PREVIEW_BYTES + '…'.len_utf8()
            );
        }
        assert_eq!(
            tickets.issue(
                fence(8),
                "operation-extra".into(),
                0,
                disclosure(),
                b"x".to_vec()
            ),
            Err(ApprovalError::QueueFull)
        );
        tickets.cancel_root("root-1");
        assert_eq!(tickets.len(), 0);
    }
}
