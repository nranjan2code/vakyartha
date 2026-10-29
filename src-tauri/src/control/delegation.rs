//! Deterministic validation of proposed delegation boundaries.
//!
//! This is a proposal gate, not child admission or dispatch. A positive result
//! only means the request has a bounded shape worth checking against persisted
//! task policy, capacity and worker authority in the control actor.

use std::collections::BTreeSet;

const MAX_CHILDREN_PER_PROPOSAL: usize = 4;
const MAX_REFERENCES_PER_CHILD: usize = 64;
const MAX_FIELD_BYTES: usize = 8_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DelegationMode {
    Disabled,
    BoundedAdaptive,
    DeclaredWorkflow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimedBenefit {
    RequiredSeparation,
    IndependentJudgment,
    ContextBound,
    MeasuredParallelism,
    RoleLabelOnly,
    GenericComplexity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChildProposal {
    pub request_id: String,
    pub objective: String,
    pub acceptance: String,
    pub inputs: Vec<String>,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
    pub benefit: ClaimedBenefit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalDisposition {
    Inline,
    EligibleForTrustedAdmission,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalReason {
    BoundedProposal,
    DelegationDisabled,
    NoIndependentWork,
    BenefitNotEstablished,
    SeparationNotDeclared,
    TooManyChildren,
    InvalidContract,
    OverlappingWrites,
    ReadWriteDependency,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalDecision {
    pub disposition: ProposalDisposition,
    pub reason: ProposalReason,
}

pub fn validate_proposal(mode: DelegationMode, proposals: &[ChildProposal]) -> ProposalDecision {
    let inline = |reason| ProposalDecision {
        disposition: ProposalDisposition::Inline,
        reason,
    };

    if mode == DelegationMode::Disabled {
        return inline(ProposalReason::DelegationDisabled);
    }
    if proposals.is_empty() {
        return inline(ProposalReason::NoIndependentWork);
    }
    if proposals.len() > MAX_CHILDREN_PER_PROPOSAL {
        return inline(ProposalReason::TooManyChildren);
    }

    let has_declared_separation = proposals
        .iter()
        .any(|proposal| proposal.benefit == ClaimedBenefit::RequiredSeparation);
    if mode != DelegationMode::DeclaredWorkflow && has_declared_separation {
        return inline(ProposalReason::SeparationNotDeclared);
    }

    if proposals.len() < 2
        && !proposals
            .iter()
            .any(|proposal| proposal.benefit == ClaimedBenefit::RequiredSeparation)
    {
        return inline(ProposalReason::NoIndependentWork);
    }

    if proposals.iter().any(|proposal| {
        matches!(
            proposal.benefit,
            ClaimedBenefit::RoleLabelOnly | ClaimedBenefit::GenericComplexity
        )
    }) {
        return inline(ProposalReason::BenefitNotEstablished);
    }

    let mut request_ids = BTreeSet::new();
    let mut writes = BTreeSet::new();
    let mut reads = BTreeSet::new();
    for proposal in proposals {
        if !valid_id(&proposal.request_id)
            || !request_ids.insert(proposal.request_id.as_str())
            || !valid_text(&proposal.objective)
            || !valid_text(&proposal.acceptance)
            || proposal.inputs.is_empty()
            || proposal.inputs.len() > MAX_REFERENCES_PER_CHILD
            || proposal.reads.len() > MAX_REFERENCES_PER_CHILD
            || proposal.writes.len() > MAX_REFERENCES_PER_CHILD
            || !unique_ids(&proposal.inputs)
            || !unique_ids(&proposal.reads)
            || !unique_ids(&proposal.writes)
        {
            return inline(ProposalReason::InvalidContract);
        }
        if proposal.inputs.iter().any(|id| !valid_id(id)) {
            return inline(ProposalReason::InvalidContract);
        }
        if proposal.reads.iter().any(|id| !valid_id(id)) {
            return inline(ProposalReason::InvalidContract);
        }
        if proposal.writes.iter().any(|id| !valid_id(id)) {
            return inline(ProposalReason::InvalidContract);
        }
        for resource in &proposal.writes {
            if !writes.insert(resource.as_str()) {
                return inline(ProposalReason::OverlappingWrites);
            }
        }
        reads.extend(proposal.reads.iter().map(String::as_str));
    }
    if writes.iter().any(|resource| reads.contains(resource)) {
        return inline(ProposalReason::ReadWriteDependency);
    }

    ProposalDecision {
        disposition: ProposalDisposition::EligibleForTrustedAdmission,
        reason: ProposalReason::BoundedProposal,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_FIELD_BYTES && !value.contains('\0')
}

fn unique_ids(values: &[String]) -> bool {
    values.iter().all(|value| valid_id(value))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(request_id: &str, write: &str) -> ChildProposal {
        ChildProposal {
            request_id: request_id.into(),
            objective: format!("Inspect {request_id}"),
            acceptance: format!("Return evidence for {request_id}"),
            inputs: vec![format!("input-{request_id}")],
            reads: vec![],
            writes: vec![write.into()],
            benefit: ClaimedBenefit::IndependentJudgment,
        }
    }

    #[test]
    fn complexity_or_role_labels_do_not_justify_children() {
        let mut one = proposal("child-1", "candidate-1");
        one.benefit = ClaimedBenefit::GenericComplexity;
        assert_eq!(
            validate_proposal(DelegationMode::BoundedAdaptive, &[one]).disposition,
            ProposalDisposition::Inline
        );
        let mut two = proposal("child-2", "candidate-2");
        two.benefit = ClaimedBenefit::RoleLabelOnly;
        assert_eq!(
            validate_proposal(
                DelegationMode::BoundedAdaptive,
                &[proposal("child-1", "candidate-1"), two]
            )
            .reason,
            ProposalReason::BenefitNotEstablished
        );
    }

    #[test]
    fn bounded_independent_proposals_are_only_eligible_for_later_admission() {
        let decision = validate_proposal(
            DelegationMode::BoundedAdaptive,
            &[
                proposal("child-1", "candidate-1"),
                proposal("child-2", "candidate-2"),
            ],
        );
        assert_eq!(
            decision.disposition,
            ProposalDisposition::EligibleForTrustedAdmission
        );
    }

    #[test]
    fn adaptive_mode_cannot_claim_workflow_mandated_separation() {
        let mut required = proposal("child-1", "candidate-1");
        required.benefit = ClaimedBenefit::RequiredSeparation;
        assert_eq!(
            validate_proposal(DelegationMode::BoundedAdaptive, &[required]).reason,
            ProposalReason::SeparationNotDeclared
        );
    }

    #[test]
    fn overlap_and_unbounded_shapes_fail_closed() {
        assert_eq!(
            validate_proposal(
                DelegationMode::BoundedAdaptive,
                &[
                    proposal("child-1", "same-write"),
                    proposal("child-2", "same-write"),
                ]
            )
            .reason,
            ProposalReason::OverlappingWrites
        );
        let many = (0..5)
            .map(|index| proposal(&format!("child-{index}"), &format!("write-{index}")))
            .collect::<Vec<_>>();
        assert_eq!(
            validate_proposal(DelegationMode::BoundedAdaptive, &many).reason,
            ProposalReason::TooManyChildren
        );

        let mut dependent = proposal("child-2", "candidate-2");
        dependent.reads.push("candidate-1".into());
        assert_eq!(
            validate_proposal(
                DelegationMode::BoundedAdaptive,
                &[proposal("child-1", "candidate-1"), dependent]
            )
            .reason,
            ProposalReason::ReadWriteDependency
        );
    }
}
