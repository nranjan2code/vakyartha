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

fn valid_timestamp(value: &str) -> bool {
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
                        file.name
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
    // The native dispatcher is intentionally not enabled yet. Do not synthesize
    // run history or completion from an authoring worker's claims.
    if root.runs_started() != 0 {
        return Err(ControlError::Admission(
            AdmissionError::TaskCapabilityUnavailable,
        ));
    }
    let cancelled = root.status() == RootStatus::Cancelled;
    let mut result = json!({
        "version": 5, "revision": root.revision(), "id": id, "session": id,
        "goal": request.goal, "criteria": request.criteria, "provider": request.provider, "model": request.model,
        "integrations": request.integrations, "confirmedFree": request.confirmed_free, "spending": request.spending,
        "limits": request.limits, "budget": {"modelRequests":0,"toolCalls":0,"activeMs":0},
        "state": if cancelled {"cancelled"} else {"queued"}, "created": record.created, "updated": record.updated,
        "note": if cancelled {"Stopped before native execution."} else {"Saved. Execution is currently unavailable; no model or tool has been started."},
        "runs":0,"runHistory":[],"operations":[],"accepted":[],"activity":[],"pending":[],
        "inputs": request.inputs.iter().map(|file| json!({"name":file.name,"content":file.content,"bytes":file.content.len(),"sha256":super::canonical::digest(file.content.as_bytes())})).collect::<Vec<_>>(),
        "diagnosticDays":request.diagnostic_days,
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
    records.into_iter().map(|record| {
        let root = ledger.roots.get(&record.request.id).ok_or(ControlError::Store(StoreError::Corrupt))?;
        let cancelled = root.status() == RootStatus::Cancelled;
        Ok(json!({"id":record.request.id,"session":record.request.id,"goal":record.request.goal.chars().take(120).collect::<String>(),"state":if cancelled {"cancelled"} else {"queued"},"updated":record.updated,"revision":root.revision(),"note":if cancelled {"Stopped before native execution."} else {"Saved. Execution is currently unavailable; no model or tool has been started."}}))
    }).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

pub(super) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    if ledger.product_tasks.len() > MAX_TASKS {
        return Err(StoreError::Corrupt);
    }
    for (id, record) in &ledger.product_tasks {
        let root = ledger.roots.get(id).ok_or(StoreError::Corrupt)?;
        if id != &record.request.id
            || record.request.validate().is_err()
            || root.session_id() != Some(id.as_str())
            || !root.creation_request_matches(
                &root_create(&record.request).map_err(|_| StoreError::Corrupt)?,
            )
            || root.runs_started() != 0
            || !matches!(root.status(), RootStatus::Queued | RootStatus::Cancelled)
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskCommand {
    List,
    Create { request: Box<TaskRequest> },
    Read { id: String },
    Cancel { id: String, revision: u64 },
    Remove { id: String, revision: u64 },
}

pub(super) fn apply(
    ledger: &mut CapacityLedger,
    command: TaskCommand,
) -> Result<Value, ControlError> {
    match command {
        TaskCommand::List => list(ledger),
        TaskCommand::Read { id } => view(ledger, &id),
        TaskCommand::Create { request } => create(ledger, *request, &now()),
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
                || root.runs_started() != 0
                || ledger
                    .candidate_receipts
                    .values()
                    .any(|receipt| receipt.root_id == id)
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
