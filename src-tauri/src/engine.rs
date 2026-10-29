// The shell owns one child and its anonymous pipes. Requests never become
// network listeners; only the main webview may use the bounded IPC contract.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}, mpsc::{SyncSender, sync_channel}};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use super::Backend;

const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_QUEUE: usize = 48 * 1024 * 1024;
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
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let size = bytes.len();
        self.queued.try_update(Ordering::AcqRel, Ordering::Relaxed, |n| n.checked_add(size).filter(|sum| *sum <= MAX_QUEUE)).map_err(|_| "Engine input queue is full")?;
        let result = self.input.lock().unwrap().as_ref().ok_or("Engine connection closed".to_string()).and_then(|input| input.try_send(bytes).map_err(|_| "Engine input queue is full or closed".to_string()));
        if result.is_err() { self.queued.fetch_sub(size, Ordering::AcqRel); }
        result
    }
    pub fn close(&self) { self.input.lock().unwrap().take(); }
}

fn fail_pending(pending: &Pending) {
    for (id, channel) in pending.lock().unwrap().drain() {
        let _ = channel.send(Frame { v: 1, id, event: Output::Error { message: "Engine connection closed".into() } });
    }
}

pub fn start(mut cmd: Command) -> Engine {
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
        let valid = result.is_ok() && ready.strip_prefix("VAK_READY ").and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()).is_some_and(|v| v["version"] == 1 && v["transport"] == "stdio");
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
    let responses = pending.clone();
    let connection = sender.clone();
    let response_queue = queued.clone();
    std::thread::spawn(move || {
        loop {
            let mut line = Vec::new();
            let result = reader.by_ref().take(128 * 1024 + 1).read_until(b'\n', &mut line);
            if !matches!(result, Ok(n) if n > 0 && n <= 128 * 1024) || !line.ends_with(b"\n") { break; }
            let frame = match serde_json::from_slice::<Frame>(&line) { Ok(frame) if frame.v == 1 => frame, _ => break };
            let terminal = matches!(frame.event, Output::End | Output::Error { .. });
            let channel = { let mut map = responses.lock().unwrap(); if terminal { map.remove(&frame.id) } else { map.get(&frame.id).cloned() } };
            if let Some(channel) = channel {
                let id = frame.id.clone();
                if channel.send(frame).is_err() {
                    responses.lock().unwrap().remove(&id);
                    let mut bytes = serde_json::to_vec(&serde_json::json!({"v":1,"id":id,"type":"cancel"})).unwrap(); bytes.push(b'\n');
                    let size = bytes.len();
                    if response_queue.try_update(Ordering::AcqRel, Ordering::Relaxed, |n| n.checked_add(size).filter(|sum| *sum <= MAX_QUEUE)).is_ok()
                        && connection.lock().unwrap().as_ref().is_none_or(|input| input.try_send(bytes).is_err()) {
                        response_queue.fetch_sub(size, Ordering::AcqRel);
                    }
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
    let mut message = serde_json::json!({"v":1,"id":id,"type":"request","method":method,"path":path,"headers":headers});
    if let Some(body) = body { message["body"] = body.into(); }
    if let Err(error) = state.send(message) { state.pending.lock().unwrap().remove(&id); return Err(error); }
    Ok(())
}

#[tauri::command]
pub fn engine_ack(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) { return Err("Invalid request identity".into()); }
    state.send(serde_json::json!({"v":1,"id":id,"type":"ack"}))
}
#[tauri::command]
pub fn engine_cancel(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) { return Err("Invalid request identity".into()); }
    state.pending.lock().unwrap().remove(&id);
    state.send(serde_json::json!({"v":1,"id":id,"type":"cancel"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_and_output_frames_are_bounded_and_typed() {
        assert!(valid_id("request-123")); assert!(!valid_id("../request")); assert!(!valid_id(&"a".repeat(65)));
        assert!(serde_json::from_str::<Frame>(r#"{"v":1,"id":"x","type":"shell","command":"bad"}"#).is_err());
        let frame: Frame = serde_json::from_str(r#"{"v":1,"id":"x","type":"data","data":"AAE="}"#).unwrap();
        assert!(matches!(frame.event, Output::Data { .. }));
    }
}
