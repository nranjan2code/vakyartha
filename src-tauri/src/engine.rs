// The shell owns one child and its anonymous pipes. Requests never become
// network listeners; only the main webview may use the bounded IPC contract.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}, mpsc::{SyncSender, TrySendError, sync_channel}};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use super::Backend;
use super::control::{ControlHandle, bridge::{self, Operation as ControlOperation, Request as ControlRequest, Status as ControlStatus}};

const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_QUEUE: usize = 48 * 1024 * 1024;
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

pub struct Engine {
    pub child: Mutex<Option<Child>>,
    input: Input,
    queued: Arc<AtomicUsize>,
    pending: Pending,
    pub backend: Result<Backend, String>,
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
    let (control_tx, control_rx) = sync_channel::<ControlRequest>(16);
    let control_writer = sender.clone();
    let control_queue_size = queued.clone();
    std::thread::spawn(move || {
        while let Ok(request) = control_rx.recv() {
            let status = match (control.as_ref(), request.operation) {
                (Some(actor), ControlOperation::Health) if actor.ping().is_ok() => ControlStatus::Ready,
                _ => ControlStatus::Unavailable,
            };
            let response = serde_json::to_value(bridge::Response::new(&request.id, status)).unwrap();
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
            let result = reader.by_ref().take(128 * 1024 + 1).read_until(b'\n', &mut line);
            if !matches!(result, Ok(n) if n > 0 && n <= 128 * 1024) || !line.ends_with(b"\n") { break; }
            let value = match serde_json::from_slice::<serde_json::Value>(&line) { Ok(value) => value, Err(_) => break };
            if value.get("type").and_then(serde_json::Value::as_str) == Some("control_request") {
                let request = match ControlRequest::decode(&line) { Ok(request) => request, Err(_) => break };
                match control_requests.try_send(request) {
                    Ok(()) => continue,
                    Err(TrySendError::Full(request)) => {
                        let response = serde_json::to_value(bridge::Response::new(&request.id, ControlStatus::Overloaded)).unwrap();
                        let input = connection.lock().unwrap().clone();
                        let Some(input) = input else { break; };
                        if queue_input(&input, &response_queue, response).is_err() { break; }
                        continue;
                    }
                    Err(TrySendError::Disconnected(_)) => break,
                }
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
}
