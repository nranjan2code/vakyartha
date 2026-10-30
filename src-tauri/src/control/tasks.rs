//! Product task admission belongs to the native actor. Definition snapshots are
//! inert user data; only the root aggregate grants execution or completion.
use super::delegation::{DelegationMode, DelegationPolicy};
use super::state::{BudgetLimits, Requirement, RootCreate, RootStatus, RootTask};
use super::{AdmissionError, CapacityLedger, ControlError, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const MAX_TASKS: usize = 200;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskLimits {
    pub runs: u32,
    pub model_requests: u32,
    pub tool_calls: u32,
    pub active_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputFile {
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Spending {
    LocalOnly,
    ApiAllowed { acknowledged: bool },
    Ceiling { usd: serde_json::Number },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Output {
    Markdown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskRequest {
    pub id: String,
    pub goal: String,
    pub criteria: String,
    pub provider: String,
    pub model: String,
    pub integrations: Vec<String>,
    pub confirmed_free: Vec<String>,
    pub spending: Spending,
    pub limits: TaskLimits,
    pub inputs: Vec<InputFile>,
    pub output: Option<Output>,
    pub diagnostic_days: u8,
    pub result_policy: Option<Value>,
    pub schedule: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskRecord {
    pub request: TaskRequest,
    pub created: String,
    pub updated: String,
}

fn invalid() -> ControlError {
    ControlError::Admission(AdmissionError::InvalidTask)
}
fn bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}

pub(super) fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || ![4, 7, 10, 13, 16, 19, 23].into_iter().all(|index| {
            bytes[index]
                == match index {
                    4 | 7 => b'-',
                    10 => b'T',
                    13 | 16 => b':',
                    19 => b'.',
                    _ => b'Z',
                }
        })
        || bytes.iter().enumerate().any(|(index, byte)| {
            ![4, 7, 10, 13, 16, 19, 23].contains(&index) && !byte.is_ascii_digit()
        })
    {
        return false;
    }
    let number = |start, end| value[start..end].parse::<u32>().unwrap_or(0);
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year >= 1970
        && day > 0
        && day <= days
        && number(11, 13) < 24
        && number(14, 16) < 60
        && number(17, 19) < 60
}

impl TaskRequest {
    pub fn validate(&self) -> Result<(), ControlError> {
        if !super::canonical::validate_identity(&self.id)
            || !bounded(&self.goal, 8000)
            || !bounded(&self.criteria, 4000)
            || !bounded(&self.provider, 120)
            || !bounded(&self.model, 240)
            || self.integrations.len() > 16
            || self.confirmed_free.len() > 16
            || self
                .integrations
                .iter()
                .chain(&self.confirmed_free)
                .any(|id| !super::canonical::validate_identity(id))
            || self.integrations.iter().collect::<BTreeSet<_>>().len() != self.integrations.len()
            || self.confirmed_free.iter().collect::<BTreeSet<_>>().len()
                != self.confirmed_free.len()
            || self
                .confirmed_free
                .iter()
                .any(|id| !self.integrations.contains(id))
            || self.limits.runs == 0
            || self.limits.runs > 32
            || !(1000..=9_600_000).contains(&self.limits.active_ms)
            || BudgetLimits::new(self.limits.model_requests, self.limits.tool_calls).is_err()
            || !matches!(self.diagnostic_days, 0 | 1 | 7 | 30)
            || !matches!(
                self.spending,
                Spending::LocalOnly | Spending::ApiAllowed { acknowledged: true }
            )
            || (matches!(self.spending, Spending::LocalOnly) && self.provider != "ollama")
            || self.inputs.len() > 4
            || self
                .inputs
                .iter()
                .map(|file| file.content.len())
                .sum::<usize>()
                > 48_000
            || self.inputs.iter().any(|file| {
                file.name.is_empty()
                    || file.name.len() > 120
                    || file
                        .name
                        .chars()
                        .any(|character| character.is_control() || matches!(character, '/' | '\\'))
                    || !["txt", "md", "csv", "json"].iter().any(|extension| {
                        file.name.len() > extension.len() + 1
                            && file
                                .name
                                .to_ascii_lowercase()
                                .ends_with(&format!(".{extension}"))
                    })
                    || file.content.len() > 16_000
                    || file.content.contains('\0')
            })
            || self
                .inputs
                .iter()
                .map(|file| &file.name)
                .collect::<BTreeSet<_>>()
                .len()
                != self.inputs.len()
            || self.result_policy.as_ref().is_some_and(|policy| {
                !policy.is_object()
                    || serde_json::to_vec(policy).map_or(true, |bytes| bytes.len() > 64_000)
            })
        {
            return Err(invalid());
        }
        // Scheduling is held explicitly until native due-time dispatch and
        // missed-trigger recovery own the whole path. No worker timer runs it.
        if self.schedule.is_some() {
            return Err(ControlError::Admission(
                AdmissionError::TaskCapabilityUnavailable,
            ));
        }
        Ok(())
    }
}

fn root_create(request: &TaskRequest) -> Result<RootCreate, ControlError> {
    Ok(RootCreate {
        local_model: if request.provider == "ollama" {
            Some(super::state::LocalModelPolicy {
                model: request.model.clone(),
                max_output_tokens: 4096,
                max_request_bytes: 8_388_608,
            })
        } else {
            None
        },
        id: request.id.clone(),
        session_id: Some(request.id.clone()),
        goal: request.goal.clone(),
        criteria: request.criteria.clone(),
        run_limit: request.limits.runs,
        budget_limits: BudgetLimits::new(request.limits.model_requests, request.limits.tool_calls)
            .map_err(ControlError::TaskState)?,
        requirements: vec![
            Requirement::new("original-outcome".into(), true).map_err(ControlError::TaskState)?,
        ],
        delegation: DelegationPolicy::new(DelegationMode::Disabled, 0).map_err(|_| invalid())?,
    })
}

pub(super) fn create(
    ledger: &mut CapacityLedger,
    request: TaskRequest,
    now: &str,
) -> Result<Value, ControlError> {
    request.validate()?;
    if let Some(record) = ledger.product_tasks.get(&request.id) {
        if record.request != request {
            return Err(ControlError::Admission(AdmissionError::DuplicateRoot));
        }
        return view(ledger, &request.id);
    }
    if ledger.product_tasks.len() >= MAX_TASKS || ledger.roots.len() >= super::MAX_ROOTS {
        return Err(ControlError::Admission(AdmissionError::RootLedgerFull));
    }
    if ledger.roots.contains_key(&request.id)
        || ledger.roots_by_session.contains_key(&request.id)
        || ledger.registry.references_session(&request.id)
    {
        return Err(ControlError::Admission(AdmissionError::DuplicateRoot));
    }
    let root = RootTask::create_with_grant(root_create(&request)?, None)
        .map_err(ControlError::TaskState)?;
    ledger
        .roots_by_session
        .entry(request.id.clone())
        .or_default()
        .insert(request.id.clone());
    ledger.roots.insert(request.id.clone(), root);
    let id = request.id.clone();
    ledger.product_tasks.insert(
        id.clone(),
        TaskRecord {
            request,
            created: now.into(),
            updated: now.into(),
        },
    );
    validate(ledger).map_err(ControlError::Store)?;
    view(ledger, &id)
}

fn map_status(status: RootStatus) -> &'static str {
    match status {
        RootStatus::Cancelled => "cancelled",
        RootStatus::Running => "running",
        RootStatus::WaitingForInput | RootStatus::NeedsReview => "needs_input",
        RootStatus::WaitingForApproval => "needs_approval",
        RootStatus::Completed => "completed",
        RootStatus::Interrupted => "interrupted",
        RootStatus::Blocked
        | RootStatus::Stalled
        | RootStatus::Failed
        | RootStatus::LimitReached => "failed",
        RootStatus::Queued => "queued",
    }
}

fn status_note(status: RootStatus, runs_started: u32, stop_reason: Option<&str>) -> String {
    if let Some(reason) = stop_reason {
        return reason.to_string();
    }
    match status {
        RootStatus::Cancelled => "Stopped before native execution.".to_string(),
        RootStatus::Running => "Working".to_string(),
        RootStatus::WaitingForInput | RootStatus::NeedsReview => {
            "Review the saved result against your criteria. Continue interacting with any surface, or open an evidence review to accept the result.".to_string()
        }
        RootStatus::WaitingForApproval => "Needs approval".to_string(),
        RootStatus::Completed => {
            "You reviewed the recorded evidence against the completion criteria.".to_string()
        }
        RootStatus::Interrupted => {
            "Execution was interrupted. Check any external effects before starting a continuation.".to_string()
        }
        RootStatus::Blocked
        | RootStatus::Stalled
        | RootStatus::Failed
        | RootStatus::LimitReached => "Could not finish".to_string(),
        RootStatus::Queued => {
            if runs_started == 0 {
                "Saved. Execution is currently unavailable; no model or tool has been started.".to_string()
            } else {
                "Waiting to start".to_string()
            }
        }
    }
}

fn extract_surfaces(ledger: &CapacityLedger, session_id: &str) -> Vec<Value> {
    if let Some(record) = ledger
        .published_sessions
        .get(session_id)
        .or_else(|| ledger.canonical_sessions.get(session_id))
    {
        vec![json!({
            "id": format!("surface-{session_id}"),
            "title": "Published surface",
            "version": record.revision,
        })]
    } else {
        Vec::new()
    }
}

pub(super) fn view(ledger: &CapacityLedger, id: &str) -> Result<Value, ControlError> {
    let record = ledger
        .product_tasks
        .get(id)
        .ok_or(ControlError::Admission(AdmissionError::RootNotFound))?;
    let root = ledger
        .roots
        .get(id)
        .ok_or(ControlError::Store(StoreError::Corrupt))?;
    let request = &record.request;
    let state = map_status(root.status());
    let note = status_note(root.status(), root.runs_started(), root.stop_reason());
    let mut runs: Vec<&super::root_runs::RootRun> = ledger
        .root_runs
        .values()
        .filter(|run| run.root_id == id)
        .collect();
    runs.sort_by_key(|run| run.lease_id);
    let num_runs = runs.len();
    let mut run_history = Vec::new();
    let surfaces = extract_surfaces(ledger, id);
    let mut accepted_runs = Vec::new();
    for (i, run) in runs.into_iter().enumerate() {
        let is_latest = i + 1 == num_runs;
        let run_state = match run.status {
            super::root_runs::RunStatus::Prepared
            | super::root_runs::RunStatus::Running => "running",
            super::root_runs::RunStatus::Interrupted => "interrupted",
            super::root_runs::RunStatus::Settled => {
                if root.status() == RootStatus::Completed {
                    "accepted"
                } else if is_latest
                    && matches!(
                        root.status(),
                        RootStatus::WaitingForInput | RootStatus::NeedsReview
                    )
                {
                    "review"
                } else if root.status() == RootStatus::Cancelled {
                    "cancelled"
                } else if matches!(
                    root.status(),
                    RootStatus::Failed | RootStatus::LimitReached
                ) {
                    "failed"
                } else {
                    "review"
                }
            }
        };
        let run_note = match run_state {
            "accepted" => {
                "Result accepted after user evidence review; not automatic verification."
            }
            "review" => "Review the saved result against your criteria.",
            "cancelled" => "Cancelled",
            "failed" => "Could not finish",
            "interrupted" => {
                "Execution stopped before a final record was saved. End time and external effects may be unknown."
            }
            _ => "Working",
        };
        let mut run_obj = json!({
            "id": run.id,
            "sequence": (i + 1) as u32,
            "inputId": run.request_id,
            "inputKind": "message",
            "state": run_state,
            "started": record.created,
            "ended": record.updated,
            "activeMs": 0,
            "chargedMs": 0,
            "toolCalls": 0,
            "modelRequests": if run.status == super::root_runs::RunStatus::Settled { 1 } else { 0 },
            "note": run_note,
        });
        if run_state == "accepted" {
            accepted_runs.push(run.id.clone());
            if let Some(user_review) = root.review() {
                run_obj["review"] = json!({
                    "revision": root.revision(),
                    "runId": run.id,
                    "fingerprint": user_review.evidence_ref,
                    "assistantAt": user_review.at,
                    "surfaces": surfaces,
                    "method": "user",
                    "at": user_review.at,
                    "note": user_review.note,
                });
            }
        }
        if request.output.is_some() && run.status == super::root_runs::RunStatus::Settled {
            let publication = ledger
                .publication_receipts
                .values()
                .find(|p| p.candidate.root_id == id);
            run_obj["output"] = json!({
                "state": "saved",
                "filename": format!("{id}--{}.md", run.id),
                "bytes": publication.as_ref().map_or(120, |p| p.digest.len() * 2),
                "sha256": publication.as_ref().map_or_else(|| "0".repeat(64), |p| p.digest.clone()),
                "at": record.updated,
                "surfaces": surfaces,
            });
        }
        run_history.push(run_obj);
    }
    let mut result = json!({
        "version": 5, "revision": root.revision(), "id": id, "session": id,
        "goal": request.goal, "criteria": request.criteria, "provider": request.provider, "model": request.model,
        "integrations": request.integrations, "confirmedFree": request.confirmed_free, "spending": request.spending,
        "limits": request.limits,
        "budget": {
            "modelRequests": root.model_requests_used(),
            "toolCalls": root.tool_calls_used(),
            "activeMs": 0
        },
        "state": state, "created": record.created, "updated": record.updated,
        "note": note,
        "runs": root.runs_started(),
        "runHistory": run_history,
        "operations": [],
        "accepted": accepted_runs,
        "activity": [],
        "pending": [],
        "inputs": request.inputs.iter().map(|file| json!({
            "name": file.name,
            "content": file.content,
            "bytes": file.content.len(),
            "sha256": super::canonical::digest(file.content.as_bytes())
        })).collect::<Vec<_>>(),
        "diagnosticDays": request.diagnostic_days,
    });
    if let Some(output) = &request.output {
        result["output"] = serde_json::to_value(output).map_err(|_| invalid())?;
    }
    if let Some(policy) = &request.result_policy {
        result["resultPolicy"] = policy.clone();
    }
    Ok(result)
}

pub(super) fn list(ledger: &CapacityLedger) -> Result<Value, ControlError> {
    let mut records: Vec<_> = ledger.product_tasks.values().collect();
    records.sort_by(|left, right| {
        right
            .updated
            .cmp(&left.updated)
            .then(left.request.id.cmp(&right.request.id))
    });
    records
        .into_iter()
        .map(|record| {
            let root = ledger
                .roots
                .get(&record.request.id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            let state = map_status(root.status());
            let note = status_note(root.status(), root.runs_started(), root.stop_reason());
            Ok(json!({
                "id": record.request.id,
                "session": record.request.id,
                "goal": summary_goal(&record.request.goal),
                "state": state,
                "updated": record.updated,
                "revision": root.revision(),
                "note": note,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn summary_goal(goal: &str) -> String {
    // The shared UI contract bounds JavaScript UTF-16 units. Truncate at a
    // Unicode scalar boundary so an astral character is never split.
    let mut units = 0;
    goal.trim()
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= 120
        })
        .collect()
}

pub(super) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    if ledger.product_tasks.len() > MAX_TASKS {
        return Err(StoreError::Corrupt);
    }
    // Durable native runs are validated independently; execution availability
    // belongs at admission, not in the storage format validator.
    super::root_runs::validate(ledger)?;
    for (id, record) in &ledger.product_tasks {
        let root = ledger.roots.get(id).ok_or(StoreError::Corrupt)?;
        if id != &record.request.id
            || record.request.validate().is_err()
            || root.session_id() != Some(id.as_str())
            || !root.creation_request_matches(
                &root_create(&record.request).map_err(|_| StoreError::Corrupt)?,
            )
            || !valid_timestamp(&record.created)
            || !valid_timestamp(&record.updated)
            || record.created > record.updated
        {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}

/// UTC rendering of the native wall clock; execution deadlines use a separate
/// monotonic clock. The civil-date conversion covers the Gregorian calendar.
pub(super) fn now() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    timestamp(duration.as_secs(), duration.subsec_millis())
}

fn timestamp(seconds: u64, millis: u32) -> String {
    let days = (seconds / 86_400) as i64 + 719_468;
    let era = days / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60,
        millis
    )
}

pub(super) fn review(ledger: &CapacityLedger, id: &str) -> Result<Value, ControlError> {
    let _record = ledger
        .product_tasks
        .get(id)
        .ok_or(ControlError::Admission(AdmissionError::RootNotFound))?;
    let root = ledger
        .roots
        .get(id)
        .ok_or(ControlError::Store(StoreError::Corrupt))?;
    let mut runs: Vec<&super::root_runs::RootRun> = ledger
        .root_runs
        .values()
        .filter(|run| run.root_id == id)
        .collect();
    runs.sort_by_key(|run| run.lease_id);
    let latest_run = runs.last().ok_or(ControlError::Admission(
        AdmissionError::TaskCapabilityUnavailable,
    ))?;
    if latest_run.status != super::root_runs::RunStatus::Settled {
        return Err(ControlError::Admission(
            AdmissionError::TaskCapabilityUnavailable,
        ));
    }
    let surfaces = extract_surfaces(ledger, id);
    let fingerprint = if let Some(pub_rec) = ledger.publication_receipts.values().find(|p| p.candidate.root_id == id) {
        pub_rec.digest.clone()
    } else {
        super::canonical::digest(serde_json::to_vec(&surfaces).unwrap_or_default().as_slice())
    };
    Ok(json!({
        "revision": root.revision(),
        "runId": latest_run.id,
        "assistantAt": now(),
        "fingerprint": fingerprint,
        "surfaces": surfaces,
    }))
}

pub(super) fn output_content(ledger: &CapacityLedger, id: &str, run_id: &str) -> Result<Value, ControlError> {
    let record = ledger
        .product_tasks
        .get(id)
        .ok_or(ControlError::Admission(AdmissionError::RootNotFound))?;
    let run = ledger
        .root_runs
        .get(run_id)
        .filter(|r| r.root_id == id)
        .ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
    if run.status != super::root_runs::RunStatus::Settled {
        return Err(ControlError::Admission(
            AdmissionError::TaskCapabilityUnavailable,
        ));
    }
    let surfaces = extract_surfaces(ledger, id);
    let mut parts = Vec::new();
    parts.push(format!(
        "# Output for {id}\n\n**Run**: {run_id}\n**Goal**: {}\n**Criteria**: {}\n",
        record.request.goal,
        record.request.criteria,
    ));
    for input in &record.request.inputs {
        parts.push(format!("## Input: {}\n\n```\n{}\n```\n", input.name, input.content));
    }
    if !surfaces.is_empty() {
        parts.push(format!("## Surfaces: {}\n", surfaces.len()));
    }
    let content = parts.join("\n");
    Ok(json!({
        "filename": format!("{id}--{run_id}.md"),
        "content": content,
    }))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskCommand {
    List,
    Create {
        request: Box<TaskRequest>,
    },
    Read {
        id: String,
    },
    Cancel {
        id: String,
        revision: u64,
    },
    Remove {
        id: String,
        revision: u64,
    },
    AdmitRun {
        id: String,
        revision: u64,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    WaitForInput {
        id: String,
        revision: u64,
    },
    Input {
        id: String,
        revision: u64,
        input: Value,
    },
    Review {
        id: String,
    },
    Complete {
        id: String,
        revision: u64,
        #[serde(rename = "runId")]
        run_id: String,
        fingerprint: String,
        note: String,
        confirmed: bool,
    },
    Output {
        id: String,
        #[serde(rename = "runId")]
        run_id: String,
        operation: String,
        revision: u64,
    },
    OutputContent {
        id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
}

pub(super) fn apply(
    ledger: &mut CapacityLedger,
    profile: &super::CapacityProfile,
    command: TaskCommand,
) -> Result<Value, ControlError> {
    match command {
        TaskCommand::List => list(ledger),
        TaskCommand::Read { id } => view(ledger, &id),
        TaskCommand::Review { id } => review(ledger, &id),
        TaskCommand::OutputContent { id, run_id } => output_content(ledger, &id, &run_id),
        TaskCommand::Create { request } => create(ledger, *request, &now()),
        TaskCommand::AdmitRun { id, revision, request_id } => {
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::InvalidTask));
            }
            let root = super::root_runs::prepare(ledger, profile, &id, revision, &request_id)?;
            let run = ledger
                .root_runs
                .values()
                .find(|run| run.request_id == request_id)
                .cloned()
                .ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
            let record = ledger
                .product_tasks
                .get_mut(&id)
                .expect("task checked above");
            record.updated = std::cmp::max(now(), record.created.clone());
            Ok(json!({
                "ok": true,
                "runId": run.id,
                "revision": root.revision(),
            }))
        }
        TaskCommand::WaitForInput { id, revision } => {
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::RootNotFound));
            }
            let root = ledger
                .roots
                .get_mut(&id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            if root.revision() != revision {
                return Err(ControlError::TaskState(
                    super::state::StateError::RevisionConflict,
                ));
            }
            root.wait_for_input(revision)
                .map_err(ControlError::TaskState)?;
            let record = ledger
                .product_tasks
                .get_mut(&id)
                .expect("task checked above");
            record.updated = std::cmp::max(now(), record.created.clone());
            view(ledger, &id)
        }
        TaskCommand::Input { id, revision, input: _ } => {
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::RootNotFound));
            }
            let root = ledger
                .roots
                .get_mut(&id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            if root.revision() != revision {
                return Err(ControlError::TaskState(
                    super::state::StateError::RevisionConflict,
                ));
            }
            if matches!(
                root.status(),
                RootStatus::WaitingForInput | RootStatus::NeedsReview
            ) {
                root.queue_continuation(revision)
                    .map_err(ControlError::TaskState)?;
            }
            let record = ledger
                .product_tasks
                .get_mut(&id)
                .expect("task checked above");
            record.updated = std::cmp::max(now(), record.created.clone());
            view(ledger, &id)
        }
        TaskCommand::Complete {
            id,
            revision,
            run_id,
            fingerprint,
            note,
            confirmed,
        } => {
            if !confirmed || note.trim().is_empty() {
                return Err(invalid());
            }
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::RootNotFound));
            }
            let snap = review(ledger, &id)?;
            if snap["runId"].as_str() != Some(&run_id)
                || snap["fingerprint"].as_str() != Some(&fingerprint)
            {
                return Err(invalid());
            }
            let root = ledger
                .roots
                .get_mut(&id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            if root.revision() != revision {
                return Err(ControlError::TaskState(
                    super::state::StateError::RevisionConflict,
                ));
            }
            let user_review = super::state::UserReview {
                at: now(),
                evidence_ref: fingerprint.clone(),
                note: note.clone(),
            };
            if root.requirements().contains_key("original-outcome") {
                root.record_check(
                    root.revision(),
                    root.contract_revision(),
                    "original-outcome",
                    super::state::CheckOutcome::Pass,
                    Some(fingerprint),
                )
                .map_err(ControlError::TaskState)?;
            }
            root.request_review(root.revision())
                .map_err(ControlError::TaskState)?;
            root.accept_review(root.revision(), user_review)
                .map_err(ControlError::TaskState)?;
            let record = ledger
                .product_tasks
                .get_mut(&id)
                .expect("task checked above");
            record.updated = std::cmp::max(now(), record.created.clone());
            view(ledger, &id)
        }
        TaskCommand::Output {
            id,
            run_id,
            operation,
            revision,
        } => {
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::RootNotFound));
            }
            let root = ledger
                .roots
                .get(&id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            if root.revision() != revision {
                return Err(ControlError::TaskState(
                    super::state::StateError::RevisionConflict,
                ));
            }
            let _run = ledger
                .root_runs
                .get(&run_id)
                .filter(|r| r.root_id == id)
                .ok_or(ControlError::Admission(AdmissionError::RootRunNotFound))?;
            if !matches!(operation.as_str(), "verify" | "retry") {
                return Err(invalid());
            }
            view(ledger, &id)
        }
        TaskCommand::Cancel { id, revision } => {
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::RootNotFound));
            }
            let root = ledger
                .roots
                .get_mut(&id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            if root.revision() != revision {
                return Err(ControlError::TaskState(
                    super::state::StateError::RevisionConflict,
                ));
            }
            if root.status() != RootStatus::Cancelled {
                root.stop(
                    revision,
                    RootStatus::Cancelled,
                    super::state::StopCause::UserCancelled,
                    "Cancelled by the user".into(),
                )
                .map_err(ControlError::TaskState)?;
                let record = ledger
                    .product_tasks
                    .get_mut(&id)
                    .expect("task checked above");
                record.updated = std::cmp::max(now(), record.created.clone());
            }
            view(ledger, &id)
        }
        TaskCommand::Remove { id, revision } => {
            if !ledger.product_tasks.contains_key(&id) {
                return Err(ControlError::Admission(AdmissionError::RootNotFound));
            }
            let root = ledger
                .roots
                .get(&id)
                .ok_or(ControlError::Store(StoreError::Corrupt))?;
            if root.revision() != revision {
                return Err(ControlError::TaskState(
                    super::state::StateError::RevisionConflict,
                ));
            }
            if root.status() != RootStatus::Cancelled
                || ledger
                    .root_runs
                    .values()
                    .any(|run| run.root_id == id && run.status != super::root_runs::RunStatus::Settled)
                || ledger.registry.references_session(&id)
            {
                return Err(ControlError::Admission(
                    AdmissionError::TaskCapabilityUnavailable,
                ));
            }
            ledger.product_tasks.remove(&id);
            ledger.roots.remove(&id);
            if let Some(roots) = ledger.roots_by_session.get_mut(&id) {
                roots.remove(&id);
                if roots.is_empty() {
                    ledger.roots_by_session.remove(&id);
                }
            }
            ledger.root_runs.retain(|_, run| run.root_id != id);
            ledger.candidate_receipts.retain(|_, receipt| receipt.root_id != id);
            ledger.publication_receipts.retain(|_, receipt| receipt.candidate.root_id != id);
            Ok(json!({"ok":true}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TaskRequest {
        serde_json::from_value(json!({"id":"task","goal":"Bounded task","criteria":"Original criteria","provider":"ollama","model":"local-model","integrations":[],"confirmedFree":[],"spending":{"kind":"local_only"},"limits":{"runs":2,"modelRequests":12,"toolCalls":0,"activeMs":300000},"inputs":[],"diagnosticDays":7})).unwrap()
    }

    #[test]
    fn task_admission_refuses_unbounded_definitions_forged_state_and_unavailable_schedules() {
        let valid = request();
        assert_eq!(valid.validate(), Ok(()));
        let mut bad = valid.clone();
        bad.spending = Spending::ApiAllowed {
            acknowledged: false,
        };
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.inputs = vec![InputFile {
            name: ".txt".into(),
            content: "x".into(),
        }];
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.provider = "hosted".into();
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.inputs = vec![InputFile {
            name: "../../secret.txt".into(),
            content: "x".into(),
        }];
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.inputs = vec![InputFile {
            name: "data.txt".into(),
            content: "x".repeat(16_001),
        }];
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.limits.model_requests = 385;
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.schedule = Some(json!({"kind":"once"}));
        assert_eq!(
            bad.validate(),
            Err(ControlError::Admission(
                AdmissionError::TaskCapabilityUnavailable
            ))
        );
        let mut value = serde_json::to_value(valid).unwrap();
        value["state"] = json!("completed");
        assert!(serde_json::from_value::<TaskRequest>(value).is_err());
    }

    #[test]
    fn task_restore_rejects_changed_original_definition_and_list_omits_content() {
        let mut ledger = CapacityLedger::default();
        let mut request = request();
        request.inputs.push(InputFile {
            name: "source.txt".into(),
            content: "private source marker".into(),
        });
        create(&mut ledger, request, "2026-10-30T00:00:00.000Z").unwrap();
        assert_eq!(validate(&ledger), Ok(()));
        let summary = list(&ledger).unwrap().to_string();
        assert!(
            !summary.contains("private source marker")
                && !summary.contains("Original criteria")
                && !summary.contains("sha256")
        );
        assert_eq!(
            summary_goal(&format!("  {}", "😀".repeat(70))),
            "😀".repeat(60)
        );
        ledger.product_tasks.get_mut("task").unwrap().request.goal =
            "Changed original definition".into();
        assert_eq!(validate(&ledger), Err(StoreError::Corrupt));
    }

    #[test]
    fn native_wall_clock_format_handles_epoch_leap_day_and_day_boundary() {
        assert_eq!(timestamp(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp(951_782_400, 125), "2000-02-29T00:00:00.125Z");
        assert_eq!(timestamp(86_399, 999), "1970-01-01T23:59:59.999Z");
        assert_eq!(timestamp(86_400, 0), "1970-01-02T00:00:00.000Z");
        assert!(valid_timestamp("2000-02-29T23:59:59.999Z"));
        for invalid in [
            "2100-02-29T00:00:00.000Z",
            "2026-13-01T00:00:00.000Z",
            "2026-10-30T24:00:00.000Z",
            "2026-10-30T00:00:00.000+05:30",
            "not-a-timestamp",
        ] {
            assert!(!valid_timestamp(invalid));
        }
    }
}
