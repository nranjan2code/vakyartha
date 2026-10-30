use super::tests::{body, cleanup, data, profile, start};
use super::*;
use crate::control::{ControlActor, RootMutation};
use std::{fs, sync::mpsc::sync_channel};

#[test]
fn trusted_consent_delivers_one_native_permit_and_never_serializes_it() {
    let data = data();
    let actor =
        ControlActor::open(&data, "consent", profile(), 16, Duration::from_secs(2)).unwrap();
    let handle = actor.handle();
    let run = start(&handle, "root", 1);
    let mut payload: serde_json::Value = serde_json::from_slice(&body()).unwrap();
    payload["messages"][0]["content"] =
        json!(format!("private-request-marker{}", "😀".repeat(3000)));
    let bytes = serde_json::to_vec(&payload).unwrap();
    let mut wait = handle
        .request_provider_consent(run.clone(), "ui-request".into(), 0, bytes.clone())
        .unwrap();
    let approval = wait.approval().clone();
    assert!(!approval.disclosure.preview.contains('\u{fffd}'));
    assert!(wait.try_decision().is_none());
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        0
    );
    let views = handle.list_provider_consents().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].root_id, "root");
    assert_eq!(views[0].session_id, "session-root");
    assert!(
        handle
            .decide_provider_approval(
                approval.ticket_id.clone(),
                approval.fingerprint.clone(),
                Decision::AllowOnce
            )
            .is_err(),
        "test controller cannot take a UI-owned ticket"
    );
    assert!(
        handle
            .decide_provider_consent(
                approval.ticket_id.clone(),
                "f".repeat(64),
                Decision::AllowOnce
            )
            .is_err()
    );
    assert_eq!(handle.list_provider_consents().unwrap().len(), 1);
    let mut offset = 0;
    let mut exact = Vec::new();
    loop {
        let page = handle
            .read_provider_consent(
                approval.ticket_id.clone(),
                approval.fingerprint.clone(),
                offset,
            )
            .unwrap();
        assert!(page.text.len() <= 4096);
        assert_eq!(page.offset, offset);
        exact.extend_from_slice(page.text.as_bytes());
        offset = page.next;
        if offset == page.total {
            break;
        }
    }
    let root = handle.read_root("root".into()).unwrap();
    assert_eq!(
        exact,
        prepare_generation_body(&permit(&root).unwrap(), &bytes).unwrap()
    );
    let mut joins = Vec::new();
    for _ in 0..4 {
        let h = handle.clone();
        let a = approval.clone();
        joins.push(std::thread::spawn(move || {
            h.decide_provider_consent(a.ticket_id, a.fingerprint, Decision::AllowOnce)
        }));
    }
    let receipts: Vec<_> = joins
        .into_iter()
        .filter_map(|join| join.join().unwrap().ok())
        .collect();
    assert_eq!(receipts.len(), 4);
    assert!(
        receipts.iter().all(|receipt| receipt.state == "allowed"
            && receipt.operation_id == receipts[0].operation_id)
    );
    assert_eq!(receipts[0].state, "allowed");
    let serialized = serde_json::to_string(&receipts[0]).unwrap();
    assert!(!serialized.contains("private-request-marker"));
    assert!(!serialized.contains("permit"));
    let dispatch = wait.try_decision().unwrap().unwrap();
    assert!(wait.try_decision().is_none());
    let (operation, _, approved) = dispatch.into_request();
    assert_eq!(approved, exact);
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        1
    );
    assert!(handle.list_provider_consents().unwrap().is_empty());
    handle
        .settle_provider_operation(
            operation.id,
            ResultReceipt {
                id: "not-sent-by-test".into(),
                outcome: IoOutcome::NotDispatched,
                status_code: None,
                response_bytes: 0,
            },
        )
        .unwrap();
    let mut over_budget = handle
        .request_provider_consent(run, "over-budget-ui".into(), 0, body())
        .unwrap();
    let ticket = over_budget.approval().clone();
    assert_eq!(
        handle
            .decide_provider_consent(ticket.ticket_id, ticket.fingerprint, Decision::AllowOnce)
            .unwrap()
            .state,
        "refused"
    );
    assert!(matches!(
        over_budget.try_decision(),
        Some(Err(ConsentRejection::Refused))
    ));
    assert_eq!(
        handle.read_root("root".into()).unwrap().status(),
        RootStatus::LimitReached
    );
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        1
    );
    drop(over_budget);
    drop(wait);
    drop(actor);
    cleanup(&data);
}

#[test]
fn deny_drop_cancel_expiry_and_restart_cannot_authorize_egress() {
    let data = data();
    let actor =
        ControlActor::open(&data, "consent", profile(), 16, Duration::from_secs(2)).unwrap();
    let handle = actor.handle();
    let run = start(&handle, "root", 2);
    let mut denied = handle
        .request_provider_consent(run.clone(), "deny".into(), 0, body())
        .unwrap();
    let a = denied.approval().clone();
    assert_eq!(
        handle
            .decide_provider_consent(a.ticket_id.clone(), a.fingerprint.clone(), Decision::Deny)
            .unwrap()
            .state,
        "denied"
    );
    assert!(matches!(
        denied.try_decision(),
        Some(Err(ConsentRejection::Denied))
    ));
    let denied_identity = a.clone();
    assert!(
        handle
            .request_provider_consent(run.clone(), "deny".into(), 0, body())
            .is_err()
    );
    let dropped = handle
        .request_provider_consent(run.clone(), "dropped".into(), 0, body())
        .unwrap();
    drop(dropped);
    assert!(handle.list_provider_consents().unwrap().is_empty());
    let mut cancelled = handle
        .request_provider_consent(run, "cancel".into(), 0, body())
        .unwrap();
    let a = cancelled.approval().clone();
    let root = handle.read_root("root".into()).unwrap();
    handle
        .mutate_root(
            "root".into(),
            root.revision(),
            RootMutation::Stop {
                status: RootStatus::Cancelled,
                cause: super::super::state::StopCause::UserCancelled,
                reason: "Cancel waiting permission".into(),
            },
        )
        .unwrap();
    assert!(handle.list_provider_consents().unwrap().is_empty());
    assert!(matches!(
        cancelled.try_decision(),
        Some(Err(ConsentRejection::Cancelled))
    ));
    assert!(
        handle
            .decide_provider_consent(a.ticket_id, a.fingerprint, Decision::AllowOnce)
            .is_err()
    );
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        0
    );
    let second = start(&handle, "second", 1);
    let mut stopped = handle
        .request_provider_consent(second, "restart".into(), 0, body())
        .unwrap();
    drop(actor);
    assert!(matches!(
        stopped.try_decision(),
        Some(Err(ConsentRejection::Unavailable))
    ));
    let actor =
        ControlActor::open(&data, "consent", profile(), 16, Duration::from_secs(2)).unwrap();
    assert!(actor.handle().list_provider_consents().unwrap().is_empty());
    assert_eq!(
        actor
            .handle()
            .decide_provider_consent(
                denied_identity.ticket_id.clone(),
                denied_identity.fingerprint.clone(),
                Decision::Deny
            )
            .unwrap()
            .state,
        "denied"
    );
    assert!(
        actor
            .handle()
            .decide_provider_consent(
                denied_identity.ticket_id.clone(),
                denied_identity.fingerprint.clone(),
                Decision::AllowOnce
            )
            .is_err()
    );
    assert!(
        actor
            .handle()
            .read_provider_consent(denied_identity.ticket_id, denied_identity.fingerprint, 0)
            .is_err()
    );

    drop(actor);
    cleanup(&data);
    // TTL uses a monotonic clock. Exercise the owning registry directly so a
    // five-minute timeout does not turn this into a wall-clock sleep test.
    let mut ledger = CapacityLedger::default();
    let request = super::tests::request("ttl", 1);
    let root = super::super::state::RootTask::create_with_grant(request, None).unwrap();
    ledger.roots.insert("ttl".into(), root);
    super::super::root_runs::prepare(&mut ledger, &profile(), "ttl", 1, "start-ttl").unwrap();
    super::super::root_runs::confirm(&mut ledger, "run-1", "supervisor-ttl").unwrap();
    let mut approvals = Approvals::default();
    let a = approvals
        .issue(&ledger, "run-1".into(), "ttl".into(), 0, body())
        .unwrap();
    let (reply, response) = sync_channel(1);
    approvals
        .attach(
            &a,
            Delivery {
                reply,
                closed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                approval: None,
            },
        )
        .unwrap();
    approvals.pending.get_mut(&a.ticket_id).unwrap().created = Instant::now() - APPROVAL_TTL;
    approvals.prune(&ledger);
    assert!(matches!(
        response.try_recv(),
        Ok(Err(ConsentRejection::Expired))
    ));
    assert!(approvals.views(&ledger).is_empty());
}

#[test]
fn failed_consent_selection_sends_no_permit_and_keeps_budget_unselected() {
    let data = data();
    let actor =
        ControlActor::open(&data, "consent", profile(), 16, Duration::from_secs(2)).unwrap();
    let handle = actor.handle();
    let run = start(&handle, "root", 1);
    let mut wait = handle
        .request_provider_consent(run, "failure".into(), 0, body())
        .unwrap();
    let a = wait.approval().clone();
    let pointer = super::super::native_store_root(&data).join("control/current");
    let selected = fs::read(&pointer).unwrap();
    fs::remove_file(&pointer).unwrap();
    fs::create_dir(&pointer).unwrap();
    assert!(matches!(
        handle.decide_provider_consent(a.ticket_id, a.fingerprint, Decision::AllowOnce),
        Err(ControlError::Store(_))
    ));
    assert!(matches!(
        wait.try_decision(),
        Some(Err(ConsentRejection::Unavailable))
    ));
    drop(actor);
    fs::remove_dir(&pointer).unwrap();
    fs::write(&pointer, selected).unwrap();
    let actor =
        ControlActor::open(&data, "consent", profile(), 16, Duration::from_secs(2)).unwrap();
    assert_eq!(
        actor
            .handle()
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        0
    );
    assert!(actor.handle().list_provider_consents().unwrap().is_empty());
    drop(actor);
    cleanup(&data);
}

#[test]
fn undelivered_permit_settles_capacity_without_refunding_committed_request() {
    use crate::control::{ActorCommand, Resource};
    use std::sync::{Arc, atomic::AtomicBool};
    let data = data();
    let actor =
        ControlActor::open(&data, "consent", profile(), 16, Duration::from_secs(2)).unwrap();
    let handle = actor.handle();
    let run = start(&handle, "root", 3);
    for full in [false, true] {
        // Model a receiver disappearing after the actor's liveness check, or
        // a nonempty receiver that cannot accept the sole dispatch object.
        let (delivery, receiver) = sync_channel(1);
        let receiver = if full {
            delivery.send(Err(ConsentRejection::Cancelled)).unwrap();
            Some(receiver)
        } else {
            drop(receiver);
            None
        };
        let (reply, response) = sync_channel(1);
        handle
            .commands
            .send(ActorCommand::IssueProviderApproval {
                run_id: run.clone(),
                operation_id: format!("undelivered-{full}"),
                attempt: 0,
                body: body(),
                delivery: Some(Delivery {
                    reply: delivery,
                    closed: Arc::new(AtomicBool::new(false)),
                    approval: None,
                }),
                in_flight: Arc::new(AtomicBool::new(true)),
                reply,
            })
            .unwrap();
        let approval = response
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let receipt = handle
            .decide_provider_consent(
                approval.ticket_id,
                approval.fingerprint,
                Decision::AllowOnce,
            )
            .unwrap();
        assert_eq!(receipt.state, "cancelled");
        let record = handle
            .read_provider_operation(receipt.operation_id.unwrap())
            .unwrap();
        assert_eq!(record.receipt.unwrap().outcome, IoOutcome::NotDispatched);
        assert!(!record.io_started);
        if let Some(receiver) = receiver {
            assert!(matches!(
                receiver.try_recv(),
                Ok(Err(ConsentRejection::Cancelled))
            ));
            assert!(receiver.try_recv().is_err());
        }
        let slot = handle
            .reserve(
                format!("capacity-after-{full}"),
                "root".into(),
                BTreeMap::from([(Resource::ProviderRequest, 1)]),
            )
            .unwrap();
        handle.release(slot).unwrap();
    }
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        2
    );
    drop(actor);
    cleanup(&data);
}
