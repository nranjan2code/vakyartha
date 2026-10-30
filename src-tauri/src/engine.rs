// The shell owns one child and its anonymous pipes. Requests never become
// network listeners; only the main webview may use the bounded IPC contract.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}, mpsc::{SyncSender, TrySendError, sync_channel}};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use super::Backend;
use super::control::{AdmissionError, ControlError, ControlHandle, StoreError, bridge::{self, Operation as ControlOperation, Request as ControlRequest, Status as ControlStatus}, state::StateError};

const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_QUEUE: usize = 48 * 1024 * 1024;
const MAX_PROVIDER_BODY: usize = 8 * 1024 * 1024;
const MAX_BRIDGE_FRAME: usize = 48 * 1024 * 1024;
const PROTOCOL_VERSION: u8 = bridge::PROTOCOL_VERSION;
type Pending = Arc<Mutex<HashMap<String, Channel<Frame>>>>;
type Input = Arc<Mutex<Option<SyncSender<Vec<u8>>>>>;

#[derive(Clone, Serialize, Deserialize)]
pub struct Frame {
    v: u8,
    id: String,
    #[serde(flatten)]
    event: Output,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Output {
    Headers { status: u16, headers: BTreeMap<String, String> },
    Data { data: String },
    End,
    Error { message: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderRequest {
    v: u8,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    provider: String,
    operation: String,
    #[serde(rename = "routeModel")]
    route_model: Option<String>,
    body: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    attempt: u32,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "runId")]
    run_id: String,
}

impl ProviderRequest {
    fn validate(&self) -> bool {
        let valid_model = self.route_model.as_deref().is_some_and(|model| {
            !model.is_empty()
                && model.len() <= 128
                && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        });
        let operation_matches_provider = match self.provider.as_str() {
            "openai" => matches!(self.operation.as_str(), "responses" | "chat_completions") && self.route_model.is_none(),
            "anthropic" => self.operation == "messages" && self.route_model.is_none(),
            "gemini" => self.operation == "stream_generate_content" && valid_model,
            "ollama" => self.operation == "ollama_chat" && self.route_model.is_none(),
            "mistral" | "xai" | "deepseek" | "groq" | "cerebras" | "openrouter"
            | "together" | "fireworks" | "moonshot" | "dashscope" => self.operation == "chat_completions" && self.route_model.is_none(),
            _ => false,
        };
        self.v == PROTOCOL_VERSION
            && self.kind == "provider_request"
            && self.id.starts_with("gen-")
            && valid_id(&self.id)
            && operation_matches_provider
            && self.body.len() <= MAX_PROVIDER_BODY
            && self.operation_id.len() <= 128
            && !self.operation_id.is_empty()
            && self.operation_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            && self.attempt <= 16
            && valid_execution_id(&self.session_id)
            && valid_execution_id(&self.run_id)
    }
}

fn valid_execution_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn provider_refusal(id: &str) -> serde_json::Value {
    serde_json::json!({
        "v": PROTOCOL_VERSION,
        "id": id,
        "type": "provider_error",
        "message": "Native provider dispatch is not enabled",
    })
}

pub struct Engine {
    pub child: Mutex<Option<Child>>,
    input: Input,
    queued: Arc<AtomicUsize>,
    pending: Pending,
    pub backend: Result<Backend, String>,
}

fn control_error_status(error: &ControlError) -> ControlStatus {
    match error {
        ControlError::QueueFull | ControlError::TimedOut => ControlStatus::Overloaded,
        ControlError::Admission(
            AdmissionError::CandidateIdentityConflict
            | AdmissionError::CandidateSessionMismatch
            | AdmissionError::CanonicalRevisionConflict
            | AdmissionError::CanonicalSessionOwned
            | AdmissionError::InvalidCandidate
            | AdmissionError::InvalidIdentity
            | AdmissionError::CapacityUnavailable(_)
            | AdmissionError::UnconfiguredResource(_)
            | AdmissionError::ReservedForControl(_)
            | AdmissionError::RootLimit(_)
            | AdmissionError::UnknownLease,
        )
        | ControlError::Store(StoreError::SessionRevisionConflict | StoreError::TooLarge)
        | ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)
        | ControlError::TaskState(
            StateError::ExecutionFenceStale | StateError::WorkspaceGrantStale,
        ) => ControlStatus::Refused,
        _ => ControlStatus::Unavailable,
    }
}

fn control_error_code(error: &ControlError) -> &'static str {
    match error {
        ControlError::QueueFull => "native_control_overloaded",
        ControlError::TimedOut => "native_control_timeout",
        ControlError::Admission(AdmissionError::RootNotFound) => "root_not_found",
        ControlError::Admission(AdmissionError::CanonicalRevisionConflict) => {
            "canonical_revision_conflict"
        }
        ControlError::Admission(AdmissionError::CandidateIdentityConflict) => {
            "candidate_identity_conflict"
        }
        ControlError::Admission(AdmissionError::CandidateSessionMismatch) => {
            "candidate_session_mismatch"
        }
        ControlError::Admission(AdmissionError::CanonicalSessionOwned) => {
            "canonical_session_owned"
        }
        ControlError::TaskState(StateError::ExecutionFenceStale) => "execution_fence_stale",
        ControlError::TaskState(StateError::WorkspaceGrantStale) => "workspace_grant_stale",
        ControlError::TaskState(StateError::InvalidTransition(_)) => "root_not_running",
        ControlError::Admission(AdmissionError::TaskCapabilityUnavailable) => "task_runtime_owned",
        ControlError::Admission(AdmissionError::InvalidCandidate) => "invalid_candidate",
        ControlError::Store(StoreError::TooLarge) => "candidate_too_large",
        ControlError::Store(StoreError::SessionRevisionConflict) => "session_revision_conflict",
        ControlError::Admission(AdmissionError::InvalidIdentity) => "invalid_session_identity",
        ControlError::Store(StoreError::UnsupportedDurability) => "durability_unavailable",
        ControlError::Admission(AdmissionError::CapacityUnavailable(_)) => "capacity_unavailable",
        ControlError::Admission(AdmissionError::UnconfiguredResource(_)) => "unconfigured_resource",
        ControlError::Admission(AdmissionError::ReservedForControl(_)) => "reserved_for_control",
        ControlError::Admission(AdmissionError::RootLimit(_)) => "root_limit_exceeded",
        ControlError::Admission(AdmissionError::UnknownLease) => "unknown_lease",
        _ => "native_control_unavailable",
    }
}
impl Engine {
    pub fn failed(error: String) -> Self {
        Self { child: Mutex::new(None), input: Arc::new(Mutex::new(None)), queued: Arc::new(AtomicUsize::new(0)), pending: Arc::new(Mutex::new(HashMap::new())), backend: Err(error) }
    }
    fn send(&self, message: serde_json::Value) -> Result<(), String> {
        let input = self.input.lock().unwrap().clone().ok_or("Engine connection closed")?;
        queue_input(&input, &self.queued, message)
    }
    pub fn close(&self) { self.input.lock().unwrap().take(); }
}

fn queue_input(input: &SyncSender<Vec<u8>>, queued: &AtomicUsize, message: serde_json::Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let size = bytes.len();
    queued.try_update(Ordering::AcqRel, Ordering::Relaxed, |n| n.checked_add(size).filter(|sum| *sum <= MAX_QUEUE)).map_err(|_| "Engine input queue is full")?;
    let result = input.try_send(bytes).map_err(|_| "Engine input queue is full or closed".to_owned());
    if result.is_err() { queued.fetch_sub(size, Ordering::AcqRel); }
    result
}

fn fail_pending(pending: &Pending) {
    for (id, channel) in pending.lock().unwrap().drain() {
        let _ = channel.send(Frame { v: PROTOCOL_VERSION, id, event: Output::Error { message: "Engine connection closed".into() } });
    }
}

pub fn start(mut cmd: Command, control: Option<ControlHandle>) -> Engine {
    let mut child = match cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
        Ok(child) => child,
        Err(e) => return Engine::failed(format!("Could not start the engine: {e}")),
    };
    let mut input = child.stdin.take().expect("piped stdin");
    let mut reader = BufReader::new(child.stdout.take().expect("piped stdout"));
    let (ready_tx, ready_rx) = sync_channel(1);
    std::thread::spawn(move || {
        let mut ready = String::new();
        let result = reader.by_ref().take(4096).read_line(&mut ready);
        let valid = result.is_ok() && ready.strip_prefix("VAK_READY ").and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()).is_some_and(|v| v["version"] == PROTOCOL_VERSION && v["transport"] == "stdio");
        let _ = ready_tx.send((valid, reader));
    });
    let result = ready_rx.recv_timeout(std::time::Duration::from_secs(10));
    let mut reader = match result {
        Ok((true, reader)) => reader,
        _ => {
        let _ = child.kill(); let _ = child.wait();
        return Engine::failed("Engine did not complete the private protocol handshake".into());
        }
    };
    let (tx, rx) = sync_channel::<Vec<u8>>(32);
    let sender = Arc::new(Mutex::new(Some(tx)));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let queued = Arc::new(AtomicUsize::new(0));
    let queue_size = queued.clone();
    let writer_pending = pending.clone();
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            let result = input.write_all(&bytes);
            queue_size.fetch_sub(bytes.len(), Ordering::AcqRel);
            if result.is_err() { fail_pending(&writer_pending); break; }
        }
        // Dropping the only stdin writer terminates the child even after a crash.
    });
    let (control_tx, control_rx) = sync_channel::<ControlRequest>(2);
    let control_writer = sender.clone();
    let control_queue_size = queued.clone();
    std::thread::spawn(move || {
        while let Ok(request) = control_rx.recv() {
            let response = match request.operation {
                ControlOperation::Health => {
                    let status = match control.as_ref() {
                        Some(actor) if actor.ping().is_ok() => ControlStatus::Ready,
                        _ => ControlStatus::Unavailable,
                    };
                    bridge::Response::new(&request.id, status)
                }
                ControlOperation::CandidateCommit(candidate) => {
                    match candidate.into_request() {
                        Ok(candidate) => match control.as_ref() {
                            Some(actor) => match actor.commit_app_candidate(candidate) {
                                Ok(receipt) => bridge::Response::candidate(
                                    &request.id,
                                    ControlStatus::Committed,
                                    Some(receipt),
                                    None,
                                ),
                                Err(error) => {
                                    let code = control_error_code(&error);
                                    bridge::Response::candidate(
                                        &request.id,
                                        control_error_status(&error),
                                        None,
                                        Some(code),
                                    )
                                }
                            },
                            None => bridge::Response::candidate(
                                &request.id,
                                ControlStatus::Unavailable,
                                None,
                                Some("native_control_unavailable"),
                            ),
                        },
                        Err(code) => bridge::Response::candidate(
                            &request.id,
                            ControlStatus::Refused,
                            None,
                            Some(code),
                        ),
                    }
                }
                ControlOperation::SessionLoad { session_id } => match control.as_ref() {
                    Some(actor) => match actor.load_host_session(session_id) {
                        Ok(Some((revision, snapshot))) => bridge::Response::session_snapshot(
                            &request.id, ControlStatus::Loaded, Some(revision), Some(snapshot), None),
                        Ok(None) => bridge::Response::session_snapshot(&request.id, ControlStatus::Refused, None, None, Some("session_not_found")),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::SessionSave { session_id, expected_revision, snapshot } => match control.as_ref() {
                    Some(actor) => match actor.save_host_session(session_id, expected_revision, snapshot) {
                        Ok(revision) => bridge::Response::session_snapshot(&request.id, ControlStatus::Saved, Some(revision), None, None),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::SessionList {} => match control.as_ref() {
                    Some(actor) => match actor.list_host_sessions() {
                        Ok(sessions) => bridge::Response::sessions(&request.id, sessions),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::SessionRemove { session_id, expected_revision } => match control.as_ref() {
                    Some(actor) => match actor.remove_host_session(session_id, expected_revision) {
                        Ok(()) => bridge::Response::session_snapshot(&request.id, ControlStatus::Removed, None, None, None),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::CapacityReserve { request_id, root_id, amounts } => match control.as_ref() {
                    Some(actor) => match actor.reserve(request_id, root_id, amounts) {
                        Ok(lease) => bridge::Response::capacity_reserve(&request.id, ControlStatus::Reserved, Some(lease), None),
                        Err(error) => bridge::Response::capacity_reserve(&request.id, control_error_status(&error), None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::capacity_reserve(&request.id, ControlStatus::Unavailable, None, Some("native_control_unavailable")),
                },
                ControlOperation::CapacityRelease { lease } => match control.as_ref() {
                    Some(actor) => match actor.release(lease) {
                        Ok(()) => bridge::Response::capacity_release(&request.id, ControlStatus::Released, None),
                        Err(error) => bridge::Response::capacity_release(&request.id, control_error_status(&error), Some(control_error_code(&error))),
                    },
                    None => bridge::Response::capacity_release(&request.id, ControlStatus::Unavailable, Some("native_control_unavailable")),
                },
            };
            let response = serde_json::to_value(response).unwrap();
            let writer = control_writer.lock().unwrap().clone();
            if let Some(writer) = writer {
                let _ = queue_input(&writer, &control_queue_size, response);
            }
        }
    });
    let responses = pending.clone();
    let connection = sender.clone();
    let response_queue = queued.clone();
    let control_requests = control_tx;
    std::thread::spawn(move || {
        loop {
            let mut line = Vec::new();
            let result = reader.by_ref().take(MAX_BRIDGE_FRAME as u64 + 1).read_until(b'\n', &mut line);
            if !matches!(result, Ok(n) if n > 0 && n <= MAX_BRIDGE_FRAME) || !line.ends_with(b"\n") { break; }
            let value = match serde_json::from_slice::<serde_json::Value>(&line) { Ok(value) => value, Err(_) => break };
            if value.get("type").and_then(serde_json::Value::as_str) == Some("control_request") {
                let request = match ControlRequest::decode_value(value, line.len()) { Ok(request) => request, Err(_) => break };
                match control_requests.try_send(request) {
                    Ok(()) => continue,
                    Err(TrySendError::Full(request)) => {
                        let response = match request.operation {
                            ControlOperation::Health => bridge::Response::new(&request.id, ControlStatus::Overloaded),
                            ControlOperation::CandidateCommit(_) => bridge::Response::candidate(
                                &request.id,
                                ControlStatus::Overloaded,
                                None,
                                Some("native_control_queue_full"),
                            ),
                            _ => bridge::Response::candidate(
                                &request.id,
                                ControlStatus::Overloaded,
                                None,
                                Some("native_control_queue_full"),
                            ),
                        };
                        let response = serde_json::to_value(response).unwrap();
                        let input = connection.lock().unwrap().clone();
                        let Some(input) = input else { break; };
                        if queue_input(&input, &response_queue, response).is_err() { break; }
                        continue;
                    }
                    Err(TrySendError::Disconnected(_)) => break,
                }
            }
            if value.get("type").and_then(serde_json::Value::as_str) == Some("provider_request") {
                let request = match serde_json::from_value::<ProviderRequest>(value) {
                    Ok(request) if request.validate() => request,
                    _ => break,
                };
                let input = connection.lock().unwrap().clone();
                let Some(input) = input else { break; };
                if queue_input(&input, &response_queue, provider_refusal(&request.id)).is_err() { break; }
                continue;
            }
            let frame = match serde_json::from_value::<Frame>(value) { Ok(frame) if frame.v == PROTOCOL_VERSION => frame, _ => break };
            let terminal = matches!(frame.event, Output::End | Output::Error { .. });
            let channel = { let mut map = responses.lock().unwrap(); if terminal { map.remove(&frame.id) } else { map.get(&frame.id).cloned() } };
            if let Some(channel) = channel {
                let id = frame.id.clone();
                if channel.send(frame).is_err() {
                    responses.lock().unwrap().remove(&id);
                    let cancel = serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"cancel"});
                    if let Some(input) = connection.lock().unwrap().as_ref() { let _ = queue_input(input, &response_queue, cancel); }
                }
            }
        }
        connection.lock().unwrap().take();
        fail_pending(&responses);
    });
    Engine { child: Mutex::new(Some(child)), input: sender, queued, pending, backend: Ok(Backend { url: "vak://localhost".into(), token: String::new() }) }
}

fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }
pub fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost")) || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"));
    let dev = cfg!(debug_assertions) && url.scheme() == "http" && [Some("localhost"), Some("127.0.0.1")].contains(&url.host_str()) && url.port() == Some(1420);
    if (window.label() != "main" && window.label() != "admin") || !(local || dev) { return Err("Engine IPC is restricted to app windows".into()); }
    Ok(())
}

#[tauri::command]
#[expect(clippy::too_many_arguments, reason = "Tauri maps this flat named IPC schema to command parameters")]
pub async fn engine_request(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String, method: String, path: String, headers: BTreeMap<String, String>, body: Option<String>, channel: Channel<Frame>) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) || !["GET", "POST", "PUT", "DELETE"].contains(&method.as_str()) || !path.starts_with("/api/") || path.len() > 8192 || path.contains(['\r', '\n', '#']) || body.as_ref().is_some_and(|b| b.len() > MAX_BODY || method == "GET") || headers.len() > 2 || headers.iter().any(|(k,v)| !["content-type", "range"].contains(&k.as_str()) || v.len() > 256 || v.contains(['\r', '\n'])) { return Err("Invalid engine request".into()); }
    { let mut pending = state.pending.lock().unwrap(); if pending.len() >= 32 || pending.contains_key(&id) { return Err("Too many engine requests or duplicate identity".into()); } pending.insert(id.clone(), channel); }
    let mut message = serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"request","method":method,"path":path,"headers":headers});
    if let Some(body) = body { message["body"] = body.into(); }
    if let Err(error) = state.send(message) { state.pending.lock().unwrap().remove(&id); return Err(error); }
    Ok(())
}

#[tauri::command]
pub fn engine_ack(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) { return Err("Invalid request identity".into()); }
    state.send(serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"ack"}))
}
#[tauri::command]
pub fn engine_cancel(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) { return Err("Invalid request identity".into()); }
    state.pending.lock().unwrap().remove(&id);
    state.send(serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"cancel"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{CapacityProfile, ControlActor};

    #[test]
    fn identifiers_and_output_frames_are_bounded_and_typed() {
        assert!(valid_id("request-123")); assert!(!valid_id("../request")); assert!(!valid_id(&"a".repeat(65)));
        assert!(serde_json::from_str::<Frame>(r#"{"v":2,"id":"x","type":"shell","command":"bad"}"#).is_err());
        let frame: Frame = serde_json::from_str(r#"{"v":2,"id":"x","type":"data","data":"AAE="}"#).unwrap();
        assert!(matches!(frame.event, Output::Data { .. }));
    }

    #[test]
    fn provider_frames_are_registered_operation_records_without_destinations() {
        let request: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-123","type":"provider_request","provider":"openai","operation":"responses","body":"{}","operationId":"root-op-1","attempt":1,"sessionId":"session-1","runId":"run-1"}"#,
        ).unwrap();
        assert!(request.validate());
        let gemini: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-124","type":"provider_request","provider":"gemini","operation":"stream_generate_content","routeModel":"gemini-2.5-flash","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"session-1","runId":"run-1"}"#,
        ).unwrap();
        assert!(gemini.validate());
        let invalid_execution_identity: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-invalid","type":"provider_request","provider":"openai","operation":"responses","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"../session","runId":"run-1"}"#,
        ).unwrap();
        assert!(!invalid_execution_identity.validate());
        let mismatched: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-125","type":"provider_request","provider":"openai","operation":"messages","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"session-1","runId":"run-1"}"#,
        ).unwrap();
        assert!(!mismatched.validate());
        assert!(serde_json::from_str::<ProviderRequest>(
            r#"{"v":2,"id":"gen-126","type":"provider_request","provider":"openai","operation":"responses","url":"https://attacker.example","body":"{}","operationId":"root-op-1","attempt":0}"#,
        ).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_child_pipe_round_trips_health_to_native_control_actor() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vak-engine-control-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let actor = ControlActor::open(
            &root,
            "unconfigured-v1",
            CapacityProfile::unconfigured().unwrap(),
            32,
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let response_path = root.join("control-response.json");
        let script = r#"printf 'VAK_READY {"transport":"stdio","version":2}\n'
printf '{"v":2,"id":"ctl-fixture","type":"control_request","operation":"health"}\n'
IFS= read -r response
printf '%s' "$response" > "$1"
"#;
        let mut command = Command::new("sh");
        command.arg("-c").arg(script).arg("fixture").arg(&response_path);
        let engine = start(command, Some(actor.handle()));
        assert!(engine.backend.is_ok());
        let mut child = engine.child.lock().unwrap().take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("private control health response timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let response: serde_json::Value = serde_json::from_slice(&std::fs::read(&response_path).unwrap()).unwrap();
        assert_eq!(response["v"], PROTOCOL_VERSION);
        assert_eq!(response["id"], "ctl-fixture");
        assert_eq!(response["type"], "control_response");
        assert_eq!(response["status"], "ready");
        drop(engine);
        drop(actor);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_provider_pipe_returns_typed_fail_closed_response() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("vak-engine-provider-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let response_path = root.join("provider-response.json");
        let script = r#"echo 'VAK_READY {"transport":"stdio","version":2}'
echo '{"v":2,"id":"gen-fixture","type":"provider_request","provider":"openai","operation":"responses","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"session-1","runId":"run-1"}'
IFS= read -r response
printf '%s' "$response" > "$1"
"#;
        let mut command = Command::new("sh");
        command.arg("-c").arg(script).arg("fixture").arg(&response_path);
        let engine = start(command, None);
        assert!(engine.backend.is_ok());
        let mut child = engine.child.lock().unwrap().take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(std::time::Instant::now() < deadline, "provider frame response timed out");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let response: serde_json::Value = serde_json::from_slice(&std::fs::read(&response_path).unwrap()).unwrap();
        assert_eq!(response["id"], "gen-fixture");
        assert_eq!(response["type"], "provider_error");
        assert_eq!(response["message"], "Native provider dispatch is not enabled");
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }
}
