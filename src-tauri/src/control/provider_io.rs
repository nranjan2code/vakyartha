//! One native I/O owner consumes a durable dispatch permit. Network bodies and
//! credentials never become durable receipts or task completion authority.
use super::{
    AdmissionError, ControlError, ControlHandle,
    broker::NativeHttpClient,
    generation::{Dispatch, IoOutcome, OperationRecord, ResultReceipt},
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering},
        mpsc::{Receiver, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_RESPONSE: usize = super::broker::MAX_RESPONSE_BYTES as usize;
const CHUNK: usize = 64 * 1024;
const MAX_TIME: Duration = super::broker::MAX_OPERATION_TIME;

pub enum Event {
    Headers {
        status: u16,
        headers: BTreeMap<String, String>,
    },
    Data {
        seq: u32,
        bytes: Vec<u8>,
    },
    Finished(Box<Result<OperationRecord, ControlError>>),
}
pub struct Exchange {
    events: tauri::async_runtime::Receiver<Event>,
    ack: tauri::async_runtime::Sender<u32>,
    completion: Receiver<Result<OperationRecord, ControlError>>,
    cancel: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    finished: bool,
    pending_ack: Option<u32>,
}
impl Exchange {
    pub fn try_next(&mut self) -> Option<Event> {
        if self.finished {
            return None;
        }
        if let Ok(event) = self.events.try_recv() {
            if let Event::Data { seq, .. } = &event {
                self.pending_ack = Some(*seq);
            }
            return Some(event);
        }
        match self.completion.try_recv() {
            Ok(result) => {
                self.finished = true;
                Some(Event::Finished(Box::new(result)))
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                self.finished = true;
                Some(Event::Finished(Box::new(Err(refused()))))
            }
            Err(_) => None,
        }
    }
    pub fn acknowledge(&mut self, seq: u32) -> Result<(), ControlError> {
        if self.pending_ack != Some(seq) || self.closed.load(Ordering::Acquire) {
            self.closed.store(true, Ordering::Release);
            return Err(refused());
        }
        self.pending_ack = None;
        self.ack.try_send(seq).map_err(|_| {
            self.closed.store(true, Ordering::Release);
            refused()
        })
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
}
impl Drop for Exchange {
    fn drop(&mut self) {
        if !self.finished {
            self.closed.store(true, Ordering::Release);
        }
    }
}
fn refused() -> ControlError {
    ControlError::Admission(AdmissionError::ProviderApprovalRefused)
}
#[derive(Default)]
struct Progress {
    status: AtomicU16,
    bytes: AtomicU32,
}

struct AbortOnDrop(Option<tauri::async_runtime::JoinHandle<IoOutcome>>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

/// Only native orchestration calls this. A request is not admitted by supplying
/// a URL/body: the consumed actor-issued object carries the exact approved bytes.
pub fn start(
    control: ControlHandle,
    dispatch: Dispatch,
    service: String,
    data: PathBuf,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
) -> Result<Exchange, ControlError> {
    start_inner(control, dispatch, service, data, cancel, deadline, None)
}
fn start_inner(
    control: ControlHandle,
    dispatch: Dispatch,
    service: String,
    data: PathBuf,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    fixture: Option<reqwest::Url>,
) -> Result<Exchange, ControlError> {
    let id = dispatch.operation().id.clone();
    if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
        control.settle_provider_operation(
            id.clone(),
            receipt(&id, IoOutcome::NotDispatched, &Progress::default()),
        )?;
        return Err(refused());
    }
    let dispatch = match control.begin_provider_dispatch(dispatch) {
        Ok(dispatch) => dispatch,
        Err(error) => {
            // No I/O task received this move-only object. A committed request
            // budget is retained; its provider capacity can now be settled.
            let _ = control.settle_provider_operation(
                id.clone(),
                receipt(&id, IoOutcome::NotDispatched, &Progress::default()),
            );
            return Err(error);
        }
    };
    let (_, permit, bytes) = dispatch.into_request();
    let request = NativeHttpClient::new(service, data).request(&permit, &bytes);
    #[cfg(test)]
    let request = if let Some(url) = fixture {
        super::broker::async_client(None).map(|client| {
            client
                .post(url)
                .header("content-type", "application/json")
                .body(bytes)
        })
    } else {
        request
    };
    #[cfg(not(test))]
    let _ = fixture;
    let request = match request {
        Ok(request) => request,
        Err(_) => {
            control.settle_provider_operation(
                id.clone(),
                receipt(&id, IoOutcome::NotDispatched, &Progress::default()),
            )?;
            return Err(refused());
        }
    };
    let (events_tx, events) = tauri::async_runtime::channel(1);
    let (ack, ack_rx) = tauri::async_runtime::channel(1);
    let (complete_tx, completion) = sync_channel(1);
    let closed = Arc::new(AtomicBool::new(false));
    let closed_worker = closed.clone();
    let cancel_worker = cancel.clone();
    let progress = Arc::new(Progress::default());
    let task_progress = progress.clone();
    let owner = control.clone();
    let operation_id = id.clone();
    let deadline = deadline.min(Instant::now() + MAX_TIME);
    let spawn = thread::Builder::new()
        .name("vak-provider-io".into())
        .spawn(move || {
            let mut task = AbortOnDrop(Some(tauri::async_runtime::spawn(transfer(
                request,
                events_tx,
                ack_rx,
                task_progress,
                cancel_worker.clone(),
                closed_worker.clone(),
                deadline,
            ))));
            let mut interrupted = None;
            while !task
                .0
                .as_ref()
                .expect("owned request task")
                .inner()
                .is_finished()
            {
                if cancel_worker.load(Ordering::Acquire) {
                    interrupted = Some(IoOutcome::Cancelled);
                } else if closed_worker.load(Ordering::Acquire) {
                    interrupted = Some(IoOutcome::ConsumerClosed);
                } else if Instant::now() >= deadline {
                    interrupted = Some(IoOutcome::TimedOut);
                } else if owner.provider_io_current(operation_id.clone()).is_err() {
                    interrupted = Some(IoOutcome::Cancelled);
                }
                if interrupted.is_some() {
                    task.0.as_ref().expect("owned request task").abort();
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            // Joining, including after abort, proves the native request future and
            // response body have been dropped before capacity is returned.
            let joined = tauri::async_runtime::block_on(task.0.take().expect("owned request task"));
            let outcome = match joined {
                Ok(outcome) => outcome,
                Err(_) => interrupted.unwrap_or(IoOutcome::TransportFailed),
            };
            let result = owner.settle_provider_operation(
                operation_id.clone(),
                receipt(&operation_id, outcome, &progress),
            );
            let _ = complete_tx.send(result);
        });
    if spawn.is_err() {
        control.settle_provider_operation(
            id.clone(),
            receipt(&id, IoOutcome::NotDispatched, &Progress::default()),
        )?;
        return Err(refused());
    }
    Ok(Exchange {
        events,
        ack,
        completion,
        cancel,
        closed,
        finished: false,
        pending_ack: None,
    })
}
fn receipt(id: &str, outcome: IoOutcome, progress: &Progress) -> ResultReceipt {
    let status = progress.status.load(Ordering::Acquire);
    ResultReceipt {
        id: format!("provider-io-{id}"),
        outcome,
        status_code: if status == 0 { None } else { Some(status) },
        response_bytes: progress.bytes.load(Ordering::Acquire),
    }
}
async fn transfer(
    request: reqwest::RequestBuilder,
    events: tauri::async_runtime::Sender<Event>,
    mut ack: tauri::async_runtime::Receiver<u32>,
    progress: Arc<Progress>,
    cancel: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    deadline: Instant,
) -> IoOutcome {
    if cancel.load(Ordering::Acquire)
        || closed.load(Ordering::Acquire)
        || Instant::now() >= deadline
    {
        return IoOutcome::NotDispatched;
    }
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return if error.is_timeout() {
                IoOutcome::TimedOut
            } else {
                IoOutcome::TransportFailed
            };
        }
    };
    let status = response.status().as_u16();
    if !(100..=599).contains(&status) {
        return IoOutcome::TransportFailed;
    }
    progress.status.store(status, Ordering::Release);
    if status < 200 {
        return IoOutcome::TransportFailed;
    }
    if response
        .content_length()
        .is_some_and(|bytes| bytes > MAX_RESPONSE as u64)
    {
        return IoOutcome::ResponseLimit;
    }
    let mut headers = BTreeMap::new();
    for name in ["content-type", "retry-after"] {
        if let Some(value) = response.headers().get(name) {
            let Ok(value) = value.to_str() else {
                return IoOutcome::TransportFailed;
            };
            if value.len() > 256 || value.contains(['\r', '\n']) {
                return IoOutcome::TransportFailed;
            }
            headers.insert(name.into(), value.into());
        }
    }
    if events
        .send(Event::Headers { status, headers })
        .await
        .is_err()
    {
        return IoOutcome::ConsumerClosed;
    }
    let mut bytes = 0usize;
    let mut seq = 0u32;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => return IoOutcome::Completed,
            Err(error) => {
                return if error.is_timeout() {
                    IoOutcome::TimedOut
                } else {
                    IoOutcome::TransportFailed
                };
            }
        };
        if chunk.len() > MAX_RESPONSE.saturating_sub(bytes) {
            return IoOutcome::ResponseLimit;
        }
        bytes += chunk.len();
        progress.bytes.store(bytes as u32, Ordering::Release);
        for part in chunk.chunks(CHUNK) {
            if events
                .send(Event::Data {
                    seq,
                    bytes: part.to_vec(),
                })
                .await
                .is_err()
                || ack.recv().await != Some(seq)
            {
                return IoOutcome::ConsumerClosed;
            }
            seq += 1;
        }
    }
}

#[cfg(test)]
mod tests;
