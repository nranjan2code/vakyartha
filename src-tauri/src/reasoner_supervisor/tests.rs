use super::*;
use crate::control::{
    CapacityProfile, ControlActor, Resource, RootMutation,
    canonical::CandidateCommitRequest,
    delegation::{DelegationMode, DelegationPolicy},
    generation::Decision,
    state::{BudgetLimits, LocalModelPolicy, Requirement, RootCreate, StopCause},
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::mpsc::sync_channel,
    thread,
};

#[test]
fn standard_base64_padding_and_chunks() {
    for (bytes, encoded) in [
        (b"".as_slice(), ""),
        (b"f", "Zg=="),
        (b"fo", "Zm8="),
        (b"foo", "Zm9v"),
        (b"foobar", "Zm9vYmFy"),
        (&[0, 255, 128], "AP+A"),
    ] {
        assert_eq!(base64(bytes), encoded);
    }
}

struct Harness {
    data: PathBuf,
    resources: PathBuf,
    actor: Option<ControlActor>,
    helper: PathBuf,
    node: PathBuf,
}
impl Harness {
    fn new() -> Self {
        let helper = PathBuf::from(
            std::env::var_os("VAK_TEST_WORKER_HELPER").expect("reviewed helper required"),
        );
        let node = PathBuf::from(std::env::var_os("VAK_TEST_WORKER_NODE").expect("Node required"));
        let data = std::env::temp_dir().join(format!(
            "vak-reasoner-driver-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data).unwrap();
        let resources = data.with_extension("runtime");
        fs::create_dir_all(&resources).unwrap();
        for name in ["task-worker.mjs", "canonical-worker.mjs"] {
            fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("resources")
                    .join(name),
                resources.join(name),
            )
            .expect("bundle runtime before this gate");
        }
        let amounts = BTreeMap::from([
            (Resource::Generation, 1),
            (Resource::ContainedProcess, 1),
            (Resource::ProviderRequest, 1),
            (Resource::VerificationExecution, 1),
        ]);
        let actor = ControlActor::open(
            &data,
            "driver-test",
            CapacityProfile::new(amounts.clone(), amounts, 128).unwrap(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        Self {
            data,
            resources,
            actor: Some(actor),
            helper,
            node,
        }
    }
    fn handle(&self) -> ControlHandle {
        self.actor.as_ref().unwrap().handle()
    }
    fn product_root(&self) -> String {
        let request = serde_json::from_value(json!({"id":"root","goal":"Prepare independent price views","criteria":"Preserve original numeric facts","provider":"ollama","model":"local-model","integrations":[],"confirmedFree":[],"spending":{"kind":"local_only"},"limits":{"runs":2,"modelRequests":4,"toolCalls":0,"activeMs":10000},"inputs":[{"name":"prices.csv","content":"price\n37.5\n"}],"diagnosticDays":0})).unwrap();
        self.handle()
            .product_task(crate::control::tasks::TaskCommand::Create {
                request: Box::new(request),
            })
            .unwrap();
        self.handle()
            .admit_product_run("root".into(), 1, "start-root".into())
            .unwrap()
            .id
    }
    fn root(&self, name: &str) -> String {
        let control = self.handle();
        let root = control
            .create_root_with_budget(RootCreate {
                id: name.into(),
                session_id: Some(format!("session-{name}")),
                local_model: Some(LocalModelPolicy {
                    model: "local-model".into(),
                    max_output_tokens: 1024,
                    max_request_bytes: 8_388_608,
                }),
                goal: "Prepare independent price views".into(),
                criteria: "Preserve original numeric facts".into(),
                run_limit: 2,
                budget_limits: BudgetLimits::new(4, 0).unwrap(),
                requirements: vec![Requirement::new("source-check".into(), true).unwrap()],
                delegation: DelegationPolicy::new(DelegationMode::Disabled, 0).unwrap(),
            })
            .unwrap();
        control
            .mutate_root(
                name.into(),
                root.revision(),
                RootMutation::StartAttempt {
                    request_id: format!("start-{name}"),
                },
            )
            .unwrap();
        control
            .read_root_run_for_start(format!("start-{name}"))
            .unwrap()
            .id
    }
    fn runtime(&self) -> Runtime<'_> {
        Runtime {
            helper: &self.helper,
            node: &self.node,
            resources: &self.resources,
            data: &self.data,
            service: "no-local-vault",
        }
    }
    fn context() -> Context {
        Context {
            instructions: String::new(),
            inputs: vec![InputFile {
                name: "prices.csv".into(),
                content: "price\n37.5\n".into(),
            }],
            initial_surfaces: vec![],
            max_steps: 2,
            active_ms: 10_000,
        }
    }
}
use std::time::SystemTime;
impl Drop for Harness {
    fn drop(&mut self) {
        drop(self.actor.take());
        let _ = fs::remove_dir_all(&self.resources);
        let _ = fs::remove_dir_all(crate::private_store::root(&self.data));
        let _ = fs::remove_dir_all(&self.data);
    }
}
fn poll<T>(mut f: impl FnMut() -> Option<T>) -> T {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(value) = f() {
            return value;
        }
        assert!(Instant::now() < until, "bounded supervisor response");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "requires reviewed helper, Node and packaged task/canonical workers"]
fn native_driver_consent_stream_cleanup_and_canonical_publication() {
    let h = Harness::new();
    let handle = h.handle();
    let run_id = h.product_root();
    let mut changed = Harness::context();
    changed.inputs[0].content = "price\n99\n".into();
    assert!(
        run(
            &handle,
            h.runtime(),
            run_id.clone(),
            changed,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        handle
            .read_root_run(run_id.clone())
            .unwrap()
            .worker_lease_id
            .is_none()
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = reqwest::Url::parse(&format!(
        "http://{}/fixture",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let (body_tx, body_rx) = sync_channel(1);
    let server = thread::spawn(move || {
        let (mut socket, _) = poll(|| listener.accept().ok());
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 8192];
        let end = loop {
            let n = socket.read(&mut chunk).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
        let length: usize = head
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse().unwrap())
            })
            .unwrap();
        while bytes.len() - end < length {
            let n = socket.read(&mut chunk).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        body_tx.send(bytes[end..end + length].to_vec()).unwrap();
        let response = json!({"tool":"vak_submit","arguments":{"reply":"Candidate ready for independent checks.","surfaces":[
            {"op":"replace","title":"Price","root":{"type":"stat","props":{"label":"Price","value":37.5}},"data":{}},
            {"op":"replace","title":"Source","root":{"type":"text","props":{"content":"prices.csv: 37.5"}},"data":{}}
        ]}});
        let body = format!(
            "{}\n",
            json!({"message":{"role":"assistant","content":response.to_string()},"done":true})
        );
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).unwrap();
    });
    let result = thread::scope(|scope| {
        let control = handle.clone();
        let run = run_id.clone();
        let runtime = h.runtime();
        let driver = scope.spawn(move || {
            run_inner(
                &control,
                runtime,
                run,
                Harness::context(),
                &AtomicBool::new(false),
                Some(url),
            )
        });
        let view = poll(|| handle.list_provider_consents().unwrap().into_iter().next());
        assert_eq!(view.root_id, "root");
        assert_eq!(view.approval.disclosure.model, "local-model");
        let mut approved = String::new();
        let mut offset = 0;
        loop {
            let page = handle
                .read_provider_consent(
                    view.approval.ticket_id.clone(),
                    view.approval.fingerprint.clone(),
                    offset,
                )
                .unwrap();
            approved.push_str(&page.text);
            offset = page.next;
            if offset == page.total {
                break;
            }
        }
        assert!(approved.contains("prices.csv"));
        assert_eq!(
            handle
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            0
        );
        let receipt = handle
            .decide_provider_consent(
                view.approval.ticket_id.clone(),
                view.approval.fingerprint.clone(),
                Decision::AllowOnce,
            )
            .unwrap();
        assert_eq!(receipt.state, "allowed");
        assert_eq!(
            body_rx.recv_timeout(Duration::from_secs(15)).unwrap(),
            approved.as_bytes()
        );
        driver.join().unwrap().unwrap()
    });
    server.join().unwrap();
    assert_eq!(result.run.worker_exit_code, Some(0));
    assert!(result.run.worker_exit_receipt.is_some());
    assert_eq!(result.run.status, RunStatus::Running);
    assert_eq!(result.candidate["surfaces"].as_array().unwrap().len(), 2);
    assert!(result.candidate.to_string().contains("37.5"));
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        1
    );
    assert!(
        handle.prepare_worker_completion(run_id.clone()).is_err(),
        "one native launch per invocation"
    );
    let commit = handle
        .commit_candidate(CandidateCommitRequest {
            session_id: "root".into(),
            commit_id: "driver-candidate".into(),
            fence: result.fence,
            expected_canonical_revision: 0,
            candidate_bytes: serde_json::to_vec(&result.candidate).unwrap(),
        })
        .unwrap();
    let canonical = crate::canonical_supervisor::run(
        &handle,
        crate::canonical_supervisor::Runtime {
            helper: &h.helper,
            node: &h.node,
            resources: &h.resources,
            data: &h.data,
        },
        commit.commit_id.clone(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(matches!(
        canonical.outcome,
        Some(crate::control::canonical_runs::Outcome::Published { .. })
    ));
    assert!(
        handle
            .read_publication_receipt(commit.commit_id)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        handle.settle_worker_completion(run_id.clone()).unwrap().status,
        RunStatus::Settled
    );
    let root = handle.read_root("root".into()).unwrap();
    assert_eq!(root.status(), RootStatus::Running);
    assert_eq!(
        root.requirements()["original-outcome"].outcome(),
        crate::control::state::CheckOutcome::Pending,
        "publication is not outcome verification"
    );

    let view_waiting = handle
        .product_task(crate::control::tasks::TaskCommand::WaitForInput {
            id: "root".into(),
            revision: root.revision(),
        })
        .unwrap();
    assert_eq!(view_waiting["state"], "needs_input");

    let snap = handle
        .product_task(crate::control::tasks::TaskCommand::Review {
            id: "root".into(),
        })
        .unwrap();
    assert_eq!(snap["runId"], run_id);
    let fingerprint = snap["fingerprint"].as_str().unwrap().to_string();
    assert_eq!(fingerprint.len(), 64);
    let snap_revision = snap["revision"].as_u64().unwrap();

    let complete_res = handle
        .product_task(crate::control::tasks::TaskCommand::Complete {
            id: "root".into(),
            revision: snap_revision,
            run_id: run_id.clone(),
            fingerprint: fingerprint.clone(),
            note: "Verified independent price views with original numeric facts".into(),
            confirmed: true,
        })
        .unwrap();
    assert_eq!(complete_res["accepted"], json!([run_id]));

    let root_accepted = handle.read_root("root".into()).unwrap();
    assert_eq!(root_accepted.status(), RootStatus::Completed);
    assert_eq!(
        root_accepted.requirements()["original-outcome"].outcome(),
        crate::control::state::CheckOutcome::Pass
    );

    let view_accepted = handle
        .product_task(crate::control::tasks::TaskCommand::Read {
            id: "root".into(),
        })
        .unwrap();
    assert_eq!(view_accepted["state"], "completed");
    assert_eq!(view_accepted["accepted"], json!([run_id]));

    let out_content = handle
        .product_task(crate::control::tasks::TaskCommand::OutputContent {
            id: "root".into(),
            run_id: run_id.clone(),
        })
        .unwrap();
    assert!(out_content["content"].as_str().unwrap().contains("37.5"));
}

#[test]
#[ignore = "requires reviewed helper, Node and packaged task worker"]
fn driver_denial_cancellation_and_protocol_failure_release_only_proven_processes() {
    let h = Harness::new();
    let handle = h.handle();
    for name in ["denied", "cancelled", "hostile", "stalled", "not-launched"] {
        let run_id = h.root(name);
        if name == "hostile" {
            fs::write(h.resources.join("task-worker.mjs"), r#"import { Socket } from "node:net"; const pipe = new Socket({ fd: 3, readable: true, writable: true }); pipe.write(JSON.stringify({v:2,type:'control_request',operation:'session_list'})+"\n"); setInterval(()=>{},1000);"#).unwrap();
        }
        if name == "stalled" {
            fs::write(h.resources.join("task-worker.mjs"), r#"import { Socket } from "node:net"; const pipe = new Socket({ fd: 3, readable: true, writable: true }); pipe.write(JSON.stringify({v:2,type:'task_ready'})+"\n"); setInterval(()=>{},1000);"#).unwrap();
        }
        let started_at = Instant::now();
        let result = if name == "not-launched" {
            run(
                &handle,
                Runtime {
                    helper: Path::new("/missing-helper"),
                    ..h.runtime()
                },
                run_id.clone(),
                Harness::context(),
                &AtomicBool::new(false),
            )
        } else {
            thread::scope(|scope| {
                let control = handle.clone();
                let run_id = run_id.clone();
                let runtime = h.runtime();
                let mut context = Harness::context();
                if name == "stalled" {
                    context.active_ms = 1000;
                }
                let driver = scope.spawn(move || {
                    run(&control, runtime, run_id, context, &AtomicBool::new(false))
                });
                if !matches!(name, "hostile" | "stalled") {
                    let view = poll(|| handle.list_provider_consents().unwrap().into_iter().next());
                    if name == "denied" {
                        handle
                            .decide_provider_consent(
                                view.approval.ticket_id,
                                view.approval.fingerprint,
                                Decision::Deny,
                            )
                            .unwrap();
                    } else {
                        let root = handle.read_root(name.into()).unwrap();
                        handle
                            .mutate_root(
                                name.into(),
                                root.revision(),
                                RootMutation::Stop {
                                    status: RootStatus::Cancelled,
                                    cause: StopCause::UserCancelled,
                                    reason: "User stopped the pending request".into(),
                                },
                            )
                            .unwrap();
                    }
                }
                driver.join().unwrap()
            })
        };
        if name == "stalled" {
            assert!(
                started_at.elapsed() < Duration::from_secs(8),
                "native active deadline must stop a ready worker before its bootstrap deadline"
            );
        }
        if name == "denied" {
            assert_eq!(result.unwrap().candidate["result"]["stop"], "error");
        } else {
            assert!(result.is_err());
        }
        assert!(handle.list_provider_consents().unwrap().is_empty());
        let run = handle.read_root_run(run_id.clone()).unwrap();
        assert!(run.worker_exit_receipt.is_some());
        assert_eq!(
            handle.read_root(name.into()).unwrap().model_requests_used(),
            0
        );
        if name == "not-launched" {
            assert_eq!(
                handle.read_root_run(run_id).unwrap().status,
                RunStatus::Settled
            );
        } else {
            assert_eq!(
                handle.settle_worker_completion(run_id).unwrap().status,
                RunStatus::Settled
            );
        }
    }
}

#[test]
fn phase_transitions_preserve_absolute_deadlines_and_do_not_refund_active_time() {
    let start = Instant::now();
    let mut clock = RunClock::new(Duration::from_secs(10), start);
    clock.advance(start + Duration::from_secs(2)).unwrap();
    assert_eq!(clock.deadline(), start + Duration::from_secs(10));
    clock
        .set_waiting(true, start + Duration::from_secs(3))
        .unwrap();
    assert_eq!(clock.active, Duration::from_secs(7));
    assert_eq!(clock.deadline(), start + Duration::from_secs(303));
    clock
        .set_waiting(false, start + Duration::from_secs(103))
        .unwrap();
    assert_eq!(clock.deadline(), start + Duration::from_secs(110));
    clock
        .set_waiting(true, start + Duration::from_secs(105))
        .unwrap();
    assert_eq!(clock.active, Duration::from_secs(5));
    assert_eq!(clock.deadline(), start + Duration::from_secs(305));
    clock
        .set_waiting(false, start + Duration::from_secs(205))
        .unwrap();
    assert_eq!(clock.deadline(), start + Duration::from_secs(210));
    assert!(clock.advance(start + Duration::from_secs(210)).is_err());
    assert!(
        clock
            .set_waiting(true, start + Duration::from_secs(210))
            .is_err()
    );
    let mut waiting = RunClock::new(Duration::from_secs(10), start);
    waiting.set_waiting(true, start).unwrap();
    assert!(
        waiting
            .set_waiting(false, start + Duration::from_secs(300))
            .is_err()
    );
    assert_eq!(waiting.active, Duration::from_secs(10));
}
