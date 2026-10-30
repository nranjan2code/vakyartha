use super::*;
use crate::control::{
    CapacityProfile, ControlActor, Resource, RootMutation,
    delegation::{DelegationMode, DelegationPolicy},
    generation::{Decision, OperationStatus},
    state::{BudgetLimits, LocalModelPolicy, Requirement, RootCreate, RootStatus, StopCause},
};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc::{Sender, channel},
};

struct Harness {
    actor: Option<ControlActor>,
    data: PathBuf,
    native: PathBuf,
    run: String,
}
impl Harness {
    fn new() -> Self {
        let data = std::env::temp_dir().join(format!(
            "vak-provider-io-{}-{}",
            std::process::id(),
            super::super::TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&data).unwrap();
        let native = super::super::native_store_root(&data);
        let profile = CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 1), (Resource::ProviderRequest, 1)]),
            BTreeMap::from([(Resource::Generation, 1), (Resource::ProviderRequest, 1)]),
            64,
        )
        .unwrap();
        let actor =
            ControlActor::open(&data, "io-test", profile, 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        let root = handle
            .create_root_with_budget(RootCreate {
                id: "root".into(),
                session_id: Some("session".into()),
                local_model: Some(LocalModelPolicy {
                    model: "local-model".into(),
                    max_output_tokens: 256,
                    max_request_bytes: 65536,
                }),
                goal: "Check native I/O".into(),
                criteria: "Original source and independent outcome checks".into(),
                run_limit: 2,
                budget_limits: BudgetLimits::new(8, 0).unwrap(),
                requirements: vec![Requirement::new("check".into(), true).unwrap()],
                delegation: DelegationPolicy::new(DelegationMode::Disabled, 0).unwrap(),
            })
            .unwrap();
        handle
            .mutate_root(
                "root".into(),
                root.revision(),
                RootMutation::StartAttempt {
                    request_id: "start".into(),
                },
            )
            .unwrap();
        let run = handle.read_root_run_for_start("start".into()).unwrap().id;
        handle
            .confirm_root_started(run.clone(), "native-supervisor".into())
            .unwrap();
        Self {
            actor: Some(actor),
            data,
            native,
            run,
        }
    }
    fn handle(&self) -> ControlHandle {
        self.actor.as_ref().unwrap().handle()
    }
    fn dispatch(&self, operation: &str) -> Dispatch {
        let handle = self.handle();
        let ticket = handle
            .issue_provider_approval(self.run.clone(), operation.into(), 0, body())
            .unwrap();
        handle
            .decide_provider_approval(ticket.ticket_id, ticket.fingerprint, Decision::AllowOnce)
            .unwrap()
    }
    fn exchange(&self, dispatch: Dispatch, url: reqwest::Url, lifetime: Duration) -> Exchange {
        start_inner(
            self.handle(),
            dispatch,
            "no-vault-for-local".into(),
            self.data.clone(),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + lifetime,
            Some(url),
        )
        .unwrap()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        drop(self.actor.take());
        let _ = fs::remove_dir_all(&self.data);
        let _ = fs::remove_dir_all(&self.native);
    }
}
fn body() -> Vec<u8> {
    serde_json::to_vec(&json!({"model":"local-model","messages":[{"role":"user","content":"exact-approved-marker"}],"stream":true,"options":{"num_predict":256},"think":false,"keep_alive":"30m"})).unwrap()
}
struct Server {
    url: reqwest::Url,
    request: Receiver<Vec<u8>>,
    closed: Receiver<bool>,
}
fn server(response: Vec<u8>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = reqwest::Url::parse(&format!(
        "http://{}/api/chat",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let (tx, request) = channel();
    let (close_tx, closed) = channel();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut socket = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                _ => return,
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        if !read_request(&socket, &tx) {
            return;
        }
        if socket.write_all(&response).is_err() {
            let _ = close_tx.send(true);
            return;
        }
        let mut byte = [0];
        let ended = match socket.read(&mut byte) {
            Ok(0) => true,
            Err(error) => matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
            ),
            _ => false,
        };
        let _ = close_tx.send(ended);
    });
    Server {
        url,
        request,
        closed,
    }
}
fn read_request(socket: &TcpStream, tx: &Sender<Vec<u8>>) -> bool {
    let mut reader = std::io::BufReader::new(socket);
    let mut length = 0usize;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return false;
        }
        header_bytes += line.len();
        if header_bytes > 16384 || line.is_empty() {
            return false;
        }
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().unwrap();
        }
    }
    if length > 65536 {
        return false;
    }
    let mut bytes = vec![0; length];
    if reader.read_exact(&mut bytes).is_err() {
        return false;
    }
    let _ = tx.send(bytes);
    true
}
fn next(exchange: &mut Exchange) -> Event {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(event) = exchange.try_next() {
            return event;
        }
        assert!(Instant::now() < deadline, "native exchange stalled");
        thread::sleep(Duration::from_millis(5));
    }
}
fn finish(exchange: &mut Exchange) -> OperationRecord {
    loop {
        match next(exchange) {
            Event::Data { seq, .. } => exchange.acknowledge(seq).unwrap(),
            Event::Headers { .. } => {}
            Event::Finished(result) => return (*result).unwrap(),
        }
    }
}

#[test]
fn exact_approved_bytes_stream_with_backpressure_and_settle_before_finished() {
    let h = Harness::new();
    let payload = vec![b'a'; CHUNK * 3];
    let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nSet-Cookie: private=never-forward\r\n\r\n",payload.len()).into_bytes();
    response.extend(&payload);
    let s = server(response);
    let dispatch = h.dispatch("exact");
    let id = dispatch.operation().id.clone();
    let mut exchange = h.exchange(dispatch, s.url, Duration::from_secs(5));
    assert_eq!(
        s.request.recv_timeout(Duration::from_secs(2)).unwrap(),
        body()
    );
    match next(&mut exchange) {
        Event::Headers { status, headers } => {
            assert_eq!(status, 200);
            assert_eq!(headers.len(), 1);
        }
        _ => panic!("headers first"),
    }
    let Event::Data { seq, bytes } = next(&mut exchange) else {
        panic!("data expected")
    };
    assert!(bytes.len() <= CHUNK);
    thread::sleep(Duration::from_millis(80));
    assert!(
        exchange.try_next().is_none(),
        "no chunk after one unacknowledged chunk"
    );
    h.handle().ping().unwrap();
    assert_eq!(
        h.handle()
            .read_provider_operation(id.clone())
            .unwrap()
            .status,
        OperationStatus::IoStarted
    );
    exchange.acknowledge(seq).unwrap();
    let mut actual = bytes;
    let record = loop {
        match next(&mut exchange) {
            Event::Data { seq, bytes } => {
                assert!(bytes.len() <= CHUNK);
                actual.extend(bytes);
                exchange.acknowledge(seq).unwrap();
            }
            Event::Finished(result) => break (*result).unwrap(),
            _ => panic!("one header frame"),
        }
    };
    assert_eq!(actual, payload);
    assert_eq!(record.status, OperationStatus::Returned);
    assert!(record.io_started);
    let receipt = record.receipt.as_ref().unwrap();
    assert_eq!(receipt.outcome, IoOutcome::Completed);
    assert_eq!(receipt.response_bytes, payload.len() as u32);
    assert!(s.closed.recv_timeout(Duration::from_secs(2)).unwrap());
    assert_eq!(
        h.handle()
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        1
    );
    assert_eq!(
        h.handle().read_root("root".into()).unwrap().status(),
        RootStatus::Running
    );
    let selected = fs::read_to_string(h.native.join("control/current")).unwrap();
    let sequence: u64 = selected.trim().parse().unwrap();
    let stored = fs::read(
        h.native
            .join("control")
            .join(format!("generation-{sequence:020}.json")),
    )
    .unwrap();
    assert!(!String::from_utf8_lossy(&stored).contains("exact-approved-marker"));
    let slot = h
        .handle()
        .reserve(
            "slot-after-io".into(),
            "root".into(),
            BTreeMap::from([(Resource::ProviderRequest, 1)]),
        )
        .unwrap();
    h.handle().release(slot).unwrap();
}

#[test]
fn native_root_cancellation_aborts_a_request_waiting_for_headers() {
    let h = Harness::new();
    let s = server(Vec::new());
    let mut exchange = h.exchange(h.dispatch("cancel-root"), s.url, Duration::from_secs(5));
    s.request.recv_timeout(Duration::from_secs(2)).unwrap();
    let handle = h.handle();
    let root = handle.read_root("root".into()).unwrap();
    handle
        .mutate_root(
            "root".into(),
            root.revision(),
            RootMutation::Stop {
                status: RootStatus::Cancelled,
                cause: StopCause::UserCancelled,
                reason: "Cancel native request".into(),
            },
        )
        .unwrap();
    let record = finish(&mut exchange);
    assert_eq!(record.receipt.unwrap().outcome, IoOutcome::Cancelled);
    assert!(s.closed.recv_timeout(Duration::from_secs(2)).unwrap());
    assert_eq!(
        handle
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        1
    );
}

#[test]
fn missing_ack_deadline_and_invalid_ack_close_local_io_without_budget_refund() {
    for invalid in [false, true] {
        let h = Harness::new();
        let s = server(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n12345678".to_vec());
        let mut exchange = h.exchange(h.dispatch("ack"), s.url, Duration::from_millis(500));
        assert!(matches!(next(&mut exchange), Event::Headers { .. }));
        let Event::Data { seq, .. } = next(&mut exchange) else {
            panic!("data")
        };
        if invalid {
            assert!(exchange.acknowledge(seq + 1).is_err());
        }
        let record = loop {
            if let Event::Finished(result) = next(&mut exchange) {
                break (*result).unwrap();
            }
        };
        assert_eq!(
            record.receipt.unwrap().outcome,
            if invalid {
                IoOutcome::ConsumerClosed
            } else {
                IoOutcome::TimedOut
            }
        );
        assert!(s.closed.recv_timeout(Duration::from_secs(2)).unwrap());
        assert_eq!(
            h.handle()
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            1
        );
    }
}

#[test]
fn acknowledgement_before_data_is_refused_and_retires_local_io() {
    let h = Harness::new();
    let s = server(Vec::new());
    let mut exchange = h.exchange(h.dispatch("early-ack"), s.url, Duration::from_secs(2));
    assert!(exchange.acknowledge(0).is_err());
    let record = loop {
        if let Event::Finished(result) = next(&mut exchange) {
            break (*result).unwrap();
        }
    };
    assert!(matches!(
        record.receipt.unwrap().outcome,
        IoOutcome::ConsumerClosed | IoOutcome::NotDispatched
    ));
}

#[test]
fn response_ceiling_and_consumer_drop_do_not_leave_provider_holds() {
    for oversized in [false, true] {
        let h = Harness::new();
        let response = if oversized {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE + 1
            )
            .into_bytes()
        } else {
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n12345678".to_vec()
        };
        let s = server(response);
        let dispatch = h.dispatch("bounded");
        let id = dispatch.operation().id.clone();
        let mut exchange = h.exchange(dispatch, s.url, Duration::from_secs(3));
        if oversized {
            assert_eq!(
                finish(&mut exchange).receipt.unwrap().outcome,
                IoOutcome::ResponseLimit
            );
        } else {
            assert!(matches!(next(&mut exchange), Event::Headers { .. }));
            assert!(matches!(next(&mut exchange), Event::Data { .. }));
            drop(exchange);
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let record = h.handle().read_provider_operation(id.clone()).unwrap();
                if record.status == OperationStatus::Returned {
                    assert_eq!(record.receipt.unwrap().outcome, IoOutcome::ConsumerClosed);
                    break;
                }
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(5));
            }
        }
        assert!(s.closed.recv_timeout(Duration::from_secs(2)).unwrap());
        let slot = h
            .handle()
            .reserve(
                "slot".into(),
                "root".into(),
                BTreeMap::from([(Resource::ProviderRequest, 1)]),
            )
            .unwrap();
        h.handle().release(slot).unwrap();
    }
}

#[test]
fn chunked_overflow_and_redirects_are_not_followed_or_replayed() {
    let h = Harness::new();
    let mut response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    response.extend(format!("{:x}\r\n", MAX_RESPONSE + 1).as_bytes());
    response.extend(vec![b'a'; MAX_RESPONSE + 1]);
    response.extend(b"\r\n0\r\n\r\n");
    let s = server(response);
    let mut exchange = h.exchange(h.dispatch("chunked"), s.url, Duration::from_secs(5));
    let record = finish(&mut exchange);
    let receipt = record.receipt.unwrap();
    assert_eq!(receipt.outcome, IoOutcome::ResponseLimit);
    assert!(receipt.response_bytes <= MAX_RESPONSE as u32);
    assert!(s.closed.recv_timeout(Duration::from_secs(2)).unwrap());
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let s = server(
        format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/unapproved\r\nContent-Length: 0\r\n\r\n",
            destination.local_addr().unwrap()
        )
        .into_bytes(),
    );
    let mut exchange = h.exchange(h.dispatch("redirect"), s.url, Duration::from_secs(3));
    let record = finish(&mut exchange);
    assert_eq!(record.receipt.unwrap().status_code, Some(302));
    assert!(
        matches!(destination.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
    assert_eq!(
        h.handle()
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        2
    );
}

#[test]
fn revoked_approval_cannot_start_io_and_selection_failure_never_sends() {
    let mut h = Harness::new();
    let dispatch = h.dispatch("failed-begin");
    let id = dispatch.operation().id.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = reqwest::Url::parse(&format!(
        "http://{}/api/chat",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let pointer = h.native.join("control/current");
    let selected = fs::read(&pointer).unwrap();
    fs::remove_file(&pointer).unwrap();
    fs::create_dir(&pointer).unwrap();
    assert!(matches!(
        start_inner(
            h.handle(),
            dispatch,
            "local".into(),
            h.data.clone(),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(2),
            Some(url.clone())
        ),
        Err(ControlError::Store(_))
    ));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    drop(h.actor.take());
    fs::remove_dir(&pointer).unwrap();
    fs::write(&pointer, selected).unwrap();
    let profile = CapacityProfile::new(
        BTreeMap::from([(Resource::Generation, 1), (Resource::ProviderRequest, 1)]),
        BTreeMap::from([(Resource::Generation, 1), (Resource::ProviderRequest, 1)]),
        64,
    )
    .unwrap();
    h.actor =
        Some(ControlActor::open(&h.data, "io-test", profile, 16, Duration::from_secs(2)).unwrap());
    let record = h.handle().read_provider_operation(id).unwrap();
    assert_eq!(record.status, OperationStatus::Interrupted);
    assert!(!record.io_started);
    assert!(record.receipt.is_none());
    assert_eq!(
        h.handle()
            .read_root("root".into())
            .unwrap()
            .model_requests_used(),
        1
    );
    let h = Harness::new();
    let dispatch = h.dispatch("stale");
    let id = dispatch.operation().id.clone();
    let root = h.handle().read_root("root".into()).unwrap();
    h.handle()
        .mutate_root(
            "root".into(),
            root.revision(),
            RootMutation::Stop {
                status: RootStatus::Cancelled,
                cause: StopCause::UserCancelled,
                reason: "Cancel before native I/O".into(),
            },
        )
        .unwrap();
    assert!(
        start_inner(
            h.handle(),
            dispatch,
            "local".into(),
            h.data.clone(),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(2),
            Some(url)
        )
        .is_err()
    );
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    assert_eq!(
        h.handle()
            .read_provider_operation(id)
            .unwrap()
            .receipt
            .unwrap()
            .outcome,
        IoOutcome::NotDispatched
    );
}

#[test]
fn malformed_status_and_transport_errors_settle_without_claiming_completion() {
    for response in [
        b"HTTP/1.1 600 Unknown\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"not http\r\n".to_vec(),
    ] {
        let h = Harness::new();
        let s = server(response);
        let mut exchange = h.exchange(
            h.dispatch("invalid-response"),
            s.url,
            Duration::from_millis(700),
        );
        let record = finish(&mut exchange);
        assert!(matches!(
            record.receipt.unwrap().outcome,
            IoOutcome::TransportFailed | IoOutcome::TimedOut
        ));
        assert_eq!(
            h.handle()
                .read_root("root".into())
                .unwrap()
                .model_requests_used(),
            1
        );
    }
}
