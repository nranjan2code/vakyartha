//! Native approval/charge handoff. Requests stay ephemeral; only redacted
//! operation identities and uncertainty are durable. No worker calls this API.
use super::approval::{
    ApprovalDecision, ApprovalFence, ApprovalTickets, OperationDisclosure, PendingApproval,
};
use super::broker::{GenerationPermit, ModelApi, ModelOperation, prepare_generation_body};
use super::state::{BudgetCharge, BudgetKind, ExecutionFence, RootStatus};
use super::{AdmissionError, CapacityLedger, CapacityProfile, ControlError, Resource, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

mod consent;
pub use super::approval::RequestSlice;
pub use super::approval::{ApprovalDecision as Decision, PendingApproval as Approval};
pub(super) use consent::Delivery;
pub use consent::{
    ConsentReceipt, ConsentRecord, ConsentRejection, ConsentState, ConsentView, PendingConsent,
};

const MAX_OPERATIONS: usize = 10_000;
const APPROVAL_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    DispatchCommitted,
    IoStarted,
    Interrupted,
    Returned,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperationRecord {
    pub id: String,
    pub run_id: String,
    pub root_id: String,
    pub operation_id: String,
    pub attempt: u32,
    pub fence: ExecutionFence,
    pub charged_root_revision: u64,
    pub lease_id: u64,
    pub request_digest: String,
    pub approval_fingerprint: String,
    pub request_bytes: u32,
    pub status: OperationStatus,
    pub io_started: bool,
    pub receipt: Option<ResultReceipt>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IoOutcome {
    Completed,
    Cancelled,
    TimedOut,
    TransportFailed,
    ResponseLimit,
    ConsumerClosed,
    NotDispatched,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResultReceipt {
    pub outcome: IoOutcome,
    pub id: String,
    pub status_code: Option<u16>,
    pub response_bytes: u32,
}

struct Pending {
    run_id: String,
    operation_id: String,
    attempt: u32,
    fence: ExecutionFence,
    created: Instant,
}

#[derive(Default)]
pub(super) struct Approvals {
    tickets: ApprovalTickets,
    pending: BTreeMap<String, Pending>,
    deliveries: BTreeMap<String, Delivery>,
}

/// Move-only native value. It is never serialized, cloned, logged or returned
/// over IPC; a lost reply leaves the durable operation uncertain, never replayed.
pub struct Dispatch {
    operation: OperationRecord,
    permit: GenerationPermit,
    bytes: Vec<u8>,
}

impl Dispatch {
    #[cfg(test)]
    pub(super) fn into_request(self) -> (OperationRecord, GenerationPermit, Vec<u8>) {
        (self.operation, self.permit, self.bytes)
    }
    pub fn operation(&self) -> &OperationRecord {
        &self.operation
    }
}
pub(crate) struct StartedDispatch(Dispatch);
impl StartedDispatch {
    pub(super) fn into_request(self) -> (OperationRecord, GenerationPermit, Vec<u8>) {
        (self.0.operation, self.0.permit, self.0.bytes)
    }
}

impl std::fmt::Debug for Dispatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dispatch")
            .field("operation_id", &self.operation.id)
            .field("request_bytes", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

pub(super) fn io_current(ledger: &CapacityLedger, id: &str) -> Result<(), ControlError> {
    let record = ledger.provider_operations.get(id).ok_or_else(refused)?;
    let root = running(ledger, &record.run_id)?;
    if record.status != OperationStatus::IoStarted
        || !record.io_started
        || root.revision() != record.charged_root_revision
        || root.contract_revision() != record.fence.contract_revision()
        || root.cancellation_epoch() != record.fence.cancellation_epoch()
        || !ledger.active.contains_key(&record.lease_id)
    {
        return Err(refused());
    }
    Ok(())
}

pub(super) fn begin(
    ledger: &mut CapacityLedger,
    mut dispatch: Dispatch,
) -> Result<StartedDispatch, ControlError> {
    let record = ledger
        .provider_operations
        .get(&dispatch.operation.id)
        .ok_or_else(refused)?;
    let root = running(ledger, &record.run_id)?;
    if record != &dispatch.operation
        || record.status != OperationStatus::DispatchCommitted
        || record.io_started
        || root.revision() != record.charged_root_revision
        || root.contract_revision() != record.fence.contract_revision()
        || root.cancellation_epoch() != record.fence.cancellation_epoch()
        || !ledger.active.contains_key(&record.lease_id)
        || super::canonical::digest(&dispatch.bytes) != record.request_digest
        || dispatch.bytes.len() != record.request_bytes as usize
    {
        return Err(refused());
    }
    let record = ledger
        .provider_operations
        .get_mut(&dispatch.operation.id)
        .expect("checked operation");
    record.status = OperationStatus::IoStarted;
    record.io_started = true;
    dispatch.operation = record.clone();
    Ok(StartedDispatch(dispatch))
}

fn valid_receipt(record: &OperationRecord, receipt: &ResultReceipt) -> bool {
    match receipt.outcome {
        IoOutcome::NotDispatched => receipt.status_code.is_none() && receipt.response_bytes == 0,
        IoOutcome::Completed => record.io_started && receipt.status_code.is_some(),
        _ => record.io_started,
    }
}

fn refused() -> ControlError {
    ControlError::Admission(AdmissionError::ProviderApprovalRefused)
}
fn identity(run_id: &str, operation_id: &str, attempt: u32) -> String {
    // JSON encoding is an unambiguous identity tuple, not an authentication
    // protocol. Native invocation binding and retained bytes supply authority.
    format!(
        "provider-{}",
        super::canonical::digest(
            json!([run_id, operation_id, attempt])
                .to_string()
                .as_bytes()
        )
    )
}

fn running<'a>(
    ledger: &'a CapacityLedger,
    run_id: &str,
) -> Result<&'a super::state::RootTask, ControlError> {
    let run = ledger.root_runs.get(run_id).ok_or_else(refused)?;
    let root = ledger.roots.get(&run.root_id).ok_or_else(refused)?;
    if run.session_id.is_none()
        || run.status != super::root_runs::RunStatus::Running
        || root.status() != RootStatus::Running
        || run.cancellation_epoch != root.cancellation_epoch()
        || run.session_id.as_deref() != root.session_id()
        || !ledger.active.contains_key(&run.lease_id)
        || run.worker_lease_id.is_some_and(|id| !ledger.active.contains_key(&id))
        || root
            .workspace_grant()
            .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
    {
        return Err(refused());
    }
    Ok(root)
}

fn resolve_task_provider(
    ledger: &CapacityLedger,
    root: &super::state::RootTask,
) -> Result<(&'static str, &'static str, ModelApi, ModelOperation), ControlError> {
    if let Some(record) = ledger.product_tasks.get(root.id()) {
        let prov = record.request.provider.as_str();
        if prov != "ollama"
            && !matches!(
                record.request.spending,
                super::tasks::Spending::ApiAllowed { acknowledged: true }
            )
        {
            return Err(refused());
        }
        let policy = root.local_model().ok_or_else(refused)?;
        let (prov_name, op_name, api, op) = match prov {
            "ollama" => ("ollama", "ollama_chat", ModelApi::OllamaLocal, ModelOperation::OllamaChat),
            "openai" => ("openai", "chat_completions", ModelApi::OpenAi, ModelOperation::ChatCompletions),
            "anthropic" => ("anthropic", "messages", ModelApi::Anthropic, ModelOperation::Messages),
            "gemini" => (
                "gemini",
                "stream_generate_content",
                ModelApi::Gemini,
                ModelOperation::StreamGenerateContent {
                    model: policy.model.clone(),
                },
            ),
            "mistral" => ("mistral", "chat_completions", ModelApi::Mistral, ModelOperation::ChatCompletions),
            "xai" => ("xai", "chat_completions", ModelApi::Xai, ModelOperation::ChatCompletions),
            "deepseek" => ("deepseek", "chat_completions", ModelApi::DeepSeek, ModelOperation::ChatCompletions),
            "groq" => ("groq", "chat_completions", ModelApi::Groq, ModelOperation::ChatCompletions),
            "cerebras" => ("cerebras", "chat_completions", ModelApi::Cerebras, ModelOperation::ChatCompletions),
            "openrouter" => ("openrouter", "chat_completions", ModelApi::OpenRouter, ModelOperation::ChatCompletions),
            "together" => ("together", "chat_completions", ModelApi::Together, ModelOperation::ChatCompletions),
            "fireworks" => ("fireworks", "chat_completions", ModelApi::Fireworks, ModelOperation::ChatCompletions),
            "moonshot" => ("moonshot", "chat_completions", ModelApi::Moonshot, ModelOperation::ChatCompletions),
            "dashscope" | "qwen" => ("dashscope", "chat_completions", ModelApi::DashScope, ModelOperation::ChatCompletions),
            "typesafe" => ("typesafe", "chat_completions", ModelApi::TypeSafe, ModelOperation::ChatCompletions),
            "lmstudio" => ("lmstudio", "chat_completions", ModelApi::LmStudio, ModelOperation::ChatCompletions),
            _ => return Err(refused()),
        };
        Ok((prov_name, op_name, api, op))
    } else {
        Ok(("ollama", "ollama_chat", ModelApi::OllamaLocal, ModelOperation::OllamaChat))
    }
}

fn permit_for_task(
    ledger: &CapacityLedger,
    root: &super::state::RootTask,
) -> Result<GenerationPermit, ControlError> {
    let policy = root.local_model().ok_or_else(refused)?;
    policy.validate().map_err(ControlError::TaskState)?;
    let (_, _, provider, operation) = resolve_task_provider(ledger, root)?;
    GenerationPermit::from_admitted_policy(
        provider,
        operation,
        policy.model.clone(),
        policy.max_output_tokens,
        policy.max_request_bytes as usize,
        BTreeSet::new(),
        BTreeMap::from([
            ("think".into(), json!(false)),
            ("keep_alive".into(), json!("30m")),
        ]),
    )
    .map_err(|_| refused())
}

fn permit(root: &super::state::RootTask) -> Result<GenerationPermit, ControlError> {
    let policy = root.local_model().ok_or_else(refused)?;
    policy.validate().map_err(ControlError::TaskState)?;
    GenerationPermit::from_admitted_policy(
        ModelApi::OllamaLocal,
        ModelOperation::OllamaChat,
        policy.model.clone(),
        policy.max_output_tokens,
        policy.max_request_bytes as usize,
        BTreeSet::new(),
        BTreeMap::from([
            ("think".into(), json!(false)),
            ("keep_alive".into(), json!("30m")),
        ]),
    )
    .map_err(|_| refused())
}

impl Approvals {
    pub(super) fn prune(&mut self, ledger: &CapacityLedger) {
        let invalid: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(id, pending)| {
                let reason = if pending.created.elapsed() >= APPROVAL_TTL {
                    Some(ConsentRejection::Expired)
                } else if self.deliveries.get(id).is_some_and(|delivery| {
                    delivery.closed.load(std::sync::atomic::Ordering::Acquire)
                }) || running(ledger, &pending.run_id)
                    .map_or(true, |root| root.execution_fence() != pending.fence)
                {
                    Some(ConsentRejection::Cancelled)
                } else {
                    None
                };
                reason.map(|reason| (id.clone(), reason))
            })
            .collect();
        for (id, reason) in invalid {
            self.pending.remove(&id);
            self.tickets.discard(&id);
            if let Some(delivery) = self.deliveries.remove(&id) {
                let _ = delivery.reply.try_send(Err(reason));
            }
        }
    }

    pub(super) fn issue(
        &mut self,
        ledger: &CapacityLedger,
        run_id: String,
        operation_id: String,
        attempt: u32,
        body: Vec<u8>,
    ) -> Result<PendingApproval, ControlError> {
        self.prune(ledger);
        if !super::valid_identity(&operation_id)
            || attempt > 16
            || ledger.provider_operations.len() >= MAX_OPERATIONS
            || ledger
                .provider_consents
                .len()
                .saturating_add(self.pending.len())
                >= MAX_OPERATIONS
        {
            return Err(refused());
        }
        let root = running(ledger, &run_id)?;
        let policy = root.local_model().ok_or_else(refused)?;
        let id = identity(&run_id, &operation_id, attempt);
        if ledger.provider_operations.contains_key(&id)
            || ledger.provider_consents.contains_key(&id)
            || self.pending.contains_key(&id)
        {
            return Err(refused());
        }
        let (prov_name, op_name, api, op) = resolve_task_provider(ledger, root)?;
        let destination = super::broker::model_endpoint(api, op)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| "http://127.0.0.1:11434/api/chat".to_owned());
        let bytes = prepare_generation_body(&permit_for_task(ledger, root)?, &body).map_err(|_| refused())?;
        let fence = root.execution_fence();
        let ticket = self
            .tickets
            .issue(
                ApprovalFence::from(&fence),
                id.clone(),
                attempt,
                OperationDisclosure {
                    provider: prov_name.into(),
                    model: policy.model.clone(),
                    operation: op_name.into(),
                    destination,
                    max_output_tokens: policy.max_output_tokens,
                    preview: String::new(),
                },
                bytes,
            )
            .map_err(|_| refused())?;
        self.pending.insert(
            id,
            Pending {
                run_id,
                operation_id,
                attempt,
                fence,
                created: Instant::now(),
            },
        );
        Ok(ticket)
    }

    pub(super) fn decide(
        &mut self,
        ledger: &mut CapacityLedger,
        profile: &CapacityProfile,
        ticket_id: &str,
        fingerprint: &str,
        decision: ApprovalDecision,
    ) -> Result<Option<Dispatch>, ControlError> {
        self.prune(ledger);
        let pending = self.pending.remove(ticket_id).ok_or_else(refused)?;
        let root = running(ledger, &pending.run_id)?;
        let fence = root.execution_fence();
        let approved = self
            .tickets
            .decide(
                ticket_id,
                fingerprint,
                decision,
                &ApprovalFence::from(&fence),
            )
            .map_err(|_| refused())?;
        if fence != pending.fence || ledger.provider_operations.contains_key(ticket_id) {
            return Err(refused());
        }
        let permit = permit_for_task(ledger, root)?;
        let root_id = root.id().to_owned();
        let queued: Vec<_> = root
            .children()
            .values()
            .filter(|child| child.status() == super::state::ChildStatus::Queued)
            .map(super::state::ChildTask::queue_lease_id)
            .collect();
        let bytes = approved.request_bytes().to_vec();
        let lease = ledger
            .reserve(
                profile,
                ticket_id,
                &root_id,
                BTreeMap::from([(Resource::ProviderRequest, 1)]),
            )
            .map_err(ControlError::Admission)?;
        let root = ledger.roots.get_mut(&root_id).ok_or_else(refused)?;
        let outcome = root
            .charge_budget(
                fence.root_revision(),
                BudgetKind::ModelRequest,
                ticket_id.into(),
            )
            .map_err(ControlError::TaskState)?;
        if outcome == BudgetCharge::Exhausted {
            ledger.release(&lease).map_err(ControlError::Admission)?;
            for id in queued {
                let lease = ledger.active_lease(id).ok_or_else(refused)?;
                ledger.release(&lease).map_err(ControlError::Admission)?;
            }
            return Ok(None);
        }
        if outcome != BudgetCharge::Charged {
            return Err(refused());
        }
        let record = OperationRecord {
            id: ticket_id.into(),
            run_id: pending.run_id,
            root_id,
            operation_id: pending.operation_id,
            attempt: pending.attempt,
            fence,
            charged_root_revision: root.revision(),
            lease_id: lease.id(),
            request_digest: super::canonical::digest(&bytes),
            approval_fingerprint: fingerprint.into(),
            request_bytes: bytes.len() as u32,
            status: OperationStatus::DispatchCommitted,
            io_started: false,
            receipt: None,
        };
        ledger
            .provider_operations
            .insert(record.id.clone(), record.clone());
        Ok(Some(Dispatch {
            operation: record,
            permit,
            bytes,
        }))
    }
}

pub(super) fn unsettled(ledger: &CapacityLedger, root_id: &str) -> bool {
    ledger
        .provider_operations
        .values()
        .any(|record| record.root_id == root_id && record.status != OperationStatus::Returned)
}

pub(super) fn settle(
    ledger: &mut CapacityLedger,
    id: &str,
    receipt: ResultReceipt,
) -> Result<OperationRecord, ControlError> {
    if !super::valid_identity(&receipt.id)
        || receipt.response_bytes > 8_388_608
        || receipt
            .status_code
            .is_some_and(|code| !(100..=599).contains(&code))
    {
        return Err(refused());
    }
    if ledger.provider_operations.values().any(|record| {
        record.id != id
            && record
                .receipt
                .as_ref()
                .is_some_and(|stored| stored.id == receipt.id)
    }) {
        return Err(refused());
    }
    let record = ledger.provider_operations.get(id).ok_or_else(refused)?;
    if !valid_receipt(record, &receipt) {
        return Err(refused());
    }
    if record.status == OperationStatus::Returned {
        return if record.receipt.as_ref() == Some(&receipt) {
            Ok(record.clone())
        } else {
            Err(refused())
        };
    }
    let lease = ledger.active_lease(record.lease_id).ok_or_else(refused)?;
    ledger.release(&lease).map_err(ControlError::Admission)?;
    let record = ledger.provider_operations.get_mut(id).ok_or_else(refused)?;
    record.status = OperationStatus::Returned;
    record.receipt = Some(receipt);
    Ok(record.clone())
}

pub(super) fn recover(ledger: &mut CapacityLedger) -> bool {
    let mut changed = false;
    for record in ledger.provider_operations.values_mut() {
        if matches!(
            record.status,
            OperationStatus::DispatchCommitted | OperationStatus::IoStarted
        ) {
            record.status = OperationStatus::Interrupted;
            changed = true;
        }
    }
    changed
}

pub(super) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    consent::validate(ledger)?;
    if ledger.provider_operations.len() > MAX_OPERATIONS {
        return Err(StoreError::Corrupt);
    }
    let mut leases = BTreeSet::new();
    let mut receipts = BTreeSet::new();
    for (id, record) in &ledger.provider_operations {
        let run = ledger
            .root_runs
            .get(&record.run_id)
            .ok_or(StoreError::Corrupt)?;
        let root = ledger
            .roots
            .get(&record.root_id)
            .ok_or(StoreError::Corrupt)?;
        let policy = root.local_model().ok_or(StoreError::Corrupt)?;
        let lease = ledger
            .issued
            .get(&record.lease_id)
            .ok_or(StoreError::Corrupt)?;
        let hash = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if id != &identity(&record.run_id, &record.operation_id, record.attempt)
            || &record.id != id
            || !super::valid_identity(&record.operation_id)
            || record.attempt > 16
            || run.root_id != record.root_id
            || record.fence.root_id() != record.root_id
            || record.fence.root_revision() == 0
            || record.fence.cancellation_epoch() != run.cancellation_epoch
            || record.fence.contract_revision() == 0
            || record.fence.contract_revision() > root.contract_revision()
            || record.charged_root_revision
                != record
                    .fence
                    .root_revision()
                    .checked_add(1)
                    .ok_or(StoreError::Corrupt)?
            || record.charged_root_revision > root.revision()
            || !root.has_model_request(id)
            || !hash(&record.request_digest)
            || !hash(&record.approval_fingerprint)
            || record.request_bytes == 0
            || record.request_bytes > policy.max_request_bytes
            || lease.root_id() != record.root_id
            || lease.request_id != *id
            || lease.amounts() != &BTreeMap::from([(Resource::ProviderRequest, 1)])
            || !leases.insert(record.lease_id)
            || record.status == OperationStatus::DispatchCommitted && record.io_started
            || record.status == OperationStatus::IoStarted && !record.io_started
            || (record.status != OperationStatus::Returned)
                != ledger.active.contains_key(&record.lease_id)
            || (record.status == OperationStatus::Returned) != record.receipt.is_some()
            || record.receipt.as_ref().is_some_and(|receipt| {
                !valid_receipt(record, receipt)
                    || !super::valid_identity(&receipt.id)
                    || !receipts.insert(&receipt.id)
                    || receipt.response_bytes > 8_388_608
                    || receipt
                        .status_code
                        .is_some_and(|code| !(100..=599).contains(&code))
            })
        {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::delegation::{DelegationMode, DelegationPolicy};
    use super::super::state::{BudgetLimits, LocalModelPolicy, Requirement, RootCreate, StopCause};
    use super::super::{ControlActor, RootMutation};
    use super::*;
    use std::fs;

    pub(super) fn profile() -> CapacityProfile {
        CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 4), (Resource::ProviderRequest, 1)]),
            BTreeMap::from([(Resource::Generation, 1), (Resource::ProviderRequest, 1)]),
            128,
        )
        .unwrap()
    }
    pub(super) fn request(id: &str, limit: u32) -> RootCreate {
        RootCreate {
            id: id.into(),
            session_id: Some(format!("session-{id}")),
            local_model: Some(LocalModelPolicy {
                model: "qwen3.5:4b-mlx".into(),
                max_output_tokens: 256,
                max_request_bytes: 65536,
            }),
            goal: "Check original evidence".into(),
            criteria: "No replay or unsupported completion".into(),
            run_limit: 2,
            budget_limits: BudgetLimits::new(limit, 0).unwrap(),
            requirements: vec![Requirement::new("check".into(), true).unwrap()],
            delegation: DelegationPolicy::new(DelegationMode::Disabled, 0).unwrap(),
        }
    }
    pub(super) fn body() -> Vec<u8> {
        serde_json::to_vec(&json!({"model":"qwen3.5:4b-mlx","stream":true,"messages":[{"role":"user","content":"private-request-marker"}],"options":{"num_predict":256},"think":false,"keep_alive":"30m"})).unwrap()
    }
    pub(super) fn data() -> std::path::PathBuf {
        let parent = std::env::temp_dir().join(format!(
            "vak-provider-authority-{}-{}",
            std::process::id(),
            super::super::TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&parent).unwrap();
        parent.canonicalize().unwrap()
    }
    pub(super) fn start(handle: &super::super::ControlHandle, id: &str, limit: u32) -> String {
        let root = handle.create_root_with_budget(request(id, limit)).unwrap();
        handle
            .mutate_root(
                id.into(),
                root.revision(),
                RootMutation::StartAttempt {
                    request_id: format!("start-{id}"),
                },
            )
            .unwrap();
        let run = handle
            .read_root_run_for_start(format!("start-{id}"))
            .unwrap();
        handle
            .confirm_root_started(run.id.clone(), format!("supervisor-{id}"))
            .unwrap();
        run.id
    }
    pub(super) fn cleanup(data: &std::path::Path) {
        fs::remove_dir_all(super::super::native_store_root(data)).unwrap();
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn native_approval_binds_exact_bytes_charges_once_and_recovers_without_replay() {
        let data = data();
        let profile = profile();
        let actor = ControlActor::open(
            &data,
            "provider-test",
            profile.clone(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        let run = start(&handle, "root", 2);
        let ticket = handle
            .issue_provider_approval(run.clone(), "worker-operation".into(), 0, body())
            .unwrap();
        assert_eq!(
            handle
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            0
        );
        assert_eq!(
            ticket.disclosure.destination,
            "http://127.0.0.1:11434/api/chat"
        );
        assert!(ticket.disclosure.preview.contains("private-request-marker"));
        assert!(
            handle
                .issue_provider_approval(run.clone(), "worker-operation".into(), 0, body())
                .is_err()
        );
        let mut joins = Vec::new();
        for _ in 0..8 {
            let handle = handle.clone();
            let ticket = ticket.clone();
            joins.push(std::thread::spawn(move || {
                handle.decide_provider_approval(
                    ticket.ticket_id,
                    ticket.fingerprint,
                    Decision::AllowOnce,
                )
            }));
        }
        let mut dispatches = joins
            .into_iter()
            .filter_map(|join| join.join().unwrap().ok())
            .collect::<Vec<_>>();
        assert_eq!(dispatches.len(), 1);
        let dispatch = dispatches.pop().unwrap();
        assert!(!format!("{dispatch:?}").contains("private-request-marker"));
        let dispatch = handle.begin_provider_dispatch(dispatch).unwrap();
        let (record, permit, bytes) = dispatch.into_request();
        assert_eq!(bytes, prepare_generation_body(&permit, &body()).unwrap());
        assert_eq!(
            record.request_digest,
            super::super::canonical::digest(&bytes)
        );
        assert_eq!(
            handle.read_provider_operation(record.id.clone()).unwrap(),
            record
        );
        assert_eq!(
            handle
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            1
        );
        let lease = handle
            .reserve(
                record.id.clone(),
                "root".into(),
                BTreeMap::from([(Resource::ProviderRequest, 1)]),
            )
            .unwrap();
        assert_eq!(
            handle.release(lease),
            Err(ControlError::Admission(AdmissionError::ReservedForControl(
                Resource::ProviderRequest
            )))
        );
        let root = handle.read_root("root".into()).unwrap();
        let root = handle
            .mutate_root(
                "root".into(),
                root.revision(),
                RootMutation::RecordCheck {
                    contract_revision: root.contract_revision(),
                    requirement_id: "check".into(),
                    outcome: super::super::state::CheckOutcome::Pass,
                    receipt: Some("test-checker-receipt".into()),
                },
            )
            .unwrap();
        handle
            .settle_root_exit(run.clone(), "worker-exit".into())
            .unwrap();
        assert_eq!(
            handle.mutate_root("root".into(), root.revision(), RootMutation::RequestReview),
            Err(ControlError::Admission(AdmissionError::RootRunUnsettled))
        );
        handle
            .mutate_root(
                "root".into(),
                root.revision(),
                RootMutation::Stop {
                    status: RootStatus::Cancelled,
                    cause: StopCause::UserCancelled,
                    reason: "Cancelled after dispatch commitment".into(),
                },
            )
            .unwrap();
        drop(handle);
        drop(actor);
        // Durable control metadata must not include request contents or preview.
        for entry in fs::read_dir(super::super::native_store_root(&data).join("control")).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_file() {
                assert!(
                    !String::from_utf8_lossy(&fs::read(entry.path()).unwrap())
                        .contains("private-request-marker")
                );
            }
        }
        let actor = ControlActor::open(&data, "provider-test", profile, 16, Duration::from_secs(2))
            .unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle
                .read_provider_operation(record.id.clone())
                .unwrap()
                .status,
            OperationStatus::Interrupted
        );
        assert!(
            handle
                .issue_provider_approval(run, "worker-operation".into(), 0, body())
                .is_err()
        );
        let second = start(&handle, "other", 2);
        let ticket = handle
            .issue_provider_approval(second.clone(), "another".into(), 0, body())
            .unwrap();
        assert!(matches!(
            handle.decide_provider_approval(
                ticket.ticket_id,
                ticket.fingerprint,
                Decision::AllowOnce
            ),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::ProviderRequest)
            ))
        ));
        assert_eq!(
            handle
                .read_root("other".into())
                .unwrap()
                .model_requests_used(),
            0
        );
        let receipt = ResultReceipt {
            outcome: IoOutcome::Completed,
            id: "native-io-finished".into(),
            status_code: Some(503),
            response_bytes: 12,
        };
        let returned = handle
            .settle_provider_operation(record.id.clone(), receipt.clone())
            .unwrap();
        assert_eq!(returned.status, OperationStatus::Returned);
        assert_eq!(
            handle
                .settle_provider_operation(record.id.clone(), receipt)
                .unwrap(),
            returned
        );
        assert!(
            handle
                .settle_provider_operation(
                    record.id,
                    ResultReceipt {
                        outcome: IoOutcome::NotDispatched,
                        id: "changed".into(),
                        status_code: None,
                        response_bytes: 0
                    }
                )
                .is_err()
        );
        let ticket = handle
            .issue_provider_approval(second, "another".into(), 0, body())
            .unwrap();
        assert!(
            handle
                .decide_provider_approval(ticket.ticket_id, ticket.fingerprint, Decision::AllowOnce)
                .is_ok()
        );
        assert_eq!(
            handle.read_root("root".into()).unwrap().status(),
            RootStatus::Cancelled
        );
        drop(handle);
        drop(actor);
        cleanup(&data);
    }

    #[test]
    fn denied_mismatched_stale_and_unconfigured_approvals_cannot_charge_or_dispatch() {
        let data = data();
        let actor = ControlActor::open(
            &data,
            "provider-test",
            profile(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        let run = start(&handle, "root", 1);
        for decision in [Decision::Deny, Decision::AllowOnce] {
            let ticket = handle
                .issue_provider_approval(run.clone(), format!("op-{decision:?}"), 0, body())
                .unwrap();
            let fingerprint = if decision == Decision::AllowOnce {
                "0".repeat(64)
            } else {
                ticket.fingerprint.clone()
            };
            assert!(
                handle
                    .decide_provider_approval(ticket.ticket_id.clone(), fingerprint, decision)
                    .is_err()
            );
            assert!(
                handle
                    .decide_provider_approval(
                        ticket.ticket_id,
                        ticket.fingerprint,
                        Decision::AllowOnce
                    )
                    .is_err()
            );
        }
        let mut changed: serde_json::Value = serde_json::from_slice(&body()).unwrap();
        for (key, value) in [
            ("model", json!("other")),
            ("url", json!("https://attacker.invalid")),
            ("options", json!({"num_predict":257})),
            (
                "tools",
                json!([{"type":"function","function":{"name":"external_write","parameters":{}}}]),
            ),
        ] {
            let old = changed[key].clone();
            changed[key] = value;
            assert!(
                handle
                    .issue_provider_approval(
                        run.clone(),
                        "invalid-body".into(),
                        0,
                        serde_json::to_vec(&changed).unwrap()
                    )
                    .is_err()
            );
            if old.is_null() {
                changed.as_object_mut().unwrap().remove(key);
            } else {
                changed[key] = old;
            }
        }
        let ticket = handle
            .issue_provider_approval(run.clone(), "stale".into(), 0, body())
            .unwrap();
        let root = handle.read_root("root".into()).unwrap();
        handle
            .mutate_root(
                "root".into(),
                root.revision(),
                RootMutation::Stop {
                    status: RootStatus::Cancelled,
                    cause: StopCause::UserCancelled,
                    reason: "Cancelled before approval".into(),
                },
            )
            .unwrap();
        assert!(
            handle
                .decide_provider_approval(ticket.ticket_id, ticket.fingerprint, Decision::AllowOnce)
                .is_err()
        );
        assert_eq!(
            handle
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            0
        );
        let mut no_policy = request("no-policy", 1);
        no_policy.local_model = None;
        let root = handle.create_root_with_budget(no_policy).unwrap();
        handle
            .mutate_root(
                root.id().into(),
                1,
                RootMutation::StartAttempt {
                    request_id: "no-policy-start".into(),
                },
            )
            .unwrap();
        let run = handle
            .read_root_run_for_start("no-policy-start".into())
            .unwrap();
        handle
            .confirm_root_started(run.id.clone(), "no-policy-supervisor".into())
            .unwrap();
        assert!(
            handle
                .issue_provider_approval(run.id, "missing-policy".into(), 0, body())
                .is_err()
        );
        drop(handle);
        drop(actor);
        cleanup(&data);
    }

    #[test]
    fn exhausted_model_budget_is_durably_stopped_and_pending_approvals_do_not_survive_restart() {
        let data = data();
        let actor = ControlActor::open(
            &data,
            "provider-test",
            profile(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        let run = start(&handle, "root", 1);
        let ticket = handle
            .issue_provider_approval(run.clone(), "first".into(), 0, body())
            .unwrap();
        let dispatch = handle
            .decide_provider_approval(ticket.ticket_id, ticket.fingerprint, Decision::AllowOnce)
            .unwrap();
        let id = dispatch.operation().id.clone();
        handle.begin_provider_dispatch(dispatch).unwrap();
        handle
            .settle_provider_operation(
                id,
                ResultReceipt {
                    outcome: IoOutcome::Completed,
                    id: "done-first".into(),
                    status_code: Some(200),
                    response_bytes: 30,
                },
            )
            .unwrap();
        let ticket = handle
            .issue_provider_approval(run, "over-budget".into(), 0, body())
            .unwrap();
        assert!(matches!(
            handle.decide_provider_approval(
                ticket.ticket_id,
                ticket.fingerprint,
                Decision::AllowOnce
            ),
            Err(ControlError::Admission(
                AdmissionError::ProviderBudgetExhausted
            ))
        ));
        let root = handle.read_root("root".into()).unwrap();
        assert_eq!(root.status(), RootStatus::LimitReached);
        assert_eq!(root.model_requests_used(), 1);
        let second = start(&handle, "other", 1);
        let pending = handle
            .issue_provider_approval(second, "pending".into(), 0, body())
            .unwrap();
        drop(handle);
        drop(actor);
        let actor = ControlActor::open(
            &data,
            "provider-test",
            profile(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle.read_root("root".into()).unwrap().status(),
            RootStatus::LimitReached
        );
        assert!(
            handle
                .decide_provider_approval(
                    pending.ticket_id,
                    pending.fingerprint,
                    Decision::AllowOnce
                )
                .is_err()
        );
        assert_eq!(
            handle
                .read_root("other".into())
                .unwrap()
                .model_requests_used(),
            0
        );
        drop(handle);
        drop(actor);
        cleanup(&data);
    }

    #[test]
    fn operation_recovery_refuses_fake_lease_budget_receipt_and_digest_associations() {
        let mut ledger = CapacityLedger::default();
        let profile = profile();
        let root =
            super::super::state::RootTask::create_with_grant(request("root", 1), None).unwrap();
        ledger.roots.insert("root".into(), root);
        super::super::root_runs::prepare(&mut ledger, &profile, "root", 1, "start").unwrap();
        let run = ledger.root_runs.values().next().unwrap().id.clone();
        super::super::root_runs::confirm(&mut ledger, &run, "supervisor").unwrap();
        let mut approvals = Approvals::default();
        let ticket = approvals
            .issue(&ledger, run, "op".into(), 0, body())
            .unwrap();
        let dispatch = approvals
            .decide(
                &mut ledger,
                &profile,
                &ticket.ticket_id,
                &ticket.fingerprint,
                Decision::AllowOnce,
            )
            .unwrap()
            .unwrap();
        assert_eq!(validate(&ledger), Ok(()));
        let id = dispatch.operation().id.clone();
        let mut bad = ledger.clone();
        bad.provider_operations.get_mut(&id).unwrap().lease_id = 999;
        assert_eq!(validate(&bad), Err(StoreError::Corrupt));
        let mut bad = ledger.clone();
        bad.provider_operations.get_mut(&id).unwrap().request_digest = "forged".into();
        assert_eq!(validate(&bad), Err(StoreError::Corrupt));
        let mut bad = ledger.clone();
        bad.provider_operations
            .get_mut(&id)
            .unwrap()
            .charged_root_revision += 1;
        assert_eq!(validate(&bad), Err(StoreError::Corrupt));
        let mut bad = ledger.clone();
        bad.provider_operations.get_mut(&id).unwrap().status = OperationStatus::Returned;
        assert_eq!(validate(&bad), Err(StoreError::Corrupt));
        let ticket = approvals
            .issue(
                &ledger,
                ledger.root_runs.values().next().unwrap().id.clone(),
                "expiring".into(),
                0,
                body(),
            )
            .unwrap();
        approvals
            .pending
            .get_mut(&ticket.ticket_id)
            .unwrap()
            .created = Instant::now() - APPROVAL_TTL;
        assert!(
            approvals
                .decide(
                    &mut ledger,
                    &profile,
                    &ticket.ticket_id,
                    &ticket.fingerprint,
                    Decision::AllowOnce
                )
                .is_err()
        );
    }

    #[test]
    fn failed_durable_selection_returns_no_dispatch_and_keeps_the_last_committed_budget() {
        let data = data();
        let actor = ControlActor::open(
            &data,
            "provider-test",
            profile(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        let run = start(&handle, "root", 1);
        let ticket = handle
            .issue_provider_approval(run, "op".into(), 0, body())
            .unwrap();
        let control = super::super::native_store_root(&data).join("control");
        fs::rename(control.join("current"), control.join("saved-current")).unwrap();
        fs::create_dir(control.join("current")).unwrap();
        assert!(matches!(
            handle.decide_provider_approval(
                ticket.ticket_id,
                ticket.fingerprint,
                Decision::AllowOnce
            ),
            Err(ControlError::Store(_))
        ));
        drop(handle);
        drop(actor);
        fs::remove_dir(control.join("current")).unwrap();
        fs::rename(control.join("saved-current"), control.join("current")).unwrap();
        let actor = ControlActor::open(
            &data,
            "provider-test",
            profile(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            0
        );
        assert_eq!(
            handle.read_root("root".into()).unwrap().status(),
            RootStatus::Interrupted
        );
        drop(handle);
        drop(actor);
        cleanup(&data);
    }

    #[test]
    fn pending_capacity_is_global_bounded_and_revalidation_clears_old_tickets() {
        let mut ledger = CapacityLedger::default();
        let profile = profile();
        let root =
            super::super::state::RootTask::create_with_grant(request("root", 8), None).unwrap();
        ledger.roots.insert("root".into(), root);
        super::super::root_runs::prepare(&mut ledger, &profile, "root", 1, "start").unwrap();
        let run = ledger.root_runs.values().next().unwrap().id.clone();
        assert!(
            Approvals::default()
                .issue(&ledger, run.clone(), "before-confirm".into(), 0, body())
                .is_err()
        );
        super::super::root_runs::confirm(&mut ledger, &run, "supervisor").unwrap();
        let mut approvals = Approvals::default();
        for i in 0..4 {
            approvals
                .issue(&ledger, run.clone(), format!("op-{i}"), 0, body())
                .unwrap();
        }
        assert!(
            approvals
                .issue(&ledger, run, "fifth".into(), 0, body())
                .is_err()
        );
        let root = ledger.roots.get_mut("root").unwrap();
        root.stop(
            root.revision(),
            RootStatus::Cancelled,
            StopCause::UserCancelled,
            "Cancelled".into(),
        )
        .unwrap();
        approvals.prune(&ledger);
        assert_eq!(approvals.pending.len(), 0);
        assert_eq!(approvals.tickets.len(), 0);
    }
}

#[cfg(test)]
mod consent_tests;
