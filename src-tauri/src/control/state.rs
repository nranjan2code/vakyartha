//! Revision-fenced native root-task state. Workers may propose changes, but
//! callers must route every transition through the owning control actor.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_REQUIREMENTS: usize = 128;
const MAX_TEXT: usize = 8_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootStatus {
    Queued,
    Running,
    WaitingForInput,
    WaitingForApproval,
    NeedsReview,
    Blocked,
    Stalled,
    Failed,
    Cancelled,
    Interrupted,
    LimitReached,
    Completed,
}

impl RootStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Failed | Self::Cancelled | Self::LimitReached | Self::Completed
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Pending,
    Pass,
    Fail,
    Unknown,
    Stale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    id: String,
    mandatory: bool,
    contract_revision: u64,
    outcome: CheckOutcome,
    receipt: Option<String>,
}

impl Requirement {
    pub fn new(id: String, mandatory: bool) -> Result<Self, StateError> {
        if !valid_identity(&id) {
            return Err(StateError::InvalidIdentity);
        }
        Ok(Self {
            id,
            mandatory,
            contract_revision: 1,
            outcome: CheckOutcome::Pending,
            receipt: None,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn mandatory(&self) -> bool {
        self.mandatory
    }
    pub fn outcome(&self) -> CheckOutcome {
        self.outcome
    }
    pub fn receipt(&self) -> Option<&str> {
        self.receipt.as_deref()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UserReview {
    pub at: String,
    pub evidence_ref: String,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RootTask {
    id: String,
    revision: u64,
    contract_revision: u64,
    status: RootStatus,
    goal: String,
    criteria: String,
    run_limit: u32,
    runs_started: u32,
    requirements: BTreeMap<String, Requirement>,
    stop_reason: Option<String>,
    review: Option<UserReview>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StateError {
    InvalidIdentity,
    InvalidText,
    InvalidLimit,
    RevisionConflict,
    InvalidTransition(RootStatus),
    RequirementSetInvalid,
    RequirementNotFound,
    RequirementStale,
    EvidenceIncomplete,
    InvalidReview,
    Corrupt,
}

impl RootTask {
    pub fn create(
        id: String,
        goal: String,
        criteria: String,
        run_limit: u32,
        requirements: Vec<Requirement>,
    ) -> Result<Self, StateError> {
        if !valid_identity(&id) {
            return Err(StateError::InvalidIdentity);
        }
        validate_text(&goal, MAX_TEXT)?;
        validate_text(&criteria, 4_000)?;
        if run_limit == 0 || run_limit > 256 {
            return Err(StateError::InvalidLimit);
        }
        if requirements.is_empty()
            || requirements.len() > MAX_REQUIREMENTS
            || !requirements.iter().any(Requirement::mandatory)
        {
            return Err(StateError::RequirementSetInvalid);
        }
        let mut indexed = BTreeMap::new();
        for requirement in requirements {
            if !valid_identity(&requirement.id)
                || requirement.contract_revision != 1
                || requirement.outcome != CheckOutcome::Pending
                || requirement.receipt.is_some()
                || indexed
                    .insert(requirement.id.clone(), requirement)
                    .is_some()
            {
                return Err(StateError::RequirementSetInvalid);
            }
        }
        Ok(Self {
            id,
            revision: 1,
            contract_revision: 1,
            status: RootStatus::Queued,
            goal,
            criteria,
            run_limit,
            runs_started: 0,
            requirements: indexed,
            stop_reason: None,
            review: None,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn contract_revision(&self) -> u64 {
        self.contract_revision
    }
    pub fn status(&self) -> RootStatus {
        self.status
    }
    pub fn runs_started(&self) -> u32 {
        self.runs_started
    }
    pub fn requirements(&self) -> &BTreeMap<String, Requirement> {
        &self.requirements
    }
    pub fn stop_reason(&self) -> Option<&str> {
        self.stop_reason.as_deref()
    }
    pub fn review(&self) -> Option<&UserReview> {
        self.review.as_ref()
    }

    pub fn recover_after_restart(&mut self) -> Result<bool, StateError> {
        if !matches!(
            self.status,
            RootStatus::Running | RootStatus::WaitingForApproval
        ) {
            return Ok(false);
        }
        self.status = RootStatus::Interrupted;
        self.stop_reason = Some(
            "Native control restarted during work; review in-flight effects before continuing"
                .into(),
        );
        self.review = None;
        self.bump_revision()?;
        Ok(true)
    }

    pub fn start_attempt(&mut self, expected_revision: u64) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if self.status != RootStatus::Queued {
            return Err(StateError::InvalidTransition(self.status));
        }
        if self.runs_started >= self.run_limit {
            self.status = RootStatus::LimitReached;
            self.stop_reason = Some("Root run limit reached".into());
            return self.bump_revision();
        }
        self.runs_started += 1;
        self.status = RootStatus::Running;
        self.stop_reason = None;
        self.review = None;
        self.bump_revision()?;
        Ok(())
    }

    pub fn wait_for_input(&mut self, expected_revision: u64) -> Result<(), StateError> {
        self.transition(
            expected_revision,
            RootStatus::Running,
            RootStatus::WaitingForInput,
        )
    }

    pub fn wait_for_approval(&mut self, expected_revision: u64) -> Result<(), StateError> {
        self.transition(
            expected_revision,
            RootStatus::Running,
            RootStatus::WaitingForApproval,
        )
    }

    pub fn stop(
        &mut self,
        expected_revision: u64,
        status: RootStatus,
        reason: String,
    ) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if !matches!(
            status,
            RootStatus::Blocked
                | RootStatus::Stalled
                | RootStatus::Failed
                | RootStatus::Cancelled
                | RootStatus::Interrupted
                | RootStatus::LimitReached
        ) {
            return Err(StateError::InvalidTransition(status));
        }
        if self.status.is_terminal() {
            return Err(StateError::InvalidTransition(self.status));
        }
        validate_text(&reason, 1_000)?;
        self.status = status;
        self.stop_reason = Some(reason);
        self.review = None;
        self.bump_revision()
    }

    pub fn revise_contract(
        &mut self,
        expected_revision: u64,
        goal: String,
        criteria: String,
    ) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if !matches!(
            self.status,
            RootStatus::Queued
                | RootStatus::WaitingForInput
                | RootStatus::Blocked
                | RootStatus::Stalled
                | RootStatus::NeedsReview
        ) {
            return Err(StateError::InvalidTransition(self.status));
        }
        validate_text(&goal, MAX_TEXT)?;
        validate_text(&criteria, 4_000)?;
        self.contract_revision = self
            .contract_revision
            .checked_add(1)
            .ok_or(StateError::Corrupt)?;
        for requirement in self.requirements.values_mut() {
            requirement.contract_revision = self.contract_revision;
            requirement.outcome = CheckOutcome::Stale;
            requirement.receipt = None;
        }
        self.goal = goal;
        self.criteria = criteria;
        self.status = RootStatus::Queued;
        self.stop_reason = None;
        self.review = None;
        self.bump_revision()
    }

    pub fn record_check(
        &mut self,
        expected_revision: u64,
        contract_revision: u64,
        requirement_id: &str,
        outcome: CheckOutcome,
        receipt: Option<String>,
    ) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if !matches!(self.status, RootStatus::Running | RootStatus::NeedsReview) {
            return Err(StateError::InvalidTransition(self.status));
        }
        if contract_revision != self.contract_revision {
            return Err(StateError::RequirementStale);
        }
        if matches!(outcome, CheckOutcome::Pending | CheckOutcome::Stale) {
            return Err(StateError::EvidenceIncomplete);
        }
        let requirement = self
            .requirements
            .get_mut(requirement_id)
            .ok_or(StateError::RequirementNotFound)?;
        if requirement.contract_revision != contract_revision {
            return Err(StateError::RequirementStale);
        }
        match outcome {
            CheckOutcome::Pass => {
                let value = receipt
                    .filter(|value| valid_identity(value))
                    .ok_or(StateError::EvidenceIncomplete)?;
                requirement.receipt = Some(value);
            }
            CheckOutcome::Fail | CheckOutcome::Unknown => {
                if receipt
                    .as_deref()
                    .is_some_and(|value| !valid_identity(value))
                {
                    return Err(StateError::EvidenceIncomplete);
                }
                requirement.receipt = receipt;
            }
            CheckOutcome::Pending | CheckOutcome::Stale => unreachable!(),
        }
        requirement.outcome = outcome;
        self.review = None;
        self.bump_revision()
    }

    pub fn request_review(&mut self, expected_revision: u64) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if self.status != RootStatus::Running {
            return Err(StateError::InvalidTransition(self.status));
        }
        if self
            .requirements
            .values()
            .any(|r| r.mandatory && r.outcome != CheckOutcome::Pass)
        {
            return Err(StateError::EvidenceIncomplete);
        }
        self.status = RootStatus::NeedsReview;
        self.bump_revision()
    }

    pub fn accept_review(
        &mut self,
        expected_revision: u64,
        review: UserReview,
    ) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if self.status != RootStatus::NeedsReview
            || self
                .requirements
                .values()
                .any(|r| r.mandatory && r.outcome != CheckOutcome::Pass)
        {
            return Err(StateError::EvidenceIncomplete);
        }
        if !valid_timestamp(&review.at) || !valid_identity(&review.evidence_ref) {
            return Err(StateError::InvalidReview);
        }
        validate_text(&review.note, 4_000).map_err(|_| StateError::InvalidReview)?;
        self.review = Some(review);
        self.status = RootStatus::Completed;
        self.stop_reason = None;
        self.bump_revision()
    }

    fn transition(
        &mut self,
        expected_revision: u64,
        from: RootStatus,
        to: RootStatus,
    ) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if self.status != from {
            return Err(StateError::InvalidTransition(self.status));
        }
        self.status = to;
        self.bump_revision()
    }

    fn check_revision(&self, expected: u64) -> Result<(), StateError> {
        if self.revision != expected {
            Err(StateError::RevisionConflict)
        } else {
            Ok(())
        }
    }

    fn bump_revision(&mut self) -> Result<(), StateError> {
        self.revision = self.revision.checked_add(1).ok_or(StateError::Corrupt)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<(), StateError> {
        if !valid_identity(&self.id)
            || self.revision == 0
            || self.contract_revision == 0
            || self.run_limit == 0
            || self.run_limit > 256
            || self.runs_started > self.run_limit
            || self.requirements.len() > MAX_REQUIREMENTS
            || self.requirements.is_empty()
            || !self.requirements.values().any(Requirement::mandatory)
            || self.requirements.iter().any(|(id, requirement)| {
                id != &requirement.id
                    || !valid_identity(id)
                    || requirement.contract_revision != self.contract_revision
                    || (requirement.outcome == CheckOutcome::Pass && requirement.receipt.is_none())
                    || (matches!(
                        requirement.outcome,
                        CheckOutcome::Pending | CheckOutcome::Stale
                    ) && requirement.receipt.is_some())
                    || requirement
                        .receipt
                        .as_deref()
                        .is_some_and(|receipt| !valid_identity(receipt))
            })
            || (self.status == RootStatus::Completed) != self.review.is_some()
            || (self.status == RootStatus::Completed
                && self
                    .requirements
                    .values()
                    .any(|r| r.mandatory && r.outcome != CheckOutcome::Pass))
            || (matches!(
                self.status,
                RootStatus::Running
                    | RootStatus::WaitingForInput
                    | RootStatus::WaitingForApproval
                    | RootStatus::NeedsReview
                    | RootStatus::Completed
            ) && self.runs_started == 0)
            || (self.status == RootStatus::NeedsReview
                && self
                    .requirements
                    .values()
                    .any(|r| r.mandatory && r.outcome != CheckOutcome::Pass))
            || (matches!(
                self.status,
                RootStatus::Blocked
                    | RootStatus::Stalled
                    | RootStatus::Failed
                    | RootStatus::Cancelled
                    | RootStatus::Interrupted
                    | RootStatus::LimitReached
            ) != self.stop_reason.is_some())
        {
            return Err(StateError::Corrupt);
        }
        validate_text(&self.goal, MAX_TEXT)?;
        validate_text(&self.criteria, 4_000)?;
        if let Some(reason) = &self.stop_reason {
            validate_text(reason, 1_000)?;
        }
        if let Some(review) = &self.review {
            if !valid_timestamp(&review.at)
                || !valid_identity(&review.evidence_ref)
                || validate_text(&review.note, 4_000).is_err()
            {
                return Err(StateError::Corrupt);
            }
        }
        Ok(())
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn validate_text(value: &str, max: usize) -> Result<(), StateError> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        Err(StateError::InvalidText)
    } else {
        Ok(())
    }
}

fn valid_timestamp(value: &str) -> bool {
    value.len() <= 40
        && value.ends_with('Z')
        && value.contains('T')
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || b == b'-'
                || b == b':'
                || b == b'.'
                || b == b'T'
                || b == b'Z'
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> RootTask {
        RootTask::create(
            "root-1".into(),
            "Deliver the checked result".into(),
            "Meet the declared criteria".into(),
            3,
            vec![Requirement::new("outcome".into(), true).unwrap()],
        )
        .unwrap()
    }

    #[test]
    fn revision_fences_lifecycle_and_terminal_review() {
        let mut task = root();
        assert_eq!(task.start_attempt(0), Err(StateError::RevisionConflict));
        assert_eq!(task.start_attempt(1), Ok(()));
        assert_eq!(
            task.request_review(task.revision()),
            Err(StateError::EvidenceIncomplete)
        );
        task.record_check(
            task.revision(),
            1,
            "outcome",
            CheckOutcome::Pass,
            Some("receipt-1".into()),
        )
        .unwrap();
        task.request_review(task.revision()).unwrap();
        assert_eq!(task.status(), RootStatus::NeedsReview);
        assert_eq!(
            task.accept_review(
                task.revision(),
                UserReview {
                    at: "2026-10-29T10:00:00Z".into(),
                    evidence_ref: "review-1".into(),
                    note: "Checked the original outcome".into()
                }
            ),
            Ok(())
        );
        assert_eq!(task.status(), RootStatus::Completed);
        assert_eq!(
            task.start_attempt(task.revision()),
            Err(StateError::InvalidTransition(RootStatus::Completed))
        );
        task.validate().unwrap();
    }

    #[test]
    fn contract_revision_invalidates_evidence_and_review() {
        let mut task = root();
        task.start_attempt(1).unwrap();
        task.record_check(
            task.revision(),
            1,
            "outcome",
            CheckOutcome::Pass,
            Some("receipt-1".into()),
        )
        .unwrap();
        task.request_review(task.revision()).unwrap();
        task.revise_contract(
            task.revision(),
            "Changed goal".into(),
            "Changed criteria".into(),
        )
        .unwrap();
        assert_eq!(task.contract_revision(), 2);
        assert_eq!(task.status(), RootStatus::Queued);
        assert_eq!(
            task.requirements()["outcome"].outcome(),
            CheckOutcome::Stale
        );
        assert_eq!(
            task.request_review(task.revision()),
            Err(StateError::InvalidTransition(RootStatus::Queued))
        );
        task.validate().unwrap();
    }

    #[test]
    fn blocked_and_unknown_evidence_never_complete() {
        let mut task = root();
        task.start_attempt(1).unwrap();
        task.record_check(
            task.revision(),
            1,
            "outcome",
            CheckOutcome::Unknown,
            Some("check-1".into()),
        )
        .unwrap();
        assert_eq!(
            task.request_review(task.revision()),
            Err(StateError::EvidenceIncomplete)
        );
        task.stop(
            task.revision(),
            RootStatus::Blocked,
            "Required evidence is unknown".into(),
        )
        .unwrap();
        assert_eq!(task.status(), RootStatus::Blocked);
        task.validate().unwrap();
    }

    #[test]
    fn exhausted_run_allowance_becomes_a_persistable_terminal_state() {
        let mut task = RootTask::create(
            "root-1".into(),
            "Goal".into(),
            "Criteria".into(),
            1,
            vec![Requirement::new("outcome".into(), true).unwrap()],
        )
        .unwrap();
        task.start_attempt(task.revision()).unwrap();
        task.record_check(
            task.revision(),
            task.contract_revision(),
            "outcome",
            CheckOutcome::Pass,
            Some("receipt-1".into()),
        )
        .unwrap();
        task.request_review(task.revision()).unwrap();
        task.revise_contract(task.revision(), "New goal".into(), "New criteria".into())
            .unwrap();
        task.start_attempt(task.revision()).unwrap();
        assert_eq!(task.status(), RootStatus::LimitReached);
        assert_eq!(task.stop_reason(), Some("Root run limit reached"));
        task.validate().unwrap();
    }

    #[test]
    fn root_requires_at_least_one_mandatory_acceptance_check() {
        assert_eq!(
            RootTask::create(
                "root-1".into(),
                "Goal".into(),
                "Criteria".into(),
                1,
                vec![Requirement::new("optional".into(), false).unwrap()],
            )
            .unwrap_err(),
            StateError::RequirementSetInvalid,
        );
    }

    #[test]
    fn input_and_approval_waits_cannot_be_bypassed_by_start() {
        let mut input_wait = root();
        input_wait.start_attempt(input_wait.revision()).unwrap();
        input_wait.wait_for_input(input_wait.revision()).unwrap();
        assert_eq!(
            input_wait.start_attempt(input_wait.revision()),
            Err(StateError::InvalidTransition(RootStatus::WaitingForInput))
        );
        input_wait.validate().unwrap();

        let mut task = root();
        task.start_attempt(task.revision()).unwrap();
        task.wait_for_approval(task.revision()).unwrap();
        assert_eq!(
            task.start_attempt(task.revision()),
            Err(StateError::InvalidTransition(
                RootStatus::WaitingForApproval
            ))
        );
        task.validate().unwrap();

        assert!(task.recover_after_restart().unwrap());
        assert_eq!(task.status(), RootStatus::Interrupted);
        assert_eq!(
            task.start_attempt(task.revision()),
            Err(StateError::InvalidTransition(RootStatus::Interrupted))
        );
        task.validate().unwrap();
    }
}
