//! A native-issued context is sent only to the canonical role. Its response is
//! still a proposal: the actor rechecks fences and selects immutable bytes in
//! the same durable control generation as the publication receipt.
use super::canonical::{CandidateCommitReceipt, CanonicalContentStore, CanonicalSessionRecord};
use super::{AdmissionError, CapacityLedger, ControlError, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationReceipt {
    pub id: String,
    pub candidate: CandidateCommitReceipt,
    pub expected_revision: u64,
    pub revision: u64,
    pub digest: String,
}

// Neither type is deserializable or constructible by a worker/IPC command.
// Moving this native object binds a response to the specific canonical pipe.
pub struct PublicationPreparation {
    candidate: CandidateCommitReceipt,
    expected_revision: u64,
    context: Value,
}
pub struct PublicationProposal {
    preparation: PublicationPreparation,
    bytes: Vec<u8>,
}

fn invalid() -> ControlError {
    ControlError::Admission(AdmissionError::InvalidCandidate)
}
fn stale() -> ControlError {
    ControlError::TaskState(super::state::StateError::ExecutionFenceStale)
}
fn io(error: super::canonical::CanonicalStoreError) -> ControlError {
    ControlError::Store(super::canonical_store_error(error))
}

impl PublicationPreparation {
    pub fn frame(&self) -> Value {
        json!({"v":2,"type":"canonical_prepare","context":self.context})
    }
    pub(super) fn candidate(&self) -> &CandidateCommitReceipt {
        &self.candidate
    }
    pub fn id(&self) -> &str {
        self.context["id"]
            .as_str()
            .expect("native context identity")
    }
    /// Called only by the native supervisor reading its canonical-role pipe.
    pub(crate) fn response(self, bytes: &[u8]) -> Result<PublicationProposal, ControlError> {
        if bytes.len() > MAX_BYTES + 4096 {
            return Err(invalid());
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Response {
            v: u8,
            r#type: String,
            id: String,
            snapshot: Value,
        }
        let frame: Response = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if frame.v != 2 || frame.r#type != "canonical_prepared" || frame.id != self.id() {
            return Err(invalid());
        }
        let snapshot = &frame.snapshot;
        super::host_sessions::validate_snapshot(&self.candidate.session_id, snapshot)
            .map_err(ControlError::Store)?;
        // The semantic role must preserve the native-selected context even if
        // the worker emits a structurally valid envelope for another operation.
        let messages = snapshot["messages"].as_array().ok_or_else(invalid)?;
        if snapshot["updated"] != self.context["at"]
            || messages.len() < 2
            || messages[messages.len() - 2]
                != json!({"role":"user","content":self.context["message"]})
            || messages[messages.len() - 1]
                != json!({"role":"assistant","content":self.context["candidate"]["reply"]})
            || snapshot["surfaces"] != self.context["candidate"]["surfaces"]
        {
            return Err(invalid());
        }
        let bytes = serde_json::to_vec(snapshot).map_err(|_| invalid())?;
        if bytes.len() > MAX_BYTES {
            return Err(invalid());
        }
        Ok(PublicationProposal {
            preparation: self,
            bytes,
        })
    }
}

pub(super) fn current(
    ledger: &CapacityLedger,
    receipt: &CandidateCommitReceipt,
) -> Result<(), ControlError> {
    let root = ledger.roots.get(&receipt.root_id).ok_or_else(stale)?;
    if root.status() != super::state::RootStatus::Running
        || root.session_id() != Some(receipt.session_id.as_str())
        || root.revision() != receipt.root_revision
        || root.contract_revision() != receipt.contract_revision
        || root.cancellation_epoch() != receipt.cancellation_epoch
        || !super::root_runs::has_running_invocation(ledger, root)
        || root
            .workspace_grant()
            .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
    {
        return Err(stale());
    }
    let selected = ledger
        .canonical_sessions
        .get(&receipt.session_id)
        .ok_or_else(stale)?;
    if selected.revision != receipt.canonical_revision
        || selected.digest != receipt.digest
        || selected.root_id != receipt.root_id
    {
        return Err(stale());
    }
    Ok(())
}

pub(super) fn prepare(
    ledger: &CapacityLedger,
    candidates: &CanonicalContentStore,
    publications: &CanonicalContentStore,
    commit_id: &str,
    at: String,
) -> Result<PublicationPreparation, ControlError> {
    let receipt = ledger
        .candidate_receipts
        .get(commit_id)
        .ok_or_else(invalid)?;
    current(ledger, receipt)?;
    if ledger
        .publication_receipts
        .values()
        .any(|value| value.candidate.commit_id == commit_id)
    {
        return Err(ControlError::Admission(
            AdmissionError::CandidateIdentityConflict,
        ));
    }
    // Task sessions have their own canonical namespace and no parallel host
    // writer. Ordinary chats continue to use their existing store.
    let task = ledger
        .product_tasks
        .get(&receipt.root_id)
        .ok_or_else(invalid)?;
    if task.request.id != receipt.session_id {
        return Err(invalid());
    }
    let candidate: Value = serde_json::from_slice(
        &candidates
            .verify_current(
                &receipt.session_id,
                &ledger.canonical_sessions[&receipt.session_id],
            )
            .map_err(io)?,
    )
    .map_err(|_| invalid())?;
    if candidate["session"] != receipt.session_id {
        return Err(invalid());
    }
    let mut context = json!({"candidate":candidate,"message":task.request.goal,"at":at});
    let expected_revision = if let Some(record) = ledger.published_sessions.get(&receipt.session_id)
    {
        context["base"] = serde_json::from_slice(
            &publications
                .verify_current(&receipt.session_id, record)
                .map_err(io)?,
        )
        .map_err(|_| invalid())?;
        record.revision
    } else {
        0
    };
    // Include the durable candidate receipt and publication base in identity;
    // response bytes from another preparation cannot be substituted.
    let identity =
        serde_json::to_vec(&(receipt, expected_revision, &context)).map_err(|_| invalid())?;
    context["id"] = json!(format!(
        "publication-{}",
        super::canonical::digest(&identity)
    ));
    Ok(PublicationPreparation {
        candidate: receipt.clone(),
        expected_revision,
        context,
    })
}

#[cfg(test)]
pub(super) fn commit(
    store: &mut super::ControlStore,
    profile: &super::CapacityProfile,
    ledger: &mut CapacityLedger,
    publications: &CanonicalContentStore,
    proposal: PublicationProposal,
) -> Result<PublicationReceipt, ControlError> {
    let (next, receipt) = stage(ledger, publications, proposal)?;
    store.persist(&next, profile).map_err(ControlError::Store)?;
    *ledger = next;
    publications
        .cleanup(&ledger.published_sessions)
        .map_err(io)?;
    Ok(receipt)
}

pub(super) fn stage(
    ledger: &CapacityLedger,
    publications: &CanonicalContentStore,
    proposal: PublicationProposal,
) -> Result<(CapacityLedger, PublicationReceipt), ControlError> {
    let preparation = proposal.preparation;
    let digest = super::canonical::digest(&proposal.bytes);
    if let Some(receipt) = ledger.publication_receipts.get(preparation.id()) {
        return if receipt.digest == digest {
            Ok((ledger.clone(), receipt.clone()))
        } else {
            Err(invalid())
        };
    }
    current(ledger, &preparation.candidate)?;
    if ledger.publication_receipts.len() >= super::MAX_CANDIDATE_RECEIPTS
        || ledger
            .publication_receipts
            .values()
            .any(|value| value.candidate.commit_id == preparation.candidate.commit_id)
    {
        return Err(ControlError::Admission(
            AdmissionError::CandidateIdentityConflict,
        ));
    }
    let session_id = &preparation.candidate.session_id;
    let prior = ledger.published_sessions.get(session_id);
    if prior.map_or(0, |record| record.revision) != preparation.expected_revision {
        return Err(ControlError::Admission(
            AdmissionError::CanonicalRevisionConflict,
        ));
    }
    let revision = preparation
        .expected_revision
        .checked_add(1)
        .ok_or(ControlError::Store(StoreError::Corrupt))?;
    let persisted_digest = publications
        .write_candidate(session_id, revision, &proposal.bytes)
        .map_err(io)?;
    if persisted_digest != digest {
        return Err(ControlError::Store(StoreError::Corrupt));
    }
    let receipt = PublicationReceipt {
        id: preparation.id().into(),
        candidate: preparation.candidate.clone(),
        expected_revision: preparation.expected_revision,
        revision,
        digest: digest.clone(),
    };
    let mut next = ledger.clone();
    next.published_sessions.insert(
        session_id.clone(),
        CanonicalSessionRecord {
            root_id: preparation.candidate.root_id,
            revision,
            previous_revision: prior.map(|record| record.revision),
            digest,
        },
    );
    next.publication_receipts
        .insert(receipt.id.clone(), receipt.clone());
    Ok((next, receipt))
}

impl PublicationProposal {
    pub(super) fn context_id(&self) -> &str {
        self.preparation.id()
    }
}

pub(super) fn load(
    ledger: &CapacityLedger,
    store: &CanonicalContentStore,
    id: &str,
) -> Result<Option<(u64, Value)>, ControlError> {
    let Some(record) = ledger.published_sessions.get(id) else {
        return Ok(None);
    };
    let value = serde_json::from_slice(&store.verify_current(id, record).map_err(io)?)
        .map_err(|_| invalid())?;
    super::host_sessions::validate_snapshot(id, &value).map_err(ControlError::Store)?;
    Ok(Some((record.revision, value)))
}

pub(super) fn validate(ledger: &CapacityLedger) -> Result<(), StoreError> {
    if ledger.published_sessions.len() > super::MAX_ROOTS
        || ledger.publication_receipts.len() > super::MAX_CANDIDATE_RECEIPTS
    {
        return Err(StoreError::Corrupt);
    }
    let mut candidates = std::collections::BTreeSet::new();
    let mut revisions = std::collections::BTreeSet::new();
    let mut counts = std::collections::BTreeMap::<&str, u64>::new();
    for (id, receipt) in &ledger.publication_receipts {
        *counts.entry(&receipt.candidate.session_id).or_default() += 1;
        if !candidates.insert(&receipt.candidate.commit_id)
            || !revisions.insert((&receipt.candidate.session_id, receipt.revision))
            || id != &receipt.id
            || !id.strip_prefix("publication-").is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
            })
            || receipt.revision == 0
            || receipt.expected_revision.checked_add(1) != Some(receipt.revision)
            || receipt.digest.len() != 64
            || !receipt.digest.bytes().all(|b| b.is_ascii_hexdigit())
            || ledger.candidate_receipts.get(&receipt.candidate.commit_id)
                != Some(&receipt.candidate)
            || !ledger
                .product_tasks
                .contains_key(&receipt.candidate.root_id)
        {
            return Err(StoreError::Corrupt);
        }
        let selected = ledger
            .published_sessions
            .get(&receipt.candidate.session_id)
            .ok_or(StoreError::Corrupt)?;
        if receipt.revision > selected.revision || receipt.candidate.root_id != selected.root_id {
            return Err(StoreError::Corrupt);
        }
    }
    for (id, record) in &ledger.published_sessions {
        if counts.get(id.as_str()).copied() != Some(record.revision)
            || record.previous_revision
                != record
                    .revision
                    .checked_sub(1)
                    .filter(|revision| *revision > 0)
            || !ledger.publication_receipts.values().any(|receipt| {
                receipt.candidate.session_id == *id
                    && receipt.revision == record.revision
                    && receipt.digest == record.digest
            })
        {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{CapacityProfile, ControlStore};
    use super::super::{
        ControlActor, Resource, canonical::CandidateCommitRequest, tasks::TaskRequest,
    };
    use super::*;
    use std::{
        collections::BTreeMap,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    const AT: &str = "2026-10-30T00:00:00.000Z";
    struct Harness {
        data: PathBuf,
        native: PathBuf,
        profile: CapacityProfile,
        store: ControlStore,
        ledger: CapacityLedger,
        candidates: CanonicalContentStore,
        publications: CanonicalContentStore,
    }
    impl Harness {
        fn new() -> Self {
            let data = std::env::temp_dir().join(format!(
                "vak-publication-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&data).unwrap();
            let native = super::super::native_store_root(&data);
            crate::private_store::ensure_root(&native).unwrap();
            let profile = CapacityProfile::new(
                BTreeMap::from([
                    (Resource::Generation, 2),
                    (Resource::VerificationExecution, 2),
                    (Resource::ContainedProcess, 2),
                ]),
                BTreeMap::from([
                    (Resource::Generation, 1),
                    (Resource::VerificationExecution, 1),
                    (Resource::ContainedProcess, 1),
                ]),
                32,
            )
            .unwrap();
            let (store, mut ledger) =
                ControlStore::open(&native, "publication-tests", &profile).unwrap();
            let request: TaskRequest = serde_json::from_value(json!({"id":"task-publish","goal":"Keep original source amount","criteria":"Independent exact-value and interaction checks","provider":"ollama","model":"local-model","integrations":[],"confirmedFree":[],"spending":{"kind":"local_only"},"limits":{"runs":2,"modelRequests":12,"toolCalls":0,"activeMs":300000},"inputs":[],"diagnosticDays":0})).unwrap();
            super::super::tasks::create(&mut ledger, request, AT).unwrap();
            super::super::root_runs::prepare(
                &mut ledger,
                &profile,
                "task-publish",
                1,
                "native-start",
            )
            .unwrap();
            super::super::root_runs::confirm(&mut ledger, "run-1", "native-supervisor").unwrap();
            let candidates =
                CanonicalContentStore::open(&native, &ledger.canonical_sessions).unwrap();
            let publications =
                CanonicalContentStore::open_publications(&native, &ledger.published_sessions)
                    .unwrap();
            Self {
                data,
                native,
                profile,
                store,
                ledger,
                candidates,
                publications,
            }
        }
        fn actor(self) -> (ControlActor, PathBuf, PathBuf, CapacityProfile) {
            use super::super::{CanonicalStores, ControlHandle};
            use std::{
                sync::{Arc, atomic::AtomicBool, mpsc::sync_channel},
                thread,
            };
            let data = self.data.clone();
            let native = self.native.clone();
            let profile = self.profile.clone();
            let mut store = self.store;
            store.persist(&self.ledger, &self.profile).unwrap();
            let admission = super::super::WorkspaceAdmissionPolicy::new(&data).unwrap();
            let sessions = super::super::host_sessions::HostSessionStore::open(&data).unwrap();
            let (commands, receiver) = sync_channel(8);
            let handle = ControlHandle {
                commands,
                response_timeout: Duration::from_secs(2),
                candidate_in_flight: Arc::new(AtomicBool::new(false)),
                provider_in_flight: Arc::new(AtomicBool::new(false)),
            };
            let join = thread::spawn(move || {
                super::super::actor_loop(
                    receiver,
                    &mut store,
                    self.profile,
                    self.ledger,
                    admission,
                    CanonicalStores {
                        candidates: self.candidates,
                        publications: self.publications,
                    },
                    sessions,
                )
            });
            (
                ControlActor {
                    handle,
                    join: Some(join),
                },
                data,
                native,
                profile,
            )
        }
        fn candidate(&mut self, number: u64) -> CandidateCommitReceipt {
            let previous = self
                .ledger
                .published_sessions
                .get("task-publish")
                .map_or(0, |record| record.revision);
            let candidate = json!({"candidateId":format!("candidate-{number}"),"session":"task-publish","provider":"ollama","model":"local-model","result":{"stop":"end"},"reply":"Ready for review","baseVersions":if previous == 0 { json!([]) } else { json!([{"id":"amount","version":previous}]) },"surfaces":[{"id":"amount","version":number,"data":{"amount":37.5},"nodes":[{"id":"root","type":"stat","props":{"label":"Original amount","value":"{/amount}"}}]}]});
            let request = CandidateCommitRequest {
                session_id: "task-publish".into(),
                commit_id: format!("candidate-commit-{number}"),
                fence: self.ledger.roots["task-publish"].execution_fence(),
                expected_canonical_revision: self
                    .ledger
                    .canonical_sessions
                    .get("task-publish")
                    .map_or(0, |record| record.revision),
                candidate_bytes: serde_json::to_vec(&candidate).unwrap(),
            };
            super::super::commit_candidate(
                &mut self.store,
                &self.profile,
                &mut self.ledger,
                &mut self.candidates,
                request,
            )
            .unwrap()
        }
        fn prepare(&self, receipt: &CandidateCommitReceipt) -> PublicationPreparation {
            prepare(
                &self.ledger,
                &self.candidates,
                &self.publications,
                &receipt.commit_id,
                AT.into(),
            )
            .unwrap()
        }
        fn commit(
            &mut self,
            proposal: PublicationProposal,
        ) -> Result<PublicationReceipt, ControlError> {
            commit(
                &mut self.store,
                &self.profile,
                &mut self.ledger,
                &self.publications,
                proposal,
            )
        }
    }
    fn response(preparation: &PublicationPreparation) -> Value {
        // Native durability tests emulate the canonical-role response. The TS
        // tests independently exercise actual Projection semantics and IPC.
        let context = &preparation.context;
        let mut messages = context["base"]["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        messages.extend([
            json!({"role":"user","content":context["message"]}),
            json!({"role":"assistant","content":context["candidate"]["reply"]}),
        ]);
        json!({"v":2,"type":"canonical_prepared","id":preparation.id(),"snapshot":{"id":"task-publish","title":"Source amount","created":AT,"updated":context["at"],"messages":messages,"timeline":[],"surfaces":context["candidate"]["surfaces"],"external":[]}})
    }
    fn proposal(preparation: PublicationPreparation) -> PublicationProposal {
        let bytes = serde_json::to_vec(&response(&preparation)).unwrap();
        preparation.response(&bytes).unwrap()
    }

    #[test]
    fn publication_selection_is_durable_idempotent_and_separate_from_acceptance() {
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        let preparation = h.prepare(&candidate);
        let replay = proposal(h.prepare(&candidate));
        let conflict_preparation = h.prepare(&candidate);
        let mut changed = response(&conflict_preparation);
        changed["snapshot"]["title"] = json!("Changed response");
        let conflict = conflict_preparation
            .response(&serde_json::to_vec(&changed).unwrap())
            .unwrap();
        let receipt = h.commit(proposal(preparation)).unwrap();
        assert_eq!(receipt.revision, 1);
        let mut corrupt = h.ledger.clone();
        let mut duplicate = receipt.clone();
        duplicate.id = format!("publication-{}", "f".repeat(64));
        corrupt
            .publication_receipts
            .insert(duplicate.id.clone(), duplicate);
        assert_eq!(validate(&corrupt), Err(StoreError::Corrupt));
        let mut corrupt = h.ledger.clone();
        corrupt
            .published_sessions
            .get_mut("task-publish")
            .unwrap()
            .previous_revision = Some(1);
        assert_eq!(validate(&corrupt), Err(StoreError::Corrupt));
        assert_eq!(h.commit(replay).unwrap(), receipt);
        assert!(h.commit(conflict).is_err());
        assert!(
            prepare(
                &h.ledger,
                &h.candidates,
                &h.publications,
                &candidate.commit_id,
                AT.into()
            )
            .is_err()
        );
        assert_eq!(
            h.ledger.roots["task-publish"].status(),
            super::super::state::RootStatus::Running
        );
        let (_, snapshot) = load(&h.ledger, &h.publications, "task-publish")
            .unwrap()
            .unwrap();
        assert_eq!(snapshot["surfaces"][0]["data"]["amount"], json!(37.5));
        assert!(
            !h.native
                .join("host-sessions/session-task-publish.json")
                .exists()
        );
        let data = h.data.clone();
        let native = h.native.clone();
        let profile = h.profile.clone();
        drop(h);
        let actor = ControlActor::open(
            &data,
            "publication-tests",
            profile,
            8,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        handle.admit_host_session("task-publish".into()).unwrap();
        assert_eq!(
            handle.load_host_session("task-publish".into()).unwrap(),
            Some((1, snapshot))
        );
        assert_eq!(
            handle
                .read_publication_receipt(candidate.commit_id)
                .unwrap(),
            Some(receipt)
        );
        assert_eq!(handle.list_host_sessions().unwrap().len(), 1);
        assert_eq!(
            handle.release_host_session_admission("task-publish".into()),
            Err(ControlError::Admission(
                AdmissionError::HostSessionAdmissionHasData
            ))
        );
        assert_ne!(
            handle.read_root("task-publish".into()).unwrap().status(),
            super::super::state::RootStatus::Running
        );
        assert_eq!(
            handle.save_host_session("task-publish".into(), 1, json!({})),
            Err(ControlError::Admission(
                AdmissionError::TaskCapabilityUnavailable
            ))
        );
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }

    #[test]
    fn publication_refuses_response_substitution_stale_candidate_and_cancellation() {
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        for change in ["id", "goal", "surface", "authority"] {
            let preparation = h.prepare(&candidate);
            let mut frame = response(&preparation);
            match change {
                "id" => frame["id"] = json!(format!("publication-{}", "f".repeat(64))),
                "goal" => frame["snapshot"]["messages"][0]["content"] = json!("Substituted goal"),
                "surface" => frame["snapshot"]["surfaces"][0]["data"]["amount"] = json!(99),
                _ => frame["commit"] = json!(true),
            }
            assert!(
                preparation
                    .response(&serde_json::to_vec(&frame).unwrap())
                    .is_err()
            );
        }
        let stale_candidate = proposal(h.prepare(&candidate));
        h.candidate(2);
        assert!(matches!(
            h.commit(stale_candidate),
            Err(ControlError::TaskState(_))
        ));
        let preparation = prepare(
            &h.ledger,
            &h.candidates,
            &h.publications,
            "candidate-commit-2",
            AT.into(),
        )
        .unwrap();
        let proposal = proposal(preparation);
        let revision = h.ledger.roots["task-publish"].revision();
        h.ledger
            .roots
            .get_mut("task-publish")
            .unwrap()
            .stop(
                revision,
                super::super::state::RootStatus::Cancelled,
                super::super::state::StopCause::UserCancelled,
                "Cancelled by the user".into(),
            )
            .unwrap();
        assert!(matches!(
            h.commit(proposal),
            Err(ControlError::TaskState(_))
        ));
        assert!(h.ledger.published_sessions.is_empty());
        let data = h.data.clone();
        let native = h.native.clone();
        drop(h);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }

    #[test]
    fn failed_pointer_selection_keeps_previous_snapshot_and_recovers_orphan_bytes() {
        let mut h = Harness::new();
        let first = h.candidate(1);
        h.commit(proposal(h.prepare(&first))).unwrap();
        let (_, original) = load(&h.ledger, &h.publications, "task-publish")
            .unwrap()
            .unwrap();
        let second = h.candidate(2);
        let preparation = h.prepare(&second);
        assert_eq!(preparation.context["base"], original);
        let pending = proposal(preparation);
        let pointer = h.native.join("control/current");
        let selected = fs::read(&pointer).unwrap();
        fs::remove_file(&pointer).unwrap();
        fs::create_dir(&pointer).unwrap();
        assert!(matches!(h.commit(pending), Err(ControlError::Store(_))));
        assert_eq!(
            load(&h.ledger, &h.publications, "task-publish").unwrap(),
            Some((1, original.clone()))
        );
        assert_eq!(h.ledger.publication_receipts.len(), 1);
        fs::remove_dir(&pointer).unwrap();
        fs::write(&pointer, selected).unwrap();
        let orphan = h
            .native
            .join("content/publications/task-publish/generation-00000000000000000002.json");
        assert!(orphan.exists());
        let data = h.data.clone();
        let native = h.native.clone();
        let profile = h.profile.clone();
        drop(h);
        let actor = ControlActor::open(
            &data,
            "publication-tests",
            profile,
            8,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        handle.admit_host_session("task-publish".into()).unwrap();
        assert_eq!(
            handle.load_host_session("task-publish".into()).unwrap(),
            Some((1, original))
        );
        assert_eq!(
            handle.read_publication_receipt(second.commit_id).unwrap(),
            None
        );
        assert!(!orphan.exists());
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }
    #[cfg(unix)]
    fn cleanup_record(
        invocation: &super::super::canonical_runs::Invocation,
        code: i32,
        verified: bool,
    ) {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&invocation.worker.completion_record)
            .unwrap();
        file.write_all(&serde_json::to_vec(&json!({"version":1,"invocation_id":invocation.id(),"cleanup_verified":verified,"exit_code":code})).unwrap()).unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn canonical_holds_need_exact_cleanup_and_never_publish_after_restart() {
        use super::super::{canonical_runs::Outcome, root_runs::RunStatus};
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        let (actor, data, native, profile) = h.actor();
        let handle = actor.handle();
        let first = handle.admit_canonical(candidate.commit_id.clone()).unwrap();
        assert!(handle.admit_canonical(candidate.commit_id.clone()).is_err());
        let lease = handle
            .reserve(
                first.id().into(),
                "task-publish".into(),
                BTreeMap::from([
                    (Resource::VerificationExecution, 1),
                    (Resource::ContainedProcess, 1),
                ]),
            )
            .unwrap();
        assert_eq!(
            handle.release(lease),
            Err(ControlError::Admission(AdmissionError::ReservedForControl(
                Resource::VerificationExecution
            )))
        );
        let cancelled_launch = handle
            .abandon_canonical_before_spawn(first.id().into())
            .unwrap();
        assert_eq!(cancelled_launch.outcome, Some(Outcome::NotLaunched));
        let second = handle.admit_canonical(candidate.commit_id.clone()).unwrap();
        let id = second.id().to_owned();
        handle
            .confirm_canonical_started(id.clone(), "canonical-test-supervisor".into())
            .unwrap();
        assert!(handle.abandon_canonical_before_spawn(id.clone()).is_err());
        assert!(handle.finish_canonical(id.clone(), None).is_err());
        cleanup_record(&second, 0, false);
        assert!(handle.finish_canonical(id.clone(), None).is_err());
        assert_eq!(
            handle.read_canonical_run(id.clone()).unwrap().status,
            RunStatus::Running
        );
        drop(actor);
        let actor = ControlActor::open(
            &data,
            "publication-tests",
            profile,
            8,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle.read_canonical_run(id.clone()).unwrap().status,
            RunStatus::Interrupted
        );
        assert!(handle.admit_canonical(candidate.commit_id.clone()).is_err());
        cleanup_record(&second, 0, true);
        let settled = handle.finish_canonical(id.clone(), None).unwrap();
        assert_eq!(settled.status, RunStatus::Settled);
        assert_eq!(settled.outcome, Some(Outcome::Rejected));
        assert_eq!(handle.finish_canonical(id, None).unwrap(), settled);
        assert_eq!(
            handle
                .read_publication_receipt(candidate.commit_id)
                .unwrap(),
            None
        );
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[ignore = "requires reviewed helper, Node and resources/canonical-worker.mjs"]
    fn contained_canonical_supervisor_publishes_only_after_protected_cleanup() {
        use super::super::canonical_runs::Outcome;
        use std::sync::atomic::AtomicBool;
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        let (actor, data, native, profile) = h.actor();
        let handle = actor.handle();
        let resources = data.with_extension("canonical-runtime");
        fs::create_dir(&resources).unwrap();
        fs::copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/canonical-worker.mjs"),
            resources.join("canonical-worker.mjs"),
        )
        .unwrap();
        let helper = PathBuf::from(
            std::env::var_os("VAK_TEST_WORKER_HELPER").expect("reviewed helper required"),
        );
        let node = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_NODE").expect("Node required"));
        assert!(
            crate::canonical_supervisor::run(
                &handle,
                crate::canonical_supervisor::Runtime {
                    helper: &helper,
                    node: &node,
                    resources: &resources,
                    data: &data
                },
                candidate.commit_id.clone(),
                &AtomicBool::new(true)
            )
            .is_err()
        );
        assert_eq!(
            handle
                .read_canonical_run("canonical-2".into())
                .unwrap()
                .outcome,
            Some(Outcome::NotLaunched)
        );
        let run = crate::canonical_supervisor::run(
            &handle,
            crate::canonical_supervisor::Runtime {
                helper: &helper,
                node: &node,
                resources: &resources,
                data: &data,
            },
            candidate.commit_id.clone(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(
            matches!(run.outcome, Some(Outcome::Published { .. })),
            "{run:?}"
        );
        assert_eq!(run.exit_code, Some(0));
        let receipt = handle
            .read_publication_receipt(candidate.commit_id.clone())
            .unwrap()
            .unwrap();
        handle.admit_host_session("task-publish".into()).unwrap();
        let (_, snapshot) = handle
            .load_host_session("task-publish".into())
            .unwrap()
            .unwrap();
        assert_eq!(snapshot["surfaces"][0]["data"]["amount"], json!(37.5));
        assert_eq!(
            handle.read_root("task-publish".into()).unwrap().status(),
            super::super::state::RootStatus::Running
        );
        let scratch = data.join("canonical-workers").join(&run.id);
        assert!(scratch.is_dir());
        assert!(!data.join("worker").exists());
        assert!(!scratch.join("sessions").exists());
        assert!(!scratch.join("profiles.json").exists());
        // Each resource was returned by the same generation selecting publication.
        let lease = handle
            .reserve(
                "capacity-after-canonical".into(),
                "task-publish".into(),
                BTreeMap::from([
                    (Resource::VerificationExecution, 1),
                    (Resource::ContainedProcess, 1),
                ]),
            )
            .unwrap();
        handle.release(lease).unwrap();
        drop(actor);
        let actor = ControlActor::open(
            &data,
            "publication-tests",
            profile,
            8,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        assert_eq!(handle.read_canonical_run(run.id.clone()).unwrap(), run);
        assert_eq!(
            handle
                .read_publication_receipt(candidate.commit_id)
                .unwrap(),
            Some(receipt)
        );
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
        fs::remove_dir_all(resources).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn canonical_cleanup_releases_holds_but_cancelled_fence_refuses_publication() {
        use super::super::canonical_runs::{self, Outcome};
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        let invocation = canonical_runs::admit(
            &mut h.ledger,
            &h.profile,
            &h.candidates,
            &h.publications,
            &h.native,
            &candidate.commit_id,
        )
        .unwrap();
        let id = invocation.id().to_owned();
        let mut cancelled_before_start = h.ledger.clone();
        let root = cancelled_before_start
            .roots
            .get_mut("task-publish")
            .unwrap();
        root.stop(
            root.revision(),
            super::super::state::RootStatus::Cancelled,
            super::super::state::StopCause::UserCancelled,
            "Cancelled before canonical start".into(),
        )
        .unwrap();
        assert!(
            canonical_runs::confirm(
                &mut cancelled_before_start,
                &id,
                "stale-canonical-supervisor"
            )
            .is_err()
        );
        canonical_runs::confirm(&mut h.ledger, &id, "canonical-supervisor").unwrap();
        let mut frame = response(&h.prepare(&candidate));
        frame["id"] = invocation.frame()["context"]["id"].clone();
        frame["snapshot"]["updated"] = invocation.frame()["context"]["at"].clone();
        cleanup_record(&invocation, 0, true);
        let proposal = invocation
            .response(&serde_json::to_vec(&frame).unwrap())
            .unwrap();
        let root = h.ledger.roots.get_mut("task-publish").unwrap();
        root.stop(
            root.revision(),
            super::super::state::RootStatus::Cancelled,
            super::super::state::StopCause::UserCancelled,
            "Cancelled".into(),
        )
        .unwrap();
        let result = canonical_runs::finish(
            &mut h.ledger,
            &h.publications,
            &h.native,
            &id,
            Some(proposal),
        )
        .unwrap();
        assert_eq!(result.outcome, Some(Outcome::Rejected));
        h.store.persist(&h.ledger, &h.profile).unwrap();
        assert!(h.ledger.published_sessions.is_empty());
        assert!(!h.ledger.active.contains_key(&result.lease_id));
        let data = h.data.clone();
        let native = h.native.clone();
        drop(h);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn failed_canonical_selection_preserves_holds_and_never_replays_prepared_output() {
        use super::super::{canonical_runs::Outcome, root_runs::RunStatus};
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        let seed = h.prepare(&candidate);
        let (actor, data, native, profile) = h.actor();
        let handle = actor.handle();
        let invocation = handle.admit_canonical(candidate.commit_id.clone()).unwrap();
        let id = invocation.id().to_owned();
        handle
            .confirm_canonical_started(id.clone(), "canonical-failure-supervisor".into())
            .unwrap();
        let mut frame = response(&seed);
        frame["id"] = invocation.frame()["context"]["id"].clone();
        frame["snapshot"]["updated"] = invocation.frame()["context"]["at"].clone();
        cleanup_record(&invocation, 0, true);
        let proposal = invocation
            .response(&serde_json::to_vec(&frame).unwrap())
            .unwrap();
        let pointer = native.join("control/current");
        let selected = fs::read(&pointer).unwrap();
        fs::remove_file(&pointer).unwrap();
        fs::create_dir(&pointer).unwrap();
        assert!(matches!(
            handle.finish_canonical(id.clone(), Some(proposal)),
            Err(ControlError::Store(_))
        ));
        drop(actor);
        fs::remove_dir(&pointer).unwrap();
        fs::write(&pointer, selected).unwrap();
        let actor = ControlActor::open(
            &data,
            "publication-tests",
            profile,
            8,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle.read_canonical_run(id.clone()).unwrap().status,
            RunStatus::Interrupted
        );
        assert_eq!(
            handle
                .read_publication_receipt(candidate.commit_id)
                .unwrap(),
            None
        );
        assert!(
            !native
                .join("content/publications/task-publish/generation-00000000000000000001.json")
                .exists()
        );
        let result = handle.finish_canonical(id, None).unwrap();
        assert_eq!(result.outcome, Some(Outcome::Rejected));
        assert_eq!(
            handle.finish_canonical(result.id.clone(), None).unwrap(),
            result
        );
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[ignore = "requires reviewed helper and Node paths"]
    fn hostile_canonical_role_has_no_ambient_authority_and_cancels_with_cleanup() {
        use super::super::canonical_runs::Outcome;
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let mut h = Harness::new();
        let candidate = h.candidate(1);
        let (actor, data, native, _) = h.actor();
        let handle = actor.handle();
        fs::create_dir(data.join("worker")).unwrap();
        fs::write(data.join("worker/private"), b"app-private").unwrap();
        fs::create_dir_all(data.join("task-workers/other")).unwrap();
        fs::write(data.join("task-workers/other/private"), b"sibling-private").unwrap();
        let resources = data.with_extension("hostile-canonical");
        fs::create_dir(&resources).unwrap();
        let source = r#"import {Socket, createConnection} from 'node:net';
import {readFileSync, writeFileSync} from 'node:fs';
const channel = new Socket({fd:3, readable:true, writable:true}); channel.setEncoding('utf8');
channel.write(JSON.stringify({v:2,type:'canonical_ready'})+'\n');
let raw='', started=false;
channel.on('data', chunk => { raw+=chunk; if(started||!raw.includes('\n'))return; started=true;
const denied=path=>{try{readFileSync(path);return false;}catch(error){return ['EPERM','EACCES'].includes(error.code);}};
let safe=denied(__NATIVE__)&&denied(__APP__)&&denied(__SIBLING__)&&!process.env.VAK_NPM_CLI&&!process.env.VAK_SANDBOX_BIN;
try{writeFileSync(__OUTSIDE__,'escaped');safe=false;}catch(error){safe=safe&&['EPERM','EACCES'].includes(error.code);}
let done=false; function finish(blocked){if(done)return;done=true;clearTimeout(timer);safe=safe&&blocked;writeFileSync(process.env.VAK_DATA_DIR+'/positive',safe?'contained':'escaped');channel.write(JSON.stringify({v:2,type:'provider_request',id:'forged'})+'\n',()=>process.exit(safe?0:13));}
const timer=setTimeout(()=>finish(false),1000);
try{const socket=createConnection({host:'127.0.0.1',port:9});socket.on('error',error=>finish(['EPERM','EACCES'].includes(error.code)));socket.on('connect',()=>{socket.destroy();finish(false);});}catch(error){finish(['EPERM','EACCES'].includes(error.code));}
});"#;
        let source = source
            .replace(
                "__NATIVE__",
                &serde_json::to_string(&native.join("control/current")).unwrap(),
            )
            .replace(
                "__APP__",
                &serde_json::to_string(&data.join("worker/private")).unwrap(),
            )
            .replace(
                "__SIBLING__",
                &serde_json::to_string(&data.join("task-workers/other/private")).unwrap(),
            )
            .replace(
                "__OUTSIDE__",
                &serde_json::to_string(&data.join("outside-write")).unwrap(),
            );
        fs::write(resources.join("canonical-worker.mjs"), source).unwrap();
        let helper = PathBuf::from(
            std::env::var_os("VAK_TEST_WORKER_HELPER").expect("reviewed helper required"),
        );
        let node = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_NODE").expect("Node required"));
        let run = crate::canonical_supervisor::run(
            &handle,
            crate::canonical_supervisor::Runtime {
                helper: &helper,
                node: &node,
                resources: &resources,
                data: &data,
            },
            candidate.commit_id.clone(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(run.outcome, Some(Outcome::Rejected));
        assert_eq!(run.exit_code, Some(0));
        assert_eq!(
            fs::read(data.join("canonical-workers").join(run.id).join("positive")).unwrap(),
            b"contained"
        );
        assert!(!data.join("outside-write").exists());
        assert_eq!(
            handle
                .read_publication_receipt(candidate.commit_id.clone())
                .unwrap(),
            None
        );
        fs::write(resources.join("canonical-worker.mjs"), "import {Socket} from 'node:net'; const channel=new Socket({fd:3,readable:true,writable:true}); channel.write(JSON.stringify({v:2,type:'canonical_ready'})+'\\n'); channel.on('data',()=>{});channel.on('end',()=>setInterval(()=>{},1000));").unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            signal.store(true, Ordering::Release);
        });
        let start = std::time::Instant::now();
        let cancelled = crate::canonical_supervisor::run(
            &handle,
            crate::canonical_supervisor::Runtime {
                helper: &helper,
                node: &node,
                resources: &resources,
                data: &data,
            },
            candidate.commit_id.clone(),
            &cancel,
        )
        .unwrap();
        trigger.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(8));
        assert!(matches!(
            cancelled.outcome,
            Some(Outcome::Rejected | Outcome::WorkerFailed)
        ));
        assert!(cancelled.exit_receipt.is_some());
        assert_eq!(
            handle
                .read_publication_receipt(candidate.commit_id)
                .unwrap(),
            None
        );
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
        fs::remove_dir_all(resources).unwrap();
    }
    #[test]
    fn canonical_admission_shares_global_capacity_across_independent_jobs() {
        use super::super::{canonical_runs::Outcome, tasks};
        let mut h = Harness::new();
        h.profile = CapacityProfile::new(
            BTreeMap::from([
                (Resource::Generation, 3),
                (Resource::VerificationExecution, 2),
                (Resource::ContainedProcess, 2),
            ]),
            BTreeMap::from([
                (Resource::Generation, 1),
                (Resource::VerificationExecution, 1),
                (Resource::ContainedProcess, 1),
            ]),
            32,
        )
        .unwrap();
        let first = h.candidate(1);
        let template = h.ledger.product_tasks["task-publish"].request.clone();
        for (id, commit_id) in [
            ("task-second", "second-commit"),
            ("task-third", "third-commit"),
        ] {
            let mut request = template.clone();
            request.id = id.into();
            tasks::create(&mut h.ledger, request, AT).unwrap();
            super::super::root_runs::prepare(
                &mut h.ledger,
                &h.profile,
                id,
                1,
                &format!("start-{id}"),
            )
            .unwrap();
            let run = h
                .ledger
                .root_runs
                .values()
                .find(|run| run.root_id == id)
                .unwrap()
                .id
                .clone();
            super::super::root_runs::confirm(&mut h.ledger, &run, &format!("supervisor-{id}"))
                .unwrap();
            let original = h
                .candidates
                .verify_current("task-publish", &h.ledger.canonical_sessions["task-publish"])
                .unwrap();
            let mut candidate: Value = serde_json::from_slice(&original).unwrap();
            candidate["session"] = json!(id);
            let request = CandidateCommitRequest {
                session_id: id.into(),
                commit_id: commit_id.into(),
                fence: h.ledger.roots[id].execution_fence(),
                expected_canonical_revision: 0,
                candidate_bytes: serde_json::to_vec(&candidate).unwrap(),
            };
            super::super::commit_candidate(
                &mut h.store,
                &h.profile,
                &mut h.ledger,
                &mut h.candidates,
                request,
            )
            .unwrap();
        }
        let (actor, data, native, _) = h.actor();
        let handle = actor.handle();
        // The actor knows a dropped reply never delivered its sole launch
        // object, so it can settle this particular pre-spawn hold safely.
        let (reply, receiver) = std::sync::mpsc::sync_channel(1);
        drop(receiver);
        handle
            .commands
            .send(super::super::ActorCommand::AdmitCanonical {
                commit_id: first.commit_id.clone(),
                reply,
            })
            .unwrap();
        assert_eq!(
            handle
                .read_canonical_run("canonical-4".into())
                .unwrap()
                .outcome,
            Some(Outcome::NotLaunched)
        );
        let first = handle.admit_canonical(first.commit_id).unwrap();
        let second = handle.admit_canonical("second-commit".into()).unwrap();
        assert!(matches!(
            handle.admit_canonical("third-commit".into()),
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::VerificationExecution)
            ))
        ));
        handle
            .abandon_canonical_before_spawn(first.id().into())
            .unwrap();
        let third = handle.admit_canonical("third-commit".into()).unwrap();
        assert_ne!(third.id(), first.id());
        assert_eq!(
            handle
                .read_canonical_run(second.id().into())
                .unwrap()
                .status,
            super::super::root_runs::RunStatus::Prepared
        );
        for invocation in [second, third] {
            assert_eq!(
                handle
                    .abandon_canonical_before_spawn(invocation.id().into())
                    .unwrap()
                    .outcome,
                Some(Outcome::NotLaunched)
            );
        }
        drop(actor);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(native).unwrap();
    }
}
