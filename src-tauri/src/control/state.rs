//! Revision-fenced native root-task state. Workers may propose changes, but
//! callers must route every transition through the owning control actor.
use super::delegation::{
    ChildProposal, ClaimedBenefit, DelegationMode, DelegationPolicy, ProposalDisposition,
    ProposalReason, validate_proposal,
};
use super::registry::WorkspaceGrant;
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
pub enum StopCause {
    UserCancelled,
    ActiveTimeLimit,
    BudgetLimit,
    ResourceExhausted,
    ExternalEffectUncertain,
    ApplicationShutdown,
    ControlRestart,
    PolicyBlocked,
    VerificationStalled,
    ExecutionError,
    Unknown,
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

#[derive(Clone, Debug)]
pub struct RootCreate {
    pub id: String,
    pub goal: String,
    pub criteria: String,
    pub run_limit: u32,
    pub requirements: Vec<Requirement>,
    pub delegation: DelegationPolicy,
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
    stop_cause: Option<StopCause>,
    stop_reason: Option<String>,
    review: Option<UserReview>,
    delegation: DelegationPolicy,
    workspace_grant: Option<WorkspaceGrant>,
    children: BTreeMap<String, ChildTask>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildStatus {
    Queued,
    Invalidated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChildTask {
    id: String,
    request_id: String,
    contract_revision: u64,
    revision: u64,
    status: ChildStatus,
    objective: String,
    acceptance: String,
    inputs: Vec<String>,
    reads: Vec<String>,
    writes: Vec<String>,
    benefit: ClaimedBenefit,
    queue_lease_id: u64,
}

impl ChildTask {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn status(&self) -> ChildStatus {
        self.status
    }
    pub fn queue_lease_id(&self) -> u64 {
        self.queue_lease_id
    }

    fn matches(&self, proposal: &ChildProposal) -> bool {
        self.request_id == proposal.request_id
            && self.objective == proposal.objective
            && self.acceptance == proposal.acceptance
            && self.inputs == proposal.inputs
            && self.reads == proposal.reads
            && self.writes == proposal.writes
            && self.benefit == proposal.benefit
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StateError {
    InvalidIdentity,
    InvalidText,
    InvalidLimit,
    RevisionConflict,
    InvalidTransition(RootStatus),
    StopCauseMismatch,
    RequirementSetInvalid,
    RequirementNotFound,
    RequirementStale,
    EvidenceIncomplete,
    InvalidReview,
    Delegation(ProposalReason),
    ChildLimitReached,
    ChildIdentityConflict,
    ChildrenOutstanding,
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
        Self::create_with_delegation(
            id,
            goal,
            criteria,
            run_limit,
            requirements,
            DelegationPolicy::new(DelegationMode::Disabled, 0).map_err(StateError::Delegation)?,
        )
    }

    pub fn create_with_delegation(
        id: String,
        goal: String,
        criteria: String,
        run_limit: u32,
        requirements: Vec<Requirement>,
        delegation: DelegationPolicy,
    ) -> Result<Self, StateError> {
        Self::create_with_grant(
            id,
            goal,
            criteria,
            run_limit,
            requirements,
            delegation,
            None,
        )
    }

    pub fn create_with_grant(
        id: String,
        goal: String,
        criteria: String,
        run_limit: u32,
        requirements: Vec<Requirement>,
        delegation: DelegationPolicy,
        workspace_grant: Option<WorkspaceGrant>,
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
            stop_cause: None,
            stop_reason: None,
            review: None,
            delegation,
            workspace_grant,
            children: BTreeMap::new(),
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
    pub fn stop_cause(&self) -> Option<StopCause> {
        self.stop_cause
    }
    pub fn review(&self) -> Option<&UserReview> {
        self.review.as_ref()
    }

    pub fn children(&self) -> &BTreeMap<String, ChildTask> {
        &self.children
    }

    pub fn delegation_policy(&self) -> DelegationPolicy {
        self.delegation
    }

    pub fn workspace_grant(&self) -> Option<&WorkspaceGrant> {
        self.workspace_grant.as_ref()
    }

    pub fn invalidate_queued_children(&mut self) -> Result<Vec<u64>, StateError> {
        let queue_leases = self.drain_queued_children()?;
        if !queue_leases.is_empty() {
            self.bump_revision()?;
        }
        Ok(queue_leases)
    }

    fn drain_queued_children(&mut self) -> Result<Vec<u64>, StateError> {
        let mut queue_leases = Vec::new();
        for child in self.children.values_mut() {
            if child.status == ChildStatus::Queued {
                child.status = ChildStatus::Invalidated;
                child.revision = child.revision.checked_add(1).ok_or(StateError::Corrupt)?;
                queue_leases.push(child.queue_lease_id);
            }
        }
        Ok(queue_leases)
    }

    pub fn new_child_count(&self, proposals: &[ChildProposal]) -> Result<usize, StateError> {
        let mut requests = std::collections::BTreeSet::new();
        let mut count = 0;
        for proposal in proposals {
            if !requests.insert(proposal.request_id.as_str()) {
                return Err(StateError::Delegation(ProposalReason::InvalidContract));
            }
            match self
                .children
                .values()
                .find(|child| child.request_id == proposal.request_id)
            {
                Some(child)
                    if child.matches(proposal)
                        && child.contract_revision == self.contract_revision
                        && child.status == ChildStatus::Queued => {}
                Some(_) => return Err(StateError::ChildIdentityConflict),
                None => count += 1,
            }
        }
        Ok(count)
    }

    pub fn validate_child_admission(
        &self,
        expected_revision: u64,
        proposals: &[ChildProposal],
    ) -> Result<usize, StateError> {
        let new_count = self.new_child_count(proposals)?;
        if new_count == 0 && !proposals.is_empty() {
            return Ok(0);
        }
        self.check_revision(expected_revision)?;
        if self.status != RootStatus::Running {
            return Err(StateError::InvalidTransition(self.status));
        }
        let decision = validate_proposal(self.delegation.mode(), proposals);
        if decision.disposition != ProposalDisposition::EligibleForTrustedAdmission {
            return Err(StateError::Delegation(decision.reason));
        }
        if self.children.len() + new_count > usize::from(self.delegation.max_children()) {
            return Err(StateError::ChildLimitReached);
        }
        Ok(new_count)
    }

    pub fn admit_children(
        &mut self,
        expected_revision: u64,
        proposals: Vec<ChildProposal>,
        queue_lease_ids: &[u64],
    ) -> Result<Vec<ChildTask>, StateError> {
        if !proposals.is_empty() && self.new_child_count(&proposals)? == 0 {
            return Ok(proposals
                .iter()
                .filter_map(|proposal| {
                    self.children
                        .values()
                        .find(|child| child.request_id == proposal.request_id)
                        .cloned()
                })
                .collect());
        }
        let new_count = self.validate_child_admission(expected_revision, &proposals)?;
        if queue_lease_ids.len() != new_count
            || queue_lease_ids.contains(&0)
            || queue_lease_ids
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != queue_lease_ids.len()
        {
            return Err(StateError::Corrupt);
        }

        let mut result = Vec::with_capacity(proposals.len());
        let mut next_child = self.children.len() + 1;
        let mut new_leases = queue_lease_ids.iter().copied();
        for proposal in proposals {
            if let Some(existing) = self
                .children
                .values()
                .find(|child| child.request_id == proposal.request_id)
            {
                result.push(existing.clone());
                continue;
            }
            let queue_lease_id = new_leases.next().ok_or(StateError::Corrupt)?;
            let id = format!("child-{next_child:04}");
            next_child += 1;
            let child = ChildTask {
                id: id.clone(),
                request_id: proposal.request_id,
                contract_revision: self.contract_revision,
                revision: 1,
                status: ChildStatus::Queued,
                objective: proposal.objective,
                acceptance: proposal.acceptance,
                inputs: proposal.inputs,
                reads: proposal.reads,
                writes: proposal.writes,
                benefit: proposal.benefit,
                queue_lease_id,
            };
            self.children.insert(id, child.clone());
            result.push(child);
        }
        self.bump_revision()?;
        Ok(result)
    }

    pub fn recover_after_restart(&mut self) -> Result<bool, StateError> {
        if !matches!(
            self.status,
            RootStatus::Running | RootStatus::WaitingForApproval
        ) {
            return Ok(false);
        }
        self.status = RootStatus::Interrupted;
        self.stop_cause = Some(StopCause::ControlRestart);
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
            self.stop_cause = Some(StopCause::BudgetLimit);
            self.stop_reason = Some("Root run limit reached".into());
            return self.bump_revision();
        }
        self.runs_started += 1;
        self.status = RootStatus::Running;
        self.stop_cause = None;
        self.stop_reason = None;
        self.review = None;
        self.bump_revision()?;
        Ok(())
    }

    pub fn wait_for_input(&mut self, expected_revision: u64) -> Result<(), StateError> {
        self.transition_and_invalidate_children(expected_revision, RootStatus::WaitingForInput)
    }

    pub fn wait_for_approval(&mut self, expected_revision: u64) -> Result<(), StateError> {
        self.transition_and_invalidate_children(expected_revision, RootStatus::WaitingForApproval)
    }

    pub fn stop(
        &mut self,
        expected_revision: u64,
        status: RootStatus,
        cause: StopCause,
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
        if !cause_matches_status(status, cause) {
            return Err(StateError::StopCauseMismatch);
        }
        if self.status.is_terminal() {
            return Err(StateError::InvalidTransition(self.status));
        }
        validate_text(&reason, 1_000)?;
        self.status = status;
        self.stop_cause = Some(cause);
        self.stop_reason = Some(reason);
        self.review = None;
        self.drain_queued_children()?;
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
        self.stop_cause = None;
        self.stop_reason = None;
        self.review = None;
        self.drain_queued_children()?;
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
            .children
            .values()
            .any(|child| child.status == ChildStatus::Queued)
        {
            return Err(StateError::ChildrenOutstanding);
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
                .children
                .values()
                .any(|child| child.status == ChildStatus::Queued)
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
        self.stop_cause = None;
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

    fn transition_and_invalidate_children(
        &mut self,
        expected_revision: u64,
        to: RootStatus,
    ) -> Result<(), StateError> {
        self.check_revision(expected_revision)?;
        if self.status != RootStatus::Running {
            return Err(StateError::InvalidTransition(self.status));
        }
        self.drain_queued_children()?;
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
        let delegation_valid =
            DelegationPolicy::new(self.delegation.mode(), self.delegation.max_children()).is_ok();
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
            || !delegation_valid
            || self
                .workspace_grant
                .as_ref()
                .is_some_and(|grant| grant.validate().is_err())
            || self.children.len() > usize::from(self.delegation.max_children())
            || self
                .children
                .values()
                .map(|child| child.request_id.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.children.len()
            || self.children.iter().any(|(id, child)| {
                id != &child.id
                    || !valid_identity(id)
                    || !valid_identity(&child.request_id)
                    || child.contract_revision == 0
                    || child.contract_revision > self.contract_revision
                    || child.revision == 0
                    || child.queue_lease_id == 0
                    || (child.status == ChildStatus::Queued
                        && child.contract_revision != self.contract_revision)
                    || validate_text(&child.objective, MAX_TEXT).is_err()
                    || validate_text(&child.acceptance, 4_000).is_err()
                    || child.inputs.is_empty()
                    || child.inputs.len() > 64
                    || child.reads.len() > 64
                    || child.writes.len() > 64
                    || !unique_references(&child.inputs)
                    || !unique_references(&child.reads)
                    || !unique_references(&child.writes)
            })
            || (matches!(self.status, RootStatus::NeedsReview | RootStatus::Completed)
                && self
                    .children
                    .values()
                    .any(|child| child.status == ChildStatus::Queued))
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
            || (matches!(
                self.status,
                RootStatus::Blocked
                    | RootStatus::Stalled
                    | RootStatus::Failed
                    | RootStatus::Cancelled
                    | RootStatus::Interrupted
                    | RootStatus::LimitReached
            ) != self.stop_cause.is_some())
            || self
                .stop_cause
                .is_some_and(|cause| !cause_matches_status(self.status, cause))
        {
            return Err(StateError::Corrupt);
        }
        validate_text(&self.goal, MAX_TEXT)?;
        validate_text(&self.criteria, 4_000)?;
        if let Some(reason) = &self.stop_reason {
            validate_text(reason, 1_000)?;
        }
        if let Some(review) = &self.review
            && (!valid_timestamp(&review.at)
                || !valid_identity(&review.evidence_ref)
                || validate_text(&review.note, 4_000).is_err())
        {
            return Err(StateError::Corrupt);
        }
        Ok(())
    }
}

fn cause_matches_status(status: RootStatus, cause: StopCause) -> bool {
    match status {
        RootStatus::Blocked => matches!(
            cause,
            StopCause::PolicyBlocked | StopCause::ExternalEffectUncertain | StopCause::Unknown
        ),
        RootStatus::Stalled => matches!(
            cause,
            StopCause::VerificationStalled | StopCause::ResourceExhausted | StopCause::Unknown
        ),
        RootStatus::Failed => matches!(
            cause,
            StopCause::ExecutionError | StopCause::ExternalEffectUncertain | StopCause::Unknown
        ),
        RootStatus::Cancelled => matches!(cause, StopCause::UserCancelled | StopCause::Unknown),
        RootStatus::Interrupted => matches!(
            cause,
            StopCause::ApplicationShutdown | StopCause::ControlRestart | StopCause::Unknown
        ),
        RootStatus::LimitReached => matches!(
            cause,
            StopCause::ActiveTimeLimit | StopCause::BudgetLimit | StopCause::Unknown
        ),
        RootStatus::Queued
        | RootStatus::Running
        | RootStatus::WaitingForInput
        | RootStatus::WaitingForApproval
        | RootStatus::NeedsReview
        | RootStatus::Completed => false,
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn unique_references(values: &[String]) -> bool {
    values.iter().all(|value| valid_identity(value))
        && values
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == values.len()
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

    fn delegating_root() -> RootTask {
        RootTask::create_with_delegation(
            "root-1".into(),
            "Deliver the checked result".into(),
            "Meet the declared criteria".into(),
            3,
            vec![Requirement::new("outcome".into(), true).unwrap()],
            DelegationPolicy::new(DelegationMode::BoundedAdaptive, 2).unwrap(),
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
            benefit: ClaimedBenefit::IndependentJudgment,
        }
    }

    #[test]
    fn queued_children_are_revision_fenced_idempotent_and_block_review() {
        let mut task = delegating_root();
        task.start_attempt(task.revision()).unwrap();
        let proposals = vec![
            child_proposal("request-a", "candidate-a"),
            child_proposal("request-b", "candidate-b"),
        ];
        let queued = task
            .admit_children(task.revision(), proposals.clone(), &[11, 12])
            .unwrap();
        assert_eq!(queued.len(), 2);
        assert!(
            queued
                .iter()
                .all(|child| child.status() == ChildStatus::Queued)
        );
        let revision = task.revision();
        assert_eq!(
            task.admit_children(1, proposals, &[]).unwrap(),
            queued,
            "a retry returns prior children even after the root revision advanced"
        );
        assert_eq!(task.revision(), revision);
        assert_eq!(
            task.request_review(task.revision()),
            Err(StateError::ChildrenOutstanding)
        );
        task.validate().unwrap();
    }

    #[test]
    fn root_changes_invalidate_queued_children() {
        let mut task = delegating_root();
        task.start_attempt(task.revision()).unwrap();
        task.admit_children(
            task.revision(),
            vec![
                child_proposal("request-a", "candidate-a"),
                child_proposal("request-b", "candidate-b"),
            ],
            &[11, 12],
        )
        .unwrap();
        let mut mismatched = task.clone();
        assert_eq!(
            mismatched.stop(
                mismatched.revision(),
                RootStatus::Cancelled,
                StopCause::PolicyBlocked,
                "Wrong cause for state".into(),
            ),
            Err(StateError::StopCauseMismatch)
        );
        task.stop(
            task.revision(),
            RootStatus::Cancelled,
            StopCause::UserCancelled,
            "User stopped".into(),
        )
        .unwrap();
        assert!(
            task.children()
                .values()
                .all(|child| child.status() == ChildStatus::Invalidated)
        );
        task.validate().unwrap();
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
            StopCause::PolicyBlocked,
            "Required evidence is unknown".into(),
        )
        .unwrap();
        assert_eq!(task.status(), RootStatus::Blocked);
        assert_eq!(task.stop_cause(), Some(StopCause::PolicyBlocked));
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
        assert_eq!(task.stop_cause(), Some(StopCause::BudgetLimit));
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
        assert_eq!(task.stop_cause(), Some(StopCause::ControlRestart));
        assert_eq!(
            task.start_attempt(task.revision()),
            Err(StateError::InvalidTransition(RootStatus::Interrupted))
        );
        task.validate().unwrap();
    }
}
