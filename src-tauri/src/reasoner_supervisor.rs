//! Native driver for one isolated reasoning invocation. Only its private pipe
//! can propose provider operations; grants remain in the native actor.
use crate::control::{
    AdmissionError, ControlError, ControlHandle,
    generation::{IoOutcome, PendingConsent},
    provider_io::{self, Exchange},
    root_runs::{RootRun, RunStatus},
    state::{ExecutionFence, RootStatus},
    task_protocol::{Event, TaskChannel},
    tasks::InputFile,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(crate) struct Runtime<'a> {
    pub helper: &'a Path,
    pub node: &'a Path,
    pub resources: &'a Path,
    pub data: &'a Path,
    pub service: &'a str,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct SkillRef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ContinuationMessage {
    pub role: String,
    pub content: String,
}

/// Explicit content from the existing context adapter, never an authority grant.
/// Run/session/model/goal/criteria and output ceilings are selected natively.
pub(crate) struct Context {
    pub instructions: String,
    pub inputs: Vec<InputFile>,
    pub initial_surfaces: Vec<Value>,
    pub max_steps: u32,
    pub active_ms: u64,
    pub skills: Vec<SkillRef>,
    pub continuation: Vec<ContinuationMessage>,
}
pub(crate) struct ReasonedCandidate {
    pub candidate: Value,
    pub run: RootRun,
    pub fence: ExecutionFence,
}
struct BoundJob {
    protocol: TaskChannel,
    frame: Value,
    fence: ExecutionFence,
}

struct RunClock {
    since: Instant,
    active: Duration,
    consent: Duration,
    waiting: bool,
}
impl RunClock {
    fn new(active: Duration, now: Instant) -> Self {
        Self {
            since: now,
            active,
            consent: Duration::from_secs(300),
            waiting: false,
        }
    }
    fn advance(&mut self, now: Instant) -> Result<(), ControlError> {
        let budget = if self.waiting {
            &mut self.consent
        } else {
            &mut self.active
        };
        *budget = budget.saturating_sub(now.duration_since(self.since));
        self.since = now;
        if budget.is_zero() {
            Err(refused())
        } else {
            Ok(())
        }
    }
    fn set_waiting(&mut self, waiting: bool, now: Instant) -> Result<(), ControlError> {
        self.advance(now)?;
        if self.waiting == waiting {
            return Err(refused());
        }
        self.waiting = waiting;
        Ok(())
    }
    fn deadline(&self) -> Instant {
        self.since
            + if self.waiting {
                self.consent
            } else {
                self.active
            }
    }
}

fn refused() -> ControlError {
    ControlError::Admission(AdmissionError::WorkerCompletionUnavailable)
}

pub(crate) fn run(
    control: &ControlHandle,
    runtime: Runtime<'_>,
    run_id: String,
    context: Context,
    cancel: &AtomicBool,
) -> Result<ReasonedCandidate, ControlError> {
    run_inner(control, runtime, run_id, context, cancel, None)
}
fn run_inner(
    control: &ControlHandle,
    runtime: Runtime<'_>,
    run_id: String,
    context: Context,
    cancel: &AtomicBool,
    fixture: Option<reqwest::Url>,
) -> Result<ReasonedCandidate, ControlError> {
    let run = control.read_root_run(run_id)?;
    let root = control.read_root(run.root_id.clone())?;
    let policy = root.local_model().ok_or_else(refused)?;
    if run.status != RunStatus::Prepared
        || root.status() != RootStatus::Running
        || run.cancellation_epoch != root.cancellation_epoch()
        || context.instructions.len() > 64_000
        || context.instructions.contains('\0')
        || !(1..=12).contains(&context.max_steps)
        || !(1000..=300_000).contains(&context.active_ms)
        || context.inputs.len() > 4
        || context.initial_surfaces.len() > 16
        || serde_json::to_vec(&context.initial_surfaces).map_or(true, |v| v.len() > 8 * 1024 * 1024)
        || context.inputs.iter().any(|file| {
            file.name.is_empty()
                || file.name.len() > 160
                || file.name.contains(['/', '\\', '\0'])
                || file.content.len() > 16_000
                || file.content.contains('\0')
        })
        || context.skills.len() > 16
        || context.skills.iter().any(|s| {
            s.name.is_empty()
                || s.name.len() > 120
                || !s.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                || s.description.as_ref().is_some_and(|d| d.len() > 1000 || d.contains('\0'))
        })
        || context.continuation.len() > 16
        || context.continuation.iter().any(|c| {
            !matches!(c.role.as_str(), "user" | "assistant" | "system")
                || c.content.len() > 16_000
                || c.content.contains('\0')
        })
    {
        return Err(refused());
    }
    let mut provider_id = "ollama".to_string();
    if let Some((task, cumulative_active_ms)) = control.reasoner_task_definition(run.id.clone())? {
        let remaining_ms = task.limits.active_ms.saturating_sub(cumulative_active_ms);
        if context.inputs != task.inputs || context.active_ms > remaining_ms {
            return Err(refused());
        }
        provider_id = task.provider;
    }
    control.check_execution_fence(root.execution_fence())?;
    let mut job = json!({
        "runId": run.id,
        "session": run.session_id,
        "provider": provider_id,
        "model": policy.model,
        "goal": root.goal(),
        "criteria": root.criteria(),
        "instructions": context.instructions,
        "inputs": context.inputs.iter().map(|file| json!({
            "name": file.name,
            "content": file.content,
            "bytes": file.content.len(),
            "sha256": crate::control::canonical::digest(file.content.as_bytes())
        })).collect::<Vec<_>>(),
        "initialSurfaces": context.initial_surfaces,
        "maxSteps": context.max_steps,
        "maxTokens": policy.max_output_tokens,
        "activeMs": context.active_ms,
    });
    if !context.skills.is_empty() {
        job["skills"] = serde_json::to_value(&context.skills).map_err(|_| refused())?;
    }
    if !context.continuation.is_empty() {
        job["continuation"] = serde_json::to_value(&context.continuation).map_err(|_| refused())?;
    }
    let channel = TaskChannel::new(&run, provider_id, policy.model.clone()).map_err(|_| refused())?;
    let invocation = control.prepare_worker_completion(run.id.clone())?;
    execute(
        control,
        runtime,
        invocation,
        BoundJob {
            protocol: channel,
            frame: job,
            fence: root.execution_fence(),
        },
        cancel,
        fixture,
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn execute(
    control: &ControlHandle,
    runtime: Runtime<'_>,
    invocation: crate::control::worker_completion::WorkerInvocation,
    bound: BoundJob,
    cancel: &AtomicBool,
    fixture: Option<reqwest::Url>,
) -> Result<ReasonedCandidate, ControlError> {
    let BoundJob {
        mut protocol,
        frame: job,
        fence: original,
    } = bound;
    use std::{
        io::{Read, Write},
        os::{fd::OwnedFd, unix::net::UnixStream},
        process::{Child, Stdio},
        thread,
    };
    struct Pipe {
        input: UnixStream,
        output: UnixStream,
        buffer: Vec<u8>,
        scanned: usize,
        eof: bool,
        clock: Option<RunClock>,
    }
    impl Pipe {
        fn send(&mut self, frame: Value, cancel: &AtomicBool) -> Result<(), ControlError> {
            let mut bytes = serde_json::to_vec(&frame).map_err(|_| refused())?;
            bytes.push(b'\n');
            if bytes.len() > crate::control::task_protocol::MAX_FRAME {
                return Err(refused());
            }
            let clock = self.clock.as_mut().ok_or_else(refused)?;
            clock.advance(Instant::now())?;
            let until = clock
                .deadline()
                .min(Instant::now() + Duration::from_secs(3));
            let mut written = 0;
            while written < bytes.len() && Instant::now() < until && !cancel.load(Ordering::Acquire)
            {
                match self.input.write(&bytes[written..]) {
                    Ok(0) => return Err(refused()),
                    Ok(n) => written += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => return Err(refused()),
                }
            }
            if written == bytes.len() {
                Ok(())
            } else {
                Err(refused())
            }
        }
        fn set_waiting(&mut self, waiting: bool) -> Result<(), ControlError> {
            self.clock
                .as_mut()
                .ok_or_else(refused)?
                .set_waiting(waiting, Instant::now())
        }
        fn frame(&mut self) -> Result<Option<Vec<u8>>, ControlError> {
            // Read at most one bounded fragment per tick so an endless producer
            // cannot starve the native cancellation/deadline checks.
            let mut newline = self.buffer[self.scanned..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|n| n + self.scanned);
            self.scanned = self.buffer.len();
            if newline.is_none() && !self.eof {
                let mut bytes = [0; 8192];
                match self.output.read(&mut bytes) {
                    Ok(0) => self.eof = true,
                    Ok(n) => self.buffer.extend_from_slice(&bytes[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => return Err(refused()),
                }
            }
            if newline.is_none() {
                newline = self.buffer[self.scanned..]
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map(|n| n + self.scanned);
            }
            self.scanned = self.buffer.len();
            let max = crate::control::task_protocol::MAX_FRAME;
            if let Some(end) = newline {
                if end + 1 > max {
                    return Err(refused());
                }
                self.scanned = 0;
                return Ok(Some(self.buffer.drain(..=end).collect()));
            }
            if self.buffer.len() > max || self.eof && !self.buffer.is_empty() {
                return Err(refused());
            }
            Ok(None)
        }
    }
    fn wait(child: &mut Child, until: Instant) -> bool {
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
    enum Provider {
        Consent { id: String, pending: PendingConsent },
        Io { id: String, exchange: Exchange },
    }
    let id = invocation.run_id.clone();
    let setup = (|| {
        if cancel.load(Ordering::Acquire) {
            return Err(refused());
        }
        let command = crate::worker::command_for_invocation(
            runtime.helper,
            runtime.node,
            runtime.resources,
            runtime.data,
            &invocation,
        )
        .map_err(|_| refused())?;
        let (input, worker_input) = UnixStream::pair().map_err(|_| refused())?;
        let (output, worker_output) = UnixStream::pair().map_err(|_| refused())?;
        input.set_nonblocking(true).map_err(|_| refused())?;
        output.set_nonblocking(true).map_err(|_| refused())?;
        Ok((
            command,
            Pipe {
                input,
                output,
                buffer: Vec::new(),
                scanned: 0,
                eof: false,
                clock: None,
            },
            worker_input,
            worker_output,
        ))
    })();
    let (mut command, mut pipe, worker_input, worker_output) = match setup {
        Ok(value) => value,
        Err(error) => {
            control.abandon_reasoner_before_spawn(id)?;
            return Err(error);
        }
    };
    let mut child = match command
        .stdin(Stdio::from(OwnedFd::from(worker_input)))
        .stdout(Stdio::from(OwnedFd::from(worker_output)))
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            control.abandon_reasoner_before_spawn(id)?;
            return Err(refused());
        }
    };
    drop(command);
    let mut provider: Option<Provider> = None;
    let bootstrap = Instant::now() + Duration::from_secs(10);
    let mut terminal = false;
    let mut candidate = None;
    let mut terminal_until = None;
    let mut next_fence_check = Instant::now();
    let mut execution = (|| {
        loop {
            let now = Instant::now();
            if let Some(clock) = &mut pipe.clock {
                clock.advance(now)?;
            } else if now >= bootstrap {
                return Err(refused());
            }
            if cancel.load(Ordering::Acquire) {
                return Err(refused());
            }
            if now >= next_fence_check {
                let root = control.read_root(original.root_id().into())?;
                if root.contract_revision() != original.contract_revision()
                    || root.cancellation_epoch() != original.cancellation_epoch()
                {
                    return Err(refused());
                }
                control.check_execution_fence(root.execution_fence())?;
                next_fence_check = Instant::now() + Duration::from_millis(50);
            }
            if let Some(bytes) = pipe.frame()? {
                if terminal {
                    return Err(refused());
                }
                match protocol.receive(&bytes).map_err(|_| refused())? {
                    Event::Ready => {
                        control.confirm_root_started(
                            id.clone(),
                            format!("reasoner-supervisor-{id}"),
                        )?;
                        protocol.start().map_err(|_| refused())?;
                        pipe.clock = Some(RunClock::new(
                            Duration::from_millis(
                                job["activeMs"].as_u64().expect("native time bound"),
                            ),
                            Instant::now(),
                        ));
                        pipe.send(json!({"v":2,"type":"task_start","job":job}), cancel)?;
                    }
                    Event::Provider(proposal) => {
                        pipe.set_waiting(true)?;
                        pipe.send(json!({"v":2,"type":"task_consent","waiting":true}), cancel)?;
                        match control.request_provider_consent(
                            id.clone(),
                            proposal.operation_id,
                            proposal.attempt,
                            proposal.body.into_bytes(),
                        ) {
                            Ok(pending) => {
                                provider = Some(Provider::Consent {
                                    id: proposal.id,
                                    pending,
                                })
                            }
                            Err(_) => {
                                pipe.set_waiting(false)?;
                                pipe.send(
                                    json!({"v":2,"type":"task_consent","waiting":false}),
                                    cancel,
                                )?;
                                protocol
                                    .finish_provider(&proposal.id)
                                    .map_err(|_| refused())?;
                                pipe.send(json!({"v":2,"type":"provider_error","id":proposal.id,"message":"Native request admission was refused"}), cancel)?;
                            }
                        }
                    }
                    Event::Ack { id: request, seq } => match &mut provider {
                        Some(Provider::Io { id, exchange }) if *id == request => {
                            exchange.acknowledge(seq)?
                        }
                        _ => return Err(refused()),
                    },
                    Event::Cancel { id: request } => {
                        // Late cancellation for a retired request cannot affect
                        // the next request. Active cancellation ends this attempt.
                        let current = match &provider {
                            Some(Provider::Consent { id, .. } | Provider::Io { id, .. }) => {
                                Some(id)
                            }
                            None => None,
                        };
                        if current == Some(&request) {
                            return Err(refused());
                        }
                    }
                    Event::Candidate(value) => {
                        candidate = Some(value);
                        terminal = true;
                        terminal_until = Some(now + Duration::from_secs(5));
                    }
                    Event::Failed(_code) => return Err(refused()),
                }
            }
            if let Some(Provider::Consent {
                id: request,
                pending,
            }) = &mut provider
                && let Some(decision) = pending.try_decision()
            {
                let request = request.clone();
                provider = None;
                if let Err(error) = pipe.set_waiting(false).and_then(|_| {
                    pipe.send(json!({"v":2,"type":"task_consent","waiting":false}), cancel)
                }) {
                    if let Ok(dispatch) = decision {
                        let operation = dispatch.operation().id.clone();
                        control.settle_provider_operation(
                            operation.clone(),
                            crate::control::generation::ResultReceipt {
                                id: format!("reasoner-unsent-{operation}"),
                                outcome: IoOutcome::NotDispatched,
                                status_code: None,
                                response_bytes: 0,
                            },
                        )?;
                    }
                    return Err(error);
                }
                let exchange = decision.map_err(|_| refused()).and_then(|dispatch| {
                    let stop = Arc::new(AtomicBool::new(false));
                    let deadline = pipe
                        .clock
                        .as_ref()
                        .expect("started native clock")
                        .deadline()
                        .min(Instant::now() + Duration::from_secs(120));
                    #[cfg(test)]
                    if let Some(url) = fixture.clone() {
                        return provider_io::start_fixture(
                            control.clone(),
                            dispatch,
                            runtime.data.to_path_buf(),
                            stop,
                            deadline,
                            url,
                        );
                    }
                    let _ = &fixture;
                    provider_io::start(
                        control.clone(),
                        dispatch,
                        runtime.service.into(),
                        runtime.data.to_path_buf(),
                        stop,
                        deadline,
                    )
                });
                match exchange {
                    Ok(exchange) => {
                        provider = Some(Provider::Io {
                            id: request,
                            exchange,
                        })
                    }
                    Err(_) => {
                        protocol.finish_provider(&request).map_err(|_| refused())?;
                        pipe.send(json!({"v":2,"type":"provider_error","id":request,"message":"Native request was denied or unavailable"}), cancel)?;
                    }
                }
            }
            if let Some(Provider::Io {
                id: request,
                exchange,
            }) = &mut provider
                && let Some(event) = exchange.try_next()
            {
                match event {
                    provider_io::Event::Headers { status, headers } => pipe.send(json!({"v":2,"type":"provider_headers","id":request,"status":status,"headers":headers}), cancel)?,
                    provider_io::Event::Data { seq, bytes } => pipe.send(json!({"v":2,"type":"provider_data","id":request,"seq":seq,"data":base64(&bytes)}), cancel)?,
                    provider_io::Event::Finished(result) => {
                        let request = request.clone();
                        provider = None;
                        let record = (*result)?;
                        let completed = record.receipt.as_ref().is_some_and(|r| r.outcome == IoOutcome::Completed);
                        protocol.finish_provider(&request).map_err(|_| refused())?;
                        pipe.send(if completed { json!({"v":2,"type":"provider_end","id":request}) }
                            else { json!({"v":2,"type":"provider_error","id":request,"message":"Native provider I/O did not complete"}) }, cancel)?;
                    }
                }
            }

            if pipe.eof {
                return if terminal { Ok(()) } else { Err(refused()) };
            }
            if terminal_until.is_some_and(|until| Instant::now() >= until) {
                return Err(refused());
            }
            thread::sleep(Duration::from_millis(5));
        }
    })();
    // Retire native consent and stop I/O before accepting any candidate. A
    // bounded join failure retains uncertainty in the actor; never replay it.
    if let Some(Provider::Consent { pending, .. }) = &mut provider {
        pending.close();
        let _ = control.read_root_run(id.clone());
        if let Some(Ok(dispatch)) = pending.try_decision() {
            let operation = dispatch.operation().id.clone();
            if let Err(error) = control.settle_provider_operation(
                operation.clone(),
                crate::control::generation::ResultReceipt {
                    id: format!("reasoner-unsent-{operation}"),
                    outcome: IoOutcome::NotDispatched,
                    status_code: None,
                    response_bytes: 0,
                },
            ) {
                execution = Err(error);
            }
        }
    }
    if let Some(Provider::Io { exchange, .. }) = &provider {
        exchange.cancel();
    }
    if let Some(Provider::Io { exchange, .. }) = &mut provider {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if matches!(exchange.try_next(), Some(provider_io::Event::Finished(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    drop(provider);
    let _ = pipe.input.shutdown(std::net::Shutdown::Write);
    if !wait(&mut child, Instant::now() + Duration::from_secs(5)) {
        let _ = child.kill();
        let _ = wait(&mut child, Instant::now() + Duration::from_secs(5));
    }
    let (active_ms, charged_ms) = if let Some(clock) = pipe.clock.as_ref() {
        let active_budget_ms = job["activeMs"].as_u64().unwrap_or(0);
        let remaining_active_ms = clock.active.as_millis() as u64;
        let elapsed = active_budget_ms.saturating_sub(remaining_active_ms);
        (elapsed, elapsed)
    } else {
        (0, 0)
    };
    let run = control.finish_reasoner(id, active_ms, charged_ms)?;
    execution?;
    if run.worker_exit_code != Some(0) || cancel.load(Ordering::Acquire) {
        return Err(refused());
    }
    let root = control.read_root(original.root_id().into())?;
    if root.contract_revision() != original.contract_revision()
        || root.cancellation_epoch() != original.cancellation_epoch()
    {
        return Err(refused());
    }
    control.check_execution_fence(root.execution_fence())?;
    Ok(ReasonedCandidate {
        candidate: candidate.ok_or_else(refused)?,
        run,
        fence: root.execution_fence(),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn execute(
    control: &ControlHandle,
    _runtime: Runtime<'_>,
    invocation: crate::control::worker_completion::WorkerInvocation,
    _bound: BoundJob,
    _cancel: &AtomicBool,
    _fixture: Option<reqwest::Url>,
) -> Result<ReasonedCandidate, ControlError> {
    control.abandon_reasoner_before_spawn(invocation.run_id)?;
    Err(refused())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let a = group[0];
        let b = group.get(1).copied().unwrap_or(0);
        let c = group.get(2).copied().unwrap_or(0);
        result.push(TABLE[(a >> 2) as usize] as char);
        result.push(TABLE[(((a & 3) << 4) | b >> 4) as usize] as char);
        result.push(if group.len() > 1 {
            TABLE[(((b & 15) << 2) | c >> 6) as usize] as char
        } else {
            '='
        });
        result.push(if group.len() > 2 {
            TABLE[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}

#[cfg(test)]
mod tests;
